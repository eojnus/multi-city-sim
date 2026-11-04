// v1.1 §8 居民消费与基本需求复核回归测试。
//
// 覆盖任务书 §8 的验收要点：
// 1) 失业居民仍有基本食品需求（基本需求不乘失业/职业系数），有现金/存款时按
//    现金 → 存款（每月≤月初 5%）→ 消费贷 顺序真实成交；非必需品可受收入/失业影响但不得归零。
// 2) “有钱但缺货”记供给缺口（unmetDemand / entry.unmet），“有货但没钱”记资金缺口
//    （entry.unmetFunding），两者不得混记。
// 3) 没有真实商品成交时不得发放消费贷；贷款额 = 实际成交额（不虚增、不超成交）。
// 4) 空市场失败路径不留副作用（不成交、不放贷、不提存款）。
//
// 测试使用真实 Simulation 世界与真实本地市场，只把目标群体以外的城市人口清零、
// 关闭跨城补货、把价格/价格系数固定为基准值，便于手算核对。

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

// 关闭消费贷授信，用于验证“有货但没钱”的资金缺口，以及存款支付路径。
const NO_LOAN_CONFIG: DemoConfig = {
  ...CONFIG,
  households: {
    ...DEMO_CONFIG.households,
    householdCredit: { ...DEMO_CONFIG.households.householdCredit, creditLimitRate: 0 },
  },
} as unknown as DemoConfig;

const CONSUMER_GOODS = GOODS.filter((good) => good.category === 'consumer');
const TOL = 0.05;
const LANPORT = 'lanport';

interface Fixture {
  world: WorldState;
  city: ReturnType<typeof Simulation.create>['state']['cities'][number];
  ledgers: ReturnType<typeof createWorldLedgers>[string];
  groups: HouseholdGroup[];
  groupOf: (occupation: OccupationClass) => HouseholdGroup;
  setCash: (occupation: OccupationClass, cash: number) => void;
  setDeposit: (occupation: OccupationClass, balance: number) => void;
  setInventory: (goodId: GoodId, quantity: number) => void;
  setPeople: (occupation: OccupationClass, people: number) => void;
  run: (config?: DemoConfig) => ReturnType<typeof runConsumerMarket>;
}

/**
 * 构造只有岚港居民的干净世界：
 * - 所有群体现金/收入/存款/贷款统计清零，人口清零；
 * - 目标群体人口默认 100（用例可覆盖）；
 * - 本地市场价格=基准价、企业价格系数=1、消费品库存清零后由用例设定；
 * - 居民投资实体权益清零，使消费贷额度只取决于手头现金+存款；
 * - 关闭跨城补货，成交只来自本地真实市场。
 */
function buildFixture(occupations: OccupationClass[]): Fixture {
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

  for (const occupation of occupations) {
    const group = groups.find((entry) => entry.occupation === occupation)!;
    group.people = 100;
    group.cash = 0;
    ensureDepositAccount(world, { kind: 'household', id: group.id }, CONFIG, world.time.tick);
  }

  const ledgers = createWorldLedgers(world)[city.id]!;
  const groupOf = (occupation: OccupationClass) => groups.find((g) => g.occupation === occupation)!;

  return {
    world,
    city,
    ledgers,
    groups,
    groupOf,
    setCash: (occupation, cash) => {
      groupOf(occupation).cash = round2(cash);
    },
    setDeposit: (occupation, balance) => {
      const account = depositAccountFor(world, { kind: 'household', id: groupOf(occupation).id });
      if (account) account.balance = round2(balance);
    },
    setInventory: (goodId, quantity) => {
      const company = world.companies.find((entry) => entry.cityId === city.id)!;
      company.inventory[goodId] = quantity;
    },
    setPeople: (occupation, people) => {
      groupOf(occupation).people = people;
    },
    run: (config: DemoConfig = CONFIG) => runConsumerMarket(world, city, ledgers, config),
  };
}

function consumerSpend(fixture: Fixture): number {
  let total = 0;
  for (const good of CONSUMER_GOODS) total = round2(total + (fixture.ledgers[good.id]?.spend ?? 0));
  return total;
}

describe('v1.1 §8 居民消费与基本需求复核', () => {
  it('失业居民仍有基本食品需求（不乘失业系数），有现金时真实成交', () => {
    const fixture = buildFixture(['unemployed']);
    fixture.setCash('unemployed', 1_000_000);
    fixture.setInventory('food', 1_000_000);

    const result = fixture.run();
    const entry = result.byGroup![fixture.groupOf('unemployed').id]!;

    // 基本需求数量 = 人均需要 × 人口 = 26 × 100 = 2600（不乘 0.72 失业系数）。
    expect(entry.desired!.food).toBeCloseTo(2_600, 2);
    expect(entry.effective!.food).toBeCloseTo(2_600, 2);
    expect(entry.bought.food).toBeCloseTo(2_600, 2);
    // 手算：2600 × 55 = 143000，全部由现金支付，不提存款、不放贷。
    expect(entry.spend).toBeCloseTo(143_000, 2);
    expect(entry.depositWithdrawn ?? 0).toBe(0);
    expect(entry.loanFinanced ?? 0).toBe(0);
    expect(fixture.world.householdFinance?.loans ?? []).toHaveLength(0);
    // 市场台账与实际成交额一致。
    expect(consumerSpend(fixture)).toBeCloseTo(entry.spend, 2);
  });

  it('失业居民无现金但有存款：先提存款（≤月初 5%）支付基本食品，不借款', () => {
    const fixture = buildFixture(['unemployed']);
    fixture.setCash('unemployed', 0);
    fixture.setDeposit('unemployed', 100_000);
    fixture.setInventory('food', 1_000_000);

    const result = fixture.run(NO_LOAN_CONFIG);
    const entry = result.byGroup![fixture.groupOf('unemployed').id]!;

    // 月初存款 5% = 5000，最多只能提 5000；不借款（NO_LOAN）。
    expect(entry.depositWithdrawn ?? 0).toBeGreaterThan(0);
    expect(entry.depositWithdrawn ?? 0).toBeLessThanOrEqual(5_000 + TOL);
    expect(entry.loanFinanced ?? 0).toBe(0);
    expect(fixture.world.householdFinance?.loans ?? []).toHaveLength(0);
    expect(entry.spend).toBeCloseTo(entry.depositWithdrawn ?? 0, 2);
    expect(entry.cashPaid ?? 0).toBe(0);
    // 存款减少 = 提取额；手头现金为 0（提现全部用于支付）。
    expect(
      round2(depositAccountFor(fixture.world, { kind: 'household', id: fixture.groupOf('unemployed').id })?.balance ?? 0),
    ).toBeCloseTo(100_000 - (entry.depositWithdrawn ?? 0), 2);
    expect(fixture.groupOf('unemployed').cash).toBeCloseTo(0, 2);
  });

  it('有钱但本地缺货：spend=0、unmetDemand>0（供给缺口）、unmetFunding=0、无贷款', () => {
    const fixture = buildFixture(['production']);
    fixture.setCash('production', 1_000_000);
    fixture.setInventory('food', 0);

    const result = fixture.run();
    const entry = result.byGroup![fixture.groupOf('production').id]!;

    expect(entry.spend).toBe(0);
    expect(entry.loanFinanced ?? 0).toBe(0);
    expect(fixture.world.householdFinance?.loans ?? []).toHaveLength(0);
    // 有钱缺货：记供给缺口。
    expect(entry.unmet.food).toBeCloseTo(2_600, 2);
    expect(fixture.ledgers.food.unmetDemand).toBeCloseTo(2_600, 2);
    expect(fixture.ledgers.food.demand).toBeGreaterThan(0);
    // 不得记为资金缺口。
    expect(entry.unmetFunding ?? 0).toBe(0);
    // 空成交不产生市场 spend。
    expect(consumerSpend(fixture)).toBe(0);
  });

  it('有货但没钱（授信关闭）：unmetFunding>0（资金缺口）、unmet 缺货=0、无贷款', () => {
    const fixture = buildFixture(['production']);
    fixture.setCash('production', 0);
    fixture.setDeposit('production', 0);
    fixture.setInventory('food', 10_000);

    const result = fixture.run(NO_LOAN_CONFIG);
    const entry = result.byGroup![fixture.groupOf('production').id]!;

    expect(entry.spend).toBe(0);
    expect(entry.bought.food ?? 0).toBe(0);
    expect(fixture.world.householdFinance?.loans ?? []).toHaveLength(0);
    // 有货没钱：本地仍有供给，故缺口性质是资金缺口，不是缺货。
    expect(entry.unmet.food ?? 0).toBe(0);
    expect(entry.unmetFunding ?? 0).toBeCloseTo(2_600 * 55, 2);
    // 没有尝试（无支付能力）就不虚增市场需求/供给缺口。
    expect(fixture.ledgers.food.unmetDemand).toBe(0);
    expect(consumerSpend(fixture)).toBe(0);
    // 存款、现金、库存均不变。
    expect(fixture.groupOf('production').cash).toBeCloseTo(0, 2);
    expect(depositAccountFor(fixture.world, { kind: 'household', id: fixture.groupOf('production').id })?.balance ?? 0).toBe(0);
    const company = fixture.world.companies.find((entry) => entry.cityId === LANPORT)!;
    expect(company.inventory.food).toBe(10_000);
  });

  it('非必需品需求不因失业归零，但低于就业群体（可下降）', () => {
    const fixture = buildFixture(['management', 'unemployed']);
    for (const occupation of ['management', 'unemployed'] as const) {
      fixture.setCash(occupation, 3_000_000);
    }
    fixture.setInventory('food', 1_000_000);
    fixture.setInventory('clothing', 1_000_000);
    fixture.setInventory('household', 1_000_000);

    const result = fixture.run();
    const employed = result.byGroup![fixture.groupOf('management').id]!;
    const unemployed = result.byGroup![fixture.groupOf('unemployed').id]!;

    // 非基本需求乘消费意愿系数：管理 1.0 vs 失业 0.72，但都不得归零。
    expect(unemployed.desired!.clothing).toBeGreaterThan(0);
    expect(employed.desired!.clothing).toBeGreaterThan(0);
    expect(unemployed.desired!.clothing).toBeCloseTo(round2(employed.desired!.clothing * 0.72), 2);
    expect(unemployed.desired!.clothing).toBeLessThan(employed.desired!.clothing);
    // 基本需求不因失业削减：两者相同。
    expect(unemployed.desired!.food).toBeCloseTo(employed.desired!.food, 2);
    // 非基本需求受日常预算约束，不能靠贷款突破预算；此场景预算足够时应有真实成交。
    expect(unemployed.effective!.clothing).toBeGreaterThan(0);
    expect(unemployed.bought.clothing ?? 0).toBeGreaterThan(0);
    expect(unemployed.bought.clothing).toBeCloseTo(unemployed.effective!.clothing, 2);
    expect(unemployed.bought.household).toBeCloseTo(unemployed.effective!.household, 2);
    // 非基本预算已覆盖全部有效需求：消费贷阶段不得再放贷。
    expect(unemployed.loanFinanced ?? 0).toBe(0);
    expect(unemployed.unmetFunding ?? 0).toBe(0);
    expect(fixture.world.householdFinance?.loans ?? []).toHaveLength(0);
  });

  it('资金顺序：现金 → 存款（≤5%）→ 消费贷，贷款额=实际成交额', () => {
    // (a) 现金足够：不提存款、不借款。
    const cashFixture = buildFixture(['production']);
    cashFixture.setCash('production', 1_000_000);
    cashFixture.setDeposit('production', 100_000);
    cashFixture.setInventory('food', 1_000_000);
    const cashEntry = cashFixture.run().byGroup![cashFixture.groupOf('production').id]!;
    expect(cashEntry.spend).toBeGreaterThan(0);
    expect(cashEntry.depositWithdrawn ?? 0).toBe(0);
    expect(cashEntry.loanFinanced ?? 0).toBe(0);

    // (b) 现金不足、存款可提：先提存款补足，不借款。
    const depositFixture = buildFixture(['production']);
    depositFixture.setCash('production', 1_000);
    depositFixture.setDeposit('production', 100_000);
    depositFixture.setInventory('food', 1_000_000);
    const depositEntry = depositFixture.run(NO_LOAN_CONFIG).byGroup![
      depositFixture.groupOf('production').id
    ]!;
    expect(depositEntry.depositWithdrawn ?? 0).toBeGreaterThan(0);
    expect(depositEntry.depositWithdrawn ?? 0).toBeLessThanOrEqual(5_000 + TOL);
    expect(depositEntry.loanFinanced ?? 0).toBe(0);
    expect(depositEntry.spend).toBeCloseTo(
      round2((depositEntry.cashPaid ?? 0) + (depositEntry.depositWithdrawn ?? 0)),
      2,
    );

    // (c) 现金+可提存款都不够：剩余缺口才借款，且贷款额=实际成交额。
    const loanFixture = buildFixture(['production']);
    loanFixture.setCash('production', 1_000);
    loanFixture.setDeposit('production', 0);
    loanFixture.setInventory('food', 1_000_000);
    const loan = loanFixture.run().byGroup![loanFixture.groupOf('production').id]!;
    expect(loan.spend).toBeGreaterThan(0);
    expect(loan.loanFinanced ?? 0).toBeGreaterThan(0);
    expect(loan.loanFinanced ?? 0).toBeCloseTo(
      round2(loan.spend - (loan.cashPaid ?? 0) - (loan.depositWithdrawn ?? 0)),
      2,
    );
    const contracts = loanFixture.world.householdFinance?.loans ?? [];
    expect(contracts).toHaveLength(1);
    expect(contracts[0]!.groupId).toBe(loanFixture.groupOf('production').id);
    expect(contracts[0]!.principal).toBeCloseTo(loan.loanFinanced ?? 0, 2);
  });

  it('无真实成交不得发放消费贷：有授信/有存款但市场无货，零副作用', () => {
    const fixture = buildFixture(['production']);
    fixture.setCash('production', 0);
    fixture.setDeposit('production', 5_000);
    fixture.setInventory('food', 0);
    const before = {
      cash: round2(fixture.groupOf('production').cash),
      deposit:
        depositAccountFor(fixture.world, { kind: 'household', id: fixture.groupOf('production').id })
          ?.balance ?? 0,
      loans: fixture.world.householdFinance?.loans.length ?? 0,
      foodStock: fixture.world.companies.find((entry) => entry.cityId === LANPORT)!.inventory.food,
      ledgerSpend: consumerSpend(fixture),
    };

    const result = fixture.run();
    const entry = result.byGroup![fixture.groupOf('production').id]!;

    expect(entry.spend).toBe(0);
    expect(entry.bought.food ?? 0).toBe(0);
    expect(entry.loanFinanced ?? 0).toBe(0);
    expect(fixture.world.householdFinance?.loans ?? []).toHaveLength(0);
    expect(entry.depositWithdrawn ?? 0).toBe(0);
    // 失败路径：现金、存款、库存、市场成交台账都不变。
    expect(round2(fixture.groupOf('production').cash)).toBe(before.cash);
    expect(
      depositAccountFor(fixture.world, { kind: 'household', id: fixture.groupOf('production').id })
        ?.balance ?? 0,
    ).toBe(before.deposit);
    expect(fixture.world.householdFinance?.loans.length ?? 0).toBe(before.loans);
    expect(fixture.world.companies.find((entry) => entry.cityId === LANPORT)!.inventory.food).toBe(
      before.foodStock,
    );
    expect(consumerSpend(fixture)).toBe(before.ledgerSpend);
  });
});
