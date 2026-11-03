import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation/core/simulation';
import { DEMO_CONFIG } from '../src/data/config';
import type { WorldState } from '../src/simulation/contracts/types';
import { GOOD_IDS } from '../src/simulation/companies/company';
import {
  createWorldLedgers,
  executePurchase,
} from '../src/simulation/markets/markets';
import { executeIntercityPurchase } from '../src/simulation/markets/intercity';
import { settleTransportMonth } from '../src/simulation/transport/settlement';
import { taxAccrualOf } from '../src/simulation/government/taxes';
import { round2 } from '../src/simulation/core/math';

/** 清空企业库存与上月统计，便于精确构造含税成交。 */
function quietWorld(): WorldState {
  const world = Simulation.create().state;
  for (const company of world.companies) {
    for (const goodId of GOOD_IDS) company.inventory[goodId] = 0;
    company.cash = 100_000;
    company.lastMonth.revenue = 0;
    company.lastMonth.inputCost = 0;
    company.lastMonth.sold = 0;
    company.lastMonth.exported = 0;
  }
  for (const city of world.cities) {
    city.lastMonth.consumerSpend = 0;
  }
  return world;
}

/** 绿色田野→兰港走廊容量清零（触发最大容量惩罚，便于验证“按净支付计税”）。 */
function zeroCorridorCapacity(world: WorldState): void {
  for (const link of world.transport.links) {
    if (link.mode !== 'road' && link.mode !== 'rail') continue;
    const matches =
      (link.fromCityId === 'greenfield' && link.toCityId === 'lanport') ||
      (link.fromCityId === 'lanport' && link.toCityId === 'greenfield');
    if (matches) link.level = link.mode === 'road' ? 0 : 0;
  }
}

describe('v0.8 消费税：本地居民消费（含税标价 5%）', () => {
  it('100 含税成交：居民付 100、卖方实收 95、税 5 记入消费城市与账本', () => {
    const world = quietWorld();
    const city = world.cities.find((entry) => entry.id === 'lanport')!;
    const seller = world.companies.find((entry) => entry.id === 'lp-food')!;
    seller.inventory.food = 1_000;
    seller.priceFactor = 1;
    city.market.food.price = 10;
    const ledgers = createWorldLedgers(world);
    const sellerCashBefore = seller.cash;
    const sellerRevenueBefore = seller.lastMonth.revenue;

    const result = executePurchase(
      world,
      city,
      ledgers.lanport!,
      'food',
      10,
      100,
      { consumer: true },
      DEMO_CONFIG,
    );

    expect(result.qty).toBeCloseTo(10, 6);
    // 居民实付为含税标价：10 × 10 = 100（税不额外加价）。
    expect(result.spend).toBeCloseTo(100, 6);
    // 卖方按净额入账：100 − 5% = 95。
    expect(seller.cash - sellerCashBefore).toBeCloseTo(95, 6);
    expect(seller.lastMonth.revenue - sellerRevenueBefore).toBeCloseTo(95, 6);
    // 税进入账本与本月税收累计，归消费发生城市。
    const ledger = ledgers.lanport!.food;
    expect(ledger.spend).toBeCloseTo(100, 6);
    expect(ledger.sold).toBeCloseTo(10, 6);
    expect(ledger.consumptionTax).toBeCloseTo(5, 6);
    expect(taxAccrualOf(world, city.id).consumptionTax).toBeCloseTo(5, 6);
    expect(taxAccrualOf(world, 'ironvale').consumptionTax).toBe(0);
  });

  it('未传 config 的旧调用保持原行为（卖方全额入账、不计税）', () => {
    const world = quietWorld();
    const city = world.cities.find((entry) => entry.id === 'lanport')!;
    const seller = world.companies.find((entry) => entry.id === 'lp-food')!;
    seller.inventory.food = 1_000;
    seller.priceFactor = 1;
    city.market.food.price = 10;
    const ledgers = createWorldLedgers(world);
    const sellerCashBefore = seller.cash;

    const result = executePurchase(world, city, ledgers.lanport!, 'food', 10, 100, {
      consumer: true,
    });

    expect(result.spend).toBeCloseTo(100, 6);
    expect(seller.cash - sellerCashBefore).toBeCloseTo(100, 6);
    expect(ledgers.lanport!.food.consumptionTax).toBe(0);
  });
});

describe('v0.8 消费税：跨城居民消费按最终实付计税', () => {
  function crossCitySetup() {
    const world = quietWorld();
    const city = world.cities.find((entry) => entry.id === 'lanport')!;
    const seller = world.companies.find((entry) => entry.id === 'gf-grain')!;
    seller.inventory.grain = 1_000;
    city.market.grain.price = 101.6;
    zeroCorridorCapacity(world);
    const ledgers = createWorldLedgers(world);
    return { world, city, seller, ledgers };
  }

  it('含容量退款：税基为买方净支付（成交额 − 退款），卖方实收再减税', () => {
    const { world, city, seller, ledgers } = crossCitySetup();
    const sellerCashBefore = seller.cash;

    const purchase = executeIntercityPurchase(
      world,
      city,
      ledgers.lanport!,
      'grain',
      100,
      10_000_000,
      { consumer: true },
      DEMO_CONFIG,
    );
    expect(purchase.qty).toBeGreaterThan(0);
    const gross = round2(purchase.spend);

    settleTransportMonth(world, DEMO_CONFIG, [], ledgers);
    const trade = world.transport.lastMonth.trades[0]!;
    expect(trade.path).toBe('householdPurchase');
    // 居民此前按含税成交额付款，退款后净支付 = 卖方容量结算所得。
    const netPaid = round2(gross - trade.buyerRefund!);
    const expectedTax = round2(netPaid * DEMO_CONFIG.tax.consumptionTaxRate);
    // trade.sellerProceeds 是税前卖方所得（恒等式 gross = sellerProceeds + buyerRefund）。
    expect(trade.sellerProceeds).toBeCloseTo(netPaid, 6);
    // 卖方实收为税后净额（不含税）。
    expect(seller.cash - sellerCashBefore).toBeCloseTo(round2(netPaid - expectedTax), 6);
    // 税归买方城市，并计入买方城市消费账本。
    expect(taxAccrualOf(world, city.id).consumptionTax).toBeCloseTo(expectedTax, 6);
    expect(ledgers.lanport!.grain.consumptionTax).toBeCloseTo(expectedTax, 6);
    // 买方账本支出与居民净支付一致（退款已冲减）。
    expect(ledgers.lanport!.grain.spend).toBeCloseTo(netPaid, 6);
    expect(trade.capacityLoss).toBeCloseTo(gross - netPaid, 6);
  });

  it('卖方已不存在：全额退款、无成交也无税（不得对退款征税）', () => {
    const { world, city, seller, ledgers } = crossCitySetup();
    executeIntercityPurchase(
      world,
      city,
      ledgers.lanport!,
      'grain',
      100,
      10_000_000,
      { consumer: true },
      DEMO_CONFIG,
    );
    world.companies = world.companies.filter((entry) => entry.id !== seller.id);

    settleTransportMonth(world, DEMO_CONFIG, [], ledgers);
    const trade = world.transport.lastMonth.trades[0]!;
    expect(trade.sellerProceeds).toBe(0);
    expect(trade.buyerRefund).toBeCloseTo(trade.grossValue, 6);
    expect(taxAccrualOf(world, city.id).consumptionTax).toBe(0);
    expect(ledgers.lanport!.grain.consumptionTax).toBe(0);
    expect(ledgers.lanport!.grain.spend).toBe(0);
  });

  it('部分成交：只对实际成交额计税，未成交部分不征税', () => {
    const { world, city, seller, ledgers } = crossCitySetup();
    seller.inventory.grain = 30;

    const purchase = executeIntercityPurchase(
      world,
      city,
      ledgers.lanport!,
      'grain',
      100,
      10_000_000,
      { consumer: true },
      DEMO_CONFIG,
    );
    expect(purchase.qty).toBeCloseTo(30, 6);
    const gross = round2(purchase.spend);

    settleTransportMonth(world, DEMO_CONFIG, [], ledgers);
    const trade = world.transport.lastMonth.trades[0]!;
    const expectedTax = round2(round2(gross - trade.buyerRefund!) * DEMO_CONFIG.tax.consumptionTaxRate);
    expect(taxAccrualOf(world, city.id).consumptionTax).toBeCloseTo(expectedTax, 6);
    expect(ledgers.lanport!.grain.consumptionTax).toBeCloseTo(expectedTax, 6);
    // 税基不超过实际成交额。
    expect(expectedTax).toBeLessThanOrEqual(round2(gross * DEMO_CONFIG.tax.consumptionTaxRate) + 1e-6);
  });

  it('无容量损失时按全额计税：卖方 95%、税 5%', () => {
    const { world, city, ledgers } = crossCitySetup();
    // 恢复走廊容量到足够大（level 1 = 1,200,000/月，远大于 100 单位需求）。
    for (const link of world.transport.links) {
      if (link.mode === 'road' || link.mode === 'rail') link.level = 1;
    }
    const purchase = executeIntercityPurchase(
      world,
      city,
      ledgers.lanport!,
      'grain',
      100,
      10_000_000,
      { consumer: true },
      DEMO_CONFIG,
    );
    const gross = round2(purchase.spend);
    const sellerCashBefore = world.companies.find((entry) => entry.id === 'gf-grain')!.cash;
    settleTransportMonth(world, DEMO_CONFIG, [], ledgers);
    const trade = world.transport.lastMonth.trades[0]!;
    const seller = world.companies.find((entry) => entry.id === 'gf-grain')!;
    expect(trade.penaltyRate).toBe(0);
    // trade.sellerProceeds 记录税前所得；卖方现金实收 95%（税后）。
    expect(trade.sellerProceeds).toBeCloseTo(gross, 6);
    expect(seller.cash - sellerCashBefore).toBeCloseTo(round2(gross * 0.95), 6);
    expect(taxAccrualOf(world, city.id).consumptionTax).toBeCloseTo(round2(gross * 0.05), 6);
  });
});

describe('v0.8 消费税：与城市财政月结接线', () => {
  it('完整 tick 后市场账本税额 = 城市消费税收支入账（首月交通系数中性 1.0）', () => {
    const sim = Simulation.create();
    const city = sim.state.cities.find((entry) => entry.id === 'lanport')!;
    const result = sim.tick();
    expect(result.ok).toBe(true);

    const marketTax = GOOD_IDS.reduce(
      (sum, goodId) => sum + (city.market[goodId].consumptionTax ?? 0),
      0,
    );
    expect(marketTax).toBeGreaterThan(0);
    // 首月无上一期运输统计 → 中性系数 1.0，税收入账 = 基准税额。
    expect(city.lastMonth.transportTaxFactor).toBe(1);
    expect(city.lastMonth.consumptionTax).toBeCloseTo(round2(marketTax), 6);

    const taxEntries = sim.state.fiscal.ledger.filter(
      (entry) => entry.cityId === city.id && entry.kind === 'consumptionTax',
    );
    const taxSum = taxEntries.reduce((sum, entry) => sum + entry.amount, 0);
    expect(taxSum).toBeCloseTo(city.lastMonth.consumptionTax!, 6);
    // 月结后本月累计清零，避免下月重复计征。
    expect(taxAccrualOf(sim.state, city.id).consumptionTax).toBe(0);
  });
});
