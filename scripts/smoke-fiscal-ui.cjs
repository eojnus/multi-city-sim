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
