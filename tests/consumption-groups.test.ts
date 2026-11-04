// 居民消费按群体独立预算结算（验收问题5）测试。
//
// 覆盖：
// - 现金为 0 的群体不消费，且不能动用其他群体的现金/预算；
// - 群体预算 = min(上月收入 × 消费倾向, 群体现金)，支出不超过该上限；
// - 本地缺货且无法跨城时“想买但买不到”：不扣款、未满足需求被记录；
// - 跨城交易的容量差额退款按 householdGroupId 归属原购买群体（旧数据按人口兜底）；
// - 固定种子下逐群体结算结果可复现。
//
// 说明：只写测试，不改产品代码；金额断言统一留浮点容差。

import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation/core/simulation';
import { DEMO_CONFIG } from '../src/data/config';
import type { DemoConfig } from '../src/data/config';
import type {
  City,
  HouseholdGroup,
  OccupationClass,
  WorldState,
} from '../src/simulation/contracts/types';
import { GOODS } from '../src/data/demo-data';
import { round2 } from '../src/simulation/core/math';
import { deepClone } from '../src/simulation/core/save';
import { createWorldLedgers } from '../src/simulation/markets/markets';
import { executeIntercityPurchase } from '../src/simulation/markets/intercity';
import { runConsumerMarket } from '../src/simulation/markets/consumer';
import { depositAccountFor } from '../src/simulation/banking/banking';
import { householdGroupsOfCity } from '../src/simulation/population/household-groups';
import { settleTransportMonth } from '../src/simulation/transport/settlement';
import { settleGovernment } from '../src/simulation/government/fiscal';
import type { FinanceResult } from '../src/simulation/finance/finance';

const CONSUMER_GOODS = GOODS.filter((good) => good.category === 'consumer');
const AMOUNT_TOLERANCE = 0.05;

function sumOf<T>(items: T[], pick: (item: T) => number): number {
  return items.reduce((total, item) => total + pick(item), 0);
}

function cityOf(world: WorldState, cityId: string): City {
  const city = world.cities.find((entry) => entry.id === cityId);
  if (!city) throw new Error(`城市不存在：${cityId}`);
  return city;
}

function groupOf(
  world: WorldState,
  cityId: string,
  occupation: OccupationClass,
): HouseholdGroup {
  const group = householdGroupsOfCity(world, cityId).find(
    (entry) => entry.occupation === occupation,
  );
  if (!group) throw new Error(`群体不存在：${cityId}/${occupation}`);
  return group;
}

/** 把所有群体现金、收入与银行存款清零，便于单独观察被测群体。 */
function clearHouseholdEconomy(world: WorldState, cityId: string): void {
  for (const group of householdGroupsOfCity(world, cityId)) {
    group.cash = 0;
    group.lastMonth.income = 0;
    group.lastMonth.depositWithdrawn = 0;
    // v0.9 T1：存款可提取补足基本消费；本文件验证逐群体现金预算，故一并清零存款。
    const account = depositAccountFor(world, { kind: 'household', id: group.id });
    if (account) account.balance = 0;
  }
}

/** 清空所有城市的谷物库存后再给指定企业补货，保证跨城交易的卖方唯一。 */
function isolateGrainSeller(world: WorldState, sellerCompanyId: string): void {
  for (const company of world.companies) company.inventory.grain = 0;
  const seller = world.companies.find((company) => company.id === sellerCompanyId);
  if (!seller) throw new Error(`企业不存在：${sellerCompanyId}`);
  seller.inventory.grain = 1_000;
  seller.cash = 0;
}

/** 把绿原—蓝港之间的道路/铁路容量清零，制造容量不足退款。 */
function zeroCorridorCapacity(world: WorldState): void {
  for (const link of world.transport.links) {
    if (link.mode !== 'road' && link.mode !== 'rail') continue;
    const matches =
      (link.fromCityId === 'greenfield' && link.toCityId === 'lanport') ||
      (link.fromCityId === 'lanport' && link.toCityId === 'greenfield');
    if (matches) link.level = 0;
  }
}

function emptyFinance(): FinanceResult {
  return {
    investorDividendsByCity: {},
    investorDistributionByCity: {},
    cityDividendsByCity: {},
    dividendsByCity: {},
    playerDividends: 0,
    playerDividendsByCompany: {},
    corporateTaxByCity: {},
    privateWagesByCity: {},
    wageArrears: 0,
  };
}

describe('居民消费：逐群体独立预算', () => {
  it('现金为 0 的群体不消费，且不动用其他群体的资金；充足群体独立记账', () => {
    const world = Simulation.create().state;
    const city = cityOf(world, 'lanport');
    const groups = householdGroupsOfCity(world, city.id);
    clearHouseholdEconomy(world, city.id);
    const rich = groupOf(world, city.id, 'production');
    rich.cash = 50_000;
    rich.lastMonth.income = 100_000;
    const cashBefore = new Map(groups.map((group) => [group.id, group.cash]));

    const ledgers = createWorldLedgers(world);
    const result = runConsumerMarket(world, city, ledgers.lanport!, DEMO_CONFIG);
    const byGroup = result.byGroup!;

    expect(result.budget).toBeGreaterThan(0);
    expect(result.spend).toBeGreaterThan(0);
    expect(Object.keys(byGroup)).toHaveLength(groups.length);

    for (const group of groups) {
      const entry = byGroup[group.id]!;
      expect(entry, `缺少群体结果：${group.id}`).toBeDefined();
      // v1.5 #38：消费贷是真实债务，现金变化 = 期初现金 + 本月新借 - 本月总消费支出。
      const cashSpent = round2(entry.spend - (entry.loanFinanced ?? 0));
      expect(group.cash).toBeCloseTo(
        round2((cashBefore.get(group.id) ?? 0) + (group.lastMonth.loanDrawn ?? 0) - entry.spend),
        2,
      );
      if (group.id === rich.id) continue;
      // 现金为 0 的群体没有现金预算，只能靠自有授信消费，不能挪用其他群体的现金。
      expect(entry.budget).toBe(0);
      expect(cashSpent).toBeCloseTo(0, 2);
      expect(entry.spend).toBeCloseTo(entry.loanFinanced ?? 0, 2);
    }

    const richEntry = byGroup[rich.id]!;
    expect(richEntry.budget).toBeCloseTo(
      Math.min(50_000, 0.8 * rich.lastMonth.income + 0.05 * 50_000),
      2,
    );
    expect(richEntry.spend).toBeGreaterThan(0);
    // 现金自付不超过现金预算；超出部分只能来自消费贷（真实债务，不计收入）。
    const richCashSpent = round2(richEntry.spend - (richEntry.loanFinanced ?? 0));
    expect(richCashSpent).toBeLessThanOrEqual(richEntry.budget + AMOUNT_TOLERANCE);
    expect(rich.cash).toBeCloseTo(
      round2(50_000 + (rich.lastMonth.loanDrawn ?? 0) - richEntry.spend),
      2,
    );

    // 全城汇总 = 各群体之和；现金总减少额 = 全城消费支出。
    expect(result.budget).toBeCloseTo(
      sumOf(Object.values(byGroup), (entry) => entry.budget),
      2,
    );
    expect(result.spend).toBeCloseTo(
      sumOf(Object.values(byGroup), (entry) => entry.spend),
      2,
    );
    const totalCashDrop = sumOf(
      groups,
      (group) => (cashBefore.get(group.id) ?? 0) - group.cash,
    );
    const totalLoanDrawn = sumOf(groups, (group) => group.lastMonth.loanDrawn ?? 0);
    expect(round2(totalCashDrop + totalLoanDrawn)).toBeCloseTo(result.spend, 1);
  });

  it('群体现金低于收入×消费倾向时，预算与支出以该群体现金为上限', () => {
    const world = Simulation.create().state;
    const city = cityOf(world, 'lanport');
    const groups = householdGroupsOfCity(world, city.id);
    clearHouseholdEconomy(world, city.id);
    const limited = groupOf(world, city.id, 'production');
    limited.cash = 1_200;
    limited.lastMonth.income = 100_000;

    const result = runConsumerMarket(
      world,
      city,
      createWorldLedgers(world).lanport!,
      DEMO_CONFIG,
    );
    const entry = result.byGroup![limited.id]!;

    expect(entry.budget).toBeCloseTo(1_200, 2);
    expect(entry.spend).toBeGreaterThan(0);
    expect(entry.spend).toBeGreaterThan(entry.budget);
    // 超出 1200 现金预算的部分只能来自消费贷（真实债务，不计收入）。
    expect(entry.loanFinanced ?? 0).toBeGreaterThan(0);
    expect(limited.cash).toBeGreaterThanOrEqual(0);
    expect(limited.cash).toBeCloseTo(
      round2(1_200 + (limited.lastMonth.loanDrawn ?? 0) - entry.spend),
      2,
    );
    for (const group of groups) {
      if (group.id === limited.id) continue;
      // 其他群体没有现金预算；若发生消费只能是它们自己的消费贷，不动用他人现金。
      const other = result.byGroup![group.id]!;
      expect(round2(other.spend - (other.loanFinanced ?? 0))).toBeCloseTo(0, 2);
    }
  });

  it('本地缺货且无法跨城时：不扣款，未满足需求被记录', () => {
    // DemoConfig 由 `as const` 派生，enabled 为字面量 true；测试里需要关闭跨城补货，
    // 因此构造等价的运行期配置后再断言为 DemoConfig（仅测试用，不改产品配置）。
    const config = {
      ...structuredClone(DEMO_CONFIG),
      intercity: { ...DEMO_CONFIG.intercity, enabled: false },
    } as unknown as DemoConfig;
    const world = Simulation.create(config).state;
    const city = cityOf(world, 'lanport');
    clearHouseholdEconomy(world, city.id);
    const buyer = groupOf(world, city.id, 'production');
    buyer.cash = 20_000;
    buyer.lastMonth.income = 50_000;
    // 城市内所有消费品的本地库存清零，且禁止跨城补货。
    for (const company of world.companies) {
      if (company.cityId !== city.id) continue;
      for (const good of CONSUMER_GOODS) company.inventory[good.id] = 0;
    }

    const ledgers = createWorldLedgers(world);
    const result = runConsumerMarket(world, city, ledgers.lanport!, config);
    const entry = result.byGroup![buyer.id]!;

    expect(result.spend).toBe(0);
    expect(entry.spend).toBe(0);
    expect(entry.budget).toBeCloseTo(
      Math.min(50_000 * config.consumer.propensity, 20_000),
      2,
    );
    for (const good of CONSUMER_GOODS) {
      expect(result.bought[good.id]).toBe(0);
      expect(ledgers.lanport![good.id]!.spend).toBe(0);
    }
    expect(entry.unmet.food).toBeGreaterThan(0);
    expect(sumOf(CONSUMER_GOODS, (good) => entry.unmet[good.id] ?? 0)).toBeGreaterThan(0);
    expect(buyer.cash).toBeCloseTo(20_000, 2);
  });
});

describe('居民跨城退款：按购买群体归属', () => {
  it('带 householdGroupId 的成交，退款按原购买群体归属并计入该群体下期收入', () => {
    const world = Simulation.create().state;
    const city = cityOf(world, 'lanport');
    const buyerGroup = groupOf(world, city.id, 'production');
    isolateGrainSeller(world, 'gf-grain');
    zeroCorridorCapacity(world);

    const ledgers = createWorldLedgers(world);
    const purchase = executeIntercityPurchase(
      world,
      city,
      ledgers.lanport!,
      'grain',
      100,
      10_160,
      { consumer: true, householdGroupId: buyerGroup.id },
      DEMO_CONFIG,
    );
    expect(purchase.qty).toBeGreaterThan(0);

    const refunds = settleTransportMonth(world, DEMO_CONFIG, [], ledgers);
    const trade = world.transport.lastMonth.trades[0]!;
    expect(trade.buyerRefund).toBeGreaterThan(0);
    const allocation = refunds.lanport!;
    expect(allocation).toBeDefined();
    expect(allocation.total).toBeCloseTo(trade.buyerRefund!, 2);
    expect(
      sumOf(Object.values(allocation.byGroup), (amount) => amount),
    ).toBeCloseTo(allocation.total, 2);
    expect(allocation.byGroup[buyerGroup.id]).toBeCloseTo(trade.buyerRefund!, 2);

    // 财政结算：退款只增加原购买群体的现金，不被其他群体平分。
    const control = deepClone(world);
    const finance = emptyFinance();
    settleGovernment(world, finance, DEMO_CONFIG, [], refunds);
    settleGovernment(control, finance, DEMO_CONFIG, []);
    const controlCity = cityOf(control, city.id);
    expect(
      city.householdIncomeLastMonth - controlCity.householdIncomeLastMonth,
    ).toBeCloseTo(trade.buyerRefund!, 2);
    for (const group of householdGroupsOfCity(world, city.id)) {
      const controlGroup = groupOf(control, city.id, group.occupation);
      const delta = round2(group.cash - controlGroup.cash);
      if (group.id === buyerGroup.id) {
        expect(delta).toBeCloseTo(trade.buyerRefund!, 2);
      } else {
        expect(delta).toBe(0);
      }
    }
  });

  it('没有群体标记的历史退款按人口比例兜底分摊，合计仍等于城市退款总额', () => {
    const world = Simulation.create().state;
    const city = cityOf(world, 'lanport');
    isolateGrainSeller(world, 'gf-grain');
    zeroCorridorCapacity(world);

    const ledgers = createWorldLedgers(world);
    const purchase = executeIntercityPurchase(
      world,
      city,
      ledgers.lanport!,
      'grain',
      100,
      10_160,
      { consumer: true },
      DEMO_CONFIG,
    );
    expect(purchase.qty).toBeGreaterThan(0);

    const refunds = settleTransportMonth(world, DEMO_CONFIG, [], ledgers);
    const trade = world.transport.lastMonth.trades[0]!;
    const allocation = refunds.lanport!;
    expect(allocation.total).toBeCloseTo(trade.buyerRefund!, 2);
    expect(Object.keys(allocation.byGroup).length).toBeGreaterThan(0);
    expect(
      sumOf(Object.values(allocation.byGroup), (amount) => amount),
    ).toBeCloseTo(allocation.total, 2);

    const groups = householdGroupsOfCity(world, city.id);
    const totalPeople = sumOf(groups, (group) => group.people);
    for (const group of groups) {
      if (group.people <= 0) continue;
      const expected = (allocation.total * group.people) / totalPeople;
      expect(Math.abs((allocation.byGroup[group.id] ?? 0) - expected)).toBeLessThan(0.02);
    }
  });
});

describe('居民消费：确定性', () => {
  it('固定种子下逐群体消费结果与现金分布可复现', () => {
    const build = (): Simulation => {
      const sim = Simulation.create();
      for (const city of sim.state.cities) {
        householdGroupsOfCity(sim.state, city.id).forEach((group, index) => {
          group.cash = 5_000 + index * 1_000;
          group.lastMonth.income = 20_000 + index * 2_000;
        });
      }
      return sim;
    };

    const first = build();
    const second = build();
    const firstCity = cityOf(first.state, 'lanport');
    const secondCity = cityOf(second.state, 'lanport');
    const firstResult = runConsumerMarket(
      first.state,
      firstCity,
      createWorldLedgers(first.state).lanport!,
      DEMO_CONFIG,
    );
    const secondResult = runConsumerMarket(
      second.state,
      secondCity,
      createWorldLedgers(second.state).lanport!,
      DEMO_CONFIG,
    );

    expect(JSON.stringify(firstResult)).toBe(JSON.stringify(secondResult));
    const firstCash = householdGroupsOfCity(first.state, 'lanport').map(
      (group) => [group.id, group.cash],
    );
    const secondCash = householdGroupsOfCity(second.state, 'lanport').map(
      (group) => [group.id, group.cash],
    );
    expect(firstCash).toEqual(secondCash);
  });
});
