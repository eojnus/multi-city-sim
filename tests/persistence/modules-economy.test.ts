// v1.7 存档系统：经济域 5 个真实存档模块的往返测试。
//
// 覆盖 task-7 要求的验收点（真实世界，不用假的完整测试）：
// 1) 模块契约：id/version=1/required/dependsOn（world 最先、其余依赖 world）/ownedPaths；
//    SaveModuleRegistry 接受这 5 个模块（归属路径不重叠、依赖可排序）。
// 2) 真实 `Simulation.create()` 推进 6 个月后逐个 export：数据等于源世界 owned 字段的 JSON 快照，
//    且导出不修改运行时世界。
// 3) `createCandidateWorld(worldMeta)` 后按依赖顺序 restore：owned 字段与源世界 JSON 深相等。
// 4) 未被这 5 个模块拥有的世界/城市字段保持候选世界默认值（不是被本组顺手恢复）。
// 5) export 后深度篡改运行时世界：已导出数据不受影响，用旧快照 restore 仍得到篡改前的世界。
// 6) validate 拒绝损坏数据（缺字段/类型错误）；migrate：fromVersion=0 抛错、=1 原样、其他抛不支持。

import { beforeAll, describe, expect, it } from 'vitest';
import { GAME_VERSION } from '../../src/simulation/contracts/types';
import type { WorldState } from '../../src/simulation/contracts/types';
import { Simulation } from '../../src/simulation/core/simulation';
import { SaveModuleRegistry } from '../../src/simulation/persistence/registry';
import { createCandidateWorld } from '../../src/simulation/persistence/scaffold';
import type {
  SaveModule,
  SaveModuleHeader,
  SaveModuleMigrationContext,
  SaveRestoreContext,
  SaveWorldMeta,
} from '../../src/simulation/persistence/types';
import { worldSaveModule } from '../../src/simulation/persistence/modules/worldSave';
import type { WorldSaveData } from '../../src/simulation/persistence/modules/worldSave';
import { populationSaveModule } from '../../src/simulation/persistence/modules/populationSave';
import type { PopulationSaveData } from '../../src/simulation/persistence/modules/populationSave';
import { companySaveModule } from '../../src/simulation/persistence/modules/companySave';
import type { CompanySaveData } from '../../src/simulation/persistence/modules/companySave';
import { marketTradeSaveModule } from '../../src/simulation/persistence/modules/marketTradeSave';
import type { MarketTradeSaveData } from '../../src/simulation/persistence/modules/marketTradeSave';
import { equipmentSaveModule } from '../../src/simulation/persistence/modules/equipmentSave';
import type { EquipmentSaveData } from '../../src/simulation/persistence/modules/equipmentSave';

/** 本组 5 个模块（注册/导出顺序：world 必须最先）。 */
const MODULES: readonly SaveModule[] = [
  worldSaveModule,
  populationSaveModule,
  companySaveModule,
  marketTradeSaveModule,
  equipmentSaveModule,
];

/** 每个模块 owned 字段的期望快照形状（对比用，不参与生产代码）。 */
interface EconomySnapshot {
  world: WorldSaveData;
  population: PopulationSaveData;
  company: CompanySaveData;
  marketTrade: MarketTradeSaveData;
  equipment: EquipmentSaveData;
}

function worldOwned(world: WorldState): WorldSaveData {
  return {
    seed: world.seed,
    rngState: world.rngState,
    time: { year: world.time.year, month: world.time.month, tick: world.time.tick },
    player: world.player,
    cities: world.cities.map((city) => ({
      id: city.id,
      name: city.name,
      englishName: city.englishName,
      tagline: city.tagline,
      color: city.color,
      region: city.region,
      gdp: city.gdp,
      gdpHistory: city.gdpHistory,
      lastMonth: city.lastMonth,
      technology: city.technology,
      realEstate: city.realEstate,
    })),
    history: world.history,
    log: world.log,
    notifications: world.notifications,
    lastTick: world.lastTick,
  };
}

function populationOwned(world: WorldState): PopulationSaveData {
  return {
    cities: world.cities.map((city) => ({
      id: city.id,
      population: city.population,
      publicSector: city.publicSector,
      workforce: city.workforce,
      housing: city.housing,
      householdIncomeLastMonth: city.householdIncomeLastMonth,
    })),
    households: world.households,
    investors: world.investors,
    householdFinance: world.householdFinance,
  };
}

function companyOwned(world: WorldState): CompanySaveData {
  return { companies: world.companies, lifecycle: world.lifecycle };
}

function marketTradeOwned(world: WorldState): MarketTradeSaveData {
  return {
    cities: world.cities.map((city) => ({ id: city.id, market: city.market })),
    tradeRoutes: world.tradeRoutes,
    agreements: world.agreements,
    transport: world.transport,
  };
}

function equipmentOwned(world: WorldState): EquipmentSaveData {
  return { equipmentMarket: world.equipmentMarket };
}

function snapshotOf(world: WorldState): EconomySnapshot {
  return {
    world: worldOwned(world),
    population: populationOwned(world),
    company: companyOwned(world),
    marketTrade: marketTradeOwned(world),
    equipment: equipmentOwned(world),
  };
}

function worldMetaOf(world: WorldState): SaveWorldMeta {
  return {
    tick: world.time.tick,
    year: world.time.year,
    month: world.time.month,
    randomState: world.rngState,
    seed: world.seed,
    gameVersion: GAME_VERSION,
  };
}

/** 以 JSON 口径比较深相等（与存档实际落盘一致：undefined 字段两边都会被丢弃）。 */
function expectJsonEqual(actual: unknown, expectedValue: unknown, message?: string): void {
  const actualJson = JSON.parse(JSON.stringify(actual));
  const expectedJson = JSON.parse(JSON.stringify(expectedValue));
  if (message) expect(actualJson, message).toEqual(expectedJson);
  else expect(actualJson).toEqual(expectedJson);
}

function expectJsonDifferent(actual: unknown, expectedValue: unknown, message?: string): void {
  const actualJson = JSON.parse(JSON.stringify(actual));
  const expectedJson = JSON.parse(JSON.stringify(expectedValue));
  if (message) expect(actualJson, message).not.toEqual(expectedJson);
  else expect(actualJson).not.toEqual(expectedJson);
}

/** 按模块声明的 dependsOn 做稳定拓扑排序（模拟协调器的恢复顺序）。 */
function modulesByDependency(): SaveModule[] {
  const ordered: SaveModule[] = [];
  const visiting = new Set<string>();
  const visit = (module: SaveModule): void => {
    if (ordered.includes(module)) return;
    if (visiting.has(module.id)) throw new Error(`模块依赖循环：${module.id}`);
    visiting.add(module.id);
    for (const dependencyId of module.dependsOn ?? []) {
      const dependency = MODULES.find((entry) => entry.id === dependencyId);
      if (!dependency) throw new Error(`模块 ${module.id} 依赖未注册模块 ${dependencyId}`);
      visit(dependency);
    }
    ordered.push(module);
  };
  for (const module of MODULES) visit(module);
  return ordered;
}

let sourceWorld: WorldState;
let sourceSnapshot: WorldState;
let meta: SaveWorldMeta;
let moduleData: Record<string, SaveModuleHeader>;
let expected: EconomySnapshot;

/** 模拟真实读档：模块数据来自存档 JSON 文本（undefined 字段已被丢弃）。 */
function parsedModuleData(): Record<string, SaveModuleHeader> {
  return JSON.parse(JSON.stringify(moduleData)) as Record<string, SaveModuleHeader>;
}

/** 在候选世界上按依赖顺序恢复 5 个模块（等价于协调器 restore 流程的手动版）。 */
function restoreInto(
  world: WorldState,
  data: Record<string, SaveModuleHeader>,
  worldMeta: SaveWorldMeta,
): void {
  const context: SaveRestoreContext = {
    world,
    moduleData: data,
    meta: worldMeta,
    warn: () => undefined,
    cityOf: (cityId) => {
      const city = world.cities.find((entry) => entry.id === cityId);
      if (!city) throw new Error(`引用了不存在的城市：${cityId}`);
      return city;
    },
    companyOf: (companyId) => {
      const company = world.companies.find((entry) => entry.id === companyId);
      if (!company) throw new Error(`引用了不存在的企业：${companyId}`);
      return company;
    },
  };
  for (const module of modulesByDependency()) {
    const header = data[module.id];
    if (!header) throw new Error(`缺少模块数据：${module.id}`);
    module.restore(header.data, context);
  }
}

function restoreCandidate(
  data: Record<string, SaveModuleHeader> = parsedModuleData(),
  worldMeta: SaveWorldMeta = meta,
): WorldState {
  const world = createCandidateWorld(worldMeta);
  restoreInto(world, data, worldMeta);
  return world;
}

beforeAll(() => {
  const simulation = Simulation.create();
  for (let month = 0; month < 6; month += 1) {
    const result = simulation.tick();
    if (!result.ok) throw new Error(`推进第 ${month + 1} 月失败：${result.error ?? '未知错误'}`);
  }
  sourceWorld = simulation.state;

  // 先按 JSON 口径抓一份独立快照：篡改测试的期望值与它比较，而不是与被篡改的运行时世界比较。
  sourceSnapshot = JSON.parse(JSON.stringify(sourceWorld)) as WorldState;
  meta = worldMetaOf(sourceWorld);
  expected = snapshotOf(sourceSnapshot);

  const beforeExport = JSON.stringify(sourceWorld);
  moduleData = {};
  for (const module of MODULES) {
    moduleData[module.id] = {
      version: module.version,
      required: module.required,
      data: module.export({ world: sourceWorld, warn: () => undefined }),
    };
  }
  // export 只读世界：导出前后世界 JSON 必须完全一致。
  expect(JSON.stringify(sourceWorld), 'export 不得修改运行时世界').toBe(beforeExport);
}, 180_000);

describe('v1.7 存档：经济域模块契约', () => {
  it('5 个模块声明正确的 id/version/required/dependsOn/ownedPaths，注册表接受其归属划分', () => {
    expect(MODULES.map((module) => module.id)).toEqual([
      'world',
      'population',
      'company',
      'marketTrade',
      'equipment',
    ]);
    for (const module of MODULES) {
      expect(module.version, `${module.id}.version`).toBe(1);
      expect(module.required, `${module.id}.required`).toBe(true);
    }
    expect(worldSaveModule.dependsOn ?? []).toEqual([]);
    for (const module of MODULES.slice(1)) {
      expect(module.dependsOn ?? [], `${module.id}.dependsOn`).toEqual(['world']);
    }

    const expectedPaths: Record<string, string[]> = {
      world: [
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
      population: [
        'cities[].population',
        'cities[].publicSector',
        'cities[].workforce',
        'cities[].housing',
        'cities[].householdIncomeLastMonth',
        'households',
        'investors',
        'householdFinance',
      ],
      company: ['companies', 'lifecycle'],
      marketTrade: ['cities[].market', 'tradeRoutes', 'agreements', 'transport'],
      equipment: ['equipmentMarket'],
    };
    for (const module of MODULES) {
      expect([...module.ownedPaths].sort(), `${module.id}.ownedPaths`).toEqual(
        [...expectedPaths[module.id]!].sort(),
      );
    }

    // 真实注册表按依赖顺序注册 5 个模块：ID 合法、归属路径互不重叠（含祖先路径）、world 最先。
    const registry = new SaveModuleRegistry();
    for (const module of modulesByDependency()) registry.register(module);
    expect(registry.list().map((module) => module.id)).toEqual(
      modulesByDependency().map((module) => module.id),
    );
    expect(registry.requiredIds().sort()).toEqual(
      ['company', 'equipment', 'marketTrade', 'population', 'world'].sort(),
    );
  });
});

describe('v1.7 存档：经济域模块导出', () => {
  it('export 返回纯数据：与源世界 owned 字段 JSON 深相等，且不引用世界内部对象', () => {
    expect(moduleData['world']!.version).toBe(1);
    expect(moduleData['world']!.required).toBe(true);

    expectJsonEqual(moduleData['world']!.data, expected.world);
    expectJsonEqual(moduleData['population']!.data, expected.population);
    expectJsonEqual(moduleData['company']!.data, expected.company);
    expectJsonEqual(moduleData['marketTrade']!.data, expected.marketTrade);
    expectJsonEqual(moduleData['equipment']!.data, expected.equipment);

    // 快照必须是独立对象，而不是世界内部容器的引用。
    expect(moduleData['world']!.data).not.toBe(sourceWorld as unknown as object);
    expect((moduleData['company']!.data as CompanySaveData).companies).not.toBe(sourceWorld.companies);
    expect((moduleData['population']!.data as PopulationSaveData).households).not.toBe(
      sourceWorld.households,
    );
    expect((moduleData['equipment']!.data as EquipmentSaveData).equipmentMarket).not.toBe(
      sourceWorld.equipmentMarket,
    );
    expect((moduleData['marketTrade']!.data as MarketTradeSaveData).transport).not.toBe(
      sourceWorld.transport,
    );

    // 落盘口径（JSON 解析后）仍必须通过各模块 validate。
    const parsed = parsedModuleData();
    for (const module of MODULES) {
      const result = module.validate(parsed[module.id]!.data, module.version);
      expect(result.ok, `${module.id} 落盘数据校验失败：${result.errors.slice(0, 3).join('；')}`).toBe(true);
    }
  });
});

describe('v1.7 存档：经济域模块恢复', () => {
  it('候选世界按依赖顺序恢复后：5 个模块拥有的字段与源世界 JSON 深相等', () => {
    const candidate = restoreCandidate();
    const restored = snapshotOf(candidate);

    expectJsonEqual(restored.world, expected.world);
    expectJsonEqual(restored.population, expected.population);
    expectJsonEqual(restored.company, expected.company);
    expectJsonEqual(restored.marketTrade, expected.marketTrade);
    expectJsonEqual(restored.equipment, expected.equipment);

    // 城市/企业数量与顺序必须保持（其余模块按 id 查找依赖这个顺序与骨架）。
    expect(candidate.cities.map((city) => city.id)).toEqual(sourceWorld.cities.map((city) => city.id));
    expect(candidate.companies.map((company) => company.id)).toEqual(
      sourceWorld.companies.map((company) => company.id),
    );
    expect(candidate.time).toEqual(sourceWorld.time);
    expect(candidate.seed).toBe(sourceWorld.seed);
    expect(candidate.rngState).toBe(sourceWorld.rngState);
    expect(candidate.history.length).toBe(sourceWorld.history.length);
    expect(candidate.log.length).toBe(sourceWorld.log.length);
    expect(candidate.cities[0]!.population.total).toBe(sourceWorld.cities[0]!.population.total);
    expect(candidate.cities[0]!.market.grain.price).toBe(sourceWorld.cities[0]!.market.grain.price);
    expect(candidate.lifecycle.nextFoundingNumber).toBe(sourceWorld.lifecycle.nextFoundingNumber);
    expect(candidate.equipmentMarket.offers.length).toBe(sourceWorld.equipmentMarket.offers.length);
  });

  it('未被本组拥有的字段保持候选世界默认值（未被顺手恢复）', () => {
    const candidate = restoreCandidate();
    const pristine = createCandidateWorld(meta);

    const unownedWorldFields = [
      'securities',
      'governance',
      'politics',
      'policies',
      'fiscal',
      'management',
      'banking',
      'bonds',
      'taxes',
    ];
    const candidateRecord = candidate as unknown as Record<string, unknown>;
    const pristineRecord = pristine as unknown as Record<string, unknown>;
    for (const field of unownedWorldFields) {
      expectJsonEqual(candidateRecord[field], pristineRecord[field], `${field} 应保持候选默认值`);
    }

    // world 模块只建立城市骨架；treasury/government/politics 等城市字段应由其他模块恢复。
    const unownedCityFields = [
      'treasury',
      'incomeTaxRate',
      'corporateTaxRate',
      'unemploymentBenefit',
      'nonLaborTransfer',
      'fiscalExpenseBaseline',
      'politics',
      'government',
      'gdpWindow',
      'gdpEstimate',
      'bankruptcy',
    ];
    for (const city of candidate.cities) {
      for (const field of unownedCityFields) {
        expect(
          Object.prototype.hasOwnProperty.call(city, field),
          `城市 ${city.id} 不应被本组恢复字段 ${field}`,
        ).toBe(false);
      }
    }

    // 源世界里这些字段有真实权威数据：证明上面对比的是“候选默认”，不是两边都为空的巧合。
    expect(sourceWorld.banking.snapshots.length).toBeGreaterThan(0);
    expect(sourceWorld.securities.holdings.length).toBeGreaterThan(0);
    expect(sourceWorld.cities[0]!.politics.status).toBe('active');
    expect(typeof sourceWorld.cities[0]!.treasury).toBe('number');
  });
});

describe('v1.7 存档：经济域模块校验与迁移', () => {
  it('validate 拒绝损坏数据；migrate 对 v0 缺失/未知版本抛错、对 v1 原样返回', () => {
    const corruptionById: Record<string, unknown> = {
      world: { ...(moduleData['world']!.data as Record<string, unknown>), seed: '不是数字' },
      population: { ...(moduleData['population']!.data as Record<string, unknown>), households: null },
      company: { ...(moduleData['company']!.data as Record<string, unknown>), companies: null },
      marketTrade: {
        ...(moduleData['marketTrade']!.data as Record<string, unknown>),
        transport: null,
      },
      equipment: {
        ...(moduleData['equipment']!.data as Record<string, unknown>),
        equipmentMarket: null,
      },
    };

    for (const module of MODULES) {
      const data = moduleData[module.id]!.data;
      const valid = module.validate(data, module.version);
      expect(valid.ok, `${module.id} 正常数据应通过：${valid.errors.slice(0, 3).join('；')}`).toBe(
        true,
      );

      const corrupted = module.validate(corruptionById[module.id], module.version);
      expect(corrupted.ok, `${module.id} 损坏数据应被拒绝`).toBe(false);
      expect(corrupted.errors.length, `${module.id} 应给出具体错误`).toBeGreaterThan(0);

      // 版本不是当前版本时也必须拒绝。
      expect(module.validate(data, module.version + 1).ok).toBe(false);

      const migrationContext = (fromVersion: number): SaveModuleMigrationContext => ({
        moduleId: module.id,
        fromVersion,
        toVersion: module.version,
        warn: () => undefined,
      });
      expect(() => module.migrate(undefined, migrationContext(0))).toThrow();
      expect(module.migrate(data, migrationContext(1))).toBe(data);
      expect(() => module.migrate(data, migrationContext(2))).toThrow(/不支持/);
    }

    // 嵌套字段类型错误（不只是顶层缺失）也要被拒绝。
    const brokenCompany = JSON.parse(JSON.stringify(moduleData['company']!.data)) as CompanySaveData;
    (brokenCompany.companies[0] as unknown as Record<string, unknown>)['cash'] = '不是数字';
    expect(companySaveModule.validate(brokenCompany, 1).ok).toBe(false);

    const brokenWorld = JSON.parse(JSON.stringify(moduleData['world']!.data)) as WorldSaveData;
    brokenWorld.cities[0]!.lastMonth.gdp = Number.NaN;
    expect(worldSaveModule.validate(brokenWorld, 1).ok).toBe(false);
  });
});

/** 深度篡改运行时世界：每个模块 owned 的嵌套字段都要改到，才能验证 export 是深快照。 */
function tamperWorld(world: WorldState): void {
  world.seed += 1;
  world.rngState = (world.rngState + 1) >>> 0;
  world.time.tick += 1;
  world.time.month = world.time.month === 12 ? 1 : world.time.month + 1;
  if (world.time.month === 1) world.time.year += 1;

  world.player.name = `${world.player.name}-篡改`;
  world.player.cash += 1;
  if (world.player.holdings.length > 0) world.player.holdings[0]!.shares += 1;
  else world.player.holdings.push({ companyId: 'tampered-company', shares: 1 });

  const city = world.cities[0]!;
  city.name = `${city.name}-篡改`;
  city.region.x += 1;
  city.gdp += 1;
  if (city.gdpHistory.length > 0) city.gdpHistory[0]!.value += 1;
  else city.gdpHistory.push({ tick: world.time.tick, value: 1 });
  city.lastMonth.gdp += 1;
  city.technology.level += 1;
  city.realEstate.avgHomePrice += 1;
  city.population.total += 1;
  city.publicSector.jobs += 1;
  city.workforce.skillLevel = Math.min(1, city.workforce.skillLevel + 0.01);
  city.housing.units += 1;
  city.householdIncomeLastMonth += 1;
  city.market.grain.price += 1;

  if (world.history.length > 0) world.history[0]!.gdp += 1;
  else {
    world.history.push({
      tick: world.time.tick,
      year: world.time.year,
      month: world.time.month,
      population: 0,
      employed: 0,
      unemployed: 0,
      gdp: 0,
      playerNetWorth: 0,
    });
  }
  if (world.log.length > 0) world.log[0]!.message += '-篡改';
  else world.log.push({ tick: world.time.tick, kind: 'system', message: '篡改' });
  world.notifications.push({
    id: 'tampered-notification',
    tick: world.time.tick,
    audience: 'personal',
    kind: 'market',
    priority: 'normal',
    title: '篡改',
    body: '篡改',
    read: false,
  });
  world.lastTick.invariants.push('tampered');
  world.lastTick.productionRecords.push({
    tick: world.time.tick,
    cityId: city.id,
    companyId: 'tampered-company',
    good: 'grain',
    qty: 0,
    outputValue: 0,
    inputValue: 0,
    valueAdded: 0,
    inputs: [],
  });

  const company = world.companies[0]!;
  company.cash += 1;
  company.inventory.grain += 1;
  if (company.inventoryCost) company.inventoryCost.grain += 1;
  company.equipment.farm += 1;
  if (company.maintenanceBase) company.maintenanceBase.farm += 1;
  world.lifecycle.nextFoundingNumber += 1;

  const group = world.households.groups[0]!;
  group.cash += 1;
  group.lastMonth.income += 1;
  if (world.households.lastStats.length > 0) world.households.lastStats[0]!.totalCash += 1;
  if (world.households.investorFundingHistory && world.households.investorFundingHistory.length > 0) {
    world.households.investorFundingHistory[0]!.amount += 1;
  }
  world.investors[0]!.cash += 1;
  world.householdFinance.nextLoanNumber += 1;
  if (world.householdFinance.loans.length > 0) world.householdFinance.loans[0]!.outstanding += 1;
  if (world.householdFinance.budgets.length > 0) world.householdFinance.budgets[0]!.cash += 1;

  if (world.tradeRoutes.length > 0) world.tradeRoutes[0]!.monthlyTarget += 1;
  if (world.agreements.length > 0) world.agreements[0]!.title += '-篡改';
  world.transport.lastMonth.tick += 1;
  if (world.transport.links.length > 0) world.transport.links[0]!.level += 1;
  if (world.transport.intracity.length > 0) world.transport.intracity[0]!.roadLevel += 1;

  world.equipmentMarket.initialStock.farm += 1;
  world.equipmentMarket.lastMonthSold.farm += 1;
  if (!world.equipmentMarket.capitalizedThisTick) world.equipmentMarket.capitalizedThisTick = {};
  world.equipmentMarket.capitalizedThisTick.grain =
    (world.equipmentMarket.capitalizedThisTick.grain ?? 0) + 1;
  if (world.equipmentMarket.offers.length > 0) world.equipmentMarket.offers[0]!.askPrice += 1;
  if (world.equipmentMarket.maintenanceMonth) {
    world.equipmentMarket.maintenanceMonth.totalDue += 1;
  }
  if (
    world.equipmentMarket.maintenanceHistory &&
    world.equipmentMarket.maintenanceHistory.length > 0
  ) {
    world.equipmentMarket.maintenanceHistory[0]!.totalDue += 1;
  }
}

describe('v1.7 存档：经济域模块快照隔离', () => {
  it('export 后深度篡改世界：已导出数据不受影响，用旧快照恢复仍等于篡改前世界', () => {
    // 篡改前：导出数据与期望快照一致。
    for (const module of MODULES) {
      const key = module.id as keyof EconomySnapshot;
      expectJsonEqual(moduleData[module.id]!.data, expected[key], `${module.id} 篡改前快照`);
    }

    tamperWorld(sourceWorld);

    // 篡改确实修改了每个模块 owned 的嵌套数据（否则下面的隔离断言无意义）。
    expectJsonDifferent(worldOwned(sourceWorld), expected.world, 'world 快照应能检测到篡改');
    expectJsonDifferent(populationOwned(sourceWorld), expected.population, 'population 快照应能检测到篡改');
    expectJsonDifferent(companyOwned(sourceWorld), expected.company, 'company 快照应能检测到篡改');
    expectJsonDifferent(marketTradeOwned(sourceWorld), expected.marketTrade, 'marketTrade 快照应能检测到篡改');
    expectJsonDifferent(equipmentOwned(sourceWorld), expected.equipment, 'equipment 快照应能检测到篡改');

    // 已导出（篡改前）的模块数据不应被世界后续变更污染。
    for (const module of MODULES) {
      const key = module.id as keyof EconomySnapshot;
      expectJsonEqual(moduleData[module.id]!.data, expected[key], `${module.id} 导出数据被污染`);
    }

    // 用篡改前导出的数据恢复：得到篡改前的世界，而不是被污染的运行时世界。
    const restored = restoreCandidate(parsedModuleData());
    const restoredSnapshot = snapshotOf(restored);
    expectJsonEqual(restoredSnapshot.world, expected.world);
    expectJsonEqual(restoredSnapshot.population, expected.population);
    expectJsonEqual(restoredSnapshot.company, expected.company);
    expectJsonEqual(restoredSnapshot.marketTrade, expected.marketTrade);
    expectJsonEqual(restoredSnapshot.equipment, expected.equipment);
    expectJsonDifferent(worldOwned(restored), worldOwned(sourceWorld));
  });
});
