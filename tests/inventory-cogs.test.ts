// v1.3 §3：库存成本结转（moving weighted average）的守恒与旧档兼容测试。
//
// 口径：
// - 采购/调入：数量与账面成本同时增加（买家实付金额入账）；
// - 生产消耗原料：按移动加权平均成本从原料存货转入成品存货（资产内部结转，不产生费用）；
// - 销售/调出：账面成本结转为当期 COGS；利润 = 营收 − COGS − 期间费用（+ 奖金 + 退款收益）；
// - 采购现金支出 inputCost 只用于现金流，不再直接进入利润；
// - 破产清算：剩余存货按账面价值注销，记 inventoryWriteOff，不重复计入 COGS；
// - v1.4 §6.6：跨城运力退款先冲减存货账面成本；超出剩余账面成本的部分是真实采购
//   退款收益（refundGain），计入利润，不能只留在现金流里。
import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation/core/simulation';
import { DEMO_CONFIG } from '../src/data/config';
import type { DemoConfig } from '../src/data/config';
import type { Company, GoodId, WorldState } from '../src/simulation/contracts/types';
import { SAVE_FORMAT_VERSION } from '../src/simulation/contracts/types';
import { round2 } from '../src/simulation/core/math';
import { setCompanyEmployees } from '../src/simulation/companies/company';
import {
  adjustInventoryCost,
  emptyInventoryCost,
  inventoryBookValue,
  issueInventory,
  receiveInventory,
  totalInventoryBookValue,
  writeOffInventory,
} from '../src/simulation/finance/inventory-cost';
import {
  createWorldLedgers,
  executePurchase,
  type WorldLedgers,
} from '../src/simulation/markets/markets';
import { executeIntercityPurchase } from '../src/simulation/markets/intercity';
import { settleTransportMonth } from '../src/simulation/transport/settlement';
import { runProduction } from '../src/simulation/production/production';
import { settleCompanyFinance } from '../src/simulation/finance/finance';
import { createSaveFile, parseSave } from '../src/simulation/core/save';
import { liquidateCompany } from '../src/simulation/companies/lifecycle/lifecycle';

function newWorld(): WorldState {
  return Simulation.create().state;
}

function companyOf(world: WorldState, id: string): Company {
  const company = world.companies.find((entry) => entry.id === id);
  if (!company) throw new Error(`测试世界没有企业 ${id}`);
  return company;
}

function clearInventory(company: Company): void {
  for (const goodId of Object.keys(company.inventory) as GoodId[]) {
    company.inventory[goodId] = 0;
  }
  company.inventoryCost = emptyInventoryCost();
}

describe('存货成本：移动加权平均', () => {
  it('入库按数量加权、出库结转平均成本，最后一批清空账面残留', () => {
    const company = newWorld().companies[0]!;
    clearInventory(company);
    receiveInventory(company, 'grain', 100, 200);
    receiveInventory(company, 'grain', 100, 400);
    expect(company.inventory.grain).toBe(200);
    expect(inventoryBookValue(company, 'grain')).toBe(600);

    expect(issueInventory(company, 'grain', 50)).toBe(150);
    expect(company.inventory.grain).toBe(150);
    expect(inventoryBookValue(company, 'grain')).toBe(450);

    // 取走最后一笔：剩余账面价值全部随最后一批结转，不留下“无货有成本”的残差。
    expect(issueInventory(company, 'grain', 150)).toBe(450);
    expect(company.inventory.grain).toBe(0);
    expect(inventoryBookValue(company, 'grain')).toBe(0);
    expect(issueInventory(company, 'grain', 10)).toBe(0);
  });

  it('账面成本调整有下限（运输退款不会把成本冲成负数），注销返回账面明细', () => {
    const company = newWorld().companies[0]!;
    clearInventory(company);
    receiveInventory(company, 'energy', 10, 100);
    expect(adjustInventoryCost(company, 'energy', -30)).toBe(-30);
    expect(inventoryBookValue(company, 'energy')).toBe(70);
    expect(adjustInventoryCost(company, 'energy', -500)).toBe(-70);
    expect(inventoryBookValue(company, 'energy')).toBe(0);

    receiveInventory(company, 'energy', 5, 50);
    const written = writeOffInventory(company, () => 999);
    expect(written).toEqual([{ good: 'energy', qty: 15, bookValue: 50 }]);
    expect(company.inventory.energy).toBe(0);
    expect(totalInventoryBookValue(company)).toBe(0);
  });
});

describe('生产 → 成品 → 销售：成本链守恒', () => {
  it('原料成本转入成品、销售时按 COGS 结转，利润=营收−COGS−期间费用', () => {
    const world = newWorld();
    const city = world.cities.find((entry) => entry.id === 'lanport')!;
    const seller = companyOf(world, 'lp-food');
    const buyer = companyOf(world, 'lp-garment');
    clearInventory(seller);
    clearInventory(buyer);
    // 期初存货资产：grain 1000 单位成本 5000（单价 5），energy 1000 单位成本 2000（单价 2）。
    receiveInventory(seller, 'grain', 1000, 5000);
    receiveInventory(seller, 'energy', 1000, 2000);
    const openingBook = totalInventoryBookValue(seller);
    expect(openingBook).toBe(7000);

    setCompanyEmployees(seller, 1000);
    seller.cash = 1_000_000;
    seller.productionPlan = {
      tick: world.time.tick,
      salesReference: 100,
      targetInventory: 50,
      equipmentLimit: 1000,
      laborLimit: 100_000,
      plannedOutput: 100,
      plannedJobs: 1000,
      emergency: false,
      reasons: ['测试计划'],
    };

    runProduction(world, createWorldLedgers(world), DEMO_CONFIG);
    const produced = seller.inventory.food ?? 0;
    expect(produced).toBeGreaterThan(0);
    // 产出 100 单位：消耗 grain 62（310）+ energy 4（8），成品入账成本 318。
    expect(produced).toBeCloseTo(100, 2);
    expect(inventoryBookValue(seller, 'food')).toBeCloseTo(318, 2);
    const afterProduction = totalInventoryBookValue(seller);
    expect(afterProduction).toBeCloseTo(openingBook, 2); // 资产内部结转，总账面不变

    // 以市场价卖出 40 单位：COGS = 40 × 3.18 = 127.2。
    const ledgers: WorldLedgers = createWorldLedgers(world);
    const sale = executePurchase(world, city, ledgers.lanport!, 'food', 40, 1_000_000, {
      buyerCompanyId: buyer.id,
    });
    expect(sale.qty).toBeCloseTo(40, 2);
    expect(seller.lastMonth.cogs).toBeCloseTo(127.2, 2);
    expect(seller.lastMonth.revenue).toBeCloseTo(sale.spend, 2);
    expect(totalInventoryBookValue(seller)).toBeCloseTo(openingBook - 127.2, 2);
    // 买方按实付金额入账（含税实付，企业采购不征消费税）。
    expect(inventoryBookValue(buyer, 'food')).toBeCloseTo(sale.spend, 2);

    settleCompanyFinance(world, DEMO_CONFIG, []);
    const stats = seller.lastMonth;
    // 会计恒等式：利润 = 营收 − COGS − 实发工资 − 利息 − 所得税。
    expect(
      round2(stats.revenue - stats.cogs! - stats.wagesPaid - stats.interestPaid - stats.corporateTax),
    ).toBeCloseTo(stats.profit, 1);
    // 现金流口径独立：采购现金支出（inputCost）与存货 COGS 不混用。
    expect(
      round2(stats.revenue - stats.inputCost - stats.wagesPaid - stats.interestPaid - stats.corporateTax),
    ).toBeCloseTo(stats.operatingCashFlow ?? 0, 1);
  });
});

describe('旧档兼容：缺少 inventoryCost / cogs 的 v9 存档', () => {
  it('读取时按市场价补齐账面成本、cogs 回退 inputCost，且重复读取幂等', () => {
    const world = newWorld();
    const raw = JSON.parse(JSON.stringify(createSaveFile(world))) as {
      formatVersion: number;
      world: { companies: Record<string, unknown>[] };
    };
    for (const company of raw.world.companies) {
      delete company.inventoryCost;
      for (const key of ['lastMonth', 'previousMonth']) {
        const stats = company[key] as Record<string, unknown>;
        delete stats.cogs;
        delete stats.inventoryWriteOff;
        delete stats.operatingCashFlow;
      }
    }
    const text = JSON.stringify(raw);
    const first = parseSave(text);
    expect(first.ok).toBe(true);
    if (!first.ok || !first.world) return;

    const sample = first.world.companies.find((company) => (company.inventory.food ?? 0) > 0);
    expect(sample).toBeDefined();
    if (!sample) return;
    const city = first.world.cities.find((entry) => entry.id === sample.cityId)!;
    const expectedBook = round2((sample.inventory.food ?? 0) * (city.market.food?.price ?? 0));
    expect(inventoryBookValue(sample, 'food')).toBeCloseTo(expectedBook, 2);
    // 旧档的月度统计没有 cogs：回退为旧现金制 inputCost，利润口径不跳变。
    expect(sample.lastMonth.cogs).toBe(sample.lastMonth.inputCost);
    expect(sample.previousMonth.cogs).toBe(sample.previousMonth.inputCost);

    // 幂等：同一旧档读取两次，账面成本不会翻倍。
    const second = parseSave(text);
    expect(second.ok).toBe(true);
    if (!second.ok || !second.world) return;
    const sample2 = second.world.companies.find((company) => company.id === sample.id)!;
    expect(inventoryBookValue(sample2, 'food')).toBeCloseTo(expectedBook, 2);
  });
});

describe('破产清算：库存按账面价值注销', () => {
  it('清算记录使用账面成本而不是市场价，且库存清零', () => {
    const world = newWorld();
    const victim = companyOf(world, 'lp-textile');
    clearInventory(victim);
    receiveInventory(victim, 'grain', 10, 500); // 账面单价 50，市场价另算
    const log: Parameters<typeof liquidateCompany>[4] = [];
    const result = liquidateCompany(world, victim.id, DEMO_CONFIG, '测试库存注销', log);
    expect(result.ok).toBe(true);
    const record = world.lifecycle.liquidations.at(-1)!;
    expect(record.companyId).toBe(victim.id);
    expect(record.inventoryBookValue).toBe(500);
    expect(record.inventoryWrittenOff).toEqual([{ good: 'grain', qty: 10, bookValue: 500 }]);
    expect(victim.inventory.grain).toBe(0);
    expect(victim.inventoryCost?.grain ?? 0).toBe(0);
  });
});

describe('v1.4 §6.6：跨城运力退款收益（refundGain）', () => {
  /** 100% 容量惩罚配置：容量为 0 时任意跨城成交都全额退款，便于构造“退款 > 剩余账面”。 */
  function fullRefundConfig(): DemoConfig {
    return {
      ...DEMO_CONFIG,
      transport: { ...DEMO_CONFIG.transport, penalty: { strength: 1, max: 1 } },
    } as unknown as DemoConfig;
  }

  /** 把世界所有跨城线路容量清零（退款比例 = 100%）。 */
  function zeroCorridorCapacity(world: WorldState): void {
    for (const link of world.transport.links) link.level = 0;
  }

  /** 买方从卖方跨城买入一批粮食并把账面数量/成本清空（模拟货已全部投产耗用）。 */
  function stageIntercityPurchaseThenConsume(world: WorldState, consume: boolean): {
    buyer: Company;
    spend: number;
    cashAfterPurchase: number;
    inputCostAfterPurchase: number;
  } {
    // 卖方在青原（唯一开局粮食企业），买方在铁谷：必然走跨城交易。
    const buyer = companyOf(world, 'iv-food');
    const seller = companyOf(world, 'gf-grain');
    clearInventory(buyer);
    clearInventory(seller);
    receiveInventory(seller, 'grain', 1_000, 1_000); // 卖方有货，账面成本 1/单位
    buyer.cash = 10_000_000;
    const ledgers = createWorldLedgers(world);
    const city = world.cities.find((entry) => entry.id === buyer.cityId)!;
    const purchase = executeIntercityPurchase(
      world,
      city,
      ledgers.ironvale!,
      'grain',
      1_000,
      10_000_000,
      { buyerCompanyId: buyer.id },
      fullRefundConfig(),
    );
    expect(purchase.qty).toBeCloseTo(1_000, 2);
    expect(purchase.spend).toBeGreaterThan(0);
    if (consume) {
      const consumedCost = issueInventory(buyer, 'grain', purchase.qty);
      expect(consumedCost).toBeCloseTo(purchase.spend, 2);
      expect(buyer.inventoryCost!.grain ?? 0).toBe(0);
    }
    expect(world.transport.pendingSales.filter((sale) => sale.buyerCompanyId === buyer.id)).toHaveLength(1);
    return {
      buyer,
      spend: purchase.spend,
      cashAfterPurchase: buyer.cash,
      inputCostAfterPurchase: buyer.lastMonth.inputCost,
    };
  }

  it('退款超过剩余账面成本时，超出部分计入利润（refundGain），利润与现金流闭合', () => {
    const config = fullRefundConfig();
    const world = Simulation.create(config).state;
    zeroCorridorCapacity(world);
    const { buyer, spend, cashAfterPurchase, inputCostAfterPurchase } =
      stageIntercityPurchaseThenConsume(world, true);
    const ledgers = createWorldLedgers(world);
    settleTransportMonth(world, config, [], ledgers);

    // 账面成本 0，整笔退款都吸收不了 → 全部是采购退款收益。
    expect(buyer.lastMonth.refundGain ?? 0).toBeCloseTo(spend, 2);
    // 现金收到退款；采购现金支出同步冲减（现金流口径仍是纯现金制）。
    expect(buyer.cash).toBeCloseTo(cashAfterPurchase + spend, 2);
    expect(buyer.lastMonth.inputCost).toBeCloseTo(
      Math.max(0, inputCostAfterPurchase - spend),
      2,
    );
    expect(buyer.inventoryCost?.grain ?? 0).toBe(0);
    // COGS 不为负，也不因退款变动（退款是采购价冲减，不是销货成本冲减）。
    expect(buyer.lastMonth.cogs ?? 0).toBe(0);

    settleCompanyFinance(world, config, []);
    const stats = buyer.lastMonth;
    // 利润闭合：revenue − COGS − 工资 − 税 − 利息 + 奖金 + refundGain = profit
    expect(
      Math.abs(
        round2(
          stats.revenue -
            (stats.cogs ?? 0) -
            stats.wagesPaid -
            stats.corporateTax -
            stats.interestPaid +
            (stats.bonusPaid ?? 0) +
            (stats.refundGain ?? 0) -
            stats.profit,
        ),
      ),
    ).toBe(0);
    // 现金流恒等式不变：采购现金支出仍只在现金流里出现。
    expect(
      Math.abs(
        round2(
          stats.revenue -
            stats.inputCost -
            stats.wagesPaid -
            stats.interestPaid -
            stats.corporateTax -
            (stats.operatingCashFlow ?? 0),
        ),
      ),
    ).toBe(0);
    // 反证：没有 refundGain 时这笔收益会被静默丢掉（利润与现金流相差整笔退款）。
    expect(
      round2(
        stats.profit -
          (stats.revenue -
            (stats.cogs ?? 0) -
            stats.wagesPaid -
            stats.corporateTax -
            stats.interestPaid),
      ),
    ).toBeCloseTo(spend, 2);
  });

  it('退款不超过账面成本时行为不变：只冲减存货成本，不产生退款收益', () => {
    const config = fullRefundConfig();
    const world = Simulation.create(config).state;
    zeroCorridorCapacity(world);
    const { buyer, spend, cashAfterPurchase, inputCostAfterPurchase } =
      stageIntercityPurchaseThenConsume(world, false);
    // 货还在库存里：该商品账面成本 = 实付金额，足以吸收整笔退款。
    expect(inventoryBookValue(buyer, 'grain')).toBeCloseTo(spend, 2);
    const ledgers = createWorldLedgers(world);
    settleTransportMonth(world, config, [], ledgers);

    expect(buyer.lastMonth.refundGain ?? 0).toBe(0);
    expect(inventoryBookValue(buyer, 'grain')).toBeCloseTo(0, 2);
    expect(buyer.cash).toBeCloseTo(cashAfterPurchase + spend, 2);
    expect(buyer.lastMonth.inputCost).toBeCloseTo(
      Math.max(0, inputCostAfterPurchase - spend),
      2,
    );
    expect(buyer.lastMonth.cogs ?? 0).toBe(0);

    settleCompanyFinance(world, config, []);
    const stats = buyer.lastMonth;
    expect(
      Math.abs(
        round2(
          stats.revenue -
            (stats.cogs ?? 0) -
            stats.wagesPaid -
            stats.corporateTax -
            stats.interestPaid +
            (stats.bonusPaid ?? 0) +
            (stats.refundGain ?? 0) -
            stats.profit,
        ),
      ),
    ).toBe(0);
  });

  it('真实整月 tick：退款收益进入利润，存货账面滚动含 refundGain 精确闭合；二次读档保留、旧档缺省为 0', () => {
    const config = fullRefundConfig();
    const sim = Simulation.create(config);
    zeroCorridorCapacity(sim.state);
    // 让铁谷食品厂必须先跨城买粮：清空开局粮食库存与账面成本（本地没有粮食企业）。
    const importer = sim.state.companies.find((company) => company.id === 'iv-food')!;
    importer.inventory.grain = 0;
    importer.inventoryCost!.grain = 0;
    let sawRefundGain = 0;
    // 第 3 个月起企业间跨城采购规模足够大、且原料在当月被生产耗用，才会出现“退款 > 剩余账面”。
    for (let month = 0; month < 3; month += 1) {
      const startBook = new Map<string, number>();
      for (const company of sim.state.companies) {
        startBook.set(company.id, totalInventoryBookValue(company));
      }
      const result = sim.tick();
      expect(result.ok).toBe(true);
      for (const company of sim.state.companies) {
        const bookStart = startBook.get(company.id);
        if (bookStart === undefined) continue; // 本月新成立企业没有期初快照
        const stats = company.lastMonth;
        const gain = stats.refundGain ?? 0;
        expect(gain).toBeGreaterThanOrEqual(0);
        if (gain > 0.01) sawRefundGain += 1;
        // 利润保留退款收益（否则利润与现金流不一致）。
        expect(
          Math.abs(
            round2(
              stats.revenue -
                (stats.cogs ?? 0) -
                stats.wagesPaid -
                stats.corporateTax -
                stats.interestPaid +
                (stats.bonusPaid ?? 0) +
                gain -
                stats.profit,
            ),
          ),
        ).toBe(0);
        // 成本链：期初 + 采购现金 − COGS − 注销 + 退款收益 = 期末账面。
        const expectedBook = round2(
          bookStart + stats.inputCost - (stats.cogs ?? 0) - (stats.inventoryWriteOff ?? 0) + gain,
        );
        expect(Math.abs(round2(totalInventoryBookValue(company) - expectedBook))).toBe(0);
      }
    }
    expect(sawRefundGain).toBeGreaterThan(0);

    // 二次读档：格式版本不变，refundGain 保留。
    const saved = createSaveFile(sim.state, '2026-11-05T00:00:00.000Z');
    expect(saved.formatVersion).toBe(SAVE_FORMAT_VERSION);
    const parsed = parseSave(JSON.stringify(saved));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || !parsed.world) return;
    const preserved = parsed.world.companies.filter(
      (company) => (company.lastMonth.refundGain ?? 0) > 0.01,
    );
    expect(preserved.length).toBeGreaterThan(0);

    // 旧档缺 refundGain：读取不报错，字段缺省（结算时按 0 处理，利润口径不跳变）。
    const raw = JSON.parse(JSON.stringify(saved)) as {
      world: { companies: Record<string, unknown>[] };
    };
    for (const company of raw.world.companies) {
      for (const key of ['lastMonth', 'previousMonth']) {
        const stats = company[key] as Record<string, unknown>;
        delete stats.refundGain;
      }
    }
    const legacy = parseSave(JSON.stringify(raw));
    expect(legacy.ok).toBe(true);
    if (!legacy.ok || !legacy.world) return;
    expect(
      legacy.world.companies.some((company) => company.lastMonth.refundGain !== undefined),
    ).toBe(false);
  });
});
