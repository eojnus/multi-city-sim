import type {
  City,
  Company,
  EquipmentKind,
  FoundingRecord,
  GoodId,
  SectorId,
  WorldState,
} from '../contracts/types';
import type { DemoConfig } from '../../data/config';
import { GOODS, PRODUCTIVITY, RECIPES } from '../../data/demo-data';
import { clamp, round2 } from '../core/math';
import {
  equipmentCapacityPerUnit,
  equipmentKindForSector,
  equipmentUnitPrice,
  newEquipmentSupply,
} from '../equipment/equipment';
import { workforceSkillMultiplier } from '../labor/workforce';
import { groupsOfCity } from '../investors/investors';
import { startupSupportActive } from '../policies/query';

/**
 * 创业评估（v0.9 T3 起步，v1.0 task-27 扩展为“最小可行规模”）。
 *
 * 评分不是拿“未满足需求数量”直接和“利润”比较，而是把候选行业放到同一套归一化口径里：
 * 售价相对基准与趋势、有支付能力但未满足的需求、近期销量与库存、同城竞争者数量与产能份额、
 * 设备可获得性、原料本地覆盖与跨城运输成本、工资成本、劳动力可得性、真实出资/授信、
 * 单位毛利与“按份额可触达销量”下的预期利润。
 *
 * 评估本身只读取世界、不修改状态；真正的出资、贷款与设备采购在 lifecycle。
 *
 * v1.0 关键口径：
 * - 每个行业按 1 / 2 / 4 台设备给出规模档位；每个档位都由设备产能 + 配置里的生产率动态推出
 *   员工数、首批原料、周转金与利息（设备厂口径：初始员工 60、1 台设备、现金约 4 个月工资，
 *   但这里不硬编码 60，全部从 config.equipment / config.labor / demo-data 推导）；
 * - 首档必须覆盖“首批原料 + 周转金”，资本不足时先降档，最小档仍不够则失败并记录结构化障碍；
 * - 设备可获得性只统计“本城设备企业库存 + 政府库存”，其他城市库存无法在创办时直接购买。
 */

export const FOUNDING_MIN_SCORE = 20;

/** 每个档位可买设备台数（行业最小可行规模的候选档）。 */
export const FOUNDING_SCALE_UNITS = [1, 2, 4] as const;

/** 分项评分（每项已 clamp，total 为七项之和）。 */
export interface FoundingScoreBreakdown {
  price: number;
  demand: number;
  competition: number;
  equipment: number;
  supplyChain: number;
  cost: number;
  profit: number;
  total: number;
}

/** 一个候选行业的评分、理由与创业规模估算（v0.9 兼容口径）。 */
export interface FoundingCandidate {
  output: GoodId;
  sector: SectorId;
  equipmentKind: EquipmentKind;
  score: number;
  breakdown: FoundingScoreBreakdown;
  reasons: string[];
  /** 按同城需求与竞争者份额估算的月可触达销量。 */
  reachableSales: number;
  /** 单位毛利 × 可触达销量（未扣固定费用）。 */
  expectedMonthlyProfit: number;
  /** 设备 + 首批原料 + 首月工资的估算启动资本。 */
  suggestedCapital: number;
  /** 同城设备企业库存 + 政府开局库存 + 其他城市设备企业可售量（台）。 */
  availableEquipmentUnits: number;
  unitPrice: number;
  /** 每台设备在本城技术条件下的月产能。 */
  unitCapacity: number;
  /** 按可触达销量需要的设备台数（未按资金裁剪）。 */
  demandUnits: number;
}

// ---------------------------------------------------------------- v1.0 评估类型

export type FounderType = 'investorGroup' | 'company' | 'government';

export type FoundingObstacleKind =
  | 'capital'
  | 'credit'
  | 'equipment'
  | 'inputs'
  | 'labor'
  | 'profit'
  | 'demand'
  | 'policy';

/** 结构化失败障碍：供日志、UI 与验收报告统计“缺口可见但被什么挡住”。 */
export interface FoundingObstacle {
  kind: FoundingObstacleKind;
  detail: string;
}

/** 一个规模档位（1/2/4 台设备）。 */
export interface FoundingScaleTier {
  units: number;
  /** 该档设备对应的真实员工数。 */
  jobs: number;
  equipmentCost: number;
  firstBatchInputCost: number;
  /** 周转金：工资储备 + 原料安全库存。 */
  workingCapital: number;
  loanPrincipal: number;
  interestCost: number;
  totalCapital: number;
  founderEquity: number;
  expectedMonthlyProfit: number;
  feasible: boolean;
  blockers: FoundingObstacle[];
}

export interface FoundingAssessment {
  output: GoodId;
  sector: SectorId;
  equipmentKind: EquipmentKind;
  score: number;
  /** 价格、需求、销量、库存、竞争、原料、设备、劳动、运输、融资、利润（各 −10..10，供 UI 归一化展示）。 */
  dimensions: {
    price: number;
    payableDemand: number;
    recentSales: number;
    inventory: number;
    competition: number;
    inputs: number;
    equipment: number;
    labor: number;
    transport: number;
    financing: number;
    profit: number;
  };
  metrics: {
    expectedPrice: number;
    /** 近 3 月价格变化（当前无价格历史，退回最近一次 lastPriceChangePct）。 */
    priceTrend3m: number;
    /** 有支付能力但未满足的需求（market.unmetDemand，区别于资金不足的 unmetFunding）。 */
    payableUnmetDemand: number;
    unmetFunding: number;
    /** 同城同行业企业最近 3 个月销量合计。 */
    recentSales3m: number;
    inventory: number;
    competitors: number;
    competitorCapacity: number;
    expectedInputCost: number;
    expectedWageCost: number;
    expectedTransportCost: number;
    expectedInterest: number;
    startupCost: number;
    expectedMonthlyProfit: number;
    founderEquity: number;
    loanAvailable: number;
    financingGap: number;
  };
  scaleTiers: FoundingScaleTier[];
  feasibleTier: FoundingScaleTier | null;
  obstacles: FoundingObstacle[];
  reasons: string[];
  /** 该城最低创办资本（含初创扶持减免），供档位重算使用。 */
  requiredCapital: number;
}

export type FoundingAttemptOutcome = 'founded' | 'rejected';

/**
 * 每次创办尝试的结构化记录（含失败）。存到 world.lifecycle.foundingAttempts：
 * 这是运行时诊断字段，不属于存档强校验字段；类型上用 module augmentation 扩展，
 * 避免改动 Lead 拥有的 contracts/types.ts。
 */
export interface FoundingAttemptRecord {
  id: string;
  tick: number;
  cityId: string;
  output: GoodId;
  sector: SectorId;
  score: number;
  tierUnits: number | null;
  founderType: FounderType | 'auto';
  outcome: FoundingAttemptOutcome;
  companyId?: string;
  obstacles: FoundingObstacle[];
  capital: number;
  loan: number;
  note: string;
}

declare module '../contracts/types' {
  interface CompanyLifecycleState {
    foundingAttempts?: FoundingAttemptRecord[];
  }
}

// ---------------------------------------------------------------- 基础工具

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
    case 'farmEquipment':
    case 'industryEquipment':
    case 'energyEquipment':
      return 'equipment';
    default:
      return 'appliance';
  }
}

function basePriceOf(output: GoodId): number {
  return GOODS.find((good) => good.id === output)?.basePrice ?? 1;
}

function cityOf(world: WorldState, cityId: string): City | undefined {
  return world.cities.find((city) => city.id === cityId);
}

function productionShare(output: GoodId, city: City): number {
  const market = city.market[output];
  const demand = Math.max(0, market?.demand ?? 0);
  const unmet = Math.max(0, market?.unmetDemand ?? 0);
  const sold = Math.max(0, market?.sold ?? 0);
  if (demand + unmet <= 0) return 0;
  return clamp(unmet / (demand + unmet), 0, 1);
}

function availableEquipment(
  world: WorldState,
  config: DemoConfig,
  cityId: string,
  kind: EquipmentKind,
): { local: number; government: number; intercity: number; total: number } {
  // 评估与实际采购共用同一来源口径（同城库存 + 政府库存 + 其他城市可售量）。
  return newEquipmentSupply(world, cityId, kind, config);
}

/**
 * 本城技术条件下的单位员工月产出（与生产模块同口径：生产率 × 技术 × 技能 × 劳动容量系数）。
 * 策略/领导修正按 1 处理，避免把尚未发生的经营改善算进创业评估。
 */
function perEmployeeFor(city: City, output: GoodId, config: DemoConfig): number {
  return Math.max(
    1e-6,
    (PRODUCTIVITY[output] ?? 1) *
      (city.technology.productivityMultiplier || 1) *
      workforceSkillMultiplier(city) *
      config.production.laborCapacityFactor,
  );
}

function unitEconomics(
  world: WorldState,
  config: DemoConfig,
  city: City,
  output: GoodId,
): {
  price: number;
  inputCostPerUnit: number;
  localCoverage: number;
  importMarkup: number;
  wagePerUnit: number;
  transportCostPerUnit: number;
  unitMargin: number;
  perEmployee: number;
} {
  const market = city.market[output];
  const price = Math.max(0.01, market?.price ?? basePriceOf(output));
  const recipe = RECIPES[output];
  const inputs = recipe?.inputs ?? [];
  let inputCostPerUnit = 0;
  let coverageSum = 0;
  const unitCapacity = Math.max(
    1,
    equipmentCapacityPerUnit(
      config,
      equipmentKindForSector(sectorForOutput(output), config),
      output,
    ) * (city.technology.productivityMultiplier || 1),
  );
  for (const input of inputs) {
    const inputMarket = city.market[input.good];
    const inputPrice = Math.max(0.01, inputMarket?.price ?? basePriceOf(input.good));
    inputCostPerUnit += input.qty * inputPrice;
    const monthlyNeed = Math.max(1e-9, unitCapacity * input.qty);
    const localSupply = Math.max(0, (inputMarket?.closingStock ?? 0) + (inputMarket?.supply ?? 0));
    coverageSum += clamp(localSupply / monthlyNeed, 0, 1);
  }
  const localCoverage = inputs.length > 0 ? coverageSum / inputs.length : 1;
  const perEmployee = perEmployeeFor(city, output, config);
  const wagePerUnit = config.labor.privateWageRate / perEmployee;
  const importMarkup = clamp(
    config.intercity.maxMarkup * (1 - localCoverage),
    0,
    config.intercity.maxMarkup,
  );
  const transportCostPerUnit = inputCostPerUnit * importMarkup;
  const unitMargin = price - inputCostPerUnit - wagePerUnit - transportCostPerUnit;
  return {
    price,
    inputCostPerUnit,
    localCoverage,
    importMarkup,
    wagePerUnit,
    transportCostPerUnit,
    unitMargin,
    perEmployee,
  };
}

function requiredStartingCapital(world: WorldState, config: DemoConfig, cityId: string): number {
  const capitalRelief = startupSupportActive(world, cityId)
    ? config.policies.startup.capitalRelief
    : 0;
  return round2(config.lifecycle.minCapital * (1 - capitalRelief));
}

/** 创办人真实可出资金额（不含贷款）：居民投资群体按联合出资口径、企业按自有现金、政府按财政。 */
export interface FoundingFounderCapacity {
  investorGroup: number;
  company: number;
  government: number;
  best: number;
}

export function foundingFounderCapacity(
  world: WorldState,
  config: DemoConfig,
  cityId: string,
): FoundingFounderCapacity {
  const city = cityOf(world, cityId);
  if (!city) return { investorGroup: 0, company: 0, government: 0, best: 0 };
  const investorGroup = investorGroupFounderCapacity(world, config, city);
  const company = companyFounderCapacity(world, config, city);
  const government = governmentFounderCapacity(world, config, city);
  return {
    investorGroup,
    company,
    government,
    best: Math.max(investorGroup, company, government),
  };
}

function foundingCount(
  world: WorldState,
  predicate: (record: FoundingRecord) => boolean,
): number {
  return world.lifecycle.foundings.filter(predicate).length;
}

function investorGroupFounderCapacity(world: WorldState, config: DemoConfig, city: City): number {
  const eligible = groupsOfCity(world, city.id)
    .filter((group) => {
      const people = Math.round(city.population.total * group.populationShare);
      return (
        people >=
          config.lifecycle.populationPerInvestorGroup / config.lifecycle.maxInvestorsPerSyndicate &&
        group.cash > 0
      );
    })
    .sort((a, b) => b.cash - a.cash || a.id.localeCompare(b.id));
  const count = Math.min(eligible.length, config.lifecycle.maxInvestorsPerSyndicate);
  if (count <= 0) return 0;
  const smallest = eligible[count - 1]!.cash;
  return round2(count * smallest);
}

function companyFounderCapacity(world: WorldState, config: DemoConfig, city: City): number {
  const candidates = world.companies
    .filter(
      (company) =>
        company.cityId === city.id &&
        company.cash > 0 &&
        foundingCount(
          world,
          (record) =>
            record.founderType === 'company' &&
            record.investors.some((investor) => investor.id === company.id),
        ) < config.lifecycle.maxCompaniesPerCompany,
    )
    .sort((a, b) => b.cash - a.cash || a.id.localeCompare(b.id));
  return candidates[0]?.cash ?? 0;
}

function governmentFounderCapacity(world: WorldState, config: DemoConfig, city: City): number {
  const count = foundingCount(
    world,
    (record) => record.founderType === 'government' && record.cityId === city.id,
  );
  if (count >= config.lifecycle.maxGovernmentCompaniesPerCity) return 0;
  return Math.max(0, city.treasury);
}

/** 指定主体的真实可出资金额；用于显式指定创办人时重算档位。 */
export function founderCapacityFor(
  world: WorldState,
  config: DemoConfig,
  cityId: string,
  founderType: FounderType,
  founderId?: string,
): number {
  const city = cityOf(world, cityId);
  if (!city) return 0;
  if (founderType === 'investorGroup') {
    if (founderId) {
      const group = groupsOfCity(world, cityId).find((entry) => entry.id === founderId);
      if (!group) return 0;
      const people = Math.round(city.population.total * group.populationShare);
      const minPeople =
        config.lifecycle.populationPerInvestorGroup / config.lifecycle.maxInvestorsPerSyndicate;
      return people >= minPeople ? Math.max(0, group.cash) : 0;
    }
    return investorGroupFounderCapacity(world, config, city);
  }
  if (founderType === 'company') {
    if (founderId) {
      const company = world.companies.find((entry) => entry.id === founderId);
      if (!company || company.cityId !== city.id) return 0;
      const count = foundingCount(
        world,
        (record) =>
          record.founderType === 'company' &&
          record.investors.some((investor) => investor.id === company.id),
      );
      return count < config.lifecycle.maxCompaniesPerCompany ? Math.max(0, company.cash) : 0;
    }
    return companyFounderCapacity(world, config, city);
  }
  return governmentFounderCapacity(world, config, city);
}

/**
 * 与银行 live credit 口径一致的企业壳可贷额度：
 * 企业账面价值 = 现金 + 库存 + 产能×0.6 + 300000 − 债务（companyBookValue）；
 * 创办壳在贷款前现金=创办人出资、无库存/产能/债务，故基数 = 出资 + 300000，额度 = 基数 × creditLimitRate。
 */
export function loanCapacityFor(founderEquity: number, config: DemoConfig): number {
  const base = Math.max(0, founderEquity) + 300_000;
  return round2(base * config.banking.creditLimitRate);
}

function buildTier(
  world: WorldState,
  config: DemoConfig,
  city: City,
  output: GoodId,
  candidate: FoundingCandidate,
  units: number,
  purchasable: number,
  requiredCapital: number,
  founderCapacity: number,
  economics: ReturnType<typeof unitEconomics>,
): FoundingScaleTier {
  const equipCost = round2(units * candidate.unitPrice);
  const capacity = units * candidate.unitCapacity;
  const outputQty = capacity * config.company.initialUtilization;
  const jobs = Math.max(1, Math.ceil(outputQty / economics.perEmployee));
  const monthlyWage = round2(jobs * config.labor.privateWageRate);
  const firstBatchInputCost = round2(economics.inputCostPerUnit * outputQty);
  const materialSafetyMonths = Math.max(0, config.production.plan?.targetInventoryMonths ?? 0.5);
  const workingCapital = round2(
    monthlyWage * config.company.wageReserveMonths + firstBatchInputCost * materialSafetyMonths,
  );
  const upfront = round2(equipCost + firstBatchInputCost + workingCapital);
  let founderEquity: number;
  const blockers: FoundingObstacle[] = [];
  if (founderCapacity + 1e-6 < requiredCapital) {
    blockers.push({
      kind: 'capital',
      detail: `创办人最多可出资 ${founderCapacity.toFixed(0)}，低于本城最低创办资本 ${requiredCapital.toFixed(0)}`,
    });
    founderEquity = Math.max(0, founderCapacity);
  } else {
    founderEquity = round2(Math.min(founderCapacity, Math.max(requiredCapital, upfront)));
  }
  const loanNeeded = Math.max(0, round2(upfront - founderEquity));
  const loanAvailable = loanCapacityFor(founderEquity, config);
  const loanPrincipal = round2(Math.min(loanNeeded, loanAvailable));
  if (loanNeeded - loanPrincipal > 0.01) {
    blockers.push({
      kind: 'credit',
      detail: `设备与启动周转需 ${upfront.toFixed(0)}，创办人可出资 ${founderEquity.toFixed(0)}，尚有 ${(
        loanNeeded - loanPrincipal
      ).toFixed(0)} 缺口超出银行授信 ${loanAvailable.toFixed(0)}`,
    });
  }
  const product = config.banking.products.workingCapital;
  const interestCost = round2(loanPrincipal * product.rateMonthly * product.termMonths);
  const totalCapital = round2(upfront + interestCost);
  if (purchasable < units) {
    blockers.push({
      kind: 'equipment',
      detail: `本地设备企业库存 + 政府库存合计 ${purchasable} 台，不足本档需要的 ${units} 台`,
    });
  }
  if (jobs > city.population.laborForce) {
    blockers.push({
      kind: 'labor',
      detail: `本档需要 ${jobs} 名员工，超过本城劳动力 ${city.population.laborForce}`,
    });
  }
  const outputCapacity = capacity * config.company.initialUtilization;
  const sales = Math.min(candidate.reachableSales, outputCapacity);
  if (sales <= 0) {
    blockers.push({
      kind: 'demand',
      detail: '当前没有可触达的订单（缺货需求与实际销量均为 0）',
    });
  }
  const monthlyInterest = loanPrincipal * product.rateMonthly;
  const expectedMonthlyProfit = round2(economics.unitMargin * sales - monthlyInterest);
  if (sales > 0 && expectedMonthlyProfit <= 0) {
    blockers.push({
      kind: 'profit',
      detail: `按当前售价/原料/工资，单位毛利 ${economics.unitMargin.toFixed(2)}，本档月利润 ${expectedMonthlyProfit.toFixed(
        0,
      )} 为负`,
    });
  }
  return {
    units,
    jobs,
    equipmentCost: equipCost,
    firstBatchInputCost,
    workingCapital,
    loanPrincipal,
    interestCost,
    totalCapital,
    founderEquity,
    expectedMonthlyProfit,
    feasible: blockers.length === 0,
    blockers,
  };
}

/**
 * 用指定出资能力重算一个档位的可出资/可贷与可行性。
 * `assessFounding` 的 feasibleTier 用全城最强出资能力评估；显式指定创办人时用它重算。
 */
export function retuneTierForCapacity(
  tier: FoundingScaleTier,
  founderCapacity: number,
  requiredCapital: number,
  config: DemoConfig,
  purchasable: number,
  laborForce: number,
  reachableSales: number,
  unitMargin: number,
  unitCapacity: number,
): FoundingScaleTier {
  const blockers = tier.blockers.filter(
    (blocker) =>
      !['capital', 'credit', 'equipment', 'labor', 'demand', 'profit'].includes(blocker.kind),
  );
  const equipCost = tier.equipmentCost;
  const upfront = round2(equipCost + tier.firstBatchInputCost + tier.workingCapital);
  let founderEquity: number;
  if (founderCapacity + 1e-6 < requiredCapital) {
    blockers.push({
      kind: 'capital',
      detail: `创办人最多可出资 ${founderCapacity.toFixed(0)}，低于本城最低创办资本 ${requiredCapital.toFixed(0)}`,
    });
    founderEquity = Math.max(0, founderCapacity);
  } else {
    founderEquity = round2(Math.min(founderCapacity, Math.max(requiredCapital, upfront)));
  }
  const loanNeeded = Math.max(0, round2(upfront - founderEquity));
  const loanAvailable = loanCapacityFor(founderEquity, config);
  const loanPrincipal = round2(Math.min(loanNeeded, loanAvailable));
  if (loanNeeded - loanPrincipal > 0.01) {
    blockers.push({
      kind: 'credit',
      detail: `启动资金缺口 ${(loanNeeded - loanPrincipal).toFixed(0)}，超出银行可授信额度 ${loanAvailable.toFixed(0)}`,
    });
  }
  if (purchasable < tier.units) {
    blockers.push({
      kind: 'equipment',
      detail: `可购买设备 ${purchasable} 台，不足本档 ${tier.units} 台`,
    });
  }
  if (tier.jobs > laborForce) {
    blockers.push({ kind: 'labor', detail: `本档需要 ${tier.jobs} 名员工，超过本城劳动力 ${laborForce}` });
  }
  const outputQty = tier.units * unitCapacity * config.company.initialUtilization;
  const sales = Math.min(reachableSales, outputQty);
  if (sales <= 0) {
    blockers.push({ kind: 'demand', detail: '当前没有可触达的订单' });
  }
  const product = config.banking.products.workingCapital;
  const monthlyInterest = loanPrincipal * product.rateMonthly;
  const expectedMonthlyProfit = round2(unitMargin * sales - monthlyInterest);
  if (sales > 0 && expectedMonthlyProfit <= 0) {
    blockers.push({ kind: 'profit', detail: `本档月利润 ${expectedMonthlyProfit.toFixed(0)} 为负` });
  }
  const interestCost = round2(loanPrincipal * product.rateMonthly * product.termMonths);
  return {
    ...tier,
    loanPrincipal,
    interestCost,
    totalCapital: round2(upfront + interestCost),
    founderEquity,
    expectedMonthlyProfit,
    feasible: blockers.length === 0,
    blockers,
  };
}

/** 用给定出资能力选择第一个可行档（按 1/2/4 台顺序）。 */
export function selectFoundingTier(
  assessment: FoundingAssessment,
  founderCapacity: number,
  config: DemoConfig,
): FoundingScaleTier | null {
  const purchasable = purchasableUnitsForAssessment(assessment);
  const laborForce = laborForceOf(assessment);
  const reachableSales = assessmentMetricsSales(assessment);
  const unitMargin = unitMarginOfAssessment(assessment);
  const unitCapacity = unitCapacityOfAssessment(assessment);
  for (const tier of assessment.scaleTiers) {
    const retuned = retuneTierForCapacity(
      tier,
      founderCapacity,
      assessment.requiredCapital,
      config,
      purchasable,
      laborForce,
      reachableSales,
      unitMargin,
      unitCapacity,
    );
    if (retuned.feasible) return retuned;
  }
  return null;
}

/** 用给定出资能力重算指定档位；allowLoan=false 时不使用银行贷款。 */
export function retuneTierForAssessment(
  assessment: FoundingAssessment,
  tier: FoundingScaleTier,
  founderCapacity: number,
  config: DemoConfig,
  allowLoan = true,
): FoundingScaleTier {
  const retuned = retuneTierForCapacity(
    tier,
    founderCapacity,
    assessment.requiredCapital,
    config,
    purchasableUnitsForAssessment(assessment),
    laborForceOf(assessment),
    assessmentMetricsSales(assessment),
    unitMarginOfAssessment(assessment),
    unitCapacityOfAssessment(assessment),
  );
  if (allowLoan) return retuned;
  const product = config.banking.products.workingCapital;
  const upfront = round2(retuned.equipmentCost + retuned.firstBatchInputCost + retuned.workingCapital);
  const blockers = retuned.blockers.filter((blocker) => blocker.kind !== 'credit');
  if (founderCapacity + 1e-6 < upfront) {
    blockers.push({
      kind: 'credit',
      detail: `不接受贷款时启动资金缺口 ${(upfront - founderCapacity).toFixed(0)}`,
    });
  }
  const expectedMonthlyProfit = round2(
    retuned.expectedMonthlyProfit + retuned.loanPrincipal * product.rateMonthly,
  );
  return {
    ...retuned,
    loanPrincipal: 0,
    interestCost: 0,
    totalCapital: upfront,
    expectedMonthlyProfit,
    feasible: blockers.length === 0,
    blockers,
  };
}

// 评估对象需要携带少量重算字段（不改变 FoundingAssessment 的对外形状，内部以可选字段挂载）。
interface FoundingAssessmentInternals {
  unitMarginForTier: number;
  unitCapacityForTier: number;
  purchasableUnits: number;
  laborForce: number;
  reachableSales: number;
}

type FoundingAssessmentWithInternals = FoundingAssessment & Partial<FoundingAssessmentInternals>;

function purchasableUnitsForAssessment(assessment: FoundingAssessment): number {
  return (assessment as FoundingAssessmentWithInternals).purchasableUnits ?? 0;
}

function laborForceOf(assessment: FoundingAssessment): number {
  return (assessment as FoundingAssessmentWithInternals).laborForce ?? 0;
}

function assessmentMetricsSales(assessment: FoundingAssessment): number {
  return (assessment as FoundingAssessmentWithInternals).reachableSales ?? 0;
}

function unitMarginOfAssessment(assessment: FoundingAssessment): number {
  return (assessment as FoundingAssessmentWithInternals).unitMarginForTier ?? 0;
}

function unitCapacityOfAssessment(assessment: FoundingAssessment): number {
  return (assessment as FoundingAssessmentWithInternals).unitCapacityForTier ?? 1;
}

// ---------------------------------------------------------------- v0.9 兼容的七维评分（供既有 API 使用）

function evaluateOutput(
  world: WorldState,
  config: DemoConfig,
  city: City,
  output: GoodId,
): FoundingCandidate {
  const basePrice = basePriceOf(output);
  const market = city.market[output];
  const price = Math.max(0.01, market?.price ?? basePrice);
  const trend = market?.lastPriceChangePct ?? 0;
  const demand = Math.max(0, market?.demand ?? 0);
  const sold = Math.max(0, market?.sold ?? 0);
  const unmet = Math.max(0, market?.unmetDemand ?? 0);

  const sector = sectorForOutput(output);
  const equipmentKind = equipmentKindForSector(sector, config);
  const catalog = config.equipment.catalog[equipmentKind];
  // 统一单位（task-23）：普通商品每台设备贡献 catalog.capacityPerUnit 个产出单位/月；
  // 资本品（设备商品）每台设备贡献 outputCapacityPerUnit[output] 台/月。
  // 若资本品仍用 300,000，设备厂会被估算成“月产数十万台”，创业资本变成数百亿。
  const unitCapacity = Math.max(
    1,
    equipmentCapacityPerUnit(config, equipmentKind, output) *
      (city.technology.productivityMultiplier || 1),
  );
  const unitPrice = equipmentUnitPrice(world, city.id, equipmentKind, config);
  const equipment = availableEquipment(world, config, city.id, equipmentKind);

  const competitors = world.companies.filter(
    (company) => company.cityId === city.id && company.recipeOutput === output,
  );
  const competitorCapacity = competitors.reduce((sum, company) => sum + Math.max(0, company.capacity), 0);

  // 1) 售价：相对基准的偏离 + 近期趋势（都是归一化百分点，不直接与需求数量比）。
  const priceScore =
    clamp(((price / basePrice - 1) * 100) * 1.5, -15, 15) + clamp(trend * 1.5, -10, 10);

  // 2) 需求：未满足需求占比 + 实际销量是否有成交。
  const unmetShare = productionShare(output, city);
  const demandScore = clamp(unmetShare * 25, 0, 20) + (sold > 0 ? 3 : 0);

  // 3) 竞争：同城竞争者数量与产能份额；没有竞争者时给进入奖励。
  const capacityShare = unitCapacity / Math.max(1e-9, competitorCapacity + unitCapacity);
  const competitionScore = clamp(
    15 * (1 - capacityShare) - competitors.length * 2 + (competitors.length === 0 ? 10 : 0),
    -10,
    15,
  );

  // 4) 设备可获得性：同城设备企业库存 + 政府开局库存 + 其他城市设备企业可售量。
  const equipmentScore =
    equipment.total <= 0 ? -100 : clamp(Math.min(10, equipment.total), 0, 10);

  // 5) 原料：本地库存与供给能覆盖多少；缺口意味着跨城补货与运输成本。
  const recipe = RECIPES[output];
  const inputs = recipe?.inputs ?? [];
  let inputCostPerUnit = 0;
  let coverageSum = 0;
  for (const input of inputs) {
    const inputMarket = city.market[input.good];
    const inputPrice = Math.max(0.01, inputMarket?.price ?? basePriceOf(input.good));
    inputCostPerUnit += input.qty * inputPrice;
    const monthlyNeed = Math.max(1e-9, unitCapacity * input.qty);
    const localSupply = Math.max(0, (inputMarket?.closingStock ?? 0) + (inputMarket?.supply ?? 0));
    coverageSum += clamp(localSupply / monthlyNeed, 0, 1);
  }
  const localCoverage = inputs.length > 0 ? coverageSum / inputs.length : 1;
  const supplyChainScore = clamp(localCoverage * 10 - 5, -10, 10);

  // 6) 成本：单位原料 + 工资 + 跨城运输加成，折算成毛利率。
  const perEmployee = perEmployeeFor(city, output, config);
  const wagePerUnit = config.labor.privateWageRate / perEmployee;
  const importMarkup = clamp(
    config.intercity.maxMarkup * (1 - localCoverage),
    0,
    config.intercity.maxMarkup,
  );
  const transportCostPerUnit = inputCostPerUnit * importMarkup;
  const unitMargin = price - inputCostPerUnit - wagePerUnit - transportCostPerUnit;
  const marginRatio = unitMargin / price;
  const costScore = clamp(marginRatio * 50, -25, 20);

  // 7) 利润：按“同城竞争者份额”估算可触达销量，再看单位毛利与启动资本的回报。
  const targetShare = 1 / (competitors.length + 1);
  // 可触达销量是“新企业按份额能卖出的量”，可超过单台设备产能（由此决定买几台），
  // 但受每月最多可购设备数约束，避免在极端未满足需求下估算出无限规模。
  const estimatedDemand = Math.max(unmet, (demand + sold) * targetShare);
  const reachableSales = Math.max(
    0,
    Math.min(estimatedDemand, unitCapacity * config.equipment.maxBuyUnitsPerMonth),
  );
  const expectedMonthlyProfit = unitMargin * reachableSales;
  const firstBatchOutput = unitCapacity * config.company.initialUtilization;
  const jobDemand = Math.ceil(unitCapacity / perEmployee);
  const demandUnits = Math.max(
    1,
    Math.min(config.equipment.maxBuyUnitsPerMonth, Math.ceil(reachableSales / unitCapacity)),
  );
  const baseCapitalNeed =
    demandUnits * unitPrice +
    inputCostPerUnit * firstBatchOutput * demandUnits +
    jobDemand * config.labor.privateWageRate * demandUnits;
  const roi = expectedMonthlyProfit / Math.max(1, baseCapitalNeed);
  const profitScore = clamp(roi * 60, -20, 25);

  const total = round2(
    priceScore + demandScore + competitionScore + equipmentScore + supplyChainScore + costScore + profitScore,
  );

  const suggestedCapital = round2(
    demandUnits * unitPrice +
      inputCostPerUnit * firstBatchOutput * demandUnits +
      jobDemand * config.labor.privateWageRate * demandUnits,
  );

  const reasons: string[] = [];
  if (equipment.total <= 0) {
    reasons.push(`当前没有可购买的${catalog.name}（本地设备企业、政府库存与其他城市均无货）`);
  }
  reasons.push(
    `售价 ${round2(price)}（基准 ${basePrice}，趋势 ${trend > 0 ? '+' : ''}${round2(trend)}%），${price >= basePrice ? '高于' : '低于'}基准`,
  );
  reasons.push(
    `未满足需求占比 ${round2(unmetShare * 100)}%，当月成交 ${round2(sold)} / 需求 ${round2(demand)}`,
  );
  reasons.push(
    `同城竞争者 ${competitors.length} 家、合计产能 ${round2(competitorCapacity)}，预计可获得 ${round2(targetShare * 100)}% 份额、月销量 ${round2(reachableSales)}`,
  );
  reasons.push(
    `可用${catalog.name} ${equipment.total} 台（本地 ${equipment.local} + 政府 ${equipment.government} + 其他城市 ${equipment.intercity}），本地单价 ${round2(unitPrice)}`,
  );
  reasons.push(
    inputs.length === 0
      ? '该行业无原料投入'
      : `原料本地覆盖 ${round2(localCoverage * 100)}%，单位原料成本 ${round2(inputCostPerUnit)}，跨城运输加成 ${round2(importMarkup * 100)}%`,
  );
  reasons.push(
    `单位毛利 ${round2(unitMargin)}（工资 ${round2(wagePerUnit)}/单位），预计月利润 ${round2(expectedMonthlyProfit)}，启动资本约 ${suggestedCapital.toFixed(0)}`,
  );

  return {
    output,
    sector,
    equipmentKind,
    score: total,
    breakdown: {
      price: round2(priceScore),
      demand: round2(demandScore),
      competition: round2(competitionScore),
      equipment: round2(equipmentScore),
      supplyChain: round2(supplyChainScore),
      cost: round2(costScore),
      profit: round2(profitScore),
      total,
    },
    reasons,
    reachableSales: round2(reachableSales),
    expectedMonthlyProfit: round2(expectedMonthlyProfit),
    suggestedCapital,
    availableEquipmentUnits: equipment.total,
    unitPrice,
    unitCapacity: round2(unitCapacity),
    demandUnits,
  };
}

/** 对全部商品（含设备商品）给出评分，按得分降序、id 升序（确定性）。 */
export function scoreFoundingCandidates(
  world: WorldState,
  config: DemoConfig,
  cityId: string,
): FoundingCandidate[] {
  const city = cityOf(world, cityId);
  if (!city) return [];
  return GOODS.map((good) => evaluateOutput(world, config, city, good.id)).sort(
    (a, b) => b.score - a.score || a.output.localeCompare(b.output),
  );
}

/** 指定行业也走同一套评分，供显式选择行业与测试使用。 */
export function foundingCandidateForOutput(
  world: WorldState,
  config: DemoConfig,
  cityId: string,
  output: GoodId,
): FoundingCandidate {
  const city = cityOf(world, cityId);
  if (!city) throw new Error(`城市不存在：${cityId}`);
  return evaluateOutput(world, config, city, output);
}

/**
 * AI 创业候选：必须同时满足“评分达标、有可触达订单、预期毛利为正、设备可买”，
 * 避免在没有订单或没有设备时凭空制造企业。
 */
export function pickFoundingCandidate(
  world: WorldState,
  config: DemoConfig,
  cityId: string,
): FoundingCandidate | null {
  for (const candidate of scoreFoundingCandidates(world, config, cityId)) {
    if (candidate.breakdown.total < FOUNDING_MIN_SCORE) continue;
    if (candidate.expectedMonthlyProfit <= 0) continue;
    if (candidate.reachableSales <= 0) continue;
    if (candidate.availableEquipmentUnits <= 0) continue;
    return candidate;
  }
  return null;
}

/** 按“需求台数、可负担资金、可购设备、每月上限”裁剪后的启动设备数量（v0.9 兼容 API）。 */
export function plannedEquipmentUnits(
  candidate: FoundingCandidate,
  capital: number,
  config: DemoConfig,
): number {
  if (candidate.unitPrice <= 0) return 0;
  const affordable = Math.floor((capital + 1e-6) / candidate.unitPrice);
  const limitedByMonth = Math.floor(config.equipment.maxBuyUnitsPerMonth);
  let units = Math.max(
    0,
    Math.min(candidate.demandUnits, affordable, candidate.availableEquipmentUnits, limitedByMonth),
  );
  // 买完设备后必须至少留下一点启动现金（首批原料 / 首月工资），否则缩一档；缩不了就失败。
  while (units > 0 && capital - units * candidate.unitPrice <= 0.01) units -= 1;
  return units;
}

// ---------------------------------------------------------------- v1.0 评估

/** 同城同行业企业最近 3 个月销量合计（salesHistory 由 production-plan 维护）。 */
function recentSales3m(world: WorldState, cityId: string, output: GoodId): number {
  return round2(
    world.companies
      .filter((company) => company.cityId === cityId && company.recipeOutput === output)
      .reduce((sum, company) => {
        const history = company.salesHistory ?? [];
        return sum + history.slice(-3).reduce((entrySum, value) => entrySum + Math.max(0, value), 0);
      }, 0),
  );
}

function obstaclesOfTiers(tiers: FoundingScaleTier[]): FoundingObstacle[] {
  const first = tiers[0];
  if (!first) return [{ kind: 'demand', detail: '没有可用的创业评估档位' }];
  const map = new Map<string, FoundingObstacle>();
  for (const blocker of first.blockers) map.set(`${blocker.kind}:${blocker.detail}`, blocker);
  return [...map.values()];
}

/** 对一个行业做 v1.0 评估：11 维评分 + 1/2/4 台规模档位 + 结构化障碍。 */
export function assessFounding(
  world: WorldState,
  config: DemoConfig,
  cityId: string,
  output: GoodId,
): FoundingAssessment {
  const city = cityOf(world, cityId);
  if (!city) throw new Error(`城市不存在：${cityId}`);
  const candidate = evaluateOutput(world, config, city, output);
  const sector = candidate.sector;
  const equipmentKind = candidate.equipmentKind;
  const economics = unitEconomics(world, config, city, output);
  const market = city.market[output];
  const price = economics.price;
  const trend = market?.lastPriceChangePct ?? 0;
  const payableUnmetDemand = Math.max(0, market?.unmetDemand ?? 0);
  const unmetFunding = Math.max(0, market?.unmetFunding ?? 0);
  const supply = availableEquipment(world, config, city.id, equipmentKind);
  // 实际可购买：同城设备企业库存 + 政府库存；其他城市库存不能直接用于本城创办。
  const purchasable = Math.max(0, supply.local + supply.government);
  const recentSales = recentSales3m(world, city.id, output);
  const productInventory = Math.max(0, market?.closingStock ?? 0);
  const requiredCapital = requiredStartingCapital(world, config, city.id);
  const founders = foundingFounderCapacity(world, config, city.id);

  const tiers = FOUNDING_SCALE_UNITS.map((units) =>
    buildTier(
      world,
      config,
      city,
      output,
      candidate,
      units,
      purchasable,
      requiredCapital,
      founders.best,
      economics,
    ),
  );
  const feasibleTier = tiers.find((tier) => tier.feasible) ?? null;

  const competitors = world.companies.filter(
    (company) => company.cityId === city.id && company.recipeOutput === output,
  );
  const competitorCapacity = competitors.reduce((sum, company) => sum + Math.max(0, company.capacity), 0);
  const unmetShare = productionShare(output, city);
  const inventoryRatio = productInventory / Math.max(1e-9, candidate.unitCapacity);
  const unemployedRatio = city.population.laborForce > 0
    ? city.population.unemployed / city.population.laborForce
    : 0;
  const firstTier = tiers[0]!;
  const financingNeed = firstTier.totalCapital;
  const financingCoverage =
    financingNeed > 0
      ? (firstTier.founderEquity + firstTier.loanPrincipal) / financingNeed
      : 1;
  const maxMarkup = Math.max(1e-9, config.intercity.maxMarkup);

  const dimensions = {
    price: round2(clamp(((price / basePriceOf(output) - 1) * 100 + trend) * 0.5, -10, 10)),
    payableDemand: round2(clamp(unmetShare * 10 + ((market?.sold ?? 0) > 0 ? 1 : 0), 0, 10)),
    recentSales: round2(clamp((recentSales / 3 / Math.max(1, candidate.unitCapacity)) * 10 - 5, -10, 10)),
    inventory: round2(clamp(5 - inventoryRatio * 5, -10, 10)),
    competition: round2(candidate.breakdown.competition),
    inputs: round2(candidate.breakdown.supplyChain),
    equipment: round2(clamp(candidate.breakdown.equipment, -10, 10)),
    labor: round2(clamp(unemployedRatio * 20 - 5, -10, 10)),
    transport: round2(clamp(5 - (economics.importMarkup / maxMarkup) * 10, -10, 10)),
    financing: round2(clamp((financingCoverage - 1) * 10, -10, 10)),
    profit: round2(candidate.breakdown.profit),
  };

  const reasons = [...candidate.reasons];
  if (feasibleTier) {
    reasons.push(
      `最小可行档 ${feasibleTier.units} 台设备：员工 ${feasibleTier.jobs}、设备 ${feasibleTier.equipmentCost.toFixed(
        0,
      )}、首批原料 ${feasibleTier.firstBatchInputCost.toFixed(0)}、周转金 ${feasibleTier.workingCapital.toFixed(
        0,
      )}、启动总资本 ${feasibleTier.totalCapital.toFixed(0)}（创办人出资 ${feasibleTier.founderEquity.toFixed(
        0,
      )} + 贷款 ${feasibleTier.loanPrincipal.toFixed(0)}，利息 ${feasibleTier.interestCost.toFixed(0)}），预计月利润 ${feasibleTier.expectedMonthlyProfit.toFixed(0)}`,
    );
  } else {
    const obstacles = obstaclesOfTiers(tiers);
    reasons.push(
      `暂不具备可行档位：${obstacles.map((obstacle) => obstacle.detail).join('；') || '资本、设备或利润条件不满足'}`,
    );
  }

  const assessment: FoundingAssessmentWithInternals = {
    output,
    sector,
    equipmentKind,
    score: candidate.score,
    dimensions,
    metrics: {
      expectedPrice: round2(price),
      priceTrend3m: round2(trend),
      payableUnmetDemand: round2(payableUnmetDemand),
      unmetFunding: round2(unmetFunding),
      recentSales3m: recentSales,
      inventory: round2(productInventory),
      competitors: competitors.length,
      competitorCapacity: round2(competitorCapacity),
      expectedInputCost: round2(economics.inputCostPerUnit),
      expectedWageCost: round2(economics.wagePerUnit),
      expectedTransportCost: round2(economics.transportCostPerUnit),
      expectedInterest: round2(firstTier.interestCost),
      startupCost: round2(financingNeed),
      expectedMonthlyProfit: firstTier.expectedMonthlyProfit,
      founderEquity: firstTier.founderEquity,
      loanAvailable: loanCapacityFor(firstTier.founderEquity, config),
      financingGap: round2(Math.max(0, firstTier.totalCapital - firstTier.founderEquity - firstTier.loanPrincipal)),
    },
    scaleTiers: tiers,
    feasibleTier,
    obstacles: feasibleTier ? [] : obstaclesOfTiers(tiers),
    reasons,
    requiredCapital,
    unitMarginForTier: economics.unitMargin,
    unitCapacityForTier: candidate.unitCapacity,
    purchasableUnits: purchasable,
    laborForce: city.population.laborForce,
    reachableSales: candidate.reachableSales,
  };
  return assessment;
}

/** 全行业评估，按分数降序（确定性）。 */
export function assessFoundingOpportunities(
  world: WorldState,
  config: DemoConfig,
  cityId: string,
): FoundingAssessment[] {
  return GOODS.map((good) => assessFounding(world, config, cityId, good.id)).sort(
    (a, b) => b.score - a.score || a.output.localeCompare(b.output),
  );
}

/** AI 创业候选：评分达标、有可触达订单、有可行规模档位。 */
export function pickFoundingOpportunity(
  world: WorldState,
  config: DemoConfig,
  cityId: string,
): FoundingAssessment | null {
  for (const assessment of assessFoundingOpportunities(world, config, cityId)) {
    if (assessment.score < FOUNDING_MIN_SCORE) continue;
    if (assessment.metrics.payableUnmetDemand + assessment.metrics.recentSales3m <= 0) continue;
    if (!assessment.feasibleTier) continue;
    return assessment;
  }
  return null;
}

// ---------------------------------------------------------------- 创办尝试记录

export function foundingAttempts(world: WorldState): FoundingAttemptRecord[] {
  const lifecycle = world.lifecycle;
  if (!lifecycle.foundingAttempts) lifecycle.foundingAttempts = [];
  return lifecycle.foundingAttempts;
}

export function recordFoundingAttempt(
  world: WorldState,
  attempt: Omit<FoundingAttemptRecord, 'id'>,
  maxRecords = 80,
): FoundingAttemptRecord {
  const attempts = foundingAttempts(world);
  const record: FoundingAttemptRecord = {
    ...attempt,
    id: `attempt-${attempt.tick}-${attempts.length + 1}`,
  };
  attempts.push(record);
  if (attempts.length > maxRecords) attempts.splice(0, attempts.length - maxRecords);
  return record;
}
