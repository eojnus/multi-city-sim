import type { SaveFile, WorldState } from '../contracts/types';
import { GAME_VERSION, SAVE_FORMAT_VERSION } from '../contracts/types';
import { checkInvariants } from './invariants';

export interface ParseResult {
  ok: boolean;
  world?: WorldState;
  save?: SaveFile;
  error?: string;
}

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

  const save = parsed as unknown as SaveFile;
  if (!isRecord(save.world)) return { ok: false, error: '存档缺少 world 数据' };
  const structureError = validateWorldStructure(save.world);
  if (structureError) return { ok: false, error: structureError };

  const world = save.world as WorldState;
  const problems = checkInvariants(world);
  if (problems.length > 0) {
    return {
      ok: false,
      error: `存档未通过不变量校验：${problems.slice(0, 3).join('；')}`,
    };
  }
  if (world.seed !== world.seed >>> 0) return { ok: false, error: '随机种子状态无效' };

  return { ok: true, world, save };
}

export function validateWorldStructure(world: unknown): string | null {
  if (!isRecord(world)) return 'world 不是对象';
  if (typeof world.seed !== 'number') return 'world.seed 缺失';
  if (typeof world.rngState !== 'number') return 'world.rngState 缺失';
  if (!isRecord(world.time) || typeof world.time.tick !== 'number') return 'world.time 无效';
  if (!Array.isArray(world.cities) || world.cities.length === 0) return 'world.cities 无效';
  if (!Array.isArray(world.companies) || world.companies.length === 0) {
    return 'world.companies 无效';
  }
  if (!Array.isArray(world.tradeRoutes)) return 'world.tradeRoutes 无效';
  if (!Array.isArray(world.history)) return 'world.history 无效';
  if (!Array.isArray(world.log)) return 'world.log 无效';
  if (!isRecord(world.player) || typeof world.player.cash !== 'number') return 'world.player 无效';
  if (!isRecord(world.lastTick)) return 'world.lastTick 无效';
  for (const city of world.cities) {
    if (!isRecord(city) || typeof city.id !== 'string') return '城市条目无效';
    if (!isRecord(city.population) || !isRecord(city.market)) return `城市 ${city.id} 数据不完整`;
  }
  for (const company of world.companies) {
    if (!isRecord(company) || typeof company.id !== 'string') return '企业条目无效';
    if (!isRecord(company.inventory) || !isRecord(company.roles)) {
      return `企业 ${company.id} 数据不完整`;
    }
  }
  return null;
}

export function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
