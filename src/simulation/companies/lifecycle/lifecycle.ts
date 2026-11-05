import type {
  ActionResult,
  BondHolder,
  City,
  Company,
  CompanyStyle,
  FoundingInvestor,
  GoodId,
  FoundingRecord,
  HolderRef,
  LiquidationHolding,
  LiquidationRecord,
  LogEntry,
  PolicyId,
  SectorId,
  WorldState,
} from '../../contracts/types';
import type { DemoConfig } from '../../../data/config';
import { GOODS, PRODUCTIVITY } from '../../../data/demo-data';
import { round2, allocateProportionally } from '../../core/math';
import { createEmptyInventory, monthlyWageBill, setCompanyEmployees } from '../company';
import { emptyInventoryCost, writeOffInventory } from '../../finance/inventory-cost';
import {
  addShares,
  createShareStructure,
  playerStakeOf,
  syncCompanyTotalShares,
  syncPlayerHoldings,
} from '../../securities/securities';
import { groupsOfCity, groupHolder } from '../../investors/investors';
import { availableCredit } from '../../banking/credit';
import { companyHolders } from '../../securities/securities';
import { settleCompanyLiquidation, openLoan, refreshBankingTotals } from '../../banking/banking';
import { syncCityPopulationFromAllocations } from '../../population/population';
import { syncHouseholdPeople } from '../../population/household-groups';
import { outputPerEmployee } from '../production-plan';
import { workforceSkillMultiplier } from '../../labor/workforce';
import { cityMarketPrices } from '../../markets/markets';
import { recordFiscal, receiveTreasury, spendTreasury } from '../../government/treasury';
import {
  buyNewEquipment,
  disposeCompanyEquipment,
  emptyEquipmentAssets,
  equipmentCapacityPerUnit,
  equipmentKindForSector,
  executeNewEquipmentPlan,
  planNewEquipmentPurchase,
} from '../../equipment/equipment';
import {
  FOUNDING_MIN_SCORE,
  assessFounding,
  assessFoundingOpportunities,
  founderCapacityFor,
  foundingAttempts,
  foundingAttemptSnapshot,
  foundingCandidateForOutput,
  pickFoundingCandidate,
  pickFoundingOpportunity,
  plannedEquipmentUnits,
  recordFoundingAttempt,
  retuneTierForAssessment,
  scoreFoundingCandidates,
  sectorForOutput,
  selectFoundingTier,
  type FounderType,
  type FoundingAssessment,
  type FoundingObstacle,
  type FoundingScaleTier,
} from '../founding';
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

declare module '../../contracts/types' {
  interface CompanyLifecycleState {
    /**
     * v1.2：本 tick（月）各城自动创办计数。world.lifecycle.foundings 会按 maxHistory 裁剪，
     * 单月超过 60 家时无法再从历史数组反推当月数量；这里保留精确计数，保证同月重复调用不超发。
     * v1.3：同时记录本 tick 已用作出资人的在营企业与新成立企业，跨多次 maybeFoundCompanies
     * 调用仍生效，阻断同 tick A→B→C 连锁抽血。
     */
    foundingMonth?: {
      tick: number;
      counts: Record<string, number>;
      foundersUsed?: Record<string, string[]>;
    };
  }
}

export interface FoundingRequest {
  cityId: string;
  /** 省略时由评估自动选择出资主体（居民投资群体 → 企业 → 政府）。 */
  founderType?: 'investorGroup' | 'company' | 'government';
  founderId?: string;
  recipeOutput?: string;
  /** 显式资本预算：给出时沿用 v0.9 兼容路径（测试/旧调用方）；省略时走 v1.0 档位评估路径。 */
  capital?: number;
  log?: LogEntry[];
}

export interface FoundCompanyOptions {
  /** 强制使用某个已评估的规模档位（供 UI 预览与测试）。 */
  plan?: FoundingScaleTier;
  /** 是否允许创业贷款（默认允许；测试可关闭）。 */
  allowLoan?: boolean;
  /**
   * 本 tick 内已被其他自动创办企业占用的岗位数：自动创办循环逐家累加，避免多家企业
   * 重复使用同一批可用劳动力；玩家直接发起创办时不传（只按真实在岗/失业约束）。
   */
  reservedJobs?: number;
  /**
   * v1.3 §5：本 tick 内已被其他自动创办企业用作出资人的企业 id。
   * 自动创办循环逐家累加：同一 tick 不允许同一在营企业连续出资（A→B→C 连锁抽血），
   * 新成立的企业也不能立刻当出资人。玩家显式指定 founderId 时不使用该列表。
   */
  blockedCompanyFounders?: string[];
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
  // 设备商品由专门的设备产业创办路径处理；AI 默认创办路径只看普通商品，
  // 否则会因设备商品极低的人均产出（0.01）误判就业规模。
  const candidates = GOODS.filter((good) => (PRODUCTIVITY[good.id] ?? 0) > 0.05).map((good) => {
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
  options?: FoundCompanyOptions,
): ActionResult & { companyId?: string; founderId?: string } {
  const log = request.log ?? [];
  const city = world.cities.find((entry) => entry.id === request.cityId);
  if (!city) return { ok: false, error: '城市不存在' };
  if (cityCompanyCount(world, city.id) >= config.lifecycle.maxCompaniesPerCity) {
    return { ok: false, error: `该城市企业数量已达上限（${config.lifecycle.maxCompaniesPerCity} 家）` };
  }

  // v1.0：未显式给资本预算（玩家/AI 新路径）时，先评估最小可行规模，再按真实出资 + 授信贷款创办。
  // 显式 capital 的旧调用方继续走 v0.9 兼容路径，保证既有测试与存档行为不变。
  if (request.capital === undefined && !options?.plan) {
    return foundCompanyV1(world, request, city, config, log, options);
  }
  const founderType = request.founderType ?? 'investorGroup';

  const startupPolicy = startupSupportActive(world, city.id);
  const capitalRelief = startupPolicy ? config.policies.startup.capitalRelief : 0;
  const requiredCapital = round2(config.lifecycle.minCapital * (1 - capitalRelief));
  const capital = round2(Math.max(requiredCapital, request.capital ?? requiredCapital));
  if (capital < requiredCapital - 1e-6) {
    return { ok: false, error: `创办资本不足：需要至少 ${requiredCapital.toFixed(0)} 信用点` };
  }

  if (request.recipeOutput && !GOODS.some((good) => good.id === request.recipeOutput)) {
    return { ok: false, error: `未知商品 ${request.recipeOutput}` };
  }
  let candidate = request.recipeOutput
    ? foundingCandidateForOutput(world, config, city.id, request.recipeOutput as GoodId)
    : pickFoundingCandidate(world, config, city.id);
  if (!candidate) {
    // 显式调用（玩家 / 测试）且当前没有达标行业时，退回“缺口最大”的旧规则；
    // 但设备、资金、劳动力检查仍然生效，不允许凭空产能。
    const fallback = pickOutput(world, city.id);
    candidate = foundingCandidateForOutput(world, config, city.id, fallback.output as GoodId);
  }
  const pick = { output: candidate.output, sector: candidate.sector };
  const equipUnits = plannedEquipmentUnits(candidate, capital, config);
  if (equipUnits <= 0) {
    const catalog = config.equipment.catalog[candidate.equipmentKind];
    return {
      ok: false,
      error:
        candidate.availableEquipmentUnits <= 0
          ? `没有可购买的${catalog.name}（本地设备企业无库存且政府库存为空），无法创办企业`
          : `创办资本不足以购买启动设备（每台约 ${candidate.unitPrice.toFixed(0)} 信用点）`,
    };
  }
  const perEmployee = Math.max(
    1e-6,
    (PRODUCTIVITY[candidate.output] ?? 1) *
      city.technology.productivityMultiplier *
      workforceSkillMultiplier(city) *
      config.production.laborCapacityFactor,
  );
  const plannedJobs = Math.ceil((equipUnits * candidate.unitCapacity) / perEmployee);
  if (plannedJobs > city.population.laborForce) {
    return {
      ok: false,
      error: `设备对应的用工规模（${plannedJobs}）超过本城劳动力（${city.population.laborForce}）`,
    };
  }

  const founderResult = collectFoundingInvestors(world, request, city, config, capital, founderType);
  if (!founderResult.ok) return { ok: false, error: founderResult.error };
  const investors = founderResult.investors;

  const companyId = nextCompanyId(world, city.id);
  const totalShares = 1_000_000;
  const votingShares = Math.round(totalShares * 0.8);
  const nonVotingShares = totalShares - votingShares;
  const company = buildFoundingCompany(
    world,
    city,
    companyId,
    pick.output as GoodId,
    pick.sector,
    capital,
    config,
    startupPolicy,
  );
  // v0.9 T3：用创办资本真实采购启动设备（同城设备企业优先，政府开局库存补足）。
  // 在扣除出资人资金之前执行；购买失败直接返回，不产生任何资金 / 股份副作用。
  const purchase = buyNewEquipment(world, company, candidate.equipmentKind, equipUnits, config, world.time.tick, {
    allowGovernmentStock: true,
    reason: '创办设备采购',
    log,
  });
  if (!purchase.ok || purchase.units <= 0) {
    return { ok: false, error: purchase.error ?? '启动设备购买失败' };
  }
  if (company.equipmentCapacity <= 0) {
    return { ok: false, error: '启动设备未形成产能，无法创办企业' };
  }
  const equipmentUnits = purchase.units;
  const equipmentCost = purchase.cost;
  // 政府开局库存是市场之外的一次性供给；设备购买会把成交计入市场账本，
  // 这里同步补充 supply，避免 invariants 误报“成交超过供应”。
  if (purchase.fromGovernment > 0) {
    const equipmentGoodId = config.equipment.catalog[candidate.equipmentKind].goodId;
    const ledger = city.market[equipmentGoodId];
    if (ledger) ledger.supply = round2(ledger.supply + purchase.fromGovernment);
  }
  company.maxCapacity = round2(company.equipmentCapacity * config.company.maxCapacityMultiple);
  company.jobDemand = Math.ceil(company.equipmentCapacity / perEmployee);

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
    founderType,
    capital,
    investorCount: investors.length,
    investors,
    governmentGrant: grant,
    note: `${
      founderType === 'investorGroup'
        ? `${investors.length} 个居民投资群体联合出资（按人口与投资能力筛选，演示规则）。`
        : founderType === 'company'
          ? '由现有企业出资创办，股份由出资企业持有。'
          : '由市政府财政出资创办，股份由城市持有。'
    } 行业评分 ${candidate.score.toFixed(1)} 分（${candidate.reasons.slice(0, 3).join('；')}）；启动采购${
      config.equipment.catalog[candidate.equipmentKind].name
    } ${equipmentUnits} 台，设备支出 ${equipmentCost.toFixed(0)}。`,
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

function buildFoundingCompany(
  world: WorldState,
  city: City,
  companyId: string,
  output: GoodId,
  sector: SectorId,
  capital: number,
  config: DemoConfig,
  startupPolicy: unknown,
): Company {
  const outputName = GOODS.find((good) => good.id === output)?.name ?? output;
  return {
    id: companyId,
    name: `${city.name}${outputName}${COMPANY_NAME_SUFFIX[world.companies.length % COMPANY_NAME_SUFFIX.length]}`,
    cityId: city.id,
    sector,
    recipeOutput: output as Company['recipeOutput'],
    cash: capital,
    debt: 0,
    capacity: 0,
    baseCapacity: 0,
    maxCapacity: 0,
    utilization: config.company.initialUtilization,
    employees: 0,
    baseWageBill: 0,
    roles: { management: 0, production: 0, sales: 0, research: 0 },
    jobDemand: 0,
    wageRate: config.labor.privateWageRate,
    priceFactor: 1,
    inventory: createEmptyInventory(),
    inventoryCost: emptyInventoryCost(),
    totalShares: 1_000_000,
    lastMonth: blankStats(),
    previousMonth: blankStats(),
    equipment: emptyEquipmentAssets(),
    equipmentCapacity: 0,
    equipmentCapacityRemainder: 0,
    salesHistory: [],
    productionPlan: null,
    recentProfits: [],
    dividendPayoutRatio: config.governance.defaultDividendPayoutRatio,
    note: `创办于第 ${world.time.tick} 期；资本 ${capital.toFixed(0)}。${startupPolicy ? '获得初创扶持（演示）。' : ''}`,
    ai: freshAiState(companyId, sector, world.lifecycle.foundings.length),
  };
}

type FoundingInvestorResult =
  | { ok: true; investors: FoundingInvestor[] }
  | { ok: false; error: string };

/** 校验出资主体上限与资金能力，按等额出资生成出资人列表（新旧创办路径共用）。 */
function collectFoundingInvestors(
  world: WorldState,
  request: FoundingRequest,
  city: City,
  config: DemoConfig,
  capital: number,
  founderType: FounderType,
): FoundingInvestorResult {
  const investors: FoundingInvestor[] = [];
  if (founderType === 'investorGroup') {
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
    return { ok: true, investors };
  }
  if (founderType === 'company') {
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
    return { ok: true, investors };
  }
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
  return { ok: true, investors };
}

/** 失败尝试统一记账并返回错误；错误文案带具体障碍，UI/日志可直接展示。 */
function rejectFounding(
  world: WorldState,
  request: FoundingRequest,
  assessment: FoundingAssessment,
  tier: FoundingScaleTier | null,
  obstacles: FoundingObstacle[],
  founderType: FounderType | 'auto',
): ActionResult {
  const detail = obstacles.map((obstacle) => obstacle.detail).join('；') || '没有可行规模档位';
  recordFoundingAttempt(world, {
    tick: world.time.tick,
    cityId: request.cityId,
    output: assessment.output,
    sector: assessment.sector,
    score: assessment.score,
    tierUnits: tier?.units ?? null,
    founderType,
    outcome: 'rejected',
    obstacles,
    capital: tier?.founderEquity ?? 0,
    loan: tier?.loanPrincipal ?? 0,
    note: `行业评分 ${assessment.score.toFixed(1)}，创办被拒绝：${detail}`,
    ...foundingAttemptSnapshot(assessment, tier),
  });
  return { ok: false, error: `创业失败：${detail}` };
}

/** 同城可再创办、缓冲后仍有出资余钱的企业出资人（AI 自动创办用）。 */
function pickCompanyFounder(
  world: WorldState,
  config: DemoConfig,
  cityId: string,
  blocked: Set<string>,
): string | undefined {
  return [...world.companies]
    .filter(
      (company) =>
        company.cityId === cityId &&
        company.cash > 0 &&
        !blocked.has(company.id) &&
        founderCapacityFor(world, config, cityId, 'company', company.id) > 0 &&
        foundingCount(
          world,
          (record) =>
            record.founderType === 'company' &&
            record.investors.some((investor) => investor.id === company.id),
        ) < config.lifecycle.maxCompaniesPerCompany,
    )
    .sort((a, b) => b.cash - a.cash || a.id.localeCompare(b.id))[0]?.id;
}

/**
 * v1.0 创办路径：先做 1/2/4 台档位评估，再用真实出资 + 受授信约束的贷款购买设备，
 * 并预留首批原料与周转金；失败写结构化 attempt，任何失败都不留下企业/股份/贷款副作用。
 */
function foundCompanyV1(
  world: WorldState,
  request: FoundingRequest,
  city: City,
  config: DemoConfig,
  log: LogEntry[],
  options?: FoundCompanyOptions,
): ActionResult & { companyId?: string; founderId?: string } {
  if (request.recipeOutput && !GOODS.some((good) => good.id === request.recipeOutput)) {
    return { ok: false, error: `未知商品 ${request.recipeOutput}` };
  }
  const fallback = pickFoundingOpportunity(world, config, city.id) ?? null;
  const output = (request.recipeOutput ?? fallback?.output ?? pickOutput(world, city.id).output) as GoodId;
  const assessment = assessFounding(world, config, city.id, output);
  const allowLoan = options?.allowLoan !== false;
  // 可用劳动力 = 劳动力 − 已在岗 − 本轮自动创办已预留岗位；不把同一批失业人口重复分配给多家新企业。
  const availableLabor = Math.max(
    0,
    city.population.laborForce - city.population.employed - Math.max(0, options?.reservedJobs ?? 0),
  );
  // v1.3 §5：恢复「有能力的在营 AI 企业」作为创业主体，但只能用运营缓冲之外的余钱
  // （2 个月工资 + 1 个月原料 + 已知本息），且同 tick 内同一企业只能出资一次、新企业不能立刻再出资，
  // 由 blockedCompanyFounders 阻断 A→B→C 连锁抽血；显式 founderType 的调用保持原语义。
  const blockedCompanyFounders = new Set(options?.blockedCompanyFounders ?? []);
  const founderOrder: FounderType[] = request.founderType
    ? [request.founderType]
    : ['investorGroup', 'company', 'government'];
  const tiers = options?.plan ? [options.plan] : assessment.scaleTiers;
  type ChosenFounder = {
    founderType: FounderType;
    founderId?: string;
    tier: FoundingScaleTier;
    investors: FoundingInvestor[];
  };
  let chosen: ChosenFounder | null = null;
  let founderError: string | null = null;
  // v1.3 §5：记录最接近可行的档位障碍，避免“有档位但无出资人”时 attempt 障碍为空（unknown）。
  let bestObstacles: FoundingObstacle[] = [];
  let bestTier: FoundingScaleTier | null = null;
  for (const tier of tiers) {
    for (const founderType of founderOrder) {
      // AI 自动创办时没有指定企业出资人：在同城挑选一家仍有创办额度、现金最多的企业。
      const founderId =
        founderType === 'company' && !request.founderId
          ? pickCompanyFounder(world, config, city.id, blockedCompanyFounders)
          : request.founderId;
      const capacity = founderCapacityFor(world, config, city.id, founderType, founderId);
      const retuned = retuneTierForAssessment(assessment, tier, capacity, config, allowLoan, availableLabor);
      if (!retuned.feasible) {
        if (retuned.blockers.length > bestObstacles.length) {
          bestObstacles = retuned.blockers;
          bestTier = retuned;
        }
        continue;
      }
      const founderResult = collectFoundingInvestors(
        world,
        { ...request, founderId },
        city,
        config,
        retuned.founderEquity,
        founderType,
      );
      if (!founderResult.ok) {
        // 该档位的资金够、但具体出资人受上限/现金约束不能出钱：尝试下一个出资人类型或更小档位。
        founderError = founderResult.error;
        continue;
      }
      chosen = { founderType, founderId, tier: retuned, investors: founderResult.investors };
      break;
    }
    if (chosen) break;
  }
  if (!chosen) {
    if (founderError) {
      return rejectFounding(
        world,
        request,
        assessment,
        assessment.scaleTiers[0] ?? null,
        [{ kind: 'policy', detail: founderError }],
        request.founderType ?? 'auto',
      );
    }
    return rejectFounding(
      world,
      request,
      assessment,
      bestTier ?? assessment.scaleTiers[0] ?? null,
      bestObstacles.length > 0
        ? bestObstacles
        : assessment.obstacles.length > 0
          ? assessment.obstacles
          : [{ kind: 'capital', detail: '没有可出资的出资人（居民/企业/政府资金均不足）' }],
      request.founderType ?? 'auto',
    );
  }

  const investors = chosen.investors;
  const startupPolicy = startupSupportActive(world, city.id);
  const companyId = nextCompanyId(world, city.id);
  const company = buildFoundingCompany(
    world,
    city,
    companyId,
    output,
    assessment.sector,
    chosen.tier.founderEquity,
    config,
    startupPolicy,
  );
  // v1.1 原子性：先让出资人真实出资到位，再把企业壳放入世界申请贷款/购买设备；
  // 后续任一步失败都会回滚企业、贷款，并把出资原路退回，保证不出现“扣款/贷款/设备/股份/补贴”残留。
  const funded = commitFoundingInvestors(world, city, investors, config, company.name, companyId);
  if (!funded) {
    return rejectFounding(
      world,
      request,
      assessment,
      chosen.tier,
      [{ kind: 'capital', detail: '出资人资金不足以完成真实出资' }],
      chosen.founderType,
    );
  }
  // 企业壳入世界后，贷款审批（ownerExists）与设备采购都以真实企业身份进行。
  world.companies.push(company);

  let loanId: string | undefined;
  let loanAmount = 0;
  if (allowLoan && chosen.tier.loanPrincipal > 0.01) {
    const loanResult = openLoan(
      world,
      {
        owner: { kind: 'company', id: company.id },
        purpose: 'workingCapital',
        amount: chosen.tier.loanPrincipal,
      },
      config,
      world.time.tick,
    );
    if (!loanResult.ok || !loanResult.loan) {
      rollbackFoundingShell(world, company.id);
      refundFoundingInvestors(world, city, investors);
      return rejectFounding(
        world,
        request,
        assessment,
        chosen.tier,
        [{ kind: 'credit', detail: loanResult.error ?? '创业贷款申请失败' }],
        chosen.founderType,
      );
    }
    loanId = loanResult.loan.id;
    loanAmount = loanResult.loan.principal;
  }

  const purchase = buyNewEquipment(world, company, assessment.equipmentKind, chosen.tier.units, config, world.time.tick, {
    allowGovernmentStock: true,
    // v1.3 §5：评估与实际采购同口径——新设企业只使用同城/政府库存，不走跨城运输；
    // 存续企业扩产仍可跨城采购（见 expandCompanyCapacity）。
    allowIntercity: false,
    reason: '创办设备采购',
    log,
  });
  if (!purchase.ok || purchase.units !== chosen.tier.units) {
    rollbackFoundingShell(world, company.id, loanId);
    refundFoundingInvestors(world, city, investors);
    return rejectFounding(
      world,
      request,
      assessment,
      chosen.tier,
      [{ kind: 'equipment', detail: purchase.error ?? `启动设备未按计划购足（${purchase.units}/${chosen.tier.units} 台）` }],
      chosen.founderType,
    );
  }
  if (company.equipmentCapacity <= 0) {
    rollbackFoundingShell(world, company.id, loanId);
    refundFoundingInvestors(world, city, investors);
    return rejectFounding(
      world,
      request,
      assessment,
      chosen.tier,
      [{ kind: 'equipment', detail: '启动设备未形成产能，无法创办企业' }],
      chosen.founderType,
    );
  }
  const equipmentCost = purchase.cost;
  // 政府开局库存是市场之外的一次性供给；设备购买会把成交计入市场账本，
  // 这里同步补充 supply，避免 invariants 误报“成交超过供应”。
  if (purchase.fromGovernment > 0) {
    const equipmentGoodId = config.equipment.catalog[assessment.equipmentKind].goodId;
    const ledger = city.market[equipmentGoodId];
    if (ledger) ledger.supply = round2(ledger.supply + purchase.fromGovernment);
  }
  // v1.1：买完启动设备后至少保留“2 个月基础工资 + 1 个月计划原料采购额”的周转金。
  if (company.cash + 0.01 < chosen.tier.workingCapital) {
    rollbackFoundingShell(world, company.id, loanId);
    refundFoundingInvestors(world, city, investors);
    return rejectFounding(
      world,
      request,
      assessment,
      chosen.tier,
      [
        {
          kind: 'workingCapital',
          detail: `设备采购后现金 ${company.cash.toFixed(
            0,
          )} 低于周转金下限 ${chosen.tier.workingCapital.toFixed(0)}（2 个月工资 + 1 个月计划原料）`,
        },
      ],
      chosen.founderType,
    );
  }
  // v1.2 量纲统一：岗位数=设备产能 ÷ 人均产出（与生产计划口径一致），
  // 不再使用“每台等效工人数”封顶，否则 4 台 farm 设备产能 1.35M 只配 30 人。
  company.maxCapacity = round2(company.equipmentCapacity * config.company.maxCapacityMultiple);

  // v1.2 Lead 口径：成立当月按“设备维护性产出”保守排产并真实上岗一小批员工。
  // 这是为了避免两个死锁：
  //   1) 新企业 employees=0 时生产计划 laborLimit=0 → plannedOutput=0，白招人；
  //   2) 生产计划按需求把 jobDemand 拉满，但首月没有销量/现金，工资把周转金烧成欠薪。
  // 做法：预置首月生产计划（维护性产出 = 设备产能 × minOutputRatio），并只招该计划
  // 需要的员工；之后每月由生产计划按真实销量/库存/现金以 ±20% 平滑增长。
  const perEmployee = outputPerEmployee(world, company, config);
  const bootstrapOutput = round2(
    company.equipmentCapacity * Math.max(0.01, config.production.plan?.minOutputRatio ?? 0.05),
  );
  const bootstrapJobs = Math.max(
    1,
    Math.min(chosen.tier.jobs, Math.ceil(bootstrapOutput / Math.max(1e-6, perEmployee))),
  );
  // v1.3 §5：首月岗位需求直接对齐 bootstrap 计划岗位，而不是“设备满负荷需要的岗位数”。
  // 否则成立后的第一个 reconcileLabor 会在没有任何销量/收入时按满负荷招人，把周转金烧成欠薪。
  // 后续月份由 production-plan 按真实销量/库存/现金平滑增长（±20%），不会锁死在维护性产出。
  company.jobDemand = bootstrapJobs;
  company.productionPlan = {
    tick: world.time.tick,
    salesReference: 0,
    targetInventory: 0,
    equipmentLimit: company.equipmentCapacity,
    laborLimit: round2(bootstrapJobs * perEmployee),
    plannedOutput: bootstrapOutput,
    plannedJobs: bootstrapJobs,
    emergency: false,
    reasons: ['创办首月保守计划：按设备维护性产出起步，后续随真实销量/库存/现金平滑增长'],
  };
  setCompanyEmployees(company, bootstrapJobs);
  syncCityPopulationFromAllocations(city, world);
  // 成立即上岗会改变职业构成：同步群体人数与人均资产，保持“群体合计=城市人口”的口径一致。
  // 下一次 tick 的 syncHouseholdPeople 再计算时 already 一致，不会重复转移资产。
  syncHouseholdPeople(world, config);

  const totalShares = 1_000_000;
  const votingShares = Math.round(totalShares * 0.8);
  const nonVotingShares = totalShares - votingShares;
  const totalInvested = investors.reduce((sum, investor) => sum + investor.cash, 0);
  const weightBase = totalInvested > 0 ? totalInvested : chosen.tier.founderEquity;
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
  const votingSum = votingHolders.reduce((sum, entry) => sum + entry.shares, 0);
  const nonVotingSum = nonVotingHolders.reduce((sum, entry) => sum + entry.shares, 0);
  votingHolders[0]!.shares = round2(votingHolders[0]!.shares + (votingShares - votingSum));
  nonVotingHolders[0]!.shares = round2(nonVotingHolders[0]!.shares + (nonVotingShares - nonVotingSum));

  createShareStructure(world, company, {
    votingShares,
    nonVotingShares,
    votingHolders,
    nonVotingHolders,
    tick: world.time.tick,
    acquiredVia: 'primary',
  });

  let grant = 0;
  if (startupPolicy) {
    grant = startupGrantPayment(world, city, chosen.tier.founderEquity, config, company.id);
    if (grant > 0) company.cash = round2(company.cash + grant);
  }

  const tier = chosen.tier;
  const founderLabel =
    chosen.founderType === 'investorGroup'
      ? `${investors.length} 个居民投资群体联合出资`
      : chosen.founderType === 'company'
        ? '由现有企业出资创办'
        : '由市政府财政出资创办';
  const record: FoundingRecord = {
    id: `founding-${world.lifecycle.nextFoundingNumber}`,
    tick: world.time.tick,
    cityId: city.id,
    companyId,
    companyName: company.name,
    sector: company.sector,
    recipeOutput: company.recipeOutput,
    founderType: chosen.founderType,
    capital: tier.founderEquity,
    investorCount: investors.length,
    investors,
    governmentGrant: grant,
    note: `${founderLabel}。行业评分 ${assessment.score.toFixed(1)} 分（${assessment.reasons.slice(0, 3).join('；')}）；最小可行档 ${tier.units} 台设备、计划岗位 ${tier.jobs} 人，设备支出 ${equipmentCost.toFixed(0)}，首批原料 ${tier.firstBatchInputCost.toFixed(0)}，周转金 ${tier.workingCapital.toFixed(0)}；首月保守上岗 ${bootstrapJobs} 人（按设备维护性产出），后续随销量/现金平滑增长；创业贷款 ${loanAmount.toFixed(0)}（利息约 ${tier.interestCost.toFixed(0)}）。`,
  };
  world.lifecycle.foundings.push(record);
  world.lifecycle.nextFoundingNumber += 1;
  if (world.lifecycle.foundings.length > config.lifecycle.maxHistory) {
    world.lifecycle.foundings.splice(0, world.lifecycle.foundings.length - config.lifecycle.maxHistory);
  }
  recordFoundingAttempt(world, {
    tick: world.time.tick,
    cityId: city.id,
    output,
    sector: assessment.sector,
    score: assessment.score,
    tierUnits: tier.units,
    founderType: chosen.founderType,
    outcome: 'founded',
    companyId,
    obstacles: [],
    capital: tier.founderEquity,
    loan: loanAmount,
    note: record.note,
    ...foundingAttemptSnapshot(assessment, tier),
  });
  log.push({
    tick: world.time.tick,
    kind: 'market',
    message: `${city.name} 新企业「${company.name}」成立：${record.note}创办人出资 ${tier.founderEquity.toFixed(0)}${
      loanAmount > 0 ? `，贷款 ${loanAmount.toFixed(0)}` : ''
    }${grant > 0 ? `，财政扶持 ${grant.toFixed(0)}` : ''}。`,
  });
  return {
    ok: true,
    note: `${company.name} 已成立。`,
    amount: tier.founderEquity,
    companyId: company.id,
    // v1.3：自动创办循环据此把该企业加入本 tick 的 blockedCompanyFounders，阻断连锁抽血。
    founderId: chosen.founderType === 'company' ? chosen.founderId : undefined,
  };
}

/** v1.1 出资人真实扣款：全部成功才返回 true；由调用方在任何世界副作用之前校验。 */
function commitFoundingInvestors(
  world: WorldState,
  city: City,
  investors: FoundingInvestor[],
  config: DemoConfig,
  companyName: string,
  companyId?: string,
): boolean {
  // 先整体校验再统一扣款，任何一位出资人余额不足都不会留下半扣状态。
  let treasuryNeeded = 0;
  for (const investor of investors) {
    if (investor.cash <= 0) continue;
    if (investor.type === 'investorGroup') {
      const group = world.investors.find((entry) => entry.id === investor.id);
      if (!group || group.cash + 1e-6 < investor.cash) return false;
    } else if (investor.type === 'company') {
      const founder = world.companies.find((entry) => entry.id === investor.id);
      if (!founder || founder.cash + 1e-6 < investor.cash) return false;
    } else {
      treasuryNeeded = round2(treasuryNeeded + investor.cash);
    }
  }
  if (city.treasury + 1e-6 < treasuryNeeded) return false;

  for (const investor of investors) {
    if (investor.cash <= 0) continue;
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
        `市政府出资创办 ${companyName}`,
        companyId ? { companyId } : {},
        config,
      );
    }
  }
  return true;
}

/** 创办失败时把已扣出资原路退回（企业/贷款回滚后调用），保证货币守恒。 */
function refundFoundingInvestors(
  world: WorldState,
  city: City,
  investors: FoundingInvestor[],
): void {
  for (const investor of investors) {
    if (investor.cash <= 0) continue;
    if (investor.type === 'investorGroup') {
      const group = world.investors.find((entry) => entry.id === investor.id);
      if (group) group.cash = round2(group.cash + investor.cash);
    } else if (investor.type === 'company') {
      const founder = world.companies.find((entry) => entry.id === investor.id);
      if (founder) founder.cash = round2(founder.cash + investor.cash);
    } else {
      city.treasury = round2(city.treasury + investor.cash);
    }
  }
}

/** 回滚创办失败的企业壳（以及刚放款的贷款），保证不留下资金/股份/贷款副作用。 */
function rollbackFoundingShell(world: WorldState, companyId: string, loanId?: string): void {
  const company = world.companies.find((entry) => entry.id === companyId);
  if (loanId) {
    const banking = world.banking;
    const index = banking.loans.findIndex((entry) => entry.id === loanId);
    if (index >= 0) {
      const loan = banking.loans[index]!;
      if (company) company.cash = round2(company.cash - loan.principal);
      banking.loans.splice(index, 1);
      banking.lastMonth.principalIssued = round2(banking.lastMonth.principalIssued - loan.principal);
      if (company) company.debt = round2(Math.max(0, company.debt - loan.principal));
    }
  }
  const companyIndex = world.companies.findIndex((entry) => entry.id === companyId);
  if (companyIndex >= 0) world.companies.splice(companyIndex, 1);
  refreshBankingTotals(world);
}

function blankStats(): Company['lastMonth'] {
  return {
    revenue: 0,
    inputCost: 0,
    cogs: 0,
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
    bonusPaid: 0,
    equipmentPurchased: 0,
    equipmentSold: 0,
    emergencyLayoffs: 0,
  };
}

/**
 * 扩产投资：企业自有资金 + 设备补助政策，真实购买设备（产能由设备决定）。
 *
 * 原子性口径（v0.9 验收修复）：
 * 1) 先按真实供给规划成交（planNewEquipmentPurchase），此时不产生任何资金/库存/设备变化；
 * 2) 按“实际成交额 × 补贴率”申请补贴，且不超过政策剩余预算与财政可用余额；
 * 3) 再原子提交成交（executeNewEquipmentPlan）。任一步失败都不留下补贴、库存或设备副作用。
 *
 * 预算上限保证：企业自有现金 + 可到账补贴 ≥ 成交额，且补贴 ≤ 成交额 × 补贴率。
 * 补贴只按实际成交额结算；部分成交时按实际成交部分计算，不按计划量预支。
 */
export function expandCompanyCapacity(
  world: WorldState,
  company: Company,
  config: DemoConfig,
  log: LogEntry[],
  requestedUnits?: number,
): ActionResult {
  const city = world.cities.find((entry) => entry.id === company.cityId);
  if (!city) return { ok: false, error: '企业城市不存在' };
  const kind = equipmentKindForSector(company.sector, config);
  // v1.3 §5：requestedUnits 是“设备台数”（planning 已按设备单价换算），不是产能单位。
  // 仍受 maxExpansionShare（单月产能扩张上限）约束：把 8% 产能折算成可购台数。
  const perUnit = Math.max(1, equipmentCapacityPerUnit(config, kind, company.recipeOutput));
  const growthCapUnits = Math.max(
    1,
    Math.floor((company.capacity * config.companyAi.maxExpansionShare) / perUnit),
  );
  const plannedUnits = Math.max(
    1,
    Math.min(Math.floor(requestedUnits ?? growthCapUnits), growthCapUnits),
  );
  const catalog = config.equipment.catalog[kind];
  const policy = activePolicy(world, city.id, 'equipmentSubsidy');
  const subsidyRate = Math.max(0, config.policies.equipment.subsidyRate);
  const subsidyCapacity = policy
    ? round2(Math.max(0, Math.min(remainingBudget(policy), city.treasury)))
    : 0;

  // 可动用预算：自有现金 + 最多可到账补贴，并保证“补贴 ≤ 成交额 × 补贴率”与“现金 + 补贴 ≥ 成交额”。
  // 补贴按实际成交额与政策剩余预算孰低结算，因此预算上限只需“现金 + 可到账补贴”，
  // 再叠加“现金 / (1 − 补贴率)”保证企业自有资金足以承担补贴后的差额。
  let budget = round2(Math.max(0, company.cash));
  if (policy && subsidyRate > 0 && subsidyCapacity > 0) {
    budget = round2(
      Math.min(
        budget + subsidyCapacity,
        // 留 0.01 余量，避免补贴按分取整后比成交额少 0.01 导致提交失败。
        Math.max(0, company.cash / (1 - subsidyRate) - 0.01),
      ),
    );
  }

  const plan = planNewEquipmentPurchase(world, company, kind, plannedUnits, config, {
    allowGovernmentStock: true,
    // 本城不足时允许通过既有跨城运输模型向其他城市设备企业采购（同城优先）。
    allowIntercity: true,
    budget,
  });
  if (!plan.ok || plan.units <= 0) {
    return { ok: false, error: plan.error ?? '设备购买失败' };
  }

  // 补贴只按实际成交额结算，且不超过政策剩余预算与财政可用余额。
  const subsidy = policy
    ? equipmentSubsidyPayment(world, city, plan.cost, config, company.id)
    : 0;
  if (subsidy > 0) company.cash = round2(company.cash + subsidy);

  // 防御：若补贴按分取整后仍差一点，先按自有现金缩减计划，避免出现“补贴已付但买不起”。
  let finalPlan = plan;
  if (company.cash + 1e-6 < plan.cost) {
    finalPlan = planNewEquipmentPurchase(world, company, kind, plan.units, config, {
      allowGovernmentStock: true,
      allowIntercity: true,
      budget: round2(company.cash),
    });
    if (!finalPlan.ok || finalPlan.units <= 0) {
      if (subsidy > 0) refundEquipmentSubsidy(world, city, policy!, company, subsidy, config);
      return { ok: false, error: '扩产资金不足：补贴结算后仍无法完成成交' };
    }
    const allowedSubsidy = round2(Math.min(subsidy, finalPlan.cost * subsidyRate));
    const excess = round2(subsidy - allowedSubsidy);
    if (excess > 0) {
      company.cash = round2(company.cash - excess);
      refundEquipmentSubsidy(world, city, policy!, company, excess, config);
    }
  }

  const purchase = executeNewEquipmentPlan(world, company, kind, finalPlan, config, world.time.tick, {
    reason: '扩产投资',
    log,
  });
  if (!purchase.ok) {
    // 成交提交失败：退还已到账补贴，保持资金/政策预算/库存/设备全部无副作用。
    if (subsidy > 0) refundEquipmentSubsidy(world, city, policy!, company, subsidy, config);
    return { ok: false, error: purchase.error ?? '设备购买失败' };
  }

  const actualSubsidy = round2(Math.min(subsidy, purchase.cost * subsidyRate));
  const excessSubsidy = round2(subsidy - actualSubsidy);
  if (excessSubsidy > 0) {
    company.cash = round2(company.cash - excessSubsidy);
    refundEquipmentSubsidy(world, city, policy!, company, excessSubsidy, config);
  }
  const netCost = round2(purchase.cost - actualSubsidy);
  const capacityPerNewUnit = equipmentCapacityPerUnit(config, kind, company.recipeOutput);
  company.lastMonth.capacityChange = round2(
    company.lastMonth.capacityChange + purchase.units * capacityPerNewUnit,
  );
  log.push({
    tick: world.time.tick,
    kind: 'production',
    message: `${company.name} 购买${catalog.name} ${purchase.units} 台扩产${purchase.fromIntercity > 0 ? `（含跨城 ${purchase.fromIntercity} 台）` : ''}，实际支出 ${netCost.toFixed(0)}${actualSubsidy > 0 ? `（设备补助 ${actualSubsidy.toFixed(0)} 来自财政）` : ''}；产能 ${company.capacity.toFixed(0)} 单位/月。`,
  });
  const capacityGain = round2(purchase.units * capacityPerNewUnit);
  return { ok: true, note: `产能增加 ${capacityGain.toFixed(0)} 单位/月。`, amount: netCost };
}

/**
 * 退还扩产补贴（仅用于成交失败/缩减时的回滚）：资金退回财政、政策预算与本月支出同步冲回。
 *
 * 使用财政流水的反向记账（负 policySpending），保证“财政现金守恒 + 政策 spent 可追溯”。
 */
function refundEquipmentSubsidy(
  world: WorldState,
  city: City,
  policy: { policyId: PolicyId; spent: number },
  company: Company,
  amount: number,
  config: DemoConfig,
): void {
  const refund = round2(Math.min(amount, Math.max(0, company.cash)));
  if (refund <= 0) return;
  company.cash = round2(company.cash - refund);
  receiveTreasury(world, city, refund, 'policySpending', '设备与扩产补助（未成交回滚）', {
    policyId: policy.policyId,
    companyId: company.id,
  });
  policy.spent = round2(Math.max(0, policy.spent - refund));
  city.lastMonth.policySpending = round2(Math.max(0, city.lastMonth.policySpending - refund));
}

/**
 * v0.9：企业清算时把名下未到期政府债券按持股比例转给股东。
 *
 * 债券是企业的真实资产（可收回本金与利息），企业退出不能让它凭空消失，也不能凭空兑付
 * （那会创造货币）。这里只做持有人变更：整数份按持股比例最大余数分配，按面额换算本金；
 * 同批次同持有人已有持仓时合并。无任何兼容股东（玩家/投资实体/其他企业）持有时，
 * 债权标记为已兑付并注明“注销”，不产生任何资金流。
 */
function redistributeLiquidatedBonds(
  world: WorldState,
  company: Company,
  log: LogEntry[],
): number {
  const ledger = world.bonds;
  if (!ledger) return 0;
  const holdings = ledger.holdings.filter(
    (holding) =>
      holding.status === 'active' &&
      holding.holder.kind === 'company' &&
      holding.holder.id === company.id,
  );
  if (holdings.length === 0) return 0;
  const shareholders: { summary: ReturnType<typeof companyHolders>[number]; bondHolder: BondHolder }[] = [];
  for (const summary of companyHolders(world, company.id)) {
    if (summary.totalShares <= 0) continue;
    const bondHolder = toBondHolder(summary.holder);
    if (!bondHolder) continue;
    if (
      bondHolder.kind === 'company' &&
      (bondHolder.id === company.id || !world.companies.some((entry) => entry.id === bondHolder.id))
    ) {
      continue;
    }
    shareholders.push({ summary, bondHolder });
  }
  shareholders.sort((a, b) => b.summary.totalShares - a.summary.totalShares);
  const weights = shareholders.map((entry) => entry.summary.totalShares);
  let movedUnits = 0;
  for (const holding of holdings) {
    if (shareholders.length === 0) {
      holding.status = 'redeemed';
      holding.redeemedTick = world.time.tick;
      holding.accruedInterest = 0;
      holding.note = `${holding.note}；企业清算时无兼容股东持有，债权注销`;
      continue;
    }
    const parts = allocateUnitsLargestRemainder(holding.units, weights);
    const faceValue =
      holding.units > 0
        ? holding.principal / holding.units
        : ledger.issuances.find((entry) => entry.id === holding.issuanceId)?.faceValue ?? 0;
    for (let index = 0; index < shareholders.length; index++) {
      const units = parts[index] ?? 0;
      const shareholder = shareholders[index];
      if (!shareholder || units <= 0) continue;
      const bondHolder = shareholder.bondHolder;
      const principal = round2(units * faceValue);
      const existing = ledger.holdings.find(
        (entry) =>
          entry !== holding &&
          entry.status === 'active' &&
          entry.issuanceId === holding.issuanceId &&
          entry.holder.kind === bondHolder.kind &&
          entry.holder.id === bondHolder.id,
      );
      if (existing) {
        existing.units += units;
        existing.principal = round2(existing.principal + principal);
        existing.note = `持有 ${existing.units} 份（含企业清算转入）`;
      } else {
        ledger.holdings.push({
          ...holding,
          id: `bondholding-${ledger.nextHoldingNumber}`,
          holder: bondHolder,
          units,
          principal,
          note: `持有 ${units} 份（${company.name} 清算时按持股比例转入）`,
        });
        ledger.nextHoldingNumber += 1;
      }
      movedUnits += units;
    }
    const position = ledger.holdings.indexOf(holding);
    if (position >= 0) ledger.holdings.splice(position, 1);
  }
  if (movedUnits > 0) {
    log.push({
      tick: world.time.tick,
      kind: 'system',
      message: `${company.name} 清算：名下 ${movedUnits} 份政府债券已按持股比例转给股东（不产生资金流）。`,
    });
  }
  return movedUnits;
}

/** 股份持有人 → 债券持有人（股权可对应 player/investorGroup/company）。 */
function toBondHolder(holder: HolderRef): BondHolder | null {
  if (holder.type === 'player') return { kind: 'player', id: 'player' };
  if (holder.type === 'investorGroup' || holder.type === 'company') {
    return { kind: holder.type, id: holder.id };
  }
  return null;
}

/** 整数按权重最大余数分配（确定性：余数相同时按原顺序）。 */
function allocateUnitsLargestRemainder(total: number, weights: number[]): number[] {
  const result = weights.map(() => 0);
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0);
  if (total <= 0 || weightSum <= 0) return result;
  const exact = weights.map((weight) => (total * weight) / weightSum);
  let assigned = 0;
  for (let index = 0; index < exact.length; index++) {
    result[index] = Math.floor(exact[index] ?? 0);
    assigned += result[index] ?? 0;
  }
  let remaining = total - assigned;
  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  let cursor = 0;
  while (remaining > 0 && order.length > 0) {
    const targetIndex = order[cursor % order.length]?.index ?? 0;
    result[targetIndex] = (result[targetIndex] ?? 0) + 1;
    remaining -= 1;
    cursor += 1;
  }
  return result;
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
  // v1.3：清算按存货账面成本注销（旧档无账面成本时按当期市场价估值），
  // 注销额单独记 inventoryWriteOff，避免与正常销售的 COGS 重复。
  const inventoryWrittenOff = writeOffInventory(company, (goodId) => prices[goodId] ?? 0);
  const inventoryBookValue = round2(inventoryWrittenOff.reduce((sum, entry) => sum + entry.bookValue, 0));
  company.lastMonth.inventoryWriteOff = round2(
    (company.lastMonth.inventoryWriteOff ?? 0) + inventoryBookValue,
  );

  // v0.9：设备资产按真实买家处置（无人购买则移交政府设备库存，不按账面变现）。
  const equipmentSale = disposeCompanyEquipment(world, company, config, world.time.tick, log);
  if (equipmentSale.proceeds > 0) {
    company.cash = round2(company.cash + equipmentSale.proceeds);
  }
  // v0.9：债券是企业的真实资产，清算时不得凭空消失——先按持股比例转给股东。
  redistributeLiquidatedBonds(world, company, log);

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
    const wage = monthlyWageBill(company, config);
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
 * 月度：企业与居民群体按评分创办新企业。
 * 每城每月最多 maxFoundingsPerCityMonth 家（v1.2 为 100，是上限不是目标；v1.1 原为 4 家）；每次分别通过市场评分、
 * 资金、设备与劳动力检查；不再使用旧的 foundingCooldownMonths 冷却判断。
 * 初始 17 家种子企业不受影响：这里只处理运行期内新创办的企业。
 */
/** 同一 tick、同一城市已写过同类停止原因时不重复刷 attempt。 */
function hasTickAttempt(world: WorldState, cityId: string, marker: string): boolean {
  return foundingAttempts(world).some(
    (attempt) =>
      attempt.tick === world.time.tick &&
      attempt.cityId === cityId &&
      attempt.note.includes(marker),
  );
}

/** 记录“本轮自动创办停止”的结构化原因（城市上限/月度上限），供 UI 与验收统计。 */
function recordFoundingStop(
  world: WorldState,
  config: DemoConfig,
  cityId: string,
  kind: FoundingObstacle['kind'],
  detail: string,
): void {
  if (hasTickAttempt(world, cityId, detail)) return;
  const probe = assessFounding(world, config, cityId, pickOutput(world, cityId).output as GoodId);
  recordFoundingAttempt(world, {
    tick: world.time.tick,
    cityId,
    output: probe.output,
    sector: probe.sector,
    score: probe.score,
    tierUnits: null,
    founderType: 'auto',
    outcome: 'rejected',
    obstacles: [{ kind, detail }],
    capital: 0,
    loan: 0,
    note: `本轮自动创办停止：${detail}`,
    ...foundingAttemptSnapshot(probe, null),
  });
}

/**
 * v1.2 自动创办：每城每月最多 maxFoundingsPerCityMonth 家（默认 100，是上限不是目标）。
 *
 * 关键约束：
 * - 每轮循环都基于“上一家成立之后”的最新世界状态重新评估（资金、设备库存、劳动力、竞争、缺口），
 *   不缓存 assessment，也不允许多家企业重复使用同一笔资金/同一批设备；
 * - 每次创办前重新检查在营企业数（160 上限；倒闭后企业已移出 world.companies，名额自动释放）；
 * - 机会/资金/设备/劳动力耗尽即早停，避免 100×11 行业×3 档位的空转；
 * - 玩家经 foundCompany 直接发起的创办不经过本函数，因此不受月上限限制（只受 160 与真实资源约束）。
 */
export function maybeFoundCompanies(
  world: WorldState,
  config: DemoConfig,
  log: LogEntry[],
): string[] {
  const created: string[] = [];
  const monthlyLimit = Math.max(0, Math.floor(config.lifecycle.maxFoundingsPerCityMonth));
  if (monthlyLimit <= 0) return created;

  // foundings 历史按 maxHistory（60）裁剪，单月超过 60 家时不能再用它统计；
  // 用持久化的本月计数保证同月重复调用 / 多城循环都按真实数量执行上限。
  const month = world.lifecycle.foundingMonth;
  if (!month || month.tick !== world.time.tick) {
    world.lifecycle.foundingMonth = { tick: world.time.tick, counts: {}, foundersUsed: {} };
  }
  const counts = world.lifecycle.foundingMonth!.counts;
  const foundersUsed = world.lifecycle.foundingMonth!.foundersUsed ?? {};

  for (const city of [...world.cities].sort((a, b) => a.id.localeCompare(b.id))) {
    let foundThisTick = counts[city.id] ?? 0;
    // v1.3 §5：本 tick 已用作出资人的在营企业 + 本 tick 新成立的企业。
    // 同一企业每月只能出资一次，新企业不能立刻再出资，避免 A→B→C 连锁抽血；
    // 该集合持久化到 foundingMonth，同 tick 多次调用也不会重置。
    const blockedCompanyFounders = new Set<string>(foundersUsed[city.id] ?? []);
    for (let attempt = 0; attempt < monthlyLimit; attempt++) {
      // 160 在营上限：每次创办前按最新 world.companies 重新检查（口径与 foundCompany 一致）。
      if (cityCompanyCount(world, city.id) >= config.lifecycle.maxCompaniesPerCity) {
        recordFoundingStop(
          world,
          config,
          city.id,
          'policy',
          `在营企业已达城市上限 ${config.lifecycle.maxCompaniesPerCity} 家`,
        );
        break;
      }
      if (foundThisTick >= monthlyLimit) {
        recordFoundingStop(world, config, city.id, 'policy', `本月自动创办已达上限 ${monthlyLimit} 家`);
        break;
      }

      // 不缓存：本轮评估结果只用于本次创办；下一次循环会重新读取最新资金/设备/劳动/竞争/缺口。
      const opportunities = assessFoundingOpportunities(world, config, city.id).filter(
        (assessment) => assessment.feasibleTier !== null,
      );
      if (opportunities.length === 0) {
        recordFoundingStop(
          world,
          config,
          city.id,
          'demand',
          '没有可成立的创业机会（缺口/资金/设备/劳动力/利润均不满足）',
        );
        break;
      }

      let founded = false;
      for (const assessment of opportunities) {
        const result = foundCompany(
          world,
          { cityId: city.id, recipeOutput: assessment.output, log },
          config,
          { blockedCompanyFounders: [...blockedCompanyFounders] },
        );
        if (result.ok && result.companyId) {
          created.push(result.companyId);
          foundThisTick += 1;
          counts[city.id] = foundThisTick;
          // v1.3：本 tick 新企业不能当出资人；实际出资企业每月也只能出资一次。
          blockedCompanyFounders.add(result.companyId);
          if (result.founderId) blockedCompanyFounders.add(result.founderId);
          foundersUsed[city.id] = [...blockedCompanyFounders];
          world.lifecycle.foundingMonth!.foundersUsed = foundersUsed;
          // v1.2：成立时员工已计入 city.population.employed，下一次循环的劳动力上限
          // 直接读最新就业即可，不再额外预留 reservedJobs（否则会重复扣减同一批失业人口）。
          founded = true;
          break;
        }
        // 失败原因已由 foundCompany 写入 foundingAttempts；继续尝试下一个行业机会。
      }
      if (!founded) break;
    }
    // 本轮把该城月上限用满时也写一条结构化停止原因（尝试次数循环结束时不会自然进入下一轮）。
    if (foundThisTick >= monthlyLimit) {
      recordFoundingStop(world, config, city.id, 'policy', `本月自动创办已达上限 ${monthlyLimit} 家`);
    }
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

