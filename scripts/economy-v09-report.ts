// v0.9 经济循环观察脚本（只读：不改变规则、不写存档、不调用玩家操作）。
//
// 用法：npx tsx scripts/economy-v09-report.ts [--months=72] [--checkpoints=1,12,24,36,72]
//
// 固定条件：Simulation.create(config)、种子默认 20261101（--seed 可设）、玩家无操作、默认 AI。
// 面向《经济循环完善计划书》§8 的观察口径：城市（GDP/运营收支/财政/贷款/债券/总负债/债务-GDP/
// 破产与重选）、企业（成立/倒闭/设备/计划产量/欠薪）、居民（消费/消费贷/存款/失业）、银行、
// 设备市场，以及“经营改善”与“借款/垫付/勾销”三者的区分。仅一次固定种子，不做调参。

import { Simulation } from '../src/simulation/core/simulation';
import { DEMO_CONFIG } from '../src/data/config';
import type { City, Company, GoodId, WorldState } from '../src/simulation/contracts/types';
import {
  assessCityFiscalRisk,
  cityDebt,
  isCityBankrupt,
  recent12MonthGdp,
} from '../src/simulation/government/metrics';
import { equipmentUnits } from '../src/simulation/equipment/equipment';
import { GOODS } from '../src/data/demo-data';
import { foundingAttempts, foundingAttemptsTruncated } from '../src/simulation/companies/founding';
import { investorFundingReport } from '../src/simulation/investors/investors';
import { policyName } from '../src/simulation/policies/definitions';
import { policyFundingMonthlyReport } from '../src/simulation/policies/policies';

function argNumber(flag: string, fallback: number): number {
  const raw = process.argv.find((arg) => arg.startsWith(`${flag}=`));
  if (!raw) return fallback;
  const parsed = Number(raw.split('=')[1]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function argList(flag: string, fallback: number[]): number[] {
  const raw = process.argv.find((arg) => arg.startsWith(`${flag}=`));
  if (!raw) return fallback;
  return raw
    .split('=')[1]
    .split(',')
    .map((entry) => Number(entry))
    .filter((entry) => Number.isFinite(entry) && entry > 0);
}

function money(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e8) return `${(value / 1e8).toFixed(2)}亿`;
  if (abs >= 1e4) return `${(value / 1e4).toFixed(1)}万`;
  return value.toFixed(0);
}

function pct(value: number, digits = 1): string {
  return `${(value * 100).toFixed(digits)}%`;
}

function num(value: number, digits = 0): string {
  return value.toLocaleString('zh-CN', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/** 金额/份额口径统一四舍五入到分（与 simulation round2 一致）。 */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

const MONTHS = argNumber('--months', 72);
const SEED = argNumber('--seed', DEMO_CONFIG.simulation.seed);
const CHECKPOINTS = argList('--checkpoints', [1, 12, 24, 36, 72]).filter(
  (tick) => tick <= MONTHS,
);

interface Cumulative {
  govIncome: number;
  govExpense: number;
  taxIncome: number;
  bondPrincipal: number;
  bankAdvance: number;
  bankLoan: number;
  writtenOff: number;
  householdConsumption: number;
}

function emptyCumulative(): Cumulative {
  return {
    govIncome: 0,
    govExpense: 0,
    taxIncome: 0,
    bondPrincipal: 0,
    bankAdvance: 0,
    bankLoan: 0,
    writtenOff: 0,
    householdConsumption: 0,
  };
}

function cityCumulative(world: WorldState, cityId: string): Cumulative {
  const total = emptyCumulative();
  for (const entry of world.fiscal.ledger) {
    if (entry.cityId !== cityId) continue;
    const amount = entry.amount ?? 0;
    if (entry.kind.endsWith('Tax') || entry.kind === 'dividendIncome') total.taxIncome += amount;
    // FiscalEntry.amount 正数为财政收入、负数为支出（见类型注释）。
    if (amount >= 0) total.govIncome += amount;
    else total.govExpense += -amount;
  }
  for (const record of world.lifecycle.liquidations) {
    if (record.cityId === cityId) total.writtenOff += record.forgiven ?? 0;
  }
  return total;
}

/**
 * 财政流水的保留窗口：`recordFiscal` 只保留最近 `policies.ledgerLimit`（800）条，
 * 因此这里只能给出“窗口内累计”，不能冒充全期累计。账本一旦达到上限，更早月份不可得。
 */
function investorEquityStats(world: WorldState, cityId: string) {
  const groups = world.households.groups.filter((group) => group.cityId === cityId);
  let contributed = 0;
  let opening = 0;
  let holders = 0;
  let zeroPeopleWithShares = 0;
  let zeroPeopleShares = 0;
  for (const group of groups) {
    const ledger = group.investorLedger;
    if (!ledger) continue;
    const owned = ledger.shares + (ledger.openingShares ?? 0);
    contributed += ledger.shares;
    opening += ledger.openingShares ?? 0;
    if (owned > 0.01) holders += 1;
    if (group.people <= 0 && owned > 0.01) {
      zeroPeopleWithShares += 1;
      zeroPeopleShares += owned;
    }
  }
  // v1.4 §3.2/§3.4：净资产 = 实体现金 + 股票市值 + 政府债券估值（本金 + 已计提利息）；
  // 份额一律用有效份额（shares + openingShares），与分红/财富归属口径一致。
  const report = investorFundingReport(world).find((entry) => entry.cityId === cityId);
  const entityCash = round2(report?.investorCash ?? 0);
  const netWorth = round2(report?.investorNetWorth ?? 0);
  const bondsValue = round2((report?.groups ?? []).reduce((sum, group) => sum + group.bondsValue, 0));
  const totalShares = round2(
    (report?.householdShares ?? []).reduce((sum, share) => sum + share.effectiveShares, 0),
  );
  const navPerShare = totalShares > 0 ? round2(netWorth / totalShares) : 0;
  return {
    contributed,
    opening,
    holders,
    groups: groups.length,
    zeroPeopleWithShares,
    zeroPeopleShares,
    entityCash,
    netWorth,
    bondsValue,
    totalShares,
    navPerShare,
  };
}

/** v1.4 §4：初始实物设备（模拟范围外实物出资）现状与本城真实设备采购。 */
function initialEquipmentStats(world: WorldState, cityId: string) {
  const companies = world.companies.filter((company) => company.cityId === cityId);
  const kindUnits: Record<string, number> = { farm: 0, industry: 0, energy: 0 };
  let grants = 0;
  let units = 0;
  let valuation = 0;
  let locked = 0;
  let grantedThisTick = 0;
  let purchasedThisTick = 0;
  for (const company of companies) {
    purchasedThisTick += Math.max(0, company.lastMonth.equipmentPurchased ?? 0);
    const grant = company.initialEquipment;
    if (!grant) continue;
    grants += 1;
    units += grant.units;
    valuation += grant.valuation;
    kindUnits[grant.kind] = (kindUnits[grant.kind] ?? 0) + grant.units;
    if (world.time.tick < grant.lockUntilTick) locked += 1;
    if (grant.grantedTick === world.time.tick) grantedThisTick += 1;
  }
  return { grants, units, valuation: round2(valuation), locked, grantedThisTick, purchasedThisTick: round2(purchasedThisTick), kindUnits };
}

/** v1.4 §5：AI 政府本月经济体检与政策执行（预算/支出/受益/就业效果/债务预警）。 */
function aiPolicyStats(world: WorldState, cityId: string) {
  const checkups = (world.policies.checkups ?? []).filter((checkup) => checkup.cityId === cityId);
  let latest = checkups[0];
  for (const checkup of checkups) if (!latest || checkup.tick > latest.tick) latest = checkup;
  const active = world.policies.active.filter((policy) => policy.cityId === cityId);
  let spentThisTick = 0;
  let beneficiaries = 0;
  let jobsEffect = 0;
  let runsThisTick = 0;
  const reasons = new Set<string>();
  for (const policy of active) {
    reasons.add(policy.reason ?? '');
    for (const run of policy.tracking?.runs ?? []) {
      if (run.tick !== world.time.tick) continue;
      spentThisTick += run.spent;
      beneficiaries += run.beneficiaries;
      jobsEffect += run.jobsEffect;
      runsThisTick += 1;
    }
  }
  const decisions = active
    .filter((policy) => policy.policyId !== 'taxAdjustment' && policy.policyId !== 'transportInvestment')
    .map((policy) => `${policyName(policy.policyId)}(预算 ${round2(policy.budget).toFixed(0)}/已支 ${round2(policy.spent).toFixed(0)})`)
    .join('、');
  return {
    latest,
    activeCount: active.length,
    spentThisTick: round2(spentThisTick),
    beneficiaries,
    jobsEffect,
    runsThisTick,
    decisions,
    reasons: [...reasons].filter(Boolean).slice(-3),
  };
}
function unemployedConsumption(world: WorldState, cityId: string) {
  const groups = world.households.groups.filter(
    (group) => group.cityId === cityId && group.occupation === 'unemployed',
  );
  const total = {
    people: 0,
    cash: 0,
    income: 0,
    budget: 0,
    consumption: 0,
    desired: 0,
    unmetFunding: 0,
    depositWithdrawn: 0,
    loanFinanced: 0,
  };
  for (const group of groups) {
    total.people += group.people;
    total.cash += group.cash;
    total.income += group.lastMonth.income;
    total.budget += group.lastMonth.budget ?? 0;
    total.consumption += group.lastMonth.consumption;
    total.desired += group.lastMonth.desiredConsumption;
    total.unmetFunding += group.lastMonth.unmetFunding ?? 0;
    total.depositWithdrawn += group.lastMonth.depositWithdrawn ?? 0;
    total.loanFinanced += group.lastMonth.loanFinancedConsumption ?? 0;
  }
  return total;
}

function companyCostStats(world: WorldState, cityId: string) {
  const rows = world.companies.filter((company) => company.cityId === cityId);
  const sum = (pick: (company: Company) => number) =>
    rows.reduce((total, company) => total + pick(company), 0);
  const inventoryValue = rows.reduce(
    (total, company) =>
      total +
      Object.values(company.inventoryCost ?? {}).reduce((s, cost) => s + (cost ?? 0), 0),
    0,
  );
  return {
    revenue: sum((company) => company.lastMonth.revenue),
    cogs: sum((company) => company.lastMonth.cogs ?? 0),
    inputCost: sum((company) => company.lastMonth.inputCost),
    wages: sum((company) => company.lastMonth.wagesPaid),
    profit: sum((company) => company.lastMonth.profit),
    cashFlow: sum((company) => company.lastMonth.operatingCashFlow ?? 0),
    inventoryValue,
  };
}

function foodChainStats(world: WorldState, city: City) {
  const companies = world.companies.filter((company) => company.cityId === city.id);
  const round = (value: number) => Math.round(value * 100) / 100;
  const aggregate = (output: GoodId) => {
    const rows = companies.filter((company) => company.recipeOutput === output);
    const sum = (pick: (company: Company) => number) =>
      round(rows.reduce((total, company) => total + pick(company), 0));
    return {
      count: rows.length,
      capacity: sum((company) => company.capacity),
      planned: sum((company) => company.productionPlan?.plannedOutput ?? 0),
      produced: sum((company) => company.lastMonth.produced),
      sold: sum((company) => company.lastMonth.sold),
      cash: sum((company) => company.cash),
      arrears: sum((company) => company.lastMonth.wageArrears),
      profit: sum((company) => company.lastMonth.profit),
      warehouses: sum((company) => company.inventory[output] ?? 0),
    };
  };
  return {
    food: aggregate('food'),
    grain: aggregate('grain'),
    energy: aggregate('energy'),
    grainMarket: city.market['grain'],
    foodMarket: city.market['food'],
    energyMarket: city.market['energy'],
  };
}

function governmentFiscalDetail(world: WorldState, cityId: string) {
  const entries = world.fiscal.ledger.filter((entry) => entry.cityId === cityId);
  const limit = DEMO_CONFIG.policies.ledgerLimit;
  const sum = (kinds: string[]) =>
    entries
      .filter((entry) => kinds.includes(entry.kind))
      .reduce((total, entry) => total + entry.amount, 0);
  const result = {
    entries: entries.length,
    limit,
    truncated: entries.length >= limit,
    incomeTax: sum(['incomeTax']),
    corporateTax: sum(['corporateTax']),
    consumptionTax: sum(['consumptionTax']),
    dividendTax: sum(['dividendTax']),
    tax:
      sum(['incomeTax', 'corporateTax', 'consumptionTax', 'dividendTax']),
    transportBonus: sum(['transportTaxBonus']),
    transportLoss: sum(['transportTaxLoss']),
    publicWages: sum(['publicWages']),
    benefits: sum(['benefits']),
    policySpending: sum(['policySpending', 'policyTransfer']),
    transport: sum(['transportConstruction', 'transportMaintenance']),
    loanProceeds: sum(['governmentLoanProceeds']),
    loanRepayment: sum(['governmentLoanRepayment', 'governmentLoanInterest']),
    bondProceeds: sum(['bondIssuanceProceeds']),
    bondService: sum(['bondInterest', 'bondPrincipal']),
    bankAdvance: sum(['bankAdvance']),
    writtenOff: sum(['debtWriteOff', 'debtForgiven']),
    // v1.4 §6.5：其余财政收支（清算收益/股息收入/选举费用），单列避免遗漏。
    otherIncome: sum(['liquidationProceeds', 'dividendIncome']),
    electionFee: sum(['electionFee']),
  };
  return result;
}

function fiscalWindow(world: WorldState, cityId: string) {
  const entries = world.fiscal.ledger.filter((entry) => entry.cityId === cityId);
  const startTick = entries.length > 0 ? Math.min(...entries.map((entry) => entry.tick)) : null;
  return {
    entries: entries.length,
    startTick,
    truncated: world.fiscal.ledger.length >= DEMO_CONFIG.policies.ledgerLimit,
    ledgerLimit: DEMO_CONFIG.policies.ledgerLimit,
  };
}

/**
 * 政府历史上破产过几次（不是观察时刻的状态）。
 * 破产记录本身也有保留上限（config.government.maxBankruptcyRecords=8）：
 * 记录数达到上限时可能已丢弃更早记录，必须显式标注。
 */
function bankruptcyHistory(city: City) {
  const records = [...city.government.records].sort((a, b) => a.tick - b.tick);
  const maxRecords = DEMO_CONFIG.government.maxBankruptcyRecords;
  return {
    count: records.length,
    ticks: records.map((record) => record.tick),
    current: city.government.bankruptcy,
    truncated: records.length >= maxRecords,
    maxRecords,
  };
}

/**
 * v1.4 §6.4：本月跨城贸易（关键商品）与运输约束。
 * 只读取 world.lastTick.tradeFlows（当月成交记录），不把保留窗口当成全期累计。
 */
function intercityTradeThisTick(world: WorldState, cityId: string) {
  const keyGoods = new Set([
    'food',
    'grain',
    'energy',
    'farmEquipment',
    'industryEquipment',
    'energyEquipment',
  ]);
  const flows = world.lastTick.tradeFlows.filter(
    (flow) =>
      keyGoods.has(flow.good) && (flow.fromCityId === cityId || flow.toCityId === cityId),
  );
  const imports = flows.filter((flow) => flow.toCityId === cityId);
  const exports = flows.filter((flow) => flow.fromCityId === cityId);
  const byGood = (rows: typeof flows) => {
    const map = new Map<string, { qty: number; value: number }>();
    for (const flow of rows) {
      const current = map.get(flow.good) ?? { qty: 0, value: 0 };
      current.qty += flow.qty;
      current.value += flow.value;
      map.set(flow.good, current);
    }
    return [...map.entries()]
      .sort((a, b) => b[1].value - a[1].value)
      .map(([good, total]) => `${good} ${num(total.qty, 1)} 件/¥${num(total.value, 1)}`);
  };
  // v1.4：运输是 WorldState 全局状态（world.transport），不是 city 字段；城内行按 cityId 过滤。
  const intracity = world.transport.lastMonth.intracity.find((row) => row.cityId === cityId);
  const corridorPenalty = world.transport.lastMonth.penaltyRate ?? 0;
  return {
    importQty: imports.reduce((total, flow) => total + flow.qty, 0),
    importValue: imports.reduce((total, flow) => total + flow.value, 0),
    exportQty: exports.reduce((total, flow) => total + flow.qty, 0),
    exportValue: exports.reduce((total, flow) => total + flow.value, 0),
    importGoods: byGood(imports),
    exportGoods: byGood(exports),
    flowCount: flows.length,
    deliveryEfficiency: intracity?.deliveryEfficiency ?? null,
    corridorPenalty,
  };
}

/** 居民消费四层口径（每城）：期望成本 / 成交 / 资金不足缺口 / 预算未形成需求。 */
function cityConsumption(world: WorldState, cityId: string) {
  const groups = world.households.groups.filter((group) => group.cityId === cityId);
  const sum = (pick: (group: (typeof groups)[number]) => number) =>
    groups.reduce((total, group) => total + Math.max(0, pick(group)), 0);
  const foodGood = GOODS.find((good) => good.id === 'food');
  const desiredCost = sum((group) => group.lastMonth.desiredConsumption);
  const consumption = sum((group) => group.lastMonth.consumption);
  const unmetFunding = sum((group) => group.lastMonth.unmetFunding ?? 0);
  const loanFinanced = sum((group) => group.lastMonth.loanFinancedConsumption ?? 0);
  const loanDrawn = sum((group) => group.lastMonth.loanDrawn ?? 0);
  const depositWithdrawn = sum((group) => group.lastMonth.depositWithdrawn ?? 0);
  const budget = sum((group) => group.lastMonth.budget ?? 0);
  // v1.4 §6.1：成交 = 现金支付 + 存款提取 + 消费贷；三项都由 consumer 本月真实落账。
  const cashPaid = round2(sum((group) => group.lastMonth.cashPaid ?? 0));
  // 期望成本中既没有成交、也没有被记为“资金不足”的部分 = 预算/有效需求没有形成。
  const fundingGap = round2(Math.max(0, desiredCost - consumption - unmetFunding));
  // 有效需求（件/金额）与商品不足缺口（件）用 consumer 落账口径：
  // 件数包含跨城进口成交，缺口只统计“尝试过但最终未成交”的部分，二者互斥。
  const effectiveUnits = round2(sum((group) => group.lastMonth.effectiveUnits ?? 0));
  const soldUnits = round2(sum((group) => group.lastMonth.soldUnits ?? 0));
  const effectiveCost = round2(sum((group) => group.lastMonth.effectiveCost ?? 0));
  const supplyShortfallUnits = round2(sum((group) => group.lastMonth.supplyShortfallUnits ?? 0));
  // 基本需要量/成交：优先读 consumer 落账；旧档/未落账回退到“人口 × 人均需要”与市场成交（标注口径）。
  const statedNeed = sum((group) => group.lastMonth.basicNeedUnits ?? 0);
  const statedSold = sum((group) => group.lastMonth.basicSoldUnits ?? 0);
  const fallbackNeed = round2(
    groups.reduce((total, group) => total + group.people, 0) * (foodGood?.perCapitaMonthlyNeed ?? 0),
  );
  const basicNeedQty = statedNeed > 0.01 ? round2(statedNeed) : fallbackNeed;
  // 旧档无群体落账时：只能近似为“本地市场成交 + 跨城进口”（不含出口，避免与 §3 居民实际成交口径冲突）。
  const basicNeedSold = statedSold > 0.01
    ? round2(statedSold)
    : round2(
        (world.cities.find((city) => city.id === cityId)?.market['food']?.sold ?? 0) +
          (world.cities.find((city) => city.id === cityId)?.market['food']?.intercityImported ?? 0),
      );
  const basicNeedCoverage = basicNeedQty > 0.01 ? basicNeedSold / basicNeedQty : null;
  return {
    desiredCost,
    consumption,
    unmetFunding,
    fundingGap,
    loanFinanced,
    loanDrawn,
    depositWithdrawn,
    cashPaid,
    budget,
    effectiveUnits,
    soldUnits,
    effectiveCost,
    supplyShortfallUnits,
    basicNeedQty,
    basicNeedSold,
    basicNeedCoverage,
  };
}
/** 商品市场供需（数量口径），用于区分缺货与缺钱。 */
function marketStats(city: City, goodId: GoodId) {
  const market = city.market[goodId];
  return {
    price: market?.price ?? 0,
    supply: market?.supply ?? 0,
    demand: market?.demand ?? 0,
    consumerDemand: market?.consumerDemand ?? 0,
    sold: market?.sold ?? 0,
    unmetDemand: market?.unmetDemand ?? 0,
    intercityImported: market?.intercityImported ?? 0,
    closingStock: market?.closingStock ?? 0,
  };
}

function describeGood(name: string, stats: ReturnType<typeof marketStats>): string {
  return `${name}：需求 ${num(stats.demand, 1)} / 成交 ${num(stats.sold, 1)}（缺货 ${num(stats.unmetDemand, 1)}，跨城进口 ${num(stats.intercityImported, 1)}，期末库存 ${num(stats.closingStock, 1)}，价 ${stats.price.toFixed(1)}）`;
}

function companyStats(world: WorldState, cityId: string) {
  const companies = world.companies.filter((company) => company.cityId === cityId);
  const active = companies.length;
  const founded = world.lifecycle.foundings.filter((record) => record.cityId === cityId).length;
  const liquidated = world.lifecycle.liquidations.filter((record) => record.cityId === cityId).length;
  // 近 12 个月窗口（创办/倒闭明细本身有保留上限，窗口内的记录必然可见）。
  const windowStart = world.time.tick - 12;
  const foundedWindow = world.lifecycle.foundings.filter(
    (record) => record.cityId === cityId && record.tick > windowStart,
  ).length;
  const liquidatedWindow = world.lifecycle.liquidations.filter(
    (record) => record.cityId === cityId && record.tick > windowStart,
  ).length;
  const equipmentKinds = {
    farm: companies.reduce((sum, company) => sum + equipmentUnits(company, 'farm'), 0),
    industry: companies.reduce((sum, company) => sum + equipmentUnits(company, 'industry'), 0),
    energy: companies.reduce((sum, company) => sum + equipmentUnits(company, 'energy'), 0),
  };
  const equipment = equipmentKinds.farm + equipmentKinds.industry + equipmentKinds.energy;
  const capacity = companies.reduce((sum, company) => sum + company.capacity, 0);
  const planned = companies.reduce((sum, company) => sum + (company.productionPlan?.plannedOutput ?? 0), 0);
  const plannedJobs = companies.reduce((sum, company) => sum + (company.productionPlan?.plannedJobs ?? 0), 0);
  const wageArrears = companies.reduce((sum, company) => sum + Math.max(0, (company.lastMonth.wageArrears ?? 0)), 0);
  const cash = companies.reduce((sum, company) => sum + company.cash, 0);
  const debt = companies.reduce((sum, company) => sum + company.debt, 0);
  const emergency = companies.reduce((sum, company) => sum + (company.lastMonth.emergencyLayoffs ?? 0), 0);
  const revenue = companies.reduce((sum, company) => sum + company.lastMonth.revenue, 0);
  const inputCost = companies.reduce((sum, company) => sum + company.lastMonth.inputCost, 0);
  const cogs = companies.reduce((sum, company) => sum + (company.lastMonth.cogs ?? company.lastMonth.inputCost), 0);
  const refundGain = companies.reduce((sum, company) => sum + (company.lastMonth.refundGain ?? 0), 0);
  const wages = companies.reduce(
    (sum, company) => sum + company.lastMonth.wagesPaid + (company.lastMonth.bonusPaid ?? 0),
    0,
  );
  const interest = companies.reduce((sum, company) => sum + company.lastMonth.interestPaid, 0);
  const tax = companies.reduce((sum, company) => sum + company.lastMonth.corporateTax, 0);
  const profit = companies.reduce((sum, company) => sum + company.lastMonth.profit, 0);
  const equipmentPurchased = companies.reduce(
    (sum, company) => sum + (company.lastMonth.equipmentPurchased ?? 0),
    0,
  );
  const equipmentSold = companies.reduce((sum, company) => sum + (company.lastMonth.equipmentSold ?? 0), 0);
  const sectors = new Map<string, number>();
  for (const company of companies) sectors.set(company.sector, (sectors.get(company.sector) ?? 0) + 1);
  return {
    active,
    founded,
    liquidated,
    foundedWindow,
    liquidatedWindow,
    equipment,
    equipmentKinds,
    capacity,
    planned,
    plannedJobs,
    wageArrears,
    cash,
    debt,
    emergency,
    revenue,
    inputCost,
    cogs,
    refundGain,
    wages,
    interest,
    tax,
    profit,
    equipmentPurchased,
    equipmentSold,
    sectors,
  };
}

function householdStats(world: WorldState, cityId: string) {
  const groups = world.households.groups.filter((group) => group.cityId === cityId);
  const cash = groups.reduce((sum, group) => sum + group.cash, 0);
  const loans = world.householdFinance.loans.filter((loan) => loan.cityId === cityId);
  const loanOutstanding = loans.reduce((sum, loan) => sum + loan.outstanding, 0);
  const defaulted = loans.filter((loan) => loan.status === 'defaulted').length;
  const consumption = groups.reduce((sum, group) => sum + group.lastMonth.consumption, 0);
  const income = groups.reduce((sum, group) => sum + group.lastMonth.income, 0);
  const desires = groups.reduce((sum, group) => sum + Math.max(0, group.lastMonth.desiredConsumption ?? 0), 0);
  // 存款按群体所属城市汇总：同一个居民只有一份存款账户，不能把全世界的存款重复写到每座城市。
  const groupIds = new Set(groups.map((group) => group.id));
  const deposits = world.banking.deposits
    .filter((account) => account.owner.kind === 'household' && groupIds.has(account.owner.id))
    .reduce((sum, account) => sum + account.balance, 0);
  // 居民消费贷合同没有保留上限（不做 splice），principal 合计即全期累计发放额。
  const borrowed = loans.reduce((sum, loan) => sum + loan.principal, 0);
  const wages = groups.reduce((sum, group) => sum + group.lastMonth.wageIncome, 0);
  const benefits = groups.reduce((sum, group) => sum + group.lastMonth.benefits, 0);
  const dividends = groups.reduce((sum, group) => sum + group.lastMonth.dividendIncome, 0);
  const incomeTax = groups.reduce((sum, group) => sum + group.lastMonth.incomeTax, 0);
  // 居民→投资实体的真实资金转移（本月从居民现金转出、进入投资实体现金的额度）。
  const invested = groups.reduce((sum, group) => sum + Math.max(0, group.lastMonth.savingsContribution), 0);
  return {
    cash,
    loanOutstanding,
    defaulted,
    consumption,
    income,
    desires,
    deposits,
    borrowed,
    loanCount: loans.length,
    wages,
    benefits,
    dividends,
    incomeTax,
    invested,
  };
}

function bankStats(world: WorldState) {
  const loans = world.banking.loans;
  const outstanding = loans.reduce((sum, loan) => sum + loan.outstanding, 0);
  const deposits = world.banking.deposits.reduce((sum, account) => sum + account.balance, 0);
  const active = loans.filter((loan) => loan.status === 'active').length;
  const defaulted = loans.filter((loan) => loan.status === 'defaulted').length;
  const repaid = loans.filter((loan) => loan.status === 'repaid').length;
  const lastMonth = world.banking.lastMonth;
  return { outstanding, deposits, active, defaulted, repaid, total: loans.length, lastMonth };
}

/**
 * 税收历史：`recordTaxMonth` 只保留最近 `config.tax.historyMonths`（12）个月，
 * 因此这里的合计是“最近 12 月窗口”，不是全期累计；更早月份只能从财政流水窗口里找。
 */
function taxWindow(world: WorldState, cityId: string): {
  tax: number;
  bonus: number;
  loss: number;
  months: number;
  windowMonths: number;
} {
  const history = world.taxes.historyByCity[cityId] ?? [];
  let tax = 0;
  let bonus = 0;
  let loss = 0;
  for (const month of history) {
    tax += month.incomeTaxRevenue + month.corporateTaxRevenue + month.consumptionTaxRevenue + month.dividendTaxRevenue;
    bonus += month.transportBonus;
    loss += month.transportLoss;
  }
  return { tax, bonus, loss, months: history.length, windowMonths: DEMO_CONFIG.tax.historyMonths };
}

function describeCity(world: WorldState, city: City) {
  const population = city.population;
  const employed = population.employed;
  const rate = 1 - employed / Math.max(1, population.laborForce);
  const debt = cityDebt(world, city.id);
  const gdp12 = recent12MonthGdp(world, city.id);
  const risk = assessCityFiscalRisk(world, city.id, DEMO_CONFIG);
  const taxes = taxWindow(world, city.id);
  const bankruptcy = city.government.bankruptcy;
  const history = bankruptcyHistory(city);
  return {
    city,
    rate,
    debt,
    gdp12: gdp12.sum,
    risk,
    taxes,
    bankrupt: isCityBankrupt(city),
    bankruptcy,
    history,
  };
}


/** v1.1 §2：本月居民群体真实转入投资实体的现金（按城市）。 */
function investorFundingThisTick(world: WorldState, cityId: string): { amount: number; groups: number } {
  const tick = world.time.tick;
  const rows = (world.households.investorFundingHistory ?? []).filter(
    (entry) => entry.tick === tick && entry.cityId === cityId,
  );
  return { amount: rows.reduce((sum, entry) => sum + entry.amount, 0), groups: rows.length };
}

/** v1.1 §2：本月该城投资实体的资金用途快照。 */
function investorUsageThisTick(
  world: WorldState,
  cityId: string,
): { contributed: number; dividendsReceived: number; dividendsReturned: number; dividendsRetained: number; invested: number } | null {
  const tick = world.time.tick;
  const entry = (world.households.investorUsageHistory ?? []).find(
    (row) => row.tick === tick && row.cityId === cityId,
  );
  return entry ?? null;
}

function investorCashInCity(world: WorldState, cityId: string): number {
  return world.investors
    .filter((investor) => investor.cityId === cityId)
    .reduce((sum, investor) => sum + investor.cash, 0);
}

/** v1.1 §5：本月新认购政府债券（按持债首次购入 tick 统计；合并持仓可能低估）。 */
function bondPurchasesThisTick(
  world: WorldState,
  cityId: string,
): { units: number; amount: number; byKind: Record<string, number> } {
  const tick = world.time.tick;
  const rows = (world.bonds?.holdings ?? []).filter(
    (holding) => holding.cityId === cityId && holding.purchasedTick === tick,
  );
  const byKind: Record<string, number> = {};
  for (const holding of rows) {
    byKind[holding.holder.kind] = (byKind[holding.holder.kind] ?? 0) + holding.principal;
  }
  return {
    units: rows.reduce((sum, holding) => sum + holding.units, 0),
    amount: rows.reduce((sum, holding) => sum + holding.principal, 0),
    byKind,
  };
}

/** v1.1 §3：本月该城的创业尝试与障碍。 */
function foundingAttemptsThisTick(world: WorldState, cityId: string) {
  const tick = world.time.tick;
  return foundingAttempts(world).filter((attempt) => attempt.tick === tick && attempt.cityId === cityId);
}

/**
 * v1.5 §3：食品成交/覆盖率统一口径（居民侧权威 = household.lastMonth 落账）。
 *
 * - 居民实际食品成交 residentSold = Σ 群体 basicSoldUnits（含本地购买与跨城进口购买）；
 * - 进口 imported = city.market['food'].intercityImported（买方城市账本，只计一次）；
 * - 本地居民成交 localResidentSold = residentSold − imported；
 * - 本地账本 sold（市场口径，含卖给其他城市居民的成交）与出口 exported = Σ tradeFlows(fromCity=city) 可交叉核对；
 * - 基本需要量 basicNeed = Σ 群体 basicNeedUnits（旧档回退 人口×人均需要）；
 * - 基本需要覆盖率 = residentSold / basicNeed；
 * - 有效需求满足率 = residentSold / effectiveDemand（effectiveDemand = Σ basicEffectiveUnits，旧档缺省则 n/a）。
 */
function cityFoodMetrics(world: WorldState, city: City) {
  const groups = world.households.groups.filter((group) => group.cityId === city.id);
  const foodGood = GOODS.find((good) => good.id === 'food');
  const statedNeed = round2(groups.reduce((sum, group) => sum + (group.lastMonth.basicNeedUnits ?? 0), 0));
  const statedSold = round2(groups.reduce((sum, group) => sum + (group.lastMonth.basicSoldUnits ?? 0), 0));
  const statedEffective = round2(
    groups.reduce((sum, group) => sum + (group.lastMonth.basicEffectiveUnits ?? 0), 0),
  );
  const fallbackNeed = round2(
    city.population.total * (foodGood?.perCapitaMonthlyNeed ?? 0),
  );
  const market = city.market['food'];
  const ledgerSold = round2(market?.sold ?? 0);
  const imported = round2(market?.intercityImported ?? 0);
  const exported = round2(
    world.lastTick.tradeFlows
      .filter((flow) => flow.good === 'food' && flow.fromCityId === city.id)
      .reduce((sum, flow) => sum + flow.qty, 0),
  );
  const flowImported = round2(
    world.lastTick.tradeFlows
      .filter((flow) => flow.good === 'food' && flow.toCityId === city.id)
      .reduce((sum, flow) => sum + flow.qty, 0),
  );
  const householdBased = statedSold > 0.01 || statedNeed > 0.01;
  const residentSold = householdBased ? statedSold : round2(ledgerSold + imported);
  const basicNeed = statedNeed > 0.01 ? statedNeed : fallbackNeed;
  const effectiveDemand = statedEffective;
  const localResidentSold = round2(Math.max(0, residentSold - imported));
  const coverage = basicNeed > 0.01 ? residentSold / basicNeed : null;
  const satisfaction = effectiveDemand > 0.01 ? residentSold / effectiveDemand : null;
  return {
    source: householdBased ? ('household' as const) : ('market-fallback' as const),
    residentSold,
    localResidentSold,
    imported,
    exported,
    ledgerSold,
    basicNeed,
    effectiveDemand,
    coverage,
    satisfaction,
    // 食品无企业投入需求（只作消费/产出），故本地居民成交应等于本地市场账本成交；
    // 跨城进口只记在买方账本，且与当月收货贸易流合计一致（全局只计一次）。
    crossCheck: round2(localResidentSold - ledgerSold),
    importCheck: round2(imported - flowImported),
  };
}

const initialEmployment = new Map<string, { employed: number; total: number }>();

function printCheckpoint(world: WorldState) {
  for (const city of world.cities) {
    if (!initialEmployment.has(city.id)) {
      initialEmployment.set(city.id, {
        employed: city.population.employed,
        total: city.population.total,
      });
    }
  }
  console.log(`\n${'='.repeat(88)}`);
  console.log(`# 第 ${world.time.tick} 个月（${world.time.year}-${String(world.time.month).padStart(2, '0')}）`);
  console.log(`${'='.repeat(88)}`);

  for (const city of world.cities) {
    const info = describeCity(world, city);
    const company = companyStats(world, city.id);
    const household = householdStats(world, city.id);
    const consumption = cityConsumption(world, city.id);
    const cum = cityCumulative(world, city.id);
    const fiscal = fiscalWindow(world, city.id);
    const historyText =
      info.history.count > 0
        ? `历史破产 ${info.history.count} 次（tick ${info.history.ticks.join('/')}）`
        : '历史破产 0 次';
    console.log(`\n## ${city.name}（${city.id}）`);
    console.log(
      `人口 ${num(city.population.total)}｜就业 ${num(city.population.employed)}｜失业 ${num(city.population.unemployed)}（${pct(info.rate)}）｜非劳动 ${num(city.population.nonLabor)}`,
    );
    console.log(
      `月 GDP ${money(city.gdp)}｜近 12 月 GDP ${money(info.gdp12)}｜财政余额 ${money(city.treasury)}｜风险 ${info.risk.riskLevel}`,
    );
    console.log(
      `负债 ${money(info.debt.totalDebt)}（${pct(info.debt.totalDebt / Math.max(1, info.gdp12))} of 12M GDP）｜银行借款 ${money(info.debt.bankLoanPrincipal)}｜债券 ${money(info.debt.bondPrincipalOutstanding)}｜欠息 ${money(info.debt.loanAccruedInterest + info.debt.bondAccruedInterest)}`,
    );
    const cost = companyCostStats(world, city.id);
    console.log(
      `企业成本 营收 ${money(cost.revenue)}｜售出成本 COGS ${money(cost.cogs)}｜原料现金支出 ${money(cost.inputCost)}｜工资 ${money(cost.wages)}｜利润 ${money(cost.profit)}｜经营现金流 ${money(cost.cashFlow)}｜期末存货账面 ${money(cost.inventoryValue)}`,
    );
    const chain = foodChainStats(world, city);
    console.log(
      `食品链 食品厂 ${chain.food.count} 家 产能 ${num(chain.food.capacity)} 计划 ${num(chain.food.planned)} 产 ${num(chain.food.produced)} 售 ${num(chain.food.sold)} 现金 ${money(chain.food.cash)} 欠薪 ${money(chain.food.arrears)} 利润 ${money(chain.food.profit)}｜粮食厂 ${chain.grain.count} 家 产能 ${num(chain.grain.capacity)} 计划 ${num(chain.grain.planned)} 产 ${num(chain.grain.produced)} 售 ${num(chain.grain.sold)} 欠薪 ${money(chain.grain.arrears)}｜能源厂 ${chain.energy.count} 家 产 ${num(chain.energy.produced)} 售 ${num(chain.energy.sold)} 欠薪 ${money(chain.energy.arrears)}`,
    );
    console.log(
      `谷食物流（本地市场口径：成交不含跨城出口，进口见下一行） 谷物 价 ${num(chain.grainMarket?.price)} 需求 ${num(chain.grainMarket?.producerRequired)} 成交 ${num(chain.grainMarket?.sold)} 库存 ${num(chain.grainMarket?.closingStock)} 进口 ${num(chain.grainMarket?.intercityImported)}｜食品 价 ${num(chain.foodMarket?.price)} 成交 ${num(chain.foodMarket?.sold)} 需求 ${num(chain.foodMarket?.consumerDemand)} 库存 ${num(chain.foodMarket?.closingStock)} 进口 ${num(chain.foodMarket?.intercityImported)}｜能源 价 ${num(chain.energyMarket?.price)} 成交 ${num(chain.energyMarket?.sold)} 库存 ${num(chain.energyMarket?.closingStock)}`,
    );
    const trade = intercityTradeThisTick(world, city.id);
    console.log(
      `跨城贸易 本月进口 ${num(trade.importQty, 1)} 件/¥${num(trade.importValue, 1)}（${trade.importGoods.join('；') || '无'}）｜出口 ${num(trade.exportQty, 1)} 件/¥${num(trade.exportValue, 1)}（${trade.exportGoods.join('；') || '无'}）｜成交 ${trade.flowCount} 笔｜城内配送效率 ${trade.deliveryEfficiency === null ? 'n/a' : pct(trade.deliveryEfficiency)}｜跨城运力惩罚 ${trade.corridorPenalty > 0 ? pct(trade.corridorPenalty) : '0.0%'}`,
    );
    const gov = governmentFiscalDetail(world, city.id);
    console.log(
      `财政明细（窗口 ${gov.entries}/${gov.limit} 条${gov.truncated ? '，已触达账本上限、更早流水被裁剪' : ''}）税收 ${money(gov.tax)}（个税 ${money(gov.incomeTax)}/企业税 ${money(gov.corporateTax)}/消费税 ${money(gov.consumptionTax)}/股息税 ${money(gov.dividendTax)}；交通加成 ${money(gov.transportBonus)}、损耗 ${money(gov.transportLoss)} 单独列示，属游戏化财政调整、无对应纳税人）｜公共工资 ${money(gov.publicWages)}｜福利 ${money(gov.benefits)}｜政策 ${money(gov.policySpending)}｜交通 ${money(gov.transport)}｜政府贷款 ${money(gov.loanProceeds)}/还本息 ${money(gov.loanRepayment)}｜发债 ${money(gov.bondProceeds)}/付本息 ${money(gov.bondService)}｜银行垫付 ${money(gov.bankAdvance)}｜勾销 ${money(gov.writtenOff)}｜其他收入 ${money(gov.otherIncome)}｜选举费 ${money(gov.electionFee)}`,
    );
    const aiPolicy = aiPolicyStats(world, city.id);
    const checkup = aiPolicy.latest;
    console.log(
      checkup
        ? `AI 政府 失业档位 ${checkup.tier}（3 月均值 ${pct(checkup.unemploymentRateAvg3)}，趋势 ${checkup.unemploymentTrend >= 0 ? '+' : ''}${pct(checkup.unemploymentTrend)}；原始档 ${checkup.rawTier}）｜症结 ${checkup.symptoms.join('/') || '无'}｜月预算 ${money(checkup.budget)}（占近 12 月均税 ${pct(checkup.budgetShare, 0)}；真实税月 ${checkup.taxMonthsReal}/估算 ${checkup.taxMonthsEstimated}）｜债务/GDP ${pct(checkup.debtRatio)}${checkup.debtWarning ? '（≥85% 预警，预算缩减）' : ''}｜到期压力 债券 ${money(checkup.bondDue)}/贷款 ${money(checkup.loanDue)}｜本月执行 ${aiPolicy.runsThisTick} 项：支出 ${money(aiPolicy.spentThisTick)} 受益 ${num(aiPolicy.beneficiaries)} 真实岗位 ${num(aiPolicy.jobsEffect)}｜预算说明 ${checkup.budgetNote}`
        : `AI 政府 本月无体检快照（玩家市长或未启用 AI）｜执行 ${aiPolicy.runsThisTick} 项：支出 ${money(aiPolicy.spentThisTick)} 受益 ${num(aiPolicy.beneficiaries)} 真实岗位 ${num(aiPolicy.jobsEffect)}`,
    );
    if (aiPolicy.decisions) console.log(`AI 政策 在行：${aiPolicy.decisions}｜原因：${aiPolicy.reasons.join('；') || '无'}`);
    // v1.5 §4：三口径（参考预算 / 已预留 / 实际支出）与真实资金顺序（税收→公共工资/福利→借款到账→预留→实支）。
    const policyFunding = policyFundingMonthlyReport(world, city.id, world.time.tick);
    console.log(
      policyFunding
        ? `AI 政策资金 参考预算 ${money(policyFunding.referenceBudget)}｜真实预留 ${money(policyFunding.reserved)}｜实际支出 ${money(policyFunding.spent)}｜未支付 ${money(policyFunding.unpaid)}｜来源 ${policyFunding.fundingSource}｜为政策真实借款 ${money(policyFunding.borrowingProceeds)}（债务/GDP ${pct(policyFunding.debtRatioBefore)}→${pct(policyFunding.debtRatioAfterBorrowing)}）｜前置 税收 ${money(policyFunding.taxReceived)}/公共工资 ${money(policyFunding.publicWages)}/福利 ${money(policyFunding.benefitsPaid)}｜顺序 ${policyFunding.stages.map((stage) => stage.stage).join('→')}`
        : 'AI 政策资金 本月无资金追踪记录（玩家市长城市/非 AI 危机政策/旧档）',
    );
    const equity = investorEquityStats(world, city.id);
    console.log(
      `居民投资权益 有效份额 ${num(equity.totalShares)}（累计投入 ${num(equity.contributed)} + 开局 ${num(equity.opening)}）｜持有人 ${equity.holders}/${equity.groups} 群体｜实体现金 ${money(equity.entityCash)}｜债券估值 ${money(equity.bondsValue)}｜净资产 ${money(equity.netWorth)}｜每份净值 ${num(equity.navPerShare, 4)}｜零人仍持份 ${equity.zeroPeopleWithShares}（${num(equity.zeroPeopleShares)} 份）`,
    );
    const jobless = unemployedConsumption(world, city.id);
    console.log(
      `失业群体 人口 ${num(jobless.people)}｜现金 ${money(jobless.cash)}｜收入 ${money(jobless.income)}｜预算 ${money(jobless.budget)}｜成交 ${money(jobless.consumption)}/期望 ${money(jobless.desired)}｜资金不足 ${money(jobless.unmetFunding)}｜存款提取 ${money(jobless.depositWithdrawn)}｜贷款支持 ${money(jobless.loanFinanced)}`,
    );
    console.log(
      `破产 当前${info.bankrupt ? `是（tick ${info.bankruptcy?.tick ?? '?'}）` : '否'}｜${historyText}${info.history.truncated ? `（破产记录已达上限 ${info.history.maxRecords}，可能已截断更早记录）` : ''}｜税收窗口 ${info.taxes.months}/${info.taxes.windowMonths} 月：收入 ${money(info.taxes.tax)}｜交通加成 ${money(info.taxes.bonus)}｜交通损耗 ${money(info.taxes.loss)}`,
    );
    const sectorText = [...company.sectors.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([sector, count]) => `${sector}×${count}`)
      .join('/');
    console.log(
      `企业 ${company.active} 家（累计成立 ${company.founded} / 累计倒闭 ${company.liquidated}；近 12 月新办 ${company.foundedWindow} / 倒闭 ${company.liquidatedWindow}）｜行业 ${sectorText}｜产能 ${num(company.capacity)}｜计划产量 ${num(company.planned)}（岗位 ${num(company.plannedJobs)}）`,
    );
    console.log(
      `企业设备 farm ${num(company.equipmentKinds.farm)} / industry ${num(company.equipmentKinds.industry)} / energy ${num(company.equipmentKinds.energy)} 台｜本月购置 ${money(company.equipmentPurchased)} / 出售 ${money(company.equipmentSold)}`,
    );
    const initialEquipment = initialEquipmentStats(world, city.id);
    console.log(
      `初始设备 实物出资 ${initialEquipment.grants} 家/${num(initialEquipment.units)} 台（farm ${num(initialEquipment.kindUnits.farm ?? 0)}/industry ${num(initialEquipment.kindUnits.industry ?? 0)}/energy ${num(initialEquipment.kindUnits.energy ?? 0)}）估值 ${money(initialEquipment.valuation)}｜锁定期内 ${initialEquipment.locked} 家｜本月新授 ${initialEquipment.grantedThisTick} 家｜本月真实市场采购 ${money(initialEquipment.purchasedThisTick)}`,
    );
    console.log(
      `企业财务 营收 ${money(company.revenue)}｜COGS ${money(company.cogs)}（原料现金支出 ${money(company.inputCost)}）｜工资(含奖金) ${money(company.wages)}｜利息 ${money(company.interest)}｜企业税 ${money(company.tax)}｜退款收益 ${money(company.refundGain)}｜利润 ${money(company.profit)}｜现金 ${money(company.cash)}｜债务 ${money(company.debt)}｜欠薪 ${money(company.wageArrears)}｜本月紧急裁员 ${num(company.emergency)}`,
    );
    console.log(
      `居民消费 成交 ${money(consumption.consumption)}（现金支付 ${money(consumption.cashPaid)} + 存款提取 ${money(consumption.depositWithdrawn)} + 消费贷 ${money(consumption.loanFinanced)}；本月贷款发放 ${money(consumption.loanDrawn)}；成交件数 ${num(consumption.soldUnits, 1)}）｜有支付力有效需求 ${num(consumption.effectiveUnits, 1)} 件/¥${money(consumption.effectiveCost)}（期望成本 ${money(consumption.desiredCost)} 含买不起部分）｜资金不足缺口 ${money(consumption.unmetFunding)}｜商品不足缺口 ${num(consumption.supplyShortfallUnits, 1)} 件｜期望未形成 ${money(consumption.fundingGap)}`,
    );
    console.log(
      `基本需要 需要量 ${num(consumption.basicNeedQty, 1)} 件/月｜基本需要成交 ${num(consumption.basicNeedSold, 1)}｜需要覆盖率 ${consumption.basicNeedCoverage === null ? 'n/a' : pct(consumption.basicNeedCoverage)}（含跨城进口成交；与“有效需求满足率”不同，后者只统计买得起的部分）`,
    );
    console.log(
      `居民收入 工资 ${money(household.wages)}｜福利 ${money(household.benefits)}｜分红 ${money(household.dividends)}｜个税 ${money(household.incomeTax)}｜本月转入投资实体 ${money(household.invested)}`,
    );
    console.log(
      `居民现金 ${money(household.cash)}｜居民存款 ${money(household.deposits)}｜消费贷未偿 ${money(household.loanOutstanding)}（合同 ${household.loanCount} 笔，违约 ${household.defaulted} 笔，累计发放 ${money(household.borrowed)}）`,
    );
    const funding = investorFundingThisTick(world, city.id);
    const usage = investorUsageThisTick(world, city.id);
    const investorCash = investorCashInCity(world, city.id);
    const bondBuy = bondPurchasesThisTick(world, city.id);
    const attempts = foundingAttemptsThisTick(world, city.id);
    const foundedNow = attempts.filter((attempt) => attempt.outcome === 'founded').length;
    const rejectedNow = attempts.filter((attempt) => attempt.outcome === 'rejected');
    const obstacleText = [
      ...rejectedNow
        .flatMap((attempt) => attempt.obstacles.map((obstacle) => obstacle.kind))
        .reduce((map, kind) => map.set(kind, (map.get(kind) ?? 0) + 1), new Map<string, number>())
        .entries(),
    ]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 4)
      .map(([kind, count]) => `${kind}×${count}`)
      .join('/');
    console.log(
      `居民投资 本月转入 ${money(funding.amount)}（${funding.groups} 个群体）｜实体现金 ${money(investorCash)}｜用途 转入 ${money(usage?.contributed ?? 0)}/股息收 ${money(usage?.dividendsReceived ?? 0)}（返还 ${money(usage?.dividendsReturned ?? 0)}/留存 ${money(usage?.dividendsRetained ?? 0)}）/本期投资 ${money(usage?.invested ?? 0)}`,
    );
    console.log(
      `企业购债 本月新认购 ${num(bondBuy.units)} 份 / ${money(bondBuy.amount)}（${Object.entries(bondBuy.byKind)
        .map(([kind, amount]) => `${kind} ${money(amount)}`)
        .join(' / ') || '无'}）`,
    );
    console.log(
      `创业尝试 本月 ${attempts.length} 次（成立 ${foundedNow} / 被拒 ${rejectedNow.length}${obstacleText ? `；障碍 ${obstacleText}` : ''}）`,
    );
    const food = cityFoodMetrics(world, city);
    console.log(
      `食品口径 居民实际成交 ${num(food.residentSold, 1)} 件（本地 ${num(food.localResidentSold, 1)} + 进口 ${num(food.imported, 1)}；本地账本 ${num(food.ledgerSold, 1)}/出口 ${num(food.exported, 1)}）｜基本需要 ${num(food.basicNeed, 1)}｜基本需要覆盖率 ${food.coverage === null ? 'n/a' : pct(food.coverage)}｜有效需求满足率 ${food.satisfaction === null ? 'n/a（旧档缺有效需求口径）' : pct(food.satisfaction)}（有效需求 ${num(food.effectiveDemand, 1)}）｜校验 本地居民−账本 ${num(food.crossCheck, 1)}/进口−收货流 ${num(food.importCheck, 2)}｜口径 ${food.source}`,
    );
    console.log(
      `食品 ${describeGood('食品', marketStats(city, 'food'))}`,
    );
    console.log(
      `原料 ${describeGood('谷物', marketStats(city, 'grain'))}｜${describeGood('金属', marketStats(city, 'metal'))}｜${describeGood('能源', marketStats(city, 'energy'))}`,
    );
    console.log(
      `设备商品 ${describeGood('农机', marketStats(city, 'farmEquipment'))}｜${describeGood('工业设备', marketStats(city, 'industryEquipment'))}｜${describeGood('能源设备', marketStats(city, 'energyEquipment'))}`,
    );
    console.log(
      `政府流水（窗口累计：${fiscal.entries} 条，自 t${fiscal.startTick ?? '?'} 起，账本上限 ${fiscal.ledgerLimit}${fiscal.truncated ? '，已截断，更早流水不可得' : ''}）：收入 ${money(cum.govIncome)}｜支出 ${money(cum.govExpense)}｜清算勾销 ${money(cum.writtenOff)}`,
    );
  }

  const bank = bankStats(world);
  console.log(
    `\n## 银行：存款 ${money(bank.deposits)}｜贷款未偿 ${money(bank.outstanding)}｜合同 ${bank.total}（active ${bank.active} / defaulted ${bank.defaulted} / repaid ${bank.repaid}）｜本月发放 ${money(bank.lastMonth.principalIssued)}｜本月收回 ${money(bank.lastMonth.principalRepaid)}｜利息收入 ${money(bank.lastMonth.interestIncome)}｜利息支出 ${money(bank.lastMonth.interestExpense)}`,
  );

  const equipmentStock = world.equipmentMarket.initialStock;
  console.log(
    `## 设备市场：政府库存 farm ${equipmentStock.farm} / industry ${equipmentStock.industry} / energy ${equipmentStock.energy}｜二手挂单 ${world.equipmentMarket.offers.length}｜本月成交 farm ${world.equipmentMarket.lastMonthSold.farm} / industry ${world.equipmentMarket.lastMonthSold.industry} / energy ${world.equipmentMarket.lastMonthSold.energy}`,
  );

  const tracked = world.companies.find((company) => company.id === 'lp-food');
  if (tracked) {
    console.log(
      `## 岚港食品厂：员工 ${num(tracked.employees)}（岗位 ${num(tracked.jobDemand)}）｜产能 ${num(tracked.capacity)}｜设备 ${num(equipmentUnits(tracked, 'farm') + equipmentUnits(tracked, 'industry') + equipmentUnits(tracked, 'energy'))} 台｜计划 ${num(tracked.productionPlan?.plannedOutput ?? 0)}｜现金 ${money(tracked.cash)}｜债务 ${money(tracked.debt)}`,
    );
  } else {
    const liquidation = world.lifecycle.liquidations.find((record) => record.companyId === 'lp-food');
    console.log(`## 岚港食品厂：已倒闭${liquidation ? `（tick ${liquidation.tick}）` : ''}`);
  }

  const householdLoans = world.householdFinance.loans;
  console.log(
    `## 居民贷款：合同 ${householdLoans.length} 笔（全量保留）｜消费贷累计发放 ${money(householdLoans.reduce((sum, loan) => sum + loan.principal, 0))}｜未偿 ${money(householdLoans.reduce((sum, loan) => sum + loan.outstanding, 0))}｜违约 ${householdLoans.filter((loan) => loan.status === 'defaulted').length} 笔`,
  );
}

// v1.4：AI 政策执行与跨城贸易的本期逐月累计（脚本内存累计，不受历史保留窗口截断）。
interface AiTotals {
  runs: number;
  spent: number;
  beneficiaries: number;
  jobsEffect: number;
  debtWarningMonths: number;
  policyIds: Set<string>;
}

interface TradeTotals {
  importQty: number;
  importValue: number;
  exportQty: number;
  exportValue: number;
  byGood: Map<string, { importQty: number; exportQty: number }>;
}

const aiTotals = new Map<string, AiTotals>();
const tradeTotals = new Map<string, TradeTotals>();

function aiTotalsOf(cityId: string): AiTotals {
  let entry = aiTotals.get(cityId);
  if (!entry) {
    entry = { runs: 0, spent: 0, beneficiaries: 0, jobsEffect: 0, debtWarningMonths: 0, policyIds: new Set() };
    aiTotals.set(cityId, entry);
  }
  return entry;
}

function tradeTotalsOf(cityId: string): TradeTotals {
  let entry = tradeTotals.get(cityId);
  if (!entry) {
    entry = { importQty: 0, importValue: 0, exportQty: 0, exportValue: 0, byGood: new Map() };
    tradeTotals.set(cityId, entry);
  }
  return entry;
}

const TRADE_REPORT_GOODS = new Set([
  'food',
  'grain',
  'energy',
  'farmEquipment',
  'industryEquipment',
  'energyEquipment',
]);

/** 每月末累计 AI 政策真实执行与本城跨城贸易成交（只累计本月真实记录）。 */
function accumulateMonthlyFlows(world: WorldState): void {
  const tick = world.time.tick;
  for (const city of world.cities) aiTotalsOf(city.id);
  for (const policy of world.policies.active) {
    const entry = aiTotalsOf(policy.cityId);
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
    const entry = aiTotalsOf(checkup.cityId);
    if (checkup.debtWarning) entry.debtWarningMonths += 1;
  }
  for (const flow of world.lastTick.tradeFlows) {
    if (!TRADE_REPORT_GOODS.has(flow.good)) continue;
    const pairs: [string, boolean][] = [
      [flow.fromCityId, false],
      [flow.toCityId, true],
    ];
    for (const [cityId, isImport] of pairs) {
      const entry = tradeTotalsOf(cityId);
      const good = entry.byGood.get(flow.good) ?? { importQty: 0, exportQty: 0 };
      if (isImport) {
        entry.importQty += flow.qty;
        entry.importValue += flow.value;
        good.importQty += flow.qty;
      } else {
        entry.exportQty += flow.qty;
        entry.exportValue += flow.value;
        good.exportQty += flow.qty;
      }
      entry.byGood.set(flow.good, good);
    }
  }
}

function printSummary(world: WorldState) {
  console.log(`\n${'='.repeat(88)}`);
  console.log('# 汇总（按城市，最后一次观察）');
  console.log(`${'='.repeat(88)}`);
  for (const city of world.cities) {
    const company = companyStats(world, city.id);
    const history = bankruptcyHistory(city);
    const historyText =
      history.count > 0 ? `${history.count} 次（tick ${history.ticks.join('/')}）` : '0 次';
    console.log(
      `${city.name}：企业成立 ${company.founded} / 倒闭 ${company.liquidated}｜政府历史破产 ${historyText}｜当前状态 ${history.current.status}${history.truncated ? `｜破产记录已达上限 ${history.maxRecords}，更早记录可能被截断` : ''}`,
    );
  }
  // v1.0：设备产业真实生产/成交（按 tick 逐月累计，见下方 main 循环）。
  console.log(
    `设备产业累计：生产 farm ${num(equipmentFlow.produced.farmEquipment ?? 0)} / industry ${num(equipmentFlow.produced.industryEquipment ?? 0)} / energy ${num(equipmentFlow.produced.energyEquipment ?? 0)} 台｜企业购置支出 ${money(equipmentFlow.purchasedValue)}｜设备出售收入 ${money(equipmentFlow.soldValue)}`,
  );
  for (const seller of [...equipmentFlow.sellers.values()].sort((a, b) => b.produced - a.produced)) {
    console.log(
      `  - ${seller.name}（${seller.cityId}）：累计生产 ${num(seller.produced)} 台｜累计售出 ${num(seller.sold)} 台`,
    );
  }
  // v1.4 §4：初始实物设备来源与规模（当前企业账 + 生命周期创办记录）。
  const lifecycleLimitForEquipment = DEMO_CONFIG.lifecycle.maxHistory;
  const equipmentRecords = world.lifecycle.foundings.filter((record) => record.initialEquipment);
  console.log(
    `初始设备（模拟范围外实物出资）合计：当前 ${world.companies.filter((company) => company.initialEquipment).length} 家企业持有/${num(
      world.companies.reduce((sum, company) => sum + (company.initialEquipment?.units ?? 0), 0),
    )} 台/估值 ${money(world.companies.reduce((sum, company) => sum + (company.initialEquipment?.valuation ?? 0), 0))}；生命周期窗口内带实物出资的创办记录 ${equipmentRecords.length} 条/${num(
      equipmentRecords.reduce((sum, record) => sum + (record.initialEquipment?.units ?? 0), 0),
    )} 台（上限 ${lifecycleLimitForEquipment} 条，更早记录可能被截断）`,
  );
  for (const city of world.cities) {
    const grants = world.companies.filter((company) => company.cityId === city.id && company.initialEquipment);
    const aiTotalsCity = aiTotalsOf(city.id);
    const tradeTotalsCity = tradeTotalsOf(city.id);
    const goodText = [...tradeTotalsCity.byGood.entries()]
      .sort((a, b) => b[1].importQty + b[1].exportQty - (a[1].importQty + a[1].exportQty))
      .map(([good, value]) => `${good} 进 ${num(value.importQty, 1)}/出 ${num(value.exportQty, 1)}`)
      .join('；');
    console.log(
      `${city.name} 初始设备 持有 ${grants.length} 家/${num(grants.reduce((sum, company) => sum + (company.initialEquipment?.units ?? 0), 0))} 台｜估值 ${money(grants.reduce((sum, company) => sum + (company.initialEquipment?.valuation ?? 0), 0))}`,
    );
    console.log(
      `${city.name} AI 政策累计（逐月真实执行，脚本累计）：执行 ${aiTotalsCity.runs} 次｜支出 ${money(aiTotalsCity.spent)}｜受益 ${num(aiTotalsCity.beneficiaries)}｜真实岗位 ${num(aiTotalsCity.jobsEffect)}｜债务预警月数 ${aiTotalsCity.debtWarningMonths}｜政策 ${[...aiTotalsCity.policyIds].sort().join('/') || '无'}`,
    );
    // v1.5 §4：持久化 fundingMonths 窗口累计（保留最近 24 月，超出截断；不是全期累计）。
    const fundingMonths = (world.policies.fundingMonths ?? []).filter((entry) => entry.cityId === city.id);
    const fundingWindow = fundingMonths.length >= DEMO_CONFIG.policies.aiLabor.policyFunding.retentionMonths;
    const fundingTotal = fundingMonths.reduce(
      (sum, entry) => ({
        reference: sum.reference + entry.referenceBudget,
        reserved: sum.reserved + entry.reserved,
        spent: sum.spent + entry.spent,
        unpaid: sum.unpaid + entry.unpaid,
        borrowed: sum.borrowed + entry.borrowingProceeds,
      }),
      { reference: 0, reserved: 0, spent: 0, unpaid: 0, borrowed: 0 },
    );
    console.log(
      `${city.name} AI 政策资金窗口（${fundingMonths.length} 月${fundingWindow ? `，保留上限 ${DEMO_CONFIG.policies.aiLabor.policyFunding.retentionMonths} 月，可能已截断` : ''}）：参考 ${money(fundingTotal.reference)}｜预留 ${money(fundingTotal.reserved)}｜实支 ${money(fundingTotal.spent)}｜未支付 ${money(fundingTotal.unpaid)}｜政策借款到账 ${money(fundingTotal.borrowed)}`,
    );
    console.log(
      `${city.name} 跨城贸易累计（关键商品，脚本逐月累计）：进口 ${num(tradeTotalsCity.importQty, 1)} 件/¥${num(tradeTotalsCity.importValue, 1)}｜出口 ${num(tradeTotalsCity.exportQty, 1)} 件/¥${num(tradeTotalsCity.exportValue, 1)}${goodText ? `｜${goodText}` : ''}`,
    );
  }
  const investorCash = world.investors.reduce((sum, investor) => sum + investor.cash, 0);
  console.log(`投资实体现金合计 ${money(investorCash)}（${world.investors.length} 家）`);
  const fundingHistory = world.households.investorFundingHistory ?? [];
  const usageHistory = world.households.investorUsageHistory ?? [];
  for (const city of world.cities) {
    const funding = fundingHistory
      .filter((entry) => entry.cityId === city.id)
      .reduce((sum, entry) => sum + entry.amount, 0);
    const usage = usageHistory.filter((entry) => entry.cityId === city.id);
    const contributed = usage.reduce((sum, entry) => sum + entry.contributed, 0);
    const dividendsIn = usage.reduce((sum, entry) => sum + entry.dividendsReceived, 0);
    const returned = usage.reduce((sum, entry) => sum + entry.dividendsReturned, 0);
    const retained = usage.reduce((sum, entry) => sum + entry.dividendsRetained, 0);
    const invested = usage.reduce((sum, entry) => sum + entry.invested, 0);
    console.log(
      `${city.name} 居民→投资实体累计 转入 ${money(funding)}｜实体现金 ${money(investorCashInCity(world, city.id))}｜用途累计 转入 ${money(contributed)}/股息收 ${money(dividendsIn)}（返还 ${money(returned)}/留存 ${money(retained)}）/投资 ${money(invested)}`,
    );
  }
  const companyBondTotal = (world.bonds?.holdings ?? [])
    .filter((holding) => holding.holder.kind === 'company' && holding.status === 'active')
    .reduce((sum, holding) => sum + holding.principal, 0);
  const investorBondTotal = (world.bonds?.holdings ?? [])
    .filter((holding) => holding.holder.kind === 'investorGroup' && holding.status === 'active')
    .reduce((sum, holding) => sum + holding.principal, 0);
  console.log(
    `企业购债存量（active）：企业 ${money(companyBondTotal)} / 居民投资实体 ${money(investorBondTotal)}｜本月新认购见各 checkpoint`,
  );
  const attemptLog = foundingAttempts(world);
  const rejected = attemptLog.filter((attempt) => attempt.outcome === 'rejected');
  const obstacles = new Map<string, number>();
  for (const attempt of rejected) {
    for (const obstacle of attempt.obstacles) obstacles.set(obstacle.kind, (obstacles.get(obstacle.kind) ?? 0) + 1);
  }
  const truncatedAttempts = foundingAttemptsTruncated(world);
  console.log(
    `创业尝试累计（保留最近 ${attemptLog.length} 条${truncatedAttempts > 0 ? `，更早 ${truncatedAttempts} 条已按记录上限裁剪` : ''}）成立 ${attemptLog.length - rejected.length} / 被拒 ${rejected.length}｜障碍 ${[...obstacles.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([kind, count]) => `${kind}×${count}`)
      .join(' / ') || '无'}`,
  );
  const foodGood = GOODS.find((good) => good.id === 'food');
  const allImported = round2(
    world.cities.reduce((sum, city) => sum + (city.market['food']?.intercityImported ?? 0), 0),
  );
  const allExported = round2(
    world.lastTick.tradeFlows
      .filter((flow) => flow.good === 'food')
      .reduce((sum, flow) => sum + flow.qty, 0),
  );
  console.log(
    `食品跨城口径校验（当月）：三城进口合计 ${num(allImported, 1)} 件｜跨城成交流合计 ${num(allExported, 1)} 件｜差 ${num(round2(allImported - allExported), 2)}（应≈0，进口只计一次）`,
  );
  for (const city of world.cities) {
    const food = cityFoodMetrics(world, city);
    console.log(
      `基本食品 需要量 ${num(food.basicNeed)} 件/月（人均 ${foodGood?.perCapitaMonthlyNeed ?? 0}×人口 ${num(city.population.total)}）｜居民实际成交 ${num(food.residentSold, 1)} 件（本地 ${num(food.localResidentSold, 1)} + 进口 ${num(food.imported, 1)}）｜基本需要覆盖率 ${food.coverage === null ? '—' : `${(food.coverage * 100).toFixed(1)}%`}｜有效需求满足率 ${food.satisfaction === null ? 'n/a' : `${(food.satisfaction * 100).toFixed(1)}%`}（有效需求 ${num(food.effectiveDemand, 1)}）｜市场账本成交（当月） ${num(food.ledgerSold, 1)}/出口（当月） ${num(food.exported, 1)}｜校验 本地居民−账本 ${num(food.crossCheck, 1)}/进口−收货流 ${num(food.importCheck, 2)}｜口径 ${food.source}`,
    );
    const initial = initialEmployment.get(city.id);
    // 失业率口径 = 失业 / 劳动力（就业+失业），与 checkpoint 的“失业率”一致。
    const laborForce = city.population.employed + city.population.unemployed;
    const rate = laborForce > 0 ? city.population.unemployed / laborForce : 0;
    const initialLaborForce = initial ? initial.employed + (initial.total - initial.employed) : 0;
    const initialRate = initial ? (initial.total - initial.employed) / initial.total : null;
    const delta = initialRate === null ? '' : `｜失业率 ${pct(rate)}（较首个观察点 ${(rate - initialRate >= 0 ? '+' : '') + ((rate - initialRate) * 100).toFixed(1)}pp）`;
    console.log(
      `食品满足率 ${city.name}：${food.satisfaction === null ? 'n/a（无有效需求/旧档）' : pct(food.satisfaction)}（居民实际成交 ${num(food.residentSold, 1)} / 有效需求 ${num(food.effectiveDemand, 1)}；其中本地 ${num(food.localResidentSold, 1)} + 进口 ${num(food.imported, 1)}）${delta}`,
    );
  }

  const founded = world.lifecycle.foundings;
  const bySector = new Map<string, number>();
  for (const record of founded) bySector.set(record.sector, (bySector.get(record.sector) ?? 0) + 1);
  console.log(
    `创办合计 ${founded.length} 家｜按行业 ${[...bySector.entries()].map(([sector, count]) => `${sector}:${count}`).join(' / ')}`,
  );
  const grants = founded.reduce((sum, record) => sum + (record.governmentGrant ?? 0), 0);
  console.log(`创办政府补助合计 ${money(grants)}`);
  const liquidations = world.lifecycle.liquidations;
  console.log(
    `倒闭合计 ${liquidations.length} 家｜清算减免 ${money(liquidations.reduce((sum, record) => sum + (record.forgiven ?? 0), 0))}`,
  );
  const lifecycleLimit = DEMO_CONFIG.lifecycle.maxHistory;
  console.log(
    `## 数据来源与保留窗口` +
      `\n- 企业创办/倒闭明细：world.lifecycle.foundings/liquidations（上限 ${lifecycleLimit} 条，超出丢弃更早记录；当前 ${founded.length}/${liquidations.length}）` +
      `\n- 财政流水：world.fiscal.ledger（上限 ${DEMO_CONFIG.policies.ledgerLimit} 条，窗口累计）` +
      `\n- 税收月度：world.taxes.historyByCity（每城最近 ${DEMO_CONFIG.tax.historyMonths} 个月）` +
      `\n- 破产历史：city.government.records（上限 ${DEMO_CONFIG.government.maxBankruptcyRecords} 条）` +
      `\n- 银行/居民贷款合同：全量保留（无 splice），principal 合计即全期累计` +
      `\n- 居民消费：household.lastMonth + 城市市场账本（成交/期望/缺货/资金缺口分列）`,
  );
  const history = world.history;
  if (history.length > 0) {
    const first = history[0]!;
    const last = history[history.length - 1]!;
    console.log(
      `历史区间 ${first.year}-${String(first.month).padStart(2, '0')} → ${last.year}-${String(last.month).padStart(2, '0')}`,
    );
  }
}

interface EquipmentFlow {
  produced: Record<string, number>;
  purchasedValue: number;
  soldValue: number;
  sellers: Map<string, { name: string; cityId: string; produced: number; sold: number }>;
}

const EQUIPMENT_GOOD_IDS = new Set(['farmEquipment', 'industryEquipment', 'energyEquipment']);
const equipmentFlow: EquipmentFlow = {
  produced: {},
  purchasedValue: 0,
  soldValue: 0,
  sellers: new Map(),
};

function accumulateEquipmentFlow(world: WorldState): void {
  for (const company of world.companies) {
    equipmentFlow.purchasedValue += company.lastMonth.equipmentPurchased ?? 0;
    equipmentFlow.soldValue += company.lastMonth.equipmentSold ?? 0;
    if (!EQUIPMENT_GOOD_IDS.has(company.recipeOutput)) continue;
    const produced = company.lastMonth.produced;
    const sold = company.lastMonth.sold;
    equipmentFlow.produced[company.recipeOutput] =
      (equipmentFlow.produced[company.recipeOutput] ?? 0) + produced;
    const seller = equipmentFlow.sellers.get(company.id) ?? {
      name: company.name,
      cityId: company.cityId,
      produced: 0,
      sold: 0,
    };
    seller.produced += produced;
    seller.sold += sold;
    equipmentFlow.sellers.set(company.id, seller);
  }
}

const runtimeConfig = { ...DEMO_CONFIG, simulation: { ...DEMO_CONFIG.simulation, seed: SEED } } as typeof DEMO_CONFIG;
console.log(`\n# v1.3 经济观察｜种子 ${SEED}｜观察 ${MONTHS} 月｜当日检查点 ${CHECKPOINTS.join('/')}`);
const simulation = Simulation.create(runtimeConfig);
for (let month = 1; month <= MONTHS; month += 1) {
  simulation.tick();
  accumulateEquipmentFlow(simulation.state);
  accumulateMonthlyFlows(simulation.state);
  if (CHECKPOINTS.includes(month)) printCheckpoint(simulation.state);
}
printSummary(simulation.state);
