const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { registerSaveHandlers } = require('../dist/electron/saveIpc.js');

const root = path.resolve(__dirname, '..');
const artifacts = path.join(root, 'artifacts');
fs.mkdirSync(artifacts, { recursive: true });
const userData = path.join(artifacts, 'electron-user-data');
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
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

async function capture(win, name) {
  win.focus();
  win.webContents.invalidate();
  await new Promise((resolve) => setTimeout(resolve, 400));
  const image = await win.webContents.capturePage();
  fs.writeFileSync(path.join(artifacts, name), image.toPNG());
  return path.join(artifacts, name);
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
  const ready = await waitFor(win, 'window.__lanwan && window.__lanwan.store && window.__lanwan.game');
  await new Promise((resolve) => setTimeout(resolve, 2200));
  const uiReady = await waitFor(win, 'document.querySelector(\'[data-testid="hud-date"]\')', 7000);

  const initial = await read(win, `(() => ({
    date: document.querySelector('[data-testid="hud-date"]')?.textContent ?? null,
    view: window.__lanwan.store.view,
    cities: window.__lanwan.store.world.cities.length,
    companies: window.__lanwan.store.world.companies.length,
    text: document.body.innerText.slice(0, 700),
  }))()`);
  const regionShot = await capture(win, 'smoke-region.png');

  // 区域 → 城市
  const clickedCity = await click(win, '[data-testid="city-card-lanport"]');
  await new Promise((resolve) => setTimeout(resolve, 250));
  const clickedEnter = await click(win, '[data-testid="btn-enter-city"]');
  const enteredCity = await waitFor(win, `window.__lanwan.store.view === 'city'`, 3000);
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const cityShot = await capture(win, 'smoke-city.png');

  // 城市建筑点击探针（画布上、UI 面板之外）
  const probeResults = [];
  for (const [px, py] of [[720, 450], [600, 300], [800, 300], [900, 300], [600, 500], [800, 500], [900, 500], [520, 380], [920, 420]]) {
    win.webContents.sendInputEvent({ type: 'mouseDown', x: px, y: py, button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x: px, y: py, button: 'left', clickCount: 1 });
    await new Promise((resolve) => setTimeout(resolve, 180));
    probeResults.push({
      px,
      py,
      building: await read(win, 'window.__lanwan.store.selectedBuildingId'),
      district: await read(win, 'window.__lanwan.store.selectedDistrictId'),
    });
  }
  const selectedBuilding = probeResults.find((entry) => entry.building)?.building ?? null;
  const selectedDistrict = probeResults.find((entry) => entry.district)?.district ?? null;
  const buildingShot = await capture(win, 'smoke-building-selected.png');
  const cityState = await read(win, `(() => ({
    view: window.__lanwan.store.view,
    city: window.__lanwan.store.selectedCityId,
    overlayView: document.querySelector('.ui-overlay')?.dataset.view ?? null,
    buildingCount: window.__lanwan.store.selectedLayout?.buildings.length,
    districtCount: window.__lanwan.store.selectedLayout?.districts.length,
  }))()`);

  // 返回区域 + 图层
  const clickedBack = await click(win, '[data-testid="btn-back-region"]');
  await new Promise((resolve) => setTimeout(resolve, 600));
  const backView = await read(win, 'window.__lanwan.store.view');
  const clickedEconomy = await click(win, '[data-testid="layer-economy"]');
  await new Promise((resolve) => setTimeout(resolve, 300));
  const layerAfter = await read(win, 'window.__lanwan.store.layer');

  // 企业注资
  const cashBeforeInvest = await read(win, 'window.__lanwan.store.world.player.cash');
  const clickedInvest = await click(win, '[data-testid="company-invest-lp-food"]');
  await new Promise((resolve) => setTimeout(resolve, 500));
  const cashAfterInvest = await read(win, 'window.__lanwan.store.world.player.cash');
  const holdingAfterInvest = await read(win, 'window.__lanwan.store.world.player.holdings.length');

  // 持股份红：推进 12 个月，检查玩家现金与分红事件日志
  const dividendEvidence = await win.webContents.executeJavaScript(`(() => {
    const s = window.__lanwan.store;
    const before = s.world.player.cash;
    let firstDividend = null;
    for (let i = 0; i < 12; i++) {
      s.tick();
      if (!firstDividend && (s.world.player.lastDividend ?? 0) > 0) {
        firstDividend = { date: s.dateLabel, amount: s.world.player.lastDividend, logs: s.world.log.filter((entry) => entry.kind === 'player' && entry.message.includes('分红')).slice(-1) };
      }
    }
    const logs = s.world.log.filter((entry) => entry.kind === 'player' && entry.message.includes('分红'));
    return {
      before,
      after: s.world.player.cash,
      firstDividend,
      lastDividend: s.world.player.lastDividend ?? 0,
      dividendsReceived: s.world.player.dividendsReceived ?? 0,
      dividends: logs.map((entry) => ({ tick: entry.tick, message: entry.message })),
      holding: s.world.player.holdings.map((entry) => ({ companyId: entry.companyId, shares: entry.shares })),
      date: s.dateLabel,
    };
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 700));
  const dividendShot = await capture(win, 'smoke-player-dividend.png');

  // 自动运行开关
  const clickedPause = await click(win, '[data-testid="btn-pause"]');
  await new Promise((resolve) => setTimeout(resolve, 300));
  const autoAfterOn = await read(win, 'window.__lanwan.store.autoRunning');
  await click(win, '[data-testid="btn-pause"]');
  await new Promise((resolve) => setTimeout(resolve, 300));
  const autoAfterOff = await read(win, 'window.__lanwan.store.autoRunning');

  // 时间推进
  const dateBeforeTick = await read(win, `document.querySelector('[data-testid="hud-date"]')?.textContent ?? null`);
  const clickedTick = await click(win, '[data-testid="btn-tick"]');
  await new Promise((resolve) => setTimeout(resolve, 900));
  const dateAfterTick = await read(win, `document.querySelector('[data-testid="hud-date"]')?.textContent ?? null`);
  const gdpAfterTick = await read(win, `document.querySelector('[data-testid="hud-gdp"]')?.textContent ?? null`);
  const cashAfterTick = await read(win, `document.querySelector('[data-testid="hud-cash"]')?.textContent ?? null`);
  const cityAfterShot = await capture(win, 'smoke-city-after-tick.png');

  // 存档模态 + Escape
  const openedSave = await click(win, '[data-testid="btn-save"]');
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const saveModalVisible = await read(win, `Boolean(document.querySelector('[data-testid="modal-save"]'))`);
  const modalShot = await capture(win, 'smoke-modal-save.png');
  await win.webContents.executeJavaScript(`window.dispatchEvent(new CustomEvent('lanwan:escape'))`);
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const saveModalGone = await read(win, `!document.querySelector('[data-testid="modal-save"]')`);
  const modalHostState = await read(win, `(() => { const h = document.querySelector('#modal-host'); return { hidden: h?.hidden, length: h?.innerHTML.length }; })()`);

  // 保存 → 推进 → 读取
  const saveResult = await win.webContents.executeJavaScript(`(async () => {
    const s = window.__lanwan.store;
    const saved = await s.saveSlot('manual-1');
    const dateSaved = s.dateLabel;
    s.tick();
    const dateAdvanced = s.dateLabel;
    const loaded = await s.loadSlot('manual-1');
    return { saved, dateSaved, dateAdvanced, loaded, dateAfterLoad: s.dateLabel, slots: await s.listSlots() };
  })()`);

  // reload 模拟重启：自动存档恢复
  await new Promise((resolve) => setTimeout(resolve, 900));
  const dateBeforeReload = await read(win, 'window.__lanwan.store.dateLabel');
  win.reload();
  const reloadedReady = await waitFor(win, 'window.__lanwan && window.__lanwan.store', 15000);
  await new Promise((resolve) => setTimeout(resolve, 1800));
  const dateAfterReload = await read(win, 'window.__lanwan.store.dateLabel');
  const restoredToast = await read(win, `document.body.innerText.includes('已恢复上次自动存档')`);

  // 最小窗口
  win.setSize(1100, 700);
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const smallShot = await capture(win, 'smoke-small-window.png');
  const smallOverflow = await read(win, `({ w: innerWidth, scrollW: document.documentElement.scrollWidth, overflowX: document.documentElement.scrollWidth > innerWidth + 2 })`);

  // 损坏自动存档：新窗口读取，不覆盖原文件
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const autosavePath = path.join(savesDir, 'autosave.json');
  const manualPath = path.join(savesDir, 'manual-1.json');
  const corruptSave = JSON.parse(fs.readFileSync(manualPath, 'utf8'));
  delete corruptSave.world.cities[0].publicSector;
  fs.writeFileSync(autosavePath, JSON.stringify(corruptSave), 'utf8');
  const corruptBytesBefore = fs.readFileSync(autosavePath, 'utf8');
  const win2 = new BrowserWindow({
    width: 1200, height: 820, show: true, backgroundColor: '#08111d',
    webPreferences: {
      preload: path.join(root, 'dist/electron/preload.js'),
      nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false,
    },
  });
  await win2.loadFile(path.join(root, 'dist/renderer/index.html'));
  const corruptReady = await waitFor(win2, 'window.__lanwan && window.__lanwan.store', 15000);
  await new Promise((resolve) => setTimeout(resolve, 1800));
  const corruptStartup = await read(win2, `(() => ({
    ready: Boolean(window.__lanwan?.store),
    autosaveDisabled: window.__lanwan.store.autosaveDisabled,
    reason: window.__lanwan.store.autosaveDisabledReason,
    note: document.querySelector('#hud-save-note')?.textContent ?? null,
    bodyHasWarning: document.body.innerText.includes('自动存档损坏') || document.body.innerText.includes('自动存档已暂停'),
    date: window.__lanwan.store.dateLabel,
  }))()`);
  await click(win2, '[data-testid="btn-tick"]');
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const corruptBytesAfter = fs.readFileSync(autosavePath, 'utf8');
  const corruptAfterTick = await read(win2, `({
    autosaveDisabled: window.__lanwan.store.autosaveDisabled,
    date: window.__lanwan.store.dateLabel,
    bytesPreserved: false,
  })`);
  const corruptShot = await capture(win2, 'smoke-corrupt-autosave.png');
  corruptAfterTick.bytesPreserved = corruptBytesBefore === corruptBytesAfter;
  win2.destroy();

  console.log(JSON.stringify({
    ready,
    uiReady,
    initial,
    interactions: {
      clickedCity,
      clickedEnter,
      enteredCity,
      clickedBack,
      backView,
      clickedEconomy,
      layerAfter,
      cashBeforeInvest,
      clickedInvest,
      cashAfterInvest,
      holdingAfterInvest,
      clickedPause,
      autoAfterOn,
      autoAfterOff,
      clickedTick,
      dateBeforeTick,
      dateAfterTick,
      gdpAfterTick,
      cashAfterTick,
      openedSave,
      saveModalVisible,
      saveModalGone,
      modalHostState,
      cityState,
      selectedBuilding,
      selectedDistrict,
      probeResults,
    },
    dividendEvidence,
    saveResult,
    reload: { reloadedReady, dateBeforeReload, dateAfterReload, restoredToast },
    smallOverflow,
    corruptStartup: { ...corruptStartup, ready: corruptReady, afterTick: corruptAfterTick, bytesPreserved: corruptBytesBefore === corruptBytesAfter },
    errors,
    screenshots: [regionShot, cityShot, cityAfterShot, modalShot, buildingShot, smallShot, dividendShot, corruptShot],
  }, null, 2));
  win.destroy();
  app.quit();
}).catch((error) => {
  console.error(error);
  app.exit(1);
});

app.on('window-all-closed', () => app.quit());
