import type { Company, LogEntry, WorldState } from '../contracts/types';
import type { DemoConfig } from '../../data/config';
import { round2 } from '../core/math';
import { companyStyleLabel, planCompanyDecision } from './ai/strategy';
import { expandCompanyCapacity } from './lifecycle/lifecycle';

/**
 * 企业月度经营计划：由 ai/strategy 依据风格、现金、库存、需求、
 * 补贴与经营结果生成计划，再在此处一次性应用。
 *
 * 计划不绕过任何权威校验：招聘仍受失业人口限制，扩产仍受自有资金与
 * 财政补助预算限制，生产仍受员工、产能和原料限制。
 */
export function planCompanies(
  world: WorldState,
  config: DemoConfig,
  log: LogEntry[],
): void {
  for (const company of [...world.companies].sort((a, b) => a.id.localeCompare(b.id))) {
    const decision = planCompanyDecision(world, company, config);
    const previousJobs = company.jobDemand;
    const previousUtilization = company.utilization;

    company.utilization = decision.utilization;
    company.priceFactor = decision.priceFactor;
    company.jobDemand = decision.targetJobs;
    company.ai.ageMonths += 1;
    company.ai.lastPlan = decision.plan;
    company.ai.lastDecision = decision.reasons.join('；');
    company.ai.lastDecisionTick = world.time.tick;

    // 投资计划只在实际资金范围内执行；失败时保留现金。
    const unitCost = config.companyAi.capacityCostPerUnit;
    if (decision.investment >= unitCost) {
      const units = Math.floor(decision.investment / unitCost);
      const result = expandCompanyCapacity(world, company, config, log, units);
      if (!result.ok) {
        decision.plan.investment = 0;
        decision.plan.reasons.push(`扩产未执行：${result.error ?? '条件不满足'}`);
        company.ai.lastDecision = decision.plan.reasons.join('；');
      }
    } else if (decision.investment > 0) {
      decision.plan.investment = 0;
    }

    const jobsChanged =
      Math.abs(company.jobDemand - previousJobs) >= Math.max(5, previousJobs * 0.03);
    const utilizationChanged = Math.abs(company.utilization - previousUtilization) >= 0.04;
    if (jobsChanged || utilizationChanged) {
      log.push({
        tick: world.time.tick,
        kind: 'labor',
        message: `${company.name} 岗位需求 ${previousJobs} → ${company.jobDemand}，利用率 ${(previousUtilization * 100).toFixed(0)}% → ${(company.utilization * 100).toFixed(0)}%（${companyStyleLabel(company.ai.style)}）。`,
      });
    }
  }
}

export function companyPayroll(companies: Company[]): number {
  return round2(companies.reduce((total, company) => total + company.employees * company.wageRate, 0));
}
