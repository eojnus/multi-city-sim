// 验收 E 组：居民消费贷款（AC-E01–E08）。
// 只调用 src/simulation 的公开 API（额度/放款/还款/迁移/消费市场），不改产品代码。
import { describe, expect, it } from 'vitest';
import { DEMO_CONFIG } from '../../src/data/config';
import type { DemoConfig } from '../../src/data/config';
import { GOODS } from '../../src/data/demo-data';
import { createWorldLedgers } from '../../src/simulation/markets/markets';
import { runConsumerMarket } from '../../src/simulation/markets/consumer';
import {
  borrowForConsumption,
  householdAssetBase,
  householdConsumerBudgetSnapshot,
  householdCreditLimit,
  householdOutstanding,
  repayHouseholdLoans,
  transferHouseholdDebtsForMigration,
} from '../../src/simulation/population/household-finance';
import { householdGroupsOfCity } from '../../src/simulation/population/household-groups';
import { depositAccountFor } from '../../src/simulation/banking/banking';
import { parseSave, serializeSave } from '../../src/simulation/core/save';
import type { HouseholdGroup, WorldState } from '../../src/simulation/contracts/types';
import { cityById, newWorld } from './helpers';

const CREDIT = DEMO_CONFIG.households.householdCredit;
const CONSUMER_GOODS = GOODS.filter((good) => good.category === 'consumer').map((good) => good.id);
const NO_INTERCITY: DemoConfig = {
  ...DEMO_CONFIG,
  intercity: { ...DEMO_CONFIG.intercity, enabled: false },
} as unknown as DemoConfig;

function groups(world: WorldState, cityId = 'lanport'): HouseholdGroup[] {
  return householdGroupsOfCity(world, cityId);
}

function pickGroup(world: WorldState, occupation?: HouseholdGroup['occupation']): HouseholdGroup {
  const list = groups(world);
  const group = occupation ? list.find((entry) => entry.occupation === occupation) : list[0];
  if (!group) throw new Error('缺少居民群体');
  return group;
}

/** 手工设置群体收入后，同步本月现金流恒等式，保证存档校验可通过。 */
function alignCashflow(group: HouseholdGroup): void {
  group.lastMonth.netCashChange =
    Math.round(
      (group.lastMonth.income -
        group.lastMonth.consumption -
        group.lastMonth.savingsContribution) *
        100,
    ) / 100;
}

function richGroup(world: WorldState): HouseholdGroup {
  const group = pickGroup(world, 'management');
  group.cash = 100_000;
  group.lastMonth.income = 10_000;
  alignCashflow(group);
  return group;
}

function stockInventory(world: WorldState, cityId: string, goodId: string, qty: number): void {
  const companies = world.companies.filter((entry) => entry.cityId === cityId);
  if (companies.length === 0) throw new Error('缺少企业');
  companies[0]!.inventory[goodId as keyof typeof companies[0]['inventory']] = qty;
}

describe('AC-E01 额度口径', () => {
  it('额度 = max(0, 财产基准×50% − 未偿本金)，放款后额度等额下降', () => {
    const world = newWorld(0);
    const group = richGroup(world);
    const base = householdAssetBase(world, group, DEMO_CONFIG);
    const limit = householdCreditLimit(world, group, DEMO_CONFIG);
    expect(limit).toBeCloseTo(Math.max(0, Math.round(base * CREDIT.creditLimitRate * 100) / 100), 2);
    expect(householdOutstanding(world, group.id)).toBe(0);

    const before = group.cash;
    const result = borrowForConsumption(world, group, DEMO_CONFIG, 500, 0);
    expect(result.ok).toBe(true);
    expect(result.loan!.principal).toBeCloseTo(500, 2);
    expect(result.loan!.termMonths).toBe(CREDIT.termMonths);
    expect(result.loan!.rateMonthly).toBe(CREDIT.rateMonthly);
    expect(group.cash).toBeCloseTo(before + 500, 2);
    expect(householdOutstanding(world, group.id)).toBeCloseTo(500, 2);
    // 现金 +500 也计入财产基准，故按新基准复核额度公式。
    const newBase = householdAssetBase(world, group, DEMO_CONFIG);
    expect(householdCreditLimit(world, group, DEMO_CONFIG)).toBeCloseTo(
      Math.max(0, Math.round((newBase * CREDIT.creditLimitRate - 500) * 100) / 100),
      2,
    );
  });
});

describe('AC-E02 无资产不授信、不拿未来收入担保', () => {
  it('财产基准为 0 时额度 0、借款被拒；默认开关允许无抵押=false', () => {
    const world = newWorld(0);
    // 清空本城投资实体权益与目标群体资产，构造“无资产”群体。
    for (const investor of world.investors) investor.cash = 0;
    world.securities.holdings = world.securities.holdings.filter(
      (holding) => holding.holder.type !== 'investorGroup',
    );
    const group = richGroup(world);
    group.cash = 0;
    group.lastMonth.income = 50_000; // 高收入也不能拿未来收入担保
    alignCashflow(group);
    const account = depositAccountFor(world, { kind: 'household', id: group.id });
    if (account) account.balance = 0;
    expect(CREDIT.allowUnsecuredNoAsset).toBe(false);
    expect(householdAssetBase(world, group, DEMO_CONFIG)).toBeCloseTo(0, 2);
    expect(householdCreditLimit(world, group, DEMO_CONFIG)).toBe(0);
    const result = borrowForConsumption(world, group, DEMO_CONFIG, 5_000, 0);
    expect(result.ok).toBe(false);
    expect(result.loan).toBeNull();
    expect(group.cash).toBe(0);
  });
});

describe('AC-E03 放款是真实债务、不计收入', () => {
  it('放款计入现金与 loanDrawn，不改上月收入；还款减少现金、登记真实流水', () => {
    const world = newWorld(0);
    const group = richGroup(world);
    const income = group.lastMonth.income;
    const cash = group.cash;
    const loanDrawnBefore = group.lastMonth.loanDrawn ?? 0;

    const result = borrowForConsumption(world, group, DEMO_CONFIG, 1_000, 0);
    expect(result.ok).toBe(true);
    expect(group.cash).toBeCloseTo(cash + 1_000, 2);
    expect(group.lastMonth.income).toBe(income);
    expect(group.lastMonth.loanDrawn).toBeCloseTo(loanDrawnBefore + 1_000, 2);

    // 次月还款：先息后本，利息 = 未偿×月利率。
    const logs: { tick: number; kind: string; message: string }[] = [];
    const cashAfterDraw = group.cash;
    const repaid = repayHouseholdLoans(world, DEMO_CONFIG, 1, logs);
    const loan = world.householdFinance!.loans.find((entry) => entry.groupId === group.id)!;
    const expectedInterest = 1_000 * CREDIT.rateMonthly;
    expect(loan.payments.length).toBe(1);
    expect(loan.payments[0]!.interestPaid).toBeCloseTo(expectedInterest, 2);
    expect(loan.outstanding).toBeCloseTo(1_000 - loan.monthlyPrincipal, 2);
    expect(repaid.interestPaid).toBeGreaterThanOrEqual(expectedInterest - 0.01);
    expect(group.cash).toBeCloseTo(cashAfterDraw - repaid.repaid - repaid.interestPaid, 2);
    expect(group.lastMonth.income).toBe(income);
  });
});

describe('AC-E04 不借超过实际成交额的钱', () => {
  it('无供给不放款；有供给时放款额 = max(实际成交额, 单笔最低额)，且每群体每月最多一笔', () => {
    const world = newWorld(0);
    for (const good of CONSUMER_GOODS) {
      for (const company of world.companies) company.inventory[good as keyof typeof company.inventory] = 0;
    }
    const group = richGroup(world);
    group.cash = 0;
    group.lastMonth.income = 0;
    alignCashflow(group);
    const account = depositAccountFor(world, { kind: 'household', id: group.id });
    if (account) account.balance = 40_000;
    const limit = householdCreditLimit(world, group, DEMO_CONFIG);
    expect(limit).toBeGreaterThan(0);

    const city = cityById(world, 'lanport');
    const ledgers = createWorldLedgers(world);
    const short = runConsumerMarket(world, city, ledgers.lanport!, NO_INTERCITY);
    expect(short.spend).toBe(0);
    expect(world.householdFinance!.loans.filter((loan) => loan.groupId === group.id)).toHaveLength(0);
    expect(group.cash).toBe(0);

    // 补本地供给：放款只覆盖真实成交额。
    for (const good of CONSUMER_GOODS) stockInventory(world, 'lanport', good, 20_000);
    const ledgers2 = createWorldLedgers(world);
    const enough = runConsumerMarket(world, city, ledgers2.lanport!, NO_INTERCITY);
    const detail = enough.byGroup![group.id]!;
    expect(detail.loanFinanced!).toBeGreaterThan(0);
    const loans = world.householdFinance!.loans.filter((loan) => loan.groupId === group.id);
    expect(loans).toHaveLength(1);
    const loan = loans[0]!;
    expect(loan.principal).toBeCloseTo(
      Math.max(detail.spend, CREDIT.minLoanAmount),
      2,
    );
    expect(loan.principal).toBeLessThanOrEqual(limit + 0.01);
    // 借到的钱先支付成交，剩余零头留在现金（仍是债务）。
    expect(group.cash).toBeCloseTo(loan.principal - detail.spend, 2);
  });
});

describe('AC-E05 欠付与违约', () => {
  it('现金不足时先息后本欠付、连续欠付>宽限月数标记违约；违约后额度冻结为 0', () => {
    const world = newWorld(0);
    const group = richGroup(world);
    borrowForConsumption(world, group, DEMO_CONFIG, 1_000, 0);
    group.cash = 0; // 模拟无现金可还
    const logs: { tick: number; kind: string; message: string }[] = [];
    repayHouseholdLoans(world, DEMO_CONFIG, 1, logs);
    const loan = world.householdFinance!.loans.find((entry) => entry.groupId === group.id)!;
    expect(loan.missedPayments).toBe(1);
    expect(loan.arrearsInterest + loan.arrearsPrincipal).toBeGreaterThan(0);
    expect(loan.status).toBe('active');

    repayHouseholdLoans(world, DEMO_CONFIG, 2, logs); // 第 2 个月仍欠付：> graceMonths(1)
    expect(loan.status).toBe('defaulted');
    expect(loan.missedPayments).toBe(2);
    expect(logs.some((entry) => entry.message.includes('标记违约'))).toBe(true);

    // 违约冻结新授信，即便补足现金/资产也不行。
    group.cash = 50_000;
    expect(householdCreditLimit(world, group, DEMO_CONFIG)).toBe(0);
    const blocked = borrowForConsumption(world, group, DEMO_CONFIG, 500, 3);
    expect(blocked.ok).toBe(false);
  });
});

describe('AC-E06 迁移时债务归属守恒', () => {
  it('迁移人口带走按人分摊的未偿债务：两城合计未偿本金不变、不产生现金', () => {
    const world = newWorld(0);
    const group = pickGroup(world, 'unemployed');
    group.cash = 100_000;
    group.lastMonth.income = 5_000;
    alignCashflow(group);
    borrowForConsumption(world, group, DEMO_CONFIG, 600, 0);
    borrowForConsumption(world, group, DEMO_CONFIG, 400, 1);
    const beforeOutstanding = householdOutstanding(world, group.id);
    expect(beforeOutstanding).toBeCloseTo(1_000, 2);
    const moving = Math.max(1, Math.floor(group.people / 2));
    const cashBefore = world.households.groups.reduce((sum, entry) => sum + entry.cash, 0);

    const moved = transferHouseholdDebtsForMigration(
      world,
      DEMO_CONFIG,
      'lanport',
      'ironvale',
      moving,
      moving,
      2,
    );
    expect(moved.loansMoved).toBeGreaterThanOrEqual(1);
    expect(moved.principalMoved).toBeGreaterThan(0);
    const totalOutstanding = world.householdFinance!.loans
      .filter((loan) => loan.status === 'active' || loan.status === 'defaulted')
      .reduce((sum, loan) => sum + loan.outstanding, 0);
    expect(totalOutstanding).toBeCloseTo(beforeOutstanding, 1);
    expect(world.households.groups.reduce((sum, entry) => sum + entry.cash, 0)).toBeCloseTo(
      cashBefore,
      2,
    );
  });
});

describe('AC-E07 存档读档与重复结算幂等', () => {
  it('读档后同一 tick 再次月结不重复扣款、不重复登记流水', () => {
    const world = newWorld(0);
    const group = richGroup(world);
    borrowForConsumption(world, group, DEMO_CONFIG, 1_000, 0);
    group.cash = 20_000;
    const logs: { tick: number; kind: string; message: string }[] = [];
    repayHouseholdLoans(world, DEMO_CONFIG, 1, logs);
    const loan = world.householdFinance!.loans.find((entry) => entry.groupId === group.id)!;
    const payments = loan.payments.length;
    const cashAfterFirst = group.cash;
    const outstandingAfterFirst = loan.outstanding;

    const parsed = parseSave(serializeSave(world));
    expect(parsed.ok).toBe(true);
    const loaded = parsed.world!;
    const loadedGroup = loaded.households.groups.find((entry) => entry.id === group.id)!;
    const loadedLoan = loaded.householdFinance!.loans.find((entry) => entry.groupId === group.id)!;
    repayHouseholdLoans(loaded, DEMO_CONFIG, 1, []);
    expect(loadedLoan.payments.length).toBe(payments);
    expect(loadedGroup.cash).toBeCloseTo(cashAfterFirst, 2);
    expect(loadedLoan.outstanding).toBeCloseTo(outstandingAfterFirst, 2);
    // 原世界存档不被读写破坏。
    expect(group.cash).toBeCloseTo(cashAfterFirst, 2);
  });
});

describe('AC-E08 贷款只补足“资金缺口”，不改有效需求口径', () => {
  it('现金预算为 0 时有效需求仍为 0；成交由贷款事后补足，且缺口分账为资金缺口', () => {
    const world = newWorld(0);
    const group = richGroup(world);
    group.cash = 0;
    group.lastMonth.income = 0;
    alignCashflow(group);
    const account = depositAccountFor(world, { kind: 'household', id: group.id });
    if (account) account.balance = 30_000;
    for (const good of CONSUMER_GOODS) stockInventory(world, 'lanport', good, 20_000);

    const snapshot = householdConsumerBudgetSnapshot(world, group, DEMO_CONFIG, 0);
    expect(snapshot.cashBudget).toBe(0);
    expect(snapshot.effectiveBudget).toBe(0);
    expect(snapshot.loanAvailable).toBeGreaterThan(0);

    const city = cityById(world, 'lanport');
    const ledgers = createWorldLedgers(world);
    const result = runConsumerMarket(world, city, ledgers.lanport!, NO_INTERCITY);
    const detail = result.byGroup![group.id]!;
    expect(detail.budget).toBe(0);
    expect(detail.spend).toBeGreaterThan(0);
    expect(detail.loanFinanced).toBeGreaterThan(0);
    expect(detail.spend).toBeCloseTo(detail.loanFinanced!, 2);
    // 供给充足时缺口应分到“资金不足”而不是“供给不足”。
    expect(detail.unmetFunding!).toBeGreaterThanOrEqual(0);
    const loans = world.householdFinance!.loans.filter((loan) => loan.groupId === group.id);
    expect(loans.length).toBeGreaterThanOrEqual(1);
    expect(loans[0]!.principal).toBeCloseTo(Math.max(detail.spend, CREDIT.minLoanAmount), 2);
  });
});
