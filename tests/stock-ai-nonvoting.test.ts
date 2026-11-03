// v0.8.2 复验修复：仅分红股份的 AI 买入/卖出路径。
//
// 覆盖：居民投资实体对仅分红股份产生真实卖单与买单；买卖双方真实资金/持股转移；
// 只有一方或价格不匹配不成交；企业买方买仅分红被拒；两类股份行情独立；
// 存档往返不重复成交；同一持有人不对倒（无自成交）。

import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation/core/simulation';
import { DEMO_CONFIG } from '../src/data/config';
import type { WorldState } from '../src/simulation/contracts/types';
import {
  bookPrice,
  classById,
  matchOrders,
  placeOrder,
} from '../src/simulation/securities/securities';
import { stockHistoryFor } from '../src/simulation/securities/history';
import {
  groupHolder,
  planInvestorOrders,
} from '../src/simulation/investors/investors';
import { parseSave, serializeSave } from '../src/simulation/core/save';
import { round2 } from '../src/simulation/core/math';

function newWorld(tick = 1): WorldState {
  const world = Simulation.create().state;
  world.time.tick = tick;
  return world;
}

function classOf(world: WorldState, companyId: string, kind: 'voting' | 'nonVoting') {
  const shareClass = world.securities.classes.find(
    (candidate) => candidate.companyId === companyId && candidate.kind === kind,
  );
  if (!shareClass) throw new Error(`缺少 ${companyId} ${kind} 类别`);
  return shareClass;
}

function holdingOf(world: WorldState, shareClassIdValue: string, holderId: string) {
  return world.securities.holdings.find(
    (entry) =>
      entry.shareClassId === shareClassIdValue &&
      entry.holder.type === 'investorGroup' &&
      entry.holder.id === holderId,
  );
}

function aiSellOrders(world: WorldState) {
  return world.securities.orders.filter(
    (order) => order.side === 'sell' && order.holder.type === 'investorGroup',
  );
}

function aiBuyOrders(world: WorldState) {
  return world.securities.orders.filter(
    (order) => order.side === 'buy' && order.holder.type === 'investorGroup',
  );
}

describe('仅分红股份的 AI 交易（v0.8.2）', () => {
  it('居民投资实体对持有的仅分红股份自动挂出卖单，且不超过真实持仓', () => {
    const world = newWorld(2);
    planInvestorOrders(world, DEMO_CONFIG, world.time.tick);
    const sells = aiSellOrders(world);
    const nonVotingSells = sells.filter(
      (order) => classById(world, order.shareClassId)?.kind === 'nonVoting',
    );
    expect(nonVotingSells.length).toBeGreaterThan(0);
    expect(sells.some((order) => classById(world, order.shareClassId)?.kind === 'voting')).toBe(true);
    for (const order of nonVotingSells) {
      const holding = holdingOf(world, order.shareClassId, order.holder.id);
      expect(holding).toBeDefined();
      expect(order.shares).toBeGreaterThan(0);
      expect(order.shares).toBeLessThanOrEqual(holding!.shares);
    }
    // 每个实体挂出的买单金额不超过真实现金（不凭空透支）。
    for (const group of world.investors) {
      const buys = aiBuyOrders(world).filter((order) => order.holder.id === group.id);
      const cost = buys.reduce((sum, order) => sum + order.shares * order.limitPrice, 0);
      expect(cost).toBeLessThanOrEqual(group.cash + 0.01);
    }
  });

  it('居民投资实体对仅分红股份形成买入意愿（不是只在接近投票权上限时才考虑）', () => {
    const world = newWorld(2);
    for (const group of world.investors) group.cash = 50_000_000;
    const seen = new Set<string>();
    for (let tick = 2; tick <= 8; tick++) {
      world.time.tick = tick;
      // 清空上月未成交订单，只看每月新生成的计划。
      world.securities.orders = [];
      planInvestorOrders(world, DEMO_CONFIG, tick);
      for (const order of aiBuyOrders(world)) {
        if (classById(world, order.shareClassId)?.kind === 'nonVoting') {
          seen.add(order.holder.id);
        }
      }
    }
    expect(seen.size).toBeGreaterThan(0);
  });

  it('价格匹配时居民卖方与买方产生真实成交：现金、股份与 K 线一致', () => {
    const world = newWorld(2);
    const company = world.companies.find((candidate) => candidate.id === 'lp-food')!;
    const shareClass = classOf(world, company.id, 'nonVoting');
    const cityGroups = world.investors.filter((group) => group.cityId === company.cityId);
    const seller = cityGroups[0]!;
    const buyer = cityGroups[1]!;
    const sellerHolding = holdingOf(world, shareClass.id, seller.id)!;
    const sellerSharesBefore = sellerHolding.shares;
    const shares = Math.min(1_000, Math.floor(sellerSharesBefore / 2));
    expect(shares).toBeGreaterThan(0);
    const price = Math.max(1, round2(bookPrice(world, company) * 0.99));
    buyer.cash = 50_000_000;
    const buyerCashBefore = buyer.cash;
    const sellerCashBefore = seller.cash;
    const buyerSharesBefore = holdingOf(world, shareClass.id, buyer.id)?.shares ?? 0;
    const candlesBefore = stockHistoryFor(world, shareClass.id)?.candles.length ?? 0;

    const sell = placeOrder(world, {
      companyId: company.id,
      shareClassId: shareClass.id,
      side: 'sell',
      holder: groupHolder(seller),
      shares,
      limitPrice: price,
      tick: 2,
      note: 'test sell',
    });
    const buy = placeOrder(world, {
      companyId: company.id,
      shareClassId: shareClass.id,
      side: 'buy',
      holder: groupHolder(buyer),
      shares,
      limitPrice: round2(price * 1.01),
      tick: 2,
      note: 'test buy',
    });
    expect(sell.ok).toBe(true);
    expect(buy.ok).toBe(true);
    const trades = matchOrders(world, 2, DEMO_CONFIG);
    const trade = trades.find((entry) => entry.shareClassId === shareClass.id);
    expect(trade).toBeDefined();
    expect(trade!.shares).toBe(shares);
    expect(trade!.unitPrice).toBe(price);
    // 真实现金转移：买方现金减少，卖方现金增加。
    expect(buyer.cash).toBeCloseTo(round2(buyerCashBefore - shares * price), 2);
    expect(seller.cash).toBeCloseTo(round2(sellerCashBefore + shares * price), 2);
    // 股份正确转移。
    expect(holdingOf(world, shareClass.id, buyer.id)!.shares).toBeCloseTo(buyerSharesBefore + shares, 2);
    expect(holdingOf(world, shareClass.id, seller.id)!.shares).toBeCloseTo(sellerSharesBefore - shares, 2);
    // K 线来自实际成交（仅分红类别，成交量=成交股数）。
    const history = stockHistoryFor(world, shareClass.id)!;
    expect(history.candles.length).toBe(candlesBefore + 1);
    const candle = history.candles[history.candles.length - 1]!;
    expect(candle.tick).toBe(2);
    expect(candle.volume).toBe(shares);
    expect(candle.close).toBe(price);
  });

  it('只有一方或价格不匹配时不成交', () => {
    const world = newWorld(2);
    const company = world.companies.find((candidate) => candidate.id === 'lp-food')!;
    const shareClass = classOf(world, company.id, 'nonVoting');
    const seller = world.investors.find((group) => group.cityId === company.cityId)!;
    const holding = holdingOf(world, shareClass.id, seller.id)!;
    const shares = Math.min(500, Math.floor(holding.shares / 2));
    const price = Math.max(1, round2(bookPrice(world, company) * 0.99));
    // 只有卖单。
    placeOrder(world, {
      companyId: company.id,
      shareClassId: shareClass.id,
      side: 'sell',
      holder: groupHolder(seller),
      shares,
      limitPrice: price,
      tick: 2,
    });
    expect(matchOrders(world, 2, DEMO_CONFIG)).toHaveLength(0);
    // 价格不匹配：买方限价低于卖方限价。
    const buyer = world.investors.find(
      (group) => group.cityId === company.cityId && group.id !== seller.id,
    )!;
    buyer.cash = 10_000_000;
    placeOrder(world, {
      companyId: company.id,
      shareClassId: shareClass.id,
      side: 'buy',
      holder: groupHolder(buyer),
      shares,
      limitPrice: round2(price * 0.98),
      tick: 2,
    });
    expect(matchOrders(world, 2, DEMO_CONFIG)).toHaveLength(0);
    // 买方现金与卖方持股保持不变。
    expect(buyer.cash).toBe(10_000_000);
    expect(holdingOf(world, shareClass.id, seller.id)!.shares).toBeCloseTo(holding.shares, 2);
  });

  it('企业作为买方购买仅分红股份仍被拒绝', () => {
    const world = newWorld(2);
    const target = world.companies.find((candidate) => candidate.id === 'lp-food')!;
    const buyerCompany = world.companies.find(
      (candidate) => candidate.id !== target.id,
    )!;
    const shareClass = classOf(world, target.id, 'nonVoting');
    const result = placeOrder(world, {
      companyId: target.id,
      shareClassId: shareClass.id,
      side: 'buy',
      holder: { type: 'company', id: buyerCompany.id },
      shares: 100,
      limitPrice: 1,
      tick: 2,
    });
    expect(result.ok).toBe(false);
    expect(result.error ?? '').toContain('只能买入有投票权股份');
  });

  it('两类股份行情互不混淆，存档往返后不重复成交', () => {
    const world = newWorld(2);
    const company = world.companies.find((candidate) => candidate.id === 'lp-food')!;
    const voting = classOf(world, company.id, 'voting');
    const nonVoting = classOf(world, company.id, 'nonVoting');
    const groups = world.investors.filter((group) => group.cityId === company.cityId);
    const seller = groups[0]!;
    const buyer = groups[1]!;
    buyer.cash = 50_000_000;
    const price = Math.max(1, round2(bookPrice(world, company) * 0.99));
    const votes = Math.min(100, Math.floor((holdingOf(world, voting.id, seller.id)?.shares ?? 0) / 10));
    placeOrder(world, {
      companyId: company.id,
      shareClassId: voting.id,
      side: 'sell',
      holder: groupHolder(seller),
      shares: votes,
      limitPrice: price,
      tick: 2,
    });
    placeOrder(world, {
      companyId: company.id,
      shareClassId: voting.id,
      side: 'buy',
      holder: groupHolder(buyer),
      shares: votes,
      limitPrice: price,
      tick: 2,
    });
    const nonVotes = Math.min(100, Math.floor((holdingOf(world, nonVoting.id, seller.id)?.shares ?? 0) / 10));
    placeOrder(world, {
      companyId: company.id,
      shareClassId: nonVoting.id,
      side: 'sell',
      holder: groupHolder(seller),
      shares: nonVotes,
      limitPrice: price,
      tick: 2,
    });
    placeOrder(world, {
      companyId: company.id,
      shareClassId: nonVoting.id,
      side: 'buy',
      holder: groupHolder(buyer),
      shares: nonVotes,
      limitPrice: price,
      tick: 2,
    });
    const trades = matchOrders(world, 2, DEMO_CONFIG);
    expect(trades.length).toBe(2);
    expect(trades.filter((trade) => trade.shareClassId === voting.id)).toHaveLength(1);
    expect(trades.filter((trade) => trade.shareClassId === nonVoting.id)).toHaveLength(1);
    // 两类 K 线各自独立。
    const votingCandles = stockHistoryFor(world, voting.id)!.candles;
    const nonVotingCandles = stockHistoryFor(world, nonVoting.id)!.candles;
    expect(votingCandles).toHaveLength(1);
    expect(nonVotingCandles).toHaveLength(1);
    expect(votingCandles[0]!.volume).toBe(votes);
    expect(nonVotingCandles[0]!.volume).toBe(nonVotes);

    // 存档往返：订单已成交并消耗，重新撮合不产生重复成交。
    const restored = parseSave(serializeSave(world));
    expect(restored.ok).toBe(true);
    if (!restored.ok || !restored.world) return;
    const again = matchOrders(restored.world, 2, DEMO_CONFIG);
    expect(again).toHaveLength(0);
    expect(stockHistoryFor(restored.world, nonVoting.id)!.candles).toHaveLength(1);
  });

  it('同一居民实体不会与自己成交', () => {
    const world = newWorld(2);
    const company = world.companies.find((candidate) => candidate.id === 'lp-food')!;
    const shareClass = classOf(world, company.id, 'nonVoting');
    const holder = world.investors.find((group) => group.cityId === company.cityId)!;
    const holding = holdingOf(world, shareClass.id, holder.id)!;
    const shares = Math.min(100, Math.floor(holding.shares / 10));
    holder.cash = 10_000_000;
    expect(shares).toBeGreaterThan(0);
    placeOrder(world, {
      companyId: company.id,
      shareClassId: shareClass.id,
      side: 'sell',
      holder: groupHolder(holder),
      shares,
      limitPrice: 1,
      tick: 2,
    });
    placeOrder(world, {
      companyId: company.id,
      shareClassId: shareClass.id,
      side: 'buy',
      holder: groupHolder(holder),
      shares,
      limitPrice: 2,
      tick: 2,
    });
    expect(matchOrders(world, 2, DEMO_CONFIG)).toHaveLength(0);
  });
});
