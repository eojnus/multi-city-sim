import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation/core/simulation';
import { DEMO_CONFIG } from '../src/data/config';
import type { WorldState } from '../src/simulation/contracts/types';
import {
  autoSelectPolicies,
  policySummary,
  settlePolicies,
  startPolicy,
} from '../src/simulation/policies/policies';
import { activePolicy, hiringSubsidyPerHire, leaderDomainScale, retentionSubsidyPerEmployee } from '../src/simulation/policies/query';
import { planCompanyDecision } from '../src/simulation/companies/ai/strategy';
import { planCompanies } from '../src/simulation/companies/planning';
import { PRODUCTIVITY } from '../src/data/demo-data';
import { reconcileLabor } from '../src/simulation/labor/labor';
import { settleGovernment } from '../src/simulation/government/fiscal';
import { companyProductivityMultiplier } from '../src/simulation/production/production';
import { createWorldLedgers } from '../src/simulation/markets/markets';
import { settleTransportMonth } from '../src/simulation/transport/settlement';
import { advanceTransportConstruction, corridorCapacity } from '../src/simulation/transport/network';
import { foundCompany, expandCompanyCapacity } from '../src/simulation/companies/lifecycle/lifecycle';
import { setCompanyEmployees } from '../src/simulation/companies/company';
import { executeIntercityPurchase } from '../src/simulation/markets/intercity';
import { checkInvariants } from '../src/simulation/core/invariants';
import { appointPlayerMayor, leaderOf, leaderSectorMultiplier } from '../src/simulation/politics/politics';
import { RECIPES } from '../src/data/demo-data';
import type { FinanceResult } from '../src/simulation/finance/finance';
function richWorld(): WorldState {
  const world = Simulation.create().state;
  for (const city of world.cities) {
    city.treasury = 80_000_000;
    city.lastMonth.publicWageBill = city.publicSector.employees * city.publicSector.wageRate;
  }
  return world;
}

function policySpendEntries(world: WorldState, cityId: string) {
  return world.fiscal.ledger.filter(
    (entry) => entry.cityId === cityId && entry.kind === 'policySpending',
  );
}

describe('15 项政策逐项验证：起始条件 → 财政变化 → 实际模拟效果', () => {
  it('新增招聘补贴：财政支出并把补贴发给实际新雇员，企业决策计入补贴', () => {
    const world = richWorld();
    const city = world.cities.find((entry) => entry.id === 'lanport')!;
    const company = world.companies.find((entry) => entry.cityId === city.id)!;
    const treasuryBefore = city.treasury;
    const started = startPolicy(world, city.id, 'hiringSubsidy', DEMO_CONFIG);
    expect(started.ok, started.error).toBe(true);
    const policy = activePolicy(world, city.id, 'hiringSubsidy')!;
    expect(hiringSubsidyPerHire(world, city.id, company.wageRate, DEMO_CONFIG)).toBeGreaterThan(0);

    const cashBefore = company.cash;
    settlePolicies(world, DEMO_CONFIG, {
      hiresByCompany: { [company.id]: 5 },
      log: [],
    });
    expect(policy.effects.hiresSubsidised).toBe(5);
    expect(policy.spent).toBeGreaterThan(0);
    expect(company.cash).toBeGreaterThan(cashBefore);
    expect(city.treasury).toBeLessThan(treasuryBefore);
    expect(policySpendEntries(world, city.id)).toHaveLength(1);

    // 企业 AI：相同企业，有补贴时因现金月数改善而保留更多岗位。
    const plain = richWorld();
    const plainCompany = plain.companies.find((entry) => entry.id === company.id)!;
    const baseJobs = planCompanyDecision(plain, plainCompany, DEMO_CONFIG).targetJobs;
    const withPolicy = richWorld();
    const cityWith = withPolicy.cities.find((entry) => entry.id === city.id)!;
    cityWith.treasury = 80_000_000;
    startPolicy(withPolicy, city.id, 'hiringSubsidy', DEMO_CONFIG);
    const companyWith = withPolicy.companies.find((entry) => entry.id === company.id)!;
    companyWith.cash = plainCompany.cash;
    const boostedJobs = planCompanyDecision(withPolicy, companyWith, DEMO_CONFIG).targetJobs;
    expect(boostedJobs).toBeGreaterThanOrEqual(baseJobs);
  });

  it('新增招聘补贴实际提高就业：相同企业条件下招商岗位更多并真实入职', () => {
    const build = (withSubsidy: boolean) => {
      const world = richWorld();
      const city = world.cities.find((entry) => entry.id === 'lanport')!;
      const company = world.companies.find((entry) => entry.id === 'lp-food')!;
      // 只保留一家有招聘需求的企业，避免其他企业抢走失业人口。
      for (const other of world.companies.filter(
        (entry) => entry.cityId === city.id && entry.id !== company.id,
      )) {
        setCompanyEmployees(other, 0);
        other.jobDemand = 0;
        other.capacity = 0;
        other.baseCapacity = 0;
        other.maxCapacity = 0;
      }
      setCompanyEmployees(company, 15_000);
      if (!withSubsidy) {
        // 让计划岗位明显低于产能，制造招聘空间。
        company.capacity = 20_000 * (PRODUCTIVITY[company.recipeOutput] ?? 1) * city.technology.productivityMultiplier * 1.08;
      }
      company.jobDemand = 15_000;
      company.cash = 120_000_000;
      // 关闭自动政策干扰：玩家市长城市不会被 AI 选政策。
      appointPlayerMayor(world, city.id);
      if (withSubsidy) expect(startPolicy(world, city.id, 'hiringSubsidy', DEMO_CONFIG).ok).toBe(true);
      planCompanies(world, DEMO_CONFIG, []);
      const labor = reconcileLabor(world, DEMO_CONFIG, []);
      if (withSubsidy) {
        settlePolicies(world, DEMO_CONFIG, { hiresByCompany: labor.hiresByCompany, log: [] });
      }
      return { world, city, company, hires: labor.hiresByCompany[company.id] ?? 0 };
    };
    const base = build(false);
    const subsidised = build(true);
    expect(subsidised.hires).toBeGreaterThan(base.hires);
    expect(subsidised.company.employees).toBeGreaterThan(base.company.employees);
    expect(subsidised.company.cash).toBeGreaterThan(base.company.cash);
    expect(subsidised.city.treasury).toBeLessThan(base.city.treasury);
    expect(subsidised.city.population.employed).toBeGreaterThan(base.city.population.employed);
    expect(checkInvariants(subsidised.world)).toEqual([]);
  });

  it('稳岗补贴实际减少裁员：企业岗位需求不低于保留阈值', () => {
    const build = (withSubsidy: boolean) => {
      const world = richWorld();
      const city = world.cities.find((entry) => entry.id === 'greenfield')!;
      const company = world.companies.find((entry) => entry.cityId === city.id)!;
      setCompanyEmployees(company, 100);
      company.jobDemand = 100;
      company.capacity = 60 * (PRODUCTIVITY[company.recipeOutput] ?? 1) * city.technology.productivityMultiplier * 1.08; // 产能只支持更少岗位，产生裁员压力
      company.cash = 300_000;
      company.previousMonth.profit = 10_000;
      appointPlayerMayor(world, city.id);
      if (withSubsidy) expect(startPolicy(world, city.id, 'retentionSubsidy', DEMO_CONFIG).ok).toBe(true);
      const plan = planCompanyDecision(world, company, DEMO_CONFIG);
      return { plan, company };
    };
    const base = build(false);
    const subsidised = build(true);
    expect(subsidised.plan.targetJobs).toBeGreaterThan(base.plan.targetJobs);
    expect(subsidised.plan.plan.retentionSubsidyPerEmployee).toBeGreaterThan(0);
    expect(base.plan.plan.retentionSubsidyPerEmployee).toBe(0);
  });

  it('稳岗补贴：按月补贴在岗员工，企业保留岗位意愿提高', () => {
    const world = richWorld();
    const city = world.cities.find((entry) => entry.id === 'lanport')!;
    const company = world.companies.find((entry) => entry.cityId === city.id)!;
    for (const other of world.companies.filter((entry) => entry.cityId === city.id && entry.id !== company.id)) {
      setCompanyEmployees(other, 0);
      other.jobDemand = 0;
    }
    company.jobDemand = company.employees;
    const treasuryBefore = city.treasury;
    expect(startPolicy(world, city.id, 'retentionSubsidy', DEMO_CONFIG).ok).toBe(true);
    const policy = activePolicy(world, city.id, 'retentionSubsidy')!;
    expect(retentionSubsidyPerEmployee(world, city.id, company.wageRate, DEMO_CONFIG)).toBeGreaterThan(0);
    const cashBefore = company.cash;
    settlePolicies(world, DEMO_CONFIG, { hiresByCompany: {}, log: [] });
    expect(policy.effects.paid).toBeGreaterThan(0);
    expect(policy.effects.employeesRetained).toBeGreaterThan(0);
    expect(company.cash).toBeGreaterThan(cashBefore);
    expect(city.treasury).toBeLessThan(treasuryBefore);
  });

  it('职业培训：培训失业居民并提高技能（真实影响单位员工产出）', () => {
    const world = richWorld();
    const city = world.cities.find((entry) => entry.id === 'greenfield')!;
    expect(city.population.unemployed).toBeGreaterThan(0);
    const skillBefore = city.workforce.skillLevel;
    expect(startPolicy(world, city.id, 'vocationalTraining', DEMO_CONFIG).ok).toBe(true);
    const policy = activePolicy(world, city.id, 'vocationalTraining')!;
    settlePolicies(world, DEMO_CONFIG, { hiresByCompany: {}, log: [] });
    expect(policy.effects.trained).toBeGreaterThan(0);
    expect(city.workforce.skillLevel).toBeGreaterThan(skillBefore);
    expect(city.workforce.trainedTotal).toBeGreaterThan(0);
  });

  it('公共岗位计划：财政设立岗位并真实从失业人口招聘', () => {
    const world = richWorld();
    const city = world.cities.find((entry) => entry.id === 'ironvale')!;
    const jobsBefore = city.publicSector.jobs;
    const unemployedBefore = city.population.unemployed;
    expect(startPolicy(world, city.id, 'publicJobs', DEMO_CONFIG).ok).toBe(true);
    const policy = activePolicy(world, city.id, 'publicJobs')!;
    expect(policy.effects.jobsCreated).toBeGreaterThan(0);
    expect(city.publicSector.jobs).toBe(jobsBefore + (policy.effects.jobsCreated ?? 0));
    expect(city.treasury).toBeLessThan(80_000_000);
    const labor = reconcileLabor(world, DEMO_CONFIG, []);
    expect(labor.publicHires).toBeGreaterThan(0);
    expect(city.population.unemployed).toBeLessThan(unemployedBefore);
  });

  it('初创扶持：降低创办资本并由财政注入启动资金', () => {
    const world = richWorld();
    const city = world.cities.find((entry) => entry.id === 'greenfield')!;
    expect(startPolicy(world, city.id, 'startupSupport', DEMO_CONFIG).ok).toBe(true);
    const policy = activePolicy(world, city.id, 'startupSupport')!;
    const group = world.investors.find((entry) => entry.cityId === city.id && entry.cash > 0)!;
    group.cash = 5_000_000;
    const result = foundCompany(
      world,
      { cityId: city.id, founderType: 'investorGroup', founderId: group.id, capital: 300_000 },
      DEMO_CONFIG,
    );
    expect(result.ok, result.error).toBe(true);
    expect(policy.spent).toBeGreaterThan(0);
    const company = world.companies.find((entry) => entry.id === result.companyId)!;
    expect(company.cash).toBeGreaterThan(300_000);
    expect(world.lifecycle.foundings.at(-1)!.governmentGrant).toBeGreaterThan(0);
  });

  it('企业纾困：向困难企业拨款并延后倒闭', () => {
    const world = richWorld();
    const city = world.cities.find((entry) => entry.id === 'lanport')!;
    const company = world.companies.find((entry) => entry.cityId === city.id && entry.employees > 0)!;
    company.cash = 100;
    company.ai.lossMonths = 3;
    company.ai.ageMonths = 20;
    expect(startPolicy(world, city.id, 'companyRelief', DEMO_CONFIG).ok).toBe(true);
    const policy = activePolicy(world, city.id, 'companyRelief')!;
    const cashBefore = company.cash;
    settlePolicies(world, DEMO_CONFIG, { hiresByCompany: {}, log: [] });
    expect(policy.effects.paid).toBeGreaterThan(0);
    expect(policy.effects.companiesHelped).toBeGreaterThan(0);
    expect(company.cash).toBeGreaterThan(cashBefore);
  });

  it('设备与扩产补助：财政承担部分扩产成本，企业产能真实增加', () => {
    const world = richWorld();
    const city = world.cities.find((entry) => entry.id === 'ironvale')!;
    const company = world.companies.find((entry) => entry.cityId === city.id && entry.employees > 0)!;
    company.cash = 5_000_000;
    expect(startPolicy(world, city.id, 'equipmentSubsidy', DEMO_CONFIG).ok).toBe(true);
    const policy = activePolicy(world, city.id, 'equipmentSubsidy')!;
    const capacityBefore = company.capacity;
    const result = expandCompanyCapacity(world, company, DEMO_CONFIG, [], 100);
    expect(result.ok, result.error).toBe(true);
    expect(company.capacity).toBeGreaterThan(capacityBefore);
    expect(policy.spent).toBeGreaterThan(0);
    expect(city.treasury).toBeLessThan(80_000_000);
  });

  it('重点产业扶持：选定行业获得财政拨款与有上限的生产率加成', () => {
    const world = richWorld();
    const city = world.cities.find((entry) => entry.id === 'lanport')!;
    const company = world.companies.find((entry) => entry.cityId === city.id)!;
    expect(
      startPolicy(world, city.id, 'keyIndustrySupport', DEMO_CONFIG, {
        targetSector: company.sector,
      }).ok,
    ).toBe(true);
    const policy = activePolicy(world, city.id, 'keyIndustrySupport')!;
    expect(policy.targetSector).toBe(company.sector);
    settlePolicies(world, DEMO_CONFIG, { hiresByCompany: {}, log: [] });
    expect(policy.effects.paid).toBeGreaterThan(0);
    expect(policy.effects.companiesSupported).toBeGreaterThan(0);
    const multiplier = companyProductivityMultiplier(world, city, company, DEMO_CONFIG);
    expect(multiplier).toBeGreaterThan(1);
    expect(multiplier).toBeLessThanOrEqual(1 + DEMO_CONFIG.policies.keyIndustry.productivityBonus + 0.001);
  });

  it('研发资助：财政投入转化为研究点并提高科技生产率', () => {
    const world = richWorld();
    const city = world.cities.find((entry) => entry.id === 'lanport')!;
    const levelBefore = city.technology.level;
    const multiplierBefore = city.technology.productivityMultiplier;
    expect(startPolicy(world, city.id, 'researchGrant', DEMO_CONFIG).ok).toBe(true);
    settlePolicies(world, DEMO_CONFIG, { hiresByCompany: {}, log: [] });
    expect(city.technology.level).toBeGreaterThan(levelBefore);
    expect(city.technology.productivityMultiplier).toBeGreaterThan(multiplierBefore);
    expect(city.technology.status).toBe('active');
    expect(policySpendEntries(world, city.id).length).toBeGreaterThan(0);
  });

  it('教育投入：缓慢提高城市技能水平', () => {
    const world = richWorld();
    const city = world.cities.find((entry) => entry.id === 'greenfield')!;
    const skillBefore = city.workforce.skillLevel;
    expect(startPolicy(world, city.id, 'educationInvestment', DEMO_CONFIG).ok).toBe(true);
    settlePolicies(world, DEMO_CONFIG, { hiresByCompany: {}, log: [] });
    expect(city.workforce.skillLevel).toBeGreaterThan(skillBefore);
    expect(policySpendEntries(world, city.id).length).toBeGreaterThan(0);
  });

  it('跨城贸易支持：补偿卖方容量损失，但容量惩罚本身仍存在', () => {
    const world = richWorld();
    const city = world.cities.find((entry) => entry.id === 'greenfield')!;
    const seller = world.companies.find((entry) => entry.cityId === 'greenfield')!;
    const buyer = world.companies.find((entry) => entry.cityId === 'lanport')!;
    // 客制化：卖方出售买方需要的投入品。
    const good = seller.recipeOutput;
    buyer.inventory[good] = 0;
    const recipe = RECIPES[buyer.recipeOutput];
    if (!recipe.inputs.some((input) => input.good === good)) return;
    seller.inventory[good] = 10_000;
    seller.cash = 0;
    world.transport.links
      .filter((link) => link.fromCityId === city.id || link.toCityId === city.id)
      .forEach((link) => {
        link.level = 0;
      });
    expect(startPolicy(world, city.id, 'intercityTradeSupport', DEMO_CONFIG).ok).toBe(true);
    buyer.cash = 10_000_000;
    const ledgers = createWorldLedgers(world);
    const purchase = executeIntercityPurchase(
      world,
      world.cities.find((entry) => entry.id === 'lanport')!,
      ledgers['lanport']!,
      good as never,
      100,
      10_000_000,
      { buyerCompanyId: buyer.id },
      DEMO_CONFIG,
    );
    expect(purchase.qty).toBe(100);
    settleTransportMonth(world, DEMO_CONFIG, [], ledgers);
    const trade = world.transport.lastMonth.trades.find((entry) => entry.sellerCompanyId === seller.id)!;
    expect(trade.penaltyRate).toBe(DEMO_CONFIG.transport.penalty.max);
    expect(trade.capacityLoss).toBeGreaterThan(0);
    expect(world.transport.lastMonth.freightSubsidy).toBeGreaterThan(0);
    expect(seller.cash).toBeCloseTo(trade.grossValue, 2);
  });

  it('交通基础设施投资：财政出资开工，建成后容量提高', () => {
    const world = richWorld();
    const city = world.cities.find((entry) => entry.id === 'lanport')!;
    expect(
      startPolicy(world, city.id, 'transportInvestment', DEMO_CONFIG, {
        transportTarget: 'intracity:road',
      }).ok,
    ).toBe(true);
    const network = world.transport.intracity.find((entry) => entry.cityId === city.id)!;
    expect(network.construction).not.toBeNull();
    expect(city.treasury).toBeLessThan(80_000_000);
    for (let i = 0; i < DEMO_CONFIG.transport.intracity.buildMonthsPerLevel; i++) {
      advanceTransportConstruction(world, DEMO_CONFIG, []);
    }
    expect(network.roadLevel).toBeGreaterThan(DEMO_CONFIG.transport.intracity.initialRoadLevel);

    // 城际线路投资在另一个世界验证（同一政策的冷却期不应被绕过）。
    const world2 = richWorld();
    const city2 = world2.cities.find((entry) => entry.id === 'lanport')!;
    const link = world2.transport.links.find(
      (entry) => (entry.fromCityId === 'lanport' || entry.toCityId === 'lanport') && entry.mode === 'road',
    )!;
    const before = corridorCapacity(world2, link.fromCityId, link.toCityId, DEMO_CONFIG);
    const levelBefore = link.level;
    expect(
      startPolicy(world2, city2.id, 'transportInvestment', DEMO_CONFIG, {
        transportTarget: link.id,
      }).ok,
    ).toBe(true);
    for (let i = 0; i < DEMO_CONFIG.transport.road.buildMonthsPerLevel; i++) {
      advanceTransportConstruction(world2, DEMO_CONFIG, []);
    }
    expect(corridorCapacity(world2, link.fromCityId, link.toCityId, DEMO_CONFIG)).toBeGreaterThan(before);
    expect(world2.transport.links.find((entry) => entry.id === link.id)!.level).toBeGreaterThan(levelBefore);
  });
  it('失业救助：向失业居民转移支付并提高可支配收入', () => {
    const world = richWorld();
    const city = world.cities.find((entry) => entry.id === 'ironvale')!;
    const incomeBefore = city.householdIncomeLastMonth;
    expect(startPolicy(world, city.id, 'unemploymentAid', DEMO_CONFIG).ok).toBe(true);
    const policy = activePolicy(world, city.id, 'unemploymentAid')!;
    settlePolicies(world, DEMO_CONFIG, { hiresByCompany: {}, log: [] });
    expect(policy.effects.paid).toBeGreaterThan(0);
    expect(city.householdIncomeLastMonth).toBeGreaterThan(incomeBefore);
    expect(city.lastMonth.benefitsPaid).toBeGreaterThan(0);
  });

  it('住房支持：财政建设住房并发放租金补贴，提高迁入吸引力', () => {
    const world = richWorld();
    const city = world.cities.find((entry) => entry.id === 'greenfield')!;
    const unitsBefore = city.housing.units;
    const incomeBefore = city.householdIncomeLastMonth;
    expect(startPolicy(world, city.id, 'housingSupport', DEMO_CONFIG).ok).toBe(true);
    settlePolicies(world, DEMO_CONFIG, { hiresByCompany: {}, log: [] });
    expect(city.housing.units).toBeGreaterThan(unitsBefore);
    expect(city.housing.rentSubsidyPaid).toBeGreaterThan(0);
    expect(city.householdIncomeLastMonth).toBeGreaterThan(incomeBefore);
    expect(policySpendEntries(world, city.id).length).toBeGreaterThanOrEqual(1);
  });

  it('税收调整：税率在授权范围内变化，并真实改变下月税收', () => {
    const world = richWorld();
    const city = world.cities.find((entry) => entry.id === 'lanport')!;
    const finance: FinanceResult = {
      investorDividendsByCity: {},
      investorDistributionByCity: {},
      dividendsByCity: {},
      playerDividends: 0,
      playerDividendsByCompany: {},
      corporateTaxByCity: { [city.id]: 100_000 },
      privateWagesByCity: { [city.id]: 10_000_000 },
      wageArrears: 0,
    };
    settleGovernment(world, finance, DEMO_CONFIG, []);
    const taxBefore = world.fiscal.ledger.filter((entry) => entry.cityId === city.id && entry.kind === 'incomeTax').at(-1)!.amount;
    const rateBefore = city.incomeTaxRate;
    expect(
      startPolicy(world, city.id, 'taxAdjustment', DEMO_CONFIG, { taxDirection: 'raise' }).ok,
    ).toBe(true);
    expect(city.incomeTaxRate).toBeGreaterThan(rateBefore);
    settleGovernment(world, finance, DEMO_CONFIG, []);
    const taxAfter = world.fiscal.ledger.filter((entry) => entry.cityId === city.id && entry.kind === 'incomeTax').at(-1)!.amount;
    expect(taxAfter).toBeGreaterThan(taxBefore);
    expect(world.policies.history.at(-1)!.taxDirection).toBe('raise');
  });
});

describe('政策边界与玩家市长', () => {
  it('预算超过财政可用资金时明确失败，不产生支出', () => {
    const world = SimpsonWorld();
    const city = world.cities.find((entry) => entry.id === 'lanport')!;
    city.treasury = 10_000;
    const result = startPolicy(world, city.id, 'researchGrant', DEMO_CONFIG);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('财政资金不足');
    expect(world.policies.active).toHaveLength(0);
    expect(world.fiscal.ledger).toHaveLength(0);
  });

  it('同一政策不能重复生效，受冷却与同时政策数量限制', () => {
    const world = richWorld();
    const city = world.cities.find((entry) => entry.id === 'lanport')!;
    expect(startPolicy(world, city.id, 'researchGrant', DEMO_CONFIG).ok).toBe(true);
    expect(startPolicy(world, city.id, 'researchGrant', DEMO_CONFIG).ok).toBe(false);
    expect(startPolicy(world, city.id, 'educationInvestment', DEMO_CONFIG).ok).toBe(true);
    const third = startPolicy(world, city.id, 'housingSupport', DEMO_CONFIG);
    expect(third.ok).toBe(false);
    expect(third.error).toContain('上限');
  });

  it('玩家市长城市：AI 不自动选择政策，玩家可自行选择', () => {
    const world = richWorld();
    const city = world.cities.find((entry) => entry.id === 'lanport')!;
    appointPlayerMayor(world, city.id);
    expect(world.politics.cities.find((entry) => entry.cityId === city.id)!.leader).toBeNull();
    autoSelectPolicies(world, DEMO_CONFIG, []);
    expect(world.policies.active.filter((entry) => entry.cityId === city.id)).toHaveLength(0);
    expect(world.policies.lastSelection[0]!.cityId).toBe(city.id);
    expect(world.policies.lastSelection[0]!.policyId).toBeNull();
    expect(world.policies.lastSelection[0]!.reason).toContain('玩家市长');
    expect(startPolicy(world, city.id, 'hiringSubsidy', DEMO_CONFIG).ok).toBe(true);
    expect(checkInvariants(world)).toEqual([]);
  });

  it('非玩家政府受财政约束：没有可用财政时不启动政策，并记录原因', () => {
    const world = Simulation.create().state;
    for (const city of world.cities) {
      city.treasury = 0;
      city.lastMonth.publicWageBill = city.publicSector.employees * city.publicSector.wageRate;
    }
    autoSelectPolicies(world, DEMO_CONFIG, []);
    expect(world.policies.active).toHaveLength(0);
    for (const city of world.cities) {
      const selection = world.policies.lastSelection.find((entry) => entry.cityId === city.id)!;
      // 财政为零时不能启动任何需要预算的政策；允许不花钱的税收调整。
      expect([null, 'taxAdjustment']).toContain(selection.policyId);
      expect(selection.reason.length).toBeGreaterThan(0);
    }
    expect(world.policies.history.some((entry) => entry.policyId === 'taxAdjustment')).toBe(true);
    expect(world.cities.every((city) => city.treasury >= 0)).toBe(true);
  });

  it('领导人被动属性：重点行业生产率加成有上限，领域倾向放大对应政策效果', () => {
    const world = richWorld();
    const city = world.cities.find((entry) => entry.id === 'lanport')!;
    const leader = leaderOf(world, city.id)!;
    expect(leader).toBeTruthy();
    const matching = world.companies.find(
      (company) => company.cityId === city.id && company.sector === leader.profile.sectorAffinity,
    );
    if (matching) {
      expect(leaderSectorMultiplier(world, city.id, matching.sector, DEMO_CONFIG)).toBeCloseTo(
        1 + DEMO_CONFIG.politics.sectorProductivityBonus,
        4,
      );
      expect(companyProductivityMultiplier(world, city, matching, DEMO_CONFIG)).toBeGreaterThan(1);
    }
    const otherSector = world.companies.find(
      (company) => company.cityId === city.id && company.sector !== leader.profile.sectorAffinity,
    );
    if (otherSector) {
      expect(leaderSectorMultiplier(world, city.id, otherSector.sector, DEMO_CONFIG)).toBe(1);
    }
    const domain = (Object.entries(leader.profile.domainLeanings) as [keyof typeof leader.profile.domainLeanings, number][])
      .sort((a, b) => b[1] - a[1])[0]!;
    expect(leaderDomainScale(world, city.id, domain[0], DEMO_CONFIG)).toBeGreaterThanOrEqual(1);
    expect(leaderDomainScale(world, city.id, domain[0], DEMO_CONFIG)).toBeLessThanOrEqual(
      1 + DEMO_CONFIG.politics.domainEffectScale + 1e-6,
    );
    // 玩家市长没有领导人被动加成。
    appointPlayerMayor(world, city.id);
    expect(leaderSectorMultiplier(world, city.id, 'food', DEMO_CONFIG)).toBe(1);
    expect(leaderDomainScale(world, city.id, 'employment', DEMO_CONFIG)).toBe(1);
  });

  it('非玩家政府按城市弱项与领导人倾向选择政策并记录原因', () => {
    const world = richWorld();
    autoSelectPolicies(world, DEMO_CONFIG, []);
    for (const city of world.cities) {
      const selection = world.policies.lastSelection.find((entry) => entry.cityId === city.id)!;
      expect(selection).toBeDefined();
      expect(selection.reason.length).toBeGreaterThan(0);
      expect(world.policies.active.some((entry) => entry.cityId === city.id)).toBe(true);
    }
    const summary = policySummary(world, 'lanport');
    expect(summary.leader.length).toBeGreaterThan(0);
  });
});

/** 极低财政的新世界，用于失败路径。 */
function SimpsonWorld(): WorldState {
  const world = Simulation.create().state;
  for (const city of world.cities) city.treasury = 0;
  return world;
}
