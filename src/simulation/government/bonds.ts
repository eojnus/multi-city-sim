/**
 * 政府债券（v0.7 契约骨架，块0 空实现）。
 *
 * 契约口径（DECISIONS v1 #4/#5、v1.2 #19/#21）：
 * - 面额 faceValue 信用点/份，整数份；发行计划（planUnits）与实际成交（soldUnits）分开；
 *   只有成交份数形成本金 principal = soldUnits × faceValue，未售出不形成债务。
 * - 认购主体：玩家、居民投资实体、企业（可跨城）；银行不得认购国债。
 * - 只用现有可支配资金，禁止贷款购债、禁止认购时自动申请贷款；企业购债流动性上限见 #23。
 * - 认购窗口：发行当月一次撮合，不跨月续售；未售出份数关闭并记录。
 * - 票息：固定 3 期，M12 / M24 / M36 各支付一次（每满 interestPeriodMonths=12）；
 *   M12/M24 财政不足时银行不垫付，记欠付利息（issuance.arrearsInterest）；
 *   **M36 同时还本**：同月需生成「第 3 期票息」与「到期本金」两笔应付（v1.4 #33）。
 *   36 月到期与破产时银行连本带欠息无条件垫付。
 *
 * 本文件当前只提供签名与空实现，业务体由游戏程序在块2 填充；签名冻结后只增不改。
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

/** 债券账本（缺失时视为空账本；迁移后必定存在）。 */
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

/**
 * 发起一次债券发行计划（planUnits 份）。
 * 约束：planUnits 为正整数且 ≤ config.government.bondMarket.maxPlanUnitsPerIssue；
 * 同一城市距上次发行不足 minMonthsBetweenIssues 时拒绝；银行不得出现在认购主体中。
 */
export function issueGovernmentBond(
  world: WorldState,
  city: City,
  config: DemoConfig,
  planUnits: number,
  tick: number,
): BondIssueResult {
  void world;
  void city;
  void config;
  void planUnits;
  void tick;
  // TODO(块2)：创建 BondIssuance（status='offering'、soldUnits=0、principal=0、未售份数关闭时记录）。
  return { ok: false, error: '债券发行尚未实现（块2）' };
}

/**
 * 某持有人对某批次的认购（整数份，按真实可用资金扣款）。
 * 超过剩余可售份数或资金不足时按**可成交份数**部分成交；0 份则不产生持债记录。
 */
export function subscribeGovernmentBond(
  world: WorldState,
  config: DemoConfig,
  issuanceId: string,
  holder: BondHolder,
  requestedUnits: number,
  tick: number,
): BondSubscriptionResult {
  void world;
  void config;
  void issuanceId;
  void holder;
  void requestedUnits;
  void tick;
  // TODO(块2)：校验批次/窗口/持有人资金，扣款、写 BondHolding 与 soldUnits。
  return { ok: false, error: '债券认购尚未实现（块2）', units: 0, principal: 0 };
}

/** 认购窗口关闭：未售出份数记入 unsoldUnits，状态转 active（或立即作废），幂等。 */
export function closeGovernmentBondSubscription(
  world: WorldState,
  config: DemoConfig,
  issuanceId: string,
  tick: number,
): BondResult {
  void world;
  void config;
  void issuanceId;
  void tick;
  return { ok: false, error: '认购窗口关闭尚未实现（块2）' };
}

/**
 * 支付某批次本期票息（M12/M24/M36 各一次，共 3 期，v1.4 #33）。
 * 财政不足时**不垫付**：未付部分累计到 issuance.arrearsInterest 与持债记录，状态置 arrears。
 */
export function payBondCoupon(
  world: WorldState,
  city: City,
  config: DemoConfig,
  issuanceId: string,
  tick: number,
  logs: LogEntry[],
): BondRedemptionResult {
  void world;
  void city;
  void config;
  void issuanceId;
  void tick;
  void logs;
  return { ok: false, payments: [], principalPaid: 0, interestPaid: 0, advancedByBank: 0 };
}

/**
 * 债券到期本息兑付（本金 + 全部欠付利息）：财政不足时银行**无条件垫付**，
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
  void world;
  void city;
  void config;
  void issuanceId;
  void tick;
  void logs;
  return { ok: false, payments: [], principalPaid: 0, interestPaid: 0, advancedByBank: 0 };
}

/**
 * 破产兑付（DECISIONS v1.2 #8）：银行立即兑付**未到期债券本金 + 按实际持有月份计提的未付利息**
 * （不支付未来利息）；随后该垫付与政府原有银行债务一并勾销。每笔债权只兑付一次。
 */
export function settleBondBankruptcyRedemption(
  world: WorldState,
  city: City,
  config: DemoConfig,
  tick: number,
  logs: LogEntry[],
): BondRedemptionResult {
  void world;
  void city;
  void config;
  void tick;
  void logs;
  return { ok: false, payments: [], principalPaid: 0, interestPaid: 0, advancedByBank: 0 };
}

/**
 * 债券持有人的真实可用现金（用于认购上限）：
 * 玩家=现金；居民投资实体/企业=现金；企业还需扣除上月实发工资与应付利息（#23 流动性保留）。
 */
export function bondHolderAvailableCash(
  world: WorldState,
  config: DemoConfig,
  holder: BondHolder,
): number {
  void world;
  void config;
  void holder;
  // TODO(块2)：玩家/投资实体/企业三类口径；禁止贷款购债。
  return 0;
}

/** 确定性认购顺序：config.government.bondMarket.subscriptionOrder 展开为具体持有人。 */
export function bondSubscriptionOrder(
  world: WorldState,
  config: DemoConfig,
  issuanceId: string,
): BondHolder[] {
  void world;
  void config;
  void issuanceId;
  // TODO(块2)：按配置顺序（玩家 → 投资实体 → 企业），同类型内部按 id 升序。
  return [];
}
