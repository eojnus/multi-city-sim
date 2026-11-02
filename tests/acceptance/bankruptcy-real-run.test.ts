import { beforeAll, describe, expect, it } from 'vitest';
import { Simulation } from '../../src/simulation/core/simulation';
import type { WorldState } from '../../src/simulation/contracts/types';
import { checkInvariants } from '../../src/simulation/core/invariants';

/**
 * F 组「真实破产样本」：固定条件 36 个月、玩家无操作、默认种子 20261101。
 * 复现命令：npx vitest run tests/acceptance/bankruptcy-real-run.test.ts
 * 现行基线：交付分支 `316eff4`（qa merge `65c4c28`）。
 * 注意：sim 块3/4（居民消费贷/政府借款调整）后经济序列已变化——
 *   旧样本（1d138a6：岚港 t20、铁谷 t30，垫付 788,239,136.64、成交 768,932 份）不再成立；
 *   现样本：仅岚港 t27 破产，垫付 485,295,713.34、成交 739,973 份。
 * 数值已写入 ACCEPTANCE_MATRIX_v1 §1.6，旧 36 月基线 JSON 需数值岗重出后对齐。
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
  const records = () => world.cities.flatMap((entry) => entry.government!.records);

  it('F-R1 触发月份：仅岚港 t27 破产一次，铁谷/青原不破产', () => {
    expect(city('lanport').government!.records.map((record) => record.tick)).toEqual([27]);
    expect(city('ironvale').government!.records).toHaveLength(0);
    expect(city('greenfield').government!.records).toHaveLength(0);
  });

  it('F-R2 风险分级：t19 岚港 70.6%（watch）、t29 岚港回落到 5.2%、t36 铁谷 70.0%（watch）；判定月比率≥100%', () => {
    const lanportPre = monthEndRatio.get(19)?.get('lanport');
    expect(lanportPre?.ratio).toBeCloseTo(0.705696, 5);
    expect(lanportPre?.riskLevel).toBe('watch');
    const lanportAfter = monthEndRatio.get(29)?.get('lanport');
    expect(lanportAfter?.ratio).toBeCloseTo(0.05173, 5);
    expect(lanportAfter?.riskLevel).toBe('normal');
    const ironvaleLate = monthEndRatio.get(36)?.get('ironvale');
    expect(ironvaleLate?.ratio).toBeCloseTo(0.699743, 5);
    expect(ironvaleLate?.riskLevel).toBe('watch');

    const record = city('lanport').government!.records[0]!;
    expect(record.tick).toBe(27);
    expect(record.debtRatio).toBeCloseTo(1.025095, 6);
    expect(record.totalDebtAtJudgement).toBeCloseTo(561_851_754.85, 2);
    expect(record.gdpJudgementValue).toBeCloseTo(548_097_298.46, 2);
    const election = world.politics!.elections.find(
      (entry) => entry.cityId === 'lanport' && entry.tick === 27,
    );
    expect(election).toBeDefined();
    expect(election!.winnerName.length).toBeGreaterThan(0);
  });

  it('F-R3 破产兑付：12 期未到期债券本金 467,536,000 + 利息 17,759,713.34 = 银行垫付 485,295,713.34', () => {
    const only = records()[0]!;
    expect(only.bondsRedeemedPrincipal).toBeCloseTo(467_536_000, 2);
    expect(only.bondsRedeemedInterest).toBeCloseTo(17_759_713.34, 2);
    expect(only.bankAdvanceCreated).toBeCloseTo(485_295_713.34, 2);
    expect(only.bankAdvanceCreated).toBeCloseTo(
      only.bondsRedeemedPrincipal + only.bondsRedeemedInterest,
      2,
    );

    // 岚港 12 期因破产提前兑付；铁谷 12 期仍在存续（未到期）。
    const lanportIssuances = allIssuances().filter((issuance) => issuance.cityId === 'lanport');
    expect(lanportIssuances).toHaveLength(12);
    for (const issuance of lanportIssuances) {
      expect(issuance.redemptionReason).toBe('bankruptcy');
      expect(issuance.status).toBe('redeemed');
      expect(issuance.arrearsInterest).toBeCloseTo(0, 2);
      expect(issuance.soldUnits).toBe(issuance.planUnits);
    }
    const ironvaleIssuances = allIssuances().filter((issuance) => issuance.cityId === 'ironvale');
    expect(ironvaleIssuances).toHaveLength(12);
    for (const issuance of ironvaleIssuances) {
      expect(issuance.status).toBe('active');
    }
    expect(world.bonds!.holdings.filter((holding) => holding.status === 'active')).toHaveLength(54);
  });

  it('F-R4 债券认购：计划=成交 739,973 份、未售 0，85 笔持有全部为 investorGroup（61 跨城 / 24 同城）', () => {
    const totalPlan = allIssuances().reduce((sum, issuance) => sum + issuance.planUnits, 0);
    const totalSold = allIssuances().reduce((sum, issuance) => sum + issuance.soldUnits, 0);
    expect(totalPlan).toBe(739_973);
    expect(totalSold).toBe(739_973);
    for (const issuance of allIssuances()) expect(issuance.unsoldUnits).toBe(0);

    const holdings = world.bonds!.holdings;
    expect(holdings).toHaveLength(85);
    let crossCity = 0;
    let sameCity = 0;
    for (const holding of holdings) {
      expect(holding.holder.kind).toBe('investorGroup');
      const issuance = allIssuances().find((entry) => entry.id === holding.issuanceId);
      expect(issuance).toBeDefined();
      if (holding.holder.id.startsWith(issuance!.cityId)) sameCity += 1;
      else crossCity += 1;
    }
    expect(crossCity).toBe(61);
    expect(sameCity).toBe(24);
  });

  it('F-R5 债务勾销：12 笔 bondAdvance 与 6 笔原有政府贷款 writtenOff、未偿清零', () => {
    const bonds = allLoans().filter((loan) => loan.purpose === 'bondAdvance');
    expect(bonds).toHaveLength(12);
    let advancePrincipal = 0;
    for (const loan of bonds) {
      expect(loan.status).toBe('writtenOff');
      expect(loan.outstanding).toBeCloseTo(0, 2);
      expect(loan.paidPrincipal).toBeCloseTo(loan.principal, 2);
      advancePrincipal += loan.principal;
    }
    expect(advancePrincipal).toBeCloseTo(485_295_713.34, 2);

    const writtenOffGovernment = allLoans().filter(
      (loan) => loan.purpose === 'government' && loan.status === 'writtenOff',
    );
    expect(writtenOffGovernment).toHaveLength(6);
    let writtenOffPrincipal = 0;
    for (const loan of writtenOffGovernment) {
      expect(loan.outstanding).toBeCloseTo(0, 2);
      writtenOffPrincipal += loan.principal;
    }
    expect(writtenOffPrincipal).toBeCloseTo(75_735_776.76, 2);

    const only = records()[0]!;
    expect(only.advancesWrittenOff).toBeCloseTo(485_295_713.34, 2);
    expect(only.interestWrittenOff).toBeCloseTo(820_264.75, 2);
    expect(only.bondRedemptionCount).toBe(31);
  });

  it('F-R6 当月重选：破产同 tick 触发选举且看守期未残留', () => {
    const record = city('lanport').government!.records[0]!;
    expect(record.electionTriggeredTick).toBe(record.tick);
    expect(record.caretakerUntilElection).toBe(false);
    const election = world.politics!.elections.filter(
      (entry) => entry.cityId === 'lanport' && entry.tick === record.tick,
    );
    expect(election).toHaveLength(1);
  });

  it('F-R7 股份分配：破产政府持股清零，且总量不变量成立', () => {
    const holdings = world.securities.holdings.filter(
      (holding) => holding.holder.type === 'city' && holding.holder.id === 'lanport',
    );
    expect(holdings).toHaveLength(0);
    expect(checkInvariants(world)).toEqual([]);
  });

  it('F-R8 次月重建：破产后靠普通银行贷款重建债务，t36 负债率 32.2% / 70.0%', () => {
    const record = city('lanport').government!.records[0]!;
    const newLoans = city('lanport').government!.loans.filter(
      (loan) => loan.purpose === 'government' && loan.startTick > record.tick,
    );
    expect(newLoans.length).toBeGreaterThanOrEqual(1);
    expect(city('lanport').government!.lastDebt?.debtRatio ?? 0).toBeCloseTo(0.32235, 3);
    expect(city('ironvale').government!.lastDebt?.debtRatio ?? 0).toBeCloseTo(0.699743, 3);
    // 已知限制（秘书处确认，不判 bug）：破产后 AI 不再发新债券（债务分期到期使“禁借新还旧”恒真）。
    expect(
      allIssuances().filter(
        (issuance) => issuance.cityId === 'lanport' && issuance.issuedTick > record.tick,
      ),
    ).toHaveLength(0);
  });
});
