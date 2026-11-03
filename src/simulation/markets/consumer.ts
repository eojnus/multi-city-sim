import type {
  City,
  Company,
  GoodId,
  HouseholdGroup,
  OccupationClass,
  WorldState,
} from '../contracts/types';
import type { DemoConfig } from '../../data/config';
import { GOODS } from '../../data/demo-data';
import type { CityLedgers } from './markets';
import {
  applyConsumerDemand,
  executePurchase,
  offeredStock,
  quoteLocalPurchase,
} from './markets';
import { executeIntercityPurchase } from './intercity';
import { householdGroupsOfCity } from '../population/household-groups';
import { recordGroupConsumption } from '../population/household-economy';
import {
  borrowForConsumption,
  consumptionLoanEligibility,
  householdConsumerBudgetSnapshot,
} from '../population/household-finance';
import { clamp, round2 } from '../core/math';
import { taxAccrualOf } from '../government/taxes';

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
 * 贷款补足成交前的城内市场快照（v0.7 验收问题 3：交易与放款必须原子一致）。
 * 记录所有可能被 executePurchase 改写的字段：卖方库存/现金/收入/销量、市场账本。
 * 正常路径下报价与成交额一致、预检已通过，不需要回滚；这是放款失败/报价漂移时的兜底。
 */
interface StagedSalesSnapshot {
  companies: {
    company: Company;
    cash: number;
    revenue: number;
    sold: number;
    inventory: Map<GoodId, number>;
  }[];
  ledgers: {
    goodId: GoodId;
    consumerDemand: number;
    demand: number;
    sold: number;
    spend: number;
    transactionCount: number;
    unmetDemand: number;
    /** v0.8：本地消费产生的基准消费税（回滚时一并撤销）。 */
    consumptionTax: number;
  }[];
  /** v0.8：该城本月累计消费税，回滚时恢复，避免留下没有成交的税。 */
  cityConsumptionTaxAccrual: number;
}

function captureStagedSales(
  world: WorldState,
  city: City,
  ledgers: CityLedgers,
  goodIds: GoodId[],
): StagedSalesSnapshot {
  const snapshot: StagedSalesSnapshot = {
    companies: [],
    ledgers: [],
    cityConsumptionTaxAccrual: taxAccrualOf(world, city.id).consumptionTax,
  };
  for (const company of world.companies) {
    if (company.cityId !== city.id) continue;
    const inventory = new Map<GoodId, number>();
    for (const goodId of goodIds) inventory.set(goodId, company.inventory[goodId] ?? 0);
    snapshot.companies.push({
      company,
      cash: company.cash,
      revenue: company.lastMonth.revenue,
      sold: company.lastMonth.sold,
      inventory,
    });
  }
  for (const goodId of goodIds) {
    const ledger = ledgers[goodId];
    if (!ledger) continue;
    snapshot.ledgers.push({
      goodId,
      consumerDemand: ledger.consumerDemand,
      demand: ledger.demand,
      sold: ledger.sold,
      spend: ledger.spend,
      transactionCount: ledger.transactionCount,
      unmetDemand: ledger.unmetDemand,
      consumptionTax: ledger.consumptionTax,
    });
  }
  return snapshot;
}

/** 完整撤销 captureStagedSales 之后的所有城内成交变化（不放款时不得留下虚假成交）。 */
function restoreStagedSales(
  snapshot: StagedSalesSnapshot,
  world: WorldState,
  city: City,
  ledgers: CityLedgers,
): void {
  for (const entry of snapshot.companies) {
    for (const [goodId, qty] of entry.inventory) entry.company.inventory[goodId] = qty;
    entry.company.cash = entry.cash;
    entry.company.lastMonth.revenue = entry.revenue;
    entry.company.lastMonth.sold = entry.sold;
  }
  for (const entry of snapshot.ledgers) {
    const ledger = ledgers[entry.goodId];
    if (!ledger) continue;
    ledger.consumerDemand = entry.consumerDemand;
    ledger.demand = entry.demand;
    ledger.sold = entry.sold;
    ledger.spend = entry.spend;
    ledger.transactionCount = entry.transactionCount;
    ledger.unmetDemand = entry.unmetDemand;
    ledger.consumptionTax = entry.consumptionTax;
  }
  taxAccrualOf(world, city.id).consumptionTax = snapshot.cityConsumptionTaxAccrual;
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
      const local = applyConsumerDemand(world, city, ledgers, good.id, qty, config);
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

    // 4) 资金缺口补足（消费贷）：先按真实成交规则报价并校验授信，再原子提交“放款+成交”。
    //    v0.7 验收问题 3：任何一步不满足都不得成交，绝不允许“市场记成交、群体支付 0”。
    let loanFinanced = 0;
    const loanAvailable = snapshot.loanAvailable;
    if (loanAvailable > 0) {
      const credit = config.households.householdCredit;
      // 4.1 只对“资金缺口中有本地真实供给”的部分报价：报价与 executePurchase 共用
      //     卖家价格系数、配送效率、预算与舍入规则，报价额即最终成交额。
      const gapGoods = consumerGoods
        .map((good) => {
          const effectiveQty = round2((desiredQty.get(good.id) ?? 0) * affordability);
          const gapQty = round2(Math.max(0, effectiveQty - (groupBought[good.id] ?? 0)));
          return { goodId: good.id, gapQty };
        })
        .filter((entry) => entry.gapQty > 0)
        .sort((a, b) => a.goodId.localeCompare(b.goodId));
      let remainingFinancing = round2(loanAvailable);
      const plans: { goodId: GoodId; qty: number; cost: number }[] = [];
      for (const entry of gapGoods) {
        if (remainingFinancing <= 0) break;
        const quote = quoteLocalPurchase(
          world,
          city,
          entry.goodId,
          entry.gapQty,
          remainingFinancing,
        );
        if (quote.qty <= 0 || quote.cost <= 0) continue;
        plans.push({ goodId: entry.goodId, qty: quote.qty, cost: quote.cost });
        remainingFinancing = round2(Math.max(0, remainingFinancing - quote.cost));
      }
      const plannedCost = round2(plans.reduce((total, plan) => total + plan.cost, 0));
      // 4.2 预检：单笔最低额、授信资格/冻结、当月笔数、真实可用额度（放款前不再变化）。
      if (plans.length > 0 && plannedCost >= credit.minLoanAmount) {
        const eligibility = consumptionLoanEligibility(world, group, config, plannedCost, tick);
        if (eligibility.ok) {
          const staged = captureStagedSales(
            world,
            city,
            ledgers,
            plans.map((plan) => plan.goodId),
          );
          // 4.3 按计划成交（预算=计划金额）。实际成交额只会 ≤ 计划额，随后按实际成交额放款。
          let actualSpend = 0;
          const executed: { goodId: GoodId; qty: number }[] = [];
          for (const plan of plans) {
            const ledger = ledgers[plan.goodId];
            if (ledger) {
              ledger.consumerDemand = round2(ledger.consumerDemand + plan.qty);
              ledger.demand = round2(ledger.demand + plan.qty);
            }
            const bought = executePurchase(
              world,
              city,
              ledgers,
              plan.goodId,
              plan.qty,
              plan.cost,
              { consumer: true },
              config,
            );
            if (ledger && bought.qty < plan.qty - 1e-6) {
              ledger.unmetDemand = round2(ledger.unmetDemand + (plan.qty - bought.qty));
            }
            actualSpend = round2(actualSpend + bought.spend);
            executed.push({ goodId: plan.goodId, qty: bought.qty });
          }
          // 4.4 放款金额 = 最终实际成交额（不多借一分钱）；低于单笔最低额则不得成交。
          const finalEligibility =
            actualSpend >= credit.minLoanAmount
              ? consumptionLoanEligibility(world, group, config, actualSpend, tick)
              : ({ ok: false as const, error: '' } as const);
          if (finalEligibility.ok) {
            const loan = borrowForConsumption(world, group, config, actualSpend, tick);
            if (loan.ok) {
              loanFinanced = actualSpend;
              for (const entry of executed) {
                groupBought[entry.goodId] = round2(
                  (groupBought[entry.goodId] ?? 0) + entry.qty,
                );
              }
            } else {
              // 预检已通过，放款理论上不会失败；若失败则成交与放款一起回滚，不留部分状态。
              restoreStagedSales(staged, world, city, ledgers);
              world.log.push({
                tick,
                kind: 'warning',
                message: `${group.name} 的消费贷放款失败：${loan.error ?? '未知原因'}，本笔信贷消费已回滚。`,
              });
            }
          } else {
            // 实际成交额低于单笔最低贷款额（含舍入）：不得放款，也不得成交。
            restoreStagedSales(staged, world, city, ledgers);
            world.log.push({
              tick,
              kind: 'warning',
              message: `${group.name} 的消费贷成交额 ${actualSpend.toFixed(2)} 低于最低贷款额 ${credit.minLoanAmount.toFixed(0)}，本笔信贷消费已回滚。`,
            });
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
