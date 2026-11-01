import type {
  ActionResult,
  ActivePolicy,
  City,
  LogEntry,
  PolicyDomain,
  PolicyHistoryEntry,
  PolicyId,
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
import { spendTreasury } from '../government/treasury';
import { addWorkforceSkill, recordTraining } from '../labor/workforce';
import { cityPolitics, cityWeaknesses, incumbencySummary, leaderOf, playerIsMayor } from '../politics/politics';
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
      return { ok: false, error: `财政资金不足：可用 ${city.treasury.toFixed(0)}，需要预算 ${requested.toFixed(0)}`, budget: requested };
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
    monthsRemaining: config.policies.defaultDurationMonths,
    startedTick: world.time.tick,
    status: 'active',
    targetSector: policyId === 'keyIndustrySupport' ? options.targetSector ?? defaultTargetSector(world, city, config) : null,
    taxDirection: null,
    transportTarget: null,
    effects: policyId === 'keyIndustrySupport' ? { productivityBonus: config.policies.keyIndustry.productivityBonus } : {},
    reason,
    note: definition.effect,
  };

  // 公共岗位：立即把预算转换为岗位（工资由财政按月支付，见 fiscal.ts）。
  if (policyId === 'publicJobs') {
    const wageMonths = Math.max(1, config.policies.publicJobs.wageMonthsReserved);
    const perJobCost = Math.max(1, city.publicSector.wageRate * wageMonths);
    const affordableJobs = Math.floor(budget / perJobCost);
    const jobsToAdd = Math.min(affordableJobs, Math.max(0, city.population.unemployed));
    if (jobsToAdd <= 0) return { ok: false, error: '预算不足以设立公共岗位，或没有失业居民' };
    city.publicSector.jobs += jobsToAdd;
    payFromPolicy(world, policy, budget, `新增 ${jobsToAdd} 个公共岗位（预留 ${wageMonths} 个月工资）`, config);
    policy.effects.jobsCreated = jobsToAdd;
    policy.note = `${policy.note} 本项已设立 ${jobsToAdd} 个公共岗位（预算 ${budget.toFixed(0)}）。`;
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
  closePolicy(world, policy, world.time.tick, 'cancelled');
  return { ok: true, note: `${policyName(policyId)} 已停止；未使用预算不再支出。` };
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
      switch (policy.policyId) {
        case 'hiringSubsidy': {
          let hires = 0;
          const companies = world.companies
            .filter((company) => company.cityId === city.id)
            .sort((a, b) => a.id.localeCompare(b.id));
          for (const company of companies) {
            const newHires = Math.max(0, Math.round(context.hiresByCompany[company.id] ?? 0));
            if (newHires <= 0) continue;
            const perHire = round2(
              company.wageRate * config.policies.hiring.subsidyRate * leaderScale(world, city.id, 'employment', config),
            );
            if (perHire <= 0) continue;
            const affordableHires = Math.min(newHires, Math.floor(remainingBudget(policy) / perHire));
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
            policy.effects.hiresSubsidised = round2((policy.effects.hiresSubsidised ?? 0) + covered);
            policy.effects.paid = round2((policy.effects.paid ?? 0) + paid);
          }
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
          break;
        }
        case 'unemploymentAid': {
          const people = city.population.unemployed;
          if (people <= 0) break;
          const extra = round2(config.policies.unemploymentAid.extraPerUnemployed * people);
          const paid = payFromPolicy(world, policy, extra, `${people} 名失业居民额外救助`, config);
          if (paid <= 0) break;
          city.householdIncomeLastMonth = round2(city.householdIncomeLastMonth + paid);
          city.lastMonth.benefitsPaid = round2(city.lastMonth.benefitsPaid + paid);
          city.lastMonth.householdIncome = city.householdIncomeLastMonth;
          policy.effects.paid = round2((policy.effects.paid ?? 0) + paid);
          policy.effects.peopleHelped = people;
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
          break;
        }
        case 'publicJobs': {
          // 岗位在一次启动时设立；此后工资由财政常规支出支付。
          policy.effects.jobs = city.publicSector.jobs;
          break;
        }
        default:
          break;
      }
      if (policy.startedTick < world.time.tick) {
        policy.monthsRemaining -= 1;
        if (policy.monthsRemaining <= 0) {
          closePolicy(world, policy, world.time.tick, 'completed');
        }
      }
      void definition;
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
