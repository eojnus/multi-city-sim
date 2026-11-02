import { describe, expect, it } from 'vitest';
import { GameStore } from '../src/app/gameStore';
import { Simulation } from '../src/simulation/core/simulation';
import { renderRightCity } from '../src/ui/panels';
import type { SaveBridge } from '../src/platform/saveBridge';
import type { PlayerNotification } from '../src/simulation/contracts/types';

/**
 * 财政信息可见性回归（补充指令 §7 / DECISIONS v1.1 #9）。
 * 覆盖：市长专属财政字段的渲染、财政命令的命令层校验、通知展示期重过滤。
 * 桌面 Electron 走查见 scripts/smoke-fiscal-ui.cjs。
 */
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

function appointMayor(store: GameStore, cityId: string): void {
  store.world.player.roles.mayorCityId = cityId;
  const state = store.world.politics.cities.find((entry) => entry.cityId === cityId);
  if (state) state.leader = null;
}

function cityNotification(cityId: string): PlayerNotification {
  return {
    id: 'n-test-city',
    tick: 0,
    audience: 'city',
    kind: 'major',
    priority: 'important',
    cityId,
    title: '测试城市通知',
    body: '仅市长可见',
    read: false,
  };
}

describe('财政信息可见性：非市长看不到市长专属字段', () => {
  it('政府章节：非市长无财政流水，市长有财政流水', () => {
    const store = createStore();
    store.selectCity('lanport');
    store.world.player.roles.mayorCityId = null;
    const citizen = renderRightCity(store, panelState);
    expect(citizen).toContain('data-testid="fiscal-restricted"');
    expect(citizen).not.toContain('data-testid="fiscal-ledger"');
    // 公开信息仍在：政策列表在非市长时不渲染操作入口。
    expect(citizen).not.toContain('data-action="stop-policy"');

    appointMayor(store, 'lanport');
    const mayor = renderRightCity(store, panelState);
    expect(mayor).toContain('data-testid="fiscal-ledger"');
    expect(mayor).not.toContain('data-testid="fiscal-restricted"');
  });

  it('政府章节：A 城市长看 B 城仍按普通玩家权限', () => {
    const store = createStore();
    appointMayor(store, 'lanport');
    store.selectCity('ironvale');
    const other = renderRightCity(store, panelState);
    expect(other).toContain('data-testid="fiscal-restricted"');
    expect(other).not.toContain('data-testid="fiscal-ledger"');

    store.selectCity('lanport');
    const mine = renderRightCity(store, panelState);
    expect(mine).toContain('data-testid="fiscal-ledger"');
  });

  it('交通章节：非市长看不到财政补偿/维护支出金额，投资入口禁用', () => {
    const store = createStore();
    store.selectCity('lanport');
    store.world.player.roles.mayorCityId = null;
    const citizen = renderRightCity(store, panelState);
    expect(citizen).toContain('财政补偿</span><b>—</b>');
    expect(citizen).toContain('维护支出</span><b>—</b>');
    expect(citizen).toContain('仅市长可决定市政投资');
    expect(citizen).not.toContain('由岚港 财政出资升级');
  });
});

describe('财政命令：命令层拒绝非市长的政府财政操作', () => {
  it('investTransport：非市长返回 false，且不产生财政支出与政策记录', () => {
    const store = createStore();
    store.selectCity('lanport');
    store.world.player.roles.mayorCityId = null;
    const city = store.world.cities.find((entry) => entry.id === 'lanport')!;
    const treasuryBefore = city.treasury;
    const policiesBefore = store.world.policies.active.length;
    const link = store.world.transport.links.find((entry) => entry.fromCityId === 'lanport' || entry.toCityId === 'lanport');
    const target = link ? link.id : 'intracity:road';
    expect(store.investTransport(target)).toBe(false);
    expect(city.treasury).toBe(treasuryBefore);
    expect(store.world.policies.active.length).toBe(policiesBefore);
  });

  it('stopPolicy：非市长返回 false，政策状态不变', () => {
    const store = createStore();
    store.selectCity('lanport');
    store.world.player.roles.mayorCityId = null;
    const activeBefore = JSON.stringify(store.world.policies.active);
    expect(store.stopPolicy('hiringSubsidy')).toBe(false);
    expect(JSON.stringify(store.world.policies.active)).toBe(activeBefore);
  });

  it('foundCompany：非市长不能以市政府名义出资创办企业', () => {
    const store = createStore();
    store.selectCity('lanport');
    store.world.player.roles.mayorCityId = null;
    const before = store.world.companies.length;
    const city = store.world.cities.find((entry) => entry.id === 'lanport')!;
    const treasuryBefore = city.treasury;
    expect(store.foundCompany('government')).toBe(false);
    expect(store.world.companies.length).toBe(before);
    expect(city.treasury).toBe(treasuryBefore);
  });
});

describe('通知展示期重过滤：城市通知只在担任该市市长期间可见', () => {
  it('市长在任时可见，离职后同一通知不再出现在列表', () => {
    const store = createStore();
    appointMayor(store, 'lanport');
    store.world.notifications.push(cityNotification('lanport'));
    expect(store.notifications.some((notice) => notice.id === 'n-test-city')).toBe(true);

    store.world.player.roles.mayorCityId = null;
    expect(store.notifications.some((notice) => notice.id === 'n-test-city')).toBe(false);
  });

  it('担任 A 城市长时看不到 B 城的旧城市通知', () => {
    const store = createStore();
    appointMayor(store, 'lanport');
    store.world.notifications.push(cityNotification('ironvale'));
    expect(store.notifications.some((notice) => notice.id === 'n-test-city')).toBe(false);
  });

  it('个人与企业通知不受市长身份影响', () => {
    const store = createStore();
    store.world.player.roles.mayorCityId = null;
    store.world.notifications.push({
      ...cityNotification('lanport'),
      id: 'n-test-personal',
      audience: 'personal',
    });
    expect(store.notifications.some((notice) => notice.id === 'n-test-personal')).toBe(true);
  });
});
