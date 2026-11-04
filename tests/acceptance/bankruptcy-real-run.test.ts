import { beforeAll, describe, expect, it } from 'vitest';
import { Simulation } from '../../src/simulation/core/simulation';
import type { BondHolding, WorldState } from '../../src/simulation/contracts/types';
import { checkInvariants } from '../../src/simulation/core/invariants';

/**
 * F 组「真实破产样本」：固定条件 36 个月、玩家无操作、默认种子 20261101。
 * 复现命令：npx vitest run tests/acceptance/bankruptcy-real-run.test.ts
 *
 * v1.1 最终代码（§1/§6 缺货计划、§4 开局周转金、§5 购债储备、§3 创业规模落地后）的实测序列：
 *   - 铁谷 t23、岚港 t31 破产，青原未破产，共 2 次破产；
 *   - 每次破产均触发同 tick 重选，兑付后勾销债券垫付与政府贷款，次月起恢复融资；
 *   - t36 负债率：岚港 21.1%（normal）、铁谷 65.8%（watch）、青原 68.7%（watch）；
 *   - 债券 44 期：计划 2,805,106 = 成交 2,475,963 + 未售 329,143；持债 289 笔
 *     （active 140 / redeemed 149，其中企业 73 笔、清算企业历史持债 6 笔）。
 * 结构/守恒断言全部保留（AC-F-R1~R8：兑付本金+利息==银行垫付、计划=成交+未售、
 * writtenOff 清零、不伪造/不抹账、次月重建、破产同 tick 重选、不变量为空）。
 */
describe('AC-F-R 真实 36 月破产序列（seed 20261101，玩家无操作，v1.1 最终税制）', () => {
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

  it('F-R1 触发月份：铁谷 t23、岚港 t31 破产，青原未破产，共 2 次', () => {
    expect(city('lanport').government!.records.map((record) => record.tick)).toEqual([31]);
    expect(city('ironvale').government!.records.map((record) => record.tick)).toEqual([23]);
    expect(city('greenfield').government!.records).toHaveLength(0);
    // 结构断言：破产事实与重选一一对应，且两轮破产合计 2 次。
    expect(records()).toHaveLength(2);
    for (const record of records()) {
      expect(record.electionTriggeredTick).toBe(record.tick);
      expect(record.debtRatio).toBeGreaterThanOrEqual(1);
    }
    // 36 月后三城均已解除破产状态（恢复为 solvent，才能继续融资）。
    for (const entry of world.cities) {
      expect(entry.government!.bankruptcy.status).toBe('solvent');
    }
  });

  it('F-R2 风险分级：t19 岚港/铁谷 normal、青原 watch；t36 岚港 normal/铁谷 watch/青原 watch；判定月比率均 ≥100%', () => {
    const lanportPre = monthEndRatio.get(19)?.get('lanport');
    expect(lanportPre?.ratio).toBeCloseTo(0.186862, 5);
    expect(lanportPre?.riskLevel).toBe('normal');
    const ironvalePre = monthEndRatio.get(19)?.get('ironvale');
    expect(ironvalePre?.ratio).toBeCloseTo(0.421064, 5);
    expect(ironvalePre?.riskLevel).toBe('normal');
    const greenfieldPre = monthEndRatio.get(19)?.get('greenfield');
    expect(greenfieldPre?.ratio).toBeCloseTo(0.569846, 5);
    expect(greenfieldPre?.riskLevel).toBe('watch');

    // 铁谷 t23 破产、岚港 t31 破产前后，其余月份按当时新债务计算。
    expect(monthEndRatio.get(27)?.get('lanport')?.ratio).toBeCloseTo(0.597193, 5);
    expect(monthEndRatio.get(27)?.get('lanport')?.riskLevel).toBe('watch');
    expect(monthEndRatio.get(27)?.get('ironvale')?.ratio).toBeCloseTo(0.195171, 5);
    expect(monthEndRatio.get(27)?.get('ironvale')?.riskLevel).toBe('normal');
    expect(monthEndRatio.get(27)?.get('greenfield')?.ratio).toBeCloseTo(0.597054, 5);
    expect(monthEndRatio.get(27)?.get('greenfield')?.riskLevel).toBe('watch');
    expect(monthEndRatio.get(28)?.get('lanport')?.ratio).toBeCloseTo(0.660143, 5);
    expect(monthEndRatio.get(28)?.get('lanport')?.riskLevel).toBe('watch');
    expect(monthEndRatio.get(28)?.get('ironvale')?.ratio).toBeCloseTo(0.207888, 5);
    expect(monthEndRatio.get(28)?.get('ironvale')?.riskLevel).toBe('normal');
    expect(monthEndRatio.get(28)?.get('greenfield')?.ratio).toBeCloseTo(0.593722, 5);
    expect(monthEndRatio.get(28)?.get('greenfield')?.riskLevel).toBe('watch');

    expect(monthEndRatio.get(36)?.get('lanport')?.ratio).toBeCloseTo(0.211411, 5);
    expect(monthEndRatio.get(36)?.get('lanport')?.riskLevel).toBe('normal');
    expect(monthEndRatio.get(36)?.get('ironvale')?.ratio).toBeCloseTo(0.657758, 5);
    expect(monthEndRatio.get(36)?.get('ironvale')?.riskLevel).toBe('watch');
    expect(monthEndRatio.get(36)?.get('greenfield')?.ratio).toBeCloseTo(0.68746, 5);
    expect(monthEndRatio.get(36)?.get('greenfield')?.riskLevel).toBe('watch');

    // 每次判定：record.debtRatio = totalDebtAtJudgement / gdpJudgementValue，且判定月≥100%。
    const expected: Record<string, Array<{ tick: number; ratio: number; debt: number; gdp: number }>> = {
      lanport: [
        { tick: 31, ratio: 1.038381, debt: 844_300_722.42, gdp: 813_093_338.96 },
      ],
      ironvale: [
        { tick: 23, ratio: 1.033272, debt: 721_615_471.42, gdp: 698_379_057.53 },
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
    // 破产兑付后仍在存续期的持债为 active（共 140 笔）。
    expect(world.bonds!.holdings.filter((holding) => holding.status === 'active')).toHaveLength(140);
    expect(world.bonds!.holdings).toHaveLength(289);
  });

  it('F-R4 债券认购：计划=成交+未售（总量守恒），持有人为居民实体或企业（181 跨城 / 102 同城 / 6 历史）', () => {
    const totalPlan = allIssuances().reduce((sum, issuance) => sum + issuance.planUnits, 0);
    const totalSold = allIssuances().reduce((sum, issuance) => sum + issuance.soldUnits, 0);
    const totalUnsold = allIssuances().reduce((sum, issuance) => sum + issuance.unsoldUnits, 0);
    expect(totalPlan).toBe(2_805_106);
    expect(totalSold).toBe(2_475_963);
    expect(totalUnsold).toBe(329_143);
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
    expect(holdings).toHaveLength(289);
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
    expect(crossCity).toBe(181);
    expect(sameCity).toBe(102);
    expect(historicalHoldings).toBe(6);
    // 企业持债为 v0.9 新增合法路径（原 v0.8 仅居民投资实体）。
    expect(holdings.filter((holding) => holding.holder.kind === 'company')).toHaveLength(73);
    expect(holdings.filter((holding) => holding.holder.kind === 'investorGroup')).toHaveLength(216);
  });

  it('F-R5 债务勾销：每次破产的垫付/银行贷款 writtenOff、未偿清零，且与 record 金额一致', () => {
    const locked = [
      { cityId: 'ironvale', tick: 23, advances: 683_828_740.03, bankLoans: 37_407_869.59, interest: 378_861.8, count: 93 },
      { cityId: 'lanport', tick: 31, advances: 774_042_293.34, bankLoans: 69_440_211.41, interest: 818_217.67, count: 56 },
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
    // 破产城市之外：破产后两座破产城市都已有新的存续政府贷款；
    // 未破产的青原主要通过债券融资，不强制要求存在银行贷款。
    for (const entry of world.cities.filter((cityEntry) => cityEntry.government!.records.length > 0)) {
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

  it('F-R8 次月重建：铁谷 t23、岚港 t31 破产后均恢复发债/贷款，t36 负债率 21.1%/65.8%/68.7%', () => {
    for (const cityId of ['ironvale', 'lanport']) {
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
    // 青原未破产，保持 solvent，并持续通过债券融资（无银行贷款）。
    expect(city('greenfield').government!.bankruptcy.status).toBe('solvent');
    expect(
      allIssuances().filter(
        (issuance) => issuance.cityId === 'greenfield' && issuance.status === 'active',
      ).length,
    ).toBeGreaterThanOrEqual(1);
    expect(city('greenfield').government!.lastDebt?.totalDebt ?? 0).toBeGreaterThan(0);

    expect(city('lanport').government!.lastDebt?.debtRatio ?? 0).toBeCloseTo(0.211411, 3);
    expect(city('lanport').government!.lastDebt?.riskLevel).toBe('normal');
    expect(city('ironvale').government!.lastDebt?.debtRatio ?? 0).toBeCloseTo(0.657758, 3);
    expect(city('ironvale').government!.lastDebt?.riskLevel).toBe('watch');
    expect(city('greenfield').government!.lastDebt?.debtRatio ?? 0).toBeCloseTo(0.68746, 3);
    expect(city('greenfield').government!.lastDebt?.riskLevel).toBe('watch');
    // 破产城市已解除破产状态（恢复为 solvent，才能继续融资）。
    expect(city('lanport').government!.bankruptcy.status).toBe('solvent');
    expect(city('ironvale').government!.bankruptcy.status).toBe('solvent');
    expect(city('greenfield').government!.bankruptcy.status).toBe('solvent');
  });
});
