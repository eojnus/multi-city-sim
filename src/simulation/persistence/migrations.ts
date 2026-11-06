/**
 * v1.7 存档系统：顶层格式迁移与识别。
 *
 * 负责：
 * - 解析存档根对象并识别“模块化新格式（formatVersion >= 10）”与“旧单体 WorldState 格式（1–9）”；
 * - 校验顶层元信息（格式版本、kind、gameVersion、savedAt、worldMeta）；
 * - 对模块化格式做顶层版本迁移入口（当前只有 v10；未来顶层布局变化时在此按版本链迁移）。
 *
 * 旧单体存档的具体字段迁移链仍在 src/simulation/core/save.ts（不能绕开既有迁移与不变量校验）。
 */

import type { ModuleSaveFile, SaveWorldMeta } from './types';
import { MODULE_SAVE_FORMAT_VERSION, MODULE_SAVE_KIND } from './types';
import type { SaveErrorCode } from './types';

export interface SaveDocumentParseError {
  ok: false;
  error: string;
  code: SaveErrorCode;
}

export interface SaveDocumentParsed {
  ok: true;
  raw: Record<string, unknown>;
}

/** 解析 JSON 文本为根对象（不做格式判断）。 */
export function parseSaveJson(text: string): SaveDocumentParsed | SaveDocumentParseError {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { ok: false, error: `存档不是有效 JSON：${(error as Error).message}`, code: 'invalid-json' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: '存档根节点不是对象', code: 'invalid-json' };
  }
  return { ok: true, raw: parsed as Record<string, unknown> };
}

export type SaveDocumentKind = 'module' | 'legacy' | 'unsupported' | 'unknown';

export interface SaveDocumentClassification {
  kind: SaveDocumentKind;
  formatVersion: number | null;
  /** kind === 'legacy' 时的世界数据（未迁移）。 */
  legacyWorld?: unknown;
  error?: string;
  code?: SaveErrorCode;
}

/**
 * 识别存档文档类型。判据是明确的、非猜测式的：
 * - formatVersion 为 >= MODULE_SAVE_FORMAT_VERSION 的整数且带 `kind: 'lanwan-modules'` → 模块格式；
 * - formatVersion 为 1..MODULE_SAVE_FORMAT_VERSION-1 且带 `world` 对象 → 旧单体格式；
 * - formatVersion 高于当前支持版本 → unsupported（由上层给出“需要更新游戏”的提示）；
 * - 其它组合（例如有 world 又声称模块格式、缺少 world、kind 不符）→ unknown/损坏。
 */
export function classifySaveDocument(raw: Record<string, unknown>): SaveDocumentClassification {
  const formatVersion = raw.formatVersion;
  if (typeof formatVersion !== 'number' || !Number.isInteger(formatVersion)) {
    return { kind: 'unknown', formatVersion: null, error: '存档缺少有效的 formatVersion', code: 'unknown-format' };
  }
  if (formatVersion < 1) {
    return { kind: 'unknown', formatVersion, error: `不支持的存档格式版本 ${formatVersion}`, code: 'unknown-format' };
  }
  if (formatVersion > MODULE_SAVE_FORMAT_VERSION) {
    return {
      kind: 'unsupported',
      formatVersion,
      error: `存档格式版本 ${formatVersion} 高于当前支持的 ${MODULE_SAVE_FORMAT_VERSION}，请使用更新版本的游戏读取。`,
      code: 'unsupported-version',
    };
  }
  const hasKind = raw.kind === MODULE_SAVE_KIND;
  const hasWorld = typeof raw.world === 'object' && raw.world !== null;
  if (formatVersion >= MODULE_SAVE_FORMAT_VERSION) {
    if (!hasKind) {
      return {
        kind: 'unknown',
        formatVersion,
        error: '存档格式版本为模块化格式，但缺少 kind 标识或标识不符',
        code: 'unknown-format',
      };
    }
    if (hasWorld) {
      return {
        kind: 'unknown',
        formatVersion,
        error: '模块化存档不应同时包含旧单体 world 字段',
        code: 'unknown-format',
      };
    }
    return { kind: 'module', formatVersion };
  }
  if (!hasWorld) {
    return {
      kind: 'unknown',
      formatVersion,
      error: '旧版存档缺少 world 数据',
      code: 'unknown-format',
    };
  }
  if (hasKind) {
    return {
      kind: 'unknown',
      formatVersion,
      error: '旧版存档不应带有模块化 kind 标识',
      code: 'unknown-format',
    };
  }
  return { kind: 'legacy', formatVersion, legacyWorld: raw.world };
}

export interface WorldMetaValidation {
  ok: boolean;
  meta?: SaveWorldMeta;
  error?: string;
  code?: SaveErrorCode;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** 校验 worldMeta（模块格式必须具备；用于早期诊断与候选世界创建）。 */
export function validateWorldMeta(value: unknown): WorldMetaValidation {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, error: '存档缺少 worldMeta', code: 'unknown-format' };
  }
  const meta = value as Record<string, unknown>;
  for (const key of ['tick', 'year', 'month', 'randomState', 'seed']) {
    if (!isFiniteNumber(meta[key])) {
      return { ok: false, error: `存档 worldMeta.${key} 无效`, code: 'unknown-format' };
    }
  }
  if (typeof meta.gameVersion !== 'string') {
    return { ok: false, error: '存档 worldMeta.gameVersion 无效', code: 'unknown-format' };
  }
  return {
    ok: true,
    meta: {
      tick: meta.tick as number,
      year: meta.year as number,
      month: meta.month as number,
      randomState: meta.randomState as number,
      seed: meta.seed as number,
      gameVersion: meta.gameVersion,
    },
  };
}

/**
 * 顶层版本迁移入口：把旧顶层版本升级到当前模块化顶层版本。
 *
 * 当前只有 v10。未来若顶层布局变化（如 v11 增加新元信息），在此按 fromVersion → toVersion 链式迁移；
 * 顶层迁移只处理“外层结构/元信息”，不得改写各模块内部数据（那属于模块自己的 migrate）。
 */
export function migrateTopLevel(document: ModuleSaveFile): ModuleSaveFile {
  if (document.formatVersion === MODULE_SAVE_FORMAT_VERSION) return document;
  // formatVersion > 当前版本已在上层拒绝；< 10 且声称模块格式视为损坏。
  throw new Error(`不支持的模块化顶层格式版本：${document.formatVersion}`);
}
