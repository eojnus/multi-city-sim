/**
 * v1.7 存档系统：marketTrade 模块。
 *
 * 归属：
 * - `cities[].market`：城市市场状态（price 权威；supply/demand/sold 等每 tick 重写的投影，
 *   但恢复“上月参考价”必须保留）；
 * - `tradeRoutes`：城际贸易路线（配置 + 运行期删除集）；
 * - `agreements`：政府牵头的跨城协议；
 * - `transport`：城际/城内交通网络与上月容量结算统计（下月输入）。
 *
 * 恢复依赖 world（候选世界城市骨架）；城市市场用 `context.cityOf(id)` 填充。
 */

import { GOOD_IDS } from '../../companies/company';
import type {
  GoodId,
  MarketState,
  TradeAgreement,
  TradeRoute,
  TransportState,
} from '../../contracts/types';
import type {
  SaveExportContext,
  SaveModule,
  SaveModuleMigrationContext,
  SaveModuleValidation,
  SaveRestoreContext,
} from '../types';

/** marketTrade 模块数据版本。 */
export const MARKET_TRADE_SAVE_MODULE_VERSION = 1;

export interface MarketTradeSaveCity {
  id: string;
  market: Record<GoodId, MarketState>;
}

export interface MarketTradeSaveData {
  cities: MarketTradeSaveCity[];
  tradeRoutes: TradeRoute[];
  agreements: TradeAgreement[];
  transport: TransportState;
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

const GOOD_ID_SET = new Set<string>(GOOD_IDS);
const AGREEMENT_STATUSES = new Set(['proposed', 'active', 'completed', 'cancelled']);
const AGREEMENT_ITEM_STATUSES = new Set(['pending', 'active', 'fulfilled', 'failed', 'declined']);
const AGREEMENT_SIDES = new Set(['buyer', 'seller']);
const AGREEMENT_DECISIONS = new Set(['pending', 'accepted', 'declined']);
const TRANSPORT_MODES = new Set(['road', 'rail']);
const PENDING_SALE_PATHS = new Set([
  'contract',
  'agreement',
  'intercityPurchase',
  'householdPurchase',
]);

/** 市场状态的数值字段（MarketState）。 */
const MARKET_NUMERIC_FIELDS = [
  'price',
  'supply',
  'demand',
  'consumerDemand',
  'producerRequired',
  'producerDemand',
  'sold',
  'unmetDemand',
  'unmetFunding',
  'intercityImported',
  'externalExport',
  'closingStock',
  'lastPriceChangePct',
  'consumptionTax',
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

  texts(record: UnknownRecord, keys: readonly string[], path: string): void {
    for (const key of keys) this.text(record[key], `${path}.${key}`);
  }

  stringArray(value: unknown, path: string): void {
    const array = this.array(value, path);
    if (!array) return;
    for (const [index, entry] of array.entries()) this.text(entry, `${path}[${index}]`);
  }
}

function validateMarket(check: ShapeCheck, value: unknown, path: string): void {
  const market = check.object(value, path);
  if (!market) return;
  if (typeof market.goodId !== 'string' || !GOOD_ID_SET.has(market.goodId)) {
    check.fail(`${path}.goodId 必须是合法商品`);
  }
  check.numbers(market, MARKET_NUMERIC_FIELDS, path);
}

function validateMarketTradeCity(check: ShapeCheck, value: unknown, index: number): void {
  const path = `cities[${index}]`;
  const city = check.object(value, path);
  if (!city) return;
  check.text(city.id, `${path}.id`);
  const market = check.object(city.market, `${path}.market`);
  if (!market) return;
  for (const goodId of GOOD_IDS) {
    validateMarket(check, market[goodId], `${path}.market.${goodId}`);
  }
}

function validateTradeRoutes(check: ShapeCheck, value: unknown): void {
  const routes = check.array(value, 'tradeRoutes');
  if (!routes) return;
  for (const [index, route] of routes.entries()) {
    const path = `tradeRoutes[${index}]`;
    const record = check.object(route, path);
    if (!record) continue;
    check.texts(
      record,
      ['id', 'fromCityId', 'toCityId', 'fromCompanyId', 'toCompanyId', 'note'],
      path,
    );
    if (typeof record.good !== 'string' || !GOOD_ID_SET.has(record.good)) {
      check.fail(`${path}.good 必须是合法商品`);
    }
    check.numbers(record, ['monthlyTarget', 'distanceKm'], path);
    check.boolean(record.active, `${path}.active`);
  }
}

function validateAgreements(check: ShapeCheck, value: unknown): void {
  const agreements = check.array(value, 'agreements');
  if (!agreements) return;
  for (const [index, agreement] of agreements.entries()) {
    const path = `agreements[${index}]`;
    const record = check.object(agreement, path);
    if (!record) continue;
    check.texts(record, ['id', 'title', 'sponsorCityId', 'partnerCityId', 'note'], path);
    check.integer(record.createdTick, `${path}.createdTick`);
    if (record.createdBy !== 'government' && record.createdBy !== 'demo') {
      check.fail(`${path}.createdBy 必须是 government 或 demo`);
    }
    if (typeof record.status !== 'string' || !AGREEMENT_STATUSES.has(record.status)) {
      check.fail(`${path}.status 必须是 proposed/active/completed/cancelled`);
    }

    const participants = check.array(record.participants, `${path}.participants`);
    if (participants) {
      for (const [participantIndex, participant] of participants.entries()) {
        const participantPath = `${path}.participants[${participantIndex}]`;
        const entry = check.object(participant, participantPath);
        if (!entry) continue;
        check.texts(entry, ['companyId', 'cityId', 'note'], participantPath);
        if (typeof entry.side !== 'string' || !AGREEMENT_SIDES.has(entry.side)) {
          check.fail(`${participantPath}.side 必须是 buyer 或 seller`);
        }
        if (typeof entry.decision !== 'string' || !AGREEMENT_DECISIONS.has(entry.decision)) {
          check.fail(`${participantPath}.decision 必须是 pending/accepted/declined`);
        }
        if (entry.decidedTick !== null) check.integer(entry.decidedTick, `${participantPath}.decidedTick`);
      }
    }

    const items = check.array(record.items, `${path}.items`);
    if (items) {
      for (const [itemIndex, item] of items.entries()) {
        const itemPath = `${path}.items[${itemIndex}]`;
        const entry = check.object(item, itemPath);
        if (!entry) continue;
        check.texts(entry, ['id', 'buyerCompanyId', 'sellerCompanyId', 'lastNote'], itemPath);
        if (typeof entry.good !== 'string' || !GOOD_ID_SET.has(entry.good)) {
          check.fail(`${itemPath}.good 必须是合法商品`);
        }
        check.numbers(
          entry,
          ['qtyPerMonth', 'unitPrice', 'months', 'deliveredQty', 'paidValue', 'monthsExecuted'],
          itemPath,
        );
        if (typeof entry.status !== 'string' || !AGREEMENT_ITEM_STATUSES.has(entry.status)) {
          check.fail(`${itemPath}.status 必须是 pending/active/fulfilled/failed/declined`);
        }
      }
    }
  }
}

function validateTransportConstruction(check: ShapeCheck, value: unknown, path: string): void {
  const construction = check.object(value, path);
  if (!construction) return;
  check.numbers(
    construction,
    ['targetLevel', 'monthsRemaining', 'totalMonths', 'costPaid', 'startedTick'],
    path,
  );
}

function validateTransport(check: ShapeCheck, value: unknown): void {
  const transport = check.object(value, 'transport');
  if (!transport) return;

  const links = check.array(transport.links, 'transport.links');
  if (links) {
    for (const [index, link] of links.entries()) {
      const path = `transport.links[${index}]`;
      const record = check.object(link, path);
      if (!record) continue;
      check.texts(record, ['id', 'fromCityId', 'toCityId'], path);
      if (typeof record.mode !== 'string' || !TRANSPORT_MODES.has(record.mode)) {
        check.fail(`${path}.mode 必须是 road 或 rail`);
      }
      check.numbers(record, ['level', 'maxLevel'], path);
      if (record.construction !== null) {
        validateTransportConstruction(check, record.construction, `${path}.construction`);
      }
      check.text(record.note, `${path}.note`);
    }
  }

  const intracity = check.array(transport.intracity, 'transport.intracity');
  if (intracity) {
    for (const [index, network] of intracity.entries()) {
      const path = `transport.intracity[${index}]`;
      const record = check.object(network, path);
      if (!record) continue;
      check.text(record.cityId, `${path}.cityId`);
      check.numbers(record, ['roadLevel', 'railLevel', 'maxLevel'], path);
      if (record.construction !== null) {
        validateTransportConstruction(check, record.construction, `${path}.construction`);
        const construction = isRecord(record.construction) ? record.construction : null;
        if (construction && construction.kind !== 'road' && construction.kind !== 'rail') {
          check.fail(`${path}.construction.kind 必须是 road 或 rail`);
        }
      }
      check.text(record.note, `${path}.note`);
    }
  }

  const pendingSales = check.array(transport.pendingSales, 'transport.pendingSales');
  if (pendingSales) {
    for (const [index, sale] of pendingSales.entries()) {
      const path = `transport.pendingSales[${index}]`;
      const record = check.object(sale, path);
      if (!record) continue;
      check.integer(record.tick, `${path}.tick`);
      if (typeof record.path !== 'string' || !PENDING_SALE_PATHS.has(record.path)) {
        check.fail(`${path}.path 必须是合法跨城销售路径`);
      }
      check.texts(
        record,
        ['fromCityId', 'toCityId', 'corridorKey', 'sellerCompanyId'],
        path,
      );
      if (typeof record.buyerCompanyId !== 'string') {
        check.fail(`${path}.buyerCompanyId 必须是字符串`);
      }
      if (typeof record.good !== 'string' || !GOOD_ID_SET.has(record.good)) {
        check.fail(`${path}.good 必须是合法商品`);
      }
      check.numbers(record, ['qty', 'grossValue'], path);
      if (record.householdGroupId !== undefined) check.text(record.householdGroupId, `${path}.householdGroupId`);
    }
  }

  const lastMonth = check.object(transport.lastMonth, 'transport.lastMonth');
  if (!lastMonth) return;
  const statsPath = 'transport.lastMonth';
  check.integer(lastMonth.tick, `${statsPath}.tick`);
  check.numbers(
    lastMonth,
    [
      'demand',
      'capacity',
      'overloadRatio',
      'penaltyRate',
      'capacityLossTotal',
      'freightSubsidy',
      'maintenancePaid',
    ],
    statsPath,
  );
  check.text(lastMonth.note, `${statsPath}.note`);

  const corridors = check.array(lastMonth.corridors, `${statsPath}.corridors`);
  if (corridors) {
    for (const [index, corridor] of corridors.entries()) {
      const path = `${statsPath}.corridors[${index}]`;
      const record = check.object(corridor, path);
      if (!record) continue;
      check.texts(record, ['corridorKey', 'fromCityId', 'toCityId'], path);
      check.numbers(record, ['demand', 'capacity', 'overloadRatio', 'penaltyRate'], path);
    }
  }

  const intracityStats = check.array(lastMonth.intracity, `${statsPath}.intracity`);
  if (intracityStats) {
    for (const [index, entry] of intracityStats.entries()) {
      const path = `${statsPath}.intracity[${index}]`;
      const record = check.object(entry, path);
      if (!record) continue;
      check.text(record.cityId, `${path}.cityId`);
      check.numbers(record, ['demand', 'capacity', 'utilization', 'deliveryEfficiency'], path);
    }
  }

  const trades = check.array(lastMonth.trades, `${statsPath}.trades`);
  if (trades) {
    for (const [index, trade] of trades.entries()) {
      const path = `${statsPath}.trades[${index}]`;
      const record = check.object(trade, path);
      if (!record) continue;
      check.integer(record.tick, `${path}.tick`);
      if (typeof record.path !== 'string' || !PENDING_SALE_PATHS.has(record.path)) {
        check.fail(`${path}.path 必须是合法跨城销售路径`);
      }
      check.texts(
        record,
        ['corridorKey', 'fromCityId', 'toCityId', 'sellerCompanyId', 'buyerCompanyId'],
        path,
      );
      if (typeof record.good !== 'string' || !GOOD_ID_SET.has(record.good)) {
        check.fail(`${path}.good 必须是合法商品`);
      }
      check.numbers(
        record,
        ['qty', 'grossValue', 'sellerProceeds', 'capacityLoss', 'penaltyRate', 'demand', 'capacity'],
        path,
      );
      if (record.buyerRefund !== undefined) check.number(record.buyerRefund, `${path}.buyerRefund`);
    }
  }
}

function validateMarketTradeData(input: unknown): SaveModuleValidation {
  const check = new ShapeCheck();

  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: ['marketTrade 模块数据必须是对象'] };
  }

  const data = input as UnknownRecord;
  const cities = check.array(data.cities, 'cities');
  if (cities) {
    const ids = new Set<string>();
    for (const [index, city] of cities.entries()) {
      validateMarketTradeCity(check, city, index);
      const id = isRecord(city) ? city.id : undefined;
      if (typeof id === 'string' && id.length > 0) {
        if (ids.has(id)) check.fail(`marketTrade 城市 ID 重复：${id}`);
        ids.add(id);
      }
    }
  }

  validateTradeRoutes(check, data.tradeRoutes);
  validateAgreements(check, data.agreements);
  validateTransport(check, data.transport);

  return { ok: check.errors.length === 0, errors: check.errors };
}

export const marketTradeSaveModule: SaveModule<MarketTradeSaveData> = {
  id: 'marketTrade',
  version: MARKET_TRADE_SAVE_MODULE_VERSION,
  required: true,
  dependsOn: ['world'],
  ownedPaths: ['cities[].market', 'tradeRoutes', 'agreements', 'transport'],

  export(context: SaveExportContext): MarketTradeSaveData {
    const world = context.world;
    return cloneJson({
      cities: world.cities.map((city) => ({ id: city.id, market: city.market })),
      tradeRoutes: world.tradeRoutes,
      agreements: world.agreements,
      transport: world.transport,
    });
  },

  validate(data: unknown, version: number): SaveModuleValidation {
    if (version !== MARKET_TRADE_SAVE_MODULE_VERSION) {
      return {
        ok: false,
        errors: [
          `marketTrade 模块数据版本不受支持：${version}（当前支持 ${MARKET_TRADE_SAVE_MODULE_VERSION}）`,
        ],
      };
    }
    return validateMarketTradeData(data);
  },

  migrate(data: unknown, context: SaveModuleMigrationContext): MarketTradeSaveData {
    if (context.fromVersion === 0) {
      throw new Error('存档缺少 marketTrade 模块：市场/贸易/交通状态无法凭空重建');
    }
    if (context.fromVersion === MARKET_TRADE_SAVE_MODULE_VERSION) {
      return data as MarketTradeSaveData;
    }
    throw new Error(
      `不支持从 marketTrade 模块数据版本 ${context.fromVersion} 迁移到 ${context.toVersion}`,
    );
  },

  restore(data: MarketTradeSaveData, context: SaveRestoreContext): void {
    const world = context.world;
    for (const cityData of data.cities) {
      const city = context.cityOf(cityData.id);
      city.market = cityData.market;
    }
    world.tradeRoutes = data.tradeRoutes;
    world.agreements = data.agreements;
    world.transport = data.transport;
  },
};
