import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation/core/simulation';
import {
  agreementsForCompany,
  applyAutoDecisions,
  cancelAgreement,
  decideParticipant,
  executeAgreements,
  proposeAgreement,
} from '../src/simulation/agreements/agreements';
import { DEMO_CONFIG } from '../src/data/config';
import { createWorldLedgers } from '../src/simulation/markets/markets';
import { settleTransportMonth } from '../src/simulation/transport/settlement';
import { GOOD_IDS } from '../src/simulation/companies/company';
import { round2 } from '../src/simulation/core/math';
import type { Company, TradeAgreement, WorldState } from '../src/simulation/contracts/types';

const GRAIN_PRICE = 100;

interface CompanySnapshot {
  cash: number;
  inventory: Record<string, number>;
  revenue: number;
  inputCost: number;
}

/**
 * 把初始世界简化成唯一可撮合链路：青原谷物合作社（卖方）→ 岚港食品厂（买方，投入 grain）。
 * 其余企业库存清零，保证协议只包含一条 grain 条目，便于精确断言。
 */
function setupWorld(): { world: WorldState; seller: Company; buyer: Company } {
  const world = Simulation.create().state;
  for (const company of world.companies) {
    company.cash = 200_000;
    // v1.0 开局新增多家食品厂，会把产能转成 grain 需求；先清零产能，仅保留 lp-food 参与撮合。
    company.capacity = 0;
    for (const goodId of GOOD_IDS) company.inventory[goodId] = 0;
    company.lastMonth.revenue = 0;
    company.lastMonth.inputCost = 0;
    company.lastMonth.sold = 0;
    company.lastMonth.exported = 0;
  }

  const seller = world.companies.find((company) => company.id === 'gf-grain');
  const buyer = world.companies.find((company) => company.id === 'lp-food');
  if (!seller || !buyer) throw new Error('测试初始数据缺少预期企业');

  seller.inventory.grain = 10_000;
  seller.cash = 100_000;
  buyer.capacity = 1_000;
  buyer.utilization = 1;
  buyer.inventory.grain = 0;
  buyer.cash = 1_000_000;

  const lanport = world.cities.find((city) => city.id === 'lanport');
  const greenfield = world.cities.find((city) => city.id === 'greenfield');
  if (!lanport || !greenfield) throw new Error('测试初始数据缺少预期城市');
  lanport.market.grain.price = GRAIN_PRICE;
  greenfield.market.grain.price = GRAIN_PRICE;

  return { world, seller, buyer };
}

function snapshot(world: WorldState): Record<string, CompanySnapshot> {
  const result: Record<string, CompanySnapshot> = {};
  for (const company of [...world.companies].sort((a, b) => a.id.localeCompare(b.id))) {
    result[company.id] = {
      cash: company.cash,
      inventory: { ...company.inventory },
      revenue: company.lastMonth.revenue,
      inputCost: company.lastMonth.inputCost,
    };
  }
  return result;
}

function proposeDemoAgreement(world: WorldState): TradeAgreement {
  const result = proposeAgreement(world, 'lanport', 'greenfield', DEMO_CONFIG, 1, 'demo');
  expect(result.ok).toBe(true);
  const agreement = result.agreement;
  if (!agreement) throw new Error('提议未返回协议');
  return agreement;
}

function acceptAll(world: WorldState, agreement: TradeAgreement, tick: number): void {
  for (const participant of agreement.participants) {
    const result = decideParticipant(
      world,
      agreement.id,
      participant.companyId,
      true,
      tick,
      DEMO_CONFIG,
      [],
    );
    expect(result.ok).toBe(true);
  }
}

describe('政府牵头的跨城贸易协议（暂定演示规则）', () => {
  it('提议协议不会改变任何企业的资金与库存', () => {
    const { world, seller, buyer } = setupWorld();
    const before = snapshot(world);
    const pricesBefore = world.cities.map((city) => ({
      id: city.id,
      grain: city.market.grain.price,
    }));

    const agreement = proposeDemoAgreement(world);

    expect(agreement.status).toBe('proposed');
    expect(agreement.createdBy).toBe('demo');
    expect(agreement.sponsorCityId).toBe('lanport');
    expect(agreement.partnerCityId).toBe('greenfield');
    expect(agreement.items).toHaveLength(1);

    const item = agreement.items[0]!;
    expect(item.good).toBe('grain');
    // 需求 = 1000 × 1 × 0.62 − 0 = 620；低于卖方库存份额与买方购买力，因此取 620。
    expect(item.qtyPerMonth).toBe(620);
    expect(item.months).toBe(DEMO_CONFIG.agreements.months);
    expect(item.status).toBe('pending');
    // 价格 = 买方城市市价 ×（1 + 运输加成）> 市价，但不超出买方接受上限。
    expect(item.unitPrice).toBeGreaterThan(GRAIN_PRICE);
    expect(item.unitPrice).toBeLessThanOrEqual(
      round2(GRAIN_PRICE * DEMO_CONFIG.agreements.buyerMaxPriceFactor),
    );

    // 参与者去重并按 id 排序。
    expect(agreement.participants.map((participant) => participant.companyId)).toEqual([
      seller.id,
      buyer.id,
    ]);
    expect(agreement.participants.every((participant) => participant.decision === 'pending')).toBe(
      true,
    );

    expect(snapshot(world)).toEqual(before);
    expect(
      world.cities.map((city) => ({ id: city.id, grain: city.market.grain.price })),
    ).toEqual(pricesBefore);
    expect(agreementsForCompany(world, seller.id)).toHaveLength(1);
    expect(agreementsForCompany(world, buyer.id)).toHaveLength(1);
    expect(agreementsForCompany(world, 'iv-metal')).toHaveLength(0);
  });

  it('拒绝参加不产生义务，也不改变资金与库存', () => {
    const { world, seller } = setupWorld();
    const agreement = proposeDemoAgreement(world);
    const before = snapshot(world);

    const result = decideParticipant(world, agreement.id, seller.id, false, 2, DEMO_CONFIG, []);
    expect(result.ok).toBe(true);

    const participant = agreement.participants.find((entry) => entry.companyId === seller.id);
    expect(participant?.decision).toBe('declined');
    expect(participant?.decidedTick).toBe(2);
    expect(agreement.items.every((item) => item.status === 'declined')).toBe(true);

    // 其余参与方自动决策后，没有双方都接受的条目，协议取消。
    applyAutoDecisions(world, agreement.id, DEMO_CONFIG, 2, []);
    expect(agreement.status).toBe('cancelled');

    expect(snapshot(world)).toEqual(before);
    expect(executeAgreements(world, DEMO_CONFIG, 2, [])).toHaveLength(0);
    expect(snapshot(world)).toEqual(before);
  });

  it('接受后按条目原子履约：货物与资金同时转移且现金守恒', () => {
    const { world, seller, buyer } = setupWorld();
    const agreement = proposeDemoAgreement(world);
    acceptAll(world, agreement, 2);

    expect(agreement.status).toBe('active');
    const item = agreement.items[0]!;
    expect(item.status).toBe('active');
    const qty = item.qtyPerMonth;
    expect(qty).toBe(620);

    const buyerCashBefore = buyer.cash;
    const sellerCashBefore = seller.cash;
    const sellerStockBefore = seller.inventory.grain;
    const buyerStockBefore = buyer.inventory.grain;
    const totalCashBefore = round2(buyerCashBefore + sellerCashBefore);

    const flows = executeAgreements(world, DEMO_CONFIG, 2, []);
    // 卖方所得在期末按运输容量统一入账（演示流程）；本场景需求低于容量。
    settleTransportMonth(world, DEMO_CONFIG, [], createWorldLedgers(world));

    expect(flows).toHaveLength(1);
    const flow = flows[0]!;
    expect(flow.routeId).toBe(`agreement:${agreement.id}`);
    expect(flow.fromCityId).toBe('greenfield');
    expect(flow.toCityId).toBe('lanport');
    expect(flow.fromCompanyId).toBe(seller.id);
    expect(flow.toCompanyId).toBe(buyer.id);
    expect(flow.good).toBe('grain');
    expect(flow.qty).toBe(qty);
    expect(flow.unitPrice).toBe(item.unitPrice);
    expect(flow.value).toBe(round2(qty * item.unitPrice));

    // 买方现金减少额严格等于卖方现金增加额。
    expect(flow.value).toBe(item.paidValue);
    expect(buyer.cash).toBe(round2(buyerCashBefore - flow.value));
    expect(seller.cash).toBe(round2(sellerCashBefore + flow.value));
    expect(round2(buyer.cash + seller.cash)).toBe(totalCashBefore);

    expect(seller.inventory.grain).toBe(round2(sellerStockBefore - qty));
    expect(buyer.inventory.grain).toBe(round2(buyerStockBefore + qty));
    expect(item.deliveredQty).toBe(qty);
    expect(item.monthsExecuted).toBe(1);
    expect(item.status).toBe('active');

    expect(buyer.lastMonth.inputCost).toBe(flow.value);
    expect(seller.lastMonth.revenue).toBe(flow.value);
    expect(buyer.cash).toBeGreaterThanOrEqual(0);
    expect(seller.inventory.grain).toBeGreaterThanOrEqual(0);
  });

  it('库存不足时该条目失败，双方现金与库存完全不变', () => {
    const { world, seller } = setupWorld();
    const agreement = proposeDemoAgreement(world);
    acceptAll(world, agreement, 2);

    // 履约前把卖方库存清空，模拟库存不足。
    seller.inventory.grain = 0;
    const before = snapshot(world);

    const flows = executeAgreements(world, DEMO_CONFIG, 2, []);

    expect(flows).toHaveLength(0);
    const item = agreement.items[0]!;
    expect(item.status).toBe('failed');
    expect(item.lastNote).toContain('库存不足');
    expect(item.deliveredQty).toBe(0);
    expect(item.paidValue).toBe(0);
    expect(item.monthsExecuted).toBe(0);
    expect(snapshot(world)).toEqual(before);
    // 所有条目结束（含失败）后协议收尾为 completed。
    expect(agreement.status).toBe('completed');
    expect(agreement.note).toContain('部分履约失败');
  });

  it('取消协议不改变资金与库存', () => {
    const { world } = setupWorld();
    const agreement = proposeDemoAgreement(world);
    const before = snapshot(world);

    const result = cancelAgreement(world, agreement.id, 2, '演示取消');

    expect(result.ok).toBe(true);
    expect(agreement.status).toBe('cancelled');
    expect(agreement.items.every((item) => item.status === 'failed')).toBe(true);
    expect(agreement.items[0]?.lastNote).toContain('协议取消');
    expect(snapshot(world)).toEqual(before);
    expect(executeAgreements(world, DEMO_CONFIG, 2, [])).toHaveLength(0);
    expect(snapshot(world)).toEqual(before);
  });
});
