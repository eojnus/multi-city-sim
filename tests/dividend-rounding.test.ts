import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation/core/simulation';
import { DEMO_CONFIG } from '../src/data/config';
import { createShareStructure, distributeDividend } from '../src/simulation/securities/securities';
import { settleCompanyFinance } from '../src/simulation/finance/finance';
import { groupsOfCity, groupHolder } from '../src/simulation/investors/investors';
import { round2 } from '../src/simulation/core/math';
import type { Company, CompanyMonthlyStats, HolderRef, WorldState } from '../src/simulation/contracts/types';

const PLAYER: HolderRef = { type: 'player', id: 'player' };

function blankStats(): CompanyMonthlyStats {
  return {
    revenue: 0,
    inputCost: 0,
    wagesPaid: 0,
    wageArrears: 0,
    interestPaid: 0,
    corporateTax: 0,
    dividendsPaid: 0,
    profit: 0,
    produced: 0,
    sold: 0,
    exported: 0,
    unmetDemand: 0,
    capacityChange: 0,
    dividendIncome: 0,
  };
}

function worldWithHolders(companyId: string, weights: number[]): { world: WorldState; company: Company; holders: HolderRef[] } {
  const world = Simulation.create().state;
  const company = world.companies.find((candidate) => candidate.id === companyId)!;
  const extraCompanies = world.companies.filter(
    (candidate) => candidate.id !== companyId,
  );
  const group = groupsOfCity(world, company.cityId)[0]!;
  const holders: HolderRef[] = [PLAYER];
  for (let index = 0; index < weights.length - 2; index++) {
    holders.push({ type: 'company', id: extraCompanies[index]!.id });
  }
  holders.push(groupHolder(group));
  createShareStructure(world, company, {
    votingShares: weights.reduce((total, value) => total + value, 0),
    nonVotingShares: 0,
    votingHolders: holders.map((holder, index) => ({ holder, shares: weights[index] ?? 0 })),
    nonVotingHolders: [],
    tick: 0,
    acquiredVia: 'primary',
  });
  return { world, company, holders };
}

function cashOf(world: WorldState, holder: HolderRef): number {
  if (holder.type === 'player') return world.player.cash;
  if (holder.type === 'company') {
    return world.companies.find((company) => company.id === holder.id)?.cash ?? 0;
  }
  return world.investors.find((group) => group.id === holder.id)?.cash ?? 0;
}

describe('股息按最小货币单位分配', () => {
  it('四名股东平分 0.02：合计严格等于 0.02，不超发', () => {
    const { world, company, holders } = worldWithHolders('lp-food', [1, 1, 1, 1]);
    const before = holders.map((holder) => cashOf(world, holder));
    const result = distributeDividend(world, company, 0.02, 0, DEMO_CONFIG);

    expect(result.total).toBe(0.02);
    expect(round2(result.player + result.companies + result.investors)).toBe(0.02);
    const allocated = holders.map((holder, index) => round2(cashOf(world, holder) - before[index]!));
    expect(round2(allocated.reduce((total, value) => total + value, 0))).toBe(0.02);
    // 以 0.01 为最小单位：只有两名股东各得 0.01。
    expect(allocated.filter((value) => value > 0)).toHaveLength(2);
    expect(allocated.every((value) => value === 0 || value === 0.01)).toBe(true);
  });

  it('小额分红 0.01 与不可整除的 100.01 都严格守恒', () => {
    const small = worldWithHolders('lp-food', [1, 1, 1, 1]);
    const smallBefore = small.holders.map((holder) => cashOf(small.world, holder));
    const smallResult = distributeDividend(small.world, small.company, 0.01, 0, DEMO_CONFIG);
    expect(smallResult.total).toBe(0.01);
    const smallGains = small.holders.map(
      (holder, index) => round2(cashOf(small.world, holder) - smallBefore[index]!),
    );
    expect(round2(smallGains.reduce((total, value) => total + value, 0))).toBe(0.01);

    const odd = worldWithHolders('lp-food', [1, 1, 1]);
    const before = odd.holders.map((holder) => cashOf(odd.world, holder));
    const oddResult = distributeDividend(odd.world, odd.company, 100.01, 0, DEMO_CONFIG);
    expect(oddResult.total).toBe(100.01);
    const distributed = round2(
      Object.values(oddResult.investorDistributionByCity).reduce(
        (total, value) => total + value,
        0,
      ),
    );
    const gains = odd.holders
      .map((holder, index) =>
        holder.type === 'investorGroup'
          ? round2(cashOf(odd.world, holder) - before[index]! + distributed)
          : round2(cashOf(odd.world, holder) - before[index]!),
      )
      .sort((a, b) => b - a);
    expect(round2(gains.reduce((total, value) => total + value, 0))).toBe(100.01);
    expect(gains[0]).toBeCloseTo(33.34, 2);
    expect(gains[1]).toBeCloseTo(33.34, 2);
    expect(gains[2]).toBeCloseTo(33.33, 2);
  });

  it('没有可分配金额或没有股东时不改变任何现金', () => {
    const { world, company, holders } = worldWithHolders('lp-food', [1, 1]);
    const before = holders.map((holder) => cashOf(world, holder));
    const zero = distributeDividend(world, company, 0, 0, DEMO_CONFIG);
    expect(zero.total).toBe(0);
    expect(holders.map((holder) => cashOf(world, holder))).toEqual(before);

    const empty = worldWithHolders('lp-garment', [0, 0]);
    const emptyBefore = empty.world.player.cash;
    const emptyResult = distributeDividend(empty.world, empty.company, 5, 0, DEMO_CONFIG);
    expect(emptyResult.total).toBe(0);
    expect(empty.world.player.cash).toBe(emptyBefore);
  });

  it('企业实际扣除的股息等于股东所得合计（财务层）', () => {
    const { world, company, holders } = worldWithHolders('lp-food', [1, 1, 1, 1]);
    for (const entry of world.companies) {
      entry.employees = 0;
      entry.roles = { management: 0, production: 0, sales: 0, research: 0 };
      entry.jobDemand = 0;
      entry.baseWageBill = 0;
      entry.debt = 0;
      entry.cash = 1_000_000;
      entry.lastMonth = blankStats();
    }
    company.lastMonth.revenue = 0.04;
    company.dividendPayoutRatio = 0.5;
    const cashBefore = company.cash;
    const holderCashBefore = holders.map((holder) => cashOf(world, holder));

    const finance = settleCompanyFinance(world, DEMO_CONFIG, []);
    expect(company.lastMonth.dividendsPaid).toBe(0.02);
    expect(cashBefore - company.cash).toBeCloseTo(0.02, 10);
    const holderGains = holders.map((holder, index) => cashOf(world, holder) - holderCashBefore[index]!);
    const distributed = Object.values(finance.investorDistributionByCity).reduce(
      (total, value) => total + value,
      0,
    );
    // 实体现金只体现留存部分；返还部分已从实体现金扣除。
    const group = groupsOfCity(world, company.cityId)[0]!;
    const groupIndex = holders.findIndex(
      (holder) => holder.type === 'investorGroup' && holder.id === group.id,
    );
    const groupGross = holderGains[groupIndex]! + distributed;
    const totalGains =
      holderGains.reduce((total, value) => total + value, 0) -
      holderGains[groupIndex]! +
      groupGross;
    expect(totalGains).toBeCloseTo(0.02, 2);  });

  it('相同状态重复分配得到相同结果', () => {
    const run = () => {
      const { world, company, holders } = worldWithHolders('lp-food', [7, 5, 3, 2]);
      const before = holders.map((holder) => cashOf(world, holder));
      const result = distributeDividend(world, company, 0.05, 0, DEMO_CONFIG);
      return {
        total: result.total,
        gains: holders.map((holder, index) => cashOf(world, holder) - before[index]!),
      };
    };
    expect(run()).toEqual(run());
  });
});
