/**
 * 12 个月 GDP 判定窗口（v0.7 契约骨架，块0 空实现）。
 *
 * 口径（DECISIONS v1 #6、v1.2 #22）：
 * - city.gdpWindow 最多 12 条、按 tick 升序；真实月 estimated=false，估计月 estimated=true 且 tick 为负；
 * - 只有该窗口参与债务/GDP 与破产判定；city.gdpHistory 仅用于展示真实历史；
 * - 真实 GDP 到来后从最早的估计月逐月替换（pushRealGdpPoint）；
 * - 判定分母 = max(config.government.fiscalRisk.minAnnualGdp, 窗口合计)。
 *
 * 本文件当前只提供签名与空实现，业务体由游戏程序在块2 填充；签名冻结后只增不改。
 */
import type { City, CityGdpPoint, WorldState } from '../contracts/types';
import type { DemoConfig } from '../../data/config';

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
 */
export function pushRealGdpPoint(
  world: WorldState,
  city: City,
  tick: number,
  value: number,
  config: DemoConfig,
): CityGdpPoint[] {
  void world;
  void value;
  void config;
  // TODO(块2)：真实 GDP 入窗与替换估计月（幂等：同一 tick 不重复插入）。
  void tick;
  return city.gdpWindow ?? [];
}
