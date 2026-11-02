// 修复后泄漏回归证据：与 acceptance-leaks-before.cjs 同机位（1440x900、同步骤、同名截图），
// 额外做断言：非市长视角不得在卡片/地图/概况/政府/交通中出现财政余额或财政流水。
// 输出：artifacts/qa-after/*.png 与 manifest.json；任一断言失败退出码 1。
// 用法：DISPLAY=:99 node_modules/electron/dist/electron --no-sandbox --disable-dev-shm-usage scripts/acceptance-leaks-after.cjs
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { registerSaveHandlers } = require('../dist/electron/saveIpc.js');

const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'artifacts', 'qa-after');
fs.mkdirSync(outDir, { recursive: true });
const userData = path.join(root, 'artifacts', 'electron-user-data-qa-after');
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

async function canvasTexts(win) {
  return read(win, `(() => {
    const game = window.__lanwan && window.__lanwan.game;
    if (!game) return [];
    const scenes = game.scene.getScenes(true);
    const out = [];
    for (const scene of scenes) {
      const walk = (obj) => {
        if (!obj) return;
        if (typeof obj.text === 'string' && obj.text.trim()) out.push(obj.text);
        if (Array.isArray(obj.list)) for (const child of obj.list) walk(child);
      };
      walk(scene.children);
    }
    return out;
  })()`);
}

async function rectOf(win, selector) {
  return read(win, `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.max(0, Math.floor(r.x)), y: Math.max(0, Math.floor(r.y)), width: Math.ceil(r.width), height: Math.ceil(r.height) };
  })()`);
}

async function capture(win, name, clip) {
  win.focus();
  win.webContents.invalidate();
  await sleep(400);
  const image = await win.webContents.capturePage(clip ?? undefined);
  const file = path.join(outDir, name);
  fs.writeFileSync(file, image.toPNG());
  return { file, rect: clip ?? null };
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
      isNonMayor: (s.world.player.roles?.mayorCityId ?? null) === null,
      date: s.dateLabel,
      cities: s.world.cities.map((c) => ({ id: c.id, name: c.name, treasury: c.treasury, gdp: c.gdp })),
    };
  })()`);

  const checks = [];
  const check = (id, ok, detail) => checks.push({ id, pass: Boolean(ok), detail });
  const evidence = [];
  const push = (entry) => evidence.push({ ...entry, capturedAt: new Date().toISOString() });
  const lanport = identity.cities.find((c) => c.id === 'lanport');

  // L0 区域初始视图
  const shot01 = await capture(win, '01-region-default.png');
  push({ id: 'L0', field: '区域视图（默认非市长）', screenshot: path.relative(root, shot01.file), sha256: sha256(shot01.file) });

  // L1 城市卡片：不得出现财政
  const cardRect = await rectOf(win, '[data-testid="city-card-lanport"]');
  const cardText = await read(win, `document.querySelector('[data-testid="city-card-lanport"]')?.innerText ?? null`);
  const shot02 = cardRect
    ? await capture(win, '02-city-card-lanport-treasury.png', cardRect)
    : await capture(win, '02-city-card-lanport-treasury.png');
  const l1 = typeof cardText === 'string' && !/财政/.test(cardText) && !cardText.includes(String(lanport?.treasury ?? ''));
  check('L1 城市卡片无财政余额', l1, { domText: cardText });
  push({ id: 'L1', field: '城市卡片财政余额', city: 'lanport', domText: cardText, screenshot: path.relative(root, shot02.file), sha256: sha256(shot02.file) });

  // L2 区域地图（economy 图层）画布文字：不得出现财政
  const layerClicked = await click(win, '[data-testid="layer-economy"]');
  await sleep(900);
  const layerState = await read(win, `window.__lanwan.store.layer`);
  const mapTexts = await canvasTexts(win);
  const shot03 = await capture(win, '03-region-map-economy-hint.png');
  const l2 = Array.isArray(mapTexts) && !mapTexts.some((t) => /财政/.test(t));
  check('L2 地图经济图层无财政', l2, { layer: layerState, layerClicked, canvasTexts: mapTexts, cities: identity.cities });
  push({ id: 'L2', field: 'GDP · 财政（画布文字）', layer: layerState, canvasTexts: mapTexts, screenshot: path.relative(root, shot03.file), sha256: sha256(shot03.file) });

  // L3 城市概况 KPI：不得出现财政
  await click(win, '[data-testid="city-card-lanport"]');
  await sleep(400);
  await click(win, '[data-testid="btn-enter-city"]');
  const entered = await waitFor(win, `window.__lanwan.store.view === 'city'`, 5000);
  await sleep(1400);
  const mayorButtonInCity = await read(win, `(() => {
    const s = window.__lanwan.store;
    const el = document.querySelector('[data-testid="run-for-mayor"]');
    return { mayorCityId: s.world.player.roles?.mayorCityId ?? null, runForMayorButton: Boolean(el), runForMayorText: el?.textContent ?? null };
  })()`);
  await scrollTo(win, '.overview-section', 'start');
  await sleep(700);
  const overviewText = await read(win, `document.querySelector('.overview-section')?.innerText ?? null`);
  const shot04 = await capture(win, '04-city-overview-fiscal-kpi.png');
  const l3 = typeof overviewText === 'string' && !/财政/.test(overviewText);
  check('L3 概况 KPI 无财政', l3, { domText: overviewText });
  push({ id: 'L3', field: '概况 KPI 财政', entered, mayorButtonInCity, domText: overviewText, screenshot: path.relative(root, shot04.file), sha256: sha256(shot04.file) });

  // 推进 12 个月（让财政转负、流水非空，与修复前证据同条件）
  const tickResult = await win.webContents.executeJavaScript(`(() => {
    const s = window.__lanwan.store;
    const before = s.world.cities.map((c) => ({ id: c.id, treasury: c.treasury }));
    const tickErrors = [];
    for (let i = 0; i < 12; i += 1) {
      const r = s.tick();
      if (!r || r.ok === false) tickErrors.push(r?.error ?? 'unknown');
    }
    const after = s.world.cities.map((c) => ({ id: c.id, treasury: c.treasury }));
    return { before, after, tickErrors, date: s.dateLabel };
  })()`);
  await sleep(1200);

  // L4 政府面板：非市长不得渲染财政流水，只允许“仅市长可见”占位
  await scrollTo(win, '[data-testid="government-section"]', 'start');
  await sleep(900);
  const govText = await read(win, `document.querySelector('[data-testid="government-section"]')?.innerText ?? null`);
  const govMarker = await read(win, `(() => {
    const sec = document.querySelector('[data-testid="government-section"]');
    if (!sec) return null;
    return {
      hasMayorPanel: Boolean(sec.querySelector('[data-testid="mayor-fiscal-panel"]')),
      hasRestricted: Boolean(sec.querySelector('[data-testid="fiscal-restricted"]')),
      hasLedger: Boolean(sec.querySelector('[data-testid="fiscal-ledger"]')),
      hasTreasury: Boolean(sec.querySelector('[data-testid="fiscal-treasury"]')),
    };
  })()`);
  const govRect = await rectOf(win, '[data-testid="government-section"]');
  const shot05 = await capture(win, '05-government-fiscal-ledger.png');
  if (govRect) await capture(win, '05b-government-section-clip.png', govRect);
  // 非市长占位本身含“财政流水｜仅市长可见”标题（允许），禁止的是明细、金额与财政面板元素。
  const govLeaksAmount = (() => {
    if (typeof govText !== 'string') return true;
    const fmt = (n) => `${(Math.abs(n) / 10000).toFixed(1)} 万`;
    return identity.cities.some((c) => govText.includes(fmt(c.treasury)));
  })();
  const l4 =
    typeof govText === 'string' &&
    !govLeaksAmount &&
    govMarker &&
    govMarker.hasRestricted === true &&
    govMarker.hasMayorPanel === false &&
    govMarker.hasLedger === false &&
    govMarker.hasTreasury === false;
  check('L4 政府面板非市长无财政流水', l4, { domText: govText, markers: govMarker, govLeaksAmount, treasuryAfterTicks: tickResult.after.find((c) => c.id === 'lanport')?.treasury ?? null });
  push({ id: 'L4', field: '政府面板财政流水', domText: govText, markers: govMarker, screenshot: path.relative(root, shot05.file), sha256: sha256(shot05.file) });

  // L5 交通/政策：不得出现“财政资金不足”提示
  await scrollTo(win, '[data-testid="transport-section"]', 'start');
  await sleep(900);
  const transportText = await read(win, `document.querySelector('[data-testid="transport-section"]')?.innerText ?? null`);
  const insuffCount = await read(win, `document.querySelectorAll('[data-testid="transport-section"] .transport-why').length`);
  const insuffTexts = await read(win, `Array.from(document.querySelectorAll('[data-testid="transport-section"] .transport-why')).map((el) => el.textContent ?? '').filter((t) => t.includes('财政资金不足')).length`);
  const transportRect = await rectOf(win, '[data-testid="transport-section"]');
  const shot06 = await capture(win, '06-transport-fiscal-insufficient.png');
  if (transportRect) await capture(win, '06b-transport-section-clip.png', transportRect);
  const l5 = typeof transportText === 'string' && !/财政资金不足/.test(transportText) && insuffTexts === 0;
  check('L5 交通无财政资金不足提示', l5, { whyCount: insuffCount, insuffTexts, domText: transportText });
  push({ id: 'L5', field: '财政资金不足 提示', hintCount: insuffCount, domText: transportText, screenshot: path.relative(root, shot06.file), sha256: sha256(shot06.file) });

  // L6 返回区域：12 个月后城市卡片仍无财政
  await click(win, '[data-testid="btn-back-region"]');
  await sleep(1200);
  const cardRectAfter = await rectOf(win, '[data-testid="city-card-lanport"]');
  const cardTextAfter = await read(win, `document.querySelector('[data-testid="city-card-lanport"]')?.innerText ?? null`);
  const shot07 = cardRectAfter
    ? await capture(win, '07-city-card-after-12m.png', cardRectAfter)
    : await capture(win, '07-city-card-after-12m.png');
  const l6 = typeof cardTextAfter === 'string' && !/财政/.test(cardTextAfter);
  check('L6 12 月后城市卡片无财政余额', l6, { domText: cardTextAfter, treasuryAfterTicks: tickResult.after.find((c) => c.id === 'lanport')?.treasury ?? null });
  push({ id: 'L6', field: '12 个月后城市卡片财政', domText: cardTextAfter, screenshot: path.relative(root, shot07.file), sha256: sha256(shot07.file) });

  // L7 12 个月后地图提示仍无财政
  const mapTextsAfter = await canvasTexts(win);
  const shot08 = await capture(win, '08-region-map-economy-after-12m.png');
  const l7 = Array.isArray(mapTextsAfter) && !mapTextsAfter.some((t) => /财政/.test(t));
  check('L7 12 月后地图经济图层无财政', l7, { canvasTexts: mapTextsAfter, citiesAfterTicks: tickResult.after });
  push({ id: 'L7', field: '12 月后地图财政余额', canvasTexts: mapTextsAfter, screenshot: path.relative(root, shot08.file), sha256: sha256(shot08.file) });

  const identityProof = await read(win, `(() => {
    const s = window.__lanwan.store;
    return { mayorCityId: s.world.player.roles?.mayorCityId ?? null, runForMayorButton: Boolean(document.querySelector('[data-testid="run-for-mayor"]')), date: s.dateLabel, view: s.view, layer: s.layer };
  })()`);

  const failed = checks.filter((c) => !c.pass);
  const run = {
    kind: 'fix-after-leak-evidence',
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
    checks,
    failed: failed.map((c) => c.id),
    errors,
    evidence,
  };
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(run, null, 2), 'utf8');

  console.log(JSON.stringify({ ok: failed.length === 0, outDir: path.relative(root, outDir), checks, failed: failed.map((c) => c.id), identityProof, tickResult, errors }, null, 2));

  win.destroy();
  app.quit();
  process.exitCode = failed.length === 0 ? 0 : 1;
}).catch((error) => {
  console.error(error);
  app.exit(1);
});

app.on('window-all-closed', () => app.quit());
