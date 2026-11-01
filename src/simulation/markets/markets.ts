import type {
  City,
  Company,
  GoodId,
  MarketState,
  WorldState,
} from '../contracts/types';
import type { DemoConfig } from '../../data/config';
import { GOODS, RECIPES } from '../../data/demo-data';
import { GOOD_IDS } from '../companies/company';
import { clamp, round2 } from '../core/math';
import { intracityDeliveryEfficiency } from '../transport/network';

/**
 * 企业自用投入品不进入本月可售供应，避免同一批原料在月内被反复转卖，
 * 也避免企业把自己生产所需的原料卖给别的企业后无法生产。
 */
export function reservedForProduction(company: Company, goodId: GoodId): number {
  const recipe = RECIPES[company.recipeOutput];
  if (!recipe) return 0;
  const input = recipe.inputs.find((entry) => entry.good === goodId);
  if (!input) return 0;
  return Math.max(0, company.capacity * company.utilization * input.qty);
}

export function offeredStock(company: Company, goodId: GoodId): number {
  const stock = company.inventory[goodId] ?? 0;
  return Math.max(0, round2(stock - reservedForProduction(company, goodId)));
}

export interface MarketLedger {
  goodId: GoodId;
  supply: number;
  demand: number;
  consumerDemand: number;
  producerDemand: number;
  sold: number;
  unmetDemand: number;
  intercityImported: number;
  externalExport: number;
  spend: number;
  transactionCount: number;
}

export type CityLedgers = Record<GoodId, MarketLedger>;
export type WorldLedgers = Record<string, CityLedgers>;

export interface PurchaseResult {
  qty: number;
  spend: number;
}

export function createLedger(goodId: GoodId): MarketLedger {
  return {
    goodId,
    supply: 0,
    demand: 0,
    consumerDemand: 0,
    producerDemand: 0,
    sold: 0,
    unmetDemand: 0,
    intercityImported: 0,
    externalExport: 0,
    spend: 0,
    transactionCount: 0,
  };
}

export function createWorldLedgers(world: WorldState): WorldLedgers {
  const ledgers: WorldLedgers = {};
  for (const city of world.cities) {
    const cityLedgers = {} as CityLedgers;
    for (const goodId of GOOD_IDS) {
      const ledger = createLedger(goodId);
      ledger.supply = sumCityOfferedStock(world, city.id, goodId);
      cityLedgers[goodId] = ledger;
    }
    ledgers[city.id] = cityLedgers;
  }
  return ledgers;
}

export function sumCityOfferedStock(world: WorldState, cityId: string, goodId: GoodId): number {
  let total = 0;
  for (const company of world.companies) {
    if (company.cityId === cityId) total += offeredStock(company, goodId);
  }
  return round2(total);
}

export function sumCityStock(world: WorldState, cityId: string, goodId: GoodId): number {
  let total = 0;
  for (const company of world.companies) {
    if (company.cityId === cityId) total += company.inventory[goodId] ?? 0;
  }
  return total;
}

export function cityMarketPrices(city: City): Record<GoodId, number> {
  const prices = {} as Record<GoodId, number>;
  for (const good of GOODS) prices[good.id] = city.market[good.id]?.price ?? good.basePrice;
  return prices;
}

export function recordProducedSupply(ledgers: CityLedgers, goodId: GoodId, qty: number): void {
  const ledger = ledgers[goodId];
  if (ledger) ledger.supply += qty;
}

/**
 * 从本城企业库存中买入。每个成交批次都先验证库存与预算，再整体提交。
 * 生产者购买进入企业库存；居民购买为最终消费，不再进入任何库存。
 */
export function executePurchase(
  world: WorldState,
  city: City,
  ledgers: CityLedgers,
  goodId: GoodId,
  desiredQty: number,
  maxSpend: number,
  options: { buyerCompanyId?: string; consumer?: boolean },
): PurchaseResult {
  const ledger = ledgers[goodId];
  if (!ledger || desiredQty <= 0 || maxSpend <= 0) return { qty: 0, spend: 0 };

  // 城内交通：本月可配送量受上一期配送压力影响（容量不足时低于 1）。
  const deliveryEfficiency = clamp(intracityDeliveryEfficiency(world, city.id), 0, 1);

  const marketPrice = city.market[goodId]?.price ?? 0;
  const buyer =
    options.buyerCompanyId === undefined
      ? undefined
      : world.companies.find((company) => company.id === options.buyerCompanyId);
  const sellers = world.companies
    .filter(
      (company) =>
        company.cityId === city.id &&
        company.id !== options.buyerCompanyId &&
        offeredStock(company, goodId) > 1e-9,
    )
    .map((company) => ({
      company,
      unitPrice: Math.max(0.01, round2(marketPrice * company.priceFactor)),
    }))
    .sort((a, b) => a.unitPrice - b.unitPrice || a.company.id.localeCompare(b.company.id));

  let remainingQty = desiredQty;
  let remainingBudget = maxSpend;
  let bought = 0;
  let spend = 0;

  for (const seller of sellers) {
    if (remainingQty <= 1e-9 || remainingBudget <= 0) break;
    const available = round2(offeredStock(seller.company, goodId) * deliveryEfficiency);
    if (available <= 0) continue;
    const affordable = seller.unitPrice > 0 ? remainingBudget / seller.unitPrice : 0;
    let qty = Math.min(remainingQty, available, affordable);
    if (qty <= 1e-9) continue;
    qty = Math.floor(qty * 100) / 100;
    if (qty <= 0) continue;
    const cost = round2(qty * seller.unitPrice);
    if (cost > remainingBudget + 1e-6) {
      qty = Math.floor((remainingBudget / seller.unitPrice) * 100) / 100;
      if (qty <= 0) continue;
    }
    const finalCost = round2(qty * seller.unitPrice);
    if (finalCost > remainingBudget + 1e-6) continue;
    if (qty > available + 1e-6) continue;
    if (buyer && buyer.cash < finalCost - 1e-6) continue;

    // ---- 提交点：以下变化要么全部发生，要么不发生 ----
    const currentStock = seller.company.inventory[goodId] ?? 0;
    if (qty > currentStock + 1e-6) continue;
    seller.company.inventory[goodId] = round2(currentStock - qty);
    if (seller.company.inventory[goodId] < 0 && seller.company.inventory[goodId] > -1e-6) {
      seller.company.inventory[goodId] = 0;
    }
    seller.company.cash = round2(seller.company.cash + finalCost);
    seller.company.lastMonth.revenue = round2(seller.company.lastMonth.revenue + finalCost);
    seller.company.lastMonth.sold = round2(
      seller.company.lastMonth.sold + (goodId === seller.company.recipeOutput ? qty : 0),
    );

    if (buyer) {
      buyer.cash = round2(buyer.cash - finalCost);
      buyer.inventory[goodId] = round2((buyer.inventory[goodId] ?? 0) + qty);
      buyer.lastMonth.inputCost = round2(buyer.lastMonth.inputCost + finalCost);
    } else if (options.consumer) {
      // 最终消费：货物离开企业库存后不再进入库存账本。
    } else {
      throw new Error('购买必须指定企业买家或居民最终消费');
    }

    ledger.sold = round2(ledger.sold + qty);
    ledger.spend = round2(ledger.spend + finalCost);
    ledger.transactionCount += 1;
    bought += qty;
    spend += finalCost;
    remainingQty -= qty;
    remainingBudget -= finalCost;
  }

  return { qty: round2(bought), spend: round2(spend) };
}

export function applyProducerPurchase(
  world: WorldState,
  city: City,
  ledgers: CityLedgers,
  buyer: Company,
  goodId: GoodId,
  shortage: number,
  maxSpend: number,
): PurchaseResult {
  const ledger = ledgers[goodId];
  if (!ledger) return { qty: 0, spend: 0 };
  const price = city.market[goodId]?.price ?? 1;
  const affordableQty = Math.max(0, maxSpend / Math.max(0.01, price));
  const effectiveDemand = Math.min(shortage, affordableQty);
  if (effectiveDemand > 0) {
    ledger.producerDemand = round2(ledger.producerDemand + effectiveDemand);
    ledger.demand = round2(ledger.demand + effectiveDemand);
  }
  const result = executePurchase(world, city, ledgers, goodId, effectiveDemand, maxSpend, {
    buyerCompanyId: buyer.id,
  });
  const unmet = Math.max(0, effectiveDemand - result.qty);
  if (unmet > 0) ledger.unmetDemand = round2(ledger.unmetDemand + unmet);
  return result;
}

export function applyConsumerDemand(
  world: WorldState,
  city: City,
  ledgers: CityLedgers,
  goodId: GoodId,
  desiredQty: number,
): PurchaseResult {
  const ledger = ledgers[goodId];
  if (!ledger) return { qty: 0, spend: 0 };
  const price = city.market[goodId]?.price ?? 1;
  const budget = desiredQty * price;
  ledger.consumerDemand = round2(ledger.consumerDemand + desiredQty);
  ledger.demand = round2(ledger.demand + desiredQty);
  const result = executePurchase(world, city, ledgers, goodId, desiredQty, budget, {
    consumer: true,
  });
  const unmet = Math.max(0, desiredQty - result.qty);
  if (unmet > 0) ledger.unmetDemand = round2(ledger.unmetDemand + unmet);
  return result;
}

export function finalizeMarkets(
  world: WorldState,
  ledgers: WorldLedgers,
  config: DemoConfig,
): void {
  const goodBase = new Map(GOODS.map((good) => [good.id, good]));

  for (const city of world.cities) {
    const cityLedgers = ledgers[city.id];
    if (!cityLedgers) continue;
    for (const goodId of GOOD_IDS) {
      const ledger = cityLedgers[goodId];
      const good = goodBase.get(goodId);
      if (!ledger || !good) continue;
      const previous = city.market[goodId];
      const oldPrice = previous?.price ?? good.basePrice;
      const closingStock = round2(sumCityStock(world, city.id, goodId));

      let change = 0;
      if (ledger.demand > 0.01) {
        const ratio = (ledger.demand - ledger.sold) / Math.max(ledger.demand, 1);
        change += clamp(ratio * config.market.priceAdjustSpeed, -config.market.maxMonthlyChange, config.market.maxMonthlyChange);
      }
      if (closingStock > Math.max(1, ledger.sold) * config.market.stockSurplusThreshold) {
        change -= config.market.stockDiscount;
      }
      const newPrice = round2(
        clamp(
          oldPrice * (1 + change),
          good.basePrice * config.market.minPriceFactor,
          good.basePrice * config.market.maxPriceFactor,
        ),
      );

      const next: MarketState = {
        goodId,
        price: newPrice,
        supply: round2(ledger.supply),
        demand: round2(ledger.demand),
        consumerDemand: round2(ledger.consumerDemand),
        producerDemand: round2(ledger.producerDemand),
        sold: round2(ledger.sold),
        unmetDemand: round2(ledger.unmetDemand),
        intercityImported: round2(ledger.intercityImported),
        externalExport: round2(ledger.externalExport),
        closingStock,
        lastPriceChangePct: oldPrice === 0 ? 0 : round2((newPrice / oldPrice - 1) * 10000) / 100,
      };
      city.market[goodId] = next;
    }
  }
}
