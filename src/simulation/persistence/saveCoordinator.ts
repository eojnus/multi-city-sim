/**
 * v1.7 存档系统：统一协调器。
 *
 * 职责（不接触文件系统）：
 * - 导出：按注册顺序对每个模块调用 export，组装模块化快照，minified JSON 序列化（不含美化缩进）；
 * - 读取：识别模块化文档 → 顶层校验 → 逐模块版本校验/迁移 → 在候选世界中恢复全部模块 →
 *   跨模块引用校验 → 世界结构校验 → 不变量校验 → 一次性返回候选世界（由调用方整体替换运行时世界）；
 * - 未知模块：必需未知模块拒绝加载；未知可选模块原样保留，重新保存时写回（不静默丢弃）。
 *
 * 一致性：export/document 组装是同步单线程过程，不会与 tick 交错；调用方在调用前后不得推进世界。
 */

import type { WorldState } from '../contracts/types';
import type { SaveModuleRegistry } from './registry';
import type {
  ModuleExportResult,
  ModuleParseResult,
  ModuleSaveFile,
  SaveErrorCode,
  SaveExportContext,
  SaveModule,
  SaveModuleHeader,
  SaveModuleMigrationContext,
  SaveRestoreContext,
  SaveWorldMeta,
} from './types';
import {
  MODULE_SAVE_FORMAT_VERSION,
  MODULE_SAVE_KIND,
  MAX_SAVE_RAW_BYTES,
} from './types';
import { GAME_VERSION } from '../contracts/types';
import { classifySaveDocument, validateWorldMeta } from './migrations';
import { createCandidateWorld } from './scaffold';
import { validateCrossReferences } from './referenceValidation';

/** 协调器与现有模拟层（core/save.ts）之间的钩子：复用既有结构校验/不变量校验，避免循环依赖。 */
export interface SaveCoordinatorHooks {
  /** 现有 validateWorldStructure：完整结构校验（缺字段/类型错误）。 */
  validateWorldStructure: (world: WorldState) => string | null;
  /** 现有读取后修复（如股份汇总同步、投资实体开局份额补齐）。必须幂等。 */
  afterWorldRestored?: (world: WorldState) => void;
  /** 现有 checkInvariants。 */
  checkInvariants: (world: WorldState) => string[];
}

export interface SaveCoordinatorOptions {
  registry: SaveModuleRegistry;
  hooks: SaveCoordinatorHooks;
}

export interface ExportSaveOptions {
  savedAt?: string;
  gameVersion?: string;
  /** 读取旧存档时保留的未知可选模块；重新保存时原样写回。 */
  preservedModules?: Record<string, SaveModuleHeader>;
}

const encoder = new TextEncoder();

function textBytes(text: string): number {
  return encoder.encode(text).byteLength;
}

/** 判断模块头形状是否合法（不检查 version 是否被支持）。 */
function isModuleHeader(value: unknown): value is SaveModuleHeader {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const header = value as Record<string, unknown>;
  return (
    typeof header.version === 'number' &&
    Number.isInteger(header.version) &&
    header.version >= 1 &&
    typeof header.required === 'boolean' &&
    'data' in header
  );
}

/** 稳定拓扑排序：按依赖优先、同层按注册顺序；world 模块必须最先恢复。 */
function sortForRestore(modules: readonly SaveModule[]): SaveModule[] {
  const byId = new Map<string, SaveModule>(modules.map((module) => [module.id, module]));
  const visited = new Map<string, 0 | 1 | 2>();
  const order: SaveModule[] = [];
  const visit = (module: SaveModule, stack: string[]): void => {
    const state = visited.get(module.id) ?? 0;
    if (state === 2) return;
    if (state === 1) {
      throw new Error(`存档模块依赖存在循环：${[...stack, module.id].join(' → ')}`);
    }
    visited.set(module.id, 1);
    for (const dependency of module.dependsOn ?? []) {
      if (dependency === module.id) throw new Error(`存档模块 ${module.id} 依赖自身`);
      const target = byId.get(dependency);
      if (!target) throw new Error(`存档模块 ${module.id} 依赖未注册模块 ${dependency}`);
      visit(target, [...stack, module.id]);
    }
    visited.set(module.id, 2);
    order.push(module);
  };
  for (const module of modules) visit(module, []);
  return order;
}

export class SaveCoordinator {
  private readonly registry: SaveModuleRegistry;
  private readonly hooks: SaveCoordinatorHooks;

  constructor(options: SaveCoordinatorOptions) {
    this.registry = options.registry;
    this.hooks = options.hooks;
    // 提前排序一次：依赖缺失/循环在启动时暴露，而不是玩家保存时才发现。
    sortForRestore(this.registry.list());
  }

  /**
   * 生成模块化存档文本（minified JSON）。
   *
   * 同步完成快照与序列化，调用方（渲染层）在 await 桥接写入之前已得到同一时刻的一致文本。
   * 本方法只读 world，不修改任何游戏状态。
   */
  exportSave(world: WorldState, options: ExportSaveOptions = {}): ModuleExportResult {
    const t0 = Date.now();
    const warnings: string[] = [];
    const warn = (message: string): void => {
      warnings.push(message);
    };
    try {
      const modules: Record<string, SaveModuleHeader> = {};
      const moduleBytes: Record<string, number> = {};
      for (const module of this.registry.list()) {
        const context: SaveExportContext = { world, warn };
        const data = module.export(context);
        const header: SaveModuleHeader = {
          version: module.version,
          required: module.required,
          data,
        };
        modules[module.id] = header;
        moduleBytes[module.id] = textBytes(JSON.stringify(data));
      }
      // 未知可选模块原样写回；若当前版本已注册同名模块，则以当前模块为准（避免旧模块数据覆盖新数据）。
      for (const [id, header] of Object.entries(options.preservedModules ?? {})) {
        if (modules[id]) {
          warn(`重新保存时丢弃已被当前版本接管的旧模块数据：${id}`);
          continue;
        }
        if (!isModuleHeader(header)) {
          warn(`未知可选模块 ${id} 的保留数据无效，已丢弃`);
          continue;
        }
        modules[id] = header;
        moduleBytes[id] = textBytes(JSON.stringify(header.data));
      }
      const gameVersion = options.gameVersion ?? worldGameVersion();
      const worldMeta: SaveWorldMeta = {
        tick: world.time.tick,
        year: world.time.year,
        month: world.time.month,
        randomState: world.rngState,
        seed: world.seed,
        gameVersion,
      };
      const file: ModuleSaveFile = {
        formatVersion: MODULE_SAVE_FORMAT_VERSION,
        kind: MODULE_SAVE_KIND,
        gameVersion,
        savedAt: options.savedAt ?? new Date().toISOString(),
        worldMeta,
        modules,
      };
      const snapshotMs = Date.now() - t0;
      const t1 = Date.now();
      const text = JSON.stringify(file);
      const serializeMs = Date.now() - t1;
      const rawBytes = textBytes(text);
      if (rawBytes > MAX_SAVE_RAW_BYTES) {
        return {
          ok: false,
          error: `存档数据过大（原始 ${(rawBytes / 1048576).toFixed(1)}MiB，上限 ${MAX_SAVE_RAW_BYTES / 1048576}MiB）`,
          code: 'too-large',
        };
      }
      return {
        ok: true,
        text,
        rawBytes,
        moduleBytes,
        timings: { snapshotMs, serializeMs, totalMs: snapshotMs + serializeMs },
        ...(warnings.length > 0 ? { warnings } : {}),
      };
    } catch (error) {
      return {
        ok: false,
        error: `导出存档失败：${(error as Error).message}`,
        code: 'module-migration-failed',
      };
    }
  }

  /**
   * 读取模块化存档文档（已 JSON.parse 的根对象），返回候选世界。
   *
   * 失败时不会修改任何运行时世界；成功时返回的是独立构造的候选世界，由调用方一次性替换。
   */
  restoreSaveDocument(raw: Record<string, unknown>): ModuleParseResult {
    const warnings: string[] = [];
    const warn = (message: string): void => {
      warnings.push(message);
    };
    const fail = (code: SaveErrorCode, error: string): ModuleParseResult => ({ ok: false, warnings, error, code });

    const classification = classifySaveDocument(raw);
    if (classification.kind === 'unsupported') {
      return fail('unsupported-version', classification.error ?? '存档版本高于当前支持版本');
    }
    if (classification.kind !== 'module') {
      return fail(
        classification.code ?? 'unknown-format',
        classification.error ?? '不是模块化存档（旧单体存档应由兼容读取路径处理）',
      );
    }
    const metaValidation = validateWorldMeta(raw.worldMeta);
    if (!metaValidation.ok || !metaValidation.meta) {
      return fail('unknown-format', metaValidation.error ?? '存档 worldMeta 无效');
    }
    const meta = metaValidation.meta;
    if (typeof raw.gameVersion !== 'string' || typeof raw.savedAt !== 'string') {
      return fail('unknown-format', '存档缺少 gameVersion 或 savedAt');
    }
    if (typeof raw.modules !== 'object' || raw.modules === null || Array.isArray(raw.modules)) {
      return fail('unknown-format', '存档缺少 modules 对象');
    }
    const rawModules = raw.modules as Record<string, unknown>;

    // 解析已知模块的数据版本（尚未迁移）。
    interface PreparedModule {
      module: SaveModule;
      data: unknown;
      headerVersion: number;
      existed: boolean;
    }
    const prepared = new Map<string, PreparedModule>();
    const preservedModules: Record<string, SaveModuleHeader> = {};

    for (const module of this.registry.list()) {
      const headerValue = rawModules[module.id];
      if (headerValue === undefined) {
        if (module.required) {
          return fail('missing-required-module', `新格式存档缺少必需模块：${module.id}`);
        }
        // 可选模块缺失：交给模块的 fromVersion=0 初始化规则（不得凭空编造资金/人口/贷款/股份）。
        try {
          const migrationContext: SaveModuleMigrationContext = {
            moduleId: module.id,
            fromVersion: 0,
            toVersion: module.version,
            warn,
          };
          const initialized = module.migrate(undefined, migrationContext);
          prepared.set(module.id, { module, data: initialized, headerVersion: 0, existed: false });
          warn(`存档缺少可选模块 ${module.id}，已按旧档初始化规则补默认数据`);
        } catch (error) {
          return fail(
            'module-migration-failed',
            `可选模块 ${module.id} 无法从旧档初始化：${(error as Error).message}`,
          );
        }
        continue;
      }
      if (!isModuleHeader(headerValue)) {
        return fail('invalid-module-data', `模块 ${module.id} 的头信息无效`);
      }
      const header = headerValue as SaveModuleHeader;
      if (header.version > module.version) {
        return fail(
          'module-version-too-high',
          `存档模块 ${module.id} 版本 ${header.version} 高于当前支持的 ${module.version}，请使用更新版本的游戏读取。`,
        );
      }
      let data: unknown = header.data;
      if (header.version < module.version) {
        try {
          data = module.migrate(header.data, {
            moduleId: module.id,
            fromVersion: header.version,
            toVersion: module.version,
            warn,
          });
        } catch (error) {
          return fail(
            'module-migration-failed',
            `存档模块 ${module.id} 从 v${header.version} 迁移失败：${(error as Error).message}`,
          );
        }
      }
      const validation = module.validate(data, module.version);
      if (!validation.ok) {
        return fail(
          'invalid-module-data',
          `存档模块 ${module.id} 数据校验失败：${validation.errors.slice(0, 3).join('；')}`,
        );
      }
      prepared.set(module.id, { module, data, headerVersion: module.version, existed: true });
    }

    // 未知模块：必需 → 拒绝；可选 → 原样保留（重新保存时写回）。
    for (const [id, headerValue] of Object.entries(rawModules)) {
      if (this.registry.has(id)) continue;
      if (!isModuleHeader(headerValue)) {
        return fail('unknown-format', `未知模块 ${id} 的数据头无效，无法安全保留`);
      }
      const header = headerValue as SaveModuleHeader;
      if (header.required) {
        return fail(
          'unknown-required-module',
          `存档包含当前游戏不认识的必需模块 ${id}，请使用更新版本的游戏读取。`,
        );
      }
      preservedModules[id] = header;
      warn(`存档包含未知可选模块 ${id}，已原样保留，重新保存时会写回`);
    }

    // 候选世界：所有模块在独立对象中恢复，全部通过后才返回。
    const world = createCandidateWorld(meta);
    const restoreContextBase = {
      world,
      moduleData: rawModules as Record<string, SaveModuleHeader>,
      meta,
      warn,
      cityOf: (cityId: string): WorldState['cities'][number] => {
        const city = world.cities.find((entry) => entry.id === cityId);
        if (!city) throw new Error(`引用了不存在的城市：${cityId}`);
        return city;
      },
      companyOf: (companyId: string): WorldState['companies'][number] => {
        const company = world.companies.find((entry) => entry.id === companyId);
        if (!company) throw new Error(`引用了不存在的企业：${companyId}`);
        return company;
      },
    } satisfies SaveRestoreContext;

    let ordered: SaveModule[];
    try {
      ordered = sortForRestore(this.registry.list());
    } catch (error) {
      return fail('invalid-module-data', `模块依赖排序失败：${(error as Error).message}`);
    }

    for (const module of ordered) {
      const entry = prepared.get(module.id);
      if (!entry) {
        // 理论上不会发生：缺失的必需模块已在上文拒绝，缺失的可选模块已初始化。
        return fail('missing-required-module', `模块 ${module.id} 未准备好恢复数据`);
      }
      try {
        module.restore(entry.data, restoreContextBase);
      } catch (error) {
        return fail(
          'invalid-module-data',
          `恢复模块 ${module.id} 失败：${(error as Error).message}`,
        );
      }
    }

    for (const module of ordered) {
      if (!module.afterRestore) continue;
      try {
        module.afterRestore(restoreContextBase);
      } catch (error) {
        return fail(
          'reference-invalid',
          `模块 ${module.id} 恢复后校验/修复失败：${(error as Error).message}`,
        );
      }
    }

    // 顶层元信息必须与恢复结果一致（防止模块间互相覆盖时间/随机状态）。
    if (
      world.seed !== meta.seed ||
      world.rngState !== meta.randomState ||
      world.time.tick !== meta.tick ||
      world.time.year !== meta.year ||
      world.time.month !== meta.month
    ) {
      return fail('reference-invalid', '存档 worldMeta 与恢复后的世界时间/随机状态不一致');
    }

    const referenceErrors = validateCrossReferences(world);
    if (referenceErrors.length > 0) {
      return fail(
        'reference-invalid',
        `跨模块引用校验失败：${referenceErrors.slice(0, 3).join('；')}`,
      );
    }

    try {
      this.hooks.afterWorldRestored?.(world);
    } catch (error) {
      return fail('invariants-failed', `读取后修复失败：${(error as Error).message}`);
    }

    const structureError = this.hooks.validateWorldStructure(world);
    if (structureError) {
      return fail('invariants-failed', `存档结构校验失败：${structureError}`);
    }
    const invariantProblems = this.hooks.checkInvariants(world);
    if (invariantProblems.length > 0) {
      return fail(
        'invariants-failed',
        `存档未通过不变量校验：${invariantProblems.slice(0, 3).join('；')}`,
      );
    }

    return {
      ok: true,
      world,
      meta,
      savedAt: raw.savedAt,
      gameVersion: raw.gameVersion,
      warnings,
      ...(Object.keys(preservedModules).length > 0 ? { preservedModules } : {}),
    };
  }
}

/** 当前游戏版本。 */
function worldGameVersion(): string {
  return GAME_VERSION;
}
