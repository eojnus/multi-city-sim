// v1.4 §7：多 seed 长期对照（只读观察，不修改世界规则）。
//
// 用法：
//   npx tsx scripts/v14-seed-compare.ts --months=36 --seeds=20261101,20261102,777001,424242
//
// 每个种子独立创建世界、玩家无操作、默认 AI；输出一行 JSON 便于汇总对比。
// 只报告真实模拟结果，不做断言；系统性问题（高失业/食品缺口）如实输出。
// 数据窗口说明：企业创办/倒闭明细受 config.lifecycle.maxHistory 截断；财政分项取城市“本月”快照；
// AI 政策执行与跨城贸易为逐月累计（脚本内存累计，不依赖被裁剪的历史）。

import { DEMO_CONFIG } from '../src/data/config';
import { GOODS } from '../src/data/demo-data';
import { Simulation } from '../src/simulation/core/simulation';
import { cityDebt } from '../src/simulation/government/metrics';
import type { City, WorldState } from '../src/simulation/contracts/types';

function argNumber(name: string, fallback: number): number {
  const prefix = `--${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  if (!match) return fallback;
  const value = Number(match.slice(prefix.length));
  return Number.isFinite(value) ? value : fallback;
}

function argList(name: string, fallback: number[]): number[] {
  const prefix = `--${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  if (!match) return fallback;
  const values = match
    .slice(prefix.length)
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((value) => Number.isFinite(value));
  return values.length > 0 ? values : fallback;
}

const round2 = (value: number): number => Math.round(value * 100) / 100;
const MONTHS = argNumber('months', 36);
const SEEDS = argList('seeds', [20261101, 20261102, 777001, 424242]);
const foodGood = GOODS.find((good) => good.id === 'food');
const perCapitaFoodNeed = foodGood?.perCapitaMonthlyNeed ?? 0;
const KEY_TRADE_GOODS = new Set(['food', 'grain', 'energy', 'farmEquipment', 'industryEquipment', 'energyEquipment']);
const cityGroupIds = (world: WorldState, cityId: string): Set<string> =>
  new Set(world.households.groups.filter((group) => group.cityId === cityId).map((group) => group.id));

function cityReport(world: WorldState, city: City, ai: AccumulatedAi, trade: AccumulatedTrade) {
  const foodMarket = city.market['food'];
  const basicNeed = city.population.total * perCapitaFoodNeed;
  const companies = world.companies.filter((company) => company.cityId === city.id);
  const activeCompanies = companies.filter((company) => company.status !== 'liquidated');
  const foodCompanies = companies.filter((company) => company.recipeOutput === 'food');
  const groupIds = cityGroupIds(world, city.id);
  const groups = world.households.groups.filter((group) => group.cityId === city.id);
  const sumGroup = (pick: (group: (typeof groups)[number]) => number) =>
    round2(groups.reduce((total, group) => total + pick(group), 0));
  const deposits = round2(
    world.banking.deposits
      .filter((account) => account.owner.kind === 'household' && groupIds.has(account.owner.id))
      .reduce((total, account) => total + account.balance, 0),
  );
  const loansOutstanding = round2(
    world.banking.loans
      .filter(
        (loan) =>
          loan.borrower.kind === 'household' &&
          groupIds.has(loan.borrower.id) &&
          loan.status === 'active',
      )
      .reduce((total, loan) => total + loan.outstanding, 0),
  );
  const grants = companies.filter((company) => company.initialEquipment);
  const initialUnits = grants.reduce((total, company) => total + (company.initialEquipment?.units ?? 0), 0);
  const initialValuation = round2(
    grants.reduce((total, company) => total + (company.initialEquipment?.valuation ?? 0), 0),
  );
  const purchasedThisMonth = round2(
    companies.reduce((total, company) => total + (company.lastMonth.equipmentPurchased ?? 0), 0),
  );
  const month = city.lastMonth;
  // v1.5 §3：食品覆盖率/满足率按居民实际成交（含跨城进口）口径，与主报告 cityFoodMetrics 一致。
  const statedFoodNeed = round2(
    groups.reduce((total, group) => total + (group.lastMonth.basicNeedUnits ?? 0), 0),
  );
  const statedFoodSold = round2(
    groups.reduce((total, group) => total + (group.lastMonth.basicSoldUnits ?? 0), 0),
  );
  const statedFoodEffective = round2(
    groups.reduce((total, group) => total + (group.lastMonth.basicEffectiveUnits ?? 0), 0),
  );
  const foodImported = round2(foodMarket?.intercityImported ?? 0);
  const foodExported = round2(
    world.lastTick.tradeFlows
      .filter((flow) => flow.good === 'food' && flow.fromCityId === city.id)
      .reduce((total, flow) => total + flow.qty, 0),
  );
  const effectiveFoodNeed = statedFoodNeed > 0.01 ? statedFoodNeed : basicNeed;
  const residentFoodSold = statedFoodSold > 0.01 ? statedFoodSold : round2((foodMarket?.sold ?? 0) + foodImported);
  const foodCoverage = effectiveFoodNeed > 0.01 ? residentFoodSold / effectiveFoodNeed : 0;
  const foodSatisfaction = statedFoodEffective > 0.01 ? residentFoodSold / statedFoodEffective : null;
  const foundedTotal = world.lifecycle.foundings.filter((record) => record.cityId === city.id).length;
  const liquidatedTotal = world.lifecycle.liquidations.filter((record) => record.cityId === city.id).length;
  const lifecycleLimit = DEMO_CONFIG.lifecycle.maxHistory;
  return {
    city: city.id,
    population: Math.round(city.population.total),
    laborForce: Math.round(city.population.laborForce),
    employed: Math.round(city.population.employed),
    unemployed: Math.round(city.population.unemployed),
    unemploymentRate:
      city.population.laborForce > 0
        ? Math.round((city.population.unemployed / city.population.laborForce) * 1000) / 10
        : 0,
    companies: activeCompanies.length,
    foundedTotal,
    liquidatedTotal,
    lifecycleTruncated: foundedTotal >= lifecycleLimit || liquidatedTotal >= lifecycleLimit,
    food: {
      sold: residentFoodSold,
      localSold: round2(Math.max(0, residentFoodSold - foodImported)),
      imported: foodImported,
      exported: foodExported,
      effectiveDemand: statedFoodEffective,
      satisfaction: foodSatisfaction === null ? null : Math.round(foodSatisfaction * 1000) / 10,
      basicNeed: round2(effectiveFoodNeed),
      basicNeedCoverage: Math.round(foodCoverage * 1000) / 10,
      price: round2(foodMarket?.price ?? 0),
      capacity: round2(foodCompanies.reduce((total, company) => total + company.capacity, 0)),
      produced: round2(foodCompanies.reduce((total, company) => total + company.lastMonth.produced, 0)),
      inventory: round2(foodMarket?.closingStock ?? 0),
    },
    grain: {
      sold: round2(city.market['grain']?.sold ?? 0),
      demand: round2(city.market['grain']?.producerDemand ?? 0),
      price: round2(city.market['grain']?.price ?? 0),
      inventory: round2(city.market['grain']?.closingStock ?? 0),
    },
    energy: {
      sold: round2(city.market['energy']?.sold ?? 0),
      demand: round2(city.market['energy']?.producerDemand ?? 0),
      price: round2(city.market['energy']?.price ?? 0),
      inventory: round2(city.market['energy']?.closingStock ?? 0),
    },
    households: {
      wages: sumGroup((group) => group.lastMonth.wageIncome),
      benefits: sumGroup((group) => group.lastMonth.benefits),
      dividends: sumGroup((group) => group.lastMonth.dividendIncome),
      consumption: sumGroup((group) => group.lastMonth.consumption),
      cash: sumGroup((group) => group.cash),
      deposits,
      loansOutstanding,
      incomeTax: month.incomeTax,
    },
    fiscal: {
      gdp: month.gdp,
      householdIncome: month.householdIncome,
      consumerSpend: month.consumerSpend,
      incomeTax: month.incomeTax,
      corporateTax: month.corporateTax,
      consumptionTax: month.consumptionTax ?? 0,
      dividendTax: month.dividendTax ?? 0,
      transportTaxBonus: month.transportTaxBonus ?? 0,
      transportTaxLoss: month.transportTaxLoss ?? 0,
      publicWages: month.publicWageBill,
      benefits: month.benefitsPaid,
      policySpending: month.policySpending,
      transportSpending: month.transportSpending,
      consumerLoanDrawn: month.consumerLoanDrawn ?? 0,
      bondInterestPaid: month.bondInterestPaid ?? 0,
      bondPrincipalPaid: month.bondPrincipalPaid ?? 0,
      bankAdvance: month.bankAdvanceThisMonth ?? 0,
      treasury: round2(city.treasury),
      // 月末债务/负债率以政府 lastDebt 快照 + 独立重算为准；lastMonth 的可选字段在部分月份未填充。
      totalDebt: round2(cityDebt(world, city.id).totalDebt),
      debtRatio: city.government?.lastDebt?.debtRatio ?? 0,
      historicalBankruptcies: city.government.records.length,
    },
    initialEquipment: {
      grants: grants.length,
      units: initialUnits,
      valuation: initialValuation,
      purchasedThisMonth,
    },
    ai: {
      runs: ai.runs,
      spent: round2(ai.spent),
      beneficiaries: ai.beneficiaries,
      jobsEffect: ai.jobsEffect,
      finalTier: ai.finalTier,
      finalBudget: round2(ai.finalBudget),
      debtWarningMonths: ai.debtWarningMonths,
      policyIds: [...ai.policyIds].sort(),
    },
    trade: {
      importQty: round2(trade.importQty),
      importValue: round2(trade.importValue),
      exportQty: round2(trade.exportQty),
      exportValue: round2(trade.exportValue),
      byGood: trade.byGood,
    },
  };
}

interface AccumulatedAi {
  runs: number;
  spent: number;
  beneficiaries: number;
  jobsEffect: number;
  finalTier: string;
  finalBudget: number;
  debtWarningMonths: number;
  policyIds: Set<string>;
}

interface AccumulatedTrade {
  importQty: number;
  importValue: number;
  exportQty: number;
  exportValue: number;
  byGood: Record<string, { importQty: number; exportQty: number }>;
}

for (const seed of SEEDS) {
  const startedAt = Date.now();
  const config = { ...DEMO_CONFIG, simulation: { ...DEMO_CONFIG.simulation, seed } };
  const simulation = Simulation.create(config);
  const aiByCity = new Map<string, AccumulatedAi>();
  const tradeByCity = new Map<string, AccumulatedTrade>();
  const accumulator = (cityId: string): AccumulatedAi => {
    let entry = aiByCity.get(cityId);
    if (!entry) {
      entry = {
        runs: 0,
        spent: 0,
        beneficiaries: 0,
        jobsEffect: 0,
        finalTier: 'normal',
        finalBudget: 0,
        debtWarningMonths: 0,
        policyIds: new Set(),
      };
      aiByCity.set(cityId, entry);
    }
    return entry;
  };
  const tradeAccumulator = (cityId: string): AccumulatedTrade => {
    let entry = tradeByCity.get(cityId);
    if (!entry) {
      entry = { importQty: 0, importValue: 0, exportQty: 0, exportValue: 0, byGood: {} };
      tradeByCity.set(cityId, entry);
    }
    return entry;
  };

  for (let month = 0; month < MONTHS; month += 1) {
    simulation.tick();
    const world = simulation.state;
    const tick = world.time.tick;
    // AI 政策执行累计（只统计本月真实记录，不把保留窗口当全期）。
    for (const policy of world.policies.active) {
      const entry = accumulator(policy.cityId);
      entry.policyIds.add(policy.policyId);
      for (const run of policy.tracking?.runs ?? []) {
        if (run.tick !== tick) continue;
        entry.runs += 1;
        entry.spent += run.spent;
        entry.beneficiaries += run.beneficiaries;
        entry.jobsEffect += run.jobsEffect;
      }
    }
    for (const checkup of world.policies.checkups ?? []) {
      if (checkup.tick !== tick) continue;
      const entry = accumulator(checkup.cityId);
      entry.finalTier = checkup.tier;
      entry.finalBudget = checkup.budget;
      if (checkup.debtWarning) entry.debtWarningMonths += 1;
    }
    // 跨城贸易累计（本月真实成交行）。
    for (const flow of world.lastTick.tradeFlows) {
      if (!KEY_TRADE_GOODS.has(flow.good)) continue;
      for (const [cityId, isImport] of [
        [flow.fromCityId, false],
        [flow.toCityId, true],
      ] as const) {
        const entry = tradeAccumulator(cityId);
        entry.byGood[flow.good] ??= { importQty: 0, exportQty: 0 };
        if (isImport) {
          entry.importQty += flow.qty;
          entry.importValue += flow.value;
          entry.byGood[flow.good]!.importQty += flow.qty;
        } else {
          entry.exportQty += flow.qty;
          entry.exportValue += flow.value;
          entry.byGood[flow.good]!.exportQty += flow.qty;
        }
      }
    }
  }

  const elapsedSeconds = Math.round((Date.now() - startedAt) / 100) / 10;
  const world = simulation.state;
  const invalid = simulation.validate();
  const cities = world.cities.map((city) =>
    cityReport(world, city, accumulator(city.id), tradeAccumulator(city.id)),
  );
  console.log(
    JSON.stringify({
      seed,
      months: MONTHS,
      elapsedSeconds,
      invariants: invalid.length,
      foundings: world.lifecycle.foundings.length,
      liquidations: world.lifecycle.liquidations.length,
      lifecycleTruncated: world.lifecycle.foundings.length >= DEMO_CONFIG.lifecycle.maxHistory,
      totalBankruptcies: cities.reduce((sum, city) => sum + city.fiscal.historicalBankruptcies, 0),
      dataWindow: {
        note: '企业创办/倒闭为保留窗口内条数（可能截断）；财政与居民指标为最后一月快照；AI/贸易为脚本逐月累计。',
      },
      cities,
    }),
  );
}
