// v1.1 §2：居民闲钱投资实体——1% 上限、取消零收入门槛、可审计份额账本。
//
// 覆盖口径：
// - 收入为零但仍有超过 3 个月生活费的闲钱时，按闲钱 1% 上限转入（不再被“无收入”挡住）；
// - 闲钱不足 3 个月生活费时为 0，完全不动手头现金；
// - 失业群体有闲钱也可投，3 个月保留额不被突破；
// - 不提取存款、不借消费贷、现金不为负；
// - 与旧“按收入 savingsRate 转入”规则整合，同一笔只扣一次；
// - 份额账本与股息归属可审计，报告能读每月转入与用途；
// - 连续两月幂等、存读档往返保留账本与流水。
import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation/core/simulation';
import { DEMO_CONFIG } from '../src/data/config';
import type { HouseholdGroup, WorldState } from '../src/simulation/contracts/types';
import { round2 } from '../src/simulation/core/math';
import { parseSave, serializeSave } from '../src/simulation/core/save';
import { checkInvariants } from '../src/simulation/core/invariants';
import {
  cityHouseholdCash,
  householdGroupsOfCity,
} from '../src/simulation/population/household-groups';
import { deposit, depositAccountFor } from '../src/simulation/banking/banking';
import {
  IDLE_CASH_MONTHLY_INVEST_SHARE,
  collectInvestableFunds,
  groupsOfCity,
  householdBasicNeedReserve,
  householdIdleCash,
  investorFundingReport,
} from '../src/simulation/investors/investors';

const CITY_ID = 'lanport';

function createWorld(): WorldState {
  return Simulation.create().state;
}

function cityOf(world: WorldState, cityId = CITY_ID) {
  const city = world.cities.find((entry) => entry.id === cityId);
  if (!city) throw new Error(`测试世界缺少城市 ${cityId}`);
  return city;
}

function householdGroups(world: WorldState, cityId = CITY_ID): HouseholdGroup[] {
  return householdGroupsOfCity(world, cityId);
}

function totalIdle(world: WorldState, cityId = CITY_ID): number {
  return round2(
    householdGroups(world, cityId).reduce(
      (sum, group) => sum + householdIdleCash(world, group, DEMO_CONFIG),
      0,
    ),
  );
}

function investorCash(world: WorldState, cityId = CITY_ID): number {
  return round2(groupsOfCity(world, cityId).reduce((sum, group) => sum + group.cash, 0));
}

function collect(world: WorldState, cityId = CITY_ID): number {
  collectInvestableFunds(world, DEMO_CONFIG, []);
  return round2(cityOf(world, cityId).lastMonth.investableContribution);
}

/** 模拟进入下一个月：核心月结会把 city.lastMonth.investableContribution 清零。 */
function nextMonth(world: WorldState, income = 0, cityId = CITY_ID): void {
  // 推进 tick：真实月结会递增 tick 并清空本月投资额；流水按 (tick, 城) 记账。
  world.time.tick += 1;
  const city = cityOf(world, cityId);
  city.lastMonth.investableContribution = 0;
  city.householdIncomeLastMonth = income;
}

describe('居民闲钱投资实体（v1.1 §2）', () => {
  it('零收入但有闲钱：按闲置现金 1% 转入，现金减少等于实体现金增加', () => {
    const world = createWorld();
    const city = cityOf(world);
    city.householdIncomeLastMonth = 0;
    const idleCap = round2(totalIdle(world) * IDLE_CASH_MONTHLY_INVEST_SHARE);
    expect(idleCap).toBeGreaterThan(0);

    const cashBefore = cityHouseholdCash(world, city.id);
    const investorBefore = investorCash(world);
    const contribution = collect(world);

    // 旧规则（收入×savingsRate）会得到 0；新规则按闲钱上限执行。
    expect(contribution).toBeCloseTo(idleCap, 2);
    expect(round2(cashBefore - cityHouseholdCash(world, city.id))).toBeCloseTo(contribution, 2);
    expect(round2(investorCash(world) - investorBefore)).toBeCloseTo(contribution, 2);
    expect(city.householdIncomeLastMonth).toBe(0);
    expect(checkInvariants(world)).toEqual([]);
  });

  it('闲钱不足 3 个月生活费：转入为 0，现金与存款都不动', () => {
    const world = createWorld();
    const city = cityOf(world, 'greenfield');
    city.householdIncomeLastMonth = 0;
    const groups = householdGroups(world, city.id);
    for (const group of groups) group.cash = 0;
    const target = groups.find((group) => group.occupation === 'management');
    if (!target) throw new Error('缺少 management 群体');
    const reserve = householdBasicNeedReserve(world, target, DEMO_CONFIG);
    target.cash = round2(reserve - 1);
    const cashBefore = target.cash;

    expect(collect(world, 'greenfield')).toBe(0);
    expect(target.cash).toBe(cashBefore);
    expect(target.lastMonth.savingsContribution).toBe(0);
    expect(target.investorLedger?.shares ?? 0).toBe(0);
  });

  it('失业群体有闲钱可投：保留额不动，只转保留额以上的 1%', () => {
    const world = createWorld();
    cityOf(world).householdIncomeLastMonth = 0;
    const groups = householdGroups(world);
    // 只让失业群体有钱，确保贡献只来自它。
    for (const group of groups) group.cash = 0;
    const unemployed = groups.find((group) => group.occupation === 'unemployed');
    if (!unemployed) throw new Error('缺少 unemployed 群体');
    const reserve = householdBasicNeedReserve(world, unemployed, DEMO_CONFIG);
    unemployed.cash = round2(reserve + 1_000_000);

    const contribution = collect(world);

    expect(contribution).toBeCloseTo(round2(1_000_000 * IDLE_CASH_MONTHLY_INVEST_SHARE), 2);
    expect(unemployed.cash).toBeCloseTo(round2(reserve + 1_000_000 - contribution), 2);
    // 3 个月保留额没有被突破。
    expect(unemployed.cash).toBeGreaterThanOrEqual(reserve);
    expect(unemployed.lastMonth.savingsContribution).toBeCloseTo(contribution, 2);
    expect(unemployed.investorLedger?.contributed).toBeCloseTo(contribution, 2);
  });

  it('不提取存款、不借消费贷、现金不为负', () => {
    const world = createWorld();
    cityOf(world).householdIncomeLastMonth = 0;
    const groups = householdGroups(world);
    const target = groups[0];
    if (!target) throw new Error('缺少居民群体');
    // 先把一部分现金存进银行，再把所有人手头现金清零。
    for (const group of groups) group.cash = 0;
    target.cash = 2_000_000;
    const deposited = deposit(
      world,
      { kind: 'household', id: target.id },
      1_000_000,
      DEMO_CONFIG,
      world.time.tick,
    );
    expect(deposited.ok, deposited.error).toBe(true);
    const account = depositAccountFor(world, { kind: 'household', id: target.id });
    if (!account) throw new Error('存款账户未创建');
    const balanceBefore = account.balance;
    for (const group of groups) group.cash = 0;
    const loansBefore = world.householdFinance?.loans.length ?? 0;

    expect(collect(world)).toBe(0);

    expect(account.balance).toBe(balanceBefore);
    expect(world.householdFinance?.loans.length ?? 0).toBe(loansBefore);
    for (const group of householdGroups(world)) expect(group.cash).toBeGreaterThanOrEqual(0);
  });

  it('与旧按收入转入整合：只扣一次，收入意愿额小于闲钱上限时按 savingsRate', () => {
    const world = createWorld();
    const city = cityOf(world);
    const groups = householdGroups(world);
    // 每组保留额 + 100 万，使闲钱上限（每群 10000）远大于收入意愿额。
    for (const group of groups) {
      group.cash = round2(householdBasicNeedReserve(world, group, DEMO_CONFIG) + 1_000_000);
      group.lastMonth.savingsContribution = 0;
      group.lastMonth.netCashChange = 0;
    }
    city.householdIncomeLastMonth = 100_000;
    const desired = round2(100_000 * DEMO_CONFIG.investors.savingsRate);
    expect(round2(totalIdle(world) * IDLE_CASH_MONTHLY_INVEST_SHARE)).toBeGreaterThan(desired);

    const before = cityHouseholdCash(world, CITY_ID);
    const contribution = collect(world);

    expect(contribution).toBeCloseTo(desired, 2);
    // 收入只按转入额减少一次（不叠加旧规则再扣一次）。
    expect(city.householdIncomeLastMonth).toBeCloseTo(100_000 - contribution, 2);
    expect(round2(before - cityHouseholdCash(world, CITY_ID))).toBeCloseTo(contribution, 2);
    const savings = round2(
      groups.reduce((sum, group) => sum + group.lastMonth.savingsContribution, 0),
    );
    expect(savings).toBeCloseTo(contribution, 2);
    // 账本累计投入 = 本月实际转入（1:1 份额）。
    const ledgerTotal = round2(
      groups.reduce((sum, group) => sum + (group.investorLedger?.contributed ?? 0), 0),
    );
    expect(ledgerTotal).toBeCloseTo(contribution, 2);
  });

  it('份额账本可审计：投入 1:1 记份额，股息按份额归属且合计等于实体股息', () => {
    const world = createWorld();
    cityOf(world).householdIncomeLastMonth = 0;
    const groups = householdGroups(world);
    for (const group of groups) group.cash = 0;
    const first = groups[0];
    const second = groups[1];
    if (!first || !second) throw new Error('缺少两个居民群体');
    first.cash = round2(householdBasicNeedReserve(world, first, DEMO_CONFIG) + 1_000_000);
    second.cash = round2(householdBasicNeedReserve(world, second, DEMO_CONFIG) + 3_000_000);

    const contribution = collect(world);
    expect(contribution).toBeGreaterThan(0);
    const ledgerFirst = first.investorLedger;
    const ledgerSecond = second.investorLedger;
    if (!ledgerFirst || !ledgerSecond) throw new Error('未建立投资份额账本');
    expect(ledgerFirst.contributed).toBeCloseTo(first.lastMonth.savingsContribution, 2);
    expect(ledgerFirst.shares).toBeCloseTo(ledgerFirst.contributed, 2);
    // 投入多的群体份额更多（3:1 左右）。
    expect(ledgerSecond.shares).toBeGreaterThan(ledgerFirst.shares);

    // 下个月实体收到股息；账本按份额归属，但不改任何现金。
    const investors = groupsOfCity(world, CITY_ID);
    for (const investor of investors) investor.lastDividend = 0;
    if (investors[0]) investors[0].lastDividend = 400;
    if (investors[1]) investors[1].lastDividend = 600;
    const cashBefore = cityHouseholdCash(world, CITY_ID);
    nextMonth(world, 0);
    collect(world);

    const totalLedgerDividends = round2(
      groups.reduce((sum, group) => sum + (group.investorLedger?.dividends ?? 0), 0),
    );
    expect(totalLedgerDividends).toBeCloseTo(1_000, 2);
    // v1.2 §1：权威口径 = 有效份额（历史投入份额 + 开局无主旧资产起始份额）。
    expect(groups.every((group) => group.investorLedger?.openingShares !== undefined)).toBe(true);
    const effectiveShares = (group: {
      investorLedger?: { shares: number; openingShares?: number };
    }): number => round2((group.investorLedger?.shares ?? 0) + (group.investorLedger?.openingShares ?? 0));
    const totalShares = round2(groups.reduce((sum, group) => sum + effectiveShares(group), 0));
    expect(ledgerFirst.dividends).toBeCloseTo(
      round2((1_000 * effectiveShares(first)) / totalShares),
      1,
    );
    expect(ledgerSecond.dividends).toBeCloseTo(
      round2((1_000 * effectiveShares(second)) / totalShares),
      1,
    );
    // 归属只是账本记录，现金仅因本月转入而减少（不额外划走股息）。
    expect(cashBefore - cityHouseholdCash(world, CITY_ID)).toBeGreaterThanOrEqual(0);
    expect(checkInvariants(world)).toEqual([]);
  });

  it('连续两个月：每月各记一条流水，重复调用同一月不追加、不二次扣款', () => {
    const world = createWorld();
    cityOf(world).householdIncomeLastMonth = 0;
    const first = collect(world);
    expect(first).toBeGreaterThan(0);
    const cashAfterFirst = cityHouseholdCash(world, CITY_ID);

    // 同月重复调用：幂等。
    expect(collect(world)).toBe(first);
    expect(cityHouseholdCash(world, CITY_ID)).toBe(cashAfterFirst);

    nextMonth(world, 0);
    const second = collect(world);
    expect(second).toBeGreaterThan(0);

    const report = investorFundingReport(world).find((entry) => entry.cityId === CITY_ID);
    if (!report) throw new Error('缺少 lanport 报告');
    expect(report.monthlyFunding).toHaveLength(2);
    expect(report.monthlyFunding[0]?.amount).toBeCloseTo(first, 2);
    expect(report.monthlyFunding[1]?.amount).toBeCloseTo(second, 2);
    expect(report.usage.contributed).toBeCloseTo(second, 2);
    expect(report.usage.closingCash).toBeCloseTo(investorCash(world), 2);
    expect(report.usage.invested).toBeGreaterThanOrEqual(0);
    expect(report.householdShares.length).toBeGreaterThan(0);
    expect(report.note).toContain('1%');
    // 同一月再调一次：流水不追加。
    const beforeReplay = report.monthlyFunding.length;
    collect(world);
    const replayReport = investorFundingReport(world).find((entry) => entry.cityId === CITY_ID);
    expect(replayReport?.monthlyFunding.length).toBe(beforeReplay);
  });

  it('存读档往返：份额账本、投资流水与报告保持一致（存档 v9 兼容）', () => {
    const world = createWorld();
    cityOf(world).householdIncomeLastMonth = 0;
    collect(world);
    nextMonth(world, 0);
    collect(world);
    const report = investorFundingReport(world);
    const ledgers = householdGroups(world).map((group) => ({
      id: group.id,
      contributed: group.investorLedger?.contributed ?? 0,
      shares: group.investorLedger?.shares ?? 0,
    }));

    const restored = parseSave(serializeSave(world));
    expect(restored.ok, restored.error).toBe(true);
    const copy = restored.world;
    if (!copy) throw new Error('读档结果缺少世界');
    expect(
      householdGroups(copy).map((group) => ({
        id: group.id,
        contributed: group.investorLedger?.contributed ?? 0,
        shares: group.investorLedger?.shares ?? 0,
      })),
    ).toEqual(ledgers);
    expect(copy.households.investorFundingHistory?.length ?? 0).toBeGreaterThan(0);
    expect(copy.households.investorUsageHistory?.length ?? 0).toBeGreaterThan(0);
    expect(investorFundingReport(copy)).toEqual(report);
  });
});
