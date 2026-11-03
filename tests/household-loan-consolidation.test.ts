// v0.7.1 复验问题 A：居民贷款“拆分碎片合并”不得把不同还款安排的债务并成一笔。
//
// 验收复现：旧贷（M0 发放、24 期，M24 剩 100，当月应还 100）+ 新贷（M20 发放、24 期，
// 剩 2400、月供 100）。旧实现合并后 M24 要求 2500（把新贷拖进旧贷的末期全额结清）。
// 修复口径：只合并开始月、期限、下次还款月、利率、状态完全一致的碎片；每期应还金额、
// 到期日与原合同一致，未偿/欠付利息守恒，转移不记为还款。
import { describe, expect, it } from 'vitest';
import { DEMO_CONFIG } from '../src/data/config';
import { createInitialWorld } from '../src/simulation/core/initializer';
import { round2 } from '../src/simulation/core/math';
import { parseSave, serializeSave } from '../src/simulation/core/save';
import type {
  HouseholdGroup,
  HouseholdLoanContract,
  LoanPayment,
  OccupationClass,
  WorldState,
} from '../src/simulation/contracts/types';
import {
  reallocateHouseholdDebtsForGroupChange,
  repayHouseholdLoans,
  transferHouseholdDebtsForMigration,
} from '../src/simulation/population/household-finance';
import { householdGroupOf } from '../src/simulation/population/household-groups';

const CONFIG = DEMO_CONFIG;
const SPLIT_MARK = '按人均债务分割';
const TOLERANCE = 0.01;

function newWorld(): WorldState {
  return createInitialWorld(CONFIG);
}

function cityIdOf(world: WorldState): string {
  const city = world.cities[0];
  if (!city) throw new Error('缺少城市');
  return city.id;
}

function groupOf(
  world: WorldState,
  cityId: string,
  occupation: OccupationClass = 'production',
): HouseholdGroup {
  const group = householdGroupOf(world, cityId, occupation);
  if (!group) throw new Error(`缺少居民群体 ${cityId}/${occupation}`);
  return group;
}

function loansOf(world: WorldState): HouseholdLoanContract[] {
  return world.householdFinance?.loans ?? [];
}

function liveLoans(world: WorldState): HouseholdLoanContract[] {
  return loansOf(world).filter(
    (loan) => (loan.status === 'active' || loan.status === 'defaulted') && loan.outstanding > 0.005,
  );
}

function sumOutstanding(world: WorldState): number {
  return round2(liveLoans(world).reduce((sum, loan) => sum + loan.outstanding, 0));
}

function payment(tick: number, principalPaid: number, principalDue = principalPaid): LoanPayment {
  return {
    tick,
    principalDue,
    interestDue: 0,
    principalPaid,
    interestPaid: 0,
    arrears: 0,
    note: '',
  };
}

let loanCounter = 0;

function makeLoan(
  group: HouseholdGroup,
  overrides: Partial<HouseholdLoanContract> = {},
): HouseholdLoanContract {
  loanCounter += 1;
  return {
    id: `hhloan-test-${loanCounter}`,
    cityId: group.cityId,
    groupId: group.id,
    purpose: 'consumption',
    principal: 2_400,
    outstanding: 2_400,
    monthlyPrincipal: 100,
    rateMonthly: 0.006,
    termMonths: 24,
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
    note: `测试${SPLIT_MARK}`,
    ...overrides,
  };
}

/** 触发“群体变化”入口（含合并阶段）；targets 与当前人数一致即只做合并。 */
function runAllocation(world: WorldState, cityId: string, targets: ReadonlyMap<OccupationClass, number> = new Map()) {
  return reallocateHouseholdDebtsForGroupChange(world, CONFIG, cityId, targets);
}

function paidAtTick(world: WorldState, tick: number): number {
  return round2(
    loansOf(world).reduce(
      (sum, loan) =>
        sum + loan.payments.filter((entry) => entry.tick === tick).reduce((x, p) => x + p.principalPaid, 0),
      0,
    ),
  );
}

describe('问题A：合并必须保留每笔债务原有还款安排', () => {
  it('复现场景：旧贷 M24 应还 100 + 新贷月供 100，合计 200（修复前错误要求 2500）', () => {
    const world = newWorld();
    const cityId = cityIdOf(world);
    const group = groupOf(world, cityId);
    group.cash = 100_000;

    const oldLoan = makeLoan(group, {
      id: 'hhloan-old',
      startTick: 0,
      termMonths: 24,
      nextDueTick: 24,
      outstanding: 100,
      principal: 2_400,
      monthlyPrincipal: 100,
      paidPrincipal: 2_300,
      payments: Array.from({ length: 23 }, (_, index) => payment(index + 1, 100)),
    });
    const newLoan = makeLoan(group, {
      id: 'hhloan-new',
      startTick: 20,
      termMonths: 24,
      nextDueTick: 24,
      outstanding: 2_400,
      principal: 2_700,
      monthlyPrincipal: 100,
      paidPrincipal: 300,
      payments: [payment(21, 100), payment(22, 100), payment(23, 100)],
    });
    loansOf(world).push(oldLoan, newLoan);

    runAllocation(world, cityId);

    // 开始月/到期安排不同，不得合并：两笔合同都保留各自的开始月与期限。
    expect(liveLoans(world)).toHaveLength(2);
    expect(oldLoan.startTick).toBe(0);
    expect(oldLoan.termMonths).toBe(24);
    expect(newLoan.startTick).toBe(20);
    expect(newLoan.termMonths).toBe(24);

    repayHouseholdLoans(world, CONFIG, 24, []);

    // M24 两笔合计只应还 200：旧贷最后一期结清 100，新贷按第 4/24 期还月供 100。
    expect(paidAtTick(world, 24)).toBeCloseTo(200, 2);
    const oldPayment = oldLoan.payments.find((entry) => entry.tick === 24);
    const newPayment = newLoan.payments.find((entry) => entry.tick === 24);
    expect(oldPayment?.principalDue).toBeCloseTo(100, 2);
    expect(oldPayment?.principalPaid).toBeCloseTo(100, 2);
    expect(newPayment?.principalDue).toBeCloseTo(100, 2);
    expect(newPayment?.principalPaid).toBeCloseTo(100, 2);
    expect(oldLoan.outstanding).toBeCloseTo(0, 2);
    expect(newLoan.outstanding).toBeCloseTo(2_300, 2);
    expect(liveLoans(world)).toHaveLength(1);
  });

  it('还款条件完全相同的碎片仍合并：月供相加、期限/开始月/下次还款月不变', () => {
    const world = newWorld();
    const cityId = cityIdOf(world);
    const group = groupOf(world, cityId);
    group.cash = 10_000;
    const first = makeLoan(group, {
      id: 'hhloan-a',
      startTick: 0,
      termMonths: 24,
      nextDueTick: 5,
      outstanding: 100,
      principal: 100,
      monthlyPrincipal: 10,
      rateMonthly: 0.006,
    });
    const second = makeLoan(group, {
      id: 'hhloan-b',
      startTick: 0,
      termMonths: 24,
      nextDueTick: 5,
      outstanding: 200,
      principal: 200,
      monthlyPrincipal: 20,
      rateMonthly: 0.006,
    });
    loansOf(world).push(first, second);

    runAllocation(world, cityId);

    const fragments = loansOf(world).filter((loan) => loan.note.includes(SPLIT_MARK));
    expect(fragments).toHaveLength(1);
    const merged = fragments[0]!;
    expect(merged.startTick).toBe(0);
    expect(merged.termMonths).toBe(24);
    expect(merged.nextDueTick).toBe(5);
    expect(merged.outstanding).toBeCloseTo(300, 2);
    expect(merged.monthlyPrincipal).toBeCloseTo(30, 2);
    // 合并本身不产生还款记录。
    expect(merged.payments).toHaveLength(0);

    repayHouseholdLoans(world, CONFIG, 5, []);
    const seen = merged.payments.find((entry) => entry.tick === 5)!;
    expect(seen.principalDue).toBeCloseTo(30, 2);
    expect(seen.principalPaid).toBeCloseTo(30, 2);
    expect(merged.outstanding).toBeCloseTo(270, 2);
  });

  it('开始月/期限/利率/逾期状态不同或部分逾期时都不合并，金额与欠款守恒', () => {
    const world = newWorld();
    const cityId = cityIdOf(world);
    const group = groupOf(world, cityId);
    group.cash = 10_000;
    const normal = makeLoan(group, {
      id: 'hhloan-normal',
      outstanding: 100,
      principal: 100,
      monthlyPrincipal: 10,
      arrearsPrincipal: 20,
      nextDueTick: 5,
    });
    const defaulted = makeLoan(group, {
      id: 'hhloan-defaulted',
      outstanding: 200,
      principal: 200,
      monthlyPrincipal: 20,
      rateMonthly: 0.007,
      nextDueTick: 5,
      status: 'defaulted',
    });
    const shortTerm = makeLoan(group, {
      id: 'hhloan-short',
      outstanding: 150,
      principal: 150,
      monthlyPrincipal: 15,
      termMonths: 12,
      nextDueTick: 5,
    });
    loansOf(world).push(normal, defaulted, shortTerm);
    const before = {
      outstanding: sumOutstanding(world),
      arrears: round2(defaulted.arrearsPrincipal + normal.arrearsPrincipal),
      schedules: [normal, defaulted, shortTerm].map((loan) => ({
        id: loan.id,
        startTick: loan.startTick,
        termMonths: loan.termMonths,
        nextDueTick: loan.nextDueTick,
        rateMonthly: loan.rateMonthly,
        status: loan.status,
        monthlyPrincipal: loan.monthlyPrincipal,
      })),
    };

    runAllocation(world, cityId);

    expect(liveLoans(world)).toHaveLength(3);
    expect(sumOutstanding(world)).toBeCloseTo(before.outstanding, 2);
    expect(
      round2(liveLoans(world).reduce((sum, loan) => sum + loan.arrearsPrincipal, 0)),
    ).toBeCloseTo(before.arrears, 2);
    for (const snapshot of before.schedules) {
      const loan = liveLoans(world).find((entry) => entry.id === snapshot.id)!;
      expect(loan.startTick).toBe(snapshot.startTick);
      expect(loan.termMonths).toBe(snapshot.termMonths);
      expect(loan.nextDueTick).toBe(snapshot.nextDueTick);
      expect(loan.rateMonthly).toBe(snapshot.rateMonthly);
      expect(loan.status).toBe(snapshot.status);
      expect(loan.monthlyPrincipal).toBeCloseTo(snapshot.monthlyPrincipal, 2);
    }

    // 逐笔核对本期应还：非末期 = min(月供, 未偿) + 欠付本金；不得被其他合同带成末期全额结清。
    repayHouseholdLoans(world, CONFIG, 5, []);
    const paid = (loan: HouseholdLoanContract) =>
      loan.payments.find((entry) => entry.tick === 5)?.principalPaid ?? 0;
    expect(paid(normal)).toBeCloseTo(30, 2); // 10 月供 + 20 欠付本金
    expect(paid(defaulted)).toBeCloseTo(20, 2);
    expect(paid(shortTerm)).toBeCloseTo(15, 2);
    expect(normal.arrearsPrincipal).toBeCloseTo(0, 2);
  });

  it('合并后连续还款、存读档与重复结算：期数/金额/到期日保持一致且同一 tick 不重复扣款', () => {
    const world = newWorld();
    const cityId = cityIdOf(world);
    const group = groupOf(world, cityId);
    group.cash = 10_000;
    const first = makeLoan(group, {
      id: 'hhloan-a',
      nextDueTick: 5,
      outstanding: 100,
      principal: 100,
      monthlyPrincipal: 10,
    });
    const second = makeLoan(group, {
      id: 'hhloan-b',
      nextDueTick: 5,
      outstanding: 200,
      principal: 200,
      monthlyPrincipal: 20,
    });
    loansOf(world).push(first, second);
    runAllocation(world, cityId);
    expect(liveLoans(world)).toHaveLength(1);

    const parsed = parseSave(serializeSave(world));
    expect(parsed.ok, parsed.ok ? '' : parsed.error).toBe(true);
    const loaded = parsed.world!;
    const loadedGroup = groupOf(loaded, cityId);
    loadedGroup.cash = 10_000;
    const merged = liveLoans(loaded)[0]!;
    expect(merged.startTick).toBe(0);
    expect(merged.termMonths).toBe(24);
    expect(merged.nextDueTick).toBe(5);

    repayHouseholdLoans(loaded, CONFIG, 5, []);
    expect(merged.payments).toHaveLength(1);
    const firstPayment = merged.payments[0]!;
    // 同一 tick 重复结算：幂等，不重复扣款、不追加还款记录。
    repayHouseholdLoans(loaded, CONFIG, 5, []);
    expect(merged.payments).toHaveLength(1);
    expect(merged.outstanding).toBeCloseTo(270, 2);

    repayHouseholdLoans(loaded, CONFIG, 6, []);
    expect(merged.payments).toHaveLength(2);
    // 第 6 期仍按同一月供 + 实际未偿计息，未被当成末期。
    expect(merged.payments[1]!.principalDue).toBeCloseTo(30, 2);
    expect(merged.outstanding).toBeCloseTo(240, 2);
    expect(firstPayment.principalDue).toBeCloseTo(30, 2);
    expect(liveLoans(loaded)).toHaveLength(1);
  });

  it('多次群体人数变化后合同数量可控，未偿本金与还款记录守恒', () => {
    const world = newWorld();
    const cityId = cityIdOf(world);
    const group = groupOf(world, cityId);
    const management = groupOf(world, cityId, 'management');
    group.cash = 100_000;
    const originals = [0, 1, 2].map((start, index) =>
      makeLoan(group, {
        id: `hhloan-origin-${index}`,
        startTick: start,
        nextDueTick: 3,
        outstanding: 300,
        principal: 300,
        monthlyPrincipal: 12.5,
      }),
    );
    loansOf(world).push(...originals);
    const initialOutstanding = sumOutstanding(world);
    const initialPayments = loansOf(world).reduce((sum, loan) => sum + loan.payments.length, 0);

    let maxContracts = 0;
    for (let iteration = 1; iteration <= 6; iteration += 1) {
      const targets = new Map<OccupationClass, number>();
      targets.set('production', Math.max(1, group.people - iteration * 10));
      targets.set('management', management.people + iteration * 10);
      runAllocation(world, cityId, targets);
      maxContracts = Math.max(maxContracts, liveLoans(world).length);
      expect(sumOutstanding(world)).toBeCloseTo(initialOutstanding, 1);
    }
    // 旧实现每次拆分都会把碎片继续拆分（指数增长）；修复后按签名合并，数量保持可控。
    expect(maxContracts).toBeLessThanOrEqual(12);
    expect(liveLoans(world).length).toBeLessThanOrEqual(12);
    expect(
      loansOf(world).reduce((sum, loan) => sum + loan.payments.length, 0),
    ).toBe(initialPayments);
    for (const original of originals) {
      expect(original.startTick).toBeLessThanOrEqual(2);
      expect(original.termMonths).toBe(24);
    }
  });

  it('跨城迁移拆分债务：本金守恒、开始月/期限/下次还款日不变、不记成还款', () => {
    const world = newWorld();
    const fromCityId = cityIdOf(world);
    const toCityId = world.cities[1]!.id;
    const sourceGroup = groupOf(world, fromCityId, 'unemployed');
    sourceGroup.cash = 10_000;
    const loan = makeLoan(sourceGroup, {
      id: 'hhloan-migrate',
      outstanding: 600,
      principal: 600,
      monthlyPrincipal: 25,
      nextDueTick: 3,
    });
    loansOf(world).push(loan);
    const totalBefore = round2(loansOf(world).reduce((sum, entry) => sum + entry.outstanding, 0));
    const sourcePaymentsBefore = JSON.stringify(loan.payments);

    const transferred = transferHouseholdDebtsForMigration(
      world,
      CONFIG,
      fromCityId,
      toCityId,
      20,
      12,
      0,
    );

    expect(transferred.principalMoved).toBeGreaterThan(0);
    const totalAfter = round2(loansOf(world).reduce((sum, entry) => sum + entry.outstanding, 0));
    expect(totalAfter).toBeCloseTo(totalBefore, 2);
    // 转移不是还款：源合同还款记录不变。
    expect(JSON.stringify(loan.payments)).toBe(sourcePaymentsBefore);
    const moved = loansOf(world).filter(
      (entry) => entry.cityId === toCityId && entry.id !== loan.id && entry.outstanding > 0.005,
    );
    expect(moved.length).toBeGreaterThan(0);
    for (const entry of moved) {
      expect(entry.startTick).toBe(0);
      expect(entry.termMonths).toBe(24);
      expect(entry.nextDueTick).toBe(3);
      expect(entry.payments).toHaveLength(0);
      expect(entry.paidPrincipal).toBe(0);
    }
    // 拆分后各期到期日一致：tick 3 所有参与合同都仍是普通分期（非末期），
    // 应还本金合计 = 各自月供（未被提前拖入末期全额结清）。
    groupOf(world, toCityId, 'unemployed').cash = 10_000;
    const participants = loansOf(world).filter(
      (entry) => entry.id === loan.id || moved.includes(entry),
    );
    const expectedDue = round2(
      participants.reduce((sum, entry) => {
        const periodNumber = entry.nextDueTick - entry.startTick;
        return (
          sum +
          (periodNumber >= entry.termMonths
            ? entry.outstanding
            : Math.min(entry.monthlyPrincipal, entry.outstanding))
        );
      }, 0),
    );
    repayHouseholdLoans(world, CONFIG, 3, []);
    const due = round2(
      participants.reduce(
        (sum, entry) => sum + (entry.payments.find((p) => p.tick === 3)?.principalDue ?? 0),
        0,
      ),
    );
    expect(due).toBeCloseTo(expectedDue, 2);
    for (const entry of moved) {
      expect(entry.termMonths).toBe(24);
      expect(entry.nextDueTick).toBe(4);
    }
    void TOLERANCE;
  });
});
