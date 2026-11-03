// v0.8 复验问题 1：交通税收加成/损耗的财政流水口径。
//
// 口径（首席架构师验收）：
// - 纳税人只支付基准税额；
// - 财政流水 = 基准税 + 交通财政加成 − 交通征收损耗；
// - 流水净额、财政余额变化、市长面板当月收入−支出、税收月报最终入账四者必须一致；
// - 四税分别可查基准/调整后收入；
// - 读档后与重复结算不得重复入账。

import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation/core/simulation';
import { DEMO_CONFIG } from '../src/data/config';
import type { City, WorldState } from '../src/simulation/contracts/types';
import {
  accrueConsumptionTax,
  accrueDividendTax,
  settleCityTaxes,
} from '../src/simulation/government/taxes';
import { buildMayorFiscalView } from '../src/simulation/government/fiscal-view';
import { parseSave, serializeSave } from '../src/simulation/core/save';
import { round2 } from '../src/simulation/core/math';

function setUp(): { world: WorldState; city: City } {
  const world = Simulation.create().state;
  const city = world.cities.find((candidate) => candidate.id === 'lanport');
  if (!city) throw new Error('缺少岚港');
  return { world, city };
}

function factorOf(factor: number) {
  return { guarantee: round2(factor - 0.5), factor };
}

/** 本月该城财政流水中各类金额（正数=收入，负数=支出）。 */
function ledgerFor(world: WorldState, cityId: string, tick: number) {
  const entries = (world.fiscal?.ledger ?? []).filter(
    (entry) => entry.tick === tick && entry.cityId === cityId,
  );
  const byKind = new Map<string, number>();
  for (const entry of entries) byKind.set(entry.kind, round2(entry.amount));
  const net = round2(entries.reduce((sum, entry) => sum + entry.amount, 0));
  return { entries, byKind, net };
}

describe('交通税收系数：流水/余额/市长面板/税收月报口径一致', () => {
  it('系数 1.5：流水 = 基准 100 + 加成 50，面板收入 150、支出 0、净额 150', () => {
    const { world, city } = setUp();
    const tick = world.time.tick;
    const before = city.treasury;
    const playerCashBefore = world.player.cash;

    const month = settleCityTaxes(
      world,
      city,
      { incomeTaxBase: 100, corporateTaxBase: 0 },
      factorOf(1.5),
      DEMO_CONFIG,
      tick,
    );

    expect(city.treasury - before).toBeCloseTo(150, 2);
    const ledger = ledgerFor(world, city.id, tick);
    expect(ledger.byKind.get('incomeTax')).toBeCloseTo(100, 2);
    expect(ledger.byKind.get('transportTaxBonus')).toBeCloseTo(50, 2);
    expect(ledger.byKind.get('transportTaxLoss')).toBeUndefined();
    expect(ledger.net).toBeCloseTo(150, 2);
    expect(month.totalBase).toBeCloseTo(100, 2);
    expect(month.incomeTaxRevenue).toBeCloseTo(150, 2);
    expect(month.transportBonus).toBeCloseTo(50, 2);

    const view = buildMayorFiscalView(world, city, DEMO_CONFIG, { playerId: 'player', mayorCityId: city.id });
    expect(view).not.toBeNull();
    expect(view!.monthIncome).toBeCloseTo(150, 2);
    expect(view!.monthExpense).toBeCloseTo(0, 2);
    expect(view!.monthIncome - view!.monthExpense).toBeCloseTo(city.treasury - before, 2);
    // 纳税人（玩家现金）不因交通加成被额外扣款。
    expect(world.player.cash).toBeCloseTo(playerCashBefore, 2);
  });

  it('系数 1.0：流水只有基准税，面板净额与财政增量一致', () => {
    const { world, city } = setUp();
    const tick = world.time.tick;
    const before = city.treasury;
    const month = settleCityTaxes(
      world,
      city,
      { incomeTaxBase: 100, corporateTaxBase: 0 },
      factorOf(1.0),
      DEMO_CONFIG,
      tick,
    );
    expect(city.treasury - before).toBeCloseTo(100, 2);
    const ledger = ledgerFor(world, city.id, tick);
    expect(ledger.byKind.get('incomeTax')).toBeCloseTo(100, 2);
    expect(ledger.byKind.get('transportTaxBonus')).toBeUndefined();
    expect(ledger.byKind.get('transportTaxLoss')).toBeUndefined();
    const view = buildMayorFiscalView(world, city, DEMO_CONFIG, { playerId: 'player', mayorCityId: city.id })!;
    expect(view.monthIncome).toBeCloseTo(100, 2);
    expect(view.monthExpense).toBeCloseTo(0, 2);
    expect(view.monthIncome - view.monthExpense).toBeCloseTo(city.treasury - before, 2);
    expect(month.totalRevenue).toBeCloseTo(100, 2);
  });

  it('系数 0.5：流水 = 基准 100 − 损耗 50，面板收入 100、支出 50、净额 50', () => {
    const { world, city } = setUp();
    const tick = world.time.tick;
    const before = city.treasury;
    const month = settleCityTaxes(
      world,
      city,
      { incomeTaxBase: 100, corporateTaxBase: 0 },
      factorOf(0.5),
      DEMO_CONFIG,
      tick,
    );
    expect(city.treasury - before).toBeCloseTo(50, 2);
    const ledger = ledgerFor(world, city.id, tick);
    expect(ledger.byKind.get('incomeTax')).toBeCloseTo(100, 2);
    expect(ledger.byKind.get('transportTaxLoss')).toBeCloseTo(-50, 2);
    expect(ledger.net).toBeCloseTo(50, 2);
    expect(month.transportLoss).toBeCloseTo(50, 2);
    expect(month.incomeTaxRevenue).toBeCloseTo(50, 2);

    const view = buildMayorFiscalView(world, city, DEMO_CONFIG, { playerId: 'player', mayorCityId: city.id })!;
    expect(view.monthIncome).toBeCloseTo(100, 2);
    expect(view.monthExpense).toBeCloseTo(50, 2);
    expect(view.monthIncome - view.monthExpense).toBeCloseTo(50, 2);
    expect(view.monthIncome - view.monthExpense).toBeCloseTo(city.treasury - before, 2);
  });

  it('四种税分别可查基准/最终，合计与流水净额、财政增量一致', () => {
    const { world, city } = setUp();
    const tick = world.time.tick;
    accrueConsumptionTax(world, city.id, 20);
    accrueDividendTax(world, city.id, 10);
    const before = city.treasury;
    const month = settleCityTaxes(
      world,
      city,
      { incomeTaxBase: 60, corporateTaxBase: 40 },
      factorOf(1.5),
      DEMO_CONFIG,
      tick,
    );
    expect(month.totalBase).toBeCloseTo(130, 2);
    expect(month.totalRevenue).toBeCloseTo(195, 2);
    expect(month.incomeTaxBase).toBeCloseTo(60, 2);
    expect(month.incomeTaxRevenue).toBeCloseTo(90, 2);
    expect(month.corporateTaxRevenue).toBeCloseTo(60, 2);
    expect(month.consumptionTaxBase).toBeCloseTo(20, 2);
    expect(month.consumptionTaxRevenue).toBeCloseTo(30, 2);
    expect(month.dividendTaxBase).toBeCloseTo(10, 2);
    expect(month.dividendTaxRevenue).toBeCloseTo(15, 2);
    expect(month.transportBonus).toBeCloseTo(65, 2);
    expect(city.treasury - before).toBeCloseTo(195, 2);

    const ledger = ledgerFor(world, city.id, tick);
    expect(ledger.byKind.get('incomeTax')).toBeCloseTo(60, 2);
    expect(ledger.byKind.get('corporateTax')).toBeCloseTo(40, 2);
    expect(ledger.byKind.get('consumptionTax')).toBeCloseTo(20, 2);
    expect(ledger.byKind.get('dividendTax')).toBeCloseTo(10, 2);
    expect(ledger.byKind.get('transportTaxBonus')).toBeCloseTo(65, 2);
    expect(ledger.net).toBeCloseTo(195, 2);
    expect(ledger.byKind.get('incomeTax')).toBeCloseTo(month.incomeTaxBase, 2);
    expect(ledger.byKind.get('consumptionTax')).toBeCloseTo(month.consumptionTaxBase, 2);

    // 本月累计清零：同一 tick 重复调用不会把消费税/股息税再结算一次。
    const treasuryAfterFirst = city.treasury;
    const again = settleCityTaxes(
      world,
      city,
      { incomeTaxBase: 0, corporateTaxBase: 0 },
      factorOf(1.5),
      DEMO_CONFIG,
      tick,
    );
    expect(again.consumptionTaxBase).toBeCloseTo(0, 2);
    expect(again.dividendTaxBase).toBeCloseTo(0, 2);
    expect(city.treasury).toBeCloseTo(treasuryAfterFirst, 2);
  });

  it('读档后再次结算：不会重复计入已结算的消费税/股息税', () => {
    const { world, city } = setUp();
    const tick = world.time.tick;
    accrueConsumptionTax(world, city.id, 50);
    settleCityTaxes(
      world,
      city,
      { incomeTaxBase: 10, corporateTaxBase: 0 },
      factorOf(1.5),
      DEMO_CONFIG,
      tick,
    );
    const treasuryBeforeSave = city.treasury;
    const historyLength = world.taxes.historyByCity[city.id]?.length ?? 0;

    // 存档 → 读档（同一世界状态往返）。
    const parsed = parseSave(serializeSave(world, '2026-01-01T00:00:00.000Z'));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const restored = parsed.world;
    if (!restored) return;
    const restoredCity = restored.cities.find((candidate) => candidate.id === city.id)!;
    expect(restoredCity.treasury).toBeCloseTo(treasuryBeforeSave, 2);
    expect((restored.taxes.historyByCity[city.id]?.length ?? 0)).toBe(historyLength);

    // 读档后同月再结算一次：基准税为 0、累计已清零，只应记录一条 0 收入月报，不重复入账。
    const again = settleCityTaxes(
      restored,
      restoredCity,
      { incomeTaxBase: 0, corporateTaxBase: 0 },
      factorOf(1.5),
      DEMO_CONFIG,
      tick,
    );
    expect(again.totalRevenue).toBeCloseTo(0, 2);
    expect(restoredCity.treasury).toBeCloseTo(treasuryBeforeSave, 2);
  });
});
