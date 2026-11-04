// v0.9 真实旧档兼容测试。
//
// fixture `tests/fixtures/v0.9-real-f942cc9.json` 由 f942cc9（v0.9 发布版）代码真实生成：
//   git worktree add /tmp/v09-old f942cc9
//   ln -s /workspace/Coding/multi-city-sim/node_modules /tmp/v09-old/node_modules
//   在 /tmp/v09-old 用 tsx 运行 Simulation.create(DEMO_CONFIG) → 5 × tick() → 该版本 serializeSave
// 固定种子 seed=20261101、玩家无操作、默认 AI、推进 5 个月（详见 tests/fixtures/README.md）。
//
// 该旧档的 formatVersion 同为 9，但 Company 尚无 `equipmentCapacityRemainder`、
// EquipmentMarketState 尚无 `pendingLedger`。当前代码读取时必须：
// - 不因缺字段报错；按“整台设备 + 显式余量”补齐，保持旧产能不跳变；
// - 不重新执行新开局逻辑（不再乘 5、不追加开局企业）；
// - 不改变现金、债务、股份、库存、人口与时间进度，不凭空生成可售设备或资金。
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Simulation } from '../src/simulation/core/simulation';
import {
  parseSave,
  serializeSave,
  validateWorldStructure,
} from '../src/simulation/core/save';
import { checkInvariants } from '../src/simulation/core/invariants';
import { equipmentCapacityFor } from '../src/simulation/equipment/equipment';
import { DEMO_CONFIG } from '../src/data/config';
import { GAME_VERSION, SAVE_FORMAT_VERSION } from '../src/simulation/contracts/types';
import type { WorldState } from '../src/simulation/contracts/types';

const FIXTURE_URL = new URL('./fixtures/v0.9-real-f942cc9.json', import.meta.url);
const FIXTURE_TEXT = readFileSync(FIXTURE_URL, 'utf8');
const RAW_SAVE = JSON.parse(FIXTURE_TEXT) as {
  formatVersion: number;
  gameVersion: string;
  savedAt: string;
  world: any; // 真实旧档结构，测试内按字段读取
};
const RAW_WORLD = RAW_SAVE.world;
const COMPAT_LOG_PREFIX = '读取 v0.9 旧档';

const KINDS = ['farm', 'industry', 'energy'] as const;
const GOOD_IDS = Object.keys(RAW_WORLD.cities[0].market) as string[];

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function loadLegacy(): WorldState {
  const parsed = parseSave(FIXTURE_TEXT);
  if (!parsed.ok || !parsed.world) {
    throw new Error(`真实 v0.9 旧档读取失败：${parsed.error ?? '未知错误'}`);
  }
  return parsed.world;
}

function equipmentUnits(company: any): number {
  return sum(KINDS.map((kind) => Number(company.equipment?.[kind] ?? 0)));
}

function compatLogEntries(world: WorldState) {
  return world.log.filter((entry) => entry.message.startsWith(COMPAT_LOG_PREFIX));
}

describe('v0.9 真实旧档（f942cc9）读取兼容', () => {
  it('能成功读取真实旧档，不触发新开局逻辑（不乘 5、不追加开局企业）', () => {
    const parsed = parseSave(FIXTURE_TEXT);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || !parsed.world || !parsed.save) return;
    const world = parsed.world;

    expect(parsed.migratedFrom).toBeUndefined();
    expect(parsed.save.formatVersion).toBe(SAVE_FORMAT_VERSION);
    // 读取后以当前运行时版本记账（旧档本身是 0.9.0 保存；再存档会写成 1.0.0），
    // formatVersion 与 savedAt 原样保留，确保旧档内容不被新开局逻辑改写。
    expect(parsed.save.gameVersion).toBe(GAME_VERSION);
    expect(parsed.save.savedAt).toBe(RAW_SAVE.savedAt);
    expect(world.time.tick).toBe(RAW_WORLD.time.tick);
    expect(world.time.tick).toBe(5);

    // 旧档人口是 v0.9 已乘 5 后的真实值，读取时不得再次乘 5。
    expect(world.cities.map((city) => [city.id, city.population.total])).toEqual(
      RAW_WORLD.cities.map((city: any) => [city.id, city.population.total]),
    );
    expect(world.cities.find((city) => city.id === 'lanport')!.population.total).toBe(600077);

    // 企业数/名单与旧档完全一致，不追加 48 家新开局企业。
    expect(world.companies.map((company) => company.id)).toEqual(
      RAW_WORLD.companies.map((company: any) => company.id),
    );
    expect(world.companies).toHaveLength(RAW_WORLD.companies.length);

    expect(checkInvariants(world)).toEqual([]);
  });

  it('读取不改变金额、债务、股份、库存与进度', () => {
    const world = loadLegacy();
    const rawCompanies = RAW_WORLD.companies as any[];

    expect(sum(world.companies.map((company) => company.cash))).toBeCloseTo(
      sum(rawCompanies.map((company) => company.cash)),
      2,
    );
    expect(sum(world.companies.map((company) => company.debt))).toBeCloseTo(
      sum(rawCompanies.map((company) => company.debt)),
      2,
    );
    expect(sum(world.companies.map((company) => company.totalShares))).toBe(
      sum(rawCompanies.map((company) => company.totalShares)),
    );

    const inventoryTotal = (companies: any[], goodId: string) =>
      sum(companies.map((company) => Number(company.inventory?.[goodId] ?? 0)));
    for (const goodId of GOOD_IDS) {
      expect(inventoryTotal(world.companies, goodId)).toBeCloseTo(
        inventoryTotal(rawCompanies, goodId),
        2,
      );
    }

    expect(world.player.cash).toBeCloseTo(RAW_WORLD.player.cash, 2);
    expect(sum(world.investors.map((group) => group.cash))).toBeCloseTo(
      sum((RAW_WORLD.investors as any[]).map((group) => group.cash)),
      2,
    );
    expect(sum(world.banking.loans.map((loan) => loan.outstanding))).toBeCloseTo(
      sum((RAW_WORLD.banking.loans as any[]).map((loan) => loan.outstanding)),
      2,
    );

    // 时间、种子与随机状态不变（不重放、不回退进度）。
    expect(world.time).toEqual(RAW_WORLD.time);
    expect(world.seed).toBe(RAW_WORLD.seed);
    expect(world.rngState).toBe(RAW_WORLD.rngState);
    expect(world.lastTick).toEqual(RAW_WORLD.lastTick);
  });

  it('缺失的 equipmentCapacityRemainder 由兼容层补齐，且旧产能不跳变', () => {
    const world = loadLegacy();
    const rawCompanies = RAW_WORLD.companies as any[];

    // 真实旧档确实没有余量字段（确保 fixture 没有用当前代码伪造）。
    for (const company of rawCompanies) {
      expect(company.equipmentCapacityRemainder).toBeUndefined();
    }
    // 校验器对缺省字段保持兼容，不因旧档而报错。
    expect(validateWorldStructure(RAW_WORLD)).toBeNull();

    for (const company of world.companies) {
      const raw = rawCompanies.find((entry) => entry.id === company.id)!;
      expect(Number.isFinite(company.equipmentCapacityRemainder)).toBe(true);
      expect(company.equipmentCapacityRemainder).toBeGreaterThanOrEqual(0);
      // 产能缓存与权威口径一致：capacity = equipmentCapacity = 设备推导产能 + 余量。
      expect(company.capacity).toBeCloseTo(raw.capacity, 2);
      expect(company.equipmentCapacity).toBeCloseTo(raw.capacity, 2);
      expect(company.equipmentCapacity).toBeCloseTo(
        equipmentCapacityFor(world, company, DEMO_CONFIG),
        2,
      );
      // 设备台数只可能因旧档 round 取整伪影被减掉，绝不凭空增加。
      for (const kind of KINDS) {
        expect(company.equipment[kind]).toBeLessThanOrEqual(Number(raw.equipment[kind] ?? 0));
      }
    }

    // 旧产能存在非整数台设备的情况：至少一家企业记录正余量，且整体设备台数被向下修正。
    const rawUnits = sum(rawCompanies.map((company) => sum(KINDS.map((kind) => Number(company.equipment[kind] ?? 0)))));
    const loadedUnits = sum(world.companies.map((company) => equipmentUnits(company)));
    const remainderTotal = sum(world.companies.map((company) => company.equipmentCapacityRemainder));
    expect(world.companies.some((company) => company.equipmentCapacityRemainder > 0)).toBe(true);
    expect(remainderTotal).toBeGreaterThan(0);
    expect(loadedUnits).toBeLessThan(rawUnits);
    expect(checkInvariants(world)).toEqual([]);
  });

  it('兼容日志显式记录余量/取整修正，且不虚增资金或可售设备', () => {
    const world = loadLegacy();
    const entries = compatLogEntries(world);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.kind).toBe('system');
    expect(entries[0]!.message).toContain('余量');
    expect(entries[0]!.message).toContain('设备');
    expect(entries[0]!.message).toContain('未改变');
    expect(world.log).toHaveLength((RAW_WORLD.log as any[]).length + 1);

    // 设备市场库存/委托与旧档一致；只补空的 pendingLedger，不生成可售设备。
    expect(world.equipmentMarket.initialStock).toEqual(RAW_WORLD.equipmentMarket.initialStock);
    expect(world.equipmentMarket.offers).toHaveLength((RAW_WORLD.equipmentMarket.offers as any[]).length);
    expect(world.equipmentMarket.lastMonthSold).toEqual(RAW_WORLD.equipmentMarket.lastMonthSold);
    expect(world.equipmentMarket.pendingLedger).toEqual([]);

    // 设备商品市场库存/成交不变（余量不是商品，不能拿去卖钱）。
    for (const city of world.cities) {
      const rawCity = (RAW_WORLD.cities as any[]).find((entry) => entry.id === city.id)!;
      for (const goodId of GOOD_IDS) {
        expect(city.market[goodId as keyof typeof city.market].closingStock).toBeCloseTo(
          rawCity.market[goodId].closingStock,
          2,
        );
        expect(city.market[goodId as keyof typeof city.market].sold).toBeCloseTo(
          rawCity.market[goodId].sold,
          2,
        );
      }
    }
  });

  it('推进 1 个月：tick 成功、不变量为空、设备与产能保持一致', () => {
    const world = loadLegacy();
    const remaindersBefore = new Map(
      world.companies.map((company) => [company.id, company.equipmentCapacityRemainder]),
    );
    const simulation = new Simulation(world, DEMO_CONFIG);
    const result = simulation.tick();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);

    expect(simulation.validate()).toEqual([]);
    expect(simulation.state.time.tick).toBe(RAW_WORLD.time.tick + 1);
    // 一个月内新增企业属于正常经营/创办，但与“重新开局追加 48 家”完全不同。
    expect(simulation.state.companies.length).toBeGreaterThanOrEqual(RAW_WORLD.companies.length);
    // v1.1 每城每月最多自动创办 4 家（3 城合计 ≤12），且旧档不得重新执行开局（+48 家）。
    expect(simulation.state.companies.length).toBeLessThan(RAW_WORLD.companies.length + 13);

    for (const company of simulation.state.companies) {
      expect(company.capacity).toBeCloseTo(company.equipmentCapacity, 2);
      expect(company.capacity).toBeCloseTo(
        equipmentCapacityFor(simulation.state, company, DEMO_CONFIG),
        2,
      );
      if (remaindersBefore.has(company.id)) {
        // 余量只由旧档兼容写入，不随设备买卖转移，也不因重算而丢失。
        expect(company.equipmentCapacityRemainder).toBeCloseTo(
          remaindersBefore.get(company.id)!,
          2,
        );
      }
    }

    // 人口没有在推进时被再次乘 5。
    for (const city of simulation.state.cities) {
      const raw = (RAW_WORLD.cities as any[]).find((entry) => entry.id === city.id)!;
      expect(city.population.total).toBeGreaterThan(raw.population.total * 0.9);
      expect(city.population.total).toBeLessThan(raw.population.total * 1.2);
    }
  });

  it('推进后保存再读取：设备、余量、产能与进度保持一致', () => {
    const world = loadLegacy();
    const simulation = new Simulation(world, DEMO_CONFIG);
    expect(simulation.tick().ok).toBe(true);
    const savedText = serializeSave(simulation.state, '2026-11-04T00:00:00.000Z');

    const reparsed = parseSave(savedText);
    expect(reparsed.ok).toBe(true);
    if (!reparsed.ok || !reparsed.world) throw new Error(reparsed.error);
    const reloaded = reparsed.world;

    expect(reparsed.migratedFrom).toBeUndefined();
    expect(reloaded.time.tick).toBe(simulation.state.time.tick);
    expect(reloaded.companies).toHaveLength(simulation.state.companies.length);
    expect(reloaded.cities.map((city) => city.population.total)).toEqual(
      simulation.state.cities.map((city) => city.population.total),
    );
    expect(checkInvariants(reloaded)).toEqual([]);

    for (const company of reloaded.companies) {
      const before = simulation.state.companies.find((entry) => entry.id === company.id);
      if (!before) continue;
      expect(company.capacity).toBeCloseTo(before.capacity, 2);
      expect(company.equipmentCapacity).toBeCloseTo(before.equipmentCapacity, 2);
      expect(company.equipmentCapacityRemainder).toBeCloseTo(
        before.equipmentCapacityRemainder,
        2,
      );
      for (const kind of KINDS) {
        expect(company.equipment[kind]).toBe(before.equipment[kind]);
      }
    }

    // 新存档里已包含余量字段，再读取不应重复补日志（幂等）。
    expect(reloaded.log.filter((entry) => entry.message.startsWith(COMPAT_LOG_PREFIX))).toHaveLength(1);
  });

  it('兼容处理幂等：已有余量的存档再次读取不会重复补齐或改动金额', () => {
    const first = loadLegacy();
    const text = serializeSave(first, '2026-11-04T00:00:00.000Z');
    const second = parseSave(text);
    expect(second.ok).toBe(true);
    if (!second.ok || !second.world) throw new Error(second.error);

    expect(sum(second.world.companies.map((company) => company.cash))).toBeCloseTo(
      sum(first.companies.map((company) => company.cash)),
      2,
    );
    expect(second.world.companies.map((company) => company.equipmentCapacityRemainder)).toEqual(
      first.companies.map((company) => company.equipmentCapacityRemainder),
    );
    expect(compatLogEntries(second.world)).toHaveLength(1);
  });

  it('损坏旧档安全失败：缺少企业数据时返回可读错误而不是抛异常', () => {
    const broken = JSON.parse(FIXTURE_TEXT) as any;
    delete broken.world.companies;
    let parsed: ReturnType<typeof parseSave> | undefined;
    expect(() => {
      parsed = parseSave(JSON.stringify(broken));
    }).not.toThrow();
    expect(parsed?.ok).toBe(false);
    expect(parsed?.error).toMatch(/企业数据|companies/);
  });
});
