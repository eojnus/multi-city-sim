import type { SaveFile, WorldState } from '../contracts/types';
import { GAME_VERSION, SAVE_FORMAT_VERSION } from '../contracts/types';
import { GOOD_IDS } from '../companies/company';
import { checkInvariants } from './invariants';

export interface ParseResult {
  ok: boolean;
  world?: WorldState;
  save?: SaveFile;
  error?: string;
}

const ROLE_KEYS = ['management', 'production', 'sales', 'research'] as const;
const SECTOR_IDS = new Set([
  'agriculture',
  'fiber-farm',
  'textile',
  'food',
  'garment',
  'metal',
  'utility',
  'appliance',
]);
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

export function createSaveFile(world: WorldState, savedAt = new Date().toISOString()): SaveFile {
  return {
    formatVersion: SAVE_FORMAT_VERSION,
    gameVersion: GAME_VERSION,
    savedAt,
    world: deepClone(world),
  };
}

export function serializeSave(world: WorldState, savedAt = new Date().toISOString()): string {
  return JSON.stringify(createSaveFile(world, savedAt), null, 2);
}

export function parseSave(text: string): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { ok: false, error: `存档不是有效 JSON：${(error as Error).message}` };
  }
  if (!isRecord(parsed)) return { ok: false, error: '存档根节点不是对象' };

  const formatVersion = parsed.formatVersion;
  if (typeof formatVersion !== 'number' || !Number.isInteger(formatVersion)) {
    return { ok: false, error: '存档缺少有效的 formatVersion' };
  }
  if (formatVersion > SAVE_FORMAT_VERSION) {
    return {
      ok: false,
      error: `存档格式版本 ${formatVersion} 高于当前支持的 ${SAVE_FORMAT_VERSION}，请使用更新版本的游戏读取。`,
    };
  }
  if (formatVersion < 1) {
    return { ok: false, error: `不支持的存档格式版本 ${formatVersion}` };
  }

  try {
    const save = parsed as unknown as SaveFile;
    if (!isRecord(save.world)) return { ok: false, error: '存档缺少 world 数据' };
    const structureError = validateWorldStructure(save.world);
    if (structureError) return { ok: false, error: structureError };

    const world = save.world as WorldState;
    const problems = checkInvariants(world);
    if (problems.length > 0) {
      return {
        ok: false,
        error: `存档未通过不变量校验：${problems.slice(0, 3).join('；')}`,
      };
    }
    if (world.seed !== world.seed >>> 0) return { ok: false, error: '随机种子状态无效' };
    return { ok: true, world, save };
  } catch (error) {
    // 即使校验器遗漏了某个嵌套字段，也必须把异常变成可读的读取失败，而不是让 UI 崩溃。
    return { ok: false, error: `存档校验异常：${(error as Error).message}` };
  }
}

/**
 * 读取侧的结构校验。只返回第一个明确错误，避免 checkInvariants 在缺失字段上抛 TypeError。
 * 所有数值必须是有限数；所有必需对象/数组/字符串都必须存在且类型正确。
 */
export function validateWorldStructure(world: unknown): string | null {
  if (!isRecord(world)) return 'world 不是对象';
  if (!isInteger(world.seed)) return 'world.seed 必须是整数';
  if (!isInteger(world.rngState)) return 'world.rngState 必须是整数';
  if (!isRecord(world.time)) return 'world.time 无效';
  if (!isInteger(world.time.year) || !isInteger(world.time.month) || !isInteger(world.time.tick)) {
    return 'world.time 必须包含整数 year/month/tick';
  }
  if (!Array.isArray(world.cities) || world.cities.length === 0) return 'world.cities 无效';
  if (!Array.isArray(world.companies) || world.companies.length === 0) {
    return 'world.companies 无效';
  }
  if (!Array.isArray(world.tradeRoutes)) return 'world.tradeRoutes 无效';
  if (!Array.isArray(world.history)) return 'world.history 无效';
  if (!Array.isArray(world.log)) return 'world.log 无效';

  const playerError = validatePlayer(world.player);
  if (playerError) return playerError;

  const cityIds = new Set<string>();
  for (let index = 0; index < world.cities.length; index++) {
    const error = validateCity(world.cities[index], index);
    if (error) return error;
    const city = world.cities[index] as Record<string, unknown>;
    const id = city.id as string;
    if (cityIds.has(id)) return `城市 ID 重复：${id}`;
    cityIds.add(id);
  }

  const companyIds = new Set<string>();
  for (let index = 0; index < world.companies.length; index++) {
    const error = validateCompany(world.companies[index], index);
    if (error) return error;
    const company = world.companies[index] as Record<string, unknown>;
    const id = company.id as string;
    if (companyIds.has(id)) return `企业 ID 重复：${id}`;
    companyIds.add(id);
    if (!cityIds.has(company.cityId as string)) {
      return `企业 ${id} 引用了不存在的城市 ${String(company.cityId)}`;
    }
  }

  for (let index = 0; index < world.tradeRoutes.length; index++) {
    const error = validateTradeRoute(world.tradeRoutes[index], index);
    if (error) return error;
    const route = world.tradeRoutes[index] as Record<string, unknown>;
    if (!cityIds.has(route.fromCityId as string) || !cityIds.has(route.toCityId as string)) {
      return `贸易路线 ${String(route.id)} 引用了不存在的城市`;
    }
    if (!companyIds.has(route.fromCompanyId as string) || !companyIds.has(route.toCompanyId as string)) {
      return `贸易路线 ${String(route.id)} 引用了不存在的企业`;
    }
  }

  const player = world.player as Record<string, unknown>;
  if (!cityIds.has(player.homeCityId as string)) {
    return '玩家 homeCityId 引用了不存在的城市';
  }
  for (const holding of player.holdings as unknown[]) {
    if (!companyIds.has((holding as Record<string, unknown>).companyId as string)) {
      return '玩家持股引用了不存在的企业';
    }
  }

  for (let index = 0; index < world.history.length; index++) {
    const error = validateHistoryPoint(world.history[index], index);
    if (error) return error;
  }
  for (let index = 0; index < world.log.length; index++) {
    const error = validateLogEntry(world.log[index], index);
    if (error) return error;
  }

  if (!isRecord(world.lastTick)) return 'world.lastTick 无效';
  for (const key of ['productionRecords', 'tradeFlows', 'externalExports', 'migration', 'invariants']) {
    if (!Array.isArray(world.lastTick[key])) return `world.lastTick.${key} 必须是数组`;
  }
  const lastTickError = validateLastTick(world.lastTick);
  if (lastTickError) return lastTickError;

  return null;
}

function validateLastTick(value: Record<string, unknown>): string | null {
  for (let index = 0; index < (value.productionRecords as unknown[]).length; index++) {
    const record = (value.productionRecords as unknown[])[index];
    if (!isRecord(record)) return `lastTick.productionRecords[${index}] 不是对象`;
    for (const key of ['tick', 'qty', 'outputValue', 'inputValue', 'valueAdded']) {
      if (!isFiniteNumber(record[key])) return `lastTick.productionRecords[${index}].${key} 无效`;
    }
    if (typeof record.cityId !== 'string' || typeof record.companyId !== 'string') {
      return `lastTick.productionRecords[${index}] 主体无效`;
    }
    if (typeof record.good !== 'string' || !(GOOD_IDS as readonly string[]).includes(record.good)) {
      return `lastTick.productionRecords[${index}].good 无效`;
    }
    if (!Array.isArray(record.inputs)) return `lastTick.productionRecords[${index}].inputs 无效`;
  }
  for (let index = 0; index < (value.tradeFlows as unknown[]).length; index++) {
    const flow = (value.tradeFlows as unknown[])[index];
    if (!isRecord(flow)) return `lastTick.tradeFlows[${index}] 不是对象`;
    for (const key of ['tick', 'qty', 'unitPrice', 'value']) {
      if (!isFiniteNumber(flow[key])) return `lastTick.tradeFlows[${index}].${key} 无效`;
    }
    for (const key of ['routeId', 'fromCityId', 'toCityId', 'fromCompanyId', 'toCompanyId']) {
      if (typeof flow[key] !== 'string') return `lastTick.tradeFlows[${index}].${key} 无效`;
    }
    if (typeof flow.good !== 'string' || !(GOOD_IDS as readonly string[]).includes(flow.good)) {
      return `lastTick.tradeFlows[${index}].good 无效`;
    }
  }
  for (let index = 0; index < (value.externalExports as unknown[]).length; index++) {
    const entry = (value.externalExports as unknown[])[index];
    if (!isRecord(entry)) return `lastTick.externalExports[${index}] 不是对象`;
    if (typeof entry.cityId !== 'string' || typeof entry.note !== 'string') {
      return `lastTick.externalExports[${index}] 字段无效`;
    }
    if (typeof entry.good !== 'string' || !(GOOD_IDS as readonly string[]).includes(entry.good)) {
      return `lastTick.externalExports[${index}].good 无效`;
    }
    for (const key of ['tick', 'qty', 'unitPrice', 'value']) {
      if (!isFiniteNumber(entry[key])) return `lastTick.externalExports[${index}].${key} 无效`;
    }
  }
  for (let index = 0; index < (value.migration as unknown[]).length; index++) {
    const entry = (value.migration as unknown[])[index];
    if (!isRecord(entry)) return `lastTick.migration[${index}] 不是对象`;
    if (typeof entry.fromCityId !== 'string' || typeof entry.toCityId !== 'string') {
      return `lastTick.migration[${index}] 城市无效`;
    }
    if (!isFiniteNumber(entry.people) || !isFiniteNumber(entry.laborForce)) {
      return `lastTick.migration[${index}] 人数无效`;
    }
  }
  if (!(value.invariants as unknown[]).every((entry) => typeof entry === 'string')) {
    return 'lastTick.invariants 必须全是字符串';
  }
  return null;
}

function validatePlayer(value: unknown): string | null {
  if (!isRecord(value)) return 'world.player 无效';
  if (typeof value.name !== 'string') return 'player.name 无效';
  if (typeof value.homeCityId !== 'string') return 'player.homeCityId 无效';
  if (!isFiniteNumber(value.cash)) return 'player.cash 必须是有限数值';
  if (
    value.lastDividend !== undefined &&
    (!isFiniteNumber(value.lastDividend) || value.lastDividend < 0)
  ) {
    return 'player.lastDividend 必须是有限非负数';
  }
  if (
    value.dividendsReceived !== undefined &&
    (!isFiniteNumber(value.dividendsReceived) || value.dividendsReceived < 0)
  ) {
    return 'player.dividendsReceived 必须是有限非负数';
  }
  if (typeof value.note !== 'string') return 'player.note 无效';
  if (!Array.isArray(value.holdings)) return 'player.holdings 必须是数组';
  for (let index = 0; index < value.holdings.length; index++) {
    const holding = value.holdings[index];
    if (!isRecord(holding)) return `player.holdings[${index}] 不是对象`;
    if (typeof holding.companyId !== 'string') return `player.holdings[${index}].companyId 无效`;
    if (!isFiniteNumber(holding.shares) || holding.shares < 0) {
      return `player.holdings[${index}].shares 必须是有限非负数`;
    }
  }
  return null;
}

function validateCity(value: unknown, index: number): string | null {
  if (!isRecord(value)) return `cities[${index}] 不是对象`;
  const id = typeof value.id === 'string' ? value.id : `cities[${index}]`;
  for (const key of ['id', 'name', 'englishName', 'tagline', 'color']) {
    if (typeof value[key] !== 'string') return `城市 ${id}.${key} 无效`;
  }

  if (!isRecord(value.region)) return `城市 ${id} 缺少 region`;
  for (const key of ['x', 'y', 'radius']) {
    if (!isFiniteNumber(value.region[key])) return `城市 ${id}.region.${key} 必须是有限数值`;
  }

  const population = value.population;
  if (!isRecord(population)) return `城市 ${id} 缺少 population`;
  for (const key of ['total', 'employed', 'unemployed', 'nonLabor', 'laborForce']) {
    if (!isFiniteNumber(population[key])) return `城市 ${id}.population.${key} 必须是有限数值`;
  }

  const publicSector = value.publicSector;
  if (!isRecord(publicSector)) return `城市 ${id} 缺少 publicSector`;
  for (const key of ['jobs', 'employees', 'wageRate']) {
    if (!isFiniteNumber(publicSector[key])) return `城市 ${id}.publicSector.${key} 必须是有限数值`;
  }

  for (const key of [
    'treasury', 'incomeTaxRate', 'corporateTaxRate', 'unemploymentBenefit',
    'nonLaborTransfer', 'householdIncomeLastMonth', 'gdp',
  ]) {
    if (!isFiniteNumber(value[key])) return `城市 ${id}.${key} 必须是有限数值`;
  }

  const market = value.market;
  if (!isRecord(market)) return `城市 ${id} 缺少 market`;
  for (const goodId of GOOD_IDS) {
    const entry = market[goodId];
    const error = validateMarket(entry, `城市 ${id}.market.${goodId}`);
    if (error) return error;
  }

  if (!Array.isArray(value.gdpHistory)) return `城市 ${id}.gdpHistory 必须是数组`;
  for (let i = 0; i < value.gdpHistory.length; i++) {
    const point = value.gdpHistory[i];
    if (!isRecord(point) || !isFiniteNumber(point.tick) || !isFiniteNumber(point.value)) {
      return `城市 ${id}.gdpHistory[${i}] 无效`;
    }
  }

  const lastMonth = value.lastMonth;
  if (!isRecord(lastMonth)) return `城市 ${id} 缺少 lastMonth`;
  for (const key of [
    'householdIncome', 'consumerSpend', 'consumerBudget', 'benefitsPaid', 'incomeTax',
    'corporateTax', 'publicWageBill', 'gdp', 'migrationIn', 'migrationOut',
  ]) {
    if (!isFiniteNumber(lastMonth[key])) return `城市 ${id}.lastMonth.${key} 必须是有限数值`;
  }
  if (typeof lastMonth.note !== 'string') return `城市 ${id}.lastMonth.note 无效`;

  const technology = value.technology;
  if (!isRecord(technology)) return `城市 ${id} 缺少 technology`;
  for (const key of ['level', 'researchPoints', 'productivityMultiplier']) {
    if (!isFiniteNumber(technology[key])) return `城市 ${id}.technology.${key} 必须是有限数值`;
  }
  if (technology.status !== 'initial-only' || typeof technology.note !== 'string') {
    return `城市 ${id}.technology 状态无效`;
  }

  const politics = value.politics;
  if (!isRecord(politics)) return `城市 ${id} 缺少 politics`;
  if (!isFiniteNumber(politics.approval) || typeof politics.rulingParty !== 'string') {
    return `城市 ${id}.politics 无效`;
  }
  if (
    politics.electionInMonths !== null &&
    !isFiniteNumber(politics.electionInMonths)
  ) {
    return `城市 ${id}.politics.electionInMonths 无效`;
  }
  if (politics.status !== 'initial-only' || typeof politics.note !== 'string') {
    return `城市 ${id}.politics 状态无效`;
  }

  const realEstate = value.realEstate;
  if (!isRecord(realEstate)) return `城市 ${id} 缺少 realEstate`;
  for (const key of ['avgHomePrice', 'rentIndex', 'vacancyRate']) {
    if (!isFiniteNumber(realEstate[key])) return `城市 ${id}.realEstate.${key} 必须是有限数值`;
  }
  if (realEstate.status !== 'initial-only' || typeof realEstate.note !== 'string') {
    return `城市 ${id}.realEstate 状态无效`;
  }

  return null;
}

function validateMarket(value: unknown, path: string): string | null {
  if (!isRecord(value)) return `${path} 缺失`;
  if (typeof value.goodId !== 'string') return `${path}.goodId 无效`;
  for (const key of [
    'price', 'supply', 'demand', 'consumerDemand', 'producerDemand', 'sold',
    'unmetDemand', 'intercityImported', 'externalExport', 'closingStock',
    'lastPriceChangePct',
  ]) {
    if (!isFiniteNumber(value[key])) return `${path}.${key} 必须是有限数值`;
  }
  return null;
}

function validateCompany(value: unknown, index: number): string | null {
  if (!isRecord(value)) return `companies[${index}] 不是对象`;
  const id = typeof value.id === 'string' ? value.id : `companies[${index}]`;
  for (const key of ['id', 'name', 'cityId', 'note']) {
    if (typeof value[key] !== 'string') return `企业 ${id}.${key} 无效`;
  }
  if (typeof value.sector !== 'string' || !SECTOR_IDS.has(value.sector)) {
    return `企业 ${id}.sector 无效`;
  }
  if (typeof value.recipeOutput !== 'string' || !(GOOD_IDS as readonly string[]).includes(value.recipeOutput)) {
    return `企业 ${id}.recipeOutput 无效`;
  }
  for (const key of [
    'cash', 'debt', 'capacity', 'baseCapacity', 'maxCapacity', 'utilization',
    'employees', 'baseWageBill', 'jobDemand', 'wageRate', 'priceFactor', 'totalShares',
  ]) {
    if (!isFiniteNumber(value[key])) return `企业 ${id}.${key} 必须是有限数值`;
  }

  const roles = value.roles;
  if (!isRecord(roles)) return `企业 ${id} 缺少 roles`;
  for (const key of ROLE_KEYS) {
    if (!isFiniteNumber(roles[key])) return `企业 ${id}.roles.${key} 必须是有限数值`;
  }

  const inventory = value.inventory;
  if (!isRecord(inventory)) return `企业 ${id} 缺少 inventory`;
  for (const goodId of GOOD_IDS) {
    if (!isFiniteNumber(inventory[goodId])) return `企业 ${id}.inventory.${goodId} 必须是有限数值`;
  }

  const lastMonth = value.lastMonth;
  if (!isRecord(lastMonth)) return `企业 ${id} 缺少 lastMonth`;
  for (const key of [
    'revenue', 'inputCost', 'wagesPaid', 'wageArrears', 'interestPaid',
    'corporateTax', 'dividendsPaid', 'profit', 'produced', 'sold', 'exported',
    'unmetDemand', 'capacityChange',
  ]) {
    if (!isFiniteNumber(lastMonth[key])) return `企业 ${id}.lastMonth.${key} 必须是有限数值`;
  }
  return null;
}

function validateTradeRoute(value: unknown, index: number): string | null {
  if (!isRecord(value)) return `tradeRoutes[${index}] 不是对象`;
  const id = typeof value.id === 'string' ? value.id : `tradeRoutes[${index}]`;
  for (const key of ['id', 'fromCityId', 'toCityId', 'fromCompanyId', 'toCompanyId', 'note']) {
    if (typeof value[key] !== 'string') return `贸易路线 ${id}.${key} 无效`;
  }
  if (typeof value.good !== 'string' || !(GOOD_IDS as readonly string[]).includes(value.good)) {
    return `贸易路线 ${id}.good 无效`;
  }
  if (!isFiniteNumber(value.monthlyTarget) || !isFiniteNumber(value.distanceKm)) {
    return `贸易路线 ${id} 的数值字段无效`;
  }
  if (typeof value.active !== 'boolean') return `贸易路线 ${id}.active 无效`;
  return null;
}

function validateHistoryPoint(value: unknown, index: number): string | null {
  if (!isRecord(value)) return `history[${index}] 不是对象`;
  for (const key of ['tick', 'year', 'month', 'population', 'employed', 'unemployed', 'gdp', 'playerNetWorth']) {
    if (!isFiniteNumber(value[key])) return `history[${index}].${key} 必须是有限数值`;
  }
  return null;
}

function validateLogEntry(value: unknown, index: number): string | null {
  if (!isRecord(value)) return `log[${index}] 不是对象`;
  if (!isFiniteNumber(value.tick)) return `log[${index}].tick 必须是有限数值`;
  if (typeof value.kind !== 'string' || !LOG_KINDS.has(value.kind)) {
    return `log[${index}].kind 无效`;
  }
  if (typeof value.message !== 'string') return `log[${index}].message 无效`;
  return null;
}

export function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}
