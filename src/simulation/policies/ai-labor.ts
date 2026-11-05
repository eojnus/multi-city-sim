import type { DemoConfig } from '../../data/config';
import { GOODS } from '../../data/demo-data';
import type {
  City,
  EconomicCheckup,
  PolicyId,
  UnemploymentTier,
  WorldState,
} from '../contracts/types';
import { clamp, round2 } from '../core/math';
import { cityDebt, recent12MonthGdp } from '../government/metrics';
import { activePolicy } from './query';

/**
 * v1.4 §五：AI 政府高失业决策。
 *
 * 本模块只做三件事，且全部基于可核验的真实状态（不做虚构支出/成交/岗位）：
 * 1. 每月经济体检：失业率 3 月均值与趋势、居民收入/食品需求与购买力、食品产能/产出/库存、
 *    招聘/裁员、财政税收（区分真实与估算）、债务与到期压力，并按档位分级（带迟滞）；
 * 2. 对症诊断：区分“买不起但有供给”“有购买力但缺货”“有岗位但招聘受阻”“技能错配”；
 * 3. 动态预算：以近 12 个月平均月税收的 5%–15% 为参考，结合档位、财政与债务/GDP 预警，
 *    给出本月可执行的预算上限（实际支出仍由各政策按真实事件发生额记账）。
 */

const TIER_ORDER: UnemploymentTier[] = ['normal', 'strained', 'severe', 'crisis'];

function tierIndex(tier: UnemploymentTier): number {
  return TIER_ORDER.indexOf(tier);
}

function tierAt(index: number): UnemploymentTier {
  return TIER_ORDER[clamp(Math.round(index), 0, TIER_ORDER.length - 1)] as UnemploymentTier;
}

/** 按 3 个月均值失业率得到原始档位（不含迟滞/开局限制）。 */
export function rawUnemploymentTier(rate: number, config: DemoConfig): UnemploymentTier {
  const ai = config.policies.aiLabor;
  // 阈值语义（v1.4 §五）：<10% 正常；10%–20% 承压；20%–35% 严重；>35% 危机。
  // 10%/20%/35% 归入更高的档位，35% 本身仍算“严重”，只有超过 35% 才是危机。
  if (rate > ai.tierCrisisAt) return 'crisis';
  if (rate >= ai.tierSevereAt) return 'severe';
  if (rate >= ai.tierStrainedAt) return 'strained';
  return 'normal';
}

export function unemploymentTierLabel(tier: UnemploymentTier): string {
  switch (tier) {
    case 'normal':
      return '正常';
    case 'strained':
      return '承压';
    case 'severe':
      return '严重';
    case 'crisis':
      return '危机';
  }
}

function checkupsOf(world: WorldState, cityId: string): EconomicCheckup[] {
  return (world.policies.checkups ?? [])
    .filter((entry) => entry.cityId === cityId)
    .sort((a, b) => a.tick - b.tick);
}

/** 最近一次（可限定 tick 之前）经济体检；没有则返回 null。 */
export function latestCheckup(
  world: WorldState,
  cityId: string,
  beforeTick?: number,
): EconomicCheckup | null {
  const list = checkupsOf(world, cityId);
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const entry = list[index]!;
    if (beforeTick === undefined || entry.tick < beforeTick) return entry;
  }
  return null;
}

/**
 * 分级迟滞：升级需连续 tierConfirmMonths 个月原始档位不低于目标档位；
 * 降级需连续 tierDeescalateMonths 个月不高于目标档位；否则维持上一档。
 */
function applyTierHysteresis(
  rawTier: UnemploymentTier,
  history: EconomicCheckup[],
  config: DemoConfig,
): UnemploymentTier {
  const ai = config.policies.aiLabor;
  const previous = history.length > 0 ? history[history.length - 1]!.tier : 'normal';
  if (rawTier === previous) return previous;
  const rising = tierIndex(rawTier) > tierIndex(previous);
  const needed = Math.max(1, Math.round(rising ? ai.tierConfirmMonths : ai.tierDeescalateMonths));
  const recent = [...history.slice(-(needed - 1)).map((entry) => entry.rawTier), rawTier];
  if (recent.length < needed) return previous;
  const confirmed = rising
    ? recent.every((tier) => tierIndex(tier) >= tierIndex(rawTier))
    : recent.every((tier) => tierIndex(tier) <= tierIndex(rawTier));
  return confirmed ? rawTier : previous;
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * 按“上一次体检 tick（含）到本次体检 tick（不含）”统计生命周期记录。
 *
 * 体检在当月结算开始前运行，所以这个窗口正好是上一完整月（正常每月体检测每月一条）。
 * lifecycle 历史有保留上限，因此只做窗口统计，不能用全期累计。
 */
function countLifecycleBetween<T extends { tick: number; cityId: string }>(
  records: readonly T[] | undefined,
  cityId: string,
  previous: EconomicCheckup | null,
  tick: number,
): number {
  if (!records || records.length === 0) return 0;
  const start = previous ? previous.tick : tick - 1;
  let count = 0;
  for (const record of records) {
    if (record.cityId === cityId && record.tick >= start && record.tick < tick) count += 1;
  }
  return count;
}

function foodGood() {
  return GOODS.find((good) => good.id === 'food');
}

/** 公共部门岗位空缺（有岗位但未招满）。 */
function publicVacancies(city: City): number {
  return Math.max(0, city.publicSector.jobs - city.publicSector.employees);
}

function companyVacancies(world: WorldState, cityId: string): number {
  let total = 0;
  for (const company of world.companies) {
    if (company.cityId !== cityId) continue;
    total += Math.max(0, company.jobDemand - company.employees);
  }
  return Math.round(total);
}

/** 近 12 个月真实税收（按 tick 升序，最多 12 条，且不含本月）。 */
function recentTaxMonths(world: WorldState, cityId: string, tick: number) {
  const history = world.taxes?.historyByCity?.[cityId] ?? [];
  return history
    .filter((entry) => entry.tick < tick)
    .sort((a, b) => a.tick - b.tick)
    .slice(-12);
}

/**
 * 动态月预算：近 12 个月平均月税收 × 档位比例，限制在 5%–15% 区间内；
 * 不足 12 个月时用近 12 个月 GDP 估算补齐并记录估算月数；
 * 债务/GDP ≥ 预警线时预算按比例缩减（不是破产线）。
 */
export function aiLaborBudget(
  world: WorldState,
  city: City,
  tier: UnemploymentTier,
  config: DemoConfig,
): { budget: number; share: number; note: string; realMonths: number; estimatedMonths: number; realAvg: number; estimatedMonthly: number } {
  const ai = config.policies.aiLabor;
  const tick = world.time.tick;
  const months = recentTaxMonths(world, city.id, tick);
  const realMonths = months.length;
  const realTotal = months.reduce((sum, entry) => sum + Math.max(0, entry.totalRevenue ?? 0), 0);
  const realAvg = realMonths > 0 ? realTotal / realMonths : 0;
  const estimatedMonths = Math.max(0, 12 - realMonths);
  const gdpWindow = recent12MonthGdp(world, city.id, config);
  const monthlyGdp = gdpWindow.months > 0 ? gdpWindow.sum / gdpWindow.months : Math.max(1, city.gdp);
  const estimatedMonthly = round2(monthlyGdp * ai.budgetEstimateGdpTaxBaseShare);
  const blended = (realTotal + estimatedMonthly * estimatedMonths) / 12;
  const tierShare = ai.budgetTierShares[tier] ?? ai.budgetTaxRevenueMinShare;
  const share = clamp(tierShare, ai.budgetTaxRevenueMinShare, ai.budgetTaxRevenueMaxShare);
  let budget = round2(clamp(blended * share, ai.budgetFloor, ai.budgetCap));
  let note = `预算参考：近 12 月平均月税收 ${blended.toFixed(0)}（真实 ${realMonths} 月 + 估算 ${estimatedMonths} 月）× ${(share * 100).toFixed(0)}%`;
  if (city.lastMonth.publicWageBill > 0) {
    const reserve = round2(city.lastMonth.publicWageBill * config.policies.aiReserveWageMonths);
    const available = round2(Math.max(0, city.treasury - reserve));
    if (budget > available) {
      budget = round2(Math.max(0, available));
      note += `；受可用财政（预留公共工资后 ${available.toFixed(0)}）限制`;
    }
  }
  const debt = cityDebt(world, city.id);
  const risk = city.government?.lastDebt;
  const debtRatio = risk?.debtRatio ?? (debt.totalDebt > 0 ? debt.totalDebt / Math.max(1, gdpWindow.sum) : 0);
  if (debtRatio >= ai.debtWarningRatio) {
    budget = round2(budget * ai.debtWarningBudgetShare);
    note += `；债务/GDP ${(debtRatio * 100).toFixed(1)}% ≥ 预警线 ${(ai.debtWarningRatio * 100).toFixed(0)}%，预算缩减 ${((1 - ai.debtWarningBudgetShare) * 100).toFixed(0)}%`;
  }
  return { budget, share, note, realMonths, estimatedMonths, realAvg, estimatedMonthly };
}

/** 到期压力：本月需支付的债券本息与政府贷款分期（只统计真实存在的合同）。 */
function debtDueThisMonth(world: WorldState, city: City, tick: number): { bondDue: number; loanDue: number } {
  let bondDue = 0;
  for (const issuance of world.bonds?.issuances ?? []) {
    if (issuance.cityId !== city.id || issuance.status !== 'active') continue;
    if (issuance.maturityTick > tick + 1) continue;
    bondDue = round2(bondDue + Math.max(0, issuance.principal) + Math.max(0, issuance.arrearsInterest));
  }
  let loanDue = 0;
  for (const loan of city.government?.loans ?? []) {
    if (loan.status !== 'active' || loan.nextDueTick > tick + 1) continue;
    const outstanding = Math.max(0, loan.outstanding);
    const periodNumber = loan.nextDueTick - loan.startTick;
    const scheduled = periodNumber >= loan.termMonths ? outstanding : Math.min(loan.monthlyPrincipal, outstanding);
    const collectible = Math.min(outstanding, Math.max(0, loan.arrearsPrincipal) + scheduled);
    loanDue = round2(
      loanDue +
        Math.max(0, loan.arrearsInterest) +
        outstanding * loan.rateMonthly +
        collectible,
    );
  }
  return { bondDue, loanDue };
}

/** 计算并写入一城本月经济体检快照（同一 tick 幂等）。 */
export function runCityEconomicCheckup(
  world: WorldState,
  city: City,
  config: DemoConfig,
): EconomicCheckup {
  world.policies.checkups ??= [];
  const tick = world.time.tick;
  const existing = (world.policies.checkups ?? []).find(
    (entry) => entry.cityId === city.id && entry.tick === tick,
  );
  if (existing) return existing;

  const ai = config.policies.aiLabor;
  const history = checkupsOf(world, city.id);
  const population = city.population;
  const laborForce = Math.max(0, population.laborForce);
  const unemploymentRate = laborForce > 0 ? round2(population.unemployed / laborForce) : 0;
  const recentRates = [...history.slice(-(ai.trendMonths - 1)).map((entry) => entry.unemploymentRate), unemploymentRate];
  const unemploymentRateAvg3 = round2(average(recentRates));
  const earlierRates = history.slice(-ai.trendMonths * 2, -ai.trendMonths).map((entry) => entry.unemploymentRate);
  const earlierAvg = earlierRates.length > 0 ? average(earlierRates) : unemploymentRateAvg3;
  const unemploymentTrend = round2(unemploymentRateAvg3 - earlierAvg);

  const rawTier = rawUnemploymentTier(unemploymentRateAvg3, config);
  let tier = applyTierHysteresis(rawTier, history, config);
  // 开局不足 earlyMonthsCap 个月：样本过少，最多判为 earlyTierCap，避免一开局就饱和。
  const checkupCount = history.length + 1;
  if (checkupCount < ai.earlyMonthsCap && tierIndex(tier) > tierIndex(ai.earlyTierCap)) {
    tier = ai.earlyTierCap;
  }

  const previous = history.length > 0 ? history[history.length - 1]! : null;
  const hires = previous ? Math.max(0, population.employed - previous.employed) : 0;
  const layoffs = previous ? Math.max(0, previous.employed - population.employed) : 0;
  // 上一 tick 的真实创办/倒闭数（不是全期累计；lifecycle 记录有保留上限）。
  const founded = countLifecycleBetween(world.lifecycle?.foundings, city.id, previous, tick);
  const closed = countLifecycleBetween(world.lifecycle?.liquidations, city.id, previous, tick);

  const food = foodGood();
  const foodNeed = food?.perCapitaMonthlyNeed ?? 0;
  const foodMarket = city.market.food;
  const foodDemand = round2(Math.max(0, population.total) * foodNeed);
  const foodPrice = Math.max(0, foodMarket?.price ?? 0);
  const foodInventory = Math.max(0, foodMarket?.closingStock ?? 0);
  const foodUnmetDemand = Math.max(0, foodMarket?.unmetDemand ?? 0);
  const foodUnmetFunding = Math.max(0, foodMarket?.unmetFunding ?? 0);
  const foodCapacity = round2(
    world.companies
      .filter((company) => company.cityId === city.id && company.recipeOutput === 'food')
      .reduce((sum, company) => sum + Math.max(0, company.capacity), 0),
  );
  const foodOutput = round2(
    world.companies
      .filter((company) => company.cityId === city.id && company.recipeOutput === 'food')
      .reduce((sum, company) => sum + Math.max(0, company.lastMonth.produced), 0),
  );
  const coverageMonths = foodDemand > 0 ? foodInventory / foodDemand : 1;
  const consumerBudget = Math.max(0, city.lastMonth.consumerBudget);
  const householdIncome = Math.max(0, city.lastMonth.householdIncome);
  const effectivePurchasingPower = round2(householdIncome);
  const foodCost = round2(foodDemand * foodPrice);
  const fundingGap = foodUnmetFunding > 0 || (consumerBudget < foodCost && coverageMonths >= ai.foodCoverageMonths);
  const supplyGap =
    (foodUnmetDemand > 0 || coverageMonths < ai.foodCoverageMonths || foodCapacity < foodDemand) &&
    consumerBudget >= foodCost;

  const vacancies = companyVacancies(world, city.id) + publicVacancies(city);
  const hiringBlocked =
    vacancies > 0 &&
    laborForce > 0 &&
    vacancies / laborForce >= ai.vacancyRateForHiringBlocked &&
    population.unemployed > 0;
  const skillLevel = city.workforce?.skillLevel ?? 0;
  const skillMismatch = hiringBlocked && skillLevel < ai.skillMismatchSkillLevel;

  const tax = recentTaxMonths(world, city.id, tick);
  const budgetInfo = aiLaborBudget(world, city, tier, config);
  const due = debtDueThisMonth(world, city, tick);
  const debt = cityDebt(world, city.id);
  const gdpWindow = recent12MonthGdp(world, city.id, config);
  const debtRatio = round2(
    city.government?.lastDebt?.debtRatio ??
      (debt.totalDebt > 0 ? debt.totalDebt / Math.max(1, gdpWindow.sum) : 0),
  );
  const debtWarning = debtRatio >= ai.debtWarningRatio;
  const necessarySpending = round2(
    Math.max(0, city.lastMonth.publicWageBill) + Math.max(0, city.lastMonth.benefitsPaid),
  );
  const debtServicePressure = round2((due.bondDue + due.loanDue) / Math.max(1, city.treasury));

  const symptoms: string[] = [];
  // 高失业是可观测事实（按真实 3 月均值判定），与用于决策的 tier 分开记录：
  // tier 带迟滞/开局上限，可能仍是 normal，但体检不能因此报告“无明显症状”。
  if (unemploymentRateAvg3 >= ai.tierStrainedAt) {
    symptoms.push(
      `高失业（3 月均值 ${(unemploymentRateAvg3 * 100).toFixed(1)}%，${unemploymentTierLabel(rawTier)}档）`,
    );
  }
  if (fundingGap) symptoms.push('买不起但有供给');
  if (supplyGap) symptoms.push('有购买力但缺货');
  if (hiringBlocked) symptoms.push('有岗位但招聘启动受阻');
  if (skillMismatch) symptoms.push('岗位与技能不匹配');
  if (debtWarning) symptoms.push('债务/GDP 预警');
  if (unemploymentTrend > 0.005) symptoms.push('失业率上升');
  else if (unemploymentTrend < -0.005) symptoms.push('失业率下降');

  const checkup: EconomicCheckup = {
    tick,
    cityId: city.id,
    unemploymentRate,
    unemploymentRateAvg3,
    unemploymentTrend,
    rawTier,
    tier,
    employed: population.employed,
    unemployed: population.unemployed,
    laborForce,
    householdIncome,
    consumerSpend: Math.max(0, city.lastMonth.consumerSpend),
    consumerBudget,
    foodDemand,
    foodUnmetDemand,
    foodUnmetFunding,
    foodInventory,
    foodCapacity,
    foodOutput,
    foodPrice,
    effectivePurchasingPower,
    fundingGap,
    supplyGap,
    vacancies,
    hiringBlocked,
    hires,
    layoffs,
    founded,
    closed,
    treasury: city.treasury,
    monthlyTaxRevenueReal: round2(tax.reduce((sum, entry) => sum + Math.max(0, entry.totalRevenue ?? 0), 0) / Math.max(1, tax.length)),
    monthlyTaxRevenueEstimated: budgetInfo.estimatedMonthly,
    taxMonthsReal: tax.length,
    taxMonthsEstimated: Math.max(0, 12 - tax.length),
    necessarySpending,
    totalDebt: round2(debt.totalDebt),
    gdpWindowSum: round2(gdpWindow.sum),
    gdpWindowMonths: gdpWindow.months,
    debtRatio,
    bondDue: due.bondDue,
    loanDue: due.loanDue,
    debtServicePressure,
    debtWarning,
    budget: budgetInfo.budget,
    budgetShare: budgetInfo.share,
    budgetNote: budgetInfo.note,
    skillLevel,
    skillMismatch,
    symptoms,
    note: `失业率 ${(unemploymentRate * 100).toFixed(1)}%（3 月均值 ${(unemploymentRateAvg3 * 100).toFixed(1)}%，档位 ${unemploymentTierLabel(tier)}）；${
      symptoms.join('、') || '无明显症状'
    }；近 12 月 GDP ${gdpWindow.sum.toFixed(0)}（${gdpWindow.months} 月）。`,
  };
  world.policies.checkups.push(checkup);
  // 保留最近 checkupRetentionMonths 个月（按城）。
  const keep = Math.max(1, Math.round(ai.checkupRetentionMonths));
  const trimmed = checkupsOf(world, city.id).slice(-keep);
  const otherCities = (world.policies.checkups ?? []).filter((entry) => entry.cityId !== city.id);
  world.policies.checkups = [...otherCities, ...trimmed];
  return checkup;
}

/** 为所有城市生成本月体检（幂等；供 tick 与测试直接调用）。 */
export function runEconomicCheckup(world: WorldState, config: DemoConfig): EconomicCheckup[] {
  world.policies.checkups ??= [];
  return [...world.cities]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((city) => runCityEconomicCheckup(world, city, config));
}

/** 确保本月体检已存在（供 autoSelectPolicies 直接调用时补齐）。 */
export function ensureEconomicCheckups(world: WorldState, config: DemoConfig): EconomicCheckup[] {
  return runEconomicCheckup(world, config);
}

export interface LaborPolicyCandidate {
  policyId: PolicyId;
  budget: number;
  reason: string;
}

/**
 * 高失业档位下某项政策的“单月合理需求上限”（v1.4 §五（三））。
 *
 * 动态预算不再被固定小额默认预算封顶：对有真实可计算月需求的措施，按需求封顶
 * （例如救助的理论转移额、公共岗位的全部失业人员安置成本、培训的全部失业人员课时成本、
 * 招聘补贴覆盖当前真实空缺的一次性支出）；事件型政策（设备/创业/跨城贸易）与
 * 产业/纾困类没有自然月需求，单月上限就是本月动态预算本身。
 *
 * 结果始终 ≤ 本月动态预算（available），因此财政压力与债务预警缩减仍然生效。
 */
function monthlyNeedCapForLaborPolicy(
  world: WorldState,
  city: City,
  checkup: EconomicCheckup,
  policyId: PolicyId,
  config: DemoConfig,
  available: number,
): number {
  switch (policyId) {
    case 'unemploymentAid': {
      const need = round2(
        Math.max(0, city.population.unemployed) * config.policies.unemploymentAid.extraPerUnemployed,
      );
      return need > 0 ? Math.min(available, need) : available;
    }
    case 'publicJobs': {
      const wageMonths = Math.max(1, config.policies.publicJobs.wageMonthsReserved);
      const need = round2(
        Math.max(0, city.population.unemployed) * Math.max(0, city.publicSector.wageRate) * wageMonths,
      );
      return need > 0 ? Math.min(available, need) : available;
    }
    case 'vocationalTraining': {
      const need = round2(
        Math.max(0, city.population.unemployed) * Math.max(0, config.policies.training.costPerTrainee),
      );
      return need > 0 ? Math.min(available, need) : available;
    }
    case 'hiringSubsidy': {
      // 一次性补贴：上限 = 当前真实岗位空缺 × 每人补贴（取本城最高工资率作为上限估计）。
      const vacancies = Math.max(0, Math.round(checkup.vacancies));
      if (vacancies <= 0) return available;
      const wageRates = world.companies
        .filter((company) => company.cityId === city.id)
        .map((company) => Math.max(0, company.wageRate));
      const wageRate = Math.max(city.publicSector.wageRate, ...wageRates);
      const perHire = round2(wageRate * config.policies.hiring.subsidyRate);
      return perHire > 0 ? Math.min(available, round2(vacancies * perHire)) : available;
    }
    default:
      // 事件型政策（设备/创业/跨城贸易）与产业扶持/企业纾困：单月上限 = 本月动态预算。
      return available;
  }
}

/**
 * 对症政策排序（只返回可执行的候选；预算不足/高承诺政策在预警时被排除）。
 *
 * 症状 → 政策：
 * - 买不起但有供给：失业救助（真实转移支付，未支付不计收入）→ 公共工程（真实岗位）
 *   → 招聘补贴（只补贴真实净新增岗位）；
 * - 有购买力但缺货：设备与扩产补助 → 重点产业扶持（食品）→ 跨城贸易支持；
 * - 有岗位但招聘启动受阻：技能不匹配时先职业培训（仅当有真实岗位空缺），
 *   否则招聘补贴 / 初创扶持；
 * - 债务/GDP 预警：排除公共工程、住房、重点产业、设备补助等长期高承诺，优先短期见效措施。
 */
export function rankLaborPolicies(
  world: WorldState,
  city: City,
  checkup: EconomicCheckup,
  config: DemoConfig,
): LaborPolicyCandidate[] {
  if (checkup.tier === 'normal') return [];
  const available = Math.max(0, checkup.budget);
  const warning = checkup.debtWarning;
  const longCommitments = new Set<PolicyId>([
    'publicJobs',
    'housingSupport',
    'keyIndustrySupport',
    'equipmentSubsidy',
    'transportInvestment',
  ]);
  const ordered: PolicyId[] = [];
  if (checkup.fundingGap) {
    ordered.push('unemploymentAid', 'publicJobs', 'hiringSubsidy');
  }
  if (checkup.supplyGap) {
    ordered.push('equipmentSubsidy', 'keyIndustrySupport', 'intercityTradeSupport');
  }
  if (checkup.hiringBlocked) {
    if (checkup.skillMismatch) ordered.push('vocationalTraining');
    ordered.push('hiringSubsidy', 'startupSupport');
  }
  if (ordered.length === 0) {
    ordered.push('unemploymentAid', 'hiringSubsidy', 'startupSupport');
  }

  const candidates: LaborPolicyCandidate[] = [];
  const seen = new Set<PolicyId>();
  for (const policyId of ordered) {
    if (seen.has(policyId)) continue;
    seen.add(policyId);
    if (activePolicy(world, city.id, policyId)) continue;
    if (warning && longCommitments.has(policyId)) continue;
    // v1.4 §五（三）：高失业档位用动态预算（本月税收比例 + 债务/GDP 缩减）作为政策预算，
    // 只再受“单月合理需求上限”约束。normal 档在上面的 early return 已排除，
    // 继续由 autoSelectPolicies 走既有弱项打分 + startPolicy 固定默认预算。
    const budget = round2(monthlyNeedCapForLaborPolicy(world, city, checkup, policyId, config, available));
    if (budget < config.policies.minBudget) continue;
    let reason = `${unemploymentTierLabel(checkup.tier)}（3 月均值 ${(checkup.unemploymentRateAvg3 * 100).toFixed(1)}%）`;
    if (checkup.symptoms.length > 0) reason += `；症状：${checkup.symptoms.join('、')}`;
    if (warning) reason += '；债务预警下缩减长期承诺';
    candidates.push({ policyId, budget, reason });
  }
  // 预算不足以支撑任何政策时返回空列表（由调用方记录原因，不虚构政策）。
  return candidates;
}
