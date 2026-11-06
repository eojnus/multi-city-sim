/**
 * v1.7 存档模块：城市政治与选举（politics + cities[].politics）。
 *
 * 数据归属依据 /tmp/save-ownership-b.md §1 与 docs/development/SAVE_SYSTEM_DESIGN.md §2.11：
 * - `politics.cities`：各城候选人/领导人/任期/选举计数（`CityPoliticsState`）；
 * - `politics.elections`：选举展示历史（允许后续历史治理按年归档）；
 * - `cities[].politics`：城市对象上的旧版政治摘要（approval/rulingParty/electionInMonths/status/note，
 *   由 politics 模块维护，closing 与 `politics.cities` 的领导人/任期保持一致）。
 *
 * 校验口径与 core/save.ts 的 validatePolitics 一致：候选人 ID 唯一、领导人必须属于候选人集合、
 * 政治城市状态必须覆盖全部城市（本模块内先检查两份数据的城市集合一致）。
 */

import type { PoliticsState, WorldPoliticsState } from '../../contracts/types';
import type {
  SaveExportContext,
  SaveModule,
  SaveModuleMigrationContext,
  SaveModuleValidation,
  SaveRestoreContext,
} from '../types';

/** 模块数据版本：字段变化时递增（当前 v10 存档统一为 1）。 */
export const POLITICS_SAVE_MODULE_VERSION = 1;

export interface PoliticsSaveCityData {
  id: string;
  politics: PoliticsState;
}

export interface PoliticsSaveData {
  politics: WorldPoliticsState;
  cities: PoliticsSaveCityData[];
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function expectRecord(value: unknown, path: string, errors: string[]): UnknownRecord | null {
  if (!isRecord(value)) {
    errors.push(`${path} 必须是对象`);
    return null;
  }
  return value;
}

function expectArray(value: unknown, path: string, errors: string[]): unknown[] | null {
  if (!Array.isArray(value)) {
    errors.push(`${path} 必须是数组`);
    return null;
  }
  return value;
}

function checkEntries(
  value: unknown,
  path: string,
  errors: string[],
  checkEntry: (entry: UnknownRecord, entryPath: string) => void,
): void {
  const array = expectArray(value, path, errors);
  if (!array) return;
  array.forEach((entry, index) => {
    if (!isRecord(entry)) {
      errors.push(`${path}[${index}] 必须是对象`);
      return;
    }
    checkEntry(entry, `${path}[${index}]`);
  });
}

function requireString(record: UnknownRecord, key: string, path: string, errors: string[]): void {
  if (typeof record[key] !== 'string') errors.push(`${path}.${key} 必须是字符串`);
}

function requireNonEmptyString(
  record: UnknownRecord,
  key: string,
  path: string,
  errors: string[],
): void {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) {
    errors.push(`${path}.${key} 必须是非空字符串`);
  }
}

function requireFiniteNumber(
  record: UnknownRecord,
  key: string,
  path: string,
  errors: string[],
): void {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    errors.push(`${path}.${key} 必须是有限数字`);
  }
}

function requireNullableFiniteNumber(
  record: UnknownRecord,
  key: string,
  path: string,
  errors: string[],
): void {
  const value = record[key];
  if (value !== null && (typeof value !== 'number' || !Number.isFinite(value))) {
    errors.push(`${path}.${key} 必须是有限数字或 null`);
  }
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function validateCandidate(entry: UnknownRecord, path: string, errors: string[]): void {
  requireNonEmptyString(entry, 'id', path, errors);
  requireNonEmptyString(entry, 'cityId', path, errors);
  requireString(entry, 'name', path, errors);
  requireString(entry, 'party', path, errors);
  const profile = expectRecord(entry.profile, `${path}.profile`, errors);
  if (profile) {
    const leanings = expectRecord(
      profile.domainLeanings,
      `${path}.profile.domainLeanings`,
      errors,
    );
    if (leanings) {
      for (const [domain, value] of Object.entries(leanings)) {
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
          errors.push(`${path}.profile.domainLeanings.${domain} 必须是 0–1 的有限数字`);
        }
      }
    }
    if (profile.sectorAffinity !== null && typeof profile.sectorAffinity !== 'string') {
      errors.push(`${path}.profile.sectorAffinity 必须是字符串或 null`);
    }
    requireString(profile, 'traitLabel', `${path}.profile`, errors);
    requireString(profile, 'traitNote', `${path}.profile`, errors);
  }
  requireFiniteNumber(entry, 'popularity', path, errors);
  requireString(entry, 'note', path, errors);
}

function validateCityPoliticsState(value: unknown, path: string, errors: string[]): void {
  const state = expectRecord(value, path, errors);
  if (!state) return;
  requireNonEmptyString(state, 'cityId', path, errors);
  const candidateIds = new Set<string>();
  const candidates = expectArray(state.candidates, `${path}.candidates`, errors);
  if (candidates && candidates.length === 0) {
    errors.push(`${path}.candidates 不能为空`);
  }
  candidates?.forEach((candidate, index) => {
    const candidatePath = `${path}.candidates[${index}]`;
    if (!isRecord(candidate)) {
      errors.push(`${candidatePath} 必须是对象`);
      return;
    }
    validateCandidate(candidate, candidatePath, errors);
    if (typeof candidate.id === 'string' && candidate.id.length > 0) {
      if (candidateIds.has(candidate.id)) {
        errors.push(`${candidatePath}.id 重复：${candidate.id}`);
      }
      candidateIds.add(candidate.id);
    }
  });
  if (state.leader !== null) {
    const leader = expectRecord(state.leader, `${path}.leader`, errors);
    if (leader) {
      requireNonEmptyString(leader, 'id', `${path}.leader`, errors);
      if (typeof leader.id === 'string' && !candidateIds.has(leader.id)) {
        errors.push(`${path}.leader 必须是候选人之一：${leader.id}`);
      }
    }
  }
  const termMonthsLeft = state.termMonthsLeft;
  if (
    typeof termMonthsLeft !== 'number' ||
    !Number.isFinite(termMonthsLeft) ||
    termMonthsLeft < 0
  ) {
    errors.push(`${path}.termMonthsLeft 必须是 >=0 的有限数字`);
  }
  requireFiniteNumber(state, 'electionCount', path, errors);
  requireNullableFiniteNumber(state, 'lastElectionTick', path, errors);
  requireString(state, 'lastResult', path, errors);
}

function validateWorldPoliticsState(value: unknown, errors: string[]): Set<string> {
  const cityIds = new Set<string>();
  const politics = expectRecord(value, 'politics', errors);
  if (!politics) return cityIds;
  checkEntries(politics.cities, 'politics.cities', errors, (entry, path) => {
    validateCityPoliticsState(entry, path, errors);
    const cityId = entry.cityId;
    if (typeof cityId === 'string' && cityId.length > 0) {
      if (cityIds.has(cityId)) errors.push(`${path}.cityId 重复：${cityId}`);
      cityIds.add(cityId);
    }
  });
  checkEntries(politics.elections, 'politics.elections', errors, (entry, path) => {
    requireFiniteNumber(entry, 'tick', path, errors);
    requireNonEmptyString(entry, 'cityId', path, errors);
    requireString(entry, 'winnerId', path, errors);
    requireString(entry, 'winnerName', path, errors);
    if (typeof entry.playerWon !== 'boolean') {
      errors.push(`${path}.playerWon 必须是布尔值`);
    }
    requireString(entry, 'note', path, errors);
  });
  return cityIds;
}

/**
 * `cities[].politics` 是城市对象上的旧版政治摘要（v0.3 起由 politics 模块维护）：
 * `{ approval, rulingParty, electionInMonths, status, note }`；候选人/领导人/任期在 `politics.cities`。
 */
function validateCityPoliticsSummary(value: unknown, path: string, errors: string[]): void {
  const summary = expectRecord(value, path, errors);
  if (!summary) return;
  requireFiniteNumber(summary, 'approval', path, errors);
  requireString(summary, 'rulingParty', path, errors);
  requireNullableFiniteNumber(summary, 'electionInMonths', path, errors);
  if (summary.status !== 'initial-only' && summary.status !== 'active') {
    errors.push(`${path}.status 非法：${String(summary.status)}`);
  }
  requireString(summary, 'note', path, errors);
}

function validateCityEntries(value: unknown, errors: string[], politicsCityIds: Set<string>): void {
  const seen = new Set<string>();
  const cities = expectArray(value, 'cities', errors);
  if (!cities) return;
  cities.forEach((raw, index) => {
    const path = `cities[${index}]`;
    if (!isRecord(raw)) {
      errors.push(`${path} 必须是对象`);
      return;
    }
    requireNonEmptyString(raw, 'id', path, errors);
    const id = raw.id;
    if (typeof id === 'string' && id.length > 0) {
      if (seen.has(id)) errors.push(`${path}.id 重复：${id}`);
      seen.add(id);
      if (politicsCityIds.size > 0 && !politicsCityIds.has(id)) {
        errors.push(`${path}.id 在 politics.cities 中缺少对应政治状态：${id}`);
      }
    }
    validateCityPoliticsSummary(raw.politics, `${path}.politics`, errors);
  });
  for (const cityId of politicsCityIds) {
    if (!seen.has(cityId)) {
      errors.push(`cities[] 缺少 politics.cities 对应的城市：${cityId}`);
    }
  }
}

export const politicsSaveModule: SaveModule<PoliticsSaveData> = {
  id: 'politics',
  version: POLITICS_SAVE_MODULE_VERSION,
  required: true,
  ownedPaths: ['politics', 'cities[].politics'],
  dependsOn: ['world'],

  export(context: SaveExportContext): PoliticsSaveData {
    const { world } = context;
    if (!isRecord(world.politics)) {
      throw new Error('世界缺少 politics 状态，无法导出政治存档模块');
    }
    return {
      politics: cloneJson(world.politics),
      cities: world.cities.map((city) => {
        if (!isRecord(city.politics)) {
          throw new Error(`城市 ${city.id} 缺少 politics 状态，无法导出政治存档模块`);
        }
        return { id: city.id, politics: cloneJson(city.politics) };
      }),
    };
  },

  validate(data: unknown, version: number): SaveModuleValidation {
    if (version !== POLITICS_SAVE_MODULE_VERSION) {
      return {
        ok: false,
        errors: [
          `politics 模块数据版本不受支持：${version}（当前支持 ${POLITICS_SAVE_MODULE_VERSION}）`,
        ],
      };
    }
    if (!isRecord(data)) {
      return { ok: false, errors: ['politics 模块数据必须是对象'] };
    }
    const errors: string[] = [];
    const politicsCityIds = validateWorldPoliticsState(data.politics, errors);
    validateCityEntries(data.cities, errors, politicsCityIds);
    return { ok: errors.length === 0, errors };
  },

  migrate(data: unknown, context: SaveModuleMigrationContext): PoliticsSaveData {
    if (context.fromVersion === 0) {
      // 必需模块缺失 = 存档损坏：候选人与领导人状态无法凭空重建。
      throw new Error('存档缺少必需的 politics 模块：无法安全重建城市政治与选举状态');
    }
    if (context.fromVersion === POLITICS_SAVE_MODULE_VERSION) {
      return data as PoliticsSaveData;
    }
    throw new Error(
      `不支持的 politics 模块版本迁移：${context.fromVersion} → ${POLITICS_SAVE_MODULE_VERSION}`,
    );
  },

  restore(data: PoliticsSaveData, context: SaveRestoreContext): void {
    if (!isRecord(data) || !isRecord(data.politics) || !Array.isArray(data.cities)) {
      throw new Error('politics 模块数据缺少 politics/cities');
    }
    context.world.politics = cloneJson(data.politics);
    for (const entry of data.cities) {
      context.cityOf(entry.id).politics = cloneJson(entry.politics);
    }
  },
};
