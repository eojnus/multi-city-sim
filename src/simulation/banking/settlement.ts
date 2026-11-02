// 银行月度结算的组合入口（测试与兜底用）。
//
// 生产结算顺序（见 docs/development/IMPLEMENTATION_PLAN_v0.4.md §2）把银行拆成三段，由核心按顺序调用：
// 1. settleDepositInterest（步骤 5）；2. serviceCompanyLoans（步骤 18，工资/所得税之后、股息之前）；
// 3. servicePlayerLoans（同步骤 18 口径）。
// settleBankMonth 只是把三段组合起来，避免测试与旧调用点必须自己记住顺序。
//
// 本文件不触碰 GDP：贷款本金与还款本金都不是收入，只有银行利息收入进入银行统计。

import type { WorldState, LogEntry } from '../contracts/types';
import type { DemoConfig } from '../../data/config';
import { round2 } from '../core/math';
import {
  serviceCompanyLoans,
  servicePlayerLoans,
  settleDepositInterest,
} from './banking';

/**
 * 组合式月度银行结算：
 * 存款计息 → 每个企业的到期贷款服务 → 玩家个人贷款服务 → 汇总银行存量指标。
 *
 * 注意：三段函数本身已按发生额累加 `banking.lastMonth` 的流量字段
 * （interestExpense / interestIncome / principalRepaid / newDefaults）。
 * 这里只补 tick、depositsTotal、loansOutstanding 与说明文案，不重复累加，避免双计。
 */
export function settleBankMonth(
  world: WorldState,
  config: DemoConfig,
  tick: number,
  logs: LogEntry[],
): void {
  const banking = world.banking;
  if (!banking) return;

  settleDepositInterest(world, config, tick, logs);
  for (const company of [...world.companies].sort((a, b) => a.id.localeCompare(b.id))) {
    serviceCompanyLoans(world, company, config, tick, logs);
  }
  servicePlayerLoans(world, config, tick, logs);

  banking.lastMonth.tick = tick;
  banking.lastMonth.depositsTotal = round2(
    banking.deposits.reduce((total, account) => total + account.balance, 0),
  );
  banking.lastMonth.loansOutstanding = round2(
    banking.loans
      .filter((loan) => loan.status !== 'repaid')
      .reduce((total, loan) => total + loan.outstanding, 0),
  );
  banking.lastMonth.note = `tick ${tick} 银行结算：存款利息支出 ${banking.lastMonth.interestExpense.toFixed(2)}，贷款利息收入 ${banking.lastMonth.interestIncome.toFixed(2)}，收回本金 ${banking.lastMonth.principalRepaid.toFixed(2)}，违约 ${banking.lastMonth.newDefaults} 笔。`;
}
