// 验收 I 组：财政信息权限白名单（AC-I01–I09，含 AC-I07a–g 泄漏回归）。
// 口径来源：DECISIONS v1 #9 / SUPPLEMENT_ARCHITECT_v1 §7；数据层为 fiscal-view.ts，
// 渲染层为 panels.ts。当前块0：canViewMayorFiscal/isVisibleTo/visibleLogEntries/visibleNotifications 已实现（绿），
// buildMayorFiscalView/buildPublicBondOffer/buildOwnBondHoldingViews 仍是空实现（红，归因“实现未落地”），
// 界面泄漏修复属块4（AC-I07a/c/d/e 预期红）。
import { describe, expect, it } from 'vitest';
import { GameStore } from '../../src/app/gameStore';
import { Simulation } from '../../src/simulation/core/simulation';
import type { SaveBridge } from '../../src/platform/saveBridge';
import { renderLeftRegion, renderRightCity } from '../../src/ui/panels';
import {
  buildMayorFiscalView,
  buildOwnBondHoldingViews,
  buildPublicBondOffer,
  canViewMayorFiscal,
  isVisibleTo,
  visibleLogEntries,
  visibleNotifications,
} from '../../src/simulation/government/fiscal-view';
import { appointPlayerMayor, stepDownPlayerMayor } from '../../src/simulation/politics/politics';
import { DEMO_CONFIG } from '../../src/data/config';
import type {
  BondHolding,
  BondIssuance,
  City,
  LogEntry,
  PlayerNotification,
  WorldState,
} from '../../src/simulation/contracts/types';
import { PLAYER_ID, cityById, newWorld, viewer } from './helpers';

const panelState = { showAllGoods: false, logCollapsed: false } as never;

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

function makeIssuance(cityId: string): BondIssuance {
  return {
    id: 'bond-test-1',
    cityId,
    issuedTick: 0,
    closedTick: 0,
    faceValue: 1000,
    couponRateAnnual: 0.04,
    interestPeriodMonths: 12,
    termMonths: 36,
    planUnits: 100,
    soldUnits: 40,
    unsoldUnits: 60,
    principal: 40_000,
    maturityTick: 36,
    status: 'active',
    lastCouponTick: null,
    arrearsInterest: 0,
    accruedInterest: 0,
    interestPaid: 0,
    couponsPaid: 0,
    principalRepaid: 0,
    bankAdvancedAmount: 0,
    redeemedTick: null,
    redemptionReason: null,
    note: '验收测试构造的批次',
  };
}

function makeHolding(cityId: string): BondHolding {
  return {
    id: 'holding-test-1',
    issuanceId: 'bond-test-1',
    cityId,
    holder: { kind: 'player', id: PLAYER_ID },
    units: 10,
    principal: 10_000,
    purchasedTick: 0,
    interestStartTick: 0,
    maturityTick: 36,
    lastCouponTick: null,
    accruedInterest: 0,
    interestPaid: 0,
    redeemedTick: null,
    status: 'active',
    note: '验收测试构造的持债',
  };
}

describe('I01 非市长可见的公开信息', () => {
  it('公开日志与通知可见；市长专属条目对非市长不可见（渲染期按当前身份过滤）', () => {
    const world = newWorld(0);
    const publicEntry: LogEntry = {
      tick: 0,
      kind: 'system',
      message: '公开事件',
      visibility: { scope: 'public', cityId: null },
    };
    const mayorEntry: LogEntry = {
      tick: 0,
      kind: 'government',
      message: '岚港财政流水',
      visibility: { scope: 'mayor', cityId: 'lanport' },
    };
    world.log.push(publicEntry, mayorEntry);
    const notice = (id: string, visibility: PlayerNotification['visibility']): PlayerNotification => ({
      id,
      tick: 0,
      audience: 'personal',
      kind: 'fiscal',
      priority: 'normal',
      title: `通知 ${id}`,
      body: '正文',
      read: false,
      visibility,
    });
    world.notifications.push(
      notice('n-public', { scope: 'public', cityId: null }),
      notice('n-mayor', { scope: 'mayor', cityId: 'lanport' }),
    );

    const nonMayor = viewer(null);
    expect(visibleLogEntries(world, nonMayor).map((entry) => entry.message)).toContain('公开事件');
    expect(visibleLogEntries(world, nonMayor).map((entry) => entry.message)).not.toContain(
      '岚港财政流水',
    );
    expect(visibleNotifications(world, nonMayor).map((entry) => entry.id)).toEqual(['n-public']);

    const mayor = viewer('lanport');
    expect(visibleLogEntries(world, mayor).map((entry) => entry.message)).toContain('岚港财政流水');
    expect(visibleNotifications(world, mayor).map((entry) => entry.id)).toEqual([
      'n-public',
      'n-mayor',
    ]);
  });

  it('公开债券投资信息按白名单投影（不含计划总额/总售额/政府总债务）', () => {
    const world = newWorld(0);
    const city = cityById(world, 'lanport');
    world.bonds!.issuances.push(makeIssuance(city.id));
    const offer = buildPublicBondOffer(world, 'bond-test-1');
    expect(offer).not.toBeNull();
    expect(offer!.cityId).toBe(city.id);
    expect(offer!.faceValue).toBe(1000);
    expect(offer!.unitsAvailable).toBe(60);
    const keys = Object.keys(offer!) as string[];
    expect(keys).not.toContain('planUnits');
    expect(keys).not.toContain('soldUnits');
    expect(keys).not.toContain('principal');
    expect(keys).not.toContain('totalDebt');
  });

  it('玩家可查看自己的持债记录（应得款与到期日），他人持债不混入', () => {
    const world = newWorld(0);
    const city = cityById(world, 'lanport');
    world.bonds!.issuances.push(makeIssuance(city.id));
    world.bonds!.holdings.push(makeHolding(city.id));
    const views = buildOwnBondHoldingViews(world, PLAYER_ID);
    expect(views.length).toBe(1);
    expect(views[0]!.holdingId).toBe('holding-test-1');
    expect(views[0]!.maturityTick).toBe(36);
    expect(views[0]!.principal).toBe(10_000);
    expect(buildOwnBondHoldingViews(world, 'someone-else')).toEqual([]);
  });
});

describe('I02 非市长不可见（市长专属财政）', () => {
  it('权限判定：非市长看不到任一城市的市长财政视图', () => {
    const world = newWorld(0);
    const nonMayor = viewer(null);
    for (const city of world.cities) {
      expect(canViewMayorFiscal(nonMayor, city.id)).toBe(false);
      expect(buildMayorFiscalView(world, city, DEMO_CONFIG, nonMayor)).toBeNull();
      expect(
        isVisibleTo({ scope: 'mayor', cityId: city.id }, nonMayor),
      ).toBe(false);
    }
    // 公开条目任何身份可见；缺省 visibility 的历史条目按公开处理（保守口径）。
    expect(isVisibleTo({ scope: 'public', cityId: null }, nonMayor)).toBe(true);
    expect(isVisibleTo(undefined, nonMayor)).toBe(true);
  });

});

describe('I03 间接泄漏：公开投资信息不得附带敏感汇总', () => {
  it('公开债券信息只有投资必需字段，不出现可推算发行总额/总售额/总债务的字段', () => {
    const world = newWorld(0);
    const city = cityById(world, 'lanport');
    world.bonds!.issuances.push(makeIssuance(city.id));
    const offer = buildPublicBondOffer(world, 'bond-test-1');
    expect(offer).not.toBeNull();
    const json = JSON.stringify(offer);
    expect(json).not.toContain('planUnits');
    expect(json).not.toContain('soldUnits');
    expect(json).not.toContain('principal');
    expect(json).not.toContain('totalDebt');
    expect(json).not.toContain('debtRatio');
  });
});

describe('I04 跨城身份隔离', () => {
  it('A 城市长只看 A 城财政视图；B 城返回 null（即便 B 城财政余额更多）', () => {
    const world = newWorld(0);
    const lanport = cityById(world, 'lanport');
    const ironvale = cityById(world, 'ironvale');
    lanport.treasury = 10_000;
    ironvale.treasury = 90_000_000;
    const mayorOfLanport = viewer('lanport');
    const view = buildMayorFiscalView(world, lanport, DEMO_CONFIG, mayorOfLanport);
    expect(view).not.toBeNull();
    expect(view!.cityId).toBe('lanport');
    expect(view!.treasury).toBe(10_000);
    expect(buildMayorFiscalView(world, ironvale, DEMO_CONFIG, mayorOfLanport)).toBeNull();
  });
});

describe('I05 换任后同一会话立即重校验', () => {
  it('任命/退任市长后无需重开，日志与视图过滤与视图立即随当前身份变化', () => {
    const world = newWorld(0);
    const city = cityById(world, 'lanport');
    world.log.push({
      tick: 0,
      kind: 'government',
      message: '岚港财政余额变动',
      visibility: { scope: 'mayor', cityId: 'lanport' },
    });

    expect(appointPlayerMayor(world, 'lanport').ok).toBe(true);
    expect(viewer(world.player.roles.mayorCityId ?? null).mayorCityId).toBe('lanport');
    expect(visibleLogEntries(world, viewer('lanport')).map((entry) => entry.message)).toContain(
      '岚港财政余额变动',
    );

    expect(stepDownPlayerMayor(world, 'lanport').ok).toBe(true);
    expect(world.player.roles.mayorCityId).toBeNull();
    expect(visibleLogEntries(world, viewer(null)).map((entry) => entry.message)).not.toContain(
      '岚港财政余额变动',
    );
    expect(buildMayorFiscalView(world, city, DEMO_CONFIG, viewer(null))).toBeNull();
  });
});

describe('I07a/c/d/e 旧界面泄漏回归（块4 前预期红）', () => {
  it('I07a 非市长城市卡片不显示“财政 <金额>”', () => {
    const store = createStore();
    const html = renderLeftRegion(store);
    expect(html).not.toMatch(/财政\s*<b>/);
  });

  it('I07a 城市卡片对所有人不显示财政；但市长仍能在城市面板看到财政（对照，避免误删市长视角）', () => {
    const store = createStore();
    store.setMayorDemo('lanport');
    store.selectCity('lanport');
    // 卡片是否对市长也隐藏属实现选择（需求只要求非市长不可见），不作为缺陷；
    // 真正必须守住的是：市长视角仍能获取财政数据（否则权限白名单被修成“谁都看不到”）。
    expect(renderLeftRegion(store)).not.toMatch(/财政\s*<b>/);
    expect(renderRightCity(store, panelState)).toContain('<span>财政</span>');
  });

  it('I07c/d 非市长概况 KPI 与政府面板不显示财政数据；市长可见', () => {
    const store = createStore();
    store.selectCity('lanport');
    const city = cityById(store.world, 'lanport');
    city.treasury = 60_000_000;

    const nonMayorHtml = renderRightCity(store, panelState);
    // 概况 KPI：不得出现财政金额块（I07c，当前仍红）。
    expect(nonMayorHtml).not.toContain('<span>财政</span>');
    // 政府面板：允许“仅市长可见”占位，但不得渲染财政流水明细（I07d）。
    expect(nonMayorHtml).not.toContain('data-testid="fiscal-ledger"');
    expect(nonMayorHtml).toContain('data-testid="fiscal-restricted"');

    store.setMayorDemo('lanport');
    const mayorHtml = renderRightCity(store, panelState);
    expect(mayorHtml).toContain('<span>财政</span>');
    expect(mayorHtml).toContain('data-testid="fiscal-ledger"');
    expect(mayorHtml).toContain('财政流水');
  });

  it('I07e 非市长无“财政资金不足”提示；市长资金不足时有', () => {
    const store = createStore();
    store.selectCity('lanport');
    const city = cityById(store.world, 'lanport');
    city.treasury = 0;
    const nonMayorHtml = renderRightCity(store, panelState);
    expect(nonMayorHtml).not.toContain('财政资金不足');

    store.setMayorDemo('lanport');
    const mayorHtml = renderRightCity(store, panelState);
    expect(mayorHtml).toContain('财政资金不足');
  });
});

describe('I09 默认开局非市长', () => {
  it('新世界玩家不是任何城市市长；界面不得显示财政', () => {
    const world = newWorld(0);
    expect(world.player.roles.mayorCityId).toBeNull();
    const store = createStore();
    expect(store.world.player.roles.mayorCityId).toBeNull();
    expect(store.mayorCityId).toBeNull();
    expect(renderLeftRegion(store)).not.toMatch(/财政\s*<b>/);
  });
});

describe('I08 模拟层不受展示限制', () => {
  it('财政状态仍由模拟正常读写（权限只在投影/展示层）', () => {
    const world = newWorld(1);
    const city: City = cityById(world, 'lanport');
    expect(typeof city.treasury).toBe('number');
    expect(city.lastMonth.householdIncome).toBeGreaterThan(0);
  });
});
