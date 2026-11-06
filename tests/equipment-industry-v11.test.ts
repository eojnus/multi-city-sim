// v1.1 §7：设备产业复核（基于 v1.0 设备单位经济标定）。
// 覆盖：设备厂真实生产→真实买方→买方产能增加且资金流可追溯；资本品机会在创业评估可见、
// 需求/意向/成交分离；撤单后产能恢复；购买失败不发补贴；跨城真实库存/资金/运输；
// 旧 v0.9 存档读取→推进→再存读档稳定。
import { describe, expect, it } from 'vitest';
import { DEMO_CONFIG } from '../src/data/config';
import type { Company, GoodId, WorldState } from '../src/simulation/contracts/types';
import { Simulation } from '../src/simulation/core/simulation';
import { checkInvariants } from '../src/simulation/core/invariants';
import { parseSave, serializeSave } from '../src/simulation/core/save';
import { SAVE_FORMAT_VERSION } from '../src/simulation/contracts/types';
import {
  buyNewEquipment,
  cancelUsedEquipmentOffer,
  equipmentCapacityPerUnit,
  listUsedEquipment,
  newEquipmentSupply,
  syncMarketClosingStock,
} from '../src/simulation/equipment/equipment';
import { createWorldLedgers } from '../src/simulation/markets/markets';
import { expandCompanyCapacity } from '../src/simulation/companies/lifecycle/lifecycle';
import {
  foundingCandidateForOutput,
  plannedEquipmentUnits,
  scoreFoundingCandidates,
} from '../src/simulation/companies/founding';
import { activePolicy } from '../src/simulation/policies/query';
import { startPolicy } from '../src/simulation/policies/policies';
import { settleTransportMonth } from '../src/simulation/transport/settlement';
import { cityById, newWorld } from './acceptance/helpers';

const CONFIG = DEMO_CONFIG;
const LANPORT = 'lanport';
const IRONVALE = 'ironvale';

function companyById(world: WorldState, id: string): Company {
  const company = world.companies.find((entry) => entry.id === id);
  if (!company) throw new Error(`缺少企业：${id}`);
  return company;
}

function equipmentProducer(world: WorldState, cityId: string, output: string): Company {
  const company = world.companies.find(
    (entry) => entry.cityId === cityId && entry.recipeOutput === output,
  );
  if (!company) throw new Error(`缺少设备生产企业：${cityId}/${output}`);
  return company;
}

/** 清零设备供给（可按城市过滤）；同步市场期末库存，保持“市场库存=企业库存合计”不变量。 */
function zeroEquipmentSupply(
  world: WorldState,
  goodId: GoodId,
  kind: 'farm' | 'industry' | 'energy',
  cityIds?: string[],
) {
  const targets = cityIds ? new Set(cityIds) : null;
  for (const company of world.companies) {
    if (company.recipeOutput !== goodId) continue;
    if (targets && !targets.has(company.cityId)) continue;
    const removed = company.inventory[goodId] ?? 0;
    if (removed > 0) syncMarketClosingStock(world, company.cityId, goodId, -removed);
    company.inventory[goodId] = 0;
  }
  world.equipmentMarket.initialStock[kind] = 0;
}

function cityOf(world: WorldState, cityId: string) {
  return cityById(world, cityId);
}

describe('§7 设备厂真实生产 → 真实买方 → 产能增加', () => {
  it('生产后由同城企业真实购买：资金/库存/设备/产能全部可追溯，账本需求与成交同步', () => {
    const sim = Simulation.create();
    const world = sim.state;
    const tickResult = sim.tick();
    expect(tickResult.ok, tickResult.error).toBe(true);
    const producer = equipmentProducer(world, LANPORT, 'industryEquipment');
    expect(producer.lastMonth.produced).toBeGreaterThan(0);
    const buyer = companyById(world, 'lp-food2');
    const inventoryBefore = producer.inventory.industryEquipment;
    expect(inventoryBefore).toBeGreaterThanOrEqual(1);

    const sellerCashBefore = producer.cash;
    const buyerCashBefore = buyer.cash;
    const capacityBefore = buyer.capacity;
    const unitsBefore = buyer.equipment.industry;
    const tech = cityOf(world, LANPORT).technology.productivityMultiplier;

    const purchase = buyNewEquipment(world, buyer, 'industry', 1, CONFIG, world.time.tick, {
      allowGovernmentStock: false,
      allowIntercity: false,
      reason: '§7 设备产业复核',
    });
    expect(purchase.ok, purchase.error).toBe(true);
    expect(purchase.units).toBe(1);
    expect(purchase.fromCompanies).toBe(1);
    expect(purchase.fromGovernment).toBe(0);
    expect(purchase.fromIntercity).toBe(0);

    expect(producer.inventory.industryEquipment).toBeCloseTo(inventoryBefore - 1, 2);
    expect(producer.cash).toBeCloseTo(sellerCashBefore + purchase.cost, 2);
    expect(buyer.cash).toBeCloseTo(buyerCashBefore - purchase.cost, 2);
    expect(buyer.equipment.industry).toBe(unitsBefore + 1);
    expect(buyer.capacity).toBeCloseTo(
      capacityBefore + equipmentCapacityPerUnit(CONFIG, 'industry', buyer.recipeOutput) * tech,
      2,
    );
    expect(buyer.equipmentCapacity).toBeCloseTo(buyer.capacity, 2);

    // 设备市场账本：需求与成交在 createWorldLedgers 合并后可见（设备商品不是居民消费品）。
    const ledgers = createWorldLedgers(world);
    const ledger = ledgers[LANPORT]!.industryEquipment!;
    expect(ledger.demand).toBeGreaterThanOrEqual(1);
    expect(ledger.sold).toBeGreaterThanOrEqual(1);
    expect(ledger.sold).toBeLessThanOrEqual(ledger.supply + 0.01);
    expect(checkInvariants(world)).toEqual([]);
  });
});

describe('§7 资本品机会在创业评估可见，需求/意向/成交分离', () => {
  it('三类设备商品都有可评估的创业机会，且评估来源与实际采购同源', () => {
    const world = newWorld(0);
    const candidates = scoreFoundingCandidates(world, CONFIG, LANPORT);
    for (const output of ['farmEquipment', 'industryEquipment', 'energyEquipment'] as const) {
      const candidate = foundingCandidateForOutput(world, CONFIG, LANPORT, output);
      // 设备商品企业归入 equipment 行业（行业映射到工业设备），即设备厂自身用工业设备生产；
      // 其产能口径按产出是否为资本品选择 outputCapacityPerUnit。
      expect(candidate.equipmentKind).toBe('industry');
      expect(candidate.availableEquipmentUnits).toBe(
        newEquipmentSupply(world, LANPORT, candidate.equipmentKind, CONFIG).total,
      );
      expect(candidate.availableEquipmentUnits).toBeGreaterThan(0);
      expect(candidate.unitCapacity).toBeCloseTo(
        equipmentCapacityPerUnit(CONFIG, candidate.equipmentKind, output) *
          cityOf(world, LANPORT).technology.productivityMultiplier,
        2,
      );
      expect(candidate.demandUnits).toBeGreaterThanOrEqual(1);
      expect(candidates.some((entry) => entry.output === output)).toBe(true);
      // 计划台数 = min(需求意向, 资金可负担, 可购供给, 单月上限)，不虚构超出供给的成交。
      const planned = plannedEquipmentUnits(candidate, candidate.suggestedCapital * 4, CONFIG);
      expect(planned).toBeLessThanOrEqual(candidate.demandUnits);
      expect(planned).toBeLessThanOrEqual(candidate.availableEquipmentUnits);
      expect(planned).toBeLessThanOrEqual(CONFIG.equipment.maxBuyUnitsPerMonth);
    }
  });

  it('供给为零时机会仍可见但意向无法成交，且不产生资金/设备副作用', () => {
    const world = newWorld(0);
    zeroEquipmentSupply(world, 'industryEquipment', 'industry');
    const candidate = foundingCandidateForOutput(world, CONFIG, LANPORT, 'industryEquipment');
    expect(candidate.availableEquipmentUnits).toBe(0);
    expect(candidate.demandUnits).toBeGreaterThanOrEqual(1);
    expect(plannedEquipmentUnits(candidate, candidate.suggestedCapital * 4, CONFIG)).toBe(0);

    const buyer = companyById(world, 'lp-food2');
    const cashBefore = buyer.cash;
    const unitsBefore = buyer.equipment.industry;
    const result = buyNewEquipment(world, buyer, 'industry', 1, CONFIG, 0, {
      allowGovernmentStock: true,
      allowIntercity: true,
    });
    expect(result.ok).toBe(false);
    expect(buyer.cash).toBe(cashBefore);
    expect(buyer.equipment.industry).toBe(unitsBefore);
  });
});

describe('§7 撤单后设备与产能一致', () => {
  it('挂单扣减产能，撤单归还设备并重算产能', () => {
    const world = newWorld(0);
    const seller = companyById(world, 'lp-food2');
    const capacityBefore = seller.capacity;
    const listed = listUsedEquipment(world, seller, 'industry', 1, CONFIG, 0);
    expect(listed.ok, listed.error).toBe(true);
    expect(seller.capacity).toBeLessThan(capacityBefore);

    const canceled = cancelUsedEquipmentOffer(world, seller.id, listed.offerId!, CONFIG);
    expect(canceled.ok, canceled.error).toBe(true);
    expect(seller.capacity).toBeCloseTo(capacityBefore, 2);
    expect(seller.equipmentCapacity).toBeCloseTo(capacityBefore, 2);
    expect(world.equipmentMarket.offers).toHaveLength(0);
    expect(checkInvariants(world)).toEqual([]);
  });
});

describe('§7 购买失败不发补贴', () => {
  it('政策生效但无设备供给时扩产失败，财政/企业现金/库存均无副作用', () => {
    const world = newWorld(0);
    const city = cityOf(world, LANPORT);
    const company = companyById(world, 'lp-food2');
    company.cash = 5_000_000;
    zeroEquipmentSupply(world, 'industryEquipment', 'industry');
    expect(startPolicy(world, city.id, 'equipmentSubsidy', CONFIG).ok).toBe(true);
    const policy = activePolicy(world, city.id, 'equipmentSubsidy')!;
    const cashBefore = company.cash;
    const treasuryBefore = city.treasury;
    const stockBefore = world.equipmentMarket.initialStock.industry;
    const spendBefore = policy.spent;

    const result = expandCompanyCapacity(world, company, CONFIG, [], 100);
    expect(result.ok).toBe(false);
    expect(company.cash).toBe(cashBefore);
    expect(city.treasury).toBe(treasuryBefore);
    expect(world.equipmentMarket.initialStock.industry).toBe(stockBefore);
    expect(policy.spent).toBe(spendBefore);
    expect(
      world.fiscal.ledger.filter(
        (entry) => entry.cityId === city.id && entry.kind === 'policySpending',
      ),
    ).toHaveLength(0);
  });
});

describe('§7 跨城真实库存/资金/运输', () => {
  it('本城无货时向其他城市设备企业真实采购，月末按运输模型结算且资金守恒', () => {
    const world = newWorld(0);
    // 只保留铁谷设备企业的真实库存，清空岚港与青原的供给。
    zeroEquipmentSupply(world, 'industryEquipment', 'industry', [LANPORT, 'greenfield']);
    const seller = equipmentProducer(world, IRONVALE, 'industryEquipment');
    const sellerInventoryBefore = seller.inventory.industryEquipment;
    expect(sellerInventoryBefore).toBeGreaterThanOrEqual(1);
    const buyer = companyById(world, 'lp-food2');
    buyer.cash = 5_000_000;
    const supply = newEquipmentSupply(world, LANPORT, 'industry', CONFIG, buyer.id);
    expect(supply.local).toBe(0);
    expect(supply.government).toBe(0);
    expect(supply.intercity).toBeGreaterThanOrEqual(1);

    const sellerCashBefore = seller.cash;
    const buyerCashBefore = buyer.cash;
    const purchase = buyNewEquipment(world, buyer, 'industry', 1, CONFIG, 0, {
      allowGovernmentStock: false,
      allowIntercity: true,
    });
    expect(purchase.ok, purchase.error).toBe(true);
    expect(purchase.fromIntercity).toBe(1);
    expect(seller.inventory.industryEquipment).toBeCloseTo(sellerInventoryBefore - 1, 2);
    expect(world.transport.pendingSales).toHaveLength(1);
    expect(world.lastTick.tradeFlows.some((flow) => flow.path === 'intercityPurchase')).toBe(true);
    expect(checkInvariants(world)).toEqual([]);

    // 成交时买方先全额付款、卖方未收款；月末运输结算后卖方按运力分账、差额退回买方，
    // 买卖双方资金合计应回到成交前的水平（容量惩罚只影响分账，不凭空增减货币）。
    settleTransportMonth(world, CONFIG, [], createWorldLedgers(world));
    expect(world.transport.pendingSales).toHaveLength(0);
    expect(seller.cash + buyer.cash).toBeCloseTo(sellerCashBefore + buyerCashBefore, 2);
    expect(seller.cash).toBeGreaterThan(sellerCashBefore);
    expect(buyer.cash).toBeLessThanOrEqual(buyerCashBefore);
  });
});

describe('§7 旧 v0.9 存档读取/推进/再存读档', () => {
  it('v9 存档读取后同 tick 往返稳定，推进一月不变量仍通过', () => {
    const sim = Simulation.create();
    for (let index = 0; index < 2; index += 1) {
      const result = sim.tick();
      expect(result.ok, result.error).toBe(true);
    }
    const first = parseSave(serializeSave(sim.state));
    expect(first.ok, first.error).toBe(true);
    expect(first.save?.formatVersion).toBe(SAVE_FORMAT_VERSION);
    expect(first.world).toBeTruthy();
    expect(checkInvariants(first.world!)).toEqual([]);

    // 同 tick 再存读档：设备/产能/迁移余量逐字段稳定。
    const second = parseSave(serializeSave(first.world!));
    expect(second.ok, second.error).toBe(true);
    expect(checkInvariants(second.world!)).toEqual([]);
    for (const company of second.world!.companies) {
      const before = first.world!.companies.find((entry) => entry.id === company.id)!;
      expect(company.equipmentCapacityRemainder).toBe(before.equipmentCapacityRemainder);
      expect(company.equipment).toEqual(before.equipment);
      expect(company.equipmentCapacity).toBeCloseTo(before.equipmentCapacity, 2);
      expect(company.equipmentCapacity).toBeCloseTo(company.capacity, 2);
    }

    // 读档后推进一月：设备可能因 AI 扩产/买卖变化，但缓存必须与推导一致且不变量通过。
    const sim2 = new Simulation(second.world!, CONFIG);
    const advanced = sim2.tick();
    expect(advanced.ok, advanced.error).toBe(true);
    expect(checkInvariants(sim2.state)).toEqual([]);
    for (const company of sim2.state.companies) {
      expect(company.equipmentCapacity).toBeCloseTo(company.capacity, 2);
    }
  });
});
