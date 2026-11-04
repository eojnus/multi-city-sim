// v1.1 §5：企业认购国债的流动性保留口径。
// 可用现金 = 现金 −（wageMonths×月基础工资 + materialMonths×计划原料采购额 + debtServiceMonths×下一期已知应还本息）。
// 覆盖：工资/原料/偿债三压力下不可认购；储备充足时只买剩余部分且现金不低于储备；
// 未售份数如实保留（不虚构买家）；不得用贷款认购。
import { describe, expect, it } from 'vitest';
import { DEMO_CONFIG } from '../src/data/config';
import type { Company, LoanContract, WorldState } from '../src/simulation/contracts/types';
import {
  bondHolderAvailableCash,
  companyBondReserve,
  issueGovernmentBond,
  subscribeGovernmentBond,
} from '../src/simulation/government/bonds';
import { cityById, newWorld } from './acceptance/helpers';

const CONFIG = DEMO_CONFIG;
const FACE = CONFIG.government.bondMarket.faceValue;
const CITY_ID = 'lanport';

/** 隔离三项储备：工资/原料/偿债都清零，由各用例显式制造压力。 */
function setup(cash = 50_000) {
  const world = newWorld(0);
  const city = cityById(world, CITY_ID);
  const company = world.companies.find((entry) => entry.cityId === city.id);
  if (!company) throw new Error('缺少测试企业');
  company.cash = cash;
  company.employees = 0;
  company.roles = { management: 0, production: 0, sales: 0, research: 0 };
  company.productionPlan = null;
  company.utilization = 0;
  company.lastMonth.wageArrears = 0;
  if (world.banking) world.banking.loans = [];
  const issuance = issueGovernmentBond(world, city, CONFIG, 10, 0).issuance!;
  return { world, city, company, issuance };
}

function purchase(world: WorldState, issuanceId: string, company: Company, units: number) {
  return subscribeGovernmentBond(
    world,
    CONFIG,
    issuanceId,
    { kind: 'company', id: company.id },
    units,
    0,
  );
}

function loansOf(world: WorldState, company: Company): LoanContract[] {
  return (world.banking?.loans ?? []).filter(
    (loan) => loan.borrower.kind === 'company' && loan.borrower.id === company.id,
  );
}

function fakeLoan(company: Company, outstanding = 20_000, arrearsInterest = 0): LoanContract {
  return {
    id: 'loan-reserve-v11',
    borrower: { kind: 'company', id: company.id },
    purpose: 'workingCapital',
    principal: outstanding,
    outstanding,
    monthlyPrincipal: 1_000,
    rateMonthly: 0.005,
    termMonths: 20,
    startTick: 0,
    nextDueTick: 1,
    paidPrincipal: 0,
    paidInterest: 0,
    accruedInterest: 0,
    arrearsPrincipal: 0,
    arrearsInterest,
    missedPayments: 0,
    status: 'active',
    payments: [],
    note: 'v1.1 储备测试用存量贷款',
  };
}

describe('§5 工资压力', () => {
  it('2 个月工资储备覆盖全部现金时不可认购，且不触发贷款', () => {
    const { world, company, issuance } = setup(5_000);
    company.employees = 60;
    company.roles = { management: 0, production: 60, sales: 0, research: 0 };
    const breakdown = companyBondReserve(world, CONFIG, company.id)!;
    expect(breakdown.wages).toBeGreaterThan(5_000);
    expect(breakdown.available).toBe(0);
    expect(bondHolderAvailableCash(world, CONFIG, { kind: 'company', id: company.id })).toBe(0);

    const cashBefore = company.cash;
    const result = purchase(world, issuance.id, company, 1);
    expect(result.ok).toBe(true);
    expect(result.units).toBe(0);
    expect(company.cash).toBe(cashBefore);
    expect(loansOf(world, company)).toHaveLength(0);
  });
});

describe('§5 原料压力', () => {
  it('计划原料采购额储备覆盖全部现金时不可认购', () => {
    const { world, company, issuance } = setup(5_000);
    company.productionPlan = {
      tick: 0,
      plannedOutput: 1_000,
    } as Company['productionPlan'];
    for (const good of Object.keys(company.inventory) as (keyof typeof company.inventory)[]) {
      company.inventory[good] = 0;
    }
    const breakdown = companyBondReserve(world, CONFIG, company.id)!;
    expect(breakdown.materials).toBeGreaterThan(5_000);
    expect(breakdown.available).toBe(0);
    const result = purchase(world, issuance.id, company, 1);
    expect(result.units).toBe(0);
    expect(company.cash).toBe(5_000);
  });
});

describe('§5 偿债压力', () => {
  it('下一期已知本息 + 逾期欠息覆盖全部现金时不可认购', () => {
    const { world, company, issuance } = setup(500);
    world.banking!.loans = [fakeLoan(company, 20_000, 300)];
    const breakdown = companyBondReserve(world, CONFIG, company.id)!;
    // 20,000×0.5% + 1,000 本金 + 300 逾期欠息 = 1,400。
    expect(breakdown.debtService).toBeCloseTo(1_400, 2);
    expect(breakdown.available).toBe(0);
    const result = purchase(world, issuance.id, company, 1);
    expect(result.units).toBe(0);
    expect(company.cash).toBe(500);
    expect(loansOf(world, company)).toHaveLength(1);
  });
});

describe('§5 储备充足', () => {
  it('只按扣除储备后的剩余现金认购，认购后现金不低于储备', () => {
    const { world, company, issuance } = setup(0);
    company.employees = 60;
    company.roles = { management: 0, production: 60, sales: 0, research: 0 };
    const breakdown = companyBondReserve(world, CONFIG, company.id)!;
    company.cash = breakdown.reserved + 2_500;
    expect(bondHolderAvailableCash(world, CONFIG, { kind: 'company', id: company.id })).toBe(2_500);

    const result = purchase(world, issuance.id, company, 2);
    expect(result.units).toBe(2);
    expect(result.principal).toBe(2 * FACE);
    expect(company.cash).toBe(breakdown.reserved + 500);
    expect(company.cash).toBeGreaterThanOrEqual(breakdown.reserved);
  });

  it('认购后未售份数如实保留，不虚构买家', () => {
    const { world, company, issuance } = setup(0);
    company.cash = 2_500;
    purchase(world, issuance.id, company, 2);
    expect(issuance.soldUnits).toBe(2);
    expect(issuance.unsoldUnits).toBe(8);
    const holders = world.bonds!.holdings.filter((holding) => holding.issuanceId === issuance.id);
    expect(holders).toHaveLength(1);
    expect(holders[0]!.holder).toEqual({ kind: 'company', id: company.id });
  });
});

describe('§5 不得用贷款认购', () => {
  it('现金为 0 但仍有授信时成交 0 份且不新增贷款', () => {
    const { world, company, issuance } = setup(0);
    company.employees = 60;
    company.roles = { management: 0, production: 60, sales: 0, research: 0 };
    const before = loansOf(world, company).length;
    const result = purchase(world, issuance.id, company, 1);
    expect(result.units).toBe(0);
    expect(company.cash).toBe(0);
    expect(loansOf(world, company)).toHaveLength(before);
  });
});
