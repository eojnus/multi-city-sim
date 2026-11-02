// 问题 4 回归：不同职业的工资差异。
//
// 覆盖：
// 1. 同一企业四个职业的岗位工资率不同（管理最高、生产最低），roles 加权总额 == companyWageBill；
// 2. 企业实发工资不足（欠薪）时按“人数 × 岗位工资率”权重比例拆分，各群体工资合计 == 实发额；
// 3. 个税随工资差异分摊，splitCityHouseholdIncome 的 wages/taxes 与 privateWagesByCity 对账；
// 4. finance 层按新口径实发工资，旧口径 monthlyWageBill(company) 仍可用。
//
// 金额断言统一用 0.05 容差（0.01 精度分配的最大尾差 × 少量群体）。

import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation/core/simulation';
import { DEMO_CONFIG } from '../src/data/config';
import type {
  City,
  Company,
  RoleKey,
  WorldState,
} from '../src/simulation/contracts/types';
import {
  WAGE_ROLES,
  companyWageBill,
  monthlyWageBill,
  occupationWageRate,
  setCompanyEmployees,
} from '../src/simulation/companies/company';
import { round2 } from '../src/simulation/core/math';
import { deepClone } from '../src/simulation/core/save';
import { settleCompanyFinance } from '../src/simulation/finance/finance';
import type { FinanceResult } from '../src/simulation/finance/finance';
import { splitCityHouseholdIncome } from '../src/simulation/population/household-economy';
import { householdGroupOf, occupationPeople } from '../src/simulation/population/household-groups';

const AMOUNT_TOLERANCE = 0.05;
const WAGE_OCCUPATIONS: RoleKey[] = ['management', 'production', 'sales', 'research'];

const amounts = {
  management: 7_360,
  production: 4_370,
  sales: 5_290,
  research: 6_210,
} as const;

function cityOf(world: WorldState, cityId: string): City {
  const city = world.cities.find((candidate) => candidate.id === cityId);
  if (!city) throw new Error(`测试世界缺少城市 ${cityId}`);
  return city;
}

function sumOf<T>(items: T[], pick: (item: T) => number): number {
  return items.reduce((total, item) => total + pick(item), 0);
}

function sumMap(map: Map<string, number>): number {
  return sumOf([...map.values()], (value) => value);
}

function expectAmount(actual: number, expected: number, tolerance = AMOUNT_TOLERANCE): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance);
}

function blankFinance(cityId: string, privateWages: number): FinanceResult {
  return {
    investorDividendsByCity: {},
    investorDistributionByCity: {},
    cityDividendsByCity: {},
    dividendsByCity: {},
    playerDividends: 0,
    playerDividendsByCompany: {},
    corporateTaxByCity: {},
    privateWagesByCity: { [cityId]: privateWages },
    wageArrears: 0,
  };
}

/**
 * 把某城收缩为“一家企业 + 无公共部门”的受控场景：
 * 其他企业员工与实发工资清零，只保留目标企业与给定实发额，便于精确断言拆分结果。
 */
function isolateSingleCompany(
  world: WorldState,
  city: City,
  employees: number,
  paidWages: number,
): Company {
  const candidates = world.companies
    .filter((company) => company.cityId === city.id)
    .sort((a, b) => a.id.localeCompare(b.id));
  const target = candidates[0];
  if (!target) throw new Error(`城市 ${city.id} 没有企业`);
  for (const company of candidates) {
    if (company.id === target.id) continue;
    setCompanyEmployees(company, 0);
    company.jobDemand = 0;
    company.lastMonth.wagesPaid = 0;
  }
  setCompanyEmployees(target, employees);
  target.wageRate = 4_600;
  target.lastMonth.wagesPaid = paidWages;
  city.publicSector.employees = 0;
  return target;
}

function groupWage(world: WorldState, city: City, split: ReturnType<typeof splitCityHouseholdIncome>, role: RoleKey): number {
  const group = householdGroupOf(world, city.id, role);
  if (!group) throw new Error(`城市 ${city.id} 缺少 ${role} 群体`);
  return split.wages.get(group.id) ?? 0;
}

function groupTax(world: WorldState, city: City, split: ReturnType<typeof splitCityHouseholdIncome>, role: RoleKey): number {
  const group = householdGroupOf(world, city.id, role);
  if (!group) throw new Error(`城市 ${city.id} 缺少 ${role} 群体`);
  return split.taxes.get(group.id) ?? 0;
}

describe('问题 4：职业工资差异', () => {
  it('岗位工资率按职业倍数计算：管理 > 研发 > 销售 > 生产，且 roles 加权总额 == companyWageBill', () => {
    const world = Simulation.create().state;
    const company = world.companies[0];
    if (!company) throw new Error('测试世界没有企业');
    setCompanyEmployees(company, 1_000);
    company.wageRate = 4_600;

    // 岗位月工资率 = 企业基准工资率 × 职业倍数（四舍五入到 0.01）。
    for (const role of WAGE_ROLES) {
      expect(occupationWageRate(company, role, DEMO_CONFIG)).toBe(
        round2(company.wageRate * DEMO_CONFIG.labor.occupationWageMultipliers[role]),
      );
      expect(occupationWageRate(company, role, DEMO_CONFIG)).toBe(amounts[role]);
    }
    const management = occupationWageRate(company, 'management', DEMO_CONFIG);
    const research = occupationWageRate(company, 'research', DEMO_CONFIG);
    const sales = occupationWageRate(company, 'sales', DEMO_CONFIG);
    const production = occupationWageRate(company, 'production', DEMO_CONFIG);
    expect(management).toBeGreaterThan(research);
    expect(research).toBeGreaterThan(sales);
    expect(sales).toBeGreaterThan(production);

    // roles 加权总额（人数 × 岗位工资率）等于 companyWageBill。
    const weighted = WAGE_ROLES.reduce(
      (total, role) =>
        total + (company.roles[role] ?? 0) * occupationWageRate(company, role, DEMO_CONFIG),
      0,
    );
    expect(companyWageBill(company, DEMO_CONFIG)).toBe(round2(weighted));

    // 加权总成本相对旧均匀口径约 +4.6%，低于验收上限 +10%。
    const legacyBill = round2(company.employees * company.wageRate);
    expect(companyWageBill(company, DEMO_CONFIG)).toBeGreaterThan(legacyBill);
    expect(companyWageBill(company, DEMO_CONFIG) / legacyBill).toBeLessThanOrEqual(1.1);

    // 口径兜底：roles 之和 < employees 的差额按生产角色计，工资覆盖 100% 员工。
    company.employees = 10;
    company.roles = { management: 2, production: 0, sales: 0, research: 0 };
    expect(companyWageBill(company, DEMO_CONFIG)).toBe(
      round2(2 * management + 8 * production),
    );
  });

  it('企业实发工资不足时按职业权重比例拆分：四群体工资合计 == 实发额，且个税随工资差异分摊', () => {
    const world = deepClone(Simulation.create().state);
    const city = world.cities[0];
    if (!city) throw new Error('测试世界没有城市');
    const paidWages = 12_000;
    const company = isolateSingleCompany(world, city, 100, paidWages);

    const finance = blankFinance(city.id, paidWages);
    const split = splitCityHouseholdIncome(world, city, finance, 0, 0, DEMO_CONFIG);

    const weights = WAGE_OCCUPATIONS.map(
      (role) => (company.roles[role] ?? 0) * occupationWageRate(company, role, DEMO_CONFIG),
    );
    const weightTotal = weights.reduce((total, weight) => total + weight, 0);

    // 1) 各群体工资合计严格等于企业实发工资（allocateMoney 保证 0.01 精度）。
    const totalWages = sumMap(split.wages);
    expectAmount(totalWages, paidWages);
    expectAmount(totalWages, sumOf(world.companies, (entry) => entry.lastMonth.wagesPaid));

    // 2) 每个职业的工资 == 实发额 × 该职业权重占比（尾差 ≤ 0.05）。
    WAGE_OCCUPATIONS.forEach((role, index) => {
      const weight = weights[index] ?? 0;
      const expected = round2((paidWages * weight) / weightTotal);
      expectAmount(groupWage(world, city, split, role), expected);
    });

    // 3) 与旧“按人数等比例”口径相比：管理群体份额更高、生产群体份额更低。
    const oldEqualShare = (role: RoleKey): number =>
      round2((paidWages * (company.roles[role] ?? 0)) / company.employees);
    expect(groupWage(world, city, split, 'management')).toBeGreaterThan(
      oldEqualShare('management'),
    );
    expect(groupWage(world, city, split, 'production')).toBeLessThan(
      oldEqualShare('production'),
    );

    // 4) 人均工资排序与岗位工资率一致：管理最高、生产最低。
    const perCapita = (role: RoleKey): number => {
      const count = company.roles[role] ?? 0;
      expect(count).toBeGreaterThan(0);
      return groupWage(world, city, split, role) / count;
    };
    expect(perCapita('management')).toBeGreaterThan(perCapita('research'));
    expect(perCapita('research')).toBeGreaterThan(perCapita('sales'));
    expect(perCapita('sales')).toBeGreaterThan(perCapita('production'));
    expectAmount(perCapita('management'), amounts.management * (paidWages / weightTotal));
    expectAmount(perCapita('production'), amounts.production * (paidWages / weightTotal));

    // 5) 个税：城市口径按 privateWagesByCity × 个税率计算，再按各群体工资比例分摊；
    //    管理群体人均个税高于生产群体，体现工资差异影响税基。
    const expectedIncomeTax = round2(round2(paidWages * city.incomeTaxRate));
    expect(split.incomeTax).toBe(expectedIncomeTax);
    expectAmount(sumMap(split.taxes), split.incomeTax);
    expect(groupTax(world, city, split, 'management') / (company.roles.management ?? 1)).toBeGreaterThan(
      groupTax(world, city, split, 'production') / (company.roles.production ?? 1),
    );

    // 6) 口径闭合：householdIncome = 工资 - 个税（本例无福利/股息/退款）。
    expectAmount(split.householdIncome, sumMap(split.wages) - sumMap(split.taxes));
  });

  it('finance 层按职业工资率实发工资：各企业实发 == companyWageBill，城市私企工资与拆分对账', () => {
    const world = deepClone(Simulation.create().state);
    for (const company of world.companies) {
      // 充足现金：确保本月没有欠薪，实发额即应付额。
      company.cash = 100_000_000;
      company.debt = 0;
    }
    // 让目标企业的岗位分布足够大，避免小企业取整后恰好无差异。
    const target = world.companies.find((company) => company.cityId === 'lanport');
    if (!target) throw new Error('测试世界缺少目标企业');
    setCompanyEmployees(target, 500);

    const finance = settleCompanyFinance(world, DEMO_CONFIG, []);

    // 1) 每家企业实发工资 == companyWageBill（无欠薪）。
    for (const company of world.companies) {
      expectAmount(company.lastMonth.wagesPaid, companyWageBill(company, DEMO_CONFIG));
    }

    // 2) 城市私企工资合计与 finance 口径一致。
    for (const city of world.cities) {
      const companies = world.companies.filter((company) => company.cityId === city.id);
      const expectedPrivateWages = sumOf(companies, (company) =>
        companyWageBill(company, DEMO_CONFIG),
      );
      expectAmount(finance.privateWagesByCity[city.id] ?? 0, expectedPrivateWages);
      expectAmount(
        sumOf(companies, (company) => company.lastMonth.wagesPaid),
        expectedPrivateWages,
      );
    }

    // 3) 新口径确实高于旧均匀口径（加权 +4.6%），证明 finance 已迁移。
    expect(target.lastMonth.wagesPaid).toBeGreaterThan(monthlyWageBill(target));

    // 4) 用 splitCityHouseholdIncome 与 privateWagesByCity 对账：私企四群体工资合计 == 实发总额。
    const city = cityOf(world, target.cityId);
    const split = splitCityHouseholdIncome(world, city, finance, 0, 0, DEMO_CONFIG);
    const privateGroupWages = sumOf(WAGE_OCCUPATIONS, (role) => groupWage(world, city, split, role));
    expectAmount(privateGroupWages, finance.privateWagesByCity[city.id] ?? 0);

    // 5) 人均工资：管理 ≈ 4600×1.6，生产 ≈ 4600×0.95（工资群体人数由岗位派生，口径一致）。
    for (const role of WAGE_OCCUPATIONS) {
      const people = occupationPeople(world, city, role);
      expect(people).toBeGreaterThan(0);
      expectAmount(groupWage(world, city, split, role) / people, amounts[role]);
    }
  });

  it('旧口径兼容：monthlyWageBill(company) 仍等于 employees × wageRate', () => {
    const world = Simulation.create().state;
    const company = world.companies[0];
    if (!company) throw new Error('测试世界没有企业');
    setCompanyEmployees(company, 37);
    company.wageRate = 4_600;

    expect(monthlyWageBill(company)).toBe(round2(company.employees * company.wageRate));
    // 传入 config 时切换到新口径。
    expect(monthlyWageBill(company, DEMO_CONFIG)).toBe(companyWageBill(company, DEMO_CONFIG));
    expect(monthlyWageBill(company, DEMO_CONFIG)).not.toBe(monthlyWageBill(company));
  });
});
