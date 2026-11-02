// 独立银行系统：存款账户、贷款发放/偿还、企业债务镜像、旧债务迁移。
//
// 定位（用户已确定）：银行资金无限、不会倒闭；不实现流动性不足、资本限制、挤兑、存款损失。
// 但“银行资金无限”不等于“借款人额度无限”，也不等于“不用还债”，更不自动借新还旧：
// - 个人额度由可核验净资产决定，企业额度由非负账面股权价值决定；
// - 同一主体全部银行贷款共享额度：可借 = max(0, 基准 × creditLimitRate − 当前未偿本金)；
// - 本金与利息都必须按合同偿还，逾期进入欠款并可能标记违约。
//
// 数据权威：存款余额与贷款合同只写在 world.banking；company.debt 只是该企业未偿本金的派生镜像。

import type {
  ActionResult,
  BankOwner,
  BankingState,
  Company,
  DepositAccount,
  LoanContract,
  LoanPurpose,
  LogEntry,
  WorldState,
} from '../contracts/types';
import type { DemoConfig } from '../../data/config';
import type { LoanOpenResult, LoanRequest } from './types';
import { round2 } from '../core/math';
import {
  availableCredit,
  creditEvaluation,
  creditOwnerCash,
  debitOwnerCash,
  ownerCash,
  ownerLabel,
  ownerOutstanding,
  sameOwner,
} from './credit';

/** 贷款用途的中文标签（仅展示文案，不承载数值参数）。 */
const LOAN_PURPOSE_LABELS: Record<LoanPurpose, string> = {
  workingCapital: '企业周转贷款',
  expansion: '企业扩张贷款',
  personal: '玩家个人贷款',
  migratedDebt: '旧债务承接',
  // v0.7：政府与居民债务的展示标签（账本在 government / householdFinance，银行台账只读展示）。
  government: '政府借款',
  bondAdvance: '债券垫付转借款',
  householdConsumption: '居民消费贷款',
};

/** 银行初始状态：空账户、空合同、空快照；资金无限，因此没有“银行资本”字段。 */
export function createInitialBanking(config: DemoConfig): BankingState {
  const depositRate = config.banking.depositRateMonthly;
  return {
    deposits: [],
    loans: [],
    snapshots: [],
    lastMonth: {
      tick: 0,
      interestExpense: 0,
      interestIncome: 0,
      principalIssued: 0,
      principalRepaid: 0,
      depositsTotal: 0,
      loansOutstanding: 0,
      newDefaults: 0,
      note: `银行初始状态：存款月息 ${(depositRate * 100).toFixed(2)}%；资金无限、不会倒闭（演示定位）。`,
    },
    nextAccountNumber: 1,
    nextLoanNumber: 1,
  };
}

/** 防御式取银行状态：核心接线尚未完成时（世界缺少 banking 字段）也能安全初始化。 */
function ensureBankingState(world: WorldState, config: DemoConfig): BankingState {
  if (!world.banking) world.banking = createInitialBanking(config);
  return world.banking;
}

/** 主体是否真实存在于世界中（用于拒绝给不存在的主体放款/记账）。 */
function ownerExists(world: WorldState, owner: BankOwner): boolean {
  switch (owner.kind) {
    case 'player':
      return true;
    case 'company':
      return world.companies.some((company) => company.id === owner.id);
    case 'investorGroup':
      return world.investors.some((group) => group.id === owner.id);
    case 'household':
      return world.households?.groups.some((group) => group.id === owner.id) ?? false;
    case 'government':
      // v0.7：政府主体的 id 即 cityId，只有真实存在的城市政府才算存在。
      return world.cities.some((city) => city.id === owner.id);
  }
}

/** 幂等创建活期存款账户；id 形如 dep-1。 */
export function ensureDepositAccount(
  world: WorldState,
  owner: BankOwner,
  config: DemoConfig,
  tick: number,
): DepositAccount {
  const banking = ensureBankingState(world, config);
  const existing = banking.deposits.find((account) => sameOwner(account.owner, owner));
  if (existing) return existing;
  const account: DepositAccount = {
    id: `dep-${banking.nextAccountNumber}`,
    owner: { kind: owner.kind, id: owner.kind === 'player' ? 'player' : owner.id },
    balance: 0,
    rateMonthly: config.banking.depositRateMonthly,
    accruedInterest: 0,
    lastInterestTick: tick,
    openedTick: tick,
    note: '活期存款账户；银行资金无限、不会倒闭，存款不计风险。',
  };
  banking.nextAccountNumber += 1;
  banking.deposits.push(account);
  banking.deposits.sort((a, b) => a.id.localeCompare(b.id));
  refreshBankingTotals(world);
  return account;
}

/** 查找主体的存款账户；不存在时 undefined（本函数不创建账户）。 */
export function depositAccountFor(world: WorldState, owner: BankOwner): DepositAccount | undefined {
  return (world.banking?.deposits ?? []).find((account) => sameOwner(account.owner, owner));
}

/** 存款：主体现金 → 银行存款。先校验后提交，避免部分扣款。 */
export function deposit(
  world: WorldState,
  owner: BankOwner,
  amount: number,
  config: DemoConfig,
  tick: number,
): ActionResult {
  const value = round2(amount);
  if (!Number.isFinite(amount) || value <= 0) return { ok: false, error: '存款金额必须大于 0' };
  if (!ownerExists(world, owner)) return { ok: false, error: '存款主体不存在' };
  if (!debitOwnerCash(world, owner, value)) {
    return { ok: false, error: '手头现金不足，无法存款' };
  }
  const account = ensureDepositAccount(world, owner, config, tick);
  account.balance = round2(account.balance + value);
  refreshBankingTotals(world);
  return {
    ok: true,
    amount: value,
    note: `${ownerLabel(world, owner)} 存入 ${value.toFixed(2)} 信用点（账户 ${account.id}）。`,
  };
}

/** 取款：银行存款 → 主体现金；余额不足时不部分扣款。 */
export function withdraw(
  world: WorldState,
  owner: BankOwner,
  amount: number,
  config: DemoConfig,
  tick: number,
): ActionResult {
  const value = round2(amount);
  if (!Number.isFinite(amount) || value <= 0) return { ok: false, error: '取款金额必须大于 0' };
  const account = depositAccountFor(world, owner);
  if (!account) return { ok: false, error: '该主体没有银行存款账户' };
  if (account.balance + 0.001 < value) {
    return { ok: false, error: `存款余额不足（余额 ${account.balance.toFixed(2)}）` };
  }
  account.balance = round2(account.balance - value);
  creditOwnerCash(world, owner, value);
  refreshBankingTotals(world);
  return {
    ok: true,
    amount: value,
    note: `${ownerLabel(world, owner)} 从账户 ${account.id} 取出 ${value.toFixed(2)} 信用点。`,
  };
}

/**
 * 放款核心：先校验用途/额度，再一次性提交（创建合同 + 记入借款人现金 + 同步企业债务镜像）。
 * enforceMinimum 仅供企业流动性兜底使用：自动补流动性时不套用“单笔最低金额”，
 * 否则小额短缺（低于 minLoanAmount）会无法补足而触发工资拖欠。
 */
function issueLoan(
  world: WorldState,
  request: LoanRequest,
  config: DemoConfig,
  tick: number,
  enforceMinimum: boolean,
): LoanOpenResult {
  const banking = ensureBankingState(world, config);
  const owner = request.owner;
  const amount = round2(request.amount);
  if (!Number.isFinite(request.amount) || amount <= 0) {
    return { ok: false, error: '贷款金额必须大于 0' };
  }
  if (!ownerExists(world, owner)) return { ok: false, error: '借款主体不存在' };

  const purpose = request.purpose;
  if (purpose === 'personal' && owner.kind !== 'player') {
    return { ok: false, error: '个人贷款只能由玩家申请' };
  }
  if ((purpose === 'workingCapital' || purpose === 'expansion') && owner.kind !== 'company') {
    return { ok: false, error: '企业贷款只能由企业申请' };
  }
  if (purpose === 'migratedDebt') {
    return { ok: false, error: '旧债务承接贷款只能由 migrateLegacyCompanyDebt 创建' };
  }
  // 最低金额只约束人工大额产品（个人贷款/企业扩张）；
  // 周转贷款用于采购与进口融资，可能远小于 minLoanAmount 且同一 tick 需要多次借入。
  if (enforceMinimum && purpose !== 'workingCapital' && amount < config.banking.minLoanAmount) {
    return {
      ok: false,
      error: `单笔贷款金额不能低于 ${config.banking.minLoanAmount.toFixed(0)} 信用点`,
    };
  }

  const product = config.banking.products[purpose];
  const evaluation = creditEvaluation(world, owner, config);
  if (amount > evaluation.available + 0.005) {
    return {
      ok: false,
      error: `超出可借额度：可借 ${evaluation.available.toFixed(2)}，申请 ${amount.toFixed(2)}`,
    };
  }

  const termMonths = product.termMonths;
  const loan: LoanContract = {
    id: `loan-${banking.nextLoanNumber}`,
    borrower: { kind: owner.kind, id: owner.kind === 'player' ? 'player' : owner.id },
    purpose,
    principal: amount,
    outstanding: amount,
    monthlyPrincipal: round2(amount / termMonths),
    rateMonthly: product.rateMonthly,
    termMonths,
    startTick: tick,
    // 首期从放款后的下一月开始：本月放款不计本月利息。
    nextDueTick: tick + 1,
    paidPrincipal: 0,
    paidInterest: 0,
    accruedInterest: 0,
    arrearsPrincipal: 0,
    arrearsInterest: 0,
    missedPayments: 0,
    status: 'active',
    payments: [],
    note: `${product.label}：等额本金 ${termMonths} 期，月利率 ${(product.rateMonthly * 100).toFixed(2)}%，首期从下一月开始。`,
  };
  banking.nextLoanNumber += 1;
  banking.loans.push(loan);
  banking.loans.sort((a, b) => a.id.localeCompare(b.id));
  creditOwnerCash(world, owner, amount);
  banking.lastMonth.principalIssued = round2(banking.lastMonth.principalIssued + amount);
  if (owner.kind === 'company') syncCompanyDebt(world, owner.id);
  refreshBankingTotals(world);
  return {
    ok: true,
    amount,
    loan,
    note: `${ownerLabel(world, owner)} 获得 ${loanLabel(world, loan)}，本金 ${amount.toFixed(2)} 信用点。`,
  };
}

/** 申请贷款（玩家命令/经营提案入口）。 */
export function openLoan(
  world: WorldState,
  request: LoanRequest,
  config: DemoConfig,
  tick: number,
): LoanOpenResult {
  return issueLoan(world, request, config, tick, true);
}

/**
 * 提前还款（不收费用）：先付到期利息欠款，再还本金；已还本金优先冲抵逾期本金。
 * 还款金额不得超过当前应还总额（未偿本金 + 欠息），避免多付无法入账。
 */
export function repayLoan(
  world: WorldState,
  loanId: string,
  amount: number,
  config: DemoConfig,
  tick: number,
): ActionResult {
  const banking = ensureBankingState(world, config);
  const loan = banking.loans.find((entry) => entry.id === loanId);
  if (!loan) return { ok: false, error: '贷款合同不存在' };
  if (loan.status === 'repaid') return { ok: false, error: '该贷款已结清' };
  const value = round2(amount);
  if (!Number.isFinite(amount) || value <= 0) return { ok: false, error: '还款金额必须大于 0' };

  const owedInterest = round2(loan.arrearsInterest + loan.accruedInterest);
  const owed = round2(owedInterest + loan.outstanding);
  if (value > owed + 0.005) {
    return { ok: false, error: `还款金额超过应还总额 ${owed.toFixed(2)} 信用点` };
  }
  if (!debitOwnerCash(world, loan.borrower, value)) {
    return { ok: false, error: `${ownerLabel(world, loan.borrower)} 现金不足，无法还款` };
  }

  const interestPaid = round2(Math.min(value, owedInterest));
  const principalPaid = round2(Math.min(round2(value - interestPaid), loan.outstanding));
  loan.arrearsInterest = round2(Math.max(0, owedInterest - interestPaid));
  loan.accruedInterest = 0;
  loan.outstanding = round2(Math.max(0, loan.outstanding - principalPaid));
  // 逾期本金是未偿本金的子集：还款先冲抵最早的逾期本金，再冲抵正常本金。
  loan.arrearsPrincipal = round2(
    Math.max(0, Math.min(loan.arrearsPrincipal - principalPaid, loan.outstanding)),
  );
  loan.paidPrincipal = round2(loan.paidPrincipal + principalPaid);
  loan.paidInterest = round2(loan.paidInterest + interestPaid);

  if (
    loan.outstanding <= 0.005 &&
    loan.arrearsInterest <= 0.005 &&
    loan.arrearsPrincipal <= 0.005
  ) {
    loan.outstanding = 0;
    loan.arrearsInterest = 0;
    loan.arrearsPrincipal = 0;
    loan.status = 'repaid';
  }

  banking.lastMonth.principalRepaid = round2(banking.lastMonth.principalRepaid + principalPaid);
  banking.lastMonth.interestIncome = round2(banking.lastMonth.interestIncome + interestPaid);
  if (loan.borrower.kind === 'company') syncCompanyDebt(world, loan.borrower.id);
  refreshBankingTotals(world);
  return {
    ok: true,
    amount: value,
    note: `${ownerLabel(world, loan.borrower)} 提前偿还 ${loanLabel(world, loan)} ${value.toFixed(2)} 信用点（利息 ${interestPaid.toFixed(2)}、本金 ${principalPaid.toFixed(2)}），未收提前还款费。`,
  };
}

/** 该主体当前全部未偿贷款本金。 */
export function totalOutstanding(world: WorldState, owner: BankOwner): number {
  return ownerOutstanding(world, owner);
}

/** 把企业债务镜像同步为该公司全部未结清贷款未偿本金合计（唯一写入方是银行）。 */
export function syncCompanyDebt(world: WorldState, companyId: string): void {
  const company = world.companies.find((entry) => entry.id === companyId);
  if (!company) return;
  let total = 0;
  for (const loan of world.banking?.loans ?? []) {
    if (loan.status === 'repaid') continue;
    if (loan.borrower.kind !== 'company' || loan.borrower.id !== companyId) continue;
    total += loan.outstanding;
  }
  company.debt = round2(total);
}

/**
 * 自动流动性融资（采购/进口/发薪补足）：**每笔借款生成独立合同（独立批次）**。
 *
 * 为什么不再并入旧合同（验收问题 3）：
 * 旧实现把新借款并入同企业的 active 周转贷款，并重算 monthlyPrincipal，导致旧合同
 * 最后一期会把新借款的本金一并作为“末期本金”要求偿还（第 23 期追加 2400，第 24 期
 * 被要求还 2500），违背“新贷款从下个月开始、按约定期限分期”的规则。
 * 现在每笔借款拥有自己的 startTick / nextDueTick / termMonths / principal，
 * 不会因旧合同到期而提前收取新借款本金。
 *
 * 口径不变：仍受同一授信额度限制（availableCredit 已扣除全部未结清合同）、
 * 借款立即占用额度、还款释放额度；利息按各合同未偿本金分别计算，不重复计息。
 * 返回实际借入金额。
 */
export function drawWorkingCapital(
  world: WorldState,
  company: Company,
  amount: number,
  config: DemoConfig,
  tick: number,
): number {
  const value = round2(amount);
  if (!(value > 0)) return 0;
  const owner: BankOwner = { kind: 'company', id: company.id };
  const available = availableCredit(world, owner, config);
  const draw = round2(Math.min(value, available));
  if (draw <= 0) return 0;

  const result = issueLoan(
    world,
    { owner, purpose: 'workingCapital', amount: draw },
    config,
    tick,
    false,
  );
  if (!result.ok || !result.loan) return 0;
  // 标注自动融资批次，便于界面与报告区分“玩家主动借款”与“系统补流动性”。
  result.loan.note = `自动流动性批次（第 ${tick} 期）：${result.loan.note}`;
  return round2(result.loan.principal);
}

/**
 * 企业现金不足时按授信额度自动借周转贷款（替代旧 companies/credit.ensureLiquidity）。
 * 返回实际借入金额；现金已足够、无额度或借款失败时返回 0。
 * 这是“补流动性”而不是“借新还旧”：借款立即进入企业现金，且计入未偿与 company.debt。
 */
export function ensureCompanyLiquidity(
  world: WorldState,
  company: Company,
  targetCash: number,
  config: DemoConfig,
  tick: number,
): number {
  if (!Number.isFinite(targetCash)) return 0;
  if (company.cash >= targetCash) return 0;
  const needed = round2(targetCash - company.cash);
  if (needed <= 0) return 0;
  const owner: BankOwner = { kind: 'company', id: company.id };
  const available = availableCredit(world, owner, config);
  const amount = round2(Math.min(needed, available));
  if (amount <= 0) return 0;
  return drawWorkingCapital(world, company, amount, config, tick);
}

/**
 * 旧存档迁移：把每个 `company.debt > 0` 的企业债务转为有对手方、有还款计划的承接贷款。
 *
 * 约束（用户已确定）：
 * - principal = outstanding = 原 debt（round2），term/rate 取 config.banking.products.migratedDebt；
 * - startTick = tick，nextDueTick = tick + 1，monthlyPrincipal = round2(debt / termMonths)；
 * - 不向企业注入现金（债务原本就已在企业资产负债表里），不清零 debt，不重复计息；
 * - 若该企业已有 active 贷款则跳过（幂等，不会二次迁移）。
 * 返回迁移总额；`company.debt` 迁移后必须仍等于新合同未偿（镜像不变）。
 */
export function migrateLegacyCompanyDebt(
  world: WorldState,
  config: DemoConfig,
  tick: number,
): number {
  const banking = ensureBankingState(world, config);
  const product = config.banking.products.migratedDebt;
  let migratedTotal = 0;
  for (const company of [...world.companies].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!(company.debt > 0)) continue;
    const hasActiveLoan = banking.loans.some(
      (loan) =>
        loan.status !== 'repaid' &&
        loan.borrower.kind === 'company' &&
        loan.borrower.id === company.id,
    );
    if (hasActiveLoan) continue;
    const principal = round2(company.debt);
    if (principal <= 0) continue;
    const termMonths = product.termMonths;
    const loan: LoanContract = {
      id: `loan-${banking.nextLoanNumber}`,
      borrower: { kind: 'company', id: company.id },
      purpose: 'migratedDebt',
      principal,
      outstanding: principal,
      monthlyPrincipal: round2(principal / termMonths),
      rateMonthly: product.rateMonthly,
      termMonths,
      startTick: tick,
      nextDueTick: tick + 1,
      paidPrincipal: 0,
      paidInterest: 0,
      accruedInterest: 0,
      arrearsPrincipal: 0,
      arrearsInterest: 0,
      missedPayments: 0,
      status: 'active',
      payments: [],
      note: `由旧 company.debt 迁移：本金 = 原债务 ${principal.toFixed(2)}，${termMonths} 期等额本金承接，月利率 ${(product.rateMonthly * 100).toFixed(2)}%；不注入新资金、不重复计息。`,
    };
    banking.nextLoanNumber += 1;
    banking.loans.push(loan);
    // 镜像不变：迁移只把“无对手方债务”换成“银行合同”，企业债务总额不得清零或翻倍。
    company.debt = round2(principal);
    migratedTotal = round2(migratedTotal + principal);
  }
  banking.loans.sort((a, b) => a.id.localeCompare(b.id));
  refreshBankingTotals(world);
  return migratedTotal;
}

/**
 * 企业倒闭清算：用清算可用现金按合同 id 顺序偿还该企业**未结清**（active + defaulted）
 * 贷款的未偿本金。包含 defaulted 是为了不让企业移除后留下无人服务、无法追偿的僵尸合同。
 *
 * 权威约束：生命周期模块不得自己改贷款合同，必须调用本函数；银行是贷款合同的唯一写入方。
 * - 每笔偿还：outstanding 减少、paidPrincipal 增加，并追加一条 note='企业清算偿还' 的 payment；
 * - 现金耗尽后仍有未偿的合同：outstanding 归零、status='defaulted'，差额计入 forgiven
 *   （企业随后被移除，无债权人追偿；不加罚息）；
 * - 为了让不变量 `outstanding == principal − paidPrincipal` 继续成立，
 *   减免本金同步计入 paidPrincipal 留痕（note 与 payment 文案会说明是清算减免而非实收）；
 * - 最后同步 company.debt 镜像（企业移除后该对象即被丢弃）并刷新银行存量统计。
 */
export function settleCompanyLiquidation(
  world: WorldState,
  company: Company,
  cashAvailable: number,
  config: DemoConfig,
  tick: number,
): { repaid: number; forgiven: number } {
  const banking = ensureBankingState(world, config);
  let remainingCash = round2(Math.max(0, cashAvailable));
  let repaid = 0;
  let forgiven = 0;
  const loans = banking.loans
    .filter(
      (loan) =>
        loan.status !== 'repaid' &&
        loan.borrower.kind === 'company' &&
        loan.borrower.id === company.id,
    )
    .sort((a, b) => a.id.localeCompare(b.id));
  const maxPayments = Math.max(1, Math.round(config.banking.maxLoanPaymentsPerLoan));

  for (const loan of loans) {
    if (loan.outstanding <= 0.005) {
      loan.outstanding = 0;
      loan.status = 'repaid';
      continue;
    }
    const payment = round2(Math.min(remainingCash, loan.outstanding));
    if (payment > 0) {
      remainingCash = round2(remainingCash - payment);
      loan.outstanding = round2(loan.outstanding - payment);
      loan.paidPrincipal = round2(loan.paidPrincipal + payment);
      repaid = round2(repaid + payment);
      loan.payments.push({
        tick,
        principalDue: 0,
        interestDue: 0,
        principalPaid: payment,
        interestPaid: 0,
        arrears: 0,
        note: '企业清算偿还',
      });
      if (loan.payments.length > maxPayments) {
        loan.payments.splice(0, loan.payments.length - maxPayments);
      }
    }
    if (loan.outstanding > 0.005) {
      const writtenOff = round2(loan.outstanding);
      forgiven = round2(forgiven + writtenOff);
      loan.note = `${loan.note}；企业清算减免 ${writtenOff.toFixed(2)}（无债权人追偿，不加罚息）。`;
      // 减免额计入 paidPrincipal 是为了维持“未偿 = 本金 − 已还本金”的银行不变量；
      // 企业清算记录会把同一金额记为 debtForgiven，不会与 debtRepaid 重复。
      loan.paidPrincipal = round2(loan.paidPrincipal + writtenOff);
      loan.outstanding = 0;
      loan.arrearsPrincipal = 0;
      loan.arrearsInterest = 0;
      loan.accruedInterest = 0;
      loan.status = 'defaulted';
    } else {
      loan.outstanding = 0;
      loan.arrearsPrincipal = 0;
      loan.arrearsInterest = 0;
      loan.accruedInterest = 0;
      loan.status = 'repaid';
    }
  }

  // 企业随后会被移除：镜像在此归零/归位，避免旧债务残留在企业对象上。
  syncCompanyDebt(world, company.id);
  refreshBankingTotals(world);
  return { repaid, forgiven };
}

/** 贷款显示名：用途 + 合同号 + 借款人。 */
export function loanLabel(world: WorldState, loan: LoanContract): string {
  return `${LOAN_PURPOSE_LABELS[loan.purpose]} ${loan.id}（${ownerLabel(world, loan.borrower)}）`;
}

/** 供 UI/日志读取主体现金（与 ownerCash 同口径的薄封装，便于银行模块对外只暴露一个入口）。 */
export function borrowerCash(world: WorldState, owner: BankOwner): number {
  return ownerCash(world, owner);
}

// ---------------------------------------------------------------- 月度贷款服务（步骤 18）

/**
 * 贷款月度服务结果。
 * interestPaid 会写入 company.lastMonth.interestPaid 供 finance.ts 计算利润；
 * 两者同时累加进 banking.lastMonth 的 interestIncome / principalRepaid（按发生额，月度清零由核心结算负责）。
 */
export interface LoanServiceResult {
  interestPaid: number;
  principalPaid: number;
}

const zeroServiceResult = (): LoanServiceResult => ({ interestPaid: 0, principalPaid: 0 });

/** 脚本化金额：负零归一，统一保留两位小数。 */
function money(value: number): number {
  const rounded = round2(value);
  return rounded === 0 ? 0 : rounded;
}

/** 计入本月的违约次数（月度统计）；由 serviceLoan 在状态迁移时调用。 */
function bankingNewDefaults(world: WorldState): void {
  if (!world.banking) return;
  world.banking.lastMonth.newDefaults += 1;
}

/** 刷新银行统计中的存量指标（存款总额、未偿贷款总额）。核心结算在月末也可再调用一次。 */
export function refreshBankingTotals(world: WorldState): void {
  const banking = world.banking;
  if (!banking) return;
  banking.lastMonth.depositsTotal = money(
    banking.deposits.reduce((total, account) => total + account.balance, 0),
  );
  banking.lastMonth.loansOutstanding = money(
    banking.loans
      .filter((loan) => loan.status !== 'repaid')
      .reduce((total, loan) => total + loan.outstanding, 0),
  );
}

/**
 * 单笔贷款的月度服务：计息 → 先息后本扣款 → 记录 payment → 更新未偿/欠款/逾期/违约。
 *
 * 会计口径（用户已确定）：
 * - outstanding = 剩余未偿本金，只按**实付本金**减少（outstanding -= principalPaid）；
 * - arrearsPrincipal = 其中已到期未付的逾期本金（outstanding 的子集，不重复计息）；
 * - arrearsInterest = 已到期未付的利息（不罚息、不计复利）；
 * - accruedInterest 首版保持 0：利息在到期日一次性计收，未付部分记入 arrearsInterest。
 */
function serviceLoan(
  world: WorldState,
  loan: LoanContract,
  config: DemoConfig,
  tick: number,
  logs: LogEntry[],
): LoanServiceResult {
  const result = zeroServiceResult();

  // 按结算前剩余本金计当月利息（本月放款不计本月，nextDueTick 保证首期在下一月）。
  const interestDue = money(loan.outstanding * loan.rateMonthly);
  const periodNumber = loan.nextDueTick - loan.startTick;
  const isFinalPeriod = periodNumber >= loan.termMonths;
  const scheduledPrincipal = isFinalPeriod
    ? money(loan.outstanding)
    : money(Math.min(loan.monthlyPrincipal, loan.outstanding));

  // 先息后本：本期利息 + 历史欠息一起收；付完利息再收本金（含逾期本金）。
  const owedInterest = money(loan.arrearsInterest + interestDue);
  const cash = ownerCash(world, loan.borrower);
  const interestPaid = money(Math.min(cash, owedInterest));
  if (interestPaid > 0) debitOwnerCash(world, loan.borrower, interestPaid);
  const cashAfterInterest = money(cash - interestPaid);

  const collectiblePrincipal = money(
    Math.min(loan.outstanding, loan.arrearsPrincipal + scheduledPrincipal),
  );
  const principalPaid = money(Math.min(cashAfterInterest, collectiblePrincipal));
  if (principalPaid > 0) debitOwnerCash(world, loan.borrower, principalPaid);

  const newArrearsInterest = money(Math.max(0, owedInterest - interestPaid));
  const remainingOutstanding = money(Math.max(0, loan.outstanding - principalPaid));
  // 本期未付的到期本金计入欠款；欠款本金始终是未偿本金的子集。
  const overduePrincipal = money(
    Math.max(0, loan.arrearsPrincipal + scheduledPrincipal - principalPaid),
  );
  const newArrearsPrincipal = money(Math.min(remainingOutstanding, overduePrincipal));

  loan.payments.push({
    tick,
    principalDue: scheduledPrincipal,
    interestDue,
    principalPaid,
    interestPaid,
    arrears: money(newArrearsInterest + newArrearsPrincipal),
    note: isFinalPeriod
      ? '最后一期：按剩余未偿本金结清，尾差计入本期。'
      : `等额本金第 ${periodNumber}/${loan.termMonths} 期。`,
  });
  const maxPayments = Math.max(1, Math.round(config.banking.maxLoanPaymentsPerLoan));
  if (loan.payments.length > maxPayments) {
    loan.payments.splice(0, loan.payments.length - maxPayments);
  }

  loan.outstanding = remainingOutstanding;
  loan.arrearsInterest = newArrearsInterest;
  loan.arrearsPrincipal = newArrearsPrincipal;
  loan.paidPrincipal = money(loan.paidPrincipal + principalPaid);
  loan.paidInterest = money(loan.paidInterest + interestPaid);
  loan.accruedInterest = 0;
  loan.nextDueTick += 1;

  const fullyPaid = newArrearsInterest <= 0.005 && newArrearsPrincipal <= 0.005;
  loan.missedPayments = fullyPaid ? 0 : loan.missedPayments + 1;

  if (remainingOutstanding <= 0.005 && fullyPaid) {
    loan.outstanding = 0;
    loan.arrearsInterest = 0;
    loan.arrearsPrincipal = 0;
    loan.status = 'repaid';
  } else if (loan.missedPayments > config.banking.graceMonths) {
    // 宽限期按“连续欠付月数 > graceMonths”判定：宽限 1 个月时第 2 个月仍欠付即违约。
    if (loan.status !== 'defaulted') {
      loan.status = 'defaulted';
      bankingNewDefaults(world);
      logs.push({
        tick,
        kind: 'warning',
        message: `${ownerLabel(world, loan.borrower)} 的 ${loanLabel(world, loan)} 连续 ${loan.missedPayments} 个月未足额还款，标记违约（不加罚息，继续按合同计息并尝试收款）。`,
      });
    }
  }

  if (loan.borrower.kind === 'company') syncCompanyDebt(world, loan.borrower.id);
  result.interestPaid = interestPaid;
  result.principalPaid = principalPaid;
  return result;
}

/** 处理某个借款人的全部到期贷款（按合同 id 字典序），返回本月实付利息/本金。 */
function serviceOwnerLoans(
  world: WorldState,
  owner: BankOwner,
  config: DemoConfig,
  tick: number,
  logs: LogEntry[],
): LoanServiceResult {
  const banking = world.banking;
  const result = zeroServiceResult();
  if (!banking) return result;
  const loans = banking.loans
    .filter(
      (loan) =>
        loan.status !== 'repaid' && sameOwner(loan.borrower, owner) && loan.nextDueTick <= tick,
    )
    .sort((a, b) => a.id.localeCompare(b.id));
  for (const loan of loans) {
    const served = serviceLoan(world, loan, config, tick, logs);
    result.interestPaid = money(result.interestPaid + served.interestPaid);
    result.principalPaid = money(result.principalPaid + served.principalPaid);
  }
  if (result.interestPaid > 0) {
    banking.lastMonth.interestIncome = money(
      banking.lastMonth.interestIncome + result.interestPaid,
    );
  }
  if (result.principalPaid > 0) {
    banking.lastMonth.principalRepaid = money(
      banking.lastMonth.principalRepaid + result.principalPaid,
    );
  }
  return result;
}

/** 步骤 5：活期存款计息。按月初余额 × 账户月利率，利息直接进入存款账户。 */
export function settleDepositInterest(
  world: WorldState,
  config: DemoConfig,
  tick: number,
  logs: LogEntry[],
): void {
  void logs;
  void config;
  const banking = world.banking;
  if (!banking) return;
  let interestTotal = 0;
  for (const account of [...banking.deposits].sort((a, b) => a.id.localeCompare(b.id))) {
    const interest = money(account.balance * account.rateMonthly);
    account.balance = money(account.balance + interest);
    account.accruedInterest = money(account.accruedInterest + interest);
    account.lastInterestTick = tick;
    interestTotal = money(interestTotal + interest);
  }
  banking.lastMonth.interestExpense = money(banking.lastMonth.interestExpense + interestTotal);
  refreshBankingTotals(world);
}

/**
 * 步骤 18：服务某企业作为借款人的到期贷款（工资/企业所得税之后、股息之前调用）。
 * 只从 company.cash 扣款，现金不足时只付可用部分，**绝不把 cash 扣成负数**；
 * 本月实付利息写入 company.lastMonth.interestPaid 供 finance.ts 计算利润。
 */
export function serviceCompanyLoans(
  world: WorldState,
  company: Company,
  config: DemoConfig,
  tick: number,
  logs: LogEntry[],
): LoanServiceResult {
  const owner: BankOwner = { kind: 'company', id: company.id };
  const result = serviceOwnerLoans(world, owner, config, tick, logs);
  company.lastMonth.interestPaid = result.interestPaid;
  syncCompanyDebt(world, company.id);
  refreshBankingTotals(world);
  return result;
}

/** 玩家个人贷款的同口径服务：从 world.player.cash 扣款。 */
export function servicePlayerLoans(
  world: WorldState,
  config: DemoConfig,
  tick: number,
  logs: LogEntry[],
): LoanServiceResult {
  const owner: BankOwner = { kind: 'player', id: 'player' };
  const result = serviceOwnerLoans(world, owner, config, tick, logs);
  refreshBankingTotals(world);
  return result;
}
