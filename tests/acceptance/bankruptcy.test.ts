import { describe, expect, it } from 'vitest';
import { Simulation } from '../../src/simulation/core/simulation';
import { DEMO_CONFIG, type DemoConfig } from '../../src/data/config';
import type { BondHolder, WorldState } from '../../src/simulation/contracts/types';
import {
  closeGovernmentBondSubscription,
  issueGovernmentBond,
  subscribeGovernmentBond,
} from '../../src/simulation/government/bonds';
import {
  borrowForGovernment,
  liquidateBankruptGovernment,
  computeGovernmentDebtSummary,
  evaluateGovernmentBankruptcy,
  distributeBankruptGovernmentShares,
  settleCityGovernmentDebt,
} from '../../src/simulation/government/debt';
import {
  companyHolders,
  createShareStructure,
  holderKey,
} from '../../src/simulation/securities/securities';
import { parseSave, serializeSave } from '../../src/simulation/core/save';
import { checkInvariants } from '../../src/simulation/core/invariants';
import { newWorld, totalMoney } from './helpers';

const CONFIG = DEMO_CONFIG;
/** 关闭 AI 政府，避免自动发债干扰破产判定（与业务测试同口径）。 */
const NO_AI = {
  ...CONFIG,
  government: {
    ...CONFIG.government,
    aiGovernment: { ...CONFIG.government.aiGovernment, enabled: false },
  },
} as unknown as DemoConfig;
const PLAYER: BondHolder = { kind: 'player', id: 'player' };

function mainCity(world: WorldState) {
  const city = world.cities.find((entry) => entry.id === 'lanport') ?? world.cities[0];
  if (!city) throw new Error('缺少城市');
  return city;
}

/** 把判定窗口压到 12×monthly，让少量债务即可触发 100% 破产。 */
function setGdpWindow(world: WorldState, monthly: number): void {
  const city = mainCity(world);
  city.gdpWindow = Array.from({ length: 12 }, (_, index) => ({
    tick: -12 + index,
    value: monthly,
    estimated: true,
  }));
}

function sellIssue(world: WorldState, tick = 0, units = 10) {
  const city = mainCity(world);
  world.time.tick = tick;
  world.player.cash = units * 1_000;
  const issued = issueGovernmentBond(world, city, CONFIG, units, tick);
  if (!issued.ok || !issued.issuance) throw new Error(issued.error ?? '发行失败');
  const bought = subscribeGovernmentBond(world, CONFIG, issued.issuance.id, PLAYER, units, tick);
  if (!bought.ok) throw new Error(bought.error ?? '认购失败');
  closeGovernmentBondSubscription(world, CONFIG, issued.issuance.id, tick);
  return { city, issuance: issued.issuance };
}

function paymentsOf(world: WorldState) {
  return (world.bonds?.payments ?? []).slice();
}

/** 触发破产的最小场景：GDP 窗口 1200、财政 0、银行借款 2,000（负债≥100%）。 */
function bankruptScenario(config: DemoConfig = NO_AI) {
  const world = newWorld();
  const city = mainCity(world);
  setGdpWindow(world, 100);
  city.treasury = 0;
  const borrowed = borrowForGovernment(world, city, config, 2_000, 0, []);
  expect(borrowed.ok).toBe(true);
  world.time.tick = 1;
  const result = settleCityGovernmentDebt(world, city, config, []);
  return { world, city, result };
}

describe('AC-F01 破产阈值口径（总负债构成）', () => {
  it('总负债 = 银行贷款 + 垫付本金 + 未偿债券本金 + 应计未付利息', () => {
    const world = newWorld();
    const city = mainCity(world);
    world.time.tick = 0;
    const borrowed = borrowForGovernment(world, city, CONFIG, 20_000, 0, []);
    expect(borrowed.ok).toBe(true);
    const { issuance } = sellIssue(world, 0, 10);
    expect(issuance.soldUnits).toBe(10);

    const summary = computeGovernmentDebtSummary(world, city, CONFIG, 0);
    const loans = city.government!.loans.filter((loan) => loan.status === 'active');
    const loanPrincipal = loans.reduce((sum, loan) => sum + loan.outstanding, 0);
    const bondPrincipal = (world.bonds?.holdings ?? []).reduce(
      (sum, holding) => sum + (holding.status === 'active' ? holding.principal : 0),
      0,
    );
    expect(summary.bankLoanPrincipal).toBeCloseTo(loanPrincipal, 2);
    expect(summary.bondPrincipalOutstanding).toBeCloseTo(bondPrincipal, 2);
    expect(summary.totalDebt).toBeCloseTo(
      summary.bankLoanPrincipal +
        summary.bankAdvancePrincipal +
        summary.bondPrincipalOutstanding +
        summary.loanAccruedInterest +
        summary.bondAccruedInterest,
      2,
    );
  });
});

describe('AC-F02 阈值边界与动态 GDP', () => {
  it('99.99% 不破产、100% 破产；GDP 增长使比率回落则不破产', () => {
    const world = newWorld();
    const city = mainCity(world);
    setGdpWindow(world, 100); // 判定分母 = 1200
    const borrowed = borrowForGovernment(world, city, CONFIG, 20_000, 0, []);
    expect(borrowed.ok).toBe(true);

    // 当前负债约 2 万，比率远高于 1：先验证可破产。
    expect(evaluateGovernmentBankruptcy(city, computeGovernmentDebtSummary(world, city, CONFIG, 0), CONFIG)).toBe(true);

    // 纯口径边界：ratio 1.0 破产、0.9999 不破产。
    const base = computeGovernmentDebtSummary(world, city, CONFIG, 0);
    const at1 = { ...base, totalDebt: base.gdpJudgementValue, debtRatio: 1 };
    const below1 = { ...base, totalDebt: base.gdpJudgementValue * 0.9999, debtRatio: 0.9999 };
    expect(evaluateGovernmentBankruptcy(city, at1, CONFIG)).toBe(true);
    expect(evaluateGovernmentBankruptcy(city, below1, CONFIG)).toBe(false);

    // GDP 增长后同一债务不破产（判定分母变大）。
    setGdpWindow(world, 100_000);
    const grown = computeGovernmentDebtSummary(world, city, CONFIG, 0);
    expect(grown.debtRatio).toBeLessThan(0.5);
    expect(evaluateGovernmentBankruptcy(city, grown, CONFIG)).toBe(false);
  });
});

describe('AC-F03 最小判定值 1', () => {
  it('12 月 GDP 合计为 0 时判定分母按 max(1, 合计)=1，不除零', () => {
    const world = newWorld();
    const city = mainCity(world);
    setGdpWindow(world, 0);
    city.treasury = 0;
    const borrowed = borrowForGovernment(world, city, CONFIG, 20_000, 0, []);
    expect(borrowed.ok).toBe(true);

    const summary = computeGovernmentDebtSummary(world, city, CONFIG, 0);
    expect(summary.gdpWindowSum).toBe(0);
    expect(summary.gdpJudgementValue).toBeCloseTo(1, 6);
    expect(Number.isFinite(summary.debtRatio)).toBe(true);
    expect(summary.debtRatio).toBeGreaterThan(1);
    expect(summary.note.length).toBeGreaterThan(0);
  });
});

describe('AC-F04 破产当月立即重选', () => {
  it('判定与重选在同一结算 tick 内发生，不推迟到下月', () => {
    const { world, city } = bankruptScenario(CONFIG);
    const government = city.government!;
    expect(government.bankruptcy.status).toBe('bankrupt');
    expect(government.bankruptcy.tick).toBe(1);
    const record = government.records[0]!;
    expect(record.tick).toBe(1);
    // 立即重选成功则记录同 tick；选举无法进行时进入看守期（唯一允许的例外）。
    expect(record.electionTriggeredTick === 1 || record.caretakerUntilElection).toBe(true);
    expect(world.time.tick).toBe(1);
  });
});

describe('AC-F05 破产幂等', () => {
  it('同一结算点只清算一次：重复 settlement 不追加记录、不重复选举', () => {
    const { world, city } = bankruptScenario();
    const government = city.government!;
    const recordsAfter = government.records.length;
    expect(recordsAfter).toBe(1);
    const settledAfter = government.settledTicks.filter((tick) => tick === 1).length;
    expect(settledAfter).toBe(1);

    // 即使人为清掉 settledTicks 重放结算，记录也不得增加。
    government.settledTicks = government.settledTicks.filter((tick) => tick !== 1);
    settleCityGovernmentDebt(world, city, NO_AI, []);
    expect(government.records).toHaveLength(recordsAfter);
    expect(government.records[0]!.tick).toBe(1);
    expect(city.bankruptcy?.recordId).toBe(government.records[0]!.id);
  });
});

describe('AC-F06 破产提前兑付未到期债券', () => {
  it('破产时立即兑付未到期本金 + 已计提未付利息；到期月不得重复付', () => {
    const world = newWorld();
    const city = mainCity(world);
    setGdpWindow(world, 100);
    city.treasury = 0;
    const { issuance } = sellIssue(world, 0, 10); // 36 月到期
    expect(issuance.status).toBe('active');

    world.time.tick = 10;
    const result = settleCityGovernmentDebt(world, city, NO_AI, []);
    expect(result.bankrupted).toBe(true);

    const paymentsAt10 = paymentsOf(world).filter((payment) => payment.issuanceId === issuance.id);
    expect(paymentsAt10.length).toBeGreaterThanOrEqual(1);
    expect(paymentsAt10.every((payment) => payment.tick === 10)).toBe(true);
    expect(paymentsAt10.reduce((sum, payment) => sum + payment.principalPaid, 0)).toBeCloseTo(10_000, 2);
    expect(paymentsAt10.reduce((sum, payment) => sum + payment.interestPaid, 0)).toBeGreaterThan(0);
    expect(issuance.redeemedTick).toBe(10);
    expect(issuance.status).toBe('redeemed');

    // 推进到 36 月：已兑付批次不得再付一笔。
    world.time.tick = 36;
    city.government!.settledTicks = city.government!.settledTicks.filter((tick) => tick !== 36);
    settleCityGovernmentDebt(world, city, NO_AI, []);
    const paymentsAt36 = paymentsOf(world).filter((payment) => payment.issuanceId === issuance.id && payment.tick === 36);
    expect(paymentsAt36).toHaveLength(0);
  });
});

describe('AC-F07 债务勾销', () => {
  it('银行贷款与垫付贷款一并勾销；勾销动作本身不改变财政余额、不留存为政府债务', () => {
    const world = newWorld();
    const city = mainCity(world);
    setGdpWindow(world, 100);
    city.treasury = 5_000;
    const borrowed = borrowForGovernment(world, city, CONFIG, 20_000, 0, []);
    expect(borrowed.ok).toBe(true);
    world.time.tick = 1;
    const summary = computeGovernmentDebtSummary(world, city, NO_AI, 1);
    expect(evaluateGovernmentBankruptcy(city, summary, CONFIG)).toBe(true);
    const treasuryBefore = city.treasury;

    const record = liquidateBankruptGovernment(world, city, NO_AI, summary, 1, []);
    expect(record).not.toBeNull();
    // 清算本身不动财政余额（破产兑付由银行垫付，不用财政资金）。
    expect(city.treasury).toBeCloseTo(treasuryBefore, 2);
    for (const loan of city.government!.loans) {
      expect(loan.status).toBe('writtenOff');
      expect(loan.outstanding).toBeCloseTo(0, 2);
      expect(loan.paidPrincipal).toBeCloseTo(loan.principal, 2);
    }
    const after = computeGovernmentDebtSummary(world, city, NO_AI, 1);
    expect(after.bankLoanPrincipal).toBeCloseTo(0, 2);
    expect(after.totalDebt).toBeCloseTo(0, 2);
  });
});

describe('AC-F08 同月到期 + 破产', () => {
  it('到期债券与破产提前兑付各只付一次，先兑付后勾销', () => {
    const world = newWorld();
    const city = mainCity(world);
    setGdpWindow(world, 100);
    city.treasury = 0;
    const { issuance } = sellIssue(world, 0, 10);
    // 直接推进到 36 月（到期月）；负债 1 万 / 判定 GDP 1200 → 触发破产。
    world.time.tick = 36;
    const result = settleCityGovernmentDebt(world, city, NO_AI, []);
    expect(result.bankrupted).toBe(true);

    const payments = paymentsOf(world).filter((payment) => payment.issuanceId === issuance.id);
    const keys = payments.map((payment) => `${payment.holdingId}|${payment.tick}|${payment.kind}`);
    expect(new Set(keys).size).toBe(keys.length);
    // 到期足额：本金 10,000 分「财政支付 + 银行垫付」两段，两段都必须入流水。
    expect(payments.reduce((sum, payment) => sum + payment.principalPaid, 0)).toBeCloseTo(10_000, 2);
    expect(issuance.status).toBe('redeemed');

    // 重放同 tick 结算：不得出现第二笔到期本金。
    city.government!.settledTicks = city.government!.settledTicks.filter((tick) => tick !== 36);
    settleCityGovernmentDebt(world, city, NO_AI, []);
    const replayed = paymentsOf(world).filter((payment) => payment.issuanceId === issuance.id);
    expect(replayed).toHaveLength(payments.length);
  });
});

describe('AC-F09 有 CEO 分股', () => {
  it('政府股份全部转给现任 CEO；发行总量不变；不转给公司', () => {
    const world = newWorld();
    const city = mainCity(world);
    const company = world.companies[0]!;
    createShareStructure(world, company, {
      votingShares: 100,
      nonVotingShares: 0,
      votingHolders: [{ holder: { type: 'city', id: city.id }, shares: 100 }],
      tick: 0,
    });
    const control = world.governance.controls.find((entry) => entry.companyId === company.id);
    if (!control) throw new Error('缺少经营者记录');
    control.operator = { type: 'player', id: 'player' };

    const before = companyHolders(world, company.id);
    expect(before.find((entry) => holderKey(entry.holder) === 'player:player')).toBeUndefined();

    const result = distributeBankruptGovernmentShares(world, city, CONFIG);
    expect(result.custody).toBe(false);
    const holders = companyHolders(world, company.id);
    const playerEntry = holders.find((entry) => holderKey(entry.holder) === 'player:player');
    expect(playerEntry?.votingShares).toBeCloseTo(100, 2);
    expect(holders.find((entry) => entry.holder.type === 'city' && entry.holder.id === city.id)).toBeUndefined();
    expect(holders.find((entry) => entry.holder.type === 'company')).toBeUndefined();
    expect(holders.reduce((sum, entry) => sum + entry.votingShares, 0)).toBeCloseTo(100, 2);
  });
});

describe('AC-F10 无 CEO 分股', () => {
  it('除破产政府外现有股东按主体数量平分（非按比例），余数按固定顺序', () => {
    const world = newWorld();
    const city = mainCity(world);
    const company = world.companies[0]!;
    const groupA = world.investors[0]!;
    const groupB = world.investors[1]!;
    createShareStructure(world, company, {
      votingShares: 100,
      nonVotingShares: 0,
      votingHolders: [
        { holder: { type: 'city', id: city.id }, shares: 41 },
        { holder: { type: 'investorGroup', id: groupA.id }, shares: 30 },
        { holder: { type: 'investorGroup', id: groupB.id }, shares: 29 },
      ],
      tick: 0,
    });
    const control = world.governance.controls.find((entry) => entry.companyId === company.id);
    if (control) control.operator = 'management';

    const result = distributeBankruptGovernmentShares(world, city, CONFIG);
    expect(result.custody).toBe(false);
    const holders = companyHolders(world, company.id);
    // 41 股按主体数量平分（非原持股比例 30:29）；v1.1 起股份必须为整数，
    // 余数按固定顺序分配，因此为 51 / 49（仍满足主体均分意图）。
    const a = holders.find((entry) => holderKey(entry.holder) === `investorGroup:${groupA.id}`);
    const b = holders.find((entry) => holderKey(entry.holder) === `investorGroup:${groupB.id}`);
    expect(a?.votingShares).toBe(51);
    expect(b?.votingShares).toBe(49);
    expect(holders.reduce((sum, entry) => sum + entry.votingShares, 0)).toBeCloseTo(100, 2);
  });
});

describe('AC-F11 无股东兜底', () => {
  it('无 CEO 且无其他股东时转无表决权托管，不销毁不增发', () => {
    const world = newWorld();
    const city = mainCity(world);
    const company = world.companies[0]!;
    createShareStructure(world, company, {
      votingShares: 100,
      nonVotingShares: 0,
      votingHolders: [{ holder: { type: 'city', id: city.id }, shares: 100 }],
      tick: 0,
    });
    const control = world.governance.controls.find((entry) => entry.companyId === company.id);
    if (control) control.operator = 'management';

    const result = distributeBankruptGovernmentShares(world, city, CONFIG);
    expect(result.custody).toBe(true);
    const holders = companyHolders(world, company.id);
    const trust = holders.find((entry) => entry.holder.type === 'trust');
    expect(trust?.holder.id).toBe(`trust-${company.id}`);
    expect(trust?.votingShares).toBeCloseTo(100, 2);
    expect(holders.reduce((sum, entry) => sum + entry.votingShares, 0)).toBeCloseTo(100, 2);
    expect(holders.find((entry) => entry.holder.type === 'company')).toBeUndefined();
  });
});

describe('AC-F12 读档重放幂等', () => {
  it('破产月存档→读档→再结算：不重复破产、不重复选举、不重复兑付', () => {
    const { world, city } = bankruptScenario();
    const government = city.government!;
    const paymentsBefore = paymentsOf(world).length;
    const recordsBefore = government.records.length;
    const electionsBefore = world.politics?.elections?.length ?? 0;

    const parsed = parseSave(serializeSave(world, '2026-11-02T00:00:00.000Z'));
    expect(parsed.ok).toBe(true);
    const restored = parsed.world!;
    const restoredCity = restored.cities.find((entry) => entry.id === city.id)!;
    expect(restoredCity.government!.bankruptcy.status).toBe('bankrupt');
    expect(restoredCity.government!.records).toHaveLength(recordsBefore);

    // 读档后同 tick 再结算：settledTicks 已持久化 → 直接跳过。
    settleCityGovernmentDebt(restored, restoredCity, NO_AI, []);
    expect(restoredCity.government!.records).toHaveLength(recordsBefore);
    expect((restored.politics?.elections?.length ?? 0)).toBe(electionsBefore);
    expect((restored.bonds?.payments ?? []).length).toBe(paymentsBefore);
  });
});

describe('AC-F13 破产前后状态一致', () => {
  it('破产后继续结算：无重复计债、财政有限、后续月份可正常运转', () => {
    const { world, city } = bankruptScenario();
    const afterBankruptcyDebt = computeGovernmentDebtSummary(world, city, NO_AI, 1).totalDebt;
    expect(afterBankruptcyDebt).toBeCloseTo(0, 2);

    for (const tick of [2, 3]) {
      world.time.tick = tick;
      const result = settleCityGovernmentDebt(world, city, NO_AI, []);
      expect(result.problems).toEqual([]);
      expect(Number.isFinite(city.treasury)).toBe(true);
      expect(city.government!.lastDebt!.debtRatio).toBeLessThanOrEqual(1);
      expect(city.government!.records).toHaveLength(1);
    }
    const problems = checkInvariants(world);
    expect(problems).toEqual([]);
  });
});

describe('AC-F14 风险预警分级', () => {
  it('<50% 正常、50–75% 关注、75–100% 高风险、≥100% 破产', () => {
    const world = newWorld();
    const city = mainCity(world);
    city.treasury = 0;
    const borrowed = borrowForGovernment(world, city, CONFIG, 20_000, 0, []);
    expect(borrowed.ok).toBe(true);

    const setRatio = (ratio: number) => {
      // 判定分母 = 12 × monthly；令 totalDebt / judgement = ratio（债务约 2 万）。
      const totalDebt = computeGovernmentDebtSummary(world, city, CONFIG, 0).totalDebt;
      const judgement = totalDebt / ratio;
      const monthly = judgement / 12;
      setGdpWindow(world, monthly);
      return computeGovernmentDebtSummary(world, city, CONFIG, 0);
    };

    expect(setRatio(0.4).riskLevel).toBe('normal');
    expect(setRatio(0.6).riskLevel).toBe('watch');
    expect(setRatio(0.9).riskLevel).toBe('high');
    expect(setRatio(1).riskLevel).toBe('bankrupt');
  });
});
