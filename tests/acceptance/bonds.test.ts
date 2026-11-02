// 验收 B 组：政府债券（AC-B01–B14）。
// 只调用 `src/simulation/government/bonds.ts` 的冻结签名 + 公开世界状态，不复制实现细节。
import { describe, expect, it } from 'vitest';
import { DEMO_CONFIG } from '../../src/data/config';
import { checkInvariants } from '../../src/simulation/core/invariants';
import type { BondHolder, City, WorldState } from '../../src/simulation/contracts/types';
import {
  accrueBondInterest,
  bondHolderAvailableCash,
  bondSubscriptionOrder,
  closeGovernmentBondSubscription,
  issueGovernmentBond,
  payBondCoupon,
  settleBondBankruptcyRedemption,
  settleBondMaturity,
  subscribeGovernmentBond,
} from '../../src/simulation/government/bonds';
import { cityById, newWorld } from './helpers';

const CONFIG = DEMO_CONFIG;
const MARKET = CONFIG.government.bondMarket;
const FACE = MARKET.faceValue;
const CITY_ID = 'lanport';
const PLAYER: BondHolder = { kind: 'player', id: 'player' };

function setup(playerCash = 0, tick = 0): { world: WorldState; city: City } {
  const world = newWorld(0);
  world.time.tick = tick;
  world.player.cash = playerCash;
  return { world, city: cityById(world, CITY_ID) };
}

function issue(world: WorldState, city: City, planUnits: number, tick = 0) {
  return issueGovernmentBond(world, city, CONFIG, planUnits, tick);
}

/** 建立一批“玩家全额认购并已关闭窗口”的债券。 */
function soldIssue(world: WorldState, city: City, units: number, tick = 0) {
  world.player.cash = units * FACE;
  const issued = issue(world, city, units, tick);
  expect(issued.ok, issued.error).toBe(true);
  const issuance = issued.issuance!;
  const subscribed = subscribeGovernmentBond(world, CONFIG, issuance.id, PLAYER, units, tick);
  expect(subscribed.units).toBe(units);
  expect(closeGovernmentBondSubscription(world, CONFIG, issuance.id, tick).ok).toBe(true);
  return issuance;
}

function accrueUntil(world: WorldState, city: City, from: number, to: number): void {
  for (let tick = from; tick <= to; tick += 1) {
    world.time.tick = tick;
    accrueBondInterest(world, city, CONFIG, tick);
  }
  world.time.tick = to;
}

function holdingsOf(world: WorldState, issuanceId: string) {
  return (world.bonds?.holdings ?? []).filter((holding) => holding.issuanceId === issuanceId);
}

function outstandingBondPrincipal(world: WorldState): number {
  return (world.bonds?.issuances ?? [])
    .filter((issuance) => issuance.status !== 'redeemed')
    .reduce((sum, issuance) => sum + issuance.principal, 0);
}

function governmentLoanOutstanding(city: City): number {
  return city.government.loans
    .filter((loan) => loan.status === 'active')
    .reduce((sum, loan) => sum + loan.outstanding, 0);
}

describe('AC-B01 面额与整数份', () => {
  it('面额 1,000/份；发行计划与认购份数必须为正整数，非整数直接拒绝且账目不变', () => {
    expect(FACE).toBe(1_000);
    const { world, city } = setup(10_000);
    const before = { treasury: city.treasury, issuances: world.bonds?.issuances.length ?? 0 };

    for (const bad of [0, -1, 1.5, Number.NaN]) {
      const result = issue(world, city, bad);
      expect(result.ok, `planUnits=${bad} 应被拒绝`).toBe(false);
    }
    expect(world.bonds?.issuances.length ?? 0).toBe(before.issuances);
    expect(city.treasury).toBe(before.treasury);

    // 1 份起，成交金额恰为面额。
    const one = issue(world, city, 1);
    expect(one.ok).toBe(true);
    const sub = subscribeGovernmentBond(world, CONFIG, one.issuance!.id, PLAYER, 1, 0);
    expect(sub.units).toBe(1);
    expect(sub.principal).toBe(FACE);
    expect(world.player.cash).toBe(10_000 - FACE);

    // 非整数份认购：不部分入账。
    const cashBefore = world.player.cash;
    const fractional = subscribeGovernmentBond(world, CONFIG, one.issuance!.id, PLAYER, 0.5, 0);
    expect(fractional.ok).toBe(false);
    expect(fractional.units).toBe(0);
    expect(world.player.cash).toBe(cashBefore);
    expect(checkInvariants(world)).toEqual([]);
  });
});

describe('AC-B02 计划与实际成交分账', () => {
  it('计划 100 份售 65 份 → 本金 65,000；未售 35 份不形成债务、不入账', () => {
    const { world, city } = setup(65_000);
    city.treasury = 0;
    const issuance = issue(world, city, 100).issuance!;
    expect(issuance.planUnits).toBe(100);
    expect(issuance.soldUnits).toBe(0);

    const sub = subscribeGovernmentBond(world, CONFIG, issuance.id, PLAYER, 65, 0);
    expect(sub.units).toBe(65);
    expect(sub.principal).toBe(65_000);
    expect(issuance.principal).toBe(65_000);
    expect(issuance.soldUnits).toBe(65);
    expect(city.treasury).toBe(65_000);

    expect(closeGovernmentBondSubscription(world, CONFIG, issuance.id, 0).ok).toBe(true);
    expect(issuance.unsoldUnits).toBe(35);
    // 未售出份数不形成债务：在外本金 = 成交本金。
    expect(outstandingBondPrincipal(world)).toBe(65_000);
    expect(issuance.status).toBe('active');
    expect(checkInvariants(world)).toEqual([]);
  });
});

describe('AC-B03 部分成交资金一次入账', () => {
  it('政府融资额 = 成交本金，且关闭窗口/重复关闭/关闭后再认购都不再入账', () => {
    const { world, city } = setup(65_000);
    city.treasury = 1_000;
    const issuance = issue(world, city, 100).issuance!;
    subscribeGovernmentBond(world, CONFIG, issuance.id, PLAYER, 65, 0);
    expect(city.treasury).toBe(1_000 + 65_000);

    expect(closeGovernmentBondSubscription(world, CONFIG, issuance.id, 0).ok).toBe(true);
    expect(closeGovernmentBondSubscription(world, CONFIG, issuance.id, 0).ok).toBe(true);
    expect(city.treasury).toBe(66_000);

    const after = subscribeGovernmentBond(world, CONFIG, issuance.id, PLAYER, 1, 0);
    expect(after.units).toBe(0);
    expect(city.treasury).toBe(66_000);
    expect(world.player.cash).toBe(0);
  });
});

describe('AC-B04 多主体认购归属', () => {
  it('玩家 / 居民投资实体 / 企业各自扣款，持债记录归属正确，利息按持有人计提', () => {
    const { world, city } = setup(2_000);
    const investor = world.investors[0]!;
    const company = world.companies.find((entry) => entry.cityId === city.id)!;
    investor.cash = 3_000;
    company.cash = 1_000;
    company.previousMonth.wagesPaid = 0;
    company.previousMonth.interestPaid = 0;
    company.lastMonth.wageArrears = 0;

    const issuance = issue(world, city, 10).issuance!;
    expect(
      subscribeGovernmentBond(world, CONFIG, issuance.id, PLAYER, 2, 0).units,
    ).toBe(2);
    expect(
      subscribeGovernmentBond(
        world,
        CONFIG,
        issuance.id,
        { kind: 'investorGroup', id: investor.id },
        3,
        0,
      ).units,
    ).toBe(3);
    expect(
      subscribeGovernmentBond(
        world,
        CONFIG,
        issuance.id,
        { kind: 'company', id: company.id },
        1,
        0,
      ).units,
    ).toBe(1);
    closeGovernmentBondSubscription(world, CONFIG, issuance.id, 0);

    expect(world.player.cash).toBe(0);
    expect(investor.cash).toBe(0);
    expect(company.cash).toBe(0);
    const holdings = holdingsOf(world, issuance.id);
    expect(holdings).toHaveLength(3);
    const unitsByKind = new Map(holdings.map((holding) => [holding.holder.kind, holding.units]));
    expect(unitsByKind.get('player')).toBe(2);
    expect(unitsByKind.get('investorGroup')).toBe(3);
    expect(unitsByKind.get('company')).toBe(1);
    expect(issuance.soldUnits).toBe(6);
    expect(issuance.principal).toBe(6_000);

    // 12 个月后利息按各自本金计提：2,000/3,000/1,000 × 4%。
    accrueUntil(world, city, 1, 12);
    const accrued = new Map(
      holdingsOf(world, issuance.id).map((holding) => [holding.holder.kind, holding.accruedInterest]),
    );
    expect(accrued.get('player')).toBeCloseTo(80, 6);
    expect(accrued.get('investorGroup')).toBeCloseTo(120, 6);
    expect(accrued.get('company')).toBeCloseTo(40, 6);
    expect(issuance.accruedInterest).toBeCloseTo(240, 6);
    expect(checkInvariants(world)).toEqual([]);
  });
});

describe('AC-B05 跨城购买', () => {
  it('A 城主体买 B 城债券：扣 A 主体资金、记 B 城债务，A 城财政不变', () => {
    const world = newWorld(0);
    const a = cityById(world, CITY_ID);
    const b = cityById(world, 'ironvale');
    const group = world.investors[0]!;
    group.cash = 5_000;
    b.treasury = 0;
    const aTreasuryBefore = a.treasury;

    const issuance = issue(world, b, 10).issuance!;
    const sub = subscribeGovernmentBond(
      world,
      CONFIG,
      issuance.id,
      { kind: 'investorGroup', id: group.id },
      2,
      0,
    );
    expect(sub.units).toBe(2);
    expect(sub.principal).toBe(2_000);
    expect(group.cash).toBe(3_000);
    expect(b.treasury).toBe(2_000);
    expect(a.treasury).toBe(aTreasuryBefore);
    const holding = holdingsOf(world, issuance.id)[0]!;
    expect(holding.cityId).toBe(b.id);
    expect(holding.holder).toEqual({ kind: 'investorGroup', id: group.id });
    expect(checkInvariants(world)).toEqual([]);
  });
});

describe('AC-B06 资金不足不成交', () => {
  it('可用资金 < 1 份面额 → 成交 0 份，不扣款、不建持债、不产生本金', () => {
    const { world, city } = setup(999);
    city.treasury = 0;
    const issuance = issue(world, city, 10).issuance!;
    const result = subscribeGovernmentBond(world, CONFIG, issuance.id, PLAYER, 5, 0);
    expect(result.units).toBe(0);
    expect(world.player.cash).toBe(999);
    expect(city.treasury).toBe(0);
    expect(issuance.soldUnits).toBe(0);
    expect(issuance.principal).toBe(0);
    expect(holdingsOf(world, issuance.id)).toHaveLength(0);
    expect(checkInvariants(world)).toEqual([]);
  });
});

describe('AC-B07 无重复扣款', () => {
  it('窗口关闭后重复认购不扣款；重复关闭不重复入账', () => {
    const { world, city } = setup(3_000);
    city.treasury = 0;
    const issuance = issue(world, city, 10).issuance!;
    subscribeGovernmentBond(world, CONFIG, issuance.id, PLAYER, 2, 0);
    expect(world.player.cash).toBe(1_000);
    closeGovernmentBondSubscription(world, CONFIG, issuance.id, 0);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const replay = subscribeGovernmentBond(world, CONFIG, issuance.id, PLAYER, 2, 0);
      expect(replay.units).toBe(0);
      closeGovernmentBondSubscription(world, CONFIG, issuance.id, 0);
    }
    expect(world.player.cash).toBe(1_000);
    expect(city.treasury).toBe(2_000);
    expect(issuance.soldUnits).toBe(2);
    expect(holdingsOf(world, issuance.id)).toHaveLength(1);
    expect(holdingsOf(world, issuance.id)[0]!.units).toBe(2);
  });
});

describe('AC-B08 无超额发行', () => {
  it('累计成交 ≤ 计划份数；超买按剩余可售截断；计划 0 不得发行', () => {
    const { world, city } = setup(100 * FACE);
    expect(issue(world, city, 0).ok).toBe(false);
    const issuance = issue(world, city, 10).issuance!;
    const sub = subscribeGovernmentBond(world, CONFIG, issuance.id, PLAYER, 100, 0);
    expect(sub.units).toBe(10);
    expect(sub.principal).toBe(10 * FACE);
    expect(issuance.soldUnits).toBe(10);
    expect(issuance.principal).toBe(10 * FACE);
    expect(world.player.cash).toBe(90 * FACE);
    // 已售罄：再买 0 份，不再扣款。
    const more = subscribeGovernmentBond(world, CONFIG, issuance.id, PLAYER, 1, 0);
    expect(more.units).toBe(0);
    expect(world.player.cash).toBe(90 * FACE);
    expect(outstandingBondPrincipal(world)).toBe(10 * FACE);
    expect(checkInvariants(world)).toEqual([]);
  });
});

describe('AC-B09 确定性排序', () => {
  it('同一世界两次展开的认购顺序完全一致，且顺序遵循配置白名单', () => {
    const { world, city } = setup(0);
    const issuance = issue(world, city, 10).issuance!;
    const first = bondSubscriptionOrder(world, CONFIG, issuance.id);
    const second = bondSubscriptionOrder(world, CONFIG, issuance.id);
    expect(first).toEqual(second);
    expect(first[0]).toEqual(PLAYER);
    expect(first).toHaveLength(1 + world.investors.length + world.companies.length);
    // 配置中不允许银行：认购顺序里只有三类合法主体。
    const kinds = new Set(first.map((holder) => holder.kind));
    expect([...kinds].sort()).toEqual(['company', 'investorGroup', 'player']);
  });
});

describe('AC-B10 36 个月到期', () => {
  it('第 35 月不兑付；第 36 月足额兑付本金 + 3 期票息', () => {
    const { world, city } = setup(0);
    const issuance = soldIssue(world, city, 10, 0);
    expect(issuance.maturityTick).toBe(MARKET.termMonths);
    accrueUntil(world, city, 1, 35);
    city.treasury = 100_000;

    const early = settleBondMaturity(world, city, CONFIG, issuance.id, 35, []);
    expect(early.payments).toHaveLength(0);
    expect(early.principalPaid).toBe(0);
    expect(issuance.status).toBe('active');

    world.time.tick = 36;
    accrueBondInterest(world, city, CONFIG, 36);
    const maturity = settleBondMaturity(world, city, CONFIG, issuance.id, 36, []);
    expect(maturity.ok).toBe(true);
    expect(maturity.principalPaid).toBe(10 * FACE);
    expect(maturity.interestPaid).toBeCloseTo((10 * FACE * MARKET.couponRateAnnual * 36) / 12, 2);
    expect(maturity.advancedByBank).toBe(0);
    expect(issuance.status).toBe('redeemed');
    expect(issuance.redemptionReason).toBe('maturity');
    expect(issuance.couponsPaid).toBe(3);
    expect(holdingsOf(world, issuance.id)[0]!.status).toBe('redeemed');
    // 财政：100,000 − 10,000 − 1,200。
    expect(city.treasury).toBeCloseTo(100_000 - 10_000 - 1_200, 2);
    expect(checkInvariants(world)).toEqual([]);
  });
});

describe('AC-B11 利息计付', () => {
  it('每满 12 个月付一次；未满周期不计；同月重复计提不重复计息', () => {
    const { world, city } = setup(0);
    const issuance = soldIssue(world, city, 10, 0);
    city.treasury = 10_000;
    accrueUntil(world, city, 1, 11);
    // 每期按 round2 累计（11 个月 = 10,000×4%×11/12 = 366.67）。
    expect(issuance.accruedInterest).toBeCloseTo(366.67, 2);

    // 第 11 月未满 12 个月：不付息。
    const early = payBondCoupon(world, city, CONFIG, issuance.id, 11, []);
    expect(early.interestPaid).toBe(0);
    expect(issuance.couponsPaid).toBe(0);

    // 第 12 月：付第一期 400。
    world.time.tick = 12;
    accrueBondInterest(world, city, CONFIG, 12);
    const first = payBondCoupon(world, city, CONFIG, issuance.id, 12, []);
    expect(first.interestPaid).toBeCloseTo(400, 6);
    expect(issuance.couponsPaid).toBe(1);
    expect(issuance.accruedInterest).toBe(0);

    // 同 tick 重复计提：不得把已付利息重新计回来。
    accrueBondInterest(world, city, CONFIG, 12);
    expect(issuance.accruedInterest).toBe(0);
    const replay = payBondCoupon(world, city, CONFIG, issuance.id, 12, []);
    expect(replay.payments).toHaveLength(0);
    expect(city.treasury).toBe(9_600);
    expect(checkInvariants(world)).toEqual([]);
  });
});

describe('AC-B12 银行无条件垫付', () => {
  it('财政为 0 时到期仍全额兑付：持有人收款完整，垫付转为政府贷款并计入负债', () => {
    const { world, city } = setup(0);
    const issuance = soldIssue(world, city, 10, 0);
    accrueUntil(world, city, 1, 36);
    city.treasury = 0;
    const playerBefore = world.player.cash; // 认购时已扣回 0，收兑付前后对比。
    const expectedInterest = (10 * FACE * 0.04 * 36) / 12;

    const maturity = settleBondMaturity(world, city, CONFIG, issuance.id, 36, []);
    expect(maturity.ok).toBe(true);
    expect(maturity.principalPaid).toBe(10_000);
    expect(maturity.interestPaid).toBeCloseTo(expectedInterest, 2);
    expect(maturity.advancedByBank).toBeCloseTo(10_000 + expectedInterest, 2);
    expect(world.player.cash).toBeCloseTo(playerBefore + 10_000 + expectedInterest, 2);

    const advanceLoans = city.government.loans.filter((loan) => loan.purpose === 'bondAdvance');
    expect(advanceLoans).toHaveLength(1);
    expect(advanceLoans[0]!.principal).toBeCloseTo(10_000 + expectedInterest, 2);
    expect(advanceLoans[0]!.bondIssuanceId).toBe(issuance.id);
    expect(city.government.advances).toHaveLength(1);
    expect(city.government.advances[0]!.purpose).toBe('maturity');
    expect(city.treasury).toBe(0);
    expect(checkInvariants(world)).toEqual([]);
  });
});

describe('AC-B13 垫付不受普通授信限制', () => {
  it('政府已有大额普通贷款、财政为负时，到期垫付仍成功且金额完整', () => {
    const { world, city } = setup(0);
    const issuance = soldIssue(world, city, 10, 0);
    accrueUntil(world, city, 1, 36);
    city.treasury = -5_000_000;
    // 伪造一笔大额普通政府贷款（已达任何合理授信上限），验证垫付不查授信。
    city.government.loans.push({
      id: 'loan-existing-1',
      cityId: city.id,
      purpose: 'government',
      principal: 500_000_000,
      outstanding: 500_000_000,
      monthlyPrincipal: 20_000_000,
      rateMonthly: 0.005,
      termMonths: 24,
      startTick: 1,
      nextDueTick: 2,
      paidPrincipal: 0,
      paidInterest: 0,
      accruedInterest: 0,
      arrearsPrincipal: 0,
      arrearsInterest: 0,
      missedPayments: 0,
      status: 'active',
      payments: [],
      bondIssuanceId: null,
      note: '验收测试用既有大额贷款',
    });

    const maturity = settleBondMaturity(world, city, CONFIG, issuance.id, 36, []);
    expect(maturity.ok).toBe(true);
    expect(maturity.principalPaid).toBe(10_000);
    expect(maturity.advancedByBank).toBeCloseTo(10_000 + 1_200, 2);
    const advanceLoans = city.government.loans.filter((loan) => loan.purpose === 'bondAdvance');
    expect(advanceLoans).toHaveLength(1);
    expect(issuance.status).toBe('redeemed');
  });
});

describe('AC-B14 债券总账守恒', () => {
  /** 守恒口径：可支配货币净额 = 持币人现金 + 财政余额 − 政府贷款未偿（垫付创造的负债）。 */
  function netMoney(world: WorldState, city: City): number {
    return world.player.cash + city.treasury - governmentLoanOutstanding(city);
  }

  it('认购不创造货币；到期足额由财政支付时守恒；不足部分垫付 = 贷款新增', () => {
    const { world, city } = setup(20_000);
    const before = netMoney(world, city);
    const issued = issue(world, city, 10);
    expect(issued.ok, issued.error).toBe(true);
    const issuance = issued.issuance!;
    expect(subscribeGovernmentBond(world, CONFIG, issuance.id, PLAYER, 10, 0).units).toBe(10);
    closeGovernmentBondSubscription(world, CONFIG, issuance.id, 0);
    // 认购：现金 → 财政，货币净额不变。
    expect(world.player.cash).toBe(10_000);
    expect(city.treasury).toBeGreaterThan(10_000);
    expect(netMoney(world, city)).toBeCloseTo(before, 2);

    accrueUntil(world, city, 1, 36);
    const beforeMaturity = netMoney(world, city);
    const treasuryBefore = city.treasury;
    const maturity = settleBondMaturity(world, city, CONFIG, issuance.id, 36, []);
    expect(maturity.ok).toBe(true);
    // 财政充足（开局 6,000 万）：本金 10,000 + 利息 1,200 全部由财政支付，不产生垫付。
    expect(maturity.principalPaid).toBe(10_000);
    expect(maturity.interestPaid).toBeCloseTo(1_200, 2);
    expect(maturity.advancedByBank).toBe(0);
    expect(city.treasury).toBeCloseTo(treasuryBefore - 11_200, 2);
    // 守恒：财政支出 11,200 必须变成持有人现金 11,200。
    expect(netMoney(world, city)).toBeCloseTo(beforeMaturity, 2);
    expect(world.player.cash).toBeCloseTo(11_200, 2);
    expect(outstandingBondPrincipal(world)).toBe(0);
    expect(checkInvariants(world)).toEqual([]);
  });

  it('破产兑付：银行垫付 = 未到期本金 + 已计提未付利息，每笔只付一次、货币净额守恒', () => {
    const { world, city } = setup(0);
    const issuance = soldIssue(world, city, 10, 0);
    const before = netMoney(world, city);
    accrueUntil(world, city, 1, 20);
    const redemption = settleBondBankruptcyRedemption(world, city, CONFIG, 20, []);
    expect(redemption.ok).toBe(true);
    const expectedInterest = (10 * FACE * 0.04 * 20) / 12;
    expect(redemption.principalPaid).toBe(10_000);
    expect(redemption.interestPaid).toBeCloseTo(expectedInterest, 2);
    expect(redemption.advancedByBank).toBeCloseTo(10_000 + expectedInterest, 2);
    expect(netMoney(world, city)).toBeCloseTo(before, 2);

    const replay = settleBondBankruptcyRedemption(world, city, CONFIG, 20, []);
    expect(replay.payments).toHaveLength(0);
    expect(city.government.loans).toHaveLength(1);
    expect(issuance.status).toBe('redeemed');
    expect(checkInvariants(world)).toEqual([]);
  });
});
