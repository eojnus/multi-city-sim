import type {
  City,
  Company,
  EquipmentKind,
  GoodId,
  SectorId,
  WorldState,
} from '../contracts/types';
import type { DemoConfig } from '../../data/config';
import { GOODS, PRODUCTIVITY, RECIPES } from '../../data/demo-data';
import { clamp, round2 } from '../core/math';
import {
  equipmentKindForSector,
  equipmentUnitPrice,
  newEquipmentSupply,
} from '../equipment/equipment';
import { workforceSkillMultiplier } from '../labor/workforce';

/**
 * v0.9 T3：AI 创业行业评分。
 *
 * 评分不是拿“未满足需求数量”直接和“利润”比较，而是把候选行业放到同一套归一化口径里：
 * 售价相对基准与趋势、实际销量与未满足需求占比、同城竞争者数量与产能份额、设备可获得性、
 * 原料本地覆盖与跨城运输成本、工资成本、单位毛利与“按份额可触达销量”下的预期利润。
 *
 * 每个分项各自 clamp 后求和；output 的理由会写入创办日志与成立记录，供日志 / UI 展示。
 * 这里只做“是否值得办、办多大”的估算，不修改世界状态；真正的出资与设备采购在 lifecycle。
 */
export const FOUNDING_MIN_SCORE = 20;

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

/** 一个候选行业的评分、理由与创业规模估算。 */
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
  const unitCapacity = Math.max(
    1,
    catalog.capacityPerUnit * (city.technology.productivityMultiplier || 1),
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
  const perEmployee = Math.max(
    1e-6,
    (PRODUCTIVITY[output] ?? 1) *
      (city.technology.productivityMultiplier || 1) *
      workforceSkillMultiplier(city) *
      config.production.laborCapacityFactor,
  );
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

/** 按“需求台数、可负担资金、可购设备、每月上限”裁剪后的启动设备数量。 */
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
