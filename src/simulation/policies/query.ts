import type {
  ActivePolicy,
  City,
  PolicyDomain,
  PolicyId,
  SectorId,
  WorldState,
} from '../contracts/types';
import type { DemoConfig } from '../../data/config';
import { round2 } from '../core/math';

/**
 * 政策查询层：只读，不改变世界。
 * 企业 AI、交通结算与界面都通过这里读取“当前生效的政策效果”，
 * 避免每个模块各自解释同一项政策。
 */

export function activePolicy(
  world: WorldState,
  cityId: string,
  policyId: PolicyId,
): ActivePolicy | undefined {
  return world.policies.active.find(
    (policy) => policy.cityId === cityId && policy.policyId === policyId && policy.status === 'active',
  );
}

export function activePoliciesFor(world: WorldState, cityId: string): ActivePolicy[] {
  return world.policies.active
    .filter((policy) => policy.cityId === cityId && policy.status === 'active')
    .sort((a, b) => a.policyId.localeCompare(b.policyId));
}

export function ensurePolicyState(world: WorldState): void {
  // 保留给旧存档：v4 迁移会补齐 policies，此处只做防御性检查。
  if (!world.policies) {
    world.policies = { active: [], history: [], lastRuns: [], lastSelection: [] };
  }
}

export function remainingBudget(policy: ActivePolicy): number {
  return round2(Math.max(0, policy.budget - policy.spent));
}

/** 领导人领域倾向对政策效果的放大（0–scale），用于政策效果与 AI 选择权重。 */
export function leaderDomainScale(
  world: WorldState,
  cityId: string,
  domain: PolicyDomain,
  config: DemoConfig,
): number {
  const politics = world.politics?.cities.find((entry) => entry.cityId === cityId);
  const leader = politics?.leader;
  if (!leader) return 1;
  const leaning = leader.profile.domainLeanings[domain] ?? 0;
  return 1 + config.politics.domainEffectScale * Math.max(0, Math.min(1, leaning));
}

/** 新增招聘补贴：每名新员工可得的一次性补贴额（预算不足时按可用余额）。 */
export function hiringSubsidyPerHire(
  world: WorldState,
  cityId: string,
  wageRate: number,
  config: DemoConfig,
): number {
  const policy = activePolicy(world, cityId, 'hiringSubsidy');
  if (!policy || remainingBudget(policy) <= 0) return 0;
  const scale = leaderDomainScale(world, cityId, 'employment', config);
  return round2(wageRate * config.policies.hiring.subsidyRate * scale);
}

/** 稳岗补贴：每名在岗员工每月可得的补贴额（预算不足时以余额为上限）。 */
export function retentionSubsidyPerEmployee(
  world: WorldState,
  cityId: string,
  wageRate: number,
  config: DemoConfig,
): number {
  const policy = activePolicy(world, cityId, 'retentionSubsidy');
  if (!policy || remainingBudget(policy) <= 0) return 0;
  const scale = leaderDomainScale(world, cityId, 'employment', config);
  return round2(wageRate * config.policies.retention.subsidyRate * scale);
}

/** 企业 AI 使用的“补贴后月工资成本”：新增与稳岗补贴按暂定规则部分传导给企业判断。 */
export function effectiveWageRate(
  world: WorldState,
  city: City,
  companyId: string,
  wageRate: number,
  config: DemoConfig,
): number {
  const company = world.companies.find((entry) => entry.id === companyId);
  if (!company) return wageRate;
  const hiring = hiringSubsidyPerHire(world, city.id, wageRate, config);
  const retention = retentionSubsidyPerEmployee(world, city.id, wageRate, config);
  // 【暂定】新增补贴按 50% 折入长期用工成本，稳岗补贴按实际比例折入；两项不叠加到同一员工月。
  const hiringFactor = wageRate > 0 ? (hiring * 0.5) / wageRate : 0;
  const retentionFactor = wageRate > 0 ? retention / wageRate : 0;
  return round2(Math.max(0, wageRate * (1 - Math.min(0.6, hiringFactor + retentionFactor))));
}

/** 重点产业扶持的行业与生产率加成。 */
export function keyIndustryFocus(
  world: WorldState,
  cityId: string,
): { sector: SectorId | null; bonus: number; policy: ActivePolicy | undefined } {
  const policy = activePolicy(world, cityId, 'keyIndustrySupport');
  return {
    sector: policy?.targetSector ?? null,
    bonus: policy ? policy.effects.productivityBonus ?? 0 : 0,
    policy,
  };
}

export function tradeSupportActive(world: WorldState, cityId: string): ActivePolicy | undefined {
  return activePolicy(world, cityId, 'intercityTradeSupport');
}

export function equipmentSubsidyActive(world: WorldState, cityId: string): ActivePolicy | undefined {
  return activePolicy(world, cityId, 'equipmentSubsidy');
}

export function reliefActive(world: WorldState, cityId: string): ActivePolicy | undefined {
  return activePolicy(world, cityId, 'companyRelief');
}

export function startupSupportActive(world: WorldState, cityId: string): ActivePolicy | undefined {
  return activePolicy(world, cityId, 'startupSupport');
}
