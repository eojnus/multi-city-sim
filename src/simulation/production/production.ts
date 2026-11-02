import type { City, Company, ProductionRecord, WorldState, LogEntry } from '../contracts/types';
import type { DemoConfig } from '../../data/config';
import { DEMO_CONFIG } from '../../data/config';
import type { CityLedgers, WorldLedgers } from '../markets/markets';
import { applyProducerPurchase, offeredStock, recordProducedSupply } from '../markets/markets';
import { executeIntercityPurchase } from '../markets/intercity';
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
 * 企业先按配方缺口采购生产资料。采购只使用自有现金（保留 wageReserve），
 * 本地/跨城成交完成后再按实际成交金额补足现金，最多补到 wage * 1.5：
 * 借款上限 = min(本月实际采购支出, 补到 wage * 1.5 的现金缺口, 可用信贷额度)。
 *
 * 这是【暂定行为】，对应 DEMO_CONFIG.company.purchaseCreditMode === 'on-settlement'。
 * 用户的待决问题“无供应时是否允许独立备资借款”仍未决定：
 * - 成交型融资不会让企业在没有供应时凭空增加债务，但没有成交时也不能提前囤积现金；
 * - 如果以后允许预借款，应新增独立配置项，而不是恢复旧的采购前 ensureLiquidity。
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

    // 验收问题 2/7：玩家经营企业的采购融资必须先过经营模式/授权/拒绝冷却；
    // 获批额度在成交前放款（每笔独立合同），避免“采购已成交、借款却失败”的部分状态。
    // 只按“本地可售库存 + 现金缺口”估算额度，不会在没有供应时凭空举债。
    const estimatedSpend = shortages.reduce((total, entry) => {
      const price = city.market[entry.input.good]?.price ?? 1;
      return total + entry.shortage * Math.max(0, price);
    }, 0);
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

    for (const { input, shortage } of shortages) {
      if (shortage <= 0 || budget <= 0) continue;
      const price = city.market[input.good]?.price ?? 1;
      // 本地没有可售库存时不融资（避免“借了钱却没有成交、凭空增加债务”）。
      const localStock = world.companies.reduce(
        (total, other) =>
          other.cityId === city.id && other.id !== company.id
            ? total + offeredStock(other, input.good)
            : total,
        0,
      );
      if (localStock > 0.01 && creditRoom > 0 && budget < shortage * price) {
        const need = round2(Math.max(0, shortage * price - budget));
        const drawn = drawPlannedWorkingCapital(
          world,
          config,
          world.time.tick,
          company,
          round2(Math.min(need, creditRoom)),
        );
        if (drawn > 0) {
          budget = round2(budget + drawn);
          creditRoom = round2(Math.max(0, creditRoom - drawn));
        }
      }
      const affordable = Math.min(shortage, budget / Math.max(0.01, price));
      const result = applyProducerPurchase(
        world,
        city,
        cityLedgers,
        company,
        input.good,
        shortage,
        budget,
      );
      budget = Math.max(0, budget - result.spend);
      purchaseSpend = round2(purchaseSpend + result.spend);
      if (result.qty < shortage - 0.01 && budget > 0) {
        const remainingDemand = Math.max(0, affordable - result.qty);
        if (remainingDemand <= 0) continue;
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
        const ledger = cityLedgers[input.good];
        if (ledger) {
          ledger.unmetDemand = round2(Math.max(0, ledger.unmetDemand - imported.qty));
        }
      }
      if (result.qty < affordable - 0.01) {
        log.push({
          tick: world.time.tick,
          kind: 'market',
          message: `${company.name} 未能足额采购 ${input.good}（需求 ${shortage.toFixed(0)}，成交 ${result.qty.toFixed(0)}）。`,
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
