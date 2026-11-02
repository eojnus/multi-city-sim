/**
 * 政府债务、应付项、银行垫付与破产（v0.7 契约，块2 实现）。
 *
 * 月结唯一入口：`settleGovernmentDebt`，在 `computeCityGdp` **之后**调用（DECISIONS v1.2 #22）。
 * 内部固定顺序（冻结，业务实现不得调整）：
 *   ① 计提应计利息并生成应付项：先债券按月（本金 × couponRateAnnual / 12）、政府贷款按月
 *      （outstanding × rateMonthly）计提，再生成本月到期的票息、到期债券本金、政府贷款分期。
 *      债券票息固定 3 期：M12、M24、M36（每满 interestPeriodMonths=12 一次）；**M36 同时还本**，
 *      应付项必须包含「M36 第 3 期票息」与「M36 到期本金」两笔（v1.4 #33，不能只按 2 期建模）。
 *   ② 票息/到期兑付：先用财政余额；票息不足 → 欠付利息（银行不垫付）；
 *      到期本金+欠息不足 → 银行无条件垫付（形成 bondAdvance 贷款，见 advances 记录）；
 *   ③ 银行贷款分期还款：财政不足时欠付，不影响破产判定之外的其他系统；
 *   ④ 债务汇总与破产判定：债务/GDP ≥ config.government.fiscalRisk.bankruptAt 即破产；
 *   ⑤ 破产清算与重选：银行立即兑付未到期债券本金+按实际持有月份计提的未付利息（不付未来利息），
 *      随后原有银行贷款与本次垫付形成的贷款一并勾销（不存在按比例清偿）；
 *      判定当月结算内立即触发重选，过渡期现任市长看守、仅维持性操作。
 *
 * 总负债口径（DECISIONS v1.1 #11 更正版 v1.3）：只计一次垫付——
 *   totalDebt = 政府全部银行贷款未偿本金（含 bondAdvance 垫付转贷款）
 *               + 未偿债券本金
 *               + 已计提未付利息（含欠付票息与欠付贷款利息）
 * 面板可拆分展示 ordinaryLoan / advanceLoan，但判定不得重复相加；GovernmentAdvanceRecord
 * 只是可追溯流水，**不得**再作为独立负债项目加入 totalDebt。
 * 公共口径统一由 `metrics.ts` 的 `cityDebt` / `assessCityFiscalRisk` / `recent12MonthGdp`
 * 提供（v1.4 #36），本文件不得另写一套。
 *
 * 幂等：同一城市同一 tick 成功结算后写入 `government.settledTicks`，重复调用直接返回；
 * 应付项按 (cityId, tick, kind, issuance/loan, holder) 锚点去重；兑付按批次/持债状态判重。
 */
import type {
  BondHolder,
  City,
  GovernmentAdvanceRecord,
  GovernmentBankruptcyRecord,
  GovernmentDebtSummary,
  GovernmentLoanContract,
  GovernmentPayable,
  HolderRef,
  LoanPayment,
  LogEntry,
  WorldState,
} from '../contracts/types';
import type { DemoConfig } from '../../data/config';
import { round2 } from '../core/math';
import { assessCityFiscalRisk, cityDebt } from './metrics';
import {
  accrueBondInterest,
  bondsOf,
  closeGovernmentBondSubscription,
  issueGovernmentBond,
  payBondCoupon,
  settleBondBankruptcyRedemption,
  settleBondMaturity,
  subscribeGovernmentBond,
  bondSubscriptionOrder,
} from './bonds';
import { receiveTreasury, spendTreasury } from './treasury';
import { requestImmediateElection } from '../politics/politics';
import {
  addShares,
  classesOfCompany,
  removeShares,
  syncAllCompanyShares,
} from '../securities/securities';

export interface GovernmentSettlementResult {
  tick: number;
  cityId: string;
  payablesCreated: number;
  payablesPaid: number;
  payablesInArrears: number;
  advancedByBank: number;
  bankrupted: boolean;
  debtSummary: GovernmentDebtSummary | null;
  problems: string[];
}

export interface GovernmentAdvanceResult {
  ok: boolean;
  advance: GovernmentAdvanceRecord | null;
  loan: GovernmentLoanContract | null;
  amountAdvanced: number;
  error?: string;
}

/** 政府贷款按月计提结果（等额本金：`outstanding_before_k = principal − (k−1)·monthlyPrincipal`）。 */
export interface GovernmentLoanAccrual {
  /** 本月应计利息（若仍未付）。 */
  currentMonthInterest: number;
  /** 自放款至当前 tick 的累计应付利息。 */
  cumulativeInterest: number;
  /** 累计应付中尚未支付的部分。 */
  unpaidInterest: number;
  /** 已过月数（0…termMonths）。 */
  elapsedMonths: number;
}

const EMPTY_SETTLEMENT = (tick: number, cityId: string): GovernmentSettlementResult => ({
  tick,
  cityId,
  payablesCreated: 0,
  payablesPaid: 0,
  payablesInArrears: 0,
  advancedByBank: 0,
  bankrupted: false,
  debtSummary: null,
  problems: [],
});

function holderKey(holder: BondHolder): string {
  return `${holder.kind}:${holder.id}`;
}

/** 政府贷款等额本金计息表（纯计算，可重复调用同一 tick 得到相同结果）。 */
export function governmentLoanAccrual(
  loan: GovernmentLoanContract,
  tick: number,
): GovernmentLoanAccrual {
  const term = Math.max(1, loan.termMonths);
  const elapsedMonths = Math.max(0, Math.min(term, tick - loan.startTick));
  let cumulativeInterest = 0;
  let currentMonthInterest = 0;
  for (let month = 1; month <= elapsedMonths; month++) {
    const outstandingBefore = Math.max(0, loan.principal - (month - 1) * loan.monthlyPrincipal);
    const interest = round2(outstandingBefore * loan.rateMonthly);
    cumulativeInterest = round2(cumulativeInterest + interest);
    currentMonthInterest = interest;
  }
  const unpaidInterest = round2(Math.max(0, cumulativeInterest - loan.paidInterest));
  return { currentMonthInterest, cumulativeInterest, unpaidInterest, elapsedMonths };
}

/**
 * 月结唯一入口：对全部城市按固定六阶段顺序结算政府债务（对同一 tick 幂等：
 * 已记录在 city.government.settledTicks 的 tick 不得重复兑付/清算）。
 * AI 政府自动发债（config.government.aiGovernment）在本函数内、逐城结算之前执行：
 * 与手动路径走同一发行/认购校验，禁止借新还旧（本月有到期本息时不新发）。
 */
export function settleGovernmentDebt(
  world: WorldState,
  config: DemoConfig,
  logs: LogEntry[],
): void {
  const tick = world.time.tick;
  const cities = [...world.cities].sort((a, b) => a.id.localeCompare(b.id));
  for (const city of cities) {
    if (!city.government) continue;
    if (city.government.settledTicks.includes(tick)) continue;
    maybeAutoIssueGovernmentBond(world, city, config, tick, logs);
    settleCityGovernmentDebt(world, city, config, logs);
  }
}

/** 单城六阶段顺序结算（供入口调用；也可被测试直接驱动）。 */
export function settleCityGovernmentDebt(
  world: WorldState,
  city: City,
  config: DemoConfig,
  logs: LogEntry[],
): GovernmentSettlementResult {
  const tick = world.time.tick;
  const result = EMPTY_SETTLEMENT(tick, city.id);
  const government = city.government;
  if (!government) {
    result.problems.push(`${city.name} 缺少政府财政状态`);
    return result;
  }
  if (government.settledTicks.includes(tick)) return result;

  // 步骤 15 之后 treasury 不应为负：先以普通政府借款补足到 0（赤字转银行贷款，DECISIONS #31 前置条件）。
  if (city.treasury < -0.005) {
    const deficit = round2(-city.treasury);
    const borrow = borrowForGovernment(world, city, config, deficit, tick, logs);
    if (!borrow.ok) {
      result.problems.push(`${city.name} 赤字 ${deficit} 无法转为政府借款：${borrow.error ?? '未知原因'}`);
    }
  }

  // 认购窗口只限发行当月：结算开始时关闭仍未关闭的批次（未售出不形成债务）。
  for (const issuance of bondsOf(world).issuances) {
    if (issuance.cityId !== city.id) continue;
    if (issuance.status !== 'offering') continue;
    closeGovernmentBondSubscription(world, config, issuance.id, tick);
  }

  // ① 计提应计利息（债券 + 政府贷款），必须在生成应付项与破产判定之前。
  accrueGovernmentDebtInterest(world, city, config, tick);

  // ② 生成并结清应付项：票息 → 到期本金 → 贷款分期。
  const payables = buildGovernmentPayables(world, city, config, tick);
  result.payablesCreated = payables.length;
  const bondPayment = payGovernmentPayables(world, city, config, payables, tick, logs);
  result.payablesPaid = bondPayment.paid;
  result.payablesInArrears = bondPayment.inArrears;
  result.advancedByBank = bondPayment.advanced;

  // ③ 政府银行贷款分期还款（票息/到期兑付之后，不足转欠付、不罚息、不垫付）。
  serviceGovernmentLoans(world, city, config, tick, logs);

  // ④ 债务汇总与破产判定。
  const summary = computeGovernmentDebtSummary(world, city, config, tick);
  result.debtSummary = summary;
  const bankrupt = evaluateGovernmentBankruptcy(city, summary, config);
  if (bankrupt) {
    const record = liquidateBankruptGovernment(world, city, config, summary, tick, logs);
    result.bankrupted = record !== null;
    if (record) result.advancedByBank = round2(result.advancedByBank + record.bankAdvanceCreated);
  }

  // ⑤ 写入结算快照（破产后重算：清算已勾销债务、兑付已清债券）。
  government.lastDebt = computeGovernmentDebtSummary(world, city, config, tick);
  // 破产状态在债务回落到阈值以下时解除（记录保留在 records 中）。
  if (
    government.bankruptcy.status === 'bankrupt' &&
    government.bankruptcy.tick !== null &&
    tick > government.bankruptcy.tick &&
    government.lastDebt.debtRatio < config.government.fiscalRisk.bankruptAt
  ) {
    government.bankruptcy = { status: 'solvent', tick: null, recordId: null, debtRatio: null };
    syncCityBankruptcyMirror(world, city);
    logs.push({
      tick,
      kind: 'government',
      message: `${city.name} 债务/GDP 回落至 ${(government.lastDebt.debtRatio * 100).toFixed(1)}%，解除破产状态（历史记录保留）。`,
    });
  }

  // 每月结算后刷新财政支出基线（供下月 AI 发债按「月支出倍数」计算阈值，DECISIONS v1.5 #42）。
  // 结算末尾 city.lastMonth 已填满本月刚性支出，因此它正是下月要用的「上月财政支出」。
  const monthExpense = lastMonthFiscalExpense(city);
  if (monthExpense > 0) {
    city.fiscalExpenseBaseline = monthExpense;
  } else if (city.fiscalExpenseBaseline === undefined) {
    city.fiscalExpenseBaseline = 0;
  }

  // 应付项保留最近 N 个月；已结算 tick 保留最近 120 个。
  const retention = Math.max(1, config.government.payableRetentionMonths);
  government.payables = government.payables.filter((payable) => payable.tick >= tick - retention);
  government.settledTicks.push(tick);
  if (government.settledTicks.length > 120) {
    government.settledTicks = government.settledTicks.slice(-120);
  }
  return result;
}

/** 上月财政刚性支出合计（供 AI 发债与基线回退；只读）。 */
export function lastMonthFiscalExpense(city: City): number {
  const month = city.lastMonth;
  if (!month) return 0;
  return round2(
    Math.max(0, month.publicWageBill) +
      Math.max(0, month.benefitsPaid) +
      Math.max(0, month.policySpending) +
      Math.max(0, month.transportSpending),
  );
}

/**
 * AI 政府自动发债（DECISIONS v1.5 #42）。触发条件全部满足才发行：
 * - aiGovernment.enabled；
 * - 未破产、无看守期（#31：新发债须等新市长）、本月本城发行次数未超限；
 * - 财政余额 < 上月财政支出 × triggerBelowExpenseMonths，且补足到 topUpToExpenseMonths 倍；
 * - 本月无任何到期债券本息 / 政府贷款分期（禁止借新还旧）；
 * - 发债后债务/GDP 不超过 maxDebtRatioToIssue。
 * 发行、认购、关闭全部走 manual 路径的同一套函数与校验（不另写放行逻辑）。
 */
export function maybeAutoIssueGovernmentBond(
  world: WorldState,
  city: City,
  config: DemoConfig,
  tick: number,
  logs: LogEntry[],
): { issued: boolean; units: number } {
  const ai = config.government.aiGovernment;
  const government = city.government;
  if (!ai.enabled || !government) return { issued: false, units: 0 };
  if (government.bankruptcy.status === 'bankrupt') return { issued: false, units: 0 };
  const latestRecord = government.records[government.records.length - 1];
  if (latestRecord?.caretakerUntilElection) return { issued: false, units: 0 };
  const issuedThisTick = bondsOf(world).issuances.filter(
    (issuance) => issuance.cityId === city.id && issuance.issuedTick === tick,
  ).length;
  if (issuedThisTick >= Math.max(1, ai.maxIssuesPerCityMonth)) return { issued: false, units: 0 };

  const baseline = city.fiscalExpenseBaseline ?? lastMonthFiscalExpense(city);
  if (baseline <= 0) return { issued: false, units: 0 };
  const trigger = round2(baseline * ai.triggerBelowExpenseMonths);
  if (city.treasury >= trigger) return { issued: false, units: 0 };
  // 禁借新还旧：本月已有债券/贷款到期项时不新发。
  if (hasDebtServiceDueThisTick(world, city, config, tick)) return { issued: false, units: 0 };

  const target = round2(baseline * ai.topUpToExpenseMonths);
  let need = round2(Math.max(0, target - city.treasury));
  if (need <= 0) return { issued: false, units: 0 };
  // 债务上限约束：按公共口径计算发债后的债务/GDP 不得超过 maxDebtRatioToIssue。
  const risk = assessCityFiscalRisk(world, city.id, config);
  const debtHeadroom = round2(
    ai.maxDebtRatioToIssue * Math.max(risk.gdpJudgementValue, 1) - risk.totalDebt,
  );
  if (debtHeadroom <= 0) return { issued: false, units: 0 };
  need = Math.min(need, debtHeadroom);

  const market = config.government.bondMarket;
  let units = Math.ceil(need / market.faceValue - 1e-9);
  units = Math.min(units, market.maxPlanUnitsPerIssue);
  if (units <= 0) return { issued: false, units: 0 };

  const issue = issueGovernmentBond(world, city, config, units, tick);
  if (!issue.ok || !issue.issuance) {
    logs.push({
      tick,
      kind: 'warning',
      message: `${city.name} AI 自动发债未获准：${issue.error ?? '未知原因'}。`,
    });
    return { issued: false, units: 0 };
  }
  let sold = 0;
  for (const holder of bondSubscriptionOrder(world, config, issue.issuance.id)) {
    const remaining = issue.issuance.planUnits - issue.issuance.soldUnits;
    if (remaining <= 0) break;
    const subscription = subscribeGovernmentBond(
      world,
      config,
      issue.issuance.id,
      holder,
      remaining,
      tick,
    );
    if (subscription.ok) sold += subscription.units;
  }
  closeGovernmentBondSubscription(world, config, issue.issuance.id, tick);
  if (sold <= 0) {
    logs.push({
      tick,
      kind: 'warning',
      message: `${city.name} AI 自动发债 ${units} 份无人认购，未形成债务。`,
    });
    return { issued: false, units: 0 };
  }
  logs.push({
    tick,
    kind: 'government',
    message: `${city.name} AI 政府为补足财政发行债券 ${units} 份（成交 ${sold} 份，到账 ${round2(
      sold * market.faceValue,
    )}）。`,
  });
  return { issued: true, units: sold };
}

/** 本月是否存在已到期债券本息或政府贷款分期（AI 禁借新还旧的判定）。 */
function hasDebtServiceDueThisTick(
  world: WorldState,
  city: City,
  config: DemoConfig,
  tick: number,
): boolean {
  const ledger = bondsOf(world);
  for (const issuance of ledger.issuances) {
    if (issuance.cityId !== city.id || issuance.status !== 'active') continue;
    if (tick >= issuance.maturityTick) return true;
    const period = issuance.interestPeriodMonths;
    const dueTick = (issuance.lastCouponTick ?? issuance.issuedTick) + period;
    if (issuance.couponsPaid < 3 && tick >= dueTick) return true;
  }
  for (const loan of city.government?.loans ?? []) {
    if (loan.status === 'active' && loan.nextDueTick <= tick) return true;
  }
  void config;
  return false;
}

/**
 * 阶段②：计提本月应计利息（债券 + 政府银行贷款），返回本次计提合计。
 * 必须在破产判定前执行（DECISIONS v1.1 #11：避免利息漏计导致判定晚一拍）。
 * 纯重算（幂等）：同一 tick 重复调用不会重复计提。
 */
export function accrueGovernmentDebtInterest(
  world: WorldState,
  city: City,
  config: DemoConfig,
  tick: number,
): number {
  let total = accrueBondInterest(world, city, config, tick);
  for (const loan of city.government?.loans ?? []) {
    if (loan.status !== 'active') continue;
    const accrual = governmentLoanAccrual(loan, tick);
    loan.accruedInterest = round2(accrual.currentMonthInterest);
    loan.arrearsInterest = round2(Math.max(0, accrual.unpaidInterest - loan.accruedInterest));
    total = round2(total + accrual.currentMonthInterest);
  }
  return total;
}

function payableAnchor(
  tick: number,
  kind: GovernmentPayable['kind'],
  issuanceId: string | null,
  loanId: string | null,
  holder: BondHolder | null,
): string {
  return `${tick}|${kind}|${issuanceId ?? ''}|${loanId ?? ''}|${holder ? holderKey(holder) : ''}`;
}

function isBondDueForCoupon(
  issuance: ReturnType<typeof bondsOf>['issuances'][number],
  tick: number,
): boolean {
  if (issuance.status !== 'active' || issuance.couponsPaid >= 3) return false;
  if (issuance.maturityTick <= tick) return true;
  const dueTick = (issuance.lastCouponTick ?? issuance.issuedTick) + issuance.interestPeriodMonths;
  return tick >= dueTick;
}

/** 阶段①：生成本月应付项（幂等锚：cityId + tick + kind + issuanceId/loanId/holder）。 */
export function buildGovernmentPayables(
  world: WorldState,
  city: City,
  config: DemoConfig,
  tick: number,
): GovernmentPayable[] {
  const government = city.government;
  if (!government) return [];
  const ledger = bondsOf(world);
  const existing = new Set(
    government.payables
      .filter((payable) => payable.status !== 'writtenOff')
      .map((payable) =>
        payableAnchor(payable.tick, payable.kind, payable.issuanceId, payable.loanId, payable.holder),
      ),
  );
  const created: GovernmentPayable[] = [];

  const makePayable = (
    kind: GovernmentPayable['kind'],
    issuanceId: string | null,
    loanId: string | null,
    holder: BondHolder | null,
    principalDue: number,
    interestDue: number,
    note: string,
  ): void => {
    const anchor = payableAnchor(tick, kind, issuanceId, loanId, holder);
    if (existing.has(anchor)) return;
    existing.add(anchor);
    const payable: GovernmentPayable = {
      id: `govpayable-${city.id}-${government.nextPayableNumber}`,
      cityId: city.id,
      tick,
      kind,
      issuanceId,
      loanId,
      holder,
      principalDue: round2(Math.max(0, principalDue)),
      interestDue: round2(Math.max(0, interestDue)),
      status: 'pending',
      paidTick: null,
      paymentId: null,
      note,
    };
    government.nextPayableNumber += 1;
    government.payables.push(payable);
    created.push(payable);
  };

  for (const issuance of ledger.issuances) {
    if (issuance.cityId !== city.id || issuance.status !== 'active') continue;
    const holdings = ledger.holdings
      .filter((holding) => holding.issuanceId === issuance.id && holding.status === 'active')
      .sort((a, b) => holderKey(a.holder).localeCompare(holderKey(b.holder)));
    const couponDue = isBondDueForCoupon(issuance, tick);
    const principalDue = tick >= issuance.maturityTick;
    for (const holding of holdings) {
      if (couponDue) {
        makePayable(
          'bondCoupon',
          issuance.id,
          null,
          holding.holder,
          0,
          holding.accruedInterest,
          `第 ${issuance.couponsPaid + 1}/3 期票息`,
        );
      }
      if (principalDue) {
        makePayable(
          'bondPrincipal',
          issuance.id,
          null,
          holding.holder,
          holding.principal,
          holding.accruedInterest,
          '到期本金（含未付利息）',
        );
      }
    }
  }

  for (const loan of government.loans) {
    if (loan.status !== 'active' || loan.nextDueTick > tick) continue;
    makePayable(
      'loanInstalment',
      null,
      loan.id,
      null,
      Math.min(loan.monthlyPrincipal, loan.outstanding),
      loan.accruedInterest,
      '政府贷款分期',
    );
  }

  void config;
  return created;
}

/**
 * 阶段③④：按“票息 → 到期本息 → 贷款分期”顺序结清应付项；不足部分转欠付或银行垫付。
 * 债券兑付仍由 bonds.ts 的权威实现完成（保证每笔债权只付一次），这里负责应付项状态与统计。
 */
export function payGovernmentPayables(
  world: WorldState,
  city: City,
  config: DemoConfig,
  payables: GovernmentPayable[],
  tick: number,
  logs: LogEntry[],
): { paid: number; inArrears: number; advanced: number } {
  const government = city.government;
  if (!government) return { paid: 0, inArrears: 0, advanced: 0 };
  const ledger = bondsOf(world);
  const pending = payables
    .filter((payable) => payable.status === 'pending' && payable.tick === tick)
    .sort(
      (a, b) =>
        kindRank(a.kind) - kindRank(b.kind) ||
        (a.issuanceId ?? a.loanId ?? '').localeCompare(b.issuanceId ?? b.loanId ?? '') ||
        (a.holder ? holderKey(a.holder) : '').localeCompare(b.holder ? holderKey(b.holder) : ''),
    );
  let paid = 0;
  let inArrears = 0;
  let advanced = 0;

  const couponIssuances = new Set<string>();
  const principalIssuances = new Set<string>();
  for (const payable of pending) {
    if (payable.kind === 'bondCoupon' && payable.issuanceId) {
      couponIssuances.add(payable.issuanceId);
    } else if (payable.kind === 'bondPrincipal' && payable.issuanceId) {
      principalIssuances.add(payable.issuanceId);
    }
  }

  for (const issuanceId of [...couponIssuances].sort()) {
    const redemption = payBondCoupon(world, city, config, issuanceId, tick, logs);
    if (!redemption.ok) {
      logs.push({
        tick,
        kind: 'warning',
        message: `${city.name} 债券 ${issuanceId} 票息支付失败：${redemption.error ?? '未知原因'}。`,
      });
      continue;
    }
    paid = round2(paid + redemption.payments.length);
    advanced = round2(advanced + redemption.advancedByBank);
  }
  for (const issuanceId of [...principalIssuances].sort()) {
    const redemption = settleBondMaturity(world, city, config, issuanceId, tick, logs);
    if (!redemption.ok) {
      logs.push({
        tick,
        kind: 'warning',
        message: `${city.name} 债券 ${issuanceId} 到期兑付失败：${redemption.error ?? '未知原因'}。`,
      });
      continue;
    }
    paid = round2(paid + redemption.payments.length);
    advanced = round2(advanced + redemption.advancedByBank);
  }

  // 回填应付项状态：票息按持债剩余欠息判 paid/arrears；到期本金按是否银行垫付判 paidByAdvance。
  for (const payable of pending) {
    if (payable.kind === 'bondCoupon' && payable.issuanceId && payable.holder) {
      const holding = ledger.holdings.find(
        (entry) =>
          entry.issuanceId === payable.issuanceId && holderKey(entry.holder) === holderKey(payable.holder!),
      );
      payable.paidTick = tick;
      if (!holding || holding.accruedInterest <= 0.005) {
        payable.status = 'paid';
        paid += 1;
      } else {
        payable.status = 'arrears';
        inArrears += 1;
      }
    } else if (payable.kind === 'bondPrincipal' && payable.issuanceId && payable.holder) {
      const fundedByAdvance = ledger.payments.some(
        (payment) =>
          payment.issuanceId === payable.issuanceId &&
          payment.kind === 'principal' &&
          payment.tick === tick &&
          holderKey(payment.holder) === holderKey(payable.holder!) &&
          payment.fundedByBankAdvance,
      );
      payable.paidTick = tick;
      payable.status = fundedByAdvance ? 'paidByAdvance' : 'paid';
      if (fundedByAdvance) {
        payable.note = `${payable.note}（银行垫付）`;
      }
      paid += 1;
    }
  }
  return { paid, inArrears, advanced };
}

function kindRank(kind: GovernmentPayable['kind']): number {
  if (kind === 'bondCoupon') return 0;
  if (kind === 'bondPrincipal') return 1;
  return 2;
}

/**
 * 政府财政不足时由银行无条件垫付，形成 GovernmentLoanContract(purpose='bondAdvance')。
 * 不适用普通授信限制；必须写 GovernmentAdvanceRecord 以逐笔可追溯。
 */
export function applyBankAdvance(
  world: WorldState,
  city: City,
  config: DemoConfig,
  input: {
    tick: number;
    issuanceId: string;
    payableIds: string[];
    principal: number;
    interest: number;
    purpose: 'maturity' | 'bankruptcy';
  },
): GovernmentAdvanceResult {
  const principal = round2(Math.max(0, input.principal));
  const interest = round2(Math.max(0, input.interest));
  const total = round2(principal + interest);
  const government = city.government;
  if (!government) {
    return {
      ok: false,
      advance: null,
      loan: null,
      amountAdvanced: 0,
      error: `${city.name} 缺少政府财政状态`,
    };
  }
  if (!Number.isFinite(total) || total <= 0.005) {
    return { ok: true, advance: null, loan: null, amountAdvanced: 0 };
  }

  const advanceConfig = config.government.advance;
  const loanNumber = government.nextLoanNumber;
  government.nextLoanNumber += 1;
  const loan: GovernmentLoanContract = {
    id: `govloan-${city.id}-${loanNumber}`,
    cityId: city.id,
    purpose: 'bondAdvance',
    // 垫付金额（本金 + 欠息）整体资本化为贷款本金，后续按 advance 口径等额本金偿还。
    principal: total,
    outstanding: total,
    monthlyPrincipal: round2(total / Math.max(1, advanceConfig.termMonths)),
    rateMonthly: advanceConfig.rateMonthly,
    termMonths: advanceConfig.termMonths,
    startTick: input.tick,
    nextDueTick: input.tick + 1,
    paidPrincipal: 0,
    paidInterest: 0,
    accruedInterest: 0,
    arrearsPrincipal: 0,
    arrearsInterest: 0,
    missedPayments: 0,
    status: 'active',
    payments: [],
    bondIssuanceId: input.issuanceId,
    note: `【暂定】${input.purpose === 'bankruptcy' ? '破产' : '到期'}兑付银行无条件垫付转借款（本金 ${principal} + 利息 ${interest}）`,
  };
  government.loans.push(loan);

  const advanceNumber = government.nextAdvanceNumber;
  government.nextAdvanceNumber += 1;
  const advance: GovernmentAdvanceRecord = {
    id: `govadvance-${city.id}-${advanceNumber}`,
    cityId: city.id,
    tick: input.tick,
    issuanceId: input.issuanceId,
    purpose: input.purpose,
    payableIds: [...input.payableIds],
    principalAdvanced: principal,
    interestAdvanced: interest,
    totalAdvanced: total,
    loanId: loan.id,
    note: '银行垫付逐笔可追溯；垫付贷款未偿已计入政府债务，本流水不重复计入。',
  };
  government.advances.push(advance);

  // 批次上的累计垫付（唯一记账点，避免调用方重复累加）。
  const issuance = world.bonds?.issuances.find((entry) => entry.id === input.issuanceId);
  if (issuance) {
    issuance.bankAdvancedAmount = round2(issuance.bankAdvancedAmount + total);
  }

  return { ok: true, advance, loan, amountAdvanced: total };
}

/** 政府银行借款（普通借款；不包括垫付转借款，后者由 applyBankAdvance 创建）。 */
export function borrowForGovernment(
  world: WorldState,
  city: City,
  config: DemoConfig,
  amount: number,
  tick: number,
  logs: LogEntry[],
): { ok: boolean; loan: GovernmentLoanContract | null; error?: string } {
  const government = city.government;
  if (!government) return { ok: false, loan: null, error: `${city.name} 缺少政府财政状态` };
  if (!Number.isFinite(amount) || amount <= 0.005) {
    return { ok: false, loan: null, error: '借款金额必须为正' };
  }
  const loanConfig = config.government.loan;
  const borrowed = round2(Math.max(amount, loanConfig.minAmount));
  const loanNumber = government.nextLoanNumber;
  government.nextLoanNumber += 1;
  const loan: GovernmentLoanContract = {
    id: `govloan-${city.id}-${loanNumber}`,
    cityId: city.id,
    purpose: 'government',
    principal: borrowed,
    outstanding: borrowed,
    monthlyPrincipal: round2(borrowed / Math.max(1, loanConfig.termMonths)),
    rateMonthly: loanConfig.rateMonthly,
    termMonths: loanConfig.termMonths,
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
    bondIssuanceId: null,
    note: `【暂定】政府向银行借款 ${borrowed}（等额本金 ${loanConfig.termMonths} 个月）`,
  };
  government.loans.push(loan);
  receiveTreasury(
    world,
    city,
    borrowed,
    'governmentLoanProceeds',
    `${city.name} 政府银行借款`,
    {},
    config,
  );
  logs.push({
    tick,
    kind: 'government',
    message: `${city.name} 政府向银行借款 ${borrowed}（${loanConfig.termMonths} 个月，月息 ${(
      loanConfig.rateMonthly * 100
    ).toFixed(2)}%）。`,
  });
  return { ok: true, loan };
}

/** 服务政府银行贷款：到期分期还款与利息支付（财政不足时记欠付）。 */
export function serviceGovernmentLoans(
  world: WorldState,
  city: City,
  config: DemoConfig,
  tick: number,
  logs: LogEntry[],
): { repaid: number; interestPaid: number; inArrears: number } {
  const government = city.government;
  if (!government) return { repaid: 0, interestPaid: 0, inArrears: 0 };
  let repaid = 0;
  let interestPaid = 0;
  let inArrears = 0;
  for (const loan of [...government.loans].sort((a, b) => a.id.localeCompare(b.id))) {
    if (loan.status !== 'active' || loan.nextDueTick > tick) continue;
    // 计息（与 accrueGovernmentDebtInterest 同源，重复调用同 tick 结果一致）。
    const accrual = governmentLoanAccrual(loan, tick);
    loan.accruedInterest = round2(accrual.currentMonthInterest);
    loan.arrearsInterest = round2(Math.max(0, accrual.unpaidInterest - loan.accruedInterest));

    const interestDue = loan.accruedInterest;
    const paidInterest = spendTreasury(
      world,
      city,
      interestDue,
      'governmentLoanInterest',
      `${city.name} 政府贷款利息`,
      {},
      config,
    );
    interestPaid = round2(interestPaid + paidInterest);
    loan.paidInterest = round2(loan.paidInterest + paidInterest);
    loan.accruedInterest = round2(Math.max(0, loan.accruedInterest - paidInterest));
    if (loan.accruedInterest > 0.005) {
      loan.arrearsInterest = round2(loan.arrearsInterest + loan.accruedInterest);
      loan.accruedInterest = 0;
    }
    // 有余力时补缴历史欠息（不罚息，只记欠付）。
    if (loan.arrearsInterest > 0.005) {
      const arrearsPaid = spendTreasury(
        world,
        city,
        loan.arrearsInterest,
        'governmentLoanInterest',
        `${city.name} 政府贷款欠付利息`,
        {},
        config,
      );
      interestPaid = round2(interestPaid + arrearsPaid);
      loan.paidInterest = round2(loan.paidInterest + arrearsPaid);
      loan.arrearsInterest = round2(Math.max(0, loan.arrearsInterest - arrearsPaid));
    }

    const principalDue = round2(Math.min(loan.monthlyPrincipal, loan.outstanding));
    const principalPaid = spendTreasury(
      world,
      city,
      principalDue,
      'governmentLoanRepayment',
      `${city.name} 政府贷款本金`,
      {},
      config,
    );
    repaid = round2(repaid + principalPaid);
    loan.paidPrincipal = round2(loan.paidPrincipal + principalPaid);
    loan.outstanding = round2(Math.max(0, loan.outstanding - principalPaid));
    const shortfall = round2(Math.max(0, principalDue - principalPaid));
    if (shortfall > 0.005) {
      loan.arrearsPrincipal = round2(loan.arrearsPrincipal + shortfall);
      loan.missedPayments += 1;
      inArrears = round2(inArrears + shortfall);
    } else {
      loan.missedPayments = 0;
    }

    const payment: LoanPayment = {
      tick,
      principalDue,
      interestDue,
      principalPaid,
      interestPaid: paidInterest,
      arrears: round2(shortfall + (interestDue - paidInterest)),
      note: shortfall > 0.005 ? '财政不足，未付部分转欠付（不再罚息）' : '按期还款',
    };
    loan.payments.push(payment);
    loan.nextDueTick += 1;
    if (loan.outstanding <= 0.005) {
      loan.outstanding = 0;
      loan.status = 'repaid';
    }

    // 回填本月应付项状态（若本月生成了贷款分期应付项）。
    for (const payable of government.payables) {
      if (payable.kind !== 'loanInstalment' || payable.loanId !== loan.id) continue;
      if (payable.tick !== tick || payable.status !== 'pending') continue;
      payable.paidTick = tick;
      if (loan.arrearsPrincipal > 0.005 || loan.arrearsInterest > 0.005) {
        payable.status = 'arrears';
      } else {
        payable.status = 'paid';
      }
    }
  }
  void logs;
  return { repaid, interestPaid, inArrears };
}

/**
 * 阶段⑤：债务汇总（五段分子 + 分母 + 分级 + 趋势）。
 * totalDebt 口径见文件头；previousSettlementDebtRatio 取上一结算月 lastDebt.debtRatio。
 */
export function computeGovernmentDebtSummary(
  world: WorldState,
  city: City,
  config: DemoConfig,
  tick: number,
): GovernmentDebtSummary {
  void cityDebt;
  const summary = assessCityFiscalRisk(world, city.id, config);
  // 分级/趋势复用 metrics（唯一口径）；debtRatio 保留更高精度，供不变量与判定使用
  // （metrics 版本按 0.01 舍入，小比率时与 totalDebt/分母 的差异会超过不变量容差）。
  const rawRatio = summary.totalDebt / Math.max(summary.gdpJudgementValue, 0.0001);
  summary.debtRatio = Math.round(rawRatio * 1_000_000) / 1_000_000;
  const risk = config.government.fiscalRisk;
  summary.riskLevel =
    summary.debtRatio >= risk.bankruptAt
      ? 'bankrupt'
      : summary.debtRatio >= risk.watchBelow
        ? 'high'
        : summary.debtRatio >= risk.normalBelow
          ? 'watch'
          : 'normal';
  return { ...summary, tick };
}

/** 阶段⑤：破产判定（债务/GDP ≥ bankruptAt；分母取 max(minAnnualGdp, 12 月 GDP 合计)）。 */
export function evaluateGovernmentBankruptcy(
  city: City,
  summary: GovernmentDebtSummary,
  config: DemoConfig,
): boolean {
  void city;
  if (!Number.isFinite(summary.debtRatio)) return false;
  if (summary.totalDebt <= 0.005) return false;
  return summary.debtRatio >= config.government.fiscalRisk.bankruptAt;
}

/**
 * 阶段⑥：破产清算。银行兑付未到期债券本金 + 实际持有月份已计提未付利息（不付未来利息），
 * 随后原有银行贷款与垫付形成的贷款一并勾销；不存在按比例清偿。写 GovernmentBankruptcyRecord。
 * 幂等：同一城市同一 tick 只允许一条记录。
 */
export function liquidateBankruptGovernment(
  world: WorldState,
  city: City,
  config: DemoConfig,
  summary: GovernmentDebtSummary,
  tick: number,
  logs: LogEntry[],
): GovernmentBankruptcyRecord | null {
  const government = city.government;
  if (!government) return null;
  const existing = government.records.find((record) => record.tick === tick);
  if (existing) return existing;

  // 1. 银行兑付未到期债券：本金 + 实际持有月份已计提未付利息（不付未来利息）。
  const redemption = settleBondBankruptcyRedemption(world, city, config, tick, logs);

  // 2. 勾销政府全部银行贷款（普通 + 垫付，含本次破产兑付形成的垫付贷款）。
  let bankLoansWrittenOff = 0;
  let advancesWrittenOff = 0;
  let interestWrittenOff = 0;
  for (const loan of government.loans) {
    if (loan.status !== 'active') continue;
    interestWrittenOff = round2(
      interestWrittenOff + loan.accruedInterest + loan.arrearsInterest,
    );
    if (loan.purpose === 'bondAdvance') {
      advancesWrittenOff = round2(advancesWrittenOff + loan.outstanding);
    } else {
      bankLoansWrittenOff = round2(bankLoansWrittenOff + loan.outstanding);
    }
    // 不变量口径（invariants.ts:935-943）把 writtenOff 贷款也计入未偿合计，并要求
    // outstanding = principal − paidPrincipal；因此勾销实现为「全额核销」：outstanding 清零、
    // paidPrincipal 记为等于本金（真实去向见 bankruptcy record 与 note，银行不倒闭、不追偿）。
    loan.accruedInterest = 0;
    loan.arrearsInterest = 0;
    loan.outstanding = 0;
    loan.paidPrincipal = loan.principal;
    loan.status = 'writtenOff';
    loan.note = `${loan.note}；破产清算银行核销本金 ${loan.principal}`;
  }
  // 未结清应付项一并核销（银行债务勾销后不再支付）。
  for (const payable of government.payables) {
    if (payable.status === 'pending' || payable.status === 'arrears') {
      payable.status = 'writtenOff';
      payable.note = `${payable.note}（破产清算核销）`;
    }
  }

  const record: GovernmentBankruptcyRecord = {
    id: `govbankrupt-${city.id}-${tick}`,
    cityId: city.id,
    tick,
    totalDebtAtJudgement: summary.totalDebt,
    gdpJudgementValue: summary.gdpJudgementValue,
    debtRatio: summary.debtRatio,
    bondsRedeemedPrincipal: redemption.principalPaid,
    bondsRedeemedInterest: redemption.interestPaid,
    bondRedemptionCount: redemption.payments.length,
    bankAdvanceCreated: redemption.advancedByBank,
    bankLoansWrittenOff,
    advancesWrittenOff,
    interestWrittenOff,
    electionTriggeredTick: null,
    caretakerUntilElection: false,
    note: `【暂定】债务/GDP ${(summary.debtRatio * 100).toFixed(1)}% ≥ 100%，银行兑付债券后勾销全部银行贷款。`,
  };

  // 3. 破产政府股份转移（CEO → 股东主体平分 → 无股东托管）。
  const shares = distributeBankruptGovernmentShares(world, city, config);
  record.note = `${record.note} 股份转移：${shares.distributedHolders} 个主体${shares.custody ? '，无股东部分进入无表决权托管' : ''}。`;

  // 4. 判定当月立即重选；未成功则进入看守期（只维持性操作，等待重选）。
  government.bankruptcy = {
    status: 'bankrupt',
    tick,
    recordId: record.id,
    debtRatio: summary.debtRatio,
  };
  syncCityBankruptcyMirror(world, city);
  if (config.government.bankruptcy.triggerElectionSameTick) {
    const election = requestImmediateElection(world, city.id, config, logs);
    if (election.ok) {
      record.electionTriggeredTick = tick;
      record.caretakerUntilElection = false;
    } else {
      record.caretakerUntilElection = true;
      record.note = `${record.note} 立即重选失败：${election.error ?? '未知原因'}。`;
    }
  } else {
    record.caretakerUntilElection = true;
  }

  government.records.push(record);
  const maxRecords = Math.max(1, config.government.maxBankruptcyRecords);
  if (government.records.length > maxRecords) {
    government.records = government.records.slice(-maxRecords);
  }

  logs.push({
    tick,
    kind: 'warning',
    message: `${city.name} 政府破产：债务 ${summary.totalDebt} / 判定 GDP ${summary.gdpJudgementValue} = ${(
      summary.debtRatio * 100
    ).toFixed(1)}%；银行兑付债券本金 ${redemption.principalPaid}、利息 ${redemption.interestPaid}，勾销贷款 ${round2(
      bankLoansWrittenOff + advancesWrittenOff,
    )}。`,
  });
  return record;
}

/** 破产状态镜像到 city.bankruptcy（同值，界面读取入口之一）。 */
function syncCityBankruptcyMirror(world: WorldState, city: City): void {
  void world;
  const state = city.government?.bankruptcy;
  if (!state) return;
  city.bankruptcy = {
    status: state.status,
    tick: state.tick,
    recordId: state.recordId,
    debtRatio: state.debtRatio,
  };
}

/**
 * 破产政府持股处理：无 CEO 时，在除破产政府外的现有股东之间按股东主体数量平均分配；
 * 无股东时进入 'trust' 无表决权托管持股（不得销毁、不得转给公司、不得增发）。
 *
 * 实现口径（按股份类别分别处理，保证类别发行总量不变）：
 * - CEO = `governance.controls` 中非 'management' 且不是企业自身的 operator/持有人 → 全部转给该 CEO；
 * - 否则在该类别现有股东主体间平分（floor 到 0.01 股，余数按 holderKey 升序 +0.01）；
 * - 该类别无其他股东 → 转给 `{type:'trust', id:'trust-{companyId}'}` 托管。
 * 不变量：类别 issuedShares 不变、Σ持股 = issuedShares。
 */
export function distributeBankruptGovernmentShares(
  world: WorldState,
  city: City,
  config: DemoConfig,
): { distributedHolders: number; custody: boolean } {
  void config;
  let distributedHolders = 0;
  let custody = false;
  const tick = world.time.tick;

  const companies = [...world.companies].sort((a, b) => a.id.localeCompare(b.id));
  for (const company of companies) {
    for (const shareClass of classesOfCompany(world, company.id)) {
      const cityHoldings = world.securities.holdings.filter(
        (holding) =>
          holding.shareClassId === shareClass.id &&
          holding.shares > 0 &&
          holding.holder.type === 'city' &&
          holding.holder.id === city.id,
      );
      if (cityHoldings.length === 0) continue;
      const totalShares = round2(cityHoldings.reduce((sum, holding) => sum + holding.shares, 0));
      if (totalShares <= 0.005) continue;

      // 目标持有人：优先现任 CEO；否则该类别其他股东主体；否则托管。
      const control = world.governance?.controls.find((entry) => entry.companyId === company.id);
      const ceo =
        control && control.operator !== 'management' && control.operator.type !== 'company'
          ? control.operator
          : null;

      let targets: { holder: HolderRef; shares: number }[] = [];
      if (ceo) {
        targets = [{ holder: ceo, shares: totalShares }];
      } else {
        const others = new Map<string, { holder: HolderRef; shares: number }>();
        for (const holding of world.securities.holdings) {
          if (holding.shareClassId !== shareClass.id || holding.shares <= 0) continue;
          if (holding.holder.type === 'city' && holding.holder.id === city.id) continue;
          const key = `${holding.holder.type}:${holding.holder.id}`;
          const entry = others.get(key) ?? { holder: holding.holder, shares: 0 };
          entry.shares = round2(entry.shares + holding.shares);
          others.set(key, entry);
        }
        const holderList = [...others.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([, entry]) => entry);
        if (holderList.length === 0) {
          custody = true;
          targets = [{ holder: { type: 'trust', id: `trust-${company.id}` }, shares: totalShares }];
        } else {
          const cents = Math.round(totalShares * 100);
          const each = Math.floor(cents / holderList.length);
          let remainder = cents - each * holderList.length;
          targets = holderList.map((entry) => {
            const bonus = remainder > 0 ? 1 : 0;
            if (remainder > 0) remainder -= 1;
            return { holder: entry.holder, shares: round2((each + bonus) / 100) };
          });
        }
      }

      // 从政府持股转出（逐笔），再按目标持股入账。
      let remaining = totalShares;
      for (const holding of cityHoldings) {
        const moved = round2(Math.min(holding.shares, remaining));
        if (moved <= 0) continue;
        removeShares(world, shareClass.id, { type: 'city', id: city.id }, moved);
        remaining = round2(remaining - moved);
      }
      if (remaining > 0.005) {
        // 理论上不会发生；兜底直接扣减（避免残留政府持股）。
        removeShares(world, shareClass.id, { type: 'city', id: city.id }, remaining);
      }
      for (const target of targets) {
        if (target.shares <= 0.005) continue;
        addShares(world, {
          companyId: company.id,
          shareClassId: shareClass.id,
          holder: target.holder,
          shares: target.shares,
          acquiredVia: 'secondary',
          tick,
        });
        distributedHolders += 1;
      }
    }
  }
  syncAllCompanyShares(world);
  return { distributedHolders, custody };
}
