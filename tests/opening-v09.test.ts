// v0.9 开局校验：人口 ×5、非劳动 20% / 劳动力 80%、人口互斥守恒、
// 企业数量仍为 17 家、设备资产与产能一致、设备市场开局库存。
import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation/core/simulation';
import { DEMO_CONFIG } from '../src/data/config';
import { CITY_SEEDS, COMPANY_SEEDS } from '../src/data/demo-data';
import { equipmentKindForSector } from '../src/simulation/equipment/equipment';
import { checkInvariants } from '../src/simulation/core/invariants';

describe('v0.9 开局人口与企业数量', () => {
  it('每城人口 = 基线 × 5，非劳动 20%，劳动力 80%，P=E+U+N', () => {
    const world = Simulation.create(DEMO_CONFIG).state;
    for (const seed of CITY_SEEDS) {
      const city = world.cities.find((entry) => entry.id === seed.id)!;
      const total = seed.totalPopulation * DEMO_CONFIG.population.initialPopulationMultiplier;
      expect(city.population.total).toBe(total);
      expect(city.population.nonLabor).toBe(Math.round(total * 0.2));
      expect(city.population.laborForce).toBe(total - city.population.nonLabor);
      expect(city.population.total).toBe(
        city.population.employed + city.population.unemployed + city.population.nonLabor,
      );
      // 公共部门岗位不随人口乘 5。
      expect(city.publicSector.jobs).toBe(seed.publicJobs);
      expect(city.publicSector.employees).toBe(seed.publicJobs);
      // 就业 = 公共部门 + 本城企业员工，且不超过劳动力。
      const privateJobs = world.companies
        .filter((company) => company.cityId === city.id)
        .reduce((totalJobs, company) => totalJobs + company.employees, 0);
      expect(city.population.employed).toBe(city.publicSector.employees + privateJobs);
      expect(city.population.employed).toBeLessThanOrEqual(city.population.laborForce);
    }
  });

  it('初始企业数量不变（17 家），上限提高到 160', () => {
    const world = Simulation.create(DEMO_CONFIG).state;
    expect(world.companies.length).toBe(COMPANY_SEEDS.length);
    expect(COMPANY_SEEDS.length).toBe(17);
    expect(DEMO_CONFIG.lifecycle.maxCompaniesPerCity).toBe(160);
    expect(DEMO_CONFIG.lifecycle.maxFoundingsPerCityMonth).toBe(2);
  });

  it('每家企业有与行业匹配的设备资产，设备产能 = 缓存产能', () => {
    const world = Simulation.create(DEMO_CONFIG).state;
    for (const company of world.companies) {
      const kind = equipmentKindForSector(company.sector, DEMO_CONFIG);
      const city = world.cities.find((entry) => entry.id === company.cityId)!;
      const perUnit = DEMO_CONFIG.equipment.catalog[kind].capacityPerUnit;
      const expectedUnits = Math.max(
        1,
        Math.round(company.capacity / (perUnit * city.technology.productivityMultiplier)),
      );
      expect(company.equipment[kind]).toBe(expectedUnits);
      const otherKinds = (['farm', 'industry', 'energy'] as const).filter((entry) => entry !== kind);
      for (const other of otherKinds) expect(company.equipment[other]).toBe(0);
      expect(company.equipmentCapacity).toBeCloseTo(company.capacity, 2);
      expect(company.salesHistory).toEqual([]);
      expect(company.productionPlan).toBeNull();
    }
  });

  it('设备市场注入开局政府库存，且没有挂单；开局不变量通过', () => {
    const world = Simulation.create(DEMO_CONFIG).state;
    const cityCount = world.cities.length;
    expect(world.equipmentMarket.initialStock.farm).toBe(
      DEMO_CONFIG.equipment.governmentInitialStockPerCity.farm * cityCount,
    );
    expect(world.equipmentMarket.initialStock.industry).toBe(
      DEMO_CONFIG.equipment.governmentInitialStockPerCity.industry * cityCount,
    );
    expect(world.equipmentMarket.initialStock.energy).toBe(
      DEMO_CONFIG.equipment.governmentInitialStockPerCity.energy * cityCount,
    );
    expect(world.equipmentMarket.offers).toEqual([]);
    expect(checkInvariants(world)).toEqual([]);
  });

  it('新开局首月结算后不变量仍通过（人口/设备/产能一致）', () => {
    const simulation = Simulation.create(DEMO_CONFIG);
    for (let month = 0; month < 3; month += 1) {
      const result = simulation.tick();
      expect(result.ok, result.error).toBe(true);
      expect(checkInvariants(simulation.state)).toEqual([]);
    }
  });
});
