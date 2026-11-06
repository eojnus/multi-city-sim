// v1.7 §一 F1：未成交二手挂单设备仍计维护费（用户验收复现 + 责任切换/不重复/不漏）。
//
// 复现：企业持 2 台工业设备、本月维护费 3,800；以极高价格挂单（未成交）→ 当月仍 3,800；
// v1.6 下个月挂单仍未成交，但维护费变成 0——因为 listUsedEquipment 把台数从 company.equipment
// 移到 equipmentMarket.offers，而月初快照只统计 company.equipment。
//
// v1.7 口径：计费台数 = 当前 equipment + 该企业未成交二手挂单 units（逐类）；
// - tick 开头快照、无快照直调回退、AI 估算 helper 同口径；
// - 成交按月初持有时点切换责任：卖方当月已计、买方下月起计；
// - 撤单/部分成交/存读档不重复不漏；
// - 挂单只影响计费台数，不重复计入产能（equipment / capacity / recompute 逻辑不变）。
import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation/core/simulation';
import { DEMO_CONFIG } from '../src/data/config';
import type { Company, LogEntry, WorldState } from '../src/simulation/contracts/types';
import { checkInvariants } from '../src/simulation/core/invariants';
import { round2 } from '../src/simulation/core/math';
import { parseSave, serializeSave } from '../src/simulation/core/save';
import {
  buyUsedEquipment,
  cancelUsedEquipmentOffer,
  equipmentCapacityFor,
  listUsedEquipment,
  recomputeCompanyCapacity,
} from '../src/simulation/equipment/equipment';
import {
  beginEquipmentMaintenanceMonth,
  equipmentMaintenanceMonthFlow,
  estimatedMonthlyMaintenance,
  maintenanceBilledUnits,
  monthlyMaintenanceDue,
  settleCompanyMaintenance,
} from '../src/simulation/equipment/maintenance';

const INDUSTRY_PRICE = 190_000;
/** 2 台工业设备 × 190,000 × 1% = 3,800（与用户验收复现数字一致）。 */
const TWO_INDUSTRY_FEE = 3_800;

function newWorld(): WorldState {
  return Simulation.create().state;
}

function companyOf(world: WorldState, id: string): Company {
  const found = world.companies.find((entry) => entry.id === id);
  if (!found) throw new Error(`测试世界没有企业 ${id}`);
  return found;
}

/** 固定三城设备市场价，保证“1% 计价”断言可复现（月初快照取这里的价格）。 */
function setEquipmentPrices(world: WorldState): void {
  const ids = {
    farm: DEMO_CONFIG.equipment.catalog.farm.goodId,
    industry: DEMO_CONFIG.equipment.catalog.industry.goodId,
    energy: DEMO_CONFIG.equipment.catalog.energy.goodId,
  } as const;
  for (const city of world.cities) {
    city.market[ids.farm]!.price = 120_000;
    city.market[ids.industry]!.price = INDUSTRY_PRICE;
    city.market[ids.energy]!.price = 160_000;
  }
}

/** 只读地改变企业设备台数并同步产能缓存（避免触发设备/产能一致性不变量）。 */
function setEquipment(world: WorldState, company: Company, equipment: Partial<Company['equipment']>): void {
  company.equipment = { ...company.equipment, ...equipment };
  recomputeCompanyCapacity(world, company, DEMO_CONFIG);
}

/** 挂出未成交的高价二手设备（价格远高于市场，保证跨月不成交）。 */
function listHighPriceOffer(world: WorldState, company: Company, units: number): void {
  const result = listUsedEquipment(
    world,
    company,
    'industry',
    units,
    DEMO_CONFIG,
    world.time.tick,
    99_000_000,
  );
  if (!result.ok) throw new Error(result.error ?? '挂单失败');
}

describe('v1.7 §一 F1 未成交二手挂单维护费', () => {
  it('用户复现：2 台工业设备挂单未成交，跨月仍按 3,800/月 计费（不再变 0）', () => {
    const world = newWorld();
    setEquipmentPrices(world);
    world.time.tick = 1;
    const company = companyOf(world, 'lp-garment');
    setEquipment(world, company, { farm: 0, industry: 2, energy: 0 });

    // 第 1 月：月初持有 2 台 → 维护费 3,800。
    beginEquipmentMaintenanceMonth(world, DEMO_CONFIG);
    expect(monthlyMaintenanceDue(world, company, DEMO_CONFIG).due).toBe(TWO_INDUSTRY_FEE);
    settleCompanyMaintenance(world, DEMO_CONFIG, []);
    expect(company.lastMonth.maintenanceDue).toBe(TWO_INDUSTRY_FEE);

    // 月内以极高价格挂单 2 台（未成交）：equipment 2 → 0，offer 2。
    listHighPriceOffer(world, company, 2);
    expect(company.equipment.industry).toBe(0);
    expect(world.equipmentMarket.offers.filter((offer) => offer.companyId === company.id)).toHaveLength(1);

    // 第 2 月：挂单仍未成交——v1.6 此处维护费变 0，v1.7 必须仍计 3,800。
    world.time.tick = 2;
    beginEquipmentMaintenanceMonth(world, DEMO_CONFIG);
    expect(company.maintenanceBase?.industry).toBe(2);
    const due = monthlyMaintenanceDue(world, company, DEMO_CONFIG);
    expect(due.basis).toBe('monthStartSnapshot');
    expect(due.unitsByKind.industry).toBe(2);
    expect(due.due).toBe(TWO_INDUSTRY_FEE);
    settleCompanyMaintenance(world, DEMO_CONFIG, []);
    expect(company.lastMonth.maintenanceDue).toBe(TWO_INDUSTRY_FEE);
    expect(company.lastMonth.maintenancePaid).toBe(TWO_INDUSTRY_FEE);
    // 挂单与设备台数不变（只影响计费台数，不移动/复制设备）。
    expect(company.equipment.industry).toBe(0);
    expect(
      world.equipmentMarket.offers
        .filter((offer) => offer.companyId === company.id)
        .reduce((total, offer) => total + offer.units, 0),
    ).toBe(2);
  });

  it('高价长期挂单连续 3 个月未成交：每月都计费，挂单设备不重复计入产能', () => {
    const world = newWorld();
    setEquipmentPrices(world);
    world.time.tick = 1;
    const company = companyOf(world, 'lp-garment');
    setEquipment(world, company, { farm: 0, industry: 2, energy: 0 });
    beginEquipmentMaintenanceMonth(world, DEMO_CONFIG);
    settleCompanyMaintenance(world, DEMO_CONFIG, []);
    listHighPriceOffer(world, company, 2);

    // 挂单后产能只按 equipment=0 计（挂单不重复计入产能）。
    expect(company.equipment.industry).toBe(0);
    expect(company.capacity).toBe(0);
    expect(company.equipmentCapacity).toBe(0);
    expect(equipmentCapacityFor(world, company, DEMO_CONFIG)).toBe(0);
    // 但计费台数与 AI 估算必须包含挂单。
    expect(maintenanceBilledUnits(world, company).industry).toBe(2);
    expect(estimatedMonthlyMaintenance(world, company, DEMO_CONFIG)).toBe(TWO_INDUSTRY_FEE);

    for (const tick of [2, 3, 4]) {
      world.time.tick = tick;
      beginEquipmentMaintenanceMonth(world, DEMO_CONFIG);
      expect(monthlyMaintenanceDue(world, company, DEMO_CONFIG).due).toBe(TWO_INDUSTRY_FEE);
      settleCompanyMaintenance(world, DEMO_CONFIG, []);
      expect(company.lastMonth.maintenanceDue).toBe(TWO_INDUSTRY_FEE);
      expect(company.lastMonth.maintenancePaid).toBe(TWO_INDUSTRY_FEE);
      // 设备与产能口径始终不受计费影响。
      expect(company.capacity).toBe(0);
      expect(company.equipmentCapacity).toBe(0);
    }
    const offerUnits = world.equipmentMarket.offers
      .filter((offer) => offer.companyId === company.id)
      .reduce((total, offer) => total + offer.units, 0);
    expect(offerUnits).toBe(2);
    expect(checkInvariants(world)).toEqual([]);
  });

  it('部分成交：卖方按月初台数付当月，买方下月起计费；剩余挂单继续计入卖方', () => {
    const world = newWorld();
    setEquipmentPrices(world);
    world.time.tick = 1;
    const seller = companyOf(world, 'lp-garment');
    const buyer = companyOf(world, 'lp-food');
    setEquipment(world, seller, { farm: 0, industry: 5, energy: 0 });
    setEquipment(world, buyer, { farm: 0, industry: 0, energy: 0 });
    beginEquipmentMaintenanceMonth(world, DEMO_CONFIG);

    // 月内挂 3 台、成交 1 台：卖方 equipment 2 + offer 2；买方 equipment 1。
    listHighPriceOffer(world, seller, 3);
    const offer = world.equipmentMarket.offers.find((entry) => entry.companyId === seller.id)!;
    offer.askPrice = INDUSTRY_PRICE; // 让买方买得起（真实资金转移）
    const bought = buyUsedEquipment(world, buyer, offer.id, 1, DEMO_CONFIG, world.time.tick);
    expect(bought.ok, bought.error).toBe(true);
    expect(bought.units).toBe(1);
    expect(seller.equipment.industry).toBe(2);
    expect(buyer.equipment.industry).toBe(1);

    // 第 1 月：卖方按月初 5 台计费；买方当月买入不计费。
    expect(monthlyMaintenanceDue(world, seller, DEMO_CONFIG).unitsByKind.industry).toBe(5);
    expect(monthlyMaintenanceDue(world, buyer, DEMO_CONFIG).due).toBe(0);
    settleCompanyMaintenance(world, DEMO_CONFIG, []);
    expect(seller.lastMonth.maintenanceDue).toBe(5 * INDUSTRY_PRICE * 0.01);
    expect(buyer.lastMonth.maintenanceDue).toBe(0);

    // 第 2 月：卖方 = 2 台 equipment + 2 台剩余挂单；买方 = 1 台。
    world.time.tick = 2;
    beginEquipmentMaintenanceMonth(world, DEMO_CONFIG);
    expect(monthlyMaintenanceDue(world, seller, DEMO_CONFIG).unitsByKind.industry).toBe(4);
    expect(monthlyMaintenanceDue(world, buyer, DEMO_CONFIG).unitsByKind.industry).toBe(1);
    expect(monthlyMaintenanceDue(world, buyer, DEMO_CONFIG).due).toBe(1 * INDUSTRY_PRICE * 0.01);
  });

  it('撤单：台数回到 equipment，按月初快照计费不重复、不漏', () => {
    const world = newWorld();
    setEquipmentPrices(world);
    world.time.tick = 1;
    const company = companyOf(world, 'lp-garment');
    setEquipment(world, company, { farm: 0, industry: 4, energy: 0 });
    beginEquipmentMaintenanceMonth(world, DEMO_CONFIG);
    listHighPriceOffer(world, company, 2);
    settleCompanyMaintenance(world, DEMO_CONFIG, []);
    expect(company.lastMonth.maintenanceDue).toBe(4 * INDUSTRY_PRICE * 0.01);

    // 第 2 月快照 = equipment 2 + 挂单 2 = 4（不重复计）；月内撤单后 equipment 回到 4。
    world.time.tick = 2;
    beginEquipmentMaintenanceMonth(world, DEMO_CONFIG);
    expect(company.maintenanceBase?.industry).toBe(4);
    const offer = world.equipmentMarket.offers.find((entry) => entry.companyId === company.id)!;
    expect(cancelUsedEquipmentOffer(world, company.id, offer.id, DEMO_CONFIG).ok).toBe(true);
    expect(company.equipment.industry).toBe(4);
    expect(world.equipmentMarket.offers.filter((entry) => entry.companyId === company.id)).toHaveLength(0);
    settleCompanyMaintenance(world, DEMO_CONFIG, []);
    expect(company.lastMonth.maintenanceDue).toBe(4 * INDUSTRY_PRICE * 0.01);

    // 第 3 月：撤单后按 equipment 4 计，不多算成 6 台。
    world.time.tick = 3;
    beginEquipmentMaintenanceMonth(world, DEMO_CONFIG);
    expect(monthlyMaintenanceDue(world, company, DEMO_CONFIG).unitsByKind.industry).toBe(4);
    expect(monthlyMaintenanceDue(world, company, DEMO_CONFIG).due).toBe(4 * INDUSTRY_PRICE * 0.01);
  });

  it('存读档往返：挂单、月初快照与计费口径一致保留', () => {
    const world = newWorld();
    setEquipmentPrices(world);
    world.time.tick = 1;
    const company = companyOf(world, 'lp-garment');
    setEquipment(world, company, { farm: 0, industry: 3, energy: 0 });
    beginEquipmentMaintenanceMonth(world, DEMO_CONFIG);
    listHighPriceOffer(world, company, 2); // equipment 1 + offer 2 = 计费 3

    const parsed = parseSave(serializeSave(world));
    expect(parsed.ok, parsed.error).toBe(true);
    const restoredWorld = parsed.world!;
    const restored = companyOf(restoredWorld, 'lp-garment');
    expect(restored.equipment.industry).toBe(1);
    const restoredOffers = restoredWorld.equipmentMarket.offers.filter(
      (offer) => offer.companyId === restored.id,
    );
    expect(restoredOffers.reduce((total, offer) => total + offer.units, 0)).toBe(2);
    expect(restored.maintenanceBase?.industry).toBe(3);
    expect(monthlyMaintenanceDue(restoredWorld, restored, DEMO_CONFIG).unitsByKind.industry).toBe(3);
    expect(monthlyMaintenanceDue(restoredWorld, restored, DEMO_CONFIG).due).toBe(3 * INDUSTRY_PRICE * 0.01);
    expect(maintenanceBilledUnits(restoredWorld, restored).industry).toBe(3);
    // 读档后结算同样按挂单口径计费，且不移动设备。
    settleCompanyMaintenance(restoredWorld, DEMO_CONFIG, []);
    expect(restored.lastMonth.maintenanceDue).toBe(3 * INDUSTRY_PRICE * 0.01);
    expect(restored.equipment.industry).toBe(1);
    expect(
      restoredWorld.equipmentMarket.offers
        .filter((offer) => offer.companyId === restored.id)
        .reduce((total, offer) => total + offer.units, 0),
    ).toBe(2);
    expect(equipmentMaintenanceMonthFlow(restoredWorld)?.tick).toBe(1);
  });

  it('无 tick 快照的直调回退与 AI 估算同口径（equipment + 挂单），且只读', () => {
    const world = newWorld();
    setEquipmentPrices(world);
    const company = companyOf(world, 'lp-garment');
    setEquipment(world, company, { farm: 0, industry: 2, energy: 0 });
    listHighPriceOffer(world, company, 2); // equipment 0 + offer 2
    const before = JSON.stringify(world);
    // 直调（没有 begin 快照）：回退当前 equipment + 未成交挂单，不能算成 0。
    const due = monthlyMaintenanceDue(world, company, DEMO_CONFIG);
    expect(due.basis).toBe('currentFallback');
    expect(due.unitsByKind.industry).toBe(2);
    expect(due.due).toBe(TWO_INDUSTRY_FEE);
    expect(estimatedMonthlyMaintenance(world, company, DEMO_CONFIG)).toBe(TWO_INDUSTRY_FEE);
    expect(maintenanceBilledUnits(world, company).industry).toBe(2);
    expect(JSON.stringify(world)).toBe(before);
  });
});

describe('v1.7 §一 F1 真实 tick 集成', () => {
  it('真实 Simulation.tick：跨月未成交挂单在财务结算中仍被计费（不再变 0）', () => {
    const sim = Simulation.create();
    const world = sim.state;
    setEquipmentPrices(world);
    // 第 1 月：让世界正常结算一次（建立维护费月度流水）。
    const first = sim.tick();
    expect(first.ok, first.error).toBe(true);
    const company = companyOf(world, 'lp-garment');
    setEquipment(world, company, { farm: 0, industry: 2, energy: 0 });
    listHighPriceOffer(world, company, 2); // equipment 0 + offer 2
    expect(company.equipment.industry).toBe(0);

    // 第 2 月 tick：月初快照必须把未成交挂单算回（equipment 0 + offer 2 = 2 台）。
    const second = sim.tick();
    expect(second.ok, second.error).toBe(true);
    expect(world.lastTick.invariants).toEqual([]);
    expect(company.maintenanceBase?.industry).toBe(2);
    const snapshotPrice = company.maintenancePrices!.industry!;
    const expectedFee = round2(2 * snapshotPrice * DEMO_CONFIG.equipment.maintenanceMonthlyRate);
    expect(expectedFee).toBeGreaterThan(0);
    expect(company.lastMonth.maintenanceDue).toBe(expectedFee);
    expect(company.lastMonth.maintenanceDue).toBeGreaterThan(0); // v1.6 此处为 0
    // 挂单仍在、设备台数没被维护费逻辑改动。
    expect(company.equipment.industry).toBe(0);
    expect(
      world.equipmentMarket.offers
        .filter((offer) => offer.companyId === company.id)
        .reduce((total, offer) => total + offer.units, 0),
    ).toBe(2);
    expect(checkInvariants(world)).toEqual([]);
  });
});
