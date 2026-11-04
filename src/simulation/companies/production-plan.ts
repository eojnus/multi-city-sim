import type {
  Company,
  CompanyProductionPlan,
  GoodId,
  MarketState,
  WorldState,
} from '../contracts/types';
import type { DemoConfig } from '../../data/config';
import { GOODS, PRODUCTIVITY, RECIPES } from '../../data/demo-data';
import { clamp, round2 } from '../core/math';
import { monthlyWageBill } from './company';
import { laborCapacity, companyProductivityMultiplier } from '../production/production';
import { equipmentCapacityFor } from '../equipment/equipment';
import { workforceSkillMultiplier } from '../labor/workforce';
import { retentionSubsidyPerEmployee } from '../policies/query';

/**
 * v0.9 T2 / v1.0：企业月度生产计划。
 *
 * 把四种“产能/产量”分开，避免再拿 decay 后的 utilization 直接当产量：
 * 1. 设备产能 equipmentLimit：Σ(设备台数 × 每台产能 × 城市技术系数)；
 * 2. 劳动产能 laborLimit：现有员工按生产模块口径（员工 × 人均生产率 × 技术 × 技能 ×
 *    政策 × laborCapacityFactor）能支撑的产量；
 * 3. 计划产量 plannedOutput：以“近 3 月实际销量 + 目标库存”为基础，v1.0 再加入
 *    “有支付能力但缺货”的未满足需求（按企业可触达份额 × unmetDemandAbsorption 每月吸收），
 *    然后按月 ±20% 平滑；库存积压/现金不足/原料资金不足时可紧急下调
 *    （下限见 config.production.plan.emergencyDownAdjust）；
 *    再取 min(计划, 设备产能, 原料可支持产量, 劳动产能)。
 *    v1.1 修正缺货口径：有效需求用 consumerDemand / producerDemand，扣除本地成交与
 *    跨城进口后与 unmetDemand 取较大值；producerRequired / unmetFunding（资金不足）
 *    不再被当成缺货。过去零销量但存在真实有效缺货时，计划按缺货信号恢复，不被历史
 *    零销量锁死（见 recomputeProductionPlan 的 recoveringFromZeroSales）。
 * 4. 实际产量：仍由 production.ts 在生产时按 min(计划, 设备, 劳动, 原料) 校验，不得超计划。
 *
 * 平滑口径：以上一期计划产量为基准做 ±20% 限幅；没有上期计划（新企业/旧档）时优先用
 * 上一完整月的实际产量（更贴近“按月平滑”的本意），再退回“产能 × 利用率”；基准为 0 时
 * 直接采用本期目标（仍受资源上限约束）。
 * 销量历史 salesHistory 由本模块在每月第一次制定计划时维护（上一完整月的 sold + exported，
 * 最多保留 salesLookbackMonths 月），与存档校验（≤3）一致。
 *
 * v1.0 扩产判定（assessExpansion）：连续 2 个月设备利用率 ≥80%、成品库存 ≤1 个月销量、
 * 保留 2 个月工资 + 近期偿债后仍有资金，才允许把扩产投资交给 planning/lifecycle 执行；
 * 设备够而缺员工时优先招聘、员工够而缺原料时优先采购，不把一切问题都当成买设备。
 */
export function equipmentLimitFor(
  world: WorldState,
  company: Company,
  config: DemoConfig,
): number {
  if (!company.equipment) {
    // 极端情况下（手工构造的企业对象/未迁移存档）退回缓存产能，保证计划仍可计算。
    return Math.max(0, round2(company.equipmentCapacity ?? company.capacity ?? 0));
  }
  return Math.max(0, round2(equipmentCapacityFor(world, company, config)));
}

/** 每名员工按生产模块口径可支撑的产量（与 laborCapacity 同源）。 */
export function outputPerEmployee(
  world: WorldState,
  company: Company,
  config: DemoConfig,
): number {
  const city = world.cities.find((entry) => entry.id === company.cityId);
  if (!city) return Math.max(1e-6, PRODUCTIVITY[company.recipeOutput] ?? 1);
  const productivity = Math.max(1e-9, PRODUCTIVITY[company.recipeOutput] ?? 0);
  const skill = workforceSkillMultiplier(city);
  const policy = companyProductivityMultiplier(world, city, company, config);
  return Math.max(
    1e-6,
    productivity *
      city.technology.productivityMultiplier *
      skill *
      policy *
      config.production.laborCapacityFactor,
  );
}

/**
 * 原料可支持的产量：(期初原料价值 + 现金中可用于采购的预算) / 每单位产出的原料成本。
 *
 * - 现金预算扣除工资预留（wageReserveMonths 个月工资），与采购模块同一口径；
 * - 无材料投入的行业（如能源）返回 Infinity，表示原料不构成额外限制；
 * - v1.0：按任务书“计划必须纳入现金/信贷约束”的要求，把调用方给出的
 *   `workingCapitalRoom`（该企业当月合法可自动动用的授信额度）并入采购资金；
 *   授信仍是真实贷款（放款、计息、偿债由采购模块执行），不是免费资金。
 *   玩家手动经营且未授权时调用方应传 0，计划与真实可动用资金一致。
 */
export function materialSupportedOutput(
  world: WorldState,
  company: Company,
  config: DemoConfig,
  workingCapitalRoom = 0,
): number {
  const recipe = RECIPES[company.recipeOutput];
  if (!recipe || recipe.inputs.length === 0) return Number.POSITIVE_INFINITY;
  const city = world.cities.find((entry) => entry.id === company.cityId);
  let unitCost = 0;
  let inventoryValue = 0;
  for (const input of recipe.inputs) {
    const price = Math.max(0.01, city?.market[input.good]?.price ?? 0.01);
    unitCost += input.qty * price;
    inventoryValue += Math.max(0, company.inventory[input.good] ?? 0) * price;
  }
  if (unitCost <= 0) return Number.POSITIVE_INFINITY;
  const wage = monthlyWageBill(company, config);
  const ownBudget = Math.max(0, round2(company.cash - wage * config.company.wageReserveMonths));
  const budget = round2(ownBudget + Math.max(0, workingCapitalRoom));
  return Math.max(0, (inventoryValue + budget) / unitCost);
}

/** 最近 N 月销量参考量：salesHistory 均值；无历史时用有依据的初始预测（禁止凭空）。 */
export function salesReferenceFor(
  world: WorldState,
  company: Company,
  config: DemoConfig,
  equipmentLimit: number,
): number {
  const planCfg = config.production.plan;
  const history = (company.salesHistory ?? []).slice(-planCfg.salesLookbackMonths);
  if (history.length > 0) {
    return round2(history.reduce((total, entry) => total + entry, 0) / history.length);
  }
  // 上一完整月已有销售但历史尚未记录（例如测试直连/旧档首月）：先按单月销量估计。
  const lastSales = round2(
    (company.previousMonth?.sold ?? 0) + (company.previousMonth?.exported ?? 0),
  );
  if (lastSales > 0) return lastSales;
  // 新企业无销量历史：用设备产能 × 初始销售系数作为有依据的首月需求预测。
  if (equipmentLimit > 0) return round2(equipmentLimit * planCfg.initialSalesFactor);
  // 旧存档/手工构造对象没有设备资产时，退回“产能 × 利用率 × 初始系数”。
  return round2(company.capacity * company.utilization * planCfg.initialSalesFactor);
}

/** 企业近 N 月平均销量（含出口）；无历史时退回上一完整月，再退回 0。 */
function meanSalesFor(company: Company, lookbackMonths: number): number {
  const history = (company.salesHistory ?? []).slice(-Math.max(0, lookbackMonths));
  if (history.length > 0) {
    return round2(history.reduce((total, entry) => total + entry, 0) / history.length);
  }
  return round2((company.previousMonth?.sold ?? 0) + (company.previousMonth?.exported ?? 0));
}

/**
 * 市场账本口径的“有支付能力但缺货”缺口（v1.1 修正）。
 *
 * - 有效需求：消费品取 consumerDemand，中间品取 producerDemand。producerRequired 含
 *   因资金不足根本没形成的部分，不能当作缺货；unmetFunding 同样只是资金缺口，不参与计算。
 * - 已满足量 = 本地成交 sold + 跨城进口 intercityImported。跨城成交已计入买方城市的
 *   有效需求，不能重复计入缺口（旧口径 producerRequired − sold 会把它重复算一遍）。
 * - 缺口 = max(0, 有效需求 − 已满足量)，再与账本 unmetDemand 取较大值：后者是逐笔
 *   “有效需求 − 实际成交（含跨城）”的累计口径，正常情况下两者一致；取较大值兼容
 *   旧档/手工构造只填其一的场景，也不会把资金不足误判为缺货。
 */
export function payableShortageFromMarket(
  market: MarketState | undefined,
  goodId: GoodId,
): number {
  if (!market) return 0;
  const good = GOODS.find((entry) => entry.id === goodId);
  const payableDemand =
    good?.category === 'consumer' ? market.consumerDemand : market.producerDemand;
  const filled = (market.sold ?? 0) + (market.intercityImported ?? 0);
  const unfilled = Math.max(0, (payableDemand ?? 0) - filled);
  const recorded = Math.max(0, market.unmetDemand ?? 0);
  return round2(Math.max(unfilled, recorded));
}

/**
 * 城市该商品“有支付能力但缺货”的未满足需求（上一完整月市场口径）。
 *
 * v1.1：改为有效需求口径（见 payableShortageFromMarket），不再用 producerRequired；
 * 该信号是“全城可触达缺口”，由 companyDemandShare 再按企业份额分摊，禁止每家重复计入。
 */
export function cityShortageFor(
  world: WorldState,
  city: WorldState['cities'][number],
  goodId: Company['recipeOutput'],
): number {
  void world;
  return payableShortageFromMarket(city.market[goodId], goodId);
}

export interface DemandShareSignal {
  /** 全城可触达缺货量（未按份额分摊）。 */
  cityShortage: number;
  /** 本企业合理份额（0–1，同城同产出企业之间不重复分配）。 */
  share: number;
  capacityShare: number;
  salesShare: number;
  /** 同城同产出企业数（含本企业）。 */
  peers: number;
  /** 分摊给本企业的额外需求 = 全城缺货 × 份额。 */
  extraDemand: number;
  /** 本月实际纳入计划的吸收量 = 额外需求 × unmetDemandAbsorption。 */
  absorbed: number;
}

/**
 * 把城市缺货信号按“同城同产出”企业的合理份额分摊给本企业。
 *
 * 份额首版 = 50% 设备产能份额 + 50% 近 N 月销量份额；没有销量数据时只用产能份额。
 * 由于 Σ产能份额 = 1、Σ销量份额 = 1（无销量企业销量份额记 0），Σ份额 ≤ 1，
 * 因此全城缺口不会被每家企业重复计入。销量份额用近 N 月实际销量（含出口）估计。
 */
export function companyDemandShare(
  world: WorldState,
  company: Company,
  config: DemoConfig,
): DemandShareSignal {
  const empty: DemandShareSignal = {
    cityShortage: 0,
    share: 0,
    capacityShare: 0,
    salesShare: 0,
    peers: 0,
    extraDemand: 0,
    absorbed: 0,
  };
  const city = world.cities.find((entry) => entry.id === company.cityId);
  if (!city) return empty;
  const planCfg = config.production.plan;
  const cityShortage = cityShortageFor(world, city, company.recipeOutput);
  const peers = world.companies.filter(
    (entry) => entry.cityId === city.id && entry.recipeOutput === company.recipeOutput,
  );
  if (peers.length === 0) return empty;

  const capacities = peers.map((entry) => Math.max(0, equipmentLimitFor(world, entry, config)));
  const totalCapacity = capacities.reduce((total, entry) => total + entry, 0);
  const companyCapacity = Math.max(0, equipmentLimitFor(world, company, config));
  const capacityShare =
    totalCapacity > 0.01 ? companyCapacity / totalCapacity : 1 / peers.length;

  const sales = peers.map((entry) => meanSalesFor(entry, planCfg.salesLookbackMonths));
  const totalSales = sales.reduce((total, entry) => total + entry, 0);
  const companySales = meanSalesFor(company, planCfg.salesLookbackMonths);
  const salesShare = totalSales > 0.01 ? companySales / totalSales : capacityShare;

  const share = clamp(
    totalSales > 0.01 ? 0.5 * capacityShare + 0.5 * salesShare : capacityShare,
    0,
    1,
  );
  const extraDemand = round2(cityShortage * share);
  return {
    cityShortage,
    share,
    capacityShare,
    salesShare,
    peers: peers.length,
    extraDemand,
    absorbed: round2(extraDemand * planCfg.unmetDemandAbsorption),
  };
}

export interface ExpansionInput {
  plannedOutput: number;
  equipmentLimit: number;
  salesReference: number;
  laborLimit?: number;
  /**
   * v1.1：全城“有支付能力但缺货”的有效需求。用于缺货驱动的扩产恢复：
   * 当月计划利用率已达阈值、库存与资金条件满足时，即使上月因停产/缺料导致利用率
   * 不足，也允许评估购买设备（仍然保留保留 2 月工资 + 近期偿债的资金约束）。
   */
  cityShortage?: number;
}

export interface ExpansionAssessment {
  eligible: boolean;
  /** 上一完整月设备利用率（上月实际产量 ÷ 设备产能）。 */
  lastUtilization: number;
  /** 本月计划设备利用率（计划产量 ÷ 设备产能）。 */
  plannedUtilization: number;
  /** 成品库存相当于几个月的预期销量。 */
  inventoryMonths: number;
  /** 保留 2 个月工资 + 近期偿债后可动用现金。 */
  cashAfterReserve: number;
  reasons: string[];
}

/**
 * v1.0 首版扩产判定：只有“连续 2 个月设备利用率 ≥80% + 库存 ≤1 个月销量 +
 * 保留 2 个月工资与近期偿债后仍有资金”才认为可以评估买设备/扩产。
 *
 * “连续 2 个月”首版取“上一完整月实际利用率”与“本月计划利用率”同时达标
 * （本模块每月重算计划，因此这两个月口径可比）；近期月偿债用剩余债务 / expansionDebtMonths
 * 加上月利息支出近似。设备够而缺员工/原料时明确优先招聘或采购，避免把问题都当成买设备。
 * v1.1 §6：真实有效缺货存在时放宽“上月利用率”这一条（见 ExpansionInput.cityShortage），
 * 否则停产恢复期的企业会因历史利用率不足而永远无法扩产；资金/库存/本月计划利用率约束保留。
 */
export function assessExpansion(
  world: WorldState,
  company: Company,
  config: DemoConfig,
  input: ExpansionInput,
): ExpansionAssessment {
  const planCfg = config.production.plan;
  const equipmentLimit = Math.max(0, input.equipmentLimit);
  const lastUtilization =
    equipmentLimit > 0.01
      ? Math.max(0, (company.previousMonth?.produced ?? 0) / equipmentLimit)
      : 0;
  const plannedUtilization =
    equipmentLimit > 0.01 ? Math.max(0, input.plannedOutput / equipmentLimit) : 0;
  const stock = Math.max(0, company.inventory[company.recipeOutput] ?? 0);
  // 销量参考为 0 时：无库存视为“0 个月”，有库存视为积压（Infinity）。
  const inventoryMonths =
    input.salesReference > 0.01
      ? stock / input.salesReference
      : stock > 0.01
        ? Number.POSITIVE_INFINITY
        : 0;

  const wageBill = monthlyWageBill(company, config);
  const debt = Math.max(0, company.debt ?? 0);
  const interest = Math.max(0, company.lastMonth?.interestPaid ?? 0);
  const debtService = round2(interest + debt / Math.max(1, planCfg.expansionDebtMonths));
  const reserve = round2(wageBill * planCfg.expansionReserveWageMonths + debtService);
  const cashAfterReserve = round2(company.cash - reserve);

  const utilizationOk =
    lastUtilization >= planCfg.expansionUtilizationThreshold &&
    plannedUtilization >= planCfg.expansionUtilizationThreshold;
  // v1.1 §6：真实有效缺货时允许“缺货驱动恢复”——本月计划利用率达标、库存与资金
  // 条件满足即可评估扩产；上月利用率不足可能只是停产/缺料造成的，不应锁死恢复。
  const shortage = Math.max(0, input.cityShortage ?? 0);
  const shortageDriven = shortage > 0.01;
  const shortageRecovery = shortageDriven && plannedUtilization >= planCfg.expansionUtilizationThreshold;
  const effectiveUtilizationOk = utilizationOk || shortageRecovery;
  const inventoryOk = inventoryMonths <= planCfg.expansionInventoryMonths;
  const cashOk = cashAfterReserve > 0;
  const eligible = equipmentLimit > 0.01 && effectiveUtilizationOk && inventoryOk && cashOk;

  const reasons: string[] = [];
  const thresholdPct = (planCfg.expansionUtilizationThreshold * 100).toFixed(0);
  if (equipmentLimit <= 0.01) {
    reasons.push('扩产判定：没有设备资产，优先购买设备/创办设备企业');
  } else if (!effectiveUtilizationOk) {
    reasons.push(
      `扩产条件未满足：上月设备利用率 ${(lastUtilization * 100).toFixed(1)}%、本月计划 ${(plannedUtilization * 100).toFixed(1)}%，未连续 ${planCfg.expansionUtilizationMonths} 个月达到 ${thresholdPct}%`,
    );
  } else if (!inventoryOk) {
    reasons.push(
      `扩产条件未满足：成品库存 ${Number.isFinite(inventoryMonths) ? inventoryMonths.toFixed(2) : '∞'} 个月销量，高于 ${planCfg.expansionInventoryMonths} 个月`,
    );
  } else if (!cashOk) {
    reasons.push(
      `扩产条件未满足：保留 ${planCfg.expansionReserveWageMonths} 个月工资与近期偿债（${debtService.toFixed(2)}）后资金为 ${cashAfterReserve.toFixed(2)}`,
    );
  } else if (shortageRecovery && !utilizationOk) {
    reasons.push(
      `缺货驱动扩产条件满足：上月设备利用率 ${(lastUtilization * 100).toFixed(1)}% 未达 ${thresholdPct}%（可能因停产/缺料），但本月计划利用率 ${(plannedUtilization * 100).toFixed(1)}% 已达标，且有 ${shortage.toFixed(2)} 的有效缺货，库存与资金条件满足，可评估购买设备`,
    );
  } else {
    reasons.push(
      `扩产条件满足：连续 ${planCfg.expansionUtilizationMonths} 个月设备利用率 ≥${thresholdPct}%，库存 ≤${planCfg.expansionInventoryMonths} 个月销量，保留 ${planCfg.expansionReserveWageMonths} 个月工资与近期偿债后仍有资金，可评估购买设备`,
    );
  }

  // 资源优先级：设备不是瓶颈时，先解决劳动/原料，而不是一律扩产。
  const laborLimit = input.laborLimit;
  if (laborLimit !== undefined && laborLimit + 0.01 < equipmentLimit) {
    reasons.push(
      `劳动产能 ${laborLimit.toFixed(2)} 低于设备产能 ${equipmentLimit.toFixed(2)}，优先招聘而非买设备`,
    );
  } else if (
    laborLimit !== undefined &&
    laborLimit + 0.01 < input.plannedOutput &&
    Number.isFinite(laborLimit)
  ) {
    reasons.push(`劳动产能仅 ${laborLimit.toFixed(2)}，计划需要 ${input.plannedOutput.toFixed(2)}，优先招聘`);
  }

  // 世界仅用于与 laborCapacity 同一数据源；这里保留参数以方便后续加入原料判定。
  void world;
  return {
    eligible,
    lastUtilization,
    plannedUtilization,
    inventoryMonths,
    cashAfterReserve,
    reasons,
  };
}

/**
 * 重算并写回企业生产计划。同一 tick 内重复调用是幂等的（直接返回已有计划），
 * 避免同一月内多次平滑叠加；跨月后第一次调用会维护销量历史。
 */
export function recomputeProductionPlan(
  world: WorldState,
  company: Company,
  config: DemoConfig,
  workingCapitalRoom = 0,
): CompanyProductionPlan {
  const tick = world.time.tick;
  const existing = company.productionPlan ?? null;
  if (existing && existing.tick === tick) return existing;

  const planCfg = config.production.plan;
  const city = world.cities.find((entry) => entry.id === company.cityId);

  // ---- 1) 维护销量历史：上一完整月的实际销量（含出口、跨城合同） ----
  if (!Array.isArray(company.salesHistory)) company.salesHistory = [];
  const prev = company.previousMonth;
  const lastMonthSales = round2((prev?.sold ?? 0) + (prev?.exported ?? 0));
  // 记录口径（v0.9 验收问题六）：公司第一次真正卖出货之前的月份不计入销量历史。
  // 开局时下游企业还有期初库存、区域贸易尚未启动，“有产量但还没有成交”的月份会
  // 被误读成“需求为零”，进而把销量参考量压到 0、再被 ±20% 平滑锁死（岚港食品厂 t4 起
  // 缺粮即是此链）。首次成交之后的零销量月份仍然照常记录，代表真实的需求消失。
  const startedSelling = (company.salesHistory ?? []).some((entry) => entry > 0.01);
  if (lastMonthSales > 0.01 || startedSelling) {
    company.salesHistory.push(lastMonthSales);
    while (company.salesHistory.length > planCfg.salesLookbackMonths) company.salesHistory.shift();
  }

  // ---- 2) 销售参考量、目标库存与目标产量 ----
  const equipmentLimit = equipmentLimitFor(world, company, config);
  const salesReference = Math.max(
    0,
    salesReferenceFor(world, company, config, equipmentLimit),
  );
  const outputId = company.recipeOutput;
  const stock = Math.max(0, company.inventory[outputId] ?? 0);
  // v1.0：有支付能力但缺货的未满足需求 → 按本企业可触达份额吸收 20% 进计划。
  // v1.1：改为有效需求口径（不使用 producerRequired / unmetFunding）。
  const demandSignal = city
    ? companyDemandShare(world, company, config)
    : { cityShortage: 0, share: 0, absorbed: 0, extraDemand: 0, capacityShare: 0, salesShare: 0, peers: 0 };
  // v1.1：过去零销量但存在真实有效缺货时，目标库存也要参考缺货需求，
  // 否则 salesReference=0 → targetInventory=0，计划会被“历史零销量”锁死在低位。
  const demandReference = round2(Math.max(salesReference, demandSignal.extraDemand));
  const targetInventory = round2(demandReference * planCfg.targetInventoryMonths);
  let desired = round2(salesReference + demandSignal.absorbed + (targetInventory - stock));

  const laborLimit = city ? laborCapacity(company, city, config, world) : 0;
  const materialLimit = materialSupportedOutput(world, company, config, workingCapitalRoom);
  const wageBill = monthlyWageBill(company, config);
  // 稳岗补贴由财政分担在岗员工工资：计算现金压力时按补贴后净工资账单，避免补贴期间仍被迫裁员。
  const retentionSubsidy = city
    ? retentionSubsidyPerEmployee(world, city.id, company.wageRate, config)
    : 0;
  const netWageBill = Math.max(0, wageBill - retentionSubsidy * company.employees);
  const cashMonths = netWageBill > 0 ? company.cash / netWageBill : Number.POSITIVE_INFINITY;

  // ---- 3) 紧急下调条件：库存严重积压 / 现金不足 / 原料与资金仅支撑很低产量 ----
  const stuck = salesReference > 0.01 && stock > planCfg.stuckInventoryMonths * salesReference;
  const cashTight = cashMonths < config.company.wageReserveMonths;
  const materialTight =
    Number.isFinite(materialLimit) &&
    materialLimit < Math.max(1, salesReference * (1 - planCfg.maxDownAdjust));
  const emergency = stuck || cashTight || materialTight;

  // ---- 4) 平滑：以上期计划为基准 ±20%（紧急时允许更大幅度下调） ----
  const capacityBase = Math.max(
    round2(company.capacity * company.utilization),
    round2(equipmentLimit * company.utilization),
  );
  // 上期计划 → 上月实际产量 → 产能×利用率，逐级回退，旧档/测试构造的对象也能平滑。
  const previousOutput = round2(company.previousMonth?.produced ?? 0);
  const base =
    existing && existing.plannedOutput > 0
      ? round2(existing.plannedOutput)
      : previousOutput > 0
        ? previousOutput
        : capacityBase;
  let smoothed: number;
  // v1.1：过去零销量但存在真实有效缺货时，不因“历史销量为零”强制继续下调；
  // 允许回到由缺货吸收 + 目标库存推出的 desired（仍受 +maxUpAdjust 上限约束），
  // 这与持续下跌的市场（有历史成交、真实需求消失）区分开。
  const recoveringFromZeroSales = salesReference <= 0.01 && demandSignal.extraDemand > 0.01;
  if (base > 0) {
    const lower = base * (1 - (emergency ? planCfg.emergencyDownAdjust : planCfg.maxDownAdjust));
    const upper = base * (1 + planCfg.maxUpAdjust);
    const floor = recoveringFromZeroSales ? Math.min(lower, desired) : lower;
    smoothed = clamp(desired, floor, upper);
  } else {
    smoothed = desired;
  }
  smoothed = Math.max(0, smoothed);

  // ---- 5) 资源上限：设备 → 原料 → 劳动（劳动是当前实际可用的硬上限） ----
  const equipmentCapped = Math.min(smoothed, equipmentLimit);
  const materialCapped = Math.min(equipmentCapped, materialLimit);
  // 最低维护性产出：计划不为 0 时不低于设备产能 × minOutputRatio。
  // 不把维护性产出压到原料可支撑量以下：材料采购可走银行授信（v0.7 起的采购融资裁决），
  // 若这里被“当前现金能买多少料”的 0 封死，会形成“计划 0 → 不采购 → 无产出 → 无收入”的死锁。
  const maintenanceFloor = Math.min(equipmentCapped, equipmentLimit * planCfg.minOutputRatio);
  let intended = Math.max(materialCapped, maintenanceFloor);
  if (!Number.isFinite(intended)) intended = equipmentLimit;
  intended = Math.max(0, intended);
  const plannedOutput = round2(Math.max(0, Math.min(intended, laborLimit)));
  const plannedJobs =
    laborLimit > 0 && company.employees > 0
      ? Math.max(
          0,
          Math.ceil(
            intended / Math.max(1e-6, laborLimit / Math.max(1, company.employees)),
          ),
        )
      : Math.max(
          0,
          Math.ceil(intended / outputPerEmployee(world, company, config)),
        );

  // ---- 5b) 资源瓶颈判定与扩产评估（v1.0 首版） ----
  // 设备够却缺员工 → 优先招聘；员工够却缺原料 → 优先采购；只有设备是瓶颈且扩产
  // 条件满足时才把“买设备”当作选项（具体投资由 planning/strategy 执行）。
  let bottleneck: 'equipment' | 'labor' | 'material' | 'none' = 'none';
  if (laborLimit + 0.01 < intended) {
    bottleneck = 'labor';
  } else if (
    Number.isFinite(materialLimit) &&
    materialLimit + 0.01 < Math.min(smoothed, equipmentLimit)
  ) {
    bottleneck = 'material';
  } else if (equipmentLimit + 0.01 < smoothed) {
    bottleneck = 'equipment';
  }
  const expansion = assessExpansion(world, company, config, {
    plannedOutput,
    equipmentLimit,
    salesReference,
    laborLimit,
    cityShortage: demandSignal.cityShortage,
  });

  // ---- 6) 原因说明（供 AI 决策/界面读取） ----
  const reasons: string[] = [];
  const historyMonths = Math.max(1, (company.salesHistory ?? []).length);
  reasons.push(
    `销售参考 ${salesReference.toFixed(2)}（近 ${historyMonths} 月实际销量），目标库存 ${targetInventory.toFixed(2)}，现有库存 ${stock.toFixed(2)}`,
  );
  reasons.push(
    `设备产能 ${equipmentLimit.toFixed(2)}，劳动产能 ${laborLimit.toFixed(2)}${Number.isFinite(materialLimit) ? `，原料资金可支撑 ${materialLimit.toFixed(2)}` : ''}`,
  );
  if (demandSignal.cityShortage > 0.01) {
    reasons.push(
      `城市缺货 ${demandSignal.cityShortage.toFixed(2)}（同城同产出 ${demandSignal.peers} 家，本企业份额 ${(demandSignal.share * 100).toFixed(1)}%），本月吸收 ${demandSignal.absorbed.toFixed(2)}（${(planCfg.unmetDemandAbsorption * 100).toFixed(0)}%）`,
    );
  }
  if (recoveringFromZeroSales) {
    reasons.push(
      `近 ${historyMonths} 月无实际成交，但存在 ${demandSignal.extraDemand.toFixed(2)} 的有效缺货份额：按缺货信号恢复计划，不因历史零销量锁死（上限仍为 +${(planCfg.maxUpAdjust * 100).toFixed(0)}%）`,
    );
  }
  if (bottleneck === 'labor') {
    reasons.push(
      `劳动产能不足：现有员工 ${company.employees} 人只能支撑 ${laborLimit.toFixed(2)}，优先招聘（计划岗位 ${plannedJobs}），而不是买设备`,
    );
  } else if (bottleneck === 'material') {
    reasons.push(
      `原料/采购资金不足：只能支撑 ${materialLimit.toFixed(2)}，优先采购原料，而不是买设备`,
    );
  } else if (bottleneck === 'equipment') {
    reasons.push(
      `设备产能不足：设备上限 ${equipmentLimit.toFixed(2)} < 计划目标 ${smoothed.toFixed(2)}，${expansion.eligible ? '扩产条件满足，可评估购买设备' : '扩产条件未满足，暂不购买设备'}`,
    );
  }
  reasons.push(...expansion.reasons);
  if (stuck) reasons.push(`成品库存超过 ${planCfg.stuckInventoryMonths} 个月销量，紧急下调`);
  if (cashTight)
    reasons.push(
      `现金仅够 ${Number.isFinite(cashMonths) ? cashMonths.toFixed(2) : '∞'} 个月工资，紧急下调`,
    );
  if (materialTight) reasons.push('原料或采购资金不足，紧急下调');
  if (plannedOutput < intended - 0.01) {
    reasons.push(`现有员工仅能支撑 ${laborLimit.toFixed(2)}，计划需要 ${intended.toFixed(2)}，需招聘`);
  }
  if (base > 0 && Math.abs(smoothed - desired) > 0.01) {
    reasons.push(`按 ±${(planCfg.maxUpAdjust * 100).toFixed(0)}% 平滑（上期计划 ${base.toFixed(2)}）`);
  }
  if (plannedOutput <= 0.01) reasons.push('受设备/员工/原料约束，本月计划产量为 0');

  const plan: CompanyProductionPlan = {
    tick,
    salesReference,
    targetInventory,
    equipmentLimit,
    laborLimit,
    plannedOutput,
    plannedJobs,
    emergency,
    reasons,
  };
  company.productionPlan = plan;
  // 岗位需求由计划产量推出（供招聘/裁员使用），不再绑定历史产能。
  company.jobDemand = plannedJobs;
  return plan;
}
