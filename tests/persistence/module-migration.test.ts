// v1.7 存档系统：模块版本迁移与格式拒绝测试（SAVE-T1）。
//
// 只验证“持久化契约”本身，不依赖真实世界模块与真实 modules/**（由其他 owner 并行实现）：
// 用测试内 fake 模块 + SaveModuleRegistry + SaveCoordinator 覆盖：
// - 模块版本迁移链：v1→v2（以及同一调用内 v1→v3 的链式升级），validate 使用“当前模块版本”，
//   restore 使用迁移后的数据；原文档不被改写。
// - fromVersion=0：可选模块在存档中缺失时执行旧档初始化；初始化必须是明确零值/空集合，
//   不得凭空造资金、人口或贷款；初始化抛错 → 'module-migration-failed'。
// - 版本/完整性错误码：模块版本过高不静默降级、未知必需模块、缺必需模块、数据校验失败。
// - 顶层格式：formatVersion > 10 → 'unsupported-version'；旧单体 1–9 + world → legacy（不进入
//   模块读取）；模块格式混入 world / 缺 kind / kind 不符 → 'unknown-format'。
// - 幂等：migrate 只在“存档模块版本落后”时调用；重新保存（版本追平）后再次读取不再迁移。
//
// 参考 tests/persistence/registry.test.ts 的构造方式；真实模块的往返测试在其它文件。

import { describe, expect, it } from 'vitest';
import type { WorldState } from '../../src/simulation/contracts/types';
import { SaveModuleRegistry } from '../../src/simulation/persistence/registry';
import {
  SaveCoordinator,
  type SaveCoordinatorHooks,
} from '../../src/simulation/persistence/saveCoordinator';
import { classifySaveDocument } from '../../src/simulation/persistence/migrations';
import type {
  ModuleParseResult,
  SaveExportContext,
  SaveModule,
  SaveModuleMigrationContext,
  SaveModuleValidation,
  SaveRestoreContext,
} from '../../src/simulation/persistence/types';
import {
  MODULE_SAVE_FORMAT_VERSION,
  MODULE_SAVE_KIND,
} from '../../src/simulation/persistence/types';

// ------------------------------------------------------------------ 测试替身

/** fake 模块的调用记录（断言“谁在什么时候被调用、参数是什么”）。 */
interface FakeCalls {
  migrate: { fromVersion: number; toVersion: number; data: unknown }[];
  validate: { version: number; data: unknown }[];
  restore: { data: unknown }[];
  export: number;
}

interface FakeModule extends SaveModule<Record<string, unknown>> {
  calls: FakeCalls;
}

interface FakeModuleOptions {
  id: SaveModule['id'];
  required?: boolean;
  version?: number;
  dependsOn?: string[];
  ownedPaths: string[];
  /** fromVersion=0 的处理：init=返回零值初始化；throw=无法安全初始化（应转成可读错误）。 */
  missingInit?: 'init' | 'throw';
  /** 指定旧版本迁移抛错（模拟无法安全升级的存档）。 */
  failMigrateFrom?: number;
  /** validate 始终失败（模拟数据损坏）。 */
  invalidData?: boolean;
  /** 非 world 模块 restore 写入候选世界的属性名（默认用模块 id）。 */
  field?: string;
  /** 跨模块调用时间线（断言恢复顺序）。 */
  timeline?: string[];
}

/**
 * 最小 fake 模块：
 * - export 只读世界、返回 {id, note}；
 * - migrate 记录 fromVersion/toVersion：0 → 零值初始化（或抛错），>0 → 保留旧数据并打上
 *   migrated-from-N 标记（模拟“字段升级”）；
 * - validate 校验 data.id 与模块 id 一致，可配置失败；
 * - restore 把（迁移后的）data 写进候选世界。
 *
 * 旧档初始化刻意只返回零值（people/cash/loanPrincipal = 0）：测试据此断言“不得凭空造资金/人口”。
 */
function fakeModule(options: FakeModuleOptions): FakeModule {
  const id = options.id;
  const required = options.required ?? true;
  const version = options.version ?? 1;
  const field = options.field ?? String(id);
  const timeline = options.timeline;
  const calls: FakeCalls = { migrate: [], validate: [], restore: [], export: 0 };
  const mark = (step: string): void => {
    timeline?.push(`${id}:${step}`);
  };

  return {
    id,
    version,
    required,
    ownedPaths: options.ownedPaths,
    ...(options.dependsOn ? { dependsOn: options.dependsOn } : {}),
    calls,
    export(context: SaveExportContext): Record<string, unknown> {
      calls.export += 1;
      mark('export');
      const world = context.world as unknown as Record<string, unknown>;
      return { id, note: typeof world.note === 'string' ? world.note : '' };
    },
    validate(data: unknown, validateVersion: number): SaveModuleValidation {
      calls.validate.push({ version: validateVersion, data });
      mark(`validate:${validateVersion}`);
      if (options.invalidData) {
        return { ok: false, errors: [`${id} 数据校验失败（测试构造）`] };
      }
      const record = data as Record<string, unknown> | null;
      if (!record || typeof record !== 'object' || Array.isArray(record)) {
        return { ok: false, errors: [`${id} 数据不是对象`] };
      }
      if (record.id !== id) {
        return { ok: false, errors: [`${id} 数据 id 不匹配`] };
      }
      return { ok: true, errors: [] };
    },
    migrate(data: unknown, context: SaveModuleMigrationContext): Record<string, unknown> {
      calls.migrate.push({
        fromVersion: context.fromVersion,
        toVersion: context.toVersion,
        data,
      });
      mark(`migrate:${context.fromVersion}->${context.toVersion}`);
      if (context.fromVersion === 0) {
        if (options.missingInit === 'throw') {
          throw new Error(`${id} 无法安全初始化（测试构造）`);
        }
        // 旧档初始化只允许“明确的空/零值”，不得凭空编造资金、人口、贷款。
        return { id, people: 0, cash: 0, loanPrincipal: 0, initializedFromMissing: true };
      }
      if (options.failMigrateFrom === context.fromVersion) {
        throw new Error(`${id} 从 v${context.fromVersion} 迁移失败（测试构造）`);
      }
      const record = (data as Record<string, unknown> | undefined) ?? {};
      return {
        ...record,
        id,
        note: `migrated-from-${context.fromVersion}`,
        upgradedTo: context.toVersion,
      };
    },
    restore(data: Record<string, unknown>, context: SaveRestoreContext): void {
      calls.restore.push({ data });
      mark('restore');
      const world = context.world as unknown as Record<string, unknown>;
      if (id === 'world') world.note = data.note;
      else world[field] = data;
    },
  };
}

function makeCoordinator(
  modules: FakeModule[],
): { registry: SaveModuleRegistry; coordinator: SaveCoordinator } {
  const registry = new SaveModuleRegistry();
  for (const module of modules) registry.register(module);
  const hooks: SaveCoordinatorHooks = {
    // 本文件只测持久化契约；真实世界结构/不变量校验由 core/save.ts 的测试覆盖。
    validateWorldStructure: () => null,
    checkInvariants: () => [],
  };
  return { registry, coordinator: new SaveCoordinator({ registry, hooks }) };
}

// ------------------------------------------------------------------ 文档构造

const META = {
  tick: 14,
  year: 2027,
  month: 3,
  randomState: 456,
  seed: 123,
  gameVersion: '1.7.0',
};

type ModuleHeader = { version: number; required: boolean; data: unknown };

function moduleHeader(version: number, required: boolean, data: unknown): ModuleHeader {
  return { version, required, data };
}

interface DocumentOptions {
  formatVersion?: number;
  kind?: string;
  omitKind?: boolean;
  worldMeta?: unknown;
  modules: Record<string, unknown>;
  world?: unknown;
}

function makeDocument(options: DocumentOptions): Record<string, unknown> {
  const document: Record<string, unknown> = {
    formatVersion: options.formatVersion ?? MODULE_SAVE_FORMAT_VERSION,
    gameVersion: '1.7.0',
    savedAt: '2026-11-07T00:00:00.000Z',
    worldMeta: options.worldMeta ?? META,
    modules: options.modules,
  };
  if (!options.omitKind) document.kind = options.kind ?? MODULE_SAVE_KIND;
  if (options.world !== undefined) document.world = options.world;
  return document;
}

function exportedDocument(coordinator: SaveCoordinator, world: WorldState): Record<string, unknown> {
  const exported = coordinator.exportSave(world, {
    savedAt: '2026-11-07T00:00:00.000Z',
    gameVersion: '1.7.0',
  });
  expect(exported.ok, exported.error).toBe(true);
  return JSON.parse(exported.text ?? '{}') as Record<string, unknown>;
}

function requireRestored(result: ModuleParseResult): WorldState {
  expect(result.ok, result.error).toBe(true);
  if (!result.ok || !result.world) throw new Error(`读取应成功：${result.error ?? '无世界'}`);
  return result.world;
}

function asRecord(world: WorldState): Record<string, unknown> {
  return world as unknown as Record<string, unknown>;
}

// ------------------------------------------------------------------ 迁移链

describe('v1.7 存档：模块版本迁移链', () => {
  it('模块 v1→v2：migrate 收到 fromVersion/toVersion，validate 用当前版本，restore 用升级后数据', () => {
    const timeline: string[] = [];
    const worldModule = fakeModule({
      id: 'world',
      version: 2,
      ownedPaths: ['seed', 'rngState', 'time', 'note'],
      timeline,
    });
    const population = fakeModule({
      id: 'population',
      version: 2,
      dependsOn: ['world'],
      ownedPaths: ['population'],
      field: 'population',
      timeline,
    });
    const { coordinator } = makeCoordinator([worldModule, population]);

    const document = makeDocument({
      modules: {
        world: moduleHeader(1, true, { id: 'world', note: 'legacy-v1' }),
        population: moduleHeader(1, true, { id: 'population', people: 500, cash: 250 }),
      },
    });

    const restored = coordinator.restoreSaveDocument(document);
    const world = requireRestored(restored);

    // 每个模块只迁移一次，且拿到完整的 from→to 版本号。
    expect(worldModule.calls.migrate).toHaveLength(1);
    expect(worldModule.calls.migrate[0]).toMatchObject({ fromVersion: 1, toVersion: 2 });
    expect(population.calls.migrate).toHaveLength(1);
    expect(population.calls.migrate[0]).toMatchObject({ fromVersion: 1, toVersion: 2 });
    // 迁移不能丢旧数据：模块收到的是存档里的 v1 数据。
    expect((population.calls.migrate[0]!.data as Record<string, unknown>).people).toBe(500);
    expect((population.calls.migrate[0]!.data as Record<string, unknown>).cash).toBe(250);

    // validate 使用“当前模块版本”，不是存档头版本。
    expect(worldModule.calls.validate).toHaveLength(1);
    expect(worldModule.calls.validate[0]!.version).toBe(2);
    expect(population.calls.validate[0]!.version).toBe(2);

    // restore 使用迁移后的数据（世界字段正确）。
    expect(asRecord(world).note).toBe('migrated-from-1');
    const populationData = asRecord(world).population as Record<string, unknown>;
    expect(populationData.people).toBe(500);
    expect(populationData.cash).toBe(250);
    expect(populationData.note).toBe('migrated-from-1');
    expect(populationData.upgradedTo).toBe(2);

    // 恢复顺序：world 先于依赖它的 population。
    expect(timeline.indexOf('world:migrate:1->2')).toBeGreaterThanOrEqual(0);
    expect(timeline.indexOf('world:migrate:1->2')).toBeLessThan(
      timeline.indexOf('population:migrate:1->2'),
    );
    expect(timeline.indexOf('world:restore')).toBeGreaterThanOrEqual(0);
    expect(timeline.indexOf('world:restore')).toBeLessThan(timeline.indexOf('population:restore'));

    // 读取不改写输入文档（模块头仍保持存档原版本）。
    const documentModules = document.modules as Record<string, ModuleHeader>;
    expect(documentModules['world']!.version).toBe(1);
    expect(documentModules['population']!.version).toBe(1);
  });

  it('模块 v1→v3：由模块内部链式升级，协调器只调用一次 migrate（fromVersion=1,toVersion=3）', () => {
    const worldModule = fakeModule({
      id: 'world',
      version: 3,
      ownedPaths: ['seed', 'rngState', 'time', 'note'],
    });
    const { coordinator } = makeCoordinator([worldModule]);
    const document = makeDocument({
      modules: { world: moduleHeader(1, true, { id: 'world', note: 'v1' }) },
    });

    const world = requireRestored(coordinator.restoreSaveDocument(document));
    expect(worldModule.calls.migrate).toHaveLength(1);
    expect(worldModule.calls.migrate[0]).toMatchObject({ fromVersion: 1, toVersion: 3 });
    expect(worldModule.calls.validate[0]!.version).toBe(3);
    expect(asRecord(world).note).toBe('migrated-from-1');
    expect((asRecord(world) as Record<string, unknown>).note).toBe('migrated-from-1');
  });

  it('同版本不重复迁移：重复读取旧档结果一致；重新保存版本追平后读取不再调用 migrate', () => {
    const worldModule = fakeModule({
      id: 'world',
      version: 2,
      ownedPaths: ['seed', 'rngState', 'time', 'note'],
    });
    const { coordinator } = makeCoordinator([worldModule]);
    const oldDocument = makeDocument({
      modules: { world: moduleHeader(1, true, { id: 'world', note: 'old' }) },
    });

    const first = requireRestored(coordinator.restoreSaveDocument(oldDocument));
    expect(worldModule.calls.migrate).toHaveLength(1);

    // 同一份 v1 存档再读一次：文件仍是 v1，因此会再次按 v1→v2 迁移；结果必须一致且世界独立。
    const second = requireRestored(coordinator.restoreSaveDocument(oldDocument));
    expect(worldModule.calls.migrate).toHaveLength(2);
    expect(second).not.toBe(first);
    expect(asRecord(second).note).toBe(asRecord(first).note);
    expect(second).toEqual(first);

    // 读取成功后重新保存：模块头写当前版本（2），而不是沿用存档里的旧版本。
    const reDocument = exportedDocument(coordinator, first);
    const reModules = reDocument.modules as Record<string, ModuleHeader>;
    expect(reModules['world']!.version).toBe(2);

    // 同版本存档再读取：不再迁移（migrate 调用数不变）。
    const before = worldModule.calls.migrate.length;
    const third = requireRestored(coordinator.restoreSaveDocument(reDocument));
    expect(worldModule.calls.migrate).toHaveLength(before);
    expect(asRecord(third).note).toBe(asRecord(first).note);
  });
});

// ------------------------------------------------------------------ fromVersion=0

describe('v1.7 存档：可选模块缺失时的旧档初始化', () => {
  it('fromVersion=0：缺失可选模块按零值初始化，不得凭空造资金/人口/贷款', () => {
    const worldModule = fakeModule({
      id: 'world',
      version: 2,
      ownedPaths: ['seed', 'rngState', 'time', 'note'],
    });
    const population = fakeModule({
      id: 'population',
      version: 2,
      required: false,
      dependsOn: ['world'],
      ownedPaths: ['population'],
      field: 'population',
      missingInit: 'init',
    });
    const { coordinator } = makeCoordinator([worldModule, population]);

    // 存档里 world 是当前版本，但完全没有 population 模块（旧档根本没有该系统）。
    const document = makeDocument({
      modules: { world: moduleHeader(2, true, { id: 'world', note: 'v2' }) },
    });
    const restored = coordinator.restoreSaveDocument(document);
    const world = requireRestored(restored);

    // 协调器用 fromVersion=0 且 data=undefined 调用模块初始化；并给出可读警告。
    expect(population.calls.migrate).toHaveLength(1);
    expect(population.calls.migrate[0]).toMatchObject({ fromVersion: 0, toVersion: 2 });
    expect(population.calls.migrate[0]!.data).toBeUndefined();
    expect(restored.warnings.join('；')).toMatch(/population/);

    // 初始化结果必须是明确的零值：没有凭空造资金、人口、贷款。
    const populationData = asRecord(world).population as Record<string, unknown>;
    expect(populationData.people).toBe(0);
    expect(populationData.cash).toBe(0);
    expect(populationData.loanPrincipal).toBe(0);
    // 世界元信息不能被初始化规则改写。
    expect(asRecord(world).seed).toBe(META.seed);
    expect(asRecord(world).rngState).toBe(META.randomState);
    expect(asRecord(world).time).toEqual({ year: META.year, month: META.month, tick: META.tick });

    // 重新保存：可选模块以当前版本写回（v2），而不是 v0 或缺失。
    const reDocument = exportedDocument(coordinator, world);
    const reModules = reDocument.modules as Record<string, ModuleHeader>;
    expect(reModules['population']!.version).toBe(2);
    expect(reModules['population']!.required).toBe(false);
  });

  it('可选模块初始化抛错 → module-migration-failed，不返回世界也不恢复任何模块', () => {
    const worldModule = fakeModule({
      id: 'world',
      version: 2,
      ownedPaths: ['seed', 'rngState', 'time', 'note'],
    });
    const population = fakeModule({
      id: 'population',
      version: 2,
      required: false,
      dependsOn: ['world'],
      ownedPaths: ['population'],
      missingInit: 'throw',
    });
    const { coordinator } = makeCoordinator([worldModule, population]);
    const document = makeDocument({
      modules: { world: moduleHeader(2, true, { id: 'world', note: 'v2' }) },
    });

    const result = coordinator.restoreSaveDocument(document);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('module-migration-failed');
    expect(result.world).toBeUndefined();
    expect(result.error ?? '').toMatch(/population/);
    // 失败发生在“准备模块”阶段：任何模块都没有被恢复。
    expect(worldModule.calls.restore).toHaveLength(0);
    expect(population.calls.restore).toHaveLength(0);
  });

  it('已存在模块的旧版本迁移抛错 → module-migration-failed（不静默接受旧数据）', () => {
    const worldModule = fakeModule({
      id: 'world',
      version: 2,
      ownedPaths: ['seed', 'rngState', 'time', 'note'],
      failMigrateFrom: 1,
    });
    const { coordinator } = makeCoordinator([worldModule]);
    const document = makeDocument({
      modules: { world: moduleHeader(1, true, { id: 'world', note: 'v1' }) },
    });

    const result = coordinator.restoreSaveDocument(document);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('module-migration-failed');
    expect(result.world).toBeUndefined();
    expect(worldModule.calls.migrate).toHaveLength(1);
    expect(worldModule.calls.validate).toHaveLength(0);
    expect(worldModule.calls.restore).toHaveLength(0);
  });
});

// ------------------------------------------------------------------ 版本与完整性

describe('v1.7 存档：版本与模块完整性错误码', () => {
  it('模块版本高于当前支持 → module-version-too-high，不静默降级', () => {
    const worldModule = fakeModule({
      id: 'world',
      version: 2,
      ownedPaths: ['seed', 'rngState', 'time', 'note'],
    });
    const { coordinator } = makeCoordinator([worldModule]);
    const document = makeDocument({
      modules: { world: moduleHeader(3, true, { id: 'world', note: 'from-future' }) },
    });

    const result = coordinator.restoreSaveDocument(document);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('module-version-too-high');
    expect(result.world).toBeUndefined();
    expect(result.error ?? '').toMatch(/world/);
    // 不降级：既不迁移、也不校验、更不恢复未来版本数据。
    expect(worldModule.calls.migrate).toHaveLength(0);
    expect(worldModule.calls.validate).toHaveLength(0);
    expect(worldModule.calls.restore).toHaveLength(0);
  });

  it('未知必需模块 → unknown-required-module（提示需要更新版本的游戏）', () => {
    const worldModule = fakeModule({
      id: 'world',
      version: 1,
      ownedPaths: ['seed', 'rngState', 'time', 'note'],
    });
    const { coordinator } = makeCoordinator([worldModule]);
    const document = makeDocument({
      modules: {
        world: moduleHeader(1, true, { id: 'world', note: 'ok' }),
        futureSystem: moduleHeader(1, true, { id: 'futureSystem', payload: 1 }),
      },
    });

    const result = coordinator.restoreSaveDocument(document);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('unknown-required-module');
    expect(result.world).toBeUndefined();
    expect(result.error ?? '').toMatch(/futureSystem/);
    expect(worldModule.calls.restore).toHaveLength(0);
  });

  it('缺少必需模块 → missing-required-module（v10 存档视为损坏）', () => {
    const worldModule = fakeModule({
      id: 'world',
      version: 1,
      ownedPaths: ['seed', 'rngState', 'time', 'note'],
    });
    const companyModule = fakeModule({
      id: 'company',
      version: 1,
      dependsOn: ['world'],
      ownedPaths: ['company'],
      field: 'company',
    });
    const { coordinator } = makeCoordinator([worldModule, companyModule]);
    const document = makeDocument({
      modules: { world: moduleHeader(1, true, { id: 'world', note: 'ok' }) },
    });

    const result = coordinator.restoreSaveDocument(document);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('missing-required-module');
    expect(result.world).toBeUndefined();
    expect(result.error ?? '').toMatch(/company/);
    expect(worldModule.calls.restore).toHaveLength(0);
    expect(companyModule.calls.restore).toHaveLength(0);
  });

  it('模块数据校验失败 → invalid-module-data（用迁移后的数据与当前版本校验）', () => {
    const worldModule = fakeModule({
      id: 'world',
      version: 2,
      ownedPaths: ['seed', 'rngState', 'time', 'note'],
      invalidData: true,
    });
    const { coordinator } = makeCoordinator([worldModule]);
    const document = makeDocument({
      modules: { world: moduleHeader(1, true, { id: 'world', note: 'v1' }) },
    });

    const result = coordinator.restoreSaveDocument(document);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('invalid-module-data');
    expect(result.world).toBeUndefined();
    // 先迁移再校验：validate 收到的是迁移后的数据、当前模块版本。
    expect(worldModule.calls.migrate).toHaveLength(1);
    expect(worldModule.calls.validate).toHaveLength(1);
    expect(worldModule.calls.validate[0]!.version).toBe(2);
    const validated = worldModule.calls.validate[0]!.data as Record<string, unknown>;
    expect(validated.note).toBe('migrated-from-1');
    expect(worldModule.calls.restore).toHaveLength(0);
  });
});

// ------------------------------------------------------------------ 顶层格式

describe('v1.7 存档：顶层格式识别与拒绝', () => {
  it('顶层 formatVersion 高于 10 → unsupported-version，且不进入模块读取', () => {
    const worldModule = fakeModule({
      id: 'world',
      version: 1,
      ownedPaths: ['seed', 'rngState', 'time', 'note'],
    });
    const { coordinator } = makeCoordinator([worldModule]);
    const futureVersion = MODULE_SAVE_FORMAT_VERSION + 1;

    const document = makeDocument({
      formatVersion: futureVersion,
      modules: { world: moduleHeader(1, true, { id: 'world', note: 'ok' }) },
    });
    expect(classifySaveDocument(document)).toMatchObject({
      kind: 'unsupported',
      formatVersion: futureVersion,
      code: 'unsupported-version',
    });

    const result = coordinator.restoreSaveDocument(document);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('unsupported-version');
    expect(result.world).toBeUndefined();
    // 完全不读取模块：没有迁移/校验/恢复。
    expect(worldModule.calls.migrate).toHaveLength(0);
    expect(worldModule.calls.validate).toHaveLength(0);
    expect(worldModule.calls.restore).toHaveLength(0);

    // 即使没有 kind/worldMeta，版本过高也必须先被拒绝（不能误判成 unknown-format 或 legacy）。
    const bare = { formatVersion: 99, modules: {} };
    expect(classifySaveDocument(bare)).toMatchObject({
      kind: 'unsupported',
      code: 'unsupported-version',
    });
    expect(coordinator.restoreSaveDocument(bare)).toMatchObject({
      ok: false,
      code: 'unsupported-version',
    });
  });

  it('旧单体 1–9 + world → legacy：识别为旧格式，不进入模块读取', () => {
    const worldModule = fakeModule({
      id: 'world',
      version: 1,
      ownedPaths: ['seed', 'rngState', 'time', 'note'],
    });
    const { coordinator } = makeCoordinator([worldModule]);

    for (let formatVersion = 1; formatVersion <= 9; formatVersion += 1) {
      const legacyWorld = { seed: 999, time: { tick: formatVersion } };
      const legacy = { formatVersion, world: legacyWorld, gameVersion: '1.6.1', savedAt: '2026-01-01T00:00:00.000Z' };
      expect(classifySaveDocument(legacy)).toMatchObject({
        kind: 'legacy',
        formatVersion,
        legacyWorld,
      });
      const result = coordinator.restoreSaveDocument(legacy);
      // 旧单体由 core/save.ts 既有 v1→…→v9 迁移链处理；模块协调器不读它。
      expect(result.ok).toBe(false);
      expect(result.code).toBe('unknown-format');
      expect(result.world).toBeUndefined();
    }

    // 整个循环没有触碰任何模块。
    expect(worldModule.calls.export).toBe(0);
    expect(worldModule.calls.migrate).toHaveLength(0);
    expect(worldModule.calls.validate).toHaveLength(0);
    expect(worldModule.calls.restore).toHaveLength(0);
  });

  it('模块格式混入 world / 缺 kind / kind 不符 → unknown-format', () => {
    const worldModule = fakeModule({
      id: 'world',
      version: 1,
      ownedPaths: ['seed', 'rngState', 'time', 'note'],
    });
    const { coordinator } = makeCoordinator([worldModule]);
    const modules = { world: moduleHeader(1, true, { id: 'world', note: 'ok' }) };

    // (1) v10 模块格式里同时出现旧单体 world 字段。
    const mixed = makeDocument({ modules, world: { seed: 1 } });
    expect(classifySaveDocument(mixed)).toMatchObject({
      kind: 'unknown',
      code: 'unknown-format',
    });
    expect(coordinator.restoreSaveDocument(mixed)).toMatchObject({
      ok: false,
      code: 'unknown-format',
    });

    // (2) v10 但缺少 kind 标识。
    const missingKind = makeDocument({ modules, omitKind: true });
    expect(classifySaveDocument(missingKind)).toMatchObject({
      kind: 'unknown',
      code: 'unknown-format',
    });
    expect(coordinator.restoreSaveDocument(missingKind)).toMatchObject({
      ok: false,
      code: 'unknown-format',
    });

    // (3) kind 标识不符（例如别的新格式）。
    const wrongKind = makeDocument({ modules, kind: 'lanwan-other' });
    expect(classifySaveDocument(wrongKind)).toMatchObject({
      kind: 'unknown',
      code: 'unknown-format',
    });
    expect(coordinator.restoreSaveDocument(wrongKind)).toMatchObject({
      ok: false,
      code: 'unknown-format',
    });

    // (4) 缺少 modules 对象（声称模块格式但结构不完整）。
    const noModules = makeDocument({ modules: {} });
    delete noModules.modules;
    expect(coordinator.restoreSaveDocument(noModules)).toMatchObject({
      ok: false,
      code: 'unknown-format',
    });

    // 以上损坏输入都不应触发任何模块调用。
    expect(worldModule.calls.migrate).toHaveLength(0);
    expect(worldModule.calls.restore).toHaveLength(0);
  });
});
