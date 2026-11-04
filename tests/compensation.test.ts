import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation/core/simulation';
import { DEMO_CONFIG } from '../src/data/config';
import type {
  Company,
  CompanyMonthlyStats,
  CreditSnapshot,
  WorldState,
} from '../src/simulation/contracts/types';
import { round2 } from '../src/simulation/core/math';
import { monthlyWageBill, setCompanyEmployees } from '../src/simulation/companies/company';
import { setCityPopulation } from '../src/simulation/population/population';
import { splitCityHouseholdIncome } from '../src/simulation/population/household-economy';
import { settleCompanyFinance } from '../src/simulation/finance/finance';
import { reconcileLabor } from '../src/simulation/labor/labor';

function blankStats(): CompanyMonthlyStats {
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
    bonusPaid: 0,
    emergencyLayoffs: 0,
  };
}

/** 把企业清到“零员工、零现金、无历史利润”，只保留目标企业做实验。 */
function resetCompany(company: Company): void {
  company.cash = 0;
  company.debt = 0;
  company.wageRate = 1_000;
  company.dividendPayoutRatio = 0;
  setCompanyEmployees(company, 0);
  company.jobDemand = 0;
  company.lastMonth = blankStats();
  company.previousMonth = blankStats();
  company.recentProfits = [];
}

interface FinanceSetup {
  world: WorldState;
  company: Company;
}

/**
 * 财务测试世界：目标企业 lp-food（岚港）10 名员工、月薪 1,000，单月收入 1,000,000。
 * 其它企业全部清零，避免工资/分红/税收互相干扰；银行无贷款与授信快照。
 */
function financeWorld(): FinanceSetup {
  const world = Simulation.create().state;
  for (const company of world.companies) resetCompany(company);
  // 清空公共部门雇员，避免公共部门工资混入居民工资拆分对账（本测试只关心私营奖金）。
  for (const city of world.cities) city.publicSector.employees = 0;
  if (world.banking) {
    world.banking.loans = [];
    world.banking.snapshots = [];
  }
  const company = world.companies.find((candidate) => candidate.id === 'lp-food');
  if (!company) throw new Error('测试世界缺少 lp-food 企业');
  setCompanyEmployees(company, 10);
  company.lastMonth.revenue = 1_000_000;
  company.lastMonth.inputCost = 0;
  company.recentProfits = [100_000, 100_000];
  world.time.tick = 3;
  return { world, company };
}

interface LaborSetup {
  world: WorldState;
  city: WorldState['cities'][number];
  company: Company;
}

/**
 * 劳动力测试世界：岚港 10,000 人口 / 8,000 劳动力，目标企业 lp-food 100 人、需求 0。
 * 其它企业员工与公共部门岗位清零；授信快照默认 limit=0（即无可用授信）。
 */
function laborWorld(options: { creditLimit?: number } = {}): LaborSetup {
  const world = Simulation.create().state;
  for (const company of world.companies) resetCompany(company);
  for (const city of world.cities) {
    city.publicSector.employees = 0;
    city.publicSector.jobs = 0;
  }
  const city = world.cities.find((candidate) => candidate.id === 'lanport');
  if (!city) throw new Error('测试世界缺少 lanport');
  setCityPopulation(city, 10_000, 8_000, 0);
  const company = world.companies.find((candidate) => candidate.id === 'lp-food');
  if (!company) throw new Error('测试世界缺少 lp-food 企业');
  setCompanyEmployees(company, 100);
  company.jobDemand = 0;
  company.cash = 0;
  company.recentProfits = [-10_000, -10_000];
  if (world.banking) {
    world.banking.loans = [];
    const limit = options.creditLimit ?? 0;
    const snapshot: CreditSnapshot = {
      tick: world.time.tick,
      borrower: { kind: 'company', id: company.id },
      baseValue: 0,
      limitRate: 0,
      limit,
      outstanding: 0,
      available: limit,
      method: 'equityBook',
      reason: '测试授信快照',
    };
    world.banking.snapshots = [snapshot];
  }
  return { world, city, company };
}

function sumMap(map: Map<string, number>): number {
  let total = 0;
  for (const value of map.values()) total += value;
  return round2(total);
}

describe('v0.9 T5：季度奖金', () => {
  it('连续 3 个月盈利且现金充足：按近 3 月利润 10% 发放，并保留工资/偿债储备', () => {
    const { world, company } = financeWorld();
    company.cash = 500_000;
    const cashBefore = company.cash;

    const finance = settleCompanyFinance(world, DEMO_CONFIG, []);

    const stats = company.lastMonth;
    // 窗口 = recentProfits(2 项) + 本月利润，共 3 项；全部为正才发放。
    const profitWindow = company.recentProfits.slice(-DEMO_CONFIG.compensation.bonusEveryMonths);
    expect(profitWindow).toHaveLength(DEMO_CONFIG.compensation.bonusEveryMonths);
    expect(profitWindow.every((profit) => profit > 0)).toBe(true);
    const profitSum = round2(profitWindow.reduce((total, profit) => total + profit, 0));
    const expectedBonus = round2(profitSum * DEMO_CONFIG.compensation.bonusProfitShare);

    expect(stats.bonusPaid).toBe(expectedBonus);
    expect(expectedBonus).toBeGreaterThan(0);
    // 奖金计入工资性收入，但不重复造收入口径：实发工资 = 工资应付 + 奖金。
    expect(stats.wagesPaid).toBe(round2(monthlyWageBill(company, DEMO_CONFIG) + expectedBonus));
    // 现金守恒：实发工资（已含奖金）+ 企业所得税（本例无贷款利息、无股息）。
    expect(cashBefore - company.cash).toBe(
      round2(stats.wagesPaid + stats.corporateTax),
    );
    // 发完奖金仍保留 ≥ 2 个月工资的现金储备（本例无贷款偿债）。
    expect(company.cash).toBeGreaterThanOrEqual(
      round2(monthlyWageBill(company, DEMO_CONFIG) * DEMO_CONFIG.compensation.bonusReserveWageMonths),
    );
    // 城市私营工资口径包含奖金；居民工资拆分自动覆盖，且合计一致。
    expect(finance.privateWagesByCity.lanport).toBe(stats.wagesPaid);
    const city = world.cities.find((candidate) => candidate.id === 'lanport')!;
    const split = splitCityHouseholdIncome(world, city, finance, 0, 0, DEMO_CONFIG);
    expect(sumMap(split.wages)).toBe(stats.wagesPaid);
  });

  it('利润窗口内有一月亏损：不发奖金', () => {
    const { world, company } = financeWorld();
    company.cash = 500_000;
    company.recentProfits = [100_000, -5_000];
    const cashBefore = company.cash;

    const finance = settleCompanyFinance(world, DEMO_CONFIG, []);

    expect(company.lastMonth.profit).toBeGreaterThan(0);
    expect(company.lastMonth.bonusPaid ?? 0).toBe(0);
    expect(company.lastMonth.wagesPaid).toBe(monthlyWageBill(company, DEMO_CONFIG));
    expect(cashBefore - company.cash).toBe(
      round2(company.lastMonth.wagesPaid + company.lastMonth.corporateTax),
    );
    expect(finance.privateWagesByCity.lanport).toBe(company.lastMonth.wagesPaid);
  });

  it('现金不足储备：不发奖金、现金不为负、不借款', () => {
    const { world, company } = financeWorld();
    company.cash = 20_000; // 够发工资（约 1.07 万），但远不够“工资 + 2 个月工资储备”。
    const loansBefore = world.banking?.loans.length ?? 0;

    settleCompanyFinance(world, DEMO_CONFIG, []);

    expect(company.lastMonth.bonusPaid ?? 0).toBe(0);
    expect(company.cash).toBeGreaterThanOrEqual(0);
    expect(world.banking?.loans.length ?? 0).toBe(loansBefore);
    expect(company.lastMonth.wagesPaid).toBe(monthlyWageBill(company, DEMO_CONFIG));
  });

  it('有可用授信也不借款发奖金：奖金只来自自有现金', () => {
    const { world, company } = financeWorld();
    company.cash = 12_000; // 刚好够工资，发完即无储备。
    world.banking!.snapshots = [
      {
        tick: world.time.tick,
        borrower: { kind: 'company', id: company.id },
        baseValue: 0,
        limitRate: 0,
        limit: 1_000_000,
        outstanding: 0,
        available: 1_000_000,
        method: 'equityBook',
        reason: '测试授信快照',
      },
    ];
    const loansBefore = world.banking!.loans.length;

    settleCompanyFinance(world, DEMO_CONFIG, []);

    expect(company.lastMonth.bonusPaid ?? 0).toBe(0);
    expect(world.banking!.loans.length).toBe(loansBefore);
    expect(company.cash).toBeGreaterThanOrEqual(0);
  });

  it('非评估月不发奖金，但 recentProfits 每月维护且最多保留 bonusEveryMonths 项', () => {
    const { world, company } = financeWorld();
    company.cash = 500_000;
    company.recentProfits = [];

    world.time.tick = 1;
    settleCompanyFinance(world, DEMO_CONFIG, []);
    expect(company.lastMonth.bonusPaid ?? 0).toBe(0);
    expect(company.recentProfits).toHaveLength(1);

    world.time.tick = 2;
    settleCompanyFinance(world, DEMO_CONFIG, []);
    expect(company.lastMonth.bonusPaid ?? 0).toBe(0);
    expect(company.recentProfits).toHaveLength(2);

    world.time.tick = 3;
    settleCompanyFinance(world, DEMO_CONFIG, []);
    expect(company.lastMonth.bonusPaid ?? 0).toBeGreaterThan(0);
    expect(company.recentProfits).toHaveLength(DEMO_CONFIG.compensation.bonusEveryMonths);
    expect(company.recentProfits.every((profit) => profit > 0)).toBe(true);
  });
});

describe('v0.9 T5：紧急裁员（30%）', () => {
  it('连续亏损 + 现金/授信不足 1 个月工资：当月裁 30%，超出常规 8% 的部分记入 emergencyLayoffs', () => {
    const { world, city, company } = laborWorld();
    expect(company.employees).toBe(100);

    reconcileLabor(world, DEMO_CONFIG, []);

    // 常规 8% 只能裁 8 人；紧急情形允许裁到 30%（需求为 0，故裁 30 人）。
    expect(company.employees).toBe(70);
    expect(company.lastMonth.emergencyLayoffs).toBe(22);
    expect(city.population.total).toBe(10_000);
    expect(city.population.employed).toBe(70);
    expect(city.population.unemployed).toBe(7_930);
    // 裁员不凭空增减人口：P = E + U + N 仍成立。
    expect(
      city.population.employed + city.population.unemployed + city.population.nonLabor,
    ).toBe(city.population.total);
  });

  it('常规情形仍按 8% 上限裁员，emergencyLayoffs 不记录', () => {
    const { world, company } = laborWorld();
    company.recentProfits = [];

    reconcileLabor(world, DEMO_CONFIG, []);

    expect(company.employees).toBe(92);
    expect(company.lastMonth.emergencyLayoffs ?? 0).toBe(0);
  });

  it('连续亏损但现金+授信充足：不触发紧急裁员，仍按 8%', () => {
    const { world, company } = laborWorld({ creditLimit: 200_000 });
    company.recentProfits = [-10_000, -10_000];

    reconcileLabor(world, DEMO_CONFIG, []);

    expect(company.employees).toBe(92);
    expect(company.lastMonth.emergencyLayoffs ?? 0).toBe(0);
  });

  it('亏损月数不足 2 个月：不触发紧急裁员', () => {
    const { world, company } = laborWorld();
    company.recentProfits = [-10_000];

    reconcileLabor(world, DEMO_CONFIG, []);

    expect(company.employees).toBe(92);
    expect(company.lastMonth.emergencyLayoffs ?? 0).toBe(0);
  });

  it('紧急裁员仍受需求与员工数约束：最多裁到 jobDemand，不会裁超 30%', () => {
    const { world, company } = laborWorld();
    company.jobDemand = 85; // 需求只下降 15 人，紧急上限 30 人也不应裁 30 人。

    reconcileLabor(world, DEMO_CONFIG, []);

    expect(company.employees).toBe(85);
    // 常规上限 8 人，实际裁 15 人，其中超出常规上限的 7 人记入紧急裁员。
    expect(company.lastMonth.emergencyLayoffs).toBe(7);
  });

  it('被裁员工进入失业，需求恢复后可通过招聘回聘', () => {
    const { world, city, company } = laborWorld();
    reconcileLabor(world, DEMO_CONFIG, []);
    expect(company.employees).toBe(70);
    expect(city.population.unemployed).toBe(7_930);

    company.jobDemand = 100;
    const second = reconcileLabor(world, DEMO_CONFIG, []);

    expect(second.hiresByCompany[company.id]).toBe(30);
    expect(company.employees).toBe(100);
    expect(city.population.employed).toBe(100);
    expect(city.population.unemployed).toBe(7_900);
  });
});
