// v1.6 §四：设备月度维护费（PLAN.md S2 / task-1 验收测试）。
//
// 口径（D1/D2）：
// - 每类设备月维护费 = 月初持有台数 × 所在城市该类“新设备”当月市场参考单价 × 1%，逐类求和；
// - 所有设备（工作/闲置/停产/二手/初始实物出资）都计费；当月买入下月起计费，
//   当月卖出/挂单/返还/破产仍按月初台数计当月；
// - 独立期间费用：全额（已付+欠付）进税前利润，现金支付进经营现金流，不资本化、不重复扣款；
// - 收款方 = 模拟范围外“城市外部设备维护服务商”：独立流水，不进设备厂收入、不记政府税收；
// - 现金不足先按既有规则合法融资，仍不足记欠付（影响分红/融资/清算），不得制造免费资金。
import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation/core/simulation';
import { DEMO_CONFIG } from '../src/data/config';
import type {
  Company,
  CompanyMonthlyStats,
  LogEntry,
  PlayerOperationMode,
  WorldState,
} from '../src/simulation/contracts/types';
import { round2 } from '../src/simulation/core/math';
import { setCompanyEmployees } from '../src/simulation/companies/company';
import { checkInvariants } from '../src/simulation/core/invariants';
import { parseSave, serializeSave } from '../src/simulation/core/save';
import { bankLoansOf } from '../src/simulation/banking/credit';
import { setOperationMode } from '../src/simulation/management/operations';
import {
  buyUsedEquipment,
  equipmentUnitPrice,
  listUsedEquipment,
  recomputeCompanyCapacity,
  returnLockedInitialEquipment,
} from '../src/simulation/equipment/equipment';
import {
  beginEquipmentMaintenanceMonth,
  currentMonthMaintenance,
  companyHasMaintenanceArrears,
  equipmentMaintenanceMonthFlow,
  equipmentMaintenanceRate,
  estimatedMonthlyMaintenance,
  maintenanceArrearsOf,
  maintenanceBreakdown,
  monthlyMaintenanceDue,
  settleCompanyMaintenance,
  settleCompanyMaintenanceForCompany,
} from '../src/simulation/equipment/maintenance';
import { settleCompanyFinance } from '../src/simulation/finance/finance';
import { liquidateCompany } from '../src/simulation/companies/lifecycle/lifecycle';
import { GameStore } from '../src/app/gameStore';
import { renderCompanyDetail } from '../src/ui/panels';
import type { SaveBridge } from '../src/platform/saveBridge';

type Equipment = Company['equipment'];

function newWorld(): WorldState {
  return Simulation.create().state;
}

function companyOf(world: WorldState, id: string): Company {
  const found = world.companies.find((entry) => entry.id === id);
  if (!found) throw new Error(`测试世界没有企业 ${id}`);
  return found;
}

/** 固定三城设备市场价，保证“1% 计价”断言可复现（快照取这里的价格）。 */
function setEquipmentPrices(world: WorldState, prices: { farm: number; industry: number; energy: number }): void {
  const goodIds = {
    farm: DEMO_CONFIG.equipment.catalog.farm.goodId,
    industry: DEMO_CONFIG.equipment.catalog.industry.goodId,
    energy: DEMO_CONFIG.equipment.catalog.energy.goodId,
  } as const;
  for (const city of world.cities) {
    city.market[goodIds.farm]!.price = prices.farm;
    city.market[goodIds.industry]!.price = prices.industry;
    city.market[goodIds.energy]!.price = prices.energy;
  }
}

function blankStats(): CompanyMonthlyStats {
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
  };
}

/** 把玩家设为经营者并切到指定模式（用于验证“手动模式不得暗中举债”）。 */
function operate(world: WorldState, companyId: string, mode: PlayerOperationMode): void {
  const control = world.governance.controls.find((entry) => entry.companyId === companyId);
  if (!control) throw new Error('企业缺少治理控制记录');
  control.operator = { type: 'player', id: 'player' };
  control.basis = 'election';
  control.operatorId = null;
  control.termEndTick = null;
  const result = setOperationMode(world, companyId, mode, DEMO_CONFIG, 0);
  if (!result.ok) throw new Error(result.error);
}

/** 只读地改变企业设备台数并同步产能缓存（避免触发设备/产能一致性不变量）。 */
function setEquipment(world: WorldState, company: Company, equipment: Partial<Equipment>): void {
  company.equipment = { ...company.equipment, ...equipment };
  recomputeCompanyCapacity(world, company, DEMO_CONFIG);
}

/** 现金支付设备维护费的现金流（本月费用已付 + 偿还旧欠）。 */
function maintenanceCashOut(company: Company): number {
  return round2((company.lastMonth.maintenancePaid ?? 0) + (company.lastMonth.maintenanceArrearsRepaid ?? 0));
}

describe('v1.6 §四 设备维护费：计费口径（D1）', () => {
  it('工作设备与完全闲置/停产设备都按 1% 计费，多类型分别计价后汇总', () => {
    const world = newWorld();
    setEquipmentPrices(world, { farm: 120_000, industry: 200_000, energy: 160_000 });
    world.time.tick = 1;
    const working = companyOf(world, 'lp-food');
    const idle = companyOf(world, 'iv-food');
    setEquipment(world, working, { farm: 2, industry: 3, energy: 1 });
    working.utilization = 1;
    setEquipment(world, idle, { farm: 0, industry: 4, energy: 0 });
    idle.utilization = 0; // 完全闲置/停产
    beginEquipmentMaintenanceMonth(world, DEMO_CONFIG);

    // 2×120,000×1% + 3×200,000×1% + 1×160,000×1% = 2,400 + 6,000 + 1,600。
    const workingDue = monthlyMaintenanceDue(world, working, DEMO_CONFIG);
    expect(workingDue.basis).toBe('monthStartSnapshot');
    expect(workingDue.due).toBe(10_000);
    const idleDue = monthlyMaintenanceDue(world, idle, DEMO_CONFIG);
    expect(idleDue.due).toBe(8_000);
    expect(estimatedMonthlyMaintenance(world, working, DEMO_CONFIG)).toBe(10_000);
    // 闲置设备与利用率无关：停产也必须付维护费。
    expect(estimatedMonthlyMaintenance(world, idle, DEMO_CONFIG)).toBe(8_000);

    const workingCash = working.cash;
    const idleCash = idle.cash;
    const month = settleCompanyMaintenance(world, DEMO_CONFIG, []);
    expect(working.cash).toBeCloseTo(workingCash - 10_000, 2);
    expect(idle.cash).toBeCloseTo(idleCash - 8_000, 2);
    expect(working.lastMonth.maintenanceDue).toBe(10_000);
    expect(working.lastMonth.maintenancePaid).toBe(10_000);
    expect(maintenanceArrearsOf(working)).toBe(0);
    // 月度独立流水：台数/费用按类别，合计 = 全企业收缴。
    expect(month.unitsByKind.industry).toBeGreaterThanOrEqual(7);
    expect(month.totalPaid).toBeGreaterThanOrEqual(10_000 + 8_000);
    expect(month.totalDue).toBe(month.totalPaid);
    expect(month.totalArrearsOutstanding).toBe(0);
    expect(month.byCity[working.cityId]!.paid).toBeGreaterThanOrEqual(10_000);
  });

  it('当月买入（含二手成交）下月起计费；月初快照不随卖出/挂单改变', () => {
    const world = newWorld();
    setEquipmentPrices(world, { farm: 120_000, industry: 200_000, energy: 160_000 });
    world.time.tick = 1;
    const seller = companyOf(world, 'lp-food');
    const buyer = companyOf(world, 'lp-garment');
    setEquipment(world, seller, { farm: 0, industry: 6, energy: 0 });
    setEquipment(world, buyer, { farm: 0, industry: 0, energy: 0 });
    beginEquipmentMaintenanceMonth(world, DEMO_CONFIG);

    // 月中：挂单 → 二手成交（买方设备 0 → 2），卖方 6 → 4。
    const listed = listUsedEquipment(world, seller, 'industry', 2, DEMO_CONFIG, world.time.tick, 150_000);
    expect(listed.ok, listed.error).toBe(true);
    const offer = world.equipmentMarket.offers.find((entry) => entry.companyId === seller.id)!;
    const bought = buyUsedEquipment(world, buyer, offer.id, 2, DEMO_CONFIG, world.time.tick);
    expect(bought.ok, bought.error).toBe(true);
    expect(buyer.equipment.industry).toBe(2);
    expect(seller.equipment.industry).toBe(4);

    // 本月仍按月初快照：卖方 6 台、买方 0 台（当月买入下月起计费）。
    expect(monthlyMaintenanceDue(world, seller, DEMO_CONFIG).unitsByKind.industry).toBe(6);
    expect(monthlyMaintenanceDue(world, buyer, DEMO_CONFIG).due).toBe(0);

    settleCompanyMaintenance(world, DEMO_CONFIG, []);
    expect(seller.lastMonth.maintenanceDue).toBe(6 * 200_000 * 0.01);
    expect(buyer.lastMonth.maintenanceDue).toBe(0);

    // 次月快照更新：卖方 4 台、买方 2 台。
    world.time.tick = 2;
    beginEquipmentMaintenanceMonth(world, DEMO_CONFIG);
    expect(monthlyMaintenanceDue(world, seller, DEMO_CONFIG).unitsByKind.industry).toBe(4);
    expect(monthlyMaintenanceDue(world, buyer, DEMO_CONFIG).unitsByKind.industry).toBe(2);
    expect(monthlyMaintenanceDue(world, buyer, DEMO_CONFIG).due).toBe(2 * 200_000 * 0.01);
  });

  it('当月卖出/挂单与初始实物出资返还仍按月初台数计当月', () => {
    const world = newWorld();
    setEquipmentPrices(world, { farm: 120_000, industry: 200_000, energy: 160_000 });
    world.time.tick = 1;
    const seller = companyOf(world, 'lp-food');
    setEquipment(world, seller, { farm: 0, industry: 6, energy: 0 });
    const founder = companyOf(world, 'lp-garment');
    setEquipment(world, founder, { farm: 0, industry: 3, energy: 0 });
    founder.initialEquipment = {
      kind: 'industry',
      units: 2,
      valuation: 2 * 200_000,
      source: 'founderInKind',
      grantedTick: 0,
      lockUntilTick: 100,
    };
    beginEquipmentMaintenanceMonth(world, DEMO_CONFIG);

    // 月中挂单卖出 2 台、返还锁定实物出资 2 台：设备台数立刻减少，但本月仍按月初台数计费。
    expect(listUsedEquipment(world, seller, 'industry', 2, DEMO_CONFIG, 1).ok).toBe(true);
    expect(seller.equipment.industry).toBe(4);
    const returned = returnLockedInitialEquipment(founder, 1);
    expect(returned?.units).toBe(2);
    expect(founder.equipment.industry).toBe(1);

    expect(monthlyMaintenanceDue(world, seller, DEMO_CONFIG).unitsByKind.industry).toBe(6);
    expect(monthlyMaintenanceDue(world, founder, DEMO_CONFIG).unitsByKind.industry).toBe(3);
    settleCompanyMaintenance(world, DEMO_CONFIG, []);
    expect(seller.lastMonth.maintenanceDue).toBe(6 * 200_000 * 0.01);
    expect(founder.lastMonth.maintenanceDue).toBe(3 * 200_000 * 0.01);
  });

  it('当月破产清算仍计当月：清算现金先扣维护费，再偿债/分配', () => {
    const world = newWorld();
    setEquipmentPrices(world, { farm: 120_000, industry: 200_000, energy: 160_000 });
    world.time.tick = 3;
    const victim = companyOf(world, 'lp-garment');
    setEquipment(world, victim, { farm: 0, industry: 5, energy: 0 });
    beginEquipmentMaintenanceMonth(world, DEMO_CONFIG);
    const month = equipmentMaintenanceMonthFlow(world)!;
    const dueBefore = month.totalDue;
    const paidBefore = month.totalPaid;
    const logs: LogEntry[] = [];

    const result = liquidateCompany(world, victim.id, DEMO_CONFIG, '测试：破产退出', logs);
    expect(result.ok, result.error).toBe(true);
    expect(world.companies.some((entry) => entry.id === victim.id)).toBe(false);
    // 清算路径在设备处置前真实扣款：当月维护费 5×200,000×1% = 10,000。
    expect(victim.lastMonth.maintenanceDue).toBe(10_000);
    expect(victim.lastMonth.maintenancePaid).toBe(10_000);
    expect(month.totalDue).toBeCloseTo(dueBefore + 10_000, 2);
    expect(month.totalPaid).toBeCloseTo(paidBefore + 10_000, 2);
    expect(month.settledCompanyIds).toContain(victim.id);
    expect(month.totalWrittenOff).toBe(0); // 现金足够，无需坏账
  });
});

describe('v1.6 §四 设备维护费：融资与欠付规则', () => {
  it('现金充足：直接支付、不举债，服务流水 paid=due', () => {
    const world = newWorld();
    setEquipmentPrices(world, { farm: 120_000, industry: 200_000, energy: 160_000 });
    world.time.tick = 1;
    const company = companyOf(world, 'lp-food');
    setEquipment(world, company, { farm: 0, industry: 10, energy: 0 });
    beginEquipmentMaintenanceMonth(world, DEMO_CONFIG);
    const debtBefore = company.debt;
    const loansBefore = bankLoansOf(world).length;
    const result = settleCompanyMaintenanceForCompany(world, DEMO_CONFIG, company, []);
    expect(result.borrowed).toBe(0);
    expect(result.paidToCurrent).toBe(20_000);
    expect(result.arrearsAdded).toBe(0);
    expect(result.arrearsOutstanding).toBe(0);
    expect(company.debt).toBe(debtBefore);
    expect(bankLoansOf(world)).toHaveLength(loansBefore);
    expect(company.lastMonth.maintenancePaid).toBe(20_000);
  });

  it('现金不足：先按既有借款规则真实融资（放款进债务、无免费资金）', () => {
    const world = newWorld();
    setEquipmentPrices(world, { farm: 120_000, industry: 200_000, energy: 160_000 });
    world.time.tick = 4;
    const company = companyOf(world, 'lp-food');
    setEquipment(world, company, { farm: 0, industry: 12, energy: 0 });
    beginEquipmentMaintenanceMonth(world, DEMO_CONFIG);
    company.cash = 0;
    company.debt = 0;
    const loansBefore = bankLoansOf(world).length;
    const result = settleCompanyMaintenanceForCompany(world, DEMO_CONFIG, company, []);
    expect(result.due).toBe(24_000);
    expect(result.borrowed).toBeGreaterThan(0);
    expect(result.arrearsAdded).toBe(0);
    // 货币守恒：期初现金 + 真实借款 − 维护费现金支付 = 期末现金。
    expect(company.cash).toBeCloseTo(0 + result.borrowed - result.paidToCurrent - result.arrearsRepaid, 2);
    expect(company.cash).toBe(0);
    expect(company.debt).toBeCloseTo(result.borrowed, 2);
    expect(bankLoansOf(world).length).toBe(loansBefore + 1);
    const loan = bankLoansOf(world)[bankLoansOf(world).length - 1]!;
    expect(loan.borrower).toEqual({ kind: 'company', id: company.id });
    expect(loan.principal).toBeCloseTo(result.borrowed, 2);
  });

  it('融资被拒（玩家手动经营）：记欠付、不重复扣款；补付只冲负债不重复计费用', () => {
    const world = newWorld();
    setEquipmentPrices(world, { farm: 120_000, industry: 200_000, energy: 160_000 });
    world.time.tick = 1;
    const company = companyOf(world, 'lp-garment');
    operate(world, company.id, 'manual');
    setEquipment(world, company, { farm: 0, industry: 4, energy: 0 });
    beginEquipmentMaintenanceMonth(world, DEMO_CONFIG);
    company.cash = 0;
    company.debt = 0;
    const loansBefore = bankLoansOf(world).length;
    const logs: LogEntry[] = [];
    const first = settleCompanyMaintenanceForCompany(world, DEMO_CONFIG, company, logs);
    expect(first.borrowed).toBe(0);
    expect(company.debt).toBe(0);
    expect(bankLoansOf(world)).toHaveLength(loansBefore);
    expect(first.arrearsAdded).toBe(8_000);
    expect(first.arrearsOutstanding).toBe(8_000);
    expect(company.lastMonth.maintenanceDue).toBe(8_000);
    expect(company.maintenanceArrears).toBe(8_000);
    expect(companyHasMaintenanceArrears(company)).toBe(true);
    expect(logs.some((entry) => entry.message.includes('欠付'))).toBe(true);

    // 同一 tick 重复调用：幂等，不重复扣款。
    const again = settleCompanyMaintenanceForCompany(world, DEMO_CONFIG, company, []);
    expect(again.settled).toBe(false);
    expect(company.maintenanceArrears).toBe(8_000);
    expect(company.lastMonth.maintenanceDue).toBe(8_000);
    expect(company.cash).toBe(0);

    // 次月：现金恰好覆盖本月费用 + 旧欠款 → 旧欠只冲负债（不计入当月费用）。
    world.time.tick = 2;
    beginEquipmentMaintenanceMonth(world, DEMO_CONFIG);
    company.cash = 8_000 + 8_000;
    const second = settleCompanyMaintenanceForCompany(world, DEMO_CONFIG, company, []);
    expect(second.due).toBe(8_000);
    expect(second.paidToCurrent).toBe(8_000);
    expect(second.arrearsRepaid).toBe(8_000);
    expect(second.arrearsOutstanding).toBe(0);
    expect(company.maintenanceArrears).toBe(0);
    expect(company.lastMonth.maintenanceDue).toBe(8_000); // 只有当月费用，旧欠不重复计
    expect(company.lastMonth.maintenanceArrearsRepaid).toBe(8_000);
    expect(company.cash).toBe(0);
  });

  it('已有欠付时不再为维护费新增借款（欠费即信用风险）', () => {
    const world = newWorld();
    setEquipmentPrices(world, { farm: 120_000, industry: 200_000, energy: 160_000 });
    world.time.tick = 2;
    const company = companyOf(world, 'lp-food');
    setEquipment(world, company, { farm: 0, industry: 5, energy: 0 });
    beginEquipmentMaintenanceMonth(world, DEMO_CONFIG);
    company.cash = 0;
    company.debt = 0;
    company.maintenanceArrears = 3_000; // 上期遗留欠费
    const logs: LogEntry[] = [];
    const result = settleCompanyMaintenanceForCompany(world, DEMO_CONFIG, company, logs);
    expect(result.borrowed).toBe(0);
    expect(company.debt).toBe(0);
    expect(result.arrearsAdded).toBe(10_000);
    expect(result.arrearsOutstanding).toBe(13_000);
    expect(logs.some((entry) => entry.message.includes('不再为维护费新增借款'))).toBe(true);
  });

  it('欠付未清不得分红（服务商债权优先于股东）', () => {
    const world = newWorld();
    world.time.tick = 1;
    const company = companyOf(world, 'lp-food');
    setCompanyEmployees(company, 0);
    company.dividendPayoutRatio = 1;
    company.maintenanceArrears = 5_000;
    company.lastMonth = blankStats();
    company.lastMonth.revenue = 10_000_000;
    setEquipment(world, company, { farm: 0, industry: 1, energy: 0 });
    company.cash = 5_000_000;
    beginEquipmentMaintenanceMonth(world, DEMO_CONFIG);
    // 构造“本月维护费已单独结算、仍有欠付且账上仍有现金”的时点：
    // 月度结算会把可用现金优先补缴欠费，这里显式标记已结算以单独验证分红闸门规则。
    world.equipmentMarket.maintenanceMonth!.settledCompanyIds.push(company.id);
    const logs: LogEntry[] = [];
    settleCompanyFinance(world, DEMO_CONFIG, logs);
    expect(company.lastMonth.dividendsPaid).toBe(0);
    expect(logs.some((entry) => entry.message.includes('存在未付设备维护费'))).toBe(true);
  });
});

describe('v1.6 §四 设备维护费：利润 / 现金流 / 独立服务流水', () => {
  it('维护费计入税前利润：所得税按扣除维护费后的利润计算，现金与经营现金流同步', () => {
    const world = newWorld();
    setEquipmentPrices(world, { farm: 120_000, industry: 200_000, energy: 160_000 });
    world.time.tick = 1;
    const company = companyOf(world, 'lp-food');
    setCompanyEmployees(company, 0);
    setEquipment(world, company, { farm: 0, industry: 10, energy: 0 });
    company.dividendPayoutRatio = 0;
    company.cash = 10_000_000;
    company.debt = 0;
    company.lastMonth = blankStats();
    company.lastMonth.revenue = 1_000_000;
    company.lastMonth.inputCost = 0;
    company.lastMonth.cogs = 0;
    beginEquipmentMaintenanceMonth(world, DEMO_CONFIG);
    const corporateTaxRate = world.cities.find((city) => city.id === company.cityId)!.corporateTaxRate;
    const cashBefore = company.cash;

    settleCompanyFinance(world, DEMO_CONFIG, []);

    const stats = company.lastMonth;
    expect(stats.maintenanceDue).toBe(20_000); // 10 台 × 200,000 × 1%
    expect(stats.maintenancePaid).toBe(20_000);
    expect(stats.wagesPaid).toBe(0);
    expect(stats.interestPaid).toBe(0);
    // 税前利润 = 收入 − COGS − 工资 − 维护费；所得税按该口径计算（维护费确实进税前利润）。
    const expectedProfitBeforeTax = round2(1_000_000 - 0 - 0 - 20_000);
    expect(stats.corporateTax).toBeCloseTo(round2(expectedProfitBeforeTax * corporateTaxRate), 2);
    expect(stats.profit).toBeCloseTo(expectedProfitBeforeTax - stats.corporateTax - stats.interestPaid, 2);
    // 现金：收入本月未实际到账（结算口径），但维护费、税是现金支出。
    expect(company.cash).toBeCloseTo(cashBefore - 20_000 - stats.corporateTax, 2);
    // 经营现金流同样扣除维护费现金支出。
    expect(stats.operatingCashFlow).toBeCloseTo(
      stats.revenue -
        stats.inputCost -
        stats.wagesPaid -
        maintenanceCashOut(company) -
        stats.interestPaid -
        stats.corporateTax,
      2,
    );
  });

  it('收款方是模拟范围外服务商：不进设备厂收入、不记政府税收，独立流水与实付一致', () => {
    const world = newWorld();
    setEquipmentPrices(world, { farm: 120_000, industry: 200_000, energy: 160_000 });
    world.time.tick = 1;
    const equipmentMaker = world.companies.find(
      (entry) => entry.recipeOutput === DEMO_CONFIG.equipment.catalog.industry.goodId,
    );
    const beforeMakerRevenue = world.companies.map((entry) => round2(entry.lastMonth.revenue ?? 0));
    const beforeTreasury = world.cities.map((city) => round2(city.treasury));
    const beforeCash = new Map(world.companies.map((entry) => [entry.id, entry.cash]));
    beginEquipmentMaintenanceMonth(world, DEMO_CONFIG);
    const month = settleCompanyMaintenance(world, DEMO_CONFIG, []);
    // 模拟内主体的现金只减少、不增加：维护费流出模拟范围。
    for (const entry of world.companies) {
      expect(entry.cash).toBeLessThanOrEqual(beforeCash.get(entry.id)! + 0.01);
    }
    // 设备厂收入、政府税收均不因维护费增加。
    for (const [index, entry] of world.companies.entries()) {
      expect(round2(entry.lastMonth.revenue ?? 0)).toBe(beforeMakerRevenue[index]);
    }
    expect(world.cities.map((city) => round2(city.treasury))).toEqual(beforeTreasury);
    // 独立月度流水：paid = 全部企业现金支付之和；due = paid（本月无欠付）。
    const totalCashOut = round2(
      world.companies.reduce((total, entry) => total + (beforeCash.get(entry.id)! - entry.cash), 0),
    );
    expect(month.totalPaid).toBeCloseTo(totalCashOut, 2);
    expect(month.totalDue).toBeCloseTo(totalCashOut, 2);
    expect(month.totalBorrowed).toBe(0);
    expect(month.note).toContain('模拟范围外');
    if (equipmentMaker) expect(equipmentMaker.lastMonth.revenue).toBe(0);
  });
});

describe('v1.6 §四 设备维护费：存档兼容', () => {
  it('存档往返保留月初快照、欠付与月度流水；次月按新快照计费', () => {
    const world = newWorld();
    setEquipmentPrices(world, { farm: 120_000, industry: 200_000, energy: 160_000 });
    world.time.tick = 1;
    const company = companyOf(world, 'lp-food');
    setEquipment(world, company, { farm: 1, industry: 2, energy: 3 });
    beginEquipmentMaintenanceMonth(world, DEMO_CONFIG);
    settleCompanyMaintenance(world, DEMO_CONFIG, []);
    company.maintenanceArrears = 1_234;

    const parsed = parseSave(serializeSave(world));
    expect(parsed.ok, parsed.error).toBe(true);
    const restored = parsed.world!;
    const restoredCompany = companyOf(restored, 'lp-food');
    expect(restoredCompany.maintenanceBase).toEqual({ farm: 1, industry: 2, energy: 3 });
    expect(restoredCompany.maintenancePrices).toEqual({ farm: 120_000, industry: 200_000, energy: 160_000 });
    expect(restoredCompany.maintenanceArrears).toBe(1_234);
    expect(restoredCompany.lastMonth.maintenanceDue).toBe(
      1 * 120_000 * 0.01 + 2 * 200_000 * 0.01 + 3 * 160_000 * 0.01,
    );
    expect(restored.equipmentMarket.maintenanceMonth?.tick).toBe(1);
    expect(restored.equipmentMarket.maintenanceMonth?.totalPaid).toBeGreaterThan(0);

    // 次月：旧月度流水归档，新快照按当月台数。
    restored.time.tick = 2;
    beginEquipmentMaintenanceMonth(restored, DEMO_CONFIG);
    expect(restored.equipmentMarket.maintenanceHistory?.length).toBe(1);
    expect(equipmentMaintenanceMonthFlow(restored, 1)?.totalPaid).toBeGreaterThan(0);
    expect(monthlyMaintenanceDue(restored, restoredCompany, DEMO_CONFIG).due).toBe(
      restoredCompany.lastMonth.maintenanceDue,
    );
  });

  it('旧档缺少新增字段：下一次 tick 开头补齐快照、按当前台数开始计费，不重复创建设备', () => {
    const world = newWorld();
    setEquipmentPrices(world, { farm: 120_000, industry: 200_000, energy: 160_000 });
    const company = companyOf(world, 'lp-food');
    setEquipment(world, company, { farm: 0, industry: 7, energy: 0 });
    const unitsBefore = { ...company.equipment };
    // 模拟旧档：删除 v1.6 新增的可选字段。
    delete (company as { maintenanceBase?: Equipment }).maintenanceBase;
    delete (company as { maintenancePrices?: Equipment }).maintenancePrices;
    delete (company as { maintenanceArrears?: number }).maintenanceArrears;
    delete (world.equipmentMarket as { maintenanceMonth?: unknown }).maintenanceMonth;
    delete (world.equipmentMarket as { maintenanceHistory?: unknown }).maintenanceHistory;

    world.time.tick = 5;
    // 旧档读取后直接结算（无 tick 快照）也必须开始计费：回退当前台数/当前价。
    const fallback = monthlyMaintenanceDue(world, company, DEMO_CONFIG);
    expect(fallback.basis).toBe('currentFallback');
    expect(fallback.due).toBe(7 * 200_000 * 0.01);

    // 下一次 tick 开头补齐快照，装备台数不变（不重复创建设备）。
    beginEquipmentMaintenanceMonth(world, DEMO_CONFIG);
    expect(company.maintenanceBase).toEqual({ farm: 0, industry: 7, energy: 0 });
    expect(company.equipment).toEqual(unitsBefore);
    const month = settleCompanyMaintenance(world, DEMO_CONFIG, []);
    expect(month.totalDue).toBeGreaterThanOrEqual(14_000);
    expect(company.lastMonth.maintenanceDue).toBe(14_000);
    expect(company.equipment).toEqual(unitsBefore);
  });
});

describe('v1.6 §四 设备维护费：AI 决策可见（与 pool-dev 协作的 helper）', () => {  it('estimatedMonthlyMaintenance(world, company, config) 只读、按当前台数×当前价估算', () => {
    const world = newWorld();
    setEquipmentPrices(world, { farm: 120_000, industry: 200_000, energy: 160_000 });
    const company = companyOf(world, 'lp-food');
    setEquipment(world, company, { farm: 2, industry: 1, energy: 0 });
    const before = JSON.stringify(world);
    // 签名稳定：3 个参数、返回 number；闲置/停产设备同样计入固定成本。
    const estimate: number = estimatedMonthlyMaintenance(world, company, DEMO_CONFIG);
    expect(estimate).toBe(2 * 120_000 * 0.01 + 1 * 200_000 * 0.01);
    expect(JSON.stringify(world)).toBe(before);
    expect(equipmentMaintenanceRate(DEMO_CONFIG)).toBe(0.01);
    // 面板/内部账用的明细与合计同口径。
    const lines = maintenanceBreakdown(world, company, DEMO_CONFIG);
    expect(lines.reduce((total, line) => total + line.fee, 0)).toBe(estimate);
    expect(currentMonthMaintenance(world, company, DEMO_CONFIG)).toBeGreaterThanOrEqual(0);
  });

  it('完整 tick 集成：tick 开头快照 → 月末财务扣费 → 独立流水/不变量均正常', () => {
    const sim = Simulation.create();
    const world = sim.state;
    setEquipmentPrices(world, { farm: 120_000, industry: 200_000, energy: 160_000 });
    const company = companyOf(world, 'lp-food');
    const expected = estimatedMonthlyMaintenance(world, company, DEMO_CONFIG);
    expect(expected).toBeGreaterThan(0);
    const result = sim.tick();
    expect(result.ok, result.error).toBe(true);
    expect(world.lastTick.invariants).toEqual([]);
    // 维护费按 tick 开头快照计费（1 月买入的设备下月起计费）。
    expect(company.lastMonth.maintenanceDue).toBeGreaterThan(0);
    expect(company.lastMonth.maintenanceDue).toBeCloseTo(expected, 2);
    const month = equipmentMaintenanceMonthFlow(world)!;
    expect(month.tick).toBe(world.time.tick);
    expect(month.totalDue).toBeGreaterThanOrEqual(company.lastMonth.maintenanceDue!);
    expect(month.totalDue).toBeCloseTo(
      (month.totalPaid ?? 0) + (month.totalArrearsAdded ?? 0),
      2,
    );
    expect(checkInvariants(world)).toEqual([]);
  });
});

describe('v1.6 §四 设备维护费：企业面板展示', () => {
  it('面板显示台数、计价单价、维护费与支付状态（含欠付状态）', () => {
    const store = new GameStore(Simulation.create(), {
      list: async () => ({ ok: true, slots: [] }),
      read: async (slot: string) => ({ ok: false, slot, error: '存档不存在', code: 'not-found' }),
      write: async (slot: string) => ({ ok: true, slot, savedAt: new Date().toISOString() }),
      remove: async () => ({ ok: true }),
      onMenuAction: () => () => undefined,
    } as unknown as SaveBridge);
    const world = store.world;
    setEquipmentPrices(world, { farm: 120_000, industry: 200_000, energy: 160_000 });
    world.time.tick = 1;
    const company = companyOf(world, 'lp-food');
    setEquipment(world, company, { farm: 0, industry: 10, energy: 0 });
    beginEquipmentMaintenanceMonth(world, DEMO_CONFIG);
    settleCompanyMaintenance(world, DEMO_CONFIG, []);

    const paidHtml = renderCompanyDetail(store, company);
    expect(paidHtml).toContain('data-testid="equipment-maintenance"');
    expect(paidHtml).toContain('data-testid="equipment-maintenance-total"');
    expect(paidHtml).toContain('data-testid="equipment-maintenance-status"');
    // 台数、计价单价与 1% 维护费：10 台 × 200,000 × 1% = 20,000（面板显示为 2.0 万）。
    expect(paidHtml).toContain('data-testid="equipment-maintenance-row-industry"');
    expect(paidHtml).toContain('10 台');
    expect(paidHtml).toMatch(/20\.0 万|20000/);
    expect(paidHtml).toContain('已付清');
    expect(paidHtml).toContain('1%');

    // 欠付状态：支付状态显示欠付金额，且损益表出现维护费/欠付标记。
    company.maintenanceArrears = 12_345;
    store.emit();
    const arrearsHtml = renderCompanyDetail(store, company);
    expect(arrearsHtml).toContain('欠付');
    expect(arrearsHtml).toContain('data-testid="equipment-maintenance-status"');
    expect(companyHasMaintenanceArrears(company)).toBe(true);
  });
});
