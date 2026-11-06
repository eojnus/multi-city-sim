import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation/core/simulation';
import { DEMO_CONFIG } from '../src/data/config';
import type { DemoConfig } from '../src/data/config';
import type { City, EconomicCheckup, LogEntry, WorldState } from '../src/simulation/contracts/types';
import { round2 } from '../src/simulation/core/math';
import {
  autoSelectPolicies,
  monthlyPolicyQuota,
  policyFundingMonthlyReport,
  preparePolicyFunding,
  publicJobsStats,
  settlePolicies,
  startPolicy,
} from '../src/simulation/policies/policies';
import { activePolicy } from '../src/simulation/policies/query';
import { runCityEconomicCheckup } from '../src/simulation/policies/ai-labor';
import { reconcileLabor } from '../src/simulation/labor/labor';
import { settleGovernment } from '../src/simulation/government/fiscal';
import type { FinanceResult } from '../src/simulation/finance/finance';
import { checkInvariants } from '../src/simulation/core/invariants';
import { parseSave, serializeSave } from '../src/simulation/core/save';

/**
 * v1.6 §一.1 / §一.2：AI 政策月预算总额口径 + 公共岗位统计。
 *
 * 核心口径（写死在测试里）：
 * - quota = 当月 checkup.budget（月政策预算总额度）；
 * - 当月全部 active AI 危机政策按参考需求权重、最大余数法分配，Σ分项 = min(quota, Σ参考需求)，
 *   同一笔预算不重复使用（修复旧 bug：两项政策各自拿满整月额度 → 合计 2×）；
 * - 每项 spent + unpaid ≤ 分项额度；公共工资按 fiscal.publicWages 实付记录归属，
 *   实发超出分项额度的部分单列，不伪造成实支、不改写工资；
 * - 公共岗位分别统计 本月新增岗位数 / 月末在岗人数 / 撤销岗位数 / 实付工资，
 *   累计“岗位数”与“在岗人次”分开，不把多月在岗人数相加叫新增。
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

function primeCheckups(world: WorldState, city: City, rate: number, months: number): void {
  for (let month = 0; month < months; month += 1) {
    world.time.tick += 1;
    setUnemploymentRate(city, rate);
    runCityEconomicCheckup(world, city, DEMO_CONFIG);
  }
}

/** 居民“买不起但有供给”的体检输入（与 v1.5 夹具一致，政策排序会优先失业救助）。 */
function neutralizeAndCreateFundingGap(world: WorldState, city: City): void {
  const food = city.market.food;
  food.price = 0;
  food.unmetDemand = 0;
  food.unmetFunding = 0;
  food.closingStock = 1_000_000_000_000;
  for (const company of world.companies) {
    if (company.cityId === city.id && company.recipeOutput === 'food') {
      company.capacity = 1_000_000_000;
    }
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

function checkupOf(world: WorldState, cityId: string): EconomicCheckup {
  const list = (world.policies.checkups ?? []).filter((entry) => entry.cityId === cityId);
  const latest = list.reduce<EconomicCheckup | null>(
    (best, entry) => (!best || entry.tick > best.tick ? entry : best),
    null,
  );
  if (!latest) throw new Error(`缺少 ${cityId} 体检快照`);
  return latest;
}

function traceOf(world: WorldState, cityId: string, tick: number) {
  const trace = (world.policies.fundingMonths ?? []).find(
    (entry) => entry.cityId === cityId && entry.tick === tick,
  );
  if (!trace) throw new Error(`缺少 ${cityId} tick ${tick} 政策资金记录`);
  return trace;
}

/**
 * 第 1 个月 AI 立项失业救助；第 2 个月体检后 AI 再立项公共岗位 → 同城同月两项 AI 危机政策。
 * 这正是旧口径 bug 的现场：两项 policy.referenceBudget 各自等于体检月预算。
 */
function twoCrisisPoliciesWorld(): { world: WorldState; city: City } {
  const world = richWorld();
  const city = cityOf(world, 'lanport');
  primeCheckups(world, city, 0.9, 3);
  neutralizeAndCreateFundingGap(world, city);
  world.time.tick += 1;
  setUnemploymentRate(city, 0.9);
  autoSelectPolicies(world, DEMO_CONFIG, []);
  if (!activePolicy(world, city.id, 'unemploymentAid')) {
    throw new Error('前置失败：第 1 个月 AI 未启动失业救助');
  }
  world.time.tick += 1;
  setUnemploymentRate(city, 0.9);
  runCityEconomicCheckup(world, city, DEMO_CONFIG);
  autoSelectPolicies(world, DEMO_CONFIG, []);
  if (!activePolicy(world, city.id, 'publicJobs')) {
    throw new Error('前置失败：第 2 个月 AI 未启动公共岗位');
  }
  return { world, city };
}

// ---------------------------------------------------------------- §一.1 总额度分配

describe('v1.6 §一.1 月政策预算总额度：多项政策分配同一笔额度，不重复使用', () => {
  it('同月两项 AI 危机政策：分项参考预算合计 = 体检月预算（不再是 2×）', () => {
    const { world, city } = twoCrisisPoliciesWorld();
    const tick = world.time.tick;
    const checkup = checkupOf(world, city.id);
    expect(checkup.tick).toBe(tick);
    const policies = world.policies.active.filter((policy) => policy.cityId === city.id);
    expect(policies).toHaveLength(2);
    // 旧口径现场：两项各自 referenceBudget = 整月额度；策略层参考需求保持不变（只影响本月分配）。
    const decisionDemand = round2(
      policies.reduce((sum, policy) => sum + (policy.referenceBudget ?? 0), 0),
    );
    expect(decisionDemand).toBeGreaterThan(checkup.budget + 0.01);

    city.treasury = 0;
    preparePolicyFunding(world, DEMO_CONFIG, [], { hiresByCompany: {} });
    const trace = traceOf(world, city.id, tick);

    // 总额度 = 当月体检月预算；分项合计 = 额度分配，不是各项各自整月额度之和。
    expect(trace.quota).toBeCloseTo(checkup.budget, 2);
    expect(trace.referenceBudget).toBeCloseTo(checkup.budget, 2);
    expect(trace.referenceBudget).toBeLessThan(decisionDemand - 0.01);
    const entries = trace.policyBudgets ?? [];
    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.policyId).sort()).toEqual(['publicJobs', 'unemploymentAid']);
    const allocated = round2(entries.reduce((sum, entry) => sum + entry.referenceBudget, 0));
    expect(allocated).toBeCloseTo(trace.quota!, 2);
    for (const entry of entries) {
      const policy = policies.find((item) => item.id === entry.policyInstanceId)!;
      expect(entry.referenceBudget).toBeGreaterThan(0);
      // 每项分到的额度不超过它自己的决策参考需求，且合计不超总额度。
      expect(entry.referenceBudget).toBeLessThanOrEqual((policy.referenceBudget ?? 0) + 0.01);
      expect(entry.claim).toBeLessThanOrEqual(entry.referenceBudget + 0.01);
      expect(entry.reserved).toBeLessThanOrEqual(entry.claim + 0.01);
      expect(entry.reserved).toBeLessThanOrEqual(entry.referenceBudget + 0.01);
    }
    // 预留只能来自真实资金：借款到账 = 总缺口（本场景财政为 0），且不超总额度。
    expect(trace.borrowingProceeds).toBeGreaterThan(0);
    expect(trace.reserved).toBeLessThanOrEqual(trace.referenceBudget + 0.01);
  });

  it('按参考需求权重最大余数分配：权重 3:1 时额度按 3:1 拆（Σ 精确等于额度）', () => {
    const world = richWorld();
    const city = cityOf(world, 'lanport');
    world.time.tick += 1;
    runCityEconomicCheckup(world, city, DEMO_CONFIG);
    const checkup = checkupOf(world, city.id);
    // 人为把本月额度固定为 1,000,000，便于断言分配比例。
    checkup.budget = 1_000_000;
    expect(
      startPolicy(world, city.id, 'unemploymentAid', DEMO_CONFIG, {
        budget: 3_000_000,
        deferFunding: true,
        reason: 'AI 高失业决策：测试权重 3',
      }).ok,
    ).toBe(true);
    expect(
      startPolicy(world, city.id, 'vocationalTraining', DEMO_CONFIG, {
        budget: 1_000_000,
        deferFunding: true,
        reason: 'AI 高失业决策：测试权重 1',
      }).ok,
    ).toBe(true);
    const aid = activePolicy(world, city.id, 'unemploymentAid')!;
    const training = activePolicy(world, city.id, 'vocationalTraining')!;

    preparePolicyFunding(world, DEMO_CONFIG, [], { hiresByCompany: {} });
    const trace = traceOf(world, city.id, world.time.tick);
    expect(trace.quota).toBeCloseTo(1_000_000, 2);
    const entries = trace.policyBudgets ?? [];
    const aidEntry = entries.find((entry) => entry.policyId === 'unemploymentAid')!;
    const trainingEntry = entries.find((entry) => entry.policyId === 'vocationalTraining')!;
    expect(aidEntry.policyInstanceId).toBe(aid.id);
    // 3:1 权重，最大余数法分币精确：750,000 / 250,000，Σ = 额度。
    expect(aidEntry.referenceBudget).toBeCloseTo(750_000, 2);
    expect(trainingEntry.referenceBudget).toBeCloseTo(250_000, 2);
    expect(round2(aidEntry.referenceBudget + trainingEntry.referenceBudget)).toBeCloseTo(1_000_000, 2);
    // 分项额度 ≤ 各项决策参考需求（不放大需求）。
    expect(aidEntry.referenceBudget).toBeLessThanOrEqual(3_000_000 + 0.01);
    expect(trainingEntry.referenceBudget).toBeLessThanOrEqual(1_000_000 + 0.01);
  });

  it('跨月继续执行：按当月 quota 重新分配，不沿用旧整月额度（含无当月体检的回退）', () => {
    const world = richWorld();
    const city = cityOf(world, 'lanport');
    const startTick = world.time.tick;
    runCityEconomicCheckup(world, city, DEMO_CONFIG);
    checkupOf(world, city.id).budget = 2_000_000;
    expect(
      startPolicy(world, city.id, 'unemploymentAid', DEMO_CONFIG, {
        budget: 3_000_000,
        deferFunding: true,
        reason: 'AI 高失业决策：跨月测试',
      }).ok,
    ).toBe(true);
    expect(
      startPolicy(world, city.id, 'vocationalTraining', DEMO_CONFIG, {
        budget: 1_000_000,
        deferFunding: true,
        reason: 'AI 高失业决策：跨月测试',
      }).ok,
    ).toBe(true);

    // 第 1 月：quota = 200 万 → 150 万 / 50 万。
    preparePolicyFunding(world, DEMO_CONFIG, [], { hiresByCompany: {} });
    const first = traceOf(world, city.id, startTick);
    expect(first.quota).toBeCloseTo(2_000_000, 2);
    expect(
      (first.policyBudgets ?? []).find((entry) => entry.policyId === 'unemploymentAid')!
        .referenceBudget,
    ).toBeCloseTo(1_500_000, 2);

    // 第 2 月：没有当月体检 → 回退最近一次体检额度（不沿用旧分配后的漂移值）。
    world.time.tick += 1;
    preparePolicyFunding(world, DEMO_CONFIG, [], { hiresByCompany: {} });
    const second = traceOf(world, city.id, world.time.tick);
    expect(second.note).toContain('最近体检');
    expect(second.quota).toBeCloseTo(2_000_000, 2);
    expect(
      (second.policyBudgets ?? []).find((entry) => entry.policyId === 'unemploymentAid')!
        .referenceBudget,
    ).toBeCloseTo(1_500_000, 2);

    // 第 3 月：当月体检额度降到 100 万 → 重新分配为 75 万 / 25 万（不是沿用的 150 万）。
    world.time.tick += 1;
    runCityEconomicCheckup(world, city, DEMO_CONFIG);
    checkupOf(world, city.id).budget = 1_000_000;
    expect(monthlyPolicyQuota(world, city.id)).toEqual({
      quota: 1_000_000,
      tick: world.time.tick,
      source: 'checkup',
    });
    preparePolicyFunding(world, DEMO_CONFIG, [], { hiresByCompany: {} });
    const third = traceOf(world, city.id, world.time.tick);
    expect(third.quota).toBeCloseTo(1_000_000, 2);
    expect(third.referenceBudget).toBeCloseTo(1_000_000, 2);
    expect(
      (third.policyBudgets ?? []).find((entry) => entry.policyId === 'unemploymentAid')!
        .referenceBudget,
    ).toBeCloseTo(750_000, 2);
    // 旧整月额度没有继续生效：本月分配 < 去年同期的 150 万。
    expect(third.referenceBudget).toBeLessThan(first.referenceBudget);
  });

  it('每项 spent + unpaid ≤ 分项额度；实支 + 未支付 ≤ 合计额度（+ 超额度公共工资实发部分）', () => {
    const { world, city } = twoCrisisPoliciesWorld();
    const tick = world.time.tick;
    // 真实补员 + 真实财政公共工资支付（fiscal.publicWages），再走资金预留。
    reconcileLabor(world, DEMO_CONFIG, []);
    settleGovernment(world, emptyFinance(), DEMO_CONFIG, []);
    city.treasury = 0;
    const log: LogEntry[] = [];
    preparePolicyFunding(world, DEMO_CONFIG, log, { hiresByCompany: {} });
    settlePolicies(world, DEMO_CONFIG, { hiresByCompany: {}, log });
    const trace = traceOf(world, city.id, tick);
    const entries = trace.policyBudgets ?? [];
    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      expect(entry.spent + entry.unpaid).toBeLessThanOrEqual(entry.referenceBudget + 0.01);
      expect(entry.spent).toBeLessThanOrEqual(entry.reserved + 0.01);
    }
    // 总量口径：实支 + 未支付 ≤ 本月额度（+ 已发生公共工资中超出分项额度的实发部分）。
    expect(trace.spent + trace.unpaid).toBeLessThanOrEqual(
      trace.referenceBudget + (trace.publicWagesOverQuota ?? 0) + 0.01,
    );
    expect(trace.quota).toBeCloseTo(checkupOf(world, city.id).budget, 2);
    // 公共岗位实发工资按 fiscal.publicWages 真实支付记录归属（不是 policySpending 二次扣款）。
    const publicJobsEntry = entries.find((entry) => entry.policyId === 'publicJobs')!;
    const record = publicJobsStats(world, city.id).latest!;
    expect(record).toBeTruthy();
    expect(record.wagesPaid).toBeGreaterThan(0);
    expect(trace.publicWagesAttributed).toBeCloseTo(record.wagesPaid, 2);
    expect(publicJobsEntry.publicWagesAttributed).toBeGreaterThan(0);
    expect(publicJobsEntry.publicWagesAttributed).toBeLessThanOrEqual(
      record.wagesPaid + 0.01,
    );
    // 政策层不产生公共岗位的 policySpending 流水（工资只由 fiscal.publicWages 付一次）。
    expect(
      world.fiscal.ledger.filter(
        (entry) =>
          entry.cityId === city.id &&
          entry.tick === tick &&
          entry.kind === 'policySpending' &&
          entry.policyId === 'publicJobs',
      ),
    ).toHaveLength(0);
  });

  it('贷款真实到账后才预留：财政余额、governmentLoanProceeds 流水、债务率同源上升', () => {
    const { world, city } = twoCrisisPoliciesWorld();
    const tick = world.time.tick;
    const ledgerBefore = world.fiscal.ledger.length;
    city.treasury = 0;
    preparePolicyFunding(world, DEMO_CONFIG, [], { hiresByCompany: {} });
    const trace = traceOf(world, city.id, tick);
    expect(trace.borrowingProceeds).toBeGreaterThan(0);
    expect(city.treasury).toBeCloseTo(trace.borrowingProceeds, 2);
    const loanEntries = world.fiscal.ledger
      .slice(ledgerBefore)
      .filter((entry) => entry.cityId === city.id && entry.kind === 'governmentLoanProceeds');
    expect(loanEntries).toHaveLength(1);
    expect(loanEntries[0]!.amount).toBeCloseTo(trace.borrowingProceeds, 2);
    expect(trace.debtRatioAfterBorrowing).toBeGreaterThanOrEqual(trace.debtRatioBefore);
    expect(trace.debtRatioAfterBorrowing).toBeLessThan(AI.policyFunding.maxDebtRatioForBorrowing);
    // 100% 破产规则不变：政策补足上限严格低于破产线。
    expect(AI.policyFunding.maxDebtRatioForBorrowing).toBeLessThan(
      DEMO_CONFIG.government.fiscalRisk.bankruptAt,
    );
    expect(trace.reserved).toBeLessThanOrEqual(trace.referenceBudget + 0.01);
  });

  it('月度报告读取总额度与分项：quota / policyBudgets / 三口径一并持久化', () => {
    const { world, city } = twoCrisisPoliciesWorld();
    const tick = world.time.tick;
    reconcileLabor(world, DEMO_CONFIG, []);
    settleGovernment(world, emptyFinance(), DEMO_CONFIG, []);
    city.treasury = 0;
    preparePolicyFunding(world, DEMO_CONFIG, [], { hiresByCompany: {} });
    settlePolicies(world, DEMO_CONFIG, { hiresByCompany: {}, log: [] });

    const report = policyFundingMonthlyReport(world, city.id, tick)!;
    expect(report).not.toBeNull();
    expect(report.quota).toBeCloseTo(traceOf(world, city.id, tick).quota!, 2);
    expect(report.policyBudgets).toHaveLength(2);
    const allocated = round2(
      report.policyBudgets.reduce((sum, entry) => sum + entry.referenceBudget, 0),
    );
    expect(allocated).toBeCloseTo(report.referenceBudget, 2);
    expect(report.referenceBudget).toBeCloseTo(report.quota, 2);
    expect(report.publicWagesAttributed).toBeGreaterThanOrEqual(0);
    // 报告的实支 = 现金政策流水 + 公共岗位归属工资（三者同源，且不重复）。
    const publicWage = round2(
      report.policyBudgets.reduce((sum, entry) => sum + entry.publicWagesAttributed, 0),
    );
    const cashSpent = round2(report.spent - publicWage);
    const ledgerCash = round2(
      world.fiscal.ledger
        .filter(
          (entry) =>
            entry.cityId === city.id &&
            entry.tick === tick &&
            entry.kind === 'policySpending',
        )
        .reduce((sum, entry) => sum + Math.abs(entry.amount), 0),
    );
    expect(cashSpent).toBeGreaterThanOrEqual(-0.01);
    if (ledgerCash > 0) expect(cashSpent).toBeLessThanOrEqual(ledgerCash + 0.01);
  });
});

// ---------------------------------------------------------------- §一.2 公共岗位统计

describe('v1.6 §一.2 公共岗位统计：新增岗位 / 在岗人数 / 撤销 / 实付工资（人数≠人次）', () => {
  it('完整生命周期：四项统计分开记录，累计岗位与累计人次口径不同', () => {
    const world = richWorld();
    const city = cityOf(world, 'ironvale');
    const startTick = world.time.tick;
    const jobsBefore = city.publicSector.jobs;
    expect(startPolicy(world, city.id, 'publicJobs', DEMO_CONFIG).ok).toBe(true);
    const policy = activePolicy(world, city.id, 'publicJobs')!;
    const created = policy.effects.jobsCreated!;
    expect(created).toBeGreaterThan(0);
    const wageRate = city.publicSector.wageRate;

    // 真实补员 + 第 1 月结算：新增岗位已记，月末在岗 = 实际到岗人数，工资按实付归属。
    reconcileLabor(world, DEMO_CONFIG, []);
    settlePolicies(world, DEMO_CONFIG, { hiresByCompany: {}, log: [] });
    let stats = publicJobsStats(world, city.id);
    let month = stats.latest!;
    expect(month.tick).toBe(startTick);
    expect(month.jobsAdded).toBe(created);
    expect(month.headcount).toBe(created);
    expect(month.jobsRemoved).toBe(0);
    expect(month.wagesPaid).toBeCloseTo(created * wageRate, 2);
    expect(month.jobsAddedCumulative).toBe(created);
    expect(month.personMonthsCumulative).toBe(created);
    expect(month.jobsOutstanding).toBe(created);
    expect(policy.spent).toBeCloseTo(month.wagesPaid, 2);

    // 第 2 月：没有新增岗位，但在岗人数仍计入“人次”，不得累加成新增人数。
    world.time.tick = startTick + 1;
    reconcileLabor(world, DEMO_CONFIG, []);
    settlePolicies(world, DEMO_CONFIG, { hiresByCompany: {}, log: [] });
    stats = publicJobsStats(world, city.id);
    month = stats.latest!;
    expect(month.tick).toBe(startTick + 1);
    expect(month.jobsAdded).toBe(0);
    expect(month.headcount).toBe(created);
    expect(month.jobsAddedCumulative).toBe(created);
    expect(month.personMonthsCumulative).toBe(created * 2);
    expect(month.personMonthsCumulative).toBeGreaterThan(month.jobsAddedCumulative);
    expect(month.wagesPaidCumulative).toBeCloseTo(created * wageRate * 2, 2);

    // 到期撤岗：撤销岗位单列，jobsOutstanding 归零；在岗人次保留历史。
    policy.monthsRemaining = 1;
    world.time.tick = startTick + 2;
    reconcileLabor(world, DEMO_CONFIG, []);
    settlePolicies(world, DEMO_CONFIG, { hiresByCompany: {}, log: [] });
    expect(activePolicy(world, city.id, 'publicJobs')).toBeUndefined();
    stats = publicJobsStats(world, city.id);
    month = stats.latest!;
    expect(month.tick).toBe(startTick + 2);
    expect(month.jobsRemoved).toBe(created);
    expect(month.jobsRemovedCumulative).toBe(created);
    expect(month.jobsOutstanding).toBe(0);
    expect(month.headcount).toBe(created); // 撤岗当月仍在岗（已按实付工资归属）
    expect(month.personMonthsCumulative).toBe(created * 3);
    expect(month.wagesPaidCumulative).toBeCloseTo(created * wageRate * 3, 2);
    expect(month.note).toContain('人次');
    expect(stats.jobsAddedCumulative).toBe(created);
    expect(stats.personMonthsCumulative).toBe(created * 3);
    expect(stats.currentJobs).toBe(jobsBefore);
    expect(checkInvariants(world)).toEqual([]);
  });

  it('报告数据源覆盖 active 与 completed：真实岗位不再是 0，历史政策也可追溯', () => {
    const world = richWorld();
    const city = cityOf(world, 'ironvale');
    const startTick = world.time.tick;
    expect(startPolicy(world, city.id, 'publicJobs', DEMO_CONFIG).ok).toBe(true);
    const policy = activePolicy(world, city.id, 'publicJobs')!;
    const created = policy.effects.jobsCreated!;
    reconcileLabor(world, DEMO_CONFIG, []);
    settlePolicies(world, DEMO_CONFIG, { hiresByCompany: {}, log: [] });
    // 设立月执行记录：真实就业效果 > 0（旧实现固定写 0 → 报告“真实岗位”显示 0）。
    const creationRun = policy.tracking!.runs.at(-1)!;
    expect(creationRun.jobsEffect).toBeGreaterThan(0);
    expect(creationRun.beneficiaries).toBeGreaterThan(0);

    // 到期后政策进入 history：报告聚合必须同时看 active + history。
    policy.monthsRemaining = 1;
    world.time.tick = startTick + 1;
    reconcileLabor(world, DEMO_CONFIG, []);
    settlePolicies(world, DEMO_CONFIG, { hiresByCompany: {}, log: [] });
    expect(activePolicy(world, city.id, 'publicJobs')).toBeUndefined();
    const archived = world.policies.history.find(
      (entry) => entry.cityId === city.id && entry.policyId === 'publicJobs',
    )!;
    expect(archived).toBeTruthy();
    expect(archived.endedTick).toBe(startTick + 1);
    const removalRun = archived.tracking!.runs.at(-1)!;
    expect(removalRun.jobsEffect).toBeLessThan(0); // 撤岗是负的净就业效果，不是新增
    const allRuns = [...world.policies.active, ...world.policies.history]
      .filter((entry) => entry.cityId === city.id && entry.policyId === 'publicJobs')
      .flatMap((entry) => entry.tracking?.runs ?? []);
    expect(allRuns.length).toBeGreaterThanOrEqual(2);
    // 持久化统计不依赖 active 列表：完成/取消后仍能读到真实新增岗位与实付工资。
    const stats = publicJobsStats(world, city.id);
    expect(stats.latest!.jobsAddedCumulative).toBe(created);
    expect(stats.latest!.jobsRemovedCumulative).toBe(created);
    expect(stats.latest!.wagesPaidCumulative).toBeGreaterThan(0);
    expect(stats.currentJobs).toBe(activePolicy(world, city.id, 'publicJobs')?.effects.jobs ?? stats.currentJobs);
    expect(checkInvariants(world)).toEqual([]);
  });

  it('公共工资按真实支付记录归属：不超过 fiscal.publicWages 实付额，不重复扣财政', () => {
    const world = richWorld();
    const city = cityOf(world, 'lanport');
    primeCheckups(world, city, 0.9, 3);
    neutralizeAndCreateFundingGap(world, city);
    world.time.tick += 1;
    setUnemploymentRate(city, 0.9);
    // 失业救助先占一个政策位（手动立项，不是 AI 危机标记）；AI 危机排序下一个候选是公共岗位。
    expect(startPolicy(world, city.id, 'unemploymentAid', DEMO_CONFIG).ok).toBe(true);
    city.treasury = 0;
    autoSelectPolicies(world, DEMO_CONFIG, []);
    const policy = activePolicy(world, city.id, 'publicJobs')!;
    expect(policy.effects.aiCrisisPolicy).toBe(1);

    reconcileLabor(world, DEMO_CONFIG, []);
    const tick = world.time.tick;
    const ledgerBefore = world.fiscal.ledger.length;
    settleGovernment(world, emptyFinance(), DEMO_CONFIG, []);
    const publicWageEntry = world.fiscal.ledger
      .slice(ledgerBefore)
      .find((entry) => entry.cityId === city.id && entry.kind === 'publicWages')!;
    expect(publicWageEntry).toBeTruthy();
    const realPublicWages = round2(-publicWageEntry.amount);

    city.treasury = 0;
    preparePolicyFunding(world, DEMO_CONFIG, [], { hiresByCompany: {} });
    settlePolicies(world, DEMO_CONFIG, { hiresByCompany: {}, log: [] });
    const trace = traceOf(world, city.id, tick);
    const attributed = policy.effects.publicWagePaidThisMonth!;
    const realAttributed = publicJobsStats(world, city.id).latest!.wagesPaid;

    expect(attributed).toBeGreaterThan(0);
    expect(realAttributed).toBeGreaterThan(0);
    // 归属 ≤ 真实公共工资总额（不额外造钱、不重复扣工资）。
    expect(attributed).toBeLessThanOrEqual(realPublicWages + 0.01);
    expect(realAttributed).toBeLessThanOrEqual(realPublicWages + 0.01);
    expect(trace.publicWagesAttributed).toBeCloseTo(realAttributed, 2);
    // 政策层没有公共岗位的第二笔 policySpending（工资只在 fiscal.publicWages 出现一次）。
    expect(
      world.fiscal.ledger.filter(
        (entry) =>
          entry.cityId === city.id &&
          entry.tick === tick &&
          entry.kind === 'policySpending' &&
          entry.policyId === 'publicJobs',
      ),
    ).toHaveLength(0);
    expect(trace.spent).toBeCloseTo(attributed, 2);
    expect(trace.spent + trace.unpaid).toBeLessThanOrEqual(
      trace.referenceBudget + (trace.publicWagesOverQuota ?? 0) + 0.01,
    );
  });

  it('真实模拟 9 个月：两项政策同月时合计 = 体检月预算（不再是 2×），三口径闭合', () => {
    const simulation = Simulation.create();
    const world = simulation.state;
    for (let month = 0; month < 9; month += 1) simulation.tick();
    expect(checkInvariants(world)).toEqual([]);
    let tracesChecked = 0;
    let multiPolicyMonths = 0;
    for (const city of world.cities) {
      const traces = (world.policies.fundingMonths ?? []).filter(
        (entry) => entry.cityId === city.id,
      );
      for (const trace of traces) {
        tracesChecked += 1;
        expect(trace.referenceBudget).toBeGreaterThanOrEqual(0);
        expect(trace.spent).toBeGreaterThanOrEqual(0);
        expect(trace.unpaid).toBeGreaterThanOrEqual(0);
        expect(trace.spent).toBeLessThanOrEqual(trace.reserved + 0.01);
        // 分项存在时：合计 = trace.referenceBudget，且 ≤ 当月额度。
        const entries = trace.policyBudgets ?? [];
        if (entries.length > 0) {
          const allocated = round2(
            entries.reduce((sum, entry) => sum + entry.referenceBudget, 0),
          );
          expect(allocated).toBeCloseTo(trace.referenceBudget, 2);
          if (trace.quota !== undefined) {
            expect(trace.referenceBudget).toBeLessThanOrEqual(trace.quota + 0.01);
          }
        }
        if (entries.length >= 2) {
          multiPolicyMonths += 1;
          // 核心回归：多项政策共用同一笔体检月预算，分项合计 = 额度（不是各项整月额度之和）。
          expect(trace.referenceBudget).toBeCloseTo(trace.quota!, 2);
          for (const entry of entries) {
            expect(entry.referenceBudget).toBeGreaterThan(0);
            expect(entry.spent + entry.unpaid).toBeLessThanOrEqual(
              entry.referenceBudget + 0.01,
            );
          }
        }
        expect(trace.spent + trace.unpaid).toBeLessThanOrEqual(
          trace.referenceBudget + (trace.publicWagesOverQuota ?? 0) + 0.01,
        );
      }
      // 公共岗位统计若存在：本月在岗人数与实付工资都必须是真实非负值，且人次与新增分开。
      const stats = publicJobsStats(world, city.id);
      for (const month of stats.months) {
        expect(month.jobsAdded).toBeGreaterThanOrEqual(0);
        expect(month.headcount).toBeGreaterThanOrEqual(0);
        expect(month.jobsRemoved).toBeGreaterThanOrEqual(0);
        expect(month.wagesPaid).toBeGreaterThanOrEqual(0);
        expect(month.personMonthsCumulative).toBeGreaterThanOrEqual(month.jobsAddedCumulative);
        expect(month.jobsOutstanding).toBeGreaterThanOrEqual(0);
      }
    }
    expect(tracesChecked).toBeGreaterThan(0);
    // 真实长跑中确实出现“同城同月两项 AI 危机政策”的月份（旧口径会在这里翻倍）。
    expect(multiPolicyMonths).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------- 坑① 与存档不变量

describe('v1.6 预算口径修正后：坑① 总预算展开与存档 spent≤budget 校验不回归', () => {
  it('政策总预算 = 单月参考预算 ×（剩余月数 + 1），多次结算后 spent ≤ budget', () => {
    const world = richWorld();
    const city = cityOf(world, 'lanport');
    world.time.tick += 1;
    runCityEconomicCheckup(world, city, DEMO_CONFIG);
    // AI 危机路径直接立项（deferFunding）：本月体检额度即为单月参考预算。
    expect(
      startPolicy(world, city.id, 'unemploymentAid', DEMO_CONFIG, {
        budget: 600_000,
        deferFunding: true,
        reason: 'AI 高失业决策：坑①回归',
      }).ok,
    ).toBe(true);
    const policy = activePolicy(world, city.id, 'unemploymentAid')!;
    expect(policy.referenceBudget).toBe(600_000);
    // 坑①：settlePolicies 在启动当月也执行一次，所以总上限按 monthsRemaining + 1 展开。
    expect(policy.budget).toBeCloseTo(
      round2(policy.referenceBudget! * (policy.monthsRemaining + 1)),
      2,
    );

    const startTick = world.time.tick;
    const log: LogEntry[] = [];
    for (let month = 0; month < 3; month += 1) {
      world.time.tick = startTick + month;
      runCityEconomicCheckup(world, city, DEMO_CONFIG);
      checkupOf(world, city.id).budget = 600_000;
      city.treasury = 0;
      preparePolicyFunding(world, DEMO_CONFIG, [], { hiresByCompany: {} });
      settlePolicies(world, DEMO_CONFIG, { hiresByCompany: {}, log });
      expect(policy.spent).toBeLessThanOrEqual(policy.budget + 0.01);
      expect(policy.spent).toBeGreaterThanOrEqual(0);
      // 每月实支 + 未支付不超过本月额度（分项口径）。
      const trace = traceOf(world, city.id, world.time.tick);
      expect(trace.spent + trace.unpaid).toBeLessThanOrEqual(trace.referenceBudget + 0.01);
    }
  });

  it('新字段随存档往返：quota / policyBudgets / publicJobsMonths 不丢，旧档缺省可读', () => {
    const simulation = Simulation.create();
    for (let month = 0; month < 2; month += 1) simulation.tick();
    const world = simulation.state;
    const traces = world.policies.fundingMonths ?? [];
    expect(traces.length).toBeGreaterThan(0);
    const text = serializeSave(world, '2026-01-01T00:00:00.000Z');
    const parsed = parseSave(text);
    expect(parsed.ok, parsed.error).toBe(true);
    const loaded = parsed.world!;
    expect(loaded.policies.fundingMonths ?? []).toEqual(traces);
    expect(loaded.policies.publicJobsMonths ?? []).toEqual(world.policies.publicJobsMonths ?? []);
    expect(serializeSave(loaded, '2026-01-01T00:00:00.000Z')).toBe(text);
    // 旧档删掉可选新字段仍可读（不升 SAVE_FORMAT_VERSION，old fixture 缺省合法）。
    const stripped = JSON.parse(text) as { world: WorldState };
    delete stripped.world.policies.fundingMonths;
    delete stripped.world.policies.publicJobsMonths;
    const oldParsed = parseSave(JSON.stringify(stripped));
    expect(oldParsed.ok, oldParsed.error).toBe(true);
  });

  it('玩家市长边界不变：AI 不代选/不代发/不代借，也不产生政策分配记录', () => {
    const world = richWorld();
    const city = cityOf(world, 'lanport');
    primeCheckups(world, city, 0.9, 3);
    neutralizeAndCreateFundingGap(world, city);
    world.time.tick += 1;
    setUnemploymentRate(city, 0.9);
    world.player.roles.mayorCityId = city.id;
    autoSelectPolicies(world, DEMO_CONFIG, []);
    expect(world.policies.active.filter((policy) => policy.cityId === city.id)).toHaveLength(0);
    city.treasury = 0;
    preparePolicyFunding(world, DEMO_CONFIG, [], { hiresByCompany: {} });
    expect(
      (world.policies.fundingMonths ?? []).filter((entry) => entry.cityId === city.id),
    ).toHaveLength(0);
    expect(
      world.fiscal.ledger.filter(
        (entry) => entry.cityId === city.id && entry.kind === 'governmentLoanProceeds',
      ),
    ).toHaveLength(0);
  });
});
