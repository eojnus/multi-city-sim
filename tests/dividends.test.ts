import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation/core/simulation';
import { settleCompanyFinance, splitDividend } from '../src/simulation/finance/finance';
import { DEMO_CONFIG } from '../src/data/config';
import type { Company } from '../src/simulation/contracts/types';
import { createShareStructure } from '../src/simulation/securities/securities';
import { groupsOfCity, groupHolder } from '../src/simulation/investors/investors';
import { round2 } from '../src/simulation/core/math';

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
    // v0.8：玩家股息按 10% 代扣，playerDividends 为税后净额。
    const withheldTax = result.playerDividendTax ?? 0;
    expect(withheldTax).toBeGreaterThan(0);
    expect(result.playerDividends).toBeCloseTo(totalDividend * 0.5 * 0.9, 2);
    expect(sim.state.player.cash).toBeCloseTo(beforeCash + result.playerDividends, 2);
    expect(sim.state.player.dividendsReceived).toBeCloseTo(result.playerDividends, 2);
    expect(result.playerDividendsByCompany[target.id]).toBeCloseTo(result.playerDividends, 2);
    // dividendsByCity 仍是居民股东收到的毛股息（返还居民前），税单独记录。
    const investorGross = result.dividendsByCity[target.cityId] ?? 0;
    expect(investorGross).toBeCloseTo(totalDividend * 0.5, 2);
    // 守恒：玩家净额 + 居民股东净额 + 全部代扣税 = 企业支付总额。
    const allWithheldTax = Object.values(result.dividendTaxByCity ?? {}).reduce(
      (sum, amount) => sum + amount,
      0,
    );
    const investorTax = round2(allWithheldTax - withheldTax);
    expect(investorTax).toBeCloseTo(round2(investorGross * DEMO_CONFIG.tax.dividendTaxRate), 2);
    expect(
      result.playerDividends + (investorGross - investorTax) + allWithheldTax,
    ).toBeCloseTo(totalDividend, 2);
    expect(log.some((entry) => entry.kind === 'player' && entry.message.includes('分红'))).toBe(true);
  });

  it('非整除持股的四舍五入保持“玩家净额 + 其他股东毛额 + 代扣税 = 支付总额”', () => {
    const split = splitDividend(100.01, 1, 3);
    expect(split.player).toBe(33.34);
    expect(split.other).toBe(66.67);
    expect(split.player + split.other).toBeCloseTo(100.01, 10);

    const sim = Simulation.create();
    const target = prepare(sim.state, 'lp-food');
    assignShares(sim.state, target, 3, 1);
    const result = settleCompanyFinance(sim.state, DEMO_CONFIG, []);
    const total = target.lastMonth.dividendsPaid;
    const grossPlayer = splitDividend(total, 1, 3).player;
    const withheldTax = result.playerDividendTax ?? 0;
    expect(withheldTax).toBeCloseTo(round2(grossPlayer * DEMO_CONFIG.tax.dividendTaxRate), 2);
    expect(result.playerDividends).toBeCloseTo(grossPlayer - withheldTax, 2);
    // 守恒：玩家税后净额 + 居民股东毛额 + 代扣税 = 企业支付总额。
    expect(
      result.playerDividends +
        (result.dividendsByCity[target.cityId] ?? 0) +
        withheldTax,
    ).toBeCloseTo(total, 2);
  });
});
