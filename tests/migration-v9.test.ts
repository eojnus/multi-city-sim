// v8 → v9 设备迁移：设备资产、设备市场与三种设备商品（含显式迁移余量）。
//
// 迁移口径（任务书 §11 + v0.9 验收修复）：
// - 旧档的总人口、企业数量、现金、持股、贷款与游戏进度不得被改动；
// - 旧 capacity 按“整台设备向下取整 + 显式迁移余量”映射：
//   设备台数 = floor(capacity / (capacityPerUnit × 科技系数))，
//   余量 = capacity − 台数 × capacityPerUnit × 科技系数（记录在 equipmentCapacityRemainder）；
// - 迁移后 capacity 仍等于原值，且 = 设备推导产能 + 余量，不凭空增加产能、现金或可售商品；
// - v9 布局直接包含 equipmentCapacityRemainder，往返存档必须保持不变；
// - 设备市场开局库存为 0（政府设备库存只在新开局注入）。
import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation/core/simulation';
import { parseSave, serializeLegacySave, serializeSave } from '../src/simulation/core/save';
import { SAVE_FORMAT_VERSION } from '../src/simulation/contracts/types';
import type { WorldState } from '../src/simulation/contracts/types';
import { checkInvariants } from '../src/simulation/core/invariants';
import { DEMO_CONFIG } from '../src/data/config';
import {
  buyNewEquipment,
  equipmentCapacityPerUnit,
  equipmentKindForSector,
} from '../src/simulation/equipment/equipment';

const EQUIPMENT_GOODS = ['farmEquipment', 'industryEquipment', 'energyEquipment'] as const;

function currentWorld(months = 2): WorldState {
  const simulation = Simulation.create();
  for (let month = 0; month < months; month += 1) {
    const result = simulation.tick();
    if (!result.ok) throw new Error(`推进第 ${month + 1} 月失败：${result.error ?? '未知错误'}`);
  }
  return simulation.state;
}

interface RawCompany {
  cityId: string;
  capacity: number;
  inventory: Record<string, unknown>;
  monthly?: Record<string, unknown>;
  lastMonth?: Record<string, unknown>;
  previousMonth?: Record<string, unknown>;
  equipment?: unknown;
  equipmentCapacity?: unknown;
  equipmentCapacityRemainder?: unknown;
  salesHistory?: unknown;
  productionPlan?: unknown;
  recentProfits?: unknown;
}

interface RawSave {
  formatVersion: number;
  world: {
    equipmentMarket?: unknown;
    cities: { id: string; market: Record<string, Record<string, unknown>>; population: { total: number } }[];
    companies: RawCompany[];
  };
}

/** 把当前存档降级成结构上的 v8：删掉 v9 新增字段，格式号改 8。 */
function toV8(world: WorldState): { text: string; raw: RawSave } {
  // 降级构造旧 v8 档：必须从旧单体格式（含 world）开始；v10 模块化文本没有 world。
  const save = JSON.parse(serializeLegacySave(world, '2026-11-01T00:00:00.000Z')) as unknown as RawSave;
  save.formatVersion = 8;
  delete save.world.equipmentMarket;
  for (const city of save.world.cities) {
    for (const goodId of EQUIPMENT_GOODS) delete city.market[goodId];
  }
  for (const company of save.world.companies) {
    delete company.equipment;
    delete company.equipmentCapacity;
    delete company.equipmentCapacityRemainder;
    delete company.salesHistory;
    delete company.productionPlan;
    delete company.recentProfits;
    for (const goodId of EQUIPMENT_GOODS) delete company.inventory[goodId];
    for (const stats of [company.monthly, company.lastMonth, company.previousMonth]) {
      if (!stats) continue;
      delete stats.bonusPaid;
      delete stats.equipmentPurchased;
      delete stats.equipmentSold;
      delete stats.emergencyLayoffs;
    }
  }
  return { text: JSON.stringify(save), raw: save };
}

describe('v8 → v9 设备资产与设备市场迁移', () => {
  it('旧 v8 存档加载成功：人口/企业/资金不变，旧产能按整台设备 + 显式余量映射', () => {
    const world = currentWorld(2);
    const before = {
      population: world.cities.map((city) => city.population.total),
      companies: world.companies.length,
      playerCash: world.player.cash,
      treasury: world.cities.map((city) => city.treasury),
      companyCash: world.companies.map((company) => company.cash),
      companyDebt: world.companies.map((company) => company.debt),
      capacity: world.companies.map((company) => company.capacity),
    };
    const { text } = toV8(world);
    const result = parseSave(text);
    expect(result.ok, result.error).toBe(true);
    expect(result.migratedFrom).toBe(8);
    expect(result.save?.formatVersion).toBe(SAVE_FORMAT_VERSION);

    const parsed = result.world!;
    // 旧档人口不得乘 5，企业数量不得变化。
    expect(parsed.cities.map((city) => city.population.total)).toEqual(before.population);
    expect(parsed.companies.length).toBe(before.companies);
    expect(parsed.player.cash).toBeCloseTo(before.playerCash, 2);
    expect(parsed.cities.map((city) => city.treasury)).toEqual(
      before.treasury.map((value) => expect.closeTo(value, 2)),
    );
    expect(parsed.companies.map((company) => company.cash)).toEqual(
      before.companyCash.map((value) => expect.closeTo(value, 2)),
    );
    expect(parsed.companies.map((company) => company.debt)).toEqual(
      before.companyDebt.map((value) => expect.closeTo(value, 2)),
    );

    // 产能不增加：capacity 保留；设备台数向下取整，差额显式记入迁移余量。
    parsed.companies.forEach((company, index) => {
      expect(company.capacity).toBeCloseTo(before.capacity[index]!, 2);
      expect(company.equipmentCapacity).toBeCloseTo(company.capacity, 2);
      const city = parsed.cities.find((entry) => entry.id === company.cityId)!;
      const tech = city.technology.productivityMultiplier;
      const kind = equipmentKindForSector(company.sector, DEMO_CONFIG);
      const perUnit = equipmentCapacityPerUnit(DEMO_CONFIG, kind, company.recipeOutput);
      const units = Math.max(0, Math.floor(company.capacity / Math.max(1, perUnit * tech)));
      expect(company.equipment[kind]).toBe(units);
      for (const other of ['farm', 'industry', 'energy'] as const) {
        if (other !== kind) expect(company.equipment[other]).toBe(0);
      }
      const expectedRemainder = Math.max(0, company.capacity - units * perUnit * tech);
      expect(company.equipmentCapacityRemainder).toBeCloseTo(expectedRemainder, 2);
      expect(
        company.equipmentCapacityRemainder +
          units * perUnit * tech,
      ).toBeCloseTo(company.capacity, 2);
      expect(company.salesHistory).toEqual([]);
      expect(company.productionPlan).toBeNull();
      expect(company.recentProfits).toEqual([]);
    });

    // 设备市场：旧档没有政府设备库存与挂单。
    expect(parsed.equipmentMarket.initialStock).toEqual({ farm: 0, industry: 0, energy: 0 });
    expect(parsed.equipmentMarket.offers).toEqual([]);
    expect(parsed.equipmentMarket.lastMonthSold).toEqual({ farm: 0, industry: 0, energy: 0 });

    // 三种设备商品市场补齐，且没有任何虚构成交。
    for (const city of parsed.cities) {
      for (const goodId of EQUIPMENT_GOODS) {
        const market = city.market[goodId];
        expect(market).toBeTruthy();
        expect(market.sold).toBe(0);
        expect(market.consumerDemand).toBe(0);
        expect(market.closingStock ?? 0).toBe(0);
      }
    }

    expect(checkInvariants(parsed)).toEqual([]);
  });

  it('迁移日志说明设备映射且不改变进度', () => {
    const { text } = toV8(currentWorld(1));
    const result = parseSave(text);
    expect(result.ok, result.error).toBe(true);
    const messages = result.world!.log.map((entry) => entry.message).join('\n');
    expect(messages).toContain('存档已从 v8 迁移到 v9');
    expect(messages).toContain('不增加产能与现金');
  });
});

describe('v9 布局中的设备迁移余量', () => {
  it('v8 迁移后的余量字段在 v9 存档中往返稳定，产能/设备/现金不变', () => {
    // 先构造 v8 迁移结果：容量不能整除设备产能，必然产生非零余量。
    const { text: v8Text } = toV8(currentWorld(2));
    const migrated = parseSave(v8Text);
    expect(migrated.ok, migrated.error).toBe(true);
    const migratedWorld = migrated.world!;
    const remainders = migratedWorld.companies.map((company) => company.equipmentCapacityRemainder);
    expect(remainders.some((value) => value > 0.01)).toBe(true);

    const result = parseSave(serializeSave(migratedWorld, '2026-11-02T00:00:00.000Z'));
    expect(result.ok, result.error).toBe(true);
    expect(result.migratedFrom).toBeUndefined();
    expect(result.save?.formatVersion).toBe(SAVE_FORMAT_VERSION);
    const parsed = result.world!;
    parsed.companies.forEach((company, index) => {
      const original = migratedWorld.companies[index]!;
      expect(company.equipmentCapacityRemainder).toBeCloseTo(remainders[index]!, 2);
      expect(company.capacity).toBeCloseTo(original.capacity, 2);
      expect(company.equipmentCapacity).toBeCloseTo(original.equipmentCapacity, 2);
      expect(company.equipment).toEqual(original.equipment);
      expect(company.cash).toBeCloseTo(original.cash, 2);
    });
    expect(checkInvariants(parsed)).toEqual([]);
  });
});

describe('设备存档往返与迁移后稳定性', () => {
  it('v9 存档往返保留设备资产与设备市场（含真实购买后的重算）', () => {
    const world = currentWorld(2);
    // 用真实采购路径改变设备与产能，而不是手工改缓存。
    const company = world.companies.find((entry) => entry.cityId === world.cities[0]!.id)!;
    const kind = equipmentKindForSector(company.sector, DEMO_CONFIG);
    const purchase = buyNewEquipment(world, company, kind, 1, DEMO_CONFIG, world.time.tick, {
      allowGovernmentStock: true,
      reason: '存档往返测试',
    });
    expect(purchase.ok, purchase.error).toBe(true);
    world.equipmentMarket.lastMonthSold.industry = 3;

    const text = serializeSave(world, '2026-11-02T00:00:00.000Z');
    const result = parseSave(text);
    expect(result.ok, result.error).toBe(true);
    expect(result.migratedFrom).toBeUndefined();
    const parsed = result.world!;
    const parsedCompany = parsed.companies.find((entry) => entry.id === company.id)!;
    expect(parsedCompany.equipment).toEqual(company.equipment);
    expect(parsedCompany.capacity).toBeCloseTo(company.capacity, 2);
    expect(parsedCompany.equipmentCapacity).toBeCloseTo(company.equipmentCapacity, 2);
    expect(parsed.equipmentMarket.lastMonthSold.industry).toBe(3);
    expect(checkInvariants(parsed)).toEqual([]);
  });

  it('v8 迁移后推进 → 买/卖设备 → 再存读档，产能与设备始终一致', () => {
    const { text } = toV8(currentWorld(1));
    const migrated = parseSave(text);
    expect(migrated.ok, migrated.error).toBe(true);
    const simulation = new Simulation(migrated.world!, DEMO_CONFIG);
    const firstTick = simulation.tick();
    expect(firstTick.ok, firstTick.error).toBe(true);

    const world = simulation.state;
    const company = world.companies.find((entry) => entry.cityId === world.cities[0]!.id)!;
    const kind = equipmentKindForSector(company.sector, DEMO_CONFIG);
    // 旧 v8 档迁移后政府设备库存为 0；这里注入一笔真实政府库存作为采购来源。
    world.equipmentMarket.initialStock[kind] = 5;
    const purchase = buyNewEquipment(world, company, kind, 1, DEMO_CONFIG, world.time.tick, {
      allowGovernmentStock: true,
      reason: '迁移后采购',
    });
    expect(purchase.ok, purchase.error).toBe(true);
    expect(checkInvariants(world)).toEqual([]);

    const again = parseSave(serializeSave(world, '2026-11-03T00:00:00.000Z'));
    expect(again.ok, again.error).toBe(true);
    const reloaded = again.world!.companies.find((entry) => entry.id === company.id)!;
    expect(reloaded.equipment).toEqual(company.equipment);
    expect(reloaded.capacity).toBeCloseTo(company.capacity, 2);
    expect(reloaded.equipmentCapacity).toBeCloseTo(company.equipmentCapacity, 2);
    expect(reloaded.equipmentCapacityRemainder).toBeCloseTo(
      company.equipmentCapacityRemainder,
      2,
    );
    expect(checkInvariants(again.world!)).toEqual([]);
  });
});
