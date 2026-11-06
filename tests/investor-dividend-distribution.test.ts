// v1.5 §2：投资实体只有未到期债券（无可变现现金/股票）时，跨城迁移权益不得丢失、不得无偿转移。
//
// 验收复现：A 城投资实体只有 10,000 未到期政府债券（现金/股票为 0），某迁移人口持有价值 5,000
// 的权益，迁到 B 城。v1.4 迁移只划转现金/股票 → 实际转移 0，迁出份额被下调（权益丢失），
// 剩余债券权益留在 A 城被剩余居民无偿获得。
//
// 修复口径（v1.5 §2）：迁移时按“迁移价值 / 源城投资实体净资产”的比例，把未到期债券按
// 0.01 份粒度真实拆分到目标城实体（本金/应计利息/已付利息按比例拆分，合计严格守恒）；
// 现金/股票仍按原逻辑划转，目标城按净值增发份额。债券拆分只发生在 `status='active'` 的持债上，
// 发行批次 soldUnits/principal 与后续付息/到期/破产兑付规则完全不变；同一（发行批次,持有实体）
// 合并为一条 active 持债，避免多次迁移产生碎片。
//
// 三方口径（分别断言，不只验全球资产总和）：
// - 迁移者：迁出前 份额×源城净值/份，迁入后 目标城份额×目标城净值/份，两者相等（债券利息等
//   后续收益按目标城份额在目标城基金内部按份额共享，这是既有的“城基金”口径）；
// - 迁出地其他居民：源城剩余份额 × 源城净值/份 不因迁移改变；
// - 迁入地原居民：目标城原份额 × 目标城净值/份 不因迁入改变；
// - 分红归属：迁移后迁入者按目标城有效份额参与目标城股息返还，不再占源城份额。
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
} from '../src/simulation/population/household-investment';
import { setCityPopulation } from '../src/simulation/population/population';
import {
  allocateResidentDividendReturns,
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
  return shares > 0 ? round2(cityInvestorEquity(world, cityId) / shares) : 0;
}

function cashOfInvestors(world: WorldState, cityId: string): number {
  return round2(investorsOf(world, cityId).reduce((sum, investor) => sum + investor.cash, 0));
}

/** 某群体按有效份额应占的本城投资实体净资产（不经过“每份净值”round2，避免二次舍入）。 */
function groupShareValue(
  world: WorldState,
  cityId: string,
  group: HouseholdGroup,
): number {
  const equity = cityInvestorEquity(world, cityId);
  const shares = totalEffectiveShares(world, cityId);
  const own = effectiveInvestorShares(group.investorLedger);
  if (shares <= 0 || own <= 0) return 0;
  return round2((own / shares) * equity);
}

function bondsOfInvestors(world: WorldState, cityId: string): number {
  return round2(
    investorsOf(world, cityId).reduce(
      (sum, investor) => sum + investorBondValue(world, investor.id),
      0,
    ),
  );
}

/** 全库 active 债券权益合计（本金 + 应计利息），用于核对“拆分不重复计、不消失”。 */
function totalActiveBondValue(world: WorldState): number {
  return round2(
    (world.bonds?.holdings ?? [])
      .filter((holding) => holding.status === 'active')
      .reduce((sum, holding) => sum + holding.principal + holding.accruedInterest, 0),
  );
}

/**
 * 测试夹具：把某城投资实体净资产收敛为“现金（+ 既有债券）”，便于按任务书数字精确构造。
 * 投资实体原持股改挂市政府（股份总股数不变），现金集中到第一个实体。
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

/** 测试夹具：清空投资实体现金但保留股票持仓（用于“债券+股票+现金不足”场景）。 */
function zeroInvestorCash(world: WorldState, cityId: string): void {
  for (const investor of investorsOf(world, cityId)) investor.cash = 0;
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

function bondHolderRef(group: InvestorGroup): BondHolder {
  return { kind: 'investorGroup', id: group.id };
}

/** 发行 units 份（面额 1,000）国债并让指定投资实体全额认购，关闭认购窗口。 */
function setupInvestorBond(
  world: WorldState,
  city: City,
  group: InvestorGroup,
  units: number,
  tick = 0,
) {
  world.time.tick = tick;
  city.treasury = 0;
  group.cash = Math.max(group.cash, units * CONFIG.government.bondMarket.faceValue + 100_000);
  const issued = issueGovernmentBond(world, city, CONFIG, units, tick);
  expect(issued.ok).toBe(true);
  const issuance = issued.issuance!;
  const subscribed = subscribeGovernmentBond(
    world,
    CONFIG,
    issuance.id,
    bondHolderRef(group),
    units,
    tick,
  );
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

/**
 * 验收复现夹具：A 城投资实体只有 10 份未到期债券（10,000 本金，现金/股票为 0），1,000 份
 * 由 A 城失业群体 500 份 + 生产群体 500 份持有；B 城实体现金 1,000、1,000 份（管理群体）。
 */
function setupBondOnlyRepro() {
  const world = newWorld();
  const from = cityAt(world, 0);
  const to = cityAt(world, 1);
  const bondGroup = investorsOf(world, from.id)[0]!;
  const issuance = setupInvestorBond(world, from, bondGroup, 10, 0);
  seedInvestorCash(world, from, 0);
  seedInvestorCash(world, to, 1_000);
  seedHouseholdShares(world, from.id, { unemployed: 500, production: 500 });
  seedHouseholdShares(world, to.id, { management: 1_000 });
  ensureInvestorOpeningShares(world);
  return { world, from, to, issuance, bondGroup };
}

describe('v1.5 §2 债券无流动性时的跨城迁移权益（不丢失、不无偿转移）', () => {
  it('验收复现：A 城实体仅 10,000 未到期债券、迁移者持 5,000，迁入 B 城后三方权益价值均不变', () => {
    const { world, from, to } = setupBondOnlyRepro();

    // 迁出前：A = 债券 10,000 / 1,000 份（净值 10），B = 现金 1,000 / 1,000 份（净值 1）。
    expect(cityInvestorEquity(world, from.id)).toBe(10_000);
    expect(cityInvestorEquity(world, to.id)).toBe(1_000);
    expect(cashOfInvestors(world, from.id)).toBe(0);
    expect(navOf(world, from.id)).toBe(10);
    expect(navOf(world, to.id)).toBe(1);
    const source = groupOf(world, from.id, 'unemployed');
    const remainingResident = groupOf(world, from.id, 'production');
    const originalToResident = groupOf(world, to.id, 'management');
    const migrantValueBefore = round2(500 * navOf(world, from.id));
    const remainingValueBefore = round2(500 * navOf(world, from.id));
    const originalToValueBefore = round2(1_000 * navOf(world, to.id));
    expect(migrantValueBefore).toBe(5_000);

    const moving = source.people;
    const result = transferInvestorAssetsForMigration(world, from.id, to.id, moving, moving);

    // 真实转移：迁移价值 5,000 全部由“债券拆分”承接（无现金、无股票），不是 0。
    expect(result.effectiveSharesMoved).toBe(500);
    expect(result.valueMoved).toBe(5_000);
    expect(result.bondValueMoved).toBe(5_000);
    expect(result.bondHoldingsMoved).toBeGreaterThan(0);
    expect(result.cashMoved).toBe(0);
    expect(result.holdingsMoved).toBe(0);
    expect(result.targetSharesAdded).toBe(5_000);

    // 迁出后：A = 债券 5,000 / 500 份（净值 10）；B = 现金 1,000 + 债券 5,000 / 6,000 份（净值 1）。
    expect(totalActiveBondValue(world)).toBe(10_000);
    expect(bondsOfInvestors(world, from.id)).toBe(5_000);
    expect(bondsOfInvestors(world, to.id)).toBe(5_000);
    expect(navOf(world, from.id)).toBe(10);
    expect(navOf(world, to.id)).toBe(1);
    expect(totalEffectiveShares(world, from.id)).toBe(500);
    expect(totalEffectiveShares(world, to.id)).toBe(6_000);

    // 三方分别核验：迁移者/迁出地其他居民/迁入地原居民权益价值均不被无偿转移。
    const migrantValueAfter = groupShareValue(world, to.id, groupOf(world, to.id, 'unemployed'));
    expect(migrantValueAfter).toBe(migrantValueBefore);
    expect(groupShareValue(world, from.id, remainingResident)).toBe(remainingValueBefore);
    expect(groupShareValue(world, to.id, originalToResident)).toBe(originalToValueBefore);
    expect(round2(migrantValueAfter + remainingValueBefore + originalToValueBefore)).toBe(11_000);

    // 不凭空造现金、不重复计债券：现金合计不变、债券本金合计不变。
    expect(round2(cashOfInvestors(world, from.id) + cashOfInvestors(world, to.id))).toBe(1_000);
    // 报告口径与 §3 一致：投资实体净资产含债券。
    const fromReport = investorFundingReport(world).find((entry) => entry.cityId === from.id)!;
    const toReport = investorFundingReport(world).find((entry) => entry.cityId === to.id)!;
    expect(fromReport.investorNetWorth).toBe(5_000);
    expect(toReport.investorNetWorth).toBe(6_000);
    expect(
      round2(fromReport.groups.reduce((sum, group) => sum + group.bondsValue, 0)),
    ).toBe(5_000);
    expect(round2(toReport.groups.reduce((sum, group) => sum + group.bondsValue, 0))).toBe(5_000);
    expect(checkInvariants(world)).toEqual([]);
  });

  it('多次迁移不产生碎片：同一（发行批次,持有实体）始终最多 1 条 active 持债，合计份数/本金守恒', () => {
    const world = newWorld();
    const from = cityAt(world, 0);
    const to = cityAt(world, 1);
    const bondGroup = investorsOf(world, from.id)[0]!;
    const issuance = setupInvestorBond(world, from, bondGroup, 100, 0);
    seedInvestorCash(world, from, 0);
    seedInvestorCash(world, to, 1_000);
    seedHouseholdShares(world, from.id, { unemployed: 1_000 });
    seedHouseholdShares(world, to.id, { management: 1_000 });
    ensureInvestorOpeningShares(world);
    const source = groupOf(world, from.id, 'unemployed');
    // 按人数比例分批迁出：每次约迁源群体的 1/10（不手工改 people，保持人口账本自洽）。
    const moving = Math.max(1, Math.round(source.people / 10));

    const destinationHoldingsCount = () =>
      world.bonds!.holdings.filter(
        (holding) =>
          holding.issuanceId === issuance.id &&
          holding.status === 'active' &&
          holding.holder.kind === 'investorGroup' &&
          holding.holder.id.startsWith(to.id),
      ).length;
    const counts: number[] = [];
    for (let step = 0; step < 5; step += 1) {
      const result = transferInvestorAssetsForMigration(world, from.id, to.id, moving, moving);
      expect(result.effectiveSharesMoved).toBeGreaterThan(0);
      expect(result.bondValueMoved).toBeGreaterThan(0);
      counts.push(destinationHoldingsCount());
    }
    // 首次迁移建立拆分持债后，后续迁移全部并入，不再新增行。
    expect(counts[0]).toBeGreaterThan(0);
    expect(counts[0]).toBeLessThanOrEqual(investorsOf(world, to.id).length);
    for (const count of counts.slice(1)) expect(count).toBe(counts[0]);
    // 每（发行批次,持有实体）最多 1 条 active 持债。
    const byHolder = new Map<string, number>();
    for (const holding of world.bonds!.holdings) {
      if (holding.issuanceId !== issuance.id || holding.status !== 'active') continue;
      const key = `${holding.holder.kind}:${holding.holder.id}`;
      byHolder.set(key, (byHolder.get(key) ?? 0) + 1);
    }
    for (const count of byHolder.values()) expect(count).toBe(1);
    // 债券账本闭合：份数/本金合计仍等于发行成交额，不因拆分凭空增减。
    const activeHoldings = world.bonds!.holdings.filter(
      (holding) => holding.issuanceId === issuance.id && holding.status === 'active',
    );
    expect(round2(activeHoldings.reduce((sum, holding) => sum + holding.units, 0))).toBeCloseTo(
      issuance.soldUnits,
      2,
    );
    expect(
      round2(activeHoldings.reduce((sum, holding) => sum + holding.principal, 0)),
    ).toBeCloseTo(issuance.principal, 2);
    for (const holding of activeHoldings) {
      expect(holding.principal).toBeCloseTo(holding.units * issuance.faceValue, 2);
    }
    // 两城净值与总额守恒；源城剩余居民与迁入地原居民价值不变。
    expect(navOf(world, from.id)).toBeCloseTo(100, 1);
    expect(navOf(world, to.id)).toBeCloseTo(1, 2);
    expect(
      round2(cityInvestorEquity(world, from.id) + cityInvestorEquity(world, to.id)),
    ).toBeCloseTo(101_000, 2);
    expect(checkInvariants(world)).toEqual([]);
  });

  it('目标实体已有同批次持债（跨城认购）时并入该持债，不新建重复行', () => {
    const world = newWorld();
    const from = cityAt(world, 0);
    const to = cityAt(world, 1);
    world.time.tick = 0;
    from.treasury = 0;
    const fromInvestor = investorsOf(world, from.id)[0]!;
    const toInvestor = investorsOf(world, to.id)[0]!;
    // 同一批次：A 城实体认购 5 份、B 城实体（跨城）认购 5 份。
    fromInvestor.cash = 1_000_000;
    toInvestor.cash = 1_000_000;
    const issued = issueGovernmentBond(world, from, CONFIG, 10, 0);
    const issuance = issued.issuance!;
    const ref = (group: InvestorGroup): BondHolder => ({ kind: 'investorGroup', id: group.id });
    expect(subscribeGovernmentBond(world, CONFIG, issuance.id, ref(fromInvestor), 5, 0).units).toBe(5);
    expect(subscribeGovernmentBond(world, CONFIG, issuance.id, ref(toInvestor), 5, 0).units).toBe(5);
    expect(closeGovernmentBondSubscription(world, CONFIG, issuance.id, 0).ok).toBe(true);
    // 夹具：A 实体 = 债券 5,000 + 现金 5,000 = 10,000 / 1,000 份；B 实体 = 债券 5,000 + 现金 1,000 / 1,000 份。
    seedInvestorCash(world, from, 5_000);
    seedInvestorCash(world, to, 1_000);
    seedHouseholdShares(world, from.id, { unemployed: 500, production: 500 });
    seedHouseholdShares(world, to.id, { management: 1_000 });
    ensureInvestorOpeningShares(world);
    expect(navOf(world, from.id)).toBe(10);
    expect(navOf(world, to.id)).toBe(6);

    const toHoldingsBefore = world.bonds!.holdings.filter(
      (holding) =>
        holding.issuanceId === issuance.id &&
        holding.status === 'active' &&
        holding.holder.kind === 'investorGroup' &&
        holding.holder.id === toInvestor.id,
    );
    expect(toHoldingsBefore).toHaveLength(1);
    const toUnitsBefore = toHoldingsBefore[0]!.units;

    const source = groupOf(world, from.id, 'unemployed');
    const moving = source.people;
    const result = transferInvestorAssetsForMigration(world, from.id, to.id, moving, moving);

    // 迁移价值 5,000 = 债券 2,500（源值的 50%）+ 现金 2,500；B 城目标份额按 NAV 6 → 833.33 份。
    expect(result.bondValueMoved).toBe(2_500);
    expect(result.cashMoved).toBe(2_500);
    expect(result.valueMoved).toBe(5_000);
    expect(result.targetSharesAdded).toBeCloseTo(833.33, 1);

    // B 城已有同批次 active 持债 → 并入原持有行，不新增第二条。
    const toHoldingsAfter = world.bonds!.holdings.filter(
      (holding) =>
        holding.issuanceId === issuance.id &&
        holding.status === 'active' &&
        holding.holder.kind === 'investorGroup' &&
        holding.holder.id === toInvestor.id,
    );
    expect(toHoldingsAfter).toHaveLength(1);
    expect(toHoldingsAfter[0]!.units).toBeGreaterThan(toUnitsBefore);
    expect(toHoldingsAfter[0]!.principal).toBeCloseTo(
      toHoldingsAfter[0]!.units * issuance.faceValue,
      2,
    );
    // 债券账本合计仍等于发行成交额；每（批次,持有实体）最多 1 条 active 持债。
    const activeHoldings = world.bonds!.holdings.filter(
      (holding) => holding.issuanceId === issuance.id && holding.status === 'active',
    );
    expect(
      round2(activeHoldings.reduce((sum, holding) => sum + holding.units, 0)),
    ).toBeCloseTo(issuance.soldUnits, 2);
    expect(
      round2(activeHoldings.reduce((sum, holding) => sum + holding.principal, 0)),
    ).toBeCloseTo(issuance.principal, 2);
    expect(totalActiveBondValue(world)).toBe(10_000);
    // 两城净值不变、三方价值守恒。
    expect(navOf(world, from.id)).toBe(10);
    expect(navOf(world, to.id)).toBe(6);
    expect(
      round2(cityInvestorEquity(world, from.id) + cityInvestorEquity(world, to.id)),
    ).toBeCloseTo(16_000, 2);
    expect(
      groupShareValue(world, from.id, groupOf(world, from.id, 'production')),
    ).toBe(5_000);
    expect(checkInvariants(world)).toEqual([]);
  });

  it('债券+股票、现金不足：按真实可转移资产比例拆分，两城净值不变、三方价值守恒', () => {
    const world = newWorld();
    const from = cityAt(world, 0);
    const to = cityAt(world, 1);
    const bondGroup = investorsOf(world, from.id)[0]!;
    setupInvestorBond(world, from, bondGroup, 4, 0); // 4,000 债券
    zeroInvestorCash(world, from.id); // 现金 0，但保留原股票持仓
    seedInvestorCash(world, to, 1_000);
    seedHouseholdShares(world, from.id, { unemployed: 500, production: 500 });
    seedHouseholdShares(world, to.id, { management: 1_000 });
    ensureInvestorOpeningShares(world);

    const stocksBefore = round2(
      cityInvestorEquity(world, from.id) - bondsOfInvestors(world, from.id),
    );
    expect(stocksBefore).toBeGreaterThan(0);
    const totalStockSharesBefore = round2(
      world.securities.holdings.reduce((sum, holding) => sum + holding.shares, 0),
    );
    const fromEquityBefore = cityInvestorEquity(world, from.id);
    const toEquityBefore = cityInvestorEquity(world, to.id);
    const fromNavBefore = navOf(world, from.id);
    const toNavBefore = navOf(world, to.id);
    const source = groupOf(world, from.id, 'unemployed');
    const remainingResident = groupOf(world, from.id, 'production');
    const originalToResident = groupOf(world, to.id, 'management');
    const migrantValueBefore = groupShareValue(world, from.id, source);
    const remainingValueBefore = groupShareValue(world, from.id, remainingResident);
    const originalToValueBefore = groupShareValue(world, to.id, originalToResident);

    const moving = source.people;
    const result = transferInvestorAssetsForMigration(world, from.id, to.id, moving, moving);

    // 真实资产按比例转移：债券、股票都动了，且不凭空造现金（两城现金合计仍为 1,000）。
    expect(result.bondValueMoved).toBeGreaterThan(0);
    expect(result.holdingsMoved).toBeGreaterThan(0);
    expect(result.cashMoved).toBe(0);
    expect(round2(cashOfInvestors(world, from.id) + cashOfInvestors(world, to.id))).toBe(1_000);
    // 债券本金合计不变、股票总股数不变。
    expect(totalActiveBondValue(world)).toBe(4_000);
    expect(
      round2(world.securities.holdings.reduce((sum, holding) => sum + holding.shares, 0)),
    ).toBe(totalStockSharesBefore);
    // 两城净值不变（0.1% 容差吸收份数/股数 0.01 粒度的尾差），总净资产守恒。
    expect(navOf(world, from.id)).toBeCloseTo(fromNavBefore, 1);
    expect(navOf(world, to.id)).toBeCloseTo(toNavBefore, 2);
    expect(
      round2(cityInvestorEquity(world, from.id) + cityInvestorEquity(world, to.id)),
    ).toBeCloseTo(round2(fromEquityBefore + toEquityBefore), 2);
    // 三方价值守恒（尾差 < 迁移价值的 0.1%，来自 0.01 份/股取整，不是无偿转移）。
    const migrantValueAfter = groupShareValue(world, to.id, groupOf(world, to.id, 'unemployed'));
    expect(Math.abs(migrantValueAfter - migrantValueBefore)).toBeLessThan(
      Math.max(1, migrantValueBefore * 0.001),
    );
    expect(
      Math.abs(groupShareValue(world, from.id, remainingResident) - remainingValueBefore),
    ).toBeLessThan(Math.max(1, remainingValueBefore * 0.001));
    expect(
      Math.abs(groupShareValue(world, to.id, originalToResident) - originalToValueBefore),
    ).toBeLessThan(Math.max(1, originalToValueBefore * 0.001));
    expect(checkInvariants(world)).toEqual([]);
  });

  it('债券后续付息：拆分后两城实体按各自真实持债收到票息，兑付规则不变、无重复', () => {
    const { world, from, to } = setupBondOnlyRepro();
    const source = groupOf(world, from.id, 'unemployed');
    const moving = source.people;
    transferInvestorAssetsForMigration(world, from.id, to.id, moving, moving);
    const issuanceId = (world.bonds?.issuances ?? [])[0]!.id;
    const holder = investorsOf(world, from.id)[0]!;
    const cashFromBefore = cashOfInvestors(world, from.id);
    const cashToBefore = cashOfInvestors(world, to.id);

    accrueTo(world, from, 1, 12);
    // 10,000 × 4% × 12/12 = 400，A/B 各按 5,000 本金计 200。
    expect(investorBondValue(world, holder.id)).toBe(5_200);
    expect(bondsOfInvestors(world, to.id)).toBe(5_200);
    from.treasury = 1_000;
    const paid = payBondCoupon(world, from, CONFIG, issuanceId, 12, []);
    expect(paid.ok).toBe(true);
    expect(paid.interestPaid).toBe(400);

    expect(round2(cashOfInvestors(world, from.id) - cashFromBefore)).toBe(200);
    expect(round2(cashOfInvestors(world, to.id) - cashToBefore)).toBe(200);
    expect(investorBondValue(world, holder.id)).toBe(5_000);
    expect(bondsOfInvestors(world, to.id)).toBe(5_000);
    // 付息后净资产：A 5,200；B 6,200（原 6,000 + 200）。
    expect(cityInvestorEquity(world, from.id)).toBe(5_200);
    expect(cityInvestorEquity(world, to.id)).toBe(6_200);
    // 三方：A 剩余居民获得 A 实体全部 200 利息；B 实体 200 利息按份额在 B 基金内共享
    // （迁入者 5/6 = 166.67、B 原居民 1/6 = 33.33）——既有“城基金按份额共享”口径。
    expect(groupShareValue(world, from.id, groupOf(world, from.id, 'production'))).toBe(5_200);
    expect(groupShareValue(world, to.id, groupOf(world, to.id, 'unemployed'))).toBe(5_166.67);
    expect(groupShareValue(world, to.id, groupOf(world, to.id, 'management'))).toBe(1_033.33);
    expect(round2(5_200 + 5_166.67 + 1_033.33)).toBe(11_400);
    expect(checkInvariants(world)).toEqual([]);
  });

  it('到期兑付：拆分后的两份真实持债分别收本息，发行状态与总额正确、重复调用不再支付', () => {
    const { world, from, to } = setupBondOnlyRepro();
    const source = groupOf(world, from.id, 'unemployed');
    const moving = source.people;
    transferInvestorAssetsForMigration(world, from.id, to.id, moving, moving);
    const issuanceId = (world.bonds?.issuances ?? [])[0]!.id;
    const cashFromBefore = cashOfInvestors(world, from.id);
    const cashToBefore = cashOfInvestors(world, to.id);

    accrueTo(world, from, 1, 36);
    from.treasury = 20_000;
    const maturity = settleBondMaturity(world, from, CONFIG, issuanceId, 36, []);
    expect(maturity.ok).toBe(true);
    // 本金 10,000、36 个月应计利息 1,200（10,000 × 4% × 36/12），各持债按 5,000 本金收 5,600。
    expect(maturity.principalPaid).toBe(10_000);
    expect(maturity.interestPaid).toBe(1_200);
    expect(round2(cashOfInvestors(world, from.id) - cashFromBefore)).toBe(5_600);
    expect(round2(cashOfInvestors(world, to.id) - cashToBefore)).toBe(5_600);
    expect(bondsOfInvestors(world, from.id)).toBe(0);
    expect(bondsOfInvestors(world, to.id)).toBe(0);
    expect(cityInvestorEquity(world, from.id)).toBe(5_600);
    expect(cityInvestorEquity(world, to.id)).toBe(6_600);
    // 三方：A 剩余居民 5,600（含其 600 利息）；B 基金本息按份额共享 → 迁入者 5,500、原居民 1,100。
    expect(groupShareValue(world, from.id, groupOf(world, from.id, 'production'))).toBe(5_600);
    expect(groupShareValue(world, to.id, groupOf(world, to.id, 'unemployed'))).toBe(5_500);
    expect(groupShareValue(world, to.id, groupOf(world, to.id, 'management'))).toBe(1_100);
    expect(round2(5_600 + 5_500 + 1_100)).toBe(12_200);
    // 幂等：已兑付批次再次调用不重复支付。
    const cashAfter = round2(cashOfInvestors(world, from.id) + cashOfInvestors(world, to.id));
    const again = settleBondMaturity(world, from, CONFIG, issuanceId, 36, []);
    expect(again.principalPaid).toBe(0);
    expect(again.interestPaid).toBe(0);
    expect(round2(cashOfInvestors(world, from.id) + cashOfInvestors(world, to.id))).toBe(cashAfter);
    expect(checkInvariants(world)).toEqual([]);
  });

  it('破产兑付：拆分后本金+已计提利息由银行垫付兑付，两个实体都拿到、不重复', () => {
    const { world, from, to } = setupBondOnlyRepro();
    const source = groupOf(world, from.id, 'unemployed');
    const moving = source.people;
    transferInvestorAssetsForMigration(world, from.id, to.id, moving, moving);
    const cashToBefore = cashOfInvestors(world, to.id);

    accrueTo(world, from, 1, 6);
    const redemption = settleBondBankruptcyRedemption(world, from, CONFIG, 6, []);
    expect(redemption.ok).toBe(true);
    expect(redemption.principalPaid).toBe(10_000);
    expect(redemption.interestPaid).toBe(200);
    expect(cashOfInvestors(world, from.id)).toBe(5_100);
    expect(round2(cashOfInvestors(world, to.id) - cashToBefore)).toBe(5_100);
    expect(bondsOfInvestors(world, from.id)).toBe(0);
    expect(bondsOfInvestors(world, to.id)).toBe(0);
    expect(cityInvestorEquity(world, from.id)).toBe(5_100);
    expect(cityInvestorEquity(world, to.id)).toBe(6_100);
    // 幂等：已兑付后再次破产兑付不再支付。
    const again = settleBondBankruptcyRedemption(world, from, CONFIG, 7, []);
    expect(again.principalPaid).toBe(0);
    expect(again.interestPaid).toBe(0);
    expect(round2(cashOfInvestors(world, from.id) + cashOfInvestors(world, to.id))).toBe(11_200);
    expect(checkInvariants(world)).toEqual([]);
  });

  it('分红归属：迁移后迁入者按 B 城有效份额分红，源城返还只归迁出地剩余居民', () => {
    const { world, from, to } = setupBondOnlyRepro();
    const source = groupOf(world, from.id, 'unemployed');
    const moving = source.people;
    transferInvestorAssetsForMigration(world, from.id, to.id, moving, moving);

    // A 城返还 1,000：只剩生产群体 500 份（100%），迁入者已不占 A 城份额。
    const fromReturns = allocateResidentDividendReturns(world, from.id, 1_000);
    expect(fromReturns.size).toBe(1);
    expect(fromReturns.get(groupOf(world, from.id, 'production').id)).toBe(1_000);
    expect(fromReturns.has(groupOf(world, to.id, 'unemployed').id)).toBe(false);

    // B 城返还 1,200：按有效份额 5,000/6,000 与 1,000/6,000 分配。
    const toReturns = allocateResidentDividendReturns(world, to.id, 1_200);
    expect(toReturns.get(groupOf(world, to.id, 'unemployed').id)).toBe(1_000);
    expect(toReturns.get(groupOf(world, to.id, 'management').id)).toBe(200);
    expect(round2([...toReturns.values()].reduce((sum, value) => sum + value, 0))).toBe(1_200);
  });

  it('人口同步：迁移后 syncHouseholdPeople 不改变两城份额与净值（无零人持份）', () => {
    const { world, from, to } = setupBondOnlyRepro();
    const source = groupOf(world, from.id, 'unemployed');
    const moving = source.people;
    transferInvestorAssetsForMigration(world, from.id, to.id, moving, moving);
    const fromNavBefore = navOf(world, from.id);
    const toNavBefore = navOf(world, to.id);
    const fromSharesBefore = totalEffectiveShares(world, from.id);
    const toSharesBefore = totalEffectiveShares(world, to.id);

    // 真实迁移后的人口变化：源城减少 moving 人（全部来自失业群体），目标城增加同样人数。
    setCityPopulation(
      from,
      from.population.total - moving,
      from.population.laborForce - moving,
      from.population.employed,
    );
    setCityPopulation(
      to,
      to.population.total + moving,
      to.population.laborForce + moving,
      to.population.employed,
    );
    syncHouseholdPeople(world, CONFIG);

    expect(totalEffectiveShares(world, from.id)).toBeCloseTo(fromSharesBefore, 2);
    expect(totalEffectiveShares(world, to.id)).toBeCloseTo(toSharesBefore, 2);
    expect(navOf(world, from.id)).toBeCloseTo(fromNavBefore, 2);
    expect(navOf(world, to.id)).toBeCloseTo(toNavBefore, 2);
    // 零人群体不得持有投资份额。
    for (const city of [from, to]) {
      for (const group of householdGroupsOfCity(world, city.id)) {
        if (group.people <= 0) {
          expect(effectiveInvestorShares(group.investorLedger)).toBeCloseTo(0, 2);
        }
      }
    }
    // 迁移者目标群体人数已按人口同步增加。
    expect(groupOf(world, to.id, 'unemployed').people).toBeGreaterThan(0);
    expect(checkInvariants(world)).toEqual([]);
  });

  it('存档往返：拆分出的跨城持债通过校验，净资产/报告/不变量往返一致且二次读取幂等', () => {
    const { world, from, to } = setupBondOnlyRepro();
    const source = groupOf(world, from.id, 'unemployed');
    const moving = source.people;
    transferInvestorAssetsForMigration(world, from.id, to.id, moving, moving);
    const issuanceId = (world.bonds?.issuances ?? [])[0]!.id;
    accrueTo(world, from, 1, 6);

    const holdingsBefore = (world.bonds?.holdings ?? []).filter(
      (holding) => holding.issuanceId === issuanceId && holding.status === 'active',
    );
    // 拆分后：发行批次同时有“A 城实体持有”和“B 城实体持有”的 active 持债（跨城真实债权）。
    expect(holdingsBefore.length).toBeGreaterThan(1);
    expect(
      holdingsBefore.some(
        (holding) =>
          holding.holder.kind === 'investorGroup' &&
          investorsOf(world, from.id).some((investor) => investor.id === holding.holder.id),
      ),
    ).toBe(true);
    expect(
      holdingsBefore.some(
        (holding) =>
          holding.holder.kind === 'investorGroup' &&
          investorsOf(world, to.id).some((investor) => investor.id === holding.holder.id),
      ),
    ).toBe(true);

    const fromEquityBefore = cityInvestorEquity(world, from.id);
    const toEquityBefore = cityInvestorEquity(world, to.id);
    const fromReportBefore = investorFundingReport(world).find((entry) => entry.cityId === from.id)!;
    const toReportBefore = investorFundingReport(world).find((entry) => entry.cityId === to.id)!;

    const parsed = parseSave(serializeSave(world, 'investor-migration-bonds'));
    expect(parsed.ok, parsed.error).toBe(true);
    const restored = parsed.world!;
    const restoredHoldings = (restored.bonds?.holdings ?? []).filter(
      (holding) => holding.issuanceId === issuanceId && holding.status === 'active',
    );
    expect(restoredHoldings.length).toBe(holdingsBefore.length);
    expect(totalActiveBondValue(restored)).toBe(totalActiveBondValue(world));
    expect(cityInvestorEquity(restored, from.id)).toBeCloseTo(fromEquityBefore, 2);
    expect(cityInvestorEquity(restored, to.id)).toBeCloseTo(toEquityBefore, 2);
    const fromReportAfter = investorFundingReport(restored).find(
      (entry) => entry.cityId === from.id,
    )!;
    const toReportAfter = investorFundingReport(restored).find((entry) => entry.cityId === to.id)!;
    expect(fromReportAfter.investorNetWorth).toBeCloseTo(fromReportBefore.investorNetWorth, 2);
    expect(toReportAfter.investorNetWorth).toBeCloseTo(toReportBefore.investorNetWorth, 2);
    expect(JSON.stringify(fromReportAfter.householdShares)).toBe(
      JSON.stringify(fromReportBefore.householdShares),
    );
    expect(checkInvariants(restored)).toEqual([]);

    // 二次往返幂等：不重复拆、不重复计债券。
    const reparsed = parseSave(serializeSave(restored, 'investor-migration-bonds-2'));
    expect(reparsed.ok, reparsed.error).toBe(true);
    expect(
      (reparsed.world!.bonds?.holdings ?? []).filter(
        (holding) => holding.issuanceId === issuanceId && holding.status === 'active',
      ).length,
    ).toBe(holdingsBefore.length);
    expect(totalActiveBondValue(reparsed.world!)).toBe(totalActiveBondValue(world));
    expect(cityInvestorEquity(reparsed.world!, from.id)).toBeCloseTo(fromEquityBefore, 2);
    expect(cityInvestorEquity(reparsed.world!, to.id)).toBeCloseTo(toEquityBefore, 2);
  });
});
