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
import { recomputeProductionPlan, cityShortageFor, outputPerEmployee } from '../production-plan';
import { companyMonthlyMaintenance } from '../cost';
import { planCompanyPrice } from '../pricing';
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
      expectedWageCost: monthlyWageBill(company, config),
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

  // ---- 生产计划：优先采用 production-plan 的计划产量 / 设备产能作为目标利用率 ----
  // 生产模块按企业生产计划的 plannedOutput 生产；utilization 只用于展示、投资与协议口径，
  // 因此这里把它对齐为“计划产量 ÷ 设备产能”，再叠加风格偏置，保留不同风格的可解释差异。
  let productionPlan = company.productionPlan;
  if (!productionPlan || productionPlan.tick !== world.time.tick) {
    productionPlan = recomputeProductionPlan(world, company, config);
  }
  const equipmentLimit = Math.max(0, productionPlan.equipmentLimit);
  const plannedUtilization =
    equipmentLimit > 0 ? productionPlan.plannedOutput / equipmentLimit : company.utilization;
  const styleBias = productionPlan.emergency ? 0 : params.utilizationBias;
  let utilization = clamp(
    round2(plannedUtilization + styleBias),
    config.company.minUtilization,
    config.company.maxUtilization,
  );
  reasons.push(...productionPlan.reasons.slice(0, 6));

  // v1.1：缺货信号与生产计划同口径（有效需求 − 已成交 − 跨城进口，且不把资金不足当缺货）。
  const unmet = cityShortageFor(world, city, output);
  if (unmet > 0 && !productionPlan.emergency) {
    reasons.push(`市场需求未满足 ${unmet.toFixed(0)}，按生产计划扩大招聘/投资`);
  }

  // ---- 用工计划：由计划产量推岗位需求（不再绑定历史产能），再按风格与现金能力修正 ----
  const effectiveWage = effectiveWageRate(world, city, company.id, company.wageRate, config);
  const hiringSubsidy = hiringSubsidyPerHire(world, city.id, company.wageRate, config);
  const retentionSubsidy = retentionSubsidyPerEmployee(world, city.id, company.wageRate, config);

  const perEmployee = Math.max(
    0.01,
    productionPlan.laborLimit > 0 && company.employees > 0
      ? productionPlan.laborLimit / company.employees
      : productivity * tech * skill,
  );
  const jobsForPlan = Math.ceil(productionPlan.plannedOutput / perEmployee);
  const styledJobs = Math.floor(productionPlan.plannedJobs * params.jobFactor);
  let targetJobs = Math.max(jobsForPlan, styledJobs);
  // v1.2 §6：招聘目标必须被“设备产能可支撑的岗位数”封顶。
  // 设备产能 ÷ 人均产出（含技术/技能/政策/1.08 系数）才是设备真正能喂饱的岗位数；
  // 不能用 maxCapacity 或 laborLimit / 现有员工数推导——后者会让超编企业靠历史用工自我维持。
  const perEmployeeCapacity = Math.max(0.01, outputPerEmployee(world, company, config));
  const equipmentJobCap =
    equipmentLimit > 0.01
      ? Math.max(0, Math.floor(equipmentLimit / perEmployeeCapacity))
      : Number.POSITIVE_INFINITY;
  const capacityMaxJobs = Math.ceil(company.maxCapacity / Math.max(1, productivity * tech * skill));
  const maxJobs = Number.isFinite(equipmentJobCap)
    ? Math.min(capacityMaxJobs, equipmentJobCap)
    : capacityMaxJobs;
  if (company.employees > maxJobs) {
    reasons.push(
      `岗位需求受设备产能限制（最多 ${maxJobs} 人，现有 ${company.employees} 人），超编人员按月度裁员率下降`,
    );
  }

  // v1.6 §四.4：设备维护费是月度固定支出，进“现金能撑几个月”“保留资金”与投资判断，
  // 否则 AI 会高估可支配现金、在不该扩产时扩产。
  const maintenanceBill = companyMonthlyMaintenance(world, company, config);
  const projectedJobs = Math.max(company.employees, targetJobs, 1);
  const effectiveBill = effectiveWage * projectedJobs;
  const monthlyFixedBill = round2(effectiveBill + maintenanceBill);
  const cashMonths = monthlyFixedBill > 0 ? company.cash / monthlyFixedBill : 99;
  if (maintenanceBill > 0) {
    reasons.push(
      `设备维护费 ${maintenanceBill.toFixed(0)}/月（含闲置设备），月度固定支出约 ${monthlyFixedBill.toFixed(0)}`,
    );
  }
  if (cashMonths < config.companyAi.cashJobThresholdHigh) {
    targetJobs = Math.floor(targetJobs * 0.9);
    reasons.push(`现金仅够 ${cashMonths.toFixed(1)} 个月工资+维护费，收紧招聘`);
  }
  if (cashMonths < config.companyAi.cashJobThresholdLow) {
    targetJobs = Math.floor(targetJobs * 0.7);
    reasons.push('现金严重不足，削减岗位需求');
  }
  if (hiringSubsidy > 0) {
    reasons.push(`新增招聘补贴 ${hiringSubsidy.toFixed(0)}/人，补贴后用工成本 ${effectiveWage.toFixed(0)}`);
    // 新增招聘补贴由财政承担部分首次用工成本：同等条件下小幅扩大招聘（暂定 5%）。
    targetJobs = Math.floor(targetJobs * 1.05);
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

  // ---- 投资计划：现金充足时形成扩产意向；是否执行还要过 v1.0 扩产条件
  //      （连续 2 月设备利用率≥80%、库存≤1 月销量、保留资金充足），由 planning 统一裁决。
  //      玩家经营企业由玩家授权决定，不受该自动判定约束。 ----
  let investment = 0;
  if (company.previousMonth.profit > 0 && cashMonths > params.investmentMonths) {
    const spare = round2(
      company.cash - monthlyFixedBill * params.reserveMonths,
    );
    investment = round2(Math.max(0, Math.min(spare * params.investmentShare, company.cash * config.companyAi.maxInvestmentShareOfCash)));
    if (investment > 0) {
      reasons.push(`现金充足（约 ${cashMonths.toFixed(1)} 个月工资+维护费），计划投资扩产`);
    }
  }
  if (investment <= 0 && company.previousMonth.profit <= 0) {
    reasons.push('上月未盈利，暂缓扩产');
  }

  // ---- v1.6 §三：真实报价竞争 ----
  // 由 cost.ts 的单位成本（原料+工资+维护费）、本城供需/库存、销量变化与对手报价共同
  // 决定 priceFactor；内部高精度、成交按分舍入，且夹在成本底线与绝对上下限之间。
  // 低报价的同类企业会因市场按单价升序成交而自然拿到更多订单（见 markets.executePurchase）。
  const pricing = planCompanyPrice(world, company, config);
  const priceFactor = pricing.priceFactor;
  reasons.push(...pricing.reasons);

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
