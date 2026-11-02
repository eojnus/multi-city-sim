// 验收问题 2：玩家经营企业的自动融资必须走同一套模式/授权/提案约束，
// 任何调用路径（发薪、生产采购、跨城进口）都不得绕过；AI 企业保持既有自动融资。
import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation/core/simulation';
import { DEMO_CONFIG } from '../src/data/config';
import type { Company, LogEntry, PlayerOperationMode, WorldState } from '../src/simulation/contracts/types';
import { round2 } from '../src/simulation/core/math';
import { bankLoansOf } from '../src/simulation/banking/credit';
import { monthlyWageBill, createEmptyInventory } from '../src/simulation/companies/company';
import { runInputPurchasing } from '../src/simulation/production/production';
import { settleCompanyFinance } from '../src/simulation/finance/finance';
import { createWorldLedgers } from '../src/simulation/markets/markets';
import {
  decideProposal,
  playerOperationFor,
  requestAutomaticLoan,
  setAuthorization,
  setOperationMode,
} from '../src/simulation/management/operations';
import { requestCompanyWorkingCapital } from '../src/simulation/management/financing';

function newWorld(): WorldState {
  return Simulation.create().state;
}

function companyOf(world: WorldState, id: string): Company {
  const company = world.companies.find((entry) => entry.id === id);
  if (!company) throw new Error(`测试世界没有企业 ${id}`);
  return company;
}

/** 把玩家设为该企业经营者，并设置经营模式。 */
function operate(world: WorldState, companyId: string, mode: PlayerOperationMode): void {
  const control = world.governance.controls.find((entry) => entry.companyId === companyId);
  if (!control) throw new Error('企业缺少治理控制记录');
  control.operator = { type: 'player', id: 'player' };
  control.basis = 'election';
  control.operatorId = null;
  control.termEndTick = null;
  const result = setOperationMode(world, companyId, mode, DEMO_CONFIG, 0);
  if (!result.ok) throw new Error(result.error);
}

function pendingLoanProposals(world: WorldState, companyId: string) {
  return (playerOperationFor(world, companyId)?.proposals ?? []).filter(
    (proposal) => proposal.kind === 'loan' && proposal.status === 'pending',
  );
}

describe('自动融资的经营模式与授权约束（验收问题 2）', () => {
  it('全面手动模式：不自动举债、不生成提案，现金不足时采购受限', () => {
    const world = newWorld();
    const company = companyOf(world, 'lp-garment');
    operate(world, company.id, 'manual');

    const decision = requestAutomaticLoan(world, DEMO_CONFIG, 0, company, 500_000, '测试');
    expect(decision.allowed).toBe(false);
    expect(decision.proposed).toBe(false);
    expect(decision.reason).toContain('手动');

    const financing = requestCompanyWorkingCapital(
      world,
      DEMO_CONFIG,
      0,
      company,
      500_000,
      '测试',
    );
    expect(financing.drawn).toBe(0);
    expect(company.debt).toBe(0);
    expect(bankLoansOf(world)).toHaveLength(0);
    expect(pendingLoanProposals(world, company.id)).toHaveLength(0);
  });

  it('AI 辅助模式：授权范围内自动放款，超出重大事项阈值则只生成待批准提案', () => {
    const world = newWorld();
    const company = companyOf(world, 'lp-garment');
    operate(world, company.id, 'assisted');

    // 低于 majorThresholds.loanAmount（200000）：授权范围内自动借款。
    const small = requestCompanyWorkingCapital(world, DEMO_CONFIG, 0, company, 50_000, '工资');
    expect(small.drawn).toBe(50_000);
    expect(company.debt).toBe(50_000);

    // 超过阈值：批准前不得放款，只生成提案。
    const debtBefore = company.debt;
    const creditBefore = bankLoansOf(world).length;
    const large = requestAutomaticLoan(world, DEMO_CONFIG, 0, company, 250_000, '采购');
    expect(large.allowed).toBe(false);
    expect(large.proposed).toBe(true);
    expect(company.debt).toBe(debtBefore);
    expect(bankLoansOf(world).length).toBe(creditBefore);
    const proposals = pendingLoanProposals(world, company.id);
    expect(proposals).toHaveLength(1);

    // 批准后才真正放款。
    const approve = decideProposal(world, proposals[0]!.id, true, DEMO_CONFIG, 0);
    expect(approve.ok, approve.error).toBe(true);
    expect(company.debt).toBe(round2(debtBefore + 250_000));
    expect(bankLoansOf(world).length).toBe(creditBefore + 1);
  });

  it('高度托管模式：按授权额度自动放款，超过授权额度需玩家批准', () => {
    const world = newWorld();
    const company = companyOf(world, 'lp-garment');
    operate(world, company.id, 'delegated');

    // 默认授权 maxLoanAmount = 300000：250000 可自动执行。
    const within = requestCompanyWorkingCapital(world, DEMO_CONFIG, 0, company, 250_000, '扩张');
    expect(within.drawn).toBe(250_000);
    expect(company.debt).toBe(250_000);

    // 收紧授权后，同样金额转为提案。
    expect(setAuthorization(world, company.id, { maxLoanAmount: 100_000 }, DEMO_CONFIG).ok).toBe(
      true,
    );
    const over = requestAutomaticLoan(world, DEMO_CONFIG, 0, company, 250_000, '扩张');
    expect(over.allowed).toBe(false);
    expect(over.proposed).toBe(true);
    expect(company.debt).toBe(250_000);
    expect(pendingLoanProposals(world, company.id)).toHaveLength(1);
  });

  it('关闭贷款授权后不自动借款、也不绕过授权生成提案', () => {
    const world = newWorld();
    const company = companyOf(world, 'lp-garment');
    operate(world, company.id, 'assisted');
    expect(setAuthorization(world, company.id, { allowLoan: false }, DEMO_CONFIG).ok).toBe(true);

    const decision = requestAutomaticLoan(world, DEMO_CONFIG, 0, company, 50_000, '工资');
    expect(decision.allowed).toBe(false);
    expect(decision.proposed).toBe(false);
    expect(decision.reason).toContain('授权未开启');
    expect(company.debt).toBe(0);
    expect(pendingLoanProposals(world, company.id)).toHaveLength(0);
  });

  it('拒绝贷款提案后，冷却期内任何路径都不得自动借回', () => {
    const world = newWorld();
    const company = companyOf(world, 'lp-garment');
    operate(world, company.id, 'assisted');

    const large = requestAutomaticLoan(world, DEMO_CONFIG, 0, company, 250_000, '采购');
    expect(large.proposed).toBe(true);
    const [proposal] = pendingLoanProposals(world, company.id);
    expect(decideProposal(world, proposal!.id, false, DEMO_CONFIG, 0).ok).toBe(true);

    const blocked = requestCompanyWorkingCapital(world, DEMO_CONFIG, 1, company, 50_000, '工资');
    expect(blocked.drawn).toBe(0);
    expect(blocked.reason).toContain('拒绝');
    expect(company.debt).toBe(0);
    expect(bankLoansOf(world)).toHaveLength(0);

    // 冷却期（3 个月）过后恢复授权内自动融资。
    const afterCooldown = requestCompanyWorkingCapital(
      world,
      DEMO_CONFIG,
      3,
      company,
      50_000,
      '工资',
    );
    expect(afterCooldown.drawn).toBe(50_000);
  });

  it('非玩家经营的企业（AI）仍可在授信额度内自动融资', () => {
    const world = newWorld();
    const company = companyOf(world, 'lp-garment');
    const decision = requestAutomaticLoan(world, DEMO_CONFIG, 0, company, 120_000, 'AI 决策');
    expect(decision.allowed).toBe(true);
    const drawn = requestCompanyWorkingCapital(world, DEMO_CONFIG, 0, company, 120_000, 'AI 决策');
    expect(drawn.drawn).toBe(120_000);
    expect(company.debt).toBe(120_000);
  });

  it('发薪路径（settleCompanyFinance）在手动模式下不暗中举债', () => {
    const world = newWorld();
    const company = companyOf(world, 'lp-garment');
    operate(world, company.id, 'manual');
    company.cash = 0;
    company.debt = 0;
    const logs: LogEntry[] = [];
    settleCompanyFinance(world, DEMO_CONFIG, logs);
    expect(company.debt).toBe(0);
    expect(bankLoansOf(world)).toHaveLength(0);
    expect(logs.some((entry) => entry.message.includes('工资资金不足'))).toBe(true);
  });

  it('生产采购路径在手动模式下不暗中举债，并说明采购受限', () => {
    const world = newWorld();
    const buyer = companyOf(world, 'lp-food');
    const seller = companyOf(world, 'lp-energy');
    operate(world, buyer.id, 'manual');
    for (const company of world.companies) {
      company.utilization = 0;
      company.inventory = createEmptyInventory();
    }
    buyer.utilization = DEMO_CONFIG.company.initialUtilization;
    const wage = monthlyWageBill(buyer, DEMO_CONFIG);
    buyer.cash = round2(wage * 0.6);
    buyer.debt = 0;
    seller.inventory.energy = 1_000_000;
    const logs: LogEntry[] = [];
    runInputPurchasing(world, createWorldLedgers(world), DEMO_CONFIG, logs);
    expect(buyer.debt).toBe(0);
    expect(bankLoansOf(world)).toHaveLength(0);
    expect(logs.some((entry) => entry.message.includes('手动'))).toBe(true);
  });
});
