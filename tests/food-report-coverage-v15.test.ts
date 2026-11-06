// v1.5 §3 食品成交与覆盖率口径回归测试（独立核对，不改 src/scripts）。
//
// 验收问题：青原第 72 月本地食品成交约 1,960,636 件、跨城进口约 2,362,300 件、
// 居民基本食品实际成交约 4,322,936 件、基本需要约 8,443,214 件；城市明细覆盖率约 51.2%，
// 但汇总只用本地成交显示约 23.2%。差异全部来自“跨城进口”被漏计。
//
// 权威口径（本文件锁定的定义）：
// - 居民实际成交（含进口）  residentSold = Σ 群体 lastMonth.basicSoldUnits（权威，一次成交只属于一个群体）
// - 本地账本成交            ledgerSold   = city.market['food'].sold（只含本城市场内的成交，
//                                          食品无企业投入需求，故 = 本地居民买本地；不含跨城出口）
// - 跨城进口                imported     = city.market['food'].intercityImported（只记在买方城市账本）
// - 跨城出口                exported     = Σ lastTick.tradeFlows(fromCity=本城, good=food).qty
// - 基本需要量              basicNeed    = Σ 群体 lastMonth.basicNeedUnits = 人口 × 人均月需要
// - 基本需要覆盖率          coverage     = residentSold / basicNeed
// - 有效需求满足率          satisfaction = residentSold / Σ lastMonth.basicEffectiveUnits（居民侧有效需求）
//
// 恒等式（本文件断言）：
//  E1 residentSold = ledgerSold + imported               （居民实际成交 = 本地 + 进口；进口只加一次）
//  E2 imported     = Σ tradeFlows(toCity=本城)            （买方账本进口 = 收货贸易流）
//  E3 exported     = Σ tradeFlows(fromCity=本城)；全局 Σimported = Σexported（每次跨城成交只有一条流）
//  E4 Σ居民成交     = Σ本地账本成交 + Σ进口               （明细与汇总一致）
//  E5 出口不计入卖方本地账本 sold，也不计入卖方居民成交（不得重复计数）
//
// 测试用真实 Simulation 世界与真实消费/市场撮合（runConsumerMarkets + finalizeMarkets），
// 只把人口/现金/库存收缩到可控范围：青原（买方）100 人、现金充足但本地食品只有 500 件；
// 岚港（卖方）居民为 0、食品库存 10,000 件，跨城开启 → 买方必须大量进口才能吃到基本需要。

import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation/core/simulation';
import { DEMO_CONFIG } from '../src/data/config';
import type { DemoConfig } from '../src/data/config';
import { GOODS } from '../src/data/demo-data';
import { createWorldLedgers, finalizeMarkets } from '../src/simulation/markets/markets';
import { runConsumerMarkets } from '../src/simulation/markets/consumer';
import { depositAccountFor, ensureDepositAccount } from '../src/simulation/banking/banking';
import { householdGroupsOfCity } from '../src/simulation/population/household-groups';
import { round2 } from '../src/simulation/core/math';
import type { HouseholdGroup, WorldState } from '../src/simulation/contracts/types';

// 关闭消费贷：让“进口额度”只受基本需要成本约束，便于手算；跨城补货保持开启。
const CONFIG: DemoConfig = {
  ...DEMO_CONFIG,
  households: {
    ...DEMO_CONFIG.households,
    householdCredit: { ...DEMO_CONFIG.households.householdCredit, creditLimitRate: 0 },
  },
} as unknown as DemoConfig;

const FOOD = GOODS.find((good) => good.id === 'food')!;
const CONSUMER_GOODS = GOODS.filter((good) => good.category === 'consumer');
const BUYER_CITY = 'greenfield'; // 青原
const SELLER_CITY = 'lanport'; // 岚港
const BUYER_PEOPLE = 100;
const BASIC_NEED = BUYER_PEOPLE * FOOD.perCapitaMonthlyNeed; // 2,600 件/月
const LOCAL_STOCK = 500;
const SELLER_STOCK = 10_000;
const TOL = 0.05;

interface FoodReportFixture {
  world: WorldState;
  buyerGroup: HouseholdGroup;
  sellerGroup: HouseholdGroup;
  /** 运行居民消费两阶段撮合并把账本定稿到 city.market（与真实 tick 的步骤 7→12 一致）。 */
  run: () => {
    ledgers: ReturnType<typeof createWorldLedgers>;
    results: ReturnType<typeof runConsumerMarkets>;
  };
}

/**
 * 构造“部分本地成交 + 大量跨城进口”的两城世界：
 * - 青原生产群体 100 人、手头现金 1,000,000，本地食品库存只有 500 件；
 * - 岚港居民人口清零、食品库存 10,000 件（只能通过跨城进口进入青原）；
 * - 其他城市/群体人口与现金清零、消费品库存清零、价格回到基准价、企业价格系数 1；
 * - 关闭消费贷，避免贷款改变“基本需要成本上限”。
 */
function buildFixture(): FoodReportFixture {
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
      group.lastMonth.basicNeedUnits = 0;
      group.lastMonth.basicSoldUnits = 0;
      group.lastMonth.basicEffectiveUnits = 0;
      group.lastMonth.basicNeedCoverage = 0;
      const account = depositAccountFor(world, { kind: 'household', id: group.id });
      if (account) account.balance = 0;
    }
  }
  for (const investor of world.investors) investor.cash = 0;
  for (const holding of world.securities.holdings) {
    if (holding.holder.type === 'investorGroup') holding.shares = 0;
  }
  for (const company of world.companies) {
    company.priceFactor = 1;
    for (const good of CONSUMER_GOODS) company.inventory[good.id] = 0;
  }
  for (const city of world.cities) {
    for (const good of CONSUMER_GOODS) {
      const market = city.market[good.id];
      if (market) market.price = good.basePrice;
    }
  }

  const buyerGroup = householdGroupsOfCity(world, BUYER_CITY).find(
    (group) => group.occupation === 'production',
  )!;
  const sellerGroup = householdGroupsOfCity(world, SELLER_CITY).find(
    (group) => group.occupation === 'production',
  )!;
  buyerGroup.people = BUYER_PEOPLE;
  buyerGroup.cash = 1_000_000;
  ensureDepositAccount(world, { kind: 'household', id: buyerGroup.id }, CONFIG, world.time.tick);

  const foodCompany = (cityId: string) =>
    world.companies.find(
      (company) => company.cityId === cityId && company.recipeOutput === 'food',
    )!;
  foodCompany(BUYER_CITY).inventory.food = LOCAL_STOCK;
  foodCompany(SELLER_CITY).inventory.food = SELLER_STOCK;

  const run = () => {
    const ledgers = createWorldLedgers(world);
    const results = runConsumerMarkets(world, ledgers, CONFIG);
    // 与真实 tick 的第 12 步一致：把当月台账定稿进 city.market（sold/intercityImported/unmetDemand）。
    finalizeMarkets(world, ledgers, CONFIG);
    return { ledgers, results };
  };

  return { world, buyerGroup, sellerGroup, run };
}

function cityGroups(world: WorldState, cityId: string): HouseholdGroup[] {
  return householdGroupsOfCity(world, cityId);
}

function sumStat(
  world: WorldState,
  cityId: string,
  pick: (group: HouseholdGroup) => number | undefined,
): number {
  return round2(
    cityGroups(world, cityId).reduce((total, group) => total + (pick(group) ?? 0), 0),
  );
}

function foodMarket(world: WorldState, cityId: string) {
  return world.cities.find((city) => city.id === cityId)!.market['food']!;
}

function foodFlows(world: WorldState) {
  return world.lastTick.tradeFlows.filter((flow) => flow.good === 'food');
}

function importsOf(world: WorldState, cityId: string): number {
  return round2(
    foodFlows(world)
      .filter((flow) => flow.toCityId === cityId)
      .reduce((total, flow) => total + flow.qty, 0),
  );
}

function exportsOf(world: WorldState, cityId: string): number {
  return round2(
    foodFlows(world)
      .filter((flow) => flow.fromCityId === cityId)
      .reduce((total, flow) => total + flow.qty, 0),
  );
}

describe('v1.5 §3 食品成交与覆盖率口径（本地 + 跨城进口）', () => {
  it('覆盖率与满足率按“居民实际成交（含进口）”计算，不能只用本地市场成交', () => {
    const fixture = buildFixture();
    const { results } = fixture.run();

    const market = foodMarket(fixture.world, BUYER_CITY);
    const stats = fixture.buyerGroup.lastMonth;
    const residentSold = round2(stats.basicSoldUnits ?? 0);
    const basicNeed = round2(stats.basicNeedUnits ?? 0);
    const basicEffective = round2(stats.basicEffectiveUnits ?? 0);

    // 场景成立：本地只买到 500 件，其余靠跨城进口（大量进口）。
    expect(market.sold).toBeCloseTo(LOCAL_STOCK, 2);
    expect(market.intercityImported).toBeGreaterThan(1_500);
    expect(importsOf(fixture.world, BUYER_CITY)).toBeCloseTo(
      market.intercityImported,
      2,
    );
    expect(exportsOf(fixture.world, SELLER_CITY)).toBeCloseTo(
      market.intercityImported,
      2,
    );

    // 基本需要量 = 人口 × 人均需要；有效需求（居民侧）同样按人计。
    expect(basicNeed).toBeCloseTo(BASIC_NEED, 2);
    expect(basicEffective).toBeCloseTo(BASIC_NEED, 2);

    // 权威：居民实际成交 = 群体落账（本地 + 进口），远大于本地成交。
    expect(residentSold).toBeCloseTo(LOCAL_STOCK + market.intercityImported, 2);
    expect(residentSold).toBeGreaterThan(LOCAL_STOCK * 3);

    // 基本需要覆盖率按居民实际成交；落账字段与公式一致（round4）。
    const coverage = residentSold / basicNeed;
    expect(stats.basicNeedCoverage).toBeCloseTo(coverage, 4);
    expect(coverage).toBeGreaterThan(0.9);

    // 有效需求满足率 = 居民实际成交 / 居民侧有效需求（与覆盖率同源，不是“本地成交/市场台账需求”）。
    const satisfaction = residentSold / basicEffective;
    expect(satisfaction).toBeCloseTo(coverage, 4);
    // 有效需求 ≤ 基本需要量（价格弹性可能压低基本需求），因此满足率 ≥ 覆盖率。
    expect(basicEffective).toBeLessThanOrEqual(basicNeed + TOL);
    expect(satisfaction).toBeGreaterThanOrEqual(coverage - 1e-9);

    // 反例：只用本地成交会把覆盖率压到 19.2%（≈ 500/2,600），与真实 96% 相差 70+ 个百分点。
    const localOnlyCoverage = market.sold / basicNeed;
    expect(localOnlyCoverage).toBeLessThan(0.2);
    expect(coverage - localOnlyCoverage).toBeGreaterThan(0.7);
    // 反例：旧“市场满足率 = 本地成交 / 市场消费需求”同样低估（市场台账需求是尝试量，不是居民有效需求）。
    const marketDemand = market.consumerDemand;
    expect(marketDemand).toBeGreaterThanOrEqual(residentSold - TOL);
    expect(market.sold / Math.max(0.01, marketDemand)).toBeLessThan(0.2);

    // 消费撮合结果与落账一致（明细来自真实成交，不是事后补算）。
    const entry = results[BUYER_CITY]!.byGroup![fixture.buyerGroup.id]!;
    expect(round2(entry.bought.food ?? 0)).toBeCloseTo(residentSold, 2);
    expect(round2(entry.effective?.food ?? 0)).toBeCloseTo(basicEffective, 2);
  });

  it('跨城进口只计一次：卖方账本与卖方居民成交不含出口，全局 Σ进口 = Σ出口', () => {
    const fixture = buildFixture();
    fixture.run();

    const buyerMarket = foodMarket(fixture.world, BUYER_CITY);
    const sellerMarket = foodMarket(fixture.world, SELLER_CITY);
    const imported = round2(buyerMarket.intercityImported);
    expect(imported).toBeGreaterThan(1_500);

    // E2：买方账本进口 = 收货贸易流；E3：卖方出口 = 同一批贸易流。
    expect(importsOf(fixture.world, BUYER_CITY)).toBeCloseTo(imported, 2);
    expect(exportsOf(fixture.world, SELLER_CITY)).toBeCloseTo(imported, 2);

    // E5：出口不计入卖方本地账本成交，也不计入卖方居民成交（否则会重复计数）。
    expect(sellerMarket.sold).toBeCloseTo(0, 2);
    expect(round2(fixture.sellerGroup.lastMonth.basicSoldUnits ?? 0)).toBeCloseTo(0, 2);
    expect(round2(fixture.sellerGroup.lastMonth.soldUnits ?? 0)).toBeCloseTo(0, 2);

    // E3 全局：Σ买方进口 = Σ出口贸易流；每次跨城成交只产生一条流。
    const totalImported = round2(
      fixture.world.cities.reduce(
        (total, city) => total + (city.market['food']?.intercityImported ?? 0),
        0,
      ),
    );
    const totalExported = round2(
      foodFlows(fixture.world).reduce((total, flow) => total + flow.qty, 0),
    );
    expect(totalImported).toBeCloseTo(totalExported, 2);
    expect(totalImported).toBeCloseTo(imported, 2);

    // E4 全局：Σ居民食品成交 = Σ本地账本成交 + Σ进口（进口只加一次）。
    let residentSum = 0;
    let ledgerSoldSum = 0;
    for (const city of fixture.world.cities) {
      residentSum += sumStat(fixture.world, city.id, (group) => group.lastMonth.basicSoldUnits);
      ledgerSoldSum += city.market['food']?.sold ?? 0;
    }
    const buyerResidentSold = round2(fixture.buyerGroup.lastMonth.basicSoldUnits ?? 0);
    expect(round2(residentSum)).toBeCloseTo(round2(ledgerSoldSum + totalImported), 2);
    expect(round2(residentSum)).toBeCloseTo(buyerResidentSold, 2);
    expect(buyerResidentSold).toBeCloseTo(round2(ledgerSoldSum + imported), 2);
  });

  it('明细与汇总互相核对：逐城 Σ群体成交 = 本地账本 + 进口，且出口校验不能混入本地账本', () => {
    const fixture = buildFixture();
    fixture.run();

    for (const city of fixture.world.cities) {
      const market = city.market['food']!;
      // 明细（群体 lastMonth 落账）与汇总（本地账本 + 买方账本进口）必须相等。
      const detail = sumStat(fixture.world, city.id, (group) => group.lastMonth.basicSoldUnits);
      const summary = round2((market.sold ?? 0) + (market.intercityImported ?? 0));
      expect(detail).toBeCloseTo(summary, 2);

      // 本地居民买本地 = 本地账本成交（食品无企业投入需求）；这才是“本地校验”的正确残差。
      const imported = round2(market.intercityImported ?? 0);
      const localResidentPurchases = round2(detail - imported);
      expect(localResidentPurchases).toBeCloseTo(round2(market.sold ?? 0), 2);

      // 出口是独立贸易流：报告脚本旧 crossCheck = 本地居民成交 + 出口 − 本地账本，
      // 其真实值恒等于 exported（而不是 0）；正确残差只能是 localResidentPurchases − sold = 0。
      // 这里不依赖脚本实现，只锁定“本地居民成交 = 本地账本”这一正确关系。
    }

    // 卖方出口与买方进口是同一批货：全局“居民实际成交”不应包含两次。
    const buyerDetail = sumStat(fixture.world, BUYER_CITY, (group) => group.lastMonth.basicSoldUnits);
    const sellerExport = exportsOf(fixture.world, SELLER_CITY);
    const sellerDetail = sumStat(fixture.world, SELLER_CITY, (group) => group.lastMonth.basicSoldUnits);
    expect(sellerDetail).toBeCloseTo(0, 2);
    expect(round2(buyerDetail)).toBeCloseTo(
      round2((foodMarket(fixture.world, BUYER_CITY).sold ?? 0) + sellerExport),
      2,
    );
  });

  it('市场台账“未满足”会随 B 阶段进口冲销，与居民落账的最终缺口一致；旧“sold/consumerDemand”仍低估', () => {
    const fixture = buildFixture();
    fixture.run();

    const market = foodMarket(fixture.world, BUYER_CITY);
    const stats = fixture.buyerGroup.lastMonth;
    const residentSold = round2(stats.basicSoldUnits ?? 0);
    const basicNeed = round2(stats.basicNeedUnits ?? 0);
    const finalGap = round2(basicNeed - residentSold);
    expect(finalGap).toBeGreaterThan(0);

    // A 阶段本地只有 500 件，台账 unmetDemand 先记 2,100 件；B 阶段进口约 2,005 件后
    // recordAttempt 按真实成交冲销，最终与居民落账的“商品不足缺口”一致（≈95 件）。
    expect(market.unmetDemand).toBeCloseTo(finalGap, 2);
    expect(round2(stats.supplyShortfallUnits ?? 0)).toBeCloseTo(finalGap, 2);
    expect(market.unmetDemand).toBeLessThan((basicNeed - LOCAL_STOCK) / 10);

    // 旧报告口径 foodSatisfaction = 本地 sold / 市场 consumerDemand 仍然低估居民实际成交：
    // 进口成交不进 sold，但居民确实吃到了；正确满足率分母是居民侧有效需求。
    expect(market.consumerDemand).toBeCloseTo(basicNeed, 2);
    const oldSatisfaction = market.sold / market.consumerDemand;
    const trueSatisfaction = residentSold / round2(stats.basicEffectiveUnits ?? 0);
    expect(oldSatisfaction).toBeLessThan(0.2);
    expect(trueSatisfaction).toBeGreaterThan(0.9);
  });
});
