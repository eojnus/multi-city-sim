import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation/core/simulation';
import { DEMO_CONFIG } from '../src/data/config';
import type { WorldState } from '../src/simulation/contracts/types';
import { GOOD_IDS } from '../src/simulation/companies/company';
import { createWorldLedgers, executePurchase } from '../src/simulation/markets/markets';
import { executeIntercityPurchase } from '../src/simulation/markets/intercity';
import { executeTradeRoutes } from '../src/simulation/trade/trade';
import { executeAgreements } from '../src/simulation/agreements/agreements';
import { startPolicy } from '../src/simulation/policies/policies';
import { settleTransportMonth } from '../src/simulation/transport/settlement';
import { splitConsumptionTax } from '../src/simulation/government/taxes';
import {
  advanceTransportConstruction,
  capacityPenalty,
  corridorCapacity,
  intracityCapacity,
  startCorridorUpgrade,
} from '../src/simulation/transport/network';

function baseWorld(): WorldState {
  const world = Simulation.create().state;
  for (const company of world.companies) {
    company.cash = 2_000_000;
    for (const goodId of GOOD_IDS) company.inventory[goodId] = 0;
    company.lastMonth.revenue = 0;
    company.lastMonth.inputCost = 0;
    company.lastMonth.sold = 0;
    company.lastMonth.exported = 0;
  }
  for (const city of world.cities) city.market.grain.price = 100;
  return world;
}

function setCorridorLevel(world: WorldState, a: string, b: string, road: number, rail: number): void {
  for (const link of world.transport.links) {
    const matches =
      (link.fromCityId === a && link.toCityId === b) || (link.fromCityId === b && link.toCityId === a);
    if (!matches) continue;
    link.level = link.mode === 'road' ? road : rail;
    link.construction = null;
  }
}

interface TradeSetup {
  world: WorldState;
  seller: WorldState['companies'][number];
  buyer: WorldState['companies'][number];
}

/** 卖方在 greenfield 有 grain，买方在 lanport 需要 grain。 */
function tradeSetup(): TradeSetup {
  const world = baseWorld();
  const seller = world.companies.find((company) => company.id === 'gf-grain')!;
  const buyer = world.companies.find((company) => company.cityId === 'lanport' && company.recipeOutput === 'food')!;
  seller.inventory.grain = 10_000;
  seller.cash = 0;
  buyer.inventory.grain = 0;
  buyer.cash = 10_000_000;
  return { world, seller, buyer };
}

function buy(world: WorldState, buyerCompanyId: string, qty: number) {
  const ledgers = createWorldLedgers(world);
  const buyerCity = world.cities.find((city) => city.id === 'lanport')!;
  const result = executeIntercityPurchase(
    world,
    buyerCity,
    ledgers.lanport!,
    'grain',
    qty,
    100_000_000,
    { buyerCompanyId },
    DEMO_CONFIG,
  );
  settleTransportMonth(world, DEMO_CONFIG, [], ledgers);
  return result;
}

describe('城际运输容量：不是成交上限，只减少卖方收益', () => {
  it('容量低于需求：交易仍全额成交，卖方少获得收益，买方差额被退回', () => {
    const { world, seller, buyer } = tradeSetup();
    setCorridorLevel(world, 'greenfield', 'lanport', 0, 0);
    const buyerCashBefore = buyer.cash;
    const inputCostBefore = buyer.lastMonth.inputCost;
    const result = buy(world, buyer.id, 100);
    expect(result.qty).toBe(100);
    const trade = world.transport.lastMonth.trades.find((entry) => entry.sellerCompanyId === seller.id)!;
    expect(trade).toBeDefined();
    expect(trade.qty).toBe(100);
    const gross = trade.grossValue;
    expect(trade.penaltyRate).toBe(DEMO_CONFIG.transport.penalty.max);
    expect(trade.capacityLoss).toBeCloseTo(gross * DEMO_CONFIG.transport.penalty.max, 2);
    expect(trade.sellerProceeds).toBeCloseTo(gross - trade.capacityLoss, 2);
    // 暂定方案：买方先按原价付款，期末差额退回；净支付 = 卖方所得。
    expect(trade.buyerRefund).toBeCloseTo(trade.capacityLoss, 2);
    expect(buyer.cash).toBeCloseTo(buyerCashBefore - trade.sellerProceeds, 2);
    expect(buyer.lastMonth.inputCost).toBeCloseTo(inputCostBefore + trade.sellerProceeds, 2);
    expect(seller.cash).toBeCloseTo(trade.sellerProceeds, 2);
    // 没有对卖方额外扣款：卖方现金恰好等于其所得，不出现负值或额外罚金。
    expect(seller.cash).toBeGreaterThanOrEqual(0);
    expect(trade.grossValue).toBeCloseTo(trade.sellerProceeds + trade.buyerRefund!, 2);
    // 买方库存按成交数量增加，商品守恒。
    expect(buyer.inventory.grain).toBeCloseTo(100, 2);
    expect(seller.inventory.grain).toBeCloseTo(9_900, 2);
  });

  it('容量等于需求：不产生惩罚，卖方获得全额收益', () => {
    const { world, seller, buyer } = tradeSetup();
    // 先把容量调到与 100 单位需求一致：公路 1 级容量远大于需求，改用容量公式验证边界。
    const capacity = corridorCapacity(world, 'greenfield', 'lanport', DEMO_CONFIG);
    const penalty = capacityPenalty(capacity, capacity, DEMO_CONFIG);
    expect(penalty.penaltyRate).toBe(0);
    const result = buy(world, buyer.id, 100);
    expect(result.qty).toBe(100);
    const trade = world.transport.lastMonth.trades.find((entry) => entry.sellerCompanyId === seller.id)!;
    expect(trade.penaltyRate).toBe(0);
    expect(trade.capacityLoss).toBe(0);
    expect(seller.cash).toBeCloseTo(trade.grossValue, 2);
  });

  it('容量高于需求：惩罚为 0，且容量越高效益损失越小', () => {
    const { world } = tradeSetup();
    const demand = 3_000_000;
    const low = capacityPenalty(demand, 1_200_000, DEMO_CONFIG);
    const high = capacityPenalty(demand, 3_600_000, DEMO_CONFIG);
    expect(low.overloadRatio).toBeCloseTo(0.6, 2);
    expect(low.penaltyRate).toBeCloseTo(0.36, 2);
    expect(high.penaltyRate).toBeLessThan(low.penaltyRate);
    expect(capacityPenalty(demand, demand * 2, DEMO_CONFIG).penaltyRate).toBe(0);
    void world;
  });

  it('超过容量交易不被截断：2 倍容量的采购仍然全部成交', () => {
    const { world, buyer } = tradeSetup();
    setCorridorLevel(world, 'greenfield', 'lanport', 0, 0);
    const result = buy(world, buyer.id, 2_000);
    expect(result.qty).toBe(2_000);
    expect(world.transport.lastMonth.trades.reduce((sum, entry) => sum + entry.qty, 0)).toBe(2_000);
  });

  it('政府建设提高容量后，相同需求的收益惩罚减轻', () => {
    const { world, seller, buyer } = tradeSetup();
    setCorridorLevel(world, 'greenfield', 'lanport', 0, 0);
    const city = world.cities.find((entry) => entry.id === 'greenfield')!;
    city.treasury = 20_000_000;
    const capacityBefore = corridorCapacity(world, 'greenfield', 'lanport', DEMO_CONFIG);
    const upgrade = startCorridorUpgrade(world, 'greenfield', 'lanport', 'road', DEMO_CONFIG, {
      cityId: city.id,
    });
    expect(upgrade.ok, upgrade.error).toBe(true);
    expect(city.treasury).toBeLessThan(20_000_000);
    for (let i = 0; i < DEMO_CONFIG.transport.road.buildMonthsPerLevel; i++) {
      advanceTransportConstruction(world, DEMO_CONFIG, []);
    }
    const capacityAfter = corridorCapacity(world, 'greenfield', 'lanport', DEMO_CONFIG);
    expect(capacityAfter).toBeGreaterThan(capacityBefore);

    const before = buy(world, buyer.id, 100);
    expect(before.qty).toBe(100);
    const tradeAfter = world.transport.lastMonth.trades.find((entry) => entry.sellerCompanyId === seller.id)!;
    expect(tradeAfter.penaltyRate).toBe(0);
    expect(tradeAfter.capacityLoss).toBe(0);
  });

  it('同一城市对的多条跨城路径共享同一需求/容量与惩罚比例', () => {
    const world = baseWorld();
    const city = world.cities.find((entry) => entry.id === 'lanport')!;
    const sellerA = world.companies.find((company) => company.id === 'gf-grain')!;
    const sellerB = world.companies.find(
      (company) => company.cityId === 'greenfield' && company.id !== sellerA.id,
    )!;
    const buyer = world.companies.find(
      (company) => company.cityId === 'lanport' && company.recipeOutput === 'food',
    )!;
    sellerA.inventory.grain = 5_000;
    sellerB.inventory.grain = 5_000;
    sellerA.cash = 0;
    sellerB.cash = 0;
    buyer.cash = 100_000_000;
    buyer.inventory.grain = 0;
    setCorridorLevel(world, 'greenfield', 'lanport', 0, 0);

    // 路径 1：企业区域市场采购。
    const ledgers = createWorldLedgers(world);
    executeIntercityPurchase(world, city, ledgers.lanport!, 'grain', 400, 100_000_000, {
      buyerCompanyId: buyer.id,
    }, DEMO_CONFIG);
    // 路径 2：另一家企业的区域市场采购。
    const secondBuyer = world.companies.find(
      (company) => company.cityId === 'lanport' && company.id !== buyer.id,
    )!;
    secondBuyer.cash = 100_000_000;
    secondBuyer.inventory.grain = 0;
    executeIntercityPurchase(world, city, ledgers.lanport!, 'grain', 300, 100_000_000, {
      buyerCompanyId: secondBuyer.id,
    }, DEMO_CONFIG);
    // 路径 3：居民跨城购买。
    executeIntercityPurchase(world, city, ledgers.lanport!, 'grain', 100, 100_000_000, {
      consumer: true,
    }, DEMO_CONFIG);
    // 路径 4：政府牵头的多企业协议（真实执行路径）。
    world.agreements.push({
      id: 'agreement-test',
      title: '测试协议',
      sponsorCityId: 'lanport',
      partnerCityId: 'greenfield',
      createdTick: world.time.tick,
      createdBy: 'government',
      status: 'active',
      participants: [
        { companyId: buyer.id, cityId: 'lanport', side: 'buyer', decision: 'accepted', decidedTick: 0, note: '' },
        { companyId: sellerB.id, cityId: 'greenfield', side: 'seller', decision: 'accepted', decidedTick: 0, note: '' },
      ],
      items: [
        {
          id: 'agreement-test-item-1',
          good: 'grain',
          buyerCompanyId: buyer.id,
          sellerCompanyId: sellerB.id,
          qtyPerMonth: 200,
          unitPrice: 100,
          months: 1,
          deliveredQty: 0,
          paidValue: 0,
          monthsExecuted: 0,
          status: 'active',
          lastNote: '',
        },
      ],
      note: '',
    });
    const agreementFlows = executeAgreements(world, DEMO_CONFIG, world.time.tick, []);
    expect(agreementFlows).toHaveLength(1);
    // 路径 5：长期跨城合同。
    buyer.inventory.grain = 0;
    buyer.capacity = 5_000;
    buyer.utilization = 1;
    world.tradeRoutes = [
      {
        id: 'route-test',
        fromCityId: 'greenfield',
        toCityId: 'lanport',
        fromCompanyId: sellerA.id,
        toCompanyId: buyer.id,
        good: 'grain',
        monthlyTarget: 50,
        distanceKm: 10,
        active: true,
        note: '',
      },
    ];
    const contractFlows = executeTradeRoutes(world, DEMO_CONFIG, []);
    expect(contractFlows).toHaveLength(1);

    const paths = new Set(world.transport.pendingSales.map((sale) => sale.path));
    expect(paths.has('intercityPurchase')).toBe(true);
    expect(paths.has('householdPurchase')).toBe(true);
    expect(paths.has('agreement')).toBe(true);
    expect(paths.has('contract')).toBe(true);

    settleTransportMonth(world, DEMO_CONFIG, [], ledgers);
    const trades = world.transport.lastMonth.trades;
    expect(trades).toHaveLength(5);
    const rates = new Set(trades.map((trade) => trade.penaltyRate));
    expect(rates.size).toBe(1);
    const corridor = world.transport.lastMonth.corridors.find(
      (entry) => entry.corridorKey === 'greenfield|lanport',
    )!;
    expect(corridor.demand).toBeCloseTo(trades.reduce((sum, trade) => sum + trade.qty, 0), 2);
    for (const trade of trades) {
      expect(trade.grossValue).toBeCloseTo(trade.sellerProceeds + trade.capacityLoss, 2);
      expect(trade.penaltyRate).toBe(DEMO_CONFIG.transport.penalty.max);
    }
    // 买方付款与卖方所得分离：没有从卖方额外扣款。
    // v0.8：居民消费（householdPurchase）的 5% 消费税从卖方所得中代扣，归买方城市，
    // 因此卖方到账 = ΣsellerProceeds − Σ居民消费税额；企业间交易不扣税。
    const householdTrades = trades.filter((trade) => trade.buyerCompanyId === 'households');
    expect(householdTrades.length).toBeGreaterThan(0);
    const consumptionTax = householdTrades.reduce(
      (sum, trade) => sum + splitConsumptionTax(trade.sellerProceeds, DEMO_CONFIG).tax,
      0,
    );
    expect(consumptionTax).toBeGreaterThan(0);
    const sellerCash = sellerA.cash + sellerB.cash;
    const sellerProceeds = trades.reduce((sum, trade) => sum + trade.sellerProceeds, 0);
    expect(sellerCash).toBeCloseTo(sellerProceeds - consumptionTax, 1);
  });
  it('没有容量（零等级）也不禁止交易，只取最大惩罚', () => {
    const { world, buyer } = tradeSetup();
    setCorridorLevel(world, 'greenfield', 'lanport', 0, 0);
    const result = buy(world, buyer.id, 50);
    expect(result.qty).toBe(50);
    expect(world.transport.lastMonth.trades[0]!.penaltyRate).toBe(DEMO_CONFIG.transport.penalty.max);
    expect(world.transport.lastMonth.trades[0]!.capacity).toBe(0);
  });
});

describe('城内交通：配送容量影响本地运输过程', () => {
  it('上期配送需求超过容量时，本期本地可配送量按效率下降', () => {
    const world = baseWorld();
    const city = world.cities.find((entry) => entry.id === 'lanport')!;
    const seller = world.companies.find((company) => company.cityId === city.id)!;
    seller.inventory[city.market.grain.goodId] = 0;
    seller.inventory.food = 10_000;
    const network = world.transport.intracity.find((entry) => entry.cityId === city.id)!;
    const capacity = intracityCapacity(network, DEMO_CONFIG);
    world.transport.lastMonth.intracity = [
      {
        cityId: city.id,
        demand: capacity * 2,
        capacity,
        utilization: 2,
        deliveryEfficiency: DEMO_CONFIG.transport.intracity.efficiencyFloor,
      },
    ];
    const ledgers = createWorldLedgers(world);
    const result = executePurchase(world, city, ledgers[city.id]!, 'food', 10_000, 100_000_000, {
      consumer: true,
    });
    // 可配送量只有 55%（efficiencyFloor），不会被当作全部供应。
    expect(result.qty).toBeLessThanOrEqual(10_000 * DEMO_CONFIG.transport.intracity.efficiencyFloor + 0.01);
    expect(result.qty).toBeGreaterThan(0);
    expect(seller.inventory.food).toBeGreaterThanOrEqual(10_000 * (1 - DEMO_CONFIG.transport.intracity.efficiencyFloor) - 0.1);
  });

  it('城内交通升级由财政出资，建成后容量提高', () => {
    const world = baseWorld();
    const city = world.cities.find((entry) => entry.id === 'ironvale')!;
    city.treasury = 5_000_000;
    const network = world.transport.intracity.find((entry) => entry.cityId === city.id)!;
    const before = intracityCapacity(network, DEMO_CONFIG);
    const result = startIntracityUpgradeDirect(world, city.id);
    expect(result.ok, result.error).toBe(true);
    for (let i = 0; i < DEMO_CONFIG.transport.intracity.buildMonthsPerLevel; i++) {
      advanceTransportConstruction(world, DEMO_CONFIG, []);
    }
    expect(intracityCapacity(network, DEMO_CONFIG)).toBeGreaterThan(before);
  });
});

function startIntracityUpgradeDirect(world: WorldState, cityId: string) {
  // 通过公开政策入口使用城内投资，保持与玩家操作一致的财政/建设路径。
  return startPolicy(world, cityId, 'transportInvestment', DEMO_CONFIG, {
    transportTarget: 'intracity:road',
  });
}
