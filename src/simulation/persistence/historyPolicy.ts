// v1.7 §五：历史记录与数据增长治理（月度安全时点执行）。
//
// 设计约束（见 docs/development/SAVE_SYSTEM_DESIGN.md §6/§7 与两份数据归属分析）：
// - 只归档“只读展示历史 / 派生缓存”，不删除未结清义务、有效资产与规则读取窗口；
// - 不读 RNG、不改变结算顺序；只在 Simulation.tick() 的月结安全时点调用一次；
// - 每个归档都有时间边界、幂等键与守恒等式（重复执行不重复累计）；
// - 任何无法证明安全的数组保持现状并在报告 skipped 中注明。
//
// 通用时间口径：一“月”= 一个结算 tick。窗口 N 个月 = 最近 N 个 tick（含当前 tick），
// 即 `now - tick < N` 的记录保留明细、`now - tick >= N` 的记录归档。
//
// 归档字段全部为 optional（contracts/types.ts 追加），旧存档缺省可读；归档明细被移除后
// 由模块化存档的 state 整体持久化（banking/householdFinance/fiscal/bonds/securities/
// governance/politics 的模块 export 直接深拷贝这些顶层字段）。

import type { DemoConfig } from '../../data/config';
import type {
  ArchivedBankLoanYear,
  ArchivedBondPaymentYear,
  ArchivedCreditSnapshotMonth,
  ArchivedElectionYear,
  ArchivedFiscalYear,
  ArchivedHouseholdLoanYear,
  ArchivedMotionYear,
  BondPayment,
  CreditSnapshot,
  FiscalEntry,
  HouseholdLoanContract,
  LoanContract,
  LogEntry,
  Motion,
  StockCandle,
  StockYearCandle,
  WorldState,
} from '../contracts/types';
import { round2 } from '../core/math';

/** 金额比较容差（信用点，1 分）：未偿 <= 该值视为已结清。 */
const MONEY_EPSILON = 0.01;

export interface HistoryPolicyReport {
  /** 执行时的世界 tick。 */
  appliedTick: number;
  /** 配置是否启用（缺省/关闭时其他字段为 0）。 */
  enabled: boolean;
  bankingSnapshots: {
    snapshotsBefore: number;
    snapshotsAfter: number;
    monthsAdded: number;
    monthsPruned: number;
  };
  bankLoans: { archived: number; bucketsAdded: number };
  householdLoans: { archived: number; bucketsAdded: number };
  fiscal: { archived: number; bucketsAdded: number };
  bonds: { archived: number; bucketsAdded: number };
  securities: { monthlyArchived: number; yearBucketsAdded: number; classesTouched: number };
  governance: { motionsArchived: number; bucketsAdded: number };
  politics: { electionsArchived: number; bucketsAdded: number };
  /** 明确不归档的数据与原因（保持现状，供交付说明/审计）。 */
  skipped: { path: string; reason: string }[];
}

/** 历史治理的固定“不归档/保持现有上限”清单（原因可追溯）。 */
const SKIPPED_PATHS: { path: string; reason: string }[] = [
  {
    path: 'lifecycle.foundings / lifecycle.liquidations',
    reason:
      'founding.ts:552-577 用裁剪后的 foundings 数组当“终身”创办计数上限（每企业/每城政府），裁剪会改变规则语义；本轮不归档，后续如需裁剪必须先落终身计数器。',
  },
  {
    path: 'world.history / world.log / world.notifications',
    reason: '保持现有上限裁剪（240/160/120），任务书不要求额外归档。',
  },
  {
    path: 'city.gdpWindow / taxes.historyByCity / policies.checkups|fundingMonths|publicJobsMonths / groups[].lastMonth.income',
    reason: '这些是规则读取窗口（破产判定、AI 预算、政策预留等），不得按展示历史裁剪。',
  },
  {
    path: 'equipmentMarket.maintenanceHistory',
    reason: '归设备模块 owner 维护；本轮未实现其归档（避免与设备维护费模块并发改动冲突），保留现有上限。',
  },
];

function emptyReport(tick: number): HistoryPolicyReport {
  return {
    appliedTick: tick,
    enabled: false,
    bankingSnapshots: { snapshotsBefore: 0, snapshotsAfter: 0, monthsAdded: 0, monthsPruned: 0 },
    bankLoans: { archived: 0, bucketsAdded: 0 },
    householdLoans: { archived: 0, bucketsAdded: 0 },
    fiscal: { archived: 0, bucketsAdded: 0 },
    bonds: { archived: 0, bucketsAdded: 0 },
    securities: { monthlyArchived: 0, yearBucketsAdded: 0, classesTouched: 0 },
    governance: { motionsArchived: 0, bucketsAdded: 0 },
    politics: { electionsArchived: 0, bucketsAdded: 0 },
    skipped: [],
  };
}

type HistoryConfig = DemoConfig['history'];

/** 兼容旧测试/局部 config 替身：缺失 history 段时视为关闭。 */
function historyConfigOf(config: DemoConfig): HistoryConfig | null {
  const history = (config as Partial<DemoConfig> | null | undefined)?.history;
  if (!history || (history as { enabled?: boolean }).enabled === false) return null;
  return history;
}

function positiveMonths(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

interface CalendarMonth {
  year: number;
  month: number;
}

/**
 * tick → 游戏日历（年/月）。以 world.time 为锚点按线性月份外推，兼容旧档
 * （旧档 world.time 已由迁移链修正）；config 缺省 simulation 时退回“每 12 tick 一年”的
 * 兜底口径——只影响归档行的 year 标注，不影响裁剪边界。
 */
function calendarAtTick(world: WorldState, tick: number, config: DemoConfig): CalendarMonth {
  const simulation = (
    config as { simulation?: { startYear?: number; startMonth?: number } } | null | undefined
  )?.simulation;
  const startYear = simulation?.startYear;
  const startMonth = simulation?.startMonth;
  const current = world.time ?? { year: 1, month: 1, tick: 0 };
  if (
    typeof startYear === 'number' &&
    typeof startMonth === 'number' &&
    Number.isFinite(world.time?.tick)
  ) {
    const currentIndex =
      (current.year - startYear) * 12 + (current.month - startMonth);
    const index = currentIndex + (tick - current.tick);
    const year = startYear + Math.floor((startMonth - 1 + index) / 12);
    const month = ((((startMonth - 1 + index) % 12) + 12) % 12) + 1;
    return { year, month };
  }
  const index = Number.isFinite(tick) ? tick : 0;
  return { year: Math.floor(index / 12) + 1, month: (index % 12) + 1 };
}

function ownerKey(owner: { kind?: string; id?: string } | undefined | null): string {
  return `${owner?.kind ?? 'unknown'}:${owner?.id ?? ''}`;
}

function isFiniteTick(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * 贷款“结清/最后活动”tick：取开始月、最后到期月与全部还款流水的最大 tick。
 * 已结清贷款没有单独的 closedTick 字段，用可核验的历史 tick 作为年龄基准（只会偏保守：
 * 提前还款的合同未知实际结清 tick 时按最后应还月计，可能更早归档，但不会早于合同活动）。
 */
function loanRetirementTick(loan: { startTick?: number; nextDueTick?: number; payments?: { tick?: number }[] }): number {
  let best = -Infinity;
  if (isFiniteTick(loan.startTick)) best = Math.max(best, loan.startTick);
  if (isFiniteTick(loan.nextDueTick)) best = Math.max(best, loan.nextDueTick - 1);
  for (const payment of loan.payments ?? []) {
    if (isFiniteTick(payment?.tick)) best = Math.max(best, payment.tick);
  }
  return Number.isFinite(best) ? best : 0;
}

function isRepaidAndSettled(loan: {
  status?: string;
  outstanding?: number;
}): boolean {
  return (
    loan.status === 'repaid' &&
    typeof loan.outstanding === 'number' &&
    Number.isFinite(loan.outstanding) &&
    Math.abs(loan.outstanding) <= MONEY_EPSILON
  );
}

// ---------------------------------------------------------------- A. 银行授信快照

/**
 * A. banking.snapshots：
 * - 规则只读“每主体最新 1 条”（credit.ts:328-338/425-432），故每主体只保留最新一条；
 * - 归档前先把现存快照按 tick 汇总一次写入 snapshotMonths（幂等键 tick），保留最近
 *   config.history.bankingSnapshotMonths 个月；
 * - 守恒：Σ 保留快照 limit/outstanding = 归档前各主体最新一条的对应合计；
 *   Σ 月度汇总 = 归档前各 tick 全部快照（按主体去重）的对应合计。
 */
function archiveBankSnapshots(
  world: WorldState,
  config: DemoConfig,
  history: HistoryConfig,
  now: number,
  report: HistoryPolicyReport,
): void {
  const banking = world.banking;
  if (!banking || !Array.isArray(banking.snapshots)) return;
  const windowMonths = positiveMonths(history.bankingSnapshotMonths, 120);
  const snapshots = banking.snapshots;

  // 1) 现存快照按 tick 汇总（每 tick 每主体只计一次；同 tick 后出现者以 refresh 的覆盖语义为准）。
  const rows: ArchivedCreditSnapshotMonth[] = Array.isArray(banking.snapshotMonths)
    ? banking.snapshotMonths
    : [];
  let monthsAdded = 0;
  if (snapshots.length > 0) {
    const perTick = new Map<number, Map<string, CreditSnapshot>>();
    for (const snapshot of snapshots) {
      if (!snapshot || !isFiniteTick(snapshot.tick)) continue;
      let owners = perTick.get(snapshot.tick);
      if (!owners) {
        owners = new Map<string, CreditSnapshot>();
        perTick.set(snapshot.tick, owners);
      }
      owners.set(ownerKey(snapshot.borrower), snapshot);
    }
    const existingTicks = new Set(rows.map((row) => row.tick));
    const newRows: ArchivedCreditSnapshotMonth[] = [];
    for (const [tick, owners] of [...perTick.entries()].sort((a, b) => a[0] - b[0])) {
      if (existingTicks.has(tick)) continue; // 幂等键：同一 tick 只汇总一次，重复执行不重复累计
      const calendar = calendarAtTick(world, tick, config);
      const byBorrowerKind: ArchivedCreditSnapshotMonth['byBorrowerKind'] = {};
      let totalLimit = 0;
      let totalOutstanding = 0;
      for (const snapshot of owners.values()) {
        const kind = snapshot.borrower?.kind ?? 'unknown';
        const entry = byBorrowerKind[kind] ?? {
          subjects: 0,
          totalLimit: 0,
          totalOutstanding: 0,
        };
        entry.subjects += 1;
        entry.totalLimit = round2(entry.totalLimit + (snapshot.limit ?? 0));
        entry.totalOutstanding = round2(entry.totalOutstanding + (snapshot.outstanding ?? 0));
        byBorrowerKind[kind] = entry;
        totalLimit += snapshot.limit ?? 0;
        totalOutstanding += snapshot.outstanding ?? 0;
      }
      newRows.push({
        tick,
        year: calendar.year,
        month: calendar.month,
        subjects: owners.size,
        totalLimit: round2(totalLimit),
        totalOutstanding: round2(totalOutstanding),
        byBorrowerKind,
      });
      monthsAdded += 1;
    }
    rows.push(...newRows);
  }

  // 2) 月度汇总窗口裁剪（幂等：旧行已不在窗口内时不会重复处理）。
  rows.sort((a, b) => a.tick - b.tick);
  const keptRows = rows.filter(
    (row) => !isFiniteTick(row.tick) || now - row.tick < windowMonths,
  );
  const monthsPruned = rows.length - keptRows.length;
  if (monthsAdded > 0 || monthsPruned > 0 || banking.snapshotMonths !== undefined) {
    banking.snapshotMonths = keptRows;
  }

  // 3) 每主体只保留最新一条（tick 相同取后出现者；与 refreshCreditSnapshots 覆盖语义一致）。
  const snapshotsBefore = snapshots.length;
  if (snapshotsBefore > 0) {
    const latestByOwner = new Map<string, CreditSnapshot>();
    for (const snapshot of snapshots) {
      if (!snapshot || !isFiniteTick(snapshot.tick)) continue;
      const key = ownerKey(snapshot.borrower);
      const current = latestByOwner.get(key);
      if (!current || snapshot.tick >= current.tick) latestByOwner.set(key, snapshot);
    }
    banking.snapshots = [...latestByOwner.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([, snapshot]) => snapshot);
  }
  report.bankingSnapshots = {
    snapshotsBefore,
    snapshotsAfter: banking.snapshots.length,
    monthsAdded,
    monthsPruned,
  };
}

// ---------------------------------------------------------------- B. 已结清贷款

/**
 * B1. banking.loans：仅归档“已结清”（status='repaid'、未偿≈0）且最后活动 tick 超过
 * config.history.closedLoanArchiveMonths 的贷款；未结清/违约/勾销（defaulted/writtenOff）
 * 与缺少可核验字段的记录一律保留（任务书“违约保留”口径）。按 年×借款人类别×用途 聚合：
 * count/principal/paidPrincipal/paidInterest。幂等：归档后明细已移除，重复执行不重复累计。
 */
function archiveClosedBankLoans(
  world: WorldState,
  config: DemoConfig,
  history: HistoryConfig,
  now: number,
  report: HistoryPolicyReport,
): void {
  const banking = world.banking;
  if (!banking || !Array.isArray(banking.loans)) return;
  const windowMonths = positiveMonths(history.closedLoanArchiveMonths, 36);
  const buckets: ArchivedBankLoanYear[] = Array.isArray(banking.archivedLoans)
    ? banking.archivedLoans
    : [];
  const bucketByKey = new Map<string, ArchivedBankLoanYear>();
  for (const bucket of buckets) {
    bucketByKey.set(`${bucket.year}|${bucket.borrowerKind}|${bucket.purpose}`, bucket);
  }
  const kept: LoanContract[] = [];
  let archived = 0;
  let bucketsAdded = 0;
  for (const loan of banking.loans) {
    if (
      !loan ||
      typeof loan.id !== 'string' ||
      typeof loan.purpose !== 'string' ||
      !loan.borrower ||
      !isRepaidAndSettled(loan)
    ) {
      kept.push(loan);
      continue;
    }
    const retirementTick = loanRetirementTick(loan);
    if (now - retirementTick < windowMonths) {
      kept.push(loan);
      continue;
    }
    const calendar = calendarAtTick(world, retirementTick, config);
    const borrowerKind = loan.borrower.kind ?? 'company';
    const key = `${calendar.year}|${borrowerKind}|${loan.purpose}`;
    let bucket = bucketByKey.get(key);
    if (!bucket) {
      bucket = {
        year: calendar.year,
        borrowerKind,
        purpose: loan.purpose,
        status: 'repaid',
        count: 0,
        principal: 0,
        paidPrincipal: 0,
        paidInterest: 0,
      };
      bucketByKey.set(key, bucket);
      buckets.push(bucket);
      bucketsAdded += 1;
    }
    bucket.count += 1;
    bucket.principal = round2(bucket.principal + (loan.principal ?? 0));
    bucket.paidPrincipal = round2(bucket.paidPrincipal + (loan.paidPrincipal ?? 0));
    bucket.paidInterest = round2(bucket.paidInterest + (loan.paidInterest ?? 0));
    archived += 1;
  }
  if (archived > 0) {
    buckets.sort(
      (a, b) =>
        a.year - b.year ||
        a.borrowerKind.localeCompare(b.borrowerKind) ||
        a.purpose.localeCompare(b.purpose),
    );
    banking.loans = kept;
    banking.archivedLoans = buckets;
  }
  report.bankLoans = { archived, bucketsAdded };
}

/**
 * B2. householdFinance.loans：口径同 B1（只归档已结清），按 年×城市×状态 聚合，
 * 不保存 groupId——归档后不得引入/保留悬空群体引用。读档兼容基线采用 core/save.ts
 * 的严格口径（城市/群体必须存在）：归档只移除 repaid 明细，不会新增校验失败；
 * 若原世界已有 defaulted 悬空引用，属既有问题（本轮保留并记录），不由归档制造。
 */
function archiveClosedHouseholdLoans(
  world: WorldState,
  config: DemoConfig,
  history: HistoryConfig,
  now: number,
  report: HistoryPolicyReport,
): void {
  const finance = world.householdFinance;
  if (!finance || !Array.isArray(finance.loans)) return;
  const windowMonths = positiveMonths(history.closedLoanArchiveMonths, 36);
  const buckets: ArchivedHouseholdLoanYear[] = Array.isArray(finance.archivedLoans)
    ? finance.archivedLoans
    : [];
  const bucketByKey = new Map<string, ArchivedHouseholdLoanYear>();
  for (const bucket of buckets) {
    bucketByKey.set(`${bucket.year}|${bucket.cityId}|${bucket.status}`, bucket);
  }
  const kept: HouseholdLoanContract[] = [];
  let archived = 0;
  let bucketsAdded = 0;
  for (const loan of finance.loans) {
    if (
      !loan ||
      typeof loan.id !== 'string' ||
      typeof loan.cityId !== 'string' ||
      !isRepaidAndSettled(loan)
    ) {
      kept.push(loan);
      continue;
    }
    const retirementTick = loanRetirementTick(loan);
    if (now - retirementTick < windowMonths) {
      kept.push(loan);
      continue;
    }
    const calendar = calendarAtTick(world, retirementTick, config);
    const key = `${calendar.year}|${loan.cityId}|${loan.status}`;
    let bucket = bucketByKey.get(key);
    if (!bucket) {
      bucket = {
        year: calendar.year,
        cityId: loan.cityId,
        status: loan.status,
        count: 0,
        principal: 0,
        paidPrincipal: 0,
        paidInterest: 0,
      };
      bucketByKey.set(key, bucket);
      buckets.push(bucket);
      bucketsAdded += 1;
    }
    bucket.count += 1;
    bucket.principal = round2(bucket.principal + (loan.principal ?? 0));
    bucket.paidPrincipal = round2(bucket.paidPrincipal + (loan.paidPrincipal ?? 0));
    bucket.paidInterest = round2(bucket.paidInterest + (loan.paidInterest ?? 0));
    archived += 1;
  }
  if (archived > 0) {
    buckets.sort(
      (a, b) =>
        a.year - b.year || a.cityId.localeCompare(b.cityId) || a.status.localeCompare(b.status),
    );
    finance.loans = kept;
    finance.archivedLoans = buckets;
  }
  report.householdLoans = { archived, bucketsAdded };
}

// ---------------------------------------------------------------- C. 财政流水

/**
 * C. fiscal.ledger：保留最近 config.history.fiscalDetailMonths 个月明细（当月必然完整：
 * age=0 永远在窗口内），更早按 城市×年×kind 聚合 amount/count。幂等键 year+cityId+kind；
 * 余额语义不在 ledger（余额 = city.treasury），聚合不改变任何余额。
 */
function archiveFiscalLedger(
  world: WorldState,
  config: DemoConfig,
  history: HistoryConfig,
  now: number,
  report: HistoryPolicyReport,
): void {
  const fiscal = world.fiscal;
  if (!fiscal || !Array.isArray(fiscal.ledger)) return;
  const windowMonths = positiveMonths(history.fiscalDetailMonths, 36);
  const buckets: ArchivedFiscalYear[] = Array.isArray(fiscal.archivedLedger)
    ? fiscal.archivedLedger
    : [];
  const bucketByKey = new Map<string, ArchivedFiscalYear>();
  for (const bucket of buckets) {
    bucketByKey.set(`${bucket.year}|${bucket.cityId}|${bucket.kind}`, bucket);
  }
  const kept: FiscalEntry[] = [];
  let archived = 0;
  let bucketsAdded = 0;
  for (const entry of fiscal.ledger) {
    if (
      !entry ||
      !isFiniteTick(entry.tick) ||
      typeof entry.cityId !== 'string' ||
      typeof entry.kind !== 'string' ||
      typeof entry.amount !== 'number' ||
      !Number.isFinite(entry.amount)
    ) {
      kept.push(entry);
      continue;
    }
    if (now - entry.tick < windowMonths) {
      kept.push(entry);
      continue;
    }
    const calendar = calendarAtTick(world, entry.tick, config);
    const key = `${calendar.year}|${entry.cityId}|${entry.kind}`;
    let bucket = bucketByKey.get(key);
    if (!bucket) {
      bucket = { year: calendar.year, cityId: entry.cityId, kind: entry.kind, count: 0, amount: 0 };
      bucketByKey.set(key, bucket);
      buckets.push(bucket);
      bucketsAdded += 1;
    }
    bucket.count += 1;
    bucket.amount = round2(bucket.amount + entry.amount);
    archived += 1;
  }
  if (archived > 0) {
    buckets.sort(
      (a, b) => a.year - b.year || a.cityId.localeCompare(b.cityId) || a.kind.localeCompare(b.kind),
    );
    fiscal.ledger = kept;
    fiscal.archivedLedger = buckets;
  }
  report.fiscal = { archived, bucketsAdded };
}

// ---------------------------------------------------------------- D. 债券兑付流水

/**
 * D. bonds.payments：保留最近 config.history.bondPaymentDetailMonths 个月明细；更早按
 * 批次×持有人×年×kind 聚合 principalPaid/interestPaid/count（含银行垫付笔数/金额）。
 * 幂等键 year+issuanceId+holderKind+holderId+kind；同 tick 兑付幂等键（bonds.ts:644-658）
 * 所需记录都在窗口内（当前 tick age=0），不受归档影响。
 */
function archiveBondPayments(
  world: WorldState,
  config: DemoConfig,
  history: HistoryConfig,
  now: number,
  report: HistoryPolicyReport,
): void {
  const bonds = world.bonds;
  if (!bonds || !Array.isArray(bonds.payments)) return;
  const windowMonths = positiveMonths(history.bondPaymentDetailMonths, 36);
  const buckets: ArchivedBondPaymentYear[] = Array.isArray(bonds.archivedPayments)
    ? bonds.archivedPayments
    : [];
  const bucketByKey = new Map<string, ArchivedBondPaymentYear>();
  for (const bucket of buckets) {
    bucketByKey.set(
      `${bucket.year}|${bucket.issuanceId}|${bucket.holderKind}|${bucket.holderId}|${bucket.kind}`,
      bucket,
    );
  }
  const kept: BondPayment[] = [];
  let archived = 0;
  let bucketsAdded = 0;
  for (const payment of bonds.payments) {
    if (
      !payment ||
      !isFiniteTick(payment.tick) ||
      typeof payment.issuanceId !== 'string' ||
      typeof payment.cityId !== 'string' ||
      !payment.holder ||
      typeof payment.kind !== 'string'
    ) {
      kept.push(payment);
      continue;
    }
    if (now - payment.tick < windowMonths) {
      kept.push(payment);
      continue;
    }
    const calendar = calendarAtTick(world, payment.tick, config);
    const holderKind = payment.holder.kind ?? 'player';
    const holderId = payment.holder.id ?? '';
    const key = `${calendar.year}|${payment.issuanceId}|${holderKind}|${holderId}|${payment.kind}`;
    let bucket = bucketByKey.get(key);
    if (!bucket) {
      bucket = {
        year: calendar.year,
        issuanceId: payment.issuanceId,
        cityId: payment.cityId,
        holderKind,
        holderId,
        kind: payment.kind,
        count: 0,
        principalPaid: 0,
        interestPaid: 0,
        bankAdvancedCount: 0,
        bankAdvancedAmount: 0,
      };
      bucketByKey.set(key, bucket);
      buckets.push(bucket);
      bucketsAdded += 1;
    }
    bucket.count += 1;
    bucket.principalPaid = round2(bucket.principalPaid + (payment.principalPaid ?? 0));
    bucket.interestPaid = round2(bucket.interestPaid + (payment.interestPaid ?? 0));
    if (payment.fundedByBankAdvance) {
      bucket.bankAdvancedCount += 1;
      bucket.bankAdvancedAmount = round2(
        bucket.bankAdvancedAmount + (payment.principalPaid ?? 0) + (payment.interestPaid ?? 0),
      );
    }
    archived += 1;
  }
  if (archived > 0) {
    buckets.sort(
      (a, b) =>
        a.year - b.year ||
        a.issuanceId.localeCompare(b.issuanceId) ||
        a.holderKind.localeCompare(b.holderKind) ||
        a.holderId.localeCompare(b.holderId) ||
        a.kind.localeCompare(b.kind),
    );
    bonds.payments = kept;
    bonds.archivedPayments = buckets;
  }
  report.bonds = { archived, bucketsAdded };
}

// ---------------------------------------------------------------- E. 股票月线 → 年度 OHLCV

/** 把一组真实月线增量合并进某年的年度 OHLCV（幂等键 year：同一年只增量合并，不重复计数）。 */
function mergeStockYearCandles(row: StockYearCandle, candles: StockCandle[]): void {
  for (const candle of candles) {
    if (!Number.isFinite(row.firstTick) || row.months <= 0) {
      row.open = candle.open;
      row.high = candle.high;
      row.low = candle.low;
      row.close = candle.close;
      row.volume = candle.volume;
      row.trades = candle.trades;
      row.months = 1;
      row.firstTick = candle.tick;
      row.lastTick = candle.tick;
      continue;
    }
    if (candle.tick < row.firstTick) {
      row.firstTick = candle.tick;
      row.open = candle.open;
    }
    if (candle.tick > row.lastTick) {
      row.lastTick = candle.tick;
      row.close = candle.close;
    } else if (candle.tick === row.lastTick) {
      row.close = candle.close;
    }
    row.high = round2(Math.max(row.high, candle.high));
    row.low = round2(Math.min(row.low, candle.low));
    row.volume = round2(row.volume + candle.volume);
    row.trades += candle.trades;
    row.months += 1;
  }
}

/**
 * E. securities.history：每类股份保留最近 config.history.stockMonthlyMonths 个月月线；
 * 更早按日历年聚合真实 OHLCV（open=该年首根月线 open、high/low=区间极值、close=末根 close、
 * volume/trades=合计、months=参与汇总的真实月线条数）。无成交月本就不生成 K 线，
 * 聚合不补 0 不造假。退市企业条目保留规则不变（仅裁剪其 K 线窗口）。
 */
function aggregateStockCandles(
  world: WorldState,
  config: DemoConfig,
  history: HistoryConfig,
  now: number,
  report: HistoryPolicyReport,
): void {
  const securities = world.securities;
  if (!securities || !Array.isArray(securities.history)) return;
  const windowMonths = positiveMonths(history.stockMonthlyMonths, 120);
  let monthlyArchived = 0;
  let yearBucketsAdded = 0;
  let classesTouched = 0;
  for (const entry of securities.history) {
    if (!entry || !Array.isArray(entry.candles) || entry.candles.length === 0) continue;
    const oldCandles: StockCandle[] = [];
    const kept: StockCandle[] = [];
    for (const candle of entry.candles) {
      if (!candle || !isFiniteTick(candle.tick)) {
        kept.push(candle);
        continue;
      }
      if (now - candle.tick >= windowMonths) oldCandles.push(candle);
      else kept.push(candle);
    }
    if (oldCandles.length === 0) continue;
    oldCandles.sort((a, b) => a.tick - b.tick);
    const yearly: StockYearCandle[] = Array.isArray(entry.yearlyCandles)
      ? entry.yearlyCandles
      : [];
    const yearByTick = new Map<number, number>();
    for (const candle of oldCandles) {
      yearByTick.set(candle.tick, calendarAtTick(world, candle.tick, config).year);
    }
    const grouped = new Map<number, StockCandle[]>();
    for (const candle of oldCandles) {
      const year = yearByTick.get(candle.tick) ?? calendarAtTick(world, candle.tick, config).year;
      const group = grouped.get(year);
      if (group) group.push(candle);
      else grouped.set(year, [candle]);
    }
    for (const [year, candles] of [...grouped.entries()].sort((a, b) => a[0] - b[0])) {
      let row = yearly.find((candidate) => candidate.year === year);
      if (!row) {
        row = {
          year,
          open: 0,
          high: 0,
          low: 0,
          close: 0,
          volume: 0,
          trades: 0,
          months: 0,
          firstTick: Number.POSITIVE_INFINITY,
          lastTick: Number.NEGATIVE_INFINITY,
        };
        yearly.push(row);
        yearBucketsAdded += 1;
      }
      candles.sort((a, b) => a.tick - b.tick);
      mergeStockYearCandles(row, candles);
    }
    yearly.sort((a, b) => a.year - b.year);
    entry.candles = kept.sort((a, b) => a.tick - b.tick);
    entry.yearlyCandles = yearly;
    monthlyArchived += oldCandles.length;
    classesTouched += 1;
  }
  report.securities = { monthlyArchived, yearBucketsAdded, classesTouched };
}

// ---------------------------------------------------------------- F. 治理议案 / 选举

/**
 * F1. governance.motions：只归档“终态”（status != 'open' 且有 decidedTick/closesAtTick），
 * 且决议后超过 config.history.governanceArchiveMonths 个月的记录；按 年×公司×kind 聚合
 * count/passed/rejected/二元议案票数（选任议案票数按候选人不汇总）。open 议案永不归档；
 * 幂等键 year+companyId+kind。公司名取归档时快照，企业退出后仍可识别。
 */
function archiveGovernanceMotions(
  world: WorldState,
  config: DemoConfig,
  history: HistoryConfig,
  now: number,
  report: HistoryPolicyReport,
): void {
  const governance = world.governance;
  if (!governance || !Array.isArray(governance.motions)) return;
  const windowMonths = positiveMonths(history.governanceArchiveMonths, 12);
  const buckets: ArchivedMotionYear[] = Array.isArray(governance.motionYears)
    ? governance.motionYears
    : [];
  const bucketByKey = new Map<string, ArchivedMotionYear>();
  for (const bucket of buckets) {
    bucketByKey.set(`${bucket.year}|${bucket.companyId}|${bucket.kind}`, bucket);
  }
  const knownKinds = new Set(['dividendPolicy', 'operatorAppointment', 'operatorElection']);
  const kept: Motion[] = [];
  let archived = 0;
  let bucketsAdded = 0;
  for (const motion of governance.motions) {
    if (!motion || typeof motion.id !== 'string' || typeof motion.companyId !== 'string') {
      kept.push(motion);
      continue;
    }
    const decidedTick =
      isFiniteTick(motion.decidedTick)
        ? motion.decidedTick
        : motion.status !== 'open' && isFiniteTick(motion.closesAtTick)
          ? motion.closesAtTick
          : null;
    if (motion.status === 'open' || decidedTick === null || !knownKinds.has(motion.kind)) {
      kept.push(motion);
      continue;
    }
    if (now - decidedTick < windowMonths) {
      kept.push(motion);
      continue;
    }
    const calendar = calendarAtTick(world, decidedTick, config);
    const key = `${calendar.year}|${motion.companyId}|${motion.kind}`;
    let bucket = bucketByKey.get(key);
    if (!bucket) {
      const companyName =
        world.companies.find((company) => company.id === motion.companyId)?.name ??
        '（企业已退出）';
      bucket = {
        year: calendar.year,
        companyId: motion.companyId,
        companyName,
        kind: motion.kind,
        count: 0,
        passed: 0,
        rejected: 0,
        votesFor: 0,
        votesAgainst: 0,
        decidedFirstTick: decidedTick,
        decidedLastTick: decidedTick,
      };
      bucketByKey.set(key, bucket);
      buckets.push(bucket);
      bucketsAdded += 1;
    }
    bucket.count += 1;
    if (motion.status === 'passed') bucket.passed += 1;
    else if (motion.status === 'rejected') bucket.rejected += 1;
    bucket.decidedFirstTick = Math.min(bucket.decidedFirstTick, decidedTick);
    bucket.decidedLastTick = Math.max(bucket.decidedLastTick, decidedTick);
    if (motion.kind !== 'operatorElection') {
      for (const vote of motion.votes ?? []) {
        if (!isFiniteTick(vote.votingShares)) continue;
        if (vote.vote === 'for') bucket.votesFor = round2(bucket.votesFor + vote.votingShares);
        else if (vote.vote === 'against') {
          bucket.votesAgainst = round2(bucket.votesAgainst + vote.votingShares);
        }
      }
    }
    archived += 1;
  }
  if (archived > 0) {
    buckets.sort(
      (a, b) =>
        a.year - b.year || a.companyId.localeCompare(b.companyId) || a.kind.localeCompare(b.kind),
    );
    governance.motions = kept;
    governance.motionYears = buckets;
  }
  report.governance = { motionsArchived: archived, bucketsAdded };
}

/**
 * F2. politics.elections：保留最近 config.history.electionArchiveMonths 个月明细；更早按
 * 城市×年 聚合 count/playerWins/末次当选人姓名（winnerId 不归档：候选人每届可能重建）。
 * 幂等键 year+cityId。
 */
function archiveElections(
  world: WorldState,
  config: DemoConfig,
  history: HistoryConfig,
  now: number,
  report: HistoryPolicyReport,
): void {
  const politics = world.politics;
  if (!politics || !Array.isArray(politics.elections)) return;
  const windowMonths = positiveMonths(history.electionArchiveMonths, 12);
  const buckets: ArchivedElectionYear[] = Array.isArray(politics.electionYears)
    ? politics.electionYears
    : [];
  const bucketByKey = new Map<string, ArchivedElectionYear>();
  for (const bucket of buckets) {
    bucketByKey.set(`${bucket.year}|${bucket.cityId}`, bucket);
  }
  const kept: typeof politics.elections = [];
  let archived = 0;
  let bucketsAdded = 0;
  for (const election of politics.elections) {
    if (
      !election ||
      !isFiniteTick(election.tick) ||
      typeof election.cityId !== 'string'
    ) {
      kept.push(election);
      continue;
    }
    if (now - election.tick < windowMonths) {
      kept.push(election);
      continue;
    }
    const calendar = calendarAtTick(world, election.tick, config);
    const key = `${calendar.year}|${election.cityId}`;
    let bucket = bucketByKey.get(key);
    if (!bucket) {
      bucket = {
        year: calendar.year,
        cityId: election.cityId,
        count: 0,
        playerWins: 0,
        lastWinnerName: election.winnerName ?? '',
        lastElectionTick: election.tick,
      };
      bucketByKey.set(key, bucket);
      buckets.push(bucket);
      bucketsAdded += 1;
    }
    bucket.count += 1;
    if (election.playerWon) bucket.playerWins += 1;
    if (election.tick >= bucket.lastElectionTick) {
      bucket.lastElectionTick = election.tick;
      bucket.lastWinnerName = election.winnerName ?? bucket.lastWinnerName;
    }
    archived += 1;
  }
  if (archived > 0) {
    buckets.sort((a, b) => a.year - b.year || a.cityId.localeCompare(b.cityId));
    politics.elections = kept;
    politics.electionYears = buckets;
  }
  report.politics = { electionsArchived: archived, bucketsAdded };
}

// ---------------------------------------------------------------- 入口

/**
 * 在“月度结算全部完成后、下一 tick 之前”的安全时点执行一次历史治理。
 *
 * @param world  当前世界（原地修改历史数组；不触碰权威结算状态、RNG 与时间）
 * @param config 演示参数（读取 config.history 窗口；缺省 history 段视为关闭）
 * @param log    可选：需要追加的日志数组（仅当确实有记录被聚合归档时追加一条 system 摘要）
 * @returns 本次执行的归档量报告（重复执行时各 archived 计数为 0）
 */
export function applyHistoryPolicy(
  world: WorldState,
  config: DemoConfig,
  log: LogEntry[] = [],
): HistoryPolicyReport {
  const now = world.time?.tick;
  const report = emptyReport(isFiniteTick(now) ? now : 0);
  const history = historyConfigOf(config);
  if (!history) return report;
  report.enabled = true;
  const safeNow = isFiniteTick(now) ? now : 0;
  report.skipped = SKIPPED_PATHS.map((entry) => ({ ...entry }));

  archiveBankSnapshots(world, config, history, safeNow, report);
  archiveClosedBankLoans(world, config, history, safeNow, report);
  archiveClosedHouseholdLoans(world, config, history, safeNow, report);
  archiveFiscalLedger(world, config, history, safeNow, report);
  archiveBondPayments(world, config, history, safeNow, report);
  aggregateStockCandles(world, config, history, safeNow, report);
  archiveGovernanceMotions(world, config, history, safeNow, report);
  archiveElections(world, config, history, safeNow, report);

  const archivedRecords =
    report.bankLoans.archived +
    report.householdLoans.archived +
    report.fiscal.archived +
    report.bonds.archived +
    report.securities.monthlyArchived +
    report.governance.motionsArchived +
    report.politics.electionsArchived;
  if (archivedRecords > 0 && Array.isArray(log)) {
    log.push({
      tick: safeNow,
      kind: 'system',
      message:
        `历史治理：已结清贷款 ${report.bankLoans.archived + report.householdLoans.archived} 笔、` +
        `财政流水 ${report.fiscal.archived} 条、债券兑付 ${report.bonds.archived} 条、` +
        `股票月线 ${report.securities.monthlyArchived} 根、已决议案 ${report.governance.motionsArchived} 个、` +
        `选举 ${report.politics.electionsArchived} 条按年度聚合归档（保留窗口内明细不变）。`,
    });
  }
  return report;
}
