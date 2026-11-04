// 批次3/4：居民消费预算（四层口径）+ 群体消费贷款 + 迁移债务守恒。
//
// 口径来源：DECISIONS v1.4 #24/#35/#38/#39/#40、任务书 §5、IMPLEMENTATION §9。
// 断言统一带浮点容差；只写测试，不改产品代码。

import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation/core/simulation';
import { DEMO_CONFIG } from '../src/data/config';
import type { City, HouseholdGroup, WorldState } from '../src/simulation/contracts/types';
import { round2 } from '../src/simulation/core/math';
import { checkInvariants } from '../src/simulation/core/invariants';
import { parseSave, serializeSave } from '../src/simulation/core/save';
import { createWorldLedgers } from '../src/simulation/markets/markets';
import { runConsumerMarket } from '../src/simulation/markets/consumer';
import {
  borrowForConsumption,
  householdAssetBase,
  householdConsumerBudgetSnapshot,
  householdCreditLimit,
  householdOutstanding,
  repayHouseholdLoans,
  transferHouseholdDebtsForMigration,
} from '../src/simulation/population/household-finance';
import { depositAccountFor } from '../src/simulation/banking/banking';
import { householdGroupsOfCity } from '../src/simulation/population/household-groups';

const CONFIG = DEMO_CONFIG;
const TOL = 0.05;

function newWorld(): WorldState {
  return Simulation.create().state;
}

function cityAt(world: WorldState, index = 0): City {
  const city = world.cities[index];
  if (!city) throw new Error(`缺少第 ${index} 个城市`);
  return city;
}

function groupOf(world: WorldState, city: City, occupation: HouseholdGroup['occupation']): HouseholdGroup {
  const group = householdGroupsOfCity(world, city.id).find(
    (entry) => entry.occupation === occupation,
  );
  if (!group) throw new Error(`缺少群体：${city.id}/${occupation}`);
  return group;
}

function resetCityHouseholds(world: WorldState, city: City): void {
  for (const group of householdGroupsOfCity(world, city.id)) {
    group.cash = 0;
    group.lastMonth.income = 0;
    group.lastMonth.consumption = 0;
    group.lastMonth.desiredConsumption = 0;
    group.lastMonth.loanDrawn = 0;
    group.lastMonth.loanFinancedConsumption = 0;
    group.lastMonth.unmetFunding = 0;
    // v0.9 T1：存款可提取补足基本消费，这里清零存款并清掉提取统计，保持“纯现金预算”用例的口径。
    group.lastMonth.depositWithdrawn = 0;
    const account = depositAccountFor(world, { kind: 'household', id: group.id });
    if (account) account.balance = 0;
  }
}

function zeroConsumerStock(world: WorldState): void {
  for (const company of world.companies) {
    for (const good of Object.keys(company.inventory)) {
      company.inventory[good as keyof typeof company.inventory] = 0;
    }
  }
}

describe('居民消费预算：四层口径（#39/#40/#26）', () => {
  it('现金预算 = min(现金, 0.8×上月可支配收入 + 0.05×现金)，且 effectiveBudget 不含可借额度', () => {
    const world = newWorld();
    const city = cityAt(world);
    resetCityHouseholds(world, city);
    const group = groupOf(world, city, 'production');
    group.cash = 10_000;
    group.lastMonth.income = 20_000;

    const snapshot = householdConsumerBudgetSnapshot(world, group, CONFIG, world.time.tick);
    expect(snapshot.incomeComponent).toBe(16_000);
    expect(snapshot.cashComponent).toBe(500);
    expect(snapshot.referenceSpend).toBe(16_500);
    expect(snapshot.cashBudget).toBe(10_000);
    // #26：有效预算=现金预算，可借额度单列，不并入有效需求。
    expect(snapshot.effectiveBudget).toBe(snapshot.cashBudget);
    expect(snapshot.loanAvailable).toBeGreaterThanOrEqual(0);
    expect(group.lastMonth.budget).toBe(10_000);

    // 现金高于参考消费额时，以参考消费额为上限。
    group.cash = 100_000;
    group.lastMonth.income = 1_000;
    const second = householdConsumerBudgetSnapshot(world, group, CONFIG, world.time.tick);
    expect(second.referenceSpend).toBe(round2(1_000 * 0.8 + 100_000 * 0.05));
    expect(second.cashBudget).toBe(second.referenceSpend);
  });

  it('供给不足不借多余资金：本地无货时借不到钱，缺口记供给缺口而非资金缺口', () => {
    const world = newWorld();
    const city = cityAt(world);
    resetCityHouseholds(world, city);
    zeroConsumerStock(world);
    const group = groupOf(world, city, 'production');
    group.cash = 5_000;

    const result = runConsumerMarket(world, city, createWorldLedgers(world)[city.id]!, CONFIG);
    const entry = result.byGroup![group.id]!;
    expect(entry.spend).toBe(0);
    expect(entry.loanFinanced ?? 0).toBe(0);
    expect(world.householdFinance?.loans ?? []).toHaveLength(0);
    expect(entry.unmetFunding ?? 0).toBe(0);
    // 有效需求全部成为供给缺口。
    const unmetTotal = Object.values(entry.unmet).reduce((total, value) => total + value, 0);
    expect(unmetTotal).toBeGreaterThan(0);
  });

  it('现金为 0 但有授信时：现金预算为 0，成交全部由消费贷融资，且贷款不计收入', () => {
    const world = newWorld();
    const city = cityAt(world);
    resetCityHouseholds(world, city);
    const group = groupOf(world, city, 'production');
    const incomeBefore = group.lastMonth.income;

    const result = runConsumerMarket(world, city, createWorldLedgers(world)[city.id]!, CONFIG);
    const entry = result.byGroup![group.id]!;
    expect(entry.budget).toBe(0);
    expect(entry.spend).toBeGreaterThan(0);
    expect(entry.loanFinanced ?? 0).toBeCloseTo(entry.spend, 2);
    expect(group.lastMonth.loanDrawn ?? 0).toBeGreaterThan(0);
    // 真实债务不计收入：收入口径不变。
    expect(group.lastMonth.income).toBe(incomeBefore);
    expect(entry.budget).toBe(0);
  });
});

describe('居民群体消费贷款：额度、冻结与还款（#24/#35/#38）', () => {
  it('额度 = max(0, 财产基准×0.5 − 未偿本金)，且单笔最低 100、每月每群体最多 1 笔', () => {
    const world = newWorld();
    const city = cityAt(world);
    const group = groupOf(world, city, 'management');
    const assetBase = householdAssetBase(world, group, CONFIG);
    expect(assetBase).toBeGreaterThan(0);
    expect(householdCreditLimit(world, group, CONFIG)).toBeCloseTo(round2(assetBase * 0.5), 2);

    // 低于单笔最低：拒绝。
    expect(borrowForConsumption(world, group, CONFIG, 50, 0).ok).toBe(false);
    // 超过额度：拒绝。
    const limit = householdCreditLimit(world, group, CONFIG);
    expect(borrowForConsumption(world, group, CONFIG, round2(limit + 1), 0).ok).toBe(false);
    // 正常借款：成功且额度按未偿扣减。
    const amount = Math.min(limit, 1_000);
    const first = borrowForConsumption(world, group, CONFIG, amount, 0);
    expect(first.ok).toBe(true);
    expect(householdOutstanding(world, group.id)).toBe(amount);
    // 借入的现金也计入财产基准（#38 口径），因此额度按 0.5×(基准+借款) − 借款 计。
    expect(householdCreditLimit(world, group, CONFIG)).toBeCloseTo(
      round2(assetBase * 0.5 - amount * 0.5),
      2,
    );
    // 同月第二笔：拒绝（maxLoansPerGroupPerMonth=1）。
    expect(borrowForConsumption(world, group, CONFIG, 100, 0).ok).toBe(false);
  });

  it('存在违约或连续欠付 ≥2 月时新授信冻结（#35）', () => {
    const world = newWorld();
    const city = cityAt(world);
    const group = groupOf(world, city, 'management');
    const borrowed = borrowForConsumption(world, group, CONFIG, 1_000, 0);
    expect(borrowed.ok).toBe(true);
    if (!borrowed.loan) throw new Error('缺少贷款合同');

    borrowed.loan.missedPayments = 2;
    expect(householdCreditLimit(world, group, CONFIG)).toBe(0);
    expect(borrowForConsumption(world, group, CONFIG, 100, 1).ok).toBe(false);

    // 违约合同同样冻结；结清后下个月结恢复（这里直接验证条件函数）。
    borrowed.loan.missedPayments = 0;
    borrowed.loan.status = 'defaulted';
    expect(householdCreditLimit(world, group, CONFIG)).toBe(0);
    borrowed.loan.status = 'repaid';
    expect(householdCreditLimit(world, group, CONFIG)).toBeGreaterThan(0);
  });

  it('等额本金 24 期：先息后本、宽限 1 月内不违约、超宽限转 defaulted', () => {
    const world = newWorld();
    const city = cityAt(world);
    const group = groupOf(world, city, 'management');
    group.cash = 100_000;
    const borrowed = borrowForConsumption(world, group, CONFIG, 2_400, 0);
    expect(borrowed.ok).toBe(true);
    const loan = borrowed.loan!;

    // 第 1 期：利息 = 2400×0.006 = 14.4，本金 100。
    group.cash = 10_000;
    repayHouseholdLoans(world, CONFIG, 1, world.log);
    expect(loan.outstanding).toBe(2_300);
    expect(loan.paidInterest).toBeCloseTo(14.4, 2);
    expect(loan.paidPrincipal).toBeCloseTo(100, 2);
    expect(loan.nextDueTick).toBe(2);

    // 同一 tick 重放不重复扣款。
    const cashAfterFirst = group.cash;
    repayHouseholdLoans(world, CONFIG, 1, world.log);
    expect(group.cash).toBeCloseTo(cashAfterFirst, 2);

    // 连续 2 个月不还（现金 0）：宽限 1 个月→第 2 次欠付标记违约。
    group.cash = 0;
    repayHouseholdLoans(world, CONFIG, 2, world.log);
    repayHouseholdLoans(world, CONFIG, 3, world.log);
    expect(loan.status).toBe('defaulted');
    expect(loan.missedPayments).toBeGreaterThanOrEqual(2);

    // 补钱后继续还，最终结清转 repaid（欠付清零后）。
    group.cash = 100_000;
    for (let tick = 4; tick <= 40; tick += 1) repayHouseholdLoans(world, CONFIG, tick, world.log);
    expect(loan.outstanding).toBe(0);
    expect(loan.status).toBe('repaid');
    expect(checkInvariants(world).filter((problem) => problem.includes('居民')).length).toBe(0);
  });

  it('存档往返：消费贷合同、预算快照与统计字段可完整还原', () => {
    const world = newWorld();
    const city = cityAt(world);
    const group = groupOf(world, city, 'management');
    borrowForConsumption(world, group, CONFIG, 1_200, 0);
    householdConsumerBudgetSnapshot(world, group, CONFIG, 0);
    const text = serializeSave(world, '2026-11-02T00:00:00.000Z');
    const parsed = parseSave(text);
    expect(parsed.ok, parsed.error).toBe(true);
    const restored = parsed.world!;
    const restoredGroup = groupOf(restored, cityAt(restored), 'management');
    expect(householdOutstanding(restored, restoredGroup.id)).toBe(1_200);
    expect(restored.householdFinance?.budgets.length).toBeGreaterThan(0);
    expect(restoredGroup.lastMonth.loanDrawn ?? 0).toBe(1_200);
  });
});

describe('迁移债务守恒：消费贷随人口迁移、两城合计未偿本金不变', () => {
  it('整群迁出时贷款改挂目标群体，跨城未偿合计守恒', () => {
    const world = newWorld();
    const from = cityAt(world, 0);
    const to = cityAt(world, 1);
    const sourceGroup = groupOf(world, from, 'unemployed');
    sourceGroup.cash = 50_000;
    const sourcePeople = sourceGroup.people;
    expect(sourcePeople).toBeGreaterThan(0);

    const borrowed = borrowForConsumption(world, sourceGroup, CONFIG, 2_000, 0);
    expect(borrowed.ok).toBe(true);
    const before = (world.householdFinance?.loans ?? []).reduce(
      (total, loan) => total + loan.outstanding,
      0,
    );

    // 整群失业群体迁出（非劳动力 0，劳动力=人数），债务应全部改挂目标城同职业群体。
    transferHouseholdDebtsForMigration(world, CONFIG, from.id, to.id, sourcePeople, sourcePeople, 0);
    const destination = groupOf(world, to, 'unemployed');
    const after = (world.householdFinance?.loans ?? []).reduce(
      (total, loan) => total + loan.outstanding,
      0,
    );
    expect(after).toBeCloseTo(before, 2);
    expect(
      (world.householdFinance?.loans ?? [])
        .filter((loan) => loan.groupId === destination.id)
        .reduce((total, loan) => total + loan.outstanding, 0),
    ).toBeCloseTo(2_000, 2);
  });

  it('部分迁出时按人均比例分割债务，源与目标合计守恒', () => {
    const world = newWorld();
    const from = cityAt(world, 0);
    const to = cityAt(world, 1);
    const sourceGroup = groupOf(world, from, 'unemployed');
    sourceGroup.cash = 50_000;
    borrowForConsumption(world, sourceGroup, CONFIG, 2_000, 0);

    const people = sourceGroup.people;
    const moving = Math.max(1, Math.floor(people / 2));
    const before = (world.householdFinance?.loans ?? []).reduce(
      (total, loan) => total + loan.outstanding,
      0,
    );
    const moved = transferHouseholdDebtsForMigration(world, CONFIG, from.id, to.id, moving, moving, 0);
    expect(moved.principalMoved).toBeGreaterThan(0);

    const after = (world.householdFinance?.loans ?? []).reduce(
      (total, loan) => total + loan.outstanding,
      0,
    );
    expect(after).toBeCloseTo(before, 2);
    const destination = groupOf(world, to, 'unemployed');
    expect(
      (world.householdFinance?.loans ?? [])
        .filter((loan) => loan.groupId === destination.id)
        .reduce((total, loan) => total + loan.outstanding, 0),
    ).toBeCloseTo(round2((2_000 * moving) / people), 1);
  });
});
