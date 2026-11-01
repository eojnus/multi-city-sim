import type { City, FiscalEntry, PolicyId, WorldState } from '../contracts/types';
import { round2 } from '../core/math';

/**
 * 财政流水权威：所有政策、交通与税收相关资金变化都必须经过这里，
 * 以便每项收入/支出都有来源记录。财政余额仍存放在 city.treasury。
 *
 * 演示规则：支出不得超过当前可用财政余额；不足时按可用金额支付，
 * 不通过“负财政余额”凭空创造资金（公共部门工资的赤字由 fiscal.ts 另行处理）。
 */
export function recordFiscal(
  world: WorldState,
  entry: Omit<FiscalEntry, 'id'>,
  config?: { policies?: { ledgerLimit: number } },
): FiscalEntry {
  if (!world.fiscal) {
    world.fiscal = { ledger: [], nextEntryId: 1 };
  }
  const record: FiscalEntry = { id: `fiscal-${world.fiscal.nextEntryId}`, ...entry };
  world.fiscal.nextEntryId += 1;
  world.fiscal.ledger.push(record);
  const limit = config?.policies?.ledgerLimit ?? 800;
  if (world.fiscal.ledger.length > limit) {
    world.fiscal.ledger.splice(0, world.fiscal.ledger.length - limit);
  }
  return record;
}

/** 从城市财政支出；返回实际支付额（可能小于请求额）。 */
export function spendTreasury(
  world: WorldState,
  city: City,
  requested: number,
  kind: FiscalEntry['kind'],
  source: string,
  extra: { policyId?: PolicyId; companyId?: string } = {},
  config?: { policies?: { ledgerLimit: number } },
): number {
  const available = Math.max(0, city.treasury);
  const amount = round2(Math.min(Math.max(0, requested), available));
  if (amount <= 0) return 0;
  city.treasury = round2(city.treasury - amount);
  recordFiscal(
    world,
    {
      tick: world.time.tick,
      cityId: city.id,
      kind,
      amount: -amount,
      source,
      ...extra,
    },
    config,
  );
  return amount;
}

/** 城市财政收入；返回入账金额。 */
export function receiveTreasury(
  world: WorldState,
  city: City,
  amount: number,
  kind: FiscalEntry['kind'],
  source: string,
  extra: { policyId?: PolicyId; companyId?: string } = {},
  config?: { policies?: { ledgerLimit: number } },
): number {
  const value = round2(Math.max(0, amount));
  if (value <= 0) return 0;
  city.treasury = round2(city.treasury + value);
  recordFiscal(
    world,
    {
      tick: world.time.tick,
      cityId: city.id,
      kind,
      amount: value,
      source,
      ...extra,
    },
    config,
  );
  return value;
}

/** 财政可承受的预算上限：不低于 0，且不超过当前余额。 */
export function affordableBudget(city: City, requested: number): number {
  return round2(Math.min(Math.max(0, requested), Math.max(0, city.treasury)));
}
