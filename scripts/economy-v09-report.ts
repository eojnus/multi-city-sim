// v0.9 经济循环观察脚本（只读：不改变规则、不写存档、不调用玩家操作）。
//
// 用法：npx tsx scripts/economy-v09-report.ts [--months=72] [--checkpoints=1,12,24,36,72]
//
// 固定条件：Simulation.create(DEMO_CONFIG)、默认种子、玩家无操作、默认 AI。
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

const MONTHS = argNumber('--months', 72);
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

/** 居民消费四层口径（每城）：期望成本 / 成交 / 资金不足缺口 / 预算未形成需求。 */
function cityConsumption(world: WorldState, cityId: string) {
  const groups = world.households.groups.filter((group) => group.cityId === cityId);
  const sum = (pick: (group: (typeof groups)[number]) => number) =>
    groups.reduce((total, group) => total + Math.max(0, pick(group)), 0);
  const desiredCost = sum((group) => group.lastMonth.desiredConsumption);
  const consumption = sum((group) => group.lastMonth.consumption);
  const unmetFunding = sum((group) => group.lastMonth.unmetFunding ?? 0);
  const loanFinanced = sum((group) => group.lastMonth.loanFinancedConsumption ?? 0);
  const loanDrawn = sum((group) => group.lastMonth.loanDrawn ?? 0);
  const depositWithdrawn = sum((group) => group.lastMonth.depositWithdrawn ?? 0);
  const budget = sum((group) => group.lastMonth.budget ?? 0);
  // 期望成本中既没有成交、也没有被记为“资金不足”的部分 = 预算/有效需求没有形成，
  // 与“有供给但缺钱”分开报告；两者都不是供给不足。
  const fundingGap = Math.round(Math.max(0, desiredCost - consumption - unmetFunding) * 100) / 100;
  // “有预算但没有商品供给”：消费购买口径下未成交的消费品数量 × 当月市场价（下限估算）。
  // consumerDemand/sold 来自城市市场账本；这里只统计 category=consumer 的商品，避免把
  // 企业投入品采购混进来。价格为当月市场价，不代表成交价。
  let supplyGapUnits = 0;
  let supplyGapValue = 0;
  for (const good of GOODS) {
    if (good.category !== 'consumer') continue;
    const market = world.cities.find((city) => city.id === cityId)?.market[good.id];
    if (!market) continue;
    const unfilled = Math.max(0, (market.consumerDemand ?? 0) - (market.sold ?? 0));
    supplyGapUnits += unfilled;
    supplyGapValue += unfilled * (market.price ?? 0);
  }
  return {
    desiredCost,
    consumption,
    unmetFunding,
    fundingGap,
    loanFinanced,
    loanDrawn,
    depositWithdrawn,
    budget,
    supplyGapUnits: Math.round(supplyGapUnits * 100) / 100,
    supplyGapValue: Math.round(supplyGapValue * 100) / 100,
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

function printCheckpoint(world: WorldState) {
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
    console.log(
      `企业财务 营收 ${money(company.revenue)}｜原料 ${money(company.inputCost)}｜工资(含奖金) ${money(company.wages)}｜利息 ${money(company.interest)}｜企业税 ${money(company.tax)}｜利润 ${money(company.profit)}｜现金 ${money(company.cash)}｜债务 ${money(company.debt)}｜欠薪 ${money(company.wageArrears)}｜本月紧急裁员 ${num(company.emergency)}`,
    );
    console.log(
      `居民消费 成交 ${money(consumption.consumption)}（期望 ${money(consumption.desiredCost)}）｜有本地供给但资金不足 ${money(consumption.unmetFunding)}｜预算缩量未形成购买 ${money(consumption.fundingGap)}｜有预算但缺货 ${num(consumption.supplyGapUnits, 1)} 件≈${money(consumption.supplyGapValue)}｜消费贷支持 ${money(consumption.loanFinanced)}（本月发放 ${money(consumption.loanDrawn)}）｜存款提取 ${money(consumption.depositWithdrawn)}`,
    );
    console.log(
      `居民收入 工资 ${money(household.wages)}｜福利 ${money(household.benefits)}｜分红 ${money(household.dividends)}｜个税 ${money(household.incomeTax)}｜本月转入投资实体 ${money(household.invested)}`,
    );
    console.log(
      `居民现金 ${money(household.cash)}｜居民存款 ${money(household.deposits)}｜消费贷未偿 ${money(household.loanOutstanding)}（合同 ${household.loanCount} 笔，违约 ${household.defaulted} 笔，累计发放 ${money(household.borrowed)}）`,
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
  const investorCash = world.investors.reduce((sum, investor) => sum + investor.cash, 0);
  console.log(`投资实体现金合计 ${money(investorCash)}（${world.investors.length} 家）`);

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

const simulation = Simulation.create(DEMO_CONFIG);
for (let month = 1; month <= MONTHS; month += 1) {
  simulation.tick();
  accumulateEquipmentFlow(simulation.state);
  if (CHECKPOINTS.includes(month)) printCheckpoint(simulation.state);
}
printSummary(simulation.state);
