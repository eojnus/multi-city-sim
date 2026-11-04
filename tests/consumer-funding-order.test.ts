// v0.9 验收问题一：居民消费资金支付顺序（现金 → 存款提取 → 消费贷）真实市场回归测试。
//
// 背景：runConsumerMarket 的消费贷阶段曾只按可借额度补“有效需求−已成交”缺口，
// 忽略本月尚未使用的现金与可提存款，导致有大量现金/存款的群体仍然借款。
// 本测试用真实 Simulation 世界与真实本地市场核对：成交额 = 现金支付 + 存款提取 + 新增贷款，
// 且失败（无供给）时不得放款、不得成交、不得提存款、不留任何副作用。

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
import type { HouseholdGroup, WorldState } from '../src/simulation/contracts/types';

const CONFIG: DemoConfig = {
  ...DEMO_CONFIG,
  intercity: { ...DEMO_CONFIG.intercity, enabled: false },
} as unknown as DemoConfig;
const CONSUMER_GOODS = GOODS.filter((good) => good.category === 'consumer');
const TOL = 0.05;

interface MarketFixture {
  world: WorldState;
  ledgers: ReturnType<typeof createWorldLedgers>[string];
  group: HouseholdGroup;
  depositBalance: () => number;
  setCash: (cash: number) => void;
  setDeposit: (balance: number) => void;
  setSupply: (quantity: number) => void;
}

/**
 * 构造只保留一个目标群体的岚港世界：
 * - 其他群体的 people 置 0（不产生消费需求，也不会因授信而干扰市场）；
 * - 目标群体人数固定 100，人口/需求可预测；
 * - 本地市场价格回归基准价、企业价格系数 1，便于手算；
 * - 本地库存可设定（0 = 无供给），跨城补货关闭，成交只来自本地真实市场。
 */
function buildFixture(): MarketFixture {
  const world = Simulation.create().state;
  const city = world.cities.find((entry) => entry.id === 'lanport')!;
  const groups = householdGroupsOfCity(world, city.id);
  const target = groups.find((group) => group.occupation === 'production')!;

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
  target.people = 100;

  // 本地市场：价格=基准价；企业价格系数=1；库存先清零，再由用例设定。
  for (const good of CONSUMER_GOODS) {
    const state = city.market[good.id];
    if (state) state.price = good.basePrice;
  }
  for (const company of world.companies) {
    if (company.cityId !== city.id) continue;
    company.priceFactor = 1;
    for (const good of CONSUMER_GOODS) company.inventory[good.id] = 0;
  }
  // 居民投资实体权益清零，使消费贷额度只取决于手头现金+存款，便于对账。
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

  return {
    world,
    ledgers,
    group: target,
    depositBalance: () => round2(depositAccountFor(world, depositOwner)?.balance ?? 0),
    setCash: (cash: number) => {
      target.cash = round2(cash);
    },
    setDeposit: (balance: number) => {
      const account = depositAccountFor(world, depositOwner);
      if (account) account.balance = round2(balance);
    },
    setSupply: (quantity: number) => {
      const company = world.companies.find((entry) => entry.cityId === city.id)!;
      for (const good of CONSUMER_GOODS) company.inventory[good.id] = 0;
      if (quantity > 0) {
        // 只给食品供货：即可支撑成交，又能保证消费贷金额受真实供给约束。
        company.inventory.food = quantity;
      }
    },
  };
}

function consumerLedgerSpend(fixture: MarketFixture): number {
  let total = 0;
  for (const good of CONSUMER_GOODS) total = round2(total + (fixture.ledgers[good.id]?.spend ?? 0));
  return total;
}

function consumerLedgerSold(fixture: MarketFixture): number {
  let total = 0;
  for (const good of CONSUMER_GOODS) total = round2(total + (fixture.ledgers[good.id]?.sold ?? 0));
  return total;
}

function snapshotSideEffects(fixture: MarketFixture) {
  const companies = fixture.world.companies.map((company) => ({
    id: company.id,
    cash: company.cash,
    revenue: company.lastMonth.revenue,
    food: company.inventory.food ?? 0,
  }));
  const ledgers = CONSUMER_GOODS.map((good) => ({
    goodId: good.id,
    sold: fixture.ledgers[good.id]?.sold ?? 0,
    spend: fixture.ledgers[good.id]?.spend ?? 0,
    transactionCount: fixture.ledgers[good.id]?.transactionCount ?? 0,
  }));
  return {
    companies,
    ledgers,
    deposit: fixture.depositBalance(),
    cash: round2(fixture.group.cash),
    loans: fixture.world.householdFinance?.loans.length ?? 0,
  };
}

describe('v0.9 验收一：居民消费资金支付顺序（现金→存款→消费贷）', () => {
  it('现金充足：成交完全由手头现金支付，不提存款、不放贷', () => {
    const fixture = buildFixture();
    fixture.setCash(1_000_000);
    fixture.setDeposit(0);
    fixture.setSupply(1_000_000);
    const cashBefore = round2(fixture.group.cash);

    const result = runConsumerMarket(fixture.world, fixture.world.cities.find((c) => c.id === 'lanport')!, fixture.ledgers, CONFIG);
    const entry = result.byGroup?.[fixture.group.id];
    expect(entry).toBeDefined();
    expect(entry!.spend).toBeGreaterThan(0);
    expect(entry!.loanFinanced ?? 0).toBe(0);
    expect(entry!.depositWithdrawn ?? 0).toBe(0);
    expect(entry!.cashPaid ?? 0).toBeCloseTo(entry!.spend, 2);
    // 现金减少 = 实际现金支付额，存款不动，无新增债务。
    expect(cashBefore - fixture.group.cash).toBeCloseTo(entry!.spend, 2);
    expect(fixture.depositBalance()).toBe(0);
    expect(fixture.world.householdFinance?.loans ?? []).toHaveLength(0);
    // 市场账目与实际成交额一致。
    expect(consumerLedgerSpend(fixture)).toBeCloseTo(entry!.spend, 2);
    expect(consumerLedgerSold(fixture)).toBeCloseTo(
      CONSUMER_GOODS.reduce((sum, good) => sum + (entry!.bought[good.id] ?? 0), 0),
      2,
    );
  });

  it('现金不足但有存款：先提存款补足，不在有可提存款时借款', () => {
    const fixture = buildFixture();
    fixture.setCash(300);
    fixture.setDeposit(1_000_000);
    fixture.setSupply(1_000_000);
    const cashBefore = round2(fixture.group.cash);

    const result = runConsumerMarket(fixture.world, fixture.world.cities.find((c) => c.id === 'lanport')!, fixture.ledgers, CONFIG);
    const entry = result.byGroup?.[fixture.group.id];
    expect(entry).toBeDefined();
    expect(entry!.spend).toBeGreaterThan(0);
    // 存款提取（≤ 月初存款 5%=50000）覆盖现金之外的成交，不产生消费贷。
    const withdrawn = entry!.depositWithdrawn ?? 0;
    expect(withdrawn).toBeGreaterThan(0);
    expect(withdrawn).toBeLessThanOrEqual(50_000 + TOL);
    expect(entry!.loanFinanced ?? 0).toBe(0);
    expect(fixture.world.householdFinance?.loans ?? []).toHaveLength(0);
    // 三方对账：成交额 = 现金支付 + 存款提取 + 贷款（此处贷款为 0）。
    expect(entry!.spend).toBeCloseTo(round2((entry!.cashPaid ?? 0) + withdrawn + (entry!.loanFinanced ?? 0)), 2);
    expect(cashBefore - fixture.group.cash).toBeCloseTo(entry!.cashPaid ?? 0, 2);
    expect(cashBefore + withdrawn - entry!.spend).toBeCloseTo(fixture.group.cash, 2);
    expect(fixture.depositBalance()).toBeCloseTo(1_000_000 - withdrawn, 2);
    expect(consumerLedgerSpend(fixture)).toBeCloseTo(entry!.spend, 2);
  });

  it('现金与可提存款均不足：剩余缺口才用消费贷，贷款额=成交额−现金−存款提取', () => {
    const fixture = buildFixture();
    fixture.setCash(0);
    fixture.setDeposit(10_000);
    fixture.setSupply(1_000_000);

    const result = runConsumerMarket(fixture.world, fixture.world.cities.find((c) => c.id === 'lanport')!, fixture.ledgers, CONFIG);
    const entry = result.byGroup?.[fixture.group.id];
    expect(entry).toBeDefined();
    const withdrawn = entry!.depositWithdrawn ?? 0;
    const financed = entry!.loanFinanced ?? 0;
    expect(entry!.spend).toBeGreaterThan(0);
    // 存款提取受本月上限 5%（500）约束（成交按 0.01 网格舍入，略低于上限），之后剩余缺口才借款。
    expect(withdrawn).toBeGreaterThan(0);
    expect(withdrawn).toBeLessThanOrEqual(500 + TOL);
    expect(financed).toBeGreaterThan(0);
    expect(entry!.cashPaid ?? 0).toBe(0);
    // 核心口径：成交额 = 现金 + 存款提取 + 贷款，贷款只补真实成交缺口。
    expect(financed).toBeCloseTo(round2(entry!.spend - (entry!.cashPaid ?? 0) - withdrawn), 2);
    expect(fixture.world.householdFinance?.loans ?? []).toHaveLength(1);
    const loan = fixture.world.householdFinance!.loans[0]!;
    expect(loan.principal).toBeCloseTo(financed, 2);
    expect(loan.outstanding).toBeCloseTo(financed, 2);
    expect(loan.groupId).toBe(fixture.group.id);
    // 净账目：现金减少=现金支付（0）、存款减少=提取、债务增加=贷款。
    expect(fixture.group.cash).toBeCloseTo(0, 2);
    expect(fixture.depositBalance()).toBeCloseTo(10_000 - withdrawn, 2);
    expect(consumerLedgerSpend(fixture)).toBeCloseTo(entry!.spend, 2);
  });

  it('有贷款额度但本地无供给：不放款、不成交、不提存款、无任何副作用', () => {
    const fixture = buildFixture();
    fixture.setCash(0);
    fixture.setDeposit(1_000);
    fixture.setSupply(0);
    const before = snapshotSideEffects(fixture);

    const result = runConsumerMarket(fixture.world, fixture.world.cities.find((c) => c.id === 'lanport')!, fixture.ledgers, CONFIG);
    const entry = result.byGroup?.[fixture.group.id];
    expect(entry).toBeDefined();
    expect(entry!.spend).toBe(0);
    expect(entry!.loanFinanced ?? 0).toBe(0);
    expect(entry!.depositWithdrawn ?? 0).toBe(0);
    expect(entry!.bought.food ?? 0).toBe(0);
    expect(fixture.world.householdFinance?.loans ?? []).toHaveLength(0);
    // 失败路径不留任何副作用：企业、台账、存款、现金、债务都不变。
    expect(snapshotSideEffects(fixture)).toEqual(before);
  });
});
