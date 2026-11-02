/**
 * v0.5 验收：Electron 桌面逐项操作验证（第 10 节）。
 *
 * 在隔离的 userData 目录里启动真实桌面窗口（Xvfb 虚拟显示），通过
 * 1) 真实 DOM 点击（data-action / data-testid）与
 * 2) 界面背后的同一命令层（window.__lanwan.store）执行验收要求的 9 组操作，
 * 截图并输出 JSON 结果到 artifacts/desktop-acceptance.json。
 *
 * 说明：经营权与投票持股属于本次修复范围之外的既有玩法路径（赢得选任/在二级市场买入），
 * 脚本用“测试前置”直接写入世界状态，并在结果里标注 fixture=true；其余步骤都走真实命令。
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { registerSaveHandlers } = require('../dist/electron/saveIpc.js');

const root = path.resolve(__dirname, '..');
const artifacts = path.join(root, 'artifacts');
fs.mkdirSync(artifacts, { recursive: true });
const userData = path.join(artifacts, 'desktop-acceptance-user-data');
fs.rmSync(userData, { recursive: true, force: true });
app.setPath('userData', userData);
const savesDir = path.join(app.getPath('userData'), 'saves');
fs.mkdirSync(savesDir, { recursive: true });
registerSaveHandlers(() => savesDir);

const COMPANY_ID = 'lp-food';
const OP_COMPANY_ID = 'lp-garment';
const ELECTION_COMPANY_ID = 'lp-energy';
const CITY_ID = 'lanport';
const checks = [];
const screenshots = [];
const errors = [];

function check(id, name, ok, detail) {
  checks.push({ id, name, ok: Boolean(ok), detail });
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`[${mark}] ${id} ${name}${detail === undefined ? '' : ` :: ${JSON.stringify(detail)}`}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(win, expression, timeoutMs = 20000) {
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

async function capture(win, name) {
  win.focus();
  win.webContents.invalidate();
  await sleep(350);
  const image = await win.webContents.capturePage();
  const file = path.join(artifacts, name);
  fs.writeFileSync(file, image.toPNG());
  screenshots.push(name);
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

/** 选中所属建筑，让右侧面板进入企业详情。 */
async function selectCompanyBuilding(win, companyId) {
  return win.webContents.executeJavaScript(`(() => {
    const s = window.__lanwan.store;
    const building = (s.selectedLayout?.buildings ?? []).find((entry) => entry.companyId === ${JSON.stringify(companyId)});
    if (!building) return null;
    s.selectBuilding(building.id);
    return building.id;
  })()`);
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
  const ignorable = /GL Driver Message|GPU stall|dbus\/|ReadPixels|libva|Failed to connect to the bus/i;
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2 && !ignorable.test(message)) errors.push(message);
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    errors.push(`renderer gone: ${JSON.stringify(details)}`);
  });

  let allOk = true;
  const finish = () => {
    allOk = checks.every((entry) => entry.ok);
    const output = {
      generatedAt: new Date().toISOString(),
      userData,
      savesDir,
      checks,
      screenshots,
      consoleErrors: errors,
      allOk,
    };
    fs.writeFileSync(path.join(artifacts, 'desktop-acceptance.json'), JSON.stringify(output, null, 2));
    console.log(`\n=== 桌面验收：${checks.filter((c) => c.ok).length}/${checks.length} 项通过；console 错误 ${errors.length} 条 ===`);
    app.exit(allOk && errors.length === 0 ? 0 : 1);
  };

  try {
    await win.loadFile(path.join(root, 'dist/renderer/index.html'));
    const ready = await waitFor(win, 'window.__lanwan && window.__lanwan.store && window.__lanwan.game');
    check('0', '桌面窗口启动并加载游戏', ready);
    await sleep(1800);

    // ---- ① 启动 → 打开城市 → 人口阶层区块 ----
    const regionShot = await capture(win, 'acceptance-01-region.png');
    check('1.0', '区域视图截图', Boolean(regionShot));
    await click(win, '[data-testid="city-card-lanport"]');
    await sleep(250);
    await click(win, '[data-testid="btn-enter-city"]');
    const entered = await waitFor(win, `window.__lanwan.store.view === 'city'`, 5000);
    await sleep(900);
    const strata = await read(win, `(() => {
      const el = document.querySelector('[data-testid="population-strata-section"]');
      return el ? { exists: true, text: el.innerText.slice(0, 900) } : { exists: false };
    })()`);
    await capture(win, 'acceptance-02-city-strata.png');
    check('1.1', '进入城市并显示「居民阶层与职业群体」', entered && strata.exists, {
      entered,
      hasStrataTitle: /阶层/.test(strata.text ?? ''),
      hasOccupation: /职业/.test(strata.text ?? ''),
    });

    // ---- ② 职业收入 / 阶层 / 消费数据 ----
    // 消费与工资在月度结算中产生：先推进 1 个月再读数据。
    await read(win, `(() => { const s = window.__lanwan.store; s.tick(); return true; })()`);
    await sleep(600);
    const strataData = await read(win, `(() => {
      const s = window.__lanwan.store;
      const groups = (s.world.households?.groups ?? []).filter((entry) => entry.cityId === ${JSON.stringify(CITY_ID)});
      const stats = (s.world.households?.lastStats ?? []).filter((entry) => entry.cityId === ${JSON.stringify(CITY_ID)});
      const tier = stats[0]?.tiers ?? [];
      return {
        groupCount: groups.length,
        incomes: groups.map((entry) => ({ occupation: entry.occupation, people: entry.people, income: entry.lastMonth.income, consumption: entry.lastMonth.consumption })),
        tiers: tier.map((entry) => ({ tier: entry.tier, people: entry.people, perCapita: entry.perCapitaWealth })),
        cityConsumption: s.world.cities.find((entry) => entry.id === ${JSON.stringify(CITY_ID)})?.lastMonth.consumerSpend ?? 0,
      };
    })()`);
    const occupationCount = strataData.groupCount ?? 0;
    const hasDifferentIncome = new Set((strataData.incomes ?? []).map((entry) => entry.income)).size > 1;
    check('2.1', '居民群体按职业展示且收入有差异', occupationCount >= 7 && hasDifferentIncome, {
      occupationCount,
      incomes: strataData.incomes,
    });
    check('2.2', '财富阶层三档与消费数据可读', (strataData.tiers ?? []).length === 3 && (strataData.cityConsumption ?? 0) > 0, {
      tiers: strataData.tiers,
      cityConsumption: strataData.cityConsumption,
    });

    // ---- ③ 未经营企业：不能贷款/还款 ----
    const buildingId = await selectCompanyBuilding(win, COMPANY_ID);
    await sleep(700);
    const nonOperated = await read(win, `(() => {
      const s = window.__lanwan.store;
      const company = s.world.companies.find((entry) => entry.id === ${JSON.stringify(COMPANY_ID)});
      const hint = document.querySelector('[data-testid="bank-company-no-operator"]');
      const companyLoanButtons = document.querySelectorAll('[data-action="take-loan"][data-owner-kind="company"]').length;
      const repayButtons = document.querySelectorAll('[data-action="repay-loan"]').length;
      const debtBefore = company.debt;
      const loansBefore = (s.world.banking?.loans ?? []).filter((loan) => loan.borrower.id === ${JSON.stringify(COMPANY_ID)}).length;
      const ok = s.takeLoan('company', ${JSON.stringify(COMPANY_ID)}, 'workingCapital', 1000);
      const after = s.world.companies.find((entry) => entry.id === ${JSON.stringify(COMPANY_ID)});
      const toast = document.body.innerText.includes('经营权');
      return {
        hint: hint ? hint.innerText : null,
        companyLoanButtons,
        repayButtons,
        ok,
        debtBefore,
        debtAfter: after.debt,
        loansBefore,
        loansAfter: (s.world.banking?.loans ?? []).filter((loan) => loan.borrower.id === ${JSON.stringify(COMPANY_ID)}).length,
        toastMentionsOperator: toast,
      };
    })()`);
    await capture(win, 'acceptance-03-no-operator.png');
    check('3.1', '未经营企业界面提示无经营权且不显示企业贷款按钮', Boolean(nonOperated.hint) && nonOperated.companyLoanButtons === 0, {
      hint: nonOperated.hint,
      companyLoanButtons: nonOperated.companyLoanButtons,
      repayButtons: nonOperated.repayButtons,
    });
    check('3.2', '命令层拒绝：无经营权借款失败且债务/合同零变化', nonOperated.ok === false && nonOperated.debtAfter === nonOperated.debtBefore && nonOperated.loansAfter === nonOperated.loansBefore && nonOperated.toastMentionsOperator, {
      ok: nonOperated.ok,
      debtBefore: nonOperated.debtBefore,
      debtAfter: nonOperated.debtAfter,
      loansBefore: nonOperated.loansBefore,
      loansAfter: nonOperated.loansAfter,
      toast: nonOperated.toastMentionsOperator,
    });

    // ---- ④ 测试前置：取得经营权；界面切换三种经营模式 ----
    await selectCompanyBuilding(win, OP_COMPANY_ID);
    await sleep(400);
    const grant = await read(win, `(() => {
      const s = window.__lanwan.store;
      const world = s.world;
      const control = world.governance.controls.find((entry) => entry.companyId === ${JSON.stringify(OP_COMPANY_ID)});
      if (!control) return { ok: false, reason: 'missing control' };
      // 释放原来的 AI 经营者档案（与 releaseOperator 行为一致），避免“一人双任”。
      if (control.operatorId) {
        const profile = world.management.operators.find((entry) => entry.id === control.operatorId);
        if (profile) {
          profile.status = 'available';
          profile.companyId = null;
          profile.appointedTick = null;
          profile.termEndTick = null;
        }
      }
      control.operator = { type: 'player', id: 'player' };
      control.basis = 'election';
      control.operatorId = null;
      control.termEndTick = world.time.tick + 24;
      control.note = '桌面验收测试前置：授予玩家经营权';
      s.tick();
      s.emit();
      return { ok: true, tick: world.time.tick };
    })()`);
    await sleep(800);
    const operatorBlock = await read(win, `Boolean(document.querySelector('[data-testid="company-operator"]'))`);
    const modes = [];
    for (const mode of ['manual', 'assisted', 'delegated']) {
      const clicked = await click(win, `[data-action="set-operation-mode"][data-mode="${mode}"]`);
      await sleep(350);
      const current = await read(win, `(() => {
        const s = window.__lanwan.store;
        const op = (s.world.management.playerOperations ?? []).find((entry) => entry.companyId === ${JSON.stringify(OP_COMPANY_ID)});
        return op ? op.mode : null;
      })()`);
      modes.push({ mode, clicked, current });
    }
    await capture(win, 'acceptance-04-operation-modes.png');
    check('4.1', '界面显示经营者区块并可切换 manual/assisted/delegated', grant.ok && operatorBlock && modes.every((entry) => entry.clicked && entry.current === entry.mode), {
      grant,
      operatorBlock,
      modes,
    });

    // ---- ⑤ 需要授权的贷款：批准前不生效，批准后生效 ----
    await read(win, `(() => {
      const s = window.__lanwan.store;
      s.setOperationMode(${JSON.stringify(OP_COMPANY_ID)}, 'assisted');
      const company = s.world.companies.find((entry) => entry.id === ${JSON.stringify(OP_COMPANY_ID)});
      company.cash = 0; // 测试前置：制造工资/采购资金缺口
      s.emit();
      return true;
    })()`);
    const proposalBefore = await read(win, `(() => {
      const s = window.__lanwan.store;
      const company = s.world.companies.find((entry) => entry.id === ${JSON.stringify(OP_COMPANY_ID)});
      return { tick: s.world.time.tick, debt: company.debt, loans: s.world.banking.loans.filter((loan) => loan.borrower.id === ${JSON.stringify(OP_COMPANY_ID)}).length };
    })()`);
    const ticked = await read(win, `(() => { const s = window.__lanwan.store; const ok = s.tick(); return { ok, tick: s.world.time.tick }; })()`);
    await sleep(700);
    const proposalState = await read(win, `(() => {
      const s = window.__lanwan.store;
      const op = (s.world.management.playerOperations ?? []).find((entry) => entry.companyId === ${JSON.stringify(OP_COMPANY_ID)});
      const pending = (op?.proposals ?? []).filter((entry) => entry.status === 'pending' && entry.kind === 'loan');
      const company = s.world.companies.find((entry) => entry.id === ${JSON.stringify(OP_COMPANY_ID)});
      return {
        pending: pending.map((entry) => ({ id: entry.id, kind: entry.kind, params: entry.params, status: entry.status })),
        debt: company.debt,
        loans: s.world.banking.loans.filter((loan) => loan.borrower.id === ${JSON.stringify(OP_COMPANY_ID)}).length,
        button: Boolean(document.querySelector('[data-action="decide-proposal"][data-approve="1"]')),
      };
    })()`);
    await capture(win, 'acceptance-05-loan-proposal.png');
    const beforeOk =
      (proposalState.pending ?? []).length > 0 &&
      proposalState.debt === proposalBefore.debt &&
      proposalState.loans === proposalBefore.loans;
    check('5.1', 'assisted 模式资金缺口生成待批准贷款提案，批准前债务/合同不变', beforeOk, {
      proposalBefore,
      ticked,
      pending: proposalState.pending,
      debt: proposalState.debt,
      loans: proposalState.loans,
    });
    const approved = await read(win, `(() => {
      const s = window.__lanwan.store;
      const op = (s.world.management.playerOperations ?? []).find((entry) => entry.companyId === ${JSON.stringify(OP_COMPANY_ID)});
      const proposal = (op?.proposals ?? []).find((entry) => entry.status === 'pending' && entry.kind === 'loan');
      if (!proposal) return { ok: false, reason: 'no pending proposal' };
      const before = s.world.companies.find((entry) => entry.id === ${JSON.stringify(OP_COMPANY_ID)}).debt;
      const clicked = s.decideProposal(proposal.id, true);
      const after = s.world.companies.find((entry) => entry.id === ${JSON.stringify(OP_COMPANY_ID)}).debt;
      return { ok: clicked, before, after, status: proposal.status };
    })()`);
    await sleep(700);
    // 测试前置：把现金恢复到可持续水平，避免企业在选任前因资不抵债被清算（清算逻辑属既有玩法）。
    const restoredCash = await read(win, `(() => {
      const s = window.__lanwan.store;
      const company = s.world.companies.find((entry) => entry.id === ${JSON.stringify(OP_COMPANY_ID)});
      if (company) company.cash = 400000000;
      s.emit();
      return company ? company.cash : null;
    })()`);
    check('5.2', '批准提案后贷款生效（债务增加）', approved.ok === true && approved.after > approved.before, { ...approved, restoredCash });
    await capture(win, 'acceptance-05b-loan-approved.png');

    // ---- ⑥ 经营者选任：候选人 / 投票 / 结果 ----
    const shareSetup = await read(win, `(() => {
      const s = window.__lanwan.store;
      const world = s.world;
      const shareClass = world.securities.classes.find((entry) => entry.companyId === ${JSON.stringify(ELECTION_COMPANY_ID)} && entry.kind === 'voting');
      if (!shareClass) return { ok: false, reason: 'no voting class' };
      const holdings = world.securities.holdings.filter((entry) => entry.shareClassId === shareClass.id && entry.shares > 0);
      const seller = holdings.find((entry) => entry.holder.type === 'investorGroup');
      if (!seller) return { ok: false, reason: 'no investorGroup holding' };
      const shares = Math.min(500, Math.floor(seller.shares / 10));
      const price = 2;
      const value = shares * price;
      if (shares <= 0 || world.player.cash < value) return { ok: false, reason: 'not enough cash' };
      seller.shares -= shares;
      world.player.cash -= value;
      const group = world.investors.find((entry) => entry.id === seller.holder.id);
      if (group) group.cash += value;
      world.securities.holdings.push({
        companyId: ${JSON.stringify(ELECTION_COMPANY_ID)},
        shareClassId: shareClass.id,
        holder: { type: 'player', id: 'player' },
        shares,
        acquiredVia: 'secondary',
        sinceTick: world.time.tick,
      });
      s.emit();
      return { ok: true, shares, price, value };
    })()`);
    // 推进到首次经营者选任（termMonths = 24）并等待议案打开。
    const electionRun = await read(win, `(() => {
      const s = window.__lanwan.store;
      for (let i = 0; i < 30; i += 1) {
        const motion = (s.world.governance.motions ?? []).find(
          (entry) => entry.kind === 'operatorElection' && entry.companyId === ${JSON.stringify(ELECTION_COMPANY_ID)} && entry.status === 'open',
        );
        if (motion) return { found: true, tick: s.world.time.tick, motionId: motion.id };
        s.tick();
      }
      const motion = (s.world.governance.motions ?? []).find((entry) => entry.kind === 'operatorElection');
      return { found: false, tick: s.world.time.tick, anyMotion: Boolean(motion) };
    })()`);
    await sleep(700);
    await selectCompanyBuilding(win, ELECTION_COMPANY_ID);
    await sleep(600);
    const electionUi = await read(win, `(() => {
      const s = window.__lanwan.store;
      const motion = (s.world.governance.motions ?? []).find((entry) => entry.kind === 'operatorElection' && entry.companyId === ${JSON.stringify(ELECTION_COMPANY_ID)} && entry.status === 'open');
      const section = document.querySelector('[data-testid="company-operator-election"]');
      return {
        section: Boolean(section),
        candidates: motion ? (motion.candidates ?? []).map((entry) => ({ id: entry.candidateId, kind: entry.kind, name: entry.name })) : [],
        canRegister: Boolean(document.querySelector('[data-action="register-candidate"]')),
        canVote: document.querySelectorAll('[data-action="vote-election"]').length,
        tick: s.world.time.tick,
      };
    })()`);
    let registered = { clicked: false };
    if (electionUi.canRegister) {
      registered.clicked = await click(win, '[data-action="register-candidate"]');
      await sleep(500);
      registered.state = await read(win, `(() => {
        const s = window.__lanwan.store;
        const motion = (s.world.governance.motions ?? []).find((entry) => entry.kind === 'operatorElection' && entry.companyId === ${JSON.stringify(ELECTION_COMPANY_ID)} && entry.status === 'open');
        return motion ? (motion.candidates ?? []).map((entry) => ({ id: entry.candidateId, kind: entry.kind })) : [];
      })()`);
    }
    await capture(win, 'acceptance-06-election.png');
    let voted = { clicked: false };
    const voteTarget = await read(win, `(() => {
      const el = document.querySelector('[data-action="vote-election"][data-candidate-id="player"]') ?? document.querySelector('[data-action="vote-election"]');
      return el ? { candidateId: el.dataset.candidateId, motionId: el.dataset.motionId } : null;
    })()`);
    if (voteTarget) {
      voted.clicked = await click(win, `[data-action="vote-election"][data-candidate-id="${voteTarget.candidateId}"]`);
      await sleep(400);
      voted.state = await read(win, `(() => {
        const s = window.__lanwan.store;
        const motion = (s.world.governance.motions ?? []).find((entry) => entry.id === ${JSON.stringify(voteTarget.motionId)});
        const vote = (motion?.votes ?? []).find((entry) => entry.holder.type === 'player');
        return { vote: vote ? { candidateId: vote.candidateId, shares: vote.votingShares } : null, status: motion?.status ?? null };
      })()`);
    }
    // 投票期结束后计票。
    const closed = await read(win, `(() => {
      const s = window.__lanwan.store;
      for (let i = 0; i < 4; i += 1) {
        const motion = (s.world.governance.motions ?? []).find((entry) => entry.kind === 'operatorElection' && entry.companyId === ${JSON.stringify(ELECTION_COMPANY_ID)});
        if (motion && motion.status !== 'open') return { tick: s.world.time.tick, status: motion.status, result: motion.result ?? null };
        s.tick();
      }
      const motion = (s.world.governance.motions ?? []).find((entry) => entry.kind === 'operatorElection' && entry.companyId === ${JSON.stringify(ELECTION_COMPANY_ID)});
      const control = s.world.governance.controls.find((entry) => entry.companyId === ${JSON.stringify(ELECTION_COMPANY_ID)});
      return { tick: s.world.time.tick, status: motion?.status ?? 'missing', control: control ? { basis: control.basis, operator: control.operator, operatorId: control.operatorId } : null };
    })()`);
    await capture(win, 'acceptance-06b-election-result.png');
    check('6.1', '选任界面显示候选人与投票入口', electionUi.section && (electionUi.candidates ?? []).length >= 2 && electionUi.canVote > 0, {
      shareSetup,
      electionRun,
      electionUi,
    });
    check('6.2', '玩家登记参选并投票，计票后议案结束', registered.clicked === true && (registered.state ?? []).some((entry) => entry.kind === 'player') && voted.clicked === true && closed.status !== 'open' && closed.status !== 'missing', {
      registered,
      voted,
      closed,
    });

    // ---- ⑦ 存款 / 取款 / 个人贷款 / 还款 ----
    const bank = await read(win, `(async () => {
      const s = window.__lanwan.store;
      const player = s.world.player;
      const deposits = (world) => (world.banking.deposits ?? []).filter((entry) => entry.owner.kind === 'player').reduce((total, entry) => total + entry.balance, 0);
      const cashBefore = player.cash;
      const depositOk = s.depositToBank(500000);
      const afterDeposit = { cash: s.world.player.cash, deposits: deposits(s.world) };
      const withdrawOk = s.withdrawFromBank(200000);
      const afterWithdraw = { cash: s.world.player.cash, deposits: deposits(s.world) };
      const loanOk = s.takeLoan('player', 'player', 'personal', 100000);
      const loan = (s.world.banking.loans ?? []).find((entry) => entry.borrower.kind === 'player' && entry.status === 'active');
      const repayOk = loan ? s.repayBankLoan(loan.id, 50000) : false;
      const loanAfter = (s.world.banking.loans ?? []).find((entry) => entry.id === loan?.id);
      return {
        cashBefore,
        depositOk,
        afterDeposit,
        withdrawOk,
        afterWithdraw,
        loanOk,
        loan: loan ? { id: loan.id, principal: loan.principal, outstanding: loan.outstanding, termMonths: loan.termMonths } : null,
        repayOk,
        loanAfter: loanAfter ? { outstanding: loanAfter.outstanding, paidPrincipal: loanAfter.paidPrincipal } : null,
        cashFinal: s.world.player.cash,
      };
    })()`);
    await sleep(500);
    await capture(win, 'acceptance-07-bank.png');
    check('7.1', '存款/取款走银行账户且现金与存款同步', bank.depositOk && bank.withdrawOk && bank.afterDeposit.deposits === 500000 && bank.afterWithdraw.deposits === 300000, bank);
    check('7.2', '个人贷款与提前还款生效', bank.loanOk && bank.loan && bank.repayOk && bank.loanAfter && bank.loanAfter.outstanding < bank.loan.principal && bank.loanAfter.paidPrincipal > 0, bank);

    // ---- ⑧ 保存 → 推进 → 读取 ----
    const saved = await read(win, `(async () => {
      const s = window.__lanwan.store;
      const ok = await s.saveSlot('manual-1');
      const snapshot = {
        tick: s.world.time.tick,
        cash: s.world.player.cash,
        deposits: (s.world.banking.deposits ?? []).filter((entry) => entry.owner.kind === 'player').reduce((total, entry) => total + entry.balance, 0),
        loans: (s.world.banking.loans ?? []).length,
        debt: s.world.companies.find((entry) => entry.id === ${JSON.stringify(COMPANY_ID)})?.debt ?? null,
      };
      s.tick();
      const advanced = { tick: s.world.time.tick, date: s.dateLabel };
      const loaded = await s.loadSlot('manual-1');
      return { ok, snapshot, advanced, loaded, restored: { tick: s.world.time.tick, cash: s.world.player.cash, deposits: (s.world.banking.deposits ?? []).filter((entry) => entry.owner.kind === 'player').reduce((total, entry) => total + entry.balance, 0), loans: (s.world.banking.loans ?? []).length, debt: s.world.companies.find((entry) => entry.id === ${JSON.stringify(COMPANY_ID)})?.debt ?? null }, slots: await s.listSlots() };
    })()`);
    await sleep(600);
    await capture(win, 'acceptance-08-save-load.png');
    const restoredMatches =
      saved.ok && saved.loaded && saved.restored.tick === saved.snapshot.tick && saved.restored.cash === saved.snapshot.cash && saved.restored.deposits === saved.snapshot.deposits && saved.restored.loans === saved.snapshot.loans && saved.restored.debt === saved.snapshot.debt;
    check('8.1', '保存后推进再读取：时间/现金/存款/贷款/债务恢复一致', restoredMatches, saved);

    // ---- ⑨ 控制台错误、按钮可达性、小窗口溢出 ----
    const smallWindow = await read(win, `({ width: innerWidth, height: innerHeight })`);
    win.setSize(1100, 700);
    await sleep(1200);
    const overflow = await read(win, `({ innerWidth, scrollWidth: document.documentElement.scrollWidth, overflowX: document.documentElement.scrollWidth > innerWidth + 2, scrollHeight: document.documentElement.scrollHeight, innerHeight })`);
    await capture(win, 'acceptance-09-small-window.png');
    const buttons = await read(win, `(() => {
      const list = [...document.querySelectorAll('[data-action]')];
      const emptyAction = list.filter((el) => !(el.dataset.action ?? '').trim()).length;
      const invisible = list.filter((el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width === 0 || rect.height === 0 || style.visibility === 'hidden' || style.display === 'none';
      }).length;
      return { total: list.length, emptyAction, invisible };
    })()`);
    check('9.1', '无控制台错误', errors.length === 0, { consoleErrors: errors });
    check('9.2', '按钮均带有效动作且无隐藏的无响应按钮', buttons.total > 0 && buttons.emptyAction === 0 && buttons.invisible === 0, buttons);
    check('9.3', '小窗口无横向溢出', overflow.overflowX === false, { smallWindow, overflow });

    finish();
  } catch (error) {
    errors.push(`script error: ${error && error.stack ? error.stack : String(error)}`);
    check('E', '脚本执行完成', false, { error: String(error) });
    finish();
  }
});
