// v1.2 §3：食品缺货 → 计划恢复 → 原料采购 → 实际生产 的跨模块集成链。
//
// 与 tests/production-demand-v11.test.ts 的单点口径测试互补：这里从真实
// city.market 的“可支付缺货”信号出发，依次经过 planCompanies（计划）、
// runInputPurchasing（真实买入本地供应商库存）、runProduction（真实消耗原料），
// 断言同一家食品厂能沿着这条链把缺货变成产量，而不是只在单个函数里成立。
import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation/core/simulation';
import { DEMO_CONFIG } from '../src/data/config';
import { RECIPES } from '../src/data/demo-data';
import type {
  CompanyMonthlyStats,
  CompanyProductionPlan,
  MarketState,
  WorldState,
} from '../src/simulation/contracts/types';
import { round2 } from '../src/simulation/core/math';
import {
  createEmptyInventory,
  setCompanyEmployees,
} from '../src/simulation/companies/company';
import { payableShortageFromMarket } from '../src/simulation/companies/production-plan';
import { planCompanies } from '../src/simulation/companies/planning';
import {
  runInputPurchasing,
  runProduction,
} from '../src/simulation/production/production';
import { createWorldLedgers } from '../src/simulation/markets/markets';

function monthStats(overrides: Partial<CompanyMonthlyStats> = {}): CompanyMonthlyStats {
  return {
    revenue: 0,
    inputCost: 0,
    wagesPaid: 0,
    wageArrears: 0,
    interestPaid: 0,
    corporateTax: 0,
    dividendsPaid: 0,
    profit: 0,
    produced: 0,
    sold: 0,
    exported: 0,
    unmetDemand: 0,
    capacityChange: 0,
    dividendIncome: 0,
    ...overrides,
  };
}

function priorPlan(
  world: WorldState,
  companyId: string,
  plannedOutput: number,
): CompanyProductionPlan {
  return {
    tick: world.time.tick - 1,
    salesReference: 0,
    targetInventory: 0,
    equipmentLimit: 0,
    laborLimit: 0,
    plannedOutput,
    plannedJobs: 0,
    emergency: false,
    reasons: [],
  };
}

function setMarket(
  city: WorldState['cities'][number],
  good: string,
  patch: Partial<MarketState>,
): void {
  const current = city.market[good as keyof typeof city.market] ?? {
    price: 1,
    supply: 0,
    demand: 0,
    consumerDemand: 0,
    producerRequired: 0,
    producerDemand: 0,
    sold: 0,
    unmetDemand: 0,
    unmetFunding: 0,
    intercityImported: 0,
    externalExport: 0,
    closingStock: 0,
    lastPriceChangePct: 0,
    consumptionTax: 0,
  };
  city.market[good as keyof typeof city.market] = { ...current, ...patch } as never;
}

function cityOf(world: WorldState, cityId: string): WorldState['cities'][number] {
  const city = world.cities.find((entry) => entry.id === cityId);
  if (!city) throw new Error(`missing city ${cityId}`);
  return city;
}

describe('v1.2 §3 食品缺货→计划→采购→生产 跨模块集成', () => {
  it('真实可支付缺货驱动食品厂恢复计划、买入原料并产出食品', () => {
    const world = Simulation.create().state;
    const company = world.companies.find((entry) => entry.id === 'lp-food');
    expect(company).toBeDefined();
    if (!company) return;
    const city = cityOf(world, company.cityId);

    // 其他企业不占员工，保证该食品厂有劳动力可用。
    for (const other of world.companies) {
      if (other.id !== company.id) setCompanyEmployees(other, 0);
    }

    // 本地供应商持有充足粮食/能源库存；市场原料价格可负担。
    const supplier = world.companies.find(
      (entry) => entry.cityId === city.id && entry.id !== company.id,
    );
    expect(supplier).toBeDefined();
    if (!supplier) return;
    supplier.inventory.grain = 1_000_000_000;
    supplier.inventory.energy = 1_000_000_000;
    setMarket(city, 'grain', { price: 1 });
    setMarket(city, 'energy', { price: 1 });

    // 食品市场：有支付能力的有效需求高、本地成交为 0 → 真实可支付缺货。
    setMarket(city, 'food', {
      consumerDemand: 1_000_000,
      producerDemand: 0,
      producerRequired: 0,
      sold: 0,
      intercityImported: 0,
      unmetDemand: 1_000_000,
      unmetFunding: 0,
      closingStock: 0,
      supply: 0,
    });
    expect(payableShortageFromMarket(city.market.food, 'food')).toBeGreaterThan(0);

    // 企业：有钱、有员工、无库存、历史零销量 + 低位旧计划（模拟被历史销量压住的食品厂）。
    setCompanyEmployees(company, 20_000);
    company.cash = 1_000_000_000_000;
    company.inventory = createEmptyInventory();
    company.utilization = 0;
    company.salesHistory = [0, 0, 0];
    company.previousMonth = monthStats({ produced: 0, sold: 0 });
    company.productionPlan = priorPlan(world, company.id, 1_000);

    // 1) 计划恢复：缺货信号应把计划从 1,000 抬升，并记录缺货理由。
    planCompanies(world, DEMO_CONFIG, []);
    const plan = company.productionPlan;
    expect(plan).not.toBeNull();
    if (!plan) return;
    expect(plan.plannedOutput).toBeGreaterThan(1_000);
    expect(plan.reasons.some((reason) => reason.includes('缺货'))).toBe(true);

    // 2) 采购：按新计划买入原料，粮食库存应覆盖计划所需。
    runInputPurchasing(world, createWorldLedgers(world), DEMO_CONFIG, []);
    const recipe = RECIPES[company.recipeOutput];
    const grainInput = recipe.inputs.find((input) => input.good === 'grain');
    expect(grainInput).toBeDefined();
    const grainNeed = round2(plan.plannedOutput * (grainInput?.qty ?? 0));
    expect(company.inventory.grain ?? 0).toBeGreaterThan(0);
    expect(company.inventory.grain ?? 0).toBeGreaterThanOrEqual(grainNeed - 0.01);

    // 3) 生产：真实消耗原料产出食品，产量落在计划范围内。
    const records = runProduction(world, createWorldLedgers(world), DEMO_CONFIG);
    const record = records.find((entry) => entry.companyId === company.id);
    expect(record).toBeDefined();
    if (!record) return;
    expect(record.qty).toBeGreaterThan(0);
    expect(record.qty).toBeLessThanOrEqual(plan.plannedOutput + 0.01);
    expect(company.inventory.food ?? 0).toBeGreaterThan(0);
  });
});
