// 跨城设备采购与创业设备口径（v0.9 验收问题六设备部分）。
//
// 规则：
// - 本城设备不足时，允许通过既有跨城交易/运输模型向其他城市真实设备企业购买；
// - 同城企业 → 政府库存 → 其他城市，同城优先；
// - 卖方真实出库、真实收款，买方真实付款，运输结算记录进入 pendingSales / tradeFlows；
// - 创业候选的“可用设备”评估与实际采购使用同一来源函数（newEquipmentSupply）。
import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation/core/simulation';
import { DEMO_CONFIG } from '../src/data/config';
import { checkInvariants } from '../src/simulation/core/invariants';
import {
  buyNewEquipment,
  newEquipmentSupply,
} from '../src/simulation/equipment/equipment';
import {
  foundingCandidateForOutput,
  plannedEquipmentUnits,
} from '../src/simulation/companies/founding';
import { createWorldLedgers } from '../src/simulation/markets/markets';
import { settleTransportMonth } from '../src/simulation/transport/settlement';

function createWorld() {
  return Simulation.create(DEMO_CONFIG).state;
}

/** 清空所有设备商品库存与政府设备库存，精确控制设备来源。 */
function clearEquipmentSupply(world: ReturnType<typeof createWorld>): void {
  for (const company of world.companies) {
    company.inventory.industryEquipment = 0;
  }
  for (const city of world.cities) {
    const ledger = city.market.industryEquipment!;
    ledger.closingStock = 0;
    ledger.supply = 0;
    ledger.sold = 0;
    ledger.demand = 0;
    ledger.intercityImported = 0;
  }
  world.equipmentMarket.initialStock.industry = 0;
}

function setEquipmentSeller(
  world: ReturnType<typeof createWorld>,
  companyId: string,
  units: number,
): ReturnType<typeof createWorld>['companies'][number] {
  const seller = world.companies.find((entry) => entry.id === companyId)!;
  seller.recipeOutput = 'industryEquipment';
  seller.inventory.industryEquipment = units;
  const city = world.cities.find((entry) => entry.id === seller.cityId)!;
  city.market.industryEquipment!.closingStock = units;
  return seller;
}

describe('跨城设备采购', () => {
  it('本城无供给时向其他城市设备企业购买：真实付款/出库/运输记录，同城优先', () => {
    const world = createWorld();
    clearEquipmentSupply(world);
    const buyer = world.companies.find((entry) => entry.id === 'lp-food')!;
    buyer.cash = 5_000_000;
    const seller = setEquipmentSeller(world, 'iv-metal', 3);
    const sellerCity = world.cities.find((entry) => entry.id === seller.cityId)!;
    const buyerCity = world.cities.find((entry) => entry.id === buyer.cityId)!;
    const sellerCashBefore = seller.cash;
    const buyerCashBefore = buyer.cash;
    const equipmentBefore = Math.floor(buyer.equipment.industry);
    const pendingBefore = world.transport.pendingSales.length;
    const flowsBefore = world.lastTick.tradeFlows.length;

    const result = buyNewEquipment(world, buyer, 'industry', 2, DEMO_CONFIG, world.time.tick, {
      allowGovernmentStock: true,
      reason: '跨城设备测试',
    });

    expect(result.ok, result.error).toBe(true);
    expect(result.fromIntercity).toBe(2);
    expect(result.fromCompanies).toBe(0);
    expect(result.fromGovernment).toBe(0);
    expect(result.cost).toBeGreaterThan(0);
    expect(Math.floor(buyer.equipment.industry)).toBe(equipmentBefore + 2);
    expect(buyer.cash).toBeCloseTo(buyerCashBefore - result.cost, 2);
    expect(seller.inventory.industryEquipment).toBe(1);
    // 跨城卖方所得不在成交时立刻到账，而是随月末运力结算（既有跨城模型）。
    expect(seller.cash).toBeCloseTo(sellerCashBefore, 2);
    expect(buyer.capacity).toBeCloseTo(buyer.equipmentCapacity, 2);
    const mergedLedger = createWorldLedgers(world)[buyerCity.id]!.industryEquipment!;
    expect(mergedLedger.intercityImported).toBe(2);
    expect(mergedLedger.demand).toBe(2);
    expect(mergedLedger.sold).toBe(0);

    // 运输结算记录：进入 pendingSales，供月末运力/运费结算；同时记入本 tick 的贸易流。
    expect(world.transport.pendingSales.length).toBe(pendingBefore + 1);
    const sale = world.transport.pendingSales[world.transport.pendingSales.length - 1]!;
    expect(sale.path).toBe('intercityPurchase');
    expect(sale.fromCityId).toBe(seller.cityId);
    expect(sale.toCityId).toBe(buyer.cityId);
    expect(sale.sellerCompanyId).toBe(seller.id);
    expect(sale.buyerCompanyId).toBe(buyer.id);
    expect(sale.good).toBe('industryEquipment');
    expect(sale.qty).toBe(2);
    expect(sale.grossValue).toBeCloseTo(result.cost, 2);
    expect(world.lastTick.tradeFlows.length).toBe(flowsBefore + 1);
    const flow = world.lastTick.tradeFlows[world.lastTick.tradeFlows.length - 1]!;
    expect(flow.path).toBe('intercityPurchase');
    expect(flow.fromCityId).toBe(seller.cityId);
    expect(flow.toCityId).toBe(buyer.cityId);

    // 月末运力结算：卖方按容量扣减后的实收到账，容量损失部分退回买方。
    settleTransportMonth(world, DEMO_CONFIG, [], createWorldLedgers(world));
    expect(world.transport.pendingSales).toEqual([]);
    const sellerProceeds = seller.cash - sellerCashBefore;
    const buyerRefund = buyer.cash - (buyerCashBefore - result.cost);
    expect(sellerProceeds).toBeGreaterThan(0);
    expect(sellerProceeds + buyerRefund).toBeCloseTo(result.cost, 2);
    expect(buyerRefund).toBeGreaterThanOrEqual(0);

    // 成交后卖方库存减少，期末库存与之一致（真实月结会在期末重算）。
    sellerCity.market.industryEquipment!.closingStock = seller.inventory.industryEquipment;
    expect(checkInvariants(world)).toEqual([]);
  });

  it('同城企业有货时优先同城，不产生跨城成交', () => {
    const world = createWorld();
    clearEquipmentSupply(world);
    const buyer = world.companies.find((entry) => entry.id === 'lp-food')!;
    buyer.cash = 5_000_000;
    const localSeller = setEquipmentSeller(world, 'lp-garment', 1);
    const remoteSeller = setEquipmentSeller(world, 'iv-metal', 3);
    const pendingBefore = world.transport.pendingSales.length;

    const result = buyNewEquipment(world, buyer, 'industry', 1, DEMO_CONFIG, world.time.tick, {
      allowGovernmentStock: true,
    });

    expect(result.ok, result.error).toBe(true);
    expect(result.fromCompanies).toBe(1);
    expect(result.fromIntercity).toBe(0);
    expect(localSeller.inventory.industryEquipment).toBe(0);
    expect(remoteSeller.inventory.industryEquipment).toBe(3);
    expect(world.transport.pendingSales.length).toBe(pendingBefore);
  });

  it('创业候选的可用设备评估与实际采购同口径（含其他城市供给）', () => {
    const world = createWorld();
    clearEquipmentSupply(world);
    setEquipmentSeller(world, 'iv-metal', 2);

    const supply = newEquipmentSupply(world, 'lanport', 'industry', DEMO_CONFIG);
    expect(supply.local).toBe(0);
    expect(supply.government).toBe(0);
    expect(supply.intercity).toBe(2);
    expect(supply.total).toBe(2);

    const candidate = foundingCandidateForOutput(world, DEMO_CONFIG, 'lanport', 'food');
    expect(candidate.equipmentKind).toBe('industry');
    expect(candidate.availableEquipmentUnits).toBe(supply.total);
    expect(candidate.breakdown.equipment).toBeGreaterThan(0);
    const planned = plannedEquipmentUnits(candidate, 100_000_000, DEMO_CONFIG);
    expect(planned).toBeGreaterThan(0);
    expect(planned).toBeLessThanOrEqual(supply.total);

    // 实际采购走同一来源：同一世界、同一城市，确实能从其他城市买到评估中的设备。
    const buyer = world.companies.find((entry) => entry.id === 'lp-food')!;
    buyer.cash = 100_000_000;
    const purchase = buyNewEquipment(world, buyer, 'industry', planned, DEMO_CONFIG, world.time.tick, {
      allowGovernmentStock: true,
    });
    expect(purchase.ok, purchase.error).toBe(true);
    expect(purchase.fromIntercity).toBe(planned);
  });
});
