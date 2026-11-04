// 设备补贴原子性回归（v0.9 验收问题三）。
//
// 规则：
// - 补贴只按“实际成交数量 × 实际成交单价”计算，且不超过政策剩余预算与成交额 × 补贴率；
// - 无设备供应、资金不足、成交校验失败时，资金/政策预算/库存/设备/账本全部无副作用；
// - 部分成交按实际成交额结算，不得按计划量预支补贴；
// - 政府库存与企业库存两种卖方都要真实收款、真实出库。
import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation/core/simulation';
import { DEMO_CONFIG } from '../src/data/config';
import { createWorldLedgers } from '../src/simulation/markets/markets';
import { checkInvariants } from '../src/simulation/core/invariants';
import { expandCompanyCapacity } from '../src/simulation/companies/lifecycle/lifecycle';
import { startPolicy } from '../src/simulation/policies/policies';
import { activePolicy } from '../src/simulation/policies/query';
import {
  equipmentKindForSector,
  executeNewEquipmentPlan,
  planNewEquipmentPurchase,
  recomputeCompanyCapacity,
} from '../src/simulation/equipment/equipment';

interface SetupOptions {
  cash?: number;
  treasury?: number;
  governmentStock?: number;
  policyBudget?: number;
}

function setup(options: SetupOptions = {}) {
  const sim = Simulation.create(DEMO_CONFIG);
  const world = sim.state;
  const city = world.cities.find((entry) => entry.id === 'lanport')!;
  city.treasury = options.treasury ?? 100_000_000;
  const company = world.companies.find((entry) => entry.id === 'lp-food')!;
  company.cash = options.cash ?? 5_000_000;
  // 清空所有城市的设备商品库存，精确控制“同城企业供应 + 政府库存”来源。
  for (const candidate of world.companies) {
    candidate.inventory.industryEquipment = 0;
  }
  // v1.0 开局设备生产商分布在各城，清库存后必须同步各城市场期末库存，避免不变量误报。
  for (const marketCity of world.cities) {
    marketCity.market.industryEquipment!.closingStock = 0;
  }
  const ledger = city.market.industryEquipment!;
  ledger.closingStock = 0;
  world.equipmentMarket.initialStock.industry = options.governmentStock ?? 0;
  const started = startPolicy(world, city.id, 'equipmentSubsidy', DEMO_CONFIG, {
    ...(options.policyBudget === undefined ? {} : { budget: options.policyBudget }),
  });
  expect(started.ok, started.error).toBe(true);
  const policy = activePolicy(world, city.id, 'equipmentSubsidy')!;
  const kind = equipmentKindForSector(company.sector, DEMO_CONFIG);
  expect(kind).toBe('industry');
  const capacityPerUnit = DEMO_CONFIG.equipment.catalog.industry.capacityPerUnit;
  const tech = city.technology.productivityMultiplier;
  // 政府库存按目录价结算；同城企业按本城设备市场价格结算。
  const catalogPrice = DEMO_CONFIG.equipment.catalog.industry.price;
  const marketPrice = ledger.price;
  return { world, city, company, policy, ledger, catalogPrice, marketPrice, capacityPerUnit, tech };
}

/** 把企业产能抬高到足以规划 2 台设备的规模（扩产计划上限 = capacity × maxExpansionShare）。 */
function raiseCapacityForTwoUnits(
  world: ReturnType<typeof setup>['world'],
  company: ReturnType<typeof setup>['company'],
): void {
  company.equipment.industry += 12;
  recomputeCompanyCapacity(world, company, DEMO_CONFIG);
}

describe('设备补贴只按实际成交结算', () => {
  it('无设备供应：扩产失败且资金/预算/库存/产能零副作用', () => {
    const { world, city, company, policy, ledger } = setup({ governmentStock: 0 });
    const cashBefore = company.cash;
    const treasuryBefore = city.treasury;
    const capacityBefore = company.capacity;
    const stockBefore = world.equipmentMarket.initialStock.industry;
    const supplyBefore = ledger.supply;
    const soldBefore = ledger.sold;

    const result = expandCompanyCapacity(world, company, DEMO_CONFIG, [], 100);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('没有可购买');
    expect(company.cash).toBeCloseTo(cashBefore, 2);
    expect(city.treasury).toBeCloseTo(treasuryBefore, 2);
    expect(policy.spent).toBe(0);
    expect(world.equipmentMarket.initialStock.industry).toBe(stockBefore);
    expect(company.capacity).toBeCloseTo(capacityBefore, 2);
    expect(company.equipment.industry).toBe(12);
    expect(ledger.supply).toBe(supplyBefore);
    expect(ledger.sold).toBe(soldBefore);
    expect(checkInvariants(world)).toEqual([]);
  });

  it('资金不足：补贴不发放、库存与设备不动', () => {
    const { world, city, company, policy, ledger, catalogPrice } = setup({
      cash: 10_000,
      governmentStock: 2,
    });
    const cashBefore = company.cash;
    const treasuryBefore = city.treasury;
    const stockBefore = world.equipmentMarket.initialStock.industry;
    const equipmentBefore = company.equipment.industry;

    const result = expandCompanyCapacity(world, company, DEMO_CONFIG, [], 300_000);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('资金不足');
    expect(company.cash).toBeCloseTo(cashBefore, 2);
    expect(city.treasury).toBeCloseTo(treasuryBefore, 2);
    expect(policy.spent).toBe(0);
    expect(world.equipmentMarket.initialStock.industry).toBe(stockBefore);
    expect(company.equipment.industry).toBe(equipmentBefore);
    expect(ledger.sold).toBe(0);
    // 确保测试确实覆盖到“补贴后仍买不起”的分支。
    expect(catalogPrice).toBeGreaterThan(cashBefore);
    expect(checkInvariants(world)).toEqual([]);
  });

  it('部分成交：计划 2 台、实际只有 1 台，只按 1 台成交额付款与补贴', () => {
    const { world, city, company, policy, ledger, catalogPrice, capacityPerUnit, tech } = setup({
      cash: 1_000_000,
      governmentStock: 1,
    });
    raiseCapacityForTwoUnits(world, company);
    const equipmentBefore = company.equipment.industry;
    const cashBefore = company.cash;
    const treasuryBefore = city.treasury;
    const capacityBefore = company.capacity;

    // 计划 2 台（600000 单位产能），政府库存只有 1 台。
    const result = expandCompanyCapacity(world, company, DEMO_CONFIG, [], 600_000);

    expect(result.ok, result.error).toBe(true);
    const actualCost = catalogPrice;
    const expectedSubsidy =
      Math.round(actualCost * DEMO_CONFIG.policies.equipment.subsidyRate * 100) / 100;
    expect(company.equipment.industry).toBe(equipmentBefore + 1);
    expect(company.cash).toBeCloseTo(cashBefore + expectedSubsidy - actualCost, 2);
    expect(city.treasury).toBeCloseTo(treasuryBefore + actualCost - expectedSubsidy, 2);
    expect(policy.spent).toBeCloseTo(expectedSubsidy, 2);
    expect(world.equipmentMarket.initialStock.industry).toBe(0);
    const partialLedger = createWorldLedgers(world)[city.id]!.industryEquipment!;
    expect(partialLedger.sold).toBe(1);
    expect(partialLedger.sold).toBeLessThanOrEqual(partialLedger.supply + 1e-6);
    expect(company.capacity).toBeCloseTo(
      Math.round((equipmentBefore + 1) * capacityPerUnit * tech * 100) / 100,
      2,
    );
    expect(company.capacity).toBeCloseTo(company.equipmentCapacity, 2);
    expect(company.capacity).toBeGreaterThan(capacityBefore);
    expect(checkInvariants(world)).toEqual([]);
  });

  it('政府库存卖方：财政先收设备款、再按实际成交额支出补贴，账本计入供应与成交', () => {
    const { world, city, company, policy, ledger, catalogPrice } = setup({ governmentStock: 1 });
    const cashBefore = company.cash;
    const treasuryBefore = city.treasury;
    const stockBefore = world.equipmentMarket.initialStock.industry;
    const supplyBefore = createWorldLedgers(world)[city.id]!.industryEquipment!.supply;

    const result = expandCompanyCapacity(world, company, DEMO_CONFIG, [], 300_000);

    expect(result.ok, result.error).toBe(true);
    const cost = catalogPrice;
    const subsidy = Math.round(cost * DEMO_CONFIG.policies.equipment.subsidyRate * 100) / 100;
    expect(world.equipmentMarket.initialStock.industry).toBe(stockBefore - 1);
    const governmentLedger = createWorldLedgers(world)[city.id]!.industryEquipment!;
    expect(governmentLedger.supply).toBe(supplyBefore + 1);
    expect(governmentLedger.sold).toBe(1);
    expect(policy.spent).toBeCloseTo(subsidy, 2);
    expect(city.treasury).toBeCloseTo(treasuryBefore + cost - subsidy, 2);
    expect(company.cash).toBeCloseTo(cashBefore + subsidy - cost, 2);
    expect(checkInvariants(world)).toEqual([]);
  });

  it('企业库存卖方：卖方真实收款、库存出库并记入市场成交', () => {
    const { world, city, company, policy, ledger, marketPrice } = setup({ governmentStock: 0 });
    // 设备卖方必须是该设备商品的生产企业；测试中把一家同城企业指认为设备生产商并注入库存。
    const seller = world.companies.find((entry) => entry.id === 'lp-garment')!;
    seller.recipeOutput = 'industryEquipment';
    seller.inventory.industryEquipment = 2;
    // v1.0 每台设备产能取决于产出商品（资本品 3 台/月 vs 普通商品 300,000 单位/月），
    // 指认产出后必须重算产能缓存，否则不变量会报“缓存与设备推导不一致”。
    recomputeCompanyCapacity(world, seller, DEMO_CONFIG);
    ledger.supply = 2;
    ledger.closingStock = 2;
    const sellerCashBefore = seller.cash;
    const sellerSoldBefore = seller.lastMonth.sold;
    const sellerRevenueBefore = seller.lastMonth.revenue;
    const cashBefore = company.cash;
    const treasuryBefore = city.treasury;

    const result = expandCompanyCapacity(world, company, DEMO_CONFIG, [], 300_000);

    expect(result.ok, result.error).toBe(true);
    const cost = marketPrice;
    const subsidy = Math.round(cost * DEMO_CONFIG.policies.equipment.subsidyRate * 100) / 100;
    expect(seller.inventory.industryEquipment).toBe(1);
    expect(seller.cash).toBeCloseTo(sellerCashBefore + cost, 2);
    expect(seller.lastMonth.sold).toBe(sellerSoldBefore + 1);
    expect(seller.lastMonth.revenue).toBeCloseTo(sellerRevenueBefore + cost, 2);
    const companyLedger = createWorldLedgers(world)[city.id]!.industryEquipment!;
    expect(companyLedger.sold).toBe(1);
    expect(companyLedger.sold).toBeLessThanOrEqual(companyLedger.supply + 1e-6);
    expect(company.cash).toBeCloseTo(cashBefore + subsidy - cost, 2);
    expect(policy.spent).toBeCloseTo(subsidy, 2);
    expect(city.treasury).toBeCloseTo(treasuryBefore - subsidy, 2);
    // 成交后企业库存减少，市场期末库存需与之一致（真实月结会在期末重算）。
    ledger.closingStock = seller.inventory.industryEquipment;
    expect(checkInvariants(world)).toEqual([]);
  });

  it('成交前卖方库存变化：提交整体失败，资金/库存/设备/账本零副作用', () => {
    const { world, city, company, ledger } = setup({ governmentStock: 1 });
    const plan = planNewEquipmentPurchase(world, company, 'industry', 1, DEMO_CONFIG, {
      allowGovernmentStock: true,
      allowIntercity: false,
    });
    expect(plan.ok, plan.error).toBe(true);
    // 规划后政府库存被其他交易占用：提交必须整体失败，不能留下半成品。
    world.equipmentMarket.initialStock.industry = 0;
    const cashBefore = company.cash;
    const treasuryBefore = city.treasury;
    const equipmentBefore = company.equipment.industry;
    const soldBefore = ledger.sold;

    const result = executeNewEquipmentPlan(world, company, 'industry', plan, DEMO_CONFIG, world.time.tick);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('库存已变化');
    expect(company.cash).toBeCloseTo(cashBefore, 2);
    expect(city.treasury).toBeCloseTo(treasuryBefore, 2);
    expect(company.equipment.industry).toBe(equipmentBefore);
    expect(ledger.sold).toBe(soldBefore);
    expect(checkInvariants(world)).toEqual([]);
  });

  it('补贴不超过政策剩余预算，剩余不足时按剩余预算封顶', () => {
    const { world, city, company, policy, catalogPrice } = setup({
      cash: 5_000_000,
      governmentStock: 1,
      policyBudget: 80_000,
    });
    const cashBefore = company.cash;
    const treasuryBefore = city.treasury;

    const result = expandCompanyCapacity(world, company, DEMO_CONFIG, [], 300_000);

    expect(result.ok, result.error).toBe(true);
    const cost = catalogPrice;
    const fullSubsidy = Math.round(cost * DEMO_CONFIG.policies.equipment.subsidyRate * 100) / 100;
    expect(fullSubsidy).toBeGreaterThan(80_000);
    expect(policy.spent).toBeCloseTo(80_000, 2);
    expect(company.cash).toBeCloseTo(cashBefore + 80_000 - cost, 2);
    expect(city.treasury).toBeCloseTo(treasuryBefore + cost - 80_000, 2);
    expect(checkInvariants(world)).toEqual([]);
  });
});
