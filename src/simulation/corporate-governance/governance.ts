// 董事会、议案与表决的【暂定演示方案】。
//
// 重要说明：
// - 本文件中的席位分配、票制、控制权归属规则全部是演示用的临时规则，
//   不代表最终策划。后续可整体替换而不影响其他模块的数据契约。
// - 持股不等于控制企业：企业默认由职业经理人经营（operator === 'management'），
//   持股只带来投票权与董事席位；把经营权交给具体持有人必须经过议案表决。
// - 证券数据的权威仍在 `world.securities`（securities 模块负责写入）。
//   这里的辅助函数只是治理模块对只读数据的局部投影，不修改证券状态；
//   为避免与并行开发中的 securities.ts 耦合，本文件不 import 该模块。
// - 所有遍历、并列都以 id 排序，保证确定性；不使用 Math.random / Date.now。

import type {
  Board,
  BoardSeat,
  Company,
  CompanyControl,
  HolderRef,
  HolderType,
  LogEntry,
  Motion,
  MotionCandidate,
  MotionVote,
  VotingEntitlement,
  WorldState,
} from '../contracts/types';
import type { DemoConfig } from '../../data/config';
import { allocateProportionally, clamp, round2 } from '../core/math';
import {
  applyOperatorElectionResult,
  tallyElection,
} from '../management/elections';
import { ELECTION_TRIGGER_LABELS, type ElectionTrigger } from '../management/types';

const MANAGEMENT_NOTE = '演示：职业经理人经营，持股不等于控制权。';
const BOARD_NOTE = '演示规则：按投票权持股比例分配董事席位；席位不等于经营控制权。';
const MOTION_NOTE =
  '暂定演示规则：议案创建时记录投票权登记日快照，只有快照内持有人可按快照股数投票；赞成票多于反对票即通过。';
const ELECTION_NOTE =
  '演示规则：经营者选任议案按登记日投票权快照投票；得票最多者当选，平票优先现任，无现任时按 candidateId 字典序；任期来自 config.management.termMonths。';

const PLAYER_ID = 'player';

function holderKey(holder: HolderRef): string {
  return `${holder.type}:${holder.id}`;
}

function sameHolder(a: HolderRef | null | undefined, b: HolderRef | null | undefined): boolean {
  if (!a || !b) return false;
  return a.type === b.type && a.id === b.id;
}

function compareHolders(a: HolderRef, b: HolderRef): number {
  const byType = a.type.localeCompare(b.type);
  if (byType !== 0) return byType;
  return a.id.localeCompare(b.id);
}

/** 校验持股人是否指向世界中真实存在的主体。 */
function holderIsValid(world: WorldState, holder: HolderRef): boolean {
  if (!holder || typeof holder.id !== 'string' || holder.id.length === 0) return false;
  switch (holder.type) {
    case 'player':
      return holder.id === PLAYER_ID || holder.id === world.player?.name;
    case 'company':
      return (world.companies ?? []).some((company) => company.id === holder.id);
    case 'investorGroup':
      return (world.investors ?? []).some((group) => group.id === holder.id);
    case 'city':
      return (world.cities ?? []).some((city) => city.id === holder.id);
    // v0.7：AI 经营者以个人身份持股；托管持股（trust）由破产清算写入持股账本。
    case 'operator':
      return (world.management?.operators ?? []).some((operator) => operator.id === holder.id);
    case 'trust':
      return holder.id.startsWith('trust-');
    default:
      return false;
  }
}

/** 持股人的中文显示名；未知主体回退到 id。 */
function holderLabel(world: WorldState, holder: HolderRef): string {
  if (holder.type === 'player') {
    const name = world.player?.name ?? '';
    return name ? `玩家 · ${name}` : '玩家';
  }
  if (holder.type === 'company') {
    const company = (world.companies ?? []).find((candidate) => candidate.id === holder.id);
    return company?.name ?? holder.id;
  }
  if (holder.type === 'investorGroup') {
    const group = (world.investors ?? []).find((candidate) => candidate.id === holder.id);
    return group?.name ?? holder.id;
  }
  if (holder.type === 'city') {
    const city = (world.cities ?? []).find((candidate) => candidate.id === holder.id);
    return city ? `${city.name}市政府` : holder.id;
  }
  return holder.id;
}

function votingClassIds(world: WorldState, companyId: string): Set<string> {
  const ids = new Set<string>();
  for (const shareClass of world.securities?.classes ?? []) {
    if (shareClass.companyId === companyId && shareClass.kind === 'voting') {
      ids.add(shareClass.id);
    }
  }
  return ids;
}

/** 企业全部投票权持有人，按股数降序、持股人类型 + id 升序。 */
function votingHoldersOf(world: WorldState, companyId: string): { holder: HolderRef; shares: number }[] {
  const classIds = votingClassIds(world, companyId);
  if (classIds.size === 0) return [];

  const totals = new Map<string, { holder: HolderRef; shares: number }>();
  for (const holding of world.securities?.holdings ?? []) {
    if (holding.companyId !== companyId) continue;
    if (!classIds.has(holding.shareClassId)) continue;
    if (!(holding.shares > 0)) continue;
    // v0.7：托管持股无表决权；AI 经营者持股首版暂不参与表决（避免与不变量口径冲突）。
    if (holding.holder.type === 'trust' || holding.holder.type === 'operator') continue;
    if (!holderIsValid(world, holding.holder)) continue;
    const key = holderKey(holding.holder);
    const existing = totals.get(key);
    if (existing) {
      existing.shares += holding.shares;
    } else {
      totals.set(key, { holder: { type: holding.holder.type, id: holding.holder.id }, shares: holding.shares });
    }
  }

  const result = [...totals.values()].map((entry) => ({
    holder: entry.holder,
    shares: round2(entry.shares),
  }));
  result.sort((a, b) => b.shares - a.shares || compareHolders(a.holder, b.holder));
  return result;
}

/** 某持股人在某企业的投票权股数（只统计 voting 类别）。 */
function holderVotingShares(world: WorldState, companyId: string, holder: HolderRef): number {
  const entry = votingHoldersOf(world, companyId).find((candidate) => sameHolder(candidate.holder, holder));
  return entry ? round2(entry.shares) : 0;
}

/** 创建议案时冻结的投票权登记日快照（经营者选任也复用它，因此导出）。 */
export function votingSnapshot(world: WorldState, companyId: string): VotingEntitlement[] {
  return votingHoldersOf(world, companyId).map((entry) => ({
    holder: { type: entry.holder.type, id: entry.holder.id },
    shares: round2(entry.shares),
  }));
}

/** 议案快照中某持有人的可投票股数；不在快照内为 0。 */
export function eligibleSharesOf(motion: Motion, holder: HolderRef): number {
  const entry = (motion.eligible ?? []).find((candidate) => sameHolder(candidate.holder, holder));
  return entry ? round2(entry.shares) : 0;
}

/** 议案快照中的全部合格投票人（确定性顺序）。 */
export function eligibleHoldersOf(motion: Motion): VotingEntitlement[] {
  return [...(motion.eligible ?? [])]
    .filter((entry) => entry.shares > 0)
    .sort((a, b) => b.shares - a.shares || compareHolders(a.holder, b.holder));
}

/** 玩家在该议案登记日的可投票股数（用于通知与界面）。 */
export function playerEligibleShares(_world: WorldState, motion: Motion): number {
  return eligibleSharesOf(motion, { type: 'player', id: PLAYER_ID });
}

function ensureGovernanceState(world: WorldState): void {
  if (!world.governance) {
    world.governance = { boards: [], motions: [], controls: [] };
  }
  if (!Array.isArray(world.governance.boards)) world.governance.boards = [];
  if (!Array.isArray(world.governance.motions)) world.governance.motions = [];
  if (!Array.isArray(world.governance.controls)) world.governance.controls = [];
}

function sortedCompanies(world: WorldState) {
  return [...world.companies].sort((a, b) => a.id.localeCompare(b.id));
}

function makeSeat(
  holder: HolderRef,
  shares: number,
  previousSeats: BoardSeat[],
  tick: number,
): BoardSeat {
  const previous = previousSeats.find((seat) => sameHolder(seat.holder, holder));
  return {
    holder: { type: holder.type, id: holder.id },
    votingShares: round2(shares),
    sinceTick: previous ? previous.sinceTick : tick,
  };
}

function buildBoard(
  world: WorldState,
  companyId: string,
  seatCount: number,
  previous: Board | undefined,
  tick: number,
): Board {
  const holders = votingHoldersOf(world, companyId);
  const previousSeats = previous?.seats ?? [];
  let seats: BoardSeat[] = [];

  if (holders.length > 0 && seatCount > 0) {
    if (holders.length <= seatCount) {
      // 持有人少于席位：一人一席补足，剩余席位留空。
      seats = holders.map((entry) => makeSeat(entry.holder, entry.shares, previousSeats, tick));
    } else {
      // 最大余数法；同一持有人持有多席时重复列出（BoardSeat 暂无席位数字段）。
      const allocation = allocateProportionally(
        seatCount,
        holders.map((entry) => entry.shares),
      );
      holders.forEach((entry, index) => {
        const count = allocation[index] ?? 0;
        for (let seat = 0; seat < count; seat++) {
          seats.push(makeSeat(entry.holder, entry.shares, previousSeats, tick));
        }
      });
      if (seats.length > seatCount) seats = seats.slice(0, seatCount);
    }
  }

  seats.sort(
    (a, b) => b.votingShares - a.votingShares || compareHolders(a.holder, b.holder),
  );

  return {
    companyId,
    seats,
    chair: holders[0] ? { type: holders[0].holder.type, id: holders[0].holder.id } : null,
    lastElectionTick: tick,
    note: BOARD_NOTE,
  };
}

/** 补齐缺失的治理记录；幂等，可每 tick 调用。 */
export function ensureGovernance(world: WorldState, config: DemoConfig, tick: number): void {
  ensureGovernanceState(world);

  for (const company of sortedCompanies(world)) {
    const hasControl = world.governance.controls.some((control) => control.companyId === company.id);
    if (!hasControl) {
      const control: CompanyControl = {
        companyId: company.id,
        operator: 'management',
        basis: 'management',
        sinceTick: tick,
        operatorId: null,
        termEndTick: null,
        note: MANAGEMENT_NOTE,
      };
      world.governance.controls.push(control);
    }
  }

  // 兼容旧存档：旧 control 没有 v0.4 的经营者字段，补齐默认值（不改变既有控制关系）。
  for (const control of world.governance.controls) {
    if (control.operatorId === undefined) control.operatorId = null;
    if (control.termEndTick === undefined) control.termEndTick = null;
  }

  refreshBoards(world, config, tick);

  const boardCompanyIds = new Set(world.governance.boards.map((board) => board.companyId));
  for (const company of sortedCompanies(world)) {
    if (boardCompanyIds.has(company.id)) continue;
    world.governance.boards.push(buildBoard(world, company.id, 0, undefined, tick));
  }
}

/** 重新选举全部董事会；保留同一持股人的在任起始 tick。 */
export function refreshBoards(world: WorldState, config: DemoConfig, tick: number): Board[] {
  ensureGovernanceState(world);
  const seatCount = Math.max(0, Math.floor(config.governance.boardSeats));
  const previousBoards = new Map(world.governance.boards.map((board) => [board.companyId, board]));

  const boards = sortedCompanies(world).map((company) =>
    buildBoard(world, company.id, seatCount, previousBoards.get(company.id), tick),
  );
  world.governance.boards = boards;
  return boards;
}

export function boardFor(world: WorldState, companyId: string): Board | null {
  return world.governance?.boards.find((board) => board.companyId === companyId) ?? null;
}

export function openDividendPolicyMotion(
  world: WorldState,
  config: DemoConfig,
  tick: number,
): Motion | null {
  ensureGovernanceState(world);

  let firstProposed: Motion | null = null;
  let proposedCount = 0;

  for (const company of sortedCompanies(world)) {
    if (proposedCount >= 3) break;
    if (!((company.lastMonth?.profit ?? 0) > config.governance.minProfitForMotion)) continue;
    if (!(company.dividendPayoutRatio < 1)) continue;
    const hasOpenMotion = world.governance.motions.some(
      (motion) =>
        motion.companyId === company.id &&
        motion.kind === 'dividendPolicy' &&
        motion.status === 'open',
    );
    if (hasOpenMotion) continue;

    const board = boardFor(world, company.id);
    const proposer =
      board?.chair ??
      votingHoldersOf(world, company.id)[0]?.holder ??
      null;
    if (!proposer) continue;

    const motion: Motion = {
      id: nextMotionId(world, `${company.id}-dividend-${tick}`),
      companyId: company.id,
      kind: 'dividendPolicy',
      title: '提高股息派发比例至 100%',
      proposedBy: { type: proposer.type, id: proposer.id },
      createdTick: tick,
      closesAtTick: tick + config.governance.motionOpenTicks,
      params: { ratio: 1 },
      status: 'open',
      eligible: votingSnapshot(world, company.id),
      votes: [],
      decidedTick: null,
      result: '',
      note: MOTION_NOTE,
    };
    world.governance.motions.push(motion);
    proposedCount += 1;
    if (!firstProposed) firstProposed = motion;
  }

  return firstProposed;
}

/**
 * 创建经营者选任议案（供 management/elections 开启选任时复用）。
 *
 * - 候选人由调用方在创建时固定（Motion.candidates）；
 * - eligible 使用创建时的登记日投票权快照；
 * - 同一企业同时最多一个 open 的选任议案（返回 null 表示已有在表决的选任）；
 * - params 只放 number|string（termMonths/trigger），符合存档校验约束。
 */
export function openElectionMotion(
  world: WorldState,
  company: Company,
  config: DemoConfig,
  tick: number,
  trigger: ElectionTrigger,
  candidates: MotionCandidate[],
  proposedBy: HolderRef,
  log?: LogEntry[],
): Motion | null {
  ensureGovernanceState(world);
  if (candidates.length === 0) return null;
  const hasOpen = world.governance.motions.some(
    (motion) =>
      motion.companyId === company.id &&
      motion.kind === 'operatorElection' &&
      motion.status === 'open',
  );
  if (hasOpen) return null;

  const motion: Motion = {
    id: nextMotionId(world, `${company.id}-election-${tick}`),
    companyId: company.id,
    kind: 'operatorElection',
    title: `${company.name} 经营者选任（${ELECTION_TRIGGER_LABELS[trigger]}）`,
    proposedBy: { type: proposedBy.type, id: proposedBy.id },
    createdTick: tick,
    closesAtTick: tick + Math.max(1, Math.floor(config.management.electionOpenTicks)),
    params: { termMonths: config.management.termMonths, trigger },
    candidates: candidates.map((candidate) => ({ ...candidate })),
    status: 'open',
    eligible: votingSnapshot(world, company.id),
    votes: [],
    decidedTick: null,
    result: '',
    note: ELECTION_NOTE,
  };
  world.governance.motions.push(motion);
  if (log) {
    log.push({
      tick,
      kind: 'player',
      message: `股东选任议案：${company.name} 开启经营者选任（${ELECTION_TRIGGER_LABELS[trigger]}），候选人 ${candidates.length} 名，投票期至第 ${motion.closesAtTick} 月。`,
    });
  }
  return motion;
}

/** 记录一张表决票；同一持股人改票时覆盖旧记录（演示便利）。 */
export function castVote(
  world: WorldState,
  motionId: string,
  holder: HolderRef,
  vote: 'for' | 'against' | 'abstain',
  tick: number,
): { ok: boolean; error?: string } {
  ensureGovernanceState(world);
  const motion = world.governance.motions.find((candidate) => candidate.id === motionId);
  if (!motion) return { ok: false, error: '议案不存在' };
  if (motion.status !== 'open') return { ok: false, error: '议案已结束表决' };
  if (!holderIsValid(world, holder)) return { ok: false, error: '持股人无效' };

  // 以议案创建时的登记日快照为准：期间受让股份的新持有人不能重复使用同一批票。
  const shares = eligibleSharesOf(motion, holder);
  if (!(shares > 0)) {
    return { ok: false, error: '该持股人不在本议案登记日的投票权名单内' };
  }

  const voteRecord: MotionVote = {
    holder: { type: holder.type, id: holder.id },
    vote,
    votingShares: round2(shares),
    tick,
  };
  const existingIndex = motion.votes.findIndex((candidate) => sameHolder(candidate.holder, holder));
  if (existingIndex >= 0) {
    // 演示便利：允许改票，直接覆盖原记录，避免出现重复票。
    motion.votes[existingIndex] = voteRecord;
  } else {
    motion.votes.push(voteRecord);
  }
  motion.votes.sort((a, b) => compareHolders(a.holder, b.holder));
  return { ok: true };
}

/** 未投票的自动立场（玩家除外，玩家缺席视为弃权）。 */
export function autoCastVotes(world: WorldState, config: DemoConfig, tick: number): void {
  void config;
  ensureGovernanceState(world);

  const openMotions = [...world.governance.motions]
    .filter((motion) => motion.status === 'open')
    .sort((a, b) => a.id.localeCompare(b.id));

  for (const motion of openMotions) {
    // 经营者选任是多候选人计票，不适用“赞成/反对”二元投票；
    // 自动投票由 management/elections.autoCastElectionVotes 处理，这里必须跳过。
    if (motion.kind === 'operatorElection') continue;
    // 只对登记日快照内的持有人自动投票；新受让人不获得本次议案的票。
    const holders = eligibleHoldersOf(motion);
    for (const { holder } of holders) {
      if (holder.type === 'player') continue;
      const alreadyVoted = motion.votes.some((vote) => sameHolder(vote.holder, holder));
      if (alreadyVoted) continue;
      const choice: MotionVote['vote'] =
        holder.type === 'investorGroup'
          ? 'for' // 居民投资实体偏好现金流（暂定）。
          : holder.type === 'company'
            ? 'against' // 企业股东倾向保留资金（暂定）。
            : holder.type === 'city'
              ? 'abstain' // 政府股东默认弃权，不自动替城市做经营决策（暂定）。
              : 'abstain';
      castVote(world, motion.id, holder, choice, tick);
    }
  }
}

function motionShareTotals(motion: Motion): { forShares: number; againstShares: number } {
  let forShares = 0;
  let againstShares = 0;
  for (const vote of motion.votes) {
    if (vote.vote === 'for') forShares += vote.votingShares;
    else if (vote.vote === 'against') againstShares += vote.votingShares;
  }
  return { forShares: round2(forShares), againstShares: round2(againstShares) };
}

function operatorLabel(world: WorldState, operator: HolderRef | 'management'): string {
  if (operator === 'management') return '职业经理人';
  return holderLabel(world, operator);
}

function applyMotion(
  world: WorldState,
  motion: Motion,
  tick: number,
  log: LogEntry[],
): { effect: string } {
  const company = world.companies.find((candidate) => candidate.id === motion.companyId);
  if (!company) return { effect: '' };

  if (motion.kind === 'dividendPolicy') {
    const ratio = round2(clamp(Number(motion.params.ratio), 0, 1));
    company.dividendPayoutRatio = ratio;
    const percent = Math.round(ratio * 100);
    log.push({
      tick,
      kind: 'player',
      message: `股东表决通过：${company.name} 股息派发比例调整为 ${percent}%。`,
    });
    return { effect: `股息派发比例调整为 ${percent}%` };
  }

  if (motion.kind === 'operatorAppointment') {
    const operatorType = String(motion.params.operatorType ?? 'management');
    const operator: HolderRef | 'management' =
      operatorType === 'management'
        ? 'management'
        : {
            type: operatorType as HolderType,
            id: String(motion.params.operatorId ?? ''),
          };

    let control = world.governance.controls.find((candidate) => candidate.companyId === company.id);
    if (!control) {
      control = {
        companyId: company.id,
        operator: 'management',
        basis: 'management',
        sinceTick: tick,
        operatorId: null,
        termEndTick: null,
        note: MANAGEMENT_NOTE,
      };
      world.governance.controls.push(control);
    }
    control.operator = operator;
    control.basis = 'boardAppointment';
    control.sinceTick = tick;
    // 董事会任命的持有人经营者不是 AI 经营者档案；任期字段清空（玩家/AI 选任另走 operatorElection）。
    control.operatorId = null;
    control.termEndTick = null;
    control.note = '演示：经股东议案表决更换经营者；持股本身仍不直接控制企业。';

    log.push({
      tick,
      kind: 'player',
      message: `股东表决通过：${company.name} 的经营者变更为 ${operatorLabel(world, operator)}。`,
    });
    return { effect: `经营者变更为 ${operatorLabel(world, operator)}` };
  }

  return { effect: '' };
}

/** 对到期议案计票并应用结果；返回本期关闭的议案。 */
export function closeMotions(
  world: WorldState,
  config: DemoConfig,
  tick: number,
  log: LogEntry[],
): Motion[] {
  ensureGovernanceState(world);

  const due = world.governance.motions
    .filter((motion) => motion.status === 'open' && tick >= motion.closesAtTick)
    .sort((a, b) => a.closesAtTick - b.closesAtTick || a.id.localeCompare(b.id));

  const closed: Motion[] = [];
  for (const motion of due) {
    const company = world.companies.find((candidate) => candidate.id === motion.companyId);

    // 经营者选任：多候选人计票，不走“赞成>反对”的二元规则。
    if (motion.kind === 'operatorElection') {
      motion.decidedTick = tick;
      const { winnerCandidateId, result } = tallyElection(world, motion, config, tick);
      if (winnerCandidateId) {
        applyOperatorElectionResult(world, motion, config, tick);
        motion.status = 'passed';
        if (!motion.result) motion.result = result;
      } else {
        motion.status = 'rejected';
        motion.result = result;
        log.push({
          tick,
          kind: 'warning',
          message: `经营者选任未产生当选人：${company?.name ?? motion.companyId}。${result}`,
        });
      }
      closed.push(motion);
      continue;
    }

    const { forShares, againstShares } = motionShareTotals(motion);
    const passed = forShares > againstShares;
    motion.decidedTick = tick;

    if (passed) {
      const { effect } = applyMotion(world, motion, tick, log);
      motion.status = 'passed';
      motion.result = `通过：赞成 ${forShares} 股，反对 ${againstShares} 股${effect ? `；${effect}` : ''}。`;
    } else {
      motion.status = 'rejected';
      motion.result = `未通过：赞成 ${forShares} 股，反对 ${againstShares} 股。`;
      log.push({
        tick,
        kind: 'player',
        message: `股东表决未通过：${company?.name ?? motion.companyId} 的「${motion.title}」。赞成 ${forShares} 股，反对 ${againstShares} 股。`,
      });
    }
    closed.push(motion);
  }

  return closed;
}

function nextMotionId(world: WorldState, base: string): string {
  let id = `motion-${base}`;
  let suffix = 2;
  while (world.governance.motions.some((motion) => motion.id === id)) {
    id = `motion-${base}-${suffix}`;
    suffix += 1;
  }
  return id;
}

function validOperatorType(value: string): value is HolderType {
  return value === 'player' || value === 'company' || value === 'investorGroup';
}

/** 提出更换经营者的议案；提案人必须是投票权持有人或现任董事。 */
export function proposeOperatorMotion(
  world: WorldState,
  companyId: string,
  proposedBy: HolderRef,
  operator: HolderRef | 'management',
  tick: number,
  config: DemoConfig,
  log?: LogEntry[],
): { ok: boolean; error?: string; motion?: Motion } {
  ensureGovernanceState(world);
  const company = world.companies.find((candidate) => candidate.id === companyId);
  if (!company) return { ok: false, error: '企业不存在' };
  if (!holderIsValid(world, proposedBy)) return { ok: false, error: '提案人无效' };

  const isVotingHolder = holderVotingShares(world, companyId, proposedBy) > 0;
  const isBoardMember = boardFor(world, companyId)?.seats.some((seat) =>
    sameHolder(seat.holder, proposedBy),
  );
  if (!isVotingHolder && !isBoardMember) {
    return { ok: false, error: '只有投票权持有人或董事可以提案' };
  }

  const hasOpenOperatorMotion = world.governance.motions.some(
    (motion) =>
      motion.companyId === companyId &&
      motion.kind === 'operatorAppointment' &&
      motion.status === 'open',
  );
  if (hasOpenOperatorMotion) return { ok: false, error: '该企业已有待表决的经营者议案' };

  let params: Record<string, number | string>;
  let operatorText: string;
  if (operator === 'management') {
    params = { operatorType: 'management' };
    operatorText = '职业经理人';
  } else {
    if (!validOperatorType(operator.type) || !operator.id) {
      return { ok: false, error: '拟任经营者无效' };
    }
    params = { operatorType: operator.type, operatorId: operator.id };
    operatorText = holderLabel(world, operator);
  }

  const motion: Motion = {
    id: nextMotionId(world, `${companyId}-operator-${tick}`),
    companyId,
    kind: 'operatorAppointment',
    title: `改选经营者：${operatorText}`,
    proposedBy: { type: proposedBy.type, id: proposedBy.id },
    createdTick: tick,
    closesAtTick: tick + config.governance.motionOpenTicks,
    params,
    status: 'open',
    eligible: votingSnapshot(world, companyId),
    votes: [],
    decidedTick: null,
    result: '',
    note: MOTION_NOTE,
  };
  world.governance.motions.push(motion);

  if (log) {
    log.push({
      tick,
      kind: 'player',
      message: `股东提案：${company.name} 拟改选经营者为 ${operatorText}，进入表决期。`,
    });
  }

  return { ok: true, motion };
}

export function governanceFor(
  world: WorldState,
  companyId: string,
): { board: Board | null; control: CompanyControl | null; motions: Motion[] } {
  const board = boardFor(world, companyId);
  const control = world.governance?.controls.find((candidate) => candidate.companyId === companyId) ?? null;
  const motions = (world.governance?.motions ?? [])
    .filter((motion) => motion.companyId === companyId)
    .sort((a, b) => a.createdTick - b.createdTick || a.id.localeCompare(b.id));
  return { board, control, motions };
}
