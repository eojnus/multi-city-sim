/**
 * v1.7 存档系统：类型、模块接口与格式契约。
 *
 * 本轮把“单个 WorldState 深拷贝 + JSON”升级为“统一存档管理器 + 分模块快照 + 版本迁移 +
 * 历史治理 + 精简 JSON + gzip”。本文件只定义契约，不实现任何具体模块。
 *
 * 关键不变量（与任务书 §三/§八 对应）：
 * - 顶层 formatVersion 与各模块 version 分开管理；顶层版本决定整体布局，模块版本只描述该模块数据。
 * - 每个模块声明自己拥有的世界字段（`ownedPaths`），注册表检查不同模块之间没有重复归属；
 *   数据归属总表另见 docs/development/SAVE_SYSTEM_DESIGN.md。
 * - 恢复先构造“候选世界”，全部模块恢复 + 跨模块引用校验 + 不变量校验通过后，才替换运行时世界；
 *   任何一步失败都不得改动当前世界。
 * - 旧单体 WorldState 存档（formatVersion 1–9、明文或 gzip）继续走既有迁移链，再转换为模块格式；
 *   旧存档迁移逻辑不删除、不绕过。
 */

import type { WorldState } from '../contracts/types';

/** 顶层（模块化）存档格式版本。旧单体格式为 1–9，本轮新格式为 10。 */
export const MODULE_SAVE_FORMAT_VERSION = 10;

/** 存档顶层结构标识（写入存档，便于诊断；读取以 formatVersion 为准，本字段只做交叉校验）。 */
export const MODULE_SAVE_KIND = 'lanwan-modules';

/**
 * 原始（未压缩）存档文本的字节上限：接近任务书 §六.5 的 128MiB 暂定兜底值。
 *
 * 注意：该值只用于拒绝异常/恶意输入，不是体积目标。实测内存峰值见交付报告；
 * 若后续实测表明 128MiB 在目标机器上不安全，应调整此常量并同步 saveBridge/saveIpc 文案。
 */
export const MAX_SAVE_RAW_BYTES = 128 * 1024 * 1024;

/** 磁盘上压缩文件字节上限（gzip 后）。 */
export const MAX_SAVE_COMPRESSED_BYTES = 64 * 1024 * 1024;

/** 模块 ID：小写字母开头、小写字母/数字组成；注册后视为稳定契约，不得改名。 */
export const SAVE_MODULE_ID_PATTERN = /^[a-z][a-z0-9]{1,31}$/;

/** 模块 ID 的静态联合类型（新增模块时在此登记；运行时仍以字符串注册表为准）。 */
export type SaveModuleId =
  | 'world'
  | 'population'
  | 'company'
  | 'marketTrade'
  | 'equipment'
  | 'banking'
  | 'government'
  | 'bonds'
  | 'securities'
  | 'management'
  | 'politics';

/** 存档顶层“世界元信息”：足够在恢复早期创建候选世界并检查基本一致性。 */
export interface SaveWorldMeta {
  /** 当前 tick（与 time.tick 相同，冗余便于早期诊断）。 */
  tick: number;
  year: number;
  month: number;
  /** 随机数状态（与 WorldState.rngState 相同）。 */
  randomState: number;
  /** 世界种子（与 WorldState.seed 相同）。 */
  seed: number;
  /** 保存时的游戏版本（与顶层 gameVersion 相同，便于按模块诊断）。 */
  gameVersion: string;
}

/** 单个模块在存档中的头信息。 */
export interface SaveModuleHeader<TData = unknown> {
  /** 模块数据版本（从 1 开始；只在该模块数据字段变化时递增）。 */
  version: number;
  /** 是否核心必需模块：新格式存档缺失必需模块 = 存档不完整/损坏。 */
  required: boolean;
  /** 模块数据本体（必须是可 JSON 序列化的纯数据）。 */
  data: TData;
}

/** 模块化存档文件的完整结构。 */
export interface ModuleSaveFile {
  formatVersion: number;
  kind: typeof MODULE_SAVE_KIND;
  gameVersion: string;
  savedAt: string;
  worldMeta: SaveWorldMeta;
  modules: Record<string, SaveModuleHeader>;
  /**
   * 未知“可选模块”的原样保留数据。读取时若遇到未知可选模块，原样存到这里；
   * 重新保存时由协调器原样写回（不允许静默丢弃）。
   */
  preservedModules?: Record<string, SaveModuleHeader>;
}

/** 导出上下文：只读运行时世界。模块导出不得修改它。 */
export interface SaveExportContext {
  readonly world: WorldState;
  /** 导出期间的可诊断信息（写入报告/日志，不进入存档数据）。 */
  readonly warn: (message: string) => void;
}

/** 模块数据校验结果。 */
export interface SaveModuleValidation {
  ok: boolean;
  errors: string[];
}

/** 模块版本迁移上下文。 */
export interface SaveModuleMigrationContext {
  readonly moduleId: string;
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly warn: (message: string) => void;
}

/**
 * 恢复上下文：把模块数据写入“候选世界”。
 *
 * 候选世界由协调器创建：world 模块先建立城市骨架，其他模块再按 ID 查询并填充。
 * 模块只能写入自己 `ownedPaths` 声明的字段；不得改其他模块拥有的字段。
 */
export interface SaveRestoreContext {
  /** 候选世界（尚未替换运行时世界；失败时整体丢弃）。 */
  readonly world: WorldState;
  /** 本次读取到的全部模块头（只读；用于模块间查询/引用修复）。 */
  readonly moduleData: Readonly<Record<string, SaveModuleHeader>>;
  /** 读取该存档的顶层元信息。 */
  readonly meta: SaveWorldMeta;
  /** 非致命问题（数据缺省初始化、未知可选字段等），进入读取报告。 */
  readonly warn: (message: string) => void;
  /** 按 ID 查找候选世界中的城市；找不到抛错（属于必须失败的引用错误）。 */
  cityOf: (cityId: string) => WorldState['cities'][number];
  /** 按 ID 查找候选世界中的企业；找不到抛错。 */
  companyOf: (companyId: string) => WorldState['companies'][number];
}

/**
 * 可注册的存档模块。
 *
 * 约定：
 * - `export` 只读世界，返回纯数据；不得修改当前权威世界。
 * - `validate` 必须能在不依赖运行时世界的情况下检查数据形状与取值。
 * - `migrate` 把旧模块版本数据升级到当前版本；无法安全迁移时抛错（由协调器转为可读错误）。
 * - `restore` 只写入 `ownedPaths` 声明字段；引用完整性校验放到 `afterRestore` 或协调器的
 *   `referenceValidation`（所有模块恢复完成后统一执行）。
 * - 模块版本高于当前游戏支持时必须拒绝，不得静默降级。
 */
export interface SaveModule<TData = unknown> {
  /** 稳定模块 ID（小写字母/数字；注册后不得改名）。 */
  readonly id: SaveModuleId;
  /** 当前数据版本。 */
  readonly version: number;
  /** 是否核心必需模块。 */
  readonly required: boolean;
  /**
   * 该模块拥有的世界字段路径（用于注册表检查重复归属 + 文档/测试的归属总表）。
   * 语法示例：`seed`、`time`、`cities[].population`、`cities[].market`、`banking.loans`。
   */
  readonly ownedPaths: readonly string[];
  /**
   * 恢复顺序依赖（可选）。例如 `population` 依赖 `world`（候选世界的城市骨架由 world 建立）。
   * 协调器按依赖做稳定拓扑排序；`world` 模块必须最先恢复。
   */
  readonly dependsOn?: readonly string[];
  export(context: SaveExportContext): TData;
  validate(data: unknown, version: number): SaveModuleValidation;
  /**
   * 把旧版本模块数据升级到当前版本。
   *
   * 约定 `context.fromVersion === 0` 表示“该模块在存档中不存在”（新系统读取旧档，或未知可选
   * 模块缺失）。模块必须在此实现明确的旧档初始化规则：能安全从其它模块/世界信息推导的填默认值，
   * 无法安全推断的必须抛错，不得凭空编造资金、人口、贷款或股份。
   */
  migrate(data: unknown, context: SaveModuleMigrationContext): TData;
  restore(data: TData, context: SaveRestoreContext): void;
  /** 可选：所有模块恢复完成后的跨模块修复/校验。 */
  afterRestore?(context: SaveRestoreContext): void;
}

/** 保存/读取失败分类（平台层与 UI 共用；字符串稳定，可跨 IPC）。 */
export type SaveErrorCode =
  | 'invalid-json'
  | 'unknown-format'
  | 'too-large'
  | 'unsupported-version'
  | 'missing-required-module'
  | 'unknown-required-module'
  | 'module-version-too-high'
  | 'invalid-module-data'
  | 'module-migration-failed'
  | 'reference-invalid'
  | 'invariants-failed'
  | 'format-migration-failed'
  | 'write-failed'
  | 'read-failed';

/** 读取成功/失败结果。 */
export interface ModuleParseResult {
  ok: boolean;
  world?: WorldState;
  /** 读取到的顶层元信息（失败时可能缺省）。 */
  meta?: SaveWorldMeta;
  savedAt?: string;
  gameVersion?: string;
  /** 迁移来源：旧单体格式版本；新模块格式读取为 undefined。 */
  migratedFrom?: number;
  /** 读取过程中的非致命提示（旧模块初始化为空、未知可选模块被保留等）。 */
  warnings: string[];
  /** 未知可选模块（重新保存时原样写回）。 */
  preservedModules?: Record<string, SaveModuleHeader>;
  error?: string;
  code?: SaveErrorCode;
}

/** 导出/序列化结果（协调器返回给平台层）。 */
export interface ModuleExportResult {
  ok: boolean;
  text?: string;
  /** 序列化后的原始文本字节数（未压缩）。 */
  rawBytes?: number;
  /** 各模块原始 JSON 字节数（诊断/体积报告用）。 */
  moduleBytes?: Record<string, number>;
  /** 导出耗时分解（毫秒）：快照组装 / JSON 序列化。 */
  timings?: { snapshotMs: number; serializeMs: number; totalMs: number };
  /** 导出过程中的非致命提示（例如未知可选模块被接管丢弃）。 */
  warnings?: string[];
  error?: string;
  code?: SaveErrorCode;
}
