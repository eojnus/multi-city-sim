// 验收 C 组：企业购债限制（AC-C01–C05）。验证“认购只用自有资金、不得触发贷款”的冻结口径。
import { describe, expect, it } from 'vitest';
import { DEMO_CONFIG } from '../../src/data/config';
import type { City, Company, LoanContract, WorldState } from '../../src/simulation/contracts/types';
import {
  bondHolderAvailableCash,
  bondSubscriptionOrder,
  closeGovernmentBondSubscription,
  issueGovernmentBond,
  subscribeGovernmentBond,
} from '../../src/simulation/government/bonds';
import { cityById, newWorld } from './helpers';

const CONFIG = DEMO_CONFIG;
const FACE = CONFIG.government.bondMarket.faceValue;
const CITY_ID = 'lanport';

function setup(companyCash = 5_000) {
  const world = newWorld(0);
  const city = cityById(world, CITY_ID);
  const company = world.companies.find((entry) => entry.cityId === city.id);
  if (!company) throw new Error('缺少测试企业');
  company.cash = companyCash;
  // v1.1 §5：购债可用现金 = 现金 −（2 个月工资 + 1 个月计划原料 + 1 个月已知偿债）。
  // 本组验收只验证“认购只用自有资金、不得触发贷款”，故把三项储备清零，使可用现金=现金。
  company.employees = 0;
  company.roles = { management: 0, production: 0, sales: 0, research: 0 };
  company.productionPlan = null;
  company.utilization = 0;
  company.lastMonth.wageArrears = 0;
  if (world.banking) {
    world.banking.loans = world.banking.loans.filter(
      (loan) => !(loan.borrower.kind === 'company' && loan.borrower.id === company.id),
    );
  }
  const issuance = issueGovernmentBond(world, city, CONFIG, 10, 0).issuance!;
  return { world, city, company, issuance };
}

function loansOf(world: WorldState, company: Company): LoanContract[] {
  return (world.banking?.loans ?? []).filter(
    (loan) => loan.borrower.kind === 'company' && loan.borrower.id === company.id,
  );
}

function purchase(
  world: WorldState,
  issuanceId: string,
  company: Company,
  units: number,
  tick = 0,
) {
  return subscribeGovernmentBond(world, CONFIG, issuanceId, { kind: 'company', id: company.id }, units, tick);
}

function fakeCompanyLoan(company: Company): LoanContract {
  return {
    id: 'loan-company-existing',
    borrower: { kind: 'company', id: company.id },
    purpose: 'workingCapital',
    principal: 20_000,
    outstanding: 20_000,
    monthlyPrincipal: 1_000,
    rateMonthly: 0.005,
    termMonths: 20,
    startTick: 0,
    nextDueTick: 1,
    paidPrincipal: 0,
    paidInterest: 0,
    accruedInterest: 0,
    arrearsPrincipal: 0,
    arrearsInterest: 0,
    missedPayments: 0,
    status: 'active',
    payments: [],
    note: '验收测试用存量贷款',
  };
}

describe('AC-C01 认购不触发贷款', () => {
  it('企业认购前后银行贷款笔数/未偿本金不变', () => {
    const { world, company, issuance } = setup(5_000);
    const before = loansOf(world, company);
    const totalBefore = before.reduce((sum, loan) => sum + loan.outstanding, 0);

    const result = purchase(world, issuance.id, company, 2);
    expect(result.units).toBe(2);
    expect(result.principal).toBe(2_000);
    expect(company.cash).toBe(3_000);

    const after = loansOf(world, company);
    expect(after).toHaveLength(before.length);
    expect(after.reduce((sum, loan) => sum + loan.outstanding, 0)).toBeCloseTo(totalBefore, 6);
    expect(company.cash).toBeGreaterThanOrEqual(0);
  });
});

describe('AC-C02 禁止“先贷款再认购”绕过', () => {
  it('按认购顺序整轮跑一遍（含现金为 0 的企业），不新增任何贷款，也不存在购债用途贷款', () => {
    const { world, city, issuance } = setup(5_000);
    const companies = world.companies.filter((entry) => entry.cityId === city.id);
    const zeroCash = companies[0]!;
    zeroCash.cash = 0;

    const loansBefore = (world.banking?.loans ?? []).length;
    const order = bondSubscriptionOrder(world, CONFIG, issuance.id);
    for (const holder of order) {
      if (holder.kind !== 'company') continue;
      const company = world.companies.find((entry) => entry.id === holder.id);
      if (!company) continue;
      const available = bondHolderAvailableCash(world, CONFIG, holder);
      const units = Math.floor(available / FACE);
      if (units <= 0) {
        const zero = purchase(world, issuance.id, company, 1);
        expect(zero.units).toBe(0);
        continue;
      }
      purchase(world, issuance.id, company, units);
    }

    expect((world.banking?.loans ?? []).length).toBe(loansBefore);
    // 银行贷款用途中不得出现购债相关用途（LoanPurpose 白名单里只有经营/消费等）。
    const purposes = new Set((world.banking?.loans ?? []).map((loan) => loan.purpose));
    expect([...purposes]).not.toContain('bond');
    expect([...purposes]).not.toContain('bondPurchase');
    expect(zeroCash.cash).toBe(0);
  });
});

describe('AC-C03 只用现有可支配资金', () => {
  it('成交金额 ≤ 可用现金；成交后现金 ≥ 0，且不被强制凑整', () => {
    const { world, company, issuance } = setup(3_500);
    const available = bondHolderAvailableCash(world, CONFIG, { kind: 'company', id: company.id });
    expect(available).toBe(3_500);

    const result = purchase(world, issuance.id, company, 5);
    expect(result.units).toBe(3);
    expect(result.principal).toBe(3_000);
    expect(company.cash).toBe(500);
    expect(company.cash).toBeGreaterThanOrEqual(0);
    // 零钱保留，不强行凑整。
    expect(company.cash % FACE).toBe(500 % FACE);
  });
});

describe('AC-C04 已有贷款企业不一律禁止', () => {
  it('有存量经营贷款的企业仍可用自有资金认购，且存量贷款不变', () => {
    const { world, company, issuance } = setup(3_000);
    const loan = fakeCompanyLoan(company);
    world.banking!.loans.push(loan);
    const loansBefore = loansOf(world, company).length;

    const result = purchase(world, issuance.id, company, 1);
    expect(result.units).toBe(1);
    expect(company.cash).toBe(2_000);
    const loansAfter = loansOf(world, company);
    expect(loansAfter).toHaveLength(loansBefore);
    expect(loansAfter[0]!.outstanding).toBe(20_000);
    expect(loansAfter[0]!.status).toBe('active');
  });
});

describe('AC-C05 现金不足/非整数份拒绝且无副作用', () => {
  it('现金 < 1 份或不含整数份时 0 份成交：不扣款、不贷款、不留持仓', () => {
    const { world, company, issuance } = setup(500);
    const loansBefore = (world.banking?.loans ?? []).length;
    const holdingsBefore = (world.bonds?.holdings ?? []).length;

    const poor = purchase(world, issuance.id, company, 1);
    expect(poor.units).toBe(0);
    expect(company.cash).toBe(500);
    expect(issuance.soldUnits).toBe(0);
    expect(issuance.principal).toBe(0);

    // 非整数份：直接拒绝。
    company.cash = 2_000;
    const fractional = purchase(world, issuance.id, company, 1.5);
    expect(fractional.ok).toBe(false);
    expect(company.cash).toBe(2_000);
    expect((world.bonds?.holdings ?? []).length).toBe(holdingsBefore);
    expect((world.banking?.loans ?? []).length).toBe(loansBefore);
    closeGovernmentBondSubscription(world, CONFIG, issuance.id, 0);
  });
});
