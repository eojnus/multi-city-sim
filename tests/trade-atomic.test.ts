import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation/core/simulation';
import { executeTradeRoutes } from '../src/simulation/trade/trade';
import { DEMO_CONFIG } from '../src/data/config';
import { createWorldLedgers } from '../src/simulation/markets/markets';
import { settleTransportMonth } from '../src/simulation/transport/settlement';
import type { Company, CompanyMonthlyStats, WorldState } from '../src/simulation/contracts/types';
import { migrateLegacyCompanyDebt } from '../src/simulation/banking/banking';

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
  it('授信不足、买不起任何数量时，现金/债务/库存/统计都不变', () => {
    const { world, exporter, importer } = prepareTrade();
    // v0.4：授信 = 非负账面股权 × 50% − 未偿。用一笔承接贷款把账面股权压到 0，
    // 使可借额度为 0（银行是债务唯一权威，先建合同再判定）。
    importer.debt = 1_000_000_000;
    migrateLegacyCompanyDebt(world, DEMO_CONFIG, world.time.tick);
    const exporterBefore = snapshot(exporter);
    const importerBefore = snapshot(importer);
    const flows = executeTradeRoutes(world, DEMO_CONFIG, []);
    expect(flows).toHaveLength(0);
    expect(snapshot(importer)).toEqual(importerBefore);
    expect(snapshot(exporter)).toEqual(exporterBefore);
  });

  it('成功交易同时提交货物与买方付款，卖方所得在期末运输结算入账', () => {
    const { world, exporter, importer } = prepareTrade();
    importer.cash = 3_100; // 62 单位 × 单价 50，现金足以全额支付，不需要融资
    const flows = executeTradeRoutes(world, DEMO_CONFIG, []);
    expect(flows).toHaveLength(1);
    const flow = flows[0]!;
    expect(flow.good).toBe('grain');
    expect(flow.qty).toBe(62);
    expect(flow.value).toBe(3_100);
    expect(importer.cash).toBe(0);
    expect(importer.debt).toBe(0);
    expect(importer.inventory.grain).toBe(62);
    expect(importer.lastMonth.inputCost).toBe(3_100);
    expect(exporter.inventory.grain).toBe(938);
    // 成交时卖方尚未入账，资金进入待结算的跨城销售（不回滚、不重复扣款）。
    expect(exporter.cash).toBe(0);
    expect(world.transport.pendingSales).toHaveLength(1);
    settle(world);
    // 容量 1400 单位/月，需求 62，不触发惩罚：卖方获得全额。
    expect(exporter.cash).toBe(3_100);
    expect(exporter.lastMonth.revenue).toBe(3_100);
    expect(exporter.lastMonth.exported).toBe(62);
    expect(world.transport.lastMonth.trades[0]!.penaltyRate).toBe(0);
  });

  it('成功交易可以使用营运资金信贷，并把银行借款与成交一起提交', () => {
    const { world, exporter, importer } = prepareTrade();
    importer.cash = 100; // 差 3,000，由银行周转贷款补足
    const flows = executeTradeRoutes(world, DEMO_CONFIG, []);
    expect(flows).toHaveLength(1);
    expect(flows[0]!.qty).toBe(62);
    expect(flows[0]!.value).toBe(3_100);
    expect(importer.cash).toBe(0);
    // v0.4：融资形成真实贷款合同，企业债务镜像 = 未偿本金。
    expect(importer.debt).toBe(3_000);
    const loans = world.banking.loans.filter(
      (loan) => loan.borrower.kind === 'company' && loan.borrower.id === importer.id,
    );
    expect(loans).toHaveLength(1);
    expect(loans[0]!.purpose).toBe('workingCapital');
    expect(loans[0]!.principal).toBe(3_000);
    expect(loans[0]!.outstanding).toBe(3_000);
    expect(importer.inventory.grain).toBe(62);
    expect(importer.lastMonth.inputCost).toBe(3_100);
    expect(exporter.inventory.grain).toBe(938);
    settle(world);
    expect(exporter.cash).toBe(3_100);
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
