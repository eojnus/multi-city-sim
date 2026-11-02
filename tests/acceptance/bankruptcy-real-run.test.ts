import { beforeAll, describe, expect, it } from 'vitest';
import { Simulation } from '../../src/simulation/core/simulation';
import type { WorldState } from '../../src/simulation/contracts/types';
import { checkInvariants } from '../../src/simulation/core/invariants';

/**
 * F 组「真实破产样本」：固定条件 36 个月、玩家无操作、默认种子 20261101。
 * 复现命令：npx vitest run tests/acceptance/bankruptcy-real-run.test.ts
 * 基线：1d138a6（交付分支）；期望值来自同条件 36 月运行（岚港 t20 / 铁谷 t30 破产）。
 * 与秘书处口径对照：负债率 t19 97.0% / t29 91.0%；垫付合计 788,239,137；24 期债券 100% 成交。
 */
describe('AC-F-R 真实 36 月破产序列（seed 20261101，玩家无操作）', () => {
  let world: WorldState;
  /** 每月月末的负债率快照（tick → cityId → lastDebt）。 */
  const monthEndRatio = new Map<number, Map<string, { ratio: number; riskLevel: string }>>();

  beforeAll(() => {
    const sim = Simulation.create();
    for (let index = 0; index < 36; index += 1) {
      const result = sim.tick();
      if (result.ok === false) throw new Error(`第 ${index} 月 tick 失败`);
      const snapshot = new Map<string, { ratio: number; riskLevel: string }>();
      for (const entry of sim.state.cities) {
        const debt = entry.government!.lastDebt;
        if (debt) snapshot.set(entry.id, { ratio: debt.debtRatio, riskLevel: debt.riskLevel });
      }
      monthEndRatio.set(sim.state.time.tick, snapshot);
    }
    world = sim.state;
  }, 180_000);

  const city = (id: string) => {
    const found = world.cities.find((entry) => entry.id === id);
    if (!found) throw new Error(`缺少城市 ${id}`);
    return found;
  };
  const allIssuances = () => world.bonds!.issuances;
  const allLoans = () => world.cities.flatMap((entry) => entry.government?.loans ?? []);

  it('F-R1 触发月份：岚港 t20、铁谷 t30 各破产一次，青原不破产', () => {
    expect(city('lanport').government!.records.map((record) => record.tick)).toEqual([20]);
    expect(city('ironvale').government!.records.map((record) => record.tick)).toEqual([30]);
    expect(city('greenfield').government!.records).toHaveLength(0);
  });

  it('F-R2 破产前风险分级：t19 岚港 96.9%（high）、t29 铁谷 91.3%（high），判定月比率≥100%', () => {
    // t19 / t29 月末快照（判定前最后一月）。
    const lanportPre = monthEndRatio.get(19)?.get('lanport');
    expect(lanportPre?.ratio).toBeCloseTo(0.969067, 5);
    expect(lanportPre?.riskLevel).toBe('high');
    const ironvalePre = monthEndRatio.get(29)?.get('ironvale');
    expect(ironvalePre?.ratio).toBeCloseTo(0.913379, 5);
    expect(ironvalePre?.riskLevel).toBe('high');

    // 判定月记录：与数值岗探针 docs/development/reports/economy-probe-block2.json 逐值一致。
    const lanportRecord = city('lanport').government!.records[0]!;
    expect(lanportRecord.tick).toBe(20);
    expect(lanportRecord.debtRatio).toBeCloseTo(1.036159, 6);
    expect(lanportRecord.totalDebtAtJudgement).toBeCloseTo(515_423_777.57, 2);
    expect(lanportRecord.gdpJudgementValue).toBeCloseTo(497_436_959.73, 2);
    expect(
      world.politics!.elections.find((entry) => entry.cityId === 'lanport' && entry.tick === 20)
        ?.winnerName,
    ).toBe('罗知远');
    const ironvaleRecord = city('ironvale').government!.records[0]!;
    expect(ironvaleRecord.tick).toBe(30);
    expect(ironvaleRecord.debtRatio).toBeCloseTo(1.035096, 6);
    expect(ironvaleRecord.totalDebtAtJudgement).toBeCloseTo(317_097_115.03, 2);
    expect(ironvaleRecord.gdpJudgementValue).toBeCloseTo(306_345_548.4, 2);
    expect(
      world.politics!.elections.find((entry) => entry.cityId === 'ironvale' && entry.tick === 30)
        ?.winnerName,
    ).toBe('许星野');
  });

  it('F-R3 破产兑付：24 期债券本金 768,932,000 + 利息 19,307,136.64 = 银行垫付 788,239,136.64', () => {
    const records = world.cities.flatMap((entry) => entry.government!.records);
    const principal = records.reduce((sum, record) => sum + record.bondsRedeemedPrincipal, 0);
    const interest = records.reduce((sum, record) => sum + record.bondsRedeemedInterest, 0);
    const advance = records.reduce((sum, record) => sum + record.bankAdvanceCreated, 0);
    expect(principal).toBeCloseTo(768_932_000, 2);
    expect(interest).toBeCloseTo(19_307_136.64, 2);
    expect(advance).toBeCloseTo(788_239_136.64, 2);
    expect(advance).toBeCloseTo(principal + interest, 2);

    // 24 期全部因破产提前兑付，兑付后账本清零。
    expect(allIssuances()).toHaveLength(24);
    for (const issuance of allIssuances()) {
      expect(issuance.redemptionReason).toBe('bankruptcy');
      expect(issuance.status).toBe('redeemed');
      expect(issuance.arrearsInterest).toBeCloseTo(0, 2);
      expect(issuance.soldUnits).toBe(issuance.planUnits);
    }
    expect(world.bonds!.holdings.filter((holding) => holding.status === 'active')).toHaveLength(0);
  });

  it('F-R4 债券认购：计划=成交 768,932 份、未售 0，85 笔持有全部为 investorGroup（71 跨城 / 14 同城）', () => {
    const totalPlan = allIssuances().reduce((sum, issuance) => sum + issuance.planUnits, 0);
    const totalSold = allIssuances().reduce((sum, issuance) => sum + issuance.soldUnits, 0);
    expect(totalPlan).toBe(768_932);
    expect(totalSold).toBe(768_932);

    const holdings = world.bonds!.holdings;
    expect(holdings).toHaveLength(85);
    let crossCity = 0;
    let sameCity = 0;
    for (const holding of holdings) {
      // 无企业、无玩家认购（企业购债受现金/工资/欠薪约束，本样本未触发）。
      expect(holding.holder.kind).toBe('investorGroup');
      const issuance = allIssuances().find((entry) => entry.id === holding.issuanceId);
      expect(issuance).toBeDefined();
      // 认购主体 id 带所属城市前缀（如 greenfield-invest1）。
      if (holding.holder.id.startsWith(issuance!.cityId)) sameCity += 1;
      else crossCity += 1;
    }
    expect(crossCity).toBe(71);
    expect(sameCity).toBe(14);
  });

  it('F-R5 债务勾销：24 笔 bondAdvance 与 4 笔原有政府贷款全部 writtenOff、未偿清零', () => {
    const bonds = allLoans().filter((loan) => loan.purpose === 'bondAdvance');
    const government = allLoans().filter((loan) => loan.purpose !== 'bondAdvance');
    expect(bonds).toHaveLength(24);
    for (const loan of bonds) {
      expect(loan.status).toBe('writtenOff');
      expect(loan.outstanding).toBeCloseTo(0, 2);
      expect(loan.paidPrincipal).toBeCloseTo(loan.principal, 2);
    }
    const writtenOffGovernment = government.filter((loan) => loan.status === 'writtenOff');
    expect(writtenOffGovernment.length).toBe(4);
    let writtenOffPrincipal = 0;
    for (const loan of writtenOffGovernment) {
      expect(loan.outstanding).toBeCloseTo(0, 2);
      expect(loan.paidPrincipal).toBeCloseTo(loan.principal, 2);
      writtenOffPrincipal += loan.principal;
    }
    // 探针 economy-probe-block2.json：岚港勾销普通贷款 11,160,100.90 + 铁谷 32,960,388.38。
    expect(writtenOffPrincipal).toBeCloseTo(11_160_100.9 + 32_960_388.38, 2);
    // 记录口径的核销利息：岚港 0 + 铁谷 161,266.68（只记录、不产生支付）。
    const records = world.cities.flatMap((entry) => entry.government!.records);
    expect(records.reduce((sum, record) => sum + record.interestWrittenOff, 0)).toBeCloseTo(
      161_266.68,
      2,
    );
    expect(records.reduce((sum, record) => sum + record.advancesWrittenOff, 0)).toBeCloseTo(
      788_239_136.64,
      2,
    );
    expect(records.reduce((sum, record) => sum + record.bondRedemptionCount, 0)).toBe(85);
  });

  it('F-R6 当月重选：两城均在破产同 tick 触发选举且看守期未残留', () => {
    for (const cityId of ['lanport', 'ironvale']) {
      const record = city(cityId).government!.records[0]!;
      expect(record.electionTriggeredTick).toBe(record.tick);
      expect(record.caretakerUntilElection).toBe(false);
      const election = world.politics!.elections.find(
        (entry) => entry.cityId === cityId && entry.tick === record.tick,
      );
      expect(election, `${cityId} 应存在破产同 tick 选举记录`).toBeDefined();
    }
  });

  it('F-R7 股份分配：破产政府持股清零，且类别发行总量不变', () => {
    for (const cityId of ['lanport', 'ironvale']) {
      const holdings = world.securities.holdings.filter(
        (holding) => holding.holder.type === 'city' && holding.holder.id === cityId,
      );
      expect(holdings).toHaveLength(0);
    }
    // 不变量覆盖：Σ持股 = issuedShares（不销毁、不增发）。
    expect(checkInvariants(world)).toEqual([]);
  });

  it('F-R8 次月重建：破产后靠普通银行贷款重建债务，t36 负债率 73.1% / 20.5%', () => {
    for (const [cityId, recordTick, minNewLoans] of [
      ['lanport', 20, 1],
      ['ironvale', 30, 1],
    ] as const) {
      const newLoans = city(cityId)
        .government!.loans.filter((loan) => loan.purpose === 'government' && loan.startTick > recordTick);
      expect(newLoans.length).toBeGreaterThanOrEqual(minNewLoans);
      const ratio = city(cityId).government!.lastDebt?.debtRatio ?? 0;
      const expected = cityId === 'lanport' ? 0.7309 : 0.2047;
      expect(ratio).toBeCloseTo(expected, 3);
    }
    // 已知限制（秘书处确认，不判 bug）：破产后 AI 不再发新债券（债务分期到期使“禁借新还旧”恒真）。
    for (const issuance of allIssuances()) {
      const bankrupt = city(issuance.cityId).government!.records[0];
      if (bankrupt) expect(issuance.issuedTick).toBeLessThanOrEqual(bankrupt.tick);
    }
  });
});
