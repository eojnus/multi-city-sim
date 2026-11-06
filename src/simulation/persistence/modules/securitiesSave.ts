/**
 * v1.7 存档模块：证券与公司治理（securities + governance）。
 *
 * 数据归属依据 /tmp/save-ownership-b.md §1 与 docs/development/SAVE_SYSTEM_DESIGN.md §2.9：
 * - `securities.classes`：股份类别与发行量唯一权威；
 * - `securities.holdings`：持股权威（各持有人合计 = 类别发行量，由不变量校验）；
 * - `securities.orders` / `offers`：有效临时委托（TTL 2 月）；
 * - `securities.lastTrades`：易失展示（每月清空）；
 * - `securities.history`：月度 K 线（真实成交；退市保留 exitedTick）；
 * - `governance.boards/controls/motions`：董事会、控制权与议案权威。
 *
 * `company.totalShares` 与 `player.holdings` 是派生镜像（恢复后由 core/save.ts 的 sync* 重建），
 * 不属于本模块。
 */

import type { GovernanceState, SecuritiesState } from '../../contracts/types';
import type {
  SaveExportContext,
  SaveModule,
  SaveModuleMigrationContext,
  SaveModuleValidation,
  SaveRestoreContext,
} from '../types';

/** 模块数据版本：字段变化时递增（当前 v10 存档统一为 1）。 */
export const SECURITIES_SAVE_MODULE_VERSION = 1;

export interface SecuritiesSaveData {
  securities: SecuritiesState;
  governance: GovernanceState;
}

type UnknownRecord = Record<string, unknown>;

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

function requireHolder(record: UnknownRecord, key: string, path: string, errors: string[]): void {
  const holder = expectRecord(record[key], `${path}.${key}`, errors);
  if (!holder) return;
  requireNonEmptyString(holder, 'type', `${path}.${key}`, errors);
  requireNonEmptyString(holder, 'id', `${path}.${key}`, errors);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function validateSecuritiesState(value: unknown, errors: string[]): void {
  const securities = expectRecord(value, 'securities', errors);
  if (!securities) return;
  checkEntries(securities.classes, 'securities.classes', errors, (entry, path) => {
    requireNonEmptyString(entry, 'id', path, errors);
    requireNonEmptyString(entry, 'companyId', path, errors);
    if (entry.kind !== 'voting' && entry.kind !== 'nonVoting') {
      errors.push(`${path}.kind 非法：${String(entry.kind)}`);
    }
    requireFiniteNumber(entry, 'issuedShares', path, errors);
  });
  checkEntries(securities.holdings, 'securities.holdings', errors, (entry, path) => {
    requireNonEmptyString(entry, 'companyId', path, errors);
    requireNonEmptyString(entry, 'shareClassId', path, errors);
    requireHolder(entry, 'holder', path, errors);
    requireFiniteNumber(entry, 'shares', path, errors);
    requireString(entry, 'acquiredVia', path, errors);
    requireFiniteNumber(entry, 'sinceTick', path, errors);
  });
  checkEntries(securities.orders, 'securities.orders', errors, (entry, path) => {
    requireNonEmptyString(entry, 'id', path, errors);
    requireNonEmptyString(entry, 'companyId', path, errors);
    requireNonEmptyString(entry, 'shareClassId', path, errors);
    if (entry.side !== 'buy' && entry.side !== 'sell') {
      errors.push(`${path}.side 非法：${String(entry.side)}`);
    }
    requireHolder(entry, 'holder', path, errors);
    requireFiniteNumber(entry, 'shares', path, errors);
    requireFiniteNumber(entry, 'limitPrice', path, errors);
    requireFiniteNumber(entry, 'createdTick', path, errors);
  });
  checkEntries(securities.lastTrades, 'securities.lastTrades', errors, (entry, path) => {
    requireNonEmptyString(entry, 'id', path, errors);
    requireFiniteNumber(entry, 'tick', path, errors);
    requireNonEmptyString(entry, 'companyId', path, errors);
    requireNonEmptyString(entry, 'shareClassId', path, errors);
    requireHolder(entry, 'buyer', path, errors);
    requireHolder(entry, 'seller', path, errors);
    requireFiniteNumber(entry, 'shares', path, errors);
    requireFiniteNumber(entry, 'unitPrice', path, errors);
    requireFiniteNumber(entry, 'value', path, errors);
  });
  checkEntries(securities.offers, 'securities.offers', errors, (entry, path) => {
    requireNonEmptyString(entry, 'id', path, errors);
    requireNonEmptyString(entry, 'companyId', path, errors);
    requireHolder(entry, 'investor', path, errors);
    if (entry.kind !== 'voting' && entry.kind !== 'nonVoting') {
      errors.push(`${path}.kind 非法：${String(entry.kind)}`);
    }
    requireFiniteNumber(entry, 'amount', path, errors);
    requireFiniteNumber(entry, 'pricePerShare', path, errors);
    requireFiniteNumber(entry, 'shares', path, errors);
    if (
      entry.status !== 'open' &&
      entry.status !== 'accepted' &&
      entry.status !== 'declined' &&
      entry.status !== 'expired'
    ) {
      errors.push(`${path}.status 非法：${String(entry.status)}`);
    }
    requireFiniteNumber(entry, 'createdTick', path, errors);
  });
  checkEntries(securities.history, 'securities.history', errors, (entry, path) => {
    requireNonEmptyString(entry, 'shareClassId', path, errors);
    requireNonEmptyString(entry, 'companyId', path, errors);
    checkEntries(entry.candles, `${path}.candles`, errors, (candle, candlePath) => {
      requireFiniteNumber(candle, 'tick', candlePath, errors);
      requireFiniteNumber(candle, 'open', candlePath, errors);
      requireFiniteNumber(candle, 'high', candlePath, errors);
      requireFiniteNumber(candle, 'low', candlePath, errors);
      requireFiniteNumber(candle, 'close', candlePath, errors);
      requireFiniteNumber(candle, 'volume', candlePath, errors);
      requireFiniteNumber(candle, 'trades', candlePath, errors);
    });
  });
}

function validateGovernanceState(value: unknown, errors: string[]): void {
  const governance = expectRecord(value, 'governance', errors);
  if (!governance) return;
  checkEntries(governance.boards, 'governance.boards', errors, (entry, path) => {
    requireNonEmptyString(entry, 'companyId', path, errors);
    checkEntries(entry.seats, `${path}.seats`, errors, (seat, seatPath) => {
      requireHolder(seat, 'holder', seatPath, errors);
      requireFiniteNumber(seat, 'votingShares', seatPath, errors);
      requireFiniteNumber(seat, 'sinceTick', seatPath, errors);
    });
    if (entry.chair !== null) requireHolder(entry, 'chair', path, errors);
    requireFiniteNumber(entry, 'lastElectionTick', path, errors);
  });
  checkEntries(governance.motions, 'governance.motions', errors, (entry, path) => {
    requireNonEmptyString(entry, 'id', path, errors);
    requireNonEmptyString(entry, 'companyId', path, errors);
    requireString(entry, 'kind', path, errors);
    requireFiniteNumber(entry, 'createdTick', path, errors);
    requireFiniteNumber(entry, 'closesAtTick', path, errors);
    requireHolder(entry, 'proposedBy', path, errors);
    if (entry.status !== 'open' && entry.status !== 'passed' && entry.status !== 'rejected') {
      errors.push(`${path}.status 非法：${String(entry.status)}`);
    }
    expectArray(entry.eligible, `${path}.eligible`, errors);
    expectArray(entry.votes, `${path}.votes`, errors);
    if (entry.decidedTick !== null) requireFiniteNumber(entry, 'decidedTick', path, errors);
  });
  checkEntries(governance.controls, 'governance.controls', errors, (entry, path) => {
    requireNonEmptyString(entry, 'companyId', path, errors);
    if (entry.operator !== 'management') requireHolder(entry, 'operator', path, errors);
    requireString(entry, 'basis', path, errors);
    requireFiniteNumber(entry, 'sinceTick', path, errors);
  });
}

export const securitiesSaveModule: SaveModule<SecuritiesSaveData> = {
  id: 'securities',
  version: SECURITIES_SAVE_MODULE_VERSION,
  required: true,
  ownedPaths: ['securities', 'governance'],
  dependsOn: ['world'],

  export(context: SaveExportContext): SecuritiesSaveData {
    const { world } = context;
    if (!isRecord(world.securities)) {
      throw new Error('世界缺少 securities 状态，无法导出证券存档模块');
    }
    if (!isRecord(world.governance)) {
      throw new Error('世界缺少 governance 状态，无法导出证券存档模块');
    }
    return {
      securities: cloneJson(world.securities),
      governance: cloneJson(world.governance),
    };
  },

  validate(data: unknown, version: number): SaveModuleValidation {
    if (version !== SECURITIES_SAVE_MODULE_VERSION) {
      return {
        ok: false,
        errors: [
          `securities 模块数据版本不受支持：${version}（当前支持 ${SECURITIES_SAVE_MODULE_VERSION}）`,
        ],
      };
    }
    if (!isRecord(data)) {
      return { ok: false, errors: ['securities 模块数据必须是对象'] };
    }
    const errors: string[] = [];
    validateSecuritiesState(data.securities, errors);
    validateGovernanceState(data.governance, errors);
    return { ok: errors.length === 0, errors };
  },

  migrate(data: unknown, context: SaveModuleMigrationContext): SecuritiesSaveData {
    if (context.fromVersion === 0) {
      // 必需模块缺失 = 存档损坏：股份与治理状态无法凭空重建。
      throw new Error('存档缺少必需的 securities 模块：无法安全重建证券与治理状态');
    }
    if (context.fromVersion === SECURITIES_SAVE_MODULE_VERSION) {
      return data as SecuritiesSaveData;
    }
    throw new Error(
      `不支持的 securities 模块版本迁移：${context.fromVersion} → ${SECURITIES_SAVE_MODULE_VERSION}`,
    );
  },

  restore(data: SecuritiesSaveData, context: SaveRestoreContext): void {
    if (!isRecord(data) || !isRecord(data.securities) || !isRecord(data.governance)) {
      throw new Error('securities 模块数据缺少 securities/governance');
    }
    context.world.securities = cloneJson(data.securities);
    context.world.governance = cloneJson(data.governance);
  },
};
