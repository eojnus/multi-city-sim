import type { GoodId, RoleAllocation, Company, RoleKey } from '../contracts/types';
import type { DemoConfig } from '../../data/config';
import { allocateProportionally, round2 } from '../core/math';
import { GOODS } from '../../data/demo-data';

export const GOOD_IDS: GoodId[] = GOODS.map((good) => good.id);

/** 计薪的四个岗位（不含公共部门；顺序固定便于按权重拆分）。 */
export const WAGE_ROLES: RoleKey[] = ['management', 'production', 'sales', 'research'];

export function createEmptyInventory(): Record<GoodId, number> {
  return {
    grain: 0,
    fiber: 0,
    fabric: 0,
    metal: 0,
    energy: 0,
    food: 0,
    clothing: 0,
    household: 0,
    farmEquipment: 0,
    industryEquipment: 0,
    energyEquipment: 0,
  };
}

const ROLE_WEIGHTS: { key: keyof RoleAllocation; weight: number }[] = [
  { key: 'management', weight: 0.08 },
  { key: 'production', weight: 0.76 },
  { key: 'sales', weight: 0.1 },
  { key: 'research', weight: 0.06 },
];

export function distributeRoles(total: number): RoleAllocation {
  const counts = allocateProportionally(
    Math.max(0, Math.round(total)),
    ROLE_WEIGHTS.map((entry) => entry.weight),
  );
  const result: RoleAllocation = { management: 0, production: 0, sales: 0, research: 0 };
  ROLE_WEIGHTS.forEach((entry, index) => {
    result[entry.key] = counts[index] ?? 0;
  });
  return result;
}

/** 企业员工数是权威值；岗位分布始终按员工数重算，保证岗位合计 = 员工数。 */
export function setCompanyEmployees(company: Company, employees: number): void {
  const next = Math.max(0, Math.round(employees));
  company.employees = next;
  company.roles = distributeRoles(next);
}

export function roleTotal(roles: RoleAllocation): number {
  return roles.management + roles.production + roles.sales + roles.research;
}

/** 某岗位的月工资率：企业基准工资率 × 职业工资倍数（未配置的岗位退回基准）。 */
export function occupationWageRate(
  company: Company,
  occupation: RoleKey,
  config: DemoConfig,
): number {
  const multiplier = config.labor.occupationWageMultipliers[occupation] ?? 1;
  return round2(company.wageRate * multiplier);
}

/**
 * 企业月度工资总额：Σ(岗位人数 × 岗位工资率)。
 *
 * 口径：roles 之和可能小于 employees（旧存档/未分配角色），差额按生产岗位计，
 * 保证工资覆盖 100% 员工；由于生产倍数为 0.95，这部分兜底的总额比旧口径
 * “employees × wageRate”低 5%（其余岗位按各自倍数），与新口径可比。
 */
export function companyWageBill(company: Company, config: DemoConfig): number {
  let total = 0;
  let assigned = 0;
  for (const role of WAGE_ROLES) {
    const count = Math.max(0, company.roles[role] ?? 0);
    assigned += count;
    total += count * occupationWageRate(company, role, config);
  }
  const unassigned = Math.max(0, company.employees - assigned);
  if (unassigned > 0) {
    total += unassigned * occupationWageRate(company, 'production', config);
  }
  return round2(total);
}

/**
 * 月度工资总额。传入 config 时按职业工资率计算（问题 4 修复后的新口径）；
 * 不传时退回旧口径“员工数 × 基准工资率”，保证旧测试与未迁移调用仍可用。
 */
export function monthlyWageBill(company: Company, config?: DemoConfig): number {
  if (config) return companyWageBill(company, config);
  return round2(company.employees * company.wageRate);
}

export function inventoryValue(company: Company, prices: Record<GoodId, number>): number {
  let total = 0;
  for (const goodId of GOOD_IDS) {
    total += (company.inventory[goodId] ?? 0) * (prices[goodId] ?? 0);
  }
  return round2(total);
}

export function companySharePrice(company: Company, prices: Record<GoodId, number>): number {
  const book =
    company.cash +
    inventoryValue(company, prices) +
    company.capacity * 0.6 +
    300_000 -
    company.debt;
  return Math.max(1, round2(book / Math.max(1, company.totalShares)));
}

export function companyBookValue(company: Company, prices: Record<GoodId, number>): number {
  return round2(
    company.cash +
      inventoryValue(company, prices) +
      company.capacity * 0.6 +
      300_000 -
      company.debt,
  );
}
