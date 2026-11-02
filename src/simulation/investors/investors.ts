// 居民投资实体：每座城市若干群体，持有可投资资金和股票，参与融资与二级买卖。
// 普通居民不逐个建模；群体不是额外人口，populationShare 只用于分配居民收入。
//
// 暂定演示规则（待用户决定）：
// - 每月从城市居民可支配收入中按 savingsRate 转入投资实体，剩余才用于下月消费。
// - 实体收到的股息按 dividendDistributionRate 返还居民收入，其余留存投资。
// - 自动投资规则可替换：优先买入有投票权股份，接近持股上限时买仅分红股份；
//   同时每月卖出极小比例持股作为市场流动性。
// - 跨城买股、阈值、风险偏好均为演示参数。

import type { Company, HolderRef, InvestorGroup, LogEntry, WorldState } from '../contracts/types';
import type { DemoConfig } from '../../data/config';
import { allocateProportionally, round2 } from '../core/math';
import { debitHouseholdSavings } from '../population/household-economy';
import { monthlyWageBill } from '../companies/company';
import { PRODUCTIVITY } from '../../data/demo-data';
import {
  acceptFinancingOffer,
  bookPrice,
  companyHolders,
  createFinancingOffer,
  declineFinancingOffer,
  holderTotalShares,
  holderVotingShares,
  placeOrder,
} from '../securities/securities';

const GROUP_NAME_SUFFIX = ['储蓄互助会', '工薪投资者联盟', '城市养老基金'];

export const PLAYER_HOLDER: HolderRef = { type: 'player', id: 'player' };

export function groupHolder(group: InvestorGroup): HolderRef {
  return { type: 'investorGroup', id: group.id };
}

export function groupsOfCity(world: WorldState, cityId: string): InvestorGroup[] {
  return world.investors
    .filter((group) => group.cityId === cityId)
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** 按比例分配金额并保证合计严格相等（余数给最后一个）。 */
function allocateMoney(total: number, weights: number[]): number[] {
  const counts = allocateProportionally(100_000, weights);
  const result = counts.map((count) => round2((total * count) / 100_000));
  const paid = round2(result.reduce((sum, value) => sum + value, 0));
  if (result.length > 0) {
    const last = result.length - 1;
    result[last] = round2((result[last] ?? 0) + (total - paid));
  }
  return result;
}

/**
 * 建立每座城市的居民投资实体。
 * 新世界初始化时给予演示初始资金（类比玩家初始现金）；旧存档迁移时 endow=false，
 * 不凭空创造资金，迁移前已存在的居民股息流由后续分红继续承接。
 */
export function createInvestorGroups(
  world: WorldState,
  config: DemoConfig,
  options: { endow?: boolean } = {},
): void {
  const endow = options.endow ?? true;
  const groups: InvestorGroup[] = [];
  for (const city of [...world.cities].sort((a, b) => a.id.localeCompare(b.id))) {
    const count = Math.max(1, config.investors.groupsPerCity);
    const weights = Array.from({ length: count }, (_, index) => count - index);
    const shares = weights.map((weight) => weight / weights.reduce((sum, value) => sum + value, 0));
    const endowment = endow
      ? round2(Math.max(0, city.householdIncomeLastMonth) * config.investors.initialCashIncomeMonths)
      : 0;
    const cashShares = allocateMoney(endowment, shares);
    for (let index = 0; index < count; index++) {
      const id = `${city.id}-invest${index + 1}`;
      groups.push({
        id,
        cityId: city.id,
        name: `${city.name}${GROUP_NAME_SUFFIX[index % GROUP_NAME_SUFFIX.length]}`,
        cash: cashShares[index] ?? 0,
        populationShare: shares[index] ?? 0,
        riskAppetite: round2(0.3 + index * 0.22),
        dividendsReceived: 0,
        lastDividend: 0,
        note: '居民投资实体（演示）：代表一部分居民，不逐人建模；内部明细不在玩家界面展示。',
      });
    }
  }
  world.investors = groups;
}

export function totalInvestorDividendsByCity(world: WorldState): Record<string, number> {
  const result: Record<string, number> = {};
  for (const group of world.investors) {
    result[group.cityId] = round2((result[group.cityId] ?? 0) + group.lastDividend);
  }
  return result;
}

/**
 * 从居民可支配收入中转出可投资资金。
 * 这是资金在不同居民用途之间的划分，不增加货币总量：转入额从下月消费预算中扣除。
 */
export function collectInvestableFunds(world: WorldState, config: DemoConfig, log: LogEntry[]): void {
  for (const city of [...world.cities].sort((a, b) => a.id.localeCompare(b.id))) {
    const groups = groupsOfCity(world, city.id);
    if (groups.length === 0) continue;
    const income = Math.max(0, city.householdIncomeLastMonth);
    const desiredContribution = round2(income * config.investors.savingsRate);
    // v0.4：储蓄是真实转账——先从居民群体现金扣出，再进入投资实体；
    // 群体现金不足时按实际可转出额缩小，不凭空创造资金。
    const contribution = debitHouseholdSavings(world, city, desiredContribution);
    if (contribution > 0) {
      const amounts = allocateMoney(contribution, groups.map((group) => group.populationShare));
      groups.forEach((group, index) => {
        group.cash = round2(group.cash + (amounts[index] ?? 0));
      });
    }
    city.householdIncomeLastMonth = round2(
      Math.max(0, city.householdIncomeLastMonth - contribution),
    );
    city.lastMonth.investableContribution = contribution;
    city.lastMonth.investorDividends = totalInvestorDividendsByCity(world)[city.id] ?? 0;
    if (contribution > 0) {
      log.push({
        tick: world.time.tick,
        kind: 'government',
        message: `${city.name} 居民本月转入投资实体 ${contribution.toFixed(0)} 信用点（占可支配收入 ${(config.investors.savingsRate * 100).toFixed(0)}%）。`,
      });
    }
  }
}

/** 每月按最新账面价重挂自动订单，避免旧限价长期偏离市场。 */
function clearOrders(
  world: WorldState,
  holder: HolderRef,
  shareClassIdValue: string,
  side: 'buy' | 'sell',
): void {
  world.securities.orders = world.securities.orders.filter(
    (order) =>
      !(
        order.side === side &&
        order.shareClassId === shareClassIdValue &&
        order.holder.type === holder.type &&
        order.holder.id === holder.id
      ),
  );
}

function pickCompanyForGroup(
  world: WorldState,
  group: InvestorGroup,
  tick: number,
  offset: number,
): Company | null {
  const candidates = [...world.companies]
    .filter((company) => company.totalShares > 0)
    .sort((a, b) => a.id.localeCompare(b.id));
  if (candidates.length === 0) return null;
  const index = (tick + offset + group.id.length) % candidates.length;
  return candidates[index] ?? null;
}

/** 居民投资实体每月自动下单（可替换规则，不是逐居民 AI）。 */
export function planInvestorOrders(world: WorldState, config: DemoConfig, tick: number): void {
  const groups = [...world.investors].sort((a, b) => a.id.localeCompare(b.id));
  for (const group of groups) {
    const holder = groupHolder(group);
    if (!group.cash || group.cash <= 0) continue;

    // 1) 市场流动性：卖出极少量持仓，给其他投资者（含玩家）提供可买股份。
    for (const company of [...world.companies].sort((a, b) => a.id.localeCompare(b.id))) {
      const shareClass = world.securities.classes.find(
        (candidate) => candidate.companyId === company.id && candidate.kind === 'voting',
      );
      if (!shareClass) continue;
      const holding = world.securities.holdings.find(
        (entry) =>
          entry.shareClassId === shareClass.id &&
          entry.holder.type === 'investorGroup' &&
          entry.holder.id === group.id,
      );
      if (!holding || holding.shares < 10) continue;
      const shares = Math.floor(holding.shares * config.investors.liquiditySellShare);
      if (shares < 1) continue;
      clearOrders(world, holder, shareClass.id, 'sell');
      placeOrder(world, {
        companyId: company.id,
        shareClassId: shareClass.id,
        side: 'sell',
        holder,
        shares,
        limitPrice: round2(bookPrice(world, company) * 1.02),
        tick,
        note: `${group.name} 提供流动性（演示自动规则）`,
      });
    }

    if (group.cash < config.investors.minCashToInvest) continue;
    const budget = round2(group.cash * config.investors.buyBudgetShare);
    if (budget <= 0) continue;

    // 2) 自动买入：优先有投票权类别；接近投票权上限时改买仅分红类别。
    for (let attempt = 0; attempt < 2; attempt++) {
      const company = pickCompanyForGroup(world, group, tick, attempt);
      if (!company) continue;
      const votingStake =
        company.totalShares > 0 ? holderVotingShares(world, company.id, holder) / company.totalShares : 0;
      const atCap = votingStake >= config.investors.maxVotingStakeShare * 0.85;
      const shareClass = world.securities.classes.find(
        (candidate) =>
          candidate.companyId === company.id && candidate.kind === (atCap ? 'nonVoting' : 'voting'),
      );
      if (!shareClass) continue;
      const price = round2(bookPrice(world, company) * (1 - config.investors.orderBidDiscount));
      if (price <= 0) continue;
      const shares = Math.floor((budget / 2) / price);
      if (shares < 1) continue;
      if (!atCap) {
        const projected =
          company.totalShares > 0
            ? (holderVotingShares(world, company.id, holder) + shares) / company.totalShares
            : 0;
        if (projected > config.investors.maxVotingStakeShare) continue;
      }
      clearOrders(world, holder, shareClass.id, 'buy');
      placeOrder(world, {
        companyId: company.id,
        shareClassId: shareClass.id,
        side: 'buy',
        holder,
        shares,
        limitPrice: price,
        tick,
        note: `${group.name} 自动投资（演示规则）`,
      });
    }
  }
}

/**
 * 企业作为股票市场买方：只允许买入有投票权类别（用户已确认的规则）。
 * 演示中现金充裕的企业会小额买入其他城市的投票权股份。
 */
export function planCompanyOrders(world: WorldState, config: DemoConfig, tick: number): void {
  const rich = [...world.companies]
    .filter((company) => company.cash > monthlyWageBill(company, config) * 3)
    .sort((a, b) => b.cash - a.cash || a.id.localeCompare(b.id))
    .slice(0, 3);
  for (const company of rich) {
    const candidates = [...world.companies]
      .filter((candidate) => candidate.id !== company.id && candidate.totalShares > 0)
      .sort((a, b) => a.id.localeCompare(b.id));
    if (candidates.length === 0) continue;
    const target = candidates[(tick + company.id.length) % candidates.length];
    if (!target) continue;
    const shareClass = world.securities.classes.find(
      (candidate) => candidate.companyId === target.id && candidate.kind === 'voting',
    );
    if (!shareClass) continue;
    const holder: HolderRef = { type: 'company', id: company.id };
    const price = round2(bookPrice(world, target) * 1.03);
    const budget = Math.min(round2(company.cash * 0.05), 500_000);
    const shares = Math.floor(budget / Math.max(0.01, price));
    if (shares < 1) continue;
    clearOrders(world, holder, shareClass.id, 'buy');
    placeOrder(world, {
      companyId: target.id,
      shareClassId: shareClass.id,
      side: 'buy',
      holder,
      shares,
      limitPrice: price,
      tick,
      note: `${company.name} 作为企业买方买入投票权股份（演示）`,
    });
  }
}

/** 融资要约为企业提供逐出资方的股份类别；接受前不改变任何资产。 */
export function maybeCreateCompanyFinancing(
  world: WorldState,
  config: DemoConfig,
  tick: number,
  log: LogEntry[],
): void {
  const ordered = [...world.companies].sort((a, b) => a.id.localeCompare(b.id));
  let created = 0;
  for (const company of ordered) {
    if (created >= 2) break;
    const wage = monthlyWageBill(company, config);
    // 现金低于两个月工资时视为需要融资（演示阈值）。
    if (company.cash >= wage * 2) continue;
    const open = world.securities.offers.some(
      (offer) => offer.companyId === company.id && offer.status === 'open',
    );
    if (open) continue;
    const recent = world.securities.offers
      .filter((offer) => offer.companyId === company.id)
      .reduce((latest, offer) => Math.max(latest, offer.createdTick), -999);
    if (tick - recent < 3) continue;

    const cityGroups = groupsOfCity(world, company.cityId).sort(
      (a, b) => b.cash - a.cash || a.id.localeCompare(b.id),
    );
    const group = cityGroups[0];
    const price = bookPrice(world, company);
    let offers = 0;
    if (group && group.cash > 0) {
      const amount = Math.min(round2(wage * 2), 1_500_000, group.cash);
      if (amount > 0) {
        const result = createFinancingOffer(world, {
          companyId: company.id,
          investor: groupHolder(group),
          kind: 'nonVoting',
          amount,
          pricePerShare: price,
          tick,
          note: `${group.name} 的仅分红融资方案（逐出资方约定，无投票权）`,
        });
        if (result.ok) offers += 1;
      }
    }
    const external = [...world.companies]
      .filter(
        (candidate) =>
          candidate.id !== company.id &&
          candidate.cityId !== company.cityId &&
          candidate.cash > monthlyWageBill(candidate, config) * 3,
      )
      .sort((a, b) => b.cash - a.cash || a.id.localeCompare(b.id))[0];
    if (external) {
      const amount = Math.min(round2(wage), 800_000, round2(external.cash * 0.1));
      if (amount > 0) {
        const result = createFinancingOffer(world, {
          companyId: company.id,
          investor: { type: 'company', id: external.id },
          kind: 'voting',
          amount,
          pricePerShare: price,
          tick,
          note: `${external.name} 的融资方案（有投票权；企业买方必须取得投票权）`,
        });
        if (result.ok) offers += 1;
      }
    }

    // 给玩家的融资要约：提供实际可操作的接受/拒绝入口（个人融资权利仍为暂定）。
    const openPlayerOffers = world.securities.offers.filter(
      (offer) => offer.status === 'open' && offer.investor.type === 'player',
    ).length;
    if (openPlayerOffers < 3 && world.player.cash > 200_000) {
      const amount = Math.min(round2(wage * 0.5), 300_000, round2(world.player.cash * 0.2));
      if (amount >= 10_000) {
        const result = createFinancingOffer(world, {
          companyId: company.id,
          investor: { type: 'player', id: 'player' },
          kind: 'voting',
          amount,
          pricePerShare: price,
          tick,
          note: '面向玩家的融资方案（暂定：个人出资取得有投票权股份）',
        });
        if (result.ok) offers += 1;
      }
    }
    if (offers > 0) {
      created += 1;
      log.push({
        tick,
        kind: 'market',
        message: `${company.name} 发布 ${offers} 份融资方案，分别约定不同股份权利。`,
      });
    }
  }
}

/** 居民投资实体与企业按演示规则回应融资要约；玩家需要自己决定。 */
export function autoDecideFinancingOffers(
  world: WorldState,
  config: DemoConfig,
  tick: number,
): void {
  // 玩家要约在若干期后失效，避免未处理的要约无限堆积。
  for (const offer of world.securities.offers) {
    if (
      offer.status === 'open' &&
      offer.investor.type === 'player' &&
      tick - offer.createdTick > 4
    ) {
      offer.status = 'expired';
    }
  }
  const offers = world.securities.offers
    .filter((offer) => offer.status === 'open' && offer.investor.type !== 'player')
    .sort((a, b) => a.id.localeCompare(b.id));
  for (const offer of offers) {
    const company = world.companies.find((candidate) => candidate.id === offer.companyId);
    if (!company) continue;
    const price = bookPrice(world, company);
    if (offer.investor.type === 'investorGroup') {
      const group = world.investors.find((candidate) => candidate.id === offer.investor.id);
      if (!group) continue;
      const affordable = group.cash + 1e-6 >= offer.amount;
      const acceptable = offer.pricePerShare <= price * (1 + config.investors.maxBuyPremium);
      const votingOk =
        offer.kind !== 'voting' ||
        company.totalShares <= 0 ||
        (holderVotingShares(world, company.id, offer.investor) + offer.shares) /
          company.totalShares <=
          config.investors.maxVotingStakeShare;
      if (affordable && acceptable && votingOk) {
        acceptFinancingOffer(world, offer.id, tick);
      } else {
        declineFinancingOffer(world, offer.id);
      }
      continue;
    }
    if (offer.investor.type === 'company') {
      const buyer = world.companies.find((candidate) => candidate.id === offer.investor.id);
      if (!buyer) continue;
      const affordable = buyer.cash >= offer.amount * 2;
      const acceptable = offer.pricePerShare <= price * 1.05;
      if (affordable && acceptable) {
        acceptFinancingOffer(world, offer.id, tick);
      } else {
        declineFinancingOffer(world, offer.id);
      }
    }
  }
}

/**
 * 群体迁移/人口变化的一致性说明：
 * populationShare 保持不变，representedPeople = 城市总人口 × share（派生值）。
 * 人口迁入迁出不会自动带走或带来投资实体资产；这是初期简化，交付文档中说明。
 */
export function representedPeople(world: WorldState, group: InvestorGroup): number {
  const city = world.cities.find((candidate) => candidate.id === group.cityId);
  return city ? Math.round(city.population.total * group.populationShare) : 0;
}

/** 供测试/审计：实体持有的股份总量（两类合计）。 */
export function groupTotalShares(world: WorldState, group: InvestorGroup): number {
  const holder = groupHolder(group);
  return round2(
    [...world.companies].reduce(
      (total, company) => total + holderTotalShares(world, company.id, holder),
      0,
    ),
  );
}

export function groupVotingSummary(world: WorldState, group: InvestorGroup): number {
  const holder = groupHolder(group);
  return round2(
    [...world.companies].reduce(
      (total, company) => total + holderVotingShares(world, company.id, holder),
      0,
    ),
  );
}

/** 仅用于诊断：实体在各企业的持股行数。 */
export function groupHoldingRows(world: WorldState, group: InvestorGroup): number {
  return world.securities.holdings.filter(
    (holding) => holding.holder.type === 'investorGroup' && holding.holder.id === group.id,
  ).length;
}

export function companyHolderCount(world: WorldState, companyId: string): number {
  return companyHolders(world, companyId).length;
}

/** 生产率的只读引用，避免某些 UI 需要额外 import 时重复实现。 */
export function companyProductivity(company: Company): number {
  return PRODUCTIVITY[company.recipeOutput] ?? 0;
}
