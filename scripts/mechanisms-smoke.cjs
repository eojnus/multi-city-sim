// 机制扩展专用桌面验收：
// - 人口环形图与悬停/键盘提示
// - 通知图标 → 可拖动/可关闭窗口
// - 企业股权、董事会、表决、二级交易入口
// - 政府牵头的跨城协议与市长演示身份
// - 存档往返、1100×700 无横向溢出
// 使用 artifacts/mechanisms-smoke-user-data 作为隔离数据目录，不触碰用户真实存档。
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { registerSaveHandlers } = require('../dist/electron/saveIpc.js');
const { verifySaveFile } = require('./save-format-check.cjs');

const root = path.resolve(__dirname, '..');
const artifacts = path.join(root, 'artifacts');
fs.mkdirSync(artifacts, { recursive: true });
const userData = path.join(artifacts, 'mechanisms-smoke-user-data');
fs.rmSync(userData, { recursive: true, force: true });
app.setPath('userData', userData);
const savesDir = path.join(app.getPath('userData'), 'saves');
fs.mkdirSync(savesDir, { recursive: true });
registerSaveHandlers(() => savesDir);

async function waitFor(win, expression, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ok = await win.webContents.executeJavaScript(
      `(() => { try { return Boolean(${expression}); } catch { return false; } })()`,
    );
    if (ok) return true;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return false;
}

async function click(win, selector, index = 0) {
  return win.webContents.executeJavaScript(`(() => {
    const list = [...document.querySelectorAll(${JSON.stringify(selector)})];
    const el = list[${index}];
    if (!el) return { ok: false, count: list.length };
    el.scrollIntoView({ block: 'center' });
    el.click();
    return { ok: true, count: list.length, text: (el.textContent || '').trim().slice(0, 80) };
  })()`);
}

async function read(win, expression) {
  return win.webContents.executeJavaScript(
    `(() => { try { return (${expression}); } catch (e) { return { error: String(e) }; } })()`,
  );
}

async function capture(win, name) {
  win.focus();
  win.webContents.invalidate();
  await new Promise((resolve) => setTimeout(resolve, 350));
  const image = await win.webContents.capturePage();
  fs.writeFileSync(path.join(artifacts, name), image.toPNG());
  return path.join(artifacts, name);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
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
    if (level >= 2) errors.push(message);
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    errors.push(`renderer gone: ${JSON.stringify(details)}`);
  });

  await win.loadFile(path.join(root, 'dist/renderer/index.html'));
  const ready = await waitFor(win, 'window.__lanwan && window.__lanwan.store');
  const uiReady = await waitFor(win, 'document.querySelector(\'[data-testid="hud-date"]\')', 8000);
  await new Promise((resolve) => setTimeout(resolve, 900));

  const result = { ready, uiReady };

  // ---- 通知：初始只有小图标，不自动展开 ----
  result.notifications = {
    toggle: await read(win, `Boolean(document.querySelector('[data-testid="notif-toggle"]'))`),
    windowHidden: await read(
      win,
      `(() => { const w = document.querySelector('[data-testid="notif-window"]'); return Boolean(w && w.hidden); })()`,
    ),
  };

  // ---- 人口饼图 ----
  await click(win, '[data-testid="btn-enter-city"]');
  await waitFor(win, `window.__lanwan.store.view === 'city'`);
  await new Promise((resolve) => setTimeout(resolve, 600));
  result.pie = {
    present: await waitFor(win, `document.querySelector('[data-testid="population-pie"]')`, 4000),
    segments: await read(
      win,
      `document.querySelectorAll('[data-testid="population-pie"] .pop-pie-seg').length`,
    ),
    center: await read(
      win,
      `(document.querySelector('[data-testid="population-pie"] .pop-pie-center')?.textContent || '').trim()`,
    ),
    legend: await read(
      win,
      `(document.querySelector('[data-testid="population-pie"] .pop-pie-legend')?.textContent || '').trim()`,
    ),
  };
  await read(
    win,
    `(() => {
      const seg = document.querySelector('[data-testid="population-pie"] .pop-pie-seg');
      if (!seg) return false;
      const r = seg.getBoundingClientRect();
      const opts = { bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
      seg.dispatchEvent(new PointerEvent('pointerover', opts));
      seg.dispatchEvent(new PointerEvent('pointermove', opts));
      seg.focus({ preventScroll: true });
      return true;
    })()`,
  );
  await new Promise((resolve) => setTimeout(resolve, 450));
  result.pie.tooltip = await read(
    win,
    `(() => { const tip = document.querySelector('[data-testid="population-pie"] .pop-pie-tip.is-on'); return tip ? tip.textContent.trim() : null; })()`,
  );
  if (!result.pie.tooltip) {
    // 兜底：直接读取扇区 aria-label 与图例，确保数据仍可见（不作为悬停验收通过）。
    result.pie.ariaLabels = await read(
      win,
      `[...document.querySelectorAll('[data-testid="population-pie"] .pop-pie-seg')].map(seg => seg.getAttribute('aria-label'))`,
    );
  }
  result.pie.hotSegments = await read(
    win,
    `document.querySelectorAll('[data-testid="population-pie"] .pop-pie-seg.is-hot').length`,
  );
  result.pie.screenshot = await capture(win, 'mechanisms-population-pie.png');

  // ---- 返回区域，打开企业详情 ----
  await click(win, '[data-testid="btn-back-region"]');
  await waitFor(win, `window.__lanwan.store.view === 'region'`);
  await new Promise((resolve) => setTimeout(resolve, 400));
  await click(win, '[data-testid="company-row-lp-food"]');
  await new Promise((resolve) => setTimeout(resolve, 500));
  result.company = {
    detail: await waitFor(win, `document.querySelector('[data-testid="company-detail-lp-food"]')`, 4000),
    holders: await read(win, `Boolean(document.querySelector('[data-testid="company-holders"]'))`),
    governance: await read(
      win,
      `Boolean(document.querySelector('[data-testid="company-governance"]'))`,
    ),
    motions: await read(win, `Boolean(document.querySelector('[data-testid="company-motions"]'))`),
    trading: await read(win, `Boolean(document.querySelector('[data-testid="company-trading"]'))`),
  };

  // 先推进两个月，让居民投资实体挂出可买股份。
  await click(win, '[data-testid="btn-tick"]');
  await new Promise((resolve) => setTimeout(resolve, 700));
  await click(win, '[data-testid="btn-tick"]');
  await new Promise((resolve) => setTimeout(resolve, 700));

  // 注资（一级融资）
  const cashBeforeInvest = await read(win, `window.__lanwan.store.world.player.cash`);
  await click(win, '[data-testid="company-invest-lp-food"]');
  await new Promise((resolve) => setTimeout(resolve, 600));
  const cashAfterInvest = await read(win, `window.__lanwan.store.world.player.cash`);
  result.invest = { cashBeforeInvest, cashAfterInvest };

  // 二级市场买入
  const sharesBefore = await read(
    win,
    `window.__lanwan.store.world.player.holdings.find(h => h.companyId === 'lp-food')?.shares ?? 0`,
  );
  const buyClicked = await click(
    win,
    '#company-panel [data-action="trade-shares"][data-side="buy"]',
  );
  await new Promise((resolve) => setTimeout(resolve, 700));
  result.trade = {
    buyClicked,
    sharesBefore,
    sharesAfter: await read(
      win,
      `window.__lanwan.store.world.player.holdings.find(h => h.companyId === 'lp-food')?.shares ?? 0`,
    ),
    openOrders: await read(win, `window.__lanwan.store.world.securities.orders.length`),
    lastTrades: await read(win, `window.__lanwan.store.world.securities.lastTrades.length`),
  };

  // 经营者议案 → 表决
  const proposeClicked = await click(
    win,
    '#company-panel [data-action="propose-operator"][data-operator="player"]',
  );
  await click(win, '[data-testid="btn-tick"]');
  await new Promise((resolve) => setTimeout(resolve, 800));
  const openMotions = await read(
    win,
    `window.__lanwan.store.world.governance.motions.filter(m => m.status === 'open').length`,
  );
  const voteClicked = await click(win, '#company-panel [data-action="vote-motion"][data-vote="for"]');
  await click(win, '[data-testid="btn-tick"]');
  await new Promise((resolve) => setTimeout(resolve, 700));
  await click(win, '[data-testid="btn-tick"]');
  await new Promise((resolve) => setTimeout(resolve, 800));
  result.governance = {
    proposeClicked,
    openMotions,
    voteClicked,
    passed: await read(
      win,
      `window.__lanwan.store.world.governance.motions.filter(m => m.status === 'passed').length`,
    ),
    operator: await read(
      win,
      `(() => { const c = window.__lanwan.store.world.governance.controls.find(e => e.companyId === 'lp-food'); return c && c.operator !== 'management' ? c.operator.id : String(c && c.operator); })()`,
    ),
  };

  // ---- 融资要约：玩家可接受/拒绝 ----
  const playerOffer = await read(
    win,
    `(() => { const o = window.__lanwan.store.world.securities.offers.find(x => x.status === 'open' && x.investor.type === 'player'); if (!o) return null; const c = window.__lanwan.store.world.companies.find(c => c.id === o.companyId); return { id: o.id, companyId: o.companyId, cityId: c ? c.cityId : null, amount: o.amount, kind: o.kind }; })()`,
  );
  result.financing = { offer: playerOffer };
  if (playerOffer && playerOffer.cityId) {
    await click(win, `[data-testid="city-card-${playerOffer.cityId}"]`);
    await new Promise((resolve) => setTimeout(resolve, 400));
    await click(win, `[data-testid="company-row-${playerOffer.companyId}"]`);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const cashBeforeOffer = await read(win, `window.__lanwan.store.world.player.cash`);
    const acceptClicked = await click(
      win,
      `[data-action="accept-offer"][data-offer-id="${playerOffer.id}"]`,
    );
    await new Promise((resolve) => setTimeout(resolve, 600));
    result.financing.acceptClicked = acceptClicked;
    result.financing.status = await read(
      win,
      `window.__lanwan.store.world.securities.offers.find(o => o.id === '${playerOffer.id}')?.status ?? null`,
    );
    result.financing.cashBefore = cashBeforeOffer;
    result.financing.cashAfter = await read(win, `window.__lanwan.store.world.player.cash`);
    result.financing.playerShares = await read(
      win,
      `window.__lanwan.store.world.player.holdings.find(h => h.companyId === '${playerOffer.companyId}')?.shares ?? 0`,
    );
  }

  // ---- 通知窗口：未读徽标、打开、拖动、关闭 ----
  result.notifications.unread = await read(
    win,
    `window.__lanwan.store.unreadNotificationCount`,
  );
  result.notifications.badgeVisible = await read(
    win,
    `(() => { const b = document.querySelector('[data-testid="notif-toggle"] .notif-badge'); return Boolean(b && !b.hidden); })()`,
  );
  await click(win, '[data-testid="notif-toggle"]');
  await new Promise((resolve) => setTimeout(resolve, 400));
  result.notifications.opened = await read(
    win,
    `(() => { const w = document.querySelector('[data-testid="notif-window"]'); return Boolean(w && !w.hidden); })()`,
  );
  result.notifications.items = await read(
    win,
    `document.querySelectorAll('[data-testid="notif-window"] .notif-item').length`,
  );
  result.notifications.kinds = await read(
    win,
    `window.__lanwan.store.notifications.map(n => n.kind)`,
  );
  result.notifications.audiences = await read(
    win,
    `window.__lanwan.store.notifications.map(n => n.audience)`,
  );
  const boxBefore = await read(
    win,
    `(() => { const w = document.querySelector('[data-testid="notif-window"]'); const r = w.getBoundingClientRect(); const h = document.querySelector('.notif-head').getBoundingClientRect(); return { left: r.left, top: r.top, hx: h.left + 40, hy: h.top + 12 }; })()`,
  );
  if (boxBefore && !boxBefore.error) {
    win.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(boxBefore.hx), y: Math.round(boxBefore.hy), button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(boxBefore.hx + 60), y: Math.round(boxBefore.hy + 40), button: 'left' });
    win.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(boxBefore.hx + 60), y: Math.round(boxBefore.hy + 40), button: 'left', clickCount: 1 });
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const boxAfter = await read(
    win,
    `(() => { const w = document.querySelector('[data-testid="notif-window"]'); const r = w.getBoundingClientRect(); return { left: r.left, top: r.top }; })()`,
  );
  result.notifications.drag = {
    before: boxBefore && !boxBefore.error ? { left: boxBefore.left, top: boxBefore.top } : null,
    after: boxAfter && !boxAfter.error ? boxAfter : null,
    moved:
      Boolean(boxBefore && !boxBefore.error && boxAfter && !boxAfter.error) &&
      (Math.abs(boxAfter.left - boxBefore.left) > 3 || Math.abs(boxAfter.top - boxBefore.top) > 3),
  };
  result.notifications.screenshot = await capture(win, 'mechanisms-notifications.png');
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  await new Promise((resolve) => setTimeout(resolve, 300));
  result.notifications.closed = await read(
    win,
    `(() => { const w = document.querySelector('[data-testid="notif-window"]'); return Boolean(w && w.hidden); })()`,
  );

  // ---- 政府牵头协议 + 市长演示 ----
  result.agreements = {
    section: await read(win, `Boolean(document.querySelector('[data-testid="agreements-section"]'))`),
  };
  const beforeAgreements = await read(win, `window.__lanwan.store.world.agreements.length`);
  const organizeClicked = await click(win, '[data-action="organize-agreement"]');
  await new Promise((resolve) => setTimeout(resolve, 700));
  result.agreements.organizeClicked = organizeClicked;
  result.agreements.before = beforeAgreements;
  result.agreements.after = await read(win, `window.__lanwan.store.world.agreements.length`);
  result.agreements.statuses = await read(
    win,
    `window.__lanwan.store.world.agreements.slice(-1).map(a => a.status)`,
  );
  result.agreements.participants = await read(
    win,
    `window.__lanwan.store.world.agreements.slice(-1).map(a => a.participants.map(p => ({ company: p.companyId, decision: p.decision })))`,
  );
  result.agreements.screenshot = await capture(win, 'mechanisms-agreements.png');

  const mayorClicked = await click(win, '[data-action="toggle-mayor-demo"]');
  await new Promise((resolve) => setTimeout(resolve, 400));
  result.mayorDemo = {
    clicked: mayorClicked,
    mayorCityId: await read(win, `window.__lanwan.store.world.player.roles.mayorCityId`),
    badge: await read(
      win,
      `(() => { const b = document.querySelector('.mayor-demo-badge'); return b ? b.textContent.trim() : null; })()`,
    ),
  };
  await click(win, '[data-action="toggle-mayor-demo"]');
  await new Promise((resolve) => setTimeout(resolve, 300));

  // ---- 存档往返 ----
  // 版本号一律来自本次实际写出的磁盘文件与 store 暴露的 saveFormatVersion，
  // 不在脚本里硬编码任何“预期版本”，否则会伪造验证结论。
  const roundTrip = await read(
    win,
    `(async () => {
      const s = window.__lanwan.store;
      const saved = await s.saveSlot('manual-1');
      const dateSaved = s.dateLabel;
      s.tick();
      const dateAdvanced = s.dateLabel;
      const loaded = await s.loadSlot('manual-1');
      return {
        saved,
        loaded,
        dateSaved,
        dateAdvanced,
        dateAfterLoad: s.dateLabel,
        storeFormatVersion: s.saveFormatVersion,
      };
    })()`,
  );
  const save = {
    saved: null,
    loaded: null,
    dateSaved: null,
    dateAdvanced: null,
    dateAfterLoad: null,
    datesRestored: null,
    storeFormatVersion: null,
    filePath: null,
    savesDirListing: [],
    fileBytes: null,
    fileFormatVersion: null,
    fileGameVersion: null,
    ok: false,
    error: null,
  };
  result.save = save;
  try {
    if (!roundTrip || roundTrip.error) {
      throw new Error(`渲染进程存档往返调用异常：${roundTrip?.error ?? '无返回'}`);
    }
    Object.assign(save, {
      saved: roundTrip.saved ?? null,
      loaded: roundTrip.loaded ?? null,
      dateSaved: roundTrip.dateSaved ?? null,
      dateAdvanced: roundTrip.dateAdvanced ?? null,
      dateAfterLoad: roundTrip.dateAfterLoad ?? null,
      storeFormatVersion: roundTrip.storeFormatVersion ?? null,
    });
    save.datesRestored =
      save.dateSaved !== null && save.dateAfterLoad !== null && save.dateSaved === save.dateAfterLoad;
    if (!save.saved) throw new Error('store.saveSlot("manual-1") 返回失败');
    if (!save.loaded) throw new Error('store.loadSlot("manual-1") 返回失败');
    // 唯一权威检查：读取本次实际写盘的存档文件，与游戏当前格式版本比对。
    const check = verifySaveFile({
      savesDir,
      slot: 'manual-1',
      storeFormatVersion: save.storeFormatVersion,
    });
    save.filePath = check.filePath;
    save.savesDirListing = check.listing;
    save.fileBytes = check.fileBytes;
    save.fileFormatVersion = check.fileFormatVersion;
    save.fileGameVersion = check.fileGameVersion;
    save.ok = check.ok;
    save.error = check.error;
  } catch (error) {
    save.ok = false;
    save.error = error instanceof Error ? error.message : String(error);
  }
  // ---- 1100×700 布局 ----
  win.setSize(1100, 700);
  await new Promise((resolve) => setTimeout(resolve, 900));
  result.layout = await read(
    win,
    `({ w: innerWidth, scrollW: document.documentElement.scrollWidth, overflowX: document.documentElement.scrollWidth > innerWidth + 2 })`,
  );
  result.systemLogHidden = await read(
    win,
    `!document.body.innerText.includes('月度结算完成') && !document.body.innerText.includes('不变量')`,
  );
  result.layoutScreenshot = await capture(win, 'mechanisms-small-window.png');

  result.screenshots = [
    result.pie.screenshot,
    result.notifications.screenshot,
    result.agreements.screenshot,
    result.layoutScreenshot,
  ];
  result.errors = errors;
  const exitCode = result.save.ok ? 0 : 1;
  if (exitCode) result.failures = [`存档往返校验失败：${result.save.error}`];
  console.log(JSON.stringify(result, null, 2));
  win.destroy();
  if (exitCode) {
    console.error(`存档往返校验失败：${result.save.error}`);
    // 明确以非零退出码结束，避免“打印了结果但静默通过”。
    process.exitCode = exitCode;
    app.exit(exitCode);
    return;
  }
  app.quit();
}).catch((error) => {
  console.error(error);
  app.exit(1);
});

app.on('window-all-closed', () => app.quit());
