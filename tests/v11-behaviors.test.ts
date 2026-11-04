// v1.1 §9 横切行为测试：验证各 owner 落盘的 v1.1 行为与既有账本口径一致。
// 依赖：production-plan（§1/§6）、investors（§2）、founding/lifecycle（§3/§4）、
// government/bonds（§5）。断言以守恒/结构为主，避免把阶段性数值固化成期望。
import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation/core/simulation';
import { DEMO_CONFIG } from '../src/data/config';
import { checkInvariants } from '../src/simulation/core/invariants';
import { monthlyWageBill } from '../src/simulation/companies/company';
import {
  cityShortageFor,
  companyDemandShare,
  payableShortageFromMarket,
  recomputeProductionPlan,
} from '../src/simulation/companies/production-plan';
import {
  FOUNDING_SCALE_UNITS,
  assessFounding,
  foundingAttempts,
} from '../src/simulation/companies/founding';
import { maybeFoundCompanies } from '../src/simulation/companies/lifecycle/lifecycle';
import { collectInvestableFunds } from '../src/simulation/investors/investors';
import {
  bondHolderAvailableCash,
  companyBondReserve,
  issueGovernmentBond,
  subscribeGovernmentBond,
} from '../src/simulation/government/bonds';
import type { GoodId, LogEntry, WorldState } from '../src/simulation/contracts/types';

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function totalOwnedCash(world: WorldState): number {
  return (
    world.investors.reduce((total, investor) => total + investor.cash, 0) +
    world.companies.reduce((total, company) => total + company.cash, 0) +
    world.cities.reduce((total, city) => total + city.treasury, 0) +
    world.player.cash
  );
}

function issuedShares(world: WorldState): number {
  return sum(world.securities.classes.map((shareClass) => shareClass.issuedShares));
}

function heldShares(world: WorldState): number {
  return sum(world.securities.holdings.map((holding) => holding.shares));
}

function depositsTotal(world: WorldState): number {
  return sum(world.banking.deposits.map((account) => account.balance));
}

function cityGroups(world: WorldState, cityId: string) {
  return world.households.groups.filter((group) => group.cityId === cityId);
}

function investorGroupsOfCity(world: WorldState, cityId: string) {
  return world.investors.filter((investor) => investor.cityId === cityId);
}

describe('v1.1 §9：缺货口径（市场 → 计划）', () => {
  it('只把“有支付能力且未满足”的需求当缺货，资金不足 / producerRequired 不虚增', () => {
    const world = Simulation.create(DEMO_CONFIG).state;
    const city = world.cities[0]!;
    const food = city.market.food;
    const grain = city.market.grain;

    // 有效需求 1000、本地成交 400 → 缺口 600。
    food.consumerDemand = 1_000;
    food.producerDemand = 0;
    food.producerRequired = 0;
    food.sold = 400;
    food.intercityImported = 0;
    food.unmetDemand = 0;
    food.unmetFunding = 0;
    expect(payableShortageFromMarket(food, 'food')).toBeCloseTo(600, 2);
    expect(cityShortageFor(world, city, 'food')).toBeCloseTo(600, 2);

    // 跨城进口 150 已满足需求，不能重复计入缺口 → 1000 − (400 + 150) = 450。
    food.intercityImported = 150;
    expect(payableShortageFromMarket(food, 'food')).toBeCloseTo(450, 2);

    // 中间品：只有 producerRequired（含无支付能力部分）与 unmetFunding 时不形成缺货。
    grain.producerDemand = 0;
    grain.producerRequired = 1_000;
    grain.sold = 0;
    grain.intercityImported = 0;
    grain.unmetDemand = 0;
    grain.unmetFunding = 1_000;
    expect(payableShortageFromMarket(grain, 'grain')).toBe(0);
    expect(cityShortageFor(world, city, 'grain')).toBe(0);

    // 有支付能力的需求 1000、成交 400 → 600（与资金缺口无关）。
    grain.producerDemand = 1_000;
    grain.sold = 400;
    expect(cityShortageFor(world, city, 'grain')).toBeCloseTo(600, 2);
  });

  it('同城同产出企业的缺货份额合计不超过 1（不重复计入）', () => {
    const world = Simulation.create(DEMO_CONFIG).state;
    const city = world.cities[0]!;
    const food = city.market.food;
    food.consumerDemand = 10_000;
    food.sold = 0;
    food.intercityImported = 0;
    food.unmetDemand = 10_000;
    const peers = world.companies.filter(
      (company) => company.cityId === city.id && company.recipeOutput === 'food',
    );
    expect(peers.length).toBeGreaterThan(0);
    const signals = peers.map((company) => companyDemandShare(world, company, DEMO_CONFIG));
    expect(sum(signals.map((signal) => signal.share))).toBeLessThanOrEqual(1 + 1e-6);
    expect(sum(signals.map((signal) => signal.absorbed))).toBeLessThanOrEqual(
      sum(signals.map((signal) => signal.cityShortage)) + 1e-6,
    );
  });

  it('历史零销量 + 真实缺货时计划能恢复，不再被零销量锁死', () => {
    const withShortage = Simulation.create(DEMO_CONFIG).state;
    const withoutShortage = structuredClone(withShortage);
    withShortage.time.tick = 1;
    withoutShortage.time.tick = 1;
    const pick = (world: WorldState) => {
      const company = world.companies.find(
        (entry) => entry.cityId === world.cities[0]!.id && entry.recipeOutput === 'food',
      );
      return company!;
    };
    const prepare = (world: WorldState) => {
      const company = pick(world);
      company.previousMonth.sold = 0;
      company.previousMonth.exported = 0;
      company.previousMonth.produced = 0;
      company.salesHistory = [0, 0, 0];
      company.inventory.food = 0;
      // 上期真实计划只有 5 万（停产恢复期），本轮不应被零销量继续压到 4 万。
      company.productionPlan = {
        tick: world.time.tick - 1,
        salesReference: 0,
        targetInventory: 0,
        equipmentLimit: company.equipmentCapacity,
        laborLimit: 0,
        plannedOutput: 50_000,
        plannedJobs: 0,
        emergency: false,
        reasons: [],
      };
      return company;
    };
    const foodCompany = prepare(withShortage);
    const city = withShortage.cities[0]!;
    city.market.food.consumerDemand = 200_000;
    city.market.food.sold = 0;
    city.market.food.intercityImported = 0;
    city.market.food.unmetDemand = 200_000;
    city.market.food.closingStock = 0;

    const recovered = recomputeProductionPlan(withShortage, foodCompany, DEMO_CONFIG);
    expect(recovered.plannedOutput).toBeGreaterThan(50_000);
    expect(recovered.reasons.some((reason) => reason.includes('无实际成交'))).toBe(true);
    expect(recovered.reasons.some((reason) => reason.includes('缺货'))).toBe(true);

    const controlCompany = prepare(withoutShortage);
    const controlCity = withoutShortage.cities[0]!;
    controlCity.market.food.consumerDemand = 0;
    controlCity.market.food.sold = 0;
    controlCity.market.food.unmetDemand = 0;
    controlCity.market.food.closingStock = 0;
    const control = recomputeProductionPlan(withoutShortage, controlCompany, DEMO_CONFIG);
    expect(recovered.plannedOutput).toBeGreaterThan(control.plannedOutput);
  });
});

describe('v1.1 §9：居民零收入闲钱投资', () => {
  it('收入为零但有闲钱：按 1% 上限真实转入投资实体，不提取存款、不放贷、不重复扣款', () => {
    const world = Simulation.create(DEMO_CONFIG).state;
    world.time.tick = 1;
    const city = world.cities.find((entry) => entry.id === 'lanport')!;
    city.householdIncomeLastMonth = 0;
    city.lastMonth.investableContribution = 0;
    for (const group of cityGroups(world, city.id)) {
      // 失业/非劳动力群体的 3 个月基本生活保留额很高（人口 × 食品需求 × 3），
      // 这里给在业群体充足现金制造闲钱，保留“收入为零”的前提。
      group.cash =
        group.occupation === 'unemployed' || group.occupation === 'nonLabor'
          ? 0
          : 100_000_000;
    }

    const groupCashBefore = sum(cityGroups(world, city.id).map((group) => group.cash));
    const cashBeforeByGroup = new Map(
      cityGroups(world, city.id).map((group) => [group.id, group.cash]),
    );
    const investorCashBefore = sum(investorGroupsOfCity(world, city.id).map((group) => group.cash));
    const depositsBefore = depositsTotal(world);
    const loansBefore = world.banking.loans.length;
    const log: LogEntry[] = [];

    collectInvestableFunds(world, DEMO_CONFIG, log);

    const groupCashAfter = sum(cityGroups(world, city.id).map((group) => group.cash));
    const investorCashAfter = sum(investorGroupsOfCity(world, city.id).map((group) => group.cash));
    const moved = investorCashAfter - investorCashBefore;
    expect(moved).toBeGreaterThan(0);
    expect(groupCashBefore - groupCashAfter).toBeCloseTo(moved, 2);
    // 最多动用闲钱的 1%：远小于全部闲钱。
    expect(moved).toBeLessThan(groupCashBefore * 0.02);
    expect(depositsTotal(world)).toBeCloseTo(depositsBefore, 2);
    expect(world.banking.loans.length).toBe(loansBefore);

    for (const group of cityGroups(world, city.id)) {
      const cashBefore = cashBeforeByGroup.get(group.id) ?? 0;
      if (Math.abs(cashBefore - group.cash) < 0.005) continue; // 本月没有闲钱可投的群体不建账本
      const ledger = group.investorLedger;
      expect(ledger).toBeDefined();
      expect(ledger!.contributed, `${group.id} 账本投入`).toBeCloseTo(ledger!.shares, 6);
      expect(ledger!.lastContributionTick).toBe(world.time.tick);
    }

    // 同月重复调用不重复扣款（幂等）。
    const investorCashAfterFirst = investorCashAfter;
    collectInvestableFunds(world, DEMO_CONFIG, log);
    expect(
      sum(investorGroupsOfCity(world, city.id).map((group) => group.cash)),
    ).toBeCloseTo(investorCashAfterFirst, 6);
  });

  it('收入为零且没有超过保留额的闲钱时不投资', () => {
    const world = Simulation.create(DEMO_CONFIG).state;
    world.time.tick = 1;
    const city = world.cities.find((entry) => entry.id === 'lanport')!;
    city.householdIncomeLastMonth = 0;
    city.lastMonth.investableContribution = 0;
    for (const group of cityGroups(world, city.id)) group.cash = 0;

    const investorCashBefore = sum(investorGroupsOfCity(world, city.id).map((group) => group.cash));
    collectInvestableFunds(world, DEMO_CONFIG, []);
    expect(
      sum(investorGroupsOfCity(world, city.id).map((group) => group.cash)),
    ).toBeCloseTo(investorCashBefore, 6);
    expect(city.lastMonth.investableContribution).toBe(0);
  });
});

describe('v1.1 §9：企业购债预留', () => {
  it('可购债现金 = 现金 −（2 月工资 + 1 月原料 + 1 月偿债），认购后仍保住预留', () => {
    const world = Simulation.create(DEMO_CONFIG).state;
    const city = world.cities.find((entry) => entry.id === 'lanport')!;
    const company = world.companies.find(
      (entry) => entry.cityId === city.id && entry.employees > 0,
    )!;
    const breakdown = companyBondReserve(world, DEMO_CONFIG, company.id)!;
    expect(breakdown).not.toBeNull();
    expect(breakdown.reserved).toBeCloseTo(
      breakdown.wages + breakdown.materials + breakdown.debtService,
      2,
    );
    expect(breakdown.wages).toBeCloseTo(
      monthlyWageBill(company, DEMO_CONFIG) * DEMO_CONFIG.government.companyPurchaseReserve.wageMonths,
      2,
    );
    expect(breakdown.materials).toBeGreaterThanOrEqual(0);
    expect(breakdown.debtService).toBeGreaterThanOrEqual(0);

    const faceValue = 1_000;
    company.cash = breakdown.reserved + 3 * faceValue;
    const available = bondHolderAvailableCash(world, DEMO_CONFIG, {
      kind: 'company',
      id: company.id,
    });
    expect(available).toBeCloseTo(company.cash - breakdown.reserved, 2);

    const issue = issueGovernmentBond(world, city, DEMO_CONFIG, 10, world.time.tick);
    expect(issue.ok, issue.error ?? '发债失败').toBe(true);
    const issuance = issue.issuance!;
    const subscription = subscribeGovernmentBond(
      world,
      DEMO_CONFIG,
      issuance.id,
      { kind: 'company', id: company.id },
      1,
      world.time.tick,
    );
    expect(subscription.ok, subscription.error ?? '认购失败').toBe(true);
    expect(subscription.principal).toBe(faceValue);
    // 购债后现金不得低于预留（工资/原料/偿债资金不被占用）。
    expect(company.cash).toBeGreaterThanOrEqual(breakdown.reserved - 0.01);
    expect(company.cash).toBeCloseTo(breakdown.reserved + 2 * faceValue, 2);
  });
});

describe('v1.1 §9：小规模创业与失败回滚', () => {
  it('资金/设备不足时降档尝试；成功创办保留周转金，失败不留资金/股份副作用', () => {
    const world = Simulation.create(DEMO_CONFIG).state;
    for (const investor of world.investors) investor.cash = 30_000_000;
    const log: LogEntry[] = [];
    const cashBefore = totalOwnedCash(world);
    const sharesBefore = issuedShares(world);
    const attemptCountBefore = foundingAttempts(world).length;

    const created = maybeFoundCompanies(world, DEMO_CONFIG, log);
    // 每城每月最多 4 家；档位从 4 台开始但可降至 2/1 台，不能超过最大档。
    const maxUnits = Math.max(...FOUNDING_SCALE_UNITS);
    for (const city of world.cities) {
      const foundedThisTick = world.lifecycle.foundings.filter(
        (record) => record.cityId === city.id && record.tick === world.time.tick,
      );
      expect(foundedThisTick.length).toBeLessThanOrEqual(
        DEMO_CONFIG.lifecycle.maxFoundingsPerCityMonth,
      );
    }
    for (const companyId of created) {
      const company = world.companies.find((entry) => entry.id === companyId)!;
      const units =
        company.equipment.farm + company.equipment.industry + company.equipment.energy;
      expect(units).toBeGreaterThanOrEqual(1);
      expect(units).toBeLessThanOrEqual(maxUnits);
      // 周转金下限：买完设备后至少保留 2 个月基础工资（配置口径）。
      expect(company.cash).toBeGreaterThanOrEqual(
        monthlyWageBill(company, DEMO_CONFIG) * 1.9,
      );
    }
    // 没有凭空造钱：玩家/居民实体/企业/财政合计只发生转移。
    expect(totalOwnedCash(world)).toBeCloseTo(cashBefore, 2);
    // 股份：发行与持仓同步，且不凭空多发。
    expect(issuedShares(world)).toBeGreaterThanOrEqual(sharesBefore);
    expect(heldShares(world)).toBeCloseTo(issuedShares(world), 6);
    expect(foundingAttempts(world).length).toBeGreaterThanOrEqual(attemptCountBefore);
    expect(checkInvariants(world)).toEqual([]);
  });

  it('设备完全不可用时失败回滚：不新增企业、不扣出资人现金、不新增贷款/股份', () => {
    const world = Simulation.create(DEMO_CONFIG).state;
    for (const investor of world.investors) investor.cash = 30_000_000;
    for (const company of world.companies) {
      company.inventory.farmEquipment = 0;
      company.inventory.industryEquipment = 0;
      company.inventory.energyEquipment = 0;
    }
    world.equipmentMarket.initialStock = { farm: 0, industry: 0, energy: 0 };
    for (const city of world.cities) {
      for (const goodId of ['farmEquipment', 'industryEquipment', 'energyEquipment'] as GoodId[]) {
        city.market[goodId].closingStock = 0;
        city.market[goodId].supply = 0;
        city.market[goodId].price = 0;
      }
    }
    const companyCountBefore = world.companies.length;
    const cashBefore = totalOwnedCash(world);
    const sharesBefore = issuedShares(world);
    const loansBefore = world.banking.loans.length;
    const attemptCountBefore = foundingAttempts(world).length;

    const created = maybeFoundCompanies(world, DEMO_CONFIG, []);

    expect(created).toEqual([]);
    expect(world.companies.length).toBe(companyCountBefore);
    expect(totalOwnedCash(world)).toBeCloseTo(cashBefore, 2);
    expect(issuedShares(world)).toBe(sharesBefore);
    expect(world.banking.loans.length).toBe(loansBefore);
    // 设备不可得时评估必须给出结构化障碍（不静默），且没有可行档。
    const assessment = assessFounding(world, DEMO_CONFIG, world.cities[0]!.id, 'food');
    expect(assessment.feasibleTier).toBeNull();
    expect(
      assessment.scaleTiers[0]?.blockers.some((blocker) => blocker.kind === 'equipment'),
    ).toBe(true);
    // v1.2 起“本轮没有机会”也会写结构化 stop attempt（city/候选/障碍），
    // 因此允许新增 attempt，但必须是 rejected 且带明确停止原因，不得静默。
    const newAttempts = foundingAttempts(world).slice(attemptCountBefore);
    expect(newAttempts.length).toBeGreaterThan(0);
    for (const attempt of newAttempts) {
      expect(attempt.outcome).toBe('rejected');
      expect(attempt.note).toContain('本轮自动创办停止');
    }
  });
});
