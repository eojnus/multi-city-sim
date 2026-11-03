// 居民投资实体：每座城市若干群体，持有可投资资金和股票，参与融资与二级买卖。
// 普通居民不逐个建模；群体不是额外人口，populationShare 只用于分配居民收入。
//
// 暂定演示规则（待用户决定）：
// - 每月从城市居民可支配收入中按 savingsRate 转入投资实体，剩余才用于下月消费。
// - 实体收到的股息按 dividendDistributionRate 返还居民收入，其余留存投资。
// - 自动投资规则可替换：投票权与仅分红两类股份都参与买卖打分；投票权接近持股上限时
//   只排除投票权买入，仅分红类别按股息收益率、折价、趋势与风险偏好独立评估；
//   两类股份每月都按真实持仓提供极小比例的流动性卖单（仅分红另有现金需求/股息惜售规则）。
// - 跨城买股、阈值、风险偏好均为演示参数。

import type { Company, HolderRef, InvestorGroup, LogEntry, ShareClass, WorldState } from '../contracts/types';
import type { DemoConfig } from '../../data/config';
import { allocateProportionally, clamp, round2 } from '../core/math';
import { debitHouseholdSavings } from '../population/household-economy';
import { companyBookValue, monthlyWageBill } from '../companies/company';
import { cityMarketPrices } from '../markets/markets';
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
import { latestStockPrice, stockHistoryFor } from '../securities/history';

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

/**
 * 确定性伪随机：只依赖世界种子与传入标识，不读取时钟、不使用 Math.random。
 * 用于同一评分下的稳定抖动，保证“相同种子 + 相同操作序列 = 相同结果”。
 */
function stableUnit(seed: number, ...parts: (string | number)[]): number {
  let hash = (seed >>> 0) ^ 0x9e3779b9;
  for (const part of parts) {
    const text = String(part);
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619) >>> 0;
    }
    hash = Math.imul(hash ^ 0x85ebca6b, 2246822519) >>> 0;
  }
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0x5bd1e995) >>> 0;
  hash ^= hash >>> 15;
  return (hash >>> 0) / 4294967296;
}

/** 最近一个完整月的利润：本月已结算则用 lastMonth，否则回退 previousMonth（只读演示口径）。 */
function recentProfit(company: Company): number {
  if (company.lastMonth.profit !== 0) return round2(company.lastMonth.profit);
  return round2(company.previousMonth.profit);
}

/** 用真实财务给单家企业估值：账面股权、负债/权益、最近利润与行情趋势（无成交时按账面价）。 */
interface CompanyFinancials {
  equity: number;
  profit: number;
  profitYield: number;
  debtRatio: number;
  price: number;
  lastPrice: number;
  /** 最近 lookbackMonths 根 K 线的收盘价变化率；无行情时为 0。 */
  momentum: number;
  /** 相对最近成交价的折价（>0 表示市价低于账面价）。 */
  valueGap: number;
}

function financialsOf(
  world: WorldState,
  company: Company,
  shareClassIdValue: string,
  config: DemoConfig,
): CompanyFinancials {
  const city = world.cities.find((candidate) => candidate.id === company.cityId);
  const equity = city ? round2(companyBookValue(company, cityMarketPrices(city))) : 0;
  const profit = recentProfit(company);
  const profitYield = equity > 0 ? round2(profit / equity) : 0;
  const debtRatio = equity > 0 ? round2(company.debt / equity) : Number.POSITIVE_INFINITY;
  const price = bookPrice(world, company);
  const lastPrice = latestStockPrice(world, shareClassIdValue) ?? price;
  const lookback = Math.max(1, Math.floor(config.securities.ai.lookbackMonths));
  const candles = stockHistoryFor(world, shareClassIdValue)?.candles ?? [];
  const window = candles.slice(-lookback);
  const first = window[0]?.close ?? lastPrice;
  const last = window[window.length - 1]?.close ?? lastPrice;
  const momentum = first > 0 ? round2(last / first - 1) : 0;
  const valueGap = lastPrice > 0 ? round2((price - lastPrice) / lastPrice) : 0;
  return { equity, profit, profitYield, debtRatio, price, lastPrice, momentum, valueGap };
}

/** 玩家经营企业判定（与 management/operations.canOperate 同口径；此处内联以避免模块循环依赖）。 */
function isPlayerOperated(world: WorldState, companyId: string): boolean {
  const control = world.governance?.controls?.find((entry) => entry.companyId === companyId);
  return !!control && control.operator !== 'management' && control.operator.type === 'player';
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

function votingClassOf(world: WorldState, companyId: string) {
  return world.securities.classes.find(
    (candidate) => candidate.companyId === companyId && candidate.kind === 'voting',
  );
}

/** 企业当前可交易的两类股份（存在才返回；顺序固定为仅分红在前，便于确定性排序）。 */
function classesForCompany(world: WorldState, companyId: string): ShareClass[] {
  return world.securities.classes
    .filter((candidate) => candidate.companyId === companyId)
    .sort((a, b) => a.kind.localeCompare(b.kind));
}

/**
 * 每股股息收益率：最近一个完整月的实际派息 ÷ 总股本 ÷ 参考价
 * （两类股份按持股比例分享同一笔分红）。
 *
 * 注意：收益率是无量纲比率（默认阈值 0.002 = 月 0.2%），必须保留足够精度再参与
 * 惜售阈值比较与买入评分；若先按货币精度（round2）舍入，0.0019~0.0021 这类真实
 * 收益率会被抹成 0 或 0.01，惜售规则与评分都会失真。金额与展示各自按需舍入。
 */
export function dividendYieldOf(company: Company, price: number): number {
  if (!(price > 0) || !(company.totalShares > 0)) return 0;
  const dividendPerShare = company.lastMonth.dividendsPaid / company.totalShares;
  if (!(dividendPerShare > 0)) return 0;
  const yieldValue = dividendPerShare / price;
  return Number.isFinite(yieldValue) ? yieldValue : 0;
}

/**
 * 仅分红股份的买入评分加成：基础偏好 + 股息率 × 权重（收益率保留原始精度）。
 * 独立导出以便测试精度；调用方仍按真实资金与撮合规则下单，不因此制造交易。
 */
export function nonVotingScoreBonus(yieldValue: number, config: DemoConfig): number {
  const ai = config.securities.ai;
  return ai.nonVotingBuyBias + Math.min(yieldValue, 0.1) * ai.nonVotingDividendWeight;
}

interface PlannedSell {
  company: Company;
  shareClass: ShareClass;
  shares: number;
  limitPrice: number;
  gainRatio: number;
  priority: number;
}

interface PlannedCandidate {
  company: Company;
  shareClassIdValue: string;
  kind: 'voting' | 'nonVoting';
  financials: CompanyFinancials;
  score: number;
}

/**
 * 居民投资实体的自动下单（可替换规则，不是逐居民 AI）。
 *
 * v0.8 改进：
 * - 用真实财务与行情决定买卖：账面股权、最近利润、负债/权益、最近成交价与 K 线趋势；
 * - 风险偏好（riskAppetite）与现金规模影响限价、预算与追涨/价值倾向；
 * - 只用真实现金与持仓（placeOrder 二次校验，撮合时再校验）；
 * - 每月每实体买单数受 maxBuyOrdersPerGroup、卖单数受 maxSellOrdersPerGroup 限制；
 * - 买入预算受 groupBudgetShare 限制，且不会在同一股份类别上同时挂买卖（避免自成交）。
 */
export function planInvestorOrders(world: WorldState, config: DemoConfig, tick: number): void {
  const ai = config.securities.ai;
  if (!ai.enabled) return;
  const groups = [...world.investors].sort((a, b) => a.id.localeCompare(b.id));
  const companies = [...world.companies].sort((a, b) => a.id.localeCompare(b.id));
  const maxBuy = Math.max(1, Math.floor(ai.maxBuyOrdersPerGroup));
  const maxSell = Math.max(1, Math.floor(ai.maxSellOrdersPerGroup));

  for (const group of groups) {
    const holder = groupHolder(group);
    const risk = clamp(group.riskAppetite, 0, 1);
    const sellingClasses = new Set<string>();
    let sellCount = 0;

    // 1) 卖出：投票权与仅分红两类股份各自按真实持仓提供流动性。
    //    v0.8.2 修复：此前只遍历 votingClassOf，仅分红股份永远不会被自动卖出。
    const cashPressed = group.cash < config.investors.minCashToInvest * ai.nonVotingCashPressureMultiple;
    const sellCandidates: PlannedSell[] = [];
    for (const company of companies) {
      const price = bookPrice(world, company);
      if (!Number.isFinite(price) || price <= 0) continue;
      for (const shareClass of classesForCompany(world, company.id)) {
        const holding = world.securities.holdings.find(
          (entry) =>
            entry.shareClassId === shareClass.id &&
            entry.holder.type === 'investorGroup' &&
            entry.holder.id === group.id,
        );
        if (!holding || holding.shares < 10) continue;
        const lastPrice = latestStockPrice(world, shareClass.id) ?? price;
        const gainRatio = price > 0 ? round2(lastPrice / price - 1) : 0;
        const nonVoting = shareClass.kind === 'nonVoting';
        let sellShare = nonVoting ? ai.nonVotingSellShare : config.investors.liquiditySellShare;
        let limitPremium: number = nonVoting ? ai.nonVotingSellLimitPremium : 1.02;
        let priority = gainRatio >= ai.takeProfitRatio ? 1.3 : 1;
        if (nonVoting) {
          // 现金需求：提高仅分红股份的卖出比例并接受小幅折价；高股息时惜售。
          if (cashPressed) {
            sellShare *= ai.nonVotingCashPressureBoost;
            limitPremium = ai.nonVotingCashPressureLimitPremium;
            priority += 0.5;
          }
          if (dividendYieldOf(company, price) >= ai.nonVotingDividendHoldThreshold) {
            sellShare *= ai.nonVotingDividendHoldFactor;
          }
        }
        if (gainRatio >= ai.takeProfitRatio) {
          // 市价明显高于账面价：落袋意愿随风险偏好上升（高风险更愿意卖出锁定收益）。
          sellShare *= 1.5 + risk;
        } else if (gainRatio <= -ai.takeProfitRatio) {
          // 市价明显低于账面价：惜售，减少流动性供给。
          sellShare *= 0.5;
        }
        const shares = Math.floor(holding.shares * clamp(sellShare, 0, 0.25));
        if (shares < 1) continue;
        const limitPrice = round2(price * limitPremium);
        if (!Number.isFinite(limitPrice) || limitPrice <= 0) continue;
        sellCandidates.push({ company, shareClass, shares, limitPrice, gainRatio, priority });
      }
    }
    // 卖出配额：仅分红至少 1 笔（现金需求时 2 笔），其余名额给投票权股份。
    // 投票权按公司 id 顺序覆盖不同企业（与旧行为一致，保证企业买方有可成交对手方），
    // 仅分红按优先级（现金需求/止盈）选择；两类换算互不挤占。
    const votingCandidates = sellCandidates
      .filter((candidate) => candidate.shareClass.kind === 'voting')
      .sort(
        (a, b) =>
          a.company.id.localeCompare(b.company.id) ||
          a.shareClass.id.localeCompare(b.shareClass.id),
      );
    const nonVotingCandidates = sellCandidates
      .filter((candidate) => candidate.shareClass.kind === 'nonVoting')
      .sort(
        (a, b) =>
          b.priority - a.priority ||
          a.company.id.localeCompare(b.company.id) ||
          a.shareClass.id.localeCompare(b.shareClass.id),
      );
    // 仅分红卖单与投票权卖单分开计数：投票权仍覆盖 maxSell 家企业（保持既有市场流动性），
    // 仅分红按现金需求挂 1–2 笔，两类互不挤占名额。
    const nonVotingQuota = Math.min(
      ai.nonVotingMaxSellOrdersPerGroup,
      cashPressed ? ai.nonVotingMaxSellOrdersPerGroup : 1,
    );
    const chosenSells: PlannedSell[] = [
      ...votingCandidates.slice(0, maxSell),
      ...nonVotingCandidates.slice(0, nonVotingQuota),
    ];
    chosenSells.sort(
      (a, b) =>
        a.shareClass.kind.localeCompare(b.shareClass.kind) ||
        a.company.id.localeCompare(b.company.id),
    );
    for (const candidate of chosenSells) {
      clearOrders(world, holder, candidate.shareClass.id, 'sell');
      const placed = placeOrder(world, {
        companyId: candidate.company.id,
        shareClassId: candidate.shareClass.id,
        side: 'sell',
        holder,
        shares: candidate.shares,
        limitPrice: candidate.limitPrice,
        tick,
        note: `${group.name} 按最新账面价提供流动性（${candidate.shareClass.kind === 'nonVoting' ? '仅分红' : '投票权'}${candidate.gainRatio >= ai.takeProfitRatio ? '，止盈' : ''}${cashPressed && candidate.shareClass.kind === 'nonVoting' ? '，现金需求' : ''}，演示自动规则）`,
      });
      if (placed.ok) {
        sellCount += 1;
        sellingClasses.add(candidate.shareClass.id);
      }
    }

    // 2) 买入：按真实财务 + 行情 + 风险偏好打分，预算与订单数受配置约束。
    if (group.cash < config.investors.minCashToInvest) continue;
    const budget = round2(group.cash * ai.groupBudgetShare);
    if (budget < 1) continue;

    const candidates: PlannedCandidate[] = [];
    for (const company of companies) {
      if (company.totalShares <= 0) continue;
      const votingStake =
        company.totalShares > 0
          ? holderVotingShares(world, company.id, holder) / company.totalShares
          : 0;
      const atCap = votingStake >= config.investors.maxVotingStakeShare * 0.85;
      // v0.8.2：两类股份都进入候选池；投票权接近持股上限时只排除投票权候选，
      // 仅分红类别仍按股息收益率、折价、趋势与风险偏好独立打分（不只是“被动兜底”）。
      for (const shareClass of classesForCompany(world, company.id)) {
        if (shareClass.kind === 'voting' && atCap) continue;
        if (sellingClasses.has(shareClass.id)) continue; // 同一类别不双向挂单，避免自成交
        const financials = financialsOf(world, company, shareClass.id, config);
        if (!Number.isFinite(financials.price) || financials.price <= 0) continue;
        // 低风险偏好更看重折价与盈利（价值），高风险偏好更愿意追趋势。
        const valueWeight = 1 - risk * 0.5;
        const trendWeight = risk * ai.riskWeight;
        const dividendYield = dividendYieldOf(company, financials.price);
        const classBonus =
          shareClass.kind === 'nonVoting' ? nonVotingScoreBonus(dividendYield, config) : 0;
        const score =
          financials.valueGap * valueWeight +
          clamp(financials.momentum, -0.3, 0.3) * trendWeight +
          financials.profitYield * (0.2 + risk * 0.2) +
          classBonus +
          stableUnit(world.seed, tick, group.id, company.id, shareClass.kind) * 0.01;
        candidates.push({
          company,
          shareClassIdValue: shareClass.id,
          kind: shareClass.kind,
          financials,
          // 评分只是排序用的无量纲值：保留原始精度（尤其股息率贡献），不按货币精度舍入。
          score,
        });
      }
    }
    candidates.sort(
      (a, b) =>
        b.score - a.score ||
        a.company.id.localeCompare(b.company.id) ||
        a.kind.localeCompare(b.kind),
    );

    let buyCount = 0;
    let remainingBudget = budget;
    for (const candidate of candidates) {
      if (buyCount >= maxBuy || remainingBudget < 1) break;
      const riskPremium = config.investors.orderBidDiscount * (1 - risk * ai.riskWeight);
      // 仅分红股份：股息偏好可以支付少量溢价；投票权仍按风险折价报价。
      const limitPrice = round2(
        candidate.financials.price *
          (candidate.kind === 'nonVoting' ? 1 - riskPremium + ai.nonVotingBidPremium : 1 - riskPremium),
      );
      if (!Number.isFinite(limitPrice) || limitPrice <= 0) continue;
      // 第一笔用 60% 预算，第二笔用剩余；总额严格不超过 groupBudgetShare 预算。
      const orderBudget =
        buyCount === 0 && maxBuy > 1 ? round2(remainingBudget * 0.6) : remainingBudget;
      let shares = Math.floor(orderBudget / limitPrice);
      if (shares < 1) continue;
      if (candidate.kind === 'voting') {
        const currentVoting = holderVotingShares(world, candidate.company.id, holder);
        const maxByStake = Math.floor(
          config.investors.maxVotingStakeShare * candidate.company.totalShares - currentVoting,
        );
        shares = Math.min(shares, Math.max(0, maxByStake));
        if (shares < 1) continue;
      }
      const cost = round2(shares * limitPrice);
      if (cost > remainingBudget + 0.01 || cost > group.cash + 0.01) continue;
      clearOrders(world, holder, candidate.shareClassIdValue, 'buy');
      const placed = placeOrder(world, {
        companyId: candidate.company.id,
        shareClassId: candidate.shareClassIdValue,
        side: 'buy',
        holder,
        shares,
        limitPrice,
        tick,
        note: `${group.name} 自动投资（${candidate.kind === 'voting' ? '投票权' : '仅分红'}；折价 ${candidate.financials.valueGap.toFixed(3)}，最近利润 ${candidate.financials.profit.toFixed(0)}；演示规则）`,
      });
      if (placed.ok) {
        buyCount += 1;
        remainingBudget = round2(remainingBudget - cost);
      }
    }
  }
}

/**
 * 企业作为股票市场买方：只允许买入有投票权类别（用户已确认的规则）。
 *
 * v0.8：只对真实财务允许的企业下单——现金需高于 companyReserveWageMonths 个月工资，
 * 预算 = min(companyBudgetCap, 现金 × companyBudgetShare)；目标必须账面股权为正、
 * 负债/权益不过高、最近利润非负（requireNonNegativeProfit），并用行情折价/趋势打分。
 * 玩家经营的企业不参与 AI 下单（经营决策归玩家）。
 */
export function planCompanyOrders(world: WorldState, config: DemoConfig, tick: number): void {
  const ai = config.securities.ai;
  if (!ai.enabled) return;
  const companies = [...world.companies].sort((a, b) => a.id.localeCompare(b.id));

  for (const company of companies) {
    if (isPlayerOperated(world, company.id)) continue;
    const wage = monthlyWageBill(company, config);
    if (company.cash <= wage * ai.companyReserveWageMonths) continue;
    const budget = round2(
      Math.min(ai.companyBudgetCap, company.cash * ai.companyBudgetShare),
    );
    if (budget < 1) continue;

    const candidates: PlannedCandidate[] = [];
    for (const target of companies) {
      if (target.id === company.id) continue;
      if (target.totalShares <= 0) continue;
      const shareClass = votingClassOf(world, target.id);
      if (!shareClass) continue;
      const financials = financialsOf(world, target, shareClass.id, config);
      if (!Number.isFinite(financials.price) || financials.price <= 0) continue;
      if (financials.equity <= 0) continue;
      if (financials.debtRatio > 1.5) continue; // 高杠杆目标不做财务投资
      if (ai.requireNonNegativeProfit && financials.profit < 0) continue;
      const risk = company.ai?.style === 'growth' ? 1 : company.ai?.style === 'return' ? 0.2 : 0.5;
      const score =
        financials.valueGap * (1 - risk * 0.3) +
        clamp(financials.momentum, -0.3, 0.3) * risk * ai.riskWeight +
        financials.profitYield * 0.5 +
        (1 - clamp(financials.debtRatio, 0, 1)) * 0.1 +
        stableUnit(world.seed, tick, company.id, target.id) * 0.01;
      candidates.push({
        company: target,
        shareClassIdValue: shareClass.id,
        kind: 'voting',
        financials,
        score: round2(score),
      });
    }
    if (candidates.length === 0) continue;
    candidates.sort(
      (a, b) => b.score - a.score || a.company.id.localeCompare(b.company.id),
    );
    const target = candidates[0]!;
    // 企业买方对目标支付小额溢价（旧行为 3%），扩张型略高、回报型略低。
    const premium =
      company.ai?.style === 'growth' ? 0.04 : company.ai?.style === 'return' ? 0.02 : 0.03;
    const limitPrice = round2(target.financials.price * (1 + premium));
    if (!Number.isFinite(limitPrice) || limitPrice <= 0) continue;
    const shares = Math.floor(budget / limitPrice);
    if (shares < 1) continue;
    const holder: HolderRef = { type: 'company', id: company.id };
    clearOrders(world, holder, target.shareClassIdValue, 'buy');
    placeOrder(world, {
      companyId: target.company.id,
      shareClassId: target.shareClassIdValue,
      side: 'buy',
      holder,
      shares,
      limitPrice,
      tick,
      note: `${company.name} 作为企业买方买入 ${target.company.name} 投票权股份（账面折价 ${target.financials.valueGap.toFixed(3)}，最近利润 ${target.financials.profit.toFixed(0)}；演示）`,
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
