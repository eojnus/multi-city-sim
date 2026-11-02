import type { SaveFile, WorldState } from '../contracts/types';
import { GAME_VERSION, SAVE_FORMAT_VERSION } from '../contracts/types';
import { GOOD_IDS } from '../companies/company';
import { checkInvariants } from './invariants';
import { DEMO_CONFIG } from '../../data/config';
import { allocateProportionally, round2 } from './math';
import {
  createShareStructure,
  syncCompanyTotalShares,
  syncPlayerHoldings,
} from '../securities/securities';
import { createInvestorGroups, groupHolder } from '../investors/investors';
import { createInitialTransport } from '../transport/network';
import { createInitialPolitics } from '../politics/politics';
import { freshAiState } from '../companies/lifecycle/lifecycle';
import { POLICY_IDS } from '../policies/definitions';
import {
  computeHouseholdWealthStats,
  migrateHouseholds,
} from '../population/household-groups';
import { createInitialManagement } from '../management/manager-pool';
import { createInitialBanking, migrateLegacyCompanyDebt } from '../banking/banking';

export interface ParseResult {
  ok: boolean;
  world?: WorldState;
  save?: SaveFile;
  error?: string;
  /** 本次读取经过迁移的旧格式版本；正常 v2 存档为 undefined。 */
  migratedFrom?: number;
}

const ROLE_KEYS = ['management', 'production', 'sales', 'research'] as const;
const SECTOR_IDS = new Set([
  'agriculture',
  'fiber-farm',
  'textile',
  'food',
  'garment',
  'metal',
  'utility',
  'appliance',
]);
const LOG_KINDS = new Set([
  'system',
  'market',
  'labor',
  'production',
  'trade',
  'population',
  'government',
  'player',
  'warning',
]);
const STATS_KEYS = [
  'revenue',
  'inputCost',
  'wagesPaid',
  'wageArrears',
  'interestPaid',
  'corporateTax',
  'dividendsPaid',
  'profit',
  'produced',
  'sold',
  'exported',
  'unmetDemand',
  'capacityChange',
  'dividendIncome',
] as const;

export function createSaveFile(world: WorldState, savedAt = new Date().toISOString()): SaveFile {
  return {
    formatVersion: SAVE_FORMAT_VERSION,
    gameVersion: GAME_VERSION,
    savedAt,
    world: deepClone(world),
  };
}

export function serializeSave(world: WorldState, savedAt = new Date().toISOString()): string {
  return JSON.stringify(createSaveFile(world, savedAt), null, 2);
}

export function parseSave(text: string): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { ok: false, error: `存档不是有效 JSON：${(error as Error).message}` };
  }
  if (!isRecord(parsed)) return { ok: false, error: '存档根节点不是对象' };

  const formatVersion = parsed.formatVersion;
  if (typeof formatVersion !== 'number' || !Number.isInteger(formatVersion)) {
    return { ok: false, error: '存档缺少有效的 formatVersion' };
  }
  if (formatVersion > SAVE_FORMAT_VERSION) {
    return {
      ok: false,
      error: `存档格式版本 ${formatVersion} 高于当前支持的 ${SAVE_FORMAT_VERSION}，请使用更新版本的游戏读取。`,
    };
  }
  if (formatVersion < 1) {
    return { ok: false, error: `不支持的存档格式版本 ${formatVersion}` };
  }

  try {
    const save = parsed as unknown as SaveFile;
    if (!isRecord(save.world)) return { ok: false, error: '存档缺少 world 数据' };

    let worldValue: unknown = save.world;
    let migratedFrom: number | undefined;
    if (formatVersion === 1) {
      const migration = migrateWorldV1(save.world);
      if (!migration.ok || !migration.world) {
        return { ok: false, error: migration.error ?? '旧存档迁移失败' };
      }
      worldValue = migration.world;
      migratedFrom = 1;
    }
    if (formatVersion <= 2) {
      const migration = migrateWorldV2ToV3(worldValue);
      if (!migration.ok || !migration.world) {
        return { ok: false, error: migration.error ?? 'v2 存档迁移失败' };
      }
      worldValue = migration.world;
      if (migratedFrom === undefined) migratedFrom = 2;
    }
    if (formatVersion <= 3) {
      const migration = migrateWorldV3ToV4(worldValue);
      if (!migration.ok || !migration.world) {
        return { ok: false, error: migration.error ?? 'v3 存档迁移失败' };
      }
      worldValue = migration.world;
      if (migratedFrom === undefined) migratedFrom = 3;
    }
    if (formatVersion <= 4) {
      const migration = migrateWorldV4ToV5(worldValue);
      if (!migration.ok || !migration.world) {
        return { ok: false, error: migration.error ?? 'v4 存档迁移失败' };
      }
      worldValue = migration.world;
      if (migratedFrom === undefined) migratedFrom = 4;
    }

    const structureError = validateWorldStructure(worldValue);
    if (structureError) return { ok: false, error: structureError };

    const world = worldValue as WorldState;
    syncCompanyTotalSharesSafe(world);
    const problems = checkInvariants(world);
    if (problems.length > 0) {
      return {
        ok: false,
        error: `存档未通过不变量校验：${problems.slice(0, 3).join('；')}`,
      };
    }
    if (world.seed !== world.seed >>> 0) return { ok: false, error: '随机种子状态无效' };
    return {
      ok: true,
      world,
      save: {
        formatVersion: SAVE_FORMAT_VERSION,
        gameVersion: GAME_VERSION,
        savedAt: typeof save.savedAt === 'string' ? save.savedAt : new Date().toISOString(),
        world,
      },
      migratedFrom,
    };
  } catch (error) {
    // 即使校验器遗漏了某个嵌套字段，也必须把异常变成可读的读取失败，而不是让 UI 崩溃。
    return { ok: false, error: `存档校验异常：${(error as Error).message}` };
  }
}

function syncCompanyTotalSharesSafe(world: WorldState): void {
  for (const company of world.companies) syncCompanyTotalShares(world, company);
  syncPlayerHoldings(world);
}

// ---------------------------------------------------------------- 旧存档迁移

interface MigrationResult {
  ok: boolean;
  world?: WorldState;
  error?: string;
}

/**
 * v1 → v2 迁移（2026-11-01 之前的真实存档）。
 * 保留：人口、企业现金/债务/库存/产能、玩家现金与持股、时间、随机状态、历史与日志。
 * 新增：股份类别（v1 的全部股份视为有投票权）、居民投资实体（初始现金 0）、
 *      治理/协议/通知空状态、企业经营上月快照。
 * 不凭空创造资金；无法安全推导的情况（企业发行量无效、玩家持股超过发行量）明确报错。
 */
export function migrateWorldV1(raw: unknown): MigrationResult {
  if (!isRecord(raw)) return { ok: false, error: '旧存档 world 不是对象' };
  if (!Array.isArray(raw.cities) || raw.cities.length === 0) {
    return { ok: false, error: '旧存档缺少有效城市数据，无法迁移' };
  }
  if (!Array.isArray(raw.companies) || raw.companies.length === 0) {
    return { ok: false, error: '旧存档缺少有效企业数据，无法迁移' };
  }
  if (!isRecord(raw.player)) return { ok: false, error: '旧存档缺少玩家数据，无法迁移' };

  const world = deepClone(raw) as unknown as WorldState & Record<string, unknown>;
  const config = DEMO_CONFIG;

  for (const city of world.cities) {
    const lastMonth = (city.lastMonth ?? {}) as unknown as Record<string, unknown>;
    city.lastMonth = {
      householdIncome: typeof lastMonth.householdIncome === 'number' ? lastMonth.householdIncome : 0,
      consumerSpend: typeof lastMonth.consumerSpend === 'number' ? lastMonth.consumerSpend : 0,
      consumerBudget: typeof lastMonth.consumerBudget === 'number' ? lastMonth.consumerBudget : 0,
      benefitsPaid: typeof lastMonth.benefitsPaid === 'number' ? lastMonth.benefitsPaid : 0,
      incomeTax: typeof lastMonth.incomeTax === 'number' ? lastMonth.incomeTax : 0,
      corporateTax: typeof lastMonth.corporateTax === 'number' ? lastMonth.corporateTax : 0,
      publicWageBill: typeof lastMonth.publicWageBill === 'number' ? lastMonth.publicWageBill : 0,
      gdp: typeof lastMonth.gdp === 'number' ? lastMonth.gdp : 0,
      migrationIn: typeof lastMonth.migrationIn === 'number' ? lastMonth.migrationIn : 0,
      migrationOut: typeof lastMonth.migrationOut === 'number' ? lastMonth.migrationOut : 0,
      investorDividends: 0,
      investableContribution: 0,
      policySpending: 0,
      transportSpending: 0,
      note:
        typeof lastMonth.note === 'string'
          ? lastMonth.note
          : '由 v1 存档迁移；后续结算会重新生成说明。',
    };
  }

  const cityIds = new Set(world.cities.map((city) => city.id));
  for (const company of world.companies) {
    if (typeof company.id !== 'string' || !cityIds.has(company.cityId)) {
      return { ok: false, error: `旧存档企业 ${String(company.id)} 的城市引用无效，无法迁移` };
    }
    if (!isFiniteNumber(company.totalShares) || company.totalShares <= 0) {
      return {
        ok: false,
        error: `旧存档企业 ${company.id} 的发行股数无效，无法在不臆造股数的前提下迁移`,
      };
    }
    const lastMonth = (company.lastMonth ?? {}) as unknown as Record<string, unknown>;
    const stats = normalizeStats(lastMonth);
    company.lastMonth = stats;
    company.previousMonth = { ...stats };
    company.dividendPayoutRatio = config.governance.defaultDividendPayoutRatio;
  }

  const player = world.player as unknown as Record<string, unknown>;
  if (!Array.isArray(player.holdings)) return { ok: false, error: '旧存档玩家持股无效' };
  player.roles = { mayorCityId: null };

  // 居民投资实体：迁移时不注入初始资金，避免凭空创造货币。
  createInvestorGroups(world, config, { endow: false });

  const playerSharesByCompany = new Map<string, number>();
  for (const holding of player.holdings as { companyId?: unknown; shares?: unknown }[]) {
    if (typeof holding.companyId !== 'string' || !isFiniteNumber(holding.shares)) {
      return { ok: false, error: '旧存档玩家持股字段无效，无法迁移' };
    }
    playerSharesByCompany.set(
      holding.companyId,
      round2((playerSharesByCompany.get(holding.companyId) ?? 0) + Math.max(0, holding.shares)),
    );
  }

  world.securities = { classes: [], holdings: [], orders: [], lastTrades: [], offers: [] };
  for (const company of [...world.companies].sort((a, b) => a.id.localeCompare(b.id))) {
    const playerShares = playerSharesByCompany.get(company.id) ?? 0;
    if (playerShares > company.totalShares + 1e-6) {
      return {
        ok: false,
        error: `旧存档中玩家持有 ${company.name} 的股数超过发行量，无法安全迁移`,
      };
    }
    const remaining = round2(Math.max(0, company.totalShares - playerShares));
    const cityGroups = world.investors
      .filter((group) => group.cityId === company.cityId)
      .sort((a, b) => a.id.localeCompare(b.id));
    const split = allocateProportionally(
      remaining,
      cityGroups.map((group) => Math.max(0, group.populationShare)),
    );
    const votingHolders = cityGroups.map((group, index) => ({
      holder: groupHolder(group),
      shares: split[index] ?? 0,
    }));
    if (playerShares > 0) {
      votingHolders.push({ holder: { type: 'player', id: 'player' }, shares: playerShares });
    }
    createShareStructure(world, company, {
      votingShares: company.totalShares,
      nonVotingShares: 0,
      votingHolders,
      nonVotingHolders: [],
      tick: world.time?.tick ?? 0,
      acquiredVia: 'migration',
    });
  }

  world.governance = { boards: [], motions: [], controls: [] };
  world.agreements = [];
  world.notifications = [];
  world.securities.orders = [];
  world.securities.lastTrades = [];
  world.securities.offers = [];
  world.lastTick = {
    productionRecords: Array.isArray(world.lastTick?.productionRecords) ? world.lastTick.productionRecords : [],
    tradeFlows: Array.isArray(world.lastTick?.tradeFlows) ? world.lastTick.tradeFlows : [],
    externalExports: Array.isArray(world.lastTick?.externalExports) ? world.lastTick.externalExports : [],
    migration: Array.isArray(world.lastTick?.migration) ? world.lastTick.migration : [],
    invariants: Array.isArray(world.lastTick?.invariants) ? world.lastTick.invariants : [],
  };

  return { ok: true, world: world as WorldState };
}

/**
 * v2 → v3 迁移：为已有议案补上“投票权登记日快照”。
 * - 新议案在创建时记录快照；v2 存档没有该字段。
 * - 迁移时按当前投票权持股生成快照；若议案仍开放，把已记录的票数上限压到快照股数，
 *   防止旧规则下“股份转手后同一批票再次投出”的重复计票继续扩大。
 * - 已结束议案的快照仅用于存档结构与审计，不改变其结果。
 * - 不修改任何资金、股份或企业资产。
 */
export function migrateWorldV2ToV3(raw: unknown): MigrationResult {
  if (!isRecord(raw)) return { ok: false, error: '存档 world 不是对象' };
  const world = deepClone(raw) as unknown as WorldState;
  if (!isRecord(world.governance)) {
    world.governance = { boards: [], motions: [], controls: [] };
  }
  if (!Array.isArray(world.governance.motions)) {
    return { ok: false, error: '存档 governance.motions 无效，无法迁移表决快照' };
  }
  if (!world.securities || !Array.isArray(world.securities.classes)) {
    return { ok: false, error: '存档缺少证券数据，无法迁移表决快照' };
  }

  for (const motion of world.governance.motions) {
    const record = motion as unknown as Record<string, unknown>;
    if (Array.isArray(record.eligible)) continue;
    if (motion.status !== 'open') {
      // 已结束议案：快照只用于存档结构与审计，按已记录票数还原，避免用当前持股改写历史。
      const byHolder = new Map<
        string,
        { holder: { type: 'player' | 'company' | 'investorGroup' | 'city'; id: string }; shares: number }
      >();
      for (const vote of motion.votes ?? []) {
        const key = `${vote.holder.type}:${vote.holder.id}`;
        const existing = byHolder.get(key);
        if (existing) existing.shares = Math.max(existing.shares, round2(vote.votingShares));
        else {
          byHolder.set(key, {
            holder: { type: vote.holder.type, id: vote.holder.id },
            shares: round2(vote.votingShares),
          });
        }
      }
      motion.eligible = [...byHolder.values()].sort(
        (a, b) =>
          b.shares - a.shares ||
          a.holder.type.localeCompare(b.holder.type) ||
          a.holder.id.localeCompare(b.holder.id),
      );
      continue;
    }

    const snapshot = snapshotVotingHolders(world, motion.companyId);
    if (Array.isArray(motion.votes)) {
      for (const vote of motion.votes) {
        const entitlement = snapshot.find(
          (entry) =>
            entry.holder.type === vote.holder.type && entry.holder.id === vote.holder.id,
        );
        const cap = entitlement?.shares ?? 0;
        if (vote.votingShares > cap) vote.votingShares = round2(cap);
        if (!entitlement) {
          // 保留旧票记录但票重为 0：持有人当前已不在股东名册时，不会凭空产生票权。
          snapshot.push({
            holder: { type: vote.holder.type, id: vote.holder.id },
            shares: 0,
          });
        }
      }
    }
    motion.eligible = snapshot;
  }

  return { ok: true, world };
}

/**
 * v3 → v4 迁移：补齐企业 AI、技能/住房、政治、政策、财政流水、交通与企业生命周期。
 * - 不创造资金：政策为空、财政流水为空；
 * - 企业风格按 ID/行业确定性分配，不改变现金、库存、产能或股份；
 * - 候选人/领导人按确定性规则生成，旧存档的玩家市长身份保留。
 */
export function migrateWorldV3ToV4(raw: unknown): MigrationResult {
  if (!isRecord(raw)) return { ok: false, error: '存档 world 不是对象' };
  if (!Array.isArray(raw.cities) || raw.cities.length === 0) {
    return { ok: false, error: 'v3 存档缺少城市数据，无法迁移' };
  }
  if (!Array.isArray(raw.companies)) return { ok: false, error: 'v3 存档缺少企业数据，无法迁移' };
  const world = deepClone(raw) as unknown as WorldState & Record<string, unknown>;
  const config = DEMO_CONFIG;

  for (const record of world.cities as unknown as Record<string, unknown>[]) {
    if (!isRecord(record.workforce)) {
      record.workforce = {
        skillLevel: 0.3,
        trainedThisMonth: 0,
        trainedTotal: 0,
        trainedLastTick: 0,
      };
    }
    if (!isRecord(record.housing)) {
      const population = (record.population ?? {}) as Record<string, unknown>;
      const total = isFiniteNumber(population.total) ? population.total : 0;
      record.housing = {
        units: Math.round(total * 0.32),
        demand: Math.round(total * 0.3),
        rentSubsidyPaid: 0,
      };
    }
    const lastMonth = (record.lastMonth ?? {}) as Record<string, unknown>;
    if (!isFiniteNumber(lastMonth.policySpending)) lastMonth.policySpending = 0;
    if (!isFiniteNumber(lastMonth.transportSpending)) lastMonth.transportSpending = 0;
    record.lastMonth = lastMonth;
    const technology = (record.technology ?? {}) as Record<string, unknown>;
    if (technology.status !== 'active') technology.status = 'initial-only';
    record.technology = technology;
    const politicsRecord = (record.politics ?? {}) as Record<string, unknown>;
    if (politicsRecord.status !== 'active') politicsRecord.status = 'initial-only';
    record.politics = politicsRecord;
  }

  (world.companies as unknown as Record<string, unknown>[]).forEach((company, index) => {
    if (isRecord(company.ai)) return;
    const id = typeof company.id === 'string' ? company.id : `company-${index}`;
    const sector = typeof company.sector === 'string' ? company.sector : 'food';
    company.ai = {
      ...freshAiState(id, sector as WorldState['companies'][number]['sector'], index),
      ageMonths: 12,
      lastDecision: '由 v3 存档迁移：风格按 ID 与行业确定性分配。',
    };
  });

  const candidateWorld = world as unknown as WorldState;
  candidateWorld.transport = createInitialTransport(candidateWorld, config);
  const politicsState = createInitialPolitics(candidateWorld, config);
  candidateWorld.politics = politicsState;
  for (const city of candidateWorld.cities) {
    const state = politicsState.cities.find((entry) => entry.cityId === city.id);
    const leader = state?.leader;
    if (world.player && world.player.roles?.mayorCityId === city.id) {
      if (state) state.leader = null;
      city.politics = {
        ...city.politics,
        rulingParty: '玩家执政（演示）',
        electionInMonths: state?.termMonthsLeft ?? null,
        status: 'active',
        note: '玩家担任市长（演示身份）：政策由玩家选择，AI 不会代选。',
      };
      continue;
    }
    city.politics = {
      ...city.politics,
      electionInMonths: state?.termMonthsLeft ?? null,
      status: 'active',
      note: leader
        ? `现任领导人：${leader.name}（${leader.party}），重点行业 ${leader.profile.sectorAffinity ?? '—'}。由旧存档迁移生成，不是最终选举制度。`
        : '由 politics 模块管理。',
    };
  }

  candidateWorld.policies = { active: [], history: [], lastRuns: [], lastSelection: [] };
  candidateWorld.fiscal = { ledger: [], nextEntryId: 1 };
  candidateWorld.lifecycle = {
    foundings: [],
    liquidations: [],
    nextFoundingNumber: 1,
    nextLiquidationNumber: 1,
  };
  candidateWorld.transport.pendingSales = [];

  return { ok: true, world: candidateWorld };
}

/**
 * v4 → v5 迁移：补齐居民群体、经营者与独立银行。
 * - 不创造资金：居民群体现金与存款为 0（财富来自投资实体权益归属）；
 * - 旧 company.debt 承接为银行贷款合同（本金不变、不清零、不重复计息）；
 * - 经营者按确定性规则生成，沿用企业既有 ai.style，不改变企业资产与行为。
 */
export function migrateWorldV4ToV5(raw: unknown): MigrationResult {
  if (!isRecord(raw)) return { ok: false, error: '存档 world 不是对象' };
  if (!Array.isArray(raw.cities) || raw.cities.length === 0) {
    return { ok: false, error: 'v4 存档缺少城市数据，无法迁移' };
  }
  if (!Array.isArray(raw.companies)) {
    return { ok: false, error: 'v4 存档缺少企业数据，无法迁移' };
  }
  const world = deepClone(raw) as unknown as WorldState & Record<string, unknown>;
  const config = DEMO_CONFIG;
  const timeValue = (world as unknown as Record<string, unknown>).time;
  const tick = isRecord(timeValue) && isFiniteNumber(timeValue.tick) ? timeValue.tick : 0;

  // 1. 居民群体：旧存档没有居民现金存量，迁移时不凭空造钱。
  const householdRecord = isRecord(world.households) ? world.households : null;
  if (!householdRecord || !Array.isArray(householdRecord.groups) || householdRecord.groups.length === 0) {
    world.households = migrateHouseholds(world as unknown as WorldState, config);
  } else if (!Array.isArray(householdRecord.lastStats)) {
    householdRecord.lastStats = [];
  }

  // 2. 银行：空账本 + 旧债务承接（公司债务是既有数据，必须保留而不是清零）。
  const bankingRecord = isRecord(world.banking) ? world.banking : null;
  if (!bankingRecord || !Array.isArray(bankingRecord.loans) || !Array.isArray(bankingRecord.deposits)) {
    world.banking = createInitialBanking(config);
  }
  migrateLegacyCompanyDebt(world as unknown as WorldState, config, tick);

  // 3. 经营者：旧存档没有经营者档案时确定性生成，并沿用企业既有风格。
  const managementRecord = isRecord(world.management) ? world.management : null;
  if (!managementRecord || !Array.isArray(managementRecord.operators) || managementRecord.operators.length === 0) {
    world.management = createInitialManagement(world as unknown as WorldState, config, tick);
  } else if (!Array.isArray(managementRecord.playerOperations)) {
    managementRecord.playerOperations = [];
  }

  // 4. 治理控制权补齐新字段（旧存档 control 没有 operatorId / termEndTick）。
  const governance = isRecord(world.governance) ? world.governance : null;
  if (governance && Array.isArray(governance.controls)) {
    for (const control of governance.controls as unknown as Record<string, unknown>[]) {
      if (typeof control.operatorId !== 'string') control.operatorId = null;
      if (!isFiniteNumber(control.termEndTick) && control.termEndTick !== null) {
        control.termEndTick = null;
      }
      if (control.basis !== 'management' && control.basis !== 'boardAppointment' && control.basis !== 'election') {
        control.basis = 'management';
      }
    }
  }

  // 5. 阶层统计快照。
  const households = world.households as unknown as WorldState['households'];
  households.lastStats = computeHouseholdWealthStats(world as unknown as WorldState, config, tick);

  return { ok: true, world: world as unknown as WorldState };
}

function snapshotVotingHolders(
  world: WorldState,  companyId: string,
): { holder: { type: 'player' | 'company' | 'investorGroup' | 'city'; id: string }; shares: number }[] {
  const votingClassIds = new Set(
    (world.securities?.classes ?? [])
      .filter((shareClass) => shareClass.companyId === companyId && shareClass.kind === 'voting')
      .map((shareClass) => shareClass.id),
  );
  const totals = new Map<string, { holder: { type: 'player' | 'company' | 'investorGroup' | 'city'; id: string }; shares: number }>();
  for (const holding of world.securities?.holdings ?? []) {
    if (holding.companyId !== companyId) continue;
    if (!votingClassIds.has(holding.shareClassId)) continue;
    if (!(holding.shares > 0)) continue;
    const key = `${holding.holder.type}:${holding.holder.id}`;
    const existing = totals.get(key);
    if (existing) existing.shares = round2(existing.shares + holding.shares);
    else {
      totals.set(key, {
        holder: { type: holding.holder.type, id: holding.holder.id },
        shares: round2(holding.shares),
      });
    }
  }
  return [...totals.values()].sort(
    (a, b) =>
      b.shares - a.shares ||
      a.holder.type.localeCompare(b.holder.type) ||
      a.holder.id.localeCompare(b.holder.id),
  );
}

function normalizeStats(value: Record<string, unknown>): WorldState['companies'][number]['lastMonth'] {  const stats = {} as WorldState['companies'][number]['lastMonth'];
  for (const key of STATS_KEYS) {
    stats[key] = isFiniteNumber(value[key]) ? (value[key] as number) : 0;
  }
  return stats;
}

// ---------------------------------------------------------------- v2 结构校验

/**
 * 读取侧的结构校验。只返回第一个明确错误，避免 checkInvariants 在缺失字段上抛 TypeError。
 * 所有数值必须是有限数；所有必需对象/数组/字符串都必须存在且类型正确。
 */
export function validateWorldStructure(world: unknown): string | null {
  if (!isRecord(world)) return 'world 不是对象';
  if (!isInteger(world.seed)) return 'world.seed 必须是整数';
  if (!isInteger(world.rngState)) return 'world.rngState 必须是整数';
  if (!isRecord(world.time)) return 'world.time 无效';
  if (!isInteger(world.time.year) || !isInteger(world.time.month) || !isInteger(world.time.tick)) {
    return 'world.time 必须包含整数 year/month/tick';
  }
  if (!Array.isArray(world.cities) || world.cities.length === 0) return 'world.cities 无效';
  if (!Array.isArray(world.companies) || world.companies.length === 0) {
    return 'world.companies 无效';
  }
  if (!Array.isArray(world.tradeRoutes)) return 'world.tradeRoutes 无效';
  if (!Array.isArray(world.history)) return 'world.history 无效';
  if (!Array.isArray(world.log)) return 'world.log 无效';

  const playerError = validatePlayer(world.player);
  if (playerError) return playerError;

  const cityIds = new Set<string>();
  for (let index = 0; index < world.cities.length; index++) {
    const error = validateCity(world.cities[index], index);
    if (error) return error;
    const city = world.cities[index] as Record<string, unknown>;
    const id = city.id as string;
    if (cityIds.has(id)) return `城市 ID 重复：${id}`;
    cityIds.add(id);
  }

  const companyIds = new Set<string>();
  for (let index = 0; index < world.companies.length; index++) {
    const error = validateCompany(world.companies[index], index);
    if (error) return error;
    const company = world.companies[index] as Record<string, unknown>;
    const id = company.id as string;
    if (companyIds.has(id)) return `企业 ID 重复：${id}`;
    companyIds.add(id);
    if (!cityIds.has(company.cityId as string)) {
      return `企业 ${id} 引用了不存在的城市 ${String(company.cityId)}`;
    }
  }

  const investorIds = new Set<string>();
  if (!Array.isArray(world.investors) || world.investors.length === 0) {
    return 'world.investors 必须是数组且至少包含一个居民投资实体';
  }
  for (let index = 0; index < world.investors.length; index++) {
    const error = validateInvestorGroup(world.investors[index], index, cityIds);
    if (error) return error;
    const group = world.investors[index] as Record<string, unknown>;
    const id = group.id as string;
    if (investorIds.has(id)) return `居民投资实体 ID 重复：${id}`;
    investorIds.add(id);
  }

  const holderCheck = (holder: unknown, path: string): string | null => {
    if (!isRecord(holder)) return `${path} 不是持有人对象`;
    if (
      holder.type !== 'player' &&
      holder.type !== 'company' &&
      holder.type !== 'investorGroup' &&
      holder.type !== 'city'
    ) {
      return `${path}.type 无效`;
    }
    if (typeof holder.id !== 'string') return `${path}.id 无效`;
    if (holder.type === 'player' && holder.id !== 'player') return `${path}.id 对玩家无效`;
    if (holder.type === 'company' && !companyIds.has(holder.id)) {
      return `${path} 引用了不存在的企业 ${holder.id}`;
    }
    if (holder.type === 'investorGroup' && !investorIds.has(holder.id)) {
      return `${path} 引用了不存在的居民投资实体 ${holder.id}`;
    }
    if (holder.type === 'city' && !cityIds.has(holder.id)) {
      return `${path} 引用了不存在的城市 ${holder.id}`;
    }
    return null;
  };

  const securitiesError = validateSecurities(world.securities, companyIds, holderCheck);
  if (securitiesError) return securitiesError;

  const governanceError = validateGovernance(world.governance, companyIds, holderCheck);
  if (governanceError) return governanceError;

  const agreementError = validateAgreements(world.agreements, companyIds, cityIds);
  if (agreementError) return agreementError;

  const notificationError = validateNotifications(world.notifications, companyIds, cityIds);
  if (notificationError) return notificationError;

  const politicsError = validatePolitics(world.politics, cityIds);
  if (politicsError) return politicsError;

  const policyError = validatePolicies(world.policies, world.fiscal, cityIds);
  if (policyError) return policyError;

  const transportError = validateTransport(world.transport, cityIds, companyIds);
  if (transportError) return transportError;

  const lifecycleError = validateLifecycle(world.lifecycle, cityIds);
  if (lifecycleError) return lifecycleError;

  // v0.4：居民群体、经营者与银行。
  const householdError = validateHouseholds(world.households, cityIds);
  if (householdError) return householdError;

  const managementError = validateManagement(world.management, companyIds, cityIds);
  if (managementError) return managementError;

  const bankingError = validateBanking(world.banking, cityIds, companyIds, investorIds);
  if (bankingError) return bankingError;

  for (let index = 0; index < world.tradeRoutes.length; index++) {
    const error = validateTradeRoute(world.tradeRoutes[index], index);
    if (error) return error;
    const route = world.tradeRoutes[index] as Record<string, unknown>;
    if (!cityIds.has(route.fromCityId as string) || !cityIds.has(route.toCityId as string)) {
      return `贸易路线 ${String(route.id)} 引用了不存在的城市`;
    }
    if (!companyIds.has(route.fromCompanyId as string) || !companyIds.has(route.toCompanyId as string)) {
      return `贸易路线 ${String(route.id)} 引用了不存在的企业`;
    }
  }

  const player = world.player as Record<string, unknown>;
  if (!cityIds.has(player.homeCityId as string)) {
    return '玩家 homeCityId 引用了不存在的城市';
  }
  for (const holding of player.holdings as unknown[]) {
    if (!companyIds.has((holding as Record<string, unknown>).companyId as string)) {
      return '玩家持股引用了不存在的企业';
    }
  }

  for (let index = 0; index < world.history.length; index++) {
    const error = validateHistoryPoint(world.history[index], index);
    if (error) return error;
  }
  for (let index = 0; index < world.log.length; index++) {
    const error = validateLogEntry(world.log[index], index);
    if (error) return error;
  }

  if (!isRecord(world.lastTick)) return 'world.lastTick 无效';
  for (const key of ['productionRecords', 'tradeFlows', 'externalExports', 'migration', 'invariants']) {
    if (!Array.isArray(world.lastTick[key])) return `world.lastTick.${key} 必须是数组`;
  }
  const lastTickError = validateLastTick(world.lastTick);
  if (lastTickError) return lastTickError;

  return null;
}

function validateLastTick(value: Record<string, unknown>): string | null {
  for (let index = 0; index < (value.productionRecords as unknown[]).length; index++) {
    const record = (value.productionRecords as unknown[])[index];
    if (!isRecord(record)) return `lastTick.productionRecords[${index}] 不是对象`;
    for (const key of ['tick', 'qty', 'outputValue', 'inputValue', 'valueAdded']) {
      if (!isFiniteNumber(record[key])) return `lastTick.productionRecords[${index}].${key} 无效`;
    }
    if (typeof record.cityId !== 'string' || typeof record.companyId !== 'string') {
      return `lastTick.productionRecords[${index}] 主体无效`;
    }
    if (typeof record.good !== 'string' || !(GOOD_IDS as readonly string[]).includes(record.good)) {
      return `lastTick.productionRecords[${index}].good 无效`;
    }
    if (!Array.isArray(record.inputs)) return `lastTick.productionRecords[${index}].inputs 无效`;
  }
  for (let index = 0; index < (value.tradeFlows as unknown[]).length; index++) {
    const flow = (value.tradeFlows as unknown[])[index];
    if (!isRecord(flow)) return `lastTick.tradeFlows[${index}] 不是对象`;
    for (const key of ['tick', 'qty', 'unitPrice', 'value']) {
      if (!isFiniteNumber(flow[key])) return `lastTick.tradeFlows[${index}].${key} 无效`;
    }
    for (const key of ['routeId', 'fromCityId', 'toCityId', 'fromCompanyId', 'toCompanyId']) {
      if (typeof flow[key] !== 'string') return `lastTick.tradeFlows[${index}].${key} 无效`;
    }
    if (typeof flow.good !== 'string' || !(GOOD_IDS as readonly string[]).includes(flow.good)) {
      return `lastTick.tradeFlows[${index}].good 无效`;
    }
  }
  for (let index = 0; index < (value.externalExports as unknown[]).length; index++) {
    const entry = (value.externalExports as unknown[])[index];
    if (!isRecord(entry)) return `lastTick.externalExports[${index}] 不是对象`;
    if (typeof entry.cityId !== 'string' || typeof entry.note !== 'string') {
      return `lastTick.externalExports[${index}] 字段无效`;
    }
    if (typeof entry.good !== 'string' || !(GOOD_IDS as readonly string[]).includes(entry.good)) {
      return `lastTick.externalExports[${index}].good 无效`;
    }
    for (const key of ['tick', 'qty', 'unitPrice', 'value']) {
      if (!isFiniteNumber(entry[key])) return `lastTick.externalExports[${index}].${key} 无效`;
    }
  }
  for (let index = 0; index < (value.migration as unknown[]).length; index++) {
    const entry = (value.migration as unknown[])[index];
    if (!isRecord(entry)) return `lastTick.migration[${index}] 不是对象`;
    if (typeof entry.fromCityId !== 'string' || typeof entry.toCityId !== 'string') {
      return `lastTick.migration[${index}] 城市无效`;
    }
    if (!isFiniteNumber(entry.people) || !isFiniteNumber(entry.laborForce)) {
      return `lastTick.migration[${index}] 人数无效`;
    }
  }
  if (!(value.invariants as unknown[]).every((entry) => typeof entry === 'string')) {
    return 'lastTick.invariants 必须全是字符串';
  }
  return null;
}

function validatePlayer(value: unknown): string | null {
  if (!isRecord(value)) return 'world.player 无效';
  if (typeof value.name !== 'string') return 'player.name 无效';
  if (typeof value.homeCityId !== 'string') return 'player.homeCityId 无效';
  if (!isFiniteNumber(value.cash)) return 'player.cash 必须是有限数值';
  if (
    value.lastDividend !== undefined &&
    (!isFiniteNumber(value.lastDividend) || value.lastDividend < 0)
  ) {
    return 'player.lastDividend 必须是有限非负数';
  }
  if (
    value.dividendsReceived !== undefined &&
    (!isFiniteNumber(value.dividendsReceived) || value.dividendsReceived < 0)
  ) {
    return 'player.dividendsReceived 必须是有限非负数';
  }
  if (!isRecord(value.roles)) return 'player.roles 无效';
  if (value.roles.mayorCityId !== null && typeof value.roles.mayorCityId !== 'string') {
    return 'player.roles.mayorCityId 必须是城市 ID 或 null';
  }
  if (typeof value.note !== 'string') return 'player.note 无效';
  if (!Array.isArray(value.holdings)) return 'player.holdings 必须是数组';
  for (let index = 0; index < value.holdings.length; index++) {
    const holding = value.holdings[index];
    if (!isRecord(holding)) return `player.holdings[${index}] 不是对象`;
    if (typeof holding.companyId !== 'string') return `player.holdings[${index}].companyId 无效`;
    if (!isFiniteNumber(holding.shares) || holding.shares < 0) {
      return `player.holdings[${index}].shares 必须是有限非负数`;
    }
  }
  return null;
}

function validateCity(value: unknown, index: number): string | null {
  if (!isRecord(value)) return `cities[${index}] 不是对象`;
  const id = typeof value.id === 'string' ? value.id : `cities[${index}]`;
  for (const key of ['id', 'name', 'englishName', 'tagline', 'color']) {
    if (typeof value[key] !== 'string') return `城市 ${id}.${key} 无效`;
  }

  if (!isRecord(value.region)) return `城市 ${id} 缺少 region`;
  for (const key of ['x', 'y', 'radius']) {
    if (!isFiniteNumber(value.region[key])) return `城市 ${id}.region.${key} 必须是有限数值`;
  }

  const population = value.population;
  if (!isRecord(population)) return `城市 ${id} 缺少 population`;
  for (const key of ['total', 'employed', 'unemployed', 'nonLabor', 'laborForce']) {
    if (!isFiniteNumber(population[key])) return `城市 ${id}.population.${key} 必须是有限数值`;
  }

  const publicSector = value.publicSector;
  if (!isRecord(publicSector)) return `城市 ${id} 缺少 publicSector`;
  for (const key of ['jobs', 'employees', 'wageRate']) {
    if (!isFiniteNumber(publicSector[key])) return `城市 ${id}.publicSector.${key} 必须是有限数值`;
  }

  for (const key of [
    'treasury', 'incomeTaxRate', 'corporateTaxRate', 'unemploymentBenefit',
    'nonLaborTransfer', 'householdIncomeLastMonth', 'gdp',
  ]) {
    if (!isFiniteNumber(value[key])) return `城市 ${id}.${key} 必须是有限数值`;
  }

  const market = value.market;
  if (!isRecord(market)) return `城市 ${id} 缺少 market`;
  for (const goodId of GOOD_IDS) {
    const entry = market[goodId];
    const error = validateMarket(entry, `城市 ${id}.market.${goodId}`);
    if (error) return error;
  }

  if (!Array.isArray(value.gdpHistory)) return `城市 ${id}.gdpHistory 必须是数组`;
  for (let i = 0; i < value.gdpHistory.length; i++) {
    const point = value.gdpHistory[i];
    if (!isRecord(point) || !isFiniteNumber(point.tick) || !isFiniteNumber(point.value)) {
      return `城市 ${id}.gdpHistory[${i}] 无效`;
    }
  }

  const lastMonth = value.lastMonth;
  if (!isRecord(lastMonth)) return `城市 ${id} 缺少 lastMonth`;
  for (const key of [
    'householdIncome', 'consumerSpend', 'consumerBudget', 'benefitsPaid', 'incomeTax',
    'corporateTax', 'publicWageBill', 'gdp', 'migrationIn', 'migrationOut',
    'investorDividends', 'investableContribution', 'policySpending', 'transportSpending',
  ]) {
    if (!isFiniteNumber(lastMonth[key])) return `城市 ${id}.lastMonth.${key} 必须是有限数值`;
  }
  if (typeof lastMonth.note !== 'string') return `城市 ${id}.lastMonth.note 无效`;

  const workforce = value.workforce;
  if (!isRecord(workforce)) return `城市 ${id} 缺少 workforce`;
  for (const key of ['skillLevel', 'trainedThisMonth', 'trainedTotal', 'trainedLastTick']) {
    if (!isFiniteNumber(workforce[key])) return `城市 ${id}.workforce.${key} 必须是有限数值`;
  }
  if ((workforce.skillLevel as number) < 0 || (workforce.skillLevel as number) > 1) {
    return `城市 ${id}.workforce.skillLevel 必须在 0–1 之间`;
  }

  const housing = value.housing;
  if (!isRecord(housing)) return `城市 ${id} 缺少 housing`;
  for (const key of ['units', 'demand', 'rentSubsidyPaid']) {
    if (!isFiniteNumber(housing[key])) return `城市 ${id}.housing.${key} 必须是有限数值`;
  }
  if ((housing.units as number) < 0) return `城市 ${id}.housing.units 不能为负`;

  const technology = value.technology;
  if (!isRecord(technology)) return `城市 ${id} 缺少 technology`;
  for (const key of ['level', 'researchPoints', 'productivityMultiplier']) {
    if (!isFiniteNumber(technology[key])) return `城市 ${id}.technology.${key} 必须是有限数值`;
  }
  if (technology.status !== 'initial-only' && technology.status !== 'active') {
    return `城市 ${id}.technology 状态无效`;
  }
  if (typeof technology.note !== 'string') return `城市 ${id}.technology.note 无效`;

  const politics = value.politics;
  if (!isRecord(politics)) return `城市 ${id} 缺少 politics`;
  if (!isFiniteNumber(politics.approval) || typeof politics.rulingParty !== 'string') {
    return `城市 ${id}.politics 无效`;
  }
  if (
    politics.electionInMonths !== null &&
    !isFiniteNumber(politics.electionInMonths)
  ) {
    return `城市 ${id}.politics.electionInMonths 无效`;
  }
  if (politics.status !== 'initial-only' && politics.status !== 'active') {
    return `城市 ${id}.politics 状态无效`;
  }
  if (typeof politics.note !== 'string') return `城市 ${id}.politics.note 无效`;

  const realEstate = value.realEstate;
  if (!isRecord(realEstate)) return `城市 ${id} 缺少 realEstate`;
  for (const key of ['avgHomePrice', 'rentIndex', 'vacancyRate']) {
    if (!isFiniteNumber(realEstate[key])) return `城市 ${id}.realEstate.${key} 必须是有限数值`;
  }
  if (realEstate.status !== 'initial-only' || typeof realEstate.note !== 'string') {
    return `城市 ${id}.realEstate 状态无效`;
  }

  return null;
}

function validateMarket(value: unknown, path: string): string | null {
  if (!isRecord(value)) return `${path} 缺失`;
  if (typeof value.goodId !== 'string') return `${path}.goodId 无效`;
  for (const key of [
    'price', 'supply', 'demand', 'consumerDemand', 'producerDemand', 'sold',
    'unmetDemand', 'intercityImported', 'externalExport', 'closingStock',
    'lastPriceChangePct',
  ]) {
    if (!isFiniteNumber(value[key])) return `${path}.${key} 必须是有限数值`;
  }
  return null;
}

function validateCompany(value: unknown, index: number): string | null {
  if (!isRecord(value)) return `companies[${index}] 不是对象`;
  const id = typeof value.id === 'string' ? value.id : `companies[${index}]`;
  for (const key of ['id', 'name', 'cityId', 'note']) {
    if (typeof value[key] !== 'string') return `企业 ${id}.${key} 无效`;
  }
  if (typeof value.sector !== 'string' || !SECTOR_IDS.has(value.sector)) {
    return `企业 ${id}.sector 无效`;
  }
  if (typeof value.recipeOutput !== 'string' || !(GOOD_IDS as readonly string[]).includes(value.recipeOutput)) {
    return `企业 ${id}.recipeOutput 无效`;
  }
  for (const key of [
    'cash', 'debt', 'capacity', 'baseCapacity', 'maxCapacity', 'utilization',
    'employees', 'baseWageBill', 'jobDemand', 'wageRate', 'priceFactor', 'totalShares',
    'dividendPayoutRatio',
  ]) {
    if (!isFiniteNumber(value[key])) return `企业 ${id}.${key} 必须是有限数值`;
  }

  const roles = value.roles;
  if (!isRecord(roles)) return `企业 ${id} 缺少 roles`;
  for (const key of ROLE_KEYS) {
    if (!isFiniteNumber(roles[key])) return `企业 ${id}.roles.${key} 必须是有限数值`;
  }

  const inventory = value.inventory;
  if (!isRecord(inventory)) return `企业 ${id} 缺少 inventory`;
  for (const goodId of GOOD_IDS) {
    if (!isFiniteNumber(inventory[goodId])) return `企业 ${id}.inventory.${goodId} 必须是有限数值`;
  }

  const lastMonth = value.lastMonth;
  if (!isRecord(lastMonth)) return `企业 ${id} 缺少 lastMonth`;
  for (const key of STATS_KEYS) {
    if (!isFiniteNumber(lastMonth[key])) return `企业 ${id}.lastMonth.${key} 必须是有限数值`;
  }

  const previousMonth = value.previousMonth;
  if (!isRecord(previousMonth)) return `企业 ${id} 缺少 previousMonth`;
  for (const key of STATS_KEYS) {
    if (!isFiniteNumber(previousMonth[key])) return `企业 ${id}.previousMonth.${key} 必须是有限数值`;
  }

  const ai = value.ai;
  if (!isRecord(ai)) return `企业 ${id} 缺少 ai`;
  if (ai.style !== 'growth' && ai.style !== 'steady' && ai.style !== 'return') {
    return `企业 ${id}.ai.style 无效`;
  }
  if (!isFiniteNumber(ai.riskTolerance) || !isFiniteNumber(ai.lossMonths) || !isFiniteNumber(ai.ageMonths)) {
    return `企业 ${id}.ai 数值字段无效`;
  }
  if (typeof ai.lastDecision !== 'string' || !isFiniteNumber(ai.lastDecisionTick)) {
    return `企业 ${id}.ai 决策记录无效`;
  }
  if (ai.lastPlan !== null) {
    if (!isRecord(ai.lastPlan)) return `企业 ${id}.ai.lastPlan 无效`;
    for (const key of [
      'tick', 'utilization', 'targetJobs', 'expectedWageCost',
      'hiringSubsidyPerHire', 'retentionSubsidyPerEmployee', 'investment',
    ]) {
      if (!isFiniteNumber(ai.lastPlan[key])) return `企业 ${id}.ai.lastPlan.${key} 无效`;
    }
    if (!Array.isArray(ai.lastPlan.reasons)) return `企业 ${id}.ai.lastPlan.reasons 无效`;
  }
  return null;
}

function validateTradeRoute(value: unknown, index: number): string | null {
  if (!isRecord(value)) return `tradeRoutes[${index}] 不是对象`;
  const id = typeof value.id === 'string' ? value.id : `tradeRoutes[${index}]`;
  for (const key of ['id', 'fromCityId', 'toCityId', 'fromCompanyId', 'toCompanyId', 'note']) {
    if (typeof value[key] !== 'string') return `贸易路线 ${id}.${key} 无效`;
  }
  if (typeof value.good !== 'string' || !(GOOD_IDS as readonly string[]).includes(value.good)) {
    return `贸易路线 ${id}.good 无效`;
  }
  if (!isFiniteNumber(value.monthlyTarget) || !isFiniteNumber(value.distanceKm)) {
    return `贸易路线 ${id} 的数值字段无效`;
  }
  if (typeof value.active !== 'boolean') return `贸易路线 ${id}.active 无效`;
  return null;
}

function validateHistoryPoint(value: unknown, index: number): string | null {
  if (!isRecord(value)) return `history[${index}] 不是对象`;
  for (const key of ['tick', 'year', 'month', 'population', 'employed', 'unemployed', 'gdp', 'playerNetWorth']) {
    if (!isFiniteNumber(value[key])) return `history[${index}].${key} 必须是有限数值`;
  }
  return null;
}

function validateLogEntry(value: unknown, index: number): string | null {
  if (!isRecord(value)) return `log[${index}] 不是对象`;
  if (!isFiniteNumber(value.tick)) return `log[${index}].tick 必须是有限数值`;
  if (typeof value.kind !== 'string' || !LOG_KINDS.has(value.kind)) {
    return `log[${index}].kind 无效`;
  }
  if (typeof value.message !== 'string') return `log[${index}].message 无效`;
  return null;
}

// ---------------------------------------------------------------- v2 新结构校验

type HolderCheck = (holder: unknown, path: string) => string | null;

function validateInvestorGroup(value: unknown, index: number, cityIds: Set<string>): string | null {
  if (!isRecord(value)) return `investors[${index}] 不是对象`;
  const id = typeof value.id === 'string' ? value.id : `investors[${index}]`;
  for (const key of ['id', 'name', 'note']) {
    if (typeof value[key] !== 'string') return `居民投资实体 ${id}.${key} 无效`;
  }
  if (typeof value.cityId !== 'string' || !cityIds.has(value.cityId)) {
    return `居民投资实体 ${id}.cityId 无效`;
  }
  for (const key of ['cash', 'populationShare', 'riskAppetite', 'dividendsReceived', 'lastDividend']) {
    if (!isFiniteNumber(value[key])) return `居民投资实体 ${id}.${key} 必须是有限数值`;
  }
  if ((value.cash as number) < -0.01) return `居民投资实体 ${id}.cash 不能为负`;
  return null;
}

function validateSecurities(
  value: unknown,
  companyIds: Set<string>,
  holderCheck: HolderCheck,
): string | null {
  if (!isRecord(value)) return 'world.securities 无效';
  if (!Array.isArray(value.classes)) return 'securities.classes 必须是数组';
  if (!Array.isArray(value.holdings)) return 'securities.holdings 必须是数组';
  if (!Array.isArray(value.orders)) return 'securities.orders 必须是数组';
  if (!Array.isArray(value.lastTrades)) return 'securities.lastTrades 必须是数组';
  if (!Array.isArray(value.offers)) return 'securities.offers 必须是数组';

  const classById = new Map<string, { companyId: string; kind: string }>();
  const kindsByCompany = new Map<string, Set<string>>();
  for (let index = 0; index < value.classes.length; index++) {
    const shareClass = value.classes[index];
    if (!isRecord(shareClass)) return `securities.classes[${index}] 不是对象`;
    if (typeof shareClass.id !== 'string') return `securities.classes[${index}].id 无效`;
    if (classById.has(shareClass.id)) return `股份类别 ID 重复：${shareClass.id}`;
    if (typeof shareClass.companyId !== 'string' || !companyIds.has(shareClass.companyId)) {
      return `股份类别 ${shareClass.id} 引用了不存在的企业`;
    }
    if (shareClass.kind !== 'voting' && shareClass.kind !== 'nonVoting') {
      return `股份类别 ${shareClass.id}.kind 无效`;
    }
    if (!isFiniteNumber(shareClass.issuedShares) || shareClass.issuedShares < 0) {
      return `股份类别 ${shareClass.id}.issuedShares 无效`;
    }
    if (typeof shareClass.note !== 'string') return `股份类别 ${shareClass.id}.note 无效`;
    classById.set(shareClass.id, {
      companyId: shareClass.companyId,
      kind: shareClass.kind,
    });
    const set = kindsByCompany.get(shareClass.companyId) ?? new Set<string>();
    set.add(shareClass.kind);
    kindsByCompany.set(shareClass.companyId, set);
  }
  for (const companyId of companyIds) {
    const kinds = kindsByCompany.get(companyId);
    if (!kinds || !kinds.has('voting') || !kinds.has('nonVoting')) {
      return `企业 ${companyId} 必须同时拥有有投票权与仅分红两类股份`;
    }
  }

  for (let index = 0; index < value.holdings.length; index++) {
    const holding = value.holdings[index];
    if (!isRecord(holding)) return `securities.holdings[${index}] 不是对象`;
    const shareClassId = holding.shareClassId;
    if (typeof shareClassId !== 'string' || !classById.has(shareClassId)) {
      return `持股记录 ${index} 的股份类别无效`;
    }
    const shareClass = classById.get(shareClassId)!;
    if (holding.companyId !== shareClass.companyId) {
      return `持股记录 ${index} 的企业与股份类别不一致`;
    }
    const holderError = holderCheck(holding.holder, `securities.holdings[${index}].holder`);
    if (holderError) return holderError;
    if (!isFiniteNumber(holding.shares) || holding.shares < 0) {
      return `持股记录 ${index}.shares 无效`;
    }
    if (
      holding.acquiredVia !== 'primary' &&
      holding.acquiredVia !== 'secondary' &&
      holding.acquiredVia !== 'migration'
    ) {
      return `持股记录 ${index}.acquiredVia 无效`;
    }
    if (!isInteger(holding.sinceTick)) return `持股记录 ${index}.sinceTick 无效`;
  }

  for (let index = 0; index < value.orders.length; index++) {
    const order = value.orders[index];
    if (!isRecord(order)) return `securities.orders[${index}] 不是对象`;
    if (typeof order.id !== 'string') return `securities.orders[${index}].id 无效`;
    if (typeof order.shareClassId !== 'string' || !classById.has(order.shareClassId)) {
      return `股票订单 ${order.id} 的股份类别无效`;
    }
    if (order.companyId !== classById.get(order.shareClassId)!.companyId) {
      return `股票订单 ${order.id} 的企业与股份类别不一致`;
    }
    if (order.side !== 'buy' && order.side !== 'sell') return `股票订单 ${order.id}.side 无效`;
    const holderError = holderCheck(order.holder, `securities.orders[${index}].holder`);
    if (holderError) return holderError;
    if (!isFiniteNumber(order.shares) || order.shares < 0) return `股票订单 ${order.id}.shares 无效`;
    if (!isFiniteNumber(order.limitPrice) || order.limitPrice <= 0) {
      return `股票订单 ${order.id}.limitPrice 无效`;
    }
    if (!isInteger(order.createdTick)) return `股票订单 ${order.id}.createdTick 无效`;
    if (typeof order.note !== 'string') return `股票订单 ${order.id}.note 无效`;
    // 市场买入限制只针对买方身份：企业作为买方只能买有投票权股份；卖出不受此限制。
    const orderHolder = order.holder as Record<string, unknown>;
    if (
      order.side === 'buy' &&
      orderHolder.type === 'company' &&
      classById.get(order.shareClassId)!.kind !== 'voting'
    ) {
      return `企业 ${String(orderHolder.id)} 的股票买单只能是有投票权股份`;
    }
  }

  for (let index = 0; index < value.lastTrades.length; index++) {
    const trade = value.lastTrades[index];
    if (!isRecord(trade)) return `securities.lastTrades[${index}] 不是对象`;
    if (typeof trade.id !== 'string' || typeof trade.companyId !== 'string') {
      return `securities.lastTrades[${index}] 标识无效`;
    }
    if (typeof trade.shareClassId !== 'string' || !classById.has(trade.shareClassId)) {
      return `securities.lastTrades[${index}] 股份类别无效`;
    }
    for (const side of ['buyer', 'seller'] as const) {
      const holderError = holderCheck(trade[side], `securities.lastTrades[${index}].${side}`);
      if (holderError) return holderError;
    }
    for (const key of ['shares', 'unitPrice', 'value', 'tick']) {
      if (!isFiniteNumber(trade[key])) return `securities.lastTrades[${index}].${key} 无效`;
    }
    if (trade.origin !== 'secondary' && trade.origin !== 'primary') {
      return `securities.lastTrades[${index}].origin 无效`;
    }
  }

  for (let index = 0; index < value.offers.length; index++) {
    const offer = value.offers[index];
    if (!isRecord(offer)) return `securities.offers[${index}] 不是对象`;
    if (typeof offer.id !== 'string') return `securities.offers[${index}].id 无效`;
    if (typeof offer.companyId !== 'string' || !companyIds.has(offer.companyId)) {
      return `融资要约 ${offer.id} 引用了不存在的企业`;
    }
    const holderError = holderCheck(offer.investor, `securities.offers[${index}].investor`);
    if (holderError) return holderError;
    if (offer.kind !== 'voting' && offer.kind !== 'nonVoting') {
      return `融资要约 ${offer.id}.kind 无效`;
    }
    for (const key of ['amount', 'pricePerShare', 'shares', 'createdTick']) {
      if (!isFiniteNumber(offer[key])) return `融资要约 ${offer.id}.${key} 无效`;
    }
    if (
      offer.status !== 'open' &&
      offer.status !== 'accepted' &&
      offer.status !== 'declined' &&
      offer.status !== 'expired'
    ) {
      return `融资要约 ${offer.id}.status 无效`;
    }
    if (typeof offer.note !== 'string') return `融资要约 ${offer.id}.note 无效`;
  }

  return null;
}

function validateGovernance(
  value: unknown,
  companyIds: Set<string>,
  holderCheck: HolderCheck,
): string | null {
  if (!isRecord(value)) return 'world.governance 无效';
  for (const key of ['boards', 'motions', 'controls']) {
    if (!Array.isArray(value[key])) return `governance.${key} 必须是数组`;
  }

  for (let index = 0; index < (value.boards as unknown[]).length; index++) {
    const board = (value.boards as unknown[])[index];
    if (!isRecord(board)) return `governance.boards[${index}] 不是对象`;
    if (typeof board.companyId !== 'string' || !companyIds.has(board.companyId)) {
      return `董事会 ${index} 引用了不存在的企业`;
    }
    if (!Array.isArray(board.seats)) return `董事会 ${index}.seats 无效`;
    for (let seatIndex = 0; seatIndex < board.seats.length; seatIndex++) {
      const seat = board.seats[seatIndex];
      if (!isRecord(seat)) return `董事会 ${index}.seats[${seatIndex}] 不是对象`;
      const holderError = holderCheck(seat.holder, `governance.boards[${index}].seats[${seatIndex}].holder`);
      if (holderError) return holderError;
      if (!isFiniteNumber(seat.votingShares) || !isInteger(seat.sinceTick)) {
        return `董事会 ${index}.seats[${seatIndex}] 数值无效`;
      }
    }
    if (board.chair !== null) {
      const holderError = holderCheck(board.chair, `governance.boards[${index}].chair`);
      if (holderError) return holderError;
    }
    if (!isInteger(board.lastElectionTick) || typeof board.note !== 'string') {
      return `董事会 ${index} 状态字段无效`;
    }
  }

  for (let index = 0; index < (value.motions as unknown[]).length; index++) {
    const motion = (value.motions as unknown[])[index];
    if (!isRecord(motion)) return `governance.motions[${index}] 不是对象`;
    if (typeof motion.id !== 'string') return `governance.motions[${index}].id 无效`;
    if (typeof motion.companyId !== 'string' || !companyIds.has(motion.companyId)) {
      return `议案 ${motion.id} 引用了不存在的企业`;
    }
    if (
      motion.kind !== 'dividendPolicy' &&
      motion.kind !== 'operatorAppointment' &&
      motion.kind !== 'operatorElection'
    ) {
      return `议案 ${motion.id}.kind 无效`;
    }
    if (typeof motion.title !== 'string' || !isRecord(motion.params)) {
      return `议案 ${motion.id} 描述无效`;
    }
    for (const paramValue of Object.values(motion.params)) {
      if (typeof paramValue !== 'string' && !isFiniteNumber(paramValue)) {
        return `议案 ${motion.id}.params 含无效值`;
      }
    }
    const holderError = holderCheck(motion.proposedBy, `governance.motions[${index}].proposedBy`);
    if (holderError) return holderError;
    // v0.4：经营者选任议案的候选人名单（候选人在议案创建时固定，玩家可登记加入）。
    const candidateIds = new Set<string>();
    if (motion.candidates !== undefined) {
      if (!Array.isArray(motion.candidates)) return `议案 ${motion.id}.candidates 必须是数组`;
      for (let candidateIndex = 0; candidateIndex < motion.candidates.length; candidateIndex++) {
        const candidate = motion.candidates[candidateIndex];
        if (!isRecord(candidate)) return `议案 ${motion.id}.candidates[${candidateIndex}] 不是对象`;
        if (typeof candidate.candidateId !== 'string' || candidate.candidateId.length === 0) {
          return `议案 ${motion.id}.candidates[${candidateIndex}].candidateId 无效`;
        }
        if (candidateIds.has(candidate.candidateId)) {
          return `议案 ${motion.id}.candidates 存在重复候选人 ${candidate.candidateId}`;
        }
        candidateIds.add(candidate.candidateId);
        if (candidate.kind !== 'ai' && candidate.kind !== 'player') {
          return `议案 ${motion.id}.candidates[${candidateIndex}].kind 无效`;
        }
        if (candidate.operatorId !== null && typeof candidate.operatorId !== 'string') {
          return `议案 ${motion.id}.candidates[${candidateIndex}].operatorId 无效`;
        }
        if (typeof candidate.name !== 'string' || typeof candidate.isIncumbent !== 'boolean') {
          return `议案 ${motion.id}.candidates[${candidateIndex}] 字段无效`;
        }
        if (
          candidate.style !== null &&
          candidate.style !== 'growth' &&
          candidate.style !== 'steady' &&
          candidate.style !== 'return'
        ) {
          return `议案 ${motion.id}.candidates[${candidateIndex}].style 无效`;
        }
      }
    } else if (motion.kind === 'operatorElection') {
      return `选任议案 ${motion.id} 缺少候选人名单`;
    }
    if (!isInteger(motion.createdTick) || !isInteger(motion.closesAtTick)) {
      return `议案 ${motion.id} 时间字段无效`;
    }
    if (motion.status !== 'open' && motion.status !== 'passed' && motion.status !== 'rejected') {
      return `议案 ${motion.id}.status 无效`;
    }
    if (!Array.isArray(motion.eligible)) return `议案 ${motion.id}.eligible 必须是数组`;
    const eligibility = new Map<string, number>();
    for (let entryIndex = 0; entryIndex < motion.eligible.length; entryIndex++) {
      const entry = motion.eligible[entryIndex];
      if (!isRecord(entry)) return `议案 ${motion.id}.eligible[${entryIndex}] 不是对象`;
      const entryError = holderCheck(
        entry.holder,
        `governance.motions[${index}].eligible[${entryIndex}].holder`,
      );
      if (entryError) return entryError;
      if (!isFiniteNumber(entry.shares) || entry.shares < 0) {
        return `议案 ${motion.id}.eligible[${entryIndex}].shares 无效`;
      }
      const holder = entry.holder as Record<string, unknown>;
      const key = `${String(holder.type)}:${String(holder.id)}`;
      if (eligibility.has(key)) return `议案 ${motion.id}.eligible 存在重复持有人 ${key}`;
      eligibility.set(key, entry.shares);
    }
    if (!Array.isArray(motion.votes)) return `议案 ${motion.id}.votes 无效`;
    for (let voteIndex = 0; voteIndex < motion.votes.length; voteIndex++) {
      const vote = motion.votes[voteIndex];
      if (!isRecord(vote)) return `议案 ${motion.id}.votes[${voteIndex}] 不是对象`;
      const voteError = holderCheck(vote.holder, `governance.motions[${index}].votes[${voteIndex}].holder`);
      if (voteError) return voteError;
      if (vote.vote !== 'for' && vote.vote !== 'against' && vote.vote !== 'abstain') {
        return `议案 ${motion.id}.votes[${voteIndex}].vote 无效`;
      }
      if (!isFiniteNumber(vote.votingShares) || !isInteger(vote.tick)) {
        return `议案 ${motion.id}.votes[${voteIndex}] 数值无效`;
      }
      // v0.4：选任议案的每一票必须指向候选人名单中的一位。
      if (motion.kind === 'operatorElection') {
        if (typeof vote.candidateId !== 'string' || !candidateIds.has(vote.candidateId)) {
          return `选任议案 ${motion.id}.votes[${voteIndex}].candidateId 无效`;
        }
      } else if (vote.candidateId !== undefined) {
        return `非选任议案 ${motion.id}.votes[${voteIndex}] 不应包含 candidateId`;
      }
      const voter = vote.holder as Record<string, unknown>;
      const voterKey = `${String(voter.type)}:${String(voter.id)}`;
      const entitled = eligibility.get(voterKey);
      if (entitled === undefined) {
        return `议案 ${motion.id} 的投票人 ${voterKey} 不在登记日快照内`;
      }
      if (vote.votingShares > entitled + 0.01) {
        return `议案 ${motion.id} 的投票人 ${voterKey} 票数超过登记日持股`;
      }
    }
    if (motion.decidedTick !== null && !isInteger(motion.decidedTick)) {
      return `议案 ${motion.id}.decidedTick 无效`;
    }
    if (typeof motion.result !== 'string' || typeof motion.note !== 'string') {
      return `议案 ${motion.id} 文本字段无效`;
    }
  }

  for (let index = 0; index < (value.controls as unknown[]).length; index++) {
    const control = (value.controls as unknown[])[index];
    if (!isRecord(control)) return `governance.controls[${index}] 不是对象`;
    if (typeof control.companyId !== 'string' || !companyIds.has(control.companyId)) {
      return `经营控制记录 ${index} 引用了不存在的企业`;
    }
    if (control.operator !== 'management') {
      const holderError = holderCheck(control.operator, `governance.controls[${index}].operator`);
      if (holderError) return holderError;
    }
    if (
      control.basis !== 'management' &&
      control.basis !== 'boardAppointment' &&
      control.basis !== 'election'
    ) {
      return `经营控制记录 ${index}.basis 无效`;
    }
    // v0.4：经营者档案引用与任期（旧档迁移会补 null）。
    if (control.operatorId !== undefined && control.operatorId !== null) {
      if (typeof control.operatorId !== 'string') return `经营控制记录 ${index}.operatorId 无效`;
    }
    if (control.termEndTick !== undefined && control.termEndTick !== null) {
      if (!isInteger(control.termEndTick)) return `经营控制记录 ${index}.termEndTick 无效`;
    }
    if (!isInteger(control.sinceTick) || typeof control.note !== 'string') {
      return `经营控制记录 ${index} 字段无效`;
    }
  }

  return null;
}

function validateAgreements(
  value: unknown,
  companyIds: Set<string>,
  cityIds: Set<string>,
): string | null {
  if (!Array.isArray(value)) return 'world.agreements 必须是数组';
  for (let index = 0; index < value.length; index++) {
    const agreement = value[index];
    if (!isRecord(agreement)) return `agreements[${index}] 不是对象`;
    if (typeof agreement.id !== 'string' || typeof agreement.title !== 'string') {
      return `agreements[${index}] 标识无效`;
    }
    if (typeof agreement.sponsorCityId !== 'string' || !cityIds.has(agreement.sponsorCityId)) {
      return `协议 ${agreement.id} 的发起城市无效`;
    }
    if (typeof agreement.partnerCityId !== 'string' || !cityIds.has(agreement.partnerCityId)) {
      return `协议 ${agreement.id} 的伙伴城市无效`;
    }
    if (!isInteger(agreement.createdTick)) return `协议 ${agreement.id}.createdTick 无效`;
    if (agreement.createdBy !== 'government' && agreement.createdBy !== 'demo') {
      return `协议 ${agreement.id}.createdBy 无效`;
    }
    if (
      agreement.status !== 'proposed' &&
      agreement.status !== 'active' &&
      agreement.status !== 'completed' &&
      agreement.status !== 'cancelled'
    ) {
      return `协议 ${agreement.id}.status 无效`;
    }
    if (!Array.isArray(agreement.participants) || !Array.isArray(agreement.items)) {
      return `协议 ${agreement.id} 缺少参与方或条目`;
    }
    for (let p = 0; p < agreement.participants.length; p++) {
      const participant = agreement.participants[p];
      if (!isRecord(participant)) return `协议 ${agreement.id}.participants[${p}] 不是对象`;
      // 企业倒闭后协议会被标记为 declined/failed 留作审计；终态记录允许指向已退出的企业。
      if (
        typeof participant.companyId !== 'string' ||
        (!companyIds.has(participant.companyId) && participant.decision !== 'declined')
      ) {
        return `协议 ${agreement.id} 的参与企业无效`;
      }
      if (typeof participant.cityId !== 'string' || !cityIds.has(participant.cityId)) {
        return `协议 ${agreement.id} 的参与城市无效`;
      }
      if (participant.side !== 'buyer' && participant.side !== 'seller') {
        return `协议 ${agreement.id}.participants[${p}].side 无效`;
      }
      if (
        participant.decision !== 'pending' &&
        participant.decision !== 'accepted' &&
        participant.decision !== 'declined'
      ) {
        return `协议 ${agreement.id}.participants[${p}].decision 无效`;
      }
      if (participant.decidedTick !== null && !isInteger(participant.decidedTick)) {
        return `协议 ${agreement.id}.participants[${p}].decidedTick 无效`;
      }
      if (typeof participant.note !== 'string') {
        return `协议 ${agreement.id}.participants[${p}].note 无效`;
      }
    }
    for (let itemIndex = 0; itemIndex < agreement.items.length; itemIndex++) {
      const item = agreement.items[itemIndex];
      if (!isRecord(item)) return `协议 ${agreement.id}.items[${itemIndex}] 不是对象`;
      if (typeof item.id !== 'string') return `协议 ${agreement.id}.items[${itemIndex}].id 无效`;
      if (typeof item.good !== 'string' || !(GOOD_IDS as readonly string[]).includes(item.good)) {
        return `协议条目 ${item.id}.good 无效`;
      }
      const itemTerminal =
        item.status === 'fulfilled' || item.status === 'failed' || item.status === 'declined';
      if (
        typeof item.buyerCompanyId !== 'string' ||
        (!companyIds.has(item.buyerCompanyId) && !itemTerminal)
      ) {
        return `协议条目 ${item.id} 的买方无效`;
      }
      if (
        typeof item.sellerCompanyId !== 'string' ||
        (!companyIds.has(item.sellerCompanyId) && !itemTerminal)
      ) {
        return `协议条目 ${item.id} 的卖方无效`;
      }
      for (const key of ['qtyPerMonth', 'unitPrice', 'months', 'deliveredQty', 'paidValue', 'monthsExecuted']) {
        if (!isFiniteNumber(item[key])) return `协议条目 ${item.id}.${key} 无效`;
      }
      if (
        item.status !== 'pending' &&
        item.status !== 'active' &&
        item.status !== 'fulfilled' &&
        item.status !== 'failed' &&
        item.status !== 'declined'
      ) {
        return `协议条目 ${item.id}.status 无效`;
      }
      if (typeof item.lastNote !== 'string') return `协议条目 ${item.id}.lastNote 无效`;
    }
    if (typeof agreement.note !== 'string') return `协议 ${agreement.id}.note 无效`;
  }
  return null;
}

function validateNotifications(
  value: unknown,
  companyIds: Set<string>,
  cityIds: Set<string>,
): string | null {
  if (!Array.isArray(value)) return 'world.notifications 必须是数组';
  for (let index = 0; index < value.length; index++) {
    const notice = value[index];
    if (!isRecord(notice)) return `notifications[${index}] 不是对象`;
    if (typeof notice.id !== 'string') return `notifications[${index}].id 无效`;
    if (!isInteger(notice.tick)) return `notifications[${index}].tick 无效`;
    if (notice.audience !== 'personal' && notice.audience !== 'company' && notice.audience !== 'city') {
      return `notifications[${index}].audience 无效`;
    }
    if (
      notice.kind !== 'dividend' &&
      notice.kind !== 'vote' &&
      notice.kind !== 'major' &&
      notice.kind !== 'agreement' &&
      notice.kind !== 'market'
    ) {
      return `notifications[${index}].kind 无效`;
    }
    if (notice.priority !== 'normal' && notice.priority !== 'important') {
      return `notifications[${index}].priority 无效`;
    }
    if (notice.companyId !== undefined) {
      // 企业可能已经倒闭：通知保留历史事件文本，因此只校验字段类型。
      if (typeof notice.companyId !== 'string' || notice.companyId.length === 0) {
        return `notifications[${index}].companyId 无效`;
      }
    }
    if (notice.cityId !== undefined) {
      if (typeof notice.cityId !== 'string' || !cityIds.has(notice.cityId)) {
        return `notifications[${index}].cityId 无效`;
      }
    }
    if (typeof notice.title !== 'string' || typeof notice.body !== 'string') {
      return `notifications[${index}] 文本无效`;
    }
    if (typeof notice.read !== 'boolean') return `notifications[${index}].read 无效`;
  }
  return null;
}

const POLICY_ID_SET = new Set<string>(POLICY_IDS);

function validatePolitics(value: unknown, cityIds: Set<string>): string | null {
  if (!isRecord(value)) return 'world.politics 无效';
  if (!Array.isArray(value.cities)) return 'politics.cities 必须是数组';
  if (!Array.isArray(value.elections)) return 'politics.elections 必须是数组';
  if (value.cities.length !== cityIds.size) return 'politics.cities 必须覆盖全部城市';
  const seenCities = new Set<string>();
  for (let index = 0; index < value.cities.length; index++) {
    const state = value.cities[index];
    if (!isRecord(state)) return `politics.cities[${index}] 不是对象`;
    if (typeof state.cityId !== 'string' || !cityIds.has(state.cityId)) {
      return `politics.cities[${index}].cityId 无效`;
    }
    if (seenCities.has(state.cityId)) return `politics.cities 重复城市 ${state.cityId}`;
    seenCities.add(state.cityId);
    if (!Array.isArray(state.candidates) || state.candidates.length === 0) {
      return `politics.cities[${index}].candidates 无效`;
    }
    const ids = new Set<string>();
    for (const candidate of state.candidates) {
      if (!isRecord(candidate)) return `politics.cities[${index}] 候选人不是对象`;
      if (typeof candidate.id !== 'string' || ids.has(candidate.id)) {
        return `politics.cities[${index}] 候选人 ID 无效或重复`;
      }
      ids.add(candidate.id);
      if (typeof candidate.name !== 'string' || typeof candidate.party !== 'string') {
        return `候选人 ${candidate.id} 文本字段无效`;
      }
      if (!isRecord(candidate.profile)) return `候选人 ${candidate.id}.profile 无效`;
      if (!isRecord(candidate.profile.domainLeanings)) {
        return `候选人 ${candidate.id}.profile.domainLeanings 无效`;
      }
      for (const leaning of Object.values(candidate.profile.domainLeanings)) {
        if (!isFiniteNumber(leaning) || leaning < 0 || leaning > 1) {
          return `候选人 ${candidate.id} 领域倾向越界`;
        }
      }
      if (
        candidate.profile.sectorAffinity !== null &&
        typeof candidate.profile.sectorAffinity !== 'string'
      ) {
        return `候选人 ${candidate.id}.profile.sectorAffinity 无效`;
      }
      if (!isFiniteNumber(candidate.popularity)) return `候选人 ${candidate.id}.popularity 无效`;
      if (typeof candidate.note !== 'string') return `候选人 ${candidate.id}.note 无效`;
    }
    if (state.leader !== null) {
      if (!isRecord(state.leader) || typeof state.leader.id !== 'string' || !ids.has(state.leader.id)) {
        return `politics.cities[${index}].leader 无效`;
      }
    }
    if (!isFiniteNumber(state.termMonthsLeft) || state.termMonthsLeft < 0) {
      return `politics.cities[${index}].termMonthsLeft 无效`;
    }
    if (!isFiniteNumber(state.electionCount)) return `politics.cities[${index}].electionCount 无效`;
    if (state.lastElectionTick !== null && !isFiniteNumber(state.lastElectionTick)) {
      return `politics.cities[${index}].lastElectionTick 无效`;
    }
    if (typeof state.lastResult !== 'string') return `politics.cities[${index}].lastResult 无效`;
  }
  return null;
}

function validatePolicies(policies: unknown, fiscal: unknown, cityIds: Set<string>): string | null {
  if (!isRecord(policies)) return 'world.policies 无效';
  for (const key of ['active', 'history', 'lastRuns', 'lastSelection']) {
    if (!Array.isArray(policies[key])) return `policies.${key} 必须是数组`;
  }
  for (const [index, policy] of (policies.active as unknown[]).entries()) {
    const error = validateActivePolicy(policy, `policies.active[${index}]`, cityIds);
    if (error) return error;
  }
  for (const [index, policy] of (policies.history as unknown[]).entries()) {
    const error = validateActivePolicy(policy, `policies.history[${index}]`, cityIds);
    if (error) return error;
    if (!isFiniteNumber((policy as Record<string, unknown>).endedTick)) {
      return `policies.history[${index}].endedTick 无效`;
    }
  }
  if (!isRecord(fiscal)) return 'world.fiscal 无效';
  if (!Array.isArray(fiscal.ledger)) return 'fiscal.ledger 必须是数组';
  if (!isInteger(fiscal.nextEntryId) || fiscal.nextEntryId < 1) {
    return 'fiscal.nextEntryId 无效';
  }
  for (const [index, entry] of (fiscal.ledger as unknown[]).entries()) {
    if (!isRecord(entry)) return `fiscal.ledger[${index}] 不是对象`;
    if (typeof entry.id !== 'string') return `fiscal.ledger[${index}].id 无效`;
    if (typeof entry.cityId !== 'string' || !cityIds.has(entry.cityId)) {
      return `fiscal.ledger[${index}].cityId 无效`;
    }
    if (!isFiniteNumber(entry.amount)) return `fiscal.ledger[${index}].amount 无效`;
    if (typeof entry.source !== 'string') return `fiscal.ledger[${index}].source 无效`;
    if (!isInteger(entry.tick)) return `fiscal.ledger[${index}].tick 无效`;
    if (entry.policyId !== undefined) {
      if (typeof entry.policyId !== 'string' || !POLICY_ID_SET.has(entry.policyId)) {
        return `fiscal.ledger[${index}].policyId 无效`;
      }
    }
  }
  return null;
}

function validateActivePolicy(value: unknown, path: string, cityIds: Set<string>): string | null {
  if (!isRecord(value)) return `${path} 不是对象`;
  if (typeof value.id !== 'string') return `${path}.id 无效`;
  if (typeof value.cityId !== 'string' || !cityIds.has(value.cityId)) return `${path}.cityId 无效`;
  if (typeof value.policyId !== 'string' || !POLICY_ID_SET.has(value.policyId)) {
    return `${path}.policyId 无效`;
  }
  for (const key of ['budget', 'spent', 'monthsRemaining', 'startedTick']) {
    if (!isFiniteNumber(value[key])) return `${path}.${key} 无效`;
  }
  if ((value.budget as number) < 0 || (value.spent as number) < 0) return `${path} 金额为负`;
  if ((value.spent as number) > (value.budget as number) + 0.01) return `${path} 支出超过预算`;
  if ((value.monthsRemaining as number) < 0) return `${path}.monthsRemaining 为负`;
  if (value.status !== 'active' && value.status !== 'completed' && value.status !== 'cancelled') {
    return `${path}.status 无效`;
  }
  if (value.targetSector !== null && typeof value.targetSector !== 'string') {
    return `${path}.targetSector 无效`;
  }
  if (value.taxDirection !== null && value.taxDirection !== 'cut' && value.taxDirection !== 'raise') {
    return `${path}.taxDirection 无效`;
  }
  if (value.transportTarget !== null && typeof value.transportTarget !== 'string') {
    return `${path}.transportTarget 无效`;
  }
  if (!isRecord(value.effects)) return `${path}.effects 无效`;
  for (const effect of Object.values(value.effects)) {
    if (!isFiniteNumber(effect)) return `${path}.effects 含非数值`;
  }
  if (typeof value.reason !== 'string' || typeof value.note !== 'string') {
    return `${path} 文本字段无效`;
  }
  return null;
}

function validateTransport(
  value: unknown,
  cityIds: Set<string>,
  companyIds: Set<string>,
): string | null {
  if (!isRecord(value)) return 'world.transport 无效';
  if (!Array.isArray(value.links)) return 'transport.links 必须是数组';
  if (!Array.isArray(value.intracity)) return 'transport.intracity 必须是数组';
  if (!Array.isArray(value.pendingSales)) return 'transport.pendingSales 必须是数组';
  const linkIds = new Set<string>();
  for (const [index, link] of (value.links as unknown[]).entries()) {
    if (!isRecord(link)) return `transport.links[${index}] 不是对象`;
    if (typeof link.id !== 'string' || linkIds.has(link.id)) return `transport.links[${index}] ID 无效或重复`;
    linkIds.add(link.id);
    if (typeof link.fromCityId !== 'string' || !cityIds.has(link.fromCityId)) {
      return `transport.links[${index}].fromCityId 无效`;
    }
    if (typeof link.toCityId !== 'string' || !cityIds.has(link.toCityId)) {
      return `transport.links[${index}].toCityId 无效`;
    }
    if (link.mode !== 'road' && link.mode !== 'rail') return `transport.links[${index}].mode 无效`;
    for (const key of ['level', 'maxLevel']) {
      if (!isFiniteNumber(link[key])) return `transport.links[${index}].${key} 无效`;
    }
    if ((link.level as number) < 0 || (link.level as number) > (link.maxLevel as number)) {
      return `transport.links[${index}].level 越界`;
    }
    if (link.construction !== null) {
      if (!isRecord(link.construction)) return `transport.links[${index}].construction 无效`;
      for (const key of ['targetLevel', 'monthsRemaining', 'totalMonths', 'costPaid', 'startedTick']) {
        if (!isFiniteNumber(link.construction[key])) {
          return `transport.links[${index}].construction.${key} 无效`;
        }
      }
    }
    if (typeof link.note !== 'string') return `transport.links[${index}].note 无效`;
  }
  for (const [index, network] of (value.intracity as unknown[]).entries()) {
    if (!isRecord(network)) return `transport.intracity[${index}] 不是对象`;
    if (typeof network.cityId !== 'string' || !cityIds.has(network.cityId)) {
      return `transport.intracity[${index}].cityId 无效`;
    }
    for (const key of ['roadLevel', 'railLevel', 'maxLevel']) {
      if (!isFiniteNumber(network[key])) return `transport.intracity[${index}].${key} 无效`;
    }
    if ((network.roadLevel as number) < 0 || (network.railLevel as number) < 0) {
      return `transport.intracity[${index}] 等级为负`;
    }
    if (network.construction !== null && !isRecord(network.construction)) {
      return `transport.intracity[${index}].construction 无效`;
    }
    if (typeof network.note !== 'string') return `transport.intracity[${index}].note 无效`;
  }
  for (const [index, sale] of (value.pendingSales as unknown[]).entries()) {
    if (!isRecord(sale)) return `transport.pendingSales[${index}] 不是对象`;
    if (typeof sale.sellerCompanyId !== 'string' || !companyIds.has(sale.sellerCompanyId)) {
      return `transport.pendingSales[${index}].sellerCompanyId 无效`;
    }
    for (const key of ['qty', 'grossValue', 'tick']) {
      if (!isFiniteNumber(sale[key])) return `transport.pendingSales[${index}].${key} 无效`;
    }
    if (typeof sale.good !== 'string' || !(GOOD_IDS as readonly string[]).includes(sale.good)) {
      return `transport.pendingSales[${index}].good 无效`;
    }
  }
  if (!isRecord(value.lastMonth)) return 'transport.lastMonth 无效';
  const stats = value.lastMonth;
  for (const key of [
    'tick', 'demand', 'capacity', 'overloadRatio', 'penaltyRate',
    'capacityLossTotal', 'freightSubsidy', 'maintenancePaid',
  ]) {
    if (!isFiniteNumber(stats[key])) return `transport.lastMonth.${key} 无效`;
  }
  for (const key of ['corridors', 'intracity', 'trades']) {
    if (!Array.isArray(stats[key])) return `transport.lastMonth.${key} 必须是数组`;
  }
  for (const [index, trade] of (stats.trades as unknown[]).entries()) {
    if (!isRecord(trade)) return `transport.lastMonth.trades[${index}] 不是对象`;
    for (const key of ['qty', 'grossValue', 'sellerProceeds', 'capacityLoss', 'penaltyRate', 'demand', 'capacity']) {
      if (!isFiniteNumber(trade[key])) return `transport.lastMonth.trades[${index}].${key} 无效`;
    }
    if (trade.buyerRefund !== undefined && !isFiniteNumber(trade.buyerRefund)) {
      return `transport.lastMonth.trades[${index}].buyerRefund 无效`;
    }
    if ((trade.sellerProceeds as number) > (trade.grossValue as number) + 0.01) {
      return `transport.lastMonth.trades[${index}] 卖方所得超过付款`;
    }
  }
  if (typeof stats.note !== 'string') return 'transport.lastMonth.note 无效';
  return null;
}

function validateLifecycle(value: unknown, cityIds: Set<string>): string | null {
  if (!isRecord(value)) return 'world.lifecycle 无效';
  if (!Array.isArray(value.foundings)) return 'lifecycle.foundings 必须是数组';
  if (!Array.isArray(value.liquidations)) return 'lifecycle.liquidations 必须是数组';
  if (!isInteger(value.nextFoundingNumber) || !isInteger(value.nextLiquidationNumber)) {
    return 'lifecycle 序号无效';
  }
  for (const [index, record] of (value.foundings as unknown[]).entries()) {
    if (!isRecord(record)) return `lifecycle.foundings[${index}] 不是对象`;
    if (typeof record.companyId !== 'string' || typeof record.companyName !== 'string') {
      return `lifecycle.foundings[${index}] 企业标识无效`;
    }
    if (typeof record.cityId !== 'string' || !cityIds.has(record.cityId)) {
      return `lifecycle.foundings[${index}].cityId 无效`;
    }
    for (const key of ['capital', 'investorCount', 'governmentGrant', 'tick']) {
      if (!isFiniteNumber(record[key])) return `lifecycle.foundings[${index}].${key} 无效`;
    }
    if (!Array.isArray(record.investors)) return `lifecycle.foundings[${index}].investors 无效`;
    if (typeof record.note !== 'string') return `lifecycle.foundings[${index}].note 无效`;
  }
  for (const [index, record] of (value.liquidations as unknown[]).entries()) {
    if (!isRecord(record)) return `lifecycle.liquidations[${index}] 不是对象`;
    if (typeof record.companyId !== 'string' || typeof record.companyName !== 'string') {
      return `lifecycle.liquidations[${index}] 企业标识无效`;
    }
    for (const key of [
      'tick', 'employeesReleased', 'cash', 'debt', 'debtRepaid',
      'debtForgiven', 'shareholderPayout', 'inventoryBookValue',
    ]) {
      if (!isFiniteNumber(record[key])) return `lifecycle.liquidations[${index}].${key} 无效`;
    }
    if (!Array.isArray(record.holdings)) return `lifecycle.liquidations[${index}].holdings 无效`;
    if (!Array.isArray(record.inventoryWrittenOff)) {
      return `lifecycle.liquidations[${index}].inventoryWrittenOff 无效`;
    }
    if (typeof record.note !== 'string') return `lifecycle.liquidations[${index}].note 无效`;
  }
  return null;
}

// ---------------------------------------------------------------- v0.4 校验器

const OCCUPATION_KEYS = new Set([
  'management',
  'production',
  'sales',
  'research',
  'publicSector',
  'unemployed',
  'nonLabor',
]);
const WEALTH_TIERS = new Set(['low', 'middle', 'high']);
const OPERATION_MODES = new Set(['manual', 'assisted', 'delegated']);
const PROPOSAL_KINDS = new Set(['hire', 'expand', 'loan', 'dividend', 'price']);
const PROPOSAL_STATUSES = new Set(['pending', 'approved', 'rejected', 'executed', 'expired']);
const LOAN_PURPOSES = new Set(['workingCapital', 'expansion', 'personal', 'migratedDebt']);
const LOAN_STATUSES = new Set(['active', 'repaid', 'defaulted']);
const BANK_OWNER_KINDS = new Set(['player', 'household', 'company', 'investorGroup']);

function validateBankOwner(
  value: unknown,
  path: string,
  companyIds: Set<string>,
  investorIds: Set<string>,
  allowMissing = false,
): string | null {
  if (!isRecord(value)) return `${path} 不是对象`;
  if (typeof value.kind !== 'string' || !BANK_OWNER_KINDS.has(value.kind)) {
    return `${path}.kind 无效`;
  }
  if (typeof value.id !== 'string' || value.id.length === 0) return `${path}.id 无效`;
  if (value.kind === 'player' && value.id !== 'player') return `${path}.id 对玩家无效`;
  // 历史记录（清零的旧账户、已结清的贷款、授信快照）允许保留已注销企业的引用；
  // 未结清的债权/余额则必须指向存在的企业或居民投资实体。
  if (value.kind === 'company' && !companyIds.has(value.id) && !allowMissing) {
    return `${path} 引用了不存在的企业 ${value.id}`;
  }
  if (value.kind === 'investorGroup' && !investorIds.has(value.id) && !allowMissing) {
    return `${path} 引用了不存在的居民投资实体 ${value.id}`;
  }
  return null;
}

function validateHouseholds(value: unknown, cityIds: Set<string>): string | null {
  if (!isRecord(value)) return 'world.households 无效';
  if (!Array.isArray(value.groups)) return 'households.groups 必须是数组';
  if (!Array.isArray(value.lastStats)) return 'households.lastStats 必须是数组';
  const ids = new Set<string>();
  for (let index = 0; index < value.groups.length; index++) {
    const group = value.groups[index];
    if (!isRecord(group)) return `households.groups[${index}] 不是对象`;
    if (typeof group.id !== 'string' || group.id.length === 0) {
      return `households.groups[${index}].id 无效`;
    }
    if (ids.has(group.id)) return `居民群体 ID 重复：${group.id}`;
    ids.add(group.id);
    if (typeof group.cityId !== 'string' || !cityIds.has(group.cityId)) {
      return `居民群体 ${group.id} 引用了不存在的城市`;
    }
    if (typeof group.occupation !== 'string' || !OCCUPATION_KEYS.has(group.occupation)) {
      return `居民群体 ${group.id}.occupation 无效`;
    }
    if (!isFiniteNumber(group.people) || group.people < 0) return `居民群体 ${group.id}.people 无效`;
    if (!isFiniteNumber(group.cash) || group.cash < -0.01) return `居民群体 ${group.id}.cash 无效`;
    if (typeof group.name !== 'string' || typeof group.note !== 'string') {
      return `居民群体 ${group.id} 文本字段无效`;
    }
    const stats = group.lastMonth;
    if (!isRecord(stats)) return `居民群体 ${group.id}.lastMonth 无效`;
    for (const key of [
      'income',
      'wageIncome',
      'benefits',
      'dividendIncome',
      'incomeTax',
      'consumption',
      'desiredConsumption',
      'savingsContribution',
      'netCashChange',
    ]) {
      if (!isFiniteNumber(stats[key])) return `居民群体 ${group.id}.lastMonth.${key} 无效`;
    }
  }
  for (let index = 0; index < value.lastStats.length; index++) {
    const stats = value.lastStats[index];
    if (!isRecord(stats)) return `households.lastStats[${index}] 不是对象`;
    if (typeof stats.cityId !== 'string' || !cityIds.has(stats.cityId)) {
      return `households.lastStats[${index}] 引用了不存在的城市`;
    }
    if (!Array.isArray(stats.tiers)) return `households.lastStats[${index}].tiers 无效`;
    for (const tier of stats.tiers) {
      if (!isRecord(tier) || typeof tier.tier !== 'string' || !WEALTH_TIERS.has(tier.tier)) {
        return `households.lastStats[${index}].tiers 含无效阶层`;
      }
      for (const key of ['people', 'share', 'perCapitaWealth', 'perCapitaIncome', 'cash', 'deposits', 'equity']) {
        if (!isFiniteNumber(tier[key])) return `households.lastStats[${index}].tiers.${key} 无效`;
      }
    }
  }
  return null;
}

function validateManagement(
  value: unknown,
  companyIds: Set<string>,
  cityIds: Set<string>,
): string | null {
  if (!isRecord(value)) return 'world.management 无效';
  if (!Array.isArray(value.operators)) return 'management.operators 必须是数组';
  if (!Array.isArray(value.playerOperations)) return 'management.playerOperations 必须是数组';
  if (!isInteger(value.nextOperatorNumber)) return 'management.nextOperatorNumber 无效';
  const operatorIds = new Set<string>();
  for (let index = 0; index < value.operators.length; index++) {
    const operator = value.operators[index];
    if (!isRecord(operator)) return `management.operators[${index}] 不是对象`;
    if (typeof operator.id !== 'string' || operator.id.length === 0) {
      return `management.operators[${index}].id 无效`;
    }
    if (operatorIds.has(operator.id)) return `经营者 ID 重复：${operator.id}`;
    operatorIds.add(operator.id);
    if (typeof operator.name !== 'string') return `经营者 ${operator.id}.name 无效`;
    if (operator.style !== 'growth' && operator.style !== 'steady' && operator.style !== 'return') {
      return `经营者 ${operator.id}.style 无效`;
    }
    if (!isFiniteNumber(operator.reputation)) return `经营者 ${operator.id}.reputation 无效`;
    if (operator.status !== 'employed' && operator.status !== 'available') {
      return `经营者 ${operator.id}.status 无效`;
    }
    if (operator.companyId !== null) {
      if (typeof operator.companyId !== 'string' || !companyIds.has(operator.companyId)) {
        return `经营者 ${operator.id}.companyId 无效`;
      }
    }
    for (const key of ['appointedTick', 'termEndTick']) {
      if (operator[key] !== null && !isInteger(operator[key])) {
        return `经营者 ${operator.id}.${key} 无效`;
      }
    }
    if (!Array.isArray(operator.history)) return `经营者 ${operator.id}.history 无效`;
    for (const tenure of operator.history) {
      if (!isRecord(tenure) || typeof tenure.companyId !== 'string') {
        return `经营者 ${operator.id}.history 含无效记录`;
      }
      if (!isInteger(tenure.fromTick) || !isInteger(tenure.toTick)) {
        return `经营者 ${operator.id}.history 时间无效`;
      }
    }
    if (typeof operator.note !== 'string') return `经营者 ${operator.id}.note 无效`;
  }

  const operatedCompanies = new Set<string>();
  for (let index = 0; index < value.playerOperations.length; index++) {
    const operation = value.playerOperations[index];
    if (!isRecord(operation)) return `management.playerOperations[${index}] 不是对象`;
    if (typeof operation.companyId !== 'string' || !companyIds.has(operation.companyId)) {
      return `玩家经营记录 ${index} 引用了不存在的企业`;
    }
    if (operatedCompanies.has(operation.companyId)) {
      return `玩家经营记录重复：${operation.companyId}`;
    }
    operatedCompanies.add(operation.companyId);
    if (typeof operation.mode !== 'string' || !OPERATION_MODES.has(operation.mode)) {
      return `玩家经营记录 ${index}.mode 无效`;
    }
    const auth = operation.authorization;
    if (!isRecord(auth)) return `玩家经营记录 ${index}.authorization 无效`;
    for (const key of ['maxInvestmentPerMonth', 'maxHiresPerMonth', 'maxLoanAmount']) {
      if (!isFiniteNumber(auth[key]) || auth[key] < 0) {
        return `玩家经营记录 ${index}.authorization.${key} 无效`;
      }
    }
    for (const key of ['allowInvestment', 'allowHiring', 'allowLoan', 'allowPriceAdjust']) {
      if (typeof auth[key] !== 'boolean') return `玩家经营记录 ${index}.authorization.${key} 无效`;
    }
    if (operation.standingPlan !== null) {
      const plan = operation.standingPlan;
      if (!isRecord(plan)) return `玩家经营记录 ${index}.standingPlan 无效`;
      for (const key of ['utilization', 'targetJobs', 'priceFactor', 'investmentPerMonth']) {
        if (!isFiniteNumber(plan[key])) return `玩家经营记录 ${index}.standingPlan.${key} 无效`;
      }
      if (!isInteger(plan.expiresTick)) return `玩家经营记录 ${index}.standingPlan.expiresTick 无效`;
    }
    if (!Array.isArray(operation.proposals)) return `玩家经营记录 ${index}.proposals 无效`;
    for (let proposalIndex = 0; proposalIndex < operation.proposals.length; proposalIndex++) {
      const proposal = operation.proposals[proposalIndex];
      if (!isRecord(proposal)) return `玩家提案 ${proposalIndex} 不是对象`;
      if (typeof proposal.id !== 'string' || typeof proposal.title !== 'string') {
        return `玩家提案 ${proposalIndex} 字段无效`;
      }
      if (typeof proposal.kind !== 'string' || !PROPOSAL_KINDS.has(proposal.kind)) {
        return `玩家提案 ${proposal.id}.kind 无效`;
      }
      if (typeof proposal.status !== 'string' || !PROPOSAL_STATUSES.has(proposal.status)) {
        return `玩家提案 ${proposal.id}.status 无效`;
      }
      if (!isFiniteNumber(proposal.amount)) return `玩家提案 ${proposal.id}.amount 无效`;
      if (!isInteger(proposal.createdTick) || !isInteger(proposal.expiresTick)) {
        return `玩家提案 ${proposal.id} 时间字段无效`;
      }
      if (proposal.decidedTick !== null && !isInteger(proposal.decidedTick)) {
        return `玩家提案 ${proposal.id}.decidedTick 无效`;
      }
      if (!Array.isArray(proposal.reasons) || !isRecord(proposal.params)) {
        return `玩家提案 ${proposal.id} 内容无效`;
      }
      if (typeof proposal.dedupeKey !== 'string' || typeof proposal.result !== 'string') {
        return `玩家提案 ${proposal.id} 文本字段无效`;
      }
    }
  }
  // cityIds 目前不参与经营者校验，保留参数以便未来按城市限制人才池。
  void cityIds;
  return null;
}

function validateBanking(
  value: unknown,
  cityIds: Set<string>,
  companyIds: Set<string>,
  investorIds: Set<string>,
): string | null {
  if (!isRecord(value)) return 'world.banking 无效';
  if (!Array.isArray(value.deposits)) return 'banking.deposits 必须是数组';
  if (!Array.isArray(value.loans)) return 'banking.loans 必须是数组';
  if (!Array.isArray(value.snapshots)) return 'banking.snapshots 必须是数组';
  if (!isRecord(value.lastMonth)) return 'banking.lastMonth 无效';
  if (!isInteger(value.nextAccountNumber) || !isInteger(value.nextLoanNumber)) {
    return 'banking 编号计数器无效';
  }
  void cityIds;

  const accountIds = new Set<string>();
  for (let index = 0; index < value.deposits.length; index++) {
    const account = value.deposits[index];
    if (!isRecord(account)) return `banking.deposits[${index}] 不是对象`;
    if (typeof account.id !== 'string' || accountIds.has(account.id)) {
      return `存款账户 ${index} ID 无效或重复`;
    }
    accountIds.add(account.id);
    const zeroBalance =
      isFiniteNumber(account.balance) && Math.abs(account.balance) <= 0.01;
    const ownerError = validateBankOwner(
      account.owner,
      `banking.deposits[${index}].owner`,
      companyIds,
      investorIds,
      zeroBalance,
    );
    if (ownerError) return ownerError;
    for (const key of ['balance', 'rateMonthly', 'accruedInterest']) {
      if (!isFiniteNumber(account[key]) || account[key] < -0.01) {
        return `存款账户 ${account.id}.${key} 无效`;
      }
    }
    if (!isInteger(account.lastInterestTick) || !isInteger(account.openedTick)) {
      return `存款账户 ${account.id} 时间字段无效`;
    }
    if (typeof account.note !== 'string') return `存款账户 ${account.id}.note 无效`;
  }

  const loanIds = new Set<string>();
  for (let index = 0; index < value.loans.length; index++) {
    const loan = value.loans[index];
    if (!isRecord(loan)) return `banking.loans[${index}] 不是对象`;
    if (typeof loan.id !== 'string' || loanIds.has(loan.id)) {
      return `贷款合同 ${index} ID 无效或重复`;
    }
    loanIds.add(loan.id);
    // 企业清算后合同保留为历史记录（defaulted/repaid、未偿为 0），此时允许借款人已注销。
    const historicalLoan =
      typeof loan.status === 'string' &&
      loan.status !== 'active' &&
      isFiniteNumber(loan.outstanding) &&
      Math.abs(loan.outstanding) <= 0.01;
    const ownerError = validateBankOwner(
      loan.borrower,
      `banking.loans[${index}].borrower`,
      companyIds,
      investorIds,
      historicalLoan,
    );
    if (ownerError) return ownerError;
    if (typeof loan.purpose !== 'string' || !LOAN_PURPOSES.has(loan.purpose)) {
      return `贷款合同 ${loan.id}.purpose 无效`;
    }
    for (const key of [
      'principal',
      'outstanding',
      'monthlyPrincipal',
      'rateMonthly',
      'paidPrincipal',
      'paidInterest',
      'accruedInterest',
      'arrearsPrincipal',
      'arrearsInterest',
    ]) {
      if (!isFiniteNumber(loan[key])) return `贷款合同 ${loan.id}.${key} 无效`;
    }
    if (!isInteger(loan.termMonths) || loan.termMonths <= 0) return `贷款合同 ${loan.id}.termMonths 无效`;
    if (!isInteger(loan.startTick) || !isInteger(loan.nextDueTick)) {
      return `贷款合同 ${loan.id} 时间字段无效`;
    }
    if (!isInteger(loan.missedPayments) || loan.missedPayments < 0) {
      return `贷款合同 ${loan.id}.missedPayments 无效`;
    }
    if (typeof loan.status !== 'string' || !LOAN_STATUSES.has(loan.status)) {
      return `贷款合同 ${loan.id}.status 无效`;
    }
    if (!Array.isArray(loan.payments)) return `贷款合同 ${loan.id}.payments 无效`;
    for (const payment of loan.payments) {
      if (!isRecord(payment) || !isInteger(payment.tick)) {
        return `贷款合同 ${loan.id} 含无效还款记录`;
      }
      for (const key of ['principalDue', 'interestDue', 'principalPaid', 'interestPaid', 'arrears']) {
        if (!isFiniteNumber(payment[key])) return `贷款合同 ${loan.id} 还款记录 ${key} 无效`;
      }
    }
    if (typeof loan.note !== 'string') return `贷款合同 ${loan.id}.note 无效`;
  }

  for (let index = 0; index < value.snapshots.length; index++) {
    const snapshot = value.snapshots[index];
    if (!isRecord(snapshot)) return `banking.snapshots[${index}] 不是对象`;
    // 授信快照是历史评估记录，允许保留已注销企业的引用。
    const ownerError = validateBankOwner(
      snapshot.borrower,
      `banking.snapshots[${index}].borrower`,
      companyIds,
      investorIds,
      true,
    );
    if (ownerError) return ownerError;
    for (const key of ['baseValue', 'limitRate', 'limit', 'outstanding', 'available']) {
      if (!isFiniteNumber(snapshot[key])) return `授信快照 ${index}.${key} 无效`;
    }
    if (!isInteger(snapshot.tick)) return `授信快照 ${index}.tick 无效`;
    if (snapshot.method !== 'netWorth' && snapshot.method !== 'equityBook') {
      return `授信快照 ${index}.method 无效`;
    }
    if (typeof snapshot.reason !== 'string') return `授信快照 ${index}.reason 无效`;
  }

  const stats = value.lastMonth;
  for (const key of [
    'interestExpense',
    'interestIncome',
    'principalIssued',
    'principalRepaid',
    'depositsTotal',
    'loansOutstanding',
    'newDefaults',
  ]) {
    if (!isFiniteNumber(stats[key])) return `banking.lastMonth.${key} 无效`;
  }
  if (!isInteger(stats.tick) || typeof stats.note !== 'string') {
    return 'banking.lastMonth 字段无效';
  }
  return null;
}

export function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}
