// v1.0 第五节：居民闲钱投资实体（真实资金通道）测试。
//
// 口径（任务书第五节）：
// - 居民群体现金 → 投资实体现金是真实转账，不凭空补钱；
// - 先保留 3 个月基本生活需求，仅对保留额以上的闲置现金每月最多转入 1%；
// - 不提取存款、不借消费贷；失业/现金不足群体优先保障基本生活，不足不转；
// - 转入不得重复计入居民收入、旧持股或新增资产；权益按人口折算，不重复计价。
import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation/core/simulation';
import { DEMO_CONFIG } from '../src/data/config';
import type { HouseholdGroup, LogEntry, WorldState } from '../src/simulation/contracts/types';
import { deepClone, parseSave, serializeSave } from '../src/simulation/core/save';
import { round2 } from '../src/simulation/core/math';
import { checkInvariants } from '../src/simulation/core/invariants';
import {
  cityHouseholdCash,
  cityInvestorEquity,
  householdGroupsOfCity,
} from '../src/simulation/population/household-groups';
import { householdAssetBase, householdBasicNeedCost } from '../src/simulation/population/household-finance';
import { deposit, depositAccountFor } from '../src/simulation/banking/banking';
import {
  BASIC_NEED_RESERVE_MONTHS,
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

function investorGroups(world: WorldState, cityId = CITY_ID) {
  return groupsOfCity(world, cityId);
}

function sumBy<T>(items: T[], pick: (item: T) => number): number {
  return round2(items.reduce((sum, item) => sum + pick(item), 0));
}

function totalIdle(world: WorldState, cityId = CITY_ID): number {
  return sumBy(householdGroups(world, cityId), (group) => householdIdleCash(world, group, DEMO_CONFIG));
}

function totalSavings(world: WorldState, cityId = CITY_ID): number {
  return sumBy(
    householdGroups(world, cityId),
    (group) => group.lastMonth.savingsContribution,
  );
}

function collect(world: WorldState, cityId = CITY_ID, log: LogEntry[] = []): number {
  collectInvestableFunds(world, DEMO_CONFIG, log);
  return round2(cityOf(world, cityId).lastMonth.investableContribution);
}

describe('居民闲钱投资实体（v1.0 第五节）', () => {
  it('转入是真实转账：居民现金减少、投资实体同额增加，货币总量不变', () => {
    const world = createWorld();
    const city = cityOf(world);
    // 放大收入，让“1% 闲钱上限”成为约束（否则收入意愿额会更小）。
    city.householdIncomeLastMonth = 1_000_000_000;
    const groups = householdGroups(world);
    const investors = investorGroups(world);
    const cashBefore = cityHouseholdCash(world, city.id);
    const investorCashBefore = sumBy(investors, (group) => group.cash);
    const equityBefore = cityInvestorEquity(world, city.id);
    const playerCashBefore = world.player.cash;
    const incomeByGroup = groups.map((group) => group.lastMonth.income);
    const cityIncomeBefore = city.lastMonth.householdIncome;

    const contribution = collect(world);

    expect(contribution).toBeGreaterThan(0);
    expect(round2(cashBefore - cityHouseholdCash(world, city.id))).toBeCloseTo(contribution, 2);
    expect(
      round2(sumBy(investorGroups(world), (group) => group.cash) - investorCashBefore),
    ).toBeCloseTo(contribution, 2);
    // 货币总量：居民现金 + 投资实体现金不变。
    expect(
      round2(cityHouseholdCash(world, city.id) + sumBy(investorGroups(world), (group) => group.cash)),
    ).toBeCloseTo(round2(cashBefore + investorCashBefore), 2);
    // 权益只增加一次（实体现金），不是“现金+权益”双计。
    expect(round2(cityInvestorEquity(world, city.id) - equityBefore)).toBeCloseTo(contribution, 2);
    expect(city.householdIncomeLastMonth).toBeCloseTo(1_000_000_000 - contribution, 2);
    expect(city.lastMonth.householdIncome).toBeCloseTo(cityIncomeBefore, 2);
    expect(groups.map((group) => group.lastMonth.income)).toEqual(incomeByGroup);
    expect(world.player.cash).toBe(playerCashBefore);
    expect(totalSavings(world)).toBeCloseTo(contribution, 2);
    expect(checkInvariants(world)).toEqual([]);
  });

  it('1% 上限：每群体不超过自身闲置现金 1%，合计等于闲置池 1%', () => {
    const world = createWorld();
    cityOf(world).householdIncomeLastMonth = 1_000_000_000;
    const idles = householdGroups(world).map((group) => householdIdleCash(world, group, DEMO_CONFIG));
    const idleTotal = round2(idles.reduce((sum, value) => sum + value, 0));
    expect(idleTotal).toBeGreaterThan(0);

    const contribution = collect(world);

    const groups = householdGroups(world);
    groups.forEach((group, index) => {
      const cap = round2((idles[index] ?? 0) * IDLE_CASH_MONTHLY_INVEST_SHARE);
      expect(group.lastMonth.savingsContribution).toBeLessThanOrEqual(cap + 0.01);
      expect(group.cash).toBeGreaterThanOrEqual(0);
    });
    expect(contribution).toBeLessThanOrEqual(
      round2(idleTotal * IDLE_CASH_MONTHLY_INVEST_SHARE) + 0.01,
    );
    // 收入意愿额远大于闲钱上限时，按上限执行（不是按收入 6% 过度抽走）。
    expect(contribution).toBeGreaterThan(0);
  });

  it('3 个月基本生活需求保留：只转保留额以上的闲钱，低于保留额不转', () => {
    const world = createWorld();
    const city = cityOf(world, 'greenfield');
    city.householdIncomeLastMonth = 1_000_000_000;
    const groups = householdGroups(world, city.id);
    const target = groups.find((group) => group.occupation === 'management');
    if (!target) throw new Error('缺少 management 群体');
    const reserve = householdBasicNeedReserve(world, target, DEMO_CONFIG);
    expect(reserve).toBeCloseTo(
      round2(householdBasicNeedCost(world, target, DEMO_CONFIG) * BASIC_NEED_RESERVE_MONTHS),
      2,
    );
    // 其他群体没有现金；目标群体保留额之上仅多出 100000。
    for (const group of groups) group.cash = 0;
    target.cash = round2(reserve + 100_000);
    target.lastMonth.savingsContribution = 0;
    target.lastMonth.netCashChange = 0;

    const contribution = collect(world, 'greenfield');
    expect(contribution).toBeCloseTo(round2(100_000 * IDLE_CASH_MONTHLY_INVEST_SHARE), 2);
    expect(target.cash).toBeCloseTo(round2(reserve + 100_000 - contribution), 2);

    // 现金低于 3 个月保留额：没有闲钱，不转。
    const world2 = createWorld();
    const city2 = cityOf(world2, 'greenfield');
    city2.householdIncomeLastMonth = 1_000_000_000;
    const groups2 = householdGroups(world2, city2.id);
    for (const group of groups2) group.cash = 0;
    const target2 = groups2.find((group) => group.occupation === 'management');
    if (!target2) throw new Error('缺少 management 群体');
    const reserve2 = householdBasicNeedReserve(world2, target2, DEMO_CONFIG);
    target2.cash = round2(reserve2 - 1);
    const cashBefore = target2.cash;
    expect(collect(world2, 'greenfield')).toBe(0);
    expect(target2.cash).toBe(cashBefore);
    expect(target2.lastMonth.savingsContribution).toBe(0);
  });

  it('失业群体优先保障基本生活：闲钱池为 0 时不转，本金不受影响', () => {
    const world = createWorld();
    cityOf(world).householdIncomeLastMonth = 1_000_000_000;
    const groups = householdGroups(world);
    const unemployed = groups.find((group) => group.occupation === 'unemployed');
    if (!unemployed) throw new Error('缺少 unemployed 群体');
    const unemployedCashBefore = unemployed.cash;
    // 初始世界失业群体现金不足以覆盖 3 个月基本需求（人口多、现金少）。
    expect(householdIdleCash(world, unemployed, DEMO_CONFIG)).toBe(0);

    const contribution = collect(world);

    expect(contribution).toBeGreaterThan(0);
    expect(unemployed.lastMonth.savingsContribution).toBe(0);
    expect(unemployed.cash).toBe(unemployedCashBefore);
    // 就业群体按闲钱比例贡献。
    const employed = groups.filter(
      (group) => group.occupation !== 'unemployed' && group.occupation !== 'nonLabor',
    );
    expect(employed.some((group) => group.lastMonth.savingsContribution > 0)).toBe(true);
  });

  it('边界：现金为 0 但有存款时不提取存款、不借消费贷、不产生负现金', () => {
    const world = createWorld();
    cityOf(world).householdIncomeLastMonth = 1_000_000_000;
    const groups = householdGroups(world);
    const target = groups[0];
    if (!target) throw new Error('缺少居民群体');
    // 先把目标群体一部分现金存进银行，再模拟“手头没有现金”。
    for (const group of groups) group.cash = 0;
    const accountBefore = depositAccountFor(world, { kind: 'household', id: target.id });
    const accountBalanceBefore = accountBefore?.balance ?? 0;
    target.cash = 1_000_000;
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
    expect(account.balance).toBeCloseTo(accountBalanceBefore + 1_000_000, 2);
    target.cash = 0;
    const loansBefore = world.householdFinance?.loans.length ?? 0;

    const contribution = collect(world);

    expect(contribution).toBe(0);
    expect(account.balance).toBeCloseTo(accountBalanceBefore + 1_000_000, 2);
    expect(target.cash).toBe(0);
    expect(world.householdFinance?.loans.length ?? 0).toBe(loansBefore);
    for (const group of householdGroups(world)) expect(group.cash).toBeGreaterThanOrEqual(0);
  });

  it('权益不重复计：群体财产基准（现金+存款+权益）不因划转而改变', () => {
    const world = createWorld();
    cityOf(world).householdIncomeLastMonth = 1_000_000_000;
    const groups = householdGroups(world);
    const assetBefore = sumBy(groups, (group) => householdAssetBase(world, group, DEMO_CONFIG));
    const cashBefore = cityHouseholdCash(world, CITY_ID);
    const equityBefore = cityInvestorEquity(world, CITY_ID);

    const contribution = collect(world);

    const assetAfter = sumBy(
      householdGroups(world),
      (group) => householdAssetBase(world, group, DEMO_CONFIG),
    );
    expect(contribution).toBeGreaterThan(0);
    expect(assetAfter).toBeCloseTo(assetBefore, 0);
    expect(cityHouseholdCash(world, CITY_ID)).toBeCloseTo(cashBefore - contribution, 2);
    // 投资实体侧：现金增加、持股不变，权益只按现金增加一次。
    expect(round2(cityInvestorEquity(world, CITY_ID) - equityBefore)).toBeCloseTo(
      contribution,
      2,
    );
  });

  it('旧规则兼容：收入意愿额小于闲钱上限时，仍按 savingsRate 转入', () => {
    const world = createWorld();
    const city = cityOf(world);
    const groups = householdGroups(world);
    // 每组只留保留额 + 100 万，使闲钱上限（35000）远大于收入意愿额。
    for (const group of groups) {
      group.cash = round2(householdBasicNeedReserve(world, group, DEMO_CONFIG) + 1_000_000);
      group.lastMonth.savingsContribution = 0;
      group.lastMonth.netCashChange = 0;
    }
    city.householdIncomeLastMonth = 100_000;
    const desired = round2(100_000 * DEMO_CONFIG.investors.savingsRate);
    expect(round2(totalIdle(world) * IDLE_CASH_MONTHLY_INVEST_SHARE)).toBeGreaterThan(desired);

    const contribution = collect(world);

    expect(contribution).toBeCloseTo(desired, 2);
    expect(city.householdIncomeLastMonth).toBeCloseTo(100_000 - desired, 2);
  });

  it('同月幂等：重复调用不会二次扣款', () => {
    const world = createWorld();
    cityOf(world).householdIncomeLastMonth = 1_000_000_000;
    const first = collect(world);
    expect(first).toBeGreaterThan(0);
    const cashAfterFirst = cityHouseholdCash(world, CITY_ID);
    const savingsAfterFirst = totalSavings(world);

    const second = collect(world);

    expect(second).toBe(first);
    expect(cityHouseholdCash(world, CITY_ID)).toBe(cashAfterFirst);
    expect(totalSavings(world)).toBe(savingsAfterFirst);
  });

  it('存读档往返：转账结果、居民/实体现金与报告一致', () => {
    const world = createWorld();
    cityOf(world).householdIncomeLastMonth = 1_000_000_000;
    const contribution = collect(world);
    expect(contribution).toBeGreaterThan(0);
    const report = investorFundingReport(world);

    const restored = parseSave(serializeSave(world));
    expect(restored.ok, restored.error).toBe(true);
    const copy = restored.world!;
    expect(round2(cityOf(copy).lastMonth.investableContribution)).toBeCloseTo(contribution, 2);
    expect(cityHouseholdCash(copy, CITY_ID)).toBeCloseTo(cityHouseholdCash(world, CITY_ID), 2);
    expect(sumBy(investorGroups(copy), (group) => group.cash)).toBeCloseTo(
      sumBy(investorGroups(world), (group) => group.cash),
      2,
    );
    expect(totalSavings(copy)).toBeCloseTo(totalSavings(world), 2);
    expect(investorFundingReport(copy)).toEqual(report);
    expect(deepClone(copy).cities.length).toBe(copy.cities.length);
  });

  it('月度报告：来源、投资实体可用现金、持股与分红口径可追溯', () => {
    const world = createWorld();
    cityOf(world).householdIncomeLastMonth = 1_000_000_000;
    const contribution = collect(world);
    expect(contribution).toBeGreaterThan(0);

    const report = investorFundingReport(world);
    expect(report).toHaveLength(world.cities.length);
    for (const cityReport of report) {
      const city = cityOf(world, cityReport.cityId);
      expect(cityReport.householdContribution).toBeCloseTo(
        round2(city.lastMonth.investableContribution),
        2,
      );
      const investors = investorGroups(world, cityReport.cityId);
      expect(cityReport.groups).toHaveLength(investors.length);
      expect(cityReport.investorCash).toBeCloseTo(sumBy(investors, (group) => group.cash), 2);
      for (const groupReport of cityReport.groups) {
        const group = investors.find((entry) => entry.id === groupReport.groupId);
        if (!group) throw new Error(`报告缺少投资实体 ${groupReport.groupId}`);
        expect(groupReport.cash).toBeCloseTo(group.cash, 2);
        expect(groupReport.holdingsValue).toBeGreaterThanOrEqual(0);
        expect(groupReport.dividendsReceived).toBeGreaterThanOrEqual(0);
      }
      expect(cityReport.note).toContain('1%');
    }
    const lanportReport = report.find((entry) => entry.cityId === CITY_ID);
    expect(lanportReport?.householdContribution).toBeCloseTo(contribution, 2);
  });

  it('跨月：第二个月按新的闲钱池计算，转出额不超过上月', () => {
    const world = createWorld();
    cityOf(world).householdIncomeLastMonth = 1_000_000_000;
    const first = collect(world);
    expect(first).toBeGreaterThan(0);
    const idleAfterFirst = totalIdle(world);

    // 模拟进入下一个月：核心月结会把 investableContribution 清零。
    cityOf(world).lastMonth.investableContribution = 0;
    cityOf(world).householdIncomeLastMonth = 1_000_000_000;
    const second = collect(world);

    expect(second).toBeGreaterThan(0);
    expect(second).toBeLessThanOrEqual(
      round2(idleAfterFirst * IDLE_CASH_MONTHLY_INVEST_SHARE) + 0.01,
    );
    expect(second).toBeLessThan(first);
  });
});
