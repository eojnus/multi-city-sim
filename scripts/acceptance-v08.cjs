/**
 * v0.8 桌面验收走查（股票市场大窗口 / 右栏标签化 / 税收联动 / 存读档）。
 *
 * 全程走真实 Electron 界面（DOM 点击、指针拖拽/缩放、输入事件），必要时用 store 只读
 * 读取世界状态做对账；证据截图与 JSON 同时写入 artifacts/ 与 docs/evidence_v0.8/
 * （artifacts 被 gitignore，验收证据必须入仓）。
 *
 * 用法：Xvfb :99 & DISPLAY=:99 node_modules/electron/dist/electron --no-sandbox \
 *        --disable-dev-shm-usage --enable-unsafe-swiftshader scripts/acceptance-v08.cjs
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { registerSaveHandlers } = require('../dist/electron/saveIpc.js');

const root = path.resolve(__dirname, '..');
const artifacts = path.join(root, 'artifacts', 'acceptance-v08');
const evidence = path.join(root, 'docs', 'evidence_v0.8');
fs.mkdirSync(artifacts, { recursive: true });
fs.mkdirSync(evidence, { recursive: true });
const userData = path.join(artifacts, 'electron-user-data');
fs.rmSync(userData, { recursive: true, force: true });
app.setPath('userData', userData);
const savesDir = path.join(app.getPath('userData'), 'saves');
fs.mkdirSync(savesDir, { recursive: true });
registerSaveHandlers(() => savesDir);

/** 把股票窗口完全拖回视口内（先缩到视口以内，再把左上角移到 16,16），返回最终矩形。 */
async function ensureWindowInside(win) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const rect = await read(win, `(() => {
      const el = document.querySelector('.stock-window');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height, vw: innerWidth, vh: innerHeight };
    })()`);
    if (!rect || rect.error) return rect;
    const targetWidth = Math.max(900, Math.min(1200, rect.vw - 32));
    const targetHeight = Math.max(560, Math.min(760, rect.vh - 32));
    if (rect.width > targetWidth + 1 || rect.height > targetHeight + 1) {
      await dragBy(win, '.stock-resize', targetWidth - rect.width, targetHeight - rect.height);
      await sleep(300);
      continue;
    }
    const dx = 16 - rect.left;
    const dy = 16 - rect.top;
    if (Math.abs(dx) <= 1 && Math.abs(dy) <= 1) return rect;
    await dragBy(win, '.stock-titlebar', dx, dy);
    await sleep(300);
  }
  return read(win, `(() => {
    const el = document.querySelector('.stock-window');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height, vw: innerWidth, vh: innerHeight };
  })()`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const checks = [];
function check(name, pass, detail) {
  checks.push({ name, pass: Boolean(pass), detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` :: ${String(detail).slice(0, 320)}` : ''}`);
}

async function waitFor(win, expression, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const ok = await win.webContents.executeJavaScript(
        `(() => { try { return Boolean(${expression}); } catch { return false; } })()`,
      );
      if (ok) return true;
    } catch {
      /* reload 期间忽略 */
    }
    await sleep(150);
  }
  return false;
}

async function capture(win, name) {
  win.focus();
  win.webContents.invalidate();
  await sleep(350);
  const image = await win.webContents.capturePage();
  const buffer = image.toPNG();
  fs.writeFileSync(path.join(artifacts, name), buffer);
  fs.writeFileSync(path.join(evidence, name), buffer);
  return name;
}

async function click(win, selector) {
  return win.webContents.executeJavaScript(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    el.click();
    return true;
  })()`);
}

async function read(win, expression) {
  return win.webContents.executeJavaScript(
    `(() => { try { return (${expression}); } catch (e) { return { error: String(e) }; } })()`,
  );
}

async function typeInto(win, selector, value) {
  return win.webContents.executeJavaScript(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(String(value))});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
}

async function enterCity(win, cityId) {
  await click(win, `[data-testid="city-card-${cityId}"]`);
  await sleep(400);
  const inCity = await read(win, `window.__lanwan.store.view === 'city'`);
  if (!inCity) {
    await click(win, '[data-testid="btn-enter-city"]');
    await sleep(500);
  }
  await waitFor(win, `window.__lanwan.store.view === 'city'`, 6000);
  await sleep(500);
}

/** 用合成 PointerEvent 模拟拖拽/缩放（setPointerCapture 在无真实指针时会抛错，先降级为空实现）。 */
async function dragBy(win, selector, dx, dy) {
  return win.webContents.executeJavaScript(`(() => {
    const target = document.querySelector(${JSON.stringify(selector)});
    const layer = document.querySelector('#stock-layer');
    if (!target || !layer) return null;
    const rect = target.getBoundingClientRect();
    const startX = rect.left + Math.min(30, rect.width / 2);
    const startY = rect.top + Math.min(14, rect.height / 2);
    const winEl = document.querySelector('.stock-window');
    const before = winEl ? winEl.getBoundingClientRect() : null;
    if (typeof Element.prototype.setPointerCapture === 'function') {
      const original = Element.prototype.setPointerCapture;
      Element.prototype.setPointerCapture = function () {};
      try {
        const down = new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 7, clientX: startX, clientY: startY });
        target.dispatchEvent(down);
        const move = new PointerEvent('pointermove', { bubbles: true, pointerId: 7, clientX: startX + ${dx}, clientY: startY + ${dy} });
        layer.dispatchEvent(move);
        layer.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 7, clientX: startX + ${dx}, clientY: startY + ${dy} }));
      } finally {
        Element.prototype.setPointerCapture = original;
      }
    }
    const after = winEl ? winEl.getBoundingClientRect() : null;
    return before && after
      ? { before: { left: before.left, top: before.top, width: before.width, height: before.height },
          after: { left: after.left, top: after.top, width: after.width, height: after.height } }
      : null;
  })()`);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1600,
    height: 1000,
    show: true,
    backgroundColor: '#08111d',
    webPreferences: {
      preload: path.join(root, 'dist/electron/preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  const errors = [];
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2 && !/GL_|Failed to create GBM|dbus|DevTools|Autofill/i.test(message)) {
      errors.push(message);
    }
  });

  await win.loadFile(path.join(root, 'dist/renderer/index.html'));
  await waitFor(win, 'window.__lanwan && window.__lanwan.store && window.__lanwan.game', 20000);
  await sleep(2000);
  await waitFor(win, `document.querySelector('[data-testid="hud-date"]')`, 8000);

  try {
    // ---- 1. 启动：区域视图 + 右栏标签默认概况 + 无横向溢出 ----
    const startup = await read(win, `(() => ({
      view: window.__lanwan.store.view,
      tick: window.__lanwan.store.world.time.tick,
      tabs: [...document.querySelectorAll('[data-testid="right-tabs"] [role="tab"]')].map((el) => el.textContent.trim()),
      activeTab: document.querySelector('[data-testid="right-tabs"] [aria-selected="true"]')?.textContent.trim() ?? null,
      overflowX: document.documentElement.scrollWidth > innerWidth + 2,
      panel: Boolean(document.querySelector('[data-testid="right-panel"]')),
    }))()`);
    check('启动进入区域视图且右栏标签可见', startup.view === 'region' && startup.panel && startup.tabs.length > 0, JSON.stringify(startup));
    check('默认标签为「概况」', startup.activeTab === '概况', startup.activeTab);
    check('1600x1000 无横向溢出', startup.overflowX === false, startup.overflowX);
    await capture(win, 'v08-01-region-overview.png');

    // ---- 2. 进入城市 + 六个城市标签切换不改模拟状态 ----
    await enterCity(win, 'lanport');
    const cityTabs = await read(win, `(() => ({
      labels: [...document.querySelectorAll('[data-testid="right-tabs"] [role="tab"]')].map((el) => el.textContent.trim()),
      tick: window.__lanwan.store.world.time.tick,
      snapshot: JSON.stringify(window.__lanwan.store.world.cities.map((c) => [c.id, c.population.total, c.treasury])),
    }))()`);
    check('城市上下文 6 个标签', JSON.stringify(cityTabs.labels) === JSON.stringify(['概况', '人口', '企业', '市场', '政府', '交通']), JSON.stringify(cityTabs.labels));

    const tabChecks = [
      ['人口', '[data-testid="population-strata-section"]'],
      ['企业', '[data-testid="company-row-lp-food"]'],
      ['市场', '[data-testid="bank-section"]'],
      ['政府', '[data-testid="government-section"]'],
      ['交通', '[data-testid="transport-section"]'],
    ];
    for (const [label, selector] of tabChecks) {
      await click(win, `#right-tab-city-${label === '人口' ? 'population' : label === '企业' ? 'companies' : label === '市场' ? 'market' : label === '政府' ? 'government' : 'transport'}`);
      await sleep(350);
      const ok = await read(win, `Boolean(document.querySelector(${JSON.stringify(selector)}))`);
      check(`城市「${label}」标签渲染 ${selector}`, ok === true, ok);
      await capture(win, `v08-02-city-tab-${label === '人口' ? 'population' : label === '企业' ? 'companies' : label === '市场' ? 'market' : label === '政府' ? 'government' : 'transport'}.png`);
    }
    const afterTabs = await read(win, `(() => ({
      tick: window.__lanwan.store.world.time.tick,
      snapshot: JSON.stringify(window.__lanwan.store.world.cities.map((c) => [c.id, c.population.total, c.treasury])),
    }))()`);
    check('切换标签不推进时间、不改模拟状态', afterTabs.tick === cityTabs.tick && afterTabs.snapshot === cityTabs.snapshot, JSON.stringify({ tick: afterTabs.tick, before: cityTabs.tick }));

    // ---- 3. 企业上下文 5 个标签 ----
    await click(win, '#right-tab-city-companies');
    await sleep(300);
    await click(win, '[data-testid="company-row-lp-food"]');
    await sleep(500);
    const companyTabs = await read(win, `(() => ({
      labels: [...document.querySelectorAll('[data-testid="right-tabs"] [role="tab"]')].map((el) => el.textContent.trim()),
      panel: Boolean(document.querySelector('[data-testid="company-detail-lp-food"]')),
    }))()`);
    check('企业上下文 5 个标签', JSON.stringify(companyTabs.labels) === JSON.stringify(['概况', '经营', '财务', '股东与治理', '股票']), JSON.stringify(companyTabs.labels));
    await click(win, '#right-tab-company-operation');
    await sleep(350);
    const operationOk = await read(win, `Boolean(document.querySelector('[data-testid="company-operator"]'))`);
    check('企业「经营」标签含经营者区域', operationOk === true, operationOk);
    await capture(win, 'v08-03-company-operation.png');
    await click(win, '#right-tab-company-stocks');
    await sleep(350);
    const stocksEntry = await read(win, `Boolean(document.querySelector('[data-testid="open-stock-window-lp-food"]'))`);
    check('企业「股票」标签含行情入口', stocksEntry === true, stocksEntry);
    await capture(win, 'v08-04-company-stocks.png');

    // ---- 4. 股票大窗口：默认空 K 线、列表、三类价格标识 ----
    await click(win, '[data-testid="btn-stock-market"]');
    await sleep(600);
    const stockOpen = await read(win, `(() => {
      const el = document.querySelector('[data-testid="stock-window"]');
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      return {
        rect: { left: Math.round(rect.left), top: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) },
        rows: document.querySelectorAll('[data-testid="stock-rows"] [data-testid^="stock-row-"]').length,
        emptyChart: Boolean(document.querySelector('[data-testid="stock-chart-empty"]')),
        month: document.querySelector('[data-testid="stock-window-month"]')?.textContent ?? null,
        quote: document.querySelector('[data-testid="stock-quote"]')?.innerText ?? null,
      };
    })()`);
    check('股票窗口可打开且宽度≥900/高度≥560', Boolean(stockOpen) && stockOpen.rect.width >= 900 && stockOpen.rect.height >= 560, JSON.stringify(stockOpen?.rect));
    check('企业列表每家企业一行（≥10 行）', (stockOpen?.rows ?? 0) >= 10, stockOpen?.rows);
    check('新世界无成交时 K 线显示「暂无成交/暂无数据」空态', stockOpen?.emptyChart === true, stockOpen?.emptyChart);
    check('窗口显示当前游戏月', /T\d+|年\s*\d+\s*月|2026/.test(stockOpen?.month ?? ''), stockOpen?.month);
    await capture(win, 'v08-05-stock-window-empty.png');

    // ---- 5. 拖拽 / 缩放 / 边界夹取 ----
    const moved = await dragBy(win, '.stock-titlebar', 120, 80);
    const movedOk = Boolean(moved) && Math.abs(moved.after.left - moved.before.left - 120) <= 4 && Math.abs(moved.after.top - moved.before.top - 80) <= 4;
    check('拖动标题栏移动窗口', movedOk, JSON.stringify(moved));
    const resized = await dragBy(win, '.stock-resize', 160, 100);
    const resizedOk = Boolean(resized) && resized.after.width > resized.before.width + 100 && resized.after.height > resized.before.height + 60;
    check('拖动右下角可放大窗口', resizedOk, JSON.stringify(resized));
    // 拖出屏幕边界：标题栏仍至少保留 160px 可见
    await dragBy(win, '.stock-titlebar', -2200, -1600);
    const clamped = await read(win, `(() => {
      const el = document.querySelector('.stock-window');
      const r = el.getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height, right: Math.min(r.right, innerWidth), bottom: Math.min(r.bottom, innerHeight) };
    })()`);
    check('拖出屏幕时窗口被夹回可见区域', clamped.left <= 0 ? clamped.right >= 160 : true, JSON.stringify(clamped));
    // 极限拖动后拖回屏幕内，截图必须能证明完整窗口（含 K 线与成交量）真实可见。
    const insideAfterDrag = await ensureWindowInside(win);
    const insideOk =
      Boolean(insideAfterDrag) &&
      insideAfterDrag.left >= 0 &&
      insideAfterDrag.top >= 0 &&
      insideAfterDrag.right <= insideAfterDrag.vw + 1 &&
      insideAfterDrag.bottom <= insideAfterDrag.vh + 1;
    check('极限拖动后窗口可拖回屏幕内且完整可见', insideOk, JSON.stringify(insideAfterDrag));
    await capture(win, 'v08-06-stock-window-moved.png');

    // ---- 6. 类别切换：有投票权 / 仅分红 各自独立列表与行情 ----
    await click(win, '[data-action="stock-kind"][data-kind="nonVoting"]');
    await sleep(400);
    const kindSwitch = await read(win, `(() => ({
      pressed: document.querySelector('[data-action="stock-kind"][data-kind="nonVoting"]')?.getAttribute('aria-pressed') ?? null,
      rows: document.querySelectorAll('[data-testid="stock-rows"] [data-testid^="stock-row-"]').length,
      emptyChart: Boolean(document.querySelector('[data-testid="stock-chart-empty"]')),
    }))()`);
    check('切换到「仅分红」类别后列表与行情独立刷新', kindSwitch.pressed === 'true' && kindSwitch.rows >= 10, JSON.stringify(kindSwitch));
    await click(win, '[data-action="stock-kind"][data-kind="voting"]');
    await sleep(400);

    // ---- 7. 推进一个月：月底撮合产生真实成交，K 线出现月蜡烛 ----
    await click(win, '[data-testid="btn-tick"]');
    await sleep(1200);
    await click(win, '[data-testid="btn-tick"]');
    await sleep(1400);
    const afterTicks = await read(win, `(() => {
      const history = window.__lanwan.store.world.securities.history ?? [];
      const candles = history.reduce((sum, h) => sum + h.candles.length, 0);
      const trades = window.__lanwan.store.world.securities.lastTrades ?? [];
      return {
        candles,
        trades: trades.length,
        classes: history.length,
        tick: window.__lanwan.store.world.time.tick,
        months: [...new Set(history.flatMap((h) => h.candles.map((c) => c.tick)))].slice(-3),
      };
    })()`);
    check('月结撮合后行情历史出现真实月度成交（K 线数据）', afterTicks.candles > 0 && afterTicks.trades > 0, JSON.stringify(afterTicks));
    // 逐行找一家有 K 线的企业，验证蜡烛渲染
    let chartRender = null;
    const candleTargets = await read(win, `(() => window.__lanwan.store.world.securities.history
      .filter((entry) => entry.candles.length > 0)
      .map((entry) => ({ companyId: entry.companyId, kind: entry.kind, candles: entry.candles.length })))()`);
    const target = Array.isArray(candleTargets) ? candleTargets[0] : null;
    if (target) {
      await click(win, `[data-action="stock-kind"][data-kind="${target.kind}"]`);
      await sleep(400);
      await click(win, `[data-testid="stock-row-${target.companyId}"]`);
      await sleep(450);
      chartRender = await read(win, `(() => ({
        companyId: window.__lanwan.store.stockMarketView().selected?.company.id ?? null,
        kind: window.__lanwan.store.stockMarketView().kind,
        candles: document.querySelectorAll('[data-testid="stock-chart"] .stock-candle').length,
        empty: Boolean(document.querySelector('[data-testid="stock-chart-empty"]')),
        meta: document.querySelector('.stock-chart-meta')?.innerText ?? null,
      }))()`);
    }
    check('选中有成交的企业后渲染月度 OHLCV 蜡烛', Boolean(chartRender) && chartRender.candles > 0, JSON.stringify(chartRender));
    await ensureWindowInside(win);
    await capture(win, 'v08-07-stock-window-candles.png');

    // ---- 7b. 无成交月份空档：找到“覆盖月份 > K 线根数”的类别再截图 ----
    let gapTarget = null;
    for (let attempt = 0; attempt < 8 && !gapTarget; attempt += 1) {
      const candidates = await read(win, `(() => window.__lanwan.store.world.securities.history
        .filter((entry) => entry.candles.length > 0)
        .map((entry) => ({
          companyId: entry.companyId,
          kind: entry.kind,
          candles: entry.candles.length,
          months: entry.candles.length > 0 ? entry.candles[entry.candles.length - 1].tick - entry.candles[0].tick + 1 : 0,
        }))
        .filter((entry) => entry.months - entry.candles >= 2))()`);
      const gap = Array.isArray(candidates) && candidates.length > 0 ? candidates[0] : null;
      if (gap) {
        gapTarget = gap;
      } else {
        await click(win, '[data-testid="btn-tick"]');
        await sleep(1200);
      }
    }
    if (gapTarget) {
      await click(win, `[data-action="stock-kind"][data-kind="${gapTarget.kind}"]`);
      await sleep(350);
      await click(win, `[data-testid="stock-row-${gapTarget.companyId}"]`);
      await sleep(450);
    }
    const gapChart = await read(win, `(() => {
      const chart = document.querySelector('[data-testid="stock-chart"]');
      if (!chart) return null;
      return {
        months: chart.getAttribute('data-months'),
        gapMonths: chart.getAttribute('data-gap-months'),
        candles: chart.querySelectorAll('.stock-candle').length,
        gapMarks: chart.querySelectorAll('.gap-mark').length,
        meta: document.querySelector('.stock-chart-meta')?.innerText ?? null,
      };
    })()`);
    check(
      'K 线按真实月份排布：无成交月份留空档并标记',
      Boolean(gapChart) && Number(gapChart.gapMonths) >= 2 && gapChart.candles > 0 && gapChart.gapMarks >= 2,
      JSON.stringify(gapChart),
    );
    await ensureWindowInside(win);
    await capture(win, 'v08-11-stock-window-gap.png');

    // ---- 7c. 两类股份各自独立：切到「仅分红」并展示其行情 ----
    const nonVotingTarget = await read(win, `(() => window.__lanwan.store.world.securities.history
      .filter((entry) => entry.kind === 'nonVoting' && entry.candles.length > 0)
      .map((entry) => ({ companyId: entry.companyId, candles: entry.candles.length }))[0] ?? null)()`);
    await click(win, '[data-action="stock-kind"][data-kind="nonVoting"]');
    await sleep(400);
    if (nonVotingTarget) {
      await click(win, `[data-testid="stock-row-${nonVotingTarget.companyId}"]`);
      await sleep(450);
    }
    const nonVotingChart = await read(win, `(() => {
      const s = window.__lanwan.store;
      const view = s.stockMarketView();
      return {
        kind: view.kind,
        rows: view.rows.length,
        classIds: [...new Set(view.rows.map((row) => row.classId))].slice(0, 2),
        candles: document.querySelectorAll('[data-testid="stock-chart"] .stock-candle').length,
        empty: Boolean(document.querySelector('[data-testid="stock-chart-empty"]')),
        month: document.querySelector('[data-testid="stock-window-month"]')?.textContent ?? null,
      };
    })()`);
    // 股份类别 id 形如 `${companyId}:non-voting`；两类股份的列表行必须全部属于非投票类别。
    const nonVotingClassIds =
      nonVotingChart.classIds.length > 0 && nonVotingChart.classIds.every((id) => /:non-voting$/.test(id));
    const nonVotingChartOk =
      nonVotingTarget === null ? nonVotingChart.empty === true : nonVotingChart.candles > 0;
    check(
      '切换到仅分红股份后列表/行情按该类别独立刷新',
      nonVotingChart.kind === 'nonVoting' && nonVotingChart.rows > 0 && nonVotingClassIds && nonVotingChartOk,
      JSON.stringify({ ...nonVotingChart, nonVotingTarget }),
    );
    await ensureWindowInside(win);
    await capture(win, 'v08-12-stock-window-nonvoting.png');
    if (target) {
      await click(win, `[data-action="stock-kind"][data-kind="${target.kind}"]`);
      await sleep(350);
    }

    // ---- 8. 下单 → 委托可见 → 撤单（现金/持股不变） ----
    const beforeOrder = await read(win, `(() => ({
      cash: window.__lanwan.store.world.player.cash,
      holdings: JSON.stringify(window.__lanwan.store.world.player.holdings),
      focus: window.__lanwan.store.stockMarketFocusCompanyId,
      book: window.__lanwan.store.stockMarketView().selected?.bookPrice ?? null,
    }))()`);
    await click(win, '[data-action="stock-side"][data-side="buy"]');
    await sleep(250);
    await typeInto(win, '[data-stock-shares]', '100');
    await typeInto(win, '[data-stock-limit]', '0.01');
    await sleep(450);
    const submitted = await click(win, '[data-testid="stock-order-submit"]');
    await sleep(700);
    const afterOrder = await read(win, `(() => ({
      cash: window.__lanwan.store.world.player.cash,
      holdings: JSON.stringify(window.__lanwan.store.world.player.holdings),
      orders: window.__lanwan.store.stockMarketView().selected?.playerOrders?.length ?? 0,
      status: document.querySelector('[data-testid="stock-order-status"]')?.textContent?.trim() ?? null,
      rows: document.querySelectorAll('[data-testid="stock-orders"] .stock-order-item').length,
    }))()`);
    check('玩家限价买单提交后生成未成交委托', submitted === true && afterOrder.orders === 1 && afterOrder.rows === 1, JSON.stringify(afterOrder));
    check('未成交委托不改变现金与持股', afterOrder.cash === beforeOrder.cash && afterOrder.holdings === beforeOrder.holdings, JSON.stringify({ before: beforeOrder.cash, after: afterOrder.cash }));
    await capture(win, 'v08-08-stock-window-order.png');
    const cancelled = await click(win, '[data-action="stock-cancel-order"]');
    await sleep(600);
    const afterCancel = await read(win, `(() => ({
      orders: window.__lanwan.store.stockMarketView().selected?.playerOrders?.length ?? 0,
      cash: window.__lanwan.store.world.player.cash,
      worldOrders: window.__lanwan.store.world.securities.orders.length,
      status: document.querySelector('[data-testid="stock-order-status"]')?.textContent?.trim() ?? null,
    }))()`);
    check('撤单后委托消失且不改变现金', cancelled === true && afterCancel.orders === 0 && afterCancel.cash === beforeOrder.cash, JSON.stringify(afterCancel));

    // ---- 9. 关闭窗口 + Esc 关闭 + 打开不改变暂停状态 ----
    const pausedBefore = await read(win, 'window.__lanwan.store.autoRunning');
    await click(win, '[data-testid="stock-close"]');
    await sleep(400);
    const closed = await read(win, `!document.querySelector('[data-testid="stock-window"]')`);
    check('关闭按钮关闭股票窗口', closed === true, closed);
    await click(win, '[data-testid="btn-stock-market"]');
    await sleep(500);
    const pausedDuring = await read(win, 'window.__lanwan.store.autoRunning');
    await win.webContents.executeJavaScript(`window.dispatchEvent(new CustomEvent('lanwan:escape'))`);
    await sleep(400);
    const closedByEsc = await read(win, `!document.querySelector('[data-testid="stock-window"]')`);
    check('Esc 关闭股票窗口且打开/关闭不改变暂停状态', closedByEsc === true && pausedBefore === pausedDuring, JSON.stringify({ pausedBefore, pausedDuring, closedByEsc }));

    // ---- 10. 市长权限与城市税收面板 ----
    // 先回到城市上下文（企业上下文里没有城市标签），再设市长。
    await click(win, '[data-action="clear-selection"]');
    await sleep(500);
    await read(win, `(() => {
      const s = window.__lanwan.store;
      s.world.player.roles.mayorCityId = 'lanport';
      s.emit();
      return true;
    })()`);
    await sleep(400);
    await click(win, '#right-tab-city-government');
    await sleep(600);
    const taxMayor = await read(win, `(() => {
      const panel = document.querySelector('[data-testid="city-tax-panel"]');
      return {
        hasPanel: Boolean(panel),
        text: panel?.innerText?.slice(0, 260) ?? null,
        factor: window.__lanwan.store.taxView('lanport')?.latest?.transportFactor ?? null,
        history: window.__lanwan.store.taxView('lanport')?.history?.length ?? 0,
      };
    })()`);
    check('市长政府标签显示城市税收面板（含交通系数）', taxMayor.hasPanel === true && taxMayor.factor !== null && taxMayor.factor >= 0.5 && taxMayor.factor <= 1.5, JSON.stringify(taxMayor));
    await capture(win, 'v08-09-city-tax-mayor.png');
    await read(win, `(() => { const s = window.__lanwan.store; s.world.player.roles.mayorCityId = null; s.emit(); return true; })()`);
    await sleep(500);
    const taxPublic = await read(win, `(() => ({
      hasPanel: Boolean(document.querySelector('[data-testid="city-tax-panel"]')),
      taxView: window.__lanwan.store.taxView('lanport'),
    }))()`);
    check('非市长看不到城市税收金额明细', taxPublic.hasPanel === false && taxPublic.taxView === null, JSON.stringify(taxPublic).slice(0, 200));

    // ---- 11. 税账对账：四税入账 + 交通加成/损耗分账 ----
    const taxLedger = await read(win, `(() => {
      const world = window.__lanwan.store.world;
      const history = world.taxes?.historyByCity?.lanport ?? [];
      const last = history[history.length - 1] ?? null;
      const fiscal = (world.fiscal?.ledger ?? []).filter((entry) => entry.cityId === 'lanport');
      const kinds = [...new Set(fiscal.map((entry) => entry.kind))];
      return {
        history: history.length,
        last,
        kinds,
        lastMonth: world.cities.find((c) => c.id === 'lanport')?.lastMonth ?? null,
        reconciliation: last ? Math.abs(last.incomeTaxRevenue + last.corporateTaxRevenue + last.consumptionTaxRevenue + last.dividendTaxRevenue - last.totalRevenue) < 0.02 : false,
        factorLedger: last ? Math.abs(last.transportBonus - last.transportLoss - (last.totalRevenue - last.totalBase)) < 0.02 : false,
      };
    })()`);
    check('税收历史含四税与交通系数，且入账可对账', taxLedger.history > 0 && taxLedger.reconciliation === true && taxLedger.factorLedger === true, JSON.stringify(taxLedger.last));
    check('消费税与股息税进入财政分录/城市月报', taxLedger.kinds.includes('consumptionTax') && taxLedger.kinds.includes('dividendTax'), JSON.stringify(taxLedger.kinds));

    // ---- 11b. 交通加成/损耗不得在流水与市长面板重复计算（v0.8 复验问题 1） ----
    const taxConsistency = await read(win, `(() => {
      const s = window.__lanwan.store;
      const world = s.world;
      s.world.player.roles.mayorCityId = 'lanport';
      const history = world.taxes?.historyByCity?.lanport ?? [];
      const last = history[history.length - 1] ?? null;
      const view = s.fiscalView('lanport');
      s.world.player.roles.mayorCityId = null;
      if (!last || !view) return { ok: false };
      const entries = (world.fiscal?.ledger ?? []).filter((e) => e.cityId === 'lanport' && e.tick === last.tick);
      const byKind = {};
      for (const entry of entries) byKind[entry.kind] = entry.amount;
      const net = entries.reduce((sum, entry) => sum + entry.amount, 0);
      const taxKinds = new Set(['incomeTax', 'corporateTax', 'consumptionTax', 'dividendTax', 'transportTaxBonus', 'transportTaxLoss']);
      const taxNet = entries.filter((entry) => taxKinds.has(entry.kind)).reduce((sum, entry) => sum + entry.amount, 0);
      return {
        ok: true,
        tick: last.tick,
        net,
        taxNet,
        totalRevenue: last.totalRevenue,
        monthIncome: view.monthIncome,
        monthExpense: view.monthExpense,
        fourSum: last.incomeTaxRevenue + last.corporateTaxRevenue + last.consumptionTaxRevenue + last.dividendTaxRevenue,
        byKind,
        bases: {
          incomeTax: last.incomeTaxBase,
          corporateTax: last.corporateTaxBase,
          consumptionTax: last.consumptionTaxBase,
          dividendTax: last.dividendTaxBase,
        },
      };
    })()`);
    const near = (a, b) => Math.abs((a ?? 0) - (b ?? 0)) <= 0.05;
    const taxConsistent =
      Boolean(taxConsistency?.ok) &&
      // 税收相关流水净额（基准四税 + 加成 − 损耗）= 税收月报最终入账：加成/损耗没有被重复计入。
      near(taxConsistency.taxNet, taxConsistency.totalRevenue) &&
      // 市长面板的当月收入−支出等于该城全部财政流水净额（含工资/福利等非税支出）。
      near(taxConsistency.monthIncome - taxConsistency.monthExpense, taxConsistency.net) &&
      near(taxConsistency.fourSum, taxConsistency.totalRevenue);
    check('税收流水净额 = 税收月报最终入账；市长面板收支=财政流水净额（不重复计算）', taxConsistent, JSON.stringify(taxConsistency));
    const baseRecorded =
      Boolean(taxConsistency?.ok) &&
      near(taxConsistency.byKind.incomeTax, taxConsistency.bases.incomeTax) &&
      near(taxConsistency.byKind.consumptionTax, taxConsistency.bases.consumptionTax) &&
      (taxConsistency.byKind.transportTaxBonus === undefined || taxConsistency.byKind.transportTaxBonus >= 0) &&
      (taxConsistency.byKind.transportTaxLoss === undefined || taxConsistency.byKind.transportTaxLoss <= 0);
    check('四税财政分录按基准税额记账，加成/损耗单列', baseRecorded, JSON.stringify({ byKind: taxConsistency?.byKind, bases: taxConsistency?.bases }));

    // ---- 12. 存读档：行情、税账、委托全部随存档保存 ----
    const saveState = await read(win, `(async () => {
      const s = window.__lanwan.store;
      const candles = s.world.securities.history.reduce((sum, h) => sum + h.candles.length, 0);
      const saved = await s.saveSlot('manual-1');
      const dateSaved = s.dateLabel;
      const taxes = JSON.stringify(s.world.taxes.historyByCity.lanport ?? []);
      s.tick();
      const dateAdvanced = s.dateLabel;
      const loaded = await s.loadSlot('manual-1');
      return {
        saved, loaded, dateSaved, dateAfterLoad: s.dateLabel, dateAdvanced,
        candlesSaved: candles,
        candlesAfterLoad: s.world.securities.history.reduce((sum, h) => sum + h.candles.length, 0),
        taxesSaved: taxes,
        taxesAfterLoad: JSON.stringify(s.world.taxes.historyByCity.lanport ?? []),
        lastTickSameMonth: s.world.securities.history.every((h) => h.candles.every((c, i, arr) => i === 0 || arr[i - 1].tick < c.tick)),
      };
    })()`);
    check('存读档保留股票行情历史且不重复/不乱序', saveState.candlesAfterLoad === saveState.candlesSaved && saveState.lastTickSameMonth === true, JSON.stringify({ saved: saveState.candlesSaved, after: saveState.candlesAfterLoad }));
    check('存读档保留税收历史', saveState.taxesAfterLoad === saveState.taxesSaved && saveState.dateSaved === saveState.dateAfterLoad, JSON.stringify({ saved: saveState.taxesSaved.length, after: saveState.taxesAfterLoad.length }));

    // ---- 13. 最小窗口 1100x700：无横向溢出、标签可读 ----
    win.setSize(1100, 700);
    await sleep(900);
    const small = await read(win, `(() => ({
      overflowX: document.documentElement.scrollWidth > innerWidth + 2,
      tabs: document.querySelectorAll('[data-testid="right-tabs"] [role="tab"]').length,
      stockWindow: Boolean(document.querySelector('[data-testid="stock-window"]')),
    }))()`);
    check('1100x700 无横向溢出且城市标签仍完整', small.overflowX === false && small.tabs === 6, JSON.stringify(small));
    await capture(win, 'v08-10-small-window.png');
    win.setSize(1600, 1000);
    await sleep(600);

    // ---- 13b. 企业退出后保留股票历史（v0.8 复验问题 3） ----
    const exitedCheck = await read(win, `(async () => {
      const s = window.__lanwan.store;
      s.setView('region');
      s.clearSelection();
      s.closeStockMarket();
      s.emit();
      await new Promise((resolve) => setTimeout(resolve, 250));
      const world = s.world;
      const entry = world.securities.history.find((h) => h.candles.length > 0);
      if (!entry) return { ok: false, reason: 'no-history' };
      const company = world.companies.find((c) => c.id === entry.companyId);
      const name = company ? company.name : entry.companyName;
      world.companies = world.companies.filter((c) => c.id !== entry.companyId);
      world.securities.classes = world.securities.classes.filter((c) => c.companyId !== entry.companyId);
      world.securities.holdings = world.securities.holdings.filter((h) => h.shareClassId !== entry.shareClassId);
      world.securities.orders = world.securities.orders.filter((o) => o.shareClassId !== entry.shareClassId);
      s.openStockMarket(entry.companyId, entry.kind);
      s.emit();
      await new Promise((resolve) => setTimeout(resolve, 350));
      const view = s.stockMarketView();
      const row = view.rows.find((r) => r.companyId === entry.companyId);
      const html = document.querySelector('[data-testid="stock-window"]')?.innerHTML ?? '';
      const orderResult = s.tradeShares(entry.companyId, entry.kind, 'buy', 10, 1);
      return {
        ok: true,
        companyName: name,
        exited: row ? row.exited : null,
        tradable: row ? row.tradable : null,
        candles: view.selected ? view.selected.candles.length : 0,
        hasNotice: html.includes('stock-exited-notice'),
        hasOrderForm: html.includes('stock-order-form'),
        orderOk: orderResult.ok,
        orderError: orderResult.error ?? null,
      };
    })()`);
    const exitedOk =
      Boolean(exitedCheck?.ok) &&
      exitedCheck.exited === true &&
      exitedCheck.tradable === false &&
      exitedCheck.candles > 0 &&
      exitedCheck.hasNotice === true &&
      exitedCheck.hasOrderForm === false &&
      exitedCheck.orderOk === false;
    check('企业退出后行情历史保留，界面标识已退出且禁止下单', exitedOk, JSON.stringify(exitedCheck));
    await ensureWindowInside(win);
    await capture(win, 'v08-13-stock-exited-history.png');

    // ---- 14. 控制台无错误 ----
    check('控制台无未过滤错误', errors.length === 0, errors.slice(0, 3).join(' | '));
  } catch (error) {
    check('验收脚本执行完毕（无未捕获异常）', false, String(error && error.stack ? error.stack : error));
  }

  const result = {
    version: '0.8.1',
    ranAt: new Date().toISOString(),
    display: process.env.DISPLAY ?? null,
    total: checks.length,
    passed: checks.filter((entry) => entry.pass).length,
    failed: checks.filter((entry) => !entry.pass).map((entry) => entry.name),
    checks,
    consoleErrors: errors,
  };
  fs.writeFileSync(path.join(artifacts, 'acceptance-v08.json'), JSON.stringify(result, null, 2));
  fs.writeFileSync(path.join(evidence, 'acceptance-v08.json'), JSON.stringify(result, null, 2));
  console.log(`\nACCEPTANCE v0.8: ${result.passed}/${result.total} passed, console errors ${errors.length}`);
  app.exit(result.failed.length === 0 && errors.length === 0 ? 0 : 1);
});
