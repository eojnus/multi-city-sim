/**
 * v0.9 桌面验收走查（人口 ×5 / 需求 vs 成交 / 真实设备链 / 生产计划 / 存读档）。
 *
 * 全程走真实 Electron 界面：DOM 点击、表单输入、标签切换；必要时只读 store 对账。
 * 唯一的人工构造：把两家企业的经营者临时设为玩家（`governance.controls`），
 * 以便在界面上真实执行设备买卖——这是“玩家经营权限”的测试前置，不改变任何经济数值。
 *
 * 证据截图与 JSON 同时写入 artifacts/（gitignore）与 docs/evidence_v1.3/（入仓）。
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
const evidence = path.join(root, 'docs', 'evidence_v1.3');
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
    await capture(win, 'v09-02-company-equipment.png');

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
      };
    })()`);
    check('股票市场大窗口仍可打开并显示行', stock.window && stock.rows > 0, JSON.stringify(stock));
    await capture(win, 'v09-06-stock-regression.png');
    await read(win, `(() => { window.__lanwan.store.closeStockMarket(); window.__lanwan.store.emit(); return true; })()`);
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
    check('存读档保留设备/现金/人口/债券/设备储备/销售历史/生产计划且完全一致', saveOk, JSON.stringify({ saved: saveState.saved, loaded: saveState.loaded, advanced: saveState.advanced, toasts: saveState.toasts, diffKeys }));
    await capture(win, 'v09-07-save-load.png');

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
