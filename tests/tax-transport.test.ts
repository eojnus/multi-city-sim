import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation/core/simulation';
import { DEMO_CONFIG } from '../src/data/config';
import type { City, TransportIntracityStats, WorldState } from '../src/simulation/contracts/types';
import {
  accrueConsumptionTax,
  accrueDividendTax,
  latestTaxMonth,
  settleCityTaxes,
  taxAccrualOf,
  transportTaxFactorFor,
  transportTaxFactors,
  type TransportTaxFactor,
} from '../src/simulation/government/taxes';
import { settleGovernment } from '../src/simulation/government/fiscal';
import type { FinanceResult } from '../src/simulation/finance/finance';

function cityOf(world: WorldState, cityId = 'lanport'): City {
  return world.cities.find((city) => city.id === cityId)!;
}

function withIntracity(world: WorldState, entries: TransportIntracityStats[]): WorldState {
  world.transport.lastMonth = { ...world.transport.lastMonth, intracity: entries };
  return world;
}

function intracity(cityId: string, demand: number, capacity: number): TransportIntracityStats {
  return {
    cityId,
    demand,
    capacity,
    utilization: demand > 0 ? capacity / demand : 0,
    deliveryEfficiency: 1,
  };
}

function financeStub(cityId: string): FinanceResult {
  return {
    investorDividendsByCity: { [cityId]: 10_000 },
    investorDistributionByCity: { [cityId]: 7_000 },
    cityDividendsByCity: {},
    dividendsByCity: {},
    playerDividends: 0,
    playerDividendsByCompany: {},
    corporateTaxByCity: { [cityId]: 20_000 },
    privateWagesByCity: { [cityId]: 200_000 },
    wageArrears: 0,
  };
}

function neutralFactors(world: WorldState): Record<string, TransportTaxFactor> {
  return transportTaxFactors(world, DEMO_CONFIG);
}

describe('v0.8 交通税收系数：由上一完整月城内配送保障率决定', () => {
  it('无运输统计/无需求时系数中性 1.0、保障率 0', () => {
    const world = Simulation.create().state;
    expect(world.transport.lastMonth.intracity).toEqual([]);
    // 无需求时中性系数 1.0，guarantee 按 baseFactor 反推仅用于展示。
    expect(transportTaxFactorFor(world, 'lanport', DEMO_CONFIG)).toEqual({ guarantee: 0.5, factor: 1 });

    withIntracity(world, [intracity('lanport', 0, 0)]);
    expect(transportTaxFactorFor(world, 'lanport', DEMO_CONFIG)).toEqual({ guarantee: 0.5, factor: 1 });
  });

  it('容量 0 → 保障率 0、系数 0.5；50% → 1.0；100% → 1.5（上限截断）', () => {
    const world = Simulation.create().state;
    withIntracity(world, [intracity('lanport', 1_000, 0)]);
    expect(transportTaxFactorFor(world, 'lanport', DEMO_CONFIG)).toEqual({ guarantee: 0, factor: 0.5 });

    withIntracity(world, [intracity('lanport', 1_000, 500)]);
    expect(transportTaxFactorFor(world, 'lanport', DEMO_CONFIG)).toEqual({ guarantee: 0.5, factor: 1 });

    withIntracity(world, [intracity('lanport', 1_000, 1_000)]);
    expect(transportTaxFactorFor(world, 'lanport', DEMO_CONFIG)).toEqual({ guarantee: 1, factor: 1.5 });

    // 供大于求同样截断在 100% 保障率。
    withIntracity(world, [intracity('lanport', 100, 10_000)]);
    expect(transportTaxFactorFor(world, 'lanport', DEMO_CONFIG)).toEqual({ guarantee: 1, factor: 1.5 });
  });

  it('逐城市读取各自的城内配送统计，未出现的城市保持中性', () => {
    const world = Simulation.create().state;
    withIntracity(world, [intracity('lanport', 1_000, 1_000)]);
    const factors = transportTaxFactors(world, DEMO_CONFIG);
    expect(factors.lanport!.factor).toBeCloseTo(1.5, 6);
    const other = world.cities.find((city) => city.id !== 'lanport')!;
    expect(factors[other.id]!.factor).toBeCloseTo(1, 6);
  });
});

describe('v0.8 交通税收系数：四税按系数入账、加成/损耗分账', () => {
  function seededWorld() {
    const world = Simulation.create().state;
    const city = cityOf(world);
    city.treasury = 1_000_000;
    accrueConsumptionTax(world, city.id, 1_000);
    accrueDividendTax(world, city.id, 2_000);
    return { world, city };
  }

  it('系数 1.5：四税收入放大，加成单独记账，纳税人基准不变', () => {
    const { world, city } = seededWorld();
    const beforeTreasury = city.treasury;
    const month = settleCityTaxes(
      world,
      city,
      { incomeTaxBase: 10_000, corporateTaxBase: 20_000 },
      { guarantee: 1, factor: 1.5 },
      DEMO_CONFIG,
      world.time.tick,
    );

    expect(month.incomeTaxRevenue).toBeCloseTo(15_000, 6);
    expect(month.corporateTaxRevenue).toBeCloseTo(30_000, 6);
    expect(month.consumptionTaxRevenue).toBeCloseTo(1_500, 6);
    expect(month.dividendTaxRevenue).toBeCloseTo(3_000, 6);
    expect(month.totalBase).toBeCloseTo(33_000, 6);
    expect(month.totalRevenue).toBeCloseTo(49_500, 6);
    expect(month.transportBonus).toBeCloseTo(16_500, 6);
    expect(month.transportLoss).toBe(0);
    expect(city.treasury - beforeTreasury).toBeCloseTo(49_500, 6);

    // city.lastMonth 与 latestTaxMonth 一致。
    expect(city.lastMonth.consumptionTax).toBeCloseTo(1_500, 6);
    expect(city.lastMonth.dividendTax).toBeCloseTo(3_000, 6);
    expect(city.lastMonth.transportTaxFactor).toBe(1.5);
    expect(city.lastMonth.transportTaxBonus).toBeCloseTo(16_500, 6);
    expect(city.lastMonth.transportTaxLoss).toBe(0);
    expect(latestTaxMonth(world, city.id)!.tick).toBe(world.time.tick);

    // 财政流水口径（v0.8 复验问题 1）：四税按**基准税额**记账，交通调整单列，
    // 流水净额 = 基准 33,000 + 加成 16,500 = 实际入账 49,500，不重复计算。
    const entries = world.fiscal.ledger.filter((entry) => entry.cityId === city.id);
    const amountOf = (kind: string) =>
      entries.filter((entry) => entry.kind === kind).reduce((sum, entry) => sum + entry.amount, 0);
    expect(amountOf('incomeTax')).toBeCloseTo(10_000, 6);
    expect(amountOf('corporateTax')).toBeCloseTo(20_000, 6);
    expect(amountOf('consumptionTax')).toBeCloseTo(1_000, 6);
    expect(amountOf('dividendTax')).toBeCloseTo(2_000, 6);
    expect(amountOf('transportTaxBonus')).toBeCloseTo(16_500, 6);
    expect(amountOf('transportTaxLoss')).toBe(0);
    expect(entries.reduce((sum, entry) => sum + entry.amount, 0)).toBeCloseTo(49_500, 6);
    // 月结后本月税收累计清零。
    expect(taxAccrualOf(world, city.id)).toEqual({ consumptionTax: 0, dividendTax: 0 });
  });

  it('系数 0.5：实际入账减半，损耗作为负向流水且不退还纳税人', () => {
    const { world, city } = seededWorld();
    const beforeTreasury = city.treasury;
    const month = settleCityTaxes(
      world,
      city,
      { incomeTaxBase: 10_000, corporateTaxBase: 20_000 },
      { guarantee: 0, factor: 0.5 },
      DEMO_CONFIG,
      world.time.tick,
    );

    expect(month.totalBase).toBeCloseTo(33_000, 6);
    expect(month.totalRevenue).toBeCloseTo(16_500, 6);
    expect(month.transportBonus).toBe(0);
    expect(month.transportLoss).toBeCloseTo(16_500, 6);
    expect(city.treasury - beforeTreasury).toBeCloseTo(16_500, 6);
    expect(city.lastMonth.transportTaxLoss).toBeCloseTo(16_500, 6);

    const lossEntries = world.fiscal.ledger.filter(
      (entry) => entry.cityId === city.id && entry.kind === 'transportTaxLoss',
    );
    expect(lossEntries).toHaveLength(1);
    expect(lossEntries[0]!.amount).toBeCloseTo(-16_500, 6);
    // 四税仍按基准税额入账（10,000+20,000+1,000+2,000），与损耗分列；净额=16,500。
    const taxBaseEntries = world.fiscal.ledger
      .filter((entry) => entry.cityId === city.id && entry.kind !== 'transportTaxLoss')
      .reduce((sum, entry) => sum + entry.amount, 0);
    expect(taxBaseEntries).toBeCloseTo(33_000, 6);
    const bonusEntries = world.fiscal.ledger.filter(
      (entry) => entry.cityId === city.id && entry.kind === 'transportTaxBonus',
    );
    expect(bonusEntries).toHaveLength(0);
  });
});

describe('v0.8 交通税收系数：财政月结与逐月接线', () => {
  it('纳税人实付不变：不同系数下居民收入、基准个税与群体现金一致，财政差额=加成/损耗', () => {
    const run = (factor: number) => {
      const world = Simulation.create().state;
      const city = cityOf(world);
      city.treasury = 10_000_000;
      accrueConsumptionTax(world, city.id, 1_000);
      accrueDividendTax(world, city.id, 2_000);
      const factors = neutralFactors(world);
      factors[city.id] = { guarantee: factor === 1.5 ? 1 : factor === 0.5 ? 0 : 0.5, factor };
      const treasuryBefore = city.treasury;
      const finance = financeStub(city.id);
      settleGovernment(world, finance, DEMO_CONFIG, [], {}, factors);
      const month = latestTaxMonth(world, city.id)!;
      return {
        world,
        city,
        month,
        householdIncome: city.lastMonth.householdIncome ?? 0,
        incomeTax: city.lastMonth.incomeTax ?? 0,
        groupCash: world.investors
          .filter((group) => group.cityId === city.id)
          .map((group) => group.cash),
        treasuryDelta: city.treasury - treasuryBefore,
      };
    };
    const base = run(1);
    const bonus = run(1.5);
    const loss = run(0.5);

    // 纳税人实付（居民收入口径、基准个税、居民群体现金）与系数无关。
    expect(bonus.householdIncome).toBeCloseTo(base.householdIncome, 6);
    expect(loss.householdIncome).toBeCloseTo(base.householdIncome, 6);
    expect(bonus.incomeTax).toBeCloseTo(base.incomeTax, 6);
    expect(loss.incomeTax).toBeCloseTo(base.incomeTax, 6);
    expect(bonus.groupCash).toEqual(base.groupCash);
    expect(loss.groupCash).toEqual(base.groupCash);

    // 财政差额恰为加成/损耗，分账条目金额与差额一致。
    expect(bonus.treasuryDelta - base.treasuryDelta).toBeCloseTo(
      round2Signed(bonus.month.totalBase * 0.5),
      6,
    );
    expect(loss.treasuryDelta - base.treasuryDelta).toBeCloseTo(
      round2Signed(-loss.month.totalBase * 0.5),
      6,
    );
    const bonusEntry = bonus.world.fiscal.ledger.find(
      (entry) => entry.cityId === bonus.city.id && entry.kind === 'transportTaxBonus',
    )!;
    expect(bonusEntry.amount).toBeCloseTo(bonus.month.transportBonus, 6);
    const lossEntry = loss.world.fiscal.ledger.find(
      (entry) => entry.cityId === loss.city.id && entry.kind === 'transportTaxLoss',
    )!;
    expect(lossEntry.amount).toBeCloseTo(-loss.month.transportLoss, 6);
  });

  it('simulation.tick 在覆盖上月运输统计前取整月数据：首月中性、次月按上月保障率 1.5 计征', () => {
    const sim = Simulation.create();
    const world = sim.state;
    const city = cityOf(world);
    // 设置“上一完整月”城内配送满载：保障率 1、系数 1.5。
    withIntracity(world, [intracity(city.id, 1_000, 1_000)]);
    const result = sim.tick();
    expect(result.ok).toBe(true);

    const month = latestTaxMonth(world, city.id)!;
    expect(month.transportFactor).toBeCloseTo(1.5, 6);
    expect(month.transportGuarantee).toBeCloseTo(1, 6);
    expect(city.lastMonth.transportTaxFactor).toBeCloseTo(1.5, 6);
    const bonusEntry = world.fiscal.ledger.find(
      (entry) => entry.cityId === city.id && entry.kind === 'transportTaxBonus',
    );
    expect(bonusEntry).toBeDefined();
    expect(bonusEntry!.amount).toBeCloseTo(month.transportBonus, 6);

    // 无上一月统计的城市保持中性 1.0。
    const other = world.cities.find((entry) => entry.id !== city.id)!;
    expect(latestTaxMonth(world, other.id)!.transportFactor).toBeCloseTo(1, 6);
  });
});

function round2Signed(value: number): number {
  return Math.round(value * 100) / 100;
}
