import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation/core/simulation';
import { DEMO_CONFIG } from '../src/data/config';
import type { CompanyMonthlyStats } from '../src/simulation/contracts/types';
import { planCompanies } from '../src/simulation/companies/planning';
import { laborCapacity, runInputPurchasing, runProduction } from '../src/simulation/production/production';
import { migrationAttractiveness } from '../src/simulation/population/population';
import { createWorldLedgers } from '../src/simulation/markets/markets';
import {
  createEmptyInventory,
  monthlyWageBill,
  setCompanyEmployees,
} from '../src/simulation/companies/company';
import { round2 } from '../src/simulation/core/math';

function monthStats(overrides: Partial<CompanyMonthlyStats> = {}): CompanyMonthlyStats {
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
    ...overrides,
  };
}

describe('已复现缺陷修复', () => {
  it('经营计划读取 previousMonth，而不是本月初已重置的 lastMonth', () => {
    const a = Simulation.create();
    const b = Simulation.create();
    const companyA = a.state.companies.find((company) => company.id === 'lp-food')!;
    const companyB = b.state.companies.find((company) => company.id === 'lp-food')!;

    // 两个世界除销售统计外完全相同；lastMonth 故意设成与 previousMonth 相反的方向，
    // 修复前读取 lastMonth 会得到相反的利用率变化。
    for (const company of a.state.companies) company.previousMonth = monthStats();
    for (const company of b.state.companies) company.previousMonth = monthStats();
    companyA.previousMonth = monthStats({ produced: 100, sold: 120, exported: 0 });
    companyB.previousMonth = monthStats({ produced: 100, sold: 20, exported: 0 });
    companyA.lastMonth = monthStats({ produced: 100, sold: 10, exported: 0 });
    companyB.lastMonth = monthStats({ produced: 100, sold: 300, exported: 0 });

    const utilizationBefore = companyA.utilization;
    expect(companyB.utilization).toBe(utilizationBefore);

    planCompanies(a.state, DEMO_CONFIG, []);
    planCompanies(b.state, DEMO_CONFIG, []);

    expect(companyA.utilization).toBeGreaterThan(utilizationBefore);
    expect(companyB.utilization).toBeLessThan(utilizationBefore);
  });

  it('零员工企业不产出、不消耗原料；恢复员工后恢复产出', () => {
    const world = Simulation.create().state;
    const energy = world.companies.find((company) => company.id === 'lp-energy')!;
    const energyCity = world.cities.find((city) => city.id === energy.cityId)!;
    const food = world.companies.find((company) => company.id === 'lp-food')!;
    const employeesBackup = energy.employees;

    setCompanyEmployees(energy, 0);
    setCompanyEmployees(food, 0);
    const energyInventoryBefore = { ...energy.inventory };
    const foodInputsBefore = {
      grain: food.inventory.grain ?? 0,
      energy: food.inventory.energy ?? 0,
    };

    expect(laborCapacity(energy, energyCity)).toBe(0);
    const records = runProduction(world, createWorldLedgers(world), DEMO_CONFIG);
    expect(records.some((record) => record.companyId === energy.id)).toBe(false);
    expect(records.some((record) => record.companyId === food.id)).toBe(false);
    expect(energy.inventory).toEqual(energyInventoryBefore);
    expect(food.inventory.grain ?? 0).toBe(foodInputsBefore.grain);
    expect(food.inventory.energy ?? 0).toBe(foodInputsBefore.energy);

    setCompanyEmployees(energy, employeesBackup);
    const restored = runProduction(world, createWorldLedgers(world), DEMO_CONFIG);
    const record = restored.find((entry) => entry.companyId === energy.id);
    expect(record).toBeDefined();
    expect(record!.qty).toBeGreaterThan(0);
    expect(record!.qty).toBeLessThanOrEqual(laborCapacity(energy, energyCity) + 0.01);
  });

  it('政治支持率越高，迁入吸引力越高', () => {
    const world = Simulation.create().state;
    const city = world.cities.find((candidate) => candidate.id === 'lanport')!;

    city.politics.approval = 40;
    const lowApproval = migrationAttractiveness(city, world, DEMO_CONFIG);
    city.politics.approval = 80;
    const highApproval = migrationAttractiveness(city, world, DEMO_CONFIG);

    expect(highApproval).toBeGreaterThan(lowApproval);
    expect(highApproval - lowApproval).toBeCloseTo(
      40 * DEMO_CONFIG.population.approvalMigrationWeight,
      2,
    );
  });

  it('无供应时采购不改变现金和债务（成交式融资，不预先借款）', () => {
    const world = Simulation.create().state;
    for (const company of world.companies) {
      company.utilization = 0;
      company.inventory = createEmptyInventory();
    }
    const buyer = world.companies.find((company) => company.id === 'lp-food')!;
    buyer.utilization = DEMO_CONFIG.company.initialUtilization;
    buyer.cash = 10_000_000;
    buyer.debt = 0;
    const cashBefore = buyer.cash;
    const debtBefore = buyer.debt;

    runInputPurchasing(world, createWorldLedgers(world), DEMO_CONFIG, []);

    expect(buyer.cash).toBe(cashBefore);
    expect(buyer.debt).toBe(debtBefore);
  });

  it('有供应时成交，借款不超过实际采购支出', () => {
    const world = Simulation.create().state;
    for (const company of world.companies) {
      company.utilization = 0;
      company.inventory = createEmptyInventory();
    }
    const buyer = world.companies.find((company) => company.id === 'lp-food')!;
    const seller = world.companies.find((company) => company.id === 'lp-energy')!;
    expect(seller.cityId).toBe(buyer.cityId);

    buyer.utilization = DEMO_CONFIG.company.initialUtilization;
    const wage = monthlyWageBill(buyer);
    // 自有现金只略高于工资保留额，采购后必须依赖成交型融资补足。
    buyer.cash = round2(wage * 0.6);
    buyer.debt = 0;
    seller.inventory.energy = 1_000_000;
    const cashBefore = buyer.cash;
    const debtBefore = buyer.debt;

    runInputPurchasing(world, createWorldLedgers(world), DEMO_CONFIG, []);

    const energyBought = buyer.inventory.energy ?? 0;
    const debtDelta = round2(buyer.debt - debtBefore);
    const spend = round2(cashBefore - buyer.cash + debtDelta);

    expect(energyBought).toBeGreaterThan(0);
    expect(spend).toBeGreaterThan(0);
    expect(debtDelta).toBeGreaterThan(0);
    expect(debtDelta).toBeLessThanOrEqual(spend + 0.01);
    // 本地成交计入内销，不计出口。
    expect(seller.lastMonth.sold).toBeGreaterThan(0);
    expect(seller.lastMonth.exported).toBe(0);
  });
});
