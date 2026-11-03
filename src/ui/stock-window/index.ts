// 股票市场浮动大窗口：纯字符串渲染（测试可直接断言，无需 DOM）。
//
// 口径：
// - 数据全部来自 GameStore.stockMarketView() / StockDetailView，UI 不维护账本、不推算价格；
// - 最近成交价与账面参考价分开标注；没有成交时显示「暂无成交 / 暂无数据」；
// - 表单只做前端可用性提示，最终以 store.tradeShares(...) 的命令结果为准（按钮禁用不能替代命令校验）；
// - 打开/关闭窗口不改变模拟暂停状态（由 GameUI 负责，窗口只渲染数据）。

import type {
  StockCandleView,
  StockDetailView,
  StockListRow,
  StockMarketView,
  StockOrderView,
} from '../../app/gameStore';
import { esc, money, num, pct, tickDate } from '../format';
import { renderCandleChart } from './chart';

export const STOCK_WINDOW_MIN_WIDTH = 900;
export const STOCK_WINDOW_MIN_HEIGHT = 560;
const STOCK_WINDOW_MARGIN = 16;
/** 标题栏至少保留这么多像素在屏幕内，保证可以拖回来。 */
const TITLE_BAR_KEEP_VISIBLE = 160;
const TITLE_BAR_HEIGHT = 34;

export interface StockWindowRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface StockViewport {
  width: number;
  height: number;
}

export type StockSide = 'buy' | 'sell';

export interface StockDraft {
  side: StockSide;
  shares: string;
  limitPrice: string;
}

export interface StockWindowOptions {
  rect?: StockWindowRect;
  draft?: StockDraft;
  /** 上一次下单结果/失败提示（来自 store.tradeShares 返回值或 store.toast）。 */
  orderNote?: string | null;
  /** 当前模拟月份（store.dateLabel）；窗口内也保留时间与暂停/继续操作。 */
  monthLabel?: string;
  /** 自动推进状态：窗口内按钮与 HUD 是同一个命令，不会互相改变暂停状态。 */
  autoRunning?: boolean;
}

/** 默认窗口尺寸：优先 1200×760，屏幕更小时按视口收缩（但不低于最小尺寸）。 */
export function defaultStockWindowRect(viewport: StockViewport): StockWindowRect {
  const width = Math.max(
    STOCK_WINDOW_MIN_WIDTH,
    Math.min(1200, viewport.width - STOCK_WINDOW_MARGIN * 2),
  );
  const height = Math.max(
    STOCK_WINDOW_MIN_HEIGHT,
    Math.min(760, viewport.height - STOCK_WINDOW_MARGIN * 2),
  );
  return {
    left: Math.max(STOCK_WINDOW_MARGIN, Math.round((viewport.width - width) / 2)),
    top: Math.max(STOCK_WINDOW_MARGIN, Math.round((viewport.height - height) / 2)),
    width,
    height,
  };
}

/**
 * 约束窗口矩形：
 * - 宽高不低于 900×560，不超过视口；
 * - 标题栏不能移出屏幕（顶部 ≥ 0，且至少保留一段标题栏可抓取）；
 * - 窗口主体尽量留在视口内，但允许右侧/底部略微超出（拖动时更自然）。
 */
export function clampStockWindowRect(
  rect: StockWindowRect,
  viewport: StockViewport,
): StockWindowRect {
  const width = Math.max(
    STOCK_WINDOW_MIN_WIDTH,
    Math.min(Math.max(STOCK_WINDOW_MIN_WIDTH, viewport.width), rect.width),
  );
  const height = Math.max(
    STOCK_WINDOW_MIN_HEIGHT,
    Math.min(Math.max(STOCK_WINDOW_MIN_HEIGHT, viewport.height), rect.height),
  );
  const maxLeft = viewport.width - TITLE_BAR_KEEP_VISIBLE;
  const minLeft = TITLE_BAR_KEEP_VISIBLE - width;
  const maxTop = viewport.height - TITLE_BAR_HEIGHT - 4;
  const left = Math.max(minLeft, Math.min(maxLeft, rect.left));
  const top = Math.max(0, Math.min(maxTop, rect.top));
  return {
    left: Math.round(left),
    top: Math.round(top),
    width: Math.round(width),
    height: Math.round(height),
  };
}

function signedPct(value: number | null): string {
  if (value === null) return '—';
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`;
}

function changeClass(value: number | null): string {
  if (value === null || value === 0) return 'is-flat';
  return value > 0 ? 'is-up' : 'is-down';
}

function priceText(value: number | null, emptyLabel: string): string {
  return value === null ? emptyLabel : money(value);
}

function estimatedAmount(draft: StockDraft | undefined): number | null {
  if (!draft) return null;
  const shares = Number(draft.shares);
  const limit = Number(draft.limitPrice);
  if (!Number.isFinite(shares) || !Number.isFinite(limit) || shares <= 0 || limit <= 0) return null;
  return shares * limit;
}

interface OrderValidation {
  shares: number;
  limit: number;
  valid: boolean;
  reason: string;
}

function validateOrder(detail: StockDetailView, draft: StockDraft | undefined): OrderValidation {
  const shares = Number(draft?.shares ?? '');
  const limit = Number(draft?.limitPrice ?? '');
  const side: StockSide = draft?.side ?? 'buy';
  if (!detail.tradable) {
    return { shares, limit, valid: false, reason: '该股份类别暂不可交易。' };
  }
  if (!Number.isInteger(shares) || shares <= 0) {
    return { shares, limit, valid: false, reason: '股数必须是正整数。' };
  }
  if (!Number.isFinite(limit) || limit <= 0) {
    return { shares, limit, valid: false, reason: '限价必须大于 0。' };
  }
  if (side === 'buy' && shares * limit > detail.playerCash + 1e-6) {
    return {
      shares,
      limit,
      valid: false,
      reason: `现金不足：预计需要 ${money(shares * limit)}，可投资现金 ${money(detail.playerCash)}。`,
    };
  }
  if (side === 'sell' && shares > detail.playerShares) {
    return {
      shares,
      limit,
      valid: false,
      reason: `可卖股数不足：你持有 ${num(detail.playerShares)} 股。`,
    };
  }
  return { shares, limit, valid: true, reason: '' };
}

function renderKindSwitch(kind: StockMarketView['kind']): string {
  return `
    <div class="stock-kind-switch" role="group" aria-label="股份类别" data-testid="stock-kind-switch">
      ${(['voting', 'nonVoting'] as const)
        .map(
          (value) => `
          <button
            type="button"
            class="chip-btn ${kind === value ? 'is-selected' : ''}"
            data-action="stock-kind"
            data-kind="${value}"
            data-focus-key="stock-kind-${value}"
            aria-pressed="${kind === value}"
          >${value === 'voting' ? '有投票权' : '仅分红'}</button>`,
        )
        .join('')}
    </div>`;
}

function renderRow(row: StockListRow, selected: boolean): string {
  return `
    <button
      type="button"
      class="stock-row ${selected ? 'is-selected' : ''} ${row.exited ? 'is-exited' : row.tradable ? '' : 'is-locked'}"
      data-action="stock-focus"
      data-company-id="${esc(row.companyId)}"
      data-testid="stock-row-${esc(row.companyId)}"
      data-focus-key="stock-row-${esc(row.companyId)}"
      aria-pressed="${selected}"
      title="${esc(row.companyName)} · ${esc(row.cityName)} · ${esc(row.industry)}"
    >
      <span class="stock-row-main">
        <b>${esc(row.companyName)}</b>
        <em>${esc(row.industry)} · ${esc(row.cityName)}</em>
      </span>
      <span class="stock-row-nums">
        <b>${row.lastPrice === null ? '暂无成交' : num(row.lastPrice, 2)}</b>
        <em class="${changeClass(row.changePct)}">${signedPct(row.changePct)}</em>
      </span>
      <span class="stock-row-flags">
        ${row.playerShares > 0 ? `<span class="stock-holding-flag" title="你的持股 ${num(row.playerShares)} 股 / ${pct(row.playerStake, 2)}">持仓 ${pct(row.playerStake, 1)}</span>` : ''}
        ${row.playerOpenOrders > 0 ? `<span class="stock-order-flag">挂单 ${row.playerOpenOrders}</span>` : ''}
        ${row.exited ? '<span class="stock-exited-flag">已退出</span>' : row.tradable ? '' : '<span class="stock-locked-flag">不可交易</span>'}
      </span>
    </button>`;
}

function renderMarketPanel(view: StockMarketView): string {
  const detail = view.selected;
  if (!detail) {
    return `
      <div class="empty-state compact" data-testid="stock-detail-empty">
        <span class="empty-mark" aria-hidden="true">◫</span>
        <p>选择左侧企业查看行情</p>
        <small>列表为空时，可切换类别或清空搜索/筛选条件。</small>
      </div>`;
  }
  return `
    <div class="stock-market-head">
      <div>
        <span class="kicker">${detail.kind === 'voting' ? 'VOTING SHARES' : 'NON-VOTING SHARES'}</span>
        <h3 data-testid="stock-selected-name">${esc(detail.company.name)}</h3>
        <p class="stock-market-sub">${esc(detail.company.cityName)} · ${esc(detail.company.industry)} · 员工 ${num(detail.company.employees)}</p>
      </div>
      ${renderKindSwitch(view.kind)}
    </div>
    <div class="stock-quote" data-testid="stock-quote">
      <div class="quote-cell">
        <span>最近成交价</span>
        <b>${priceText(detail.lastPrice, '暂无成交')}</b>
        <small>${detail.lastTradeTick === null ? '还没有真实成交' : `最近 ${esc(tickDate(detail.lastTradeTick))}`}</small>
      </div>
      <div class="quote-cell">
        <span>账面参考价</span>
        <b>${money(detail.bookPrice)}</b>
        <small>不是可成交价</small>
      </div>
      <div class="quote-cell ${changeClass(detail.changePct)}">
        <span>较上月收盘</span>
        <b>${signedPct(detail.changePct)}</b>
        <small>无可靠基准时显示 —</small>
      </div>
      <div class="quote-cell">
        <span>盘口</span>
        <b>${detail.bestBid === null ? '—' : `买 ${num(detail.bestBid, 2)}`} / ${detail.bestAsk === null ? '—' : `卖 ${num(detail.bestAsk, 2)}`}</b>
        <small>未成交委托最优价</small>
      </div>
    </div>
    ${detail.exited ? `<div class="stock-exited-notice" data-testid="stock-exited-notice" role="status">
      <b>已退出市场</b>
      <span>${detail.lastTradeTick === null ? '退出前没有真实成交记录' : `最后真实成交：${esc(tickDate(detail.lastTradeTick))}`} · 股份已注销，不可再交易或恢复</span>
    </div>` : ''}
    ${renderCandleChart(detail.candles as readonly StockCandleView[])}
    <p class="stock-market-note">${esc(detail.note)}</p>`;
}

function renderOrderForm(
  detail: StockDetailView,
  draft: StockDraft | undefined,
  orderNote: string | null | undefined,
): string {
  const side: StockSide = draft?.side ?? 'buy';
  const validation = validateOrder(detail, draft);
  const estimated = estimatedAmount(draft);
  const hint = validation.valid
    ? side === 'buy'
      ? `预计金额 ${money(estimated ?? 0)}；下单后按真实对手方撮合。`
      : `预计回收 ${money(estimated ?? 0)}；可卖 ${num(detail.playerShares)} 股。`
    : validation.reason;
  return `
    <section class="stock-order" data-testid="stock-order-form">
      <div class="stock-order-head">
        <span class="kicker">ORDER TICKET</span>
        <div class="stock-side-switch" role="group" aria-label="买卖方向">
          <button
            type="button"
            class="chip-btn ${side === 'buy' ? 'is-selected is-buy' : ''}"
            data-action="stock-side"
            data-side="buy"
            data-focus-key="stock-side-buy"
            aria-pressed="${side === 'buy'}"
          >买入</button>
          <button
            type="button"
            class="chip-btn ${side === 'sell' ? 'is-selected is-sell' : ''}"
            data-action="stock-side"
            data-side="sell"
            data-focus-key="stock-side-sell"
            aria-pressed="${side === 'sell'}"
          >卖出</button>
        </div>
      </div>
      <label class="stock-field">
        <span>股数（整数）</span>
        <input type="number" min="1" step="1" inputmode="numeric" data-stock-shares data-focus-key="stock-shares" value="${esc(draft?.shares ?? '')}" placeholder="例如 100">
      </label>
      <label class="stock-field">
        <span>限价（信用点 / 股）</span>
        <input type="number" min="0.01" step="0.01" data-stock-limit data-focus-key="stock-limit" value="${esc(draft?.limitPrice ?? '')}" placeholder="${detail.lastPrice === null ? '参考账面价 ' + num(detail.bookPrice, 2) : num(detail.lastPrice, 2)}">
      </label>
      <div class="stock-quick-row" role="group" aria-label="快捷数量">
        ${[100, 1000, 10000]
          .map(
            (shares) =>
              `<button type="button" class="chip-btn" data-action="stock-quick-shares" data-shares="${shares}" data-focus-key="stock-quick-${shares}" title="填入 ${num(shares)} 股">${num(shares)}</button>`,
          )
          .join('')}
      </div>
      <div class="stock-order-meta">
        <span>预估金额 <b>${estimated === null ? '—' : money(estimated)}</b></span>
        <span>可投资现金 <b>${money(detail.playerCash)}</b></span>
        <span>可卖股数 <b>${num(detail.playerShares)}</b></span>
      </div>
      <button
        type="button"
        class="ken-btn ${side === 'buy' ? 'ken-btn--green' : 'ken-btn--red'} stock-submit"
        data-action="stock-order-submit"
        data-testid="stock-order-submit"
        data-focus-key="stock-order-submit"
        ${validation.valid ? '' : 'disabled'}
        title="${esc(hint)}"
      >${side === 'buy' ? '买入' : '卖出'} ${validation.shares > 0 ? num(validation.shares) : ''} 股</button>
      <p class="stock-order-hint ${validation.valid ? '' : 'is-warn'}" data-testid="stock-order-hint">${esc(hint)}</p>
      <div class="stock-order-status ${orderNote ? 'is-visible' : ''}" data-testid="stock-order-status" aria-live="polite">${orderNote ? esc(orderNote) : '提交后在此显示委托/成交/失败状态。'}</div>
    </section>`;
}

function renderOrders(detail: StockDetailView): string {
  const orders = detail.playerOrders as StockOrderView[];
  return `
    <section class="stock-orders" data-testid="stock-orders">
      <div class="gov-sub-head"><span>我的未成交委托</span><em>${orders.length} 条</em></div>
      ${
        orders.length === 0
          ? '<p class="fin-hint">暂无未成交委托；下单后未成交部分会显示在这里。</p>'
          : `<ul class="stock-order-list">${orders
              .map(
                (order) => `
                <li class="stock-order-item">
                  <span class="stock-order-side ${order.side === 'buy' ? 'is-buy' : 'is-sell'}">${order.side === 'buy' ? '买入' : '卖出'}</span>
                  <span class="stock-order-main">${num(order.shares)} 股 · 限价 ${num(order.limitPrice, 2)}</span>
                  <em>${esc(tickDate(order.createdTick))}</em>
                  <button
                    type="button"
                    class="chip-btn"
                    data-action="stock-cancel-order"
                    data-order-id="${esc(order.id)}"
                    data-focus-key="stock-cancel-${esc(order.id)}"
                    title="撤销该未成交委托；不改变现金与持股"
                  >撤单</button>
                </li>`,
              )
              .join('')}</ul>`
      }
    </section>`;
}

/**
 * 渲染整块股票窗口。rect 由 GameUI 持有（拖动/缩放只改 UI 状态，不写 store）。
 */
export function renderStockWindow(view: StockMarketView, options: StockWindowOptions = {}): string {
  const rect = options.rect ?? { left: 40, top: 40, width: 1200, height: 760 };
  const detail = view.selected;
  const rows = view.rows as StockListRow[];
  const selectedId = detail?.company.id ?? null;
  const draft = options.draft;
  return `
    <div
      class="stock-window"
      data-testid="stock-window"
      role="dialog"
      aria-label="股票市场"
      aria-modal="false"
      data-kind="${view.kind}"
      style="left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px"
    >
      <header class="stock-titlebar" data-stock-drag="1">
        <div class="stock-title">
          <span class="kicker">STOCK MARKET</span>
          <b>股票市场</b>
          <em>${view.kind === 'voting' ? '有投票权股份' : '仅分红股份'}</em>
        </div>
        <div class="stock-title-meta">
          <span class="stock-month" data-testid="stock-window-month">${esc(options.monthLabel ?? tickDate(0))}</span>
          <span class="stock-open-note" title="股票窗口是查看工具，不改变模拟暂停状态">窗口打开不暂停模拟</span>
          <span class="stock-title-actions" role="group" aria-label="时间控制">
            <button type="button" class="chip-btn" data-action="tick" data-focus-key="stock-tick" title="推进 1 个月；与 HUD 的推进按钮作用相同">推进 1 月</button>
            <button type="button" class="chip-btn" data-action="toggle-auto" data-focus-key="stock-toggle-auto" title="开始/暂停自动推进；与 HUD 的开关作用相同">${options.autoRunning ? '暂停' : '继续'}</button>
          </span>
        </div>
        <button
          type="button"
          class="icon-btn stock-close"
          data-action="close-stock-market"
          data-testid="stock-close"
          data-focus-key="stock-close"
          aria-label="关闭股票市场窗口"
          title="关闭（Esc）"
        >×</button>
      </header>
      <div class="stock-body">
        <aside class="stock-list" data-testid="stock-list">
          <div class="stock-list-tools">
            <input
              type="search"
              class="stock-search"
              data-stock-search
              data-focus-key="stock-search"
              value="${esc(view.search)}"
              placeholder="搜索企业 / 城市 / 行业"
              aria-label="搜索股票"
            >
            <div class="stock-filter-row">
              <select data-stock-filter="city" aria-label="城市筛选" data-testid="stock-city-filter">
                <option value="">全部城市</option>
                ${view.cities
                  .map(
                    (city) =>
                      `<option value="${esc(city.id)}" ${view.cityFilter === city.id ? 'selected' : ''}>${esc(city.name)}</option>`,
                  )
                  .join('')}
              </select>
              <select data-stock-filter="industry" aria-label="行业筛选" data-testid="stock-industry-filter">
                <option value="">全部行业</option>
                ${view.industries
                  .map(
                    (industry) =>
                      `<option value="${esc(industry)}" ${view.industryFilter === industry ? 'selected' : ''}>${esc(industry)}</option>`,
                  )
                  .join('')}
              </select>
            </div>
            <div class="stock-view-switch" role="group" aria-label="列表范围" data-testid="stock-view-switch">
              <button
                type="button"
                class="chip-btn ${view.view === 'all' ? 'is-selected' : ''}"
                data-action="stock-view"
                data-view="all"
                data-focus-key="stock-view-all"
                aria-pressed="${view.view === 'all'}"
              >全部</button>
              <button
                type="button"
                class="chip-btn ${view.view === 'holdings' ? 'is-selected' : ''}"
                data-action="stock-view"
                data-view="holdings"
                data-focus-key="stock-view-holdings"
                aria-pressed="${view.view === 'holdings'}"
              >我的持仓</button>
            </div>
          </div>
          <div class="stock-rows" data-scroll="stock-list" data-testid="stock-rows">
            ${
              rows.length === 0
                ? `<div class="empty-state compact stock-list-empty">
                    <span class="empty-mark" aria-hidden="true">◫</span>
                    <p>${view.view === 'holdings' ? '我的持仓：暂无持股' : '暂无符合条件的企业'}</p>
                    <small>${view.view === 'holdings' ? '买入后会出现在这里；也可切换「全部」。' : '试试清空搜索或城市/行业筛选。'}</small>
                  </div>`
                : rows.map((row) => renderRow(row, row.companyId === selectedId)).join('')
            }
          </div>
          <p class="stock-list-foot">共 ${num(rows.length)} 家 · ${view.kind === 'voting' ? '有投票权' : '仅分红'}股份</p>
        </aside>
        <section class="stock-market" data-testid="stock-market">
          ${renderMarketPanel(view)}
        </section>
        <aside class="stock-side" data-testid="stock-side">
          ${
            detail
              ? `<section class="stock-company" data-testid="stock-company-info">
                  <div class="gov-sub-head"><span>企业信息</span><em>${detail.exited ? '已退出' : esc(detail.company.cityName)}</em></div>
                  <div class="stock-kv"><span>行业</span><b>${esc(detail.company.industry)}</b></div>
                  <div class="stock-kv"><span>已发行</span><b>${num(detail.issuedShares)} 股</b></div>
                  <div class="stock-kv"><span>员工 / 产能</span><b>${num(detail.company.employees)} / ${num(detail.company.capacity)}</b></div>
                  <p class="fin-hint">${esc(detail.company.note)}</p>
                </section>
                <section class="stock-position" data-testid="stock-position">
                  <div class="gov-sub-head"><span>我的持股</span><em>${pct(detail.playerStake, 2)}</em></div>
                  <div class="stock-kv"><span>持股</span><b>${num(detail.playerShares)} 股</b></div>
                  <div class="stock-kv"><span>可投资现金</span><b>${money(detail.playerCash)}</b></div>
                </section>
                ${detail.exited
                  ? `<section class="stock-exited-panel" data-testid="stock-exited-panel">
                      <div class="gov-sub-head"><span>交易</span><em>已停止</em></div>
                      <p class="fin-hint">该企业已退出市场，股份类别已注销：不能下单、买入或卖出，也不能恢复已注销股份。历史行情仅用于查阅。</p>
                    </section>`
                  : `${renderOrderForm(detail, draft, options.orderNote)}
                ${renderOrders(detail)}`}`
              : `<div class="empty-state compact"><span class="empty-mark" aria-hidden="true">◫</span><p>未选中企业</p><small>在左侧列表选择一家企业后可查看持仓与下单。</small></div>`
          }
        </aside>
      </div>
      <footer class="stock-foot">
        <span>${esc(view.note)}</span>
        <span class="stock-foot-note">打开窗口不改变暂停状态；Esc 关闭。</span>
      </footer>
      <div class="stock-resize" data-stock-resize="1" title="拖动缩放（最小 900 × 560）"></div>
    </div>`;
}
