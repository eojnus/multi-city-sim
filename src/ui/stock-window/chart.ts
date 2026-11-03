// 月 K 线：把 GameStore 的真实成交历史画成 SVG。
//
// 只消费 StockCandleView[]，不生成/推算价格；没有成交时返回明确的空态，
// 不用账面参考价伪造 K 线（口径见 stockMarketView().note）。
//
// 横坐标按**真实游戏月份**排布（v0.8 复验问题 2）：
// - x = 该月在一个月宽 slot 中的位置，而不是“数组第几根”；
// - 中间无成交的月份留出空档（不画 K 线/成交量），并在底部标注月份刻度；
// - 悬停标题里的月份与横坐标月份一致；
// - 成交量柱在独立的底部区域内绘制，绝不超出 SVG 视口。

import type { StockCandleView } from '../../app/gameStore';
import { money, num, tickDate } from '../format';

const CHART_WIDTH = 520;
const CHART_HEIGHT = 190;
const PADDING = { left: 8, right: 46, top: 10, bottom: 22 };
const VOLUME_HEIGHT = 30;
const VOLUME_GAP = 8;
/** 价格区底部（成交量区上方留白之后）。 */
const PRICE_BOTTOM = CHART_HEIGHT - PADDING.bottom - VOLUME_HEIGHT - VOLUME_GAP;
const VOLUME_BASE = CHART_HEIGHT - PADDING.bottom;

function candleTooltip(candle: StockCandleView): string {
  return `${tickDate(candle.tick)} · 开 ${money(candle.open)} · 高 ${money(candle.high)} · 低 ${money(candle.low)} · 收 ${money(candle.close)} · 量 ${num(candle.volume, 0)} · ${num(candle.trades, 0)} 笔`;
}

/** 最多 6 个月份刻度，覆盖首末月份与中间空档。 */
function monthLabels(firstTick: number, lastTick: number): number[] {
  const months = lastTick - firstTick + 1;
  const count = Math.min(6, Math.max(2, months));
  const result: number[] = [];
  for (let index = 0; index < count; index++) {
    const tick = Math.round(firstTick + ((lastTick - firstTick) * index) / (count - 1));
    if (result[result.length - 1] !== tick) result.push(tick);
  }
  return result;
}

/** 渲染月 K 线；空数组时返回「暂无成交 / 暂无数据」空态。 */
export function renderCandleChart(candles: readonly StockCandleView[]): string {
  if (candles.length === 0) {
    return `
      <div class="stock-chart-empty" data-testid="stock-chart-empty">
        <span class="empty-mark" aria-hidden="true">▁▂▃</span>
        <p>暂无成交 / 暂无数据</p>
        <small>行情只来自真实成交；本月没有成交时不会生成 K 线，旧存档历史也不补造数据。</small>
      </div>`;
  }
  const firstTick = candles[0]?.tick ?? 0;
  const lastTick = candles[candles.length - 1]?.tick ?? firstTick;
  const months = Math.max(1, lastTick - firstTick + 1);
  const gapMonths = Math.max(0, months - candles.length);
  const plotWidth = CHART_WIDTH - PADDING.left - PADDING.right;
  const priceHeight = PRICE_BOTTOM - PADDING.top;
  const slot = plotWidth / months;
  const highs = candles.map((candle) => candle.high);
  const lows = candles.map((candle) => candle.low);
  const max = Math.max(...highs);
  const min = Math.min(...lows);
  const span = max - min || Math.max(max, 1) * 0.02;
  const y = (value: number): number =>
    PADDING.top + priceHeight - ((value - min) / span) * priceHeight;
  const bodyWidth = Math.max(2, Math.min(9, slot * 0.55));
  const maxVolume = Math.max(...candles.map((candle) => candle.volume), 1);
  /** 按真实月份取横坐标；无成交月份自然留空。 */
  const xOf = (tick: number): number => PADDING.left + (tick - firstTick + 0.5) * slot;

  const gridValues = [max, min + span / 2, min];
  const candlesSvg = candles
    .map((candle) => {
      const cx = xOf(candle.tick);
      const openY = y(candle.open);
      const closeY = y(candle.close);
      const top = Math.min(openY, closeY);
      const height = Math.max(1.5, Math.abs(closeY - openY));
      const rising = candle.close >= candle.open;
      const volume = Math.max(1, (candle.volume / maxVolume) * VOLUME_HEIGHT);
      // 先量化底边再反推 y/height，避免四舍五入把柱子画到视口外（v0.8 复验问题 2）。
      const volumeTop = Number((VOLUME_BASE - volume).toFixed(1));
      const volumeHeightPx = Number((VOLUME_BASE - volumeTop).toFixed(1));
      return `
        <g class="stock-candle ${rising ? 'is-up' : 'is-down'}" data-tick="${candle.tick}">
          <title>${candleTooltip(candle)}</title>
          <line class="wick" x1="${cx.toFixed(1)}" y1="${y(candle.high).toFixed(1)}" x2="${cx.toFixed(1)}" y2="${y(candle.low).toFixed(1)}"></line>
          <rect class="body" x="${(cx - bodyWidth / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${bodyWidth.toFixed(1)}" height="${height.toFixed(1)}" rx="0.5"></rect>
          <rect class="vol" x="${(cx - bodyWidth / 2).toFixed(1)}" y="${volumeTop.toFixed(1)}" width="${bodyWidth.toFixed(1)}" height="${volumeHeightPx.toFixed(1)}"></rect>
        </g>`;
    })
    .join('');

  const labels = monthLabels(firstTick, lastTick);
  const labelSvg = labels
    .map((tick) => {
      const x = xOf(tick);
      return `<text class="axis month" x="${x.toFixed(1)}" y="${(CHART_HEIGHT - 6).toFixed(1)}" text-anchor="middle">${tickDate(tick)}</text>`;
    })
    .join('');
  // 无成交月份补一条淡淡的纵向刻度，便于看出“这里有空档”。
  const tradedTicks = new Set(candles.map((candle) => candle.tick));
  const gapMarks = Array.from({ length: months }, (_, index) => firstTick + index)
    .filter((tick) => !tradedTicks.has(tick))
    .map((tick) => {
      const x = xOf(tick);
      return `<line class="gap-mark" x1="${x.toFixed(1)}" y1="${PADDING.top}" x2="${x.toFixed(1)}" y2="${VOLUME_BASE}"></line>`;
    })
    .join('');

  return `
    <div class="stock-chart" data-testid="stock-chart" data-months="${months}" data-gap-months="${gapMonths}">
      <svg viewBox="0 0 ${CHART_WIDTH} ${CHART_HEIGHT}" role="img" aria-label="月 K 线与成交量（按真实月份排布，空档为无成交月）" preserveAspectRatio="none">
        ${gapMarks}
        ${gridValues
          .map(
            (value) =>
              `<line class="grid" x1="${PADDING.left}" y1="${y(value).toFixed(1)}" x2="${CHART_WIDTH - PADDING.right}" y2="${y(value).toFixed(1)}"></line>`,
          )
          .join('')}
        ${gridValues
          .map(
            (value) =>
              `<text class="axis" x="${CHART_WIDTH - PADDING.right + 3}" y="${(y(value) + 3).toFixed(1)}">${money(value)}</text>`,
          )
          .join('')}
        ${candlesSvg}
        <line class="axis-line" x1="${PADDING.left}" y1="${VOLUME_BASE}" x2="${CHART_WIDTH - PADDING.right}" y2="${VOLUME_BASE}"></line>
        <text class="axis vol-label" x="${PADDING.left}" y="${VOLUME_BASE + 10}">成交量</text>
        ${labelSvg}
      </svg>
      <div class="stock-chart-meta">
        <span>共 ${num(candles.length)} 根月 K · 覆盖 ${num(months)} 个月${gapMonths > 0 ? ` · 空档 ${num(gapMonths)} 个月无成交` : ''}</span>
        <span>${tickDate(firstTick)} → ${tickDate(lastTick)}</span>
      </div>
      <p class="stock-chart-note">横坐标按真实游戏月份排布；没有成交的月份不画 K 线，留空档且不生成价格。</p>
    </div>`;
}
