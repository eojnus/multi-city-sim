import type { Company, CompanyProductionPlan, WorldState } from '../contracts/types';
import type { DemoConfig } from '../../data/config';
import { PRODUCTIVITY, RECIPES } from '../../data/demo-data';
import { clamp, round2 } from '../core/math';
import { monthlyWageBill } from './company';
import { laborCapacity, companyProductivityMultiplier } from '../production/production';
import { equipmentCapacityFor } from '../equipment/equipment';
import { workforceSkillMultiplier } from '../labor/workforce';
import { retentionSubsidyPerEmployee } from '../policies/query';

/**
 * v0.9 T2：企业月度生产计划。
 *
 * 把四种“产能/产量”分开，避免再拿 decay 后的 utilization 直接当产量：
 * 1. 设备产能 equipmentLimit：Σ(设备台数 × 每台产能 × 城市技术系数)；
 * 2. 劳动产能 laborLimit：现有员工按生产模块口径（员工 × 人均生产率 × 技术 × 技能 ×
 *    政策 × laborCapacityFactor）能支撑的产量；
 * 3. 计划产量 plannedOutput：以“近 3 月实际销量 + 目标库存”为目标，按月 ±20% 平滑，
 *    库存积压/现金不足/原料资金不足时可紧急下调（下限见 config.production.plan.emergencyDownAdjust）；
 *    再取 min(计划, 设备产能, 原料可支持产量, 劳动产能)。
 * 4. 实际产量：仍由 production.ts 在生产时按 min(计划, 劳动, 原料) 校验，不得超计划。
 *
 * 平滑口径：以上一期计划产量为基准做 ±20% 限幅；没有上期计划（新企业/旧档）时优先用
 * 上一完整月的实际产量（更贴近“按月平滑”的本意），再退回“产能 × 利用率”；基准为 0 时
 * 直接采用本期目标（仍受资源上限约束）。
 * 销量历史 salesHistory 由本模块在每月第一次制定计划时维护（上一完整月的 sold + exported，
 * 最多保留 salesLookbackMonths 月），与存档校验（≤3）一致。
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
 * - 自动授信不预先计入（授信裁决由采购模块处理），因此现金紧张企业的计划会收缩，
 *   后续若拿到授权融资，采购模块仍可在计划内买料。
 */
export function materialSupportedOutput(
  world: WorldState,
  company: Company,
  config: DemoConfig,
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
  const budget = Math.max(0, round2(company.cash - wage * config.company.wageReserveMonths));
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

/**
 * 重算并写回企业生产计划。同一 tick 内重复调用是幂等的（直接返回已有计划），
 * 避免同一月内多次平滑叠加；跨月后第一次调用会维护销量历史。
 */
export function recomputeProductionPlan(
  world: WorldState,
  company: Company,
  config: DemoConfig,
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
  const targetInventory = round2(salesReference * planCfg.targetInventoryMonths);
  const outputId = company.recipeOutput;
  const stock = Math.max(0, company.inventory[outputId] ?? 0);
  let desired = round2(salesReference + (targetInventory - stock));

  const laborLimit = city ? laborCapacity(company, city, config, world) : 0;
  const materialLimit = materialSupportedOutput(world, company, config);
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
  if (base > 0) {
    const lower = base * (1 - (emergency ? planCfg.emergencyDownAdjust : planCfg.maxDownAdjust));
    const upper = base * (1 + planCfg.maxUpAdjust);
    smoothed = clamp(desired, lower, upper);
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

  // ---- 6) 原因说明（供 AI 决策/界面读取） ----
  const reasons: string[] = [];
  const historyMonths = Math.max(1, (company.salesHistory ?? []).length);
  reasons.push(
    `销售参考 ${salesReference.toFixed(2)}（近 ${historyMonths} 月实际销量），目标库存 ${targetInventory.toFixed(2)}，现有库存 ${stock.toFixed(2)}`,
  );
  reasons.push(
    `设备产能 ${equipmentLimit.toFixed(2)}，劳动产能 ${laborLimit.toFixed(2)}${Number.isFinite(materialLimit) ? `，原料资金可支撑 ${materialLimit.toFixed(2)}` : ''}`,
  );
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
