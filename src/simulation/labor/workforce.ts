import type { City } from '../contracts/types';
import { clamp, round2 } from '../core/math';

/**
 * 技能最小机制（仅支持培训/教育政策的因果闭环）：
 * - skillLevel 0–1，由职业培训与教育投入逐步提高，不会自动下降；
 * - 对单位员工产出提供最多 +10% 的加成（有上限、可追溯）；
 * - 不是完整的技能市场、职业匹配或教育系统。
 */
export const MAX_SKILL_PRODUCTIVITY_BONUS = 0.1;

export function workforceSkillMultiplier(city: City): number {
  return round2(1 + clamp(city.workforce?.skillLevel ?? 0, 0, 1) * MAX_SKILL_PRODUCTIVITY_BONUS);
}

export function addWorkforceSkill(city: City, delta: number): number {
  if (!city.workforce) {
    city.workforce = { skillLevel: 0, trainedThisMonth: 0, trainedTotal: 0, trainedLastTick: 0 };
  }
  const before = city.workforce.skillLevel;
  // 技能提升按月很小，必须保留足够精度（不能 round2，否则培训永远为 0）。
  const next = clamp(before + Math.max(0, delta), 0, 1);
  city.workforce.skillLevel = Math.round(next * 1_000_000) / 1_000_000;
  return Math.round((city.workforce.skillLevel - before) * 1_000_000) / 1_000_000;
}

export function recordTraining(city: City, people: number): void {
  if (!city.workforce) {
    city.workforce = { skillLevel: 0, trainedThisMonth: 0, trainedTotal: 0, trainedLastTick: 0 };
  }
  const count = Math.max(0, Math.round(people));
  city.workforce.trainedThisMonth = round2(city.workforce.trainedThisMonth + count);
  city.workforce.trainedTotal = round2(city.workforce.trainedTotal + count);
}

export function startWorkforceMonth(city: City): void {
  if (!city.workforce) {
    city.workforce = { skillLevel: 0, trainedThisMonth: 0, trainedTotal: 0, trainedLastTick: 0 };
  }
  city.workforce.trainedLastTick = city.workforce.trainedThisMonth;
  city.workforce.trainedThisMonth = 0;
}
