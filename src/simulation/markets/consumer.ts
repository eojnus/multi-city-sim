import type { City, Company, GoodId, HouseholdGroup, WorldState } from '../contracts/types';
import type { DemoConfig } from '../../data/config';
import { GOODS } from '../../data/demo-data';
import type { CityLedgers } from './markets';
import {
  applyConsumerDemand,
  executePurchase,
  quoteLocalPurchase,
} from './markets';
import { executeIntercityPurchase, quoteIntercityPurchase } from './intercity';
import { householdGroupsOfCity } from '../population/household-groups';
import { recordGroupConsumption } from '../population/household-economy';
import {
  borrowForConsumption,
  consumptionLoanEligibility,
  householdBasicNeedCost,
  householdConsumerBudgetSnapshot,
  householdDepositWithdrawalRemaining,
  householdGroupNeedFactor,
  isBasicNeedGood,
  withdrawHouseholdDeposit,
} from '../population/household-finance';
import { clamp, round2 } from '../core/math';
import { taxAccrualOf } from '../government/taxes';
import { emptyInventoryCost } from '../finance/inventory-cost';

/** 单个居民群体的本月消费结果（四层口径：期望→资金有效→成交→缺口）。 */
export interface ConsumerGroupResult {
  /** 现金预算（不含可借额度，DECISIONS #26）。 */
  budget: number;
  spend: number;
  desiredCost: number;
  /** v1.4 §6.1：可支付有效需求成本（按本月本城市场价，= Σ effective×price）。 */
  effectiveCost?: number;
  /** v1.0：想买的量（desired，未按预算缩放；基本需求不因失业削减）。 */
  desired?: Record<GoodId, number>;
  /** v1.0：可支付的有效需求量（effective；基本需求=desired，非基本按日常预算与消费意愿缩放）。 */
  effective?: Record<GoodId, number>;
  /** v1.0：日常现金预算 = min(手头现金, 0.8×上月可支配收入 + 0.05×现金)。 */
  dailyBudget?: number;
  /** v1.0：基本需求月成本（food 全量；基本需求支付上限不得低于此值或实际现金上限）。 */
  basicNeedCost?: number;
  bought: Record<GoodId, number>;
  /** 因供给/配送不足而未满足（不含资金缺口）。 */
  unmet: Record<GoodId, number>;
  /** 本月可借消费贷额度（单列，不进入有效需求，失败或缺省为 0）。 */
  loanAvailable?: number;
  /** 由消费贷款支持的成交额（真实债务，不计收入）。 */
  loanFinanced?: number;
  /** 因资金不足（含贷款额度不足）而未满足的消费成本。 */
  unmetFunding?: number;
  /** v0.9 验收一：本次消费中由手头现金支付的部分。 */
  cashPaid?: number;
  /** v0.9 验收一：本次消费中从存款提取支付的部分（≤月初存款×5%）。 */
  depositWithdrawn?: number;
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

function emptyGoodsRecord(): Record<GoodId, number> {
  const record = {} as Record<GoodId, number>;
  for (const good of GOODS) record[good.id] = 0;
  return record;
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
    cogs: number;
    inventory: Map<GoodId, number>;
    /** v1.3：库存账面成本快照（与 inventory 同键），回滚时一并恢复。 */
    inventoryCost: Map<GoodId, number>;
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
    /** v0.9 验收问题六：跨城成交会累加进口额，回滚时一并撤销。 */
    intercityImported: number;
  }[];
  /** v0.8：该城本月累计消费税，回滚时恢复，避免留下没有成交的税。 */
  cityConsumptionTaxAccrual: number;
  /** v0.9 验收问题六：跨城成交会追加待结算记录与 tradeFlows，回滚时一并截断。 */
  pendingSalesCount: number;
  tradeFlowsCount: number;
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
    pendingSalesCount: world.transport.pendingSales.length,
    tradeFlowsCount: world.lastTick.tradeFlows.length,
  };
  // v0.9 验收问题六：融资购买可能跨城，卖方可能在别的城市；快照所有企业受影响商品的库存，
  // 以及现金/收入/销量（跨城成交不改卖方现金，但保留完整还原能力）。
  for (const company of world.companies) {
    const inventory = new Map<GoodId, number>();
    const inventoryCost = new Map<GoodId, number>();
    for (const goodId of goodIds) {
      inventory.set(goodId, company.inventory[goodId] ?? 0);
      inventoryCost.set(goodId, company.inventoryCost?.[goodId] ?? 0);
    }
    snapshot.companies.push({
      company,
      cash: company.cash,
      revenue: company.lastMonth.revenue,
      sold: company.lastMonth.sold,
      cogs: company.lastMonth.cogs ?? 0,
      inventory,
      inventoryCost,
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
      intercityImported: ledger.intercityImported,
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
    // v1.3：库存账面成本与本月 COGS 一并回滚，保证回滚后成本链仍守恒。
    for (const [goodId, cost] of entry.inventoryCost) {
      if (!entry.company.inventoryCost) entry.company.inventoryCost = emptyInventoryCost();
      entry.company.inventoryCost[goodId] = cost;
    }
    entry.company.cash = entry.cash;
    entry.company.lastMonth.revenue = entry.revenue;
    entry.company.lastMonth.sold = entry.sold;
    entry.company.lastMonth.cogs = entry.cogs;
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
    ledger.intercityImported = entry.intercityImported;
  }
  taxAccrualOf(world, city.id).consumptionTax = snapshot.cityConsumptionTaxAccrual;
  // 撤销跨城待售记录与本月贸易流：不能留下没有对应成交的“已出口”记录。
  world.transport.pendingSales.length = snapshot.pendingSalesCount;
  world.lastTick.tradeFlows.length = snapshot.tradeFlowsCount;
}

/**
 * 居民消费需求（两阶段，四层口径，DECISIONS #39/#40/#26；v1.0 任务书第四节）。
 *
 * 阶段 A（本地优先）：所有城市先只在本城成交，不跨城。A 阶段按“基本需求 → 非基本需求”
 *   顺序消费本地供给，群体按人均预算升序，让预算更紧的群体优先获得本地有限库存：
 *   - 基本需求（food）支付上限 = min(手头现金 + 本月剩余可提存款, 基本需求成本)，
 *     日常预算不能阻挡基本需求支付；
 *   - 非基本消费只用日常预算内剩余现金（受预算与消费意愿约束，不自动耗尽积蓄）。
 * 阶段 B（跨城补缺口）：A 阶段结束后，再按城市顺序处理各群体的本地缺口：跨城购买按当前
 *   真实 offeredStock 重新报价（quoteIntercityPurchase），不足就部分成交、剩余如实记 unmetDemand；
 *   资金按“手头现金 → 提取存款（单月≤月初存款5%）→ 消费贷”补足，失败原子回滚，
 *   不得破坏 A 阶段已记账的成交，也不得伪造供给或透支。
 *
 * 四层口径（v1.0）：
 * 1) desired（想买）：按人口、人均需要、价格弹性计算；基本需求数量不因失业/非劳动身份削减，
 *    非基本需求乘 householdGroupNeedFactor（消费意愿）；
 * 2) effective（可支付有效需求）：基本需求不按预算缩放（预算不能阻挡基本需求支付），
 *    非基本需求按“日常预算 / 非基本期望成本”缩放；
 * 3) sold（真实成交）：A 阶段本地优先、B 阶段跨城补缺口；有效需求缩放 ≠ 资金上限；
 * 4) unmet（缺货）：真实尝试过但没买到（供给/配送不足）记 unmet；因资金不足（含可借额度不足）
 *    没有尝试购买的部分记 unmetFunding。两者之和恒等于 effective − bought，不重复记账。
 * 日常预算公式（v1.0）：min(手头现金, 上月可支配收入×0.8 + 现金×0.05)；基本需求可以突破它，
 * 但最多到“基本需求成本”或实际可用现金（含单月存款提取）上限。
 * 支付顺序：手头现金 → 提取存款 → 合规消费贷；仍有足够现金时不会先借贷。
 * 贷款是真实债务，资金从银行支付给卖方，不计入居民收入；不借超过已确认供给的资金。
 * 净账目：现金减少=实际现金支付、存款减少=实际提取、债务增加=贷款，三者之和=成交额。
 */
export function runConsumerMarket(
  world: WorldState,
  city: City,
  ledgers: CityLedgers,
  config: DemoConfig,
): ConsumerResult {
  const state = createCityConsumptionState(world, city, ledgers, config);
  runLocalConsumptionPhase(world, state, config);
  runIntercityConsumptionPhase(world, state, config);
  return assembleConsumerResult(state);
}

/**
 * v0.9 验收问题六：多城市两阶段消费调度。
 * A 阶段让所有城市先完成本地消费（本地居民优先），B 阶段再按城市顺序跨城补缺口；
 * 这样任何一个城市的本地居民都不会被先跑的城市“跨城抢购”抽干本地库存。
 */
export function runConsumerMarkets(
  world: WorldState,
  ledgersByCity: Record<string, CityLedgers>,
  config: DemoConfig,
): Record<string, ConsumerResult> {
  const orderedCities = [...world.cities].sort((a, b) => a.id.localeCompare(b.id));
  const states: CityConsumptionState[] = [];
  for (const city of orderedCities) {
    const ledgers = ledgersByCity[city.id];
    if (!ledgers) continue;
    states.push(createCityConsumptionState(world, city, ledgers, config));
  }
  // 阶段 A：所有城市只做本地成交。
  for (const state of states) runLocalConsumptionPhase(world, state, config);
  // 阶段 B：再按城市顺序处理本地缺口的跨城购买、存款/贷款补足与记账。
  for (const state of states) runIntercityConsumptionPhase(world, state, config);
  const results: Record<string, ConsumerResult> = {};
  for (const state of states) results[state.city.id] = assembleConsumerResult(state);
  return results;
}

/** 单城某群体的消费中间状态（A/B 两阶段共享，最后统一记账）。 */
interface GroupConsumptionState {
  group: HouseholdGroup;
  snapshot: ReturnType<typeof householdConsumerBudgetSnapshot>;
  /** 现金预算：有效需求缩放口径，不是资金硬上限（DECISIONS #26）。 */
  budget: number;
  /** v1.0：日常现金预算 = min(手头现金, 0.8×上月可支配收入 + 0.05×现金)。 */
  dailyBudget: number;
  /** v1.0：基本需求月成本（food 全量，不因失业/非劳动身份削减）。 */
  basicNeedCost: number;
  /** v1.0：基本需求数量（按人均需要全额，不含价格弹性）；预算保障以它为上限。 */
  basicNeedQty: Map<GoodId, number>;
  /** v1.0：基本需求现金保障上限（手头现金 + 单月可提存款，封顶于基本需求成本）。 */
  essentialCashCap: number;
  /** 开始消费时的手头现金。 */
  cashAtStart: number;
  desiredQty: Map<GoodId, number>;
  effectiveQty: Map<GoodId, number>;
  desiredCost: number;
  /** v1.4 §6.1：可支付有效需求成本（= Σ effective×本月本城价格）。 */
  effectiveCost: number;
  affordability: number;
  /** 已记入市场需求台账的“尝试购买量”，跨阶段补记 demand 时避免重复。 */
  recorded: Record<GoodId, number>;
  bought: Record<GoodId, number>;
  unmet: Record<GoodId, number>;
  /**
   * v1.3：每个商品“真实尝试过但未成交”的数量。
   * B4 用它把缺口分成缺货（尝试过、没买到）与资金缺口（因资金不足没尝试/没报价），
   * 避免“月末还有库存”这种间接推断把资金不足误记成缺货。
   */
  supplyShortfallQty: Record<GoodId, number>;
  /** A 阶段本地基本需求现金成交额。 */
  essentialSpend: number;
  /** A 阶段本地非基本需求现金成交额（受日常预算约束，不动积蓄）。 */
  nonEssentialSpend: number;
  /** B 阶段跨城基本需求现金成交额。 */
  intercityEssentialSpend: number;
  /** B 阶段跨城非基本需求现金成交额（受日常预算约束）。 */
  intercityNonEssentialSpend: number;
  withdrawn: number;
  loanFinanced: number;
  unmetFunding: number;
  entry?: ConsumerGroupResult;
}

interface CityConsumptionState {
  city: City;
  ledgers: CityLedgers;
  groups: GroupConsumptionState[];
}

const CONSUMER_GOODS = GOODS.filter((good) => good.category === 'consumer');

function createCityConsumptionState(
  world: WorldState,
  city: City,
  ledgers: CityLedgers,
  config: DemoConfig,
): CityConsumptionState {
  const tick = world.time.tick;
  const groups: GroupConsumptionState[] = householdGroupsOfCity(world, city.id)
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
    })
    .map(({ group, snapshot }) => {
      const cashAtStart = round2(Math.max(0, group.cash));
      const basicNeedCost = householdBasicNeedCost(world, group, config);
      // 基本需求保障上限：预算不能阻挡基本需求，但天花板是“真实现金 + 本月可提存款”且不超过基本需求成本。
      const essentialCashCap = round2(
        Math.max(
          0,
          Math.min(
            cashAtStart + householdDepositWithdrawalRemaining(world, group),
            basicNeedCost,
          ),
        ),
      );
      return {
        group,
        snapshot,
        budget: snapshot.cashBudget,
        dailyBudget: round2(Math.max(0, Math.min(cashAtStart, snapshot.referenceSpend))),
        basicNeedCost,
        basicNeedQty: new Map<GoodId, number>(),
        essentialCashCap,
        cashAtStart,
        desiredQty: new Map<GoodId, number>(),
        effectiveQty: new Map<GoodId, number>(),
        desiredCost: 0,
        effectiveCost: 0,
        affordability: 1,
        recorded: emptyGoodsRecord(),
        bought: emptyGoodsRecord(),
        unmet: emptyGoodsRecord(),
        supplyShortfallQty: emptyGoodsRecord(),
        essentialSpend: 0,
        nonEssentialSpend: 0,
        intercityEssentialSpend: 0,
        intercityNonEssentialSpend: 0,
        withdrawn: 0,
        loanFinanced: 0,
        unmetFunding: 0,
      };
    });
  return { city, ledgers, groups };
}

/**
 * 2) 需求分四层（v1.0 任务书第四节）：
 * - desired（想买）：按人口、人均需要、价格弹性计算；基本需求（food）不乘失业/非劳动系数，
 *   非基本需求乘 householdGroupNeedFactor（消费意愿）。
 * - effective（可支付）：基本需求不按预算缩放（预算不能阻挡基本需求支付，后续用现金→存款→贷款补足）；
 *   非基本需求按“日常预算 / 非基本期望成本”缩放（受预算与消费意愿约束，不自动耗尽积蓄）。
 */
function computeGroupDemand(
  state: CityConsumptionState,
  group: GroupConsumptionState,
  config: DemoConfig,
): void {
  let desiredCost = 0;
  let nonBasicDesiredCost = 0;
  for (const good of CONSUMER_GOODS) {
    const price = state.city.market[good.id]?.price ?? good.basePrice;
    const elasticity = Math.pow(
      good.basePrice / Math.max(0.01, price),
      config.consumer.priceElasticity,
    );
    const basic = isBasicNeedGood(good.id);
    const needFactor = basic ? 1 : householdGroupNeedFactor(group.group.occupation, config);
    const qty = round2(
      group.group.people *
        good.perCapitaMonthlyNeed *
        needFactor *
        clamp(elasticity, 0.55, 1.85),
    );
    group.desiredQty.set(good.id, qty);
    if (basic) {
      // 保障口径：基本需求数量 = 人均需要 × 人口，不乘价格弹性、不因失业削减。
      // 价格低时 desired 可能高于它，超出的部分不再享受“预算不能阻挡”的保障。
      group.basicNeedQty.set(good.id, round2(group.group.people * good.perCapitaMonthlyNeed));
    }
    desiredCost += qty * price;
    if (!basic) nonBasicDesiredCost += qty * price;
  }
  group.desiredCost = round2(desiredCost);
  // 非基本需求只能用日常预算扣掉“基本需求现金保障”之后的剩余部分，避免靠贷款突破预算、耗尽积蓄。
  const nonBasicBudget = round2(Math.max(0, group.dailyBudget - group.essentialCashCap));
  // v1.1 §8：effective 是“可支付的有效需求”，非基本需求不得突破日常预算。
  // 此前用 minAffordability 下限抬高比例，会让有效需求成本超过预算，缺口随后被消费贷融资，
  // 既违反“非基本消费受预算约束”，也违反“贷款只补真实缺口”的支付顺序。
  const nonBasicAffordability =
    nonBasicDesiredCost <= 0
      ? 1
      : nonBasicBudget <= 0
        ? 0
        : clamp(nonBasicBudget / nonBasicDesiredCost, 0, 1);
  group.affordability =
    group.desiredCost <= 0 ? 1 : clamp(group.dailyBudget / group.desiredCost, 0, 1);
  // v1.4 §6.1：可支付有效需求金额按本月本城价格折算，供报告区分“有效需求/成交/缺口”。
  let effectiveCost = 0;
  for (const good of CONSUMER_GOODS) {
    const desired = group.desiredQty.get(good.id) ?? 0;
    const effective = isBasicNeedGood(good.id)
      ? Math.min(desired, group.basicNeedQty.get(good.id) ?? 0)
      : round2(desired * nonBasicAffordability);
    group.effectiveQty.set(good.id, round2(effective));
    const price = state.city.market[good.id]?.price ?? good.basePrice;
    effectiveCost += round2(effective) * price;
  }
  group.effectiveCost = round2(effectiveCost);
}

/** 当前仍未被成交覆盖的资金有效需求，按 goodId 升序（复现性）。 */
function gapGoodsOf(group: GroupConsumptionState): { goodId: GoodId; gapQty: number }[] {
  const entries: { goodId: GoodId; gapQty: number }[] = [];
  for (const good of CONSUMER_GOODS) {
    const gapQty = round2(
      Math.max(0, (group.effectiveQty.get(good.id) ?? 0) - (group.bought[good.id] ?? 0)),
    );
    if (gapQty > 0) entries.push({ goodId: good.id, gapQty });
  }
  entries.sort((a, b) => a.goodId.localeCompare(b.goodId));
  return entries;
}

/**
 * 记录一次“尝试购买”的市场需求，但不重复记账：
 * 只有尚未记过的有效需求（effective − recorded）才计入 demand；
 * unmetDemand 按本次真实成交额冲销，因此跨阶段补货不会虚增需求。
 */
function recordAttempt(
  ledgers: CityLedgers,
  group: GroupConsumptionState,
  goodId: GoodId,
  attemptQty: number,
  boughtQty: number,
): void {
  if (attemptQty <= 0) return;
  const ledger = ledgers[goodId];
  if (!ledger) return;
  const effective = round2(group.effectiveQty.get(goodId) ?? 0);
  const unrecorded = round2(Math.max(0, effective - (group.recorded[goodId] ?? 0)));
  const newDemand = round2(Math.min(attemptQty, unrecorded));
  group.recorded[goodId] = round2((group.recorded[goodId] ?? 0) + newDemand);
  ledger.consumerDemand = round2(ledger.consumerDemand + newDemand);
  ledger.demand = round2(ledger.demand + newDemand);
  ledger.unmetDemand = round2(Math.max(0, ledger.unmetDemand + newDemand - boughtQty));
}

/**
 * 阶段 A：本地消费。所有城市都先跑完本阶段，然后才进入跨城阶段。
 * A1) 基本需求（food）先买本地供给：支付上限 = min(手头现金 + 本月剩余可提存款, 基本需求成本)，
 *     即日常预算不能阻挡基本需求支付（可动用更多当前现金/存款，直至成本或现金上限）；
 * A2) 非基本需求再买本地供给：支付上限 = min(日常预算 − 已花基本需求现金, 剩余现金)，
 *     受预算与消费意愿约束，不动积蓄、不提前透支未来；
 * A3) 为本地真实成交提款（只有基本需求可能超过手头现金，提取≤月初存款5%）。
 * 贷款只在本阶段之后（B 阶段）统一处理，保证每群体每月最多一笔、且不跨城重复放款。
 */
function runLocalConsumptionPhase(
  world: WorldState,
  state: CityConsumptionState,
  config: DemoConfig,
): void {
  for (const group of state.groups) {
    computeGroupDemand(state, group, config);
    const allowance = round2(householdDepositWithdrawalRemaining(world, group.group));

    // A1) 基本需求：预算不足时可动用更多手头现金/可提存款，直至基本需求成本或实际现金上限。
    let essentialCapacity = round2(
      Math.max(0, Math.min(group.cashAtStart + allowance, group.basicNeedCost)),
    );
    for (const good of CONSUMER_GOODS) {
      if (!isBasicNeedGood(good.id)) continue;
      const effectiveQty = group.effectiveQty.get(good.id) ?? 0;
      if (effectiveQty <= 0) continue;
      const price = state.city.market[good.id]?.price ?? good.basePrice;
      const affordableQty =
        essentialCapacity > 0
          ? Math.floor((essentialCapacity / Math.max(0.01, price)) * 100) / 100
          : 0;
      const qty = round2(Math.min(effectiveQty, affordableQty));
      if (qty <= 0) continue;
      const local = applyConsumerDemand(world, state.city, state.ledgers, good.id, qty, config);
      group.recorded[good.id] = round2((group.recorded[good.id] ?? 0) + qty);
      group.bought[good.id] = round2((group.bought[good.id] ?? 0) + local.qty);
      group.supplyShortfallQty[good.id] = round2(
        (group.supplyShortfallQty[good.id] ?? 0) + Math.max(0, qty - local.qty),
      );
      group.essentialSpend = round2(group.essentialSpend + local.spend);
      essentialCapacity = round2(Math.max(0, essentialCapacity - local.spend));
    }

    // A2) 非基本需求：只用日常预算内剩余现金（并受实际剩余现金约束），不自动耗尽积蓄。
    let nonEssentialCapacity = round2(
      Math.max(
        0,
        Math.min(
          group.dailyBudget - group.essentialSpend,
          group.cashAtStart - group.essentialSpend,
        ),
      ),
    );
    for (const good of CONSUMER_GOODS) {
      if (isBasicNeedGood(good.id)) continue;
      const effectiveQty = group.effectiveQty.get(good.id) ?? 0;
      if (effectiveQty <= 0) continue;
      const price = state.city.market[good.id]?.price ?? good.basePrice;
      const affordableQty =
        nonEssentialCapacity > 0
          ? Math.floor((nonEssentialCapacity / Math.max(0.01, price)) * 100) / 100
          : 0;
      const qty = round2(Math.min(effectiveQty, affordableQty));
      if (qty <= 0) continue;
      const local = applyConsumerDemand(world, state.city, state.ledgers, good.id, qty, config);
      group.recorded[good.id] = round2((group.recorded[good.id] ?? 0) + qty);
      group.bought[good.id] = round2((group.bought[good.id] ?? 0) + local.qty);
      group.supplyShortfallQty[good.id] = round2(
        (group.supplyShortfallQty[good.id] ?? 0) + Math.max(0, qty - local.qty),
      );
      group.nonEssentialSpend = round2(group.nonEssentialSpend + local.spend);
      nonEssentialCapacity = round2(Math.max(0, nonEssentialCapacity - local.spend));
    }

    // A3) 只有基本需求可能超过手头现金，按真实资金缺口提款。
    const localPayments = round2(group.essentialSpend + group.nonEssentialSpend);
    const neededWithdrawal = round2(Math.max(0, localPayments - group.cashAtStart));
    if (neededWithdrawal > 0) {
      group.withdrawn = round2(
        withdrawHouseholdDeposit(world, group.group, config, neededWithdrawal, world.time.tick),
      );
    }
  }
}

/**
 * 阶段 B：本地缺口的跨城购买 + 存款补提 + 消费贷补足 + 记账。
 * 跨城报价按执行时的真实 offeredStock 重新计算，因此不会抢走其他城市本地居民尚未购买的库存
 * （其他城市的本地消费已在阶段 A 完成）。成交失败/放款失败时原子回滚到本阶段开始前的状态。
 */
function runIntercityConsumptionPhase(
  world: WorldState,
  state: CityConsumptionState,
  config: DemoConfig,
): void {
  for (const group of state.groups) {
    // B1) 跨城补缺口：先基本需求（手头现金 + 已提存款 + 剩余可提额度），
    //     再非基本需求（仅日常预算内剩余现金，不消耗积蓄）。
    const allowance = round2(householdDepositWithdrawalRemaining(world, group.group));
    const localSpend = round2(group.essentialSpend + group.nonEssentialSpend);
    // 基本需求现金支付上限：先受“基本需求成本”约束（保障只到基本需求为止，不因价格弹性多买），
    // 再受实际可用现金（含本月可提存款）约束。
    const essentialBudgetLeft = round2(
      Math.max(0, group.basicNeedCost - group.essentialSpend - group.intercityEssentialSpend),
    );
    let essentialCapacity = round2(
      Math.max(
        0,
        Math.min(
          group.cashAtStart + group.withdrawn + allowance - localSpend,
          essentialBudgetLeft,
        ),
      ),
    );
    for (const entry of gapGoodsOf(group)) {
      if (!isBasicNeedGood(entry.goodId) || essentialCapacity <= 0) continue;
      const quote = quoteIntercityPurchase(
        world,
        state.city,
        entry.goodId,
        entry.gapQty,
        essentialCapacity,
        config,
      );
      if (quote.qty <= 0 || quote.cost <= 0) continue;
      const imported = executeIntercityPurchase(
        world,
        state.city,
        state.ledgers,
        entry.goodId,
        quote.qty,
        quote.cost,
        { consumer: true, householdGroupId: group.group.id },
        config,
      );
      group.bought[entry.goodId] = round2((group.bought[entry.goodId] ?? 0) + imported.qty);
      group.supplyShortfallQty[entry.goodId] = round2(
        (group.supplyShortfallQty[entry.goodId] ?? 0) +
          Math.max(0, quote.qty - imported.qty),
      );
      group.intercityEssentialSpend = round2(group.intercityEssentialSpend + imported.spend);
      essentialCapacity = round2(Math.max(0, essentialCapacity - imported.spend));
      recordAttempt(state.ledgers, group, entry.goodId, quote.qty, imported.qty);
    }

    const essentialTotal = round2(group.essentialSpend + group.intercityEssentialSpend);
    const nonEssentialSpent = round2(group.nonEssentialSpend);
    const remainingCashForNonEssential = round2(
      Math.max(0, group.cashAtStart - essentialTotal - nonEssentialSpent),
    );
    let nonEssentialCapacity = round2(
      Math.max(
        0,
        Math.min(
          group.dailyBudget - essentialTotal - nonEssentialSpent,
          remainingCashForNonEssential,
        ),
      ),
    );
    for (const entry of gapGoodsOf(group)) {
      if (isBasicNeedGood(entry.goodId) || nonEssentialCapacity <= 0) continue;
      const quote = quoteIntercityPurchase(
        world,
        state.city,
        entry.goodId,
        entry.gapQty,
        nonEssentialCapacity,
        config,
      );
      if (quote.qty <= 0 || quote.cost <= 0) continue;
      const imported = executeIntercityPurchase(
        world,
        state.city,
        state.ledgers,
        entry.goodId,
        quote.qty,
        quote.cost,
        { consumer: true, householdGroupId: group.group.id },
        config,
      );
      group.bought[entry.goodId] = round2((group.bought[entry.goodId] ?? 0) + imported.qty);
      group.supplyShortfallQty[entry.goodId] = round2(
        (group.supplyShortfallQty[entry.goodId] ?? 0) +
          Math.max(0, quote.qty - imported.qty),
      );
      group.intercityNonEssentialSpend = round2(
        group.intercityNonEssentialSpend + imported.spend,
      );
      nonEssentialCapacity = round2(Math.max(0, nonEssentialCapacity - imported.spend));
      recordAttempt(state.ledgers, group, entry.goodId, quote.qty, imported.qty);
    }

    // B2) 跨城成交后仍缺的现金（只可能来自基本需求），按真实缺口补提存款。
    const cashPayments = round2(
      group.essentialSpend +
        group.nonEssentialSpend +
        group.intercityEssentialSpend +
        group.intercityNonEssentialSpend,
    );
    const neededWithdrawal = round2(
      Math.max(0, cashPayments - group.cashAtStart - group.withdrawn),
    );
    if (neededWithdrawal > 0) {
      group.withdrawn = round2(
        group.withdrawn +
          withdrawHouseholdDeposit(world, group.group, config, neededWithdrawal, world.time.tick),
      );
    }

    // B3) 现金与可提存款都用尽后，仍不足才申请消费贷（原子：放款+成交要么全成、要么全无）。
    runLoanFinancedPurchases(world, state, group, config);

    // B4) 缺口分账（v1.3 §6）：真实尝试过但没买到 → 缺货（unmet）；
    // 因资金不足没尝试/没报价 → 资金缺口（unmetFunding）。
    // 早期阶段失败、后续阶段补上的尝试仍计入缺货，作为“曾发生供应不足”的保守上限；
    // 二者之和恒等于 effective − bought，不重复记账。
    let unmetFunding = 0;
    for (const good of CONSUMER_GOODS) {
      const price = state.city.market[good.id]?.price ?? good.basePrice;
      const effectiveQty = group.effectiveQty.get(good.id) ?? 0;
      const gapQty = round2(Math.max(0, effectiveQty - (group.bought[good.id] ?? 0)));
      if (gapQty <= 0) {
        group.unmet[good.id] = 0;
        continue;
      }
      const unserved = round2(
        Math.min(gapQty, Math.max(0, group.supplyShortfallQty[good.id] ?? 0)),
      );
      group.unmet[good.id] = unserved;
      unmetFunding = round2(unmetFunding + round2(Math.max(0, gapQty - unserved) * price));
    }
    group.unmetFunding = unmetFunding;

    // B5) 逐群体扣款并记录“想要购买”的成本（贷款已入账，扣款不超出现金）。
    const finalCashPayments = round2(
      group.essentialSpend +
        group.nonEssentialSpend +
        group.intercityEssentialSpend +
        group.intercityNonEssentialSpend,
    );
    const groupSpend = round2(finalCashPayments + group.loanFinanced);
    const paid = recordGroupConsumption(
      world,
      state.city,
      group.group.id,
      groupSpend,
      round2(group.desiredCost),
    );
    group.group.lastMonth.loanFinancedConsumption = round2(
      (group.group.lastMonth.loanFinancedConsumption ?? 0) + group.loanFinanced,
    );
    group.group.lastMonth.unmetFunding = round2(
      (group.group.lastMonth.unmetFunding ?? 0) + unmetFunding,
    );

    // v1.4 §6.1 消费六项：把“基本需要量/有效需求/成交/商品不足缺口”的件数与现金支付
    // 落到本月统计，供报告与审计直接读取（旧存档缺省按 0 处理）。
    // 关键口径：基本需要覆盖率 = 基本需要商品成交量 / 基本需要量，不得用“有效需求满足率”替代；
    // 商品不足缺口取本月最终仍未成交的供给缺口（Σunmet），与资金缺口互斥、不重复记账。
    let basicNeedUnits = 0;
    for (const qty of group.basicNeedQty.values()) basicNeedUnits += qty;
    basicNeedUnits = round2(basicNeedUnits);
    let basicSoldUnits = 0;
    let soldUnits = 0;
    let supplyShortfallUnits = 0;
    let effectiveUnits = 0;
    for (const good of CONSUMER_GOODS) {
      const bought = round2(group.bought[good.id] ?? 0);
      soldUnits += bought;
      if (isBasicNeedGood(good.id)) basicSoldUnits += bought;
      supplyShortfallUnits += round2(group.unmet[good.id] ?? 0);
      effectiveUnits += round2(group.effectiveQty.get(good.id) ?? 0);
    }
    basicSoldUnits = round2(basicSoldUnits);
    soldUnits = round2(soldUnits);
    supplyShortfallUnits = round2(supplyShortfallUnits);
    effectiveUnits = round2(effectiveUnits);
    const cashPaid = round2(Math.min(finalCashPayments, group.cashAtStart));
    const stats = group.group.lastMonth;
    stats.basicNeedUnits = round2((stats.basicNeedUnits ?? 0) + basicNeedUnits);
    stats.basicSoldUnits = round2((stats.basicSoldUnits ?? 0) + basicSoldUnits);
    stats.effectiveUnits = round2((stats.effectiveUnits ?? 0) + effectiveUnits);
    stats.soldUnits = round2((stats.soldUnits ?? 0) + soldUnits);
    stats.supplyShortfallUnits = round2(
      (stats.supplyShortfallUnits ?? 0) + supplyShortfallUnits,
    );
    stats.cashPaid = round2((stats.cashPaid ?? 0) + cashPaid);
    stats.effectiveCost = round2((stats.effectiveCost ?? 0) + round2(group.effectiveCost));
    // v1.5 §3：基本需要商品（food）的居民侧有效需求量，供“有效需求满足率”与基本需要覆盖率同口径核对。
    stats.basicEffectiveUnits = round2(
      (stats.basicEffectiveUnits ?? 0) + round2(group.effectiveQty.get('food') ?? 0),
    );
    stats.basicNeedCoverage =
      (stats.basicNeedUnits ?? 0) > 0.01
        ? Math.round(((stats.basicSoldUnits ?? 0) / (stats.basicNeedUnits ?? 1)) * 10000) / 10000
        : 0;

    // v1.0：把四层口径中的 desired / effective 也写进结果，便于审计与测试区分
    // “想买多少”“能支付多少”“真实成交多少”“缺货多少”。
    const desiredRecord = emptyGoodsRecord();
    const effectiveRecord = emptyGoodsRecord();
    for (const good of CONSUMER_GOODS) {
      desiredRecord[good.id] = round2(group.desiredQty.get(good.id) ?? 0);
      effectiveRecord[good.id] = round2(group.effectiveQty.get(good.id) ?? 0);
    }
    group.entry = {
      budget: round2(group.budget),
      spend: round2(paid),
      desiredCost: round2(group.desiredCost),
      effectiveCost: round2(group.effectiveCost),
      desired: desiredRecord,
      effective: effectiveRecord,
      dailyBudget: round2(group.dailyBudget),
      basicNeedCost: round2(group.basicNeedCost),
      bought: group.bought,
      unmet: group.unmet,
      loanAvailable: round2(group.snapshot.loanAvailable),
      loanFinanced: round2(group.loanFinanced),
      unmetFunding: round2(unmetFunding),
      cashPaid,
      depositWithdrawn: round2(group.withdrawn),
    };
  }
}

interface LoanPurchasePlan {
  source: 'local' | 'intercity';
  goodId: GoodId;
  qty: number;
  cost: number;
}

/**
 * B3) 消费贷原子阶段：
 * 先对本地/跨城缺口按真实报价生成计划并校验授信，再原子提交“成交 + 按实际成交额放款”。
 * 任何一步不满足（预检失败、实际成交低于最低贷款额、放款失败）都回滚全部成交与跨城待结算记录，
 * 绝不允许“市场记成交、群体支付 0”或留下没有对应成交的跨城销售。
 */
function runLoanFinancedPurchases(
  world: WorldState,
  state: CityConsumptionState,
  group: GroupConsumptionState,
  config: DemoConfig,
): void {
  const loanAvailable = round2(group.snapshot.loanAvailable);
  if (loanAvailable <= 0) return;
  const credit = config.households.householdCredit;

  // B3.1 本地优先、跨城补缺口地生成融资购买计划（预算=可借额度）。
  let remainingFinancing = loanAvailable;
  const plans: LoanPurchasePlan[] = [];
  for (const entry of gapGoodsOf(group)) {
    if (remainingFinancing <= 0) break;
    let remainingQty = entry.gapQty;
    const localQuote = quoteLocalPurchase(
      world,
      state.city,
      entry.goodId,
      remainingQty,
      remainingFinancing,
    );
    if (localQuote.qty > 0 && localQuote.cost > 0) {
      plans.push({
        source: 'local',
        goodId: entry.goodId,
        qty: localQuote.qty,
        cost: localQuote.cost,
      });
      remainingFinancing = round2(Math.max(0, remainingFinancing - localQuote.cost));
      remainingQty = round2(remainingQty - localQuote.qty);
    }
    if (remainingFinancing <= 0 || remainingQty <= 0) continue;
    const intercityQuote = quoteIntercityPurchase(
      world,
      state.city,
      entry.goodId,
      remainingQty,
      remainingFinancing,
      config,
    );
    if (intercityQuote.qty > 0 && intercityQuote.cost > 0) {
      plans.push({
        source: 'intercity',
        goodId: entry.goodId,
        qty: intercityQuote.qty,
        cost: intercityQuote.cost,
      });
      remainingFinancing = round2(Math.max(0, remainingFinancing - intercityQuote.cost));
    }
  }
  const plannedCost = round2(plans.reduce((total, plan) => total + plan.cost, 0));
  if (plans.length === 0 || plannedCost < credit.minLoanAmount) return;

  // B3.2 预检：单笔最低额、授信资格/冻结、当月笔数；额度以消费阶段开始时的快照为准
  // （成交本身会改变企业估值/投资实体权益，不能拿变动后的额度否决已按快照排好的计划）。
  if (plannedCost > loanAvailable + 0.01) return;
  const eligibility = consumptionLoanEligibility(
    world,
    group.group,
    config,
    plannedCost,
    world.time.tick,
    { skipCreditLimit: true },
  );
  if (!eligibility.ok) return;

  const staged = captureStagedSales(
    world,
    state.city,
    state.ledgers,
    plans.map((plan) => plan.goodId),
  );
  let actualSpend = 0;
  const executed: { plan: LoanPurchasePlan; qty: number }[] = [];
  for (const plan of plans) {
    const bought =
      plan.source === 'local'
        ? executePurchase(
            world,
            state.city,
            state.ledgers,
            plan.goodId,
            plan.qty,
            plan.cost,
            { consumer: true },
            config,
          )
        : executeIntercityPurchase(
            world,
            state.city,
            state.ledgers,
            plan.goodId,
            plan.qty,
            plan.cost,
            { consumer: true, householdGroupId: group.group.id },
            config,
          );
    actualSpend = round2(actualSpend + bought.spend);
    executed.push({ plan, qty: bought.qty });
  }

  // B3.3 放款金额 = 最终实际成交额（不多借一分钱）；低于单笔最低额则不得成交。
  // 授信已在预检时按“计划成交额”批准；成交本身会经由企业现金/库存/股价影响投资实体权益，
  // 因而不能用成交后的额度二次否决已批准的交易（否则贷款恰好用满额度时会被自身成交回滚）。
  const approved = actualSpend >= credit.minLoanAmount && actualSpend <= round2(loanAvailable) + 0.01;
  if (approved) {
    const loan = borrowForConsumption(world, group.group, config, actualSpend, world.time.tick, {
      prechecked: true,
    });
    if (loan.ok) {
      group.loanFinanced = actualSpend;
      for (const entry of executed) {
        group.bought[entry.plan.goodId] = round2(
          (group.bought[entry.plan.goodId] ?? 0) + entry.qty,
        );
        group.supplyShortfallQty[entry.plan.goodId] = round2(
          (group.supplyShortfallQty[entry.plan.goodId] ?? 0) +
            Math.max(0, entry.plan.qty - entry.qty),
        );
        recordAttempt(state.ledgers, group, entry.plan.goodId, entry.plan.qty, entry.qty);
      }
      return;
    }
    restoreStagedSales(staged, world, state.city, state.ledgers);
    world.log.push({
      tick: world.time.tick,
      kind: 'warning',
      message: `${group.group.name} 的消费贷放款失败：${loan.error ?? '未知原因'}，本笔信贷消费已回滚。`,
    });
    return;
  }
  restoreStagedSales(staged, world, state.city, state.ledgers);
  world.log.push({
    tick: world.time.tick,
    kind: 'warning',
    message: `${group.group.name} 的消费贷成交额 ${actualSpend.toFixed(2)} 低于单笔最低贷款额 ${credit.minLoanAmount.toFixed(0)} 或超出已批准额度，本笔信贷消费已回滚。`,
  });
}

function assembleConsumerResult(state: CityConsumptionState): ConsumerResult {
  const totalBought = emptyGoodsRecord();
  const totalUnmet = emptyGoodsRecord();
  const byGroup: Record<string, ConsumerGroupResult> = {};
  let totalBudget = 0;
  let totalSpend = 0;
  let totalDesiredCost = 0;
  let totalEffectiveCost = 0;
  for (const group of state.groups) {
    const entry = group.entry;
    if (!entry) continue;
    byGroup[group.group.id] = entry;
    totalBudget += entry.budget;
    totalSpend += entry.spend;
    totalDesiredCost += entry.desiredCost;
    totalEffectiveCost += entry.effectiveCost ?? 0;
    for (const good of GOODS) {
      totalBought[good.id] = round2((totalBought[good.id] ?? 0) + (entry.bought[good.id] ?? 0));
      totalUnmet[good.id] = round2((totalUnmet[good.id] ?? 0) + (entry.unmet[good.id] ?? 0));
    }
  }
  return {
    budget: round2(totalBudget),
    spend: round2(totalSpend),
    desiredCost: round2(totalDesiredCost),
    // v1.4 §6.1 口径修正：affordability 是“可支付有效需求 / 期望需求”，
    // 不是“实际成交 / 期望需求”（后者把缺货与资金缺口混在一起，不能当作满足率）。
    affordability:
      totalDesiredCost <= 0
        ? 1
        : round2(clamp(totalEffectiveCost / totalDesiredCost, 0, 1) * 1000) / 1000,
    bought: totalBought,
    unmet: totalUnmet,
    byGroup,
  };
}
