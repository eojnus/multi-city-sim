// v1.0 任务书第四节：居民消费预算与基本需求。
//
// 口径：
// - 日常现金预算 = min(手头现金, 上月可支配收入×80% + 现金×5%)；
// - 基本需求（food）：数量不因失业/非劳动身份削减，预算不能阻挡支付——可用超过日常预算的当前现金，
//   上限为“基本需求成本”与“真实现金 + 本月可提存款”；不足部分按 现金 → 存款（≤月初 5%）→ 消费贷 顺序补足；
// - 非基本需求：仍受日常预算与消费意愿约束，不自动耗尽积蓄，也不能靠贷款突破预算；
// - 四层口径：desired（想买）/ effective（可支付的有效需求）/ sold（真实成交）/ unmet（缺货）；
// - 无供给时不得成交、不得放贷、不得提存款；交易必须对应真实卖方与真实资金。

import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation/core/simulation';
import { DEMO_CONFIG } from '../src/data/config';
import type { DemoConfig } from '../src/data/config';
import { GOODS } from '../src/data/demo-data';
import { createWorldLedgers, finalizeMarkets } from '../src/simulation/markets/markets';
import { runConsumerMarket } from '../src/simulation/markets/consumer';
import { parseSave, serializeSave } from '../src/simulation/core/save';
import { depositAccountFor, ensureDepositAccount } from '../src/simulation/banking/banking';
import { householdGroupsOfCity } from '../src/simulation/population/household-groups';
import { round2 } from '../src/simulation/core/math';
import type { HouseholdGroup, OccupationClass, WorldState } from '../src/simulation/contracts/types';

const CONFIG: DemoConfig = {
  ...DEMO_CONFIG,
  // 关闭跨城补货：本文件验证本地真实市场与资金支付顺序，避免跨城物流容量干扰对账。
  intercity: { ...DEMO_CONFIG.intercity, enabled: false },
} as unknown as DemoConfig;
const CONSUMER_GOODS = GOODS.filter((good) => good.category === 'consumer');
const FOOD = GOODS.find((good) => good.id === 'food')!;
const TOL = 0.05;
const PEOPLE = 100;
const FOOD_PRICE = FOOD.basePrice;
/** 基本需求成本：100 人 × 26/人月 × 基准价。 */
const BASIC_COST = round2(PEOPLE * FOOD.perCapitaMonthlyNeed * FOOD_PRICE);

interface Fixture {
  world: WorldState;
  city: ReturnType<WorldState['cities']['at']> & object;
  group: HouseholdGroup;
  ledgers: ReturnType<typeof createWorldLedgers>[string];
  setCash: (cash: number) => void;
  setDeposit: (balance: number) => void;
  setIncome: (income: number) => void;
  setSupply: (stock: { food?: number; clothing?: number; household?: number }) => void;
  depositBalance: () => number;
}

/**
 * 构造只保留一个目标群体的岚港世界（人数固定 100），便于手算：
 * - 其他城市/群体人数置 0，不产生消费需求，也不会借消费贷干扰本地市场；
 * - 市场价格=基准价、企业价格系数=1；
 * - 居民投资实体权益清零，使消费贷额度只取决于现金+存款；
 * - 本地库存由用例设定，跨城关闭。
 */
function buildFixture(occupation: OccupationClass): Fixture {
  const world = Simulation.create().state;
  const city = world.cities.find((entry) => entry.id === 'lanport')!;
  const groups = householdGroupsOfCity(world, city.id);
  const target = groups.find((group) => group.occupation === occupation)!;

  for (const group of groups) {
    group.cash = 0;
    group.lastMonth.income = 0;
    group.lastMonth.consumption = 0;
    group.lastMonth.desiredConsumption = 0;
    group.lastMonth.loanDrawn = 0;
    group.lastMonth.loanFinancedConsumption = 0;
    group.lastMonth.unmetFunding = 0;
    group.lastMonth.depositWithdrawn = 0;
    group.lastMonth.netCashChange = 0;
    group.lastMonth.savingsContribution = 0;
    const account = depositAccountFor(world, { kind: 'household', id: group.id });
    if (account) account.balance = 0;
    if (group !== target) group.people = 0;
  }
  target.people = PEOPLE;

  for (const good of CONSUMER_GOODS) {
    const state = city.market[good.id];
    if (state) state.price = good.basePrice;
  }
  for (const company of world.companies) {
    if (company.cityId !== city.id) continue;
    company.priceFactor = 1;
    for (const good of CONSUMER_GOODS) company.inventory[good.id] = 0;
  }
  for (const investor of world.investors) {
    if (investor.cityId !== city.id) continue;
    investor.cash = 0;
    for (const holding of world.securities.holdings) {
      if (holding.holder.type === 'investorGroup' && holding.holder.id === investor.id) {
        holding.shares = 0;
      }
    }
  }

  const depositOwner = { kind: 'household' as const, id: target.id };
  ensureDepositAccount(world, depositOwner, CONFIG, world.time.tick);
  const ledgers = createWorldLedgers(world)[city.id]!;
  const firstCompany = world.companies.find((company) => company.cityId === city.id)!;

  return {
    world,
    city,
    group: target,
    ledgers,
    setCash: (cash) => {
      target.cash = round2(cash);
    },
    setDeposit: (balance) => {
      const account = depositAccountFor(world, depositOwner);
      if (account) account.balance = round2(balance);
    },
    setIncome: (income) => {
      target.lastMonth.income = round2(income);
    },
    setSupply: (stock) => {
      for (const company of world.companies) {
        if (company.cityId !== city.id) continue;
        for (const good of CONSUMER_GOODS) company.inventory[good.id] = 0;
      }
      if (stock.food) firstCompany.inventory.food = stock.food;
      if (stock.clothing) firstCompany.inventory.clothing = stock.clothing;
      if (stock.household) firstCompany.inventory.household = stock.household;
    },
    depositBalance: () => round2(depositAccountFor(world, depositOwner)?.balance ?? 0),
  };
}

function runMarket(fixture: Fixture) {
  return runConsumerMarket(fixture.world, fixture.city, fixture.ledgers, CONFIG);
}

describe('v1.0 居民基本需求（失业不削减、预算不阻挡食品）', () => {
  it('失业群体基本需求数量不因失业削减，用真实现金/存款买到真实食品', () => {
    const fixture = buildFixture('unemployed');
    fixture.setCash(100_000);
    fixture.setDeposit(10_000);
    fixture.setSupply({ food: 1_000_000 });

    const result = runMarket(fixture);
    const entry = result.byGroup![fixture.group.id]!;
    const cashBefore = 100_000;

    // desired（想买）不乘失业系数 0.72：100×26（基准价下价格弹性=1），而不是 1872。
    expect(entry.desired?.food ?? 0).toBeCloseTo(PEOPLE * FOOD.perCapitaMonthlyNeed, 2);
    expect(entry.desired?.food ?? 0).toBeGreaterThan(PEOPLE * FOOD.perCapitaMonthlyNeed * 0.72 + 1);
    // 基本需求的 full 保障数量与 effective 全额（不被预算缩放）。
    expect(entry.effective?.food ?? 0).toBeCloseTo(PEOPLE * FOOD.perCapitaMonthlyNeed, 2);
    expect(entry.basicNeedCost ?? 0).toBeCloseTo(BASIC_COST, 2);
    // 真实成交：买到了食品，且成交额来自真实现金、存款提取与合规消费贷。
    expect(entry.bought.food).toBeGreaterThan(0);
    expect(entry.spend).toBeGreaterThan(0);
    expect(entry.spend).toBeCloseTo(
      round2((entry.cashPaid ?? 0) + (entry.depositWithdrawn ?? 0) + (entry.loanFinanced ?? 0)),
      2,
    );
    expect(entry.cashPaid ?? 0).toBeLessThanOrEqual(cashBefore + TOL);
    expect(entry.depositWithdrawn ?? 0).toBeLessThanOrEqual(round2(10_000 * 0.05) + TOL);
    expect(fixture.depositBalance()).toBeCloseTo(round2(10_000 - (entry.depositWithdrawn ?? 0)), 2);
    // 现金账目闭合：期初现金 − 现金支付 = 期末现金（提取存款与贷款直接用于支付，不进入现金）。
    expect(fixture.group.cash).toBeCloseTo(round2(cashBefore - (entry.cashPaid ?? 0)), 2);
    // 台账 = 实际成交额；成交必须对应真实卖方，不得虚增。
    const ledgerSpend = round2(CONSUMER_GOODS.reduce((sum, good) => sum + (fixture.ledgers[good.id]?.spend ?? 0), 0));
    expect(ledgerSpend).toBeCloseTo(entry.spend, 2);
    expect(fixture.world.householdFinance!.loans.filter((loan) => loan.groupId === fixture.group.id).length).toBeLessThanOrEqual(1);
  });

  it('食品基本需求超过日常预算但现金充足时可全额支付，不借款、不提存款', () => {
    const fixture = buildFixture('production');
    fixture.setCash(200_000);
    fixture.setDeposit(1_000_000);
    fixture.setIncome(0);
    fixture.setSupply({ food: 1_000_000 });

    const result = runMarket(fixture);
    const entry = result.byGroup![fixture.group.id]!;

    // 上月收入为 0 时日常预算只有现金的 5%（200,000×5%=10,000），远低于基本需求成本；
    // 但基本需求不能因此被拦住。
    expect(entry.dailyBudget ?? 0).toBeCloseTo(round2(200_000 * 0.05), 2);
    expect(entry.spend).toBeCloseTo(BASIC_COST, 2);
    expect(entry.bought.food ?? 0).toBeCloseTo(PEOPLE * FOOD.perCapitaMonthlyNeed, 2);
    expect(entry.spend).toBeGreaterThan(entry.dailyBudget ?? 0);
    expect(entry.loanFinanced ?? 0).toBe(0);
    expect(entry.depositWithdrawn ?? 0).toBe(0);
    expect(entry.cashPaid ?? 0).toBeCloseTo(BASIC_COST, 2);
    expect(fixture.group.cash).toBeCloseTo(200_000 - BASIC_COST, 2);
    expect(fixture.depositBalance()).toBeCloseTo(1_000_000, 2);
    expect(fixture.world.householdFinance!.loans).toHaveLength(0);
  });
});

describe('v1.0 支付顺序与原子性', () => {
  it('无供给：不成交、不放贷、不提存款、无任何副作用', () => {
    const fixture = buildFixture('production');
    fixture.setCash(80_000);
    fixture.setDeposit(10_000);
    fixture.setIncome(10_000);
    fixture.setSupply({});

    const result = runMarket(fixture);
    const entry = result.byGroup![fixture.group.id]!;

    expect(entry.spend).toBe(0);
    expect(entry.bought.food ?? 0).toBe(0);
    expect(entry.loanFinanced ?? 0).toBe(0);
    expect(entry.depositWithdrawn ?? 0).toBe(0);
    expect(fixture.group.cash).toBeCloseTo(80_000, 2);
    expect(fixture.depositBalance()).toBeCloseTo(10_000, 2);
    expect(fixture.world.householdFinance!.loans).toHaveLength(0);
    for (const good of CONSUMER_GOODS) {
      expect(fixture.ledgers[good.id]?.spend ?? 0).toBe(0);
      expect(fixture.ledgers[good.id]?.sold ?? 0).toBe(0);
    }
    // 基本需求缺口被记录为 unmet（缺货），而不是伪造成交。
    expect(entry.unmet.food ?? 0).toBeGreaterThan(0);
  });

  it('现金 → 存款（≤月初 5%）→ 消费贷：仍有可提存款时不借款，用尽后才放贷且额度合规', () => {
    const fixture = buildFixture('production');
    fixture.setCash(0);
    fixture.setDeposit(10_000);
    fixture.setIncome(0);
    fixture.setSupply({ food: 1_000_000 });

    const result = runMarket(fixture);
    const entry = result.byGroup![fixture.group.id]!;

    const withdrawn = entry.depositWithdrawn ?? 0;
    const financed = entry.loanFinanced ?? 0;
    expect(entry.spend).toBeGreaterThan(0);
    expect(entry.cashPaid ?? 0).toBe(0);
    // 先提存款，且不超过月初存款 5%（500）。
    expect(withdrawn).toBeGreaterThan(0);
    expect(withdrawn).toBeLessThanOrEqual(round2(10_000 * 0.05) + TOL);
    // 存款与现金都不够时，剩余真实缺口才由消费贷补足，且贷款额=实际成交额−现金−提取。
    expect(financed).toBeGreaterThan(0);
    expect(entry.spend).toBeCloseTo(round2(withdrawn + financed), 2);
    const limited = fixture.world.householdFinance!.loans.filter((loan) => loan.groupId === fixture.group.id);
    expect(limited).toHaveLength(1);
    expect(limited[0]!.principal).toBeCloseTo(financed, 2);
    expect(limited[0]!.principal).toBeCloseTo(limited[0]!.outstanding, 2);
    expect(fixture.group.cash).toBeCloseTo(0, 2);
    expect(fixture.depositBalance()).toBeCloseTo(round2(10_000 - withdrawn), 2);
    expect(
      round2(CONSUMER_GOODS.reduce((sum, good) => sum + (fixture.ledgers[good.id]?.spend ?? 0), 0)),
    ).toBeCloseTo(entry.spend, 2);
  });

  it('非必需品不耗尽积蓄：只花日常预算内现金，不动存款、不放贷', () => {
    const fixture = buildFixture('production');
    fixture.group.people = 10; // 基本需求成本 10×26×55=14,300，小到能留下非基本预算
    fixture.setCash(50_000);
    fixture.setDeposit(1_000_000);
    fixture.setIncome(100_000);
    // 无食品供给；只供应非必需品。
    fixture.setSupply({ clothing: 1_000_000, household: 1_000_000 });

    const result = runMarket(fixture);
    const entry = result.byGroup![fixture.group.id]!;

    const dailyBudget = round2(Math.min(50_000, 0.8 * 100_000 + 0.05 * 50_000));
    expect(entry.dailyBudget ?? 0).toBeCloseTo(dailyBudget, 2);
    expect(entry.spend).toBeGreaterThan(0);
    expect(entry.spend).toBeLessThanOrEqual(dailyBudget + TOL);
    expect(entry.bought.food ?? 0).toBe(0);
    // 非基本消费只花现金预算内现金，不自动提存款、不借款。
    expect(entry.depositWithdrawn ?? 0).toBe(0);
    expect(entry.loanFinanced ?? 0).toBe(0);
    expect(fixture.depositBalance()).toBeCloseTo(1_000_000, 2);
    expect(fixture.world.householdFinance!.loans).toHaveLength(0);
    expect(fixture.group.cash).toBeCloseTo(round2(50_000 - entry.spend), 2);
  });
});

describe('v1.0 存读档：基本需求消费后的现金/存款/贷款归属', () => {
  it('存读档往返后居民现金、存款、消费与消费贷归属一致', () => {
    // 使用原始世界（不破坏股份/人口不变量）：把目标群体现金清零、存款压到 500，并给本地食品充足供给。
    const world = Simulation.create().state;
    const city = world.cities.find((entry) => entry.id === 'lanport')!;
    const group = householdGroupsOfCity(world, city.id).find((entry) => entry.occupation === 'production')!;
    group.cash = 0;
    group.lastMonth.income = 0;
    group.lastMonth.consumption = 0;
    group.lastMonth.netCashChange = 0;
    group.lastMonth.savingsContribution = 0;
    group.lastMonth.depositWithdrawn = 0;
    const owner = { kind: 'household' as const, id: group.id };
    ensureDepositAccount(world, owner, DEMO_CONFIG, world.time.tick);
    const account = depositAccountFor(world, owner)!;
    account.balance = 500;
    for (const company of world.companies) {
      if (company.cityId !== city.id) continue;
      company.inventory.food = 50_000_000;
    }
    const ledgers = createWorldLedgers(world)[city.id]!;

    const result = runConsumerMarket(world, city, ledgers, DEMO_CONFIG);
    const entry = result.byGroup![group.id]!;
    expect(entry.spend).toBeGreaterThan(0);
    expect(entry.bought.food ?? 0).toBeGreaterThan(0);
    const withdrawn = entry.depositWithdrawn ?? 0;
    const financed = entry.loanFinanced ?? 0;
    // 与完整 tick 一致：先结算所有城市市场，再存档。
    finalizeMarkets(world, createWorldLedgers(world), DEMO_CONFIG);

    const parsed = parseSave(serializeSave(world, '2026-11-04T00:00:00.000Z'));
    expect(parsed.ok, parsed.error).toBe(true);
    const restored = parsed.world!;
    const restoredCity = restored.cities.find((candidate) => candidate.id === city.id)!;
    const restoredGroup = householdGroupsOfCity(restored, city.id).find(
      (candidate) => candidate.occupation === 'production',
    )!;
    expect(restoredGroup.cash).toBeCloseTo(group.cash, 2);
    expect(restoredGroup.lastMonth.depositWithdrawn ?? 0).toBeCloseTo(withdrawn, 2);
    expect(restoredGroup.lastMonth.consumption ?? 0).toBeCloseTo(group.lastMonth.consumption ?? 0, 2);
    expect(depositAccountFor(restored, { kind: 'household', id: restoredGroup.id })!.balance).toBeCloseTo(
      round2(500 - withdrawn),
      2,
    );
    expect(restoredGroup.people).toBe(group.people);
    expect(restoredCity.population.total).toBe(city.population.total);
    if (financed > 0) {
      const loans = (restored.householdFinance?.loans ?? []).filter((loan) => loan.groupId === group.id);
      expect(loans).toHaveLength(1);
      expect(loans[0]!.principal).toBeCloseTo(financed, 2);
    }
  });
});
