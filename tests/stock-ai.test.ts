// v0.8 AI 投资行为：真实财务决策、预算/订单数约束、只用真实资金与持股、不参与玩家经营企业。
//
// 覆盖：资金与股份守恒、无自成交、预算上限、订单数上限、player 经营企业跳过、
// 利润为负目标过滤、撤单语义、确定性。

import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation/core/simulation';
import { DEMO_CONFIG } from '../src/data/config';
import type { DemoConfig } from '../src/data/config';
import type { StockOrder, WorldState } from '../src/simulation/contracts/types';
import {
  bookPrice,
  cancelOrder,
  matchOrders,
  placeOrder,
} from '../src/simulation/securities/securities';
import {
  groupHolder,
  planCompanyOrders,
  planInvestorOrders,
} from '../src/simulation/investors/investors';
import { round2 } from '../src/simulation/core/math';

function newWorld(tick = 1): WorldState {
  const world = Simulation.create().state;
  world.time.tick = tick;
  return world;
}

function makeRich(world: WorldState, companyId: string, cash = 600_000_000): void {
  const company = world.companies.find((candidate) => candidate.id === companyId);
  if (!company) throw new Error(`企业不存在：${companyId}`);
  company.cash = cash;
}

function totalCash(world: WorldState): number {
  return round2(
    world.player.cash +
      world.companies.reduce((sum, company) => sum + company.cash, 0) +
      world.investors.reduce((sum, group) => sum + group.cash, 0),
  );
}

function holdingsByClass(world: WorldState): Map<string, number> {
  const result = new Map<string, number>();
  for (const holding of world.securities.holdings) {
    result.set(
      holding.shareClassId,
      round2((result.get(holding.shareClassId) ?? 0) + holding.shares),
    );
  }
  return result;
}

function aiOrders(world: WorldState, side: 'buy' | 'sell'): StockOrder[] {
  return world.securities.orders.filter(
    (order) =>
      order.side === side &&
      (order.holder.type === 'investorGroup' || order.holder.type === 'company'),
  );
}

function configWithAi(overrides: Record<string, unknown>): DemoConfig {
  return {
    ...DEMO_CONFIG,
    securities: {
      ...DEMO_CONFIG.securities,
      ai: { ...DEMO_CONFIG.securities.ai, ...overrides },
    },
  } as unknown as DemoConfig;
}

describe('AI 投资行为（v0.8）', () => {
  it('AI 下单受预算与订单数约束，撮合后资金与股份守恒且无自成交', () => {
    const world = newWorld();
    makeRich(world, 'lp-food');
    const cashBefore = totalCash(world);
    const holdingsBefore = holdingsByClass(world);
    const groupCashBefore = new Map(world.investors.map((group) => [group.id, group.cash]));

    planInvestorOrders(world, DEMO_CONFIG, world.time.tick);
    planCompanyOrders(world, DEMO_CONFIG, world.time.tick);

    const ai = DEMO_CONFIG.securities.ai;
    for (const group of world.investors) {
      const buys = world.securities.orders.filter(
        (order) =>
          order.side === 'buy' &&
          order.holder.type === 'investorGroup' &&
          order.holder.id === group.id,
      );
      const sells = world.securities.orders.filter(
        (order) =>
          order.side === 'sell' &&
          order.holder.type === 'investorGroup' &&
          order.holder.id === group.id,
      );
      expect(buys.length).toBeLessThanOrEqual(ai.maxBuyOrdersPerGroup);
      // v0.8.2：投票权与仅分红卖单分开计数（仅分红是独立流动性与现金需求通道）。
      const votingSells = sells.filter(
        (order) =>
          world.securities.classes.find((cls) => cls.id === order.shareClassId)?.kind ===
          'voting',
      );
      const nonVotingSells = sells.filter(
        (order) =>
          world.securities.classes.find((cls) => cls.id === order.shareClassId)?.kind ===
          'nonVoting',
      );
      expect(votingSells.length).toBeLessThanOrEqual(ai.maxSellOrdersPerGroup);
      expect(nonVotingSells.length).toBeLessThanOrEqual(ai.nonVotingMaxSellOrdersPerGroup);
      expect(sells.length).toBeLessThanOrEqual(
        ai.maxSellOrdersPerGroup + ai.nonVotingMaxSellOrdersPerGroup,
      );
      const buyValue = round2(
        buys.reduce((sum, order) => sum + order.shares * order.limitPrice, 0),
      );
      const budget = round2((groupCashBefore.get(group.id) ?? 0) * ai.groupBudgetShare);
      expect(buyValue).toBeLessThanOrEqual(budget + 0.01);
      // 只用真实现金：挂单总面值不超过现金。
      expect(buyValue).toBeLessThanOrEqual((groupCashBefore.get(group.id) ?? 0) + 0.01);
    }

    for (const company of world.companies) {
      const buys = world.securities.orders.filter(
        (order) =>
          order.side === 'buy' &&
          order.holder.type === 'company' &&
          order.holder.id === company.id,
      );
      expect(buys.length).toBeLessThanOrEqual(1);
      const buyValue = round2(
        buys.reduce((sum, order) => sum + order.shares * order.limitPrice, 0),
      );
      expect(buyValue).toBeLessThanOrEqual(
        Math.min(ai.companyBudgetCap, round2(company.cash * ai.companyBudgetShare)) + 0.01,
      );
    }

    // 同一持有人不会在同一股份类别上同时挂买卖（避免自成交）。
    const sidesByHolderClass = new Map<string, Set<string>>();
    for (const order of aiOrders(world, 'buy').concat(aiOrders(world, 'sell'))) {
      const key = `${order.holder.type}:${order.holder.id}:${order.shareClassId}`;
      const sides = sidesByHolderClass.get(key) ?? new Set<string>();
      sides.add(order.side);
      sidesByHolderClass.set(key, sides);
    }
    for (const sides of sidesByHolderClass.values()) {
      expect(sides.size).toBe(1);
    }

    // 卖单不超过实际持股。
    for (const order of aiOrders(world, 'sell')) {
      const holding = world.securities.holdings.find(
        (entry) =>
          entry.shareClassId === order.shareClassId &&
          entry.holder.type === order.holder.type &&
          entry.holder.id === order.holder.id,
      );
      expect(order.shares).toBeLessThanOrEqual(holding?.shares ?? 0);
    }

    const trades = matchOrders(world, world.time.tick, DEMO_CONFIG);
    expect(trades.length).toBeGreaterThan(0);
    for (const trade of trades) {
      expect(
        trade.buyer.type === trade.seller.type && trade.buyer.id === trade.seller.id,
      ).toBe(false);
    }
    expect(totalCash(world)).toBeCloseTo(cashBefore, 2);
    expect(holdingsByClass(world)).toEqual(holdingsBefore);
  });

  it('玩家经营的企业不会被 AI 企业下单，其他现金充裕的企业仍会投资', () => {
    const world = newWorld();
    makeRich(world, 'lp-food');
    makeRich(world, 'lp-garment');
    const control = world.governance!.controls.find((entry) => entry.companyId === 'lp-food')!;
    control.operator = { type: 'player', id: 'player' };

    planCompanyOrders(world, DEMO_CONFIG, world.time.tick);

    const companyOrders = world.securities.orders.filter(
      (order) => order.holder.type === 'company',
    );
    expect(companyOrders.some((order) => order.holder.id === 'lp-food')).toBe(false);
    expect(companyOrders.some((order) => order.holder.id === 'lp-garment')).toBe(true);
    // 玩家经营企业也不会被 AI 生成卖单（企业 AI 只买不卖，这里作为防御性断言）。
    expect(
      world.securities.orders.some(
        (order) => order.side === 'sell' && order.holder.id === 'lp-food',
      ),
    ).toBe(false);
  });

  it('requireNonNegativeProfit 为真时，最近利润为负的企业不会成为投资对象', () => {
    const world = newWorld();
    makeRich(world, 'lp-food');
    for (const company of world.companies) {
      company.lastMonth.profit = -100;
      company.previousMonth.profit = 0;
    }
    const profitable = world.companies.find((company) => company.id === 'iv-appliance')!;
    profitable.lastMonth.profit = 50;

    planCompanyOrders(world, DEMO_CONFIG, world.time.tick);

    const orders = world.securities.orders.filter(
      (order) => order.holder.type === 'company' && order.holder.id === 'lp-food',
    );
    expect(orders).toHaveLength(1);
    expect(orders[0]!.companyId).toBe('iv-appliance');
  });

  it('关闭 securities.ai.enabled 后不生成新的 AI 订单', () => {
    const world = newWorld();
    makeRich(world, 'lp-food');
    const config = configWithAi({ enabled: false });

    planInvestorOrders(world, config, world.time.tick);
    planCompanyOrders(world, config, world.time.tick);

    expect(world.securities.orders).toHaveLength(0);
  });

  it('撤单只移除订单，不改变现金与持股；非订单持有人不能撤单', () => {
    const world = newWorld();
    const company = world.companies.find((candidate) => candidate.id === 'lp-food')!;
    const shareClass = world.securities.classes.find(
      (candidate) => candidate.companyId === company.id && candidate.kind === 'voting',
    )!;
    const group = world.investors.find((candidate) => candidate.id === 'lanport-invest1')!;

    // 玩家买单：下单不冻结现金。
    const playerCash = world.player.cash;
    const playerHoldings = JSON.stringify(world.player.holdings ?? []);
    const playerOrder = placeOrder(world, {
      companyId: company.id,
      shareClassId: shareClass.id,
      side: 'buy',
      holder: { type: 'player', id: 'player' },
      shares: 10,
      limitPrice: 100,
      tick: world.time.tick,
    });
    expect(playerOrder.ok).toBe(true);
    expect(world.player.cash).toBe(playerCash);
    const cancelled = cancelOrder(world, playerOrder.orderId!, world.time.tick);
    expect(cancelled.ok).toBe(true);
    expect(world.securities.orders.some((order) => order.id === playerOrder.orderId)).toBe(false);
    expect(world.player.cash).toBe(playerCash);
    expect(JSON.stringify(world.player.holdings ?? [])).toBe(playerHoldings);

    // 居民实体卖单：默认调用方是玩家，不能撤别人的单；显式传持有人后才允许。
    const groupHolding = world.securities.holdings.find(
      (holding) => holding.shareClassId === shareClass.id && holding.holder.id === group.id,
    )!;
    const holdingsBefore = JSON.stringify(groupHolding);
    const groupOrder = placeOrder(world, {
      companyId: company.id,
      shareClassId: shareClass.id,
      side: 'sell',
      holder: groupHolder(group),
      shares: 100,
      limitPrice: 200,
      tick: world.time.tick,
    });
    expect(groupOrder.ok).toBe(true);
    const denied = cancelOrder(world, groupOrder.orderId!, world.time.tick);
    expect(denied.ok).toBe(false);
    expect(world.securities.orders.some((order) => order.id === groupOrder.orderId)).toBe(true);
    expect(JSON.stringify(groupHolding)).toBe(holdingsBefore);

    const allowed = cancelOrder(world, groupOrder.orderId!, world.time.tick, groupHolder(group));
    expect(allowed.ok).toBe(true);
    expect(world.securities.orders.some((order) => order.id === groupOrder.orderId)).toBe(false);
    expect(JSON.stringify(groupHolding)).toBe(holdingsBefore);

    // 不存在/已移除的订单撤单失败。
    expect(cancelOrder(world, 'order-does-not-exist', world.time.tick).ok).toBe(false);
  });

  it('相同种子与初始状态的 AI 计划完全一致（确定性，不使用 Math.random）', () => {
    const first = newWorld();
    const second = newWorld();
    makeRich(first, 'lp-food');
    makeRich(second, 'lp-food');

    planInvestorOrders(first, DEMO_CONFIG, 1);
    planCompanyOrders(first, DEMO_CONFIG, 1);
    planInvestorOrders(second, DEMO_CONFIG, 1);
    planCompanyOrders(second, DEMO_CONFIG, 1);

    expect(second.securities.orders).toEqual(first.securities.orders);
    // 订单 ID 也是确定的（同一 tick、同一生成顺序）。
    expect(second.securities.orders.map((order) => order.id)).toEqual(
      first.securities.orders.map((order) => order.id),
    );
  });

  it('现金低于 minCashToInvest 的投资实体不会生成买单，但可继续提供卖单', () => {
    const world = newWorld();
    const group = world.investors.find((candidate) => candidate.id === 'lanport-invest1')!;
    // 让该城市所有居民实体都低于买入门槛，避免其他实体干扰判断。
    for (const candidate of world.investors) {
      if (candidate.cityId === group.cityId) candidate.cash = 1_000;
    }

    planInvestorOrders(world, DEMO_CONFIG, world.time.tick);

    const buys = world.securities.orders.filter(
      (order) =>
        order.side === 'buy' &&
        order.holder.type === 'investorGroup' &&
        order.holder.id === group.id,
    );
    expect(buys).toHaveLength(0);
  });

  it('AI 生成的卖单限价与最新账面价挂钩（供玩家观察市场）', () => {
    const world = newWorld();
    planInvestorOrders(world, DEMO_CONFIG, world.time.tick);
    const sells = aiOrders(world, 'sell');
    expect(sells.length).toBeGreaterThan(0);
    // 卖单价格为正且有限；至少有一笔卖单高于当前账面价（流动性溢价 2%）。
    for (const order of sells) {
      expect(Number.isFinite(order.limitPrice)).toBe(true);
      expect(order.limitPrice).toBeGreaterThan(0);
    }
    // 每笔卖单价格 = 最新账面价 × 1.02（流动性溢价），与行情/财务口径一致。
    for (const order of sells) {
      const company = world.companies.find((candidate) => candidate.id === order.companyId)!;
      expect(order.limitPrice).toBeCloseTo(round2(bookPrice(world, company) * 1.02), 2);
    }
  });
});
