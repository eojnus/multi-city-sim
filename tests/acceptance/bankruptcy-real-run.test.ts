import { beforeAll, describe, expect, it } from 'vitest';
import { Simulation } from '../../src/simulation/core/simulation';
import type { WorldState } from '../../src/simulation/contracts/types';
import { checkInvariants } from '../../src/simulation/core/invariants';

/**
 * F 组「真实破产样本」：固定条件 36 个月、玩家无操作、默认种子 20261101。
 * 复现命令：npx vitest run tests/acceptance/bankruptcy-real-run.test.ts
 *
 * v0.7.2 复验修复后的序列再次漂移（问题 A：居民贷款合并只合并还款条件完全相同的碎片，
 * 不再把不同月份的新贷款拖进旧贷末期提前结清；问题 B：玩家市长城市禁止 AI 代发债）：
 *   - 岚港 t29 破产、铁谷 t31 破产，青原不破产；
 *   - 两城均在破产后恢复发行债券（岚港 t31/33/35、铁谷 t33/35）。
 * 本文件按新序列更新数值；并改为按 record 自身字段做守恒断言，
 * 避免下次序列漂移时整块失效。数值同时写入了交付报告 §15 与本轮说明。
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
  const records = () =>
    world.cities
      .flatMap((entry) => entry.government!.records)
      .sort((a, b) => a.tick - b.tick);

  it('F-R1 触发月份：岚港 t28、铁谷 t31 各破产一次，青原不破产', () => {
    expect(city('lanport').government!.records.map((record) => record.tick)).toEqual([29]);
    expect(city('ironvale').government!.records.map((record) => record.tick)).toEqual([31]);
    expect(city('greenfield').government!.records).toHaveLength(0);
  });

  it('F-R2 风险分级：t19 岚港 49.7%（normal）、t29 岚港破产清算后归零、t36 铁谷 33.8%（normal）；判定月比率≥100%', () => {
    const lanportPre = monthEndRatio.get(19)?.get('lanport');
    expect(lanportPre?.ratio).toBeCloseTo(0.497438, 5);
    expect(lanportPre?.riskLevel).toBe('normal');
    const lanportAfter = monthEndRatio.get(29)?.get('lanport');
    expect(lanportAfter?.ratio).toBeCloseTo(0, 5);
    expect(lanportAfter?.riskLevel).toBe('normal');
    const ironvaleLate = monthEndRatio.get(36)?.get('ironvale');
    expect(ironvaleLate?.ratio).toBeCloseTo(0.337664, 5);
    expect(ironvaleLate?.riskLevel).toBe('normal');

    const lanportRecord = city('lanport').government!.records[0]!;
    expect(lanportRecord.debtRatio).toBeCloseTo(1.067731, 5);
    expect(lanportRecord.totalDebtAtJudgement).toBeCloseTo(469_325_220.36, 2);
    expect(lanportRecord.gdpJudgementValue).toBeCloseTo(439_553_636.05, 2);
    const lanportElection = world.politics!.elections.find(
      (entry) => entry.cityId === 'lanport' && entry.tick === 29,
    );
    expect(lanportElection).toBeDefined();
    expect(lanportElection!.winnerName.length).toBeGreaterThan(0);

    const ironvaleRecord = city('ironvale').government!.records[0]!;
    expect(ironvaleRecord.debtRatio).toBeCloseTo(1.0454, 5);
    expect(ironvaleRecord.totalDebtAtJudgement).toBeCloseTo(377_723_265.88, 2);
    expect(ironvaleRecord.gdpJudgementValue).toBeCloseTo(361_319_477.89, 2);
  });

  it('F-R3 破产兑付守恒：每城 兑付本金+利息 == 银行垫付，且 ballots 全部兑付', () => {
    for (const record of records()) {
      expect(record.bankAdvanceCreated).toBeCloseTo(
        record.bondsRedeemedPrincipal + record.bondsRedeemedInterest,
        2,
      );
      expect(record.bondsRedeemedPrincipal).toBeGreaterThan(0);
      expect(record.bondRedemptionCount).toBeGreaterThan(0);
      const cityIssuances = allIssuances().filter(
        (issuance) => issuance.cityId === record.cityId,
      );
      expect(cityIssuances.length).toBeGreaterThan(0);
      for (const issuance of cityIssuances) {
        if (issuance.status !== 'redeemed') continue;
        expect(issuance.redemptionReason).toBe('bankruptcy');
        expect(issuance.arrearsInterest).toBeCloseTo(0, 2);
        expect(issuance.soldUnits).toBeCloseTo(issuance.planUnits, 2);
      }
    }
    expect(world.bonds!.holdings.filter((holding) => holding.status === 'active')).toHaveLength(5);
  });

  it('F-R4 债券认购：计划=成交+未售（总量守恒），持有全部为 investorGroup（62 跨城 / 3 同城）', () => {
    const totalPlan = allIssuances().reduce((sum, issuance) => sum + issuance.planUnits, 0);
    const totalSold = allIssuances().reduce((sum, issuance) => sum + issuance.soldUnits, 0);
    const totalUnsold = allIssuances().reduce((sum, issuance) => sum + issuance.unsoldUnits, 0);
    expect(totalPlan).toBe(845_822);
    expect(totalSold).toBe(786_516);
    expect(totalUnsold).toBe(59_306);
    expect(totalSold + totalUnsold).toBe(totalPlan);
    for (const issuance of allIssuances()) {
      if (issuance.status !== 'offering') expect(issuance.unsoldUnits).toBe(0);
    }

    const holdings = world.bonds!.holdings;
    expect(holdings).toHaveLength(65);
    let crossCity = 0;
    let sameCity = 0;
    for (const holding of holdings) {
      expect(holding.holder.kind).toBe('investorGroup');
      const issuance = allIssuances().find((entry) => entry.id === holding.issuanceId);
      expect(issuance).toBeDefined();
      if (holding.holder.id.startsWith(issuance!.cityId)) sameCity += 1;
      else crossCity += 1;
    }
    expect(crossCity).toBe(62);
    expect(sameCity).toBe(3);
  });

  it('F-R5 债务勾销：每笔 bondAdvance/政府贷款 writtenOff、未偿清零，且与该城 record 金额一致', () => {
    for (const record of records()) {
      const cityLoans = city(record.cityId).government!.loans;
      const bonds = cityLoans.filter((loan) => loan.purpose === 'bondAdvance');
      expect(bonds.length).toBeGreaterThan(0);
      let advancePrincipal = 0;
      for (const loan of bonds) {
        expect(loan.status).toBe('writtenOff');
        expect(loan.outstanding).toBeCloseTo(0, 2);
        expect(loan.paidPrincipal).toBeCloseTo(loan.principal, 2);
        advancePrincipal += loan.principal;
      }
      // record.advancesWrittenOff 记的是勾销时未偿；bondAdvance 全部为破产兑付垫付，未偿==本金。
      expect(advancePrincipal).toBeCloseTo(record.advancesWrittenOff, 2);
      expect(record.advancesWrittenOff).toBeCloseTo(record.bankAdvanceCreated, 2);

      const writtenOffGovernment = cityLoans.filter(
        (loan) => loan.purpose === 'government' && loan.status === 'writtenOff',
      );
      expect(writtenOffGovernment.length).toBeGreaterThan(0);
      for (const loan of writtenOffGovernment) expect(loan.outstanding).toBeCloseTo(0, 2);
      expect(record.bankLoansWrittenOff).toBeGreaterThan(0);
      expect(record.interestWrittenOff).toBeGreaterThanOrEqual(0);
    }
    const lanport = city('lanport').government!.records[0]!;
    expect(lanport.advancesWrittenOff).toBeCloseTo(364_070_383.34, 2);
    expect(lanport.interestWrittenOff).toBeCloseTo(0, 2);
    expect(lanport.bondRedemptionCount).toBe(31);
    const ironvale = city('ironvale').government!.records[0]!;
    expect(ironvale.advancesWrittenOff).toBeCloseTo(315_132_270.94, 2);
    expect(ironvale.bondRedemptionCount).toBe(29);
  });

  it('F-R6 当月重选：破产同 tick 触发选举且看守期未残留', () => {
    for (const record of records()) {
      expect(record.electionTriggeredTick).toBe(record.tick);
      expect(record.caretakerUntilElection).toBe(false);
      const election = world.politics!.elections.filter(
        (entry) => entry.cityId === record.cityId && entry.tick === record.tick,
      );
      expect(election).toHaveLength(1);
    }
  });

  it('F-R7 股份分配：破产政府持股清零，且总量不变量成立', () => {
    for (const record of records()) {
      const holdings = world.securities.holdings.filter(
        (holding) => holding.holder.type === 'city' && holding.holder.id === record.cityId,
      );
      expect(holdings).toHaveLength(0);
    }
    expect(checkInvariants(world)).toEqual([]);
  });

  it('F-R8 次月重建：破产后两城均恢复政府贷款与债券发行，t36 负债率 40.2% / 33.8%', () => {
    const lanportRecord = city('lanport').government!.records[0]!;
    const lanportNewLoans = city('lanport').government!.loans.filter(
      (loan) => loan.purpose === 'government' && loan.startTick > lanportRecord.tick,
    );
    expect(lanportNewLoans.length).toBeGreaterThanOrEqual(1);
    // 问题 7 修复后：破产/重选后可以恢复发债（旧基线“破产后不再发债”的已知限制已消除）。
    const lanportNewIssuances = allIssuances().filter(
      (issuance) => issuance.cityId === 'lanport' && issuance.issuedTick > lanportRecord.tick,
    );
    expect(lanportNewIssuances.length).toBeGreaterThanOrEqual(1);
    expect(lanportNewIssuances.some((issuance) => issuance.status === 'active')).toBe(true);

    const ironvaleRecord = city('ironvale').government!.records[0]!;
    const ironvaleNewLoans = city('ironvale').government!.loans.filter(
      (loan) => loan.purpose === 'government' && loan.startTick > ironvaleRecord.tick,
    );
    expect(ironvaleNewLoans.length).toBeGreaterThanOrEqual(1);

    expect(city('lanport').government!.lastDebt?.debtRatio ?? 0).toBeCloseTo(0.401742, 3);
    expect(city('ironvale').government!.lastDebt?.debtRatio ?? 0).toBeCloseTo(0.337664, 3);
    expect(city('greenfield').government!.lastDebt?.debtRatio ?? 0).toBeCloseTo(0, 3);
  });
});
