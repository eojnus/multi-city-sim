// v1.1 §1+§6：生产需求口径与缺货驱动的计划恢复。
//
// 固定口径：
// - 缺货 = 有支付能力的有效需求 − 已成交（本地 sold + 跨城 intercityImported），
//   并与账本 unmetDemand 取较大值兼容旧档；producerRequired（含买不起部分）与
//   unmetFunding（资金不足）不再被当成缺货，跨城成交不能重复计入；
// - 过去零销量但存在真实有效缺货时，计划按缺货信号恢复（仍受每月 +20% 上限约束），
//   不会因为“历史销量为零”锁死在低位；
// - 员工人数影响实际产量（laborCapacity），招聘后实际产量提升；
// - AI 在真实缺货 + 资金/原料充足时应招聘、采购，扩产条件满足时购买设备。
import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation/core/simulation';
import { DEMO_CONFIG } from '../src/data/config';
import { RECIPES } from '../src/data/demo-data';
import type {
  Company,
  CompanyMonthlyStats,
  CompanyProductionPlan,
  GoodId,
  MarketState,
  WorldState,
} from '../src/simulation/contracts/types';
import { round2 } from '../src/simulation/core/math';
import {
  createEmptyInventory,
  setCompanyEmployees,
} from '../src/simulation/companies/company';
import {
  cityShortageFor,
  payableShortageFromMarket,
  recomputeProductionPlan,
} from '../src/simulation/companies/production-plan';
import { planCompanies } from '../src/simulation/companies/planning';
import { reconcileLabor } from '../src/simulation/labor/labor';
import {
  laborCapacity,
  productionTarget,
  runInputPurchasing,
  runProduction,
} from '../src/simulation/production/production';
import { createWorldLedgers } from '../src/simulation/markets/markets';

const EPSILON = 0.01;

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

function priorPlan(company: Company, plannedOutput: number, tick: number): CompanyProductionPlan {
  return {
    tick,
    salesReference: 0,
    targetInventory: 0,
    equipmentLimit: company.capacity,
    laborLimit: 0,
    plannedOutput,
    plannedJobs: 0,
    emergency: false,
    reasons: [],
  };
}

function cityOf(world: WorldState, cityId: string): WorldState['cities'][number] {
  const city = world.cities.find((entry) => entry.id === cityId);
  if (!city) throw new Error(`测试世界没有城市 ${cityId}`);
  return city;
}

function companyOf(world: WorldState, id: string): Company {
  const company = world.companies.find((entry) => entry.id === id);
  if (!company) throw new Error(`测试世界没有企业 ${id}`);
  return company;
}

function setMarket(
  city: WorldState['cities'][number],
  goodId: GoodId,
  overrides: Partial<MarketState>,
): void {
  city.market[goodId] = { ...city.market[goodId], ...overrides };
}

/** 下一步计划：上期计划 1000，上月零生产零成交（零销量恢复测试的世界）。 */
function stageZeroSales(options: { employees?: number; shortage?: number } = {}): {
  world: WorldState;
  company: Company;
  city: WorldState['cities'][number];
} {
  const world = Simulation.create().state;
  const company = companyOf(world, 'lp-food');
  const city = cityOf(world, company.cityId);
  const employees = options.employees ?? 20_000;
  setCompanyEmployees(company, employees);
  company.jobDemand = employees;
  company.cash = 1_000_000_000_000;
  company.utilization = 0.8;
  company.inventory = createEmptyInventory();
  for (const input of RECIPES[company.recipeOutput].inputs) {
    company.inventory[input.good] = 1_000_000_000;
  }
  company.inventory[company.recipeOutput] = 0;
  company.salesHistory = [0, 0, 0];
  company.previousMonth = monthStats({ produced: 0, sold: 0 });
  company.productionPlan = priorPlan(company, 1000, world.time.tick - 1);
  const shortage = options.shortage ?? 0;
  setMarket(city, company.recipeOutput, {
    consumerDemand: shortage,
    producerDemand: 0,
    producerRequired: 0,
    demand: 0,
    sold: 0,
    unmetDemand: shortage,
    unmetFunding: 0,
    intercityImported: 0,
  });
  return { world, company, city };
}

describe('v1.1 缺货口径：有支付能力的有效需求 − 成交', () => {
  it('资金不足的 producerRequired / unmetFunding 不算缺货', () => {
    const world = Simulation.create().state;
    const city = cityOf(world, 'lanport');
    // 复现验收问题：计划需求 1000、有效需求 0、资金缺口 1000。
    setMarket(city, 'food', {
      consumerDemand: 0,
      producerDemand: 0,
      producerRequired: 1000,
      sold: 0,
      unmetDemand: 0,
      unmetFunding: 1000,
      intercityImported: 0,
    });
    expect(cityShortageFor(world, city, 'food')).toBe(0);
  });

  it('消费品用 consumerDemand，短缺 = 有效需求 − 本地成交', () => {
    const world = Simulation.create().state;
    const city = cityOf(world, 'lanport');
    setMarket(city, 'food', {
      consumerDemand: 1000,
      producerDemand: 0,
      producerRequired: 5000,
      sold: 600,
      unmetDemand: 400,
      unmetFunding: 4000,
      intercityImported: 0,
    });
    expect(cityShortageFor(world, city, 'food')).toBe(400);
  });

  it('跨城进口是成交的一部分，不重复计入缺货', () => {
    const world = Simulation.create().state;
    const city = cityOf(world, 'lanport');
    // 有效需求 1000：本地成交 600 + 跨城进口 300，真实未成交 100。
    setMarket(city, 'food', {
      consumerDemand: 1000,
      sold: 600,
      intercityImported: 300,
      unmetDemand: 100,
      producerRequired: 0,
      producerDemand: 0,
      unmetFunding: 0,
    });
    expect(cityShortageFor(world, city, 'food')).toBe(100);
    // 若把跨城进口漏算，会错报成 400。
    expect(cityShortageFor(world, city, 'food')).not.toBe(400);
  });

  it('中间品用 producerDemand，不使用买不起的 producerRequired', () => {
    const world = Simulation.create().state;
    const city = cityOf(world, 'greenfield');
    setMarket(city, 'grain', {
      consumerDemand: 999_999,
      producerDemand: 500,
      producerRequired: 99_999,
      sold: 200,
      unmetDemand: 300,
      unmetFunding: 99_699,
      intercityImported: 0,
    });
    expect(cityShortageFor(world, city, 'grain')).toBe(300);
  });

  it('旧档只有 unmetDemand 时安全回退', () => {
    expect(payableShortageFromMarket(undefined, 'food')).toBe(0);
    const world = Simulation.create().state;
    const city = cityOf(world, 'lanport');
    setMarket(city, 'food', {
      consumerDemand: 0,
      sold: 0,
      intercityImported: 0,
      unmetDemand: 250,
      producerRequired: 0,
      producerDemand: 0,
      unmetFunding: 0,
    });
    expect(cityShortageFor(world, city, 'food')).toBe(250);
  });
});

describe('v1.1 §6 缺货驱动的计划恢复', () => {
  it('过去零销量但存在真实缺货时计划恢复，且每月不超过 +20%', () => {
    // 无缺货：目标为 0，但受 ±20% 平滑下限约束停在 800。
    const quiet = stageZeroSales();
    const quietPlan = recomputeProductionPlan(quiet.world, quiet.company, DEMO_CONFIG);
    expect(quietPlan.plannedOutput).toBe(800);
    expect(quietPlan.reasons.some((reason) => reason.includes('城市缺货'))).toBe(false);
    expect(quietPlan.reasons.some((reason) => reason.includes('无实际成交'))).toBe(false);

    // 有真实有效缺货：不能因为近 3 月销量为 0 就把计划锁死在低位。
    const { world, company } = stageZeroSales({ shortage: 200_000 });
    const first = recomputeProductionPlan(world, company, DEMO_CONFIG);
    expect(first.plannedOutput).toBeGreaterThan(quietPlan.plannedOutput);
    expect(first.plannedOutput).toBeLessThanOrEqual(1000 * 1.2 + EPSILON);
    expect(first.reasons.some((reason) => reason.includes('城市缺货'))).toBe(true);
    expect(first.reasons.some((reason) => reason.includes('无实际成交'))).toBe(true);

    // 下个月继续按缺货吸收恢复（仍受 +20% 平滑上限）。
    world.time.tick += 1;
    const second = recomputeProductionPlan(world, company, DEMO_CONFIG);
    expect(second.plannedOutput).toBeGreaterThan(first.plannedOutput);
    expect(second.plannedOutput).toBeLessThanOrEqual(first.plannedOutput * 1.2 + EPSILON);
  });

  it('员工人数影响实际产量，招聘后实际产量提升', () => {
    const world = Simulation.create().state;
    const company = companyOf(world, 'lp-food');
    const city = cityOf(world, company.cityId);
    for (const other of world.companies) {
      if (other.id !== company.id) setCompanyEmployees(other, 0);
    }
    company.cash = 1_000_000_000_000;
    company.salesHistory = [1_000_000];
    company.utilization = 0.8;
    company.productionPlan = null;
    company.previousMonth = monthStats({ produced: 1_000_000, sold: 1_000_000 });
    const refillInputs = (): void => {
      company.inventory = createEmptyInventory();
      for (const input of RECIPES[company.recipeOutput].inputs) {
        company.inventory[input.good] = 1_000_000_000;
      }
    };

    setCompanyEmployees(company, 100);
    refillInputs();
    const fewLabor = laborCapacity(company, city, DEMO_CONFIG, world);
    const fewRecords = runProduction(world, createWorldLedgers(world), DEMO_CONFIG);
    const few = fewRecords.find((record) => record.companyId === company.id)!;
    expect(few).toBeDefined();
    expect(few.qty).toBeCloseTo(
      Math.floor(
        Math.min(productionTarget(company), company.capacity, fewLabor) * 100,
      ) / 100,
      2,
    );

    setCompanyEmployees(company, 20_000);
    refillInputs();
    const moreLabor = laborCapacity(company, city, DEMO_CONFIG, world);
    const moreRecords = runProduction(world, createWorldLedgers(world), DEMO_CONFIG);
    const more = moreRecords.find((record) => record.companyId === company.id)!;
    expect(moreLabor).toBeGreaterThan(fewLabor);
    expect(more.qty).toBeGreaterThan(few.qty);
    expect(more.qty).toBeLessThanOrEqual(productionTarget(company) + EPSILON);
  });

  it('缺货 + 资金充足时 AI 主动招聘，计划岗位高于现有员工', () => {
    const { world, company, city } = stageZeroSales({ employees: 2, shortage: 200_000 });
    // 保证本城有可招聘的失业人口，便于验证实际补员。
    const cityPopulation = city.population;
    cityPopulation.total = round2(cityPopulation.total + 1000);
    cityPopulation.unemployed = round2(cityPopulation.unemployed + 1000);
    cityPopulation.laborForce = round2(cityPopulation.laborForce + 1000);

    planCompanies(world, DEMO_CONFIG, []);
    expect(company.ai.lastPlan).not.toBeNull();
    expect(company.jobDemand).toBeGreaterThan(2);
    const reasons = company.ai.lastPlan?.reasons ?? [];
    expect(reasons.some((reason) => reason.includes('缺货') || reason.includes('招聘'))).toBe(true);

    const result = reconcileLabor(world, DEMO_CONFIG, []);
    expect(result.hiresByCompany[company.id] ?? 0).toBeGreaterThan(0);
    expect(company.employees).toBeGreaterThan(2);
  });

  it('缺货 + 资金充足时缺货驱动扩产，设备采购可见', () => {
    const world = Simulation.create().state;
    const company = companyOf(world, 'lp-food');
    const city = cityOf(world, company.cityId);
    setCompanyEmployees(company, 30_000);
    company.jobDemand = 30_000;
    company.cash = 1_000_000_000_000;
    company.utilization = 0.8;
    company.inventory = createEmptyInventory();
    for (const input of RECIPES[company.recipeOutput].inputs) {
      company.inventory[input.good] = 1_000_000_000;
    }
    company.salesHistory = [3_500_000];
    // 上月实际生产为 0（利用率 0），旧口径下会被永久卡住；本月计划利用率会达标。
    company.previousMonth = monthStats({
      produced: 0,
      sold: 3_500_000,
      profit: 1_000_000,
    });
    company.productionPlan = priorPlan(company, 3_900_000, world.time.tick - 1);
    setMarket(city, company.recipeOutput, {
      consumerDemand: 1_000_000,
      producerDemand: 0,
      producerRequired: 0,
      demand: 0,
      sold: 0,
      unmetDemand: 1_000_000,
      unmetFunding: 0,
      intercityImported: 0,
    });
    const capacityBefore = company.capacity;

    planCompanies(world, DEMO_CONFIG, []);

    const plan = company.ai.lastPlan;
    expect(plan).not.toBeNull();
    expect((plan?.investment ?? 0) + company.equipment.industry).toBeGreaterThan(0);
    const reasons = plan?.reasons ?? [];
    expect(
      reasons.some((reason) => reason.includes('缺货驱动') || reason.includes('扩产条件满足')),
    ).toBe(true);
    expect(company.capacity).toBeGreaterThan(capacityBefore);
  });

  it('缺货 + 资金充足时 AI 主动采购原料，需求记账不因缺货归零', () => {
    const world = Simulation.create().state;
    const company = companyOf(world, 'lp-food');
    const city = cityOf(world, company.cityId);
    for (const other of world.companies) {
      if (other.id !== company.id) setCompanyEmployees(other, 0);
    }
    // 本地供应商：另一家兰港企业持有粮食/能源库存。
    const supplier = world.companies.find(
      (entry) => entry.cityId === city.id && entry.id !== company.id,
    )!;
    supplier.inventory.grain = 1_000_000_000;
    supplier.inventory.energy = 1_000_000_000;
    setMarket(city, 'grain', { price: Math.max(0.01, city.market.grain?.price ?? 1) });
    setMarket(city, 'energy', { price: Math.max(0.01, city.market.energy?.price ?? 1) });

    setCompanyEmployees(company, 20_000);
    company.cash = 1_000_000_000_000;
    company.inventory = createEmptyInventory();
    company.salesHistory = [1000];
    company.previousMonth = monthStats({ produced: 1000, sold: 1000 });
    company.productionPlan = priorPlan(company, 1500, world.time.tick - 1);
    const grainBefore = company.inventory.grain ?? 0;

    const ledgers = createWorldLedgers(world);
    runInputPurchasing(world, ledgers, DEMO_CONFIG, []);

    const recipe = RECIPES[company.recipeOutput];
    const grainNeed = round2(1500 * recipe.inputs.find((input) => input.good === 'grain')!.qty);
    expect((company.inventory.grain ?? 0) - grainBefore).toBeCloseTo(grainNeed, 1);
    const ledger = ledgers[city.id]!.grain;
    expect(ledger.producerRequired).toBeGreaterThanOrEqual(grainNeed - EPSILON);
    expect(ledger.producerDemand).toBeGreaterThan(0);
    expect(ledger.sold).toBeGreaterThan(0);
  });
});
