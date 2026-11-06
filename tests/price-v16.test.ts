// v1.6 §二：商品价格规则（短缺快涨 / 进口计入需求 / 过剩与竞争回落 / 向锚价回归 / 上下限）。
//
// 口径（PLAN D3/D7）：
// - 缺口率 = 未成交有效需求 ÷ 有效需求；unmetDemand 已由跨城进口冲销，进口满足的需求不算缺口；
// - 过剩率 = 期末库存超过“成交覆盖量（本地成交+进口）× stockSurplusThreshold”的部分 ÷ 成交覆盖量；
// - 锚价 = clamp(上月单位生产成本中位数, 基础价, 基础价 × costAnchorMaxFactor)；
// - 单月变动 ±maxMonthlyChange，价格夹在 basePrice × [minPriceFactor, maxPriceFactor]。
//
// 只写测试，不改产品代码；除价格规则外不动真实经济（清库存只为隔离 closingStock）。

import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation/core/simulation';
import { DEMO_CONFIG } from '../src/data/config';
import { GOODS } from '../src/data/demo-data';
import type { City, GoodId, WorldState } from '../src/simulation/contracts/types';
import type { MarketLedger } from '../src/simulation/markets/markets';
import { createWorldLedgers, finalizeMarkets, priceAnchor } from '../src/simulation/markets/markets';

const CONFIG = DEMO_CONFIG;
const GOOD: GoodId = 'food';
const CITY_INDEX = 0;

function basePriceOf(goodId: GoodId): number {
  const good = GOODS.find((entry) => entry.id === goodId);
  if (!good) throw new Error(`缺少商品 ${goodId}`);
  return good.basePrice;
}

function newWorld(): WorldState {
  return Simulation.create().state;
}

function cityAt(world: WorldState, index = CITY_INDEX): City {
  const city = world.cities[index];
  if (!city) throw new Error(`缺少第 ${index} 个城市`);
  return city;
}

/** 清空本城该商品库存，隔离 closingStock；返回城市与账本。 */
function prepare(world: WorldState, goodId: GoodId = GOOD): { city: City; ledger: MarketLedger } {
  const city = cityAt(world);
  for (const company of world.companies) {
    if (company.cityId === city.id) company.inventory[goodId] = 0;
  }
  const ledgers = createWorldLedgers(world);
  const ledger = ledgers[city.id]?.[goodId];
  if (!ledger) throw new Error(`缺少账本 ${city.id}/${goodId}`);
  return { city, ledger };
}

function priceOf(world: WorldState, cityId: string, goodId: GoodId): number {
  const price = world.cities.find((city) => city.id === cityId)?.market[goodId]?.price;
  if (price === undefined) throw new Error(`缺少市场价 ${cityId}/${goodId}`);
  return price;
}

/** 应用一次月度价格结算，返回涨跌幅（百分数）与成交字段快照。 */
function finalizeOnce(
  world: WorldState,
  cityId: string,
  patch: Partial<MarketLedger>,
  goodId: GoodId = GOOD,
): { pct: number; before: number; after: number; sold: number; demand: number } {
  const ledgers = createWorldLedgers(world);
  const ledger = ledgers[cityId]?.[goodId];
  if (!ledger) throw new Error(`缺少账本 ${cityId}/${goodId}`);
  Object.assign(ledger, patch);
  const before = priceOf(world, cityId, goodId);
  finalizeMarkets(world, ledgers, CONFIG);
  const market = world.cities.find((city) => city.id === cityId)?.market[goodId];
  if (!market) throw new Error(`缺少市场 ${cityId}/${goodId}`);
  return {
    pct: (market.price / before - 1) * 100,
    before,
    after: market.price,
    sold: market.sold,
    demand: market.demand,
  };
}

describe('v1.6 §二 商品价格：缺口口径', () => {
  it('跨城进口满足的需求不算缺口：需求100/本地60/进口40 不推高价格', () => {
    const world = newWorld();
    const { city } = prepare(world);
    const result = finalizeOnce(world, city.id, {
      demand: 100,
      consumerDemand: 100,
      sold: 60,
      intercityImported: 40,
      unmetDemand: 0,
    });
    // 只剩“价格低于锚价”的回归量级（<0.5%），绝不能按 40% 缺口上涨。
    expect(result.pct).toBeGreaterThan(-0.5);
    expect(result.pct).toBeLessThan(0.5);
  });

  it('同一需求下没进口时才按真实缺口上涨（对照）', () => {
    const world = newWorld();
    const { city } = prepare(world);
    const result = finalizeOnce(world, city.id, {
      demand: 100,
      consumerDemand: 100,
      sold: 60,
      intercityImported: 0,
      unmetDemand: 40,
    });
    expect(result.pct).toBeGreaterThan(10);
    expect(result.pct).toBeLessThanOrEqual(CONFIG.market.maxMonthlyChange * 100 + 0.01);
  });

  it('短缺越重涨得越快，且单月涨幅封顶', () => {
    const mild = (() => {
      const world = newWorld();
      const { city } = prepare(world);
      return finalizeOnce(world, city.id, {
        demand: 100,
        consumerDemand: 100,
        sold: 90,
        unmetDemand: 10,
      });
    })();
    const severe = (() => {
      const world = newWorld();
      const { city } = prepare(world);
      return finalizeOnce(world, city.id, {
        demand: 100,
        consumerDemand: 100,
        sold: 40,
        unmetDemand: 60,
      });
    })();
    expect(mild.pct).toBeGreaterThan(0);
    expect(severe.pct).toBeGreaterThan(mild.pct);
    expect(severe.pct).toBeCloseTo(CONFIG.market.maxMonthlyChange * 100, 1);
  });

  it('买不起的需求（不进入 demand）不推高价格', () => {
    const world = newWorld();
    const { city } = prepare(world);
    // 有效需求 10 全部成交，另有大量“资金缺口”只记在 unmetFunding。
    const result = finalizeOnce(world, city.id, {
      demand: 10,
      consumerDemand: 10,
      sold: 10,
      unmetDemand: 0,
      unmetFunding: 500,
    });
    expect(result.pct).toBeLessThan(0.5);
  });
});

describe('v1.6 §二 商品价格：过剩、竞争与回归', () => {
  it('库存积压时下跌', () => {
    const world = newWorld();
    const { city } = prepare(world);
    const producer = world.companies.find((company) => company.cityId === city.id);
    if (!producer) throw new Error('缺少企业');
    producer.inventory[GOOD] = 500;
    const result = finalizeOnce(world, city.id, {
      demand: 50,
      consumerDemand: 50,
      sold: 50,
      unmetDemand: 0,
    });
    expect(result.pct).toBeLessThan(-10);
  });

  it('跨城进口计入成交覆盖量，不把已售出的进口货再算成积压', () => {
    const world = newWorld();
    const { city } = prepare(world);
    const producer = world.companies.find((company) => company.cityId === city.id);
    if (!producer) throw new Error('缺少企业');
    producer.inventory[GOOD] = 100;
    // 成交覆盖量 = 10 本地 + 90 进口 = 100，低于 1.6 倍阈值 → 不算过剩。
    const covered = finalizeOnce(world, city.id, {
      demand: 100,
      consumerDemand: 60,
      producerDemand: 40,
      sold: 10,
      intercityImported: 90,
      unmetDemand: 0,
    });
    expect(covered.pct).toBeGreaterThan(-2);

    const world2 = newWorld();
    const { city: city2 } = prepare(world2);
    const producer2 = world2.companies.find((company) => company.cityId === city2.id);
    if (!producer2) throw new Error('缺少企业');
    producer2.inventory[GOOD] = 100;
    const notCovered = finalizeOnce(world2, city2.id, {
      demand: 100,
      consumerDemand: 100,
      sold: 10,
      intercityImported: 0,
      unmetDemand: 90,
    });
    // 主要是缺口上涨，不是过剩下跌——用于确认覆盖量口径没有把缺口和过剩搞反。
    expect(notCovered.pct).toBeGreaterThan(0);
  });

  it('供需平衡但价格在高位时，缓慢向基础价值回归', () => {
    const world = newWorld();
    const { city } = prepare(world);
    const base = basePriceOf(GOOD);
    const market = world.cities.find((entry) => entry.id === city.id)?.market[GOOD];
    if (!market) throw new Error('缺少市场');
    market.price = base * 1.5;
    const result = finalizeOnce(world, city.id, {
      demand: 50,
      consumerDemand: 50,
      sold: 50,
      unmetDemand: 0,
    });
    expect(result.pct).toBeLessThan(0);
    expect(result.pct).toBeGreaterThan(-3);
  });

  it('竞争更激烈（同价同库存、卖家更多）时跌得更多', () => {
    const oneSeller = (() => {
      const world = newWorld();
      const { city } = prepare(world);
      const producer = world.companies.find((company) => company.cityId === city.id);
      if (!producer) throw new Error('缺少企业');
      producer.inventory[GOOD] = 120;
      const market = city.market[GOOD];
      market.price = basePriceOf(GOOD) * 1.8;
      return finalizeOnce(world, city.id, { demand: 50, sold: 50, unmetDemand: 0 });
    })();
    const threeSellers = (() => {
      const world = newWorld();
      const { city } = prepare(world);
      const producers = world.companies.filter((company) => company.cityId === city.id).slice(0, 3);
      if (producers.length < 3) throw new Error('企业不足 3 家');
      for (const producer of producers) producer.inventory[GOOD] = 40;
      const market = city.market[GOOD];
      market.price = basePriceOf(GOOD) * 1.8;
      return finalizeOnce(world, city.id, { demand: 50, sold: 50, unmetDemand: 0 });
    })();
    expect(threeSellers.pct).toBeLessThan(oneSeller.pct);
  });

  it('没有需求也没有库存时价格不涨（不制造无需求上涨）', () => {
    const world = newWorld();
    const { city } = prepare(world);
    const result = finalizeOnce(world, city.id, {
      demand: 0,
      sold: 0,
      intercityImported: 0,
      unmetDemand: 0,
    });
    expect(Math.abs(result.pct)).toBeLessThan(0.01);
  });
});

describe('v1.6 §二 商品价格：成本锚与边界', () => {
  it('真实单位生产成本长期上升时，锚价高于基础价并推高价格', () => {
    const world = newWorld();
    const { city } = prepare(world);
    const base = basePriceOf(GOOD);
    const producer = world.companies.find(
      (company) => company.cityId === city.id && company.recipeOutput === GOOD,
    );
    if (!producer) throw new Error(`缺少 ${GOOD} 生产者`);
    // 上月：卖出 100 个单位，COGS 与工资合计达到基础价的 1.2 倍/单位。
    producer.previousMonth.sold = 100;
    producer.previousMonth.cogs = base * 100;
    producer.previousMonth.wagesPaid = base * 0.2 * 100;

    const anchor = priceAnchor(world, city.id, GOOD, base, CONFIG);
    expect(anchor).toBeCloseTo(base * 1.2, 1);
    expect(anchor).toBeGreaterThan(base);

    const market = city.market[GOOD];
    market.price = base;
    const result = finalizeOnce(world, city.id, {
      demand: 50,
      consumerDemand: 50,
      sold: 50,
      unmetDemand: 0,
    });
    expect(result.pct).toBeGreaterThan(0);
  });

  it('成本锚有上限，不会被异常成本推飞', () => {
    const world = newWorld();
    const { city } = prepare(world);
    const base = basePriceOf(GOOD);
    const producer = world.companies.find(
      (company) => company.cityId === city.id && company.recipeOutput === GOOD,
    );
    if (!producer) throw new Error(`缺少 ${GOOD} 生产者`);
    producer.previousMonth.sold = 100;
    producer.previousMonth.cogs = base * 999 * 100;
    producer.previousMonth.wagesPaid = 0;
    const anchor = priceAnchor(world, city.id, GOOD, base, CONFIG);
    expect(anchor).toBeCloseTo(base * CONFIG.market.costAnchorMaxFactor, 6);
  });

  it('连续短缺时价格封顶在 maxPriceFactor，连续过剩时封底在 minPriceFactor', () => {
    const world = newWorld();
    const { city } = prepare(world);
    const base = basePriceOf(GOOD);
    for (let month = 0; month < 40; month += 1) {
      finalizeOnce(world, city.id, {
        demand: 100,
        consumerDemand: 100,
        sold: 10,
        unmetDemand: 90,
      });
    }
    expect(priceOf(world, city.id, GOOD)).toBeCloseTo(
      base * CONFIG.market.maxPriceFactor,
      1,
    );

    const producer = world.companies.find((company) => company.cityId === city.id);
    if (!producer) throw new Error('缺少企业');
    producer.inventory[GOOD] = 5000;
    for (let month = 0; month < 40; month += 1) {
      finalizeOnce(world, city.id, { demand: 10, consumerDemand: 10, sold: 10, unmetDemand: 0 });
    }
    expect(priceOf(world, city.id, GOOD)).toBeCloseTo(
      base * CONFIG.market.minPriceFactor,
      1,
    );
  });

  it('价格规则不伪造成交量（成交/需求字段原样落账）', () => {
    const world = newWorld();
    const { city } = prepare(world);
    const result = finalizeOnce(world, city.id, {
      demand: 100,
      consumerDemand: 100,
      sold: 60,
      intercityImported: 40,
      unmetDemand: 0,
    });
    expect(result.sold).toBe(60);
    expect(result.demand).toBe(100);
  });

  it('配置项齐全且起伏方向符合“短缺涨得比过剩跌得快”', () => {
    const { market } = CONFIG;
    expect(market.shortageRiseSpeed).toBeGreaterThan(0);
    expect(market.surplusFallSpeed).toBeGreaterThan(0);
    expect(market.competitionFallSpeed).toBeGreaterThan(0);
    expect(market.reversionSpeed).toBeGreaterThan(0);
    expect(market.maxMonthlyChange).toBeGreaterThan(0);
    expect(market.maxMonthlyChange).toBeLessThan(0.5);
    expect(market.shortageRiseSpeed).toBeGreaterThan(market.surplusFallSpeed);
    expect(market.minPriceFactor).toBeLessThan(1);
    expect(market.maxPriceFactor).toBeGreaterThan(1);
    expect(CONFIG.market.costAnchorMaxFactor).toBeGreaterThanOrEqual(1);
    expect(CONFIG.market.initialPriceFactor).toBeGreaterThan(0);
  });
});
