// v0.5 存档迁移测试共用 helper。
//
// 目的：从当前版本世界生成“结构忠实的 v4 存档”，用于验证 v4 → v5 迁移。
// 只做测试侧的数据降级，不修改任何产品代码；也不读取/写入仓库外路径。

import { Simulation } from '../../src/simulation/core/simulation';
import type { WorldState } from '../../src/simulation/contracts/types';

/** 允许以宽松下标访问旧格式字段的测试世界。 */
export type AnyWorld = Record<string, any>;

/** 新世界并推进 `months` 个月；任何一次结算失败都会抛错，避免测试在坏世界上继续断言。 */
export function currentWorld(months = 1): WorldState {
  const sim = Simulation.create();
  for (let index = 0; index < months; index += 1) {
    const result = sim.tick();
    if (!result.ok) {
      throw new Error(`推进第 ${index + 1} 月失败：${result.error ?? '未知错误'}`);
    }
  }
  return sim.state;
}

/**
 * 把当前 v5 世界降级为 v4 结构：
 * - 删除 world.households / management / banking；
 * - 删除 CompanyControl.operatorId / termEndTick（v0.4 之前没有经营者档案）；
 * - 删除 Motion.candidates 与 MotionVote.candidateId（v0.4 之前没有候选人名单）；
 * - v4 没有 operatorElection 议案类型，将其移除（只保留 v4 存在的 dividendPolicy 等）。
 */
export function toV4(world: WorldState): AnyWorld {
  const clone = JSON.parse(JSON.stringify(world)) as AnyWorld;
  delete clone.households;
  delete clone.management;
  delete clone.banking;

  const controls = (clone.governance?.controls ?? []) as AnyWorld[];
  for (const control of controls) {
    delete control.operatorId;
    delete control.termEndTick;
    // v4 的控制权只有 management / boardAppointment 两种来源。
    if (control.operator === 'management') control.basis = 'management';
  }

  const motions = ((clone.governance?.motions ?? []) as AnyWorld[]).filter(
    (motion) => motion.kind !== 'operatorElection',
  );
  for (const motion of motions) {
    for (const vote of (motion.votes ?? []) as AnyWorld[]) delete vote.candidateId;
  }
  if (clone.governance) clone.governance.motions = motions;
  return clone;
}

/** 生成 v4 存档 JSON 文本（结构已降级，formatVersion=4）。 */
export function v4SaveText(
  world: WorldState | AnyWorld,
  savedAt = '2026-11-01T00:00:00.000Z',
): string {
  return JSON.stringify(
    {
      formatVersion: 4,
      gameVersion: '0.3.0',
      savedAt,
      world,
    },
    null,
    2,
  );
}

/** 世界内不属于银行的现金总量：企业现金 + 玩家现金 + 居民投资实体现金。 */
export function totalOwnerCash(world: WorldState | AnyWorld): number {
  const raw = world as AnyWorld;
  const companyCash = ((raw.companies ?? []) as AnyWorld[]).reduce(
    (total, company) => total + (company.cash as number),
    0,
  );
  const investorCash = ((raw.investors ?? []) as AnyWorld[]).reduce(
    (total, investor) => total + (investor.cash as number),
    0,
  );
  return companyCash + ((raw.player?.cash as number) ?? 0) + investorCash;
}

/** 数值数组求和。 */
export function sumOf<T>(items: T[], pick: (item: T) => number): number {
  return items.reduce((total, item) => total + pick(item), 0);
}
