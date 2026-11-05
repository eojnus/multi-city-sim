// v1.3 §2：居民投资权益随职业/人口/迁移流转与统一归属口径。
//
// 验收复现（修复前）：某职业群体持有投资份额，群体全部失业后人数为 0，但份额与后续分红
// 仍留在空群体；财富统计与居民授信又按人口比例分投资资产，与份额归属不一致。
//
// 修复后口径：
// - 招聘/裁员/职业变更/自然人口变化：投资权益随人转移，按迁出人数占源群体比例拆分
//   （0.01 最大余数），同城账本合计严格守恒；群体人数归零时不得把份额留在空群体；
// - 财富/阶层统计、股息返还、居民授信统一使用 effectiveInvestorShares 权重；
// - 跨城迁移必须是真实资产流转（A 城实体现金/持股按占比划转到 B 城实体），不得把
//   A 城基金份额直接当成 B 城份额；不产生新资金/新股份；
// - 开局/旧档无主旧资产只记一次起始份额，存读档幂等，不重复计财富。
import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation/core/simulation';
import { DEMO_CONFIG } from '../src/data/config';
import type {
  HouseholdGroup,
  HouseholdInvestorLedger,
  OccupationClass,
  WorldState,
} from '../src/simulation/contracts/types';
import type { FinanceResult } from '../src/simulation/finance/finance';
import { round2 } from '../src/simulation/core/math';
import { parseSave, serializeSave } from '../src/simulation/core/save';
import { checkInvariants } from '../src/simulation/core/invariants';
import { applyHouseholdIncome } from '../src/simulation/population/household-economy';
import {
  cityInvestorEquity,
  computeHouseholdWealthStats,
  householdGroupsOfCity,
  syncHouseholdPeople,
} from '../src/simulation/population/household-groups';
import {
  effectiveInvestorShares,
  splitInvestorEquity,
} from '../src/simulation/population/household-investment';
import {
  householdAssetBase,
  householdCreditLimit,
  transferHouseholdDebtsForMigration,
} from '../src/simulation/population/household-finance';
import {
  allocateResidentDividendReturns,
  ensureInvestorOpeningShares,
  groupsOfCity,
  transferInvestorAssetsForMigration,
} from '../src/simulation/investors/investors';

const CITY_ID = 'lanport';

function createWorld(): WorldState {
  return Simulation.create().state;
}

function cityOf(world: WorldState, cityId = CITY_ID) {
  const city = world.cities.find((entry) => entry.id === cityId);
  if (!city) throw new Error(`测试世界缺少城市 ${cityId}`);
  return city;
}

function groupsOf(world: WorldState, cityId = CITY_ID): HouseholdGroup[] {
  return householdGroupsOfCity(world, cityId);
}

function groupOf(world: WorldState, occupation: OccupationClass, cityId = CITY_ID): HouseholdGroup {
  const group = groupsOf(world, cityId).find((entry) => entry.occupation === occupation);
  if (!group) throw new Error(`缺少群体 ${occupation}`);
  return group;
}

function emptyLedger(): HouseholdInvestorLedger {
  return {
    contributed: 0,
    shares: 0,
    openingShares: 0,
    dividends: 0,
    lastContributionTick: -1,
    lastDividendTick: -1,
  };
}

/** 清空本城所有群体的账本，便于用确定的小额份额构造断言。 */
function resetLedgers(world: WorldState, cityId = CITY_ID): void {
  for (const group of groupsOf(world, cityId)) group.investorLedger = emptyLedger();
}

/** 可裁员岗位类别（RoleAllocation 只包含工资职业，不含 publicSector/unemployed/nonLabor）。 */
type WageOccupation = 'management' | 'production' | 'sales' | 'research';

/** 把某职业岗位减少 count 人（其余人口转为失业），保持人口/就业口径自洽。 */
function layoff(world: WorldState, occupation: WageOccupation, count: number): number {
  const city = cityOf(world);
  let remaining = Math.max(0, Math.round(count));
  let removed = 0;
  for (const company of [...world.companies].sort((a, b) => a.id.localeCompare(b.id))) {
    if (company.cityId !== city.id || remaining <= 0) continue;
    const current = Math.max(0, company.roles[occupation] ?? 0);
    const take = Math.min(current, remaining);
    company.roles[occupation] = current - take;
    company.employees = Math.max(0, company.employees - take);
    remaining -= take;
    removed += take;
  }
  city.population.employed = Math.max(0, city.population.employed - removed);
  city.population.unemployed += removed;
  return removed;
}

function sumShares(world: WorldState, cityId = CITY_ID): number {
  return round2(
    groupsOf(world, cityId).reduce(
      (sum, group) => sum + effectiveInvestorShares(group.investorLedger),
      0,
    ),
  );
}

function sumCash(world: WorldState, cityId = CITY_ID): number {
  return round2(groupsOf(world, cityId).reduce((sum, group) => sum + group.cash, 0));
}

function financeWithDividend(amount: number, cityId = CITY_ID): FinanceResult {
  return {
    investorDividendsByCity: {},
    investorDistributionByCity: { [cityId]: amount },
    cityDividendsByCity: {},
    dividendsByCity: {},
    playerDividends: 0,
    playerDividendsByCompany: {},
    corporateTaxByCity: {},
    privateWagesByCity: {},
    wageArrears: 0,
    dividendTaxByCity: {},
    playerDividendTax: 0,
  } as unknown as FinanceResult;
}

function silenceIncome(world: WorldState, cityId = CITY_ID): void {
  const city = cityOf(world, cityId);
  city.householdIncomeLastMonth = 0;
  // 公共部门工资由 city.publicSector 直接派生，与本用例的股息口径无关，置 0 以隔离。
  city.publicSector.wageRate = 0;
  for (const company of world.companies) {
    if (company.cityId !== cityId) continue;
    company.lastMonth.wagesPaid = 0;
  }
}

describe('居民投资权益流转（v1.3 §2）', () => {
  it('全部裁员：份额从零人群体转给同城实际持有人，账本与现金守恒', () => {
    const world = createWorld();
    resetLedgers(world);
    const production = groupOf(world, 'production');
    production.investorLedger = { ...emptyLedger(), contributed: 1_000, shares: 1_000 };
    const peopleBefore = production.people;
    const cashBefore = sumCash(world);
    const sharesBefore = sumShares(world);

    const removed = layoff(world, 'production', peopleBefore);
    expect(removed).toBe(peopleBefore);
    syncHouseholdPeople(world, DEMO_CONFIG);

    // 原群体人数归零且份额清零；份额合计守恒（不增发、不抹除）。
    expect(production.people).toBe(0);
    expect(effectiveInvestorShares(production.investorLedger)).toBeCloseTo(0, 2);
    expect(sumShares(world)).toBeCloseTo(sharesBefore, 2);
    // 接收方（失业群体）确实承接了份额。
    expect(effectiveInvestorShares(groupOf(world, 'unemployed').investorLedger)).toBeCloseTo(
      1_000,
      2,
    );
    // 现金同城守恒，零人群体不再持有现金。
    expect(sumCash(world)).toBeCloseTo(cashBefore, 2);
    expect(production.cash).toBeCloseTo(0, 2);
    expect(checkInvariants(world)).toEqual([]);
  });

  it('部分职业流转：按迁出人数比例拆份额，尾差 0.01 内闭合', () => {
    const world = createWorld();
    resetLedgers(world);
    const production = groupOf(world, 'production');
    production.investorLedger = { ...emptyLedger(), contributed: 1_000, shares: 1_000 };
    const peopleBefore = production.people;
    const moving = Math.max(1, Math.round(peopleBefore / 3));
    const expectedMoved = round2(1_000 * (moving / peopleBefore));

    layoff(world, 'production', moving);
    syncHouseholdPeople(world, DEMO_CONFIG);

    expect(production.people).toBe(peopleBefore - moving);
    expect(effectiveInvestorShares(production.investorLedger)).toBeCloseTo(
      1_000 - expectedMoved,
      2,
    );
    expect(effectiveInvestorShares(groupOf(world, 'unemployed').investorLedger)).toBeCloseTo(
      expectedMoved,
      2,
    );
    expect(sumShares(world)).toBeCloseTo(1_000, 2);
    expect(checkInvariants(world)).toEqual([]);
  });

  it('零人群体无新增接收方（净迁出）：份额转给同城仍有人口的群体', () => {
    const world = createWorld();
    resetLedgers(world);
    const production = groupOf(world, 'production');
    production.investorLedger = { ...emptyLedger(), contributed: 500, shares: 500 };
    const peopleBefore = production.people;
    const city = cityOf(world);
    const totalBefore = city.population.total;

    // 岗位减少且人口总量同步减少（净迁出），不产生“失业接收方”。
    let remaining = peopleBefore;
    for (const company of [...world.companies].sort((a, b) => a.id.localeCompare(b.id))) {
      if (company.cityId !== city.id || remaining <= 0) continue;
      const current = Math.max(0, company.roles.production ?? 0);
      const take = Math.min(current, remaining);
      company.roles.production = current - take;
      remaining -= take;
    }
    const removed = peopleBefore - remaining;
    city.population.employed = Math.max(0, city.population.employed - removed);
    city.population.total = totalBefore - removed;
    syncHouseholdPeople(world, DEMO_CONFIG);

    expect(production.people).toBe(0);
    expect(effectiveInvestorShares(production.investorLedger)).toBeCloseTo(0, 2);
    expect(sumShares(world)).toBeCloseTo(500, 2);
    // 份额落到仍有人口的群体上，而不是留在空群体。
    const holders = groupsOf(world).filter(
      (group) => group.people > 0 && effectiveInvestorShares(group.investorLedger) > 0,
    );
    expect(holders.length).toBeGreaterThan(0);
  });

  it('零人群体不再参与股息返还：实际到账按有效份额落到接收方现金', () => {
    const world = createWorld();
    resetLedgers(world);
    const production = groupOf(world, 'production');
    production.investorLedger = { ...emptyLedger(), contributed: 1_000, shares: 1_000 };
    const peopleBefore = production.people;
    layoff(world, 'production', peopleBefore);
    syncHouseholdPeople(world, DEMO_CONFIG);
    expect(production.people).toBe(0);

    const shares = allocateResidentDividendReturns(world, CITY_ID, 1_000);
    // 只有实际持有份额的群体分到返还，零人群体不在内。
    expect(shares.has(production.id)).toBe(false);
    expect(shares.get(groupOf(world, 'unemployed').id) ?? 0).toBeCloseTo(1_000, 2);

    // 核对 applyHouseholdIncome 后的真实 group.cash：只有失业群体 +1000。
    silenceIncome(world);
    const before = new Map(groupsOf(world).map((group) => [group.id, group.cash]));
    applyHouseholdIncome(world, cityOf(world), financeWithDividend(1_000), 0, 0, [], DEMO_CONFIG);
    for (const group of groupsOf(world)) {
      const delta = round2(group.cash - (before.get(group.id) ?? 0));
      if (group.occupation === 'unemployed') {
        expect(delta).toBeCloseTo(1_000, 2);
      } else {
        expect(delta).toBeCloseTo(0, 2);
      }
    }
  });

  it('财富统计与居民授信统一按有效份额：份额多的群体权益/授信更高', () => {
    const world = createWorld();
    resetLedgers(world);
    const management = groupOf(world, 'management');
    management.investorLedger = { ...emptyLedger(), contributed: 1_000, shares: 1_000 };
    const equity = cityInvestorEquity(world, CITY_ID);
    const groups = groupsOf(world);
    const shares = splitInvestorEquity(groups, equity);
    const managementIndex = groups.indexOf(management);

    const stats = computeHouseholdWealthStats(world, DEMO_CONFIG, world.time.tick);
    const cityStats = stats.find((entry) => entry.cityId === CITY_ID)!;
    expect(cityStats.totalEquity).toBeCloseTo(equity, 2);
    expect(
      round2(cityStats.tiers.reduce((sum, tier) => sum + tier.equity, 0)),
    ).toBeCloseTo(equity, 2);

    // 财产基准 = 现金 + 存款 + 按有效份额归属的权益（不是人口平均）。
    const other = groupOf(world, 'nonLabor');
    const otherIndex = groups.indexOf(other);
    const managementEquity = shares[managementIndex] ?? 0;
    const otherEquity = shares[otherIndex] ?? 0;
    expect(managementEquity).toBeGreaterThan(otherEquity);
    const depositOf = (group: HouseholdGroup): number =>
      round2(
        world.banking.deposits.find(
          (account) => account.owner.kind === 'household' && account.owner.id === group.id,
        )?.balance ?? 0,
      );
    expect(householdAssetBase(world, management, DEMO_CONFIG)).toBeCloseTo(
      round2(management.cash + depositOf(management) + managementEquity),
      2,
    );
    expect(householdAssetBase(world, other, DEMO_CONFIG)).toBeCloseTo(
      round2(other.cash + depositOf(other) + otherEquity),
      2,
    );
    // 授信 = 财产基准 × 比例（本用例无消费贷未偿），份额多者额度更高。
    const credit = DEMO_CONFIG.households.householdCredit.creditLimitRate;
    expect(householdCreditLimit(world, management, DEMO_CONFIG)).toBeCloseTo(
      round2(householdAssetBase(world, management, DEMO_CONFIG) * credit),
      2,
    );
    expect(householdCreditLimit(world, management, DEMO_CONFIG)).toBeGreaterThan(
      householdCreditLimit(world, other, DEMO_CONFIG),
    );
  });

  it('跨城迁移：投资权益随人转移且为真实资产流转（现金/持股划转，不凭空造份额）', () => {
    const world = createWorld();
    ensureInvestorOpeningShares(world);
    const cities = [...world.cities].sort((a, b) => a.id.localeCompare(b.id));
    const from = cities[0];
    const to = cities[1];
    if (!from || !to) throw new Error('测试世界至少需要两个城市');
    const source = groupOf(world, 'unemployed', from.id);
    const destination = groupOf(world, 'unemployed', to.id);
    source.investorLedger = { ...emptyLedger(), contributed: 400, shares: 400, openingShares: 200 };
    destination.investorLedger = emptyLedger();
    const sourceShares = effectiveInvestorShares(source.investorLedger);
    const fromInvestorCash = round2(
      groupsOfCity(world, from.id).reduce((sum, investor) => sum + investor.cash, 0),
    );
    const toInvestorCash = round2(
      groupsOfCity(world, to.id).reduce((sum, investor) => sum + investor.cash, 0),
    );
    const totalHoldingShares = round2(
      world.securities.holdings.reduce((sum, holding) => sum + holding.shares, 0),
    );
    const moving = Math.max(1, Math.round(source.people / 4));
    const expectedMoved = round2(sourceShares * (moving / source.people));

    const result = transferInvestorAssetsForMigration(
      world,
      from.id,
      to.id,
      moving,
      moving,
    );
    expect(result.effectiveSharesMoved).toBeCloseTo(expectedMoved, 2);
    expect(effectiveInvestorShares(source.investorLedger)).toBeCloseTo(
      sourceShares - expectedMoved,
      2,
    );
    expect(effectiveInvestorShares(destination.investorLedger)).toBeCloseTo(expectedMoved, 2);
    // 真实资产流转：两城实体现金合计不变、B 城实体现金增加、股份总股数不变。
    const fromInvestorCashAfter = round2(
      groupsOfCity(world, from.id).reduce((sum, investor) => sum + investor.cash, 0),
    );
    const toInvestorCashAfter = round2(
      groupsOfCity(world, to.id).reduce((sum, investor) => sum + investor.cash, 0),
    );
    expect(round2(fromInvestorCashAfter + toInvestorCashAfter)).toBeCloseTo(
      round2(fromInvestorCash + toInvestorCash),
      2,
    );
    expect(toInvestorCashAfter).toBeGreaterThan(toInvestorCash);
    expect(result.cashMoved).toBeGreaterThan(0);
    expect(
      round2(world.securities.holdings.reduce((sum, holding) => sum + holding.shares, 0)),
    ).toBeCloseTo(totalHoldingShares, 2);
    expect(checkInvariants(world)).toEqual([]);
  });

  it('迁移钩子（transferHouseholdDebtsForMigration）也走真实资产流转', () => {
    const world = createWorld();
    ensureInvestorOpeningShares(world);
    const cities = [...world.cities].sort((a, b) => a.id.localeCompare(b.id));
    const from = cities[0];
    const to = cities[1];
    if (!from || !to) throw new Error('测试世界至少需要两个城市');
    const source = groupOf(world, 'unemployed', from.id);
    const destination = groupOf(world, 'unemployed', to.id);
    source.investorLedger = { ...emptyLedger(), contributed: 400, shares: 400, openingShares: 200 };
    destination.investorLedger = emptyLedger();
    const toCashBefore = round2(
      groupsOfCity(world, to.id).reduce((sum, investor) => sum + investor.cash, 0),
    );
    const moving = Math.max(1, Math.round(source.people / 5));
    transferHouseholdDebtsForMigration(
      world,
      DEMO_CONFIG,
      from.id,
      to.id,
      moving,
      moving,
      world.time.tick,
    );
    const toCashAfter = round2(
      groupsOfCity(world, to.id).reduce((sum, investor) => sum + investor.cash, 0),
    );
    expect(effectiveInvestorShares(destination.investorLedger)).toBeGreaterThan(0);
    expect(toCashAfter).toBeGreaterThan(toCashBefore);
  });

  it('旧档往返：份额/起始权益/财富与授信口径幂等，不重复计财富', () => {
    const world = createWorld();
    ensureInvestorOpeningShares(world);
    const beforeShares = groupsOf(world).map((group) => [
      group.id,
      effectiveInvestorShares(group.investorLedger),
    ]);
    const equityBefore = cityInvestorEquity(world, CITY_ID);
    const creditBefore = groupsOf(world).map((group) =>
      householdCreditLimit(world, group, DEMO_CONFIG),
    );

    const parsed = parseSave(serializeSave(world));
    expect(parsed.ok).toBe(true);
    const loaded = parsed.world!;

    // 再次补齐起始份额应幂等：不重复归属、不改变有效份额与净资产口径。
    ensureInvestorOpeningShares(loaded);
    ensureInvestorOpeningShares(loaded);
    expect(
      groupsOf(loaded).map((group) => [group.id, effectiveInvestorShares(group.investorLedger)]),
    ).toEqual(beforeShares);
    expect(cityInvestorEquity(loaded, CITY_ID)).toBeCloseTo(equityBefore, 2);
    expect(
      groupsOf(loaded).map((group) => householdCreditLimit(loaded, group, DEMO_CONFIG)),
    ).toEqual(creditBefore);

    // 人口同步对账本幂等（份额挂在群体上，不因一次重算而漂移）。
    const sharesBeforeSync = sumShares(loaded);
    syncHouseholdPeople(loaded, DEMO_CONFIG);
    expect(sumShares(loaded)).toBeCloseTo(sharesBeforeSync, 2);
    expect(checkInvariants(loaded)).toEqual([]);
  });
});
