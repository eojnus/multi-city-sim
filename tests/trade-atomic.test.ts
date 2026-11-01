import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation/core/simulation';
import { executeTradeRoutes } from '../src/simulation/trade/trade';
import { DEMO_CONFIG } from '../src/data/config';
import type { Company, CompanyMonthlyStats } from '../src/simulation/contracts/types';

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
  };
}

function snapshot(company: Company) {
  return {
    cash: company.cash,
    debt: company.debt,
    grain: company.inventory.grain,
    stats: { ...company.lastMonth },
  };
}

function prepareTrade() {
  const world = Simulation.create().state;
  const route = world.tradeRoutes.find((entry) => entry.id === 'route-grain-lanport')!;
  for (const entry of world.tradeRoutes) entry.active = entry.id === route.id;
  const exporter = world.companies.find((company) => company.id === route.fromCompanyId)!;
  const importer = world.companies.find((company) => company.id === route.toCompanyId)!;
  const toCity = world.cities.find((city) => city.id === route.toCityId)!;

  importer.employees = 0;
  importer.roles = { management: 0, production: 0, sales: 0, research: 0 };
  importer.jobDemand = 0;
  importer.baseWageBill = 0;
  importer.cash = 0;
  importer.debt = 0;
  importer.capacity = 100;
  importer.utilization = 1;
  importer.inventory.grain = 0;
  importer.lastMonth = blankStats();

  exporter.inventory.grain = 1_000;
  exporter.cash = 0;
  exporter.debt = 0;
  exporter.lastMonth = blankStats();
  toCity.market.grain.price = 50;
  return { world, route, exporter, importer };
}

describe('跨城交易原子性', () => {
  it('只能借到很少资金、不足以成交时，现金/债务/库存/统计都不变', () => {
    const { world, exporter, importer } = prepareTrade();
    importer.baseWageBill = 0.1; // 信用额度 0.6，价格 50，连 1 单位都买不起
    const exporterBefore = snapshot(exporter);
    const importerBefore = snapshot(importer);
    const flows = executeTradeRoutes(world, DEMO_CONFIG, []);
    expect(flows).toHaveLength(0);
    expect(snapshot(importer)).toEqual(importerBefore);
    expect(snapshot(exporter)).toEqual(exporterBefore);
  });

  it('成功交易同时提交融资、货物、资金和统计记录', () => {
    const { world, exporter, importer } = prepareTrade();
    importer.cash = 500;
    const flows = executeTradeRoutes(world, DEMO_CONFIG, []);
    expect(flows).toHaveLength(1);
    const flow = flows[0]!;
    expect(flow.good).toBe('grain');
    expect(flow.qty).toBe(10);
    expect(flow.value).toBe(500);
    expect(importer.cash).toBe(0);
    expect(importer.debt).toBe(0);
    expect(importer.inventory.grain).toBe(10);
    expect(importer.lastMonth.inputCost).toBe(500);
    expect(exporter.inventory.grain).toBe(990);
    expect(exporter.cash).toBe(500);
    expect(exporter.lastMonth.revenue).toBe(500);
    expect(exporter.lastMonth.exported).toBe(10);
  });

  it('无效交易主体不会抛异常或改变任何主体', () => {
    const { world, exporter, importer, route } = prepareTrade();
    route.fromCompanyId = 'does-not-exist';
    const exporterBefore = snapshot(exporter);
    const importerBefore = snapshot(importer);
    expect(() => executeTradeRoutes(world, DEMO_CONFIG, [])).not.toThrow();
    expect(snapshot(importer)).toEqual(importerBefore);
    expect(snapshot(exporter)).toEqual(exporterBefore);
  });
});
