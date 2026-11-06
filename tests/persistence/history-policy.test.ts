// v1.7 §五：历史记录与数据增长治理测试。
//
// 覆盖：
// 1) banking.snapshots 每主体 1 条 + 月度汇总（窗口边界/守恒/幂等）；
// 2) 已结清银行贷款 36 月后年聚合归档（边界/守恒/未结清与违约保留/幂等）；
// 3) 已结清居民消费贷归档 + 悬空引用口径（core/save.ts 严格口径 vs referenceValidation 放宽）
//    与“归档后读档校验通过”；
// 4) fiscal.ledger 36 月明细 + 城市×年×kind 聚合（当月明细完整/守恒/幂等）；
// 5) bonds.payments 36 月明细 + 批次×持有人×年×kind 聚合（守恒/幂等）；
// 6) securities.history 月线 120 月窗口 + 年度 OHLCV（真实计算、无成交月不造假、增量合并幂等）；
// 7) 治理议案（终态、12 月后）与选举（12 月后）年度聚合；open 议案与近期记录保留；
// 8) lifecycle 不被裁剪（founding.ts 终身计数语义，本轮明确不归档）；
// 9) 真实 6 个月推进 + 短窗口配置的集成：不变量空、存档往返字段保留、读档后推进等价；
// 10) 全量重复执行幂等。
//
// 说明：窗口/年份均按 tick 与 config.simulation 起始年月推导；测试用 clockAt 把世界时钟
// 设为与注入 tick 一致，避免依赖真实推进速度。

import { describe, expect, it } from 'vitest';
import { Simulation } from '../../src/simulation/core/simulation';
import { DEMO_CONFIG } from '../../src/data/config';
import type { DemoConfig } from '../../src/data/config';
import { checkInvariants } from '../../src/simulation/core/invariants';
import { parseSave, serializeSave } from '../../src/simulation/core/save';
import { round2 } from '../../src/simulation/core/math';
import { applyHistoryPolicy } from '../../src/simulation/persistence/historyPolicy';
import type {
  BankOwner,
  BondPayment,
  CreditSnapshot,
  ElectionRecord,
  FiscalEntry,
  FoundingRecord,
  HouseholdLoanContract,
  LiquidationRecord,
  LoanContract,
  Motion,
  StockCandle,
  StockClassHistory,
  WorldState,
} from '../../src/simulation/contracts/types';

// ---------------------------------------------------------------- 测试工具

function newWorld(): WorldState {
  return Simulation.create().state;
}

/** 把世界时钟设置到指定 tick（起始年月取自 DEMO_CONFIG，保证 calendarAtTick 与注入记录一致）。 */
function clockAt(world: WorldState, tick: number): void {
  const startYear = DEMO_CONFIG.simulation.startYear;
  const startMonth = DEMO_CONFIG.simulation.startMonth;
  const year = startYear + Math.floor((startMonth - 1 + tick) / 12);
  const month = (((startMonth - 1 + tick) % 12) + 12) % 12 + 1;
  world.time = { year, month, tick };
}

function configWithHistory(overrides: Record<string, number | boolean>): DemoConfig {
  return {
    ...DEMO_CONFIG,
    history: { ...DEMO_CONFIG.history, ...overrides },
  } as unknown as DemoConfig;
}

function ownerKeyOf(owner: BankOwner): string {
  return `${owner.kind}:${owner.id}`;
}

function pushSnapshot(
  world: WorldState,
  borrower: BankOwner,
  tick: number,
  limit: number,
  outstanding: number,
): void {
  const snapshot: CreditSnapshot = {
    tick,
    borrower: { ...borrower },
    baseValue: round2(limit * 2),
    limitRate: DEMO_CONFIG.banking.creditLimitRate,
    limit,
    outstanding,
    available: Math.max(0, round2(limit - outstanding)),
    method: borrower.kind === 'company' ? 'equityBook' : 'netWorth',
    reason: '测试快照',
  };
  world.banking.snapshots.push(snapshot);
}

function baseBankLoan(): LoanContract {
  return {
    id: 'loan-test',
    borrower: { kind: 'player', id: 'player' },
    purpose: 'personal',
    principal: 1_000,
    outstanding: 0,
    monthlyPrincipal: 100,
    rateMonthly: 0.006,
    termMonths: 12,
    startTick: 1,
    nextDueTick: 13,
    paidPrincipal: 1_000,
    paidInterest: 10,
    accruedInterest: 0,
    arrearsPrincipal: 0,
    arrearsInterest: 0,
    missedPayments: 0,
    status: 'repaid',
    payments: [],
    note: '测试贷款',
  };
}

function baseHouseholdLoan(world: WorldState): HouseholdLoanContract {
  const group = world.households.groups[0]!;
  return {
    id: 'hhloan-test',
    cityId: group.cityId,
    groupId: group.id,
    purpose: 'consumption',
    principal: 1_000,
    outstanding: 0,
    monthlyPrincipal: 100,
    rateMonthly: 0.006,
    termMonths: 12,
    startTick: 1,
    nextDueTick: 13,
    paidPrincipal: 1_000,
    paidInterest: 10,
    accruedInterest: 0,
    arrearsPrincipal: 0,
    arrearsInterest: 0,
    missedPayments: 0,
    status: 'repaid',
    payments: [],
    note: '测试消费贷',
  };
}

function fiscalEntry(
  tick: number,
  cityId: string,
  kind: FiscalEntry['kind'],
  amount: number,
): FiscalEntry {
  return {
    id: `fiscal-test-${tick}-${cityId}-${kind}`,
    tick,
    cityId,
    kind,
    amount,
    source: '测试',
  };
}

function bondPayment(
  id: string,
  tick: number,
  cityId: string,
  holder: { kind: 'company' | 'player' | 'investorGroup'; id: string },
  kind: BondPayment['kind'],
  principalPaid: number,
  interestPaid: number,
  fundedByBankAdvance = false,
): BondPayment {
  return {
    id,
    tick,
    issuanceId: 'issuance-test',
    cityId,
    holdingId: `holding-${id}`,
    holder,
    kind,
    principalPaid,
    interestPaid,
    fundedByBankAdvance,
    advanceLoanId: fundedByBankAdvance ? 'advance-test' : null,
    note: '测试兑付',
  };
}

function candle(
  tick: number,
  open: number,
  high: number,
  low: number,
  close: number,
  volume: number,
  trades: number,
): StockCandle {
  return { tick, open, high, low, close, volume, trades };
}

/** 断言“同一世界重复 apply 完全无变化”（幂等）。 */
function expectRepeatApplyIdempotent(world: WorldState, config: DemoConfig): void {
  const before = JSON.stringify(world);
  const report = applyHistoryPolicy(world, config, []);
  expect(JSON.stringify(world)).toBe(before);
  const archived =
    report.bankLoans.archived +
    report.householdLoans.archived +
    report.fiscal.archived +
    report.bonds.archived +
    report.securities.monthlyArchived +
    report.governance.motionsArchived +
    report.politics.electionsArchived;
  expect(archived).toBe(0);
  expect(report.bankingSnapshots.monthsAdded).toBe(0);
}

// ---------------------------------------------------------------- 1. 授信快照

describe('A banking.snapshots：每主体仅留最新 1 条 + 月度汇总', () => {
  it('保留最新一条并生成按月汇总（金额/数量守恒，月度汇总不重复累计）', () => {
    const world = newWorld();
    clockAt(world, 6);
    const owners: BankOwner[] = [
      { kind: 'player', id: 'player' },
      { kind: 'company', id: world.companies[0]!.id },
      { kind: 'company', id: world.companies[1]!.id },
      { kind: 'investorGroup', id: world.investors[0]!.id },
    ];
    const extraOwner: BankOwner = { kind: 'company', id: world.companies[2]!.id };
    for (const owner of owners) {
      for (let tick = 1; tick <= 5; tick += 1) {
        pushSnapshot(world, owner, tick, 1_000 + tick, 100 * tick);
      }
    }
    // 只在 t1/t2 有快照的主体：归档后仍保留其最新一条（主体未消失）。
    for (let tick = 1; tick <= 2; tick += 1) {
      pushSnapshot(world, extraOwner, tick, 5_000, 500);
    }

    // 归档前对照：每主体最新一条的 limit/outstanding，以及每 tick 的去重合计。
    const latestBefore = new Map<string, CreditSnapshot>();
    const tickTotals = new Map<number, { limit: number; outstanding: number; subjects: Set<string> }>();
    for (const snapshot of world.banking.snapshots) {
      const key = ownerKeyOf(snapshot.borrower);
      const current = latestBefore.get(key);
      if (!current || snapshot.tick >= current.tick) latestBefore.set(key, snapshot);
      const total = tickTotals.get(snapshot.tick) ?? {
        limit: 0,
        outstanding: 0,
        subjects: new Set<string>(),
      };
      total.limit = round2(total.limit + snapshot.limit);
      total.outstanding = round2(total.outstanding + snapshot.outstanding);
      total.subjects.add(key);
      tickTotals.set(snapshot.tick, total);
    }

    const report = applyHistoryPolicy(world, configWithHistory({}), []);
    expect(report.enabled).toBe(true);

    // 每主体仅最新 1 条（数量守恒：主体数不变）。
    const subjects = new Set(world.banking.snapshots.map((snapshot) => ownerKeyOf(snapshot.borrower)));
    expect(world.banking.snapshots).toHaveLength(latestBefore.size);
    expect(subjects.size).toBe(latestBefore.size);
    for (const snapshot of world.banking.snapshots) {
      expect(snapshot.tick).toBe(latestBefore.get(ownerKeyOf(snapshot.borrower))!.tick);
    }
    // 金额守恒：保留下来的快照总额 = 归档前各主体最新一条合计。
    const keptLimit = round2(world.banking.snapshots.reduce((sum, entry) => sum + entry.limit, 0));
    const keptOutstanding = round2(
      world.banking.snapshots.reduce((sum, entry) => sum + entry.outstanding, 0),
    );
    const expectedLimit = round2([...latestBefore.values()].reduce((sum, entry) => sum + entry.limit, 0));
    const expectedOutstanding = round2(
      [...latestBefore.values()].reduce((sum, entry) => sum + entry.outstanding, 0),
    );
    expect(keptLimit).toBe(expectedLimit);
    expect(keptOutstanding).toBe(expectedOutstanding);

    // 月度汇总：t1–t5 各一行，主体数/金额与归档前同 tick 去重合计守恒。
    expect(world.banking.snapshotMonths).toBeDefined();
    const rows = world.banking.snapshotMonths!;
    expect(rows.map((row) => row.tick)).toEqual([1, 2, 3, 4, 5]);
    for (const row of rows) {
      const expected = tickTotals.get(row.tick)!;
      expect(row.subjects).toBe(expected.subjects.size);
      expect(row.totalLimit).toBe(expected.limit);
      expect(row.totalOutstanding).toBe(expected.outstanding);
      const kindSubjects = Object.values(row.byBorrowerKind).reduce(
        (sum, entry) => sum + entry.subjects,
        0,
      );
      expect(kindSubjects).toBe(row.subjects);
    }
    expect(rows[0]!.year).toBe(2026);
    expect(rows[0]!.month).toBe(2); // tick 1 = 起始月 2026-01 的下一个月

    // 重复执行：不重复统计、不改变世界。
    expectRepeatApplyIdempotent(world, configWithHistory({}));
    expect(world.banking.snapshotMonths).toHaveLength(5);
  });

  it('月度汇总按 bankingSnapshotMonths 裁剪，边界为 now - tick < N', () => {
    const world = newWorld();
    clockAt(world, 6);
    for (const tick of [1, 4, 5, 6]) {
      pushSnapshot(world, { kind: 'player', id: 'player' }, tick, 1_000, 0);
    }
    const config = configWithHistory({ bankingSnapshotMonths: 3 });
    const report = applyHistoryPolicy(world, config, []);
    expect(report.bankingSnapshots.monthsAdded).toBe(4);
    // now=6，窗口 3 → 保留 tick 4/5/6（age<3），tick1（age5）裁掉。
    expect(world.banking.snapshotMonths!.map((row) => row.tick)).toEqual([4, 5, 6]);
    expect(report.bankingSnapshots.monthsPruned).toBe(1);

    clockAt(world, 9);
    for (const tick of [7, 8]) {
      pushSnapshot(world, { kind: 'player', id: 'player' }, tick, 1_000, 0);
    }
    const second = applyHistoryPolicy(world, config, []);
    expect(second.bankingSnapshots.monthsAdded).toBe(2);
    // now=9，窗口 3 → 保留 tick 7/8；tick4/5/6 均 age>=3 被裁。
    expect(world.banking.snapshotMonths!.map((row) => row.tick)).toEqual([7, 8]);
    expect(second.bankingSnapshots.monthsPruned).toBe(3);
  });
});

// ---------------------------------------------------------------- 2. 已结清银行贷款

describe('B1 已结清银行贷款：36 月后年聚合归档', () => {
  it('只归档 repaid 且结清超过 36 个月；未结清/违约/近期结清保留且守恒', () => {
    const world = newWorld();
    clockAt(world, 50);
    const oldRepaid: LoanContract = {
      ...baseBankLoan(),
      id: 'loan-old-repaid',
      startTick: 1,
      nextDueTick: 11,
      payments: [{ tick: 10, principalDue: 100, interestDue: 5, principalPaid: 100, interestPaid: 5, arrears: 0, note: '' }],
      paidPrincipal: 1_000,
      paidInterest: 30,
    };
    const recentRepaid: LoanContract = {
      ...baseBankLoan(),
      id: 'loan-recent-repaid',
      startTick: 30,
      nextDueTick: 41,
      payments: [{ tick: 40, principalDue: 100, interestDue: 5, principalPaid: 100, interestPaid: 5, arrears: 0, note: '' }],
      paidPrincipal: 1_000,
      paidInterest: 12,
    };
    const active: LoanContract = {
      ...baseBankLoan(),
      id: 'loan-active',
      status: 'active',
      outstanding: 500,
      paidPrincipal: 500,
      principal: 1_000,
      startTick: 1,
      nextDueTick: 2,
      payments: [{ tick: 1, principalDue: 100, interestDue: 5, principalPaid: 100, interestPaid: 5, arrears: 0, note: '' }],
    };
    const defaulted: LoanContract = {
      ...baseBankLoan(),
      id: 'loan-defaulted',
      status: 'defaulted',
      principal: 5_000,
      paidPrincipal: 5_000,
      outstanding: 0,
      startTick: 2,
      nextDueTick: 3,
      payments: [],
    };
    const writtenOff: LoanContract = {
      ...baseBankLoan(),
      id: 'loan-written-off',
      status: 'writtenOff',
      principal: 800,
      paidPrincipal: 800,
      outstanding: 0,
      startTick: 3,
      nextDueTick: 4,
    };
    world.banking.loans.push(oldRepaid, recentRepaid, active, defaulted, writtenOff);

    const report = applyHistoryPolicy(world, configWithHistory({}), []);
    expect(report.bankLoans.archived).toBe(1);
    const remainingIds = world.banking.loans.map((loan) => loan.id).sort();
    expect(remainingIds).toEqual(['loan-active', 'loan-defaulted', 'loan-recent-repaid', 'loan-written-off']);
    expect(world.banking.archivedLoans).toBeDefined();
    const buckets = world.banking.archivedLoans!;
    expect(buckets).toHaveLength(1);
    const bucket = buckets[0]!;
    expect(bucket).toMatchObject({
      year: 2026,
      borrowerKind: 'player',
      purpose: 'personal',
      status: 'repaid',
      count: 1,
      principal: 1_000,
      paidPrincipal: 1_000,
      paidInterest: 30,
    });
    // 守恒：Σ 聚合 = 被移除明细合计。
    expect(round2(buckets.reduce((sum, entry) => sum + entry.principal, 0))).toBe(oldRepaid.principal);
    expect(round2(buckets.reduce((sum, entry) => sum + entry.paidInterest, 0))).toBe(oldRepaid.paidInterest);
    expect(world.banking.loans).toHaveLength(4);
    expect(checkInvariants(world)).toEqual([]);
    expectRepeatApplyIdempotent(world, configWithHistory({}));
  });

  it('边界：结清未满 36 个月保留、满 36 个月归档（age >= N 归档）', () => {
    const world = newWorld();
    clockAt(world, 50);
    // 结清 tick = 15：now - 15 = 35 → 保留；结清 tick = 14：36 → 归档。
    const boundaryKept: LoanContract = {
      ...baseBankLoan(),
      id: 'loan-boundary-kept',
      startTick: 1,
      nextDueTick: 16,
      payments: [{ tick: 15, principalDue: 0, interestDue: 0, principalPaid: 0, interestPaid: 0, arrears: 0, note: '' }],
    };
    const boundaryArchived: LoanContract = {
      ...baseBankLoan(),
      id: 'loan-boundary-archived',
      startTick: 1,
      nextDueTick: 15,
      payments: [{ tick: 14, principalDue: 0, interestDue: 0, principalPaid: 0, interestPaid: 0, arrears: 0, note: '' }],
    };
    world.banking.loans.push(boundaryKept, boundaryArchived);
    applyHistoryPolicy(world, configWithHistory({}), []);
    expect(world.banking.loans.map((loan) => loan.id)).toEqual(['loan-boundary-kept']);
    expect(world.banking.archivedLoans!).toHaveLength(1);
    expect(world.banking.archivedLoans![0]!.count).toBe(1);
  });
});

// ---------------------------------------------------------------- 3. 已结清居民消费贷

describe('B2 已结清居民消费贷：36 月后归档 + 悬空引用口径', () => {
  it('只归档 repaid；活跃/违约保留，归档后不变量为空', () => {
    const world = newWorld();
    clockAt(world, 50);
    const base = baseHouseholdLoan(world);
    const oldRepaid: HouseholdLoanContract = {
      ...base,
      id: 'hhlo-old-repaid',
      startTick: 1,
      nextDueTick: 11,
      payments: [{ tick: 10, principalDue: 100, interestDue: 5, principalPaid: 100, interestPaid: 5, arrears: 0, note: '' }],
      paidInterest: 25,
    };
    const recentRepaid: HouseholdLoanContract = {
      ...base,
      id: 'hhlo-recent-repaid',
      startTick: 30,
      nextDueTick: 41,
      payments: [{ tick: 40, principalDue: 0, interestDue: 0, principalPaid: 0, interestPaid: 0, arrears: 0, note: '' }],
    };
    const active: HouseholdLoanContract = {
      ...base,
      id: 'hhlo-active',
      status: 'active',
      principal: 2_000,
      paidPrincipal: 500,
      outstanding: 1_500,
      startTick: 1,
      nextDueTick: 2,
    };
    const defaulted: HouseholdLoanContract = {
      ...base,
      id: 'hhlo-defaulted',
      status: 'defaulted',
      principal: 3_000,
      paidPrincipal: 1_000,
      outstanding: 2_000,
      startTick: 1,
      nextDueTick: 2,
    };
    world.householdFinance.loans = [oldRepaid, recentRepaid, active, defaulted];

    const report = applyHistoryPolicy(world, configWithHistory({}), []);
    expect(report.householdLoans.archived).toBe(1);
    expect(world.householdFinance.loans.map((loan) => loan.id).sort()).toEqual([
      'hhlo-active',
      'hhlo-defaulted',
      'hhlo-recent-repaid',
    ]);
    const bucket = world.householdFinance.archivedLoans![0]!;
    expect(bucket).toMatchObject({
      year: 2026,
      cityId: base.cityId,
      status: 'repaid',
      count: 1,
      principal: 1_000,
      paidPrincipal: 1_000,
      paidInterest: 25,
    });
    expect(checkInvariants(world)).toEqual([]);
    expectRepeatApplyIdempotent(world, configWithHistory({}));
  });

  it('口径决策：以 core/save.ts 严格校验为读档基线；归档移除悬空已结清记录后读档通过', () => {
    // 真实推进 2 个月得到结构完整的首存世界（初始世界缺若干运行时数组，不能直接当旧档校验基准）。
    const sim = Simulation.create();
    sim.tick();
    sim.tick();
    const world = sim.state;
    clockAt(world, 50);
    /** 旧单体 v9 存档文本：走 core/save.ts 的严格结构校验（含消费贷 groupId 存在性）。 */
    const legacyV9Text = (): string =>
      JSON.stringify({
        formatVersion: 9,
        gameVersion: '1.6.1',
        savedAt: new Date().toISOString(),
        world,
      });
    // 基线：无悬空引用时旧档可读。
    expect(parseSave(legacyV9Text()).ok).toBe(true);

    // 构造“已结清消费贷引用已不存在的群体”的历史悬空数据：referenceValidation 放宽，
    // 但 core/save.ts（旧档读档路径）严格校验 groupId 存在 → 归档前读档失败。
    const ghost: HouseholdLoanContract = {
      ...baseHouseholdLoan(world),
      id: 'hhlo-ghost',
      groupId: 'ghost-group-not-exist',
      startTick: 1,
      nextDueTick: 11,
      payments: [{ tick: 10, principalDue: 0, interestDue: 0, principalPaid: 0, interestPaid: 0, arrears: 0, note: '' }],
    };
    world.householdFinance.loans = [ghost];
    const before = parseSave(legacyV9Text());
    expect(before.ok).toBe(false);
    if (!before.ok) expect(before.error).toContain('不存在的居民群体');

    const report = applyHistoryPolicy(world, configWithHistory({}), []);
    expect(report.householdLoans.archived).toBe(1);
    expect(world.householdFinance.loans).toHaveLength(0);
    // 归档行不含 groupId（不引入新的悬空引用），严格旧档校验与当前模块化序列化都通过。
    expect(world.householdFinance.archivedLoans![0]).not.toHaveProperty('groupId');
    expect(parseSave(legacyV9Text()).ok).toBe(true);
    expect(parseSave(serializeSave(world)).ok).toBe(true);
  });
});

// ---------------------------------------------------------------- 4. 财政流水

describe('C fiscal.ledger：36 月明细 + 城市×年×kind 聚合', () => {
  it('窗口边界、当月明细完整、金额/条数守恒、重复执行幂等', () => {
    const world = newWorld();
    clockAt(world, 60);
    const cityIds = world.cities.map((city) => city.id);
    const kinds: FiscalEntry['kind'][] = ['incomeTax', 'publicWages'];
    for (let tick = 1; tick <= 60; tick += 1) {
      for (const cityId of cityIds) {
        for (const kind of kinds) {
          const amount = kind === 'incomeTax' ? tick * 10 : -(tick * 7);
          world.fiscal.ledger.push(fiscalEntry(tick, cityId, kind, amount));
        }
      }
    }
    const before = { amount: round2(world.fiscal.ledger.reduce((sum, entry) => sum + entry.amount, 0)), count: world.fiscal.ledger.length };

    const report = applyHistoryPolicy(world, configWithHistory({}), []);
    // 窗口 36：now=60 → 保留 tick 25..60，归档 tick 1..24。
    expect(report.fiscal.archived).toBe(24 * cityIds.length * kinds.length);
    const keptTicks = world.fiscal.ledger.map((entry) => entry.tick);
    expect(Math.min(...keptTicks)).toBe(25);
    expect(Math.max(...keptTicks)).toBe(60);
    expect(world.fiscal.ledger).toHaveLength(36 * cityIds.length * kinds.length);
    // 当月（tick=60）明细完整。
    expect(world.fiscal.ledger.filter((entry) => entry.tick === 60)).toHaveLength(cityIds.length * kinds.length);
    // 守恒：归档 + 保留 = 归档前（条数与金额）。
    const keptAmount = round2(world.fiscal.ledger.reduce((sum, entry) => sum + entry.amount, 0));
    const archivedAmount = round2(world.fiscal.archivedLedger!.reduce((sum, entry) => sum + entry.amount, 0));
    expect(round2(keptAmount + archivedAmount)).toBe(before.amount);
    expect(world.fiscal.archivedLedger!.reduce((sum, entry) => sum + entry.count, 0)).toBe(report.fiscal.archived);
    expect(world.fiscal.ledger.length + report.fiscal.archived).toBe(before.count);
    // 聚合键：城市×年×kind。tick0=2026-01，故归档 tick 1..24 跨 2026/2027/2028 三个日历年
    //（tick1–11=2026、12–23=2027、24=2028）→ 每城每 kind 3 个年度桶。
    expect(world.fiscal.archivedLedger).toHaveLength(cityIds.length * kinds.length * 3);
    expect(world.fiscal.archivedLedger!.every((entry) => entry.kind === 'incomeTax' || entry.kind === 'publicWages')).toBe(true);
    expect(checkInvariants(world)).toEqual([]);
    expectRepeatApplyIdempotent(world, configWithHistory({}));
  });
});

// ---------------------------------------------------------------- 5. 债券兑付流水

describe('D bonds.payments：36 月明细 + 批次×持有人×年×kind 聚合', () => {
  it('窗口边界、金额/条数守恒、银行垫付汇总、重复执行幂等', () => {
    const world = newWorld();
    clockAt(world, 50);
    const cityId = world.cities[0]!.id;
    const companyId = world.companies[0]!.id;
    const payments: BondPayment[] = [
      bondPayment('p-old-1', 5, cityId, { kind: 'company', id: companyId }, 'coupon', 0, 40),
      bondPayment('p-old-2', 10, cityId, { kind: 'company', id: companyId }, 'coupon', 0, 40),
      bondPayment('p-old-3', 14, cityId, { kind: 'player', id: 'player' }, 'principal', 1_000, 0, true),
      bondPayment('p-new-1', 15, cityId, { kind: 'company', id: companyId }, 'coupon', 0, 40),
      bondPayment('p-new-2', 50, cityId, { kind: 'player', id: 'player' }, 'principal', 1_000, 0),
    ];
    world.bonds!.payments = payments;
    const before = {
      count: payments.length,
      principal: round2(payments.reduce((sum, entry) => sum + entry.principalPaid, 0)),
      interest: round2(payments.reduce((sum, entry) => sum + entry.interestPaid, 0)),
    };

    const report = applyHistoryPolicy(world, configWithHistory({}), []);
    // now=50，窗口 36 → 归档 tick <= 14（now-tick >= 36）。
    expect(report.bonds.archived).toBe(3);
    expect(world.bonds!.payments.map((payment) => payment.id)).toEqual(['p-new-1', 'p-new-2']);
    const buckets = world.bonds!.archivedPayments!;
    expect(buckets).toHaveLength(2); // company/coupon 与 player/principal
    const companyBucket = buckets.find((entry) => entry.holderKind === 'company')!;
    expect(companyBucket).toMatchObject({ year: 2026, issuanceId: 'issuance-test', kind: 'coupon', count: 2, interestPaid: 80, principalPaid: 0 });
    const playerBucket = buckets.find((entry) => entry.holderKind === 'player')!;
    expect(playerBucket).toMatchObject({ kind: 'principal', count: 1, principalPaid: 1_000, bankAdvancedCount: 1, bankAdvancedAmount: 1_000 });
    const keptPrincipal = round2(
      world.bonds!.payments.reduce((sum, entry) => sum + entry.principalPaid, 0),
    );
    const keptInterest = round2(
      world.bonds!.payments.reduce((sum, entry) => sum + entry.interestPaid, 0),
    );
    expect(round2(buckets.reduce((sum, entry) => sum + entry.principalPaid, 0)) + keptPrincipal).toBe(before.principal);
    expect(round2(buckets.reduce((sum, entry) => sum + entry.interestPaid, 0)) + keptInterest).toBe(before.interest);
    expect(buckets.reduce((sum, entry) => sum + entry.count, 0)).toBe(report.bonds.archived);
    expectRepeatApplyIdempotent(world, configWithHistory({}));
  });
});

// ---------------------------------------------------------------- 6. 股票年度 OHLCV

describe('E securities.history：120 月月线 + 更早年度 OHLCV', () => {
  function stockEntry(world: WorldState, candles: StockCandle[]): StockClassHistory {
    const entry: StockClassHistory = {
      shareClassId: 'test-share-class',
      companyId: world.companies[0]!.id,
      kind: 'voting',
      companyName: world.companies[0]!.name,
      candles: candles.map((item) => ({ ...item })),
    };
    world.securities.history.push(entry);
    return entry;
  }

  it('年度 OHLCV 由真实月线正确计算、无成交月不造假、窗口边界正确', () => {
    const world = newWorld();
    clockAt(world, 250);
    const entry = stockEntry(world, [
      candle(1, 10, 12, 9, 11, 100, 2),
      candle(2, 11, 15, 10, 14, 50, 1),
      candle(3, 14, 14, 8, 9, 20, 3),
      candle(61, 20, 21, 19, 20, 30, 1),
      candle(100, 30, 33, 28, 31, 40, 2),
      candle(130, 40, 41, 39, 40, 10, 1), // now-tick=120 → 归档边界（含）
      candle(131, 41, 42, 40, 42, 60, 2), // now-tick=119 → 保留
      candle(200, 50, 55, 49, 54, 70, 3),
      candle(250, 60, 61, 59, 60, 80, 4),
    ]);
    const report = applyHistoryPolicy(world, configWithHistory({}), []);
    expect(report.securities.monthlyArchived).toBe(6);
    expect(entry.candles.map((item) => item.tick)).toEqual([131, 200, 250]);

    const yearly = entry.yearlyCandles!;
    expect(yearly).toHaveLength(4);
    // 2026：tick 1–3（无 tick 4–12 成交月，months 只能是 3，不补 0）。
    const y2026 = yearly.find((row) => row.year === 2026)!;
    expect(y2026).toEqual({
      year: 2026,
      open: 10,
      high: 15,
      low: 8,
      close: 9,
      volume: 170,
      trades: 6,
      months: 3,
      firstTick: 1,
      lastTick: 3,
    });
    // 2031/2034：各 1 根真实月线。
    for (const [year, tick, value] of [
      [2031, 61, 20],
      [2034, 100, 31],
    ] as const) {
      const row = yearly.find((item) => item.year === year)!;
      expect(row.months).toBe(1);
      expect(row.firstTick).toBe(tick);
      expect(row.lastTick).toBe(tick);
      expect(row.open).toBe(year === 2031 ? 20 : 30);
      expect(row.close).toBe(value);
    }
    // 2036：仅 tick130（tick131 仍在月线窗口内）→ months=1。
    const y2036 = yearly.find((row) => row.year === 2036)!;
    expect(y2036.months).toBe(1);
    expect(y2036.firstTick).toBe(130);
    expect(entry.candles.some((item) => item.tick === 130)).toBe(false);

    // 无成交月不造假：年度 months 合计 = 归档月线根数，且不存在 months > 实际根数。
    const totalMonths = yearly.reduce((sum, row) => sum + row.months, 0);
    expect(totalMonths).toBe(report.securities.monthlyArchived);
    for (const row of yearly) {
      expect(row.high).toBeGreaterThanOrEqual(row.open);
      expect(row.high).toBeGreaterThanOrEqual(row.close);
      expect(row.low).toBeLessThanOrEqual(row.open);
      expect(row.low).toBeLessThanOrEqual(row.close);
    }
    expectRepeatApplyIdempotent(world, configWithHistory({}));
  });

  it('同一年分两次归档时增量合并：open/close 按真实首末月线，不重复计数', () => {
    const world = newWorld();
    clockAt(world, 250);
    const entry = stockEntry(world, [
      candle(130, 40, 41, 39, 40, 10, 1),
      candle(131, 41, 45, 40, 44, 20, 2),
    ]);
    applyHistoryPolicy(world, configWithHistory({}), []);
    expect(entry.yearlyCandles![0]!.months).toBe(1);

    clockAt(world, 251); // tick131 也超过 120 月窗口
    const report = applyHistoryPolicy(world, configWithHistory({}), []);
    expect(report.securities.monthlyArchived).toBe(1);
    const row = entry.yearlyCandles![0]!;
    expect(row.year).toBe(2036);
    expect(row.months).toBe(2);
    expect(row.firstTick).toBe(130);
    expect(row.lastTick).toBe(131);
    expect(row.open).toBe(40);
    expect(row.close).toBe(44);
    expect(row.high).toBe(45);
    expect(row.low).toBe(39);
    expect(row.volume).toBe(30);
    expect(row.trades).toBe(3);
    expect(entry.candles).toHaveLength(0);
    expectRepeatApplyIdempotent(world, configWithHistory({}));
  });
});

// ---------------------------------------------------------------- 7. 治理议案 / 选举

describe('F governance.motions / politics.elections：终态一年后年度聚合', () => {
  function motion(overrides: Partial<Motion> & { id: string }): Motion {
    return {
      companyId: '',
      kind: 'dividendPolicy',
      title: '测试议案',
      proposedBy: { type: 'player', id: 'player' },
      createdTick: 1,
      closesAtTick: 3,
      params: { ratio: 0.3 },
      status: 'passed',
      eligible: [],
      votes: [],
      decidedTick: 3,
      result: '通过',
      note: '',
      ...overrides,
    };
  }

  it('归档终态且超过 12 个月；open 与近期保留；票数/结果摘要守恒', () => {
    const world = newWorld();
    clockAt(world, 50);
    const companyId = world.companies[0]!.id;
    const companyName = world.companies[0]!.name;
    const votes: Motion['votes'] = [
      { holder: { type: 'player', id: 'player' }, vote: 'for', votingShares: 100, tick: 3 },
      { holder: { type: 'investorGroup', id: world.investors[0]!.id }, vote: 'against', votingShares: 40, tick: 3 },
    ];
    const motions: Motion[] = [
      motion({ id: 'm-old-2026', companyId, decidedTick: 3, votes }),
      motion({ id: 'm-old-2026-rejected', companyId, status: 'rejected', decidedTick: 5, kind: 'operatorAppointment' }),
      motion({ id: 'm-old-2027', companyId, decidedTick: 13, votes: [] }),
      motion({ id: 'm-recent', companyId, decidedTick: 45 }),
      motion({ id: 'm-open-old', companyId, status: 'open', decidedTick: null, createdTick: 1, closesAtTick: 60 }),
    ];
    world.governance.motions = motions;

    const report = applyHistoryPolicy(world, configWithHistory({}), []);
    expect(report.governance.motionsArchived).toBe(3);
    expect(world.governance.motions.map((entry) => entry.id)).toEqual(['m-recent', 'm-open-old']);
    const buckets = world.governance.motionYears!;
    expect(buckets).toHaveLength(3);
    const dividend2026 = buckets.find((entry) => entry.year === 2026 && entry.kind === 'dividendPolicy')!;
    expect(dividend2026).toMatchObject({
      companyId,
      companyName,
      count: 1,
      passed: 1,
      rejected: 0,
      votesFor: 100,
      votesAgainst: 40,
    });
    const appointment2026 = buckets.find((entry) => entry.year === 2026 && entry.kind === 'operatorAppointment')!;
    expect(appointment2026).toMatchObject({ count: 1, passed: 0, rejected: 1 });
    const dividend2027 = buckets.find((entry) => entry.year === 2027 && entry.kind === 'dividendPolicy')!;
    expect(dividend2027).toMatchObject({ count: 1, decidedFirstTick: 13, decidedLastTick: 13 });
    expectRepeatApplyIdempotent(world, configWithHistory({}));
  });

  it('选举记录一年后按 城市×年 聚合，近期保留，玩家胜选计数守恒', () => {
    const world = newWorld();
    clockAt(world, 50);
    const cityId = world.cities[0]!.id;
    const initialCount = world.politics.elections.length; // 3 条 tick0 初始记录
    const extra: ElectionRecord[] = [
      { tick: 1, cityId, winnerId: 'candidate-x', winnerName: '甲', playerWon: false, note: '旧选举' },
      { tick: 2, cityId, winnerId: 'player', winnerName: '玩家', playerWon: true, note: '旧选举' },
      { tick: 45, cityId, winnerId: 'candidate-y', winnerName: '乙', playerWon: false, note: '近期选举' },
    ];
    world.politics.elections.push(...extra);

    const report = applyHistoryPolicy(world, configWithHistory({}), []);
    // tick0 初始 3 条 + tick1/2 旧记录（now - tick >= 12）全部归档；tick45 保留。
    expect(report.politics.electionsArchived).toBe(initialCount + 2);
    expect(world.politics.elections.map((election) => election.tick)).toEqual([45]);
    const cityBucket = world.politics.electionYears!.find((entry) => entry.cityId === cityId)!;
    expect(cityBucket).toMatchObject({
      year: 2026,
      count: 3, // 3 城初始记录中的本城 1 条 + tick1 + tick2
      playerWins: 1,
      lastElectionTick: 2,
      lastWinnerName: '玩家',
    });
    expect(world.politics.electionYears!.reduce((sum, entry) => sum + entry.count, 0)).toBe(initialCount + 2);
    expectRepeatApplyIdempotent(world, configWithHistory({}));
  });
});

// ---------------------------------------------------------------- 8. lifecycle 不归档

describe('G lifecycle 不归档（终身计数语义）', () => {
  it('foundings/liquidations 与 next* 序号在任何窗口下都不被裁剪', () => {
    const world = newWorld();
    clockAt(world, 500);
    const company = world.companies[0]!;
    const founding: FoundingRecord = {
      id: 'founding-legacy-1',
      tick: 1,
      cityId: company.cityId,
      companyId: company.id,
      companyName: '历史企业',
      sector: company.sector,
      recipeOutput: company.recipeOutput,
      founderType: 'investorGroup',
      capital: 100_000,
      investorCount: 1,
      investors: [],
      governmentGrant: 0,
      note: '历史创办记录',
    };
    const liquidation: LiquidationRecord = {
      id: 'liquidation-legacy-1',
      tick: 2,
      companyId: 'company-gone',
      companyName: '已倒闭企业',
      cityId: company.cityId,
      reason: '测试',
      employeesReleased: 0,
      cash: 0,
      debt: 0,
      debtRepaid: 0,
      debtForgiven: 0,
      shareholderPayout: 0,
      holdings: [],
      inventoryWrittenOff: [],
      inventoryBookValue: 0,
      agreementsAffected: [],
      note: '历史清算记录',
    };
    world.lifecycle.foundings.push(founding);
    world.lifecycle.liquidations.push(liquidation);
    const before = JSON.stringify({
      foundings: world.lifecycle.foundings,
      liquidations: world.lifecycle.liquidations,
      nextFoundingNumber: world.lifecycle.nextFoundingNumber,
      nextLiquidationNumber: world.lifecycle.nextLiquidationNumber,
    });

    const report = applyHistoryPolicy(world, configWithHistory({ governanceArchiveMonths: 1 }), []);
    expect(report.skipped.some((entry) => entry.path.includes('lifecycle'))).toBe(true);
    const after = JSON.stringify({
      foundings: world.lifecycle.foundings,
      liquidations: world.lifecycle.liquidations,
      nextFoundingNumber: world.lifecycle.nextFoundingNumber,
      nextLiquidationNumber: world.lifecycle.nextLiquidationNumber,
    });
    expect(after).toBe(before);
  });
});

// ---------------------------------------------------------------- 9. 集成：真实推进 + 存档往返

describe('H 真实月结集成：安全时点、存档往返与读档后推进等价', () => {
  const shortWindowConfig = configWithHistory({
    fiscalDetailMonths: 2,
    bankingSnapshotMonths: 2,
    bondPaymentDetailMonths: 2,
    governanceArchiveMonths: 1,
    electionArchiveMonths: 1,
    stockMonthlyMonths: 2,
    closedLoanArchiveMonths: 1,
  });

  it('6 个月真实推进：不变量空、归档生效、lifecycle 记录不减少、存档往返字段保留、读档后推进等价', () => {
    const sim = Simulation.create(shortWindowConfig);
    for (let month = 0; month < 6; month += 1) {
      const result = sim.tick();
      expect(result.ok).toBe(true);
      expect(checkInvariants(sim.state)).toEqual([]);
    }
    const world = sim.state;
    expect(world.time.tick).toBe(6);

    // A. 授信快照每主体一条；月度汇总存在且不超过窗口。
    const snapshotOwners = new Set(
      world.banking.snapshots.map((snapshot) => ownerKeyOf(snapshot.borrower)),
    );
    expect(world.banking.snapshots).toHaveLength(snapshotOwners.size);
    expect(world.banking.snapshotMonths).toBeDefined();
    expect(world.banking.snapshotMonths!.length).toBeLessThanOrEqual(2);
    expect(world.banking.snapshotMonths!.every((row) => world.time.tick - row.tick < 2)).toBe(true);

    // B. 财政窗口 2 个月：保留明细都在窗口内（当月必然完整），更早已聚合。
    expect(world.fiscal.archivedLedger).toBeDefined();
    expect(world.fiscal.archivedLedger!.length).toBeGreaterThan(0);
    expect(world.fiscal.ledger.every((entry) => world.time.tick - entry.tick < 2)).toBe(true);
    const currentTickEntries = world.fiscal.ledger.filter((entry) => entry.tick === world.time.tick);
    expect(currentTickEntries.length).toBeGreaterThan(0);

    // C. 选举一年窗口：开局 3 条初始记录在 t1 后即归档（12→1 月测试窗口）。
    expect(world.politics.elections).toHaveLength(0);
    expect(world.politics.electionYears).toBeDefined();
    expect(world.politics.electionYears!.reduce((sum, row) => sum + row.count, 0)).toBe(3);

    // D. lifecycle 不归档：再推进 1 月后，直接再执行一次历史治理，lifecycle 与序号完全不变。
    //    （真实推进中 foundings 的 maxHistory 裁剪由 lifecycle.ts 自身负责，与历史治理无关。）
    const result = sim.tick();
    expect(result.ok).toBe(true);
    expect(checkInvariants(world)).toEqual([]);
    const lifecycleSnapshot = (): string =>
      JSON.stringify({
        foundings: world.lifecycle.foundings,
        liquidations: world.lifecycle.liquidations,
        nextFoundingNumber: world.lifecycle.nextFoundingNumber,
        nextLiquidationNumber: world.lifecycle.nextLiquidationNumber,
      });
    const lifecycleBefore = lifecycleSnapshot();
    const directReport = applyHistoryPolicy(world, shortWindowConfig, []);
    expect(lifecycleSnapshot()).toBe(lifecycleBefore);
    // 本月 tick 内已治理过：直接再执行不新增任何归档（安全时点幂等）。
    expect(directReport.fiscal.archived).toBe(0);
    expect(directReport.bankingSnapshots.monthsAdded).toBe(0);
    expect(directReport.politics.electionsArchived).toBe(0);

    // E. 存档往返（当前 v9/v10 过渡期用既有 serialize/parse）：归档字段全部保留。
    const parsed = parseSave(serializeSave(world));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || !parsed.world) throw new Error(parsed.error ?? '存档解析失败');
    const restored = parsed.world;
    expect(restored.banking.snapshotMonths).toEqual(world.banking.snapshotMonths);
    expect(restored.banking.snapshots).toEqual(world.banking.snapshots);
    expect(restored.fiscal.archivedLedger).toEqual(world.fiscal.archivedLedger);
    expect(restored.politics.electionYears).toEqual(world.politics.electionYears);
    expect(restored.governance.motionYears).toEqual(world.governance.motionYears);

    // F. 读档后继续推进：与直接推进逐状态等价（normalize 掉 JSON 丢弃 undefined 的差异）。
    //    做法：直接推进 6 月 → 存档读档 → 再推进 1 月；与直接推进 7 月的世界逐字段相等。
    const directSim = Simulation.create(shortWindowConfig);
    for (let month = 0; month < 6; month += 1) {
      expect(directSim.tick().ok).toBe(true);
    }
    const savedAt6 = parseSave(serializeSave(directSim.state));
    expect(savedAt6.ok).toBe(true);
    if (!savedAt6.ok || !savedAt6.world) throw new Error(savedAt6.error ?? '第 6 月存档解析失败');
    const resumedSim = new Simulation(savedAt6.world, shortWindowConfig);
    expect(resumedSim.tick().ok).toBe(true);
    expect(directSim.tick().ok).toBe(true);
    expect(resumedSim.state.time).toEqual(directSim.state.time);
    expect(resumedSim.state.rngState).toBe(directSim.state.rngState);
    expect(JSON.parse(JSON.stringify(resumedSim.state))).toEqual(
      JSON.parse(JSON.stringify(directSim.state)),
    );
  });
});
