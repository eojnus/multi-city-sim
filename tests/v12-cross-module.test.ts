// v1.2 §4 横切测试（跨模块集成）：
// §1 居民投资份额权威口径（股息按份额 → 居民现金；旧资产起始份额不被首个新出资者独占）
// §2 企业购债储备含逾期本金（储备覆盖下一期真实义务，购债不得占用偿债资金）
// 断言以跨模块闭环与守恒为主，不固化阶段性数值。
import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation/core/simulation';
import { DEMO_CONFIG } from '../src/data/config';
import { monthlyWageBill } from '../src/simulation/companies/company';
import { distributeDividend } from '../src/simulation/securities/securities';
import {
  allocateResidentDividendReturns,
  effectiveInvestorShares,
  ensureInvestorOpeningShares,
} from '../src/simulation/investors/investors';
import {
  applyHouseholdIncome,
  splitCityHouseholdIncome,
} from '../src/simulation/population/household-economy';
import { householdGroupsOfCity } from '../src/simulation/population/household-groups';
import {
  nextLoanObligation,
  serviceCompanyLoans,
} from '../src/simulation/banking/banking';
import {
  bondHolderAvailableCash,
  companyBondReserve,
  issueGovernmentBond,
  subscribeGovernmentBond,
} from '../src/simulation/government/bonds';
import type { FinanceResult } from '../src/simulation/finance/finance';
import type { City, LoanContract, LogEntry, WorldState } from '../src/simulation/contracts/types';

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function emptyFinance(investorDistributionByCity: Record<string, number> = {}): FinanceResult {
  return {
    investorDividendsByCity: {},
    investorDistributionByCity,
    cityDividendsByCity: {},
    dividendsByCity: {},
    playerDividends: 0,
    playerDividendsByCompany: {},
    corporateTaxByCity: {},
    privateWagesByCity: {},
    wageArrears: 0,
  };
}

function round2Money(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function pickCity(world: WorldState): City {
  return world.cities[0]!;
}

/** 把某城全部居民群体账本清零，只保留指定份额，用于验证“按份额”口径。 */
function resetLedgerShares(world: WorldState, cityId: string, sharesByGroup: Record<string, number>): void {
  for (const group of householdGroupsOfCity(world, cityId)) {
    group.investorLedger = {
      contributed: 0,
      shares: sharesByGroup[group.id] ?? 0,
      // 显式置 0：让 ensureInvestorOpeningShares 认为本城已初始化，
      // 避免按人口重新分摊开局无主旧资产，干扰“按份额”断言的隔离条件。
      openingShares: 0,
      dividends: 0,
      lastContributionTick: -1,
      lastDividendTick: -1,
    };
  }
}

function syntheticArrearsLoan(world: WorldState, companyId: string): LoanContract {
  const tick = world.time.tick;
  const loan: LoanContract = {
    id: 'loan-test-arrears',
    borrower: { kind: 'company', id: companyId },
    purpose: 'workingCapital',
    principal: 20_000,
    outstanding: 20_000,
    monthlyPrincipal: 1_000,
    rateMonthly: 0.005,
    termMonths: 24,
    startTick: 0,
    nextDueTick: tick,
    paidPrincipal: 0,
    paidInterest: 0,
    accruedInterest: 0,
    arrearsPrincipal: 8_000,
    arrearsInterest: 0,
    missedPayments: 1,
    status: 'active',
    payments: [],
    note: 'v1.2 集成测试：模拟已到期未付本金',
  };
  world.banking.loans = world.banking.loans.filter(
    (entry) => !(entry.borrower.kind === 'company' && entry.borrower.id === companyId),
  );
  world.banking.loans.push(loan);
  return loan;
}

describe('v1.2 §1 居民投资份额：股息按份额进入居民现金', () => {
  it('投资实体股息按群体有效份额返还：全体份额→现金闭合，无份额群体不受益', () => {
    const world = Simulation.create(DEMO_CONFIG).state;
    const city = pickCity(world);
    const groups = householdGroupsOfCity(world, city.id);
    expect(groups.length).toBeGreaterThan(1);

    ensureInvestorOpeningShares(world);
    // 只让第一个群体持有 1000 份，其余为 0（排除开局无主旧资产的影响）。
    resetLedgerShares(world, city.id, { [groups[0]!.id]: 1_000 });

    const investor = world.investors.find((entry) => entry.cityId === city.id)!;
    const holding = world.securities.holdings.find(
      (entry) => entry.holder.type === 'investorGroup' && entry.holder.id === investor.id,
    )!;
    expect(holding).toBeDefined();
    const company = world.companies.find((entry) => entry.id === holding.companyId)!;
    expect(company).toBeDefined();

    const dividendAmount = 10_000;
    const result = distributeDividend(world, company, dividendAmount, world.time.tick, DEMO_CONFIG);
    const distributed = result.investorDistributionByCity[city.id] ?? 0;
    expect(distributed).toBeGreaterThan(0);
    // 投资实体留存的股息进入实体现金；返还部分留给家庭结算。
    const retained = (result.investorByCity[city.id] ?? 0) - distributed;
    const cityInvestorCashAfterDividend = sum(
      world.investors.filter((entry) => entry.cityId === city.id).map((entry) => entry.cash),
    );

    const finance = emptyFinance({ [city.id]: distributed });
    // 先只读拆分，拿到股息归属与各群体本期应得收入（工资 + 股息 − 个税）。
    const split = splitCityHouseholdIncome(world, city, finance, 0, 0, DEMO_CONFIG);
    expect(sum(groups.map((group) => split.dividends.get(group.id) ?? 0))).toBeCloseTo(
      distributed,
      2,
    );
    expect(split.dividends.get(groups[0]!.id) ?? 0).toBeCloseTo(distributed, 2);
    for (let index = 1; index < groups.length; index++) {
      expect(split.dividends.get(groups[index]!.id) ?? 0).toBeCloseTo(0, 2);
    }

    const cashBefore = groups.map((group) => group.cash);
    const householdIncome = applyHouseholdIncome(world, city, finance, 0, 0, [], DEMO_CONFIG);
    expect(householdIncome).toBeCloseTo(split.householdIncome, 2);

    // 现金增量严格等于拆分出的工资+股息−个税，股息部分只落到有份额群体。
    for (let index = 0; index < groups.length; index++) {
      const group = groups[index]!;
      const expectedDelta = round2Money(
        (split.wages.get(group.id) ?? 0) +
          (split.benefits.get(group.id) ?? 0) +
          (split.dividends.get(group.id) ?? 0) -
          (split.taxes.get(group.id) ?? 0),
      );
      expect(group.cash - cashBefore[index]!).toBeCloseTo(expectedDelta, 2);
      expect(group.lastMonth.dividendIncome ?? 0).toBeCloseTo(
        split.dividends.get(group.id) ?? 0,
        2,
      );
    }
    expect(sum(groups.map((group) => group.lastMonth.dividendIncome ?? 0))).toBeCloseTo(
      distributed,
      2,
    );
    // 居民返还 + 实体留存 == 该投资实体收到的股息（同一笔钱不重复入账）。
    expect(retained + distributed).toBeCloseTo(result.investorByCity[city.id] ?? 0, 2);
    expect(cityInvestorCashAfterDividend).toBeGreaterThan(0);
  });

  it('开局无主旧资产按人口分摊为起始份额，新增出资不能独占全部股息', () => {
    const world = Simulation.create(DEMO_CONFIG).state;
    const city = pickCity(world);
    const groups = householdGroupsOfCity(world, city.id);

    ensureInvestorOpeningShares(world);
    const opening = groups.map((group) => effectiveInvestorShares(group.investorLedger));
    expect(sum(opening)).toBeGreaterThan(0);

    // 只有第一个群体新增出资，其他群体只有旧资产起始份额。
    const contributor = groups[0]!;
    contributor.investorLedger = {
      contributed: 100_000,
      shares: 100_000,
      dividends: 0,
      lastContributionTick: world.time.tick,
      lastDividendTick: -1,
    };
    const effective = groups.map((group) => effectiveInvestorShares(group.investorLedger));
    const totalEffective = sum(effective);
    expect(totalEffective).toBeGreaterThan(100_000); // 旧资产份额确实存在

    const amount = 1_000;
    const returns = allocateResidentDividendReturns(world, city.id, amount);
    const returned = sum(groups.map((group) => returns.get(group.id) ?? 0));
    expect(returned).toBeCloseTo(amount, 2);
    // 首个新出资者不能独占：其返还 < 全额，其他拥有旧资产份额的群体得到正返还。
    const contributorReturn = returns.get(contributor.id) ?? 0;
    expect(contributorReturn).toBeLessThan(amount);
    expect(contributorReturn).toBeCloseTo(
      (amount * effective[0]!) / totalEffective,
      1,
    );
    expect(
      groups.some((group, index) => index > 0 && (returns.get(group.id) ?? 0) > 0),
    ).toBe(true);

    // 重复初始化不重复补记，起始份额保持幂等。
    const snapshot = groups.map((group) => group.investorLedger?.openingShares ?? 0);
    ensureInvestorOpeningShares(world);
    expect(groups.map((group) => group.investorLedger?.openingShares ?? 0)).toEqual(snapshot);
  });
});

describe('v1.2 §2 企业购债储备含逾期本金', () => {
  it('储备的偿债项=下一期真实义务（含逾期本金），不是只算合同分期', () => {
    const world = Simulation.create(DEMO_CONFIG).state;
    const company = world.companies[0]!;
    const loan = syntheticArrearsLoan(world, company.id);
    const obligation = nextLoanObligation(loan, world.time.tick);
    expect(obligation.due).toBe(true);
    expect(obligation.scheduledPrincipal).toBeCloseTo(1_000, 2);
    expect(obligation.interestDue).toBeCloseTo(100, 2);
    expect(obligation.arrearsPrincipalDue).toBeCloseTo(8_000, 2);
    expect(obligation.collectiblePrincipal).toBeCloseTo(9_000, 2);
    expect(obligation.total).toBeCloseTo(9_100, 2);

    const base = companyBondReserve(world, DEMO_CONFIG, company.id)!;
    company.cash = base.reserved + 10_000;
    const reserve = companyBondReserve(world, DEMO_CONFIG, company.id)!;
    expect(reserve).not.toBeNull();
    expect(reserve.debtService).toBeCloseTo(obligation.total, 2);
    expect(reserve.reserved).toBeCloseTo(
      reserve.wages + reserve.materials + obligation.total,
      2,
    );
    expect(reserve.wages).toBeCloseTo(monthlyWageBill(company, DEMO_CONFIG) * 2, 2);
    expect(reserve.available).toBeCloseTo(10_000, 2);
    expect(
      bondHolderAvailableCash(world, DEMO_CONFIG, { kind: 'company', id: company.id }),
    ).toBeCloseTo(reserve.available, 2);
  });

  it('购债只能使用扣除储备后的现金；下期银行实收本息与储备口径一致', () => {
    const world = Simulation.create(DEMO_CONFIG).state;
    const city = pickCity(world);
    const company = world.companies[0]!;
    const loan = syntheticArrearsLoan(world, company.id);

    const reserve = companyBondReserve(world, DEMO_CONFIG, company.id)!;
    company.cash = reserve.reserved + 3_000;
    expect(
      bondHolderAvailableCash(world, DEMO_CONFIG, { kind: 'company', id: company.id }),
    ).toBeCloseTo(3_000, 2);

    const issue = issueGovernmentBond(world, city, DEMO_CONFIG, 100, world.time.tick);
    expect(issue.ok).toBe(true);
    const issuance = issue.issuance!;
    const subscription = subscribeGovernmentBond(
      world,
      DEMO_CONFIG,
      issuance.id,
      { kind: 'company', id: company.id },
      2,
      world.time.tick,
    );
    expect(subscription.ok).toBe(true);
    expect(subscription.units).toBe(2);
    // 购债后仍完整保留工资/原料/偿债储备（另剩 1000 可用现金）。
    expect(company.cash).toBeCloseTo(reserve.reserved + 1_000, 2);
    expect(company.cash).toBeGreaterThanOrEqual(reserve.wages + reserve.materials);

    const logs: LogEntry[] = [];
    const service = serviceCompanyLoans(world, company, DEMO_CONFIG, world.time.tick, logs);
    expect(service.interestPaid).toBeCloseTo(100, 2);
    expect(service.principalPaid).toBeCloseTo(9_000, 2);
    // 银行实收 == 储备中的偿债额，说明储备口径覆盖了真实义务。
    expect(service.interestPaid + service.principalPaid).toBeCloseTo(9_100, 2);
    expect(company.cash).toBeCloseTo(reserve.reserved + 1_000 - 9_100, 2);
    expect(company.cash).toBeGreaterThanOrEqual(reserve.wages + reserve.materials);
    expect(loan.arrearsPrincipal).toBeCloseTo(0, 2);
    expect(loan.arrearsInterest).toBeCloseTo(0, 2);
    expect(loan.outstanding).toBeCloseTo(11_000, 2);
    expect(loan.paidPrincipal).toBeCloseTo(9_000, 2);
  });
});
