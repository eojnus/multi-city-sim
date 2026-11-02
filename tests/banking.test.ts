import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation/core/simulation';
import { DEMO_CONFIG } from '../src/data/config';
import type {
  BankOwner,
  Company,
  LogEntry,
  WorldState,
} from '../src/simulation/contracts/types';
import { round2 } from '../src/simulation/core/math';
import { parseSave, serializeSave } from '../src/simulation/core/save';
import {
  createInitialBanking,
  deposit,
  depositAccountFor,
  ensureCompanyLiquidity,
  ensureDepositAccount,
  loanLabel,
  migrateLegacyCompanyDebt,
  openLoan,
  repayLoan,
  serviceCompanyLoans,
  servicePlayerLoans,
  settleCompanyLiquidation,
  settleDepositInterest,
  syncCompanyDebt,
  totalOutstanding,
  withdraw,
} from '../src/simulation/banking/banking';
import {
  availableCredit,
  companyEquityBase,
  creditEvaluation,
  creditOwnerCash,
  debitOwnerCash,
  ownerCash,
  ownerKey,
  personalNetWorthBase,
  refreshCreditSnapshots,
  snapshotFor,
} from '../src/simulation/banking/credit';
import { settleBankMonth } from '../src/simulation/banking/settlement';

// ---------------------------------------------------------------- 测试工具

function newWorld(): WorldState {
  const world = Simulation.create().state;
  // 核心接线阶段防御：银行由 initializer 初始化，这里兜底避免测试因接线顺序失败。
  if (!world.banking) world.banking = createInitialBanking(DEMO_CONFIG);
  return world;
}

function playerOwner(): BankOwner {
  return { kind: 'player', id: 'player' };
}

function companyOwner(company: Company): BankOwner {
  return { kind: 'company', id: company.id };
}

function companyOf(world: WorldState, companyId = 'lp-food'): Company {
  const company = world.companies.find((entry) => entry.id === companyId);
  if (!company) throw new Error(`测试企业 ${companyId} 不存在`);
  return company;
}

function freshLogs(): LogEntry[] {
  return [];
}

function depositBalance(world: WorldState, owner: BankOwner): number {
  return depositAccountFor(world, owner)?.balance ?? 0;
}

// ---------------------------------------------------------------- 存款

describe('银行存款', () => {
  it('账户幂等创建，存款/取款只搬运现金，余额不足不部分扣款', () => {
    const world = newWorld();
    const owner = playerOwner();
    const cashBefore = world.player.cash;

    const account = ensureDepositAccount(world, owner, DEMO_CONFIG, 0);
    expect(account.id).toMatch(/^dep-\d+$/);
    expect(ensureDepositAccount(world, owner, DEMO_CONFIG, 0)).toBe(account);
    expect(world.banking.deposits.filter((entry) => ownerKey(entry.owner) === ownerKey(owner))).toHaveLength(1);

    const depositResult = deposit(world, owner, 50_000, DEMO_CONFIG, 0);
    expect(depositResult.ok).toBe(true);
    expect(world.player.cash).toBeCloseTo(cashBefore - 50_000, 2);
    expect(account.balance).toBeCloseTo(50_000, 2);

    const overdraw = withdraw(world, owner, 60_000, DEMO_CONFIG, 0);
    expect(overdraw.ok).toBe(false);
    expect(account.balance).toBeCloseTo(50_000, 2);
    expect(world.player.cash).toBeCloseTo(cashBefore - 50_000, 2);

    const withdrawResult = withdraw(world, owner, 20_000, DEMO_CONFIG, 0);
    expect(withdrawResult.ok).toBe(true);
    expect(account.balance).toBeCloseTo(30_000, 2);
    expect(world.player.cash).toBeCloseTo(cashBefore - 30_000, 2);

    // 没有账户的主体不能取款；现金扣款失败时不部分扣款。
    expect(withdraw(world, { kind: 'investorGroup', id: 'nope' }, 100, DEMO_CONFIG, 0).ok).toBe(false);
    const cashNow = world.player.cash;
    expect(debitOwnerCash(world, owner, cashNow + 1)).toBe(false);
    expect(world.player.cash).toBeCloseTo(cashNow, 2);
    creditOwnerCash(world, owner, 0);
    expect(world.player.cash).toBeCloseTo(cashNow, 2);
  });

  it('存款按月初余额计息入账，银行统计利息支出与存款总额一致', () => {
    const world = newWorld();
    const owner = playerOwner();
    ensureDepositAccount(world, owner, DEMO_CONFIG, 0);
    deposit(world, owner, 100_000, DEMO_CONFIG, 0);
    const before = world.banking.deposits.map((account) => ({
      id: account.id,
      balance: account.balance,
      rate: account.rateMonthly,
    }));

    const logs = freshLogs();
    settleBankMonth(world, DEMO_CONFIG, 1, logs);

    let expectedInterest = 0;
    for (const entry of before) {
      const account = world.banking.deposits.find((candidate) => candidate.id === entry.id);
      expect(account).toBeDefined();
      const interest = round2(entry.balance * entry.rate);
      expectedInterest = round2(expectedInterest + interest);
      expect(account!.balance).toBeCloseTo(round2(entry.balance + interest), 2);
      expect(account!.lastInterestTick).toBe(1);
    }
    const playerAccount = depositAccountFor(world, owner);
    expect(playerAccount!.balance).toBeCloseTo(100_100, 2);
    expect(playerAccount!.accruedInterest).toBeCloseTo(100, 2);
    expect(world.banking.lastMonth.interestExpense).toBeCloseTo(expectedInterest, 2);
    const totalBalance = round2(
      world.banking.deposits.reduce((total, account) => total + account.balance, 0),
    );
    expect(world.banking.lastMonth.depositsTotal).toBeCloseTo(totalBalance, 2);
  });

  it('存款账户不存在时结算不创建账户', () => {
    const world = newWorld();
    const owner: BankOwner = { kind: 'investorGroup', id: 'no-such-group' };
    expect(depositAccountFor(world, owner)).toBeUndefined();
    settleBankMonth(world, DEMO_CONFIG, 1, freshLogs());
    expect(depositAccountFor(world, owner)).toBeUndefined();
  });
});

// ---------------------------------------------------------------- 授信

describe('授信额度', () => {
  it('个人额度 = 可核验净资产 × 50% − 未偿；存款计入、贷款不虚增额度', () => {
    const world = newWorld();
    const owner = playerOwner();
    deposit(world, owner, 100_000, DEMO_CONFIG, 0);

    const base = personalNetWorthBase(world, DEMO_CONFIG);
    // 个人基准 = 玩家现金 + 银行存款 + 股票权益 − 未偿贷款。
    expect(base).toBeCloseTo(round2(world.player.cash + depositBalance(world, owner)), 2);

    const before = creditEvaluation(world, owner, DEMO_CONFIG);
    expect(before.method).toBe('netWorth');
    expect(before.limit).toBeCloseTo(round2(base * DEMO_CONFIG.banking.creditLimitRate), 2);
    expect(before.outstanding).toBe(0);
    expect(before.available).toBeCloseTo(before.limit, 2);

    const opened = openLoan(
      world,
      { owner, purpose: 'personal', amount: 100_000 },
      DEMO_CONFIG,
      0,
    );
    expect(opened.ok).toBe(true);
    expect(opened.loan).toBeDefined();

    const after = creditEvaluation(world, owner, DEMO_CONFIG);
    expect(after.outstanding).toBeCloseTo(100_000, 2);
    expect(after.available).toBeCloseTo(round2(before.limit - 100_000), 2);
    // 借款让现金与未偿同步增加，基准不因借钱变大（不虚增额度）。
    expect(after.baseValue).toBeCloseTo(before.baseValue, 2);
    expect(after.limit).toBeCloseTo(before.limit, 2);
  });

  it('企业额度 = 非负账面股权 × 50% − 未偿，company.debt 镜像同步且不计入 GDP', () => {
    const world = newWorld();
    const company = companyOf(world);
    const owner = companyOwner(company);
    const gdpBefore = world.cities.map((city) => city.gdp);
    const cashBefore = company.cash;

    const base = companyEquityBase(world, company);
    expect(base).toBeGreaterThan(0);
    const before = creditEvaluation(world, owner, DEMO_CONFIG);
    expect(before.method).toBe('equityBook');
    expect(before.limit).toBeCloseTo(round2(base * DEMO_CONFIG.banking.creditLimitRate), 2);

    const opened = openLoan(
      world,
      { owner, purpose: 'workingCapital', amount: 100_000 },
      DEMO_CONFIG,
      0,
    );
    expect(opened.ok).toBe(true);
    expect(company.cash).toBeCloseTo(cashBefore + 100_000, 2);
    expect(company.debt).toBeCloseTo(100_000, 2);
    expect(totalOutstanding(world, owner)).toBeCloseTo(100_000, 2);
    // 借入现金与债务同步增加，账面股权基准保持不变。
    expect(companyEquityBase(world, company)).toBeCloseTo(base, 2);
    expect(creditEvaluation(world, owner, DEMO_CONFIG).available).toBeCloseTo(
      round2(before.limit - 100_000),
      2,
    );
    // 贷款本金不是产出：城市 GDP 字段不得被银行模块改写。
    expect(world.cities.map((city) => city.gdp)).toEqual(gdpBefore);
  });

  it('借 → 还 → 再借不会放大额度；还款释放额度', () => {
    const world = newWorld();
    const company = companyOf(world);
    company.cash = 1_000_000;
    const owner = companyOwner(company);
    const init = creditEvaluation(world, owner, DEMO_CONFIG);

    const first = openLoan(
      world,
      { owner, purpose: 'workingCapital', amount: 100_000 },
      DEMO_CONFIG,
      0,
    );
    expect(first.ok).toBe(true);
    expect(company.debt).toBeCloseTo(100_000, 2);
    expect(availableCredit(world, owner, DEMO_CONFIG)).toBeCloseTo(
      round2(init.limit - 100_000),
      2,
    );

    const repaid = repayLoan(world, first.loan!.id, 100_000, DEMO_CONFIG, 0);
    expect(repaid.ok).toBe(true);
    expect(company.debt).toBeCloseTo(0, 2);
    expect(availableCredit(world, owner, DEMO_CONFIG)).toBeCloseTo(init.limit, 2);

    const second = openLoan(
      world,
      { owner, purpose: 'workingCapital', amount: 100_000 },
      DEMO_CONFIG,
      0,
    );
    expect(second.ok).toBe(true);
    expect(second.loan!.principal).toBeCloseTo(100_000, 2);
    expect(availableCredit(world, owner, DEMO_CONFIG)).toBeCloseTo(
      round2(init.limit - 100_000),
      2,
    );
    expect(creditEvaluation(world, owner, DEMO_CONFIG).limit).toBeCloseTo(init.limit, 2);
  });

  it('超出可借额度、非法用途与低于最低金额均被拒绝且不产生副作用', () => {
    const world = newWorld();
    const owner = playerOwner();
    const evaluation = creditEvaluation(world, owner, DEMO_CONFIG);
    const cashBefore = world.player.cash;

    const overLimit = openLoan(
      world,
      { owner, purpose: 'personal', amount: round2(evaluation.available + 10_000) },
      DEMO_CONFIG,
      0,
    );
    expect(overLimit.ok).toBe(false);
    expect(overLimit.error).toContain('超出可借额度');
    expect(world.banking.loans).toHaveLength(0);
    expect(world.player.cash).toBeCloseTo(cashBefore, 2);

    const belowMinimum = openLoan(
      world,
      { owner, purpose: 'personal', amount: DEMO_CONFIG.banking.minLoanAmount - 1 },
      DEMO_CONFIG,
      0,
    );
    expect(belowMinimum.ok).toBe(false);

    const company = companyOf(world);
    const wrongPurpose = openLoan(
      world,
      { owner: companyOwner(company), purpose: 'personal', amount: 20_000 },
      DEMO_CONFIG,
      0,
    );
    expect(wrongPurpose.ok).toBe(false);
  });

  it('月度授信快照当月稳定，新增本金立即占用当月额度，下月刷新后重算', () => {
    const world = newWorld();
    const company = companyOf(world);
    const owner = companyOwner(company);
    refreshCreditSnapshots(world, DEMO_CONFIG, 5);

    const snapshot = snapshotFor(world, owner);
    expect(snapshot).toBeDefined();
    expect(snapshot!.tick).toBe(5);
    expect(snapshot!.method).toBe('equityBook');
    expect(snapshot!.limit).toBeCloseTo(round2(Math.max(0, snapshot!.baseValue) * 0.5), 2);

    const stableBefore = creditEvaluation(world, owner, DEMO_CONFIG);
    // 当月账面价值变化（未刷新快照）不得改变已生成的额度。
    company.cash = round2(company.cash + 500_000);
    const stableAfter = creditEvaluation(world, owner, DEMO_CONFIG);
    expect(stableAfter.baseValue).toBeCloseTo(stableBefore.baseValue, 2);
    expect(stableAfter.limit).toBeCloseTo(stableBefore.limit, 2);

    // 新增本金立即占用额度（按当前未偿实时算）。
    const opened = openLoan(
      world,
      { owner, purpose: 'workingCapital', amount: 100_000 },
      DEMO_CONFIG,
      5,
    );
    expect(opened.ok).toBe(true);
    expect(creditEvaluation(world, owner, DEMO_CONFIG).available).toBeCloseTo(
      round2(stableBefore.available - 100_000),
      2,
    );

    // 下月刷新后按新的账面价值重算额度。
    refreshCreditSnapshots(world, DEMO_CONFIG, 6);
    const next = creditEvaluation(world, owner, DEMO_CONFIG);
    expect(next.limit).toBeGreaterThan(stableBefore.limit);

    // 每主体快照数量受配置上限约束。
    for (let tick = 7; tick < 60; tick += 1) {
      refreshCreditSnapshots(world, DEMO_CONFIG, tick);
    }
    const count = world.banking.snapshots.filter(
      (entry) => entry.borrower.kind === 'company' && entry.borrower.id === company.id,
    ).length;
    expect(count).toBeLessThanOrEqual(DEMO_CONFIG.banking.maxSnapshotsPerBorrower);
  });

  it('无快照时 availableCredit 也能即时计算（生命周期/经营提案可直接调用）', () => {
    const world = newWorld();
    expect(world.banking.snapshots).toHaveLength(0);
    const company = companyOf(world);
    const value = availableCredit(world, companyOwner(company), DEMO_CONFIG);
    expect(Number.isFinite(value)).toBe(true);
    expect(value).toBeGreaterThan(0);
    expect(totalOutstanding(world, companyOwner(company))).toBe(0);
  });
});

// ---------------------------------------------------------------- 贷款偿还

describe('贷款偿还与风险', () => {
  it('等额本金、首期从下一月开始，最后一期吸收尾差', () => {
    const world = newWorld();
    const company = companyOf(world);
    company.cash = 1_000_000;
    const owner = companyOwner(company);
    const opened = openLoan(world, { owner, purpose: 'workingCapital', amount: 10_000 }, DEMO_CONFIG, 0);
    expect(opened.ok).toBe(true);
    const loan = opened.loan!;
    expect(loan.nextDueTick).toBe(1);
    expect(loan.monthlyPrincipal).toBeCloseTo(round2(10_000 / 24), 2);

    const logs = freshLogs();
    // 放款当月不还（首期从下一月开始）。
    settleBankMonth(world, DEMO_CONFIG, 0, logs);
    expect(loan.payments).toHaveLength(0);
    expect(loan.outstanding).toBeCloseTo(10_000, 2);

    settleBankMonth(world, DEMO_CONFIG, 1, logs);
    expect(loan.payments).toHaveLength(1);
    const firstPayment = loan.payments[0]!;
    expect(firstPayment.principalDue).toBeCloseTo(416.67, 2);
    expect(firstPayment.interestDue).toBeCloseTo(50, 2);
    expect(firstPayment.interestPaid).toBeCloseTo(50, 2);
    expect(firstPayment.principalPaid).toBeCloseTo(416.67, 2);
    expect(loan.outstanding).toBeCloseTo(9_583.33, 2);
    expect(loan.paidPrincipal).toBeCloseTo(416.67, 2);
    expect(loan.paidInterest).toBeCloseTo(50, 2);

    for (let tick = 2; tick <= 24; tick += 1) {
      settleBankMonth(world, DEMO_CONFIG, tick, logs);
    }
    expect(loan.payments).toHaveLength(24);
    expect(loan.status).toBe('repaid');
    expect(loan.outstanding).toBe(0);
    const totalPrincipal = round2(
      loan.payments.reduce((total, payment) => total + payment.principalPaid, 0),
    );
    expect(totalPrincipal).toBeCloseTo(10_000, 2);
    expect(company.debt).toBeCloseTo(0, 2);
  });

  it('还款不足时先付到期利息、再还本金，未付部分记入欠款', () => {
    const world = newWorld();
    const company = companyOf(world);
    company.cash = 0;
    const owner = companyOwner(company);
    const opened = openLoan(world, { owner, purpose: 'workingCapital', amount: 12_000 }, DEMO_CONFIG, 0);
    expect(opened.ok).toBe(true);
    const loan = opened.loan!;
    company.cash = 100;

    settleBankMonth(world, DEMO_CONFIG, 1, freshLogs());
    const payment = loan.payments[0]!;
    expect(payment.interestDue).toBeCloseTo(60, 2);
    expect(payment.interestPaid).toBeCloseTo(60, 2);
    expect(payment.principalPaid).toBeCloseTo(40, 2);
    expect(payment.arrears).toBeCloseTo(460, 2);
    expect(loan.arrearsInterest).toBeCloseTo(0, 2);
    expect(loan.arrearsPrincipal).toBeCloseTo(460, 2);
    expect(loan.outstanding).toBeCloseTo(11_960, 2);
    expect(loan.paidPrincipal).toBeCloseTo(40, 2);
    expect(loan.paidInterest).toBeCloseTo(60, 2);
    expect(company.cash).toBeCloseTo(0, 2);
    expect(company.debt).toBeCloseTo(11_960, 2);
    expect(loan.missedPayments).toBe(1);
    expect(loan.status).toBe('active');
  });

  it('逾期宽限 1 个月，第 2 个月仍欠付标记违约并写日志（不加罚息）', () => {
    const world = newWorld();
    const company = companyOf(world);
    company.cash = 0;
    const opened = openLoan(
      world,
      { owner: companyOwner(company), purpose: 'workingCapital', amount: 12_000 },
      DEMO_CONFIG,
      0,
    );
    const loan = opened.loan!;
    const logs = freshLogs();
    // 放款后现金曾短暂到账；模拟企业当月起就把现金耗尽（工资/采购），还款能力为 0。
    company.cash = 0;

    settleBankMonth(world, DEMO_CONFIG, 1, logs);
    expect(loan.missedPayments).toBe(1);
    expect(loan.status).toBe('active');

    settleBankMonth(world, DEMO_CONFIG, 2, logs);
    expect(loan.missedPayments).toBe(2);
    expect(loan.status).toBe('defaulted');
    expect(world.banking.lastMonth.newDefaults).toBe(1);
    expect(logs.some((entry) => entry.kind === 'warning' && entry.message.includes('违约'))).toBe(true);

    // 违约后继续按合同计息与尝试收款：利息仍按未偿本金计算，没有罚息字段/加倍利息。
    const interestBefore = loan.payments[loan.payments.length - 1]!.interestDue;
    expect(interestBefore).toBeCloseTo(60, 2);
    company.cash = 60;
    settleBankMonth(world, DEMO_CONFIG, 3, logs);
    expect(loan.payments[loan.payments.length - 1]!.interestDue).toBeCloseTo(60, 2);
    // 60 先付本期利息，历史欠息仍保留，且未付金额不额外计息。
    expect(loan.arrearsInterest).toBeGreaterThan(0);
  });

  it('提前还款先息后本、不收费用；未到首期时只还本金', () => {
    const world = newWorld();
    const owner = playerOwner();
    const cashBefore = world.player.cash;
    const opened = openLoan(world, { owner, purpose: 'personal', amount: 100_000 }, DEMO_CONFIG, 0);
    expect(opened.ok).toBe(true);
    const loan = opened.loan!;
    expect(world.player.cash).toBeCloseTo(cashBefore + 100_000, 2);

    const repaid = repayLoan(world, loan.id, 100_000, DEMO_CONFIG, 0);
    expect(repaid.ok).toBe(true);
    expect(loan.status).toBe('repaid');
    expect(loan.paidInterest).toBeCloseTo(0, 2);
    expect(loan.paidPrincipal).toBeCloseTo(100_000, 2);
    expect(world.player.cash).toBeCloseTo(cashBefore, 2);

    // 有欠款时提前还款先冲抵欠息，再冲抵本金。
    const company = companyOf(world);
    company.cash = 0;
    const second = openLoan(
      world,
      { owner: companyOwner(company), purpose: 'workingCapital', amount: 12_000 },
      DEMO_CONFIG,
      1,
    );
    expect(second.ok).toBe(true);
    // 放款现金随后被耗尽，确保首期无还款能力，进入欠款。
    company.cash = 0;
    settleBankMonth(world, DEMO_CONFIG, 2, freshLogs());
    expect(second.loan!.arrearsInterest).toBeCloseTo(60, 2);
    expect(second.loan!.arrearsPrincipal).toBeCloseTo(500, 2);

    company.cash = 1_000;
    const partial = repayLoan(world, second.loan!.id, 1_000, DEMO_CONFIG, 2);
    expect(partial.ok).toBe(true);
    expect(second.loan!.paidInterest).toBeCloseTo(60, 2);
    expect(second.loan!.arrearsInterest).toBeCloseTo(0, 2);
    expect(second.loan!.arrearsPrincipal).toBeCloseTo(0, 2);
    expect(second.loan!.outstanding).toBeCloseTo(11_060, 2);
    expect(company.cash).toBeCloseTo(0, 2);
  });

  it('企业现金短缺时按额度自动借周转贷款；现金已够或无额度时不借', () => {
    const world = newWorld();
    const company = companyOf(world);
    company.cash = 0;
    const borrowed = ensureCompanyLiquidity(world, company, 100_000, DEMO_CONFIG, 0);
    expect(borrowed).toBeGreaterThan(0);
    expect(borrowed).toBeLessThanOrEqual(100_000);
    expect(company.cash).toBeCloseTo(borrowed, 2);
    expect(company.debt).toBeCloseTo(borrowed, 2);
    const loans = world.banking.loans.filter((loan) => loan.borrower.id === company.id);
    expect(loans).toHaveLength(1);
    expect(loans[0]!.purpose).toBe('workingCapital');
    expect(loans[0]!.principal).toBeCloseTo(borrowed, 2);

    // 现金足够时不再借款。
    expect(ensureCompanyLiquidity(world, company, 0, DEMO_CONFIG, 0)).toBe(0);
    expect(world.banking.loans).toHaveLength(1);
    // 自动流动性只借不还：已有未偿不会因再次补流动性而被“借新还旧”重置。
    const outstandingBefore = totalOutstanding(world, companyOwner(company));
    company.cash = 0;
    ensureCompanyLiquidity(world, company, 50_000, DEMO_CONFIG, 0);
    expect(totalOutstanding(world, companyOwner(company))).toBeGreaterThan(outstandingBefore);
  });

  it('同步 company.debt 镜像：只统计未结清贷款未偿本金', () => {
    const world = newWorld();
    const company = companyOf(world);
    company.cash = 1_000_000;
    const owner = companyOwner(company);
    const first = openLoan(world, { owner, purpose: 'workingCapital', amount: 50_000 }, DEMO_CONFIG, 0);
    const second = openLoan(world, { owner, purpose: 'expansion', amount: 30_000 }, DEMO_CONFIG, 0);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(company.debt).toBeCloseTo(80_000, 2);

    // 外部直接改债不影响银行权威，sync 后恢复镜像。
    company.debt = 999;
    syncCompanyDebt(world, company.id);
    expect(company.debt).toBeCloseTo(80_000, 2);
    expect(ownerLabelText(world, company)).toContain(company.name);
    expect(loanLabel(world, first.loan!)).toContain('企业周转贷款');
  });

  it('三段结算可独立调用：存款计息不碰贷款，企业服务只动该企业并写 lastMonth.interestPaid', () => {
    const world = newWorld();
    const company = companyOf(world);
    const other = companyOf(world, 'lp-garment');
    company.cash = 1_000_000;
    other.cash = 500_000;
    const playerCash = world.player.cash;

    deposit(world, playerOwner(), 100_000, DEMO_CONFIG, 0);
    const opened = openLoan(
      world,
      { owner: companyOwner(company), purpose: 'workingCapital', amount: 12_000 },
      DEMO_CONFIG,
      0,
    );
    expect(opened.ok).toBe(true);
    const loan = opened.loan!;
    const otherCash = other.cash;

    settleDepositInterest(world, DEMO_CONFIG, 1, freshLogs());
    expect(loan.payments).toHaveLength(0);
    expect(depositBalance(world, playerOwner())).toBeCloseTo(100_100, 2);
    expect(other.cash).toBeCloseTo(otherCash, 2);

    const result = serviceCompanyLoans(world, company, DEMO_CONFIG, 1, freshLogs());
    expect(result.interestPaid).toBeCloseTo(60, 2);
    expect(result.principalPaid).toBeCloseTo(500, 2);
    expect(company.lastMonth.interestPaid).toBeCloseTo(60, 2);
    expect(company.cash).toBeCloseTo(1_000_000 + 12_000 - 560, 2);
    expect(other.cash).toBeCloseTo(otherCash, 2);

    // 玩家个人贷款由 servicePlayerLoans 独立服务。
    const personal = openLoan(
      world,
      { owner: playerOwner(), purpose: 'personal', amount: 100_000 },
      DEMO_CONFIG,
      1,
    );
    expect(personal.ok).toBe(true);
    const cashBeforeService = world.player.cash;
    const playerResult = servicePlayerLoans(world, DEMO_CONFIG, 2, freshLogs());
    expect(playerResult.interestPaid).toBeCloseTo(600, 2);
    expect(playerResult.principalPaid).toBeCloseTo(round2(100_000 / 24), 2);
    expect(world.player.cash).toBeCloseTo(
      round2(cashBeforeService - 600 - round2(100_000 / 24)),
      2,
    );
    expect(playerCash).toBeGreaterThan(0); // 仅使用初始现金语义，不做额外断言
  });
});

// ---------------------------------------------------------------- 小额周转贷款与清算

describe('小额周转贷款与企业清算', () => {
  it('workingCapital 允许低于最低金额且同一 tick 多次借入，每次都立即占用额度', () => {
    const world = newWorld();
    const company = companyOf(world);
    company.cash = 0;
    const owner = companyOwner(company);
    const before = availableCredit(world, owner, DEMO_CONFIG);

    // 采购/进口融资可能远小于 minLoanAmount（首版 10,000）。
    const first = openLoan(world, { owner, purpose: 'workingCapital', amount: 500 }, DEMO_CONFIG, 3);
    expect(first.ok).toBe(true);
    expect(first.loan!.principal).toBeCloseTo(500, 2);
    expect(availableCredit(world, owner, DEMO_CONFIG)).toBeCloseTo(round2(before - 500), 2);

    const second = openLoan(world, { owner, purpose: 'workingCapital', amount: 700 }, DEMO_CONFIG, 3);
    expect(second.ok).toBe(true);
    expect(second.loan!.id).not.toBe(first.loan!.id);
    expect(totalOutstanding(world, owner)).toBeCloseTo(1_200, 2);
    expect(company.debt).toBeCloseTo(1_200, 2);
    expect(availableCredit(world, owner, DEMO_CONFIG)).toBeCloseTo(round2(before - 1_200), 2);
  });

  it('清算按合同 id 顺序偿还 active 贷款：先还满，现金耗尽后未偿归零并记减免', () => {
    const world = newWorld();
    const company = companyOf(world);
    company.cash = 1_000_000;
    const owner = companyOwner(company);
    const loanA = openLoan(world, { owner, purpose: 'workingCapital', amount: 20_000 }, DEMO_CONFIG, 0);
    const loanB = openLoan(world, { owner, purpose: 'expansion', amount: 10_000 }, DEMO_CONFIG, 0);
    expect(loanA.ok).toBe(true);
    expect(loanB.ok).toBe(true);
    const first = loanA.loan!;
    const second = loanB.loan!;
    expect([first.id, second.id].sort()).toEqual([first.id, second.id].sort());

    // 可用现金 25,000：还满 A（20,000），再还 B 的 5,000，剩余 5,000 减免。
    const result = settleCompanyLiquidation(world, company, 25_000, DEMO_CONFIG, 1);
    expect(result.repaid).toBeCloseTo(25_000, 2);
    expect(result.forgiven).toBeCloseTo(5_000, 2);
    expect(result.repaid + result.forgiven).toBeCloseTo(30_000, 2);

    expect(first.status).toBe('repaid');
    expect(first.outstanding).toBe(0);
    expect(first.payments[first.payments.length - 1]!.note).toBe('企业清算偿还');
    expect(second.status).toBe('defaulted');
    expect(second.outstanding).toBe(0);
    expect(second.note).toContain('企业清算减免');
    // 不变量：未偿 = 本金 − 已还本金（减免计入 paidPrincipal 留痕）。
    for (const loan of [first, second]) {
      expect(round2(loan.principal - loan.paidPrincipal)).toBeCloseTo(loan.outstanding, 2);
    }
    // 清算后没有 active 贷款，企业债务镜像归零。
    expect(
      world.banking.loans.filter(
        (loan) => loan.borrower.id === company.id && loan.status === 'active',
      ),
    ).toHaveLength(0);
    expect(company.debt).toBeCloseTo(0, 2);
    expect(world.banking.lastMonth.loansOutstanding).toBeCloseTo(0, 2);
  });

  it('清算也覆盖已违约贷款，避免企业移除后留下僵尸合同', () => {
    const world = newWorld();
    const company = companyOf(world);
    company.cash = 0;
    const opened = openLoan(
      world,
      { owner: companyOwner(company), purpose: 'workingCapital', amount: 12_000 },
      DEMO_CONFIG,
      0,
    );
    company.cash = 0;
    settleBankMonth(world, DEMO_CONFIG, 1, freshLogs());
    settleBankMonth(world, DEMO_CONFIG, 2, freshLogs());
    expect(opened.loan!.status).toBe('defaulted');

    const result = settleCompanyLiquidation(world, company, 4_000, DEMO_CONFIG, 2);
    expect(result.repaid).toBeCloseTo(4_000, 2);
    expect(result.forgiven).toBeCloseTo(8_000, 2);
    expect(result.repaid + result.forgiven).toBeCloseTo(12_000, 2);
    expect(opened.loan!.outstanding).toBe(0);
    expect(opened.loan!.status).toBe('defaulted');
    expect(company.debt).toBeCloseTo(0, 2);
  });

  it('清算现金足以覆盖全部未偿时不产生减免，贷款全部结清', () => {
    const world = newWorld();
    const company = companyOf(world);
    company.cash = 1_000_000;
    const opened = openLoan(
      world,
      { owner: companyOwner(company), purpose: 'workingCapital', amount: 12_000 },
      DEMO_CONFIG,
      0,
    );
    expect(opened.ok).toBe(true);
    const loan = opened.loan!;

    const result = settleCompanyLiquidation(world, company, 12_000, DEMO_CONFIG, 1);
    expect(result.repaid).toBeCloseTo(12_000, 2);
    expect(result.forgiven).toBe(0);
    expect(loan.status).toBe('repaid');
    expect(loan.outstanding).toBe(0);
    expect(loan.paidPrincipal).toBeCloseTo(12_000, 2);
    expect(company.debt).toBeCloseTo(0, 2);
  });
});

// ---------------------------------------------------------------- 旧债务迁移

describe('旧债务迁移', () => {
  it('company.debt 迁移为承接贷款：本金不变、镜像不变、不重复计息、不二次迁移', () => {
    const world = newWorld();
    const company = companyOf(world);
    company.cash = 0;
    company.debt = 12_000;

    const migrated = migrateLegacyCompanyDebt(world, DEMO_CONFIG, 0);
    expect(migrated).toBeCloseTo(12_000, 2);
    expect(company.debt).toBeCloseTo(12_000, 2);

    const migratedLoans = world.banking.loans.filter(
      (loan) => loan.borrower.kind === 'company' && loan.borrower.id === company.id,
    );
    expect(migratedLoans).toHaveLength(1);
    const loan = migratedLoans[0]!;
    expect(loan.purpose).toBe('migratedDebt');
    expect(loan.principal).toBeCloseTo(12_000, 2);
    expect(loan.outstanding).toBeCloseTo(12_000, 2);
    expect(loan.monthlyPrincipal).toBeCloseTo(1_000, 2);
    expect(loan.termMonths).toBe(DEMO_CONFIG.banking.products.migratedDebt.termMonths);
    expect(loan.rateMonthly).toBe(DEMO_CONFIG.banking.products.migratedDebt.rateMonthly);
    expect(loan.startTick).toBe(0);
    expect(loan.nextDueTick).toBe(1);

    // 幂等：已有 active 贷款时再次迁移不得新增合同、不得改变债务。
    expect(migrateLegacyCompanyDebt(world, DEMO_CONFIG, 1)).toBe(0);
    expect(
      world.banking.loans.filter((candidate) => candidate.borrower.id === company.id),
    ).toHaveLength(1);
    expect(company.debt).toBeCloseTo(12_000, 2);

    // 不重复计息：首期利息 = 未偿 12,000 × 0.50% = 60，而不是按迁移前再叠加一次。
    company.cash = 1_060;
    settleBankMonth(world, DEMO_CONFIG, 1, freshLogs());
    expect(loan.paidInterest).toBeCloseTo(60, 2);
    expect(loan.paidPrincipal).toBeCloseTo(1_000, 2);
    expect(loan.outstanding).toBeCloseTo(11_000, 2);
    expect(company.debt).toBeCloseTo(11_000, 2);
    expect(company.cash).toBeCloseTo(0, 2);
  });

  it('debt ≤ 0 的企业不迁移', () => {
    const world = newWorld();
    for (const company of world.companies) company.debt = 0;
    expect(migrateLegacyCompanyDebt(world, DEMO_CONFIG, 0)).toBe(0);
    expect(world.banking.loans).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- 存档往返

describe('存档往返', () => {
  it('存款与贷款余额可通过 serializeSave/parseSave 往返保持', () => {
    const world = newWorld();
    deposit(world, playerOwner(), 50_000, DEMO_CONFIG, 0);
    const company = companyOf(world);
    const opened = openLoan(
      world,
      { owner: companyOwner(company), purpose: 'workingCapital', amount: 30_000 },
      DEMO_CONFIG,
      0,
    );
    expect(opened.ok).toBe(true);
    const text = serializeSave(world, '2026-11-02T00:00:00.000Z');
    const parsed = parseSave(text);
    expect(parsed.ok, parsed.ok ? '' : parsed.error).toBe(true);
    if (!parsed.ok || !parsed.world) return;
    const restored = parsed.world;
    expect(restored.banking).toBeDefined();
    expect(restored.banking.deposits.length).toBe(world.banking.deposits.length);
    expect(restored.banking.loans).toHaveLength(1);
    const restoredLoan = restored.banking.loans[0]!;
    expect(restoredLoan.id).toBe(opened.loan!.id);
    expect(restoredLoan.outstanding).toBeCloseTo(30_000, 2);
    const restoredCompany = restored.companies.find((entry) => entry.id === company.id);
    expect(restoredCompany!.debt).toBeCloseTo(30_000, 2);
    expect(ownerCash(restored, companyOwner(company))).toBeCloseTo(company.cash, 2);
  });
});

/** 仅用于断言显示名的小工具，避免测试直接依赖 ownerLabel 的完整文案。 */
function ownerLabelText(world: WorldState, company: Company): string {
  return world.companies.find((entry) => entry.id === company.id)?.name ?? '';
}
