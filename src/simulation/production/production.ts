import type { City, Company, GoodId, ProductionRecord, WorldState, LogEntry } from '../contracts/types';
import type { DemoConfig } from '../../data/config';
import { DEMO_CONFIG } from '../../data/config';
import type { CityLedgers, WorldLedgers } from '../markets/markets';
import {
  executePurchase,
  offeredStock,
  quoteLocalPurchase,
  recordProducedSupply,
} from '../markets/markets';
import { executeIntercityPurchase, quoteIntercityPurchase } from '../markets/intercity';
import { GOOD_IDS } from '../companies/company';
import { PRODUCTIVITY, RECIPES } from '../../data/demo-data';
import { round2 } from '../core/math';
import { monthlyWageBill } from '../companies/company';
import {
  drawPlannedWorkingCapital,
  legalWorkingCapitalRoom,
  planCompanyWorkingCapital,
} from '../management/financing';
import { workforceSkillMultiplier } from '../labor/workforce';
import { leaderSectorMultiplier } from '../politics/politics';
import { keyIndustryFocus } from '../policies/query';
import { issueInventory, receiveInventory } from '../finance/inventory-cost';

/** 单个投入品的采购计划（阶段 A/B 共用的中间结构）。 */
interface InputPurchasePlan {
  goodId: GoodId;
  shortage: number;
  price: number;
  localStock: number;
  intercitySupply: number;
  supplyQty: number;
}

interface AccountedInputPlan extends InputPurchasePlan {
  effectiveDemand: number;
}

/**
 * 一家企业的本月采购上下文。
 *
 * v1.2：采购拆成两个阶段执行，但需求记账与融资裁决仍在第一阶段一次性完成
 * （使用月初可售供给快照，不随后续成交变化），因此账本口径与旧实现一致。
 */
interface CompanyInputPurchasing {
  company: Company;
  city: City;
  cityLedgers: CityLedgers;
  plans: AccountedInputPlan[];
  /** 自有采购预算（现金−工资预留）与已裁决的周转授信额度，跨阶段持续扣减。 */
  budget: number;
  creditRoom: number;
  /** 每个投入品已成交数量（本地 + 跨城），用于最终缺货记账。 */
  bought: number[];
}

/** 按权重把数量分配到 0.01（最大余数法），保证合计严格等于 total。 */
function allocateByWeight(total: number, weights: number[]): number[] {
  const sum = weights.reduce((acc, weight) => acc + Math.max(0, weight), 0);
  if (!(sum > 0) || total <= 0) return weights.map(() => 0);
  const raw = weights.map((weight) => (total * Math.max(0, weight)) / sum);
  const shares = raw.map((value) => Math.floor(value * 100) / 100);
  let remainder = round2(total - shares.reduce((acc, share) => acc + share, 0));
  const order = raw
    .map((value, index) => ({ index, fraction: value * 100 - Math.floor(value * 100) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  for (const entry of order) {
    if (remainder <= 0.001) break;
    const add = Math.min(0.01, remainder);
    shares[entry.index] = round2((shares[entry.index] ?? 0) + add);
    remainder = round2(remainder - add);
  }
  return shares;
}

/**
 * 本月生产目标。
 *
 * v0.9：优先读取企业生产计划的 plannedOutput（由设备产能、劳动产能、原料资金与
 * “近 3 月销量 + 目标库存”共同决定）；旧档/新企业没有计划时回退旧口径
 * “产能 × 利用率”。v1.0 保持“计划/实际/设备/劳动”分离：实际产量仍由 runProduction
 * 再按 min(计划, 设备产能, 劳动产能, 原料库存) 收紧，不会超计划/超设备/超劳动/超原料。
 */
export function productionTarget(company: Company): number {
  const planned = company.productionPlan?.plannedOutput;
  if (typeof planned === 'number' && Number.isFinite(planned) && planned >= 0) {
    return Math.max(0, round2(planned));
  }
  return Math.max(0, round2(company.capacity * company.utilization));
}

/**
 * 政策与领导人带来的有上限生产率系数：
 * 领导人重点行业加成 + 重点产业扶持加成（两者可叠加，均有明确上限）。
 */
export function companyProductivityMultiplier(
  world: WorldState,
  city: City,
  company: Company,
  config: DemoConfig = DEMO_CONFIG,
): number {
  const leader = leaderSectorMultiplier(world, city.id, company.sector, config);
  const focus = keyIndustryFocus(world, city.id);
  const industry =
    focus.sector && focus.sector === company.sector ? 1 + Math.max(0, focus.bonus ?? 0) : 1;
  return round2(leader * industry);
}

/** 当期员工能支撑的最大产出。员工为 0 时上限为 0，产能本身不能替代劳动力。 */
export function laborCapacity(
  company: Company,
  city: City,
  config: DemoConfig = DEMO_CONFIG,
  world?: WorldState,
): number {
  const skill = workforceSkillMultiplier(city);
  const policy = world ? companyProductivityMultiplier(world, city, company, config) : 1;
  return round2(
    company.employees *
      (PRODUCTIVITY[company.recipeOutput] ?? 0) *
      city.technology.productivityMultiplier *
      skill *
      policy *
      config.production.laborCapacityFactor,
  );
}

/**
 * 企业先按配方缺口采购生产资料。
 *
 * 采购预算 = 自有现金扣除工资预留（wageReserveMonths × 月工资 × 0.5）后的余额；
 * 预算不足时，按“准备成交的数量 × 真实成交报价”向银行申请周转贷补足，
 * 但必须先通过经营模式/玩家授权/提案/拒绝冷却的裁决（见 financing.ts）：
 * - 全面手动模式不自动举债，采购只能花自有现金；
 * - AI 辅助/高度托管模式在授权额度内自动放款，超出部分只生成待批准提案；
 * - 没有可售供应（本地与跨城都没有）时不融资，避免凭空增加债务；
 * - 融资失败或被拒绝时不成交，不会留下部分成交或无关贷款；
 * - 跨城补货按真实报价（含运输加成）估算缺口，避免多借。
 *
 * 需求记账口径（验收复验）：
 * - producerRequired：按生产计划需要采购的数量（资金不足前）。完全无供应时也必须记录，
 *   否则市场会把“真实缺货”显示成“没有需求”；
 * - producerDemand / demand：形成有效购买需求的数量 = 计划需求中
 *   “自有采购预算 + 合法可用授信”买得起的那部分（手动模式不把自动授信算作购买力）；
 * - 实际成交 = 本地成交 + 跨城进口（sold / intercityImported），两者不重复计入需求；
 * - unmetDemand：有效需求中因缺货/配送不足未成交的数量；
 * - unmetFunding：计划需求中因资金不足未形成有效需求的数量。
 * 因此 producerRequired 减实际成交 = unmetDemand + unmetFunding（每笔舍入 ≤ 0.01）。
 *
 * 有效需求只取决于购买力，不取决于可售数量：部分供应时不会把可售数量当成全部需求；
 * 购买力按当前可成交来源的最低价估算，没有可售供应时退化为市场价。
 *
 * v1.2 两阶段成交（各城产业循环公平性）：
 * - 阶段 A：所有企业先按优先级买完本地可售库存（本地卖家与买家同城）；
 * - 阶段 B：仍缺货的企业才跨城，可售供给按“各企业剩余缺口”加权分配
 *   （最大余数到 0.01），成交前重新核对预算与授信。
 * 阶段顺序只改变成交先后，不改变需求记账、融资裁决与账本口径。
 */
export interface InputPurchasingOptions {
  /**
   * v1.3 §4：月内采购轮次（1 起）。
   * - 第 1 轮：按整月生产计划记录需求（producerRequired/producerDemand/unmetDemand/unmetFunding）
   *   并完成本地/跨城成交；
   * - 第 2 轮及以后：为本月剩余计划再采购刚刚生产出来的原料。需求已在第 1 轮记账，
   *   因此本轮不再新增需求，只在本轮成交后按成交数量冲减对应城市的 unmetDemand
   *   （原“缺货”被本月新产出补上了），避免同一需求被重复计入。
   */
  round?: number;
}

export function runInputPurchasing(
  world: WorldState,
  ledgers: WorldLedgers,
  config: DemoConfig,
  log: LogEntry[],
  options: InputPurchasingOptions = {},
): void {
  const tick = world.time.tick;
  const round = Math.max(1, Math.floor(options.round ?? 1));
  const recordDemand = round <= 1;
  const ordered = [...world.companies].sort((a, b) => {
    const priority = (company: Company): number => {
      const city = world.cities.find((candidate) => candidate.id === company.cityId);
      const recipe = RECIPES[company.recipeOutput];
      if (!city || !recipe) return 0;
      return recipe.inputs.reduce(
        (total, input) =>
          total + (city.market[input.good]?.price ?? 0) * input.qty,
        0,
      );
    };
    return priority(b) - priority(a) || a.id.localeCompare(b.id);
  });

  // v1.2：先完成所有企业的需求记账与融资裁决（口径不变），再分两阶段成交：
  // 阶段 A 所有企业先买本地，阶段 B 跨城按剩余缺口比例分配。
  const purchases: CompanyInputPurchasing[] = [];

  for (const company of ordered) {
    const city = world.cities.find((candidate) => candidate.id === company.cityId);
    const cityLedgers = ledgers[company.cityId];
    if (!city || !cityLedgers) continue;
    const recipe = RECIPES[company.recipeOutput];
    if (!recipe || recipe.inputs.length === 0) continue;

    // v1.3 §4：第 2 轮只为“本月剩余计划”补料，已生产部分不再重复采购。
    const producedThisMonth = Math.max(0, company.lastMonth.produced);
    const monthlyTarget = Math.min(
      productionTarget(company),
      laborCapacity(company, city, config, world),
    );
    const target = round2(
      recordDemand ? monthlyTarget : Math.max(0, monthlyTarget - producedThisMonth),
    );
    if (target <= 0) continue;
    const shortages = recipe.inputs.map((input) => {
      const required = round2(target * input.qty);
      const inStock = company.inventory[input.good] ?? 0;
      return { input, shortage: Math.max(0, round2(required - inStock)) };
    });
    if (shortages.every((entry) => entry.shortage <= 0)) continue;

    const wage = monthlyWageBill(company, config);
    const wageReserve = wage * config.company.wageReserveMonths * 0.5;
    let budget = round2(Math.max(0, company.cash - wageReserve));

    // 1) 计划需求与可售供应：先完整收集，再决定融资与成交。
    //    完全没有供应时也保留需求，避免“needs 为空 → 提前跳过 → 市场显示 0 需求”。
    const plans: InputPurchasePlan[] = shortages
      .filter((entry) => entry.shortage > 0)
      .map((entry) => {
        const goodId = entry.input.good;
        const price = city.market[goodId]?.price ?? 1;
        let localStock = 0;
        let intercitySupply = 0;
        for (const other of world.companies) {
          if (other.id === company.id) continue;
          const stock = offeredStock(other, goodId);
          if (!(stock > 0)) continue;
          if (other.cityId === city.id) localStock += stock;
          else intercitySupply += stock;
        }
        return {
          goodId,
          shortage: entry.shortage,
          price,
          localStock: round2(localStock),
          intercitySupply: round2(intercitySupply),
          supplyQty: round2(localStock + intercitySupply),
        };
      });
    if (plans.length === 0) continue;

    // 2) 融资裁决：只有存在可售供应时才裁决/放款；没有供应不借款、也不生成提案。
    //    估算金额按真实成交报价（本地卖家价格系数、配送效率、跨城运输加成）。
    const financeable = plans.filter((plan) => plan.supplyQty > 0.01);
    let creditRoom = 0;
    if (financeable.length > 0) {
      const estimatedSpend = round2(
        financeable.reduce((total, plan) => {
          const executable = Math.min(plan.shortage, plan.supplyQty);
          const localQuote = quoteLocalPurchase(
            world,
            city,
            plan.goodId,
            executable,
            Number.MAX_SAFE_INTEGER,
            company.id,
          );
          const rest = round2(executable - localQuote.qty);
          const importedCost =
            rest > 0.01
              ? quoteIntercityPurchase(
                  world,
                  city,
                  plan.goodId,
                  rest,
                  Number.MAX_SAFE_INTEGER,
                  config,
                  company.id,
                ).cost
              : 0;
          return round2(total + localQuote.cost + importedCost);
        }, 0),
      );
      const financing = planCompanyWorkingCapital(
        world,
        config,
        tick,
        company,
        round2(Math.max(0, estimatedSpend - budget)),
        '生产采购现金不足',
      );
      creditRoom = financing.limit;
      if (financing.denied && estimatedSpend > budget + 0.01) {
        log.push({
          tick,
          kind: 'warning',
          message: `${company.name} 采购受可用现金限制：${financing.reason}`,
        });
      }
    }

    // 3) 记录需求：计划需求 / 有效需求 / 资金不足未满足。
    //    有效需求只取决于购买力（采购预算 + 合法可用授信），不取决于可售数量；
    //    部分供应时不会把可售数量当成全部需求，资金不足也不会伪装成缺货。
    //
    //    购买力是一笔共享预算，分两步分配，避免同一笔现金被多个商品重复计入：
    //    3a) 先为“本月确实可能成交的数量”预留现金（按真实报价），保证有货的投入品不被缺货挤占；
    //    3b) 剩余购买力按“尚未被可售供应覆盖的需求金额”比例分配，全部缺货时也不会把
    //        同一笔预算同时记成多个商品的有效需求。
    const legalCredit = round2(legalWorkingCapitalRoom(world, config, tick, company));
    let demandFunds = round2(budget + (financeable.length > 0 ? creditRoom : legalCredit));
    const unitPrices = plans.map((plan) =>
      estimatedUnitPrice(world, city, plan.goodId, company.id, plan.price, config),
    );
    const fundedExecutable = plans.map(() => 0);
    plans.forEach((plan, index) => {
      if (plan.supplyQty <= 0.01) return;
      const unitPrice = unitPrices[index] ?? 0;
      const affordable =
        unitPrice > 0 ? Math.floor((demandFunds / unitPrice) * 100) / 100 : 0;
      const executable = Math.min(plan.shortage, plan.supplyQty);
      const funded = round2(Math.min(executable, affordable));
      fundedExecutable[index] = funded;
      demandFunds = round2(Math.max(0, demandFunds - funded * unitPrice));
    });

    const uncoveredCost = round2(
      plans.reduce(
        (total, plan, index) =>
          total +
          Math.max(0, round2(plan.shortage - (fundedExecutable[index] ?? 0))) *
            (unitPrices[index] ?? 0),
        0,
      ),
    );
    const claimedDemand = plans.map(() => 0);
    if (demandFunds > 0.005 && uncoveredCost > 0.005) {
      plans.forEach((plan, index) => {
        const unitPrice = unitPrices[index] ?? 0;
        const uncovered = Math.max(0, round2(plan.shortage - (fundedExecutable[index] ?? 0)));
        if (uncovered <= 0.01 || unitPrice <= 0) return;
        const share = (uncovered * unitPrice) / uncoveredCost;
        const affordable = Math.floor(((demandFunds * share) / unitPrice) * 100) / 100;
        claimedDemand[index] = round2(Math.min(uncovered, affordable));
      });
    }

    const accounted = plans.map((plan, index) => {
      // 第 2 轮：需求已在第 1 轮记账，本轮只按剩余缺口采购，不再重复记需求。
      const effectiveDemand = recordDemand
        ? round2((fundedExecutable[index] ?? 0) + (claimedDemand[index] ?? 0))
        : round2(plan.shortage);
      const ledger = cityLedgers[plan.goodId];
      if (ledger && recordDemand) {
        ledger.producerRequired = round2(ledger.producerRequired + plan.shortage);
        ledger.producerDemand = round2(ledger.producerDemand + effectiveDemand);
        ledger.demand = round2(ledger.demand + effectiveDemand);
        ledger.unmetFunding = round2(
          ledger.unmetFunding + Math.max(0, round2(plan.shortage - effectiveDemand)),
        );
      }
      return { ...plan, effectiveDemand };
    });

    // 4) 成交推迟到下面的阶段 A/B；这里只保存本企业的采购上下文，
    //    预算与授信额度在成交时继续扣减。
    purchases.push({
      company,
      city,
      cityLedgers,
      plans: accounted,
      budget,
      creditRoom,
      bought: accounted.map(() => 0),
    });
  }

  // 第 2 轮（及以后）：本轮能成交的数量必须落在“第 1 轮已记账但尚未满足的需求”之内。
  // 否则 sold 会超过 demand（不变量校验失败），也会把同一份需求重复计入成交。
  // 按“城市 + 商品”把该城账本的 unmetDemand 作为本轮可购买上限，再按各企业剩余
  // 计划缺口加权分配（最大余数到 0.01），避免先到先得。
  if (!recordDemand) {
    interface RoundTwoDemand {
      pending: CompanyInputPurchasing;
      index: number;
      requested: number;
    }
    const groups = new Map<string, { ledger: (typeof ledgers)[string][GoodId]; demands: RoundTwoDemand[] }>();
    for (const pending of purchases) {
      pending.plans.forEach((plan, index) => {
        if (plan.effectiveDemand <= 0.01) return;
        const ledger = pending.cityLedgers[plan.goodId];
        if (!ledger) return;
        const key = `${pending.city.id}|${plan.goodId}`;
        const group = groups.get(key) ?? { ledger, demands: [] };
        group.demands.push({ pending, index, requested: plan.effectiveDemand });
        groups.set(key, group);
      });
    }
    for (const group of groups.values()) {
      const cap = Math.max(0, round2(group.ledger.unmetDemand ?? 0));
      const requested = round2(group.demands.reduce((total, demand) => total + demand.requested, 0));
      const granted = allocateByWeight(
        round2(Math.min(cap, requested)),
        group.demands.map((demand) => demand.requested),
      );
      group.demands.forEach((demand, position) => {
        const plan = demand.pending.plans[demand.index]!;
        plan.effectiveDemand = round2(granted[position] ?? 0);
      });
    }
  }

  // 阶段 A：所有企业先买完全部本地可售库存。
  // 本地卖家与买家同城，属于本城产业循环；先让所有城市的本地采购成交，
  // 再开始跨城采购，避免排序靠前的大厂先到先得，把别城卖家的库存买空、
  // 让卖家本城的产业只能吃跨城剩货（v1.1 消费侧公平性修复的同构问题）。
  for (const pending of purchases) {
    for (let index = 0; index < pending.plans.length; index += 1) {
      const plan = pending.plans[index]!;
      if (plan.effectiveDemand <= 0.01 || plan.localStock <= 0.01) continue;
      const company = pending.company;
      // 本地采购：先按真实报价估算所需现金，再在已裁决额度内放款（每笔独立合同）。
      const localQuote = quoteLocalPurchase(
        world,
        pending.city,
        plan.goodId,
        plan.effectiveDemand,
        pending.budget + pending.creditRoom,
        company.id,
      );
      if (localQuote.qty > 0 && pending.budget < localQuote.cost - 0.01 && pending.creditRoom > 0) {
        const needed = round2(Math.min(localQuote.cost - pending.budget, pending.creditRoom));
        const drawn = drawPlannedWorkingCapital(world, config, tick, company, needed);
        if (drawn > 0) {
          pending.budget = round2(pending.budget + drawn);
          pending.creditRoom = round2(Math.max(0, pending.creditRoom - drawn));
        }
      }
      const local = executePurchase(
        world,
        pending.city,
        pending.cityLedgers,
        plan.goodId,
        plan.effectiveDemand,
        pending.budget,
        { buyerCompanyId: company.id },
      );
      pending.budget = Math.max(0, round2(pending.budget - local.spend));
      pending.bought[index] = round2((pending.bought[index] ?? 0) + local.qty);
      // v1.3 §4：第 2 轮的市场供给口径。期初 supply 只统计“当时的可售库存”，
      // 生产消耗后原本为生产预留的库存会重新变为可售并可能在第二轮成交；
      // 这部分成交同样来自当月可供库存，因此把 supply 抬到“已成交数量”以上，
      // 保持 sold ≤ supply + intercityImported 不变量（与设备账本 pendingLedger 的
      // “sold 同时计入 supply”口径一致）。
      if (!recordDemand && local.qty > 0) {
        const ledger = pending.cityLedgers[plan.goodId];
        if (ledger) ledger.supply = round2(Math.max(ledger.supply, ledger.sold));
      }
    }
  }

  // 阶段 B：跨城采购按“各企业剩余缺口比例”分配可售供给。
  // 阶段 A 之后仍缺货的企业才进入跨城；可售供给是其他城市剩余库存，
  // 按缺口加权（最大余数到 0.01）分摊，任何一个城市/企业都不能先到先得吃光。
  interface IntercityDemand {
    pending: CompanyInputPurchasing;
    index: number;
    remaining: number;
  }
  const demandsByGood = new Map<GoodId, IntercityDemand[]>();
  for (const pending of purchases) {
    for (let index = 0; index < pending.plans.length; index += 1) {
      const plan = pending.plans[index]!;
      const remaining = round2(plan.effectiveDemand - (pending.bought[index] ?? 0));
      if (remaining <= 0.01 || plan.intercitySupply <= 0.01) continue;
      if (pending.budget + pending.creditRoom <= 0.01) continue;
      const list = demandsByGood.get(plan.goodId) ?? [];
      list.push({ pending, index, remaining });
      demandsByGood.set(plan.goodId, list);
    }
  }
  for (const [goodId, demands] of demandsByGood) {
    const totalGap = round2(demands.reduce((total, demand) => total + demand.remaining, 0));
    if (totalGap <= 0.01) continue;
    // 按城市统计阶段 A 之后的剩余可售库存。买方本城的剩余库存不再参与跨城分配：
    // 它只能通过阶段 A 的本地成交卖出；若把它算进跨城可售，会让份额被本地库存“虚增”，
    // 却无法真正成交（v1.2 §1：本地有效需求优先，剩余才跨城）。
    const stockByCity = new Map<string, number>();
    for (const seller of world.companies) {
      const qty = offeredStock(seller, goodId);
      if (qty <= 0.01) continue;
      stockByCity.set(seller.cityId, round2((stockByCity.get(seller.cityId) ?? 0) + qty));
    }
    const totalStock = round2([...stockByCity.values()].reduce((total, qty) => total + qty, 0));
    if (totalStock <= 0.01) continue;
    const crossAvailable = (cityId: string): number =>
      round2(Math.max(0, totalStock - (stockByCity.get(cityId) ?? 0)));
    if (demands.every((demand) => crossAvailable(demand.pending.city.id) <= 0.01)) continue;
    // 跨城成交总量不超过“缺口总量”，也不超过“其他城市剩余可售供给”，按缺口比例分摊；
    // 每个买方再按“其他城市可售”上限回调，未用完的额度进入下一轮重新按比例分配，
    // 仍然不是先到先得。
    const allocations: number[] = demands.map(() => 0);
    let pool = totalStock;
    for (let pass = 0; pass < 3 && pool > 0.01; pass += 1) {
      const eligible = demands
        .map((demand, index) => ({ demand, index }))
        .filter(
          ({ demand, index }) =>
            demand.remaining - (allocations[index] ?? 0) > 0.01 &&
            crossAvailable(demand.pending.city.id) - (allocations[index] ?? 0) > 0.01,
        );
      if (eligible.length === 0) break;
      const gapSum = round2(
        eligible.reduce(
          (total, { demand, index }) => total + demand.remaining - (allocations[index] ?? 0),
          0,
        ),
      );
      if (gapSum <= 0.01) break;
      const shares = allocateByWeight(
        round2(Math.min(gapSum, pool)),
        eligible.map(({ demand, index }) => demand.remaining - (allocations[index] ?? 0)),
      );
      let used = 0;
      eligible.forEach(({ demand, index }, position) => {
        const remainingGap = round2(demand.remaining - (allocations[index] ?? 0));
        const room = round2(
          crossAvailable(demand.pending.city.id) - (allocations[index] ?? 0),
        );
        const granted = round2(
          Math.max(0, Math.min(shares[position] ?? 0, remainingGap, room)),
        );
        allocations[index] = round2((allocations[index] ?? 0) + granted);
        used = round2(used + granted);
      });
      if (used <= 0.01) break;
      pool = round2(pool - used);
    }
    demands.forEach((demand, index) => {
      const pending = demand.pending;
      const company = pending.company;
      const allocated = round2(Math.min(allocations[index] ?? 0, demand.remaining));
      if (allocated <= 0.01) return;
      // 成交前重新核对预算/授信：预算不足时再按真实报价申请已裁决额度内的周转贷。
      const quote = quoteIntercityPurchase(
        world,
        pending.city,
        goodId,
        allocated,
        pending.budget + pending.creditRoom,
        config,
        company.id,
      );
      const needed = round2(Math.max(0, quote.cost - pending.budget));
      if (needed > 0.01 && pending.creditRoom > 0) {
        const drawn = drawPlannedWorkingCapital(
          world,
          config,
          tick,
          company,
          round2(Math.min(needed, pending.creditRoom)),
        );
        if (drawn > 0) {
          pending.budget = round2(pending.budget + drawn);
          pending.creditRoom = round2(Math.max(0, pending.creditRoom - drawn));
        }
      }
      if (pending.budget <= 0.01) return;
      const imported = executeIntercityPurchase(
        world,
        pending.city,
        pending.cityLedgers,
        goodId,
        allocated,
        pending.budget,
        { buyerCompanyId: company.id },
        config,
      );
      pending.budget = Math.max(0, round2(pending.budget - imported.spend));
      pending.bought[demand.index] = round2((pending.bought[demand.index] ?? 0) + imported.qty);
    });
  }

  // 需求收尾：缺货只按“有效需求 − 本地成交 − 跨城成交”记一次。
  // 第 2 轮不再新增需求：本轮用本月新产出补上的数量，直接从第 1 轮记录的
  // unmetDemand 中冲减（这部分缺货已经被当月的采购满足，不是新增需求）。
  for (const pending of purchases) {
    pending.plans.forEach((plan, index) => {
      if (plan.effectiveDemand <= 0.01) return;
      const ledger = pending.cityLedgers[plan.goodId];
      if (!recordDemand) {
        const bought = pending.bought[index] ?? 0;
        if (ledger && bought > 0.01) {
          ledger.unmetDemand = round2(Math.max(0, round2(ledger.unmetDemand - bought)));
        }
        return;
      }
      if (plan.supplyQty <= 0.01) {
        if (ledger) {
          ledger.unmetDemand = round2(ledger.unmetDemand + plan.effectiveDemand);
        }
        log.push({
          tick,
          kind: 'market',
          message: `${pending.company.name} 需要 ${plan.shortage.toFixed(0)} ${plan.goodId}，但本地与跨城都没有可售供应（缺货 ${plan.effectiveDemand.toFixed(0)}）。`,
        });
        return;
      }
      const bought = pending.bought[index] ?? 0;
      if (ledger) {
        ledger.unmetDemand = round2(
          ledger.unmetDemand + Math.max(0, round2(plan.effectiveDemand - bought)),
        );
      }
      if (bought < plan.shortage - 0.01) {
        log.push({
          tick,
          kind: 'market',
          message: `${pending.company.name} 未能足额采购 ${plan.goodId}（计划 ${plan.shortage.toFixed(0)}，有效需求 ${plan.effectiveDemand.toFixed(0)}，成交 ${bought.toFixed(0)}）。`,
        });
      }
    });
  }
}

/**
 * 估算“买得起多少”时使用的单价：取当前可成交来源中的最低真实单价，
 * 完全没有可售供应时退化为市场价。只用于需求记账，不参与成交计价。
 */
function estimatedUnitPrice(
  world: WorldState,
  city: City,
  goodId: GoodId,
  excludeCompanyId: string,
  marketPrice: number,
  config: DemoConfig,
): number {
  const candidates: number[] = [];
  const local = quoteLocalPurchase(
    world,
    city,
    goodId,
    1,
    Number.MAX_SAFE_INTEGER,
    excludeCompanyId,
  );
  if (local.qty > 0 && local.cost > 0) candidates.push(local.cost / local.qty);
  const imported = quoteIntercityPurchase(
    world,
    city,
    goodId,
    1,
    Number.MAX_SAFE_INTEGER,
    config,
    excludeCompanyId,
  );
  if (imported.qty > 0 && imported.cost > 0) candidates.push(imported.cost / imported.qty);
  if (candidates.length === 0) return Math.max(0.01, marketPrice);
  return Math.max(0.01, round2(Math.min(...candidates)));
}

/** 按配方消耗库存并生产。产出受产能、当期劳动力和原料库存共同限制。 */
export function runProduction(
  world: WorldState,
  ledgers: WorldLedgers,
  config: DemoConfig,
): ProductionRecord[] {
  const records: ProductionRecord[] = [];
  const ordered = [...world.companies].sort((a, b) => a.id.localeCompare(b.id));

  for (const company of ordered) {
    const city = world.cities.find((candidate) => candidate.id === company.cityId);
    const cityLedgers = ledgers[company.cityId];
    if (!city || !cityLedgers) continue;
    const recipe = RECIPES[company.recipeOutput];
    if (!recipe) continue;
    // v1.0：实际产量 = min(计划, 设备产能, 劳动产能)，再在下面按原料库存收紧。
    // 计划本身已 ≤ min(设备, 劳动, 原料资金)，这里再显式夹一次，防止旧档/手动改计划越界。
    // v1.3 §4：runProduction 每月可能被调用多轮（月内分阶段生产），这里统一按
    // “本月剩余计划 / 剩余设备产能 / 剩余劳动产能”计算，保证两轮合计不超过月度上限、
    // 也不会因为分轮而重复使用同一份劳动或设备。
    const producedThisMonth = Math.max(0, company.lastMonth.produced);
    const equipmentLimit = company.productionPlan
      ? Math.max(0, company.productionPlan.equipmentLimit)
      : Math.max(0, company.capacity);
    const monthlyTarget = productionTarget(company);
    const remainingTarget = Math.max(0, monthlyTarget - producedThisMonth);
    const remainingEquipment = Math.max(0, equipmentLimit - producedThisMonth);
    const remainingLabor = Math.max(
      0,
      laborCapacity(company, city, config, world) - producedThisMonth,
    );
    let output = Math.min(remainingTarget, remainingEquipment, remainingLabor);
    if (output <= 0) continue;

    for (const input of recipe.inputs) {
      const available = company.inventory[input.good] ?? 0;
      const possible = available / Math.max(1e-9, input.qty);
      output = Math.min(output, possible);
    }
    output = Math.max(0, Math.floor(output * 100) / 100);
    if (output <= 0) continue;

    const consumed: ProductionRecord['inputs'] = [];
    let inputValue = 0;
    // v1.3：生产消耗原料不直接计入费用，而是按账面移动加权平均成本转入成品存货。
    // consumedCost 汇总为本批成品的入账成本；inputValue 仍按市场价记录产出法增值（GDP 口径不变）。
    let consumedCost = 0;
    for (const input of recipe.inputs) {
      const qty = round2(output * input.qty);
      const price = city.market[input.good]?.price ?? 0;
      const available = company.inventory[input.good] ?? 0;
      if (qty > available + 1e-6) {
        throw new Error(`企业 ${company.id} 原料不足，生产事务失败`);
      }
      consumedCost = round2(consumedCost + issueInventory(company, input.good, qty));
      if ((company.inventory[input.good] ?? 0) < 0) company.inventory[input.good] = 0;
      const value = round2(qty * price);
      inputValue = round2(inputValue + value);
      consumed.push({ good: input.good, qty, value });
    }

    const outputPrice = city.market[company.recipeOutput]?.price ?? 0;
    const outputValue = round2(output * outputPrice);
    receiveInventory(company, company.recipeOutput, output, consumedCost);
    company.lastMonth.produced = round2(company.lastMonth.produced + output);
    recordProducedSupply(cityLedgers, company.recipeOutput, output);

    records.push({
      tick: world.time.tick,
      cityId: city.id,
      companyId: company.id,
      good: company.recipeOutput,
      qty: output,
      outputValue,
      inputValue,
      valueAdded: round2(outputValue - inputValue),
      inputs: consumed,
    });
  }
  return records;
}

/** 供 UI 展示的单位员工产出，不参与结算。 */
export function productivityFor(company: Company): number {
  return PRODUCTIVITY[company.recipeOutput] ?? 0;
}

export function companyInputGoods(company: Company): string[] {
  return RECIPES[company.recipeOutput]?.inputs.map((input) => input.good) ?? [];
}

export function inventoryTotal(company: Company): number {
  return GOOD_IDS.reduce((total, goodId) => total + (company.inventory[goodId] ?? 0), 0);
}
