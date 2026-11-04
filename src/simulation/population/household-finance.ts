/**
 * 居民消费预算与居民群体消费贷款（块3/4 实现）。
 *
 * 口径（任务书 + DECISIONS #24/#35/#38/#39/#54，冻结）：
 * - 预算公式：参考消费额 = 上月实际可支配收入 × lastIncomeShare(0.8) + 手头现金 × cashShare(0.05)；
 *   现金预算 = min(现金, max(0, 参考消费额))；有积蓄即可消费，上月收入不是硬上限。
 *   上月收入是“上一个月结后的可支配收入”，还款从现金里扣，不从收入基数里再扣（避免双重扣减）。
 * - v0.9 T1：常规预算之外，若基本需求（food）存在资金缺口，允许在单月“月初存款×5%”上限内
 *   原子提取存款补足（存款→手头现金，depositWithdrawn 可审计），提取额不超过真实资金缺口与可用存款；
 *   支付顺序 = 手头现金 → 提取存款 → 消费贷。存款只是提现来源，不偷偷复制到手头。
 * - v1.0 任务书第四节：基本需求（food）的“数量”不因失业/非劳动身份削减，预算不足时允许动用更多
 *   手头现金直至基本需求成本（预算不能阻挡基本需求支付）；非基本消费仍受日常预算与消费意愿约束，
 *   不自动耗尽积蓄。有效需求分四层：desired（想买）→ effective（可支付）→ sold（真实成交）→ unmet（缺货），
 *   由 consumer.ts 的逐群体市场撮合与 recordGroupConsumption 记账落实。
 * - 消费贷款：额度 = max(0, 群体财产基准 × creditLimitRate − 未偿消费贷本金)，
 *   财产基准 = 手头现金 + 银行存款 + 按人口折算的居民投资实体权益（与 householdPerCapitaWealth 同口径）。
 *   贷款是真实债务，资金从银行支付，**不计入居民收入**；禁止无限信用。
 * - 新授信冻结条件（#35）：存在未结清违约合同，或连续欠付月数 ≥ denyWhenArrearsMonthsAtLeast(2)。
 *   逾期宽限沿用 banking.graceMonths，不新开 grace 配置键。
 * - 群体迁出/并组/人口变化必须保持债务归属与守恒（迁移由居民模块负责，本模块提供债务迁移导出）。
 *
 * 签名冻结后只增不改。
 */
import type {
  ConsumerBudgetSnapshot,
  GoodId,
  HouseholdGroup,
  HouseholdLoanContract,
  LoanPayment,
  OccupationClass,
  WorldState,
} from '../contracts/types';
import type { DemoConfig } from '../../data/config';
import { GOODS } from '../../data/demo-data';
import { round2 } from '../core/math';
import { depositAccountFor, withdraw } from '../banking/banking';
import { cityInvestorEquity, householdGroupsOfCity } from './household-groups';
import { transferInvestorLedgerForMigration } from '../investors/investors';

/**
 * v0.9 T1：存款提取上限（相对“月初存款”）——单月最多提取 5%。
 * 提取是存款→手头现金的转账，不创造货币；用于补足基本消费需求（food）。
 */
const DEPOSIT_WITHDRAWAL_MONTHLY_SHARE = 0.05;

/** 群体在银行（owner.kind='household'）的存款余额。 */
function groupDepositBalance(world: WorldState, groupId: string): number {
  return round2(Math.max(0, depositAccountFor(world, { kind: 'household', id: groupId })?.balance ?? 0));
}

/** 群体的消费需要系数：就业群体（含公共部门）最高，失业与非劳动力更低。 */
export function householdGroupNeedFactor(
  occupation: OccupationClass,
  config: DemoConfig,
): number {
  switch (occupation) {
    case 'unemployed':
      return config.consumer.unemployedNeedFactor;
    case 'nonLabor':
      return config.consumer.nonLaborNeedFactor;
    default:
      return config.consumer.employedNeedFactor;
  }
}

/**
 * v1.0：基本需求商品（当前只有 food）。
 * 基本需求的数量不随失业/非劳动身份削减；预算不足时允许动用更多手头现金与
 * 单月存款提取额度来支付（见 consumer.ts 顶部两阶段与四层口径说明）。
 */
export function isBasicNeedGood(goodId: GoodId): boolean {
  return goodId === 'food';
}

/**
 * 群体“基本需求”月成本（food 的按人月需求，不含价格弹性和职业需要系数；
 * 用于判断积蓄提取缺口，以及消费者市场的“基本需求现金支付上限”）。
 * v1.0：失业群体的基本需求数量不因失业削减——这里故意不乘 householdGroupNeedFactor。
 */
export function householdBasicNeedCost(
  world: WorldState,
  group: HouseholdGroup,
  config: DemoConfig,
): number {
  void config;
  const city = world.cities.find((entry) => entry.id === group.cityId);
  const food = GOODS.find((good) => good.id === 'food');
  if (!food) return 0;
  const price = city?.market?.food?.price ?? food.basePrice;
  const qty = group.people * food.perCapitaMonthlyNeed;
  return round2(qty * Math.max(0.01, price));
}

/**
 * 本月剩余可提取额度 = max(0, 月初存款×5% − 本月已提取)。
 * 月初存款用“当前余额 + 本月已提取”反推（同月内只有提取会减少余额；
 * 存款利息在步骤 5 先入账，因此这里已是计息后的月初余额）。
 */
export function householdDepositWithdrawalRemaining(
  world: WorldState,
  group: HouseholdGroup,
): number {
  const balance = groupDepositBalance(world, group.id);
  const withdrawn = round2(Math.max(0, group.lastMonth.depositWithdrawn ?? 0));
  const monthStart = round2(balance + withdrawn);
  if (monthStart <= 0) return 0;
  const cap = round2(monthStart * DEPOSIT_WITHDRAWAL_MONTHLY_SHARE);
  return round2(Math.max(0, cap - withdrawn));
}

/**
 * 原子地从该群体存款账户提取到本群体现金（存款减少、现金增加，总量不变），
 * 并累加 HouseholdMonthlyStats.depositWithdrawn。取款额自动封顶于
 * “本月剩余额度、存款余额、申请额”三者最小值；失败返回 0（不留半期状态）。
 * 仅应在真实消费成交后按实际缺口调用，避免“先提钱再闲置”。
 */
export function withdrawHouseholdDeposit(
  world: WorldState,
  group: HouseholdGroup,
  config: DemoConfig,
  amount: number,
  tick: number,
): number {
  const requested = round2(amount);
  if (!Number.isFinite(requested) || requested <= 0) return 0;
  const remaining = householdDepositWithdrawalRemaining(world, group);
  const balance = groupDepositBalance(world, group.id);
  const take = round2(Math.max(0, Math.min(requested, remaining, balance)));
  if (take <= 0) return 0;
  const result = withdraw(world, { kind: 'household', id: group.id }, take, config, tick);
  if (!result.ok) return 0;
  group.lastMonth.depositWithdrawn = round2((group.lastMonth.depositWithdrawn ?? 0) + take);
  return take;
}

/** 居民投资实体权益按人口折算到该群体（与 householdPerCapitaWealth 同口径，不重复计价）。 */
function groupInvestorEquityShare(
  world: WorldState,
  group: HouseholdGroup,
  cityGroups: HouseholdGroup[],
): number {
  const totalPeople = cityGroups.reduce((total, entry) => total + entry.people, 0);
  if (totalPeople <= 0) return 0;
  const equity = cityInvestorEquity(world, group.cityId);
  return round2((equity / totalPeople) * group.people);
}

/** 群体财产基准（现金 + 存款 + 权益）：额度与授信冻结都以此为准。 */
export function householdAssetBase(
  world: WorldState,
  group: HouseholdGroup,
  config: DemoConfig,
): number {
  void config;
  const cityGroups = householdGroupsOfCity(world, group.cityId);
  return round2(
    group.cash +
      groupDepositBalance(world, group.id) +
      groupInvestorEquityShare(world, group, cityGroups),
  );
}

/** 是否存在未结清违约合同（status='defaulted'）。 */
function hasDefaultedLoan(world: WorldState, groupId: string): boolean {
  return (world.householdFinance?.loans ?? []).some(
    (loan) => loan.groupId === groupId && loan.status === 'defaulted',
  );
}

/** 连续欠付月数是否达到冻结阈值（missedPayments 连续计数）。 */
function hasTooManyMissedPayments(
  world: WorldState,
  groupId: string,
  config: DemoConfig,
): boolean {
  const threshold = Math.max(1, config.households.householdCredit.denyWhenArrearsMonthsAtLeast);
  return (world.householdFinance?.loans ?? []).some(
    (loan) =>
      loan.groupId === groupId &&
      loan.status !== 'repaid' &&
      loan.status !== 'writtenOff' &&
      loan.missedPayments >= threshold,
  );
}

/** 群体财产基准与授信上限（不含当月新借款）。 */
export function householdCreditLimit(
  world: WorldState,
  group: HouseholdGroup,
  config: DemoConfig,
): number {
  const credit = config.households.householdCredit;
  const assetBase = householdAssetBase(world, group, config);
  if (assetBase <= 0 && !credit.allowUnsecuredNoAsset) return 0;
  if (hasDefaultedLoan(world, group.id)) return 0;
  if (hasTooManyMissedPayments(world, group.id, config)) return 0;
  const limit = round2(assetBase * credit.creditLimitRate - householdOutstanding(world, group.id));
  return Math.max(0, limit);
}

/** 群体当前未偿消费贷款本金合计。 */
export function householdOutstanding(world: WorldState, groupId: string): number {
  const loans = world.householdFinance?.loans ?? [];
  let total = 0;
  for (const loan of loans) {
    if (loan.groupId !== groupId) continue;
    if (loan.status === 'repaid' || loan.status === 'writtenOff') continue;
    total += loan.outstanding;
  }
  return Math.round(total * 100) / 100;
}

/**
 * 单群体单月的等额本金还款（只从群体现金扣款，绝不扣成负数；宽限/违约沿用 banking.graceMonths）。
 * 幂等：同一 tick 已服务过的贷款（payments 末条 tick === tick）会跳过。
 */
function serviceGroupLoans(
  world: WorldState,
  group: HouseholdGroup,
  config: DemoConfig,
  tick: number,
  logs: { tick: number; kind: string; message: string }[],
): { repaid: number; interestPaid: number; inArrears: number } {
  const finance = world.householdFinance;
  if (!finance) return { repaid: 0, interestPaid: 0, inArrears: 0 };
  const result = { repaid: 0, interestPaid: 0, inArrears: 0 };
  const loans = finance.loans
    .filter(
      (loan) =>
        loan.groupId === group.id &&
        (loan.status === 'active' || loan.status === 'defaulted') &&
        loan.nextDueTick <= tick,
    )
    .sort((a, b) => a.id.localeCompare(b.id));
  for (const loan of loans) {
    const lastPayment = loan.payments[loan.payments.length - 1];
    if (lastPayment && lastPayment.tick === tick) continue;

    // 先息后本：本期利息 + 历史欠息一起收，再收本金（含逾期本金），合计不超过群体现金。
    const interestDue = round2(loan.outstanding * loan.rateMonthly);
    const owedInterest = round2(loan.arrearsInterest + interestDue);
    const interestPaid = round2(Math.min(group.cash, owedInterest));
    group.cash = round2(group.cash - interestPaid);

    const periodNumber = loan.nextDueTick - loan.startTick;
    const isFinalPeriod = periodNumber >= loan.termMonths;
    const scheduledPrincipal = isFinalPeriod
      ? round2(loan.outstanding)
      : round2(Math.min(loan.monthlyPrincipal, loan.outstanding));
    const collectiblePrincipal = round2(
      Math.min(loan.outstanding, loan.arrearsPrincipal + scheduledPrincipal),
    );
    const principalPaid = round2(Math.min(group.cash, collectiblePrincipal));
    group.cash = round2(group.cash - principalPaid);

    const newArrearsInterest = round2(Math.max(0, owedInterest - interestPaid));
    const remainingOutstanding = round2(Math.max(0, loan.outstanding - principalPaid));
    const overduePrincipal = round2(
      Math.max(0, loan.arrearsPrincipal + scheduledPrincipal - principalPaid),
    );
    const newArrearsPrincipal = round2(Math.min(remainingOutstanding, overduePrincipal));

    const payment: LoanPayment = {
      tick,
      principalDue: scheduledPrincipal,
      interestDue,
      principalPaid,
      interestPaid,
      arrears: round2(newArrearsInterest + newArrearsPrincipal),
      note: isFinalPeriod
        ? '最后一期：按剩余未偿本金结清，尾差计入本期。'
        : `等额本金第 ${periodNumber}/${loan.termMonths} 期。`,
    };
    loan.payments.push(payment);

    loan.outstanding = remainingOutstanding;
    loan.arrearsInterest = newArrearsInterest;
    loan.arrearsPrincipal = newArrearsPrincipal;
    loan.paidPrincipal = round2(loan.paidPrincipal + principalPaid);
    loan.paidInterest = round2(loan.paidInterest + interestPaid);
    loan.accruedInterest = 0;
    loan.nextDueTick += 1;

    const fullyPaid = newArrearsInterest <= 0.005 && newArrearsPrincipal <= 0.005;
    loan.missedPayments = fullyPaid ? 0 : loan.missedPayments + 1;
    result.repaid = round2(result.repaid + principalPaid);
    result.interestPaid = round2(result.interestPaid + interestPaid);
    result.inArrears = round2(result.inArrears + newArrearsInterest + newArrearsPrincipal);

    if (remainingOutstanding <= 0.005 && fullyPaid) {
      loan.outstanding = 0;
      loan.arrearsInterest = 0;
      loan.arrearsPrincipal = 0;
      loan.status = 'repaid';
    } else if (loan.missedPayments > config.banking.graceMonths) {
      // 宽限期按“连续欠付月数 > graceMonths”判定：宽限 1 个月时第 2 个月仍欠付即违约。
      if (loan.status !== 'defaulted') {
        loan.status = 'defaulted';
        logs.push({
          tick,
          kind: 'warning',
          message: `${group.name} 的居民消费贷款 ${loan.id} 连续 ${loan.missedPayments} 个月未足额还款，标记违约（不加罚息，继续按合同收款）。`,
        });
      }
    }
  }
  return result;
}

/** 单群体预算快照（内部：先服务到期贷款，再算预算；幂等调用同一 tick 结果一致）。 */
function buildSnapshot(
  world: WorldState,
  group: HouseholdGroup,
  config: DemoConfig,
  tick: number,
): ConsumerBudgetSnapshot {
  const budgetConfig = config.households.consumerBudget;
  void serviceGroupLoans(world, group, config, tick, world.log);
  const lastMonthIncome = round2(Math.max(0, group.lastMonth.income));
  const cash = round2(Math.max(0, group.cash));
  const incomeComponent = round2(lastMonthIncome * budgetConfig.lastIncomeShare);
  const cashComponent = round2(cash * budgetConfig.cashShare);
  const referenceSpend = round2(incomeComponent + cashComponent);
  const baseCashBudget = round2(Math.min(cash, Math.max(0, referenceSpend)));
  // v0.9 T1：常规预算 = min(现金, 0.8×上月收入 + 0.05×现金)；当它不足以覆盖基本需求（food）时，
  // 允许在“月初存款×5%”上限内提取存款补足，且提取额不超过真实资金缺口（基本需求成本 − 手头现金）。
  const basicCost = householdBasicNeedCost(world, group, config);
  const fundingGap = round2(Math.max(0, basicCost - cash));
  const withdrawalAllowance = round2(
    Math.min(fundingGap, householdDepositWithdrawalRemaining(world, group), groupDepositBalance(world, group.id)),
  );
  const cashBudget = round2(baseCashBudget + withdrawalAllowance);
  const loanAvailable = householdCreditLimit(world, group, config);
  const snapshot: ConsumerBudgetSnapshot = {
    tick,
    cityId: group.cityId,
    groupId: group.id,
    lastMonthDisposableIncome: lastMonthIncome,
    incomeComponent,
    cash,
    cashComponent,
    referenceSpend,
    cashBudget,
    loanAvailable,
    // DECISIONS #26（冻结）：有效需求 = 现金预算，不含可借额度；可借额度单列，只用于事后补足。
    effectiveBudget: cashBudget,
    loanGranted: 0,
    actualSpend: 0,
    unmetByFunding: 0,
    depositsIncluded: budgetConfig.depositsIncluded,
    note: '【v0.9 T1】现金预算 = min(手头现金, 0.8×上月可支配收入 + 0.05×现金) + 基本需求缺口补充；补充 ≤ 月初存款×5% 且 ≤ 真实资金缺口（基本需求成本−手头现金）；存款只是提现来源、不是复制品；有效需求不含可借额度（#26）。',
  };
  group.lastMonth.budget = cashBudget;
  return snapshot;
}

/**
 * 生成某群体某月的消费预算快照（可审计；actualSpend/loanGranted 由消费结算回填）。
 * 预算不足部分计入 unmetByFunding（与“供给不足未满足”分开）。
 * 快照写入 world.householdFinance.budgets，按 tick+groupId 幂等覆盖，只保留最近 budgetSnapshotMonths 个月。
 */
export function householdConsumerBudgetSnapshot(
  world: WorldState,
  group: HouseholdGroup,
  config: DemoConfig,
  tick: number,
): ConsumerBudgetSnapshot {
  const snapshot = buildSnapshot(world, group, config, tick);
  const finance = world.householdFinance;
  if (finance) {
    const existing = finance.budgets.findIndex(
      (entry) => entry.tick === tick && entry.groupId === group.id,
    );
    if (existing >= 0) finance.budgets[existing] = snapshot;
    else finance.budgets.push(snapshot);
    finance.budgets.sort((a, b) => a.tick - b.tick || a.groupId.localeCompare(b.groupId));
    const keep = Math.max(1, config.households.budgetSnapshotMonths);
    const ticks = [...new Set(finance.budgets.map((entry) => entry.tick))].sort((a, b) => a - b);
    const floorTick = ticks.length > keep ? (ticks[ticks.length - keep] ?? 0) : Number.NEGATIVE_INFINITY;
    finance.budgets = finance.budgets.filter((entry) => entry.tick >= floorTick);
  }
  return snapshot;
}

/**
 * 消费贷前置校验（纯函数：只读世界、不产生任何副作用）。
 *
 * v0.7 验收问题 3：消费市场必须在成交前用它确认“授信资格、当月笔数、真实可用额度、
 * 单笔最低额”全部满足，再原子提交放款+成交；任何一条不满足就不得成交，
 * 避免出现“市场记录成交、群体实际支付 0 / 贷款未放出”的虚假成交。
 * 与 borrowForConsumption 共用同一套规则（放款前会再走一遍同样的校验）。
 */
export function consumptionLoanEligibility(
  world: WorldState,
  group: HouseholdGroup,
  config: DemoConfig,
  amount: number,
  tick: number,
  // 原子消费阶段：额度以“消费阶段开始时的授信快照”为准（见 buildSnapshot.loanAvailable），
  // 因此可跳过这里按当前财产基准的二次额度复核；冻结/欠付/笔数等资格校验仍保留。
  options: { skipCreditLimit?: boolean } = {},
): { ok: true } | { ok: false; error: string } {
  const finance = world.householdFinance;
  if (!finance) return { ok: false, error: '世界缺少居民消费金融账本' };
  const credit = config.households.householdCredit;
  const requested = round2(amount);
  if (!Number.isFinite(requested) || requested <= 0) {
    return { ok: false, error: '贷款金额必须为正' };
  }
  if (requested < credit.minLoanAmount) {
    return {
      ok: false,
      error: `单笔消费贷款不能低于 ${credit.minLoanAmount.toFixed(0)} 信用点`,
    };
  }
  const createdThisTick = finance.loans.filter(
    (loan) => loan.groupId === group.id && loan.startTick === tick,
  ).length;
  if (createdThisTick >= Math.max(1, credit.maxLoansPerGroupPerMonth)) {
    return { ok: false, error: '该群体本月新增消费贷款笔数已达上限' };
  }
  if (!options.skipCreditLimit) {
    const limit = householdCreditLimit(world, group, config);
    if (requested > limit + 0.005) {
      return {
        ok: false,
        error: `超出消费贷额度：可借 ${limit.toFixed(2)}，申请 ${requested.toFixed(2)}`,
      };
    }
  }
  return { ok: true };
}

/**
 * 为消费放款（在额度内，整数金额；资金从银行支付给卖方，不进入居民收入）。
 * 约束：不得超过 householdCreditLimit；每月每群体新增笔数 ≤ maxLoansPerGroupPerMonth。
 */
export function borrowForConsumption(
  world: WorldState,
  group: HouseholdGroup,
  config: DemoConfig,
  amount: number,
  tick: number,
  // 原子消费阶段专用：调用方已对“计划成交额”做过完整授信预检，此处按实际成交额放款，
  // 不再用成交后的财产基准重算额度（成交会改变企业现金/库存估值，可能反过来否决已批准授信）。
  options: { prechecked?: boolean } = {},
): { ok: boolean; loan: HouseholdLoanContract | null; error?: string } {
  const finance = world.householdFinance;
  if (!finance) return { ok: false, loan: null, error: '世界缺少居民消费金融账本' };
  const credit = config.households.householdCredit;
  const requested = round2(amount);
  const eligibility = options.prechecked
    ? requested > 0
      ? ({ ok: true } as const)
      : ({ ok: false, error: '贷款金额必须为正' } as const)
    : consumptionLoanEligibility(world, group, config, requested, tick);
  if (!eligibility.ok) {
    return { ok: false, loan: null, error: eligibility.error };
  }
  const termMonths = Math.max(1, credit.termMonths);
  const loan: HouseholdLoanContract = {
    id: `hhloan-${group.cityId}-${finance.nextLoanNumber}`,
    cityId: group.cityId,
    groupId: group.id,
    purpose: 'consumption',
    principal: requested,
    outstanding: requested,
    monthlyPrincipal: round2(requested / termMonths),
    rateMonthly: credit.rateMonthly,
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
    note: `【暂定】居民消费贷款：等额本金 ${termMonths} 期，月利率 ${(credit.rateMonthly * 100).toFixed(2)}%；资金由银行支付、不计入居民收入。`,
  };
  finance.nextLoanNumber += 1;
  finance.loans.push(loan);
  finance.loans.sort((a, b) => a.id.localeCompare(b.id));
  // 银行放款：货币从银行体系进入居民手头现金（真实债务，不进收入口径）。
  group.cash = round2(group.cash + requested);
  group.lastMonth.loanDrawn = round2((group.lastMonth.loanDrawn ?? 0) + requested);
  return { ok: true, loan };
}

/** 服务居民消费贷款（全部群体；供月结/测试直接调用；同一 tick 可重复调用）。 */
export function repayHouseholdLoans(
  world: WorldState,
  config: DemoConfig,
  tick: number,
  logs: { tick: number; kind: string; message: string }[],
): { repaid: number; interestPaid: number; inArrears: number } {
  const result = { repaid: 0, interestPaid: 0, inArrears: 0 };
  for (const city of [...world.cities].sort((a, b) => a.id.localeCompare(b.id))) {
    for (const group of householdGroupsOfCity(world, city.id).sort((a, b) => a.id.localeCompare(b.id))) {
      const served = serviceGroupLoans(world, group, config, tick, logs);
      result.repaid = round2(result.repaid + served.repaid);
      result.interestPaid = round2(result.interestPaid + served.interestPaid);
      result.inArrears = round2(result.inArrears + served.inArrears);
    }
  }
  return result;
}

/** 贷款是否仍有未结清债务（未偿本金、欠付本金或欠付利息任一大于 0）。 */
function loanHasDebt(loan: HouseholdLoanContract): boolean {
  return (
    loan.outstanding > 0.005 ||
    loan.arrearsPrincipal > 0.005 ||
    loan.arrearsInterest > 0.005
  );
}

/**
 * 把 total 按 weights 精确拆成 0.01 精度的金额数组（最大余数法）：
 * Σ 返回值 === round2(total)（分位精确），避免逐项 round2 累积尾差破坏守恒。
 */
function allocateDebtCents(total: number, weights: number[]): number[] {
  const cents = Math.max(0, Math.round(total * 100));
  const allocations = weights.map(() => 0);
  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0);
  if (cents <= 0 || weightTotal <= 0) return allocations;
  const raw = weights.map((weight) => (cents * weight) / weightTotal);
  const floors = raw.map((value) => Math.floor(value));
  let remainder = cents - floors.reduce((sum, value) => sum + value, 0);
  const order = raw
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  for (const entry of order) {
    if (remainder <= 0) break;
    floors[entry.index] = (floors[entry.index] ?? 0) + 1;
    remainder -= 1;
  }
  return floors.map((value) => value / 100);
}

function remainingLoanTerm(loan: HouseholdLoanContract): number {
  const elapsed = Math.max(0, loan.nextDueTick - loan.startTick - 1);
  return Math.max(1, loan.termMonths - elapsed);
}

interface DebtSplitDestination {
  group: HouseholdGroup;
  weight: number;
}

interface DebtSplitResult {
  outstanding: number;
  arrearsPrincipal: number;
  arrearsInterest: number;
  contracts: number;
}

/** 群体变化拆分出的债务合同标记（用于月度合并，防止合同数量指数增长）。 */
const GROUP_SPLIT_NOTE_MARK = '按人均债务分割';

function isGroupSplitFragment(loan: HouseholdLoanContract): boolean {
  return loan.note.includes(GROUP_SPLIT_NOTE_MARK);
}

/**
 * 合并前要求的“还款条件完全相同”签名。
 *
 * v0.7.1 复验问题 A：旧实现用 min(startTick)/min(nextDueTick)/max(termMonths) 合并任意碎片，
 * 会把不同月份发放、到期月不同的贷款并成一笔——新贷款被拖进旧贷款的“最后一期”，
 * 末期按剩余未偿全额结清，导致新贷款提前到期（复现：旧贷 M24 应还 100，新贷月供 100，
 * 合并后 M24 却要求 2500）。
 * 现在只合并开始月、期限、下次还款月、月利率、状态完全一致的碎片：这类合同的每一期
 * 应还本金/利息/到期日天然相同，聚合后各期金额就是原合同之和，不会改变任何还款安排。
 */
function loanScheduleKey(loan: HouseholdLoanContract): string {
  return [
    loan.startTick,
    loan.termMonths,
    loan.nextDueTick,
    loan.rateMonthly.toFixed(6),
    loan.status,
  ].join('|');
}

/**
 * 把同一城同一群体内**还款条件完全相同**的“群体变化拆分合同”合并为一笔：
 * 拆分每月都会发生，若不合并，碎片会继续被拆分，合同数与存档体积指数增长。
 * 合并只做账面聚合：Σ未偿/欠息/月供守恒，payments 拼接，不产生还款记录；
 * 开始月、期限、下次还款月、利率、状态必须完全一致，故各期还款计划与原合同保持一致。
 */
function consolidateGroupSplitFragments(
  finance: NonNullable<WorldState['householdFinance']>,
  cityId: string,
  groupId: string,
): number {
  const fragments = finance.loans
    .filter(
      (loan) =>
        loan.cityId === cityId &&
        loan.groupId === groupId &&
        isGroupSplitFragment(loan) &&
        (loan.status === 'active' || loan.status === 'defaulted') &&
        loanHasDebt(loan),
    )
    .sort((a, b) => a.id.localeCompare(b.id));
  if (fragments.length <= 1) return 0;
  const buckets = new Map<string, HouseholdLoanContract[]>();
  for (const fragment of fragments) {
    const key = loanScheduleKey(fragment);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(fragment);
    else buckets.set(key, [fragment]);
  }
  const mergedIds = new Set<string>();
  for (const bucket of buckets.values()) {
    if (bucket.length <= 1) continue;
    bucket.sort((a, b) => a.id.localeCompare(b.id));
    const target = bucket[0]!;
    for (const fragment of bucket.slice(1)) {
      target.principal = round2(target.principal + fragment.principal);
      target.outstanding = round2(target.outstanding + fragment.outstanding);
      target.paidPrincipal = round2(target.paidPrincipal + fragment.paidPrincipal);
      target.paidInterest = round2(target.paidInterest + fragment.paidInterest);
      target.accruedInterest = round2(target.accruedInterest + fragment.accruedInterest);
      target.arrearsPrincipal = round2(target.arrearsPrincipal + fragment.arrearsPrincipal);
      target.arrearsInterest = round2(target.arrearsInterest + fragment.arrearsInterest);
      // 各期月供相加 = 聚合合同每期应还的本金；不重算、不改期限/开始月/下次还款月。
      target.monthlyPrincipal = round2(target.monthlyPrincipal + fragment.monthlyPrincipal);
      target.missedPayments = Math.max(target.missedPayments, fragment.missedPayments);
      target.payments = [...target.payments, ...fragment.payments].sort((a, b) => a.tick - b.tick);
      mergedIds.add(fragment.id);
    }
    // 账面恒等式：principal − paidPrincipal === outstanding。
    target.principal = round2(target.outstanding + target.paidPrincipal);
  }
  if (mergedIds.size === 0) return 0;
  finance.loans = finance.loans.filter((loan) => !mergedIds.has(loan.id));
  return mergedIds.size;
}

/**
 * 把单笔贷款按 share 拆出一部分给 destinations（按权重分配，分位精确）。
 * 只转移未偿本金/欠付本金/欠付利息，**不写 payments、不改 paidPrincipal/paidInterest**
 * （转移不是还款）；源合同按转出额同步减记 principal，保持 principal − paidPrincipal === outstanding。
 */
function splitHouseholdLoan(
  finance: NonNullable<WorldState['householdFinance']>,
  loan: HouseholdLoanContract,
  share: number,
  destinations: DebtSplitDestination[],
  tick: number,
  notePrefix: string,
): DebtSplitResult {
  const result: DebtSplitResult = {
    outstanding: 0,
    arrearsPrincipal: 0,
    arrearsInterest: 0,
    contracts: 0,
  };
  if (destinations.length === 0 || share <= 0) return result;
  const movedOutstanding = round2(Math.max(0, Math.min(loan.outstanding, loan.outstanding * share)));
  const movedArrearsPrincipal = round2(
    Math.max(0, Math.min(loan.arrearsPrincipal, loan.arrearsPrincipal * share)),
  );
  const movedArrearsInterest = round2(
    Math.max(0, Math.min(loan.arrearsInterest, loan.arrearsInterest * share)),
  );
  if (movedOutstanding <= 0.004 && movedArrearsPrincipal <= 0.004 && movedArrearsInterest <= 0.004) {
    return result;
  }
  const weights = destinations.map((entry) => entry.weight);
  const outstandingParts = allocateDebtCents(movedOutstanding, weights);
  const arrearsPrincipalParts = allocateDebtCents(movedArrearsPrincipal, weights);
  const arrearsInterestParts = allocateDebtCents(movedArrearsInterest, weights);
  const termMonths = remainingLoanTerm(loan);
  for (let index = 0; index < destinations.length; index += 1) {
    const destination = destinations[index]!;
    const partOutstanding = outstandingParts[index] ?? 0;
    // 欠付本金是未偿本金的一部分，拆分后不得超过该合同分到的未偿额。
    const partArrearsPrincipal = Math.min(arrearsPrincipalParts[index] ?? 0, partOutstanding);
    const partArrearsInterest = arrearsInterestParts[index] ?? 0;
    if (partOutstanding <= 0 && partArrearsPrincipal <= 0 && partArrearsInterest <= 0) continue;
    const split: HouseholdLoanContract = {
      ...loan,
      id: `${loan.id}-s${finance.nextLoanNumber}`,
      cityId: destination.group.cityId,
      groupId: destination.group.id,
      principal: partOutstanding,
      outstanding: partOutstanding,
      monthlyPrincipal: round2(partOutstanding / termMonths),
      // 保持原合同期限/首期：拆分不是新贷款，不得延长债务久期。
      termMonths: loan.termMonths,
      startTick: loan.startTick,
      nextDueTick: loan.nextDueTick,
      paidPrincipal: 0,
      paidInterest: 0,
      accruedInterest: 0,
      arrearsPrincipal: partArrearsPrincipal,
      arrearsInterest: partArrearsInterest,
      payments: [],
      note: `${notePrefix}：来自 ${loan.id} 的按人均债务分割（${(share * 100).toFixed(2)}%，不记为还款）。`,
    };
    finance.nextLoanNumber += 1;
    finance.loans.push(split);
    result.outstanding = round2(result.outstanding + partOutstanding);
    result.arrearsPrincipal = round2(result.arrearsPrincipal + partArrearsPrincipal);
    result.arrearsInterest = round2(result.arrearsInterest + partArrearsInterest);
    result.contracts += 1;
  }
  // 源合同减记：未偿与原始本金同额减少，还款历史（payments/paidPrincipal/paidInterest）保持不动。
  loan.outstanding = round2(Math.max(0, loan.outstanding - result.outstanding));
  loan.arrearsPrincipal = round2(Math.max(0, loan.arrearsPrincipal - result.arrearsPrincipal));
  loan.arrearsInterest = round2(Math.max(0, loan.arrearsInterest - result.arrearsInterest));
  loan.principal = round2(Math.max(loan.paidPrincipal, loan.principal - result.outstanding));
  loan.monthlyPrincipal = round2(
    Math.min(loan.monthlyPrincipal, loan.outstanding / Math.max(1, termMonths)),
  );
  if (!loanHasDebt(loan)) {
    loan.outstanding = 0;
    loan.arrearsPrincipal = 0;
    loan.arrearsInterest = 0;
    loan.status = 'repaid';
  }
  return result;
}

/** 城内群体人数变化时的债务分配结果（会计口径；金额为本次转出/改挂的未偿与欠息）。 */
export interface HouseholdDebtAllocationResult {
  movedPrincipal: number;
  movedArrearsPrincipal: number;
  movedArrearsInterest: number;
  splitLoans: number;
  reassignedLoans: number;
  isolatedLoans: number;
}

/**
 * 城内居民群体人数变化（就业/失业/职业变动/并组拆分）时的消费贷债务归属守恒。
 *
 * 规则（与现金/存款的“按人均随人走”一致）：
 * 1. 有接收群体时按“离开人数 / 源群体原人数”的比例把每笔贷款的未偿本金、欠付本金、
 *    欠付利息转给新增人数的群体（按新增人数权重分配，分位精确，Σ 债务不变）；
 * 2. 整群转出且只有一个接收群体时直接改挂 groupId（合同/还款记录原样保留，不伪造已还款）；
 * 3. 目标人数为 0 的群体若仍留有债务：先并入同城人数最多（tie-break groupId 升序）的群体；
 *    同城已无任何在册群体时**显式隔离**：保留原合同、追加【隔离】备注并写 warning 日志，
 *    不删除、不改挂、不记为已还款（无法可靠承接的类别不静默消失）。
 *
 * 只读 targets（syncHouseholdPeople 计算出的新人数），要求调用时 group.people 仍是旧人数。
 */
export function reallocateHouseholdDebtsForGroupChange(
  world: WorldState,
  config: DemoConfig,
  cityId: string,
  targets: ReadonlyMap<OccupationClass, number>,
): HouseholdDebtAllocationResult {
  void config;
  const result: HouseholdDebtAllocationResult = {
    movedPrincipal: 0,
    movedArrearsPrincipal: 0,
    movedArrearsInterest: 0,
    splitLoans: 0,
    reassignedLoans: 0,
    isolatedLoans: 0,
  };
  const finance = world.householdFinance;
  if (!finance) return result;
  const groups = householdGroupsOfCity(world, cityId);
  if (groups.length === 0) return result;
  const tick = world.time.tick;
  // 先合并上月拆分碎片：拆分每月发生，碎片继续拆分会让合同数/存档体积指数增长。
  for (const group of groups) {
    consolidateGroupSplitFragments(finance, cityId, group.id);
  }
  const targetOf = (group: HouseholdGroup): number =>
    Math.max(0, Math.round(targets.get(group.occupation) ?? group.people));

  const changes = groups.map((group) => ({ group, delta: targetOf(group) - group.people }));
  const increases = changes.filter((entry) => entry.delta > 0);
  const decreases = changes.filter((entry) => entry.delta < 0);
  const totalIncrease = increases.reduce((sum, entry) => sum + entry.delta, 0);
  const destinations: DebtSplitDestination[] = increases.map((entry) => ({
    group: entry.group,
    weight: entry.delta,
  }));

  if (totalIncrease > 0 && destinations.length > 0) {
    for (const entry of decreases) {
      const source = entry.group;
      if (source.people <= 0) continue;
      const leaving = Math.min(-entry.delta, source.people);
      if (leaving <= 0) continue;
      const share = leaving / source.people;
      const sourceLoans = finance.loans
        .filter(
          (loan) =>
            loan.groupId === source.id &&
            (loan.status === 'active' || loan.status === 'defaulted') &&
            loanHasDebt(loan),
        )
        .sort((a, b) => a.id.localeCompare(b.id));
      for (const loan of sourceLoans) {
        // 整群转出且唯一接收方：改挂归属，保留合同与全部还款记录（不产生“已还款”记录）。
        if (leaving >= source.people && destinations.length === 1) {
          const destination = destinations[0]!.group;
          loan.groupId = destination.id;
          loan.cityId = destination.cityId;
          result.reassignedLoans += 1;
          result.movedPrincipal = round2(result.movedPrincipal + loan.outstanding);
          result.movedArrearsPrincipal = round2(
            result.movedArrearsPrincipal + loan.arrearsPrincipal,
          );
          result.movedArrearsInterest = round2(
            result.movedArrearsInterest + loan.arrearsInterest,
          );
          continue;
        }
        const moved = splitHouseholdLoan(
          finance,
          loan,
          share,
          destinations,
          tick,
          '群体人数变化转入',
        );
        result.movedPrincipal = round2(result.movedPrincipal + moved.outstanding);
        result.movedArrearsPrincipal = round2(
          result.movedArrearsPrincipal + moved.arrearsPrincipal,
        );
        result.movedArrearsInterest = round2(
          result.movedArrearsInterest + moved.arrearsInterest,
        );
        result.splitLoans += moved.contracts;
      }
    }
  }

  // 兜底：目标人数为 0 的群体若仍有未清债务，不得静默留在无人群体。
  const fallback = groups
    .filter((group) => targetOf(group) > 0)
    .sort((a, b) => targetOf(b) - targetOf(a) || a.id.localeCompare(b.id))[0];
  for (const group of groups) {
    if (targetOf(group) > 0) continue;
    const residualLoans = finance.loans
      .filter(
        (loan) =>
          loan.groupId === group.id &&
          (loan.status === 'active' || loan.status === 'defaulted') &&
          loanHasDebt(loan),
      )
      .sort((a, b) => a.id.localeCompare(b.id));
    for (const loan of residualLoans) {
      if (fallback) {
        loan.groupId = fallback.id;
        loan.cityId = fallback.cityId;
        result.reassignedLoans += 1;
        result.movedPrincipal = round2(result.movedPrincipal + loan.outstanding);
        result.movedArrearsPrincipal = round2(result.movedArrearsPrincipal + loan.arrearsPrincipal);
        result.movedArrearsInterest = round2(
          result.movedArrearsInterest + loan.arrearsInterest,
        );
        world.log.push({
          tick,
          kind: 'population',
          message: `居民群体 ${group.name}（${group.cityId}）人数归零但仍有未偿债务，按兜底规则并入同城人数最多的 ${fallback.name}（合同 ${loan.id}）。`,
        });
        continue;
      }
      // 同城已无任何可承接群体：不删除、不改挂，显式隔离并记日志（未记为还款）。
      result.isolatedLoans += 1;
      if (!loan.note.includes('【隔离】')) {
        loan.note = `${loan.note}【隔离】所在群体 ${group.id} 已无人且同城无其他可承接群体；债务保留原合同并记录日志，等待后续人工/迁移修复。`;
        world.log.push({
          tick,
          kind: 'warning',
          message: `居民消费贷款 ${loan.id} 所在群体 ${group.id} 已无人且同城无其他群体可承接：未偿本金 ${loan.outstanding.toFixed(2)} 已显式隔离（未删除、未记为已还款）。`,
        });
      }
    }
  }
  finance.loans.sort((a, b) => a.id.localeCompare(b.id));
  return result;
}

/**
 * 跨城迁移时的消费贷款归属守恒（“只增不改”追加导出，已获秘书处批准）：
 * 迁移者按人均带走自己那部分债务——按“迁出人数 / 源群体人数”的比例，把源群体贷款的
 * 未偿本金、欠付本金、欠付利息等额转移到目标城同职业群体；整群迁出时直接改挂 groupId。
 * 拆分只减记源合同的 outstanding 与 principal（保持 principal − paidPrincipal === outstanding），
 * 不写 payments、不改 paidPrincipal/paidInterest：转移不是还款。
 * 全程不产生新的现金；两城合计未偿本金与欠息守恒（分位精确）。
 */
export function transferHouseholdDebtsForMigration(
  world: WorldState,
  config: DemoConfig,
  fromCityId: string,
  toCityId: string,
  people: number,
  laborForceMoved: number = people,
  tick: number = world.time.tick,
): { principalMoved: number; loansMoved: number } {
  void config;
  // v1.2 §1：居民投资份额随迁移守恒——与消费贷同一“城 + 职业”粒度、同一人数口径，
  // 按迁出人数占源群体比例拆分份额给目的地同职业群体；不产生现金、不改实体现金与持股。
  transferInvestorLedgerForMigration(world, fromCityId, toCityId, people, laborForceMoved);
  const result = { principalMoved: 0, loansMoved: 0 };
  const finance = world.householdFinance;
  if (!finance || people <= 0) return result;
  const laborMoving = Math.max(0, Math.min(people, Math.round(laborForceMoved)));
  const legs: { occupation: HouseholdGroup['occupation']; moving: number }[] = [
    { occupation: 'unemployed', moving: laborMoving },
    { occupation: 'nonLabor', moving: people - laborMoving },
  ];
  const fromGroups = householdGroupsOfCity(world, fromCityId);
  const toGroups = householdGroupsOfCity(world, toCityId);
  for (const leg of legs) {
    if (leg.moving <= 0) continue;
    const source = fromGroups.find((group) => group.occupation === leg.occupation);
    const destination = toGroups.find((group) => group.occupation === leg.occupation);
    if (!source || !destination || source.people <= 0) continue;
    const moving = Math.min(leg.moving, source.people);
    if (moving <= 0) continue;
    const wholeGroup = moving >= source.people;
    const share = wholeGroup ? 1 : moving / source.people;
    const sourceLoans = finance.loans
      .filter(
        (loan) =>
          loan.groupId === source.id &&
          (loan.status === 'active' || loan.status === 'defaulted') &&
          loanHasDebt(loan),
      )
      .sort((a, b) => a.id.localeCompare(b.id));
    for (const loan of sourceLoans) {
      if (wholeGroup) {
        loan.groupId = destination.id;
        loan.cityId = destination.cityId;
        result.principalMoved = round2(result.principalMoved + loan.outstanding);
        result.loansMoved += 1;
        continue;
      }
      const moved = splitHouseholdLoan(
        finance,
        loan,
        share,
        [{ group: destination, weight: 1 }],
        tick,
        '迁移转入',
      );
      if (moved.contracts === 0) continue;
      result.principalMoved = round2(result.principalMoved + moved.outstanding);
      result.loansMoved += 1;
    }
  }
  finance.loans.sort((a, b) => a.id.localeCompare(b.id));
  return result;
}
