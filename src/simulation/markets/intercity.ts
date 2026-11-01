import type {
  City,
  GoodId,
  TradeFlow,
  WorldState,
} from '../contracts/types';
import type { DemoConfig } from '../../data/config';
import type { CityLedgers, PurchaseResult } from './markets';
import { offeredStock } from './markets';
import { clamp, round2 } from '../core/math';

function cityDistanceKm(a: City, b: City): number {
  const dx = a.region.x - b.region.x;
  const dy = a.region.y - b.region.y;
  return Math.sqrt(dx * dx + dy * dy) * 0.35;
}

/**
 * 区域市场补货：本城供应不足时，企业或居民可从其他城市企业直接购买。
 * 价格包含演示运输加成；成交记录写入城市间贸易流。
 * 每个卖家批次先验证库存和买方资金，再整体提交。
 */
export function executeIntercityPurchase(
  world: WorldState,
  buyerCity: City,
  ledgers: CityLedgers,
  goodId: GoodId,
  desiredQty: number,
  maxSpend: number,
  options: { buyerCompanyId?: string; consumer?: boolean },
  config: DemoConfig,
): PurchaseResult {
  if (!config.intercity.enabled || desiredQty <= 0 || maxSpend <= 0) {
    return { qty: 0, spend: 0 };
  }
  const ledger = ledgers[goodId];
  if (!ledger) return { qty: 0, spend: 0 };

  const buyer =
    options.buyerCompanyId === undefined
      ? undefined
      : world.companies.find((company) => company.id === options.buyerCompanyId);
  // 只有卖方城市与买方所在城市不同时才算出口；居民跨城补货同样计入出口。
  const buyerCityId = buyer ? buyer.cityId : buyerCity.id;

  const sellers = world.companies
    .filter(
      (company) =>
        company.cityId !== buyerCity.id &&
        company.id !== options.buyerCompanyId &&
        offeredStock(company, goodId) > 1e-9,
    )
    .map((company) => {
      const city = world.cities.find((candidate) => candidate.id === company.cityId);
      const basePrice = buyerCity.market[goodId]?.price ?? 0;
      const km = city ? cityDistanceKm(buyerCity, city) : 0;
      const markup = clamp(
        km * config.intercity.transportMarkupPerKm,
        config.intercity.minMarkup,
        config.intercity.maxMarkup,
      );
      return {
        company,
        city,
        unitPrice: Math.max(0.01, round2(basePrice * company.priceFactor * (1 + markup))),
        markup,
        km,
      };
    })
    .filter((entry) => entry.city !== undefined && entry.unitPrice > 0)
    .sort(
      (a, b) =>
        a.unitPrice - b.unitPrice ||
        a.company.cityId.localeCompare(b.company.cityId) ||
        a.company.id.localeCompare(b.company.id),
    );

  let remainingQty = desiredQty;
  let remainingBudget = maxSpend;
  let bought = 0;
  let spend = 0;

  for (const seller of sellers) {
    if (remainingQty <= 1e-9 || remainingBudget <= 0) break;
    const available = offeredStock(seller.company, goodId);
    if (available <= 0) continue;
    let qty = Math.min(remainingQty, available, remainingBudget / seller.unitPrice);
    qty = Math.floor(qty * 100) / 100;
    if (qty <= 0) continue;
    let cost = round2(qty * seller.unitPrice);
    if (cost > remainingBudget + 1e-6) {
      qty = Math.floor((remainingBudget / seller.unitPrice) * 100) / 100;
      if (qty <= 0) continue;
      cost = round2(qty * seller.unitPrice);
    }
    if (cost > remainingBudget + 1e-6) continue;
    const currentStock = seller.company.inventory[goodId] ?? 0;
    if (qty > currentStock + 1e-6) continue;
    if (buyer && buyer.cash < cost - 1e-6) continue;

    // ---- 原子提交 ----
    seller.company.inventory[goodId] = round2(currentStock - qty);
    seller.company.cash = round2(seller.company.cash + cost);
    seller.company.lastMonth.revenue = round2(seller.company.lastMonth.revenue + cost);
    // 只有卖出自身产出才计入企业统计；跨城成交计出口，本地成交计内销。
    const producedQty = goodId === seller.company.recipeOutput ? qty : 0;
    if (seller.company.cityId !== buyerCityId) {
      seller.company.lastMonth.exported = round2(
        seller.company.lastMonth.exported + producedQty,
      );
    } else {
      seller.company.lastMonth.sold = round2(
        seller.company.lastMonth.sold + producedQty,
      );
    }

    if (buyer) {
      buyer.cash = round2(buyer.cash - cost);
      buyer.inventory[goodId] = round2((buyer.inventory[goodId] ?? 0) + qty);
      buyer.lastMonth.inputCost = round2(buyer.lastMonth.inputCost + cost);
    } else if (!options.consumer) {
      continue;
    }

    ledger.intercityImported = round2(ledger.intercityImported + qty);
    ledger.spend = round2(ledger.spend + cost);
    ledger.transactionCount += 1;
    bought += qty;
    spend += cost;
    remainingQty -= qty;
    remainingBudget -= cost;

    const flow: TradeFlow = {
      routeId: `market:${seller.company.cityId}:${buyerCity.id}`,
      tick: world.time.tick,
      fromCityId: seller.company.cityId,
      toCityId: buyerCity.id,
      fromCompanyId: seller.company.id,
      toCompanyId: options.buyerCompanyId ?? 'households',
      good: goodId,
      qty,
      unitPrice: seller.unitPrice,
      value: cost,
    };
    world.lastTick.tradeFlows.push(flow);
  }

  return { qty: round2(bought), spend: round2(spend) };
}
