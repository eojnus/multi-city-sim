import { beforeAll, describe, expect, it } from 'vitest';
import { Simulation } from '../../src/simulation/core/simulation';
import type { BondHolding, WorldState } from '../../src/simulation/contracts/types';
import { checkInvariants } from '../../src/simulation/core/invariants';
import { round2 } from '../../src/simulation/core/math';

/**
 * F 组「真实破产样本」：固定条件 36 个月、玩家无操作、默认种子 20261101。
 * 复现命令：npx vitest run tests/acceptance/bankruptcy-real-run.test.ts --maxWorkers=1 --testTimeout=300000
 *
 * v1.5 最终代码（§1 非市长财政投影、§2 债券无流动性迁移拆分、§4 AI 政策“先立项后融资”
 * 与真实借款/转移支付落地居民群体、§5 初始设备入口、§3 报告口径落地后）的实测序列：
 *   - 36 月内三城均未触发政府破产（records 为空），负债率随债券+政策借款上升但全程 < 100%：
 *     t36 负债率 岚港 28.6%（normal）、铁谷 41.4%（normal）、青原 40.9%（normal）；
 *   - 36 期债券全部成交（计划=成交=3,014,448，未售 0），每城 12 期，全部 active；
 *   - 持债 985 笔（active 965 / 已清算企业历史持债 20；企业 730 / 居民实体 255 / 玩家 0），
 *     同城 160 / 跨城 805 / 历史 20；票息流水 1,041 笔（首笔 t13），无破产兑付流水；
 *   - v1.5 §4 AI 政策真实借款：每城 35 笔 active 政府贷款（purpose=government，24 期），
 *     政策资金记录 24 个月/城（t13–t36）：参考 2.88 亿、预留/实支/借款到账均 1.9198 亿、
 *     未支付 0（预算修正后政策全额执行；未支付不计受益/收入）；
 *   - 无 bondAdvance、无 writtenOff 政府贷款（所有贷款 active，勾销记录为 0）。
 *
 * 相对 v1.4 的变化来自 §4 政策融资与转移支付：AI 高失业政策在财政为 0 时“先立项、后真实借款”，
 * 救助/租金补贴真实落地到居民群体（改变消费/税收轨迹），因此出现政府贷款与贷款利息、
 * 负债率与债券/持债规模变化。本文件按“空序列”如实锁定结构与守恒，不伪造破产数值。
 * 保留全部可验证的守恒/结构断言（AC-F-R1~R9：计划=成交+未售、持债份数=成交份数、
 *  无破产兑付/垫付、不变量为空、政府持股来源结构、三城保持 solvent、政策资金三口径与
 *  政府贷款/债务分解守恒）。
 *
 * 性能注意：v1.5 下 36 月默认模拟单次约 3 分钟（2 核共享环境更慢），
 * 因此 beforeAll 的 hookTimeout 放宽到 600s；单测超时由命令行 --testTimeout 控制。
 */
describe('AC-F-R 真实 36 月破产序列（seed 20261101，玩家无操作，v1.5 最终口径）', () => {
  let world: WorldState;
  /** 每月月末的负债率快照（tick → cityId → lastDebt）。 */
  const monthEndRatio = new Map<number, Map<string, { ratio: number; riskLevel: string }>>();

  beforeAll(async () => {
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
      // 每月让出一次事件循环：36 月连续同步计算约 3 分钟，长期占住 worker 会让
      // vitest 的 onTaskUpdate RPC 超时（误报 unhandled error）；让出后不影响模拟结果。
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    world = sim.state;
  }, 600_000);

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
  /** 解析持债人所在城市（用于同城/跨城分类；玩家不参与该分类）。 */
  const holderCityId = (holding: BondHolding): string | null => {
    if (holding.holder.kind === 'player') return null;
    if (holding.holder.kind === 'investorGroup') {
      return world.investors.find((group) => group.id === holding.holder.id)?.cityId ?? null;
    }
    return world.companies.find((company) => company.id === holding.holder.id)?.cityId ?? null;
  };

  it('F-R1 触发月份：36 月内三城均未破产，records 为空且全部 solvent', () => {
    expect(records()).toHaveLength(0);
    for (const entry of world.cities) {
      expect(entry.government!.records).toEqual([]);
      expect(entry.government!.bankruptcy.status).toBe('solvent');
      expect(entry.government!.bankruptcy.tick).toBeNull();
      expect(entry.government!.bankruptcy.recordId).toBeNull();
      expect(entry.government!.bankruptcy.debtRatio).toBeNull();
    }
  });

  it('F-R2 风险分级：t19/t27/t28/t36 负债率按真实轨迹锁定，且全程未达 100%', () => {
    const expected: Record<number, Record<string, { ratio: number; riskLevel: string }>> = {
      19: {
        lanport: { ratio: 0.156909, riskLevel: 'normal' },
        ironvale: { ratio: 0.197433, riskLevel: 'normal' },
        greenfield: { ratio: 0.206488, riskLevel: 'normal' },
      },
      27: {
        lanport: { ratio: 0.248676, riskLevel: 'normal' },
        ironvale: { ratio: 0.340757, riskLevel: 'normal' },
        greenfield: { ratio: 0.345479, riskLevel: 'normal' },
      },
      28: {
        lanport: { ratio: 0.251704, riskLevel: 'normal' },
        ironvale: { ratio: 0.350446, riskLevel: 'normal' },
        greenfield: { ratio: 0.356034, riskLevel: 'normal' },
      },
      36: {
        lanport: { ratio: 0.286466, riskLevel: 'normal' },
        ironvale: { ratio: 0.414176, riskLevel: 'normal' },
        greenfield: { ratio: 0.409088, riskLevel: 'normal' },
      },
    };
    for (const [tick, cities] of Object.entries(expected)) {
      for (const [cityId, item] of Object.entries(cities)) {
        const snapshot = monthEndRatio.get(Number(tick))?.get(cityId);
        expect(snapshot?.ratio).toBeCloseTo(item.ratio, 5);
        expect(snapshot?.riskLevel).toBe(item.riskLevel);
      }
    }
    // 结构断言：36 个月所有月末均未达到破产判定线（无 record、riskLevel 非 bankrupt）。
    for (const snapshot of monthEndRatio.values()) {
      for (const item of snapshot.values()) {
        expect(item.ratio).toBeGreaterThanOrEqual(0);
        expect(item.ratio).toBeLessThan(1);
        expect(item.riskLevel).toBe('normal');
      }
    }
  });

  it('F-R3 无破产兑付：债券流水仅票息，无 bankruptcyRedemption/垫付贷款；未付票息只计欠息', () => {
    const payments = world.bonds!.payments;
    expect(payments).toHaveLength(1041);
    expect(payments.every((payment) => payment.kind === 'coupon')).toBe(true);
    expect(payments.filter((payment) => payment.kind === 'bankruptcyRedemption')).toHaveLength(0);
    expect(Math.min(...payments.map((payment) => payment.tick))).toBe(13);

    for (const issuance of allIssuances()) {
      expect(issuance.status).toBe('active');
      expect(issuance.redeemedTick).toBeNull();
      expect(issuance.redemptionReason).toBeNull();
      expect(issuance.bankAdvancedAmount).toBeCloseTo(0, 2);
      expect(issuance.arrearsInterest).toBeGreaterThanOrEqual(0);
    }
    // v1.3 财政轨迹下部分票息未付（欠息累积但未触发破产）：欠息只可能出现在
    // “首期票息已到期”的批次上；未到票息期的批次欠息必须为 0。
    const arrearsIssuances = allIssuances().filter((issuance) => issuance.arrearsInterest > 0.005);
    expect(arrearsIssuances).toHaveLength(30);
    expect(arrearsIssuances.reduce((sum, issuance) => sum + issuance.arrearsInterest, 0)).toBeCloseTo(
      38_922_000,
      2,
    );
    for (const issuance of allIssuances()) {
      const couponDue = issuance.issuedTick + issuance.interestPeriodMonths <= 36;
      if (!couponDue) {
        expect(issuance.arrearsInterest).toBeCloseTo(0, 2);
      } else if (issuance.arrearsInterest > 0.005) {
        // 已到期未付的票息：欠息 = 未付票息 + 逾期后继续计提的利息，量级不超过
        // 两期年付票息（防呆上限；真实值见下方总额锁定）。
        expect(issuance.arrearsInterest).toBeLessThanOrEqual(
          issuance.principal * issuance.couponRateAnnual * 2 + 0.02,
        );
      } else {
        // 已到期且已支付：必须有至少一次票息支付记录。
        expect(issuance.couponsPaid).toBeGreaterThanOrEqual(1);
      }
    }
    // 无破产兑付 → 不存在 bondAdvance 贷款，也不存在勾销贷款；政府贷款全部来自
    // v1.5 §4 政策“先立项后融资”的真实银行放款（purpose=government，24 期，active）。
    const allGovernmentLoans = world.cities.flatMap((entry) => entry.government!.loans);
    expect(allGovernmentLoans.length).toBeGreaterThan(0);
    for (const loan of allGovernmentLoans) {
      expect(loan.status).toBe('active');
      expect(loan.purpose).toBe('government');
      expect(loan.outstanding).toBeGreaterThanOrEqual(0);
      expect(loan.outstanding).toBeLessThanOrEqual(loan.principal + 0.01);
    }
    expect(allGovernmentLoans.filter((loan) => loan.purpose === 'bondAdvance')).toHaveLength(0);
    expect(allGovernmentLoans.filter((loan) => loan.status === 'writtenOff')).toHaveLength(0);
    expect(world.bonds!.payments.filter((payment) => payment.kind === 'bankruptcyRedemption')).toHaveLength(0);
  });

  it('F-R4 债券认购：计划=成交+未售（总量守恒），持有人为居民实体或企业（940 跨城 / 166 同城 / 6 历史）', () => {
    const totalPlan = allIssuances().reduce((sum, issuance) => sum + issuance.planUnits, 0);
    const totalSold = allIssuances().reduce((sum, issuance) => sum + issuance.soldUnits, 0);
    const totalUnsold = allIssuances().reduce((sum, issuance) => sum + issuance.unsoldUnits, 0);
    expect(totalPlan).toBe(3_014_448);
    expect(totalSold).toBe(3_014_448);
    expect(totalUnsold).toBe(0);
    expect(totalSold + totalUnsold).toBe(totalPlan);
    expect(allIssuances()).toHaveLength(36);
    for (const entry of world.cities) {
      expect(allIssuances().filter((issuance) => issuance.cityId === entry.id)).toHaveLength(12);
    }
    for (const issuance of allIssuances()) {
      // 关闭后未售=计划-成交（未售不形成债务，也不重复计入持债）。
      expect(issuance.unsoldUnits).toBe(issuance.planUnits - issuance.soldUnits);
      expect(issuance.principal).toBe(issuance.planUnits * 1000);
      // 持债份数合计必须等于成交份数（不重复记账、不凭空造债）。
      const holdingUnits = world.bonds!.holdings
        .filter((holding) => holding.issuanceId === issuance.id)
        .reduce((sum, holding) => sum + holding.units, 0);
      // v1.5 §2 跨城迁移会按 0.01 份粒度拆分持债（本金=份数×面额不变），份数合计会有
      // 浮点累计尾差，故用分币级近似而非整数相等；守恒语义不变（仍等于成交份数）。
      expect(holdingUnits).toBeCloseTo(issuance.soldUnits, 2);
    }

    const holdings = world.bonds!.holdings;
    expect(holdings).toHaveLength(985);
    // 认购顺序为玩家→居民投资实体→企业；持有主体只能是这三类（银行不得认购）。
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
    expect(crossCity).toBe(805);
    expect(sameCity).toBe(160);
    expect(historicalHoldings).toBe(20);
    expect(holdings.filter((holding) => holding.holder.kind === 'company')).toHaveLength(730);
    expect(holdings.filter((holding) => holding.holder.kind === 'investorGroup')).toHaveLength(255);
    // 无破产兑付时，除 20 笔历史持债外其余全部 active（985 − 20 = 965）。
    expect(holdings.filter((holding) => holding.status === 'active')).toHaveLength(965);
  });

  it('F-R5 债务勾销：无破产勾销；债务 = 未偿债券本息 + v1.5 政策借款本息（分解守恒）', () => {
    for (const entry of world.cities) {
      expect(entry.government!.records).toHaveLength(0);
      // v1.5 §4：政策“先立项后融资”产生真实政府贷款（每城 35 笔，全部 active）。
      expect(entry.government!.loans).toHaveLength(35);
      expect(entry.treasury).toBe(0);
    }
    // 城市级勾销合计为 0；所有 writtenOff 贷款为空（不抹账、不留尾）。
    for (const entry of world.cities) {
      expect(entry.government!.records.reduce((sum, record) => sum + record.advancesWrittenOff, 0)).toBe(0);
      expect(entry.government!.records.reduce((sum, record) => sum + record.bankLoansWrittenOff, 0)).toBe(0);
    }
    // 36 月末政府债务汇总锁定（v1.5 真实轨迹）。
    expect(city('lanport').government!.lastDebt?.totalDebt ?? 0).toBeCloseTo(1_147_169_053.07, 2);
    expect(city('ironvale').government!.lastDebt?.totalDebt ?? 0).toBeCloseTo(1_221_572_909.97, 2);
    expect(city('greenfield').government!.lastDebt?.totalDebt ?? 0).toBeCloseTo(1_172_484_668.36, 2);

    // 债务分解恒等式：totalDebt = 债券本金 + 政策贷款本金 + 债券计提利息 + 贷款利息；
    // 且贷款口径 = 该城 active 政府贷款的未偿本金/利息合计（同一份数据，不重复造债）。
    for (const entry of world.cities) {
      const debt = entry.government!.lastDebt!;
      const activeLoans = entry.government!.loans.filter((loan) => loan.status === 'active');
      const loanPrincipal = activeLoans.reduce((sum, loan) => sum + loan.outstanding, 0);
      const loanInterest = activeLoans.reduce(
        (sum, loan) => sum + loan.accruedInterest + loan.arrearsInterest,
        0,
      );
      expect(debt.bankLoanPrincipal).toBeCloseTo(loanPrincipal, 2);
      expect(debt.loanAccruedInterest).toBeCloseTo(loanInterest, 2);
      expect(debt.totalDebt).toBeCloseTo(
        debt.bankLoanPrincipal +
          debt.bondPrincipalOutstanding +
          debt.loanAccruedInterest +
          debt.bondAccruedInterest,
        2,
      );
      expect(debt.totalDebt).toBeGreaterThan(0);
    }
  });

  it('F-R6 无破产重选：破产触发选举为 0，未进入看守期', () => {
    // 36 月内仅发生例行选举（t0 三城），没有任何破产触发的同 tick 重选。
    for (const entry of world.cities) {
      expect(entry.government!.records).toHaveLength(0);
      expect(entry.government!.bankruptcy.status).toBe('solvent');
    }
    const bankruptcyElections = world.politics!.elections.filter(
      (election) => election.tick > 0 && world.cities.some((entry) => entry.government!.records.some((record) => record.tick === election.tick)),
    );
    expect(bankruptcyElections).toHaveLength(0);
  });

  it('F-R7 股份分配：无破产时政府持股来源结构合法，且总量不变量成立', () => {
    // 无破产 → 不存在“破产后新创办 primary 持股”；但政府在正常经营中也可能通过
    // 创办企业持有 primary 股份或二级市场买入 secondary 股份，这里只验证来源结构合法。
    for (const entry of world.cities) {
      const cityHoldings = world.securities.holdings.filter(
        (holding) => holding.holder.type === 'city' && holding.holder.id === entry.id,
      );
      for (const holding of cityHoldings) {
        expect(holding.shares).toBeGreaterThan(0);
        expect(world.companies.some((company) => company.id === holding.companyId)).toBe(true);
        expect(['primary', 'secondary']).toContain(holding.acquiredVia);
        expect(holding.sinceTick).toBeGreaterThanOrEqual(0);
        // 有创办记录时，primary 持股必须来自政府创办且不早于创办 tick。
        const founding = world.lifecycle!.foundings.find(
          (record) => record.companyId === holding.companyId,
        );
        if (founding) {
          if (holding.acquiredVia === 'primary') {
            expect(founding.founderType).toBe('government');
            expect(holding.sinceTick).toBeGreaterThanOrEqual(founding.tick);
          }
        }
      }
    }
    expect(checkInvariants(world)).toEqual([]);
  });

  it('F-R8 36 月末财政状态：三城 solvent，负债率 28.6%/41.4%/40.9%', () => {
    const expected: Record<string, { ratio: number; level: string; total: number }> = {
      lanport: { ratio: 0.286466, level: 'normal', total: 1_147_169_053.07 },
      ironvale: { ratio: 0.414176, level: 'normal', total: 1_221_572_909.97 },
      greenfield: { ratio: 0.409088, level: 'normal', total: 1_172_484_668.36 },
    };
    for (const [cityId, item] of Object.entries(expected)) {
      const entry = city(cityId);
      expect(entry.government!.bankruptcy.status).toBe('solvent');
      expect(entry.government!.lastDebt?.debtRatio ?? 0).toBeCloseTo(item.ratio, 5);
      expect(entry.government!.lastDebt?.riskLevel).toBe(item.level);
      expect(entry.government!.lastDebt?.totalDebt ?? 0).toBeCloseTo(item.total, 2);
      // 无破产 → 每城 12 期债券全部 active；v1.5 政策借款为 35 笔 active 政府贷款。
      const cityIssuances = allIssuances().filter((issuance) => issuance.cityId === cityId);
      expect(cityIssuances).toHaveLength(12);
      expect(cityIssuances.every((issuance) => issuance.status === 'active')).toBe(true);
      expect(entry.government!.loans).toHaveLength(35);
      expect(entry.government!.loans.every((loan) => loan.status === 'active')).toBe(true);
    }
    expect(checkInvariants(world)).toEqual([]);
  });

  it('F-R9 v1.5 §4 政策资金三口径：24 月/城，实支≤预留、未支付不计受益，借款=预留且为真实到账', () => {
    const expected: Record<
      string,
      { reference: number; reserved: number; spent: number; unpaid: number; borrowed: number }
    > = {
      lanport: {
        reference: 288_000_000,
        reserved: 191_980_800,
        spent: 191_980_800,
        unpaid: 0,
        borrowed: 191_980_800,
      },
      ironvale: {
        reference: 288_000_000,
        reserved: 191_980_800,
        spent: 191_980_800,
        unpaid: 0,
        borrowed: 191_980_800,
      },
      greenfield: {
        reference: 287_355_515.95,
        reserved: 191_658_784.05,
        spent: 191_658_784.05,
        unpaid: 0,
        borrowed: 191_658_784.05,
      },
    };
    const months = world.policies.fundingMonths ?? [];
    for (const [cityId, item] of Object.entries(expected)) {
      const traces = months
        .filter((trace) => trace.cityId === cityId)
        .sort((left, right) => left.tick - right.tick);
      // 保留窗口 24 月，t13 起 AI 危机政策每月真实立项→融资→预留→实支。
      expect(traces).toHaveLength(24);
      expect(traces[0]!.tick).toBe(13);
      expect(traces[traces.length - 1]!.tick).toBe(36);
      for (const trace of traces) {
        expect(trace.spent).toBeGreaterThanOrEqual(0);
        expect(trace.spent).toBeLessThanOrEqual(trace.reserved + 0.01);
        expect(trace.unpaid).toBeGreaterThanOrEqual(0);
        expect(trace.borrowingProceeds).toBeGreaterThanOrEqual(0);
        expect(['treasury', 'bankLoan', 'none']).toContain(trace.fundingSource);
        expect(trace.debtRatioAfterBorrowing).toBeLessThan(1);
        // 三口径分离且守恒：实支 + 未支付 = 本月预留资金需求。
        expect(trace.spent + trace.unpaid).toBeCloseTo(trace.reserved, 2);
        // 预留只能来自真实到账资金：借款到账 ≥ 预留中来自借款的部分（本轨迹借款=预留）。
        expect(trace.borrowingProceeds + 1e-6).toBeGreaterThanOrEqual(trace.reserved);
      }
      const aggregate = {
        reference: round2(traces.reduce((sum, trace) => sum + trace.referenceBudget, 0)),
        reserved: round2(traces.reduce((sum, trace) => sum + trace.reserved, 0)),
        spent: round2(traces.reduce((sum, trace) => sum + trace.spent, 0)),
        unpaid: round2(traces.reduce((sum, trace) => sum + trace.unpaid, 0)),
        borrowed: round2(traces.reduce((sum, trace) => sum + trace.borrowingProceeds, 0)),
      };
      expect(aggregate.reference).toBeCloseTo(item.reference, 2);
      expect(aggregate.reserved).toBeCloseTo(item.reserved, 2);
      expect(aggregate.spent).toBeCloseTo(item.spent, 2);
      expect(aggregate.unpaid).toBeCloseTo(item.unpaid, 2);
      expect(aggregate.borrowed).toBeCloseTo(item.borrowed, 2);
      expect(aggregate.spent + aggregate.unpaid).toBeCloseTo(aggregate.reserved, 2);
      // 借款是真实银行放款：该城政府贷款本金合计与资金记录借款到账同源（不为 0）。
      const activeLoanPrincipal = round2(
        city(cityId)
          .government!.loans.filter((loan) => loan.status === 'active')
          .reduce((sum, loan) => sum + loan.principal, 0),
      );
      expect(activeLoanPrincipal).toBeGreaterThan(0);
      expect(activeLoanPrincipal).toBeGreaterThanOrEqual(aggregate.borrowed - 0.01);
    }
    // 政策执行记录：实支与受益来自真实执行（未支付部分不计受益/收入）。
    const crisisRuns = [...world.policies.active, ...world.policies.history]
      .filter((policy) => policy.reason.startsWith('AI 高失业决策'))
      .flatMap((policy) => policy.tracking?.runs ?? []);
    expect(crisisRuns.length).toBeGreaterThan(0);
    expect(crisisRuns.reduce((sum, run) => sum + run.spent, 0)).toBeGreaterThan(0);
    expect(crisisRuns.reduce((sum, run) => sum + run.beneficiaries, 0)).toBeGreaterThan(0);
    for (const run of crisisRuns) {
      expect(run.spent).toBeGreaterThanOrEqual(0);
      expect(run.fiscalImpact).toBeLessThanOrEqual(0);
    }
    expect(checkInvariants(world)).toEqual([]);
  });
});
