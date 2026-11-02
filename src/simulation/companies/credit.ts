// ⚠️ 已废弃（v0.4）：本文件是 v0.3 及更早的“无对手方企业信贷”。
//
// v0.4 起企业债务的唯一权威是 world.banking.loans（独立银行系统）：
// - 借款走 banking.openLoan（形成贷款合同，立即占用授信额度）；
// - 利息与还款走 banking.serviceCompanyLoans（有对手方、有流水）；
// - company.debt 只是银行贷款未偿本金的派生镜像，由 banking.syncCompanyDebt 维护。
//
// 保留本文件仅因为 tests/lifecycle.test.ts 仍用 companyCreditLimit() 构造“额度耗尽”的
// 测试场景；生产代码已无调用方。不要在业务代码里重新调用这里的函数。

import type { Company } from '../contracts/types';
import type { DemoConfig } from '../../data/config';
import { monthlyWageBill } from './company';
import { round2 } from '../core/math';

export function companyCreditLimit(company: Company, config: DemoConfig): number {
  const base = company.baseWageBill > 0 ? company.baseWageBill : monthlyWageBill(company);
  return round2(base * config.company.creditLimitWageMonths);
}

export function restructureDebt(company: Company): number {
  if (company.debt <= 0) return 0;
  const forgiven = round2(company.debt * 0.5);
  company.debt = round2(company.debt - forgiven);
  return forgiven;
}

export function creditAvailable(company: Company, config: DemoConfig): number {
  return Math.max(0, round2(companyCreditLimit(company, config) - company.debt));
}

/**
 * 营运资金信贷（演示）：企业现金不足时自动借款，避免因单月回款时点
 * 造成“有产能、有订单但无现金采购”的流动性死亡螺旋。借款计入 debt。
 */
export function ensureLiquidity(
  company: Company,
  targetCash: number,
  config: DemoConfig,
): number {
  if (company.cash >= targetCash) return 0;
  const needed = targetCash - company.cash;
  const borrow = Math.min(needed, creditAvailable(company, config));
  if (borrow <= 0) return 0;
  company.cash = round2(company.cash + borrow);
  company.debt = round2(company.debt + borrow);
  return round2(borrow);
}

export function payInterest(company: Company, config: DemoConfig): number {
  if (company.debt <= 0) return 0;
  const interest = round2(company.debt * config.company.creditInterestRate);
  const paid = round2(Math.min(company.cash, interest));
  company.cash = round2(company.cash - paid);
  company.debt = round2(company.debt + (interest - paid));
  company.lastMonth.interestPaid = paid;
  return paid;
}

export function repayDebt(company: Company, config: DemoConfig): number {
  if (company.debt <= 0) return 0;
  const reserve = monthlyWageBill(company) * 0.5;
  const spare = Math.max(0, company.cash - reserve);
  const repayment = round2(
    Math.min(company.debt, spare * config.company.debtRepaymentRate),
  );
  if (repayment <= 0) return 0;
  company.cash = round2(company.cash - repayment);
  company.debt = round2(company.debt - repayment);
  return repayment;
}
