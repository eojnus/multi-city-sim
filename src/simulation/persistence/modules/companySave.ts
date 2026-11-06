/**
 * v1.7 存档系统：company 模块。
 *
 * 归属：
 * - `companies`：企业原子聚合（现金、库存与账面成本、设备台数与产能缓存、计划/AI 决策状态、
 *   月度统计等）。企业是权威聚合：员工、设备、库存、现金不拆到其他模块，避免跨模块部分快照
 *   出现“半家企业”。企业债务/已发行股份/玩家持股等镜像仍由 banking/securities 同步后修复。
 * - `lifecycle`：企业成立与清算记录（含序号计数权威）。
 *
 * 恢复依赖 world（候选世界由其建立）；本模块只整对象写回 companies/lifecycle，不逐字段拆写。
 */

import { GOOD_IDS } from '../../companies/company';
import type {
  Company,
  CompanyLifecycleState,
  EquipmentAssets,
  LiquidationRecord,
} from '../../contracts/types';
import type {
  SaveExportContext,
  SaveModule,
  SaveModuleMigrationContext,
  SaveModuleValidation,
  SaveRestoreContext,
} from '../types';

/** company 模块数据版本。 */
export const COMPANY_SAVE_MODULE_VERSION = 1;

export interface CompanySaveData {
  companies: Company[];
  lifecycle: CompanyLifecycleState;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

/** 深拷贝（存档数据均为 JSON 可序列化纯数据；JSON 口径与落盘一致）。 */
function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const ROLE_KEYS = ['management', 'production', 'sales', 'research'] as const;
const EQUIPMENT_KINDS = ['farm', 'industry', 'energy'] as const;
const EQUIPMENT_KIND_SET = new Set<string>(EQUIPMENT_KINDS);
const SECTOR_IDS = new Set([
  'agriculture',
  'fiber-farm',
  'textile',
  'food',
  'garment',
  'metal',
  'utility',
  'appliance',
  'equipment',
]);
const COMPANY_STYLES = new Set(['growth', 'steady', 'return']);
const FOUNDER_TYPES = new Set(['investorGroup', 'company', 'government']);
const HOLDER_TYPES = new Set(['player', 'company', 'investorGroup', 'city', 'operator', 'trust']);
const GOOD_ID_SET = new Set<string>(GOOD_IDS);

/** 企业月度统计的必填数值字段（CompanyMonthlyStats）。 */
const COMPANY_STATS_REQUIRED_NUMBERS = [
  'revenue',
  'inputCost',
  'wagesPaid',
  'wageArrears',
  'interestPaid',
  'corporateTax',
  'dividendsPaid',
  'profit',
  'produced',
  'sold',
  'exported',
  'unmetDemand',
  'capacityChange',
  'dividendIncome',
] as const;

/** 企业月度统计的可选数值字段：缺省合法，出现时必须为有限数值。 */
const COMPANY_STATS_OPTIONAL_NUMBERS = [
  'bonusPaid',
  'equipmentPurchased',
  'equipmentSold',
  'emergencyLayoffs',
  'operatingCashFlow',
  'cogs',
  'inventoryWriteOff',
  'refundGain',
  'maintenanceDue',
  'maintenancePaid',
  'maintenanceArrearsAdded',
  'maintenanceArrearsRepaid',
  'maintenanceArrears',
] as const;

/** 结构校验收集器：一次收集全部错误，便于定位损坏字段。 */
class ShapeCheck {
  readonly errors: string[] = [];

  fail(message: string): void {
    this.errors.push(message);
  }

  object(value: unknown, path: string): UnknownRecord | null {
    if (!isRecord(value)) {
      this.fail(`${path} 必须是对象`);
      return null;
    }
    return value;
  }

  array(value: unknown, path: string): unknown[] | null {
    if (!Array.isArray(value)) {
      this.fail(`${path} 必须是数组`);
      return null;
    }
    return value;
  }

  number(value: unknown, path: string): void {
    if (!isFiniteNumber(value)) this.fail(`${path} 必须是有限数值`);
  }

  integer(value: unknown, path: string): void {
    if (!isInteger(value)) this.fail(`${path} 必须是整数`);
  }

  text(value: unknown, path: string): void {
    if (typeof value !== 'string') this.fail(`${path} 必须是字符串`);
  }

  boolean(value: unknown, path: string): void {
    if (typeof value !== 'boolean') this.fail(`${path} 必须是布尔值`);
  }

  numbers(record: UnknownRecord, keys: readonly string[], path: string): void {
    for (const key of keys) this.number(record[key], `${path}.${key}`);
  }

  optionalNumbers(record: UnknownRecord, keys: readonly string[], path: string): void {
    for (const key of keys) {
      if (record[key] === undefined) continue;
      this.number(record[key], `${path}.${key}`);
    }
  }

  texts(record: UnknownRecord, keys: readonly string[], path: string): void {
    for (const key of keys) this.text(record[key], `${path}.${key}`);
  }

  stringArray(value: unknown, path: string): void {
    const array = this.array(value, path);
    if (!array) return;
    for (const [index, entry] of array.entries()) this.text(entry, `${path}[${index}]`);
  }
}

function validateEquipmentAssets(check: ShapeCheck, value: unknown, path: string): void {
  const assets = check.object(value, path);
  if (!assets) return;
  check.numbers(assets, EQUIPMENT_KINDS, path);
}

function validateInitialEquipmentGrant(check: ShapeCheck, value: unknown, path: string): void {
  const grant = check.object(value, path);
  if (!grant) return;
  if (typeof grant.kind !== 'string' || !EQUIPMENT_KIND_SET.has(grant.kind)) {
    check.fail(`${path}.kind 必须是 farm/industry/energy`);
  }
  check.numbers(grant, ['units', 'valuation', 'grantedTick', 'lockUntilTick'], path);
  if (grant.source !== 'founderInKind') check.fail(`${path}.source 必须是 founderInKind`);
}

function validateInitialEquipmentReturned(check: ShapeCheck, value: unknown, path: string): void {
  const returned = check.object(value, path);
  if (!returned) return;
  if (typeof returned.kind !== 'string' || !EQUIPMENT_KIND_SET.has(returned.kind)) {
    check.fail(`${path}.kind 必须是 farm/industry/energy`);
  }
  check.numbers(returned, ['units', 'valuation'], path);
}

function validateCompanyMonthlyStats(check: ShapeCheck, value: unknown, path: string): void {
  const stats = check.object(value, path);
  if (!stats) return;
  check.numbers(stats, COMPANY_STATS_REQUIRED_NUMBERS, path);
  check.optionalNumbers(stats, COMPANY_STATS_OPTIONAL_NUMBERS, path);
}

function validateAiPlan(check: ShapeCheck, value: unknown, path: string): void {
  const plan = check.object(value, path);
  if (!plan) return;
  check.number(plan.tick, `${path}.tick`);
  if (typeof plan.style !== 'string' || !COMPANY_STYLES.has(plan.style)) {
    check.fail(`${path}.style 必须是 growth/steady/return`);
  }
  check.numbers(
    plan,
    [
      'utilization',
      'targetJobs',
      'expectedWageCost',
      'hiringSubsidyPerHire',
      'retentionSubsidyPerEmployee',
      'investment',
    ],
    path,
  );
  check.stringArray(plan.reasons, `${path}.reasons`);
}

function validateProductionPlan(check: ShapeCheck, value: unknown, path: string): void {
  const plan = check.object(value, path);
  if (!plan) return;
  check.numbers(
    plan,
    [
      'tick',
      'salesReference',
      'targetInventory',
      'equipmentLimit',
      'laborLimit',
      'plannedOutput',
      'plannedJobs',
    ],
    path,
  );
  check.boolean(plan.emergency, `${path}.emergency`);
  check.optionalNumbers(plan, ['reachableDemand', 'latentDemand', 'maintenanceCost'], path);
  check.stringArray(plan.reasons, `${path}.reasons`);
}

function validateCompanyAi(check: ShapeCheck, value: unknown, path: string): void {
  const ai = check.object(value, path);
  if (!ai) return;
  if (typeof ai.style !== 'string' || !COMPANY_STYLES.has(ai.style)) {
    check.fail(`${path}.style 必须是 growth/steady/return`);
  }
  check.numbers(ai, ['riskTolerance', 'lossMonths', 'ageMonths'], path);
  if (ai.idleMonths !== undefined) check.number(ai.idleMonths, `${path}.idleMonths`);
  if (ai.lastPlan !== null) validateAiPlan(check, ai.lastPlan, `${path}.lastPlan`);
  check.text(ai.lastDecision, `${path}.lastDecision`);
  check.number(ai.lastDecisionTick, `${path}.lastDecisionTick`);
}

function validateCompany(check: ShapeCheck, value: unknown, index: number): void {
  const path = `companies[${index}]`;
  const company = check.object(value, path);
  if (!company) return;
  check.texts(company, ['id', 'name', 'cityId', 'note'], path);
  if (typeof company.sector !== 'string' || !SECTOR_IDS.has(company.sector)) {
    check.fail(`${path}.sector 必须是合法行业`);
  }
  if (typeof company.recipeOutput !== 'string' || !GOOD_ID_SET.has(company.recipeOutput)) {
    check.fail(`${path}.recipeOutput 必须是合法商品`);
  }
  check.numbers(
    company,
    [
      'cash',
      'debt',
      'capacity',
      'baseCapacity',
      'maxCapacity',
      'utilization',
      'employees',
      'baseWageBill',
      'jobDemand',
      'wageRate',
      'priceFactor',
      'totalShares',
      'dividendPayoutRatio',
    ],
    path,
  );

  const roles = check.object(company.roles, `${path}.roles`);
  if (roles) check.numbers(roles, ROLE_KEYS, `${path}.roles`);

  const inventory = check.object(company.inventory, `${path}.inventory`);
  if (inventory) check.numbers(inventory, GOOD_IDS, `${path}.inventory`);
  if (company.inventoryCost !== undefined) {
    const inventoryCost = check.object(company.inventoryCost, `${path}.inventoryCost`);
    if (inventoryCost) {
      for (const [goodId, cost] of Object.entries(inventoryCost)) {
        if (!GOOD_ID_SET.has(goodId)) check.fail(`${path}.inventoryCost 含未知商品 ${goodId}`);
        check.number(cost, `${path}.inventoryCost.${goodId}`);
      }
    }
  }

  validateCompanyMonthlyStats(check, company.lastMonth, `${path}.lastMonth`);
  validateCompanyMonthlyStats(check, company.previousMonth, `${path}.previousMonth`);

  validateCompanyAi(check, company.ai, `${path}.ai`);

  validateEquipmentAssets(check, company.equipment, `${path}.equipment`);
  check.number(company.equipmentCapacity, `${path}.equipmentCapacity`);
  if (company.equipmentCapacityRemainder !== undefined) {
    check.number(company.equipmentCapacityRemainder, `${path}.equipmentCapacityRemainder`);
  }
  if (company.maintenanceBase !== undefined) {
    validateEquipmentAssets(check, company.maintenanceBase, `${path}.maintenanceBase`);
  }
  if (company.maintenancePrices !== undefined) {
    validateEquipmentAssets(check, company.maintenancePrices, `${path}.maintenancePrices`);
  }
  if (company.maintenanceArrears !== undefined) {
    check.number(company.maintenanceArrears, `${path}.maintenanceArrears`);
  }

  if (!Array.isArray(company.salesHistory)) {
    check.fail(`${path}.salesHistory 必须是数组`);
  } else {
    for (const [entryIndex, entry] of company.salesHistory.entries()) {
      check.number(entry, `${path}.salesHistory[${entryIndex}]`);
    }
  }
  if (!Array.isArray(company.recentProfits)) {
    check.fail(`${path}.recentProfits 必须是数组`);
  } else {
    for (const [entryIndex, entry] of company.recentProfits.entries()) {
      check.number(entry, `${path}.recentProfits[${entryIndex}]`);
    }
  }
  if (company.productionPlan !== null) {
    validateProductionPlan(check, company.productionPlan, `${path}.productionPlan`);
  }

  if (company.initialEquipment !== undefined) {
    validateInitialEquipmentGrant(check, company.initialEquipment, `${path}.initialEquipment`);
  }
}

function validateFoundingRecord(check: ShapeCheck, value: unknown, index: number): void {
  const path = `lifecycle.foundings[${index}]`;
  const record = check.object(value, path);
  if (!record) return;
  check.texts(record, ['id', 'cityId', 'companyId', 'companyName', 'note'], path);
  check.integer(record.tick, `${path}.tick`);
  if (typeof record.sector !== 'string' || !SECTOR_IDS.has(record.sector)) {
    check.fail(`${path}.sector 必须是合法行业`);
  }
  if (typeof record.recipeOutput !== 'string' || !GOOD_ID_SET.has(record.recipeOutput)) {
    check.fail(`${path}.recipeOutput 必须是合法商品`);
  }
  if (typeof record.founderType !== 'string' || !FOUNDER_TYPES.has(record.founderType)) {
    check.fail(`${path}.founderType 必须是 investorGroup/company/government`);
  }
  check.numbers(record, ['capital', 'investorCount', 'governmentGrant'], path);
  const investors = check.array(record.investors, `${path}.investors`);
  if (investors) {
    for (const [investorIndex, investor] of investors.entries()) {
      const investorPath = `${path}.investors[${investorIndex}]`;
      const entry = check.object(investor, investorPath);
      if (!entry) continue;
      if (typeof entry.type !== 'string' || !FOUNDER_TYPES.has(entry.type)) {
        check.fail(`${investorPath}.type 必须是合法创办者类型`);
      }
      check.text(entry.id, `${investorPath}.id`);
      check.numbers(entry, ['cash', 'shares'], investorPath);
    }
  }
  if (record.initialEquipment !== undefined) {
    validateInitialEquipmentGrant(check, record.initialEquipment, `${path}.initialEquipment`);
  }
}

function validateLiquidationRecord(check: ShapeCheck, value: unknown, index: number): void {
  const path = `lifecycle.liquidations[${index}]`;
  const record = check.object(value, path);
  if (!record) return;
  check.texts(record, ['id', 'companyId', 'companyName', 'cityId', 'reason', 'note'], path);
  check.integer(record.tick, `${path}.tick`);
  check.numbers(
    record,
    [
      'employeesReleased',
      'cash',
      'debt',
      'debtRepaid',
      'debtForgiven',
      'shareholderPayout',
      'inventoryBookValue',
    ],
    path,
  );

  const holdings = check.array(record.holdings, `${path}.holdings`);
  if (holdings) {
    for (const [holdingIndex, holding] of holdings.entries()) {
      const holdingPath = `${path}.holdings[${holdingIndex}]`;
      const entry = check.object(holding, holdingPath);
      if (!entry) continue;
      const holder = check.object(entry.holder, `${holdingPath}.holder`);
      if (holder) {
        if (typeof holder.type !== 'string' || !HOLDER_TYPES.has(holder.type)) {
          check.fail(`${holdingPath}.holder.type 必须是合法持有人类型`);
        }
        check.text(holder.id, `${holdingPath}.holder.id`);
      }
      check.numbers(entry, ['shares', 'amount'], holdingPath);
    }
  }

  const writtenOff = check.array(record.inventoryWrittenOff, `${path}.inventoryWrittenOff`);
  if (writtenOff) {
    for (const [entryIndex, entry] of writtenOff.entries()) {
      const entryPath = `${path}.inventoryWrittenOff[${entryIndex}]`;
      const recordEntry = check.object(entry, entryPath);
      if (!recordEntry) continue;
      if (typeof recordEntry.good !== 'string' || !GOOD_ID_SET.has(recordEntry.good)) {
        check.fail(`${entryPath}.good 必须是合法商品`);
      }
      check.numbers(recordEntry, ['qty', 'bookValue'], entryPath);
    }
  }

  check.stringArray(record.agreementsAffected, `${path}.agreementsAffected`);

  if (record.initialEquipmentReturned !== undefined) {
    validateInitialEquipmentReturned(
      check,
      record.initialEquipmentReturned,
      `${path}.initialEquipmentReturned`,
    );
  }
  // v1.7 §二 F2：清算对账字段可选（旧档缺省安全），出现时必须是有限数值。
  check.optionalNumbers(
    record,
    [
      'equipmentProceeds',
      'equipmentMaintenanceDue',
      'equipmentMaintenancePaid',
      'equipmentMaintenanceArrearsRepaid',
      'equipmentMaintenanceWrittenOff',
    ],
    path,
  );
}

function validateLifecycle(check: ShapeCheck, value: unknown): void {
  const lifecycle = check.object(value, 'lifecycle');
  if (!lifecycle) return;
  check.integer(lifecycle.nextFoundingNumber, 'lifecycle.nextFoundingNumber');
  check.integer(lifecycle.nextLiquidationNumber, 'lifecycle.nextLiquidationNumber');
  const foundings = check.array(lifecycle.foundings, 'lifecycle.foundings');
  if (foundings) {
    for (const [index, record] of foundings.entries()) validateFoundingRecord(check, record, index);
  }
  const liquidations = check.array(lifecycle.liquidations, 'lifecycle.liquidations');
  if (liquidations) {
    for (const [index, record] of liquidations.entries()) {
      validateLiquidationRecord(check, record, index);
    }
  }
}

function validateCompanyData(input: unknown): SaveModuleValidation {
  const check = new ShapeCheck();

  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: ['company 模块数据必须是对象'] };
  }

  const data = input as UnknownRecord;
  const companies = check.array(data.companies, 'companies');
  if (companies) {
    const ids = new Set<string>();
    for (const [index, company] of companies.entries()) {
      validateCompany(check, company, index);
      const id = isRecord(company) ? company.id : undefined;
      if (typeof id === 'string' && id.length > 0) {
        if (ids.has(id)) check.fail(`企业 ID 重复：${id}`);
        ids.add(id);
      }
    }
  }

  validateLifecycle(check, data.lifecycle);

  return { ok: check.errors.length === 0, errors: check.errors };
}

export const companySaveModule: SaveModule<CompanySaveData> = {
  id: 'company',
  version: COMPANY_SAVE_MODULE_VERSION,
  required: true,
  dependsOn: ['world'],
  ownedPaths: ['companies', 'lifecycle'],

  export(context: SaveExportContext): CompanySaveData {
    const world = context.world;
    return cloneJson({
      companies: world.companies,
      lifecycle: world.lifecycle,
    });
  },

  validate(data: unknown, version: number): SaveModuleValidation {
    if (version !== COMPANY_SAVE_MODULE_VERSION) {
      return {
        ok: false,
        errors: [`company 模块数据版本不受支持：${version}（当前支持 ${COMPANY_SAVE_MODULE_VERSION}）`],
      };
    }
    return validateCompanyData(data);
  },

  migrate(data: unknown, context: SaveModuleMigrationContext): CompanySaveData {
    if (context.fromVersion === 0) {
      throw new Error('存档缺少 company 模块：企业资产/现金/设备无法凭空重建');
    }
    if (context.fromVersion === COMPANY_SAVE_MODULE_VERSION) return data as CompanySaveData;
    throw new Error(`不支持从 company 模块数据版本 ${context.fromVersion} 迁移到 ${context.toVersion}`);
  },

  restore(data: CompanySaveData, context: SaveRestoreContext): void {
    const world = context.world;
    world.companies = data.companies;
    world.lifecycle = data.lifecycle;
  },
};
