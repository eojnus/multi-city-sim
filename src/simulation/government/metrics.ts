/**
 * 财政与 GDP 公共口径函数（v0.7 契约层，v1.4 #36 冻结）。
 *
 * 报告脚本、模拟、界面必须调用本文件的三个函数，禁止各线各写一套口径：
 * - `cityDebt(world, cityId)`：总负债五段拆分与合计；
 * - `assessCityFiscalRisk(world, cityId, config)`：债务/GDP、风险分级与趋势；
 * - `recent12MonthGdp(world, cityId, config)`：12 个月判定窗口合计与真实/估计月数。
 *
 * 总负债口径（DECISIONS v1.1 #11 更正版）：垫付只计一次——
 *   政府全部银行贷款未偿本金（含 purpose='bondAdvance'）
 *   + 未偿债券本金
 *   + 已计提未付利息（含欠付票息与欠付贷款利息）。
 * `GovernmentAdvanceRecord` 只是流水，**不**单独计入总负债。
 */
import type {
  City,
  CityGdpPoint,
  GovernmentDebtSummary,
  GovernmentRiskLevel,
  GovernmentRiskTrend,
  WorldState,
} from '../contracts/types';
import { DEMO_CONFIG } from '../../data/config';
import type { DemoConfig } from '../../data/config';
import { round2 } from '../core/math';

export interface CityDebtBreakdown {
  cityId: string;
  /** 普通政府贷款（purpose='government'）未偿本金。 */
  ordinaryLoanPrincipal: number;
  /** 垫付转借款（purpose='bondAdvance'）未偿本金（只在这里计一次）。 */
  advanceLoanPrincipal: number;
  /** = ordinaryLoanPrincipal + advanceLoanPrincipal。 */
  bankLoanPrincipal: number;
  bondPrincipalOutstanding: number;
  /** 政府贷款已计提未付利息 + 欠付利息。 */
  loanAccruedInterest: number;
  /** 债券已计提未付利息（含欠付票息）。 */
  bondAccruedInterest: number;
  totalDebt: number;
}

export interface GdpWindowTotals {
  points: CityGdpPoint[];
  months: number;
  sum: number;
  estimatedMonths: number;
  realMonths: number;
}

export function cityDebt(world: WorldState, cityId: string): CityDebtBreakdown {
  const empty: CityDebtBreakdown = {
    cityId,
    ordinaryLoanPrincipal: 0,
    advanceLoanPrincipal: 0,
    bankLoanPrincipal: 0,
    bondPrincipalOutstanding: 0,
    loanAccruedInterest: 0,
    bondAccruedInterest: 0,
    totalDebt: 0,
  };
  const city = world.cities.find((entry) => entry.id === cityId);
  if (!city) return empty;
  let ordinary = 0;
  let advance = 0;
  let loanInterest = 0;
  for (const loan of city.government?.loans ?? []) {
    if (loan.status !== 'active') continue;
    if (loan.purpose === 'bondAdvance') advance += loan.outstanding;
    else ordinary += loan.outstanding;
    loanInterest += loan.accruedInterest + loan.arrearsInterest;
  }
  let bondPrincipal = 0;
  let bondInterest = 0;
  for (const holding of world.bonds?.holdings ?? []) {
    if (holding.cityId !== cityId || holding.status !== 'active') continue;
    bondPrincipal += holding.principal;
    bondInterest += holding.accruedInterest;
  }
  const breakdown: CityDebtBreakdown = {
    cityId,
    ordinaryLoanPrincipal: round2(ordinary),
    advanceLoanPrincipal: round2(advance),
    bankLoanPrincipal: round2(ordinary + advance),
    bondPrincipalOutstanding: round2(bondPrincipal),
    loanAccruedInterest: round2(loanInterest),
    bondAccruedInterest: round2(bondInterest),
    totalDebt: 0,
  };
  breakdown.totalDebt = round2(
    breakdown.bankLoanPrincipal +
      breakdown.bondPrincipalOutstanding +
      breakdown.loanAccruedInterest +
      breakdown.bondAccruedInterest,
  );
  return breakdown;
}

/** 12 个月 GDP 判定窗口（按 tick 升序；估计值带 estimated=true）。 */
export function recent12MonthGdp(
  world: WorldState,
  cityId: string,
  config: DemoConfig = DEMO_CONFIG,
): GdpWindowTotals {
  const city = world.cities.find((entry) => entry.id === cityId);
  if (!city) return { points: [], months: 0, sum: 0, estimatedMonths: 0, realMonths: 0 };
  const windowMonths = config.government.gdpEstimate.windowMonths;
  const points = [...(city.gdpWindow ?? [])].sort((a, b) => a.tick - b.tick).slice(-windowMonths);
  let sum = 0;
  let estimatedMonths = 0;
  for (const point of points) {
    sum += point.value;
    if (point.estimated) estimatedMonths += 1;
  }
  return {
    points,
    months: points.length,
    sum: round2(sum),
    estimatedMonths,
    realMonths: points.length - estimatedMonths,
  };
}

/**
 * 债务/GDP 与风险分级/趋势（只读计算，不写存档）。
 * 分母 = max(config.government.fiscalRisk.minAnnualGdp, 12 月窗口合计)；
 * 趋势与上一结算月 lastDebt.debtRatio 比较（无上月数据 unknown）。
 */
export function assessCityFiscalRisk(
  world: WorldState,
  cityId: string,
  config: DemoConfig = DEMO_CONFIG,
): GovernmentDebtSummary {
  const city = world.cities.find((entry) => entry.id === cityId);
  if (!city) throw new Error(`城市不存在：${cityId}`);
  const debt = cityDebt(world, cityId);
  const gdp = recent12MonthGdp(world, cityId, config);
  const judgement = Math.max(config.government.fiscalRisk.minAnnualGdp, gdp.sum);
  const ratio = round2(debt.totalDebt / Math.max(judgement, 0.0001));
  const risk = config.government.fiscalRisk;
  let riskLevel: GovernmentRiskLevel = 'normal';
  if (ratio >= risk.bankruptAt) riskLevel = 'bankrupt';
  else if (ratio >= risk.watchBelow) riskLevel = 'high';
  else if (ratio >= risk.normalBelow) riskLevel = 'watch';

  const previous = city.government?.lastDebt?.debtRatio ?? null;
  let riskTrend: GovernmentRiskTrend = 'unknown';
  if (previous !== null && Number.isFinite(previous)) {
    const delta = ratio - previous;
    if (delta > risk.trendEpsilon) riskTrend = 'up';
    else if (delta < -risk.trendEpsilon) riskTrend = 'down';
    else riskTrend = 'flat';
  }

  return {
    cityId,
    tick: world.time.tick,
    treasury: round2(city.treasury),
    bankLoanPrincipal: debt.ordinaryLoanPrincipal,
    bankAdvancePrincipal: debt.advanceLoanPrincipal,
    bondPrincipalOutstanding: debt.bondPrincipalOutstanding,
    loanAccruedInterest: debt.loanAccruedInterest,
    bondAccruedInterest: debt.bondAccruedInterest,
    totalDebt: debt.totalDebt,
    gdpWindowMonths: gdp.months,
    gdpWindowSum: gdp.sum,
    gdpWindowEstimatedMonths: gdp.estimatedMonths,
    gdpJudgementValue: round2(judgement),
    debtRatio: ratio,
    riskLevel,
    riskTrend,
    previousSettlementDebtRatio: previous,
    note: '公共口径（IMPLEMENTATION_v0.7 §4）；估计月数值不是真实交易。',
  };
}

/** 城市是否已破产（读取权威状态，不是重新判定）。 */
export function isCityBankrupt(city: City): boolean {
  return city.government?.bankruptcy.status === 'bankrupt';
}
