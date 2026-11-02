// 验收问题 3：自动流动性借款必须按“每笔独立期限/首期”还款，
// 不得把新借款并入旧合同导致提前到期。
import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation/core/simulation';
import { DEMO_CONFIG } from '../src/data/config';
import type { BankOwner, Company, LogEntry, WorldState } from '../src/simulation/contracts/types';
import { round2 } from '../src/simulation/core/math';
import {
  bankLoansOf,
  availableCredit,
  creditOwnerCash,
  ownerOutstanding,
} from '../src/simulation/banking/credit';
import { drawWorkingCapital, repayLoan, serviceCompanyLoans } from '../src/simulation/banking/banking';

function newWorld(): WorldState {
  return Simulation.create().state;
}

function firstCompany(world: WorldState): Company {
  const company = world.companies[0];
  if (!company) throw new Error('测试世界没有企业');
  return company;
}

function owner(company: Company): BankOwner {
  return { kind: 'company', id: company.id };
}

function seedCash(world: WorldState, company: Company, amount: number): void {
  creditOwnerCash(world, owner(company), amount);
}

/** 逐月结算该企业的银行贷款（与 simulation 的 settleCompanyFinance 调用一致）。 */
function serviceMonths(
  world: WorldState,
  company: Company,
  fromTick: number,
  toTick: number,
  log: LogEntry[] = [],
): void {
  for (let tick = fromTick; tick <= toTick; tick += 1) {
    serviceCompanyLoans(world, company, DEMO_CONFIG, tick, log);
  }
}

describe('周转贷款批次与还款计划（验收问题 3）', () => {
  it('旧贷款最后一期前追加新借款：新借款首期从下月开始，各自按完整期限还款', () => {
    const world = newWorld();
    const company = firstCompany(world);
    seedCash(world, company, 1_000_000);

    const first = drawWorkingCapital(world, company, 2400, DEMO_CONFIG, 0);
    expect(first).toBe(2400);
    let loans = bankLoansOf(world).filter((loan) => loan.borrower.id === company.id);
    expect(loans).toHaveLength(1);
    const oldLoan = loans[0]!;
    expect(oldLoan.termMonths).toBe(24);
    expect(oldLoan.nextDueTick).toBe(1);

    // 还 23 期后，旧贷款只剩最后一期本金 100。
    serviceMonths(world, company, 1, 23);
    expect(oldLoan.outstanding).toBe(100);
    expect(oldLoan.status).toBe('active');

    // 第 23 期追加同额借款：不得并入旧合同。
    const cashBeforeDraw = company.cash;
    const second = drawWorkingCapital(world, company, 2400, DEMO_CONFIG, 23);
    expect(second).toBe(2400);
    expect(company.cash).toBe(round2(cashBeforeDraw + 2400));
    loans = bankLoansOf(world).filter((loan) => loan.borrower.id === company.id);
    expect(loans).toHaveLength(2);
    const newLoan = loans.find((loan) => loan.id !== oldLoan.id)!;
    expect(newLoan.principal).toBe(2400);
    expect(newLoan.outstanding).toBe(2400);
    expect(newLoan.startTick).toBe(23);
    expect(newLoan.nextDueTick).toBe(24);
    expect(newLoan.termMonths).toBe(24);
    // 旧合同本金不被静默改动。
    expect(oldLoan.principal).toBe(2400);

    // 第 24 期：旧合同收尾 100，新合同只还第 1 期 100，合计本金 200（不是 2500）。
    const cashBeforeService = company.cash;
    const interestBefore = serviceInterestTotal(world, company);
    serviceMonths(world, company, 24, 24);
    expect(oldLoan.status).toBe('repaid');
    expect(oldLoan.outstanding).toBe(0);
    expect(newLoan.outstanding).toBe(2300);
    const interestThisMonth = round2(serviceInterestTotal(world, company) - interestBefore);
    const principalPaid = round2(cashBeforeService - company.cash - interestThisMonth);
    expect(principalPaid).toBeCloseTo(200, 2);
  });

  it('同一月多次追加：每笔生成独立合同，各自 24 期', () => {
    const world = newWorld();
    const company = firstCompany(world);
    seedCash(world, company, 1_000_000);

    drawWorkingCapital(world, company, 600, DEMO_CONFIG, 0);
    drawWorkingCapital(world, company, 900, DEMO_CONFIG, 0);
    const loans = bankLoansOf(world).filter((loan) => loan.borrower.id === company.id);
    expect(loans).toHaveLength(2);
    for (const loan of loans) {
      expect(loan.startTick).toBe(0);
      expect(loan.nextDueTick).toBe(1);
      expect(loan.termMonths).toBe(24);
      expect(loan.outstanding).toBe(loan.principal);
    }
    expect(ownerOutstanding(world, owner(company))).toBe(1500);
    expect(company.debt).toBe(1500);
  });

  it('提前偿还旧合同不影响新合同的剩余期限与未偿', () => {
    const world = newWorld();
    const company = firstCompany(world);
    seedCash(world, company, 1_000_000);
    drawWorkingCapital(world, company, 1200, DEMO_CONFIG, 0);
    serviceMonths(world, company, 1, 2);
    drawWorkingCapital(world, company, 1200, DEMO_CONFIG, 2);
    const [oldLoan, newLoan] = bankLoansOf(world)
      .filter((loan) => loan.borrower.id === company.id)
      .sort((a, b) => a.id.localeCompare(b.id));
    expect(oldLoan && newLoan).toBeTruthy();

    const repay = repayLoan(world, oldLoan!.id, oldLoan!.outstanding, DEMO_CONFIG, 2);
    expect(repay.ok).toBe(true);
    expect(oldLoan!.status).toBe('repaid');
    expect(newLoan!.status).toBe('active');
    expect(newLoan!.outstanding).toBe(1200);
    expect(newLoan!.nextDueTick).toBe(3);
    expect(newLoan!.termMonths).toBe(24);
    expect(company.debt).toBe(1200);
  });

  it('不重复计息、不重复扣款：每期只按各自未偿本金计息', () => {
    const world = newWorld();
    const company = firstCompany(world);
    seedCash(world, company, 1_000_000);
    drawWorkingCapital(world, company, 1200, DEMO_CONFIG, 0);
    serviceMonths(world, company, 1, 1);
    drawWorkingCapital(world, company, 1200, DEMO_CONFIG, 1);

    const rate = DEMO_CONFIG.banking.products.workingCapital.rateMonthly;
    const before = company.cash;
    serviceMonths(world, company, 2, 2);
    const nextTickInterest = round2(
      (1200 - 50) * rate + 1200 * rate,
    );
    const expectedPrincipal = 50 + 50;
    const spent = round2(before - company.cash);
    expect(spent).toBeCloseTo(round2(nextTickInterest + expectedPrincipal), 1);
    const loans = bankLoansOf(world).filter((loan) => loan.borrower.id === company.id);
    expect(loans.reduce((total, loan) => total + loan.outstanding, 0)).toBe(round2(company.debt));
    for (const loan of loans) {
      expect(loan.outstanding).toBeLessThanOrEqual(loan.principal);
    }
  });
});

/** 该企业银行贷款累计已付利息（用于把本期现金流拆成“本金 + 利息”）。 */
function serviceInterestTotal(world: WorldState, company: Company): number {
  const loans = bankLoansOf(world).filter((loan) => loan.borrower.id === company.id);
  return round2(loans.reduce((total, loan) => total + loan.paidInterest, 0));
}
