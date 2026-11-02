// 验收复验：市场需求记账。
//
// 修复前 production.ts 以“可成交数量”记录生产需求：企业有资金、有采购计划，
// 但本地与跨城都没有供应时 needs 为空提前跳过，producerDemand / unmetDemand 都是 0，
// 市场把真实缺货显示成“没有需求”，影响价格与创办企业的判断。
//
// 本文件固定以下口径：
// - producerRequired：按生产计划需要采购的数量（资金不足前，完全无供应也要记录）；
// - producerDemand / demand：计划需求中“自有采购预算 + 合法可用授信”买得起的那部分；
// - 实际成交 = 本地成交 + 跨城进口；
// - unmetDemand：有效需求中因缺货/配送不足未成交的数量；
// - unmetFunding：计划需求中因资金不足未形成有效需求的数量。
import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation/core/simulation';
import { DEMO_CONFIG } from '../src/data/config';
import type { Company, GoodId, PlayerOperationMode, WorldState } from '../src/simulation/contracts/types';
import { round2 } from '../src/simulation/core/math';
import {
  createEmptyInventory,
  monthlyWageBill,
  setCompanyEmployees,
} from '../src/simulation/companies/company';
import {
  laborCapacity,
  productionTarget,
  runInputPurchasing,
} from '../src/simulation/production/production';
import { createWorldLedgers, type MarketLedger, type WorldLedgers } from '../src/simulation/markets/markets';
import { setOperationMode } from '../src/simulation/management/operations';
import { bankLoansOf } from '../src/simulation/banking/credit';
import { RECIPES } from '../src/data/demo-data';

function newWorld(): WorldState {
  return Simulation.create().state;
}

function companyOf(world: WorldState, id: string): Company {
  const company = world.companies.find((entry) => entry.id === id);
  if (!company) throw new Error(`测试世界没有企业 ${id}`);
  return company;
}

/** 清空所有企业的利用率与库存，只留下测试指定的供应，避免随机库存干扰断言。 */
function isolateMarket(world: WorldState): void {
  for (const company of world.companies) {
    company.utilization = 0;
    company.inventory = createEmptyInventory();
  }
}

/** 让岚港食品厂恢复生产、库存为空，并设定现金。 */
function prepareBuyer(world: WorldState, cash: number): Company {
  const buyer = companyOf(world, 'lp-food');
  buyer.utilization = DEMO_CONFIG.company.initialUtilization;
  setCompanyEmployees(buyer, 3);
  buyer.cash = cash;
  buyer.debt = 0;
  return buyer;
}

/** 把玩家设为该企业经营者并设置经营模式。 */
function operate(world: WorldState, companyId: string, mode: PlayerOperationMode): void {
  const control = world.governance.controls.find((entry) => entry.companyId === companyId);
  if (!control) throw new Error('企业缺少治理控制记录');
  control.operator = { type: 'player', id: 'player' };
  control.basis = 'election';
  control.operatorId = null;
  control.termEndTick = null;
  const result = setOperationMode(world, companyId, mode, DEMO_CONFIG, 0);
  if (!result.ok) throw new Error(result.error);
}

/** 按当前产能/劳动力计算该企业的计划采购量（库存为空）。 */
function plannedShortage(world: WorldState, buyer: Company, goodId: GoodId): number {
  const city = world.cities.find((entry) => entry.id === buyer.cityId);
  if (!city) throw new Error('企业缺少城市');
  const recipe = RECIPES[buyer.recipeOutput];
  const input = recipe?.inputs.find((entry) => entry.good === goodId);
  if (!input) throw new Error(`配方不含 ${goodId}`);
  const target = Math.min(productionTarget(buyer), laborCapacity(buyer, city, DEMO_CONFIG, world));
  const required = round2(target * input.qty);
  const inStock = buyer.inventory[goodId] ?? 0;
  return Math.max(0, round2(required - inStock));
}

function ledgerOf(ledgers: WorldLedgers, cityId: string, goodId: GoodId): MarketLedger {
  const ledger = ledgers[cityId]?.[goodId];
  if (!ledger) throw new Error(`缺少 ${cityId}/${goodId} 账本`);
  return ledger;
}

/** 本地卖家的实际单价（市价 × 价格系数，与成交规则一致）。 */
function localUnitPrice(world: WorldState, cityId: string, goodId: GoodId, sellerId: string): number {
  const city = world.cities.find((entry) => entry.id === cityId);
  if (!city) throw new Error(`测试世界没有城市 ${cityId}`);
  return round2((city.market[goodId]?.price ?? 0) * companyOf(world, sellerId).priceFactor);
}

describe('生产采购的需求记账（验收复验）', () => {
  it('有资金、完全无供应：市场记录计划需求与缺货，不借款、不虚假成交', () => {
    const world = newWorld();
    isolateMarket(world);
    const buyer = prepareBuyer(world, 1_000_000);
    const shortage = plannedShortage(world, buyer, 'grain');
    expect(shortage).toBeGreaterThan(0);

    const ledgers = createWorldLedgers(world);
    runInputPurchasing(world, ledgers, DEMO_CONFIG, []);

    const grep = ledgerOf(ledgers, 'lanport', 'grain');
    // 计划需求必须记录，不能因为“没有可成交数量”就归零。
    expect(grep.producerRequired).toBeCloseTo(shortage, 2);
    // 有足够资金：有效需求 = 计划需求；没有供应 → 全部是缺货未满足。
    expect(grep.producerDemand).toBeCloseTo(shortage, 2);
    expect(grep.unmetDemand).toBeCloseTo(shortage, 2);
    expect(grep.unmetFunding).toBe(0);
    expect(grep.sold).toBe(0);

    // 不借款、不成交、现金不变。
    expect(bankLoansOf(world)).toHaveLength(0);
    expect(buyer.debt).toBe(0);
    expect(buyer.cash).toBeCloseTo(1_000_000, 2);
  });

  it('有资金、部分供应：不能把可售数量当成全部需求，未成交部分记为缺货', () => {
    const world = newWorld();
    isolateMarket(world);
    const buyer = prepareBuyer(world, 1_000_000);
    const seller = companyOf(world, 'lp-garment');
    seller.inventory.grain = 4;
    const shortage = plannedShortage(world, buyer, 'grain');
    expect(shortage).toBeGreaterThan(4);

    const ledgers = createWorldLedgers(world);
    runInputPurchasing(world, ledgers, DEMO_CONFIG, []);

    const bought = buyer.inventory.grain ?? 0;
    expect(bought).toBeGreaterThan(0);
    expect(bought).toBeLessThan(shortage);
    const grep = ledgerOf(ledgers, 'lanport', 'grain');
    // 需求仍是计划需求（买得起），不是可售的 4。
    expect(grep.producerDemand).toBeCloseTo(shortage, 2);
    expect(grep.sold).toBeCloseTo(bought, 2);
    expect(grep.unmetDemand).toBeCloseTo(round2(shortage - bought), 2);
    expect(grep.unmetFunding).toBe(0);
    // 对账：计划需求 − 成交 = 缺货未满足 + 资金不足。
    expect(round2(grep.producerRequired - bought)).toBeCloseTo(
      round2(grep.unmetDemand + grep.unmetFunding),
      2,
    );
  });

  it('需求存在但资金不足：有效需求按买得起的量记录，其余记为资金不足', () => {
    const world = newWorld();
    isolateMarket(world);
    const seller = companyOf(world, 'lp-garment');
    seller.inventory.grain = 1000;
    const unit = localUnitPrice(world, 'lanport', 'grain', seller.id);
    const probe = prepareBuyer(world, 0);
    const wageReserve = round2(monthlyWageBill(probe, DEMO_CONFIG) * 0.5);
    // 手动模式不会自动举债，购买力只有采购预算；预算恰好够 3 单位谷物。
    const buyer = prepareBuyer(world, round2(wageReserve + unit * 3));
    operate(world, buyer.id, 'manual');
    const shortage = plannedShortage(world, buyer, 'grain');
    // 采购前的预算：现金扣除工资预留；采购后现金会被花掉，必须提前计算。
    const budget = round2(buyer.cash - wageReserve);
    const expectedDemand = round2(Math.min(shortage, Math.floor((budget / unit) * 100) / 100));

    const ledgers = createWorldLedgers(world);
    runInputPurchasing(world, ledgers, DEMO_CONFIG, []);

    expect(expectedDemand).toBeGreaterThan(0);
    const grep = ledgerOf(ledgers, 'lanport', 'grain');
    expect(grep.producerDemand).toBeCloseTo(expectedDemand, 2);
    expect(grep.unmetFunding).toBeCloseTo(round2(shortage - expectedDemand), 2);
    expect(grep.unmetDemand).toBeCloseTo(0, 2);
    expect(buyer.inventory.grain ?? 0).toBeCloseTo(expectedDemand, 2);
    // 手动模式不自动举债。
    expect(buyer.debt).toBe(0);
    expect(bankLoansOf(world)).toHaveLength(0);
  });

  it('本地不足、跨城补货：需求不重复计算，本地成交 + 进口 = 实际成交', () => {
    const world = newWorld();
    isolateMarket(world);
    const buyer = prepareBuyer(world, 1_000_000);
    const localSeller = companyOf(world, 'lp-garment');
    localSeller.inventory.grain = 3;
    const remoteSeller = companyOf(world, 'gf-grain');
    remoteSeller.inventory.grain = 100;
    const shortage = plannedShortage(world, buyer, 'grain');

    const ledgers = createWorldLedgers(world);
    runInputPurchasing(world, ledgers, DEMO_CONFIG, []);

    const bought = buyer.inventory.grain ?? 0;
    const grep = ledgerOf(ledgers, 'lanport', 'grain');
    // 需求只记一次（计划需求），本地成交与跨城进口都算成交，不重复计入需求。
    expect(grep.producerDemand).toBeCloseTo(shortage, 2);
    expect(grep.sold + grep.intercityImported).toBeCloseTo(bought, 2);
    expect(grep.intercityImported).toBeGreaterThan(0);
    expect(grep.unmetDemand).toBeCloseTo(round2(shortage - bought), 2);
    expect(grep.unmetFunding).toBe(0);
    // 资金对账：采购支出只来自自有现金，不产生债务。
    expect(buyer.debt).toBe(0);
    expect(buyer.cash).toBeLessThan(1_000_000);
  });

  it('无供应时不产生贷款，但市场仍反映有效需求与缺货（有授信）', () => {
    const world = newWorld();
    isolateMarket(world);
    const buyer = prepareBuyer(world, 0);
    const shortage = plannedShortage(world, buyer, 'grain');

    const ledgers = createWorldLedgers(world);
    runInputPurchasing(world, ledgers, DEMO_CONFIG, []);

    // 没有任何可售供应：银行可借额度不能变成“无关贷款”。
    expect(bankLoansOf(world)).toHaveLength(0);
    expect(buyer.debt).toBe(0);
    expect(buyer.cash).toBe(0);

    const grep = ledgerOf(ledgers, 'lanport', 'grain');
    expect(grep.producerRequired).toBeCloseTo(shortage, 2);
    // 合法授信构成购买力：有效需求存在，并且全部表现为缺货未满足。
    expect(grep.producerDemand).toBeGreaterThan(0);
    expect(grep.producerDemand).toBeCloseTo(shortage, 2);
    expect(grep.unmetDemand).toBeCloseTo(grep.producerDemand, 2);
    expect(grep.unmetFunding).toBe(0);
  });

  it('零预算但有授信与供应：仍可融资采购（保留上一轮修复）', () => {
    const world = newWorld();
    isolateMarket(world);
    const buyer = prepareBuyer(world, 0);
    const grainSeller = companyOf(world, 'lp-garment');
    const energySeller = companyOf(world, 'lp-energy');
    grainSeller.inventory.grain = 10;
    energySeller.inventory.energy = 10;

    const ledgers = createWorldLedgers(world);
    runInputPurchasing(world, ledgers, DEMO_CONFIG, []);

    const grainBought = buyer.inventory.grain ?? 0;
    const energyBought = buyer.inventory.energy ?? 0;
    expect(grainBought).toBeGreaterThan(0);
    expect(energyBought).toBeGreaterThan(0);
    // 借款只覆盖实际成交支出，资金全部用于采购。
    const grainUnit = localUnitPrice(world, 'lanport', 'grain', grainSeller.id);
    const energyUnit = localUnitPrice(world, 'lanport', 'energy', energySeller.id);
    expect(buyer.debt).toBeCloseTo(round2(grainBought * grainUnit + energyBought * energyUnit), 2);
    expect(buyer.cash).toBeCloseTo(0, 2);
    expect(bankLoansOf(world).length).toBeGreaterThan(0);

    // 需求记账同样成立：成交 + 未满足 = 计划需求（资金不足部分另记）。
    const grep = ledgerOf(ledgers, 'lanport', 'grain');
    expect(round2(grep.producerRequired - grainBought)).toBeCloseTo(
      round2(grep.unmetDemand + grep.unmetFunding),
      2,
    );
  });
});
