// v0.9 真实设备链回归：政府储备释放计入市场供应、二手委托真实成交、
// 清算处置按 45% 残值出售或移交政府库存、存档往返仍通过市场守恒校验。
import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation/core/simulation';
import { DEMO_CONFIG } from '../src/data/config';
import { checkInvariants } from '../src/simulation/core/invariants';
import { parseSave, serializeSave } from '../src/simulation/core/save';
import {
  buyNewEquipment,
  buyUsedEquipment,
  disposeCompanyEquipment,
  equipmentKindForSector,
  listUsedEquipment,
} from '../src/simulation/equipment/equipment';

function createWorld() {
  return Simulation.create(DEMO_CONFIG);
}

describe('v0.9 真实设备链', () => {
  it('购买政府储备设备：计入市场供应与成交，市场守恒不被破坏，存档可通过校验', () => {
    const sim = createWorld();
    const world = sim.state;
    const company = world.companies.find((entry) => entry.cityId === 'lanport')!;
    const kind = equipmentKindForSector(company.sector, DEMO_CONFIG);
    const catalog = DEMO_CONFIG.equipment.catalog[kind];
    const ledger = world.cities.find((entry) => entry.id === company.cityId)!.market[catalog.goodId]!;
    const supplyBefore = ledger.supply;
    const soldBefore = ledger.sold;
    // 拆掉同城设备企业库存，强制走政府储备分支。
    for (const candidate of world.companies) {
      if (candidate.cityId === company.cityId) candidate.inventory[catalog.goodId] = 0;
    }
    const stockBefore = Math.floor(world.equipmentMarket.initialStock[kind]);
    const unitsBefore = Math.floor(company.equipment[kind]);
    expect(stockBefore).toBeGreaterThan(0);

    const result = buyNewEquipment(world, company, kind, 1, DEMO_CONFIG, world.time.tick, {
      allowGovernmentStock: true,
      reason: '测试采购',
    });

    expect(result.ok).toBe(true);
    expect(result.fromGovernment).toBe(1);
    expect(result.fromCompanies).toBe(0);
    expect(Math.floor(company.equipment[kind])).toBe(unitsBefore + 1);
    expect(Math.floor(world.equipmentMarket.initialStock[kind])).toBe(stockBefore - 1);
    expect(ledger.supply).toBe(supplyBefore + 1);
    expect(ledger.sold).toBe(soldBefore + 1);
    expect(checkInvariants(world).filter((line) => line.includes('超过供应'))).toEqual([]);

    const parsed = parseSave(serializeSave(world));
    expect(parsed.ok).toBe(true);
    expect(parsed.error).toBeUndefined();
  });

  it('二手委托真实成交：设备与资金双向转移、产能同步重算、委托清空', () => {
    const sim = createWorld();
    const world = sim.state;
    const seller = world.companies.find((entry) => entry.id === 'lp-food')!;
    const buyer = world.companies.find((entry) => entry.id === 'lp-garment')!;
    const askPrice = 123_456;
    const listed = listUsedEquipment(world, seller, 'industry', 2, DEMO_CONFIG, world.time.tick, askPrice);
    expect(listed.ok).toBe(true);
    const offer = world.equipmentMarket.offers.find((entry) => entry.companyId === seller.id)!;
    expect(offer.units).toBe(2);
    expect(seller.equipment.industry).toBe(10);

    const cashBefore = buyer.cash;
    const capacityBefore = buyer.capacity;
    const sellerCashBefore = seller.cash;
    const bought = buyUsedEquipment(world, buyer, offer.id, 2, DEMO_CONFIG, world.time.tick);
    expect(bought.ok).toBe(true);
    expect(bought.units).toBe(2);
    expect(buyer.equipment.industry).toBe(3);
    expect(world.equipmentMarket.offers).toEqual([]);
    expect(buyer.cash).toBeCloseTo(cashBefore - askPrice * 2, 2);
    expect(seller.cash).toBeCloseTo(sellerCashBefore + askPrice * 2, 2);
    expect(buyer.equipmentCapacity).toBeCloseTo(buyer.capacity, 2);
    expect(buyer.capacity).toBeGreaterThan(capacityBefore);
  });

  it('清算处置设备：按 45% 残值出售给同城买家，无人购买的部分移交政府库存', () => {
    const sim = createWorld();
    const world = sim.state;
    const company = world.companies.find((entry) => entry.id === 'lp-food')!;
    const units = Math.floor(company.equipment.industry);
    expect(units).toBeGreaterThan(0);
    // 清空其他企业现金，制造“无人购买”场景，验证移交政府库存而不消失。
    for (const other of world.companies) {
      if (other.id !== company.id) other.cash = 0;
    }
    const stockBefore = Math.floor(world.equipmentMarket.initialStock.industry);
    const log: Array<{ tick: number; kind: string; message: string }> = [];
    const result = disposeCompanyEquipment(world, company, DEMO_CONFIG, world.time.tick, log as never);
    expect(result.unitsSold + result.unitsConsigned).toBe(units);
    expect(result.proceeds).toBe(0);
    expect(result.unitsConsigned).toBe(units);
    expect(Math.floor(world.equipmentMarket.initialStock.industry)).toBe(stockBefore + result.unitsConsigned);
  });
});
