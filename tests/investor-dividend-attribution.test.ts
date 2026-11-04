// v1.2 §1：居民投资份额与股息归属一致性。
//
// 核心 bug（修复前）：household-economy.splitCityHouseholdIncome 第 4 步把投资实体返还的
// 股息按 group.people 人口比例分给居民，而投资者账本 HouseholdGroup.investorLedger 才是
// 权威份额口径。验收复现：只有一个群体有份额、其他为 0 时，返还 1000 仍按人口分给所有人，
// 账本与现金流不一致。
//
// 修复后口径：
// - 有效份额 = 历史投入份额（1 信用点 = 1 份）+ 开局/旧档无主旧资产的一次性起始份额；
// - 返还现金、股息归属、报告占比全部按有效份额分摊（0.01 最大余数，合计严格相等）；
// - 开局旧资产不得被首个新增出资者无偿取得，也不凭空增现金（只记权益归属，不改现金）；
// - 人口自然变化不搬份额（只改变人均权益）；跨城迁移按人数比例拆份额，总额守恒；
// - 旧存档读取时补齐起始份额且幂等，SAVE_FORMAT_VERSION 保持 9。
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Simulation } from '../src/simulation/core/simulation';
import { DEMO_CONFIG } from '../src/data/config';
import type { FinanceResult } from '../src/simulation/finance/finance';
import type { HouseholdGroup, WorldState } from '../src/simulation/contracts/types';
import { round2 } from '../src/simulation/core/math';
import { parseSave, serializeSave } from '../src/simulation/core/save';
import { checkInvariants } from '../src/simulation/core/invariants';
import {
  applyHouseholdIncome,
  splitCityHouseholdIncome,
} from '../src/simulation/population/household-economy';
import {
  cityInvestorEquity,
  householdGroupsOfCity,
  syncHouseholdPeople,
} from '../src/simulation/population/household-groups';
import {
  allocateResidentDividendReturns,
  collectInvestableFunds,
  effectiveInvestorShares,
  ensureInvestorOpeningShares,
  groupsOfCity,
  householdBasicNeedReserve,
  transferInvestorLedgerForMigration,
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

/**
 * 把本城投资实体的“开局已有资产”（现金 + 持股）清零，用于构造“没有无主旧资产”的
 * 纯新增投入场景；只动投资实体的证券账户，不改任何居民现金。
 */
function clearInvestorAssets(world: WorldState, cityId = CITY_ID): void {
  const ids = new Set(groupsOfCity(world, cityId).map((group) => group.id));
  for (const investor of groupsOfCity(world, cityId)) investor.cash = 0;
  // 持股不能凭空消失（全部股份必须有人持有）；改挂到市政府名下，使其不再计入
  // 居民投资实体权益，同时股份持有人合计仍等于发行量。
  for (const holding of world.securities.holdings) {
    if (holding.holder.type !== 'investorGroup') continue;
    if (!ids.has(holding.holder.id)) continue;
    holding.holder = { type: 'city', id: cityId };
  }
}

/** 清空本月收入来源，避免工资/公共部门收入干扰股息口径断言（不改人口/就业口径）。 */
function silenceIncome(world: WorldState, cityId = CITY_ID): void {
  const city = cityOf(world, cityId);
  city.householdIncomeLastMonth = 0;
  for (const company of world.companies) {
    if (company.cityId !== cityId) continue;
    company.lastMonth.wagesPaid = 0;
  }
}

/** 只带“投资实体返还居民股息”的最小财政结果（其余收入为 0）。 */
function financeWithDividend(amount: number, cityId = CITY_ID): FinanceResult {
  return {
    investorDividendsByCity: {},
    investorDistributionByCity: { [cityId]: amount },
    cityDividendsByCity: {},
    dividendsByCity: {},
    playerDividends: 0,
    playerDividendsByCompany: {},
    corporateTaxByCity: {},
    privateWagesByCity: {},
    wageArrears: 0,
    dividendTaxByCity: {},
    playerDividendTax: 0,
  } as unknown as FinanceResult;
}

function nextMonth(world: WorldState, cityId = CITY_ID): void {
  world.time.tick += 1;
  const city = cityOf(world, cityId);
  city.lastMonth.investableContribution = 0;
  city.householdIncomeLastMonth = 0;
}

function collect(world: WorldState, cityId = CITY_ID): number {
  collectInvestableFunds(world, DEMO_CONFIG, []);
  return round2(cityOf(world, cityId).lastMonth.investableContribution);
}

function cashSnapshot(world: WorldState): Map<string, number> {
  return new Map(householdGroups(world).map((group) => [group.id, group.cash]));
}

function cashDelta(world: WorldState, before: Map<string, number>): Map<string, number> {
  return new Map(
    householdGroups(world).map((group) => [
      group.id,
      round2(group.cash - (before.get(group.id) ?? 0)),
    ]),
  );
}

function ledgerShares(world: WorldState): Map<string, number> {
  return new Map(
    householdGroups(world).map((group) => [group.id, effectiveInvestorShares(group.investorLedger)]),
  );
}

/**
 * 调用真实 applyHouseholdIncome 落地本月股息，并核对每个群体的实际现金变化
 * 恰等于分账结果（工资 + 转移 + 股息 − 个税），而不只是账本数字。
 */
function applyDividends(
  world: WorldState,
  amount: number,
  cityId = CITY_ID,
): { split: ReturnType<typeof splitCityHouseholdIncome>; delta: Map<string, number> } {
  const city = cityOf(world, cityId);
  const finance = financeWithDividend(amount, cityId);
  const split = splitCityHouseholdIncome(world, city, finance, 0, 0, DEMO_CONFIG);
  const before = cashSnapshot(world);
  applyHouseholdIncome(world, city, finance, 0, 0, [], DEMO_CONFIG);
  const delta = cashDelta(world, before);
  for (const group of householdGroups(world, cityId)) {
    const expected = round2(
      (split.wages.get(group.id) ?? 0) +
        (split.benefits.get(group.id) ?? 0) +
        (split.dividends.get(group.id) ?? 0) -
        (split.taxes.get(group.id) ?? 0),
    );
    expect(delta.get(group.id) ?? 0).toBeCloseTo(expected, 2);
  }
  return { split, delta };
}

/** 让单个群体成为唯一有闲钱的居民群体（其余群体现金清零）。 */
function fundOnlyGroup(world: WorldState, group: HouseholdGroup, idle: number): void {
  for (const other of householdGroups(world)) other.cash = 0;
  group.cash = round2(householdBasicNeedReserve(world, group, DEMO_CONFIG) + idle);
}

describe('居民投资份额与股息归属（v1.2 §1）', () => {
  it('验收复现：只有一个群体有份额、其他为 0 时，返还按份额而不是按人口', () => {
    const world = createWorld();
    silenceIncome(world);
    clearInvestorAssets(world);
    const groups = householdGroups(world);
    const first = groups[0];
    if (!first) throw new Error('缺少居民群体');
    fundOnlyGroup(world, first, 100_000);

    const contribution = collect(world);
    expect(contribution).toBeGreaterThan(0);
    // 只有出资群体有份额；其他群体份额为 0（实体本身无无主旧资产）。
    for (const group of groups) {
      const ledger = group.investorLedger;
      const expected = group.id === first.id ? contribution : 0;
      expect(round2((ledger?.shares ?? 0) + (ledger?.openingShares ?? 0))).toBeCloseTo(expected, 2);
    }

    // 实体返还 1000：修复前按人口分给所有人，修复后只按份额给唯一出资群体。
    const { split, delta } = applyDividends(world, 1_000);
    expect(split.dividends.get(first.id) ?? 0).toBeCloseTo(1_000, 2);
    for (const group of groups) {
      if (group.id === first.id) continue;
      // 其他群体可能仍有转移支付等收入，但股息份额必须为 0。
      expect(split.dividends.get(group.id) ?? 0).toBeCloseTo(0, 2);
    }
    expect(delta.get(first.id) ?? 0).toBeCloseTo(1_000, 2);
    expect(checkInvariants(world)).toEqual([]);
  });

  it('不等投入：返还按份额 1:3 落账，尾差 0.01 内闭合', () => {
    const world = createWorld();
    silenceIncome(world);
    clearInvestorAssets(world);
    const groups = householdGroups(world);
    const first = groups[0];
    const second = groups[1];
    if (!first || !second) throw new Error('缺少两个居民群体');
    for (const group of groups) group.cash = 0;
    first.cash = round2(householdBasicNeedReserve(world, first, DEMO_CONFIG) + 100_000);
    second.cash = round2(householdBasicNeedReserve(world, second, DEMO_CONFIG) + 300_000);
    collect(world);
    expect(first.investorLedger?.shares).toBeCloseTo(1_000, 2);
    expect(second.investorLedger?.shares).toBeCloseTo(3_000, 2);

    const { split } = applyDividends(world, 400);
    expect(split.dividends.get(first.id) ?? 0).toBeCloseTo(100, 2);
    expect(split.dividends.get(second.id) ?? 0).toBeCloseTo(300, 2);
    const total = round2(
      householdGroups(world).reduce((sum, group) => sum + (split.dividends.get(group.id) ?? 0), 0),
    );
    expect(total).toBeCloseTo(400, 2);
  });

  it('开局旧资产：首个新增出资者不能无偿取得，旧资产收益按人口起始份额归属', () => {
    const world = createWorld();
    silenceIncome(world);
    for (const group of householdGroups(world)) group.cash = 0;
    // 投资实体开局已有 500,000 现金（无任何居民投入、无股票持仓）。
    clearInvestorAssets(world);
    const investors = groupsOfCity(world, CITY_ID);
    if (!investors[0]) throw new Error('缺少投资实体');
    investors[0].cash = 500_000;
    const equityBefore = cityInvestorEquity(world, CITY_ID);
    expect(equityBefore).toBeCloseTo(500_000, 2);

    collect(world);
    const groups = householdGroups(world);
    const openingTotal = round2(
      groups.reduce((sum, group) => sum + (group.investorLedger?.openingShares ?? 0), 0),
    );
    expect(openingTotal).toBeCloseTo(equityBefore, 2);
    const peopleTotal = groups.reduce((sum, group) => sum + group.people, 0);
    for (const group of groups) {
      expect(group.investorLedger?.openingShares ?? 0).toBeCloseTo(
        round2((equityBefore * group.people) / peopleTotal),
        1,
      );
    }

    // 无新增投入，返还 1000 只按起始份额（人口）归属，不是被某一个人独占。
    const { split, delta } = applyDividends(world, 1_000);
    for (const group of groups) {
      const expected = round2((1_000 * group.people) / peopleTotal);
      // 起始份额按人口分摊时各群体已四舍五入到 0.01，股息再按份额分摊，
      // 与“纯人口比例”的误差不超过 1 信用点。
      expect(Math.abs((split.dividends.get(group.id) ?? 0) - expected)).toBeLessThan(1);
    }
    expect(round2(groups.reduce((sum, group) => sum + (split.dividends.get(group.id) ?? 0), 0))).toBe(
      1_000,
    );
    // 实际现金变化已由 applyDividends 逐组核对（= 工资+转移+股息−个税）。
    expect(delta.size).toBeGreaterThan(0);
    expect(checkInvariants(world)).toEqual([]);
  });

  it('仅一人新增投入：新旧份额合并计算归属，不重复扣款也不重复归属', () => {
    const world = createWorld();
    silenceIncome(world);
    for (const group of householdGroups(world)) group.cash = 0;
    clearInvestorAssets(world);
    const investors = groupsOfCity(world, CITY_ID);
    if (!investors[0]) throw new Error('缺少投资实体');
    investors[0].cash = 500_000;
    collect(world); // 初始化 500,000 起始份额

    const groups = householdGroups(world);
    const first = groups[0];
    if (!first) throw new Error('缺少居民群体');
    fundOnlyGroup(world, first, 100_000);
    nextMonth(world);
    const contribution = collect(world);
    expect(contribution).toBeGreaterThan(0);

    const totalEffective = round2(
      groups.reduce((sum, group) => sum + effectiveInvestorShares(group.investorLedger), 0),
    );
    expect(totalEffective).toBeCloseTo(500_000 + contribution, 2);
    const firstEffective = effectiveInvestorShares(first.investorLedger);
    expect(firstEffective).toBeGreaterThan(first.investorLedger?.openingShares ?? 0);

    const { split, delta } = applyDividends(world, 1_000);
    expect(split.dividends.get(first.id) ?? 0).toBeCloseTo(
      round2((1_000 * firstEffective) / totalEffective),
      1,
    );
    expect(delta.size).toBeGreaterThan(0);
  });

  it('返还与留存：返还现金按份额落地，账本归属合计=实体本月全部股息（含留存）', () => {
    const world = createWorld();
    silenceIncome(world);
    for (const group of householdGroups(world)) group.cash = 0;
    clearInvestorAssets(world);
    const investors = groupsOfCity(world, CITY_ID);
    if (!investors[0]) throw new Error('缺少投资实体');
    investors[0].cash = 300_000;
    collect(world); // 初始化起始份额（按人口）

    // 实体本月收到 1000 股息（含将留存部分）；返还给居民的只是 700。
    for (const investor of investors) investor.lastDividend = 0;
    investors[0].lastDividend = 1_000;
    nextMonth(world);
    collect(world);
    const ledgerTotal = round2(
      householdGroups(world).reduce(
        (sum, group) => sum + (group.investorLedger?.dividends ?? 0),
        0,
      ),
    );
    expect(ledgerTotal).toBeCloseTo(1_000, 2);

    const { split } = applyDividends(world, 700);
    const returned = round2(
      householdGroups(world).reduce((sum, group) => sum + (split.dividends.get(group.id) ?? 0), 0),
    );
    expect(returned).toBeCloseTo(700, 2);
    // 账本归属与现金返还使用同一份额比例：逐群体 返还 / 归属股息 ≈ 700 / 1000。
    for (const group of householdGroups(world)) {
      const attributed = group.investorLedger?.dividends ?? 0;
      if (attributed <= 0) continue;
      expect((split.dividends.get(group.id) ?? 0) / attributed).toBeCloseTo(0.7, 2);
    }
  });

  it('尾差 0.01：三个群体分摊除不尽时合计严格等于返还额', () => {
    const world = createWorld();
    silenceIncome(world);
    for (const group of householdGroups(world)) group.cash = 0;
    clearInvestorAssets(world);
    const investors = groupsOfCity(world, CITY_ID);
    if (!investors[0]) throw new Error('缺少投资实体');
    investors[0].cash = 1_000;
    collect(world); // 起始份额按人口分摊，通常除不尽

    const allocation = allocateResidentDividendReturns(world, CITY_ID, 1_000);
    const total = round2([...allocation.values()].reduce((sum, value) => sum + value, 0));
    expect(total).toBe(1_000);
    expect(allocation.size).toBeGreaterThan(1);
    for (const value of allocation.values()) expect(value).toBeGreaterThanOrEqual(0);

    const { split } = applyDividends(world, 1_000);
    expect(
      round2(householdGroups(world).reduce((sum, g) => sum + (split.dividends.get(g.id) ?? 0), 0)),
    ).toBe(1_000);
    expect(checkInvariants(world)).toEqual([]);
  });

  it('人口自然变化：份额挂在群体上不搬走，起始份额不重算', () => {
    const world = createWorld();
    collect(world); // 初始化起始份额
    const sharesBefore = ledgerShares(world);
    const openingBefore = new Map(
      householdGroups(world).map((group) => [
        group.id,
        group.investorLedger?.openingShares ?? 0,
      ]),
    );
    const city = cityOf(world);
    city.population.total += 500;
    syncHouseholdPeople(world, DEMO_CONFIG);
    const after = ledgerShares(world);
    for (const group of householdGroups(world)) {
      expect(after.get(group.id) ?? 0).toBeCloseTo(sharesBefore.get(group.id) ?? 0, 2);
      expect(group.investorLedger?.openingShares ?? 0).toBeCloseTo(
        openingBefore.get(group.id) ?? 0,
        2,
      );
    }
    // 实体现金变化（例如新增投资）后也不会重算起始份额（幂等）。
    const investors = groupsOfCity(world, CITY_ID);
    if (investors[0]) investors[0].cash = round2(investors[0].cash + 1_000_000);
    ensureInvestorOpeningShares(world);
    for (const group of householdGroups(world)) {
      expect(group.investorLedger?.openingShares ?? 0).toBeCloseTo(
        openingBefore.get(group.id) ?? 0,
        2,
      );
    }
  });

  it('跨城迁移：份额按人数比例拆分给目的地同职业群体，总额守恒且不产生现金', () => {
    const world = createWorld();
    const cities = [...world.cities].sort((a, b) => a.id.localeCompare(b.id));
    const from = cities[0];
    const to = cities[1];
    if (!from || !to) throw new Error('测试世界至少需要两个城市');
    const source = householdGroups(world, from.id).find((group) => group.occupation === 'unemployed');
    const destination = householdGroups(world, to.id).find(
      (group) => group.occupation === 'unemployed',
    );
    if (!source || !destination) throw new Error('缺少失业群体');
    source.people = 1_000;
    source.cash = 0;
    destination.cash = 0;
    source.investorLedger = {
      contributed: 400,
      shares: 400,
      openingShares: 200,
      dividends: 0,
      lastContributionTick: -1,
      lastDividendTick: -1,
    };
    destination.investorLedger = {
      contributed: 0,
      shares: 0,
      openingShares: 0,
      dividends: 0,
      lastContributionTick: -1,
      lastDividendTick: -1,
    };
    const totalBefore = round2(
      [...householdGroups(world, from.id), ...householdGroups(world, to.id)].reduce(
        (sum, group) => sum + effectiveInvestorShares(group.investorLedger),
        0,
      ),
    );
    const fromCash = source.cash;
    const toCash = destination.cash;

    transferInvestorLedgerForMigration(world, from.id, to.id, 250, 250);
    // 250 / 1000 = 25%：投入 100、份额 100、起始份额 50。
    expect(source.investorLedger.contributed).toBeCloseTo(300, 2);
    expect(source.investorLedger.shares).toBeCloseTo(300, 2);
    expect(source.investorLedger.openingShares).toBeCloseTo(150, 2);
    expect(destination.investorLedger.contributed).toBeCloseTo(100, 2);
    expect(destination.investorLedger.shares).toBeCloseTo(100, 2);
    expect(destination.investorLedger.openingShares).toBeCloseTo(50, 2);
    const totalAfter = round2(
      [...householdGroups(world, from.id), ...householdGroups(world, to.id)].reduce(
        (sum, group) => sum + effectiveInvestorShares(group.investorLedger),
        0,
      ),
    );
    expect(totalAfter).toBeCloseTo(totalBefore, 2);
    // 只迁移账本，不动现金。
    expect(source.cash).toBeCloseTo(fromCash, 2);
    expect(destination.cash).toBeCloseTo(toCash, 2);
  });

  it('旧档读取：补齐起始份额且幂等，不改现金、不重复归属', () => {
    const world = createWorld();
    silenceIncome(world);
    for (const group of householdGroups(world)) group.cash = 123.45;
    for (const investor of groupsOfCity(world, CITY_ID)) investor.cash = 0;
    const investors = groupsOfCity(world, CITY_ID);
    if (!investors[0]) throw new Error('缺少投资实体');
    investors[0].cash = 250_000;
    const equity = cityInvestorEquity(world, CITY_ID);
    // 模拟 v0.9/v1.1 旧档：没有账本、没有流水。
    for (const group of householdGroups(world)) delete group.investorLedger;
    delete world.households.investorFundingHistory;
    delete world.households.investorUsageHistory;
    const cashBefore = new Map(householdGroups(world).map((group) => [group.id, group.cash]));

    const restored = parseSave(serializeSave(world));
    expect(restored.ok, restored.error).toBe(true);
    const loaded = restored.world;
    if (!loaded) throw new Error('读档结果缺少世界');
    const groups = householdGroups(loaded);
    const openingTotal = round2(
      groups.reduce((sum, group) => sum + (group.investorLedger?.openingShares ?? 0), 0),
    );
    expect(openingTotal).toBeCloseTo(equity, 2);
    for (const group of groups) {
      expect(group.cash).toBeCloseTo(cashBefore.get(group.id) ?? 0, 2);
      expect(group.investorLedger?.openingShares).toBeDefined();
    }
    expect(checkInvariants(loaded)).toEqual([]);

    // 第二次存读档：起始份额不重算、不叠加。
    const again = parseSave(serializeSave(loaded));
    expect(again.ok, again.error).toBe(true);
    const reloaded = again.world;
    if (!reloaded) throw new Error('二次读档结果缺少世界');
    expect(
      householdGroups(reloaded).map((group) => group.investorLedger?.openingShares ?? 0),
    ).toEqual(groups.map((group) => group.investorLedger?.openingShares ?? 0));
  });

  it('v0.9 真实旧档：读取补齐起始份额且幂等，不改变现金', () => {
    const fixtureUrl = new URL('./fixtures/v0.9-real-f942cc9.json', import.meta.url);
    const text = readFileSync(fixtureUrl, 'utf8');
    const first = parseSave(text);
    expect(first.ok, first.error).toBe(true);
    if (!first.world) throw new Error('缺少旧档世界');
    const world = first.world;

    const cashSnapshotOf = (target: WorldState): number =>
      round2(
        target.cities.reduce(
          (sum, city) =>
            sum +
            householdGroupsOfCity(target, city.id).reduce(
              (acc, group) => acc + group.cash,
              0,
            ),
          0,
        ),
      );
    const openingSnapshotOf = (target: WorldState): string =>
      target.cities
        .map((city) =>
          householdGroupsOfCity(target, city.id)
            .map((group) => `${city.id}/${group.id}:${group.investorLedger?.openingShares ?? -1}`)
            .join(','),
        )
        .join(';');

    // 读取时补齐：每个群体的起始份额都必须是显式数字（旧档没有该字段）。
    for (const city of world.cities) {
      for (const group of householdGroupsOfCity(world, city.id)) {
        expect(group.investorLedger?.openingShares).toBeTypeOf('number');
      }
    }
    const cashBefore = cashSnapshotOf(world);
    const openingBefore = openingSnapshotOf(world);

    // 重复调用幂等：不重算、不改现金。
    ensureInvestorOpeningShares(world);
    expect(cashSnapshotOf(world)).toBe(cashBefore);
    expect(openingSnapshotOf(world)).toBe(openingBefore);

    // 存读档往返：改前/改后各解析一次，起始份额与现金完全一致且不重复归属。
    const second = parseSave(serializeSave(world));
    expect(second.ok, second.error).toBe(true);
    if (!second.world) throw new Error('缺少往返世界');
    expect(cashSnapshotOf(second.world)).toBe(cashBefore);
    expect(openingSnapshotOf(second.world)).toBe(openingBefore);
    expect(checkInvariants(second.world)).toEqual([]);
  });

  it('splitCityHouseholdIncome 的股息 Map 合计与实体返还额严格相等', () => {
    const world = createWorld();
    silenceIncome(world);
    for (const group of householdGroups(world)) group.cash = 0;
    for (const investor of groupsOfCity(world, CITY_ID)) investor.cash = 0;
    const investors = groupsOfCity(world, CITY_ID);
    if (!investors[0]) throw new Error('缺少投资实体');
    investors[0].cash = 7_777;
    collect(world);
    const split = splitCityHouseholdIncome(
      world,
      cityOf(world),
      financeWithDividend(1_234.56),
      0,
      0,
      DEMO_CONFIG,
    );
    const dividendTotal = round2(
      [...split.dividends.entries()].reduce((sum, [, value]) => sum + value, 0),
    );
    expect(dividendTotal).toBeCloseTo(1_234.56, 2);
    const shares = allocateResidentDividendReturns(world, CITY_ID, 1_234.56);
    for (const [groupId, value] of shares.entries()) {
      expect(split.dividends.get(groupId) ?? 0).toBeCloseTo(value, 2);
    }
  });
});
