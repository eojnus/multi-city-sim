// 经营者、人才市场与玩家经营模式的【模块内部类型与常量】。
//
// 数据契约（OperatorProfile / MotionCandidate / PlayerCompanyOperation 等）在
// contracts/types.ts；本文件只放本模块自用的辅助类型、文案与去重键约定，
// 避免把魔法字符串散落到 elections.ts / operations.ts。
//
// 说明：本模块不 import Phaser / Electron / DOM，也不写 world 之外的任何状态。

import type { CompanyStyle, PlayerOperationMode } from '../contracts/types';

/**
 * 选任触发原因。写入议案 params.trigger（字符串，符合 Motion.params 的类型约束），
 * 便于界面、日志与审计解释“为什么改选”。
 */
export type ElectionTrigger = 'termEnd' | 'vacancy' | 'severeProblem' | 'manual';

export const ELECTION_TRIGGER_LABELS: Record<ElectionTrigger, string> = {
  termEnd: '任期届满',
  vacancy: '职位空缺',
  severeProblem: '严重经营问题',
  manual: '主动改选',
};

/** 玩家候选人的固定 candidateId；AI 候选人直接使用经营者档案 id。 */
export const PLAYER_CANDIDATE_ID = 'player';

/** 玩家经营模式的中文标签（界面使用）。 */
export const OPERATION_MODE_LABELS: Record<PlayerOperationMode, string> = {
  manual: '全面手动',
  assisted: 'AI 辅助',
  delegated: '高度托管',
};

/**
 * 经营风格的可读标签。
 * 与 companies/ai/strategy.ts 的 companyStyleLabel 保持一致；
 * 这里独立实现是为了避免 management → strategy → management 的循环依赖
 * （lead 会让 strategy 读取 currentStyle，即 strategy 反向依赖本模块）。
 */
export const OPERATOR_STYLE_LABELS: Record<CompanyStyle, string> = {
  growth: '扩张型',
  steady: '稳健型',
  return: '回报型',
};

export const OPERATOR_STYLE_DESCRIPTIONS: Record<CompanyStyle, string> = {
  growth: '愿意以较低价格换取销量，现金允许时积极招聘与扩产。',
  steady: '在就业、库存与现金之间取中，避免大幅波动。',
  return: '优先保留现金与利润，谨慎扩产，定价更保守。',
};

/**
 * 玩家提案去重键约定：同一企业同一类重大事项共用一个键。
 * 冷却期（config.management.proposalCooldownMonths）内不会重复生成，
 * 避免每月刷屏；拒绝后只有“新情况”才会在冷却期结束后再次提出。
 */
export function proposalDedupeKey(companyId: string, kind: string): string {
  return `${companyId}:${kind}`;
}

/** setStandingPlan 的输入（持续生效的经营计划）。 */
export interface StandingPlanInput {
  utilization: number;
  targetJobs: number;
  priceFactor: number;
  investmentPerMonth: number;
}
