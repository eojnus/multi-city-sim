/**
 * v1.7 存档系统：world 模块。
 *
 * 归属（与 task/数据归属分析一致）：世界级权威/配置/展示字段 + 城市骨架中不属于其他模块的字段。
 * - seed/rngState/time：世界推进与随机数的唯一权威；
 * - player：玩家现金、持股镜像、身份；
 * - cities[]：只保存骨架字段（id/name/englishName/tagline/color/region）与世界级派生/展示字段
 *   （gdp/gdpHistory/lastMonth/technology/realEstate）；population、market、treasury 等同城字段
 *   分别由 population/company/marketTrade 等模块恢复，本模块不得写入。
 * - history/log/notifications/lastTick：展示历史与上一 tick 展示快照。
 *
 * 恢复顺序：world 必须最先恢复（建立候选世界城市骨架），其余模块依赖它用 `cityOf(id)` 查找城市。
 *
 * 数据纯度：export 用 JSON 序列化深拷贝生成新对象，绝不把世界内部可变对象引用交给存档层；
 * 导出后继续推进/篡改世界不会影响已经拿到的快照数据。
 */

import type {
  City,
  LogEntry,
  PlayerNotification,
  PlayerState,
  WorldHistoryPoint,
  WorldState,
} from '../../contracts/types';
import type {
  SaveExportContext,
  SaveModule,
  SaveModuleMigrationContext,
  SaveModuleValidation,
  SaveRestoreContext,
} from '../types';

/** world 模块数据版本（从 1 开始；字段变化才递增）。 */
export const WORLD_SAVE_MODULE_VERSION = 1;

/** 模块数据中的城市骨架 + world 拥有的城市字段。 */
export interface WorldSaveCity {
  id: string;
  name: string;
  englishName: string;
  tagline: string;
  color: string;
  region: City['region'];
  gdp: number;
  gdpHistory: City['gdpHistory'];
  lastMonth: City['lastMonth'];
  technology: City['technology'];
  realEstate: City['realEstate'];
}

export interface WorldSaveData {
  seed: number;
  rngState: number;
  time: WorldState['time'];
  player: PlayerState;
  cities: WorldSaveCity[];
  history: WorldHistoryPoint[];
  log: LogEntry[];
  notifications: PlayerNotification[];
  lastTick: WorldState['lastTick'];
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

/** 城市月度报告中的必填数值字段（CityMonthlyReport）。 */
const CITY_REPORT_REQUIRED_NUMBERS = [
  'householdIncome',
  'consumerSpend',
  'consumerBudget',
  'benefitsPaid',
  'incomeTax',
  'corporateTax',
  'publicWageBill',
  'gdp',
  'migrationIn',
  'migrationOut',
  'investorDividends',
  'investableContribution',
  'policySpending',
  'transportSpending',
] as const;

/** 城市月度报告中的可选数值字段：缺省合法，出现时必须是有限数值。 */
const CITY_REPORT_OPTIONAL_NUMBERS = [
  'consumerLoanDrawn',
  'consumerLoanRepaid',
  'consumerLoanOutstanding',
  'bondInterestPaid',
  'bondPrincipalPaid',
  'bankAdvanceThisMonth',
  'totalDebtAtMonthEnd',
  'debtRatioAtMonthEnd',
  'gdpJudgementValue',
  'consumptionTax',
  'dividendTax',
  'transportTaxFactor',
  'transportTaxBonus',
  'transportTaxLoss',
] as const;

const LOG_KINDS = new Set([
  'system',
  'market',
  'labor',
  'production',
  'trade',
  'population',
  'government',
  'player',
  'warning',
]);

const NOTIFICATION_AUDIENCES = new Set(['personal', 'company', 'city']);
const NOTIFICATION_KINDS = new Set([
  'dividend',
  'vote',
  'major',
  'agreement',
  'market',
  'fiscal',
  'bankruptcy',
]);
const NOTIFICATION_PRIORITIES = new Set(['normal', 'important']);

/** 结构校验收集器：一次收集全部错误，便于定位损坏字段而不是只报第一个。 */
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

  /** 可选数值字段：缺省（undefined）合法，出现则必须合法。 */
  optionalNumbers(record: UnknownRecord, keys: readonly string[], path: string): void {
    for (const key of keys) {
      if (record[key] === undefined) continue;
      this.number(record[key], `${path}.${key}`);
    }
  }

  texts(record: UnknownRecord, keys: readonly string[], path: string): void {
    for (const key of keys) this.text(record[key], `${path}.${key}`);
  }
}

function validatePlayer(check: ShapeCheck, value: unknown, path: string): void {
  const player = check.object(value, path);
  if (!player) return;
  check.text(player.name, `${path}.name`);
  check.text(player.homeCityId, `${path}.homeCityId`);
  check.number(player.cash, `${path}.cash`);
  check.optionalNumbers(player, ['lastDividend', 'dividendsReceived'], path);
  const roles = check.object(player.roles, `${path}.roles`);
  if (roles) {
    if (roles.mayorCityId !== null) check.text(roles.mayorCityId, `${path}.roles.mayorCityId`);
  }
  check.text(player.note, `${path}.note`);
  const holdings = check.array(player.holdings, `${path}.holdings`);
  if (!holdings) return;
  for (const [index, holding] of holdings.entries()) {
    const holdingPath = `${path}.holdings[${index}]`;
    const record = check.object(holding, holdingPath);
    if (!record) continue;
    check.text(record.companyId, `${holdingPath}.companyId`);
    check.number(record.shares, `${holdingPath}.shares`);
  }
}

function validateVisibility(check: ShapeCheck, value: unknown, path: string): void {
  const visibility = check.object(value, path);
  if (!visibility) return;
  if (visibility.scope !== 'public' && visibility.scope !== 'mayor') {
    check.fail(`${path}.scope 必须是 public 或 mayor`);
    return;
  }
  if (visibility.scope === 'public') {
    if (visibility.cityId !== null) check.fail(`${path}.cityId 在 public 时必须为 null`);
    return;
  }
  if (typeof visibility.cityId !== 'string' || visibility.cityId.length === 0) {
    check.fail(`${path}.cityId 在 mayor 时必须是非空字符串`);
  }
}

function validateWorldCity(check: ShapeCheck, value: unknown, index: number): void {
  const path = `cities[${index}]`;
  const city = check.object(value, path);
  if (!city) return;
  check.texts(city, ['id', 'name', 'englishName', 'tagline', 'color'], path);
  const region = check.object(city.region, `${path}.region`);
  if (region) check.numbers(region, ['x', 'y', 'radius'], `${path}.region`);
  check.number(city.gdp, `${path}.gdp`);

  const gdpHistory = check.array(city.gdpHistory, `${path}.gdpHistory`);
  if (gdpHistory) {
    for (const [pointIndex, point] of gdpHistory.entries()) {
      const pointPath = `${path}.gdpHistory[${pointIndex}]`;
      const record = check.object(point, pointPath);
      if (!record) continue;
      check.numbers(record, ['tick', 'value'], pointPath);
      if (record.estimated !== undefined) check.boolean(record.estimated, `${pointPath}.estimated`);
    }
  }

  const lastMonth = check.object(city.lastMonth, `${path}.lastMonth`);
  if (lastMonth) {
    check.numbers(lastMonth, CITY_REPORT_REQUIRED_NUMBERS, `${path}.lastMonth`);
    check.optionalNumbers(lastMonth, CITY_REPORT_OPTIONAL_NUMBERS, `${path}.lastMonth`);
    check.text(lastMonth.note, `${path}.lastMonth.note`);
  }

  const technology = check.object(city.technology, `${path}.technology`);
  if (technology) {
    check.numbers(technology, ['level', 'researchPoints', 'productivityMultiplier'], `${path}.technology`);
    if (technology.status !== 'initial-only' && technology.status !== 'active') {
      check.fail(`${path}.technology.status 必须是 initial-only 或 active`);
    }
    check.text(technology.note, `${path}.technology.note`);
  }

  const realEstate = check.object(city.realEstate, `${path}.realEstate`);
  if (realEstate) {
    check.numbers(realEstate, ['avgHomePrice', 'rentIndex', 'vacancyRate'], `${path}.realEstate`);
    if (realEstate.status !== 'initial-only') {
      check.fail(`${path}.realEstate.status 必须是 initial-only`);
    }
    check.text(realEstate.note, `${path}.realEstate.note`);
  }
}

function validateHistory(check: ShapeCheck, value: unknown): void {
  const history = check.array(value, 'history');
  if (!history) return;
  for (const [index, point] of history.entries()) {
    const path = `history[${index}]`;
    const record = check.object(point, path);
    if (!record) continue;
    check.numbers(
      record,
      ['tick', 'year', 'month', 'population', 'employed', 'unemployed', 'gdp', 'playerNetWorth'],
      path,
    );
  }
}

function validateLog(check: ShapeCheck, value: unknown): void {
  const log = check.array(value, 'log');
  if (!log) return;
  for (const [index, entry] of log.entries()) {
    const path = `log[${index}]`;
    const record = check.object(entry, path);
    if (!record) continue;
    check.integer(record.tick, `${path}.tick`);
    if (typeof record.kind !== 'string' || !LOG_KINDS.has(record.kind)) {
      check.fail(`${path}.kind 必须是合法日志类型`);
    }
    check.text(record.message, `${path}.message`);
    if (record.visibility !== undefined) validateVisibility(check, record.visibility, `${path}.visibility`);
  }
}

function validateNotifications(check: ShapeCheck, value: unknown): void {
  const notifications = check.array(value, 'notifications');
  if (!notifications) return;
  for (const [index, notice] of notifications.entries()) {
    const path = `notifications[${index}]`;
    const record = check.object(notice, path);
    if (!record) continue;
    check.text(record.id, `${path}.id`);
    check.integer(record.tick, `${path}.tick`);
    if (typeof record.audience !== 'string' || !NOTIFICATION_AUDIENCES.has(record.audience)) {
      check.fail(`${path}.audience 必须是 personal/company/city`);
    }
    if (typeof record.kind !== 'string' || !NOTIFICATION_KINDS.has(record.kind)) {
      check.fail(`${path}.kind 必须是合法通知类型`);
    }
    if (typeof record.priority !== 'string' || !NOTIFICATION_PRIORITIES.has(record.priority)) {
      check.fail(`${path}.priority 必须是 normal 或 important`);
    }
    if (record.companyId !== undefined && typeof record.companyId !== 'string') {
      check.fail(`${path}.companyId 必须是字符串`);
    }
    if (record.cityId !== undefined) check.text(record.cityId, `${path}.cityId`);
    check.text(record.title, `${path}.title`);
    check.text(record.body, `${path}.body`);
    check.boolean(record.read, `${path}.read`);
    if (record.visibility !== undefined) validateVisibility(check, record.visibility, `${path}.visibility`);
  }
}

function validateLastTick(check: ShapeCheck, value: unknown): void {
  const lastTick = check.object(value, 'lastTick');
  if (!lastTick) return;
  const productionRecords = check.array(lastTick.productionRecords, 'lastTick.productionRecords');
  if (productionRecords) {
    for (const [index, entry] of productionRecords.entries()) {
      const path = `lastTick.productionRecords[${index}]`;
      const record = check.object(entry, path);
      if (!record) continue;
      check.numbers(record, ['tick', 'qty', 'outputValue', 'inputValue', 'valueAdded'], path);
      check.texts(record, ['cityId', 'companyId', 'good'], path);
      check.array(record.inputs, `${path}.inputs`);
    }
  }
  const tradeFlows = check.array(lastTick.tradeFlows, 'lastTick.tradeFlows');
  if (tradeFlows) {
    for (const [index, entry] of tradeFlows.entries()) {
      const path = `lastTick.tradeFlows[${index}]`;
      const record = check.object(entry, path);
      if (!record) continue;
      check.numbers(record, ['tick', 'qty', 'unitPrice', 'value'], path);
      check.texts(
        record,
        ['routeId', 'fromCityId', 'toCityId', 'fromCompanyId', 'toCompanyId', 'good'],
        path,
      );
    }
  }
  const externalExports = check.array(lastTick.externalExports, 'lastTick.externalExports');
  if (externalExports) {
    for (const [index, entry] of externalExports.entries()) {
      const path = `lastTick.externalExports[${index}]`;
      const record = check.object(entry, path);
      if (!record) continue;
      check.texts(record, ['cityId', 'good', 'note'], path);
      check.numbers(record, ['tick', 'qty', 'unitPrice', 'value'], path);
    }
  }
  const migration = check.array(lastTick.migration, 'lastTick.migration');
  if (migration) {
    for (const [index, entry] of migration.entries()) {
      const path = `lastTick.migration[${index}]`;
      const record = check.object(entry, path);
      if (!record) continue;
      check.texts(record, ['fromCityId', 'toCityId'], path);
      check.numbers(record, ['people', 'laborForce'], path);
    }
  }
  const invariants = check.array(lastTick.invariants, 'lastTick.invariants');
  if (invariants) {
    for (const [index, entry] of invariants.entries()) {
      check.text(entry, `lastTick.invariants[${index}]`);
    }
  }
}

function validateWorldData(input: unknown): SaveModuleValidation {
  const check = new ShapeCheck();

  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: ['world 模块数据必须是对象'] };
  }

  const data = input as UnknownRecord;
  check.integer(data.seed, 'seed');
  check.integer(data.rngState, 'rngState');

  const time = check.object(data.time, 'time');
  if (time) {
    check.integer(time.year, 'time.year');
    check.integer(time.month, 'time.month');
    check.integer(time.tick, 'time.tick');
    if (isInteger(time.month) && (time.month < 1 || time.month > 12)) {
      check.fail('time.month 必须在 1–12 之间');
    }
  }

  validatePlayer(check, data.player, 'player');

  const cities = check.array(data.cities, 'cities');
  if (cities) {
    const ids = new Set<string>();
    for (const [index, city] of cities.entries()) {
      validateWorldCity(check, city, index);
      const id = isRecord(city) ? city.id : undefined;
      if (typeof id === 'string' && id.length > 0) {
        if (ids.has(id)) check.fail(`城市 ID 重复：${id}`);
        ids.add(id);
      }
    }
  }

  validateHistory(check, data.history);
  validateLog(check, data.log);
  validateNotifications(check, data.notifications);
  validateLastTick(check, data.lastTick);

  return { ok: check.errors.length === 0, errors: check.errors };
}

export const worldSaveModule: SaveModule<WorldSaveData> = {
  id: 'world',
  version: WORLD_SAVE_MODULE_VERSION,
  required: true,
  dependsOn: [],
  ownedPaths: [
    'seed',
    'rngState',
    'time',
    'player',
    'cities[].id',
    'cities[].name',
    'cities[].englishName',
    'cities[].tagline',
    'cities[].color',
    'cities[].region',
    'cities[].gdp',
    'cities[].gdpHistory',
    'cities[].lastMonth',
    'cities[].technology',
    'cities[].realEstate',
    'history',
    'log',
    'notifications',
    'lastTick',
  ],

  export(context: SaveExportContext): WorldSaveData {
    const world = context.world;
    return {
      seed: world.seed,
      rngState: world.rngState,
      time: { year: world.time.year, month: world.time.month, tick: world.time.tick },
      player: cloneJson(world.player),
      cities: world.cities.map((city) => ({
        id: city.id,
        name: city.name,
        englishName: city.englishName,
        tagline: city.tagline,
        color: city.color,
        region: { ...city.region },
        gdp: city.gdp,
        gdpHistory: city.gdpHistory.map((point) => ({ ...point })),
        lastMonth: { ...city.lastMonth },
        technology: { ...city.technology },
        realEstate: { ...city.realEstate },
      })),
      history: world.history.map((point) => ({ ...point })),
      log: world.log.map((entry) => ({
        ...entry,
        ...(entry.visibility ? { visibility: { ...entry.visibility } } : {}),
      })),
      notifications: cloneJson(world.notifications),
      lastTick: cloneJson(world.lastTick),
    };
  },

  validate(data: unknown, version: number): SaveModuleValidation {
    if (version !== WORLD_SAVE_MODULE_VERSION) {
      return {
        ok: false,
        errors: [`world 模块数据版本不受支持：${version}（当前支持 ${WORLD_SAVE_MODULE_VERSION}）`],
      };
    }
    return validateWorldData(data);
  },

  migrate(data: unknown, context: SaveModuleMigrationContext): WorldSaveData {
    if (context.fromVersion === 0) {
      throw new Error('存档缺少 world 模块：旧单体存档应走旧格式迁移路径，不能凭空补世界数据');
    }
    if (context.fromVersion === WORLD_SAVE_MODULE_VERSION) return data as WorldSaveData;
    throw new Error(`不支持从 world 模块数据版本 ${context.fromVersion} 迁移到 ${context.toVersion}`);
  },

  restore(data: WorldSaveData, context: SaveRestoreContext): void {
    const world = context.world;
    world.seed = data.seed;
    world.rngState = data.rngState;
    world.time = { year: data.time.year, month: data.time.month, tick: data.time.tick };
    world.player = data.player;

    // 候选世界初始 cities 为空；先清空保证重复 restore 幂等，再按存档顺序建立骨架。
    // 只填本模块拥有的字段，population/market/treasury 等留待其他模块恢复（此时不是完整 City）。
    world.cities.length = 0;
    for (const city of data.cities) {
      const skeleton = {
        id: city.id,
        name: city.name,
        englishName: city.englishName,
        tagline: city.tagline,
        color: city.color,
        region: { ...city.region },
        gdp: city.gdp,
        gdpHistory: city.gdpHistory.map((point) => ({ ...point })),
        lastMonth: { ...city.lastMonth },
        technology: { ...city.technology },
        realEstate: { ...city.realEstate },
      };
      world.cities.push(skeleton as unknown as City);
    }

    world.history = data.history;
    world.log = data.log;
    world.notifications = data.notifications;
    world.lastTick = data.lastTick;
  },
};
