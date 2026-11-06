// v1.7 存档：财政域 6 个真实模块（banking/government/bonds/securities/management/politics）测试。
//
// 覆盖三条契约：
// 1) 真实世界（Simulation.create() 推进 6 个月）逐模块 export → 候选世界按依赖顺序 restore →
//    每个模块 ownedPaths 声明的字段与真实世界 JSON 深相等，且未拥有字段不被写；
// 2) export 返回纯数据：导出后篡改真实世界不影响已导出数据（无引用别名）；
// 3) validate/migrate 契约：version=1 数据通过校验、形状损坏被拒绝；migrate(0) 抛错、
//    migrate(1) 原样返回、migrate(2+) 抛不支持。
//
// world 模块：本文件用内联最小 stub（只导出/恢复
// seed/rngState/time/cities[{id}]/player/history/log/notifications/lastTick）代替 M1 的 worldSave，
// 以保持本测试只依赖本任务写作用域（task-8 允许）；真实 worldSave + 全部模块的注册/归属由 Lead 的
// tests/persistence/ownership.test.ts 与集成测试覆盖。同时在“模块注册与协调器导出”用例中用真实
// SaveModuleRegistry/SaveCoordinator 验证 world stub + 6 财政域模块的 ownedPaths 不重叠且可整体导出。

import { beforeAll, describe, expect, it } from 'vitest';
import type { WorldState } from '../../src/simulation/contracts/types';
import { GAME_VERSION } from '../../src/simulation/contracts/types';
import { Simulation } from '../../src/simulation/core/simulation';
import { SaveModuleRegistry } from '../../src/simulation/persistence/registry';
import { SaveCoordinator } from '../../src/simulation/persistence/saveCoordinator';
import { createCandidateWorld } from '../../src/simulation/persistence/scaffold';
import type {
  SaveExportContext,
  SaveModule,
  SaveModuleHeader,
  SaveModuleMigrationContext,
  SaveRestoreContext,
} from '../../src/simulation/persistence/types';
import {
  MODULE_SAVE_FORMAT_VERSION,
  MODULE_SAVE_KIND,
} from '../../src/simulation/persistence/types';
import { bankingSaveModule } from '../../src/simulation/persistence/modules/bankingSave';
import { bondsSaveModule } from '../../src/simulation/persistence/modules/bondsSave';
import type { GovernmentSaveData } from '../../src/simulation/persistence/modules/governmentSave';
import { governmentSaveModule } from '../../src/simulation/persistence/modules/governmentSave';
import { managementSaveModule } from '../../src/simulation/persistence/modules/managementSave';
import type { PoliticsSaveData } from '../../src/simulation/persistence/modules/politicsSave';
import { politicsSaveModule } from '../../src/simulation/persistence/modules/politicsSave';
import { securitiesSaveModule } from '../../src/simulation/persistence/modules/securitiesSave';

// ---------------------------------------------------------------- world 模块最小 stub（M1 的替身）

interface WorldStubData {
  seed: number;
  rngState: number;
  time: WorldState['time'];
  cities: { id: string }[];
  player: WorldState['player'];
  history: WorldState['history'];
  log: WorldState['log'];
  notifications: WorldState['notifications'];
  lastTick: WorldState['lastTick'];
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const worldStubModule: SaveModule<WorldStubData> = {
  id: 'world',
  version: 1,
  required: true,
  ownedPaths: [
    'seed',
    'rngState',
    'time',
    'cities[].id',
    'player',
    'history',
    'log',
    'notifications',
    'lastTick',
  ],
  export(context: SaveExportContext): WorldStubData {
    const { world } = context;
    return cloneJson({
      seed: world.seed,
      rngState: world.rngState,
      time: world.time,
      cities: world.cities.map((city) => ({ id: city.id })),
      player: world.player,
      history: world.history,
      log: world.log,
      notifications: world.notifications,
      lastTick: world.lastTick,
    });
  },
  validate(data: unknown): { ok: boolean; errors: string[] } {
    if (typeof data !== 'object' || data === null) {
      return { ok: false, errors: ['world stub 数据必须是对象'] };
    }
    return { ok: true, errors: [] };
  },
  migrate(data: unknown, context: SaveModuleMigrationContext): WorldStubData {
    if (context.fromVersion === 0) throw new Error('world 模块不可缺失');
    return data as WorldStubData;
  },
  restore(data: WorldStubData, context: SaveRestoreContext): void {
    const { world } = context;
    world.seed = data.seed;
    world.rngState = data.rngState;
    world.time = cloneJson(data.time);
    world.player = cloneJson(data.player);
    world.history = cloneJson(data.history);
    world.log = cloneJson(data.log);
    world.notifications = cloneJson(data.notifications);
    world.lastTick = cloneJson(data.lastTick);
    // world 模块建立城市骨架；财政域模块随后按 cityId 填充自己的字段。
    world.cities = data.cities.map(
      (city) => ({ id: city.id }) as unknown as WorldState['cities'][number],
    );
  },
};

// ---------------------------------------------------------------- 财政域 6 模块

const financeModules: readonly SaveModule[] = [
  bankingSaveModule,
  governmentSaveModule,
  bondsSaveModule,
  securitiesSaveModule,
  managementSaveModule,
  politicsSaveModule,
];

/** 恢复顺序：world 必须先建立城市骨架（其余模块都依赖 world）。 */
const restoreOrder: readonly SaveModule[] = [worldStubModule, ...financeModules];

function makeExportContext(world: WorldState, warnings: string[]): SaveExportContext {
  return { world, warn: (message) => warnings.push(message) };
}

function makeMigrationContext(fromVersion: number): SaveModuleMigrationContext {
  return { moduleId: 'test', fromVersion, toVersion: 1, warn: () => undefined };
}

/** 按 ownedPaths 语法读取字段值（`cities[].treasury` → 每城 treasury 的数组）。 */
function valuesAtPath(root: unknown, path: string): unknown[] {
  let current: unknown[] = [root];
  for (const segment of path.split('.')) {
    const isArray = segment.endsWith('[]');
    const key = isArray ? segment.slice(0, -2) : segment;
    const next: unknown[] = [];
    for (const value of current) {
      const child = (value as Record<string, unknown>)[key];
      if (isArray) {
        if (Array.isArray(child)) next.push(...child);
      } else {
        next.push(child);
      }
    }
    current = next;
  }
  return current;
}

function makeRestoreContext(
  world: WorldState,
  meta: SaveRestoreContext['meta'],
  moduleData: Record<string, SaveModuleHeader>,
  warnings: string[],
): SaveRestoreContext {
  return {
    world,
    moduleData,
    meta,
    warn: (message) => warnings.push(message),
    cityOf: (cityId) => {
      const city = world.cities.find((entry) => entry.id === cityId);
      if (!city) throw new Error(`恢复引用了不存在的城市：${cityId}`);
      return city;
    },
    companyOf: (companyId) => {
      const company = world.companies.find((entry) => entry.id === companyId);
      if (!company) throw new Error(`恢复引用了不存在的企业：${companyId}`);
      return company;
    },
  };
}

// ---------------------------------------------------------------- 真实世界（6 个月）

let realWorld: WorldState;
let worldStubData: WorldStubData;
/** 各模块 export 的结果（在 beforeAll 中一次性导出，后续测试只读/克隆）。 */
const exportedData = new Map<string, unknown>();
const exportWarnings: string[] = [];

beforeAll(
  () => {
    const simulation = Simulation.create();
    for (let month = 0; month < 6; month += 1) simulation.tick();
    realWorld = simulation.state;

    const context = makeExportContext(realWorld, exportWarnings);
    for (const module of restoreOrder) {
      exportedData.set(module.id, module.export(context));
    }
    worldStubData = exportedData.get('world') as WorldStubData;
  },
  600_000,
);

describe('v1.7 财政域存档模块：真实世界数据 sanity', () => {
  it('6 个月真实世界包含非空的财政/银行/政治账本（不是空世界深相等）', () => {
    expect(realWorld.cities.length).toBeGreaterThan(0);
    expect(realWorld.fiscal.ledger.length).toBeGreaterThan(0);
    expect(realWorld.banking.deposits.length).toBeGreaterThan(0);
    expect(realWorld.taxes.historyByCity).not.toEqual({});
    expect(realWorld.politics.cities.length).toBe(realWorld.cities.length);
    expect(realWorld.policies.active.length + realWorld.policies.history.length).toBeGreaterThan(0);
    // 当前世界 bonds 账本存在，导出不应触发“按空账本导出”的兜底 warning。
    expect(exportWarnings).toEqual([]);
  });
});

describe('v1.7 财政域存档模块：模块注册与协调器导出', () => {
  it('7 个模块（world stub + 6 财政域）归属路径不重叠，可注册并整体导出', () => {
    const registry = new SaveModuleRegistry();
    registry.register(worldStubModule);
    for (const module of financeModules) registry.register(module);
    expect(registry.list().map((module) => module.id)).toEqual([
      'world',
      'banking',
      'government',
      'bonds',
      'securities',
      'management',
      'politics',
    ]);
    expect(registry.requiredIds()).toHaveLength(7);

    const coordinator = new SaveCoordinator({
      registry,
      hooks: {
        // 本测试只验证导出与模块装配；完整世界结构/不变量校验由 Lead 的集成测试负责。
        validateWorldStructure: () => null,
        checkInvariants: () => [],
      },
    });
    const result = coordinator.exportSave(realWorld);
    expect(result.ok, result.error).toBe(true);
    expect(result.text).toBeTruthy();
    const document = JSON.parse(result.text as string) as {
      formatVersion: number;
      kind: string;
      worldMeta: { tick: number; seed: number };
      modules: Record<string, { version: number; required: boolean; data: unknown }>;
    };
    expect(document.formatVersion).toBe(MODULE_SAVE_FORMAT_VERSION);
    expect(document.kind).toBe(MODULE_SAVE_KIND);
    expect(document.worldMeta.tick).toBe(realWorld.time.tick);
    expect(document.worldMeta.seed).toBe(realWorld.seed);
    expect(Object.keys(document.modules).sort()).toEqual(
      ['banking', 'bonds', 'government', 'management', 'politics', 'securities', 'world'].sort(),
    );
    for (const module of financeModules) {
      const header = document.modules[module.id];
      expect(header, `缺少模块 ${module.id}`).toBeTruthy();
      expect(header?.version).toBe(1);
      expect(header?.required).toBe(true);
    }
  });
});

describe('v1.7 财政域存档模块：export → 候选世界 restore → ownedPaths 深相等', () => {
  it('6 模块按依赖恢复后，自己拥有的字段与真实世界 JSON 深相等', () => {
    const meta: SaveRestoreContext['meta'] = {
      tick: realWorld.time.tick,
      year: realWorld.time.year,
      month: realWorld.time.month,
      randomState: realWorld.rngState,
      seed: realWorld.seed,
      gameVersion: GAME_VERSION,
    };
    const candidate = createCandidateWorld(meta);
    const moduleData: Record<string, SaveModuleHeader> = {};
    for (const module of restoreOrder) {
      moduleData[module.id] = {
        version: module.version,
        required: module.required,
        data: exportedData.get(module.id),
      };
    }
    const restoreWarnings: string[] = [];
    const context = makeRestoreContext(candidate, meta, moduleData, restoreWarnings);

    // 先放一个“非本模块字段”的哨兵，验证恢复只写 ownedPaths。
    candidate.companies = [
      { id: 'sentinel-company' } as unknown as WorldState['companies'][number],
    ];
    candidate.investors = [
      { id: 'sentinel-investor' } as unknown as WorldState['investors'][number],
    ];

    for (const module of restoreOrder) {
      if (module.id === 'world') worldStubModule.restore(worldStubData, context);
      const data = exportedData.get(module.id);
      module.restore(data, context);
      if (module.afterRestore) module.afterRestore(context);
    }

    for (const module of financeModules) {
      for (const path of module.ownedPaths) {
        const expected = JSON.stringify(valuesAtPath(realWorld, path));
        const actual = JSON.stringify(valuesAtPath(candidate, path));
        expect(actual, `${module.id} 的 ${path} 恢复后与真实世界不一致`).toBe(expected);
      }
    }

    // 未拥有的字段保持候选世界原值（恢复不得写别人的字段）。
    expect(candidate.companies).toHaveLength(1);
    expect(candidate.companies[0]?.id).toBe('sentinel-company');
    expect(candidate.investors[0]?.id).toBe('sentinel-investor');
    // householdFinance 归 population 模块（M1），banking 模块不得触碰它。
    expect(candidate.householdFinance.loans).toHaveLength(0);
    expect(candidate.householdFinance.nextLoanNumber).toBe(1);
    // world stub 拥有的字段应已恢复。
    expect(candidate.seed).toBe(realWorld.seed);
    expect(candidate.time.tick).toBe(realWorld.time.tick);
    expect(candidate.cities.map((city) => city.id)).toEqual(realWorld.cities.map((city) => city.id));
  });

  it('恢复按 context.cityOf(id) 关联城市：数据里有候选世界不存在的城市时抛错', () => {
    const meta: SaveRestoreContext['meta'] = {
      tick: realWorld.time.tick,
      year: realWorld.time.year,
      month: realWorld.time.month,
      randomState: realWorld.rngState,
      seed: realWorld.seed,
      gameVersion: GAME_VERSION,
    };
    const candidate = createCandidateWorld(meta);
    candidate.cities = [
      { id: realWorld.cities[0]?.id ?? 'city-0' } as unknown as WorldState['cities'][number],
    ];
    const context = makeRestoreContext(candidate, meta, {}, []);

    const brokenGovernment = cloneJson(exportedData.get('government')) as GovernmentSaveData;
    const governmentBaseCity = brokenGovernment.cities[0];
    if (!governmentBaseCity) throw new Error('government 导出数据没有城市');
    brokenGovernment.cities.push({ ...governmentBaseCity, id: 'ghost-city' });
    expect(() => governmentSaveModule.restore(brokenGovernment, context)).toThrow(/不存在的城市/);

    const brokenPolitics = cloneJson(exportedData.get('politics')) as PoliticsSaveData;
    const politicsBaseCity = brokenPolitics.cities[0];
    if (!politicsBaseCity) throw new Error('politics 导出数据没有城市');
    brokenPolitics.cities.push({ id: 'ghost-city', politics: politicsBaseCity.politics });
    expect(() => politicsSaveModule.restore(brokenPolitics, context)).toThrow(/不存在的城市/);
  });
});

describe('v1.7 财政域存档模块：validate 形状校验', () => {
  it('6 模块对自身真实导出数据校验通过', () => {
    for (const module of financeModules) {
      const data = exportedData.get(module.id);
      const result = module.validate(data, 1);
      expect(result.ok, `${module.id}: ${result.errors.slice(0, 3).join('；')}`).toBe(true);
      expect(result.errors).toEqual([]);
    }
  });

  it('数据版本不是当前版本时拒绝', () => {
    for (const module of financeModules) {
      const result = module.validate(exportedData.get(module.id), 2);
      expect(result.ok, `${module.id} 应拒绝 version=2`).toBe(false);
    }
  });

  it('顶层/嵌套结构损坏被拒绝（逐模块）', () => {
    // banking：deposits 不是数组
    const banking = cloneJson(exportedData.get('banking')) as Record<string, unknown>;
    const bankingState = banking.banking as Record<string, unknown>;
    bankingState.deposits = 'not-an-array';
    expect(bankingSaveModule.validate(banking, 1).ok).toBe(false);
    expect(bankingSaveModule.validate(null, 1).ok).toBe(false);

    // government：treasury 非数字 + fiscal.nextEntryId 非法
    const government = cloneJson(exportedData.get('government')) as Record<string, unknown>;
    const governmentCities = government.cities as Record<string, unknown>[];
    const firstGovernmentCity = governmentCities[0];
    if (!firstGovernmentCity) throw new Error('government 导出数据没有城市');
    firstGovernmentCity.treasury = 'not-a-number';
    const governmentFiscal = government.fiscal as Record<string, unknown>;
    governmentFiscal.nextEntryId = 0;
    const governmentResult = governmentSaveModule.validate(government, 1);
    expect(governmentResult.ok).toBe(false);
    expect(governmentResult.errors.length).toBeGreaterThanOrEqual(2);

    // bonds：holdings 引用不存在的批次
    const bonds = cloneJson(exportedData.get('bonds')) as Record<string, unknown>;
    const bondState = bonds.bonds as Record<string, unknown>;
    (bondState.holdings as Record<string, unknown>[]).push({
      id: 'test-holding',
      issuanceId: 'missing-issuance',
      cityId: 'missing-city',
      holder: { kind: 'player', id: 'player' },
      units: 1,
      principal: 1000,
      accruedInterest: 0,
      status: 'active',
    });
    expect(bondsSaveModule.validate(bonds, 1).ok).toBe(false);

    // securities：governance.boards 不是数组
    const securities = cloneJson(exportedData.get('securities')) as Record<string, unknown>;
    const governance = securities.governance as Record<string, unknown>;
    governance.boards = { not: 'an-array' };
    expect(securitiesSaveModule.validate(securities, 1).ok).toBe(false);

    // management：nextOperatorNumber 不是正整数
    const management = cloneJson(exportedData.get('management')) as Record<string, unknown>;
    const managementState = management.management as Record<string, unknown>;
    managementState.nextOperatorNumber = 0;
    expect(managementSaveModule.validate(management, 1).ok).toBe(false);

    // politics：领导人不在候选人集合
    const politics = cloneJson(exportedData.get('politics')) as Record<string, unknown>;
    const politicsState = politics.politics as Record<string, unknown>;
    const politicsCities = politicsState.cities as Record<string, unknown>[];
    const firstPoliticsCity = politicsCities[0];
    if (!firstPoliticsCity) throw new Error('politics 导出数据没有城市');
    firstPoliticsCity.leader = { id: 'not-a-candidate' };
    expect(politicsSaveModule.validate(politics, 1).ok).toBe(false);
  });
});

describe('v1.7 财政域存档模块：migrate 版本规则', () => {
  it('fromVersion=0 视为必需模块缺失并抛错', () => {
    for (const module of financeModules) {
      expect(() => module.migrate(undefined, makeMigrationContext(0))).toThrow(/缺少必需/);
    }
  });

  it('fromVersion=1 原样返回（不修改/不重建数据）', () => {
    for (const module of financeModules) {
      const data = exportedData.get(module.id);
      expect(module.migrate(data, makeMigrationContext(1))).toBe(data);
    }
  });

  it('fromVersion>=2 抛不支持', () => {
    for (const module of financeModules) {
      expect(() => module.migrate(exportedData.get(module.id), makeMigrationContext(2))).toThrow(
        /不支持/,
      );
    }
  });
});

describe('v1.7 财政域存档模块：export 返回纯数据（无引用别名）', () => {
  it('导出后篡改真实世界，已导出数据不变', () => {
    const exportedBefore = new Map<string, string>();
    for (const [id, data] of exportedData) exportedBefore.set(id, JSON.stringify(data));

    // 直接清空/修改权威世界里的数组与对象（若 export 返回引用，已导出数据会跟着变）。
    realWorld.banking.deposits.length = 0;
    realWorld.banking.lastMonth.interestIncome += 1;
    if (realWorld.bonds) {
      realWorld.bonds.issuances.length = 0;
      realWorld.bonds.holdings.length = 0;
      realWorld.bonds.payments.length = 0;
    }
    realWorld.securities.classes.length = 0;
    realWorld.securities.holdings.length = 0;
    realWorld.securities.history.length = 0;
    realWorld.governance.boards.length = 0;
    realWorld.governance.controls.length = 0;
    realWorld.management.operators.length = 0;
    realWorld.management.playerOperations.length = 0;
    realWorld.politics.elections.length = 0;
    realWorld.politics.cities.length = 0;
    realWorld.fiscal.ledger.length = 0;
    realWorld.policies.active.length = 0;
    realWorld.policies.history.length = 0;
    realWorld.taxes.historyByCity = {};
    realWorld.taxes.accrualByCity = {};
    const firstCity = realWorld.cities[0];
    if (firstCity) {
      firstCity.treasury = -999_999;
      firstCity.government.loans.length = 0;
      firstCity.government.payables.length = 0;
      firstCity.gdpWindow.length = 0;
      firstCity.gdpEstimate = null;
      firstCity.politics.approval = -1;
      firstCity.politics.rulingParty = '';
    }

    for (const [id, data] of exportedData) {
      expect(JSON.stringify(data), `模块 ${id} 的导出数据被世界篡改污染`).toBe(
        exportedBefore.get(id),
      );
    }
  });
});
