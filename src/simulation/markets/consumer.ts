import type { City, GoodId, OccupationClass, WorldState } from '../contracts/types';
import type { DemoConfig } from '../../data/config';
import { GOODS } from '../../data/demo-data';
import type { CityLedgers } from './markets';
import { applyConsumerDemand, offeredStock } from './markets';
import { executeIntercityPurchase } from './intercity';
import { householdGroupsOfCity } from '../population/household-groups';
import { recordGroupConsumption } from '../population/household-economy';
import {
  borrowForConsumption,
  householdConsumerBudgetSnapshot,
} from '../population/household-finance';
import { clamp, round2 } from '../core/math';

/** 单个居民群体的本月消费结果（四层口径：期望→资金有效→成交→缺口）。 */
export interface ConsumerGroupResult {
  /** 现金预算（不含可借额度，DECISIONS #26）。 */
  budget: number;
  spend: number;
  desiredCost: number;
  bought: Record<GoodId, number>;
  /** 因供给/配送不足而未满足（不含资金缺口）。 */
  unmet: Record<GoodId, number>;
  /** 本月可借消费贷额度（单列，不进入有效需求，失败或缺省为 0）。 */
  loanAvailable?: number;
  /** 由消费贷款支持的成交额（真实债务，不计收入）。 */
  loanFinanced?: number;
  /** 因资金不足（含贷款额度不足）而未满足的消费成本。 */
  unmetFunding?: number;
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

/** 本城某商品当前可售（未预留生产投入）的库存数量。用于“先确认供给再放款”。 */
function localAvailableQty(world: WorldState, city: City, goodId: GoodId): number {
  let total = 0;
  for (const company of world.companies) {
    if (company.cityId !== city.id) continue;
    total += offeredStock(company, goodId);
  }
  return round2(Math.max(0, total));
}

/**
 * 居民消费需求（四层口径，DECISIONS #39/#40/#26）。
 *
 * 1) 期望需求：按人口、人均需要、就业系数与价格弹性计算；
 * 2) 资金有效需求：以现金预算（上月可支配收入×0.8 + 现金×0.05，且不超过现金）缩放；
 * 3) 成交：先本地后跨城；现金不足但仍有可借额度、且本地确有供给时，先确认供给再放款补足；
 * 4) 缺口分账：供给/配送不足记 unmet，资金不足（含可借额度不足）记 unmetFunding。
 *
 * 贷款是真实债务，资金从银行支付给卖方，不计入居民收入；不借超过已确认供给的资金。
 * 群体按人均预算升序处理，让预算更紧的群体优先获得本地有限供给。
 */
export function runConsumerMarket(
  world: WorldState,
  city: City,
  ledgers: CityLedgers,
  config: DemoConfig,
): ConsumerResult {
  const tick = world.time.tick;
  const consumerGoods = GOODS.filter((good) => good.category === 'consumer');
  const orderedGroups = householdGroupsOfCity(world, city.id)
    .map((group) => ({
      group,
      // 先扣当月到期贷款，再给出现金预算；可借额度单列（不进入有效需求）。
      snapshot: householdConsumerBudgetSnapshot(world, group, config, tick),
    }))
    .sort((a, b) => {
      const perCapitaA =
        a.group.people > 0 ? a.snapshot.cashBudget / a.group.people : Number.POSITIVE_INFINITY;
      const perCapitaB =
        b.group.people > 0 ? b.snapshot.cashBudget / b.group.people : Number.POSITIVE_INFINITY;
      if (perCapitaA !== perCapitaB) return perCapitaA < perCapitaB ? -1 : 1;
      return a.group.id.localeCompare(b.group.id);
    });

  const totalBought = emptyGoodsRecord();
  const totalUnmet = emptyGoodsRecord();
  const byGroup: Record<string, ConsumerGroupResult> = {};
  let totalBudget = 0;
  let totalSpend = 0;
  let totalDesiredCost = 0;

  for (const { group, snapshot } of orderedGroups) {
    const budget = snapshot.cashBudget;
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
    // 2) 资金有效需求：低于 minAffordability 时仍保留最低有效需求，下面用预算硬封顶。
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
      // 3) 成交：现金预算内先本地、再跨城。
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
      if (boughtQty < effectiveQty - 1e-6) {
        groupUnmet[good.id] = round2(effectiveQty - boughtQty);
      }
    }

    // 4) 缺口分账 + 消费贷补足：只在本地确有供给时放款，且不借超过已确认供给的资金。
    let loanFinanced = 0;
    const loanAvailable = snapshot.loanAvailable;
    if (loanAvailable > 0) {
      const gapCostByGood = new Map<GoodId, { price: number; supplyQty: number }>();
      let financeableCost = 0;
      for (const good of consumerGoods) {
        const price = city.market[good.id]?.price ?? good.basePrice;
        const effectiveQty = round2((desiredQty.get(good.id) ?? 0) * affordability);
        const gapQty = round2(Math.max(0, effectiveQty - (groupBought[good.id] ?? 0)));
        // 先确认供给：只对本地实际可售的部分放款，供给不足不借多余资金。
        const supplyQty = round2(Math.min(gapQty, localAvailableQty(world, city, good.id)));
        if (supplyQty <= 0) continue;
        gapCostByGood.set(good.id, { price, supplyQty });
        financeableCost = round2(financeableCost + supplyQty * price);
      }
      const financeBudget = Math.min(loanAvailable, financeableCost);
      if (financeBudget >= config.households.householdCredit.minLoanAmount) {
        let remaining = financeBudget;
        const purchases = [...gapCostByGood.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([goodId, entry]) => {
            const qty = round2(
              Math.max(0, Math.min(entry.supplyQty, Math.floor((remaining / entry.price) * 100) / 100)),
            );
            const cost = round2(qty * entry.price);
            remaining = round2(remaining - cost);
            return { goodId, qty, cost };
          })
          .filter((entry) => entry.qty > 0);
        const plannedCost = round2(purchases.reduce((total, entry) => total + entry.cost, 0));
        if (plannedCost >= config.households.householdCredit.minLoanAmount) {
          // 先确认供给并在本地成交，再按实际成交额放款（不借超过实际卖出额的资金）。
          let actualSpend = 0;
          for (const purchase of purchases) {
            const bought = applyConsumerDemand(world, city, ledgers, purchase.goodId, purchase.qty);
            loanFinanced = round2(loanFinanced + bought.spend);
            actualSpend = round2(actualSpend + bought.spend);
            groupBought[purchase.goodId] = round2(
              (groupBought[purchase.goodId] ?? 0) + bought.qty,
            );
          }
          if (actualSpend > 0) {
            const amount = Math.max(actualSpend, config.households.householdCredit.minLoanAmount);
            const loan = borrowForConsumption(world, group, config, amount, tick);
            if (loan.ok) {
              // 借到但未花掉的零头（最低金额/尾差）留在群体现金，仍是真实债务。
              void loan;
            } else {
              // 理论上预检已排除失败（额度、笔数）；若仍失败，这部分支出回滚不可行，
              // 记录日志并让现金缺口暴露给不变量，而不是静默借新钱。
              world.log.push({
                tick,
                kind: 'warning',
                message: `${group.name} 的消费贷放款失败：${loan.error ?? '未知原因'}（已成交 ${actualSpend.toFixed(2)}）。`,
              });
            }
          }
        }
      }
    }

    // 缺口按“现在还有没有本地供给”分账：有供给但没钱→资金缺口；没供给→供给缺口。
    let unmetFunding = 0;
    for (const good of consumerGoods) {
      const price = city.market[good.id]?.price ?? good.basePrice;
      const effectiveQty = round2((desiredQty.get(good.id) ?? 0) * affordability);
      const gapQty = round2(Math.max(0, effectiveQty - (groupBought[good.id] ?? 0)));
      if (gapQty <= 0) {
        groupUnmet[good.id] = 0;
        continue;
      }
      const localQty = round2(Math.min(gapQty, localAvailableQty(world, city, good.id)));
      const supplyShortfall = round2(gapQty - localQty);
      groupUnmet[good.id] = supplyShortfall;
      unmetFunding = round2(unmetFunding + localQty * price);
    }
    groupSpend = round2(groupSpend + loanFinanced);

    // 逐群体扣款并记录“想要购买”的成本（贷款已入账，扣款不超出现金）。
    const paid = recordGroupConsumption(
      world,
      city,
      group.id,
      round2(groupSpend),
      round2(groupDesiredCost),
    );
    group.lastMonth.loanFinancedConsumption = round2(
      (group.lastMonth.loanFinancedConsumption ?? 0) + loanFinanced,
    );
    group.lastMonth.unmetFunding = round2((group.lastMonth.unmetFunding ?? 0) + unmetFunding);
    byGroup[group.id] = {
      budget: round2(budget),
      spend: round2(paid),
      desiredCost: round2(groupDesiredCost),
      bought: groupBought,
      unmet: groupUnmet,
      loanAvailable: round2(loanAvailable),
      loanFinanced: round2(loanFinanced),
      unmetFunding: round2(unmetFunding),
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
