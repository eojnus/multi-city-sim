import type { City, Company, GoodId, HouseholdGroup, WorldState } from '../contracts/types';
import type { DemoConfig } from '../../data/config';
import { GOODS } from '../../data/demo-data';
import type { CityLedgers } from './markets';
import {
  applyConsumerDemand,
  executePurchase,
  offeredStock,
  quoteLocalPurchase,
} from './markets';
import { executeIntercityPurchase, quoteIntercityPurchase } from './intercity';
import { householdGroupsOfCity } from '../population/household-groups';
import { recordGroupConsumption } from '../population/household-economy';
import {
  borrowForConsumption,
  consumptionLoanEligibility,
  householdConsumerBudgetSnapshot,
  householdDepositWithdrawalRemaining,
  householdGroupNeedFactor,
  withdrawHouseholdDeposit,
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
    ledger.intercityImported = entry.intercityImported;
  }
  taxAccrualOf(world, city.id).consumptionTax = snapshot.cityConsumptionTaxAccrual;
  // 撤销跨城待售记录与本月贸易流：不能留下没有对应成交的“已出口”记录。
  world.transport.pendingSales.length = snapshot.pendingSalesCount;
  world.lastTick.tradeFlows.length = snapshot.tradeFlowsCount;
}

/**
 * 居民消费需求（两阶段，四层口径，DECISIONS #39/#40/#26）。
 *
 * 阶段 A（本地优先）：所有城市先只在本城成交，不跨城。A 阶段按“现金预算 → 闲置现金/可提存款”
 *   顺序消费本地供给，群体按人均预算升序，让预算更紧的群体优先获得本地有限库存。
 * 阶段 B（跨城补缺口）：A 阶段结束后，再按城市顺序处理各群体的本地缺口：跨城购买按当前
 *   真实 offeredStock 重新报价（quoteIntercityPurchase），不足就部分成交、剩余如实记 unmetDemand；
 *   资金按“手头现金 → 提取存款（单月≤月初存款5%）→ 消费贷”补足，失败原子回滚，
 *   不得破坏 A 阶段已记账的成交，也不得伪造供给或透支。
 *
 * 四层口径：
 * 1) 期望需求：按人口、人均需要、就业系数与价格弹性计算；
 * 2) 资金有效需求：以现金预算（上月可支配收入×0.8 + 现金×0.05，且不超过现金）缩放；
 * 3) 成交：A 阶段本地优先、B 阶段跨城补缺口；有效需求缩放 ≠ 资金上限——现金预算只是需求的
 *    缩放口径，本月尚未使用的现金与可提存款会先用于真实供给缺口，只有二者都不足时才
 *    先确认供给再放款补足；
 * 4) 缺口分账：供给/配送不足记 unmet，资金不足（含可借额度不足）记 unmetFunding。
 *
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
  /** 开始消费时的手头现金。 */
  cashAtStart: number;
  desiredQty: Map<GoodId, number>;
  effectiveQty: Map<GoodId, number>;
  desiredCost: number;
  affordability: number;
  /** 已记入市场需求台账的“尝试购买量”，跨阶段补记 demand 时避免重复。 */
  recorded: Record<GoodId, number>;
  bought: Record<GoodId, number>;
  unmet: Record<GoodId, number>;
  /** A 阶段现金预算段成交额。 */
  cashSpend: number;
  /** A 阶段闲置现金/存款段成交额。 */
  nonLoanSpend: number;
  /** B 阶段跨城非贷款段成交额。 */
  intercityNonLoanSpend: number;
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
    .map(({ group, snapshot }) => ({
      group,
      snapshot,
      budget: snapshot.cashBudget,
      cashAtStart: round2(Math.max(0, group.cash)),
      desiredQty: new Map<GoodId, number>(),
      effectiveQty: new Map<GoodId, number>(),
      desiredCost: 0,
      affordability: 1,
      recorded: emptyGoodsRecord(),
      bought: emptyGoodsRecord(),
      unmet: emptyGoodsRecord(),
      cashSpend: 0,
      nonLoanSpend: 0,
      intercityNonLoanSpend: 0,
      withdrawn: 0,
      loanFinanced: 0,
      unmetFunding: 0,
    }));
  return { city, ledgers, groups };
}

/** 2) 资金有效需求：低于 minAffordability 时仍保留最低有效需求，用预算封顶成交。 */
function computeGroupDemand(
  state: CityConsumptionState,
  group: GroupConsumptionState,
  config: DemoConfig,
): void {
  let desiredCost = 0;
  for (const good of CONSUMER_GOODS) {
    const price = state.city.market[good.id]?.price ?? good.basePrice;
    const elasticity = Math.pow(
      good.basePrice / Math.max(0.01, price),
      config.consumer.priceElasticity,
    );
    const qty = round2(
      group.group.people *
        good.perCapitaMonthlyNeed *
        householdGroupNeedFactor(group.group.occupation, config) *
        clamp(elasticity, 0.55, 1.85),
    );
    group.desiredQty.set(good.id, qty);
    desiredCost += qty * price;
  }
  group.desiredCost = round2(desiredCost);
  group.affordability =
    group.desiredCost <= 0
      ? 1
      : clamp(group.budget / group.desiredCost, config.consumer.minAffordability, 1);
  for (const good of CONSUMER_GOODS) {
    const qty = round2((group.desiredQty.get(good.id) ?? 0) * group.affordability);
    group.effectiveQty.set(good.id, qty);
  }
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
 * A1 现金预算段（只买本地）；A2 闲置现金 + 可提存款段（只买本地）；A3 为本地成交提款。
 * 贷款只在本阶段之后（B 阶段）统一处理，保证每群体每月最多一笔、且不跨城重复放款。
 */
function runLocalConsumptionPhase(
  world: WorldState,
  state: CityConsumptionState,
  config: DemoConfig,
): void {
  for (const group of state.groups) {
    computeGroupDemand(state, group, config);

    // A1) 现金预算内的本地成交（预算硬封顶）。
    let remainingBudget = group.budget;
    for (const good of CONSUMER_GOODS) {
      const effectiveQty = group.effectiveQty.get(good.id) ?? 0;
      if (effectiveQty <= 0) continue;
      const price = state.city.market[good.id]?.price ?? good.basePrice;
      const affordableQty =
        remainingBudget > 0
          ? Math.floor((remainingBudget / Math.max(0.01, price)) * 100) / 100
          : 0;
      const qty = round2(Math.min(effectiveQty, affordableQty));
      if (qty <= 0) continue;
      const local = applyConsumerDemand(world, state.city, state.ledgers, good.id, qty, config);
      group.recorded[good.id] = round2((group.recorded[good.id] ?? 0) + qty);
      group.bought[good.id] = round2((group.bought[good.id] ?? 0) + local.qty);
      group.cashSpend = round2(group.cashSpend + local.spend);
      remainingBudget = round2(Math.max(0, remainingBudget - local.spend));
    }

    // A2) 支付顺序：手头现金 → 提取存款（单月≤月初存款5%）。非贷款资金只用于本地缺口。
    const allowance = round2(householdDepositWithdrawalRemaining(world, group.group));
    let nonLoanCapacity = round2(
      Math.max(0, group.cashAtStart + allowance - group.cashSpend),
    );
    for (const entry of gapGoodsOf(group)) {
      if (nonLoanCapacity <= 0) break;
      const quote = quoteLocalPurchase(
        world,
        state.city,
        entry.goodId,
        entry.gapQty,
        nonLoanCapacity,
      );
      if (quote.qty <= 0 || quote.cost <= 0) continue;
      const bought = executePurchase(
        world,
        state.city,
        state.ledgers,
        entry.goodId,
        quote.qty,
        quote.cost,
        { consumer: true },
        config,
      );
      group.bought[entry.goodId] = round2((group.bought[entry.goodId] ?? 0) + bought.qty);
      group.nonLoanSpend = round2(group.nonLoanSpend + bought.spend);
      nonLoanCapacity = round2(Math.max(0, nonLoanCapacity - bought.spend));
      recordAttempt(state.ledgers, group, entry.goodId, quote.qty, bought.qty);
    }

    // A3) 现金不够的本地真实成交缺口，才从存款提取（helper 内部再封顶 5%/余额）。
    const localPayments = round2(group.cashSpend + group.nonLoanSpend);
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
    // B1) 跨城非贷款段：手头剩余现金 + 剩余可提存款额度。
    const allowance = round2(householdDepositWithdrawalRemaining(world, group.group));
    let capacity = round2(
      Math.max(
        0,
        group.cashAtStart +
          group.withdrawn +
          allowance -
          group.cashSpend -
          group.nonLoanSpend,
      ),
    );
    for (const entry of gapGoodsOf(group)) {
      if (capacity <= 0) break;
      const quote = quoteIntercityPurchase(
        world,
        state.city,
        entry.goodId,
        entry.gapQty,
        capacity,
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
      group.intercityNonLoanSpend = round2(group.intercityNonLoanSpend + imported.spend);
      capacity = round2(Math.max(0, capacity - imported.spend));
      recordAttempt(state.ledgers, group, entry.goodId, quote.qty, imported.qty);
    }

    // B2) 跨城成交后仍缺的现金，按真实缺口补提存款。
    const cashPayments = round2(
      group.cashSpend + group.nonLoanSpend + group.intercityNonLoanSpend,
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

    // B4) 缺口按“现在还有没有本地供给”分账：有供给但没钱→资金缺口；没供给→供给缺口。
    let unmetFunding = 0;
    for (const good of CONSUMER_GOODS) {
      const price = state.city.market[good.id]?.price ?? good.basePrice;
      const effectiveQty = group.effectiveQty.get(good.id) ?? 0;
      const gapQty = round2(Math.max(0, effectiveQty - (group.bought[good.id] ?? 0)));
      if (gapQty <= 0) {
        group.unmet[good.id] = 0;
        continue;
      }
      const localQty = round2(Math.min(gapQty, localAvailableQty(world, state.city, good.id)));
      group.unmet[good.id] = round2(gapQty - localQty);
      unmetFunding = round2(unmetFunding + localQty * price);
    }
    group.unmetFunding = unmetFunding;

    // B5) 逐群体扣款并记录“想要购买”的成本（贷款已入账，扣款不超出现金）。
    const finalCashPayments = round2(
      group.cashSpend + group.nonLoanSpend + group.intercityNonLoanSpend,
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
    group.entry = {
      budget: round2(group.budget),
      spend: round2(paid),
      desiredCost: round2(group.desiredCost),
      bought: group.bought,
      unmet: group.unmet,
      loanAvailable: round2(group.snapshot.loanAvailable),
      loanFinanced: round2(group.loanFinanced),
      unmetFunding: round2(unmetFunding),
      cashPaid: round2(Math.min(finalCashPayments, group.cashAtStart)),
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

  // B3.2 预检：单笔最低额、授信资格/冻结、当月笔数、真实可用额度（放款前不再变化）。
  const eligibility = consumptionLoanEligibility(
    world,
    group.group,
    config,
    plannedCost,
    world.time.tick,
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
  const finalEligibility =
    actualSpend >= credit.minLoanAmount
      ? consumptionLoanEligibility(world, group.group, config, actualSpend, world.time.tick)
      : ({ ok: false as const, error: '' } as const);
  if (finalEligibility.ok) {
    const loan = borrowForConsumption(world, group.group, config, actualSpend, world.time.tick);
    if (loan.ok) {
      group.loanFinanced = actualSpend;
      for (const entry of executed) {
        group.bought[entry.plan.goodId] = round2(
          (group.bought[entry.plan.goodId] ?? 0) + entry.qty,
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
    message: `${group.group.name} 的消费贷成交额 ${actualSpend.toFixed(2)} 低于最低贷款额 ${credit.minLoanAmount.toFixed(0)}，本笔信贷消费已回滚。`,
  });
}

function assembleConsumerResult(state: CityConsumptionState): ConsumerResult {
  const totalBought = emptyGoodsRecord();
  const totalUnmet = emptyGoodsRecord();
  const byGroup: Record<string, ConsumerGroupResult> = {};
  let totalBudget = 0;
  let totalSpend = 0;
  let totalDesiredCost = 0;
  for (const group of state.groups) {
    const entry = group.entry;
    if (!entry) continue;
    byGroup[group.group.id] = entry;
    totalBudget += entry.budget;
    totalSpend += entry.spend;
    totalDesiredCost += entry.desiredCost;
    for (const good of GOODS) {
      totalBought[good.id] = round2((totalBought[good.id] ?? 0) + (entry.bought[good.id] ?? 0));
      totalUnmet[good.id] = round2((totalUnmet[good.id] ?? 0) + (entry.unmet[good.id] ?? 0));
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
