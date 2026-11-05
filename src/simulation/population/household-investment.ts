// 居民投资权益的纯函数口径（v1.3 §2）。
//
// 为什么单独成模块：
// - 财富/阶层统计（household-groups）、居民授信（household-finance）、股息归属与迁移
//   （investors）必须用同一份“有效份额”权重，否则会出现“财富按人口分、股息按份额分、
//   授信又是另一套”的三套口径；
// - 只依赖 contracts 类型与 round2，不 import 任何业务模块，避免
//   investors ↔ household-groups ↔ household-finance 的循环依赖。
//
// 口径：有效份额 = ledger.shares + ledger.openingShares（开局/旧档无主旧资产一次性归属）。
// 账本尚未建立（旧档或手工构造世界）时回退到人口权重，保证钱与权益不会凭空消失。

import type { HouseholdGroup, HouseholdInvestorLedger, WorldState } from '../contracts/types';
import { round2 } from '../core/math';

/**
 * 投资实体持有的政府债券估值（v1.4 §3）：未到期本金 + 已计提未付利息。
 * 权威明细在 world.bonds.holdings（BondHolding.principal / accruedInterest）；
 * 只统计 status='active'，已兑付（含到期/破产兑付）的持债不再计入净资产，避免重复计价。
 */
export function investorBondValue(world: WorldState, investorId: string): number {
  const holdings = world.bonds?.holdings ?? [];
  let total = 0;
  for (const holding of holdings) {
    if (holding.status !== 'active') continue;
    if (holding.holder.kind !== 'investorGroup' || holding.holder.id !== investorId) continue;
    total += Math.max(0, holding.principal) + Math.max(0, holding.accruedInterest);
  }
  return round2(total);
}

/**
 * 每份有效份额对应的投资实体净资产（净值/份额）。
 * 份额为 0（旧档未建账/零人城市）或净资产为 0 时返回 0，由调用方决定 1:1 兜底口径。
 */
export function investorNavPerShare(equity: number, totalShares: number): number {
  const netWorth = Math.max(0, equity);
  const shares = Math.max(0, totalShares);
  if (shares <= 0 || netWorth <= 0) return 0;
  return netWorth / shares;
}

/**
 * 按净值把一笔权益价值换算成份额（v1.4 §3）：新资金/迁移权益不得再按 1:1 增发，
 * 否则会稀释原持有人。零/负净值（净资产为 0 的实体）回退 1:1，保证资金与份额可对账。
 */
export function sharesForInvestorValue(value: number, navPerShare: number): number {
  const amount = Math.max(0, value);
  if (amount <= 0) return 0;
  if (navPerShare > 0) return round2(amount / navPerShare);
  return round2(amount);
}

/** 读取（必要时初始化）群体的投资份额账本；只记投入/份额/分红归属，不凭空造钱。 */
export function ensureInvestorLedger(group: HouseholdGroup): HouseholdInvestorLedger {
  if (!group.investorLedger) {
    group.investorLedger = {
      contributed: 0,
      shares: 0,
      dividends: 0,
      // 从未发生记为 -1（而不是 0）：tick 0 时也要能与“本月已记账”区分，避免幂等判断误挡。
      lastContributionTick: -1,
      lastDividendTick: -1,
    };
  }
  return group.investorLedger;
}

/** 有效份额 = 历史投入份额 + 一次性“开局无主旧资产”起始份额（未初始化按 0）。 */
export function effectiveInvestorShares(
  ledger: HouseholdInvestorLedger | undefined,
): number {
  if (!ledger) return 0;
  return round2(Math.max(0, ledger.shares) + Math.max(0, ledger.openingShares ?? 0));
}

/**
 * 权益权重：优先按有效份额；账本合计为 0（旧档/未初始化）时回退到人口。
 * 返回长度与 groups 一致，且合计 > 0（全为 0 时按均分处理，避免 NaN）。
 */
export function investorEquityWeights(groups: HouseholdGroup[]): number[] {
  const shares = groups.map((group) => effectiveInvestorShares(group.investorLedger));
  const totalShares = shares.reduce((sum, value) => sum + value, 0);
  if (totalShares > 0) return shares;
  const people = groups.map((group) => Math.max(0, group.people));
  const totalPeople = people.reduce((sum, value) => sum + value, 0);
  if (totalPeople > 0) return people;
  return groups.map(() => 1);
}

/**
 * 以 0.01 为单位按权重分配金额，保证合计严格等于 round2(total)（最大余数法）。
 * 与 household-economy.allocateMoney 同算法；作为居民投资权益/股息/迁移拆分的统一实现。
 */
export function allocateMoneyExact(total: number, weights: number[]): number[] {
  const target = round2(total);
  if (weights.length === 0) return [];
  const cents = Math.round(target * 100);
  if (cents <= 0) return weights.map(() => 0);
  const weightSum = weights.reduce((acc, value) => acc + Math.max(0, value), 0);
  if (weightSum <= 0) {
    const base = Math.floor(cents / weights.length);
    const result = weights.map(() => base);
    for (let i = 0; i < cents - base * weights.length; i += 1) {
      result[i] = (result[i] ?? 0) + 1;
    }
    return result.map((value) => round2(value / 100));
  }
  const exact = weights.map((value) => (Math.max(0, value) / weightSum) * cents);
  const floors = exact.map((value) => Math.floor(value));
  let remaining = cents - floors.reduce((sum, value) => sum + value, 0);
  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  const result = floors.slice();
  for (let i = 0; i < order.length && remaining > 0; i += 1) {
    const entry = order[i]!;
    result[entry.index] = (result[entry.index] ?? 0) + 1;
    remaining -= 1;
  }
  return result.map((value) => round2(value / 100));
}

/**
 * 把本城投资实体权益 total 按有效份额拆到各群体（分币精确）。
 * 与 cityInvestorEquity 一起使用：合计严格等于权益总额，用于财富统计与授信。
 */
export function splitInvestorEquity(groups: HouseholdGroup[], total: number): number[] {
  return allocateMoneyExact(total, investorEquityWeights(groups));
}

/** 某群体在本城投资实体权益中的份额（分币精确，供授信与人均财富使用）。 */
export function investorEquityOfGroup(
  groups: HouseholdGroup[],
  group: HouseholdGroup,
  total: number,
): number {
  const index = groups.indexOf(group);
  if (index < 0) return 0;
  const shares = splitInvestorEquity(groups, total);
  return shares[index] ?? 0;
}
