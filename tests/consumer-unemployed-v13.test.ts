// v1.3 任务书 §6「消费侧：失业居民消费与预算/缺货/无需求分账」回归测试。
//
// 覆盖验收要点：
// 1) 失业居民收入为 0 时，现金预算=min(现金, 0.8×收入+5%现金) 只有手头现金的 5%，
//    但基本需求不因失业系数或预算不足被削减：预算不足时允许动用更多当前现金，
//    支付顺序仍是 现金 → 存款（每月≤月初 5%）→ 合规消费贷。
// 2) 有存款 / 有授信 / 有商品 / 缺货 / 无有效需求 五类场景分别验证：
//    - “有钱但缺货”记供给缺口（entry.unmet、ledger.unmetDemand）；
//    - “有货但没钱”记资金缺口（entry.unmetFunding）；
//    - 预算不足未形成的有效需求（affordability）既不进 consumerDemand，也不进缺货。
// 3) 无真实商品供给时不得成交 / 放贷 / 提款。
// 4) 分账守恒：bought + unmet + unmetFunding/价格 = effective（不重复计算、不虚增）。
// 5) 多个月连续运行不出现“收入 0 → 预算归零 → 永不消费”的规则死锁。
//
// 测试使用真实 Simulation 世界与真实本地市场，只把目标城市其他群体的人口/现金清零、
// 关闭跨城补货、把消费价格与价格系数固定为基准值，便于手算核对。

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
import type { GoodId, HouseholdGroup, HouseholdLoanContract, WorldState } from '../src/simulation/contracts/types';

const CONFIG: DemoConfig = {
  ...DEMO_CONFIG,
  intercity: { ...DEMO_CONFIG.intercity, enabled: false },
} as unknown as DemoConfig;

// 关闭消费贷授信：用于隔离“现金 + 存款”路径，避免投资实体权益带来巨额授信。
const NO_LOAN_CONFIG: DemoConfig = {
  ...CONFIG,
  households: {
    ...DEMO_CONFIG.households,
    householdCredit: { ...DEMO_CONFIG.households.householdCredit, creditLimitRate: 0 },
  },
} as unknown as DemoConfig;

const CONSUMER_GOODS = GOODS.filter((good) => good.category === 'consumer');
const FOOD_PRICE = GOODS.find((good) => good.id === 'food')!.basePrice;
const FOOD_NEED = GOODS.find((good) => good.id === 'food')!.perCapitaMonthlyNeed;
const PEOPLE = 100;
const BASIC_NEED_QTY = PEOPLE * FOOD_NEED; // 2600
const BASIC_NEED_COST = round2(BASIC_NEED_QTY * FOOD_PRICE); // 143000
const TOL = 0.05;
const LANPORT = 'lanport';

interface Fixture {
  world: WorldState;
  city: WorldState['cities'][number];
  ledgers: ReturnType<typeof createWorldLedgers>[string];
  group: HouseholdGroup;
  setCash: (value: number) => void;
  setDeposit: (value: number) => void;
  depositBalance: () => number;
  setSupply: (supply: Partial<Record<GoodId, number>>) => void;
  loans: () => HouseholdLoanContract[];
  run: (config?: DemoConfig) => ReturnType<typeof runConsumerMarket>;
}

/**
 * 构造只有岚港失业居民的干净世界：
 * - 所有群体的人民/现金/收入/存款/贷款统计清零，目标群体（unemployed）人口=100；
 * - 本地市场消费价格=基准价、企业价格系数=1、消费品库存清零后由用例设定；
 * - 默认把居民投资实体权益清零，使消费贷额度只取决于手头现金+存款；
 *   keepInvestors=true 时保留真实投资实体权益，用于验证“无现金但有授信可贷”。
 * - 关闭跨城补货，成交只来自本地真实市场。
 */
function buildFixture(keepInvestors = false): Fixture {
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
  if (!keepInvestors) {
    for (const investor of world.investors) {
      if (investor.cityId !== city.id) continue;
      investor.cash = 0;
      for (const holding of world.securities.holdings) {
        if (holding.holder.type === 'investorGroup' && holding.holder.id === investor.id) {
          holding.shares = 0;
        }
      }
    }
  }

  const group = groups.find((entry) => entry.occupation === 'unemployed')!;
  group.people = PEOPLE;
  group.cash = 0;
  ensureDepositAccount(world, { kind: 'household', id: group.id }, CONFIG, world.time.tick);

  const ledgers = createWorldLedgers(world)[city.id]!;
  const depositBalance = () =>
    depositAccountFor(world, { kind: 'household', id: group.id })?.balance ?? 0;

  return {
    world,
    city,
    ledgers,
    group,
    setCash: (value) => {
      group.cash = value;
    },
    setDeposit: (value) => {
      const account = depositAccountFor(world, { kind: 'household', id: group.id })!;
      account.balance = value;
    },
    depositBalance,
    setSupply: (supply) => {
      let first = true;
      for (const company of world.companies) {
        if (company.cityId !== city.id) continue;
        for (const good of CONSUMER_GOODS) company.inventory[good.id] = 0;
        if (first) {
          for (const [goodId, quantity] of Object.entries(supply)) {
            company.inventory[goodId as GoodId] = quantity as number;
          }
          first = false;
        }
      }
    },
    loans: () =>
      (world.householdFinance?.loans ?? []).filter((loan) => loan.groupId === group.id),
    run: (config = CONFIG) => runConsumerMarket(world, city, ledgers, config),
  };
}

/** 每月开始时重置“本月已提存款”，与模拟 resetCompanyMonth 的口径一致。 */
function startMonth(fixture: Fixture): void {
  fixture.world.time.tick += 1;
  fixture.group.lastMonth.depositWithdrawn = 0;
}

describe('v1.3 §6 失业居民消费：预算 / 存款 / 授信 / 缺货 / 有效需求', () => {
  it('收入为 0 但持有现金：基本需求不乘失业系数、不被现金预算阻挡，非基本需求仍受预算约束', () => {
    const fixture = buildFixture();
    fixture.setCash(200_000);
    fixture.setSupply({ food: 100_000, clothing: 100_000, household: 100_000 });

    const result = fixture.run(NO_LOAN_CONFIG);
    const entry = result.byGroup![fixture.group.id]!;

    // 预算=min(现金, 0.8×0+5%×现金)=10,000；但基本需求不按预算缩放。
    expect(entry.dailyBudget).toBeCloseTo(10_000, 2);
    expect(entry.basicNeedCost).toBeCloseTo(BASIC_NEED_COST, 2);
    expect(entry.desired?.food).toBeCloseTo(BASIC_NEED_QTY, 2);
    expect(entry.effective?.food).toBeCloseTo(BASIC_NEED_QTY, 2);
    // 基本需求实际成交 143,000，远超 10,000 的日常预算。
    expect(entry.spend).toBeCloseTo(BASIC_NEED_COST, 2);
    expect(entry.cashPaid).toBeCloseTo(BASIC_NEED_COST, 2);
    expect(entry.depositWithdrawn).toBeCloseTo(0, 2);
    expect(entry.loanFinanced).toBeCloseTo(0, 2);
    expect(entry.bought.food).toBeCloseTo(BASIC_NEED_QTY, 2);
    expect(entry.unmet.food ?? 0).toBeCloseTo(0, 2);
    expect(entry.unmetFunding).toBeCloseTo(0, 2);
    expect(fixture.group.cash).toBeCloseTo(200_000 - BASIC_NEED_COST, 2);
    expect(fixture.depositBalance()).toBeCloseTo(0, 2);
    expect(fixture.loans()).toHaveLength(0);

    // 失业只影响非基本消费意愿（乘 0.72），不影响基本需求数量。
    const clothing = GOODS.find((good) => good.id === 'clothing')!;
    expect(entry.desired?.clothing).toBeCloseTo(
      round2(PEOPLE * clothing.perCapitaMonthlyNeed * CONFIG.consumer.unemployedNeedFactor),
      2,
    );
    // 基本需求已吃满日常预算（143,000 > 10,000），非基本有效需求为 0，且不记缺货/资金缺口。
    expect(entry.effective?.clothing ?? 0).toBeCloseTo(0, 2);
    expect(entry.bought.clothing ?? 0).toBeCloseTo(0, 2);
    expect(entry.unmet.clothing ?? 0).toBeCloseTo(0, 2);

    // 台账：真实成交只记 sold，且不虚增需求。
    expect(fixture.ledgers.food!.consumerDemand).toBeCloseTo(BASIC_NEED_QTY, 2);
    expect(fixture.ledgers.food!.sold).toBeCloseTo(BASIC_NEED_QTY, 2);
    expect(fixture.ledgers.food!.unmetDemand).toBeCloseTo(0, 2);
    expect(fixture.group.lastMonth.consumption).toBeCloseTo(BASIC_NEED_COST, 2);
    expect(fixture.group.lastMonth.unmetFunding).toBeCloseTo(0, 2);
  });

  it('有存款无现金：按月初存款 5% 提款支付基本需求，余额不重复计入', () => {
    const fixture = buildFixture();
    fixture.setDeposit(100_000);
    fixture.setSupply({ food: 100_000 });

    const result = fixture.run(NO_LOAN_CONFIG);
    const entry = result.byGroup![fixture.group.id]!;

    // 本月最多可提 100,000×5%=5,000；按 55 的价格网格实际提款 4,999.5。
    expect(entry.depositWithdrawn).toBeGreaterThan(0);
    expect(entry.depositWithdrawn!).toBeLessThanOrEqual(round2(100_000 * 0.05) + TOL);
    expect(entry.depositWithdrawn).toBeCloseTo(4_999.5, 2);
    expect(fixture.depositBalance()).toBeCloseTo(100_000 - entry.depositWithdrawn!, 2);
    expect(entry.cashPaid).toBeCloseTo(0, 2);
    expect(entry.spend).toBeCloseTo(entry.depositWithdrawn!, 2);
    expect(entry.bought.food).toBeCloseTo(90.9, 2);
    expect(entry.loanFinanced).toBeCloseTo(0, 2);
    expect(fixture.loans()).toHaveLength(0);
    expect(fixture.group.cash).toBeCloseTo(0, 2);

    // 没提完/买不起的剩余需求属于资金缺口，不是缺货。
    expect(entry.unmet.food ?? 0).toBeCloseTo(0, 2);
    expect(entry.unmetFunding).toBeCloseTo(round2((BASIC_NEED_QTY - 90.9) * FOOD_PRICE), 2);
    // 台账只记录真实尝试过的需求，未尝试的资金缺口不混入缺货。
    expect(fixture.ledgers.food!.consumerDemand).toBeCloseTo(90.9, 2);
    expect(fixture.ledgers.food!.sold).toBeCloseTo(90.9, 2);
    expect(fixture.ledgers.food!.unmetDemand).toBeCloseTo(0, 2);
  });

  it('有授信无现金：消费贷补足真实基本需求，贷款额=实际成交额且不虚增收入', () => {
    // 保留真实投资实体权益，让该群体在无现金/存款时仍有授信额度。
    const fixture = buildFixture(true);
    fixture.setSupply({ food: 100_000 });

    const result = fixture.run();
    const entry = result.byGroup![fixture.group.id]!;
    const loans = fixture.loans();

    expect(entry.loanAvailable ?? 0).toBeGreaterThan(BASIC_NEED_COST);
    expect(entry.spend).toBeCloseTo(BASIC_NEED_COST, 2);
    expect(entry.cashPaid).toBeCloseTo(0, 2);
    expect(entry.depositWithdrawn).toBeCloseTo(0, 2);
    expect(entry.loanFinanced).toBeCloseTo(BASIC_NEED_COST, 2);
    expect(entry.bought.food).toBeCloseTo(BASIC_NEED_QTY, 2);
    expect(entry.unmet.food ?? 0).toBeCloseTo(0, 2);
    expect(entry.unmetFunding).toBeCloseTo(0, 2);

    expect(loans).toHaveLength(1);
    expect(loans[0]!.principal).toBeCloseTo(entry.loanFinanced!, 2);
    // 贷款只是资金来源，不是收入。
    expect(fixture.group.lastMonth.income).toBeCloseTo(0, 2);
    expect(fixture.group.lastMonth.loanDrawn).toBeCloseTo(entry.loanFinanced!, 2);
    expect(fixture.group.lastMonth.loanFinancedConsumption).toBeCloseTo(entry.loanFinanced!, 2);
    expect(fixture.group.cash).toBeCloseTo(0, 2);

    expect(fixture.ledgers.food!.consumerDemand).toBeCloseTo(BASIC_NEED_QTY, 2);
    expect(fixture.ledgers.food!.sold).toBeCloseTo(BASIC_NEED_QTY, 2);
    expect(fixture.ledgers.food!.unmetDemand).toBeCloseTo(0, 2);
  });

  it('存款+授信、无现金：顺序为 现金(0) → 存款(≤5%) → 消费贷，金额闭合', () => {
    const fixture = buildFixture();
    fixture.setDeposit(100_000);
    fixture.setSupply({ food: 100_000 });

    const result = fixture.run(CONFIG);
    const entry = result.byGroup![fixture.group.id]!;
    const loans = fixture.loans();

    // 先提 4,999.5 存款，剩余由授信额度 50,000 内的消费贷补足。
    expect(entry.depositWithdrawn).toBeCloseTo(4_999.5, 2);
    expect(entry.loanFinanced).toBeGreaterThan(0);
    expect(entry.loanFinanced!).toBeLessThanOrEqual(50_000 + TOL);
    expect(entry.spend).toBeCloseTo(round2(entry.depositWithdrawn! + entry.loanFinanced!), 2);
    expect(entry.cashPaid).toBeCloseTo(0, 2);
    expect(fixture.depositBalance()).toBeCloseTo(100_000 - entry.depositWithdrawn!, 2);
    expect(fixture.group.cash).toBeCloseTo(0, 2);

    expect(loans).toHaveLength(1);
    expect(loans[0]!.principal).toBeCloseTo(entry.loanFinanced!, 2);

    expect(entry.bought.food).toBeCloseTo(999.98, 2);
    // 报价与成交 0.01 的取整尾差允许计入缺货；口径核心是“全部有效需求都有供给成交”。
    expect(entry.unmet.food ?? 0).toBeLessThan(0.05);
    expect(entry.unmetFunding).toBeCloseTo(
      round2(
        (BASIC_NEED_QTY - entry.bought.food - (entry.unmet.food ?? 0)) * FOOD_PRICE,
      ),
      1,
    );
    expect(fixture.ledgers.food!.sold).toBeCloseTo(999.98, 2);
    expect(fixture.ledgers.food!.unmetDemand).toBeCloseTo(0, 1);
  });

  it('有存款/授信但无真实供给：不成交、不放贷、不提款、无任何副作用', () => {
    const fixture = buildFixture();
    fixture.setDeposit(100_000);
    fixture.setSupply({});

    const result = fixture.run(CONFIG);
    const entry = result.byGroup![fixture.group.id]!;

    expect(entry.spend).toBeCloseTo(0, 2);
    expect(entry.bought.food ?? 0).toBeCloseTo(0, 2);
    expect(entry.depositWithdrawn).toBeCloseTo(0, 2);
    expect(entry.loanFinanced).toBeCloseTo(0, 2);
    expect(fixture.loans()).toHaveLength(0);
    expect(fixture.depositBalance()).toBeCloseTo(100_000, 2);
    expect(fixture.group.cash).toBeCloseTo(0, 2);
    for (const good of CONSUMER_GOODS) {
      expect(fixture.ledgers[good.id]!.spend ?? 0).toBeCloseTo(0, 2);
      expect(fixture.ledgers[good.id]!.sold ?? 0).toBeCloseTo(0, 2);
    }

    // 有真实需求但无供给：只有“真实尝试购买”的部分记缺货（4,999.5/55≈90.9 件），
    // 因存款/授信不足以把全部基本需求拿去尝试的部分记资金缺口；不放贷、不提款。
    expect(entry.unmet.food).toBeCloseTo(90.9, 1);
    expect(entry.unmetFunding).toBeCloseTo(round2((BASIC_NEED_QTY - 90.9) * FOOD_PRICE), 1);
    expect(fixture.ledgers.food!.sold).toBeCloseTo(0, 2);
    expect(fixture.ledgers.food!.unmetDemand).toBeGreaterThan(0);
  });

  it('分账守恒：有钱缺货记缺货、有货没钱记资金缺口，bought+unmet+unmetFunding/价格=effective', () => {
    const assertSplit = (
      fixture: Fixture,
      config: DemoConfig,
      expected: { category: 'supply' | 'funding' | 'mixed'; bought: number; supply: number; funding: number },
    ) => {
      const entry = fixture.run(config).byGroup![fixture.group.id]!;
      const effective = entry.effective?.food ?? 0;
      expect(entry.bought.food).toBeCloseTo(expected.bought, 2);
      expect(entry.unmet.food ?? 0).toBeCloseTo(expected.supply, 2);
      expect(entry.unmetFunding ?? 0).toBeCloseTo(expected.funding, 2);
      // 四层口径守恒：不重复计算、不虚增。
      expect(round2((entry.bought.food ?? 0) + (entry.unmet.food ?? 0) + (entry.unmetFunding ?? 0) / FOOD_PRICE)).toBeCloseTo(
        effective,
        2,
      );
      // 资金缺口不以缺口形式进入 ledger 的 unmetDemand；ledger 只反映尝试过的需求。
      expect(
        round2(fixture.ledgers.food!.sold + fixture.ledgers.food!.unmetDemand),
      ).toBeCloseTo(fixture.ledgers.food!.consumerDemand, 2);
    };

    // 有钱但缺货：供给缺口 2600，资金缺口 0。
    const supplyShortage = buildFixture();
    supplyShortage.setCash(200_000);
    supplyShortage.setSupply({});
    assertSplit(supplyShortage, NO_LOAN_CONFIG, {
      category: 'supply',
      bought: 0,
      supply: BASIC_NEED_QTY,
      funding: 0,
    });
    expect(supplyShortage.ledgers.food!.unmetDemand).toBeCloseTo(BASIC_NEED_QTY, 2);

    // 有货但没钱：资金缺口 143,000，缺货 0，且 ledger 不记虚构需求。
    const fundingShortage = buildFixture();
    fundingShortage.setCash(0);
    fundingShortage.setSupply({ food: 100_000 });
    assertSplit(fundingShortage, NO_LOAN_CONFIG, {
      category: 'funding',
      bought: 0,
      supply: 0,
      funding: BASIC_NEED_COST,
    });
    expect(fundingShortage.ledgers.food!.consumerDemand).toBeCloseTo(0, 2);
    expect(fundingShortage.ledgers.food!.unmetDemand).toBeCloseTo(0, 2);

    // 混合场景（现金只够 90.9 件、本地只有 50 件）：真实尝试 90.9 件、成交 50 件，
    // 因此 40.9 件记缺货；因资金不足没有尝试的 2,509.1 件记资金缺口（v1.3 分账口径）。
    const mixed = buildFixture();
    mixed.setCash(5_000);
    mixed.setSupply({ food: 50 });
    assertSplit(mixed, NO_LOAN_CONFIG, {
      category: 'mixed',
      bought: 50,
      supply: round2(BASIC_NEED_QTY - 50 - 2_509.1),
      funding: round2(2_509.1 * FOOD_PRICE),
    });
    // ledger 只记录真实尝试过的 90.9 件；40.9 件尝试后未成交才是 ledger 口径的缺货。
    expect(mixed.ledgers.food!.consumerDemand).toBeCloseTo(90.9, 2);
    expect(mixed.ledgers.food!.sold).toBeCloseTo(50, 2);
    expect(mixed.ledgers.food!.unmetDemand).toBeCloseTo(40.9, 2);
  });

  it('连续月份无预算死锁：收入为 0 仍逐月用现金/存款消费，现金耗尽才停止', () => {
    const fixture = buildFixture();
    fixture.setCash(200_000);
    fixture.setSupply({ food: 1_000_000 });

    // 第 1 个月：现金支付全部基本需求。
    const first = fixture.run(NO_LOAN_CONFIG).byGroup![fixture.group.id]!;
    expect(first.spend).toBeCloseTo(BASIC_NEED_COST, 2);
    expect(fixture.group.cash).toBeCloseTo(200_000 - BASIC_NEED_COST, 2);

    // 第 2 个月：现金只剩 57,000，预算只有 5%×57,000=2,850，但基本需求仍按现金上限真实成交。
    startMonth(fixture);
    const second = fixture.run(NO_LOAN_CONFIG).byGroup![fixture.group.id]!;
    expect(second.spend).toBeGreaterThan(0);
    expect(second.spend).toBeLessThanOrEqual(200_000 - BASIC_NEED_COST + TOL);
    expect(second.dailyBudget).toBeCloseTo(round2((200_000 - BASIC_NEED_COST) * 0.05), 2);
    expect(second.cashPaid).toBeCloseTo(second.spend, 2);
    expect(fixture.group.cash).toBeLessThanOrEqual(1);
    expect(fixture.ledgers.food!.sold).toBeGreaterThan(BASIC_NEED_QTY);

    // 第 3 个月起现金为 0、存款为 0：不再成交，但这是“没有购买力”，不是预算规则死锁。
    startMonth(fixture);
    const third = fixture.run(NO_LOAN_CONFIG).byGroup![fixture.group.id]!;
    // 手头只剩不到 1 信用点，只能买到 0.01 件；其余全部是资金缺口而非缺货。
    expect(third.spend).toBeLessThanOrEqual(1);
    expect(third.unmetFunding).toBeGreaterThan(BASIC_NEED_COST - 1);
    expect(third.unmet.food ?? 0).toBeCloseTo(0, 2);
    expect(fixture.loans()).toHaveLength(0);
  });

  it('连续月份存款提取按月初余额滚动，每月不超过 5%', () => {
    const fixture = buildFixture();
    fixture.setDeposit(100_000);
    fixture.setSupply({ food: 1_000_000 });

    let previousBalance = 100_000;
    let totalWithdrawn = 0;
    for (let month = 0; month < 3; month += 1) {
      if (month > 0) startMonth(fixture);
      const entry = fixture.run(NO_LOAN_CONFIG).byGroup![fixture.group.id]!;
      expect(entry.depositWithdrawn).toBeGreaterThan(0);
      expect(entry.depositWithdrawn!).toBeLessThanOrEqual(round2(previousBalance * 0.05) + TOL);
      expect(entry.spend).toBeCloseTo(entry.depositWithdrawn!, 2);
      expect(fixture.depositBalance()).toBeCloseTo(previousBalance - entry.depositWithdrawn!, 2);
      previousBalance = fixture.depositBalance();
      totalWithdrawn = round2(totalWithdrawn + entry.depositWithdrawn!);
    }
    expect(totalWithdrawn).toBeGreaterThan(0);
    expect(previousBalance).toBeGreaterThan(0);
    // 三个月累计提取 ≈ 100,000×(1−0.95³)（价格网格导致略低于理论值）。
    expect(totalWithdrawn).toBeGreaterThan(round2(100_000 * (1 - 0.95 ** 3)) - 100);
    expect(totalWithdrawn).toBeLessThanOrEqual(round2(100_000 * (1 - 0.95 ** 3)) + TOL);
  });
});
