import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation/core/simulation';
import { DEMO_CONFIG } from '../src/data/config';
import {
  autoCastVotes,
  castVote,
  closeMotions,
  openDividendPolicyMotion,
  proposeOperatorMotion,
} from '../src/simulation/corporate-governance/governance';
import {
  bookPrice,
  createShareStructure,
  playerTotalShares,
  shareClassId,
  tradeImmediately,
  transferShares,
} from '../src/simulation/securities/securities';
import { groupsOfCity, groupHolder } from '../src/simulation/investors/investors';
import { parseSave, serializeSave } from '../src/simulation/core/save';
import { checkInvariants } from '../src/simulation/core/invariants';
import type { Company, HolderRef, WorldState } from '../src/simulation/contracts/types';

const PLAYER: HolderRef = { type: 'player', id: 'player' };
const OTHER: HolderRef = { type: 'company', id: 'iv-metal' };

function isolateCompany(
  world: WorldState,
  companyId: string,
  voting: { holder: HolderRef; shares: number }[],
  nonVoting: { holder: HolderRef; shares: number }[] = [],
): Company {
  const company = world.companies.find((candidate) => candidate.id === companyId)!;
  createShareStructure(world, company, {
    votingShares: voting.reduce((total, entry) => total + entry.shares, 0),
    nonVotingShares: nonVoting.reduce((total, entry) => total + entry.shares, 0),
    votingHolders: voting,
    nonVotingHolders: nonVoting,
    tick: world.time.tick,
    acquiredVia: 'primary',
  });
  return company;
}

function prepareMotion(world: WorldState): ReturnType<typeof openDividendPolicyMotion> {
  const company = world.companies.find((candidate) => candidate.id === 'lp-food')!;
  company.lastMonth.profit = 1_000_000;
  company.dividendPayoutRatio = 0;
  for (const other of world.companies) {
    if (other.id !== company.id) other.lastMonth.profit = 0;
  }
  return openDividendPolicyMotion(world, DEMO_CONFIG, 0);
}

describe('表决权登记日快照', () => {
  it('100 股投票后转手，受让方不能再次对同一议案投票', () => {
    const world = Simulation.create().state;
    isolateCompany(world, 'lp-food', [{ holder: PLAYER, shares: 100 }]);
    const motion = prepareMotion(world)!;
    expect(motion).not.toBeNull();
    expect(motion.eligible).toEqual([{ holder: PLAYER, shares: 100 }]);

    expect(castVote(world, motion.id, PLAYER, 'for', 0).ok).toBe(true);
    expect(
      transferShares(
        world,
        'lp-food',
        shareClassId('lp-food', 'voting'),
        PLAYER,
        OTHER,
        100,
        0,
      ),
    ).toBe(true);

    const buyerVote = castVote(world, motion.id, OTHER, 'against', 0);
    expect(buyerVote.ok).toBe(false);
    const total = motion.votes.reduce((sum, vote) => sum + vote.votingShares, 0);
    expect(total).toBe(100);
    expect(motion.votes).toHaveLength(1);
  });

  it('转让后原登记股东仍按登记日股数投票，受让方不能投票', () => {
    const world = Simulation.create().state;
    isolateCompany(world, 'lp-food', [{ holder: PLAYER, shares: 100 }]);
    const motion = prepareMotion(world)!;

    expect(
      transferShares(
        world,
        'lp-food',
        shareClassId('lp-food', 'voting'),
        PLAYER,
        OTHER,
        100,
        0,
      ),
    ).toBe(true);
    expect(castVote(world, motion.id, OTHER, 'for', 0).ok).toBe(false);
    expect(castVote(world, motion.id, PLAYER, 'against', 0).ok).toBe(true);
    expect(motion.votes).toHaveLength(1);
    expect(motion.votes[0]!.votingShares).toBe(100);
    const closed = closeMotions(world, DEMO_CONFIG, motion.closesAtTick, []);
    expect(closed[0]!.result).toContain('反对 100 股');
  });

  it('同一持有人改票只保留一张票，票重不变', () => {
    const world = Simulation.create().state;
    isolateCompany(world, 'lp-food', [{ holder: PLAYER, shares: 100 }]);
    const motion = prepareMotion(world)!;
    expect(castVote(world, motion.id, PLAYER, 'for', 0).ok).toBe(true);
    expect(castVote(world, motion.id, PLAYER, 'against', 0).ok).toBe(true);
    expect(motion.votes).toHaveLength(1);
    expect(motion.votes[0]!.vote).toBe('against');
    expect(motion.votes[0]!.votingShares).toBe(100);
  });

  it('仅分红股份不进入登记日名单，也不能投票', () => {
    const world = Simulation.create().state;
    const group = groupsOfCity(world, 'lanport')[0]!;
    isolateCompany(
      world,
      'lp-food',
      [{ holder: groupHolder(group), shares: 100 }],
      [{ holder: PLAYER, shares: 100 }],
    );
    const motion = prepareMotion(world)!;
    expect(motion.eligible.some((entry) => entry.holder.type === 'player')).toBe(false);
    const result = castVote(world, motion.id, PLAYER, 'for', 0);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('登记日');
  });

  it('自动投票只使用登记日快照内的持有人', () => {
    const world = Simulation.create().state;
    const group = groupsOfCity(world, 'lanport')[0]!;
    isolateCompany(world, 'lp-food', [
      { holder: groupHolder(group), shares: 100 },
      { holder: OTHER, shares: 50 },
    ]);
    const motion = prepareMotion(world)!;
    // 议案创建后转让：快照仍为集团 100、OTHER 50。
    expect(
      transferShares(
        world,
        'lp-food',
        shareClassId('lp-food', 'voting'),
        groupHolder(group),
        OTHER,
        100,
        0,
      ),
    ).toBe(true);
    autoCastVotes(world, DEMO_CONFIG, 1);
    const holders = motion.votes.map((vote) => `${vote.holder.type}:${vote.holder.id}`).sort();
    expect(holders).toEqual([`company:${OTHER.id}`, `investorGroup:${group.id}`].sort());
    const groupVote = motion.votes.find((vote) => vote.holder.id === group.id)!;
    const otherVote = motion.votes.find((vote) => vote.holder.id === OTHER.id)!;
    expect(groupVote.votingShares).toBe(100);
    expect(otherVote.votingShares).toBe(50);
  });

  it('议案与登记日快照可随存档保存并恢复，受让方读档后仍不能投票', () => {
    const world = Simulation.create().state;
    const playerShares = 500_000;
    world.player.cash = 5_000_000;
    const target = world.companies.find((company) => company.id === 'lp-food')!;
    createShareStructure(world, target, {
      votingShares: playerShares + 1_000,
      nonVotingShares: 0,
      votingHolders: [
        { holder: PLAYER, shares: playerShares },
        { holder: OTHER, shares: 1_000 },
      ],
      nonVotingHolders: [],
      tick: 0,
      acquiredVia: 'primary',
    });
    const motion = proposeOperatorMotion(
      world,
      'lp-food',
      PLAYER,
      { type: 'player', id: 'player' },
      0,
      DEMO_CONFIG,
    );
    expect(motion.ok).toBe(true);
    expect(castVote(world, motion.motion!.id, PLAYER, 'for', 0).ok).toBe(true);

    // 通过二级市场把部分股份卖给一个登记日前不在名单内的企业。
    const buyer: HolderRef = { type: 'company', id: 'iv-energy' };
    expect(
      world.securities.holdings.some(
        (holding) => holding.companyId === 'lp-food' && holding.holder.type === 'company' && holding.holder.id === buyer.id,
      ),
    ).toBe(false);
    const price = bookPrice(world, target);
    world.securities.orders.push({
      id: 'buyer-order',
      companyId: target.id,
      shareClassId: shareClassId(target.id, 'voting'),
      side: 'buy',
      holder: buyer,
      shares: 100,
      limitPrice: price * 1.05,
      createdTick: 0,
      note: '测试买盘',
    });
    const trade = tradeImmediately(
      world,
      {
        companyId: target.id,
        shareClassId: shareClassId(target.id, 'voting'),
        side: 'sell',
        holder: PLAYER,
        shares: 100,
        limitPrice: price,
        tick: 0,
      },
      DEMO_CONFIG,
    );
    expect(trade.ok).toBe(true);
    expect(trade.shares).toBe(100);
    expect(playerTotalShares(world, target.id)).toBe(playerShares - 100);

    const text = serializeSave(world);
    const restored = parseSave(text);
    expect(restored.ok, restored.error).toBe(true);
    const loaded = restored.world!;
    const loadedMotion = loaded.governance.motions.find((entry) => entry.id === motion.motion!.id)!;
    expect(loadedMotion.eligible.find((entry) => entry.holder.type === 'player')?.shares).toBe(
      playerShares,
    );
    expect(castVote(loaded, loadedMotion.id, buyer, 'against', 0).ok).toBe(false);
    closeMotions(loaded, DEMO_CONFIG, loadedMotion.closesAtTick, []);
    expect(loadedMotion.result).toContain('赞成 500000 股');
    expect(checkInvariants(loaded)).toEqual([]);
  });
});
