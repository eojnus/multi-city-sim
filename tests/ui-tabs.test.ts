// 右侧栏标签化回归：标签组成、默认标签、上下文切换、切换不调用模拟命令。
// 纯字符串渲染，不需要 jsdom（与 tests/ui-panels.test.ts 同一套 fake bridge）。

import { describe, expect, it, vi } from 'vitest';
import { GameStore } from '../src/app/gameStore';
import { Simulation } from '../src/simulation/core/simulation';
import type { SaveBridge } from '../src/platform/saveBridge';
import { renderRightPanel } from '../src/ui/right-panel';
import {
  BUILDING_TABS,
  CITY_TABS,
  COMPANY_TABS,
  DEFAULT_RIGHT_TAB,
  DISTRICT_TABS,
  resolveRightTab,
  tabsForContext,
} from '../src/ui/right-panel/tabs';

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

const baseState = { tab: DEFAULT_RIGHT_TAB, focusCompanyId: null, showAllGoods: false };

describe('右侧栏标签：定义与状态机', () => {
  it('城市 6 个标签、企业 5 个标签、建筑/街区 2 个标签，默认概况', () => {
    expect(CITY_TABS.map((tab) => tab.id)).toEqual([
      'overview',
      'population',
      'companies',
      'market',
      'government',
      'transport',
    ]);
    expect(COMPANY_TABS.map((tab) => tab.id)).toEqual([
      'overview',
      'operation',
      'finance',
      'governance',
      'stocks',
    ]);
    expect(BUILDING_TABS.map((tab) => tab.id)).toEqual(['overview', 'related']);
    expect(DISTRICT_TABS.map((tab) => tab.id)).toEqual(['overview', 'related']);
    expect(tabsForContext('city')).toBe(CITY_TABS);
    expect(DEFAULT_RIGHT_TAB).toBe('overview');
  });

  it('上下文变化回到概况；上下文不变保留合法标签；非法标签回到概况', () => {
    // 上下文键变化：即使玩家停在其他标签，也回到默认概况。
    expect(resolveRightTab('city', 'transport', 'city:lanport', 'city:lanhai')).toBe('overview');
    // 上下文不变：保留玩家选择。
    expect(resolveRightTab('city', 'transport', 'city:lanport', 'city:lanport')).toBe('transport');
    // 标签不属于当前上下文：回到默认。
    expect(resolveRightTab('company', 'transport', 'company:a:1', 'company:a:1')).toBe('overview');
    expect(resolveRightTab('city', null, 'city:lanport', 'city:lanport')).toBe('overview');
  });
});

describe('右侧栏标签：HTML 渲染', () => {
  it('城市上下文默认渲染「概况」，标签栏具备 ARIA tabs 语义与 6 个标签', () => {
    const store = createStore();
    const html = renderRightPanel(store, { ...baseState, tab: 'overview' });
    expect(html).toContain('data-testid="right-panel"');
    expect(html).toContain('data-context="city"');
    expect(html).toContain('role="tablist"');
    expect(html).toContain('data-testid="right-tabs"');
    for (const tab of CITY_TABS) {
      expect(html).toContain(`role="tab"`);
      expect(html).toContain(`data-tab="${tab.id}"`);
      expect(html).toContain(`data-action="right-tab"`);
    }
    // 只有一个 aria-selected="true"：默认概况。
    expect((html.match(/aria-selected="true"/g) ?? []).length).toBe(1);
    expect(html).toContain('aria-controls="right-tabpanel"');
    expect(html).toContain('id="right-tabpanel"');
    expect(html).toContain('data-testid="right-tabpanel"');
  });

  it('人口标签包含人口阶层与人才市场，市场标签包含银行/债券/协议', () => {
    const store = createStore();
    const cityKey = `city:${store.selectedCity!.id}`;
    const population = renderRightPanel(store, {
      ...baseState,
      tab: 'population',
      previousContextKey: cityKey,
    });
    expect(population).toContain('data-testid="population-strata-section"');
    expect(population).toContain('data-testid="talent-market-section"');
    expect(population).toContain('data-testid="population-pie"');
    expect(population).toContain('data-tab="population"');

    const market = renderRightPanel(store, {
      ...baseState,
      tab: 'market',
      previousContextKey: cityKey,
    });
    expect(market).toContain('data-testid="bank-section"');
    expect(market).toContain('data-testid="bond-market-section"');
    expect(market).toContain('data-testid="agreements-section"');
  });

  it('政府标签保留市长财政/税收权限口径：非市长不渲染金额', () => {
    const store = createStore();
    store.world.player.roles.mayorCityId = null;
    const cityKey = `city:${store.selectedCity!.id}`;
    const html = renderRightPanel(store, {
      ...baseState,
      tab: 'government',
      previousContextKey: cityKey,
    });
    expect(html).toContain('data-testid="government-section"');
    expect(html).toContain('data-testid="fiscal-restricted"');
    expect(html).not.toContain('data-testid="fiscal-ledger"');
    // 非市长不渲染税收金额面板（面板整块只在该城现任市长时出现）。
    expect(html).not.toContain('data-testid="city-tax-panel"');

    // 市长：财政面板与税收面板（基准税/交通系数/加成/损耗/最终入账）都可见。
    const mayorStore = createStore();
    mayorStore.setMayorDemo('lanport');
    const mayorHtml = renderRightPanel(mayorStore, {
      ...baseState,
      tab: 'government',
      previousContextKey: `city:${mayorStore.selectedCity!.id}`,
    });
    expect(mayorHtml).toContain('data-testid="fiscal-ledger"');
    expect(mayorHtml).toContain('data-testid="city-tax-panel"');
    expect(mayorHtml).toContain('基准税');
    expect(mayorHtml).toContain('最终入账');
  });

  it('企业上下文渲染 5 个标签，经营标签含经营者区块，股票标签含大窗口入口', () => {
    const store = createStore();
    const company = store.world.companies[0]!;
    const companyKey = `company:${company.cityId}:${company.id}`;
    const overview = renderRightPanel(store, {
      ...baseState,
      focusCompanyId: company.id,
      tab: 'overview',
      previousContextKey: companyKey,
    });
    expect(overview).toContain('data-context="company"');
    expect(overview).toContain('data-testid="right-tabpanel"');
    for (const tab of COMPANY_TABS) expect(overview).toContain(`data-tab="${tab.id}"`);
    expect(overview).toContain(company.name);

    const operation = renderRightPanel(store, {
      ...baseState,
      focusCompanyId: company.id,
      tab: 'operation',
      previousContextKey: companyKey,
    });
    expect(operation).toContain('data-testid="company-operator"');

    const stocks = renderRightPanel(store, {
      ...baseState,
      focusCompanyId: company.id,
      tab: 'stocks',
      previousContextKey: companyKey,
    });
    expect(stocks).toContain('data-action="open-stock-market"');
    expect(stocks).toContain(`data-testid="open-stock-window-${company.id}"`);
    expect(stocks).toContain('data-testid="company-trading"');

    const finance = renderRightPanel(store, {
      ...baseState,
      focusCompanyId: company.id,
      tab: 'finance',
      previousContextKey: companyKey,
    });
    expect(finance).toContain('class="finance-grid"');

    const governance = renderRightPanel(store, {
      ...baseState,
      focusCompanyId: company.id,
      tab: 'governance',
      previousContextKey: companyKey,
    });
    expect(governance).toContain('data-testid="company-holders"');
    expect(governance).not.toContain('data-testid="company-trading"');
  });

  it('建筑上下文渲染 2 个标签与建筑概况；街区上下文渲染 2 个标签', () => {
    const store = createStore();
    store.enterCity('lanport');
    const layout = store.selectedLayout;
    expect(layout).not.toBeNull();
    const building = layout!.buildings[0]!;
    store.selectBuilding(building.id);
    const buildingHtml = renderRightPanel(store, { ...baseState, tab: 'overview' });
    expect(buildingHtml).toContain('data-context="building"');
    expect(buildingHtml).toContain('data-testid="building-detail"');
    expect(buildingHtml).toContain('data-tab="related"');

    const district = layout!.districts[0]!;
    store.selectDistrict(district.id);
    const districtHtml = renderRightPanel(store, { ...baseState, tab: 'overview' });
    expect(districtHtml).toContain('data-context="district"');
    expect(districtHtml).toContain('data-tab="related"');
    expect(districtHtml).not.toContain('data-tab="population"');
  });

  it('切换标签不调用任何 GameStore 命令，也不推进模拟时间', () => {
    const store = createStore();
    const tick = vi.spyOn(store, 'tick');
    const auto = vi.spyOn(store, 'setAutoRunning');
    const selectCity = vi.spyOn(store, 'selectCity');
    const enterCity = vi.spyOn(store, 'enterCity');
    const before = store.world.time.tick;

    renderRightPanel(store, { ...baseState, tab: 'overview' });
    renderRightPanel(store, { ...baseState, tab: 'population' });
    renderRightPanel(store, { ...baseState, tab: 'market' });
    renderRightPanel(store, { ...baseState, tab: 'government' });
    renderRightPanel(store, { ...baseState, tab: 'transport' });

    expect(tick).not.toHaveBeenCalled();
    expect(auto).not.toHaveBeenCalled();
    expect(selectCity).not.toHaveBeenCalled();
    expect(enterCity).not.toHaveBeenCalled();
    expect(store.world.time.tick).toBe(before);
  });
});
