// v1.7 存档系统：模块注册表与协调器行为测试。
//
// 用最小假模块验证“架构契约”本身（不依赖真实世界数据）：
// - 注册表：重复 ID / 非法 ID / 归属路径重叠 / 依赖缺失或循环 / world 必须最先注册；
// - 协调器：为每个模块组装 data 与版本、minified JSON、旧模块缺失初始化、未知可选模块保留、
//   未知必需模块/高版本拒绝、恢复失败不污染当前世界、候选世界在全部校验前不可见。
//
// 真实世界模块的往返与兼容测试见 tests/persistence/roundtrip.test.ts 等文件。

import { describe, expect, it } from 'vitest';
import type { WorldState } from '../../src/simulation/contracts/types';
import { SaveModuleRegistry, savePathsOverlap } from '../../src/simulation/persistence/registry';
import { SaveCoordinator } from '../../src/simulation/persistence/saveCoordinator';
import { classifySaveDocument, validateWorldMeta } from '../../src/simulation/persistence/migrations';
import type {
  SaveExportContext,
  SaveModule,
  SaveModuleMigrationContext,
  SaveRestoreContext,
  SaveModuleValidation,
} from '../../src/simulation/persistence/types';
import { MODULE_SAVE_FORMAT_VERSION, MODULE_SAVE_KIND } from '../../src/simulation/persistence/types';

/** 一个最小的世界替身：假模块只读写这里的字段，避免依赖完整 WorldState 结构。 */
interface FakeWorld {
  seed: number;
  rngState: number;
  time: { year: number; month: number; tick: number };
  note: string;
}

function fakeModule(options: {
  id: SaveModule['id'];
  required?: boolean;
  version?: number;
  dependsOn?: string[];
  ownedPaths: string[];
  initMissing?: boolean;
}): SaveModule<Record<string, unknown>> & { calls: string[] } {
  const id = options.id;
  const required = options.required ?? true;
  const version = options.version ?? 1;
  const calls: string[] = [];
  const module: SaveModule<Record<string, unknown>> & { calls: string[] } = {
    id,
    version,
    required,
    ownedPaths: options.ownedPaths,
    ...(options.dependsOn ? { dependsOn: options.dependsOn } : {}),
    calls,
    export(context: SaveExportContext): Record<string, unknown> {
      calls.push('export');
      const world = context.world as unknown as FakeWorld;
      return { id, note: world.note };
    },
    validate(data: unknown, _version: number): SaveModuleValidation {
      calls.push('validate');
      const record = data as Record<string, unknown>;
      if (record.id !== id) return { ok: false, errors: [`expected module id ${id}`] };
      return { ok: true, errors: [] };
    },
    migrate(data: unknown, context: SaveModuleMigrationContext): Record<string, unknown> {
      calls.push(`migrate:${context.fromVersion}`);
      if (context.fromVersion === 0) {
        if (!options.initMissing) throw new Error('无法安全初始化');
        return { id, note: 'initialized' };
      }
      return { id, note: `migrated-from-${context.fromVersion}` };
    },
    restore(data: Record<string, unknown>, context: SaveRestoreContext): void {
      calls.push('restore');
      const world = context.world as unknown as FakeWorld;
      world.note = `${data.note}`;
    },
  };
  return module;
}

function makeCoordinator(registry: SaveModuleRegistry): SaveCoordinator {
  return new SaveCoordinator({
    registry,
    hooks: {
      // 测试替身不做完整校验（真实世界测试复用 core/save.ts 的校验器）。
      validateWorldStructure: () => null,
      checkInvariants: () => [],
    },
  });
}

function fakeWorld(): WorldState {
  return {
    seed: 123,
    rngState: 456,
    time: { year: 2027, month: 3, tick: 14 },
    note: 'hello',
  } as unknown as WorldState;
}

describe('v1.7 存档：模块注册表', () => {
  it('注册重复 ID 被拒绝', () => {
    const registry = new SaveModuleRegistry();
    registry.register(fakeModule({ id: 'world', ownedPaths: ['seed'] }));
    expect(() => registry.register(fakeModule({ id: 'world', ownedPaths: ['other'] }))).toThrow(
      /重复注册/,
    );
  });

  it('非法/空 ID 被拒绝', () => {
    const registry = new SaveModuleRegistry();
    expect(() =>
      registry.register(fakeModule({ id: 'Bad-Id' as SaveModule['id'], ownedPaths: ['seed'] })),
    ).toThrow(/ID 非法/);
  });

  it('归属路径重叠被拒绝（含祖先路径）', () => {
    expect(savePathsOverlap('cities[].population', 'cities[].population[]')).toBe(true);
    expect(savePathsOverlap('cities', 'cities[].population')).toBe(true);
    expect(savePathsOverlap('cities[].market', 'cities[].population')).toBe(false);
    const registry = new SaveModuleRegistry();
    registry.register(fakeModule({ id: 'world', ownedPaths: ['seed', 'cities'] }));
    expect(() =>
      registry.register(fakeModule({ id: 'population', ownedPaths: ['cities[].population'] })),
    ).toThrow(/归属重复/);
  });

  it("'world' 必须最先注册；依赖缺失/循环在注册表排序时暴露", () => {
    const registry = new SaveModuleRegistry();
    expect(() => registry.register(fakeModule({ id: 'population', ownedPaths: ['p'] }))).toThrow(
      /world/,
    );
    const ok = new SaveModuleRegistry();
    ok.register(fakeModule({ id: 'world', ownedPaths: ['seed'] }));
    ok.register(fakeModule({ id: 'population', ownedPaths: ['population'], dependsOn: ['company'] }));
    expect(() => new SaveCoordinator({ registry: ok, hooks: {
      validateWorldStructure: () => null,
      checkInvariants: () => [],
    } })).toThrow(/依赖未注册模块/);

    const cyclic = new SaveModuleRegistry();
    cyclic.register(fakeModule({ id: 'world', ownedPaths: ['seed'], dependsOn: ['population'] }));
    cyclic.register(fakeModule({ id: 'population', ownedPaths: ['population'], dependsOn: ['world'] }));
    expect(() => new SaveCoordinator({ registry: cyclic, hooks: {
      validateWorldStructure: () => null,
      checkInvariants: () => [],
    } })).toThrow(/循环/);
  });

  it('模块接口缺少必需方法时注册失败', () => {
    const registry = new SaveModuleRegistry();
    const broken = fakeModule({ id: 'world', ownedPaths: ['seed'] }) as unknown as Record<string, unknown>;
    delete broken['restore'];
    expect(() => registry.register(broken as unknown as SaveModule)).toThrow(/restore/);
  });
});

describe('v1.7 存档：顶层格式识别', () => {
  const meta = {
    tick: 14,
    year: 2027,
    month: 3,
    randomState: 456,
    seed: 123,
    gameVersion: '1.7.0',
  };

  it('模块化格式 / 旧单体格式 / 高版本 / 混合损坏分别识别', () => {
    expect(
      classifySaveDocument({ formatVersion: MODULE_SAVE_FORMAT_VERSION, kind: MODULE_SAVE_KIND, modules: {}, worldMeta: meta }),
    ).toMatchObject({ kind: 'module' });
    expect(classifySaveDocument({ formatVersion: 9, world: {} })).toMatchObject({ kind: 'legacy' });
    expect(classifySaveDocument({ formatVersion: MODULE_SAVE_FORMAT_VERSION + 5 })).toMatchObject({
      kind: 'unsupported',
    });
    expect(
      classifySaveDocument({ formatVersion: MODULE_SAVE_FORMAT_VERSION, kind: MODULE_SAVE_KIND, world: {} }),
    ).toMatchObject({ kind: 'unknown' });
    expect(classifySaveDocument({ formatVersion: 9 })).toMatchObject({ kind: 'unknown' });
    expect(classifySaveDocument({ formatVersion: 9, kind: MODULE_SAVE_KIND, world: {} })).toMatchObject({
      kind: 'unknown',
    });
    expect(validateWorldMeta(meta)).toMatchObject({ ok: true });
    expect(validateWorldMeta({ tick: 1 })).toMatchObject({ ok: false });
  });
});

describe('v1.7 存档：协调器导出/恢复', () => {
  it('导出为 minified JSON 且可完整恢复（世界由调用方替换，候选世界独立构造）', () => {
    const registry = new SaveModuleRegistry();
    const worldModule = fakeModule({ id: 'world', ownedPaths: ['seed', 'rngState', 'time', 'note'] });
    registry.register(worldModule);
    const population = fakeModule({ id: 'population', ownedPaths: ['population'], dependsOn: ['world'] });
    registry.register(population);
    const coordinator = makeCoordinator(registry);

    const source = fakeWorld();
    const exported = coordinator.exportSave(source, { savedAt: '2026-11-07T00:00:00.000Z', gameVersion: '1.7.0' });
    expect(exported.ok).toBe(true);
    if (!exported.ok || !exported.text) return;
    expect(exported.text).not.toContain('\n  '); // 不写美化缩进
    const document = JSON.parse(exported.text) as Record<string, unknown>;
    expect(document.formatVersion).toBe(MODULE_SAVE_FORMAT_VERSION);
    expect(document.kind).toBe(MODULE_SAVE_KIND);
    const modules = document.modules as Record<string, { version: number; required: boolean; data: unknown }>;
    expect(Object.keys(modules)).toEqual(['world', 'population']);
    expect(modules['world']!.required).toBe(true);
    expect(modules['world']!.version).toBe(1);

    const restored = coordinator.restoreSaveDocument(document);
    expect(restored.ok).toBe(true);
    if (!restored.ok || !restored.world) return;
    expect(restored.world).not.toBe(source); // 候选世界是独立对象
    expect((restored.world as unknown as FakeWorld).note).toBe('hello');
    expect(restored.warnings).toEqual([]);
  });

  it('必需模块缺失/未知必需模块/模块版本过高/数据校验失败都拒绝并给出错误码', () => {
    const registry = new SaveModuleRegistry();
    registry.register(fakeModule({ id: 'world', ownedPaths: ['seed', 'rngState', 'time', 'note'] }));
    const coordinator = makeCoordinator(registry);
    const base = JSON.parse(
      coordinator.exportSave(fakeWorld(), { gameVersion: '1.7.0' }).text ?? '{}',
    ) as { modules: Record<string, unknown> };

    const missing = structuredClone(base);
    delete missing.modules['world'];
    expect(coordinator.restoreSaveDocument(missing)).toMatchObject({
      ok: false,
      code: 'missing-required-module',
    });

    const unknownRequired = structuredClone(base);
    unknownRequired.modules['futureSystem'] = { version: 1, required: true, data: {} };
    expect(coordinator.restoreSaveDocument(unknownRequired as never)).toMatchObject({
      ok: false,
      code: 'unknown-required-module',
    });

    const tooHigh = structuredClone(base);
    tooHigh.modules['world'] = { version: 99, required: true, data: {} };
    expect(coordinator.restoreSaveDocument(tooHigh as never)).toMatchObject({
      ok: false,
      code: 'module-version-too-high',
    });

    const invalid = structuredClone(base);
    invalid.modules['world'] = { version: 1, required: true, data: { id: 'wrong' } };
    expect(coordinator.restoreSaveDocument(invalid as never)).toMatchObject({
      ok: false,
      code: 'invalid-module-data',
    });
  });

  it('未知可选模块原样保留，重新保存时写回（不静默丢弃）', () => {
    const registry = new SaveModuleRegistry();
    registry.register(fakeModule({ id: 'world', ownedPaths: ['seed', 'rngState', 'time', 'note'] }));
    const coordinator = makeCoordinator(registry);
    const document = JSON.parse(
      coordinator.exportSave(fakeWorld(), { gameVersion: '1.7.0' }).text ?? '{}',
    ) as { modules: Record<string, unknown>; worldMeta: unknown; gameVersion: string; savedAt: string };
    document.modules['futureOptional'] = {
      version: 3,
      required: false,
      data: { hello: 'future', nested: [1, 2, 3] },
    };
    const restored = coordinator.restoreSaveDocument(document as never);
    expect(restored.ok).toBe(true);
    if (!restored.ok || !restored.world) return;
    expect(restored.preservedModules?.['futureOptional']).toMatchObject({
      version: 3,
      required: false,
      data: { hello: 'future', nested: [1, 2, 3] },
    });
    const reExported = coordinator.exportSave(restored.world, {
      gameVersion: '1.7.0',
      preservedModules: restored.preservedModules,
    });
    expect(reExported.ok).toBe(true);
    const reDocument = JSON.parse(reExported.text ?? '{}') as { modules: Record<string, unknown> };
    expect(reDocument.modules['futureOptional']).toEqual({
      version: 3,
      required: false,
      data: { hello: 'future', nested: [1, 2, 3] },
    });
  });

  it('可选模块缺失时按旧档初始化规则恢复；初始化失败则拒绝读取', () => {
    const registry = new SaveModuleRegistry();
    registry.register(fakeModule({ id: 'world', ownedPaths: ['seed', 'rngState', 'time', 'note'] }));
    const optional = fakeModule({
      id: 'population',
      required: false,
      ownedPaths: ['population'],
      initMissing: true,
    });
    registry.register(optional);
    const coordinator = makeCoordinator(registry);
    const document = JSON.parse(
      coordinator.exportSave(fakeWorld(), { gameVersion: '1.7.0' }).text ?? '{}',
    ) as { modules: Record<string, unknown> };
    delete document.modules['population'];
    const restored = coordinator.restoreSaveDocument(document as never);
    expect(restored.ok).toBe(true);
    expect(restored.warnings.join('；')).toMatch(/旧档初始化/);

    const failingRegistry = new SaveModuleRegistry();
    failingRegistry.register(fakeModule({ id: 'world', ownedPaths: ['seed', 'rngState', 'time', 'note'] }));
    failingRegistry.register(
      fakeModule({ id: 'population', required: false, ownedPaths: ['population'], initMissing: false }),
    );
    const failing = makeCoordinator(failingRegistry);
    const failingDocument = JSON.parse(
      failing.exportSave(fakeWorld(), { gameVersion: '1.7.0' }).text ?? '{}',
    ) as { modules: Record<string, unknown> };
    delete failingDocument.modules['population'];
    expect(failing.restoreSaveDocument(failingDocument as never)).toMatchObject({
      ok: false,
      code: 'module-migration-failed',
    });
  });

  it('恢复阶段抛错时不返回世界（当前运行世界由调用方保持不变）', () => {
    const registry = new SaveModuleRegistry();
    registry.register(fakeModule({ id: 'world', ownedPaths: ['seed', 'rngState', 'time', 'note'] }));
    const failing = fakeModule({ id: 'company', ownedPaths: ['companies'], dependsOn: ['world'] });
    failing.restore = () => {
      throw new Error('boom');
    };
    registry.register(failing);
    const coordinator = makeCoordinator(registry);
    const document = JSON.parse(
      coordinator.exportSave(fakeWorld(), { gameVersion: '1.7.0' }).text ?? '{}',
    ) as Record<string, unknown>;
    const result = coordinator.restoreSaveDocument(document);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('invalid-module-data');
    expect(result.world).toBeUndefined();
  });
});
