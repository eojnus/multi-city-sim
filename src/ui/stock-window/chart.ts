// 月 K 线：把 GameStore 的真实成交历史画成 SVG。
//
// 只消费 StockCandleView[]，不生成/推算价格；没有成交时返回明确的空态，
// 不用账面参考价伪造 K 线（口径见 stockMarketView().note）。

import type { StockCandleView } from '../../app/gameStore';
import { money, num, tickDate } from '../format';

const CHART_WIDTH = 520;
const CHART_HEIGHT = 190;
const PADDING = { left: 8, right: 46, top: 10, bottom: 22 };

function candleTooltip(candle: StockCandleView): string {
  return `${tickDate(candle.tick)} · 开 ${money(candle.open)} · 高 ${money(candle.high)} · 低 ${money(candle.low)} · 收 ${money(candle.close)} · 量 ${num(candle.volume, 0)} · ${num(candle.trades, 0)} 笔`;
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
  const plotWidth = CHART_WIDTH - PADDING.left - PADDING.right;
  const plotHeight = CHART_HEIGHT - PADDING.top - PADDING.bottom;
  const highs = candles.map((candle) => candle.high);
  const lows = candles.map((candle) => candle.low);
  const max = Math.max(...highs);
  const min = Math.min(...lows);
  const span = max - min || Math.max(max, 1) * 0.02;
  const y = (value: number): number =>
    PADDING.top + plotHeight - ((value - min) / span) * plotHeight;
  const slot = plotWidth / candles.length;
  const bodyWidth = Math.max(2, Math.min(9, slot * 0.55));
  const maxVolume = Math.max(...candles.map((candle) => candle.volume), 1);
  const volumeHeight = 26;

  const gridValues = [max, min + span / 2, min];
  const candlesSvg = candles
    .map((candle, index) => {
      const cx = PADDING.left + slot * index + slot / 2;
      const openY = y(candle.open);
      const closeY = y(candle.close);
      const top = Math.min(openY, closeY);
      const height = Math.max(1.5, Math.abs(closeY - openY));
      const rising = candle.close >= candle.open;
      const volume = Math.max(1, (candle.volume / maxVolume) * volumeHeight);
      return `
        <g class="stock-candle ${rising ? 'is-up' : 'is-down'}" data-tick="${candle.tick}">
          <title>${candleTooltip(candle)}</title>
          <line class="wick" x1="${cx.toFixed(1)}" y1="${y(candle.high).toFixed(1)}" x2="${cx.toFixed(1)}" y2="${y(candle.low).toFixed(1)}"></line>
          <rect class="body" x="${(cx - bodyWidth / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${bodyWidth.toFixed(1)}" height="${height.toFixed(1)}" rx="0.5"></rect>
          <rect class="vol" x="${(cx - bodyWidth / 2).toFixed(1)}" y="${(CHART_HEIGHT - PADDING.bottom + volumeHeight - volume).toFixed(1)}" width="${bodyWidth.toFixed(1)}" height="${volume.toFixed(1)}"></rect>
        </g>`;
    })
    .join('');

  return `
    <div class="stock-chart" data-testid="stock-chart">
      <svg viewBox="0 0 ${CHART_WIDTH} ${CHART_HEIGHT}" role="img" aria-label="月 K 线与成交量" preserveAspectRatio="none">
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
        <line class="axis-line" x1="${PADDING.left}" y1="${CHART_HEIGHT - PADDING.bottom}" x2="${CHART_WIDTH - PADDING.right}" y2="${CHART_HEIGHT - PADDING.bottom}"></line>
      </svg>
      <div class="stock-chart-meta">
        <span>共 ${num(candles.length)} 根月 K</span>
        <span>${escTick(candles[0]?.tick)} → ${escTick(candles[candles.length - 1]?.tick)}</span>
      </div>
    </div>`;
}

function escTick(tick: number | undefined): string {
  return typeof tick === 'number' ? tickDate(tick) : '—';
}
