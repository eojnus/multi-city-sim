import type { Company, WorldState } from '../contracts/types';
import type { DemoConfig } from '../../data/config';
import { clamp, round2 } from '../core/math';
import { companyUnitCost } from './cost';
import { payableShortageFromMarket } from './production-plan';

/**
 * v1.6 §三：企业真实报价竞争。
 *
 * 报价口径必须与市场成交完全一致：`unitPrice = round2(市场价 × priceFactor)`，且不低于
 * 0.01（见 markets.localMarketSellers / intercity.intercityOffers）。市场按单价升序
 * 逐家成交，因此更低的报价自然获得更多订单——本模块只负责“把 priceFactor 调到有竞争力
 * 且不亏本的水平”，不直接决定成交量。
 *
 * 关键修复（v1.6）：
 * - 内部 priceFactor 保留 6 位小数（原先每步 round2 到 2 位，0.25% 的风格偏移会被舍入
 *   吞掉，价格从未真正变动）。展示/成交仍按分舍入，由市场模块完成。
 * - 每月变动至少 1 分钱（minVisiblePriceStep），否则同样会被成交价的 round2 吞掉。
 * - 结果夹在 [priceBiasMin, priceBiasMax] × 市场价内，且不低于单位成本底线，不会出现
 *   负价、0 价或失控价。
 */

/** 与市场成交同一计算公式的报价（市场模块按分舍入；这里保持一致供比较）。 */
export function quotedUnitPrice(marketPrice: number, priceFactor: number): number {
  const base = Math.max(0.01, marketPrice);
  const factor = Number.isFinite(priceFactor) && priceFactor > 0 ? priceFactor : 1;
  return Math.max(0.01, round2(base * factor));
}

export interface PriceDecision {
  /** 内部高精度价格系数（6 位小数）。 */
  priceFactor: number;
  /** 本月对外报价（市场价 × 系数，按分舍入）。 */
  quotedPrice: number;
  /** 上月对外报价（用于展示变动）。 */
  previousPrice: number;
  marketPrice: number;
  /** 单位变动成本（原料 + 工资 + 维护费），用于成本底线。 */
  unitCost: number;
  /** 最低的同类对手报价（本地 + 可达跨城加成后），没有对手时为 null。 */
  competitorPrice: number | null;
  reasons: string[];
}

/** 同城同产出企业的报价（与市场排序口径一致）。 */
function localCompetitorQuotes(
  world: WorldState,
  company: Company,
  marketPrice: number,
): number[] {
  return world.companies
    .filter(
      (peer) =>
        peer.id !== company.id &&
        peer.cityId === company.cityId &&
        peer.recipeOutput === company.recipeOutput,
    )
    .map((peer) => quotedUnitPrice(marketPrice, peer.priceFactor))
    .filter((price) => price > 0);
}

/**
 * 可达跨城对手报价：其他城市同产出的报价 + 运输加成（与 intercity.intercityOffers
 * 同一公式）。只用于判断“本地报价相对跨城补给是否有竞争力”，不改变跨城成交规则。
 */
function intercityCompetitorQuotes(
  world: WorldState,
  company: Company,
  marketPrice: number,
  config: DemoConfig,
): number[] {
  if (!config.intercity.enabled) return [];
  const buyerCity = world.cities.find((entry) => entry.id === company.cityId);
  if (!buyerCity) return [];
  const quotes: number[] = [];
  for (const peer of world.companies) {
    if (peer.cityId === company.cityId || peer.recipeOutput !== company.recipeOutput) continue;
    const peerCity = world.cities.find((entry) => entry.id === peer.cityId);
    if (!peerCity) continue;
    const km = Math.sqrt(
      (buyerCity.region.x - peerCity.region.x) ** 2 + (buyerCity.region.y - peerCity.region.y) ** 2,
    ) * 0.35;
    const markup = clamp(
      km * config.intercity.transportMarkupPerKm,
      config.intercity.minMarkup,
      config.intercity.maxMarkup,
    );
    quotes.push(quotedUnitPrice(marketPrice, peer.priceFactor * (1 + markup)));
  }
  return quotes;
}

/**
 * 计算下月价格系数与报价。
 *
 * 调整逻辑（每一步都有可解释原因，供 AI 决策日志与界面展示）：
 * 1. 基准 = 市场价 × 当前系数，然后向市场价缓慢回归（避免风格偏移无限累积）；
 * 2. 缺货且库存低 → 加价；积压/销量下滑 → 降价；
 * 3. 有同城对手报价更低且本城无缺货 → 让价到对手之下 1%（不低于成本底线）；
 * 4. 成本底线：不低于单位成本 ×（1 + 最低毛利）；
 * 5. 单月变动限幅 + 绝对上下限 + 最小可见变动（1 分钱）。
 */
export function planCompanyPrice(
  world: WorldState,
  company: Company,
  config: DemoConfig,
): PriceDecision {
  const city = world.cities.find((entry) => entry.id === company.cityId);
  const output = company.recipeOutput;
  const basePrice = Math.max(0.01, city?.market[output]?.price ?? 1);
  const pricing = config.companyAi.pricing;
  const style = company.ai?.style ?? 'steady';
  const styleBias = config.companyAi.styles[style].priceBias;

  const currentFactor = Number.isFinite(company.priceFactor) && company.priceFactor > 0
    ? company.priceFactor
    : 1;
  const currentPrice = quotedUnitPrice(basePrice, currentFactor);
  const market = city?.market[output];
  const shortage = city ? payableShortageFromMarket(market, output) : 0;
  const stock = Math.max(0, company.inventory[output] ?? 0);
  const plan = company.productionPlan;
  const salesReference = Math.max(
    0,
    plan?.salesReference ??
      (company.salesHistory?.length
        ? company.salesHistory.reduce((sum, entry) => sum + entry, 0) / company.salesHistory.length
        : (company.previousMonth?.sold ?? 0) + (company.previousMonth?.exported ?? 0)),
  );
  const stockMonths =
    salesReference > 0.01 ? stock / salesReference : stock > 0.01 ? Number.POSITIVE_INFINITY : 0;
  const lastSold = (company.previousMonth?.sold ?? 0) + (company.previousMonth?.exported ?? 0);
  const salesFalling = salesReference > 0.01 && lastSold < salesReference * 0.85;
  const overstocked =
    salesReference > 0.01 &&
    stock > config.production.plan.stuckInventoryMonths * salesReference;
  const understocked =
    shortage > 0.01 && stockMonths <= Math.max(0.5, config.production.plan.targetInventoryMonths);
  const unit = companyUnitCost(world, company, config);
  const costFloor = unit.total > 0.01 ? unit.total * (1 + pricing.minUnitMargin) : 0;

  const reasons: string[] = [];
  // 1) 基准：向市场价缓慢回归（风格偏置决定长期偏离方向）。
  const referenceFactor =
    1 + (currentFactor - 1) * (1 - clamp(pricing.reversionSpeed, 0, 1)) + styleBias * 0.25;
  let target = Math.max(0.01, basePrice * referenceFactor);

  // 2) 供需/库存信号
  if (understocked) {
    target *= 1 + pricing.shortageMarkup;
    reasons.push(
      `本城可支付缺货 ${round2(shortage).toFixed(0)}、成品库存约 ${Number.isFinite(stockMonths) ? stockMonths.toFixed(2) : '∞'} 个月销量：短缺加价 ${(pricing.shortageMarkup * 100).toFixed(1)}%`,
    );
  } else if (overstocked) {
    target *= 1 - pricing.surplusDiscount;
    reasons.push(
      `成品库存约 ${stockMonths.toFixed(2)} 个月销量（超过 ${config.production.plan.stuckInventoryMonths} 个月）：积压降价 ${(pricing.surplusDiscount * 100).toFixed(1)}%`,
    );
  } else if (salesFalling) {
    target *= 1 - pricing.salesDropDiscount;
    reasons.push(
      `上月销量 ${round2(lastSold).toFixed(0)} 低于销售参考 ${round2(salesReference).toFixed(0)}：小幅降价 ${(pricing.salesDropDiscount * 100).toFixed(1)}%`,
    );
  }

  // 3) 对手报价：本城无缺货且对手更便宜时跟随让价，避免把订单让给对手。
  const competitorQuotes = [
    ...localCompetitorQuotes(world, company, basePrice),
    ...intercityCompetitorQuotes(world, company, basePrice, config),
  ];
  const competitorPrice = competitorQuotes.length > 0 ? Math.min(...competitorQuotes) : null;
  if (competitorPrice !== null && shortage <= 0.01) {
    // 已积压：必须让价；正常且无缺货：只在明显高于对手时跟随。
    const threshold = overstocked ? 1.0 : 1.02;
    if (target > competitorPrice * threshold) {
      target = competitorPrice * (1 - pricing.undercut);
      reasons.push(
        `同类对手最低报价 ${competitorPrice.toFixed(2)} 低于本企业报价 ${currentPrice.toFixed(2)}：让价 ${(pricing.undercut * 100).toFixed(1)}% 争取订单`,
      );
    }
  }

  // 4) 成本底线（有真实成本数据时才启用，避免把测试/旧档的空成本当成本）。
  if (costFloor > 0.01) {
    if (target < costFloor) {
      target = costFloor;
      reasons.push(
        `报价低于单位成本 ${unit.total.toFixed(2)} × (1+${(pricing.minUnitMargin * 100).toFixed(1)}%)：上调至成本底线 ${costFloor.toFixed(2)}`,
      );
    }
  }

  // 5) 单月变动限幅 + 绝对上下限（不允许负价/失控价）。
  const moveCap = Math.max(0, pricing.maxMonthlyMove);
  target = clamp(target, currentPrice * (1 - moveCap), currentPrice * (1 + moveCap));
  const minFactor = Math.max(0.01, config.companyAi.priceBiasMin);
  const maxFactor = Math.max(minFactor, config.companyAi.priceBiasMax);
  target = clamp(target, basePrice * minFactor, basePrice * maxFactor);
  target = Math.max(0.01, target);

  // 6) 最小可见变动：成交价按分舍入，变动不足 1 分钱等于没调价，强制到 1 分钱。
  // 用未舍入的差值判断方向，避免 0.005 这类“半个分位”被 Math.round 舍成 0。
  const rawDelta = target - currentPrice;
  if (Math.abs(rawDelta) > 1e-9 && Math.abs(rawDelta) < pricing.minVisiblePriceStep) {
    const direction = rawDelta > 0 ? 1 : -1;
    target = Math.max(
      0.01,
      clamp(
        round2(currentPrice + direction * pricing.minVisiblePriceStep),
        basePrice * minFactor,
        basePrice * maxFactor,
      ),
    );
  }

  // 7) 高精度系数：按分报价可由 factor 精确还原；再夹一次防止浮点溢出。
  const priceFactor = clamp(round2((target / basePrice) * 1_000_000) / 1_000_000, minFactor, maxFactor);
  const quotedPrice = quotedUnitPrice(basePrice, priceFactor);
  if (quotedPrice <= 0 || !Number.isFinite(quotedPrice)) {
    // 理论不可达：保底维持上月系数，保证不出现 0/负价。
    return {
      priceFactor: currentFactor,
      quotedPrice: currentPrice,
      previousPrice: currentPrice,
      marketPrice: basePrice,
      unitCost: unit.total,
      competitorPrice,
      reasons: ['报价异常：维持上月报价'],
    };
  }
  if (reasons.length === 0) {
    reasons.push(
      `无短缺/积压信号：报价 ${quotedPrice.toFixed(2)}（市场价 ${basePrice.toFixed(2)}，${style === 'growth' ? '扩张型偏低价' : style === 'return' ? '回报型偏高报价' : '稳健型跟随市场'}）`,
    );
  }
  return {
    priceFactor,
    quotedPrice,
    previousPrice: currentPrice,
    marketPrice: basePrice,
    unitCost: unit.total,
    competitorPrice,
    reasons,
  };
}
