// v8 → v9 存档迁移：新增设备资产、设备市场与三种设备商品。
//
// 迁移口径（任务书 §11）：
// - 旧档的总人口、企业数量、现金、持股、贷款与游戏进度不得被改动；
// - 旧产能按设备台数反推（capacity / (capacityPerUnit × 科技系数)），
//   equipmentCapacity 沿用原 capacity，不凭空增加产能、现金或可售商品；
// - 设备市场开局库存为 0（政府设备库存只在新开局注入）；
// - 三种设备商品市场补齐、成交与库存为 0，不虚构历史成交。
import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation/core/simulation';
import { parseSave, serializeSave } from '../src/simulation/core/save';
import { SAVE_FORMAT_VERSION } from '../src/simulation/contracts/types';
import type { WorldState } from '../src/simulation/contracts/types';
import { checkInvariants } from '../src/simulation/core/invariants';
import { DEMO_CONFIG } from '../src/data/config';
import { equipmentKindForSector } from '../src/simulation/equipment/equipment';

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

/** 把当前 v9 存档降级成结构上的 v8：删掉 v9 新增字段，格式号改 8。 */
function toV8(world: WorldState): { text: string; raw: RawSave } {
  const save = JSON.parse(serializeSave(world, '2026-11-01T00:00:00.000Z')) as unknown as RawSave;
  save.formatVersion = 8;
  delete save.world.equipmentMarket;
  for (const city of save.world.cities) {
    for (const goodId of EQUIPMENT_GOODS) delete city.market[goodId];
  }
  for (const company of save.world.companies) {
    delete company.equipment;
    delete company.equipmentCapacity;
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
  it('旧 v8 存档加载成功：人口/企业/资金不变，设备按旧产能反推', () => {
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

    // 产能不增加：capacity 保留，equipmentCapacity 等于原 capacity，设备台数按产能反推。
    parsed.companies.forEach((company, index) => {
      expect(company.capacity).toBeCloseTo(before.capacity[index]!, 2);
      expect(company.equipmentCapacity).toBeCloseTo(company.capacity, 2);
      const city = parsed.cities.find((entry) => entry.id === company.cityId)!;
      const tech = city.technology.productivityMultiplier;
      const kind = equipmentKindForSector(company.sector, DEMO_CONFIG);
      const perUnit = DEMO_CONFIG.equipment.catalog[kind].capacityPerUnit;
      expect(company.equipment[kind]).toBe(Math.max(0, Math.round(company.capacity / (perUnit * tech))));
      for (const other of ['farm', 'industry', 'energy'] as const) {
        if (other !== kind) expect(company.equipment[other]).toBe(0);
      }
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

  it('v9 存档往返保留设备资产与设备市场', () => {
    const world = currentWorld(2);
    // 手工制造一笔可辨认的状态：设备台数与本月成交。
    world.companies[0]!.equipment.farm += 2;
    world.equipmentMarket.lastMonthSold.industry = 3;
    const text = serializeSave(world, '2026-11-02T00:00:00.000Z');
    const result = parseSave(text);
    expect(result.ok, result.error).toBe(true);
    expect(result.migratedFrom).toBeUndefined();
    const parsed = result.world!;
    expect(parsed.companies[0]!.equipment.farm).toBe(world.companies[0]!.equipment.farm);
    expect(parsed.equipmentMarket.lastMonthSold.industry).toBe(3);
    expect(checkInvariants(parsed)).toEqual([]);
  });
});
