import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation/core/simulation';
import { DEMO_CONFIG } from '../src/data/config';
import type { DemoConfig } from '../src/data/config';
import type { City, EconomicCheckup, LogEntry, WorldState } from '../src/simulation/contracts/types';
import { round2 } from '../src/simulation/core/math';
import {
  autoSelectPolicies,
  policyFundingMonthlyReport,
  preparePolicyFunding,
  settlePolicies,
  startPolicy,
} from '../src/simulation/policies/policies';
import { activePolicy } from '../src/simulation/policies/query';
import { appointPlayerMayor } from '../src/simulation/politics/politics';
import { reconcileLabor } from '../src/simulation/labor/labor';
import { borrowForGovernment, settleCityGovernmentDebt } from '../src/simulation/government/debt';
import { settleGovernment } from '../src/simulation/government/fiscal';
import type { FinanceResult } from '../src/simulation/finance/finance';
import { checkInvariants } from '../src/simulation/core/invariants';
import { parseSave, serializeSave } from '../src/simulation/core/save';
import { runCityEconomicCheckup } from '../src/simulation/policies/ai-labor';

/**
 * v1.5 §4：AI 政策预算与真实资金执行衔接。
 *
 * 覆盖：参考预算/已预留/实际支出三口径；真实到账后才支出；85% 债务预警降级；
 * 玩家市长不代选/不代发/不代借；100% 破产不变；真实模拟中至少一城真实支付。
 * 资金都来自真实 API：borrowForGovernment 的银行放款与 settlePolicies 的财政流水。
 */

const AI = DEMO_CONFIG.policies.aiLabor;

function richWorld(): WorldState {
  const world = Simulation.create().state;
  for (const city of world.cities) city.treasury = 80_000_000;
  return world;
}

function cityOf(world: WorldState, cityId = 'lanport'): City {
  const city = world.cities.find((entry) => entry.id === cityId);
  if (!city) throw new Error(`缺少城市 ${cityId}`);
  return city;
}

function setUnemploymentRate(city: City, rate: number): void {
  const laborForce = Math.max(1, city.population.laborForce);
  const unemployed = Math.max(0, Math.min(laborForce, Math.round(laborForce * rate)));
  city.population.unemployed = unemployed;
  city.population.employed = Math.max(0, laborForce - unemployed);
  city.population.total = city.population.employed + unemployed + city.population.nonLabor;
}

function primeCheckups(world: WorldState, city: City, rate: number, months: number): EconomicCheckup {
  let last: EconomicCheckup | null = null;
  for (let month = 0; month < months; month += 1) {
    world.time.tick += 1;
    setUnemploymentRate(city, rate);
    last = runCityEconomicCheckup(world, city, DEMO_CONFIG);
  }
  if (!last) throw new Error('至少需要生成一个月体检');
  return last;
}

/**
 * 把居民群体消费六项写成“有供给但买不起基本食品”（v1.5 §4：体检取 Σ group.lastMonth，
 * 不是本地市场台账），政策排序会优先失业救助。
 */
function neutralizeAndCreateFundingGap(world: WorldState, city: City): void {
  const food = city.market.food;
  food.price = 0;
  food.unmetDemand = 0;
  food.unmetFunding = 0;
  food.closingStock = 1_000_000_000_000;
  for (const company of world.companies) {
    if (company.cityId === city.id && company.recipeOutput === 'food') company.capacity = 1_000_000_000;
  }
  const groups = world.households.groups.filter((group) => group.cityId === city.id);
  groups.forEach((group, index) => {
    const stats = group.lastMonth;
    stats.basicNeedUnits = index === 0 ? 1_000 : 0;
    stats.basicEffectiveUnits = index === 0 ? 800 : 0;
    stats.basicSoldUnits = index === 0 ? 800 : 0;
    stats.unmetFunding = 0;
    stats.supplyShortfallUnits = 0;
  });
  city.lastMonth.consumerBudget = 0;
  city.lastMonth.consumerSpend = 0;
  city.lastMonth.householdIncome = 0;
  city.lastMonth.benefitsPaid = 0;
  city.lastMonth.publicWageBill = 0;
}

/** 建立一个“高失业危机 + funding gap，AI 已启动失业救助”的真实世界。 */
function crisisWorld(): { world: WorldState; city: City } {
  const world = richWorld();
  const city = cityOf(world);
  primeCheckups(world, city, 0.9, 3);
  neutralizeAndCreateFundingGap(world, city);
  world.time.tick += 1;
  setUnemploymentRate(city, 0.9);
  autoSelectPolicies(world, DEMO_CONFIG, []);
  if (!activePolicy(world, city.id, 'unemploymentAid')) {
    throw new Error('AI 未启动失业救助，测试前置失败');
  }
  return { world, city };
}

function emptyFinance(): FinanceResult {
  return {
    investorDividendsByCity: {},
    investorDistributionByCity: {},
    cityDividendsByCity: {},
    dividendsByCity: {},
    playerDividends: 0,
    playerDividendsByCompany: {},
    corporateTaxByCity: {},
    privateWagesByCity: {},
    wageArrears: 0,
  };
}

function lastTrace(world: WorldState, cityId: string, tick: number) {
  const trace = (world.policies.fundingMonths ?? []).find(
    (entry) => entry.cityId === cityId && entry.tick === tick,
  );
  if (!trace) throw new Error(`缺少 ${cityId} tick ${tick} 的资金追踪记录`);
  return trace;
}

function policySpendingEntries(world: WorldState, cityId: string, tick: number) {
  return world.fiscal.ledger.filter(
    (entry) => entry.cityId === cityId && entry.tick === tick && entry.kind === 'policySpending',
  );
}

/**
 * 高失业危机 + funding gap，但决策时财政已为 0（长跑中 t36+ 的典型场景）。
 * AI 高失业决策走“先立项、同 tick 15b 再真实融资”（deferFunding），不应因财政 0 无法启动。
 */
function crisisWorldWithEmptyTreasury(): { world: WorldState; city: City } {
  const world = richWorld();
  const city = cityOf(world);
  primeCheckups(world, city, 0.9, 3);
  neutralizeAndCreateFundingGap(world, city);
  world.time.tick += 1;
  setUnemploymentRate(city, 0.9);
  city.treasury = 0;
  autoSelectPolicies(world, DEMO_CONFIG, []);
  return { world, city };
}

// ---------------------------------------------------------------- 三口径 / 真实到账

describe('v1.5 §4 三口径：参考预算 → 真实到账借款 → 预留 → 实支', () => {
  it('政策执行前按规则补足资金：三口径分离、实支来自真实财政流水、未支付不计收入', () => {
    const { world, city } = crisisWorld();
    const tick = world.time.tick;
    const policy = activePolicy(world, city.id, 'unemploymentAid')!;
    const reference = policy.referenceBudget!;
    expect(reference).toBeGreaterThan(0);
    expect(policy.budget).toBe(round2(reference * (policy.monthsRemaining + 1)));

    // 模拟“税收/公共工资/福利之后财政已被用尽”的真实场景。
    city.treasury = 0;
    const log: LogEntry[] = [];
    const ledgerBefore = world.fiscal.ledger.length;
    const debtRatioBefore = 0;
    preparePolicyFunding(world, DEMO_CONFIG, log, { hiresByCompany: {} });

    const trace = lastTrace(world, city.id, tick);
    // 借款真实到账：财政余额增加、财政流水有 governmentLoanProceeds、债务率真实上升但仍 <85%。
    expect(trace.borrowingProceeds).toBeGreaterThan(0);
    expect(city.treasury).toBeGreaterThan(0);
    const loanEntries = world.fiscal.ledger
      .slice(ledgerBefore)
      .filter((entry) => entry.cityId === city.id && entry.kind === 'governmentLoanProceeds');
    expect(loanEntries).toHaveLength(1);
    expect(loanEntries[0]!.amount).toBe(trace.borrowingProceeds);
    expect(trace.debtRatioBefore).toBeGreaterThanOrEqual(debtRatioBefore);
    expect(trace.debtRatioAfterBorrowing).toBeGreaterThan(trace.debtRatioBefore);
    expect(trace.debtRatioAfterBorrowing).toBeLessThan(AI.policyFunding.maxDebtRatioForBorrowing);
    expect(trace.fundingSource).toBe('bankLoan');
    // 参考预算（决策口径）与预留（真实可动用）分离；预留 ≤ 参考预算 ≤ 真实需求。
    expect(trace.referenceBudget).toBe(reference);
    expect(policy.reservedThisMonth).toBe(trace.reserved);
    expect(trace.reserved).toBeLessThanOrEqual(trace.referenceBudget + 0.01);
    expect(policy.fundingSourceThisMonth).toBe('bankLoan');

    const incomeBefore = city.householdIncomeLastMonth;
    const benefitsBefore = city.lastMonth.benefitsPaid;
    settlePolicies(world, DEMO_CONFIG, { hiresByCompany: {}, log });

    const spent = round2(policy.spent);
    const traceAfter = lastTrace(world, city.id, tick);
    expect(spent).toBeGreaterThan(0);
    expect(traceAfter.spent).toBe(spent);
    expect(traceAfter.spent).toBeLessThanOrEqual(traceAfter.reserved + 0.01);
    // 实支逐笔来自真实政策流水，且与政策 spent 一致（无凭空支付）。
    const ledgerSpending = round2(
      policySpendingEntries(world, city.id, tick).reduce((sum, entry) => sum + Math.abs(entry.amount), 0),
    );
    expect(ledgerSpending).toBe(spent);
    // 未支付 = 真实需求/预留内没有支付的部分；只有实发进入居民收入/福利。
    expect(policy.unpaidThisMonth).toBe(traceAfter.unpaid);
    expect(traceAfter.spent + traceAfter.unpaid).toBeCloseTo(traceAfter.referenceBudget, 2);
    expect(city.householdIncomeLastMonth - incomeBefore).toBeCloseTo(spent, 2);
    expect(city.lastMonth.benefitsPaid - benefitsBefore).toBeCloseTo(spent, 2);

    // 执行记录三口径：参考预算 / 预留 / 未支付 / 真实支出 + 资金来源。
    const run = policy.tracking!.runs.at(-1)!;
    expect(run.referenceBudget).toBe(reference);
    expect(run.reserved).toBe(traceAfter.reserved);
    expect(run.unpaid).toBe(traceAfter.unpaid);
    expect(run.spent).toBe(spent);
    expect(run.fundingSource).toBe('city.treasury+govBankLoan/policySpending');
    expect(log.some((entry) => entry.message.includes('政策资金顺序'))).toBe(true);
    expect(log.some((entry) => entry.message.includes('政策执行：预留'))).toBe(true);
  });

  it('财政余额已足够时不借款：预留来自 treasury，资金来源可区分', () => {
    const { world, city } = crisisWorld();
    const tick = world.time.tick;
    const policy = activePolicy(world, city.id, 'unemploymentAid')!;
    const reference = policy.referenceBudget!;
    city.treasury = reference;
    const ledgerBefore = world.fiscal.ledger.length;
    preparePolicyFunding(world, DEMO_CONFIG, [], { hiresByCompany: {} });

    const trace = lastTrace(world, city.id, tick);
    expect(trace.borrowingProceeds).toBe(0);
    expect(trace.fundingSource).toBe('treasury');
    expect(trace.reserved).toBe(reference);
    expect(
      world.fiscal.ledger
        .slice(ledgerBefore)
        .filter((entry) => entry.cityId === city.id && entry.kind === 'governmentLoanProceeds'),
    ).toHaveLength(0);

    settlePolicies(world, DEMO_CONFIG, { hiresByCompany: {}, log: [] });
    const traceAfter = lastTrace(world, city.id, tick);
    expect(traceAfter.spent).toBe(reference);
    expect(traceAfter.unpaid).toBe(0);
    expect(policy.fundingSourceThisMonth).toBe('treasury');
  });

  it('月度报告按真实顺序输出：决策参考 → 税收 → 公共工资/福利 → 借款到账 → 预留 → 实支', () => {
    const { world, city } = crisisWorld();
    const tick = world.time.tick;
    // 先跑一次真实财政结算：产生本 tick 的税收/公共工资/福利流水（政策执行前的必要支出）。
    settleGovernment(world, emptyFinance(), DEMO_CONFIG, []);
    city.treasury = 0;
    preparePolicyFunding(world, DEMO_CONFIG, [], { hiresByCompany: {} });
    settlePolicies(world, DEMO_CONFIG, { hiresByCompany: {}, log: [] });

    const report = policyFundingMonthlyReport(world, city.id, tick)!;
    expect(report).not.toBeNull();
    expect(report.referenceBudget).toBeGreaterThan(0);
    expect(report.stages.map((stage) => stage.stage)).toEqual([
      'policyDecision',
      'taxReceived',
      'publicWages',
      'benefits',
      'policyBorrowing',
      'policyReserved',
      'policySpent',
      'unpaid',
    ]);
    // 每个阶段的金额与真实财政流水/追踪记录一致。
    const byStage = new Map(report.stages.map((stage) => [stage.stage, stage.amount]));
    expect(byStage.get('policyDecision')).toBe(report.referenceBudget);
    expect(byStage.get('taxReceived')).toBe(report.taxReceived);
    expect(byStage.get('publicWages')).toBe(report.publicWages);
    expect(byStage.get('benefits')).toBe(report.benefitsPaid);
    expect(byStage.get('policyBorrowing')).toBe(report.borrowingProceeds);
    expect(byStage.get('policyReserved')).toBe(report.reserved);
    expect(byStage.get('policySpent')).toBe(report.spent);
    expect(byStage.get('unpaid')).toBe(report.unpaid);
    expect(report.taxReceived).toBeGreaterThan(0);
    expect(report.publicWages).toBeGreaterThan(0);
    expect(report.debtRatioAfterBorrowing).toBeLessThan(AI.policyFunding.maxDebtRatioForBorrowing);
    expect(world.policies.fundingMonths!.filter((entry) => entry.cityId === city.id)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- 降级路径 / 破产规则 / 玩家权限

describe('v1.5 §4 降级路径：不能融资时不支付并如实记录未支付', () => {
  it('债务/GDP ≥ 85%：不再新增借款，预留 0、实支 0、未支付 = 真实需求', () => {
    const { world, city } = crisisWorld();
    const tick = world.time.tick;
    const policy = activePolicy(world, city.id, 'unemploymentAid')!;
    const reference = policy.referenceBudget!;
    // 固定 GDP 判定窗口，再借到债务/GDP=90%（超过 85% 预警线，但未到 100% 破产线）。
    city.gdpWindow = [{ tick: -1, value: 20_000_000, estimated: true }];
    const borrow = borrowForGovernment(world, city, DEMO_CONFIG, 18_000_000, tick, [], { exact: true });
    expect(borrow.ok, borrow.error).toBe(true);
    city.treasury = 0;
    const incomeBefore = city.householdIncomeLastMonth;
    const log: LogEntry[] = [];

    preparePolicyFunding(world, DEMO_CONFIG, log, { hiresByCompany: {} });
    const trace = lastTrace(world, city.id, tick);
    expect(trace.debtRatioBefore).toBeCloseTo(0.9, 2);
    expect(trace.borrowingProceeds).toBe(0);
    expect(trace.reserved).toBe(0);
    expect(trace.fundingSource).toBe('none');
    expect(trace.unpaid).toBe(reference);

    settlePolicies(world, DEMO_CONFIG, { hiresByCompany: {}, log });
    const traceAfter = lastTrace(world, city.id, tick);
    expect(traceAfter.spent).toBe(0);
    expect(traceAfter.unpaid).toBe(reference);
    expect(policy.spent).toBe(0);
    expect(policySpendingEntries(world, city.id, tick)).toHaveLength(0);
    expect(city.householdIncomeLastMonth).toBe(incomeBefore);
    expect(city.lastMonth.benefitsPaid).toBe(0);
    expect(traceAfter.note).toContain('未支付');
    expect(log.some((entry) => entry.message.includes('政策执行：预留 0'))).toBe(true);
    // 90% < 100%：没有触发破产，规则未变。
    expect(city.government!.bankruptcy.status).toBe('solvent');
  });

  it('债务/GDP 介于当前值与 85% 之间：只借到预警线，预留/实支为可借到的部分，其余未支付', () => {
    const { world, city } = crisisWorld();
    const tick = world.time.tick;
    const policy = activePolicy(world, city.id, 'unemploymentAid')!;
    const reference = policy.referenceBudget!;
    city.gdpWindow = [{ tick: -1, value: 20_000_000, estimated: true }];
    // 84%：再借 20 万即到 85%，远小于本月参考预算。
    const borrow = borrowForGovernment(world, city, DEMO_CONFIG, 16_800_000, tick, [], { exact: true });
    expect(borrow.ok, borrow.error).toBe(true);
    city.treasury = 0;
    preparePolicyFunding(world, DEMO_CONFIG, [], { hiresByCompany: {} });

    const trace = lastTrace(world, city.id, tick);
    expect(trace.debtRatioBefore).toBeCloseTo(0.84, 2);
    expect(trace.borrowingProceeds).toBeGreaterThan(0);
    expect(trace.borrowingProceeds).toBeCloseTo(200_000, 0);
    expect(trace.debtRatioAfterBorrowing).toBeLessThanOrEqual(0.85 + 1e-6);
    expect(trace.reserved).toBe(trace.borrowingProceeds);
    expect(trace.unpaid).toBeCloseTo(reference - trace.reserved, 2);

    settlePolicies(world, DEMO_CONFIG, { hiresByCompany: {}, log: [] });
    const traceAfter = lastTrace(world, city.id, tick);
    expect(traceAfter.spent).toBeCloseTo(traceAfter.reserved, 2);
    expect(traceAfter.unpaid).toBeGreaterThan(0);
    expect(policy.spent).toBe(traceAfter.spent);
  });

  it('100% 破产规则不变：债务/GDP ≥ 100% 仍触发破产清算', () => {
    const world = richWorld();
    const city = cityOf(world);
    city.gdpWindow = [{ tick: -1, value: 10_000_000, estimated: true }];
    city.treasury = 0;
    const borrow = borrowForGovernment(world, city, DEMO_CONFIG, 10_500_000, world.time.tick, [], {
      exact: true,
    });
    expect(borrow.ok, borrow.error).toBe(true);
    const log: LogEntry[] = [];
    settleCityGovernmentDebt(world, city, DEMO_CONFIG, log);

    expect(city.government!.bankruptcy.status).toBe('bankrupt');
    expect(city.government!.records.length).toBe(1);
    expect(city.government!.records[0]!.debtRatio).toBeGreaterThanOrEqual(
      DEMO_CONFIG.government.fiscalRisk.bankruptAt,
    );
    // 政策补足的融资上限（85%）低于破产线（100%），不替代破产规则。
    expect(AI.policyFunding.maxDebtRatioForBorrowing).toBeLessThan(
      DEMO_CONFIG.government.fiscalRisk.bankruptAt,
    );
  });

  it('玩家市长：AI 不代选/不代发/不代借，也不产生政策资金预留', () => {
    const world = richWorld();
    const city = cityOf(world);
    appointPlayerMayor(world, city.id);
    // 玩家自己选择政策（不是 AI）；随后财政被用尽。
    expect(startPolicy(world, city.id, 'unemploymentAid', DEMO_CONFIG).ok).toBe(true);
    city.treasury = 0;
    const log: LogEntry[] = [];
    preparePolicyFunding(world, DEMO_CONFIG, log, { hiresByCompany: {} });
    settlePolicies(world, DEMO_CONFIG, { hiresByCompany: {}, log });

    expect((world.policies.fundingMonths ?? []).filter((entry) => entry.cityId === city.id)).toHaveLength(0);
    expect(
      world.fiscal.ledger.filter(
        (entry) => entry.cityId === city.id && entry.kind === 'governmentLoanProceeds',
      ),
    ).toHaveLength(0);
    expect(activePolicy(world, city.id, 'unemploymentAid')!.spent).toBe(0);
    expect(world.policies.lastSelection.some((entry) => entry.cityId === city.id)).toBe(false);
    expect(checkInvariants(world)).toEqual([]);
  });
});

// ---------------------------------------------------------------- 真实模拟 / 留存 / 权限日志

describe('v1.5 §4（task-18）先立项后融资：财政为 0 仍可启动 AI 危机政策', () => {
  it('财政=0 时 AI 危机政策仍可启动；同 tick 真实借款后实支 > 0', () => {
    const { world, city } = crisisWorldWithEmptyTreasury();
    const tick = world.time.tick;
    // 旧规则会因 treasury < budget 拒绝；deferFunding 只跳过启动前财政检查，其他校验保留。
    const policy = activePolicy(world, city.id, 'unemploymentAid');
    expect(policy).toBeDefined();
    expect(policy!.effects.aiCrisisPolicy).toBe(1);
    expect(policy!.effects.deferredFunding).toBe(1);
    expect(city.treasury).toBe(0);
    expect(policy!.referenceBudget).toBeGreaterThan(DEMO_CONFIG.policies.minBudget);

    const log: LogEntry[] = [];
    preparePolicyFunding(world, DEMO_CONFIG, log, { hiresByCompany: {} });
    const trace = lastTrace(world, city.id, tick);
    expect(trace.borrowingProceeds).toBeGreaterThan(0);
    expect(city.treasury).toBeGreaterThan(0);
    expect(trace.fundingSource).toBe('bankLoan');
    expect(trace.reserved).toBe(trace.borrowingProceeds);

    settlePolicies(world, DEMO_CONFIG, { hiresByCompany: {}, log });
    const after = lastTrace(world, city.id, tick);
    expect(after.spent).toBeGreaterThan(0);
    expect(after.spent).toBeLessThanOrEqual(after.reserved + 0.01);
    expect(policy!.spent).toBe(after.spent);
    expect(after.unpaid).toBe(0);
  });

  it('财政=0 可立项但借不到（债务/GDP≥85%）：spent=0、unpaid>0，如实降级', () => {
    const world = richWorld();
    const city = cityOf(world);
    primeCheckups(world, city, 0.9, 3);
    neutralizeAndCreateFundingGap(world, city);
    world.time.tick += 1;
    setUnemploymentRate(city, 0.9);
    city.gdpWindow = [{ tick: -1, value: 20_000_000, estimated: true }];
    const borrow = borrowForGovernment(world, city, DEMO_CONFIG, 18_000_000, world.time.tick, [], {
      exact: true,
    });
    expect(borrow.ok, borrow.error).toBe(true);
    city.treasury = 0;
    autoSelectPolicies(world, DEMO_CONFIG, []);
    const policy = activePolicy(world, city.id, 'unemploymentAid')!;
    expect(policy.effects.aiCrisisPolicy).toBe(1);
    const tick = world.time.tick;

    preparePolicyFunding(world, DEMO_CONFIG, [], { hiresByCompany: {} });
    const trace = lastTrace(world, city.id, tick);
    expect(trace.borrowingProceeds).toBe(0);
    expect(trace.reserved).toBe(0);
    settlePolicies(world, DEMO_CONFIG, { hiresByCompany: {}, log: [] });
    const after = lastTrace(world, city.id, tick);
    expect(after.spent).toBe(0);
    expect(after.unpaid).toBeGreaterThan(0);
    expect(policy.spent).toBe(0);
    expect(policySpendingEntries(world, city.id, tick)).toHaveLength(0);
    expect(city.government!.bankruptcy.status).toBe('solvent');
  });

  it('“先立项后融资”只限 AI 危机路径：玩家手动/普通 AI 政策仍受启动财政约束', () => {
    const world = richWorld();
    const city = cityOf(world);
    city.treasury = 0;
    // 即使 reason 文本相同，没有 deferFunding 也不得绕过启动财政检查。
    const manual = startPolicy(world, city.id, 'unemploymentAid', DEMO_CONFIG, {
      reason: 'AI 高失业决策：伪造文本也不能绕过',
    });
    expect(manual.ok).toBe(false);
    expect(manual.error).toBe('该政策当前无法执行：城市财政资金不足');
    // 显式 deferFunding（AI 路径）在同样财政下可以立项，但多了一层标记。
    city.treasury = 80_000_000;
    const deferred = startPolicy(world, city.id, 'hiringSubsidy', DEMO_CONFIG, {
      reason: 'AI 高失业决策：测试',
      deferFunding: true,
    });
    expect(deferred.ok, deferred.error).toBe(true);
    expect(activePolicy(world, city.id, 'hiringSubsidy')!.effects.aiCrisisPolicy).toBe(1);
  });

  it('玩家市长：财政为 0 时 AI 也不启动政策、不借款', () => {
    const world = richWorld();
    const city = cityOf(world);
    appointPlayerMayor(world, city.id);
    primeCheckups(world, city, 0.9, 3);
    neutralizeAndCreateFundingGap(world, city);
    world.time.tick += 1;
    setUnemploymentRate(city, 0.9);
    city.treasury = 0;
    autoSelectPolicies(world, DEMO_CONFIG, []);
    expect(world.policies.active.filter((policy) => policy.cityId === city.id)).toHaveLength(0);
    expect(world.policies.lastSelection.find((entry) => entry.cityId === city.id)!.reason).toContain('玩家市长');
    preparePolicyFunding(world, DEMO_CONFIG, [], { hiresByCompany: {} });
    settlePolicies(world, DEMO_CONFIG, { hiresByCompany: {}, log: [] });
    expect((world.policies.fundingMonths ?? []).filter((entry) => entry.cityId === city.id)).toHaveLength(0);
    expect(
      world.fiscal.ledger.filter(
        (entry) => entry.cityId === city.id && entry.kind === 'governmentLoanProceeds',
      ),
    ).toHaveLength(0);
  });

  it('公共岗位被标记后同样被资助：预留>0、实支来自真实公共工资（fiscal publicWages）', () => {
    const world = richWorld();
    const city = cityOf(world);
    primeCheckups(world, city, 0.9, 3);
    neutralizeAndCreateFundingGap(world, city);
    world.time.tick += 1;
    setUnemploymentRate(city, 0.9);
    // 失业救助已占一个政策位，AI 危机排序下一个候选是公共岗位。
    expect(startPolicy(world, city.id, 'unemploymentAid', DEMO_CONFIG).ok).toBe(true);
    city.treasury = 0;
    autoSelectPolicies(world, DEMO_CONFIG, []);
    const policy = activePolicy(world, city.id, 'publicJobs')!;
    expect(policy).toBeDefined();
    expect(policy.effects.aiCrisisPolicy).toBe(1);
    // 真实补员 + 真实财政公共工资支付（fiscal publicWages），再走政策资金预留。
    reconcileLabor(world, DEMO_CONFIG, []);
    settleGovernment(world, emptyFinance(), DEMO_CONFIG, []);
    const tick = world.time.tick;
    city.treasury = 0;
    preparePolicyFunding(world, DEMO_CONFIG, [], { hiresByCompany: {} });
    const trace = lastTrace(world, city.id, tick);
    expect(trace.reserved).toBeGreaterThan(0);
    expect(trace.fundingSource).toBe('bankLoan');
    expect(policy.reservedThisMonth).toBeGreaterThan(0);
    settlePolicies(world, DEMO_CONFIG, { hiresByCompany: {}, log: [] });
    const after = lastTrace(world, city.id, tick);
    // 公共岗位实支来自 fiscal.publicWages（真实财政流水），由政策归属统计。
    expect(policy.effects.publicWagePaidThisMonth).toBeGreaterThan(0);
    expect(after.spent).toBeGreaterThan(0);
    expect(after.spent).toBe(policy.effects.publicWagePaidThisMonth);
    expect(after.spent).toBeLessThanOrEqual(after.reserved + 0.01);
  });
});

describe('v1.5 §4 真实模拟与持久化', () => {
  it('真实模拟 6 个月：至少一城 AI 政策按真实到账资金支付，三口径与财政流水闭合', () => {
    const simulation = Simulation.create();
    const world = simulation.state;
    for (let month = 0; month < 6; month += 1) simulation.tick();
    expect(checkInvariants(world)).toEqual([]);

    const paidCities: string[] = [];
    for (const city of world.cities) {
      const traces = (world.policies.fundingMonths ?? []).filter((entry) => entry.cityId === city.id);
      expect(traces.length).toBeGreaterThan(0);
      for (const trace of traces) {
        expect(trace.reserved).toBeGreaterThanOrEqual(trace.spent - 0.01);
        expect(trace.spent).toBeGreaterThanOrEqual(0);
        expect(trace.unpaid).toBeGreaterThanOrEqual(0);
        expect(trace.debtRatioAfterBorrowing).toBeLessThan(DEMO_CONFIG.government.fiscalRisk.bankruptAt);
        // 每笔实支都来自真实财政流水（同 tick 无截断风险时逐笔核对）。
        // 政策实支 = policySpending 流水 + 公共岗位由 fiscal.publicWages 实际支付的部分。
        const candidates = [
          ...world.policies.active,
          ...world.policies.history.filter((entry) => entry.endedTick === trace.tick),
        ].filter(
          (policy) => policy.cityId === city.id && policy.effects.reservedTick === trace.tick,
        );
        const publicWageSpent = round2(
          candidates
            .filter((policy) => policy.policyId === 'publicJobs')
            .reduce((sum, policy) => sum + Math.max(0, policy.effects.publicWagePaidThisMonth ?? 0), 0),
        );
        const ledgerSpent = round2(
          policySpendingEntries(world, city.id, trace.tick).reduce(
            (sum, entry) => sum + Math.abs(entry.amount),
            0,
          ) + publicWageSpent,
        );
        if (trace.spent > 0) expect(ledgerSpent).toBeCloseTo(trace.spent, 2);
      }
      const totalSpent = round2(traces.reduce((sum, trace) => sum + trace.spent, 0));
      if (totalSpent > 0) paidCities.push(city.id);
      // 借款只用于真实到账：借贷总额与政策实支同量级，且未超债务率上限。
      const totalBorrowed = round2(traces.reduce((sum, trace) => sum + trace.borrowingProceeds, 0));
      expect(totalBorrowed).toBeGreaterThanOrEqual(0);
      const last = traces[traces.length - 1]!;
      expect(policyFundingMonthlyReport(world, city.id, last.tick)).not.toBeNull();
    }
    // 至少一座高失业 AI 城市真实支付政策资金（验收核心）。
    expect(paidCities.length).toBeGreaterThan(0);
    for (const cityId of paidCities) {
      const city = cityOf(world, cityId);
      const traces = world.policies.fundingMonths!.filter((entry) => entry.cityId === cityId);
      const totalSpent = round2(traces.reduce((sum, trace) => sum + trace.spent, 0));
      // 真实受益人：救助/招聘等政策有实际支出即留下受益（benefits/企业现金已真实变化）。
      expect(totalSpent).toBeGreaterThan(0);
      expect(city.population.total).toBeGreaterThan(0);
    }
  });

  it('fundingMonths 与三口径字段随存档往返保留（parse 不丢失、二次序列化逐字节一致）', () => {
    const simulation = Simulation.create();
    for (let month = 0; month < 3; month += 1) simulation.tick();
    const world = simulation.state;
    const before = world.policies.fundingMonths ?? [];
    expect(before.length).toBeGreaterThan(0);
    const savedAt = '2026-01-01T00:00:00.000Z';
    const text = serializeSave(world, savedAt);
    const parsed = parseSave(text);
    expect(parsed.ok, parsed.error).toBe(true);
    const loaded = parsed.world!;
    const after = loaded.policies.fundingMonths ?? [];
    expect(after).toHaveLength(before.length);
    expect(after[0]).toEqual(before[0]);
    const sample = before.find((entry) => entry.spent > 0)!;
    const loadedSample = after.find((entry) => entry.tick === sample.tick && entry.cityId === sample.cityId)!;
    expect(loadedSample).toEqual(sample);
    // 三口径字段属于存档内容：参考预算/预留/未支付/资金来源均保留。
    const loadedPolicies = loaded.policies.active.filter((policy) => policy.referenceBudget !== undefined);
    expect(loadedPolicies.length).toBeGreaterThan(0);
    for (const policy of loadedPolicies) {
      const original = world.policies.active.find((entry) => entry.id === policy.id)!;
      expect(policy.referenceBudget).toBe(original.referenceBudget);
      expect(policy.reservedThisMonth).toBe(original.reservedThisMonth);
      expect(policy.unpaidThisMonth).toBe(original.unpaidThisMonth);
      expect(policy.fundingSourceThisMonth).toBe(original.fundingSourceThisMonth);
    }
    expect(serializeSave(loaded, savedAt)).toBe(text);
  });

  it('fundingMonths 每城保留最近 N 月，并在 note 标注截断', () => {
    const config = {
      ...DEMO_CONFIG,
      policies: {
        ...DEMO_CONFIG.policies,
        aiLabor: {
          ...DEMO_CONFIG.policies.aiLabor,
          policyFunding: { ...DEMO_CONFIG.policies.aiLabor.policyFunding, retentionMonths: 2 },
        },
      },
    } as unknown as DemoConfig;
    const { world, city } = crisisWorld();
    const policy = activePolicy(world, city.id, 'unemploymentAid')!;
    let tick = world.time.tick;
    for (let month = 0; month < 3; month += 1) {
      tick += 1;
      world.time.tick = tick;
      setUnemploymentRate(city, 0.9);
      // 让缺口真实存在：每次结算前财政为 0。
      city.treasury = 0;
      preparePolicyFunding(world, config, [], { hiresByCompany: {} });
      settlePolicies(world, config, { hiresByCompany: {}, log: [] });
    }
    const traces = (world.policies.fundingMonths ?? []).filter((entry) => entry.cityId === city.id);
    expect(traces).toHaveLength(2);
    expect(policy.monthsRemaining).toBe(6 - 3);
    expect(traces[traces.length - 1]!.note).toContain('保留最近 2 个月');
    expect(traces[traces.length - 1]!.note).toContain('截断');
  });

  it('财政金额日志带市长可见性（§1 财政泄露修复）', () => {
    const world = richWorld();
    const city = cityOf(world);
    const log: LogEntry[] = [];
    expect(startPolicy(world, city.id, 'housingSupport', DEMO_CONFIG, { log }).ok).toBe(true);
    const startLog = log.find((entry) => entry.message.includes('启动住房支持'))!;
    expect(startLog.visibility).toEqual({ scope: 'mayor', cityId: city.id });
    settlePolicies(world, DEMO_CONFIG, { hiresByCompany: {}, log });
    const spendLog = log.find((entry) => entry.message.includes('住房支持：支出'))!;
    expect(spendLog.visibility).toEqual({ scope: 'mayor', cityId: city.id });

    // 招聘补贴的支出日志同样不应向非市长泄露金额。
    const world2 = richWorld();
    const city2 = cityOf(world2, 'ironvale');
    for (const company of world2.companies) {
      if (company.cityId === city2.id) company.jobDemand = company.employees;
    }
    const company = world2.companies.find((entry) => entry.id === 'iv-food')!;
    const log2: LogEntry[] = [];
    expect(startPolicy(world2, city2.id, 'hiringSubsidy', DEMO_CONFIG, { log: log2 }).ok).toBe(true);
    company.jobDemand = company.employees + 5;
    const labor = reconcileLabor(world2, DEMO_CONFIG, []);
    settlePolicies(world2, DEMO_CONFIG, { hiresByCompany: labor.hiresByCompany, log: log2 });
    const hiringLog = log2.find((entry) => entry.message.includes('新增招聘补贴'))!;
    expect(hiringLog.visibility).toEqual({ scope: 'mayor', cityId: city2.id });
  });
});
