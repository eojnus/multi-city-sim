// v1.7 验收修复回归：新开局/读档后继续推进的经济结果必须完全一致。
//
// 背景（验收问题一）：模块化 v10 存档读取钩子曾在读档时调用 ensureInvestorOpeningShares，
// 用“读档时点的投资实体净资产”提前写入 investorLedger.openingShares；而直接推进的新开局直到
// 第一次月度结算中需要有效份额时才计算。两者计算时点的资产不同 → 股息息归属/居民现金/城市
// 居民收入等后续经济结果分叉（rngState 相同也挡不住）。
//
// 修复后唯一初始化时点 = 第一次月度结算中首次需要有效份额时（tick 内确定性位置，幂等）；
// v10 读档不再预写 openingShares；旧单体存档仍在读取时一次性补齐（迁移兼容）。
//
// 本文件验证：
// 1) tick 0 直接推进 vs tick 0 存档→读取→推进：1 个 tick 与连续多个 tick 全量权威状态逐字段相等；
// 2) 存档读取不改变已经完整保存的 v10 权威状态（tick 0 与游戏中途都成立）；
// 3) 旧档缺少 openingShares 时读取补齐幂等：重复读取不重复分配、不增减现金、不覆盖已存在份额；
// 4) 读档→推进与直接推进的不变量均为空。

import { describe, expect, it } from 'vitest';
import { Simulation } from '../../src/simulation/core/simulation';
import { checkInvariants } from '../../src/simulation/core/invariants';
import { parseSave, serializeSave, createLegacySaveFile } from '../../src/simulation/core/save';
import type { WorldState } from '../../src/simulation/contracts/types';

const SAVED_AT = '2026-11-07T00:00:00.000Z';

/** JSON 规范化（复制纯数据、忽略对象字段插入顺序）。 */
function canonical(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

function advance(sim: Simulation, months: number): void {
  for (let index = 0; index < months; index += 1) {
    const result = sim.tick();
    if (result.ok === false) throw new Error(`第 ${index + 1} 月推进失败：${result.error ?? ''}`);
  }
}

/** 关键权威字段快照：居民现金/股息/份额、投资实体现金、城市居民收入、企业现金、银行账本、rng。 */
function economicSnapshot(world: WorldState): unknown {
  return canonical({
    time: world.time,
    rngState: world.rngState,
    playerCash: world.player.cash,
    companies: world.companies.map((company) => [company.id, company.cash, company.debt, company.totalShares]),
    cities: world.cities.map((city) => ({
      id: city.id,
      householdIncomeLastMonth: city.householdIncomeLastMonth,
      lastMonthInvestable: city.lastMonth.investableContribution,
      lastMonthHouseholdIncome: city.lastMonth.householdIncome,
      population: city.population.total,
      treasury: city.treasury,
      marketFood: city.market.food?.price,
    })),
    investors: world.investors.map((investor) => [
      investor.id,
      investor.cityId,
      investor.cash,
      investor.dividendsReceived,
    ]),
    groups: world.households.groups.map((group) => ({
      id: group.id,
      cityId: group.cityId,
      people: group.people,
      cash: group.cash,
      lastMonthIncome: group.lastMonth?.income,
      lastMonthDividendIncome: group.lastMonth?.dividendIncome,
      lastMonthSavingsContribution: group.lastMonth?.savingsContribution,
      investorLedger: group.investorLedger
        ? {
            contributed: group.investorLedger.contributed,
            shares: group.investorLedger.shares,
            dividends: group.investorLedger.dividends,
            openingShares: group.investorLedger.openingShares,
            lastContributionTick: group.investorLedger.lastContributionTick,
            lastDividendTick: group.investorLedger.lastDividendTick,
          }
        : undefined,
    })),
    bankingLoans: world.banking.loans.map((loan) => [loan.id, loan.status, loan.outstanding]),
    securitiesHoldings: world.securities.holdings.map((holding) => [
      holding.companyId,
      holding.shareClassId,
      holding.holder.type,
      holding.holder.id,
      holding.shares,
    ]),
  });
}

function cloneWorld(world: WorldState): WorldState {
  return JSON.parse(JSON.stringify(canonical(world))) as WorldState;
}

describe('v1.7 验收修复：开局份额初始化时点与存读档等价性', () => {
  it('tick 0：存档→读取→推进 1 月 与 直接推进 1 月 的全量经济结果一致', () => {
    const direct = Simulation.create();
    const restored = parseSave(serializeSave(direct.state, { savedAt: SAVED_AT }));
    expect(restored.ok, restored.error).toBe(true);
    if (!restored.ok || !restored.world) return;
    const restoredSim = new Simulation(restored.world);

    advance(direct, 1);
    advance(restoredSim, 1);

    expect(restoredSim.state.rngState).toBe(direct.state.rngState);
    expect(economicSnapshot(restoredSim.state)).toEqual(economicSnapshot(direct.state));
    expect(canonical(restoredSim.state)).toEqual(canonical(direct.state));
    expect(checkInvariants(direct.state)).toEqual([]);
    expect(checkInvariants(restoredSim.state)).toEqual([]);

    // 明确断言“开局份额”在两条路径上一致（这正是验收问题里分叉的字段）。
    const directOpening = direct.state.households.groups.map((group) => group.investorLedger?.openingShares);
    const restoredOpening = restoredSim.state.households.groups.map((group) => group.investorLedger?.openingShares);
    expect(restoredOpening).toEqual(directOpening);
    expect(directOpening.every((value) => value !== undefined)).toBe(true);

    // 居民现金/股息/投资实体现金/城市居民收入逐项一致。
    expect(restoredSim.state.households.groups.map((group) => [group.cash, group.lastMonth?.dividendIncome])).toEqual(
      direct.state.households.groups.map((group) => [group.cash, group.lastMonth?.dividendIncome]),
    );
    expect(restoredSim.state.investors.map((investor) => investor.cash)).toEqual(
      direct.state.investors.map((investor) => investor.cash),
    );
    expect(restoredSim.state.cities.map((city) => city.householdIncomeLastMonth)).toEqual(
      direct.state.cities.map((city) => city.householdIncomeLastMonth),
    );
  });

  it('连续 6 个 tick 每一步都保持一致（不是只比较随机数或总量）', () => {
    const directBase = Simulation.create();
    const restoredBase = parseSave(serializeSave(directBase.state, { savedAt: SAVED_AT }));
    expect(restoredBase.ok, restoredBase.error).toBe(true);
    if (!restoredBase.ok || !restoredBase.world) return;
    const direct = new Simulation(cloneWorld(directBase.state));
    const restored = new Simulation(restoredBase.world);

    for (let month = 1; month <= 6; month += 1) {
      advance(direct, 1);
      advance(restored, 1);
      expect(restored.state.rngState, `tick ${month} rngState`).toBe(direct.state.rngState);
      expect(economicSnapshot(restored.state), `tick ${month} 经济快照`).toEqual(
        economicSnapshot(direct.state),
      );
      expect(canonical(restored.state), `tick ${month} 全量世界`).toEqual(canonical(direct.state));
      expect(checkInvariants(restored.state)).toEqual([]);
    }
  });

  it('游戏中途存读档后继续推进，与直接推进一致（读档不改变完整权威状态）', () => {
    const direct = Simulation.create();
    advance(direct, 3);
    const text = serializeSave(direct.state, { savedAt: SAVED_AT });

    // 读档不应改变已经完整保存的状态（含中途已写入的 openingShares）。
    const parsed = parseSave(text);
    expect(parsed.ok, parsed.error).toBe(true);
    if (!parsed.ok || !parsed.world) return;
    expect(canonical(parsed.world)).toEqual(canonical(direct.state));

    const restored = new Simulation(parsed.world);
    advance(direct, 3);
    advance(restored, 3);
    expect(canonical(restored.state)).toEqual(canonical(direct.state));
    expect(checkInvariants(restored.state)).toEqual([]);
  });

  it('读档不预写 tick 0 的 openingShares（避免用读档时点资产重算开局份额）', () => {
    const fresh = Simulation.create().state;
    // 新开局按现有 v1.4 语义确实没有 openingShares。
    expect(fresh.households.groups.every((group) => group.investorLedger?.openingShares === undefined)).toBe(
      true,
    );
    const parsed = parseSave(serializeSave(fresh, { savedAt: SAVED_AT }));
    expect(parsed.ok, parsed.error).toBe(true);
    if (!parsed.ok || !parsed.world) return;
    expect(canonical(parsed.world)).toEqual(canonical(fresh));
    expect(
      parsed.world.households.groups.every((group) => group.investorLedger?.openingShares === undefined),
    ).toBe(true);
  });

  it('旧单体存档缺少 openingShares：读取一次性补齐且幂等，不重复分配、不增减现金、不覆盖已有份额', () => {
    // 从真实新开局构造旧档夹具，并移除 investorLedger 中的开局份额（模拟 v1.2 之前的旧档）。
    const world = Simulation.create().state;
    const legacy = JSON.parse(JSON.stringify(createLegacySaveFile(world, SAVED_AT))) as {
      formatVersion: number;
      world: WorldState;
    };
    for (const group of legacy.world.households.groups) {
      if (group.investorLedger) delete group.investorLedger.openingShares;
    }
    const legacyText = JSON.stringify(legacy);

    const first = parseSave(legacyText);
    expect(first.ok, first.error).toBe(true);
    if (!first.ok || !first.world) return;
    const second = parseSave(legacyText);
    expect(second.ok, second.error).toBe(true);
    if (!second.ok || !second.world) return;

    // 幂等：两次读取完全相同（不会重复分配）。
    expect(canonical(second.world)).toEqual(canonical(first.world));
    // 没有凭空增减现金：居民/投资实体/玩家现金合计一致。
    const cashTotal = (state: WorldState): number =>
      state.households.groups.reduce((sum, group) => sum + group.cash, 0) +
      state.investors.reduce((sum, investor) => sum + investor.cash, 0) +
      state.player.cash;
    expect(cashTotal(first.world)).toBeCloseTo(cashTotal(world), 2);
    // 开局份额被补齐（后续推进才有意义），且合计等于“无主旧资产”口径（非负、不超过净资产）。
    const opening = first.world.households.groups.map((group) => group.investorLedger?.openingShares ?? 0);
    expect(opening.every((value) => value >= 0)).toBe(true);
    expect(opening.reduce((sum, value) => sum + value, 0)).toBeGreaterThan(0);

    // 已存在于旧档中的合法 openingShares 不被覆盖：构造仅部分群体有值的旧档。
    const partial = JSON.parse(JSON.stringify(createLegacySaveFile(world, SAVED_AT))) as {
      formatVersion: number;
      world: WorldState;
    };
    const firstGroup = partial.world.households.groups[0]!;
    firstGroup.investorLedger = {
      ...(firstGroup.investorLedger ?? {
        contributed: 0,
        shares: 0,
        dividends: 0,
        lastContributionTick: -1,
        lastDividendTick: -1,
      }),
      openingShares: 123.45,
    };
    for (const group of partial.world.households.groups.slice(1)) {
      if (group.investorLedger) delete group.investorLedger.openingShares;
    }
    const partialLoaded = parseSave(JSON.stringify(partial));
    expect(partialLoaded.ok, partialLoaded.error).toBe(true);
    if (!partialLoaded.ok || !partialLoaded.world) return;
    const anchor = partialLoaded.world.households.groups[0]!;
    expect(anchor.investorLedger?.openingShares).toBe(123.45);
    // 既有初始化语义是“按城市”幂等：同城任一群体已有值 → 该城其余群体补 0（不重复分配）；
    // 其他从未初始化过的城市仍按无主净资产一次性分配（这是旧档迁移的既有行为）。
    const sameCityOthers = partialLoaded.world.households.groups.filter(
      (group) => group.id !== anchor.id && group.cityId === anchor.cityId,
    );
    expect(sameCityOthers.every((group) => group.investorLedger?.openingShares === 0)).toBe(true);
    const otherCities = partialLoaded.world.households.groups.filter(
      (group) => group.cityId !== anchor.cityId,
    );
    expect(otherCities.every((group) => (group.investorLedger?.openingShares ?? 0) >= 0)).toBe(true);

    // 旧档读取 → 保存为 v10 → 再读取：份额保持不变（只迁移一次）。
    const v10 = serializeSave(first.world, { savedAt: SAVED_AT });
    const roundTripped = parseSave(v10);
    expect(roundTripped.ok, roundTripped.error).toBe(true);
    if (!roundTripped.ok || !roundTripped.world) return;
    expect(
      roundTripped.world.households.groups.map((group) => group.investorLedger?.openingShares),
    ).toEqual(first.world.households.groups.map((group) => group.investorLedger?.openingShares));
  });

  it('旧档读取后从读档时点继续推进，与“读档→再存读档→推进”一致（迁移不引入额外差异）', () => {
    const world = Simulation.create().state;
    const legacy = JSON.parse(JSON.stringify(createLegacySaveFile(world, SAVED_AT))) as {
      formatVersion: number;
      world: WorldState;
    };
    for (const group of legacy.world.households.groups) {
      if (group.investorLedger) delete group.investorLedger.openingShares;
    }
    const loaded = parseSave(JSON.stringify(legacy));
    expect(loaded.ok, loaded.error).toBe(true);
    if (!loaded.ok || !loaded.world) return;
    const again = parseSave(serializeSave(loaded.world, { savedAt: SAVED_AT }));
    expect(again.ok, again.error).toBe(true);
    if (!again.ok || !again.world) return;

    const simA = new Simulation(loaded.world);
    const simB = new Simulation(again.world);
    advance(simA, 2);
    advance(simB, 2);
    expect(canonical(simB.state)).toEqual(canonical(simA.state));
    expect(checkInvariants(simA.state)).toEqual([]);
  });
});
