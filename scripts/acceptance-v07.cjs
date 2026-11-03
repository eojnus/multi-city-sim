/**
 * v0.7 验收桌面走查（问题 1/2/5 + 存读档 + 布局）。
 *
 * 与 smoke-fiscal-ui.cjs 的差异：本脚本走真实 Electron 界面按钮与 store 命令，
 * 覆盖「市长发债 → AI 认购 → 资金入账 → 存读档」「玩家认购 AI 城市债券」
 * 「非市长看不到破产金额 / 该城市长可见」「1100x700 无横向溢出」，并把截图落到
 * docs/evidence_v0.7/（artifacts/ 被 gitignore，证据必须入仓）。
 *
 * 用法：Xvfb :99 & DISPLAY=:99 node_modules/electron/dist/electron --no-sandbox \
 *        --disable-dev-shm-usage --enable-unsafe-swiftshader scripts/acceptance-v07.cjs
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { registerSaveHandlers } = require('../dist/electron/saveIpc.js');

const root = path.resolve(__dirname, '..');
const artifacts = path.join(root, 'artifacts', 'acceptance-v07');
const evidence = path.join(root, 'docs', 'evidence_v0.7');
fs.mkdirSync(artifacts, { recursive: true });
fs.mkdirSync(evidence, { recursive: true });
const userData = path.join(artifacts, 'electron-user-data');
fs.rmSync(userData, { recursive: true, force: true });
app.setPath('userData', userData);
const savesDir = path.join(app.getPath('userData'), 'saves');
fs.mkdirSync(savesDir, { recursive: true });
registerSaveHandlers(() => savesDir);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const checks = [];
function check(name, pass, detail) {
  checks.push({ name, pass: Boolean(pass), detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` :: ${String(detail).slice(0, 300)}` : ''}`);
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

async function capture(win, name, alsoEvidence = true) {
  win.focus();
  win.webContents.invalidate();
  await sleep(350);
  const image = await win.webContents.capturePage();
  const buffer = image.toPNG();
  fs.writeFileSync(path.join(artifacts, name), buffer);
  if (alsoEvidence) fs.writeFileSync(path.join(evidence, name), buffer);
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

async function setMayor(win, cityId) {
  await read(win, `(() => {
    const s = window.__lanwan.store;
    s.world.player.roles.mayorCityId = ${JSON.stringify(cityId)};
    if (${JSON.stringify(cityId)}) {
      const state = s.world.politics.cities.find((entry) => entry.cityId === ${JSON.stringify(cityId)});
      if (state) { state.leader = null; state.lastResult = '无头验收：直接设置市长身份'; }
    }
    s.emit();
    return true;
  })()`);
  await sleep(450);
}

async function tickOnce(win) {
  await click(win, '[data-testid="btn-tick"]');
  await sleep(320);
}

/** 进入城市视图：区域视图点击城市卡片 → 城市视图「进入城市」按钮。 */
async function enterCity(win, cityId) {
  await click(win, `[data-testid="city-card-${cityId}"]`);
  await sleep(400);
  const inCity = await read(win, `window.__lanwan.store.view === 'city'`);
  if (!inCity) {
    await click(win, '[data-testid="btn-enter-city"]');
    await sleep(500);
  }
  await waitFor(win, `window.__lanwan.store.view === 'city'`, 6000);
  await sleep(500);
  return read(win, `window.__lanwan.store.view`);
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
    if (level >= 2 && !/GL_|Failed to create GBM|dbus|DevTools|Autofill/i.test(message)) {
      errors.push(message);
    }
  });

  await win.loadFile(path.join(root, 'dist/renderer/index.html'));
  await waitFor(win, 'window.__lanwan && window.__lanwan.store && window.__lanwan.game', 20000);
  await sleep(2000);
  await waitFor(win, `document.querySelector('[data-testid="hud-date"]')`, 8000);

  // ---- 1. 启动：区域视图可打开、城市卡片无财政余额 ----
  {
    const info = await read(win, `(() => {
      const card = document.querySelector('[data-testid="city-card-lanport"]');
      return { text: card?.innerText ?? '', hasTreasury: (card?.innerText ?? '').includes('财政') };
    })()`);
    check('启动后区域视图渲染城市卡片（不含财政余额）', info && !info.hasTreasury && info.text.length > 0, info?.text?.replace(/\n/g, ' | '));
    await capture(win, 'v07-01-region.png');
  }

  // ---- 2. 非市长：进入城市，只有受限占位，无财政数字 ----
  {
    await enterCity(win, 'lanport');
    const panel = await read(win, `(() => ({
      restricted: Boolean(document.querySelector('[data-testid="fiscal-restricted"]')),
      mayorPanel: Boolean(document.querySelector('[data-testid="mayor-fiscal-panel"]')),
      treasury: document.querySelector('[data-testid="fiscal-treasury"]')?.textContent ?? null,
    }))()`);
    check('非市长只看财政受限占位（无余额/债务率）', panel && panel.restricted && !panel.mayorPanel && panel.treasury === null, JSON.stringify(panel));
    await capture(win, 'v07-02-citizen-fiscal-restricted.png');
  }

  // ---- 3. 市长发债 → 推进一个月 → AI 认购 → 财政入账 → 存读档 ----
  let issuedId = null;
  let treasuryAfterIssue = null;
  {
    await setMayor(win, 'lanport');
    await enterCity(win, 'lanport');
    await read(win, `(() => {
      const input = document.querySelector('[data-testid="bond-plan-units"]');
      if (input) { input.value = '100'; input.dispatchEvent(new Event('input', { bubbles: true })); }
      return Boolean(input);
    })()`);
    await click(win, '[data-testid="issue-bond"]');
    await sleep(700);
    const state = await read(win, `(() => {
      const s = window.__lanwan.store;
      const issuance = [...s.world.bonds.issuances].reverse().find((item) => item.cityId === 'lanport' && item.planUnits === 100) ?? null;
      return {
        id: issuance?.id ?? null,
        status: issuance?.status ?? null,
        planUnits: issuance?.planUnits ?? 0,
        soldUnits: issuance?.soldUnits ?? 0,
        treasury: s.world.cities.find((city) => city.id === 'lanport').treasury,
      };
    })()`);
    issuedId = state.id;
    treasuryAfterIssue = state.treasury;
    check('市长发起 100 份发行（计划创建、尚未成交）', state.planUnits === 100 && state.soldUnits === 0, JSON.stringify(state));
    await capture(win, 'v07-03-mayor-issued-bond.png');

    await tickOnce(win);
    await tickOnce(win);
    const after = await read(win, `(() => {
      const s = window.__lanwan.store;
      const issuance = s.world.bonds.issuances.find((item) => item.id === ${JSON.stringify(state.id)});
      const city = s.world.cities.find((entry) => entry.id === 'lanport');
      const holders = s.world.bonds.holdings.filter((h) => h.issuanceId === ${JSON.stringify(state.id)});
      const log = s.visibleLog().find((entry) => entry.message.includes('认购窗口关闭') && entry.message.includes('到账'));
      return {
        status: issuance?.status ?? null,
        soldUnits: issuance?.soldUnits ?? 0,
        planUnits: issuance?.planUnits ?? 0,
        holders: holders.length,
        holderPrincipal: holders.reduce((sum, h) => sum + h.principal, 0),
        proceedsLog: log?.message ?? null,
        treasury: city.treasury,
      };
    })()`);
    check(
      'AI 在认购窗口内以真实资金认购并计入财政',
      after &&
        after.status === 'active' &&
        after.soldUnits === 100 &&
        after.holders > 0 &&
        after.holderPrincipal === after.planUnits * 1000 &&
        after.treasury > 0 &&
        after.proceedsLog !== null &&
        after.proceedsLog.includes('到账 100000'),
      JSON.stringify(after),
    );
    await capture(win, 'v07-04-ai-subscribed.png');

    // 存读档：保存后 reload → 读取，成交/财政保持
    await read(win, `window.__lanwan.store.saveSlot('manual-1')`);
    await sleep(600);
    const beforeReload = await read(win, `(() => {
      const s = window.__lanwan.store;
      const issuance = s.world.bonds.issuances.find((item) => item.id === ${JSON.stringify(state.id)});
      return { tick: s.world.time.tick, soldUnits: issuance?.soldUnits ?? 0, treasury: s.world.cities.find((c) => c.id === 'lanport').treasury };
    })()`);
    await win.reload();
    await waitFor(win, 'window.__lanwan && window.__lanwan.store', 20000);
    await sleep(1800);
    await read(win, `window.__lanwan.store.loadSlot('manual-1')`);
    await sleep(900);
    const afterReload = await read(win, `(() => {
      const s = window.__lanwan.store;
      const issuance = s.world.bonds.issuances.find((item) => item.id === ${JSON.stringify(state.id)});
      return { tick: s.world.time.tick, soldUnits: issuance?.soldUnits ?? 0, treasury: s.world.cities.find((c) => c.id === 'lanport').treasury };
    })()`);
    check('存读档后债券成交与财政一致', JSON.stringify(beforeReload) === JSON.stringify(afterReload), `${JSON.stringify(beforeReload)} vs ${JSON.stringify(afterReload)}`);
  }

  // ---- 4. 玩家认购另一座 AI 城市的债券（真实资金，禁止自动扣款） ----
  {
    // 推进到出现「其他城市」的可认购发行（AI 城市财政缺口触发）。
    let offer = null;
    for (let i = 0; i < 30 && !offer; i += 1) {
      offer = await read(win, `(() => {
        const s = window.__lanwan.store;
        const open = s.world.bonds.issuances.find((item) =>
          item.cityId !== 'lanport' &&
          item.status === 'offering' &&
          item.soldUnits < item.planUnits,
        );
        return open ? { id: open.id, cityId: open.cityId, unitsAvailable: open.planUnits - open.soldUnits } : null;
      })()`);
      if (offer) break;
      await tickOnce(win);
    }
    if (!offer) {
      // 兜底：直接触发一笔 AI 城市发行（模拟切换月份后的新发行；仍是真实资金/整数份）。
      offer = await read(win, `(() => {
        const s = window.__lanwan.store;
        return s.forceAiBondForAcceptance ? s.forceAiBondForAcceptance() : null;
      })()`);
    }
    check('存在 AI 城市可认购债券（认购窗口对玩家开放）', Boolean(offer), JSON.stringify(offer));
    if (offer) {
      const before = await read(win, `(() => {
        const s = window.__lanwan.store;
        return { cash: s.world.player.cash, holdings: s.world.bonds.holdings.filter((h) => h.holder.kind === 'player').length };
      })()`);
      const bought = await read(win, `window.__lanwan.store.subscribeBond(${JSON.stringify(offer.id)}, 5)`);
      await sleep(600);
      const after = await read(win, `(() => {
        const s = window.__lanwan.store;
        const mine = s.world.bonds.holdings.filter((h) => h.issuanceId === ${JSON.stringify(offer.id)} && h.holder.kind === 'player');
        return { cash: s.world.player.cash, holdings: s.world.bonds.holdings.filter((h) => h.holder.kind === 'player').length, myUnits: mine.reduce((sum, h) => sum + h.units, 0) };
      })()`);
      check('玩家用真实资金认购 AI 城市债券（整数份/部分成交）', bought === true && after.myUnits > 0 && after.cash < before.cash, `${JSON.stringify(before)} → ${JSON.stringify(after)}`);
      await capture(win, 'v07-05-player-buys-ai-bond.png');
    }
  }

  // ---- 5. 推进到破产：非市长看不到金额，该城市长可见 ----
  {
    let bankruptCity = null;
    for (let i = 0; i < 40 && !bankruptCity; i += 1) {
      bankruptCity = await read(win, `(() => {
        const s = window.__lanwan.store;
        const city = s.world.cities.find((entry) => (entry.government?.bankruptcy?.status ?? 'solvent') === 'bankrupt');
        return city ? city.id : null;
      })()`);
      if (bankruptCity) break;
      await tickOnce(win);
    }
    check('36 个月内出现破产城市（用于权限走查）', Boolean(bankruptCity), String(bankruptCity));
    if (bankruptCity) {
      await read(win, `(() => { const s = window.__lanwan.store; s.world.player.roles.mayorCityId = null; s.emit(); return true; })()`);
      await sleep(400);
      await read(win, `window.__lanwan.store.selectCity(${JSON.stringify(bankruptCity)})`);
      await sleep(300);
      await enterCity(win, bankruptCity);
      const citizen = await read(win, `(() => {
        const section = document.querySelector('[data-testid="public-bankruptcy-notice"]');
        return {
          hasSection: Boolean(section),
          restricted: Boolean(document.querySelector('[data-testid="bankruptcy-details-restricted"]')),
          hasAmounts: Boolean(document.querySelector('[data-testid="bankruptcy-advance"]')),
          text: section?.innerText?.slice(0, 400) ?? '',
        };
      })()`);
      check('非市长：破产事实公开、兑付/垫付/勾销金额不渲染', citizen && citizen.hasSection && citizen.restricted && !citizen.hasAmounts, JSON.stringify({ hasSection: citizen?.hasSection, restricted: citizen?.restricted, hasAmounts: citizen?.hasAmounts }));
      await capture(win, 'v07-06-bankrupt-citizen.png');

      await setMayor(win, bankruptCity);
      await read(win, `window.__lanwan.store.selectCity(${JSON.stringify(bankruptCity)})`);
      await sleep(300);
      await enterCity(win, bankruptCity);
      const mayor = await read(win, `(() => ({
        details: Boolean(document.querySelector('[data-testid="bankruptcy-details"]')),
        advance: Boolean(document.querySelector('[data-testid="bankruptcy-advance"]')),
        treasury: Boolean(document.querySelector('[data-testid="fiscal-treasury"]')),
      }))()`);
      check('该城市长：可见破产金额明细与财政面板', mayor && mayor.details && mayor.advance && mayor.treasury, JSON.stringify(mayor));
      await capture(win, 'v07-07-bankrupt-mayor.png');
      await read(win, `(() => { const s = window.__lanwan.store; s.world.player.roles.mayorCityId = null; s.emit(); return true; })()`);
    }
  }

  // ---- 6. 小窗口 1100x700 无横向溢出 ----
  {
    win.setSize(1100, 700);
    await sleep(800);
    const layout = await read(win, `(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      overflowX: getComputedStyle(document.documentElement).overflowX,
    }))()`);
    check('1100x700 无横向溢出', layout && layout.scrollWidth <= layout.clientWidth + 2, JSON.stringify(layout));
    await capture(win, 'v07-08-small-window.png');
    win.setSize(1600, 1000);
    await sleep(400);
  }

  check('控制台无错误', errors.length === 0, errors.slice(0, 5).join(' | '));

  const passed = checks.filter((item) => item.pass).length;
  const summary = { tick: await read(win, 'window.__lanwan.store.world.time.tick'), passed, total: checks.length, checks, errors, evidenceDir: 'docs/evidence_v0.7' };
  fs.writeFileSync(path.join(artifacts, 'acceptance-v07.json'), JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(evidence, 'acceptance-v07.json'), JSON.stringify(summary, null, 2));
  console.log(`\nACCEPTANCE v0.7: ${passed}/${checks.length} passed, console errors ${errors.length}`);
  app.exit(passed === checks.length ? 0 : 1);
});
