// v1.4 §7 横切守恒测试：资产 / 资金 / 份额 / 设备 / 债务在真实 tick 间不凭空产生或消失。
//
// 覆盖点（与 §4/§5 的模块内单测互补，这里全部走真实 tick 或真实 API 聚合）：
// 1. 投资实体净资产恒等式：净资产 = 现金 + 股票市值 + 债券估值（未到期本金 + 已计提未付利息），
//    报告（investorFundingReport）与独立重算逐城一致，债券只按 active 持债计一次；
// 2. 有效份额守恒：有效份额 = shares + openingShares，报告占比与账本一致；
// 3. 公共岗位：预算“预留”不等于预扣财政；每月只按真实在岗工资归属一次（不与 fiscal publicWages
//    重复扣费），发生额与执行记录一致，取消/到期撤岗；
// 4. 初始设备只计一次：实物出资进入企业设备一次，不消耗设备市场库存、不生成成交/财政补贴；
// 5. 债务守恒：政府债务 = 未到期债券本金 + 债券计提利息 + 贷款本金 + 贷款利息；每期发行
//    成交份数 = 持债份数，持债本金 = 份数 × 面额，不重复造债；
// 6. 以上恒等式在每 1 个真实月份结算后都成立，且不变量校验为空。
import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation/core/simulation';
import { DEMO_CONFIG } from '../src/data/config';
import { GOODS } from '../src/data/demo-data';
import type { EquipmentKind, LogEntry, WorldState } from '../src/simulation/contracts/types';
import { checkInvariants } from '../src/simulation/core/invariants';
import { round2 } from '../src/simulation/core/math';
import { investorFundingReport } from '../src/simulation/investors/investors';
import { cityInvestorEquity } from '../src/simulation/population/household-groups';
import {
  effectiveInvestorShares,
  investorBondValue,
} from '../src/simulation/population/household-investment';
import { companySharePrice } from '../src/simulation/companies/company';
import { cityMarketPrices } from '../src/simulation/markets/markets';
import {
  equipmentCapacityFor,
  equipmentKindForSector,
  equipmentUnitPrice,
} from '../src/simulation/equipment/equipment';
import { foundCompany } from '../src/simulation/companies/lifecycle/lifecycle';
import { cancelPolicy, settlePolicies, startPolicy } from '../src/simulation/policies/policies';
import { activePolicy } from '../src/simulation/policies/query';
import { reconcileLabor } from '../src/simulation/labor/labor';

const KINDS: EquipmentKind[] = ['farm', 'industry', 'energy'];

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

/** 独立重算本城投资实体净资产 = 现金 + 股票市值 + 债券估值（v1.4 §3 口径）。 */
function independentInvestorNetWorth(world: WorldState, cityId: string): number {
  const pricesByCity = new Map(
    world.cities.map((city) => [city.id, cityMarketPrices(city)] as const),
  );
  let cash = 0;
  let holdingsValue = 0;
  let bondsValue = 0;
  for (const investor of world.investors.filter((entry) => entry.cityId === cityId)) {
    cash += investor.cash;
    bondsValue += investorBondValue(world, investor.id);
    for (const holding of world.securities.holdings) {
      if (holding.holder.type !== 'investorGroup' || holding.holder.id !== investor.id) continue;
      const company = world.companies.find((entry) => entry.id === holding.companyId);
      if (!company) continue;
      const prices = pricesByCity.get(company.cityId);
      if (!prices) continue;
      holdingsValue += holding.shares * companySharePrice(company, prices);
    }
  }
  return round2(cash + holdingsValue + bondsValue);
}

/** 独立重算政府债务（债券 + 贷款 + 计提利息），用于核对 lastDebt.totalDebt。 */
function independentCityDebt(world: WorldState, cityId: string): number {
  const city = world.cities.find((entry) => entry.id === cityId)!;
  let total = 0;
  for (const loan of city.government?.loans ?? []) {
    if (loan.status !== 'active') continue;
    total += Math.max(0, loan.outstanding) + Math.max(0, loan.accruedInterest) + Math.max(0, loan.arrearsInterest);
  }
  for (const holding of world.bonds?.holdings ?? []) {
    if (holding.cityId !== cityId || holding.status !== 'active') continue;
    total += Math.max(0, holding.principal) + Math.max(0, holding.accruedInterest);
  }
  return round2(total);
}

/** 全库债券守恒：每期发行“持债份数 = 成交份数”，持债本金 = 份数 × 面额。 */
function expectBondBooksClosed(world: WorldState): void {
  const issuances = world.bonds?.issuances ?? [];
  const holdings = world.bonds?.holdings ?? [];
  expect(issuances.length).toBeGreaterThan(0);
  for (const issuance of issuances) {
    const issuanceHoldings = holdings.filter((holding) => holding.issuanceId === issuance.id);
    const holdingUnits = sum(issuanceHoldings.map((holding) => holding.units));
    expect(holdingUnits, `${issuance.id} 持债份数 != 成交份数`).toBe(issuance.soldUnits);
    for (const holding of issuanceHoldings) {
      expect(holding.principal).toBeCloseTo(holding.units * issuance.faceValue, 2);
    }
    // 未售不形成债务；成交 = 计划 − 未售（不凭空造债、也不漏记）。
    expect(issuance.unsoldUnits).toBe(issuance.planUnits - issuance.soldUnits);
  }
}

describe('v1.4 §7 资产/资金/份额/设备/债务守恒', () => {
  it('真实 5 个月逐月结算：净资产/份额/债券/债务/设备恒等式每月成立，不变量为空', () => {
    const sim = Simulation.create();
    const world = sim.state;
    let previousGrantUnits = new Map<string, { kind: EquipmentKind; units: number }>();
    let sawInitialEquipmentGrant = false;

    for (let month = 1; month <= 5; month += 1) {
      const result = sim.tick();
      expect(result.ok, `第 ${month} 月 tick 失败：${result.ok ? '' : result.error}`).toBe(true);
      expect(checkInvariants(world)).toEqual([]);

      const reports = investorFundingReport(world);
      expect(reports).toHaveLength(world.cities.length);
      let reportInvestorNetWorth = 0;
      for (const report of reports) {
        const city = world.cities.find((entry) => entry.id === report.cityId)!;
        // (1) 净资产恒等式：报告 = 独立重算 = cityInvestorEquity（三处口径必须一致）。
        expect(report.investorNetWorth).toBeCloseTo(independentInvestorNetWorth(world, report.cityId), 2);
        expect(report.investorNetWorth).toBeCloseTo(cityInvestorEquity(world, report.cityId), 2);
        reportInvestorNetWorth = round2(reportInvestorNetWorth + report.investorNetWorth);
        // 实体现金 = 各群体现金合计（报告不重复计入）。
        expect(report.investorCash).toBeCloseTo(sum(report.groups.map((group) => group.cash)), 2);
        for (const group of report.groups) {
          expect(group.netWorth).toBeCloseTo(group.cash + group.holdingsValue + group.bondsValue, 2);
          expect(group.bondsValue).toBeCloseTo(investorBondValue(world, group.groupId), 2);
          // 债券估值只含 active 持债，不把已兑付/破产兑付重复计价。
          const activeBondHoldings = (world.bonds?.holdings ?? []).filter(
            (holding) =>
              holding.status === 'active' &&
              holding.holder.kind === 'investorGroup' &&
              holding.holder.id === group.groupId,
          );
          expect(group.bondsValue).toBeCloseTo(
            round2(
              sum(
                activeBondHoldings.map(
                  (holding) =>
                    Math.max(0, holding.principal) + Math.max(0, holding.accruedInterest),
                ),
              ),
            ),
            2,
          );
          expect(group.netWorth).toBeGreaterThanOrEqual(-0.01);
        }

        // (2) 有效份额守恒：有效份额 = shares + openingShares；报告占比按有效份额。
        const groups = world.households.groups.filter((group) => group.cityId === city.id);
        const effectiveTotal = round2(
          sum(groups.map((group) => effectiveInvestorShares(group.investorLedger))),
        );
        const ledgerTotal = round2(
          sum(
            groups.map(
              (group) =>
                Math.max(0, group.investorLedger?.shares ?? 0) +
                Math.max(0, group.investorLedger?.openingShares ?? 0),
            ),
          ),
        );
        expect(effectiveTotal).toBeCloseTo(ledgerTotal, 2);
        const reportedEffective = round2(
          sum(report.householdShares.map((entry) => entry.effectiveShares)),
        );
        expect(reportedEffective).toBeCloseTo(effectiveTotal, 2);
        for (const entry of report.householdShares) {
          expect(entry.effectiveShares).toBeCloseTo(entry.shares + entry.openingShares, 2);
          expect(entry.shareRatio).toBeGreaterThanOrEqual(0);
          expect(entry.shareRatio).toBeLessThanOrEqual(1);
        }
        if (effectiveTotal > 0) {
          expect(
            sum(report.householdShares.map((entry) => entry.shareRatio)),
          ).toBeCloseTo(1, 2);
        }

        // (3) 债务守恒：lastDebt 与“债券 + 贷款 + 计提利息”独立重算一致。
        const lastDebt = city.government?.lastDebt;
        if (lastDebt) {
          expect(lastDebt.totalDebt).toBeCloseTo(independentCityDebt(world, city.id), 2);
        }
      }
      // 三城净资产合计 = 全体投资实体独立重算合计（无跨城重复计入）。
      expect(reportInvestorNetWorth).toBeCloseTo(
        round2(sum(world.cities.map((city) => independentInvestorNetWorth(world, city.id)))),
        2,
      );

      // (4) 债券账本闭合（成交 = 持债，本金 = 份数 × 面额）。
      expectBondBooksClosed(world);

      // (5) 初始设备只计一次：已登记实物出资的企业，其设备台数只增不减（锁定期内不可出售），
      //     且产能与设备台数独立推导一致。
      const grantedCompanies = world.companies.filter((company) => company.initialEquipment);
      if (grantedCompanies.length > 0) sawInitialEquipmentGrant = true;
      const currentGrantUnits = new Map<string, { kind: EquipmentKind; units: number }>();
      for (const company of grantedCompanies) {
        const grant = company.initialEquipment!;
        const before = previousGrantUnits.get(company.id);
        expect(company.equipment[grant.kind]).toBeGreaterThanOrEqual(grant.units);
        if (before && before.kind === grant.kind && world.time.tick < grant.lockUntilTick) {
          // 锁定期内实物出资设备不得因出售/清算而消失（没有被重复增减）。
          expect(company.equipment[grant.kind]).toBeGreaterThanOrEqual(before.units);
        }
        expect(company.equipmentCapacity).toBeCloseTo(
          equipmentCapacityFor(world, company, DEMO_CONFIG),
          2,
        );
        expect(company.capacity).toBeCloseTo(company.equipmentCapacity, 2);
        currentGrantUnits.set(company.id, { kind: grant.kind, units: company.equipment[grant.kind] });
      }
      previousGrantUnits = currentGrantUnits;

      // (6) 设备/产能整体：台数均为整数且非负；设备市场库存不因实物出资而增加。
      for (const company of world.companies) {
        for (const kind of KINDS) {
          expect(Number.isInteger(company.equipment[kind])).toBe(true);
          expect(company.equipment[kind]).toBeGreaterThanOrEqual(0);
        }
      }
      for (const kind of KINDS) {
        expect(world.equipmentMarket.initialStock[kind]).toBeGreaterThanOrEqual(0);
        expect(Number.isInteger(world.equipmentMarket.initialStock[kind])).toBe(true);
      }
    }
    // 真实运行中必须出现“新企业自带初始设备”，否则本项守恒校验没有覆盖对象。
    expect(sawInitialEquipmentGrant).toBe(true);
  });

  it('公共岗位：预算预留不预扣财政，按月只按真实在岗工资归属一次，取消撤岗', () => {
    const world = Simulation.create().state;
    for (const city of world.cities) {
      city.treasury = 80_000_000;
      city.lastMonth.publicWageBill = city.publicSector.employees * city.publicSector.wageRate;
    }
    const city = world.cities.find((entry) => entry.id === 'ironvale')!;
    const jobsBefore = city.publicSector.jobs;
    const employeesBefore = city.publicSector.employees;
    const treasuryBefore = city.treasury;
    const wageRate = city.publicSector.wageRate;

    const started = startPolicy(world, city.id, 'publicJobs', DEMO_CONFIG);
    expect(started.ok, started.ok ? '' : started.error).toBe(true);
    const policy = activePolicy(world, city.id, 'publicJobs')!;
    const created = policy.effects.jobsCreated ?? 0;
    const reserved = policy.effects.reservedWages ?? 0;
    expect(created).toBeGreaterThan(0);
    expect(reserved).toBeGreaterThan(0);
    expect(city.publicSector.jobs).toBe(jobsBefore + created);

    // 预留 ≠ 预扣：启动时财政分文未动，只记录预留额上限与资金来源。
    expect(city.treasury).toBe(treasuryBefore);
    expect(policy.spent).toBe(0);
    expect(policy.budget).toBeCloseTo(reserved, 2);
    expect(reserved).toBeCloseTo(
      created * wageRate * DEMO_CONFIG.policies.publicJobs.wageMonthsReserved,
      2,
    );
    expect(policy.tracking?.publicWorksJobs).toBe(created);
    expect(policy.tracking?.publicWorksBaselineEmployees).toBe(employeesBefore);
    expect(policy.tracking?.publicWorksFunding).toContain('publicWages');
    expect(
      world.fiscal.ledger.filter(
        (entry) => entry.cityId === city.id && entry.kind === 'policySpending',
      ),
    ).toHaveLength(0);

    // 第一个月：真实招聘填岗后结算，只把真实在岗工资计入政策预算归属，不再次扣财政。
    const labor = reconcileLabor(world, DEMO_CONFIG, []);
    expect(labor.publicHires).toBeGreaterThan(0);
    settlePolicies(world, DEMO_CONFIG, { hiresByCompany: labor.hiresByCompany, log: [] });
    const baseline = policy.tracking?.publicWorksBaselineEmployees ?? 0;
    const filled = Math.min(created, city.publicSector.employees - baseline);
    expect(filled).toBeGreaterThan(0);
    const monthOneWage = round2(filled * wageRate);
    expect(policy.effects.publicWagePaid).toBeCloseTo(monthOneWage, 2);
    expect(policy.spent).toBeCloseTo(monthOneWage, 2);
    expect(city.treasury).toBe(treasuryBefore);
    const publicJobsRuns = () =>
      (policy.tracking?.runs ?? []).filter((run) => run.reason.includes('公共工程'));
    expect(publicJobsRuns()).toHaveLength(1);
    expect(publicJobsRuns()[0]!.spent).toBeCloseTo(monthOneWage, 2);
    expect(publicJobsRuns()[0]!.fiscalImpact).toBeCloseTo(-monthOneWage, 2);
    expect(publicJobsRuns()[0]!.beneficiaries).toBe(filled);

    // 第二个月：累计支出 = 两个月真实工资；不超过预留预算；财政仍只由 fiscal publicWages 实付。
    world.time.tick += 1;
    const labor2 = reconcileLabor(world, DEMO_CONFIG, []);
    settlePolicies(world, DEMO_CONFIG, { hiresByCompany: labor2.hiresByCompany, log: [] });
    const monthTwoWage = round2(
      Math.min(created, city.publicSector.employees - baseline) * wageRate,
    );
    expect(policy.spent).toBeCloseTo(round2(monthOneWage + monthTwoWage), 2);
    expect(city.treasury).toBe(treasuryBefore);
    expect(sum(publicJobsRuns().map((run) => run.spent))).toBeCloseTo(policy.spent, 2);
    expect(policy.spent).toBeLessThanOrEqual(reserved + 0.01);
    // 政策归属的公共工资不超过财政实际公共工资口径（不额外造钱）。
    expect(policy.spent).toBeLessThanOrEqual(
      city.publicSector.employees * city.publicSector.wageRate + 0.01,
    );

    // 取消即撤岗：岗位回到启动前，未使用预留不再支出，财政未被政策扣款；
    // 在岗人员随岗位同步退出（撤岗后不变量立即一致，不留下 employees > jobs 的中间态）。
    const cancelled = cancelPolicy(world, city.id, 'publicJobs');
    expect(cancelled.ok).toBe(true);
    expect(city.publicSector.jobs).toBe(jobsBefore);
    expect(city.publicSector.employees).toBeLessThanOrEqual(city.publicSector.jobs);
    expect(city.treasury).toBe(treasuryBefore);
    expect(activePolicy(world, city.id, 'publicJobs')).toBeUndefined();
    expect(checkInvariants(world)).toEqual([]);
    // 下一轮劳动力结算不会重复撤岗、也不会把已退出人员重新计薪。
    reconcileLabor(world, DEMO_CONFIG, []);
    expect(city.publicSector.jobs).toBe(jobsBefore);
    expect(checkInvariants(world)).toEqual([]);
  });

  it('初始设备只计一次：实物出资进入企业设备一次，不消耗设备库存、不生成成交与财政支出', () => {
    const world = Simulation.create().state;
    for (const city of world.cities) city.treasury = 50_000_000;
    for (const group of world.investors) group.cash = 100_000_000;
    for (const company of world.companies) company.cash = 50_000_000;

    const city = world.cities.find((entry) => entry.id === 'lanport')!;
    // 制造“食品缺货 + 本地/政府设备库存为 0”的机会，确保只走实物出资路径。
    const base = GOODS.find((good) => good.id === 'food')!.basePrice;
    city.market.food.price = base * 1.4;
    city.market.food.lastPriceChangePct = 5;
    city.market.food.demand = 2_000_000;
    city.market.food.sold = 0;
    city.market.food.unmetDemand = 2_000_000;
    city.market.food.supply = 500_000;
    for (const kind of KINDS) world.equipmentMarket.initialStock[kind] = 0;
    for (const company of world.companies) {
      for (const kind of KINDS) company.inventory[DEMO_CONFIG.equipment.catalog[kind].goodId] = 0;
    }
    for (const entry of world.cities) {
      for (const kind of KINDS) {
        const goodId = DEMO_CONFIG.equipment.catalog[kind].goodId;
        entry.market[goodId].closingStock = 0;
        entry.market[goodId].supply = 0;
      }
    }

    const equipmentUnitsTotal = (kind: EquipmentKind) =>
      sum(world.companies.map((company) => Math.max(0, company.equipment[kind] ?? 0)));
    const unitsBefore = { farm: equipmentUnitsTotal('farm'), industry: equipmentUnitsTotal('industry'), energy: equipmentUnitsTotal('energy') };
    const marketStockBefore = { ...world.equipmentMarket.initialStock };
    const industryLedgerBefore = {
      sold: city.market.industryEquipment.sold,
      demand: city.market.industryEquipment.demand,
      supply: city.market.industryEquipment.supply,
    };
    const treasuryBefore = city.treasury;
    const totalCashBefore = round2(
      sum(world.companies.map((company) => company.cash)) +
        sum(world.investors.map((investor) => investor.cash)) +
        sum(world.cities.map((entry) => entry.treasury)) +
        world.player.cash,
    );

    const log: LogEntry[] = [];
    const result = foundCompany(world, { cityId: city.id, recipeOutput: 'food', log }, DEMO_CONFIG);
    expect(result.ok, result.ok ? '' : result.error).toBe(true);
    const company = world.companies.find((entry) => entry.id === result.companyId)!;
    const grant = company.initialEquipment!;
    expect(grant).toBeDefined();
    expect(grant.source).toBe('founderInKind');
    expect(grant.units).toBeGreaterThanOrEqual(1);
    expect(grant.kind).toBe(equipmentKindForSector(company.sector, DEMO_CONFIG));
    expect(grant.valuation).toBeCloseTo(
      grant.units * equipmentUnitPrice(world, city.id, grant.kind, DEMO_CONFIG),
      2,
    );

    // 设备台数只增加实物出资的台数（没有第二份手工加总/重复计入）；市场买不到（库存已清空）。
    expect(equipmentUnitsTotal(grant.kind) - unitsBefore[grant.kind]).toBe(grant.units);
    expect(company.equipment[grant.kind]).toBe(grant.units);
    expect(company.equipmentCapacity).toBeCloseTo(
      equipmentCapacityFor(world, company, DEMO_CONFIG),
      2,
    );
    expect(company.lastMonth.equipmentPurchased ?? 0).toBe(0);

    // 实物出资不是游戏内设备生产/销售：设备市场库存与设备商品市场账本不变。
    expect(world.equipmentMarket.initialStock).toEqual(marketStockBefore);
    expect(city.market.industryEquipment.sold).toBeCloseTo(industryLedgerBefore.sold, 2);
    expect(city.market.industryEquipment.demand).toBeCloseTo(industryLedgerBefore.demand, 2);
    expect(city.market.industryEquipment.supply).toBeCloseTo(industryLedgerBefore.supply, 2);
    // 不是财政补贴：财政与全社会现金不被实物出资凭空增加（创办资本是既有现金的转移）。
    expect(city.treasury).toBeCloseTo(treasuryBefore, 2);
    expect(totalCashBefore).toBeCloseTo(
      round2(
        sum(world.companies.map((entry) => entry.cash)) +
          sum(world.investors.map((investor) => investor.cash)) +
          sum(world.cities.map((entry) => entry.treasury)) +
          world.player.cash,
      ),
      2,
    );
    // 创办记录与公司字段一致（同一笔实物出资只落一次账）。
    const founding = world.lifecycle!.foundings.find((record) => record.companyId === company.id)!;
    expect(founding.initialEquipment).toEqual(grant);
    expect(checkInvariants(world)).toEqual([]);
  });
});
