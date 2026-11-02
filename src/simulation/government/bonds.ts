/**
 * 政府债券（v0.7 契约实现，块1）。
 *
 * 契约口径（DECISIONS v1 #4/#5、v1.2 #19/#21、v1.3 #23、v1.4 #33/#34）：
 * - 面额 faceValue 信用点/份，整数份；发行计划（planUnits）与实际成交（soldUnits）分开；
 *   只有成交份数形成本金 principal = soldUnits × faceValue，未售出不形成债务。
 * - 认购主体：玩家、居民投资实体、企业（可跨城）；银行不得认购国债。
 * - 只用现有可支配资金，禁止贷款购债、禁止认购时自动申请贷款。
 * - 认购窗口：发行当月一次撮合，不跨月续售；未售出份数关闭时记 unsoldUnits，不形成债务。
 * - 票息：固定 3 期，M12 / M24 / M36 各支付一次；M12/M24 财政不足时银行不垫付，记欠付利息；
 *   M36 同月付第 3 期票息 + 本金 + 全部欠息，财政不足部分由银行无条件垫付（bondAdvance 贷款）。
 * - 到期与破产兑付每笔债权只付一次：以批次 status='redeemed' 与持债 status='redeemed' 判重。
 *
 * 计息采用"自计息起点起按月重算"的幂等方式（accrued = principal × 票息 × 已过月数 − 已付利息），
 * 同一 tick 重复调用不会重复计提；计息明细 BondHolding.accruedInterest 是权威，
 * BondIssuance.accruedInterest 只是对账汇总（不变量要求二者一致）。
 */
import type {
  BondHolder,
  BondHolding,
  BondIssuance,
  BondPayment,
  City,
  LogEntry,
  WorldState,
} from '../contracts/types';
import type { DemoConfig } from '../../data/config';
import { round2 } from '../core/math';
import { bankLoansOf, debitOwnerCash, ownerCash, ownerKey, sameOwner } from '../banking/credit';
import { receiveTreasury, spendTreasury } from './treasury';
import { applyBankAdvance } from './debt';

export interface BondResult {
  ok: boolean;
  error?: string;
}

export interface BondIssueResult extends BondResult {
  issuance?: BondIssuance;
}

export interface BondSubscriptionResult extends BondResult {
  units: number;
  principal: number;
  holding?: BondHolding;
}

export interface BondRedemptionResult extends BondResult {
  payments: BondPayment[];
  principalPaid: number;
  interestPaid: number;
  advancedByBank: number;
}

type BondLedger = NonNullable<WorldState['bonds']>;

const EMPTY_REDEMPTION = (): BondRedemptionResult => ({
  ok: true,
  payments: [],
  principalPaid: 0,
  interestPaid: 0,
  advancedByBank: 0,
});

/** 债券账本（缺失时视为空账本；首次写入时补齐，迁移后必定存在）。 */
export function bondsOf(world: WorldState): {
  issuances: BondIssuance[];
  holdings: BondHolding[];
  payments: BondPayment[];
} {
  const bonds = world.bonds;
  return {
    issuances: bonds?.issuances ?? [],
    holdings: bonds?.holdings ?? [],
    payments: bonds?.payments ?? [],
  };
}

function bondsLedger(world: WorldState): BondLedger {
  if (!world.bonds) {
    world.bonds = {
      issuances: [],
      holdings: [],
      payments: [],
      nextIssuanceNumber: 1,
      nextHoldingNumber: 1,
      nextPaymentNumber: 1,
    };
  }
  return world.bonds;
}

function bondHolderKey(holder: BondHolder): string {
  return ownerKey(holder);
}

function holderExists(world: WorldState, holder: BondHolder): boolean {
  if (holder.kind === 'player') return true;
  if (holder.kind === 'investorGroup') {
    return world.investors.some((group) => group.id === holder.id);
  }
  if (holder.kind === 'company') {
    return world.companies.some((company) => company.id === holder.id);
  }
  return false;
}

function holderLabel(world: WorldState, holder: BondHolder): string {
  if (holder.kind === 'player') return `玩家 · ${world.player.name}`;
  if (holder.kind === 'investorGroup') {
    const group = world.investors.find((entry) => entry.id === holder.id);
    return group ? `居民投资实体 · ${group.name}` : `居民投资实体 · ${holder.id}`;
  }
  const company = world.companies.find((entry) => entry.id === holder.id);
  return company ? `企业 · ${company.name}` : `企业 · ${holder.id}`;
}

/** 企业上月应付利息（用于购债流动性保留口径 #23：按银行贷款未偿本金估算当月应付利息）。 */
function companyMonthlyInterestDue(world: WorldState, companyId: string): number {
  let interest = 0;
  for (const loan of bankLoansOf(world)) {
    if (loan.status !== 'active') continue;
    if (!sameOwner(loan.borrower, { kind: 'company', id: companyId })) continue;
    interest += loan.outstanding * loan.rateMonthly;
  }
  return round2(interest);
}

/**
 * 企业是否被禁止认购国债（DECISIONS v1.4 #34）：
 * 存在未结清违约贷款，或最近一月仍有欠薪。返回禁止原因，null 表示允许。
 */
export function companySubscriptionBlockReason(
  world: WorldState,
  companyId: string,
): string | null {
  const company = world.companies.find((entry) => entry.id === companyId);
  if (!company) return '企业不存在';
  const hasDefaultedLoan = bankLoansOf(world).some(
    (loan) =>
      loan.status === 'defaulted' &&
      sameOwner(loan.borrower, { kind: 'company', id: companyId }),
  );
  if (hasDefaultedLoan) return '该企业存在未结清违约贷款，禁止认购国债';
  const wageArrears = company.lastMonth.wageArrears ?? 0;
  if (wageArrears > 0.005) return '该企业上月存在欠薪，禁止认购国债';
  return null;
}

/**
 * 债券持有人的真实可用现金（用于认购上限）：
 * 玩家=现金；居民投资实体=现金；企业=现金 − 上月实发工资×wageMonths − 上月应付利息×interestMonths
 * （#23/#37 流动性保留，剩余零钱保留、不强制凑整）。
 * 被禁止认购的企业返回 0；任何主体都不会因认购触发贷款。
 */
export function bondHolderAvailableCash(
  world: WorldState,
  config: DemoConfig,
  holder: BondHolder,
): number {
  if (!holderExists(world, holder)) return 0;
  if (holder.kind !== 'company') {
    return round2(Math.max(0, ownerCash(world, holder)));
  }
  if (companySubscriptionBlockReason(world, holder.id) !== null) return 0;
  const company = world.companies.find((entry) => entry.id === holder.id);
  if (!company) return 0;
  const reserve = config.government.companyPurchaseReserve;
  const wages =
    company.previousMonth.wagesPaid > 0
      ? company.previousMonth.wagesPaid
      : company.lastMonth.wagesPaid;
  const interestBase =
    company.previousMonth.interestPaid > 0
      ? company.previousMonth.interestPaid
      : companyMonthlyInterestDue(world, company.id);
  const reserved = round2(wages * reserve.wageMonths + interestBase * reserve.interestMonths);
  return round2(Math.max(0, company.cash - reserved));
}

/** 确定性认购顺序：config.government.bondMarket.subscriptionOrder 展开为具体持有人。 */
export function bondSubscriptionOrder(
  world: WorldState,
  config: DemoConfig,
  issuanceId: string,
): BondHolder[] {
  // issuanceId 保留在签名中（契约冻结），首版顺序与批次无关；未知批次仍返回配置顺序。
  void issuanceId;
  const order = config.government.bondMarket.subscriptionOrder;
  const result: BondHolder[] = [];
  for (const kind of order) {
    if (kind === 'player') {
      result.push({ kind: 'player', id: 'player' });
    } else if (kind === 'investorGroup') {
      const groups = [...world.investors]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((group) => ({ kind: 'investorGroup' as const, id: group.id }));
      result.push(...groups);
    } else if (kind === 'company') {
      const companies = [...world.companies]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((company) => ({ kind: 'company' as const, id: company.id }));
      result.push(...companies);
    }
  }
  // 银行不得认购（config.allowBankSubscription=false 为首版冻结口径，且 BondHolder 不含 bank）。
  return result;
}

/**
 * 发起一次债券发行计划（planUnits 份）。
 * 约束：planUnits 为正整数且 ≤ maxPlanUnitsPerIssue；同一城市同一 tick 只能一期；
 * 距上次发行不足 minMonthsBetweenIssues 时拒绝。
 */
export function issueGovernmentBond(
  world: WorldState,
  city: City,
  config: DemoConfig,
  planUnits: number,
  tick: number,
): BondIssueResult {
  if (!Number.isInteger(planUnits) || planUnits <= 0) {
    return { ok: false, error: '发行份数必须是正整数' };
  }
  const market = config.government.bondMarket;
  if (planUnits > market.maxPlanUnitsPerIssue) {
    return {
      ok: false,
      error: `发行份数 ${planUnits} 超过单次上限 ${market.maxPlanUnitsPerIssue}`,
    };
  }
  if (!city.government) {
    return { ok: false, error: `${city.name} 缺少政府财政状态` };
  }
  const ledger = bondsLedger(world);
  const previous = ledger.issuances
    .filter((issuance) => issuance.cityId === city.id)
    .sort((a, b) => b.issuedTick - a.issuedTick)[0];
  if (previous) {
    if (previous.issuedTick === tick) {
      return { ok: false, error: '同一城市同一 tick 只能发行一期债券' };
    }
    if (tick - previous.issuedTick < market.minMonthsBetweenIssues) {
      return {
        ok: false,
        error: `距上次发行不足 ${market.minMonthsBetweenIssues} 个月，暂不能再次发行`,
      };
    }
  }

  const number = ledger.nextIssuanceNumber;
  ledger.nextIssuanceNumber += 1;
  const issuance: BondIssuance = {
    id: `bond-${city.id}-${number}`,
    cityId: city.id,
    issuedTick: tick,
    closedTick: null,
    faceValue: market.faceValue,
    couponRateAnnual: market.couponRateAnnual,
    interestPeriodMonths: market.interestPeriodMonths,
    termMonths: market.termMonths,
    planUnits,
    soldUnits: 0,
    unsoldUnits: planUnits,
    principal: 0,
    maturityTick: tick + market.termMonths,
    status: 'offering',
    lastCouponTick: null,
    arrearsInterest: 0,
    accruedInterest: 0,
    interestPaid: 0,
    couponsPaid: 0,
    principalRepaid: 0,
    bankAdvancedAmount: 0,
    redeemedTick: null,
    redemptionReason: null,
    note: `【暂定】${city.name} 发行 ${planUnits} 份政府债券（面额 ${market.faceValue}，年息 ${(
      market.couponRateAnnual * 100
    ).toFixed(1)}%，期限 ${market.termMonths} 个月）`,
  };
  ledger.issuances.push(issuance);
  return { ok: true, issuance };
}

/**
 * 某持有人对某批次的认购（整数份，按真实可用资金扣款）。
 * 超过剩余可售份数或资金不足时按**可成交份数**部分成交；0 份则不产生持债记录、不扣款。
 */
export function subscribeGovernmentBond(
  world: WorldState,
  config: DemoConfig,
  issuanceId: string,
  holder: BondHolder,
  requestedUnits: number,
  tick: number,
): BondSubscriptionResult {
  if (!Number.isInteger(requestedUnits) || requestedUnits <= 0) {
    return { ok: false, error: '认购份数必须是正整数', units: 0, principal: 0 };
  }
  const ledger = bondsLedger(world);
  const issuance = ledger.issuances.find((entry) => entry.id === issuanceId);
  if (!issuance) {
    return { ok: false, error: `债券批次不存在：${issuanceId}`, units: 0, principal: 0 };
  }
  const market = config.government.bondMarket;
  if (issuance.status !== 'offering' || issuance.closedTick !== null) {
    return { ok: false, error: '认购窗口已关闭', units: 0, principal: 0 };
  }
  if (market.singleMonthSubscription && tick !== issuance.issuedTick) {
    return {
      ok: false,
      error: '认购窗口仅限发行当月，不跨月续售',
      units: 0,
      principal: 0,
    };
  }
  if (!holderExists(world, holder)) {
    return { ok: false, error: '认购主体不存在', units: 0, principal: 0 };
  }
  if (holder.kind === 'company') {
    const blocked = companySubscriptionBlockReason(world, holder.id);
    if (blocked !== null) return { ok: false, error: blocked, units: 0, principal: 0 };
  }
  const city = world.cities.find((entry) => entry.id === issuance.cityId);
  if (!city) {
    return { ok: false, error: '发行城市不存在', units: 0, principal: 0 };
  }

  let capacity = issuance.planUnits - issuance.soldUnits;
  if (market.maxSoldRatio < 1) {
    const soldCap = Math.floor(issuance.planUnits * market.maxSoldRatio);
    capacity = Math.min(capacity, soldCap - issuance.soldUnits);
  }
  const cash = bondHolderAvailableCash(world, config, holder);
  const affordable = Math.floor(cash / issuance.faceValue + 1e-9);
  const units = Math.max(0, Math.min(requestedUnits, affordable, capacity));
  if (units <= 0) {
    // 资金不足或已售罄：返回成功但 0 份，不扣款、不建持债。
    return { ok: true, units: 0, principal: 0 };
  }

  const cost = round2(units * issuance.faceValue);
  if (!debitOwnerCash(world, holder, cost)) {
    return { ok: false, error: '认购资金不足，未扣款', units: 0, principal: 0 };
  }
  receiveTreasury(
    world,
    city,
    cost,
    'bondIssuanceProceeds',
    `${holderLabel(world, holder)} 认购 ${city.name} 政府债券 ${units} 份`,
    {},
    config,
  );

  const holdingKey = bondHolderKey(holder);
  let holding = ledger.holdings.find(
    (entry) => entry.issuanceId === issuance.id && bondHolderKey(entry.holder) === holdingKey,
  );
  if (!holding) {
    holding = {
      id: `bondholding-${ledger.nextHoldingNumber}`,
      issuanceId: issuance.id,
      cityId: issuance.cityId,
      holder,
      units: 0,
      principal: 0,
      purchasedTick: tick,
      interestStartTick: Math.max(tick, issuance.issuedTick),
      maturityTick: issuance.maturityTick,
      lastCouponTick: null,
      accruedInterest: 0,
      interestPaid: 0,
      redeemedTick: null,
      status: 'active',
      note: '',
    };
    ledger.nextHoldingNumber += 1;
    ledger.holdings.push(holding);
  }
  holding.units += units;
  holding.principal = round2(holding.units * issuance.faceValue);
  holding.note = `持有 ${holding.units} 份（面额 ${issuance.faceValue}）`;

  issuance.soldUnits += units;
  issuance.principal = round2(issuance.soldUnits * issuance.faceValue);
  issuance.unsoldUnits = issuance.planUnits - issuance.soldUnits;

  return { ok: true, units, principal: cost, holding };
}

/** 认购窗口关闭：未售出份数记入 unsoldUnits，状态转 active，幂等。 */
export function closeGovernmentBondSubscription(
  world: WorldState,
  config: DemoConfig,
  issuanceId: string,
  tick: number,
): BondResult {
  void config;
  const ledger = bondsLedger(world);
  const issuance = ledger.issuances.find((entry) => entry.id === issuanceId);
  if (!issuance) return { ok: false, error: `债券批次不存在：${issuanceId}` };
  if (issuance.closedTick !== null) return { ok: true };
  issuance.closedTick = tick;
  issuance.status = 'active';
  issuance.unsoldUnits = issuance.planUnits - issuance.soldUnits;
  if (issuance.soldUnits === 0) {
    issuance.note = `${issuance.note}；认购窗口关闭时无成交，未形成债务`;
  }
  // 首次付息日按发行月 + 付息周期计算；到期按发行月 + 期限。
  issuance.maturityTick = issuance.issuedTick + issuance.termMonths;
  return { ok: true };
}

/** 单批次的当月计息（幂等重算）。返回该批次当前未付利息合计。 */
function accrueIssuance(
  world: WorldState,
  city: City,
  config: DemoConfig,
  issuance: BondIssuance,
  tick: number,
  logs?: LogEntry[],
): number {
  const ledger = bondsLedger(world);
  let aggregate = 0;
  for (const holding of ledger.holdings) {
    if (holding.issuanceId !== issuance.id || holding.status !== 'active') continue;
    const months = Math.max(0, tick - holding.interestStartTick);
    const totalAccrued = round2(
      (holding.principal * issuance.couponRateAnnual * months) / 12,
    );
    holding.accruedInterest = round2(Math.max(0, totalAccrued - holding.interestPaid));
    aggregate += holding.accruedInterest;
  }
  issuance.accruedInterest = round2(aggregate);
  void city;
  void config;
  void logs;
  return issuance.accruedInterest;
}

/**
 * 计息入口：对某城全部 active 批次按"已过月数重算"计提，供月结阶段②调用（幂等）。
 */
export function accrueBondInterest(
  world: WorldState,
  city: City,
  config: DemoConfig,
  tick: number,
): number {
  const ledger = bondsLedger(world);
  let total = 0;
  for (const issuance of ledger.issuances) {
    if (issuance.cityId !== city.id || issuance.status !== 'active') continue;
    total = round2(total + accrueIssuance(world, city, config, issuance, tick));
  }
  return total;
}

function nextPaymentId(world: WorldState, ledger: BondLedger, note: string): string {
  const id = `bondpayment-${ledger.nextPaymentNumber}`;
  ledger.nextPaymentNumber += 1;
  void world;
  void note;
  return id;
}

/**
 * 支付某批次本期票息（M12/M24/M36 各一次，共 3 期）。
 * 财政不足时**不垫付**：未付部分留在持债 accruedInterest 并累计到 issuance.arrearsInterest。
 */
export function payBondCoupon(
  world: WorldState,
  city: City,
  config: DemoConfig,
  issuanceId: string,
  tick: number,
  logs: LogEntry[],
): BondRedemptionResult {
  void logs;
  const ledger = bondsLedger(world);
  const issuance = ledger.issuances.find((entry) => entry.id === issuanceId);
  if (!issuance) return { ...EMPTY_REDEMPTION(), ok: false, error: `债券批次不存在：${issuanceId}` };
  if (issuance.cityId !== city.id) {
    return { ...EMPTY_REDEMPTION(), ok: false, error: '债券批次与城市不匹配' };
  }
  if (issuance.status !== 'active') return EMPTY_REDEMPTION();
  if (issuance.couponsPaid >= 3) return EMPTY_REDEMPTION();
  const period = issuance.interestPeriodMonths;
  const dueTick = (issuance.lastCouponTick ?? issuance.issuedTick) + period;
  if (tick < dueTick) return EMPTY_REDEMPTION();
  if (issuance.lastCouponTick === tick) return EMPTY_REDEMPTION();

  accrueIssuance(world, city, config, issuance, tick);
  const holdings = ledger.holdings
    .filter((holding) => holding.issuanceId === issuance.id && holding.status === 'active')
    .sort((a, b) => bondHolderKey(a.holder).localeCompare(bondHolderKey(b.holder)));
  const due = round2(holdings.reduce((sum, holding) => sum + holding.accruedInterest, 0));
  const paid = spendTreasury(
    world,
    city,
    due,
    'bondInterest',
    `${city.name} 债券第 ${issuance.couponsPaid + 1} 期票息`,
    {},
    config,
  );
  let remainingCash = paid;
  const payments: BondPayment[] = [];
  for (const holding of holdings) {
    const interest = round2(Math.min(holding.accruedInterest, remainingCash));
    holding.lastCouponTick = tick;
    if (interest > 0) {
      holding.accruedInterest = round2(holding.accruedInterest - interest);
      holding.interestPaid = round2(holding.interestPaid + interest);
      remainingCash = round2(remainingCash - interest);
      const payment: BondPayment = {
        id: nextPaymentId(world, ledger, '票息'),
        tick,
        issuanceId: issuance.id,
        cityId: issuance.cityId,
        holder: holding.holder,
        kind: 'coupon',
        principalPaid: 0,
        interestPaid: interest,
        fundedByBankAdvance: false,
        advanceLoanId: null,
        note: `${issuance.couponsPaid + 1}/3 期票息`,
      };
      ledger.payments.push(payment);
      payments.push(payment);
    }
  }
  issuance.lastCouponTick = tick;
  issuance.interestPaid = round2(issuance.interestPaid + paid);
  issuance.accruedInterest = round2(
    holdings.reduce((sum, holding) => sum + holding.accruedInterest, 0),
  );
  issuance.arrearsInterest = issuance.accruedInterest;
  if (issuance.accruedInterest <= 0.005) {
    issuance.couponsPaid = Math.min(3, issuance.couponsPaid + 1);
    issuance.arrearsInterest = 0;
  }
  return {
    ok: true,
    payments,
    principalPaid: 0,
    interestPaid: paid,
    advancedByBank: 0,
  };
}

/**
 * 债券到期本息兑付（M36：第 3 期票息 + 本金 + 全部欠息）：财政不足时银行**无条件垫付**，
 * 垫付形成 GovernmentLoanContract(purpose='bondAdvance') 并写 advance 记录；每笔只兑付一次。
 */
export function settleBondMaturity(
  world: WorldState,
  city: City,
  config: DemoConfig,
  issuanceId: string,
  tick: number,
  logs: LogEntry[],
): BondRedemptionResult {
  const ledger = bondsLedger(world);
  const issuance = ledger.issuances.find((entry) => entry.id === issuanceId);
  if (!issuance) return { ...EMPTY_REDEMPTION(), ok: false, error: `债券批次不存在：${issuanceId}` };
  if (issuance.cityId !== city.id) {
    return { ...EMPTY_REDEMPTION(), ok: false, error: '债券批次与城市不匹配' };
  }
  // 幂等：已兑付的批次不再支付第二遍。
  if (issuance.status === 'redeemed') return EMPTY_REDEMPTION();
  if (tick < issuance.maturityTick) return EMPTY_REDEMPTION();

  accrueIssuance(world, city, config, issuance, tick);
  const holdings = ledger.holdings
    .filter((holding) => holding.issuanceId === issuance.id && holding.status === 'active')
    .sort((a, b) => bondHolderKey(a.holder).localeCompare(bondHolderKey(b.holder)));
  const interestDue = round2(holdings.reduce((sum, holding) => sum + holding.accruedInterest, 0));
  const principalDue = round2(holdings.reduce((sum, holding) => sum + holding.principal, 0));

  const paidInterestFromTreasury = spendTreasury(
    world,
    city,
    interestDue,
    'bondInterest',
    `${city.name} 债券到期欠付利息`,
    {},
    config,
  );
  const paidPrincipalFromTreasury = spendTreasury(
    world,
    city,
    principalDue,
    'bondPrincipal',
    `${city.name} 债券到期本金`,
    {},
    config,
  );
  const shortInterest = round2(Math.max(0, interestDue - paidInterestFromTreasury));
  const shortPrincipal = round2(Math.max(0, principalDue - paidPrincipalFromTreasury));

  let advanceLoanId: string | null = null;
  let advancedByBank = 0;
  if (shortInterest + shortPrincipal > 0.005) {
    const advance = applyBankAdvance(world, city, config, {
      tick,
      issuanceId: issuance.id,
      payableIds: [],
      principal: shortPrincipal,
      interest: shortInterest,
      purpose: 'maturity',
    });
    if (!advance.ok) {
      return {
        ...EMPTY_REDEMPTION(),
        ok: false,
        error: advance.error ?? '银行垫付失败',
      };
    }
    advanceLoanId = advance.loan?.id ?? null;
    advancedByBank = advance.amountAdvanced;
  }

  let remainingInterestTreasury = paidInterestFromTreasury;
  let remainingPrincipalTreasury = paidPrincipalFromTreasury;
  let remainingInterestAdvance = shortInterest;
  let remainingPrincipalAdvance = shortPrincipal;
  const payments: BondPayment[] = [];
  let totalPrincipalPaid = 0;
  let totalInterestPaid = 0;

  const makePayment = (
    holder: BondHolder,
    principal: number,
    interest: number,
    fundedByBankAdvance: boolean,
  ): void => {
    if (principal <= 0.005 && interest <= 0.005) return;
    const payment: BondPayment = {
      id: nextPaymentId(world, ledger, '到期兑付'),
      tick,
      issuanceId: issuance.id,
      cityId: issuance.cityId,
      holder,
      kind: 'principal',
      principalPaid: round2(principal),
      interestPaid: round2(interest),
      fundedByBankAdvance,
      advanceLoanId: fundedByBankAdvance ? advanceLoanId : null,
      note: fundedByBankAdvance ? '到期本息（银行垫付）' : '到期本息（财政支付）',
    };
    ledger.payments.push(payment);
    payments.push(payment);
    totalPrincipalPaid = round2(totalPrincipalPaid + principal);
    totalInterestPaid = round2(totalInterestPaid + interest);
  };

  for (const holding of holdings) {
    const interestT = round2(Math.min(holding.accruedInterest, remainingInterestTreasury));
    const interestA = round2(Math.min(holding.accruedInterest - interestT, remainingInterestAdvance));
    const principalT = round2(Math.min(holding.principal, remainingPrincipalTreasury));
    const principalA = round2(
      Math.min(holding.principal - principalT, remainingPrincipalAdvance),
    );
    remainingInterestTreasury = round2(remainingInterestTreasury - interestT);
    remainingInterestAdvance = round2(remainingInterestAdvance - interestA);
    remainingPrincipalTreasury = round2(remainingPrincipalTreasury - principalT);
    remainingPrincipalAdvance = round2(remainingPrincipalAdvance - principalA);

    makePayment(holding.holder, principalT, interestT, false);
    makePayment(holding.holder, principalA, interestA, true);

    holding.accruedInterest = 0;
    holding.interestPaid = round2(holding.interestPaid + interestT + interestA);
    holding.lastCouponTick = tick;
    holding.redeemedTick = tick;
    holding.status = 'redeemed';
  }

  issuance.lastCouponTick = tick;
  issuance.interestPaid = round2(issuance.interestPaid + totalInterestPaid);
  issuance.principalRepaid = round2(issuance.principalRepaid + totalPrincipalPaid);
  issuance.accruedInterest = 0;
  issuance.arrearsInterest = 0;
  // issuance.bankAdvancedAmount 由 applyBankAdvance 统一累加（唯一记账点）。
  issuance.redeemedTick = tick;
  issuance.redemptionReason = 'maturity';
  issuance.status = 'redeemed';
  issuance.couponsPaid = 3;
  issuance.note = `${issuance.note}；${tick} 到期兑付（票息累计 ${issuance.interestPaid}）`;

  logs.push({
    tick,
    kind: 'government',
    message: `${city.name} 政府债券 ${issuance.id} 到期兑付：本金 ${totalPrincipalPaid}，利息 ${totalInterestPaid}${
      advancedByBank > 0 ? `，其中银行垫付 ${advancedByBank}` : ''
    }。`,
  });

  return {
    ok: true,
    payments,
    principalPaid: totalPrincipalPaid,
    interestPaid: totalInterestPaid,
    advancedByBank,
  };
}

/**
 * 破产兑付（DECISIONS v1.2 #8）：银行立即兑付**未到期债券本金 + 按实际持有月份计提的未付利息**
 * （不支付未来利息）；财政余额不参与兑付。每笔债权只兑付一次。
 * 垫付形成的 bondAdvance 贷款由清算阶段（debt.ts）随原有银行债务一并勾销。
 */
export function settleBondBankruptcyRedemption(
  world: WorldState,
  city: City,
  config: DemoConfig,
  tick: number,
  logs: LogEntry[],
): BondRedemptionResult {
  const ledger = bondsLedger(world);
  const issuances = ledger.issuances.filter((issuance) => issuance.cityId === city.id);
  const payments: BondPayment[] = [];
  let totalPrincipal = 0;
  let totalInterest = 0;
  let advancedByBank = 0;

  for (const issuance of issuances) {
    const holdings = ledger.holdings
      .filter((holding) => holding.issuanceId === issuance.id && holding.status === 'active')
      .sort((a, b) => bondHolderKey(a.holder).localeCompare(bondHolderKey(b.holder)));
    if (holdings.length === 0) {
      if (issuance.status !== 'redeemed') {
        issuance.status = 'redeemed';
        issuance.redeemedTick = tick;
        issuance.redemptionReason = 'bankruptcy';
        issuance.accruedInterest = 0;
        issuance.arrearsInterest = 0;
      }
      continue;
    }
    accrueIssuance(world, city, config, issuance, tick);
    const interestDue = round2(holdings.reduce((sum, holding) => sum + holding.accruedInterest, 0));
    const principalDue = round2(holdings.reduce((sum, holding) => sum + holding.principal, 0));
    const advance = applyBankAdvance(world, city, config, {
      tick,
      issuanceId: issuance.id,
      payableIds: [],
      principal: principalDue,
      interest: interestDue,
      purpose: 'bankruptcy',
    });
    if (!advance.ok) {
      logs.push({
        tick,
        kind: 'warning',
        message: `${city.name} 破产兑付 ${issuance.id} 失败：${advance.error ?? '银行垫付失败'}。`,
      });
      continue;
    }
    const loanId = advance.loan?.id ?? null;
    for (const holding of holdings) {
      const payment: BondPayment = {
        id: nextPaymentId(world, ledger, '破产兑付'),
        tick,
        issuanceId: issuance.id,
        cityId: city.id,
        holder: holding.holder,
        kind: 'bankruptcyRedemption',
        principalPaid: holding.principal,
        interestPaid: holding.accruedInterest,
        fundedByBankAdvance: true,
        advanceLoanId: loanId,
        note: '破产兑付：未到期本金 + 实际持有月份已计提未付利息',
      };
      ledger.payments.push(payment);
      payments.push(payment);
      totalPrincipal = round2(totalPrincipal + holding.principal);
      totalInterest = round2(totalInterest + holding.accruedInterest);
      holding.interestPaid = round2(holding.interestPaid + holding.accruedInterest);
      holding.accruedInterest = 0;
      holding.redeemedTick = tick;
      holding.status = 'redeemed';
    }
    issuance.interestPaid = round2(issuance.interestPaid + interestDue);
    issuance.principalRepaid = round2(issuance.principalRepaid + principalDue);
    issuance.accruedInterest = 0;
    issuance.arrearsInterest = 0;
    // issuance.bankAdvancedAmount 由 applyBankAdvance 统一累加（唯一记账点）。
    issuance.redeemedTick = tick;
    issuance.redemptionReason = 'bankruptcy';
    issuance.status = 'redeemed';
    advancedByBank = round2(advancedByBank + advance.amountAdvanced);
  }

  if (payments.length > 0) {
    logs.push({
      tick,
      kind: 'warning',
      message: `${city.name} 政府破产：银行兑付未到期债券本金 ${totalPrincipal}、未付利息 ${totalInterest}（垫付 ${advancedByBank}）。`,
    });
  }
  return {
    ok: true,
    payments,
    principalPaid: totalPrincipal,
    interestPaid: totalInterest,
    advancedByBank,
  };
}
