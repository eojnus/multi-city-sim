// v1.0 task-23 设备单位经济标定回归：
// 1) 设备商品生产率（台/员工/月）与 config.equipment.catalog[kind].unitsPerWorkerMonth 单一来源一致；
// 2) 三类设备单位经济为正且利润率落在 10–20%；
// 3) 普通商品/资本品产能口径分开（300,000 产出单位/台 vs 5/3/3 台/月），设备厂缓存与独立推导一致；
// 4) 设备厂真实生产，并在下月卖给真实买方（资金、库存、固定资产守恒，资本化审计通过）；
// 5) 创业评估的 unitCapacity / availableEquipmentUnits 与实际采购同源，启动资本为百万级而非数百亿。
import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation/core/simulation';
import { DEMO_CONFIG } from '../src/data/config';
import { GOODS, PRODUCTIVITY, RECIPES } from '../src/data/demo-data';
import { monthlyWageBill } from '../src/simulation/companies/company';
import { foundingCandidateForOutput } from '../src/simulation/companies/founding';
import { checkInvariants } from '../src/simulation/core/invariants';
import {
  buyNewEquipment,
  derivedEquipmentCapacity,
  equipmentCapacityPerUnit,
  equipmentUnits,
  newEquipmentSupply,
} from '../src/simulation/equipment/equipment';
import type { Company, EquipmentKind, GoodId } from '../src/simulation/contracts/types';

const KINDS: EquipmentKind[] = ['farm', 'industry', 'energy'];
const FACTORY_CITY = 'lanport';

function basePriceOf(goodId: GoodId): number {
  return GOODS.find((good) => good.id === goodId)?.basePrice ?? 0;
}

function techOf(cityId: string): number {
  const city = Simulation.create().state.cities.find((entry) => entry.id === cityId);
  return city?.technology.productivityMultiplier ?? 1;
}

function factoryFor(world: Simulation['state'], goodId: GoodId): Company {
  const factory =
    world.companies.find(
      (company) => company.recipeOutput === goodId && company.cityId === FACTORY_CITY,
    ) ?? world.companies.find((company) => company.recipeOutput === goodId);
  if (!factory) throw new Error(`缺少设备制造企业：${goodId}`);
  return factory;
}

interface UnitEconomics {
  margin: number;
  unitProfit: number;
  outputPerMonth: number;
}

function unitEconomics(world: Simulation['state'], kind: EquipmentKind): UnitEconomics {
  const catalog = DEMO_CONFIG.equipment.catalog[kind];
  const goodId = catalog.goodId;
  const factory = factoryFor(world, goodId);
  const city = world.cities.find((entry) => entry.id === factory.cityId)!;
  const tech = city.technology.productivityMultiplier;
  const recipe = RECIPES[goodId];
  const materialCost = recipe.inputs.reduce(
    (sum, input) => sum + input.qty * basePriceOf(input.good),
    0,
  );
  const wageBill = monthlyWageBill(factory, DEMO_CONFIG);
  const laborLimit =
    factory.employees * PRODUCTIVITY[goodId] * tech * DEMO_CONFIG.production.laborCapacityFactor;
  const capacity = derivedEquipmentCapacity(world, factory, DEMO_CONFIG);
  const outputPerMonth = Math.max(0.01, Math.min(capacity, laborLimit));
  const wagePerUnit = wageBill / outputPerMonth;
  const unitProfit = catalog.price - materialCost - wagePerUnit;
  return { margin: unitProfit / catalog.price, unitProfit, outputPerMonth };
}

describe('v1.0 设备单位经济标定（task-23）', () => {
  it('设备商品人均月产量与 config 单一来源一致（0.15 / 0.08 / 0.09 台/员工/月）', () => {
    for (const kind of KINDS) {
      const catalog = DEMO_CONFIG.equipment.catalog[kind];
      expect(PRODUCTIVITY[catalog.goodId]).toBe(catalog.unitsPerWorkerMonth);
      expect(catalog.unitsPerWorkerMonth).toBeGreaterThan(0);
      // 旧值 0.01 会让 60 员工设备厂月产 0.6 台，无法支撑设备产业。
      expect(catalog.unitsPerWorkerMonth).toBeGreaterThanOrEqual(0.05);
    }
    expect(PRODUCTIVITY.farmEquipment).toBe(0.15);
    expect(PRODUCTIVITY.industryEquipment).toBe(0.08);
    expect(PRODUCTIVITY.energyEquipment).toBe(0.09);
  });

  it('三类设备单位经济为正，且利润率落在 10–20% 区间', () => {
    const world = Simulation.create().state;
    for (const kind of KINDS) {
      const economics = unitEconomics(world, kind);
      const name = DEMO_CONFIG.equipment.catalog[kind].name;
      expect(economics.outputPerMonth, `${name} 月产量`).toBeGreaterThan(0);
      expect(economics.unitProfit, `${name} 单位收益`).toBeGreaterThan(0);
      expect(economics.margin, `${name} 利润率`).toBeGreaterThanOrEqual(0.1);
      expect(economics.margin, `${name} 利润率`).toBeLessThanOrEqual(0.2);
    }
  });

  it('产能口径分开：普通商品 300,000 产出单位/台，资本品 5/3/3 台/月，设备厂缓存与推导一致', () => {
    const sim = Simulation.create();
    const world = sim.state;
    const tech = techOf(FACTORY_CITY);
    // 普通商品：设备为被服务行业提供的产出单位/月。
    expect(equipmentCapacityPerUnit(DEMO_CONFIG, 'industry', 'food')).toBe(300_000);
    expect(equipmentCapacityPerUnit(DEMO_CONFIG, 'farm', 'grain')).toBe(300_000);
    expect(equipmentCapacityPerUnit(DEMO_CONFIG, 'energy', 'energy')).toBe(300_000);
    // 资本品：设备厂自身产能单位是“台/月”。
    expect(equipmentCapacityPerUnit(DEMO_CONFIG, 'industry', 'farmEquipment')).toBe(5);
    expect(equipmentCapacityPerUnit(DEMO_CONFIG, 'industry', 'industryEquipment')).toBe(3);
    expect(equipmentCapacityPerUnit(DEMO_CONFIG, 'industry', 'energyEquipment')).toBe(3);

    const normal = world.companies.find((company) => company.recipeOutput === 'food')!;
    const normalKind = 'industry' as EquipmentKind;
    const normalDerived = derivedEquipmentCapacity(world, normal, DEMO_CONFIG);
    expect(normalDerived).toBeCloseTo(
      equipmentUnits(normal, normalKind) * 300_000 * tech,
      2,
    );
    expect(normal.capacity).toBeCloseTo(normalDerived, 2);

    for (const kind of KINDS) {
      const factory = factoryFor(world, DEMO_CONFIG.equipment.catalog[kind].goodId);
      const units = equipmentUnits(factory, 'industry');
      const perUnit = equipmentCapacityPerUnit(
        DEMO_CONFIG,
        'industry',
        factory.recipeOutput,
      );
      expect(perUnit).toBeLessThanOrEqual(5);
      const derived = derivedEquipmentCapacity(world, factory, DEMO_CONFIG);
      expect(derived).toBeCloseTo(units * perUnit * tech, 2);
      expect(factory.equipmentCapacity).toBeCloseTo(derived, 2);
      expect(factory.capacity).toBeCloseTo(derived, 2);
    }
    expect(checkInvariants(world, [], DEMO_CONFIG)).toEqual([]);
  });

  it('设备厂真实生产，并在下月卖给真实买方：资金/库存/固定资产守恒，资本化审计通过', () => {
    const sim = Simulation.create();
    const world = sim.state;
    const factory = factoryFor(world, 'industryEquipment');
    const goodId = 'industryEquipment' as GoodId;
    const inventoryBefore = factory.inventory[goodId] ?? 0;

    const tickResult = sim.tick();
    expect(tickResult.ok).toBe(true);
    expect(tickResult.invariants).toEqual([]);
    expect(checkInvariants(world, [], DEMO_CONFIG)).toEqual([]);
    const produced = factory.lastMonth.produced ?? 0;
    expect(produced).toBeGreaterThan(0);
    expect(factory.inventory[goodId] ?? 0).toBeGreaterThan(inventoryBefore);

    const buyer = world.companies.find(
      (company) => company.cityId === factory.cityId && company.recipeOutput === 'food',
    )!;
    buyer.cash = Math.max(buyer.cash, 5_000_000);
    const buyerCashBefore = buyer.cash;
    const buyerUnitsBefore = equipmentUnits(buyer, 'industry');
    const buyerCapacityBefore = buyer.capacity;
    const factoryCashBefore = factory.cash;
    const factoryStockBefore = factory.inventory[goodId] ?? 0;
    const capitalizedBefore = world.equipmentMarket.capitalizedThisTick?.[goodId] ?? 0;

    const purchase = buyNewEquipment(
      world,
      buyer,
      'industry',
      1,
      DEMO_CONFIG,
      world.time.tick,
      { reason: '测试采购' },
    );
    expect(purchase.ok).toBe(true);
    expect(purchase.units).toBe(1);
    expect(purchase.fromCompanies).toBe(1);
    expect(purchase.fromGovernment).toBe(0);
    expect(purchase.fromIntercity).toBe(0);
    expect(purchase.cost).toBeGreaterThan(0);

    // 资金守恒：买方付出 = 卖方收到（同城企业卖方）。
    expect(buyer.cash).toBeCloseTo(buyerCashBefore - purchase.cost, 2);
    expect(factory.cash).toBeCloseTo(factoryCashBefore + purchase.cost, 2);
    // 库存与固定资产：卖方库存 -1，买方设备 +1 台，产能按普通商品口径增加 300,000×tech。
    expect(factory.inventory[goodId] ?? 0).toBeCloseTo(factoryStockBefore - 1, 2);
    expect(equipmentUnits(buyer, 'industry')).toBe(buyerUnitsBefore + 1);
    const tech = techOf(buyer.cityId);
    expect(buyer.capacity).toBeCloseTo(buyerCapacityBefore + 300_000 * tech, 2);
    // 资本化流出显式记录，供库存审计扣减。
    expect(world.equipmentMarket.capitalizedThisTick?.[goodId] ?? 0).toBe(
      capitalizedBefore + 1,
    );
    expect(checkInvariants(world, [], DEMO_CONFIG)).toEqual([]);
  });

  it('创业评估与真实采购同源：unitCapacity/availableEquipmentUnits 一致，启动资本为百万级', () => {
    const world = Simulation.create().state;
    const tech = techOf(FACTORY_CITY);
    for (const kind of KINDS) {
      const goodId = DEMO_CONFIG.equipment.catalog[kind].goodId;
      const candidate = foundingCandidateForOutput(world, DEMO_CONFIG, FACTORY_CITY, goodId);
      const expectedUnitCapacity = Math.max(
        1,
        equipmentCapacityPerUnit(DEMO_CONFIG, 'industry', goodId) * tech,
      );
      expect(candidate.unitCapacity, `${goodId} unitCapacity`).toBeCloseTo(
        expectedUnitCapacity,
        2,
      );
      const supply = newEquipmentSupply(world, FACTORY_CITY, 'industry', DEMO_CONFIG);
      expect(candidate.availableEquipmentUnits).toBe(supply.total);
      // 旧口径 300,000 台/月会让启动资本达到数百亿；标定后应为百万级。
      expect(candidate.suggestedCapital).toBeGreaterThan(50_000);
      expect(candidate.suggestedCapital).toBeLessThan(20_000_000);
      expect(candidate.demandUnits).toBeGreaterThanOrEqual(1);
      expect(candidate.demandUnits).toBeLessThanOrEqual(
        DEMO_CONFIG.equipment.maxBuyUnitsPerMonth,
      );
    }
  });
});
