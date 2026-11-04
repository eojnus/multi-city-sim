import { beforeAll, describe, expect, it } from 'vitest';
import { Simulation } from '../../src/simulation/core/simulation';
import type { BondHolding, WorldState } from '../../src/simulation/contracts/types';
import { checkInvariants } from '../../src/simulation/core/invariants';

/**
 * F 组「真实破产样本」：固定条件 36 个月、玩家无操作、默认种子 20261101。
 * 复现命令：npx vitest run tests/acceptance/bankruptcy-real-run.test.ts
 *
 * v1.2 最终代码（§1 股息按份额、§2 购债储备含逾期本金、§3 食品链、§4 创办上限 100 落地后）的实测序列：
 *   - 青原 t21、铁谷 t25、岚港 t27 各破产一次，共 3 次破产；
 *   - 每次破产均触发同 tick 重选，兑付后勾销债券垫付与政府贷款，次月起恢复融资；
 *   - t36 负债率：岚港 36.5%（normal）、铁谷 92.0%（high）、青原 58.4%（watch）；
 *   - 债券 52 期：计划 3,264,499 = 成交 2,963,268 + 未售 301,231；持债 488 笔
 *     （active 111 / redeemed 377，其中企业 206 笔、清算企业历史持债 16 笔）。
 * 结构/守恒断言全部保留（AC-F-R1~R8：兑付本金+利息==银行垫付、计划=成交+未售、
 * writtenOff 清零、不伪造/不抹账、次月重建、破产同 tick 重选、不变量为空）。
 */
describe('AC-F-R 真实 36 月破产序列（seed 20261101，玩家无操作，v1.2 最终税制）', () => {
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

  it('F-R1 触发月份：青原 t21、铁谷 t25、岚港 t27 各破产一次，共 3 次', () => {
    expect(city('lanport').government!.records.map((record) => record.tick)).toEqual([27]);
    expect(city('ironvale').government!.records.map((record) => record.tick)).toEqual([25]);
    expect(city('greenfield').government!.records.map((record) => record.tick)).toEqual([21]);
    // 结构断言：破产事实与重选一一对应，且三轮破产合计 3 次。
    expect(records()).toHaveLength(3);
    for (const record of records()) {
      expect(record.electionTriggeredTick).toBe(record.tick);
      expect(record.debtRatio).toBeGreaterThanOrEqual(1);
    }
    // 36 月后三城均已解除破产状态（恢复为 solvent，才能继续融资）。
    for (const entry of world.cities) {
      expect(entry.government!.bankruptcy.status).toBe('solvent');
    }
  });

  it('F-R2 风险分级：t19 岚港 normal/铁谷 watch/青原 high；t36 岚港 normal/铁谷 high/青原 watch；判定月比率均 ≥100%', () => {
    const lanportPre = monthEndRatio.get(19)?.get('lanport');
    expect(lanportPre?.ratio).toBeCloseTo(0.393105, 5);
    expect(lanportPre?.riskLevel).toBe('normal');
    const ironvalePre = monthEndRatio.get(19)?.get('ironvale');
    expect(ironvalePre?.ratio).toBeCloseTo(0.52691, 5);
    expect(ironvalePre?.riskLevel).toBe('watch');
    const greenfieldPre = monthEndRatio.get(19)?.get('greenfield');
    expect(greenfieldPre?.ratio).toBeCloseTo(0.875407, 5);
    expect(greenfieldPre?.riskLevel).toBe('high');

    // 青原 t21、铁谷 t25、岚港 t27 破产前后，其余月份按当时新债务计算。
    expect(monthEndRatio.get(27)?.get('lanport')?.ratio).toBeCloseTo(0, 5);
    expect(monthEndRatio.get(27)?.get('lanport')?.riskLevel).toBe('normal');
    expect(monthEndRatio.get(27)?.get('ironvale')?.ratio).toBeCloseTo(0.049629, 5);
    expect(monthEndRatio.get(27)?.get('ironvale')?.riskLevel).toBe('normal');
    expect(monthEndRatio.get(27)?.get('greenfield')?.ratio).toBeCloseTo(0.203396, 5);
    expect(monthEndRatio.get(27)?.get('greenfield')?.riskLevel).toBe('normal');
    expect(monthEndRatio.get(28)?.get('lanport')?.ratio).toBeCloseTo(0.00731, 5);
    expect(monthEndRatio.get(28)?.get('lanport')?.riskLevel).toBe('normal');
    expect(monthEndRatio.get(28)?.get('ironvale')?.ratio).toBeCloseTo(0.05964, 5);
    expect(monthEndRatio.get(28)?.get('ironvale')?.riskLevel).toBe('normal');
    expect(monthEndRatio.get(28)?.get('greenfield')?.ratio).toBeCloseTo(0.245595, 5);
    expect(monthEndRatio.get(28)?.get('greenfield')?.riskLevel).toBe('normal');

    expect(monthEndRatio.get(36)?.get('lanport')?.ratio).toBeCloseTo(0.365053, 5);
    expect(monthEndRatio.get(36)?.get('lanport')?.riskLevel).toBe('normal');
    expect(monthEndRatio.get(36)?.get('ironvale')?.ratio).toBeCloseTo(0.919828, 5);
    expect(monthEndRatio.get(36)?.get('ironvale')?.riskLevel).toBe('high');
    expect(monthEndRatio.get(36)?.get('greenfield')?.ratio).toBeCloseTo(0.583586, 5);
    expect(monthEndRatio.get(36)?.get('greenfield')?.riskLevel).toBe('watch');

    // 每次判定：record.debtRatio = totalDebtAtJudgement / gdpJudgementValue，且判定月≥100%。
    const expected: Record<string, Array<{ tick: number; ratio: number; debt: number; gdp: number }>> = {
      greenfield: [
        { tick: 21, ratio: 1.105843, debt: 707_374_368.75, gdp: 639_669_566.1 },
      ],
      ironvale: [
        { tick: 25, ratio: 1.00902, debt: 843_327_121.55, gdp: 835_788_405.93 },
      ],
      lanport: [
        { tick: 27, ratio: 1.130757, debt: 839_214_068.98, gdp: 742_170_289.7 },
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
        // bankAdvancedAmount 是该批次破产兑付时仍由银行垫付的金额；部分批次此前
        // 已归还部分垫付，因此单批可能低于原始本金。批次汇总必须等于 record 垫付额。
        expect(issuance.bankAdvancedAmount).toBeGreaterThanOrEqual(0);
        redeemedUnits += issuance.soldUnits;
        issuancePrincipal += issuance.principal;
        issuanceAdvanced += issuance.bankAdvancedAmount;
      }
      // 批次层面无重复/遗漏：银行垫付合计必须等于记录垫付额。
      // 注意：兑付本金是“破产时未偿本金”，部分批次在此前已结清部分本金，
      // 因此 soldUnits×1000 / issuance.principal（原始成交/发行本金）可能大于
      // 本次兑付的未偿本金；逐笔本金守恒已在上面的 payments（按破产 tick）断言。
      expect(redeemedUnits * 1000).toBeGreaterThanOrEqual(record.bondsRedeemedPrincipal - 0.02);
      expect(issuancePrincipal).toBeGreaterThanOrEqual(record.bondsRedeemedPrincipal - 0.02);
      expect(issuanceAdvanced).toBeCloseTo(record.bankAdvanceCreated, 2);
    }
    // 破产兑付后仍在存续期的持债为 active（共 111 笔）。
    expect(world.bonds!.holdings.filter((holding) => holding.status === 'active')).toHaveLength(111);
    expect(world.bonds!.holdings).toHaveLength(488);
  });

  it('F-R4 债券认购：计划=成交+未售（总量守恒），持有人为居民实体或企业（317 跨城 / 155 同城 / 16 历史）', () => {
    const totalPlan = allIssuances().reduce((sum, issuance) => sum + issuance.planUnits, 0);
    const totalSold = allIssuances().reduce((sum, issuance) => sum + issuance.soldUnits, 0);
    const totalUnsold = allIssuances().reduce((sum, issuance) => sum + issuance.unsoldUnits, 0);
    expect(totalPlan).toBe(3_264_499);
    expect(totalSold).toBe(2_963_268);
    expect(totalUnsold).toBe(301_231);
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
    expect(holdings).toHaveLength(488);
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
    expect(crossCity).toBe(317);
    expect(sameCity).toBe(155);
    expect(historicalHoldings).toBe(16);
    // 企业持债为 v0.9 新增合法路径（原 v0.8 仅居民投资实体）。
    expect(holdings.filter((holding) => holding.holder.kind === 'company')).toHaveLength(206);
    expect(holdings.filter((holding) => holding.holder.kind === 'investorGroup')).toHaveLength(282);
  });

  it('F-R5 债务勾销：每次破产的垫付/银行贷款 writtenOff、未偿清零，且与 record 金额一致', () => {
    const locked = [
      { cityId: 'greenfield', tick: 21, advances: 700_608_303.29, bankLoans: 6_766_065.46, interest: 0, count: 171 },
      { cityId: 'ironvale', tick: 25, advances: 825_626_593.32, bankLoans: 17_700_528.23, interest: 0, count: 101 },
      { cityId: 'lanport', tick: 27, advances: 786_078_053.33, bankLoans: 52_678_681.16, interest: 457_334.49, count: 103 },
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
    // 破产城市之外：破产后三座破产城市都已有新的存续政府贷款；
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

  it('F-R8 次月重建：三城破产后均恢复发债/贷款，t36 负债率 36.5%/92.0%/58.4%', () => {
    for (const cityId of ['greenfield', 'ironvale', 'lanport']) {
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
      // 破产后不仅最后一条记录之后恢复，记录之间也在持续融资（本序列每城仅一次破产，
      // 因此“第一次之后”等价于“最后一次之后”，保留结构断言以覆盖多轮破产场景）。
      const firstRecord = entry.government!.records[0]!;
      const between = allIssuances().filter(
        (issuance) => issuance.cityId === cityId && issuance.issuedTick > firstRecord.tick,
      );
      expect(between.length).toBeGreaterThanOrEqual(1);
      // 破产城市均已解除破产状态（恢复为 solvent，才能继续融资）。
      expect(entry.government!.bankruptcy.status).toBe('solvent');
    }

    expect(city('lanport').government!.lastDebt?.debtRatio ?? 0).toBeCloseTo(0.365053, 3);
    expect(city('lanport').government!.lastDebt?.riskLevel).toBe('normal');
    expect(city('ironvale').government!.lastDebt?.debtRatio ?? 0).toBeCloseTo(0.919828, 3);
    expect(city('ironvale').government!.lastDebt?.riskLevel).toBe('high');
    expect(city('greenfield').government!.lastDebt?.debtRatio ?? 0).toBeCloseTo(0.583586, 3);
    expect(city('greenfield').government!.lastDebt?.riskLevel).toBe('watch');
    for (const cityId of ['greenfield', 'ironvale', 'lanport']) {
      expect(city(cityId).government!.lastDebt?.totalDebt ?? 0).toBeGreaterThan(0);
      expect(city(cityId).government!.bankruptcy.status).toBe('solvent');
    }
  });
});
