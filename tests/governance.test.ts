import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation/core/simulation';
import { DEMO_CONFIG } from '../src/data/config';
import {
  autoCastVotes,
  boardFor,
  castVote,
  closeMotions,
  ensureGovernance,
  governanceFor,
  openDividendPolicyMotion,
  proposeOperatorMotion,
} from '../src/simulation/corporate-governance/governance';
import type {
  HolderRef,
  LogEntry,
  ShareClass,
  ShareHolding,
  WorldState,
} from '../src/simulation/contracts/types';

const PLAYER: HolderRef = { type: 'player', id: 'player' };
const OTHER_COMPANY: HolderRef = { type: 'company', id: 'lp-textile' };

function investor(index: number): HolderRef {
  return { type: 'investorGroup', id: `inv-${index}` };
}

interface HoldingSpec {
  holder: HolderRef;
  voting?: number;
  nonVoting?: number;
}

/** 测试专用证券数据：只给目标企业建类，避免其他企业产生干扰。 */
function seedSecurities(world: WorldState, companyId: string, entries: HoldingSpec[]): void {
  const votingId = `${companyId}:voting`;
  const nonVotingId = `${companyId}:nonVoting`;
  const classes: ShareClass[] = [
    {
      id: votingId,
      companyId,
      kind: 'voting',
      issuedShares: 10_000_000,
      note: '测试用投票权股份',
    },
    {
      id: nonVotingId,
      companyId,
      kind: 'nonVoting',
      issuedShares: 10_000_000,
      note: '测试用无投票权股份',
    },
  ];
  const holdings: ShareHolding[] = [];
  for (const entry of entries) {
    if ((entry.voting ?? 0) > 0) {
      holdings.push({
        companyId,
        shareClassId: votingId,
        holder: entry.holder,
        shares: entry.voting!,
        acquiredVia: 'migration',
        sinceTick: 0,
      });
    }
    if ((entry.nonVoting ?? 0) > 0) {
      holdings.push({
        companyId,
        shareClassId: nonVotingId,
        holder: entry.holder,
        shares: entry.nonVoting!,
        acquiredVia: 'migration',
        sinceTick: 0,
      });
    }
  }
  world.securities = { classes, holdings, orders: [], lastTrades: [], offers: [] };
}

function seedInvestors(world: WorldState): void {
  world.investors = Array.from({ length: 8 }, (_, index) => ({
    id: `inv-${index + 1}`,
    cityId: 'lanport',
    name: `测试投资实体 ${index + 1}`,
    cash: 0,
    populationShare: 0.05,
    riskAppetite: 0.5,
    dividendsReceived: 0,
    lastDividend: 0,
    note: '测试数据',
  }));
}

function prepare(world: WorldState, companyId: string, entries: HoldingSpec[]) {
  seedInvestors(world);
  seedSecurities(world, companyId, entries);
  world.governance = { boards: [], motions: [], controls: [] };
  for (const company of world.companies) {
    company.dividendPayoutRatio = 1;
    company.lastMonth.profit = 0;
  }
  const target = world.companies.find((company) => company.id === companyId);
  if (!target) throw new Error(`missing company ${companyId}`);
  return target;
}

describe('董事会席位', () => {
  it('按投票权股份分配席位，合计不超过席位数，且无投票权持有人不进入董事会', () => {
    const world = Simulation.create().state;
    prepare(world, 'lp-food', [
      { holder: investor(1), voting: 600 },
      { holder: investor(2), voting: 200 },
      { holder: investor(3), voting: 100 },
      { holder: investor(4), voting: 50 },
      { holder: investor(5), voting: 30 },
      { holder: investor(6), voting: 20 },
      { holder: investor(7), nonVoting: 900 },
    ]);

    ensureGovernance(world, DEMO_CONFIG, 0);
    const board = boardFor(world, 'lp-food');
    expect(board).not.toBeNull();
    expect(board!.seats.length).toBe(DEMO_CONFIG.governance.boardSeats);

    const seatCounts = new Map<string, number>();
    for (const seat of board!.seats) {
      expect(seat.votingShares).toBeGreaterThan(0);
      seatCounts.set(seat.holder.id, (seatCounts.get(seat.holder.id) ?? 0) + 1);
    }
    // 600/200/100/50/30/20 分配 5 席：3 + 1 + 1（最大余数法）。
    expect(seatCounts.get('inv-1')).toBe(3);
    expect(seatCounts.get('inv-2')).toBe(1);
    expect(seatCounts.get('inv-3')).toBe(1);
    // 只有无投票权股份的持有人不得获得席位。
    expect(seatCounts.has('inv-7')).toBe(false);
    expect(board!.chair).toEqual(investor(1));
    expect(board!.lastElectionTick).toBe(0);
  });
});

describe('股息政策议案', () => {
  it('表决按股份加权，通过后企业股息派发比例发生变化', () => {
    const world = Simulation.create().state;
    const target = prepare(world, 'lp-food', [
      { holder: PLAYER, voting: 600 },
      { holder: OTHER_COMPANY, voting: 400 },
    ]);
    target.dividendPayoutRatio = 0.4;
    target.lastMonth.profit = 100_000;

    ensureGovernance(world, DEMO_CONFIG, 1);
    const motion = openDividendPolicyMotion(world, DEMO_CONFIG, 1);
    expect(motion).not.toBeNull();
    expect(motion!.companyId).toBe('lp-food');
    expect(motion!.kind).toBe('dividendPolicy');
    expect(motion!.closesAtTick).toBe(1 + DEMO_CONFIG.governance.motionOpenTicks);

    expect(castVote(world, motion!.id, PLAYER, 'for', 1).ok).toBe(true);
    expect(castVote(world, motion!.id, OTHER_COMPANY, 'against', 1).ok).toBe(true);

    const log: LogEntry[] = [];
    const closed = closeMotions(world, DEMO_CONFIG, motion!.closesAtTick, log);
    expect(closed).toContain(motion);
    expect(motion!.status).toBe('passed');
    expect(target.dividendPayoutRatio).toBe(1);
    expect(log.some((entry) => entry.message.includes('股息派发比例'))).toBe(true);
  });

  it('反对票权重更多时不通过，企业股息派发比例保持不变', () => {
    const world = Simulation.create().state;
    const target = prepare(world, 'lp-food', [
      { holder: PLAYER, voting: 400 },
      { holder: OTHER_COMPANY, voting: 600 },
    ]);
    target.dividendPayoutRatio = 0.3;
    target.lastMonth.profit = 100_000;

    ensureGovernance(world, DEMO_CONFIG, 0);
    const motion = openDividendPolicyMotion(world, DEMO_CONFIG, 0);
    expect(motion).not.toBeNull();
    castVote(world, motion!.id, PLAYER, 'for', 0);
    castVote(world, motion!.id, OTHER_COMPANY, 'against', 0);

    const log: LogEntry[] = [];
    closeMotions(world, DEMO_CONFIG, motion!.closesAtTick, log);
    expect(motion!.status).toBe('rejected');
    expect(motion!.result).toContain('未通过');
    expect(target.dividendPayoutRatio).toBe(0.3);
    expect(log.some((entry) => entry.message.includes('未通过'))).toBe(true);
  });

  it('无投票权股份持有人投票被拒绝，也不进入董事会', () => {
    const world = Simulation.create().state;
    const target = prepare(world, 'lp-food', [
      { holder: PLAYER, nonVoting: 500 },
      { holder: OTHER_COMPANY, voting: 500 },
    ]);
    target.dividendPayoutRatio = 0.6;
    target.lastMonth.profit = 100_000;

    ensureGovernance(world, DEMO_CONFIG, 0);
    const board = boardFor(world, 'lp-food')!;
    expect(board.seats.some((seat) => seat.holder.type === 'player')).toBe(false);
    expect(board.seats.every((seat) => seat.votingShares > 0)).toBe(true);

    const motion = openDividendPolicyMotion(world, DEMO_CONFIG, 0)!;
    const result = castVote(world, motion.id, PLAYER, 'for', 0);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('投票权');
    expect(motion.votes).toHaveLength(0);
  });

  it('未投票的非玩家持有人按暂定立场自动投票', () => {
    const world = Simulation.create().state;
    const target = prepare(world, 'lp-food', [
      { holder: PLAYER, voting: 100 },
      { holder: investor(1), voting: 600 },
      { holder: OTHER_COMPANY, voting: 300 },
    ]);
    target.dividendPayoutRatio = 0.5;
    target.lastMonth.profit = 100_000;

    ensureGovernance(world, DEMO_CONFIG, 0);
    const motion = openDividendPolicyMotion(world, DEMO_CONFIG, 0)!;
    autoCastVotes(world, DEMO_CONFIG, 0);

    expect(motion.votes.some((vote) => vote.holder.type === 'player')).toBe(false);
    expect(
      motion.votes.find((vote) => vote.holder.id === 'inv-1')?.vote,
    ).toBe('for');
    expect(
      motion.votes.find((vote) => vote.holder.type === 'company')?.vote,
    ).toBe('against');

    closeMotions(world, DEMO_CONFIG, motion.closesAtTick, []);
    expect(motion.status).toBe('passed');
    expect(target.dividendPayoutRatio).toBe(1);
  });
});

describe('经营者议案', () => {
  it('通过后 control.operator 改变且 basis 为董事会任命', () => {
    const world = Simulation.create().state;
    prepare(world, 'lp-food', [
      { holder: PLAYER, voting: 600 },
      { holder: OTHER_COMPANY, voting: 400 },
    ]);
    const log: LogEntry[] = [];

    ensureGovernance(world, DEMO_CONFIG, 0);
    const before = governanceFor(world, 'lp-food');
    expect(before.control?.operator).toBe('management');
    expect(before.control?.basis).toBe('management');

    const proposed = proposeOperatorMotion(
      world,
      'lp-food',
      PLAYER,
      { type: 'company', id: 'lp-textile' },
      0,
      DEMO_CONFIG,
      log,
    );
    expect(proposed.ok).toBe(true);
    expect(proposed.motion?.params.operatorType).toBe('company');
    expect(proposed.motion?.params.operatorId).toBe('lp-textile');

    castVote(world, proposed.motion!.id, PLAYER, 'for', 0);
    castVote(world, proposed.motion!.id, OTHER_COMPANY, 'against', 0);
    closeMotions(world, DEMO_CONFIG, proposed.motion!.closesAtTick, log);

    const after = governanceFor(world, 'lp-food');
    expect(proposed.motion!.status).toBe('passed');
    expect(after.control?.operator).toEqual({ type: 'company', id: 'lp-textile' });
    expect(after.control?.basis).toBe('boardAppointment');
    expect(after.control?.sinceTick).toBe(proposed.motion!.closesAtTick);
  });
});

describe('治理记录', () => {
  it('ensureGovernance 幂等，并在重新选举时保留在任董事的起始 tick', () => {
    const world = Simulation.create().state;
    prepare(world, 'lp-food', [
      { holder: investor(1), voting: 500 },
      { holder: OTHER_COMPANY, voting: 500 },
    ]);

    ensureGovernance(world, DEMO_CONFIG, 0);
    const firstBoards = JSON.stringify(world.governance.boards);
    const firstControls = JSON.stringify(world.governance.controls);

    ensureGovernance(world, DEMO_CONFIG, 0);
    expect(world.governance.controls).toHaveLength(world.companies.length);
    expect(JSON.stringify(world.governance.boards)).toBe(firstBoards);
    expect(JSON.stringify(world.governance.controls)).toBe(firstControls);

    const sinceTickBefore = boardFor(world, 'lp-food')!.seats[0]!.sinceTick;
    ensureGovernance(world, DEMO_CONFIG, 5);
    const board = boardFor(world, 'lp-food')!;
    expect(board.lastElectionTick).toBe(5);
    expect(board.seats[0]!.sinceTick).toBe(sinceTickBefore);
    expect(board.seats[0]!.sinceTick).toBe(0);
  });
});
