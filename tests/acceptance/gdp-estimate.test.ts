// 验收 G 组：开局 12 个月 GDP 估计与判定窗口（AC-G01–G08）。
// 口径来源：DECISIONS v1 #6、IMPLEMENTATION_v0.7 §3/§4；估计值不是真实交易。
import { describe, expect, it } from 'vitest';
import { createInitialWorld } from '../../src/simulation/core/initializer';
import { recent12MonthGdp, assessCityFiscalRisk } from '../../src/simulation/government/metrics';
import { gdpJudgementValue } from '../../src/simulation/government/gdp-window';
import { laborCapacity } from '../../src/simulation/production/production';
import { RECIPES } from '../../src/data/demo-data';
import { DEMO_CONFIG } from '../../src/data/config';
import { round2 } from '../../src/simulation/core/math';
import { Simulation } from '../../src/simulation/core/simulation';
import { checkInvariants } from '../../src/simulation/core/invariants';
import { cityById } from './helpers';
import type { WorldState } from '../../src/simulation/contracts/types';

function freshWorld(): WorldState {
  return createInitialWorld(DEMO_CONFIG);
}

describe('G01 开局窗口结构', () => {
  it('每城 12 条估计月（tick −12…−1、全部 estimated=true、数值相同）', () => {
    const world = freshWorld();
    for (const city of world.cities) {
      const window = city.gdpWindow ?? [];
      expect(window.length).toBe(12);
      expect(window.map((point) => point.tick)).toEqual([
        -12, -11, -10, -9, -8, -7, -6, -5, -4, -3, -2, -1,
      ]);
      expect(window.every((point) => point.estimated)).toBe(true);
      for (const point of window) {
        expect(point.value).toBe(city.gdpEstimate!.monthlyValue);
      }
    }
  });

  it('估计来源字段完整：月/年一致、利用率假设 0.8、兜底 1、口径说明非空、createdAtTick=0', () => {
    const world = freshWorld();
    for (const city of world.cities) {
      const estimate = city.gdpEstimate!;
      expect(estimate.monthlyValue).toBeGreaterThanOrEqual(0);
      expect(estimate.annualValue).toBeCloseTo(estimate.monthlyValue * 12, 2);
      expect(estimate.utilizationAssumption).toBe(0.8);
      expect(estimate.minAnnualGdp).toBe(1);
      expect(estimate.method.length).toBeGreaterThan(0);
      expect(estimate.note.length).toBeGreaterThan(0);
      expect(estimate.createdAtTick).toBe(0);
    }
  });
});

describe('G02 估计不得冒充真实', () => {
  it('开局真实 GDP/历史/月报保持 0 或空，估计值只进 gdpWindow/gdpEstimate', () => {
    const world = freshWorld();
    for (const city of world.cities) {
      expect(city.gdp).toBe(0);
      expect(city.gdpHistory).toEqual([]);
      expect(city.lastMonth.gdp).toBe(0);
    }
    expect(world.history[0]?.gdp).toBe(0);
    expect(checkInvariants(world)).toEqual([]);
  });
});

describe('G03 估计口径（产出价值 − 中间投入，×80% 只乘一次）', () => {
  it('逐城按公式复算与 gdpEstimate.monthlyValue 一致，窗口合计 = 12 × 月估计', () => {
    const world = freshWorld();
    for (const city of world.cities) {
      let expected = 0;
      for (const company of world.companies) {
        if (company.cityId !== city.id) continue;
        const recipe = RECIPES[company.recipeOutput];
        const outputPrice = city.market[company.recipeOutput]?.price ?? 0;
        let inputCost = 0;
        for (const input of recipe.inputs) {
          inputCost += input.qty * (city.market[input.good]?.price ?? 0);
        }
        const unitValueAdded = Math.max(0, outputPrice - inputCost);
        const producible = Math.min(company.capacity, laborCapacity(company, city, DEMO_CONFIG, world));
        expected += producible * DEMO_CONFIG.government.gdpEstimate.utilizationAssumption * unitValueAdded;
      }
      expect(city.gdpEstimate!.monthlyValue).toBeCloseTo(round2(expected), 2);

      const totals = recent12MonthGdp(world, city.id, DEMO_CONFIG);
      expect(totals.months).toBe(12);
      expect(totals.estimatedMonths).toBe(12);
      expect(totals.realMonths).toBe(0);
      expect(totals.sum).toBeCloseTo(round2(city.gdpEstimate!.monthlyValue * 12), 1);
    }
  });
});

describe('G04 真实月逐月替换估计（依赖块2 pushRealGdpPoint）', () => {
  it('推进 1 个月：窗口仍 12 条，新增 1 条 tick>0 的 real，估计月剩 11 条', () => {
    const sim = Simulation.create();
    const first = sim.tick();
    expect(first.ok, first.error).toBe(true);
    const world = sim.state;
    for (const city of world.cities) {
      const window = city.gdpWindow ?? [];
      expect(window.length).toBe(12);
      const real = window.filter((point) => !point.estimated);
      expect(real.length).toBe(1);
      expect(real[0]!.tick).toBe(world.time.tick);
      expect(real[0]!.value).toBeCloseTo(city.gdp, 2);
      expect(window.filter((point) => point.estimated).length).toBe(11);
      expect(checkInvariants(world)).toEqual([]);
    }
  });

  it('推进 13 个月：窗口保持 ≤12 条、按 tick 升序、最早月份滚动淘汰', () => {
    const sim = Simulation.create();
    for (let index = 0; index < 13; index += 1) {
      const result = sim.tick();
      expect(result.ok, result.error).toBe(true);
    }
    const world = sim.state;
    for (const city of world.cities) {
      const window = city.gdpWindow ?? [];
      expect(window.length).toBeLessThanOrEqual(12);
      expect(window.length).toBe(12);
      const ticks = window.map((point) => point.tick);
      expect([...ticks].sort((a, b) => a - b)).toEqual(ticks);
      expect(ticks[ticks.length - 1]).toBe(world.time.tick);
      // 13 个月真实 GDP 后，估计月应全部被替换（块2 完成后成立）。
      expect(window.every((point) => !point.estimated)).toBe(true);
    }
  });
});

describe('G05 判定分母与风险分级（metrics 已实现，作为绿锚点）', () => {
  it('recent12MonthGdp / gdpJudgementValue 使用 max(minAnnualGdp, 窗口合计)', () => {
    const world = freshWorld();
    const city = cityById(world, 'lanport');
    const totals = recent12MonthGdp(world, city.id, DEMO_CONFIG);
    expect(gdpJudgementValue(city, DEMO_CONFIG)).toBeCloseTo(
      Math.max(DEMO_CONFIG.government.fiscalRisk.minAnnualGdp, totals.sum),
      2,
    );

    // 空窗口时兜底为 1（防除零，不创造产出）。
    const emptyCity = { ...city, gdpWindow: [] };
    expect(gdpJudgementValue(emptyCity as typeof city, DEMO_CONFIG)).toBe(1);
  });

  it('开局无债务时：债务率 0、风险 normal、趋势 unknown、估计月数 12', () => {
    const world = freshWorld();
    const city = cityById(world, 'lanport');
    const summary = assessCityFiscalRisk(world, city.id, DEMO_CONFIG);
    expect(summary.treasury).toBe(city.treasury);
    expect(summary.totalDebt).toBe(0);
    expect(summary.debtRatio).toBe(0);
    expect(summary.riskLevel).toBe('normal');
    expect(summary.riskTrend).toBe('unknown');
    expect(summary.previousSettlementDebtRatio).toBeNull();
    expect(summary.gdpWindowMonths).toBe(12);
    expect(summary.gdpWindowEstimatedMonths).toBe(12);
    expect(summary.gdpJudgementValue).toBe(
      Math.max(DEMO_CONFIG.government.fiscalRisk.minAnnualGdp, summary.gdpWindowSum),
    );
  });
});
