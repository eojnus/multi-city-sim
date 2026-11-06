import type { Company, WorldState } from '../contracts/types';
import type { DemoConfig } from '../../data/config';
import { RECIPES } from '../../data/demo-data';
import { round2 } from '../core/math';
import { monthlyWageBill } from './company';
import { estimatedMonthlyMaintenance } from '../equipment/maintenance';

/**
 * v1.6 §四.4：设备月度维护费接入点。
 *
 * 维护费的权威计算在装备模块（`src/simulation/equipment/maintenance.ts`，
 * 签名 `estimatedMonthlyMaintenance(world, company, config): number`）。企业侧所有
 * AI 决策（生产成本、盈亏平衡、保留资金、买/卖设备、破产风险）统一通过本函数读取，
 * 避免每个调用点各自实现口径；helper 未落地时这里返回 0（接入点只改这一处）。
 */
export function companyMonthlyMaintenance(
  world: WorldState,
  company: Company,
  config: DemoConfig,
): number {
  const value = estimatedMonthlyMaintenance(world, company, config);
  return Number.isFinite(value) && value > 0 ? round2(value) : 0;
}

export interface CompanyUnitCost {
  /** 单位原料成本（按本城当前市场价）。 */
  inputCost: number;
  /** 单位工资成本（月工资账单 ÷ 产出规模）。 */
  wagePerUnit: number;
  /** 单位设备维护费（月维护费 ÷ 产出规模）。 */
  maintenancePerUnit: number;
  /** 单位总变动成本（原料 + 工资 + 维护费）。 */
  total: number;
  /** 计算工资/维护费摊薄所用的月产出规模（台/单位）。 */
  outputScale: number;
}

/**
 * 企业单位产出成本，供定价底线与创业评分共用。
 *
 * 口径：
 * - 原料按企业所在城市当月市场价（计划采购面对的同一价格）；
 * - 工资按当前岗位结构的月工资账单摊到本月计划产量；计划缺失时退回设备产能（与
 *   production-plan 的销售参考口径一致），避免除以 0；
 * - 维护费按 §四.4 helper 的月总额摊到同一产出规模。
 * 不含利息与折旧（利息在固定成本里单列，避免 AI 利润判断重复扣减）。
 */
export function companyUnitCost(
  world: WorldState,
  company: Company,
  config: DemoConfig,
): CompanyUnitCost {
  const city = world.cities.find((entry) => entry.id === company.cityId);
  const recipe = RECIPES[company.recipeOutput];
  let inputCost = 0;
  for (const input of recipe?.inputs ?? []) {
    const price = Math.max(0.01, city?.market[input.good]?.price ?? 0.01);
    inputCost += input.qty * price;
  }
  inputCost = round2(inputCost);
  const plan = company.productionPlan;
  const planned = Math.max(0, plan?.plannedOutput ?? 0);
  const capacity = Math.max(0, plan?.equipmentLimit ?? 0);
  const fallback = Math.max(1e-9, capacity > 0 ? capacity : (company.capacity ?? 0));
  const outputScale = Math.max(1e-9, planned > 0.01 ? planned : fallback);
  const wageBill = monthlyWageBill(company, config);
  const maintenance = companyMonthlyMaintenance(world, company, config);
  const wagePerUnit = round2(wageBill / outputScale);
  const maintenancePerUnit = round2(maintenance / outputScale);
  return {
    inputCost,
    wagePerUnit,
    maintenancePerUnit,
    total: round2(inputCost + wagePerUnit + maintenancePerUnit),
    outputScale: round2(outputScale),
  };
}

export interface CompanyFixedCost {
  /** 月工资账单（按岗位工资率，不含奖金）。 */
  wage: number;
  /** 月设备维护费（§四.4）。 */
  maintenance: number;
  /** 月偿债：上月实付利息 + 未偿本金按均摊月数。 */
  debtService: number;
  total: number;
}

/**
 * 企业月固定成本（破产风险/保留资金的统一口径）：
 * 工资 + 设备维护费 + 偿债。AI 决策中的“现金能撑几个月”“保留几个月工资”都应包括
 * 维护费；维护费不是 COGS，不进单位原料成本（见 companyUnitCost 的分摊用法）。
 */
export function companyMonthlyFixedCost(
  world: WorldState,
  company: Company,
  config: DemoConfig,
): CompanyFixedCost {
  const wage = round2(Math.max(0, monthlyWageBill(company, config)));
  const maintenance = round2(Math.max(0, companyMonthlyMaintenance(world, company, config)));
  const interest = Math.max(
    0,
    company.previousMonth?.interestPaid ?? company.lastMonth?.interestPaid ?? 0,
  );
  const debt = Math.max(0, company.debt ?? 0);
  const debtMonths = Math.max(1, config.production.plan.expansionDebtMonths);
  const debtService = round2(interest + debt / debtMonths);
  return { wage, maintenance, debtService, total: round2(wage + maintenance + debtService) };
}
