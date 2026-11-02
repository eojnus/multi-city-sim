// 银行授信：所有权主体识别、现金收付、授信基准与额度评估、月度快照。
//
// 数据权威（见 docs/development/IMPLEMENTATION_PLAN_v0.4.md §1）：
// - 存款余额在 world.banking.deposits；
// - 贷款本金/未偿在 world.banking.loans；
// - 企业现金/库存/产能仍归企业字段，company.debt 只是银行贷款的派生镜像（由 banking.syncCompanyDebt 写入）。
// 本文件不做任何货币创造：只搬运世界内已有现金，额度评估只读数据。

import type {
  BankOwner,
  Company,
  CreditSnapshot,
  DepositAccount,
  LoanContract,
  WorldState,
} from '../contracts/types';
import type { DemoConfig } from '../../data/config';
import type { CreditEvaluation } from './types';
import { round2 } from '../core/math';
import { companyBookValue, companySharePrice } from '../companies/company';
import { cityMarketPrices } from '../markets/markets';
import { playerNetWorth } from '../economy/gdp';

/** 同一主体的判断：玩家是单例，忽略 id；其他主体按 kind + id 精确匹配。 */
export function sameOwner(a: BankOwner, b: BankOwner): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'player') return true;
  return a.id === b.id;
}

/** 稳定的主体键，用于快照去重与排序：'kind:id'。玩家单例统一为 'player:player'。 */
export function ownerKey(owner: BankOwner): string {
  const id = owner.kind === 'player' ? 'player' : owner.id;
  return `${owner.kind}:${id}`;
}

/** 面向日志/提示的主体显示名。 */
export function ownerLabel(world: WorldState, owner: BankOwner): string {
  switch (owner.kind) {
    case 'player':
      return `玩家 · ${world.player.name}`;
    case 'company':
      return world.companies.find((company) => company.id === owner.id)?.name ?? owner.id;
    case 'investorGroup':
      return world.investors.find((group) => group.id === owner.id)?.name ?? owner.id;
    case 'household': {
      const group = world.households?.groups.find((entry) => entry.id === owner.id);
      return group ? `居民群体 · ${group.name}` : `居民群体 · ${owner.id}`;
    }
  }
}

/** 银行持有的存款账户（世界尚未接入银行时视为空）。 */
export function bankDepositsOf(world: WorldState): DepositAccount[] {
  return world.banking?.deposits ?? [];
}

/** 银行持有的贷款合同（世界尚未接入银行时视为空）。 */
export function bankLoansOf(world: WorldState): LoanContract[] {
  return world.banking?.loans ?? [];
}

/** 该主体当前可动用的手头现金；主体不存在时返回 0（调用方需自行校验存在性）。 */
export function ownerCash(world: WorldState, owner: BankOwner): number {
  switch (owner.kind) {
    case 'player':
      return round2(world.player.cash);
    case 'company':
      return round2(world.companies.find((company) => company.id === owner.id)?.cash ?? 0);
    case 'investorGroup':
      return round2(world.investors.find((group) => group.id === owner.id)?.cash ?? 0);
    case 'household':
      return round2(world.households?.groups.find((entry) => entry.id === owner.id)?.cash ?? 0);
  }
}

/** 把银行放款/还款等资金记入主体现金；金额非正或主体不存在时不动作。 */
export function creditOwnerCash(world: WorldState, owner: BankOwner, amount: number): void {
  const value = round2(amount);
  if (!Number.isFinite(value) || value <= 0) return;
  switch (owner.kind) {
    case 'player':
      world.player.cash = round2(world.player.cash + value);
      return;
    case 'company': {
      const company = world.companies.find((entry) => entry.id === owner.id);
      if (company) company.cash = round2(company.cash + value);
      return;
    }
    case 'investorGroup': {
      const group = world.investors.find((entry) => entry.id === owner.id);
      if (group) group.cash = round2(group.cash + value);
      return;
    }
    case 'household': {
      const group = world.households?.groups.find((entry) => entry.id === owner.id);
      if (group) group.cash = round2(group.cash + value);
      return;
    }
  }
}

/**
 * 从主体现金扣款。余额不足返回 false 且**不部分扣款**（调用方先校验再提交）。
 * 金额非正或主体不存在同样返回 false。
 */
export function debitOwnerCash(world: WorldState, owner: BankOwner, amount: number): boolean {
  const value = round2(amount);
  if (!Number.isFinite(value) || value <= 0) return false;
  const cash = ownerCash(world, owner);
  if (cash + 0.001 < value) return false;
  switch (owner.kind) {
    case 'player':
      world.player.cash = round2(Math.max(0, world.player.cash - value));
      return true;
    case 'company': {
      const company = world.companies.find((entry) => entry.id === owner.id);
      if (!company) return false;
      company.cash = round2(Math.max(0, company.cash - value));
      return true;
    }
    case 'investorGroup': {
      const group = world.investors.find((entry) => entry.id === owner.id);
      if (!group) return false;
      group.cash = round2(Math.max(0, group.cash - value));
      return true;
    }
    case 'household': {
      const group = world.households?.groups.find((entry) => entry.id === owner.id);
      if (!group) return false;
      group.cash = round2(Math.max(0, group.cash - value));
      return true;
    }
  }
}

/** 该主体当前的银行存款余额；没有账户时为 0。 */
export function ownerDepositBalance(world: WorldState, owner: BankOwner): number {
  const account = bankDepositsOf(world).find((entry) => sameOwner(entry.owner, owner));
  return account ? round2(account.balance) : 0;
}

/** 该主体当前全部未偿贷款本金（active + defaulted；已结清不计）。 */
export function ownerOutstanding(world: WorldState, owner: BankOwner): number {
  let total = 0;
  for (const loan of bankLoansOf(world)) {
    if (loan.status === 'repaid') continue;
    if (!sameOwner(loan.borrower, owner)) continue;
    total += loan.outstanding;
  }
  return round2(total);
}

/**
 * 企业授信基准 = max(0, 账面股权价值)（用户确定口径）。
 * companyBookValue 已经是“现金 + 库存价值 + 产能资产 − 企业债务”，可能为负，这里取下限 0。
 * 刻意**不**使用 companySharePrice × totalShares 的 1 信用点下限，避免授信虚高。
 * 缺少城市市场价格时按保守口径给 0，不猜测估值。
 */
export function companyEquityBase(world: WorldState, company: Company): number {
  const city = world.cities.find((entry) => entry.id === company.cityId);
  if (!city) return 0;
  return Math.max(0, round2(companyBookValue(company, cityMarketPrices(city))));
}

/**
 * 个人授信基准 = 可核验净资产（用户确定口径）：
 * 玩家现金 + 银行存款 + 股票权益（复用 playerNetWorth 的持股估值）− 未偿贷款。
 *
 * 没有房产系统，因此**不得**虚增房产估值。
 * 注意：基准里已经减过一次未偿贷款，而额度公式还会再减当前未偿——这是刻意的保守双重约束
 * （基准约束“净资产规模”，额度约束“已用授信”），不是把同一笔债务重复扣两次。
 */
export function personalNetWorthBase(world: WorldState, config: DemoConfig): number {
  // config 保留在签名中是模块契约的一部分；具体比例由 creditEvaluation 读取，这里只按资产口径估值。
  void config;
  const owner: BankOwner = { kind: 'player', id: 'player' };
  const netWorth = playerNetWorth(world);
  const deposits = ownerDepositBalance(world, owner);
  const outstanding = ownerOutstanding(world, owner);
  return round2(netWorth + deposits - outstanding);
}

/** 居民投资实体持股市值（权威在 securities.holdings；按企业账面股价估值，与玩家持股同口径）。 */
function investorEquityValue(world: WorldState, owner: BankOwner): number {
  let value = 0;
  for (const holding of world.securities?.holdings ?? []) {
    if (holding.holder.type !== 'investorGroup' || holding.holder.id !== owner.id) continue;
    const company = world.companies.find((entry) => entry.id === holding.companyId);
    if (!company) continue;
    const city = world.cities.find((entry) => entry.id === company.cityId);
    if (!city) continue;
    value += holding.shares * companySharePrice(company, cityMarketPrices(city));
  }
  return round2(value);
}

interface OwnerCreditBase {
  baseValue: number;
  method: 'netWorth' | 'equityBook';
}

/**
 * 各主体的授信基准。
 * - company：非负账面股权（已扣企业债务）；
 * - player：可核验净资产（现金 + 存款 + 股票权益 − 未偿）；
 * - household：手头现金 + 银行存款 − 未偿；股票权益按设计归属居民投资实体，不重复计入；
 * - investorGroup：现金 + 存款 + 持股市值 − 未偿。
 */
function ownerCreditBase(world: WorldState, owner: BankOwner, config: DemoConfig): OwnerCreditBase {
  switch (owner.kind) {
    case 'company': {
      const company = world.companies.find((entry) => entry.id === owner.id);
      return { baseValue: company ? companyEquityBase(world, company) : 0, method: 'equityBook' };
    }
    case 'player':
      return { baseValue: personalNetWorthBase(world, config), method: 'netWorth' };
    case 'household':
      return {
        baseValue: round2(ownerCash(world, owner) + ownerDepositBalance(world, owner) - ownerOutstanding(world, owner)),
        method: 'netWorth',
      };
    case 'investorGroup':
      return {
        baseValue: round2(
          ownerCash(world, owner) +
            ownerDepositBalance(world, owner) +
            investorEquityValue(world, owner) -
            ownerOutstanding(world, owner),
        ),
        method: 'netWorth',
      };
  }
}

/** 统一的授信说明文案：把“基准已扣债 + 额度再减未偿”的双重约束讲清楚。 */
function evaluationReason(
  owner: BankOwner,
  baseValue: number,
  limitRate: number,
  limit: number,
  outstanding: number,
  available: number,
  method: CreditEvaluation['method'],
  snapshotTick: number | undefined,
): string {
  const parts: string[] = [];
  parts.push(
    snapshotTick === undefined
      ? '实时估值（尚无月度授信快照）'
      : `月度授信快照 tick ${snapshotTick}（当月稳定，下月按上一完整月数据重算）`,
  );
  if (method === 'equityBook') {
    parts.push(
      `企业授信基准 = max(0, 现金 + 库存价值 + 产能资产 − 企业债务) = ${baseValue.toFixed(2)}`,
    );
  } else if (owner.kind === 'player') {
    parts.push(
      `个人授信基准 = 可核验净资产（现金 + 银行存款 + 股票权益 − 未偿贷款）= ${baseValue.toFixed(2)}；无房产系统，不计房产`,
    );
  } else if (owner.kind === 'investorGroup') {
    parts.push(
      `投资实体授信基准 = 现金 + 银行存款 + 持股市值 − 未偿贷款 = ${baseValue.toFixed(2)}`,
    );
  } else {
    parts.push(
      `居民群体授信基准 = 手头现金 + 银行存款 − 未偿贷款 = ${baseValue.toFixed(2)}（股票权益归属居民投资实体，不重复计入）`,
    );
  }
  parts.push(
    `额度 = max(0, 基准) × ${(limitRate * 100).toFixed(2)}% = ${limit.toFixed(2)}；已有未偿本金 = ${outstanding.toFixed(2)}；可借额度 = ${available.toFixed(2)}`,
  );
  parts.push(
    '基准已扣除债务，额度再减去已用未偿，是刻意保守的双重约束：分别限制资产规模与已用授信，不是重复扣同一笔债务。',
  );
  if (outstanding > limit) {
    parts.push('估值下降导致已有未偿超过新额度：不要求提前还清，可借额度为 0。');
  }
  return parts.join('；');
}

/** 不使用快照的实时授信评估（快照生成与“无快照兜底”共用）。 */
function liveCreditEvaluation(
  world: WorldState,
  owner: BankOwner,
  config: DemoConfig,
): CreditEvaluation {
  const { baseValue, method } = ownerCreditBase(world, owner, config);
  const limitRate = config.banking.creditLimitRate;
  const limit = round2(Math.max(0, baseValue) * limitRate);
  const outstanding = ownerOutstanding(world, owner);
  const available = Math.max(0, round2(limit - outstanding));
  return {
    baseValue: round2(baseValue),
    limit,
    outstanding,
    available,
    method,
    reason: evaluationReason(owner, round2(baseValue), limitRate, limit, outstanding, available, method, undefined),
  };
}

/**
 * 授信评估：有月度快照时使用快照的基准/额度（当月稳定），可借额度仍按**当前未偿**实时计算；
 * 没有快照时退回实时估值，保证新世界/旧存档在首次刷新前也能工作。
 */
export function creditEvaluation(
  world: WorldState,
  owner: BankOwner,
  config: DemoConfig,
): CreditEvaluation {
  const snapshot = snapshotFor(world, owner);
  if (!snapshot) return liveCreditEvaluation(world, owner, config);
  const outstanding = ownerOutstanding(world, owner);
  const limit = round2(snapshot.limit);
  const available = Math.max(0, round2(limit - outstanding));
  return {
    baseValue: round2(snapshot.baseValue),
    limit,
    outstanding,
    available,
    method: snapshot.method,
    reason: evaluationReason(
      owner,
      round2(snapshot.baseValue),
      snapshot.limitRate,
      limit,
      outstanding,
      available,
      snapshot.method,
      snapshot.tick,
    ),
  };
}

/**
 * 每月生成授信快照（基于结算开始时的上一完整月数据）。
 * 覆盖对象：玩家、全部企业、所有存款账户所有者、所有未结清贷款借款人。
 * 同一主体同一 tick 反复刷新时覆盖；每个主体只保留最近 maxSnapshotsPerBorrower 条。
 */
export function refreshCreditSnapshots(world: WorldState, config: DemoConfig, tick: number): void {
  const banking = world.banking;
  if (!banking) return;

  const owners: BankOwner[] = [];
  const seen = new Set<string>();
  const addOwner = (owner: BankOwner): void => {
    const key = ownerKey(owner);
    if (seen.has(key)) return;
    seen.add(key);
    owners.push(owner);
  };
  addOwner({ kind: 'player', id: 'player' });
  for (const company of [...world.companies].sort((a, b) => a.id.localeCompare(b.id))) {
    addOwner({ kind: 'company', id: company.id });
  }
  for (const account of banking.deposits) addOwner(account.owner);
  for (const loan of banking.loans) addOwner(loan.borrower);
  owners.sort((a, b) => ownerKey(a).localeCompare(ownerKey(b)));

  const limitRate = config.banking.creditLimitRate;
  const maxPerOwner = Math.max(1, Math.round(config.banking.maxSnapshotsPerBorrower));
  const kept: CreditSnapshot[] = [];
  for (const owner of owners) {
    const { baseValue, method } = ownerCreditBase(world, owner, config);
    const roundedBase = round2(baseValue);
    const limit = round2(Math.max(0, roundedBase) * limitRate);
    const outstanding = ownerOutstanding(world, owner);
    const available = Math.max(0, round2(limit - outstanding));
    const snapshot: CreditSnapshot = {
      tick,
      borrower: { kind: owner.kind, id: owner.kind === 'player' ? 'player' : owner.id },
      baseValue: roundedBase,
      limitRate,
      limit,
      outstanding,
      available,
      method,
      reason: evaluationReason(
        owner,
        roundedBase,
        limitRate,
        limit,
        outstanding,
        available,
        method,
        tick,
      ),
    };
    const history = banking.snapshots.filter(
      (entry) => sameOwner(entry.borrower, owner) && entry.tick !== tick,
    );
    history.push(snapshot);
    history.sort((a, b) => a.tick - b.tick);
    kept.push(...history.slice(-maxPerOwner));
  }
  kept.sort(
    (a, b) => ownerKey(a.borrower).localeCompare(ownerKey(b.borrower)) || a.tick - b.tick,
  );
  banking.snapshots = kept;
}

/** 该主体最近一条授信快照（无快照时 undefined）。 */
export function snapshotFor(world: WorldState, owner: BankOwner): CreditSnapshot | undefined {
  let best: CreditSnapshot | undefined;
  for (const snapshot of world.banking?.snapshots ?? []) {
    if (!sameOwner(snapshot.borrower, owner)) continue;
    if (!best || snapshot.tick >= best.tick) best = snapshot;
  }
  return best;
}

/** 该主体的实时可借额度：额度 − 当前未偿（不读取缓存 available）。 */
export function availableCredit(world: WorldState, owner: BankOwner, config: DemoConfig): number {
  return creditEvaluation(world, owner, config).available;
}
