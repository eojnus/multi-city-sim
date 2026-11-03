// v0.8 复验问题 3：企业退出/倒闭后保留真实股票历史。
//
// 规则：
// - 企业退出（股份类别被移除）后，此前真实成交形成的 K 线必须保留；
// - 存档校验允许历史引用已退出的企业/类别，不造成坏档；
// - 已退出企业只读：禁止下单、禁止恢复已注销股份；
// - 读档、刷新或其他企业交易不得清理这些历史。

import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation/core/simulation';
import { DEMO_CONFIG } from '../src/data/config';
import { GameStore } from '../src/app/gameStore';
import type { SaveBridge } from '../src/platform/saveBridge';
import type { ShareClass, WorldState } from '../src/simulation/contracts/types';
import {
  ensureStockHistory,
  latestStockPrice,
  recordStockTrade,
  stockHistoryFor,
} from '../src/simulation/securities/history';
import { shareClassId } from '../src/simulation/securities/securities';
import { parseSave, serializeSave } from '../src/simulation/core/save';
import { round2 } from '../src/simulation/core/math';

function createStore(simulation: Simulation): GameStore {
  const bridge: SaveBridge = {
    list: async () => ({ ok: true, slots: [] }),
    read: async (slot: string) => ({ ok: false, slot, error: '存档不存在', code: 'not-found' }),
    write: async (slot: string) => ({ ok: true, slot, savedAt: new Date().toISOString() }),
    remove: async () => ({ ok: true }),
    onMenuAction: () => () => undefined,
  } as unknown as SaveBridge;
  return new GameStore(simulation, bridge);
}

function classOfCompany(world: WorldState, companyId: string, kind: 'voting' | 'nonVoting'): ShareClass {
  const found = world.securities.classes.find(
    (candidate) => candidate.companyId === companyId && candidate.kind === kind,
  );
  if (!found) throw new Error(`缺少股份类别 ${companyId}:${kind}`);
  return found;
}

let tradeSeq = 0;
function trade(world: WorldState, shareClass: ShareClass, tick: number, price: number, shares: number) {
  tradeSeq += 1;
  recordStockTrade(
    world,
    {
      id: `retire-trade-${tradeSeq}`,
      tick,
      companyId: shareClass.companyId,
      shareClassId: shareClass.id,
      buyer: { type: 'player', id: 'player' },
      seller: { type: 'investorGroup', id: world.investors[0]?.id ?? 'lanport-invest1' },
      shares,
      unitPrice: price,
      value: round2(price * shares),
      origin: 'secondary',
    },
    DEMO_CONFIG,
  );
}

/** 模拟企业退出：删除企业记录、股份类别与相关持股/委托，但保留行情历史。 */
function retireCompany(world: WorldState, companyId: string): void {
  world.companies = world.companies.filter((company) => company.id !== companyId);
  const classIds = new Set(
    world.securities.classes
      .filter((candidate) => candidate.companyId === companyId)
      .map((candidate) => candidate.id),
  );
  world.securities.classes = world.securities.classes.filter(
    (candidate) => candidate.companyId !== companyId,
  );
  world.securities.holdings = world.securities.holdings.filter(
    (holding) => !classIds.has(holding.shareClassId),
  );
  world.securities.orders = world.securities.orders.filter(
    (order) => !classIds.has(order.shareClassId),
  );
  world.securities.offers = world.securities.offers.filter((offer) => offer.companyId !== companyId);
}

describe('企业退出后保留真实股票历史', () => {
  it('退出后 K 线、最后成交与名称快照保留，并标记退出月份', () => {
    const world = Simulation.create().state;
    const company = world.companies.find((candidate) => candidate.id === 'lp-garment') ?? world.companies[0]!;
    const shareClass = classOfCompany(world, company.id, 'voting');
    trade(world, shareClass, 2, 10, 100);
    trade(world, shareClass, 5, 12, 200);
    const before = stockHistoryFor(world, shareClass.id);
    expect(before?.candles.map((candle) => candle.tick)).toEqual([2, 5]);

    retireCompany(world, company.id);
    ensureStockHistory(world);

    const kept = stockHistoryFor(world, shareClass.id);
    expect(kept).toBeDefined();
    expect(kept!.candles.map((candle) => candle.tick)).toEqual([2, 5]);
    expect(kept!.candles[1]!.close).toBeCloseTo(12, 2);
    expect(kept!.lastTrade?.tick).toBe(5);
    expect(kept!.companyName).toBe(company.name);
    expect(kept!.exitedTick).toBe(world.time.tick);
    expect(latestStockPrice(world, shareClass.id)).toBeCloseTo(12, 2);
  });

  it('反复刷新/其他企业交易不会清除已退出历史，退出月份保持首次记录', () => {
    const world = Simulation.create().state;
    const retired = world.companies.find((candidate) => candidate.id === 'lp-garment') ?? world.companies[0]!;
    const live = world.companies.find((candidate) => candidate.id !== retired.id)!;
    const retiredClass = classOfCompany(world, retired.id, 'voting');
    const liveClass = classOfCompany(world, live.id, 'voting');
    trade(world, retiredClass, 1, 8, 10);
    retireCompany(world, retired.id);
    ensureStockHistory(world);
    const firstExitTick = stockHistoryFor(world, retiredClass.id)!.exitedTick;
    expect(firstExitTick).toBe(0);

    // 其他企业继续交易、时间前进后再次刷新：历史仍在，退出月份不被改写。
    world.time.tick = 7;
    trade(world, liveClass, 7, 20, 50);
    ensureStockHistory(world);
    ensureStockHistory(world);
    const kept = stockHistoryFor(world, retiredClass.id)!;
    expect(kept.candles.map((candle) => candle.tick)).toEqual([1]);
    expect(kept.exitedTick).toBe(firstExitTick);
    // 存续企业行情正常追加。
    expect(stockHistoryFor(world, liveClass.id)!.candles.map((candle) => candle.tick)).toEqual([7]);
  });

  it('存档校验允许历史引用已退出的企业/类别，读档后历史仍在', () => {
    const world = Simulation.create().state;
    const snapshot = JSON.parse(
      serializeSave(world, '2026-01-01T00:00:00.000Z'),
    ) as Record<string, any>;
    snapshot.world.securities.history.push({
      shareClassId: 'retired-co-voting',
      companyId: 'retired-co',
      kind: 'voting',
      companyName: '已退出示例厂',
      exitedTick: 4,
      candles: [
        { tick: 2, open: 5, high: 6, low: 4.5, close: 5.5, volume: 10, trades: 1 },
        { tick: 4, open: 5.5, high: 7, low: 5, close: 6.5, volume: 20, trades: 2 },
      ],
      lastTrade: { tick: 4, price: 6.5, shares: 20 },
    });
    const parsed = parseSave(JSON.stringify(snapshot));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || !parsed.world) return;
    const entry = parsed.world.securities.history.find(
      (candidate) => candidate.shareClassId === 'retired-co-voting',
    );
    expect(entry).toBeDefined();
    expect(entry!.companyName).toBe('已退出示例厂');
    expect(entry!.candles).toHaveLength(2);
    expect(entry!.exitedTick).toBe(4);
  });

  it('股票窗口列出已退出企业（只读），明细显示历史且禁止交易', () => {
    const simulation = Simulation.create();
    const world = simulation.state;
    const company = world.companies.find((candidate) => candidate.id === 'lp-garment') ?? world.companies[0]!;
    const shareClass = classOfCompany(world, company.id, 'voting');
    trade(world, shareClass, 2, 10, 100);
    retireCompany(world, company.id);
    ensureStockHistory(world);

    const store = createStore(simulation);
    store.openStockMarket(company.id, 'voting');
    const view = store.stockMarketView();
    const row = view.rows.find((candidate) => candidate.companyId === company.id);
    expect(row).toBeDefined();
    expect(row!.exited).toBe(true);
    expect(row!.tradable).toBe(false);
    expect(row!.companyName).toBe(company.name);
    expect(row!.lastTradeTick).toBe(2);

    const detail = view.selected;
    expect(detail?.company.id).toBe(company.id);
    expect(detail!.exited).toBe(true);
    expect(detail!.tradable).toBe(false);
    expect(detail!.candles.map((candle) => candle.tick)).toEqual([2]);
    expect(detail!.playerOrders).toEqual([]);

    const result = store.tradeShares(company.id, 'voting', 'buy', 10, 1);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('已退出');
  });
});
