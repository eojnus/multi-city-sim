// v0.9 GDP 口径：公共服务增加值 = 当月实际计入居民收入的公共部门工资；
// 转移支付、借款、债券发行与债务勾销不计入 GDP；企业生产增加值口径不变、不重复计算。
import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation/core/simulation';
import { computeCityGdp } from '../src/simulation/economy/gdp';
import { DEMO_CONFIG } from '../src/data/config';
import { investInCompany } from '../src/simulation/economy/gdp';

function tickOnce(simulation: Simulation, times = 2): void {
  for (let index = 0; index < times; index += 1) {
    const result = simulation.tick();
    if (!result.ok) throw new Error(`推进失败：${result.error ?? '未知错误'}`);
  }
}

describe('v0.9 公共服务 GDP 口径', () => {
  it('公共部门工资计入 GDP，且与企业增加值相加不重复', () => {
    const simulation = Simulation.create();
    tickOnce(simulation);
    const world = simulation.state;
    const city = world.cities[0]!;
    const companyValue = world.lastTick.productionRecords
      .filter((record) => record.cityId === city.id)
      .reduce((total, record) => total + record.valueAdded, 0);
    city.lastMonth.publicWageBill = 5_000;
    const gdp = computeCityGdp(world);
    expect(gdp[city.id]).toBeCloseTo(companyValue + 5_000, 2);
    expect(city.gdp).toBeCloseTo(companyValue + 5_000, 2);
  });

  it('转移支付、借款、债券与债务勾销不计入 GDP', () => {
    const simulation = Simulation.create();
    tickOnce(simulation);
    const world = simulation.state;
    const city = world.cities[0]!;
    city.lastMonth.publicWageBill = 0;
    // 有企业增加值时，财政侧字段不得进入 GDP。
    city.lastMonth.benefitsPaid = 900_000;
    city.lastMonth.consumptionTax = 0;
    city.lastMonth.investorDividends = 0;
    city.treasury += 50_000_000;
    const before = computeCityGdp(world)[city.id]!;
    const companyValue = world.lastTick.productionRecords
      .filter((record) => record.cityId === city.id)
      .reduce((total, record) => total + record.valueAdded, 0);
    expect(before).toBeCloseTo(companyValue, 2);
    city.treasury += 10_000_000;
    expect(computeCityGdp(world)[city.id]).toBeCloseTo(companyValue, 2);
  });

  it('公共工资为 0 时 GDP 仅含企业增加值；负数按 0 处理', () => {
    const simulation = Simulation.create();
    tickOnce(simulation);
    const world = simulation.state;
    const city = world.cities[0]!;
    city.lastMonth.publicWageBill = 0;
    const companyValue = world.lastTick.productionRecords
      .filter((record) => record.cityId === city.id)
      .reduce((total, record) => total + record.valueAdded, 0);
    expect(computeCityGdp(world)[city.id]).toBeCloseTo(companyValue, 2);
    city.lastMonth.publicWageBill = -100;
    expect(computeCityGdp(world)[city.id]).toBeCloseTo(companyValue, 2);
  });
});

describe('v0.9 注资不再直接增加产能', () => {
  it('玩家注资只增加现金与股份，产能须另行购买设备', () => {
    const simulation = Simulation.create();
    tickOnce(simulation);
    const world = simulation.state;
    const company = world.companies[0]!;
    world.player.cash = 10_000_000;
    const capacityBefore = company.capacity;
    const equipmentBefore = { ...company.equipment };
    const result = investInCompany(world, company.id, 1_000_000, DEMO_CONFIG);
    expect(result.ok, result.error).toBe(true);
    expect(company.capacity).toBeCloseTo(capacityBefore, 2);
    expect(company.equipment).toEqual(equipmentBefore);
  });
});
