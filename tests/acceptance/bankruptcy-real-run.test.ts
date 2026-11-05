import { beforeAll, describe, expect, it } from 'vitest';
import { Simulation } from '../../src/simulation/core/simulation';
import type { BondHolding, WorldState } from '../../src/simulation/contracts/types';
import { checkInvariants } from '../../src/simulation/core/invariants';

/**
 * F 组「真实破产样本」：固定条件 36 个月、玩家无操作、默认种子 20261101。
 * 复现命令：npx vitest run tests/acceptance/bankruptcy-real-run.test.ts --maxWorkers=1 --testTimeout=300000
 *
 * v1.4 最终代码（§3 投资权益净值/债券估值、§4 新企业初始设备、§5 AI 政府高失业决策、
 * §6 经济循环与报告口径落地后）的实测序列：
 *   - 36 月内三城均未触发政府破产（records 为空），负债率随债券滚动上升但全程 < 100%：
 *     t36 负债率 岚港 46.1%（normal）、铁谷 20.1%（normal）、青原 17.6%（normal）；
 *   - 36 期债券全部成交（计划=成交=3,037,246，未售 0），每城 12 期，全部 active；
 *   - 持债 994 笔（active 986 / 已清算企业历史持债 8；企业 756 / 居民实体 238 / 玩家 0），
 *     同城 342 / 跨城 644 / 历史 8；票息流水 315 笔（首笔 t15），无破产兑付流水；
 *   - 无 bondAdvance、无 writtenOff 政府贷款（government.loans 全为 0）。
 *
 * 相对 v1.3 的变化来自 §4/§5/§6：新企业自带初始设备让创办更早开工、AI 高失业决策（含
 * 动态预算）改变政策支出与就业、消费/生产口径（含 refundGain）变化改变税收与融资节奏 →
 * 债券成交、持债数与负债率整体上移（岚港 t36 由 27.5% 升至 46.1%）。
 * 本文件按“空序列”如实锁定结构与守恒：不伪造破产数值，保留全部可验证的守恒/结构断言
 * （AC-F-R1~R8：计划=成交+未售、持债份数=成交份数、无破产兑付/垫付、不变量为空、
 *  政府持股来源结构、三城保持 solvent）。
 *
 * 性能注意：v1.4 下 36 月默认模拟单次约 3 分钟（2 核共享环境更慢），
 * 因此 beforeAll 的 hookTimeout 放宽到 600s；单测超时由命令行 --testTimeout 控制。
 */
describe('AC-F-R 真实 36 月破产序列（seed 20261101，玩家无操作，v1.4 最终口径）', () => {
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
        lanport: { ratio: 0.153947, riskLevel: 'normal' },
        ironvale: { ratio: 0.157726, riskLevel: 'normal' },
        greenfield: { ratio: 0.1705, riskLevel: 'normal' },
      },
      27: {
        lanport: { ratio: 0.299964, riskLevel: 'normal' },
        ironvale: { ratio: 0.214138, riskLevel: 'normal' },
        greenfield: { ratio: 0.23213, riskLevel: 'normal' },
      },
      28: {
        lanport: { ratio: 0.327362, riskLevel: 'normal' },
        ironvale: { ratio: 0.212269, riskLevel: 'normal' },
        greenfield: { ratio: 0.222755, riskLevel: 'normal' },
      },
      36: {
        lanport: { ratio: 0.46144, riskLevel: 'normal' },
        ironvale: { ratio: 0.200738, riskLevel: 'normal' },
        greenfield: { ratio: 0.175611, riskLevel: 'normal' },
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
    expect(payments).toHaveLength(315);
    expect(payments.every((payment) => payment.kind === 'coupon')).toBe(true);
    expect(payments.filter((payment) => payment.kind === 'bankruptcyRedemption')).toHaveLength(0);
    expect(Math.min(...payments.map((payment) => payment.tick))).toBe(15);

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
    expect(arrearsIssuances).toHaveLength(33);
    expect(arrearsIssuances.reduce((sum, issuance) => sum + issuance.arrearsInterest, 0)).toBeCloseTo(
      116_768_880,
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
    // 无破产兑付 → 不存在 bondAdvance 贷款，也不存在勾销贷款。
    const allGovernmentLoans = world.cities.flatMap((entry) => entry.government!.loans);
    expect(allGovernmentLoans).toHaveLength(0);
    expect(allGovernmentLoans.filter((loan) => loan.purpose === 'bondAdvance')).toHaveLength(0);
    expect(allGovernmentLoans.filter((loan) => loan.status === 'writtenOff')).toHaveLength(0);
    expect(world.bonds!.payments.filter((payment) => payment.kind === 'bankruptcyRedemption')).toHaveLength(0);
  });

  it('F-R4 债券认购：计划=成交+未售（总量守恒），持有人为居民实体或企业（644 跨城 / 342 同城 / 8 历史）', () => {
    const totalPlan = allIssuances().reduce((sum, issuance) => sum + issuance.planUnits, 0);
    const totalSold = allIssuances().reduce((sum, issuance) => sum + issuance.soldUnits, 0);
    const totalUnsold = allIssuances().reduce((sum, issuance) => sum + issuance.unsoldUnits, 0);
    expect(totalPlan).toBe(3_037_246);
    expect(totalSold).toBe(3_037_246);
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
      expect(holdingUnits).toBe(issuance.soldUnits);
    }

    const holdings = world.bonds!.holdings;
    expect(holdings).toHaveLength(994);
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
    expect(crossCity).toBe(644);
    expect(sameCity).toBe(342);
    expect(historicalHoldings).toBe(8);
    expect(holdings.filter((holding) => holding.holder.kind === 'company')).toHaveLength(756);
    expect(holdings.filter((holding) => holding.holder.kind === 'investorGroup')).toHaveLength(238);
    // 无破产兑付时，除 8 笔历史持债外其余全部 active（994 − 8 = 986）。
    expect(holdings.filter((holding) => holding.status === 'active')).toHaveLength(986);
  });

  it('F-R5 债务勾销：无破产勾销，政府债务全部为未偿债券本金', () => {
    for (const entry of world.cities) {
      expect(entry.government!.records).toHaveLength(0);
      expect(entry.government!.loans).toHaveLength(0);
      expect(entry.treasury).toBe(0);
    }
    // 城市级勾销合计为 0；所有 writtenOff 贷款为空（不抹账、不留尾）。
    for (const entry of world.cities) {
      expect(entry.government!.records.reduce((sum, record) => sum + record.advancesWrittenOff, 0)).toBe(0);
      expect(entry.government!.records.reduce((sum, record) => sum + record.bankLoansWrittenOff, 0)).toBe(0);
    }
    // 36 月末政府债务汇总锁定（v1.3 真实轨迹）。
    expect(city('lanport').government!.lastDebt?.totalDebt ?? 0).toBeCloseTo(1_092_467_763.35, 2);
    expect(city('ironvale').government!.lastDebt?.totalDebt ?? 0).toBeCloseTo(1_095_948_499.99, 2);
    expect(city('greenfield').government!.lastDebt?.totalDebt ?? 0).toBeCloseTo(969_521_196.69, 2);
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

  it('F-R8 36 月末财政状态：三城 solvent，负债率 46.1%/20.1%/17.6%', () => {
    const expected: Record<string, { ratio: number; level: string; total: number }> = {
      lanport: { ratio: 0.46144, level: 'normal', total: 1_092_467_763.35 },
      ironvale: { ratio: 0.200738, level: 'normal', total: 1_095_948_499.99 },
      greenfield: { ratio: 0.175611, level: 'normal', total: 969_521_196.69 },
    };
    for (const [cityId, item] of Object.entries(expected)) {
      const entry = city(cityId);
      expect(entry.government!.bankruptcy.status).toBe('solvent');
      expect(entry.government!.lastDebt?.debtRatio ?? 0).toBeCloseTo(item.ratio, 5);
      expect(entry.government!.lastDebt?.riskLevel).toBe(item.level);
      expect(entry.government!.lastDebt?.totalDebt ?? 0).toBeCloseTo(item.total, 2);
      // 无破产 → 每城 12 期债券全部 active，无政府贷款。
      const cityIssuances = allIssuances().filter((issuance) => issuance.cityId === cityId);
      expect(cityIssuances).toHaveLength(12);
      expect(cityIssuances.every((issuance) => issuance.status === 'active')).toBe(true);
      expect(entry.government!.loans).toHaveLength(0);
    }
    expect(checkInvariants(world)).toEqual([]);
  });
});
