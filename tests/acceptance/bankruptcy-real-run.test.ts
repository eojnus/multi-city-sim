import { beforeAll, describe, expect, it } from 'vitest';
import { Simulation } from '../../src/simulation/core/simulation';
import type { BondHolding, WorldState } from '../../src/simulation/contracts/types';
import { checkInvariants } from '../../src/simulation/core/invariants';

/**
 * F 组「真实破产样本」：固定条件 36 个月、玩家无操作、默认种子 20261101。
 * 复现命令：npx vitest run tests/acceptance/bankruptcy-real-run.test.ts
 *
 * v1.0 最终代码（消费贷授信快照修复冻结后）的实测序列：
 *   - 岚港未破产；铁谷 t17 / t31，青原 t16 / t31，共 4 次破产；
 *   - 每次破产均触发同 tick 重选，兑付后勾销债券垫付与政府贷款，次月起恢复融资；
 *   - t36 负债率：岚港 52.0%（watch）、铁谷 36.8%（normal）、青原 26.5%（normal）；
 *   - 债券 48 期：计划 2,466,911 = 成交 1,941,947 + 未售 524,964；持债 263 笔
 *     （active 62 / redeemed 201，其中企业 68 笔、清算企业历史持债 16 笔）。
 * 结构/守恒断言全部保留（AC-F-R1~R8：兑付本金+利息==银行垫付、计划=成交+未售、
 * writtenOff 清零、不伪造/不抹账、次月重建、破产同 tick 重选、不变量为空）。
 */
describe('AC-F-R 真实 36 月破产序列（seed 20261101，玩家无操作，v1.0 最终税制）', () => {
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
  const records = () =>
    world.cities
      .flatMap((entry) => entry.government!.records)
      .sort((a, b) => a.tick - b.tick);
  const recordOf = (cityId: string, tick: number) => {
    const found = records().find((record) => record.cityId === cityId && record.tick === tick);
    if (!found) throw new Error(`缺少 ${cityId} t${tick} 破产记录`);
    return found;
  };
  /** 解析持债人所在城市（用于同城/跨城分类；玩家不参与该分类）。 */
  const holderCityId = (holding: BondHolding): string | null => {
    if (holding.holder.kind === 'player') return null;
    if (holding.holder.kind === 'investorGroup') {
      return world.investors.find((group) => group.id === holding.holder.id)?.cityId ?? null;
    }
    return world.companies.find((company) => company.id === holding.holder.id)?.cityId ?? null;
  };

  it('F-R1 触发月份：岚港未破产，铁谷 t17/t31、青原 t16/t31 共 4 次', () => {
    expect(city('lanport').government!.records.map((record) => record.tick)).toEqual([]);
    expect(city('ironvale').government!.records.map((record) => record.tick)).toEqual([17, 31]);
    expect(city('greenfield').government!.records.map((record) => record.tick)).toEqual([16, 31]);
    // 结构断言：破产事实与重选一一对应，且两轮破产合计 4 次。
    expect(records()).toHaveLength(4);
    for (const record of records()) {
      expect(record.electionTriggeredTick).toBe(record.tick);
      expect(record.debtRatio).toBeGreaterThanOrEqual(1);
    }
    // 36 月后三城均已解除破产状态（恢复为 solvent，才能继续融资）。
    for (const entry of world.cities) {
      expect(entry.government!.bankruptcy.status).toBe('solvent');
    }
  });

  it('F-R2 风险分级：t19 岚港 watch、其余 normal；t36 岚港 watch/铁谷 normal/青原 normal；判定月比率均 ≥100%', () => {
    const lanportPre = monthEndRatio.get(19)?.get('lanport');
    expect(lanportPre?.ratio).toBeCloseTo(0.566786, 5);
    expect(lanportPre?.riskLevel).toBe('watch');
    const ironvalePre = monthEndRatio.get(19)?.get('ironvale');
    expect(ironvalePre?.ratio).toBeCloseTo(0.064882, 5);
    expect(ironvalePre?.riskLevel).toBe('normal');
    const greenfieldPre = monthEndRatio.get(19)?.get('greenfield');
    expect(greenfieldPre?.ratio).toBeCloseTo(0.078608, 5);
    expect(greenfieldPre?.riskLevel).toBe('normal');

    // 铁谷 t17 破产、青原 t16 破产后均已恢复；t27/t28 负债率按恢复后的新债务计算。
    expect(monthEndRatio.get(27)?.get('lanport')?.ratio).toBeCloseTo(0.664343, 5);
    expect(monthEndRatio.get(27)?.get('lanport')?.riskLevel).toBe('watch');
    expect(monthEndRatio.get(27)?.get('ironvale')?.ratio).toBeCloseTo(0.793457, 5);
    expect(monthEndRatio.get(27)?.get('ironvale')?.riskLevel).toBe('high');
    expect(monthEndRatio.get(27)?.get('greenfield')?.ratio).toBeCloseTo(0.741461, 5);
    expect(monthEndRatio.get(27)?.get('greenfield')?.riskLevel).toBe('watch');
    expect(monthEndRatio.get(28)?.get('lanport')?.ratio).toBeCloseTo(0.613474, 5);
    expect(monthEndRatio.get(28)?.get('lanport')?.riskLevel).toBe('watch');
    expect(monthEndRatio.get(28)?.get('ironvale')?.ratio).toBeCloseTo(0.794299, 5);
    expect(monthEndRatio.get(28)?.get('ironvale')?.riskLevel).toBe('high');
    expect(monthEndRatio.get(28)?.get('greenfield')?.ratio).toBeCloseTo(0.831283, 5);
    expect(monthEndRatio.get(28)?.get('greenfield')?.riskLevel).toBe('high');

    expect(monthEndRatio.get(36)?.get('lanport')?.ratio).toBeCloseTo(0.520036, 5);
    expect(monthEndRatio.get(36)?.get('lanport')?.riskLevel).toBe('watch');
    expect(monthEndRatio.get(36)?.get('ironvale')?.ratio).toBeCloseTo(0.367912, 5);
    expect(monthEndRatio.get(36)?.get('ironvale')?.riskLevel).toBe('normal');
    expect(monthEndRatio.get(36)?.get('greenfield')?.ratio).toBeCloseTo(0.264736, 5);
    expect(monthEndRatio.get(36)?.get('greenfield')?.riskLevel).toBe('normal');

    // 每次判定：record.debtRatio = totalDebtAtJudgement / gdpJudgementValue，且判定月≥100%。
    const expected: Record<string, Array<{ tick: number; ratio: number; debt: number; gdp: number }>> = {
      ironvale: [
        { tick: 17, ratio: 1.23298, debt: 526_444_632.66, gdp: 426_969_314.92 },
        { tick: 31, ratio: 1.08048, debt: 290_526_625.58, gdp: 268_886_539.79 },
      ],
      greenfield: [
        { tick: 16, ratio: 1.547121, debt: 519_488_069.91, gdp: 335_777_218.52 },
        { tick: 31, ratio: 1.107504, debt: 254_030_569.88, gdp: 229_372_245.29 },
      ],
    };
    for (const [cityId, list] of Object.entries(expected)) {
      for (const item of list) {
        const record = recordOf(cityId, item.tick);
        expect(record.debtRatio).toBeCloseTo(item.ratio, 5);
        expect(record.totalDebtAtJudgement).toBeCloseTo(item.debt, 2);
        expect(record.gdpJudgementValue).toBeCloseTo(item.gdp, 2);
        expect(record.totalDebtAtJudgement / record.gdpJudgementValue).toBeCloseTo(
          record.debtRatio,
          5,
        );
        const election = world.politics!.elections.find(
          (entry) => entry.cityId === cityId && entry.tick === item.tick,
        );
        expect(election).toBeDefined();
        expect(election!.winnerName.length).toBeGreaterThan(0);
      }
    }
  });

  it('F-R3 破产兑付守恒：兑付本金+利息 == 银行垫付，且每笔兑付流水与批次/记录一致', () => {
    for (const record of records()) {
      expect(record.bankAdvanceCreated).toBeCloseTo(
        record.bondsRedeemedPrincipal + record.bondsRedeemedInterest,
        2,
      );
      expect(record.bondsRedeemedPrincipal).toBeGreaterThan(0);
      expect(record.bondRedemptionCount).toBeGreaterThan(0);

      // 逐笔流水：本金 + 利息分别等于记录汇总，笔数等于 bondRedemptionCount（不重复兑付）。
      const payments = world.bonds!.payments.filter(
        (payment) =>
          payment.cityId === record.cityId &&
          payment.tick === record.tick &&
          payment.kind === 'bankruptcyRedemption',
      );
      expect(payments).toHaveLength(record.bondRedemptionCount);
      expect(payments.reduce((sum, payment) => sum + payment.principalPaid, 0)).toBeCloseTo(
        record.bondsRedeemedPrincipal,
        2,
      );
      expect(payments.reduce((sum, payment) => sum + payment.interestPaid, 0)).toBeCloseTo(
        record.bondsRedeemedInterest,
        2,
      );

      // 该次破产关闭的批次：全部已兑付、无欠息、持债份数=成交份数、无 active 残留。
      const redeemedIssuances = allIssuances().filter(
        (issuance) =>
          issuance.cityId === record.cityId &&
          issuance.redeemedTick === record.tick &&
          issuance.redemptionReason === 'bankruptcy',
      );
      expect(redeemedIssuances.length).toBeGreaterThan(0);
      let redeemedUnits = 0;
      let issuancePrincipal = 0;
      let issuanceAdvanced = 0;
      for (const issuance of redeemedIssuances) {
        expect(issuance.status).toBe('redeemed');
        expect(issuance.arrearsInterest).toBeCloseTo(0, 2);
        expect(issuance.unsoldUnits).toBe(issuance.planUnits - issuance.soldUnits);
        const holdings = world.bonds!.holdings.filter(
          (holding) => holding.issuanceId === issuance.id,
        );
        expect(holdings.reduce((sum, holding) => sum + holding.units, 0)).toBe(issuance.soldUnits);
        expect(holdings.filter((holding) => holding.status === 'active')).toHaveLength(0);
        // bankAdvancedAmount 是含兑付利息的银行垫付（>= 本金），其汇总才等于 record 垫付额。
        expect(issuance.bankAdvancedAmount).toBeGreaterThanOrEqual(issuance.principal - 0.02);
        redeemedUnits += issuance.soldUnits;
        issuancePrincipal += issuance.principal;
        issuanceAdvanced += issuance.bankAdvancedAmount;
      }
      // 兑付份数 × 面额 == 兑付本金（面额 1000），且批次层面无重复/遗漏。
      expect(redeemedUnits * 1000).toBeCloseTo(record.bondsRedeemedPrincipal, 2);
      expect(issuancePrincipal).toBeCloseTo(record.bondsRedeemedPrincipal, 2);
      expect(issuanceAdvanced).toBeCloseTo(record.bankAdvanceCreated, 2);
    }
    // 破产兑付后仍在存续期的持债为 active（共 62 笔）。
    expect(world.bonds!.holdings.filter((holding) => holding.status === 'active')).toHaveLength(62);
    expect(world.bonds!.holdings).toHaveLength(263);
  });

  it('F-R4 债券认购：计划=成交+未售（总量守恒），持有人为居民实体或企业（166 跨城 / 81 同城 / 16 历史）', () => {
    const totalPlan = allIssuances().reduce((sum, issuance) => sum + issuance.planUnits, 0);
    const totalSold = allIssuances().reduce((sum, issuance) => sum + issuance.soldUnits, 0);
    const totalUnsold = allIssuances().reduce((sum, issuance) => sum + issuance.unsoldUnits, 0);
    expect(totalPlan).toBe(2_466_911);
    expect(totalSold).toBe(1_941_947);
    expect(totalUnsold).toBe(524_964);
    expect(totalSold + totalUnsold).toBe(totalPlan);
    for (const issuance of allIssuances()) {
      // 关闭后未售=计划-成交（未售不形成债务，也不重复计入持债）。
      expect(issuance.unsoldUnits).toBe(issuance.planUnits - issuance.soldUnits);
      // 持债份数合计必须等于成交份数（不重复记账、不凭空造债）。
      const holdingUnits = world.bonds!.holdings
        .filter((holding) => holding.issuanceId === issuance.id)
        .reduce((sum, holding) => sum + holding.units, 0);
      expect(holdingUnits).toBe(issuance.soldUnits);
    }

    const holdings = world.bonds!.holdings;
    expect(holdings).toHaveLength(263);
    // v0.9 认购顺序为玩家→居民投资实体→企业；持有主体只能是这三类（银行不得认购）。
    expect(holdings.every((holding) => holding.holder.kind !== 'player')).toBe(true);
    expect(
      holdings.every(
        (holding) => holding.holder.kind === 'investorGroup' || holding.holder.kind === 'company',
      ),
    ).toBe(true);
    let crossCity = 0;
    let sameCity = 0;
    let historicalHoldings = 0;
    for (const holding of holdings) {
      const issuance = allIssuances().find((entry) => entry.id === holding.issuanceId);
      expect(issuance).toBeDefined();
      const holderCity = holderCityId(holding);
      if (holderCity === null) {
        // 已清算企业留下的历史持债：均已兑付（不构成对存续实体的债权），
        // 不作为同城/跨城认购统计，但必须没有 active 的“孤儿债权”。
        historicalHoldings += 1;
        expect(holding.status).toBe('redeemed');
        continue;
      }
      if (holderCity === issuance!.cityId) sameCity += 1;
      else crossCity += 1;
    }
    expect(crossCity).toBe(166);
    expect(sameCity).toBe(81);
    expect(historicalHoldings).toBe(16);
    // 企业持债为 v0.9 新增合法路径（原 v0.8 仅居民投资实体）。
    expect(holdings.filter((holding) => holding.holder.kind === 'company')).toHaveLength(68);
    expect(holdings.filter((holding) => holding.holder.kind === 'investorGroup')).toHaveLength(195);
  });

  it('F-R5 债务勾销：每次破产的垫付/银行贷款 writtenOff、未偿清零，且与 record 金额一致', () => {
    const locked = [
      { cityId: 'greenfield', tick: 16, advances: 491_655_139.97, bankLoans: 27_712_122.65, interest: 120_807.29, count: 77 },
      { cityId: 'ironvale', tick: 17, advances: 450_745_346.67, bankLoans: 75_699_285.99, interest: 0, count: 39 },
      { cityId: 'greenfield', tick: 31, advances: 217_050_826.67, bankLoans: 36_979_743.21, interest: 0, count: 42 },
      { cityId: 'ironvale', tick: 31, advances: 232_564_850, bankLoans: 57_514_285.76, interest: 447_489.82, count: 43 },
    ];
    for (const item of locked) {
      const record = recordOf(item.cityId, item.tick);
      expect(record.advancesWrittenOff).toBeCloseTo(item.advances, 2);
      expect(record.bankLoansWrittenOff).toBeCloseTo(item.bankLoans, 2);
      expect(record.interestWrittenOff).toBeCloseTo(item.interest, 2);
      expect(record.bondRedemptionCount).toBe(item.count);

      // 该次破产垫付形成的 bondAdvance 贷款：本 tick 新放、全部勾销、未偿清零、本金全额勾销。
      const advances = city(item.cityId).government!.loans.filter(
        (loan) => loan.purpose === 'bondAdvance' && loan.startTick === item.tick,
      );
      expect(advances.length).toBeGreaterThan(0);
      let advancePrincipal = 0;
      for (const loan of advances) {
        expect(loan.status).toBe('writtenOff');
        expect(loan.outstanding).toBeCloseTo(0, 2);
        expect(loan.paidPrincipal).toBeCloseTo(loan.principal, 2);
        advancePrincipal += loan.principal;
      }
      expect(advancePrincipal).toBeCloseTo(record.advancesWrittenOff, 2);
      // record.advancesWrittenOff 记的是勾销时未偿；bondAdvance 全部为破产兑付垫付，未偿==本金。
      expect(record.advancesWrittenOff).toBeCloseTo(record.bankAdvanceCreated, 2);
      expect(record.bankLoansWrittenOff).toBeGreaterThan(0);
      expect(record.interestWrittenOff).toBeGreaterThanOrEqual(0);
    }

    // 城市层面守恒：Σ record.advancesWrittenOff == Σ 已勾销 bondAdvance 本金。
    for (const entry of world.cities) {
      const cityRecords = entry.government!.records;
      const advancesSum = cityRecords.reduce((sum, record) => sum + record.advancesWrittenOff, 0);
      const loanSum = entry.government!.loans
        .filter((loan) => loan.purpose === 'bondAdvance' && loan.status === 'writtenOff')
        .reduce((sum, loan) => sum + loan.principal, 0);
      expect(loanSum).toBeCloseTo(advancesSum, 2);
    }

    // 所有 writtenOff 贷款均未偿清零、计提与欠息清零（不抹账、不留尾）。
    const writtenOffLoans = world.cities.flatMap((entry) =>
      entry.government!.loans.filter((loan) => loan.status === 'writtenOff'),
    );
    expect(writtenOffLoans.length).toBeGreaterThan(0);
    for (const loan of writtenOffLoans) {
      expect(loan.outstanding).toBeCloseTo(0, 2);
      expect(loan.accruedInterest).toBeCloseTo(0, 2);
      expect(loan.arrearsInterest).toBeCloseTo(0, 2);
    }
    // 破产城市以外的贷款不受影响：破产后三城都已有新的存续政府贷款。
    for (const entry of world.cities) {
      expect(
        entry.government!.loans.filter((loan) => loan.purpose === 'government' && loan.status !== 'writtenOff').length,
      ).toBeGreaterThanOrEqual(1);
    }
  });

  it('F-R6 当月重选：每次破产同 tick 触发选举且看守期未残留', () => {
    for (const record of records()) {
      expect(record.electionTriggeredTick).toBe(record.tick);
      expect(record.caretakerUntilElection).toBe(false);
      const election = world.politics!.elections.filter(
        (entry) => entry.cityId === record.cityId && entry.tick === record.tick,
      );
      expect(election).toHaveLength(1);
    }
  });

  it('F-R7 股份分配：破产时旧政府持股清零，破产后新创办持股为 primary 且总量不变量成立', () => {
    // 破产后政府可重新创办企业并持有 primary 股份（v1.0 起的合法路径）；
    // 因此这里验证的是“旧股权不残留 + 新持股来源真实”，而不是简单地要求最终持股市值为 0。
    for (const entry of world.cities) {
      const records = entry.government!.records;
      if (records.length === 0) continue;
      const firstBankruptcyTick = records[0]!.tick;
      const lastBankruptcyTick = records[records.length - 1]!.tick;
      const cityHoldings = world.securities.holdings.filter(
        (holding) => holding.holder.type === 'city' && holding.holder.id === entry.id,
      );
      for (const holding of cityHoldings) {
        const founding = world.lifecycle!.foundings.find(
          (record) => record.companyId === holding.companyId,
        );
        expect(founding).toBeDefined();
        expect(holding.acquiredVia).toBe('primary');
        // 只能持有最后一次破产之后新创办企业的股份；破产前旧股权不得残留。
        expect(founding!.tick).toBeGreaterThanOrEqual(lastBankruptcyTick);
        expect(holding.sinceTick).toBeGreaterThanOrEqual(founding!.tick);
      }
      expect(
        cityHoldings.filter((holding) => holding.sinceTick < firstBankruptcyTick),
      ).toHaveLength(0);
    }
    expect(checkInvariants(world)).toEqual([]);
  });

  it('F-R8 次月重建：铁谷/青原破产后均恢复发债/贷款，t36 负债率 52.0%/36.8%/26.5%', () => {
    for (const cityId of ['ironvale', 'greenfield']) {
      const entry = city(cityId);
      const lastRecord = entry.government!.records[entry.government!.records.length - 1]!;
      // 破产/重选后可以恢复发债与政府贷款（旧基线“破产后不再发债”的限制已消除）。
      const newIssuances = allIssuances().filter(
        (issuance) => issuance.cityId === cityId && issuance.issuedTick > lastRecord.tick,
      );
      expect(newIssuances.length).toBeGreaterThanOrEqual(1);
      expect(newIssuances.some((issuance) => issuance.status === 'active')).toBe(true);
      const newLoans = entry.government!.loans.filter(
        (loan) => loan.purpose === 'government' && loan.startTick > lastRecord.tick,
      );
      expect(newLoans.length).toBeGreaterThanOrEqual(1);
      // 两次破产之间也能恢复（不是只有最后一次后恢复）。
      const firstRecord = entry.government!.records[0]!;
      const between = allIssuances().filter(
        (issuance) => issuance.cityId === cityId && issuance.issuedTick > firstRecord.tick,
      );
      expect(between.length).toBeGreaterThanOrEqual(1);
    }
    // 岚港未破产，但同样保持 solvent 且持续有存续的政府贷款。
    expect(city('lanport').government!.bankruptcy.status).toBe('solvent');
    expect(
      city('lanport').government!.loans.filter(
        (loan) => loan.purpose === 'government' && loan.status !== 'writtenOff',
      ).length,
    ).toBeGreaterThanOrEqual(1);

    expect(city('lanport').government!.lastDebt?.debtRatio ?? 0).toBeCloseTo(0.520036, 3);
    expect(city('lanport').government!.lastDebt?.riskLevel).toBe('watch');
    expect(city('ironvale').government!.lastDebt?.debtRatio ?? 0).toBeCloseTo(0.367912, 3);
    expect(city('ironvale').government!.lastDebt?.riskLevel).toBe('normal');
    expect(city('greenfield').government!.lastDebt?.debtRatio ?? 0).toBeCloseTo(0.264736, 3);
    expect(city('greenfield').government!.lastDebt?.riskLevel).toBe('normal');
    // 破产城市已解除破产状态（恢复为 solvent，才能继续融资）。
    expect(city('lanport').government!.bankruptcy.status).toBe('solvent');
    expect(city('ironvale').government!.bankruptcy.status).toBe('solvent');
    expect(city('greenfield').government!.bankruptcy.status).toBe('solvent');
  });
});
