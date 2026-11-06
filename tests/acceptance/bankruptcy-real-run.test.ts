import { beforeAll, describe, expect, it } from 'vitest';
import { Simulation } from '../../src/simulation/core/simulation';
import type { BondHolding, WorldState } from '../../src/simulation/contracts/types';
import { checkInvariants } from '../../src/simulation/core/invariants';
import { round2 } from '../../src/simulation/core/math';

/**
 * F 组「真实破产样本」：固定条件 36 个月、玩家无操作、默认种子 20261101。
 * 复现命令：npx vitest run tests/acceptance/bankruptcy-real-run.test.ts --maxWorkers=1 --testTimeout=300000
 *
 * v1.6 最终代码（§一 政策总额度口径、§二 价格规则、§三 企业竞争/生产/招聘、§四 设备维护费、
 * §五 僵尸企业退出、D4 债券迁移高精度份额）的实测序列（2026-11-06 重锁）：
 *   - 36 月内三城均未触发政府破产（records 为空），负债率随债券+政策借款上升但全程 < 100%：
 *     t36 负债率 岚港 27.3%（normal）、铁谷 29.1%（normal）、青原 37.5%（normal）；
 *   - 36 期债券全部成交（计划=成交=3,234,342，未售 0），每城 12 期；
 *   - 持债 790 笔（active 787 / 已兑付历史 3），企业 518 / 居民实体 272 / 玩家 0；
 *     同城 243 / 跨城 544 / 历史 3；票息流水 807 笔（首笔 t13），无破产兑付流水；
 *   - v1.6 §一.1 政策总额度口径：每城 35/35/32 笔 active 政府贷款（purpose=government，24 期），
 *     政策资金记录 24 个月/城（t13–t36）：参考合计 1.44 亿（= 600 万/月 × 24，旧口径 2.88 亿），
 *     预留/实支/借款到账见下方锁定值，未支付 0，Σ分项分配 ≤ 当月总额度。
 *   - 无 bondAdvance、无 writtenOff 政府贷款（所有贷款 active，勾销记录为 0）。
 *
 * 相对 v1.5 的变化来自本任务书确认的规则调整（政策总额度不再每项各拿一份、设备维护费进入
 * 税前利润与 AI 决策、价格缺口计入进口、企业竞争/退出），轨迹整体改变；本文件按真实 v1.6
 * 序列重锁数值，但保留全部守恒/结构断言（AC-F-R1~R9：计划=成交+未售、持债份数=成交份数、
 * 无破产兑付/垫付、不变量为空、政府持股来源结构、三城保持 solvent、政策额度分项与债务分解守恒）。
 *
 * 性能注意：v1.6 下 36 月默认模拟单次约 3 分钟（2 核共享环境更慢），
 * 因此 beforeAll 的 hookTimeout 放宽到 600s；单测超时由命令行 --testTimeout 控制。
 */
describe('AC-F-R 真实 36 月破产序列（seed 20261101，玩家无操作，v1.6 最终口径）', () => {
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

  it('F-R2 风险分级：t19/t27/t28/t36 负债率按 v1.6 真实轨迹锁定，且全程未达 100%', () => {
    const expected: Record<number, Record<string, { ratio: number; riskLevel: string }>> = {
      19: {
        lanport: { ratio: 0.164194, riskLevel: 'normal' },
        ironvale: { ratio: 0.188312, riskLevel: 'normal' },
        greenfield: { ratio: 0.247863, riskLevel: 'normal' },
      },
      27: {
        lanport: { ratio: 0.231993, riskLevel: 'normal' },
        ironvale: { ratio: 0.289059, riskLevel: 'normal' },
        greenfield: { ratio: 0.406351, riskLevel: 'normal' },
      },
      28: {
        lanport: { ratio: 0.237853, riskLevel: 'normal' },
        ironvale: { ratio: 0.283805, riskLevel: 'normal' },
        greenfield: { ratio: 0.406425, riskLevel: 'normal' },
      },
      36: {
        lanport: { ratio: 0.273331, riskLevel: 'normal' },
        ironvale: { ratio: 0.29095, riskLevel: 'normal' },
        greenfield: { ratio: 0.375315, riskLevel: 'normal' },
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
    expect(payments).toHaveLength(807);
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
    // v1.6 财政轨迹下部分票息未付（欠息累积但未触发破产）：欠息只可能出现在
    // “首期票息已到期”的批次上；未到票息期的批次欠息必须为 0。
    const arrearsIssuances = allIssuances().filter((issuance) => issuance.arrearsInterest > 0.005);
    expect(arrearsIssuances).toHaveLength(31);
    expect(arrearsIssuances.reduce((sum, issuance) => sum + issuance.arrearsInterest, 0)).toBeCloseTo(
      55_144_505.65,
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

  it('F-R4 债券认购：计划=成交+未售（总量守恒），持有人为居民实体或企业（544 跨城 / 243 同城 / 3 历史）', () => {
    const totalPlan = allIssuances().reduce((sum, issuance) => sum + issuance.planUnits, 0);
    const totalSold = allIssuances().reduce((sum, issuance) => sum + issuance.soldUnits, 0);
    const totalUnsold = allIssuances().reduce((sum, issuance) => sum + issuance.unsoldUnits, 0);
    expect(totalPlan).toBe(3_234_342);
    expect(totalSold).toBe(3_234_342);
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
    expect(holdings).toHaveLength(790);
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
    expect(crossCity).toBe(544);
    expect(sameCity).toBe(243);
    expect(historicalHoldings).toBe(3);
    expect(holdings.filter((holding) => holding.holder.kind === 'company')).toHaveLength(518);
    expect(holdings.filter((holding) => holding.holder.kind === 'investorGroup')).toHaveLength(272);
    // 无破产兑付时，除 3 笔历史持债外其余全部 active（790 − 3 = 787）。
    expect(holdings.filter((holding) => holding.status === 'active')).toHaveLength(787);
  });

  it('F-R5 债务勾销：无破产勾销；债务 = 未偿债券本息 + 政策借款本息（分解守恒）', () => {
    const loansByCity: Record<string, number> = { lanport: 35, ironvale: 35, greenfield: 32 };
    for (const entry of world.cities) {
      expect(entry.government!.records).toHaveLength(0);
      // v1.6 §一.1：政策“先立项后融资”产生真实政府贷款（每月最多 1 笔，35/35/32 笔全部 active）。
      expect(entry.government!.loans).toHaveLength(loansByCity[entry.id] ?? 0);
      expect(entry.treasury).toBe(0);
    }
    // 城市级勾销合计为 0；所有 writtenOff 贷款为空（不抹账、不留尾）。
    for (const entry of world.cities) {
      expect(entry.government!.records.reduce((sum, record) => sum + record.advancesWrittenOff, 0)).toBe(0);
      expect(entry.government!.records.reduce((sum, record) => sum + record.bankLoansWrittenOff, 0)).toBe(0);
    }
    // 36 月末政府债务汇总锁定（v1.6 真实轨迹）。
    expect(city('lanport').government!.lastDebt?.totalDebt ?? 0).toBeCloseTo(1_267_451_036.13, 2);
    expect(city('ironvale').government!.lastDebt?.totalDebt ?? 0).toBeCloseTo(1_271_643_830.65, 2);
    expect(city('greenfield').government!.lastDebt?.totalDebt ?? 0).toBeCloseTo(1_146_147_854.13, 2);

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

  it('F-R8 36 月末财政状态：三城 solvent，负债率 27.3%/29.1%/37.5%', () => {
    const expected: Record<string, { ratio: number; level: string; total: number }> = {
      lanport: { ratio: 0.273331, level: 'normal', total: 1_267_451_036.13 },
      ironvale: { ratio: 0.29095, level: 'normal', total: 1_271_643_830.65 },
      greenfield: { ratio: 0.375315, level: 'normal', total: 1_146_147_854.13 },
    };
    const loansByCity: Record<string, number> = { lanport: 35, ironvale: 35, greenfield: 32 };
    for (const [cityId, item] of Object.entries(expected)) {
      const entry = city(cityId);
      expect(entry.government!.bankruptcy.status).toBe('solvent');
      expect(entry.government!.lastDebt?.debtRatio ?? 0).toBeCloseTo(item.ratio, 5);
      expect(entry.government!.lastDebt?.riskLevel).toBe(item.level);
      expect(entry.government!.lastDebt?.totalDebt ?? 0).toBeCloseTo(item.total, 2);
      // 无破产 → 每城 12 期债券全部 active；v1.6 政策借款为 35/35/32 笔 active 政府贷款。
      const cityIssuances = allIssuances().filter((issuance) => issuance.cityId === cityId);
      expect(cityIssuances).toHaveLength(12);
      expect(cityIssuances.every((issuance) => issuance.status === 'active')).toBe(true);
      expect(entry.government!.loans).toHaveLength(loansByCity[cityId] ?? 0);
      expect(entry.government!.loans.every((loan) => loan.status === 'active')).toBe(true);
    }
    expect(checkInvariants(world)).toEqual([]);
  });

  it('F-R9 v1.6 §一.1 政策总额度分项：24 月/城，Σ分项≤总额度，实支≤预留、未支付不计受益', () => {
    const expected: Record<
      string,
      { reference: number; reserved: number; spent: number; unpaid: number; borrowed: number }
    > = {
      lanport: {
        reference: 144_000_000,
        reserved: 119_980_800,
        spent: 119_980_800,
        unpaid: 0,
        borrowed: 119_980_800,
      },
      ironvale: {
        reference: 144_000_000,
        reserved: 119_980_800,
        spent: 119_980_800,
        unpaid: 0,
        borrowed: 119_980_800,
      },
      greenfield: {
        reference: 144_000_000,
        reserved: 119_888_746.26,
        spent: 119_888_746.26,
        unpaid: 0,
        borrowed: 109_890_346.26,
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
        // v1.6 §一.1：当月总额度存在，且各项分项参考预算之和 ≤ 总额度（同一笔额度不重复使用）；
        // 每项 spent+unpaid 按自身分项额度封顶（公共工资超配额部分单独记录，不计入分项额度）。
        expect(trace.quota).toBeGreaterThan(0);
        const allocationTotal = (trace.policyBudgets ?? []).reduce(
          (sum, entry) => sum + entry.referenceBudget,
          0,
        );
        expect(allocationTotal).toBeLessThanOrEqual(trace.quota! + 0.01);
        for (const entry of trace.policyBudgets ?? []) {
          expect(entry.spent + entry.unpaid).toBeLessThanOrEqual(entry.referenceBudget + 0.02);
          expect(entry.reserved).toBeGreaterThanOrEqual(0);
        }
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
      // 实支+未支付 = 实际预留（本月预留即执行需求，未支付自然是 0）。
      expect(aggregate.spent + aggregate.unpaid).toBeCloseTo(aggregate.reserved, 2);
      // 借款只能补足预留中财政付不出的部分，不得超过预留总额（不凭空造钱）。
      expect(aggregate.borrowed).toBeLessThanOrEqual(aggregate.reserved + 0.01);
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
