import { describe, expect, it } from 'vitest';
import { DEMO_CONFIG } from '../src/data/config';
import { createInitialWorld } from '../src/simulation/core/initializer';
import { matchOrders, placeOrder, tradeImmediately } from '../src/simulation/securities/securities';
import type { ShareKind, WorldState } from '../src/simulation/contracts/types';

function classId(world: WorldState, companyId: string, kind: ShareKind): string {
  const cls = world.securities.classes.find((entry) => entry.companyId === companyId && entry.kind === kind);
  if (!cls) throw new Error(`missing ${companyId}/${kind}`);
  return cls.id;
}

describe('股票委托编号唯一性（v0.8 回归）', () => {
  it('成交释放订单后同一 tick 再下单不会复用他人订单号', () => {
    const world = createInitialWorld(DEMO_CONFIG);
    const companyId = world.companies[0]!.id;
    const cls = classId(world, companyId, 'voting');
    const tick = world.time.tick;

    // 1) 有持股的主体先挂卖单（order 1）。
    const holding = world.securities.holdings.find(
      (entry) => entry.shareClassId === cls && entry.shares >= 10 && entry.holder.type !== 'player',
    );
    expect(holding).toBeDefined();
    const seller = holding!.holder;
    const sell = tradeImmediately(
      world,
      {
        companyId,
        shareClassId: cls,
        side: 'sell',
        holder: seller,
        shares: 10,
        limitPrice: 5,
        tick,
        note: '编号回归：AI 卖单',
      },
      DEMO_CONFIG,
    );
    expect(sell.ok).toBe(true);

    // 2) 买方吃单，成交后卖单被移除 → orders.length 回退。
    const buy = placeOrder(world, {
      companyId,
      shareClassId: cls,
      side: 'buy',
      holder: { type: 'player', id: 'player' },
      shares: 10,
      limitPrice: 5,
      tick,
    });
    expect(buy.ok).toBe(true);
    matchOrders(world, tick, DEMO_CONFIG);
    expect(world.securities.orders.some((order) => order.holder.type === 'player')).toBe(false);

    // 3) 玩家再挂一张同 tick/同企业/同方向的单：编号不得与历史订单冲突。
    const again = placeOrder(world, {
      companyId,
      shareClassId: cls,
      side: 'buy',
      holder: { type: 'player', id: 'player' },
      shares: 3,
      limitPrice: 1,
      tick,
    });
    expect(again.ok).toBe(true);
    const ids = world.securities.orders.map((order) => order.id);
    expect(new Set(ids).size).toBe(ids.length);
    const playerOrder = world.securities.orders.find((order) => order.holder.type === 'player');
    expect(playerOrder?.id).toBe(again.orderId);
  });

  it('连续同 tick 下单编号不重复', () => {
    const world = createInitialWorld(DEMO_CONFIG);
    const companyId = world.companies[0]!.id;
    const cls = classId(world, companyId, 'voting');
    const tick = world.time.tick;
    for (let i = 0; i < 5; i += 1) {
      const result = tradeImmediately(
        world,
        {
          companyId,
          shareClassId: cls,
          side: 'buy',
          holder: { type: 'player', id: 'player' },
          shares: 1,
          limitPrice: 0.01 + i * 0.01,
          tick,
          note: `编号回归 ${i}`,
        },
        DEMO_CONFIG,
      );
      expect(result.ok).toBe(true);
    }
    const ids = world.securities.orders.map((order) => order.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
