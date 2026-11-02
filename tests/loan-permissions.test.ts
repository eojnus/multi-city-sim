// 验收问题 1：玩家只能对自己有经营权的企业借款/还款；个人借还正常；
// 越权失败必须零部分变化；银行内部 AI 企业融资不受影响（不破坏 AI 运行）。
import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation/core/simulation';
import { DEMO_CONFIG } from '../src/data/config';
import type { BankOwner, Company, CompanyControl, WorldState } from '../src/simulation/contracts/types';
import { openLoan } from '../src/simulation/banking/banking';
import { bankLoansOf, availableCredit } from '../src/simulation/banking/credit';
import { drawWorkingCapital } from '../src/simulation/banking/banking';
import {
  playerOpenLoan,
  playerRepayBankLoan,
} from '../src/simulation/management/financing';
import { canOperate } from '../src/simulation/management/operations';

function newWorld(): WorldState {
  return Simulation.create().state;
}

function firstCompany(world: WorldState): Company {
  const company = world.companies[0];
  if (!company) throw new Error('测试世界没有企业');
  return company;
}

function controlOf(world: WorldState, companyId: string): CompanyControl {
  const control = world.governance.controls.find((entry) => entry.companyId === companyId);
  if (!control) throw new Error('企业缺少治理控制记录');
  return control;
}

/** 把玩家设为该企业经营者（模拟议案通过后的控制权）。 */
function grantOperator(world: WorldState, companyId: string): void {
  const control = controlOf(world, companyId);
  control.operator = { type: 'player', id: 'player' };
  control.basis = 'election';
  control.operatorId = null;
  control.termEndTick = null;
}

describe('玩家贷款权限（验收问题 1）', () => {
  it('新世界里玩家默认不是任何企业经营者，不能替企业借款', () => {
    const world = newWorld();
    const company = firstCompany(world);
    expect(canOperate(world, company.id)).toBe(false);

    const before = JSON.stringify(world);
    const result = playerOpenLoan(
      world,
      DEMO_CONFIG,
      world.time.tick,
      { kind: 'company', id: company.id },
      'workingCapital',
      1000,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('经营权');
    // 越权失败：现金、贷款合同、企业债务零变化。
    expect(JSON.stringify(world)).toBe(before);
    expect(company.debt).toBe(0);
    expect(bankLoansOf(world).length).toBe(0);
  });

  it('无经营权时不能替该企业提前还款，状态零变化', () => {
    const world = newWorld();
    const company = firstCompany(world);
    // 银行内部（AI 决策）放款不受玩家权限限制：模拟已有企业贷款。
    const loan = openLoan(
      world,
      { owner: { kind: 'company', id: company.id }, purpose: 'workingCapital', amount: 1000 },
      DEMO_CONFIG,
      world.time.tick,
    );
    expect(loan.ok).toBe(true);
    const loanId = loan.loan?.id;
    expect(loanId).toBeTruthy();
    expect(company.debt).toBeGreaterThan(0);

    const before = JSON.stringify(world);
    const result = playerRepayBankLoan(world, loanId!, 100, DEMO_CONFIG, world.time.tick);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('经营权');
    expect(JSON.stringify(world)).toBe(before);
  });

  it('获得经营权后可以以企业名义借款与还款', () => {
    const world = newWorld();
    const company = firstCompany(world);
    grantOperator(world, company.id);
    expect(canOperate(world, company.id)).toBe(true);

    const cashBefore = company.cash;
    const debtBefore = company.debt;
    const result = playerOpenLoan(
      world,
      DEMO_CONFIG,
      world.time.tick,
      { kind: 'company', id: company.id },
      'workingCapital',
      1000,
    );
    expect(result.ok).toBe(true);
    expect(company.cash).toBe(cashBefore + 1000);
    expect(company.debt).toBe(debtBefore + 1000);

    const repay = playerRepayBankLoan(
      world,
      result.loan!.id,
      500,
      DEMO_CONFIG,
      world.time.tick,
    );
    expect(repay.ok).toBe(true);
    expect(company.cash).toBeLessThan(cashBefore + 1000);
    expect(company.debt).toBeLessThan(debtBefore + 1000);
  });

  it('玩家个人贷款与还款不受企业经营权限制', () => {
    const world = newWorld();
    const player: BankOwner = { kind: 'player', id: 'player' };
    const cashBefore = world.player.cash;
    // 个人贷款受 minLoanAmount（10000）约束。
    const loan = playerOpenLoan(world, DEMO_CONFIG, world.time.tick, player, 'personal', 10000);
    expect(loan.ok).toBe(true);
    expect(world.player.cash).toBe(cashBefore + 10000);

    const repay = playerRepayBankLoan(world, loan.loan!.id, 4000, DEMO_CONFIG, world.time.tick);
    expect(repay.ok).toBe(true);
    expect(world.player.cash).toBeCloseTo(cashBefore + 6000, 2);
  });

  it('银行内部 AI 企业融资仍可工作（不经过玩家权限）', () => {
    const world = newWorld();
    const company = firstCompany(world);
    expect(canOperate(world, company.id)).toBe(false);
    const available = availableCredit(world, { kind: 'company', id: company.id }, DEMO_CONFIG);
    expect(available).toBeGreaterThan(0);
    const drawn = drawWorkingCapital(world, company, Math.min(500, available), DEMO_CONFIG, world.time.tick);
    expect(drawn).toBeGreaterThan(0);
    expect(company.debt).toBe(drawn);
    expect(bankLoansOf(world).length).toBe(1);
  });

  it('个人用途不能伪装成企业贷款，企业用途不能挂在个人名下', () => {
    const world = newWorld();
    const company = firstCompany(world);
    grantOperator(world, company.id);
    const personalAsCompany = playerOpenLoan(
      world,
      DEMO_CONFIG,
      world.time.tick,
      { kind: 'company', id: company.id },
      'personal',
      1000,
    );
    expect(personalAsCompany.ok).toBe(false);

    const companyAsPlayer = playerOpenLoan(
      world,
      DEMO_CONFIG,
      world.time.tick,
      { kind: 'player', id: 'player' },
      'workingCapital',
      1000,
    );
    expect(companyAsPlayer.ok).toBe(false);
  });
});
