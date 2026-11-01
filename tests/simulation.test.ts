import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation/core/simulation';
import { checkInvariants } from '../src/simulation/core/invariants';
import { parseSave, serializeSave } from '../src/simulation/core/save';
import { playerNetWorth } from '../src/simulation/economy/gdp';
import { GOOD_IDS } from '../src/simulation/companies/company';

function run(sim: Simulation, months: number): void {
  for (let i = 0; i < months; i++) {
    const result = sim.tick();
    expect(result.ok, result.error).toBe(true);
    expect(result.invariants).toEqual([]);
  }
}

describe('模拟核心', () => {
  it('初始世界满足全部不变量', () => {
    const sim = Simulation.create();
    expect(checkInvariants(sim.state)).toEqual([]);
    expect(sim.state.cities).toHaveLength(3);
    expect(sim.state.companies.length).toBeGreaterThanOrEqual(10);
    expect(sim.state.time.tick).toBe(0);
  });

  it('连续推进 24 个月保持人口、就业、库存和成交约束', () => {
    const sim = Simulation.create();
    run(sim, 24);
    for (const city of sim.state.cities) {
      const p = city.population;
      expect(p.total).toBe(p.employed + p.unemployed + p.nonLabor);
      expect(p.laborForce).toBe(p.employed + p.unemployed);
      for (const goodId of GOOD_IDS) {
        expect(city.market[goodId].sold).toBeLessThanOrEqual(
          city.market[goodId].demand + 0.05,
        );
        expect(city.market[goodId].price).toBeGreaterThan(0);
      }
    }
    for (const company of sim.state.companies) {
      for (const goodId of GOOD_IDS) {
        expect(company.inventory[goodId]).toBeGreaterThanOrEqual(-0.01);
      }
      const roles = company.roles;
      expect(roles.management + roles.production + roles.sales + roles.research).toBe(
        company.employees,
      );
    }
    expect(checkInvariants(sim.state)).toEqual([]);
  });

  it('连续推进 36 个月仍保持不变量（长期稳定性）', () => {
    const sim = Simulation.create();
    run(sim, 36);
    expect(checkInvariants(sim.state)).toEqual([]);
    const totalPop = sim.state.cities.reduce((sum, city) => sum + city.population.total, 0);
    expect(totalPop).toBeGreaterThan(200_000);
    expect(sim.state.history.length).toBeGreaterThanOrEqual(36);
  });

  it('产生真实跨城市货物流动，且流向与商品有效', () => {
    const sim = Simulation.create();
    run(sim, 4);
    const flows = sim.state.lastTick.tradeFlows;
    expect(flows.length).toBeGreaterThan(0);
    for (const flow of flows) {
      expect(flow.fromCityId).not.toBe(flow.toCityId);
      expect(flow.qty).toBeGreaterThan(0);
      expect(flow.value).toBeGreaterThan(0);
    }
    expect(flows.some((flow) => flow.good === 'grain' || flow.good === 'fabric' || flow.good === 'fiber')).toBe(true);
  });

  it('相同种子与相同操作得到相同结果', () => {
    const a = Simulation.create();
    const b = Simulation.create();
    for (let i = 0; i < 3; i++) {
      a.tick();
      b.tick();
    }
    const investA = a.invest('lp-food', 500_000);
    const investB = b.invest('lp-food', 500_000);
    expect(investA).toEqual(investB);
    for (let i = 0; i < 9; i++) {
      a.tick();
      b.tick();
    }
    expect(JSON.stringify(a.state)).toBe(JSON.stringify(b.state));
  });

  it('玩家注资会真实改变企业现金、产能和玩家持股', () => {
    const sim = Simulation.create();
    const company = sim.state.companies.find((c) => c.id === 'lp-food')!;
    const cashBefore = company.cash;
    const capacityBefore = company.capacity;
    const playerBefore = sim.state.player.cash;
    const result = sim.invest('lp-food', 500_000);
    expect(result.ok).toBe(true);
    expect(result.shares).toBeGreaterThan(0);
    expect(sim.state.player.cash).toBe(playerBefore - 500_000);
    expect(company.cash).toBeGreaterThan(cashBefore);
    expect(company.capacity).toBeGreaterThan(capacityBefore);
    const holding = sim.state.player.holdings.find((h) => h.companyId === 'lp-food')!;
    expect(holding.shares).toBeGreaterThan(0);
    expect(playerNetWorth(sim.state)).toBeGreaterThan(0);
    expect(checkInvariants(sim.state)).toEqual([]);
    run(sim, 3);
  });

  it('非法注资不改变任何状态', () => {
    const sim = Simulation.create();
    const before = JSON.stringify(sim.state);
    expect(sim.invest('lp-food', -100).ok).toBe(false);
    expect(sim.invest('not-exist', 100_000).ok).toBe(false);
    expect(sim.invest('lp-food', 99_999_999).ok).toBe(false);
    expect(JSON.stringify(sim.state)).toBe(before);
  });

  it('存档往返保持世界状态，且拒绝损坏与过新版本', () => {
    const sim = Simulation.create();
    run(sim, 6);
    const text = serializeSave(sim.state, '2026-07-01T00:00:00.000Z');
    const parsed = parseSave(text);
    expect(parsed.ok, parsed.error).toBe(true);
    expect(parsed.world).toEqual(sim.state);

    const broken = parseSave('{ not json');
    expect(broken.ok).toBe(false);
    expect(broken.error).toContain('JSON');

    const tooNew = JSON.parse(text) as { formatVersion: number };
    tooNew.formatVersion = 99;
    const tooNewResult = parseSave(JSON.stringify(tooNew));
    expect(tooNewResult.ok).toBe(false);
    expect(tooNewResult.error).toContain('高于');

    const tampered = JSON.parse(text) as {
      world: { cities: { population: { total: number } }[] };
    };
    tampered.world.cities[0]!.population.total += 1;
    const tamperedResult = parseSave(JSON.stringify(tampered));
    expect(tamperedResult.ok).toBe(false);
    expect(tamperedResult.error).toContain('不变量');
  });

  it('GDP 等于企业增加值合计，不使用营业额或工资', () => {
    const sim = Simulation.create();
    run(sim, 4);
    for (const city of sim.state.cities) {
      const sum = sim.state.lastTick.productionRecords
        .filter((record) => record.cityId === city.id)
        .reduce((total, record) => total + record.valueAdded, 0);
      expect(city.gdp).toBeCloseTo(Math.max(0, sum), 2);
    }
  });
});
