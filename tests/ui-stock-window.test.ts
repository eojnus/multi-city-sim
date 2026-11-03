// 股票市场浮动大窗口回归：纯字符串渲染（不需要 jsdom）。
// 数据形状与 GameStore.stockMarketView() 契约一致；UI 不维护账本。

import { describe, expect, it } from 'vitest';
import type {
  StockCandleView,
  StockDetailView,
  StockListRow,
  StockMarketView,
} from '../src/app/gameStore';
import {
  STOCK_WINDOW_MIN_HEIGHT,
  STOCK_WINDOW_MIN_WIDTH,
  clampStockWindowRect,
  defaultStockWindowRect,
  renderStockWindow,
} from '../src/ui/stock-window';

function row(overrides: Partial<StockListRow> = {}): StockListRow {
  return {
    companyId: 'c1',
    companyName: '蓝港重工',
    cityId: 'lanport',
    cityName: '蓝港',
    industry: '制造业',
    kind: 'voting',
    classId: 'c1-voting',
    issuedShares: 1_000_000,
    lastPrice: 12.5,
    lastTradeTick: 24,
    bookPrice: 10,
    changePct: 3.2,
    playerShares: 1000,
    playerStake: 0.001,
    playerOpenOrders: 1,
    tradable: true,
    ...overrides,
  };
}

function detail(overrides: Partial<StockDetailView> = {}): StockDetailView {
  return {
    company: {
      id: 'c1',
      name: '蓝港重工',
      cityId: 'lanport',
      cityName: '蓝港',
      industry: '制造业',
      note: '区域内主要制造企业。',
      employees: 240,
      capacity: 300,
      utilization: 0.8,
    },
    kind: 'voting',
    classId: 'c1-voting',
    issuedShares: 1_000_000,
    lastPrice: 12.5,
    lastTradeTick: 24,
    bookPrice: 10,
    changePct: 3.2,
    candles: [],
    bestBid: 12.4,
    bestAsk: 12.6,
    playerShares: 1000,
    playerStake: 0.001,
    playerCash: 100_000,
    playerOrders: [],
    tradable: true,
    note: '行情来自真实成交。',
    ...overrides,
  };
}

function view(overrides: Partial<StockMarketView> = {}): StockMarketView {
  return {
    open: true,
    view: 'all',
    search: '',
    cityFilter: null,
    industryFilter: null,
    cities: [
      { id: 'lanport', name: '蓝港' },
      { id: 'lanhai', name: '蓝海' },
    ],
    industries: ['制造业', '服务业'],
    rows: [row(), row({ companyId: 'c2', companyName: '蓝海航运', cityId: 'lanhai', cityName: '蓝海' })],
    selected: detail(),
    kind: 'voting',
    note: '行情来自真实成交（玩家撮合与月度撮合）。',
    ...overrides,
  };
}

const rect = { left: 40, top: 40, width: 1280, height: 760 };

describe('股票大窗口：列表、空态与类别切换', () => {
  it('渲染三栏、企业行、选中企业与盘口，且窗口打开不暂停模拟', () => {
    const html = renderStockWindow(view(), { rect });
    expect(html).toContain('data-testid="stock-window"');
    expect(html).toContain('role="dialog"');
    expect(html).toContain('data-testid="stock-row-c1"');
    expect(html).toContain('data-testid="stock-row-c2"');
    expect(html).toContain('data-action="stock-focus"');
    expect(html).toContain('data-testid="stock-selected-name"');
    expect(html).toContain('蓝港重工');
    expect(html).toContain('data-testid="stock-quote"');
    expect(html).toContain('最近成交价');
    expect(html).toContain('账面参考价');
    expect(html).toContain('data-testid="stock-order-form"');
    expect(html).toContain('窗口打开不暂停模拟');
    // 列表有持仓/挂单标记。
    expect(html).toContain('持仓');
    expect(html).toContain('挂单');
  });

  it('列表为空时显示空态；我的持仓为空时显示持股空态；未选中企业时中间栏空态', () => {
    const empty = renderStockWindow(view({ rows: [], selected: null }), { rect });
    expect(empty).toContain('data-testid="stock-detail-empty"');
    expect(empty).toContain('暂无符合条件的企业');
    expect(empty).not.toContain('data-testid="stock-order-form"');

    const holdings = renderStockWindow(view({ view: 'holdings', rows: [], selected: null }), {
      rect,
    });
    expect(holdings).toContain('我的持仓：暂无持股');
  });

  it('类别切换展示当前类别，仅分红类别显示对应文案', () => {
    const voting = renderStockWindow(view(), { rect });
    expect(voting).toContain('data-kind="voting"');
    expect(voting).toContain('data-action="stock-kind"');

    const nonVoting = renderStockWindow(
      view({ kind: 'nonVoting', selected: detail({ kind: 'nonVoting' }) }),
      { rect },
    );
    expect(nonVoting).toContain('data-kind="nonVoting"');
    expect(nonVoting).toContain('仅分红');
  });
});

describe('股票大窗口：K 线', () => {
  it('无成交时显示「暂无成交 / 暂无数据」，不伪造 K 线', () => {
    const html = renderStockWindow(view(), { rect });
    expect(html).toContain('data-testid="stock-chart-empty"');
    expect(html).toContain('暂无成交 / 暂无数据');
    expect(html).not.toContain('data-testid="stock-chart"');
  });

  it('有成交时渲染月 K 线，包含上涨/下跌蜡烛', () => {
    const candles: StockCandleView[] = [
      { tick: 22, open: 10, high: 12, low: 9.5, close: 11.5, volume: 1000, trades: 4 },
      { tick: 23, open: 11.5, high: 13, low: 11, close: 11, volume: 800, trades: 3 },
    ];
    const html = renderStockWindow(view({ selected: detail({ candles }) }), { rect });
    expect(html).toContain('data-testid="stock-chart"');
    expect(html).toContain('is-up');
    expect(html).toContain('is-down');
    expect(html).toContain('共 2 根月 K');
  });
});

describe('股票大窗口：下单表单校验与委托撤单', () => {
  const submitDisabled = (html: string): boolean =>
    /data-testid="stock-order-submit"[\s\S]{0,160}?disabled/.test(html);

  it('空表单禁用提交并提示股数必须是正整数', () => {
    const html = renderStockWindow(view(), { rect });
    expect(submitDisabled(html)).toBe(true);
    expect(html).toContain('股数必须是正整数');
  });

  it('非法股数/限价禁用提交', () => {
    const zero = renderStockWindow(view(), {
      rect,
      draft: { side: 'buy', shares: '0', limitPrice: '12' },
    });
    expect(submitDisabled(zero)).toBe(true);
    expect(zero).toContain('股数必须是正整数');

    const badLimit = renderStockWindow(view(), {
      rect,
      draft: { side: 'buy', shares: '10', limitPrice: '0' },
    });
    expect(submitDisabled(badLimit)).toBe(true);
    expect(badLimit).toContain('限价必须大于 0');
  });

  it('买入超出可投资现金、卖出超出可卖股数时禁用并提示原因', () => {
    const buy = renderStockWindow(view({ selected: detail({ playerCash: 100 }) }), {
      rect,
      draft: { side: 'buy', shares: '100', limitPrice: '5' },
    });
    expect(submitDisabled(buy)).toBe(true);
    expect(buy).toContain('现金不足');

    const sell = renderStockWindow(view({ selected: detail({ playerShares: 10 }) }), {
      rect,
      draft: { side: 'sell', shares: '100', limitPrice: '5' },
    });
    expect(submitDisabled(sell)).toBe(true);
    expect(sell).toContain('可卖股数不足');
  });

  it('合法买单可提交，并显示预估金额与快捷数量', () => {
    const html = renderStockWindow(view(), {
      rect,
      draft: { side: 'buy', shares: '10', limitPrice: '5' },
    });
    expect(submitDisabled(html)).toBe(false);
    expect(html).toContain('data-action="stock-quick-shares"');
    expect(html).toContain('data-action="stock-order-submit"');
    expect(html).toContain('预估金额');
  });

  it('展示未成交委托与撤单按钮；提交结果写入状态区', () => {
    const html = renderStockWindow(
      view({
        selected: detail({
          playerOrders: [
            { id: 'o1', side: 'buy', shares: 100, limitPrice: 11, createdTick: 23 },
          ],
        }),
      }),
      { rect, orderNote: '订单已挂出，暂时没有对手方。' },
    );
    expect(html).toContain('data-testid="stock-orders"');
    expect(html).toContain('data-action="stock-cancel-order"');
    expect(html).toContain('data-order-id="o1"');
    expect(html).toContain('订单已挂出，暂时没有对手方。');
  });
});

describe('股票大窗口：位置与尺寸约束', () => {
  it('最小尺寸 900×560，标题栏不能完全拖出屏幕', () => {
    expect(STOCK_WINDOW_MIN_WIDTH).toBe(900);
    expect(STOCK_WINDOW_MIN_HEIGHT).toBe(560);

    const tiny = clampStockWindowRect({ left: 10, top: 10, width: 200, height: 100 }, {
      width: 1600,
      height: 900,
    });
    expect(tiny.width).toBe(STOCK_WINDOW_MIN_WIDTH);
    expect(tiny.height).toBe(STOCK_WINDOW_MIN_HEIGHT);
    expect(tiny.left).toBeGreaterThanOrEqual(0);
    expect(tiny.top).toBeGreaterThanOrEqual(0);

    // 向左/向上拖出屏幕：至少保留一段标题栏可抓取。
    const offscreen = clampStockWindowRect(
      { left: -5000, top: -5000, width: 1000, height: 600 },
      { width: 1600, height: 900 },
    );
    expect(offscreen.left).toBe(160 - 1000);
    expect(offscreen.top).toBe(0);

    // 向下拖出屏幕：标题栏仍可见。
    const below = clampStockWindowRect(
      { left: 100, top: 5000, width: 1000, height: 600 },
      { width: 1600, height: 900 },
    );
    expect(below.top).toBe(900 - 34 - 4);
  });

  it('默认窗口尺寸不小于最小尺寸且不超出视口', () => {
    const big = defaultStockWindowRect({ width: 1920, height: 1080 });
    expect(big.width).toBe(1200);
    expect(big.height).toBe(760);
    expect(big.left).toBeGreaterThanOrEqual(0);
    expect(big.top).toBeGreaterThanOrEqual(0);

    const small = defaultStockWindowRect({ width: 1000, height: 700 });
    expect(small.width).toBeGreaterThanOrEqual(STOCK_WINDOW_MIN_WIDTH);
    expect(small.height).toBeGreaterThanOrEqual(STOCK_WINDOW_MIN_HEIGHT);
    expect(small.width).toBeLessThanOrEqual(1000);
  });
});
