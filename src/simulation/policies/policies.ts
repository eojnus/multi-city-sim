import type {
  ActionResult,
  ActivePolicy,
  City,
  LogEntry,
  PolicyDomain,
  PolicyExecutionRecord,
  PolicyHistoryEntry,
  PolicyId,
  PolicyTracking,
  SectorId,
  WorldState,
} from '../contracts/types';
import type { DemoConfig } from '../../data/config';
import { clamp, round2 } from '../core/math';
import { POLICY_IDS, policyDefinition, policyDomainLabel, policyName } from './definitions';
import {
  activePoliciesFor,
  activePolicy,
  ensurePolicyState,
  keyIndustryFocus,
  remainingBudget,
} from './query';
import { ensureEconomicCheckups, rankLaborPolicies, unemploymentTierLabel } from './ai-labor';
import { spendTreasury } from '../government/treasury';
import { addWorkforceSkill, recordTraining } from '../labor/workforce';
import { cityPolitics, cityWeaknesses, incumbencySummary, leaderOf, playerIsMayor } from '../politics/politics';
import { syncCityPopulationFromAllocations } from '../population/population';
import { startCorridorUpgrade, startIntracityUpgrade } from '../transport/network';

/**
 * 政策执行器。
 *
 * 所有政策共用同一套约束：
 * 1. 有明确的城市与目标主体；
 * 2. 预算来自城市财政，实际支出逐笔记入财政流水，不超过可用余额；
 * 3. 每月产生至少一项进入经济/人口/企业状态的真实变化；
 * 4. 非玩家政府按城市弱项 + 领导人倾向选择；玩家市长时绝不自动选择。
 *
 * 金额、期限、系数均为【暂定演示方案】，集中在 data/config.ts。
 */

export interface PolicyContext {
  /** 本月各企业实际新增雇员（由劳动力匹配返回）。 */
  hiresByCompany: Record<string, number>;
  log: LogEntry[];
}

function policyBudget(policyId: PolicyId, config: DemoConfig, requested?: number): number {
  const fallback = config.policies.budgets[policyId];
  return round2(Math.max(0, requested ?? fallback));
}

function defaultTargetSector(world: WorldState, city: City, config: DemoConfig): SectorId {
  const sectors = world.companies
    .filter((company) => company.cityId === city.id)
    .map((company) => company.sector)
    .sort((a, b) => a.localeCompare(b));
  if (sectors.length === 0) return 'food';
  const leader = leaderOf(world, city.id);
  const affinity = leader?.profile.sectorAffinity ?? null;
  if (affinity && sectors.includes(affinity)) return affinity;
  void config;
  return sectors[0]!;
}

function cooldownLeft(
  world: WorldState,
  cityId: string,
  policyId: PolicyId,
  config: DemoConfig,
): number {
  const runs = world.policies.lastRuns
    .filter((entry) => entry.cityId === cityId && entry.policyId === policyId)
    .map((entry) => entry.tick);
  if (runs.length === 0) return 0;
  const last = Math.max(...runs);
  return Math.max(0, config.policies.cooldownMonths - (world.time.tick - last));
}

/** 从政策预算中支付并记入财政流水；返回实际支付额。 */
export function payFromPolicy(
  world: WorldState,
  policy: ActivePolicy,
  requested: number,
  source: string,
  config: DemoConfig,
  companyId?: string,
): number {
  const available = Math.min(remainingBudget(policy), requested);
  if (available <= 0) return 0;
  const city = world.cities.find((entry) => entry.id === policy.cityId);
  if (!city) return 0;
  const paid = spendTreasury(
    world,
    city,
    available,
    'policySpending',
    `${policyName(policy.policyId)}：${source}`,
    { policyId: policy.policyId, companyId },
    config,
  );
  if (paid <= 0) return 0;
  policy.spent = round2(policy.spent + paid);
  city.lastMonth.policySpending = round2(city.lastMonth.policySpending + paid);
  return paid;
}

/** 已存在同一政策的生效记录？ */
function hasActive(world: WorldState, cityId: string, policyId: PolicyId): boolean {
  return Boolean(activePolicy(world, cityId, policyId));
}

export function canStartPolicy(
  world: WorldState,
  cityId: string,
  policyId: PolicyId,
  config: DemoConfig,
  budget?: number,
): { ok: boolean; error?: string; budget: number } {
  const city = world.cities.find((entry) => entry.id === cityId);
  if (!city) return { ok: false, error: '城市不存在', budget: 0 };
  if (!POLICY_IDS.includes(policyId)) return { ok: false, error: `未知政策 ${policyId}`, budget: 0 };
  if (hasActive(world, cityId, policyId)) {
    return { ok: false, error: `该城市已有正在执行的${policyName(policyId)}`, budget: 0 };
  }
  const cooldown = cooldownLeft(world, cityId, policyId, config);
  if (cooldown > 0) {
    return { ok: false, error: `${policyName(policyId)} 冷却中，还需 ${cooldown} 个月`, budget: 0 };
  }
  if (policyId !== 'taxAdjustment' && policyId !== 'transportInvestment') {
    const activeCount = activePoliciesFor(world, cityId).filter(
      (policy) => policy.policyId !== 'taxAdjustment' && policy.policyId !== 'transportInvestment',
    ).length;
    if (activeCount >= config.policies.maxActivePerCity) {
      return { ok: false, error: `该城市同时执行的政策已达上限（${config.policies.maxActivePerCity} 项）`, budget: 0 };
    }
  }
  const requested = policyBudget(policyId, config, budget);
  if (policyDefinition(policyId).spendsTreasury && policyId !== 'transportInvestment') {
    if (requested < config.policies.minBudget) {
      return { ok: false, error: `预算低于最低额 ${config.policies.minBudget.toLocaleString('zh-CN')}`, budget: 0 };
    }
    if (city.treasury + 1e-6 < requested) {
      // v0.7 泄漏审计 #9：非市长不得看到精确财政余额与预算，只给定性提示。
      return { ok: false, error: '该政策当前无法执行：城市财政资金不足', budget: requested };
    }
  }
  return { ok: true, budget: requested };
}

function recordRun(world: WorldState, cityId: string, policyId: PolicyId): void {
  world.policies.lastRuns.push({ cityId, policyId, tick: world.time.tick });
  if (world.policies.lastRuns.length > 400) {
    world.policies.lastRuns.splice(0, world.policies.lastRuns.length - 400);
  }
}

function closePolicy(world: WorldState, policy: ActivePolicy, tick: number, status: PolicyHistoryEntry['status']): void {
  policy.status = status;
  const history: PolicyHistoryEntry = { ...policy, endedTick: tick };
  world.policies.history.push(history);
  if (world.policies.history.length > 200) {
    world.policies.history.splice(0, world.policies.history.length - 200);
  }
  world.policies.active = world.policies.active.filter((entry) => entry.id !== policy.id);
}

// ---------------------------------------------------------------- v1.4 §五：执行追踪

const TRACKING_RUN_LIMIT = 24;

function ensureTracking(policy: ActivePolicy): PolicyTracking {
  policy.tracking ??= { runs: [] };
  policy.tracking.runs ??= [];
  return policy.tracking;
}

/** 记录一次真实执行（原因/资金来源/周期/支出/受益/就业效果/财政影响）。 */
function recordExecution(policy: ActivePolicy, record: PolicyExecutionRecord): void {
  const tracking = ensureTracking(policy);
  tracking.runs.push(record);
  if (tracking.runs.length > TRACKING_RUN_LIMIT) {
    tracking.runs.splice(0, tracking.runs.length - TRACKING_RUN_LIMIT);
  }
}

/**
 * 公共工程到期/取消：撤回岗位，并同步撤回真实在岗人员。
 *
 * 岗位是一次性设立的，工资由财政“公共工资”科目按月真实支付（fiscal.ts），
 * 因此到期必须撤岗，不能无限期占用财政工资；预算预留额与实付额分账记录。
 *
 * v1.4 不变量修复：只减 jobs 会把已填满的岗位留在 employees 上（employees > jobs），
 * 要等到下月劳动力结算才自愈。这里按“实际在岗数不超过撤岗后岗位数”同步撤人，
 * 并把被撤岗的真实在岗人员放回失业人口（P = E + U + N 与“雇主员工合计 = 就业人口”立即成立）。
 * 工资仍由 fiscal.ts 的公共工资科目按月实付，撤岗本身不产生任何扣费。
 */
function releasePublicWorksJobs(world: WorldState, policy: ActivePolicy): number {
  if (policy.policyId !== 'publicJobs') return 0;
  const city = world.cities.find((entry) => entry.id === policy.cityId);
  const jobs = Math.max(0, Math.round(policy.tracking?.publicWorksJobs ?? policy.effects.jobsCreated ?? 0));
  if (!city || jobs <= 0) return 0;
  const jobsBefore = Math.max(0, Math.round(city.publicSector.jobs));
  const employeesBefore = Math.max(0, Math.round(city.publicSector.employees));
  const removed = Math.min(jobs, jobsBefore);
  city.publicSector.jobs = Math.max(0, jobsBefore - removed);
  // 撤岗后公共部门人数不得超过岗位数；多出来的真实在岗人员回到失业人口。
  const employeesAfter = Math.max(0, Math.min(employeesBefore, city.publicSector.jobs));
  city.publicSector.employees = employeesAfter;
  const releasedEmployees = Math.max(0, employeesBefore - employeesAfter);
  if (releasedEmployees > 0) {
    syncCityPopulationFromAllocations(city, world);
  }
  // tracking 中保留设立岗位数/启动时在岗人数/工资来源，供事后核对预留 vs 实付 vs 财政账本。
  policy.effects.jobsRemoved = removed;
  if (releasedEmployees > 0) policy.effects.employeesRemoved = releasedEmployees;
  return removed;
}

/** 政策是否连续多个月有支出却没有任何受益/就业效果（用于停止低效政策）。 */
function policyIneffective(policy: ActivePolicy, config: DemoConfig): boolean {
  // 只对“以就业/收入为目标”的政策做低效停止；研发/教育/住房等长期投入不计入。
  const employmentTargeted: PolicyId[] = [
    'hiringSubsidy',
    'retentionSubsidy',
    'vocationalTraining',
    'publicJobs',
    'unemploymentAid',
    'companyRelief',
    'keyIndustrySupport',
    'startupSupport',
  ];
  if (!employmentTargeted.includes(policy.policyId)) return false;
  const tracking = policy.tracking;
  if (!tracking || tracking.runs.length === 0) return false;
  const months = Math.max(1, Math.round(config.policies.aiLabor.ineffectiveStopMonths));
  const recent = tracking.runs.slice(-months);
  if (recent.length < months) return false;
  return recent.every((run) => run.spent > 0 && run.beneficiaries <= 0 && run.jobsEffect <= 0);
}

function nextPolicyId(world: WorldState): string {
  return `policy-${world.time.tick}-${world.policies.active.length + world.policies.history.length + 1}-${
    world.policies.lastRuns.length
  }`;
}

function applyTaxChange(
  world: WorldState,
  city: City,
  direction: 'cut' | 'raise',
  config: DemoConfig,
  log: LogEntry[],
): { incomeDelta: number; corporateDelta: number } {
  const step = config.policies.tax.adjustStep;
  const previousIncome = city.incomeTaxRate;
  const previousCorporate = city.corporateTaxRate;
  if (direction === 'raise') {
    city.incomeTaxRate = round2(clamp(previousIncome + step, config.policies.tax.minIncomeTax, config.policies.tax.maxIncomeTax));
    city.corporateTaxRate = round2(
      clamp(previousCorporate + step, config.policies.tax.minCorporateTax, config.policies.tax.maxCorporateTax),
    );
  } else {
    city.incomeTaxRate = round2(clamp(previousIncome - step, config.policies.tax.minIncomeTax, config.policies.tax.maxIncomeTax));
    city.corporateTaxRate = round2(
      clamp(previousCorporate - step, config.policies.tax.minCorporateTax, config.policies.tax.maxCorporateTax),
    );
  }
  const incomeDelta = round2(city.incomeTaxRate - previousIncome);
  const corporateDelta = round2(city.corporateTaxRate - previousCorporate);
  log.push({
    tick: world.time.tick,
    kind: 'government',
    message: `${city.name} 税收调整（${direction === 'raise' ? '上调' : '下调'}）：个税 ${(previousIncome * 100).toFixed(0)}% → ${(city.incomeTaxRate * 100).toFixed(0)}%，企税 ${(previousCorporate * 100).toFixed(0)}% → ${(city.corporateTaxRate * 100).toFixed(0)}%。`,
  });
  return { incomeDelta, corporateDelta };
}

/**
 * 执行一项政策（玩家市长命令或非玩家政府决定）。
 * taxAdjustment 立即生效；transportInvestment 立即开工；
 * 其余政策进入持续状态，按月执行。
 */
export function startPolicy(
  world: WorldState,
  cityId: string,
  policyId: PolicyId,
  config: DemoConfig,
  options: {
    budget?: number;
    targetSector?: SectorId;
    taxDirection?: 'cut' | 'raise';
    transportTarget?: string;
    reason?: string;
    log?: LogEntry[];
  } = {},
): ActionResult {
  ensurePolicyState(world);
  const city = world.cities.find((entry) => entry.id === cityId);
  if (!city) return { ok: false, error: '城市不存在' };
  const log = options.log ?? [];
  const check = canStartPolicy(world, cityId, policyId, config, options.budget);
  if (!check.ok) return { ok: false, error: check.error };
  const definition = policyDefinition(policyId);
  const reason = options.reason ?? '由玩家选择';

  if (policyId === 'taxAdjustment') {
    const direction = options.taxDirection ?? 'raise';
    const change = applyTaxChange(world, city, direction, config, log);
    const policy: ActivePolicy = {
      id: nextPolicyId(world),
      cityId,
      policyId,
      budget: 0,
      spent: 0,
      monthsRemaining: 0,
      startedTick: world.time.tick,
      status: 'active',
      targetSector: null,
      taxDirection: direction,
      transportTarget: null,
      effects: { incomeRateDelta: change.incomeDelta, corporateRateDelta: change.corporateDelta },
      reason,
      note: definition.effect,
    };
    closePolicy(world, policy, world.time.tick, 'completed');
    recordRun(world, cityId, policyId);
    return {
      ok: true,
      note: `${city.name} ${direction === 'raise' ? '上调' : '下调'}税率：个税 ${(city.incomeTaxRate * 100).toFixed(0)}%，企税 ${(city.corporateTaxRate * 100).toFixed(0)}%。`,
    };
  }

  if (policyId === 'transportInvestment') {
    const target = options.transportTarget ?? 'intracity';
    let result: ActionResult;
    if (target.startsWith('intracity')) {
      const kind = target.endsWith('rail') ? 'rail' : 'road';
      result = startIntracityUpgrade(world, cityId, kind, config, { reason });
    } else {
      const [pairPart, modePart] = target.split(':');
      const [fromId, toId] = (pairPart ?? '').split('|');
      const mode = modePart === 'rail' ? 'rail' : 'road';
      if (!fromId || !toId) return { ok: false, error: '交通投资目标线路无效' };
      result = startCorridorUpgrade(world, fromId, toId, mode, config, { cityId, reason });
    }
    if (!result.ok) return { ok: false, error: result.error };
    const policy: ActivePolicy = {
      id: nextPolicyId(world),
      cityId,
      policyId,
      budget: result.amount ?? 0,
      spent: result.amount ?? 0,
      monthsRemaining: 0,
      startedTick: world.time.tick,
      status: 'active',
      targetSector: null,
      taxDirection: null,
      transportTarget: target,
      effects: { invested: result.amount ?? 0 },
      reason,
      note: result.note ?? definition.effect,
    };
    closePolicy(world, policy, world.time.tick, 'completed');
    recordRun(world, cityId, policyId);
    return { ok: true, note: result.note, amount: result.amount };
  }

  const budget = check.budget;
  const policy: ActivePolicy = {
    id: nextPolicyId(world),
    cityId,
    policyId,
    budget,
    spent: 0,
    // 公共工程有明确期限（aiLabor.publicWorksMonths），到期必须撤岗；其余政策沿用默认期限。
    monthsRemaining:
      policyId === 'publicJobs'
        ? Math.max(1, Math.round(config.policies.aiLabor.publicWorksMonths))
        : config.policies.defaultDurationMonths,
    startedTick: world.time.tick,
    status: 'active',
    targetSector: policyId === 'keyIndustrySupport' ? options.targetSector ?? defaultTargetSector(world, city, config) : null,
    taxDirection: null,
    transportTarget: null,
    effects: policyId === 'keyIndustrySupport' ? { productivityBonus: config.policies.keyIndustry.productivityBonus } : {},
    reason,
    note: definition.effect,
  };

  // 招聘补贴：启动时就把各城企业当前在岗人数记为基线（只增不减）。
  // 若只依赖首次结算时的惰性初始化，政策启动到首次结算之间发生的真实入职会被算进基线，
  // 首月真实净新增岗位就拿不到补贴（v1.4 §五 修复点）。
  if (policyId === 'hiringSubsidy') {
    const tracking = ensureTracking(policy);
    tracking.hiringBaseline ??= {};
    tracking.subsidisedJobs ??= {};
    for (const company of world.companies
      .filter((entry) => entry.cityId === city.id)
      .sort((a, b) => a.id.localeCompare(b.id))) {
      tracking.hiringBaseline[company.id] = Math.max(0, Math.round(company.employees));
    }
  }

  // 公共岗位：立即设立岗位，但**不预扣财政**——工资由 fiscal.ts 的公共工资科目按月真实支付。
  // 这里只记录“预算预留额”（上限），并在 tracking 中记录岗位数、启动时在岗人数与资金来源，
  // 供月度核对“预留 vs 实付 vs 财政账本”，避免预扣与实付重复扣费或资金消失。
  if (policyId === 'publicJobs') {
    const wageMonths = Math.max(1, config.policies.publicJobs.wageMonthsReserved);
    const perJobCost = Math.max(1, city.publicSector.wageRate * wageMonths);
    const affordableJobs = Math.floor(budget / perJobCost);
    const jobsToAdd = Math.min(affordableJobs, Math.max(0, city.population.unemployed));
    if (jobsToAdd <= 0) return { ok: false, error: '预算不足以设立公共岗位，或没有失业居民' };
    city.publicSector.jobs += jobsToAdd;
    const reservedWages = round2(jobsToAdd * perJobCost);
    policy.budget = round2(Math.max(reservedWages, 0));
    policy.effects.jobsCreated = jobsToAdd;
    policy.effects.reservedWages = reservedWages;
    const tracking = ensureTracking(policy);
    tracking.publicWorksJobs = jobsToAdd;
    tracking.publicWorksBaselineEmployees = city.publicSector.employees;
    tracking.publicWorksWageRate = city.publicSector.wageRate;
    tracking.publicWorksFunding = '城市财政公共工资科目（fiscal.ts publicWages，按月实付）';
    policy.note = `${policy.note} 本项已设立 ${jobsToAdd} 个公共岗位，期限 ${policy.monthsRemaining} 个月；预留 ${wageMonths} 个月工资 ${reservedWages.toFixed(0)}，不预扣财政，工资按月由公共工资科目实付，到期撤岗。`;
    log.push({
      tick: world.time.tick,
      kind: 'government',
      // 岗位数与预留工资属市长财政口径。
      visibility: { scope: 'mayor', cityId: city.id },
      message: `${city.name} 公共岗位计划：设立 ${jobsToAdd} 个岗位（期限 ${policy.monthsRemaining} 个月），预留工资 ${reservedWages.toFixed(0)}，由公共工资科目按月实付。`,
    });
  }

  world.policies.active.push(policy);
  recordRun(world, cityId, policyId);
  log.push({
    tick: world.time.tick,
    kind: 'government',
    message: `${city.name} 启动${definition.name}，预算 ${budget.toFixed(0)}，期限 ${policy.monthsRemaining} 个月（${reason}）。`,
  });
  return { ok: true, note: `${definition.name} 已启动。`, amount: budget };
}

export function cancelPolicy(world: WorldState, cityId: string, policyId: PolicyId): ActionResult {
  const policy = activePolicy(world, cityId, policyId);
  if (!policy) return { ok: false, error: '该政策未在执行' };
  // 公共工程取消时立即撤岗（工资随岗位真实退出，避免继续占用财政公共工资）。
  const releasedJobs = releasePublicWorksJobs(world, policy);
  closePolicy(world, policy, world.time.tick, 'cancelled');
  return {
    ok: true,
    note: releasedJobs > 0
      ? `${policyName(policyId)} 已停止；撤回公共岗位 ${releasedJobs} 个，未使用预算不再支出。`
      : `${policyName(policyId)} 已停止；未使用预算不再支出。`,
  };
}

/**
 * 月度政策执行。调用顺序：在劳动力匹配之后、企业财务之前，
 * 使补贴、培训、救助等在同一结算月内影响实际状态。
 */
export function settlePolicies(
  world: WorldState,
  config: DemoConfig,
  context: PolicyContext,
): void {
  ensurePolicyState(world);
  const log = context.log;
  for (const city of [...world.cities].sort((a, b) => a.id.localeCompare(b.id))) {
    for (const policy of activePoliciesFor(world, city.id)) {
      const definition = policyDefinition(policy.policyId);
      const spentBefore = policy.spent;
      let execution: PolicyExecutionRecord | null = null;
      switch (policy.policyId) {
        case 'hiringSubsidy': {
          // v1.4 §五：只按“真实净新增岗位”发放。
          // hiringBaseline 记录政策启动时的在岗人数（只增不减）：先裁后招只会补回基线，
          // 不会再次领取补贴；subsidisedJobs 记录已补贴人次，防止重复领取。
          let hires = 0;
          const tracking = ensureTracking(policy);
          tracking.hiringBaseline ??= {};
          tracking.subsidisedJobs ??= {};
          const companies = world.companies
            .filter((company) => company.cityId === city.id)
            .sort((a, b) => a.id.localeCompare(b.id));
          for (const company of companies) {
            const newHires = Math.max(0, Math.round(context.hiresByCompany[company.id] ?? 0));
            // 基线只在政策启动（或该企业首次进入政策视野）时确定，之后不随在岗人数上调：
            // 否则首月真实入职会被并进基线，净新增恒为 0（v1.4 §五 修复点）。
            const baseline = tracking.hiringBaseline[company.id] ?? company.employees;
            tracking.hiringBaseline[company.id] = baseline;
            const alreadySubsidised = Math.max(0, Math.round(tracking.subsidisedJobs[company.id] ?? 0));
            const netNew = Math.max(0, company.employees - baseline - alreadySubsidised);
            const eligible = Math.min(newHires, netNew);
            if (eligible <= 0) continue;
            const perHire = round2(
              company.wageRate * config.policies.hiring.subsidyRate * leaderScale(world, city.id, 'employment', config),
            );
            if (perHire <= 0) continue;
            const affordableHires = Math.min(eligible, Math.floor(remainingBudget(policy) / perHire));
            if (affordableHires <= 0) break;
            const paid = payFromPolicy(
              world,
              policy,
              perHire * affordableHires,
              `${company.name} 新增 ${affordableHires} 人招聘补贴`,
              config,
              company.id,
            );
            if (paid <= 0) break;
            company.cash = round2(company.cash + paid);
            const covered = Math.min(affordableHires, Math.floor(paid / perHire));
            hires += covered;
            tracking.subsidisedJobs[company.id] = alreadySubsidised + covered;
            policy.effects.hiresSubsidised = round2((policy.effects.hiresSubsidised ?? 0) + covered);
            policy.effects.paid = round2((policy.effects.paid ?? 0) + paid);
          }
          execution = {
            tick: world.time.tick,
            reason: '按真实净新增岗位发放招聘补贴（先裁后招不重复领取）',
            fundingSource: 'city.treasury/policySpending',
            periodMonths: 1,
            spent: round2(policy.spent - spentBefore),
            beneficiaries: hires,
            jobsEffect: hires,
            fiscalImpact: round2(-(policy.spent - spentBefore)),
            note: '补贴只覆盖真实新增并维持的岗位；未新增不发放。',
          };
          if (hires > 0) {
            log.push({
              tick: world.time.tick,
              kind: 'labor',
              message: `${city.name} 新增招聘补贴：${hires} 名新员工获得补贴，支出 ${(policy.effects.paid ?? 0).toFixed(0)}。`,
            });
          }
          break;
        }
        case 'retentionSubsidy': {
          let total = 0;
          let employees = 0;
          for (const company of world.companies
            .filter((company) => company.cityId === city.id && company.employees > 0)
            .sort((a, b) => a.id.localeCompare(b.id))) {
            const perEmployee = round2(
              company.wageRate * config.policies.retention.subsidyRate * leaderScale(world, city.id, 'employment', config),
            );
            const paid = payFromPolicy(
              world,
              policy,
              perEmployee * company.employees,
              `${company.name} 稳岗补贴`,
              config,
              company.id,
            );
            if (paid <= 0) break;
            company.cash = round2(company.cash + paid);
            total = round2(total + paid);
            employees += Math.floor(paid / Math.max(0.01, perEmployee));
          }
          policy.effects.paid = round2((policy.effects.paid ?? 0) + total);
          policy.effects.employeesRetained = employees;
          execution = {
            tick: world.time.tick,
            reason: '补贴在岗岗位以稳定就业（不降薪、不替代真实岗位）',
            fundingSource: 'city.treasury/policySpending',
            periodMonths: 1,
            spent: round2(policy.spent - spentBefore),
            beneficiaries: employees,
            jobsEffect: 0,
            fiscalImpact: round2(-(policy.spent - spentBefore)),
            note: '稳岗补贴只补贴真实在岗人数，不虚构岗位。',
          };
          if (total > 0) {
            log.push({
              tick: world.time.tick,
              kind: 'labor',
              message: `${city.name} 稳岗补贴：${employees} 个在岗岗位获得补贴，支出 ${total.toFixed(0)}。`,
            });
          }
          break;
        }
        case 'vocationalTraining': {
          const perTrainee = config.policies.training.costPerTrainee;
          const budgetThisMonth = Math.min(
            remainingBudget(policy),
            Math.max(config.policies.minBudget, policy.budget / Math.max(1, policy.monthsRemaining)),
          );
          const trainees = Math.min(
            city.population.unemployed,
            Math.floor(budgetThisMonth / Math.max(1, perTrainee)),
          );
          if (trainees <= 0) break;
          const paid = payFromPolicy(world, policy, trainees * perTrainee, `${trainees} 名失业居民职业培训`, config);
          if (paid <= 0) break;
          const actualTrainees = Math.floor(paid / Math.max(1, perTrainee));
          recordTraining(city, actualTrainees);
          const gain = Math.min(
            config.policies.training.maxSkillGainPerMonth,
            actualTrainees * config.policies.training.skillGainPerTrainee,
          );
          addWorkforceSkill(city, gain);
          policy.effects.trained = round2((policy.effects.trained ?? 0) + actualTrainees);
          policy.effects.skillGain = Math.round(((policy.effects.skillGain ?? 0) + gain) * 1_000_000) / 1_000_000;
          policy.effects.paid = round2((policy.effects.paid ?? 0) + paid);
          execution = {
            tick: world.time.tick,
            reason: '结构性失业：有真实岗位空缺且技能不匹配时培训',
            fundingSource: 'city.treasury/policySpending',
            periodMonths: 1,
            spent: round2(policy.spent - spentBefore),
            beneficiaries: actualTrainees,
            // 培训只提升技能，不虚构就业；就业效果由后续真实招聘产生。
            jobsEffect: 0,
            fiscalImpact: round2(-(policy.spent - spentBefore)),
            note: '培训不是就业；只有后续被真实岗位录用才计入就业。',
          };
          log.push({
            tick: world.time.tick,
            kind: 'labor',
            message: `${city.name} 职业培训：${actualTrainees} 人结训，技能水平 ${(city.workforce.skillLevel * 100).toFixed(1)}%。`,
          });
          break;
        }
        case 'companyRelief': {
          const distressed = world.companies
            .filter(
              (company) =>
                company.cityId === city.id &&
                company.ai.lossMonths >= 1 &&
                company.cash < Math.max(1, company.employees * company.wageRate),
            )
            .sort((a, b) => a.cash - b.cash || a.id.localeCompare(b.id))
            .slice(0, config.policies.relief.maxCompanies);
          let paidTotal = 0;
          for (const company of distressed) {
            const need = round2(Math.max(0, company.employees * company.wageRate * config.policies.relief.wageMonths));
            const paid = payFromPolicy(world, policy, need, `${company.name} 企业纾困`, config, company.id);
            if (paid <= 0) break;
            company.cash = round2(company.cash + paid);
            paidTotal = round2(paidTotal + paid);
          }
          policy.effects.companiesHelped = distressed.length;
          policy.effects.paid = round2((policy.effects.paid ?? 0) + paidTotal);
          execution = {
            tick: world.time.tick,
            reason: '亏损且现金不足的企业纾困（只按真实工资缺口拨付）',
            fundingSource: 'city.treasury/policySpending',
            periodMonths: 1,
            spent: round2(policy.spent - spentBefore),
            beneficiaries: distressed.length,
            jobsEffect: 0,
            fiscalImpact: round2(-(policy.spent - spentBefore)),
            note: '纾困资金进入企业现金，不直接创造岗位。',
          };
          if (paidTotal > 0) {
            log.push({
              tick: world.time.tick,
              kind: 'government',
              message: `${city.name} 企业纾困：${distressed.length} 家企业获得 ${paidTotal.toFixed(0)} 财政支持。`,
            });
          }
          break;
        }
        case 'keyIndustrySupport': {
          const focus = policy.targetSector;
          if (!focus) break;
          const companies = world.companies
            .filter((company) => company.cityId === city.id && company.sector === focus)
            .sort((a, b) => a.id.localeCompare(b.id));
          if (companies.length === 0) break;
          const monthly = Math.min(
            remainingBudget(policy),
            Math.max(config.policies.minBudget, policy.budget / Math.max(1, policy.monthsRemaining)),
          );
          const share = (monthly * config.policies.keyIndustry.grantShare) / companies.length;
          let paidTotal = 0;
          for (const company of companies) {
            const paid = payFromPolicy(world, policy, share, `${company.name} 重点产业扶持`, config, company.id);
            if (paid <= 0) break;
            company.cash = round2(company.cash + paid);
            paidTotal = round2(paidTotal + paid);
          }
          policy.effects.paid = round2((policy.effects.paid ?? 0) + paidTotal);
          policy.effects.companiesSupported = companies.length;
          execution = {
            tick: world.time.tick,
            reason: `重点产业扶持（目标行业 ${focus}）`,
            fundingSource: 'city.treasury/policySpending',
            periodMonths: 1,
            spent: round2(policy.spent - spentBefore),
            beneficiaries: companies.length,
            jobsEffect: 0,
            fiscalImpact: round2(-(policy.spent - spentBefore)),
            note: '拨款进入企业现金；产能/就业效果由真实生产与招聘产生。',
          };
          break;
        }
        case 'researchGrant': {
          const budgetThisMonth = Math.min(
            remainingBudget(policy),
            Math.max(config.policies.minBudget, policy.budget / Math.max(1, policy.monthsRemaining)),
          );
          const points = Math.floor(budgetThisMonth / config.policies.research.costPerPoint);
          if (points <= 0) break;
          const paid = payFromPolicy(
            world,
            policy,
            points * config.policies.research.costPerPoint,
            `研究投入 ${points} 点`,
            config,
          );
          if (paid <= 0) break;
          const actualPoints = Math.floor(paid / config.policies.research.costPerPoint);
          city.technology.researchPoints += actualPoints;
          city.technology.status = 'active';
          const levelGain = Math.floor(
            city.technology.researchPoints / config.policies.research.pointsPerLevel,
          );
          if (levelGain > 0) {
            city.technology.researchPoints -= levelGain * config.policies.research.pointsPerLevel;
            city.technology.level += levelGain;
            city.technology.productivityMultiplier = round2(
              Math.min(
                config.policies.research.maxMultiplier,
                1 + city.technology.level * config.policies.research.productivityPerLevel,
              ),
            );
            log.push({
              tick: world.time.tick,
              kind: 'government',
              message: `${city.name} 科技等级提升到 ${city.technology.level}，生产率 ×${city.technology.productivityMultiplier.toFixed(3)}。`,
            });
          }
          policy.effects.points = round2((policy.effects.points ?? 0) + actualPoints);
          policy.effects.paid = round2((policy.effects.paid ?? 0) + paid);
          execution = {
            tick: world.time.tick,
            reason: '研发投入：按实际支付换取研究点与科技等级',
            fundingSource: 'city.treasury/policySpending',
            periodMonths: 1,
            spent: round2(policy.spent - spentBefore),
            beneficiaries: 0,
            jobsEffect: 0,
            fiscalImpact: round2(-(policy.spent - spentBefore)),
            note: `研究点 +${actualPoints}；科技等级提升由真实研究点累积。`,
          };
          break;
        }
        case 'educationInvestment': {
          const budgetThisMonth = Math.min(
            remainingBudget(policy),
            Math.max(config.policies.minBudget, policy.budget / Math.max(1, policy.monthsRemaining)),
          );
          const paid = payFromPolicy(world, policy, budgetThisMonth, '教育投入', config);
          if (paid <= 0) break;
          const gain = Math.min(
            config.policies.education.maxSkillGainPerMonth,
            paid * config.policies.education.skillGainPerBudget,
          );
          const actualGain = addWorkforceSkill(city, gain);
          policy.effects.skillGain = Math.round(((policy.effects.skillGain ?? 0) + actualGain) * 1_000_000) / 1_000_000;
          policy.effects.paid = round2((policy.effects.paid ?? 0) + paid);
          execution = {
            tick: world.time.tick,
            reason: '教育投入：按实际支付提升劳动力技能',
            fundingSource: 'city.treasury/policySpending',
            periodMonths: 1,
            spent: round2(policy.spent - spentBefore),
            beneficiaries: 0,
            jobsEffect: 0,
            fiscalImpact: round2(-(policy.spent - spentBefore)),
            note: `技能 +${actualGain.toFixed(4)}；不虚构就业。`,
          };
          break;
        }
        case 'unemploymentAid': {
          // v1.4 §五：记录理论需求/预算/受益/实发/未支付；只有实发进入居民收入。
          const people = city.population.unemployed;
          if (people <= 0) break;
          const extra = round2(config.policies.unemploymentAid.extraPerUnemployed * people);
          const paid = payFromPolicy(world, policy, extra, `${people} 名失业居民额外救助`, config);
          if (paid <= 0) break;
          city.householdIncomeLastMonth = round2(city.householdIncomeLastMonth + paid);
          city.lastMonth.benefitsPaid = round2(city.lastMonth.benefitsPaid + paid);
          city.lastMonth.householdIncome = city.householdIncomeLastMonth;
          policy.effects.paid = round2((policy.effects.paid ?? 0) + paid);
          const helped = Math.min(people, Math.floor(paid / Math.max(1, config.policies.unemploymentAid.extraPerUnemployed)));
          policy.effects.peopleHelped = helped;
          execution = {
            tick: world.time.tick,
            reason: '失业救助：有供给但居民买不起时直接补充可支配收入',
            fundingSource: 'city.treasury/policySpending',
            periodMonths: 1,
            spent: paid,
            beneficiaries: helped,
            jobsEffect: 0,
            fiscalImpact: -paid,
            theoreticalNeed: extra,
            paid,
            unpaid: round2(Math.max(0, extra - paid)),
            note: '未支付部分不计入居民收入；救助不替代真实就业。',
          };
          break;
        }
        case 'housingSupport': {
          const budgetThisMonth = Math.min(
            remainingBudget(policy),
            Math.max(config.policies.minBudget, policy.budget / Math.max(1, policy.monthsRemaining)),
          );
          const unitCost = config.policies.housing.unitCost;
          const rentPart = round2(budgetThisMonth * config.policies.housing.rentSubsidyShare);
          const buildPart = round2(budgetThisMonth - rentPart);
          const rentPaid = payFromPolicy(world, policy, rentPart, '住房租金补贴', config);
          const buildPaid = payFromPolicy(world, policy, buildPart, '新住房建设', config);
          if (rentPaid > 0) {
            city.householdIncomeLastMonth = round2(city.householdIncomeLastMonth + rentPaid);
            city.lastMonth.householdIncome = city.householdIncomeLastMonth;
            city.housing.rentSubsidyPaid = round2(city.housing.rentSubsidyPaid + rentPaid);
          }
          if (buildPaid > 0) {
            const units = Math.floor(buildPaid / Math.max(1, unitCost));
            city.housing.units += units;
            city.realEstate.vacancyRate = round2(
              clamp(city.realEstate.vacancyRate - units / Math.max(1, city.population.total) * 6, 0, 0.6),
            );
            city.realEstate.rentIndex = round2(
              Math.max(0.5, city.realEstate.rentIndex - units / Math.max(1, city.housing.demand || 1) * 0.05),
            );
            policy.effects.unitsBuilt = round2((policy.effects.unitsBuilt ?? 0) + units);
          }
          policy.effects.paid = round2((policy.effects.paid ?? 0) + rentPaid + buildPaid);
          execution = {
            tick: world.time.tick,
            reason: '住房支持：租金补贴与真实住房建设',
            fundingSource: 'city.treasury/policySpending',
            periodMonths: 1,
            spent: round2(policy.spent - spentBefore),
            beneficiaries: 0,
            jobsEffect: 0,
            fiscalImpact: round2(-(policy.spent - spentBefore)),
            note: `新建住房 ${policy.effects.unitsBuilt ?? 0} 单元；租金补贴进入居民收入。`,
          };
          log.push({
            tick: world.time.tick,
            kind: 'government',
            message: `${city.name} 住房支持：支出 ${(rentPaid + buildPaid).toFixed(0)}，住房存量 ${city.housing.units}。`,
          });
          break;
        }
        case 'equipmentSubsidy':
        case 'startupSupport':
        case 'intercityTradeSupport': {
          // 这三种政策在对应事件（扩产/创办/跨城结算）发生时支出，见相关模块。
          policy.effects.passiveTick = world.time.tick;
          execution = {
            tick: world.time.tick,
            reason: '事件型政策：只在真实扩产/创办/跨城交易发生时按比例支出',
            fundingSource: 'city.treasury/policySpending（事件发生时）',
            periodMonths: 1,
            spent: round2(policy.spent - spentBefore),
            beneficiaries: 0,
            jobsEffect: 0,
            fiscalImpact: round2(-(policy.spent - spentBefore)),
            note: '本月无对应真实事件时不产生支出。',
          };
          break;
        }
        case 'publicJobs': {
          // v1.4 §五：岗位工资由财政公共工资科目按月真实支付（fiscal.ts publicWages）。
          // 这里不再次扣财政，只核对“实际在岗（扣除启动基线）”并把支出计入政策预算/追踪，
          // 避免预扣 + 实付重复扣费，也避免预留资金“消失”。
          const tracking = ensureTracking(policy);
          const created = Math.max(0, Math.round(tracking.publicWorksJobs ?? policy.effects.jobsCreated ?? 0));
          const baselineEmployees = Math.max(0, Math.round(tracking.publicWorksBaselineEmployees ?? 0));
          const actualEmployees = Math.max(0, city.publicSector.employees - baselineEmployees);
          const funded = Math.min(created, actualEmployees);
          const wageRate = Math.max(0, tracking.publicWorksWageRate ?? city.publicSector.wageRate);
          const monthlyWage = round2(funded * wageRate);
          const spentBeforeThisCase = policy.spent;
          policy.spent = round2(Math.min(policy.budget, policy.spent + monthlyWage));
          const attributed = round2(policy.spent - spentBeforeThisCase);
          policy.effects.jobs = city.publicSector.jobs;
          policy.effects.publicWagePaid = round2((policy.effects.publicWagePaid ?? 0) + attributed);
          policy.effects.publicJobsFilled = funded;
          execution = {
            tick: world.time.tick,
            reason: '公共工程：按真实在岗人数支付公共工资（预算预留、不预扣）',
            fundingSource: tracking.publicWorksFunding ?? 'city.treasury/publicWages',
            periodMonths: 1,
            spent: attributed,
            beneficiaries: funded,
            jobsEffect: 0,
            fiscalImpact: -attributed,
            note: `设立 ${created} 个岗位，实际在岗 ${funded} 人；工资由 fiscal.ts 公共工资科目实付，本记录只做预算归属与核对。`,
          };
          break;
        }
        default:
          break;
      }
      // v1.4 §五：每次执行都留下可追溯记录（含本月无支出的事件型政策）。
      if (!execution) {
        const spentDelta = round2(policy.spent - spentBefore);
        execution = {
          tick: world.time.tick,
          reason: `本月执行${definition.name}`,
          fundingSource: 'city.treasury/policySpending',
          periodMonths: 1,
          spent: spentDelta,
          beneficiaries: 0,
          jobsEffect: 0,
          fiscalImpact: round2(-spentDelta),
          note: '本月无真实支出/受益时按 0 记录。',
        };
      }
      recordExecution(policy, execution);
      if (policy.startedTick < world.time.tick) {
        policy.monthsRemaining -= 1;
        if (policy.monthsRemaining <= 0) {
          // 公共工程到期：撤岗，工资随岗位真实退出。
          const released = releasePublicWorksJobs(world, policy);
          if (released > 0) {
            log.push({
              tick: world.time.tick,
              kind: 'government',
              // 岗位数属市长财政口径。
              visibility: { scope: 'mayor', cityId: city.id },
              message: `${city.name} 公共岗位计划到期：撤回 ${released} 个岗位，财政公共工资相应减少。`,
            });
          }
          closePolicy(world, policy, world.time.tick, 'completed');
          continue;
        }
      }
      // 效果差可调整停止：连续多个月有支出却无受益/无就业效果。
      if (policyIneffective(policy, config)) {
        const released = releasePublicWorksJobs(world, policy);
        closePolicy(world, policy, world.time.tick, 'cancelled');
        log.push({
          tick: world.time.tick,
          kind: 'government',
          message: `${city.name} ${definition.name} 连续 ${
            config.policies.aiLabor.ineffectiveStopMonths
          } 个月有支出但无受益/无就业效果，已停止${released > 0 ? `（撤回岗位 ${released} 个）` : ''}。`,
        });
      }
    }
  }
}

function leaderScale(
  world: WorldState,
  cityId: string,
  domain: PolicyDomain,
  config: DemoConfig,
): number {
  const leader = leaderOf(world, cityId);
  if (!leader) return 1;
  return 1 + config.politics.domainEffectScale * clamp(leader.profile.domainLeanings[domain] ?? 0, 0, 1);
}

/**
 * 非玩家政府选政策：城市弱项 + 领导人领域倾向 + 财政承受力。
 * 玩家市长的城市会被完全跳过（AI 不代选）。
 */
export function autoSelectPolicies(
  world: WorldState,
  config: DemoConfig,
  log: LogEntry[],
): void {
  ensurePolicyState(world);
  for (const city of [...world.cities].sort((a, b) => a.id.localeCompare(b.id))) {
    if (playerIsMayor(world, city.id)) {
      world.policies.lastSelection.unshift({
        tick: world.time.tick,
        cityId: city.id,
        policyId: null,
        reason: '玩家市长：政策由玩家选择，AI 不自动选择。',
      });
      continue;
    }
    // v1.4 §五：先做经济体检，再按失业档位走“对症政策”；正常档位沿用既有弱项打分。
    const checkups = ensureEconomicCheckups(world, config);
    const checkup = checkups.find((entry) => entry.cityId === city.id) ?? null;
    if (checkup && checkup.tier !== 'normal') {
      const candidates = rankLaborPolicies(world, city, checkup, config);
      if (candidates.length === 0) {
        world.policies.lastSelection.unshift({
          tick: world.time.tick,
          cityId: city.id,
          policyId: null,
          reason: `AI 高失业决策：${unemploymentTierLabel(checkup.tier)}（失业率 ${(
            checkup.unemploymentRateAvg3 * 100
          ).toFixed(1)}%），但预算不足或没有可负担的对症政策（${checkup.budgetNote}）`,
        });
        if (world.policies.lastSelection.length > 60) world.policies.lastSelection.splice(60);
        continue;
      }
      let started: PolicyId | null = null;
      let lastError = '';
      for (const candidate of candidates) {
        const result = startPolicy(world, city.id, candidate.policyId, config, {
          budget: candidate.budget,
          reason: `AI 高失业决策：${candidate.reason}`,
          log,
        });
        if (result.ok) {
          started = candidate.policyId;
          log.push({
            tick: world.time.tick,
            kind: 'government',
            // 预算/失业率细节属市长财政口径。
            visibility: { scope: 'mayor', cityId: city.id },
            message: `${city.name} AI 高失业决策：${unemploymentTierLabel(checkup.tier)}（失业率 ${(
              checkup.unemploymentRateAvg3 * 100
            ).toFixed(1)}%，${checkup.symptoms.join('、') || '无明显症状'}）→ 启动${
              policyName(candidate.policyId)
            }，本月预算上限 ${candidate.budget.toFixed(0)}。`,
          });
          break;
        }
        lastError = result.error ?? '';
      }
      world.policies.lastSelection.unshift({
        tick: world.time.tick,
        cityId: city.id,
        policyId: started,
        reason: started
          ? `AI 高失业决策：${unemploymentTierLabel(checkup.tier)}，${candidates.find((entry) => entry.policyId === started)?.reason ?? ''}`
          : `AI 高失业决策未能启动政策：${lastError}`,
      });
      if (world.policies.lastSelection.length > 60) world.policies.lastSelection.splice(60);
      continue;
    }
    const active = activePoliciesFor(world, city.id);
    if (active.length >= config.policies.maxActivePerCity) continue;
    const leader = leaderOf(world, city.id);
    const leanings = leader?.profile.domainLeanings;
    const weaknesses = cityWeaknesses(world, city, config);
    const wageMonths = city.lastMonth.publicWageBill > 0
      ? city.treasury / city.lastMonth.publicWageBill
      : 3;
    const reserve = city.lastMonth.publicWageBill * config.policies.aiReserveWageMonths;
    const available = Math.max(0, city.treasury - reserve);

    type Scored = { policyId: PolicyId; score: number; reason: string; budget: number };
    const scored: Scored[] = [];
    for (const policyId of POLICY_IDS) {
      if (policyId === 'transportInvestment') continue;
      if (policyId === 'taxAdjustment') {
        const direction: 'cut' | 'raise' | null =
          wageMonths < config.policies.tax.aiRaiseMonths
            ? 'raise'
            : wageMonths > config.policies.tax.aiCutMonths
              ? 'cut'
              : null;
        if (!direction) continue;
        const domain = policyDefinition(policyId).domain;
        scored.push({
          policyId,
          score: 0.5 + weaknesses.fiscal + (leanings?.[domain] ?? 0) * 0.4,
          reason: direction === 'raise' ? '财政收入偏低，需要提高税率' : '财政有余，降低税负刺激经济',
          budget: 0,
        });
        continue;
      }
      if (hasActive(world, city.id, policyId)) continue;
      if (cooldownLeft(world, city.id, policyId, config) > 0) continue;
      const definition = policyDefinition(policyId);
      const budget = config.policies.budgets[policyId];
      if (definition.spendsTreasury && available < budget) continue;
      const domain = definition.domain;
      const need = weaknesses[domain] ?? 0;
      const leaning = leanings?.[domain] ?? 0.4;
      let score = need * 1.2 + leaning * 0.7;
      // 事件型加权：企业困难、失业高企、贸易损失等。
      if (policyId === 'intercityTradeSupport') {
        score += world.transport.lastMonth.penaltyRate * 1.2;
      }
      if (policyId === 'hiringSubsidy' || policyId === 'retentionSubsidy') {
        score += weaknesses.employment * 0.5;
      }
      if (policyId === 'startupSupport') {
        score += 0.15 + weaknesses.enterprise * 0.3;
      }
      if (policyId === 'keyIndustrySupport') {
        score += 0.2;
      }
      scored.push({
        policyId,
        score,
        reason: `城市弱项「${policyDomainLabel(domain)}」评分 ${(need * 100).toFixed(0)}，领导人 ${leader?.name ?? '—'}（${leader?.profile.traitLabel ?? '无'}）倾向 ${(leaning * 100).toFixed(0)}`,
        budget,
      });
    }
    scored.sort((a, b) => b.score - a.score || a.policyId.localeCompare(b.policyId));
    const pick = scored[0];
    if (!pick) {
      world.policies.lastSelection.unshift({
        tick: world.time.tick,
        cityId: city.id,
        policyId: null,
        reason: '没有可负担且未在冷却中的政策',
      });
      continue;
    }
    const result = startPolicy(world, city.id, pick.policyId, config, {
      reason: `非玩家政府自动选择：${pick.reason}`,
      log,
    });
    world.policies.lastSelection.unshift({
      tick: world.time.tick,
      cityId: city.id,
      policyId: result.ok ? pick.policyId : null,
      reason: result.ok ? pick.reason : result.error ?? '政策启动失败',
    });
    if (world.policies.lastSelection.length > 60) {
      world.policies.lastSelection.splice(60);
    }
  }
}

/** 供界面/报告：某城政策执行摘要。 */
export function policySummary(world: WorldState, cityId: string): {
  active: ActivePolicy[];
  leader: string;
  lastSelection: string;
} {
  return {
    active: activePoliciesFor(world, cityId),
    leader: incumbencySummary(world, cityId),
    lastSelection: world.policies.lastSelection.find((entry) => entry.cityId === cityId)?.reason ?? '尚未选择政策',
  };
}

/** 设备补助：企业扩产时由政策承担一部分成本。 */
export function equipmentSubsidyPayment(
  world: WorldState,
  city: City,
  cost: number,
  config: DemoConfig,
  companyId: string,
): number {
  const policy = activePolicy(world, city.id, 'equipmentSubsidy');
  if (!policy) return 0;
  return payFromPolicy(
    world,
    policy,
    cost * config.policies.equipment.subsidyRate,
    '设备与扩产补助',
    config,
    companyId,
  );
}

/** 初创扶持：新企业成立时由政策承担的启动资金。 */
export function startupGrantPayment(
  world: WorldState,
  city: City,
  capital: number,
  config: DemoConfig,
  companyId: string,
): number {
  const policy = activePolicy(world, city.id, 'startupSupport');
  if (!policy) return 0;
  return payFromPolicy(
    world,
    policy,
    capital * config.policies.startup.grantRate,
    '初创企业启动资金',
    config,
    companyId,
  );
}

/** 跨城贸易支持：容量损失补偿（由 transport 结算调用）。 */
export function intercityTradeSupportPayment(
  world: WorldState,
  city: City,
  loss: number,
  config: DemoConfig,
  companyId: string,
): number {
  const policy = activePolicy(world, city.id, 'intercityTradeSupport');
  if (!policy) return 0;
  return payFromPolicy(
    world,
    policy,
    loss * config.policies.tradeSupport.reimbursementShare,
    '跨城贸易容量损失补偿',
    config,
    companyId,
  );
}

/** 诊断/测试：某城技能与科技状态。 */
export function cityPolicyOutcomes(world: WorldState, cityId: string) {
  const city = world.cities.find((entry) => entry.id === cityId);
  const politics = cityPolitics(world, cityId);
  const focus = keyIndustryFocus(world, cityId);
  return {
    skillLevel: city?.workforce.skillLevel ?? 0,
    researchLevel: city?.technology.level ?? 0,
    researchPoints: city?.technology.researchPoints ?? 0,
    productivityMultiplier: city?.technology.productivityMultiplier ?? 1,
    housingUnits: city?.housing.units ?? 0,
    publicJobs: city?.publicSector.jobs ?? 0,
    keySector: focus.sector,
    leader: politics?.leader?.name ?? '玩家市长/无',
  };
}
