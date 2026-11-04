// v1.0 开局扩充企业（任务书第二、三节）：
// - 每城在原有 17 家企业之外新增 16 家，三城合计 65 家；
// - 行业分布符合“食品 3 / 谷物 3 / 能源 2 / 金属 1 / 设备 3 / 纤维纺织服装日用品 4”；
// - 新增企业具备真实开局资产（现金、员工、设备、库存、股份），不是运行时凭空发放；
// - 人口、就业、失业、非劳动与企业员工口径一致；
// - 读取真实 v0.9 旧存档不会追加开局企业，也不会再次乘人口。
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Simulation } from '../src/simulation/core/simulation';
import { DEMO_CONFIG } from '../src/data/config';
import { CITY_SEEDS, COMPANY_SEEDS, OPENING_COMPANIES } from '../src/data/demo-data';
import { checkInvariants } from '../src/simulation/core/invariants';
import {
  derivedEquipmentCapacity,
  equipmentKindForSector,
} from '../src/simulation/equipment/equipment';
import { parseSave, serializeSave } from '../src/simulation/core/save';

const OPENING_PER_CITY = 16;
const NEW_OUTPUTS = [
  'food',
  'grain',
  'energy',
  'metal',
  'farmEquipment',
  'industryEquipment',
  'energyEquipment',
  'fiber',
  'fabric',
  'clothing',
  'household',
] as const;

const openingIds = new Set(OPENING_COMPANIES.map((seed) => seed.id));

function isOpeningCompany(company: { id: string }): boolean {
  return openingIds.has(company.id);
}

describe('v1.0 开局扩充企业', () => {
  const world = Simulation.create(DEMO_CONFIG).state;

  it('总量 = 原有 17 + 新增 48 = 65，且原有企业全部保留', () => {
    expect(COMPANY_SEEDS.length).toBe(17);
    expect(OPENING_COMPANIES.length).toBe(48);
    expect(world.companies.length).toBe(65);
    for (const seed of COMPANY_SEEDS) {
      expect(world.companies.some((company) => company.id === seed.id)).toBe(true);
    }
    // 新增企业 id 不与原有企业冲突。
    const ids = new Set(world.companies.map((company) => company.id));
    expect(ids.size).toBe(world.companies.length);
  });

  it('每城恰好新增 16 家，行业分布符合任务书且每城产业链完整', () => {
    for (const city of CITY_SEEDS) {
      const opening = world.companies.filter(
        (company) => company.cityId === city.id && isOpeningCompany(company),
      );
      expect(opening.length, city.id).toBe(OPENING_PER_CITY);

      const countOutput = (output: string) =>
        opening.filter((company) => company.recipeOutput === output).length;
      expect(countOutput('food')).toBe(3);
      expect(countOutput('grain')).toBe(3);
      expect(countOutput('energy')).toBe(2);
      expect(countOutput('metal')).toBe(1);
      expect(countOutput('farmEquipment')).toBe(1);
      expect(countOutput('industryEquipment')).toBe(1);
      expect(countOutput('energyEquipment')).toBe(1);
      const fiberChain = opening.filter((company) =>
        ['fiber', 'fabric', 'clothing', 'household'].includes(company.recipeOutput),
      );
      expect(fiberChain.length).toBe(4);
      for (const output of ['fiber', 'fabric', 'clothing', 'household']) {
        expect(countOutput(output), `${city.id}:${output}`).toBeGreaterThanOrEqual(1);
      }
      // 每城新增企业覆盖全部行业（便于报告行业分布）。
      for (const output of NEW_OUTPUTS) {
        expect(countOutput(output), `${city.id}:${output}`).toBeGreaterThanOrEqual(1);
      }
    }

    // 世界中三类设备都有真实生产者，且每城各有一家。
    for (const good of ['farmEquipment', 'industryEquipment', 'energyEquipment']) {
      const producers = world.companies.filter((company) => company.recipeOutput === good);
      expect(producers.length, good).toBe(world.cities.length);
    }
  });

  it('新增企业有真实开局资产：员工、现金、设备、库存、股份', () => {
    for (const seed of OPENING_COMPANIES) {
      const company = world.companies.find((entry) => entry.id === seed.id);
      expect(company, seed.id).toBeDefined();
      if (!company) continue;
      expect(company.employees, seed.id).toBe(seed.employees);
      expect(company.cash, seed.id).toBeGreaterThan(0);
      expect(company.capacity, seed.id).toBeGreaterThan(0);
      const kind = equipmentKindForSector(company.sector, DEMO_CONFIG);
      expect(company.equipment[kind], seed.id).toBeGreaterThan(0);
      // 设备资产与缓存产能一致，且由设备台数独立推导也一致（不变量口径）。
      expect(company.equipmentCapacity, seed.id).toBeCloseTo(company.capacity, 2);
      expect(derivedEquipmentCapacity(world, company, DEMO_CONFIG), seed.id).toBeCloseTo(
        company.capacity,
        2,
      );
      expect(company.inventory[company.recipeOutput], seed.id).toBeGreaterThan(0);
      const hasInputs = Object.values(company.inventory).some((value) => value > 0);
      expect(hasInputs, seed.id).toBe(true);
      expect(company.totalShares, seed.id).toBeGreaterThan(0);
      const holdings = world.securities.holdings.filter(
        (holding) => holding.companyId === company.id && holding.shares > 0,
      );
      expect(holdings.length, seed.id).toBeGreaterThan(0);
      const heldShares = holdings.reduce((total, holding) => total + holding.shares, 0);
      expect(heldShares, seed.id).toBe(company.totalShares);
    }

    // 开局设备是企业已有资产，不应消耗政府设备储备。
    for (const kind of ['farm', 'industry', 'energy'] as const) {
      expect(world.equipmentMarket.initialStock[kind]).toBe(
        DEMO_CONFIG.equipment.governmentInitialStockPerCity[kind] * world.cities.length,
      );
    }
  });

  it('人口/就业/失业/非劳动守恒，企业员工与公共岗位不重复统计', () => {
    for (const city of world.cities) {
      const privateJobs = world.companies
        .filter((company) => company.cityId === city.id)
        .reduce((total, company) => total + company.employees, 0);
      expect(city.population.employed, city.id).toBe(city.publicSector.employees + privateJobs);
      expect(city.population.total, city.id).toBe(
        city.population.employed + city.population.unemployed + city.population.nonLabor,
      );
      expect(city.population.employed, city.id).toBeLessThanOrEqual(city.population.laborForce);
      expect(city.population.laborForce, city.id).toBe(
        city.population.employed + city.population.unemployed,
      );
    }
    expect(checkInvariants(world)).toEqual([]);
  });

  it('推进一个月后不变量仍通过（新增企业进入正常结算）', () => {
    const simulation = Simulation.create(DEMO_CONFIG);
    const result = simulation.tick();
    expect(result.ok, result.error).toBe(true);
    expect(checkInvariants(simulation.state)).toEqual([]);
    // 结算后企业数量不因创办/记录而重复，原有 65 家仍在。
    for (const seed of COMPANY_SEEDS) {
      expect(simulation.state.companies.some((company) => company.id === seed.id)).toBe(true);
    }
  });

  it('读取真实 v0.9 旧档不会追加开局企业或再次乘人口', () => {
    const text = readFileSync(
      new URL('./fixtures/v0.9-real-f942cc9.json', import.meta.url),
      'utf8',
    );
    const raw = JSON.parse(text) as {
      world: { companies: unknown[]; cities: { id: string; population: { total: number } }[] };
    };
    const parsed = parseSave(text);
    expect(parsed.ok, parsed.error).toBe(true);
    const loaded = parsed.world!;
    expect(loaded.companies.length).toBe(raw.world.companies.length);
    for (const seed of OPENING_COMPANIES) {
      expect(loaded.companies.some((company) => company.id === seed.id), seed.id).toBe(false);
    }
    for (const city of raw.world.cities) {
      const current = loaded.cities.find((entry) => entry.id === city.id);
      expect(current?.population.total, city.id).toBe(city.population.total);
    }

    // 保存→再次读取后仍不会追加。
    const again = parseSave(serializeSave(loaded));
    expect(again.ok, again.error).toBe(true);
    expect(again.world!.companies.length).toBe(loaded.companies.length);
  });
});
