import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation/core/simulation';
import { DEMO_CONFIG, type DemoConfig } from '../src/data/config';
import type { BondHolder, WorldState } from '../src/simulation/contracts/types';
import { checkInvariants } from '../src/simulation/core/invariants';
import { parseSave, serializeSave } from '../src/simulation/core/save';
import {
  closeGovernmentBondSubscription,
  issueGovernmentBond,
  payBondCoupon,
  subscribeGovernmentBond,
} from '../src/simulation/government/bonds';
import {
  borrowForGovernment,
  buildGovernmentPayables,
  distributeBankruptGovernmentShares,
  governmentLoanAccrual,
  payGovernmentPayables,
  settleCityGovernmentDebt,
  settleGovernmentDebt,
} from '../src/simulation/government/debt';
import {
  companyHolders,
  createShareStructure,
  holderKey,
} from '../src/simulation/securities/securities';

const CONFIG = DEMO_CONFIG;
const NO_AI = {
  ...CONFIG,
  government: {
    ...CONFIG.government,
    aiGovernment: { ...CONFIG.government.aiGovernment, enabled: false },
  },
} as unknown as DemoConfig;
const PLAYER: BondHolder = { kind: 'player', id: 'player' };

function newWorld(): WorldState {
  return Simulation.create().state;
}

function mainCity(world: WorldState) {
  const city = world.cities[0];
  if (!city) throw new Error('缺少城市');
  return city;
}

/** 把判定窗口压到 12×monthly，方便在少量债务下触发破产（≥100%）。 */
function shrinkGdp(world: WorldState, monthly = 100): void {
  const city = mainCity(world);
  city.gdpWindow = Array.from({ length: 12 }, (_, index) => ({
    tick: -12 + index,
    value: monthly,
    estimated: true,
  }));
}

function sellIssue(world: WorldState, tick = 0, units = 10) {
  const city = mainCity(world);
  world.time.tick = tick;
  world.player.cash = units * 1_000;
  const issued = issueGovernmentBond(world, city, CONFIG, units, tick);
  if (!issued.ok || !issued.issuance) throw new Error(issued.error ?? '发行失败');
  const bought = subscribeGovernmentBond(world, CONFIG, issued.issuance.id, PLAYER, units, tick);
  if (!bought.ok) throw new Error(bought.error ?? '认购失败');
  closeGovernmentBondSubscription(world, CONFIG, issued.issuance.id, tick);
  return { city, issuance: issued.issuance };
}

function holdingOf(world: WorldState, issuanceId: string) {
  const holding = (world.bonds?.holdings ?? []).find((entry) => entry.issuanceId === issuanceId);
  if (!holding) throw new Error('缺少持债记录');
  return holding;
}

function paymentsOf(world: WorldState, issuanceId: string) {
  return (world.bonds?.payments ?? []).filter((payment) => payment.issuanceId === issuanceId);
}

describe('政府贷款计息', () => {
  it('按剩余未偿本金逐月计息，纯函数可重复调用', () => {
    const world = newWorld();
    const city = mainCity(world);
    const borrowed = borrowForGovernment(world, city, CONFIG, 12_000, 0, []);
    expect(borrowed.ok).toBe(true);
    const loan = borrowed.loan!;
    expect(loan.monthlyPrincipal).toBeCloseTo(500, 2);

    expect(governmentLoanAccrual(loan, 0)).toMatchObject({
      elapsedMonths: 0,
      cumulativeInterest: 0,
      unpaidInterest: 0,
    });
    const first = governmentLoanAccrual(loan, 1);
    expect(first.elapsedMonths).toBe(1);
    expect(first.currentMonthInterest).toBeCloseTo(60, 2);
    const second = governmentLoanAccrual(loan, 2);
    expect(second.elapsedMonths).toBe(2);
    expect(second.cumulativeInterest).toBeCloseTo(117.5, 2);
    expect(second.currentMonthInterest).toBeCloseTo(57.5, 2);
    expect(governmentLoanAccrual(loan, 2)).toEqual(second);
  });
});

describe('月结：票息与到期垫付', () => {
  it('第 12 个月按时从财政支付票息，账本与持债同步清零', () => {
    const world = newWorld();
    const treasuryBefore = mainCity(world).treasury;
    const { city, issuance } = sellIssue(world, 0);
    const holding = holdingOf(world, issuance.id);
    expect(city.treasury).toBeCloseTo(treasuryBefore + 10_000, 2);

    world.time.tick = 12;
    settleCityGovernmentDebt(world, city, NO_AI, []);

    const coupons = paymentsOf(world, issuance.id).filter((payment) => payment.kind === 'coupon');
    expect(coupons).toHaveLength(1);
    expect(coupons[0]).toMatchObject({ holder: PLAYER, principalPaid: 0, interestPaid: 400 });
    expect(coupons[0]?.holdingId).toBe(holding.id);
    expect(holding.accruedInterest).toBeCloseTo(0, 2);
    expect(issuance.couponsPaid).toBe(1);
    expect(city.treasury).toBeCloseTo(treasuryBefore + 9_600, 2);
    const payable = city.government!.payables.find((entry) => entry.kind === 'bondCoupon');
    expect(payable?.status).toBe('paid');
  });

  it('财政不足时票息只记欠付，不向银行垫付', () => {
    const world = newWorld();
    const { city, issuance } = sellIssue(world, 0);
    city.treasury = 0;

    world.time.tick = 12;
    settleCityGovernmentDebt(world, city, NO_AI, []);

    expect(paymentsOf(world, issuance.id)).toHaveLength(0);
    expect(city.government!.loans).toHaveLength(0);
    expect(city.government!.advances).toHaveLength(0);
    const holding = holdingOf(world, issuance.id);
    expect(holding.accruedInterest).toBeCloseTo(400, 2);
    expect(issuance.arrearsInterest).toBeCloseTo(400, 2);
    expect(issuance.couponsPaid).toBe(0);
    const payable = city.government!.payables.find((entry) => entry.kind === 'bondCoupon');
    expect(payable?.status).toBe('arrears');
  });

  it('第 36 个月到期本息由银行垫付，形成 bondAdvance 贷款且只记一次', () => {
    const world = newWorld();
    const { city, issuance } = sellIssue(world, 0);
    city.treasury = 0;

    world.time.tick = 36;
    settleCityGovernmentDebt(world, city, NO_AI, []);

    const advance = city.government!.advances[0];
    expect(advance).toBeDefined();
    expect(advance).toMatchObject({ purpose: 'maturity', tick: 36 });
    expect(advance!.totalAdvanced).toBeCloseTo(11_200, 2);
    expect(advance!.principalAdvanced).toBeCloseTo(10_000, 2);
    expect(advance!.interestAdvanced).toBeCloseTo(1_200, 2);

    const bondAdvanceLoans = city.government!.loans.filter(
      (loan) => loan.purpose === 'bondAdvance',
    );
    expect(bondAdvanceLoans).toHaveLength(1);
    expect(bondAdvanceLoans[0]?.principal).toBeCloseTo(11_200, 2);
    expect(issuance.status).toBe('redeemed');
    expect(issuance.bankAdvancedAmount).toBeCloseTo(11_200, 2);
    for (const payment of paymentsOf(world, issuance.id)) {
      expect(payment.fundedByBankAdvance).toBe(true);
      expect(payment.kind).toBe('principal');
    }
    expect(holdingOf(world, issuance.id).status).toBe('redeemed');
  });

  it('同 tick 重复结算不产生重复付款流水（幂等键 issuanceId+holdingId+tick+kind）', () => {
    const world = newWorld();
    const { city, issuance } = sellIssue(world, 0);
    city.treasury = 0;

    world.time.tick = 36;
    settleCityGovernmentDebt(world, city, NO_AI, []);
    const firstKeys = paymentsOf(world, issuance.id).map(
      (payment) => `${payment.issuanceId}|${payment.holdingId}|${payment.tick}|${payment.kind}`,
    );
    expect(firstKeys.length).toBeGreaterThan(0);
    expect(new Set(firstKeys).size).toBe(firstKeys.length);

    // 模拟崩溃后同 tick 重试：清掉结算水位再结算一次。
    city.government!.settledTicks = city.government!.settledTicks.filter((tick) => tick !== 36);
    settleCityGovernmentDebt(world, city, NO_AI, []);
    const secondKeys = paymentsOf(world, issuance.id).map(
      (payment) => `${payment.issuanceId}|${payment.holdingId}|${payment.tick}|${payment.kind}`,
    );
    expect(secondKeys).toEqual(firstKeys);
    expect(city.government!.loans.filter((loan) => loan.purpose === 'bondAdvance')).toHaveLength(1);
  });
});

describe('debt：政府应付项计数与贷款分期结清', () => {
  it('debt：payablesPaid 为笔数且同 tick 重复结算不重复计数（票息场景）', () => {
    const world = newWorld();
    const { city, issuance } = sellIssue(world, 0);
    expect(issuance.cityId).toBe(city.id);

    world.time.tick = 12;
    const first = settleCityGovernmentDebt(world, city, NO_AI, []);
    expect(first.payablesCreated).toBe(1);
    expect(first.payablesPaid).toBe(1);
    expect(first.payablesInArrears).toBe(0);

    city.government!.settledTicks = city.government!.settledTicks.filter((tick) => tick !== 12);
    const second = settleCityGovernmentDebt(world, city, NO_AI, []);
    expect(second.payablesCreated).toBe(0);
    expect(second.payablesPaid).toBe(0);
    expect(second.payablesInArrears).toBe(0);
  });

  it('debt：同 tick 重复调用 payGovernmentPayables 不重复加计数', () => {
    const world = newWorld();
    const { city } = sellIssue(world, 0);
    city.treasury = 5_000;

    world.time.tick = 12;
    const payables = buildGovernmentPayables(world, city, CONFIG, 12);
    expect(payables).toHaveLength(1);

    const first = payGovernmentPayables(world, city, CONFIG, payables, 12, []);
    expect(first.paid).toBe(1);
    expect(first.inArrears).toBe(0);

    const second = payGovernmentPayables(world, city, CONFIG, payables, 12, []);
    expect(second.paid).toBe(0);
    expect(second.inArrears).toBe(0);
  });

  it('debt：M36 到期两笔应付项（票息 + 本金）各计 1 次，不按付款流水重复累加', () => {
    const world = newWorld();
    const { city } = sellIssue(world, 0);
    city.treasury = 0;

    world.time.tick = 36;
    const result = settleCityGovernmentDebt(world, city, NO_AI, []);
    expect(result.payablesCreated).toBe(2);
    expect(result.payablesPaid).toBe(2);
    expect(result.payablesInArrears).toBe(0);
  });

  it('debt：贷款分期财政不足时应付项转 arrears 且 payablesInArrears 计 1 笔', () => {
    const world = newWorld();
    const city = mainCity(world);
    city.treasury = 0;
    expect(borrowForGovernment(world, city, CONFIG, 12_000, 0, []).ok).toBe(true);
    city.treasury = 0;

    world.time.tick = 1;
    const result = settleCityGovernmentDebt(world, city, NO_AI, []);

    const instalment = city.government!.payables.find((entry) => entry.kind === 'loanInstalment');
    expect(instalment).toBeDefined();
    expect(instalment!.status).toBe('arrears');
    expect(instalment!.paidTick).toBe(1);
    expect(result.payablesInArrears).toBe(1);
  });

  it('debt：贷款分期按时还清时应付项转 paid 且 payablesPaid 计 1 笔', () => {
    const world = newWorld();
    const city = mainCity(world);
    city.treasury = 0;
    expect(borrowForGovernment(world, city, CONFIG, 12_000, 0, []).ok).toBe(true);

    world.time.tick = 1;
    const result = settleCityGovernmentDebt(world, city, NO_AI, []);

    const instalment = city.government!.payables.find((entry) => entry.kind === 'loanInstalment');
    expect(instalment!.status).toBe('paid');
    expect(result.payablesPaid).toBe(1);
  });
});

describe('破产判定、清算与股份转移', () => {
  it('总负债≥12 月 GDP 的 100% 时当月破产：垫付兑付、债务勾销、当月重选', () => {
    const world = newWorld();
    const city = mainCity(world);
    shrinkGdp(world, 100);
    city.treasury = 0;
    const borrowed = borrowForGovernment(world, city, CONFIG, 2_000, 0, []);
    expect(borrowed.ok).toBe(true);

    world.time.tick = 1;
    settleCityGovernmentDebt(world, city, NO_AI, []);

    const government = city.government!;
    expect(government.bankruptcy.status).toBe('bankrupt');
    expect(government.bankruptcy.tick).toBe(1);
    expect(government.lastDebt!.debtRatio).toBeLessThan(CONFIG.government.fiscalRisk.bankruptAt);
    expect(government.lastDebt!.totalDebt).toBeCloseTo(0, 2);

    const record = government.records[0]!;
    expect(record).toMatchObject({ tick: 1, cityId: city.id });
    expect(record.totalDebtAtJudgement).toBeGreaterThan(0);
    expect(record.debtRatio).toBeGreaterThanOrEqual(1);
    expect(record.bankLoansWrittenOff).toBeGreaterThan(0);
    expect(record.bankAdvanceCreated).toBe(0);
    expect(record.electionTriggeredTick === 1 || record.caretakerUntilElection).toBeTruthy();

    // 贷款核销后未偿清零、状态 writtenOff（不变量要求 outstanding=principal−paidPrincipal）。
    for (const loan of government.loans) {
      expect(loan.status).toBe('writtenOff');
      expect(loan.outstanding).toBeCloseTo(0, 2);
      expect(loan.paidPrincipal).toBeCloseTo(loan.principal, 2);
    }
    expect(city.bankruptcy?.status).toBe('bankrupt');
    expect(city.bankruptcy?.recordId).toBe(record.id);
  });

  it('同 tick 只判一次破产，重复结算不追加 record', () => {
    const world = newWorld();
    const city = mainCity(world);
    shrinkGdp(world, 100);
    city.treasury = 0;
    borrowForGovernment(world, city, CONFIG, 2_000, 0, []);

    world.time.tick = 1;
    settleCityGovernmentDebt(world, city, NO_AI, []);
    const recordCount = city.government!.records.length;
    city.government!.settledTicks = city.government!.settledTicks.filter((tick) => tick !== 1);
    settleCityGovernmentDebt(world, city, NO_AI, []);
    expect(city.government!.records.length).toBe(recordCount);
  });

  it('破产股份：无 CEO 时按除政府外股东主体平分', () => {
    const world = newWorld();
    const city = mainCity(world);
    const company = world.companies[0]!;
    const group = world.investors[0]!;
    createShareStructure(world, company, {
      votingShares: 100,
      nonVotingShares: 0,
      votingHolders: [
        { holder: { type: 'city', id: city.id }, shares: 60 },
        { holder: { type: 'investorGroup', id: group.id }, shares: 40 },
      ],
      tick: 0,
    });

    const result = distributeBankruptGovernmentShares(world, city, CONFIG);
    expect(result.custody).toBe(false);
    const holders = companyHolders(world, company.id);
    expect(holders.find((entry) => entry.holder.type === 'city')).toBeUndefined();
    const groupEntry = holders.find((entry) => holderKey(entry.holder) === `investorGroup:${group.id}`);
    expect(groupEntry?.votingShares).toBeCloseTo(100, 2);
  });

  it('破产股份：现任 CEO 优先，全部转给该经营者', () => {
    const world = newWorld();
    const city = mainCity(world);
    const company = world.companies[0]!;
    const group = world.investors[0]!;
    createShareStructure(world, company, {
      votingShares: 100,
      nonVotingShares: 0,
      votingHolders: [
        { holder: { type: 'city', id: city.id }, shares: 100 },
        { holder: { type: 'player', id: 'player' }, shares: 0 },
      ],
      tick: 0,
    });
    const control = world.governance.controls.find((entry) => entry.companyId === company.id);
    if (!control) throw new Error('缺少经营者记录');
    control.operator = { type: 'investorGroup', id: group.id };

    const result = distributeBankruptGovernmentShares(world, city, CONFIG);
    expect(result.custody).toBe(false);
    const holders = companyHolders(world, company.id);
    const groupEntry = holders.find((entry) => holderKey(entry.holder) === `investorGroup:${group.id}`);
    expect(groupEntry?.votingShares).toBeCloseTo(100, 2);
  });

  it('破产股份：无其他股东时转无表决权托管，不销毁不转给公司', () => {
    const world = newWorld();
    const city = mainCity(world);
    const company = world.companies[0]!;
    createShareStructure(world, company, {
      votingShares: 100,
      nonVotingShares: 0,
      votingHolders: [{ holder: { type: 'city', id: city.id }, shares: 100 }],
      tick: 0,
    });

    const result = distributeBankruptGovernmentShares(world, city, CONFIG);
    expect(result.custody).toBe(true);
    const holders = companyHolders(world, company.id);
    const trust = holders.find((entry) => entry.holder.type === 'trust');
    expect(trust?.holder.id).toBe(`trust-${company.id}`);
    expect(trust?.votingShares).toBeCloseTo(100, 2);
    expect(holders.find((entry) => entry.holder.type === 'city')).toBeUndefined();
  });

  it('破产结算后存档往返保持破产/核销/托管状态', () => {
    const world = newWorld();
    const city = mainCity(world);
    shrinkGdp(world, 100);
    city.treasury = 0;
    borrowForGovernment(world, city, CONFIG, 2_000, 0, []);
    world.time.tick = 1;
    settleCityGovernmentDebt(world, city, NO_AI, []);
    expect(checkInvariants(world).filter((problem) => problem.includes('债') || problem.includes('GDP'))).toEqual([]);

    const parsed = parseSave(serializeSave(world, '2026-11-02T00:00:00.000Z'));
    expect(parsed.ok).toBe(true);
    const restored = parsed.world!.cities[0]!.government!;
    expect(restored.bankruptcy.status).toBe('bankrupt');
    expect(restored.records).toHaveLength(1);
    for (const loan of restored.loans) {
      expect(loan.status).toBe('writtenOff');
      expect(loan.outstanding).toBeCloseTo(0, 2);
    }
  });
});

describe('debt：赤字转贷精确补足', () => {
  it('debt：赤字 3,000 小于单笔最低借款额时，结算后 treasury 归零且贷款本金=3,000', () => {
    const world = newWorld();
    const city = mainCity(world);
    world.time.tick = 1;
    city.treasury = -3_000;

    const result = settleCityGovernmentDebt(world, city, NO_AI, []);
    expect(result.problems).toEqual([]);
    expect(city.treasury).toBeCloseTo(0, 2);
    const loan = city.government.loans.find((entry) => entry.purpose === 'government');
    expect(loan).toBeDefined();
    expect(loan!.principal).toBeCloseTo(3_000, 2);
  });

  it('debt：非结算路径（AI 主动借款）仍受单笔最低借款额约束', () => {
    const world = newWorld();
    const city = mainCity(world);
    const treasuryBefore = city.treasury;

    const result = borrowForGovernment(world, city, CONFIG, 5_000, 0, []);
    expect(result.ok).toBe(true);
    expect(result.loan!.principal).toBeCloseTo(10_000, 2);
    expect(city.treasury).toBeCloseTo(treasuryBefore + 10_000, 2);
  });
});
