// v1.4 §6.2/6.3：企业利润/库存/原料/工资/计划/销售/招聘的正反馈核查。
//
// 背景（/tmp 探针，24 月，seed 20261101）：能源/食品企业曾出现“有设备、有员工、有需求却
// 不恢复生产”——生产计划以上期计划为基准每月最多 +20%，而 plannedJobs 又由被限速的计划
// 推导；当计划长期低于需求时，企业每月只招到少量岗位甚至继续裁员，劳动产能随之缩小，形成
// “越慢越裁、越裁越慢”的反向锁定。
//
// v1.4 修复：当①上期计划自身的销售参考已高于本期平滑上限（需求持续，不是单月尖峰）、
// ②目标产量 desired 高于 +20% 上限、③企业无紧急下调（现金/原料/库存正常）、④资金可支撑
// 工资（近 3 月利润为正或现金≥3 个月工资）时，允许本月计划直接恢复到
// min(desired, 设备/劳动/原料上限)；岗位需求按“需求可支撑产出”推导，避免爬坡期错裁。
// 困难企业（现金不足/连续亏损）仍走原来的 ±20% 平滑与紧急下调。
import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation/core/simulation';
import { DEMO_CONFIG } from '../src/data/config';
import type { DemoConfig } from '../src/data/config';
import { RECIPES } from '../src/data/demo-data';
import type { Company, CompanyMonthlyStats, CompanyProductionPlan, WorldState } from '../src/simulation/contracts/types';
import { round2 } from '../src/simulation/core/math';
import {
  createEmptyInventory,
  setCompanyEmployees,
} from '../src/simulation/companies/company';
import {
  equipmentLimitFor,
  recomputeProductionPlan,
} from '../src/simulation/companies/production-plan';
import { laborCapacity, productionTarget } from '../src/simulation/production/production';
import {
  emptyInventoryCost,
  totalInventoryBookValue,
} from '../src/simulation/finance/inventory-cost';

const EPSILON = 0.01;

function monthStats(overrides: Partial<CompanyMonthlyStats> = {}): CompanyMonthlyStats {
  return {
    revenue: 0,
    inputCost: 0,
    wagesPaid: 0,
    wageArrears: 0,
    interestPaid: 0,
    corporateTax: 0,
    dividendsPaid: 0,
    profit: 0,
    produced: 0,
    sold: 0,
    exported: 0,
    unmetDemand: 0,
    capacityChange: 0,
    dividendIncome: 0,
    ...overrides,
  };
}

function priorPlan(company: Company, plannedOutput: number, salesReference: number, tick: number): CompanyProductionPlan {
  return {
    tick,
    salesReference,
    targetInventory: round2(salesReference * DEMO_CONFIG.production.plan.targetInventoryMonths),
    equipmentLimit: company.capacity,
    laborLimit: 0,
    plannedOutput,
    plannedJobs: 0,
    emergency: false,
    reasons: [],
  };
}

interface StageOptions {
  salesHistory?: number[];
  priorOutput?: number;
  priorSalesReference?: number;
  employees?: number;
  cash?: number;
  recentProfits?: number[];
  outputStock?: number;
}

/** 构造岚港食品厂：现金/设备充足，原料库存清空，按需覆盖关键字段。 */
function stageCompany(options: StageOptions = {}): { world: WorldState; company: Company } {
  const sim = Simulation.create(DEMO_CONFIG);
  const world = sim.state;
  const company = world.companies.find((entry) => entry.id === 'lp-food')!;
  setCompanyEmployees(company, options.employees ?? 100);
  company.jobDemand = company.employees;
  company.cash = options.cash ?? 1_000_000_000;
  company.debt = 0;
  company.utilization = 0.5;
  company.salesHistory = [...(options.salesHistory ?? [])];
  company.recentProfits = [...(options.recentProfits ?? [])];
  company.ai.lossMonths = 0;
  company.previousMonth = monthStats();
  company.lastMonth = monthStats();
  for (const good of Object.keys(company.inventory) as (keyof typeof company.inventory)[]) {
    company.inventory[good] = 0;
  }
  company.inventory[company.recipeOutput] = options.outputStock ?? 0;
  company.productionPlan =
    options.priorOutput === undefined
      ? null
      : priorPlan(company, options.priorOutput, options.priorSalesReference ?? 0, world.time.tick - 1);
  return { world, company };
}

describe('v1.4 §6.2 企业生产与招聘正反馈', () => {
  it('盈利、有闲置设备与劳动、需求持续高于限速时，计划按需求恢复且主动扩招', () => {
    const { world, company } = stageCompany({
      salesHistory: [50_000, 50_000, 50_000],
      priorOutput: 1_000,
      priorSalesReference: 60_000,
      employees: 100,
      recentProfits: [1_000_000, 1_000_000, 1_000_000],
    });
    const city = world.cities.find((entry) => entry.id === company.cityId)!;
    const laborLimit = laborCapacity(company, city, DEMO_CONFIG, world);
    const plan = recomputeProductionPlan(world, company, DEMO_CONFIG);

    // 不再被上期计划 ×1.2 锁死：直接恢复到劳动上限（设备/原料都不是瓶颈）。
    expect(plan.plannedOutput).toBeGreaterThan(1_000 * 1.2 + EPSILON);
    expect(plan.plannedOutput).toBe(round2(Math.min(laborLimit, equipmentLimitFor(world, company, DEMO_CONFIG))));
    expect(plan.plannedOutput).toBe(round2(laborLimit));
    // 岗位需求按“需求可支撑产出”推导，高于现有员工，触发招聘而不是继续裁员。
    expect(plan.plannedJobs).toBeGreaterThan(company.employees);
    expect(plan.reasons.some((reason) => reason.includes('需求持续高于上期限速'))).toBe(true);
    expect(plan.plannedOutput).toBe(round2(productionTarget(company)));
  });

  it('现金不足/连续亏损的困难企业不触发恢复，仍按 ±20% 平滑并控制岗位', () => {
    const { world, company } = stageCompany({
      salesHistory: [50_000, 50_000, 50_000],
      priorOutput: 1_000,
      priorSalesReference: 60_000,
      employees: 100,
      cash: 50_000, // 不足 1 个月工资 → cashTight/emergency
      recentProfits: [-1_000_000, -1_000_000, -1_000_000],
    });
    const plan = recomputeProductionPlan(world, company, DEMO_CONFIG);
    expect(plan.emergency).toBe(true);
    expect(plan.plannedOutput).toBeLessThanOrEqual(1_000 * 1.2 + EPSILON);
    expect(plan.reasons.some((reason) => reason.includes('需求持续高于上期限速'))).toBe(false);
    expect(plan.plannedJobs).toBeLessThanOrEqual(company.employees);
  });

  it('单月需求尖峰（上期计划尚未看到需求）不触发恢复，保留 ≤20% 平滑', () => {
    const { world, company } = stageCompany({
      salesHistory: [1_000, 3_000],
      priorOutput: 1_000,
      priorSalesReference: 0,
      employees: 20_000,
      recentProfits: [1_000, 1_000],
    });
    const plan = recomputeProductionPlan(world, company, DEMO_CONFIG);
    expect(plan.plannedOutput).toBe(1_200);
    expect(plan.plannedOutput).toBeLessThanOrEqual(1_000 * 1.2 + EPSILON);
  });

  it('恢复月内两轮采购/生产仍然守恒：产量不超计划、轮次≤2、COGS 非负且账面一致', () => {
    const sim = Simulation.create(DEMO_CONFIG);
    const world = sim.state;
    const company = world.companies.find((entry) => entry.id === 'lp-food')!;
    setCompanyEmployees(company, 1_000);
    company.cash = 1_000_000_000;
    company.salesHistory = [50_000, 50_000, 50_000];
    company.recentProfits = [1_000_000, 1_000_000, 1_000_000];
    company.productionPlan = priorPlan(company, 1_000, 60_000, world.time.tick - 1);
    const result = sim.tick();
    expect(result.ok).toBe(true);
    const plan = company.productionPlan!;
    expect(company.lastMonth.produced).toBeLessThanOrEqual(plan.plannedOutput + EPSILON);
    const ownRecords = world.lastTick.productionRecords.filter((record) => record.companyId === company.id);
    expect(ownRecords.length).toBeLessThanOrEqual(DEMO_CONFIG.production.productionRounds);
    expect(company.lastMonth.cogs ?? 0).toBeGreaterThanOrEqual(0);
    expect(company.lastMonth.wageArrears).toBeGreaterThanOrEqual(0);
  });

  it('新企业只有初始预测需求、尚无真实成交时不触发恢复（预测不是已实现需求）', () => {
    const { world, company } = stageCompany({
      salesHistory: [],
      priorOutput: 1_000,
      employees: 4_000,
      recentProfits: [1_000_000, 1_000_000, 1_000_000],
    });
    const equipmentLimit = equipmentLimitFor(world, company, DEMO_CONFIG);
    const forecast = round2(equipmentLimit * DEMO_CONFIG.production.plan.initialSalesFactor);
    expect(forecast).toBeGreaterThan(1_000 * 1.2);
    // 新企业首月计划自己的 salesReference 就是“设备产能 × initialSalesFactor”预测。
    company.productionPlan = priorPlan(company, 1_000, forecast, world.time.tick - 1);
    company.salesHistory = [];

    const plan = recomputeProductionPlan(world, company, DEMO_CONFIG);
    expect(plan.salesReference).toBe(forecast);
    // 前置条件成立：按旧口径这里 desired 与资源上限都高于 +20% 平滑上限。
    expect(plan.equipmentLimit).toBeGreaterThan(1_000 * 1.2);
    expect(plan.plannedOutput).toBeLessThanOrEqual(1_000 * 1.2 + EPSILON);
    expect(plan.reasons.some((reason) => reason.includes('需求持续高于上期限速'))).toBe(false);

    // 对照：同样的产能/现金，只要有真实成交历史且近月销量高于计划基线，恢复通道仍生效。
    company.productionPlan = priorPlan(company, 1_000, forecast, world.time.tick - 1);
    company.salesHistory = [forecast, forecast, forecast];
    const recovered = recomputeProductionPlan(world, company, DEMO_CONFIG);
    expect(recovered.plannedOutput).toBeGreaterThan(1_000 * 1.2 + EPSILON);
    expect(recovered.reasons.some((reason) => reason.includes('需求持续高于上期限速'))).toBe(true);
  });

  it('真实整月 tick：有真实需求且盈利的企业按需求扩产并扩招，产量不超计划', () => {
    const sim = Simulation.create(DEMO_CONFIG);
    const world = sim.state;
    const company = world.companies.find((entry) => entry.id === 'lp-textile')!;
    // 20 名员工、需求 5000/月：劳动上限远低于需求，恢复通道应把岗位需求拉高并实际招聘。
    setCompanyEmployees(company, 20);
    company.jobDemand = 20;
    company.cash = 1_000_000_000;
    company.debt = 0;
    company.ai.lossMonths = 0;
    company.inventory = createEmptyInventory();
    company.inventoryCost = emptyInventoryCost();
    for (const input of RECIPES[company.recipeOutput].inputs) {
      company.inventory[input.good] = 1_000_000;
    }
    company.salesHistory = [5_000, 5_000, 5_000];
    company.recentProfits = [1_000_000, 1_000_000, 1_000_000];
    company.lastMonth = monthStats({ sold: 5_000, produced: 5_000 });
    company.previousMonth = monthStats({ sold: 5_000, produced: 5_000 });
    company.productionPlan = priorPlan(company, 100, 5_000, world.time.tick - 1);

    const employeesBefore = company.employees;
    const result = sim.tick();
    expect(result.ok).toBe(true);
    const plan = company.productionPlan!;
    expect(plan.tick).toBe(world.time.tick);
    expect(plan.reasons.some((reason) => reason.includes('需求持续高于上期限速'))).toBe(true);
    // 计划从 100 直接恢复到需求可支撑的产量，而不是每月最多 +20%。
    expect(plan.plannedOutput).toBeGreaterThan(100 * 1.2 + EPSILON);
    // 岗位需求按“需求可支撑产出”推导，高于现有人数 → 本月真实招聘（不是继续裁员）。
    expect(company.jobDemand).toBeGreaterThan(employeesBefore);
    expect(company.employees).toBeGreaterThan(employeesBefore);
    // 实际产量不超计划，且已经高于上期计划（恢复落地）。
    expect(company.lastMonth.produced).toBeGreaterThan(100);
    expect(company.lastMonth.produced).toBeLessThanOrEqual(plan.plannedOutput + EPSILON);
  });

  it('真实整月 tick：困难企业（现金不足+库存积压）紧急减产并按上限裁员', () => {
    const sim = Simulation.create(DEMO_CONFIG);
    const world = sim.state;
    const company = world.companies.find((entry) => entry.id === 'lp-textile')!;
    setCompanyEmployees(company, 2_000);
    company.jobDemand = 2_000;
    company.cash = 50_000; // 远低于 1 个月工资 → 现金不足
    company.ai.lossMonths = 3;
    company.recentProfits = [-1_000_000, -1_000_000, -1_000_000];
    company.inventory = createEmptyInventory();
    company.inventoryCost = emptyInventoryCost();
    // 成品库存 5000 > 2 个月销量（销量 1000/月）→ 积压；没有任何原料库存。
    company.inventory[company.recipeOutput] = 5_000;
    company.salesHistory = [1_000, 1_000, 1_000];
    company.lastMonth = monthStats({ sold: 1_000, produced: 4_000 });
    company.previousMonth = monthStats({ sold: 1_000, produced: 4_000 });
    company.productionPlan = priorPlan(company, 4_000, 1_000, world.time.tick - 1);

    const employeesBefore = company.employees;
    const result = sim.tick();
    expect(result.ok).toBe(true);
    const plan = company.productionPlan!;
    expect(plan.emergency).toBe(true);
    // 减产：计划低于上期计划（不再按 +20% 扩张），实际产量不超计划。
    expect(plan.plannedOutput).toBeLessThan(4_000);
    expect(company.lastMonth.produced).toBeLessThanOrEqual(plan.plannedOutput + EPSILON);
    // 裁员：岗位需求低于现有员工，且本月实际减员。
    expect(company.jobDemand).toBeLessThan(employeesBefore);
    expect(company.employees).toBeLessThan(employeesBefore);
  });
});

describe('v1.4 §6.6 COGS / 库存成本口径：真实整月 tick 的成本链守恒', () => {
  /** 关闭跨城运力罚款：本用例只校验“无运力退款”时采购→耗料→成品→销售→COGS 的精确
   * 成本链守恒（退款收益 refundGain 已在 v1.4 修复并计入利润，专项用例见
   * tests/inventory-cogs.test.ts 的“跨城运力退款收益”套件）。 */
  function cogsConfig(): DemoConfig {
    return {
      ...DEMO_CONFIG,
      transport: {
        ...DEMO_CONFIG.transport,
        penalty: { strength: 0, max: 0 },
      },
    } as unknown as DemoConfig;
  }

  it('利润=营收−COGS−工资−税−利息+奖金+退款收益；采购现金不重复计入利润；存货账面按采购−COGS−注销滚动', () => {
    const sim = Simulation.create(cogsConfig());
    const world = sim.state;
    for (let month = 0; month < 2; month += 1) {
      const startBook = new Map<string, number>();
      for (const company of world.companies) {
        startBook.set(company.id, totalInventoryBookValue(company));
      }
      const result = sim.tick();
      expect(result.ok).toBe(true);
      for (const company of world.companies) {
        const bookStart = startBook.get(company.id);
        // 本月新成立的企业没有期初快照，跳过（其期初存货在成立时已经入账）。
        if (bookStart === undefined) continue;
        const stats = company.lastMonth;
        expect(stats.cogs ?? 0).toBeGreaterThanOrEqual(0);
        expect(stats.inputCost).toBeGreaterThanOrEqual(0);
        // 会计利润：奖金是对税后利润的分配（计入 wagesPaid，但不进利润），故加回；
        // 运力退款超过剩余账面成本的部分是采购退款收益（refundGain），同样加回；
        // v1.6 §四：设备维护费是独立期间费用，全额（已付+欠付）进税前利润。
        const profitIdentity = round2(
          stats.revenue -
            (stats.cogs ?? 0) -
            stats.wagesPaid -
            (stats.maintenanceDue ?? 0) -
            stats.corporateTax -
            stats.interestPaid +
            (stats.bonusPaid ?? 0) +
            (stats.refundGain ?? 0) -
            stats.profit,
        );
        expect(Math.abs(profitIdentity)).toBe(0);
        // 经营现金流是纯现金制：采购现金支出只在这里出现，不进入利润（不重复扣成本）。
        const cashFlowIdentity = round2(
          stats.revenue -
            stats.inputCost -
            stats.wagesPaid -
            (stats.maintenancePaid ?? 0) -
            (stats.maintenanceArrearsRepaid ?? 0) -
            stats.interestPaid -
            stats.corporateTax -
            (stats.operatingCashFlow ?? 0),
        );
        expect(Math.abs(cashFlowIdentity)).toBe(0);
        // 成本链：期初存货 + 本月采购（现金制实付）− 销售结转 COGS − 注销 + 退款收益 = 期末存货账面。
        const expectedBook = round2(
          bookStart +
            stats.inputCost -
            (stats.cogs ?? 0) -
            (stats.inventoryWriteOff ?? 0) +
            (stats.refundGain ?? 0),
        );
        expect(Math.abs(round2(totalInventoryBookValue(company) - expectedBook))).toBe(0);
      }
    }
  });

});
