import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation/core/simulation';
import { settleCompanyFinance } from '../src/simulation/finance/finance';
import { settleGovernment } from '../src/simulation/government/fiscal';
import { taxAccrualOf } from '../src/simulation/government/taxes';
import { DEMO_CONFIG } from '../src/data/config';
import type { Company, HolderRef, WorldState } from '../src/simulation/contracts/types';
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

function prepare(world: WorldState, targetId: string): Company {
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
  world.player.lastDividend = 0;
  world.player.dividendsReceived = 0;
  return target;
}

function setHolders(world: WorldState, target: Company, holders: { holder: HolderRef; shares: number }[]): void {
  createShareStructure(world, target, {
    votingShares: holders.reduce((sum, entry) => sum + entry.shares, 0),
    nonVotingShares: 0,
    votingHolders: holders,
    nonVotingHolders: [],
    tick: world.time.tick,
    acquiredVia: 'primary',
  });
}

describe('v0.8 股息税：玩家分红代扣 10%', () => {
  it('玩家按实际分红代扣 10%，净额入账且税额记入玩家所在城市', () => {
    const sim = Simulation.create();
    const target = prepare(sim.state, 'lp-food');
    const group = groupsOfCity(sim.state, target.cityId)[0]!;
    setHolders(sim.state, target, [
      { holder: { type: 'player', id: 'player' }, shares: 600 },
      { holder: groupHolder(group), shares: 400 },
    ]);
    const playerCashBefore = sim.state.player.cash;
    const log: { tick: number; kind: string; message: string }[] = [];

    const finance = settleCompanyFinance(sim.state, DEMO_CONFIG, log as never);
    const totalDividend = target.lastMonth.dividendsPaid;
    expect(totalDividend).toBeGreaterThan(0);

    const net = finance.playerDividends;
    const tax = finance.playerDividendTax ?? 0;
    expect(net).toBeGreaterThan(0);
    expect(tax).toBeGreaterThan(0);
    // 毛股息 = 净额 + 代扣税，税率 10%。
    const gross = round2(net + tax);
    expect(gross / totalDividend).toBeCloseTo(0.6, 2);
    expect(tax).toBeCloseTo(round2(gross * DEMO_CONFIG.tax.dividendTaxRate), 2);
    // 玩家到账为税后净额，账户/累计字段同步净额。
    expect(sim.state.player.cash - playerCashBefore).toBeCloseTo(net, 6);
    expect(sim.state.player.lastDividend).toBeCloseTo(net, 6);
    expect(sim.state.player.dividendsReceived).toBeCloseTo(net, 6);
    // 税记入玩家所在城市（纳税人所在地）；同城居民股东也各自代扣。
    const homeCityId = sim.state.player.homeCityId;
    const homeTax = finance.dividendTaxByCity?.[homeCityId] ?? 0;
    expect(homeTax).toBeGreaterThanOrEqual(round2(tax) - 1e-6);
    expect(taxAccrualOf(sim.state, homeCityId).dividendTax).toBeCloseTo(homeTax, 6);
    expect(homeTax).toBeCloseTo(round2(tax + round2(round2(totalDividend - gross) * 0.1)), 2);
    expect(log.some((entry) => entry.message.includes('代扣股息税'))).toBe(true);
    // 企业实际分红支出 = 派发给股东的金额，不因代扣税增加。
    expect(finance.playerDividends + (finance.dividendsByCity[target.cityId] ?? 0)).toBeCloseTo(
      totalDividend - tax,
      2,
    );
  });
});

describe('v0.8 股息税：居民投资实体代扣且不重复征', () => {
  it('实体按收到股息代扣 10%，返还居民的部分不再次征税', () => {
    const sim = Simulation.create();
    const target = prepare(sim.state, 'lp-food');
    const group = groupsOfCity(sim.state, target.cityId)[0]!;
    setHolders(sim.state, target, [{ holder: groupHolder(group), shares: 1_000 }]);
    const groupCashBefore = group.cash;

    const finance = settleCompanyFinance(sim.state, DEMO_CONFIG, []);
    const totalDividend = target.lastMonth.dividendsPaid;
    const gross = finance.investorDividendsByCity[target.cityId] ?? 0;
    const distributed = finance.investorDistributionByCity[target.cityId] ?? 0;
    const tax = finance.dividendTaxByCity?.[target.cityId] ?? 0;
    expect(gross).toBeCloseTo(totalDividend, 2);
    expect(distributed).toBeCloseTo(round2(gross * DEMO_CONFIG.investors.dividendDistributionRate), 2);
    expect(tax).toBeCloseTo(round2(gross * DEMO_CONFIG.tax.dividendTaxRate), 2);
    // 实体资金：保留部分 − 代扣税（返还居民部分已从实体扣除，不能再税一次）。
    expect(group.cash - groupCashBefore).toBeCloseTo(round2(gross - distributed - tax), 2);
    expect(group.dividendsReceived).toBeCloseTo(round2(gross - tax), 2);
    expect(taxAccrualOf(sim.state, target.cityId).dividendTax).toBeCloseTo(round2(gross * 0.1), 6);

    // 月结财政：lastMonth 与流水一致；居民返还额不再产生第二笔税。
    settleGovernment(sim.state, finance, DEMO_CONFIG, []);
    const city = sim.state.cities.find((entry) => entry.id === target.cityId)!;
    expect(city.lastMonth.dividendTax).toBeCloseTo(round2(gross * 0.1), 6);
    const taxEntries = sim.state.fiscal.ledger.filter(
      (entry) => entry.cityId === city.id && entry.kind === 'dividendTax',
    );
    expect(taxEntries.reduce((sum, entry) => sum + entry.amount, 0)).toBeCloseTo(
      round2(gross * 0.1),
      6,
    );
    // 仅对 100% 股息代扣一次；返还的 70% 不再重复征。
    expect(taxAccrualOf(sim.state, city.id).dividendTax).toBe(0);
  });

  it('企业与城市股东不代扣股息税', () => {
    const sim = Simulation.create();
    const target = prepare(sim.state, 'lp-food');
    const companyHolder = sim.state.companies.find((company) => company.id === 'gf-grain')!;
    const cityHolder = sim.state.cities.find((city) => city.id === target.cityId)!;
    const companyCashBefore = companyHolder.cash;
    const cityTreasuryBefore = cityHolder.treasury;
    setHolders(sim.state, target, [
      { holder: { type: 'company', id: companyHolder.id }, shares: 500 },
      { holder: { type: 'city', id: cityHolder.id }, shares: 500 },
    ]);

    const finance = settleCompanyFinance(sim.state, DEMO_CONFIG, []);
    const totalDividend = target.lastMonth.dividendsPaid;
    expect(finance.playerDividendTax ?? 0).toBe(0);
    expect(Object.values(finance.dividendTaxByCity ?? {}).reduce((sum, value) => sum + value, 0)).toBe(0);
    for (const city of sim.state.cities) {
      expect(taxAccrualOf(sim.state, city.id).dividendTax).toBe(0);
    }
    // 企业股东全额入账，城市股东全额入财政，均不扣税。
    expect(companyHolder.cash - companyCashBefore).toBeCloseTo(totalDividend * 0.5, 2);
    expect(cityHolder.treasury - cityTreasuryBefore).toBeCloseTo(totalDividend * 0.5, 2);
  });
});
