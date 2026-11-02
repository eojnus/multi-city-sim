// 经营者、人才市场、企业选任与玩家经营模式的测试。
//
// 使用真实 createInitialWorld()（世界初始化会调用 createInitialManagement），
// 局部修改股权/控制权来构造选任与玩家经营场景；所有金额与阈值都来自 config，
// 不依赖硬编码的游戏数值（测试自定义阈值时通过 makeConfig 覆盖）。

import { describe, expect, it } from 'vitest';
import { DEMO_CONFIG } from '../src/data/config';
import type { DemoConfig } from '../src/data/config';
import { createInitialWorld } from '../src/simulation/core/initializer';
import {
  availableOperators,
  createInitialManagement,
  currentOperator,
  currentStyle,
  ensureOperators,
  generateOperator,
  operatorById,
  operatorNameFor,
  pruneOperatorPool,
  releaseOperator,
} from '../src/simulation/management/manager-pool';
import {
  autoCastElectionVotes,
  castElectionVote,
  electionCandidates,
  maybeOpenElections,
  openOperatorElection,
  playerHoldsVotingShares,
  registerPlayerCandidate,
  tallyElection,
} from '../src/simulation/management/elections';
import {
  canOperate,
  decideProposal,
  ensurePlayerOperations,
  expireProposals,
  planPlayerOperatedCompany,
  playerOperationFor,
  playerOperatedCompanies,
  proposalView,
  setAuthorization,
  setOperationMode,
  setStandingPlan,
} from '../src/simulation/management/operations';
import {
  autoCastVotes,
  castVote,
  closeMotions,
} from '../src/simulation/corporate-governance/governance';
import {
  createShareStructure,
  shareClassId,
  transferShares,
} from '../src/simulation/securities/securities';
import type { Company, HolderRef, LogEntry, WorldState } from '../src/simulation/contracts/types';

const PLAYER: HolderRef = { type: 'player', id: 'player' };

function investor(index: number): HolderRef {
  return { type: 'investorGroup', id: `lanport-invest${index}` };
}

/** 只覆盖本测试关心的重大事项阈值，其余参数保持 DEMO_CONFIG。 */
function makeConfig(
  patch: Partial<{
    investmentAmount: number;
    hireCount: number;
    loanAmount: number;
    priceChangeRatio: number;
  }> = {},
): DemoConfig {
  return {
    ...DEMO_CONFIG,
    management: {
      ...DEMO_CONFIG.management,
      majorThresholds: { ...DEMO_CONFIG.management.majorThresholds, ...patch },
    },
  } as unknown as DemoConfig;
}

function companyOf(world: WorldState, companyId: string): Company {
  const company = world.companies.find((candidate) => candidate.id === companyId);
  if (!company) throw new Error(`缺少企业 ${companyId}`);
  return company;
}

function controlOf(world: WorldState, companyId: string) {
  const control = world.governance.controls.find((entry) => entry.companyId === companyId);
  if (!control) throw new Error(`缺少控制记录 ${companyId}`);
  return control;
}

/** 用指定投票权分布替换某企业的股权结构（测试隔离）。 */
function seedVoting(
  world: WorldState,
  companyId: string,
  voting: { holder: HolderRef; shares: number }[],
  nonVoting: { holder: HolderRef; shares: number }[] = [],
): void {
  const company = companyOf(world, companyId);
  createShareStructure(world, company, {
    votingShares: voting.reduce((total, entry) => total + entry.shares, 0),
    nonVotingShares: nonVoting.reduce((total, entry) => total + entry.shares, 0),
    votingHolders: voting,
    nonVotingHolders: nonVoting,
    tick: world.time.tick,
    acquiredVia: 'migration',
  });
}

/** 把企业控制权改成玩家经营（测试用，等价于玩家在选任中当选后的状态）。 */
function makePlayerOperator(world: WorldState, companyId: string, tick = 0): void {
  const control = controlOf(world, companyId);
  if (control.operatorId) releaseOperator(world, control.operatorId, tick, '测试：玩家接管');
  control.operator = { type: 'player', id: 'player' };
  control.operatorId = null;
  control.basis = 'election';
  control.sinceTick = tick;
  control.termEndTick = tick + DEMO_CONFIG.management.termMonths;
  control.note = '测试：玩家经营';
}

/** 制造职位空缺（原经营者离任）。 */
function makeVacancy(world: WorldState, companyId: string, tick = 0): void {
  const control = controlOf(world, companyId);
  if (control.operatorId) releaseOperator(world, control.operatorId, tick, '测试：制造空缺');
}

function openElectionFor(world: WorldState, companyId: string, config: DemoConfig = DEMO_CONFIG) {
  const logs: LogEntry[] = [];
  const result = openOperatorElection(
    world,
    companyOf(world, companyId),
    config,
    world.time.tick,
    'termEnd',
    logs,
  );
  return { result, logs };
}

describe('初始经营者与人才市场', () => {
  it('每家企业都有在任经营者，AI 经营者不会同时任职两家，风格沿用旧企业风格', () => {
    const world = createInitialWorld();
    expect(world.management.operators.length).toBeGreaterThan(world.companies.length);
    expect(world.management.operators.filter((operator) => operator.status === 'available').length).toBeGreaterThan(0);

    const employedIds = new Map<string, number>();
    for (const company of world.companies) {
      const control = controlOf(world, company.id);
      expect(control.operator).toBe('management');
      expect(control.operatorId).toBeTruthy();
      expect(control.basis).toBe('election');
      expect(control.termEndTick).toBe(DEMO_CONFIG.management.termMonths);

      const operator = currentOperator(world, company.id);
      expect(operator).not.toBeNull();
      expect(operator!.status).toBe('employed');
      expect(operator!.companyId).toBe(company.id);
      // 旧存档行为不突变：经营者风格 = 企业原本的 ai.style。
      expect(operator!.style).toBe(company.ai.style);
      expect(currentStyle(world, company)).toBe(company.ai.style);
      employedIds.set(operator!.id, (employedIds.get(operator!.id) ?? 0) + 1);
    }
    // 同一名 AI 经营者不会出现在两家企业。
    expect([...employedIds.values()].every((count) => count === 1)).toBe(true);
    // 人才市场按城市控制规模。
    for (const city of world.cities) {
      expect(availableOperators(world, city.id).length).toBeGreaterThan(0);
      expect(availableOperators(world, city.id).length).toBeLessThanOrEqual(
        DEMO_CONFIG.management.maxPoolPerCity,
      );
    }
  });

  it('ensureOperators 幂等；旧存档迁移后风格保持且不会重复生成经营者', () => {
    const world = createInitialWorld();
    // 模拟旧存档：没有 management 状态，control 也没有经营者字段。
    world.management = { operators: [], playerOperations: [], nextOperatorNumber: 1 };
    for (const control of world.governance.controls) {
      control.operatorId = null;
      control.termEndTick = null;
      control.basis = 'management';
    }
    const migrated = createInitialManagement(world, DEMO_CONFIG, 7);
    expect(migrated.operators.length).toBeGreaterThan(0);
    for (const company of world.companies) {
      const operator = currentOperator(world, company.id);
      expect(operator).not.toBeNull();
      expect(operator!.style).toBe(company.ai.style);
    }

    const operatorIds = world.management.operators.map((operator) => operator.id).sort();
    const controlSnapshot = JSON.stringify(world.governance.controls);
    ensureOperators(world, DEMO_CONFIG, 8);
    expect(world.management.operators.map((operator) => operator.id).sort()).toEqual(operatorIds);
    expect(JSON.stringify(world.governance.controls)).toBe(controlSnapshot);
    // 第二次 createInitialManagement 也不会重复生成人才池。
    const countBefore = world.management.operators.length;
    createInitialManagement(world, DEMO_CONFIG, 9);
    expect(world.management.operators.length).toBe(countBefore);
  });

  it('人才池超上限时保留全部档案（不删人）并留下提示日志', () => {
    const world = createInitialWorld();
    const cityId = 'lanport';
    for (let index = 0; index < 20; index++) generateOperator(world, cityId, 0);
    const before = availableOperators(world, cityId).length;
    expect(before).toBeGreaterThan(DEMO_CONFIG.management.maxPoolPerCity);
    const idsBefore = world.management.operators.map((operator) => operator.id).sort();
    pruneOperatorPool(world, DEMO_CONFIG, 3);
    // 验收问题 6：落选者必须留在人才市场，档案/履历不得被删除。
    expect(world.management.operators.map((operator) => operator.id).sort()).toEqual(idsBefore);
    expect(availableOperators(world, cityId).length).toBe(before);
    expect(world.log.some((entry) => entry.message.includes('人才市场调整'))).toBe(true);
    // 同一城市同一条提示不重复堆叠。
    pruneOperatorPool(world, DEMO_CONFIG, 4);
    const adjustmentLogs = world.log.filter((entry) =>
      entry.message.includes('人才市场调整'),
    );
    expect(adjustmentLogs).toHaveLength(1);
  });
});

describe('选任候选人规则', () => {
  it('有现任时提供 3 名候选人且现任在列，其他候选人来自人才市场', () => {
    const world = createInitialWorld();
    const { result } = openElectionFor(world, 'lp-food');
    expect(result.ok).toBe(true);

    const motion = world.governance.motions.find(
      (entry) => entry.kind === 'operatorElection' && entry.companyId === 'lp-food',
    )!;
    expect(motion.candidates).toHaveLength(DEMO_CONFIG.management.candidatesPerElection);
    expect(motion.candidates![0]!.isIncumbent).toBe(true);
    expect(motion.candidates![0]!.candidateId).toBe(controlOf(world, 'lp-food').operatorId);
    expect(motion.candidates!.filter((candidate) => candidate.isIncumbent)).toHaveLength(1);
    expect(new Set(motion.candidates!.map((candidate) => candidate.candidateId)).size).toBe(
      motion.candidates!.length,
    );
    for (const candidate of motion.candidates!.slice(1)) {
      expect(candidate.kind).toBe('ai');
      const operator = operatorById(world, candidate.operatorId!);
      expect(operator?.status).toBe('available');
    }
    // 议案进入治理记录，等待计票。
    expect(motion.status).toBe('open');
    expect(motion.eligible.length).toBeGreaterThan(0);
  });

  it('无现任时提供 3 名非现任候选人', () => {
    const world = createInitialWorld();
    makeVacancy(world, 'lp-food');
    const { result } = openElectionFor(world, 'lp-food');
    expect(result.ok).toBe(true);
    const motion = world.governance.motions.find(
      (entry) => entry.kind === 'operatorElection' && entry.companyId === 'lp-food',
    )!;
    expect(motion.candidates).toHaveLength(DEMO_CONFIG.management.candidatesPerElection);
    expect(motion.candidates!.every((candidate) => !candidate.isIncumbent)).toBe(true);
    expect(motion.eligible.length).toBeGreaterThan(0);
    expect(motion.params.termMonths).toBe(DEMO_CONFIG.management.termMonths);
  });
});

describe('选任投票与计票', () => {
  it('登记日快照：投票期内转手，受让方不能重复使用同一批票', () => {
    const world = createInitialWorld();
    seedVoting(world, 'lp-food', [
      { holder: PLAYER, shares: 1000 },
      { holder: { type: 'company', id: 'lp-garment' }, shares: 1000 },
    ]);
    const { result } = openElectionFor(world, 'lp-food');
    expect(result.ok).toBe(true);
    const motion = world.governance.motions.find(
      (entry) => entry.kind === 'operatorElection' && entry.companyId === 'lp-food',
    )!;
    const challenger = motion.candidates!.find((candidate) => !candidate.isIncumbent)!;

    expect(castElectionVote(world, motion.id, PLAYER, challenger.candidateId, 0).ok).toBe(true);
    // 把票转给不在登记日快照内的受让方。
    const outsider: HolderRef = { type: 'company', id: 'lp-appliance' };
    expect(
      transferShares(world, 'lp-food', shareClassId('lp-food', 'voting'), PLAYER, outsider, 1000, 0),
    ).toBe(true);

    const outsiderVote = castElectionVote(world, motion.id, outsider, challenger.candidateId, 0);
    expect(outsiderVote.ok).toBe(false);
    expect(outsiderVote.error).toContain('登记日');
    // 原登记股东仍按登记日股数投票，且改票不会重复计票。
    expect(castElectionVote(world, motion.id, PLAYER, challenger.candidateId, 0).ok).toBe(true);
    expect(motion.votes.filter((vote) => vote.holder.id === 'player')).toHaveLength(1);
    expect(motion.votes.find((vote) => vote.holder.id === 'player')!.votingShares).toBe(1000);
  });

  it('平票时现任优先', () => {
    const world = createInitialWorld();
    seedVoting(world, 'lp-food', [
      { holder: investor(1), shares: 500 },
      { holder: investor(2), shares: 500 },
    ]);
    const { result } = openElectionFor(world, 'lp-food');
    expect(result.ok).toBe(true);
    const motion = world.governance.motions.find(
      (entry) => entry.kind === 'operatorElection' && entry.companyId === 'lp-food',
    )!;
    const incumbent = motion.candidates!.find((candidate) => candidate.isIncumbent)!;
    const challenger = motion.candidates!.find((candidate) => !candidate.isIncumbent)!;

    expect(castElectionVote(world, motion.id, investor(1), incumbent.candidateId, 0).ok).toBe(true);
    expect(castElectionVote(world, motion.id, investor(2), challenger.candidateId, 0).ok).toBe(true);
    const tally = tallyElection(world, motion, DEMO_CONFIG, 0);
    expect(tally.winnerCandidateId).toBe(incumbent.candidateId);
    expect(tally.result).toContain('现任');
  });

  it('无现任且平票时按 candidateId 字典序确定性排序', () => {
    const world = createInitialWorld();
    makeVacancy(world, 'lp-food');
    seedVoting(world, 'lp-food', [
      { holder: investor(1), shares: 500 },
      { holder: investor(2), shares: 500 },
    ]);
    const { result } = openElectionFor(world, 'lp-food');
    expect(result.ok).toBe(true);
    const motion = world.governance.motions.find(
      (entry) => entry.kind === 'operatorElection' && entry.companyId === 'lp-food',
    )!;
    const first = motion.candidates![0]!;
    const second = motion.candidates![1]!;
    castElectionVote(world, motion.id, investor(1), first.candidateId, 0);
    castElectionVote(world, motion.id, investor(2), second.candidateId, 0);

    const expected = [first.candidateId, second.candidateId].sort((a, b) => a.localeCompare(b))[0];
    const tally = tallyElection(world, motion, DEMO_CONFIG, 0);
    expect(tally.winnerCandidateId).toBe(expected);
    expect(tally.result).toContain('字典序');
  });

  it('得票最多者当选：落选原经营者回人才市场，当选者上任并设置任期', () => {
    const world = createInitialWorld();
    seedVoting(world, 'lp-food', [
      { holder: investor(1), shares: 600 },
      { holder: investor(2), shares: 400 },
    ]);
    const previousOperatorId = controlOf(world, 'lp-food').operatorId!;
    const { result } = openElectionFor(world, 'lp-food');
    expect(result.ok).toBe(true);
    const motion = world.governance.motions.find(
      (entry) => entry.kind === 'operatorElection' && entry.companyId === 'lp-food',
    )!;
    const challenger = motion.candidates!.find((candidate) => !candidate.isIncumbent)!;
    castElectionVote(world, motion.id, investor(1), challenger.candidateId, 0);
    castElectionVote(world, motion.id, investor(2), challenger.candidateId, 0);

    const closed = closeMotions(world, DEMO_CONFIG, motion.closesAtTick, []);
    expect(closed).toContain(motion);
    expect(motion.status).toBe('passed');

    const control = controlOf(world, 'lp-food');
    expect(control.operatorId).toBe(challenger.operatorId);
    expect(control.basis).toBe('election');
    expect(control.sinceTick).toBe(motion.closesAtTick);
    expect(control.termEndTick).toBe(
      motion.closesAtTick + DEMO_CONFIG.management.termMonths,
    );

    const previous = operatorById(world, previousOperatorId)!;
    expect(previous.status).toBe('available');
    expect(previous.companyId).toBeNull();
    expect(previous.history.length).toBeGreaterThan(0);

    const elected = operatorById(world, challenger.operatorId!)!;
    expect(elected.status).toBe('employed');
    expect(elected.companyId).toBe('lp-food');
    expect(operatorNameFor(world, 'lp-food')).toBe(elected.name);
  });

  it('AI 候选人不会同时任职两家企业（选任也不会制造双任职）', () => {
    const world = createInitialWorld();
    seedVoting(world, 'lp-food', [
      { holder: investor(1), shares: 600 },
      { holder: investor(2), shares: 400 },
    ]);
    const { result } = openElectionFor(world, 'lp-food');
    expect(result.ok).toBe(true);
    const motion = world.governance.motions.find(
      (entry) => entry.kind === 'operatorElection' && entry.companyId === 'lp-food',
    )!;
    const challenger = motion.candidates!.find((candidate) => !candidate.isIncumbent)!;
    castElectionVote(world, motion.id, investor(1), challenger.candidateId, 0);
    castElectionVote(world, motion.id, investor(2), challenger.candidateId, 0);
    closeMotions(world, DEMO_CONFIG, motion.closesAtTick, []);

    const employedIds = new Map<string, number>();
    for (const company of world.companies) {
      const operator = currentOperator(world, company.id);
      if (!operator) continue;
      employedIds.set(operator.id, (employedIds.get(operator.id) ?? 0) + 1);
    }
    expect([...employedIds.values()].every((count) => count === 1)).toBe(true);

    // 已任职者不会再出现在其他企业的候选人名单里。
    const otherCandidates = electionCandidates(
      world,
      companyOf(world, 'lp-garment'),
      DEMO_CONFIG,
      1,
    );
    const electedId = controlOf(world, 'lp-food').operatorId!;
    expect(otherCandidates.some((candidate) => candidate.operatorId === electedId)).toBe(false);
  });
});

describe('选任触发条件', () => {
  it('任期届满触发选任，且同一企业不会每月重复生成议案', () => {
    const world = createInitialWorld();
    const control = controlOf(world, 'lp-food');
    control.termEndTick = 5;
    const logs: LogEntry[] = [];

    maybeOpenElections(world, DEMO_CONFIG, 4, logs);
    expect(
      world.governance.motions.filter(
        (motion) => motion.companyId === 'lp-food' && motion.kind === 'operatorElection',
      ),
    ).toHaveLength(0);

    maybeOpenElections(world, DEMO_CONFIG, 5, logs);
    const opened = world.governance.motions.filter(
      (motion) => motion.companyId === 'lp-food' && motion.kind === 'operatorElection',
    );
    expect(opened).toHaveLength(1);
    expect(opened[0]!.params.trigger).toBe('termEnd');

    maybeOpenElections(world, DEMO_CONFIG, 5, logs);
    maybeOpenElections(world, DEMO_CONFIG, 6, logs);
    expect(
      world.governance.motions.filter(
        (motion) =>
          motion.companyId === 'lp-food' &&
          motion.kind === 'operatorElection' &&
          motion.status === 'open',
      ),
    ).toHaveLength(1);
  });

  it('严重经营问题触发选任，冷却期内不会重复生成议案', () => {
    const world = createInitialWorld();
    const company = companyOf(world, 'lp-food');
    const severe = DEMO_CONFIG.management.severe;
    company.ai.lossMonths = severe.lossMonths;
    company.ai.ageMonths = severe.minAgeMonths;
    company.cash = 0;
    const logs: LogEntry[] = [];

    maybeOpenElections(world, DEMO_CONFIG, 10, logs);
    const opened = world.governance.motions.filter(
      (motion) => motion.companyId === 'lp-food' && motion.kind === 'operatorElection',
    );
    expect(opened).toHaveLength(1);
    expect(opened[0]!.params.trigger).toBe('severeProblem');

    // 模拟该议案被否决结束；冷却期内不应再次触发。
    opened[0]!.status = 'rejected';
    maybeOpenElections(world, DEMO_CONFIG, 11, logs);
    expect(
      world.governance.motions.filter(
        (motion) => motion.companyId === 'lp-food' && motion.kind === 'operatorElection',
      ),
    ).toHaveLength(1);

    // 冷却结束（createdTick + cooldownMonths）后、问题仍在时重新触发。
    maybeOpenElections(world, DEMO_CONFIG, 10 + severe.cooldownMonths, logs);
    expect(
      world.governance.motions.filter(
        (motion) =>
          motion.companyId === 'lp-food' &&
          motion.kind === 'operatorElection' &&
          motion.status === 'open',
      ),
    ).toHaveLength(1);
  });
});

describe('选任议案的自动投票与连任', () => {
  it('二元自动投票跳过选任议案；选任自动投票写入 candidateId 且一人一票', () => {
    const world = createInitialWorld();
    seedVoting(world, 'lp-food', [
      { holder: investor(1), shares: 600 },
      { holder: investor(2), shares: 300 },
      { holder: { type: 'company', id: 'lp-garment' }, shares: 100 },
    ]);
    const { result } = openElectionFor(world, 'lp-food');
    expect(result.ok).toBe(true);
    const motion = world.governance.motions.find(
      (entry) => entry.kind === 'operatorElection' && entry.companyId === 'lp-food',
    )!;

    // 二元自动投票必须跳过选任议案（否则会被写成赞成/反对票）。
    autoCastVotes(world, DEMO_CONFIG, 0);
    expect(motion.votes).toHaveLength(0);

    autoCastElectionVotes(world, DEMO_CONFIG, 0);
    expect(motion.votes.length).toBe(3);
    expect(motion.votes.every((vote) => vote.candidateId !== undefined)).toBe(true);
    expect(motion.votes.every((vote) => vote.vote === 'for')).toBe(true);
    // 投资者群体自动投给现任；票重等于登记日股数。
    const incumbent = motion.candidates!.find((candidate) => candidate.isIncumbent)!;
    expect(
      motion.votes.find((vote) => vote.holder.id === 'lanport-invest1')!.candidateId,
    ).toBe(incumbent.candidateId);
    expect(motion.votes.find((vote) => vote.holder.id === 'lanport-invest1')!.votingShares).toBe(600);
    // 重复调用不会重复加票。
    autoCastElectionVotes(world, DEMO_CONFIG, 0);
    expect(motion.votes).toHaveLength(3);
  });

  it('现任连任时保留控制权起始时间并延长任期，不会产生离任历史', () => {
    const world = createInitialWorld();
    seedVoting(world, 'lp-food', [{ holder: investor(1), shares: 1000 }]);
    const controlBefore = controlOf(world, 'lp-food');
    const incumbentId = controlBefore.operatorId!;
    const incumbentHistory = operatorById(world, incumbentId)!.history.length;
    const sinceBefore = controlBefore.sinceTick;

    const { result } = openElectionFor(world, 'lp-food');
    expect(result.ok).toBe(true);
    const motion = world.governance.motions.find(
      (entry) => entry.kind === 'operatorElection' && entry.companyId === 'lp-food',
    )!;
    const incumbent = motion.candidates!.find((candidate) => candidate.isIncumbent)!;
    castElectionVote(world, motion.id, investor(1), incumbent.candidateId, 0);
    closeMotions(world, DEMO_CONFIG, motion.closesAtTick, []);

    expect(motion.status).toBe('passed');
    const controlAfter = controlOf(world, 'lp-food');
    expect(controlAfter.operatorId).toBe(incumbentId);
    expect(controlAfter.sinceTick).toBe(sinceBefore);
    expect(controlAfter.termEndTick).toBe(
      motion.closesAtTick + DEMO_CONFIG.management.termMonths,
    );
    expect(operatorById(world, incumbentId)!.history.length).toBe(incumbentHistory);
    expect(operatorById(world, incumbentId)!.status).toBe('employed');
  });
});

describe('玩家参选与经营模式', () => {
  it('玩家没有投票权股份不能参选；有投票权可登记且不能重复登记', () => {
    const world = createInitialWorld();
    seedVoting(
      world,
      'lp-food',
      [{ holder: investor(1), shares: 500 }],
      [{ holder: PLAYER, shares: 500 }],
    );
    const { result } = openElectionFor(world, 'lp-food');
    expect(result.ok).toBe(true);
    const motion = world.governance.motions.find(
      (entry) => entry.kind === 'operatorElection' && entry.companyId === 'lp-food',
    )!;
    expect(playerHoldsVotingShares(world, 'lp-food')).toBe(false);
    const rejected = registerPlayerCandidate(world, motion.id, DEMO_CONFIG, 0);
    expect(rejected.ok).toBe(false);
    expect(rejected.error).toContain('投票权');
    expect(motion.candidates!.some((candidate) => candidate.kind === 'player')).toBe(false);

    seedVoting(world, 'lp-food', [{ holder: PLAYER, shares: 1000 }]);
    expect(playerHoldsVotingShares(world, 'lp-food')).toBe(true);
    expect(registerPlayerCandidate(world, motion.id, DEMO_CONFIG, 0).ok).toBe(true);
    const duplicate = registerPlayerCandidate(world, motion.id, DEMO_CONFIG, 0);
    expect(duplicate.ok).toBe(false);
    expect(motion.candidates!.filter((candidate) => candidate.kind === 'player')).toHaveLength(1);
  });

  it('玩家当选后控制权归玩家，并生成独立的默认经营模式', () => {
    const world = createInitialWorld();
    seedVoting(world, 'lp-food', [{ holder: PLAYER, shares: 1000 }]);
    const { result } = openElectionFor(world, 'lp-food');
    expect(result.ok).toBe(true);
    const motion = world.governance.motions.find(
      (entry) => entry.kind === 'operatorElection' && entry.companyId === 'lp-food',
    )!;
    expect(registerPlayerCandidate(world, motion.id, DEMO_CONFIG, 0).ok).toBe(true);
    expect(castElectionVote(world, motion.id, PLAYER, 'player', 0).ok).toBe(true);
    closeMotions(world, DEMO_CONFIG, motion.closesAtTick, []);

    expect(motion.status).toBe('passed');
    const control = controlOf(world, 'lp-food');
    expect(control.operator).toEqual({ type: 'player', id: 'player' });
    expect(control.operatorId).toBeNull();
    expect(control.basis).toBe('election');
    expect(control.termEndTick).toBe(motion.closesAtTick + DEMO_CONFIG.management.termMonths);
    expect(canOperate(world, 'lp-food')).toBe(true);
    expect(currentOperator(world, 'lp-food')).toBeNull();

    ensurePlayerOperations(world, DEMO_CONFIG, world.time.tick);
    ensurePlayerOperations(world, DEMO_CONFIG, world.time.tick);
    const operation = playerOperationFor(world, 'lp-food');
    expect(operation).not.toBeNull();
    expect(operation!.mode).toBe('assisted');
    expect(
      world.management.playerOperations.filter((entry) => entry.companyId === 'lp-food'),
    ).toHaveLength(1);
  });

  it('玩家可以同时经营多家企业，各自的模式与授权互相独立', () => {
    const world = createInitialWorld();
    makePlayerOperator(world, 'lp-food');
    makePlayerOperator(world, 'lp-garment');
    ensurePlayerOperations(world, DEMO_CONFIG, 0);

    const operated = playerOperatedCompanies(world);
    expect(operated.map((company) => company.id)).toEqual(['lp-food', 'lp-garment']);
    expect(canOperate(world, 'lp-food')).toBe(true);
    expect(canOperate(world, 'lp-garment')).toBe(true);
    // 非玩家经营企业不受影响。
    expect(canOperate(world, 'lp-appliance')).toBe(false);

    expect(
      setOperationMode(world, 'lp-food', 'manual', DEMO_CONFIG, 0).ok,
    ).toBe(true);
    expect(
      setOperationMode(world, 'lp-garment', 'delegated', DEMO_CONFIG, 0).ok,
    ).toBe(true);
    expect(playerOperationFor(world, 'lp-food')!.mode).toBe('manual');
    expect(playerOperationFor(world, 'lp-garment')!.mode).toBe('delegated');
    expect(
      setAuthorization(world, 'lp-garment', { maxInvestmentPerMonth: 1234 }, DEMO_CONFIG).ok,
    ).toBe(true);
    expect(playerOperationFor(world, 'lp-garment')!.authorization.maxInvestmentPerMonth).toBe(1234);
    expect(playerOperationFor(world, 'lp-food')!.authorization.maxInvestmentPerMonth).toBe(
      DEMO_CONFIG.management.defaultAuthorization.maxInvestmentPerMonth,
    );
  });
});

/** 让玩家企业拥有充足现金与利润，便于触发投资/招聘等重大事项。 */
function prepareRichPlayerCompany(world: WorldState): Company {
  const company = companyOf(world, 'lp-food');
  makePlayerOperator(world, 'lp-food');
  ensurePlayerOperations(world, DEMO_CONFIG, 0);
  company.cash = 2_000_000_000;
  company.previousMonth.profit = 5_000_000;
  company.dividendPayoutRatio = 0.6;
  return company;
}

function pendingProposalOf(world: WorldState, companyId: string, kind: string) {
  return proposalView(world, companyId).find(
    (proposal) => proposal.kind === kind && proposal.status === 'pending',
  );
}

describe('AI 辅助模式', () => {
  it('重大投资生成提案不执行；批准后走既有扩产入口执行', () => {
    const world = createInitialWorld();
    const company = prepareRichPlayerCompany(world);
    setOperationMode(world, 'lp-food', 'assisted', DEMO_CONFIG, 0);
    const capacityBefore = company.capacity;
    const employeesBefore = company.employees;

    const log: LogEntry[] = [];
    expect(planPlayerOperatedCompany(world, company, DEMO_CONFIG, 1, log)).toBe(true);
    const expand = pendingProposalOf(world, 'lp-food', 'expand');
    expect(expand).toBeTruthy();
    // 未批准不得执行。
    expect(company.capacity).toBe(capacityBefore);

    // 招聘提案批准后只改 jobDemand（下月由 labor 匹配），不直接改 employees。
    const hire = pendingProposalOf(world, 'lp-food', 'hire');
    expect(hire).toBeTruthy();
    const hireResult = decideProposal(world, hire!.id, true, DEMO_CONFIG, 1);
    expect(hireResult.ok).toBe(true);
    expect(company.employees).toBe(employeesBefore);
    expect(Number(hire!.params.targetJobs)).toBeGreaterThanOrEqual(0);
    expect(proposalView(world, 'lp-food').find((proposal) => proposal.id === hire!.id)!.status).toBe(
      'executed',
    );
    expect(pendingProposalOf(world, 'lp-food', 'hire')).toBeUndefined();

    const result = decideProposal(world, expand!.id, true, DEMO_CONFIG, 1);
    expect(result.ok).toBe(true);
    expect(company.capacity).toBeGreaterThan(capacityBefore);
    expect(
      proposalView(world, 'lp-food').find((proposal) => proposal.id === expand!.id)!.status,
    ).toBe('executed');
  });

  it('拒绝提案后同键冷却，冷却结束可基于新情况重新提出；过期提案不再执行', () => {
    const world = createInitialWorld();
    const company = prepareRichPlayerCompany(world);
    setOperationMode(world, 'lp-food', 'assisted', DEMO_CONFIG, 0);
    const log: LogEntry[] = [];

    planPlayerOperatedCompany(world, company, DEMO_CONFIG, 1, log);
    const first = pendingProposalOf(world, 'lp-food', 'expand');
    expect(first).toBeTruthy();
    expect(decideProposal(world, first!.id, false, DEMO_CONFIG, 1).ok).toBe(true);

    // 冷却期内不重复生成同一去重键的提案。
    planPlayerOperatedCompany(world, company, DEMO_CONFIG, 2, log);
    expect(pendingProposalOf(world, 'lp-food', 'expand')).toBeUndefined();

    // 冷却结束后（拒绝 tick + proposalCooldownMonths）可重新提出。
    const retryTick = 1 + DEMO_CONFIG.management.proposalCooldownMonths;
    planPlayerOperatedCompany(world, company, DEMO_CONFIG, retryTick, log);
    const retried = pendingProposalOf(world, 'lp-food', 'expand');
    expect(retried).toBeTruthy();
    expect(retried!.id).not.toBe(first!.id);

    // 未处理的提案到达有效期后标记 expired，之后不得再执行。
    const capacityBefore = company.capacity;
    expireProposals(world, DEMO_CONFIG, retried!.expiresTick);
    expect(
      proposalView(world, 'lp-food').find((proposal) => proposal.id === retried!.id)!.status,
    ).toBe('expired');
    const late = decideProposal(world, retried!.id, true, DEMO_CONFIG, retried!.expiresTick);
    expect(late.ok).toBe(false);
    expect(company.capacity).toBe(capacityBefore);
  });

  it('重大事项阈值来自 config：阈值足够高时 AI 辅助可直接执行投资', () => {
    const config = makeConfig({ investmentAmount: 1_000_000_000_000 });
    const world = createInitialWorld(config);
    const company = companyOf(world, 'lp-food');
    makePlayerOperator(world, 'lp-food');
    ensurePlayerOperations(world, config, 0);
    setOperationMode(world, 'lp-food', 'assisted', config, 0);
    company.cash = 2_000_000_000;
    company.previousMonth.profit = 5_000_000;
    const capacityBefore = company.capacity;

    planPlayerOperatedCompany(world, company, config, 1, []);
    expect(company.capacity).toBeGreaterThan(capacityBefore);
    expect(pendingProposalOf(world, 'lp-food', 'expand')).toBeUndefined();
  });

  it('周转贷款提案按银行可借额度收敛，批准后走 banking.openLoan 真实放款', () => {
    const world = createInitialWorld();
    const company = companyOf(world, 'lp-garment');
    makePlayerOperator(world, 'lp-garment');
    ensurePlayerOperations(world, DEMO_CONFIG, 0);
    setOperationMode(world, 'lp-garment', 'assisted', DEMO_CONFIG, 0);
    // 现金不足 0.75 个月工资 → 触发周转贷款需求。
    company.cash = 1_000_000;

    planPlayerOperatedCompany(world, company, DEMO_CONFIG, 1, []);
    const loan = pendingProposalOf(world, 'lp-garment', 'loan');
    expect(loan).toBeTruthy();
    expect(loan!.amount).toBeGreaterThan(0);
    // 金额已按银行实时可借额度收敛，不会生成注定被拒绝的提案。
    const debtBefore = company.debt;
    const result = decideProposal(world, loan!.id, true, DEMO_CONFIG, 1);
    expect(result.ok).toBe(true);
    expect(company.debt).toBeGreaterThan(debtBefore);
    expect(
      world.banking.loans.some(
        (entry) => entry.borrower.kind === 'company' && entry.borrower.id === 'lp-garment',
      ),
    ).toBe(true);
  });
});

describe('高度托管模式', () => {
  it('授权范围内自动执行投资；超出授权范围生成提案等待批准', () => {
    // 授权过小 → 生成提案，不执行。
    const limited = createInitialWorld();
    const limitedCompany = prepareRichPlayerCompany(limited);
    setOperationMode(limited, 'lp-food', 'delegated', DEMO_CONFIG, 0);
    setAuthorization(
      limited,
      'lp-food',
      { allowInvestment: true, maxInvestmentPerMonth: 1 },
      DEMO_CONFIG,
    );
    const limitedCapacity = limitedCompany.capacity;
    planPlayerOperatedCompany(limited, limitedCompany, DEMO_CONFIG, 1, []);
    expect(limitedCompany.capacity).toBe(limitedCapacity);
    expect(pendingProposalOf(limited, 'lp-food', 'expand')).toBeTruthy();

    // 授权充足 → 直接执行，不生成扩产提案。
    const funded = createInitialWorld();
    const fundedCompany = prepareRichPlayerCompany(funded);
    setOperationMode(funded, 'lp-food', 'delegated', DEMO_CONFIG, 0);
    setAuthorization(
      funded,
      'lp-food',
      { allowInvestment: true, maxInvestmentPerMonth: 1_000_000_000 },
      DEMO_CONFIG,
    );
    const fundedCapacity = fundedCompany.capacity;
    planPlayerOperatedCompany(funded, fundedCompany, DEMO_CONFIG, 1, []);
    expect(fundedCompany.capacity).toBeGreaterThan(fundedCapacity);
    expect(pendingProposalOf(funded, 'lp-food', 'expand')).toBeUndefined();
  });

  it('授权内自动借入可执行的周转贷款，不生成待批准提案', () => {
    const world = createInitialWorld();
    const company = companyOf(world, 'lp-garment');
    makePlayerOperator(world, 'lp-garment');
    ensurePlayerOperations(world, DEMO_CONFIG, 0);
    setOperationMode(world, 'lp-garment', 'delegated', DEMO_CONFIG, 0);
    setAuthorization(
      world,
      'lp-garment',
      { allowLoan: true, maxLoanAmount: 1_000_000_000 },
      DEMO_CONFIG,
    );
    company.cash = 1_000_000;

    planPlayerOperatedCompany(world, company, DEMO_CONFIG, 1, []);
    expect(company.debt).toBeGreaterThan(0);
    expect(pendingProposalOf(world, 'lp-garment', 'loan')).toBeUndefined();
  });
});

describe('手动模式与持续计划', () => {
  it('持续经营计划一直生效直到修改或到期', () => {
    const world = createInitialWorld();
    const company = companyOf(world, 'lp-food');
    makePlayerOperator(world, 'lp-food');
    ensurePlayerOperations(world, DEMO_CONFIG, 0);
    setOperationMode(world, 'lp-food', 'manual', DEMO_CONFIG, 0);
    const planResult = setStandingPlan(
      world,
      'lp-food',
      { utilization: 0.9, targetJobs: 100, priceFactor: 1.02, investmentPerMonth: 0 },
      DEMO_CONFIG,
      0,
    );
    expect(planResult.ok).toBe(true);

    const log: LogEntry[] = [];
    planPlayerOperatedCompany(world, company, DEMO_CONFIG, 1, log);
    expect(company.utilization).toBe(0.9);
    expect(company.jobDemand).toBe(100);
    expect(company.priceFactor).toBe(1.02);

    // 下个月不做任何操作，计划仍持续生效。
    planPlayerOperatedCompany(world, company, DEMO_CONFIG, 2, log);
    expect(company.utilization).toBe(0.9);
    expect(company.jobDemand).toBe(100);

    // 到期后计划失效（不再自动应用），等待玩家重新设定。
    const expiresTick = playerOperationFor(world, 'lp-food')!.standingPlan!.expiresTick;
    planPlayerOperatedCompany(world, company, DEMO_CONFIG, expiresTick + 1, log);
    expect(playerOperationFor(world, 'lp-food')!.standingPlan).toBeNull();
    expect(log.some((entry) => entry.message.includes('已到期'))).toBe(true);
  });
});

describe('股东表决类提案', () => {
  it('玩家批准股息提案后仍需股东表决，不得直接改变派发比例', () => {
    const world = createInitialWorld();
    const company = companyOf(world, 'lp-food');
    seedVoting(world, 'lp-food', [
      { holder: investor(1), shares: 600 },
      { holder: investor(2), shares: 400 },
    ]);
    makePlayerOperator(world, 'lp-food');
    ensurePlayerOperations(world, DEMO_CONFIG, 0);
    setOperationMode(world, 'lp-food', 'assisted', DEMO_CONFIG, 0);
    company.cash = 2_000_000_000;
    company.previousMonth.profit = 5_000_000;
    company.dividendPayoutRatio = 0.6;

    planPlayerOperatedCompany(world, company, DEMO_CONFIG, 1, []);
    const dividend = pendingProposalOf(world, 'lp-food', 'dividend');
    expect(dividend).toBeTruthy();

    const decide = decideProposal(world, dividend!.id, true, DEMO_CONFIG, 1);
    expect(decide.ok).toBe(true);
    // 批准只是提交治理议案：派发比例未变。
    expect(company.dividendPayoutRatio).toBe(0.6);
    const motion = world.governance.motions.find(
      (entry) =>
        entry.companyId === 'lp-food' &&
        entry.kind === 'dividendPolicy' &&
        entry.status === 'open',
    );
    expect(motion).toBeTruthy();
    expect(Number(motion!.params.ratio)).toBe(1);

    // 走常规股东表决通道，通过后才生效。
    expect(castVote(world, motion!.id, investor(1), 'for', 1).ok).toBe(true);
    expect(castVote(world, motion!.id, investor(2), 'for', 1).ok).toBe(true);
    closeMotions(world, DEMO_CONFIG, motion!.closesAtTick, []);
    expect(motion!.status).toBe('passed');
    expect(company.dividendPayoutRatio).toBe(1);
  });
});
