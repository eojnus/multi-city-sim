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
import type { City, Company, WorldState } from '../src/simulation/contracts/types';
import {
  assessCityFiscalRisk,
  cityDebt,
  isCityBankrupt,
  recent12MonthGdp,
} from '../src/simulation/government/metrics';
import { equipmentUnits } from '../src/simulation/equipment/equipment';

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

function companyStats(world: WorldState, cityId: string) {
  const companies = world.companies.filter((company) => company.cityId === cityId);
  const active = companies.length;
  const founded = world.lifecycle.foundings.filter((record) => record.cityId === cityId).length;
  const liquidated = world.lifecycle.liquidations.filter((record) => record.cityId === cityId).length;
  const equipment = companies.reduce(
    (sum, company) =>
      sum + equipmentUnits(company, 'farm') + equipmentUnits(company, 'industry') + equipmentUnits(company, 'energy'),
    0,
  );
  const capacity = companies.reduce((sum, company) => sum + company.capacity, 0);
  const planned = companies.reduce((sum, company) => sum + (company.productionPlan?.plannedOutput ?? 0), 0);
  const plannedJobs = companies.reduce((sum, company) => sum + (company.productionPlan?.plannedJobs ?? 0), 0);
  const wageArrears = companies.reduce((sum, company) => sum + Math.max(0, (company.lastMonth.wageArrears ?? 0)), 0);
  const cash = companies.reduce((sum, company) => sum + company.cash, 0);
  const debt = companies.reduce((sum, company) => sum + company.debt, 0);
  const emergency = companies.reduce((sum, company) => sum + (company.lastMonth.emergencyLayoffs ?? 0), 0);
  return { active, founded, liquidated, equipment, capacity, planned, plannedJobs, wageArrears, cash, debt, emergency };
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
  const deposits = world.banking.deposits
    .filter((account) => account.owner.kind === 'household')
    .reduce((sum, account) => sum + account.balance, 0);
  return { cash, loanOutstanding, defaulted, consumption, income, desires, deposits };
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

function taxTotal12(world: WorldState, cityId: string): { tax: number; bonus: number; loss: number } {
  const history = world.taxes.historyByCity[cityId] ?? [];
  let tax = 0;
  let bonus = 0;
  let loss = 0;
  for (const month of history) {
    tax += month.incomeTaxRevenue + month.corporateTaxRevenue + month.consumptionTaxRevenue + month.dividendTaxRevenue;
    bonus += month.transportBonus;
    loss += month.transportLoss;
  }
  return { tax, bonus, loss };
}

function describeCity(world: WorldState, city: City) {
  const population = city.population;
  const employed = population.employed;
  const rate = 1 - employed / Math.max(1, population.laborForce);
  const debt = cityDebt(world, city.id);
  const gdp12 = recent12MonthGdp(world, city.id);
  const risk = assessCityFiscalRisk(world, city.id, DEMO_CONFIG);
  const taxes = taxTotal12(world, city.id);
  const bankruptcy = city.government.bankruptcy;
  return {
    city,
    rate,
    debt,
    gdp12: gdp12.sum,
    risk,
    taxes,
    bankrupt: isCityBankrupt(city),
    bankruptcy,
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
    const cum = cityCumulative(world, city.id);
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
      `破产 ${info.bankrupt ? `是（tick ${info.bankruptcy?.tick ?? '?'}）` : '否'}｜累计税收入账 ${money(info.taxes.tax)}｜交通加成 ${money(info.taxes.bonus)}｜交通损耗 ${money(info.taxes.loss)}`,
    );
    console.log(
      `企业 ${company.active} 家（成立 ${company.founded} / 倒闭 ${company.liquidated}）｜设备 ${num(company.equipment)} 台｜产能 ${num(company.capacity)}｜计划产量 ${num(company.planned)}（岗位 ${num(company.plannedJobs)}）`,
    );
    console.log(
      `企业现金 ${money(company.cash)}｜企业债务 ${money(company.debt)}｜欠薪 ${money(company.wageArrears)}｜本月紧急裁员 ${num(company.emergency)}`,
    );
    console.log(
      `居民消费 ${money(household.consumption)}（期望 ${money(household.desires)}）｜居民现金 ${money(household.cash)}｜存款 ${money(household.deposits)}｜消费贷未偿 ${money(household.loanOutstanding)}（违约 ${household.defaulted} 笔）`,
    );
    console.log(
      `政府流水（累计，来自财政账本）：收入 ${money(cum.govIncome)}｜支出 ${money(cum.govExpense)}｜清算勾销 ${money(cum.writtenOff)}`,
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

  const householdLoans = world.householdFinance.loans.length;
  console.log(
    `## 居民贷款：合同 ${householdLoans} 笔｜消费贷累计发放 ${money(world.householdFinance.totalBorrowed ?? 0)}`,
  );
}

function printSummary(world: WorldState) {
  console.log(`\n${'='.repeat(88)}`);
  console.log('# 汇总（按城市，最后一次观察）');
  console.log(`${'='.repeat(88)}`);
  for (const city of world.cities) {
    const company = companyStats(world, city.id);
    console.log(
      `${city.name}：企业成立 ${company.founded} / 倒闭 ${company.liquidated}｜政府破产 ${(city.government.bankruptcy.status === 'bankrupt' ? '有' : '无')}`,
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
  const history = world.history;
  if (history.length > 0) {
    const first = history[0]!;
    const last = history[history.length - 1]!;
    console.log(
      `历史区间 ${first.year}-${String(first.month).padStart(2, '0')} → ${last.year}-${String(last.month).padStart(2, '0')}`,
    );
  }
}

const simulation = Simulation.create(DEMO_CONFIG);
for (let month = 1; month <= MONTHS; month += 1) {
  simulation.tick();
  if (CHECKPOINTS.includes(month)) printCheckpoint(simulation.state);
}
printSummary(simulation.state);
