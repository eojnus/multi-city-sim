import { describe, expect, it } from 'vitest';
import { GameStore } from '../src/app/gameStore';
import { Simulation } from '../src/simulation/core/simulation';
import { renderLeftRegion, renderRightCity, renderRightRegion } from '../src/ui/panels';
import { POLICY_DEFINITIONS } from '../src/simulation/policies/definitions';
import type { SaveBridge } from '../src/platform/saveBridge';

/** 桌面环境不可用时的无 DOM 面板回归：只验证渲染出的 HTML 包含必需入口。 */
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

const panelState = { showAllGoods: false, logCollapsed: false } as never;

describe('控制台面板：政府、政策、交通与企业生命周期入口', () => {
  it('城市面板包含政府与交通 section，玩家市长时 15 项政策全部可操作', () => {
    const store = createStore();
    store.setMayorDemo('lanport');
    const city = store.world.cities.find((entry) => entry.id === 'lanport')!;
    const html = renderRightCity(store, panelState);
    expect(html).toContain('data-testid="government-section"');
    expect(html).toContain('data-testid="transport-section"');
    for (const definition of POLICY_DEFINITIONS) {
      expect(html).toContain(`data-policy-id="${definition.id}"`);
    }
    expect(html).not.toContain('data-action="run-for-mayor"');
    expect(html).toContain('data-action="invest-transport"');
    expect(html).toContain('data-testid="intracity-road"');
    expect(html).toContain(`data-testid="transport-link-`);
    expect(html).toContain(city.name);
    expect(html).not.toContain('系统未实现');
    // 玩家可以分配政策预算：13 项需要预算的政策各有一个输入；税收与交通不按预算。
    const budgetInputs = html.match(/data-policy-budget="/g) ?? [];
    expect(budgetInputs.length).toBe(13);
    expect(html).toContain('data-testid="policy-budget-hiringSubsidy"');
    expect(html).toContain('data-default-budget="700000"');
    expect(html).not.toContain('data-policy-budget="taxAdjustment"');
    expect(html).not.toContain('data-policy-budget="transportInvestment"');
  });

  it('非玩家市长时政策按钮不可直接执行，并显示 AI 选择原因', () => {
    const store = createStore();
    store.world.player.roles.mayorCityId = null;
    const html = renderRightCity(store, panelState);
    expect(html).toContain('data-testid="government-section"');
    expect(html).toContain('data-action="run-for-mayor"');
    expect(html).toContain('由政府自主施政');
  });

  it('区域面板包含企业创办入口与生命周期记录区域', () => {
    const store = createStore();
    const left = renderLeftRegion(store);
    expect(left).toContain('data-action="enter-city"');
    const html = renderRightRegion(store, panelState);
    expect(html).toContain('data-testid="company-row-lp-food"');
    expect(html).toContain('data-testid="company-lifecycle"');
    expect(html).toContain('data-action="found-company"');
    expect(store.lifecycleView('lanport').limits.maxCompanies).toBeGreaterThan(0);
  });

  it('企业详情包含经营风格、最近决策、扩产入口与生命周期状态', () => {
    const store = createStore();
    store.selectCity('lanport');
    store.selectCompany('lp-food');
    const html = renderRightRegion(store, { showAllGoods: false, focusCompanyId: 'lp-food' } as never);
    expect(html).toContain('data-testid="company-ai"');
    expect(html).toContain('data-action="expand-capacity"');
    const view = store.companyAiView('lp-food')!;
    expect(view.styleLabel.length).toBeGreaterThan(0);
    expect(view.decision.length).toBeGreaterThan(0);
  });
});
