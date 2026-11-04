// v0.9 验收问题六：居民消费公平性 / 两阶段本地优先。
//
// 背景：居民消费曾按城市 id 顺序逐城执行（greenfield → ironvale → lanport），
// 青原/铁谷居民会先跨城买走岚港的食品（卖方记 exported），等岚港本地居民消费时本地库存已为 0，
// 导致“本地居民挨饿、缺货=有效需求”。本测试基于真实 Simulation 世界与真实市场核对：
// - 阶段 A：所有城市先在本城消费，本地居民优先；
// - 阶段 B：本地缺口再跨城补货，按真实 offeredStock 重新报价，部分成交、剩余如实记 unmet；
// - 跨城购买同样遵守“现金 → 存款提取 → 消费贷”的支付顺序与原子性。

import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation/core/simulation';
import { DEMO_CONFIG } from '../src/data/config';
import type { DemoConfig } from '../src/data/config';
import { GOODS } from '../src/data/demo-data';
import { createWorldLedgers, finalizeMarkets } from '../src/simulation/markets/markets';
import { runConsumerMarkets } from '../src/simulation/markets/consumer';
import { depositAccountFor, ensureDepositAccount } from '../src/simulation/banking/banking';
import { householdGroupsOfCity } from '../src/simulation/population/household-groups';
import { parseSave, serializeSave } from '../src/simulation/core/save';
import { round2 } from '../src/simulation/core/math';
import type { HouseholdGroup, WorldState } from '../src/simulation/contracts/types';

const CONFIG: DemoConfig = DEMO_CONFIG;
const NO_LOAN: DemoConfig = {
  ...DEMO_CONFIG,
  households: {
    ...DEMO_CONFIG.households,
    householdCredit: {
      ...DEMO_CONFIG.households.householdCredit,
      creditLimitRate: 0,
    },
  },
} as unknown as DemoConfig;
const CONSUMER_GOODS = GOODS.filter((good) => good.category === 'consumer');
const TOL = 0.05;
const LANPORT_DEMAND_FOOD = 100 * 26; // 100 人 × 人均每月 26 单位

interface FairnessFixture {
  world: WorldState;
  ledgers: ReturnType<typeof createWorldLedgers>;
  lanportGroup: HouseholdGroup;
  greenfieldGroup: HouseholdGroup;
  setCash: (group: HouseholdGroup, cash: number) => void;
  setDeposit: (group: HouseholdGroup, balance: number) => void;
  stockFood: (cityId: string, quantity: number) => void;
  exportedFood: (fromCityId: string, toCityId: string) => number;
}

/**
 * 构造两城对照世界：岚港（lanport）与青原（greenfield）各只保留 1 个目标群体（100 人）。
 * 其余群体 people=0、无现金/收入/存款；消费品库存清零，由用例按城市设置；跨城保持开启。
 */
function buildFixture(): FairnessFixture {
  const world = Simulation.create().state;
  for (const city of world.cities) {
    for (const group of householdGroupsOfCity(world, city.id)) {
      group.people = 0;
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
    }
  }
  for (const investor of world.investors) {
    investor.cash = 0;
  }
  // 清零投资实体持仓，使消费贷额度只取决于居民现金+存款，便于对账（本文件不做存档校验）。
  for (const holding of world.securities.holdings) {
    if (holding.holder.type === 'investorGroup') holding.shares = 0;
  }
  for (const company of world.companies) {
    company.priceFactor = 1;
    for (const good of CONSUMER_GOODS) company.inventory[good.id] = 0;
  }
  for (const city of world.cities) {
    for (const good of CONSUMER_GOODS) {
      const state = city.market[good.id];
      if (state) state.price = good.basePrice;
    }
  }

  const lanportGroup = householdGroupsOfCity(world, 'lanport').find(
    (group) => group.occupation === 'production',
  )!;
  const greenfieldGroup = householdGroupsOfCity(world, 'greenfield').find(
    (group) => group.occupation === 'production',
  )!;
  lanportGroup.people = 100;
  greenfieldGroup.people = 100;
  for (const group of [lanportGroup, greenfieldGroup]) {
    ensureDepositAccount(world, { kind: 'household', id: group.id }, CONFIG, world.time.tick);
  }

  return {
    world,
    ledgers: createWorldLedgers(world),
    lanportGroup,
    greenfieldGroup,
    setCash: (group, cash) => {
      group.cash = round2(cash);
    },
    setDeposit: (group, balance) => {
      const account = depositAccountFor(world, { kind: 'household', id: group.id });
      if (account) account.balance = round2(balance);
    },
    stockFood: (cityId, quantity) => {
      const company = world.companies.find((entry) => entry.cityId === cityId)!;
      company.inventory.food = round2(quantity);
    },
    exportedFood: (fromCityId, toCityId) =>
      round2(
        world.transport.pendingSales
          .filter(
            (sale) =>
              sale.path === 'householdPurchase' &&
              sale.fromCityId === fromCityId &&
              sale.toCityId === toCityId &&
              sale.good === 'food',
          )
          .reduce((total, sale) => total + sale.qty, 0),
      ),
  };
}

describe('v0.9 验收问题六：居民消费本地优先 / 跨城补缺口', () => {
  it('两个城市都缺食品时，岚港本地居民先足额买到，剩余库存才出口给青原', () => {
    const fixture = buildFixture();
    fixture.setCash(fixture.lanportGroup, 10_000_000);
    fixture.setCash(fixture.greenfieldGroup, 10_000_000);
    // 岚港库存 = 本地需求 + 400 单位剩余；青原本地无食品。
    fixture.stockFood('lanport', LANPORT_DEMAND_FOOD + 400);

    const results = runConsumerMarkets(fixture.world, fixture.ledgers, CONFIG);
    const lanport = results.lanport!.byGroup![fixture.lanportGroup.id]!;
    const greenfield = results.greenfield!.byGroup![fixture.greenfieldGroup.id]!;

    // 本地优先：岚港本地居民先按现金预算足额买到，不因外地抢购而挨饿。
    expect(lanport.bought.food).toBeCloseTo(LANPORT_DEMAND_FOOD, 1);
    expect(lanport.unmet.food ?? 0).toBeCloseTo(0, 1);
    expect(fixture.ledgers.lanport!.food!.sold).toBeCloseTo(LANPORT_DEMAND_FOOD, 1);

    // 剩余 400 单位才通过阶段 B 出口给青原，青原的其余缺口如实记 unmet。
    const exported = fixture.exportedFood('lanport', 'greenfield');
    expect(exported).toBeGreaterThan(0);
    expect(exported).toBeLessThanOrEqual(400 + TOL);
    expect(greenfield.bought.food).toBeCloseTo(exported, 1);
    expect(greenfield.unmet.food ?? 0).toBeGreaterThan(400);
    // 青原跨城购买的账目：进口量记入本市市场台账。
    expect(fixture.ledgers.greenfield!.food!.intercityImported).toBeCloseTo(exported, 1);
  });

  it('本地供给不足但外地有货时，阶段 B 跨城购买并遵守现金→存款→贷款顺序', () => {
    const fixture = buildFixture();
    // 岚港本地无供给，青原食品充足。
    fixture.stockFood('lanport', 0);
    fixture.stockFood('greenfield', 100_000);
    // 岚港目标群体：无现金、无收入，只有 10,000 存款。
    fixture.setCash(fixture.lanportGroup, 0);
    fixture.setDeposit(fixture.lanportGroup, 10_000);

    const results = runConsumerMarkets(fixture.world, fixture.ledgers, CONFIG);
    const lanport = results.lanport!.byGroup![fixture.lanportGroup.id]!;
    const withdrawn = fixture.lanportGroup.lastMonth.depositWithdrawn ?? 0;
    const loans = fixture.world.householdFinance!.loans.filter(
      (loan) => loan.groupId === fixture.lanportGroup.id,
    );

    expect(fixture.exportedFood('greenfield', 'lanport')).toBeGreaterThan(0);
    expect(lanport.bought.food ?? 0).toBeGreaterThan(0);
    // 支付顺序：现金（0）→ 存款提取（≤5%）→ 消费贷补剩余资金缺口。
    expect(lanport.cashPaid ?? 0).toBeCloseTo(0, 2);
    expect(withdrawn).toBeGreaterThan(0);
    expect(withdrawn).toBeLessThanOrEqual(round2(10_000 * 0.05) + TOL);
    expect(lanport.loanFinanced ?? 0).toBeGreaterThan(0);
    expect(lanport.spend).toBeCloseTo(
      round2((lanport.cashPaid ?? 0) + withdrawn + (lanport.loanFinanced ?? 0)),
      2,
    );
    expect(loans).toHaveLength(1);
    expect(loans[0]!.principal).toBeCloseTo(lanport.loanFinanced ?? 0, 2);
    // 存款减少额 = 提取额；贷款用于支付后不留现金零头（或仅舍入零头）。
    const account = depositAccountFor(fixture.world, {
      kind: 'household',
      id: fixture.lanportGroup.id,
    });
    expect(account!.balance).toBeCloseTo(round2(10_000 - withdrawn), 2);
    expect(Math.abs(fixture.lanportGroup.cash)).toBeLessThanOrEqual(TOL);
  });

  it('阶段 B 现金不足时只部分成交，剩余缺口如实记 unmet（不伪造供给、不透支）', () => {
    const fixture = buildFixture();
    fixture.stockFood('lanport', 0);
    fixture.stockFood('greenfield', 100_000);
    // 无存款、无授信，只有 60 现金：预算=min(60, 5%×60)=3，B 阶段最多花掉手头 60。
    fixture.setCash(fixture.lanportGroup, 60);

    const results = runConsumerMarkets(fixture.world, fixture.ledgers, NO_LOAN);
    const lanport = results.lanport!.byGroup![fixture.lanportGroup.id]!;
    const boughtFood = lanport.bought.food ?? 0;
    const imported = fixture.exportedFood('greenfield', 'lanport');

    expect(boughtFood).toBeGreaterThan(0);
    expect(boughtFood).toBeLessThan(LANPORT_DEMAND_FOOD);
    expect(imported).toBeCloseTo(boughtFood, 1);
    // 现金几乎全部用于成交，但绝不超过现金；不提存款、不放贷。
    // （跨城报价按 0.01 价格网格部分成交，可能留下不到 1 信用点的现金零头。）
    expect(lanport.spend).toBeGreaterThan(55);
    expect(lanport.spend).toBeLessThanOrEqual(60 + TOL);
    expect(lanport.cashPaid ?? 0).toBeLessThanOrEqual(60 + TOL);
    expect(lanport.spend).toBeCloseTo(lanport.cashPaid ?? 0, 2);
    expect(lanport.depositWithdrawn ?? 0).toBeCloseTo(0, 2);
    expect(lanport.loanFinanced ?? 0).toBeCloseTo(0, 2);
    expect(fixture.world.householdFinance!.loans).toHaveLength(0);
    expect(Math.abs(fixture.lanportGroup.cash)).toBeLessThanOrEqual(1);
    // 未能满足的部分如实留在 unmet，不得伪造成交。
    expect(lanport.unmet.food ?? 0).toBeGreaterThan(0);
    expect(
      round2(boughtFood + (lanport.unmet.food ?? 0)),
    ).toBeLessThanOrEqual(LANPORT_DEMAND_FOOD + TOL);
  });

  it('两阶段跨城消费后存读档通过，跨城待结算记录与居民账目保持一致', () => {
    const world = Simulation.create().state;
    const lanportGroup = householdGroupsOfCity(world, 'lanport').find(
      (group) => group.occupation === 'production',
    )!;
    lanportGroup.cash = 2_000_000;
    for (const company of world.companies) {
      if (company.cityId === 'lanport') company.inventory.food = 0;
      if (company.cityId === 'greenfield') company.inventory.food = 5_000_000;
    }
    const ledgers = createWorldLedgers(world);
    const results = runConsumerMarkets(world, ledgers, CONFIG);
    const entry = results.lanport!.byGroup![lanportGroup.id]!;
    expect(entry.bought.food ?? 0).toBeGreaterThan(0);
    expect(world.transport.pendingSales.length).toBeGreaterThan(0);

    // 存档校验需要市场期末库存与真实成交一致：先结算市场再保存。
    finalizeMarkets(world, ledgers, CONFIG);
    const text = serializeSave(world, '2026-11-04T00:00:00.000Z');
    const parsed = parseSave(text);
    expect(parsed.ok, parsed.error).toBe(true);
    const restored = parsed.world!;
    const restoredGroup = restored.households.groups.find((group) => group.id === lanportGroup.id)!;
    expect(restoredGroup.cash).toBeCloseTo(lanportGroup.cash, 2);
    expect(restoredGroup.lastMonth.consumption).toBeCloseTo(
      lanportGroup.lastMonth.consumption,
      2,
    );
    expect(restored.transport.pendingSales).toHaveLength(world.transport.pendingSales.length);
    const restoredFood = restored.cities.find((city) => city.id === 'lanport')!.market.food!;
    const originalFood = world.cities.find((city) => city.id === 'lanport')!.market.food!;
    expect(restoredFood.sold).toBeCloseTo(originalFood.sold, 2);
    expect(restoredFood.intercityImported).toBeCloseTo(originalFood.intercityImported, 2);
  });
});
