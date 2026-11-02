import type { City, Company, ProductionRecord, WorldState, LogEntry } from '../contracts/types';
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
import { planCompanyWorkingCapital, drawPlannedWorkingCapital } from '../management/financing';
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
 * 预算不足时，按“可实际成交的数量 × 当前价格”向银行申请周转贷补足，
 * 但必须先通过经营模式/玩家授权/提案/拒绝冷却的裁决（见 financing.ts）：
 * - 全面手动模式不自动举债，采购只能花自有现金；
 * - AI 辅助/高度托管模式在授权额度内自动放款，超出部分只生成待批准提案；
 * - 没有可售供应（本地与跨城都没有）时不融资，避免凭空增加债务；
 * - 融资失败或被拒绝时不成交，不会留下部分成交或无关贷款；
 * - 跨城补货按真实报价（含运输加成）估算缺口，避免多借。
 *
 * 缺口写入市场未满足需求，不会凭空生成原料。
 */
export function runInputPurchasing(
  world: WorldState,
  ledgers: WorldLedgers,
  config: DemoConfig,
  log: LogEntry[],
): void {
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
    let budget = Math.max(0, company.cash - wageReserve);
    let purchaseSpend = 0;

    // 验收问题 2/7 与复验：玩家经营企业的采购融资必须先过经营模式/授权/拒绝冷却；
    // 获批额度在成交前放款（每笔独立合同），避免“采购已成交、借款却失败”的部分状态。
    // 估算金额只按“可实际成交的数量 × 当前价格”，无供应时不融资。
    const needs = shortages
      .filter((entry) => entry.shortage > 0)
      .map((entry) => {
        const price = city.market[entry.input.good]?.price ?? 1;
        const localStock = world.companies.reduce(
          (total, other) =>
            other.cityId === city.id && other.id !== company.id
              ? total + offeredStock(other, entry.input.good)
              : total,
          0,
        );
        const intercitySupply = world.companies.reduce(
          (total, other) =>
            other.cityId !== city.id ? total + offeredStock(other, entry.input.good) : total,
          0,
        );
        // 与真实成交规则一致的报价：授权裁决与放款金额都按它计算，
        // 避免按市价粗略估算导致多借、或借了却买不到。
        const localQuote = quoteLocalPurchase(
          world,
          city,
          entry.input.good,
          entry.shortage,
          Number.MAX_SAFE_INTEGER,
          company.id,
        );
        const remaining = round2(entry.shortage - localQuote.qty);
        const intercityQuote =
          remaining > 0.01
            ? quoteIntercityPurchase(
                world,
                city,
                entry.input.good,
                remaining,
                Number.MAX_SAFE_INTEGER,
                config,
                company.id,
              )
            : { qty: 0, cost: 0 };
        const executable = round2(localQuote.qty + intercityQuote.qty);
        const estimatedCost = round2(localQuote.cost + intercityQuote.cost);
        return { ...entry, price, localStock, intercitySupply, executable, estimatedCost };
      })
      .filter((entry) => entry.executable > 0.01);
    if (needs.length === 0) continue;

    const estimatedSpend = round2(
      needs.reduce((total, entry) => total + entry.estimatedCost, 0),
    );
    const financing = planCompanyWorkingCapital(
      world,
      config,
      world.time.tick,
      company,
      round2(Math.max(0, estimatedSpend - budget)),
      '生产采购现金不足',
    );
    let creditRoom = financing.limit;
    if (financing.denied && estimatedSpend > budget + 0.01) {
      log.push({
        tick: world.time.tick,
        kind: 'warning',
        message: `${company.name} 采购受可用现金限制：${financing.reason}`,
      });
    }

    for (const { input, shortage, price, localStock, intercitySupply, executable } of needs) {

      // 验收复验：采购预算为 0（例如现金全部被工资预留占用）时，
      // 只要存在真实需求、可售供应与合法授信，仍应先在经营模式/授权内融资再采购。
      // 借款金额按真实成交报价估算；融资失败或未获授权则不成交。
      const localQuote = quoteLocalPurchase(
        world,
        city,
        input.good,
        shortage,
        budget + creditRoom,
        company.id,
      );
      if (localQuote.qty > 0 && budget < localQuote.cost - 0.01 && creditRoom > 0) {
        const need = round2(Math.min(localQuote.cost - budget, creditRoom));
        const drawn = drawPlannedWorkingCapital(world, config, world.time.tick, company, need);
        if (drawn > 0) {
          budget = round2(budget + drawn);
          creditRoom = round2(Math.max(0, creditRoom - drawn));
        }
      }

      // 需求按“本月可供成交的数量”记账（含本地与跨城可售），
      // 成交后把差额记入未满足需求；这样本地成交 + 跨城进口不会超过需求。
      const ledger = cityLedgers[input.good];
      if (ledger) {
        ledger.producerDemand = round2(ledger.producerDemand + executable);
        ledger.demand = round2(ledger.demand + executable);
      }

      const result = executePurchase(world, city, cityLedgers, input.good, executable, budget, {
        buyerCompanyId: company.id,
      });
      budget = Math.max(0, budget - result.spend);
      purchaseSpend = round2(purchaseSpend + result.spend);
      let bought = result.qty;

      const remainingDemand = round2(executable - result.qty);
      if (remainingDemand > 0.01 && intercitySupply > 0.01) {
        // 跨城报价含运输加成：先按实际报价估算缺口再放款，避免多借或借了却买不到。
        const quote = quoteIntercityPurchase(
          world,
          city,
          input.good,
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
            world.time.tick,
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
            input.good,
            remainingDemand,
            budget,
            { buyerCompanyId: company.id },
            config,
          );
          budget = Math.max(0, budget - imported.spend);
          purchaseSpend = round2(purchaseSpend + imported.spend);
          bought = round2(bought + imported.qty);
        }
      }

      if (ledger) {
        ledger.unmetDemand = round2(ledger.unmetDemand + Math.max(0, executable - bought));
      }

      if (bought < shortage - 0.01) {
        log.push({
          tick: world.time.tick,
          kind: 'market',
          message: `${company.name} 未能足额采购 ${input.good}（需求 ${shortage.toFixed(0)}，成交 ${bought.toFixed(0)}）。`,
        });
      }
    }

  }
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
