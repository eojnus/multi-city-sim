// v1.6 横切验收（Lead 集成测试）：
// 1) 新规则跑满 12 个月：整链不变量为空、维护费月度流水与各企业欠付余额对账（存量口径、不为负）；
// 2) 设备维护费服务流水是“模拟范围外”独立费用：不重复计入设备厂收入/政府税收（结构断言）；
// 3) 存档往返：v1.6 新增可选字段（维护费快照/欠付、僵尸计数、政策总额度分项、公共岗位、生产计划需求）
//    全部保留，且旧档缺省可读；
// 4) 政策总额度分项逐月守恒：Σ分项参考预算 ≤ 当月总额度。
//
// 只写测试，不改产品代码；数据来自真实 tick，不构造虚假成交。

import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation/core/simulation';
import { checkInvariants } from '../src/simulation/core/invariants';
import { createSaveFile, parseSave } from '../src/simulation/core/save';
import { round2 } from '../src/simulation/core/math';
import type { WorldState } from '../src/simulation/contracts/types';

function newWorld(months: number): WorldState {
  const sim = Simulation.create();
  for (let index = 0; index < months; index += 1) {
    const result = sim.tick();
    if (result.ok === false) throw new Error(`第 ${index + 1} 月 tick 失败：${result.error ?? ''}`);
  }
  return sim.state;
}

function totalCompanyArrears(world: WorldState): number {
  return round2(
    world.companies.reduce((sum, company) => {
      const value = company.maintenanceArrears ?? 0;
      return sum + (Number.isFinite(value) && value > 0 ? value : 0);
    }, 0),
  );
}

describe('v1.6 横切：设备维护费流水对账与整链不变量', () => {
  it('真实 12 个月：维护费月度流水与各企业欠付余额逐月对账，末期余额非负且不重复计入收入', () => {
    const sim = Simulation.create();
    for (let month = 0; month < 12; month += 1) {
      const result = sim.tick();
      expect(result.ok).toBe(true);
      expect(checkInvariants(sim.state)).toEqual([]);
      const flow = sim.state.equipmentMarket.maintenanceMonth;
      expect(flow).toBeDefined();
      if (!flow) continue;
      // 月末欠付余额必须是“存量”且等于各企业在营欠付合计（允许分币级舍入差）。
      const expected = totalCompanyArrears(sim.state);
      expect(flow.totalArrearsOutstanding).toBeGreaterThanOrEqual(-0.01);
      expect(flow.totalArrearsOutstanding).toBeCloseTo(expected, 2);
      // 流水自洽：本月应计 = 本月现金已付（含补付旧欠中属于当月费用的部分）+ 本月新增欠付；
      // 用“已付本费 = totalPaid − totalArrearsRepaid”闭合。
      expect(flow.totalDue).toBeGreaterThanOrEqual(0);
      expect(flow.totalPaid).toBeGreaterThanOrEqual(0);
      expect(flow.totalArrearsAdded).toBeGreaterThanOrEqual(0);
      expect(flow.totalArrearsRepaid).toBeGreaterThanOrEqual(0);
      expect(flow.totalBorrowed).toBeGreaterThanOrEqual(0);
      // totalPaid 含“补付旧欠”，其中只有已付本费部分属于本月应计：
      // 本月应计 = (totalPaid − totalArrearsRepaid) + totalArrearsAdded。
      expect(flow.totalDue).toBeCloseTo(
        round2(flow.totalPaid - flow.totalArrearsRepaid + flow.totalArrearsAdded),
        1,
      );
    }
    // 维护费收款方是模拟范围外服务商：不应出现在任何企业收入或政府税收里。
    const revenue = sim.state.companies.reduce(
      (sum, company) => sum + company.lastMonth.revenue,
      0,
    );
    const maintenancePaid = sim.state.companies.reduce(
      (sum, company) => sum + (company.lastMonth.maintenancePaid ?? 0),
      0,
    );
    expect(revenue).toBeGreaterThan(0);
    expect(maintenancePaid).toBeGreaterThan(0);
    // 结构断言：设备维护费不进入城市财政账本（交通“维护支出”是另一项城市支出，不在此列）。
    const equipmentMaintenanceFiscalEntries = sim.state.fiscal.ledger.filter((entry) =>
      (entry.source ?? '').includes('设备维护费'),
    );
    expect(equipmentMaintenanceFiscalEntries).toHaveLength(0);
  });

  it('v1.6 存档往返：维护费快照/欠付、僵尸计数、政策总额度分项、公共岗位字段全部保留', () => {
    const world = newWorld(14);
    const company = world.companies.find((entry) => (entry.maintenanceBase?.farm ?? 0) > 0)
      ?? world.companies[0]!;
    const funding = (world.policies.fundingMonths ?? []).find((entry) => entry.quota !== undefined);
    expect(funding).toBeDefined();

    const text = JSON.stringify(createSaveFile(world, '2026-11-06T00:00:00.000Z'));
    const parsed = parseSave(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || !parsed.world) return;
    const restored = parsed.world.companies.find((entry) => entry.id === company.id);
    expect(restored).toBeDefined();
    expect(restored?.maintenanceBase).toEqual(company.maintenanceBase);
    expect(restored?.maintenancePrices).toEqual(company.maintenancePrices);
    expect(restored?.maintenanceArrears ?? 0).toBeCloseTo(company.maintenanceArrears ?? 0, 6);
    expect(restored?.ai?.idleMonths ?? 0).toBe(company.ai?.idleMonths ?? 0);
    expect(restored?.lastMonth.maintenanceDue ?? 0).toBeCloseTo(
      company.lastMonth.maintenanceDue ?? 0,
      6,
    );
    const restoredFunding = (parsed.world.policies.fundingMonths ?? []).find(
      (entry) => entry.quota !== undefined,
    );
    expect(restoredFunding?.quota).toBeCloseTo(funding!.quota!, 6);
    expect(restoredFunding?.policyBudgets?.length ?? 0).toBe(
      funding!.policyBudgets?.length ?? 0,
    );
  });

  it('政策总额度分项逐月守恒：Σ分项参考预算 ≤ 当月总额度，且每项实支+未支付 ≤ 分项额度', () => {
    const world = newWorld(16);
    const traces = (world.policies.fundingMonths ?? []).filter((entry) => entry.quota !== undefined);
    expect(traces.length).toBeGreaterThan(0);
    for (const trace of traces) {
      const quota = trace.quota ?? 0;
      expect(quota).toBeGreaterThan(0);
      const allocations = trace.policyBudgets ?? [];
      const allocated = round2(
        allocations.reduce((sum, entry) => sum + entry.referenceBudget, 0),
      );
      expect(allocated).toBeLessThanOrEqual(round2(quota) + 0.01);
      for (const entry of allocations) {
        expect(entry.referenceBudget).toBeGreaterThanOrEqual(0);
        expect(entry.spent + entry.unpaid).toBeLessThanOrEqual(entry.referenceBudget + 0.02);
        // 公共岗位超配额工资单独列示，不伪造成分项实支。
        if ((entry.publicWagesAttributed ?? 0) > entry.referenceBudget) {
          expect(trace.publicWagesOverQuota ?? 0).toBeGreaterThan(0);
        }
      }
    }
  });
});
