import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation/core/simulation';
import { executeTradeRoutes } from '../src/simulation/trade/trade';
import { DEMO_CONFIG } from '../src/data/config';
import { createWorldLedgers } from '../src/simulation/markets/markets';
import { settleTransportMonth } from '../src/simulation/transport/settlement';
import type { Company, CompanyMonthlyStats, WorldState } from '../src/simulation/contracts/types';

/** 跨城成交的资金在期末按容量统一结算；测试显式完成结算步骤。 */
function settle(world: WorldState): void {
  settleTransportMonth(world, DEMO_CONFIG, [], createWorldLedgers(world));
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

  it('成功交易同时提交融资、货物与买方付款，卖方所得在期末运输结算入账', () => {
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
    // 成交时卖方尚未入账，资金进入待结算的跨城销售（不回滚、不重复扣款）。
    expect(exporter.cash).toBe(0);
    expect(world.transport.pendingSales).toHaveLength(1);
    settle(world);
    // 容量 1400 单位/月，需求 10，不触发惩罚：卖方获得全额。
    expect(exporter.cash).toBe(500);
    expect(exporter.lastMonth.revenue).toBe(500);
    expect(exporter.lastMonth.exported).toBe(10);
    expect(world.transport.lastMonth.trades[0]!.penaltyRate).toBe(0);
  });

  it('成功交易可以使用营运资金信贷，并把借款与成交一起提交', () => {
    const { world, exporter, importer } = prepareTrade();
    importer.cash = 100;
    importer.baseWageBill = 10; // 信用额度 60；总可负担 160，买 3.2 单位（160）
    const flows = executeTradeRoutes(world, DEMO_CONFIG, []);
    expect(flows).toHaveLength(1);
    expect(flows[0]!.qty).toBe(3.2);
    expect(flows[0]!.value).toBe(160);
    expect(importer.cash).toBe(0);
    expect(importer.debt).toBe(60);
    expect(importer.inventory.grain).toBe(3.2);
    expect(importer.lastMonth.inputCost).toBe(160);
    expect(exporter.inventory.grain).toBe(996.8);
    settle(world);
    expect(exporter.cash).toBe(160);
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
