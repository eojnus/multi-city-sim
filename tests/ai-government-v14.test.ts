import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation/core/simulation';
import { DEMO_CONFIG } from '../src/data/config';
import { GOODS } from '../src/data/demo-data';
import type {
  City,
  CityTaxMonth,
  EconomicCheckup,
  LogEntry,
  PolicyExecutionRecord,
  WorldState,
} from '../src/simulation/contracts/types';
import { clamp, round2 } from '../src/simulation/core/math';
import {
  aiLaborBudget,
  latestCheckup,
  rankLaborPolicies,
  rawUnemploymentTier,
  runCityEconomicCheckup,
  unemploymentTierLabel,
} from '../src/simulation/policies/ai-labor';
import { autoSelectPolicies, cancelPolicy, settlePolicies, startPolicy } from '../src/simulation/policies/policies';
import { activePolicy, hiringSubsidyPerHire } from '../src/simulation/policies/query';
import { appointPlayerMayor } from '../src/simulation/politics/politics';
import { reconcileLabor } from '../src/simulation/labor/labor';
import { settleGovernment } from '../src/simulation/government/fiscal';
import {
  borrowForGovernment,
  computeGovernmentDebtSummary,
  evaluateGovernmentBankruptcy,
  maybeAutoIssueGovernmentBond,
} from '../src/simulation/government/debt';
import { recent12MonthGdp } from '../src/simulation/government/metrics';
import { foundCompany, liquidateCompany } from '../src/simulation/companies/lifecycle/lifecycle';
import { setCompanyEmployees } from '../src/simulation/companies/company';
import { checkInvariants } from '../src/simulation/core/invariants';
import type { FinanceResult } from '../src/simulation/finance/finance';

/**
 * v1.4 §五（AI 政府高失业决策）行为测试。
 *
 * 所有断言都建立在真实世界状态上：体检数值直接来自 city.population / city.market /
 * world.taxes / world.lifecycle / city.government；政策效果来自真实的财政流水、
 * 真实入职（reconcileLabor）、真实工资支付（settleGovernment）与真实债券/贷款合同。
 * 不使用 vi.mock，也不手写“统计结果”冒充产品输出。
 */

const AI_LABOR = DEMO_CONFIG.policies.aiLabor;

function richWorld(): WorldState {
  const world = Simulation.create().state;
  for (const city of world.cities) city.treasury = 80_000_000;
  return world;
}

function cityOf(world: WorldState, cityId = 'lanport'): City {
  const city = world.cities.find((entry) => entry.id === cityId);
  if (!city) throw new Error(`缺少城市 ${cityId}`);
  return city;
}

/** 只改人口结构，保持 P = E + U + N 恒等。 */
function setUnemploymentRate(city: City, rate: number): void {
  const laborForce = Math.max(1, city.population.laborForce);
  const unemployed = Math.max(0, Math.min(laborForce, Math.round(laborForce * rate)));
  city.population.unemployed = unemployed;
  city.population.employed = Math.max(0, laborForce - unemployed);
  city.population.total = city.population.employed + unemployed + city.population.nonLabor;
}

/** 逐月生成真实体检快照（每月把失业率设为给定值），返回最后一次快照。 */
function primeCheckups(world: WorldState, city: City, rate: number, months: number): EconomicCheckup {
  let last: EconomicCheckup | null = null;
  for (let month = 0; month < months; month += 1) {
    world.time.tick += 1;
    setUnemploymentRate(city, rate);
    last = runCityEconomicCheckup(world, city, DEMO_CONFIG);
  }
  if (!last) throw new Error('至少需要生成一个月体检');
  return last;
}

/**
 * 把食品供需字段调成“无症状”基线，便于逐项打开 fundingGap / supplyGap：
 * 价格 0 时食品成本为 0（消费预算足够），库存与产能充足，缺货/缺钱缺口都为 0。
 */
/**
 * 写入居民群体月度消费六项（v1.5 §4：AI 体检以 Σ group.lastMonth 为准，而不是市场台账）。
 * 聚合值全部落在第一条群体上、其余清零，保证 Σ 等于指定值。
 */
function setGroupConsumption(
  world: WorldState,
  city: City,
  values: {
    needUnits?: number;
    effectiveUnits?: number;
    soldUnits?: number;
    unmetFunding?: number;
    supplyShortfallUnits?: number;
  },
): void {
  const groups = world.households.groups.filter((group) => group.cityId === city.id);
  groups.forEach((group, index) => {
    const stats = group.lastMonth;
    stats.basicNeedUnits = index === 0 ? values.needUnits ?? 0 : 0;
    stats.basicEffectiveUnits = index === 0 ? values.effectiveUnits ?? 0 : 0;
    stats.basicSoldUnits = index === 0 ? values.soldUnits ?? 0 : 0;
    stats.unmetFunding = index === 0 ? values.unmetFunding ?? 0 : 0;
    stats.supplyShortfallUnits = index === 0 ? values.supplyShortfallUnits ?? 0 : 0;
  });
}

function neutralizeCheckupInputs(world: WorldState, city: City): void {
  const food = city.market.food;
  food.price = 0;
  food.unmetDemand = 0;
  food.unmetFunding = 0;
  food.closingStock = 1_000_000_000_000;
  for (const company of world.companies) {
    if (company.cityId === city.id && company.recipeOutput === 'food') company.capacity = 1_000_000_000;
  }
  // 居民侧：需要=有效需求=成交，无资金缺口/缺货缺口。
  setGroupConsumption(world, city, { needUnits: 1_000, effectiveUnits: 1_000, soldUnits: 1_000 });
  city.lastMonth.consumerBudget = 0;
  city.lastMonth.consumerSpend = 0;
  city.lastMonth.householdIncome = 0;
  city.lastMonth.benefitsPaid = 0;
  city.lastMonth.publicWageBill = 0;
}

function taxMonth(tick: number, totalRevenue: number): CityTaxMonth {
  return {
    tick,
    incomeTaxBase: 0,
    corporateTaxBase: 0,
    consumptionTaxBase: 0,
    dividendTaxBase: 0,
    transportGuarantee: 1,
    transportFactor: 1,
    incomeTaxRevenue: 0,
    corporateTaxRevenue: 0,
    consumptionTaxRevenue: 0,
    dividendTaxRevenue: 0,
    transportBonus: 0,
    transportLoss: 0,
    totalBase: totalRevenue,
    totalRevenue,
  };
}

/** 写入真实税收历史（tick 严格小于当前 tick）。 */
function setTaxHistory(
  world: WorldState,
  city: City,
  monthlyRevenues: number[],
  endTickExclusive: number,
): void {
  const history = (world.taxes.historyByCity[city.id] ??= []);
  const startTick = endTickExclusive - monthlyRevenues.length;
  monthlyRevenues.forEach((revenue, index) => {
    history.push(taxMonth(startTick + index, revenue));
  });
}

function emptyFinance(): FinanceResult {
  return {
    investorDividendsByCity: {},
    investorDistributionByCity: {},
    cityDividendsByCity: {},
    dividendsByCity: {},
    playerDividends: 0,
    playerDividendsByCompany: {},
    corporateTaxByCity: {},
    privateWagesByCity: {},
    wageArrears: 0,
  };
}

function lastRun(policy: { tracking?: { runs: PolicyExecutionRecord[] } }): PolicyExecutionRecord {
  const run = policy.tracking?.runs.at(-1);
  if (!run) throw new Error('政策缺少执行记录');
  return run;
}

// ---------------------------------------------------------------- §五（一）经济体检与分级

describe('v1.4 §五（一）每月经济体检：真实口径、3 月均值与失业分级', () => {
  it('体检快照全部取自真实状态，并记录 GDP/税收估算口径（同 tick 幂等）', () => {
    const world = richWorld();
    const city = cityOf(world);
    city.householdIncomeLastMonth = 10_000_000;
    city.lastMonth.householdIncome = 10_000_000;
    city.lastMonth.consumerBudget = 12_345_678;
    city.lastMonth.consumerSpend = 3_000_000;
    city.lastMonth.benefitsPaid = 111;
    city.lastMonth.publicWageBill = 222;

    const checkup = runCityEconomicCheckup(world, city, DEMO_CONFIG);
    const foodDefinition = GOODS.find((good) => good.id === 'food')!;
    const foodCompanies = world.companies.filter(
      (company) => company.cityId === city.id && company.recipeOutput === 'food',
    );
    const gdpWindow = recent12MonthGdp(world, city.id, DEMO_CONFIG);

    // 人口与失业：直接来自城市人口状态。
    expect(checkup.employed).toBe(city.population.employed);
    expect(checkup.unemployed).toBe(city.population.unemployed);
    expect(checkup.laborForce).toBe(city.population.laborForce);
    expect(checkup.unemploymentRate).toBe(
      round2(city.population.unemployed / Math.max(1, city.population.laborForce)),
    );
    // 居民收入/消费/食品需要：来自上月结算与真实市场。
    expect(checkup.householdIncome).toBe(city.lastMonth.householdIncome);
    expect(checkup.consumerBudget).toBe(city.lastMonth.consumerBudget);
    expect(checkup.consumerSpend).toBe(city.lastMonth.consumerSpend);
    expect(checkup.foodDemand).toBe(round2(city.population.total * foodDefinition.perCapitaMonthlyNeed));
    expect(checkup.foodInventory).toBe(city.market.food.closingStock);
    expect(checkup.foodPrice).toBe(city.market.food.price);
    expect(checkup.foodCapacity).toBe(round2(foodCompanies.reduce((sum, company) => sum + company.capacity, 0)));
    expect(checkup.foodOutput).toBe(round2(foodCompanies.reduce((sum, company) => sum + company.lastMonth.produced, 0)));
    // 财政与债务：来自真实财政/债务状态。
    expect(checkup.treasury).toBe(city.treasury);
    expect(checkup.totalDebt).toBe(0);
    expect(checkup.necessarySpending).toBe(round2(222 + 111));
    expect(checkup.bondDue).toBe(0);
    expect(checkup.loanDue).toBe(0);
    // 税收：开局不足 12 个月，真实 0 月 + 按近 12 月 GDP 估算 12 月，且明确标注。
    expect(checkup.taxMonthsReal).toBe(0);
    expect(checkup.taxMonthsEstimated).toBe(12);
    expect(checkup.monthlyTaxRevenueReal).toBe(0);
    expect(checkup.monthlyTaxRevenueEstimated).toBe(
      round2((gdpWindow.sum / gdpWindow.months) * AI_LABOR.budgetEstimateGdpTaxBaseShare),
    );
    expect(checkup.gdpWindowSum).toBe(round2(gdpWindow.sum));
    expect(checkup.gdpWindowMonths).toBe(gdpWindow.months);
    expect(checkup.budgetNote).toContain('真实 0 月 + 估算 12 月');
    expect(checkup.note).toContain('近 12 月 GDP');
    // 症状必须反映真实可观测事实：失业率 86% 时不能报告“无明显症状”。
    expect(checkup.symptoms.some((symptom) => symptom.includes('高失业'))).toBe(true);
    // 开局不足 3 个月：原始档位是危机，但决策档位不饱和（最多“承压”）。
    expect(checkup.rawTier).toBe('crisis');
    expect(checkup.tier).toBe('normal');

    // 同一 tick 重复体检幂等：返回同一条记录，不追加。
    const before = world.policies.checkups!.filter((entry) => entry.cityId === city.id).length;
    const again = runCityEconomicCheckup(world, city, DEMO_CONFIG);
    expect(again).toBe(checkup);
    expect(world.policies.checkups!.filter((entry) => entry.cityId === city.id)).toHaveLength(before);
    expect(latestCheckup(world, city.id)!.tick).toBe(checkup.tick);
  });

  it('失业四档边界与档位标签', () => {
    expect(rawUnemploymentTier(0.05, DEMO_CONFIG)).toBe('normal');
    expect(rawUnemploymentTier(0.0999, DEMO_CONFIG)).toBe('normal');
    // 10%/20%/35% 归入更高档位；只有 >35% 才是危机。
    expect(rawUnemploymentTier(0.1, DEMO_CONFIG)).toBe('strained');
    expect(rawUnemploymentTier(0.1999, DEMO_CONFIG)).toBe('strained');
    expect(rawUnemploymentTier(0.2, DEMO_CONFIG)).toBe('severe');
    expect(rawUnemploymentTier(0.35, DEMO_CONFIG)).toBe('severe');
    expect(rawUnemploymentTier(0.3501, DEMO_CONFIG)).toBe('crisis');
    expect(rawUnemploymentTier(0.9, DEMO_CONFIG)).toBe('crisis');
    expect(unemploymentTierLabel('normal')).toBe('正常');
    expect(unemploymentTierLabel('strained')).toBe('承压');
    expect(unemploymentTierLabel('severe')).toBe('严重');
    expect(unemploymentTierLabel('crisis')).toBe('危机');
  });

  it('3 月均值与趋势来自真实体检历史', () => {
    const world = richWorld();
    const city = cityOf(world);
    const historicalRates = [0.1, 0.1, 0.1, 0.2, 0.3, 0.4];
    historicalRates.forEach((rate, index) => {
      world.time.tick = index + 1;
      setUnemploymentRate(city, rate);
      runCityEconomicCheckup(world, city, DEMO_CONFIG);
    });
    world.time.tick = 7;
    setUnemploymentRate(city, 0.5);
    const checkup = runCityEconomicCheckup(world, city, DEMO_CONFIG);

    // 3 月均值 = 最近 2 个月历史 + 本月。
    const expectedAverage = round2((0.3 + 0.4 + 0.5) / 3);
    expect(checkup.unemploymentRateAvg3).toBe(expectedAverage);
    // 趋势 = 3 月均值 − 再前 3 个月均值（历史 0.1/0.1/0.1）。
    expect(checkup.unemploymentTrend).toBe(round2(expectedAverage - 0.1));
    expect(checkup.unemploymentTrend).toBeGreaterThan(0);
    expect(checkup.symptoms.some((symptom) => symptom.includes('失业率上升'))).toBe(true);
  });

  it('分级迟滞：升级需连续确认；降级需连续确认（且先等 3 月均值回落）', () => {
    const world = richWorld();
    const city = cityOf(world);
    const tiers: string[] = [];
    const raws: string[] = [];
    const checkups: EconomicCheckup[] = [];
    for (let tick = 1; tick <= 10; tick += 1) {
      world.time.tick = tick;
      setUnemploymentRate(city, tick <= 4 ? 0.9 : 0.02);
      const checkup = runCityEconomicCheckup(world, city, DEMO_CONFIG);
      tiers.push(checkup.tier);
      raws.push(checkup.rawTier);
      checkups.push(checkup);
    }

    expect(raws).toEqual([
      'crisis',
      'crisis',
      'crisis',
      'crisis',
      'crisis',
      'severe',
      'normal',
      'normal',
      'normal',
      'normal',
    ]);
    // 第 1 个月不饱和；第 2 个月因开局保护最多“承压”；第 3 个月确认进入危机。
    expect(tiers.slice(0, 4)).toEqual(['normal', 'strained', 'crisis', 'crisis']);
    // 降级：第 5 个月 3 月均值仍高 → 维持危机；第 7 个月均值已低但确认月数不足 → 仍危机；
    // 第 8 个月连续 2 个月不高于目标档位后才降为正常，避免边界逐月抖动。
    expect(tiers.slice(4, 8)).toEqual(['crisis', 'crisis', 'crisis', 'normal']);
    expect(tiers.slice(8)).toEqual(['normal', 'normal']);
    // 高失业症状按真实观测值记录，不因决策档位迟滞而消失。
    expect(checkups[0]!.symptoms.some((symptom) => symptom.includes('高失业'))).toBe(true);
    expect(checkups[7]!.symptoms.some((symptom) => symptom.includes('高失业'))).toBe(false);
  });

  it('20% 与 90% 失业：档位、症状与预算都不同', () => {
    const lowWorld = richWorld();
    const lowCity = cityOf(lowWorld);
    const low = primeCheckups(lowWorld, lowCity, 0.2, 3);

    const highWorld = richWorld();
    const highCity = cityOf(highWorld);
    const high = primeCheckups(highWorld, highCity, 0.9, 3);

    expect(low.unemploymentRateAvg3).toBe(0.2);
    expect(high.unemploymentRateAvg3).toBe(0.9);
    // 20% 属“20–35% 严重”档，90% 属“>35% 危机”档。
    expect(low.rawTier).toBe('severe');
    expect(high.rawTier).toBe('crisis');
    expect(low.tier).toBe('severe');
    expect(high.tier).toBe('crisis');
    expect(low.symptoms.some((symptom) => symptom.includes('严重档'))).toBe(true);
    expect(high.symptoms.some((symptom) => symptom.includes('危机档'))).toBe(true);
    expect(high.symptoms).not.toEqual(low.symptoms);

    // 档位比例不同（5%–15% 区间内），预算随档位增加。
    expect(low.budgetShare).toBe(AI_LABOR.budgetTierShares.severe);
    expect(high.budgetShare).toBe(AI_LABOR.budgetTierShares.crisis);
    expect(high.budget).toBeGreaterThan(low.budget);
    // 预算 = 近 12 月平均月税收 × 档位比例（再受上下限约束），可直接由体检字段复算。
    const expectedBudget = (checkup: EconomicCheckup) =>
      round2(
        clamp(checkup.monthlyTaxRevenueEstimated * checkup.budgetShare, AI_LABOR.budgetFloor, AI_LABOR.budgetCap),
      );
    expect(low.budget).toBe(expectedBudget(low));
    expect(high.budget).toBe(expectedBudget(high));
  });
});

// ---------------------------------------------------------------- §五（三）动态预算与债务预警

describe('v1.4 §五（三）动态预算：税收口径、5%–15% 区间与债务/GDP 预警', () => {
  it('不足 12 个月按 GDP 估算并记录估算月数，预算为月税收 × 档位比例', () => {
    const world = richWorld();
    const city = cityOf(world);
    const checkup = runCityEconomicCheckup(world, city, DEMO_CONFIG);
    const gdpWindow = recent12MonthGdp(world, city.id, DEMO_CONFIG);

    expect(gdpWindow.months).toBeGreaterThan(0);
    expect(checkup.taxMonthsReal).toBe(0);
    expect(checkup.taxMonthsEstimated).toBe(12);
    expect(checkup.monthlyTaxRevenueReal).toBe(0);
    const monthlyGdp = gdpWindow.sum / gdpWindow.months;
    const estimatedMonthly = round2(monthlyGdp * AI_LABOR.budgetEstimateGdpTaxBaseShare);
    expect(checkup.monthlyTaxRevenueEstimated).toBe(estimatedMonthly);
    expect(checkup.budgetNote).toContain('真实 0 月 + 估算 12 月');
    // 估算税收不是真实税收：二者字段分开，不混用。
    expect(checkup.taxMonthsEstimated).toBe(12);
    expect(checkup.monthlyTaxRevenueReal).not.toBe(estimatedMonthly);
    expect(checkup.budget).toBe(
      round2(clamp(estimatedMonthly * checkup.budgetShare, AI_LABOR.budgetFloor, AI_LABOR.budgetCap)),
    );
    expect(checkup.budgetShare).toBeGreaterThanOrEqual(AI_LABOR.budgetTaxRevenueMinShare);
    expect(checkup.budgetShare).toBeLessThanOrEqual(AI_LABOR.budgetTaxRevenueMaxShare);
  });

  it('真实税收月数与估算月数混合计算，并只把真实部分当真实税收', () => {
    const world = richWorld();
    const city = cityOf(world);
    world.time.tick = 20;
    setTaxHistory(world, city, [5_000_000, 5_000_000, 5_000_000, 5_000_000, 5_000_000, 5_000_000], 20);
    const checkup = runCityEconomicCheckup(world, city, DEMO_CONFIG);
    const gdpWindow = recent12MonthGdp(world, city.id, DEMO_CONFIG);
    const estimatedMonthly = round2(
      (gdpWindow.sum / gdpWindow.months) * AI_LABOR.budgetEstimateGdpTaxBaseShare,
    );

    expect(checkup.taxMonthsReal).toBe(6);
    expect(checkup.taxMonthsEstimated).toBe(6);
    expect(checkup.monthlyTaxRevenueReal).toBe(5_000_000);
    expect(checkup.monthlyTaxRevenueEstimated).toBe(estimatedMonthly);
    expect(checkup.budgetNote).toContain('真实 6 月 + 估算 6 月');
    const blended = (5_000_000 * 6 + estimatedMonthly * 6) / 12;
    expect(checkup.budget).toBe(
      round2(clamp(blended * checkup.budgetShare, AI_LABOR.budgetFloor, AI_LABOR.budgetCap)),
    );
  });

  it('预算下限与上限生效，且档位比例始终在 5%–15%', () => {
    const floorWorld = richWorld();
    const floorCity = cityOf(floorWorld);
    floorWorld.time.tick = 100;
    setTaxHistory(floorWorld, floorCity, Array.from({ length: 12 }, () => 100_000), 100);
    const floor = aiLaborBudget(floorWorld, floorCity, 'crisis', DEMO_CONFIG);
    expect(floor.realMonths).toBe(12);
    expect(floor.estimatedMonths).toBe(0);
    expect(floor.budget).toBe(AI_LABOR.budgetFloor);
    expect(floor.share).toBe(AI_LABOR.budgetTaxRevenueMaxShare);

    const capWorld = richWorld();
    const capCity = cityOf(capWorld);
    capWorld.time.tick = 100;
    setTaxHistory(capWorld, capCity, Array.from({ length: 12 }, () => 100_000_000), 100);
    const cap = aiLaborBudget(capWorld, capCity, 'crisis', DEMO_CONFIG);
    expect(cap.budget).toBe(AI_LABOR.budgetCap);
    expect(cap.share).toBe(AI_LABOR.budgetTaxRevenueMaxShare);

    const normal = aiLaborBudget(floorWorld, floorCity, 'normal', DEMO_CONFIG);
    expect(normal.share).toBe(AI_LABOR.budgetTaxRevenueMinShare);
  });

  it('高失业档位：候选政策预算使用动态预算，不再被固定小额默认预算封顶', () => {
    const world = richWorld();
    const city = cityOf(world);
    primeCheckups(world, city, 0.9, 3);
    neutralizeCheckupInputs(world, city);
    // 居民买不起基本食品：有效需求 800 < 基本需要 1000（资金约束），市场台账不参与判定。
    setGroupConsumption(world, city, { needUnits: 1_000, effectiveUnits: 800, soldUnits: 800, unmetFunding: 0 });
    world.time.tick += 1;
    setUnemploymentRate(city, 0.9);
    const checkup = runCityEconomicCheckup(world, city, DEMO_CONFIG);
    expect(checkup.tier).toBe('crisis');
    expect(checkup.budgetShare).toBe(AI_LABOR.budgetTierShares.crisis);
    // 危机档动态预算（15%）远大于旧固定小额默认预算。
    expect(checkup.budget).toBeGreaterThan(DEMO_CONFIG.policies.budgets.unemploymentAid * 4);

    const candidates = rankLaborPolicies(world, city, checkup, DEMO_CONFIG);
    const byId = new Map(candidates.map((candidate) => [candidate.policyId, candidate.budget]));
    // 本场景失业救助/公共岗位/招聘补贴的真实月需求都远超动态预算，
    // 因此单月上限 = 本月动态预算；旧实现会被 500k/900k/700k 的固定默认值封顶。
    const oldDefaults: [keyof typeof DEMO_CONFIG.policies.budgets, number][] = [
      ['unemploymentAid', 500_000],
      ['publicJobs', 900_000],
      ['hiringSubsidy', 700_000],
    ];
    for (const [policyId, oldDefault] of oldDefaults) {
      expect(byId.get(policyId)).toBe(checkup.budget);
      expect(byId.get(policyId)!).toBeGreaterThan(oldDefault);
    }

    // startPolicy 实际写入的预算与候选一致（不再回落固定默认）。
    const chosen = candidates[0]!;
    expect(startPolicy(world, city.id, chosen.policyId, DEMO_CONFIG, { budget: chosen.budget }).ok).toBe(true);
    const policy = activePolicy(world, city.id, chosen.policyId)!;
    expect(policy.budget).toBe(chosen.budget);
    expect(policy.budget).toBe(checkup.budget);
  });

  it('招聘受阻：招聘补贴/创业支持的候选预算同样使用动态预算', () => {
    const world = richWorld();
    const city = cityOf(world);
    primeCheckups(world, city, 0.9, 3);
    neutralizeCheckupInputs(world, city);
    city.workforce.skillLevel = 0.8;
    const company = world.companies.find((entry) => entry.cityId === city.id)!;
    company.jobDemand = company.employees + Math.ceil(city.population.laborForce * 0.05);
    world.time.tick += 1;
    setUnemploymentRate(city, 0.9);
    const checkup = runCityEconomicCheckup(world, city, DEMO_CONFIG);
    expect(checkup.hiringBlocked).toBe(true);

    const candidates = rankLaborPolicies(world, city, checkup, DEMO_CONFIG);
    const hiring = candidates.find((candidate) => candidate.policyId === 'hiringSubsidy')!;
    const startup = candidates.find((candidate) => candidate.policyId === 'startupSupport')!;
    expect(hiring.budget).toBe(checkup.budget);
    expect(startup.budget).toBe(checkup.budget);
    expect(hiring.budget).toBeGreaterThan(DEMO_CONFIG.policies.budgets.hiringSubsidy);
    expect(startup.budget).toBeGreaterThan(DEMO_CONFIG.policies.budgets.startupSupport);
  });

  it('债务预警下动态预算按比例缩减，候选预算随之缩减且保留 minBudget', () => {
    const world = richWorld();
    const city = cityOf(world);
    primeCheckups(world, city, 0.9, 3);
    neutralizeCheckupInputs(world, city);
    // 居民买不起基本食品：有效需求 800 < 基本需要 1000（资金约束），市场台账不参与判定。
    setGroupConsumption(world, city, { needUnits: 1_000, effectiveUnits: 800, soldUnits: 800, unmetFunding: 0 });
    // 用固定 GDP 窗口控制债务/GDP：借 1,800 万 / 2,000 万 = 90%（≥85% 预警，未到 100% 破产线）。
    city.gdpWindow = [{ tick: -1, value: 20_000_000, estimated: true }];
    const borrow = borrowForGovernment(world, city, DEMO_CONFIG, 18_000_000, world.time.tick, [], {
      exact: true,
    });
    expect(borrow.ok, borrow.error).toBe(true);
    city.government!.lastDebt = computeGovernmentDebtSummary(world, city, DEMO_CONFIG, world.time.tick);
    world.time.tick += 1;
    setUnemploymentRate(city, 0.9);
    const checkup = runCityEconomicCheckup(world, city, DEMO_CONFIG);
    expect(checkup.debtWarning).toBe(true);
    expect(checkup.debtRatio).toBeCloseTo(0.9, 6);
    expect(checkup.budgetNote).toContain('预算缩减 50%');

    // 无预警动态预算 = 估算月税收 × 危机档 15%（仍在上下限内）；预警后减半。
    const gdpWindow = recent12MonthGdp(world, city.id, DEMO_CONFIG);
    const estimatedMonthly = round2((gdpWindow.sum / gdpWindow.months) * AI_LABOR.budgetEstimateGdpTaxBaseShare);
    const baseBudget = round2(
      clamp(estimatedMonthly * checkup.budgetShare, AI_LABOR.budgetFloor, AI_LABOR.budgetCap),
    );
    expect(checkup.budget).toBe(round2(baseBudget * AI_LABOR.debtWarningBudgetShare));
    expect(checkup.budget).toBeGreaterThanOrEqual(DEMO_CONFIG.policies.minBudget);

    const candidates = rankLaborPolicies(world, city, checkup, DEMO_CONFIG);
    const aid = candidates.find((candidate) => candidate.policyId === 'unemploymentAid')!;
    expect(aid.budget).toBe(checkup.budget);
    expect(aid.budget).toBeLessThan(baseBudget);
    expect(startPolicy(world, city.id, 'unemploymentAid', DEMO_CONFIG, { budget: aid.budget }).ok).toBe(true);
    expect(activePolicy(world, city.id, 'unemploymentAid')!.budget).toBe(aid.budget);
  });

  it('normal 档保持旧逻辑：不返回动态预算候选，AI 仍用固定默认预算', () => {
    const world = richWorld();
    const city = cityOf(world);
    primeCheckups(world, city, 0.03, 3);
    world.time.tick += 1;
    setUnemploymentRate(city, 0.03);
    const checkup = runCityEconomicCheckup(world, city, DEMO_CONFIG);
    expect(checkup.tier).toBe('normal');
    // 旧行为：normal 不进入高失业对症候选（继续走弱项打分 + 固定默认预算）。
    expect(rankLaborPolicies(world, city, checkup, DEMO_CONFIG)).toHaveLength(0);

    autoSelectPolicies(world, DEMO_CONFIG, []);
    const selection = world.policies.lastSelection.find((entry) => entry.cityId === city.id)!;
    expect(selection.policyId).not.toBeNull();
    const policy = world.policies.active.find((entry) => entry.cityId === city.id)!;
    expect(policy.policyId).toBe(selection.policyId);
    expect(policy.budget).toBe(DEMO_CONFIG.policies.budgets[policy.policyId]);
  });

  it('与 72 月长跑同口径：动态预算达上限 600 万时，候选政策预算也是 600 万', () => {
    const world = richWorld();
    const city = cityOf(world);
    primeCheckups(world, city, 0.9, 3);
    neutralizeCheckupInputs(world, city);
    // 居民买不起基本食品：有效需求 800 < 基本需要 1000（资金约束），市场台账不参与判定。
    setGroupConsumption(world, city, { needUnits: 1_000, effectiveUnits: 800, soldUnits: 800, unmetFunding: 0 });
    // 12 个月真实税收各 1 亿 → 月均 1 亿 × 危机档 15% = 1500 万 → 被预算上限 600 万截断。
    world.time.tick = 20;
    setTaxHistory(world, city, Array.from({ length: 12 }, () => 100_000_000), 20);
    world.time.tick += 1;
    setUnemploymentRate(city, 0.9);
    const checkup = runCityEconomicCheckup(world, city, DEMO_CONFIG);
    expect(checkup.tier).toBe('crisis');
    expect(checkup.taxMonthsReal).toBe(12);
    expect(checkup.budget).toBe(AI_LABOR.budgetCap);

    const candidates = rankLaborPolicies(world, city, checkup, DEMO_CONFIG);
    for (const policyId of ['unemploymentAid', 'publicJobs', 'hiringSubsidy'] as const) {
      const candidate = candidates.find((entry) => entry.policyId === policyId)!;
      expect(candidate.budget).toBe(6_000_000);
      expect(candidate.budget).toBeGreaterThan(DEMO_CONFIG.policies.budgets[policyId]);
    }
    const chosen = candidates[0]!;
    expect(startPolicy(world, city.id, chosen.policyId, DEMO_CONFIG, { budget: chosen.budget }).ok).toBe(true);
    expect(activePolicy(world, city.id, chosen.policyId)!.budget).toBe(6_000_000);
  });

  it('动态预算变大但结算时财政为 0：实际发放 0，不伪造支出（资金必须真实到账）', () => {
    const world = richWorld();
    const city = cityOf(world);
    primeCheckups(world, city, 0.9, 3);
    neutralizeCheckupInputs(world, city);
    // 居民买不起基本食品：有效需求 800 < 基本需要 1000（资金约束），市场台账不参与判定。
    setGroupConsumption(world, city, { needUnits: 1_000, effectiveUnits: 800, soldUnits: 800, unmetFunding: 0 });
    world.time.tick += 1;
    setUnemploymentRate(city, 0.9);
    autoSelectPolicies(world, DEMO_CONFIG, []);
    const policy = activePolicy(world, city.id, 'unemploymentAid')!;
    // 单月参考预算已写入政策（远大于旧固定默认），总预算 = 单月 × 剩余月数；但本月未走
    // v1.5 §4 资金预留步骤且结算时财政为 0，因此实发必须为 0（不伪造支出）。
    expect(policy.referenceBudget).toBe(latestCheckup(world, city.id)!.budget);
    expect(policy.referenceBudget).toBeGreaterThan(DEMO_CONFIG.policies.budgets.unemploymentAid);
    expect(policy.budget).toBe(round2(policy.referenceBudget! * (policy.monthsRemaining + 1)));
    city.treasury = 0;
    const benefitsBefore = city.lastMonth.benefitsPaid;
    const ledgerBefore = world.fiscal.ledger.length;
    settlePolicies(world, DEMO_CONFIG, { hiresByCompany: {}, log: [] });

    expect(policy.spent).toBe(0);
    expect(city.lastMonth.benefitsPaid).toBe(benefitsBefore);
    expect(
      world.fiscal.ledger
        .slice(ledgerBefore)
        .filter((entry) => entry.cityId === city.id && entry.kind === 'policySpending'),
    ).toHaveLength(0);
    const run = lastRun(policy);
    expect(run.spent).toBe(0);
    expect(run.beneficiaries).toBe(0);
    expect(run.fiscalImpact).toBe(0);
  });

  it('债务/GDP ≥ 85% 缩减预算但非破产；100% 才达到破产线', () => {
    const world = richWorld();
    const city = cityOf(world);
    primeCheckups(world, city, 0.9, 3);
    // 固定 GDP 判定窗口，令债务/GDP 可精确控制。
    city.gdpWindow = [{ tick: -1, value: 12_000_000, estimated: true }];
    const borrow = borrowForGovernment(world, city, DEMO_CONFIG, 10_800_000, world.time.tick, [], {
      exact: true,
    });
    expect(borrow.ok, borrow.error).toBe(true);
    const summary = computeGovernmentDebtSummary(world, city, DEMO_CONFIG, world.time.tick);
    city.government!.lastDebt = summary;
    expect(summary.debtRatio).toBeCloseTo(0.9, 6);
    expect(summary.riskLevel).toBe('high');
    expect(city.government!.bankruptcy.status).toBe('solvent');
    expect(evaluateGovernmentBankruptcy(city, summary, DEMO_CONFIG)).toBe(false);

    world.time.tick += 1;
    setUnemploymentRate(city, 0.9);
    const checkup = runCityEconomicCheckup(world, city, DEMO_CONFIG);
    expect(checkup.tier).toBe('crisis');
    expect(checkup.debtRatio).toBeCloseTo(0.9, 6);
    expect(checkup.debtWarning).toBe(true);
    expect(checkup.symptoms.some((symptom) => symptom.includes('债务/GDP 预警'))).toBe(true);
    expect(checkup.budgetNote).toContain('预警线 85%');
    // 预估税收 = 近 12 月 GDP 月均 × 估算税率；危机档 15%，预警后预算减半。
    const gdpWindow = recent12MonthGdp(world, city.id, DEMO_CONFIG);
    const estimatedMonthly = round2((gdpWindow.sum / gdpWindow.months) * AI_LABOR.budgetEstimateGdpTaxBaseShare);
    const baseBudget = round2(
      clamp(estimatedMonthly * checkup.budgetShare, AI_LABOR.budgetFloor, AI_LABOR.budgetCap),
    );
    expect(checkup.budget).toBe(round2(baseBudget * AI_LABOR.debtWarningBudgetShare));
    expect(checkup.budget).toBeLessThan(AI_LABOR.budgetFloor);
    // 预算缩减到最低政策预算以下 → 本月没有可负担的对症政策（不虚构支出）。
    expect(rankLaborPolicies(world, city, checkup, DEMO_CONFIG)).toHaveLength(0);
    // 近 12 月 GDP 口径随体检一起记录。
    expect(checkup.gdpWindowSum).toBe(round2(gdpWindow.sum));
    expect(checkup.gdpWindowMonths).toBe(gdpWindow.months);
    // 真实贷款到期压力：本月新借贷款在下期到期，体检必须看到。
    expect(checkup.bondDue).toBe(0);
    expect(checkup.loanDue).toBeGreaterThan(0);
    expect(checkup.debtServicePressure).toBe(
      round2(checkup.loanDue / Math.max(1, city.treasury)),
    );

    // 债务继续加到 ≥ 100% 才达到破产线（本函数不负责清算，状态仍为 solvent）。
    borrowForGovernment(world, city, DEMO_CONFIG, 1_500_000, world.time.tick, [], { exact: true });
    const over = computeGovernmentDebtSummary(world, city, DEMO_CONFIG, world.time.tick);
    expect(over.debtRatio).toBeGreaterThanOrEqual(DEMO_CONFIG.government.fiscalRisk.bankruptAt);
    expect(evaluateGovernmentBankruptcy(city, over, DEMO_CONFIG)).toBe(true);
    expect(city.government!.bankruptcy.status).toBe('solvent');
  });
});

// ---------------------------------------------------------------- §五（二）对症政策

describe('v1.4 §五（二）对症政策：买不起 / 缺货 / 缺岗位 / 技能不匹配', () => {
  it('买不起但有供给 → 优先失业救助，发放真实进入居民收入', () => {
    const world = richWorld();
    const city = cityOf(world);
    primeCheckups(world, city, 0.9, 3);
    neutralizeCheckupInputs(world, city);
    // 居民买不起基本食品（预算约束）：需要 1000、有效需求 800，市场台账不参与判定。
    setGroupConsumption(world, city, { needUnits: 1_000, effectiveUnits: 800, soldUnits: 800, unmetFunding: 0 });
    world.time.tick += 1;
    setUnemploymentRate(city, 0.9);
    const checkup = runCityEconomicCheckup(world, city, DEMO_CONFIG);

    expect(checkup.tier).toBe('crisis');
    expect(checkup.fundingGap).toBe(true);
    expect(checkup.supplyGap).toBe(false);
    expect(checkup.symptoms).toContain('买不起但有供给');
    expect(checkup.symptoms).not.toContain('有购买力但缺货');

    const candidates = rankLaborPolicies(world, city, checkup, DEMO_CONFIG);
    expect(candidates.slice(0, 3).map((candidate) => candidate.policyId)).toEqual([
      'unemploymentAid',
      'publicJobs',
      'hiringSubsidy',
    ]);
    const chosen = candidates[0]!;
    expect(chosen.reason).toContain('危机');

    const treasuryBefore = city.treasury;
    expect(startPolicy(world, city.id, chosen.policyId, DEMO_CONFIG, { budget: chosen.budget }).ok).toBe(true);
    const policy = activePolicy(world, city.id, 'unemploymentAid')!;
    const incomeBefore = city.householdIncomeLastMonth;
    const benefitsBefore = city.lastMonth.benefitsPaid;
    settlePolicies(world, DEMO_CONFIG, { hiresByCompany: {}, log: [] });

    expect(policy.spent).toBeGreaterThan(0);
    expect(city.treasury).toBeLessThan(treasuryBefore);
    // 只有实际发放计入居民收入/福利，且与财政支出同额。
    expect(city.householdIncomeLastMonth - incomeBefore).toBeCloseTo(policy.spent, 6);
    expect(city.lastMonth.benefitsPaid - benefitsBefore).toBeCloseTo(policy.spent, 6);
    const run = lastRun(policy);
    expect(run.reason).toContain('失业救助');
    expect(run.jobsEffect).toBe(0);
    expect(run.beneficiaries).toBeGreaterThan(0);
    expect(run.spent).toBe(policy.spent);
    expect(run.fiscalImpact).toBe(-policy.spent);
  });

  it('有购买力但缺货 → 生产/设备/跨城贸易支持，而不是发钱', () => {
    const world = richWorld();
    const city = cityOf(world);
    primeCheckups(world, city, 0.9, 3);
    neutralizeCheckupInputs(world, city);
    // 居民有支付能力但买不到：有效需求 1000、成交 600（缺货 400 件）。
    setGroupConsumption(world, city, {
      needUnits: 1_000,
      effectiveUnits: 1_000,
      soldUnits: 600,
      unmetFunding: 0,
      supplyShortfallUnits: 400,
    });
    world.time.tick += 1;
    setUnemploymentRate(city, 0.9);
    const checkup = runCityEconomicCheckup(world, city, DEMO_CONFIG);

    expect(checkup.supplyGap).toBe(true);
    expect(checkup.fundingGap).toBe(false);
    expect(checkup.symptoms).toContain('有购买力但缺货');
    const candidates = rankLaborPolicies(world, city, checkup, DEMO_CONFIG);
    expect(candidates[0]!.policyId).toBe('equipmentSubsidy');
    expect(candidates.map((candidate) => candidate.policyId)).toEqual(
      expect.arrayContaining(['equipmentSubsidy', 'keyIndustrySupport', 'intercityTradeSupport']),
    );
  });

  it('有订单缺岗位且技能足够 → 真实招聘补贴/创业支持，不安排培训', () => {
    const world = richWorld();
    const city = cityOf(world);
    primeCheckups(world, city, 0.9, 3);
    neutralizeCheckupInputs(world, city);
    city.workforce.skillLevel = 0.8;
    const company = world.companies.find((entry) => entry.cityId === city.id)!;
    company.jobDemand = company.employees + Math.ceil(city.population.laborForce * 0.05);
    world.time.tick += 1;
    setUnemploymentRate(city, 0.9);
    const checkup = runCityEconomicCheckup(world, city, DEMO_CONFIG);

    expect(checkup.hiringBlocked).toBe(true);
    expect(checkup.skillMismatch).toBe(false);
    expect(checkup.vacancies).toBeGreaterThan(0);
    expect(checkup.symptoms).toContain('有岗位但招聘启动受阻');
    const candidates = rankLaborPolicies(world, city, checkup, DEMO_CONFIG);
    expect(candidates[0]!.policyId).toBe('hiringSubsidy');
    expect(candidates.map((candidate) => candidate.policyId)).toEqual(
      expect.arrayContaining(['hiringSubsidy', 'startupSupport']),
    );
    expect(candidates.map((candidate) => candidate.policyId)).not.toContain('vocationalTraining');
  });

  it('仅当有真实岗位且技能不匹配才培训，且培训不计就业', () => {
    const world = richWorld();
    const city = cityOf(world);
    primeCheckups(world, city, 0.9, 3);
    neutralizeCheckupInputs(world, city);
    city.workforce.skillLevel = 0.3;
    const company = world.companies.find((entry) => entry.cityId === city.id)!;
    company.jobDemand = company.employees + Math.ceil(city.population.laborForce * 0.05);
    world.time.tick += 1;
    setUnemploymentRate(city, 0.9);
    const checkup = runCityEconomicCheckup(world, city, DEMO_CONFIG);

    expect(checkup.hiringBlocked).toBe(true);
    expect(checkup.skillMismatch).toBe(true);
    expect(checkup.symptoms).toContain('岗位与技能不匹配');
    const candidates = rankLaborPolicies(world, city, checkup, DEMO_CONFIG);
    expect(candidates[0]!.policyId).toBe('vocationalTraining');

    const chosen = candidates[0]!;
    expect(startPolicy(world, city.id, chosen.policyId, DEMO_CONFIG, { budget: chosen.budget }).ok).toBe(true);
    const policy = activePolicy(world, city.id, 'vocationalTraining')!;
    const employedBefore = city.population.employed;
    const skillBefore = city.workforce.skillLevel;
    const trainedBefore = city.workforce.trainedTotal;
    settlePolicies(world, DEMO_CONFIG, { hiresByCompany: {}, log: [] });

    expect(policy.effects.trained).toBeGreaterThan(0);
    expect(city.workforce.trainedTotal).toBeGreaterThan(trainedBefore);
    expect(city.workforce.skillLevel).toBeGreaterThan(skillBefore);
    // 培训只提升技能：没有真实招聘就不增加就业。
    expect(city.population.employed).toBe(employedBefore);
    const run = lastRun(policy);
    expect(run.jobsEffect).toBe(0);
    expect(run.note).toContain('培训不是就业');
  });
});

// ---------------------------------------------------------------- §五（二）（四）招聘补贴

describe('v1.4 §五（二）（四）招聘补贴：只按真实净新增岗位发放', () => {
  function calmCompanies(world: WorldState, city: City): void {
    for (const company of world.companies) {
      if (company.cityId === city.id) company.jobDemand = company.employees;
    }
  }

  it('启动即记录在岗基线：政策启动后、首次结算前的真实入职仍能拿到补贴', () => {
    const world = richWorld();
    const city = cityOf(world);
    calmCompanies(world, city);
    const company = world.companies.find((entry) => entry.id === 'lp-food')!;
    const baseline = company.employees;

    expect(startPolicy(world, city.id, 'hiringSubsidy', DEMO_CONFIG).ok).toBe(true);
    const policy = activePolicy(world, city.id, 'hiringSubsidy')!;
    // 修复点：基线在 startPolicy 时写入，而不是等到首次结算。
    expect(policy.tracking?.hiringBaseline?.[company.id]).toBe(baseline);
    const perHire = hiringSubsidyPerHire(world, city.id, company.wageRate, DEMO_CONFIG);
    expect(perHire).toBeGreaterThan(0);

    // 政策启动后发生真实入职（劳动力匹配把 7 人招进企业）。
    company.jobDemand = baseline + 7;
    const labor = reconcileLabor(world, DEMO_CONFIG, []);
    expect(labor.hiresByCompany[company.id]).toBe(7);
    expect(company.employees).toBe(baseline + 7);

    const treasuryBefore = city.treasury;
    const cashBefore = company.cash;
    settlePolicies(world, DEMO_CONFIG, { hiresByCompany: labor.hiresByCompany, log: [] });

    expect(policy.effects.hiresSubsidised).toBe(7);
    expect(policy.spent).toBe(round2(perHire * 7));
    expect(company.cash).toBeGreaterThan(cashBefore);
    expect(city.treasury).toBeLessThan(treasuryBefore);
    expect(policy.tracking?.subsidisedJobs?.[company.id]).toBe(7);
    const run = lastRun(policy);
    expect(run.jobsEffect).toBe(7);
    expect(run.spent).toBe(policy.spent);
    expect(run.fiscalImpact).toBe(-policy.spent);
    expect(policy.spent).toBeLessThanOrEqual(policy.budget);
  });

  it('同一岗位不重复领取：无新增不发放，先裁后招也不重复领', () => {
    const world = richWorld();
    const city = cityOf(world);
    calmCompanies(world, city);
    const company = world.companies.find((entry) => entry.id === 'lp-food')!;
    const baseline = company.employees;
    expect(startPolicy(world, city.id, 'hiringSubsidy', DEMO_CONFIG).ok).toBe(true);
    const policy = activePolicy(world, city.id, 'hiringSubsidy')!;
    const perHire = hiringSubsidyPerHire(world, city.id, company.wageRate, DEMO_CONFIG);

    // 第 1 月：真实新增 7 人 → 补贴 7 人次。
    company.jobDemand = baseline + 7;
    const labor = reconcileLabor(world, DEMO_CONFIG, []);
    expect(labor.hiresByCompany[company.id]).toBe(7);
    world.time.tick += 1;
    settlePolicies(world, DEMO_CONFIG, { hiresByCompany: labor.hiresByCompany, log: [] });
    const spentAfterFirstMonth = policy.spent;
    expect(spentAfterFirstMonth).toBe(round2(perHire * 7));

    // 第 2 月：在岗人数不变，却再次上报 7 名“新雇员”→ 不重复补贴。
    world.time.tick += 1;
    settlePolicies(world, DEMO_CONFIG, { hiresByCompany: { [company.id]: 7 }, log: [] });
    expect(policy.spent).toBe(spentAfterFirstMonth);

    // 第 3 月：先裁回基线，当月无新增 → 不补贴。
    company.jobDemand = baseline;
    world.time.tick += 1;
    reconcileLabor(world, DEMO_CONFIG, []);
    expect(company.employees).toBe(baseline);
    settlePolicies(world, DEMO_CONFIG, { hiresByCompany: {}, log: [] });
    expect(policy.spent).toBe(spentAfterFirstMonth);

    // 第 4 月：招回同样的 7 人（只是补回裁掉的岗位）→ 仍不重复补贴。
    company.jobDemand = baseline + 7;
    world.time.tick += 1;
    const rehire = reconcileLabor(world, DEMO_CONFIG, []);
    expect(rehire.hiresByCompany[company.id]).toBe(7);
    settlePolicies(world, DEMO_CONFIG, { hiresByCompany: rehire.hiresByCompany, log: [] });
    expect(policy.spent).toBe(spentAfterFirstMonth);
    expect(policy.tracking?.subsidisedJobs?.[company.id]).toBe(7);
  });
});

// ---------------------------------------------------------------- §五（四）公共岗位与救助执行追踪

describe('v1.4 §五（四）公共岗位：预留 / 实付 / 财政账本不重复扣费', () => {
  it('启动只预留不预扣，工资按月经公共工资科目实付，账本与预算归属一致', () => {
    const world = richWorld();
    const city = cityOf(world, 'ironvale');
    const jobsBefore = city.publicSector.jobs;
    const baselineEmployees = city.publicSector.employees;
    const unemployedBefore = city.population.unemployed;
    const treasuryBefore = city.treasury;
    const ledgerBefore = world.fiscal.ledger.length;

    expect(startPolicy(world, city.id, 'publicJobs', DEMO_CONFIG).ok).toBe(true);
    const policy = activePolicy(world, city.id, 'publicJobs')!;
    const created = policy.effects.jobsCreated!;
    expect(created).toBeGreaterThan(0);
    expect(city.publicSector.jobs).toBe(jobsBefore + created);
    expect(policy.monthsRemaining).toBe(AI_LABOR.publicWorksMonths);
    // 只记录预算预留额，不预扣财政；工资来源写入 tracking 供核对。
    expect(policy.effects.reservedWages).toBeGreaterThan(0);
    expect(policy.budget).toBe(policy.effects.reservedWages);
    expect(policy.spent).toBe(0);
    expect(policy.tracking?.publicWorksJobs).toBe(created);
    expect(policy.tracking?.publicWorksBaselineEmployees).toBe(baselineEmployees);
    expect(policy.tracking?.publicWorksFunding).toContain('publicWages');
    expect(city.treasury).toBe(treasuryBefore);
    expect(world.fiscal.ledger.slice(ledgerBefore).filter((entry) => entry.kind === 'policySpending')).toHaveLength(0);

    // 真实招聘：公共部门优先从本城失业人口补员。
    const labor = reconcileLabor(world, DEMO_CONFIG, []);
    expect(labor.publicHires).toBe(created);
    expect(city.publicSector.employees).toBe(baselineEmployees + created);
    expect(city.population.unemployed).toBe(unemployedBefore - created);

    // 月度执行：按真实在岗把工资计入政策预算归属，但不再扣一次财政。
    const ledgerBeforeSettle = world.fiscal.ledger.length;
    settlePolicies(world, DEMO_CONFIG, { hiresByCompany: labor.hiresByCompany, log: [] });
    const funded = policy.effects.publicJobsFilled!;
    expect(funded).toBe(created);
    expect(policy.spent).toBe(round2(funded * city.publicSector.wageRate));
    expect(policy.effects.publicWagePaid).toBe(policy.spent);
    expect(policy.spent).toBeLessThanOrEqual(policy.budget);
    expect(city.treasury).toBe(treasuryBefore);
    expect(world.fiscal.ledger.slice(ledgerBeforeSettle)).toHaveLength(0);
    expect(world.fiscal.ledger.slice(ledgerBefore).filter((entry) => entry.kind === 'policySpending')).toHaveLength(0);

    // 财政真正支付公共工资时，只有 publicWages 一笔出账；账本合计 = 财政余额变化。
    const treasuryBeforeFiscal = city.treasury;
    const ledgerBeforeFiscal = world.fiscal.ledger.length;
    settleGovernment(world, emptyFinance(), DEMO_CONFIG, []);
    const cityEntries = world.fiscal.ledger.slice(ledgerBeforeFiscal).filter((entry) => entry.cityId === city.id);
    const publicWageEntries = cityEntries.filter((entry) => entry.kind === 'publicWages');
    expect(publicWageEntries).toHaveLength(1);
    expect(publicWageEntries[0]!.amount).toBe(-round2(city.publicSector.employees * city.publicSector.wageRate));
    expect(cityEntries.filter((entry) => entry.kind === 'policySpending')).toHaveLength(0);
    expect(cityEntries.reduce((sum, entry) => sum + entry.amount, 0)).toBeCloseTo(city.treasury - treasuryBeforeFiscal, 2);
    // 政策预算归属（扣除启动基线后的工资）≤ 真实公共工资总额，不重复也不凭空多计。
    expect(policy.spent).toBeLessThanOrEqual(-publicWageEntries[0]!.amount);
  });

  it('公共岗位到期撤岗：jobs 与 employees 同步撤回，立即满足不变量', () => {
    const world = richWorld();
    const city = cityOf(world, 'ironvale');
    const jobsBefore = city.publicSector.jobs;
    const baselineEmployees = city.publicSector.employees;
    expect(startPolicy(world, city.id, 'publicJobs', DEMO_CONFIG).ok).toBe(true);
    reconcileLabor(world, DEMO_CONFIG, []);
    const policy = activePolicy(world, city.id, 'publicJobs')!;
    const created = policy.effects.jobsCreated!;
    const filledEmployees = city.publicSector.employees;
    expect(city.publicSector.jobs).toBe(jobsBefore + created);
    expect(filledEmployees).toBe(baselineEmployees + created);
    expect(checkInvariants(world)).toEqual([]);

    // 把期限推到最后一月，下个月结算即到期。
    policy.monthsRemaining = 1;
    world.time.tick += 1;
    const log: LogEntry[] = [];
    const populationAfterFill = { ...city.population };
    settlePolicies(world, DEMO_CONFIG, { hiresByCompany: {}, log });

    expect(activePolicy(world, city.id, 'publicJobs')).toBeUndefined();
    expect(world.policies.history.at(-1)!.status).toBe('completed');
    expect(policy.effects.jobsRemoved).toBe(created);
    // 撤岗后立即：jobs 回到基线，employees ≤ jobs，真实在岗人员回到失业人口。
    expect(city.publicSector.jobs).toBe(jobsBefore);
    expect(city.publicSector.employees).toBe(jobsBefore);
    expect(city.publicSector.employees).toBeLessThanOrEqual(city.publicSector.jobs);
    const releasedEmployees = filledEmployees - city.publicSector.employees;
    expect(releasedEmployees).toBe(created);
    expect(policy.effects.employeesRemoved).toBe(releasedEmployees);
    expect(city.population.employed).toBe(populationAfterFill.employed - releasedEmployees);
    expect(city.population.unemployed).toBe(populationAfterFill.unemployed + releasedEmployees);
    expect(city.population.total).toBe(populationAfterFill.total);
    // 不变量立即成立（无需等下月劳动力结算自愈）。
    expect(checkInvariants(world)).toEqual([]);
    // tracking 保留设立岗位数/在岗基线/工资来源，供“预留 vs 实付 vs 账本”核对。
    expect(policy.tracking?.publicWorksJobs).toBe(created);
    expect(policy.tracking?.publicWorksBaselineEmployees).toBe(baselineEmployees);
    expect(policy.tracking?.publicWorksFunding).toContain('publicWages');
    expect(log.some((entry) => entry.message.includes('到期') && entry.message.includes('撤回'))).toBe(true);
  });

  it('玩家取消已填岗公共岗位：立即撤岗撤人，不变量为空', () => {
    const world = richWorld();
    const city = cityOf(world, 'lanport');
    const jobsBefore = city.publicSector.jobs;
    const baselineEmployees = city.publicSector.employees;
    expect(startPolicy(world, city.id, 'publicJobs', DEMO_CONFIG).ok).toBe(true);
    reconcileLabor(world, DEMO_CONFIG, []);
    const policy = activePolicy(world, city.id, 'publicJobs')!;
    const created = policy.effects.jobsCreated!;
    const filledEmployees = city.publicSector.employees;
    expect(filledEmployees).toBe(baselineEmployees + created);
    expect(checkInvariants(world)).toEqual([]);
    const populationAfterFill = { ...city.population };

    const result = cancelPolicy(world, city.id, 'publicJobs');
    expect(result.ok).toBe(true);
    expect(result.note).toContain('撤回公共岗位');
    expect(city.publicSector.jobs).toBe(jobsBefore);
    expect(city.publicSector.employees).toBe(Math.min(filledEmployees, jobsBefore));
    expect(city.publicSector.employees).toBeLessThanOrEqual(city.publicSector.jobs);
    expect(world.policies.history.at(-1)!.status).toBe('cancelled');
    expect(policy.effects.jobsRemoved).toBe(created);
    const releasedEmployees = filledEmployees - city.publicSector.employees;
    expect(releasedEmployees).toBe(created);
    expect(policy.effects.employeesRemoved).toBe(releasedEmployees);
    expect(city.population.employed).toBe(populationAfterFill.employed - releasedEmployees);
    expect(city.population.unemployed).toBe(populationAfterFill.unemployed + releasedEmployees);
    expect(policy.tracking?.publicWorksJobs).toBe(created);
    expect(policy.tracking?.publicWorksFunding).toContain('publicWages');
    expect(checkInvariants(world)).toEqual([]);
  });

  it('未填岗时取消公共岗位：在岗人数不变、不变量仍然为空', () => {
    const world = richWorld();
    const city = cityOf(world, 'greenfield');
    const jobsBefore = city.publicSector.jobs;
    const employeesBefore = city.publicSector.employees;
    const populationBefore = { ...city.population };
    expect(startPolicy(world, city.id, 'publicJobs', DEMO_CONFIG).ok).toBe(true);
    const policy = activePolicy(world, city.id, 'publicJobs')!;
    const created = policy.effects.jobsCreated!;
    expect(checkInvariants(world)).toEqual([]);

    expect(cancelPolicy(world, city.id, 'publicJobs').ok).toBe(true);
    expect(city.publicSector.jobs).toBe(jobsBefore);
    expect(city.publicSector.employees).toBe(employeesBefore);
    expect(policy.effects.jobsRemoved).toBe(created);
    expect(policy.effects.employeesRemoved).toBeUndefined();
    expect(city.population).toEqual(populationBefore);
    expect(checkInvariants(world)).toEqual([]);
  });

  it('失业救助记录理论需求/实发/未支付；未支付部分不计入居民收入', () => {
    const world = richWorld();
    const city = cityOf(world, 'greenfield');
    expect(startPolicy(world, city.id, 'unemploymentAid', DEMO_CONFIG).ok).toBe(true);
    const policy = activePolicy(world, city.id, 'unemploymentAid')!;
    // 财政被其他支出耗尽：只能发一小部分，剩余记为未支付。
    city.treasury = 1_000;
    const incomeBefore = city.householdIncomeLastMonth;
    const benefitsBefore = city.lastMonth.benefitsPaid;
    const ledgerBefore = world.fiscal.ledger.length;
    settlePolicies(world, DEMO_CONFIG, { hiresByCompany: {}, log: [] });

    const run = lastRun(policy);
    const theoreticalNeed = round2(
      city.population.unemployed * DEMO_CONFIG.policies.unemploymentAid.extraPerUnemployed,
    );
    const paid = 1_000;
    expect(run.theoreticalNeed).toBeCloseTo(theoreticalNeed, 6);
    expect(run.paid).toBe(paid);
    expect(run.unpaid).toBeCloseTo(theoreticalNeed - paid, 6);
    expect(run.spent).toBe(paid);
    expect(run.fiscalImpact).toBe(-paid);
    expect(city.treasury).toBe(0);
    // 只有实发进入居民收入与福利支出。
    expect(city.householdIncomeLastMonth - incomeBefore).toBeCloseTo(paid, 6);
    expect(city.lastMonth.benefitsPaid - benefitsBefore).toBeCloseTo(paid, 6);
    expect(city.householdIncomeLastMonth - incomeBefore).not.toBeCloseTo(theoreticalNeed, 0);
    const spending = world.fiscal.ledger.slice(ledgerBefore).filter(
      (entry) => entry.cityId === city.id && entry.kind === 'policySpending',
    );
    expect(spending).toHaveLength(1);
    expect(spending[0]!.amount).toBe(-paid);
    expect(run.note).toContain('未支付部分不计入居民收入');
  });
});

// ---------------------------------------------------------------- §五（三）（四）低效停止 / 玩家市长 / 执行记录

describe('v1.4 §五（三）（四）低效停止、玩家市长边界与执行记录守恒', () => {
  it('连续 2 个月有支出但无受益/无就业效果 → 自动停止并留痕', () => {
    const world = richWorld();
    const city = cityOf(world, 'lanport');
    // 只留 1 名在岗员工；每次财政仅剩 100，补贴不足以覆盖任何岗位 → 有支出、无受益。
    const company = world.companies.find(
      (entry) => entry.cityId === city.id && entry.employees > 0,
    )!;
    setCompanyEmployees(company, 1);
    company.jobDemand = 1;
    expect(startPolicy(world, city.id, 'retentionSubsidy', DEMO_CONFIG).ok).toBe(true);
    const policy = activePolicy(world, city.id, 'retentionSubsidy')!;
    const startTick = world.time.tick;
    const log: LogEntry[] = [];

    for (let month = 1; month <= 2; month += 1) {
      city.treasury = 100;
      world.time.tick = startTick + month;
      settlePolicies(world, DEMO_CONFIG, { hiresByCompany: {}, log });
    }

    expect(activePolicy(world, city.id, 'retentionSubsidy')).toBeUndefined();
    expect(world.policies.history.at(-1)!.status).toBe('cancelled');
    const runs = policy.tracking!.runs;
    expect(runs).toHaveLength(2);
    expect(runs[0]!.spent).toBe(100);
    expect(runs[1]!.spent).toBe(100);
    expect(runs[0]!.beneficiaries).toBe(0);
    expect(runs[1]!.beneficiaries).toBe(0);
    expect(runs[0]!.jobsEffect).toBe(0);
    expect(runs[1]!.jobsEffect).toBe(0);
    expect(
      log.some((entry) => entry.message.includes('无受益/无就业效果') && entry.message.includes('已停止')),
    ).toBe(true);
    const spending = world.fiscal.ledger.filter(
      (entry) => entry.cityId === city.id && entry.kind === 'policySpending',
    );
    expect(spending).toHaveLength(2);
    expect(spending.reduce((sum, entry) => sum + entry.amount, 0)).toBe(-200);
  });

  it('玩家市长：AI 不代选政策，也不代发债（非玩家政府仍可发债）', () => {
    const world = richWorld();
    const playerCity = cityOf(world, 'lanport');
    appointPlayerMayor(world, playerCity.id);

    // 让城市处于高失业危机档，确认 AI 不是因为“没有症状”才不选。
    primeCheckups(world, playerCity, 0.9, 3);
    world.time.tick += 1;
    setUnemploymentRate(playerCity, 0.9);
    autoSelectPolicies(world, DEMO_CONFIG, []);
    expect(world.policies.active.filter((entry) => entry.cityId === playerCity.id)).toHaveLength(0);
    const selection = world.policies.lastSelection.find((entry) => entry.cityId === playerCity.id)!;
    expect(selection.policyId).toBeNull();
    expect(selection.reason).toContain('玩家市长');

    // 发债同样是玩家决策：AI 政府已启用、财政已低于触发线，仍不得代发。
    expect(DEMO_CONFIG.government.aiGovernment.enabled).toBe(true);
    playerCity.treasury = 0;
    playerCity.fiscalExpenseBaseline = 1_000_000;
    const playerLog: LogEntry[] = [];
    const playerIssue = maybeAutoIssueGovernmentBond(world, playerCity, DEMO_CONFIG, world.time.tick, playerLog);
    expect(playerIssue.issued).toBe(false);
    expect(world.bonds!.issuances.filter((issuance) => issuance.cityId === playerCity.id)).toHaveLength(0);

    // 正向对照：同一规则下非玩家城市照常发债（说明上面的 false 来自玩家市长边界）。
    const aiCity = cityOf(world, 'greenfield');
    aiCity.treasury = 0;
    aiCity.fiscalExpenseBaseline = 1_000_000;
    const aiLog: LogEntry[] = [];
    const aiIssue = maybeAutoIssueGovernmentBond(world, aiCity, DEMO_CONFIG, world.time.tick, aiLog);
    expect(aiIssue.issued).toBe(true);
    expect(world.bonds!.issuances.filter((issuance) => issuance.cityId === aiCity.id).length).toBeGreaterThan(0);
  });

  it('AI 高失业决策真实启动对症政策：原因/预算/支出/执行记录可追溯', () => {
    const world = richWorld();
    const city = cityOf(world);
    primeCheckups(world, city, 0.9, 3);
    neutralizeCheckupInputs(world, city);
    // 居民买不起基本食品：有效需求 800 < 基本需要 1000（资金约束），市场台账不参与判定。
    setGroupConsumption(world, city, { needUnits: 1_000, effectiveUnits: 800, soldUnits: 800, unmetFunding: 0 });
    world.time.tick += 1;
    setUnemploymentRate(city, 0.9);
    const log: LogEntry[] = [];
    autoSelectPolicies(world, DEMO_CONFIG, log);

    const selection = world.policies.lastSelection.find((entry) => entry.cityId === city.id)!;
    expect(selection.policyId).toBe('unemploymentAid');
    expect(selection.reason).toContain('AI 高失业决策');
    const policy = activePolicy(world, city.id, 'unemploymentAid')!;
    expect(policy.reason).toContain('AI 高失业决策');
    const checkup = latestCheckup(world, city.id)!;
    // v1.5 §4：referenceBudget 是“单月参考预算”（= 本月动态预算，远大于旧固定默认 500k）；
    // policy.budget 是展开后的总预算（单月 × 剩余月数），供支出≤预算不变量使用。
    expect(policy.referenceBudget).toBe(checkup.budget);
    expect(policy.referenceBudget).toBeGreaterThan(DEMO_CONFIG.policies.budgets.unemploymentAid);
    expect(policy.budget).toBe(round2(checkup.budget * (policy.monthsRemaining + 1)));
    expect(
      log.some((entry) => entry.message.includes('AI 高失业决策') && entry.message.includes('启动失业救助')),
    ).toBe(true);

    const treasuryBefore = city.treasury;
    settlePolicies(world, DEMO_CONFIG, { hiresByCompany: {}, log });
    expect(policy.spent).toBeGreaterThan(0);
    expect(city.treasury).toBeLessThan(treasuryBefore);
    const run = lastRun(policy);
    expect(run.spent).toBe(policy.spent);
    expect(run.beneficiaries).toBeGreaterThan(0);
    expect(run.jobsEffect).toBe(0);
    expect(run.fiscalImpact).toBe(-policy.spent);
  });

  it('执行记录守恒：spent ≤ 预算、财政影响 = 负支出、就业效果 = 真实新增', () => {
    const world = richWorld();
    const city = cityOf(world, 'lanport');
    for (const company of world.companies) {
      if (company.cityId === city.id) company.jobDemand = company.employees;
    }
    const company = world.companies.find((entry) => entry.id === 'lp-food')!;
    const baseline = company.employees;

    expect(startPolicy(world, city.id, 'hiringSubsidy', DEMO_CONFIG).ok).toBe(true);
    expect(startPolicy(world, city.id, 'unemploymentAid', DEMO_CONFIG).ok).toBe(true);
    company.jobDemand = baseline + 7;
    const labor = reconcileLabor(world, DEMO_CONFIG, []);
    expect(labor.hiresByCompany[company.id]).toBe(7);

    const spentBefore = new Map(
      world.policies.active
        .filter((policy) => policy.cityId === city.id)
        .map((policy) => [policy.id, policy.spent] as const),
    );
    world.time.tick += 1;
    settlePolicies(world, DEMO_CONFIG, { hiresByCompany: labor.hiresByCompany, log: [] });

    const policies = world.policies.active.filter((policy) => policy.cityId === city.id);
    expect(policies).toHaveLength(2);
    let totalSpent = 0;
    for (const policy of policies) {
      const run = lastRun(policy);
      const expectedDelta = round2(policy.spent - (spentBefore.get(policy.id) ?? 0));
      totalSpent = round2(totalSpent + policy.spent);
      expect(run.tick).toBe(world.time.tick);
      expect(run.periodMonths).toBe(1);
      expect(run.fundingSource.length).toBeGreaterThan(0);
      expect(run.spent).toBe(expectedDelta);
      expect(run.spent).toBeGreaterThanOrEqual(0);
      expect(run.fiscalImpact).toBe(-run.spent);
      expect(run.beneficiaries).toBeGreaterThanOrEqual(0);
      expect(policy.spent).toBeLessThanOrEqual(policy.budget);
      expect(policy.tracking!.runs.length).toBeLessThanOrEqual(24);
    }
    // 招聘补贴的就业效果与真实在岗新增完全一致；救助不虚构岗位。
    const hiring = policies.find((policy) => policy.policyId === 'hiringSubsidy')!;
    const hiringRun = lastRun(hiring);
    expect(hiringRun.jobsEffect).toBe(7);
    expect(company.employees - baseline).toBe(7);
    expect(hiringRun.beneficiaries).toBe(7);
    const aid = policies.find((policy) => policy.policyId === 'unemploymentAid')!;
    const aidRun = lastRun(aid);
    expect(aidRun.jobsEffect).toBe(0);
    expect(aidRun.theoreticalNeed).toBeGreaterThan(aidRun.paid!);
    expect(aidRun.unpaid).toBeCloseTo(aidRun.theoreticalNeed! - aidRun.paid!, 6);

    // 财政流水：每笔实际政策支出都进账本，合计与政策 spent 一致。
    const spending = world.fiscal.ledger.filter(
      (entry) => entry.cityId === city.id && entry.kind === 'policySpending' && entry.tick === world.time.tick,
    );
    expect(spending.length).toBeGreaterThan(0);
    expect(spending.reduce((sum, entry) => sum + Math.abs(entry.amount), 0)).toBeCloseTo(totalSpent, 2);
    expect(checkInvariants(world)).toEqual([]);
  });
});

// ---------------------------------------------------------------- 真实模拟 3 个月：症状不再为空

describe('v1.4 §五 真实模拟前 3 个月：体检逐月落盘、症状非空、预算随档位变化', () => {
  it('t1/t2/t3 每月都有真实体检；高失业不再报告“无明显症状”', () => {
    const simulation = Simulation.create();
    const world = simulation.state;
    const observed: EconomicCheckup[][] = [];
    // lifecycle 历史有保留上限（新创办会挤掉旧记录），因此在体检发生前的时刻截取真实计数。
    let foundedAtTick2 = 0;
    for (let month = 1; month <= 3; month += 1) {
      simulation.tick();
      const tick = world.time.tick;
      if (tick === 2) {
        foundedAtTick2 = world.lifecycle.foundings.filter((entry) => entry.tick === 2).length;
      }
      const checkups = (world.policies.checkups ?? []).filter((entry) => entry.tick === tick);
      expect(checkups).toHaveLength(world.cities.length);
      observed.push(checkups);
    }

    for (const checkup of observed.flat()) {
      // 开局失业率远高于 35%，体检必须报告真实高失业症状，而不是空数组。
      expect(checkup.unemploymentRateAvg3).toBeGreaterThan(AI_LABOR.tierCrisisAt);
      expect(checkup.symptoms.length).toBeGreaterThan(0);
      expect(checkup.symptoms.some((symptom) => symptom.includes('高失业'))).toBe(true);
      expect(checkup.rawTier).toBe('crisis');
      expect(checkup.budget).toBeGreaterThanOrEqual(AI_LABOR.budgetFloor);
    }

    // 档位按真实规则升级：t1 开局保护 normal → t2 最多承压 → t3 确认危机；
    // 预算比例随之 5% → 8% → 15%。
    for (let index = 0; index < observed.length; index += 1) {
      for (const checkup of observed[index]!) {
        expect(checkup.tier).toBe(['normal', 'strained', 'crisis'][index]);
        expect(checkup.budgetShare).toBe(
          [AI_LABOR.budgetTierShares.normal, AI_LABOR.budgetTierShares.strained, AI_LABOR.budgetTierShares.crisis][
            index
          ],
        );
        // 真实税收月数逐月增加，估算月数相应减少，二者合计恒为 12。
        expect(checkup.taxMonthsReal + checkup.taxMonthsEstimated).toBe(12);
      }
    }
    expect(observed[0]![0]!.taxMonthsReal).toBe(0);
    expect(observed[1]![0]!.taxMonthsReal).toBe(1);
    expect(observed[2]![0]!.taxMonthsReal).toBe(2);
    expect(observed[2]![0]!.taxMonthsEstimated).toBe(10);

    // founded 来自真实生命周期记录（同一窗口），不是硬编码 0。
    const reportedFounded = observed[2]!.reduce((sum, checkup) => sum + checkup.founded, 0);
    expect(reportedFounded).toBe(foundedAtTick2);
    expect(reportedFounded).toBeGreaterThan(0);

    // 危机档下 AI 真实启动了对症政策，且预算来自本月体检预算上限。
    for (const checkup of observed[2]!) {
      const aiPolicy = world.policies.active.find(
        (policy) => policy.cityId === checkup.cityId && policy.reason.includes('AI 高失业决策'),
      );
      expect(aiPolicy).toBeDefined();
      // v1.5 §4（task-18）：政策可能是本月或更早用“先立项后融资”启动的，
      // 其单月参考预算来自当次体检，不应与本月体检预算强行相等；但必须真实存在且总预算≥单月。
      expect(aiPolicy!.referenceBudget).toBeGreaterThan(0);
      expect(aiPolicy!.budget).toBeGreaterThanOrEqual(aiPolicy!.referenceBudget!);
    }
    expect(checkInvariants(world)).toEqual([]);
  });
});

// ---------------------------------------------------------------- §五（一）技能/创办关闭观测

describe('v1.4 §五（一）生命周期观测：创办/关闭按上一 tick 真实统计', () => {
  it('体检的 founded/closed 来自 lifecycle 真实记录（窗口统计，不是全期累计）', () => {
    const world = richWorld();
    const city = cityOf(world, 'greenfield');
    const group = world.investors.find((entry) => entry.cityId === city.id && entry.cash > 0)!;
    group.cash = 5_000_000;
    world.time.tick = 1;
    const founded = foundCompany(
      world,
      { cityId: city.id, founderType: 'investorGroup', founderId: group.id, capital: 300_000 },
      DEMO_CONFIG,
    );
    expect(founded.ok, founded.error).toBe(true);
    const victim = world.companies.find(
      (entry) => entry.cityId === city.id && entry.id !== founded.companyId,
    )!;
    const liquidation = liquidateCompany(world, victim.id, DEMO_CONFIG, '测试：真实清算记录', []);
    expect(liquidation.ok, liquidation.error).toBe(true);
    expect(world.lifecycle.foundings.filter((entry) => entry.cityId === city.id)).toHaveLength(1);
    expect(world.lifecycle.liquidations.filter((entry) => entry.cityId === city.id)).toHaveLength(1);

    // 体检在 tick 2 统计 tick 1 的创办/关闭（上一完整月）。
    world.time.tick = 2;
    const checkup = runCityEconomicCheckup(world, city, DEMO_CONFIG);
    expect(checkup.founded).toBe(1);
    expect(checkup.closed).toBe(1);

    // 再下一个月没有新的创办/关闭 → 窗口内为 0（证明不是全期累计）。
    world.time.tick = 3;
    const next = runCityEconomicCheckup(world, city, DEMO_CONFIG);
    expect(next.founded).toBe(0);
    expect(next.closed).toBe(0);
  });
});

// ---------------------------------------------------------------- 边界：关档但真实就业仍可增长

// ---------------------------------------------------------------- v1.5 §4：体检消费口径

describe('v1.5 §4 体检消费口径：使用居民群体六项，不用市场台账', () => {
  it('有效需求/成交/资金缺口/缺货缺口来自 Σ group.lastMonth，市场台账不参与分类', () => {
    const world = richWorld();
    const city = cityOf(world);
    // 市场台账故意给“缺货/资金缺口”，但居民群体统计显示无缺口 → 不能误报。
    city.market.food.unmetDemand = 99_999;
    city.market.food.unmetFunding = 88_888;
    city.market.food.price = 50;
    setGroupConsumption(world, city, {
      needUnits: 10_000,
      effectiveUnits: 10_000,
      soldUnits: 10_000,
      unmetFunding: 0,
      supplyShortfallUnits: 0,
    });
    const ok = runCityEconomicCheckup(world, city, DEMO_CONFIG);
    expect(ok.foodDemand).toBe(10_000);
    expect(ok.foodUnmetDemand).toBe(0);
    expect(ok.foodUnmetFunding).toBe(0);
    expect(ok.fundingGap).toBe(false);
    expect(ok.supplyGap).toBe(false);
    expect(ok.symptoms).not.toContain('买不起但有供给');
    expect(ok.symptoms).not.toContain('有购买力但缺货');
    expect(ok.note).toContain('居民基本食品');

    // 真实居民资金缺口：需要 10000、有效需求 8000（预算约束 2000 件没形成有效需求）。
    world.time.tick += 1;
    setGroupConsumption(world, city, {
      needUnits: 10_000,
      effectiveUnits: 8_000,
      soldUnits: 8_000,
      unmetFunding: 500,
      supplyShortfallUnits: 0,
    });
    const funding = runCityEconomicCheckup(world, city, DEMO_CONFIG);
    expect(funding.foodDemand).toBe(10_000);
    expect(funding.foodUnmetDemand).toBe(0);
    expect(funding.foodUnmetFunding).toBe(500);
    expect(funding.fundingGap).toBe(true);
    expect(funding.supplyGap).toBe(false);
    expect(funding.symptoms).toContain('买不起但有供给');

    // 真实缺货：有效需求 10000、成交 7000（缺货 3000 件）。
    world.time.tick += 1;
    setGroupConsumption(world, city, {
      needUnits: 10_000,
      effectiveUnits: 10_000,
      soldUnits: 7_000,
      unmetFunding: 0,
      supplyShortfallUnits: 3_000,
    });
    const supply = runCityEconomicCheckup(world, city, DEMO_CONFIG);
    expect(supply.foodUnmetDemand).toBe(3_000);
    expect(supply.foodUnmetFunding).toBe(0);
    expect(supply.fundingGap).toBe(false);
    expect(supply.supplyGap).toBe(true);
    expect(supply.symptoms).toContain('有购买力但缺货');
    expect(supply.symptoms).not.toContain('买不起但有供给');
  });

  it('旧存档缺居民消费统计时回退本地市场台账并在 note 标注', () => {
    const world = richWorld();
    const city = cityOf(world);
    for (const group of world.households.groups.filter((entry) => entry.cityId === city.id)) {
      const stats = group.lastMonth as unknown as Record<string, unknown>;
      delete stats.basicNeedUnits;
      delete stats.basicEffectiveUnits;
      delete stats.basicSoldUnits;
      delete stats.unmetFunding;
      delete stats.supplyShortfallUnits;
    }
    city.market.food.unmetDemand = 1_234;
    const checkup = runCityEconomicCheckup(world, city, DEMO_CONFIG);
    expect(checkup.note).toContain('回退本地市场台账');
    expect(checkup.foodUnmetDemand).toBe(1_234);
  });
});

describe('v1.4 §五 边界：症状字段与档位解耦，不因迟滞丢失真实观测', () => {
  it('10%–20% 承压档在体检中始终带着高失业症状，且预算比例在区间内', () => {
    const world = richWorld();
    const city = cityOf(world);
    const checkup = primeCheckups(world, city, 0.15, 3);
    expect(checkup.tier).toBe('strained');
    expect(checkup.rawTier).toBe('strained');
    expect(checkup.symptoms.some((symptom) => symptom.includes('高失业'))).toBe(true);
    expect(checkup.budgetShare).toBe(AI_LABOR.budgetTierShares.strained);
    expect(checkup.budgetShare).toBeGreaterThanOrEqual(AI_LABOR.budgetTaxRevenueMinShare);
    expect(checkup.budgetShare).toBeLessThanOrEqual(AI_LABOR.budgetTaxRevenueMaxShare);
  });
});
