// 经济平衡观察脚本（只读：不改变游戏规则、不写存档、不调用玩家操作）。
// 用法：npx tsx scripts/economy-balance-report.ts [--months=36] [--json[=path]] [--csv[=path]] [--repeat]
//
// 固定条件（任务书 §五.3 / 设计稿 DESIGN_economy_balance_report.md）：
//   Simulation.create(DEMO_CONFIG)、种子与开局 2026-01 取 config、玩家无操作、默认 AI、36 个月。
// 输出：控制台文本 + 可选 JSON / CSV；--repeat 会独立重跑一次并比对逐月序列以自检确定性。
//
// 说明（v0.7 基线，块 0 契约 + 数值岗首版暂定参数）：
//   - 债务/预警/GDP 窗口三个口径一律调用契约层 metrics.ts（v1.4 #36），不自行重算。
//   - 债券、政府贷款/垫付、居民消费贷、破产清算业务由块 1/3 实现；报告已留块6 扩展点
//     （collectBonds / BondObservation），落地后只改映射函数，不动报告结构与 CSV 列。
//   - 会计利润 vs 经营现金流使用公司月结字段的近似式，见 E 段说明。

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Simulation } from '../src/simulation/core/simulation';
import { DEMO_CONFIG } from '../src/data/config';
import { householdGroupsOfCity } from '../src/simulation/population/household-groups';
import { depositAccountFor } from '../src/simulation/banking/banking';
import { monthlyWageBill } from '../src/simulation/companies/company';
import type { City, Company, WorldState } from '../src/simulation/contracts/types';
import { cityDebt, recent12MonthGdp, assessCityFiscalRisk } from '../src/simulation/government/metrics';

// ---------------------------------------------------------- 块6 扩展点：债券观察
// 块6（36 月观察表设计见 docs/development/DESIGN_block6_36m_observation_tables.md）依赖
// 块 1 的 WorldState.bonds 落地。落地后只需实现 collectBonds() 内的映射（字段名见该设计稿
// 与 IMPLEMENTATION_v0.7 §12 的 bonds 结构），报告 [D]/JSON/CSV 骨架保持不变。
// 严禁在未落地时返回空数组伪装"无发行"；返回 null 表示"机制未实现"，报告如实标注。

interface BondIssueRow {
  issueId: string;
  cityId: string;
  cityName: string;
  tick: number;
  plannedUnits: number;
  soldUnits: number;
  unsoldUnits: number;
  /** soldUnits / plannedUnits；plannedUnits=0 时为 null。 */
  coverageRatio: number | null;
  /** 认购主体结构（含跨城标记）。 */
  holders: Array<{ holderType: string; units: number; crossCity: boolean }>;
  couponPaid: number;
  couponArrears: number;
  principalRepaid: number;
  bankAdvance: number;
}

interface BondObservation {
  issues: BondIssueRow[];
  /** 逐月汇总（块6 表 D2）：发行期数/计划份/成交份/未售/垫付/票息/还本/欠息。 */
  months: Array<{
    tick: number;
    issues: number;
    plannedUnits: number;
    soldUnits: number;
    unsoldUnits: number;
    bankAdvance: number;
    couponPaid: number;
    /** 当期"新增欠付利息"无法从账本期末快照反推 → 记 null；欠付余额看 D3 的 bondAccruedInterest 逐月序列。 */
    couponArrears: number | null;
    principalRepaid: number;
  }>;
}

function holderCityId(world: WorldState, holder: { kind: string; id: string }): string | null {
  if (holder.kind === 'player') return world.player.homeCityId;
  if (holder.kind === 'company') return world.companies.find((item) => item.id === holder.id)?.cityId ?? null;
  if (holder.kind === 'investorGroup') return world.investors.find((item) => item.id === holder.id)?.cityId ?? null;
  return null;
}

function collectBonds(world: WorldState): BondObservation | null {
  // world.bonds 未初始化（旧存档/块 0 前）→ null（"机制未落地"，不是"无发行"）。
  const bonds = world.bonds;
  if (!bonds || !Array.isArray(bonds.issuances)) return null;
  const cityNames = new Map(world.cities.map((city) => [city.id, city.name]));
  const issues: BondIssueRow[] = bonds.issuances.map((issuance) => {
    const holdings = bonds.holdings.filter((item) => item.issuanceId === issuance.id);
    return {
      issueId: issuance.id,
      cityId: issuance.cityId,
      cityName: cityNames.get(issuance.cityId) ?? issuance.cityId,
      tick: issuance.issuedTick,
      plannedUnits: issuance.planUnits,
      soldUnits: issuance.soldUnits,
      unsoldUnits: issuance.unsoldUnits,
      coverageRatio: issuance.planUnits > 0 ? issuance.soldUnits / issuance.planUnits : null,
      holders: holdings.map((holding) => {
        const holderCity = holderCityId(world, holding.holder);
        return {
          holderType: holding.holder.kind,
          units: holding.units,
          crossCity: holderCity !== null && holderCity !== issuance.cityId,
        };
      }),
      couponPaid: issuance.interestPaid,
      couponArrears: issuance.arrearsInterest,
      principalRepaid: issuance.principalRepaid,
      bankAdvance: issuance.bankAdvancedAmount,
    };
  });
  const monthMap = new Map<number, BondObservation['months'][number]>();
  const ensureMonth = (tick: number): BondObservation['months'][number] => {
    let row = monthMap.get(tick);
    if (!row) {
      row = {
        tick,
        issues: 0,
        plannedUnits: 0,
        soldUnits: 0,
        unsoldUnits: 0,
        bankAdvance: 0,
        couponPaid: 0,
        couponArrears: null,
        principalRepaid: 0,
      };
      monthMap.set(tick, row);
    }
    return row;
  };
  for (const issuance of bonds.issuances) {
    const row = ensureMonth(issuance.issuedTick);
    row.issues += 1;
    row.plannedUnits += issuance.planUnits;
    row.soldUnits += issuance.soldUnits;
    row.unsoldUnits += issuance.unsoldUnits;
  }
  for (const payment of bonds.payments) {
    const row = ensureMonth(payment.tick);
    if (payment.kind === 'coupon') row.couponPaid += payment.interestPaid;
    row.principalRepaid += payment.principalPaid;
    if (payment.fundedByBankAdvance) row.bankAdvance += payment.principalPaid + payment.interestPaid;
  }
  const months = [...monthMap.values()].sort((a, b) => a.tick - b.tick);
  return { issues, months };
}

const GOVERNMENT_FINANCING_KINDS = [
  'bondIssuanceProceeds',
  'bondInterest',
  'bondPrincipal',
  'bankAdvance',
  'governmentLoanProceeds',
  'governmentLoanRepayment',
  'governmentLoanInterest',
  'debtWriteOff',
] as const;

function collectGovernmentProbe(world: WorldState, monthly: MonthRow[], months: number): GovernmentProbe {
  const cityNames = new Map(world.cities.map((city) => [city.id, city.name]));
  const bonds = world.bonds;

  const bondIssuanceByCity = world.cities.map((city) => {
    const list = (bonds?.issuances ?? []).filter((issuance) => issuance.cityId === city.id);
    return {
      cityId: city.id,
      cityName: city.name,
      issues: list.length,
      firstTick: list.length > 0 ? Math.min(...list.map((item) => item.issuedTick)) : null,
      lastTick: list.length > 0 ? Math.max(...list.map((item) => item.issuedTick)) : null,
      plannedUnits: round2(list.reduce((sum, item) => sum + item.planUnits, 0)),
      soldUnits: round2(list.reduce((sum, item) => sum + item.soldUnits, 0)),
      unsoldUnits: round2(list.reduce((sum, item) => sum + item.unsoldUnits, 0)),
    };
  });

  const bankruptcies: GovernmentProbe['bankruptcies'] = [];
  for (const city of world.cities) {
    for (const record of city.government?.records ?? []) {
      const election = world.politics.elections.find(
        (item) => item.tick === record.tick && item.cityId === city.id,
      );
      const shareNote = record.note.includes('股份转移：') ? record.note.split('股份转移：')[1]!.trim() : '—';
      bankruptcies.push({
        cityId: city.id,
        cityName: city.name,
        tick: record.tick,
        debtRatio: record.debtRatio,
        totalDebtAtJudgement: record.totalDebtAtJudgement,
        gdpJudgementValue: record.gdpJudgementValue,
        bondsRedeemedPrincipal: record.bondsRedeemedPrincipal,
        bondsRedeemedInterest: record.bondsRedeemedInterest,
        bondRedemptionCount: record.bondRedemptionCount,
        bankAdvanceCreated: record.bankAdvanceCreated,
        bankLoansWrittenOff: record.bankLoansWrittenOff,
        advancesWrittenOff: record.advancesWrittenOff,
        interestWrittenOff: record.interestWrittenOff,
        electionTriggeredTick: record.electionTriggeredTick,
        caretakerUntilElection: record.caretakerUntilElection,
        electionWinner: election?.winnerName ?? null,
        shareNote,
        note: record.note,
      });
    }
  }

  const elections = world.politics.elections
    .filter((item) => item.tick > 0)
    .map((item) => ({
      tick: item.tick,
      cityId: item.cityId,
      cityName: cityNames.get(item.cityId) ?? item.cityId,
      winnerName: item.winnerName,
      playerWon: item.playerWon,
      note: item.note,
    }));

  const bondHoldersByCity: GovernmentProbe['bondHoldersByCity'] = [];
  if (bonds) {
    const aggregate = new Map<string, number>();
    for (const holding of bonds.holdings) {
      const issuance = bonds.issuances.find((item) => item.id === holding.issuanceId);
      if (!issuance) continue;
      const holderCity = holderCityId(world, holding.holder);
      const key = `${issuance.cityId}|${holderCity ?? holding.holder.kind}|${holding.holder.kind}`;
      aggregate.set(key, round2((aggregate.get(key) ?? 0) + holding.units));
    }
    const sorted = [...aggregate.entries()].sort(([a], [b]) => a.localeCompare(b));
    for (const [key, units] of sorted) {
      const [issuerCityId, holderCityIdOrKind, holderKind] = key.split('|');
      bondHoldersByCity.push({
        issuerCityName: cityNames.get(issuerCityId!) ?? issuerCityId!,
        holderCityName:
          holderKind === 'investorGroup' || holderKind === 'player' || holderKind === 'company'
            ? (cityNames.get(holderCityIdOrKind!) ?? holderCityIdOrKind!)
            : holderKind!,
        units,
      });
    }
  }

  const financingByCity = world.cities.map((city) => {
    const byKind: Record<string, number> = {};
    for (const kind of GOVERNMENT_FINANCING_KINDS) byKind[kind] = 0;
    for (const entry of world.fiscal.ledger) {
      if (entry.cityId !== city.id) continue;
      if (!(GOVERNMENT_FINANCING_KINDS as readonly string[]).includes(entry.kind)) continue;
      byKind[entry.kind] = round2((byKind[entry.kind] ?? 0) + entry.amount);
    }
    const totalIn = round2(
      Object.values(byKind).filter((value) => value > 0).reduce((sum, value) => sum + value, 0),
    );
    const totalOut = round2(
      -Object.values(byKind).filter((value) => value < 0).reduce((sum, value) => sum + value, 0),
    );
    const loanTicks = world.fiscal.ledger
      .filter((entry) => entry.cityId === city.id && entry.kind === 'governmentLoanProceeds')
      .map((entry) => entry.tick);
    const governmentLoanFirstTick = loanTicks.length > 0 ? Math.min(...loanTicks) : null;
    const cityRows = monthly.map((row) => row.cities.find((item) => item.cityId === city.id)).filter(Boolean);
    const income = round2(cityRows.reduce((sum, row) => sum + (row?.income ?? 0), 0));
    const expense = round2(cityRows.reduce((sum, row) => sum + (row?.expense ?? 0), 0));
    const lastRow = cityRows[cityRows.length - 1];
    return {
      cityId: city.id,
      cityName: city.name,
      byKind,
      totalIn,
      totalOut,
      governmentLoanFirstTick,
      cumulative: {
        income,
        expense,
        operatingIncome: round2(income - totalIn),
        operatingExpense: round2(expense - totalOut),
        netFinancing: round2(totalIn - totalOut),
        finalTreasury: round2(lastRow?.treasury ?? 0),
        finalDebt: round2(lastRow?.debt ?? 0),
      },
    };
  });

  const writeOffsByCity: GovernmentProbe['writeOffsByCity'] = world.cities
    .map((city) => {
      const records = bankruptcies.filter((item) => item.cityId === city.id);
      const bankLoans = round2(records.reduce((sum, item) => sum + item.bankLoansWrittenOff, 0));
      const advances = round2(records.reduce((sum, item) => sum + item.advancesWrittenOff, 0));
      const interest = round2(records.reduce((sum, item) => sum + item.interestWrittenOff, 0));
      return { cityId: city.id, cityName: city.name, bankLoans, advances, interest, total: round2(bankLoans + advances + interest) };
    })
    .filter((item) => item.total > 0.005);

  const liquidations = world.lifecycle.liquidations;
  const debtAtLiquidation = round2(liquidations.reduce((sum, item) => sum + item.debt, 0));
  const repaidAtLiquidation = round2(liquidations.reduce((sum, item) => sum + item.debtRepaid, 0));
  const forgivenAtLiquidation = round2(liquidations.reduce((sum, item) => sum + item.debtForgiven, 0));
  let outstandingAtEnd = 0;
  for (const loan of world.banking.loans) {
    if (loan.status === 'active' || loan.status === 'defaulted') {
      outstandingAtEnd = round2(outstandingAtEnd + loan.outstanding);
    }
  }

  const highDividendCompanies = world.companies
    .filter((company) => {
      const wage = monthlyWageBill(company);
      return (
        company.lastMonth.profit > 0 &&
        company.lastMonth.dividendsPaid >= company.lastMonth.profit * 0.9 &&
        company.cash < wage * 2
      );
    })
    .map((company) => ({
      name: company.name,
      cityName: cityNames.get(company.cityId) ?? company.cityId,
      cash: round2(company.cash),
      monthlyWage: round2(monthlyWageBill(company)),
      dividendsPaid: round2(company.lastMonth.dividendsPaid),
      profit: round2(company.lastMonth.profit),
    }));

  const gdpPoints = [1, 12, 24, months]
    .filter((tick, index, list) => tick <= months && list.indexOf(tick) === index)
    .map((tick) => ({
      tick,
      worldGdp: round2(monthly.find((row) => row.tick === tick)?.world.gdp ?? 0),
    }));

  return {
    bondIssuanceByCity,
    bondHoldersByCity,
    bankruptcies,
    writeOffsByCity,
    elections,
    financingByCity,
    lifecycle: {
      foundings: world.lifecycle.foundings.length,
      liquidations: liquidations.length,
      debtAtLiquidation,
      repaidAtLiquidation,
      forgivenAtLiquidation,
      recoveryRatio: debtAtLiquidation > 0 ? repaidAtLiquidation / debtAtLiquidation : null,
    },
    knownLimitations: {
      liquidationZeroRecovery: {
        count: liquidations.length,
        debt: debtAtLiquidation,
        repaid: repaidAtLiquidation,
        forgiven: forgivenAtLiquidation,
        shareOfOutstanding: outstandingAtEnd > 0 ? forgivenAtLiquidation / outstandingAtEnd : 0,
      },
      bankNegativeSpreadMonths: monthly.filter(
        (row) => row.world.bankInterestIncome < row.world.bankInterestExpense,
      ).length,
      highDividendCompanies,
    },
    gdpPoints,
  };
}

// ------------------------------------------------------------------ 参数解析

interface Options {
  months: number;
  jsonPath: string | null;
  csvPath: string | null;
  repeat: boolean;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    months: 36,
    jsonPath: null,
    csvPath: null,
    repeat: false,
  };
  for (const arg of argv) {
    if (arg === '--repeat') options.repeat = true;
    else if (arg === '--help' || arg === '-h') {
      console.log('用法：npx tsx scripts/economy-balance-report.ts [--months=36] [--json[=path]] [--csv[=path]] [--repeat]');
      process.exit(0);
    } else if (arg.startsWith('--months=')) {
      options.months = Math.max(1, Math.floor(Number(arg.slice('--months='.length))));
    } else if (arg === '--json') {
      options.jsonPath = 'docs/development/reports/economy-baseline.json';
    } else if (arg.startsWith('--json=')) {
      options.jsonPath = arg.slice('--json='.length);
    } else if (arg === '--csv') {
      options.csvPath = 'docs/development/reports/economy-baseline.csv';
    } else if (arg.startsWith('--csv=')) {
      options.csvPath = arg.slice('--csv='.length);
    } else {
      console.error(`未知参数：${arg}`);
      process.exit(2);
    }
  }
  return options;
}

// ------------------------------------------------------------------ 数据结构

const round2 = (value: number): number => Math.round(value * 100) / 100;
const fmt = (value: number | null | undefined): string =>
  value === null || value === undefined || !Number.isFinite(value) ? '—' : value.toFixed(0);

interface CityMonthRow {
  tick: number;
  year: number;
  month: number;
  cityId: string;
  cityName: string;
  treasury: number;
  income: number;
  expense: number;
  deficit: number;
  gdp: number;
  /** 12 个月 GDP 判定窗口（契约口径；含开局估计月，estimated=true）。 */
  gdpWindowSum: number;
  gdpWindowMonths: number;
  gdpWindowEstimatedMonths: number;
  /** 契约口径总负债（#11 五段只计一次）：银行贷款本金 + 垫付本金 + 债券本金 + 已计提未付利息。 */
  debt: number;
  debtBreakdown: {
    bankLoanPrincipal: number;
    advanceLoanPrincipal: number;
    bondPrincipalOutstanding: number;
    loanAccruedInterest: number;
    bondAccruedInterest: number;
  };
  /** 债务/GDP = 总负债 / max(minAnnualGdp, 12 月窗口合计)。 */
  debtRatio: number;
  riskLevel: string;
  riskTrend: string;
  companies: number;
  founded: number;
  liquidated: number;
  householdConsumption: number;
  householdDesiredConsumption: number;
  /** 新消费公式参考预算：Σ min(现金, max(0, 0.8×收入 + 0.05×现金))。 */
  budgetNewFormula: number;
  /** 现有代码的消费预算（propensity 0.96 旧口径），用于对照。 */
  budgetCurrentCode: number;
  householdCash: number;
  householdDeposits: number;
  loansOutstanding: number;
  defaultedLoans: number;
}

interface WorldMonthRow {
  tick: number;
  gdp: number;
  treasury: number;
  companies: number;
  founded: number;
  liquidated: number;
  householdConsumption: number;
  householdDesiredConsumption: number;
  depositsTotal: number;
  loansOutstanding: number;
  loanContracts: number;
  defaultedContracts: number;
  bankInterestIncome: number;
  bankInterestExpense: number;
  invariants: string[];
}

interface MonthRow {
  tick: number;
  year: number;
  month: number;
  cities: CityMonthRow[];
  world: WorldMonthRow;
}

interface CompanyRow {
  id: string;
  name: string;
  cityId: string;
  cityName: string;
  sector: string;
  cash: number;
  debt: number;
  monthlyWage: number;
  utilization: number;
  profit: number;
  /** 经营现金流（不含股息）：revenue − inputCost − wagesPaid − corporateTax − interestPaid。 */
  operatingCashFlow: number;
  /** 自由现金流 = 经营现金流 − 股息。 */
  freeCashFlow: number;
  revenue: number;
  inputCost: number;
  wagesPaid: number;
  wageArrears: number;
  corporateTax: number;
  interestPaid: number;
  dividendsPaid: number;
  inventoryValue: number;
}

interface ProfitCashRow {
  id: string;
  name: string;
  cityName: string;
  profit: number;
  operatingCashFlow: number;
  difference: number;
  differenceToProfit: number | null;
  reason: string;
}


/** 块6 探针：破产/重选/股份分配、AI 发债与融资拆解、既有异常对照（只读观察，不改实现）。 */
interface GovernmentProbe {
  bondIssuanceByCity: Array<{
    cityId: string;
    cityName: string;
    issues: number;
    firstTick: number | null;
    lastTick: number | null;
    plannedUnits: number;
    soldUnits: number;
    unsoldUnits: number;
  }>;
  bankruptcies: Array<{
    cityId: string;
    cityName: string;
    tick: number;
    debtRatio: number;
    totalDebtAtJudgement: number;
    gdpJudgementValue: number;
    bondsRedeemedPrincipal: number;
    bondsRedeemedInterest: number;
    bondRedemptionCount: number;
    bankAdvanceCreated: number;
    bankLoansWrittenOff: number;
    advancesWrittenOff: number;
    interestWrittenOff: number;
    electionTriggeredTick: number | null;
    caretakerUntilElection: boolean;
    electionWinner: string | null;
    shareNote: string;
    note: string;
  }>;
  elections: Array<{ tick: number; cityId: string; cityName: string; winnerName: string; playerWon: boolean; note: string }>;
  bondHoldersByCity: Array<{ issuerCityName: string; holderCityName: string; units: number }>;
  financingByCity: Array<{
    cityId: string;
    cityName: string;
    byKind: Record<string, number>;
    totalIn: number;
    totalOut: number;
    /** 首笔政府银行贷款月份（null=从未借政府贷款）。 */
    governmentLoanFirstTick: number | null;
    /** 36 月累计财政收支（含融资项）与剔除融资后的经营口径。 */
    cumulative: {
      income: number;
      expense: number;
      operatingIncome: number;
      operatingExpense: number;
      netFinancing: number;
      finalTreasury: number;
      finalDebt: number;
    };
  }>;
  /** 破产勾销分城汇总（#44：单列，不计入"已还本金"）。 */
  writeOffsByCity: Array<{ cityId: string; cityName: string; bankLoans: number; advances: number; interest: number; total: number }>;
  lifecycle: { foundings: number; liquidations: number; debtAtLiquidation: number; repaidAtLiquidation: number; forgivenAtLiquidation: number; recoveryRatio: number | null };
  knownLimitations: {
    liquidationZeroRecovery: { count: number; debt: number; repaid: number; forgiven: number; shareOfOutstanding: number };
    bankNegativeSpreadMonths: number;
    highDividendCompanies: Array<{ name: string; cityName: string; cash: number; monthlyWage: number; dividendsPaid: number; profit: number }>;
  };
  gdpPoints: Array<{ tick: number; worldGdp: number }>;
}

interface BankSummary {
  contracts: number;
  open: number;
  defaulted: number;
  outstanding: number;
  defaultedOutstanding: number;
  byPurpose: Record<string, { contracts: number; outstanding: number }>;
  depositsTotal: number;
  interestIncome: number;
  interestExpense: number;
  newDefaults: number;
  migratedDebtContracts: number;
  /** 政府债务契约口径合计（块0：无发行/借款记录时为 0 = "尚未发生"，不代表健康）。 */
  governmentDebtTotal: number;
  governmentDebtByCity: Array<{
    cityId: string;
    cityName: string;
    totalDebt: number;
    debtRatio: number;
    riskLevel: string;
    riskTrend: string;
  }>;
}

interface Report {
  meta: {
    generatedAt: string;
    seed: number;
    startYear: number;
    startMonth: number;
    months: number;
    configSignature: string;
    note: string;
  };
  params: Record<string, unknown>;
  initial: {
    cities: Array<{
      cityId: string;
      name: string;
      treasury: number;
      gdp: number;
      companies: number;
      population: number;
      /** 契约层开局估计（city.gdpEstimate.monthlyValue；block0 已实现）。 */
      gdpEstimateMonthly: number;
      gdpWindowEstimatedMonths: number;
    }>;
    companiesTotal: number;
    depositsTotal: number;
    loanContracts: number;
    note: string;
  };
  monthly: MonthRow[];
  snapshots: { m1: MonthRow | null; m12: MonthRow | null; m36: MonthRow | null };
  companiesTop: CompanyRow[];
  profitVsCash: ProfitCashRow[];
  banking: BankSummary;
  /** 块6 扩展点：null = 债券机制未落地（不是"无发行"）。 */
  bonds: BondObservation | null;
  /** 块6 探针：破产/重选/融资拆解/既有异常对照。 */
  probe: GovernmentProbe;
  fiscalTop: string[];
  anomalies: string[];
  limitations: string[];
}

// ------------------------------------------------------------------ 采集

function collectCityMonth(
  sim: Simulation,
  tick: number,
  city: City,
): CityMonthRow {
  const world = sim.state;
  const entries = world.fiscal.ledger.filter((entry) => entry.tick === tick && entry.cityId === city.id);
  const income = round2(entries.filter((entry) => entry.amount > 0).reduce((sum, entry) => sum + entry.amount, 0));
  const expense = round2(
    entries.filter((entry) => entry.amount < 0).reduce((sum, entry) => sum + Math.abs(entry.amount), 0),
  );
  const groups = householdGroupsOfCity(world, city.id);
  const householdConsumption = round2(groups.reduce((sum, group) => sum + group.lastMonth.consumption, 0));
  const householdDesiredConsumption = round2(
    groups.reduce((sum, group) => sum + group.lastMonth.desiredConsumption, 0),
  );
  const householdCash = round2(groups.reduce((sum, group) => sum + group.cash, 0));
  const householdDeposits = round2(
    groups.reduce((sum, group) => sum + (depositAccountFor(world, { kind: 'household', id: group.id })?.balance ?? 0), 0),
  );
  const budgetNewFormula = round2(
    groups.reduce(
      (sum, group) =>
        sum + Math.min(group.cash, Math.max(0, group.lastMonth.income * 0.8 + group.cash * 0.05)),
      0,
    ),
  );
  let loansOutstanding = 0;
  let defaultedLoans = 0;
  for (const loan of world.banking.loans) {
    if (loan.borrower.kind === 'company') {
      const company = world.companies.find((item) => item.id === loan.borrower.id);
      if (company?.cityId !== city.id) continue;
    } else if (loan.borrower.kind === 'household') {
      const group = groups.find((item) => item.id === loan.borrower.id);
      if (!group) continue;
    } else {
      continue; // 玩家与投资实体的贷款不计入城市。
    }
    if (loan.status === 'active') loansOutstanding += loan.outstanding;
    if (loan.status === 'defaulted') {
      loansOutstanding += loan.outstanding;
      defaultedLoans += 1;
    }
  }
  // v0.7 契约层公共口径（v1.4 #36）：报告、模拟、UI 共用，禁止各写一套。
  const debt = cityDebt(world, city.id);
  const gdpWindow = recent12MonthGdp(world, city.id, DEMO_CONFIG);
  const risk = assessCityFiscalRisk(world, city.id, DEMO_CONFIG);
  const companiesOfCity = world.companies.filter((company) => company.cityId === city.id);
  const founded = world.lifecycle.foundings.filter((item) => item.tick === tick && item.cityId === city.id).length;
  const liquidated = world.lifecycle.liquidations.filter((item) => item.tick === tick && item.cityId === city.id).length;
  return {
    tick,
    year: world.time.year,
    month: world.time.month,
    cityId: city.id,
    cityName: city.name,
    treasury: round2(city.treasury),
    income,
    expense,
    deficit: round2(income - expense),
    gdp: round2(city.gdp),
    gdpWindowSum: gdpWindow.sum,
    gdpWindowMonths: gdpWindow.months,
    gdpWindowEstimatedMonths: gdpWindow.estimatedMonths,
    debt: debt.totalDebt,
    debtBreakdown: {
      bankLoanPrincipal: debt.bankLoanPrincipal,
      advanceLoanPrincipal: debt.advanceLoanPrincipal,
      bondPrincipalOutstanding: debt.bondPrincipalOutstanding,
      loanAccruedInterest: debt.loanAccruedInterest,
      bondAccruedInterest: debt.bondAccruedInterest,
    },
    debtRatio: risk.debtRatio,
    riskLevel: risk.riskLevel,
    riskTrend: risk.riskTrend,
    companies: companiesOfCity.length,
    founded,
    liquidated,
    householdConsumption,
    householdDesiredConsumption,
    budgetNewFormula,
    budgetCurrentCode: round2(city.lastMonth.consumerBudget),
    householdCash,
    householdDeposits,
    loansOutstanding: round2(loansOutstanding),
    defaultedLoans,
  };
}

function collectWorldMonth(sim: Simulation, tick: number): WorldMonthRow {
  const world = sim.state;
  const openLoans = world.banking.loans.filter((loan) => loan.status !== 'repaid');
  const defaulted = world.banking.loans.filter((loan) => loan.status === 'defaulted');
  return {
    tick,
    gdp: round2(world.cities.reduce((sum, city) => sum + city.gdp, 0)),
    treasury: round2(world.cities.reduce((sum, city) => sum + city.treasury, 0)),
    companies: world.companies.length,
    founded: world.lifecycle.foundings.filter((item) => item.tick === tick).length,
    liquidated: world.lifecycle.liquidations.filter((item) => item.tick === tick).length,
    householdConsumption: round2(
      world.cities.reduce((sum, city) => sum + (sim.state.households.groups.filter((g) => g.cityId === city.id).reduce((s, g) => s + g.lastMonth.consumption, 0)), 0),
    ),
    householdDesiredConsumption: round2(
      world.cities.reduce((sum, city) => sum + (sim.state.households.groups.filter((g) => g.cityId === city.id).reduce((s, g) => s + g.lastMonth.desiredConsumption, 0)), 0),
    ),
    depositsTotal: round2(world.banking.deposits.reduce((sum, account) => sum + account.balance, 0)),
    loansOutstanding: round2(openLoans.reduce((sum, loan) => sum + loan.outstanding, 0)),
    loanContracts: world.banking.loans.length,
    defaultedContracts: defaulted.length,
    bankInterestIncome: round2(world.banking.lastMonth.interestIncome),
    bankInterestExpense: round2(world.banking.lastMonth.interestExpense),
    invariants: [...world.lastTick.invariants],
  };
}

function inventoryValue(company: Company, city: City): number {
  let total = 0;
  for (const [goodId, qty] of Object.entries(company.inventory)) {
    const price = city.market[goodId as keyof typeof city.market]?.price ?? 0;
    total += qty * price;
  }
  return round2(total);
}

function collectCompanyRow(company: Company, city: City): CompanyRow {
  const last = company.lastMonth;
  // 经营口径不含股息与融资：股息是分配决策，不应算作经营流出。
  const operatingCashFlow = round2(
    last.revenue - last.inputCost - last.wagesPaid - last.corporateTax - last.interestPaid,
  );
  return {
    id: company.id,
    name: company.name,
    cityId: company.cityId,
    cityName: city.name,
    sector: company.sector,
    cash: round2(company.cash),
    debt: round2(company.debt),
    monthlyWage: round2(monthlyWageBill(company)),
    utilization: company.utilization,
    profit: round2(last.profit),
    operatingCashFlow,
    freeCashFlow: round2(operatingCashFlow - last.dividendsPaid),
    revenue: round2(last.revenue),
    inputCost: round2(last.inputCost),
    wagesPaid: round2(last.wagesPaid),
    wageArrears: round2(last.wageArrears),
    corporateTax: round2(last.corporateTax),
    interestPaid: round2(last.interestPaid),
    dividendsPaid: round2(last.dividendsPaid),
    inventoryValue: inventoryValue(company, city),
  };
}

// ------------------------------------------------------------------ 主流程

function run(months: number): { report: Report; elapsedMs: number } {
  const start = Date.now();
  const sim = Simulation.create(DEMO_CONFIG);
  const world = sim.state;
  const initialCities = world.cities.map((city) => ({
    cityId: city.id,
    name: city.name,
    treasury: round2(city.treasury),
    gdp: round2(city.gdp),
    companies: world.companies.filter((company) => company.cityId === city.id).length,
    population: city.population.total,
    gdpEstimateMonthly: round2(city.gdpEstimate?.monthlyValue ?? 0),
    gdpWindowEstimatedMonths: (city.gdpWindow ?? []).filter((point) => point.estimated).length,
  }));
  const initial = {
    cities: initialCities,
    companiesTotal: world.companies.length,
    depositsTotal: round2(world.banking.deposits.reduce((sum, account) => sum + account.balance, 0)),
    loanContracts: world.banking.loans.length,
    note:
      '开局状态（未 tick）：treasury 与存款为初始值，gdp 为 0（首月结算前）；' +
      'gdpEstimateMonthly 为契约层开局 12 个月估计（块0 已实现，estimated=true），不是真实交易。',
  };

  const monthly: MonthRow[] = [];
  for (let index = 0; index < months; index += 1) {
    const result = sim.tick();
    if (!result.ok) {
      console.error(`第 ${index + 1} 月结算失败：${result.error}`);
      process.exit(1);
    }
    const tick = world.time.tick;
    const cities = [...world.cities]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((city) => collectCityMonth(sim, tick, city));
    monthly.push({ tick, year: world.time.year, month: world.time.month, cities, world: collectWorldMonth(sim, tick) });
  }

  const finalTick = world.time.tick;
  const lastCityRows = monthly[monthly.length - 1]?.cities ?? [];
  const companies = [...world.companies]
    .map((company) => collectCompanyRow(company, world.cities.find((city) => city.id === company.cityId)!))
    .sort((a, b) => a.cash / Math.max(1, a.monthlyWage) - b.cash / Math.max(1, b.monthlyWage));
  const profitVsCash: ProfitCashRow[] = companies
    .filter((row) => row.profit > 0 && (row.operatingCashFlow < 0 || row.operatingCashFlow < row.profit * 0.5))
    .map((row) => ({
      id: row.id,
      name: row.name,
      cityName: row.cityName,
      profit: row.profit,
      operatingCashFlow: row.operatingCashFlow,
      difference: round2(row.profit - row.operatingCashFlow),
      differenceToProfit: row.profit !== 0 ? (row.profit - row.operatingCashFlow) / row.profit : null,
      reason:
        row.operatingCashFlow < 0
          ? '利润为正但经营现金流为负（收入未回款/存货与应收占用/欠薪等应计项）'
          : '利润与经营现金流差额超过利润 50%（应计项，如欠薪、存货变动）',
    }));

  const openLoans = world.banking.loans.filter((loan) => loan.status !== 'repaid');
  const defaulted = world.banking.loans.filter((loan) => loan.status === 'defaulted');
  const byPurpose: Record<string, { contracts: number; outstanding: number }> = {};
  for (const loan of openLoans) {
    const bucket = (byPurpose[loan.purpose] ??= { contracts: 0, outstanding: 0 });
    bucket.contracts += 1;
    bucket.outstanding = round2(bucket.outstanding + loan.outstanding);
  }
  const banking: BankSummary = {
    contracts: world.banking.loans.length,
    open: openLoans.length,
    defaulted: defaulted.length,
    outstanding: round2(openLoans.reduce((sum, loan) => sum + loan.outstanding, 0)),
    defaultedOutstanding: round2(defaulted.reduce((sum, loan) => sum + loan.outstanding, 0)),
    byPurpose,
    depositsTotal: round2(world.banking.deposits.reduce((sum, account) => sum + account.balance, 0)),
    interestIncome: round2(world.banking.lastMonth.interestIncome),
    interestExpense: round2(world.banking.lastMonth.interestExpense),
    newDefaults: world.banking.lastMonth.newDefaults,
    migratedDebtContracts: world.banking.loans.filter((loan) => loan.purpose === 'migratedDebt').length,
    governmentDebtTotal: round2(
      world.cities.reduce((sum, city) => sum + cityDebt(world, city.id).totalDebt, 0),
    ),
    governmentDebtByCity: world.cities.map((city) => {
      const debt = cityDebt(world, city.id);
      const risk = assessCityFiscalRisk(world, city.id, DEMO_CONFIG);
      return {
        cityId: city.id,
        cityName: city.name,
        totalDebt: debt.totalDebt,
        debtRatio: risk.debtRatio,
        riskLevel: risk.riskLevel,
        riskTrend: risk.riskTrend,
      };
    }),
  };

  const snapshot = (tick: number): MonthRow | null => monthly.find((row) => row.tick === tick) ?? null;
  const probe = collectGovernmentProbe(world, monthly, months);
  const report: Report = {
    meta: {
      generatedAt: new Date().toISOString(),
      seed: world.seed,
      startYear: 2026,
      startMonth: 1,
      months,
      configSignature: `DEMO_CONFIG seed=${DEMO_CONFIG.simulation.seed} tick0=${DEMO_CONFIG.simulation.startYear}-${DEMO_CONFIG.simulation.startMonth}`,
      note:
        '固定条件探针：玩家无操作、默认 AI；config 为 v0.7 冻结键名 + 数值岗首版暂定值。' +
        '块1 债券/政府贷款/垫付、块2 破产清算/月结六阶段/12 月真实 GDP 窗口、块3/4 居民消费预算与群体消费贷、债券兑付入账修复均已合入（交付分支 316eff4）。' +
        '债务指标由契约函数 cityDebt/assessCityFiscalRisk/recent12MonthGdp 计算；probe 段为块6 观察（破产/重选/融资拆解/既有异常对照）。',
    },
    params: {
      simulation: {
        seed: DEMO_CONFIG.simulation.seed,
        startYear: DEMO_CONFIG.simulation.startYear,
        startMonth: DEMO_CONFIG.simulation.startMonth,
      },
      market: { initialPriceFactor: DEMO_CONFIG.market.initialPriceFactor },
      company: {
        initialUtilization: DEMO_CONFIG.company.initialUtilization,
        wageReserveMonths: DEMO_CONFIG.company.wageReserveMonths,
        initialCashWageMonths: DEMO_CONFIG.company.initialCashWageMonths,
      },
      production: { laborCapacityFactor: DEMO_CONFIG.production.laborCapacityFactor },
      banking: {
        depositRateMonthly: DEMO_CONFIG.banking.depositRateMonthly,
        creditLimitRate: DEMO_CONFIG.banking.creditLimitRate,
        graceMonths: DEMO_CONFIG.banking.graceMonths,
        earlyRepaymentFee: DEMO_CONFIG.banking.earlyRepaymentFee,
      },
      households: {
        consumptionPropensity: DEMO_CONFIG.households.consumptionPropensity,
        initialDepositShare: DEMO_CONFIG.households.initialDepositShare,
      },
      consumer: { propensity: DEMO_CONFIG.consumer.propensity },
      government: {
        bondMarket: { ...DEMO_CONFIG.government.bondMarket },
        companyPurchaseReserve: { ...DEMO_CONFIG.government.companyPurchaseReserve },
        loan: { ...DEMO_CONFIG.government.loan },
        advance: { ...DEMO_CONFIG.government.advance },
        fiscalRisk: { ...DEMO_CONFIG.government.fiscalRisk },
        gdpEstimate: {
          utilizationAssumption: DEMO_CONFIG.government.gdpEstimate.utilizationAssumption,
          windowMonths: DEMO_CONFIG.government.gdpEstimate.windowMonths,
        },
        aiGovernment: { ...DEMO_CONFIG.government.aiGovernment },
        householdCredit: { ...DEMO_CONFIG.households.householdCredit },
        consumerBudget: { ...DEMO_CONFIG.households.consumerBudget },
      },
    },
    initial,
    monthly,
    snapshots: { m1: snapshot(1), m12: snapshot(12), m36: snapshot(months) },
    companiesTop: companies,
    profitVsCash,
    banking,
    bonds: collectBonds(world),
    probe,
  };

  // ---------------- 异常判据（设计稿 §E；未实现机制的判据标注跳过） ----------------
  const anomalies: string[] = [];
  const cityIds = world.cities.map((city) => city.id);
  for (const cityId of cityIds) {
    const rows = monthly.map((row) => row.cities.find((city) => city.cityId === cityId)!).filter(Boolean);
    const name = rows[0]?.cityName ?? cityId;
    // 1. 财政连续 3 个月下降且降幅均 >10%。
    for (let i = 2; i < rows.length; i += 1) {
      const a = rows[i - 2]!, b = rows[i - 1]!, c = rows[i]!;
      if (b.treasury < a.treasury * 0.9 && c.treasury < b.treasury * 0.9 && c.treasury < a.treasury) {
        anomalies.push(`${name}：财政连续 3 个月下降超过 10%（第 ${rows[i - 2]!.tick}–${rows[i]!.tick} 月，${fmt(a.treasury)}→${fmt(c.treasury)}）。`);
        break;
      }
    }
    // 2. 单城月赤字 / 月财政支出 > 40%。
    const deficitRows = rows.filter((row) => row.expense > 0 && row.deficit / row.expense > 0.4);
    if (deficitRows.length > 0) {
      const first = deficitRows[0]!;
      anomalies.push(
        `${name}：${deficitRows.length} 个月赤字/支出 > 40%（首次第 ${first.tick} 月：赤字 ${fmt(first.deficit)} / 支出 ${fmt(first.expense)}）。`,
      );
    }
    // 3. GDP 较 36 月内峰值下跌 > 50%。
    const peak = Math.max(...rows.map((row) => row.gdp));
    const last = rows[rows.length - 1]!;
    if (peak > 0 && last.gdp < peak * 0.5) {
      anomalies.push(`${name}：GDP 较 36 月内峰值下跌超过 50%（峰值 ${fmt(peak)} → 第 ${last.tick} 月 ${fmt(last.gdp)}）。`);
    }
    // 4. 单城单月倒闭 ≥ 3 家。
    for (const row of rows) {
      if (row.liquidated >= 3) anomalies.push(`${name}：第 ${row.tick} 月单月倒闭 ${row.liquidated} 家（≥3，异常）。`);
    }
  }

  const lastMonth = monthly[monthly.length - 1]!;
  // 5. 倒闭 > 成立（累计）。
  if (lastMonth.world.liquidated > lastMonth.world.founded && lastMonth.world.liquidated > 0) {
    anomalies.push(
      `世界：第 ${lastMonth.tick} 月累计倒闭 ${lastMonth.world.liquidated} 家 > 成立 ${lastMonth.world.founded} 家。`,
    );
  }
  // 6. 倒闭企业现金 > 0 或债务减免占比 > 50%。
  const badLiquidations = world.lifecycle.liquidations.filter(
    (item) => item.cash > 0 || (item.debt > 0 && item.debtForgiven / item.debt > 0.5),
  );
  if (badLiquidations.length > 0) {
    const item = badLiquidations[0]!;
    const forgivenTotal = badLiquidations.reduce((sum, entry) => sum + entry.debtForgiven, 0);
    anomalies.push(
      `${badLiquidations.length} 家倒闭企业清算中银行实收 0、债务全额减免（合计 ${fmt(forgivenTotal)}；如 ${item.companyName}：债务 ${fmt(item.debt)}、减免 ${fmt(item.debtForgiven)}）。` +
        `属既有清算规则，但占期末全部未偿 ${((forgivenTotal / Math.max(1, banking.outstanding)) * 100).toFixed(1)}%，需确认是否符合预期。`,
    );
  }
  // 7. 违约未偿 > 全部未偿 20%。
  if (banking.outstanding > 0 && banking.defaultedOutstanding / banking.outstanding > 0.2) {
    anomalies.push(
      `银行：违约合同未偿 ${fmt(banking.defaultedOutstanding)} 占全部未偿 ${fmt(banking.outstanding)} 的 ${(
        (banking.defaultedOutstanding / banking.outstanding) * 100
      ).toFixed(1)}%（>20%）。`,
    );
  }
  // 8. 违约合同占未结清合同 > 30%。
  if (banking.open > 0 && banking.defaulted / banking.open > 0.3) {
    anomalies.push(`银行：违约合同 ${banking.defaulted} / 未结清 ${banking.open}（>30%）。`);
  }
  // 9. 不变量违规。
  for (const row of monthly) {
    if (row.world.invariants.length > 0) {
      anomalies.push(`第 ${row.tick} 月不变量违规：${row.world.invariants.join('；')}`);
    }
  }
  // 10. 利润与经营现金流背离（企业层面）。
  if (profitVsCash.length > 0) {
    const sample = profitVsCash.slice(0, 3).map((row) => `${row.name}（利润 ${fmt(row.profit)} / 现金流 ${fmt(row.operatingCashFlow)}）`);
    anomalies.push(`${profitVsCash.length} 家企业利润为正但经营现金流 < 利润 50%：${sample.join('；')} 等。`);
  }
  // 11. 居民实际消费明显低于新公式预算（按城市汇总，避免逐月刷屏）。
  for (const cityId of cityIds) {
    const rows = monthly.map((row) => row.cities.find((city) => city.cityId === cityId)!).filter(Boolean);
    const name = rows[0]?.cityName ?? cityId;
    const gaps = rows.filter(
      (row) => row.budgetNewFormula > 0 && row.householdConsumption / row.budgetNewFormula < 0.5,
    );
    if (gaps.length > 0) {
      const worst = gaps.reduce((min, row) =>
        row.householdConsumption / row.budgetNewFormula < min.householdConsumption / min.budgetNewFormula ? row : min,
      );
      anomalies.push(
        `${name}：${gaps.length}/${rows.length} 个月居民实际消费 / 新公式预算 < 50%（最差第 ${worst.tick} 月：` +
          `${fmt(worst.householdConsumption)} / ${fmt(worst.budgetNewFormula)}，供给或资金缺口）。`,
      );
    }
  }
  // 12. 财政余额为负：现有代码无政府发债/欠付机制，负余额等于隐性负债（债务/GDP 口径待 #11 落地）。
  for (const city of lastMonth.cities) {
    if (city.treasury < 0) {
      anomalies.push(
        `${city.cityName}：第 ${lastMonth.tick} 月财政余额 ${fmt(city.treasury)}（负余额=隐性负债，现有代码无政府发债机制）。`,
      );
    }
  }
  const negativeTreasuryMonths = monthly.filter((row) => row.world.treasury < 0).length;
  if (negativeTreasuryMonths > 0) {
    anomalies.push(
      `世界：${negativeTreasuryMonths}/${monthly.length} 个月三城财政合计为负（第 ${lastMonth.tick} 月合计 ${fmt(lastMonth.world.treasury)}）。`,
    );
  }
  // 13. 银行利差持续为负（存款利息刚性、贷款利息不足）。
  const negativeSpreadMonths = monthly.filter(
    (row) => row.world.bankInterestIncome < row.world.bankInterestExpense,
  ).length;
  if (negativeSpreadMonths >= 3) {
    anomalies.push(
      `银行：${negativeSpreadMonths}/${monthly.length} 个月利息收入 < 利息支出（本月 ${fmt(lastMonth.world.bankInterestIncome)} vs ${fmt(lastMonth.world.bankInterestExpense)}），利差持续为负。`,
    );
  }
  // 14. 高分红低现金：利润基本分光且现金不足 2 个月工资。
  const highDividend = companies.filter(
    (company) => company.profit > 0 && company.dividendsPaid >= company.profit * 0.9 && company.cash < company.monthlyWage * 2,
  );
  if (highDividend.length > 0) {
    anomalies.push(
      `${highDividend.length} 家企业利润基本全部分红且现金 < 2 个月工资（流动性风险）：` +
        highDividend
          .slice(0, 3)
          .map((company) => `${company.name}（现金 ${fmt(company.cash)}，月工资 ${fmt(company.monthlyWage)}）`)
          .join('；') +
        `${highDividend.length > 3 ? ' 等' : ''}。`,
    );
  }
  // 15. 债券：单期未售出超过 50%（发不出去）。
  for (const issue of report.bonds?.issues ?? []) {
    if (issue.coverageRatio !== null && issue.coverageRatio < 0.5) {
      anomalies.push(
        `${issue.cityName} ${issue.issueId}（${issue.tick} 月）：发行覆盖率 ${(issue.coverageRatio * 100).toFixed(1)}%，` +
          `未售 ${issue.unsoldUnits}/${issue.plannedUnits} 份 —— 债券发不出去（需求侧或认购约束，见 block6 D5）。`,
      );
    }
  }
  // 16. 债券：计划份数超过 config 上限（契约/校验漏掉的证据）。
  const planUnitsCap = DEMO_CONFIG.government.bondMarket.maxPlanUnitsPerIssue;
  for (const issue of report.bonds?.issues ?? []) {
    if (issue.plannedUnits > planUnitsCap) {
      anomalies.push(`${issue.cityName} ${issue.issueId}：计划 ${issue.plannedUnits} 份超过 maxPlanUnitsPerIssue=${planUnitsCap}。`);
    }
  }
  // 17. 破产处置：判定当月重选未触发（进入看守期）。
  for (const item of probe.bankruptcies) {
    if (item.caretakerUntilElection) {
      anomalies.push(
        `${item.cityName}：第 ${item.tick} 月破产判定后同 tick 重选未触发，进入看守期（债务/GDP ${(item.debtRatio * 100).toFixed(1)}%）。`,
      );
    }
  }
  // 18. 债券重复兑付（同 issuanceId+holdingId+tick+kind 出现两次 = 幂等失效）。
  const paymentKeys = new Set<string>();
  let duplicatePayments = 0;
  for (const payment of world.bonds?.payments ?? []) {
    const holdingKey = payment.holdingId ?? `${payment.holder.kind}:${payment.holder.id}`;
    const key = `${payment.issuanceId}|${holdingKey}|${payment.tick}|${payment.kind}`;
    if (paymentKeys.has(key)) duplicatePayments += 1;
    else paymentKeys.add(key);
  }
  if (duplicatePayments > 0) {
    anomalies.push(`债券：发现 ${duplicatePayments} 笔重复兑付（同批次/持有人/月份/类型出现多次），幂等键可能失效。`);
  }
  // 19. 期末仍有债券欠付利息（#19：12/24 月资金不足应记欠付，不应长期悬空）。
  const bondArrearsEnd = round2(
    (world.bonds?.issuances ?? []).reduce((sum, issuance) => sum + Math.max(0, issuance.arrearsInterest), 0),
  );
  if (bondArrearsEnd > 0.005) {
    anomalies.push(`债券：期末仍有欠付利息 ${fmt(bondArrearsEnd)}（未通过票息或到期/破产兑付结清）。`);
  }
  // 20. 破产后债务重新累积到预警档（watch 及以上）。
  for (const item of probe.bankruptcies) {
    const lastRow = report.monthly[report.monthly.length - 1]?.cities.find((city) => city.cityId === item.cityId);
    if (lastRow && lastRow.riskLevel !== 'normal') {
      anomalies.push(
        `${item.cityName}：第 ${item.tick} 月破产后债务重新累积，第 ${lastRow.tick} 月负债率 ${(lastRow.debtRatio * 100).toFixed(1)}%（${lastRow.riskLevel}）。`,
      );
    }
  }
  report.anomalies = anomalies;
  const lastMonthRow = report.monthly[report.monthly.length - 1];
  const debtText = report.banking.governmentDebtByCity
    .map(
      (item) =>
        `${item.cityName} ${(item.totalDebt / 1e6).toFixed(2)}M（${(item.debtRatio * 100).toFixed(1)}%，${item.riskLevel}）`,
    )
    .join(' / ');
  const bankruptcyText =
    probe.bankruptcies.length === 0
      ? '无破产'
      : probe.bankruptcies
          .map((item) => `${item.cityName}第 ${item.tick} 月（判定 ${(item.debtRatio * 100).toFixed(1)}%）`)
          .join('、');
  const advanceTotal = round2(probe.bankruptcies.reduce((sum, item) => sum + item.bankAdvanceCreated, 0));
  const writeOffTotal = round2(probe.writeOffsByCity.reduce((sum, item) => sum + item.total, 0));
  const bondIssueRows = report.bonds?.issues ?? [];
  const bondPrincipalPaid = round2(bondIssueRows.reduce((sum, item) => sum + item.principalRepaid, 0));
  const bondArrearsTotal = round2(bondIssueRows.reduce((sum, item) => sum + (item.couponArrears ?? 0), 0));
  const financingText =
    probe.financingByCity
      .filter((item) => item.totalIn > 0.005 || item.totalOut > 0.005)
      .map(
        (item) =>
          `${item.cityName} 融资净额 ${fmt(item.cumulative.netFinancing)}（发债 ${fmt(item.byKind.bondIssuanceProceeds ?? 0)} / 政府贷款 ${fmt(item.byKind.governmentLoanProceeds ?? 0)} / 票息流出 ${fmt(item.byKind.bondInterest ?? 0)}）`,
      )
      .join('；') || '三城均无融资项';
  const windowText =
    lastMonthRow?.cities
      .map(
        (city) =>
          `${city.cityName} 真实 ${city.gdpWindowMonths - city.gdpWindowEstimatedMonths} 个月、估计 ${city.gdpWindowEstimatedMonths} 个月`,
      )
      .join('；') ?? '—';
  const issueStopText = probe.bondIssuanceByCity
    .filter((item) => item.issues > 0)
    .map((item) => {
      const firstLoan = probe.financingByCity.find((city) => city.cityId === item.cityId)?.governmentLoanFirstTick;
      return `${item.cityName} 最后一次发债 M${item.lastTick}、首笔政府贷款 ${firstLoan === null || firstLoan === undefined ? '无' : `M${firstLoan}`}`;
    })
    .join('；');
  report.limitations = [
    '单一固定条件（种子 20261101、36 月、玩家无操作），不是多种子统计；结论不能外推为概率。',
    '版本：块1 债券（发行/认购/票息/到期/破产兑付/垫付）+ 块2 破产清算/月结六阶段/12 月真实 GDP 窗口 + 块3/4 居民消费预算（#39 80%/5%）与群体消费贷、债券兑付入账修复（316eff4）均已合入。',
    '破产清算为一次性事件：勾销后债务重新累计，本报告只记录 36 月内发生的破产次数与当次明细，不评价恢复过程是否合理。#8 幂等由重复兑付判据（18）覆盖。',
    `财政 M36 未转负是"破产勾销 + 银行垫付 + 赤字转政府贷款"的结果，不是财政改善：${financingText}；剔除融资后的经营缺口仍很大（见 [块6] 累计拆解）。旧基线 −422.8M 是"没有融资渠道的欠账"。`,
    `破产事件：${bankruptcyText}；银行垫付合计 ${fmt(advanceTotal)} 兑付债券本息后全部核销。银行无资本充足/亏损口径，垫付成本不落在任何主体资产负债表上、也不进财政流水——破产成本目前是"隐性"的。`,
    `【正式已知限制，v0.7 不改】政府贷款月供出现后 AI 发债永久停摆：赤字转成的政府贷款每月等额本金到期，使 AI "禁借新还旧"判定（hasDebtServiceDueThisTick）恒真，债券被银行贷款替代；实测 ${issueStopText}——铁谷未破产也未再发债，说明停摆不限于破产后。M36 负债率 ${debtText}。详见 B 稿 B11 / 块6 D11e-D11f。`,
    `债务/GDP、预警档位与趋势由契约层 assessCityFiscalRisk 计算。本探针债券发行 ${bondIssueRows.length} 期、破产 ${probe.bankruptcies.length} 次；M36 总负债 ${debtText}。总负债 0 表示无未偿债务，不代表长期财政健康。`,
    `按 DECISIONS #44：政府贷款/银行垫付核销时账面 paidPrincipal=principal 仅是记账口径。本报告所有"已还/还本"列均为实际现金支付——债券还本 ${fmt(bondPrincipalPaid)} 是银行垫付实际付给持有人的现金；勾销合计 ${fmt(writeOffTotal)} 单列（${probe.writeOffsByCity.map((item) => `${item.cityName} ${fmt(item.total)}`).join(' / ') || '无'}），不计入已还本金或还款能力。期末债券欠付利息 ${fmt(bondArrearsTotal)}（#19：12/24 月票息不足不垫付、记欠付）。`,
    `12 个月 GDP 判定窗口：块2 已真实替换——开局 12 条估计（estimated=true）随结算逐月换出；M36 ${windowText}。负债率为真实口径，与旧基线（估计窗口 2.5B 级）不可直接比。`,
    '居民消费预算：新公式已生效（#39：预算=min(扣款后现金, 0.8×上月可支配收入+0.05×扣款后现金)）。报告 budgetNewFormula 列为对照估算（收入×0.8+现金×0.05、未扣还款/存款），budgetCurrentCode 为实际城市预算，差异反映还款与资产口径。',
    '居民消费贷明细（#40 四字段：预算/新贷/贷款融资消费/资金缺口）块3 已写入契约，但本报告尚未逐城列示；本轮以城市贷款未偿/违约笔数（含企业贷）作粗代理，逐群体现金流与消费贷存量待下一步接入报告。',
    '经营现金流为月结字段近似（收入 − 投入 − 实发工资 − 税 − 利息，不含股息/融资），非严格现金流量表；利润与它差额对应应计项（欠薪、存货变动等）。',
    'GDP 为增加值口径（产出 − 中间投入），未含 12 月估计历史；首月结算前无历史。',
    '不变量仅覆盖系统自检（库存/现金/股份等），不含货币守恒（由 316eff4 的兑付入账测试覆盖），也不覆盖经济合理性。',
    '企业名单与异常 Top 为期末快照，未覆盖中途已消失企业的全生命周期。',
  ];

  return { report, elapsedMs: Date.now() - start };
}

// ------------------------------------------------------------------ 输出

function printReport(report: Report, elapsedMs: number): void {
  const line = '─'.repeat(96);
  console.log(`\n${line}`);
  console.log(`经济平衡观察（固定条件，${report.meta.months} 个月，种子 ${report.meta.seed}，耗时 ${elapsedMs} ms）`);
  console.log(line);

  console.log('\n[参数]');
  console.log(`  simulation: seed=${report.meta.seed}, 开局 ${report.meta.startYear}-${String(report.meta.startMonth).padStart(2, '0')}`);
  console.log(`  market.initialPriceFactor=${DEMO_CONFIG.market.initialPriceFactor}，company.initialUtilization=${DEMO_CONFIG.company.initialUtilization}`);
  console.log(`  company.wageReserveMonths=${DEMO_CONFIG.company.wageReserveMonths}，initialCashWageMonths=${DEMO_CONFIG.company.initialCashWageMonths}`);
  console.log(`  production.laborCapacityFactor=${DEMO_CONFIG.production.laborCapacityFactor}，households.consumptionPropensity=${DEMO_CONFIG.households.consumptionPropensity}`);
  const gov = DEMO_CONFIG.government;
  console.log(
    `  government.bondMarket: 面额 ${gov.bondMarket.faceValue} / 年利率 ${gov.bondMarket.couponRateAnnual} / 期限 ${gov.bondMarket.termMonths} 月 / 每 ${gov.bondMarket.interestPeriodMonths} 月付息 / 单期上限 ${gov.bondMarket.maxPlanUnitsPerIssue} 份`,
  );
  console.log(
    `  government.companyPurchaseReserve: 工资 ${gov.companyPurchaseReserve.wageMonths} 月 / 利息 ${gov.companyPurchaseReserve.interestMonths} 月；` +
      `fiscalRisk 分档 ${gov.fiscalRisk.normalBelow}/${gov.fiscalRisk.watchBelow}/${gov.fiscalRisk.bankruptAt}`,
  );
  console.log(
    `  gdpEstimate: 利用率 ${gov.gdpEstimate.utilizationAssumption} / 窗口 ${gov.gdpEstimate.windowMonths} 月 / 最小年 GDP ${gov.fiscalRisk.minAnnualGdp}；` +
      `aiGovernment: ${gov.aiGovernment.enabled ? '开' : '关'}（触发 ${gov.aiGovernment.triggerBelowExpenseMonths}×月支出 / 补足 ${gov.aiGovernment.topUpToExpenseMonths}× / 每城每月 ${gov.aiGovernment.maxIssuesPerCityMonth} 期 / 债务率上限 ${gov.aiGovernment.maxDebtRatioToIssue}）`,
  );
  console.log(
    `  households.consumerBudget: 收入 ${DEMO_CONFIG.households.consumerBudget.lastIncomeShare} + 现金 ${DEMO_CONFIG.households.consumerBudget.cashShare}；` +
      `householdCredit: ${DEMO_CONFIG.households.householdCredit.rateMonthly}/月 × ${DEMO_CONFIG.households.householdCredit.termMonths} 月 / 额度 ${DEMO_CONFIG.households.householdCredit.creditLimitRate}`,
  );

  console.log('\n[初始]');
  for (const city of report.initial.cities) {
    console.log(
      `  ${city.name}: 财政 ${fmt(city.treasury)}，企业 ${city.companies} 家，人口 ${city.population}，GDP ${fmt(city.gdp)}；` +
        `开局估计 ${fmt(city.gdpEstimateMonthly)}/月（窗口估计 ${city.gdpWindowEstimatedMonths} 月）`,
    );
  }
  console.log(`  世界：企业 ${report.initial.companiesTotal} 家，存款 ${fmt(report.initial.depositsTotal)}，贷款合同 ${report.initial.loanContracts} 笔`);

  const cityTable = (rows: MonthRow[], title: string): void => {
    console.log(`\n${title}`);
    for (const row of rows) {
      for (const city of row.cities) {
        console.log(
          `  M${String(row.tick).padStart(2)} ${city.cityName}：财政 ${fmt(city.treasury)}（收 ${fmt(city.income)} / 支 ${fmt(city.expense)} / 赤字 ${fmt(city.deficit)}）` +
            ` GDP ${fmt(city.gdp)}（判定窗口 ${fmt(city.gdpWindowSum)}，估计 ${city.gdpWindowEstimatedMonths}/${city.gdpWindowMonths} 月）` +
            `；总负债 ${fmt(city.debt)}（负债/GDP ${(city.debtRatio * 100).toFixed(1)}%，${city.riskLevel}/${city.riskTrend}）` +
            `；企业 ${city.companies}（成立 ${city.founded} / 倒闭 ${city.liquidated}）` +
            `；消费 ${fmt(city.householdConsumption)} / 期望 ${fmt(city.householdDesiredConsumption)}；存款 ${fmt(city.householdDeposits)}；贷款未偿 ${fmt(city.loansOutstanding)}（违约 ${city.defaultedLoans} 笔）`,
        );
      }
    }
  };
  cityTable(
    [report.snapshots.m1, report.snapshots.m12, report.snapshots.m36].filter((row): row is MonthRow => Boolean(row)),
    '[A] 三城断面（M1 / M12 / M36）',
  );

  console.log('\n[B] 世界逐月');
  console.log('  月  GDP        财政        企业  成立/倒闭  消费        期望        存款        贷款未偿    违约合同  不变量');
  for (const row of report.monthly) {
    const world = row.world;
    console.log(
      `  ${String(row.tick).padStart(2)}  ${fmt(world.gdp).padStart(10)} ${fmt(world.treasury).padStart(11)} ` +
        `${String(world.companies).padStart(4)}  ${String(world.founded).padStart(2)}/${String(world.liquidated).padStart(2)}   ` +
        `${fmt(world.householdConsumption).padStart(10)} ${fmt(world.householdDesiredConsumption).padStart(10)} ` +
        `${fmt(world.depositsTotal).padStart(10)} ${fmt(world.loansOutstanding).padStart(10)} ` +
        `${String(world.defaultedContracts).padStart(4)}     ${world.invariants.length === 0 ? '通过' : '违规'}`,
    );
  }

  console.log('\n[C] 企业异常（按现金/月工资升序，前 15 家）');
  for (const company of report.companiesTop.slice(0, 15)) {
    const monthsOfCash = company.cash / Math.max(1, company.monthlyWage);
    console.log(
      `  ${company.cityName} ${company.name}: 现金 ${fmt(company.cash)}（≈${monthsOfCash.toFixed(2)} 月工资），` +
        `债务 ${fmt(company.debt)}，利用率 ${(company.utilization * 100).toFixed(0)}%，` +
        `利润 ${fmt(company.profit)}，经营现金流 ${fmt(company.operatingCashFlow)}，自由现金流 ${fmt(company.freeCashFlow)}，欠薪 ${fmt(company.wageArrears)}`,
    );
  }

  console.log('\n[D] 银行与债务');
  console.log(
    `  存款 ${fmt(report.banking.depositsTotal)}；合同 ${report.banking.contracts} 笔（未结清 ${report.banking.open}，违约 ${report.banking.defaulted}），` +
      `未偿 ${fmt(report.banking.outstanding)}（违约未偿 ${fmt(report.banking.defaultedOutstanding)}）；` +
      `利息收入 ${fmt(report.banking.interestIncome)}，利息支出 ${fmt(report.banking.interestExpense)}`,
  );
  for (const [purpose, bucket] of Object.entries(report.banking.byPurpose)) {
    console.log(`  用途 ${purpose}: ${bucket.contracts} 笔，未偿 ${fmt(bucket.outstanding)}`);
  }
  console.log(`  本月利差（利息收入 − 利息支出）：${fmt(report.banking.interestIncome - report.banking.interestExpense)}`);
  console.log(`  政府总负债（契约口径）：${fmt(report.banking.governmentDebtTotal)}`);
  for (const city of report.banking.governmentDebtByCity) {
    const row = report.monthly[report.monthly.length - 1]?.cities.find((item) => item.cityId === city.cityId);
    console.log(
      `  ${city.cityName}：总负债 ${fmt(city.totalDebt)}（银行普通 ${fmt(row?.debtBreakdown.bankLoanPrincipal)} / 垫付 ${fmt(
        row?.debtBreakdown.advanceLoanPrincipal,
      )} / 债券 ${fmt(row?.debtBreakdown.bondPrincipalOutstanding)} / 应计未付利息 ${fmt(
        (row?.debtBreakdown.loanAccruedInterest ?? 0) + (row?.debtBreakdown.bondAccruedInterest ?? 0),
      )}）；负债/GDP ${(city.debtRatio * 100).toFixed(1)}%，风险 ${city.riskLevel}（趋势 ${city.riskTrend}）`,
    );
  }

  if (report.bonds === null) {
    console.log('  债券观察（块6 扩展点）：WorldState.bonds 未落地/无发行记录 —— 不按 0 解读，等块 1 后启用。');
  } else {
    const totals = report.bonds.months.reduce(
      (acc, item) => ({
        issues: acc.issues + item.issues,
        plannedUnits: acc.plannedUnits + item.plannedUnits,
        soldUnits: acc.soldUnits + item.soldUnits,
        unsoldUnits: acc.unsoldUnits + item.unsoldUnits,
        bankAdvance: acc.bankAdvance + item.bankAdvance,
        couponPaid: acc.couponPaid + item.couponPaid,
        couponArrears: acc.couponArrears + (item.couponArrears ?? 0),
        principalRepaid: acc.principalRepaid + item.principalRepaid,
      }),
      { issues: 0, plannedUnits: 0, soldUnits: 0, unsoldUnits: 0, bankAdvance: 0, couponPaid: 0, couponArrears: 0, principalRepaid: 0 },
    );
    console.log(
      `  债券合计：发行 ${totals.issues} 期，计划 ${totals.plannedUnits} 份 / 成交 ${totals.soldUnits} 份 / 未售 ${totals.unsoldUnits} 份；` +
        `票息 ${fmt(totals.couponPaid)}（累计欠付 ${fmt(totals.couponArrears)}），还本 ${fmt(totals.principalRepaid)}，银行垫付 ${fmt(totals.bankAdvance)}`,
    );
    if (report.bonds.issues.length === 0) {
      console.log('  债券账本已初始化，但本基线无发行记录（块1 结算接线未完成时属预期；见 block6 D11 预期 vs 实测）。');
    }
    for (const issue of report.bonds.issues.slice(0, 10)) {
      const crossCityUnits = issue.holders.filter((item) => item.crossCity).reduce((sum, item) => sum + item.units, 0);
      const holderMix = issue.holders.map((item) => `${item.holderType}:${item.units}`).join('/') || '无';
      console.log(
        `  ${issue.cityName} ${issue.issueId}（tick ${issue.tick}）：计划 ${issue.plannedUnits} / 成交 ${issue.soldUnits} / 未售 ${issue.unsoldUnits}` +
          `，覆盖率 ${issue.coverageRatio === null ? '—' : (issue.coverageRatio * 100).toFixed(1) + '%'}，跨城 ${crossCityUnits} 份，主体 ${holderMix}`,
      );
    }
  }

  const probePrint = report.probe;
  console.log('\n[块6] 政府债券 / 破产重选 / 融资拆解 / 既有异常对照');
  console.log('  AI 自动发债（分城）：');
  for (const row of probePrint.bondIssuanceByCity) {
    if (row.issues === 0) {
      console.log(`    ${row.cityName}：0 期（财政未触发）`);
      continue;
    }
    console.log(
      `    ${row.cityName}：${row.issues} 期（第 ${row.firstTick}–${row.lastTick} 月），计划 ${fmt(row.plannedUnits)} 份 / 成交 ${fmt(row.soldUnits)} 份 / 未售 ${fmt(row.unsoldUnits)} 份` +
        `；首笔政府贷款 ${
          probePrint.financingByCity.find((city) => city.cityId === row.cityId)?.governmentLoanFirstTick === null
            ? '—'
            : `M${probePrint.financingByCity.find((city) => city.cityId === row.cityId)?.governmentLoanFirstTick}`
        }`,
    );
  }
  console.log('  破产事件：');
  if (probePrint.bankruptcies.length === 0) console.log('    无');
  for (const item of probePrint.bankruptcies) {
    console.log(
      `    ${item.cityName} 第 ${item.tick} 月：债务/GDP ${(item.debtRatio * 100).toFixed(1)}%` +
        `（负债 ${fmt(item.totalDebtAtJudgement)} / 判定 GDP ${fmt(item.gdpJudgementValue)}）`,
    );
    console.log(
      `      银行兑付债券本金 ${fmt(item.bondsRedeemedPrincipal)} + 计提未付利息 ${fmt(item.bondsRedeemedInterest)}（${item.bondRedemptionCount} 笔）→ 垫付转贷款 ${fmt(item.bankAdvanceCreated)}；` +
        `勾销普通贷款 ${fmt(item.bankLoansWrittenOff)} / 垫付 ${fmt(item.advancesWrittenOff)} / 欠息 ${fmt(item.interestWrittenOff)}`,
    );
    console.log(
      `      重选：${item.electionTriggeredTick === null ? '未触发（看守期）' : `同 tick 触发（获胜 ${item.electionWinner ?? '—'}）`}；股份转移：${item.shareNote}`,
    );
  }
  if (probePrint.writeOffsByCity.length > 0) {
    const total = round2(probePrint.writeOffsByCity.reduce((sum, item) => sum + item.total, 0));
    console.log(
      `  破产勾销合计 ${fmt(total)}（单列，不计入"已还本金"，#44）：` +
        probePrint.writeOffsByCity
          .map(
            (item) =>
              `${item.cityName} 普通贷款 ${fmt(item.bankLoans)} / 垫付 ${fmt(item.advances)} / 欠息 ${fmt(item.interest)}`,
          )
          .join('；') +
        '。债券"还本"为银行垫付实际支付给持有人的现金，对应垫付贷款已勾销，不代表政府偿还能力。',
    );
  }
  if (probePrint.bondHoldersByCity.length > 0) {
    console.log(
      `  债券持有结构（发行城 ← 持有城/主体）：${probePrint.bondHoldersByCity
        .map((item) => `${item.issuerCityName}←${item.holderCityName} ${fmt(item.units)} 份`)
        .join('；')}`,
    );
  }
  const bankruptcyElections = probePrint.elections.filter((item) =>
    probePrint.bankruptcies.some((record) => record.cityId === item.cityId && record.tick === item.tick),
  );
  if (bankruptcyElections.length > 0) {
    for (const item of bankruptcyElections) {
      console.log(`    重选记录：第 ${item.tick} 月 ${item.cityName} → ${item.winnerName}（${item.note}）`);
    }
  }
  console.log('  融资拆解（36 月累计，按 FiscalEntry.kind；正=流入现金，负=流出现金）：');
  for (const city of probePrint.financingByCity) {
    const parts: string[] = [];
    const k = city.byKind;
    if (k.bondIssuanceProceeds) parts.push(`发债 +${fmt(k.bondIssuanceProceeds)}`);
    if (k.bankAdvance) parts.push(`银行垫付 +${fmt(k.bankAdvance)}`);
    if (k.bondInterest) parts.push(`票息 ${fmt(k.bondInterest)}`);
    if (k.bondPrincipal) parts.push(`还本 ${fmt(k.bondPrincipal)}`);
    if (k.governmentLoanProceeds) parts.push(`政府贷款 +${fmt(k.governmentLoanProceeds)}`);
    if (k.governmentLoanRepayment) parts.push(`还贷 ${fmt(k.governmentLoanRepayment)}`);
    if (k.governmentLoanInterest) parts.push(`贷款利息 ${fmt(k.governmentLoanInterest)}`);
    if (k.debtWriteOff) parts.push(`勾销 ${fmt(k.debtWriteOff)}`);
    console.log(`    ${city.cityName}：融资流入 ${fmt(city.totalIn)} / 债务服务流出 ${fmt(city.totalOut)}；${parts.join('；') || '无'}`);
    const cum = city.cumulative;
    console.log(
      `      累计（36 月）：收入 ${fmt(cum.income)}（其中融资 ${fmt(city.totalIn)} → 经营收入 ${fmt(cum.operatingIncome)}）` +
        `；支出 ${fmt(cum.expense)}（融资流出 ${fmt(city.totalOut)} → 经营支出 ${fmt(cum.operatingExpense)}）` +
        `；融资净额 ${fmt(cum.netFinancing)}；期末财政 ${fmt(cum.finalTreasury)} / 期末负债 ${fmt(cum.finalDebt)}`,
    );
  }
  console.log(
    `  世界 GDP 三点：${probePrint.gdpPoints.map((item) => `M${item.tick} ${fmt(item.worldGdp)}`).join(' / ')}`,
  );
  console.log('  既有异常对照：');
  const kl = probePrint.knownLimitations;
  console.log(
    `    清算零回收：${kl.liquidationZeroRecovery.count} 家倒闭，债务 ${fmt(kl.liquidationZeroRecovery.debt)}，` +
      `银行实收 ${fmt(kl.liquidationZeroRecovery.repaid)}（回收率 ${((probePrint.lifecycle.recoveryRatio ?? 0) * 100).toFixed(3)}%），` +
      `减免 ${fmt(kl.liquidationZeroRecovery.forgiven)}（占期末未偿 ${(kl.liquidationZeroRecovery.shareOfOutstanding * 100).toFixed(1)}%）`,
  );
  console.log(
    `    银行负利差：${kl.bankNegativeSpreadMonths}/${report.meta.months} 个月利息收入 < 利息支出（期末月 ${fmt(
      report.monthly[report.monthly.length - 1]?.world.bankInterestIncome,
    )} vs ${fmt(report.monthly[report.monthly.length - 1]?.world.bankInterestExpense)}）`,
  );
  console.log(
    `    高分红低现金：${kl.highDividendCompanies.length} 家${kl.highDividendCompanies.length > 0 ? '：' + kl.highDividendCompanies.map((company) => `${company.cityName}${company.name}（现金 ${fmt(company.cash)} / 月工资 ${fmt(company.monthlyWage)}）`).join('；') : ''}`,
  );

  console.log('\n[E] 会计利润 vs 经营现金流（利润 > 0 但现金流 < 利润 50% 的企业）');
  if (report.profitVsCash.length === 0) console.log('  无');
  for (const row of report.profitVsCash.slice(0, 10)) {
    console.log(
      `  ${row.cityName} ${row.name}: 利润 ${fmt(row.profit)}，经营现金流 ${fmt(row.operatingCashFlow)}，` +
        `差额 ${fmt(row.difference)}${row.differenceToProfit !== null ? `（${(row.differenceToProfit * 100).toFixed(0)}% 利润）` : ''} —— ${row.reason}`,
    );
  }

  console.log('\n[F] 异常清单');
  if (report.anomalies.length === 0) console.log('  无');
  for (const anomaly of report.anomalies) console.log(`  - ${anomaly}`);

  console.log('\n[G] 样本局限');
  for (const limitation of report.limitations) console.log(`  - ${limitation}`);
  console.log(`\n${line}\n`);
}

function toCsv(report: Report): string {
  const header = [
    'tick',
    'year',
    'month',
    'cityId',
    'cityName',
    'treasury',
    'income',
    'expense',
    'deficit',
    'gdp',
    'gdpWindowSum',
    'gdpWindowMonths',
    'gdpWindowEstimatedMonths',
    'debt',
    'debtBankLoan',
    'debtAdvance',
    'debtBond',
    'debtAccruedInterest',
    'debtRatio',
    'riskLevel',
    'riskTrend',
    'companies',
    'founded',
    'liquidated',
    'householdConsumption',
    'householdDesiredConsumption',
    'budgetNewFormula',
    'budgetCurrentCode',
    'householdCash',
    'householdDeposits',
    'loansOutstanding',
    'defaultedLoans',
  ].join(',');
  const lines = [header];
  for (const row of report.monthly) {
    for (const city of row.cities) {
      lines.push(
        [
          city.tick,
          city.year,
          city.month,
          city.cityId,
          city.cityName,
          city.treasury,
          city.income,
          city.expense,
          city.deficit,
          city.gdp,
          city.gdpWindowSum,
          city.gdpWindowMonths,
          city.gdpWindowEstimatedMonths,
          city.debt,
          city.debtBreakdown.bankLoanPrincipal,
          city.debtBreakdown.advanceLoanPrincipal,
          city.debtBreakdown.bondPrincipalOutstanding,
          city.debtBreakdown.loanAccruedInterest + city.debtBreakdown.bondAccruedInterest,
          city.debtRatio,
          city.riskLevel,
          city.riskTrend,
          city.companies,
          city.founded,
          city.liquidated,
          city.householdConsumption,
          city.householdDesiredConsumption,
          city.budgetNewFormula,
          city.budgetCurrentCode,
          city.householdCash,
          city.householdDeposits,
          city.loansOutstanding,
          city.defaultedLoans,
        ].join(','),
      );
    }
  }
  return lines.join('\n');
}

// ------------------------------------------------------------------ 入口

const options = parseArgs(process.argv.slice(2));
const first = run(options.months);
printReport(first.report, first.elapsedMs);

let determinism = '未检查';
if (options.repeat) {
  const second = run(options.months);
  const same = JSON.stringify(first.report.monthly) === JSON.stringify(second.report.monthly);
  determinism = same ? '通过（两次独立运行逐月序列完全一致）' : '失败（两次运行结果不同，存在不确定性来源）';
  console.log(`[确定性] ${determinism}（第二次耗时 ${second.elapsedMs} ms）`);
}
first.report.meta.note += ` 确定性：${determinism}。`;

if (options.jsonPath) {
  const path = resolve(process.cwd(), options.jsonPath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(first.report, null, 2));
  console.log(`[JSON] 已写入 ${path}`);
}
if (options.csvPath) {
  const path = resolve(process.cwd(), options.csvPath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, toCsv(first.report));
  console.log(`[CSV] 已写入 ${path}`);
}
