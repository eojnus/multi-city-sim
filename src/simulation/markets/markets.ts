import type {
  City,
  Company,
  CompanyMonthlyStats,
  GoodId,
  MarketState,
  WorldState,
} from '../contracts/types';
import type { DemoConfig } from '../../data/config';
import { GOODS, RECIPES } from '../../data/demo-data';
import { GOOD_IDS } from '../companies/company';
import { clamp, round2 } from '../core/math';
import { intracityDeliveryEfficiency } from '../transport/network';
import { accrueConsumptionTax, splitConsumptionTax } from '../government/taxes';
import { issueInventory, receiveInventory } from '../finance/inventory-cost';

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

/**
 * 月度市场账本（只在当月结算中使用，最终写入 city.market 的 MarketState）。
 *
 * 企业采购的需求口径（验收复验）：
 * - producerRequired：按生产计划需要采购的数量（资金不足前）；
 * - producerDemand：形成有效购买需求的数量（计划需求中，自有采购预算 + 合法可用授信买得起的那部分）；
 * - sold / intercityImported：实际成交（本地 + 跨城）；
 * - unmetDemand：有效需求中因缺货/配送不足未成交的数量；
 * - unmetFunding：计划需求中因资金不足未形成有效需求的数量。
 * 三者关系：producerRequired − 实际成交 = unmetDemand + unmetFunding（舍入误差 ≤ 0.01/笔）。
 */
export interface MarketLedger {
  goodId: GoodId;
  supply: number;
  demand: number;
  consumerDemand: number;
  producerRequired: number;
  producerDemand: number;
  sold: number;
  unmetDemand: number;
  unmetFunding: number;
  intercityImported: number;
  externalExport: number;
  spend: number;
  transactionCount: number;
  /** v0.8：本月本地居民消费成交额中的基准消费税（由税收模块结算时累加）。 */
  consumptionTax: number;
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
    producerRequired: 0,
    producerDemand: 0,
    sold: 0,
    unmetDemand: 0,
    unmetFunding: 0,
    intercityImported: 0,
    externalExport: 0,
    spend: 0,
    transactionCount: 0,
    consumptionTax: 0,
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
  // v0.9：设备成交发生在市场账本创建之前或 tick 之间，增量先记在 equipmentMarket.pendingLedger，
  // 这里并入当月账本并清空。sold 同时计入 supply（成交台数来自期初可供库存），保证 sold ≤ supply。
  const pending = world.equipmentMarket?.pendingLedger;
  if (pending && pending.length > 0) {
    for (const entry of pending) {
      const ledger = ledgers[entry.cityId]?.[entry.goodId];
      if (!ledger) continue;
      ledger.demand = round2(ledger.demand + entry.demand);
      ledger.sold = round2(ledger.sold + entry.sold);
      ledger.supply = round2(ledger.supply + entry.sold);
      ledger.intercityImported = round2(ledger.intercityImported + entry.intercityImported);
    }
    world.equipmentMarket.pendingLedger = [];
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
export interface LocalSeller {
  company: Company;
  unitPrice: number;
}

/** 城内可售卖家（按单价升序）；executePurchase / 报价 / 需求记录共用同一套排序。 */
function localMarketSellers(
  world: WorldState,
  city: City,
  goodId: GoodId,
  excludeCompanyId?: string,
): LocalSeller[] {
  const marketPrice = city.market[goodId]?.price ?? 0;
  return world.companies
    .filter(
      (company) =>
        company.cityId === city.id &&
        company.id !== excludeCompanyId &&
        offeredStock(company, goodId) > 1e-9,
    )
    .map((company) => ({
      company,
      unitPrice: Math.max(0.01, round2(marketPrice * company.priceFactor)),
    }))
    .sort((a, b) => a.unitPrice - b.unitPrice || a.company.id.localeCompare(b.company.id));
}

export function executePurchase(
  world: WorldState,
  city: City,
  ledgers: CityLedgers,
  goodId: GoodId,
  desiredQty: number,
  maxSpend: number,
  options: { buyerCompanyId?: string; consumer?: boolean },
  /**
   * v0.8：传入配置后，居民最终消费按含税标价拆分消费税（卖方实收净额、税记入城市）；
   * 企业采购不征消费税。省略时保持旧行为（供未迁移的调用点/测试使用）。
   */
  config?: DemoConfig,
): PurchaseResult {
  const ledger = ledgers[goodId];
  if (!ledger || desiredQty <= 0 || maxSpend <= 0) return { qty: 0, spend: 0 };

  // 城内交通：本月可配送量受上一期配送压力影响（容量不足时低于 1）。
  const deliveryEfficiency = clamp(intracityDeliveryEfficiency(world, city.id), 0, 1);

  const buyer =
    options.buyerCompanyId === undefined
      ? undefined
      : world.companies.find((company) => company.id === options.buyerCompanyId);
  const sellers = localMarketSellers(world, city, goodId, options.buyerCompanyId);

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
    // v0.8：居民消费的含税标价内已包含 5% 消费税。买方仍支付 finalCost（含税），
    // 卖方现金/收入按净额入账，税单独累加并记入消费发生城市（不重复征税、不漏征）。
    const consumerTax =
      options.consumer && !buyer && config ? splitConsumptionTax(finalCost, config).tax : 0;
    const sellerProceeds = round2(finalCost - consumerTax);
    // v1.3：卖方按存货账面移动加权平均成本结转 COGS；买方按实付金额把货物入账为存货资产。
    const soldCost = issueInventory(seller.company, goodId, qty);
    seller.company.lastMonth.cogs = round2((seller.company.lastMonth.cogs ?? 0) + soldCost);
    seller.company.cash = round2(seller.company.cash + sellerProceeds);
    seller.company.lastMonth.revenue = round2(
      seller.company.lastMonth.revenue + sellerProceeds,
    );
    seller.company.lastMonth.sold = round2(
      seller.company.lastMonth.sold + (goodId === seller.company.recipeOutput ? qty : 0),
    );

    if (buyer) {
      buyer.cash = round2(buyer.cash - finalCost);
      receiveInventory(buyer, goodId, qty, finalCost);
      buyer.lastMonth.inputCost = round2(buyer.lastMonth.inputCost + finalCost);
    } else if (options.consumer) {
      // 最终消费：货物离开企业库存后不再进入库存账本。
    } else {
      throw new Error('购买必须指定企业买家或居民最终消费');
    }

    ledger.sold = round2(ledger.sold + qty);
    // ledger.spend 保持买方含税实付口径（居民消费支出含税），税额另记 ledger.consumptionTax。
    ledger.spend = round2(ledger.spend + finalCost);
    ledger.transactionCount += 1;
    if (consumerTax > 0) {
      ledger.consumptionTax = round2(ledger.consumptionTax + consumerTax);
      accrueConsumptionTax(world, city.id, consumerTax);
    }
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
  // 实际成交价按卖家价格系数浮动（可能低于市价）：用最低可售价估算可负担数量，
  // 否则会把“买得起”的需求误记为买不起，留下未成交余量与多余借款。
  const sellers = localMarketSellers(world, city, goodId, buyer.id);
  const best = sellers[0];
  const unitPrice = best ? Math.min(price, best.unitPrice) : price;
  const affordableQty = Math.max(0, maxSpend / Math.max(0.01, unitPrice));
  const effectiveDemand = Math.min(shortage, affordableQty);
  if (effectiveDemand > 0) {
    ledger.producerRequired = round2(ledger.producerRequired + effectiveDemand);
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

export interface LocalQuote {
  /** 在给定预算内可成交的数量。 */
  qty: number;
  /** 成交所需金额（与 executePurchase 的计价、配送效率规则一致）。 */
  cost: number;
}

/**
 * 只报价、不成交：按城内真实成交规则（卖家价格系数、配送效率、预算）估算某数量需要多少钱。
 * 企业采购在放款前用它与授信额度对齐，避免多借贷款、或借了却买不到货。
 */
export function quoteLocalPurchase(
  world: WorldState,
  city: City,
  goodId: GoodId,
  desiredQty: number,
  maxSpend: number,
  excludeCompanyId?: string,
): LocalQuote {
  if (desiredQty <= 0 || maxSpend <= 0) return { qty: 0, cost: 0 };
  const deliveryEfficiency = clamp(intracityDeliveryEfficiency(world, city.id), 0, 1);
  const sellers = localMarketSellers(world, city, goodId, excludeCompanyId);

  let remainingQty = desiredQty;
  let remainingBudget = maxSpend;
  let qty = 0;
  let cost = 0;
  for (const seller of sellers) {
    if (remainingQty <= 1e-9 || remainingBudget <= 0) break;
    const available = round2(offeredStock(seller.company, goodId) * deliveryEfficiency);
    if (available <= 0) continue;
    const affordable = seller.unitPrice > 0 ? remainingBudget / seller.unitPrice : 0;
    let buy = Math.min(remainingQty, available, affordable);
    if (buy <= 1e-9) continue;
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

export function applyConsumerDemand(
  world: WorldState,
  city: City,
  ledgers: CityLedgers,
  goodId: GoodId,
  desiredQty: number,
  config?: DemoConfig,
): PurchaseResult {
  const ledger = ledgers[goodId];
  if (!ledger) return { qty: 0, spend: 0 };
  const price = city.market[goodId]?.price ?? 1;
  const budget = desiredQty * price;
  ledger.consumerDemand = round2(ledger.consumerDemand + desiredQty);
  ledger.demand = round2(ledger.demand + desiredQty);
  const result = executePurchase(
    world,
    city,
    ledgers,
    goodId,
    desiredQty,
    budget,
    { consumer: true },
    config,
  );
  const unmet = Math.max(0, desiredQty - result.qty);
  if (unmet > 0) ledger.unmetDemand = round2(ledger.unmetDemand + unmet);
  return result;
}

/** 中位数；空数组返回 null。 */
function medianOf(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    const left = sorted[middle - 1] ?? 0;
    const right = sorted[middle] ?? 0;
    return (left + right) / 2;
  }
  return sorted[middle] ?? null;
}

/**
 * v1.6 §二：城市某商品的锚价（长期参考价）。
 *
 * 锚价 = clamp(上月单位生产成本中位数 × costAnchorFactor, basePrice, basePrice × costAnchorMaxFactor)。
 * 单位生产成本 = (COGS + 工资 + 设备维护费) ÷ 上月成交单位数，取本城该商品生产者中位数；
 * 没有真实生产数据时锚价就是基础价值。这样真实成本长期上升可以推高锚价，
 * 价格不会被迫长期低于成本；同时锚价上限防止异常成本把价格推飞。
 */
export function priceAnchor(
  world: WorldState,
  cityId: string,
  goodId: GoodId,
  basePrice: number,
  config: DemoConfig,
): number {
  const unitCosts: number[] = [];
  for (const company of world.companies) {
    if (company.cityId !== cityId || company.recipeOutput !== goodId) continue;
    const prev = company.previousMonth;
    if (!prev || prev.sold <= 0) continue;
    // 维护费字段由 v1.6 §四 维护费模块写入；旧夹具没有该字段时按 0 处理。
    const maintenancePaid = (prev as CompanyMonthlyStats & { maintenancePaid?: number })
      .maintenancePaid;
    const cost = (prev.cogs ?? prev.inputCost ?? 0) + prev.wagesPaid + (maintenancePaid ?? 0);
    if (!(cost > 0)) continue;
    unitCosts.push(cost / prev.sold);
  }
  const medianCost = medianOf(unitCosts);
  if (medianCost === null) return basePrice;
  return clamp(
    medianCost * config.market.costAnchorFactor,
    basePrice,
    basePrice * config.market.costAnchorMaxFactor,
  );
}

/** 本城本月该商品的可售卖家数（竞争程度）。 */
function localSellerCount(world: WorldState, cityId: string, goodId: GoodId): number {
  let count = 0;
  for (const company of world.companies) {
    if (company.cityId === cityId && offeredStock(company, goodId) > 1e-9) count += 1;
  }
  return count;
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
      const market = config.market;

      // 缺口只算“真的缺货”：unmetDemand 已由跨城进口冲销（本地成交 + 进口都没补上的部分），
      // 居民买不起的 unmetFunding 不在 demand 里，不会推高价格。
      const shortageRatio =
        ledger.demand > 1e-6 ? clamp(Math.max(0, ledger.unmetDemand) / ledger.demand, 0, 1) : 0;
      // 过剩用“成交覆盖量”（本地成交 + 跨城进口）衡量，而不是只看本地成交。
      const coverageQty = Math.max(1, ledger.sold + ledger.intercityImported);
      const surplusRatio = clamp(
        Math.max(0, closingStock - coverageQty * market.stockSurplusThreshold) / coverageQty,
        0,
        2,
      );
      const anchor = priceAnchor(world, city.id, goodId, good.basePrice, config);
      const priceForChange = oldPrice > 1e-9 ? oldPrice : good.basePrice;
      const premium = clamp(priceForChange / Math.max(0.01, anchor) - 1, 0, 1);
      const sellerCount = localSellerCount(world, city.id, goodId);

      let change = shortageRatio * market.shortageRiseSpeed;
      change -= Math.min(surplusRatio * market.surplusFallSpeed, market.maxMonthlyChange);
      if (sellerCount > 1 && premium > 0) {
        change -=
          clamp((sellerCount - 1) / 6, 0, 1) * premium * market.competitionFallSpeed;
      }
      const deviation = anchor / Math.max(0.01, priceForChange) - 1;
      // 高于锚价时向下回归；低于锚价时只有存在真实需求或成本压力才向上回归。
      if (deviation < 0 || ledger.demand > 0 || shortageRatio > 0) {
        change += clamp(deviation, -1, 1) * market.reversionSpeed;
      }
      change = clamp(change, -market.maxMonthlyChange, market.maxMonthlyChange);

      const newPrice = round2(
        clamp(
          priceForChange * (1 + change),
          good.basePrice * market.minPriceFactor,
          good.basePrice * market.maxPriceFactor,
        ),
      );

      const next: MarketState = {
        goodId,
        price: newPrice,
        supply: round2(ledger.supply),
        demand: round2(ledger.demand),
        consumerDemand: round2(ledger.consumerDemand),
        producerRequired: round2(ledger.producerRequired),
        producerDemand: round2(ledger.producerDemand),
        sold: round2(ledger.sold),
        unmetDemand: round2(ledger.unmetDemand),
        unmetFunding: round2(ledger.unmetFunding),
        intercityImported: round2(ledger.intercityImported),
        externalExport: round2(ledger.externalExport),
        closingStock,
        consumptionTax: round2(ledger.consumptionTax),
        lastPriceChangePct: oldPrice === 0 ? 0 : round2((newPrice / oldPrice - 1) * 10000) / 100,
      };
      city.market[goodId] = next;
    }
  }
}
