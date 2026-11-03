// v0.8 股票行情：按股份类别把真实成交聚合成月度 K 线（StockCandle）。
//
// 权威约定（Lead 已定契约）：
// - 只记录真实成交（origin === 'secondary'），主发行（origin === 'primary'）不计入行情；
//   不把账面参考价、挂单价或虚构历史写进 K 线。
// - 按成交 tick（游戏月）聚合：open = 当月首笔价、high/low = 区间、close = 末笔、
//   volume += 股数、trades += 1；同月多笔（含同一 tick 的多次撮合/玩家手动成交）合并到同一根。
// - 每类股份保留最近 config.securities.historyMonths 根 K 线；无成交的月份不生成 K 线。
// - lastTrade 记录最近一次真实成交（可跨月），用于“最近成交价”。
// - 行情是持久数据：读档后继续累积即可，禁止从 world.securities.lastTrades 反推历史。
// - 已退市（股份类别被移除）的行情条目会被清理，避免存档校验引用不存在的类别。

import type {
  StockCandle,
  StockClassHistory,
  StockTrade,
  WorldState,
} from '../contracts/types';
import type { DemoConfig } from '../../data/config';
import { round2 } from '../core/math';

function candleCapacity(config: DemoConfig): number {
  return Math.max(1, Math.floor(config.securities.historyMonths));
}

function sortedHistory(world: WorldState): StockClassHistory[] {
  return [...world.securities.history].sort((a, b) => a.shareClassId.localeCompare(b.shareClassId));
}

/**
 * 确保行情结构存在且与当前股份类别一致：
 * - 缺失的类别补一条空行情（candles: []）；
 * - 已移除的类别 / 企业或 kind 不匹配的条目会被清理；
 * - 按 shareClassId 排序，保证遍历与存档确定性。
 * 幂等：反复调用不会产生重复条目，也不会改变已有 K 线。
 */
export function ensureStockHistory(world: WorldState): StockClassHistory[] {
  if (!Array.isArray(world.securities.history)) {
    world.securities.history = [];
  }
  const classes = [...world.securities.classes].sort((a, b) => a.id.localeCompare(b.id));
  const classById = new Map(classes.map((shareClass) => [shareClass.id, shareClass]));
  const existing = new Map(world.securities.history.map((entry) => [entry.shareClassId, entry]));

  const next: StockClassHistory[] = [];
  for (const shareClass of classes) {
    const entry = existing.get(shareClass.id);
    if (entry) {
      // 类别元数据以 securities.classes 为权威。
      entry.companyId = shareClass.companyId;
      entry.kind = shareClass.kind;
      next.push(entry);
      continue;
    }
    next.push({
      shareClassId: shareClass.id,
      companyId: shareClass.companyId,
      kind: shareClass.kind,
      candles: [],
    });
  }
  // 不在 classById 中的历史类别自然被丢弃（企业退市后行情不再保留，避免坏档）。
  world.securities.history = next;
  return world.securities.history;
}

/** 查某个股份类别的行情条目（不存在时 undefined；不会顺手创建）。 */
export function stockHistoryFor(
  world: WorldState,
  shareClassIdValue: string,
): StockClassHistory | undefined {
  return (world.securities.history ?? []).find((entry) => entry.shareClassId === shareClassIdValue);
}

/**
 * 最近一次真实成交价：优先 lastTrade（可跨月），否则取最近一根 K 线收盘价。
 * 没有成交历史时返回 null，供行情界面显示“暂无数据”。
 */
export function latestStockPrice(world: WorldState, shareClassIdValue: string): number | null {
  const history = stockHistoryFor(world, shareClassIdValue);
  if (!history) return null;
  if (history.lastTrade) return round2(history.lastTrade.price);
  const last = history.candles[history.candles.length - 1];
  return last ? round2(last.close) : null;
}

/**
 * 记录一笔真实成交到对应股份类别的月度 K 线。
 * 主发行（primary）、非正价格/股数的记录被忽略；未知类别（已退市）也被忽略。
 */
export function recordStockTrade(
  world: WorldState,
  trade: StockTrade,
  config: DemoConfig,
): void {
  if (!trade || trade.origin !== 'secondary') return;
  const price = round2(trade.unitPrice);
  const shares = round2(trade.shares);
  if (!Number.isFinite(price) || price <= 0) return;
  if (!Number.isFinite(shares) || shares <= 0) return;

  const history = ensureStockHistory(world);
  const entry = history.find((candidate) => candidate.shareClassId === trade.shareClassId);
  if (!entry) return;

  const existingCandle = entry.candles.find((candle) => candle.tick === trade.tick);
  if (existingCandle) {
    // 同月多笔：开盘价保持首笔，最高/最低/收盘价随之更新，成交量与笔数累加。
    existingCandle.high = round2(Math.max(existingCandle.high, price));
    existingCandle.low = round2(Math.min(existingCandle.low, price));
    existingCandle.close = price;
    existingCandle.volume = round2(existingCandle.volume + shares);
    existingCandle.trades += 1;
  } else {
    const candle: StockCandle = {
      tick: trade.tick,
      open: price,
      high: price,
      low: price,
      close: price,
      volume: shares,
      trades: 1,
    };
    entry.candles.push(candle);
    entry.candles.sort((a, b) => a.tick - b.tick);
  }

  // 最近成交：按 tick 与处理顺序取最新（乱序 tick 不会覆盖更新的记录）。
  if (!entry.lastTrade || trade.tick >= entry.lastTrade.tick) {
    entry.lastTrade = { tick: trade.tick, price, shares };
  }

  const keep = candleCapacity(config);
  if (entry.candles.length > keep) {
    entry.candles.splice(0, entry.candles.length - keep);
  }

  // 保持存档中的行情顺序稳定（与 ensureStockHistory 一致）。
  world.securities.history = sortedHistory(world);
}
