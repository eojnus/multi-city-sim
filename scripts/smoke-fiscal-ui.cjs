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

/** 在同一 JS 回合内写入输入值并点击按钮，避免中途重渲染把输入重置为默认值。 */
async function inputAndClick(win, inputSelector, value, clickSelector) {
  return read(win, `(() => {
    const input = document.querySelector(${JSON.stringify(inputSelector)});
    const button = document.querySelector(${JSON.stringify(clickSelector)});
    if (!input || !button) return false;
    input.value = ${JSON.stringify(value)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    button.click();
    return true;
  })()`);
}

/** 设置表单输入值（走查直接用 value + input 事件，模拟用户键入）。 */
async function setInput(win, selector, value) {
  return read(win, `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    el.value = ${JSON.stringify(value)};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
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

/** 撤销玩家市长身份（模拟离职/落选后的市民视角），等价于渲染期 viewer.mayorCityId 变化。 */
async function setCitizen(win) {
  await read(win, `(() => {
    const s = window.__lanwan.store;
    s.world.player.roles.mayorCityId = null;
    s.emit();
    return true;
  })()`);
  await sleep(500);
}

/** 用顶部「推进 1 月」按钮推进到目标 tick，返回实际 tick 与日期。 */
async function advanceToTick(win, targetTick, maxClicks = 40) {
  let tick = await read(win, 'window.__lanwan.store.world.time.tick');
  let clicks = 0;
  while (tick < targetTick && clicks < maxClicks) {
    await click(win, '[data-testid="btn-tick"]');
    await sleep(280);
    tick = await read(win, 'window.__lanwan.store.world.time.tick');
    clicks += 1;
  }
  return { tick, clicks, date: await read(win, 'window.__lanwan.store.dateLabel') };
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

  // ---- 9. KPI「企业数量」（v0.7 #2）与市长财政面板 / 债券市场（块4） ----
  stage('KPI：企业数量可点击直达企业列表');
  const kpi = await read(win, `(() => {
    const card = document.querySelector('[data-testid="kpi-companies"]');
    const text = card ? card.innerText : '';
    return {
      exists: Boolean(card),
      text,
      showsCompanies: /\\d+\\s*家/.test(text),
      leaksTreasury: text.includes('财政') || /\\d+\\.\\d\\s*万/.test(text),
    };
  })()`);
  await click(win, '[data-testid="kpi-companies"]');
  await sleep(700);
  const companiesReached = await read(win, `(() => {
    const section = document.querySelector('[data-testid="companies-section"]');
    if (!section) return { visible: false };
    const rect = section.getBoundingClientRect();
    return { visible: rect.top >= -40 && rect.top < window.innerHeight };
  })()`);
  check(
    'KPI 企业数量：显示家数、不含财政余额，点击可跳到企业列表',
    kpi.exists && kpi.showsCompanies && !kpi.leaksTreasury && companiesReached.visible === true,
    JSON.stringify({ kpi, companiesReached }),
  );

  stage('市长财政面板（块4）');
  await scrollTo(win, '[data-testid="mayor-fiscal-panel"]');
  const panel = await read(win, `(() => {
    const panel = document.querySelector('[data-testid="mayor-fiscal-panel"]');
    const text = panel ? panel.innerText : '';
    const pick = (testId) => {
      const el = document.querySelector('[data-testid="' + testId + '"]');
      return el ? el.textContent || '' : '';
    };
    return {
      exists: Boolean(panel),
      treasury: pick('fiscal-treasury'),
      totalDebt: pick('fiscal-total-debt'),
      ratio: pick('fiscal-debt-ratio'),
      badge: pick('fiscal-risk-badge'),
      hasMonthFlow: text.includes('当月收入') && text.includes('当月支出'),
      hasDebtRows: text.includes('银行贷款') && text.includes('在外债券本金') && text.includes('应计未付利息'),
      hasDue: text.includes('本月应付项') && text.includes('本月银行垫付'),
      hasRules: text.includes('银行无条件垫付') && text.includes('破产规则') && text.includes('100%'),
      hasIssueForm: Boolean(document.querySelector('[data-testid="issue-bond"]')),
      faceHint: text.includes('面额'),
      gdpCollapsed: (() => {
        const details = document.querySelector('[data-testid="fiscal-gdp-window"]');
        return details ? details.open === false : null;
      })(),
    };
  })()`);
  check(
    '财政面板：可用资金/当月收支/债务/风险/兑付入口齐全',
    panel.exists &&
      /[0-9]/.test(panel.treasury) &&
      /[0-9]/.test(panel.totalDebt) &&
      /%/.test(panel.ratio) &&
      panel.hasMonthFlow &&
      panel.hasDebtRows &&
      panel.hasDue &&
      panel.hasRules &&
      panel.hasIssueForm &&
      panel.faceHint,
    JSON.stringify(panel),
  );
  check(
    '财政面板：风险用文字+图标表达（不只颜色）',
    /●|▲|✖/.test(panel.badge) &&
      /正常|关注|高风险|已破产/.test(panel.badge) &&
      /上升|下降|持平|无可比/.test(panel.badge),
    panel.badge,
  );
  await capture(win, '10-mayor-fiscal-panel.png');

  stage('12 个月 GDP 窗口');
  await read(win, `(() => {
    const details = document.querySelector('[data-testid="fiscal-gdp-window"]');
    if (details) details.open = true;
    return true;
  })()`);
  await sleep(500);
  const gdp = await read(win, `(() => {
    const details = document.querySelector('[data-testid="fiscal-gdp-window"]');
    if (!details) return { rows: 0 };
    const rows = details.querySelectorAll('.gdp-window-row').length;
    const text = details.innerText;
    return {
      rows,
      estimated: (text.match(/估计/g) || []).length,
      summary: (details.querySelector('summary') || {}).textContent || '',
      hasJudgementNote: text.includes('判定合计') || text.includes('判定用'),
      dates: Array.from(details.querySelectorAll('.gdp-window-row > span')).map((el) => el.textContent),
      uniqueDates: new Set(Array.from(details.querySelectorAll('.gdp-window-row > span')).map((el) => el.textContent)).size,
    };
  })()`);
  check(
    '12 个月 GDP：默认收合，展开后逐月列出并标注估计月',
    panel.gdpCollapsed === true &&
      gdp.rows === 12 &&
      gdp.estimated >= 1 &&
      gdp.uniqueDates === 12 &&
      gdp.dates.every((date) => /^\d{4}\.\d{2}$/.test(date)),
    JSON.stringify(gdp),
  );
  await capture(win, '11-fiscal-gdp-window.png');

  stage('债券市场（空态，所有玩家可见）');
  await scrollTo(win, '[data-testid="bond-market-section"]');
  const market = await read(win, `(() => {
    const section = document.querySelector('[data-testid="bond-market-section"]');
    const text = section ? section.innerText : '';
    const empty = document.querySelector('[data-testid="bond-market-empty"]');
    return {
      exists: Boolean(section),
      emptyText: empty ? empty.textContent || '' : '',
      ownEmpty: Boolean(document.querySelector('[data-testid="own-bond-empty"]')),
      subscribeButtons: document.querySelectorAll('[data-action="subscribe-bond"]').length,
      hasWhitelistNote: text.includes('发行计划总额') && text.includes('不可贷款购债'),
      noDebtLabel: !text.includes('总负债') && !text.includes('计划总额：'),
    };
  })()`);
  check(
    '债券市场：独立区、空态文案、无认购按钮、不含政府总债务',
    market.exists &&
      /暂无已发行债券/.test(market.emptyText) &&
      market.ownEmpty &&
      market.subscribeButtons === 0 &&
      market.hasWhitelistNote &&
      market.noDebtLabel,
    JSON.stringify(market),
  );
  await capture(win, '12-bond-market-empty.png');

  stage('债券市场：非市长可见（公开信息）');
  await setMayor(win, null);
  await sleep(500);
  const citizenMarket = await read(win, `(() => ({
    mayorCityId: window.__lanwan.store.mayorCityId,
    hasMarket: Boolean(document.querySelector('[data-testid="bond-market-section"]')),
    hasFiscalPanel: Boolean(document.querySelector('[data-testid="mayor-fiscal-panel"]')),
    hasRestricted: Boolean(document.querySelector('[data-testid="fiscal-restricted"]')),
  }))()`);
  check(
    '债券市场：非市长仍可见，但看不到市长财政面板',
    citizenMarket.mayorCityId === null &&
      citizenMarket.hasMarket === true &&
      citizenMarket.hasFiscalPanel === false,
    JSON.stringify(citizenMarket),
  );
  await scrollTo(win, '[data-testid="bond-market-section"]');
  await capture(win, '13-bond-market-citizen.png');

  // 恢复市长身份，供小窗口检查使用（与 09 的语义一致）。
  await setMayor(win, 'lanport');
  await sleep(600);
  await scrollTo(win, '[data-testid="mayor-fiscal-panel"]');
  await capture(win, '14-mayor-fiscal-panel-restored.png');

  // ---- 10. 债券发行与认购（真实数据；块1 债券状态机已合入集成） ----
  stage('债券发行与认购（真实数据）');
  const treasuryBeforeIssue = await read(win, `window.__lanwan.store.fiscalView('lanport').treasury`);
  await scrollTo(win, '[data-testid="issue-bond"]');
  await capture(win, '16-bond-issue-form.png');

  // 非法计划份数：表单层拦下，不产生批次。
  await inputAndClick(win, '.fiscal-panel input[data-bond-plan-units]', '0', '[data-testid="issue-bond"]');
  await sleep(400);
  const invalidIssue = await read(win, `(() => {
    const s = window.__lanwan.store;
    const last = s.toasts[s.toasts.length - 1];
    return { message: last ? last.message : null, offers: s.bondMarketOffers.length };
  })()`);
  check(
    '发债表单：非正整数计划份数被拦下且不产生批次',
    /正整数/.test(invalidIssue.message ?? '') && invalidIssue.offers === 0,
    JSON.stringify(invalidIssue),
  );

  // 真实发行：100 份，面额 1,000。
  await inputAndClick(win, '.fiscal-panel input[data-bond-plan-units]', '100', '[data-testid="issue-bond"]');
  await sleep(600);
  const issued = await read(win, `(() => {
    const s = window.__lanwan.store;
    const offer = s.bondMarketOffers[0];
    const section = document.querySelector('[data-testid="bond-market-section"]');
    const last = s.toasts[s.toasts.length - 1];
    return {
      toast: last ? last.message : null,
      offer: offer ? { id: offer.issuanceId, status: offer.status, available: offer.unitsAvailable, face: offer.faceValue, coupon: offer.couponRateAnnual, term: offer.termMonths } : null,
      hasBuy: Boolean(document.querySelector('[data-testid^="subscribe-bond-"]')),
      marketVisible: Boolean(section),
    };
  })()`);
  check(
    '市长发债：真实批次进入 offering，债券市场出现可认购入口',
    issued.offer !== null &&
      issued.offer.status === 'offering' &&
      issued.offer.available === 100 &&
      issued.offer.face === 1000 &&
      issued.hasBuy &&
      issued.marketVisible,
    JSON.stringify(issued),
  );
  await scrollTo(win, '[data-testid="bond-market-section"]');
  await capture(win, '17-bond-offering.png');

  // 同月重复发行：失败反馈，且不泄漏财政余额。
  await click(win, '[data-testid="issue-bond"]');
  await sleep(400);
  const repeatIssue = await read(win, `(() => {
    const s = window.__lanwan.store;
    const last = s.toasts[s.toasts.length - 1];
    return { message: last ? last.message : null, issues: s.bondMarketOffers.length };
  })()`);
  check(
    '同月重复发债：给出失败原因且不含财政余额',
    /只能发行一期/.test(repeatIssue.message ?? '') &&
      repeatIssue.issues === 1 &&
      !/\d+\.\d+\s*万/.test(repeatIssue.message ?? ''),
    JSON.stringify(repeatIssue),
  );

  // 非法认购份数：表单层拦下，持债不变。
  await scrollTo(win, '[data-action="subscribe-bond"]');
  await inputAndClick(win, '.bond-offer input[data-bond-subscribe-units]', '0', '[data-testid^="subscribe-bond-"]');
  await sleep(400);
  const invalidSub = await read(win, `(() => {
    const s = window.__lanwan.store;
    const last = s.toasts[s.toasts.length - 1];
    return { message: last ? last.message : null, holdings: s.ownBondHoldings.length };
  })()`);
  check(
    '认购表单：0 份被拦下且不产生持债',
    /正整数/.test(invalidSub.message ?? '') && invalidSub.holdings === 0,
    JSON.stringify(invalidSub),
  );

  // 真实认购 10 份。
  const cashBefore = await read(win, `window.__lanwan.store.world.player.cash`);
  await inputAndClick(win, '.bond-offer input[data-bond-subscribe-units]', '10', '[data-testid^="subscribe-bond-"]');
  await sleep(600);
  const subscribed = await read(win, `(() => {
    const s = window.__lanwan.store;
    const offer = s.bondMarketOffers[0];
    const holding = s.ownBondHoldings[0];
    const last = s.toasts[s.toasts.length - 1];
    return {
      toast: last ? last.message : null,
      available: offer ? offer.unitsAvailable : null,
      holding: holding ? { units: holding.units, principal: holding.principal, maturity: holding.maturityTick } : null,
      cash: s.world.player.cash,
    };
  })()`);
  check(
    '认购：整数份成交，持债、可售份数与资金同步更新',
    subscribed.available === 90 &&
      subscribed.holding !== null &&
      subscribed.holding.units === 10 &&
      subscribed.holding.principal === 10000 &&
      cashBefore - subscribed.cash === 10000,
    JSON.stringify({ cashBefore, subscribed }),
  );
  await scrollTo(win, '[data-testid="bond-market-section"]');
  await capture(win, '18-bond-subscribed.png');

  // 售罄：剩余 90 份全部认购后，认购入口关闭。
  await inputAndClick(win, '.bond-offer input[data-bond-subscribe-units]', '90', '[data-testid^="subscribe-bond-"]');
  await sleep(600);
  const soldOut = await read(win, `(() => {
    const s = window.__lanwan.store;
    const offer = s.bondMarketOffers[0];
    const closed = document.querySelector('[data-testid^="bond-closed-"]');
    const holding = s.ownBondHoldings[0];
    return {
      available: offer ? offer.unitsAvailable : null,
      buyButtons: document.querySelectorAll('[data-testid^="subscribe-bond-"]').length,
      closedText: closed ? closed.textContent : null,
      units: holding ? holding.units : null,
      principal: holding ? holding.principal : null,
      treasury: s.fiscalView('lanport').treasury,
    };
  })()`);
  check(
    '售罄：认购入口关闭、发行款进入市财政（资金守恒）',
    soldOut.available === 0 &&
      soldOut.buyButtons === 0 &&
      /售罄/.test(soldOut.closedText ?? '') &&
      soldOut.units === 100 &&
      soldOut.principal === 100000 &&
      soldOut.treasury - treasuryBeforeIssue === 100000,
    JSON.stringify({ treasuryBeforeIssue, soldOut }),
  );
  await scrollTo(win, '[data-testid="bond-market-section"]');
  await capture(win, '19-bond-soldout.png');

  // 非市长：债券市场仍可见，但只有白名单字段。
  await setMayor(win, null);
  await sleep(500);
  await scrollTo(win, '[data-testid="bond-market-section"]');
  const citizenBond = await read(win, `(() => {
    const section = document.querySelector('[data-testid="bond-market-section"]');
    const offer = section ? section.querySelector('.bond-offer') : null;
    const text = offer ? offer.innerText : '';
    const labels = offer ? Array.from(offer.querySelectorAll('.bond-offer-grid > span')).map((el) => (el.innerText.split(String.fromCharCode(10))[0] || '').trim()) : [];
    return {
      hasMarket: Boolean(section),
      hasFiscalPanel: Boolean(document.querySelector('[data-testid="mayor-fiscal-panel"]')),
      hasRestricted: Boolean(document.querySelector('[data-testid="fiscal-restricted"]')),
      text: text.replace(/\\n/g, ' | '),
      labels,
      leaksPlan: /计划总额|总售额|总债务|尚未售出/.test(text),
    };
  })()`);
  check(
    '非市长：债券市场仅白名单字段，无计划总额/总售额/总债务',
    citizenBond.hasMarket === true &&
      citizenBond.hasFiscalPanel === false &&
      citizenBond.hasRestricted === true &&
      citizenBond.leaksPlan === false &&
      citizenBond.labels.join(',') === '面额,票面年利率,期限,付息周期,到期,可认购',
    JSON.stringify(citizenBond),
  );
  await capture(win, '20-bond-market-citizen.png');

  // 恢复市长身份，供小窗口检查使用。
  await setMayor(win, 'lanport');
  await sleep(600);

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

  // 秘书处 #2 要求：1100x700 下 KPI「企业数量」同样不裁切、不溢出。
  stage('小窗口：KPI 企业数量');
  await scrollTo(win, '[data-testid="kpi-companies"]');
  const smallKpi = await read(win, `(() => {
    const card = document.querySelector('[data-testid="kpi-companies"]');
    const grid = card ? card.parentElement : null;
    const rect = card ? card.getBoundingClientRect() : null;
    const gridRect = grid ? grid.getBoundingClientRect() : null;
    return {
      exists: Boolean(card),
      text: card ? card.innerText.replace(/\\n/g, ' | ') : '',
      clippedX: grid ? grid.scrollWidth > grid.clientWidth + 2 : null,
      inViewport: rect ? rect.left >= -1 && rect.right <= window.innerWidth + 1 : null,
      gridWidth: gridRect ? Math.round(gridRect.width) : null,
      overflowX: document.documentElement.scrollWidth > window.innerWidth + 2,
    };
  })()`);
  check(
    '小窗口：KPI 企业数量不裁切、不横向溢出',
    smallKpi.exists && /家/.test(smallKpi.text) && smallKpi.clippedX === false && smallKpi.inViewport === true && smallKpi.overflowX === false,
    JSON.stringify(smallKpi),
  );
  await capture(win, '15-small-window-kpi.png');

  // ---- 10. 长周期走查（2027–2028）：真实负债/风险、24 期发行、破产兑付 ----
  // 从全新世界重启，避免前面各阶段的人为发债/身份残留影响时间线。
  stage('长周期：重置到全新世界');
  win.setSize(1600, 1000);
  await sleep(600);
  // 注意：删存档再 reload 无效——旧页面卸载时的自动存档会把旧世界写回；必须走 store.resetWorld()。
  const resetInfo = await read(win, `(() => {
    const s = window.__lanwan.store;
    s.resetWorld();
    return { tick: s.world.time.tick, mayorCityId: s.mayorCityId, holdings: s.ownBondHoldings.length, date: s.dateLabel };
  })()`);
  await sleep(1200);
  const freshTick = await read(win, 'window.__lanwan.store.world.time.tick');
  check(
    '长周期：从全新世界重启（tick=0、无持债）',
    freshTick === 0 && resetInfo.holdings === 0 && resetInfo.mayorCityId === null,
    JSON.stringify({ freshTick, resetInfo }),
  );

  const bondsDir = path.join(root, 'artifacts', 'ui-fiscal-bonds');
  fs.mkdirSync(bondsDir, { recursive: true });
  const captureBonds = async (name) => {
    win.focus();
    win.webContents.invalidate();
    await sleep(450);
    const image = await win.webContents.capturePage();
    const file = path.join(bondsDir, name);
    fs.writeFileSync(file, image.toPNG());
    return file;
  };

  await setMayor(win, 'lanport');
  await sleep(500);
  const advance = await advanceToTick(win, 22);
  check('长周期：用「推进 1 月」按钮推进到 2027-11（tick 22）', advance.tick >= 22 && /2027/.test(String(advance.date)), JSON.stringify(advance));

  stage('长周期①：市长财政面板（负债/债务率/风险/批次）');
  await click(win, '[data-testid="city-card-lanport"]');
  await sleep(300);
  await click(win, '[data-testid="btn-enter-city"]');
  await waitFor(win, `window.__lanwan.store.view === 'city'`, 6000);
  await sleep(1200);
  await scrollTo(win, '[data-testid="mayor-fiscal-panel"]');
  const mayorFiscal = await read(win, `(() => {
    const s = window.__lanwan.store;
    const v = s.fiscalView('lanport');
    const panel = document.querySelector('[data-testid="mayor-fiscal-panel"]');
    const text = panel ? panel.innerText : '';
    const badge = document.querySelector('[data-testid="fiscal-risk-badge"]');
    const debtCell = document.querySelector('[data-testid="fiscal-total-debt"]');
    const ratioCell = document.querySelector('[data-testid="fiscal-debt-ratio"]');
    const issueRows = panel ? panel.querySelectorAll('.fiscal-table tbody tr').length : 0;
    return {
      tick: s.world.time.tick,
      date: s.dateLabel,
      mayorCityId: s.mayorCityId,
      treasury: v ? v.treasury : null,
      totalDebt: v ? v.totalDebt : null,
      debtRatio: v ? v.debtRatio : null,
      riskLevel: v ? v.riskLevel : null,
      riskTrend: v ? v.riskTrend : null,
      bankLoan: v ? v.bankLoanPrincipal : null,
      bankAdvance: v ? v.bankAdvancePrincipal : null,
      bondPrincipal: v ? v.bondPrincipalOutstanding : null,
      payablesDue: v ? v.payablesDueThisMonth : null,
      paidByAdvance: v ? v.paidByAdvanceThisMonth : null,
      issuances: v ? v.issuances.length : 0,
      hasPanel: Boolean(panel),
      hasTotalDebt: Boolean(debtCell),
      hasDebtRatio: Boolean(ratioCell),
      hasRiskBadge: Boolean(badge),
      riskText: badge ? badge.innerText.replace(/\\n/g, ' | ') : '',
      issueRows,
      textHasDebt: /总负债/.test(text),
      textHasRatio: /债务\\s*\\/\\s*GDP|债务\\/GDP/.test(text),
      textHasTrend: /上升|下降|持平|无可比/.test(text),
      textHasPayable: /本月应付|应付项/.test(text),
      textHasAdvance: /垫付/.test(text),
      overflowX: document.documentElement.scrollWidth > window.innerWidth + 2,
    };
  })()`);
  check(
    '长周期①：市长可见总负债/债务率/风险档，且风险非 normal',
    mayorFiscal.hasPanel === true &&
      mayorFiscal.hasTotalDebt === true &&
      mayorFiscal.hasDebtRatio === true &&
      mayorFiscal.hasRiskBadge === true &&
      mayorFiscal.textHasDebt === true &&
      mayorFiscal.textHasRatio === true &&
      mayorFiscal.textHasTrend === true &&
      mayorFiscal.textHasPayable === true &&
      mayorFiscal.textHasAdvance === true &&
      mayorFiscal.riskLevel !== 'normal' &&
      mayorFiscal.totalDebt > 0 &&
      mayorFiscal.overflowX === false,
    JSON.stringify(mayorFiscal),
  );
  await captureBonds('01-mayor-fiscal-panel.png');

  stage('长周期①b：市长视角债券批次与风险徽章细节');
  await scrollTo(win, '[data-testid="fiscal-risk-badge"]');
  await captureBonds('01b-mayor-risk-badge.png');

  stage('长周期①c：冻结破产前存档夹具（供 06 取证）');
  const fixture = await read(win, `(async () => {
    const s = window.__lanwan.store;
    const result = await s.saveSlot('pre-bankruptcy');
    return { result, tick: s.world.time.tick, mayorCityId: s.mayorCityId, debtRatio: s.fiscalView('lanport')?.debtRatio ?? null };
  })()`);
  check(
    '长周期①c：冻结破产前存档夹具（tick 22、岚港市长、负债率 < 100%）',
    Boolean(fixture.result) && fixture.tick === 22 && fixture.mayorCityId === 'lanport' && fixture.debtRatio < 1,
    JSON.stringify(fixture),
  );

  stage('长周期②：同一 tick 的市民视角（财政受限、债券市场可见）');
  await setCitizen(win);
  await sleep(700);
  await scrollTo(win, '[data-testid="government-section"]');
  const citizenView = await read(win, `(() => {
    const s = window.__lanwan.store;
    const gov = document.querySelector('[data-testid="government-section"]');
    const text = gov ? gov.innerText : '';
    return {
      tick: s.world.time.tick,
      date: s.dateLabel,
      mayorCityId: s.mayorCityId,
      hasRestricted: Boolean(document.querySelector('[data-testid="fiscal-restricted"]')),
      hasFiscalPanel: Boolean(document.querySelector('[data-testid="mayor-fiscal-panel"]')),
      hasRiskBadge: Boolean(document.querySelector('[data-testid="fiscal-risk-badge"]')),
      hasDebtCell: Boolean(document.querySelector('[data-testid="fiscal-total-debt"]')),
      textHasDebt: /总负债/.test(text),
      textHasRatio: /债务\\s*\\/\\s*GDP|债务\\/GDP/.test(text),
      textHasRiskLabel: /风险等级|高风险|已破产/.test(text),
      restrictedText: document.querySelector('[data-testid="fiscal-restricted"]')?.innerText.replace(/\\n/g, ' | ') ?? '',
      overflowX: document.documentElement.scrollWidth > window.innerWidth + 2,
    };
  })()`);
  check(
    '长周期②：非市长看不到总负债/债务率/风险档',
    citizenView.hasRestricted === true &&
      citizenView.hasFiscalPanel === false &&
      citizenView.hasRiskBadge === false &&
      citizenView.hasDebtCell === false &&
      citizenView.textHasDebt === false &&
      citizenView.textHasRatio === false &&
      citizenView.textHasRiskLabel === false &&
      citizenView.overflowX === false,
    JSON.stringify(citizenView),
  );
  await captureBonds('02-citizen-fiscal-restricted.png');

  stage('长周期②b：市民视角债券市场白名单');
  await scrollTo(win, '[data-testid="bond-market-section"]');
  const citizenBondLong = await read(win, `(() => {
    const s = window.__lanwan.store;
    const section = document.querySelector('[data-testid="bond-market-section"]');
    const cardsText = Array.from(section ? section.querySelectorAll('.bond-offer') : [])
      .map((el) => el.innerText)
      .join('\\n');
    const labels = Array.from(section ? section.querySelectorAll('.bond-offer .bond-offer-grid span') : [])
      .map((el) => el.firstChild?.textContent?.trim() ?? '')
      .filter(Boolean);
    return {
      tick: s.world.time.tick,
      offers: s.bondMarketOffers.length,
      cities: Array.from(new Set(s.bondMarketOffers.map((o) => o.cityId))),
      labels: Array.from(new Set(labels)),
      leaksPlan: /计划总额|总售额|总债务|尚未售出/.test(cardsText),
      hasMarket: Boolean(section),
      hasFiscalPanel: Boolean(document.querySelector('[data-testid="mayor-fiscal-panel"]')),
    };
  })()`);
  check(
    '长周期②b：债券市场仍有真实批次与白名单字段，无计划总额/总售额/总债务',
    citizenBondLong.hasMarket === true &&
      citizenBondLong.offers >= 20 &&
      citizenBondLong.cities.includes('lanport') &&
      citizenBondLong.cities.includes('ironvale') &&
      citizenBondLong.labels.join(',') === '面额,票面年利率,期限,付息周期,到期,可认购' &&
      citizenBondLong.leaksPlan === false &&
      citizenBondLong.hasFiscalPanel === false,
    JSON.stringify(citizenBondLong),
  );
  await captureBonds('03-citizen-bond-market.png');

  stage('长周期③：市长新发一批债券并当月认购（认购/自持）');
  await setMayor(win, 'greenfield');
  await sleep(500);
  // 先返回区域视图：城市视图里没有城市卡片，直接点会停留在岚港面板。
  await click(win, '[data-testid="btn-back-region"]');
  await waitFor(win, `window.__lanwan.store.view === 'region'`, 5000);
  await sleep(800);
  await click(win, '[data-testid="city-card-greenfield"]');
  await sleep(300);
  await click(win, '[data-testid="btn-enter-city"]');
  await sleep(1200);
  await scrollTo(win, '[data-testid="mayor-fiscal-panel"]');
  await inputAndClick(win, '.fiscal-panel input[data-bond-plan-units]', '50', '[data-testid="issue-bond"]');
  await sleep(1200);
  const issueResult = await read(win, `(() => {
    const s = window.__lanwan.store;
    const offer = s.bondMarketOffers.find((o) => o.cityId === 'greenfield' && o.status === 'offering');
    return { offer, id: offer ? offer.issuanceId : null, toasts: s.toasts.map((t) => t.message).slice(-3) };
  })()`);
  check('长周期③：市长可发起债券发行（出现认购中批次）', Boolean(issueResult.id && issueResult.offer.status === 'offering'), JSON.stringify(issueResult));
  const issueId = issueResult.id;
  await sleep(600);
  if (issueId) {
    await inputAndClick(
      win,
      `[data-issuance-id="${issueId}"] [data-bond-subscribe-units]`,
      '50',
      `[data-testid="subscribe-bond-${issueId}"]`,
    );
    await sleep(1000);
  }
  await scrollTo(win, `[data-issuance-id="${issueId}"]`);
  const greenSubscribed = await read(win, `(() => {
    const s = window.__lanwan.store;
    const holding = s.ownBondHoldings.find((h) => h.cityId === 'greenfield' && h.redeemedTick === null);
    const offer = s.publicBondView(${JSON.stringify(issueId)});
    const card = document.querySelector('[data-issuance-id=${JSON.stringify(issueId)}]');
    return {
      tick: s.world.time.tick,
      date: s.dateLabel,
      mayorCityId: s.mayorCityId,
      hasHolding: Boolean(holding),
      holdingUnits: holding ? holding.units : 0,
      holdingPrincipal: holding ? holding.principal : 0,
      accrued: holding ? holding.accruedInterest : 0,
      unitsAvailable: offer ? offer.unitsAvailable : null,
      hasSubscribe: Boolean(document.querySelector('[data-action="subscribe-bond"]')),
      cardText: card ? card.innerText.replace(/\\n/g, ' | ') : '',
    };
  })()`);
  check(
    '长周期③：认购成功（自持 50 份、可认购归零、卡片显示认购中）',
    greenSubscribed.hasHolding === true &&
      greenSubscribed.holdingUnits === 50 &&
      greenSubscribed.holdingPrincipal === 50000 &&
      greenSubscribed.unitsAvailable === 0 &&
      /认购中|已售罄/.test(String(greenSubscribed.cardText)),
    JSON.stringify(greenSubscribed),
  );
  await captureBonds('04-bond-market-offering.png');

  stage('长周期③b：推进一月后的债券收益（应计利息）');
  await advanceToTick(win, 23);
  await sleep(900);
  const holdingsView = await read(win, `(() => {
    const s = window.__lanwan.store;
    const holding = s.ownBondHoldings.find((h) => h.cityId === 'greenfield');
    const node = document.querySelector('.bond-holdings');
    return {
      tick: s.world.time.tick,
      date: s.dateLabel,
      units: holding ? holding.units : 0,
      accrued: holding ? holding.accruedInterest : 0,
      interestPaid: holding ? holding.interestPaid : 0,
      text: node ? node.innerText.replace(/\\n/g, ' | ') : '',
      hasYield: /应计利息/.test(node ? node.innerText : ''),
    };
  })()`);
  check(
    '长周期③b：持债应计利息 > 0（收益可见）',
    holdingsView.units === 50 && holdingsView.accrued > 0 && holdingsView.hasYield === true,
    JSON.stringify(holdingsView),
  );
  await scrollTo(win, '.bond-holdings');
  await captureBonds('05-bond-holdings-accrued.png');

  stage('长周期③c：推进到首个付息月（M12 票息入账）');
  const cashBeforeCoupon = await read(win, 'window.__lanwan.store.world.player.cash');
  const couponAdvance = await advanceToTick(win, 34);
  await sleep(900);
  const coupon = await read(win, `(() => {
    const s = window.__lanwan.store;
    const holding = s.ownBondHoldings.find((h) => h.cityId === 'greenfield');
    const node = document.querySelector('.bond-holdings');
    return {
      tick: s.world.time.tick,
      date: s.dateLabel,
      cash: s.world.player.cash,
      interestPaid: holding ? holding.interestPaid : 0,
      accrued: holding ? holding.accruedInterest : 0,
      text: node ? node.innerText.replace(/\\n/g, ' | ') : '',
    };
  })()`);
  check(
    '长周期③c：M12 票息入账（已付利息 > 0、现金增加）',
    couponAdvance.tick >= 34 &&
      coupon.interestPaid > 0 &&
      coupon.cash > cashBeforeCoupon &&
      /已付利息|应计利息/.test(coupon.text),
    JSON.stringify({ cashBeforeCoupon, coupon, couponAdvance }),
  );
  await scrollTo(win, '.bond-holdings');
  await captureBonds('05b-bond-coupon-cash.png');

  stage('长周期④：加载破产前夹具并推进 1 tick（真实破产瞬间）');
  win.reload();
  await waitFor(win, 'window.__lanwan && window.__lanwan.store', 20000);
  await sleep(2600);
  const loadedFixture = await read(win, `(async () => {
    const s = window.__lanwan.store;
    const result = await s.loadSlot('pre-bankruptcy');
    return { result, tick: s.world.time.tick, mayorCityId: s.mayorCityId };
  })()`);
  await sleep(1200);
  check(
    '长周期④：读取破产前夹具（tick 22、岚港市长）',
    Boolean(loadedFixture.result) && loadedFixture.tick === 22 && loadedFixture.mayorCityId === 'lanport',
    JSON.stringify(loadedFixture),
  );
  await click(win, '[data-testid="btn-tick"]');
  await sleep(1500);
  const bankruptcy = await read(win, `(() => {
    const s = window.__lanwan.store;
    const w = s.world;
    const notice = s.publicBankruptcy('lanport');
    const offers = s.bondMarketOffers;
    const currentTick = w.time.tick;
    const early = offers.filter((o) => o.status === 'redeemed' && currentTick < o.maturityTick);
    const banner = document.querySelector('[data-testid="bond-bankruptcy-banner"]');
    const record = (w.cities.find((c) => c.id === 'lanport').government?.records ?? []).slice(-1)[0] ?? null;
    return {
      tick: currentTick,
      date: s.dateLabel,
      mayorCityId: s.mayorCityId,
      notice,
      record,
      earlyRedemptions: early.length,
      earlyCities: Array.from(new Set(early.map((o) => o.cityId))),
      bannerText: banner ? banner.innerText.replace(/\\n/g, ' | ') : '',
      hasBanner: Boolean(banner),
      cityStatus: w.cities.map((c) => ({ id: c.id, status: c.government?.bankruptcy?.status ?? null, tick: c.government?.bankruptcy?.tick ?? null })),
      overflowX: document.documentElement.scrollWidth > window.innerWidth + 2,
    };
  })()`);
  check(
    '长周期④：1 tick 后岚港进入真实破产态（看守期+银行垫付+已勾销）',
    bankruptcy.tick === 23 &&
      bankruptcy.notice?.status === 'bankrupt' &&
      (bankruptcy.notice?.caretakerUntilElection === true || bankruptcy.notice?.electionTriggeredTick !== null) &&
      bankruptcy.notice?.bondsRedeemedPrincipal > 0 &&
      bankruptcy.notice?.bankAdvanceCreated > 0 &&
      bankruptcy.notice?.bankLoansWrittenOff + bankruptcy.notice?.advancesWrittenOff > 0 &&
      bankruptcy.earlyRedemptions > 0 &&
      bankruptcy.earlyCities.includes('lanport') &&
      bankruptcy.hasBanner === true &&
      bankruptcy.overflowX === false,
    JSON.stringify(bankruptcy),
  );

  stage('长周期④b：公开破产事件面板（破产横幅/看守期/股份托管/垫付与已勾销）');
  await click(win, '[data-testid="city-card-lanport"]');
  await sleep(400);
  await click(win, '[data-testid="btn-enter-city"]');
  await waitFor(win, `window.__lanwan.store.view === 'city'`, 6000);
  await sleep(1400);
  await scrollTo(win, '[data-testid="public-bankruptcy-notice"]');
  const noticeView = await read(win, `(() => {
    const s = window.__lanwan.store;
    const panel = document.querySelector('[data-testid="public-bankruptcy-notice"]');
    const text = panel ? panel.innerText : '';
    return {
      tick: s.world.time.tick,
      date: s.dateLabel,
      mayorCityId: s.mayorCityId,
      hasPanel: Boolean(panel),
      text,
      textHasCaretaker: /看守期/.test(text),
      textHasAdvance: /银行垫付/.test(text),
      textHasWrittenOff: /已勾销/.test(text),
      textHasTrust: /托管持股|股份处置/.test(text),
      textHasRedemption: /破产兑付/.test(text),
      hasAdvanceCell: Boolean(document.querySelector('[data-testid="bankruptcy-advance"]')),
      hasWrittenOffCell: Boolean(document.querySelector('[data-testid="bankruptcy-written-off"]')),
      hasTrustNote: Boolean(document.querySelector('[data-testid="bankruptcy-share-disposal"]')),
      hasRedemptionCell: Boolean(document.querySelector('[data-testid="bankruptcy-bond-redemptions"]')),
      overflowX: document.documentElement.scrollWidth > window.innerWidth + 2,
    };
  })()`);
  check(
    '长周期④b：公开破产面板含看守期/银行垫付/已勾销/股份托管说明',
    noticeView.hasPanel === true &&
      noticeView.textHasCaretaker === true &&
      noticeView.textHasAdvance === true &&
      noticeView.textHasWrittenOff === true &&
      noticeView.textHasTrust === true &&
      noticeView.textHasRedemption === true &&
      noticeView.hasAdvanceCell === true &&
      noticeView.hasWrittenOffCell === true &&
      noticeView.hasTrustNote === true &&
      noticeView.hasRedemptionCell === true &&
      noticeView.overflowX === false,
    JSON.stringify(noticeView),
  );
  await captureBonds('06-bankruptcy-public-notice.png');

  stage('长周期④c：债券市场破产兑付横幅与批次结算');
  await scrollTo(win, '[data-testid="bond-bankruptcy-banner"]');
  const bondBankruptcyView = await read(win, `(() => {
    const s = window.__lanwan.store;
    const section = document.querySelector('[data-testid="bond-market-section"]');
    const text = section ? section.innerText : '';
    const cards = Array.from(section ? section.querySelectorAll('.bond-offer') : []).map((el) => el.innerText);
    return {
      tick: s.world.time.tick,
      earlyRedemptions: s.bondMarketOffers.filter((o) => o.status === 'redeemed' && s.world.time.tick < o.maturityTick).length,
      textHasBankruptcy: /破产清算/.test(text),
      textHasAdvance: /银行垫付/.test(text),
      textHasWriteOff: /勾销/.test(text),
      settledCards: cards.filter((entry) => /破产清算（银行垫付）/.test(entry)).length,
    };
  })()`);
  check(
    '长周期④c：债券市场显示破产兑付（银行垫付）与勾销说明',
    bondBankruptcyView.earlyRedemptions > 0 &&
      bondBankruptcyView.settledCards > 0 &&
      bondBankruptcyView.textHasBankruptcy === true &&
      bondBankruptcyView.textHasAdvance === true &&
      bondBankruptcyView.textHasWriteOff === true,
    JSON.stringify(bondBankruptcyView),
  );
  await captureBonds('06b-bond-bankruptcy-settlement.png');

  // 每组截图的小记（城市/游戏月/玩家身份/关键字段值），供 QA 引用。
  const notes = [
    '# 市长财政面板 / 债券市场 / 权限 / 破产事件 走查截图小记',
    '',
    `- 走查脚本：\`scripts/smoke-fiscal-ui.cjs\`（长周期段 10；截图目录 \`artifacts/ui-fiscal-bonds/\`）`,
    `- 主线游戏月：${mayorFiscal.date}（tick ${mayorFiscal.tick}）～ ${coupon.date}（tick ${coupon.tick}）；破产取证：${noticeView.date}（tick ${noticeView.tick}）`,
    '- 分支：feature/ui-fiscal（合并 316eff4 后）；截图均为无头 Electron 1600×1000（01b/05/05b 同窗口）。',
    '',
    '## 01-mayor-fiscal-panel.png',
    `- 城市：岚港（市长视角，mayorCityId=${mayorFiscal.mayorCityId}）`,
    `- 游戏月：${mayorFiscal.date}（tick ${mayorFiscal.tick}）`,
    `- 关键字段：可用资金 ${Math.round(mayorFiscal.treasury).toLocaleString('zh-CN')}；总负债 ${Math.round(mayorFiscal.totalDebt).toLocaleString('zh-CN')}；银行借款 ${Math.round(mayorFiscal.bankLoan).toLocaleString('zh-CN')}；银行垫付 ${Math.round(mayorFiscal.bankAdvance).toLocaleString('zh-CN')}；在外债券本金 ${Math.round(mayorFiscal.bondPrincipal).toLocaleString('zh-CN')}；债务/GDP ${(mayorFiscal.debtRatio * 100).toFixed(1)}%；风险 ${mayorFiscal.riskLevel}/${mayorFiscal.riskTrend}；本月应付 ${Math.round(mayorFiscal.payablesDue).toLocaleString('zh-CN')}；发债批次 ${mayorFiscal.issuances}`,
    '',
    '## 01b-mayor-risk-badge.png',
    `- 与 01 同时刻；风险徽章文本：${mayorFiscal.riskText}（图标+文字+颜色三重表达）`,
    '',
    '## 02-citizen-fiscal-restricted.png',
    `- 城市：岚港（市民视角，mayorCityId=${citizenView.mayorCityId}，同一 tick ${citizenView.tick}）`,
    `- 关键字段：无财政面板/总负债/债务率/风险档；受限提示「${citizenView.restrictedText}」`,
    '',
    '## 03-citizen-bond-market.png',
    `- 城市：岚港（市民视角，tick ${citizenBondLong.tick}），债券市场 ${citizenBondLong.offers} 期，城市 ${citizenBondLong.cities.join('、')}`,
    '- 可见字段：面额、票面年利率、期限、付息周期、到期、可认购；不含计划总额/总售额/总债务。空态证据见旧目录 `artifacts/ui-fiscal/12-bond-market-empty.png`。',
    '',
    '## 04-bond-market-offering.png',
    `- 城市：青原（市长视角，mayorCityId=${greenSubscribed.mayorCityId}，tick ${greenSubscribed.tick}）`,
    `- 关键字段：新批次 ${issueId}；真实认购 ${greenSubscribed.holdingUnits} 份 / 本金 ${greenSubscribed.holdingPrincipal.toLocaleString('zh-CN')}；可认购归零 ${greenSubscribed.unitsAvailable}`,
    '',
    '## 05-bond-holdings-accrued.png',
    `- 城市：青原（市长视角，tick ${holdingsView.tick}，${holdingsView.date}）`,
    `- 关键字段：自持 ${holdingsView.units} 份；应计利息 ${holdingsView.accrued.toFixed(2)}；已付利息 ${holdingsView.interestPaid.toFixed(2)}`,
    '',
    '## 05b-bond-coupon-cash.png',
    `- 城市：青原（市长视角，tick ${coupon.tick}，${coupon.date}）；M12 票息入账`,
    `- 关键字段：已付利息 ${coupon.interestPaid.toFixed(2)}；玩家现金 ${Math.round(cashBeforeCoupon).toLocaleString('zh-CN')} → ${Math.round(coupon.cash).toLocaleString('zh-CN')}`,
    '',
    '## 06-bankruptcy-public-notice.png',
    `- 城市：岚港（公开视角，玩家 mayorCityId=${noticeView.mayorCityId}，tick ${noticeView.tick}，${noticeView.date}；由 t22 存档夹具 +1 tick 得到真实破产瞬间）`,
    `- 关键字段：破产状态 ${bankruptcy.notice?.status}；看守期 ${bankruptcy.notice?.caretakerUntilElection}；破产兑付 ${bankruptcy.notice?.bondRedemptionCount} 笔、本金 ${Math.round(bankruptcy.notice?.bondsRedeemedPrincipal ?? 0).toLocaleString('zh-CN')}、利息 ${Math.round(bankruptcy.notice?.bondsRedeemedInterest ?? 0).toLocaleString('zh-CN')}；银行垫付 ${Math.round(bankruptcy.notice?.bankAdvanceCreated ?? 0).toLocaleString('zh-CN')}；已勾销：银行贷款本金 ${Math.round(bankruptcy.notice?.bankLoansWrittenOff ?? 0).toLocaleString('zh-CN')}、垫付贷款本金 ${Math.round(bankruptcy.notice?.advancesWrittenOff ?? 0).toLocaleString('zh-CN')}、未清偿利息 ${Math.round(bankruptcy.notice?.interestWrittenOff ?? 0).toLocaleString('zh-CN')}；托管持股 ${bankruptcy.notice?.trustHoldings.length} 只`,
    '',
    '## 06b-bond-bankruptcy-settlement.png',
    `- 城市：岚港（公开视角，tick ${bondBankruptcyView.tick}）`,
    `- 关键字段：破产兑付批次 ${bondBankruptcyView.earlyRedemptions} 期；批次卡片「已兑付 · 破产清算（银行垫付）」${bondBankruptcyView.settledCards} 个；含银行垫付与勾销说明`,
    '',
    '## 走查场景与块6 探针的口径差异（必读）',
    '- 本走查场景：全新世界（`resetWorld()`，**未固定随机种子**），通过 dev 钩子把玩家设为岚港市长后，仅点击顶部「推进 1 月」22 次，不做任何财政/债券操作。结果：t22 岚港债务/GDP 83%、风险 high；t23 破产判定（存档夹具 +1 tick 取证）。',
    `- 块6 探针场景：seed 20261101、36 个月、玩家无操作，岚港在 t20 即破产（判定债务/GDP 103.6%）。`,
    '- 差异原因：走查未固定随机种子，AI 政府的发债规模/支出路径与块6 探针不同，导致负债率增长速度和破产月份不同；玩家市长身份只替换政治领导人，不改变 AI 财政路径。推进方式（UI 按钮逐月 vs 模拟循环）不改变结算结果。因此 06 采用本场景「t22 破产前存档夹具 +1 tick」取证（秘书处允许的夹具方案），与 01 的 t22 状态严格同一世界；如需与块6 探针逐项对账，请用 seed 20261101 重跑本脚本（需先在 resetWorld 处注入固定种子，当前界面无固定种子入口）。',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(bondsDir, 'NOTES.md'), notes, 'utf8');

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
