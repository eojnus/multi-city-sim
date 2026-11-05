// v1.3 §3：库存成本结转（moving weighted average）的守恒与旧档兼容测试。
//
// 口径：
// - 采购/调入：数量与账面成本同时增加（买家实付金额入账）；
// - 生产消耗原料：按移动加权平均成本从原料存货转入成品存货（资产内部结转，不产生费用）；
// - 销售/调出：账面成本结转为当期 COGS；利润 = 营收 − COGS − 期间费用；
// - 采购现金支出 inputCost 只用于现金流，不再直接进入利润；
// - 破产清算：剩余存货按账面价值注销，记 inventoryWriteOff，不重复计入 COGS。
import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation/core/simulation';
import { DEMO_CONFIG } from '../src/data/config';
import type { Company, GoodId, WorldState } from '../src/simulation/contracts/types';
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
