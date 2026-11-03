// 批次 3/4（v0.7 验收问题 3）：居民消费贷与商品成交必须原子一致。
//
// 口径来源：DECISIONS v1.5 #40、任务书 §5“居民消费贷”、验收问题 3。
// 断言统一带浮点容差；只写测试，不改产品代码。

import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation/core/simulation';
import { DEMO_CONFIG } from '../src/data/config';
import type { City, GoodId, HouseholdGroup, WorldState } from '../src/simulation/contracts/types';
import type { CityLedgers } from '../src/simulation/markets/markets';
import { round2 } from '../src/simulation/core/math';
import { parseSave, serializeSave } from '../src/simulation/core/save';
import { createWorldLedgers, finalizeMarkets } from '../src/simulation/markets/markets';
import { runConsumerMarket } from '../src/simulation/markets/consumer';
import {
  borrowForConsumption,
  householdCreditLimit,
} from '../src/simulation/population/household-finance';
import { householdGroupsOfCity } from '../src/simulation/population/household-groups';
import { depositAccountFor } from '../src/simulation/banking/banking';

const CONFIG = DEMO_CONFIG;
const TOL = 0.05;
const CONSUMER_GOODS: GoodId[] = ['food', 'clothing', 'household'];

function newWorld(): WorldState {
  return Simulation.create().state;
}

function cityAt(world: WorldState, index = 0): City {
  const city = world.cities[index];
  if (!city) throw new Error(`缺少第 ${index} 个城市`);
  return city;
}

function groupOf(
  world: WorldState,
  city: City,
  occupation: HouseholdGroup['occupation'],
): HouseholdGroup {
  const group = householdGroupsOfCity(world, city.id).find(
    (entry) => entry.occupation === occupation,
  );
  if (!group) throw new Error(`缺少群体：${city.id}/${occupation}`);
  return group;
}

/**
 * 清零该城居民的现金、存款与投资实体权益，使“可借额度”只能由本测试显式设置的存款决定，
 * 避免初始财富把授信额度抬到看不见上限的程度。只动测试数据，不触发任何产品逻辑。
 */
function neutralizeHouseholds(world: WorldState, city: City): void {
  for (const group of householdGroupsOfCity(world, city.id)) {
    group.cash = 0;
    group.lastMonth.income = 0;
    group.lastMonth.consumption = 0;
    group.lastMonth.desiredConsumption = 0;
    group.lastMonth.loanDrawn = 0;
    group.lastMonth.loanFinancedConsumption = 0;
    group.lastMonth.unmetFunding = 0;
    const account = depositAccountFor(world, { kind: 'household', id: group.id });
    if (account) account.balance = 0;
  }
  for (const investor of world.investors) {
    if (investor.cityId !== city.id) continue;
    investor.cash = 0;
    for (const holding of world.securities.holdings) {
      if (holding.holder.type !== 'investorGroup' || holding.holder.id !== investor.id) continue;
      holding.shares = 0;
    }
  }
}

function setGroupDeposits(world: WorldState, group: HouseholdGroup, amount: number): void {
  const account = depositAccountFor(world, { kind: 'household', id: group.id });
  if (!account) throw new Error(`群体缺少存款账户：${group.id}`);
  account.balance = amount;
}

interface SaleState {
  companies: Array<{
    id: string;
    cash: number;
    inventory: Record<string, number>;
    revenue: number;
    sold: number;
  }>;
  ledgers: Array<{
    goodId: GoodId;
    sold: number;
    spend: number;
    consumerDemand: number;
    demand: number;
    transactionCount: number;
    unmetDemand: number;
  }>;
}

/** 卖方与消费类台账的快照：用于断言“失败时任何主体都不变”。 */
function captureSaleState(world: WorldState, city: City, ledgers: CityLedgers): SaleState {
  return {
    companies: world.companies
      .filter((company) => company.cityId === city.id)
      .map((company) => ({
        id: company.id,
        cash: company.cash,
        inventory: { ...company.inventory },
        revenue: company.lastMonth.revenue,
        sold: company.lastMonth.sold,
      })),
    ledgers: CONSUMER_GOODS.map((goodId) => {
      const ledger = ledgers[goodId];
      return {
        goodId,
        sold: ledger.sold,
        spend: ledger.spend,
        consumerDemand: ledger.consumerDemand,
        demand: ledger.demand,
        transactionCount: ledger.transactionCount,
        unmetDemand: ledger.unmetDemand,
      };
    }),
  };
}

function marketSetup(): {
  world: WorldState;
  city: City;
  group: HouseholdGroup;
  ledgers: CityLedgers;
} {
  const world = newWorld();
  const city = cityAt(world);
  neutralizeHouseholds(world, city);
  const group = groupOf(world, city, 'production');
  const ledgers = createWorldLedgers(world)[city.id]!;
  return { world, city, group, ledgers };
}

describe('居民消费贷与商品成交原子一致（验收问题 3）', () => {
  it('本月已有消费贷时，第二笔被拒后不得产生任何虚假信用消费成交', () => {
    const { world, city, group, ledgers } = marketSetup();
    setGroupDeposits(world, group, 1_000);
    // 本月第一笔消费贷：放款后现金被花掉（模拟“本月已有一笔”）。
    const first = borrowForConsumption(world, group, CONFIG, 100, world.time.tick);
    expect(first.ok, first.error).toBe(true);
    group.cash = 0;
    const loanDrawnBefore = group.lastMonth.loanDrawn ?? 0;
    expect(loanDrawnBefore).toBeGreaterThan(0);

    const before = captureSaleState(world, city, ledgers);
    const result = runConsumerMarket(world, city, ledgers, CONFIG);
    const entry = result.byGroup?.[group.id];
    expect(entry).toBeDefined();
    // 现金预算为 0 且本月笔数已用尽：不得成交、不得放第二笔贷款。
    expect(entry!.budget).toBe(0);
    expect(entry!.spend).toBe(0);
    expect(entry!.loanFinanced ?? 0).toBe(0);
    expect(group.cash).toBe(0);
    expect(world.householdFinance?.loans ?? []).toHaveLength(1);
    // 本月已放款额不变：没有新增第二笔贷款。
    expect(group.lastMonth.loanDrawn ?? 0).toBe(loanDrawnBefore);
    // 卖方库存/收入/台账完全不变：不允许“成交已发生、贷款却失败”的半成品。
    expect(captureSaleState(world, city, ledgers)).toEqual(before);
  });

  it('授信不足时只按真实可用额度放款，成交额与放款额一致，其余记资金缺口', () => {
    const { world, city, group, ledgers } = marketSetup();
    // 财产基准 = 存款 2000 → 可借额度 = 2000 × 0.5 = 1000。
    setGroupDeposits(world, group, 2_000);
    const limit = householdCreditLimit(world, group, CONFIG);
    expect(limit).toBeCloseTo(1_000, 2);

    const result = runConsumerMarket(world, city, ledgers, CONFIG);
    const entry = result.byGroup?.[group.id];
    expect(entry).toBeDefined();
    const financed = entry!.loanFinanced ?? 0;
    expect(financed).toBeGreaterThan(0);
    expect(financed).toBeLessThanOrEqual(limit + TOL);
    // 放款额不得超过最终实际成交额（现金预算为 0，成交额全部由贷款支持）。
    expect(entry!.spend).toBeCloseTo(financed, 2);
    expect(entry!.unmetFunding ?? 0).toBeGreaterThan(0);
    const loans = world.householdFinance?.loans ?? [];
    expect(loans).toHaveLength(1);
    expect(loans[0]!.principal).toBeCloseTo(financed, 2);
    expect(loans[0]!.principal).toBeLessThanOrEqual(limit + TOL);
    expect(group.cash).toBeCloseTo(0, 2);
  });

  it('价格变化时按卖家真实报价放款，放款额等于实际成交额与卖方新增收入', () => {
    const { world, city, group, ledgers } = marketSetup();
    setGroupDeposits(world, group, 2_000);
    // 卖家价格系数 1.5：真实单价高于城市市场参考价，放款必须以真实成交额为准。
    for (const company of world.companies) {
      if (company.cityId === city.id) company.priceFactor = 1.5;
    }
    const revenueBefore = world.companies
      .filter((company) => company.cityId === city.id)
      .reduce((total, company) => total + company.lastMonth.revenue, 0);

    const result = runConsumerMarket(world, city, ledgers, CONFIG);
    const entry = result.byGroup?.[group.id];
    expect(entry).toBeDefined();
    const financed = entry!.loanFinanced ?? 0;
    expect(financed).toBeGreaterThan(0);
    expect(entry!.spend).toBeCloseTo(financed, 2);
    const loans = world.householdFinance?.loans ?? [];
    expect(loans).toHaveLength(1);
    expect(loans[0]!.principal).toBeCloseTo(financed, 2);
    const revenueAfter = world.companies
      .filter((company) => company.cityId === city.id)
      .reduce((total, company) => total + company.lastMonth.revenue, 0);
    // v0.8：居民消费含税标价，卖方按 95% 净额入账（税 5% 归消费城市财政）。
    expect(revenueAfter - revenueBefore).toBeCloseTo(
      round2(financed * (1 - CONFIG.tax.consumptionTaxRate)),
      2,
    );
  });

  it('实际成交额低于单笔最低贷款额时不得放款、不得成交', () => {
    const { world, city, group, ledgers } = marketSetup();
    setGroupDeposits(world, group, 2_000);
    // 只留 1 单位食品库存（约 52 信用点，低于最低贷款额 100）。
    for (const company of world.companies) {
      if (company.cityId !== city.id) continue;
      for (const goodId of CONSUMER_GOODS) company.inventory[goodId] = 0;
    }
    const seller = world.companies.find(
      (company) => company.cityId === city.id && 'food' in company.inventory,
    );
    expect(seller).toBeDefined();
    seller!.inventory.food = 1;

    const before = captureSaleState(world, city, ledgers);
    const result = runConsumerMarket(world, city, ledgers, CONFIG);
    const entry = result.byGroup?.[group.id];
    expect(entry).toBeDefined();
    expect(entry!.spend).toBe(0);
    expect(entry!.loanFinanced ?? 0).toBe(0);
    expect(world.householdFinance?.loans ?? []).toHaveLength(0);
    expect(group.cash).toBe(0);
    // 未成交则不扣库存、不增卖方收入（一手交钱一手交货）。
    expect(captureSaleState(world, city, ledgers)).toEqual(before);
    expect(entry!.unmet.food ?? 0).toBeGreaterThan(0);
  });

  it('本地无消费品供给时不放贷、不成交，卖方与台账保持不变', () => {
    const { world, city, group, ledgers } = marketSetup();
    setGroupDeposits(world, group, 2_000);
    for (const company of world.companies) {
      if (company.cityId !== city.id) continue;
      for (const goodId of CONSUMER_GOODS) company.inventory[goodId] = 0;
    }
    const before = captureSaleState(world, city, ledgers);
    const result = runConsumerMarket(world, city, ledgers, CONFIG);
    const entry = result.byGroup?.[group.id];
    expect(entry).toBeDefined();
    expect(entry!.spend).toBe(0);
    expect(entry!.loanFinanced ?? 0).toBe(0);
    expect(world.householdFinance?.loans ?? []).toHaveLength(0);
    expect(captureSaleState(world, city, ledgers)).toEqual(before);
  });

  it('存读档往返后贷款、成交与现金口径保持一致', () => {
    // 不破坏初始财富结构（股份守恒等不变量）：只把目标群体的现金预算清零，使成交由贷款支持。
    const world = newWorld();
    const city = cityAt(world);
    const group = groupOf(world, city, 'production');
    group.cash = 0;
    group.lastMonth.income = 0;
    group.lastMonth.consumption = 0;
    group.lastMonth.netCashChange = 0;
    group.lastMonth.savingsContribution = 0;
    group.lastMonth.loanFinancedConsumption = 0;
    const ledgers = createWorldLedgers(world)[city.id]!;

    const result = runConsumerMarket(world, city, ledgers, CONFIG);
    const financed = result.byGroup?.[group.id]?.loanFinanced ?? 0;
    expect(financed).toBeGreaterThan(0);
    // 与完整 tick 的月末结算一致：先结算本城市场，再存档（期末库存不变量才成立）。
    finalizeMarkets(world, { [city.id]: ledgers }, CONFIG);

    const loanCount = (world.householdFinance?.loans ?? []).length;
    expect(loanCount).toBeGreaterThan(0);
    const text = serializeSave(world, '2026-11-03T00:00:00.000Z');
    const parsed = parseSave(text);
    expect(parsed.ok, parsed.error).toBe(true);
    const restored = parsed.world!;
    const restoredGroup = groupOf(restored, cityAt(restored), 'production');
    const restoredLoans = restored.householdFinance?.loans ?? [];
    expect(restoredLoans).toHaveLength(loanCount);
    const restoredLoan = restoredLoans.find((loan) => loan.groupId === group.id);
    expect(restoredLoan).toBeDefined();
    expect(restoredLoan!.principal).toBeCloseTo(financed, 2);
    expect(restoredGroup.lastMonth.loanFinancedConsumption ?? 0).toBeCloseTo(financed, 2);
    expect(restoredGroup.cash).toBeCloseTo(group.cash, 2);
  });

  it('同一 tick 重复执行不会重复放贷或重复成交（幂等）', () => {
    const { world, city, group, ledgers } = marketSetup();
    setGroupDeposits(world, group, 1_000);

    const first = runConsumerMarket(world, city, ledgers, CONFIG);
    const financed = first.byGroup?.[group.id]?.loanFinanced ?? 0;
    expect(financed).toBeGreaterThan(0);
    const loanCountAfterFirst = (world.householdFinance?.loans ?? []).length;
    const between = captureSaleState(world, city, ledgers);

    const second = runConsumerMarket(world, city, ledgers, CONFIG);
    const entry = second.byGroup?.[group.id];
    expect(entry).toBeDefined();
    expect(entry!.loanFinanced ?? 0).toBe(0);
    expect(entry!.spend).toBe(0);
    expect((world.householdFinance?.loans ?? []).length).toBe(loanCountAfterFirst);
    expect(captureSaleState(world, city, ledgers)).toEqual(between);
  });

  it('多群体独立判定：本月已放款的群体不再放款，其他群体仍可正常贷款消费', () => {
    const { world, city, group: production, ledgers } = marketSetup();
    const management = groupOf(world, city, 'management');
    setGroupDeposits(world, production, 1_000);
    setGroupDeposits(world, management, 1_000);
    // 管理群体本月已有一笔消费贷，且资金已花掉。
    const prior = borrowForConsumption(world, management, CONFIG, 100, world.time.tick);
    expect(prior.ok, prior.error).toBe(true);
    management.cash = 0;

    const result = runConsumerMarket(world, city, ledgers, CONFIG);
    const productionEntry = result.byGroup?.[production.id];
    const managementEntry = result.byGroup?.[management.id];
    expect(productionEntry).toBeDefined();
    expect(managementEntry).toBeDefined();
    expect(productionEntry!.loanFinanced ?? 0).toBeGreaterThan(0);
    expect(managementEntry!.loanFinanced ?? 0).toBe(0);
    expect(managementEntry!.spend).toBe(0);

    const loans = world.householdFinance?.loans ?? [];
    expect(loans).toHaveLength(2);
    const managementLoans = loans.filter((loan) => loan.groupId === management.id);
    expect(managementLoans).toHaveLength(1);
    expect(managementLoans[0]!.principal).toBeCloseTo(100, 2);
    expect(managementLoans[0]!.principal).toBe(prior.loan!.principal);
  });

  it('现金预算与贷款共同支撑成交时，账目闭合：支出 = 现金 + 放款', () => {
    const { world, city, group, ledgers } = marketSetup();
    setGroupDeposits(world, group, 1_000);
    // 手头现金 3,000、上月收入 0：现金预算 = min(3000, 0.05×3000)=150，其余由贷款补足。
    group.cash = 3_000;
    const cashStart = group.cash;

    const result = runConsumerMarket(world, city, ledgers, CONFIG);
    const entry = result.byGroup?.[group.id];
    expect(entry).toBeDefined();
    const financed = entry!.loanFinanced ?? 0;
    expect(financed).toBeGreaterThan(0);
    const cashSpent = round2(cashStart - group.cash);
    expect(entry!.spend).toBeCloseTo(round2(cashSpent + financed), 2);
    const loan = (world.householdFinance?.loans ?? [])[0];
    expect(loan).toBeDefined();
    expect(loan!.principal).toBeCloseTo(financed, 2);
  });
});
