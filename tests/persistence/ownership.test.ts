// v1.7 存档系统：数据归属完整性测试。
//
// 目标（任务书 §9.1 “各系统权威数据不会重复导出并重复恢复”）：
// - 默认注册表必须注册全部内置模块，ID/版本/必需标志正确；
// - 对真实世界做“字段归属覆盖检查”：WorldState 的每个顶层字段、City 的每个字段都恰好被
//   一个模块声明拥有（cities 是复合载体，按 City 子字段检查），漏归属或重复归属即失败；
// - 每个模块的 ownedPaths 顶层段必须是真实存在的世界字段/城市字段，避免拼写错误造成“声明了但不恢复”；
// - 顶层格式版本单一来源（contracts/types.ts 的 SAVE_FORMAT_VERSION 与 persistence 常量一致）。

import { describe, expect, it } from 'vitest';
import { Simulation } from '../../src/simulation/core/simulation';
import { SAVE_FORMAT_VERSION } from '../../src/simulation/contracts/types';
import { createDefaultSaveRegistry, DEFAULT_SAVE_MODULE_IDS } from '../../src/simulation/persistence/modules';
import { MODULE_SAVE_FORMAT_VERSION, MODULE_SAVE_KIND } from '../../src/simulation/persistence/types';
import { savePathsOverlap } from '../../src/simulation/persistence/registry';

/** 顶级路径段（`cities[].population` → 'cities'；`banking.loans` → 'banking'）。 */
function topSegment(path: string): string {
  return path.split('.')[0]!.replace(/\[\]$/, '');
}

/** 城市字段路径（`cities[].population` → 'population'），非城市路径返回 null。 */
function cityFieldOf(path: string): string | null {
  const match = /^cities\[\]\.([^.[\]]+)$/.exec(path);
  return match ? match[1]! : null;
}

describe('v1.7 存档：默认模块注册表与归属覆盖', () => {
  it('默认注册表包含全部内置模块，ID/顺序稳定，全部为必需模块且版本 1', () => {
    const registry = createDefaultSaveRegistry();
    const modules = registry.list();
    expect(modules.map((module) => module.id)).toEqual([...DEFAULT_SAVE_MODULE_IDS]);
    expect(new Set(modules.map((module) => module.id)).size).toBe(DEFAULT_SAVE_MODULE_IDS.length);
    for (const module of modules) {
      expect(module.required).toBe(true);
      expect(module.version).toBe(1);
      expect(module.ownedPaths.length).toBeGreaterThan(0);
    }
    // world 必须最先恢复（依赖图的根）。
    expect(modules[0]!.id).toBe('world');
    expect(modules[0]!.dependsOn ?? []).toEqual([]);
  });

  it('格式版本单一来源：SAVE_FORMAT_VERSION = MODULE_SAVE_FORMAT_VERSION = 10，kind 标识稳定', () => {
    expect(SAVE_FORMAT_VERSION).toBe(10);
    expect(MODULE_SAVE_FORMAT_VERSION).toBe(SAVE_FORMAT_VERSION);
    expect(MODULE_SAVE_KIND).toBe('lanwan-modules');
  });

  it('模块之间没有任何重复/祖先重叠的归属路径', () => {
    const modules = createDefaultSaveRegistry().list();
    const all: { id: string; path: string }[] = [];
    for (const module of modules) {
      for (const path of module.ownedPaths) all.push({ id: module.id, path });
    }
    for (let left = 0; left < all.length; left += 1) {
      for (let right = left + 1; right < all.length; right += 1) {
        const a = all[left]!;
        const b = all[right]!;
        expect(
          savePathsOverlap(a.path, b.path),
          `归属重叠：${a.id} 的 ${a.path} 与 ${b.id} 的 ${b.path}`,
        ).toBe(false);
      }
    }
  });

  it('真实世界的每个顶层字段与 City 字段都恰好被一个模块拥有', () => {
    const world = Simulation.create().state;
    const modules = createDefaultSaveRegistry().list();
    const owners = (pathPredicate: (path: string) => boolean): string[] =>
      modules.filter((module) => module.ownedPaths.some(pathPredicate)).map((module) => module.id);

    // 顶层字段：cities 是复合载体单独检查；其余顶层字段必须恰好一个 owner。
    for (const field of Object.keys(world)) {
      if (field === 'cities') continue;
      const ownersOfField = owners((path) => topSegment(path) === field);
      expect(ownersOfField, `顶层字段 ${field} 的存档归属数量`).toHaveLength(1);
    }
    // City 字段：每个字段恰好一个 owner（world/population/marketTrade/government/politics 等共同覆盖）。
    const city = world.cities[0]!;
    for (const field of Object.keys(city)) {
      const ownersOfField = owners((path) => cityFieldOf(path) === field);
      expect(ownersOfField, `City 字段 ${field} 的存档归属数量`).toHaveLength(1);
    }
    // 反向：每个 ownedPaths 必须指向真实存在的顶层字段或 City 字段（防止拼写错误/漏恢复）。
    // 旧档可选字段在全新世界可能尚未写入（例如首月结算后才出现的基线/快速破产镜像），
    // 这些“可选但已登记”的路径允许运行时暂缺；新增可选字段时在此登记并同步 DESIGN 文档。
    const OPTIONAL_ABSENT_PATHS = new Set<string>([
      'cities[].fiscalExpenseBaseline',
      'cities[].bankruptcy',
      'equipmentMarket.maintenanceMonth',
      'equipmentMarket.maintenanceHistory',
      'policies.checkups',
      'policies.fundingMonths',
      'policies.publicJobsMonths',
      'households.investorFundingHistory',
      'households.investorUsageHistory',
    ]);
    for (const module of modules) {
      for (const path of module.ownedPaths) {
        const cityField = cityFieldOf(path);
        if (cityField !== null) {
          if (!Object.keys(city).includes(cityField)) {
            expect(
              OPTIONAL_ABSENT_PATHS.has(path),
              `${module.id} 声明了不存在的 City 字段 ${path}（若为旧档/首月可选字段请登记）`,
            ).toBe(true);
          }
          continue;
        }
        const top = topSegment(path);
        if (!Object.keys(world).includes(top)) {
          expect(
            OPTIONAL_ABSENT_PATHS.has(path),
            `${module.id} 声明了不存在的世界字段 ${path}（若为旧档/首月可选字段请登记）`,
          ).toBe(true);
        }
      }
    }
  });
});
