import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation/core/simulation';
import { DEMO_CONFIG } from '../src/data/config';
import type { CompanyMonthlyStats, WorldState } from '../src/simulation/contracts/types';
import { setCompanyEmployees } from '../src/simulation/companies/company';
import { syncCityPopulationFromAllocations } from '../src/simulation/population/population';
import { settleCompanyFinance } from '../src/simulation/finance/finance';
import { settleGovernment } from '../src/simulation/government/fiscal';
import { startPolicy } from '../src/simulation/policies/policies';
import { parseSave, serializeSave } from '../src/simulation/core/save';
import { checkInvariants } from '../src/simulation/core/invariants';

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
  };
}

interface TaxSetup {
  world: WorldState;
  lanportCompany: WorldState['companies'][number];
  ironvaleCompany: WorldState['companies'][number];
}

/** 两座城市各选一家企业，给定相同的税前利润 1,000,000。 */
function taxSetup(): TaxSetup {
  const world = Simulation.create().state;
  for (const company of world.companies) {
    company.cash = 10_000_000;
    company.debt = 0;
    company.baseWageBill = 0;
    company.lastMonth = blankStats();
    company.previousMonth = blankStats();
    setCompanyEmployees(company, 0);
  }
  for (const city of world.cities) city.treasury = 20_000_000;
  const lanportCompany = world.companies.find((company) => company.id === 'lp-food')!;
  const ironvaleCompany = world.companies.find((company) => company.id === 'iv-food')!;
  for (const company of [lanportCompany, ironvaleCompany]) {
    company.lastMonth.revenue = 1_000_000;
    company.lastMonth.inputCost = 0;
    company.employees = 0;
    company.jobDemand = 0;
  }
  for (const city of world.cities) syncCityPopulationFromAllocations(city, world);
  return { world, lanportCompany, ironvaleCompany };
}

describe('修复二：城市企业税率生效', () => {
  it('相同税前利润 1,000,000：2% 城市缴税 20,000，20% 城市缴税 200,000', () => {
    const { world } = taxSetup();
    world.cities.find((city) => city.id === 'lanport')!.corporateTaxRate = 0.02;
    world.cities.find((city) => city.id === 'ironvale')!.corporateTaxRate = 0.2;
    const finance = settleCompanyFinance(world, DEMO_CONFIG, []);
    expect(finance.corporateTaxByCity.lanport).toBeCloseTo(20_000, 2);
    expect(finance.corporateTaxByCity.ironvale).toBeCloseTo(200_000, 2);
    expect(
      world.companies.find((company) => company.cityId === 'lanport' && company.id === 'lp-food')!
        .lastMonth.corporateTax,
    ).toBeCloseTo(20_000, 2);
    expect(checkInvariants(world)).toEqual([]);
  });

  it('税收调整只改变本城企业税款，另一城市不受影响', () => {
    const { world } = taxSetup();
    const lanport = world.cities.find((city) => city.id === 'lanport')!;
    const ironvale = world.cities.find((city) => city.id === 'ironvale')!;
    lanport.corporateTaxRate = 0.05;
    ironvale.corporateTaxRate = 0.1;
    const before = settleCompanyFinance(world, DEMO_CONFIG, []);
    expect(before.corporateTaxByCity.lanport).toBeCloseTo(50_000, 2);
    expect(before.corporateTaxByCity.ironvale).toBeCloseTo(100_000, 2);

    const raised = startPolicy(world, lanport.id, 'taxAdjustment', DEMO_CONFIG, {
      taxDirection: 'raise',
    });
    expect(raised.ok, raised.error).toBe(true);
    expect(lanport.corporateTaxRate).toBeCloseTo(0.07, 4);
    expect(ironvale.corporateTaxRate).toBeCloseTo(0.1, 4);

    // 重新给两城的对照企业设定相同税前利润。
    for (const company of world.companies) {
      company.lastMonth = blankStats();
      company.cash = 10_000_000;
    }
    const lanportCompany = world.companies.find(
      (company) => company.cityId === 'lanport' && company.id === 'lp-food',
    )!;
    const ironvaleCompany = world.companies.find((company) => company.id === 'iv-food')!;
    for (const company of [lanportCompany, ironvaleCompany]) {
      company.lastMonth.revenue = 1_000_000;
      company.lastMonth.inputCost = 0;
      company.cash = 10_000_000;
    }
    const after = settleCompanyFinance(world, DEMO_CONFIG, []);
    expect(after.corporateTaxByCity.lanport).toBeCloseTo(70_000, 2);
    expect(after.corporateTaxByCity.ironvale).toBeCloseTo(100_000, 2);
  });

  it('亏损不缴税；现金不足时只缴可用金额，企业记录与城市财政一致', () => {
    const { world } = taxSetup();
    const city = world.cities.find((entry) => entry.id === 'lanport')!;
    city.corporateTaxRate = 0.2;
    const company = world.companies.find(
      (entry) => entry.cityId === 'lanport' && entry.id === 'lp-food',
    )!;
    company.lastMonth.revenue = 100_000;
    company.lastMonth.inputCost = 200_000;
    company.cash = 10_000_000;
    const loss = settleCompanyFinance(world, DEMO_CONFIG, []);
    expect(loss.corporateTaxByCity.lanport ?? 0).toBe(0);
    expect(company.lastMonth.corporateTax).toBe(0);

    for (const entry of world.companies) {
      entry.lastMonth = blankStats();
      entry.cash = 10_000_000;
    }
    company.lastMonth.revenue = 1_000_000;
    company.lastMonth.inputCost = 0;
    company.cash = 50_000;
    city.treasury = 20_000_000;
    const poor = settleCompanyFinance(world, DEMO_CONFIG, []);
    expect(poor.corporateTaxByCity.lanport).toBeCloseTo(50_000, 2);
    expect(company.lastMonth.corporateTax).toBeCloseTo(50_000, 2);
    expect(company.cash).toBeGreaterThanOrEqual(0);

    // 财政实际入账与财务记录一致（不重复计收）。
    // 注：本世界无上一期城内运输统计 → 交通税收系数中性 1.0，故入账=基准税额；
    // 系数调整/加成损耗的分账口径由 tests/tax-transport.test.ts 唯一负责，避免重复权威。
    settleGovernment(world, poor, DEMO_CONFIG, []);
    const ledgerEntries = world.fiscal.ledger.filter(
      (entry) => entry.cityId === city.id && entry.kind === 'corporateTax',
    );
    expect(ledgerEntries).toHaveLength(1);
    expect(ledgerEntries[0]!.amount).toBeCloseTo(50_000, 2);
  });

  it('税率与城市财政在保存读取后保持一致', () => {
    const { world } = taxSetup();
    const city = world.cities.find((entry) => entry.id === 'lanport')!;
    city.corporateTaxRate = 0.17;
    const parsed = parseSave(serializeSave(world));
    expect(parsed.ok, parsed.error).toBe(true);
    const restored = parsed.world!;
    expect(restored.cities.find((entry) => entry.id === city.id)!.corporateTaxRate).toBeCloseTo(
      0.17,
      4,
    );
    const finance = settleCompanyFinance(restored, DEMO_CONFIG, []);
    expect(finance.corporateTaxByCity.lanport).toBeCloseTo(170_000, 2);
    expect(checkInvariants(restored)).toEqual([]);
  });
});
