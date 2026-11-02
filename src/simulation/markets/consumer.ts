import type { City, GoodId, OccupationClass, WorldState } from '../contracts/types';
import type { DemoConfig } from '../../data/config';
import { GOODS } from '../../data/demo-data';
import type { CityLedgers } from './markets';
import { applyConsumerDemand } from './markets';
import { executeIntercityPurchase } from './intercity';
import { householdGroupsOfCity } from '../population/household-groups';
import { householdGroupBudget, recordGroupConsumption } from '../population/household-economy';
import { clamp, round2 } from '../core/math';

/** 单个居民群体的本月消费结果。 */
export interface ConsumerGroupResult {
  budget: number;
  spend: number;
  desiredCost: number;
  bought: Record<GoodId, number>;
  unmet: Record<GoodId, number>;
}

export interface ConsumerResult {
  budget: number;
  spend: number;
  desiredCost: number;
  affordability: number;
  bought: Record<GoodId, number>;
  unmet: Record<GoodId, number>;
  /** v0.5：按居民群体拆分的消费明细（key = householdGroupId）。 */
  byGroup?: Record<string, ConsumerGroupResult>;
}

/** 群体的消费需要系数：就业群体（含公共部门）最高，失业与非劳动力更低。 */
function groupNeedFactor(occupation: OccupationClass, config: DemoConfig): number {
  switch (occupation) {
    case 'unemployed':
      return config.consumer.unemployedNeedFactor;
    case 'nonLabor':
      return config.consumer.nonLaborNeedFactor;
    default:
      return config.consumer.employedNeedFactor;
  }
}

function emptyGoodsRecord(): Record<GoodId, number> {
  const record = {} as Record<GoodId, number>;
  for (const good of GOODS) record[good.id] = 0;
  return record;
}

/**
 * 居民消费需求。v0.5：按居民群体逐群体结算——每个群体有自己独立的预算
 * （上月收入 × 消费倾向，且不超过该群体手头现金），群体之间不挪用资金；
 * 需求先本地成交、不足再跨城采购，并按群体记账（跨城交易带上 groupId 以便退款归属）。
 * 群体按人均预算升序处理，让预算更紧的群体优先获得本地有限供给。
 */
export function runConsumerMarket(
  world: WorldState,
  city: City,
  ledgers: CityLedgers,
  config: DemoConfig,
): ConsumerResult {
  const consumerGoods = GOODS.filter((good) => good.category === 'consumer');
  const orderedGroups = householdGroupsOfCity(world, city.id)
    .map((group) => ({ group, budget: householdGroupBudget(world, city, group, config) }))
    .sort((a, b) => {
      const perCapitaA = a.group.people > 0 ? a.budget / a.group.people : Number.POSITIVE_INFINITY;
      const perCapitaB = b.group.people > 0 ? b.budget / b.group.people : Number.POSITIVE_INFINITY;
      if (perCapitaA !== perCapitaB) return perCapitaA < perCapitaB ? -1 : 1;
      return a.group.id.localeCompare(b.group.id);
    });

  const totalBought = emptyGoodsRecord();
  const totalUnmet = emptyGoodsRecord();
  const byGroup: Record<string, ConsumerGroupResult> = {};
  let totalBudget = 0;
  let totalSpend = 0;
  let totalDesiredCost = 0;

  for (const { group, budget } of orderedGroups) {
    const groupBought = emptyGoodsRecord();
    const groupUnmet = emptyGoodsRecord();
    const desiredQty = new Map<GoodId, number>();
    let groupDesiredCost = 0;
    for (const good of consumerGoods) {
      const price = city.market[good.id]?.price ?? good.basePrice;
      const elasticity = Math.pow(
        good.basePrice / Math.max(0.01, price),
        config.consumer.priceElasticity,
      );
      const qty = round2(
        group.people *
          good.perCapitaMonthlyNeed *
          groupNeedFactor(group.occupation, config) *
          clamp(elasticity, 0.55, 1.85),
      );
      desiredQty.set(good.id, qty);
      groupDesiredCost += qty * price;
    }
    // 该群体自身购买力：低于 minAffordability 时仍保留最低有效需求，但下面会用预算硬封顶。
    const affordability =
      groupDesiredCost <= 0
        ? 1
        : clamp(budget / groupDesiredCost, config.consumer.minAffordability, 1);
    let groupSpend = 0;
    let remainingBudget = budget;
    for (const good of consumerGoods) {
      const price = city.market[good.id]?.price ?? good.basePrice;
      const effectiveQty = round2((desiredQty.get(good.id) ?? 0) * affordability);
      if (effectiveQty <= 0) continue;
      // 再按该群体剩余预算封顶，确保本群体支出不超过自身预算（也不动其他群体的现金）。
      const affordableQty =
        remainingBudget > 0
          ? Math.floor((remainingBudget / Math.max(0.01, price)) * 100) / 100
          : 0;
      const qty = round2(Math.min(effectiveQty, affordableQty));
      if (qty <= 0) {
        groupUnmet[good.id] = round2(effectiveQty);
        continue;
      }
      const local = applyConsumerDemand(world, city, ledgers, good.id, qty);
      let boughtQty = local.qty;
      let spent = local.spend;
      const remainingForGood = Math.max(
        0,
        Math.min(remainingBudget - spent, qty * price - spent),
      );
      if (local.qty < qty - 1e-6 && remainingForGood > 0) {
        const imported = executeIntercityPurchase(
          world,
          city,
          ledgers,
          good.id,
          round2(qty - local.qty),
          remainingForGood,
          { consumer: true, householdGroupId: group.id },
          config,
        );
        boughtQty += imported.qty;
        spent += imported.spend;
        const ledger = ledgers[good.id];
        if (ledger) {
          ledger.unmetDemand = round2(Math.max(0, ledger.unmetDemand - imported.qty));
        }
      }
      remainingBudget = round2(Math.max(0, remainingBudget - spent));
      groupSpend += spent;
      groupBought[good.id] = round2(boughtQty);
      groupUnmet[good.id] = round2(Math.max(0, effectiveQty - boughtQty));
    }
    // 逐群体扣款并记录“想要购买”的成本；返回值是实际扣款额（不超过该群体现金）。
    const paid = recordGroupConsumption(
      world,
      city,
      group.id,
      round2(groupSpend),
      round2(groupDesiredCost),
    );
    byGroup[group.id] = {
      budget: round2(budget),
      spend: round2(paid),
      desiredCost: round2(groupDesiredCost),
      bought: groupBought,
      unmet: groupUnmet,
    };
    totalBudget += budget;
    totalSpend += paid;
    totalDesiredCost += groupDesiredCost;
    for (const good of GOODS) {
      totalBought[good.id] = round2((totalBought[good.id] ?? 0) + (groupBought[good.id] ?? 0));
      totalUnmet[good.id] = round2((totalUnmet[good.id] ?? 0) + (groupUnmet[good.id] ?? 0));
    }
  }

  return {
    budget: round2(totalBudget),
    spend: round2(totalSpend),
    desiredCost: round2(totalDesiredCost),
    affordability:
      totalDesiredCost <= 0
        ? 1
        : round2(clamp(totalSpend / totalDesiredCost, 0, 1) * 1000) / 1000,
    bought: totalBought,
    unmet: totalUnmet,
    byGroup,
  };
}
