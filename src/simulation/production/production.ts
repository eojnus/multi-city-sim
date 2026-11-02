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

export function productionTarget(company: Company): number {
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
 */
export function runInputPurchasing(
  world: WorldState,
  ledgers: WorldLedgers,
  config: DemoConfig,
  log: LogEntry[],
): void {
  const tick = world.time.tick;
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

  for (const company of ordered) {
    const city = world.cities.find((candidate) => candidate.id === company.cityId);
    const cityLedgers = ledgers[company.cityId];
    if (!city || !cityLedgers) continue;
    const recipe = RECIPES[company.recipeOutput];
    if (!recipe || recipe.inputs.length === 0) continue;

    const target = Math.min(productionTarget(company), laborCapacity(company, city, config, world));
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
    let purchaseSpend = 0;

    // 1) 计划需求与可售供应：先完整收集，再决定融资与成交。
    //    完全没有供应时也保留需求，避免“needs 为空 → 提前跳过 → 市场显示 0 需求”。
    const plans = shortages
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
      const effectiveDemand = round2((fundedExecutable[index] ?? 0) + (claimedDemand[index] ?? 0));
      const ledger = cityLedgers[plan.goodId];
      if (ledger) {
        ledger.producerRequired = round2(ledger.producerRequired + plan.shortage);
        ledger.producerDemand = round2(ledger.producerDemand + effectiveDemand);
        ledger.demand = round2(ledger.demand + effectiveDemand);
        ledger.unmetFunding = round2(
          ledger.unmetFunding + Math.max(0, round2(plan.shortage - effectiveDemand)),
        );
      }
      return { ...plan, effectiveDemand };
    });

    // 4) 成交：只买有效需求内的量。无供应时不借款、不成交，只留下缺货未满足需求。
    for (const plan of accounted) {
      const ledger = cityLedgers[plan.goodId];
      if (plan.effectiveDemand <= 0.01) continue;

      if (plan.supplyQty <= 0.01) {
        if (ledger) {
          ledger.unmetDemand = round2(ledger.unmetDemand + plan.effectiveDemand);
        }
        log.push({
          tick,
          kind: 'market',
          message: `${company.name} 需要 ${plan.shortage.toFixed(0)} ${plan.goodId}，但本地与跨城都没有可售供应（缺货 ${plan.effectiveDemand.toFixed(0)}）。`,
        });
        continue;
      }

      // 本地采购：先按真实报价估算所需现金，再在已裁决额度内放款（每笔独立合同）。
      const localQuote = quoteLocalPurchase(
        world,
        city,
        plan.goodId,
        plan.effectiveDemand,
        budget + creditRoom,
        company.id,
      );
      if (localQuote.qty > 0 && budget < localQuote.cost - 0.01 && creditRoom > 0) {
        const needed = round2(Math.min(localQuote.cost - budget, creditRoom));
        const drawn = drawPlannedWorkingCapital(world, config, tick, company, needed);
        if (drawn > 0) {
          budget = round2(budget + drawn);
          creditRoom = round2(Math.max(0, creditRoom - drawn));
        }
      }
      const local = executePurchase(
        world,
        city,
        cityLedgers,
        plan.goodId,
        plan.effectiveDemand,
        budget,
        { buyerCompanyId: company.id },
      );
      budget = Math.max(0, round2(budget - local.spend));
      purchaseSpend = round2(purchaseSpend + local.spend);
      let bought = local.qty;

      // 跨城补货：只补本地未成交的部分，需求与未满足都不会重复计算。
      const remainingDemand = round2(plan.effectiveDemand - local.qty);
      if (
        remainingDemand > 0.01 &&
        plan.intercitySupply > 0.01 &&
        budget + creditRoom > 0
      ) {
        const quote = quoteIntercityPurchase(
          world,
          city,
          plan.goodId,
          remainingDemand,
          budget + creditRoom,
          config,
          company.id,
        );
        const needed = round2(Math.max(0, quote.cost - budget));
        if (needed > 0.01 && creditRoom > 0) {
          const drawn = drawPlannedWorkingCapital(
            world,
            config,
            tick,
            company,
            round2(Math.min(needed, creditRoom)),
          );
          if (drawn > 0) {
            budget = round2(budget + drawn);
            creditRoom = round2(Math.max(0, creditRoom - drawn));
          }
        }
        if (budget > 0) {
          const imported = executeIntercityPurchase(
            world,
            city,
            cityLedgers,
            plan.goodId,
            remainingDemand,
            budget,
            { buyerCompanyId: company.id },
            config,
          );
          budget = Math.max(0, round2(budget - imported.spend));
          purchaseSpend = round2(purchaseSpend + imported.spend);
          bought = round2(bought + imported.qty);
        }
      }

      if (ledger) {
        ledger.unmetDemand = round2(
          ledger.unmetDemand + Math.max(0, round2(plan.effectiveDemand - bought)),
        );
      }
      if (bought < plan.shortage - 0.01) {
        log.push({
          tick,
          kind: 'market',
          message: `${company.name} 未能足额采购 ${plan.goodId}（计划 ${plan.shortage.toFixed(0)}，有效需求 ${plan.effectiveDemand.toFixed(0)}，成交 ${bought.toFixed(0)}）。`,
        });
      }
    }

    void purchaseSpend;
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
    let output = Math.min(productionTarget(company), laborCapacity(company, city, config, world));
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
    for (const input of recipe.inputs) {
      const qty = round2(output * input.qty);
      const price = city.market[input.good]?.price ?? 0;
      const available = company.inventory[input.good] ?? 0;
      if (qty > available + 1e-6) {
        throw new Error(`企业 ${company.id} 原料不足，生产事务失败`);
      }
      company.inventory[input.good] = round2(available - qty);
      if (company.inventory[input.good] < 0 && company.inventory[input.good] > -1e-6) {
        company.inventory[input.good] = 0;
      }
      const value = round2(qty * price);
      inputValue = round2(inputValue + value);
      consumed.push({ good: input.good, qty, value });
    }

    const outputPrice = city.market[company.recipeOutput]?.price ?? 0;
    const outputValue = round2(output * outputPrice);
    company.inventory[company.recipeOutput] = round2(
      (company.inventory[company.recipeOutput] ?? 0) + output,
    );
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
