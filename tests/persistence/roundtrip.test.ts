// v1.7 存档系统：真实世界存读档一致性测试。
//
// 对应任务书 §9.2：
// - 真实世界（企业/贷款/债券/股份/政府/贸易/居民资产）序列化为 v10 模块格式并读回；
// - 权威字段一致、不变量为空；
// - 从同一初始状态分出两条路径：A 直接推进 vs B 存档→读档→推进，结果一致；
// - 导出/序列化不修改运行中的权威世界；读取失败不污染当前世界。

import { describe, expect, it } from 'vitest';
import { Simulation } from '../../src/simulation/core/simulation';
import { checkInvariants } from '../../src/simulation/core/invariants';
import { parseSave, serializeSave } from '../../src/simulation/core/save';
import type { WorldState } from '../../src/simulation/contracts/types';

/** 去掉 undefined 字段并规范为 JSON 纯数据（模块恢复后对象字段顺序可能不同，不能用字符串比较）。 */
function canonical(world: WorldState): unknown {
  return JSON.parse(JSON.stringify(world));
}

function advance(sim: Simulation, months: number): WorldState {
  for (let index = 0; index < months; index += 1) {
    const result = sim.tick();
    if (result.ok === false) throw new Error(`第 ${index + 1} 月推进失败：${result.error ?? ''}`);
  }
  return sim.state;
}

describe('v1.7 存档：真实世界往返', () => {
  it('v10 模块化文本：minified、11 个必填模块、无旧 world 字段；往返权威数据一致且不变量为空', () => {
    const world = advance(Simulation.create(), 6);
    const text = serializeSave(world, { savedAt: '2026-11-07T00:00:00.000Z' });
    expect(text).not.toContain('\n  ');
    expect((text.match(/\n/g) ?? []).length).toBe(0);
    const document = JSON.parse(text) as Record<string, unknown>;
    expect(document.formatVersion).toBe(10);
    expect(document.kind).toBe('lanwan-modules');
    expect('world' in document).toBe(false);
    const modules = document.modules as Record<string, { required: boolean; version: number }>;
    expect(Object.keys(modules).sort()).toEqual([
      'banking',
      'bonds',
      'company',
      'equipment',
      'government',
      'management',
      'marketTrade',
      'politics',
      'population',
      'securities',
      'world',
    ]);
    expect(Object.values(modules).every((module) => module.required && module.version === 1)).toBe(true);

    const parsed = parseSave(text);
    expect(parsed.ok, parsed.error).toBe(true);
    if (!parsed.ok || !parsed.world) return;
    expect(parsed.migratedFrom).toBeUndefined();
    expect(parsed.warnings ?? []).toEqual([]);
    expect(canonical(parsed.world)).toEqual(canonical(world));
    expect(checkInvariants(parsed.world)).toEqual([]);
  });

  it('新开局（0 月、尚未写入可选历史数组）也能保存并读回；读档幂等稳定', () => {
    const world = Simulation.create().state;
    const text = serializeSave(world, { savedAt: '2026-11-07T00:00:00.000Z' });
    const parsed = parseSave(text);
    expect(parsed.ok, parsed.error).toBe(true);
    if (!parsed.ok || !parsed.world) return;
    // 首次读档会执行既有的一次性读取迁移（ensureInvestorOpeningShares 补齐居民投资实体
    // 开局份额 investorLedger；旧单体格式同样如此），因此不强求与未迁移的 0 月世界逐字段相等；
    // 要求：关键权威字段一致、不变量为空、再次存读档完全稳定（迁移幂等）。
    expect(parsed.world.cities.map((city) => city.population.total)).toEqual(
      world.cities.map((city) => city.population.total),
    );
    expect(parsed.world.companies.map((company) => [company.id, company.cash])).toEqual(
      world.companies.map((company) => [company.id, company.cash]),
    );
    expect(parsed.world.player.cash).toBe(world.player.cash);
    expect(parsed.world.seed).toBe(world.seed);
    expect(parsed.world.rngState).toBe(world.rngState);
    expect(parsed.world.time).toEqual(world.time);
    expect(checkInvariants(parsed.world)).toEqual([]);

    const second = parseSave(serializeSave(parsed.world, { savedAt: '2026-11-07T00:00:00.000Z' }));
    expect(second.ok, second.error).toBe(true);
    if (!second.ok || !second.world) return;
    expect(canonical(second.world)).toEqual(canonical(parsed.world));
    expect(checkInvariants(second.world)).toEqual([]);
  });

  it('导出/序列化不修改运行中的权威世界', () => {
    const world = advance(Simulation.create(), 3);
    const before = JSON.stringify(canonical(world));
    serializeSave(world, { savedAt: '2026-11-07T00:00:00.000Z' });
    const after = JSON.stringify(canonical(world));
    expect(after).toBe(before);
  });

  it('读取失败不返回世界、不污染当前世界（候选世界未通过校验即丢弃）', () => {
    const world = advance(Simulation.create(), 2);
    const before = JSON.stringify(canonical(world));
    const parsed = parseSave('{"formatVersion":10,"kind":"lanwan-modules","gameVersion":"1.6.1","savedAt":"x","worldMeta":{},"modules":{}}');
    expect(parsed.ok).toBe(false);
    expect(parsed.world).toBeUndefined();
    expect(typeof parsed.error).toBe('string');
    expect(JSON.stringify(canonical(world))).toBe(before);
  });

  it('同一初始状态：A 直接推进 vs B 存档→读档→推进，权威结果一致', () => {
    const base = advance(Simulation.create(), 3);
    const text = serializeSave(base, { savedAt: '2026-11-07T00:00:00.000Z' });

    // A：从副本直接推进（不经过存档格式）。
    const directSim = new Simulation(JSON.parse(JSON.stringify(base)) as WorldState);
    const directWorld = advance(directSim, 2);

    // B：存档 → 读档 → 推进。
    const parsed = parseSave(text);
    expect(parsed.ok, parsed.error).toBe(true);
    if (!parsed.ok || !parsed.world) return;
    const loadedSim = new Simulation(parsed.world);
    const loadedWorld = advance(loadedSim, 2);

    expect(canonical(loadedWorld)).toEqual(canonical(directWorld));
    expect(checkInvariants(loadedWorld)).toEqual([]);
    // 关键权威字段抽查（人口/企业现金与库存/银行与居民贷款/债券/股份/政府财政/设备/市场）。
    expect(loadedWorld.cities.map((city) => city.population.total)).toEqual(
      directWorld.cities.map((city) => city.population.total),
    );
    expect(loadedWorld.companies.map((company) => [company.id, company.cash, company.debt])).toEqual(
      directWorld.companies.map((company) => [company.id, company.cash, company.debt]),
    );
    expect(loadedWorld.banking.loans.map((loan) => [loan.id, loan.status, loan.outstanding])).toEqual(
      directWorld.banking.loans.map((loan) => [loan.id, loan.status, loan.outstanding]),
    );
    expect(loadedWorld.bonds?.issuances.length).toBe(directWorld.bonds?.issuances.length);
    expect(loadedWorld.bonds?.holdings.length).toBe(directWorld.bonds?.holdings.length);
    expect(loadedWorld.securities.holdings.length).toBe(directWorld.securities.holdings.length);
    expect(loadedWorld.cities.map((city) => city.treasury)).toEqual(
      directWorld.cities.map((city) => city.treasury),
    );
    expect(loadedWorld.equipmentMarket.offers.length).toBe(directWorld.equipmentMarket.offers.length);
    expect(loadedWorld.cities.map((city) => city.market.food?.price ?? null)).toEqual(
      directWorld.cities.map((city) => city.market.food?.price ?? null),
    );
    expect(loadedWorld.rngState).toBe(directWorld.rngState);
  });

  it('未知可选模块被原样保留并在重新保存时写回', () => {
    const world = advance(Simulation.create(), 2);
    const text = serializeSave(world, { savedAt: '2026-11-07T00:00:00.000Z' });
    const document = JSON.parse(text) as Record<string, unknown>;
    const modules = document.modules as Record<string, unknown>;
    modules.futureOptional = { version: 3, required: false, data: { hello: 'future', nested: [1, 2] } };
    const parsed = parseSave(JSON.stringify(document));
    expect(parsed.ok, parsed.error).toBe(true);
    if (!parsed.ok || !parsed.world) return;
    expect(parsed.preservedModules?.futureOptional).toMatchObject({
      version: 3,
      required: false,
      data: { hello: 'future', nested: [1, 2] },
    });
    const reSaved = parseSave(serializeSave(parsed.world, { preservedModules: parsed.preservedModules }));
    expect(reSaved.ok).toBe(true);
    const reModules = (JSON.parse(serializeSave(parsed.world, { preservedModules: parsed.preservedModules })) as {
      modules: Record<string, unknown>;
    }).modules;
    expect(reModules.futureOptional).toEqual({
      version: 3,
      required: false,
      data: { hello: 'future', nested: [1, 2] },
    });
  });
});
