// 验收 H08/H09：新档在到期月/破产月读档后，结算结果与不读档一致；重复读档不重复结算。
// 只读 src/** 公开 API（save.parseSave/serializeSave、Simulation），不改产品代码。
import { beforeAll, describe, expect, it } from 'vitest';
import { DEMO_CONFIG } from '../../src/data/config';
import { parseSave, serializeSave } from '../../src/simulation/core/save';
import { Simulation } from '../../src/simulation/core/simulation';
import type { BondHolder, WorldState } from '../../src/simulation/contracts/types';
import {
  issueGovernmentBond,
  subscribeGovernmentBond,
  closeGovernmentBondSubscription,
} from '../../src/simulation/government/bonds';
import { cityById, newWorld } from './helpers';

const STAMP = '2026-11-01T00:00:00.000Z';
const PLAYER: BondHolder = { kind: 'player', id: 'player' };

function text(world: WorldState): string {
  return serializeSave(world, STAMP);
}

function load(textValue: string): Simulation {
  const result = parseSave(textValue);
  if (!result.ok || !result.world) throw new Error(`读档失败：${result.error}`);
  return new Simulation(result.world, DEMO_CONFIG);
}

describe('H08 到期月读档：结算结果与不读档一致', () => {
  it('到期前存档 → 读档推进与连续推进逐字段一致，到期本金只付一次', () => {
    const world = newWorld(0);
    const sim = new Simulation(world, DEMO_CONFIG);
    // 财政充足，保证城市不破产，债券能走到 36 月正常到期。
    for (const city of world.cities) city.treasury = 1e12;
    const city = cityById(world, 'lanport');
    world.player.cash = 10 * DEMO_CONFIG.government.bondMarket.faceValue;
    const issued = issueGovernmentBond(world, city, DEMO_CONFIG, 10, 0);
    expect(issued.ok, issued.error).toBe(true);
    const issuance = issued.issuance!;
    expect(subscribeGovernmentBond(world, DEMO_CONFIG, issuance.id, PLAYER, 10, 0).units).toBe(10);
    expect(closeGovernmentBondSubscription(world, DEMO_CONFIG, issuance.id, 0).ok).toBe(true);

    const maturityTick = issuance.maturityTick;
    while (world.time.tick < maturityTick - 1) sim.tick();
    expect(world.time.tick).toBe(maturityTick - 1);

    const saveText = text(world);
    const continuous = sim.tick();
    expect(continuous.ok).toBe(true);
    const loaded = load(saveText);
    expect(loaded.tick().ok).toBe(true);

    // 双路径逐字段一致（含 RNG 推进、账目、日志、债券流水）。
    expect(text(loaded.state)).toBe(text(world));

    // 到期兑付：本金流水恰好一条，且城市未被提前破产兑付。
    expect(issuance.status).toBe('redeemed');
    const principalPayments = (world.bonds?.payments ?? []).filter(
      (payment) => payment.kind === 'principal' && payment.issuanceId === issuance.id,
    );
    expect(principalPayments).toHaveLength(1);
    expect(principalPayments[0]!.tick).toBe(maturityTick);
    expect(principalPayments[0]!.principalPaid).toBe(10 * DEMO_CONFIG.government.bondMarket.faceValue);
    expect(
      (world.bonds?.payments ?? []).filter(
        (payment) => payment.kind === 'bankruptcyRedemption' && payment.issuanceId === issuance.id,
      ),
    ).toHaveLength(0);
  });
});

/** 真实序列里首次政府破产的 tick（随数值调整自动发现，避免硬编码失效）。 */
let bankruptTick = 0;
beforeAll(() => {
  const probe = Simulation.create();
  for (let index = 0; index < 36; index += 1) {
    probe.tick();
    const ticks = probe.state.cities.flatMap((entry) =>
      entry.government!.records.map((record) => record.tick),
    );
    if (ticks.length > 0) {
      bankruptTick = Math.min(...ticks);
      break;
    }
  }
  expect(bankruptTick).toBeGreaterThan(0);
}, 180_000);

describe('H09 破产月读档：不重复结算/重复选举', () => {
  it('破产前存档 → 读档推进，两路径一致且破产记录/选举各一次', () => {
    const sim = Simulation.create();
    for (let index = 0; index < bankruptTick - 1; index += 1) sim.tick();
    expect(sim.state.time.tick).toBe(bankruptTick - 1);

    const saveText = text(sim.state);
    const continued = sim.tick();
    expect(continued.ok).toBe(true);
    const resumed = load(saveText);
    expect(resumed.tick().ok).toBe(true);
    expect(text(resumed.state)).toBe(text(sim.state));

    // 首个破产城市：记录 1 条、同 tick 选举 1 次、不重复。
    const bankruptCity = sim.state.cities.find(
      (entry) => entry.government!.records.length > 0,
    )!;
    expect(bankruptCity.government!.records.map((record) => record.tick)).toEqual([bankruptTick]);
    expect(
      sim.state.politics!.elections.filter(
        (entry) => entry.cityId === bankruptCity.id && entry.tick === bankruptTick,
      ),
    ).toHaveLength(1);
    // 同一份存档读两次再推进，结果仍一致（重复读档不重复结算）。
    const repeat = load(saveText);
    repeat.tick();
    expect(text(repeat.state)).toBe(text(sim.state));
  });

  it('破产后存档 → 读档推进，不重复兑付/不重复建垫付贷款', () => {
    const sim = Simulation.create();
    for (let index = 0; index < bankruptTick; index += 1) sim.tick();
    const bankruptCity = sim.state.cities.find(
      (entry) => entry.government!.records.length > 0,
    )!;
    const record = bankruptCity.government!.records[0]!;
    expect(record.tick).toBe(bankruptTick);
    expect(record.bankAdvanceCreated).toBeGreaterThan(0);
    const bankPaymentsAtTrigger = sim.state.bonds!.payments.filter(
      (payment) => payment.kind === 'bankruptcyRedemption' && payment.tick === bankruptTick,
    ).length;

    const saveText = text(sim.state);
    sim.tick();
    const resumed = load(saveText);
    resumed.tick();
    expect(text(resumed.state)).toBe(text(sim.state));

    // 读档后下一月不再重放破产兑付流水，也不新建同 tick 垫付贷款。
    expect(
      sim.state.bonds!.payments.filter(
        (payment) =>
          payment.kind === 'bankruptcyRedemption' && payment.tick === bankruptTick + 1,
      ),
    ).toHaveLength(0);
    expect(
      sim.state.bonds!.payments.filter(
        (payment) => payment.kind === 'bankruptcyRedemption' && payment.tick === bankruptTick,
      ).length,
    ).toBe(bankPaymentsAtTrigger);
    expect(bankruptCity.government!.records).toHaveLength(1);
  });
});
