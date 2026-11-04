// v1.2 §2：企业购债偿债储备必须包含逾期本金，并与银行实际还款口径共用同一 helper。
//
// 验收复现：outstanding=20000、arrearsPrincipal=8000、monthlyPrincipal=1000、月利息=100、
// missedPayments=1、现金=10000 → 真实下期需 9100（逾期本金 8000 + 当期本金 1000 + 利息 100），
// 储备 9100、可认购现金 900（旧实现漏逾期本金，会算成 8900）。
// 覆盖：末期结清、部分偿还、逾期、正常、逾期欠息未到期时点、真实认购前后现金与下期还款。
import { describe, expect, it } from 'vitest';
import { DEMO_CONFIG } from '../src/data/config';
import type { Company, LoanContract, WorldState } from '../src/simulation/contracts/types';
import {
  bondHolderAvailableCash,
  companyBondReserve,
  issueGovernmentBond,
  subscribeGovernmentBond,
} from '../src/simulation/government/bonds';
import {
  nextLoanObligation,
  serviceCompanyLoans,
} from '../src/simulation/banking/banking';
import { cityById, newWorld } from './acceptance/helpers';

const CONFIG = DEMO_CONFIG;
const CITY_ID = 'lanport';

/** 隔离工资/原料储备：企业无员工、无生产计划，只保留偿债储备，便于核对债务口径。 */
function setup(cash: number) {
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

/** 验收复现贷款：逾期本金 8000 + 当期本金 1000 + 利息 100。 */
function overdueLoan(company: Company, overrides: Partial<LoanContract> = {}): LoanContract {
  return {
    id: 'loan-reserve-v12',
    borrower: { kind: 'company', id: company.id },
    purpose: 'workingCapital',
    principal: 20_000,
    outstanding: 20_000,
    monthlyPrincipal: 1_000,
    rateMonthly: 0.005,
    termMonths: 24,
    startTick: 0,
    nextDueTick: 1,
    paidPrincipal: 0,
    paidInterest: 0,
    accruedInterest: 0,
    arrearsPrincipal: 8_000,
    arrearsInterest: 0,
    missedPayments: 1,
    status: 'active',
    payments: [],
    note: 'v1.2 逾期本金储备测试',
    ...overrides,
  };
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

describe('§2 验收复现：逾期本金必须计入购债储备', () => {
  it('outstanding 20000 + 逾期本金 8000 → 储备 9100、可认购 900（旧实现 8900）', () => {
    const { world, company } = setup(10_000);
    const loan = overdueLoan(company);
    world.banking!.loans = [loan];

    const obligation = nextLoanObligation(loan, 0);
    expect(obligation.arrearsPrincipalDue).toBe(8_000);
    expect(obligation.collectiblePrincipal).toBe(9_000);
    expect(obligation.interestDue).toBe(100);
    expect(obligation.total).toBe(9_100);

    const breakdown = companyBondReserve(world, CONFIG, company.id)!;
    expect(breakdown.wages).toBe(0);
    expect(breakdown.materials).toBe(0);
    expect(breakdown.debtService).toBe(9_100);
    expect(breakdown.reserved).toBe(9_100);
    expect(breakdown.available).toBe(900);
    expect(bondHolderAvailableCash(world, CONFIG, { kind: 'company', id: company.id })).toBe(900);
  });

  it('储备不足一份面额时不认购、不扣现金', () => {
    const { world, company, issuance } = setup(10_000);
    world.banking!.loans = [overdueLoan(company)];
    const result = purchase(world, issuance.id, company, 1);
    expect(result.ok).toBe(true);
    expect(result.units).toBe(0);
    expect(company.cash).toBe(10_000);
  });
});

describe('§2 真实认购与下期还款（不只测储备函数）', () => {
  it('认购 1 份后，下期银行按同一口径收 9100，现金仍保留储备', () => {
    const { world, company, issuance } = setup(11_000);
    world.banking!.loans = [overdueLoan(company)];

    // 11000 − 9100 = 1900 可认购；买 1 份（1000）后现金 10000。
    expect(companyBondReserve(world, CONFIG, company.id)!.available).toBe(1_900);
    const result = purchase(world, issuance.id, company, 1);
    expect(result.ok).toBe(true);
    expect(result.units).toBe(1);
    expect(company.cash).toBe(10_000);

    // 下一个月结：先息后本，利息 100 + 逾期本金 8000 + 当期本金 1000 = 9100。
    world.time.tick = 1;
    const served = serviceCompanyLoans(world, company, CONFIG, 1, []);
    expect(served.interestPaid).toBe(100);
    expect(served.principalPaid).toBe(9_000);
    expect(company.cash).toBe(900);

    const loan = world.banking!.loans[0]!;
    expect(loan.outstanding).toBe(11_000);
    expect(loan.arrearsPrincipal).toBe(0);
    expect(loan.missedPayments).toBe(0);

    // 下下期义务：利息 55 + 本金 1000 = 1055；现金 900 不足以覆盖，可认购现金为 0。
    const nextObligation = nextLoanObligation(loan, 1);
    expect(nextObligation.interestDue).toBe(55);
    expect(nextObligation.total).toBe(1_055);
    const breakdown = companyBondReserve(world, CONFIG, company.id)!;
    expect(breakdown.debtService).toBe(1_055);
    expect(breakdown.available).toBe(0);
  });

  it('部分偿还后剩余逾期本金继续计入下一期储备', () => {
    const { world, company } = setup(500);
    // 逾期本金 8000 但尚未连续欠付（missedPayments=0），部分偿还后只累计 1 次欠付，不会立刻违约。
    const loan = overdueLoan(company, { missedPayments: 0 });
    world.banking!.loans = [loan];

    const served = serviceCompanyLoans(world, company, CONFIG, 1, []);
    expect(served.interestPaid).toBe(100);
    expect(served.principalPaid).toBe(400);
    expect(company.cash).toBe(0);
    expect(loan.outstanding).toBe(19_600);
    // 到期本金 9000 未付清，剩余 8600 记入逾期本金（outstanding 子集）。
    expect(loan.arrearsPrincipal).toBe(8_600);
    expect(loan.missedPayments).toBe(1);
    expect(loan.status).toBe('active');

    const nextObligation = nextLoanObligation(loan, 1);
    expect(nextObligation.arrearsPrincipalDue).toBe(8_600);
    expect(nextObligation.interestDue).toBe(98);
    expect(nextObligation.total).toBe(9_698);
    world.time.tick = 1;
    expect(companyBondReserve(world, CONFIG, company.id)!.debtService).toBe(9_698);
  });
});

describe('§2 边界口径', () => {
  it('末期按剩余未偿本金结清', () => {
    // 现金恰好覆盖结清本金 5000 + 当期利息 25。
    const { world, company } = setup(5_025);
    const loan = overdueLoan(company, {
      outstanding: 5_000,
      arrearsPrincipal: 0,
      missedPayments: 0,
      startTick: 0,
      nextDueTick: 24,
    });
    world.banking!.loans = [loan];
    const obligation = nextLoanObligation(loan, 23);
    expect(obligation.scheduledPrincipal).toBe(5_000);
    expect(obligation.total).toBe(5_025);
    // 储备在“下一月结即末期”的时点必须覆盖结清本金 + 当期利息。
    world.time.tick = 23;
    expect(companyBondReserve(world, CONFIG, company.id)!.debtService).toBe(5_025);

    const served = serviceCompanyLoans(world, company, CONFIG, 24, []);
    expect(served.principalPaid).toBe(5_000);
    expect(loan.status).toBe('repaid');
    expect(company.cash).toBe(0);
  });

  it('正常贷款：当期本金 + 利息，无逾期', () => {
    const { world, company } = setup(2_000);
    const loan = overdueLoan(company, { arrearsPrincipal: 0, missedPayments: 0 });
    world.banking!.loans = [loan];
    const obligation = nextLoanObligation(loan, 0);
    expect(obligation.due).toBe(true);
    expect(obligation.total).toBe(1_100);
    expect(companyBondReserve(world, CONFIG, company.id)!.debtService).toBe(1_100);

    const served = serviceCompanyLoans(world, company, CONFIG, 1, []);
    expect(served.interestPaid).toBe(100);
    expect(served.principalPaid).toBe(1_000);
    expect(company.cash).toBe(900);
  });

  it('逾期欠息无论下期是否到期都计入储备；未到期只计已逾期部分', () => {
    const { world, company } = setup(10_000);
    const loan = overdueLoan(company, { nextDueTick: 5, arrearsInterest: 250 });
    world.banking!.loans = [loan];
    const obligation = nextLoanObligation(loan, 0);
    expect(obligation.due).toBe(false);
    expect(obligation.arrearsInterestDue).toBe(250);
    expect(obligation.arrearsPrincipalDue).toBe(8_000);
    expect(obligation.total).toBe(8_250);
    const breakdown = companyBondReserve(world, CONFIG, company.id)!;
    expect(breakdown.debtService).toBe(8_250);
    expect(breakdown.available).toBe(1_750);
  });
});
