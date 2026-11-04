// v0.9 T1：居民存款提取消费（现金 → 存款 → 消费贷支付顺序）。
//
// 覆盖：
// - 有存款、无现金时先提取存款再消费，不触发消费贷；
// - 存款不足时才用消费贷补足；
// - 单月提取上限 = 月初存款 × 5%；
// - 基本需求缺口小于上限时只提“真实资金缺口”；
// - 存款提取不创造余额（现金 + 存款 + 真实消费 = 常量）；
// - 存读档往返后提取统计与余额一致；
// - 同月重复结算不重复突破 5% 上限。
//
// 说明：只写测试，不改产品代码；金额断言统一留浮点容差。

import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation/core/simulation';
import { DEMO_CONFIG } from '../src/data/config';
import type { City, HouseholdGroup, WorldState } from '../src/simulation/contracts/types';
import { round2 } from '../src/simulation/core/math';
import { parseSave, serializeSave } from '../src/simulation/core/save';
import { createWorldLedgers, finalizeMarkets } from '../src/simulation/markets/markets';
import { runConsumerMarket } from '../src/simulation/markets/consumer';
import { depositAccountFor } from '../src/simulation/banking/banking';
import {
  householdDepositWithdrawalRemaining,
  withdrawHouseholdDeposit,
} from '../src/simulation/population/household-finance';
import { householdGroupsOfCity } from '../src/simulation/population/household-groups';

const CONFIG = DEMO_CONFIG;
const TOL = 0.05;

function newWorld(): WorldState {
  return Simulation.create().state;
}

function cityOf(world: WorldState, cityId = 'lanport'): City {
  const city = world.cities.find((entry) => entry.id === cityId);
  if (!city) throw new Error(`城市不存在：${cityId}`);
  return city;
}

function groupOf(world: WorldState, city: City, occupation = 'production' as const): HouseholdGroup {
  const group = householdGroupsOfCity(world, city.id).find(
    (entry) => entry.occupation === occupation,
  );
  if (!group) throw new Error(`群体不存在：${city.id}/${occupation}`);
  return group;
}

function depositAccountOf(world: WorldState, group: HouseholdGroup) {
  return depositAccountFor(world, { kind: 'household', id: group.id });
}

/**
 * 隔离被测城市：清空全部群体现金/收入/存款与居民投资实体权益，把 food 价格归一为 1
 * 并给城内企业充足库存，使成交金额只由预算/提取额度决定。
 */
function prepare(world: WorldState, city: City): void {
  for (const group of householdGroupsOfCity(world, city.id)) {
    group.cash = 0;
    group.lastMonth.income = 0;
    group.lastMonth.depositWithdrawn = 0;
    // 只保留被测群体（production）的人口，其余群体无需求，避免它们在零预算下
    // 因 minAffordability 下限而借消费贷，干扰“支付顺序”断言。
    if (group.occupation !== 'production') group.people = 0;
    const account = depositAccountOf(world, group);
    if (account) account.balance = 0;
  }
  // 不动居民投资实体与证券持仓：只清零现金流，避免破坏存档的股本不变量。
  // 消费类商品价格归一为 1，使成交金额可逐项核对（基本需求只算 food）。
  for (const goodId of ['food', 'clothing', 'household'] as const) {
    city.market[goodId].price = 1;
  }
  for (const company of world.companies) {
    if (company.cityId !== city.id) continue;
    company.priceFactor = 1;
    company.inventory.food = 1_000_000;
  }
}

function setDeposit(world: WorldState, group: HouseholdGroup, amount: number): void {
  const account = depositAccountOf(world, group);
  if (!account) throw new Error(`群体缺少存款账户：${group.id}`);
  account.balance = round2(amount);
}

function runMarket(world: WorldState, city: City) {
  const ledgers = createWorldLedgers(world);
  const result = runConsumerMarket(world, city, ledgers[city.id]!, CONFIG);
  return result;
}

describe('居民存款提取消费（v0.9 T1）', () => {
  it('有存款无现金：先提取存款完成消费，不触发消费贷', () => {
    const world = newWorld();
    const city = cityOf(world);
    prepare(world, city);
    const group = groupOf(world, city);
    // 1 人、food 单价 1 → 基本需求成本 26；存款 10000 的 5% 上限为 500。
    group.people = 1;
    setDeposit(world, group, 10_000);
    const loansBefore = world.householdFinance?.loans.length ?? 0;

    const result = runMarket(world, city);
    const entry = result.byGroup![group.id]!;
    const withdrawn = group.lastMonth.depositWithdrawn ?? 0;

    expect(entry.budget).toBeCloseTo(26, 2);
    expect(entry.spend).toBeGreaterThan(0);
    expect(entry.spend).toBeCloseTo(entry.budget, 2);
    // 提取额 = 真实资金缺口（预算由提取补足），且不超过基本需求成本 26。
    expect(withdrawn).toBeGreaterThan(0);
    expect(withdrawn).toBeCloseTo(entry.spend, 2);
    expect(withdrawn).toBeLessThanOrEqual(26 + TOL);
    expect(entry.loanFinanced ?? 0).toBe(0);
    expect(world.householdFinance?.loans.length ?? 0).toBe(loansBefore);
    expect(depositAccountOf(world, group)!.balance).toBeCloseTo(10_000 - withdrawn, 2);
    expect(group.cash).toBeCloseTo(round2(withdrawn - entry.spend), 2);
  });

  it('基本需求缺口小于 5% 上限：只提取真实资金缺口', () => {
    const world = newWorld();
    const city = cityOf(world);
    prepare(world, city);
    const group = groupOf(world, city);
    group.people = 100;
    group.cash = 1_000;
    group.lastMonth.income = 5_000;
    setDeposit(world, group, 40_000);

    const result = runMarket(world, city);
    const entry = result.byGroup![group.id]!;
    const withdrawn = group.lastMonth.depositWithdrawn ?? 0;

    // 常规预算 = min(1000, 0.8×5000 + 0.05×1000) = 1000；基本需求 2600 → 缺口 1600。
    expect(entry.budget).toBeCloseTo(2_600, 2);
    // 只提实际缺口（= 成交额 − 手头现金），且小于 5% 上限 2000。
    expect(withdrawn).toBeCloseTo(entry.spend - 1_000, 1);
    expect(withdrawn).toBeLessThan(round2(40_000 * 0.05));
    expect(entry.loanFinanced ?? 0).toBe(0);
    expect(depositAccountOf(world, group)!.balance).toBeCloseTo(40_000 - withdrawn, 2);
  });

  it('单月提取上限 = 月初存款 × 5%', () => {
    const world = newWorld();
    const city = cityOf(world);
    prepare(world, city);
    const group = groupOf(world, city);
    group.people = 100;
    setDeposit(world, group, 1_000);

    const result = runMarket(world, city);
    const entry = result.byGroup![group.id]!;
    const withdrawn = group.lastMonth.depositWithdrawn ?? 0;

    expect(entry.budget).toBeCloseTo(50, 2);
    expect(withdrawn).toBeCloseTo(50, 1);
    expect(withdrawn).toBeLessThanOrEqual(50 + TOL);
    expect(depositAccountOf(world, group)!.balance).toBeCloseTo(950, 2);
    // 存款不够覆盖剩余需求时，缺口才由消费贷补足。
    expect(entry.loanFinanced ?? 0).toBeGreaterThan(0);
  });

  it('存款不足时才使用消费贷：提取到 5% 上限后剩余缺口走贷款', () => {
    const world = newWorld();
    const city = cityOf(world);
    prepare(world, city);
    const group = groupOf(world, city);
    group.people = 100;
    setDeposit(world, group, 200);

    const result = runMarket(world, city);
    const entry = result.byGroup![group.id]!;
    const withdrawn = group.lastMonth.depositWithdrawn ?? 0;

    expect(withdrawn).toBeCloseTo(10, 2); // 200 × 5%
    expect(entry.budget).toBeCloseTo(10, 2);
    expect(entry.loanFinanced ?? 0).toBeGreaterThanOrEqual(100 - TOL);
    expect(entry.spend).toBeCloseTo(withdrawn + (entry.loanFinanced ?? 0), 2);
    // 支付顺序：存款先转现金、再与贷款一起被真实消费扣款，最终现金不残留。
    expect(group.cash).toBeCloseTo(0, 2);
    expect(depositAccountOf(world, group)!.balance).toBeCloseTo(190, 2);
  });

  it('存款提取不创造余额：现金 + 存款 + 真实消费 = 常量', () => {
    const world = newWorld();
    const city = cityOf(world);
    prepare(world, city);
    const group = groupOf(world, city);
    group.people = 1;
    setDeposit(world, group, 10_000);
    const cashBefore = group.cash;
    const depositBefore = depositAccountOf(world, group)!.balance;

    const result = runMarket(world, city);
    const entry = result.byGroup![group.id]!;
    const cashAfter = group.cash;
    const depositAfter = depositAccountOf(world, group)!.balance;

    expect(cashAfter + depositAfter + entry.spend).toBeCloseTo(cashBefore + depositBefore, 2);
    expect(depositBefore - depositAfter).toBeCloseTo(group.lastMonth.depositWithdrawn ?? 0, 2);
    expect(entry.loanFinanced ?? 0).toBe(0);
  });

  it('存读档往返：存款余额与 depositWithdrawn 统计完整还原', () => {
    // 存档不变量会校验人口合计、群体现金流闭合与市场/企业库存一致，
    // 因此这里用干净世界（不调 prepare 改人口/收入），只清空被测群体现金。
    const world = newWorld();
    const city = cityOf(world);
    const group = groupOf(world, city);
    group.cash = 0;
    setDeposit(world, group, 500);

    const result = runMarket(world, city);
    const entry = result.byGroup![group.id]!;
    const withdrawn = group.lastMonth.depositWithdrawn ?? 0;
    // 消费改变了企业库存：先走一次市场期末结算，让市场 closingStock 与企业库存一致（存档不变量要求）。
    finalizeMarkets(world, createWorldLedgers(world), CONFIG);
    const parsed = parseSave(serializeSave(world));
    expect(parsed.ok, parsed.error).toBe(true);

    const restoredWorld = parsed.world!;
    const restoredCity = restoredWorld.cities.find((entry2) => entry2.id === city.id)!;
    const restoredGroup = householdGroupsOfCity(restoredWorld, restoredCity.id).find(
      (entry2) => entry2.id === group.id,
    )!;
    expect(depositAccountOf(restoredWorld, restoredGroup)!.balance).toBeCloseTo(
      500 - withdrawn,
      2,
    );
    expect(restoredGroup.lastMonth.depositWithdrawn ?? 0).toBeCloseTo(withdrawn, 2);
    expect(restoredGroup.cash).toBeCloseTo(group.cash, 2);
    expect(entry.spend).toBeGreaterThan(0);
  });

  it('同一 tick 重复结算：不重复突破 5% 提取上限', () => {
    const world = newWorld();
    const city = cityOf(world);
    prepare(world, city);
    const group = groupOf(world, city);
    group.people = 100;
    setDeposit(world, group, 1_000);

    const first = runMarket(world, city);
    expect(first.byGroup![group.id]!.spend).toBeGreaterThan(0);
    const withdrawnAfterFirst = group.lastMonth.depositWithdrawn ?? 0;
    expect(withdrawnAfterFirst).toBeCloseTo(50, 1);
    const loansAfterFirst = world.householdFinance?.loans.length ?? 0;

    const second = runMarket(world, city);
    const secondEntry = second.byGroup![group.id]!;
    expect(secondEntry.spend).toBe(0);
    expect(secondEntry.loanFinanced ?? 0).toBe(0);
    expect(group.lastMonth.depositWithdrawn ?? 0).toBeCloseTo(withdrawnAfterFirst, 2);
    expect(householdDepositWithdrawalRemaining(world, group)).toBeCloseTo(0, 2);
    expect(world.householdFinance?.loans.length ?? 0).toBe(loansAfterFirst);
  });

  it('无存款群体保持旧预算口径：min(现金, 0.8×收入 + 0.05×现金)', () => {
    const world = newWorld();
    const city = cityOf(world);
    prepare(world, city);
    const group = groupOf(world, city);
    group.people = 1;
    group.cash = 10_000;
    group.lastMonth.income = 20_000;

    const result = runMarket(world, city);
    const entry = result.byGroup![group.id]!;
    expect(entry.budget).toBeCloseTo(10_000, 2);
    expect(group.lastMonth.depositWithdrawn ?? 0).toBe(0);
  });

  it('提取 helper 自身遵守“月初存款 × 5%”与可用余额上限', () => {
    const world = newWorld();
    const city = cityOf(world);
    prepare(world, city);
    const group = groupOf(world, city);
    setDeposit(world, group, 1_000);

    const taken = withdrawHouseholdDeposit(world, group, CONFIG, 999, 0);
    expect(taken).toBeCloseTo(50, 2);
    expect(group.cash).toBeCloseTo(50, 2);
    expect(depositAccountOf(world, group)!.balance).toBeCloseTo(950, 2);
    const second = withdrawHouseholdDeposit(world, group, CONFIG, 100, 0);
    expect(second).toBe(0);
    expect(group.lastMonth.depositWithdrawn ?? 0).toBeCloseTo(50, 2);
  });
});
