import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation/core/simulation';
import { DEMO_CONFIG, type DemoConfig } from '../src/data/config';
import { GOODS } from '../src/data/demo-data';
import type { GoodId, WorldState } from '../src/simulation/contracts/types';
import {
  FOUNDING_SCALE_UNITS,
  assessFounding,
  foundingAttempts,
  type FoundingAssessment,
} from '../src/simulation/companies/founding';
import {
  foundCompany,
  maybeFoundCompanies,
} from '../src/simulation/companies/lifecycle/lifecycle';
import { equipmentUnitPrice } from '../src/simulation/equipment/equipment';
import { employOperator } from '../src/simulation/management/manager-pool';
import { checkInvariants } from '../src/simulation/core/invariants';

function newWorld(config: DemoConfig = DEMO_CONFIG): WorldState {
  return Simulation.create(config).state;
}

function cityOf(world: WorldState, cityId = 'lanport') {
  return world.cities.find((city) => city.id === cityId)!;
}

function basePriceOf(output: GoodId): number {
  return GOODS.find((good) => good.id === output)!.basePrice;
}

/** 制造“售价上涨 + 有支付能力但未满足需求”的行业缺口（只改市场指标，不动库存口径）。 */
function seedGap(
  world: WorldState,
  cityId = 'lanport',
  output: GoodId = 'food',
  priceFactor = 1.3,
): void {
  const market = cityOf(world, cityId).market[output];
  market.price = Math.round(basePriceOf(output) * priceFactor * 100) / 100;
  market.lastPriceChangePct = priceFactor >= 1 ? 8 : -8;
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

function drainFounders(world: WorldState, cityId = 'lanport'): void {
  const city = cityOf(world, cityId);
  city.treasury = 0;
  for (const group of world.investors) {
    if (group.cityId === cityId) group.cash = 0;
  }
  for (const company of world.companies) {
    if (company.cityId === cityId) company.cash = 0;
  }
}

function totalOwnedCash(world: WorldState): number {
  return (
    world.investors.reduce((sum, group) => sum + group.cash, 0) +
    world.companies.reduce((sum, company) => sum + company.cash, 0) +
    world.cities.reduce((sum, city) => sum + city.treasury, 0)
  );
}

function cloneConfig(overrides: {
  lifecycle?: Record<string, unknown>;
  company?: Record<string, unknown>;
}): DemoConfig {
  return {
    ...DEMO_CONFIG,
    lifecycle: { ...DEMO_CONFIG.lifecycle, ...overrides.lifecycle },
    company: { ...DEMO_CONFIG.company, ...overrides.company },
  } as unknown as DemoConfig;
}

describe('v1.0 创业评估：价格与可支付需求', () => {
  it('售价上涨且未满足需求高时，价格/需求维度与总分都更高', () => {
    const highWorld = newWorld();
    seedGap(highWorld, 'lanport', 'food', 1.3);
    const high: FoundingAssessment = assessFounding(highWorld, DEMO_CONFIG, 'lanport', 'food');

    const lowWorld = newWorld();
    seedGap(lowWorld, 'lanport', 'food', 0.75);
    lowWorld.cities.find((city) => city.id === 'lanport')!.market.food.unmetDemand = 0;
    const low: FoundingAssessment = assessFounding(lowWorld, DEMO_CONFIG, 'lanport', 'food');

    expect(high.metrics.expectedPrice).toBeGreaterThan(low.metrics.expectedPrice);
    expect(high.dimensions.price).toBeGreaterThan(low.dimensions.price);
    expect(high.dimensions.payableDemand).toBeGreaterThan(low.dimensions.payableDemand);
    expect(high.metrics.payableUnmetDemand).toBeGreaterThan(0);
    expect(high.score).toBeGreaterThan(low.score);
    expect(high.reasons.join(' ')).toContain('售价');
    expect(high.reasons.join(' ')).toContain('未满足');
  });
});

describe('v1.0 创业评估：最小可行规模档位', () => {
  it('1/2/4 台档位的设备、员工、首批原料与周转金全部由 config 推导', () => {
    const world = newWorld();
    makeRich(world);
    seedGap(world, 'lanport', 'food');
    const assessment = assessFounding(world, DEMO_CONFIG, 'lanport', 'food');

    expect(assessment.scaleTiers.map((tier) => tier.units)).toEqual([...FOUNDING_SCALE_UNITS]);
    const unitPrice = equipmentUnitPrice(
      world,
      'lanport',
      assessment.equipmentKind,
      DEMO_CONFIG,
    );
    const byUnits = new Map(assessment.scaleTiers.map((tier) => [tier.units, tier]));
    for (const tier of assessment.scaleTiers) {
      expect(tier.equipmentCost).toBeCloseTo(unitPrice * tier.units, 2);
      expect(tier.jobs).toBeGreaterThan(0);
      expect(tier.firstBatchInputCost).toBeGreaterThan(0);
      expect(tier.workingCapital).toBeGreaterThan(0);
    }
    // v1.1：档位按 4→2→1 降档；员工数仍随设备台数成比例（同一行业、同一城市生产率）。
    const first = byUnits.get(1)!;
    const second = byUnits.get(2)!;
    const fourth = byUnits.get(4)!;
    expect(second.jobs).toBeGreaterThanOrEqual(first.jobs * 2 - 1);
    expect(second.jobs).toBeLessThanOrEqual(first.jobs * 2);
    expect(fourth.jobs).toBeGreaterThanOrEqual(first.jobs * 4 - 2);
    expect(fourth.jobs).toBeLessThanOrEqual(first.jobs * 4);
  });

  it('周转金随 config.company.wageReserveMonths 变化，而不是硬编码', () => {
    const world = newWorld();
    makeRich(world);
    seedGap(world, 'lanport', 'food');
    const base = assessFounding(world, DEMO_CONFIG, 'lanport', 'food');
    const generous = assessFounding(
      world,
      cloneConfig({ company: { wageReserveMonths: 4 } }),
      'lanport',
      'food',
    );
    expect(generous.scaleTiers[0]!.workingCapital).toBeGreaterThan(
      base.scaleTiers[0]!.workingCapital,
    );
    expect(generous.scaleTiers[0]!.totalCapital).toBeGreaterThan(
      base.scaleTiers[0]!.totalCapital,
    );
  });
});

describe('v1.0 创办失败：设备/资本/授信障碍', () => {
  it('设备不可得时失败并记录 equipment 障碍，不产生资金/企业/股份副作用', () => {
    const world = newWorld();
    makeRich(world);
    seedGap(world, 'lanport', 'food');
    world.equipmentMarket.initialStock = { farm: 0, industry: 0, energy: 0 };
    for (const company of world.companies) {
      company.inventory.industryEquipment = 0;
      company.inventory.farmEquipment = 0;
      company.inventory.energyEquipment = 0;
    }
    const companiesBefore = world.companies.length;
    const cashBefore = totalOwnedCash(world);
    const log: { message: string }[] = [];
    const result = foundCompany(
      world,
      { cityId: 'lanport', recipeOutput: 'food', log } as never,
      DEMO_CONFIG,
    );
    expect(result.ok).toBe(false);
    expect(result.error ?? '').toContain('设备');
    expect(world.companies.length).toBe(companiesBefore);
    expect(totalOwnedCash(world)).toBeCloseTo(cashBefore, 2);
    expect(world.lifecycle.foundings).toHaveLength(0);
    const attempt = foundingAttempts(world).at(-1)!;
    expect(attempt.outcome).toBe('rejected');
    expect(attempt.obstacles.some((obstacle) => obstacle.kind === 'equipment')).toBe(true);
    expect(attempt.cityId).toBe('lanport');
    expect(attempt.output).toBe('food');
  });

  it('没有可出资人时失败，不凭空发股份或增加货币', () => {
    const world = newWorld();
    seedGap(world, 'lanport', 'food');
    drainFounders(world, 'lanport');
    const companiesBefore = world.companies.length;
    const cashBefore = totalOwnedCash(world);
    const result = foundCompany(
      world,
      { cityId: 'lanport', recipeOutput: 'food', log: [] } as never,
      DEMO_CONFIG,
    );
    expect(result.ok).toBe(false);
    expect(world.companies.length).toBe(companiesBefore);
    expect(totalOwnedCash(world)).toBeCloseTo(cashBefore, 2);
    const attempt = foundingAttempts(world).at(-1)!;
    expect(attempt.outcome).toBe('rejected');
    expect(
      attempt.obstacles.some(
        (obstacle) =>
          obstacle.kind === 'capital' ||
          obstacle.kind === 'credit' ||
          obstacle.kind === 'workingCapital',
      ),
    ).toBe(true);
    expect(attempt.note).toContain('创办被拒绝');
  });

  it('启动资金缺口超过银行授信时记录资金/周转金障碍', () => {
    const world = newWorld();
    seedGap(world, 'lanport', 'food');
    const group = world.investors
      .filter((entry) => entry.cityId === 'lanport')
      .sort((a, b) => b.cash - a.cash)[0]!;
    for (const entry of world.investors) entry.cash = 0;
    group.cash = 8_500_000;
    for (const company of world.companies) company.cash = 0;
    cityOf(world, 'lanport').treasury = 0;

    const result = foundCompany(
      world,
      { cityId: 'lanport', recipeOutput: 'food', log: [] } as never,
      DEMO_CONFIG,
    );
    expect(result.ok).toBe(false);
    const attempt = foundingAttempts(world).at(-1)!;
    expect(attempt.outcome).toBe('rejected');
    expect(
      attempt.obstacles.some(
        (obstacle) => obstacle.kind === 'workingCapital' || obstacle.kind === 'capital',
      ),
    ).toBe(true);
    expect(group.cash).toBe(8_500_000);
    expect(world.companies.every((company) => company.id !== result.companyId)).toBe(true);
  });
});

describe('v1.0 创办成功：真实设备、出资、贷款与守恒', () => {
  it('富余出资人时真实购买设备、发股份、写 attempt 与日志', () => {
    const world = newWorld();
    makeRich(world);
    seedGap(world, 'lanport', 'food');
    const cashBefore = totalOwnedCash(world);
    const log: { message: string }[] = [];
    const result = foundCompany(
      world,
      { cityId: 'lanport', recipeOutput: 'food', log } as never,
      DEMO_CONFIG,
    );
    expect(result.ok).toBe(true);
    expect(result.companyId).toBeTruthy();
    const company = world.companies.find((entry) => entry.id === result.companyId)!;
    expect(company.equipmentCapacity).toBeGreaterThan(0);
    expect(company.capacity).toBeCloseTo(company.equipmentCapacity, 2);
    expect(company.jobDemand).toBeGreaterThan(0);
    expect(company.equipment.industry + company.equipment.farm + company.equipment.energy).toBeGreaterThan(0);
    expect(company.totalShares).toBe(1_000_000);
    expect(company.debt).toBe(0);
    expect(totalOwnedCash(world)).toBeCloseTo(cashBefore, 2);

    const attempt = foundingAttempts(world).at(-1)!;
    expect(attempt.outcome).toBe('founded');
    expect(attempt.companyId).toBe(company.id);
    // v1.1：资金充足时按 4→2→1 优先选择最大可行档（4 台），降档逻辑见 founding-v11.test.ts。
    expect(attempt.tierUnits).toBe(4);
    expect(attempt.loan).toBe(0);
    expect(world.lifecycle.foundings).toHaveLength(1);
    const record = world.lifecycle.foundings[0]!;
    expect(record.note).toContain('行业评分');
    expect(record.note).toContain('设备');
    expect(log.some((entry) => entry.message.includes('设备'))).toBe(true);
    expect(log.some((entry) => entry.message.includes('评分'))).toBe(true);
    expect(checkInvariants(world)).toEqual([]);
  });

  it('成立新企业后的股份与货币仍守恒，checkInvariants 通过', () => {
    const world = newWorld();
    makeRich(world);
    seedGap(world, 'lanport', 'food');
    const result = foundCompany(
      world,
      { cityId: 'lanport', recipeOutput: 'food', log: [] } as never,
      DEMO_CONFIG,
    );
    expect(result.ok).toBe(true);
    const record = world.lifecycle.foundings.at(-1)!;
    const capital = record.capital;
    const paid = record.investors.reduce((sum, investor) => sum + investor.cash, 0);
    expect(paid).toBeCloseTo(capital, 2);
    const holdersBefore = world.securities.holdings.filter(
      (holding) => holding.companyId !== result.companyId,
    );
    expect(checkInvariants(world)).toEqual([]);
    const newHoldings = world.securities.holdings.filter(
      (holding) => holding.companyId === result.companyId,
    );
    expect(newHoldings.reduce((sum, holding) => sum + holding.shares, 0)).toBeCloseTo(1_000_000, 0);
    expect(newHoldings.some((holding) => holding.holder.type === 'investorGroup')).toBe(true);
    // 新增股份只来自这次 primary 发行；既有企业的持股记录不受影响（数量一致）。
    expect(
      world.securities.holdings.filter((holding) => holding.companyId !== result.companyId),
    ).toHaveLength(holdersBefore.length);
  });

  it('贷款额不超过银行授信，且 company.debt 与 attempt.loan 一致', () => {
    const world = newWorld();
    seedGap(world, 'lanport', 'food');
    const groups = world.investors
      .filter((entry) => entry.cityId === 'lanport')
      .sort((a, b) => b.cash - a.cash);
    for (const group of groups) group.cash = 0;
    // 出资能力介于“最低资本”与“完整启动成本”之间 → 需要贷款才能达到 1 台最小可行档。
    groups[0]!.cash = 18_000_000;
    for (const company of world.companies) company.cash = 0;
    cityOf(world, 'lanport').treasury = 0;

    const result = foundCompany(
      world,
      { cityId: 'lanport', recipeOutput: 'food', log: [] } as never,
      DEMO_CONFIG,
    );
    expect(result.ok).toBe(true);
    const company = world.companies.find((entry) => entry.id === result.companyId)!;
    const attempt = foundingAttempts(world).at(-1)!;
    expect(attempt.loan).toBeGreaterThan(0);
    expect(company.debt).toBeCloseTo(attempt.loan, 2);
    const creditLimit = (18_000_000 + 300_000) * DEMO_CONFIG.banking.creditLimitRate;
    expect(attempt.loan).toBeLessThanOrEqual(creditLimit + 0.01);
  });
});

describe('v1.0 创办数量与经营权限约束', () => {
  it('每城每月最多 4 家（v1.1），重复调用同 tick 不再增设；初始 65 家不变', () => {
    const world = newWorld();
    expect(world.companies).toHaveLength(65);
    expect(world.lifecycle.foundings).toHaveLength(0);
    makeRich(world);
    for (const city of world.cities) for (const output of ['food', 'clothing', 'household'] as GoodId[]) {
      seedGap(world, city.id, output);
    }
    const first = maybeFoundCompanies(world, DEMO_CONFIG, []);
    expect(first.length).toBe(12);
    for (const city of world.cities) {
      const count = world.lifecycle.foundings.filter(
        (record) => record.cityId === city.id && record.tick === world.time.tick,
      ).length;
      expect(count).toBeLessThanOrEqual(4);
    }
    const second = maybeFoundCompanies(world, DEMO_CONFIG, []);
    expect(second).toHaveLength(0);
  });

  it('企业数达到 160 上限（或配置上限）时不再创办', () => {
    const world = newWorld();
    const capped = cloneConfig({ lifecycle: { maxCompaniesPerCity: 0 } });
    makeRich(world);
    for (const city of world.cities) seedGap(world, city.id, 'food');
    const created = maybeFoundCompanies(world, capped, []);
    expect(created).toHaveLength(0);
    expect(world.lifecycle.foundings).toHaveLength(0);
  });

  it('同一非玩家经营者不会同时经营两家企业（玩家除外）', () => {
    const world = newWorld();
    const operator = world.management.operators.find((entry) => entry.status === 'available')!;
    const [firstCompany, secondCompany] = world.companies.filter(
      (company) => company.cityId === 'lanport',
    );
    employOperator(world, operator.id, firstCompany!.id, 0, 24, '测试任职');
    employOperator(world, operator.id, secondCompany!.id, 1, 25, '测试任职');
    const controls = world.governance.controls;
    const firstControl = controls.find((control) => control.companyId === firstCompany!.id)!;
    const secondControl = controls.find((control) => control.companyId === secondCompany!.id)!;
    expect(firstControl.operatorId).not.toBe(operator.id);
    expect(secondControl.operatorId).toBe(operator.id);
    expect(operator.companyId).toBe(secondCompany!.id);
    expect(operator.status).toBe('employed');
  });
});
