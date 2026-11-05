// v1.4 §6.1 居民消费六项口径回归测试。
//
// 覆盖验收要点：
// 1) 本月统计落账六项：基本需要量、可支付有效需求（件）、实际成交（件/金额）、
//    商品不足缺口（件）、资金不足缺口（金额）、现金/存款提取/消费贷金额。
// 2) 关键口径：基本需要覆盖率 = 基本需要商品成交量 / 基本需要量（人均需要 × 人口），
//    不得用“有效需求满足率”（成交 / 有效需求）替代——买不起的部分不是供给不足。
// 3) 三方对账：成交额 = 手头现金支付 + 存款提取 + 消费贷，贷款只补真实成交；
//    未支付部分（资金不足缺口）不计入收入、不虚增成交、不进市场 sold。
// 4) 四层守恒：有效需求件数 = 成交 + 商品不足 + 资金不足对应件数（不重复记账）。
// 5) 城市级 affordability 是“可支付有效需求 / 期望需求”，不是“实际成交 / 期望需求”。
//
// 测试使用真实 Simulation 世界与真实本地市场，只把目标群体以外人口清零、关闭跨城补货、
// 把消费价格与价格系数固定为基准价，便于手算核对。

import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation/core/simulation';
import { DEMO_CONFIG } from '../src/data/config';
import type { DemoConfig } from '../src/data/config';
import { GOODS } from '../src/data/demo-data';
import { createWorldLedgers } from '../src/simulation/markets/markets';
import { runConsumerMarket } from '../src/simulation/markets/consumer';
import { depositAccountFor, ensureDepositAccount } from '../src/simulation/banking/banking';
import { householdGroupsOfCity } from '../src/simulation/population/household-groups';
import { round2 } from '../src/simulation/core/math';
import type {
  GoodId,
  HouseholdGroup,
  OccupationClass,
  WorldState,
} from '../src/simulation/contracts/types';

const CONFIG: DemoConfig = {
  ...DEMO_CONFIG,
  intercity: { ...DEMO_CONFIG.intercity, enabled: false },
} as unknown as DemoConfig;

// 关闭消费贷授信：隔离“现金 + 存款”路径，便于手算资金缺口。
const NO_LOAN_CONFIG: DemoConfig = {
  ...CONFIG,
  households: {
    ...DEMO_CONFIG.households,
    householdCredit: { ...DEMO_CONFIG.households.householdCredit, creditLimitRate: 0 },
  },
} as unknown as DemoConfig;

const CONSUMER_GOODS = GOODS.filter((good) => good.category === 'consumer');
const FOOD = GOODS.find((good) => good.id === 'food')!;
const FOOD_PRICE = FOOD.basePrice;
const LANPORT = 'lanport';
const PEOPLE = 100;
const BASIC_NEED_UNITS = PEOPLE * FOOD.perCapitaMonthlyNeed; // 2,600 件/月
const BASIC_NEED_COST = BASIC_NEED_UNITS * FOOD_PRICE; // 143,000
const TOL = 0.05;

interface Fixture {
  world: WorldState;
  city: ReturnType<typeof Simulation.create>['state']['cities'][number];
  ledgers: ReturnType<typeof createWorldLedgers>[string];
  group: HouseholdGroup;
  setCash: (cash: number) => void;
  setDeposit: (balance: number) => void;
  setInventory: (goodId: GoodId, quantity: number) => void;
  run: (config?: DemoConfig) => ReturnType<typeof runConsumerMarket>;
}

/**
 * 构造只保留岚港目标群体的干净世界：
 * - 其他群体人口/现金/收入/存款清零（不产生消费需求）；
 * - 目标群体人口 100、现金默认 0；
 * - 本地市场价格=基准价、企业价格系数=1、消费品库存清零后由用例设定；
 * - 居民投资实体权益清零（授信只取决于现金+存款）；
 * - 关闭跨城补货，成交只来自本地真实市场。
 */
function buildFixture(occupation: OccupationClass = 'production'): Fixture {
  const world = Simulation.create().state;
  const city = world.cities.find((entry) => entry.id === LANPORT)!;
  const groups = householdGroupsOfCity(world, city.id);

  for (const group of groups) {
    group.cash = 0;
    group.people = 0;
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
  }
  const target = groups.find((group) => group.occupation === occupation)!;
  target.people = PEOPLE;

  for (const good of CONSUMER_GOODS) {
    const market = city.market[good.id];
    if (market) market.price = good.basePrice;
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

  ensureDepositAccount(world, { kind: 'household', id: target.id }, CONFIG, world.time.tick);
  const ledgers = createWorldLedgers(world)[city.id]!;
  const depositOwner = { kind: 'household' as const, id: target.id };

  return {
    world,
    city,
    ledgers,
    group: target,
    setCash: (cash) => {
      target.cash = round2(cash);
    },
    setDeposit: (balance) => {
      const account = depositAccountFor(world, depositOwner);
      if (account) account.balance = round2(balance);
    },
    setInventory: (goodId, quantity) => {
      const company = world.companies.find((entry) => entry.cityId === city.id)!;
      company.inventory[goodId] = quantity;
    },
    run: (config = CONFIG) => runConsumerMarket(world, city, ledgers, config),
  };
}

function depositBalance(fixture: Fixture): number {
  return round2(
    depositAccountFor(fixture.world, { kind: 'household', id: fixture.group.id })?.balance ?? 0,
  );
}

function lastMonthOf(fixture: Fixture) {
  return fixture.group.lastMonth;
}

describe('v1.4 §6.1 消费六项口径', () => {
  it('落账六项：基本需要量按人均需要单列，覆盖率不用“有效需求满足率”替代', () => {
    const fixture = buildFixture();
    fixture.setCash(5_000);
    fixture.setInventory('food', 50); // 本地只有 50 件食品

    const result = fixture.run(NO_LOAN_CONFIG);
    const entry = result.byGroup![fixture.group.id]!;
    const stats = lastMonthOf(fixture);

    // 四层口径（件）：想买 2,600 / 只有 5,000 现金 → 尝试 90.9 件 / 真实成交 50 件。
    expect(entry.effective?.food).toBeCloseTo(BASIC_NEED_UNITS, 2);
    expect(entry.bought.food).toBeCloseTo(50, 2);
    expect(entry.spend).toBeCloseTo(50 * FOOD_PRICE, 2);

    // 六项 1：基本需要量按“人均需要 × 人口”，不是有效需求。
    expect(stats.basicNeedUnits).toBeCloseTo(BASIC_NEED_UNITS, 2);
    // 六项 2：可支付有效需求（件）= Σ effective。
    expect(stats.effectiveUnits).toBeCloseTo(BASIC_NEED_UNITS, 2);
    // 六项 3：实际成交（件）；金额用既有 consumption 口径。
    expect(stats.soldUnits).toBeCloseTo(50, 2);
    expect(stats.consumption).toBeCloseTo(50 * FOOD_PRICE, 2);
    // 六项 4：商品不足缺口 = 真实尝试过但没买到的量（90.9 尝试、50 成交）。
    expect(stats.supplyShortfallUnits).toBeCloseTo(40.9, 2);
    // 六项 5：资金不足缺口 = 未尝试的 2,509.1 件 × 价格。
    expect(stats.unmetFunding).toBeCloseTo(round2((BASIC_NEED_UNITS - 90.9) * FOOD_PRICE), 2);
    // 六项 6：现金/存款/消费贷（本例全部为手头现金）。
    expect(stats.cashPaid).toBeCloseTo(50 * FOOD_PRICE, 2);
    expect(stats.depositWithdrawn).toBeCloseTo(0, 2);
    expect(stats.loanFinancedConsumption).toBeCloseTo(0, 2);

    // 基本需要覆盖率 = 50 / 2,600 ≈ 1.92%；“有效需求满足率”= 50 / 90.9 ≈ 55%，
    // 后者只统计买得起的部分，绝不能替代覆盖率。
    expect(stats.basicNeedCoverage).toBeCloseTo(Math.round((50 / BASIC_NEED_UNITS) * 10000) / 10000, 4);
    const effectiveSatisfactionRate = 50 / 90.9;
    expect(Math.abs((stats.basicNeedCoverage ?? 0) - effectiveSatisfactionRate)).toBeGreaterThan(0.4);

    // 四层守恒（件）：effective = 成交 + 商品不足 + 资金不足对应件数，不重复记账。
    expect(
      round2(
        (stats.soldUnits ?? 0) +
          (stats.supplyShortfallUnits ?? 0) +
          (stats.unmetFunding ?? 0) / FOOD_PRICE,
      ),
    ).toBeCloseTo(stats.effectiveUnits ?? 0, 2);

    // 成交额 = 现金 + 存款提取 + 消费贷。
    expect(stats.consumption).toBeCloseTo(
      round2(
        (stats.cashPaid ?? 0) +
          (stats.depositWithdrawn ?? 0) +
          (stats.loanFinancedConsumption ?? 0),
      ),
      2,
    );
    // 市场台账只记真实成交与真实尝试，不虚增。
    expect(fixture.ledgers.food!.sold).toBeCloseTo(stats.soldUnits ?? 0, 2);
    expect(fixture.ledgers.food!.consumerDemand).toBeCloseTo(90.9, 2);
    expect(fixture.ledgers.food!.unmetDemand).toBeCloseTo(40.9, 2);
  });

  it('三方对账：现金/存款提取/消费贷金额与成交额逐项闭合', () => {
    // (a) 现金不足、可提存款补足：成交 = 现金 + 存款提取，不借款。
    const depositFixture = buildFixture();
    depositFixture.setCash(1_000);
    depositFixture.setDeposit(100_000);
    depositFixture.setInventory('food', 1_000_000);
    const depositEntry = depositFixture.run(NO_LOAN_CONFIG).byGroup![depositFixture.group.id]!;
    const depositStats = lastMonthOf(depositFixture);
    expect(depositEntry.depositWithdrawn ?? 0).toBeGreaterThan(0);
    expect(depositEntry.depositWithdrawn ?? 0).toBeLessThanOrEqual(5_000 + TOL);
    expect(depositEntry.loanFinanced ?? 0).toBeCloseTo(0, 2);
    expect(depositStats.cashPaid).toBeCloseTo(depositEntry.cashPaid ?? 0, 2);
    expect(depositStats.depositWithdrawn).toBeCloseTo(depositEntry.depositWithdrawn ?? 0, 2);
    expect(depositStats.consumption).toBeCloseTo(
      round2(
        (depositStats.cashPaid ?? 0) +
          (depositStats.depositWithdrawn ?? 0) +
          (depositStats.loanFinancedConsumption ?? 0),
      ),
      2,
    );
    expect(depositEntry.spend).toBeCloseTo(depositStats.consumption, 2);

    // (b) 现金/存款都不足：剩余真实缺口才用消费贷，贷款额 = 实际成交额。
    const loanFixture = buildFixture();
    loanFixture.setCash(1_000);
    loanFixture.setDeposit(0);
    loanFixture.setInventory('food', 1_000_000);
    const loanEntry = loanFixture.run(CONFIG).byGroup![loanFixture.group.id]!;
    const loanStats = lastMonthOf(loanFixture);
    expect(loanEntry.loanFinanced ?? 0).toBeGreaterThan(0);
    expect(loanStats.loanFinancedConsumption).toBeCloseTo(loanEntry.loanFinanced ?? 0, 2);
    expect(loanStats.consumption).toBeCloseTo(
      round2(
        (loanStats.cashPaid ?? 0) +
          (loanStats.depositWithdrawn ?? 0) +
          (loanStats.loanFinancedConsumption ?? 0),
      ),
      2,
    );
    const loans = (loanFixture.world.householdFinance?.loans ?? []).filter(
      (loan) => loan.groupId === loanFixture.group.id,
    );
    expect(loans).toHaveLength(1);
    expect(loans[0]!.principal).toBeCloseTo(loanEntry.loanFinanced ?? 0, 2);
    // 贷款放款额 = 实际成交额（不多借），且真实债务不计入收入。
    expect((loanStats.income ?? 0)).toBeCloseTo(0, 2);
    expect(loanStats.consumption).toBeCloseTo(loanEntry.spend, 2);
  });

  it('未支付部分不算收入：无供给时成交 0、资金缺口>0、收入/现金/存款/债务不变', () => {
    const fixture = buildFixture();
    fixture.setCash(0);
    fixture.setDeposit(1_000);
    fixture.setInventory('food', 0);
    const cashBefore = fixture.group.cash;
    const depositBefore = depositBalance(fixture);

    const result = fixture.run(NO_LOAN_CONFIG);
    const entry = result.byGroup![fixture.group.id]!;
    const stats = lastMonthOf(fixture);

    expect(entry.spend).toBeCloseTo(0, 2);
    expect(entry.bought.food ?? 0).toBeCloseTo(0, 2);
    expect(entry.loanFinanced ?? 0).toBeCloseTo(0, 2);
    expect(entry.depositWithdrawn ?? 0).toBeCloseTo(0, 2);
    // 资金不足缺口只作为“缺口”统计，不形成成交、不形成收入。
    expect(stats.unmetFunding).toBeGreaterThan(0);
    expect(stats.consumption).toBeCloseTo(0, 2);
    expect(stats.soldUnits).toBeCloseTo(0, 2);
    expect(stats.cashPaid).toBeCloseTo(0, 2);
    expect(stats.depositWithdrawn).toBeCloseTo(0, 2);
    expect(stats.income).toBeCloseTo(0, 2);
    expect(stats.netCashChange).toBeCloseTo(0, 2);
    expect(fixture.group.cash).toBeCloseTo(cashBefore, 2);
    expect(depositBalance(fixture)).toBeCloseTo(depositBefore, 2);
    expect(fixture.world.householdFinance?.loans ?? []).toHaveLength(0);
    // 市场只见到真实尝试的 0.9 件（可提存款 50÷55），没有虚构成交。
    expect(fixture.ledgers.food!.sold).toBeCloseTo(0, 2);
    expect(fixture.ledgers.food!.consumerDemand).toBeCloseTo(0.9, 2);
    expect(fixture.ledgers.food!.unmetDemand).toBeCloseTo(0.9, 2);
  });

  it('城市 affordability = 可支付有效需求 / 期望需求，不把收成/缺货混成“满足率”', () => {
    const fixture = buildFixture();
    fixture.setCash(5_000);
    fixture.setInventory('food', 50);

    const result = fixture.run(NO_LOAN_CONFIG);
    const entries = Object.values(result.byGroup ?? {});
    const desiredCost = entries.reduce((total, entry) => total + entry.desiredCost, 0);
    const effectiveCost = entries.reduce((total, entry) => total + (entry.effectiveCost ?? 0), 0);

    // 有效需求成本 = 2,600 件 × 55 = 143,000（非基本需求被预算压成 0）。
    expect(effectiveCost).toBeCloseTo(BASIC_NEED_COST, 2);
    // 期望成本 = 基本需要 + 非基本期望。
    expect(desiredCost).toBeGreaterThan(BASIC_NEED_COST);
    expect(result.affordability).toBeCloseTo(
      Math.round((effectiveCost / desiredCost) * 1000) / 1000,
      3,
    );
    // 实际成交 / 期望需求（≈1.1%）远低于 affordability（≈59.8%）：缺货不能算成“买不起”。
    const realizedShare = result.spend / desiredCost;
    expect(result.affordability).toBeGreaterThan(realizedShare + 0.1);
  });
});
