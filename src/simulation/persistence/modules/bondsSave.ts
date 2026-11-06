/**
 * v1.7 存档模块：政府债券账本（bonds）。
 *
 * 数据归属依据 /tmp/save-ownership-b.md §1 与 docs/development/SAVE_SYSTEM_DESIGN.md §2.8：
 * - `bonds.issuances`：发行批次（条款/实售/回款汇总；`principal` = 累计售出毛额）；
 * - `bonds.holdings`：逐持有人债权（`principal ≈ units × faceValue`；active 未偿用于债务/GDP）；
 * - `bonds.payments`：兑付流水（审计 + 同 tick 幂等键）；
 * - `nextIssuanceNumber/nextHoldingNumber/nextPaymentNumber`：序号计数（权威，不得重排）。
 *
 * 账本跨城共享一本账（`BondState`），不存在按城市的副本。
 * export 只读世界并返回纯数据；restore 只写 `bonds` 顶层字段。
 */

import type { BondState } from '../../contracts/types';
import type {
  SaveExportContext,
  SaveModule,
  SaveModuleMigrationContext,
  SaveModuleValidation,
  SaveRestoreContext,
} from '../types';

/** 模块数据版本：字段变化时递增（当前 v10 存档统一为 1）。 */
export const BONDS_SAVE_MODULE_VERSION = 1;

export interface BondsSaveData {
  bonds: BondState;
}

type UnknownRecord = Record<string, unknown>;

/** 空债券账本：仅用于运行时世界缺少可选 `bonds` 字段时导出（当前版本正常情况不会发生）。 */
export function emptyBondState(): BondState {
  return {
    issuances: [],
    holdings: [],
    payments: [],
    nextIssuanceNumber: 1,
    nextHoldingNumber: 1,
    nextPaymentNumber: 1,
  };
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function expectRecord(value: unknown, path: string, errors: string[]): UnknownRecord | null {
  if (!isRecord(value)) {
    errors.push(`${path} 必须是对象`);
    return null;
  }
  return value;
}

function expectArray(value: unknown, path: string, errors: string[]): unknown[] | null {
  if (!Array.isArray(value)) {
    errors.push(`${path} 必须是数组`);
    return null;
  }
  return value;
}

function checkEntries(
  value: unknown,
  path: string,
  errors: string[],
  checkEntry: (entry: UnknownRecord, entryPath: string) => void,
): void {
  const array = expectArray(value, path, errors);
  if (!array) return;
  array.forEach((entry, index) => {
    if (!isRecord(entry)) {
      errors.push(`${path}[${index}] 必须是对象`);
      return;
    }
    checkEntry(entry, `${path}[${index}]`);
  });
}

function requireString(record: UnknownRecord, key: string, path: string, errors: string[]): void {
  if (typeof record[key] !== 'string') errors.push(`${path}.${key} 必须是字符串`);
}

function requireNonEmptyString(
  record: UnknownRecord,
  key: string,
  path: string,
  errors: string[],
): void {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) {
    errors.push(`${path}.${key} 必须是非空字符串`);
  }
}

function requireFiniteNumber(
  record: UnknownRecord,
  key: string,
  path: string,
  errors: string[],
): void {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    errors.push(`${path}.${key} 必须是有限数字`);
  }
}

function requirePositiveInteger(
  record: UnknownRecord,
  key: string,
  path: string,
  errors: string[],
): void {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    errors.push(`${path}.${key} 必须是 >=1 的整数`);
  }
}

function requireHolder(record: UnknownRecord, path: string, errors: string[]): void {
  const holder = expectRecord(record.holder, `${path}.holder`, errors);
  if (!holder) return;
  requireNonEmptyString(holder, 'kind', `${path}.holder`, errors);
  requireString(holder, 'id', `${path}.holder`, errors);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function validateBondState(value: unknown, errors: string[]): void {
  const bonds = expectRecord(value, 'bonds', errors);
  if (!bonds) return;
  const issuanceIds = new Set<string>();
  const issuances = expectArray(bonds.issuances, 'bonds.issuances', errors);
  issuances?.forEach((raw, index) => {
    const path = `bonds.issuances[${index}]`;
    if (!isRecord(raw)) {
      errors.push(`${path} 必须是对象`);
      return;
    }
    requireNonEmptyString(raw, 'id', path, errors);
    if (typeof raw.id === 'string' && raw.id.length > 0) {
      if (issuanceIds.has(raw.id)) errors.push(`${path}.id 重复：${raw.id}`);
      issuanceIds.add(raw.id);
    }
    requireNonEmptyString(raw, 'cityId', path, errors);
    requireFiniteNumber(raw, 'faceValue', path, errors);
    requireFiniteNumber(raw, 'couponRateAnnual', path, errors);
    requireFiniteNumber(raw, 'planUnits', path, errors);
    requireFiniteNumber(raw, 'soldUnits', path, errors);
    requireFiniteNumber(raw, 'principal', path, errors);
    requireFiniteNumber(raw, 'maturityTick', path, errors);
    requireFiniteNumber(raw, 'interestPaid', path, errors);
    requireFiniteNumber(raw, 'principalRepaid', path, errors);
    if (raw.status !== 'offering' && raw.status !== 'active' && raw.status !== 'redeemed') {
      errors.push(`${path}.status 非法：${String(raw.status)}`);
    }
  });
  const holdingIds = new Set<string>();
  checkEntries(bonds.holdings, 'bonds.holdings', errors, (entry, path) => {
    requireNonEmptyString(entry, 'id', path, errors);
    if (typeof entry.id === 'string' && entry.id.length > 0) {
      if (holdingIds.has(entry.id)) errors.push(`${path}.id 重复：${entry.id}`);
      holdingIds.add(entry.id);
    }
    const issuanceId = entry.issuanceId;
    if (typeof issuanceId !== 'string' || !issuanceIds.has(issuanceId)) {
      errors.push(`${path}.issuanceId 引用了不存在的债券批次：${String(issuanceId)}`);
    }
    requireNonEmptyString(entry, 'cityId', path, errors);
    requireFiniteNumber(entry, 'units', path, errors);
    requireFiniteNumber(entry, 'principal', path, errors);
    requireFiniteNumber(entry, 'accruedInterest', path, errors);
    requireHolder(entry, path, errors);
    if (entry.status !== 'active' && entry.status !== 'redeemed') {
      errors.push(`${path}.status 非法：${String(entry.status)}`);
    }
  });
  const paymentIds = new Set<string>();
  checkEntries(bonds.payments, 'bonds.payments', errors, (entry, path) => {
    requireNonEmptyString(entry, 'id', path, errors);
    if (typeof entry.id === 'string' && entry.id.length > 0) {
      if (paymentIds.has(entry.id)) errors.push(`${path}.id 重复：${entry.id}`);
      paymentIds.add(entry.id);
    }
    requireFiniteNumber(entry, 'tick', path, errors);
    const issuanceId = entry.issuanceId;
    if (typeof issuanceId !== 'string' || !issuanceIds.has(issuanceId)) {
      errors.push(`${path}.issuanceId 引用了不存在的债券批次：${String(issuanceId)}`);
    }
    requireFiniteNumber(entry, 'principalPaid', path, errors);
    requireFiniteNumber(entry, 'interestPaid', path, errors);
    requireHolder(entry, path, errors);
    if (entry.kind !== 'coupon' && entry.kind !== 'principal' && entry.kind !== 'bankruptcyRedemption') {
      errors.push(`${path}.kind 非法：${String(entry.kind)}`);
    }
    if (typeof entry.fundedByBankAdvance !== 'boolean') {
      errors.push(`${path}.fundedByBankAdvance 必须是布尔值`);
    }
  });
  requirePositiveInteger(bonds, 'nextIssuanceNumber', 'bonds', errors);
  requirePositiveInteger(bonds, 'nextHoldingNumber', 'bonds', errors);
  requirePositiveInteger(bonds, 'nextPaymentNumber', 'bonds', errors);
}

export const bondsSaveModule: SaveModule<BondsSaveData> = {
  id: 'bonds',
  version: BONDS_SAVE_MODULE_VERSION,
  required: true,
  ownedPaths: ['bonds'],
  dependsOn: ['world'],

  export(context: SaveExportContext): BondsSaveData {
    const bonds = context.world.bonds;
    if (!isRecord(bonds)) {
      context.warn('世界缺少 bonds 账本（v0.7 前旧档），按空账本导出债券存档模块');
      return { bonds: emptyBondState() };
    }
    return { bonds: cloneJson(bonds) };
  },

  validate(data: unknown, version: number): SaveModuleValidation {
    if (version !== BONDS_SAVE_MODULE_VERSION) {
      return {
        ok: false,
        errors: [`bonds 模块数据版本不受支持：${version}（当前支持 ${BONDS_SAVE_MODULE_VERSION}）`],
      };
    }
    if (!isRecord(data)) {
      return { ok: false, errors: ['bonds 模块数据必须是对象'] };
    }
    const errors: string[] = [];
    validateBondState(data.bonds, errors);
    return { ok: errors.length === 0, errors };
  },

  migrate(data: unknown, context: SaveModuleMigrationContext): BondsSaveData {
    if (context.fromVersion === 0) {
      // 必需模块缺失 = 存档损坏：债券债权/流水无法凭空重建。
      throw new Error('存档缺少必需的 bonds 模块：无法安全重建债券账本');
    }
    if (context.fromVersion === BONDS_SAVE_MODULE_VERSION) {
      return data as BondsSaveData;
    }
    throw new Error(
      `不支持的 bonds 模块版本迁移：${context.fromVersion} → ${BONDS_SAVE_MODULE_VERSION}`,
    );
  },

  restore(data: BondsSaveData, context: SaveRestoreContext): void {
    if (!isRecord(data) || !isRecord(data.bonds)) {
      throw new Error('bonds 模块数据缺少 bonds');
    }
    context.world.bonds = cloneJson(data.bonds);
  },

  /**
   * 恢复后对账（设计文档 §2.8）：旧档缺省的汇总字段按 0 处理并 warning；
   * 只修复“缺省”，不覆盖已有权威值（不变量与历史治理负责一致性）。
   */
  afterRestore(context: SaveRestoreContext): void {
    const bonds = context.world.bonds;
    if (!isRecord(bonds) || !Array.isArray(bonds.issuances)) return;
    for (const issuance of bonds.issuances) {
      if (!isRecord(issuance)) continue;
      for (const key of ['interestPaid', 'principalRepaid', 'bankAdvancedAmount'] as const) {
        const value = issuance[key];
        if (value === undefined || value === null) {
          issuance[key] = 0;
          context.warn(`债券批次 ${String(issuance.id)} 缺少汇总字段 ${key}，已按 0 处理`);
        }
      }
    }
  },
};
