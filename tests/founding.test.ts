import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation/core/simulation';
import { DEMO_CONFIG } from '../src/data/config';
import { COMPANY_SEEDS, GOODS, OPENING_COMPANIES } from '../src/data/demo-data';
import type { EquipmentKind, GoodId, LogEntry, WorldState } from '../src/simulation/contracts/types';
import {
  FOUNDING_MIN_SCORE,
  foundingCandidateForOutput,
  pickFoundingCandidate,
  plannedEquipmentUnits,
  scoreFoundingCandidates,
} from '../src/simulation/companies/founding';
import {
  foundCompany,
  liquidateCompany,
  maybeFoundCompanies,
} from '../src/simulation/companies/lifecycle/lifecycle';
import { checkInvariants } from '../src/simulation/core/invariants';

const KINDS: EquipmentKind[] = ['farm', 'industry', 'energy'];

function richWorld(): WorldState {
  const world = Simulation.create().state;
  for (const city of world.cities) city.treasury = 50_000_000;
  for (const group of world.investors) group.cash = 100_000_000;
  for (const company of world.companies) company.cash = 50_000_000;
  return world;
}

function cityOf(world: WorldState, cityId: string) {
  return world.cities.find((city) => city.id === cityId)!;
}

function basePriceOf(output: GoodId): number {
  return GOODS.find((good) => good.id === output)!.basePrice;
}

function totalOwnedCash(world: WorldState): number {
  return (
    world.investors.reduce((sum, group) => sum + group.cash, 0) +
    world.companies.reduce((sum, company) => sum + company.cash, 0) +
    world.cities.reduce((sum, city) => sum + city.treasury, 0) +
    world.player.cash
  );
}

function equipmentUnits(company: { equipment: Record<EquipmentKind, number> }): number {
  return KINDS.reduce((sum, kind) => sum + company.equipment[kind], 0);
}

describe('创业行业评分', () => {
  it('售价高于基准且趋势向上时，售价分项与总分都更高', () => {
    const world = Simulation.create().state;
    const city = cityOf(world, 'lanport');
    const food = city.market.food;
    const base = basePriceOf('food');

    food.price = base * 1.3;
    food.lastPriceChangePct = 5;
    const high = foundingCandidateForOutput(world, DEMO_CONFIG, city.id, 'food');

    food.price = base * 0.8;
    food.lastPriceChangePct = -5;
    const low = foundingCandidateForOutput(world, DEMO_CONFIG, city.id, 'food');

    expect(high.breakdown.price).toBeGreaterThan(low.breakdown.price);
    expect(high.score).toBeGreaterThan(low.score);
    // 评分理由要能直接展示“售价 / 趋势”的依据。
    expect(high.reasons.some((reason) => reason.includes('售价') && reason.includes('趋势'))).toBe(true);
  });

  it('未满足需求占比越高，需求分项与总分越高（不直接用需求数量比利润）', () => {
    const world = Simulation.create().state;
    const city = cityOf(world, 'lanport');
    const food = city.market.food;

    food.demand = 90_000;
    food.sold = 40_000;
    food.unmetDemand = 50_000;
    const gap = foundingCandidateForOutput(world, DEMO_CONFIG, city.id, 'food');

    food.demand = 90_000;
    food.sold = 90_000;
    food.unmetDemand = 0;
    const balanced = foundingCandidateForOutput(world, DEMO_CONFIG, city.id, 'food');

    expect(gap.breakdown.demand).toBeGreaterThan(balanced.breakdown.demand);
    expect(gap.score).toBeGreaterThan(balanced.score);
  });

  it('所有候选按得分降序输出，并包含设备可获得性与启动资本估算', () => {
    const world = richWorld();
    const city = cityOf(world, 'lanport');
    const candidates = scoreFoundingCandidates(world, DEMO_CONFIG, city.id);
    expect(candidates).toHaveLength(GOODS.length);
    for (let index = 1; index < candidates.length; index++) {
      expect(candidates[index - 1]!.score).toBeGreaterThanOrEqual(candidates[index]!.score);
    }
    for (const candidate of candidates) {
      expect(candidate.suggestedCapital).toBeGreaterThan(0);
      expect(candidate.unitCapacity).toBeGreaterThan(0);
      expect(candidate.reasons.length).toBeGreaterThan(0);
    }
  });

  it('t=0 没有订单时不自动创办企业（不凭空制造小企业）', () => {
    const world = richWorld();
    const before = world.companies.length;
    expect(pickFoundingCandidate(world, DEMO_CONFIG, 'lanport')).toBeNull();
    const created = maybeFoundCompanies(world, DEMO_CONFIG, []);
    expect(created).toHaveLength(0);
    expect(world.companies).toHaveLength(before);
  });
});

describe('设备化创办', () => {
  it('设备不可得时创办失败，且不改变任何资产', () => {
    const world = richWorld();
    const city = cityOf(world, 'lanport');
    for (const kind of KINDS) world.equipmentMarket.initialStock[kind] = 0;
    // v1.0 开局新增 16 家/城企业，其中包含设备生产商；这里同时清空企业设备库存，
    // 才能构造“同城、政府、跨城都没有设备可买”的原始场景。
    for (const company of world.companies) {
      for (const kind of KINDS) {
        company.inventory[DEMO_CONFIG.equipment.catalog[kind].goodId] = 0;
      }
    }
    const groupsBefore = world.investors.reduce((sum, group) => sum + group.cash, 0);
    const companiesBefore = world.companies.length;
    const cashBefore = totalOwnedCash(world);

    const result = foundCompany(
      world,
      { cityId: city.id, founderType: 'investorGroup', capital: 600_000, recipeOutput: 'food' },
      DEMO_CONFIG,
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain('设备');
    expect(world.companies).toHaveLength(companiesBefore);
    expect(world.investors.reduce((sum, group) => sum + group.cash, 0)).toBeCloseTo(groupsBefore, 2);
    expect(totalOwnedCash(world)).toBeCloseTo(cashBefore, 2);
  });

  it('资金不足时按可负担台数缩小规模，产能由设备决定', () => {
    const world = richWorld();
    const city = cityOf(world, 'lanport');
    // 未满足需求很大 → 需要多台设备；但 45 万资本只买得起 2 台。
    city.market.food.demand = 2_000_000;
    city.market.food.sold = 0;
    city.market.food.unmetDemand = 2_000_000;
    const priceBefore = city.market.industryEquipment.price;

    const result = foundCompany(
      world,
      { cityId: city.id, founderType: 'investorGroup', capital: 450_000, recipeOutput: 'food' },
      DEMO_CONFIG,
    );

    expect(result.ok, result.error).toBe(true);
    const company = world.companies.find((entry) => entry.id === result.companyId)!;
    expect(company.equipment.industry).toBe(2);
    expect(company.equipmentCapacity).toBeCloseTo(company.capacity, 2);
    expect(company.capacity).toBeGreaterThan(0);
    expect(company.jobDemand).toBeGreaterThan(0);
    const equipmentPurchased = company.lastMonth.equipmentPurchased ?? 0;
    expect(equipmentPurchased).toBeGreaterThan(0);
    expect(company.cash).toBeCloseTo(450_000 - equipmentPurchased, 2);
    expect(city.market.industryEquipment.price).toBeCloseTo(priceBefore, 2);
  });

  it('资本买不起任何设备时创办失败且不扣出资人资金', () => {
    const world = richWorld();
    const city = cityOf(world, 'lanport');
    // 设备市场价格高于资本，计划台数为 0。
    city.market.industryEquipment.price = 400_000;
    const groupsBefore = world.investors.reduce((sum, group) => sum + group.cash, 0);
    const companiesBefore = world.companies.length;

    const result = foundCompany(
      world,
      { cityId: city.id, founderType: 'investorGroup', capital: 250_000, recipeOutput: 'food' },
      DEMO_CONFIG,
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain('设备');
    expect(world.companies).toHaveLength(companiesBefore);
    expect(world.investors.reduce((sum, group) => sum + group.cash, 0)).toBeCloseTo(groupsBefore, 2);
  });

  it('创办资金、设备资产与股份守恒，日志包含评分理由', () => {
    const world = richWorld();
    const city = cityOf(world, 'lanport');
    const cashBefore = totalOwnedCash(world);
    const stockBefore = { ...world.equipmentMarket.initialStock };
    const log: LogEntry[] = [];

    const result = foundCompany(
      world,
      {
        cityId: city.id,
        founderType: 'investorGroup',
        capital: 600_000,
        recipeOutput: 'household',
        log,
      },
      DEMO_CONFIG,
    );

    expect(result.ok, result.error).toBe(true);
    const company = world.companies.find((entry) => entry.id === result.companyId)!;
    const record = world.lifecycle.foundings.at(-1)!;
    expect(company.cash + (company.lastMonth.equipmentPurchased ?? 0)).toBeCloseTo(600_000, 2);
    expect(equipmentUnits(company)).toBeGreaterThan(0);
    expect(company.capacity).toBeCloseTo(company.equipmentCapacity, 2);
    expect(record.capital).toBe(600_000);
    expect(record.investors.reduce((sum, investor) => sum + investor.cash, 0)).toBeCloseTo(600_000, 2);
    const shares = world.securities.holdings
      .filter((holding) => holding.companyId === company.id)
      .reduce((sum, holding) => sum + holding.shares, 0);
    expect(shares).toBeCloseTo(1_000_000, 2);
    // 货币守恒：出资人 → 企业，企业 → 设备卖方 / 政府库存，总量不变。
    expect(totalOwnedCash(world)).toBeCloseTo(cashBefore, 2);
    expect(world.equipmentMarket.initialStock.farm).toBeLessThanOrEqual(stockBefore.farm);
    expect(world.equipmentMarket.initialStock.industry).toBeLessThanOrEqual(stockBefore.industry);
    expect(record.note).toContain('行业评分');
    expect(log.some((entry) => entry.message.includes('设备') && entry.message.includes('评分'))).toBe(true);
    expect(checkInvariants(world)).toEqual([]);
  });
});

describe('每月创办数量与城市上限', () => {
  function demandRichWorld() {
    const world = richWorld();
    for (const city of world.cities) {
      for (const good of GOODS) {
        const market = city.market[good.id];
        market.price = good.basePrice * 1.4;
        market.demand = 600_000;
        market.sold = 100_000;
        market.unmetDemand = 500_000;
        market.supply = 100_000;
        market.closingStock = 100_000;
      }
    }
    return world;
  }

  it('每城每月最多 4 家（v1.1），同月重复调用不会超发', () => {
    const world = demandRichWorld();
    const created = maybeFoundCompanies(world, DEMO_CONFIG, []);
    const lanportCreated = world.lifecycle.foundings.filter(
      (record) => record.cityId === 'lanport' && record.tick === world.time.tick,
    );
    expect(DEMO_CONFIG.lifecycle.maxFoundingsPerCityMonth).toBe(4);
    expect(lanportCreated.length).toBeLessThanOrEqual(4);
    expect(lanportCreated.length).toBeGreaterThan(0);
    expect(new Set(created).size).toBe(created.length);

    const secondCall = maybeFoundCompanies(world, DEMO_CONFIG, []);
    expect(secondCall).toHaveLength(0);
    expect(
      world.lifecycle.foundings.filter(
        (record) => record.cityId === 'lanport' && record.tick === world.time.tick,
      ),
    ).toHaveLength(lanportCreated.length);
  });

  it('下个月可以继续创办（不受旧冷却参数影响）', () => {
    const world = demandRichWorld();
    maybeFoundCompanies(world, DEMO_CONFIG, []);
    const firstMonthCount = world.lifecycle.foundings.length;
    world.time.tick += 1;
    const looseConfig = {
      ...DEMO_CONFIG,
      lifecycle: { ...DEMO_CONFIG.lifecycle, maxCompaniesPerInvestorGroup: 99 },
    } as unknown as typeof DEMO_CONFIG;
    maybeFoundCompanies(world, looseConfig, []);
    expect(world.lifecycle.foundings.length).toBeGreaterThan(firstMonthCount);
  });

  it('城市企业数达到上限时不再创办，倒闭释放名额后可再创办', () => {
    const world = richWorld();
    const city = cityOf(world, 'lanport');
    const count = world.companies.filter((company) => company.cityId === city.id).length;
    const cappedConfig = {
      ...DEMO_CONFIG,
      lifecycle: { ...DEMO_CONFIG.lifecycle, maxCompaniesPerCity: count },
    } as unknown as typeof DEMO_CONFIG;

    const blocked = foundCompany(
      world,
      { cityId: city.id, founderType: 'investorGroup', capital: 600_000, recipeOutput: 'household' },
      cappedConfig,
    );
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toContain('上限');
    expect(world.companies).toHaveLength(COMPANY_SEEDS.length + OPENING_COMPANIES.length);

    // 让一家企业真实倒闭，释放名额后再创办。
    const victim = world.companies.find((company) => company.cityId === city.id)!;
    victim.cash = 10_000;
    const liquidation = liquidateCompany(world, victim.id, DEMO_CONFIG, '测试释放名额', []);
    expect(liquidation.ok, liquidation.error).toBe(true);

    const retried = foundCompany(
      world,
      { cityId: city.id, founderType: 'investorGroup', capital: 600_000, recipeOutput: 'household' },
      cappedConfig,
    );
    expect(retried.ok, retried.error).toBe(true);
  });

  it('初始 65 家开局企业保持不变（17 家种子 + 48 家新增），开局没有创办记录', () => {
    const world = Simulation.create().state;
    expect(world.companies).toHaveLength(COMPANY_SEEDS.length + OPENING_COMPANIES.length);
    expect(world.companies.length).toBe(65);
    expect(world.lifecycle.foundings).toHaveLength(0);
    expect(
      world.companies.map((company) => company.id).sort(),
    ).toEqual([...COMPANY_SEEDS, ...OPENING_COMPANIES].map((seed) => seed.id).sort());
  });
});

describe('设备计划裁剪', () => {
  it('plannedEquipmentUnits 同时受资金、设备库存与每月上限约束', () => {
    const world = richWorld();
    const city = cityOf(world, 'lanport');
    const candidate = foundingCandidateForOutput(world, DEMO_CONFIG, city.id, 'food');
    const limited = {
      ...DEMO_CONFIG,
      equipment: { ...DEMO_CONFIG.equipment, maxBuyUnitsPerMonth: 1 },
    } as unknown as typeof DEMO_CONFIG;
    expect(plannedEquipmentUnits(candidate, 100_000_000, limited)).toBe(1);
    expect(plannedEquipmentUnits(candidate, 0, DEMO_CONFIG)).toBe(0);
  });

  it('评分阈值用于 AI 选行业：低于阈值的候选不会被自动采纳', () => {
    const world = richWorld();
    const candidates = scoreFoundingCandidates(world, DEMO_CONFIG, 'lanport');
    const eligible = candidates.filter((candidate) => candidate.breakdown.total >= FOUNDING_MIN_SCORE);
    const picked = pickFoundingCandidate(world, DEMO_CONFIG, 'lanport');
    if (picked) {
      expect(picked.breakdown.total).toBeGreaterThanOrEqual(FOUNDING_MIN_SCORE);
      expect(eligible.some((candidate) => candidate.output === picked.output)).toBe(true);
    }
  });
});
