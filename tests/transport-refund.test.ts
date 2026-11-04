import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation/core/simulation';
import { DEMO_CONFIG } from '../src/data/config';
import type { WorldState } from '../src/simulation/contracts/types';
import { GOOD_IDS, setCompanyEmployees } from '../src/simulation/companies/company';
import { syncCityPopulationFromAllocations } from '../src/simulation/population/population';
import { createWorldLedgers, sumCityStock } from '../src/simulation/markets/markets';
import { executeIntercityPurchase } from '../src/simulation/markets/intercity';
import { executeTradeRoutes } from '../src/simulation/trade/trade';
import { executeAgreements } from '../src/simulation/agreements/agreements';
import { settleTransportMonth } from '../src/simulation/transport/settlement';
import type { HouseholdRefundsByCity } from '../src/simulation/transport/settlement';
import { advanceTransportConstruction, startCorridorUpgrade } from '../src/simulation/transport/network';
import { parseSave, serializeSave } from '../src/simulation/core/save';
import { checkInvariants } from '../src/simulation/core/invariants';
import { settleGovernment } from '../src/simulation/government/fiscal';
import { collectInvestableFunds } from '../src/simulation/investors/investors';
import { runConsumerMarket } from '../src/simulation/markets/consumer';
import { householdGroupsOfCity } from '../src/simulation/population/household-groups';
import { householdConsumerBudgetSnapshot } from '../src/simulation/population/household-finance';
import { round2 } from '../src/simulation/core/math';
import { splitConsumptionTax, taxAccrualOf } from '../src/simulation/government/taxes';
import { appointPlayerMayor } from '../src/simulation/politics/politics';
import { migrateLegacyCompanyDebt } from '../src/simulation/banking/banking';

const PRICE = 101.6;

function baseWorld(): WorldState {
  const world = Simulation.create().state;
  for (const company of world.companies) {
    company.cash = 100_000;
    for (const goodId of GOOD_IDS) company.inventory[goodId] = 0;
    company.lastMonth.revenue = 0;
    company.lastMonth.inputCost = 0;
    company.lastMonth.sold = 0;
    company.lastMonth.exported = 0;
  }
  const city = world.cities.find((entry) => entry.id === 'lanport')!;
  city.market.grain.price = PRICE;
  city.market.grain.goodId = 'grain';
  return world;
}

function setCapacity(world: WorldState, level: number): void {
  for (const link of world.transport.links) {
    if (link.mode !== 'road' && link.mode !== 'rail') continue;
    const matches =
      (link.fromCityId === 'greenfield' && link.toCityId === 'lanport') ||
      (link.fromCityId === 'lanport' && link.toCityId === 'greenfield');
    if (matches) link.level = link.mode === 'road' ? level : 0;
  }
}

function contractSetup() {
  const world = baseWorld();
  const seller = world.companies.find((company) => company.id === 'gf-grain')!;
  const buyer = world.companies.find((company) => company.id === 'lp-food')!;
  seller.inventory.grain = 1_000;
  seller.cash = 0;
  buyer.inventory.grain = 0;
  buyer.cash = 100_000;
  buyer.baseWageBill = 0;
  buyer.debt = 0;
  setCompanyEmployees(buyer, 0);
  buyer.jobDemand = 0;
  // v0.9：设备产能由设备台数独立推导，夹具不再手工改写 capacity/equipmentCapacity 缓存。
  for (const city of world.cities) syncCityPopulationFromAllocations(city, world);
  buyer.utilization = 1;
  setCapacity(world, 0);
  world.tradeRoutes = [
    {
      id: 'route-refund-test',
      fromCityId: 'greenfield',
      toCityId: 'lanport',
      fromCompanyId: seller.id,
      toCompanyId: buyer.id,
      good: 'grain',
      monthlyTarget: 100,
      distanceKm: 10,
      active: true,
      note: '',
    },
  ];
  return { world, seller, buyer };
}

function settle(
  world: WorldState,
  ledgers = createWorldLedgers(world),
): HouseholdRefundsByCity {
  return settleTransportMonth(world, DEMO_CONFIG, [], ledgers);
}

/** 手工交易不会经过月度 finalizeMarkets；在断言不变量前同步期末库存缓存。 */
function syncMarketStock(world: WorldState): void {
  for (const city of world.cities) {
    for (const goodId of GOOD_IDS) {
      city.market[goodId].closingStock = sumCityStock(world, city.id, goodId);
    }
  }
}

describe('修复三：跨城超载结算的买卖双方资金流', () => {
  it('复现场景：买方原付 10,160，卖方所得 5,080，差额退回买方且交易数量不变', () => {
    const { world, seller, buyer } = contractSetup();
    const buyerCashBefore = buyer.cash;
    const buyerInputBefore = buyer.lastMonth.inputCost;
    const flows = executeTradeRoutes(world, DEMO_CONFIG, []);
    expect(flows).toHaveLength(1);
    settle(world);
    const trade = world.transport.lastMonth.trades[0]!;
    expect(trade.qty).toBe(100);
    expect(trade.grossValue).toBeCloseTo(10_160, 2);
    expect(trade.penaltyRate).toBe(DEMO_CONFIG.transport.penalty.max);
    expect(trade.sellerProceeds).toBeCloseTo(5_080, 2);
    expect(trade.capacityLoss).toBeCloseTo(5_080, 2);
    expect(trade.buyerRefund).toBeCloseTo(5_080, 2);
    // 买方净支付 = 卖方所得；没有额外扣款或罚款。
    expect(buyerCashBefore - buyer.cash).toBeCloseTo(5_080, 2);
    expect(buyer.lastMonth.inputCost - buyerInputBefore).toBeCloseTo(5_080, 2);
    expect(seller.cash).toBeCloseTo(5_080, 2);
    expect(trade.grossValue).toBeCloseTo(trade.sellerProceeds + trade.buyerRefund!, 2);
    expect(buyer.inventory.grain).toBeCloseTo(100, 2);
    expect(seller.inventory.grain).toBeCloseTo(900, 2);
    syncMarketStock(world);
    expect(checkInvariants(world)).toEqual([]);
  });

  it('未超载：不发生容量损失，也没有退款，买方付全额', () => {
    const { world, buyer, seller } = contractSetup();
    setCapacity(world, 1);
    const buyerCashBefore = buyer.cash;
    executeTradeRoutes(world, DEMO_CONFIG, []);
    settle(world);
    const trade = world.transport.lastMonth.trades[0]!;
    expect(trade.penaltyRate).toBe(0);
    expect(trade.capacityLoss).toBe(0);
    expect(trade.buyerRefund).toBe(0);
    expect(trade.sellerProceeds).toBeCloseTo(10_160, 2);
    expect(buyerCashBefore - buyer.cash).toBeCloseTo(10_160, 2);
    expect(seller.cash).toBeCloseTo(10_160, 2);
  });

  it('容量提升后，同样需求的退款与卖方损失下降；容量足够时归零', () => {
    const { world, buyer, seller } = contractSetup();
    const firstBuyerCash = buyer.cash;
    executeTradeRoutes(world, DEMO_CONFIG, []);
    settle(world);
    const first = world.transport.lastMonth.trades[0]!;
    expect(first.buyerRefund).toBeGreaterThan(0);

    // 建设一条公路后容量 1,200,000，100 单位需求不再超载。
    const city = world.cities.find((entry) => entry.id === 'greenfield')!;
    city.treasury = 5_000_000;
    expect(
      startCorridorUpgrade(world, 'greenfield', 'lanport', 'road', DEMO_CONFIG, {
        cityId: city.id,
      }).ok,
    ).toBe(true);
    for (let i = 0; i < DEMO_CONFIG.transport.road.buildMonthsPerLevel; i++) {
      advanceTransportConstruction(world, DEMO_CONFIG, []);
    }
    seller.inventory.grain = 1_000;
    buyer.cash = firstBuyerCash;
    buyer.inventory.grain = 0;
    executeTradeRoutes(world, DEMO_CONFIG, []);
    settle(world);
    const second = world.transport.lastMonth.trades[0]!;
    expect(second.penaltyRate).toBe(0);
    expect(second.buyerRefund).toBe(0);
    expect(second.sellerProceeds).toBeCloseTo(second.grossValue, 2);
  });

  it('多卖家多笔交易：每笔独立退款，卖方所得合计等于买方净支付', () => {
    const world = baseWorld();
    const buyer = world.companies.find((company) => company.id === 'lp-food')!;
    const sellers = world.companies.filter(
      (company) => company.cityId === 'greenfield' && company.id !== buyer.id,
    ).slice(0, 2);
    for (const seller of sellers) {
      seller.inventory.grain = 100;
      seller.cash = 0;
    }
    buyer.inventory.grain = 0;
    buyer.cash = 100_000;
    buyer.baseWageBill = 0;
    buyer.debt = 0;
    setCompanyEmployees(buyer, 0);
    for (const city of world.cities) syncCityPopulationFromAllocations(city, world);
    setCapacity(world, 0);
    const ledgers = createWorldLedgers(world);
    const purchase = executeIntercityPurchase(
      world,
      world.cities.find((entry) => entry.id === 'lanport')!,
      ledgers.lanport!,
      'grain',
      200,
      100_000,
      { buyerCompanyId: buyer.id },
      DEMO_CONFIG,
    );
    expect(purchase.qty).toBe(200);
    settle(world, ledgers);
    const trades = world.transport.lastMonth.trades;
    expect(trades.length).toBeGreaterThanOrEqual(2);
    const refunds = trades.reduce((sum, trade) => sum + (trade.buyerRefund ?? 0), 0);
    const proceeds = trades.reduce((sum, trade) => sum + trade.sellerProceeds, 0);
    const gross = trades.reduce((sum, trade) => sum + trade.grossValue, 0);
    expect(refunds).toBeCloseTo(proceeds, 2);
    expect(gross).toBeCloseTo(refunds + proceeds, 2);
    for (const seller of sellers) {
      const trade = trades.find((entry) => entry.sellerCompanyId === seller.id);
      if (trade) expect(seller.cash).toBeCloseTo(trade.sellerProceeds, 2);
    }
    // 买方净支付等于全部卖方所得。
    expect(100_000 - buyer.cash).toBeCloseTo(proceeds, 2);
  });

  it('政府牵头协议同样先付后退：协议价仍为总额，买方净支付按容量减少', () => {
    const world = baseWorld();
    const city = world.cities.find((entry) => entry.id === 'lanport')!;
    const seller = world.companies.find((company) => company.id === 'gf-grain')!;
    const buyer = world.companies.find((company) => company.id === 'lp-food')!;
    seller.inventory.grain = 1_000;
    seller.cash = 0;
    buyer.cash = 100_000;
    buyer.inventory.grain = 0;
    setCapacity(world, 0);
    world.agreements.push({
      id: 'agreement-refund',
      title: '退款测试协议',
      sponsorCityId: 'lanport',
      partnerCityId: 'greenfield',
      createdTick: 0,
      createdBy: 'government',
      status: 'active',
      participants: [
        { companyId: buyer.id, cityId: 'lanport', side: 'buyer', decision: 'accepted', decidedTick: 0, note: '' },
        { companyId: seller.id, cityId: 'greenfield', side: 'seller', decision: 'accepted', decidedTick: 0, note: '' },
      ],
      items: [
        {
          id: 'agreement-refund-item-1',
          good: 'grain',
          buyerCompanyId: buyer.id,
          sellerCompanyId: seller.id,
          qtyPerMonth: 100,
          unitPrice: PRICE,
          months: 2,
          deliveredQty: 0,
          paidValue: 0,
          monthsExecuted: 0,
          status: 'active',
          lastNote: '',
        },
      ],
      note: '',
    });
    const flows = executeAgreements(world, DEMO_CONFIG, 1, []);
    expect(flows).toHaveLength(1);
    settle(world);
    const trade = world.transport.lastMonth.trades[0]!;
    expect(trade.path).toBe('agreement');
    expect(trade.grossValue).toBeCloseTo(10_160, 2);
    expect(trade.sellerProceeds).toBeCloseTo(5_080, 2);
    expect(trade.buyerRefund).toBeCloseTo(5_080, 2);
    expect(100_000 - buyer.cash).toBeCloseTo(5_080, 2);
    expect(seller.cash).toBeCloseTo(5_080, 2);
    const item = world.agreements[0]!.items[0]!;
    expect(item.paidValue).toBeCloseTo(10_160, 2);
    expect(item.status).toBe('active');
    expect(city.treasury).toBeGreaterThanOrEqual(0);
  });

  it('资金不足时只成交可负担部分；完全买不起时不留待结算交易或资金变化', () => {
    const { world, buyer } = contractSetup();
    buyer.cash = 0;
    // v0.4：银行是债务唯一权威。用一笔巨额承接贷款把账面股权压到 0，使可借额度为 0。
    buyer.debt = 1_000_000_000;
    migrateLegacyCompanyDebt(world, DEMO_CONFIG, world.time.tick);
    const before = buyer.cash;
    const flows = executeTradeRoutes(world, DEMO_CONFIG, []);
    expect(flows).toHaveLength(0);
    expect(world.transport.pendingSales).toHaveLength(0);
    expect(buyer.cash).toBe(before);

    // 部分成交：只买得起 50 单位。
    buyer.cash = 5_080;
    buyer.inventory.grain = 0;
    executeTradeRoutes(world, DEMO_CONFIG, []);
    settle(world);
    const trade = world.transport.lastMonth.trades[0]!;
    expect(trade.qty).toBe(50);
    expect(trade.grossValue).toBeCloseTo(5_080, 2);
    expect(trade.sellerProceeds).toBeCloseTo(2_540, 2);
    expect(trade.buyerRefund).toBeCloseTo(2_540, 2);
    expect(5_080 - buyer.cash).toBeCloseTo(2_540, 2);
  });

  it('居民跨城购买：差额退回城市居民收入并冲减消费支出，卖方所得不变', () => {
    const world = baseWorld();
    const city = world.cities.find((entry) => entry.id === 'lanport')!;
    const seller = world.companies.find((company) => company.id === 'gf-grain')!;
    seller.inventory.grain = 1_000;
    seller.cash = 0;
    city.householdIncomeLastMonth = 100_000;
    city.lastMonth.consumerSpend = 10_160;
    setCapacity(world, 0);
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
    const refunds = settle(world, ledgers);
    const trade = world.transport.lastMonth.trades[0]!;
    expect(trade.path).toBe('householdPurchase');
    expect(trade.buyerCompanyId).toBe('households');
    expect(trade.grossValue).toBeCloseTo(purchase.spend, 2);
    expect(trade.sellerProceeds).toBeCloseTo(purchase.spend * (1 - trade.penaltyRate), 2);
    expect(trade.buyerRefund).toBeCloseTo(purchase.spend - trade.sellerProceeds, 2);
    expect(refunds.lanport?.total).toBeCloseTo(trade.buyerRefund!, 2);
    expect(city.lastMonth.consumerSpend).toBeCloseTo(
      Math.max(0, 10_160 - (trade.buyerRefund ?? 0)),
      2,
    );
    // v0.8：买方支付额保持含税（净支付 = 成交额 − 退款），税从卖方所得中代扣 5%。
    const netPaid = round2(purchase.spend - (trade.buyerRefund ?? 0));
    const tax = splitConsumptionTax(trade.sellerProceeds, DEMO_CONFIG).tax;
    expect(netPaid).toBeCloseTo(trade.sellerProceeds, 2);
    expect(seller.cash).toBeCloseTo(round2(trade.sellerProceeds - tax), 2);
    expect(tax).toBeCloseTo(round2(netPaid * DEMO_CONFIG.tax.consumptionTaxRate), 2);
    // 税记到消费发生城市（买方城市）的账本与本月累计。
    expect(ledgers.lanport!.grain.spend).toBeCloseTo(netPaid, 2);
    expect(ledgers.lanport!.grain.consumptionTax).toBeCloseTo(tax, 2);
    expect(taxAccrualOf(world, city.id).consumptionTax).toBeCloseTo(tax, 2);
    expect(taxAccrualOf(world, seller.cityId).consumptionTax).toBe(0);
    const control = structuredClone(world);
    const finance = {
      investorDividendsByCity: {}, investorDistributionByCity: {}, cityDividendsByCity: {},
      dividendsByCity: {}, playerDividends: 0, playerDividendsByCompany: {},
      corporateTaxByCity: {}, privateWagesByCity: {}, wageArrears: 0,
    };
    settleGovernment(world, finance, DEMO_CONFIG, [], refunds);
    settleGovernment(control, finance, DEMO_CONFIG, []);
    const controlCity = control.cities.find((entry) => entry.id === 'lanport')!;
    expect(city.householdIncomeLastMonth - controlCity.householdIncomeLastMonth).toBeCloseTo(trade.buyerRefund!, 2);
    expect(city.lastMonth.householdIncome).toBe(controlCity.lastMonth.householdIncome);
    collectInvestableFunds(world, DEMO_CONFIG, []);
    collectInvestableFunds(control, DEMO_CONFIG, []);
    const availableDifference = city.householdIncomeLastMonth - controlCity.householdIncomeLastMonth;
    const investmentDifference = city.lastMonth.investableContribution - controlCity.lastMonth.investableContribution;
    expect(availableDifference + investmentDifference).toBeCloseTo(trade.buyerRefund!, 2);
  });

  it('居民退款经过完整月度结算与存档后仍进入下期可用预算，且不计为新收入', () => {
    const config = DEMO_CONFIG;
    const sim = Simulation.create(config);
    const world = sim.state;
    const city = world.cities.find((entry) => entry.id === 'lanport')!;
    expect(appointPlayerMayor(world, city.id).ok).toBe(true);
    const seller = world.companies.find((entry) => entry.id === 'gf-grain')!;
    for (const company of world.companies) company.inventory.grain = 0;
    seller.inventory.grain = 1_000;
    city.market.grain.price = PRICE;
    setCapacity(world, 0);
    const ledgers = createWorldLedgers(world);
    const purchase = executeIntercityPurchase(world, city, ledgers.lanport!, 'grain', 100, 10_160, { consumer: true }, config);
    expect(purchase.qty).toBeGreaterThan(0);
    syncMarketStock(world);
    const tick = sim.tick();
    expect(tick.ok).toBe(true);
    const refunds = world.transport.lastMonth.trades
      .filter((trade) => trade.buyerCompanyId === 'households' && trade.toCityId === city.id)
      .reduce((sum, trade) => sum + (trade.buyerRefund ?? 0), 0);
    expect(refunds).toBeGreaterThan(0);
    expect(city.householdIncomeLastMonth + city.lastMonth.investableContribution)
      .toBeCloseTo(city.lastMonth.householdIncome + refunds, 2);
    const restored = parseSave(serializeSave(world));
    expect(restored.ok, restored.error).toBe(true);
    const restoredCity = restored.world!.cities.find((entry) => entry.id === city.id)!;
    // 问题 5：预算已改为逐群体口径（由 householdConsumerBudgetSnapshot 计算：上月收入按比例
    // + 现金按比例，并先扣当月到期贷款），不再是城市统一预算。
    // 必须在 runConsumerMarket 之前取预算：运行后群体现金已被消费扣减。
    const budgetTick = restored.world!.time.tick;
    const expectedBudget = round2(
      householdGroupsOfCity(restored.world!, city.id).reduce(
        (sum, group) =>
          sum +
          round2(
            householdConsumerBudgetSnapshot(restored.world!, group, config, budgetTick).cashBudget,
          ),
        0,
      ),
    );
    const nextBudget = runConsumerMarket(restored.world!, restoredCity, createWorldLedgers(restored.world!)[city.id]!, config).budget;
    expect(nextBudget).toBeCloseTo(expectedBudget, 2);
  });

  it('读档时仍未结算的跨城交易按新规则结算，旧存档不会被静默改写', () => {
    const { world, buyer, seller } = contractSetup();
    const buyerCashBefore = buyer.cash;
    executeTradeRoutes(world, DEMO_CONFIG, []);
    expect(world.transport.pendingSales).toHaveLength(1);
    syncMarketStock(world);
    const parsed = parseSave(serializeSave(world));
    expect(parsed.ok, parsed.error).toBe(true);
    const restored = parsed.world!;
    expect(restored.transport.pendingSales).toHaveLength(1);
    const restoredBuyer = restored.companies.find((company) => company.id === buyer.id)!;
    const restoredSeller = restored.companies.find((company) => company.id === seller.id)!;
    settleTransportMonth(restored, DEMO_CONFIG, [], createWorldLedgers(restored));
    const trade = restored.transport.lastMonth.trades[0]!;
    expect(trade.buyerRefund).toBeGreaterThan(0);
    expect(restoredBuyer.cash).toBeCloseTo(buyerCashBefore - trade.sellerProceeds, 2);
    expect(restoredSeller.cash).toBeCloseTo(trade.sellerProceeds, 2);
    syncMarketStock(restored);
    expect(checkInvariants(restored)).toEqual([]);
  });

  it('旧存档历史交易没有 buyerRefund 字段时仍可读取，且不改写历史资金', () => {    const { world, buyer } = contractSetup();
    executeTradeRoutes(world, DEMO_CONFIG, []);
    settle(world);
    const buyerCashAfter = buyer.cash;
    syncMarketStock(world);
    const clone = JSON.parse(serializeSave(world)) as Record<string, any>;
    for (const trade of clone.world.transport.lastMonth.trades) delete trade.buyerRefund;
    // 构造旧版记录：gross = proceeds + capacityLoss，没有退款字段。
    const result = parseSave(JSON.stringify(clone));
    expect(result.ok, result.error).toBe(true);
    const restored = result.world!;
    expect(restored.transport.lastMonth.trades[0]!.buyerRefund).toBeUndefined();
    const restoredBuyer = restored.companies.find((company) => company.id === 'lp-food')!;
    expect(restoredBuyer.cash).toBeCloseTo(buyerCashAfter, 2);
    syncMarketStock(restored);
    expect(checkInvariants(restored)).toEqual([]);
  });
});
