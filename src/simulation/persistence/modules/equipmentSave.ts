/**
 * v1.7 存档系统：equipment 模块。
 *
 * 归属：`equipmentMarket` 整体——政府开局设备库存、二手设备挂单、上月成交统计、
 * 本月设备成交市场账本增量、资本化流出、设备维护费月度流水与历史流水。
 *
 * 企业自身的设备台数/维护费快照/欠费属于企业原子聚合（company 模块），本模块不拆分。
 * 恢复依赖 world（候选世界容器），只写 world.equipmentMarket。
 */

import { GOOD_IDS } from '../../companies/company';
import type {
  EquipmentKind,
  EquipmentMaintenanceMonth,
  EquipmentMarketState,
} from '../../contracts/types';
import type {
  SaveExportContext,
  SaveModule,
  SaveModuleMigrationContext,
  SaveModuleValidation,
  SaveRestoreContext,
} from '../types';

/** equipment 模块数据版本。 */
export const EQUIPMENT_SAVE_MODULE_VERSION = 1;

export interface EquipmentSaveData {
  equipmentMarket: EquipmentMarketState;
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

const EQUIPMENT_KINDS: readonly EquipmentKind[] = ['farm', 'industry', 'energy'];
const EQUIPMENT_KIND_SET = new Set<string>(EQUIPMENT_KINDS);
const GOOD_ID_SET = new Set<string>(GOOD_IDS);

/** 维护费月度流水中的数值字段（EquipmentMaintenanceMonth）。 */
const MAINTENANCE_MONTH_NUMERIC_FIELDS = [
  'totalDue',
  'totalPaid',
  'totalBorrowed',
  'totalArrearsAdded',
  'totalArrearsRepaid',
  'totalArrearsOutstanding',
  'totalWrittenOff',
] as const;

/** 单城维护费流水中的数值字段（EquipmentMaintenanceCityFlow）。 */
const MAINTENANCE_CITY_FLOW_NUMERIC_FIELDS = [
  'due',
  'paid',
  'borrowed',
  'arrearsAdded',
  'arrearsRepaid',
  'arrearsOutstanding',
  'writtenOff',
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

  numbers(record: UnknownRecord, keys: readonly string[], path: string): void {
    for (const key of keys) this.number(record[key], `${path}.${key}`);
  }

  texts(record: UnknownRecord, keys: readonly string[], path: string): void {
    for (const key of keys) this.text(record[key], `${path}.${key}`);
  }

  equipmentAssets(value: unknown, path: string): void {
    const assets = this.object(value, path);
    if (!assets) return;
    this.numbers(assets, EQUIPMENT_KINDS, path);
  }
}

function validateMaintenanceMonth(check: ShapeCheck, value: unknown, path: string): void {
  const month = check.object(value, path);
  if (!month) return;
  check.integer(month.tick, `${path}.tick`);
  check.equipmentAssets(month.unitsByKind, `${path}.unitsByKind`);
  check.equipmentAssets(month.feeByKind, `${path}.feeByKind`);
  check.numbers(month, MAINTENANCE_MONTH_NUMERIC_FIELDS, path);

  const byCity = check.object(month.byCity, `${path}.byCity`);
  if (byCity) {
    for (const [cityId, flow] of Object.entries(byCity)) {
      const flowPath = `${path}.byCity.${cityId}`;
      const record = check.object(flow, flowPath);
      if (record) check.numbers(record, MAINTENANCE_CITY_FLOW_NUMERIC_FIELDS, flowPath);
    }
  }

  const settledCompanyIds = check.array(month.settledCompanyIds, `${path}.settledCompanyIds`);
  if (settledCompanyIds) {
    for (const [index, companyId] of settledCompanyIds.entries()) {
      check.text(companyId, `${path}.settledCompanyIds[${index}]`);
    }
  }

  check.text(month.note, `${path}.note`);
}

function validateEquipmentData(input: unknown): SaveModuleValidation {
  const check = new ShapeCheck();

  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: ['equipment 模块数据必须是对象'] };
  }

  const data = input as UnknownRecord;
  const market = check.object(data.equipmentMarket, 'equipmentMarket');
  if (!market) return { ok: check.errors.length === 0, errors: check.errors };

  check.equipmentAssets(market.initialStock, 'equipmentMarket.initialStock');
  check.equipmentAssets(market.lastMonthSold, 'equipmentMarket.lastMonthSold');

  const offers = check.array(market.offers, 'equipmentMarket.offers');
  if (offers) {
    const ids = new Set<string>();
    for (const [index, offer] of offers.entries()) {
      const path = `equipmentMarket.offers[${index}]`;
      const record = check.object(offer, path);
      if (!record) continue;
      check.text(record.id, `${path}.id`);
      if (typeof record.id === 'string' && record.id.length > 0) {
        if (ids.has(record.id)) check.fail(`设备委托 ID 重复：${record.id}`);
        ids.add(record.id);
      }
      check.texts(record, ['companyId', 'cityId', 'note'], path);
      if (typeof record.kind !== 'string' || !EQUIPMENT_KIND_SET.has(record.kind)) {
        check.fail(`${path}.kind 必须是 farm/industry/energy`);
      }
      check.numbers(record, ['units', 'askPrice', 'listedTick'], path);
    }
  }

  if (market.pendingLedger !== undefined) {
    const pendingLedger = check.array(market.pendingLedger, 'equipmentMarket.pendingLedger');
    if (pendingLedger) {
      for (const [index, entry] of pendingLedger.entries()) {
        const path = `equipmentMarket.pendingLedger[${index}]`;
        const record = check.object(entry, path);
        if (!record) continue;
        check.text(record.cityId, `${path}.cityId`);
        if (typeof record.goodId !== 'string' || !GOOD_ID_SET.has(record.goodId)) {
          check.fail(`${path}.goodId 必须是合法商品`);
        }
        check.numbers(record, ['demand', 'sold', 'intercityImported'], path);
      }
    }
  }

  if (market.capitalizedThisTick !== undefined) {
    const capitalized = check.object(market.capitalizedThisTick, 'equipmentMarket.capitalizedThisTick');
    if (capitalized) {
      for (const [goodId, units] of Object.entries(capitalized)) {
        if (!GOOD_ID_SET.has(goodId)) {
          check.fail(`equipmentMarket.capitalizedThisTick 含未知商品 ${goodId}`);
          continue;
        }
        check.number(units, `equipmentMarket.capitalizedThisTick.${goodId}`);
      }
    }
  }

  if (market.maintenanceMonth !== undefined) {
    validateMaintenanceMonth(check, market.maintenanceMonth, 'equipmentMarket.maintenanceMonth');
  }

  if (market.maintenanceHistory !== undefined) {
    const history = check.array(market.maintenanceHistory, 'equipmentMarket.maintenanceHistory');
    if (history) {
      for (const [index, entry] of history.entries()) {
        validateMaintenanceMonth(check, entry, `equipmentMarket.maintenanceHistory[${index}]`);
      }
    }
  }

  return { ok: check.errors.length === 0, errors: check.errors };
}

export const equipmentSaveModule: SaveModule<EquipmentSaveData> = {
  id: 'equipment',
  version: EQUIPMENT_SAVE_MODULE_VERSION,
  required: true,
  dependsOn: ['world'],
  ownedPaths: ['equipmentMarket'],

  export(context: SaveExportContext): EquipmentSaveData {
    // equipmentMarket 是纯数据对象（offers/流水均可 JSON 序列化），整体深拷贝后返回。
    return cloneJson({ equipmentMarket: context.world.equipmentMarket });
  },

  validate(data: unknown, version: number): SaveModuleValidation {
    if (version !== EQUIPMENT_SAVE_MODULE_VERSION) {
      return {
        ok: false,
        errors: [`equipment 模块数据版本不受支持：${version}（当前支持 ${EQUIPMENT_SAVE_MODULE_VERSION}）`],
      };
    }
    return validateEquipmentData(data);
  },

  migrate(data: unknown, context: SaveModuleMigrationContext): EquipmentSaveData {
    if (context.fromVersion === 0) {
      throw new Error('存档缺少 equipment 模块：设备库存/挂单/维护费流水无法凭空重建');
    }
    if (context.fromVersion === EQUIPMENT_SAVE_MODULE_VERSION) return data as EquipmentSaveData;
    throw new Error(
      `不支持从 equipment 模块数据版本 ${context.fromVersion} 迁移到 ${context.toVersion}`,
    );
  },

  restore(data: EquipmentSaveData, context: SaveRestoreContext): void {
    context.world.equipmentMarket = data.equipmentMarket;
  },
};
