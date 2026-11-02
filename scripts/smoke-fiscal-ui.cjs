/**
 * 财政界面无头走查（界面线专用；不改动 scripts/smoke-main.cjs，那个归验收员）。
 *
 * 覆盖补充指令 §7 / DECISIONS v1.1 #9 的可见性白名单：
 *   1. 城市卡片不再展示财政余额；
 *   2. 非市长视角：政府章节只有"仅市长可见"占位，没有财政流水、没有预算数字；
 *   3. 市长视角：财政流水与预算明细可见；
 *   4. A 城市长切到 B 城：B 城按普通玩家权限（跨城不泄漏）；
 *   5. 交通投资入口对非市长禁用（title 说明原因，不含可用资金比较）；
 *   6. 生产构建不出现"市长演示"入口（#5）；
 *   7. 通知展示期按当前市长身份重过滤（#13 展示期部分）；
 *   8. 月度报告财政列只对本人担任市长的城市显示；
 *   9. 读档后市长身份与可见性一致；1100x700 窗口无横向溢出。
 *
 * 用法（无头环境）：
 *   Xvfb :99 -screen 0 1600x1000x24 &
 *   DISPLAY=:99 node_modules/electron/dist/electron --no-sandbox --disable-dev-shm-usage scripts/smoke-fiscal-ui.cjs
 * 截图输出：artifacts/ui-fiscal/*.png；结论以 JSON 打印到 stdout，失败时退出码非 0。
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { registerSaveHandlers } = require('../dist/electron/saveIpc.js');

const root = path.resolve(__dirname, '..');
const artifacts = path.join(root, 'artifacts', 'ui-fiscal');
fs.mkdirSync(artifacts, { recursive: true });
const userData = path.join(artifacts, 'electron-user-data');
fs.rmSync(userData, { recursive: true, force: true });
app.setPath('userData', userData);
const savesDir = path.join(app.getPath('userData'), 'saves');
fs.mkdirSync(savesDir, { recursive: true });
registerSaveHandlers(() => savesDir);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 走查阶段日志：出错时能定位到具体一步（无头环境没有交互式调试）。 */
function stage(name) {
  console.log(`[stage] ${name}`);
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
      // 页面正在导航（reload）时忽略，继续轮询。
    }
    await sleep(200);
  }
  return false;
}

async function capture(win, name) {
  win.focus();
  win.webContents.invalidate();
  await sleep(400);
  const image = await win.webContents.capturePage();
  const file = path.join(artifacts, name);
  fs.writeFileSync(file, image.toPNG());
  return file;
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

/** 直接改写身份状态，等价于"存档里玩家已是/不是市长"；生产构建没有演示入口。 */
async function setMayor(win, cityId) {
  await read(win, `(() => {
    const s = window.__lanwan.store;
    const cityId = ${JSON.stringify(cityId)};
    s.world.player.roles.mayorCityId = cityId;
    // 与 appointPlayerMayor 保持一致：玩家在任时清掉 AI 领导人，否则违反存档不变量。
    if (cityId) {
      const state = s.world.politics.cities.find((entry) => entry.cityId === cityId);
      if (state) {
        state.leader = null;
        state.lastResult = '无头走查：直接设置市长身份（等价于选举结果）';
      }
    }
    s.emit();
    return s.world.player.roles.mayorCityId;
  })()`);
  await sleep(500);
}

async function scrollTo(win, selector) {
  await read(win, `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (el) el.scrollIntoView({ block: 'start' });
    return Boolean(el);
  })()`);
  await sleep(450);
}

const checks = [];
function check(name, pass, detail) {
  checks.push({ name, pass: Boolean(pass), detail });
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
    if (level >= 2) errors.push(message);
  });

  await win.loadFile(path.join(root, 'dist/renderer/index.html'));
  await waitFor(win, 'window.__lanwan && window.__lanwan.store && window.__lanwan.game');
  await sleep(2400);
  await waitFor(win, `document.querySelector('[data-testid="hud-date"]')`, 7000);
  await sleep(600);

  // ---- 1. 区域视图：城市卡片不含财政余额 ----
  stage('区域视图：城市卡片');
  const cityCard = await read(win, `(() => {
    const card = document.querySelector('[data-testid="city-card-lanport"]');
    return { text: card?.innerText ?? '', hasTreasury: (card?.innerText ?? '').includes('财政') };
  })()`);
  check('城市卡片不展示财政余额', !cityCard.hasTreasury && cityCard.text.includes('劳动力'), cityCard.text.replace(/\n/g, ' | '));
  await capture(win, '01-region-city-cards.png');

  // ---- 2. 进入岚港，非市长视角 ----
  stage('进入城市：岚港');
  await click(win, '[data-testid="city-card-lanport"]');
  await sleep(300);
  await click(win, '[data-testid="btn-enter-city"]');
  await waitFor(win, `window.__lanwan.store.view === 'city'`, 4000);
  await sleep(1400);
  await setMayor(win, null);
  stage('非市长：政府章节读数');
  await scrollTo(win, '[data-testid="government-section"]');

  const nonMayor = await read(win, `(() => {
    const s = window.__lanwan.store;
    const gov = document.querySelector('[data-testid="government-section"]');
    const tr = document.querySelector('[data-testid="transport-section"]');
    const invest = tr?.querySelector('[data-action="invest-transport"]');
    return {
      hasLedger: Boolean(document.querySelector('[data-testid="fiscal-ledger"]')),
      hasRestricted: Boolean(document.querySelector('[data-testid="fiscal-restricted"]')),
      govText: (gov?.innerText ?? '').slice(0, 500),
      transportKpis: [...(tr?.querySelectorAll('.transport-kpi') ?? [])].map((el) => el.innerText.replace(/\\n/g, ' ')),
      investDisabled: invest ? invest.disabled : null,
      investTitle: invest?.getAttribute('title') ?? null,
      demoButton: Boolean(document.querySelector('[data-testid="mayor-demo-toggle"]')),
      mayorCityId: s.mayorCityId,
    };
  })()`);
  const nonMayorTreasury = await read(win, `(() => {
    const s = window.__lanwan.store;
    const city = s.world.cities.find((c) => c.id === 'lanport');
    const text = (document.querySelector('[data-testid="government-section"]')?.innerText ?? '')
      + (document.querySelector('[data-testid="transport-section"]')?.innerText ?? '');
    return { treasury: city.treasury, formatted: (city.treasury / 10000).toFixed(1) + ' 万', leaked: text.includes((city.treasury / 10000).toFixed(1) + ' 万') };
  })()`);
  check('非市长：政府章节无财政流水', !nonMayor.hasLedger && nonMayor.hasRestricted, nonMayor.govText.slice(0, 160));
  check('非市长：政府/交通章节不含财政余额格式化值', !nonMayorTreasury.leaked, JSON.stringify(nonMayorTreasury));
  check('非市长：交通投资入口禁用且说明原因', nonMayor.investDisabled === true && /仅市长可决定市政投资/.test(nonMayor.investTitle ?? ''), String(nonMayor.investTitle));
  check('非市长：交通支出 KPI 显示占位', nonMayor.transportKpis.some((line) => line.includes('财政补偿') && line.includes('—')) && nonMayor.transportKpis.some((line) => line.includes('维护支出') && line.includes('—')), nonMayor.transportKpis.join(' / '));
  check('生产构建无市长演示入口', nonMayor.demoButton === false, 'mayor-demo-toggle=' + String(nonMayor.demoButton));
  await capture(win, '02-nonmayor-government.png');

  // ---- 3. 市长视角 ----
  stage('市长：政府与交通章节');
  await setMayor(win, 'lanport');
  await scrollTo(win, '[data-testid="government-section"]');
  const mayor = await read(win, `(() => {
    const tr = document.querySelector('[data-testid="transport-section"]');
    const s = window.__lanwan.store;
    const city = s.world.cities.find((c) => c.id === 'lanport');
    return {
      hasLedger: Boolean(document.querySelector('[data-testid="fiscal-ledger"]')),
      hasRestricted: Boolean(document.querySelector('[data-testid="fiscal-restricted"]')),
      govText: (document.querySelector('[data-testid="government-section"]')?.innerText ?? '').slice(0, 500),
      transportKpis: [...(tr?.querySelectorAll('.transport-kpi') ?? [])].map((el) => el.innerText.replace(/\\n/g, ' ')),
      investDisabled: tr?.querySelector('[data-action="invest-transport"]')?.disabled ?? null,
      treasuryFormatted: (city.treasury / 10000).toFixed(1) + ' 万',
    };
  })()`);
  check('市长：政府章节展示财政流水', mayor.hasLedger && !mayor.hasRestricted, mayor.govText.slice(0, 160));
  check('市长：交通支出 KPI 展示金额', /财政补偿[^0-9]*[0-9]/.test(mayor.transportKpis.join(' ')), mayor.transportKpis.join(' / '));
  await capture(win, '03-mayor-government.png');
  await scrollTo(win, '[data-testid="transport-section"]');
  await capture(win, '04-mayor-transport.png');

  // ---- 4. 跨城：A 城市长看 B 城 ----
  stage('跨城：岚港市长看铁谷');
  await setMayor(win, 'lanport');
  await click(win, '[data-testid="city-card-ironvale"]');
  await sleep(600);
  await read(win, `(() => { window.__lanwan.store.selectCity('ironvale'); window.__lanwan.store.emit(); return window.__lanwan.store.selectedCityId; })()`);
  await sleep(700);
  await scrollTo(win, '[data-testid="government-section"]');
  const crossCity = await read(win, `(() => {
    const s = window.__lanwan.store;
    const gov = document.querySelector('[data-testid="government-section"]');
    return {
      selectedCityId: s.selectedCityId,
      mayorCityId: s.mayorCityId,
      hasLedger: Boolean(document.querySelector('[data-testid="fiscal-ledger"]')),
      hasRestricted: Boolean(document.querySelector('[data-testid="fiscal-restricted"]')),
      govText: (gov?.innerText ?? '').slice(0, 300),
    };
  })()`);
  check('跨城：市长看非本市只有公开信息', crossCity.selectedCityId === 'ironvale' && crossCity.mayorCityId === 'lanport' && !crossCity.hasLedger && crossCity.hasRestricted, JSON.stringify({ selected: crossCity.selectedCityId, mayor: crossCity.mayorCityId, ledger: crossCity.hasLedger, restricted: crossCity.hasRestricted }));
  await capture(win, '05-cross-city-ironvale.png');

  // ---- 5. 通知展示期重过滤 ----
  stage('通知展示期重过滤');
  const noticeFilter = await read(win, `(() => {
    const s = window.__lanwan.store;
    s.world.player.roles.mayorCityId = 'lanport';
    const lanportState = s.world.politics.cities.find((entry) => entry.cityId === 'lanport');
    if (lanportState) lanportState.leader = null;
    s.world.notifications.push({ id: 'n-smoke-city', tick: s.world.time.tick, audience: 'city', kind: 'major', priority: 'important', cityId: 'lanport', title: '走查用城市通知', body: '仅市长可见', read: false });
    s.emit();
    const asMayor = s.notifications.some((n) => n.id === 'n-smoke-city');
    s.world.player.roles.mayorCityId = null;
    s.emit();
    const asCitizen = s.notifications.some((n) => n.id === 'n-smoke-city');
    s.world.notifications = s.world.notifications.filter((n) => n.id !== 'n-smoke-city');
    s.emit();
    return { asMayor, asCitizen };
  })()`);
  check('通知：仅市长期间展示城市通知', noticeFilter.asMayor === true && noticeFilter.asCitizen === false, JSON.stringify(noticeFilter));

  // ---- 6. 月度报告财政列 ----
  stage('月度报告财政列');
  await setMayor(win, null);
  await click(win, '[data-testid="btn-report"]');
  await sleep(900);
  const reportCitizen = await read(win, `(() => {
    const s = window.__lanwan.store;
    const rows = [...document.querySelectorAll('.report-table tbody tr')].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.innerText.trim()));
    const header = [...document.querySelectorAll('.report-table thead th')].map((th) => th.innerText.trim());
    const treasuryIndex = header.indexOf('财政');
    return { header, rows, treasuryIndex, mayorCityId: s.mayorCityId };
  })()`);
  const citizenTreasuryCells = reportCitizen.treasuryIndex >= 0 ? reportCitizen.rows.map((row) => row[reportCitizen.treasuryIndex]) : [];
  check('报告：非市长时财政列为占位', reportCitizen.treasuryIndex >= 0 && citizenTreasuryCells.every((cell) => cell === '—'), JSON.stringify(citizenTreasuryCells));
  await capture(win, '06-report-nonmayor.png');
  await win.webContents.executeJavaScript(`window.dispatchEvent(new CustomEvent('lanwan:escape'))`);
  await sleep(600);

  await setMayor(win, 'lanport');
  await click(win, '[data-testid="btn-report"]');
  await sleep(900);
  const reportMayor = await read(win, `(() => {
    const s = window.__lanwan.store;
    const header = [...document.querySelectorAll('.report-table thead th')].map((th) => th.innerText.trim());
    const treasuryIndex = header.indexOf('财政');
    const names = [...document.querySelectorAll('.report-table tbody tr')].map((tr) => tr.querySelector('td')?.innerText.trim() ?? '');
    const rows = [...document.querySelectorAll('.report-table tbody tr')].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.innerText.trim()));
    const city = s.world.cities.find((c) => c.id === 'lanport');
    return { names, rows, treasuryIndex, myFormatted: (city.treasury / 10000).toFixed(1) + ' 万' };
  })()`);
  const mayorRow = reportMayor.rows.find((row) => row[0] === '岚港') ?? [];
  const otherRows = reportMayor.rows.filter((row) => row[0] !== '岚港');
  check('报告：市长只看到本市财政', mayorRow[reportMayor.treasuryIndex] !== '—' && otherRows.every((row) => row[reportMayor.treasuryIndex] === '—'), JSON.stringify({ mine: mayorRow[reportMayor.treasuryIndex], others: otherRows.map((row) => row[reportMayor.treasuryIndex]) }));
  await capture(win, '07-report-mayor.png');
  await win.webContents.executeJavaScript(`window.dispatchEvent(new CustomEvent('lanwan:escape'))`);
  await sleep(600);

  // ---- 7. 存档后重载：身份与可见性保持一致 ----
  stage('存档后重载');
  const saved = await read(win, `(async () => {
    const s = window.__lanwan.store;
    const result = await s.saveSlot('manual-fiscal');
    return { result, mayorCityId: s.mayorCityId, date: s.dateLabel };
  })()`);
  win.reload();
  await waitFor(win, 'window.__lanwan && window.__lanwan.store', 15000);
  await sleep(2400);
  // 重启后读回手动存档（自动存档是角色变更前生成的，不能用它验证身份持久化）。
  const afterReload = await read(win, `(async () => {
    const s = window.__lanwan.store;
    const load = await s.loadSlot('manual-fiscal');
    return { load, mayorCityId: s.mayorCityId, view: s.view, date: s.dateLabel };
  })()`);
  await sleep(900);
  await click(win, '[data-testid="city-card-lanport"]');
  await sleep(300);
  await click(win, '[data-testid="btn-enter-city"]');
  await waitFor(win, `window.__lanwan.store.view === 'city'`, 4000);
  await sleep(1400);
  await scrollTo(win, '[data-testid="government-section"]');
  const reloadMayor = await read(win, `(() => ({
    hasLedger: Boolean(document.querySelector('[data-testid="fiscal-ledger"]')),
    mayorCityId: window.__lanwan.store.mayorCityId,
  }))()`);
  check('读档：市长身份保留且财政详情可见', afterReload.mayorCityId === 'lanport' && reloadMayor.hasLedger === true, JSON.stringify({ afterReload, reloadMayor, saved: saved.result }));
  await capture(win, '08-after-reload-mayor.png');

  // ---- 8. 小窗口（1100x700）无横向溢出 + 文字不裁切 ----
  stage('小窗口检查');
  win.setSize(1100, 700);
  await sleep(1400);
  await scrollTo(win, '[data-testid="government-section"]');
  const smallWindow = await read(win, `(() => {
    const gov = document.querySelector('[data-testid="government-section"]');
    const overflowX = document.documentElement.scrollWidth > window.innerWidth + 2;
    const clipped = gov ? gov.scrollWidth > gov.clientWidth + 2 : null;
    return { w: window.innerWidth, h: window.innerHeight, scrollW: document.documentElement.scrollWidth, overflowX, govClipped: clipped };
  })()`);
  check('小窗口：无横向页面溢出、政府章节不被裁切', smallWindow.overflowX === false && smallWindow.govClipped === false, JSON.stringify(smallWindow));
  await capture(win, '09-small-window.png');

  const failed = checks.filter((entry) => !entry.pass);
  console.log(JSON.stringify({
    artifacts,
    checks,
    failed: failed.map((entry) => entry.name),
    consoleErrors: errors.slice(0, 10),
  }, null, 2));
  process.exitCode = failed.length === 0 ? 0 : 1;
  await sleep(300);
  app.quit();
}).catch((error) => {
  console.error('smoke-fiscal-ui failed:', error);
  process.exitCode = 1;
  app.quit();
});
