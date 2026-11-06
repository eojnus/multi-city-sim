// v1.6 §五 D6：僵尸企业退出（零员工漏洞修复 / 长期无经营能力清算 / 暂时停业保护）。
//
// 规则（Lead 确认的 D6 口径）：
// - 保护期 = max(lifecycle.bankruptcy.minAgeMonths, companyAi.newCompanyGraceMonths)；
//   保护期内 idleMonths 清零，不累计历史计数；
// - idleMonths：上一完整月 produced≈0 且 sold+exported≈0 时 +1，任一经营活动即清零
//   （必须读 previousMonth：checkBankruptcies 在 tick 第 5 步、lastMonth 已被月首重置）；
// - idleMonths ≥ idleExitMonths（默认 6）且 现金+可用授信 < 1 个月固定成本
//   （工资 + 设备维护费 + 偿债）且无实际恢复计划、无纾困观察期 → 走既有 liquidateCompany；
// - 短于 idleExitMonths 的停业、可覆盖固定成本的停业、有真实需求+正毛利+可开工资产的停业不清算；
// - 修复旧漏洞：`if (wage <= 0) continue;` 让零员工/零工资企业永远跳过后续判定。
import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation/core/simulation';
import { DEMO_CONFIG } from '../src/data/config';
import type {
  Company,
  CompanyMonthlyStats,
  GoodId,
  LogEntry,
  MarketState,
  WorldState,
} from '../src/simulation/contracts/types';
import { createEmptyInventory, setCompanyEmployees } from '../src/simulation/companies/company';
import { checkBankruptcies } from '../src/simulation/companies/lifecycle/lifecycle';
import { companyMonthlyFixedCost } from '../src/simulation/companies/cost';

const CITY_ID = 'lanport';
const IDLE_EXIT_MONTHS = DEMO_CONFIG.lifecycle.bankruptcy.idleExitMonths;

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
  goodId: GoodId,
  overrides: Partial<MarketState>,
): void {
  city.market[goodId] = { ...city.market[goodId], ...overrides };
}

/** 三城该商品都设为“无需求、无缺货、无资金缺口”，排除恢复计划里的市场需求来源。 */
function noDemandAnywhere(world: WorldState, goodId: GoodId): void {
  for (const city of world.cities) {
    setMarket(city, goodId, {
      consumerDemand: 0,
      producerDemand: 0,
      producerRequired: 0,
      sold: 0,
      unmetDemand: 0,
      unmetFunding: 0,
      intercityImported: 0,
    });
  }
}

/** 构造“上一完整月完全停业”的企业状态（ageMonths 已过保护期）。 */
function stageIdleZombie(
  world: WorldState,
  overrides: {
    employees?: number;
    cash?: number;
    debt?: number;
    idleMonths?: number;
    ageMonths?: number;
    lossMonths?: number;
    keepEquipment?: boolean;
  } = {},
): Company {
  const company = companyOf(world, 'lp-food');
  const employees = overrides.employees ?? 0;
  setCompanyEmployees(company, employees);
  company.jobDemand = employees;
  company.cash = overrides.cash ?? 0;
  company.debt = overrides.debt ?? 0;
  company.inventory = createEmptyInventory();
  company.initialEquipment = undefined;
  if (!overrides.keepEquipment) {
    company.equipment = { farm: 0, industry: 0, energy: 0 };
    company.equipmentCapacity = 0;
    company.capacity = 0;
  }
  company.salesHistory = [0, 0, 0];
  company.previousMonth = monthStats();
  company.lastMonth = monthStats();
  company.productionPlan = null;
  company.ai = {
    ...company.ai,
    ageMonths: overrides.ageMonths ?? 20,
    lossMonths: overrides.lossMonths ?? 0,
    idleMonths: overrides.idleMonths ?? 0,
  };
  noDemandAnywhere(world, company.recipeOutput);
  return company;
}

describe('v1.6 §五 僵尸企业退出', () => {
  it('修复零员工漏洞：零工资企业不再被跳过，现金耗尽且无授信时仍能清算', () => {
    const world = Simulation.create().state;
    // 零员工 + 零设备 + 现金 0 + 债务压满（可用授信为 0）+ 连续亏损。
    const company = stageIdleZombie(world, {
      employees: 0,
      cash: 0,
      debt: 1_000_000_000,
      ageMonths: 20,
      lossMonths: 6,
    });
    const fixed = companyMonthlyFixedCost(world, company, DEMO_CONFIG);
    expect(fixed.wage).toBe(0); // 旧实现正是因为这个 0 而直接 continue。
    expect(fixed.total).toBeGreaterThan(0); // 偿债仍构成一个月固定成本。

    const log: LogEntry[] = [];
    const liquidated = checkBankruptcies(world, DEMO_CONFIG, log);
    expect(liquidated).toContain(company.id);
    const record = world.lifecycle.liquidations.find((entry) => entry.companyId === company.id)!;
    expect(record).toBeDefined();
    expect(record.employeesReleased).toBe(0);
    expect(world.companies.some((entry) => entry.id === company.id)).toBe(false);
  });

  it('可恢复的短期停业（短于 idleExitMonths）不清算，idleMonths 正常累计；有经营活动即清零', () => {
    const world = Simulation.create().state;
    const company = stageIdleZombie(world, { employees: 100, cash: 0, debt: 0 });
    const log: LogEntry[] = [];

    let liquidated = checkBankruptcies(world, DEMO_CONFIG, log);
    expect(liquidated).not.toContain(company.id);
    expect(company.ai.idleMonths).toBe(1);
    world.time.tick += 1;
    liquidated = checkBankruptcies(world, DEMO_CONFIG, log);
    expect(liquidated).not.toContain(company.id);
    expect(company.ai.idleMonths).toBe(2);
    expect(company.ai.idleMonths).toBeLessThan(IDLE_EXIT_MONTHS);

    // 恢复生产（哪怕只生产不销售，用于建库存）：停业计数清零。
    company.ai.idleMonths = 5;
    company.previousMonth = monthStats({ produced: 10, sold: 0, exported: 0 });
    world.time.tick += 1;
    checkBankruptcies(world, DEMO_CONFIG, log);
    expect(company.ai.idleMonths).toBe(0);
    expect(world.companies.some((entry) => entry.id === company.id)).toBe(true);
  });

  it('停业但现金+授信可覆盖 1 个月固定成本的企业不清算（暂时停业的合理保护）', () => {
    const world = Simulation.create().state;
    const company = stageIdleZombie(world, { employees: 100, cash: 0, debt: 0 });
    const fixed = companyMonthlyFixedCost(world, company, DEMO_CONFIG);
    expect(fixed.total).toBeGreaterThan(0);
    company.cash = Math.ceil(fixed.total * 2);
    company.ai.idleMonths = IDLE_EXIT_MONTHS - 1;

    const liquidated = checkBankruptcies(world, DEMO_CONFIG, []);
    expect(liquidated).not.toContain(company.id);
    expect(company.ai.idleMonths).toBe(IDLE_EXIT_MONTHS);
    expect(company.cash).toBeGreaterThan(0);
  });

  it('长期停业但有实际恢复计划（真实需求 + 正毛利 + 设备员工可开工）不清算', () => {
    const world = Simulation.create().state;
    const company = stageIdleZombie(world, {
      employees: 0,
      cash: 0,
      debt: 1_000_000_000, // 授信为 0：只有恢复计划能救它
      idleMonths: IDLE_EXIT_MONTHS - 1,
      keepEquipment: true,
    });
    setCompanyEmployees(company, 200);
    // 本城有真实可支付缺货，且市场价高于单位成本（食品厂原料/工资成本 < 市场价）。
    setMarket(cityOf(world), 'food', {
      consumerDemand: 1_000_000,
      producerDemand: 0,
      producerRequired: 0,
      sold: 0,
      unmetDemand: 1_000_000,
      unmetFunding: 0,
      intercityImported: 0,
    });

    const log: LogEntry[] = [];
    const liquidated = checkBankruptcies(world, DEMO_CONFIG, log);
    expect(liquidated).not.toContain(company.id);
    expect(company.ai.idleMonths).toBe(IDLE_EXIT_MONTHS);
    expect(log.some((entry) => entry.message.includes('恢复计划'))).toBe(true);
  });

  it('长期无经营能力（无产出/无销售 + 无资金能力 + 无恢复计划）走既有清算：设备/锁定实物出资/债务/名额都处理', () => {
    const world = Simulation.create().state;
    const company = stageIdleZombie(world, {
      employees: 0,
      cash: 0,
      debt: 100_000_000,
      idleMonths: IDLE_EXIT_MONTHS - 1,
      keepEquipment: true,
      lossMonths: 0, // 证明不是“单月亏损”触发
    });
    // 2 台工业设备，其中 1 台为锁定期内的创办实物出资（清算时按实物返还）。
    company.equipment = { farm: 0, industry: 2, energy: 0 };
    company.initialEquipment = {
      kind: 'industry',
      units: 1,
      valuation: 120_000,
      source: 'founderInKind',
      grantedTick: 0,
      lockUntilTick: world.time.tick + 10,
    };
    const companiesBefore = world.companies.length;

    const log: LogEntry[] = [];
    const liquidated = checkBankruptcies(world, DEMO_CONFIG, log);
    expect(liquidated).toContain(company.id);
    expect(world.companies).toHaveLength(companiesBefore - 1);
    expect(world.companies.some((entry) => entry.id === company.id)).toBe(false);

    const record = world.lifecycle.liquidations.find((entry) => entry.companyId === company.id)!;
    expect(record).toBeDefined();
    expect(record.reason).toContain(`连续 ${IDLE_EXIT_MONTHS} 个月无产出且无销售`);
    expect(record.reason).toContain('固定成本');
    // 锁定期内的实物出资按实物返还（不进入清算现金/股东分配）。
    expect(record.initialEquipmentReturned?.units).toBe(1);
    // 债务走既有清算顺序：现金先偿债，银行真实贷款的未偿部分记减免。
    // 本夹具的 company.debt 是镜像值（没有对应 banking.loans 合同），因此减免流水为 0，
    // 清算记录仍如实保留债务总额；这里只断言“偿债 + 减免”不超过记录债务、不重复记账。
    expect(record.debt).toBeGreaterThan(0);
    expect(record.debtRepaid + record.debtForgiven).toBeLessThanOrEqual(record.debt + 0.01);
    expect(record.shareholderPayout).toBeGreaterThanOrEqual(0);
    // 企业名额释放：清算记录可追溯，后续创办不再受它占用。
    expect(world.lifecycle.liquidations.some((entry) => entry.companyId === company.id)).toBe(true);
  });

  it('保护期（max(minAgeMonths, newCompanyGraceMonths)）内不计停业月数、不清算', () => {
    const world = Simulation.create().state;
    const company = stageIdleZombie(world, {
      employees: 0,
      cash: 0,
      debt: 1_000_000_000,
      ageMonths: 2,
      idleMonths: IDLE_EXIT_MONTHS + 3,
      lossMonths: 20,
    });
    const liquidated = checkBankruptcies(world, DEMO_CONFIG, []);
    expect(liquidated).not.toContain(company.id);
    expect(company.ai.idleMonths).toBe(0);
    expect(world.companies.some((entry) => entry.id === company.id)).toBe(true);
  });

  it('配置口径：idleExitMonths 默认 6、覆盖 1 个月固定成本', () => {
    expect(DEMO_CONFIG.lifecycle.bankruptcy.idleExitMonths).toBe(6);
    expect(DEMO_CONFIG.lifecycle.bankruptcy.idleFixedCostCoverMonths).toBe(1);
  });
});
