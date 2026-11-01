import type { GoodId, RoleAllocation, Company } from '../contracts/types';
import { allocateProportionally, round2 } from '../core/math';
import { GOODS } from '../../data/demo-data';

export const GOOD_IDS: GoodId[] = GOODS.map((good) => good.id);

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

export function monthlyWageBill(company: Company): number {
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
