/**
 * 居民消费预算与居民群体消费贷款（v0.7 契约骨架，块0 空实现）。
 *
 * 口径（任务书 + DECISIONS v1.2 #24，暂定）：
 * - 预算公式：参考消费额 = 上月实际可支配收入 × lastIncomeShare(0.8) + 手头现金 × cashShare(0.05)；
 *   现金预算 = min(现金, max(0, 参考消费额))；有积蓄即可消费，上月收入不是硬上限。
 * - 银行存款首版不自动取出（depositsIncluded=false），不偷偷把存款复制到手头。
 * - 消费贷款：额度 = max(0, 群体财产基准) × creditLimitRate(0.5)，利率/期限与个人贷款同档（0.6%/24 月）；
 *   贷款是真实债务，资金从银行支付给商品卖方，不经过居民收入口径；不得无限信用。
 * - 新授信冻结条件（v1.4 #35，冻结）：存在未结清违约合同，或连续欠付月数
 *   ≥ householdCredit.denyWhenArrearsMonthsAtLeast(2) 时不得新增消费贷；
 *   逾期宽限沿用 banking.graceMonths，不新开 grace 配置键。
 * - 群体迁出/并组/人口变化必须保持债务归属与守恒（本模块不负责迁移，由居民模块在业务实现中处理）。
 *
 * 本文件当前只提供签名与空实现，业务体由游戏程序在块3 填充；签名冻结后只增不改。
 */
import type {
  ConsumerBudgetSnapshot,
  HouseholdGroup,
  HouseholdLoanContract,
  WorldState,
} from '../contracts/types';
import type { DemoConfig } from '../../data/config';

/** 群体财产基准与授信上限（不含当月新借款）。 */
export function householdCreditLimit(
  world: WorldState,
  group: HouseholdGroup,
  config: DemoConfig,
): number {
  void world;
  void group;
  void config;
  // TODO(块3)：现金 + 银行存款 − 未偿本金，再乘 creditLimitRate；下限 0。
  return 0;
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
 * 生成某群体某月的消费预算快照（可审计；actualSpend/loanGranted 由消费结算回填）。
 * 预算不足部分计入 unmetByFunding（与“供给不足未满足”分开）。
 */
export function householdConsumerBudgetSnapshot(
  world: WorldState,
  group: HouseholdGroup,
  config: DemoConfig,
  tick: number,
): ConsumerBudgetSnapshot {
  void world;
  void config;
  void tick;
  // TODO(块3)：按冻结公式计算并返回；当前返回零值占位。
  return {
    tick,
    cityId: group.cityId,
    groupId: group.id,
    lastMonthDisposableIncome: 0,
    incomeComponent: 0,
    cash: group.cash,
    cashComponent: 0,
    referenceSpend: 0,
    cashBudget: 0,
    loanAvailable: 0,
    effectiveBudget: 0,
    loanGranted: 0,
    actualSpend: 0,
    unmetByFunding: 0,
    depositsIncluded: config.households.consumerBudget.depositsIncluded,
    note: '块0 契约占位：尚未实现（块3）。',
  };
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
  void world;
  void group;
  void config;
  void amount;
  void tick;
  return { ok: false, loan: null, error: '居民消费贷款尚未实现（块3）' };
}

/** 服务居民消费贷款：还本付息、逾期/违约（沿用现有 grace/违约机制）。 */
export function repayHouseholdLoans(
  world: WorldState,
  config: DemoConfig,
  tick: number,
  logs: { tick: number; kind: string; message: string }[],
): { repaid: number; interestPaid: number; inArrears: number } {
  void world;
  void config;
  void tick;
  void logs;
  return { repaid: 0, interestPaid: 0, inArrears: 0 };
}
