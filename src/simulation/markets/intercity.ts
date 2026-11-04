import type {
  City,
  Company,
  EquipmentKind,
  GoodId,
  TradeFlow,
  WorldState,
} from '../contracts/types';
import type { DemoConfig } from '../../data/config';
import type { CityLedgers, PurchaseResult } from './markets';
import { offeredStock } from './markets';
import { clamp, round2 } from '../core/math';
import { corridorKey, recordIntercitySale } from '../transport/network';

function cityDistanceKm(a: City, b: City): number {
  const dx = a.region.x - b.region.x;
  const dy = a.region.y - b.region.y;
  return Math.sqrt(dx * dx + dy * dy) * 0.35;
}

export interface IntercityOffer {
  company: Company;
  city: City;
  unitPrice: number;
  markup: number;
  km: number;
  /** 该卖家当前可售数量（已扣除自身生产预留）。 */
  available: number;
}

/** 可购买的其他城市卖家候选，按单价从低到高排序（供成交与报价共用）。 */
function intercityOffers(
  world: WorldState,
  buyerCity: City,
  goodId: GoodId,
  config: DemoConfig,
  excludeCompanyId?: string,
): IntercityOffer[] {
  return world.companies
    .filter(
      (company) =>
        company.cityId !== buyerCity.id &&
        company.id !== excludeCompanyId &&
        offeredStock(company, goodId) > 1e-9,
    )
    .flatMap((company): IntercityOffer[] => {
      const city = world.cities.find((candidate) => candidate.id === company.cityId);
      if (!city) return [];
      const basePrice = buyerCity.market[goodId]?.price ?? 0;
      const km = cityDistanceKm(buyerCity, city);
      const markup = clamp(
        km * config.intercity.transportMarkupPerKm,
        config.intercity.minMarkup,
        config.intercity.maxMarkup,
      );
      return [
        {
          company,
          city,
          unitPrice: Math.max(0.01, round2(basePrice * company.priceFactor * (1 + markup))),
          markup,
          km,
          available: offeredStock(company, goodId),
        },
      ];
    })
    .filter((entry) => entry.unitPrice > 0)
    .sort(
      (a, b) =>
        a.unitPrice - b.unitPrice ||
        a.company.cityId.localeCompare(b.company.cityId) ||
        a.company.id.localeCompare(b.company.id),
    );
}

export interface IntercityQuote {
  /** 在给定预算内可成交的数量。 */
  qty: number;
  /** 成交所需金额。 */
  cost: number;
}

/**
 * 只报价、不成交：按真实成交规则（价格 + 运输加成 + 预算）估算某数量需要多少钱。
 * 生产采购在放款前用它与授信额度对齐，避免多借贷款或借了却买不到货。
 */
export function quoteIntercityPurchase(
  world: WorldState,
  buyerCity: City,
  goodId: GoodId,
  desiredQty: number,
  maxSpend: number,
  config: DemoConfig,
  excludeCompanyId?: string,
): IntercityQuote {
  if (!config.intercity.enabled || desiredQty <= 0 || maxSpend <= 0) {
    return { qty: 0, cost: 0 };
  }
  let remainingQty = desiredQty;
  let remainingBudget = maxSpend;
  let qty = 0;
  let cost = 0;
  for (const seller of intercityOffers(world, buyerCity, goodId, config, excludeCompanyId)) {
    if (remainingQty <= 1e-9 || remainingBudget <= 0) break;
    let buy = Math.min(remainingQty, seller.available, remainingBudget / seller.unitPrice);
    buy = Math.floor(buy * 100) / 100;
    if (buy <= 0) continue;
    let lineCost = round2(buy * seller.unitPrice);
    if (lineCost > remainingBudget + 1e-6) {
      buy = Math.floor((remainingBudget / seller.unitPrice) * 100) / 100;
      if (buy <= 0) continue;
      lineCost = round2(buy * seller.unitPrice);
    }
    if (lineCost > remainingBudget + 1e-6) continue;
    qty = round2(qty + buy);
    cost = round2(cost + lineCost);
    remainingQty -= buy;
    remainingBudget -= lineCost;
  }
  return { qty, cost };
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
  options: { buyerCompanyId?: string; consumer?: boolean; householdGroupId?: string },
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

  const sellers = intercityOffers(world, buyerCity, goodId, config, options.buyerCompanyId);

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
    // 跨城成交：买方先付款取得货物；卖方所得在期末按运输容量统一结算
    // （容量不足时卖方少获得收益，不从卖方现金额外扣款）。
    const producedQty = goodId === seller.company.recipeOutput ? qty : 0;
    void producedQty;

    if (buyer) {
      buyer.cash = round2(buyer.cash - cost);
      buyer.inventory[goodId] = round2((buyer.inventory[goodId] ?? 0) + qty);
      buyer.lastMonth.inputCost = round2(buyer.lastMonth.inputCost + cost);
    } else if (!options.consumer) {
      continue;
    }

    recordIntercitySale(world, {
      tick: world.time.tick,
      path: options.consumer ? 'householdPurchase' : 'intercityPurchase',
      fromCityId: seller.company.cityId,
      toCityId: buyerCityId,
      corridorKey: corridorKey(seller.company.cityId, buyerCityId),
      sellerCompanyId: seller.company.id,
      buyerCompanyId: options.buyerCompanyId ?? 'households',
      good: goodId,
      qty,
      grossValue: cost,
      householdGroupId: options.householdGroupId,
    });

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
      path: options.consumer ? 'householdPurchase' : 'intercityPurchase',
    };
    world.lastTick.tradeFlows.push(flow);
  }

  return { qty: round2(bought), spend: round2(spend) };
}

// ---------------------------------------------------------------- v0.9 设备跨城采购

/** 其他城市设备企业的可售清单（价格、运输加成与商品跨城完全同口径）。 */
export function intercityEquipmentOffers(
  world: WorldState,
  buyerCity: City,
  kind: EquipmentKind,
  config: DemoConfig,
  excludeCompanyId?: string,
): IntercityOffer[] {
  const goodId = config.equipment.catalog[kind].goodId;
  return intercityOffers(world, buyerCity, goodId, config, excludeCompanyId);
}

/**
 * 记录一笔跨城设备成交。
 *
 * 设备购买后立即计入企业设备资产，不像商品那样进入买方库存；因此买方城市账本只记
 * “跨城进口 + 支出 + 需求”，不重复记 sold（成交台数由 equipmentMarket 与设备资产追踪）。
 * 卖方所得仍走既有运输容量结算：成交时买方全额付款，期末按城市对容量统一扣减并退回差额
 * （复用 settleTransportMonth 的既有规则，不另造运费/回滚模型）。
 */
export function recordIntercityEquipmentPurchase(
  world: WorldState,
  buyer: Company,
  seller: Company,
  kind: EquipmentKind,
  units: number,
  grossValue: number,
  config: DemoConfig,
): void {
  const goodId = config.equipment.catalog[kind].goodId;
  const buyerCity = world.cities.find((city) => city.id === buyer.cityId);
  const corridor = corridorKey(seller.cityId, buyer.cityId);
  recordIntercitySale(world, {
    tick: world.time.tick,
    path: 'intercityPurchase',
    fromCityId: seller.cityId,
    toCityId: buyer.cityId,
    corridorKey: corridor,
    sellerCompanyId: seller.id,
    buyerCompanyId: buyer.id,
    good: goodId,
    qty: units,
    grossValue,
  });
  // 市场账本增量由 equipment.ts 记入 equipmentMarket.pendingLedger，
  // 再由 createWorldLedgers 合并（直接写 city.market 会被 finalizeMarkets 覆盖）。
  world.lastTick.tradeFlows.push({
    routeId: `market:${seller.cityId}:${buyer.cityId}`,
    tick: world.time.tick,
    fromCityId: seller.cityId,
    toCityId: buyer.cityId,
    fromCompanyId: seller.id,
    toCompanyId: buyer.id,
    good: goodId,
    qty: units,
    unitPrice: units > 0 ? round2(grossValue / units) : 0,
    value: grossValue,
    path: 'intercityPurchase',
  });
}
