// v5 → v6 存档迁移：市场账本新增“生产计划需求（producerRequired）”与
// “资金不足未满足（unmetFunding）”两个统计字段（需求记账修复）。
//
// 旧 v5 存档没有这两个字段，迁移按保守口径补齐：计划需求 = 当月记录的有效需求，
// 资金不足 = 0；不修改价格、成交、库存与资金，也不重建历史。
import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation/core/simulation';
import { parseSave, serializeSave } from '../src/simulation/core/save';
import { SAVE_FORMAT_VERSION } from '../src/simulation/contracts/types';
import type { WorldState } from '../src/simulation/contracts/types';
import { checkInvariants } from '../src/simulation/core/invariants';

function currentWorld(months = 1): WorldState {
  const simulation = Simulation.create();
  for (let month = 0; month < months; month += 1) simulation.tick();
  return simulation.state;
}

/** 把当前存档降级成 v5：格式号改 5，并删除 v6 新增的市场统计字段。 */
function toV5(world: WorldState): string {
  const save = JSON.parse(serializeSave(world, '2026-11-01T00:00:00.000Z')) as {
    formatVersion: number;
    world: { cities: { market: Record<string, Record<string, unknown>> }[] };
  };
  save.formatVersion = 5;
  for (const city of save.world.cities) {
    for (const entry of Object.values(city.market)) {
      delete entry.producerRequired;
      delete entry.unmetFunding;
    }
  }
  return JSON.stringify(save);
}

describe('v5 → v6 市场账本字段迁移', () => {
  it('旧 v5 存档加载成功：migratedFrom=5，缺失字段按 producerDemand / 0 补齐', () => {
    const world = currentWorld(2);
    const original = JSON.parse(serializeSave(world)) as {
      world: { cities: { id: string; market: Record<string, { producerDemand: number }> }[] };
    };
    const text = toV5(world);
    const result = parseSave(text);
    expect(result.ok, result.error).toBe(true);
    expect(result.migratedFrom).toBe(5);
    expect(result.save?.formatVersion).toBe(SAVE_FORMAT_VERSION);
    const parsed = result.world!;
    for (const city of parsed.cities) {
      const before = original.world.cities.find((entry) => entry.id === city.id);
      for (const [goodId, market] of Object.entries(city.market)) {
        expect(market.producerRequired).toBe(before?.market[goodId]?.producerDemand ?? 0);
        expect(market.unmetFunding).toBe(0);
        // 其他市场字段与迁移前一致：迁移不改价格/成交/库存。
        const source = before?.market[goodId] as unknown as Record<string, number> | undefined;
        if (source) {
          expect(market.price).toBe(source.price);
          expect(market.sold).toBe(source.sold);
          expect(market.closingStock).toBe(source.closingStock);
        }
      }
    }
    expect(checkInvariants(parsed)).toEqual([]);
  });

  it('新存档往返：formatVersion 为当前版本，新字段保留', () => {
    const world = currentWorld(1);
    const city = world.cities[0]!;
    city.market.grain.producerRequired = 123.45;
    city.market.grain.unmetFunding = 6.78;
    const result = parseSave(serializeSave(world));
    expect(result.ok, result.error).toBe(true);
    expect(result.save?.formatVersion).toBe(SAVE_FORMAT_VERSION);
    expect(result.migratedFrom).toBeUndefined();
    const migratedCity = result.world!.cities[0]!;
    expect(migratedCity.market.grain.producerRequired).toBeCloseTo(123.45, 2);
    expect(migratedCity.market.grain.unmetFunding).toBeCloseTo(6.78, 2);
  });

  it('v4 存档仍可一路迁移到当前版本', () => {
    const world = currentWorld(1);
    const save = JSON.parse(serializeSave(world)) as { formatVersion: number };
    save.formatVersion = 4;
    const result = parseSave(JSON.stringify(save));
    // v4 → v5 → v6 迁移链要求 v4 存档缺少 v5/v6 字段，这里用 v5 存档结构模拟 v4 会缺少 v4→v5 字段；
    // 因此只断言版本链与迁移来源，不覆盖具体 v4 结构（v4→v5 由 migration-v5.test.ts 覆盖）。
    expect(result.migratedFrom).toBe(4);
    expect(result.save?.formatVersion).toBe(SAVE_FORMAT_VERSION);
  });
});
