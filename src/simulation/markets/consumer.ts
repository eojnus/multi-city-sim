import type { City, GoodId, WorldState } from '../contracts/types';
import type { DemoConfig } from '../../data/config';
import { GOODS } from '../../data/demo-data';
import type { CityLedgers } from './markets';
import { applyConsumerDemand } from './markets';
import { executeIntercityPurchase } from './intercity';
import { householdGroupWeights } from '../population/population';
import { clamp, round2 } from '../core/math';

export interface ConsumerResult {
  budget: number;
  spend: number;
  desiredCost: number;
  affordability: number;
  bought: Record<GoodId, number>;
  unmet: Record<GoodId, number>;
}

/**
 * 居民消费需求。先按人口群体、人均需要和价格弹性求期望数量，
 * 再用本月可支配预算统一缩放，保证有效需求不超过购买能力。
 */
export function runConsumerMarket(
  world: WorldState,
  city: City,
  ledgers: CityLedgers,
  config: DemoConfig,
): ConsumerResult {
  const budget = Math.max(0, city.householdIncomeLastMonth * config.consumer.propensity);
  const weights = householdGroupWeights(city, config);
  const consumerGoods = GOODS.filter((good) => good.category === 'consumer');

  const desired = new Map<GoodId, number>();
  let desiredCost = 0;
  for (const good of consumerGoods) {
    const price = city.market[good.id]?.price ?? good.basePrice;
    const elasticity = Math.pow(good.basePrice / Math.max(0.01, price), config.consumer.priceElasticity);
    const qty = round2(weights.total * good.perCapitaMonthlyNeed * clamp(elasticity, 0.55, 1.85));
    desired.set(good.id, qty);
    desiredCost += qty * price;
  }

  const affordability = desiredCost <= 0 ? 1 : clamp(budget / desiredCost, 0, 1);
  const bought = {} as Record<GoodId, number>;
  const unmet = {} as Record<GoodId, number>;
  let spend = 0;
  for (const good of GOODS) {
    bought[good.id] = 0;
    unmet[good.id] = 0;
  }

  for (const good of consumerGoods) {
    const qty = round2((desired.get(good.id) ?? 0) * affordability);
    if (qty <= 0) continue;
    const price = city.market[good.id]?.price ?? good.basePrice;
    const local = applyConsumerDemand(world, city, ledgers, good.id, qty);
    let boughtQty = local.qty;
    let localSpend = local.spend;
    const remainingBudget = Math.max(0, qty * price - local.spend);
    if (local.qty < qty - 1e-6 && remainingBudget > 0) {
      const imported = executeIntercityPurchase(
        world,
        city,
        ledgers,
        good.id,
        qty - local.qty,
        remainingBudget,
        { consumer: true },
        config,
      );
      boughtQty += imported.qty;
      localSpend += imported.spend;
      const ledger = ledgers[good.id];
      if (ledger) {
        ledger.unmetDemand = round2(Math.max(0, ledger.unmetDemand - imported.qty));
      }
    }
    bought[good.id] = round2(boughtQty);
    unmet[good.id] = round2(Math.max(0, qty - boughtQty));
    spend += localSpend;
  }

  return {
    budget: round2(budget),
    spend: round2(spend),
    desiredCost: round2(desiredCost),
    affordability: round2(affordability * 1000) / 1000,
    bought,
    unmet,
  };
}
