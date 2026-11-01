import type { City, WorldState } from '../contracts/types';
import type { DemoConfig } from '../../data/config';
import { round2 } from '../core/math';
import { receiveTreasury } from '../government/treasury';

/**
 * 玩家向城市财政转账（例如参选费用）。资金守恒：玩家现金减少的金额
 * 与财政入账金额相同，不凭空生成或销毁资金。
 */
export function transmitPlayerCash(
  world: WorldState,
  city: City,
  amount: number,
  source: string,
  config?: DemoConfig,
): number {
  const paid = round2(Math.min(Math.max(0, amount), Math.max(0, world.player.cash)));
  if (paid <= 0) return 0;
  world.player.cash = round2(world.player.cash - paid);
  receiveTreasury(world, city, paid, 'electionFee', source, {}, config);
  return paid;
}
