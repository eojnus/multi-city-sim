/**
 * 12 个月 GDP 判定窗口（v0.7 契约，块2 实现）。
 *
 * 口径（DECISIONS v1 #6、v1.2 #22、v1.4 #32）：
 * - city.gdpWindow 最多 12 条、按 tick 升序；真实月 estimated=false，估计月 estimated=true 且 tick 为负；
 * - 只有该窗口参与债务/GDP 与破产判定；city.gdpHistory 仅用于展示真实历史；
 * - 真实 GDP 到来后从最早的估计月逐月替换（pushRealGdpPoint）；
 * - 判定分母 = max(config.government.fiscalRisk.minAnnualGdp, 窗口合计)。
 *
 * 幂等：同一 tick 重复入窗只更新数值，不重复插入；窗口按 tick 升序去重后截取最近 windowMonths 条。
 */
import type { City, CityGdpPoint, WorldState } from '../contracts/types';
import type { DemoConfig } from '../../data/config';
import { round2 } from '../core/math';

export interface GdpWindowTotals {
  months: number;
  sum: number;
  estimatedMonths: number;
  realMonths: number;
}

/** 窗口合计（含数量统计；不修改状态）。 */
export function sumGdpWindow(city: City): GdpWindowTotals {
  const points = city.gdpWindow ?? [];
  let sum = 0;
  let estimatedMonths = 0;
  for (const point of points) {
    sum += point.value;
    if (point.estimated) estimatedMonths += 1;
  }
  return {
    months: points.length,
    sum: Math.round(sum * 100) / 100,
    estimatedMonths,
    realMonths: points.length - estimatedMonths,
  };
}

/** 判定分母 = max(minAnnualGdp, 窗口合计)。 */
export function gdpJudgementValue(city: City, config: DemoConfig): number {
  const totals = sumGdpWindow(city);
  return Math.max(config.government.fiscalRisk.minAnnualGdp, totals.sum);
}

/**
 * 记录本月真实 GDP 到判定窗口：真实点标记 estimated=false，替换最早的估计月；
 * 窗口保持最多 windowMonths 条、按 tick 升序。
 *
 * 规则（IMPLEMENTATION_v0.7 §7 / 设计稿 §4.1）：
 * 1. 同一 tick 已存在（估计或真实）→ 原地更新数值并标记为真实，不新增条目；
 * 2. 否则删除一条最早的估计月（若仍有估计值），再把真实点插入；
 * 3. 排序后只保留最近 windowMonths 条（窗口已满且全是真实时淘汰最旧的真实月）。
 */
export function pushRealGdpPoint(
  world: WorldState,
  city: City,
  tick: number,
  value: number,
  config: DemoConfig,
): CityGdpPoint[] {
  void world;
  const windowMonths = Math.max(1, config.government.gdpEstimate.windowMonths);
  if (!Array.isArray(city.gdpWindow)) city.gdpWindow = [];
  const points = city.gdpWindow;
  const rounded = round2(Math.max(0, Number.isFinite(value) ? value : 0));

  const existing = points.find((point) => point.tick === tick);
  if (existing) {
    existing.value = rounded;
    existing.estimated = false;
  } else {
    // 删除最早的估计月：窗口在开局由 initializer 写入 −12…−1，按 tick 升序逐月替换。
    let earliestEstimated: CityGdpPoint | null = null;
    for (const point of points) {
      if (!point.estimated) continue;
      if (earliestEstimated === null || point.tick < earliestEstimated.tick) {
        earliestEstimated = point;
      }
    }
    if (earliestEstimated !== null) {
      points.splice(points.indexOf(earliestEstimated), 1);
    }
    points.push({ tick, value: rounded, estimated: false });
  }

  points.sort((a, b) => a.tick - b.tick);
  while (points.length > windowMonths) points.shift();
  return points;
}
