import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation/core/simulation';
import { DEMO_CONFIG } from '../src/data/config';
import { settleCompanyFinance } from '../src/simulation/finance/finance';
import { settleGovernment } from '../src/simulation/government/fiscal';
import {
  IDLE_CASH_MONTHLY_INVEST_SHARE,
  collectInvestableFunds,
  groupsOfCity,
  groupHolder,
  householdIdleCash,
} from '../src/simulation/investors/investors';
import { createShareStructure, distributeDividend } from '../src/simulation/securities/securities';
import { checkInvariants } from '../src/simulation/core/invariants';
import { round2 } from '../src/simulation/core/math';
import { householdGroupsOfCity } from '../src/simulation/population/household-groups';
import { syncCityPopulationFromAllocations } from '../src/simulation/population/population';
import type { Company, CompanyMonthlyStats, WorldState } from '../src/simulation/contracts/types';

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

/** 只让目标企业产生利润，其余企业无收入、无员工，便于核对单笔资金流。 */
function prepareWorld(companyId: string): { world: WorldState; company: Company } {
  const world = Simulation.create().state;
  for (const company of world.companies) {
    company.employees = 0;
    company.roles = { management: 0, production: 0, sales: 0, research: 0 };
    company.jobDemand = 0;
    company.baseWageBill = 0;
    company.debt = 0;
    company.cash = 1_000_000;
    company.lastMonth = blankStats();
    company.previousMonth = blankStats();
  }
  const company = world.companies.find((entry) => entry.id === companyId)!;
  company.cash = 50_000_000;
  company.lastMonth.revenue = 10_000_000;
  for (const city of world.cities) syncCityPopulationFromAllocations(city, world);
  return { world, company };
}

describe('居民股息资金流（不得重复计入）', () => {
  it('验收复现场景：896 股息的返还部分从实体现金扣除，不重复计入', () => {
    const world = Simulation.create().state;
    const company = world.companies.find((entry) => entry.id === 'lp-garment')!;
    const city = world.cities.find((entry) => entry.id === company.cityId)!;
    const group = groupsOfCity(world, city.id)[0]!;
    createShareStructure(world, company, {
      votingShares: 100,
      nonVotingShares: 0,
      votingHolders: [{ holder: groupHolder(group), shares: 100 }],
      nonVotingHolders: [],
      tick: world.time.tick,
      acquiredVia: 'primary',
    });
    const cashBefore = group.cash;
    const result = distributeDividend(world, company, 896, world.time.tick, DEMO_CONFIG);
    const gross = result.investorByCity[city.id] ?? 0;
    const distributed = result.investorDistributionByCity[city.id] ?? 0;
    expect(gross).toBeCloseTo(896, 2);
    expect(distributed).toBeCloseTo(627.2, 2);
    expect(group.cash - cashBefore).toBeCloseTo(268.8, 2);
    expect(round2(group.cash - cashBefore + distributed)).toBeCloseTo(896, 2);
    expect(result.total).toBeCloseTo(896, 2);
  });

  it('投资实体收到的股息只有留存部分留在实体现金，返还部分进入居民收入', () => {
    const { world, company } = prepareWorld('lp-garment');
    const city = world.cities.find((entry) => entry.id === company.cityId)!;
    const groups = groupsOfCity(world, city.id);
    const before = new Map(groups.map((group) => [group.id, group.cash]));

    const result = distributeDividend(world, company, 10_000, world.time.tick, DEMO_CONFIG);
    const gross = result.investorByCity[city.id] ?? 0;
    const distributed = result.investorDistributionByCity[city.id] ?? 0;

    expect(gross).toBeGreaterThan(0);
    expect(distributed).toBeCloseTo(
      round2(gross * DEMO_CONFIG.investors.dividendDistributionRate),
      1,
    );
    const groupGain = groups.reduce(
      (total, group) => total + (group.cash - (before.get(group.id) ?? 0)),
      0,
    );
    expect(groupGain).toBeCloseTo(gross - distributed, 2);
    // 实体现金增加 + 返还居民收入 = 实收股息，且两者互斥。
    expect(round2(groupGain + distributed)).toBeCloseTo(gross, 2);
    expect(result.investors + result.companies + result.player).toBeCloseTo(10_000, 2);
  });

  it('完整结算后居民收入只包含返还部分一次，储蓄划转再从消费预算扣除', () => {
    const { world, company } = prepareWorld('lp-food');
    const city = world.cities.find((entry) => entry.id === company.cityId)!;
    const groups = groupsOfCity(world, city.id);
    const groupCashBefore = new Map(groups.map((group) => [group.id, group.cash]));

    const finance = settleCompanyFinance(world, DEMO_CONFIG, []);
    const gross = finance.investorDividendsByCity[city.id] ?? 0;
    const distributed = finance.investorDistributionByCity[city.id] ?? 0;
    expect(gross).toBeGreaterThan(0);
    expect(distributed).toBeGreaterThan(0);

    const retained = round2(gross - distributed);
    // v0.8：居民投资实体按 10% 代扣股息税；留存现金 = 留存 − 代扣税。
    const playerTaxInCity =
      world.player.homeCityId === city.id ? (finance.playerDividendTax ?? 0) : 0;
    const investorTax = round2(
      (finance.dividendTaxByCity?.[city.id] ?? 0) - playerTaxInCity,
    );
    expect(investorTax).toBeCloseTo(round2(gross * DEMO_CONFIG.tax.dividendTaxRate), 0);
    const afterFinanceCash = groups.reduce(
      (total, group) => total + (group.cash - (groupCashBefore.get(group.id) ?? 0)),
      0,
    );
    expect(afterFinanceCash).toBeCloseTo(round2(retained - investorTax), 2);
    // 对账：实体现金留存 + 返还居民 + 代扣税 = 实收股息。
    expect(round2(afterFinanceCash + distributed + investorTax)).toBeCloseTo(gross, 2);

    settleGovernment(world, finance, DEMO_CONFIG, []);
    const publicGross = round2(
      city.publicSector.employees * city.publicSector.wageRate,
    );
    const expectedIncome = round2(
      (finance.privateWagesByCity[city.id] ?? 0) * (1 - city.incomeTaxRate) +
        publicGross * (1 - city.incomeTaxRate) +
        city.lastMonth.benefitsPaid +
        distributed,
    );
    expect(city.lastMonth.householdIncome).toBeCloseTo(expectedIncome, 2);
    expect(city.lastMonth.householdIncome).not.toBeCloseTo(
      expectedIncome + distributed,
      2,
    );

    const budgetBeforeSavings = city.householdIncomeLastMonth;
    expect(budgetBeforeSavings).toBeGreaterThan(0);
    // v1.0 闲钱投资规则：先保留 3 个月基本生活需求，只把超出的闲置现金每月最多转 1%；
    // 收入意愿额（收入 × savingsRate）与闲钱上限取小，二者相同时才按旧口径全额转出。
    const idleCap = round2(
      householdGroupsOfCity(world, city.id).reduce(
        (total, group) => total + householdIdleCash(world, group, DEMO_CONFIG),
        0,
      ) * IDLE_CASH_MONTHLY_INVEST_SHARE,
    );
    collectInvestableFunds(world, DEMO_CONFIG, []);
    const expectedContribution = round2(
      Math.min(budgetBeforeSavings * DEMO_CONFIG.investors.savingsRate, idleCap),
    );
    // v1.2：储蓄按群体逐笔分币 round2 后汇总，城市层面的目标额可能差 ≤ 1 分；
    // 这是分币取整（每笔转账与实体现金一一对应），不是资金丢失。
    const contribution = city.lastMonth.investableContribution;
    expect(contribution).toBeGreaterThan(0);
    expect(Math.abs(contribution - expectedContribution)).toBeLessThanOrEqual(0.02);
    expect(city.householdIncomeLastMonth).toBeCloseTo(budgetBeforeSavings - contribution, 2);

    const savingsGain = groups.reduce(
      (total, group) => total + (group.cash - (groupCashBefore.get(group.id) ?? 0)),
      0,
    );
    expect(savingsGain).toBeCloseTo(round2(retained - investorTax + contribution), 2);
    expect(checkInvariants(world)).toEqual([]);
  });

  it('多期结算中居民实体现金始终非负，股票买卖资金与股息可追溯', () => {
    const sim = Simulation.create();
    for (let index = 0; index < 24; index++) {
      const result = sim.tick();
      expect(result.ok, result.error).toBe(true);
    }
    for (const group of sim.state.investors) {
      expect(group.cash).toBeGreaterThanOrEqual(0);
      expect(group.dividendsReceived).toBeGreaterThanOrEqual(0);
    }
    expect(checkInvariants(sim.state)).toEqual([]);
    for (const city of sim.state.cities) {
      expect(city.lastMonth.investorDividends).toBeGreaterThanOrEqual(0);
      expect(city.lastMonth.investableContribution).toBeGreaterThanOrEqual(0);
    }
  });
});
