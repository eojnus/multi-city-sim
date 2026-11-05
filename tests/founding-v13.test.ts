import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation/core/simulation';
import { DEMO_CONFIG } from '../src/data/config';
import { GOODS } from '../src/data/demo-data';
import type { GoodId, WorldState } from '../src/simulation/contracts/types';
import {
  assessFounding,
  foundingAttempts,
  foundingAttemptsTruncated,
  foundingAttemptSnapshot,
  recordFoundingAttempt,
} from '../src/simulation/companies/founding';
import {
  expandCompanyCapacity,
  foundCompany,
  maybeFoundCompanies,
} from '../src/simulation/companies/lifecycle/lifecycle';
import {
  equipmentCapacityPerUnit,
  equipmentKindForSector,
} from '../src/simulation/equipment/equipment';
import { outputPerEmployee } from '../src/simulation/companies/production-plan';
import { planCompanies } from '../src/simulation/companies/planning';
import { monthlyWageBill } from '../src/simulation/companies/company';
import { checkInvariants } from '../src/simulation/core/invariants';

function newWorld(): WorldState {
  return Simulation.create(DEMO_CONFIG).state;
}

function cityOf(world: WorldState, cityId = 'lanport') {
  return world.cities.find((city) => city.id === cityId)!;
}

function basePriceOf(output: GoodId): number {
  return GOODS.find((good) => good.id === output)!.basePrice;
}

/** 制造“售价合理上涨 + 有支付能力但未满足需求”的食品缺口。 */
function seedGap(world: WorldState, cityId = 'lanport', output: GoodId = 'food'): void {
  const market = cityOf(world, cityId).market[output];
  market.price = Math.round(basePriceOf(output) * 1.3 * 100) / 100;
  market.lastPriceChangePct = 8;
  market.demand = 40_000;
  market.sold = 12_000;
  market.unmetDemand = 28_000;
}

function makeRich(world: WorldState): void {
  for (const city of world.cities) {
    city.treasury = 200_000_000;
    for (const group of world.investors) {
      if (group.cityId === city.id) group.cash = 2_000_000_000;
    }
    for (const company of world.companies) {
      if (company.cityId === city.id) company.cash = 1_000_000_000;
    }
  }
}

describe('v1.3 创业评估快照与规模口径', () => {
  it('foundingAttempts 记录结构化快照，窗口溢出时显式标注截断', () => {
    const world = newWorld();
    makeRich(world);
    seedGap(world);
    maybeFoundCompanies(world, DEMO_CONFIG, []);
    const attempts = foundingAttempts(world);
    expect(attempts.length).toBeGreaterThan(0);
    for (const attempt of attempts) {
      expect(Number.isFinite(attempt.demandGap)).toBe(true);
      expect(Number.isFinite(attempt.price)).toBe(true);
      expect(Number.isFinite(attempt.expectedPrice)).toBe(true);
      expect(Number.isFinite(attempt.unitCost)).toBe(true);
      expect(Number.isFinite(attempt.availableFunding)).toBe(true);
      expect(Number.isFinite(attempt.loanAvailable)).toBe(true);
      expect(Number.isFinite(attempt.equipmentNeed)).toBe(true);
      expect(Number.isFinite(attempt.capitalNeed)).toBe(true);
      expect(Number.isFinite(attempt.expectedUnits)).toBe(true);
      expect(Number.isFinite(attempt.expectedJobs)).toBe(true);
      expect(Array.isArray(attempt.obstacles)).toBe(true);
    }
    const founded = attempts.filter((attempt) => attempt.outcome === 'founded');
    expect(founded.length).toBeGreaterThan(0);
    expect(founded[0]!.expectedUnits).toBeGreaterThan(0);
    expect(founded[0]!.expectedJobs).toBeGreaterThan(0);

    // 直接用 >80 条记录验证裁剪与截断计数：报告不得把窗口当全期累计。
    const assessment = assessFounding(world, DEMO_CONFIG, 'lanport', 'food');
    const snapshot = foundingAttemptSnapshot(assessment, assessment.feasibleTier);
    const beforeTruncated = foundingAttemptsTruncated(world);
    for (let index = 0; index < 100; index += 1) {
      recordFoundingAttempt(
        world,
        {
          tick: world.time.tick,
          cityId: 'lanport',
          output: 'food',
          sector: assessment.sector,
          score: assessment.score,
          tierUnits: 1,
          founderType: 'investorGroup',
          outcome: 'rejected',
          obstacles: [{ kind: 'capital', detail: '测试：资金不足' }],
          capital: 0,
          loan: 0,
          note: '测试：裁剪窗口',
          ...snapshot,
        },
        80,
      );
    }
    expect(foundingAttempts(world)).toHaveLength(80);
    expect(foundingAttemptsTruncated(world) - beforeTruncated).toBeGreaterThanOrEqual(20);
  });

  it('在营企业出资时保留 2 个月工资与 1 个月原料，且同 tick 不能连锁抽血', () => {
    const world = newWorld();
    for (const group of world.investors) group.cash = 0;
    for (const company of world.companies) company.cash = 0;
    for (const city of world.cities) city.treasury = 0;
    const founder = world.companies.find((company) => company.cityId === 'lanport')!;
    founder.cash = 500_000_000;
    seedGap(world);
    const wageReserve = monthlyWageBill(founder, DEMO_CONFIG) * 2;

    const result = foundCompany(
      world,
      { cityId: 'lanport', recipeOutput: 'food', log: [] },
      DEMO_CONFIG,
    );
    expect(result.ok).toBe(true);
    expect(result.founderId).toBe(founder.id);
    // 在营企业不能被抽干：出资后至少留下 2 个月工资。
    expect(founder.cash).toBeGreaterThanOrEqual(wageReserve - 0.01);

    // 同 tick 已被用作创办人的企业再次被传入 blocked 时不能再出资（防止 A→B→C）。
    const blockedResult = foundCompany(
      world,
      { cityId: 'lanport', recipeOutput: 'food', log: [] },
      DEMO_CONFIG,
      { blockedCompanyFounders: [founder.id, result.companyId!] },
    );
    expect(blockedResult.ok).toBe(false);
  });

  it('新企业成立即写保守首月计划，岗位与设备产能/人均产出同量纲且首月不欠薪', () => {
    const world = newWorld();
    makeRich(world);
    seedGap(world);
    const created = maybeFoundCompanies(world, DEMO_CONFIG, []);
    expect(created.length).toBeGreaterThan(0);
    const company = world.companies.find((entry) => entry.id === created[0])!;
    const plan = company.productionPlan;
    expect(plan).not.toBeNull();
    expect(company.jobDemand).toBe(plan!.plannedJobs);
    const perEmployee = outputPerEmployee(world, company, DEMO_CONFIG);
    const minOutputRatio = DEMO_CONFIG.production.plan?.minOutputRatio ?? 0.05;
    expect(plan!.plannedOutput).toBeCloseTo(company.equipmentCapacity * minOutputRatio, 0);
    expect(company.jobDemand).toBeLessThanOrEqual(
      Math.max(1, Math.ceil(plan!.plannedOutput / perEmployee)) + 1,
    );
    expect(company.jobDemand * perEmployee).toBeLessThanOrEqual(
      company.equipmentCapacity + perEmployee,
    );
    // 首月工资必须由成立时的周转金覆盖。
    expect(monthlyWageBill(company, DEMO_CONFIG)).toBeLessThanOrEqual(company.cash + 0.01);

    const simulation = new Simulation(world, DEMO_CONFIG);
    simulation.tick();
    expect(company.lastMonth.wageArrears).toBe(0);
    const produced =
      simulation.state.lastTick.productionRecords.find((entry) => entry.companyId === company.id)
        ?.qty ?? 0;
    expect(produced).toBeLessThanOrEqual(company.equipmentCapacity + 0.01);
    expect(checkInvariants(simulation.state, [], DEMO_CONFIG)).toEqual([]);
  });

  it('扩产按“设备台数”执行，产能增量=台数×每台产能×技术系数', () => {
    const world = newWorld();
    const company = world.companies.find((entry) => entry.cityId === 'lanport')!;
    company.cash = 50_000_000;
    const city = cityOf(world, company.cityId);
    const kind = equipmentKindForSector(company.sector, DEMO_CONFIG);
    const unitsBefore = company.equipment[kind];
    const capacityBefore = company.capacity;
    const result = expandCompanyCapacity(world, company, DEMO_CONFIG, [], 2);
    expect(result.ok).toBe(true);
    const bought = company.equipment[kind] - unitsBefore;
    expect(bought).toBeGreaterThanOrEqual(1);
    expect(bought).toBeLessThanOrEqual(2);
    expect(Number.isInteger(company.equipment[kind])).toBe(true);
    const perUnit =
      equipmentCapacityPerUnit(DEMO_CONFIG, kind, company.recipeOutput) *
      city.technology.productivityMultiplier;
    expect(company.capacity - capacityBefore).toBeCloseTo(bought * perUnit, 0);
    expect(company.lastMonth.capacityChange).toBeCloseTo(
      bought * equipmentCapacityPerUnit(DEMO_CONFIG, kind, company.recipeOutput),
      0,
    );
    expect(company.lastMonth.equipmentPurchased).toBeGreaterThan(0);
  });

  it('盈利且持续缺货、设备库存充足时，planning 会真实扩产（按设备台数）', () => {
    const world = newWorld();
    const company = world.companies.find((entry) => entry.id === 'lp-food')!;
    company.cash = 500_000_000;
    company.previousMonth.profit = 20_000_000;
    company.previousMonth.sold = 4_000_000;
    company.salesHistory = [4_000_000, 4_200_000, 3_900_000];
    company.inventory.food = 0;
    company.utilization = 0.9;
    company.productionPlan = null;
    const city = cityOf(world);
    city.market.food.price = 120;
    city.market.food.lastPriceChangePct = 5;
    city.market.food.demand = 5_000_000;
    city.market.food.sold = 1_000_000;
    city.market.food.unmetDemand = 4_000_000;
    world.equipmentMarket.initialStock.industry = 1000;
    const kind = equipmentKindForSector(company.sector, DEMO_CONFIG);
    const unitsBefore = company.equipment[kind];
    planCompanies(world, DEMO_CONFIG, []);
    expect(company.equipment[kind]).toBeGreaterThan(unitsBefore);
    expect(company.lastMonth.capacityChange).toBeGreaterThan(0);
    expect(company.lastMonth.equipmentPurchased).toBeGreaterThan(0);
  });

  it('无需求/亏损时 planning 下调计划岗位（减产裁员）', () => {
    const world = newWorld();
    const company = world.companies.find((entry) => entry.id === 'lp-food')!;
    const before = company.jobDemand;
    planCompanies(world, DEMO_CONFIG, []);
    expect(company.jobDemand).toBeLessThan(before);
    expect(company.jobDemand).toBeLessThanOrEqual(company.employees);
  });
});
