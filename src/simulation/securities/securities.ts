// 证券与股权：股份类别、发行、持股、二级撮合、融资要约和股息归属。
// 权威数据在 world.securities；company.totalShares 与 player.holdings 是缓存镜像。
//
// 暂定演示规则（均待用户决定，不得视为正式设计）：
// - 每家企业发行两类股份：voting（有投票权）与 nonVoting（仅分红）。
// - 企业作为买方在二级市场买入的股票一律只能是有投票权类别。
// - 个人二级市场买入是否带投票权由 DEMO_CONFIG 的持有方规则决定；当前演示默认带投票权。
// - 两类股票按股同额分红。
// - 融资要约逐出资方记录股份类别，接受前不改变任何资金或股份。

import type {
  Company,
  HolderRef,
  HolderType,
  InvestorGroup,
  PlayerHolding,
  ShareClass,
  ShareHolding,
  ShareKind,
  StockOrder,
  StockTrade,
  WorldState,
} from '../contracts/types';
import type { DemoConfig } from '../../data/config';
import { cityMarketPrices } from '../markets/markets';
import { companySharePrice } from '../companies/company';
import { round2 } from '../core/math';

export function shareClassId(companyId: string, kind: ShareKind): string {
  return `${companyId}:${kind === 'voting' ? 'voting' : 'non-voting'}`;
}

export function holderKey(holder: HolderRef): string {
  return `${holder.type}:${holder.id}`;
}

export function sameHolder(a: HolderRef | 'management', b: HolderRef | 'management'): boolean {
  if (a === 'management' || b === 'management') return a === b;
  return a.type === b.type && a.id === b.id;
}

export function holderOf(type: HolderType, id: string): HolderRef {
  return { type, id };
}

export function holderExists(world: WorldState, holder: HolderRef): boolean {
  if (!holder || typeof holder.id !== 'string') return false;
  if (holder.type === 'player') return holder.id === 'player';
  if (holder.type === 'company') return world.companies.some((company) => company.id === holder.id);
  if (holder.type === 'investorGroup') return world.investors.some((group) => group.id === holder.id);
  return false;
}

export function holderName(world: WorldState, holder: HolderRef | 'management'): string {
  if (holder === 'management') return '职业经理人';
  if (holder.type === 'player') return `玩家 · ${world.player.name}`;
  if (holder.type === 'company') {
    return world.companies.find((company) => company.id === holder.id)?.name ?? holder.id;
  }
  return world.investors.find((group) => group.id === holder.id)?.name ?? holder.id;
}

export function classOf(world: WorldState, companyId: string, kind: ShareKind): ShareClass | undefined {
  return world.securities.classes.find(
    (shareClass) => shareClass.companyId === companyId && shareClass.kind === kind,
  );
}

export function classById(world: WorldState, shareClassIdValue: string): ShareClass | undefined {
  return world.securities.classes.find((shareClass) => shareClass.id === shareClassIdValue);
}

export function classesOfCompany(world: WorldState, companyId: string): ShareClass[] {
  return world.securities.classes
    .filter((shareClass) => shareClass.companyId === companyId)
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function findHolding(
  world: WorldState,
  shareClassIdValue: string,
  holder: HolderRef,
): ShareHolding | undefined {
  return world.securities.holdings.find(
    (holding) =>
      holding.shareClassId === shareClassIdValue && sameHolder(holding.holder, holder),
  );
}

export function companyIssuedShares(world: WorldState, companyId: string): number {
  return round2(
    classesOfCompany(world, companyId).reduce((total, shareClass) => total + shareClass.issuedShares, 0),
  );
}

/** 企业持股按类别汇总；返回结果的顺序固定，便于 UI 与测试。 */
export interface CompanyHolderSummary {
  holder: HolderRef;
  votingShares: number;
  nonVotingShares: number;
  totalShares: number;
}

export function companyHolders(world: WorldState, companyId: string): CompanyHolderSummary[] {
  const classes = classesOfCompany(world, companyId);
  const kindByClass = new Map(classes.map((shareClass) => [shareClass.id, shareClass.kind]));
  const map = new Map<string, CompanyHolderSummary>();
  for (const holding of world.securities.holdings) {
    if (holding.companyId !== companyId || holding.shares <= 0) continue;
    const kind = kindByClass.get(holding.shareClassId);
    if (!kind) continue;
    const key = holderKey(holding.holder);
    const entry = map.get(key) ?? {
      holder: holding.holder,
      votingShares: 0,
      nonVotingShares: 0,
      totalShares: 0,
    };
    if (kind === 'voting') entry.votingShares = round2(entry.votingShares + holding.shares);
    else entry.nonVotingShares = round2(entry.nonVotingShares + holding.shares);
    entry.totalShares = round2(entry.votingShares + entry.nonVotingShares);
    map.set(key, entry);
  }
  return [...map.values()].sort(
    (a, b) =>
      b.totalShares - a.totalShares ||
      a.holder.type.localeCompare(b.holder.type) ||
      a.holder.id.localeCompare(b.holder.id),
  );
}

/** 投票权持有人，按票数降序；票数来自 voting 类别的持股。 */
export function votingHoldersOf(
  world: WorldState,
  companyId: string,
): { holder: HolderRef; shares: number }[] {
  return companyHolders(world, companyId)
    .filter((entry) => entry.votingShares > 0)
    .map((entry) => ({ holder: entry.holder, shares: entry.votingShares }))
    .sort(
      (a, b) =>
        b.shares - a.shares ||
        a.holder.type.localeCompare(b.holder.type) ||
        a.holder.id.localeCompare(b.holder.id),
    );
}

export function holderVotingShares(world: WorldState, companyId: string, holder: HolderRef): number {
  const entry = companyHolders(world, companyId).find((candidate) => sameHolder(candidate.holder, holder));
  return entry?.votingShares ?? 0;
}

export function holderTotalShares(world: WorldState, companyId: string, holder: HolderRef): number {
  const entry = companyHolders(world, companyId).find((candidate) => sameHolder(candidate.holder, holder));
  return entry?.totalShares ?? 0;
}

export function playerTotalShares(world: WorldState, companyId: string): number {
  return holderTotalShares(world, companyId, { type: 'player', id: 'player' });
}

export function playerVotingShares(world: WorldState, companyId: string): number {
  return holderVotingShares(world, companyId, { type: 'player', id: 'player' });
}

export function playerStakeOf(world: WorldState, companyId: string): number {
  const company = world.companies.find((candidate) => candidate.id === companyId);
  if (!company || company.totalShares <= 0) return 0;
  return playerTotalShares(world, companyId) / company.totalShares;
}

export function holderCash(world: WorldState, holder: HolderRef): number {
  if (holder.type === 'player') return world.player.cash;
  if (holder.type === 'company') {
    return world.companies.find((company) => company.id === holder.id)?.cash ?? 0;
  }
  return world.investors.find((group) => group.id === holder.id)?.cash ?? 0;
}

export function creditHolderCash(world: WorldState, holder: HolderRef, amount: number): void {
  const value = round2(amount);
  if (value === 0) return;
  if (holder.type === 'player') {
    world.player.cash = round2(world.player.cash + value);
  } else if (holder.type === 'company') {
    const company = world.companies.find((candidate) => candidate.id === holder.id);
    if (company) company.cash = round2(company.cash + value);
  } else {
    const group = world.investors.find((candidate) => candidate.id === holder.id);
    if (group) group.cash = round2(group.cash + value);
  }
}

export function debitHolderCash(world: WorldState, holder: HolderRef, amount: number): boolean {
  const value = round2(amount);
  if (value <= 0) return true;
  if (holderCash(world, holder) < value - 1e-6) return false;
  creditHolderCash(world, holder, -value);
  return true;
}

/** 由证券权威数据重建玩家持股镜像，保持既有 UI 与存档字段可用。 */
export function syncPlayerHoldings(world: WorldState): void {
  const map = new Map<string, number>();
  for (const holding of world.securities.holdings) {
    if (!sameHolder(holding.holder, { type: 'player', id: 'player' })) continue;
    if (holding.shares <= 0) continue;
    map.set(holding.companyId, round2((map.get(holding.companyId) ?? 0) + holding.shares));
  }
  const next: PlayerHolding[] = [...map.entries()]
    .filter(([, shares]) => shares > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([companyId, shares]) => ({ companyId, shares }));
  world.player.holdings = next;
}

export function syncCompanyTotalShares(world: WorldState, company: Company): void {
  company.totalShares = companyIssuedShares(world, company.id);
}

export function syncAllCompanyShares(world: WorldState): void {
  for (const company of world.companies) syncCompanyTotalShares(world, company);
  syncPlayerHoldings(world);
}

export function addShares(
  world: WorldState,
  input: {
    companyId: string;
    shareClassId: string;
    holder: HolderRef;
    shares: number;
    acquiredVia: ShareHolding['acquiredVia'];
    tick: number;
  },
): void {
  const shares = round2(input.shares);
  if (shares <= 0) return;
  const existing = findHolding(world, input.shareClassId, input.holder);
  if (existing) {
    existing.shares = round2(existing.shares + shares);
    return;
  }
  world.securities.holdings.push({
    companyId: input.companyId,
    shareClassId: input.shareClassId,
    holder: input.holder,
    shares,
    acquiredVia: input.acquiredVia,
    sinceTick: input.tick,
  });
}

export function removeShares(
  world: WorldState,
  shareClassIdValue: string,
  holder: HolderRef,
  shares: number,
): boolean {
  const holding = findHolding(world, shareClassIdValue, holder);
  if (!holding || holding.shares + 1e-6 < shares) return false;
  holding.shares = round2(holding.shares - shares);
  if (holding.shares <= 1e-6) {
    world.securities.holdings = world.securities.holdings.filter((entry) => entry !== holding);
  }
  return true;
}

/** 建立企业股份结构。调用方负责保证双方合计等于期望发行量。 */
export function createShareStructure(
  world: WorldState,
  company: Company,
  input: {
    votingShares: number;
    nonVotingShares: number;
    votingHolders: { holder: HolderRef; shares: number }[];
    nonVotingHolders?: { holder: HolderRef; shares: number }[];
    tick: number;
    acquiredVia?: ShareHolding['acquiredVia'];
  },
): void {
  const voting = shareClassId(company.id, 'voting');
  const nonVoting = shareClassId(company.id, 'nonVoting');
  world.securities.classes = world.securities.classes.filter(
    (shareClass) => shareClass.companyId !== company.id,
  );
  world.securities.holdings = world.securities.holdings.filter(
    (holding) => holding.companyId !== company.id,
  );
  world.securities.classes.push(
    {
      id: voting,
      companyId: company.id,
      kind: 'voting',
      issuedShares: round2(input.votingShares),
      note: '有投票权股份（暂定：每股一票，按股分红）。',
    },
    {
      id: nonVoting,
      companyId: company.id,
      kind: 'nonVoting',
      issuedShares: round2(input.nonVotingShares),
      note: '仅分红股份（暂定：无投票权，按股分红）。',
    },
  );
  for (const entry of input.votingHolders) {
    addShares(world, {
      companyId: company.id,
      shareClassId: voting,
      holder: entry.holder,
      shares: entry.shares,
      acquiredVia: input.acquiredVia ?? 'migration',
      tick: input.tick,
    });
  }
  for (const entry of input.nonVotingHolders ?? []) {
    addShares(world, {
      companyId: company.id,
      shareClassId: nonVoting,
      holder: entry.holder,
      shares: entry.shares,
      acquiredVia: input.acquiredVia ?? 'migration',
      tick: input.tick,
    });
  }
  syncCompanyTotalShares(world, company);
  syncPlayerHoldings(world);
}

export function bookPrice(world: WorldState, company: Company): number {
  const city = world.cities.find((candidate) => candidate.id === company.cityId);
  if (!city) return Math.max(1, round2(company.cash / Math.max(1, company.totalShares)));
  return companySharePrice(company, cityMarketPrices(city));
}

export function issueShares(
  world: WorldState,
  company: Company,
  kind: ShareKind,
  holder: HolderRef,
  shares: number,
  tick: number,
): void {
  const shareClass = classOf(world, company.id, kind);
  if (!shareClass) throw new Error(`企业 ${company.id} 缺少 ${kind} 股份类别`);
  const quantity = round2(shares);
  if (quantity <= 0) throw new Error('发行股数必须为正');
  shareClass.issuedShares = round2(shareClass.issuedShares + quantity);
  addShares(world, {
    companyId: company.id,
    shareClassId: shareClass.id,
    holder,
    shares: quantity,
    acquiredVia: 'primary',
    tick,
  });
  syncCompanyTotalShares(world, company);
  syncPlayerHoldings(world);
}

export function transferShares(
  world: WorldState,
  companyId: string,
  shareClassIdValue: string,
  from: HolderRef,
  to: HolderRef,
  shares: number,
  tick: number,
): boolean {
  const quantity = round2(shares);
  if (quantity <= 0) return false;
  if (!removeShares(world, shareClassIdValue, from, quantity)) return false;
  addShares(world, {
    companyId,
    shareClassId: shareClassIdValue,
    holder: to,
    shares: quantity,
    acquiredVia: 'secondary',
    tick,
  });
  syncPlayerHoldings(world);
  return true;
}

export function companyTotalSharesFromClasses(world: WorldState, companyId: string): number {
  return companyIssuedShares(world, companyId);
}

// ---------------------------------------------------------------- 股息

export interface DividendResult {
  total: number;
  player: number;
  companies: number;
  investors: number;
  /** 居民投资实体收到的股息总额（按城市，未扣除返还部分）。 */
  investorByCity: Record<string, number>;
  /** 从投资实体资金中扣除并返还给居民可支配收入的部分（按城市）。 */
  investorDistributionByCity: Record<string, number>;
}

/**
 * 按实际持股分配一次性股息。两类股份按股同额，持有人与金额逐笔记录。
 * 合计严格等于 total（余数给最后一个持有人），因此玩家、企业、居民实体的所得不会重复或漏算。
 *
 * 居民投资实体收到的股息按配置比例拆成两部分：
 * - 返还部分直接从实体现金扣出，随后计入居民可支配收入（见 fiscal.ts）；
 * - 留存部分留在实体现金中用于投资。
 * 两部分互斥，避免同一笔股息同时用于消费和投资。
 */
export function distributeDividend(
  world: WorldState,
  company: Company,
  amount: number,
  tick: number,
  config: DemoConfig,
): DividendResult {
  const result: DividendResult = {
    total: 0,
    player: 0,
    companies: 0,
    investors: 0,
    investorByCity: {},
    investorDistributionByCity: {},
  };
  const total = round2(Math.max(0, amount));
  if (total <= 0 || company.totalShares <= 0) return result;

  const classes = classesOfCompany(world, company.id);
  const payouts: { holder: HolderRef; shares: number; value: number }[] = [];

  for (const shareClass of classes) {
    if (shareClass.issuedShares <= 0) continue;
    const holdings = world.securities.holdings
      .filter((holding) => holding.shareClassId === shareClass.id && holding.shares > 0)
      .sort(
        (a, b) =>
          a.holder.type.localeCompare(b.holder.type) ||
          a.holder.id.localeCompare(b.holder.id),
      );
    for (const holding of holdings) {
      payouts.push({
        holder: holding.holder,
        shares: holding.shares,
        value: 0,
      });
    }
  }
  if (payouts.length === 0) return result;

  // 用实际持股合计作为分母：即使镜像字段暂时不一致，也不会凭空多付股息。
  const holdingTotal = payouts.reduce((totalShares, entry) => totalShares + entry.shares, 0);
  if (holdingTotal <= 0) return result;
  let paid = 0;
  const perShare = total / holdingTotal;
  for (let index = 0; index < payouts.length; index++) {
    const entry = payouts[index]!;
    const isLast = index === payouts.length - 1;
    const value = isLast ? round2(total - paid) : round2(entry.shares * perShare);
    const safe = Math.max(0, value);
    entry.value = safe;
    paid = round2(paid + safe);
  }

  for (const entry of payouts) {
    if (entry.value <= 0) continue;
    // 居民投资实体的股息在下面拆分（留存 / 返还），不能先整笔入账再扣减，
    // 否则同一笔钱会同时留在投资账户和进入居民收入。
    if (entry.holder.type !== 'investorGroup') {
      creditHolderCash(world, entry.holder, entry.value);
    }
    if (entry.holder.type === 'player') {
      world.player.lastDividend = round2((world.player.lastDividend ?? 0) + entry.value);
      world.player.dividendsReceived = round2((world.player.dividendsReceived ?? 0) + entry.value);
      result.player = round2(result.player + entry.value);
    } else if (entry.holder.type === 'company') {
      const holderCompany = world.companies.find(
        (candidate) => candidate.id === entry.holder.id,
      );
      if (holderCompany) {
        holderCompany.lastMonth.dividendIncome = round2(
          holderCompany.lastMonth.dividendIncome + entry.value,
        );
      }
      result.companies = round2(result.companies + entry.value);
    } else {
      const group = world.investors.find((candidate) => candidate.id === entry.holder.id);
      if (group) {
        // 返还居民的股息必须从实体资金中扣除，剩余才留作投资资金；两者互斥。
        const distribution = round2(entry.value * config.investors.dividendDistributionRate);
        const retained = round2(entry.value - distribution);
        group.cash = round2(group.cash + retained);
        group.lastDividend = round2(group.lastDividend + entry.value);
        group.dividendsReceived = round2(group.dividendsReceived + entry.value);
        result.investorByCity[group.cityId] = round2(
          (result.investorByCity[group.cityId] ?? 0) + entry.value,
        );
        result.investorDistributionByCity[group.cityId] = round2(
          (result.investorDistributionByCity[group.cityId] ?? 0) + distribution,
        );
      }
      result.investors = round2(result.investors + entry.value);
    }
  }

  result.total = round2(paid);
  if (tick >= 0 && result.total > 0) {
    // 股息归属不需要额外记录到 world；企业和居民实体已各自入账。
  }
  return result;
}

// ---------------------------------------------------------------- 融资要约

export interface OfferResult {
  ok: boolean;
  error?: string;
  offerId?: string;
  shares?: number;
}

/** 逐出资方创建融资要约；接受前不改变任何资金或股份。 */
export function createFinancingOffer(
  world: WorldState,
  input: {
    companyId: string;
    investor: HolderRef;
    kind: ShareKind;
    amount: number;
    pricePerShare: number;
    tick: number;
    note?: string;
  },
): OfferResult {
  const company = world.companies.find((candidate) => candidate.id === input.companyId);
  if (!company) return { ok: false, error: '企业不存在' };
  if (!holderExists(world, input.investor)) return { ok: false, error: '出资方无效' };
  if (input.investor.type === 'player' && input.investor.id !== 'player') {
    return { ok: false, error: '出资方无效' };
  }
  // 融资可由企业出资并获得仅分红股份（用户已确认：逐出资方约定权利）；
  // “企业买入必须有投票权”只约束股票市场买入，不约束融资。
  const price = round2(input.pricePerShare);
  const amount = round2(input.amount);
  if (!Number.isFinite(price) || price <= 0) return { ok: false, error: '发行价无效' };
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: '融资金额无效' };
  const shares = Math.floor(amount / price);
  if (shares < 1) return { ok: false, error: '金额不足一股' };
  const exactAmount = round2(shares * price);
  if (exactAmount > amount + 0.01) return { ok: false, error: '金额与股数不一致' };

  const id = `offer-${world.time.tick}-${input.companyId}-${world.securities.offers.length + 1}`;
  world.securities.offers.push({
    id,
    companyId: input.companyId,
    investor: input.investor,
    kind: input.kind,
    amount: exactAmount,
    pricePerShare: price,
    shares,
    status: 'open',
    createdTick: input.tick,
    note: input.note ?? '融资要约（暂定：逐出资方约定是否给予投票权）',
  });
  return { ok: true, offerId: id, shares };
}

export function acceptFinancingOffer(
  world: WorldState,
  offerId: string,
  tick: number,
): OfferResult {
  const offer = world.securities.offers.find((candidate) => candidate.id === offerId);
  if (!offer) return { ok: false, error: '融资要约不存在' };
  if (offer.status !== 'open') return { ok: false, error: '融资要约已结束' };
  const company = world.companies.find((candidate) => candidate.id === offer.companyId);
  if (!company) return { ok: false, error: '企业不存在' };
  if (holderCash(world, offer.investor) + 1e-6 < offer.amount) {
    return { ok: false, error: '出资方现金不足' };
  }

  // ---- 提交：资金进入发行企业，新股份支付给出资方 ----
  if (!debitHolderCash(world, offer.investor, offer.amount)) {
    return { ok: false, error: '出资方现金不足' };
  }
  company.cash = round2(company.cash + offer.amount);
  issueShares(world, company, offer.kind, offer.investor, offer.shares, tick);
  offer.status = 'accepted';
  world.securities.lastTrades.push({
    id: `primary-${tick}-${offer.id}`,
    tick,
    companyId: company.id,
    shareClassId: shareClassId(company.id, offer.kind),
    buyer: offer.investor,
    seller: { type: 'company', id: company.id },
    shares: offer.shares,
    unitPrice: offer.pricePerShare,
    value: offer.amount,
    origin: 'primary',
  });
  return { ok: true, offerId: offer.id, shares: offer.shares };
}

export function declineFinancingOffer(world: WorldState, offerId: string): OfferResult {
  const offer = world.securities.offers.find((candidate) => candidate.id === offerId);
  if (!offer) return { ok: false, error: '融资要约不存在' };
  if (offer.status !== 'open') return { ok: false, error: '融资要约已结束' };
  offer.status = 'declined';
  return { ok: true, offerId };
}

// ---------------------------------------------------------------- 二级市场

export interface OrderInput {
  companyId: string;
  shareClassId: string;
  side: 'buy' | 'sell';
  holder: HolderRef;
  shares: number;
  limitPrice: number;
  tick: number;
  note?: string;
}

export function placeOrder(world: WorldState, input: OrderInput): { ok: boolean; error?: string; orderId?: string } {
  const shareClass = classById(world, input.shareClassId);
  if (!shareClass || shareClass.companyId !== input.companyId) {
    return { ok: false, error: '股份类别无效' };
  }
  const shares = Math.round(input.shares);
  if (!Number.isFinite(shares) || shares <= 0) return { ok: false, error: '股数无效' };
  const price = round2(input.limitPrice);
  if (!Number.isFinite(price) || price <= 0) return { ok: false, error: '价格无效' };
  if (input.side === 'buy' && input.holder.type === 'company' && shareClass.kind !== 'voting') {
    return { ok: false, error: '企业作为买方在股票市场只能买入有投票权股份' };
  }
  if (input.side === 'buy') {
    if (holderCash(world, input.holder) + 1e-6 < round2(shares * price)) {
      return { ok: false, error: '买方现金不足' };
    }
  } else {
    const holding = findHolding(world, input.shareClassId, input.holder);
    if (!holding || holding.shares + 1e-6 < shares) return { ok: false, error: '卖方持股不足' };
  }
  const id = `order-${input.tick}-${input.companyId}-${input.side}-${world.securities.orders.length + 1}`;
  world.securities.orders.push({
    id,
    companyId: input.companyId,
    shareClassId: input.shareClassId,
    side: input.side,
    holder: input.holder,
    shares,
    limitPrice: price,
    createdTick: input.tick,
    note: input.note ?? '二级市场订单（撮合时才划转资金与股份）',
  });
  return { ok: true, orderId: id };
}

function purgeStaleOrders(world: WorldState, tick: number, config: DemoConfig): void {
  world.securities.orders = world.securities.orders.filter(
    (order) => order.shares > 0 && tick - order.createdTick <= config.securities.orderTtlTicks,
  );
}

/**
 * 确定性撮合：买方限价 ≥ 卖方限价才成交，成交价为卖方限价。
 * 每笔成交都在提交前校验买方现金与卖方持股；不足则缩减数量或跳过，不产生部分扣款。
 */
export function matchOrders(world: WorldState, tick: number, config: DemoConfig): StockTrade[] {
  purgeStaleOrders(world, tick, config);
  const trades: StockTrade[] = [];
  const groups = new Map<string, StockOrder[]>();
  for (const order of world.securities.orders) {
    const key = order.shareClassId;
    const list = groups.get(key) ?? [];
    list.push(order);
    groups.set(key, list);
  }

  for (const key of [...groups.keys()].sort()) {
    const orders = groups.get(key) ?? [];
    const buys = orders
      .filter((order) => order.side === 'buy')
      .sort((a, b) => b.limitPrice - a.limitPrice || a.id.localeCompare(b.id));
    const sells = orders
      .filter((order) => order.side === 'sell')
      .sort((a, b) => a.limitPrice - b.limitPrice || a.id.localeCompare(b.id));
    let matched = 0;
    for (const buy of buys) {
      if (trades.length >= config.securities.maxTradesPerTick) break;
      if (buy.shares <= 0) continue;
      const shareClass = classById(world, key);
      if (!shareClass) break;
      if (buy.holder.type === 'company' && shareClass.kind !== 'voting') {
        buy.shares = 0;
        continue;
      }

      // 只与“不同持有人”的卖单成交，避免居民投资实体自己和自己对倒消耗市场流动性。
      let sell = sells.find(
        (candidate) =>
          candidate.shares > 0 &&
          !sameHolder(candidate.holder, buy.holder) &&
          candidate.limitPrice <= buy.limitPrice + 1e-9,
      );
      while (sell && buy.shares > 0 && trades.length < config.securities.maxTradesPerTick) {
        const sellerHolding = findHolding(world, key, sell.holder);
        const sellerAvailable = sellerHolding?.shares ?? 0;
        const buyerCash = holderCash(world, buy.holder);
        const maxByCash = Math.floor(buyerCash / sell.limitPrice + 1e-9);
        let quantity = Math.min(buy.shares, sell.shares, sellerAvailable, maxByCash);
        quantity = Math.floor(quantity);
        if (quantity <= 0) {
          if (sellerAvailable <= 0) {
            sell.shares = 0;
          } else {
            buy.shares = 0;
            break;
          }
        } else {
          const value = round2(quantity * sell.limitPrice);
          if (!debitHolderCash(world, buy.holder, value)) {
            buy.shares = 0;
            break;
          }
          if (!transferShares(world, buy.companyId, key, sell.holder, buy.holder, quantity, tick)) {
            creditHolderCash(world, buy.holder, value);
            sell.shares = 0;
          } else {
            creditHolderCash(world, sell.holder, value);
            buy.shares = Math.max(0, buy.shares - quantity);
            sell.shares = Math.max(0, sell.shares - quantity);
            matched += 1;
            trades.push({
              id: `trade-${tick}-${key}-${trades.length + 1}`,
              tick,
              companyId: buy.companyId,
              shareClassId: key,
              buyer: buy.holder,
              seller: sell.holder,
              shares: quantity,
              unitPrice: sell.limitPrice,
              value,
              origin: 'secondary',
            });
          }
        }
        if (buy.shares <= 0) break;
        sell = sells.find(
          (candidate) =>
            candidate.shares > 0 &&
            !sameHolder(candidate.holder, buy.holder) &&
            candidate.limitPrice <= buy.limitPrice + 1e-9,
        );
      }
      if (matched >= config.securities.maxTradesPerTick) break;
    }
  }

  purgeStaleOrders(world, tick, config);
  for (const trade of trades) world.securities.lastTrades.push(trade);
  return trades;
}

/**
 * 玩家（或其他主体）立即买卖：先下单再撮合，返回实际成交结果。
 * 未成交部分保留为挂单，直到过期；不会冻结资金或股份。
 */
export function tradeImmediately(
  world: WorldState,
  input: OrderInput,
  config: DemoConfig,
): { ok: boolean; error?: string; shares: number; unitPrice: number; value: number; orderId?: string } {
  const placed = placeOrder(world, input);
  if (!placed.ok) {
    return { ok: false, error: placed.error, shares: 0, unitPrice: 0, value: 0 };
  }
  const before = world.securities.lastTrades.length;
  const trades = matchOrders(world, input.tick, config);
  const mine = trades.filter(
    (trade) =>
      (trade.buyer.type === input.holder.type && trade.buyer.id === input.holder.id) ||
      (trade.seller.type === input.holder.type && trade.seller.id === input.holder.id),
  );
  if (mine.length === 0) {
    return {
      ok: true,
      shares: 0,
      unitPrice: 0,
      value: 0,
      orderId: placed.orderId,
    };
  }
  void before;
  const shares = round2(mine.reduce((total, trade) => total + trade.shares, 0));
  const value = round2(mine.reduce((total, trade) => total + trade.value, 0));
  const unitPrice = shares > 0 ? round2(value / shares) : 0;
  return { ok: true, shares, unitPrice, value, orderId: placed.orderId };
}

export function openOrdersFor(world: WorldState, companyId: string): StockOrder[] {
  return world.securities.orders
    .filter((order) => order.companyId === companyId && order.shares > 0)
    .sort(
      (a, b) =>
        a.side.localeCompare(b.side) ||
        a.limitPrice - b.limitPrice ||
        a.id.localeCompare(b.id),
    );
}

export function openOffersFor(world: WorldState, companyId?: string): typeof world.securities.offers {
  return world.securities.offers.filter(
    (offer) => offer.status === 'open' && (companyId === undefined || offer.companyId === companyId),
  );
}

/** 居民投资实体的持股汇总（用于一致性检查与界面之外的调试）。 */
export function investorHoldings(world: WorldState, group: InvestorGroup): ShareHolding[] {
  return world.securities.holdings.filter(
    (holding) => holding.holder.type === 'investorGroup' && holding.holder.id === group.id,
  );
}
