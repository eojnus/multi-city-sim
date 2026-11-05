import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation/core/simulation';
import { checkInvariants } from '../src/simulation/core/invariants';
import { serializeSave } from '../src/simulation/core/save';
import { GOOD_IDS } from '../src/simulation/companies/company';
import { sumCityStock } from '../src/simulation/markets/markets';

describe('固定种子与长期稳定性', () => {
  it('相同种子与相同操作序列产生完全一致的世界状态', () => {
    const runOnce = () => {
      const sim = Simulation.create();
      for (let index = 0; index < 16; index++) {
        const result = sim.tick();
        expect(result.ok, result.error).toBe(true);
        if (index === 6) expect(sim.invest('lp-garment', 300_000).ok).toBe(true);
      }
      return sim;
    };
    const a = runOnce();
    const b = runOnce();
    expect(a.state.rngState).toBe(b.state.rngState);
    expect(a.state.time).toEqual(b.state.time);
    expect(JSON.stringify(a.state.companies)).toBe(JSON.stringify(b.state.companies));
    expect(JSON.stringify(a.state.policies)).toBe(JSON.stringify(b.state.policies));
    expect(JSON.stringify(a.state.transport.lastMonth)).toBe(JSON.stringify(b.state.transport.lastMonth));
    expect(JSON.stringify(a.state.securities)).toBe(JSON.stringify(b.state.securities));
    expect(serializeSave(a.state, 'fixed')).toBe(serializeSave(b.state, 'fixed'));
  });

  // v0.4：世界规模扩大（居民群体、经营者、银行、更多企业），120 期模拟耗时上升，
  // 显式放宽该长期用例的超时，避免把“跑得久”误判成失败。
  // v1.0 开局 65 家企业 + 设备链后，120 月模拟实测约 95s（本机 2 核/1GB，load 高时更慢）；
  // v1.3 月内两轮采购+生产使每月结算量约翻倍，实测 200s 左右（load 高时更慢），
  // 属规模增长与测试机争用，不是功能回退，故超时提高到 420s。
  it('推进 120 个月保持人口、就业、资金、商品、股份与预算约束', { timeout: 420_000 }, () => {
    const sim = Simulation.create();
    for (let index = 0; index < 120; index++) {
      const result = sim.tick();
      expect(result.ok, `第 ${index + 1} 月：${result.error}`).toBe(true);
      expect(result.invariants).toEqual([]);
      const world = sim.state;
      // 人口口径。
      for (const city of world.cities) {
        expect(city.population.total).toBe(
          city.population.employed + city.population.unemployed + city.population.nonLabor,
        );
        expect(city.population.unemployed).toBeGreaterThanOrEqual(0);
        expect(city.lastMonth.policySpending).toBeGreaterThanOrEqual(0);
      }
      // 企业现金与库存不为负；股份合计等于发行量。
      for (const company of world.companies) {
        expect(company.cash).toBeGreaterThanOrEqual(-0.01);
        expect(company.debt).toBeGreaterThanOrEqual(-0.01);
        for (const goodId of GOOD_IDS) {
          expect(company.inventory[goodId]).toBeGreaterThanOrEqual(-0.01);
        }
      }
      for (const company of world.companies) {
        const issued = world.securities.classes
          .filter((shareClass) => shareClass.companyId === company.id)
          .reduce((sum, shareClass) => sum + shareClass.issuedShares, 0);
        expect(issued).toBeCloseTo(company.totalShares, 2);
      }
      // 政策支出不超过预算。
      for (const policy of world.policies.active) {
        expect(policy.spent).toBeLessThanOrEqual(policy.budget + 0.01);
        expect(policy.monthsRemaining).toBeGreaterThanOrEqual(0);
      }
      // 城际结算账目：买方付款 = 卖方所得 + 收益损失。
      for (const trade of world.transport.lastMonth.trades) {
        expect(trade.grossValue).toBeCloseTo(trade.sellerProceeds + trade.capacityLoss, 2);
        expect(trade.sellerProceeds).toBeGreaterThanOrEqual(-0.01);
        expect(trade.penaltyRate).toBeGreaterThanOrEqual(0);
        expect(trade.penaltyRate).toBeLessThanOrEqual(1);
      }
      // 市场期末库存与城市企业库存一致。
      for (const city of world.cities) {
        for (const goodId of GOOD_IDS) {
          const market = city.market[goodId];
          expect(Math.abs(market.closingStock - sumCityStock(world, city.id, goodId))).toBeLessThanOrEqual(0.05);
        }
      }
      expect(checkInvariants(world)).toEqual([]);
    }
    // 长期世界仍保有企业与居民，不会因机制缺陷全部消失。
    expect(sim.state.companies.length).toBeGreaterThan(0);
    expect(sim.state.investors.length).toBeGreaterThan(0);
    expect(sim.state.history.length).toBeGreaterThan(60);
  });

  it('政策、交通与企业生命周期在长期世界中有实际事件（不是纯展示）', () => {
    // v0.9 验收修复后，三城在 40 月内均经历破产，破产清算会清空当月末的城际走廊，
    // 因此“第 40 月末 capacity>0”不再是稳定信号；改为在窗口内记录交通峰值，
    // 证明交通网络真实承载过运量并支付过维护费，而不是只存在于字段里。
    const sim = Simulation.create();
    let maxTransportCapacity = 0;
    let maxMaintenancePaid = 0;
    for (let index = 0; index < 40; index++) {
      const result = sim.tick();
      expect(result.ok, `第 ${index + 1} 月：${result.error}`).toBe(true);
      expect(result.invariants).toEqual([]);
      maxTransportCapacity = Math.max(maxTransportCapacity, sim.state.transport.lastMonth.capacity);
      maxMaintenancePaid = Math.max(maxMaintenancePaid, sim.state.transport.lastMonth.maintenancePaid);
    }
    const world = sim.state;
    expect(world.policies.history.length + world.policies.active.length).toBeGreaterThan(0);
    expect(world.fiscal.ledger.length).toBeGreaterThan(0);
    expect(maxTransportCapacity).toBeGreaterThan(0);
    expect(maxMaintenancePaid).toBeGreaterThan(0);
    expect(
      world.lifecycle.foundings.length + world.lifecycle.liquidations.length,
    ).toBeGreaterThan(0);
  });
});
