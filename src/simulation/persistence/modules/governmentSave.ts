/**
 * v1.7 存档模块：城市财政与政府（government）。
 *
 * 数据归属依据 /tmp/save-ownership-b.md §1 与 docs/development/SAVE_SYSTEM_DESIGN.md §2.7：
 * - `cities[].treasury` 是政府唯一现金（不存在政府存款副本）；
 * - `cities[].incomeTaxRate/corporateTaxRate/unemploymentBenefit/nonLaborTransfer` 是政策可改的权威税率；
 * - `cities[].fiscalExpenseBaseline` 是 AI 发债分母（派生缓存，但被下月规则读取）；
 * - `cities[].government` 是政府银行债务/应付项/垫付/破产的唯一权威账本；
 * - `cities[].gdpWindow`（12 月判定窗口）与 `gdpEstimate`（开局估计说明）；
 * - `cities[].bankruptcy` 是 `government.bankruptcy` 的派生镜像（恢复时以权威为准覆盖）；
 * - `fiscal` 财政流水（余额不在账本）、`taxes` 本月累计 + 12 月历史、`policies` 政策状态与规则窗口。
 *
 * `cities[].gdpHistory` 归 world 模块（展示历史），此处不保存。
 * export 只读世界并返回纯数据；restore 按 `context.cityOf(id)` 写回城市字段，其余顶层字段直接赋值。
 */

import type {
  CityBankruptcyState,
  CityGdpPoint,
  CityGovernmentState,
  FiscalState,
  GdpEstimateInfo,
  PolicyState,
  TaxState,
} from '../../contracts/types';
import type {
  SaveExportContext,
  SaveModule,
  SaveModuleMigrationContext,
  SaveModuleValidation,
  SaveRestoreContext,
} from '../types';

/** 模块数据版本：字段变化时递增（当前 v10 存档统一为 1）。 */
export const GOVERNMENT_SAVE_MODULE_VERSION = 1;

/** 单城财政数据：以 `id` 关联候选世界的城市对象。 */
export interface GovernmentSaveCityData {
  id: string;
  treasury: number;
  incomeTaxRate: number;
  corporateTaxRate: number;
  unemploymentBenefit: number;
  nonLaborTransfer: number;
  fiscalExpenseBaseline?: number;
  government: CityGovernmentState;
  gdpWindow: CityGdpPoint[];
  gdpEstimate: GdpEstimateInfo | null;
  bankruptcy?: CityBankruptcyState;
}

export interface GovernmentSaveData {
  cities: GovernmentSaveCityData[];
  fiscal: FiscalState;
  taxes: TaxState;
  policies: PolicyState;
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

function requireOptionalFiniteNumber(
  record: UnknownRecord,
  key: string,
  path: string,
  errors: string[],
): void {
  const value = record[key];
  if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) {
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

function validateGovernmentState(value: unknown, path: string, errors: string[]): void {
  const government = expectRecord(value, path, errors);
  if (!government) return;
  checkEntries(government.loans, `${path}.loans`, errors, (entry, entryPath) => {
    requireNonEmptyString(entry, 'id', entryPath, errors);
    requireNonEmptyString(entry, 'cityId', entryPath, errors);
    requireFiniteNumber(entry, 'principal', entryPath, errors);
    requireFiniteNumber(entry, 'outstanding', entryPath, errors);
    requireString(entry, 'status', entryPath, errors);
  });
  checkEntries(government.payables, `${path}.payables`, errors, (entry, entryPath) => {
    requireNonEmptyString(entry, 'id', entryPath, errors);
    requireNonEmptyString(entry, 'cityId', entryPath, errors);
    requireFiniteNumber(entry, 'tick', entryPath, errors);
    requireString(entry, 'kind', entryPath, errors);
    requireFiniteNumber(entry, 'principalDue', entryPath, errors);
    requireFiniteNumber(entry, 'interestDue', entryPath, errors);
    requireString(entry, 'status', entryPath, errors);
  });
  checkEntries(government.advances, `${path}.advances`, errors, (entry, entryPath) => {
    requireNonEmptyString(entry, 'id', entryPath, errors);
    requireNonEmptyString(entry, 'cityId', entryPath, errors);
    requireFiniteNumber(entry, 'tick', entryPath, errors);
    requireNonEmptyString(entry, 'issuanceId', entryPath, errors);
    requireFiniteNumber(entry, 'principalAdvanced', entryPath, errors);
    requireFiniteNumber(entry, 'interestAdvanced', entryPath, errors);
    requireFiniteNumber(entry, 'totalAdvanced', entryPath, errors);
  });
  checkEntries(government.records, `${path}.records`, errors, (entry, entryPath) => {
    requireNonEmptyString(entry, 'id', entryPath, errors);
    requireNonEmptyString(entry, 'cityId', entryPath, errors);
    requireString(entry, 'note', entryPath, errors);
  });
  expectArray(government.settledTicks, `${path}.settledTicks`, errors);
  if (Array.isArray(government.settledTicks)) {
    government.settledTicks.forEach((tick, index) => {
      if (typeof tick !== 'number' || !Number.isFinite(tick)) {
        errors.push(`${path}.settledTicks[${index}] 必须是有限数字`);
      }
    });
  }
  requirePositiveInteger(government, 'nextLoanNumber', path, errors);
  requirePositiveInteger(government, 'nextPayableNumber', path, errors);
  requirePositiveInteger(government, 'nextAdvanceNumber', path, errors);
  const bankruptcy = expectRecord(government.bankruptcy, `${path}.bankruptcy`, errors);
  if (bankruptcy) {
    requireString(bankruptcy, 'status', `${path}.bankruptcy`, errors);
    const tick = bankruptcy.tick;
    if (tick !== null && (typeof tick !== 'number' || !Number.isFinite(tick))) {
      errors.push(`${path}.bankruptcy.tick 必须是有限数字或 null`);
    }
  }
  const lastDebt = government.lastDebt;
  if (lastDebt !== null && !isRecord(lastDebt)) {
    errors.push(`${path}.lastDebt 必须是对象或 null`);
  }
}

function validateFiscalState(value: unknown, errors: string[]): void {
  const fiscal = expectRecord(value, 'fiscal', errors);
  if (!fiscal) return;
  checkEntries(fiscal.ledger, 'fiscal.ledger', errors, (entry, path) => {
    requireNonEmptyString(entry, 'id', path, errors);
    requireFiniteNumber(entry, 'tick', path, errors);
    requireNonEmptyString(entry, 'cityId', path, errors);
    requireNonEmptyString(entry, 'kind', path, errors);
    requireFiniteNumber(entry, 'amount', path, errors);
    requireString(entry, 'source', path, errors);
  });
  requirePositiveInteger(fiscal, 'nextEntryId', 'fiscal', errors);
}

function validateTaxesState(value: unknown, errors: string[]): void {
  const taxes = expectRecord(value, 'taxes', errors);
  if (!taxes) return;
  const accrual = expectRecord(taxes.accrualByCity, 'taxes.accrualByCity', errors);
  if (accrual) {
    for (const [cityId, entry] of Object.entries(accrual)) {
      const path = `taxes.accrualByCity.${cityId}`;
      if (!isRecord(entry)) {
        errors.push(`${path} 必须是对象`);
        continue;
      }
      requireFiniteNumber(entry, 'consumptionTax', path, errors);
      requireFiniteNumber(entry, 'dividendTax', path, errors);
    }
  }
  const history = expectRecord(taxes.historyByCity, 'taxes.historyByCity', errors);
  if (history) {
    for (const [cityId, entries] of Object.entries(history)) {
      checkEntries(entries, `taxes.historyByCity.${cityId}`, errors, (entry, path) => {
        requireFiniteNumber(entry, 'tick', path, errors);
        requireFiniteNumber(entry, 'totalRevenue', path, errors);
        requireFiniteNumber(entry, 'totalBase', path, errors);
      });
    }
  }
}

function validatePoliciesState(value: unknown, errors: string[]): void {
  const policies = expectRecord(value, 'policies', errors);
  if (!policies) return;
  checkEntries(policies.active, 'policies.active', errors, (entry, path) => {
    requireNonEmptyString(entry, 'id', path, errors);
    requireNonEmptyString(entry, 'cityId', path, errors);
    requireNonEmptyString(entry, 'policyId', path, errors);
    requireFiniteNumber(entry, 'budget', path, errors);
    requireFiniteNumber(entry, 'spent', path, errors);
    requireString(entry, 'status', path, errors);
  });
  checkEntries(policies.history, 'policies.history', errors, (entry, path) => {
    requireNonEmptyString(entry, 'id', path, errors);
    requireNonEmptyString(entry, 'cityId', path, errors);
    requireNonEmptyString(entry, 'policyId', path, errors);
    requireFiniteNumber(entry, 'endedTick', path, errors);
  });
  checkEntries(policies.lastRuns, 'policies.lastRuns', errors, (entry, path) => {
    requireNonEmptyString(entry, 'cityId', path, errors);
    requireNonEmptyString(entry, 'policyId', path, errors);
    requireFiniteNumber(entry, 'tick', path, errors);
  });
  checkEntries(policies.lastSelection, 'policies.lastSelection', errors, (entry, path) => {
    requireFiniteNumber(entry, 'tick', path, errors);
    requireNonEmptyString(entry, 'cityId', path, errors);
  });
  for (const key of ['checkups', 'fundingMonths', 'publicJobsMonths'] as const) {
    const optional = policies[key];
    if (optional !== undefined) expectArray(optional, `policies.${key}`, errors);
  }
}

function validateCityData(value: unknown, errors: string[], seenIds: Set<string>): void {
  if (!isRecord(value)) {
    errors.push('cities[] 存在非对象条目');
    return;
  }
  const id = value.id;
  if (typeof id !== 'string' || id.length === 0) {
    errors.push('cities[].id 必须是非空字符串');
    return;
  }
  if (seenIds.has(id)) errors.push(`cities[] 存在重复城市 ID：${id}`);
  seenIds.add(id);
  const path = `cities.${id}`;
  requireFiniteNumber(value, 'treasury', path, errors);
  requireFiniteNumber(value, 'incomeTaxRate', path, errors);
  requireFiniteNumber(value, 'corporateTaxRate', path, errors);
  requireFiniteNumber(value, 'unemploymentBenefit', path, errors);
  requireFiniteNumber(value, 'nonLaborTransfer', path, errors);
  requireOptionalFiniteNumber(value, 'fiscalExpenseBaseline', path, errors);
  validateGovernmentState(value.government, `${path}.government`, errors);
  checkEntries(value.gdpWindow, `${path}.gdpWindow`, errors, (entry, entryPath) => {
    requireFiniteNumber(entry, 'tick', entryPath, errors);
    requireFiniteNumber(entry, 'value', entryPath, errors);
    if (typeof entry.estimated !== 'boolean') {
      errors.push(`${entryPath}.estimated 必须是布尔值`);
    }
  });
  if (value.gdpEstimate !== null) {
    const estimate = expectRecord(value.gdpEstimate, `${path}.gdpEstimate`, errors);
    if (estimate) {
      requireFiniteNumber(estimate, 'monthlyValue', `${path}.gdpEstimate`, errors);
      requireFiniteNumber(estimate, 'annualValue', `${path}.gdpEstimate`, errors);
    }
  }
  if (value.bankruptcy !== undefined) {
    const mirror = expectRecord(value.bankruptcy, `${path}.bankruptcy`, errors);
    if (mirror) requireString(mirror, 'status', `${path}.bankruptcy`, errors);
  }
}

export const governmentSaveModule: SaveModule<GovernmentSaveData> = {
  id: 'government',
  version: GOVERNMENT_SAVE_MODULE_VERSION,
  required: true,
  ownedPaths: [
    'cities[].treasury',
    'cities[].incomeTaxRate',
    'cities[].corporateTaxRate',
    'cities[].unemploymentBenefit',
    'cities[].nonLaborTransfer',
    'cities[].fiscalExpenseBaseline',
    'cities[].government',
    'cities[].gdpWindow',
    'cities[].gdpEstimate',
    'cities[].bankruptcy',
    'fiscal',
    'taxes',
    'policies',
  ],
  dependsOn: ['world'],

  export(context: SaveExportContext): GovernmentSaveData {
    const { world } = context;
    return {
      cities: world.cities.map((city) => ({
        id: city.id,
        treasury: city.treasury,
        incomeTaxRate: city.incomeTaxRate,
        corporateTaxRate: city.corporateTaxRate,
        unemploymentBenefit: city.unemploymentBenefit,
        nonLaborTransfer: city.nonLaborTransfer,
        ...(city.fiscalExpenseBaseline === undefined
          ? {}
          : { fiscalExpenseBaseline: city.fiscalExpenseBaseline }),
        government: cloneJson(city.government),
        gdpWindow: cloneJson(city.gdpWindow),
        gdpEstimate: city.gdpEstimate === null ? null : cloneJson(city.gdpEstimate),
        ...(city.bankruptcy === undefined ? {} : { bankruptcy: cloneJson(city.bankruptcy) }),
      })),
      fiscal: cloneJson(world.fiscal),
      taxes: cloneJson(world.taxes),
      policies: cloneJson(world.policies),
    };
  },

  validate(data: unknown, version: number): SaveModuleValidation {
    if (version !== GOVERNMENT_SAVE_MODULE_VERSION) {
      return {
        ok: false,
        errors: [
          `government 模块数据版本不受支持：${version}（当前支持 ${GOVERNMENT_SAVE_MODULE_VERSION}）`,
        ],
      };
    }
    if (!isRecord(data)) {
      return { ok: false, errors: ['government 模块数据必须是对象'] };
    }
    const errors: string[] = [];
    const cities = expectArray(data.cities, 'cities', errors);
    if (cities) {
      const seenIds = new Set<string>();
      for (const city of cities) validateCityData(city, errors, seenIds);
    }
    validateFiscalState(data.fiscal, errors);
    validateTaxesState(data.taxes, errors);
    validatePoliciesState(data.policies, errors);
    return { ok: errors.length === 0, errors };
  },

  migrate(data: unknown, context: SaveModuleMigrationContext): GovernmentSaveData {
    if (context.fromVersion === 0) {
      // 必需模块缺失 = 存档损坏：财政/债务/政策无法从世界信息安全重建（不得凭空造钱）。
      throw new Error('存档缺少必需的 government 模块：无法安全重建城市财政与政府债务账本');
    }
    if (context.fromVersion === GOVERNMENT_SAVE_MODULE_VERSION) {
      return data as GovernmentSaveData;
    }
    throw new Error(
      `不支持的 government 模块版本迁移：${context.fromVersion} → ${GOVERNMENT_SAVE_MODULE_VERSION}`,
    );
  },

  restore(data: GovernmentSaveData, context: SaveRestoreContext): void {
    if (!isRecord(data) || !Array.isArray(data.cities)) {
      throw new Error('government 模块数据缺少 cities 数组');
    }
    for (const entry of data.cities) {
      const city = context.cityOf(entry.id);
      city.treasury = entry.treasury;
      city.incomeTaxRate = entry.incomeTaxRate;
      city.corporateTaxRate = entry.corporateTaxRate;
      city.unemploymentBenefit = entry.unemploymentBenefit;
      city.nonLaborTransfer = entry.nonLaborTransfer;
      city.fiscalExpenseBaseline = entry.fiscalExpenseBaseline;
      city.government = cloneJson(entry.government);
      city.gdpWindow = cloneJson(entry.gdpWindow);
      city.gdpEstimate = entry.gdpEstimate === null ? null : cloneJson(entry.gdpEstimate);
      // city.bankruptcy 是 government.bankruptcy 的派生镜像：以权威账本为准恢复；
      // 若存档镜像与权威不一致，保留权威并记录提示（派生值不得覆盖权威）。
      const authoritativeBankruptcy = city.government.bankruptcy;
      const storedMirror = entry.bankruptcy;
      if (
        storedMirror !== undefined &&
        authoritativeBankruptcy !== undefined &&
        JSON.stringify(storedMirror) !== JSON.stringify(authoritativeBankruptcy)
      ) {
        context.warn(
          `城市 ${entry.id} 的 city.bankruptcy 与 government.bankruptcy 不一致，已按权威账本恢复`,
        );
      }
      city.bankruptcy =
        authoritativeBankruptcy === undefined
          ? storedMirror === undefined
            ? undefined
            : cloneJson(storedMirror)
          : cloneJson(authoritativeBankruptcy);
    }
    context.world.fiscal = cloneJson(data.fiscal);
    context.world.taxes = cloneJson(data.taxes);
    context.world.policies = cloneJson(data.policies);
  },
};
