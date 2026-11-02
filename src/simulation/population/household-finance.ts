/**
 * 居民消费预算与居民群体消费贷款（块3/4 实现）。
 *
 * 口径（任务书 + DECISIONS #24/#35/#38/#39/#54，冻结）：
 * - 预算公式：参考消费额 = 上月实际可支配收入 × lastIncomeShare(0.8) + 手头现金 × cashShare(0.05)；
 *   现金预算 = min(现金, max(0, 参考消费额))；有积蓄即可消费，上月收入不是硬上限。
 *   上月收入是“上一个月结后的可支配收入”，还款从现金里扣，不从收入基数里再扣（避免双重扣减）。
 * - 银行存款首版不自动取出（depositsIncluded=false），不偷偷把存款复制到手头。
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
  HouseholdGroup,
  HouseholdLoanContract,
  LoanPayment,
  WorldState,
} from '../contracts/types';
import type { DemoConfig } from '../../data/config';
import { round2 } from '../core/math';
import { depositAccountFor } from '../banking/banking';
import { cityInvestorEquity, householdGroupsOfCity } from './household-groups';

/** 群体在银行（owner.kind='household'）的存款余额。 */
function groupDepositBalance(world: WorldState, groupId: string): number {
  return round2(Math.max(0, depositAccountFor(world, { kind: 'household', id: groupId })?.balance ?? 0));
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
  const cashBudget = round2(Math.min(cash, Math.max(0, referenceSpend)));
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
    note: '【暂定】现金预算 = min(现金, 0.8×上月可支配收入 + 0.05×现金)；存款首版不进预算；有效需求不含可借额度（#26）。',
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
 * 为消费放款（在额度内，整数金额；资金从银行支付给卖方，不进入居民收入）。
 * 约束：不得超过 householdCreditLimit；每月每群体新增笔数 ≤ maxLoansPerGroupPerMonth。
 */
export function borrowForConsumption(
  world: WorldState,
  group: HouseholdGroup,
  config: DemoConfig,
  amount: number,
  tick: number,
): { ok: boolean; loan: HouseholdLoanContract | null; error?: string } {
  const finance = world.householdFinance;
  if (!finance) return { ok: false, loan: null, error: '世界缺少居民消费金融账本' };
  const credit = config.households.householdCredit;
  const requested = round2(amount);
  if (!Number.isFinite(requested) || requested <= 0) {
    return { ok: false, loan: null, error: '贷款金额必须为正' };
  }
  if (requested < credit.minLoanAmount) {
    return {
      ok: false,
      loan: null,
      error: `单笔消费贷款不能低于 ${credit.minLoanAmount.toFixed(0)} 信用点`,
    };
  }
  const createdThisTick = finance.loans.filter(
    (loan) => loan.groupId === group.id && loan.startTick === tick,
  ).length;
  if (createdThisTick >= Math.max(1, credit.maxLoansPerGroupPerMonth)) {
    return { ok: false, loan: null, error: '该群体本月新增消费贷款笔数已达上限' };
  }
  const limit = householdCreditLimit(world, group, config);
  if (requested > limit + 0.005) {
    return {
      ok: false,
      loan: null,
      error: `超出消费贷额度：可借 ${limit.toFixed(2)}，申请 ${requested.toFixed(2)}`,
    };
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

/**
 * 跨城迁移时的消费贷款归属守恒（“只增不改”追加导出，已获秘书处批准）：
 * 迁移者按人均带走自己那部分债务——按“迁出人数 / 源群体人数”的比例，把源群体贷款的
 * 未偿本金、欠付本金、欠付利息等额转移到目标城同职业群体；整群迁出时直接改挂 groupId。
 * 全程只转移债务、不产生新的现金；两城合计未偿本金守恒（容差 0.01/笔）。
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
          (loan.status === 'active' || loan.status === 'defaulted'),
      )
      .sort((a, b) => a.id.localeCompare(b.id));
    for (const loan of sourceLoans) {
      if (loan.outstanding <= 0.005) continue;
      if (wholeGroup) {
        loan.groupId = destination.id;
        loan.cityId = destination.cityId;
        result.principalMoved = round2(result.principalMoved + loan.outstanding);
        result.loansMoved += 1;
        continue;
      }
      const movedOutstanding = round2(loan.outstanding * share);
      if (movedOutstanding <= 0) continue;
      if (movedOutstanding > loan.outstanding) continue;
      const movedArrearsPrincipal = round2(loan.arrearsPrincipal * share);
      const movedArrearsInterest = round2(loan.arrearsInterest * share);
      const elapsed = Math.max(0, loan.nextDueTick - loan.startTick - 1);
      const remainingTerm = Math.max(1, loan.termMonths - elapsed);
      const split: HouseholdLoanContract = {
        ...loan,
        id: `${loan.id}-m${finance.nextLoanNumber}`,
        cityId: destination.cityId,
        groupId: destination.id,
        principal: movedOutstanding,
        outstanding: movedOutstanding,
        monthlyPrincipal: round2(movedOutstanding / remainingTerm),
        termMonths: remainingTerm,
        startTick: tick,
        nextDueTick: tick + 1,
        paidPrincipal: 0,
        paidInterest: 0,
        accruedInterest: 0,
        arrearsPrincipal: movedArrearsPrincipal,
        arrearsInterest: movedArrearsInterest,
        missedPayments: loan.missedPayments,
        payments: [],
        note: `迁移转入：来自 ${loan.id} 的按人均债务分割（${moving}/${source.people}）。`,
      };
      finance.nextLoanNumber += 1;
      finance.loans.push(split);
      loan.outstanding = round2(loan.outstanding - movedOutstanding);
      loan.arrearsPrincipal = round2(loan.arrearsPrincipal - movedArrearsPrincipal);
      loan.arrearsInterest = round2(loan.arrearsInterest - movedArrearsInterest);
      loan.monthlyPrincipal = round2(
        Math.min(loan.monthlyPrincipal, loan.outstanding / Math.max(1, remainingTerm)),
      );
      if (loan.outstanding <= 0.005) {
        loan.outstanding = 0;
        loan.status = 'repaid';
      }
      result.principalMoved = round2(result.principalMoved + movedOutstanding);
      result.loansMoved += 1;
    }
  }
  finance.loans.sort((a, b) => a.id.localeCompare(b.id));
  return result;
}
