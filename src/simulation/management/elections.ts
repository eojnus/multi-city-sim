// 经营者选任：候选人提名、玩家登记参选、按登记日快照投票与计票。
//
// 【演示规则（用户已确认方向，数值见 config.management）】
// - 通常 3 名候选人：有现任 = 现任 + 2 名其他；无现任 = 3 名；
//   优先从人才市场选，不足时生成新人（每次最多 maxNewPerElection 名）；
// - 候选人在一次投票期间固定；玩家持有该企业有投票权股份即可报名参选；
// - 有投票权股东按登记日快照持股投票；得票最多者当选；
//   平票优先现任；无现任时按 candidateId 字典序（确定性排序）；
// - 任期 termMonths（首版 24 个月）；任期届满 / 职位空缺 / 严重经营问题触发选任；
// - 落选的原经营者回到人才市场，未来可参与其他企业选任；AI 候选人不得同时任职另一家；
// - 选任议案复用 governance 的 Motion，但计票是“多候选人”，
//   因此 governance.autoCastVotes 跳过选任议案，改由本文件处理。
//
// 依赖方向：elections → governance（votingSnapshot / openElectionMotion / 董事会）与
// governance → elections（closeMotions 调用计票/应用结果）构成函数级环；
// 两个模块都只在函数体内互相调用，没有顶层求值依赖，ESM 可以安全处理。

import type {
  ActionResult,
  Company,
  CompanyControl,
  HolderRef,
  LogEntry,
  Motion,
  MotionCandidate,
  MotionVote,
  WorldState,
} from '../contracts/types';
import type { DemoConfig } from '../../data/config';
import { round2 } from '../core/math';
import { monthlyWageBill } from '../companies/company';
import {
  boardFor,
  eligibleSharesOf,
  ensureGovernance,
  openElectionMotion,
} from '../corporate-governance/governance';
import {
  holderExists,
  playerVotingShares,
  sameHolder,
  votingHoldersOf,
} from '../securities/securities';
import { notifyPlayer } from '../notifications/notifications';
import {
  availableOperators,
  currentOperator,
  employOperator,
  generateOperator,
  operatorCityId,
  operatorStyleLabel,
  releaseOperator,
} from './manager-pool';
import {
  ELECTION_TRIGGER_LABELS,
  PLAYER_CANDIDATE_ID,
  type ElectionTrigger,
} from './types';

/** 选任相关日志直接写入世界日志（这些函数没有 log 参数），并裁剪到上限。 */
function pushWorldLog(world: WorldState, config: DemoConfig, entry: LogEntry): void {
  world.log.push(entry);
  while (world.log.length > config.simulation.maxLogEntries) world.log.shift();
}

/** 为候选人生成确定性风格（不消耗 rng，避免改变既有随机序列）。 */
function candidateStyle(company: Company, index: number): 'growth' | 'steady' | 'return' {
  const order = ['growth', 'steady', 'return'] as const;
  let hash = index;
  for (let i = 0; i < company.id.length; i++) hash += company.id.charCodeAt(i);
  if (company.ai?.style) hash += order.indexOf(company.ai.style) + 1;
  return order[hash % order.length] ?? 'steady';
}

/**
 * 生成选任候选人名单：现任优先 + 人才市场符合条件者（同城优先）+ 不足时生成新人。
 * 候选人一次投票期间固定；这里生成的“新人”会留在人才市场，落选后仍可被其他企业选任。
 */
export function electionCandidates(
  world: WorldState,
  company: Company,
  config: DemoConfig,
  tick: number,
): MotionCandidate[] {
  if (!world.management) return [];
  const target = Math.max(1, Math.floor(config.management.candidatesPerElection));
  const candidates: MotionCandidate[] = [];
  const usedCandidateIds = new Set<string>();
  const usedOperatorIds = new Set<string>();

  const control = world.governance?.controls?.find((entry) => entry.companyId === company.id);
  const incumbent = currentOperator(world, company.id);
  const playerIncumbent =
    !!control && control.operator !== 'management' && control.operator.type === 'player';

  if (playerIncumbent) {
    candidates.push({
      candidateId: PLAYER_CANDIDATE_ID,
      kind: 'player',
      operatorId: null,
      name: world.player?.name ? `玩家 · ${world.player.name}` : '玩家',
      style: null,
      isIncumbent: true,
    });
    usedCandidateIds.add(PLAYER_CANDIDATE_ID);
  } else if (incumbent) {
    candidates.push({
      candidateId: incumbent.id,
      kind: 'ai',
      operatorId: incumbent.id,
      name: incumbent.name,
      style: incumbent.style,
      isIncumbent: true,
    });
    usedCandidateIds.add(incumbent.id);
    usedOperatorIds.add(incumbent.id);
  }

  // 已在其他企业本次选任中获提名的经营者不重复提名，避免同一人同时出现在两份议案。
  const nominatedElsewhere = new Set<string>();
  for (const motion of world.governance?.motions ?? []) {
    if (motion.kind !== 'operatorElection' || motion.status !== 'open') continue;
    if (motion.companyId === company.id) continue;
    for (const candidate of motion.candidates ?? []) {
      if (candidate.operatorId) nominatedElsewhere.add(candidate.operatorId);
    }
  }

  if (candidates.length < target) {
    const cityId = company.cityId;
    const pool = availableOperators(world)
      .filter(
        (operator) =>
          !usedOperatorIds.has(operator.id) && !nominatedElsewhere.has(operator.id),
      )
      .sort((a, b) => {
        const aLocal = operatorCityId(a) === cityId ? 0 : 1;
        const bLocal = operatorCityId(b) === cityId ? 0 : 1;
        if (aLocal !== bLocal) return aLocal - bLocal;
        return b.reputation - a.reputation || a.id.localeCompare(b.id);
      });
    for (const operator of pool) {
      if (candidates.length >= target) break;
      if (usedCandidateIds.has(operator.id)) continue;
      candidates.push({
        candidateId: operator.id,
        kind: 'ai',
        operatorId: operator.id,
        name: operator.name,
        style: operator.style,
        isIncumbent: false,
      });
      usedCandidateIds.add(operator.id);
      usedOperatorIds.add(operator.id);
    }
  }

  // 人才市场不足时生成新人，数量不超过 maxNewPerElection（避免无限增长）。
  let generated = 0;
  const maxNew = Math.max(0, Math.floor(config.management.maxNewPerElection));
  while (candidates.length < target && generated < maxNew) {
    const style = candidateStyle(company, generated);
    const operator = generateOperator(world, company.cityId, tick, style);
    candidates.push({
      candidateId: operator.id,
      kind: 'ai',
      operatorId: operator.id,
      name: operator.name,
      style: operator.style,
      isIncumbent: false,
    });
    generated += 1;
  }

  return candidates;
}

/**
 * 开启一次经营者选任：创建 kind='operatorElection' 的议案，
 * 候选人在创建时固定，投票期为 config.management.electionOpenTicks 个月。
 */
export function openOperatorElection(
  world: WorldState,
  company: Company,
  config: DemoConfig,
  tick: number,
  trigger: ElectionTrigger,
  log: LogEntry[],
): ActionResult {
  if (!world.management) return { ok: false, error: '经营者系统未初始化' };
  const hasOpen = (world.governance?.motions ?? []).some(
    (motion) =>
      motion.companyId === company.id &&
      motion.kind === 'operatorElection' &&
      motion.status === 'open',
  );
  if (hasOpen) return { ok: false, error: '该企业已有待表决的经营者选任议案' };

  const candidates = electionCandidates(world, company, config, tick);
  if (candidates.length === 0) return { ok: false, error: '没有可用候选人' };

  const board = boardFor(world, company.id);
  const proposer = board?.chair ?? votingHoldersOf(world, company.id)[0]?.holder ?? null;
  if (!proposer) return { ok: false, error: '企业没有投票权股东，无法提出选任议案' };

  const motion = openElectionMotion(world, company, config, tick, trigger, candidates, proposer);
  if (!motion) return { ok: false, error: '该企业已有待表决的经营者选任议案' };

  log.push({
    tick,
    kind: 'player',
    message: `${company.name} 开启经营者选任（${ELECTION_TRIGGER_LABELS[trigger]}）：候选人 ${candidates
      .map((candidate) => candidate.name)
      .join('、')}，投票期至第 ${motion.closesAtTick} 月。`,
  });
  // 通知由 simulation 的集中通知步骤（publishManagementNotices）统一发出，避免重复。
  return {
    ok: true,
    note: `选任议案已开启（${motion.id}），候选人 ${candidates.length} 名，投票期至第 ${motion.closesAtTick} 月。`,
    amount: candidates.length,
  };
}

/** 连续亏损且现金不足一个月工资的“严重经营问题”判定（阈值全部来自 config）。 */
function severeBusinessProblem(
  world: WorldState,
  company: Company,
  config: DemoConfig,
  tick: number,
): boolean {
  const control = world.governance?.controls?.find((entry) => entry.companyId === company.id);
  if (!control || control.operator !== 'management' || !control.operatorId) return false;
  const severe = config.management.severe;
  const ai = company.ai;
  if (!ai) return false;
  if (ai.ageMonths < severe.minAgeMonths) return false;
  if (ai.lossMonths < severe.lossMonths) return false;
  const wageBill = monthlyWageBill(company);
  if (wageBill > 0 && company.cash >= severe.cashWageMonths * wageBill) return false;

  // 冷却：最近一次选任议案的创建时间在冷却期内则不重复触发（避免每月生成议案）。
  const lastElection = (world.governance?.motions ?? [])
    .filter((motion) => motion.companyId === company.id && motion.kind === 'operatorElection')
    .sort((a, b) => b.createdTick - a.createdTick)[0];
  if (lastElection && tick - lastElection.createdTick < severe.cooldownMonths) return false;
  return true;
}

/**
 * 每月检查并开启必要的选任议案（幂等：同一 tick 重复调用不会重复创建）。
 * 触发顺序：职位空缺 → 任期届满 → 严重经营问题。
 */
export function maybeOpenElections(
  world: WorldState,
  config: DemoConfig,
  tick: number,
  logs: LogEntry[],
): void {
  if (!world.management) return;
  ensureGovernance(world, config, tick);

  for (const company of [...world.companies].sort((a, b) => a.id.localeCompare(b.id))) {
    const control = world.governance.controls.find((entry) => entry.companyId === company.id);
    if (!control) continue;
    const hasOpen = world.governance.motions.some(
      (motion) =>
        motion.companyId === company.id &&
        motion.kind === 'operatorElection' &&
        motion.status === 'open',
    );
    if (hasOpen) continue;

    const playerOperated = control.operator !== 'management';
    const hasAiOperator =
      control.operator === 'management' &&
      !!control.operatorId &&
      !!world.management.operators.find((operator) => operator.id === control.operatorId);

    let trigger: ElectionTrigger | null = null;
    if (!playerOperated && !hasAiOperator) {
      trigger = 'vacancy';
    } else if (
      control.termEndTick !== null &&
      control.termEndTick !== undefined &&
      tick >= control.termEndTick
    ) {
      trigger = 'termEnd';
    } else if (severeBusinessProblem(world, company, config, tick)) {
      trigger = 'severeProblem';
    }
    if (!trigger) continue;

    const result = openOperatorElection(world, company, config, tick, trigger, logs);
    if (!result.ok && result.error) {
      logs.push({
        tick,
        kind: 'warning',
        message: `${company.name} 无法开启经营者选任：${result.error}`,
      });
    }
  }
}

/** 玩家是否持有该企业有投票权股份（可报名参选的前提）。 */
export function playerHoldsVotingShares(world: WorldState, companyId: string): boolean {
  return playerVotingShares(world, companyId) > 0;
}

/** 玩家在投票期内登记参选；重复登记失败。 */
export function registerPlayerCandidate(
  world: WorldState,
  motionId: string,
  config: DemoConfig,
  tick: number,
): ActionResult {
  const motion = world.governance?.motions?.find((entry) => entry.id === motionId);
  if (!motion || motion.kind !== 'operatorElection') {
    return { ok: false, error: '选任议案不存在' };
  }
  if (motion.status !== 'open') return { ok: false, error: '议案已结束表决' };
  if (!playerHoldsVotingShares(world, motion.companyId)) {
    return { ok: false, error: '只有持有该企业有投票权股份的股东可以报名参选' };
  }
  const candidates = motion.candidates ?? [];
  if (candidates.some((candidate) => candidate.kind === 'player')) {
    return { ok: false, error: '你已登记参选该企业的经营者选任' };
  }
  const company = world.companies.find((entry) => entry.id === motion.companyId);
  const control = world.governance?.controls?.find(
    (entry) => entry.companyId === motion.companyId,
  );
  const isIncumbent =
    !!control && control.operator !== 'management' && control.operator.type === 'player';
  const candidate: MotionCandidate = {
    candidateId: PLAYER_CANDIDATE_ID,
    kind: 'player',
    operatorId: null,
    name: world.player?.name ? `玩家 · ${world.player.name}` : '玩家',
    style: null,
    isIncumbent,
  };
  candidates.push(candidate);
  motion.candidates = candidates;

  pushWorldLog(world, config, {
    tick,
    kind: 'player',
    message: `你登记参选${company?.name ?? motion.companyId}的经营者选任（投票期至第 ${motion.closesAtTick} 月）。`,
  });
  notifyPlayer(world, config, {
    audience: 'personal',
    kind: 'vote',
    priority: 'important',
    companyId: motion.companyId,
    motionId: motion.id,
    title: '已登记参选经营者',
    body: `你已登记参选${company?.name ?? motion.companyId}经营者，投票期至第 ${motion.closesAtTick} 月。`,
  });
  return { ok: true, note: `已登记参选${company?.name ?? motion.companyId}的经营者选任。` };
}

/**
 * 投出一张选任票：投票人必须在登记日快照内，票重 = 快照股数；
 * 同一持有人一人一票，改票覆盖旧记录；不能投票给不存在的候选人。
 */
export function castElectionVote(
  world: WorldState,
  motionId: string,
  holder: HolderRef,
  candidateId: string,
  tick: number,
): ActionResult {
  const motion = world.governance?.motions?.find((entry) => entry.id === motionId);
  if (!motion || motion.kind !== 'operatorElection') {
    return { ok: false, error: '选任议案不存在' };
  }
  if (motion.status !== 'open') return { ok: false, error: '议案已结束表决' };
  if (!holderExists(world, holder)) return { ok: false, error: '持股人无效' };
  const candidate = (motion.candidates ?? []).find((entry) => entry.candidateId === candidateId);
  if (!candidate) return { ok: false, error: '候选人不存在' };

  const shares = eligibleSharesOf(motion, holder);
  if (!(shares > 0)) {
    return { ok: false, error: '该持股人不在本议案登记日的投票权名单内' };
  }

  const voteRecord: MotionVote = {
    holder: { type: holder.type, id: holder.id },
    vote: 'for',
    votingShares: round2(shares),
    tick,
    candidateId,
  };
  const existingIndex = motion.votes.findIndex((entry) => sameHolder(entry.holder, holder));
  if (existingIndex >= 0) motion.votes[existingIndex] = voteRecord;
  else motion.votes.push(voteRecord);
  motion.votes.sort(
    (a, b) =>
      a.holder.type.localeCompare(b.holder.type) || a.holder.id.localeCompare(b.holder.id),
  );
  return { ok: true, note: `投票给 ${candidate.name}（${round2(shares)} 股）。` };
}

/** 简单确定性哈希，用于企业/城市股东的自动候选选择。 */
function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * 快照内未投票的 AI 持有人自动投票：
 * - 投资者群体 → 现任（无现任则第一候选人）；
 * - 企业 / 城市 → 按 (议案 id + 持有人) 哈希做确定性选择。
 * 玩家不自动投票（缺席视为弃权，不替玩家做决定）。
 */
export function autoCastElectionVotes(world: WorldState, config: DemoConfig, tick: number): void {
  void config;
  const openMotions = [...(world.governance?.motions ?? [])]
    .filter((motion) => motion.kind === 'operatorElection' && motion.status === 'open')
    .sort((a, b) => a.id.localeCompare(b.id));

  for (const motion of openMotions) {
    const candidates = motion.candidates ?? [];
    if (candidates.length === 0) continue;
    const incumbent = candidates.find((candidate) => candidate.isIncumbent);
    for (const entry of motion.eligible ?? []) {
      const holder = entry.holder;
      if (holder.type === 'player') continue;
      const alreadyVoted = motion.votes.some(
        (vote) => sameHolder(vote.holder, holder) && vote.candidateId !== undefined,
      );
      if (alreadyVoted) continue;
      let candidateId: string;
      if (holder.type === 'investorGroup') {
        candidateId = (incumbent ?? candidates[0]!).candidateId;
      } else {
        const index = hashString(`${motion.id}:${holder.type}:${holder.id}`) % candidates.length;
        candidateId = candidates[index]!.candidateId;
      }
      castElectionVote(world, motion.id, holder, candidateId, tick);
    }
  }
}

/**
 * 选任计票：按 candidateId 汇总投票股数；最高票当选；
 * 平票优先现任；无现任（或无现任并列）时按 candidateId 字典序最小者。
 * 返回 winnerCandidateId 与可读 result 文案（写入 Motion.result）。
 */
export function tallyElection(
  world: WorldState,
  motion: Motion,
  config: DemoConfig,
  tick: number,
): { winnerCandidateId: string; result: string } {
  void world;
  void config;
  void tick;
  const candidates = motion.candidates ?? [];
  if (candidates.length === 0) {
    return { winnerCandidateId: '', result: '选任议案没有候选人，未产生结果。' };
  }

  const totals = new Map<string, number>();
  for (const candidate of candidates) totals.set(candidate.candidateId, 0);
  for (const vote of motion.votes ?? []) {
    if (!vote.candidateId) continue;
    if (!totals.has(vote.candidateId)) continue;
    totals.set(vote.candidateId, round2((totals.get(vote.candidateId) ?? 0) + vote.votingShares));
  }

  const ranked = candidates
    .map((candidate) => ({ candidate, shares: totals.get(candidate.candidateId) ?? 0 }))
    .sort(
      (a, b) =>
        b.shares - a.shares || a.candidate.candidateId.localeCompare(b.candidate.candidateId),
    );
  const maxShares = ranked[0]?.shares ?? 0;
  const top = ranked.filter((entry) => Math.abs(entry.shares - maxShares) <= 0.01);

  let winner = top.find((entry) => entry.candidate.isIncumbent)?.candidate ?? null;
  let tieNote = '';
  if (winner) {
    tieNote = top.length > 1 ? '平票，按现任优先' : '得票最多';
  } else {
    const lexicographic = [...top].sort((a, b) =>
      a.candidate.candidateId.localeCompare(b.candidate.candidateId),
    )[0];
    winner = lexicographic?.candidate ?? candidates[0]!;
    tieNote = top.length > 1 ? '平票，无现任，按 candidateId 字典序' : '得票最多';
  }

  const detail = ranked
    .map((entry) => `${entry.candidate.name} ${entry.shares} 股`)
    .join('，');
  const result = `选任结果：${winner.name} 当选（${tieNote}）。得票：${detail}。`;
  return { winnerCandidateId: winner.candidateId, result };
}

function findOrCreateControl(world: WorldState, companyId: string, tick: number): CompanyControl {
  const existing = world.governance?.controls?.find((entry) => entry.companyId === companyId);
  if (existing) {
    if (existing.operatorId === undefined) existing.operatorId = null;
    if (existing.termEndTick === undefined) existing.termEndTick = null;
    return existing;
  }
  const control: CompanyControl = {
    companyId,
    operator: 'management',
    basis: 'management',
    sinceTick: tick,
    operatorId: null,
    termEndTick: null,
    note: '演示：AI 经营者由市场选任产生；持股本身不直接带来经营权。',
  };
  world.governance.controls.push(control);
  return control;
}

/**
 * 应用选任结果（由 governance.closeMotions 调用）：
 * 写控制权 + 经营者档案；旧经营者离任回人才市场；玩家当选/落选都留通知。
 */
export function applyOperatorElectionResult(
  world: WorldState,
  motion: Motion,
  config: DemoConfig,
  tick: number,
): void {
  const company = world.companies.find((entry) => entry.id === motion.companyId);
  if (!company) return;
  const { winnerCandidateId, result } = tallyElection(world, motion, config, tick);
  motion.result = result;
  const candidate = (motion.candidates ?? []).find(
    (entry) => entry.candidateId === winnerCandidateId,
  );
  if (!candidate) {
    pushWorldLog(world, config, {
      tick,
      kind: 'warning',
      message: `${company.name} 经营者选任未产生当选人，控制权保持不变。`,
    });
    return;
  }

  const control = findOrCreateControl(world, company.id, tick);
  const previousOperatorId = control.operatorId ?? null;
  const previousWasPlayer =
    control.operator !== 'management' && control.operator.type === 'player';
  const termMonths = Math.max(1, Math.floor(config.management.termMonths));
  const termEndTick = tick + termMonths;

  if (candidate.kind === 'player') {
    if (previousOperatorId) {
      releaseOperator(world, previousOperatorId, tick, `选任落选（${company.name}）`);
    }
    control.operator = { type: 'player', id: 'player' };
    control.operatorId = null;
    control.basis = 'election';
    control.sinceTick = tick;
    control.termEndTick = termEndTick;
    control.note = '演示：经股东选任由玩家经营。';
    pushWorldLog(world, config, {
      tick,
      kind: 'player',
      message: `经营者选任：${company.name} 由玩家 ${world.player?.name ?? '玩家'} 当选，任期至第 ${termEndTick} 月。`,
    });
    notifyPlayer(world, config, {
      audience: 'personal',
      kind: 'vote',
      priority: 'important',
      companyId: company.id,
      motionId: motion.id,
      title: '当选企业经营者',
      body: `你在${company.name}的经营者选任中当选，任期至第 ${termEndTick} 月。可在企业页面选择经营模式。`,
    });
    return;
  }

  const operator = candidate.operatorId
    ? world.management?.operators?.find((entry) => entry.id === candidate.operatorId)
    : undefined;
  if (!operator) {
    motion.result = `${motion.result}（当选人档案缺失，控制权未变更）`;
    pushWorldLog(world, config, {
      tick,
      kind: 'warning',
      message: `${company.name} 选任当选人档案缺失，控制权未变更。`,
    });
    return;
  }

  // 防御：AI 经营者不得同时任职两家（两份选任议案同 tick 结算时可能撞车）。
  if (operator.status === 'employed' && operator.companyId && operator.companyId !== company.id) {
    motion.result = `${motion.result}（当选人 ${operator.name} 已在其他企业任职，结果未执行）`;
    pushWorldLog(world, config, {
      tick,
      kind: 'warning',
      message: `${company.name} 选任结果未执行：${operator.name} 已在其他企业任职。`,
    });
    return;
  }

  if (previousOperatorId && previousOperatorId !== operator.id) {
    releaseOperator(world, previousOperatorId, tick, `选任落选（${company.name}）`);
  }
  if (previousWasPlayer) {
    notifyPlayer(world, config, {
      audience: 'personal',
      kind: 'vote',
      priority: 'important',
      companyId: company.id,
      motionId: motion.id,
      title: '不再担任企业经营者',
      body: `你在${company.name}的经营者选任中落选，已不再担任该企业经营者。`,
    });
  }
  employOperator(world, operator.id, company.id, tick, termEndTick, '选任当选');
  pushWorldLog(world, config, {
    tick,
    kind: 'player',
    message: `经营者选任：${company.name} 由 ${operator.name}（${operatorStyleLabel(operator.style)}）当选，任期至第 ${termEndTick} 月。`,
  });
  notifyPlayer(world, config, {
    audience: 'company',
    kind: 'vote',
    priority: 'important',
    companyId: company.id,
    motionId: motion.id,
    title: `${company.name} 经营者选任结果`,
    body: `${operator.name}（${operatorStyleLabel(operator.style)}）当选经营者，任期至第 ${termEndTick} 月。`,
  });
}
