// 独立银行系统的模块内契约类型。
// 权威类型（BankOwner / DepositAccount / LoanContract / CreditSnapshot / BankingState 等）
// 定义在 ../contracts/types.ts；这里只放银行模块自己的输入/输出结构，避免把实现细节塞进共享契约。

import type { ActionResult, BankOwner, LoanContract, LoanPurpose } from '../contracts/types';

/**
 * 一次授信评估的结果。
 *
 * 口径（用户已确定，刻意保守）：
 * - baseValue 是授信基准：个人 = 可核验净资产；企业 = 非负账面股权价值。
 * - limit = max(0, baseValue) × config.banking.creditLimitRate（首版 50%）。
 * - outstanding = 该主体当前全部未偿贷款本金（不含已结清）。
 * - available = max(0, limit − outstanding)，实时计算，不缓存。
 *
 * 注意这是“双重约束”而不是“两次扣同一笔债务”：
 * 企业基准已经减去企业债务（约束资产规模），额度再减去已用未偿（约束剩余可借），
 * 分别限制“能借多少”和“已经借了多少”，是刻意保守的设计。
 */
export interface CreditEvaluation {
  baseValue: number;
  limit: number;
  outstanding: number;
  available: number;
  method: 'netWorth' | 'equityBook';
  reason: string;
}

/** 贷款申请：由玩家命令、经营提案或企业流动性兜底调用。 */
export interface LoanRequest {
  owner: BankOwner;
  purpose: LoanPurpose;
  amount: number;
}

/** openLoan 的统一返回：失败时只有 ok/error；成功时带上新建合同。 */
export type LoanOpenResult = ActionResult & { loan?: LoanContract };
