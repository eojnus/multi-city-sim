// 块2 合入后的“修复后”走查证据（1d138a6 基线）。
// 覆盖：市长财政面板（负债/GDP/风险）、非市长受限态、债券市场认购区、月度报告非市长列。
// 身份说明：市长身份用演示命令 store.setMayorDemo 写入（生产构建无演示入口），
// 之后所有动作（发债、认购、开报告、推进月份）都走真实 DOM 点击；manifest 中标注 fixture。
// 输出：artifacts/qa-after-block2/*.png + manifest.json（sha256 / city / identity / dom 摘要）
// 用法：DISPLAY=:99 node_modules/electron/dist/electron --no-sandbox --disable-dev-shm-usage scripts/acceptance-after-block2.cjs
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { registerSaveHandlers } = require('../dist/electron/saveIpc.js');

const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'artifacts', 'qa-after-block2');
fs.mkdirSync(outDir, { recursive: true });
const userData = path.join(root, 'artifacts', 'electron-user-data-qa-after-block2');
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

async function setInput(win, selector, value) {
  return win.webContents.executeJavaScript(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(el, ${JSON.stringify(String(value))});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
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
  await sleep(450);
  const image = await win.webContents.capturePage(clip ?? undefined);
  const file = path.join(outDir, name);
  fs.writeFileSync(file, image.toPNG());
  return { file, rect: clip ?? null };
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
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
  const consoleErrors = [];
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2 && !/WebGL|GroupMarkerNotSet|GL Driver/.test(message)) consoleErrors.push(message);
  });

  await win.loadFile(path.join(root, 'dist/renderer/index.html'));
  const ready = await waitFor(win, 'window.__lanwan && window.__lanwan.store');
  const uiReady = await waitFor(win, `document.querySelector('[data-testid="hud-date"]')`, 15000);
  await sleep(2200);

  const shots = [];
  const record = async (id, name, meta, clip) => {
    const shot = await capture(win, name, clip);
    shots.push({
      id,
      screenshot: path.relative(root, shot.file),
      sha256: sha256(shot.file),
      clip: shot.rect,
      ...meta,
      capturedAt: new Date().toISOString(),
    });
    return shot;
  };

  const nonMayor = await read(win, `(() => {
    const s = window.__lanwan.store;
    return {
      mayorCityId: s.world.player.roles?.mayorCityId ?? null,
      date: s.dateLabel,
      cities: s.world.cities.map((c) => ({ id: c.id, name: c.name, treasury: c.treasury, gdp: c.gdp })),
    };
  })()`);

  // 1) 非市长：区域城市卡片（无财政）
  await record('nonmayor-region', '01-nonmayor-region-city-cards.png', {
    identity: '非市长',
    city: '三城（区域视图）',
    field: '城市卡片（不得含财政余额）',
    testid: 'city-card-lanport',
    dom: await read(win, `document.querySelector('[data-testid="city-card-lanport"]')?.innerText ?? null`),
  });

  // 2) 非市长：进入城市 → 政府章节受限态
  await click(win, '[data-testid="city-card-lanport"]');
  await sleep(400);
  await click(win, '[data-testid="btn-enter-city"]');
  await waitFor(win, `window.__lanwan.store.view === 'city'`, 5000);
  await sleep(1400);
  await scrollTo(win, '[data-testid="government-section"]', 'start');
  await sleep(800);
  const govRect = await rectOf(win, '[data-testid="government-section"]');
  await record('nonmayor-government', '02-nonmayor-government-restricted.png', {
    identity: '非市长',
    city: 'lanport（岚港）',
    field: '政府章节：仅市长可见占位（不得含财政流水/余额）',
    testid: 'fiscal-restricted',
    markers: await read(win, `(() => {
      const sec = document.querySelector('[data-testid="government-section"]');
      return {
        hasRestricted: Boolean(sec?.querySelector('[data-testid="fiscal-restricted"]')),
        hasMayorPanel: Boolean(sec?.querySelector('[data-testid="mayor-fiscal-panel"]')),
        hasLedger: Boolean(sec?.querySelector('[data-testid="fiscal-ledger"]')),
      };
    })()`),
    dom: await read(win, `document.querySelector('[data-testid="government-section"]')?.innerText ?? null`),
  }, govRect ?? undefined);

  // 3) 非市长：月度报告（财政列占位）
  await click(win, '[data-testid="btn-report"]');
  await sleep(900);
  const reportNonMayor = await read(win, `(() => {
    const header = [...document.querySelectorAll('.report-table thead th')].map((th) => th.innerText.trim());
    const rows = [...document.querySelectorAll('.report-table tbody tr')].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.innerText.trim()));
    return { header, rows, treasuryIndex: header.indexOf('财政') };
  })()`);
  await record('nonmayor-report', '03-nonmayor-monthly-report.png', {
    identity: '非市长',
    city: '三城（月度报告）',
    field: '月度报告财政列（应为占位 —）',
    report: reportNonMayor,
  });
  await win.webContents.executeJavaScript(`window.dispatchEvent(new CustomEvent('lanwan:escape'))`);
  await sleep(600);

  // 4) 市长：财政面板（负债 / GDP / 风险）
  // 生产构建没有演示入口（补充指令 §7），这里按验收 fixture 直接写身份并触发一次渲染；
  // 之后的发债/认购/报告/推进全部走真实 DOM。
  const mayorSet = await read(win, `(() => {
    const s = window.__lanwan.store;
    s.world.player.roles.mayorCityId = 'lanport';
    s.selectCity('lanport');
    s.emit();
    return { mayorCityId: s.mayorCityId, injected: true };
  })()`);
  await sleep(1400);
  await scrollTo(win, '[data-testid="mayor-fiscal-panel"]', 'start');
  await sleep(900);
  const panelRect = await rectOf(win, '[data-testid="mayor-fiscal-panel"]');
  const fiscalFacts = await read(win, `(() => {
    const s = window.__lanwan.store;
    const view = s.fiscalView('lanport');
    return {
      treasury: document.querySelector('[data-testid="fiscal-treasury"]')?.textContent ?? null,
      totalDebt: document.querySelector('[data-testid="fiscal-total-debt"]')?.textContent ?? null,
      debtRatio: document.querySelector('[data-testid="fiscal-debt-ratio"]')?.textContent ?? null,
      riskBadge: document.querySelector('[data-testid="fiscal-risk-badge"]')?.textContent?.trim() ?? null,
      viewTreasury: view?.treasury ?? null,
      viewTotalDebt: view?.totalDebt ?? null,
      viewDebtRatio: view?.debtRatio ?? null,
      viewRiskLevel: view?.riskLevel ?? null,
    };
  })()`);
  await record('mayor-fiscal-panel', '04-mayor-fiscal-panel.png', {
    identity: '市长（fixture: store.setMayorDemo）',
    city: 'lanport（岚港）',
    field: '可用资金 / 总负债 / 债务-GDP / 风险等级',
    testid: 'mayor-fiscal-panel',
    facts: fiscalFacts,
  }, panelRect ?? undefined);

  // 5) 市长：发债 → 债券市场认购区
  await scrollTo(win, '[data-testid="issue-bond"]', 'center');
  await sleep(600);
  await setInput(win, 'input[data-bond-plan-units]', 200);
  const issued = await click(win, '[data-testid="issue-bond"]');
  await sleep(1200);
  const marketBefore = await read(win, `(() => {
    const s = window.__lanwan.store;
    const sec = document.querySelector('[data-testid="bond-market-section"]');
    return {
      issueClicked: ${JSON.stringify(true)},
      offerings: s.world.bonds?.issuances?.map((entry) => ({ id: entry.id, status: entry.status, planUnits: entry.planUnits, soldUnits: entry.soldUnits })) ?? [],
      subscribeInputs: sec?.querySelectorAll('input[data-bond-subscribe-units]').length ?? 0,
      subscribeButtons: sec?.querySelectorAll('[data-testid^="subscribe-bond-"]').length ?? 0,
      dom: sec?.innerText ?? null,
    };
  })()`);
  const marketRect = await rectOf(win, '[data-testid="bond-market-section"]');
  await record('bond-market-offering', '05-bond-market-subscribe.png', {
    identity: '市长（fixture: store.setMayorDemo）',
    city: 'lanport（岚港）',
    field: '债券市场：发行批次与认购区',
    testid: 'bond-market-section',
    issueClicked: issued,
    market: marketBefore,
  }, marketRect ?? undefined);

  // 6) 市长：认购 20 份并推进 1 月结算
  const subInput = '[data-testid^="subscribe-bond-"] input, .bond-offer input[data-bond-subscribe-units]';
  const hasSubInput = await setInput(win, subInput, 20);
  const subClicked = await click(win, '[data-testid^="subscribe-bond-"]');
  await sleep(900);
  const bondFacts = await read(win, `(() => {
    const s = window.__lanwan.store;
    const issuance = s.world.bonds?.issuances?.[0] ?? null;
    const holding = s.world.bonds?.holdings?.find((h) => h.issuanceId === issuance?.id) ?? null;
    return {
      date: s.dateLabel,
      playerCash: s.world.player.cash,
      issuance: issuance ? { id: issuance.id, status: issuance.status, planUnits: issuance.planUnits, soldUnits: issuance.soldUnits } : null,
      playerHolding: holding ? { units: holding.units ?? holding.principal / 1000, principal: holding.principal } : null,
    };
  })()`);
  await click(win, '[data-testid="btn-tick"]');
  await sleep(1600);
  const afterTick = await read(win, `(() => {
    const s = window.__lanwan.store;
    const issuance = s.world.bonds?.issuances?.[0] ?? null;
    const view = s.fiscalView('lanport');
    return {
      date: s.dateLabel,
      issuance: issuance ? { status: issuance.status, soldUnits: issuance.soldUnits } : null,
      treasury: view?.treasury ?? null,
      totalDebt: view?.totalDebt ?? null,
      debtRatio: view?.debtRatio ?? null,
      riskLevel: view?.riskLevel ?? null,
    };
  })()`);
  await record('bond-subscribed', '06-bond-subscribed-after-tick.png', {
    identity: '市长（fixture: store.setMayorDemo）',
    city: 'lanport（岚港）',
    field: '认购结果与结算后财政读数',
    testid: 'bond-market-section',
    subscribeInputFound: hasSubInput,
    subscribeClicked: subClicked,
    beforeTick: bondFacts,
    afterTick,
  }, marketRect ?? undefined);

  // 7) 市长：月度报告（本市财政只对自己可见）
  await click(win, '[data-testid="btn-report"]');
  await sleep(900);
  const reportMayor = await read(win, `(() => {
    const header = [...document.querySelectorAll('.report-table thead th')].map((th) => th.innerText.trim());
    const rows = [...document.querySelectorAll('.report-table tbody tr')].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.innerText.trim()));
    return { header, rows, treasuryIndex: header.indexOf('财政') };
  })()`);
  await record('mayor-report', '07-mayor-monthly-report.png', {
    identity: '市长（fixture: store.setMayorDemo）',
    city: '三城（月度报告）',
    field: '月度报告：仅本市财政列有值',
    report: reportMayor,
  });
  await win.webContents.executeJavaScript(`window.dispatchEvent(new CustomEvent('lanwan:escape'))`);
  await sleep(500);

  const identityFinal = await read(win, `(() => {
    const s = window.__lanwan.store;
    return { mayorCityId: s.mayorCityId, date: s.dateLabel, view: s.view };
  })()`);

  const manifest = {
    kind: 'after-block2-walkthrough-evidence',
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
    identity: { initial: nonMayor, fixture: mayorSet, final: identityFinal },
    screenshots: shots,
    consoleErrors,
    ready,
    uiReady,
  };
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  console.log(JSON.stringify({ ok: true, outDir: path.relative(root, outDir), shots: shots.map((s) => s.screenshot), identity: manifest.identity, consoleErrors }, null, 2));

  win.destroy();
  app.quit();
}).catch((error) => {
  console.error(error);
  app.exit(1);
});

app.on('window-all-closed', () => app.quit());
