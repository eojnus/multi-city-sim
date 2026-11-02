// 玩家经营模式：全面手动 / AI 辅助 / 高度托管，以及重大事项提案的生成与批准。
//
// 【演示规则（用户已确认方向，数值见 config.management）】
// - 每家玩家经营企业的模式与授权独立保存（world.management.playerOperations 是唯一权威）；
// - 手动模式：应用持续经营计划（StandingPlan），直到玩家修改或计划到期/条件失效；
// - AI 辅助：AI 处理日常项（生产利用率、小幅调价、小额招聘/投资），
//   重大项（投资/招聘/贷款/大幅调价）只生成提案，未批准不得执行；
// - 高度托管：授权范围内的重大项 AI 自动执行，超出授权范围生成提案；
// - 需要股东/董事会表决的事项（如股息政策）即使玩家批准也改为开治理议案，不得直接生效；
// - 手动与 AI 使用同一组业务校验：扩产走 expandCompanyCapacity，贷款走 banking.openLoan，
//   招聘只改 company.jobDemand（由 labor 模块下月匹配），绝不直接改 employees。
//
// 幂等性：planPlayerOperatedCompany 每个 tick 每家企业最多处理一次（lastExecutedTick），
// generateProposals 在 plan 已处理时不会重复生成提案。

import type {
  ActionResult,
  Company,
  CompanyAiPlan,
  LogEntry,
  Motion,
  PlayerAuthorization,
  PlayerCompanyOperation,
  PlayerOperationMode,
  PlayerProposal,
  ProposalKind,
  WorldState,
} from '../contracts/types';
import type { DemoConfig } from '../../data/config';
import { clamp, round2 } from '../core/math';
import { monthlyWageBill } from '../companies/company';
import { PRODUCTIVITY } from '../../data/demo-data';
import { workforceSkillMultiplier } from '../labor/workforce';
import { expandCompanyCapacity } from '../companies/lifecycle/lifecycle';
import { planCompanyDecision } from '../companies/ai/strategy';
import { openLoan } from '../banking/banking';
import { availableCredit } from '../banking/credit';
import { boardFor, votingSnapshot } from '../corporate-governance/governance';
import { notifyPlayer } from '../notifications/notifications';
import {
  currentStyle,
  ensureManagementState,
} from './manager-pool';
import { OPERATION_MODE_LABELS, proposalDedupeKey } from './types';
import type { StandingPlanInput } from './types';

const PLAYER_OPERATION_NOTE =
  '演示：玩家经营企业的模式、授权与待批准提案保存在这里；UI 只能发命令，不直接改世界状态。';
const DEFAULT_MODE: PlayerOperationMode = 'assisted';

// ---------------------------------------------------------------- 基础查询

function controlOf(world: WorldState, companyId: string) {
  return world.governance?.controls?.find((entry) => entry.companyId === companyId) ?? null;
}

/** 统一玩家经营者判定：control.operator 指向玩家才算玩家经营。 */
export function canOperate(world: WorldState, companyId: string): boolean {
  const control = controlOf(world, companyId);
  return !!control && control.operator !== 'management' && control.operator.type === 'player';
}

export function playerOperationFor(
  world: WorldState,
  companyId: string,
): PlayerCompanyOperation | null {
  return world.management?.playerOperations?.find((entry) => entry.companyId === companyId) ?? null;
}

export function playerOperatedCompanies(world: WorldState): Company[] {
  return [...world.companies]
    .filter((company) => canOperate(world, company.id))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function defaultAuthorization(config: DemoConfig): PlayerAuthorization {
  const defaults = config.management.defaultAuthorization;
  return {
    maxInvestmentPerMonth: defaults.maxInvestmentPerMonth,
    maxHiresPerMonth: defaults.maxHiresPerMonth,
    maxLoanAmount: defaults.maxLoanAmount,
    allowInvestment: defaults.allowInvestment,
    allowHiring: defaults.allowHiring,
    allowLoan: defaults.allowLoan,
    allowPriceAdjust: defaults.allowPriceAdjust,
  };
}

function makeDefaultOperation(companyId: string, config: DemoConfig): PlayerCompanyOperation {
  return {
    companyId,
    mode: DEFAULT_MODE,
    authorization: defaultAuthorization(config),
    standingPlan: null,
    proposals: [],
    lastExecutedTick: -1,
    note: PLAYER_OPERATION_NOTE,
  };
}

function ensureOperation(
  world: WorldState,
  companyId: string,
  config: DemoConfig,
): PlayerCompanyOperation {
  const state = ensureManagementState(world);
  const existing = state.playerOperations.find((entry) => entry.companyId === companyId);
  if (existing) return existing;
  const created = makeDefaultOperation(companyId, config);
  state.playerOperations.push(created);
  return created;
}

/** 幂等：为所有玩家控制的企业补齐默认 operation（不改已有模式/授权）。 */
export function ensurePlayerOperations(world: WorldState, config: DemoConfig, tick: number): void {
  void tick;
  ensureManagementState(world);
  for (const company of [...world.companies].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!canOperate(world, company.id)) continue;
    if (playerOperationFor(world, company.id)) continue;
    ensureOperation(world, company.id, config);
  }
}

// ---------------------------------------------------------------- 日志/工具

function pushWorldLog(
  world: WorldState,
  config: DemoConfig,
  tick: number,
  kind: LogEntry['kind'],
  message: string,
): void {
  world.log.push({ tick, kind, message });
  while (world.log.length > config.simulation.maxLogEntries) world.log.shift();
}

function appendEntries(world: WorldState, config: DemoConfig, entries: LogEntry[]): void {
  for (const entry of entries) world.log.push(entry);
  while (world.log.length > config.simulation.maxLogEntries) world.log.shift();
}

/** 企业合法岗位需求上限（与 ai/strategy 的算法保持一致）。 */
function maxJobsFor(world: WorldState, company: Company): number {
  const city = world.cities.find((entry) => entry.id === company.cityId);
  const productivity = Math.max(1, PRODUCTIVITY[company.recipeOutput] ?? 1);
  const tech = city?.technology.productivityMultiplier ?? 1;
  const skill = city ? workforceSkillMultiplier(city) : 1;
  return Math.max(0, Math.ceil(company.maxCapacity / Math.max(1, productivity * tech * skill)));
}

function clampUtilization(config: DemoConfig, value: number): number {
  return round2(clamp(value, config.company.minUtilization, config.company.maxUtilization));
}

function clampPriceFactor(config: DemoConfig, value: number): number {
  return round2(clamp(value, config.companyAi.priceBiasMin, config.companyAi.priceBiasMax));
}

function nextProposalId(operation: PlayerCompanyOperation, tick: number): string {
  let serial = operation.proposals.length + 1;
  let id = `proposal-${operation.companyId}-${tick}-${serial}`;
  while (operation.proposals.some((proposal) => proposal.id === id)) {
    serial += 1;
    id = `proposal-${operation.companyId}-${tick}-${serial}`;
  }
  return id;
}

function nextMotionId(world: WorldState, base: string): string {
  let id = `motion-${base}`;
  let suffix = 2;
  while ((world.governance?.motions ?? []).some((motion) => motion.id === id)) {
    id = `motion-${base}-${suffix}`;
    suffix += 1;
  }
  return id;
}

// ---------------------------------------------------------------- 设置接口

export function setOperationMode(
  world: WorldState,
  companyId: string,
  mode: PlayerOperationMode,
  config: DemoConfig,
  tick: number,
): ActionResult {
  if (!canOperate(world, companyId)) return { ok: false, error: '你不是该企业的经营者' };
  if (mode !== 'manual' && mode !== 'assisted' && mode !== 'delegated') {
    return { ok: false, error: '经营模式无效' };
  }
  const operation = ensureOperation(world, companyId, config);
  operation.mode = mode;
  operation.note = `${PLAYER_OPERATION_NOTE}当前模式：${OPERATION_MODE_LABELS[mode]}。`;
  pushWorldLog(
    world,
    config,
    tick,
    'player',
    `玩家经营模式：${companyId} 设为「${OPERATION_MODE_LABELS[mode]}」。`,
  );
  return { ok: true, note: `经营模式已设为「${OPERATION_MODE_LABELS[mode]}」。` };
}

export function setAuthorization(
  world: WorldState,
  companyId: string,
  auth: Partial<PlayerAuthorization>,
  config: DemoConfig,
): ActionResult {
  if (!canOperate(world, companyId)) return { ok: false, error: '你不是该企业的经营者' };
  const operation = ensureOperation(world, companyId, config);
  const next = { ...operation.authorization };

  for (const field of ['maxInvestmentPerMonth', 'maxHiresPerMonth', 'maxLoanAmount'] as const) {
    const value = auth[field];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      return { ok: false, error: `授权数值无效：${field}` };
    }
    next[field] = round2(value);
  }
  for (const field of [
    'allowInvestment',
    'allowHiring',
    'allowLoan',
    'allowPriceAdjust',
  ] as const) {
    const value = auth[field];
    if (value === undefined) continue;
    if (typeof value !== 'boolean') return { ok: false, error: `授权开关无效：${field}` };
    next[field] = value;
  }
  operation.authorization = next;
  operation.note = `${PLAYER_OPERATION_NOTE}授权已更新。`;
  return { ok: true, note: '授权范围已更新。' };
}

export function setStandingPlan(
  world: WorldState,
  companyId: string,
  plan: StandingPlanInput,
  config: DemoConfig,
  tick: number,
): ActionResult {
  if (!canOperate(world, companyId)) return { ok: false, error: '你不是该企业的经营者' };
  const company = world.companies.find((entry) => entry.id === companyId);
  if (!company) return { ok: false, error: '企业不存在' };
  const operation = ensureOperation(world, companyId, config);

  const values = [plan.utilization, plan.targetJobs, plan.priceFactor, plan.investmentPerMonth];
  if (values.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
    return { ok: false, error: '持续经营计划数值无效' };
  }

  const maxJobs = maxJobsFor(world, company);
  operation.standingPlan = {
    utilization: clampUtilization(config, plan.utilization),
    targetJobs: Math.round(clamp(plan.targetJobs, 0, maxJobs)),
    priceFactor: clampPriceFactor(config, plan.priceFactor),
    investmentPerMonth: round2(Math.max(0, plan.investmentPerMonth)),
    expiresTick: tick + Math.max(1, Math.floor(config.management.standingPlanMonths)),
    note: '玩家持续经营计划（手动模式生效，直到修改/到期/条件失效）。',
  };
  operation.note = `${PLAYER_OPERATION_NOTE}已设置持续经营计划。`;
  pushWorldLog(world, config, tick, 'player', `玩家为 ${company.name} 设置持续经营计划，有效期至第 ${operation.standingPlan.expiresTick} 月。`);
  return {
    ok: true,
    note: `持续经营计划已保存（利用率 ${operation.standingPlan.utilization}，岗位 ${operation.standingPlan.targetJobs}，价格系数 ${operation.standingPlan.priceFactor}）。`,
  };
}

// ---------------------------------------------------------------- 提案生成

interface ProposalInput {
  kind: ProposalKind;
  title: string;
  summary: string;
  reasons: string[];
  params: Record<string, number | string>;
  amount: number;
}

/**
 * 生成一条待批准提案（内部去重）：
 * - 同一企业同一去重键只保留一条 pending；
 * - 已拒绝/已执行/已过期的同键提案在 proposalCooldownMonths 内不再重复；
 * - 超过 maxPendingProposals 时不再生成，避免刷屏。
 */
function addProposal(
  _world: WorldState,
  config: DemoConfig,
  tick: number,
  operation: PlayerCompanyOperation,
  company: Company,
  input: ProposalInput,
): PlayerProposal | null {
  const dedupeKey = proposalDedupeKey(company.id, input.kind);
  const pending = operation.proposals.filter((proposal) => proposal.status === 'pending');
  if (pending.length >= config.management.maxPendingProposals) return null;
  if (pending.some((proposal) => proposal.dedupeKey === dedupeKey)) return null;

  const cooldown = config.management.proposalCooldownMonths;
  const recentlyDecided = operation.proposals.some(
    (proposal) =>
      proposal.dedupeKey === dedupeKey &&
      proposal.status !== 'pending' &&
      proposal.decidedTick !== null &&
      tick - proposal.decidedTick < cooldown,
  );
  if (recentlyDecided) return null;

  const proposal: PlayerProposal = {
    id: nextProposalId(operation, tick),
    companyId: company.id,
    kind: input.kind,
    title: input.title,
    summary: input.summary,
    reasons: [...input.reasons],
    params: { ...input.params },
    amount: round2(input.amount),
    status: 'pending',
    createdTick: tick,
    decidedTick: null,
    dedupeKey,
    expiresTick: tick + Math.max(1, Math.floor(config.management.proposalTtlMonths)),
    result: '',
  };
  operation.proposals.push(proposal);
  // 通知由 simulation 的集中通知步骤（publishManagementNotices）统一发出，避免重复。
  return proposal;
}

/** 月底/计划步骤的统一入口：确保提案在有效期内，过期未处理的标记为 expired。 */
export function expireProposals(world: WorldState, config: DemoConfig, tick: number): void {
  for (const operation of world.management?.playerOperations ?? []) {
    for (const proposal of operation.proposals) {
      if (proposal.status !== 'pending') continue;
      if (tick < proposal.expiresTick) continue;
      proposal.status = 'expired';
      proposal.decidedTick = tick;
      proposal.result = '提案过期未处理（玩家未在有效期内决定）。';
      pushWorldLog(
        world,
        config,
        tick,
        'player',
        `玩家经营提案过期：${operation.companyId} 的「${proposal.title}」。`,
      );
    }
  }
}

/**
 * AI 辅助 / 高度托管模式下的重大事项提案生成。
 * 正常结算顺序中 planPlayerOperatedCompany 已在企业计划步骤处理并生成提案，
 * 本函数对同一 tick 已处理的企业直接跳过（幂等）；未处理时作为兜底重新跑一次计划。
 */
export function generateProposals(
  world: WorldState,
  config: DemoConfig,
  tick: number,
  logs: LogEntry[],
): void {
  ensurePlayerOperations(world, config, tick);
  expireProposals(world, config, tick);
  for (const company of playerOperatedCompanies(world)) {
    const operation = playerOperationFor(world, company.id);
    if (!operation) continue;
    if (operation.mode === 'manual') continue;
    if (operation.lastExecutedTick === tick) continue;
    planPlayerOperatedCompany(world, company, config, tick, logs);
  }
}

// ---------------------------------------------------------------- 玩家经营计划

function writePlanState(
  world: WorldState,
  company: Company,
  config: DemoConfig,
  style: ReturnType<typeof currentStyle>,
  utilization: number,
  targetJobs: number,
  investment: number,
  reasons: string[],
): void {
  if (!company.ai) return;
  const plan: CompanyAiPlan = {
    tick: world.time.tick,
    style,
    utilization,
    targetJobs,
    expectedWageCost: round2(monthlyWageBill(company, config)),
    hiringSubsidyPerHire: 0,
    retentionSubsidyPerEmployee: 0,
    investment: round2(Math.max(0, investment)),
    reasons: reasons.length > 0 ? reasons : ['维持现有经营节奏'],
  };
  company.ai.ageMonths += 1;
  company.ai.lastPlan = plan;
  company.ai.lastDecision = plan.reasons.join('；');
  company.ai.lastDecisionTick = world.time.tick;
}

/** 手动模式：应用持续经营计划（全部数值 clamp 到合法范围；投资走既有扩产入口）。 */
function planManualCompany(
  world: WorldState,
  company: Company,
  config: DemoConfig,
  log: LogEntry[],
  operation: PlayerCompanyOperation,
): void {
  const standing = operation.standingPlan;
  const reasons: string[] = [];
  let investment = 0;

  if (!standing) {
    reasons.push('玩家手动经营：未设定持续计划，维持现有经营参数');
  } else {
    company.utilization = clampUtilization(config, standing.utilization);
    company.priceFactor = clampPriceFactor(config, standing.priceFactor);
    company.jobDemand = Math.round(clamp(standing.targetJobs, 0, maxJobsFor(world, company)));
    reasons.push(
      `玩家手动经营：利用率 ${company.utilization}，岗位需求 ${company.jobDemand}，价格系数 ${company.priceFactor}`,
    );

    const unitCost = config.companyAi.capacityCostPerUnit;
    const units = Math.floor(standing.investmentPerMonth / unitCost);
    if (units >= 1) {
      const result = expandCompanyCapacity(world, company, config, log, units);
      if (result.ok) {
        investment = round2(result.amount ?? 0);
        reasons.push(`按计划投资扩产 ${units} 单位`);
      } else {
        reasons.push(`计划内扩产未执行：${result.error ?? '条件不满足'}`);
      }
    }

    const wageBill = monthlyWageBill(company, config);
    if (wageBill > 0 && company.cash < wageBill) {
      reasons.push('现金不足一个月工资，招聘可能受限（计划仍保留）');
    }
  }

  writePlanState(
    world,
    company,
    config,
    currentStyle(world, company),
    company.utilization,
    company.jobDemand,
    investment,
    reasons,
  );
}

/**
 * 处理一家玩家经营企业的当月计划。返回 true 表示该企业本月已由玩家模式处理，
 * 普通 AI 路径（planCompanies）不应再处理它。
 */
export function planPlayerOperatedCompany(
  world: WorldState,
  company: Company,
  config: DemoConfig,
  tick: number,
  log: LogEntry[],
): boolean {
  if (!canOperate(world, company.id)) return false;
  const operation = ensureOperation(world, company.id, config);

  // 每 tick 每家企业最多处理一次，避免重复执行投资/重复生成提案。
  if (operation.lastExecutedTick === tick) return true;

  // 持续计划到期：清空并提示（直到玩家重新设定）。
  if (operation.standingPlan && tick > operation.standingPlan.expiresTick) {
    operation.standingPlan = null;
    log.push({
      tick,
      kind: 'player',
      message: `${company.name} 的玩家持续经营计划已到期，已停止自动应用。`,
    });
  }

  if (operation.mode === 'manual') {
    planManualCompany(world, company, config, log, operation);
    operation.lastExecutedTick = tick;
    operation.note = `${PLAYER_OPERATION_NOTE}当前模式：${OPERATION_MODE_LABELS.manual}。`;
    return true;
  }

  const decision = planCompanyDecision(world, company, config, currentStyle(world, company));
  const operationMode = operation.mode;
  const auth = operation.authorization;
  const thresholds = config.management.majorThresholds;
  const reasons: string[] = [];
  let executedInvestment = 0;

  // ---- 生产利用率：日常项，直接应用（仍在合法范围内）。 ----
  company.utilization = clampUtilization(config, decision.utilization);

  // ---- 定价：波动超过阈值算重大事项。 ----
  const priceDelta =
    company.priceFactor > 0
      ? Math.abs(decision.priceFactor - company.priceFactor) / company.priceFactor
      : 1;
  const priceMajor = priceDelta >= thresholds.priceChangeRatio;
  const priceAllowed =
    operationMode === 'delegated'
      ? auth.allowPriceAdjust && !priceMajor
      : !priceMajor;
  if (priceAllowed) {
    company.priceFactor = clampPriceFactor(config, decision.priceFactor);
  } else {
    addProposal(world, config, tick, operation, company, {
      kind: 'price',
      title: '调整产品定价',
      summary: `拟把价格系数由 ${company.priceFactor} 调整为 ${decision.priceFactor}（变动 ${(priceDelta * 100).toFixed(1)}%，超过重大事项阈值）。`,
      reasons: decision.reasons,
      params: { priceFactor: decision.priceFactor, currentPriceFactor: company.priceFactor },
      amount: 0,
    });
    reasons.push('调价幅度超过重大事项阈值，等待玩家批准');
  }

  // ---- 招聘：岗位需求变动达到 hireCount 算重大事项；只改 jobDemand，不直接改员工数。 ----
  const jobDelta = decision.targetJobs - company.jobDemand;
  const hireMajor = Math.abs(jobDelta) >= Math.max(1, Math.floor(thresholds.hireCount));
  const hiringAllowed =
    operationMode === 'delegated'
      ? auth.allowHiring && Math.abs(jobDelta) <= auth.maxHiresPerMonth
      : !hireMajor;
  if (hiringAllowed) {
    company.jobDemand = Math.round(clamp(decision.targetJobs, 0, maxJobsFor(world, company)));
  } else {
    addProposal(world, config, tick, operation, company, {
      kind: 'hire',
      title: jobDelta >= 0 ? '扩大招聘计划' : '缩减招聘计划',
      summary: `拟把岗位需求由 ${company.jobDemand} 调整为 ${decision.targetJobs}（变动 ${jobDelta} 人）。批准后下月由劳动力市场匹配，企业不直接改员工数。`,
      reasons: decision.reasons,
      params: { targetJobs: decision.targetJobs, fromJobs: company.jobDemand },
      amount: Math.abs(jobDelta),
    });
    reasons.push('招聘变动超过授权/阈值，等待玩家批准');
  }

  // ---- 投资扩产：走统一入口 expandCompanyCapacity，资金校验在入口内。 ----
  const investment = decision.investment;
  if (investment >= config.companyAi.capacityCostPerUnit) {
    const investmentMajor = investment >= thresholds.investmentAmount;
    const investmentAllowed =
      operationMode === 'delegated'
        ? auth.allowInvestment && investment <= auth.maxInvestmentPerMonth
        : !investmentMajor;
    if (investmentAllowed) {
      const units = Math.floor(investment / config.companyAi.capacityCostPerUnit);
      const result = expandCompanyCapacity(world, company, config, log, units);
      if (!result.ok) reasons.push(`自动扩产未执行：${result.error ?? '条件不满足'}`);
      else {
        executedInvestment = round2(result.amount ?? 0);
        reasons.push(`自动投资扩产 ${units} 单位`);
      }
    } else {
      addProposal(world, config, tick, operation, company, {
        kind: 'expand',
        title: '扩产投资',
        summary: `拟投入 ${investment.toFixed(0)} 信用点扩产（约 ${Math.floor(investment / config.companyAi.capacityCostPerUnit)} 单位产能），超过授权/重大事项阈值。`,
        reasons: decision.reasons,
        params: {
          amount: investment,
          units: Math.floor(investment / config.companyAi.capacityCostPerUnit),
        },
        amount: investment,
      });
      reasons.push('投资额超过授权/阈值，等待玩家批准');
    }
  }

  // ---- 贷款需求：现金不足 0.75 个月工资时考虑周转贷款。 ----
  // 额度校验封在银行内：这里先用实时可借额度把金额收敛到“可执行范围”，
  // 避免生成一个注定被银行拒绝的提案（批准/执行时仍会再次走 openLoan 校验）。
  // 金额下限复用 config.banking.minLoanAmount 作为“提案业务下限”（银行侧对
  // workingCapital 已放开小额；这里保留一个配置驱动的下限，避免刷屏式小额提案）。
  const wageBill = monthlyWageBill(company, config);
  if (wageBill > 0 && company.cash < wageBill * 0.75) {
    const need = round2(Math.max(config.banking.minLoanAmount, wageBill * 3));
    const credit = round2(
      Math.max(0, availableCredit(world, { kind: 'company', id: company.id }, config)),
    );
    const amount = round2(Math.min(need, credit));
    if (!(amount > 0)) {
      reasons.push('周转资金不足，但银行可借额度为 0，暂不生成贷款提案');
    } else {
      const loanMajor = amount >= thresholds.loanAmount;
      const loanAllowed =
        operationMode === 'delegated'
          ? auth.allowLoan && amount <= auth.maxLoanAmount
          : !loanMajor;
      if (loanAllowed) {
        const result = openLoan(
          world,
          {
            owner: { kind: 'company', id: company.id },
            purpose: 'workingCapital',
            amount,
          },
          config,
          tick,
        );
        if (result.ok && result.loan) {
          result.loan.note = `${result.loan.note}（来源：托管授权内自动）`;
        }
        if (!result.ok) reasons.push(`自动贷款未执行：${result.error ?? '条件不满足'}`);
        else reasons.push(`自动周转贷款 ${amount.toFixed(0)} 已到账（可借额度内）`);
      } else {
        addProposal(world, config, tick, operation, company, {
          kind: 'loan',
          title: '申请周转贷款',
          summary: `现金仅 ${company.cash.toFixed(0)}，拟向银行申请 ${amount.toFixed(0)} 信用点周转贷款（用途 workingCapital，约需 ${need.toFixed(0)}，已按可借额度收敛）。`,
          reasons: decision.reasons,
          params: { amount, purpose: 'workingCapital' },
          amount,
        });
        reasons.push('贷款需求超过授权/阈值，等待玩家批准');
      }
    }
  }

  // ---- 股息政策：属于股东表决事项，玩家批准后也必须走治理议案，不得直接改派发比例。 ----
  if (
    company.previousMonth.profit > config.governance.minProfitForMotion &&
    company.dividendPayoutRatio < 1
  ) {
    addProposal(world, config, tick, operation, company, {
      kind: 'dividend',
      title: '提高股息派发比例',
      summary: `上月利润 ${company.previousMonth.profit.toFixed(0)}，拟把股息派发比例由 ${Math.round(
        company.dividendPayoutRatio * 100,
      )}% 提高到 100%。该事项需股东表决，批准后提交治理议案，不直接生效。`,
      reasons: decision.reasons,
      params: { ratio: 1 },
      amount: 0,
    });
    reasons.push('股息政策需股东表决，已生成待批准提案');
  }

  if (operationMode === 'assisted' && reasons.length === 0) {
    reasons.push('AI 辅助：日常项已自动处理，本月无重大事项需要批准');
  }

  writePlanState(
    world,
    company,
    config,
    currentStyle(world, company),
    company.utilization,
    company.jobDemand,
    executedInvestment,
    reasons,
  );

  operation.lastExecutedTick = tick;
  operation.note = `${PLAYER_OPERATION_NOTE}当前模式：${OPERATION_MODE_LABELS[operationMode]}。`;
  return true;
}

// ---------------------------------------------------------------- 提案批准/拒绝

/** 把“提高股息”转成治理议案（玩家批准也不得直接改 dividendPayoutRatio）。 */
function openDividendRatioMotion(
  world: WorldState,
  company: Company,
  ratio: number,
  config: DemoConfig,
  tick: number,
): Motion | null {
  const hasOpen = (world.governance?.motions ?? []).some(
    (motion) =>
      motion.companyId === company.id && motion.kind === 'dividendPolicy' && motion.status === 'open',
  );
  if (hasOpen) return null;
  const eligible = votingSnapshot(world, company.id);
  if (eligible.length === 0) return null;
  const board = boardFor(world, company.id);
  const proposedBy = board?.chair ?? eligible[0]!.holder;
  const clampedRatio = round2(clamp(ratio, 0, 1));
  const motion: Motion = {
    id: nextMotionId(world, `${company.id}-dividend-proposal-${tick}`),
    companyId: company.id,
    kind: 'dividendPolicy',
    title: `提高股息派发比例至 ${Math.round(clampedRatio * 100)}%`,
    proposedBy: { type: proposedBy.type, id: proposedBy.id },
    createdTick: tick,
    closesAtTick: tick + Math.max(1, Math.floor(config.governance.motionOpenTicks)),
    params: { ratio: clampedRatio },
    status: 'open',
    eligible,
    votes: [],
    decidedTick: null,
    result: '',
    note: '演示：玩家批准的经营提案仍需股东表决；登记日快照内按持股投票。',
  };
  world.governance.motions.push(motion);
  return motion;
}

function findProposal(
  world: WorldState,
  proposalId: string,
): { operation: PlayerCompanyOperation; proposal: PlayerProposal } | null {
  for (const operation of world.management?.playerOperations ?? []) {
    const proposal = operation.proposals.find((entry) => entry.id === proposalId);
    if (proposal) return { operation, proposal };
  }
  return null;
}

/**
 * 玩家批准/拒绝一条提案。
 * - 拒绝：status='rejected' + 冷却（同键 proposalCooldownMonths 内不再生成）；
 * - 批准：重新走同一业务校验后执行；需要股东表决的事项改为开治理议案；
 *   校验失败时不改世界状态、提案保持 pending 并记录失败原因（可再拒绝）。
 */
export function decideProposal(
  world: WorldState,
  proposalId: string,
  approve: boolean,
  config: DemoConfig,
  tick: number,
): ActionResult {
  const found = findProposal(world, proposalId);
  if (!found) return { ok: false, error: '提案不存在' };
  const { proposal } = found;
  if (proposal.status !== 'pending') return { ok: false, error: '提案已处理，不能重复决定' };

  const company = world.companies.find((entry) => entry.id === proposal.companyId);
  if (!company) return { ok: false, error: '企业不存在' };

  if (!approve) {
    proposal.status = 'rejected';
    proposal.decidedTick = tick;
    proposal.result = '玩家拒绝执行。';
    pushWorldLog(
      world,
      config,
      tick,
      'player',
      `玩家拒绝经营提案：${company.name}「${proposal.title}」。`,
    );
    notifyPlayer(world, config, {
      audience: 'personal',
      kind: 'major',
      companyId: company.id,
      title: '已拒绝经营提案',
      body: `你拒绝了${company.name}的「${proposal.title}」，该提案在冷却期内不会重复出现。`,
    });
    return { ok: true, note: '已拒绝该提案。' };
  }

  const params = proposal.params;
  let executedNote = '';
  switch (proposal.kind) {
    case 'hire': {
      const targetJobs = Math.round(
        clamp(Number(params.targetJobs ?? company.jobDemand), 0, maxJobsFor(world, company)),
      );
      company.jobDemand = targetJobs;
      executedNote = `岗位需求调整为 ${targetJobs}，下月由劳动力市场匹配。`;
      break;
    }
    case 'expand': {
      const unitCost = config.companyAi.capacityCostPerUnit;
      const fallbackUnits = Math.floor(proposal.amount / unitCost);
      const units = Math.max(1, Math.floor(Number(params.units ?? fallbackUnits) || fallbackUnits));
      const box: LogEntry[] = [];
      const result = expandCompanyCapacity(world, company, config, box, units);
      if (!result.ok) {
        proposal.result = `批准未执行：${result.error ?? '条件不满足'}`;
        return { ok: false, error: proposal.result };
      }
      appendEntries(world, config, box);
      executedNote = result.note ?? `扩产 ${units} 单位。`;
      break;
    }
    case 'loan': {
      const amount = round2(Number(params.amount ?? 0));
      if (!(amount > 0)) {
        proposal.result = '批准未执行：贷款金额无效';
        return { ok: false, error: proposal.result };
      }
      const purpose: 'workingCapital' | 'expansion' =
        params.purpose === 'expansion' ? 'expansion' : 'workingCapital';
      const result = openLoan(
        world,
        { owner: { kind: 'company', id: company.id }, purpose, amount },
        config,
        tick,
      );
      if (result.ok && result.loan) {
        result.loan.note = `${result.loan.note}（来源：玩家批准提案）`;
      }
      if (!result.ok) {
        proposal.result = `批准未执行：${result.error ?? '银行拒绝放款'}`;
        return { ok: false, error: proposal.result };
      }
      executedNote = `贷款 ${amount.toFixed(0)} 已到账（${purpose}）。`;
      break;
    }
    case 'price': {
      company.priceFactor = clampPriceFactor(config, Number(params.priceFactor ?? company.priceFactor));
      executedNote = `价格系数调整为 ${company.priceFactor}。`;
      break;
    }
    case 'dividend': {
      const ratio = Number(params.ratio ?? 1);
      const motion = openDividendRatioMotion(world, company, ratio, config, tick);
      if (!motion) {
        proposal.result = '批准未执行：已有待表决的股息议案或没有投票权股东';
        return { ok: false, error: proposal.result };
      }
      executedNote = `已提交股东表决（议案 ${motion.id}），投票期至第 ${motion.closesAtTick} 月。`;
      break;
    }
    default:
      return { ok: false, error: '未知提案类型' };
  }

  proposal.status = 'executed';
  proposal.decidedTick = tick;
  proposal.result = executedNote;
  pushWorldLog(
    world,
    config,
    tick,
    'player',
    `玩家批准经营提案：${company.name}「${proposal.title}」— ${executedNote}`,
  );
  notifyPlayer(world, config, {
    audience: 'personal',
    kind: 'major',
    companyId: company.id,
    title: '已批准经营提案',
    body: `${company.name}「${proposal.title}」：${executedNote}`,
  });
  return { ok: true, note: executedNote };
}

/** 同一去重键在冷却期内是否已有被拒绝/过期的贷款提案（防止其他路径绕过玩家决定）。 */
function hasRecentLoanRejection(
  operation: PlayerCompanyOperation,
  tick: number,
  cooldownMonths: number,
): boolean {
  return operation.proposals.some(
    (proposal) =>
      proposal.kind === 'loan' &&
      (proposal.status === 'rejected' || proposal.status === 'expired') &&
      proposal.decidedTick !== null &&
      tick - proposal.decidedTick < Math.max(1, cooldownMonths),
  );
}

export interface AutomaticLoanDecision {
  /** 是否允许在授权范围内自动放款。 */
  allowed: boolean;
  /** 允许时本次可自动借入的上限（调用方仍需受实时授信额度约束）。 */
  limit: number;
  /** 拒绝/允许的原因（用于日志与玩家提示）。 */
  reason: string;
  /** 是否因超出授权而生成/命中待批准提案。 */
  proposed: boolean;
}

/**
 * 玩家经营企业的“非计划内”自动借款统一裁决（发薪补流动性、生产采购、跨城进口等所有路径）。
 *
 * 规则（验收问题 2）：
 * - 非玩家经营企业：不受此限制，按既有 AI 规则在额度内自动融资；
 * - 全面手动：一律不自动举债（采购受限、工资不足照旧反映，并给出原因）；
 * - 同一冷却期内玩家已拒绝/未批准贷款提案：不得从其他路径绕回；
 * - AI 辅助：只有低于重大事项阈值的贷款可自动执行，否则生成待批准提案；
 * - 高度托管：allowLoan 且金额不超过 maxLoanAmount 时可自动执行，否则生成提案；
 * - 任何情况下都不得“先借后报”：先裁决、再放款。
 */
export function requestAutomaticLoan(
  world: WorldState,
  config: DemoConfig,
  tick: number,
  company: Company,
  desiredAmount: number,
  cause: string,
): AutomaticLoanDecision {
  const desired = round2(Math.max(0, desiredAmount));
  if (!canOperate(world, company.id)) {
    return {
      allowed: true,
      limit: desired,
      reason: '非玩家经营企业：按 AI 既有规则自动融资。',
      proposed: false,
    };
  }
  const operation = ensureOperation(world, company.id, config);
  if (operation.mode === 'manual') {
    return {
      allowed: false,
      limit: 0,
      reason: `全面手动模式不自动举债（${cause}），请先手动处理现金或改用其他模式。`,
      proposed: false,
    };
  }
  if (hasRecentLoanRejection(operation, tick, config.management.proposalCooldownMonths)) {
    return {
      allowed: false,
      limit: 0,
      reason: `玩家近期拒绝或未批准贷款提案，本期不再自动举债（${cause}）。`,
      proposed: false,
    };
  }
  const auth = operation.authorization;
  if (!auth.allowLoan) {
    return {
      allowed: false,
      limit: 0,
      reason: `授权未开启企业贷款，不自动借款（${cause}）。`,
      proposed: false,
    };
  }
  const credit = round2(
    Math.max(0, availableCredit(world, { kind: 'company', id: company.id }, config)),
  );
  const amount = round2(Math.min(desired, credit));
  if (!(amount > 0)) {
    return {
      allowed: false,
      limit: 0,
      reason: `银行可借额度不足（${cause}）。`,
      proposed: false,
    };
  }
  const threshold = config.management.majorThresholds.loanAmount;
  const autoLimit =
    operation.mode === 'delegated' ? auth.maxLoanAmount : Math.max(0, round2(threshold - 0.01));
  if (amount <= autoLimit + 1e-6) {
    return {
      allowed: true,
      limit: amount,
      reason: `${OPERATION_MODE_LABELS[operation.mode]}授权范围内自动融资：${cause}`,
      proposed: false,
    };
  }
  addProposal(world, config, tick, operation, company, {
    kind: 'loan',
    title: '申请周转贷款',
    summary: `因${cause}，拟向银行申请 ${amount.toFixed(0)} 信用点周转贷款（用途 workingCapital），超出自动授权/重大事项阈值。`,
    reasons: [cause],
    params: { amount, purpose: 'workingCapital' },
    amount,
  });
  return {
    allowed: false,
    limit: 0,
    reason: `超出自动授权（可自动 ${autoLimit.toFixed(0)}，需要 ${amount.toFixed(0)}），已生成待批准提案：${cause}`,
    proposed: true,
  };
}

/** 只读副本：供 UI 展示（排序：新的在前）。 */
export function proposalView(world: WorldState, companyId: string): PlayerProposal[] {
  const operation = playerOperationFor(world, companyId);
  if (!operation) return [];
  return [...operation.proposals]
    .sort((a, b) => b.createdTick - a.createdTick || a.id.localeCompare(b.id))
    .map((proposal) => ({
      ...proposal,
      reasons: [...proposal.reasons],
      params: { ...proposal.params },
    }));
}
