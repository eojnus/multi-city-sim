/**
 * v1.7 存档模块：经营者与玩家经营状态（management）。
 *
 * 数据归属依据 /tmp/save-ownership-b.md §1 与 docs/development/SAVE_SYSTEM_DESIGN.md §2.10：
 * - `management.operators`：职业经理人档案、在职状态与履历（履历上限 20，历史允许公司已退出）；
 * - `management.playerOperations`：玩家经营模式/授权/standedPlan/提案（模式唯一权威）；
 * - `management.nextOperatorNumber`：经营者编号计数（权威，不得重排）。
 *
 * 经营者 `companyId` 为 null/离职合法；履历中 companyId 允许引用已退出企业（历史例外）。
 */

import type { ManagementState } from '../../contracts/types';
import type {
  SaveExportContext,
  SaveModule,
  SaveModuleMigrationContext,
  SaveModuleValidation,
  SaveRestoreContext,
} from '../types';

/** 模块数据版本：字段变化时递增（当前 v10 存档统一为 1）。 */
export const MANAGEMENT_SAVE_MODULE_VERSION = 1;

export interface ManagementSaveData {
  management: ManagementState;
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

function requireNullableFiniteNumber(
  record: UnknownRecord,
  key: string,
  path: string,
  errors: string[],
): void {
  const value = record[key];
  if (value !== null && (typeof value !== 'number' || !Number.isFinite(value))) {
    errors.push(`${path}.${key} 必须是有限数字或 null`);
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

function validateManagementState(value: unknown, errors: string[]): void {
  const management = expectRecord(value, 'management', errors);
  if (!management) return;
  checkEntries(management.operators, 'management.operators', errors, (entry, path) => {
    requireNonEmptyString(entry, 'id', path, errors);
    requireNonEmptyString(entry, 'name', path, errors);
    if (entry.status !== 'employed' && entry.status !== 'available') {
      errors.push(`${path}.status 非法：${String(entry.status)}`);
    }
    const companyId = entry.companyId;
    if (companyId !== null && (typeof companyId !== 'string' || companyId.length === 0)) {
      errors.push(`${path}.companyId 必须是非空字符串或 null`);
    }
    requireNullableFiniteNumber(entry, 'appointedTick', path, errors);
    requireNullableFiniteNumber(entry, 'termEndTick', path, errors);
    checkEntries(entry.history, `${path}.history`, errors, (tenure, tenurePath) => {
      // 履历中的企业允许已退出：只检查字段类型，不做存在性校验。
      requireString(tenure, 'companyId', tenurePath, errors);
      requireString(tenure, 'companyName', tenurePath, errors);
      requireFiniteNumber(tenure, 'fromTick', tenurePath, errors);
      requireFiniteNumber(tenure, 'toTick', tenurePath, errors);
      requireString(tenure, 'reason', tenurePath, errors);
    });
  });
  checkEntries(management.playerOperations, 'management.playerOperations', errors, (entry, path) => {
    requireNonEmptyString(entry, 'companyId', path, errors);
    if (entry.mode !== 'manual' && entry.mode !== 'assisted' && entry.mode !== 'delegated') {
      errors.push(`${path}.mode 非法：${String(entry.mode)}`);
    }
    const authorization = expectRecord(entry.authorization, `${path}.authorization`, errors);
    if (authorization) {
      for (const key of [
        'maxInvestmentPerMonth',
        'maxHiresPerMonth',
        'maxLoanAmount',
      ] as const) {
        requireFiniteNumber(authorization, key, `${path}.authorization`, errors);
      }
      for (const key of [
        'allowInvestment',
        'allowHiring',
        'allowLoan',
        'allowPriceAdjust',
      ] as const) {
        if (typeof authorization[key] !== 'boolean') {
          errors.push(`${path}.authorization.${key} 必须是布尔值`);
        }
      }
    }
    if (entry.standingPlan !== null && !isRecord(entry.standingPlan)) {
      errors.push(`${path}.standingPlan 必须是对象或 null`);
    }
    checkEntries(entry.proposals, `${path}.proposals`, errors, (proposal, proposalPath) => {
      requireNonEmptyString(proposal, 'id', proposalPath, errors);
      requireNonEmptyString(proposal, 'companyId', proposalPath, errors);
      requireString(proposal, 'status', proposalPath, errors);
      requireFiniteNumber(proposal, 'createdTick', proposalPath, errors);
    });
    requireFiniteNumber(entry, 'lastExecutedTick', path, errors);
  });
  requirePositiveInteger(management, 'nextOperatorNumber', 'management', errors);
}

export const managementSaveModule: SaveModule<ManagementSaveData> = {
  id: 'management',
  version: MANAGEMENT_SAVE_MODULE_VERSION,
  required: true,
  ownedPaths: ['management'],
  dependsOn: ['world'],

  export(context: SaveExportContext): ManagementSaveData {
    if (!isRecord(context.world.management)) {
      throw new Error('世界缺少 management 状态，无法导出经营者存档模块');
    }
    return { management: cloneJson(context.world.management) };
  },

  validate(data: unknown, version: number): SaveModuleValidation {
    if (version !== MANAGEMENT_SAVE_MODULE_VERSION) {
      return {
        ok: false,
        errors: [
          `management 模块数据版本不受支持：${version}（当前支持 ${MANAGEMENT_SAVE_MODULE_VERSION}）`,
        ],
      };
    }
    if (!isRecord(data)) {
      return { ok: false, errors: ['management 模块数据必须是对象'] };
    }
    const errors: string[] = [];
    validateManagementState(data.management, errors);
    return { ok: errors.length === 0, errors };
  },

  migrate(data: unknown, context: SaveModuleMigrationContext): ManagementSaveData {
    if (context.fromVersion === 0) {
      // 必需模块缺失 = 存档损坏：经营者/玩家授权状态无法凭空重建。
      throw new Error('存档缺少必需的 management 模块：无法安全重建经营者与玩家经营状态');
    }
    if (context.fromVersion === MANAGEMENT_SAVE_MODULE_VERSION) {
      return data as ManagementSaveData;
    }
    throw new Error(
      `不支持的 management 模块版本迁移：${context.fromVersion} → ${MANAGEMENT_SAVE_MODULE_VERSION}`,
    );
  },

  restore(data: ManagementSaveData, context: SaveRestoreContext): void {
    if (!isRecord(data) || !isRecord(data.management)) {
      throw new Error('management 模块数据缺少 management');
    }
    context.world.management = cloneJson(data.management);
  },
};
