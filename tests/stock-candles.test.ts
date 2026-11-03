// v0.8 股票行情 K 线：真实成交聚合、按类别分离、读档续写不重复、历史裁剪。
//
// 只用公开 API 构造成交：直接调用 recordStockTrade 验证聚合规则，并通过 matchOrders
// 验证“撮合产生的每笔真实成交都会进入行情”。

import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation/core/simulation';
import { DEMO_CONFIG } from '../src/data/config';
import type { DemoConfig } from '../src/data/config';
import type { ShareClass, StockTrade, WorldState } from '../src/simulation/contracts/types';
import {
  ensureStockHistory,
  latestStockPrice,
  recordStockTrade,
  stockHistoryFor,
} from '../src/simulation/securities/history';
import {
  matchOrders,
  placeOrder,
  shareClassId,
} from '../src/simulation/securities/securities';
import { groupHolder, groupsOfCity } from '../src/simulation/investors/investors';
import { parseSave, serializeSave } from '../src/simulation/core/save';
import { round2 } from '../src/simulation/core/math';

function newWorld(): WorldState {
  return Simulation.create().state;
}

function classFor(world: WorldState, companyId: string, kind: 'voting' | 'nonVoting'): ShareClass {
  const shareClass = world.securities.classes.find(
    (candidate) => candidate.companyId === companyId && candidate.kind === kind,
  );
  if (!shareClass) throw new Error(`缺少股份类别：${companyId}:${kind}`);
  return shareClass;
}

let tradeCounter = 0;

function makeTrade(
  world: WorldState,
  shareClass: ShareClass,
  tick: number,
  unitPrice: number,
  shares: number,
  origin: 'secondary' | 'primary' = 'secondary',
): StockTrade {
  tradeCounter += 1;
  return {
    id: `probe-trade-${tradeCounter}`,
    tick,
    companyId: shareClass.companyId,
    shareClassId: shareClass.id,
    buyer: { type: 'player', id: 'player' },
    seller: { type: 'investorGroup', id: world.investors[0]?.id ?? 'lanport-invest1' },
    shares,
    unitPrice,
    value: round2(unitPrice * shares),
    origin,
  };
}

/** 覆盖 securities 配置（测试用极小上限，避免构造 400 笔真实撮合）。 */
function configWithSecurities(overrides: Record<string, unknown>): DemoConfig {
  return {
    ...DEMO_CONFIG,
    securities: { ...DEMO_CONFIG.securities, ...overrides },
  } as unknown as DemoConfig;
}

const FOOD = 'lp-food';
const GARMENT = 'lp-garment';

describe('股票行情 K 线（v0.8）', () => {
  it('为每个股份类别建立行情条目：开档空容器、ensureStockHistory 幂等、撮合写入不重复', () => {
    const world = newWorld();
    // v0.8 initializer 会调用 ensureStockHistory：新世界开档即每类一条空行情；
    // 旧存档则可能是空数组。两种入口都必须被 ensureStockHistory 收敛到同一结构。
    expect(Array.isArray(world.securities.history)).toBe(true);
    if (world.securities.history.length > 0) {
      expect(world.securities.history).toHaveLength(world.securities.classes.length);
      for (const entry of world.securities.history) {
        expect(entry.candles).toEqual([]);
        expect(entry.lastTrade).toBeUndefined();
      }
    }

    const history = ensureStockHistory(world);
    expect(history).toHaveLength(world.securities.classes.length);
    for (const shareClass of world.securities.classes) {
      const entry = stockHistoryFor(world, shareClass.id);
      expect(entry).toBeDefined();
      expect(entry!.companyId).toBe(shareClass.companyId);
      expect(entry!.kind).toBe(shareClass.kind);
      expect(entry!.candles).toEqual([]);
      expect(entry!.lastTrade).toBeUndefined();
    }

    // 再调用一次不产生重复条目。
    ensureStockHistory(world);
    expect(world.securities.history).toHaveLength(world.securities.classes.length);
    const ids = world.securities.history.map((entry) => entry.shareClassId);
    expect(new Set(ids).size).toBe(ids.length);
    // 排序稳定（便于存档与 UI 遍历）。
    expect(ids).toEqual([...ids].sort((a, b) => a.localeCompare(b)));

    // 开档已有空容器的世界经过一次真实撮合后再次 ensureStockHistory：
    // 只把成交合并进同一根 K 线，不重复建条目、不重复累计量/笔数。
    world.time.tick = 2;
    const company = world.companies.find((candidate) => candidate.id === FOOD)!;
    const shareClass = classFor(world, FOOD, 'voting');
    const group = groupsOfCity(world, company.cityId)[0]!;
    expect(
      placeOrder(world, {
        companyId: company.id,
        shareClassId: shareClass.id,
        side: 'sell',
        holder: groupHolder(group),
        shares: 100,
        limitPrice: 150,
        tick: 2,
      }).ok,
    ).toBe(true);
    expect(
      placeOrder(world, {
        companyId: company.id,
        shareClassId: shareClass.id,
        side: 'buy',
        holder: { type: 'player', id: 'player' },
        shares: 100,
        limitPrice: 160,
        tick: 2,
      }).ok,
    ).toBe(true);
    const trades = matchOrders(world, 2, DEMO_CONFIG);
    expect(trades).toHaveLength(1);
    ensureStockHistory(world);
    const entry = stockHistoryFor(world, shareClass.id)!;
    expect(entry.candles).toHaveLength(1);
    expect(entry.candles[0]).toEqual({
      tick: 2,
      open: 150,
      high: 150,
      low: 150,
      close: 150,
      volume: 100,
      trades: 1,
    });
    expect(world.securities.history).toHaveLength(world.securities.classes.length);
  });

  it('同一结算月的多笔成交合并为一根 K 线（开高低收/量/笔数）', () => {
    const world = newWorld();
    const shareClass = classFor(world, FOOD, 'voting');

    recordStockTrade(world, makeTrade(world, shareClass, 5, 10, 100), DEMO_CONFIG);
    recordStockTrade(world, makeTrade(world, shareClass, 5, 12, 50), DEMO_CONFIG);
    recordStockTrade(world, makeTrade(world, shareClass, 5, 8, 30), DEMO_CONFIG);

    const entry = stockHistoryFor(world, shareClass.id)!;
    expect(entry.candles).toHaveLength(1);
    const candle = entry.candles[0]!;
    expect(candle).toEqual({ tick: 5, open: 10, high: 12, low: 8, close: 8, volume: 180, trades: 3 });
    expect(entry.lastTrade).toEqual({ tick: 5, price: 8, shares: 30 });
    expect(latestStockPrice(world, shareClass.id)).toBe(8);
  });

  it('单笔成交月 OHLC 相等；无成交的月份不生成 K 线', () => {
    const world = newWorld();
    const shareClass = classFor(world, FOOD, 'voting');

    recordStockTrade(world, makeTrade(world, shareClass, 7, 20, 40), DEMO_CONFIG);
    recordStockTrade(world, makeTrade(world, shareClass, 9, 21, 10), DEMO_CONFIG);

    const candles = stockHistoryFor(world, shareClass.id)!.candles;
    expect(candles.map((candle) => candle.tick)).toEqual([7, 9]);
    expect(candles[0]).toEqual({ tick: 7, open: 20, high: 20, low: 20, close: 20, volume: 40, trades: 1 });
    // 第 8 月没有成交：不存在 tick=8 的 K 线。
    expect(candles.some((candle) => candle.tick === 8)).toBe(false);
  });

  it('两类股份的行情完全分离，互不混合', () => {
    const world = newWorld();
    const voting = classFor(world, GARMENT, 'voting');
    const nonVoting = classFor(world, GARMENT, 'nonVoting');

    recordStockTrade(world, makeTrade(world, voting, 3, 30, 100), DEMO_CONFIG);
    recordStockTrade(world, makeTrade(world, nonVoting, 3, 5, 60), DEMO_CONFIG);

    const votingEntry = stockHistoryFor(world, voting.id)!;
    const nonVotingEntry = stockHistoryFor(world, nonVoting.id)!;
    expect(votingEntry.kind).toBe('voting');
    expect(nonVotingEntry.kind).toBe('nonVoting');
    expect(votingEntry.candles).toHaveLength(1);
    expect(nonVotingEntry.candles).toHaveLength(1);
    expect(votingEntry.candles[0]!.open).toBe(30);
    expect(nonVotingEntry.candles[0]!.open).toBe(5);
    expect(votingEntry.candles[0]!.volume).toBe(100);
    expect(nonVotingEntry.candles[0]!.volume).toBe(60);
  });

  it('主发行（primary）成交不写入行情', () => {
    const world = newWorld();
    const shareClass = classFor(world, FOOD, 'voting');
    // 先建立行情结构，再验证主发行不会写入。
    ensureStockHistory(world);

    recordStockTrade(world, makeTrade(world, shareClass, 2, 99, 1000, 'primary'), DEMO_CONFIG);
    const entry = stockHistoryFor(world, shareClass.id)!;
    expect(entry.candles).toEqual([]);
    expect(entry.lastTrade).toBeUndefined();

    // 之后的二级成交照常记录。
    recordStockTrade(world, makeTrade(world, shareClass, 2, 100, 5), DEMO_CONFIG);
    expect(stockHistoryFor(world, shareClass.id)!.candles).toHaveLength(1);
    expect(stockHistoryFor(world, shareClass.id)!.candles[0]!.close).toBe(100);
  });

  it('matchOrders 的每笔真实成交都进入对应类别的 K 线，lastTrades 保留该笔', () => {
    const world = newWorld();
    world.time.tick = 2;
    const company = world.companies.find((candidate) => candidate.id === FOOD)!;
    const shareClass = classFor(world, FOOD, 'voting');
    const group = groupsOfCity(world, company.cityId)[0]!;

    const sell = placeOrder(world, {
      companyId: company.id,
      shareClassId: shareClass.id,
      side: 'sell',
      holder: groupHolder(group),
      shares: 100,
      limitPrice: 150,
      tick: 2,
    });
    const buy = placeOrder(world, {
      companyId: company.id,
      shareClassId: shareClass.id,
      side: 'buy',
      holder: { type: 'player', id: 'player' },
      shares: 100,
      limitPrice: 160,
      tick: 2,
    });
    expect(sell.ok).toBe(true);
    expect(buy.ok).toBe(true);

    const trades = matchOrders(world, 2, DEMO_CONFIG);
    expect(trades).toHaveLength(1);
    expect(world.securities.lastTrades.some((trade) => trade.id === trades[0]!.id)).toBe(true);

    const entry = stockHistoryFor(world, shareClass.id)!;
    expect(entry.candles).toHaveLength(1);
    expect(entry.candles[0]).toEqual({
      tick: 2,
      open: 150,
      high: 150,
      low: 150,
      close: 150,
      volume: 100,
      trades: 1,
    });
    expect(entry.lastTrade).toEqual({ tick: 2, price: 150, shares: 100 });
    expect(latestStockPrice(world, shareClass.id)).toBe(150);
  });

  it('读档往返后行情保留，继续成交只合并/追加而不会重复计数', () => {
    const world = newWorld();
    const shareClass = classFor(world, FOOD, 'voting');
    recordStockTrade(world, makeTrade(world, shareClass, 4, 10, 100), DEMO_CONFIG);
    recordStockTrade(world, makeTrade(world, shareClass, 5, 11, 20), DEMO_CONFIG);

    const parsed = parseSave(serializeSave(world));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || !parsed.world) throw new Error(parsed.error ?? '存档解析失败');
    const restored = parsed.world;
    expect(restored.securities.history).toEqual(world.securities.history);

    // 读档后同一游戏月再来一笔：合并进原 K 线，不产生新的重复根。
    recordStockTrade(restored, makeTrade(restored, shareClass, 4, 12, 30), DEMO_CONFIG);
    const entry = stockHistoryFor(restored, shareClass.id)!;
    expect(entry.candles).toHaveLength(2);
    expect(entry.candles.map((candle) => candle.tick)).toEqual([4, 5]);
    expect(entry.candles[0]).toEqual({
      tick: 4,
      open: 10,
      high: 12,
      low: 10,
      close: 12,
      volume: 130,
      trades: 2,
    });
    expect(entry.lastTrade).toEqual({ tick: 5, price: 11, shares: 20 });
  });

  it('每类股份只保留最近 historyMonths（36）根 K 线', () => {
    const world = newWorld();
    const shareClass = classFor(world, FOOD, 'voting');
    for (let tick = 1; tick <= 40; tick += 1) {
      recordStockTrade(world, makeTrade(world, shareClass, tick, 10 + tick, 1), DEMO_CONFIG);
    }
    const candles = stockHistoryFor(world, shareClass.id)!.candles;
    expect(candles).toHaveLength(DEMO_CONFIG.securities.historyMonths);
    expect(candles[0]!.tick).toBe(5);
    expect(candles[candles.length - 1]!.tick).toBe(40);
    // 升序且不重复。
    for (let index = 1; index < candles.length; index += 1) {
      expect(candles[index]!.tick).toBeGreaterThan(candles[index - 1]!.tick);
    }
  });

  it('lastTrades 按 tradeHistoryLimit 截断，保留最新成交', () => {
    const world = newWorld();
    const shareClass = classFor(world, FOOD, 'voting');
    for (let index = 1; index <= 6; index += 1) {
      world.securities.lastTrades.push(makeTrade(world, shareClass, 1, 10 + index, 1));
    }
    const config = configWithSecurities({ tradeHistoryLimit: 2 });
    matchOrders(world, 1, config);
    expect(world.securities.lastTrades).toHaveLength(2);
    const kept = world.securities.lastTrades.map((trade) => trade.unitPrice);
    expect(kept).toEqual([15, 16]);
  });

  it('成交写入行情后，存档校验仍通过（行情结构完整）', () => {
    const world = newWorld();
    const shareClass = classFor(world, FOOD, 'voting');
    recordStockTrade(world, makeTrade(world, shareClass, 1, 10, 100), DEMO_CONFIG);
    recordStockTrade(world, makeTrade(world, shareClass, 2, 11, 50), DEMO_CONFIG);
    const parsed = parseSave(serializeSave(world));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || !parsed.world) throw new Error(parsed.error ?? '存档解析失败');
    expect(parsed.world.securities.history.length).toBe(world.securities.classes.length);
  });
});
