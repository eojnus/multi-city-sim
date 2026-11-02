import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation/core/simulation';
import { DEMO_CONFIG } from '../src/data/config';
import type { WorldState } from '../src/simulation/contracts/types';
import { checkInvariants } from '../src/simulation/core/invariants';
import { parseSave, serializeSave } from '../src/simulation/core/save';
import {
  gdpJudgementValue,
  pushRealGdpPoint,
  sumGdpWindow,
} from '../src/simulation/government/gdp-window';

const CONFIG = DEMO_CONFIG;

function newWorld(): WorldState {
  return Simulation.create().state;
}

function mainCity(world: WorldState) {
  const city = world.cities[0];
  if (!city) throw new Error('缺少城市');
  return city;
}

describe('12 个月 GDP 判定窗口', () => {
  it('开局有 12 条估计月（tick −12…−1），估计月 tick 为负', () => {
    const world = newWorld();
    const city = mainCity(world);
    expect(city.gdpWindow).toHaveLength(12);
    expect(city.gdpWindow.map((point) => point.tick)).toEqual([
      -12, -11, -10, -9, -8, -7, -6, -5, -4, -3, -2, -1,
    ]);
    expect(city.gdpWindow.every((point) => point.estimated)).toBe(true);
    expect(sumGdpWindow(city)).toMatchObject({ months: 12, estimatedMonths: 12, realMonths: 0 });
  });

  it('真实 GDP 入窗：删除最早的估计月、窗口保持 12 条且按 tick 升序', () => {
    const world = newWorld();
    const city = mainCity(world);
    pushRealGdpPoint(world, city, 1, 12_345, CONFIG);
    expect(city.gdpWindow).toHaveLength(12);
    expect(city.gdpWindow.map((point) => point.tick)).toEqual([
      -11, -10, -9, -8, -7, -6, -5, -4, -3, -2, -1, 1,
    ]);
    const real = city.gdpWindow.filter((point) => !point.estimated);
    expect(real).toHaveLength(1);
    expect(real[0]).toMatchObject({ tick: 1, value: 12_345 });
    expect(sumGdpWindow(city)).toMatchObject({ estimatedMonths: 11, realMonths: 1 });
  });

  it('同一 tick 重复入窗幂等（只更新数值，不重复插入）', () => {
    const world = newWorld();
    const city = mainCity(world);
    pushRealGdpPoint(world, city, 1, 10_000, CONFIG);
    pushRealGdpPoint(world, city, 1, 11_000, CONFIG);
    expect(city.gdpWindow).toHaveLength(12);
    const real = city.gdpWindow.filter((point) => point.tick === 1);
    expect(real).toHaveLength(1);
    expect(real[0]).toMatchObject({ estimated: false, value: 11_000 });
  });

  it('连续 12 个真实月后窗口全是真实值，再入窗淘汰最旧真实月', () => {
    const world = newWorld();
    const city = mainCity(world);
    for (let tick = 1; tick <= 12; tick += 1) {
      pushRealGdpPoint(world, city, tick, 1_000 + tick, CONFIG);
    }
    expect(city.gdpWindow.map((point) => point.tick)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ]);
    expect(city.gdpWindow.every((point) => !point.estimated)).toBe(true);

    pushRealGdpPoint(world, city, 13, 2_000, CONFIG);
    expect(city.gdpWindow).toHaveLength(12);
    expect(city.gdpWindow[0]?.tick).toBe(2);
    expect(city.gdpWindow[11]?.tick).toBe(13);
  });

  it('判定分母 = max(minAnnualGdp, 窗口合计) 且负值被截为 0', () => {
    const world = newWorld();
    const city = mainCity(world);
    city.gdpWindow = [{ tick: -1, value: 0, estimated: true }];
    expect(gdpJudgementValue(city, CONFIG)).toBe(CONFIG.government.fiscalRisk.minAnnualGdp);

    city.gdpWindow = [{ tick: 1, value: 5_000, estimated: false }];
    expect(gdpJudgementValue(city, CONFIG)).toBe(5_000);

    pushRealGdpPoint(world, city, 2, -100, CONFIG);
    expect(city.gdpWindow.find((point) => point.tick === 2)?.value).toBe(0);
  });

  it('入窗后不变量对 GDP 窗口无报错，且存档往返保留窗口', () => {
    const world = newWorld();
    const city = mainCity(world);
    for (let tick = 1; tick <= 6; tick += 1) {
      pushRealGdpPoint(world, city, tick, 2_000 + tick, CONFIG);
    }
    const problems = checkInvariants(world).filter((problem) => problem.includes('GDP'));
    expect(problems).toEqual([]);

    const parsed = parseSave(serializeSave(world, '2026-11-02T00:00:00.000Z'));
    expect(parsed.ok).toBe(true);
    const restored = parsed.world!;
    const restoredCity = restored.cities[0]!;
    expect(restoredCity.gdpWindow).toEqual(city.gdpWindow);
  });
});
