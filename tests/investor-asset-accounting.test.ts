import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation/core/simulation';
import { DEMO_CONFIG } from '../src/data/config';
import type {
  BondHolder,
  City,
  HouseholdGroup,
  InvestorGroup,
  OccupationClass,
  WorldState,
} from '../src/simulation/contracts/types';
import { checkInvariants } from '../src/simulation/core/invariants';
import { parseSave, serializeSave } from '../src/simulation/core/save';
import { round2 } from '../src/simulation/core/math';
import {
  accrueBondInterest,
  closeGovernmentBondSubscription,
  issueGovernmentBond,
  payBondCoupon,
  settleBondBankruptcyRedemption,
  settleBondMaturity,
  subscribeGovernmentBond,
} from '../src/simulation/government/bonds';
import {
  cityInvestorEquity,
  householdGroupsOfCity,
  syncHouseholdPeople,
} from '../src/simulation/population/household-groups';
import {
  effectiveInvestorShares,
  investorBondValue,
  sharesForInvestorValue,
} from '../src/simulation/population/household-investment';
import {
  collectInvestableFunds,
  ensureInvestorOpeningShares,
  investorFundingReport,
  transferInvestorAssetsForMigration,
} from '../src/simulation/investors/investors';

const CONFIG = DEMO_CONFIG;

function newWorld(): WorldState {
  return Simulation.create().state;
}

function citiesSorted(world: WorldState): City[] {
  return [...world.cities].sort((left, right) => left.id.localeCompare(right.id));
}

function cityAt(world: WorldState, index: number): City {
  const city = citiesSorted(world)[index];
  if (!city) throw new Error(`缺少第 ${index} 个城市`);
  return city;
}

function investorsOf(world: WorldState, cityId: string): InvestorGroup[] {
  return world.investors
    .filter((group) => group.cityId === cityId)
    .sort((left, right) => left.id.localeCompare(right.id));
}

function groupOf(
  world: WorldState,
  cityId: string,
  occupation: OccupationClass,
): HouseholdGroup {
  const group = householdGroupsOfCity(world, cityId).find(
    (entry) => entry.occupation === occupation,
  );
  if (!group) throw new Error(`缺少 ${cityId} 的 ${occupation} 群体`);
  return group;
}

/**
 * 测试夹具：把某城投资实体净资产收敛为“现金（+ 既有债券）”，便于按任务书数字精确构造。
 * 投资实体原持股改挂市政府（股份总股数不变，不影响证券总量），现金集中到第一个实体。
 */
function seedInvestorCash(world: WorldState, city: City, cash: number): InvestorGroup {
  const investors = investorsOf(world, city.id);
  const ids = new Set(investors.map((investor) => investor.id));
  for (const holding of world.securities.holdings) {
    if (holding.holder.type === 'investorGroup' && ids.has(holding.holder.id)) {
      holding.holder = { type: 'city', id: city.id };
    }
  }
  for (const investor of investors) investor.cash = 0;
  const first = investors[0];
  if (!first) throw new Error(`缺少 ${city.id} 的投资实体`);
  first.cash = cash;
  return first;
}

/** 测试夹具：直接指定某城各职业群体的投资份额账本（openingShares 显式为 0，防重算）。 */
function seedHouseholdShares(
  world: WorldState,
  cityId: string,
  sharesByOccupation: Partial<Record<OccupationClass, number>>,
): void {
  for (const group of householdGroupsOfCity(world, cityId)) {
    const shares = round2(sharesByOccupation[group.occupation] ?? 0);
    group.investorLedger = {
      contributed: shares,
      shares,
      openingShares: 0,
      dividends: 0,
      lastContributionTick: -1,
      lastDividendTick: -1,
    };
  }
}

/** 指定城市的投资者实体净资产合计（迁移不变量：跨城迁移不得创造/销毁权益价值）。 */
function totalInvestorEquity(world: WorldState, cityIds: string[]): number {
  return round2(
    cityIds.reduce((sum, cityId) => sum + cityInvestorEquity(world, cityId), 0),
  );
}

function totalEffectiveShares(world: WorldState, cityId: string): number {
  return round2(
    householdGroupsOfCity(world, cityId).reduce(
      (sum, group) => sum + effectiveInvestorShares(group.investorLedger),
      0,
    ),
  );
}

/** 本城投资实体每份有效份额对应的净资产（净值/份额）。 */
function navOf(world: WorldState, cityId: string): number {
  const shares = totalEffectiveShares(world, cityId);
  return shares > 0 ? cityInvestorEquity(world, cityId) / shares : 0;
}

function investorHolder(group: InvestorGroup): BondHolder {
  return { kind: 'investorGroup', id: group.id };
}

/** 发行 10 份（10,000 面额）国债并让居民投资实体全额认购，关闭认购窗口。 */
function setupInvestorBond(
  world: WorldState,
  city: City,
  group: InvestorGroup,
  units = 10,
  tick = 0,
) {
  world.time.tick = tick;
  city.treasury = 0;
  group.cash = Math.max(group.cash, units * CONFIG.government.bondMarket.faceValue + 100_000);
  const issued = issueGovernmentBond(world, city, CONFIG, units, tick);
  expect(issued.ok).toBe(true);
  const issuance = issued.issuance!;
  const subscribed = subscribeGovernmentBond(world, CONFIG, issuance.id, investorHolder(group), units, tick);
  expect(subscribed.ok).toBe(true);
  expect(subscribed.units).toBe(units);
  expect(closeGovernmentBondSubscription(world, CONFIG, issuance.id, tick).ok).toBe(true);
  return issuance;
}

function accrueTo(world: WorldState, city: City, fromTick: number, toTick: number): void {
  for (let tick = fromTick; tick <= toTick; tick += 1) {
    world.time.tick = tick;
    accrueBondInterest(world, city, CONFIG, tick);
  }
  world.time.tick = toTick;
}

describe('投资实体资产核算（v1.4 §3）', () => {
  it('认购国债：现金减少与债券本金增加相抵，投资实体净资产不变且债券计入净资产', () => {
    const world = newWorld();
    const city = cityAt(world, 0);
    const group = investorsOf(world, city.id)[0]!;
    const equityBefore = cityInvestorEquity(world, city.id);
    const cashBefore = group.cash;

    setupInvestorBond(world, city, group, 10, 0);
    expect(group.cash).toBeCloseTo(round2(cashBefore - 10_000), 2);
    expect(investorBondValue(world, group.id)).toBe(10_000);
    // 债券本金不是凭空增加的财富：现金 −10,000 + 债券 +10,000 = 0。
    expect(cityInvestorEquity(world, city.id)).toBeCloseTo(equityBefore, 2);
    expect(checkInvariants(world)).toEqual([]);
  });

  it('计提票息进入净资产；付息后现金增加、应计利息清零，净资产只增加真实利息', () => {
    const world = newWorld();
    const city = cityAt(world, 0);
    const group = investorsOf(world, city.id)[0]!;
    const equityBefore = cityInvestorEquity(world, city.id);
    const issuance = setupInvestorBond(world, city, group, 10, 0);

    accrueTo(world, city, 1, 12);
    // 10,000 × 4% × 12/12 = 400。
    expect(investorBondValue(world, group.id)).toBe(10_400);
    expect(cityInvestorEquity(world, city.id)).toBeCloseTo(round2(equityBefore + 400), 2);

    const cashBeforeCoupon = group.cash;
    city.treasury = 1_000;
    const paid = payBondCoupon(world, city, CONFIG, issuance.id, 12, []);
    expect(paid.ok).toBe(true);
    expect(group.cash).toBeCloseTo(round2(cashBeforeCoupon + 400), 2);
    expect(investorBondValue(world, group.id)).toBe(10_000);
    // 利息从“应计”变成“现金”，净资产不因付息重复增加。
    expect(cityInvestorEquity(world, city.id)).toBeCloseTo(round2(equityBefore + 400), 2);
    expect(checkInvariants(world)).toEqual([]);
  });

  it('到期兑付：本息现金入账、债券移出净资产，兑付前后净资产不变', () => {
    const world = newWorld();
    const city = cityAt(world, 0);
    const group = investorsOf(world, city.id)[0]!;
    setupInvestorBond(world, city, group, 10, 0);
    accrueTo(world, city, 1, 12);
    city.treasury = 1_000;
    payBondCoupon(world, city, CONFIG, (world.bonds?.issuances ?? [])[0]!.id, 12, []);
    accrueTo(world, city, 13, 36);
    // 第 3 期应计 800。
    expect(investorBondValue(world, group.id)).toBe(10_800);
    const equityBeforeMaturity = cityInvestorEquity(world, city.id);

    const cashBeforeMaturity = group.cash;
    city.treasury = 20_000;
    const issuanceId = (world.bonds?.issuances ?? [])[0]!.id;
    const maturity = settleBondMaturity(world, city, CONFIG, issuanceId, 36, []);
    expect(maturity.ok).toBe(true);
    expect(maturity.principalPaid).toBe(10_000);
    expect(maturity.interestPaid).toBe(800);
    expect(group.cash).toBeCloseTo(round2(cashBeforeMaturity + 10_800), 2);
    expect(investorBondValue(world, group.id)).toBe(0);
    expect(cityInvestorEquity(world, city.id)).toBeCloseTo(equityBeforeMaturity, 2);
    expect(checkInvariants(world)).toEqual([]);
  });

  it('破产兑付：未到期本金与已计提利息由银行垫付进实体现金，净资产口径闭合', () => {
    const world = newWorld();
    const city = cityAt(world, 0);
    const group = investorsOf(world, city.id)[0]!;
    const equityBefore = cityInvestorEquity(world, city.id);
    setupInvestorBond(world, city, group, 10, 0);
    accrueTo(world, city, 1, 6);
    expect(investorBondValue(world, group.id)).toBe(10_200);

    const cashBefore = group.cash;
    const redemption = settleBondBankruptcyRedemption(world, city, CONFIG, 6, []);
    expect(redemption.ok).toBe(true);
    expect(redemption.principalPaid).toBe(10_000);
    expect(redemption.interestPaid).toBe(200);
    expect(group.cash).toBeCloseTo(round2(cashBefore + 10_200), 2);
    expect(investorBondValue(world, group.id)).toBe(0);
    // 兑付前净资产 = 本金 + 200 应计；兑付后现金 +10,200、债券归零，净资产不变。
    expect(cityInvestorEquity(world, city.id)).toBeCloseTo(round2(equityBefore + 200), 2);
    expect(checkInvariants(world)).toEqual([]);
  });

  it('新资金进入不同净值的实体：按各自净值换算份额，原持有人每份价值不变', () => {
    const world = newWorld();
    const left = cityAt(world, 0);
    const right = cityAt(world, 1);
    ensureInvestorOpeningShares(world);
    // 测试夹具：给左城投资实体额外现金，拉开两城净值/份额，验证按各自净值换算。
    for (const group of investorsOf(world, left.id)) group.cash = round2(group.cash + 5_000_000);
    for (const city of world.cities) {
      city.lastMonth.investableContribution = 0;
      city.householdIncomeLastMonth = 10_000_000;
    }
    for (const group of world.households.groups) group.cash = 1_000_000_000;

    const navLeftBefore = navOf(world, left.id);
    const navRightBefore = navOf(world, right.id);
    expect(navLeftBefore).toBeGreaterThan(0);
    expect(navRightBefore).toBeGreaterThan(0);
    expect(navLeftBefore).not.toBeCloseTo(navRightBefore, 6);
    const before = world.cities.map((city) => ({
      cityId: city.id,
      equity: cityInvestorEquity(world, city.id),
      shares: totalEffectiveShares(world, city.id),
    }));

    collectInvestableFunds(world, CONFIG, []);

    for (const snapshot of before) {
      const city = world.cities.find((entry) => entry.id === snapshot.cityId)!;
      const contribution = round2(city.lastMonth.investableContribution);
      expect(contribution).toBeGreaterThan(0);
      const equityAfter = cityInvestorEquity(world, city.id);
      const sharesAfter = totalEffectiveShares(world, city.id);
      const nav = snapshot.shares > 0 ? snapshot.equity / snapshot.shares : 0;
      // 真实转账：投资实体净资产增加额严格等于居民转入额。
      expect(round2(equityAfter - snapshot.equity)).toBeCloseTo(contribution, 2);
      const addedShares = round2(sharesAfter - snapshot.shares);
      expect(addedShares).toBeGreaterThan(0);
      // 增发份额的价值 = 转入现金：addedShares × 原净值/份额 ≈ contribution（0.01 舍入内）。
      expect(addedShares * nav).toBeCloseTo(contribution, 1);
      // 原持有人每份价值不被稀释。
      const navAfter = sharesAfter > 0 ? equityAfter / sharesAfter : 0;
      expect(navAfter).toBeCloseTo(nav, 2);
    }
    expect(checkInvariants(world)).toEqual([]);
  });

  it('零净资产实体：新资金按 1:1 兜底份额，不产生除零或 NaN', () => {
    const world = newWorld();
    const city = cityAt(world, 2);
    ensureInvestorOpeningShares(world);
    // 清空该城投资实体的现金与持股（持股改挂市政府，股份总量不变）。
    const investorIds = new Set(investorsOf(world, city.id).map((group) => group.id));
    for (const holding of world.securities.holdings) {
      if (holding.holder.type === 'investorGroup' && investorIds.has(holding.holder.id)) {
        holding.holder = { type: 'city', id: city.id };
      }
    }
    for (const group of investorsOf(world, city.id)) group.cash = 0;
    for (const group of householdGroupsOfCity(world, city.id)) {
      group.investorLedger = {
        contributed: 0,
        shares: 0,
        openingShares: 0,
        dividends: 0,
        lastContributionTick: -1,
        lastDividendTick: -1,
      };
      group.cash = 1_000_000_000;
    }
    city.lastMonth.investableContribution = 0;
    city.householdIncomeLastMonth = 10_000_000;
    expect(cityInvestorEquity(world, city.id)).toBe(0);
    expect(navOf(world, city.id)).toBe(0);

    collectInvestableFunds(world, CONFIG, []);

    const contribution = round2(city.lastMonth.investableContribution);
    expect(contribution).toBeGreaterThan(0);
    expect(totalEffectiveShares(world, city.id)).toBeCloseTo(contribution, 2);
    expect(sharesForInvestorValue(123.45, 0)).toBe(123.45);
    expect(Number.isFinite(navOf(world, city.id))).toBe(true);
    expect(checkInvariants(world)).toEqual([]);
  });

  it('职业/人口变化：份额随人流转后城市总份额、净资产与每份价值守恒', () => {
    const world = newWorld();
    const city = cityAt(world, 0);
    ensureInvestorOpeningShares(world);
    const sharesBefore = totalEffectiveShares(world, city.id);
    const equityBefore = cityInvestorEquity(world, city.id);
    const navBefore = navOf(world, city.id);
    const company = world.companies.find((entry) => entry.cityId === city.id);
    if (!company) throw new Error('缺少测试企业');
    const moved = Math.min(1_000, company.roles.production);
    company.roles.production -= moved;
    company.roles.sales += moved;

    syncHouseholdPeople(world, CONFIG);

    expect(totalEffectiveShares(world, city.id)).toBeCloseTo(sharesBefore, 2);
    expect(cityInvestorEquity(world, city.id)).toBeCloseTo(equityBefore, 2);
    expect(navOf(world, city.id)).toBeCloseTo(navBefore, 6);
    expect(checkInvariants(world)).toEqual([]);
  });

  it('§3.1 任务书复现例：A 实体 10,000/1,000 份、B 实体 1,000/1,000 份，A 城 500 份持有人迁入 B，三方权益价值均不被无偿转移', () => {
    const world = newWorld();
    const from = cityAt(world, 0);
    const to = cityAt(world, 1);
    // 任务书夹具：A 实体净资产 10,000、1,000 份（净值 10/份）；B 实体 1,000、1,000 份（净值 1/份）。
    seedInvestorCash(world, from, 10_000);
    seedInvestorCash(world, to, 1_000);
    seedHouseholdShares(world, from.id, { unemployed: 500, production: 500 });
    seedHouseholdShares(world, to.id, { management: 1_000 });
    ensureInvestorOpeningShares(world);

    const fromEquityBefore = cityInvestorEquity(world, from.id);
    const toEquityBefore = cityInvestorEquity(world, to.id);
    expect(fromEquityBefore).toBe(10_000);
    expect(toEquityBefore).toBe(1_000);
    const fromNavBefore = round2(fromEquityBefore / totalEffectiveShares(world, from.id));
    const toNavBefore = round2(toEquityBefore / totalEffectiveShares(world, to.id));
    expect(fromNavBefore).toBe(10);
    expect(toNavBefore).toBe(1);

    const source = groupOf(world, from.id, 'unemployed');
    const remainingResident = groupOf(world, from.id, 'production');
    const originalToResident = groupOf(world, to.id, 'management');
    const destination = groupOf(world, to.id, 'unemployed');
    const migrantSharesBefore = effectiveInvestorShares(source.investorLedger);
    expect(migrantSharesBefore).toBe(500);
    // 迁入前各方价值（份额 × 本城净值/份）。
    const migrantValueBefore = round2(migrantSharesBefore * fromNavBefore);
    const remainingValueBefore = round2(
      effectiveInvestorShares(remainingResident.investorLedger) * fromNavBefore,
    );
    const originalToValueBefore = round2(
      effectiveInvestorShares(originalToResident.investorLedger) * toNavBefore,
    );
    expect(migrantValueBefore).toBe(5_000);
    expect(remainingValueBefore).toBe(5_000);
    expect(originalToValueBefore).toBe(1_000);
    const totalValueBefore = round2(migrantValueBefore + remainingValueBefore + originalToValueBefore);
    expect(totalValueBefore).toBe(11_000);

    // A 城持有 500 份者整群迁入 B（迁移路径：先按源城净值计价，再按目标城净值换算份额）。
    const moving = source.people;
    const result = transferInvestorAssetsForMigration(world, from.id, to.id, moving, moving);

    // 迁出者按源城净值带走 500 × 10 = 5,000，真实划转 5,000 现金；B 城按净值 1/份增发 5,000 份。
    expect(result.effectiveSharesMoved).toBe(500);
    expect(result.valueMoved).toBe(5_000);
    expect(result.cashMoved).toBe(5_000);
    expect(result.targetSharesAdded).toBe(5_000);

    // 迁入后：A 城剩 500 份、净资产 5,000（净值仍 10/份）；B 城 6,000 份、净资产 6,000（净值仍 1/份）。
    const fromSharesAfter = totalEffectiveShares(world, from.id);
    const fromEquityAfter = cityInvestorEquity(world, from.id);
    const toSharesAfter = totalEffectiveShares(world, to.id);
    const toEquityAfter = cityInvestorEquity(world, to.id);
    expect(fromSharesAfter).toBe(500);
    expect(fromEquityAfter).toBe(5_000);
    expect(toSharesAfter).toBe(6_000);
    expect(toEquityAfter).toBe(6_000);
    const fromNavAfter = round2(fromEquityAfter / fromSharesAfter);
    const toNavAfter = round2(toEquityAfter / toSharesAfter);
    expect(fromNavAfter).toBe(fromNavBefore);
    expect(toNavAfter).toBe(toNavBefore);

    // 迁入者：500 份 A 权益（5,000）→ 5,000 份 B 权益 × 1 = 5,000，价值分文不差。
    expect(effectiveInvestorShares(source.investorLedger)).toBe(0);
    expect(effectiveInvestorShares(destination.investorLedger)).toBe(5_000);
    const migrantValueAfter = round2(
      effectiveInvestorShares(destination.investorLedger) * toNavAfter,
    );
    expect(migrantValueAfter).toBe(migrantValueBefore);

    // 迁出地其他居民：500 份 × 10 = 5,000，不被迁入者带走、也不被稀释。
    expect(
      round2(effectiveInvestorShares(remainingResident.investorLedger) * fromNavAfter),
    ).toBe(remainingValueBefore);
    // 迁入地原居民：1,000 份 × 1 = 1,000，不因迁入者而增值（若按 1:1 记 500 份，B 净值会被稀释到 4/份）。
    expect(
      round2(effectiveInvestorShares(originalToResident.investorLedger) * toNavAfter),
    ).toBe(originalToValueBefore);
    expect(toNavAfter).not.toBe(4);

    // 全城权益价值守恒：11,000 → 11,000；投资实体现金守恒 11,000，不凭空造钱。
    expect(totalValueBefore).toBe(11_000);
    expect(
      round2(migrantValueAfter + remainingValueBefore + originalToValueBefore),
    ).toBe(totalValueBefore);
    expect(totalInvestorEquity(world, [from.id, to.id])).toBe(11_000);
    expect(
      round2(
        [...investorsOf(world, from.id), ...investorsOf(world, to.id)].reduce(
          (sum, investor) => sum + investor.cash,
          0,
        ),
      ),
    ).toBe(11_000);
    expect(checkInvariants(world)).toEqual([]);
  });

  it('§3.2/v1.5 §2 跨城迁移：债券按比例真实拆分给两城实体，不重复计、不消失、兑付规则不变', () => {
    const world = newWorld();
    const from = cityAt(world, 0);
    const to = cityAt(world, 1);
    const bondGroup = investorsOf(world, from.id)[0]!;
    // A 城投资实体认购 4 份 × 面额 1,000 = 4,000 未到期国债本金。
    setupInvestorBond(world, from, bondGroup, 4, 0);
    expect(investorBondValue(world, bondGroup.id)).toBe(4_000);
    // 夹具：A 实体 = 现金 6,000 + 债券 4,000 = 10,000；B 实体 = 现金 1,000。
    const holder = seedInvestorCash(world, from, 6_000);
    seedInvestorCash(world, to, 1_000);
    seedHouseholdShares(world, from.id, { unemployed: 500, production: 500 });
    seedHouseholdShares(world, to.id, { management: 1_000 });
    ensureInvestorOpeningShares(world);
    expect(holder.id).toBe(bondGroup.id);

    const bondValueBefore = investorBondValue(world, holder.id);
    expect(bondValueBefore).toBe(4_000);
    expect(cityInvestorEquity(world, from.id)).toBe(10_000);
    const totalValueBefore = totalInvestorEquity(world, [from.id, to.id]);
    expect(totalValueBefore).toBe(11_000);
    const totalBondValueBefore = round2(
      (world.bonds?.holdings ?? [])
        .filter((holding) => holding.status === 'active')
        .reduce((sum, holding) => sum + holding.principal + holding.accruedInterest, 0),
    );

    const source = groupOf(world, from.id, 'unemployed');
    const moving = source.people;
    const result = transferInvestorAssetsForMigration(world, from.id, to.id, moving, moving);

    // 迁移价值 5,000 = 债券 2,000（真实拆分给 B 城实体）+ 现金 3,000；股票为 0。
    expect(result.effectiveSharesMoved).toBe(500);
    expect(result.valueMoved).toBe(5_000);
    expect(result.holdingsMoved).toBe(0);
    expect(result.bondValueMoved).toBe(2_000);
    expect(result.bondHoldingsMoved).toBeGreaterThan(0);
    expect(result.cashMoved).toBe(3_000);
    expect(result.targetSharesAdded).toBe(5_000);
    expect(investorBondValue(world, holder.id)).toBe(2_000);
    const bondValueOfToInvestors = round2(
      investorsOf(world, to.id).reduce(
        (sum, investor) => sum + investorBondValue(world, investor.id),
        0,
      ),
    );
    expect(bondValueOfToInvestors).toBe(2_000);
    const totalBondValueAfter = round2(
      (world.bonds?.holdings ?? [])
        .filter((holding) => holding.status === 'active')
        .reduce((sum, holding) => sum + holding.principal + holding.accruedInterest, 0),
    );
    // 债券本金/应计合计不变：真实转移，不是凭空造债也不是抹掉。
    expect(totalBondValueAfter).toBe(totalBondValueBefore);

    // A 城：净资产 5,000 = 现金 3,000 + 债券 2,000，500 份净值仍 10/份；留在 A 的居民价值不变。
    const fromEquityAfter = cityInvestorEquity(world, from.id);
    const fromNavAfter = round2(fromEquityAfter / totalEffectiveShares(world, from.id));
    expect(fromEquityAfter).toBe(5_000);
    expect(fromNavAfter).toBe(10);
    expect(
      round2(
        effectiveInvestorShares(groupOf(world, from.id, 'production').investorLedger) *
          fromNavAfter,
      ),
    ).toBe(5_000);

    // B 城：6,000/6,000 = 净值 1/份；原居民 1,000 份价值不变，迁入者 5,000 份价值 5,000。
    const toEquityAfter = cityInvestorEquity(world, to.id);
    const toNavAfter = round2(toEquityAfter / totalEffectiveShares(world, to.id));
    expect(toEquityAfter).toBe(6_000);
    expect(toNavAfter).toBe(1);
    expect(
      round2(
        effectiveInvestorShares(groupOf(world, to.id, 'management').investorLedger) * toNavAfter,
      ),
    ).toBe(1_000);
    expect(
      round2(
        effectiveInvestorShares(groupOf(world, to.id, 'unemployed').investorLedger) * toNavAfter,
      ),
    ).toBe(5_000);

    // 跨城迁移不创造/不销毁权益价值。
    expect(totalInvestorEquity(world, [from.id, to.id])).toBe(totalValueBefore);
    expect(checkInvariants(world)).toEqual([]);
  });

  it('存读档：债券估值、有效份额与报告口径往返一致且幂等', () => {
    const world = newWorld();
    const city = cityAt(world, 0);
    const group = investorsOf(world, city.id)[0]!;
    setupInvestorBond(world, city, group, 10, 0);
    accrueTo(world, city, 1, 12);
    ensureInvestorOpeningShares(world);

    const bondValueBefore = investorBondValue(world, group.id);
    const equityBefore = cityInvestorEquity(world, city.id);
    const reportBefore = investorFundingReport(world).find((entry) => entry.cityId === city.id)!;

    const parsed = parseSave(serializeSave(world, 'investor-asset-accounting'));
    expect(parsed.ok, parsed.error).toBe(true);
    const restored = parsed.world!;

    expect(investorBondValue(restored, group.id)).toBe(bondValueBefore);
    expect(cityInvestorEquity(restored, city.id)).toBeCloseTo(equityBefore, 2);
    const reportAfter = investorFundingReport(restored).find((entry) => entry.cityId === city.id)!;
    expect(reportAfter.investorNetWorth).toBeCloseTo(reportBefore.investorNetWorth, 2);
    expect(JSON.stringify(reportAfter.householdShares)).toBe(
      JSON.stringify(reportBefore.householdShares),
    );
    expect(checkInvariants(restored)).toEqual([]);

    // 再次读档归一化幂等：不重复补起始份额、不重复计债券。
    const reparsed = parseSave(serializeSave(restored, 'investor-asset-accounting-2'));
    expect(reparsed.ok, reparsed.error).toBe(true);
    expect(investorBondValue(reparsed.world!, group.id)).toBe(bondValueBefore);
    expect(cityInvestorEquity(reparsed.world!, city.id)).toBeCloseTo(equityBefore, 2);
  });

  it('报告：投资实体净资产 = 现金 + 持股市值 + 债券估值，群体有效份额合计与占比一致', () => {
    const world = newWorld();
    const city = cityAt(world, 0);
    const group = investorsOf(world, city.id)[0]!;
    setupInvestorBond(world, city, group, 10, 0);
    accrueTo(world, city, 1, 6);
    ensureInvestorOpeningShares(world);

    const report = investorFundingReport(world).find((entry) => entry.cityId === city.id)!;
    expect(report.investorNetWorth).toBeCloseTo(cityInvestorEquity(world, city.id), 2);
    const totalShares = round2(
      report.householdShares.reduce((sum, share) => sum + share.effectiveShares, 0),
    );
    const totalRatio = report.householdShares.reduce((sum, share) => sum + share.shareRatio, 0);
    expect(totalShares).toBeCloseTo(totalEffectiveShares(world, city.id), 2);
    expect(totalRatio).toBeCloseTo(1, 2);
    for (const share of report.householdShares) {
      expect(share.effectiveShares).toBeCloseTo(share.shares + share.openingShares, 2);
    }
    for (const entry of report.groups) {
      expect(entry.netWorth).toBeCloseTo(round2(entry.cash + entry.holdingsValue + entry.bondsValue), 2);
    }
  });
});
