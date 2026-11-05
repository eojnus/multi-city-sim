// 验收 H08/H09：新档在到期月/破产月读档后，结算结果与不读档一致；重复读档不重复结算。
// 只读 src/** 公开 API（save.parseSave/serializeSave、Simulation），不改产品代码。
import { describe, expect, it } from 'vitest';
import { DEMO_CONFIG, type DemoConfig } from '../../src/data/config';
import { parseSave, serializeSave } from '../../src/simulation/core/save';
import { Simulation } from '../../src/simulation/core/simulation';
import type { BondHolder, WorldState } from '../../src/simulation/contracts/types';
import {
  issueGovernmentBond,
  subscribeGovernmentBond,
  closeGovernmentBondSubscription,
} from '../../src/simulation/government/bonds';
import { borrowForGovernment, settleCityGovernmentDebt } from '../../src/simulation/government/debt';
import { ensureInvestorOpeningShares } from '../../src/simulation/investors/investors';
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

/**
 * v1.3 起 36 月真实序列不再出现政府破产（负债率全程 <100%），因此 H09 改为
 * “构造一个确定性破产场景”：压低 GDP 窗口 + 清空财政 + 借入 2,000 政府贷款，
 * 使 debt/GDP ≥ 100%，再验证破产月读档/重复结算的幂等性。
 * 该构造与 tests/acceptance/bankruptcy.test.ts 的 bankruptScenario 同口径。
 */
const NO_AI = {
  ...DEMO_CONFIG,
  government: {
    ...DEMO_CONFIG.government,
    aiGovernment: { ...DEMO_CONFIG.government.aiGovernment, enabled: false },
  },
} as unknown as DemoConfig;

function bankruptcyScenario(): { world: WorldState; city: WorldState['cities'][number] } {
  const world = newWorld();
  const city = cityById(world, 'lanport');
  // 把判定窗口压到 12×100，使 2,000 政府贷款即可触发 100% 破产。
  city.gdpWindow = Array.from({ length: 12 }, (_, index) => ({
    tick: -12 + index,
    value: 100,
    estimated: true,
  }));
  city.treasury = 0;
  const borrowed = borrowForGovernment(world, city, NO_AI, 2_000, 0, []);
  expect(borrowed.ok, borrowed.error).toBe(true);
  // 保存前先补齐居民投资份额账本，保证读档路径不会额外规范化（存档往返逐字段一致）。
  ensureInvestorOpeningShares(world);
  world.time.tick = 1;
  return { world, city };
}

describe('H09 破产月读档：不重复结算/重复选举（构造破产场景）', () => {
  it('破产前存档 → 读档推进，两路径一致且破产记录/选举各一次', () => {
    const { world, city } = bankruptcyScenario();
    const saveText = text(world);

    const settled = settleCityGovernmentDebt(world, city, NO_AI, []);
    expect(settled.bankrupted).toBe(true);
    const record = city.government!.records[0]!;
    expect(record.tick).toBe(1);
    expect(city.government!.records).toHaveLength(1);
    expect(
      world.politics!.elections.filter(
        (entry) => entry.cityId === city.id && entry.tick === record.tick,
      ),
    ).toHaveLength(1);

    // 读档后在同一 tick 结算：逐字段一致（记录/选举/兑付/账目全部不重复）。
    const loaded = load(saveText);
    const loadedCity = cityById(loaded.state, 'lanport');
    const resumed = settleCityGovernmentDebt(loaded.state, loadedCity, NO_AI, []);
    expect(resumed.bankrupted).toBe(true);
    expect(text(loaded.state)).toBe(text(world));
    expect(loadedCity.government!.records).toHaveLength(1);
    expect(loadedCity.government!.records[0]!.id).toBe(record.id);
    expect(
      loaded.state.politics!.elections.filter(
        (entry) => entry.cityId === city.id && entry.tick === record.tick,
      ),
    ).toHaveLength(1);
    // 不重复兑付：破产兑付流水条数 = 记录条数（本场景无未偿债券 → 0 条）。
    expect(
      loaded.state.bonds!.payments.filter(
        (payment) => payment.kind === 'bankruptcyRedemption' && payment.tick === record.tick,
      ),
    ).toHaveLength(record.bondRedemptionCount);
  });

  it('破产后存档 → 读档推进，不重复兑付/不重复建垫付贷款', () => {
    const { world, city } = bankruptcyScenario();
    settleCityGovernmentDebt(world, city, NO_AI, []);
    const record = city.government!.records[0]!;
    expect(record.tick).toBe(1);
    const saveText = text(world);

    const reloaded = load(saveText);
    const reloadedCity = cityById(reloaded.state, 'lanport');
    // 破产状态随存档持久化。
    expect(reloadedCity.government!.bankruptcy.status).toBe('bankrupt');
    expect(reloadedCity.government!.bankruptcy.recordId).toBe(record.id);
    const paymentsBefore = reloaded.state.bonds!.payments.length;
    const textBefore = text(reloaded.state);

    // 同一 tick 重复结算：settledTicks 已持久化 → 直接跳过，不重复兑付/建垫付贷款。
    const repeated = settleCityGovernmentDebt(reloaded.state, reloadedCity, NO_AI, []);
    expect(repeated.bankrupted).toBe(false);
    expect(repeated.payablesCreated).toBe(0);
    expect(reloadedCity.government!.records).toHaveLength(1);
    expect(reloaded.state.bonds!.payments).toHaveLength(paymentsBefore);
    expect(text(reloaded.state)).toBe(textBefore);
  });
});
