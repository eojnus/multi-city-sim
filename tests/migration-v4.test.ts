import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation/core/simulation';
import { parseSave, serializeSave } from '../src/simulation/core/save';
import { SAVE_FORMAT_VERSION } from '../src/simulation/contracts/types';
import { checkInvariants } from '../src/simulation/core/invariants';
import { playerVotingShares } from '../src/simulation/securities/securities';

type AnyWorld = Record<string, any>;

function currentWorld() {
  const sim = Simulation.create();
  for (let index = 0; index < 5; index++) expect(sim.tick().ok).toBe(true);
  expect(sim.invest('lp-food', 500_000).ok).toBe(true);
  expect(sim.tick().ok).toBe(true);
  return sim.state;
}

/** 把当前 v4 世界降级为 v3 结构：删除 v0.3 新增字段。 */
function toV3(world: ReturnType<typeof currentWorld>): AnyWorld {
  const clone = JSON.parse(JSON.stringify(world)) as AnyWorld;
  delete clone.transport;
  delete clone.politics;
  delete clone.policies;
  delete clone.fiscal;
  delete clone.lifecycle;
  for (const company of clone.companies as AnyWorld[]) delete company.ai;
  for (const city of clone.cities as AnyWorld[]) {
    delete city.workforce;
    delete city.housing;
    delete city.lastMonth.policySpending;
    delete city.lastMonth.transportSpending;
    city.technology.status = 'initial-only';
    city.politics.status = 'initial-only';
  }
  return clone;
}

/** 在 v3 基础上继续删除 v2→v3 的投票快照，得到 v2 结构。 */
function toV2(world: ReturnType<typeof currentWorld>): AnyWorld {
  const clone = toV3(world);
  for (const motion of clone.governance.motions as AnyWorld[]) delete motion.eligible;
  return clone;
}

/** 在 v2 基础上删除 v0.2 新增结构，得到 v1 结构。 */
function toV1(world: ReturnType<typeof currentWorld>): AnyWorld {
  const clone = toV2(world);
  delete clone.securities;
  delete clone.governance;
  delete clone.investors;
  delete clone.agreements;
  delete clone.notifications;
  delete clone.player.roles;
  for (const city of clone.cities as AnyWorld[]) {
    delete city.lastMonth.investorDividends;
    delete city.lastMonth.investableContribution;
  }
  for (const company of clone.companies as AnyWorld[]) {
    delete company.previousMonth;
    delete company.dividendPayoutRatio;
    delete company.lastMonth.dividendIncome;
  }
  return clone;
}

describe('旧存档迁移到 v4', () => {
  it('v3 → v4：保留人口、企业、库存、资金、股份、时间与随机状态，补齐新结构且不凭空发钱', () => {
    const before = JSON.parse(JSON.stringify(currentWorld()));
    const save = {
      formatVersion: 3,
      gameVersion: '0.2.1',
      savedAt: '2026-11-01T00:00:00.000Z',
      world: toV3(currentWorld()),
    };
    const result = parseSave(JSON.stringify(save));
    expect(result.ok, result.error).toBe(true);
    expect(result.migratedFrom).toBe(3);
    const world = result.world!;

    expect(world.player.cash).toBeCloseTo(before.player.cash, 2);
    expect(world.time).toEqual(before.time);
    expect(world.seed).toBe(before.seed);
    expect(world.rngState).toBe(before.rngState);
    for (const city of world.cities) {
      const previous = before.cities.find((entry: { id: string }) => entry.id === city.id);
      expect(city.population).toEqual(previous.population);
      expect(city.treasury).toBeCloseTo(previous.treasury, 2);
      expect(city.workforce).toBeDefined();
      expect(city.housing).toBeDefined();
      expect(city.lastMonth.policySpending).toBe(0);
      expect(city.lastMonth.transportSpending).toBe(0);
    }
    for (const company of world.companies) {
      const previous = before.companies.find((entry: { id: string }) => entry.id === company.id);
      expect(company.cash).toBeCloseTo(previous.cash, 2);
      expect(company.inventory).toEqual(previous.inventory);
      expect(company.ai).toBeDefined();
      expect(['growth', 'steady', 'return']).toContain(company.ai.style);
    }
    expect(world.securities.holdings.length).toBeGreaterThan(0);
    expect(playerVotingShares(world, 'lp-food')).toBeGreaterThanOrEqual(0);
    expect(world.policies.active).toEqual([]);
    expect(world.policies.history).toEqual([]);
    expect(world.fiscal.ledger).toEqual([]);
    expect(world.lifecycle.foundings).toEqual([]);
    expect(world.transport.links.length).toBeGreaterThan(0);
    expect(world.transport.intracity.length).toBe(world.cities.length);
    expect(world.politics.cities.length).toBe(world.cities.length);
    expect(world.politics.cities.every((entry) => entry.candidates.length > 0)).toBe(true);
    expect(checkInvariants(world)).toEqual([]);

    const roundTrip = parseSave(serializeSave(world));
    expect(roundTrip.ok, roundTrip.error).toBe(true);
    expect(roundTrip.migratedFrom).toBeUndefined();
    expect(roundTrip.save?.formatVersion).toBe(SAVE_FORMAT_VERSION);
  });

  it('v2 → v4：保留资产并补齐表决快照、企业与交通/政策数据', () => {
    const before = JSON.parse(JSON.stringify(currentWorld()));
    const save = {
      formatVersion: 2,
      gameVersion: '0.2.1',
      savedAt: '2026-11-01T00:00:00.000Z',
      world: toV2(currentWorld()),
    };
    const result = parseSave(JSON.stringify(save));
    expect(result.ok, result.error).toBe(true);
    expect(result.migratedFrom).toBe(2);
    const world = result.world!;
    expect(world.player.cash).toBeCloseTo(before.player.cash, 2);
    for (const motion of world.governance.motions) expect(Array.isArray(motion.eligible)).toBe(true);
    for (const company of world.companies) {
      const previous = before.companies.find((entry: { id: string }) => entry.id === company.id);
      expect(company.cash).toBeCloseTo(previous.cash, 2);
      expect(company.ai).toBeDefined();
    }
    expect(world.politics.cities.length).toBe(world.cities.length);
    expect(checkInvariants(world)).toEqual([]);
  });

  it('v1 → v4：连续迁移并保留可识别资产、时间、随机状态与玩家持股', () => {
    const before = JSON.parse(JSON.stringify(currentWorld()));
    const save = {
      formatVersion: 1,
      gameVersion: '0.1.0',
      savedAt: '2026-11-01T00:00:00.000Z',
      world: toV1(currentWorld()),
    };
    const result = parseSave(JSON.stringify(save));
    expect(result.ok, result.error).toBe(true);
    expect(result.migratedFrom).toBe(1);
    const world = result.world!;
    expect(world.player.cash).toBeCloseTo(before.player.cash, 2);
    expect(world.time).toEqual(before.time);
    expect(world.rngState).toBe(before.rngState);
    const playerHolding = world.player.holdings.find((entry) => entry.companyId === 'lp-food');
    expect(playerHolding?.shares).toBeGreaterThan(0);
    expect(playerVotingShares(world, 'lp-food')).toBe(playerHolding?.shares ?? 0);
    for (const company of world.companies) {
      const previous = before.companies.find((entry: { id: string }) => entry.id === company.id);
      expect(company.cash).toBeCloseTo(previous.cash, 2);
      expect(company.inventory).toEqual(previous.inventory);
      expect(company.ai).toBeDefined();
    }
    expect(world.investors.every((group) => group.cash === 0)).toBe(true);
    expect(world.policies.active).toEqual([]);
    expect(world.fiscal.ledger).toEqual([]);
    expect(checkInvariants(world)).toEqual([]);
    const roundTrip = parseSave(serializeSave(world));
    expect(roundTrip.ok, roundTrip.error).toBe(true);
    expect(roundTrip.save?.formatVersion).toBe(SAVE_FORMAT_VERSION);
  });

  it('未来版本、损坏 JSON 与缺少关键字段的存档安全失败', () => {
    const save = {
      formatVersion: SAVE_FORMAT_VERSION + 1,
      gameVersion: '9.9.9',
      savedAt: '2026-11-01T00:00:00.000Z',
      world: toV3(currentWorld()),
    };
    const future = parseSave(JSON.stringify(save));
    expect(future.ok).toBe(false);
    expect(future.error).toContain('高于当前支持');

    const corrupt = parseSave('{ not json');
    expect(corrupt.ok).toBe(false);

    const missing = {
      formatVersion: 4,
      gameVersion: '0.3.0',
      savedAt: '2026-11-01T00:00:00.000Z',
      world: { seed: 1 },
    };
    const broken = parseSave(JSON.stringify(missing));
    expect(broken.ok).toBe(false);
    expect(broken.error).toBeTruthy();
  });

  it('v4 存档经多次回合后往返，保留政策、交通与时间/随机状态', () => {
    const sim = Simulation.create();
    for (let index = 0; index < 8; index++) expect(sim.tick().ok).toBe(true);
    const text = serializeSave(sim.state);
    const parsed = parseSave(text);
    expect(parsed.ok, parsed.error).toBe(true);
    expect(parsed.migratedFrom).toBeUndefined();
    const world = parsed.world!;
    expect(world.time).toEqual(sim.state.time);
    expect(world.rngState).toBe(sim.state.rngState);
    expect(world.policies.active.length).toBe(sim.state.policies.active.length);
    expect(world.transport.lastMonth.trades.length).toBe(
      sim.state.transport.lastMonth.trades.length,
    );
    expect(world.fiscal.ledger.length).toBe(sim.state.fiscal.ledger.length);
    expect(checkInvariants(world)).toEqual([]);
  });
});
