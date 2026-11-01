import type { Company, ProductionRecord, WorldState, LogEntry } from '../contracts/types';
import type { DemoConfig } from '../../data/config';
import type { CityLedgers, WorldLedgers } from '../markets/markets';
import { applyProducerPurchase, recordProducedSupply } from '../markets/markets';
import { executeIntercityPurchase } from '../markets/intercity';
import { GOOD_IDS } from '../companies/company';
import { PRODUCTIVITY, RECIPES } from '../../data/demo-data';
import { round2 } from '../core/math';
import { monthlyWageBill } from '../companies/company';
import { ensureLiquidity } from '../companies/credit';

export function productionTarget(company: Company): number {
  return Math.max(0, round2(company.capacity * company.utilization));
}

/**
 * 企业先按配方缺口采购生产资料。采购受现金和本城可售库存约束，
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

    const target = productionTarget(company);
    if (target <= 0) continue;
    const shortages = recipe.inputs.map((input) => {
      const required = round2(target * input.qty);
      const inStock = company.inventory[input.good] ?? 0;
      return { input, shortage: Math.max(0, round2(required - inStock)) };
    });
    if (shortages.every((entry) => entry.shortage <= 0)) continue;

    const wage = monthlyWageBill(company);
    // 只有确实需要采购时才申请营运资金信贷，避免“无需采购却新增债务”。
    ensureLiquidity(company, wage * 1.5, config);
    const wageReserve = wage * config.company.wageReserveMonths * 0.5;
    let budget = Math.max(0, company.cash - wageReserve);

    for (const { input, shortage } of shortages) {
      if (shortage <= 0 || budget <= 0) continue;
      const price = city.market[input.good]?.price ?? 1;
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

/** 按配方消耗库存并生产。产出受产能、原料库存和设备利用率共同限制。 */
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
    let output = productionTarget(company);
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
