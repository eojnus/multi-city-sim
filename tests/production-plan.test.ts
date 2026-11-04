// v0.9 T2：企业生产计划模型。
//
// 固定口径：
// - 销售参考量取近 salesLookbackMonths 月实际销量（含出口）均值；无历史时按设备产能 ×
//   initialSalesFactor（或旧档的产能 × 利用率）给出有依据的预测；
// - v1.0 加入“有支付能力但缺货”的未满足需求：城市缺口按同城同产出企业的产能/销量份额
//   分摊给本企业（Σ份额≤1，不重复分配），每月只吸收 unmetDemandAbsorption（20%）；
// - 计划产量以上期计划（没有则上月实际产量，再没有则产能 × 利用率）为基准按月 ±20% 平滑，
//   库存严重积压/现金不足/原料资金不足时按 emergencyDownAdjust 紧急下调；
// - 计划不超设备产能、原料可支持产量、劳动产能；岗位需求由计划产量推出；
// - 扩产判定：连续 2 月设备利用率≥80%、库存≤1 月销量、保留 2 月工资+近期偿债后仍有资金；
//   设备够缺员工→优先招聘，员工够缺原料→优先采购；
// - 实际产量仍由 production.ts 在生产时取 min(计划, 设备, 劳动, 原料)，不得超计划。
import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation/core/simulation';
import { DEMO_CONFIG } from '../src/data/config';
import { RECIPES } from '../src/data/demo-data';
import type {
  Company,
  CompanyMonthlyStats,
  CompanyProductionPlan,
  WorldState,
} from '../src/simulation/contracts/types';
import { round2 } from '../src/simulation/core/math';
import { createEmptyInventory, monthlyWageBill, setCompanyEmployees } from '../src/simulation/companies/company';
import {
  assessExpansion,
  companyDemandShare,
  equipmentLimitFor,
  recomputeProductionPlan,
} from '../src/simulation/companies/production-plan';
import { planCompanies } from '../src/simulation/companies/planning';
import { laborCapacity, productionTarget, runProduction } from '../src/simulation/production/production';
import { createWorldLedgers } from '../src/simulation/markets/markets';

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

function priorPlan(company: Company, plannedOutput: number, tick: number): CompanyProductionPlan {
  return {
    tick,
    salesReference: 0,
    targetInventory: 0,
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
  outputStock?: number;
  produced?: number;
  sold?: number;
  employees?: number;
  cash?: number;
  inputStock?: number;
  priorOutput?: number;
}

/** 构造一个只关心计划口径的食品企业：现金/原料充足，除非显式覆盖。 */
function stageCompany(options: StageOptions = {}): {
  world: WorldState;
  company: Company;
  city: WorldState['cities'][number];
} {
  const world = Simulation.create().state;
  const company = world.companies.find((entry) => entry.id === 'lp-food')!;
  const city = world.cities.find((entry) => entry.id === company.cityId)!;
  setCompanyEmployees(company, options.employees ?? 20_000);
  company.jobDemand = company.employees;
  company.cash = options.cash ?? 1_000_000_000_000;
  company.utilization = 0.8;
  company.inventory = createEmptyInventory();
  const recipe = RECIPES[company.recipeOutput];
  for (const input of recipe.inputs) {
    company.inventory[input.good] = options.inputStock ?? 1_000_000_000;
  }
  company.inventory[company.recipeOutput] = options.outputStock ?? 0;
  company.salesHistory = options.salesHistory ?? [1000];
  company.previousMonth = monthStats({
    produced: options.produced ?? 1000,
    sold: options.sold ?? 1000,
  });
  company.productionPlan =
    options.priorOutput !== undefined
      ? priorPlan(company, options.priorOutput, world.time.tick - 1)
      : null;
  return { world, company, city };
}

describe('v0.9 企业生产计划模型', () => {
  it('销量下滑时计划按月下调且幅度不超过 20%', () => {
    const { world, company } = stageCompany({ salesHistory: [1000] });

    const first = recomputeProductionPlan(world, company, DEMO_CONFIG);
    // 上月实际产量 1000 作为平滑基准，目标 1500 → 上限 1200。
    expect(first.plannedOutput).toBe(1200);

    world.time.tick = 1;
    company.previousMonth = monthStats({ produced: 200, sold: 200 });
    const second = recomputeProductionPlan(world, company, DEMO_CONFIG);
    // 近 3 月销量 [1000, 1000, 200] → 参考 733.33，目标 1100；基准 1200。
    expect(second.plannedOutput).toBe(1100);
    expect(second.plannedOutput).toBeGreaterThanOrEqual(1200 * 0.8 - EPSILON);

    world.time.tick = 2;
    company.previousMonth = monthStats({ produced: 200, sold: 200 });
    const third = recomputeProductionPlan(world, company, DEMO_CONFIG);
    // 基准 1100 → 下限 880：连续下滑时每月也只允许 −20%。
    expect(third.plannedOutput).toBe(880);
    expect(third.plannedOutput).toBeGreaterThanOrEqual(1100 * 0.8 - EPSILON);
  });

  it('成品库存超过 2 个月销量时紧急下调', () => {
    const { world, company } = stageCompany({
      salesHistory: [1000],
      outputStock: 3000,
      priorOutput: 1200,
    });
    const plan = recomputeProductionPlan(world, company, DEMO_CONFIG);
    expect(plan.emergency).toBe(true);
    expect(plan.plannedOutput).toBe(480);
    // 正常月份下限是 −20%；紧急时允许 −60%。
    expect(plan.plannedOutput).toBeLessThanOrEqual(1200 * 0.6 + EPSILON);
    expect(plan.reasons.some((reason) => reason.includes('库存'))).toBe(true);
  });

  it('现金不足 1 个月工资时紧急下调并保留招聘/生产意图说明', () => {
    const { world, company } = stageCompany({ priorOutput: 1200, outputStock: 2000 });
    const wage = monthlyWageBill(company, DEMO_CONFIG);
    company.cash = round2(wage * 0.5);
    const plan = recomputeProductionPlan(world, company, DEMO_CONFIG);
    expect(plan.emergency).toBe(true);
    expect(plan.plannedOutput).toBe(480);
    expect(plan.reasons.some((reason) => reason.includes('现金'))).toBe(true);
  });

  it('计划不超设备产能；设备受限时按设备上限生产并保留岗位意图', () => {
    const { world, company } = stageCompany({
      salesHistory: [1_000_000],
      produced: 1_000_000,
      sold: 1_000_000,
    });
    // 1 台工业设备 ≈ 30 万产能，远低于销量参考与劳动产能。
    company.equipment = { farm: 0, industry: 1, energy: 0 };
    const equipmentLimit = equipmentLimitFor(world, company, DEMO_CONFIG);
    const plan = recomputeProductionPlan(world, company, DEMO_CONFIG);
    expect(plan.equipmentLimit).toBe(equipmentLimit);
    expect(plan.plannedOutput).toBe(equipmentLimit);
    expect(plan.plannedOutput).toBeLessThanOrEqual(plan.equipmentLimit + EPSILON);
    expect(plan.plannedJobs).toBeGreaterThan(0);
  });

  it('劳动产能限制计划；补足员工后可重新利用设备', () => {
    const { world, company } = stageCompany({
      salesHistory: [1_000_000],
      produced: 1_000_000,
      sold: 1_000_000,
      employees: 10,
    });
    const limited = recomputeProductionPlan(world, company, DEMO_CONFIG);
    expect(limited.plannedOutput).toBe(limited.laborLimit);
    expect(limited.plannedOutput).toBeLessThanOrEqual(limited.equipmentLimit + EPSILON);
    // 计划比现有员工能做的更多 → 保留招聘意图（岗位需求大于现有人数）。
    expect(limited.plannedJobs).toBeGreaterThan(company.employees);
    expect(limited.reasons.some((reason) => reason.includes('需招聘'))).toBe(true);

    // 招到足够员工后同一 tick 重算：计划不再被劳动上限压住，但仍不超设备产能。
    setCompanyEmployees(company, 20_000);
    company.productionPlan = null;
    const staffed = recomputeProductionPlan(world, company, DEMO_CONFIG);
    expect(staffed.plannedOutput).toBeGreaterThan(limited.plannedOutput);
    expect(staffed.plannedOutput).toBeLessThanOrEqual(staffed.equipmentLimit + EPSILON);
    expect(staffed.plannedOutput).toBeLessThanOrEqual(staffed.laborLimit + EPSILON);
  });

  it('原料不足时实际产量被原料收紧，且不超过计划产量', () => {
    const world = Simulation.create().state;
    const company = world.companies.find((entry) => entry.id === 'lp-food')!;
    const recipe = RECIPES[company.recipeOutput];
    // 只留够生产 100 单位食品的原料：grain 0.62、energy 0.04 每单位。
    company.inventory = createEmptyInventory();
    for (const input of recipe.inputs) company.inventory[input.good] = round2(100 * input.qty);
    setCompanyEmployees(company, 20_000);
    company.cash = 1_000_000_000_000;
    company.salesHistory = [1_000_000];
    company.previousMonth = monthStats({ produced: 1_000_000, sold: 1_000_000 });
    company.productionPlan = null;
    const plan = recomputeProductionPlan(world, company, DEMO_CONFIG);
    expect(plan.plannedOutput).toBeGreaterThan(100);

    // 其他企业停止生产，避免干扰断言。
    for (const other of world.companies) {
      if (other.id === company.id) continue;
      setCompanyEmployees(other, 0);
    }
    const ledgers = createWorldLedgers(world);
    const records = runProduction(world, ledgers, DEMO_CONFIG);
    const record = records.find((entry) => entry.companyId === company.id);
    expect(record).toBeDefined();
    expect(record!.qty).toBe(100);
    expect(company.lastMonth.produced).toBe(100);
    expect(company.lastMonth.produced).toBeLessThanOrEqual(productionTarget(company) + EPSILON);
    // 原料按配方消耗完，没有超计划/超原料生产。
    for (const input of recipe.inputs) {
      expect(company.inventory[input.good] ?? 0).toBeLessThanOrEqual(EPSILON);
    }
  });

  it('销售回升时计划上调但每月不超过 20%', () => {
    const { world, company } = stageCompany({
      salesHistory: [1000, 3000],
      produced: 0,
      sold: 0,
      priorOutput: 1000,
    });
    const plan = recomputeProductionPlan(world, company, DEMO_CONFIG);
    expect(plan.plannedOutput).toBe(1200);
    expect(plan.plannedOutput).toBeLessThanOrEqual(1000 * 1.2 + EPSILON);
    expect(plan.plannedOutput).toBeGreaterThan(1000);
  });

  it('旧档 / 无计划企业安全回退，同一 tick 重算幂等', () => {
    const { world, company } = stageCompany({
      salesHistory: [],
      produced: 0,
      sold: 0,
    });
    company.salesHistory = [];
    company.productionPlan = null;
    expect(productionTarget(company)).toBe(round2(company.capacity * company.utilization));

    const plan = recomputeProductionPlan(world, company, DEMO_CONFIG);
    const equipmentLimit = equipmentLimitFor(world, company, DEMO_CONFIG);
    // 无销量历史：设备产能 × initialSalesFactor 作为有依据的预测。
    expect(plan.salesReference).toBe(round2(equipmentLimit * DEMO_CONFIG.production.plan.initialSalesFactor));
    expect(plan.plannedOutput).toBeGreaterThan(0);
    expect(plan.tick).toBe(world.time.tick);
    expect(productionTarget(company)).toBe(round2(plan.plannedOutput));

    const again = recomputeProductionPlan(world, company, DEMO_CONFIG);
    expect(again).toBe(plan);
  });

  it('计划同时受设备与劳动上限约束（取较小者）', () => {
    const { world, company } = stageCompany({
      salesHistory: [1_000_000],
      produced: 1_000_000,
      sold: 1_000_000,
      employees: 5000,
    });
    company.equipment = { farm: 0, industry: 2, energy: 0 };
    const plan = recomputeProductionPlan(world, company, DEMO_CONFIG);
    const bound = Math.min(plan.equipmentLimit, plan.laborLimit);
    expect(plan.plannedOutput).toBeLessThanOrEqual(bound + EPSILON);
    expect(plan.plannedOutput).toBeGreaterThan(0);
    // 劳动产能来自 production.ts 同一口径。
    const city = world.cities.find((entry) => entry.id === company.cityId)!;
    expect(plan.laborLimit).toBe(laborCapacity(company, city, DEMO_CONFIG, world));
  });
});

describe('v1.0 缺货信号、扩产与招聘/采购优先级', () => {
  function setFoodShortage(
    city: WorldState['cities'][number],
    consumerDemand: number,
    sold: number,
    unmetDemand = 0,
  ): void {
    city.market.food = {
      ...city.market.food,
      consumerDemand,
      sold,
      unmetDemand,
    };
  }

  it('缺货出现时计划上升，且每月只吸收缺口的 20%（再受 ±20% 平滑约束）', () => {
    // 基准：没有缺货，上期计划 1500 → 本月计划 1500。
    const baseline = stageCompany({ priorOutput: 1500 });
    const baselinePlan = recomputeProductionPlan(baseline.world, baseline.company, DEMO_CONFIG);
    expect(baselinePlan.plannedOutput).toBe(1500);
    expect(baselinePlan.reasons.some((reason) => reason.includes('城市缺货'))).toBe(false);

    // 同一形势下出现全城缺货：食品需求 3000、成交 1000。
    const { world, company, city } = stageCompany({ priorOutput: 1500 });
    setFoodShortage(city, 3000, 1000);
    const signal = companyDemandShare(world, company, DEMO_CONFIG);
    const peers = world.companies.filter(
      (entry) => entry.cityId === city.id && entry.recipeOutput === company.recipeOutput,
    );
    expect(signal.cityShortage).toBe(2000);
    expect(signal.peers).toBe(peers.length);
    expect(signal.share).toBeGreaterThan(0);
    expect(signal.share).toBeLessThanOrEqual(1);
    expect(signal.extraDemand).toBe(round2(2000 * signal.share));
    // 每月只吸收 20%：吸收量是平滑前的增量意图。
    expect(signal.absorbed).toBe(round2(signal.extraDemand * DEMO_CONFIG.production.plan.unmetDemandAbsorption));
    expect(signal.absorbed).toBeGreaterThan(0);

    const plan = recomputeProductionPlan(world, company, DEMO_CONFIG);
    // 在 1500 的基础上叠加吸收量，但按月 ±20% 最多到 1800。
    expect(plan.plannedOutput).toBeGreaterThan(baselinePlan.plannedOutput);
    expect(plan.plannedOutput).toBeLessThanOrEqual(1500 * 1.2 + EPSILON);
    expect(plan.reasons.some((reason) => reason.includes('城市缺货'))).toBe(true);
    expect(plan.reasons.some((reason) => reason.includes('吸收'))).toBe(true);
  });

  it('同城多家同产出企业按份额分摊缺货，不把全城缺口重复计入', () => {
    const { world, company, city } = stageCompany({ priorOutput: 1500 });
    setFoodShortage(city, 3000, 1000);
    const peersBefore = world.companies.filter(
      (entry) => entry.cityId === city.id && entry.recipeOutput === company.recipeOutput,
    ).length;
    // 复制一家同城同产出的食品厂（产能与近月销量都相同），份额应被重新分摊。
    const clone: Company = structuredClone(company);
    clone.id = 'lp-food-2';
    clone.productionPlan = null;
    world.companies.push(clone);

    const peers = world.companies.filter(
      (entry) => entry.cityId === city.id && entry.recipeOutput === company.recipeOutput,
    );
    expect(peers.length).toBe(peersBefore + 1);
    const signals = peers.map((entry) => companyDemandShare(world, entry, DEMO_CONFIG));
    for (const signal of signals) expect(signal.peers).toBe(peers.length);
    // Σ份额 = 1（产能份额与销量份额各自合计为 1），不会因企业数量重复放大缺口。
    const totalShare = signals.reduce((total, signal) => total + signal.share, 0);
    expect(totalShare).toBeCloseTo(1, 6);
    const totalAbsorbed = signals.reduce((total, signal) => total + signal.absorbed, 0);
    expect(totalAbsorbed).toBeCloseTo(round2(2000 * DEMO_CONFIG.production.plan.unmetDemandAbsorption), 1);
    // 本企业与克隆企业的份额相同，各拿到全城缺口的一半。
    const original = companyDemandShare(world, company, DEMO_CONFIG);
    const copy = companyDemandShare(world, clone, DEMO_CONFIG);
    expect(original.share).toBeCloseTo(copy.share, 6);
  });

  it('扩产条件：连续 2 月利用率≥80%、库存≤1 月销量、保留资金充足才满足', () => {
    const { world, company } = stageCompany({ salesHistory: [1000], outputStock: 500 });
    const equipmentLimit = equipmentLimitFor(world, company, DEMO_CONFIG);
    const high = round2(equipmentLimit * 0.85);
    company.previousMonth = monthStats({ produced: high, sold: 1000 });

    const good = assessExpansion(world, company, DEMO_CONFIG, {
      plannedOutput: high,
      equipmentLimit,
      salesReference: 1000,
      laborLimit: laborCapacity(company, world.cities.find((c) => c.id === company.cityId)!, DEMO_CONFIG, world),
    });
    expect(good.lastUtilization).toBeGreaterThanOrEqual(DEMO_CONFIG.production.plan.expansionUtilizationThreshold);
    expect(good.plannedUtilization).toBeGreaterThanOrEqual(DEMO_CONFIG.production.plan.expansionUtilizationThreshold);
    expect(good.inventoryMonths).toBeLessThanOrEqual(DEMO_CONFIG.production.plan.expansionInventoryMonths);
    expect(good.eligible).toBe(true);
    expect(good.reasons.some((reason) => reason.includes('扩产条件满足'))).toBe(true);

    // 上月利用率只有 50% → 不满足“连续 2 月≥80%”。
    company.previousMonth = monthStats({ produced: round2(equipmentLimit * 0.5), sold: 1000 });
    const low = assessExpansion(world, company, DEMO_CONFIG, {
      plannedOutput: high,
      equipmentLimit,
      salesReference: 1000,
    });
    expect(low.eligible).toBe(false);
    expect(low.reasons[0]).toContain('扩产条件未满足');

    // 利用率与库存都达标，但现金不够保留 2 月工资 + 近期偿债。
    company.previousMonth = monthStats({ produced: high, sold: 1000 });
    company.cash = 0;
    const poor = assessExpansion(world, company, DEMO_CONFIG, {
      plannedOutput: high,
      equipmentLimit,
      salesReference: 1000,
    });
    expect(poor.eligible).toBe(false);
    expect(poor.reasons[0]).toContain('资金');
  });

  it('自主扩产条件不满足时 AI 不投资，并在 planning reasons 中说明原因', () => {
    const { world, company } = stageCompany({
      priorOutput: 1500,
      outputStock: 1500,
      produced: 1000,
      sold: 1000,
    });
    company.previousMonth = monthStats({ produced: 1000, sold: 1000, profit: 1_000_000 });
    const capacityBefore = company.capacity;
    planCompanies(world, DEMO_CONFIG, []);
    // 上月设备利用率远低于 80% → 不允许自主扩产，金额清零且原因可读。
    expect(company.ai.lastPlan?.investment ?? 0).toBe(0);
    expect(company.capacity).toBe(capacityBefore);
    expect(company.ai.lastPlan?.reasons.some((reason) => reason.includes('暂缓扩产'))).toBe(true);
  });

  it('设备够但缺员工时提示优先招聘；缺原料时提示优先采购；设备不足才提扩产', () => {
    // ① 劳动瓶颈：只有 2 名员工，设备产能远大于劳动产能。
    const labor = stageCompany({ employees: 2, salesHistory: [1000], priorOutput: 1500 });
    const laborPlan = recomputeProductionPlan(labor.world, labor.company, DEMO_CONFIG);
    expect(laborPlan.laborLimit).toBeLessThan(laborPlan.equipmentLimit);
    expect(laborPlan.reasons.some((reason) => reason.includes('劳动产能不足'))).toBe(true);
    expect(laborPlan.reasons.some((reason) => reason.includes('优先招聘'))).toBe(true);

    // ② 原料瓶颈：员工充足但原料与现金都很少，原料资金只够支撑很小的产量。
    const material = stageCompany({
      employees: 20_000,
      salesHistory: [1000],
      inputStock: 10,
    });
    material.company.cash = 1000;
    const materialPlan = recomputeProductionPlan(material.world, material.company, DEMO_CONFIG);
    expect(materialPlan.emergency).toBe(true);
    // 注意：计划保留 minOutputRatio 的维护性产出（避免“计划 0 → 不采购 → 无产出”的死锁），
    // 因此原料缺口体现在原因与采购优先提示上，而不是把计划直接压到原料可支撑量。
    expect(materialPlan.plannedOutput).toBeGreaterThan(materialPlan.salesReference);
    expect(materialPlan.reasons.some((reason) => reason.includes('原料'))).toBe(true);
    expect(materialPlan.reasons.some((reason) => reason.includes('优先采购原料'))).toBe(true);

    // ③ 设备瓶颈：销量远大于 1 台设备产能，劳动与原料都够。
    const equipment = stageCompany({
      employees: 20_000,
      salesHistory: [2_000_000],
      produced: 2_000_000,
      sold: 2_000_000,
    });
    equipment.company.equipment = { farm: 0, industry: 1, energy: 0 };
    const equipmentPlan = recomputeProductionPlan(equipment.world, equipment.company, DEMO_CONFIG);
    expect(equipmentPlan.plannedOutput).toBeLessThanOrEqual(equipmentPlan.equipmentLimit + EPSILON);
    expect(equipmentPlan.reasons.some((reason) => reason.includes('设备产能不足'))).toBe(true);
    expect(equipmentPlan.reasons.some((reason) => reason.includes('扩产条件'))).toBe(true);
  });

  it('旧档 / 无计划企业在缺货信号下安全回退，仍按份额吸收', () => {
    const { world, company, city } = stageCompany({
      salesHistory: [],
      produced: 0,
      sold: 0,
    });
    company.salesHistory = [];
    company.productionPlan = null;
    setFoodShortage(city, 3000, 0);
    const plan = recomputeProductionPlan(world, company, DEMO_CONFIG);
    expect(plan.salesReference).toBe(
      round2(equipmentLimitFor(world, company, DEMO_CONFIG) * DEMO_CONFIG.production.plan.initialSalesFactor),
    );
    expect(plan.plannedOutput).toBeGreaterThan(0);
    expect(plan.reasons.some((reason) => reason.includes('城市缺货'))).toBe(true);
    // 同 tick 重算幂等，不会重复吸收缺货。
    expect(recomputeProductionPlan(world, company, DEMO_CONFIG)).toBe(plan);
  });
});
