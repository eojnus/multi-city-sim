import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation/core/simulation';
import { DEMO_CONFIG } from '../src/data/config';
import type { BondHolder, WorldState } from '../src/simulation/contracts/types';
import { checkInvariants } from '../src/simulation/core/invariants';
import { parseSave, serializeSave } from '../src/simulation/core/save';
import { round2 } from '../src/simulation/core/math';
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
} from '../src/simulation/government/bonds';

const PLAYER: BondHolder = { kind: 'player', id: 'player' };
const CONFIG = DEMO_CONFIG;

function newWorld(): WorldState {
  return Simulation.create().state;
}

function cityAt(world: WorldState, index: number) {
  const city = world.cities[index];
  if (!city) throw new Error(`缺少第 ${index} 个城市`);
  return city;
}

function mainCity(world: WorldState) {
  return cityAt(world, 0);
}

function investorAt(world: WorldState, index: number) {
  const group = world.investors[index];
  if (!group) throw new Error(`缺少第 ${index} 个居民投资实体`);
  return group;
}

function holdingsOf(world: WorldState, issuanceId: string) {
  return (world.bonds?.holdings ?? []).filter((holding) => holding.issuanceId === issuanceId);
}

/** 建立一期已售罄 10 份的债券：玩家用 10,000 现金买入，发行城财政收到 10,000。 */
function setupSoldIssue(world: WorldState, tick = 0) {
  const city = mainCity(world);
  world.time.tick = tick;
  world.player.cash = 10_000;
  const issued = issueGovernmentBond(world, city, CONFIG, 10, tick);
  expect(issued.ok).toBe(true);
  const issuance = issued.issuance!;
  const subscribed = subscribeGovernmentBond(world, CONFIG, issuance.id, PLAYER, 10, tick);
  expect(subscribed.ok).toBe(true);
  expect(subscribed.units).toBe(10);
  expect(closeGovernmentBondSubscription(world, CONFIG, issuance.id, tick).ok).toBe(true);
  return { city, issuance };
}

function accrueTo(world: WorldState, fromTick: number, toTick: number): void {
  const city = mainCity(world);
  for (let tick = fromTick; tick <= toTick; tick += 1) {
    world.time.tick = tick;
    accrueBondInterest(world, city, CONFIG, tick);
  }
  world.time.tick = toTick;
}

describe('政府债券：发行与整数份认购', () => {
  it('发行份数必须为正整数且不超过单次上限，同城同 tick 只能一期', () => {
    const world = newWorld();
    const city = mainCity(world);
    expect(issueGovernmentBond(world, city, CONFIG, 0, 0).ok).toBe(false);
    expect(issueGovernmentBond(world, city, CONFIG, -3, 0).ok).toBe(false);
    expect(issueGovernmentBond(world, city, CONFIG, 1.5, 0).ok).toBe(false);
    expect(
      issueGovernmentBond(
        world,
        city,
        CONFIG,
        CONFIG.government.bondMarket.maxPlanUnitsPerIssue + 1,
        0,
      ).ok,
    ).toBe(false);

    const first = issueGovernmentBond(world, city, CONFIG, 10, 0);
    expect(first.ok).toBe(true);
    expect(first.issuance).toMatchObject({
      planUnits: 10,
      soldUnits: 0,
      unsoldUnits: 10,
      principal: 0,
      status: 'offering',
      maturityTick: CONFIG.government.bondMarket.termMonths,
    });
    // 同城同 tick 第二期被拒。
    expect(issueGovernmentBond(world, city, CONFIG, 5, 0).ok).toBe(false);
    // 间隔满足 minMonthsBetweenIssues 后可再发。
    expect(issueGovernmentBond(world, city, CONFIG, 5, 1).ok).toBe(true);
    expect(checkInvariants(world)).toEqual([]);
  });

  it('整数份认购：资金进入发行城财政，超买只按可成交份数部分成交，0 份不扣款', () => {
    const world = newWorld();
    const city = mainCity(world);
    city.treasury = 0;
    world.player.cash = 10_000;
    const issuance = issueGovernmentBond(world, city, CONFIG, 10, 5).issuance!;

    const partial = subscribeGovernmentBond(world, CONFIG, issuance.id, PLAYER, 3, 5);
    expect(partial.ok).toBe(true);
    expect(partial.units).toBe(3);
    expect(partial.principal).toBe(3_000);
    expect(world.player.cash).toBe(7_000);
    expect(city.treasury).toBe(3_000);
    expect(issuance.soldUnits).toBe(3);
    expect(issuance.principal).toBe(3_000);
    expect(issuance.unsoldUnits).toBe(7);

    // 同一买家再认购并入同一持债记录。
    const again = subscribeGovernmentBond(world, CONFIG, issuance.id, PLAYER, 2, 5);
    expect(again.units).toBe(2);
    expect(holdingsOf(world, issuance.id)).toHaveLength(1);
    expect(holdingsOf(world, issuance.id)[0]!.units).toBe(5);

    // 现金只剩 5,000，请求 100 份只能成交 5 份；超出剩余可售/资金的份数不扣款。
    const oversell = subscribeGovernmentBond(world, CONFIG, issuance.id, PLAYER, 100, 5);
    expect(oversell.ok).toBe(true);
    expect(oversell.units).toBe(5);
    expect(world.player.cash).toBe(0);
    expect(issuance.soldUnits).toBe(10);
    expect(checkInvariants(world)).toEqual([]);

    // 资金为 0 时 0 份成交、不建持债、不扣款。
    const zero = subscribeGovernmentBond(world, CONFIG, issuance.id, PLAYER, 1, 5);
    expect(zero.ok).toBe(true);
    expect(zero.units).toBe(0);
    expect(world.player.cash).toBe(0);
  });

  it('跨城认购：居民投资实体可在任意城市买入，资金只进发行城财政', () => {
    const world = newWorld();
    const sellerCity = mainCity(world);
    const otherCity = cityAt(world, 1);
    sellerCity.treasury = 0;
    const otherTreasuryBefore = otherCity.treasury;
    const group = investorAt(world, 0);
    group.cash = 5_000;
    const issuance = issueGovernmentBond(world, sellerCity, CONFIG, 10, 0).issuance!;

    const result = subscribeGovernmentBond(
      world,
      CONFIG,
      issuance.id,
      { kind: 'investorGroup', id: group.id },
      2,
      0,
    );
    expect(result.ok).toBe(true);
    expect(result.units).toBe(2);
    expect(group.cash).toBe(3_000);
    expect(sellerCity.treasury).toBe(2_000);
    expect(otherCity.treasury).toBe(otherTreasuryBefore);
    expect(holdingsOf(world, issuance.id)[0]!.cityId).toBe(sellerCity.id);
    expect(checkInvariants(world)).toEqual([]);
  });

  it('企业购债保留工资与利息，且禁止贷款购债；欠薪企业禁止认购', () => {
    const world = newWorld();
    const city = mainCity(world);
    const market = CONFIG.government.bondMarket;
    const company = world.companies.find((entry) => entry.cityId === city.id);
    if (!company) throw new Error('缺少测试企业');
    const issuance = issueGovernmentBond(world, city, CONFIG, 10, 0).issuance!;

    const reserve = CONFIG.government.companyPurchaseReserve;
    company.cash = 3_000 + 1_000 * reserve.wageMonths + 500 * reserve.interestMonths;
    company.previousMonth.wagesPaid = 1_000;
    company.previousMonth.interestPaid = 500;
    company.lastMonth.wageArrears = 0;
    const available = bondHolderAvailableCash(world, CONFIG, { kind: 'company', id: company.id });
    expect(available).toBe(3_000);

    const bought = subscribeGovernmentBond(
      world,
      CONFIG,
      issuance.id,
      { kind: 'company', id: company.id },
      1,
      0,
    );
    expect(bought.units).toBe(1);
    // 保留 3,000 可支配现金不动，额外买入 1 份 1,000。
    expect(company.cash).toBe(3_000 + 1_000 * reserve.wageMonths + 500 * reserve.interestMonths - 1_000);

    // 欠薪企业禁止认购，且不扣款。
    const cashBefore = company.cash;
    company.lastMonth.wageArrears = 100;
    const blocked = subscribeGovernmentBond(
      world,
      CONFIG,
      issuance.id,
      { kind: 'company', id: company.id },
      1,
      0,
    );
    expect(blocked.ok).toBe(false);
    expect(blocked.units).toBe(0);
    expect(company.cash).toBe(cashBefore);

    // 现金为 0 的企业不会因购债触发贷款：成交 0 份，银行贷款笔数不变。
    company.lastMonth.wageArrears = 0;
    company.cash = 0;
    const loanCountBefore = world.banking?.loans.length ?? 0;
    const noCash = subscribeGovernmentBond(
      world,
      CONFIG,
      issuance.id,
      { kind: 'company', id: company.id },
      1,
      0,
    );
    expect(noCash.ok).toBe(true);
    expect(noCash.units).toBe(0);
    expect(world.banking?.loans.length ?? 0).toBe(loanCountBefore);
    expect(market.allowBankSubscription).toBe(false);
    expect(checkInvariants(world)).toEqual([]);
  });

  it('认购顺序按 config 展开为玩家 → 居民投资实体 → 企业，且不含银行', () => {
    const world = newWorld();
    const city = mainCity(world);
    const issuance = issueGovernmentBond(world, city, CONFIG, 10, 0).issuance!;
    const order = bondSubscriptionOrder(world, CONFIG, issuance.id);
    expect(order[0]).toEqual(PLAYER);
    const kinds = new Set(order.map((holder) => holder.kind));
    expect(kinds.has('player')).toBe(true);
    expect(kinds.has('investorGroup')).toBe(true);
    expect(kinds.has('company')).toBe(true);
    expect(order.length).toBe(1 + world.investors.length + world.companies.length);
    // 同类内部按 id 升序。
    const investors = order.filter((holder) => holder.kind === 'investorGroup').map((h) => h.id);
    expect(investors).toEqual([...investors].sort());
  });

  it('认购窗口关闭后未售出份数不形成债务，且不跨月续售', () => {
    const world = newWorld();
    const city = mainCity(world);
    world.player.cash = 3_000;
    const issuance = issueGovernmentBond(world, city, CONFIG, 10, 0).issuance!;
    subscribeGovernmentBond(world, CONFIG, issuance.id, PLAYER, 10, 0);
    expect(closeGovernmentBondSubscription(world, CONFIG, issuance.id, 0).ok).toBe(true);
    expect(issuance.closedTick).toBe(0);
    expect(issuance.status).toBe('active');
    expect(issuance.unsoldUnits).toBe(7);
    expect(issuance.principal).toBe(3_000);
    // 幂等关闭。
    expect(closeGovernmentBondSubscription(world, CONFIG, issuance.id, 0).ok).toBe(true);
    // 关闭后不可再认购；跨月同 tick 之外也不可。
    expect(subscribeGovernmentBond(world, CONFIG, issuance.id, PLAYER, 1, 0).ok).toBe(false);
    expect(checkInvariants(world)).toEqual([]);
  });
});

describe('政府债券：票息、到期与银行垫付', () => {
  it('M12 票息按已过月份计提并支付；同 tick 重复调用不重复付款', () => {
    const world = newWorld();
    const { city, issuance } = setupSoldIssue(world);
    city.treasury = 500;
    accrueTo(world, 1, 12);
    const paid = payBondCoupon(world, city, CONFIG, issuance.id, 12, []);
    expect(paid.ok).toBe(true);
    // 10,000 × 4% = 400。
    expect(paid.interestPaid).toBe(400);
    expect(city.treasury).toBe(100);
    expect(issuance.couponsPaid).toBe(1);
    expect(issuance.accruedInterest).toBe(0);
    expect(issuance.arrearsInterest).toBe(0);
    const holding = holdingsOf(world, issuance.id)[0]!;
    expect(holding.interestPaid).toBe(400);
    expect(holding.accruedInterest).toBe(0);

    // 同一 tick 重放：0 元二次支付。
    const replay = payBondCoupon(world, city, CONFIG, issuance.id, 12, []);
    expect(replay.payments).toHaveLength(0);
    expect(city.treasury).toBe(100);
    expect(checkInvariants(world)).toEqual([]);
  });

  it('M12 财政不足不垫付、记欠付利息；M36 同月付第 3 期票息与本金，不足部分银行垫付', () => {
    const world = newWorld();
    const { city, issuance } = setupSoldIssue(world);
    city.treasury = 100;
    accrueTo(world, 1, 12);
    const first = payBondCoupon(world, city, CONFIG, issuance.id, 12, []);
    expect(first.interestPaid).toBe(100);
    expect(issuance.couponsPaid).toBe(0);
    expect(issuance.arrearsInterest).toBe(300);
    expect(city.government.loans).toHaveLength(0); // 票息不垫付。

    // M24：应计累计 800，已付 100，本次付 700。
    accrueTo(world, 13, 24);
    city.treasury = 700;
    const second = payBondCoupon(world, city, CONFIG, issuance.id, 24, []);
    expect(second.interestPaid).toBe(700);
    expect(issuance.couponsPaid).toBe(1);
    expect(issuance.arrearsInterest).toBe(0);

    // M36：第 3 期票息（400）财政为 0，先记欠付；随后到期兑付本金 + 欠息由银行垫付。
    accrueTo(world, 25, 36);
    city.treasury = 0;
    const third = payBondCoupon(world, city, CONFIG, issuance.id, 36, []);
    expect(third.interestPaid).toBe(0);
    expect(issuance.arrearsInterest).toBe(400);

    const maturity = settleBondMaturity(world, city, CONFIG, issuance.id, 36, []);
    expect(maturity.ok).toBe(true);
    expect(maturity.principalPaid).toBe(10_000);
    expect(maturity.interestPaid).toBe(400);
    expect(maturity.advancedByBank).toBe(10_400);
    expect(issuance.status).toBe('redeemed');
    expect(issuance.redemptionReason).toBe('maturity');
    expect(issuance.couponsPaid).toBe(3);
    expect(issuance.bankAdvancedAmount).toBe(10_400);
    expect(issuance.principalRepaid).toBe(10_000);
    expect(issuance.accruedInterest).toBe(0);
    expect(issuance.arrearsInterest).toBe(0);

    const advanceLoans = city.government.loans.filter((loan) => loan.purpose === 'bondAdvance');
    expect(advanceLoans).toHaveLength(1);
    expect(advanceLoans[0]!.principal).toBe(10_400);
    expect(advanceLoans[0]!.bondIssuanceId).toBe(issuance.id);
    expect(city.government.advances).toHaveLength(1);
    const advance = city.government.advances[0]!;
    expect(advance.totalAdvanced).toBe(10_400);
    expect(advance.principalAdvanced).toBe(10_000);
    expect(advance.interestAdvanced).toBe(400);
    // 票息 100 + 700 + 400 = 1,200，恰好三期。
    expect(issuance.interestPaid).toBe(1_200);

    // 幂等：重复到期兑付不再付款、不再生成贷款。
    const replay = settleBondMaturity(world, city, CONFIG, issuance.id, 36, []);
    expect(replay.payments).toHaveLength(0);
    expect(city.government.loans).toHaveLength(1);
    expect(issuance.bankAdvancedAmount).toBe(10_400);
    expect(checkInvariants(world)).toEqual([]);
  });

  it('财政充足时到期本息全部由财政支付，不产生垫付贷款', () => {
    const world = newWorld();
    const { city, issuance } = setupSoldIssue(world);
    accrueTo(world, 1, 36);
    city.treasury = 12_000;
    const maturity = settleBondMaturity(world, city, CONFIG, issuance.id, 36, []);
    expect(maturity.principalPaid).toBe(10_000);
    expect(maturity.interestPaid).toBe(1_200);
    expect(maturity.advancedByBank).toBe(0);
    expect(city.treasury).toBe(800);
    expect(city.government.loans).toHaveLength(0);
    expect(checkInvariants(world)).toEqual([]);
  });

  it('破产兑付：银行兑付未到期本金 + 实际持有月份已计提未付利息，且每笔只付一次', () => {
    const world = newWorld();
    const { city, issuance } = setupSoldIssue(world);
    city.treasury = 1_000;
    accrueTo(world, 1, 12);
    payBondCoupon(world, city, CONFIG, issuance.id, 12, []);
    // 第 12 月已付 400；再持有 8 个月（13…20），未付利息 = 10,000×4%×20/12 − 400。
    accrueTo(world, 13, 20);
    const redemption = settleBondBankruptcyRedemption(world, city, CONFIG, 20, []);
    expect(redemption.ok).toBe(true);
    const expectedInterest = round2((10_000 * 0.04 * 20) / 12 - 400);
    expect(redemption.principalPaid).toBe(10_000);
    expect(redemption.interestPaid).toBe(expectedInterest);
    expect(redemption.advancedByBank).toBe(round2(10_000 + expectedInterest));
    expect(issuance.status).toBe('redeemed');
    expect(issuance.redemptionReason).toBe('bankruptcy');
    expect(issuance.accruedInterest).toBe(0);
    expect(city.government.loans).toHaveLength(1);
    expect(city.government.loans[0]!.purpose).toBe('bondAdvance');

    const replay = settleBondBankruptcyRedemption(world, city, CONFIG, 20, []);
    expect(replay.payments).toHaveLength(0);
    expect(city.government.loans).toHaveLength(1);
    expect(checkInvariants(world)).toEqual([]);
  });

  it('固定序列可复现：相同操作序列产生完全一致的债券账本与财政', () => {
    const runOnce = () => {
      const world = newWorld();
      const { city, issuance } = setupSoldIssue(world);
      city.treasury = 500;
      accrueTo(world, 1, 12);
      payBondCoupon(world, city, CONFIG, issuance.id, 12, []);
      accrueTo(world, 13, 36);
      city.treasury = 0;
      settleBondMaturity(world, city, CONFIG, issuance.id, 36, []);
      return world;
    };
    const a = runOnce();
    const b = runOnce();
    expect(JSON.stringify(a.bonds)).toBe(JSON.stringify(b.bonds));
    expect(JSON.stringify(a.cities.map((city) => city.government))).toBe(
      JSON.stringify(b.cities.map((city) => city.government)),
    );
    expect(mainCity(a).treasury).toBe(mainCity(b).treasury);
  });

  it('存档往返：债券账本与政府债务状态读回后一致', () => {
    const world = newWorld();
    const { city, issuance } = setupSoldIssue(world);
    city.treasury = 500;
    accrueTo(world, 1, 12);
    payBondCoupon(world, city, CONFIG, issuance.id, 12, []);
    const text = serializeSave(world, 'bond-roundtrip');
    const parsed = parseSave(text);
    expect(parsed.ok, parsed.error).toBe(true);
    const restored = parsed.world!;
    expect(JSON.stringify(restored.bonds)).toBe(JSON.stringify(world.bonds));
    expect(JSON.stringify(restored.cities[0]?.government)).toBe(
      JSON.stringify(mainCity(world).government),
    );
    expect(restored.cities[0]!.treasury).toBe(mainCity(world).treasury);
    expect(checkInvariants(restored)).toEqual([]);
  });
});

describe('债券兑付：资金必须真正到持有人账上（货币守恒）', () => {
  it('到期财政充足：持有人现金增量 = 本息支付额', () => {
    const world = newWorld();
    const { city, issuance } = setupSoldIssue(world, 0);
    city.treasury = 20_000;
    const playerBefore = world.player.cash;
    const treasuryBefore = city.treasury;

    world.time.tick = 36;
    const result = settleBondMaturity(world, city, CONFIG, issuance.id, 36, world.log);
    expect(result.ok).toBe(true);
    expect(result.advancedByBank).toBe(0);

    const paid = round2(result.principalPaid + result.interestPaid);
    expect(paid).toBe(11_200);
    expect(world.player.cash).toBeCloseTo(round2(playerBefore + paid), 2);
    expect(city.treasury).toBeCloseTo(round2(treasuryBefore - paid), 2);

    // 同 tick 重放：幂等，不再给钱。
    const replay = settleBondMaturity(world, city, CONFIG, issuance.id, 36, world.log);
    expect(replay.payments).toHaveLength(0);
    expect(world.player.cash).toBeCloseTo(round2(playerBefore + paid), 2);
  });

  it('到期财政为 0：银行垫付的钱进持有人、政府欠银行的钱进垫付贷款，两边都有', () => {
    const world = newWorld();
    const { city, issuance } = setupSoldIssue(world, 0);
    city.treasury = 0;
    const playerBefore = world.player.cash;

    world.time.tick = 36;
    const result = settleBondMaturity(world, city, CONFIG, issuance.id, 36, world.log);
    expect(result.ok).toBe(true);
    expect(result.advancedByBank).toBe(11_200);

    const paid = round2(result.principalPaid + result.interestPaid);
    expect(world.player.cash).toBeCloseTo(round2(playerBefore + paid), 2);
    expect(city.treasury).toBe(0);
    const advanceLoans = city.government.loans.filter((loan) => loan.purpose === 'bondAdvance');
    expect(round2(advanceLoans.reduce((total, loan) => total + loan.outstanding, 0))).toBe(11_200);

    // 重放：不重复垫付、不重复给持有人钱。
    const replay = settleBondMaturity(world, city, CONFIG, issuance.id, 36, world.log);
    expect(replay.payments).toHaveLength(0);
    expect(world.player.cash).toBeCloseTo(round2(playerBefore + paid), 2);
  });

  it('到期财政只够 88%、银行垫付 12%：财政段与垫付段合并为一条全额流水，持有人一次收满', () => {
    const world = newWorld();
    const { city, issuance } = setupSoldIssue(world, 0);
    // 应兑付 11,200；财政只够 9,856（88%），其余 1,344 必须由银行垫付。
    city.treasury = 9_856;
    const playerBefore = world.player.cash;

    world.time.tick = 36;
    const result = settleBondMaturity(world, city, CONFIG, issuance.id, 36, world.log);
    expect(result.ok).toBe(true);
    expect(result.advancedByBank).toBeCloseTo(1_344, 2);

    // 一条流水、金额=两段之和，不是被幂等键吞掉前半段。
    expect(result.payments).toHaveLength(1);
    expect(result.payments[0]!.kind).toBe('principal');
    expect(result.payments[0]!.principalPaid).toBeCloseTo(10_000, 2);
    expect(result.payments[0]!.interestPaid).toBeCloseTo(1_200, 2);
    expect(result.payments[0]!.fundedByBankAdvance).toBe(true);
    expect(round2(result.principalPaid + result.interestPaid)).toBe(11_200);
    expect(world.player.cash).toBeCloseTo(round2(playerBefore + 11_200), 2);
    expect(issuance.principalRepaid).toBeCloseTo(10_000, 2);
    expect(city.treasury).toBe(0);
    expect(checkInvariants(world)).toEqual([]);

    // 同一 tick 重放：幂等，不重复支付、不重复垫付。
    const paymentsBefore = (world.bonds?.payments ?? []).length;
    const replay = settleBondMaturity(world, city, CONFIG, issuance.id, 36, world.log);
    expect(replay.payments).toHaveLength(0);
    expect((world.bonds?.payments ?? []).length).toBe(paymentsBefore);
    expect(world.player.cash).toBeCloseTo(round2(playerBefore + 11_200), 2);
    expect(issuance.principalRepaid).toBeCloseTo(10_000, 2);
  });

  it('M12 票息：持有人现金增量 = interestPaid；同 tick 重放增量为 0', () => {
    const world = newWorld();
    const { city, issuance } = setupSoldIssue(world, 0);
    city.treasury = 5_000;
    const playerBefore = world.player.cash;

    world.time.tick = 12;
    const result = payBondCoupon(world, city, CONFIG, issuance.id, 12, world.log);
    expect(result.ok).toBe(true);
    expect(result.interestPaid).toBe(400);
    expect(world.player.cash).toBeCloseTo(round2(playerBefore + result.interestPaid), 2);

    const replay = payBondCoupon(world, city, CONFIG, issuance.id, 12, world.log);
    expect(replay.interestPaid).toBe(0);
    expect(world.player.cash).toBeCloseTo(round2(playerBefore + 400), 2);
  });

  it('破产兑付：持有人现金增量 = 未到期本金 + 已计提未付利息；重放增量为 0', () => {
    const world = newWorld();
    const { city, issuance } = setupSoldIssue(world, 0);
    const playerBefore = world.player.cash;

    world.time.tick = 18;
    const result = settleBondBankruptcyRedemption(world, city, CONFIG, 18, world.log);
    expect(result.ok).toBe(true);
    const expectedInterest = 600; // 10,000 × 4% × 18/12
    expect(result.principalPaid).toBe(10_000);
    expect(result.interestPaid).toBe(expectedInterest);
    expect(world.player.cash).toBeCloseTo(
      round2(playerBefore + 10_000 + expectedInterest),
      2,
    );

    const replay = settleBondBankruptcyRedemption(world, city, CONFIG, 18, world.log);
    expect(replay.payments).toHaveLength(0);
    expect(world.player.cash).toBeCloseTo(
      round2(playerBefore + 10_000 + expectedInterest),
      2,
    );
    // 已兑付批次不再保留 active 持债，且不变量自洽。
    expect(holdingsOf(world, issuance.id).every((holding) => holding.status === 'redeemed')).toBe(
      true,
    );
    expect(checkInvariants(world)).toEqual([]);
  });
});
