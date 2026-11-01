import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation/core/simulation';
import { settleCompanyFinance, splitDividend } from '../src/simulation/finance/finance';
import { DEMO_CONFIG } from '../src/data/config';
import type { Company } from '../src/simulation/contracts/types';
import { createShareStructure } from '../src/simulation/securities/securities';
import { groupsOfCity, groupHolder } from '../src/simulation/investors/investors';

function blankStats(): Company['lastMonth'] {
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

function prepare(world: ReturnType<typeof Simulation.create>['state'], targetId: string): Company {
  const target = world.companies.find((company) => company.id === targetId)!;
  for (const company of world.companies) {
    company.employees = 0;
    company.roles = { management: 0, production: 0, sales: 0, research: 0 };
    company.jobDemand = 0;
    company.baseWageBill = 0;
    company.cash = 1_000_000;
    company.debt = 0;
    company.lastMonth = blankStats();
  }
  target.cash = 10_000_000;
  target.lastMonth.revenue = 1_000_000;
  world.player.cash = 1_000_000;
  return target;
}

/** 将目标企业的股份重设为指定分配：v0.2 起股息按 securities 持股分配。 */
function assignShares(
  world: ReturnType<typeof Simulation.create>['state'],
  target: Company,
  totalShares: number,
  playerShares: number,
): void {
  const groups = groupsOfCity(world, target.cityId);
  const group = groups[0]!;
  const otherShares = Math.max(0, totalShares - playerShares);
  createShareStructure(world, target, {
    votingShares: totalShares,
    nonVotingShares: 0,
    votingHolders: [
      ...(playerShares > 0 ? [{ holder: { type: 'player' as const, id: 'player' }, shares: playerShares }] : []),
      ...(otherShares > 0 ? [{ holder: groupHolder(group), shares: otherShares }] : []),
    ],
    nonVotingHolders: [],
    tick: world.time.tick,
    acquiredVia: 'primary',
  });
}

describe('玩家分红', () => {
  it('无持股时玩家所得为 0，企业股息全部归居民股东', () => {
    const sim = Simulation.create();
    const target = prepare(sim.state, 'lp-food');
    assignShares(sim.state, target, 1_000, 0);
    const log: { tick: number; kind: string; message: string }[] = [];
    const result = settleCompanyFinance(sim.state, DEMO_CONFIG, log as never);

    expect(result.playerDividends).toBe(0);
    expect(result.playerDividendsByCompany[target.id]).toBeUndefined();
    expect(sim.state.player.cash).toBe(1_000_000);
    expect(result.dividendsByCity[target.cityId]).toBeGreaterThan(0);
    expect(result.dividendsByCity[target.cityId]).toBe(target.lastMonth.dividendsPaid);
  });

  it('按持股比例把企业实际股息转入玩家账户，剩余部分才计入居民收入', () => {
    const sim = Simulation.create();
    const target = prepare(sim.state, 'lp-food');
    assignShares(sim.state, target, 1_000, 500);
    const beforeCash = sim.state.player.cash;
    const log: { tick: number; kind: string; message: string }[] = [];
    const result = settleCompanyFinance(sim.state, DEMO_CONFIG, log as never);

    const totalDividend = target.lastMonth.dividendsPaid;
    expect(totalDividend).toBeGreaterThan(0);
    expect(result.playerDividends).toBeCloseTo(totalDividend * 0.5, 2);
    expect(sim.state.player.cash).toBeCloseTo(beforeCash + result.playerDividends, 2);
    expect(sim.state.player.dividendsReceived).toBeCloseTo(result.playerDividends, 2);
    expect(result.dividendsByCity[target.cityId]).toBeCloseTo(
      totalDividend - result.playerDividends,
      2,
    );
    expect(result.playerDividends + (result.dividendsByCity[target.cityId] ?? 0)).toBeCloseTo(
      totalDividend,
      2,
    );
    expect(log.some((entry) => entry.kind === 'player' && entry.message.includes('分红'))).toBe(true);
  });

  it('非整除持股的四舍五入保持“玩家 + 其他股东 = 支付总额”', () => {
    const split = splitDividend(100.01, 1, 3);
    expect(split.player).toBe(33.34);
    expect(split.other).toBe(66.67);
    expect(split.player + split.other).toBeCloseTo(100.01, 10);

    const sim = Simulation.create();
    const target = prepare(sim.state, 'lp-food');
    assignShares(sim.state, target, 3, 1);
    const result = settleCompanyFinance(sim.state, DEMO_CONFIG, []);
    const total = target.lastMonth.dividendsPaid;
    expect(result.playerDividends + (result.dividendsByCity[target.cityId] ?? 0)).toBeCloseTo(
      total,
      2,
    );
    expect(result.playerDividends).toBeCloseTo(splitDividend(total, 1, 3).player, 2);
  });
});
