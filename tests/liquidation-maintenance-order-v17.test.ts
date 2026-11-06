// v1.7 §二 F2：清算维护费欠款偿付顺序（先处置资产 → 用真实现金偿维护服务商 → 银行债务/股东）。
//
// 用户验收问题：清理前现金 0、旧欠 10,000、当月维护费 3,800；v1.6 在 disposeCompanyEquipment
// 开头先结算，现金 0 → 13,800 直接记坏账；随后设备处置得 180,000，因已无维护费负债，
// 180,000 全给股东。v1.7 要求：
//   1. 先完成设备处置、处置收入进入企业现金；
//   2. 用真实清算资金按债权优先偿付维护服务商（当月费用 + 旧欠）；
//   3. 确实收不到的部分才记模拟范围外服务商坏账；
//   4. 之后剩余现金才偿还银行债务、分配股东；对账不重复、不造钱。
import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation/core/simulation';
import { DEMO_CONFIG } from '../src/data/config';
import type { Company, LogEntry, WorldState } from '../src/simulation/contracts/types';
import { round2 } from '../src/simulation/core/math';
import { checkInvariants } from '../src/simulation/core/invariants';
import { migrateLegacyCompanyDebt } from '../src/simulation/banking/banking';
import { sumCityStock } from '../src/simulation/markets/markets';
import { GOOD_IDS } from '../src/simulation/companies/company';
import { liquidateCompany } from '../src/simulation/companies/lifecycle/lifecycle';
import { recomputeCompanyCapacity } from '../src/simulation/equipment/equipment';
import {
  beginEquipmentMaintenanceMonth,
  equipmentMaintenanceMonthFlow,
  settleCompanyMaintenanceForCompany,
} from '../src/simulation/equipment/maintenance';

const INDUSTRY_PRICE = 190_000;
/** 2 台工业设备 × 190,000 × 1% = 3,800（用户验收复现数字）。 */
const TWO_INDUSTRY_FEE = 3_800;
/** 清算折价：200,000 目录价 × 45% = 90,000/台。 */
const LIQUIDATION_UNIT_PRICE = round2(
  DEMO_CONFIG.equipment.catalog.industry.price * DEMO_CONFIG.equipment.liquidationPriceFactor,
);

function newWorld(): WorldState {
  return Simulation.create().state;
}

function companyOf(world: WorldState, id: string): Company {
  const found = world.companies.find((entry) => entry.id === id);
  if (!found) throw new Error(`测试世界没有企业 ${id}`);
  return found;
}

function setEquipmentPrices(world: WorldState): void {
  const ids = {
    farm: DEMO_CONFIG.equipment.catalog.farm.goodId,
    industry: DEMO_CONFIG.equipment.catalog.industry.goodId,
    energy: DEMO_CONFIG.equipment.catalog.energy.goodId,
  } as const;
  for (const city of world.cities) {
    city.market[ids.farm]!.price = 120_000;
    city.market[ids.industry]!.price = INDUSTRY_PRICE;
    city.market[ids.energy]!.price = 160_000;
  }
}

function setEquipment(world: WorldState, company: Company, equipment: Partial<Company['equipment']>): void {
  company.equipment = { ...company.equipment, ...equipment };
  recomputeCompanyCapacity(world, company, DEMO_CONFIG);
}

/** 清空其他企业现金：制造“设备无真实买家、移交政府库存”场景（不产生现金）。 */
function makeNoEquipmentBuyers(world: WorldState, companyId: string): void {
  for (const other of world.companies) {
    if (other.id !== companyId) other.cash = 0;
  }
}

/** 让目标城市场期末库存与真实库存一致，便于收尾跑不变量。 */
function syncMarketStock(world: WorldState, cityId: string): void {
  const city = world.cities.find((entry) => entry.id === cityId)!;
  for (const goodId of GOOD_IDS) {
    city.market[goodId].closingStock = sumCityStock(world, cityId, goodId);
  }
}

/** 对账：清算前现金 + 设备处置收入 = 维护费实付 + 银行债务偿还 + 股东分配（+ 取整余额）。 */
function expectLiquidationReconciled(rec: WorldState['lifecycle']['liquidations'][number], cashBefore: number): void {
  const inflow = round2(cashBefore + (rec.equipmentProceeds ?? 0));
  const outflow = round2(
    (rec.equipmentMaintenancePaid ?? 0) + rec.debtRepaid + rec.shareholderPayout,
  );
  expect(outflow).toBeLessThanOrEqual(inflow + 0.01);
  expect(round2(inflow - outflow)).toBeLessThan(0.02);
}

/**
 * 构造“设备处置能卖出 2 台工业设备（180,000）”的世界：
 * 目标企业 equipment=2；同城真实买家（其它企业）保留默认现金。
 */
function setupSellableEquipment(world: WorldState): Company {
  const company = companyOf(world, 'lp-garment');
  setEquipment(world, company, { farm: 0, industry: 2, energy: 0 });
  company.cash = 0;
  company.debt = 0;
  company.maintenanceArrears = 0;
  return company;
}

describe('v1.7 §二 F2 清算维护费偿付顺序', () => {
  it('用户复现：现金 0 + 旧欠 10,000 + 当月 3,800，设备处置 180,000 后先偿服务商，剩余才给股东', () => {
    const world = newWorld();
    setEquipmentPrices(world);
    world.time.tick = 1;
    const company = setupSellableEquipment(world);
    company.maintenanceArrears = 10_000; // 月初存量欠费（begin 会把它计入月末欠付存量）
    beginEquipmentMaintenanceMonth(world, DEMO_CONFIG);
    const month = equipmentMaintenanceMonthFlow(world)!;
    const dueBefore = month.totalDue;
    const paidBefore = month.totalPaid;
    const writtenOffBefore = month.totalWrittenOff;
    const treasuryBefore = world.cities.map((city) => city.treasury);
    const logs: LogEntry[] = [];

    const result = liquidateCompany(world, company.id, DEMO_CONFIG, '测试：偿付顺序', logs);
    expect(result.ok, result.error).toBe(true);
    const record = world.lifecycle.liquidations.at(-1)!;

    // 设备处置收入真实入账：2 台 × 90,000 = 180,000。
    expect(record.equipmentProceeds).toBe(2 * LIQUIDATION_UNIT_PRICE);
    expect(record.equipmentProceeds).toBe(180_000);
    // 当月维护费 = 3,800，旧欠 10,000：先用处置收入全额偿付 13,800，不记坏账。
    expect(record.equipmentMaintenanceDue).toBe(TWO_INDUSTRY_FEE);
    expect(record.equipmentMaintenanceArrearsRepaid).toBe(10_000);
    expect(record.equipmentMaintenancePaid).toBe(13_800);
    expect(record.equipmentMaintenanceWrittenOff).toBe(0);
    // 剩余 166,200 才给股东（无银行债务）。
    expect(record.shareholderPayout).toBe(166_200);
    expect(record.cash).toBe(166_200);
    expectLiquidationReconciled(record, 0);

    // 月度维护费流水：应计/实付/欠付对账，不重复、不造钱、欠付不出现负数。
    expect(month.totalDue).toBeCloseTo(dueBefore + TWO_INDUSTRY_FEE, 2);
    expect(month.totalPaid).toBeCloseTo(paidBefore + 13_800, 2);
    expect(month.totalWrittenOff).toBeCloseTo(writtenOffBefore, 2);
    expect(month.totalArrearsOutstanding).toBe(0);
    expect(month.totalArrearsOutstanding).toBeGreaterThanOrEqual(0);
    // 维护费流向模拟范围外服务商，不进任何政府财政。
    expect(world.cities.map((city) => city.treasury)).toEqual(treasuryBefore);
    expect(world.companies.some((entry) => entry.id === company.id)).toBe(false);
    syncMarketStock(world, company.cityId);
    expect(checkInvariants(world)).toEqual([]);
  });

  it('现金不足且设备无买家：处置不产生现金 → 当月+旧欠确实收不到才记坏账，股东分 0', () => {
    const world = newWorld();
    setEquipmentPrices(world);
    world.time.tick = 1;
    const company = setupSellableEquipment(world);
    company.maintenanceArrears = 10_000;
    makeNoEquipmentBuyers(world, company.id);
    beginEquipmentMaintenanceMonth(world, DEMO_CONFIG);
    const month = equipmentMaintenanceMonthFlow(world)!;
    const writtenOffBefore = month.totalWrittenOff;
    const paidBefore = month.totalPaid;
    const stockBefore = world.equipmentMarket.initialStock.industry;

    const result = liquidateCompany(world, company.id, DEMO_CONFIG, '测试：无买家', []);
    expect(result.ok, result.error).toBe(true);
    const record = world.lifecycle.liquidations.at(-1)!;
    // 无人购买：设备移交政府库存，不产生现金。
    expect(record.equipmentProceeds).toBe(0);
    expect(world.equipmentMarket.initialStock.industry).toBe(stockBefore + 2);
    // 无现金可付：当月 3,800 + 旧欠 10,000 全部成为服务商坏账，股东分 0。
    expect(record.equipmentMaintenanceDue).toBe(TWO_INDUSTRY_FEE);
    expect(record.equipmentMaintenancePaid).toBe(0);
    expect(record.equipmentMaintenanceWrittenOff).toBe(13_800);
    expect(record.shareholderPayout).toBe(0);
    expect(record.debtRepaid).toBe(0);
    expectLiquidationReconciled(record, 0);
    expect(month.totalWrittenOff).toBeCloseTo(writtenOffBefore + 13_800, 2);
    expect(month.totalPaid).toBeCloseTo(paidBefore, 2);
    expect(month.totalArrearsOutstanding).toBe(0);
    expect(month.totalArrearsOutstanding).toBeGreaterThanOrEqual(0);
  });

  it('部分偿还：清算资金 5,000，先付当月 3,800、再还旧欠 1,200，剩余 8,800 记坏账', () => {
    const world = newWorld();
    setEquipmentPrices(world);
    world.time.tick = 1;
    const company = setupSellableEquipment(world);
    company.cash = 5_000; // 清算前现金（不是处置收入）
    company.maintenanceArrears = 10_000;
    makeNoEquipmentBuyers(world, company.id);
    beginEquipmentMaintenanceMonth(world, DEMO_CONFIG);
    const month = equipmentMaintenanceMonthFlow(world)!;

    liquidateCompany(world, company.id, DEMO_CONFIG, '测试：部分偿还', []);
    const record = world.lifecycle.liquidations.at(-1)!;
    expect(record.equipmentMaintenanceDue).toBe(TWO_INDUSTRY_FEE);
    // 实付 5,000 = 当月 3,800 + 旧欠 1,200（先当月后旧欠）。
    expect(record.equipmentMaintenancePaid).toBe(5_000);
    expect(record.equipmentMaintenanceArrearsRepaid).toBe(1_200);
    expect(record.equipmentMaintenanceWrittenOff).toBe(8_800);
    expect(record.shareholderPayout).toBe(0);
    // 对账：应计 + 旧欠 = 实付 + 坏账。
    expect(
      round2((record.equipmentMaintenanceDue ?? 0) + 10_000),
    ).toBe(round2((record.equipmentMaintenancePaid ?? 0) + (record.equipmentMaintenanceWrittenOff ?? 0)));
    expectLiquidationReconciled(record, 5_000);
    expect(month.totalArrearsOutstanding).toBe(0);
    expect(month.totalArrearsOutstanding).toBeGreaterThanOrEqual(0);
  });

  it('维护费已在本月财务结算后再清算：不重复计当月费用，只用清算资金偿还旧欠', () => {
    const world = newWorld();
    setEquipmentPrices(world);
    world.time.tick = 1;
    const company = setupSellableEquipment(world);
    beginEquipmentMaintenanceMonth(world, DEMO_CONFIG);
    // 模拟本月财务结算：现金 0 且不能融资 → 当月 3,800 全部成为欠付。
    const settled = settleCompanyMaintenanceForCompany(
      world,
      DEMO_CONFIG,
      company,
      [],
      world.time.tick,
      { skipFinancing: true },
    );
    expect(settled.due).toBe(TWO_INDUSTRY_FEE);
    expect(settled.arrearsAdded).toBe(TWO_INDUSTRY_FEE);
    expect(company.maintenanceArrears).toBe(TWO_INDUSTRY_FEE);
    expect(company.lastMonth.maintenanceDue).toBe(TWO_INDUSTRY_FEE);
    const month = equipmentMaintenanceMonthFlow(world)!;
    const dueBefore = month.totalDue;

    liquidateCompany(world, company.id, DEMO_CONFIG, '测试：本月已结算后清算', []);
    const record = world.lifecycle.liquidations.at(-1)!;
    // 不重复计当月：清算路径不新增应计，只从处置收入中偿付旧欠。
    expect(month.totalDue).toBeCloseTo(dueBefore, 2);
    expect(record.equipmentMaintenanceDue).toBe(0);
    expect(record.equipmentMaintenancePaid).toBe(TWO_INDUSTRY_FEE);
    expect(record.equipmentMaintenanceArrearsRepaid).toBe(TWO_INDUSTRY_FEE);
    expect(record.equipmentMaintenanceWrittenOff).toBe(0);
    // 180,000 − 3,800 旧欠 = 176,200 给股东。
    expect(record.equipmentProceeds).toBe(180_000);
    expect(record.shareholderPayout).toBe(176_200);
    expect(company.lastMonth.maintenanceDue).toBe(TWO_INDUSTRY_FEE); // 不是 7,600
    expect(company.lastMonth.maintenanceArrearsRepaid).toBe(TWO_INDUSTRY_FEE);
    expectLiquidationReconciled(record, 0);
  });

  it('初始设备锁定返还：锁定台数不卖现金但仍计当月维护费，按真实现金/坏账收尾', () => {
    const world = newWorld();
    setEquipmentPrices(world);
    world.time.tick = 1;
    const company = setupSellableEquipment(world);
    // 4 台工业设备，其中 2 台是锁定期内初始实物出资（按实物返还、不进入清算现金）。
    setEquipment(world, company, { farm: 0, industry: 4, energy: 0 });
    company.initialEquipment = {
      kind: 'industry',
      units: 2,
      valuation: 2 * INDUSTRY_PRICE,
      source: 'founderInKind',
      grantedTick: 0,
      lockUntilTick: 100,
    };
    beginEquipmentMaintenanceMonth(world, DEMO_CONFIG);

    liquidateCompany(world, company.id, DEMO_CONFIG, '测试：锁定初始设备', []);
    const record = world.lifecycle.liquidations.at(-1)!;
    // 锁定的 2 台按实物返还（无现金），只剩 2 台可按 90,000 卖出。
    expect(record.initialEquipmentReturned).toEqual({ kind: 'industry', units: 2, valuation: 380_000 });
    expect(record.equipmentProceeds).toBe(180_000);
    // 维护费按月初持有 4 台计（锁定设备也计费）＝ 7,600，从处置收入中真实支付。
    expect(record.equipmentMaintenanceDue).toBe(4 * INDUSTRY_PRICE * 0.01);
    expect(record.equipmentMaintenancePaid).toBe(7_600);
    expect(record.equipmentMaintenanceWrittenOff).toBe(0);
    expect(record.shareholderPayout).toBe(180_000 - 7_600);
    expectLiquidationReconciled(record, 0);
  });

  it('偿付顺序：维护服务商优先于银行债务，银行只拿剩余、最后才轮到股东', () => {
    const world = newWorld();
    setEquipmentPrices(world);
    world.time.tick = 1;
    const company = setupSellableEquipment(world);
    company.maintenanceArrears = 10_000;
    company.debt = 300_000;
    migrateLegacyCompanyDebt(world, DEMO_CONFIG, world.time.tick);
    beginEquipmentMaintenanceMonth(world, DEMO_CONFIG);

    const result = liquidateCompany(world, company.id, DEMO_CONFIG, '测试：银行债权顺序', []);
    expect(result.ok, result.error).toBe(true);
    const record = world.lifecycle.liquidations.at(-1)!;
    // 180,000 → 维护费 13,800 → 银行 166,200（不足部分减免 133,800）→ 股东 0。
    expect(record.equipmentMaintenancePaid).toBe(13_800);
    expect(record.debtRepaid).toBe(166_200);
    expect(record.debtForgiven).toBe(133_800);
    expect(record.shareholderPayout).toBe(0);
    expectLiquidationReconciled(record, 0);
    expect((record.equipmentMaintenancePaid ?? 0) + record.debtRepaid).toBeLessThanOrEqual(
      (record.equipmentProceeds ?? 0) + 0.01,
    );
  });
});
