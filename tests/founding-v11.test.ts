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

/**
 * v1.3：给每城设备厂补足本地库存。
 * 开局政府设备储备是世界级共享池、跨城设备也会被先评估的城市先买走，若只用开局库存，
 * 富裕测试世界里字母序靠前的城市会吃光全部设备。该用例只验证“每城每月上限 100”本身，
 * 因此显式给每城本地设备供给（每城设备厂各补 400 台），隔离共享储备/城市顺序/劳动力耗尽因素；
 * 该用例只验证“每城每月上限”，资源不足时其他用例另有覆盖（公平性问题见 v1.3 报告）。
 */
function seedLocalEquipmentStock(world: WorldState): void {
  for (const company of world.companies) {
    if (company.recipeOutput === 'farmEquipment' || company.recipeOutput === 'industryEquipment' || company.recipeOutput === 'energyEquipment') {
      company.inventory[company.recipeOutput] = (company.inventory[company.recipeOutput] ?? 0) + 400;
    }
  }
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
    // 2M 出资 + 授信同样不够 1 台最小可行档（约 24M）：零副作用失败。
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

describe('v1.2 每城每月 100 家与 160 上限', () => {
  it('每城每月最多 100 家，同月重复调用不再超发', () => {
    const world = newWorld();
    makeRich(world);
    seedLocalEquipmentStock(world);
    for (const city of world.cities) {
      seedGap(world, city.id, 'food');
      seedGap(world, city.id, 'clothing');
      seedGap(world, city.id, 'household');
    }
    const created = maybeFoundCompanies(world, DEMO_CONFIG, []);
    expect(DEMO_CONFIG.lifecycle.maxFoundingsPerCityMonth).toBe(100);
    // 100 是上限不是目标：实际数量还受设备库存/资金/劳动力约束，但必须 > 0 且每城不超 100。
    expect(created.length).toBeGreaterThan(0);
    for (const city of world.cities) {
      const count = world.lifecycle.foundingMonth?.counts[city.id] ?? 0;
      expect(count).toBeGreaterThan(0);
      expect(count).toBeLessThanOrEqual(100);
    }
    const second = maybeFoundCompanies(world, DEMO_CONFIG, []);
    // v1.3：100 是“每城每月上限”，重复调用可以继续创办，但合计不得超发；
    // 剩余机会/设备/劳动力不足时第二次调用自然为 0。
    for (const city of world.cities) {
      const count = world.lifecycle.foundingMonth?.counts[city.id] ?? 0;
      expect(count).toBeLessThanOrEqual(100);
      expect(count).toBeGreaterThanOrEqual(1);
    }
    expect(second.length).toBeLessThanOrEqual(300);
    expect(world.companies.length).toBeLessThanOrEqual(65 + 300);
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

describe('v1.2 成立后首月资金可持续（不被在营企业抽干）', () => {
  it('自动创办不再用在营企业出资；新企业首月不欠薪、保留周转现金', () => {
    const sim = Simulation.create(DEMO_CONFIG);
    const world = sim.state;
    makeRich(world);
    for (const city of world.cities) seedGap(world, city.id, 'food');
    const existing = [...world.companies];
    const cashBefore = new Map(existing.map((company) => [company.id, company.cash]));
    const created = maybeFoundCompanies(world, DEMO_CONFIG, []);
    expect(created.length).toBeGreaterThan(0);
    // 1) 在营企业的现金不能被本轮创办抽走（旧缺陷：把在营企业当出资人，整笔现金转给新企业）。
    for (const company of existing) {
      // 设备厂卖出设备会增加现金，但任何在营企业都不应因“被当作出资人”而减少现金。
      expect(company.cash, company.id).toBeGreaterThanOrEqual(cashBefore.get(company.id)! - 0.01);
    }
    // 2) 新企业真实买到设备，且成立时保留周转金。
    const newCompanies = created.map((id) => world.companies.find((company) => company.id === id)!);
    for (const company of newCompanies) {
      expect(company.equipmentCapacity, company.id).toBeGreaterThan(0);
      expect(company.cash, company.id).toBeGreaterThan(0);
    }
    // 3) 完整跑一个月：新办企业不得出现工资欠薪，也不得首月工资支付超过其现金。
    sim.tick();
    for (const company of newCompanies) {
      expect(company.lastMonth.wageArrears, company.id).toBe(0);
      expect(company.cash, company.id).toBeGreaterThan(0);
    }
  });
});
