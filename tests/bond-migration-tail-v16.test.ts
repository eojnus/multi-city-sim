// v1.6 §P5（PLAN D4 方案①：内部高精度份额）：债券跨城迁移微小权益尾差。
//
// 验收复现（v1.5 缺陷）：A 城投资实体只持 1 份未到期债券（面额 1000，本金 1000，现金/股票为 0），
// 迁移者按份额应带走 4 信用点。v1.5 把迁移份数四舍五入到 0.01 份粒度（= 面额×0.01 = 10 信用点），
// 4 信用点 < 10 信用点 → round 成 0 份，实际转移 0，4 信用点权益留在源城实体被剩余居民无偿获得。
//
// v1.6 修复口径：
// - 本金以信用点“分”（round2）为权威粒度；持债份数不再四舍五入到 0.01 份，而是内部按
//   `本金 / 面额` 保留全精度（面额 1000 时 1 分 = 1e-5 份，优于要求的 1e-6 份级）；
//   展示/兑付只在既有分币口径结算，不需要新增 tailPrincipal 存档字段、不改发型批次与兑付规则。
// - 守恒证明（本测试逐条断言）：
//   ① 源实体持债本金减少 = 目标实体持债本金增加（同一发行批次全体持有人本金合计不变）；
//   ② 全体 active 持债本金合计 = 发行批次 principal = soldUnits × faceValue；
//   ③ 全体 active 持债份数合计 = 发行批次 soldUnits；
//   ④ 每笔持债 “本金 = round2(份数×面额)” 成立（全精度下精确，远小于不变量 0.01 容差）；
//   ⑤ 迁移者 / 源城剩余居民 / 迁入地原居民三方权益价值不因迁移改变；不凭空造现金/债券/利息；
//   ⑥ 后续付息、到期兑付、破产兑付按拆分后的真实持债逐笔结算，不重复支付。
import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation/core/simulation';
import { DEMO_CONFIG } from '../src/data/config';
import type {
  BondHolder,
  BondHolding,
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
} from '../src/simulation/population/household-groups';
import {
  effectiveInvestorShares,
  investorBondValue,
} from '../src/simulation/population/household-investment';
import {
  ensureInvestorOpeningShares,
  transferInvestorAssetsForMigration,
} from '../src/simulation/investors/investors';
import { setCityPopulation } from '../src/simulation/population/population';

const CONFIG = DEMO_CONFIG;
const FACE_VALUE = CONFIG.government.bondMarket.faceValue;

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

/** 某群体按有效份额应占的本城投资实体净资产。 */
function groupShareValue(world: WorldState, cityId: string, group: HouseholdGroup): number {
  const equity = cityInvestorEquity(world, cityId);
  const shares = totalEffectiveShares(world, cityId);
  const own = effectiveInvestorShares(group.investorLedger);
  if (shares <= 0 || own <= 0) return 0;
  return round2((own / shares) * equity);
}

/** 某城投资实体持有的 active 债券权益（本金 + 应计利息）。 */
function cityInvestorBondValue(world: WorldState, cityId: string): number {
  return round2(
    investorsOf(world, cityId).reduce(
      (sum, investor) => sum + investorBondValue(world, investor.id),
      0,
    ),
  );
}

function activeHoldingsOf(world: WorldState, issuanceId: string): BondHolding[] {
  return (world.bonds?.holdings ?? []).filter(
    (holding) => holding.issuanceId === issuanceId && holding.status === 'active',
  );
}

/** active 持债账本合计：份数/本金/应计，用于核对“不重复创造、不消失”。 */
function activeLedgerTotals(world: WorldState, issuanceId: string) {
  const holdings = activeHoldingsOf(world, issuanceId);
  return {
    count: holdings.length,
    units: holdings.reduce((sum, holding) => sum + holding.units, 0),
    principal: round2(holdings.reduce((sum, holding) => sum + holding.principal, 0)),
    accrued: round2(holdings.reduce((sum, holding) => sum + holding.accruedInterest, 0)),
  };
}

/** 持债账本逐笔不变量：本金 = round2(份数×面额)，且份数/本金非负。 */
function expectHoldingInvariants(world: WorldState, issuanceId: string): void {
  const issuance = (world.bonds?.issuances ?? []).find((entry) => entry.id === issuanceId);
  if (!issuance) throw new Error(`缺少债券批次 ${issuanceId}`);
  for (const holding of activeHoldingsOf(world, issuanceId)) {
    expect(holding.units).toBeGreaterThanOrEqual(0);
    expect(holding.principal).toBeGreaterThanOrEqual(0);
    // v1.6：份数为内部全精度值，本金仍是分；round2 后必须严格相等（不是仅在 0.01 容差内）。
    expect(round2(holding.units * issuance.faceValue)).toBe(holding.principal);
  }
  const totals = activeLedgerTotals(world, issuanceId);
  expect(round2(totals.principal)).toBe(issuance.principal);
  expect(totals.units).toBeCloseTo(issuance.soldUnits, 6);
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

/** 发行 units 份（面额 1000）国债并让指定投资实体全额认购，关闭认购窗口。 */
function setupInvestorBond(
  world: WorldState,
  city: City,
  group: InvestorGroup,
  units: number,
  tick = 0,
) {
  world.time.tick = tick;
  city.treasury = 0;
  group.cash = Math.max(group.cash, units * FACE_VALUE + 100_000);
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
 * 验收复现夹具（v1.6 版）：A 城投资实体只有 1 份未到期债券（本金 1,000，现金/股票为 0），
 * A 城失业群体 4 份 + 生产群体 996 份（合计 1,000 份，净值/份 = 1）；
 * B 城实体现金 1,000、管理群体 1,000 份（净值/份 = 1）。
 * 失业群体整群迁出 → 迁移价值 4 信用点（= 1000 × 4/1000），低于旧 0.01 份粒度门槛 10 信用点。
 */
function setupFourCreditRepro() {
  const world = newWorld();
  const from = cityAt(world, 0);
  const to = cityAt(world, 1);
  const bondGroup = investorsOf(world, from.id)[0]!;
  const issuance = setupInvestorBond(world, from, bondGroup, 1, 0);
  seedInvestorCash(world, from, 0);
  seedInvestorCash(world, to, 1_000);
  seedHouseholdShares(world, from.id, { unemployed: 4, production: 996 });
  seedHouseholdShares(world, to.id, { management: 1_000 });
  ensureInvestorOpeningShares(world);
  return { world, from, to, issuance };
}

describe('v1.6 §P5 债券跨城迁移微小权益尾差（内部高精度份额）', () => {
  it('验收复现：只持债券、应带走 4 信用点（<旧最小单位 10）的迁移 → 权益守恒、不再转出 0', () => {
    const { world, from, to, issuance } = setupFourCreditRepro();

    // 迁移前三方价值：A 净值/份 = 1，B 净值/份 = 1。
    expect(cityInvestorEquity(world, from.id)).toBe(1_000);
    expect(cityInvestorEquity(world, to.id)).toBe(1_000);
    expect(navOf(world, from.id)).toBe(1);
    expect(navOf(world, to.id)).toBe(1);
    const source = groupOf(world, from.id, 'unemployed');
    const remainingResident = groupOf(world, from.id, 'production');
    const originalToResident = groupOf(world, to.id, 'management');
    const migrantValueBefore = groupShareValue(world, from.id, source);
    const remainingValueBefore = groupShareValue(world, from.id, remainingResident);
    const originalToValueBefore = groupShareValue(world, to.id, originalToResident);
    expect(migrantValueBefore).toBe(4);
    expect(remainingValueBefore).toBe(996);
    expect(originalToValueBefore).toBe(1_000);

    const sourceHoldingsBefore = activeHoldingsOf(world, issuance.id);
    const sourcePrincipalBefore = round2(
      sourceHoldingsBefore.reduce((sum, holding) => sum + holding.principal, 0),
    );
    const moving = source.people;
    const result = transferInvestorAssetsForMigration(world, from.id, to.id, moving, moving);

    // 关键回归：4 信用点真实转出（旧实现 0.01 份粒度下 = 0）。
    expect(result.bondValueMoved).toBe(4);
    expect(result.bondValueMoved).toBeGreaterThan(0);
    expect(result.valueMoved).toBe(4);
    expect(result.effectiveSharesMoved).toBe(4);
    expect(result.targetSharesAdded).toBe(4);
    expect(result.cashMoved).toBe(0);
    expect(result.holdingsMoved).toBe(0);

    // ① 源实体本金减少 = 目标实体本金增加（守恒等式）。
    const sourcePrincipalAfter = round2(
      activeHoldingsOf(world, issuance.id)
        .filter((holding) => investorsOf(world, from.id).some((i) => i.id === holding.holder.id))
        .reduce((sum, holding) => sum + holding.principal, 0),
    );
    const targetPrincipalAfter = round2(
      activeHoldingsOf(world, issuance.id)
        .filter((holding) => investorsOf(world, to.id).some((i) => i.id === holding.holder.id))
        .reduce((sum, holding) => sum + holding.principal, 0),
    );
    expect(round2(sourcePrincipalBefore - sourcePrincipalAfter)).toBe(targetPrincipalAfter);
    expect(targetPrincipalAfter).toBe(4);

    // ② 全体持有人本金合计不变，且等于发行批次 principal = soldUnits × faceValue。
    const totals = activeLedgerTotals(world, issuance.id);
    expect(totals.principal).toBe(issuance.principal);
    expect(totals.principal).toBe(1_000);
    // ③ 份数合计 = soldUnits（内部全精度，不再有 0.01 份粒度尾差）。
    expect(totals.units).toBeCloseTo(issuance.soldUnits, 6);
    expect(totals.units).toBeCloseTo(1, 6);
    // ④ 逐笔“本金 = 份数×面额”，目标持债为 4/1000 = 0.004 份（不再被 round 成 0）。
    expectHoldingInvariants(world, issuance.id);
    const targetUnits = activeHoldingsOf(world, issuance.id)
      .filter((holding) => investorsOf(world, to.id).some((i) => i.id === holding.holder.id))
      .reduce((sum, holding) => sum + holding.units, 0);
    expect(targetUnits).toBeCloseTo(0.004, 9);

    // ⑤ 三方价值守恒：迁移者拿到 4，源城剩余居民 996，迁入地原居民 1,000 不变。
    expect(navOf(world, from.id)).toBe(1);
    expect(navOf(world, to.id)).toBe(1);
    expect(groupShareValue(world, to.id, groupOf(world, to.id, 'unemployed'))).toBe(
      migrantValueBefore,
    );
    expect(groupShareValue(world, from.id, remainingResident)).toBe(remainingValueBefore);
    expect(groupShareValue(world, to.id, originalToResident)).toBe(originalToValueBefore);
    expect(
      round2(migrantValueBefore + remainingValueBefore + originalToValueBefore),
    ).toBe(2_000);

    // 不凭空造现金：两城投资实体现金合计仍是 1,000（迁移只拆债券，不动现金）。
    expect(round2(cashOfInvestors(world, from.id) + cashOfInvestors(world, to.id))).toBe(1_000);
    expect(cityInvestorBondValue(world, from.id)).toBe(996);
    expect(cityInvestorBondValue(world, to.id)).toBe(4);
    expect(checkInvariants(world)).toEqual([]);
  });

  it('连续 10 次小额迁移（每次 4 信用点）累计不丢不重，到期兑付按真实持债结算', () => {
    const world = newWorld();
    const from = cityAt(world, 0);
    const to = cityAt(world, 1);
    const bondGroup = investorsOf(world, from.id)[0]!;
    const issuance = setupInvestorBond(world, from, bondGroup, 1, 0);
    seedInvestorCash(world, from, 0);
    seedInvestorCash(world, to, 1_000);
    seedHouseholdShares(world, from.id, { unemployed: 400, production: 600 });
    seedHouseholdShares(world, to.id, { management: 1_000 });
    ensureInvestorOpeningShares(world);
    const source = groupOf(world, from.id, 'unemployed');
    // 固定“人均 4 份”：把源城失业群体人数压缩到 100（有效份额 400 = 4 份/人），
    // 并同步城市人口账本，保证不变量“群体人数合计 = 城市总人口 / 劳动力口径”仍成立。
    const originalSourcePeople = source.people;
    const fromEmployed = from.population.employed;
    let fromTotal = from.population.total;
    let fromLaborForce = from.population.laborForce;
    const shrink = originalSourcePeople - 100;
    expect(shrink).toBeGreaterThanOrEqual(0);
    source.people = 100;
    fromTotal -= shrink;
    fromLaborForce -= shrink;
    setCityPopulation(from, fromTotal, fromLaborForce, fromEmployed);
    // 目标实体是 3 个投资实体；同一（批次, 持有实体）应合并为 1 条 active 持债。
    const targetInvestorIds = investorsOf(world, to.id).map((investor) => investor.id);
    const targetHoldingRows = () =>
      activeHoldingsOf(world, issuance.id).filter((holding) =>
        targetInvestorIds.includes(holding.holder.id),
      ).length;

    let movedTotal = 0;
    let rowsAfterFirst = 0;
    for (let step = 1; step <= 10; step += 1) {
      const result = transferInvestorAssetsForMigration(world, from.id, to.id, 1, 1);
      movedTotal = round2(movedTotal + result.bondValueMoved);
      // 真实迁移后：源城少 1 人，人口与群体账本同步（迁入地群体的模拟人数不参与迁移计算）。
      source.people -= 1;
      fromTotal -= 1;
      fromLaborForce -= 1;
      setCityPopulation(from, fromTotal, fromLaborForce, fromEmployed);
      // 每次真实转出 4 信用点（旧实现在第 1 次就会因 < 10 信用点门槛转出 0）。
      expect(result.bondValueMoved).toBe(4);
      expect(result.valueMoved).toBe(4);
      expect(result.targetSharesAdded).toBe(4);
      // 守恒等式：本次迁移的债券价值 = 源城本金减少 = 迁入地本金增加。
      const sourcePrincipal = round2(
        activeHoldingsOf(world, issuance.id)
          .filter((holding) => investorsOf(world, from.id).some((i) => i.id === holding.holder.id))
          .reduce((sum, holding) => sum + holding.principal, 0),
      );
      const targetPrincipal = round2(
        activeHoldingsOf(world, issuance.id)
          .filter((holding) => targetInvestorIds.includes(holding.holder.id))
          .reduce((sum, holding) => sum + holding.principal, 0),
      );
      expect(sourcePrincipal).toBe(round2(1_000 - 4 * step));
      expect(targetPrincipal).toBe(round2(4 * step));
      expect(round2(sourcePrincipal + targetPrincipal)).toBe(issuance.principal);
      expect(round2(sourcePrincipal + targetPrincipal)).toBe(1_000);
      expectHoldingInvariants(world, issuance.id);
      expect(checkInvariants(world)).toEqual([]);
      if (step === 1) rowsAfterFirst = targetHoldingRows();
    }
    expect(movedTotal).toBe(40);
    expect(rowsAfterFirst).toBeGreaterThan(0);
    // 多次迁移不产生碎片：目标实体持债行数在首次拆分后保持不变（全部并入）。
    expect(targetHoldingRows()).toBe(rowsAfterFirst);

    // 到期兑付：累计 36 个月，A 剩余 960 本金、B 累计 40 本金，按真实持债收本息。
    accrueTo(world, from, 1, 36);
    expect(activeLedgerTotals(world, issuance.id).accrued).toBe(120); // 1000 × 4% × 3 年
    const cashFromBefore = cashOfInvestors(world, from.id);
    const cashToBefore = cashOfInvestors(world, to.id);
    from.treasury = 5_000;
    const maturity = settleBondMaturity(world, from, CONFIG, issuance.id, 36, []);
    expect(maturity.ok).toBe(true);
    expect(maturity.principalPaid).toBe(1_000);
    expect(maturity.interestPaid).toBe(120);
    // 源城实体：960 本金 + 115.2 利息；迁入地实体：40 本金 + 4.8 利息（合计守恒）。
    expect(round2(cashOfInvestors(world, from.id) - cashFromBefore)).toBe(1_075.2);
    expect(round2(cashOfInvestors(world, to.id) - cashToBefore)).toBe(44.8);
    expect(round2(cashOfInvestors(world, from.id) - cashFromBefore)).toBe(
      round2(960 + 960 * 0.04 * 3),
    );
    expect(round2(cashOfInvestors(world, to.id) - cashToBefore)).toBe(round2(40 + 40 * 0.04 * 3));
    expect(activeHoldingsOf(world, issuance.id)).toHaveLength(0);
    expect(issuance.status).toBe('redeemed');
    expect(issuance.principalRepaid).toBe(1_000);
    expect(issuance.interestPaid).toBe(120);
    // 幂等：已兑付批次再次调用不重复支付。
    const cashTotalAfter = round2(
      cashOfInvestors(world, from.id) + cashOfInvestors(world, to.id),
    );
    const again = settleBondMaturity(world, from, CONFIG, issuance.id, 36, []);
    expect(again.principalPaid).toBe(0);
    expect(again.interestPaid).toBe(0);
    expect(
      round2(cashOfInvestors(world, from.id) + cashOfInvestors(world, to.id)),
    ).toBe(cashTotalAfter);
    expect(checkInvariants(world)).toEqual([]);
  });

  it('拆分后付息：两城实体按各自真实本金计息收息，兑付规则不变、无重复', () => {
    const { world, from, to, issuance } = setupFourCreditRepro();
    const source = groupOf(world, from.id, 'unemployed');
    const moving = source.people;
    transferInvestorAssetsForMigration(world, from.id, to.id, moving, moving);
    const cashFromBefore = cashOfInvestors(world, from.id);
    const cashToBefore = cashOfInvestors(world, to.id);

    accrueTo(world, from, 1, 12);
    // 10,000... 本例本金 1,000 × 4% × 12/12 = 40：A 996 本金计 39.84，B 4 本金计 0.16。
    const totals = activeLedgerTotals(world, issuance.id);
    expect(totals.accrued).toBe(40);
    from.treasury = 1_000;
    const paid = payBondCoupon(world, from, CONFIG, issuance.id, 12, []);
    expect(paid.ok).toBe(true);
    expect(paid.interestPaid).toBe(40);

    expect(round2(cashOfInvestors(world, from.id) - cashFromBefore)).toBe(39.84);
    expect(round2(cashOfInvestors(world, to.id) - cashToBefore)).toBe(0.16);
    // 付息后持债本金不变、应计清零（不重复计息）。
    expect(activeLedgerTotals(world, issuance.id).principal).toBe(1_000);
    expect(activeLedgerTotals(world, issuance.id).accrued).toBe(0);
    expect(cityInvestorBondValue(world, from.id)).toBe(996);
    expect(cityInvestorBondValue(world, to.id)).toBe(4);
    // 两城净资产均增加本城实体的真实票息。
    expect(cityInvestorEquity(world, from.id)).toBe(1_035.84);
    expect(cityInvestorEquity(world, to.id)).toBe(1_004.16);
    // 迁入地原居民与迁移者按 B 城份额共享这 0.16 利息（既有“城基金按份额共享”口径）。
    expect(round2(
      cityInvestorEquity(world, from.id) + cityInvestorEquity(world, to.id),
    )).toBe(2_040);
    expect(checkInvariants(world)).toEqual([]);
  });

  it('破产兑付：拆分后本金+已计提利息由银行垫付兑付，两城实体都收到、不重复', () => {
    const { world, from, to, issuance } = setupFourCreditRepro();
    const source = groupOf(world, from.id, 'unemployed');
    const moving = source.people;
    transferInvestorAssetsForMigration(world, from.id, to.id, moving, moving);
    const cashFromBefore = cashOfInvestors(world, from.id);
    const cashToBefore = cashOfInvestors(world, to.id);

    accrueTo(world, from, 1, 6);
    // 6 个月应计利息 = 1,000 × 4% × 6/12 = 20：A 19.92、B 0.08。
    const cashToBeforeRedemption = cashOfInvestors(world, to.id);
    const redemption = settleBondBankruptcyRedemption(world, from, CONFIG, 6, []);
    expect(redemption.ok).toBe(true);
    expect(redemption.principalPaid).toBe(1_000);
    expect(redemption.interestPaid).toBe(20);
    expect(round2(cashOfInvestors(world, from.id) - cashFromBefore)).toBe(1_015.92);
    expect(round2(cashOfInvestors(world, to.id) - cashToBeforeRedemption)).toBe(4.08);
    expect(activeHoldingsOf(world, issuance.id)).toHaveLength(0);
    // 幂等：已兑付后再次破产兑付不再支付。
    const again = settleBondBankruptcyRedemption(world, from, CONFIG, 7, []);
    expect(again.principalPaid).toBe(0);
    expect(again.interestPaid).toBe(0);
    expect(
      round2(cashOfInvestors(world, from.id) + cashOfInvestors(world, to.id)),
    ).toBe(round2(cashFromBefore + cashToBefore + 1_020));
    expect(checkInvariants(world)).toEqual([]);
  });

  it('存档往返：全精度拆分持债通过校验，往返一致、二次读取幂等且不重复拆', () => {
    const { world, from, to, issuance } = setupFourCreditRepro();
    const source = groupOf(world, from.id, 'unemployed');
    const moving = source.people;
    transferInvestorAssetsForMigration(world, from.id, to.id, moving, moving);
    accrueTo(world, from, 1, 6);

    const holdingsBefore = activeHoldingsOf(world, issuance.id).map((holding) => ({
      id: holding.id,
      holderKind: holding.holder.kind,
      holderId: holding.holder.id,
      units: holding.units,
      principal: holding.principal,
      accruedInterest: holding.accruedInterest,
    }));
    const fromEquityBefore = cityInvestorEquity(world, from.id);
    const toEquityBefore = cityInvestorEquity(world, to.id);

    const parsed = parseSave(serializeSave(world, 'bond-migration-tail-v16'));
    expect(parsed.ok, parsed.error).toBe(true);
    const restored = parsed.world!;
    const holdingsAfter = activeHoldingsOf(restored, issuance.id).map((holding) => ({
      id: holding.id,
      holderKind: holding.holder.kind,
      holderId: holding.holder.id,
      units: holding.units,
      principal: holding.principal,
      accruedInterest: holding.accruedInterest,
    }));
    expect(holdingsAfter).toEqual(holdingsBefore);
    expect(activeLedgerTotals(restored, issuance.id).principal).toBe(issuance.principal);
    expectHoldingInvariants(restored, issuance.id);
    expect(cityInvestorEquity(restored, from.id)).toBeCloseTo(fromEquityBefore, 2);
    expect(cityInvestorEquity(restored, to.id)).toBeCloseTo(toEquityBefore, 2);
    expect(checkInvariants(restored)).toEqual([]);

    // 二次往返幂等：不重复拆、不重复计债券/利息。
    const reparsed = parseSave(serializeSave(restored, 'bond-migration-tail-v16-2'));
    expect(reparsed.ok, reparsed.error).toBe(true);
    expect(activeHoldingsOf(reparsed.world!, issuance.id)).toHaveLength(holdingsBefore.length);
    expect(activeLedgerTotals(reparsed.world!, issuance.id).principal).toBe(issuance.principal);
    expect(activeLedgerTotals(reparsed.world!, issuance.id).accrued).toBe(
      activeLedgerTotals(world, issuance.id).accrued,
    );
    expect(cityInvestorEquity(reparsed.world!, from.id)).toBeCloseTo(fromEquityBefore, 2);
    expect(cityInvestorEquity(reparsed.world!, to.id)).toBeCloseTo(toEquityBefore, 2);
    expect(checkInvariants(reparsed.world!)).toEqual([]);
  });
});
