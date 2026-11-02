import type {
  ActionResult,
  Company,
  CompanyStyle,
  FoundingInvestor,
  FoundingRecord,
  HolderRef,
  LiquidationHolding,
  LiquidationRecord,
  LogEntry,
  SectorId,
  WorldState,
} from '../../contracts/types';
import type { DemoConfig } from '../../../data/config';
import { GOODS, PRODUCTIVITY } from '../../../data/demo-data';
import { round2, allocateProportionally } from '../../core/math';
import { createEmptyInventory, monthlyWageBill, setCompanyEmployees } from '../company';
import {
  addShares,
  createShareStructure,
  playerStakeOf,
  syncCompanyTotalShares,
  syncPlayerHoldings,
} from '../../securities/securities';
import { groupsOfCity, groupHolder } from '../../investors/investors';
import { availableCredit } from '../../banking/credit';
import { settleCompanyLiquidation } from '../../banking/banking';
import { syncCityPopulationFromAllocations } from '../../population/population';
import { cityMarketPrices } from '../../markets/markets';
import { recordFiscal, receiveTreasury, spendTreasury } from '../../government/treasury';
import { equipmentSubsidyPayment, startupGrantPayment } from '../../policies/policies';
import { activePolicy, remainingBudget, startupSupportActive } from '../../policies/query';
import { notifyPlayer } from '../../notifications/notifications';

/**
 * 企业成立与退出（最小完整流程）。
 *
 * 【暂定演示规则，用户尚未确定】
 * - 数量限制：城市企业上限、居民投资实体可创办数、现有企业可创办数、政府可创办数；
 * - 居民投资群体按人口占比代表真实居民，不另生人口；可联合出资但受投资者人数上限；
 * - 创办资金与股份全部来自出资人（居民实体现金 / 企业现金 / 市政府财政），
 *   新企业获得等额现金，货币守恒；
 * - 倒闭顺序：现金偿还债务 → 剩余现金按股分配给股东；库存按账面注销并留痕；
 *   未偿还债务记录为减免。不实现完整公司法、破产程序或资产拍卖。
 */

const COMPANY_NAME_SUFFIX = ['新业', '工坊', '联合企业', '实业'];

export function companyStyleFor(companyId: string, sector: SectorId, index: number): CompanyStyle {
  const order: CompanyStyle[] = ['growth', 'steady', 'return'];
  let hash = index;
  for (let i = 0; i < companyId.length; i++) hash += companyId.charCodeAt(i);
  for (let i = 0; i < sector.length; i++) hash += sector.charCodeAt(i) * (i + 1);
  return order[hash % order.length]!;
}

export function freshAiState(companyId: string, sector: SectorId, index: number) {
  const style = companyStyleFor(companyId, sector, index);
  return {
    style,
    riskTolerance: style === 'growth' ? 0.75 : style === 'steady' ? 0.5 : 0.3,
    lossMonths: 0,
    ageMonths: 0,
    lastPlan: null,
    lastDecision: '新企业尚未制定经营计划。',
    lastDecisionTick: 0,
  };
}

export function sectorForOutput(output: string): SectorId {
  switch (output) {
    case 'grain':
      return 'agriculture';
    case 'fiber':
      return 'fiber-farm';
    case 'fabric':
      return 'textile';
    case 'food':
      return 'food';
    case 'clothing':
      return 'garment';
    case 'metal':
      return 'metal';
    case 'energy':
      return 'utility';
    default:
      return 'appliance';
  }
}

export interface FoundingRequest {
  cityId: string;
  founderType: 'investorGroup' | 'company' | 'government';
  founderId?: string;
  recipeOutput?: string;
  capital?: number;
  log?: LogEntry[];
}

function foundingCount(world: WorldState, predicate: (record: FoundingRecord) => boolean): number {
  return world.lifecycle.foundings.filter(predicate).length;
}

function cityCompanyCount(world: WorldState, cityId: string): number {
  return world.companies.filter((company) => company.cityId === cityId).length;
}

function nextCompanyId(world: WorldState, cityId: string): string {
  let number = world.lifecycle.nextFoundingNumber;
  const ids = new Set(world.companies.map((company) => company.id));
  while (ids.has(`co-${cityId}-${number}`)) number += 1;
  return `co-${cityId}-${number}`;
}

function pickOutput(world: WorldState, cityId: string): { output: string; sector: SectorId } {
  const city = world.cities.find((entry) => entry.id === cityId);
  const candidates = GOODS.map((good) => {
    const producers = world.companies.filter(
      (company) => company.cityId === cityId && company.recipeOutput === good.id,
    ).length;
    const unmet = city?.market[good.id]?.unmetDemand ?? 0;
    return { good, producers, unmet, score: unmet + (producers === 0 ? 50 : 0) };
  }).sort((a, b) => b.score - a.score || a.good.id.localeCompare(b.good.id));
  const pick = candidates[0]?.good ?? GOODS[0]!;
  return { output: pick.id, sector: sectorForOutput(pick.id) };
}

/** 创办企业：先全部校验，再一次性提交（资金、股份、企业、记录）。 */
export function foundCompany(
  world: WorldState,
  request: FoundingRequest,
  config: DemoConfig,
): ActionResult & { companyId?: string } {
  const log = request.log ?? [];
  const city = world.cities.find((entry) => entry.id === request.cityId);
  if (!city) return { ok: false, error: '城市不存在' };
  if (cityCompanyCount(world, city.id) >= config.lifecycle.maxCompaniesPerCity) {
    return { ok: false, error: `该城市企业数量已达上限（${config.lifecycle.maxCompaniesPerCity} 家）` };
  }

  const startupPolicy = startupSupportActive(world, city.id);
  const capitalRelief = startupPolicy ? config.policies.startup.capitalRelief : 0;
  const requiredCapital = round2(config.lifecycle.minCapital * (1 - capitalRelief));
  const capital = round2(Math.max(requiredCapital, request.capital ?? requiredCapital));
  if (capital < requiredCapital - 1e-6) {
    return { ok: false, error: `创办资本不足：需要至少 ${requiredCapital.toFixed(0)} 信用点` };
  }

  const pick = request.recipeOutput
    ? { output: request.recipeOutput, sector: sectorForOutput(request.recipeOutput) }
    : pickOutput(world, city.id);
  if (!GOODS.some((good) => good.id === pick.output)) {
    return { ok: false, error: `未知商品 ${pick.output}` };
  }

  const investors: FoundingInvestor[] = [];
  if (request.founderType === 'investorGroup') {
    if (
      foundingCount(
        world,
        (record) =>
          record.founderType === 'investorGroup' &&
          record.investors.some((investor) => investor.id === request.founderId),
      ) >= config.lifecycle.maxCompaniesPerInvestorGroup
    ) {
      return { ok: false, error: '该居民投资群体已达到可创办企业数量上限' };
    }
    const eligible = groupsOfCity(world, city.id)
      .filter((group) => {
        const people = Math.round(city.population.total * group.populationShare);
        return (
          people >= config.lifecycle.populationPerInvestorGroup / config.lifecycle.maxInvestorsPerSyndicate &&
          group.cash > 0
        );
      })
      .sort((a, b) => b.cash - a.cash || a.id.localeCompare(b.id));
    if (eligible.length === 0) return { ok: false, error: '没有具备投资能力的居民投资群体' };
    const syndicate = eligible.slice(0, config.lifecycle.maxInvestorsPerSyndicate);
    // 等额出资；买不起份额的群体退出，直到所有参与者都能承担。
    let sharesCount = syndicate.length;
    while (sharesCount > 0) {
      const share = round2(capital / sharesCount);
      const affordable = syndicate.slice(0, sharesCount).filter((group) => group.cash + 1e-6 >= share);
      if (affordable.length === sharesCount) break;
      sharesCount = affordable.length;
    }
    if (sharesCount === 0) return { ok: false, error: '居民投资群体资金不足，无法创办企业' };
    const share = round2(capital / sharesCount);
    let remaining = capital;
    for (let index = 0; index < sharesCount; index++) {
      const group = syndicate[index]!;
      const amount = index === sharesCount - 1 ? round2(remaining) : share;
      investors.push({ type: 'investorGroup', id: group.id, cash: amount, shares: 0 });
      remaining = round2(remaining - amount);
    }
    if (remaining < -0.01) return { ok: false, error: '出资分配失败' };
  } else if (request.founderType === 'company') {
    const founder = world.companies.find((company) => company.id === request.founderId);
    if (!founder) return { ok: false, error: '创办企业不存在' };
    if (founder.cityId !== city.id) return { ok: false, error: '现有企业只能在本城创办新企业（暂定规则）' };
    if (
      foundingCount(
        world,
        (record) => record.founderType === 'company' && record.investors.some((investor) => investor.id === founder.id),
      ) >= config.lifecycle.maxCompaniesPerCompany
    ) {
      return { ok: false, error: '该企业已达到可创办企业数量上限' };
    }
    if (founder.cash + 1e-6 < capital) return { ok: false, error: '创办企业自有资金不足' };
    investors.push({ type: 'company', id: founder.id, cash: capital, shares: 0 });
  } else {
    if (
      foundingCount(
        world,
        (record) => record.founderType === 'government' && record.cityId === city.id,
      ) >= config.lifecycle.maxGovernmentCompaniesPerCity
    ) {
      return { ok: false, error: '该城市政府已达到可创办企业数量上限' };
    }
    if (city.treasury + 1e-6 < capital) return { ok: false, error: '市政府财政资金不足' };
    investors.push({ type: 'government', id: city.id, cash: capital, shares: 0 });
  }

  const companyId = nextCompanyId(world, city.id);
  const totalShares = 1_000_000;
  const votingShares = Math.round(totalShares * 0.8);
  const nonVotingShares = totalShares - votingShares;
  const outputName = GOODS.find((good) => good.id === pick.output)?.name ?? pick.output;
  const company: Company = {
    id: companyId,
    name: `${city.name}${outputName}${COMPANY_NAME_SUFFIX[world.companies.length % COMPANY_NAME_SUFFIX.length]}`,
    cityId: city.id,
    sector: pick.sector,
    recipeOutput: pick.output as Company['recipeOutput'],
    cash: capital,
    debt: 0,
    capacity: round2(capital / config.lifecycle.capitalPerCapacity),
    baseCapacity: round2(capital / config.lifecycle.capitalPerCapacity),
    maxCapacity: round2((capital / config.lifecycle.capitalPerCapacity) * config.company.maxCapacityMultiple),
    utilization: config.company.initialUtilization,
    employees: 0,
    baseWageBill: 0,
    roles: { management: 0, production: 0, sales: 0, research: 0 },
    jobDemand: 0,
    wageRate: config.labor.privateWageRate,
    priceFactor: 1,
    inventory: createEmptyInventory(),
    totalShares,
    lastMonth: blankStats(),
    previousMonth: blankStats(),
    dividendPayoutRatio: config.governance.defaultDividendPayoutRatio,
    note: `创办于第 ${world.time.tick} 期；资本 ${capital.toFixed(0)}。${startupPolicy ? '获得初创扶持（演示）。' : ''}`,
    ai: freshAiState(companyId, pick.sector, world.lifecycle.foundings.length),
  };
  company.jobDemand = Math.ceil(
    company.capacity / Math.max(1, (PRODUCTIVITY[company.recipeOutput] ?? 1) * city.technology.productivityMultiplier),
  );

  // 出资人扣款（全部校验通过后提交）。
  for (const investor of investors) {
    if (investor.type === 'investorGroup') {
      const group = world.investors.find((entry) => entry.id === investor.id)!;
      group.cash = round2(group.cash - investor.cash);
    } else if (investor.type === 'company') {
      const founder = world.companies.find((entry) => entry.id === investor.id)!;
      founder.cash = round2(founder.cash - investor.cash);
    } else {
      spendTreasury(
        world,
        city,
        investor.cash,
        'policyTransfer',
        `市政府出资创办 ${company.name}`,
        { companyId },
        config,
      );
    }
  }

  // 出资人按出资额取得股份；两类股份均来自创办出资，不在市场凭空增发。
  const totalInvested = investors.reduce((sum, investor) => sum + investor.cash, 0);
  const weightBase = totalInvested > 0 ? totalInvested : capital;
  const votingHolders: { holder: HolderRef; shares: number }[] = [];
  const nonVotingHolders: { holder: HolderRef; shares: number }[] = [];
  for (const investor of investors) {
    const weight = investor.cash / weightBase;
    const voting = Math.round(votingShares * weight);
    const nonVoting = Math.round(nonVotingShares * weight);
    const holder: HolderRef =
      investor.type === 'investorGroup'
        ? groupHolder(world.investors.find((group) => group.id === investor.id)!)
        : investor.type === 'company'
          ? { type: 'company', id: investor.id }
          : { type: 'city', id: city.id };
    investor.shares = voting + nonVoting;
    votingHolders.push({ holder, shares: voting });
    nonVotingHolders.push({ holder, shares: nonVoting });
  }
  // 取整余数给第一位出资人，保证两类股份严格等于发行量。
  const votingSum = votingHolders.reduce((sum, entry) => sum + entry.shares, 0);
  const nonVotingSum = nonVotingHolders.reduce((sum, entry) => sum + entry.shares, 0);
  votingHolders[0]!.shares = round2(votingHolders[0]!.shares + (votingShares - votingSum));
  nonVotingHolders[0]!.shares = round2(nonVotingHolders[0]!.shares + (nonVotingShares - nonVotingSum));

  world.companies.push(company);
  createShareStructure(world, company, {
    votingShares,
    nonVotingShares,
    votingHolders,
    nonVotingHolders,
    tick: world.time.tick,
    acquiredVia: 'primary',
  });

  // 初创扶持：财政按比例向新企业注入启动资金（预算不足则按可用额）。
  let grant = 0;
  if (startupPolicy) {
    grant = startupGrantPayment(world, city, capital, config, company.id);
    if (grant > 0) company.cash = round2(company.cash + grant);
  }

  const record: FoundingRecord = {
    id: `founding-${world.lifecycle.nextFoundingNumber}`,
    tick: world.time.tick,
    cityId: city.id,
    companyId,
    companyName: company.name,
    sector: company.sector,
    recipeOutput: company.recipeOutput,
    founderType: request.founderType,
    capital,
    investorCount: investors.length,
    investors,
    governmentGrant: grant,
    note:
      request.founderType === 'investorGroup'
        ? `${investors.length} 个居民投资群体联合出资（按人口与投资能力筛选，演示规则）。`
        : request.founderType === 'company'
          ? '由现有企业出资创办，股份由出资企业持有。'
          : '由市政府财政出资创办，股份由城市持有。',
  };
  world.lifecycle.foundings.push(record);
  world.lifecycle.nextFoundingNumber += 1;
  if (world.lifecycle.foundings.length > config.lifecycle.maxHistory) {
    world.lifecycle.foundings.splice(0, world.lifecycle.foundings.length - config.lifecycle.maxHistory);
  }

  log.push({
    tick: world.time.tick,
    kind: 'market',
    message: `${city.name} 新企业「${company.name}」成立：${record.note}资本 ${capital.toFixed(0)}${grant > 0 ? `，财政扶持 ${grant.toFixed(0)}` : ''}。`,
  });
  return { ok: true, note: `${company.name} 已成立。`, amount: capital, companyId: company.id };
}

function blankStats(): Company['lastMonth'] {
  return {
    revenue: 0,
    inputCost: 0,
    wagesPaid: 0,
    wageArrears: 0,
    interestPaid: 0,
    corporateTax: 0,
    dividendsPaid: 0,
    profit: 0,
    produced: 0,
    sold: 0,
    exported: 0,
    unmetDemand: 0,
    capacityChange: 0,
    dividendIncome: 0,
  };
}

/** 扩产投资：企业自有资金 + 设备补助政策；实际增加产能。 */
export function expandCompanyCapacity(
  world: WorldState,
  company: Company,
  config: DemoConfig,
  log: LogEntry[],
  requestedUnits?: number,
): ActionResult {
  const city = world.cities.find((entry) => entry.id === company.cityId);
  if (!city) return { ok: false, error: '企业城市不存在' };
  const units = round2(
    Math.max(1, Math.min(requestedUnits ?? company.capacity * config.companyAi.maxExpansionShare, company.capacity * config.companyAi.maxExpansionShare)),
  );
  const cost = round2(units * config.companyAi.capacityCostPerUnit);
  const policy = activePolicy(world, city.id, 'equipmentSubsidy');
  const maxSubsidy = policy ? Math.min(remainingBudget(policy), cost * config.policies.equipment.subsidyRate) : 0;
  const netCost = round2(cost - maxSubsidy);
  if (company.cash + 1e-6 < netCost) {
    return { ok: false, error: `扩产资金不足：需要 ${netCost.toFixed(0)}，现有 ${company.cash.toFixed(0)}` };
  }
  company.cash = round2(company.cash - netCost);
  const subsidy = maxSubsidy > 0 ? equipmentSubsidyPayment(world, city, cost, config, company.id) : 0;
  if (subsidy > 0) company.cash = round2(company.cash + subsidy);
  company.capacity = round2(company.capacity + units);
  company.baseCapacity = round2(company.baseCapacity + units);
  company.maxCapacity = round2(Math.max(company.maxCapacity, company.capacity));
  company.lastMonth.capacityChange = round2(company.lastMonth.capacityChange + units);
  log.push({
    tick: world.time.tick,
    kind: 'production',
    message: `${company.name} 扩产 ${units.toFixed(0)} 单位/月，投入 ${netCost.toFixed(0)}${subsidy > 0 ? `（设备补助 ${subsidy.toFixed(0)} 来自财政）` : ''}。`,
  });
  return { ok: true, note: `产能增加 ${units.toFixed(0)} 单位/月。`, amount: netCost };
}

/** 倒闭：处理员工、资金、债务、库存、股份、协议与历史记录。 */
export function liquidateCompany(
  world: WorldState,
  companyId: string,
  config: DemoConfig,
  reason: string,
  log: LogEntry[],
): ActionResult {
  const company = world.companies.find((entry) => entry.id === companyId);
  if (!company) return { ok: false, error: '企业不存在' };
  const city = world.cities.find((entry) => entry.id === company.cityId);
  if (!city) return { ok: false, error: '企业城市不存在' };

  const interestedStake = playerStakeOf(world, company.id);
  const prices = cityMarketPrices(city);
  const inventoryWrittenOff = Object.entries(company.inventory)
    .map(([good, qty]) => ({
      good: good as Company['recipeOutput'],
      qty: round2(Math.max(0, qty)),
      bookValue: round2(Math.max(0, qty) * (prices[good as Company['recipeOutput']] ?? 0)),
    }))
    .filter((entry) => entry.qty > 0);
  const inventoryBookValue = round2(inventoryWrittenOff.reduce((sum, entry) => sum + entry.bookValue, 0));

  const cash = round2(Math.max(0, company.cash));
  const debt = round2(Math.max(0, company.debt));
  // v0.4：企业债务权威在银行——先偿还银行贷款，剩余部分才按持股分配。
  const debtSettlement = settleCompanyLiquidation(
    world,
    company,
    cash,
    config,
    world.time.tick,
  );
  const debtRepaid = debtSettlement.repaid;
  const debtForgiven = debtSettlement.forgiven;
  let remainingCash = round2(cash - debtRepaid);

  // 股份持有明细（含仅分红股东）；剩余资产按股分配，取整余额给最大股东。
  const totalShares = world.securities.classes
    .filter((shareClass) => shareClass.companyId === company.id)
    .reduce((sum, shareClass) => sum + shareClass.issuedShares, 0);
  const byHolder = new Map<string, { holder: HolderRef; shares: number }>();
  for (const holding of world.securities.holdings) {
    if (holding.companyId !== company.id || holding.shares <= 0) continue;
    // 倒闭企业持有的自身股份是库存股：没有经济所有者，随企业注销而不参与分配，
    // 否则再分配时会把新增股份并入随后被删除的记录，造成股份凭空减少。
    if (holding.holder.type === 'company' && holding.holder.id === company.id) continue;
    const key = `${holding.holder.type}:${holding.holder.id}`;
    const existing = byHolder.get(key);
    if (existing) existing.shares = round2(existing.shares + holding.shares);
    else byHolder.set(key, { holder: { ...holding.holder }, shares: holding.shares });
  }
  const sortedHolders = [...byHolder.values()].sort(
    (a, b) =>
      b.shares - a.shares ||
      a.holder.type.localeCompare(b.holder.type) ||
      a.holder.id.localeCompare(b.holder.id),
  );
  const payouts: LiquidationHolding[] = [];
  let paidOut = 0;
  for (const entry of sortedHolders) {
    const stake = totalShares > 0 ? entry.shares / totalShares : 0;
    const amount = round2(remainingCash * stake);
    if (amount <= 0) continue;
    paidOut = round2(paidOut + amount);
    payouts.push({ holder: entry.holder, shares: entry.shares, amount });
  }
  // 取整差额归最大股东，保证分配总额不超过剩余现金。
  const rounding = round2(remainingCash - paidOut);
  if (payouts.length > 0 && Math.abs(rounding) > 0.001) {
    payouts[0]!.amount = round2(payouts[0]!.amount + rounding);
  }
  for (const payout of payouts) {
    if (payout.amount <= 0) continue;
    if (payout.holder.type === 'player') {
      world.player.cash = round2(world.player.cash + payout.amount);
    } else if (payout.holder.type === 'company') {
      const recipient = world.companies.find((entry) => entry.id === payout.holder.id);
      if (recipient) recipient.cash = round2(recipient.cash + payout.amount);
    } else if (payout.holder.type === 'investorGroup') {
      const group = world.investors.find((entry) => entry.id === payout.holder.id);
      if (group) group.cash = round2(group.cash + payout.amount);
    } else {
      const recipientCity = world.cities.find((entry) => entry.id === payout.holder.id);
      if (recipientCity) {
        receiveTreasury(
          world,
          recipientCity,
          payout.amount,
          'liquidationProceeds',
          `${company.name} 清算剩余资产（城市持股）`,
          { companyId: company.id },
          config,
        );
      }
    }
  }
  const shareholderPayout = round2(payouts.reduce((sum, entry) => sum + Math.max(0, entry.amount), 0));
  remainingCash = round2(remainingCash - shareholderPayout);
  const employeesReleased = company.employees;

  // 通知必须在移除股份记录之前发送：玩家仍被视为利害关系人。
  const playerPayout = payouts.find((entry) => entry.holder.type === 'player')?.amount ?? 0;
  notifyPlayer(world, config, {
    audience: 'company',
    kind: 'major',
    priority: 'important',
    companyId: company.id,
    title: `${company.name} 已倒闭`,
    body: `${reason}。${employeesReleased > 0 ? `${employeesReleased} 名员工回到劳动力市场。` : ''}你${interestedStake > 0 ? `持有的股份按剩余资产分配，共收到 ${playerPayout.toFixed(2)} 信用点` : '未持有该企业股份'}。`,
  });

  // 员工释放：企业员工清零，随后同步城市人口（变为失业）。
  setCompanyEmployees(company, 0);
  syncCityPopulationFromAllocations(city, world);
  if (employeesReleased > 0) {
    log.push({
      tick: world.time.tick,
      kind: 'labor',
      message: `${company.name} 倒闭，${employeesReleased} 名员工转为失业（由城市劳动力匹配重新安排）。`,
    });
  }

  // 既有协议：未完成条目失败，参与方记录拒绝；不影响其他企业。
  const agreementsAffected: string[] = [];
  for (const agreement of world.agreements) {
    const participant = agreement.participants.find((entry) => entry.companyId === company.id);
    if (!participant && !agreement.items.some((item) => item.buyerCompanyId === company.id || item.sellerCompanyId === company.id)) {
      continue;
    }
    agreementsAffected.push(agreement.id);
    if (participant) {
      participant.decision = 'declined';
      participant.decidedTick = world.time.tick;
      participant.note = `企业已倒闭（${reason}），不再履约。`;
    }
    for (const item of agreement.items) {
      if (item.buyerCompanyId !== company.id && item.sellerCompanyId !== company.id) continue;
      if (item.status === 'pending' || item.status === 'active') {
        item.status = 'failed';
        item.lastNote = `相关企业已倒闭（${reason}），条目不再执行。`;
      }
    }
    const stillOpen = agreement.items.some((item) => item.status === 'pending' || item.status === 'active');
    if (!stillOpen && (agreement.status === 'proposed' || agreement.status === 'active')) {
      agreement.status = 'completed';
      agreement.note = '协议因参与企业倒闭而结束（暂定规则）。';
    }
  }

  // 治理与证券记录：保留历史议案结果，删除本企业相关权利记录。
  world.governance.boards = world.governance.boards.filter((board) => board.companyId !== company.id);
  world.governance.controls = world.governance.controls.filter((control) => control.companyId !== company.id);
  for (const motion of world.governance.motions) {
    if (motion.companyId !== company.id || motion.status !== 'open') continue;
    motion.status = 'rejected';
    motion.decidedTick = world.time.tick;
    motion.result = `企业已倒闭（${reason}），议案终止。`;
  }
  world.securities.orders = world.securities.orders.filter(
    (order) => order.companyId !== company.id && !(order.holder.type === 'company' && order.holder.id === company.id),
  );
  world.securities.offers = world.securities.offers.filter(
    (offer) => offer.companyId !== company.id && !(offer.investor.type === 'company' && offer.investor.id === company.id),
  );
  world.securities.classes = world.securities.classes.filter((shareClass) => shareClass.companyId !== company.id);

  // 倒闭企业作为其他企业股东持有的股份属于清算资产：
  // 按其在倒闭企业中的持股比例转给其股东，保证发行量守恒；无股东时注销并同步发行量。
  const crossHoldings = world.securities.holdings.filter(
    (holding) => holding.holder.type === 'company' && holding.holder.id === company.id,
  );
  const defunctShareTotal = totalShares;
  for (const holding of crossHoldings) {
    const issuer = world.companies.find((entry) => entry.id === holding.companyId);
    const count = Math.round(holding.shares);
    if (!issuer) {
      // 发行企业已不存在（或就是本企业自身）：该笔持股随类别注销，不再分配。
      world.securities.holdings = world.securities.holdings.filter((entry) => entry !== holding);
      continue;
    }
    if (sortedHolders.length > 0 && defunctShareTotal > 0 && count > 0) {
      const sharesSplit = allocateProportionally(
        count,
        sortedHolders.map((entry) => entry.shares),
      );
      sortedHolders.forEach((recipient, index) => {
        const shares = sharesSplit[index] ?? 0;
        if (shares <= 0) return;
        addShares(world, {
          companyId: holding.companyId,
          shareClassId: holding.shareClassId,
          holder: recipient.holder,
          shares,
          acquiredVia: 'secondary',
          tick: world.time.tick,
        });
      });
    } else {
      const shareClass = world.securities.classes.find(
        (entry) => entry.id === holding.shareClassId,
      );
      if (shareClass) {
        shareClass.issuedShares = round2(Math.max(0, shareClass.issuedShares - holding.shares));
      }
    }
    world.securities.holdings = world.securities.holdings.filter((entry) => entry !== holding);
    if (issuer) syncCompanyTotalShares(world, issuer);
  }
  world.securities.holdings = world.securities.holdings.filter(
    (holding) =>
      holding.companyId !== company.id &&
      !(holding.holder.type === 'company' && holding.holder.id === company.id),
  );
  // 历史成交记录保留可审计性，但存档结构不允许引用已不存在的持有人。
  world.securities.lastTrades = world.securities.lastTrades.filter(
    (trade) =>
      !(trade.buyer.type === 'company' && trade.buyer.id === company.id) &&
      !(trade.seller.type === 'company' && trade.seller.id === company.id),
  );
  world.player.holdings = world.player.holdings.filter((holding) => holding.companyId !== company.id);
  // 该企业可能在其他企业担任董事/持有表决权：一并移除，避免无效持有人记录。
  for (const board of world.governance.boards) {
    board.seats = board.seats.filter(
      (seat) => !(seat.holder.type === 'company' && seat.holder.id === company.id),
    );
    if (board.chair && board.chair.type === 'company' && board.chair.id === company.id) {
      board.chair = null;
    }
  }
  for (const motion of world.governance.motions) {
    motion.eligible = motion.eligible.filter(
      (entry) => !(entry.holder.type === 'company' && entry.holder.id === company.id),
    );
    motion.votes = motion.votes.filter(
      (vote) => !(vote.holder.type === 'company' && vote.holder.id === company.id),
    );
  }
  world.governance.controls = world.governance.controls.filter(
    (control) =>
      control.companyId !== company.id &&
      !(
        control.operator !== 'management' &&
        control.operator.type === 'company' &&
        control.operator.id === company.id
      ),
  );
  // 由该企业提出的议案不再有有效提案人；关于该企业的议案也失去对象。
  // 移除并在结局记录中说明（不是伪造历史结果）。
  const proposedMotions = world.governance.motions.filter(
    (motion) => motion.proposedBy.type === 'company' && motion.proposedBy.id === company.id,
  );
  const subjectMotions = world.governance.motions.filter(
    (motion) => motion.companyId === company.id,
  );
  const removedMotions = new Set([...proposedMotions, ...subjectMotions]);
  if (removedMotions.size > 0) {
    world.governance.motions = world.governance.motions.filter(
      (motion) => !removedMotions.has(motion),
    );
  }
  syncPlayerHoldings(world);

  // 与倒闭企业相关的贸易路线不再执行。
  world.tradeRoutes = world.tradeRoutes.filter(
    (route) => route.fromCompanyId !== company.id && route.toCompanyId !== company.id,
  );
  world.companies = world.companies.filter((entry) => entry.id !== company.id);
  // 交易/生产记录保留公司 ID，作为历史审计；不修改既有记录。
  world.transport.pendingSales = world.transport.pendingSales.filter(
    (sale) => sale.sellerCompanyId !== company.id,
  );

  const record: LiquidationRecord = {
    id: `liquidation-${world.lifecycle.nextLiquidationNumber}`,
    tick: world.time.tick,
    companyId: company.id,
    companyName: company.name,
    cityId: company.cityId,
    reason,
    employeesReleased,
    cash,
    debt,
    debtRepaid,
    debtForgiven,
    shareholderPayout,
    holdings: payouts,
    inventoryWrittenOff,
    inventoryBookValue,
    agreementsAffected,
    note:
      '清算顺序（暂定）：现金先偿还债务，剩余按股分配；库存按账面注销并留痕，未产生现金；未偿还债务记为减免。不是完整破产程序。' +
      (proposedMotions.length > 0
        ? ` 该企业提出的 ${proposedMotions.length} 项未决议案因提案人不存在而移除。`
        : '') +
      (subjectMotions.length > 0
        ? ` 关于该企业的 ${subjectMotions.length} 项议案随企业退出而终止并移除。`
        : ''),
  };
  world.lifecycle.liquidations.push(record);
  world.lifecycle.nextLiquidationNumber += 1;
  if (world.lifecycle.liquidations.length > config.lifecycle.maxHistory) {
    world.lifecycle.liquidations.splice(0, world.lifecycle.liquidations.length - config.lifecycle.maxHistory);
  }

  if (debtForgiven > 0) {
    recordFiscal(
      world,
      {
        tick: world.time.tick,
        cityId: city.id,
        kind: 'debtForgiven',
        amount: 0,
        source: `${company.name} 倒闭：未偿还债务 ${debtForgiven.toFixed(0)} 记为减免（不产生财政收支）`,
        companyId: company.id,
      },
      config,
    );
  }

  log.push({
    tick: world.time.tick,
    kind: 'warning',
    message: `${company.name} 倒闭（${reason}）：${employeesReleased} 名员工释放，剩余现金 ${shareholderPayout.toFixed(0)} 按股分配，库存 ${inventoryBookValue.toFixed(0)} 注销，债务减免 ${debtForgiven.toFixed(0)}。`,
  });

  return { ok: true, note: `${company.name} 已清算。`, amount: shareholderPayout };
}

/** 月度：按失败路径（连续亏损 + 现金不足）判定倒闭；新企业有保护期。 */
export function checkBankruptcies(
  world: WorldState,
  config: DemoConfig,
  log: LogEntry[],
): string[] {
  const liquidated: string[] = [];
  const ordered = [...world.companies].sort((a, b) => a.id.localeCompare(b.id));
  for (const company of ordered) {
    if (!company.ai) continue;
    const grace = Math.max(
      config.lifecycle.bankruptcy.minAgeMonths,
      config.companyAi.newCompanyGraceMonths,
    );
    if (company.ai.ageMonths < grace) continue;
    if (company.ai.lossMonths < config.lifecycle.bankruptcy.lossMonths) continue;
    const wage = monthlyWageBill(company);
    if (wage <= 0) continue;
    if (company.cash >= wage * config.lifecycle.bankruptcy.cashWageMonths) continue;
    // 真正的退出条件是“现金耗尽且已无可用信贷”，而不是会计利润为负：
    // 现有演示经济中企业长期薄利，仅凭亏损判定会造成不现实的连锁倒闭。
    // v0.4：可用信贷来自独立银行的授信评估（无快照时即时计算）。
    if (availableCredit(world, { kind: 'company', id: company.id }, config) > 1) continue;
    if (activePolicy(world, company.cityId, 'companyRelief')) {
      // 纾困政策存在时，给企业一个观察期；若纾困预算已用尽则照常判定。
      const policy = activePolicy(world, company.cityId, 'companyRelief')!;
      if (remainingBudget(policy) > 0) continue;
    }
    const result = liquidateCompany(
      world,
      company.id,
      config,
      `连续 ${company.ai.lossMonths} 个月亏损、现金不足一个月工资且债务压力过高`,
      log,
    );
    if (result.ok) liquidated.push(company.id);
  }
  return liquidated;
}

/**
 * 月度：企业与居民群体按条件创办新企业。
 * 只在存在明显市场缺口（未满足需求）时尝试；每城每月最多一家。
 */
export function maybeFoundCompanies(
  world: WorldState,
  config: DemoConfig,
  log: LogEntry[],
): string[] {
  const created: string[] = [];
  for (const city of [...world.cities].sort((a, b) => a.id.localeCompare(b.id))) {
    if (cityCompanyCount(world, city.id) >= config.lifecycle.maxCompaniesPerCity) continue;
    const lastFounding = world.lifecycle.foundings
      .filter((record) => record.cityId === city.id)
      .reduce((latest, record) => Math.max(latest, record.tick), -999);
    if (world.time.tick - lastFounding < config.lifecycle.foundingCooldownMonths) continue;
    const goodWithGap = GOODS.map((good) => {
      const unmet = city.market[good.id]?.unmetDemand ?? 0;
      const producers = world.companies.filter(
        (company) => company.cityId === city.id && company.recipeOutput === good.id,
      ).length;
      return { good, score: unmet + (producers === 0 ? 60 : 0) };
    }).sort((a, b) => b.score - a.score || a.good.id.localeCompare(b.good.id))[0];
    if (!goodWithGap || goodWithGap.score < 40) continue;

    const startupPolicy = startupSupportActive(world, city.id);
    const requiredCapital = round2(
      config.lifecycle.minCapital * (1 - (startupPolicy ? config.policies.startup.capitalRelief : 0)),
    );
    const groups = groupsOfCity(world, city.id).filter((group) => group.cash >= requiredCapital / config.lifecycle.maxInvestorsPerSyndicate);
    let founderType: 'investorGroup' | 'company' | 'government' | null = null;
    let founderId: string | undefined;
    if (groups.length > 0) founderType = 'investorGroup';
    else {
      const rich = world.companies
        .filter((company) => company.cityId === city.id && company.cash > requiredCapital * 2)
        .sort((a, b) => b.cash - a.cash || a.id.localeCompare(b.id))[0];
      if (rich) {
        founderType = 'company';
        founderId = rich.id;
      } else if (
        city.treasury > city.lastMonth.publicWageBill * 3 + requiredCapital &&
        foundingCount(world, (record) => record.founderType === 'government' && record.cityId === city.id) <
          config.lifecycle.maxGovernmentCompaniesPerCity
      ) {
        founderType = 'government';
      }
    }
    if (!founderType) continue;
    const result = foundCompany(
      world,
      {
        cityId: city.id,
        founderType,
        founderId,
        recipeOutput: goodWithGap.good.id,
        capital: requiredCapital,
        log,
      },
      config,
    );
    if (result.ok && result.companyId) created.push(result.companyId);
  }
  return created;
}

/** 供界面：企业最近一次经营/生命周期说明。 */
export function companyLifecycleNote(world: WorldState, company: Company): string {
  const founding = [...world.lifecycle.foundings]
    .reverse()
    .find((record) => record.companyId === company.id);
  if (!founding) return company.note;
  return `${company.note} 成立记录：第 ${founding.tick} 期，${founding.note}`;
}

/** 供测试/界面：某城市当前的企业数量限制状态。 */
export function lifecycleLimits(world: WorldState, cityId: string, config: DemoConfig) {
  const city = world.cities.find((entry) => entry.id === cityId);
  return {
    companies: cityCompanyCount(world, cityId),
    maxCompanies: config.lifecycle.maxCompaniesPerCity,
    governmentFoundings: foundingCount(
      world,
      (record) => record.founderType === 'government' && record.cityId === cityId,
    ),
    maxGovernmentFoundings: config.lifecycle.maxGovernmentCompaniesPerCity,
    population: city?.population.total ?? 0,
  };
}

