import type { Company, LogEntry, WorldState } from '../contracts/types';
import type { DemoConfig } from '../../data/config';
import { round2 } from '../core/math';
import { companyStyleLabel, planCompanyDecision } from './ai/strategy';
import { expandCompanyCapacity } from './lifecycle/lifecycle';
import { recomputeProductionPlan, assessExpansion } from './production-plan';
import { currentStyle } from '../management/manager-pool';
import { planPlayerOperatedCompany } from '../management/operations';
import { legalWorkingCapitalRoom } from '../management/financing';

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
    // v0.9：先重算本月生产计划（销量参考、目标库存、设备/劳动/原料上限），
    // 计划会写回 company.productionPlan 与基于计划产量的 jobDemand；
    // 后续 AI 决策只在此基础上调整利用率、岗位与投资。
    // v1.0：把“合法可自动动用的授信额度”并入计划期原料资金约束（真实贷款，
    // 采购时经 drawPlannedWorkingCapital 放款并计息）。玩家手动经营/未授权时该值为 0。
    const workingCapitalRoom = legalWorkingCapitalRoom(world, config, world.time.tick, company);
    const productionPlan = recomputeProductionPlan(world, company, config, workingCapitalRoom);

    // v0.4：玩家经营的企业按玩家模式处理（手动计划 / AI 辅助提案 / 高度托管授权执行）。
    if (planPlayerOperatedCompany(world, company, config, world.time.tick, log)) {
      // 玩家模式：生产目标同步为玩家/授权决策的“产能 × 利用率”，
      // 避免生产模块用 AI 计划产量覆盖玩家的手动设定（计划其余字段仍保留）。
      productionPlan.plannedOutput = round2(company.capacity * company.utilization);
      continue;
    }

    const style = currentStyle(world, company);
    const decision = planCompanyDecision(world, company, config, style);
    const previousJobs = company.jobDemand;
    const previousUtilization = company.utilization;

    company.utilization = decision.utilization;
    company.priceFactor = decision.priceFactor;
    company.jobDemand = decision.targetJobs;
    company.ai.ageMonths += 1;
    company.ai.lastPlan = decision.plan;
    company.ai.lastDecision = decision.reasons.join('；');
    company.ai.lastDecisionTick = world.time.tick;

    // v1.0：自主扩产必须满足扩产条件（连续 2 月设备利用率≥80%、库存≤1 月销量、
    // 保留 2 月工资 + 近期偿债后仍有资金）；不满足时不执行设备投资，只记录原因。
    // 玩家经营企业的扩产走玩家授权/提案，不受这条自动判定约束。
    if (decision.investment >= config.companyAi.capacityCostPerUnit) {
      const expansion = assessExpansion(world, company, config, {
        plannedOutput: productionPlan.plannedOutput,
        equipmentLimit: productionPlan.equipmentLimit,
        salesReference: productionPlan.salesReference,
        laborLimit: productionPlan.laborLimit,
      });
      if (!expansion.eligible) {
        decision.investment = 0;
        decision.plan.investment = 0;
        decision.plan.reasons.push(
          `暂缓扩产：${expansion.reasons[0] ?? '扩产条件未满足'}`,
        );
        company.ai.lastDecision = decision.plan.reasons.join('；');
      }
    }

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
        message: `${company.name} 岗位需求 ${previousJobs} → ${company.jobDemand}，利用率 ${(previousUtilization * 100).toFixed(0)}% → ${(company.utilization * 100).toFixed(0)}%（${companyStyleLabel(style)}）。`,
      });
    }
  }
}

export function companyPayroll(companies: Company[]): number {
  return round2(companies.reduce((total, company) => total + company.employees * company.wageRate, 0));
}
