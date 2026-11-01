import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation/core/simulation';
import { parseSave, serializeSave } from '../src/simulation/core/save';
import { checkInvariants } from '../src/simulation/core/invariants';
import { playerVotingShares } from '../src/simulation/securities/securities';

interface V1LikeSave {
  formatVersion: number;
  gameVersion: string;
  savedAt: string;
  world: Record<string, any>;
}

/** 把当前 v2 世界降级成 v1 结构，用于验证真实旧存档的迁移路径。 */
function toV1(world: ReturnType<typeof Simulation.create>['state']): V1LikeSave {
  const clone = JSON.parse(JSON.stringify(world)) as Record<string, any>;
  delete clone.securities;
  delete clone.governance;
  delete clone.investors;
  delete clone.agreements;
  delete clone.notifications;
  delete clone.player.roles;
  for (const city of clone.cities as Record<string, any>[]) {
    delete city.lastMonth.investorDividends;
    delete city.lastMonth.investableContribution;
  }
  for (const company of clone.companies as Record<string, any>[]) {
    delete company.previousMonth;
    delete company.dividendPayoutRatio;
    delete company.lastMonth.dividendIncome;
  }
  return {
    formatVersion: 1,
    gameVersion: '0.1.0',
    savedAt: '2026-11-01T00:00:00.000Z',
    world: clone,
  };
}

describe('旧存档（formatVersion 1）迁移', () => {
  it('迁移后保留人口、企业、库存、资金、玩家持股与随机状态，并补齐 v2 结构', () => {
    const sim = Simulation.create();
    for (let index = 0; index < 4; index++) {
      expect(sim.tick().ok).toBe(true);
    }
    expect(sim.invest('lp-food', 500_000).ok).toBe(true);
    expect(sim.tick().ok).toBe(true);

    const before = JSON.parse(JSON.stringify(sim.state));
    const v1 = toV1(sim.state);
    const result = parseSave(JSON.stringify(v1));

    expect(result.ok, result.error).toBe(true);
    expect(result.migratedFrom).toBe(1);
    const world = result.world!;

    // 原有资产与状态逐项保留。
    expect(world.player.cash).toBeCloseTo(before.player.cash, 2);
    const playerHolding = world.player.holdings.find((entry) => entry.companyId === 'lp-food');
    expect(playerHolding?.shares).toBeGreaterThan(0);
    expect(playerVotingShares(world, 'lp-food')).toBe(playerHolding?.shares ?? 0);
    expect(world.seed).toBe(before.seed);
    expect(world.rngState).toBe(before.rngState);
    expect(world.time).toEqual(before.time);
    for (const city of world.cities) {
      const previous = before.cities.find((entry: { id: string }) => entry.id === city.id);
      expect(city.population).toEqual(previous.population);
      expect(city.treasury).toBeCloseTo(previous.treasury, 2);
    }
    for (const company of world.companies) {
      const previous = before.companies.find((entry: { id: string }) => entry.id === company.id);
      expect(company.cash).toBeCloseTo(previous.cash, 2);
      expect(company.debt).toBeCloseTo(previous.debt, 2);
      expect(company.capacity).toBeCloseTo(previous.capacity, 2);
      expect(company.inventory).toEqual(previous.inventory);
    }

    // v2 新增结构：发行量守恒、居民实体现金为 0（不凭空创造资金）、治理/协议/通知为空。
    for (const company of world.companies) {
      const issued = world.securities.classes
        .filter((shareClass) => shareClass.companyId === company.id)
        .reduce((total, shareClass) => total + shareClass.issuedShares, 0);
      expect(issued).toBeCloseTo(company.totalShares, 2);
    }
    expect(world.investors.length).toBeGreaterThanOrEqual(3);
    expect(world.investors.every((group) => group.cash === 0)).toBe(true);
    expect(world.governance.motions).toEqual([]);
    expect(world.agreements).toEqual([]);
    expect(world.notifications).toEqual([]);
    expect(world.player.roles.mayorCityId).toBeNull();
    expect(checkInvariants(world)).toEqual([]);

    // 迁移后的世界可再次保存为 v2 并读回。
    const roundTrip = parseSave(serializeSave(world));
    expect(roundTrip.ok, roundTrip.error).toBe(true);
    expect(roundTrip.migratedFrom).toBeUndefined();
  });

  it('玩家持股超过发行量等无法安全推导的旧存档会被拒绝，并给出明确原因', () => {
    const sim = Simulation.create();
    const v1 = toV1(sim.state);
    v1.world.player.holdings = [{ companyId: 'lp-food', shares: 99_999_999 }];
    const result = parseSave(JSON.stringify(v1));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('无法安全迁移');
  });

  it('缺少企业发行量时拒绝迁移，而不是臆造股份', () => {
    const sim = Simulation.create();
    const v1 = toV1(sim.state);
    v1.world.companies[0].totalShares = 0;
    const result = parseSave(JSON.stringify(v1));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('发行股数无效');
  });
});
