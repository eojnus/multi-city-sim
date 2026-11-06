// v1.6 §三 + §四.4：企业真实报价竞争、需求评估、缺口驱动增产、多余设备出售、创业防羊群、
// 设备维护费进入 AI 决策。
//
// 口径与实现（P3 / pool-dev）：
// - 成交规则未改：市场按 unitPrice（= round2(市场价 × priceFactor)）升序成交，报价更低的
//   同类企业自然拿到更多订单；
// - 定价由成本（原料+工资+维护费）、库存/需求、对手报价与销量共同决定；内部 priceFactor
//   保留 6 位小数、每月变动至少 1 分钱，修复“0.25% 风格偏移被 round2 吞掉”的问题；
// - 需求估计 = 本城可支付缺货份额 + 资金缺口折算 + 降价机会 + 可达跨城（全部按份额），
//   潜在部分只按吸收比例进入计划，不当确定订单；
// - 有盈利 + 真实缺货 + 设备有余量时优先用现有设备增产（并招聘/采购原料），
//   设备利用率低时不得只靠买新设备扩产；长期闲置且无缺货时可出售多余设备。
import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation/core/simulation';
import { DEMO_CONFIG } from '../src/data/config';
import type {
  Company,
  CompanyMonthlyStats,
  CompanyProductionPlan,
  EquipmentKind,
  MarketState,
  WorldState,
} from '../src/simulation/contracts/types';
import { round2 } from '../src/simulation/core/math';
import { createEmptyInventory, setCompanyEmployees } from '../src/simulation/companies/company';
import {
  companyDemandShare,
  equipmentLimitFor,
  assessEquipmentSurplus,
  recomputeProductionPlan,
} from '../src/simulation/companies/production-plan';
import { planCompanyPrice, quotedUnitPrice } from '../src/simulation/companies/pricing';
import { planCompanyDecision } from '../src/simulation/companies/ai/strategy';
import { companyMonthlyMaintenance } from '../src/simulation/companies/cost';
import { planCompanies } from '../src/simulation/companies/planning';
import { createWorldLedgers, executePurchase } from '../src/simulation/markets/markets';
import {
  assessFounding,
  foundingCandidateForOutput,
  foundingSaturated,
} from '../src/simulation/companies/founding';

const CITY_ID = 'lanport';

function cityOf(world: WorldState, cityId = CITY_ID): WorldState['cities'][number] {
  return world.cities.find((city) => city.id === cityId)!;
}

function companyOf(world: WorldState, id: string): Company {
  return world.companies.find((company) => company.id === id)!;
}

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

function setMarket(
  city: WorldState['cities'][number],
  goodId: Company['recipeOutput'],
  overrides: Partial<MarketState>,
): void {
  city.market[goodId] = { ...city.market[goodId], ...overrides };
}

function priorPlan(
  world: WorldState,
  company: Company,
  plannedOutput: number,
  tick: number,
): CompanyProductionPlan {
  return {
    tick,
    salesReference: 0,
    targetInventory: 0,
    equipmentLimit: equipmentLimitFor(world, company, DEMO_CONFIG),
    laborLimit: 0,
    plannedOutput,
    plannedJobs: 0,
    emergency: false,
    reasons: [],
  };
}


/**
 * 低价行业夹具：谷物企业、员工置 0（工资账单=0）、配方无原料（投入成本=0），
 * 只剩很小的设备维护费，因此“单位成本底线”不会压住价格信号；
 * 用于单独验证 0.25% 风格偏移这类“不足 1 分钱”的变动是否被成交价舍入吞掉。
 */
function stageLowPriceCompany(): {
  world: WorldState;
  company: Company;
  city: WorldState['cities'][number];
} {
  const world = Simulation.create().state;
  const city = cityOf(world);
  const company = companyOf(world, 'lp-grain2');
  setCompanyEmployees(company, 0);
  company.jobDemand = 0;
  company.cash = 1_000_000;
  company.inventory = createEmptyInventory();
  company.salesHistory = [0, 0, 0];
  company.previousMonth = monthStats();
  company.productionPlan = null;
  company.priceFactor = 1;
  company.ai.style = 'steady';
  setMarket(city, 'grain', {
    price: 2,
    consumerDemand: 0,
    producerDemand: 0,
    sold: 0,
    unmetDemand: 0,
    unmetFunding: 0,
    intercityImported: 0,
  });
  return { world, company, city };
}

describe('v1.6 §三 真实报价竞争', () => {
  it('报价更低的同类企业先成交；高价企业在低价库存卖完后才拿到订单', () => {
    const world = Simulation.create().state;
    const city = cityOf(world);
    const cheap = companyOf(world, 'lp-food');
    const price = 10;
    setMarket(city, 'food', {
      price,
      consumerDemand: 0,
      producerDemand: 0,
      sold: 0,
      unmetDemand: 0,
      unmetFunding: 0,
      intercityImported: 0,
    });
    // 清空干扰库存：只有两家食品厂有货。
    for (const company of world.companies) company.inventory.food = 0;
    cheap.priceFactor = 0.9;
    cheap.inventory.food = 100;
    cheap.lastMonth = monthStats();
    const rival: Company = structuredClone(cheap);
    rival.id = 'lp-food-rival';
    rival.name = '岚港食品二厂';
    rival.priceFactor = 1;
    rival.inventory.food = 100;
    rival.lastMonth = monthStats();
    world.companies.push(rival);

    // 两家报价：9.00 vs 10.00（市场按单价升序成交）。
    expect(quotedUnitPrice(price, cheap.priceFactor)).toBe(9);
    expect(quotedUnitPrice(price, rival.priceFactor)).toBe(10);

    const ledgers = createWorldLedgers(world);
    const cityLedgers = ledgers[city.id]!;
    const first = executePurchase(world, city, cityLedgers, 'food', 40, 1_000_000, { consumer: true }, DEMO_CONFIG);
    expect(first.qty).toBeGreaterThan(0);
    expect(cheap.lastMonth.sold).toBeGreaterThan(0);
    expect(rival.lastMonth.sold).toBe(0);

    // 低价企业剩余库存卖完后，订单才流向高价企业。
    const second = executePurchase(world, city, cityLedgers, 'food', 500, 1_000_000, { consumer: true }, DEMO_CONFIG);
    expect(second.qty).toBeGreaterThan(first.qty);
    expect(rival.lastMonth.sold).toBeGreaterThan(0);
  });

  it('价格每月变动至少 1 分钱，不再被成交价 round2 吞掉（内部高精度系数）', () => {
    const { world, company } = stageLowPriceCompany();
    company.ai.style = 'return';
    const raised = planCompanyPrice(world, company, DEMO_CONFIG);
    expect(raised.previousPrice).toBe(2);
    expect(raised.quotedPrice).toBeGreaterThanOrEqual(raised.previousPrice + 0.01 - 1e-9);
    expect(raised.priceFactor).toBeGreaterThan(1);

    company.ai.style = 'growth';
    const cut = planCompanyPrice(world, company, DEMO_CONFIG);
    expect(cut.quotedPrice).toBeLessThanOrEqual(cut.previousPrice - 0.01 + 1e-9);
    expect(cut.priceFactor).toBeLessThan(1);

    // 24 个月连续变动：始终在 [0.85, 1.15] × 市场价内，无负价、无失控价。
    let factor = 1;
    for (let month = 0; month < 24; month++) {
      world.time.tick += 1;
      company.priceFactor = factor;
      const decision = planCompanyPrice(world, company, DEMO_CONFIG);
      factor = decision.priceFactor;
      expect(Number.isFinite(factor)).toBe(true);
      expect(factor).toBeGreaterThanOrEqual(DEMO_CONFIG.companyAi.priceBiasMin - 1e-9);
      expect(factor).toBeLessThanOrEqual(DEMO_CONFIG.companyAi.priceBiasMax + 1e-9);
      expect(decision.quotedPrice).toBeGreaterThanOrEqual(0.01);
      expect(Number.isFinite(decision.quotedPrice)).toBe(true);
    }
    // growth 风格累计降价（每月至少 1 分钱），价格明确低于初始 2.00。
    expect(quotedUnitPrice(2, factor)).toBeLessThan(2);
  });

  it('真实缺货时加价、严重积压时降价，且加价不超过绝对上限', () => {
    const { world, company, city } = stageLowPriceCompany();
    setMarket(city, 'grain', {
      price: 10,
      producerDemand: 100_000,
      consumerDemand: 0,
      sold: 0,
      unmetDemand: 100_000,
      unmetFunding: 0,
      intercityImported: 0,
    });
    company.salesHistory = [100];
    company.previousMonth = monthStats({ sold: 100 });
    const shortage = planCompanyPrice(world, company, DEMO_CONFIG);
    expect(shortage.quotedPrice).toBeGreaterThan(10);
    expect(shortage.reasons.some((reason) => reason.includes('短缺'))).toBe(true);

    // 严重积压 + 无缺货 → 降价。
    setMarket(city, 'grain', {
      price: 10,
      producerDemand: 0,
      consumerDemand: 0,
      sold: 0,
      unmetDemand: 0,
      unmetFunding: 0,
      intercityImported: 0,
    });
    company.priceFactor = 1;
    company.inventory.grain = 10_000;
    const surplus = planCompanyPrice(world, company, DEMO_CONFIG);
    expect(surplus.quotedPrice).toBeLessThan(10);
    expect(surplus.reasons.some((reason) => reason.includes('积压'))).toBe(true);

    // 连续 24 个月缺货也只到绝对上限 1.15 × 市场价，不会失控。
    company.inventory.grain = 0;
    for (let month = 0; month < 24; month++) {
      world.time.tick += 1;
      setMarket(city, 'grain', {
        price: 10,
        producerDemand: 100_000,
        sold: 0,
        unmetDemand: 100_000,
        unmetFunding: 0,
        intercityImported: 0,
      });
      company.priceFactor = planCompanyPrice(world, company, DEMO_CONFIG).priceFactor;
    }
    expect(company.priceFactor).toBeLessThanOrEqual(DEMO_CONFIG.companyAi.priceBiasMax + 1e-9);
    expect(quotedUnitPrice(10, company.priceFactor)).toBeLessThanOrEqual(11.5 + 1e-6);
  });
});

describe('v1.6 §三 需求评估：不只参考上月销量', () => {
  it('资金缺口与可达跨城缺口进入需求估计，但只按小比例折算、不当确定订单', () => {
    const world = Simulation.create().state;
    const city = cityOf(world);
    const company = companyOf(world, 'lp-food');
    const other = cityOf(world, 'greenfield');
    company.salesHistory = [0, 0, 0];
    company.previousMonth = monthStats();
    company.productionPlan = null;
    company.inventory = createEmptyInventory();
    // 本城：可支付缺货 0，但居民“想买买不起”200,000。
    setMarket(city, 'food', {
      consumerDemand: 0,
      producerDemand: 0,
      sold: 0,
      unmetDemand: 0,
      unmetFunding: 200_000,
      intercityImported: 0,
    });
    // 另一城市：真实可支付缺货 150,000（可达跨城市场）。
    setMarket(other, 'food', {
      consumerDemand: 150_000,
      producerDemand: 0,
      sold: 0,
      unmetDemand: 150_000,
      unmetFunding: 0,
      intercityImported: 0,
    });

    const signal = companyDemandShare(world, company, DEMO_CONFIG);
    expect(signal.cityShortage).toBe(0);
    expect(signal.extraDemand).toBe(0);
    expect(signal.fundingOpportunity).toBeGreaterThan(0);
    expect(signal.intercityOpportunity).toBeGreaterThan(0);
    expect(signal.latentDemand).toBeGreaterThan(0);
    expect(signal.reachableDemand).toBe(signal.latentDemand);
    // 资金缺口不是确定订单：只按 fundingDemandShare 折算（且再按企业份额）。
    expect(signal.fundingOpportunity).toBeLessThanOrEqual(200_000 * DEMO_CONFIG.production.plan.fundingDemandShare);
    // 潜在需求只按吸收比例进入计划。
    expect(signal.latentAbsorbed).toBeCloseTo(
      round2(signal.latentDemand * DEMO_CONFIG.production.plan.unmetDemandAbsorption),
      2,
    );

    const plan = recomputeProductionPlan(world, company, DEMO_CONFIG);
    expect(plan.reachableDemand ?? 0).toBeGreaterThan(0);
    expect(plan.latentDemand ?? 0).toBeGreaterThan(0);
    expect(plan.reasons.some((reason) => reason.includes('潜在需求'))).toBe(true);
    // 上月销量为 0，但需求参考不为 0：不再被“历史零销量”完全忽略。
    expect(plan.targetInventory).toBeGreaterThan(0);
  });
});

describe('v1.6 §三 生产：优先用现有设备增产/招聘', () => {
  it('有盈利 + 真实缺货 + 设备余量：直接增产并提高岗位需求，且不靠买新设备', () => {
    const world = Simulation.create().state;
    const city = cityOf(world);
    const company = companyOf(world, 'lp-food');
    // 员工数：足够支撑“上月产量”继续爬坡，但不足以支撑全部可触达需求（→ 需要招聘）。
    setCompanyEmployees(company, 5_000);
    company.jobDemand = 5_000;
    company.cash = 1_000_000_000;
    company.utilization = 0.8;
    company.inventory = createEmptyInventory();
    for (const input of [
      { good: 'grain' as const, qty: 5000 },
      { good: 'energy' as const, qty: 5000 },
    ]) {
      company.inventory[input.good] = 1_000_000_000;
    }
    company.salesHistory = [1000];
    const equipmentLimit = equipmentLimitFor(world, company, DEMO_CONFIG);
    expect(equipmentLimit).toBeGreaterThan(0);
    // 上月只用了设备 10%：设备尚有余量。
    company.previousMonth = monthStats({
      produced: round2(equipmentLimit * 0.1),
      sold: 1000,
      profit: 1_000_000,
    });
    company.productionPlan = priorPlan(world, company, round2(equipmentLimit * 0.1), world.time.tick - 1);
    setMarket(city, 'food', {
      price: Math.max(0.01, city.market.food.price),
      consumerDemand: 3_000_000,
      producerDemand: 0,
      sold: 0,
      unmetDemand: 3_000_000,
      unmetFunding: 0,
      intercityImported: 0,
    });

    const plan = recomputeProductionPlan(world, company, DEMO_CONFIG);
    const previous = round2(equipmentLimit * 0.1);
    // 不再被 ±20% 平滑压住：需求驱动增产直接向设备/劳动上限靠拢。
    expect(plan.plannedOutput).toBeGreaterThan(previous * 1.2);
    expect(plan.plannedOutput).toBeLessThanOrEqual(equipmentLimit + 0.01);
    expect(plan.reasons.some((reason) => reason.includes('优先用现有设备增产'))).toBe(true);
    // 设备够但员工不够 → 岗位需求高于现有人数（招聘），而不是先买设备。
    expect(plan.plannedJobs).toBeGreaterThan(company.employees);
    expect(plan.reasons.some((reason) => reason.includes('招聘'))).toBe(true);

    // 走完整计划流程：设备利用率低时不执行设备投资（不得只靠买新设备扩产）。
    const capacityBefore = company.capacity;
    planCompanies(world, DEMO_CONFIG, []);
    expect(company.ai.lastPlan).not.toBeNull();
    expect(company.capacity).toBeCloseTo(capacityBefore, 6);
    expect(company.ai.lastPlan?.investment ?? 0).toBe(0);
  });

  it('设备长期闲置 + 无真实缺货 + 现金/库存压力时才出售多余设备；有缺货时优先增产不卖设备', () => {
    const world = Simulation.create().state;
    const city = cityOf(world);
    const company = companyOf(world, 'lp-food');
    const kind: EquipmentKind = 'industry';
    company.equipment = { farm: 0, industry: 4, energy: 0 };
    company.initialEquipment = undefined;
    company.inventory = createEmptyInventory();
    company.inventory.food = 10_000;
    company.cash = 1000;
    company.salesHistory = [100];
    company.previousMonth = monthStats({ produced: 0, sold: 0 });
    company.productionPlan = {
      ...priorPlan(world, company, 0, world.time.tick - 1),
      salesReference: 100,
      plannedOutput: 0,
      laborLimit: 0,
    };
    setMarket(city, 'food', {
      consumerDemand: 0,
      sold: 0,
      unmetDemand: 0,
      unmetFunding: 0,
      intercityImported: 0,
    });
    expect(equipmentLimitFor(world, company, DEMO_CONFIG)).toBeGreaterThan(0);

    const surplus = assessEquipmentSurplus(world, company, DEMO_CONFIG);
    expect(surplus.ownedUnits).toBe(4);
    expect(surplus.sellableUnits).toBe(4);
    expect(surplus.eligible).toBe(true);
    expect(surplus.unitsToSell).toBeGreaterThan(0);
    expect(surplus.unitsToSell).toBeLessThanOrEqual(Math.floor(4 / 2));

    // 锁定期内的实物出资设备不可出售。
    // 既有守恒测试要求“锁定期内该类设备台数只增不减”，因此 AI 在整段锁定期内
    // 不出售该行业设备（保守规则，见 assessEquipmentSurplus 注释）。
    company.initialEquipment = {
      kind,
      units: 1,
      valuation: 120_000,
      source: 'founderInKind',
      grantedTick: 0,
      lockUntilTick: world.time.tick + 10,
    };
    const locked = assessEquipmentSurplus(world, company, DEMO_CONFIG);
    expect(locked.sellableUnits).toBe(0);
    expect(locked.eligible).toBe(false);
    expect(locked.reasons.some((reason) => reason.includes('锁定期'))).toBe(true);

    // 本城出现真实可支付缺货：不出售设备，优先用现有设备增产。
    company.initialEquipment = undefined;
    setMarket(city, 'food', {
      consumerDemand: 50_000,
      sold: 0,
      unmetDemand: 50_000,
      intercityImported: 0,
    });
    const withDemand = assessEquipmentSurplus(world, company, DEMO_CONFIG);
    expect(withDemand.eligible).toBe(false);
    expect(withDemand.reasons.some((reason) => reason.includes('增产'))).toBe(true);
  });
});

describe('v1.6 §三 创业 AI：避免同行业羊群', () => {
  it('近期同城同行业密集新办会降低竞争分项与总分，并触发“饱和”判定', () => {
    const world = Simulation.create().state;
    const city = cityOf(world);
    // 需求远小于现有产能：供给/需求 > 1，属于饱和行业。
    setMarket(city, 'food', {
      price: Math.max(0.01, city.market.food.price) * 1.6,
      consumerDemand: 1_000,
      producerDemand: 0,
      sold: 0,
      unmetDemand: 1_000,
      unmetFunding: 0,
      intercityImported: 0,
    });
    const clean = foundingCandidateForOutput(world, DEMO_CONFIG, city.id, 'food');
    expect(clean.recentFoundings).toBe(0);

    // 过去 3 个月同城食品行业新办 3 家（记录在 foundings 历史里，不是本 tick）。
    world.time.tick = 13;
    for (let index = 0; index < 3; index++) {
      world.lifecycle.foundings.push({
        id: `founding-herd-${index}`,
        tick: 10 + index,
        cityId: city.id,
        companyId: `herd-${index}`,
        companyName: `羊群企业 ${index}`,
        sector: 'food',
        recipeOutput: 'food',
        founderType: 'investorGroup',
        capital: 300_000,
        investorCount: 1,
        investors: [],
        governmentGrant: 0,
        note: '测试：防羊群构造',
      });
    }
    const crowded = foundingCandidateForOutput(world, DEMO_CONFIG, city.id, 'food');
    expect(crowded.recentFoundings).toBe(3);
    expect(crowded.breakdown.competition).toBeLessThan(clean.breakdown.competition);
    expect(crowded.score).toBeLessThan(clean.score);
    expect(crowded.reasons.some((reason) => reason.includes('羊群'))).toBe(true);

    const assessment = assessFounding(world, DEMO_CONFIG, city.id, 'food');
    expect(assessment.metrics.recentFoundings).toBe(3);
    expect(assessment.metrics.demandCoverage ?? 0).toBeGreaterThan(1);
    expect(foundingSaturated(assessment).saturated).toBe(true);

    // 没有近期新办记录时不会误判为羊群。
    world.lifecycle.foundings = world.lifecycle.foundings.filter((record) => record.tick >= 12);
    const fresh = assessFounding(world, DEMO_CONFIG, city.id, 'food');
    expect(foundingSaturated(fresh).saturated).toBe(false);
  });
});

describe('v1.6 §四.4 维护费进入 AI 决策', () => {
  it('生产计划与经营决定都计入设备维护费（固定成本的一部分）', () => {
    const world = Simulation.create().state;
    const city = cityOf(world);
    const company = companyOf(world, 'lp-food');
    company.cash = 10_000_000;
    company.salesHistory = [1000];
    company.previousMonth = monthStats({ produced: 1000, sold: 1000, profit: 100_000 });

    const maintenance = companyMonthlyMaintenance(world, company, DEMO_CONFIG);
    expect(maintenance).toBeGreaterThan(0);

    const plan = recomputeProductionPlan(world, company, DEMO_CONFIG);
    expect(plan.maintenanceCost ?? 0).toBeCloseTo(maintenance, 2);

    const decision = planCompanyDecision(world, company, DEMO_CONFIG);
    expect(decision.reasons.some((reason) => reason.includes('设备维护费'))).toBe(true);
    expect(city.id).toBe(company.cityId);
  });
});
