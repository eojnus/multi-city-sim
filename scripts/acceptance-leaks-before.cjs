// 修复前泄漏证据采集：无头 Electron（Xvfb）+ 现有渲染，不修改世界与产品代码。
// 输出：artifacts/qa-before/*.png 与 manifest.json / run.json
// 用法：DISPLAY=:99 node_modules/electron/dist/electron --no-sandbox --disable-dev-shm-usage scripts/acceptance-leaks-before.cjs
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { registerSaveHandlers } = require('../dist/electron/saveIpc.js');

const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'artifacts', 'qa-before');
fs.mkdirSync(outDir, { recursive: true });
const userData = path.join(root, 'artifacts', 'electron-user-data-qa-before');
fs.rmSync(userData, { recursive: true, force: true });
app.setPath('userData', userData);
const savesDir = path.join(app.getPath('userData'), 'saves');
fs.mkdirSync(savesDir, { recursive: true });
registerSaveHandlers(() => savesDir);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(win, expression, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ok = await win.webContents.executeJavaScript(
      `(() => { try { return Boolean(${expression}); } catch { return false; } })()`,
    );
    if (ok) return true;
    await sleep(200);
  }
  return false;
}

async function read(win, expression) {
  return win.webContents.executeJavaScript(
    `(() => { try { return (${expression}); } catch (e) { return { error: String(e) }; } })()`,
  );
}

async function click(win, selector) {
  return win.webContents.executeJavaScript(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    el.click();
    return true;
  })()`);
}

async function scrollTo(win, selector, block = 'start') {
  return win.webContents.executeJavaScript(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    el.scrollIntoView({ block: ${JSON.stringify(block)} });
    return true;
  })()`);
}


/** 读取 Phaser 画布上的文字对象（用于无法用 DOM 读取的地图图层文字证据）。 */
async function canvasTexts(win) {
  return read(win, `(() => {
    const scene = window.__lanwan?.game?.scene?.getScene('RegionalScene');
    if (!scene) return null;
    const out = [];
    const walk = (obj) => {
      if (!obj) return;
      if (typeof obj.text === 'string' && obj.text.length > 0) out.push(obj.text);
      if (Array.isArray(obj.list)) obj.list.forEach(walk);
    };
    scene.children.list.forEach(walk);
    return out;
  })()`);
}

async function rectOf(win, selector) {
  return read(
    win,
    `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    })()`,
  );
}

async function capture(win, name, clip) {
  win.focus();
  win.webContents.invalidate();
  await sleep(400);
  const rect = clip
    ? {
        x: Math.max(0, Math.round(clip.x)),
        y: Math.max(0, Math.round(clip.y)),
        width: Math.max(1, Math.round(clip.width)),
        height: Math.max(1, Math.round(clip.height)),
      }
    : undefined;
  const image = rect ? await win.webContents.capturePage(rect) : await win.webContents.capturePage();
  const file = path.join(outDir, name);
  fs.writeFileSync(file, image.toPNG());
  return { file, rect: rect ?? null };
}

function sha256(file) {
  return require('node:crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex');
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
  const uiReady = await waitFor(win, `document.querySelector('[data-testid="hud-date"]')`, 15000);
  await sleep(2200);

  const identity = await read(win, `(() => {
    const s = window.__lanwan.store;
    return {
      mayorCityId: s.world.player.roles?.mayorCityId ?? null,
      playerCash: s.world.player.cash,
      date: s.dateLabel,
      view: s.view,
      layer: s.layer,
      selectedCityId: s.selectedCityId,
      cities: s.world.cities.map((c) => ({ id: c.id, name: c.name, treasury: c.treasury, gdp: c.gdp })),
      isNonMayor: (s.world.player.roles?.mayorCityId ?? null) === null,
    };
  })()`);

  const evidence = [];
  const push = (entry) => evidence.push({ ...entry, capturedAt: new Date().toISOString() });

  // L0 区域初始视图（默认 population 图层）
  const shot01 = await capture(win, '01-region-default.png');
  push({
    id: 'L0',
    source: '—',
    field: '基准：区域视图（默认非市长）',
    city: null,
    identity: '非市长',
    screenshot: path.relative(root, shot01.file),
    sha256: sha256(shot01.file),
  });

  // L1 城市卡片：财政余额（panels.ts:346）
  const cardRect = await rectOf(win, '[data-testid="city-card-lanport"]');
  const cardText = await read(win, `document.querySelector('[data-testid="city-card-lanport"]')?.innerText ?? null`);
  const shot02 = cardRect
    ? await capture(win, '02-city-card-lanport-treasury.png', cardRect)
    : await capture(win, '02-city-card-lanport-treasury.png');
  push({
    id: 'L1',
    source: 'src/ui/panels.ts:346（cityCard 的 财政 余额）',
    field: '财政余额 city.treasury',
    city: 'lanport（岚港）',
    identity: '非市长',
    treasury: identity.cities.find((c) => c.id === 'lanport')?.treasury ?? null,
    domText: cardText,
    screenshot: path.relative(root, shot02.file),
    sha256: sha256(shot02.file),
  });

  // L2 区域地图提示：GDP · 财政（RegionalScene.ts:266，economy 图层）
  const layerClicked = await click(win, '[data-testid="layer-economy"]');
  await sleep(900);
  const layerState = await read(win, `window.__lanwan.store.layer`);
  const mapTexts = await canvasTexts(win);
  const shot03 = await capture(win, '03-region-map-economy-hint.png');
  push({
    id: 'L2',
    source: 'src/presentation/scenes/RegionalScene.ts:266（economy 图层 dataLine）',
    field: 'GDP 与 财政 余额（画布文字）',
    city: '三城（地图节点）',
    identity: '非市长',
    layer: layerState,
    layerClicked,
    cities: identity.cities,
    canvasTexts: mapTexts,
    note: '画布文字经 Phaser 场景 text 对象读取，非 DOM；与截图、代码行、layer=economy 状态互证',
    screenshot: path.relative(root, shot03.file),
    sha256: sha256(shot03.file),
  });

  // L3 城市概况 KPI：财政（panels.ts:539）
  await click(win, '[data-testid="city-card-lanport"]');
  await sleep(400);
  await click(win, '[data-testid="btn-enter-city"]');
  const entered = await waitFor(win, `window.__lanwan.store.view === 'city'`, 5000);
  await sleep(1400);
  const mayorButtonInCity = await read(win, `(() => {
    const s = window.__lanwan.store;
    const el = document.querySelector('[data-testid="run-for-mayor"]');
    return {
      mayorCityId: s.world.player.roles?.mayorCityId ?? null,
      runForMayorButton: Boolean(el),
      runForMayorText: el?.textContent ?? null,
      govModeText: document.querySelector('[data-testid="government-section"] .gov-mode')?.innerText ?? null,
    };
  })()`);
  await scrollTo(win, '.overview-section', 'start');
  await sleep(700);
  const overviewText = await read(win, `document.querySelector('.overview-section')?.innerText ?? null`);
  const shot04 = await capture(win, '04-city-overview-fiscal-kpi.png');
  push({
    id: 'L3',
    source: 'src/ui/panels.ts:539（城市概况 KPI：财政）',
    field: '财政余额 city.treasury',
    city: 'lanport（岚港）',
    identity: '非市长',
    entered,
    mayorButtonInCity,
    treasury: identity.cities.find((c) => c.id === 'lanport')?.treasury ?? null,
    domText: overviewText,
    screenshot: path.relative(root, shot04.file),
    sha256: sha256(shot04.file),
  });

  // 推进 12 个月（正常游戏操作），让财政流水非空、财政余额转负，触发“财政资金不足”
  const tickResult = await win.webContents.executeJavaScript(`(() => {
    const s = window.__lanwan.store;
    const before = s.world.cities.map((c) => ({ id: c.id, treasury: c.treasury }));
    const tickErrors = [];
    for (let i = 0; i < 12; i += 1) {
      const r = s.tick();
      if (!r || r.ok === false) tickErrors.push(r?.error ?? 'unknown');
    }
    const after = s.world.cities.map((c) => ({ id: c.id, treasury: c.treasury }));
    return { before, after, tickErrors, date: s.dateLabel, mayorCityId: s.world.player.roles?.mayorCityId ?? null };
  })()`);
  await sleep(1200);

  // L4 政府面板：财政流水（panels.ts:761 / 945–1003）
  await scrollTo(win, '[data-testid="government-section"]', 'start');
  await sleep(900);
  const govText = await read(win, `document.querySelector('[data-testid="government-section"]')?.innerText ?? null`);
  const govRect = await rectOf(win, '[data-testid="government-section"]');
  const shot05 = await capture(win, '05-government-fiscal-ledger.png');
  if (govRect) await capture(win, '05b-government-section-clip.png', govRect);
  push({
    id: 'L4',
    source: 'src/ui/panels.ts:761 / 945–1003（政府与政策：财政流水）',
    field: '财政收支流水明细 + 财政余额',
    city: 'lanport（岚港）',
    identity: '非市长',
    treasuryAfterTicks: tickResult.after.find((c) => c.id === 'lanport')?.treasury ?? null,
    domText: govText,
    screenshot: path.relative(root, shot05.file),
    sha256: sha256(shot05.file),
  });

  // L5 交通/政策“财政资金不足”提示（panels.ts:1030 / 1075 / 1082 / 1131 / 1144）
  await scrollTo(win, '[data-testid="transport-section"]', 'start');
  await sleep(900);
  const transportText = await read(win, `document.querySelector('[data-testid="transport-section"]')?.innerText ?? null`);
  const insuffCount = await read(
    win,
    `document.querySelectorAll('[data-testid="transport-section"] .transport-why').length`,
  );
  const transportRect = await rectOf(win, '[data-testid="transport-section"]');
  const shot06 = await capture(win, '06-transport-fiscal-insufficient.png');
  if (transportRect) await capture(win, '06b-transport-section-clip.png', transportRect);
  push({
    id: 'L5',
    source: 'src/ui/panels.ts:1030/1075/1082/1131/1144（财政资金不足 提示）',
    field: '可由“财政资金不足”推断政府可用资金不足',
    city: 'lanport（岚港）',
    identity: '非市长',
    treasuryAfterTicks: tickResult.after.find((c) => c.id === 'lanport')?.treasury ?? null,
    domText: transportText,
    hintCount: insuffCount,
    hintSource: 'transport-why 元素文本（财政资金不足）',
    screenshot: path.relative(root, shot06.file),
    sha256: sha256(shot06.file),
  });

  // L6 返回区域：城市卡片与地图提示在 12 个月后的值
  await click(win, '[data-testid="btn-back-region"]');
  await sleep(1200);
  const cardRectAfter = await rectOf(win, '[data-testid="city-card-lanport"]');
  const cardTextAfter = await read(win, `document.querySelector('[data-testid="city-card-lanport"]')?.innerText ?? null`);
  const shot07 = cardRectAfter
    ? await capture(win, '07-city-card-after-12m.png', cardRectAfter)
    : await capture(win, '07-city-card-after-12m.png');
  push({
    id: 'L6',
    source: 'src/ui/panels.ts:346（12 个月后，财政余额已转负）',
    field: '财政余额（负数泄漏）',
    city: 'lanport（岚港）',
    identity: '非市长',
    treasuryAfterTicks: tickResult.after.find((c) => c.id === 'lanport')?.treasury ?? null,
    domText: cardTextAfter,
    screenshot: path.relative(root, shot07.file),
    sha256: sha256(shot07.file),
  });

  const mapTextsAfter = await canvasTexts(win);
  const shot08 = await capture(win, '08-region-map-economy-after-12m.png');
  push({
    id: 'L7',
    source: 'src/presentation/scenes/RegionalScene.ts:266（12 个月后）',
    field: 'GDP 与负财政余额（画布文字）',
    city: '三城（地图节点）',
    identity: '非市长',
    citiesAfterTicks: tickResult.after,
    canvasTexts: mapTextsAfter,
    screenshot: path.relative(root, shot08.file),
    sha256: sha256(shot08.file),
  });

  // 非市长身份与旧按钮证据
  const identityProof = await read(win, `(() => {
    const s = window.__lanwan.store;
    return {
      mayorCityId: s.world.player.roles?.mayorCityId ?? null,
      runForMayorButton: Boolean(document.querySelector('[data-testid="run-for-mayor"]')),
      date: s.dateLabel,
      view: s.view,
      layer: s.layer,
    };
  })()`);

  const run = {
    kind: 'fix-before-leak-evidence',
    preparedAt: new Date().toISOString(),
    environment: {
      os: process.platform,
      display: process.env.DISPLAY ?? null,
      window: '1440x900',
      xvfb: '1600x1000x24',
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      headless: 'Xvfb + Electron（无真实显示器）',
    },
    ready,
    uiReady,
    identity,
    identityProof,
    tickResult,
    errors,
    evidence,
  };
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(run, null, 2), 'utf8');

  console.log(JSON.stringify({
    ok: true,
    outDir: path.relative(root, outDir),
    shots: evidence.map((e) => e.screenshot),
    ids: evidence.map((e) => e.id),
    identityProof,
    tickResult,
    errors,
  }, null, 2));

  win.destroy();
  app.quit();
}).catch((error) => {
  console.error(error);
  app.exit(1);
});

app.on('window-all-closed', () => app.quit());
