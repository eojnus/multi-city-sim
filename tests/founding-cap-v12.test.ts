import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation/core/simulation';
import { DEMO_CONFIG, type DemoConfig } from '../src/data/config';
import { GOODS, PRODUCTIVITY } from '../src/data/demo-data';
import type { EquipmentKind, WorldState } from '../src/simulation/contracts/types';
import {
  foundCompany,
  liquidateCompany,
  maybeFoundCompanies,
} from '../src/simulation/companies/lifecycle/lifecycle';
import { foundingAttempts } from '../src/simulation/companies/founding';
import { checkInvariants } from '../src/simulation/core/invariants';
import { workforceSkillMultiplier } from '../src/simulation/labor/workforce';

const KINDS: EquipmentKind[] = ['farm', 'industry', 'energy'];

function withConfig(patch: Record<string, number>): DemoConfig {
  return {
    ...DEMO_CONFIG,
    lifecycle: { ...DEMO_CONFIG.lifecycle, ...patch } as unknown as DemoConfig['lifecycle'],
  } as unknown as DemoConfig;
}

function cityOf(world: WorldState, cityId = 'lanport') {
  return world.cities.find((city) => city.id === cityId)!;
}

/**
 * 资源充足的世界：每个行业都有“价格合理 + 有支付能力未满足需求”的缺口，
 * 出资人/财政/政府设备库存/劳动力都足够支撑每城 100+ 家真实创办，用来验证
 * “100 是上限而不是目标”以及连续创办不会重复使用同一笔资金/设备/劳动力。
 */
function maxWorld(): WorldState {
  const world: WorldState = Simulation.create(DEMO_CONFIG).state;
  for (const city of world.cities) {
    city.treasury = 1_000_000_000_000;
    const employed = city.population.employed;
    const addedLabor = 8_000_000 - city.population.laborForce;
    city.population.laborForce = 8_000_000;
    city.population.unemployed = city.population.laborForce - employed;
    city.population.total = city.population.laborForce + city.population.nonLabor;
    // 保持“居民群体人数合计 == 城市总人口”的不变量：把新增劳动力挂到失业群体。
    const unemployedGroup = world.households.groups.find(
      (group) => group.cityId === city.id && group.occupation === 'unemployed',
    );
    if (unemployedGroup) unemployedGroup.people += addedLabor;
    for (const good of GOODS) {
      const market = city.market[good.id];
      market.price = Math.round(good.basePrice * 1.5 * 100) / 100;
      market.lastPriceChangePct = 6;
      market.demand = 5_000_000;
      market.sold = 0;
      market.unmetDemand = 5_000_000;
      market.supply = 0;
    }
  }
  for (const group of world.investors) group.cash = 1_000_000_000_000;
  for (const company of world.companies) company.cash = 100_000_000_000;
  world.equipmentMarket.initialStock = { farm: 10_000, industry: 10_000, energy: 10_000 };
  return world;
}

function totalOwnedCash(world: WorldState): number {
  return (
    world.investors.reduce((sum, group) => sum + group.cash, 0) +
    world.companies.reduce((sum, company) => sum + company.cash, 0) +
    world.cities.reduce((sum, city) => sum + city.treasury, 0) +
    world.player.cash
  );
}

function outstandingLoans(world: WorldState): number {
  return world.banking.loans.reduce((sum, loan) => sum + loan.outstanding, 0);
}

function equipmentUnitsOf(company: { equipment: Record<EquipmentKind, number> }): number {
  return KINDS.reduce((sum, kind) => sum + company.equipment[kind], 0);
}

function stopAttempts(world: WorldState) {
  return foundingAttempts(world).filter((attempt) => attempt.note.includes('本轮自动创办停止'));
}

describe('v1.2 自动创办上限与资源使用', () => {
  it('单月每城最多 100 家；连续创办逐次使用最新资金/设备/劳动力，不重复计数', () => {
    const config = withConfig({ maxCompaniesPerCity: 1000 });
    const world = maxWorld();
    const stockBefore = { ...world.equipmentMarket.initialStock };
    const equipmentGoodIds = ['farmEquipment', 'industryEquipment', 'energyEquipment'] as const;
    const inventoryBefore = world.companies.reduce(
      (sum, company) => sum + equipmentGoodIds.reduce((inner, good) => inner + company.inventory[good], 0),
      0,
    );
    const cashBefore = totalOwnedCash(world);
    const loansBefore = outstandingLoans(world);

    const created = maybeFoundCompanies(world, config, []);
    expect(config.lifecycle.maxFoundingsPerCityMonth).toBe(100);
    expect(created).toHaveLength(300);
    for (const city of world.cities) {
      expect(world.lifecycle.foundingMonth?.counts[city.id]).toBe(100);
    }

    // 同月重复调用不会超发，也不会再产生新企业。
    const second = maybeFoundCompanies(world, config, []);
    expect(second).toHaveLength(0);
    expect(world.companies).toHaveLength(65 + 300);

    // 跳过/停止原因结构化写入 attempts。
    expect(
      stopAttempts(world).some((attempt) => attempt.note.includes('本月自动创办已达上限 100 家')),
    ).toBe(true);

    // 每家企业都真实买了设备、留下了启动现金与岗位。
    for (const companyId of created) {
      const company = world.companies.find((entry) => entry.id === companyId)!;
      expect(equipmentUnitsOf(company)).toBeGreaterThan(0);
      expect(company.cash).toBeGreaterThan(0);
      expect(company.jobDemand).toBeGreaterThan(0);
      const holdingShares = world.securities.holdings
        .filter((holding) => holding.companyId === companyId)
        .reduce((sum, holding) => sum + holding.shares, 0);
      expect(holdingShares).toBeCloseTo(1_000_000, 0);
    }

    // 设备库存没有被重复记账：新企业“市场购买”的设备台数 = 政府库存减少量 + 从既有设备企业库存买走的台数。
    // v1.4：每家企业另有 1 台创办者从模拟范围外带入的实物出资，不消耗任何市场/政府库存。
    const governmentUsed = KINDS.reduce(
      (sum, kind) => sum + (stockBefore[kind] - world.equipmentMarket.initialStock[kind]),
      0,
    );
    const newEquipmentUnits = created.reduce((sum, companyId) => {
      const company = world.companies.find((entry) => entry.id === companyId)!;
      return sum + equipmentUnitsOf(company);
    }, 0);
    const newInKindUnits = created.reduce((sum, companyId) => {
      const company = world.companies.find((entry) => entry.id === companyId)!;
      return sum + (company.initialEquipment?.units ?? 0);
    }, 0);
    const inventoryAfter = world.companies.reduce(
      (sum, company) => sum + equipmentGoodIds.reduce((inner, good) => inner + company.inventory[good], 0),
      0,
    );
    expect(governmentUsed + (inventoryBefore - inventoryAfter)).toBe(
      newEquipmentUnits - newInKindUnits,
    );
    expect(world.equipmentMarket.initialStock.farm).toBeGreaterThanOrEqual(0);

    // 劳动力不重复分配：每城所有企业岗位之和不超过可用劳动力。
    for (const city of world.cities) {
      const jobs = world.companies
        .filter((company) => company.cityId === city.id)
        .reduce((sum, company) => sum + company.jobDemand, 0);
      expect(jobs).toBeLessThanOrEqual(city.population.laborForce - city.population.employed);
    }

    // 货币守恒：新企业现金增量的来源只能是真实出资 + 银行按授信发放的贷款。
    const cashAfter = totalOwnedCash(world);
    const loansAfter = outstandingLoans(world);
    expect(cashAfter - cashBefore).toBeCloseTo(loansAfter - loansBefore, 0);

    expect(checkInvariants(world, [], config)).toEqual([]);
  });

  it('在营企业达到 160 上限（含开局 65 家）后停止，并记录明确原因', () => {
    const config = withConfig({ maxFoundingsPerCityMonth: 1000 });
    const world = maxWorld();
    const created = maybeFoundCompanies(world, config, []);
    expect(created).toHaveLength(415);
    for (const city of world.cities) {
      expect(world.companies.filter((company) => company.cityId === city.id)).toHaveLength(160);
    }
    expect(world.companies).toHaveLength(480);
    expect(
      foundingAttempts(world).some((attempt) =>
        attempt.obstacles.some((obstacle) => obstacle.detail.includes('在营企业已达城市上限 160 家')),
      ),
    ).toBe(true);
    expect(maybeFoundCompanies(world, config, [])).toHaveLength(0);
  });

  it('倒闭释放名额后，同一 tick 可以再创办 1 家', () => {
    const config = withConfig({ maxFoundingsPerCityMonth: 1000 });
    const world = maxWorld();
    maybeFoundCompanies(world, config, []);
    const lanportCompanies = world.companies.filter((company) => company.cityId === 'lanport');
    expect(lanportCompanies).toHaveLength(160);
    const target = lanportCompanies[0]!;
    const result = liquidateCompany(world, target.id, config, '测试：倒闭释放名额', []);
    expect(result.ok).toBe(true);

    const added = maybeFoundCompanies(world, config, []);
    expect(added).toHaveLength(1);
    expect(world.companies.filter((company) => company.cityId === 'lanport')).toHaveLength(160);
    expect(world.companies.find((company) => company.id === added[0])?.cityId).toBe('lanport');
  });

  it('玩家创办不受 AI 月上限限制，只受在营上限与真实资源约束', () => {
    const config = withConfig({ maxFoundingsPerCityMonth: 1 });
    const world = maxWorld();
    const aiCreated = maybeFoundCompanies(world, config, []);
    expect(aiCreated).toHaveLength(3);
    const aiLanportCount = world.lifecycle.foundingMonth?.counts.lanport ?? 0;
    expect(aiLanportCount).toBe(1);

    const before = world.companies.filter((company) => company.cityId === 'lanport').length;
    const result = foundCompany(
      world,
      { cityId: 'lanport', recipeOutput: 'food', log: [] },
      config,
    );
    expect(result.ok).toBe(true);
    // 玩家创办不计入 AI 的月度计数。
    expect(world.lifecycle.foundingMonth?.counts.lanport ?? 0).toBe(aiLanportCount);
    expect(world.companies.filter((company) => company.cityId === 'lanport').length).toBe(before + 1);
  });

  it('没有可成立机会时早停，并记录结构化原因', () => {
    const world = Simulation.create(DEMO_CONFIG).state;
    const created = maybeFoundCompanies(world, DEMO_CONFIG, []);
    expect(created).toHaveLength(0);
    expect(world.companies).toHaveLength(65);
    expect(
      stopAttempts(world).some((attempt) => attempt.note.includes('没有可成立的创业机会')),
    ).toBe(true);
  });


  it('量纲统一：岗位=设备产能/人均产出，实际产出不超过设备/劳动上限', () => {
    const world = maxWorld();
    const config = withConfig({ maxCompaniesPerCity: 1000 });
    const existing = new Set(world.companies.map((entry) => entry.id));
    maybeFoundCompanies(world, config, []);
    const city = cityOf(world);
    const company = world.companies
      .filter((entry) => entry.cityId === city.id && !existing.has(entry.id))
      .sort((a, b) => b.id.localeCompare(a.id))[0]!;
    const skill = workforceSkillMultiplier(city);
    const tech = city.technology.productivityMultiplier;
    const perEmployee =
      PRODUCTIVITY[company.recipeOutput] * tech * skill * config.production.laborCapacityFactor;

    // v1.3：成立首月按“设备维护性产出”（capacity × minOutputRatio）上岗，
    // 岗位与 bootstrap 计划一致；后续月份由生产计划按真实销量平滑增长。
    const bootstrapOutput =
      company.equipmentCapacity * (config.production.plan?.minOutputRatio ?? 0.05);
    expect(company.productionPlan).not.toBeNull();
    expect(company.jobDemand).toBe(company.productionPlan!.plannedJobs);
    expect(company.jobDemand).toBeGreaterThanOrEqual(1);
    expect(company.jobDemand).toBeLessThanOrEqual(
      Math.max(1, Math.ceil(bootstrapOutput / Math.max(1e-6, perEmployee))),
    );
    expect(company.jobDemand * perEmployee).toBeLessThanOrEqual(bootstrapOutput + perEmployee);
    // 岗位×人均产出不得超过设备产能（否则说明把“台/月”当成了产出量纲）。
    expect(company.jobDemand * perEmployee).toBeLessThanOrEqual(company.equipmentCapacity + 0.01);
    // 首月岗位也不得超过“设备满负荷可支撑岗位”，避免无销量时按满负荷招人烧周转金。
    expect(company.jobDemand).toBeLessThanOrEqual(
      Math.ceil(company.equipmentCapacity / perEmployee) + 1,
    );

    // 实跑一个 tick：实际产出不超过设备/劳动上限（laborCap 用实际在岗人数）。
    const simulation = new Simulation(world, config);
    simulation.tick();
    const produced =
      simulation.state.lastTick.productionRecords.find((entry) => entry.companyId === company.id)
        ?.qty ?? 0;
    const laborCap = company.employees * perEmployee;
    expect(produced).toBeLessThanOrEqual(Math.min(company.equipmentCapacity, laborCap) + 0.01);
    // 成立首月不得欠薪：bootstrap 工资必须由周转金覆盖。
    expect(company.lastMonth.wageArrears).toBe(0);
  });

  it('12 个月实跑：逐月每城自动创办不超 100，性能可接受', () => {
    const simulation = Simulation.create(DEMO_CONFIG);
    const startedAt = performance.now();
    const monthlyCreated: number[] = [];
    for (let month = 0; month < 12; month += 1) {
      simulation.tick();
      const counts = simulation.state.lifecycle.foundingMonth?.counts ?? {};
      const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
      monthlyCreated.push(total);
      for (const count of Object.values(counts)) {
        expect(count).toBeLessThanOrEqual(DEMO_CONFIG.lifecycle.maxFoundingsPerCityMonth);
      }
    }
    const elapsed = performance.now() - startedAt;
    expect(monthlyCreated.some((count) => count > 0)).toBe(true);
    expect(monthlyCreated.reduce((sum, count) => sum + count, 0)).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(120_000);
  }, 150_000);
});
