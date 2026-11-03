import { beforeAll, describe, expect, it } from 'vitest';
import { Simulation } from '../../src/simulation/core/simulation';
import type { WorldState } from '../../src/simulation/contracts/types';
import { checkInvariants } from '../../src/simulation/core/invariants';

/**
 * F 组「真实破产样本」：固定条件 36 个月、玩家无操作、默认种子 20261101。
 * 复现命令：npx vitest run tests/acceptance/bankruptcy-real-run.test.ts
 *
 * v0.8 税制变更（消费税 5%、股息税 10%、城内交通税收系数 0.5–1.5 作用于四种税，
 * 正加成注入财政、负损耗单独记账）使财政现金流与 36 月真实序列再次漂移：
 *   - 岚港 t28 破产（旧基线 t29），铁谷、青原在 36 月内均未破产（铁谷旧基线 t31）；
 *   - 岚港破产后恢复发行债券（t29/31/33/35）与政府贷款，铁谷全程正常融资；
 *   - t36 负债率：岚港 64.2%（watch）、铁谷 51.2%（watch）、青原 0%。
 *   注：v0.8 修复“同 tick 订单号复用”后，撮合排序的确定性基准变化，序列再次小幅漂移，
 *   本文件按最终代码实测值锁定；结构/守恒断言全部保留。
 * 本文件按 v0.8 实测序列更新锁定值，但保留 AC-F-R1~R8 的守恒/结构断言
 * （兑付本金+利息==银行垫付、计划=成交+未售、writtenOff 清零、不伪造/不抹账、
 * 次月重建、破产同 tick 重选、不变量为空）。数值同时写入交付报告 §15 与 v0.8 回归说明。
 */
describe('AC-F-R 真实 36 月破产序列（seed 20261101，玩家无操作，v0.8 税制）', () => {
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

  it('F-R1 触发月份：岚港 t28 破产一次，铁谷、青原 36 月内不破产', () => {
    expect(city('lanport').government!.records.map((record) => record.tick)).toEqual([28]);
    expect(city('ironvale').government!.records).toHaveLength(0);
    expect(city('greenfield').government!.records).toHaveLength(0);
  });

  it('F-R2 风险分级：t19 岚港 33.9%（normal）、t28 破产清算后归零、t36 铁谷 51.2%（watch）；判定月比率≥100%', () => {
    const lanportPre = monthEndRatio.get(19)?.get('lanport');
    expect(lanportPre?.ratio).toBeCloseTo(0.338543, 5);
    expect(lanportPre?.riskLevel).toBe('normal');
    const lanportAfter = monthEndRatio.get(28)?.get('lanport');
    expect(lanportAfter?.ratio).toBeCloseTo(0, 5);
    expect(lanportAfter?.riskLevel).toBe('normal');
    const lanportLate = monthEndRatio.get(36)?.get('lanport');
    expect(lanportLate?.ratio).toBeCloseTo(0.64213, 5);
    expect(lanportLate?.riskLevel).toBe('watch');
    const ironvaleLate = monthEndRatio.get(36)?.get('ironvale');
    expect(ironvaleLate?.ratio).toBeCloseTo(0.511837, 5);
    expect(ironvaleLate?.riskLevel).toBe('watch');

    const lanportRecord = city('lanport').government!.records[0]!;
    expect(lanportRecord.debtRatio).toBeCloseTo(1.03294, 5);
    // 结构断言：破产判定月实际债务/判定 GDP 必须达到破产门槛（不是伪造的低比率）。
    expect(lanportRecord.debtRatio).toBeGreaterThanOrEqual(1);
    expect(lanportRecord.totalDebtAtJudgement).toBeCloseTo(361_873_906.81, 2);
    expect(lanportRecord.gdpJudgementValue).toBeCloseTo(350_333_917.55, 2);
    expect(lanportRecord.totalDebtAtJudgement / lanportRecord.gdpJudgementValue).toBeCloseTo(
      lanportRecord.debtRatio,
      5,
    );
    const lanportElection = world.politics!.elections.find(
      (entry) => entry.cityId === 'lanport' && entry.tick === 28,
    );
    expect(lanportElection).toBeDefined();
    expect(lanportElection!.winnerName.length).toBeGreaterThan(0);

    // 未破产城市不产生破产记录（结构断言）。
    expect(city('ironvale').government!.records).toHaveLength(0);
    expect(city('greenfield').government!.records).toHaveLength(0);
  });

  it('F-R3 破产兑付守恒：兑付本金+利息 == 银行垫付，且破产批次全部兑付', () => {
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
        // 已兑付批次不得再留有 active 持债（不重复兑付/不抹账）。
        const activeHoldings = world.bonds!.holdings.filter(
          (holding) => holding.issuanceId === issuance.id && holding.status === 'active',
        );
        expect(activeHoldings).toHaveLength(0);
      }
    }
    // 岚港破产兑付后，铁谷仍在存续期的持债为 active（共 22 笔）。
    expect(world.bonds!.holdings.filter((holding) => holding.status === 'active')).toHaveLength(22);
    expect(world.bonds!.holdings).toHaveLength(39);
  });

  it('F-R4 债券认购：计划=成交+未售（总量守恒），持有全部为 investorGroup（38 跨城 / 1 同城）', () => {
    const totalPlan = allIssuances().reduce((sum, issuance) => sum + issuance.planUnits, 0);
    const totalSold = allIssuances().reduce((sum, issuance) => sum + issuance.soldUnits, 0);
    const totalUnsold = allIssuances().reduce((sum, issuance) => sum + issuance.unsoldUnits, 0);
    expect(totalPlan).toBe(705_855);
    expect(totalSold).toBe(670_024);
    expect(totalUnsold).toBe(35_831);
    expect(totalSold + totalUnsold).toBe(totalPlan);
    for (const issuance of allIssuances()) {
      // 只有仍在发行窗口内的批次允许有未售份数；关闭后未售=计划-成交。
      if (issuance.status === 'offering') {
        expect(issuance.unsoldUnits).toBe(issuance.planUnits - issuance.soldUnits);
      } else {
        expect(issuance.unsoldUnits).toBe(issuance.planUnits - issuance.soldUnits);
      }
      // 持债份数合计必须等于成交份数（不重复记账、不凭空造债）。
      const holdingUnits = world.bonds!.holdings
        .filter((holding) => holding.issuanceId === issuance.id)
        .reduce((sum, holding) => sum + holding.units, 0);
      expect(holdingUnits).toBe(issuance.soldUnits);
    }

    const holdings = world.bonds!.holdings;
    expect(holdings).toHaveLength(39);
    let crossCity = 0;
    let sameCity = 0;
    for (const holding of holdings) {
      expect(holding.holder.kind).toBe('investorGroup');
      const issuance = allIssuances().find((entry) => entry.id === holding.issuanceId);
      expect(issuance).toBeDefined();
      if (holding.holder.id.startsWith(issuance!.cityId)) sameCity += 1;
      else crossCity += 1;
    }
    expect(crossCity).toBe(38);
    expect(sameCity).toBe(1);
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
      for (const loan of writtenOffGovernment) {
        expect(loan.outstanding).toBeCloseTo(0, 2);
        expect(loan.accruedInterest).toBeCloseTo(0, 2);
        expect(loan.arrearsInterest).toBeCloseTo(0, 2);
      }
      expect(record.bankLoansWrittenOff).toBeGreaterThan(0);
      expect(record.interestWrittenOff).toBeGreaterThanOrEqual(0);
    }
    const lanport = city('lanport').government!.records[0]!;
    expect(lanport.advancesWrittenOff).toBeCloseTo(312_942_003.35, 2);
    expect(lanport.bankLoansWrittenOff).toBeCloseTo(48_931_903.46, 2);
    expect(lanport.interestWrittenOff).toBeCloseTo(0, 2);
    expect(lanport.bondRedemptionCount).toBe(17);

    // 未破产城市不勾销债务：铁谷只有正常政府贷款，没有 writtenOff。
    const ironvaleLoans = city('ironvale').government!.loans;
    expect(ironvaleLoans.length).toBeGreaterThan(0);
    expect(ironvaleLoans.every((loan) => loan.status !== 'writtenOff')).toBe(true);
    expect(allLoans().filter((loan) => loan.status === 'writtenOff').every((loan) => loan.outstanding === 0)).toBe(true);
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

  it('F-R8 次月重建：岚港破产后恢复政府贷款与债券发行，t36 负债率 64.2% / 51.2% / 0%', () => {
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

    // 未破产城市持续正常融资（不是“未破产也停发”的机制性停摆）。
    const ironvaleIssuances = allIssuances().filter(
      (issuance) => issuance.cityId === 'ironvale',
    );
    expect(ironvaleIssuances.length).toBeGreaterThanOrEqual(1);
    const ironvaleNewLoans = city('ironvale').government!.loans.filter(
      (loan) => loan.purpose === 'government',
    );
    expect(ironvaleNewLoans.length).toBeGreaterThanOrEqual(1);

    expect(city('lanport').government!.lastDebt?.debtRatio ?? 0).toBeCloseTo(0.64213, 3);
    expect(city('lanport').government!.lastDebt?.riskLevel).toBe('watch');
    expect(city('ironvale').government!.lastDebt?.debtRatio ?? 0).toBeCloseTo(0.511837, 3);
    expect(city('ironvale').government!.lastDebt?.riskLevel).toBe('watch');
    expect(city('greenfield').government!.lastDebt?.debtRatio ?? 0).toBeCloseTo(0, 3);
    // 破产城市已解除破产状态（恢复为 solvent，才能继续融资）。
    expect(city('lanport').government!.bankruptcy.status).toBe('solvent');
  });
});
