import type {
  ActionResult,
  ActivePolicy,
  City,
  FiscalEntry,
  LogEntry,
  PolicyDomain,
  PolicyExecutionRecord,
  PolicyFundingMonth,
  PolicyFundingSource,
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
import { borrowForGovernment, computeGovernmentDebtSummary } from '../government/debt';
import { addWorkforceSkill, recordTraining } from '../labor/workforce';
import { cityPolitics, cityWeaknesses, incumbencySummary, leaderOf, playerIsMayor } from '../politics/politics';
import { syncCityPopulationFromAllocations } from '../population/population';
import { allocateMoneyExact } from '../population/household-investment';
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
/**
 * v1.5 §4：把政策转移支付（失业救助 / 住房租金补贴）真实计入居民群体。
 *
 * 背景：settleGovernment 已在 step 15 把工资/福利/股息计入群体；政策支付发生在 step 16，
 * 若只改城市汇总（city.householdIncomeLastMonth / lastMonth.benefitsPaid）而不落地到群体，
 * Σgroup.income 会小于城市居民收入，households.test 的“收入入账闭合”失败，且居民实际购买力
 * 与“受益人数”不一致。这里按人口权重（可选优先失业群体）用最大余数法分摊，保证合计严格等于
 * 实际支付额（不造钱、不重复计）。
 */
function attributePolicyTransferToGroups(
  world: WorldState,
  city: City,
  amount: number,
  preferUnemployed: boolean,
): void {
  const target = round2(Math.max(0, amount));
  if (target <= 0) return;
  const groups = world.households.groups.filter(
    (group) => group.cityId === city.id && group.people > 0,
  );
  if (groups.length === 0) return;
  const weights = groups.map((group) =>
    preferUnemployed && group.occupation !== 'unemployed' ? 0 : group.people,
  );
  const totalWeight = weights.reduce((sum, value) => sum + value, 0);
  const basis = totalWeight > 0 ? weights : groups.map((group) => group.people);
  const shares = allocateMoneyExact(target, basis);
  groups.forEach((group, index) => {
    const share = shares[index] ?? 0;
    if (share <= 0) return;
    group.cash = round2(group.cash + share);
    group.lastMonth.income = round2((group.lastMonth.income ?? 0) + share);
    group.lastMonth.benefits = round2((group.lastMonth.benefits ?? 0) + share);
    group.lastMonth.netCashChange = round2((group.lastMonth.netCashChange ?? 0) + share);
  });
}

export function payFromPolicy(
  world: WorldState,
  policy: ActivePolicy,
  requested: number,
  source: string,
  config: DemoConfig,
  companyId?: string,
): number {
  // v1.5 §4：本月已做资金预留的 AI 政策，实支不得超过“预留 − 本月已支”，
  // 保证 实支 ≤ 预留 ≤ 真实到账资金（预留只来自财政余额与真实到账借款）。
  const fundedThisMonth = policy.effects.reservedTick === world.time.tick;
  const reservedLeft = fundedThisMonth
    ? round2(Math.max(0, (policy.reservedThisMonth ?? 0) - (policy.effects.spentThisMonth ?? 0)))
    : Number.POSITIVE_INFINITY;
  // v1.5 §4 的参考预算/预留是“单月”口径：已预留政策按本月剩余预留封顶，不再叠加总预算扣减。
  const available = fundedThisMonth
    ? Math.min(requested, reservedLeft)
    : Math.min(remainingBudget(policy), requested);
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
  if (fundedThisMonth) {
    policy.effects.spentThisMonth = round2((policy.effects.spentThisMonth ?? 0) + paid);
  }
  city.lastMonth.policySpending = round2(city.lastMonth.policySpending + paid);
  return paid;
}

/**
 * 本月政策可动用的现金上限（只用于执行分配，不产生资金）。
 *
 * - v1.5 §4 已做资金预留的 AI 政策：参考预算/预留是“单月”口径 → 上限 = 本月预留 − 本月已支；
 * - 其他政策：沿用既有口径（总剩余预算，且按月摊分时不超过剩余）。
 */
function policyMonthlyCashLimit(world: WorldState, policy: ActivePolicy, config: DemoConfig): number {
  if (policy.effects.reservedTick === world.time.tick) {
    return round2(Math.max(0, (policy.reservedThisMonth ?? 0) - (policy.effects.spentThisMonth ?? 0)));
  }
  return Math.min(
    remainingBudget(policy),
    Math.max(config.policies.minBudget, policy.budget / Math.max(1, policy.monthsRemaining)),
  );
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
  options: {
    /**
     * v1.5 §4（task-18）：AI 高失业决策允许“先立项、后真实融资”。
     * 跳过“启动时 treasury ≥ budget”检查，但保留 minBudget / 政策数量 / 冷却等全部校验；
     * 同 tick 15b `preparePolicyFunding` 再按既有借款规则真实补足，借不到则如实记录未支付。
     * 玩家手动政策不得使用该参数。
     */
    deferFunding?: boolean;
  } = {},
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
    // v1.5 §4（task-18）：AI 高失业决策走“先立项、后融资”，不在启动时用当前财政卡死；
    // 其他所有路径（玩家手动、普通 AI 政策）仍要求启动时财政足够。
    if (!options.deferFunding && city.treasury + 1e-6 < requested) {
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

// ---------------------------------------------------------------- v1.5 §4：政策资金预留与补足

/** “AI 高失业决策”政策前缀：只有这类政策走 v1.5 §4 的月度资金预留/补足。 */
const AI_CRISIS_POLICY_PREFIX = 'AI 高失业决策';

const TAX_FISCAL_KINDS: readonly FiscalEntry['kind'][] = [
  'incomeTax',
  'corporateTax',
  'consumptionTax',
  'dividendTax',
  'transportTaxBonus',
  'transportTaxLoss',
];

const DEBT_FISCAL_KINDS: readonly FiscalEntry['kind'][] = [
  'bondIssuanceProceeds',
  'bondInterest',
  'bondPrincipal',
  'governmentLoanRepayment',
  'governmentLoanInterest',
  'bankAdvance',
  'debtWriteOff',
  'debtForgiven',
];

function isAiCrisisPolicy(policy: Pick<ActivePolicy, 'reason' | 'effects'>): boolean {
  // v1.5 §4（task-18）：以启动时写入的政策标记为准（AI 高失业决策路径），
  // 不再依赖任何政策白名单；reason 前缀仅用于旧存档/旧数据的兼容回退。
  return policy.effects.aiCrisisPolicy === 1 || policy.reason.startsWith(AI_CRISIS_POLICY_PREFIX);
}

/** 政策参考预算（决策口径）：优先记录值，其次该政策的固定默认预算。不是已到账资金。 */
function policyReferenceBudget(policy: ActivePolicy, config: DemoConfig): number {
  return round2(Math.max(0, policy.referenceBudget ?? config.policies.budgets[policy.policyId]));
}

function ledgerAmountSum(
  world: WorldState,
  cityId: string,
  tick: number,
  kinds: readonly FiscalEntry['kind'][],
): number {
  let total = 0;
  for (const entry of world.fiscal.ledger) {
    if (entry.cityId !== cityId || entry.tick !== tick) continue;
    if (!kinds.includes(entry.kind)) continue;
    total += entry.amount;
  }
  return round2(total);
}

/**
 * 本月某项政策“真实可支付现金需求”的估算（只用于预留，不产生支付、不计收入）。
 *
 * 只覆盖在 settlePolicies 内产生现金支出的政策：
 * - 事件型政策（设备/创业/跨城贸易）在事件发生当月之外不产生月末现金支出，返回 0；
 * - 公共岗位工资由 fiscal.ts 公共工资科目支付（政策层只做预算归属），返回 0。
 */
function expectedPolicyCashClaim(
  world: WorldState,
  city: City,
  policy: ActivePolicy,
  config: DemoConfig,
  hiresByCompany?: Record<string, number>,
): number {
  // v1.5 §4：参考预算/预留按“单月”口径；即使总预算已被前几个月支出，本月仍按参考预算评估真实需求。
  const reference = policyReferenceBudget(policy, config);
  if (reference <= 0 || policy.monthsRemaining <= 0) return 0;
  switch (policy.policyId) {
    case 'unemploymentAid': {
      const need = round2(
        Math.max(0, city.population.unemployed) * config.policies.unemploymentAid.extraPerUnemployed,
      );
      return Math.min(reference, need);
    }
    case 'retentionSubsidy': {
      let need = 0;
      for (const company of world.companies) {
        if (company.cityId !== city.id || company.employees <= 0) continue;
        const perEmployee = round2(
          company.wageRate * config.policies.retention.subsidyRate * leaderScale(world, city.id, 'employment', config),
        );
        need = round2(need + perEmployee * company.employees);
      }
      return Math.min(reference, need);
    }
    case 'hiringSubsidy': {
      // 需要本月真实招聘结果（labor.hiresByCompany）；没有上下文则不预借，避免高估。
      if (!hiresByCompany) return 0;
      const tracking = policy.tracking;
      let need = 0;
      for (const company of world.companies) {
        if (company.cityId !== city.id) continue;
        const newHires = Math.max(0, Math.round(hiresByCompany[company.id] ?? 0));
        if (newHires <= 0) continue;
        const baseline = tracking?.hiringBaseline?.[company.id] ?? company.employees;
        const alreadySubsidised = Math.max(0, Math.round(tracking?.subsidisedJobs?.[company.id] ?? 0));
        const netNew = Math.max(0, company.employees - baseline - alreadySubsidised);
        const eligible = Math.min(newHires, netNew);
        if (eligible <= 0) continue;
        const perHire = round2(
          company.wageRate * config.policies.hiring.subsidyRate * leaderScale(world, city.id, 'employment', config),
        );
        need = round2(need + perHire * eligible);
      }
      return Math.min(reference, need);
    }
    case 'vocationalTraining': {
      const need = round2(city.population.unemployed * config.policies.training.costPerTrainee);
      return Math.min(reference, need);
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
      let need = 0;
      for (const company of distressed) {
        need = round2(need + Math.max(0, company.employees * company.wageRate * config.policies.relief.wageMonths));
      }
      return Math.min(reference, need);
    }
    case 'keyIndustrySupport': {
      return Math.min(reference, round2(reference * config.policies.keyIndustry.grantShare));
    }
    case 'researchGrant': {
      const points = Math.floor(reference / Math.max(1, config.policies.research.costPerPoint));
      return Math.min(reference, round2(points * config.policies.research.costPerPoint));
    }
    case 'educationInvestment':
    case 'housingSupport': {
      return reference;
    }
    case 'publicJobs': {
      // 公共岗位工资由 fiscal publicWages 真实支付；资金补足按“本月在岗工资”计算，
      // 使 AI 选中的公共岗位同样被资助（实支口径取 fiscal 公共工资中属于本政策的部分）。
      const jobs = Math.max(0, Math.round(policy.tracking?.publicWorksJobs ?? policy.effects.jobsCreated ?? 0));
      const wageRate = Math.max(0, policy.tracking?.publicWorksWageRate ?? city.publicSector.wageRate);
      const need = round2(jobs * wageRate);
      return Math.min(reference, need);
    }
    case 'equipmentSubsidy':
    case 'startupSupport':
    case 'intercityTradeSupport':
    case 'taxAdjustment':
    case 'transportInvestment': {
      // 事件型政策在事件发生时支出（早于 15b 资金预留），月末政策现金流水为 0。
      return 0;
    }
    default:
      return reference;
  }
}

/**
 * v1.5 §4：政策执行前的“资金预留/补足”步骤（必须排在 settleGovernment 之后、settlePolicies 之前）。
 *
 * 顺序（与财政流水插入顺序一致）：
 *   政策决策/参考预算（本月体检动态预算或固定默认）
 *   → 税收入账 → 公共工资/福利（settleGovernment 已完成）
 *   → 政策借款到账（本步骤：真实银行放款，计息入债，债务/GDP 必须 < 85%）
 *   → 政策预留（≤ 到账后财政余额）→ 政策实际执行（settlePolicies，实支 ≤ 预留）。
 *
 * 只处理非玩家市长城市的“AI 高失业决策”政策；玩家市长城市完全跳过（AI 不代选/代发/代借）。
 * 借款失败或达到债务率上限时，按可用财政预留，未支付部分由 settlePolicies 如实记为 unpaid。
 */
export function preparePolicyFunding(
  world: WorldState,
  config: DemoConfig,
  log: LogEntry[],
  context: { hiresByCompany?: Record<string, number> } = {},
): void {
  ensurePolicyState(world);
  const settings = config.policies.aiLabor.policyFunding;
  world.policies.fundingMonths ??= [];
  const tick = world.time.tick;
  for (const city of [...world.cities].sort((a, b) => a.id.localeCompare(b.id))) {
    if (playerIsMayor(world, city.id)) continue;
    const policies = activePoliciesFor(world, city.id).filter((policy) => isAiCrisisPolicy(policy));
    if (policies.length === 0) continue;

    const referenceBudget = round2(
      policies.reduce((sum, policy) => sum + policyReferenceBudget(policy, config), 0),
    );
    const targets = policies.map((policy) => ({
      policy,
      claim: expectedPolicyCashClaim(world, city, policy, config, context.hiresByCompany),
    }));
    const desired = round2(targets.reduce((sum, entry) => sum + entry.claim, 0));

    const treasuryBeforeFunding = round2(city.treasury);
    const debtBefore = computeGovernmentDebtSummary(world, city, config, tick);
    const debtRatioBefore = debtBefore.debtRatio;
    let borrowingProceeds = 0;
    let debtRatioAfterBorrowing = debtRatioBefore;
    const deficit = round2(Math.max(0, desired - Math.max(0, treasuryBeforeFunding)));
    if (
      settings.enabled &&
      deficit > 0.005 &&
      city.government &&
      city.government.bankruptcy.status !== 'bankrupt'
    ) {
      // 只允许把债务/GDP 补到预警线以内（85%），100% 破产规则不变。
      const headroom = round2(
        Math.max(0, (settings.maxDebtRatioForBorrowing - debtBefore.debtRatio) *
          Math.max(1, debtBefore.gdpJudgementValue)),
      );
      const amount = round2(Math.min(deficit, headroom));
      if (amount > 0.005) {
        const borrow = borrowForGovernment(world, city, config, amount, tick, log, { exact: true });
        if (borrow.ok) {
          borrowingProceeds = amount;
          debtRatioAfterBorrowing = computeGovernmentDebtSummary(world, city, config, tick).debtRatio;
        } else {
          log.push({
            tick,
            kind: 'warning',
            visibility: { scope: 'mayor', cityId: city.id },
            message: `${city.name} 政策资金补足借款失败：${borrow.error ?? '未知原因'}；本月按可用财政支付，未支付部分如实记录。`,
          });
        }
      }
    }

    // 预留只能来自真实到账资金（财政余额含本步骤真实借款）。
    let pool = round2(city.treasury);
    let reservedTotal = 0;
    let unpaidTotal = 0;
    for (const target of targets) {
      const policy = target.policy;
      const reserve = round2(Math.min(target.claim, Math.max(0, pool)));
      pool = round2(pool - reserve);
      reservedTotal = round2(reservedTotal + reserve);
      unpaidTotal = round2(unpaidTotal + Math.max(0, target.claim - reserve));
      policy.reservedThisMonth = reserve;
      policy.unpaidThisMonth = round2(Math.max(0, target.claim - reserve));
      policy.fundingSourceThisMonth =
        reserve <= 0 ? 'none' : borrowingProceeds > 0 ? 'bankLoan' : 'treasury';
      // 本月实支从 0 开始计；reservedTick 让 payFromPolicy 只在本月执行时按预留封顶。
      policy.effects.spentThisMonth = 0;
      policy.effects.reservedTick = tick;
      policy.effects.expectedClaim = target.claim;
    }

    const trace: PolicyFundingMonth = {
      tick,
      cityId: city.id,
      referenceBudget,
      taxReceived: ledgerAmountSum(world, city.id, tick, TAX_FISCAL_KINDS),
      publicWages: round2(-ledgerAmountSum(world, city.id, tick, ['publicWages'])),
      benefitsPaid: round2(-ledgerAmountSum(world, city.id, tick, ['benefits'])),
      essentialSpending: 0,
      treasuryBeforeFunding,
      borrowingProceeds,
      debtRatioBefore,
      debtRatioAfterBorrowing,
      reserved: reservedTotal,
      spent: 0,
      unpaid: unpaidTotal,
      fundingSource: borrowingProceeds > 0 ? 'bankLoan' : reservedTotal > 0 ? 'treasury' : 'none',
      note: `参考预算 ${referenceBudget.toFixed(0)}（${policies.length} 项）；缺口 ${deficit.toFixed(0)}；借款到账 ${borrowingProceeds.toFixed(0)}`,
    };
    trace.essentialSpending = round2(trace.publicWages + trace.benefitsPaid);
    world.policies.fundingMonths.push(trace);
    // 每城只保留最近 retentionMonths 条，并在 note 标注截断。
    const retention = Math.max(1, Math.round(settings.retentionMonths));
    const allMonths: PolicyFundingMonth[] = world.policies.fundingMonths ?? [];
    const cityMonths: PolicyFundingMonth[] = allMonths
      .filter((entry: PolicyFundingMonth) => entry.cityId === city.id)
      .sort((a: PolicyFundingMonth, b: PolicyFundingMonth) => a.tick - b.tick);
    if (cityMonths.length > retention) {
      const dropped: number = cityMonths.length - retention;
      const dropTicks = new Set<number>(
        cityMonths.slice(0, dropped).map((entry: PolicyFundingMonth) => entry.tick),
      );
      world.policies.fundingMonths = allMonths.filter(
        (entry: PolicyFundingMonth) => entry.cityId !== city.id || !dropTicks.has(entry.tick),
      );
      const latest = cityMonths[cityMonths.length - 1]!;
      latest.note = `${latest.note}；保留最近 ${retention} 个月（更早 ${dropped} 条已截断）`;
    }

    log.push({
      tick,
      kind: 'government',
      // 预算/债务/财政余额属市长财政口径。
      visibility: { scope: 'mayor', cityId: city.id },
      message: `${city.name} 政策资金顺序：决策参考预算 ${referenceBudget.toFixed(0)} → 税收到账 ${trace.taxReceived.toFixed(0)} → 公共工资 ${trace.publicWages.toFixed(0)} / 福利 ${trace.benefitsPaid.toFixed(0)} → 政策前财政余额 ${treasuryBeforeFunding.toFixed(0)} → 政策借款到账 ${borrowingProceeds.toFixed(0)}（债务/GDP ${(debtRatioBefore * 100).toFixed(1)}% → ${(debtRatioAfterBorrowing * 100).toFixed(1)}%）→ 预留 ${reservedTotal.toFixed(0)}（来源 ${trace.fundingSource}）。`,
    });
  }
}

/** 单城单月 fundingMonths 记录之后，写入真实实支/未支付并留痕（settlePolicies 内调用）。 */
function finalizePolicyFunding(
  world: WorldState,
  city: City,
  config: DemoConfig,
  log: LogEntry[],
): void {
  const trace = (world.policies.fundingMonths ?? []).find(
    (entry) => entry.cityId === city.id && entry.tick === world.time.tick,
  );
  if (!trace) return;
  const candidates = [
    ...activePoliciesFor(world, city.id),
    ...world.policies.history.filter((entry) => entry.cityId === city.id && entry.endedTick === world.time.tick),
  ].filter((policy) => isAiCrisisPolicy(policy) && policy.effects.reservedTick === world.time.tick);
  const seen = new Set<string>();
  let reference = 0;
  let reserved = 0;
  let spent = 0;
  let unpaid = 0;
  for (const policy of candidates) {
    if (seen.has(policy.id)) continue;
    seen.add(policy.id);
    const spentThisMonth = round2(Math.max(0, policy.effects.spentThisMonth ?? 0));
    const claim = round2(Math.max(0, policy.effects.expectedClaim ?? 0));
    policy.unpaidThisMonth = round2(Math.max(0, claim - spentThisMonth));
    reference = round2(reference + policyReferenceBudget(policy, config));
    reserved = round2(reserved + (policy.reservedThisMonth ?? 0));
    spent = round2(spent + spentThisMonth);
    unpaid = round2(unpaid + policy.unpaidThisMonth);
  }
  trace.referenceBudget = reference;
  trace.reserved = reserved;
  trace.spent = spent;
  trace.unpaid = unpaid;
  trace.note = `${trace.note}；实支 ${spent.toFixed(0)}，未支付 ${unpaid.toFixed(0)}（未支付不计受益/收入）`;
  log.push({
    tick: world.time.tick,
    kind: 'government',
    visibility: { scope: 'mayor', cityId: city.id },
    message: `${city.name} 政策执行：预留 ${reserved.toFixed(0)} → 实支 ${spent.toFixed(0)} / 未支付 ${unpaid.toFixed(0)}（资金已真实到账后才支付）。`,
  });
}

export interface PolicyFundingReportStage {
  order: number;
  stage:
    | 'policyDecision'
    | 'taxReceived'
    | 'publicWages'
    | 'benefits'
    | 'policyBorrowing'
    | 'policyReserved'
    | 'policySpent'
    | 'debtSettlement'
    | 'unpaid'
    | 'otherFiscal';
  amount: number;
  source: string;
}

export interface PolicyFundingReport {
  cityId: string;
  tick: number;
  referenceBudget: number;
  taxReceived: number;
  publicWages: number;
  benefitsPaid: number;
  essentialSpending: number;
  treasuryBeforeFunding: number;
  borrowingProceeds: number;
  debtRatioBefore: number;
  debtRatioAfterBorrowing: number;
  reserved: number;
  spent: number;
  unpaid: number;
  fundingSource: PolicyFundingSource;
  note: string;
  stages: PolicyFundingReportStage[];
}

/**
 * 报告/UI：读取持久化的 fundingMonths + 当月财政流水，输出真实的月度资金顺序与三口径。
 * 没有该城该月资金记录（非 AI 高失业政策或旧档）时返回 null。
 */
export function policyFundingMonthlyReport(
  world: WorldState,
  cityId: string,
  tick: number,
): PolicyFundingReport | null {
  const trace = (world.policies.fundingMonths ?? []).find(
    (entry) => entry.cityId === cityId && entry.tick === tick,
  );
  if (!trace) return null;
  const entries = world.fiscal.ledger.filter((entry) => entry.cityId === cityId && entry.tick === tick);
  const stages: PolicyFundingReportStage[] = [];
  const push = (stage: PolicyFundingReportStage['stage'], amount: number, source: string) => {
    stages.push({ order: stages.length + 1, stage, amount: round2(amount), source });
  };
  push('policyDecision', trace.referenceBudget, '本月政策决策参考预算（体检动态预算/固定默认）');
  const group = (
    kinds: readonly FiscalEntry['kind'][],
  ): { amount: number; source: string } | null => {
    const matched = entries.filter((entry) => kinds.includes(entry.kind));
    if (matched.length === 0) return null;
    return {
      amount: round2(matched.reduce((sum, entry) => sum + entry.amount, 0)),
      source: matched.map((entry) => entry.source).join('；'),
    };
  };
  const tax = group(TAX_FISCAL_KINDS);
  if (tax) push('taxReceived', tax.amount, tax.source);
  const wages = group(['publicWages']);
  if (wages) push('publicWages', round2(-wages.amount), wages.source);
  const benefits = group(['benefits']);
  if (benefits) push('benefits', round2(-benefits.amount), benefits.source);
  if (trace.borrowingProceeds > 0) {
    push('policyBorrowing', trace.borrowingProceeds, `真实银行放款到账（债务/GDP ${(trace.debtRatioAfterBorrowing * 100).toFixed(2)}%）`);
  }
  push('policyReserved', trace.reserved, `本月真实可动用预留（来源 ${trace.fundingSource}）`);
  const spending = group(['policySpending']);
  if (spending) push('policySpent', round2(-spending.amount), spending.source);
  const debt = group(DEBT_FISCAL_KINDS);
  if (debt) push('debtSettlement', debt.amount, debt.source);
  const otherKinds = new Set(DEBT_FISCAL_KINDS);
  const others = entries.filter(
    (entry) =>
      !TAX_FISCAL_KINDS.includes(entry.kind) &&
      entry.kind !== 'publicWages' &&
      entry.kind !== 'benefits' &&
      entry.kind !== 'policySpending' &&
      entry.kind !== 'governmentLoanProceeds' &&
      !otherKinds.has(entry.kind),
  );
  if (others.length > 0) {
    push('otherFiscal', round2(others.reduce((sum, entry) => sum + entry.amount, 0)), others.map((entry) => entry.source).join('；'));
  }
  push('unpaid', trace.unpaid, '预留/真实需求内未支付（不计受益或居民收入）');
  return {
    cityId,
    tick,
    referenceBudget: trace.referenceBudget,
    taxReceived: trace.taxReceived,
    publicWages: trace.publicWages,
    benefitsPaid: trace.benefitsPaid,
    essentialSpending: trace.essentialSpending,
    treasuryBeforeFunding: trace.treasuryBeforeFunding,
    borrowingProceeds: trace.borrowingProceeds,
    debtRatioBefore: trace.debtRatioBefore,
    debtRatioAfterBorrowing: trace.debtRatioAfterBorrowing,
    reserved: trace.reserved,
    spent: trace.spent,
    unpaid: trace.unpaid,
    fundingSource: trace.fundingSource,
    note: trace.note,
    stages,
  };
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
    /** v1.5 §4（task-18）：仅 AI 高失业决策路径使用；先立项、同 tick 15b 再真实融资。 */
    deferFunding?: boolean;
  } = {},
): ActionResult {
  ensurePolicyState(world);
  const city = world.cities.find((entry) => entry.id === cityId);
  if (!city) return { ok: false, error: '城市不存在' };
  const log = options.log ?? [];
  const check = canStartPolicy(world, cityId, policyId, config, options.budget, {
    deferFunding: options.deferFunding,
  });
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
    // v1.5 §4：记录决策时的参考预算（AI 动态预算/固定默认）；与实际到账预留在结算时区分。
    referenceBudget: budget,
    reason,
    note: definition.effect,
  };
  // v1.5 §4（task-18）：经 AI 高失业决策启动的政策打标记；资金补足/报告按标记判断，
  // 不再用硬编码政策列表或仅靠 reason 文本（旧存档仍保留 reason 前缀回退）。
  if (options.deferFunding) {
    policy.effects.aiCrisisPolicy = 1;
    policy.effects.deferredFunding = 1;
  }
  // v1.5 §4：AI 高失业政策的预算语义是“单月参考预算”，总预算按“启动当月 + 剩余月数”展开。
  // 说明：settlePolicies 在启动当月也会执行一次（startedTick 不扣月），因此可执行次数 =
  // monthsRemaining + 1；若只按 monthsRemaining 展开，完成时会出现 spent > budget，
  // 触发存档校验失败（tests-dev 复现：8 月世界无法读档）。
  // referenceBudget 保留单月口径（每月预留/实支按它评估），budget 作为总上限，
  // 供不变量“spent ≤ budget”与政策生命周期审计使用。
  const budgetExecutions = policy.monthsRemaining + 1;
  if (options.deferFunding || reason.startsWith(AI_CRISIS_POLICY_PREFIX)) {
    policy.budget = round2(Math.max(policy.budget, budget * budgetExecutions));
  }

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

  // v1.5 §4：公共岗位等政策会在上面覆盖 budget（预留工资口径）；这里再按可执行次数
  // 重置总上限，保证完成时 spent ≤ budget（否则存档校验失败）。
  if (options.deferFunding) {
    policy.budget = round2(Math.max(policy.budget, budget * budgetExecutions));
  }
  world.policies.active.push(policy);
  recordRun(world, cityId, policyId);
  log.push({
    tick: world.time.tick,
    kind: 'government',
    // 政策预算属市长财政口径，非市长不可见具体金额。
    visibility: { scope: 'mayor', cityId: city.id },
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
    // v1.5 §4：已做本月资金预留的政策优先执行（预留资金优先于其他未预留政策），
    // 否则未预留的旧政策可能先花掉本属于高失业新政的已预留资金。
    const policies = [...activePoliciesFor(world, city.id)].sort((a, b) => {
      const fundedA = a.effects.reservedTick === world.time.tick ? 1 : 0;
      const fundedB = b.effects.reservedTick === world.time.tick ? 1 : 0;
      if (fundedA !== fundedB) return fundedB - fundedA;
      return a.policyId.localeCompare(b.policyId);
    });
    for (const policy of policies) {
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
            const affordableHires = Math.min(
              eligible,
              Math.floor(policyMonthlyCashLimit(world, policy, config) / perHire),
            );
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
              // 财政支出金额属市长财政口径，非市长不可见。
              visibility: { scope: 'mayor', cityId: city.id },
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
              // 财政支出金额属市长财政口径，非市长不可见。
              visibility: { scope: 'mayor', cityId: city.id },
              message: `${city.name} 稳岗补贴：${employees} 个在岗岗位获得补贴，支出 ${total.toFixed(0)}。`,
            });
          }
          break;
        }
        case 'vocationalTraining': {
          const perTrainee = config.policies.training.costPerTrainee;
          const budgetThisMonth = policyMonthlyCashLimit(world, policy, config);
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
              // 财政支出金额属市长财政口径，非市长不可见。
              visibility: { scope: 'mayor', cityId: city.id },
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
          const monthly = policyMonthlyCashLimit(world, policy, config);
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
          const budgetThisMonth = policyMonthlyCashLimit(world, policy, config);
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
          const budgetThisMonth = policyMonthlyCashLimit(world, policy, config);
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
          // v1.5 §4：同步计入居民群体（失业救助优先按失业群体分摊），保证 Σgroup.income 闭合。
          attributePolicyTransferToGroups(world, city, paid, true);
          // lastMonth.householdIncome 沿用 settleGovernment 的“不含退款”口径，仅加政策实发；
          // 不能直接赋值为 householdIncomeLastMonth（它含退款与投资转出，会与退款重复计算）。
          city.lastMonth.householdIncome = round2(city.lastMonth.householdIncome + paid);
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
          const budgetThisMonth = policyMonthlyCashLimit(world, policy, config);
          const unitCost = config.policies.housing.unitCost;
          const rentPart = round2(budgetThisMonth * config.policies.housing.rentSubsidyShare);
          const buildPart = round2(budgetThisMonth - rentPart);
          const rentPaid = payFromPolicy(world, policy, rentPart, '住房租金补贴', config);
          const buildPaid = payFromPolicy(world, policy, buildPart, '新住房建设', config);
          if (rentPaid > 0) {
            city.householdIncomeLastMonth = round2(city.householdIncomeLastMonth + rentPaid);
            // v1.5 §4：住房租金补贴同样真实计入居民群体收入；lastMonth.householdIncome 沿用
            // “不含退款”口径，只加政策实发（不能赋值为含退款的 householdIncomeLastMonth）。
            attributePolicyTransferToGroups(world, city, rentPaid, false);
            city.lastMonth.householdIncome = round2(city.lastMonth.householdIncome + rentPaid);
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
            // 财政支出金额属市长财政口径，非市长不可见。
            visibility: { scope: 'mayor', cityId: city.id },
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
          // 该笔钱由 fiscal.ts 的公共工资科目真实支付（不是 policySpending 流水），
          // 计入本月政策实支口径，用于“预留 vs 实支 vs 未支付”与资金追踪。
          policy.effects.spentThisMonth = round2((policy.effects.spentThisMonth ?? 0) + attributed);
          policy.effects.publicWagePaidThisMonth = attributed;
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
      // v1.5 §4：若本月已做资金预留，把三口径写进执行记录与政策字段（未支付不计受益/收入）。
      if (policy.effects.reservedTick === world.time.tick) {
        const spentThisMonth = round2(Math.max(0, policy.effects.spentThisMonth ?? 0));
        const claim = round2(Math.max(0, policy.effects.expectedClaim ?? 0));
        policy.unpaidThisMonth = round2(Math.max(0, claim - spentThisMonth));
        execution.referenceBudget = policyReferenceBudget(policy, config);
        execution.reserved = policy.reservedThisMonth ?? 0;
        execution.unpaid = policy.unpaidThisMonth;
        execution.fundingSource =
          policy.fundingSourceThisMonth === 'bankLoan'
            ? 'city.treasury+govBankLoan/policySpending'
            : 'city.treasury/policySpending';
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
    // v1.5 §4：本城本月政策执行完毕后，把真实实支/未支付写回 fundingMonths（三口径持久化）。
    finalizePolicyFunding(world, city, config, log);
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
          // v1.5 §4（task-18）：先立项、同 tick 15b preparePolicyFunding 再真实借款/预留。
          deferFunding: true,
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
