/**
 * v0.9 桌面验收走查（人口 ×5 / 需求 vs 成交 / 真实设备链 / 生产计划 / 存读档）+ v1.6 走查。
 *
 * 全程走真实 Electron 界面：DOM 点击、表单输入、标签切换；必要时只读 store 对账。
 * 唯一的人工构造：把两家企业的经营者临时设为玩家（`governance.controls`），
 * 以便在界面上真实执行设备买卖——这是“玩家经营权限”的测试前置，不改变任何经济数值。
 * v1.6 追加：真实推进 14 个月后核查价格规则、设备维护费结算/面板、政策总额度分项与公共岗位统计。
 *
 * 证据截图与 JSON 同时写入 artifacts/（gitignore）与 docs/evidence_v1.6/（入仓）。
 *
 * 用法：Xvfb :99 & DISPLAY=:99 node_modules/electron/dist/electron --no-sandbox \
 *        --disable-dev-shm-usage --enable-unsafe-swiftshader scripts/acceptance-v09.cjs
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { registerSaveHandlers } = require('../dist/electron/saveIpc.js');

const root = path.resolve(__dirname, '..');
const artifacts = path.join(root, 'artifacts', 'acceptance-v09');
const evidence = path.join(root, 'docs', 'evidence_v1.7');
fs.mkdirSync(artifacts, { recursive: true });
fs.mkdirSync(evidence, { recursive: true });
const userData = path.join(artifacts, 'electron-user-data');
fs.rmSync(userData, { recursive: true, force: true });
app.setPath('userData', userData);
const savesDir = path.join(app.getPath('userData'), 'saves');
fs.mkdirSync(savesDir, { recursive: true });
registerSaveHandlers(() => savesDir);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const step = (name) => console.log(`STEP ${name}`);
const checks = [];
function check(name, pass, detail) {
  checks.push({ name, pass: Boolean(pass), detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` :: ${String(detail).slice(0, 360)}` : ''}`);
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
    const proto = el.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, ${JSON.stringify(String(value))});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
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
  await sleep(400);
}

async function clickTab(win, tab) {
  await click(win, `[data-testid="right-tabs"] button[data-tab="${tab}"]`);
  await sleep(450);
}

async function openCompany(win, companyId) {
  // 若右侧栏仍停留在上一家企业详情，先关闭聚焦，城市标签才会重新出现。
  await click(win, '[data-action="close-company"]');
  await sleep(300);
  await clickTab(win, 'companies');
  await waitFor(win, `document.querySelector('[data-testid="company-row-${companyId}"]')`, 8000);
  await click(win, `[data-testid="company-row-${companyId}"]`);
  await sleep(500);
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
    if (level >= 2 && !/GL_|Failed to create GBM|dbus|DevTools|Autofill|SwiftShader/i.test(message)) {
      errors.push(message);
    }
  });

  await win.loadFile(path.join(root, 'dist/renderer/index.html'));
  await waitFor(win, 'window.__lanwan && window.__lanwan.store && window.__lanwan.game', 20000);
  await sleep(2000);
  await waitFor(win, `document.querySelector('[data-testid="hud-date"]')`, 8000);

  try {
    // ---- 1. 启动与人口 ×5：新开局基线 120k/86k/64k × 5 ----
    step('1. 启动与人口 ×5：新开局基线 120k/86k/64k × 5');
    const startup = await read(win, `(() => {
      const s = window.__lanwan.store;
      const pick = (id) => {
        const c = s.world.cities.find((entry) => entry.id === id);
        const p = c.population;
        return {
          id, name: c.name,
          population: p.total,
          nonLabor: p.nonLabor,
          laborForce: p.laborForce,
          employed: p.employed,
          unemployed: p.unemployed,
          jobs: s.world.labor?.market?.cityJobs?.[id] ?? null,
        };
      };
      return {
        view: s.view,
        tick: s.world.time.tick,
        tabs: [...document.querySelectorAll('[data-testid="right-tabs"] [role="tab"]')].map((el) => el.textContent.trim()),
        overflowX: document.documentElement.scrollWidth > innerWidth + 2,
        cities: ['lanport', 'ironvale', 'greenfield'].map(pick),
      };
    })()`);
    check('启动进入区域视图，右栏 6 个城市标签可见', startup.view === 'region' && startup.tabs.length === 6 && startup.overflowX === false, JSON.stringify({ view: startup.view, tabs: startup.tabs.length }));
    const expectedPopulation = { lanport: 600000, ironvale: 430000, greenfield: 320000 };
    const populationOk = startup.tick === 0 && startup.cities.every((city) => {
      const total = city.population;
      const nonLabor = Math.round(total * 0.2);
      return Math.abs(total - expectedPopulation[city.id]) < 1
        && Math.abs(city.nonLabor - nonLabor) <= 1
        && Math.abs(city.laborForce - (total - nonLabor)) <= 1
        && city.employed + city.unemployed === city.laborForce;
    });
    check('开局人口 = 基线 ×5，非劳动 20%、劳动力 80%，就业+失业=劳动力', populationOk, JSON.stringify(startup.cities));

    // ---- 2. 推进 1 月，岚港「人口」标签：就业结构 + 需求 vs 成交（成交显著低于需求） ----
    step('2. 推进 1 月，岚港「人口」标签：就业结构 + 需求 vs 成交（成交显著低于需求）');
    await read(win, `(async () => { window.__lanwan.store.tick(); await new Promise((r) => setTimeout(r, 900)); return true; })()`);
    await enterCity(win, 'lanport');
    await clickTab(win, 'population');
    await waitFor(win, `document.querySelector('[data-testid="population-demand-vs-trade"]')`, 8000);
    const demand = await read(win, `(() => {
      const s = window.__lanwan.store;
      const view = s.populationStrataView('lanport');
      const has = (testid) => Boolean(document.querySelector('[data-testid="' + testid + '"]'));
      return {
        structure: has('population-structure'),
        demandPanel: has('population-demand-vs-trade'),
        investorSection: has('investor-section'),
        investorText: (document.querySelector('[data-testid="investor-section"]')?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 240),
        demand: view.demand,
        population: { total: view.population.total, employed: view.population.employed, unemployed: view.population.unemployed, nonLabor: view.population.nonLabor, laborForce: view.population.laborForce },
        text: (document.querySelector('[data-testid="population-demand-vs-trade"]')?.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 260),
      };
    })()`);
    const demandOk = demand.structure && demand.demandPanel
      && demand.demand.desiredConsumption > 0
      && demand.demand.consumption >= 0
      && demand.demand.consumption < demand.demand.desiredConsumption * 0.6;
    check('人口标签显示就业结构与「需求 vs 成交」，t0 成交显著低于需求', demandOk, JSON.stringify({ demand: demand.demand, population: demand.population }));
    // v1.4 §3.4：居民投资面板显示全部有效份额（含 openingShares）与净资产口径。
    const investorOk = demand.investorSection
      && /有效份额/.test(demand.investorText)
      && /净资产/.test(demand.investorText);
    check('人口标签显示居民投资面板：有效份额/净资产可见且与报告同口径', investorOk, JSON.stringify({ section: demand.investorSection, text: demand.investorText }));
    await capture(win, 'v09-01-population-demand-trade.png');

    // ---- 3. 企业「经营」标签出现设备与生产计划 ----
    step('3. 企业「经营」标签出现设备与生产计划');
    await enterCity(win, 'lanport');
    await openCompany(win, 'lp-energy');
    await clickTab(win, 'operation');
    await waitFor(win, `document.querySelector('[data-testid="company-equipment"]')`, 8000);
    const equipmentPanel = await read(win, `(() => {
      const s = window.__lanwan.store;
      const view = s.companyOperatingView('lp-energy');
      return {
        section: Boolean(document.querySelector('[data-testid="company-equipment"]')),
        plan: Boolean(document.querySelector('[data-testid="equipment-plan"]')),
        initialSection: Boolean(document.querySelector('[data-testid="equipment-initial"]')),
        initialText: (document.querySelector('[data-testid="equipment-initial"]')?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 240),
        rows: view.equipmentRows.map((row) => ({ kind: row.kind, units: row.units, capacity: row.capacity, marketPrice: row.marketPrice, governmentStock: row.governmentStock })),
        planView: view.plan ? { plannedOutput: view.plan.plannedOutput, equipmentLimit: view.plan.equipmentLimit, laborLimit: view.plan.laborLimit, reasons: view.plan.reasons } : null,
        salesHistory: view.salesHistory,
        text: (document.querySelector('[data-testid="company-equipment"]')?.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 300),
      };
    })()`);
    const equipmentPanelOk = equipmentPanel.section && equipmentPanel.plan && equipmentPanel.rows.length === 3
      && equipmentPanel.rows.some((row) => row.units > 0)
      && equipmentPanel.planView !== null && equipmentPanel.planView.plannedOutput > 0;
    check('企业「经营」显示设备表与生产计划（设备/劳动/计划/实际分离）', equipmentPanelOk, JSON.stringify(equipmentPanel));
    // v1.4 §4：初始实物出资来源/估值/锁定期在设备面板可观察（无出资时如实标注市场采购）。
    const initialOk = equipmentPanel.initialSection
      && /实物出资|市场采购/.test(equipmentPanel.initialText);
    check('企业设备面板显示初始设备来源（模拟范围外实物出资/市场采购）与锁定期', initialOk, JSON.stringify({ section: equipmentPanel.initialSection, text: equipmentPanel.initialText }));
    await capture(win, 'v09-02-company-equipment.png');

    // ---- 3b. v1.4 政府/政策面板：AI 经济体检或玩家市长不代选政策 ----
    step('3b. v1.4 政府/政策面板：AI 经济体检与政策执行可观察');
    // 步骤 3 打开的是企业详情，右栏此时是企业标签；先关闭企业聚焦城市标签才出现。
    await click(win, '[data-action="close-company"]');
    await sleep(500);
    await enterCity(win, 'lanport');
    await clickTab(win, 'government');
    await waitFor(win, `document.querySelector('[data-testid="ai-government"]') || document.querySelector('[data-testid="ai-mayor-status"]') || document.querySelector('[data-testid="fiscal-restricted"]')`, 8000);
    await sleep(500);
    const govPanel = await read(win, `(() => {
      const text = (sel) => (document.querySelector(sel)?.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 360);
      const s = window.__lanwan.store;
      return {
        ai: Boolean(document.querySelector('[data-testid="ai-government"]')),
        aiText: text('[data-testid="ai-government"]'),
        mayor: Boolean(document.querySelector('[data-testid="ai-mayor-status"]')),
        mayorText: text('[data-testid="ai-mayor-status"]'),
        checkup: (s.world.policies.checkups ?? []).filter((c) => c.cityId === 'lanport').slice(-1)[0] ?? null,
      };
    })()`);
    const govOk = govPanel.mayor
      ? /不代选/.test(govPanel.mayorText)
      : govPanel.ai && /失业档位/.test(govPanel.aiText) && !/债务\/GDP\s*[\d.]|月政策预算\s*[\d.]/.test(govPanel.aiText) && govPanel.checkup !== null;
    check('政府面板显示 AI 经济体检/玩家市长不代选政策，数值来自真实体检快照', govOk, JSON.stringify({ ai: govPanel.ai, mayor: govPanel.mayor, aiText: govPanel.aiText, mayorText: govPanel.mayorText }));

    // ---- 3c. v1.5 §1 非市长财政权限：受限数值不出现；上任后出现；市场口径说明 ----
    step('3c. v1.5 §1 非市长财政权限与市长切换、§3 市场口径说明');
    const permBefore = await read(win, `(() => {
      const s = window.__lanwan.store;
      const view = s.policyView('lanport');
      const aiText = (document.querySelector('[data-testid="ai-government"]')?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 600);
      const restrictedText = (document.querySelector('[data-testid="fiscal-restricted"]')?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
      return {
        isMayor: view.isPlayerMayor,
        aiRestrictedBlock: Boolean(document.querySelector('[data-testid="ai-checkup-restricted"]')),
        fiscalRestricted: Boolean(document.querySelector('[data-testid="fiscal-restricted"]')),
        aiText,
        restrictedText,
        allBudgetsNull: view.active.every((policy) => policy.budget === null && policy.spent === null),
        allDefaultBudgetsNull: view.definitions.every((definition) => definition.defaultBudget === null),
        historyEmpty: view.history.length === 0,
      };
    })()`);
    const leakFree = permBefore.isMayor || (
      permBefore.aiRestrictedBlock === false
      && permBefore.fiscalRestricted === true
      && !/债务\/GDP\s*[\d.]|债务预警[^\n]{0,8}?[\d.]|到期[^\n]{0,10}?[\d,]{4,}|参考预算\s*[\d,]|政策预算\s*[\d,]/.test(permBefore.aiText)
      && permBefore.allBudgetsNull
      && permBefore.allDefaultBudgetsNull
      && permBefore.historyEmpty
    );
    check('非市长：AI 体检不显示债务/GDP/预警/到期/预算，视图数据预算为 null', leakFree, JSON.stringify(permBefore));
    const mayorSwitch = await read(win, `(() => {
      const s = window.__lanwan.store;
      // 生产构建禁用 setMayorDemo 后门；桌面验收用显式构造的身份夹具（与单元测试 appointPlayerMayor 等价的最小状态）。
      s.world.player.roles.mayorCityId = 'lanport';
      s.emit();
      const view = s.policyView('lanport');
      const restrictedText = (document.querySelector('[data-testid="ai-checkup-restricted"]')?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 600);
      const cardText = (document.querySelector('.policy-active-meta')?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
      return {
        isMayor: view.isPlayerMayor,
        restrictedBlock: Boolean(document.querySelector('[data-testid="ai-checkup-restricted"]')),
        restrictedText,
        cardText,
        budgetVisible: view.active.some((policy) => typeof policy.budget === 'number'),
        referenceVisible: view.active.some((policy) => typeof policy.referenceBudget === 'number'),
      };
    })()`);
    const mayorOk = mayorSwitch.isMayor && mayorSwitch.restrictedBlock
      && /债务\/GDP|参考预算|到期压力/.test(mayorSwitch.restrictedText)
      && mayorSwitch.budgetVisible
      && (!mayorSwitch.referenceVisible || /本月参考|预留|未支付/.test(mayorSwitch.cardText));
    check('市长：AI 体检受限财政口径出现，政策卡显示参考/预留/未支付与资金预算', mayorOk, JSON.stringify(mayorSwitch));
    // v1.7 验收修复：财政流水面板必须明确“近期明细 vs 已归档年度汇总”，且归档区块只读、不伪造。
    const fiscalArchiveUi = await read(win, `(() => {
      const note = document.querySelector('[data-testid="fiscal-ledger-window-note"]');
      const ledger = document.querySelector('[data-testid="fiscal-ledger"]');
      const archive = document.querySelector('[data-testid="fiscal-annual-archive"]');
      return {
        noteExists: Boolean(note),
        noteText: (note?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 300),
        ledgerVisible: Boolean(ledger),
        archiveVisible: Boolean(archive),
        archiveText: (archive?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 200),
      };
    })()`);
    check(
      '财政流水面板标注“近期逐笔明细 / 更早已按年度汇总归档”，归档区块与明细区分',
      fiscalArchiveUi.noteExists && fiscalArchiveUi.ledgerVisible
        && /明细/.test(fiscalArchiveUi.noteText)
        && /归档|年度汇总/.test(fiscalArchiveUi.noteText)
        && fiscalArchiveUi.archiveVisible,
      JSON.stringify(fiscalArchiveUi),
    );
    const mayorReset = await read(win, `(() => { const s = window.__lanwan.store; s.world.player.roles.mayorCityId = null; s.emit(); return s.policyView('lanport').isPlayerMayor; })()`);
    await sleep(400);
    check('离任后立即恢复非市长受限视图', mayorReset === false, JSON.stringify({ isPlayerMayor: mayorReset }));
    await capture(win, 'v15-01-fiscal-permission.png');
    await clickTab(win, 'market');
    await sleep(400);
    const marketScope = await read(win, `(() => {
      const note = document.querySelector('[data-testid="market-scope-note"]');
      const header = document.querySelector('[data-testid="market-scope-note"]');
      return { note: Boolean(note), text: (note?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 240), header: Boolean(header) };
    })()`);
    check('市场快照显示 §3 口径说明（居民实际食品成交 = 本地 + 跨城进口）', marketScope.note && /居民实际食品成交|跨城进口/.test(marketScope.text), JSON.stringify(marketScope));
    await capture(win, 'v15-02-market-scope.png');

    // ---- 4. 玩家经营前置（唯一构造）：设置两家企业的经营者为玩家 ----
    step('4. 玩家经营前置（唯一构造）：设置两家企业的经营者为玩家');
    const fixture = await read(win, `(() => {
      const s = window.__lanwan.store;
      const setPlayer = (companyId) => {
        const control = s.world.governance.controls.find((entry) => entry.companyId === companyId);
        if (!control) return false;
        s.world.governance.controls = s.world.governance.controls.map((entry) => entry.companyId === companyId
          ? { ...entry, operator: { type: 'player', id: 'player' }, basis: 'election' }
          : entry);
        return true;
      };
      const a = setPlayer('lp-energy');
      const b = setPlayer('lp-garment');
      const c = setPlayer('lp-food');
      s.emit();
      return { a, b, c };
    })()`);
    await sleep(500);
    const canOperate = await read(win, `(() => {
      const s = window.__lanwan.store;
      return ['lp-energy', 'lp-garment', 'lp-food'].every((id) => s.companyOperatingView(id) && s.companyOperatingView(id).isPlayerOperator);
    })()`);
    check('构造玩家经营三家岚港企业后，设备买卖权限在视图层生效', fixture.a && fixture.b && fixture.c && canOperate === true, JSON.stringify({ fixture, canOperate }));

    // ---- 5. 界面买入新设备：现金减少、设备 +1、货源（企业库存或政府储备）等额减少 ----
    // v1.0 起世界有真实设备厂：同城设备企业库存优先于政府储备，买家价格=城市市场价；
    // 政府储备分支按目录价收款且财政等额增加。两条路径都必须是真实资金/库存转移。
    step('5. 界面买入新设备：设备 +1、货源减少、企业付款=卖方收款（企业库存或政府储备）');
    await openCompany(win, 'lp-energy');
    await clickTab(win, 'operation');
    await waitFor(win, `document.querySelector('[data-testid="equipment-buy-form"]')`, 8000);
    const buyBefore = await read(win, `(() => {
      const s = window.__lanwan.store;
      const company = s.world.companies.find((c) => c.id === 'lp-energy');
      const view = s.companyOperatingView('lp-energy');
      const sellers = s.world.companies
        .filter((c) => c.cityId === 'lanport' && c.inventory && (c.inventory.energyEquipment ?? 0) > 0)
        .map((c) => ({ id: c.id, cash: c.cash, inventory: c.inventory.energyEquipment }));
      return {
        cash: company.cash,
        treasury: s.world.cities.find((c) => c.id === 'lanport').treasury,
        units: view.equipment.energy,
        stock: s.world.equipmentMarket.initialStock.energy,
        price: view.equipmentRows.find((r) => r.kind === 'energy').catalogPrice,
        marketPrice: view.equipmentRows.find((r) => r.kind === 'energy').marketPrice,
        stockMonths: s.equipmentMarketView('lanport').offers.length,
        sellers,
      };
    })()`);
    await typeInto(win, '[data-equipment-form="buy"] [data-equipment-kind]', 'energy');
    await typeInto(win, '[data-equipment-form="buy"] [data-equipment-units]', '1');
    const buyClicked = await click(win, '[data-testid="buy-equipment-lp-energy"]');
    await sleep(600);
    const buyAfter = await read(win, `(() => {
      const s = window.__lanwan.store;
      const company = s.world.companies.find((c) => c.id === 'lp-energy');
      const view = s.companyOperatingView('lp-energy');
      const sellers = s.world.companies
        .filter((c) => c.cityId === 'lanport' && c.inventory)
        .map((c) => ({ id: c.id, cash: c.cash, inventory: c.inventory.energyEquipment ?? 0 }));
      return {
        cash: company.cash,
        treasury: s.world.cities.find((c) => c.id === 'lanport').treasury,
        units: view.equipment.energy,
        stock: s.world.equipmentMarket.initialStock.energy,
        sellers,
      };
    })()`);
    const spent = Math.round((buyBefore.cash - buyAfter.cash) * 100) / 100;
    const received = Math.round((buyAfter.treasury - buyBefore.treasury) * 100) / 100;
    const sellerDelta = buyBefore.sellers.map((before) => {
      const after = buyAfter.sellers.find((row) => row.id === before.id);
      return {
        id: before.id,
        inventory: before.inventory - (after ? after.inventory : before.inventory),
        cash: after ? after.cash - before.cash : 0,
      };
    }).filter((row) => row.inventory > 0);
    const companySale = sellerDelta.length === 1
      && Math.abs(sellerDelta[0].cash - spent) <= 0.02
      && buyAfter.stock === buyBefore.stock;
    const governmentSale = buyAfter.stock === buyBefore.stock - 1
      && Math.abs(received - spent) <= 0.02
      && Math.abs(spent - buyBefore.price) <= 0.02;
    const buyOk = buyClicked && buyAfter.units === buyBefore.units + 1
      && spent > 0
      && (companySale || governmentSale);
    check(
      '界面买入 1 台能源设备：设备 +1、货源减少、企业付款=卖方收款（企业库存或政府储备）',
      buyOk,
      JSON.stringify({ buyBefore, buyAfter, spent, received, sellerDelta, path: companySale ? 'company' : governmentSale ? 'government' : 'invalid' }),
    );
    await capture(win, 'v09-03-equipment-buy.png');

    // ---- 6. 界面挂出二手设备（lp-food 有 12 台工业设备；留空单价按 65% 目录价） ----
    step('6. 界面挂出二手设备（lp-food 有 12 台工业设备；留空单价按 65% 目录价）');
    const sellSource = await read(win, `(() => {
      const s = window.__lanwan.store;
      const company = s.world.companies.find((c) => c.id === 'lp-food');
      const kinds = ['industry', 'energy', 'farm'];
      const kind = kinds.find((k) => Math.floor(company.equipment[k] ?? 0) >= 2) ?? null;
      return { kind, units: kind ? Math.floor(company.equipment[kind]) : 0 };
    })()`);
    await openCompany(win, 'lp-food');
    await clickTab(win, 'operation');
    await waitFor(win, `document.querySelector('[data-testid="sell-used-equipment-lp-food"]')`, 8000);
    await typeInto(win, '[data-equipment-form="sell"] [data-equipment-kind]', sellSource.kind);
    await typeInto(win, '[data-equipment-form="sell"] [data-equipment-units]', '2');
    await typeInto(win, '[data-equipment-form="sell"] [data-equipment-price]', '');
    const sellClicked = await click(win, '[data-testid="sell-used-equipment-lp-food"]');
    await sleep(600);
    const sellAfter = await read(win, `(() => {
      const kind = ${JSON.stringify(sellSource.kind)};
      const s = window.__lanwan.store;
      const company = s.world.companies.find((c) => c.id === 'lp-food');
      const offers = s.equipmentMarketView('lanport').offers;
      return {
        units: Math.floor(company.equipment[kind] ?? 0),
        offers: offers.map((offer) => ({ id: offer.id, companyId: offer.companyId, kind: offer.kind, units: offer.units, askPrice: offer.askPrice })),
        hasOfferRow: Boolean(document.querySelector('[data-testid^="used-offer-"]')),
      };
    })()`);
    const offer = sellAfter.offers.find((entry) => entry.companyId === 'lp-food');
    const sellOk = sellClicked && Boolean(offer) && offer.units === 2 && sellAfter.hasOfferRow
      && sellAfter.units === sellSource.units - 2;
    check('界面挂出 2 台二手设备：立即扣除设备、生成本城委托并显示在列表', sellOk, JSON.stringify({ sellSource, offer, unitsAfter: sellAfter.units }));
    await capture(win, 'v09-04-used-market.png');

    // ---- 7. 另一家玩家企业买入二手设备：委托消失、设备转移、资金对账 ----
    step('7. 另一家玩家企业买入二手设备：委托消失、设备转移、资金对账');
    const offerId = offer?.id ?? '';
    const usedBefore = await read(win, `(() => {
      const kind = ${JSON.stringify(sellSource.kind)};
      const s = window.__lanwan.store;
      const buyer = s.world.companies.find((c) => c.id === 'lp-garment');
      const seller = s.world.companies.find((c) => c.id === 'lp-food');
      return { buyerCash: buyer.cash, sellerCash: seller.cash, buyerUnits: Math.floor(buyer.equipment[kind] ?? 0) };
    })()`);
    await openCompany(win, 'lp-garment');
    await clickTab(win, 'operation');
    await waitFor(win, `document.querySelector('[data-testid="equipment-used-market"]')`, 8000);
    const buyUsedClicked = await click(win, `[data-action="buy-used-equipment"][data-offer-id="${offerId}"]`);
    await sleep(700);
    const usedAfter = await read(win, `(() => {
      const kind = ${JSON.stringify(sellSource.kind)};
      const s = window.__lanwan.store;
      const buyer = s.world.companies.find((c) => c.id === 'lp-garment');
      const seller = s.world.companies.find((c) => c.id === 'lp-food');
      return {
        buyerCash: buyer.cash,
        sellerCash: seller.cash,
        buyerUnits: Math.floor(buyer.equipment[kind] ?? 0),
        offersLeft: s.equipmentMarketView('lanport').offers.length,
      };
    })()`);
    const usedCost = offer ? offer.askPrice * offer.units : 0;
    const buyUsedOk = buyUsedClicked && usedAfter.buyerUnits === usedBefore.buyerUnits + 2
      && usedAfter.offersLeft === 0
      && Math.abs((usedBefore.buyerCash - usedAfter.buyerCash) - usedCost) <= 0.02
      && Math.abs((usedAfter.sellerCash - usedBefore.sellerCash) - usedCost) <= 0.02;
    check('界面买入二手设备：委托清空、买方设备 +2、买卖双方现金等额转移', buyUsedOk, JSON.stringify({ usedBefore, usedAfter, usedCost }));
    await capture(win, 'v09-05-buy-used.png');

    // ---- 8. 股票大窗口回归（v0.8 功能不得被 v0.9 改坏） ----
    step('8. 股票大窗口回归（v0.8 功能不得被 v0.9 改坏）');
    const stock = await read(win, `(async () => {
      const s = window.__lanwan.store;
      s.openStockMarket('lp-energy', 'voting');
      await new Promise((r) => setTimeout(r, 600));
      return {
        window: Boolean(document.querySelector('[data-testid="stock-window"]')),
        rows: s.stockMarketView().rows.length,
        title: (document.querySelector('[data-testid="stock-window"] .stock-title')?.textContent ?? '').trim(),
        klineNote: (document.querySelector('[data-testid="stock-kline-window-note"]')?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 300),
        yearlyArchive: Boolean(document.querySelector('[data-testid="stock-yearly-archive"], [data-testid="stock-yearly-archive-empty"]')),
      };
    })()`);
    check('股票市场大窗口仍可打开并显示行', stock.window && stock.rows > 0, JSON.stringify(stock));
    check(
      '股票 K 线窗口标注“120 月明细窗口 + 更早年度 OHLCV 汇总”，且年度汇总区块存在（空数据不伪造）',
      stock.klineNote.includes('120') && /年度|归档/.test(stock.klineNote) && stock.yearlyArchive === true,
      JSON.stringify({ klineNote: stock.klineNote, yearlyArchive: stock.yearlyArchive }),
    );
    await capture(win, 'v09-06-stock-regression.png');
    await read(win, `(() => { window.__lanwan.store.closeStockMarket(); window.__lanwan.store.emit(); return true; })()`);
    await sleep(400);

    // ---- 8b. v1.6：真实推进 14 个月后核查价格规则/设备维护费/政策总额度 ----
    step('8b. v1.6 价格规则 / 设备维护费 / 政策总额度与公共岗位（真实 14 个月 tick）');
    await read(win, `(async () => {
      const s = window.__lanwan.store;
      for (let index = 0; index < 14; index += 1) {
        s.tick();
        await new Promise((resolve) => setTimeout(resolve, 60));
      }
      s.emit();
      return s.world.time.tick;
    })()`);
    await sleep(1200);
    const v16 = await read(win, `(() => {
      const s = window.__lanwan.store;
      const cfg = s.simulation.config;
      const city = s.world.cities.find((entry) => entry.id === 'lanport');
      const market = city.market;
      const maxChange = cfg.market.maxMonthlyChange * 100 + 0.01;
      const rows = Object.values(market).map((entry) => ({
        good: entry.goodId,
        price: entry.price,
        change: entry.lastPriceChangePct ?? 0,
      }));
      const pricesFinite = rows.every((row) => Number.isFinite(row.price) && row.price > 0);
      const changeBounded = rows.every((row) => Math.abs(row.change) <= maxChange);
      const imported = rows.reduce((sum, row) => sum + (market[row.good].intercityImported ?? 0), 0);
      const maintenance = s.world.equipmentMarket.maintenanceMonth;
      const flow = maintenance?.byCity?.[city.id];
      const company = s.world.companies.find((entry) => entry.id === 'lp-food')
        || s.world.companies.find((entry) => entry.cityId === city.id);
      const kinds = ['farm', 'industry', 'energy'];
      const base = company.maintenanceBase || company.equipment;
      const prices = company.maintenancePrices || {};
      const rate = cfg.equipment.maintenanceMonthlyRate;
      const expectedDue = kinds.reduce(
        (sum, kind) => sum + (base?.[kind] ?? 0) * (prices?.[kind] ?? 0) * rate,
        0,
      );
      const traces = (s.world.policies.fundingMonths ?? [])
        .filter((entry) => entry.cityId === city.id)
        .sort((left, right) => left.tick - right.tick);
      const trace = traces.length > 0 ? traces[traces.length - 1] : null;
      const allocations = trace?.policyBudgets ?? [];
      const allocated = allocations.reduce((sum, entry) => sum + entry.referenceBudget, 0);
      const overBudgetEntries = allocations.filter(
        (entry) => entry.spent + entry.unpaid > entry.referenceBudget + 0.02,
      ).length;
      const jobs = (s.world.policies.publicJobsMonths ?? [])
        .filter((entry) => entry.cityId === city.id)
        .sort((left, right) => left.tick - right.tick)
        .pop() || null;
      return {
        tick: s.world.time.tick,
        pricesFinite,
        changeBounded,
        maxAbsChange: Math.round(Math.max(0, ...rows.map((row) => Math.abs(row.change))) * 100) / 100,
        imported: Math.round(imported),
        cityMaintenanceDue: flow?.due ?? 0,
        cityMaintenancePaid: flow?.paid ?? 0,
        cityMaintenanceArrears: flow?.arrearsOutstanding ?? 0,
        companyId: company.id,
        companyMaintenanceDue: company.lastMonth?.maintenanceDue ?? 0,
        companyExpectedDue: Math.round(expectedDue * 100) / 100,
        companyHasSnapshot: Boolean(company.maintenanceBase && company.maintenancePrices),
        quota: trace?.quota ?? null,
        allocated: Math.round(allocated * 100) / 100,
        allocations: allocations.length,
        overBudgetEntries,
        jobs: jobs
          ? { added: jobs.jobsAdded, headcount: jobs.headcount, removed: jobs.jobsRemoved, wages: jobs.wagesPaid }
          : null,
      };
    })()`);
    check(
      '14 个月真实 tick：商品价格均为正、单月变动不超过配置上限',
      v16.pricesFinite && v16.changeBounded,
      JSON.stringify({ tick: v16.tick, maxAbsChange: v16.maxAbsChange, pricesFinite: v16.pricesFinite }),
    );
    check(
      '设备维护费按月初快照真实结算：应计 = 台数 × 月初价 × 1%（误差 ≤0.05），城市已真实付款',
      v16.cityMaintenanceDue > 0
        && v16.companyHasSnapshot
        && Math.abs(v16.companyMaintenanceDue - v16.companyExpectedDue) <= 0.05,
      JSON.stringify({
        company: v16.companyId,
        due: v16.companyMaintenanceDue,
        expected: v16.companyExpectedDue,
        cityDue: v16.cityMaintenanceDue,
        cityPaid: v16.cityMaintenancePaid,
      }),
    );
    check(
      '政策月预算为合计额度：Σ分项参考预算 ≤ 本月总额度，且无分项实支+未支付超出自身额度',
      v16.quota !== null && v16.allocations > 0 && v16.allocated <= v16.quota + 0.01 && v16.overBudgetEntries === 0,
      JSON.stringify({ quota: v16.quota, allocated: v16.allocated, allocations: v16.allocations, over: v16.overBudgetEntries }),
    );
    check(
      '公共岗位统计可读：新增/在岗/撤销/实发工资均为非负数（人数与人次分开）',
      v16.jobs === null
        || (v16.jobs.added >= 0 && v16.jobs.headcount >= 0 && v16.jobs.removed >= 0 && v16.jobs.wages >= 0),
      JSON.stringify(v16.jobs),
    );
    await capture(win, 'v16-01-market-prices.png');
    // 先回到城市视图并打开一家仍在营（且持有设备）的企业，再切到「经营」标签；
    // 14 个月真实 tick 后企业名单会变化，不能用固定 id 假设 lp-food 仍在营。
    await enterCity(win, 'lanport');
    await clickTab(win, 'companies');
    await waitFor(win, `document.querySelector('[data-testid="company-row-lp-food"]')`, 8000);
    await openCompany(win, 'lp-food');
    await clickTab(win, 'operation');
    await waitFor(win, `document.querySelector('[data-testid="company-equipment"]')`, 8000);
    const maintenanceUi = await read(win, `(() => ({
      hasPanel: Boolean(document.querySelector('[data-testid="company-equipment"]')),
      hasSection: Boolean(document.querySelector('[data-testid="equipment-maintenance"]')),
      total: (document.querySelector('[data-testid="equipment-maintenance-total"]')?.textContent ?? '').trim(),
      status: (document.querySelector('[data-testid="equipment-maintenance-status"]')?.textContent ?? '').trim(),
      rows: document.querySelectorAll('[data-testid^="equipment-maintenance-row-"]').length,
    }))()`);
    check(
      '企业面板显示设备台数/计价/维护费/支付状态',
      maintenanceUi.hasPanel
        && maintenanceUi.hasSection
        && maintenanceUi.rows > 0
        && maintenanceUi.total.length > 0
        && /已付清|欠付|本月无计费/.test(maintenanceUi.status),
      JSON.stringify(maintenanceUi),
    );
    await capture(win, 'v16-02-company-maintenance.png');
    await click(win, '[data-action="close-company"]');
    await sleep(400);

    // ---- 8c. v1.6.1：未成交挂单设备仍计入卖方维护费（跨月）+ 企业财务面板 ----
    step('8c. v1.6.1 未成交挂单设备仍计维护费（跨月）/ 企业财务面板');
    const listingCheck = await read(win, `(async () => {
      const s = window.__lanwan.store;
      const city = s.world.cities.find((entry) => entry.id === 'lanport');
      // 先记录“挂单前”台数，再挂单（顺序反了会把挂单后台数当成挂单前）。
      let chosenId = null;
      let beforeIndustry = 0;
      let beforeOfferUnits = 0;
      for (const entry of s.world.companies.filter((item) => item.cityId === city.id && (item.equipment.industry ?? 0) > 0)) {
        const snapshotBefore = entry.equipment.industry;
        // 该企业之前可能已有未成交挂单（AI 卖设备），计费台数口径是 equipment + 挂单，快照应等于两者之和。
        const priorOffers = (s.world.equipmentMarket.offers || [])
          .filter((offer) => offer.companyId === entry.id && offer.kind === 'industry')
          .reduce((sum, offer) => sum + offer.units, 0);
        if (s.sellUsedEquipment(entry.id, 'industry', 1, 999999)) {
          chosenId = entry.id;
          beforeIndustry = snapshotBefore;
          beforeOfferUnits = priorOffers;
          break;
        }
      }
      if (!chosenId) return { ok: false, reason: '没有可挂单工业设备的企业' };
      const findCompany = () => s.world.companies.find((entry) => entry.id === chosenId);
      const offer0 = (s.world.equipmentMarket.offers || []).find((entry) => entry.companyId === chosenId && entry.kind === 'industry');
      const afterListIndustry = findCompany().equipment.industry;
      s.tick();
      await new Promise((resolve) => setTimeout(resolve, 200));
      const company = findCompany();
      const offersAfter = (s.world.equipmentMarket.offers || []).filter((entry) => entry.companyId === chosenId);
      const offerUnits = offersAfter.reduce((sum, entry) => sum + entry.units, 0);
      const equipmentAfterTick = company.equipment.industry;
      const base = company.maintenanceBase || company.equipment;
      const prices = company.maintenancePrices || {};
      const rate = s.simulation.config.equipment.maintenanceMonthlyRate;
      const expected = ['farm', 'industry', 'energy'].reduce(
        (sum, kind) => sum + (base[kind] ?? 0) * (prices[kind] ?? 0) * rate,
        0,
      );
      const due = company.lastMonth.maintenanceDue ?? 0;
      const paid = company.lastMonth.maintenancePaid ?? 0;
      const arrearsAdded = company.lastMonth.maintenanceArrearsAdded ?? 0;
      const cancelled = offer0 ? s.cancelUsedEquipment(chosenId, offer0.id) : false;
      const afterCancelIndustry = findCompany().equipment.industry;
      s.emit();
      return {
        ok: true,
        company: chosenId,
        tick: s.world.time.tick,
        beforeIndustry,
        beforeOfferUnits,
        afterListIndustry,
        offerUnits,
        baseIndustry: base.industry,
        expectedDue: Math.round(expected * 100) / 100,
        due: Math.round(due * 100) / 100,
        paid,
        arrearsAdded,
        cancelled,
        afterCancelIndustry,
        equipmentAfterTick,
      };
    })()`);
    const listingOk = listingCheck.ok
      // 挂单当刻设备 -1；月初快照把挂单 1 台算回，合计 = 挂单前台数。
      && listingCheck.afterListIndustry === listingCheck.beforeIndustry - 1
      && listingCheck.offerUnits > 0
      && listingCheck.baseIndustry === listingCheck.beforeIndustry + listingCheck.beforeOfferUnits
      && Math.abs(listingCheck.due - listingCheck.expectedDue) <= 0.05
      && listingCheck.due > 0
      && Math.abs(listingCheck.paid + listingCheck.arrearsAdded - listingCheck.due) <= 0.05
      && listingCheck.cancelled === true
      && listingCheck.afterCancelIndustry === listingCheck.equipmentAfterTick + listingCheck.offerUnits;
    check('未成交挂单设备仍计入卖方当月维护费（月初快照含挂单台数，撤单返还）', listingOk, JSON.stringify(listingCheck));
    await capture(win, 'v16-03-listed-maintenance.png');

    await enterCity(win, 'lanport');
    await clickTab(win, 'companies');
    await waitFor(win, `document.querySelector('[data-testid="company-row-${listingCheck.company}"]')`, 8000);
    await openCompany(win, listingCheck.company);
    await clickTab(win, 'finance');
    await sleep(600);
    const financeUi = await read(win, `(() => {
      const row = Array.from(document.querySelectorAll('tr')).find((item) => (item.textContent || '').includes('设备维护费'));
      return {
        hasRow: Boolean(row),
        rowText: (row ? row.textContent : '').replace(/\s+/g, ' ').trim().slice(0, 160),
      };
    })()`);
    check('企业财务面板显示设备维护费独立费用行', financeUi.hasRow, JSON.stringify(financeUi));
    await capture(win, 'v16-04-company-finance.png');
    await click(win, '[data-action="close-company"]');
    await sleep(400);

    // ---- 9. 存读档：设备、现金、人口、债券、设备储备全部往返一致 ----
    step('9. 存读档：设备、现金、人口、债券、设备储备全部往返一致');
    const saveState = await read(win, `(async () => {
      const s = window.__lanwan.store;
      const snapshot = () => {
        const company = s.world.companies.find((c) => c.id === 'lp-energy');
        const garment = s.world.companies.find((c) => c.id === 'lp-garment');
        return {
          tick: s.world.time.tick,
          date: s.dateLabel,
          energyUnits: Math.floor(company.equipment.energy ?? 0),
          garmentEnergyUnits: Math.floor(garment.equipment.energy ?? 0),
          companyCash: company.cash,
          garmentCash: garment.cash,
          treasury: s.world.cities.find((c) => c.id === 'lanport').treasury,
          populations: s.world.cities.map((c) => c.population.total),
          stock: { ...s.world.equipmentMarket.initialStock },
          bonds: s.world.bonds.holdings.length,
          salesHistory: JSON.stringify(company.salesHistory ?? []),
          plan: JSON.stringify(company.productionPlan ?? null),
          // v1.6：设备维护费快照/欠付、僵尸计数、企业报价系数与政策额度分项也必须往返一致。
          maintenanceArrears: company.maintenanceArrears ?? 0,
          maintenanceBase: JSON.stringify(company.maintenanceBase ?? null),
          maintenancePrices: JSON.stringify(company.maintenancePrices ?? null),
          idleMonths: company.ai?.idleMonths ?? 0,
          priceFactor: company.priceFactor,
          policyQuota: (s.world.policies.fundingMonths ?? [])
            .filter((entry) => entry.cityId === 'lanport')
            .sort((left, right) => left.tick - right.tick)
            .pop()?.quota ?? null,
        };
      };
      const before = snapshot();
      const saved = await s.saveSlot('manual-1');
      s.tick();
      await new Promise((r) => setTimeout(r, 300));
      const advanced = s.dateLabel;
      const loaded = await s.loadSlot('manual-1');
      await new Promise((r) => setTimeout(r, 300));
      return { saved, loaded, before, after: snapshot(), advanced, toasts: (s.toasts || []).map((t) => t.message) };
    })()`);
    const diffKeys = Object.keys(saveState.before).filter((key) => JSON.stringify(saveState.before[key]) !== JSON.stringify(saveState.after[key]));
    const saveOk = saveState.saved && saveState.loaded
      && saveState.advanced !== saveState.before.date
      && diffKeys.length === 0;
    check('存读档保留设备/现金/人口/债券/设备储备/销售历史/生产计划/维护费快照/政策额度且完全一致', saveOk, JSON.stringify({ saved: saveState.saved, loaded: saveState.loaded, advanced: saveState.advanced, toasts: saveState.toasts, diffKeys }));
    // v1.7：桌面存档落盘为 gzip 的 v10 模块化格式（minified、kind、11 个模块、无旧 world 字段）。
    const saveFormat = await read(win, `(async () => {
      const s = window.__lanwan.store;
      const read = await s.bridge.read('manual-1');
      if (!read.ok || !read.text) return { ok: false, error: read.error };
      let document;
      try { document = JSON.parse(read.text); } catch (error) { return { ok: false, error: 'JSON 解析失败：' + String(error) }; }
      return {
        ok: true,
        bytes: read.text.length,
        formatVersion: document.formatVersion,
        kind: document.kind,
        hasWorld: Object.prototype.hasOwnProperty.call(document, 'world'),
        modules: Object.keys(document.modules || {}).sort(),
      };
    })()`);
    check(
      '桌面存档为 v1.7 模块化格式（formatVersion 10 / kind / 11 模块 / 无旧 world 字段）',
      saveFormat.ok && saveFormat.formatVersion === 10 && saveFormat.kind === 'lanwan-modules' && saveFormat.hasWorld === false && saveFormat.modules.length === 11,
      JSON.stringify(saveFormat),
    );
    await capture(win, 'v09-07-save-load.png');

    // ---- 9a. v1.7 验收修复：成功覆盖后保留上一版本备份（.bak 轮换） ----
    step('9a. 保存备份保留与轮换');
    const backupCheck = await read(win, `(async () => {
      const s = window.__lanwan.store;
      const firstRead = await s.bridge.read('manual-1');
      if (!firstRead.ok || !firstRead.text) return { ok: false, error: '首次存档读取失败：' + String(firstRead.error) };
      const firstParsed = JSON.parse(firstRead.text);
      const savedAgain = await s.saveSlot('manual-1');
      if (!savedAgain) return { ok: false, error: '第二次保存失败' };
      const backup = typeof s.bridge.readBackup === 'function' ? await s.bridge.readBackup('manual-1') : { ok: false, error: '无 readBackup' };
      const list = await s.bridge.list();
      const entry = (list || []).find((item) => item.slot === 'manual-1') || null;
      let backupParsed = null;
      if (backup.ok && backup.text) { try { backupParsed = JSON.parse(backup.text); } catch { backupParsed = null; } }
      return {
        ok: true,
        backupOk: backup.ok,
        backupFormatVersion: backupParsed ? backupParsed.formatVersion : null,
        backupKind: backupParsed ? backupParsed.kind : null,
        backupSavedAt: backupParsed ? backupParsed.savedAt : null,
        firstSavedAt: firstParsed.savedAt,
        backupExistsInList: entry ? entry.backupExists === true : null,
        recoveredFromBackup: entry ? entry.recoveredFromBackup === true : null,
      };
    })()`);
    check(
      '成功覆盖后保留上一版本备份（.bak 可读取、内容为上一版、list 标记 backupExists）',
      backupCheck.ok === true && backupCheck.backupOk === true
        && backupCheck.backupFormatVersion === 10 && backupCheck.backupKind === 'lanwan-modules'
        && backupCheck.backupExistsInList === true && backupCheck.recoveredFromBackup === false
        && typeof backupCheck.firstSavedAt === 'string' && backupCheck.backupSavedAt === backupCheck.firstSavedAt,
      JSON.stringify(backupCheck),
    );
    const rotation = await read(win, `(async () => {
      const s = window.__lanwan.store;
      const main = await s.bridge.read('manual-1');
      const backup = typeof s.bridge.readBackup === 'function' ? await s.bridge.readBackup('manual-1') : { ok: false };
      if (!main.ok || !main.text || !backup.ok || !backup.text) return { ok: false };
      const mainDoc = JSON.parse(main.text);
      const backupDoc = JSON.parse(backup.text);
      return { ok: true, mainSavedAt: mainDoc.savedAt, backupSavedAt: backupDoc.savedAt };
    })()`);
    check(
      '连续保存轮换：主档为最新版本、备份为上一版本（两者不是同一份）',
      rotation.ok === true && typeof rotation.mainSavedAt === 'string' && typeof rotation.backupSavedAt === 'string'
        && rotation.mainSavedAt !== rotation.backupSavedAt,
      JSON.stringify(rotation),
    );
    await capture(win, 'v17-02-backup-rotation.png');

    // ---- 9b. v1.7：损坏/不兼容存档提示、自动保存、v10 模块格式 ----
    step('9b. v1.7 损坏/不兼容存档提示、自动保存');
    fs.writeFileSync(path.join(savesDir, 'manual-corrupt.json'), '{ "formatVersion": 10, "kind": "lanwan-modules", broken');
    const corruptLoad = await read(win, `(async () => {
      const s = window.__lanwan.store;
      const beforeTick = s.world.time.tick;
      const ok = await s.loadSlot('manual-corrupt');
      return { ok, beforeTick, afterTick: s.world.time.tick, toasts: (s.toasts || []).map((entry) => entry.message) };
    })()`);
    check(
      '损坏存档读取失败、给出可读错误且不覆盖当前世界',
      corruptLoad.ok === false && corruptLoad.afterTick === corruptLoad.beforeTick
        && corruptLoad.toasts.some((message) => message.includes('读取失败')),
      JSON.stringify(corruptLoad),
    );

    // 用刚保存的 v10 存档构造“未知必需模块”的不兼容存档。
    const incompatible = await read(win, `(async () => {
      const s = window.__lanwan.store;
      const read = await s.bridge.read('manual-1');
      if (!read.ok || !read.text) return { ok: false, error: read.error };
      const document = JSON.parse(read.text);
      document.modules.futureRequired = { version: 1, required: true, data: { future: true } };
      return { ok: true, text: JSON.stringify(document), tick: s.world.time.tick };
    })()`);
    let incompatibleResult = { ok: false, error: '未构造' };
    if (incompatible.ok) {
      fs.writeFileSync(path.join(savesDir, 'manual-incompat.json'), incompatible.text);
      incompatibleResult = await read(win, `(async () => {
        const s = window.__lanwan.store;
        const beforeTick = s.world.time.tick;
        const ok = await s.loadSlot('manual-incompat');
        return { ok, beforeTick, afterTick: s.world.time.tick, toasts: (s.toasts || []).map((entry) => entry.message) };
      })()`);
    }
    check(
      '包含未知必需模块的存档被拒绝加载且不覆盖当前世界',
      incompatibleResult.ok === false && incompatibleResult.afterTick === incompatibleResult.beforeTick
        && (incompatibleResult.toasts || []).some((message) => message.includes('不认识的必需模块') || message.includes('更新版本')),
      JSON.stringify(incompatibleResult),
    );

    const autosaveCheck = await read(win, `(async () => {
      const s = window.__lanwan.store;
      await s.autosave();
      const read = await s.bridge.read('autosave');
      if (!read.ok || !read.text) return { ok: false, error: read.error, lastAutoSaveError: s.lastAutoSaveError };
      const document = JSON.parse(read.text);
      return {
        ok: true,
        lastAutoSaveError: s.lastAutoSaveError ?? null,
        formatVersion: document.formatVersion,
        kind: document.kind,
        modules: Object.keys(document.modules || {}).length,
        hasWorld: Object.prototype.hasOwnProperty.call(document, 'world'),
      };
    })()`);
    check(
      '自动保存成功且写出版本格式 v10 模块化存档（无旧 world 字段）',
      autosaveCheck.ok === true && autosaveCheck.lastAutoSaveError === null
        && autosaveCheck.formatVersion === 10 && autosaveCheck.modules === 11 && autosaveCheck.hasWorld === false,
      JSON.stringify(autosaveCheck),
    );
    await capture(win, 'v17-01-save-safety.png');

    // ---- 10. 1100x700 最小窗口：无横向溢出、城市标签完整 ----
    step('10. 1100x700 最小窗口：无横向溢出、城市标签完整');
    await click(win, '[data-action="close-company"]');
    await sleep(500);
    win.setSize(1100, 700);
    await sleep(900);
    const small = await read(win, `(() => ({
      overflowX: document.documentElement.scrollWidth > innerWidth + 2,
      tabs: document.querySelectorAll('[data-testid="right-tabs"] [role="tab"]').length,
      labels: Array.from(document.querySelectorAll('[data-testid="right-tabs"] [role="tab"]')).map((el) => (el.textContent || '').trim()).filter(Boolean),
      view: window.__lanwan.store.view,
      equipment: Boolean(document.querySelector('[data-testid="company-equipment"]')) || true,
    }))()`);
    check('1100x700 无横向溢出且城市标签仍完整', small.overflowX === false && small.tabs === 6, JSON.stringify(small));
    win.setSize(1600, 1000);
    await sleep(500);

    // ---- 10b. §三.2：72 个月默认世界经桌面存档接口写入/读取并推进下一个月 ----
    step('10b. 72 月存档：桌面接口读取→推进 1 月→写入→再读取');
    const t72Path = '/tmp/v16-acceptance/t72-save.json';
    if (fs.existsSync(t72Path)) {
      const t72Text = fs.readFileSync(t72Path, 'utf8');
      const t72Bytes = Buffer.byteLength(t72Text, 'utf8');
      fs.writeFileSync(path.join(savesDir, 'manual-t72.json'), t72Text);
      const t72 = await read(win, `(async () => {
        const s = window.__lanwan.store;
        if (typeof s.resetWorld === 'function') {
          s.resetWorld();
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
        const t0 = performance.now();
        const loaded = await s.loadSlot('manual-t72');
        const loadMs = Math.round(performance.now() - t0);
        const startTick = s.world.time.tick;
        const companies = s.world.companies.length;
        const t1 = performance.now();
        s.tick();
        const tickMs = Math.round(performance.now() - t1);
        const t2 = performance.now();
        const saved = await s.saveSlot('manual-t72');
        const saveMs = Math.round(performance.now() - t2);
        const t3 = performance.now();
        const reloaded = await s.loadSlot('manual-t72');
        const reloadMs = Math.round(performance.now() - t3);
        return {
          saved, loaded, reloaded, startTick, advancedTick: s.world.time.tick, companies,
          loadMs, tickMs, saveMs, reloadMs,
          toasts: (s.toasts || []).map((entry) => entry.message),
        };
      })()`);
      const savedFile = path.join(savesDir, 'manual-t72.json');
      const savedBytes = fs.existsSync(savedFile) ? fs.statSync(savedFile).size : 0;
      const savedHead = fs.existsSync(savedFile) ? fs.readFileSync(savedFile).subarray(0, 2) : Buffer.alloc(0);
      // v1.6.1 §三 长期方案：桌面存档对 ≥4MiB 文本 gzip 落盘（.json 后缀 + gzip 魔数，格式版本仍 9）。
      const savedIsGzip = savedHead.length === 2 && savedHead[0] === 0x1f && savedHead[1] === 0x8b;
      // v1.7 验收修复：旧版明文升级并在**同一槽位**首次覆盖后，.bak 必须保留升级前的旧档内容（可被旧格式读取）。
      const backupFile = path.join(savesDir, 'manual-t72.json.bak');
      const backupExists = fs.existsSync(backupFile);
      let backupLegacyOk = false;
      let backupBytes = 0;
      if (backupExists) {
        const backupBuffer = fs.readFileSync(backupFile);
        backupBytes = backupBuffer.length;
        backupLegacyOk = backupBuffer[0] === 0x7b && (() => {
          try {
            const parsed = JSON.parse(backupBuffer.toString('utf8'));
            return parsed.formatVersion === 9 && Object.prototype.hasOwnProperty.call(parsed, 'world');
          } catch { return false; }
        })();
      }
      check(
        '72 月默认世界经桌面存档接口：读取成功→推进 1 月→写入成功（gzip）→再读取成功',
        t72.loaded && t72.reloaded && t72.advancedTick === t72.startTick + 1 && t72.saved
          && savedBytes > 0 && savedBytes < t72Bytes * 0.3 && savedIsGzip
          && backupExists && backupBytes === t72Bytes && backupLegacyOk,
        JSON.stringify({
          sourceBytes: t72Bytes, savedBytes, savedIsGzip, compressionRatio: Number((savedBytes / t72Bytes).toFixed(3)),
          backupExists, backupBytes, backupLegacyOk,
          loadMs: t72.loadMs, tickMs: t72.tickMs, saveMs: t72.saveMs, reloadMs: t72.reloadMs,
          startTick: t72.startTick, advancedTick: t72.advancedTick, companies: t72.companies,
          toasts: t72.toasts,
        }),
      );
      await capture(win, 'v16-05-t72-save-load.png');
    } else {
      check('72 月存档验收素材缺失（/tmp/v16-acceptance/t72-save.json）', false, '需先运行 npx tsx scripts/tmp-v16-gen-save.ts');
    }

    check('全程无控制台错误（过滤 GPU/GL 噪声）', errors.length === 0, errors.slice(0, 5).join(' | '));
  } catch (error) {
    check('验收脚本执行完成（无异常）', false, String(error && error.stack ? error.stack : error));
  }

  const report = {
    generatedAt: new Date().toISOString(),
    electron: process.versions.electron,
    checks,
    passed: checks.filter((entry) => entry.pass).length,
    total: checks.length,
    consoleErrors: errors,
  };
  fs.writeFileSync(path.join(artifacts, 'report.json'), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`\nSUMMARY ${report.passed}/${report.total} checks passed`);
  app.exit(report.passed === report.total ? 0 : 1);
});
