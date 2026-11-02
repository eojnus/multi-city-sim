// 企业融资的统一入口：区分“玩家命令”与“系统自动决策”。
//
// 验收问题 1：玩家不能以无经营权企业的名义借款/还款（持股不等于经营权）。
// 验收问题 2：玩家经营企业的所有自动借款路径（发薪补流动性、生产采购、跨城进口）
//             都必须先经过经营模式与授权裁决，未获授权不得先借后报。
//
// 银行内部（banking.ts）仍保留不带权限的放款原语：AI 企业与非玩家经营企业照旧使用，
// 权限校验只加在玩家命令入口与“玩家经营企业”的自动融资入口，避免破坏 AI 企业运行。

import type {
  ActionResult,
  BankOwner,
  Company,
  LoanPurpose,
  WorldState,
} from '../contracts/types';
import type { DemoConfig } from '../../data/config';
import { round2 } from '../core/math';
import type { LoanOpenResult, LoanRequest } from '../banking/types';
import { drawWorkingCapital, openLoan, repayLoan } from '../banking/banking';
import { availableCredit } from '../banking/credit';
import { canOperate, requestAutomaticLoan } from './operations';

export interface CompanyFinancingResult {
  /** 实际借入金额（0 表示未融资）。 */
  drawn: number;
  /** true 表示因权限/模式/授权/额度被拒绝，调用方应按现金不足处理。 */
  denied: boolean;
  /** 给玩家/日志的原因说明。 */
  reason: string;
  /** 是否生成了待玩家批准的贷款提案。 */
  proposed: boolean;
}

/**
 * 玩家经营企业自动融资的唯一入口。
 * 先裁决（模式/授权/拒绝冷却/额度），通过后才放款；每笔生成独立合同（见 banking）。
 */
export function requestCompanyWorkingCapital(
  world: WorldState,
  config: DemoConfig,
  tick: number,
  company: Company,
  desiredAmount: number,
  cause: string,
): CompanyFinancingResult {
  const desired = round2(Math.max(0, desiredAmount));
  if (!(desired > 0)) return { drawn: 0, denied: false, reason: '', proposed: false };
  const decision = requestAutomaticLoan(world, config, tick, company, desired, cause);
  if (!decision.allowed) {
    return { drawn: 0, denied: true, reason: decision.reason, proposed: decision.proposed };
  }
  const credit = round2(
    Math.max(0, availableCredit(world, { kind: 'company', id: company.id }, config)),
  );
  const amount = round2(Math.min(desired, decision.limit, credit));
  if (!(amount > 0)) {
    return { drawn: 0, denied: true, reason: `银行可借额度不足（${cause}）。`, proposed: false };
  }
  const drawn = drawWorkingCapital(world, company, amount, config, tick);
  if (drawn <= 0) {
    return { drawn: 0, denied: true, reason: `放款失败（${cause}）。`, proposed: false };
  }
  return { drawn, denied: false, reason: decision.reason, proposed: false };
}

/**
 * 只裁决、不放款：用于“先授权与资金检查、后成交”的采购/进口路径。
 * 返回本次可自动使用的融资上限（已按实时授信额度收敛）；denied=true 时上限为 0。
 */
export function planCompanyWorkingCapital(
  world: WorldState,
  config: DemoConfig,
  tick: number,
  company: Company,
  desiredAmount: number,
  cause: string,
): { limit: number; denied: boolean; reason: string; proposed: boolean } {
  const decision = requestAutomaticLoan(world, config, tick, company, desiredAmount, cause);
  if (!decision.allowed) {
    return { limit: 0, denied: true, reason: decision.reason, proposed: decision.proposed };
  }
  const credit = round2(
    Math.max(0, availableCredit(world, { kind: 'company', id: company.id }, config)),
  );
  return {
    limit: round2(Math.min(decision.limit, credit)),
    denied: false,
    reason: decision.reason,
    proposed: false,
  };
}

/** 在已裁决的额度内放款（每笔独立合同）；返回实际借入金额。 */
export function drawPlannedWorkingCapital(
  world: WorldState,
  config: DemoConfig,
  tick: number,
  company: Company,
  amount: number,
): number {
  return drawWorkingCapital(world, company, amount, config, tick);
}

/**
 * 玩家命令：申请贷款。
 * - 个人贷款只允许玩家本人；
 * - 企业贷款需要玩家具备该企业的经营权（control.operator 指向玩家），持股本身不赋予经营权；
 * - 需要股东/董事会表决的融资事项仍由治理流程处理（本入口不绕过任何既有议案）。
 */
export function playerOpenLoan(
  world: WorldState,
  config: DemoConfig,
  tick: number,
  owner: BankOwner,
  purpose: LoanPurpose,
  amount: number,
): LoanOpenResult {
  if (purpose === 'personal') {
    if (owner.kind !== 'player') {
      return { ok: false, error: '个人贷款只能由玩家本人申请' };
    }
  } else if (purpose === 'workingCapital' || purpose === 'expansion') {
    if (owner.kind !== 'company') {
      return { ok: false, error: '企业贷款只能以企业名义申请' };
    }
    if (!canOperate(world, owner.id)) {
      return {
        ok: false,
        error: '没有该企业的经营权：不能以企业名义申请贷款（持有股票不等于经营权）',
      };
    }
  } else {
    return { ok: false, error: '该贷款用途不能由玩家发起' };
  }
  const request: LoanRequest = { owner, purpose, amount };
  const result = openLoan(world, request, config, tick);
  // 来源标记：供审计/报告区分“玩家指令”与系统/AI 自动借款。
  if (result.ok && result.loan) result.loan.note = `${result.loan.note}（来源：玩家指令）`;
  return result;
}

/**
 * 玩家命令：提前还款。
 * - 玩家个人贷款：本人可还；
 * - 企业贷款：需要该企业的经营权；
 * - 其他主体（投资实体等）的贷款不支持玩家代还。
 */
export function playerRepayBankLoan(
  world: WorldState,
  loanId: string,
  amount: number,
  config: DemoConfig,
  tick: number,
): ActionResult {
  const loan = world.banking?.loans.find((entry) => entry.id === loanId);
  if (!loan) return { ok: false, error: '贷款合同不存在' };
  if (loan.borrower.kind === 'company') {
    if (!canOperate(world, loan.borrower.id)) {
      return {
        ok: false,
        error: '没有该企业的经营权：不能替该企业偿还贷款（持有股票不等于经营权）',
      };
    }
  } else if (loan.borrower.kind !== 'player') {
    return { ok: false, error: '该贷款主体不支持玩家操作' };
  }
  return repayLoan(world, loanId, amount, config, tick);
}
