import { describe, expect, it } from 'vitest';
import { GameStore } from '../src/app/gameStore';
import { Simulation } from '../src/simulation/core/simulation';
import { DEMO_CONFIG } from '../src/data/config';
import { listUsedEquipment, recomputeCompanyCapacity } from '../src/simulation/equipment/equipment';
import { renderCompanyDetail, renderRightCity } from '../src/ui/panels';
import type { SaveBridge } from '../src/platform/saveBridge';

/** 无 DOM 的 UI 回归：渲染字符串 + GameStore 真实命令（不 mock 模拟层）。 */
function createStore(): GameStore {
  const bridge: SaveBridge = {
    list: async () => ({ ok: true, slots: [] }),
    read: async (slot: string) => ({ ok: false, slot, error: '存档不存在', code: 'not-found' }),
    write: async (slot: string) => ({ ok: true, slot, savedAt: new Date().toISOString() }),
    remove: async () => ({ ok: true }),
    onMenuAction: () => () => undefined,
  } as unknown as SaveBridge;
  return new GameStore(Simulation.create(), bridge);
}

/** 把企业控制权改成玩家经营（等价于玩家在选任中当选；测试用最小状态）。 */
function makePlayerOperator(store: GameStore, companyId: string): void {
  const control = store.world.governance.controls.find((entry) => entry.companyId === companyId);
  if (!control) throw new Error(`找不到企业控制权：${companyId}`);
  control.operator = { type: 'player', id: 'player' };
  control.operatorId = null;
  control.basis = 'election';
  control.sinceTick = store.world.time.tick;
  control.termEndTick = store.world.time.tick + DEMO_CONFIG.management.termMonths;
}

const panelState = { showAllGoods: false, logCollapsed: false } as never;

describe('v0.9 企业设备/产能/计划面板', () => {
  it('非经营者只读：展示设备与计划，不出现交易表单', () => {
    const store = createStore();
    const company = store.world.companies.find((entry) => entry.id === 'lp-food')!;
    const html = renderCompanyDetail(store, company);
    expect(html).toContain('data-testid="company-equipment"');
    expect(html).toContain('data-testid="equipment-readonly"');
    expect(html).toContain('设备产能');
    expect(html).toContain('劳动产能');
    expect(html).toContain('暂无计划');
    expect(html).toContain('data-testid="equipment-used-empty"');
    expect(html).not.toContain('data-action="buy-equipment"');
    expect(html).not.toContain('data-action="sell-used-equipment"');
    expect(html).not.toContain('data-testid="equipment-buy-form"');
  });

  it('玩家经营：出现购买/出售表单与本城二手市场', () => {
    const store = createStore();
    makePlayerOperator(store, 'lp-food');
    const company = store.world.companies.find((entry) => entry.id === 'lp-food')!;
    const html = renderCompanyDetail(store, company);
    expect(html).toContain('data-testid="equipment-buy-form"');
    expect(html).toContain('data-testid="equipment-sell-form"');
    expect(html).toContain('data-action="buy-equipment"');
    expect(html).toContain('data-action="sell-used-equipment"');
    expect(html).toContain('data-equipment-kind="new"');
    expect(html).toContain('data-equipment-kind="sell"');
    expect(html).toContain(`data-testid="buy-equipment-${company.id}"`);
    expect(html).toContain('data-testid="equipment-used-market"');
    expect(html).not.toContain('data-testid="equipment-readonly"');
  });

  it('购买新设备：真实扣款、增加设备与产能，政府储备付款进入本城财政', () => {
    const store = createStore();
    makePlayerOperator(store, 'lp-food');
    const company = store.world.companies.find((entry) => entry.id === 'lp-food')!;
    const city = store.world.cities.find((entry) => entry.id === company.cityId)!;
    const beforeCash = company.cash;
    const beforeUnits = company.equipment.industry;
    const beforeTreasury = city.treasury;
    const beforeStock = store.world.equipmentMarket.initialStock.industry;

    const ok = store.buyEquipment('lp-food', 'industry', 1);

    expect(ok).toBe(true);
    expect(company.equipment.industry).toBe(beforeUnits + 1);
    expect(company.cash).toBeLessThan(beforeCash);
    expect(city.treasury).toBeGreaterThan(beforeTreasury);
    expect(store.world.equipmentMarket.initialStock.industry).toBe(beforeStock - 1);
    expect(company.lastMonth.equipmentPurchased ?? 0).toBeGreaterThan(0);
  });

  it('无经营权或非法数量：命令被拒绝，账本不变并给出提示', () => {
    const store = createStore();
    const company = store.world.companies.find((entry) => entry.id === 'lp-food')!;
    const beforeCash = company.cash;
    const beforeUnits = company.equipment.industry;

    expect(store.buyEquipment('lp-food', 'industry', 1)).toBe(false);
    expect(company.cash).toBe(beforeCash);
    expect(company.equipment.industry).toBe(beforeUnits);
    expect(store.toasts.at(-1)?.message ?? '').toContain('经营');

    makePlayerOperator(store, 'lp-food');
    expect(store.buyEquipment('lp-food', 'industry', 0)).toBe(false);
    expect(store.buyEquipment('lp-food', 'industry', 1.5)).toBe(false);
    expect(store.toasts.at(-1)?.message ?? '').toContain('正整数');
  });

  it('二手设备：挂出扣减设备、撤单返还，买入方真实付款并转移所有权', () => {
    const store = createStore();
    makePlayerOperator(store, 'lp-food');
    const buyer = store.world.companies.find((entry) => entry.id === 'lp-food')!;
    const seller = store.world.companies.find((entry) => entry.id === 'lp-garment')!;
    expect(seller.cityId).toBe(buyer.cityId);
    seller.equipment.industry = Math.max(1, seller.equipment.industry);
    recomputeCompanyCapacity(store.world, seller, DEMO_CONFIG);

    // 企业自己挂单：立刻扣设备；撤单后返还。
    expect(store.sellUsedEquipment('lp-food', 'industry', 1)).toBe(true);
    const ownOffer = store.equipmentMarketView(buyer.cityId)!.offers.find(
      (offer) => offer.companyId === buyer.id,
    );
    expect(ownOffer).toBeTruthy();
    const afterList = buyer.equipment.industry;
    const htmlWithOffer = renderCompanyDetail(store, buyer);
    expect(htmlWithOffer).toContain(`data-testid="used-offer-${ownOffer!.id}"`);
    expect(htmlWithOffer).toContain('data-action="cancel-used-equipment"');
    expect(store.cancelUsedEquipment('lp-food', ownOffer!.id)).toBe(true);
    expect(buyer.equipment.industry).toBeGreaterThan(afterList);
    expect(
      store.equipmentMarketView(buyer.cityId)!.offers.some((offer) => offer.id === ownOffer!.id),
    ).toBe(false);

    // 其他企业的委托：买方付款，卖方收款，设备转移。
    seller.equipment.industry = Math.max(1, seller.equipment.industry);
    recomputeCompanyCapacity(store.world, seller, DEMO_CONFIG);
    const listing = listUsedEquipment(
      store.world,
      seller,
      'industry',
      1,
      DEMO_CONFIG,
      store.world.time.tick,
    );
    expect(listing.ok).toBe(true);
    expect(listing.offerId).toBeTruthy();
    const sellerCash = seller.cash;
    const buyerCash = buyer.cash;
    const buyerUnits = buyer.equipment.industry;

    expect(store.buyUsedEquipment('lp-food', listing.offerId!, 1)).toBe(true);
    expect(buyer.equipment.industry).toBe(buyerUnits + 1);
    expect(buyer.cash).toBeLessThan(buyerCash);
    expect(seller.cash).toBeGreaterThan(sellerCash);
    expect(store.equipmentMarketView(buyer.cityId)!.offers.some((offer) => offer.id === listing.offerId)).toBe(false);
  });

  it('生产计划：推进一个月后展示计划产量、上限与原因', () => {
    const store = createStore();
    makePlayerOperator(store, 'lp-food');
    store.tick();
    const company = store.world.companies.find((entry) => entry.id === 'lp-food')!;
    expect(company.productionPlan).not.toBeNull();
    const html = renderCompanyDetail(store, company);
    expect(html).toContain('data-testid="equipment-plan"');
    expect(html).toContain('计划产量');
    expect(html).toContain('设备上限');
    expect(html).toContain('销售参考');
    expect(html).not.toContain('data-testid="equipment-plan-empty"');
  });
});

describe('v0.9 居民需求 vs 成交面板', () => {
  it('人口标签展示就业结构、需求总额/实际成交/资金缺口，且汇总与群体一致', () => {
    const store = createStore();
    const view = store.populationStrataView('lanport')!;
    const html = renderRightCity(store, panelState);

    expect(html).toContain('data-testid="population-strata-section"');
    expect(html).toContain('data-testid="population-structure"');
    expect(html).toContain('data-testid="population-demand-vs-trade"');
    expect(html).toContain('需求总额');
    expect(html).toContain('实际成交');
    expect(html).toContain('资金缺口');
    expect(html).toContain('消费预算');
    expect(html).toContain('消费贷支持');
    expect(html).toContain('存款提取');
    // 需求/成交/缺口 与群体行汇总一致（一个是视图口径，一个是渲染口径）。
    const desired = view.groups.reduce((total, group) => total + group.desiredConsumption, 0);
    const actual = view.groups.reduce((total, group) => total + group.consumption, 0);
    const unmet = view.groups.reduce((total, group) => total + group.unmetFunding, 0);
    expect(view.demand.desiredConsumption).toBeCloseTo(desired, 6);
    expect(view.demand.consumption).toBeCloseTo(actual, 6);
    expect(view.demand.unmetFunding).toBeCloseTo(unmet, 6);
    expect(view.demand.consumption).toBeLessThanOrEqual(view.demand.desiredConsumption + 1e-6);
  });
});
