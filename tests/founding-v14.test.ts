import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation/core/simulation';
import { DEMO_CONFIG, type DemoConfig } from '../src/data/config';
import { GOODS } from '../src/data/demo-data';
import type { EquipmentKind, LogEntry, WorldState } from '../src/simulation/contracts/types';
import { INITIAL_EQUIPMENT_LOCK_MONTHS } from '../src/simulation/companies/founding';
import {
  expandCompanyCapacity,
  foundCompany,
  liquidateCompany,
  maybeFoundCompanies,
  checkBankruptcies,
} from '../src/simulation/companies/lifecycle/lifecycle';
import {
  buyUsedEquipment,
  equipmentCapacityPerUnit,
  equipmentUnitPrice,
  listUsedEquipment,
} from '../src/simulation/equipment/equipment';
import { checkInvariants } from '../src/simulation/core/invariants';
import { parseSave, serializeLegacySave, serializeSave } from '../src/simulation/core/save';

const KINDS: EquipmentKind[] = ['farm', 'industry', 'energy'];

function richWorld(): WorldState {
  const world = Simulation.create().state;
  for (const city of world.cities) city.treasury = 50_000_000;
  for (const group of world.investors) group.cash = 100_000_000;
  for (const company of world.companies) company.cash = 50_000_000;
  return world;
}

function cityOf(world: WorldState, cityId: string) {
  return world.cities.find((city) => city.id === cityId)!;
}

/** 构造“食品持续缺货 + 价格合理”的机会，同时清空所有设备库存（本地企业与政府）。 */
function foodGapWithoutEquipment(world: WorldState, cityId = 'lanport') {
  const city = cityOf(world, cityId);
  const base = GOODS.find((good) => good.id === 'food')!.basePrice;
  const market = city.market.food;
  market.price = base * 1.4;
  market.lastPriceChangePct = 5;
  market.demand = 2_000_000;
  market.sold = 0;
  market.unmetDemand = 2_000_000;
  market.supply = 500_000;
  for (const kind of KINDS) world.equipmentMarket.initialStock[kind] = 0;
  for (const company of world.companies) {
    for (const kind of KINDS) {
      company.inventory[DEMO_CONFIG.equipment.catalog[kind].goodId] = 0;
    }
  }
  // 设备商品的市场期末库存必须与同城企业库存合计一致（不变量），
  // 这里把设备库存清零后同步清空市场账本。
  for (const entry of world.cities) {
    for (const kind of KINDS) {
      const goodId = DEMO_CONFIG.equipment.catalog[kind].goodId;
      entry.market[goodId].closingStock = 0;
      entry.market[goodId].supply = 0;
    }
  }
  return city;
}

function totalOwnedCash(world: WorldState): number {
  return (
    world.investors.reduce((sum, group) => sum + group.cash, 0) +
    world.companies.reduce((sum, company) => sum + company.cash, 0) +
    world.cities.reduce((sum, city) => sum + city.treasury, 0) +
    world.player.cash
  );
}

/**
 * 只制造“食品持续缺货 + 价格合理”的机会，保留真实设备市场（政府开局库存 + 设备企业库存）。
 * 用于验证“1 台实物出资 + 其余在设备市场真实购买”的混合路径，不重复 foodGapWithoutEquipment 的清库存。
 */
function foodGapKeepingEquipment(world: WorldState, cityId = 'lanport') {
  const city = cityOf(world, cityId);
  const base = GOODS.find((good) => good.id === 'food')!.basePrice;
  const market = city.market.food;
  market.price = base * 1.4;
  market.lastPriceChangePct = 5;
  market.demand = 2_000_000;
  market.sold = 0;
  market.unmetDemand = 2_000_000;
  market.supply = 500_000;
  return city;
}

function foundFoodInKindCompany(world: WorldState, cityId = 'lanport', log: LogEntry[] = []) {
  foodGapWithoutEquipment(world, cityId);
  const result = foundCompany(
    world,
    { cityId, recipeOutput: 'food', log },
    DEMO_CONFIG,
  );
  expect(result.ok, result.error).toBe(true);
  const company = world.companies.find((entry) => entry.id === result.companyId)!;
  return { company, result };
}

describe('v1.4 §4 新企业自带初始设备（模拟范围外实物出资）', () => {
  it('本地与政府设备库存都为 0 时仍能创办：1 台实物设备，不消耗市场库存/账本/财政', () => {
    const world = richWorld();
    const city = cityOf(world, 'lanport');
    foodGapWithoutEquipment(world);
    const log: LogEntry[] = [];
    const stockBefore = { ...world.equipmentMarket.initialStock };
    const treasuryBefore = city.treasury;
    const ledgerBefore = {
      sold: city.market.industryEquipment.sold,
      demand: city.market.industryEquipment.demand,
      supply: city.market.industryEquipment.supply,
    };
    const cashBefore = totalOwnedCash(world);
    const companiesBefore = world.companies.length;

    const result = foundCompany(world, { cityId: city.id, recipeOutput: 'food', log }, DEMO_CONFIG);

    expect(result.ok, result.error).toBe(true);
    const company = world.companies.find((entry) => entry.id === result.companyId)!;
    expect(world.companies).toHaveLength(companiesBefore + 1);
    expect(company.equipment.industry).toBe(1);
    expect(company.equipmentCapacity).toBeGreaterThan(0);
    expect(company.capacity).toBeCloseTo(company.equipmentCapacity, 2);
    expect(company.lastMonth.equipmentPurchased ?? 0).toBe(0);
    expect(company.initialEquipment).toBeDefined();
    expect(company.initialEquipment).toMatchObject({
      kind: 'industry',
      units: 1,
      source: 'founderInKind',
      grantedTick: world.time.tick,
      lockUntilTick: world.time.tick + INITIAL_EQUIPMENT_LOCK_MONTHS,
    });
    expect(company.initialEquipment!.valuation).toBeGreaterThan(0);
    // 实物出资不伪装成游戏内设备生产/库存/销售，也不进政府财政。
    expect(world.equipmentMarket.initialStock).toEqual(stockBefore);
    expect(city.treasury).toBeCloseTo(treasuryBefore, 2);
    expect(city.market.industryEquipment.sold).toBeCloseTo(ledgerBefore.sold, 2);
    expect(city.market.industryEquipment.demand).toBeCloseTo(ledgerBefore.demand, 2);
    expect(city.market.industryEquipment.supply).toBeCloseTo(ledgerBefore.supply, 2);
    // 资金守恒：设备是外部实物，不产生现金流出。
    expect(totalOwnedCash(world)).toBeCloseTo(cashBefore, 2);
    const record = world.lifecycle.foundings.at(-1)!;
    expect(record.initialEquipment).toBeDefined();
    expect(record.note).toContain('实物出资');
    expect(log.some((entry) => entry.message.includes('模拟范围外') && entry.message.includes('实物出资'))).toBe(true);
    expect(checkInvariants(world)).toEqual([]);
  });

  it('实物设备形成真实产能：下一 tick 有产出且产能与设备一致', () => {
    const sim = Simulation.create();
    const world = sim.state;
    for (const group of world.investors) group.cash = 100_000_000;
    for (const city of world.cities) city.treasury = 50_000_000;
    foodGapWithoutEquipment(world);

    const result = foundCompany(world, { cityId: 'lanport', recipeOutput: 'food', log: [] }, DEMO_CONFIG);
    expect(result.ok, result.error).toBe(true);
    const companyId = result.companyId!;

    sim.tick();

    const company = world.companies.find((entry) => entry.id === companyId)!;
    expect(company.capacity).toBeCloseTo(company.equipmentCapacity, 2);
    expect(company.equipment.industry).toBe(1);
    const produced = world.lastTick.productionRecords
      .filter((record) => record.companyId === companyId)
      .reduce((sum, record) => sum + record.qty, 0);
    expect(produced).toBeGreaterThan(0);
    expect(company.lastMonth.wageArrears ?? 0).toBe(0);
  });

  it('资金/劳动力约束仍然生效：没有真实出资人时拒绝并记录 capital 障碍', () => {
    const world = richWorld();
    foodGapWithoutEquipment(world);
    for (const group of world.investors) group.cash = 0;
    for (const company of world.companies) company.cash = 0;
    for (const city of world.cities) city.treasury = 0;
    const companiesBefore = world.companies.length;

    const result = foundCompany(world, { cityId: 'lanport', recipeOutput: 'food', log: [] }, DEMO_CONFIG);

    expect(result.ok).toBe(false);
    expect(world.companies).toHaveLength(companiesBefore);
    const attempt = world.lifecycle.foundingAttempts?.at(-1);
    expect(attempt?.outcome).toBe('rejected');
    expect(attempt?.obstacles.some((obstacle) => obstacle.kind === 'capital' || obstacle.kind === 'workingCapital')).toBe(true);
  });

  it('劳动力不足时拒绝并记录 labor 障碍', () => {
    const world = richWorld();
    const city = cityOf(world, 'lanport');
    foodGapWithoutEquipment(world);
    city.population.laborForce = 1;
    city.population.unemployed = 1;
    city.population.nonLabor = Math.max(0, city.population.total - 1);

    const result = foundCompany(world, { cityId: city.id, recipeOutput: 'food', log: [] }, DEMO_CONFIG);

    expect(result.ok).toBe(false);
    const attempt = world.lifecycle.foundingAttempts?.at(-1);
    expect(attempt?.obstacles.some((obstacle) => obstacle.kind === 'labor')).toBe(true);
  });

  it('锁定期内不得出售；提前清算按实物返还，不进入现金/股东分配/政府库存', () => {
    const world = richWorld();
    const log: LogEntry[] = [];
    const { company } = foundFoodInKindCompany(world, 'lanport', log);
    const stockBefore = { ...world.equipmentMarket.initialStock };
    const cashBefore = company.cash;

    const listed = listUsedEquipment(world, company, 'industry', 1, DEMO_CONFIG, world.time.tick);
    expect(listed.ok).toBe(false);
    expect(listed.error).toContain('锁定期');
    expect(listed.error).toContain('实物出资');

    const liquidated = liquidateCompany(world, company.id, DEMO_CONFIG, '测试：提前退出', log);
    expect(liquidated.ok, liquidated.error).toBe(true);
    const record = world.lifecycle.liquidations.at(-1)!;
    expect(record.initialEquipmentReturned).toEqual({ kind: 'industry', units: 1, valuation: expect.any(Number) });
    // 实物返还：不产生现金、不进股东分配、不增加政府设备库存。
    expect(record.shareholderPayout).toBeLessThanOrEqual(cashBefore + 0.01);
    expect(world.equipmentMarket.initialStock).toEqual(stockBefore);
    expect(world.companies.some((entry) => entry.id === company.id)).toBe(false);
    expect(checkInvariants(world)).toEqual([]);
  });

  it('锁定期满后初始设备转为普通资产，可正常出售', () => {
    const world = richWorld();
    const { company } = foundFoodInKindCompany(world);
    const grant = company.initialEquipment!;
    world.time.tick = grant.lockUntilTick;

    const listed = listUsedEquipment(world, company, 'industry', 1, DEMO_CONFIG, world.time.tick);
    expect(listed.ok, listed.error).toBe(true);
    expect(company.equipment.industry).toBe(0);
    expect(world.equipmentMarket.offers.some((offer) => offer.id === listed.offerId)).toBe(true);
  });

  it('后续扩产仍走真实设备市场：市场库存减少、现金支付、实物出资记录不变', () => {
    const world = richWorld();
    const city = cityOf(world, 'lanport');
    const base = GOODS.find((good) => good.id === 'food')!.basePrice;
    city.market.food.price = base * 1.4;
    city.market.food.demand = 2_000_000;
    city.market.food.unmetDemand = 2_000_000;
    city.market.food.supply = 500_000;
    // 保留真实设备市场库存（政府 + 设备企业），验证扩产走市场而不是实物出资。
    const marketStockBefore = world.equipmentMarket.initialStock.industry;
    const result = foundCompany(world, { cityId: city.id, recipeOutput: 'food', log: [] }, DEMO_CONFIG);
    expect(result.ok, result.error).toBe(true);
    const company = world.companies.find((entry) => entry.id === result.companyId)!;
    const grantBefore = company.initialEquipment;
    const unitsBefore = company.equipment.industry;
    const companyCashBefore = company.cash;
    const log: LogEntry[] = [];

    const expanded = expandCompanyCapacity(world, company, DEMO_CONFIG, log, 1);

    expect(expanded.ok, expanded.error).toBe(true);
    expect(company.equipment.industry).toBe(unitsBefore + 1);
    expect(company.lastMonth.equipmentPurchased ?? 0).toBeGreaterThan(0);
    expect(company.cash).toBeLessThan(companyCashBefore);
    expect(company.initialEquipment).toEqual(grantBefore);
    expect(world.equipmentMarket.initialStock.industry).toBeLessThanOrEqual(marketStockBefore);
  });

  it('玩家经界面发起的创办同样获得实物出资（与 AI 同一路径）', () => {
    const world = richWorld();
    foodGapWithoutEquipment(world);
    // gameStore.foundCompany 只传 cityId/founderType/founderId，不传 capital。
    const result = foundCompany(
      world,
      { cityId: 'lanport', founderType: 'investorGroup' },
      DEMO_CONFIG,
    );
    expect(result.ok, result.error).toBe(true);
    const company = world.companies.find((entry) => entry.id === result.companyId)!;
    expect(company.initialEquipment?.source).toBe('founderInKind');
    expect(company.equipment.industry).toBe(1);
  });

  it('破产清算路径同样返还锁定期实物出资', () => {
    const world = richWorld();
    const log: LogEntry[] = [];
    const { company } = foundFoodInKindCompany(world, 'lanport', log);
    // 构造破产条件：超过新企业宽限期、连续亏损、现金不足月工资、无可用授信。
    company.ai = { ...company.ai, ageMonths: 24, lossMonths: 12 };
    company.cash = 0;
    company.debt = 1_000_000_000;
    const liquidated = checkBankruptcies(world, DEMO_CONFIG, log);
    expect(liquidated).toContain(company.id);
    const record = world.lifecycle.liquidations.at(-1)!;
    expect(record.companyId).toBe(company.id);
    expect(record.initialEquipmentReturned?.units).toBe(1);
    expect(world.companies.some((entry) => entry.id === company.id)).toBe(false);
  });

  it('存档往返保留实物出资字段，旧档缺失字段仍可读取；100/160 上限不受影响', () => {
    const world = richWorld();
    const { company } = foundFoodInKindCompany(world);
    const text = serializeSave(world);
    const parsed = parseSave(text);
    expect(parsed.ok, parsed.error).toBe(true);
    const restored = parsed.world!.companies.find((entry) => entry.id === company.id)!;
    expect(restored.initialEquipment).toEqual(company.initialEquipment);
    const restoredRecord = parsed.world!.lifecycle.foundings.at(-1)!;
    expect(restoredRecord.initialEquipment).toEqual(company.initialEquipment);

    // 旧档（无 initialEquipment 字段）不会被校验拒绝：用旧单体格式夹具，不能从 v10 文本降级。
    const legacy = JSON.parse(serializeLegacySave(world)) as { world: WorldState };
    delete (legacy.world.companies.find((entry) => entry.id === company.id) as { initialEquipment?: unknown }).initialEquipment;
    for (const record of legacy.world.lifecycle.foundings) delete (record as { initialEquipment?: unknown }).initialEquipment;
    const legacyParsed = parseSave(JSON.stringify(legacy));
    expect(legacyParsed.ok, legacyParsed.error).toBe(true);

    // 规则未被改变。
    expect(DEMO_CONFIG.lifecycle.maxCompaniesPerCity).toBe(160);
    expect(DEMO_CONFIG.lifecycle.maxFoundingsPerCityMonth).toBe(100);
  });
});

/**
 * v1.4 §4 审计补缺：现有 10 项已覆盖“授权 + 锁定期内清算返还”的主路径，
 * 这里补合并/资产并入、资产不重复计入、旧档缺字段、锁定设备交易路径与存档幂等。
 */
describe('v1.4 §4 初始设备审计补缺（合并/不重复计入/旧档/交易/幂等）', () => {
  it('资产只记一次：4 台档位 = 1 台实物出资 + 3 台真实市场购买，台数/产能/估值不重复计入', () => {
    const world = richWorld();
    const city = foodGapKeepingEquipment(world);
    const goodId = DEMO_CONFIG.equipment.catalog.industry.goodId;
    const stockBefore = { ...world.equipmentMarket.initialStock };
    const inventoryBefore = world.companies.reduce(
      (sum, entry) => sum + Math.max(0, entry.inventory[goodId] ?? 0),
      0,
    );
    const cashBefore = totalOwnedCash(world);
    const loansBefore = world.banking.loans.reduce((sum, loan) => sum + loan.outstanding, 0);

    const result = foundCompany(world, { cityId: city.id, recipeOutput: 'food', log: [] }, DEMO_CONFIG);
    expect(result.ok, result.error).toBe(true);
    const company = world.companies.find((entry) => entry.id === result.companyId)!;
    const grant = company.initialEquipment!;
    expect(grant.source).toBe('founderInKind');
    expect(grant.units).toBe(1);

    // 市场购买台数 = 政府库存减少 + 设备企业库存减少；与实物出资相加正好等于企业设备台数。
    const boughtFromGovernment = stockBefore.industry - world.equipmentMarket.initialStock.industry;
    const inventoryAfter = world.companies.reduce(
      (sum, entry) => sum + Math.max(0, entry.inventory[goodId] ?? 0),
      0,
    );
    const boughtFromCompanies = inventoryBefore - inventoryAfter;
    const marketUnits = boughtFromGovernment + boughtFromCompanies;
    expect(marketUnits).toBe(3);
    expect(company.equipment.industry).toBe(grant.units + marketUnits);

    // 实物估值只按 1 台记录一次；设备产能只由整数台数推导一次（不含第二份手工加总）。
    const unitPrice = equipmentUnitPrice(world, city.id, 'industry', DEMO_CONFIG);
    expect(grant.valuation).toBeCloseTo(grant.units * unitPrice, 2);
    const derived =
      company.equipment.industry *
      equipmentCapacityPerUnit(DEMO_CONFIG, 'industry', company.recipeOutput) *
      (city.technology.productivityMultiplier || 1);
    expect(company.equipmentCapacity).toBeCloseTo(derived, 2);
    expect(company.capacity).toBeCloseTo(derived, 2);
    expect(company.lastMonth.equipmentPurchased ?? 0).toBeGreaterThan(0);

    // 实物出资不创造现金：本次新增现金全部来自银行贷款。
    const loansAfter = world.banking.loans.reduce((sum, loan) => sum + loan.outstanding, 0);
    expect(totalOwnedCash(world) - cashBefore).toBeCloseTo(loansAfter - loansBefore, 2);
    expect(checkInvariants(world)).toEqual([]);
  });

  it('企业合并/资产并入路径：锁定期满后清算，设备被同城受让企业真实买走且不继承锁定期', () => {
    const world = richWorld();
    const log: LogEntry[] = [];
    const { company } = foundFoodInKindCompany(world, 'lanport', log);
    const grant = company.initialEquipment!;
    world.time.tick = grant.lockUntilTick;
    const unitsBefore = new Map(
      world.companies.map((entry) => [entry.id, entry.equipment.industry] as const),
    );
    const stockBefore = { ...world.equipmentMarket.initialStock };

    const liquidated = liquidateCompany(world, company.id, DEMO_CONFIG, '测试：资产并入另一企业', log);
    expect(liquidated.ok, liquidated.error).toBe(true);
    const record = world.lifecycle.liquidations.at(-1)!;
    // 锁定期已满：不再按实物返还，而是作为普通设备卖给真实买家。
    expect(record.initialEquipmentReturned).toBeUndefined();
    expect(world.companies.some((entry) => entry.id === company.id)).toBe(false);
    // 有真实买家时不得把设备直接堆进政府库存。
    expect(world.equipmentMarket.initialStock).toEqual(stockBefore);
    const buyers = world.companies.filter(
      (entry) => (unitsBefore.get(entry.id) ?? 0) < entry.equipment.industry,
    );
    expect(buyers).toHaveLength(1);
    const buyer = buyers[0]!;
    // 受让企业不继承实物出资锁定期：并入的设备是普通资产，可立即挂牌出售。
    expect(buyer.initialEquipment).toBeUndefined();
    const listed = listUsedEquipment(world, buyer, 'industry', 1, DEMO_CONFIG, world.time.tick);
    expect(listed.ok, listed.error).toBe(true);
    expect(checkInvariants(world)).toEqual([]);
  });

  it('旧档缺 initialEquipment 字段：可读、无锁定期残留，出售/清算不虚报实物返还', () => {
    const world = richWorld();
    const { company } = foundFoodInKindCompany(world);
    // 旧档缺 initialEquipment：构造旧单体格式夹具（v10 文本没有 world）。
    const legacy = JSON.parse(serializeLegacySave(world)) as {
      formatVersion: number;
      world: WorldState;
    };
    delete (
      legacy.world.companies.find((entry) => entry.id === company.id) as {
        initialEquipment?: unknown;
      }
    ).initialEquipment;
    for (const record of legacy.world.lifecycle.foundings) {
      delete (record as { initialEquipment?: unknown }).initialEquipment;
    }
    const parsed = parseSave(JSON.stringify(legacy));
    expect(parsed.ok, parsed.error).toBe(true);
    const restored = parsed.world!.companies.find((entry) => entry.id === company.id)!;
    expect(restored.initialEquipment).toBeUndefined();
    // 缺字段不得凭空产生锁定期：旧档企业设备可以正常出售。
    const listed = listUsedEquipment(
      parsed.world!,
      restored,
      'industry',
      1,
      DEMO_CONFIG,
      parsed.world!.time.tick,
    );
    expect(listed.ok, listed.error).toBe(true);
    expect(restored.equipment.industry).toBe(0);

    // 清算不得虚报 initialEquipmentReturned，且未成交挂单不悬空、设备不丢失。
    const log: LogEntry[] = [];
    const liquidated = liquidateCompany(
      parsed.world!,
      restored.id,
      DEMO_CONFIG,
      '测试：旧档企业清算',
      log,
    );
    expect(liquidated.ok, liquidated.error).toBe(true);
    const record = parsed.world!.lifecycle.liquidations.at(-1)!;
    expect(record.initialEquipmentReturned).toBeUndefined();
    expect(parsed.world!.equipmentMarket.offers).toHaveLength(0);
    expect(checkInvariants(parsed.world!)).toEqual([]);
  });

  it('锁定期内只有超额设备可出售：实物出资那台不可挂单，他人也无法买走锁定期内设备', () => {
    const world = richWorld();
    const log: LogEntry[] = [];
    // 4 台档位：1 台实物出资（锁定）+ 3 台真实市场购买（可出售）。
    foodGapKeepingEquipment(world);
    const founded = foundCompany(world, { cityId: 'lanport', recipeOutput: 'food', log }, DEMO_CONFIG);
    expect(founded.ok, founded.error).toBe(true);
    const company = world.companies.find((entry) => entry.id === founded.companyId)!;
    expect(company.equipment.industry).toBe(4);
    expect(company.initialEquipment?.units).toBe(1);

    // 出售 4 台把锁定期内那台也算进去 → 拒绝；出售 3 台（超额部分）放行。
    const tooMany = listUsedEquipment(world, company, 'industry', 4, DEMO_CONFIG, world.time.tick);
    expect(tooMany.ok).toBe(false);
    expect(tooMany.error).toContain('锁定期');
    const listed = listUsedEquipment(world, company, 'industry', 3, DEMO_CONFIG, world.time.tick);
    expect(listed.ok, listed.error).toBe(true);
    expect(company.equipment.industry).toBe(1);
    // 锁定那台仍留在企业名下，无法再次挂单。
    expect(
      listUsedEquipment(world, company, 'industry', 1, DEMO_CONFIG, world.time.tick).ok,
    ).toBe(false);

    // 挂单可以被其他企业真实买走；受让方买到的是普通设备，不继承锁定期。
    const buyer = world.companies.find(
      (entry) =>
        entry.id !== company.id && entry.cityId === company.cityId && entry.cash > 1_000_000,
    )!;
    const bought = buyUsedEquipment(world, buyer, listed.offerId!, 3, DEMO_CONFIG, world.time.tick);
    expect(bought.ok, bought.error).toBe(true);
    expect(bought.units).toBe(3);
    expect(buyer.initialEquipment).toBeUndefined();
    const buyerListed = listUsedEquipment(world, buyer, 'industry', 1, DEMO_CONFIG, world.time.tick);
    expect(buyerListed.ok, buyerListed.error).toBe(true);
    expect(checkInvariants(world)).toEqual([]);
  });

  it('实物出资锁定期只约束出资类别：企业合法持有的其他类别设备可正常出售', () => {
    const world = richWorld();
    const { company } = foundFoodInKindCompany(world);
    // 通过二手市场真实买入一台农机：食品企业允许持有 farm 设备（买方不按行业过滤挂单）。
    const farmOwner = world.companies.find(
      (entry) => entry.cityId === 'lanport' && entry.equipment.farm > 0,
    )!;
    const listedFarm = listUsedEquipment(world, farmOwner, 'farm', 1, DEMO_CONFIG, world.time.tick);
    expect(listedFarm.ok, listedFarm.error).toBe(true);
    const bought = buyUsedEquipment(world, company, listedFarm.offerId!, 1, DEMO_CONFIG, world.time.tick);
    expect(bought.ok, bought.error).toBe(true);
    expect(company.equipment.farm).toBe(1);

    // industry 是实物出资类别，仍在锁定期内 → 不可出售；farm 不是 → 可出售。
    expect(
      listUsedEquipment(world, company, 'industry', 1, DEMO_CONFIG, world.time.tick).ok,
    ).toBe(false);
    const sellFarm = listUsedEquipment(world, company, 'farm', 1, DEMO_CONFIG, world.time.tick);
    expect(sellFarm.ok, sellFarm.error).toBe(true);
    expect(checkInvariants(world)).toEqual([]);
  });

  it('锁定期满后挂单由其他企业真实购买：所有权/资金/产能转移，实物出资记录不转移', () => {
    const world = richWorld();
    const { company } = foundFoodInKindCompany(world);
    const grant = company.initialEquipment!;
    const buyer = world.companies.find(
      (entry) => entry.id !== company.id && entry.cityId === company.cityId,
    )!;
    world.time.tick = grant.lockUntilTick;
    const sellerUnitsBefore = company.equipment.industry;
    const buyerUnitsBefore = buyer.equipment.industry;
    const sellerCashBefore = company.cash;
    const buyerCashBefore = buyer.cash;

    const listed = listUsedEquipment(world, company, 'industry', 1, DEMO_CONFIG, world.time.tick);
    expect(listed.ok, listed.error).toBe(true);
    const offer = world.equipmentMarket.offers.find((entry) => entry.id === listed.offerId)!;
    const bought = buyUsedEquipment(world, buyer, offer.id, 1, DEMO_CONFIG, world.time.tick);
    expect(bought.ok, bought.error).toBe(true);

    expect(world.equipmentMarket.offers.some((entry) => entry.id === offer.id)).toBe(false);
    expect(company.equipment.industry).toBe(sellerUnitsBefore - 1);
    expect(buyer.equipment.industry).toBe(buyerUnitsBefore + 1);
    expect(company.cash).toBeCloseTo(sellerCashBefore + offer.askPrice, 2);
    expect(buyer.cash).toBeCloseTo(buyerCashBefore - offer.askPrice, 2);
    expect(company.lastMonth.equipmentSold).toBeCloseTo(offer.askPrice, 2);
    expect(buyer.lastMonth.equipmentPurchased).toBeGreaterThanOrEqual(offer.askPrice - 0.01);
    expect(company.capacity).toBeCloseTo(company.equipmentCapacity, 2);
    expect(buyer.capacity).toBeCloseTo(buyer.equipmentCapacity, 2);
    // 实物出资记录属于原企业，不随设备转移；受让企业不会凭空获得锁定期。
    expect(company.initialEquipment).toEqual(grant);
    expect(buyer.initialEquipment).toBeUndefined();
    expect(checkInvariants(world)).toEqual([]);
  });

  it('存档二次往返幂等：初始设备/锁定/产能不漂移，重载后锁定期仍生效', () => {
    const world = richWorld();
    const { company } = foundFoodInKindCompany(world);
    const first = serializeSave(world, 'v14-roundtrip');
    const parsedOnce = parseSave(first);
    expect(parsedOnce.ok, parsedOnce.error).toBe(true);
    expect(checkInvariants(parsedOnce.world!)).toEqual([]);
    const second = serializeSave(parsedOnce.world!, 'v14-roundtrip');
    const parsedTwice = parseSave(second);
    expect(parsedTwice.ok, parsedTwice.error).toBe(true);
    const third = serializeSave(parsedTwice.world!, 'v14-roundtrip');
    // 第二次往返起字节级收敛（首轮可能补齐可选兼容字段），再次读取不再变化。
    expect(third).toBe(second);

    const restored = parsedTwice.world!.companies.find((entry) => entry.id === company.id)!;
    expect(restored.initialEquipment).toEqual(company.initialEquipment);
    expect(restored.equipment.industry).toBe(company.equipment.industry);
    expect(restored.equipmentCapacity).toBeCloseTo(company.equipmentCapacity, 2);
    expect(restored.capacity).toBeCloseTo(restored.equipmentCapacity, 2);
    expect(parsedTwice.world!.lifecycle.foundings.at(-1)!.initialEquipment).toEqual(
      company.initialEquipment,
    );
    // 重载后锁定期仍生效。
    const listed = listUsedEquipment(
      parsedTwice.world!,
      restored,
      'industry',
      1,
      DEMO_CONFIG,
      parsedTwice.world!.time.tick,
    );
    expect(listed.ok).toBe(false);
    expect(listed.error).toContain('锁定期');
    expect(checkInvariants(parsedTwice.world!)).toEqual([]);
  });

  it('实物出资不绕过在营上限 160：达上限城市拒绝创办，不产生实物出资或设备副作用', () => {
    const world = richWorld();
    foodGapWithoutEquipment(world);
    const lanportCount = world.companies.filter((entry) => entry.cityId === 'lanport').length;
    // DemoConfig = typeof DEMO_CONFIG（字面量类型），测试里用显式覆盖值需显式转型
    // （与 tests/founding-cap-v12.test.ts 的 withConfig 同口径）。
    const config = {
      ...DEMO_CONFIG,
      lifecycle: {
        ...DEMO_CONFIG.lifecycle,
        maxCompaniesPerCity: lanportCount,
      },
    } as unknown as DemoConfig;
    const companiesBefore = world.companies.length;
    const grantsBefore = world.companies.filter((entry) => entry.initialEquipment).length;
    const stockBefore = { ...world.equipmentMarket.initialStock };

    const result = foundCompany(world, { cityId: 'lanport', recipeOutput: 'food', log: [] }, config);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('上限');
    expect(world.companies).toHaveLength(companiesBefore);
    expect(world.companies.filter((entry) => entry.initialEquipment)).toHaveLength(grantsBefore);
    expect(world.equipmentMarket.initialStock).toEqual(stockBefore);
    // 100 家/月上限规则本身未被实物出资改写。
    expect(config.lifecycle.maxFoundingsPerCityMonth).toBe(100);
  });

  it('清算时撤销未成交二手委托：冻结设备不丢失、挂单不悬空、资产只处置一次', () => {
    const world = richWorld();
    const log: LogEntry[] = [];
    foodGapKeepingEquipment(world);
    const result = foundCompany(world, { cityId: 'lanport', recipeOutput: 'food', log }, DEMO_CONFIG);
    expect(result.ok, result.error).toBe(true);
    const company = world.companies.find((entry) => entry.id === result.companyId)!;
    const grant = company.initialEquipment!;
    // 锁定期满，允许挂单；4 台设备中挂出 1 台（冻结在委托里）。
    world.time.tick = grant.lockUntilTick;
    const listed = listUsedEquipment(world, company, 'industry', 1, DEMO_CONFIG, world.time.tick);
    expect(listed.ok, listed.error).toBe(true);
    const offerUnits = world.equipmentMarket.offers
      .filter((entry) => entry.companyId === company.id && entry.kind === 'industry')
      .reduce((sum, entry) => sum + entry.units, 0);
    expect(offerUnits).toBe(1);
    const unitsInCompaniesBefore = world.companies.reduce(
      (sum, entry) => sum + entry.equipment.industry,
      0,
    );
    const unitsBefore = unitsInCompaniesBefore + offerUnits;
    const stockBefore = { ...world.equipmentMarket.initialStock };

    const liquidated = liquidateCompany(world, company.id, DEMO_CONFIG, '测试：带挂单清算', log);
    expect(liquidated.ok, liquidated.error).toBe(true);
    const record = world.lifecycle.liquidations.at(-1)!;
    expect(record.initialEquipmentReturned).toBeUndefined();
    expect(log.some((entry) => entry.message.includes('撤销') && entry.message.includes('二手出售委托'))).toBe(true);
    expect(world.equipmentMarket.offers.filter((entry) => entry.companyId === company.id)).toHaveLength(0);
    expect(checkInvariants(world)).toEqual([]);
    // 冻结设备要么卖给真实买家，要么移交政府库存；不得凭空消失或重复计入。
    const unitsInCompaniesAfter = world.companies.reduce(
      (sum, entry) => sum + entry.equipment.industry,
      0,
    );
    const governmentGain =
      world.equipmentMarket.initialStock.industry - stockBefore.industry;
    expect(unitsInCompaniesAfter + governmentGain).toBe(unitsBefore);
  });
});
