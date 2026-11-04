// v0.9 真实设备链回归：政府储备释放计入市场供应、二手委托真实成交、
// 清算处置按 45% 残值出售或移交政府库存、存档往返仍通过市场守恒校验。
import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation/core/simulation';
import { DEMO_CONFIG } from '../src/data/config';
import { checkInvariants } from '../src/simulation/core/invariants';
import { parseSave, serializeSave } from '../src/simulation/core/save';
import { createWorldLedgers } from '../src/simulation/markets/markets';
import {
  buyNewEquipment,
  buyUsedEquipment,
  cancelUsedEquipmentOffer,
  disposeCompanyEquipment,
  equipmentCapacityFor,
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
    // 拆掉同城设备企业库存，强制走政府储备分支。
    for (const candidate of world.companies) {
      if (candidate.cityId === company.cityId) candidate.inventory[catalog.goodId] = 0;
    }
    // 清空同城设备企业库存后同步本城市场期末库存（v1.0 开局面板不再默认零库存）。
    world.cities.find((entry) => entry.id === company.cityId)!.market[catalog.goodId]!.closingStock = 0;
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
    // 设备成交先记 pendingLedger，由 createWorldLedgers 合并进当月账本（不直接写 city.market）。
    expect(world.equipmentMarket.pendingLedger?.length).toBe(1);
    const cityLedgers = createWorldLedgers(world)[company.cityId]!;
    expect(cityLedgers[catalog.goodId]!.demand).toBe(1);
    expect(cityLedgers[catalog.goodId]!.sold).toBe(1);
    expect(cityLedgers[catalog.goodId]!.sold).toBeLessThanOrEqual(
      cityLedgers[catalog.goodId]!.supply + 1e-6,
    );
    expect(world.equipmentMarket.pendingLedger).toEqual([]);
    expect(checkInvariants(world).filter((line) => line.includes('超过供应'))).toEqual([]);

    const parsed = parseSave(serializeSave(world));
    expect(parsed.ok).toBe(true);
    expect(parsed.error).toBeUndefined();
  });

  it('向同城设备企业购买：卖方库存/资金真实转移，成交计入该城设备商品账本并在月结后保留', () => {
    const sim = createWorld();
    const world = sim.state;
    const buyer = world.companies.find((entry) => entry.id === 'lp-food')!;
    const kind = equipmentKindForSector(buyer.sector, DEMO_CONFIG);
    const catalog = DEMO_CONFIG.equipment.catalog[kind];
    // 同城设备企业：取同城另一家企业作为卖方（测试夹具指认其产出该设备商品）。
    const seller =
      world.companies.find(
        (entry) =>
          entry.cityId === buyer.cityId &&
          entry.id !== buyer.id &&
          entry.recipeOutput === catalog.goodId,
      ) ??
      world.companies.find((entry) => entry.cityId === buyer.cityId && entry.id !== buyer.id)!;
    seller.recipeOutput = catalog.goodId;
    seller.inventory[catalog.goodId] = 5;
    const sellerCashBefore = seller.cash;
    const price = world.cities.find((entry) => entry.id === buyer.cityId)!.market[catalog.goodId]!.price;
    buyer.cash = price * 2;
    const buyerCashBefore = buyer.cash;

    const result = buyNewEquipment(world, buyer, kind, 1, DEMO_CONFIG, world.time.tick, {
      allowGovernmentStock: false,
      allowIntercity: false,
      reason: '同城企业采购测试',
    });

    expect(result.ok, result.error).toBe(true);
    expect(result.fromCompanies).toBe(1);
    expect(seller.inventory[catalog.goodId]).toBe(4);
    expect(seller.cash).toBeCloseTo(sellerCashBefore + price, 2);
    expect(buyer.cash).toBeCloseTo(buyerCashBefore - price, 2);

    const tickResult = sim.tick();
    expect(tickResult.ok, tickResult.error).toBe(true);
    const market = world.cities.find((entry) => entry.id === buyer.cityId)!.market[catalog.goodId]!;
    // v0.9 验收问题五/六：设备商品需求/成交不再被 finalizeMarkets 覆盖为 0。
    expect(market.demand).toBeGreaterThanOrEqual(1);
    expect(market.sold).toBeGreaterThanOrEqual(1);
    expect(market.sold).toBeLessThanOrEqual(market.supply + 1e-6);
    expect(checkInvariants(world)).toEqual([]);

    const parsed = parseSave(serializeSave(world));
    expect(parsed.ok, parsed.error).toBe(true);
    const restored = parsed.world!.cities.find((entry) => entry.id === buyer.cityId)!.market[catalog.goodId]!;
    expect(restored.demand).toBeCloseTo(market.demand, 2);
    expect(restored.sold).toBeCloseTo(market.sold, 2);
    expect(restored.supply).toBeCloseTo(market.supply, 2);
    expect(parsed.world!.equipmentMarket.pendingLedger ?? []).toEqual([]);
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

  it('撤销二手委托：设备返还后立即重算产能，部分成交/存档往返仍与设备一致', () => {
    const sim = createWorld();
    const world = sim.state;
    const seller = world.companies.find((entry) => entry.id === 'lp-food')!;
    const buyer = world.companies.find((entry) => entry.id === 'lp-garment')!;
    const unitsBefore = Math.floor(seller.equipment.industry);
    expect(unitsBefore).toBeGreaterThan(2);

    const listed = listUsedEquipment(world, seller, 'industry', 2, DEMO_CONFIG, world.time.tick, 123_456);
    expect(listed.ok, listed.error).toBe(true);
    const offerId = listed.offerId!;
    expect(seller.equipment.industry).toBe(unitsBefore - 2);
    expect(seller.capacity).toBeCloseTo(equipmentCapacityFor(world, seller, DEMO_CONFIG), 2);
    expect(seller.equipmentCapacity).toBeCloseTo(seller.capacity, 2);

    // 部分成交 1 台，剩余 1 台委托被撤销。
    const partial = buyUsedEquipment(world, buyer, offerId, 1, DEMO_CONFIG, world.time.tick);
    expect(partial.ok, partial.error).toBe(true);
    const cancel = cancelUsedEquipmentOffer(world, seller.id, offerId, DEMO_CONFIG);
    expect(cancel.ok, cancel.error).toBe(true);
    expect(world.equipmentMarket.offers).toEqual([]);
    expect(seller.equipment.industry).toBe(unitsBefore - 1);
    expect(seller.capacity).toBeCloseTo(equipmentCapacityFor(world, seller, DEMO_CONFIG), 2);
    expect(seller.equipmentCapacity).toBeCloseTo(seller.capacity, 2);
    expect(buyer.equipmentCapacity).toBeCloseTo(buyer.capacity, 2);
    expect(seller.maxCapacity).toBeGreaterThanOrEqual(seller.capacity);
    expect(checkInvariants(world)).toEqual([]);

    const parsed = parseSave(serializeSave(world));
    expect(parsed.ok, parsed.error).toBe(true);
    const reloaded = parsed.world!.companies.find((entry) => entry.id === seller.id)!;
    expect(reloaded.equipment).toEqual(seller.equipment);
    expect(reloaded.capacity).toBeCloseTo(seller.capacity, 2);
    expect(reloaded.equipmentCapacity).toBeCloseTo(seller.equipmentCapacity, 2);
    expect(reloaded.maxCapacity).toBeCloseTo(seller.maxCapacity, 2);
  });

  it('独立一致性检查：只改产能缓存而不改设备时，不变量能报出设备推导产能不一致', () => {
    const sim = createWorld();
    const world = sim.state;
    const company = world.companies[0]!;
    const consistent = company.capacity;
    // 只篡改缓存，不改设备台数：独立推导必须报出不一致。
    company.capacity = consistent + 300_000;
    company.equipmentCapacity = consistent + 300_000;
    const problems = checkInvariants(world);
    expect(problems.some((line) => line.includes('按设备推导产能'))).toBe(true);
    // 只改 capacity、不改 equipmentCapacity 时，也会报“产能与设备产能不一致”。
    company.capacity = consistent;
    company.equipmentCapacity = consistent;
    company.capacity = consistent + 300_000;
    expect(checkInvariants(world).some((line) => line.includes('不一致'))).toBe(true);
    company.capacity = consistent;
    expect(checkInvariants(world)).toEqual([]);
  });
});
