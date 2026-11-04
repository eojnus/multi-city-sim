// v1.2 §3：生产采购的两阶段公平性（本地优先 + 跨城按剩余缺口比例）。
//
// 修复前 runInputPurchasing 按“输入成本”排序后逐个企业执行，企业内部的跨城补货是
// 全局先到先得：排序靠前的大厂会把别城卖家的库存买光，卖家本城的企业只能吃剩货。
// ironvale t13 谷物市场 supply 2,644k、producerDemand 2,382k，本地 sold 却只有 19k，
// 同期 lanport 从 ironvale 进口谷物 2,679k，导致 iv-food3 计划 1,370k 实际只生产 4k。
//
// 现在拆成两个阶段：
// - 阶段 A：所有企业先买本地可售库存（同城卖家），按输入成本优先级执行；
// - 阶段 B：仍缺货的企业才跨城，可售供给按各企业剩余缺口加权分配（0.01 精度）。
// 需求记账、融资裁决与账本口径不变：producerRequired − 成交 = unmetDemand + unmetFunding。
import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation/core/simulation';
import { DEMO_CONFIG } from '../src/data/config';
import type {
  Company,
  CompanyProductionPlan,
  PlayerOperationMode,
  WorldState,
} from '../src/simulation/contracts/types';
import { round2 } from '../src/simulation/core/math';
import {
  createEmptyInventory,
  monthlyWageBill,
  setCompanyEmployees,
} from '../src/simulation/companies/company';
import { runInputPurchasing } from '../src/simulation/production/production';
import {
  createWorldLedgers,
  type MarketLedger,
  type WorldLedgers,
} from '../src/simulation/markets/markets';
import { setOperationMode } from '../src/simulation/management/operations';
import { bankLoansOf } from '../src/simulation/banking/credit';
import { RECIPES } from '../src/data/demo-data';

const FOOD_GRAIN_PER_UNIT =
  RECIPES.food.inputs.find((entry) => entry.good === 'grain')?.qty ?? 0.62;

function newWorld(): WorldState {
  return Simulation.create().state;
}

function companyOf(world: WorldState, id: string): Company {
  const company = world.companies.find((entry) => entry.id === id);
  if (!company) throw new Error(`测试世界没有企业 ${id}`);
  return company;
}

/** 清空所有企业的利用率、库存与旧计划，只留下测试显式设置的供应。 */
function isolateMarket(world: WorldState): void {
  for (const company of world.companies) {
    company.utilization = 0;
    company.inventory = createEmptyInventory();
    company.productionPlan = null;
  }
}

function planOf(world: WorldState, plannedOutput: number): CompanyProductionPlan {
  return {
    tick: world.time.tick,
    salesReference: plannedOutput,
    targetInventory: 0,
    equipmentLimit: 10_000_000,
    laborLimit: 10_000_000,
    plannedOutput,
    plannedJobs: 1,
    emergency: false,
    reasons: [],
  };
}

/** 准备一家按计划生产食品、现金充裕的采购方。 */
function prepareFoodBuyer(
  world: WorldState,
  id: string,
  plannedOutput: number,
  cash = 1_000_000_000,
): Company {
  const buyer = companyOf(world, id);
  buyer.utilization = DEMO_CONFIG.company.initialUtilization;
  setCompanyEmployees(buyer, 30);
  buyer.cash = cash;
  buyer.debt = 0;
  buyer.productionPlan = planOf(world, plannedOutput);
  return buyer;
}

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

function ledgerOf(ledgers: WorldLedgers, cityId: string, goodId: 'grain'): MarketLedger {
  const ledger = ledgers[cityId]?.[goodId];
  if (!ledger) throw new Error(`缺少 ${cityId}/${goodId} 账本`);
  return ledger;
}

describe('生产采购两阶段成交（v1.2）', () => {
  it('阶段 A 本地优先：卖家本城企业的需求先被满足，外城只能买剩余部分', () => {
    const world = newWorld();
    isolateMarket(world);
    const seller = companyOf(world, 'iv-grain2');
    seller.inventory.grain = 1000;
    const localBuyer = prepareFoodBuyer(world, 'iv-food', 1000);
    const remoteBuyer = prepareFoodBuyer(world, 'lp-food', 1000);
    const shortage = round2(1000 * FOOD_GRAIN_PER_UNIT);
    expect(shortage).toBeGreaterThan(0);
    expect(shortage).toBeLessThanOrEqual(1000);

    const ledgers = createWorldLedgers(world);
    runInputPurchasing(world, ledgers, DEMO_CONFIG, []);

    // 本地买家在阶段 A 一次买满；外城买家在阶段 B 只能拿到剩余供给。
    expect(localBuyer.inventory.grain ?? 0).toBeCloseTo(shortage, 2);
    expect(remoteBuyer.inventory.grain ?? 0).toBeCloseTo(round2(1000 - shortage), 2);

    // 本地成交记卖家城市 sold，跨城成交记买家城市 intercityImported，不重复计入。
    const sellerLedger = ledgerOf(ledgers, 'ironvale', 'grain');
    const remoteLedger = ledgerOf(ledgers, 'lanport', 'grain');
    expect(sellerLedger.sold).toBeCloseTo(shortage, 2);
    expect(sellerLedger.intercityImported).toBeCloseTo(0, 2);
    expect(remoteLedger.sold).toBeCloseTo(0, 2);
    expect(remoteLedger.intercityImported).toBeCloseTo(round2(1000 - shortage), 2);

    // 缺货只记录未成交的有效需求；卖家城市没有缺货。
    expect(sellerLedger.unmetDemand).toBeCloseTo(0, 2);
    expect(remoteLedger.unmetDemand).toBeCloseTo(round2(shortage - (1000 - shortage)), 2);
    expect(remoteLedger.producerDemand).toBeCloseTo(shortage, 2);

    // 守恒：卖家库存减少 = 两个买家的进货之和。
    expect((seller.inventory.grain ?? 0) + (localBuyer.inventory.grain ?? 0) + (remoteBuyer.inventory.grain ?? 0)).toBeCloseTo(
      1000,
      2,
    );
    expect(seller.inventory.grain).toBeCloseTo(0, 2);
  });

  it('阶段 B 跨城按剩余缺口比例分配，不先到先得吃光供给', () => {
    const world = newWorld();
    isolateMarket(world);
    const seller = companyOf(world, 'gf-grain');
    seller.inventory.grain = 1000;
    // 两家外城买方（岚港、铁谷），本地都没有谷物供给，缺口相同。
    const lanportBuyer = prepareFoodBuyer(world, 'lp-food', 1000);
    const ironvaleBuyer = prepareFoodBuyer(world, 'iv-food', 1000);
    const shortage = round2(1000 * FOOD_GRAIN_PER_UNIT);

    const ledgers = createWorldLedgers(world);
    runInputPurchasing(world, ledgers, DEMO_CONFIG, []);

    // 1000 供给按 620:620 的缺口比例分配 → 各 500。
    expect(lanportBuyer.inventory.grain ?? 0).toBeCloseTo(500, 2);
    expect(ironvaleBuyer.inventory.grain ?? 0).toBeCloseTo(500, 2);
    expect(
      (lanportBuyer.inventory.grain ?? 0) + (ironvaleBuyer.inventory.grain ?? 0),
    ).toBeCloseTo(1000, 2);
    expect(seller.inventory.grain).toBeCloseTo(0, 2);

    const lanportLedger = ledgerOf(ledgers, 'lanport', 'grain');
    const ironvaleLedger = ledgerOf(ledgers, 'ironvale', 'grain');
    expect(lanportLedger.intercityImported).toBeCloseTo(500, 2);
    expect(ironvaleLedger.intercityImported).toBeCloseTo(500, 2);
    expect(lanportLedger.unmetDemand).toBeCloseTo(round2(shortage - 500), 2);
    expect(ironvaleLedger.unmetDemand).toBeCloseTo(round2(shortage - 500), 2);
    expect(round2(lanportLedger.producerRequired - 500)).toBeCloseTo(
      round2(lanportLedger.unmetDemand + lanportLedger.unmetFunding),
      2,
    );
  });

  it('跨城分配仍受预算约束：预算不足只记资金不足，不成交、不自动举债', () => {
    const world = newWorld();
    isolateMarket(world);
    const seller = companyOf(world, 'gf-grain');
    seller.inventory.grain = 1000;
    const buyer = prepareFoodBuyer(world, 'lp-food', 1000, 0);
    operate(world, buyer.id, 'manual');
    const wageReserve = round2(monthlyWageBill(buyer, DEMO_CONFIG) * 0.5);
    buyer.cash = round2(wageReserve + 0.5);

    const ledgers = createWorldLedgers(world);
    runInputPurchasing(world, ledgers, DEMO_CONFIG, []);

    const ledger = ledgerOf(ledgers, 'lanport', 'grain');
    const shortage = round2(1000 * FOOD_GRAIN_PER_UNIT);
    // 预算只够 0.5，买不起任何一单位谷物：有效需求≈0，计划需求几乎全部落入资金不足。
    expect(ledger.producerRequired).toBeCloseTo(shortage, 2);
    expect(ledger.producerDemand).toBeLessThan(0.1);
    expect(ledger.unmetDemand).toBeCloseTo(0, 2);
    expect(ledger.unmetFunding).toBeCloseTo(round2(shortage - ledger.producerDemand), 2);
    expect(ledger.sold).toBeCloseTo(0, 2);
    expect(ledger.intercityImported).toBeLessThan(0.1);
    expect(buyer.inventory.grain ?? 0).toBeLessThan(0.1);
    // 手动模式不自动举债，卖家的库存也不被这批无效需求占用。
    expect(bankLoansOf(world)).toHaveLength(0);
    expect(seller.inventory.grain ?? 0).toBeGreaterThan(999.9);
  });
});
