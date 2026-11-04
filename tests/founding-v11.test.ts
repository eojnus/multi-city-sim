import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation/core/simulation';
import { DEMO_CONFIG } from '../src/data/config';
import { GOODS } from '../src/data/demo-data';
import type { GoodId, WorldState } from '../src/simulation/contracts/types';
import {
  FOUNDING_MIN_MATERIAL_RESERVE_MONTHS,
  FOUNDING_MIN_WAGE_RESERVE_MONTHS,
  FOUNDING_SCALE_UNITS,
  assessFounding,
  foundingAttempts,
} from '../src/simulation/companies/founding';
import {
  foundCompany,
  maybeFoundCompanies,
} from '../src/simulation/companies/lifecycle/lifecycle';
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

/** 制造“售价合理上涨 + 有支付能力但未满足需求”的食品缺口（不动 producerRequired）。 */
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

/** 只给 lanport 一个投资群体留现金，其余出资人清空，用于构造降档/失败场景。 */
function soloFounder(world: WorldState, cash: number): void {
  for (const group of world.investors) group.cash = 0;
  const group = world.investors
    .filter((entry) => entry.cityId === 'lanport')
    .sort((a, b) => b.cash - a.cash)[0]!;
  group.cash = cash;
  for (const company of world.companies) company.cash = 0;
  cityOf(world, 'lanport').treasury = 0;
}

function totalOwnedCash(world: WorldState): number {
  return (
    world.investors.reduce((sum, group) => sum + group.cash, 0) +
    world.companies.reduce((sum, company) => sum + company.cash, 0) +
    world.cities.reduce((sum, city) => sum + city.treasury, 0)
  );
}

/** 未偿贷款是外部银行负债：用“货币资产 − 未偿贷款”衡量创办前后的净财富守恒。 */
function outstandingLoans(world: WorldState): number {
  return world.banking.loans.reduce((sum, loan) => sum + loan.outstanding, 0);
}

describe('v1.1 有效需求信号与食品创业机会', () => {
  it('食品长期缺货且价格合理时，存在可行档且评分理由包含售价/未满足需求', () => {
    const world = newWorld();
    makeRich(world);
    seedGap(world, 'lanport', 'food');
    const assessment = assessFounding(world, DEMO_CONFIG, 'lanport', 'food');

    expect(assessment.metrics.payableUnmetDemand).toBe(28_000);
    expect(assessment.metrics.unmetFunding).toBe(0);
    expect(assessment.feasibleTier).not.toBeNull();
    expect(assessment.feasibleTier!.units).toBe(FOUNDING_SCALE_UNITS[0]);
    expect(assessment.reasons.join(' ')).toContain('售价');
    expect(assessment.reasons.join(' ')).toContain('未满足');
  });

  it('食品机会变现：真实购买设备、成立企业并记录 founded attempt', () => {
    const world = newWorld();
    makeRich(world);
    seedGap(world, 'lanport', 'food');
    const result = foundCompany(
      world,
      { cityId: 'lanport', recipeOutput: 'food', log: [] } as never,
      DEMO_CONFIG,
    );
    expect(result.ok, result.error).toBe(true);
    const company = world.companies.find((entry) => entry.id === result.companyId)!;
    expect(company.recipeOutput).toBe('food');
    expect(company.equipment.industry).toBe(FOUNDING_SCALE_UNITS[0]);
    const attempt = foundingAttempts(world).at(-1)!;
    expect(attempt.outcome).toBe('founded');
    expect(attempt.output).toBe('food');
  });
});

describe('v1.1 规模降档 4→2→1', () => {
  it('4 台档资金不足时按 4→2→1 降到 1 台并成功', () => {
    const world = newWorld();
    seedGap(world, 'lanport', 'food');
    // 20M 出资 + 授信约 10.15M：不够 4 台（约 97M）与 2 台（约 49M），但够 1 台（约 24M）。
    soloFounder(world, 20_000_000);
    const assessment = assessFounding(world, DEMO_CONFIG, 'lanport', 'food');
    const tier4 = assessment.scaleTiers.find((tier) => tier.units === 4)!;
    const tier2 = assessment.scaleTiers.find((tier) => tier.units === 2)!;
    expect(tier4.feasible).toBe(false);
    expect(tier2.feasible).toBe(false);
    expect(assessment.feasibleTier?.units).toBe(1);

    const cashBefore = totalOwnedCash(world);
    const result = foundCompany(
      world,
      { cityId: 'lanport', recipeOutput: 'food', log: [] } as never,
      DEMO_CONFIG,
    );
    expect(result.ok, result.error).toBe(true);
    const company = world.companies.find((entry) => entry.id === result.companyId)!;
    expect(company.equipment.industry).toBe(1);
    const attempt = foundingAttempts(world).at(-1)!;
    expect(attempt.tierUnits).toBe(1);
    expect(attempt.obstacles).toEqual([]);
    expect(totalOwnedCash(world) - outstandingLoans(world)).toBeCloseTo(cashBefore, 2);
    expect(checkInvariants(world)).toEqual([]);
  });

  it('最小 1 台档也买不起资金时失败，零副作用并记录周转金/资本障碍', () => {
    const world = newWorld();
    seedGap(world, 'lanport', 'food');
    soloFounder(world, 2_000_000);
    const companiesBefore = world.companies.length;
    const cashBefore = totalOwnedCash(world);
    const loansBefore = world.banking.loans.length;
    const groupCashBefore = world.investors
      .filter((entry) => entry.cityId === 'lanport')
      .reduce((sum, group) => sum + group.cash, 0);

    const result = foundCompany(
      world,
      { cityId: 'lanport', recipeOutput: 'food', log: [] } as never,
      DEMO_CONFIG,
    );
    expect(result.ok).toBe(false);
    expect(world.companies).toHaveLength(companiesBefore);
    expect(totalOwnedCash(world) - outstandingLoans(world)).toBeCloseTo(cashBefore, 2);
    expect(world.banking.loans).toHaveLength(loansBefore);
    expect(world.lifecycle.foundings).toHaveLength(0);
    expect(
      world.investors
        .filter((entry) => entry.cityId === 'lanport')
        .reduce((sum, group) => sum + group.cash, 0),
    ).toBeCloseTo(groupCashBefore, 2);
    const attempt = foundingAttempts(world).at(-1)!;
    expect(attempt.outcome).toBe('rejected');
    expect(
      attempt.obstacles.some(
        (obstacle) => obstacle.kind === 'workingCapital' || obstacle.kind === 'capital',
      ),
    ).toBe(true);
  });
});

describe('v1.1 周转金：2 个月工资 + 1 个月计划原料', () => {
  it('每档周转金按 2 个月基础工资 + 1 个月计划原料采购额动态计算', () => {
    const world = newWorld();
    makeRich(world);
    seedGap(world, 'lanport', 'food');
    const assessment = assessFounding(world, DEMO_CONFIG, 'lanport', 'food');
    for (const tier of assessment.scaleTiers) {
      const monthlyWage = tier.jobs * DEMO_CONFIG.labor.privateWageRate;
      const wageReserve = monthlyWage * FOUNDING_MIN_WAGE_RESERVE_MONTHS;
      const materialReserve = tier.firstBatchInputCost * FOUNDING_MIN_MATERIAL_RESERVE_MONTHS;
      expect(tier.workingCapital).toBeGreaterThanOrEqual(wageReserve - 0.01);
      expect(tier.workingCapital).toBeGreaterThanOrEqual(wageReserve + materialReserve - 0.01);
    }
  });

  it('成功创办后企业现金不低于该档周转金下限', () => {
    const world = newWorld();
    makeRich(world);
    seedGap(world, 'lanport', 'food');
    const planned = assessFounding(world, DEMO_CONFIG, 'lanport', 'food').feasibleTier!;
    const result = foundCompany(
      world,
      { cityId: 'lanport', recipeOutput: 'food', log: [] } as never,
      DEMO_CONFIG,
    );
    expect(result.ok, result.error).toBe(true);
    const company = world.companies.find((entry) => entry.id === result.companyId)!;
    expect(company.cash + 0.01).toBeGreaterThanOrEqual(planned.workingCapital);
    expect(company.cash).toBeGreaterThan(0);
  });
});

describe('v1.1 创办失败回滚与守恒', () => {
  it('设备不可得时不创办、不产生贷款/扣款/设备/股份副作用', () => {
    const world = newWorld();
    makeRich(world);
    seedGap(world, 'lanport', 'food');
    world.equipmentMarket.initialStock = { farm: 0, industry: 0, energy: 0 };
    for (const company of world.companies) {
      company.inventory.farmEquipment = 0;
      company.inventory.industryEquipment = 0;
      company.inventory.energyEquipment = 0;
    }
    const companiesBefore = world.companies.length;
    const cashBefore = totalOwnedCash(world);
    const loansBefore = world.banking.loans.length;
    const holdingsBefore = world.securities.holdings.length;

    const result = foundCompany(
      world,
      { cityId: 'lanport', recipeOutput: 'food', log: [] } as never,
      DEMO_CONFIG,
    );
    expect(result.ok).toBe(false);
    expect(result.error ?? '').toContain('设备');
    expect(world.companies).toHaveLength(companiesBefore);
    expect(totalOwnedCash(world) - outstandingLoans(world)).toBeCloseTo(cashBefore, 2);
    expect(world.banking.loans).toHaveLength(loansBefore);
    expect(world.securities.holdings).toHaveLength(holdingsBefore);
    expect(world.lifecycle.foundings).toHaveLength(0);
    const attempt = foundingAttempts(world).at(-1)!;
    expect(attempt.outcome).toBe('rejected');
    expect(attempt.obstacles.some((obstacle) => obstacle.kind === 'equipment')).toBe(true);
    expect(attempt.companyId).toBeUndefined();
  });
});

describe('v1.1 每城每月 4 家与 160 上限', () => {
  it('每城每月最多 4 家，同月重复调用不再超发', () => {
    const world = newWorld();
    makeRich(world);
    for (const city of world.cities) {
      seedGap(world, city.id, 'food');
      seedGap(world, city.id, 'clothing');
      seedGap(world, city.id, 'household');
    }
    const created = maybeFoundCompanies(world, DEMO_CONFIG, []);
    expect(DEMO_CONFIG.lifecycle.maxFoundingsPerCityMonth).toBe(4);
    expect(created).toHaveLength(12);
    for (const city of world.cities) {
      const count = world.lifecycle.foundings.filter(
        (record) => record.cityId === city.id && record.tick === world.time.tick,
      ).length;
      expect(count).toBe(4);
    }
    const second = maybeFoundCompanies(world, DEMO_CONFIG, []);
    expect(second).toHaveLength(0);
  });

  it('资金/资产/股份守恒，checkInvariants 通过', () => {
    const world = newWorld();
    makeRich(world);
    seedGap(world, 'lanport', 'food');
    const cashBefore = totalOwnedCash(world);
    const companiesBefore = world.companies.length;
    const result = foundCompany(
      world,
      { cityId: 'lanport', recipeOutput: 'food', log: [] } as never,
      DEMO_CONFIG,
    );
    expect(result.ok, result.error).toBe(true);
    expect(world.companies).toHaveLength(companiesBefore + 1);
    expect(totalOwnedCash(world) - outstandingLoans(world)).toBeCloseTo(cashBefore, 2);
    const record = world.lifecycle.foundings.at(-1)!;
    expect(record.investors.reduce((sum, investor) => sum + investor.cash, 0)).toBeCloseTo(
      record.capital,
      2,
    );
    const holdings = world.securities.holdings.filter(
      (holding) => holding.companyId === result.companyId,
    );
    expect(holdings.reduce((sum, holding) => sum + holding.shares, 0)).toBeCloseTo(1_000_000, 0);
    expect(checkInvariants(world)).toEqual([]);
  });
});
