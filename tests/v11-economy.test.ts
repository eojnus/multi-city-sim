// v1.1 §9 横切行为测试（不依赖各 owner 的 v1.1 WIP 行为改动）：
// - 旧 v0.9 真实存档：读取 → 推进 1 月 → 保存 → 再读取；
// - 人口 / 就业 / 股份 / 贷款 / 市场 / 税收 / 设备 的跨系统口径一致与守恒；
// - 设备自然生产与真实交易（自然状态，不手工购买）。
//
// 说明：v1.1 的行为改动（缺货信号、闲钱投资、小规模创业、企业购债预留、食品缺货
// 带动生产）由各 owner 落盘后，在 tests/v11-behaviors.test.ts 中补齐；本文件只断言
// 不依赖这些改动的横切不变量，避免把 WIP 状态固化成测试期望。
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Simulation } from '../src/simulation/core/simulation';
import { DEMO_CONFIG } from '../src/data/config';
import { checkInvariants } from '../src/simulation/core/invariants';
import { parseSave, serializeSave } from '../src/simulation/core/save';
import {
  equipmentCapacityFor,
  equipmentKindForSector,
} from '../src/simulation/equipment/equipment';
import { roleTotal } from '../src/simulation/companies/company';
import type { GoodId, WorldState } from '../src/simulation/contracts/types';

const FIXTURE_URL = new URL('./fixtures/v0.9-real-f942cc9.json', import.meta.url);
const FIXTURE_TEXT = readFileSync(FIXTURE_URL, 'utf8');

const EQUIPMENT_GOODS: GoodId[] = ['farmEquipment', 'industryEquipment', 'energyEquipment'];
const EMPLOYED_OCCUPATIONS = new Set(['management', 'production', 'sales', 'research', 'publicSector']);

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function loadLegacyWorld(): WorldState {
  const parsed = parseSave(FIXTURE_TEXT);
  if (!parsed.ok || !parsed.world) {
    throw new Error(`真实 v0.9 旧档读取失败：${parsed.error ?? '未知错误'}`);
  }
  return parsed.world;
}

function equipmentUnits(company: { equipment: { farm: number; industry: number; energy: number } }): number {
  return company.equipment.farm + company.equipment.industry + company.equipment.energy;
}

interface CompanySnapshot {
  capacity: number;
  equipmentCapacity: number;
  remainder: number;
  units: number;
}

function snapshotWorld(world: WorldState) {
  const companies = new Map<string, CompanySnapshot>();
  for (const company of world.companies) {
    companies.set(company.id, {
      capacity: company.capacity,
      equipmentCapacity: company.equipmentCapacity,
      remainder: company.equipmentCapacityRemainder ?? 0,
      units: equipmentUnits(company),
    });
  }
  return {
    tick: world.time.tick,
    companyCount: world.companies.length,
    companyIds: world.companies.map((company) => company.id),
    companies,
    populations: new Map(world.cities.map((city) => [city.id, city.population.total])),
    companyCash: sum(world.companies.map((company) => company.cash)),
    playerCash: world.player.cash,
    investorCash: sum(world.investors.map((investor) => investor.cash)),
    groupCash: sum(world.households.groups.map((group) => group.cash)),
    deposits: sum(world.banking.deposits.map((account) => account.balance)),
    issuedShares: sum(world.securities.classes.map((shareClass) => shareClass.issuedShares)),
  };
}

function assertEquipmentCapacityConsistent(world: WorldState): void {
  for (const company of world.companies) {
    const expected = equipmentCapacityFor(world, company, DEMO_CONFIG);
    expect(company.equipmentCapacity, `${company.id} equipmentCapacity`).toBeCloseTo(expected, 6);
    expect(company.capacity, `${company.id} capacity`).toBeCloseTo(expected, 6);
  }
}

describe('v1.1 §9 横切：旧 v0.9 真实存档', () => {
  it('读取 → 推进 1 月：不重新乘 5、不追加开局企业，设备余量与产能一致', () => {
    const sim = new Simulation(loadLegacyWorld(), DEMO_CONFIG);
    const before = snapshotWorld(sim.state);
    expect(before.tick).toBe(5);
    expect(before.companyCount).toBe(30);

    const result = sim.tick();
    expect(result.ok, result.error ?? '推进失败').toBe(true);
    expect(sim.state.time.tick).toBe(6);
    expect(checkInvariants(sim.state)).toEqual([]);

    // 旧档只能自然存续/创办，绝不能被重新执行新开局（每城 +16 家、人口 ×5）。
    // v1.1 每城每月最多自动创办 4 家（3 城合计 ≤12），一个月最多新增 12 家，
    // 远小于“重新执行开局”的 48 家；因此上限取 30 + 12。
    expect(sim.state.companies.length).toBeGreaterThanOrEqual(before.companyCount);
    expect(sim.state.companies.length).toBeLessThan(before.companyCount + 13);
    for (const id of before.companyIds) {
      expect(sim.state.companies.some((company) => company.id === id), `${id} 丢失`).toBe(true);
    }
    for (const city of sim.state.cities) {
      const oldTotal = before.populations.get(city.id)!;
      expect(city.population.total, `${city.id} 人口不应跳变`).toBeGreaterThanOrEqual(
        Math.floor(oldTotal * 0.99),
      );
      expect(city.population.total, `${city.id} 人口不应跳变`).toBeLessThanOrEqual(
        Math.ceil(oldTotal * 1.01),
      );
    }

    // 旧档补出的设备产能余量必须稳定；产能由设备 + 余量解释，不能被重算抹掉。
    for (const company of sim.state.companies) {
      const prior = before.companies.get(company.id);
      if (!prior) continue;
      expect(company.equipmentCapacityRemainder ?? 0, `${company.id} 余量`).toBeCloseTo(
        prior.remainder,
        6,
      );
      expect(equipmentUnits(company), `${company.id} 设备台数不应减少`).toBeGreaterThanOrEqual(
        prior.units,
      );
    }
    assertEquipmentCapacityConsistent(sim.state);
  });

  it('推进 1 月后存读档：人群 / 企业 / 设备 / 现金 / 股份 / 存款逐项一致', () => {
    const sim = new Simulation(loadLegacyWorld(), DEMO_CONFIG);
    expect(sim.tick().ok).toBe(true);
    const beforeSave = snapshotWorld(sim.state);

    const text = serializeSave(sim.state, '2026-11-04T00:00:00.000Z');
    const parsed = parseSave(text);
    expect(parsed.ok, parsed.error ?? '存档读取失败').toBe(true);
    const reloaded = parsed.world!;
    expect(checkInvariants(reloaded)).toEqual([]);
    const afterReload = snapshotWorld(reloaded);

    expect(afterReload.tick).toBe(beforeSave.tick);
    expect(afterReload.companyIds).toEqual(beforeSave.companyIds);
    expect(afterReload.populations).toEqual(beforeSave.populations);
    expect(afterReload.companyCash).toBeCloseTo(beforeSave.companyCash, 6);
    expect(afterReload.playerCash).toBeCloseTo(beforeSave.playerCash, 6);
    expect(afterReload.investorCash).toBeCloseTo(beforeSave.investorCash, 6);
    expect(afterReload.groupCash).toBeCloseTo(beforeSave.groupCash, 6);
    expect(afterReload.deposits).toBeCloseTo(beforeSave.deposits, 6);
    expect(afterReload.issuedShares).toBe(beforeSave.issuedShares);
    for (const company of reloaded.companies) {
      const prior = beforeSave.companies.get(company.id)!;
      expect(company.equipmentCapacityRemainder ?? 0).toBeCloseTo(prior.remainder, 6);
      expect(company.equipmentCapacity).toBeCloseTo(prior.equipmentCapacity, 6);
      expect(company.capacity).toBeCloseTo(prior.capacity, 6);
      expect(equipmentUnits(company)).toBe(prior.units);
    }
    assertEquipmentCapacityConsistent(reloaded);
  });
});

describe('v1.1 §9 横切：人口、就业、股份与贷款口径', () => {
  it('新开局 3 月后人口 / 就业 / 岗位 / 私营与公共部门逐项一致', () => {
    const sim = Simulation.create(DEMO_CONFIG);
    for (let month = 1; month <= 3; month += 1) {
      expect(sim.tick().ok).toBe(true);
    }
    const world = sim.state;
    expect(checkInvariants(world)).toEqual([]);

    let worldPopulation = 0;
    for (const city of world.cities) {
      const p = city.population;
      worldPopulation += p.total;
      expect(p.total, `${city.id} 总人口`).toBe(p.employed + p.unemployed + p.nonLabor);
      expect(p.laborForce, `${city.id} 劳动力`).toBe(p.employed + p.unemployed);
      expect(p.nonLabor, `${city.id} 非劳动力`).toBe(p.total - p.laborForce);

      const groups = world.households.groups.filter((group) => group.cityId === city.id);
      expect(sum(groups.map((group) => group.people)), `${city.id} 群体人口合计`).toBe(p.total);
      expect(
        sum(
          groups
            .filter((group) => EMPLOYED_OCCUPATIONS.has(group.occupation))
            .map((group) => group.people),
        ),
        `${city.id} 就业群体人数`,
      ).toBe(p.employed);
      expect(
        groups.find((group) => group.occupation === 'unemployed')?.people ?? 0,
        `${city.id} 失业群体`,
      ).toBe(p.unemployed);
      expect(
        groups.find((group) => group.occupation === 'nonLabor')?.people ?? 0,
        `${city.id} 非劳动力群体`,
      ).toBe(p.nonLabor);

      const companyEmployees = sum(
        world.companies.filter((company) => company.cityId === city.id).map((c) => c.employees),
      );
      expect(companyEmployees + city.publicSector.employees, `${city.id} 雇主合计`).toBe(
        p.employed,
      );
      for (const company of world.companies) {
        if (company.cityId !== city.id) continue;
        expect(roleTotal(company.roles), `${company.id} 岗位合计`).toBe(company.employees);
      }
    }
    expect(worldPopulation).toBe(sum(world.cities.map((city) => city.population.total)));
  });

  it('新开局 3 月后股份总量与贷款本金账本自洽', () => {
    const sim = Simulation.create(DEMO_CONFIG);
    for (let month = 1; month <= 3; month += 1) {
      expect(sim.tick().ok).toBe(true);
    }
    const world = sim.state;

    // 股份守恒：每个股份类别的全部持仓（含玩家 / 居民实体 / 企业 / 政府 / 托管）等于发行数。
    for (const shareClass of world.securities.classes) {
      const held = sum(
        world.securities.holdings
          .filter((holding) => holding.shareClassId === shareClass.id)
          .map((holding) => holding.shares),
      );
      expect(held, `${shareClass.id} 持股合计 != 发行数`).toBeCloseTo(shareClass.issuedShares, 6);
    }

    // 贷款账本：未偿本金 + 已还本金 = 原始本金；欠付本金是未偿本金的子集，不重复计算。
    expect(world.banking.loans.length).toBeGreaterThan(0);
    for (const loan of world.banking.loans) {
      expect(loan.outstanding, `${loan.id} 未偿为负`).toBeGreaterThanOrEqual(-0.01);
      expect(
        loan.principal - loan.paidPrincipal - loan.outstanding,
        `${loan.id} 本金恒等`,
      ).toBeCloseTo(0, 2);
      expect(loan.arrearsPrincipal, `${loan.id} 欠付本金超过未偿`).toBeLessThanOrEqual(
        loan.outstanding + 0.01,
      );
      expect(loan.arrearsInterest).toBeGreaterThanOrEqual(-0.01);
      expect(
        loan.payments.every(
          (payment) =>
            payment.principalPaid >= -0.01 &&
            payment.interestPaid >= -0.01 &&
            payment.arrears >= -0.01,
        ),
      ).toBe(true);
    }

    // 账户不为负：企业 / 居民群体 / 玩家 / 居民投资实体。
    expect(world.companies.every((company) => company.cash >= -0.01)).toBe(true);
    expect(world.households.groups.every((group) => group.cash >= -0.01)).toBe(true);
    expect(world.banking.deposits.every((account) => account.balance >= -0.01)).toBe(true);
    expect(world.player.cash).toBeGreaterThanOrEqual(-0.01);
    expect(world.investors.every((investor) => investor.cash >= -0.01)).toBe(true);
  });
});

describe('v1.1 §9 横切：市场、库存与税收账本', () => {
  it('新开局 3 月后市场账本自洽且不变量为空', () => {
    const sim = Simulation.create(DEMO_CONFIG);
    for (let month = 1; month <= 3; month += 1) {
      expect(sim.tick().ok).toBe(true);
    }
    const world = sim.state;
    expect(checkInvariants(world)).toEqual([]);

    for (const city of world.cities) {
      for (const goodId of Object.keys(city.market) as GoodId[]) {
        const market = city.market[goodId];
        expect(market.price, `${city.id}/${goodId} 价格`).toBeGreaterThan(0);
        expect(market.sold, `${city.id}/${goodId} 成交为负`).toBeGreaterThanOrEqual(-0.01);
        expect(market.closingStock, `${city.id}/${goodId} 期末库存为负`).toBeGreaterThanOrEqual(
          -0.01,
        );
        expect(market.unmetDemand, `${city.id}/${goodId} 未满足为负`).toBeGreaterThanOrEqual(
          -0.01,
        );
        expect(market.unmetFunding, `${city.id}/${goodId} 资金缺口为负`).toBeGreaterThanOrEqual(
          -0.01,
        );
        // 跨城进口的单位可继续在本地成交，因此可用供给 = 本地供应 + 跨城进口。
        expect(
          market.sold,
          `${city.id}/${goodId} 成交超过可用供给`,
        ).toBeLessThanOrEqual(market.supply + market.intercityImported + 0.05);
        expect(market.sold, `${city.id}/${goodId} 成交超过需求`).toBeLessThanOrEqual(
          market.demand + 0.05,
        );
      }
    }
  });

  it('新开局 3 月后税收记录：四税合计 / 基准 / 交通系数账本对账', () => {
    const sim = Simulation.create(DEMO_CONFIG);
    for (let month = 1; month <= 3; month += 1) {
      expect(sim.tick().ok).toBe(true);
    }
    const world = sim.state;

    for (const city of world.cities) {
      const history = world.taxes.historyByCity[city.id] ?? [];
      expect(history.length, `${city.id} 缺少税收记录`).toBeGreaterThan(0);
      for (const record of history) {
        const baseSum =
          record.incomeTaxBase +
          record.corporateTaxBase +
          record.consumptionTaxBase +
          record.dividendTaxBase;
        const revenueSum =
          record.incomeTaxRevenue +
          record.corporateTaxRevenue +
          record.consumptionTaxRevenue +
          record.dividendTaxRevenue;
        expect(record.totalBase, `${city.id} t${record.tick} 基准合计`).toBeCloseTo(baseSum, 2);
        expect(record.totalRevenue, `${city.id} t${record.tick} 入账合计`).toBeCloseTo(
          revenueSum,
          2,
        );
        expect(
          record.totalRevenue,
          `${city.id} t${record.tick} 基准+加成-损耗`,
        ).toBeCloseTo(record.totalBase + record.transportBonus - record.transportLoss, 2);
        expect(record.transportBonus).toBeGreaterThanOrEqual(-0.01);
        expect(record.transportLoss).toBeGreaterThanOrEqual(-0.01);
        expect(record.transportFactor).toBeGreaterThanOrEqual(0.5);
        expect(record.transportFactor).toBeLessThanOrEqual(1.5);
      }
    }
  });
});

describe('v1.1 §9 横切：设备自然生产与真实交易', () => {
  it('自然运行 3 月：设备厂真实生产、市场真实成交、买方产能随设备增加', () => {
    const sim = Simulation.create(DEMO_CONFIG);
    const world = sim.state;
    const equipmentProducers = world.companies.filter((company) =>
      EQUIPMENT_GOODS.includes(company.recipeOutput),
    );
    expect(equipmentProducers.length, '开局缺少真实设备生产企业').toBeGreaterThanOrEqual(3);

    const unitsBefore = new Map(
      world.companies.map((company) => [company.id, equipmentUnits(company)]),
    );
    let produced = 0;
    let sold = 0;
    let capitalized = 0;
    for (let month = 1; month <= 3; month += 1) {
      expect(sim.tick().ok).toBe(true);
      produced += sum(
        world.lastTick.productionRecords
          .filter((record) => EQUIPMENT_GOODS.includes(record.good))
          .map((record) => record.qty),
      );
      for (const city of world.cities) {
        for (const goodId of EQUIPMENT_GOODS) {
          sold += city.market[goodId].sold;
        }
      }
      for (const goodId of EQUIPMENT_GOODS) {
        capitalized += world.equipmentMarket.capitalizedThisTick?.[goodId] ?? 0;
      }
    }

    expect(produced, '设备厂没有自然生产').toBeGreaterThan(0);
    expect(sold, '设备市场没有真实成交').toBeGreaterThan(0);
    expect(capitalized, '设备成交没有转成买方固定资产').toBeGreaterThan(0);

    const unitsAfter = sum(world.companies.map((company) => equipmentUnits(company)));
    expect(unitsAfter, '世界设备台数没有因真实交易增加').toBeGreaterThan(
      sum([...unitsBefore.values()]),
    );
    let boughtByCompany = false;
    for (const company of world.companies) {
      const prior = unitsBefore.get(company.id);
      if (prior !== undefined && equipmentUnits(company) > prior) boughtByCompany = true;
    }
    expect(boughtByCompany, '没有任何企业作为真实买方增加设备').toBe(true);

    for (const company of world.companies) {
      const kind = equipmentKindForSector(company.sector, DEMO_CONFIG);
      expect(company.equipment[kind], `${company.id} 主营设备台数应为整数`).toBeGreaterThanOrEqual(
        0,
      );
    }
    assertEquipmentCapacityConsistent(world);
    expect(checkInvariants(world)).toEqual([]);
  });
});
