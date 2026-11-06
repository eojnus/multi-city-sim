/**
 * v1.7 存档模块：银行账本（banking）。
 *
 * 数据归属依据 /tmp/save-ownership-b.md §1 与 docs/development/SAVE_SYSTEM_DESIGN.md §2.6：
 * - `banking.deposits` / `banking.loans` 是存款与贷款的唯一权威账本（`company.debt` 只是派生镜像，
 *   属于 company 模块，不在此保存；政府债务在 `cities[].government.loans`，属于 government 模块）；
 * - `banking.snapshots` 是每月重算的授信快照（当月规则冻结读取）；
 * - `banking.lastMonth` 是月内累计统计（利息收入/发放不可重算，需保存）。
 *
 * 注意：`householdFinance`（居民消费贷独立账本）归 population 模块（设计文档 §2.2/§2.6），
 * banking 模块不拥有它，避免一本账两处保存。
 *
 * export 只读世界并返回纯数据（JSON 克隆）；restore 只写自己拥有的 `banking` 顶层字段。
 */

import type { BankingState } from '../../contracts/types';
import type {
  SaveExportContext,
  SaveModule,
  SaveModuleMigrationContext,
  SaveModuleValidation,
  SaveRestoreContext,
} from '../types';

/** 模块数据版本：字段变化时递增（当前 v10 存档统一为 1）。 */
export const BANKING_SAVE_MODULE_VERSION = 1;

export interface BankingSaveData {
  banking: BankingState;
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

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function validateBankingState(value: unknown, errors: string[]): void {
  const banking = expectRecord(value, 'banking', errors);
  if (!banking) return;
  checkEntries(banking.deposits, 'banking.deposits', errors, (entry, path) => {
    requireNonEmptyString(entry, 'id', path, errors);
    const owner = expectRecord(entry.owner, `${path}.owner`, errors);
    if (owner) {
      requireNonEmptyString(owner, 'kind', `${path}.owner`, errors);
      requireNonEmptyString(owner, 'id', `${path}.owner`, errors);
    }
    requireFiniteNumber(entry, 'balance', path, errors);
    requireFiniteNumber(entry, 'rateMonthly', path, errors);
    requireFiniteNumber(entry, 'accruedInterest', path, errors);
  });
  checkEntries(banking.loans, 'banking.loans', errors, (entry, path) => {
    requireNonEmptyString(entry, 'id', path, errors);
    const borrower = expectRecord(entry.borrower, `${path}.borrower`, errors);
    if (borrower) {
      requireNonEmptyString(borrower, 'kind', `${path}.borrower`, errors);
      requireNonEmptyString(borrower, 'id', `${path}.borrower`, errors);
    }
    requireFiniteNumber(entry, 'principal', path, errors);
    requireFiniteNumber(entry, 'outstanding', path, errors);
    requireFiniteNumber(entry, 'paidPrincipal', path, errors);
    requireFiniteNumber(entry, 'paidInterest', path, errors);
    requireString(entry, 'status', path, errors);
    // payments 是逐期还款流水（审计；上限 60），允许为空但必须是数组。
    expectArray(entry.payments, `${path}.payments`, errors);
  });
  checkEntries(banking.snapshots, 'banking.snapshots', errors, (entry, path) => {
    requireFiniteNumber(entry, 'tick', path, errors);
    const borrower = expectRecord(entry.borrower, `${path}.borrower`, errors);
    if (borrower) {
      requireNonEmptyString(borrower, 'kind', `${path}.borrower`, errors);
      requireNonEmptyString(borrower, 'id', `${path}.borrower`, errors);
    }
    requireFiniteNumber(entry, 'limit', path, errors);
    requireFiniteNumber(entry, 'outstanding', path, errors);
  });
  const lastMonth = expectRecord(banking.lastMonth, 'banking.lastMonth', errors);
  if (lastMonth) {
    for (const key of [
      'tick',
      'interestExpense',
      'interestIncome',
      'principalIssued',
      'principalRepaid',
      'depositsTotal',
      'loansOutstanding',
      'newDefaults',
    ]) {
      requireFiniteNumber(lastMonth, key, 'banking.lastMonth', errors);
    }
    requireString(lastMonth, 'note', 'banking.lastMonth', errors);
  }
  requirePositiveInteger(banking, 'nextAccountNumber', 'banking', errors);
  requirePositiveInteger(banking, 'nextLoanNumber', 'banking', errors);
}

export const bankingSaveModule: SaveModule<BankingSaveData> = {
  id: 'banking',
  version: BANKING_SAVE_MODULE_VERSION,
  required: true,
  ownedPaths: ['banking'],
  dependsOn: ['world'],

  export(context: SaveExportContext): BankingSaveData {
    if (!isRecord(context.world.banking)) {
      throw new Error('世界缺少 banking 状态，无法导出银行存档模块');
    }
    return { banking: cloneJson(context.world.banking) };
  },

  validate(data: unknown, version: number): SaveModuleValidation {
    if (version !== BANKING_SAVE_MODULE_VERSION) {
      return {
        ok: false,
        errors: [
          `banking 模块数据版本不受支持：${version}（当前支持 ${BANKING_SAVE_MODULE_VERSION}）`,
        ],
      };
    }
    if (!isRecord(data)) {
      return { ok: false, errors: ['banking 模块数据必须是对象'] };
    }
    const errors: string[] = [];
    validateBankingState(data.banking, errors);
    return { ok: errors.length === 0, errors };
  },

  migrate(data: unknown, context: SaveModuleMigrationContext): BankingSaveData {
    if (context.fromVersion === 0) {
      // 必需模块缺失 = 存档损坏：银行账本无法从世界信息安全重建（不得凭空造钱）。
      throw new Error('存档缺少必需的 banking 模块：无法安全重建银行账本');
    }
    if (context.fromVersion === BANKING_SAVE_MODULE_VERSION) {
      return data as BankingSaveData;
    }
    throw new Error(
      `不支持的 banking 模块版本迁移：${context.fromVersion} → ${BANKING_SAVE_MODULE_VERSION}`,
    );
  },

  restore(data: BankingSaveData, context: SaveRestoreContext): void {
    if (!isRecord(data) || !isRecord(data.banking)) {
      throw new Error('banking 模块数据缺少 banking');
    }
    // 恢复为独立副本：候选世界不得与存档数据（moduleData/未知保留模块）共享引用。
    context.world.banking = cloneJson(data.banking);
  },
};
