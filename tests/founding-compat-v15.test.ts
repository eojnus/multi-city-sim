// v1.5 §5 初始设备兼容入口核查。
//
// 背景：v1.4 起“新创办路径”会给企业 1 台模拟范围外实物出资设备（12 个月锁定、提前退出
// 按实物返还）。但 `foundCompany` 里显式传 `capital` 或旧 `plan` 的兼容分支仍保留 v0.9
// “先买设备”的旧逻辑。本套件核查并锁定：
// 1. 所有创办入口的路径归属（v1.0 评估路径 vs v0.9 兼容路径）与可达性；
// 2. capital 兼容路径的行为差异（无初始实物出资/锁定/返还）有代码与记录标记，且游戏不可达；
// 3. plan 档位覆盖改走 v1.0 评估路径，同样获得实物出资、锁定与来源记录；
// 4. 正常游戏入口（GameStore 居民/企业/政府、AI 自动创办、政策补贴）逐一有实物出资；
// 5. 初始设备只计一次、后续扩产走真实市场、混合存档兼容与幂等。
import { describe, expect, it } from 'vitest';
import { GameStore } from '../src/app/gameStore';
import { Simulation } from '../src/simulation/core/simulation';
import { DEMO_CONFIG, type DemoConfig } from '../src/data/config';
import { GOODS } from '../src/data/demo-data';
import type { EquipmentKind, LogEntry, WorldState } from '../src/simulation/contracts/types';
import type { SaveBridge } from '../src/platform/saveBridge';
import {
  INITIAL_EQUIPMENT_LOCK_MONTHS,
  INITIAL_EQUIPMENT_UNITS,
  assessFounding,
} from '../src/simulation/companies/founding';
import {
  expandCompanyCapacity,
  foundCompany,
  maybeFoundCompanies,
  usesLegacyFoundingPath,
} from '../src/simulation/companies/lifecycle/lifecycle';
import {
  equipmentCapacityPerUnit,
  equipmentUnitPrice,
  listUsedEquipment,
} from '../src/simulation/equipment/equipment';
import { startPolicy } from '../src/simulation/policies/policies';
import { activePolicy } from '../src/simulation/policies/query';
import { checkInvariants } from '../src/simulation/core/invariants';
import { parseSave, serializeSave } from '../src/simulation/core/save';

const KINDS: EquipmentKind[] = ['farm', 'industry', 'energy'];

function createStore(): GameStore {
  const bridge: SaveBridge = {
    list: async () => ({ ok: true, slots: [] }),
    read: async (slot: string) => ({ ok: false, slot, error: '存档不存在', code: 'not-found' }),
    write: async (slot: string) => ({ ok: true, slot, savedAt: new Date().toISOString() }),
    remove: async () => ({ ok: true }),
    onMenuAction: () => () => undefined,
  } as unknown as SaveBridge;
  return new GameStore(Simulation.create(), bridge);
}

function richWorld(world: WorldState): WorldState {
  for (const city of world.cities) city.treasury = 50_000_000;
  for (const group of world.investors) group.cash = 100_000_000;
  for (const company of world.companies) company.cash = 50_000_000;
  return world;
}

function cityOf(world: WorldState, cityId = 'lanport') {
  return world.cities.find((city) => city.id === cityId)!;
}

/** 制造“食品持续缺货 + 价格合理”的机会，保留真实设备市场（政府开局库存 + 设备企业库存）。 */
function foodGap(world: WorldState, cityId = 'lanport') {
  const city = cityOf(world, cityId);
  const base = GOODS.find((good) => good.id === 'food')!.basePrice;
  const market = city.market.food;
  market.price = base * 1.4;
  market.lastPriceChangePct = 5;
  market.demand = 2_000_000;
  market.sold = 0;
  market.unmetDemand = 2_000_000;
  market.supply = 500_000;
  return city;
}

function equipmentGoodsInventory(world: WorldState, goodId: string): number {
  return world.companies.reduce(
    (sum, company) => sum + Math.max(0, company.inventory[goodId as never] ?? 0),
    0,
  );
}

function totalEquipmentUnits(world: WorldState): number {
  return world.companies.reduce(
    (sum, company) => sum + KINDS.reduce((inner, kind) => inner + company.equipment[kind], 0),
    0,
  );
}

describe('v1.5 §5 创办入口路径归属', () => {
  it('只有显式 capital 走 v0.9 兼容路径；plan 档位覆盖属于 v1.0 评估路径', () => {
    expect(usesLegacyFoundingPath({ cityId: 'lanport' })).toBe(false);
    expect(usesLegacyFoundingPath({ cityId: 'lanport', recipeOutput: 'food' })).toBe(false);
    expect(
      usesLegacyFoundingPath({ cityId: 'lanport', recipeOutput: 'food', founderType: 'investorGroup' }),
    ).toBe(false);
    expect(usesLegacyFoundingPath({ cityId: 'lanport', capital: INITIAL_EQUIPMENT_UNITS })).toBe(true);
  });

  it('capital 兼容路径：全量市场采购、无初始实物出资/锁定，记录与日志显式标注差异', () => {
    const world = richWorld(Simulation.create().state);
    const city = foodGap(world);
    const goodId = DEMO_CONFIG.equipment.catalog.industry.goodId;
    const inventoryBefore = equipmentGoodsInventory(world, goodId);
    const stockBefore = { ...world.equipmentMarket.initialStock };
    const log: LogEntry[] = [];

    const result = foundCompany(
      world,
      {
        cityId: city.id,
        founderType: 'investorGroup',
        capital: 600_000,
        recipeOutput: 'food',
        log,
      },
      DEMO_CONFIG,
    );
    expect(result.ok, result.error).toBe(true);
    const company = world.companies.find((entry) => entry.id === result.companyId)!;

    // 资产与设备来源：所有启动设备都来自真实市场（设备企业库存或政府开局库存）。
    const marketUnits =
      inventoryBefore -
      equipmentGoodsInventory(world, goodId) +
      (stockBefore.industry - world.equipmentMarket.initialStock.industry);
    expect(marketUnits).toBeGreaterThan(0);
    expect(company.equipment.industry).toBe(marketUnits);
    expect(company.lastMonth.equipmentPurchased ?? 0).toBeGreaterThan(0);
    expect(company.initialEquipment).toBeUndefined();
    const record = world.lifecycle.foundings.at(-1)!;
    expect(record.initialEquipment).toBeUndefined();
    expect(record.note).toContain('v0.9 兼容路径');
    expect(log.some((entry) => entry.message.includes('v0.9 兼容路径'))).toBe(true);

    // 无 12 个月锁定：设备可立即全部出售（兼容路径没有防套利限制，也说明它不能进正常游戏）。
    const listed = listUsedEquipment(
      world,
      company,
      'industry',
      company.equipment.industry,
      DEMO_CONFIG,
      world.time.tick,
    );
    expect(listed.ok, listed.error).toBe(true);
    expect(company.initialEquipment).toBeUndefined();
    expect(checkInvariants(world)).toEqual([]);
  });

  it('capital 兼容路径同样受 160 在营上限约束', () => {
    const world = richWorld(Simulation.create().state);
    foodGap(world);
    const lanportCount = world.companies.filter((entry) => entry.cityId === 'lanport').length;
    const config = {
      ...DEMO_CONFIG,
      lifecycle: { ...DEMO_CONFIG.lifecycle, maxCompaniesPerCity: lanportCount },
    } as unknown as DemoConfig;
    const companiesBefore = world.companies.length;

    const result = foundCompany(
      world,
      { cityId: 'lanport', founderType: 'investorGroup', capital: 600_000, recipeOutput: 'food' },
      config,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('上限');
    expect(world.companies).toHaveLength(companiesBefore);
  });
});

describe('v1.5 §5 plan 档位覆盖改走 v1.0 评估路径', () => {
  it('plan 路径获得初始实物出资、12 个月锁定与来源记录，且档位按 plan 生效', () => {
    const world = richWorld(Simulation.create().state);
    const city = foodGap(world);
    const assessment = assessFounding(world, DEMO_CONFIG, city.id, 'food');
    const plan = assessment.scaleTiers.find((tier) => tier.units === 2)!;
    expect(plan.inKindUnits).toBe(1);
    expect(plan.marketUnits).toBe(1);

    const result = foundCompany(
      world,
      { cityId: city.id, recipeOutput: 'food', log: [] },
      DEMO_CONFIG,
      { plan },
    );
    expect(result.ok, result.error).toBe(true);
    const company = world.companies.find((entry) => entry.id === result.companyId)!;

    // 档位被强制为 2 台（默认富余资金会选 4 台），其中 1 台为实物出资、1 台真实购买。
    expect(company.equipment.industry).toBe(2);
    expect(company.initialEquipment).toMatchObject({
      kind: 'industry',
      units: 1,
      source: 'founderInKind',
      grantedTick: world.time.tick,
      lockUntilTick: world.time.tick + INITIAL_EQUIPMENT_LOCK_MONTHS,
    });
    expect(company.initialEquipment!.valuation).toBeCloseTo(
      INITIAL_EQUIPMENT_UNITS *
        equipmentUnitPrice(world, city.id, 'industry', DEMO_CONFIG),
      2,
    );
    // 初始设备只计一次：台数 = 实物 1 + 市场 1；产能只由这 2 台推导，估值只记一次。
    const derived =
      company.equipment.industry *
      equipmentCapacityPerUnit(DEMO_CONFIG, 'industry', company.recipeOutput) *
      (city.technology.productivityMultiplier || 1);
    expect(company.equipmentCapacity).toBeCloseTo(derived, 2);
    expect(company.capacity).toBeCloseTo(derived, 2);
    expect(company.lastMonth.equipmentPurchased ?? 0).toBeGreaterThan(0);
    const record = world.lifecycle.foundings.at(-1)!;
    expect(record.initialEquipment).toEqual(company.initialEquipment);

    // 锁定期内只能出售“超额”的那 1 台，实物出资那台不可出售。
    expect(
      listUsedEquipment(world, company, 'industry', 2, DEMO_CONFIG, world.time.tick).ok,
    ).toBe(false);
    const listed = listUsedEquipment(world, company, 'industry', 1, DEMO_CONFIG, world.time.tick);
    expect(listed.ok, listed.error).toBe(true);
    expect(checkInvariants(world)).toEqual([]);
  });

  it('capital 与 plan 同时给出时以 capital 为准（仍走兼容路径，不重复发实物出资）', () => {
    const world = richWorld(Simulation.create().state);
    const city = foodGap(world);
    const plan = assessFounding(world, DEMO_CONFIG, city.id, 'food').scaleTiers[0]!;
    const result = foundCompany(
      world,
      { cityId: city.id, founderType: 'investorGroup', capital: 600_000, recipeOutput: 'food' },
      DEMO_CONFIG,
      { plan },
    );
    expect(result.ok, result.error).toBe(true);
    const company = world.companies.find((entry) => entry.id === result.companyId)!;
    expect(company.initialEquipment).toBeUndefined();
    expect(company.equipment.industry).toBeGreaterThan(0);
    expect(world.lifecycle.foundings.at(-1)!.note).toContain('v0.9 兼容路径');
  });
});

describe('v1.5 §5 正常游戏可达入口逐一覆盖', () => {
  it('GameStore 的居民/企业/政府三个创办入口都获得实物出资与 12 个月锁定', () => {
    for (const founderType of ['investorGroup', 'company', 'government'] as const) {
      const store = createStore();
      const world = richWorld(store.world);
      // v1.5：企业出资人只能用“运营缓冲之外的余钱”（v1.3 §5），这里给足现金让三个入口都可真实成立。
      for (const company of world.companies) company.cash = 5_000_000_000;
      foodGap(world);
      store.selectCity('lanport');
      world.player.roles.mayorCityId = founderType === 'government' ? 'lanport' : null;
      // 玩家市长在任时不得同时存在 AI 领导人（invariant）：与 UI 权限测试同一套最小状态。
      const cityPolitics = world.politics.cities.find((entry) => entry.cityId === 'lanport');
      if (cityPolitics) cityPolitics.leader = null;
      const founderCompanyId =
        founderType === 'company'
          ? world.companies.find(
              (entry) => entry.cityId === 'lanport' && entry.cash > 1_000_000,
            )!.id
          : undefined;

      expect(store.foundCompany(founderType, founderCompanyId), founderType).toBe(true);
      const founded = world.companies.filter(
        (entry) => entry.initialEquipment?.source === 'founderInKind',
      );
      expect(founded, founderType).toHaveLength(1);
      const company = founded[0]!;
      expect(company.initialEquipment!.units).toBe(INITIAL_EQUIPMENT_UNITS);
      expect(company.initialEquipment!.lockUntilTick).toBe(
        world.time.tick + INITIAL_EQUIPMENT_LOCK_MONTHS,
      );
      // 玩家入口同样不能即时套现实物出资：把整企业设备全部挂单（含锁定那台）必须被拒。
      const lockedListing = listUsedEquipment(
        world,
        company,
        company.initialEquipment!.kind,
        company.equipment[company.initialEquipment!.kind],
        DEMO_CONFIG,
        world.time.tick,
      );
      expect(lockedListing.ok).toBe(false);
      expect(lockedListing.error).toContain('锁定期');
      expect(checkInvariants(world)).toEqual([]);
    }
  });

  it('AI 自动创办入口（maybeFoundCompanies）的每家企业都带实物出资记录', () => {
    const world = richWorld(Simulation.create().state);
    for (const city of world.cities) foodGap(world, city.id);
    const config = {
      ...DEMO_CONFIG,
      lifecycle: { ...DEMO_CONFIG.lifecycle, maxFoundingsPerCityMonth: 1 },
    } as unknown as DemoConfig;

    const created = maybeFoundCompanies(world, config, []);
    expect(created.length).toBeGreaterThan(0);
    for (const companyId of created) {
      const company = world.companies.find((entry) => entry.id === companyId)!;
      expect(company.initialEquipment?.source, companyId).toBe('founderInKind');
      expect(company.initialEquipment!.lockUntilTick).toBe(
        world.time.tick + INITIAL_EQUIPMENT_LOCK_MONTHS,
      );
    }
    expect(checkInvariants(world)).toEqual([]);
  });

  it('初创扶持政策入口：财政补贴与实物出资并存，补贴不伪装成设备（设备仍来自实物+市场）', () => {
    const world = richWorld(Simulation.create().state);
    const city = foodGap(world);
    expect(startPolicy(world, city.id, 'startupSupport', DEMO_CONFIG).ok).toBe(true);
    const policy = activePolicy(world, city.id, 'startupSupport')!;
    const goodId = DEMO_CONFIG.equipment.catalog.industry.goodId;
    const inventoryBefore = equipmentGoodsInventory(world, goodId);
    const stockBefore = { ...world.equipmentMarket.initialStock };

    const result = foundCompany(
      world,
      { cityId: city.id, recipeOutput: 'food', log: [] },
      DEMO_CONFIG,
    );
    expect(result.ok, result.error).toBe(true);
    const company = world.companies.find((entry) => entry.id === result.companyId)!;
    const record = world.lifecycle.foundings.at(-1)!;
    // 财政补贴是真实现金（计入 governmentGrant 与政策支出），不是设备来源。
    expect(record.governmentGrant ?? 0).toBeGreaterThan(0);
    expect(policy.spent).toBeGreaterThan(0);
    // 设备来源仍是 1 台实物出资 + 其余真实市场购买。
    expect(company.initialEquipment?.source).toBe('founderInKind');
    const marketPurchased =
      inventoryBefore -
      equipmentGoodsInventory(world, goodId) +
      (stockBefore.industry - world.equipmentMarket.initialStock.industry);
    expect(company.equipment.industry).toBe(company.initialEquipment!.units + marketPurchased);
    expect(checkInvariants(world)).toEqual([]);
  });
});

describe('v1.5 §5 扩产与存档兼容', () => {
  it('plan 路径公司后续扩产仍走真实设备市场，实物出资记录/锁定不变', () => {
    const world = richWorld(Simulation.create().state);
    const city = foodGap(world);
    const plan = assessFounding(world, DEMO_CONFIG, city.id, 'food').scaleTiers.find(
      (tier) => tier.units === 2,
    )!;
    const founded = foundCompany(
      world,
      { cityId: city.id, recipeOutput: 'food', log: [] },
      DEMO_CONFIG,
      { plan },
    );
    expect(founded.ok, founded.error).toBe(true);
    const company = world.companies.find((entry) => entry.id === founded.companyId)!;
    const grantBefore = company.initialEquipment;
    const unitsBefore = company.equipment.industry;
    const purchasedBefore = company.lastMonth.equipmentPurchased ?? 0;
    const goodId = DEMO_CONFIG.equipment.catalog.industry.goodId;
    const marketUnitsBefore =
      equipmentGoodsInventory(world, goodId) + world.equipmentMarket.initialStock.industry;
    const totalUnitsBefore = totalEquipmentUnits(world);
    const log: LogEntry[] = [];

    const expanded = expandCompanyCapacity(world, company, DEMO_CONFIG, log, 1);
    expect(expanded.ok, expanded.error).toBe(true);
    expect(company.equipment.industry).toBe(unitsBefore + 1);
    // 扩产是真实市场采购：市场可售来源减少 1 台、设备支出增加。
    const marketUnitsAfter =
      equipmentGoodsInventory(world, goodId) + world.equipmentMarket.initialStock.industry;
    expect(marketUnitsBefore - marketUnitsAfter).toBe(1);
    expect(company.lastMonth.equipmentPurchased ?? 0).toBeGreaterThan(purchasedBefore);
    // 扩产不新增实物出资、不改锁定记录，总台数只增加真实购买的 1 台。
    expect(company.initialEquipment).toEqual(grantBefore);
    expect(company.initialEquipment!.units).toBe(INITIAL_EQUIPMENT_UNITS);
    expect(totalEquipmentUnits(world)).toBe(totalUnitsBefore + 1);
    expect(checkInvariants(world)).toEqual([]);
  });

  it('存档兼容：V1 实物出资字段保留、兼容路径缺省，二次往返幂等且重载后锁定仍生效', () => {
    const world = richWorld(Simulation.create().state);
    foodGap(world, 'lanport');
    foodGap(world, 'ironvale');

    const v1 = foundCompany(
      world,
      { cityId: 'lanport', recipeOutput: 'food', log: [] },
      DEMO_CONFIG,
    );
    expect(v1.ok, v1.error).toBe(true);
    const legacy = foundCompany(
      world,
      { cityId: 'ironvale', founderType: 'investorGroup', capital: 600_000, recipeOutput: 'food' },
      DEMO_CONFIG,
    );
    expect(legacy.ok, legacy.error).toBe(true);
    const v1Company = world.companies.find((entry) => entry.id === v1.companyId)!;
    const legacyCompany = world.companies.find((entry) => entry.id === legacy.companyId)!;
    expect(v1Company.initialEquipment).toBeDefined();
    expect(legacyCompany.initialEquipment).toBeUndefined();

    const first = serializeSave(world, 'v15-compat');
    const parsedOnce = parseSave(first);
    expect(parsedOnce.ok, parsedOnce.error).toBe(true);
    expect(checkInvariants(parsedOnce.world!)).toEqual([]);
    const restoredV1 = parsedOnce.world!.companies.find((entry) => entry.id === v1.companyId)!;
    const restoredLegacy = parsedOnce.world!.companies.find(
      (entry) => entry.id === legacy.companyId,
    )!;
    expect(restoredV1.initialEquipment).toEqual(v1Company.initialEquipment);
    expect(restoredLegacy.initialEquipment).toBeUndefined();
    // 重载后：V1 公司仍受锁定期约束；兼容路径公司没有幻影锁定期，可正常出售。
    expect(
      listUsedEquipment(
        parsedOnce.world!,
        restoredV1,
        'industry',
        restoredV1.equipment.industry,
        DEMO_CONFIG,
        parsedOnce.world!.time.tick,
      ).ok,
    ).toBe(false);
    expect(
      listUsedEquipment(
        parsedOnce.world!,
        restoredLegacy,
        'industry',
        restoredLegacy.equipment.industry,
        DEMO_CONFIG,
        parsedOnce.world!.time.tick,
      ).ok,
    ).toBe(true);

    const second = serializeSave(parsedOnce.world!, 'v15-compat');
    const parsedTwice = parseSave(second);
    expect(parsedTwice.ok, parsedTwice.error).toBe(true);
    const third = serializeSave(parsedTwice.world!, 'v15-compat');
    expect(third).toBe(second);
    expect(checkInvariants(parsedTwice.world!)).toEqual([]);
  });
});
