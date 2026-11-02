import type {
  Company,
  CompanyAiPlan,
  CompanyStyle,
  LogEntry,
  WorldState,
} from '../../contracts/types';
import type { DemoConfig } from '../../../data/config';
import { PRODUCTIVITY } from '../../../data/demo-data';
import { clamp, round2 } from '../../core/math';
import { monthlyWageBill } from '../company';
import { effectiveWageRate, hiringSubsidyPerHire, retentionSubsidyPerEmployee } from '../../policies/query';
import { workforceSkillMultiplier } from '../../labor/workforce';

/**
 * 企业自动经营：同一套经济规则下的不同目标与取舍。
 *
 * 三种风格【暂定演示】：
 * - growth（扩张）：更愿意招人、扩产、接受较低价格换取销量；
 * - steady（稳健）：在现金、岗位与库存之间取中；
 * - return（回报）：更谨慎地扩产，偏好较高价格与保留现金。
 *
 * 企业仍受现金、劳动力、库存、产能与政策预算约束；计划只是意图，
 * 实际招聘由 labor 模块从失业人口中匹配，实际产出由生产模块校验。
 * 目标：相同形势下不同风格给出可解释的不同选择。
 */
export interface PlannedDecision {
  plan: CompanyAiPlan;
  utilization: number;
  targetJobs: number;
  investment: number;
  priceFactor: number;
  reasons: string[];
}

export function styleParams(style: CompanyStyle, config: DemoConfig) {
  return config.companyAi.styles[style];
}

export function planCompanyDecision(
  world: WorldState,
  company: Company,
  config: DemoConfig,
  styleOverride?: CompanyStyle,
): PlannedDecision {
  const city = world.cities.find((candidate) => candidate.id === company.cityId);
  if (!city) {
    const fallback: CompanyAiPlan = {
      tick: world.time.tick,
      style: styleOverride ?? company.ai?.style ?? 'steady',
      utilization: company.utilization,
      targetJobs: company.jobDemand,
      expectedWageCost: monthlyWageBill(company),
      hiringSubsidyPerHire: 0,
      retentionSubsidyPerEmployee: 0,
      investment: 0,
      reasons: ['城市不存在，维持现有计划'],
    };
    return { plan: fallback, utilization: company.utilization, targetJobs: company.jobDemand, investment: 0, priceFactor: company.priceFactor, reasons: fallback.reasons };
  }

  // v0.4：经营风格由现任经营者决定（无经营者时回退企业自身风格）。
  const style = styleOverride ?? company.ai?.style ?? 'steady';
  const params = styleParams(style, config);
  const reasons: string[] = [];
  const output = company.recipeOutput;
  const stock = company.inventory[output] ?? 0;
  const productivity = Math.max(1, PRODUCTIVITY[output] ?? 1);
  const tech = city.technology.productivityMultiplier;
  const skill = workforceSkillMultiplier(city);

  // ---- 生产计划：按上月销售实现率、库存与需求调整利用率 ----
  let utilization = company.utilization;
  if (company.previousMonth.produced > 0.01) {
    const sellRatio =
      (company.previousMonth.sold + company.previousMonth.exported) /
      company.previousMonth.produced;
    utilization += (sellRatio - 1) * config.company.utilizationAdjust;
    if (sellRatio < 0.85) reasons.push('上月销售低于产量，降低生产');
    if (sellRatio > 1.05) reasons.push('上月销量超过产量，提高生产');
  }
  if (stock > Math.max(1, company.capacity * 0.8)) {
    utilization -= 0.05;
    reasons.push('成品库存偏高，压缩生产');
  }
  const unmet = city.market[output]?.unmetDemand ?? 0;
  if (stock < Math.max(1, company.capacity * 0.15) && unmet > 0) {
    utilization += 0.05;
    reasons.push(`市场需求未满足 ${unmet.toFixed(0)}，增加生产`);
  }
  utilization = clamp(
    round2(utilization + params.utilizationBias),
    config.company.minUtilization,
    config.company.maxUtilization,
  );

  // ---- 用工计划：产能需求 × 风格系数，再按补贴后的现金能力修正 ----
  const effectiveWage = effectiveWageRate(world, city, company.id, company.wageRate, config);
  const hiringSubsidy = hiringSubsidyPerHire(world, city.id, company.wageRate, config);
  const retentionSubsidy = retentionSubsidyPerEmployee(world, city.id, company.wageRate, config);

  let targetJobs = Math.ceil(company.capacity / Math.max(1, productivity * tech * skill));
  targetJobs = Math.floor(targetJobs * params.jobFactor);
  const maxJobs = Math.ceil(company.maxCapacity / Math.max(1, productivity * tech * skill));

  const projectedJobs = Math.max(company.employees, targetJobs, 1);
  const effectiveBill = effectiveWage * projectedJobs;
  const cashMonths = effectiveBill > 0 ? company.cash / effectiveBill : 99;
  if (cashMonths < config.companyAi.cashJobThresholdHigh) {
    targetJobs = Math.floor(targetJobs * 0.9);
    reasons.push(`现金仅够 ${cashMonths.toFixed(1)} 个月工资，收紧招聘`);
  }
  if (cashMonths < config.companyAi.cashJobThresholdLow) {
    targetJobs = Math.floor(targetJobs * 0.7);
    reasons.push('现金严重不足，削减岗位需求');
  }
  if (hiringSubsidy > 0) {
    reasons.push(`新增招聘补贴 ${hiringSubsidy.toFixed(0)}/人，补贴后用工成本 ${effectiveWage.toFixed(0)}`);
  }
  if (retentionSubsidy > 0) {
    reasons.push(`稳岗补贴 ${retentionSubsidy.toFixed(0)}/人，倾向保留现有岗位`);
    // 稳岗补贴降低保留岗位成本：短期波动下不立即裁员（暂定规则）。
    if (company.previousMonth.profit >= 0 && company.employees > 0) {
      targetJobs = Math.max(targetJobs, Math.floor(company.employees * 0.95));
    }
  }
  if (unmet > 0 && stock < company.capacity * 0.3 && cashMonths > 1.2) {
    targetJobs = Math.floor(targetJobs * 1.05);
    reasons.push('存在未满足需求且现金充足，扩大招聘');
  }
  targetJobs = clamp(targetJobs, 0, maxJobs);

  // ---- 投资计划：现金充足时扩产；设备补助会改善投资条件 ----
  let investment = 0;
  if (company.previousMonth.profit > 0 && cashMonths > params.investmentMonths) {
    const spare = round2(company.cash - effectiveBill * params.reserveMonths);
    investment = round2(Math.max(0, Math.min(spare * params.investmentShare, company.cash * config.companyAi.maxInvestmentShareOfCash)));
    if (investment > 0) {
      reasons.push(`现金充足（约 ${cashMonths.toFixed(1)} 个月工资），计划投资扩产`);
    }
  }
  if (investment <= 0 && company.previousMonth.profit <= 0) {
    reasons.push('上月未盈利，暂缓扩产');
  }

  // ---- 定价倾向：风格造成的缓慢偏移，仍在市场允许范围内 ----
  const priceFactor = round2(
    clamp(
      company.priceFactor + params.priceBias * 0.25,
      config.companyAi.priceBiasMin * company.priceFactor,
      config.companyAi.priceBiasMax,
    ),
  );

  const plan: CompanyAiPlan = {
    tick: world.time.tick,
    style,
    utilization,
    targetJobs,
    expectedWageCost: round2(effectiveWage * targetJobs),
    hiringSubsidyPerHire: hiringSubsidy,
    retentionSubsidyPerEmployee: retentionSubsidy,
    investment,
    reasons: reasons.length > 0 ? reasons : ['维持现有经营节奏'],
  };
  return { plan, utilization, targetJobs, investment, priceFactor, reasons: plan.reasons };
}

/** 风格的可读名称（界面使用）。 */
export function companyStyleLabel(style: CompanyStyle): string {
  return style === 'growth' ? '扩张型' : style === 'steady' ? '稳健型' : '回报型';
}

export function companyStyleDescription(style: CompanyStyle): string {
  return style === 'growth'
    ? '愿意以较低价格换取销量，现金允许时积极招聘与扩产。'
    : style === 'steady'
      ? '在就业、库存与现金之间取中，避免大幅波动。'
      : '优先保留现金与利润，谨慎扩产，定价更保守。';
}

/** 供企业页面展示：上期计划原因（不展示内部系数）。 */
export function decisionSummary(company: Company): string {
  const plan = company.ai?.lastPlan;
  if (!plan) return company.ai?.lastDecision ?? '尚未制定经营计划。';
  return plan.reasons.join('；');
}

export function logDecision(log: LogEntry[], tick: number, company: Company, reasons: string[]): void {
  if (reasons.length === 0) return;
  log.push({
    tick,
    kind: 'production',
    message: `${company.name} 经营决定：${reasons.join('；')}。`,
  });
}
