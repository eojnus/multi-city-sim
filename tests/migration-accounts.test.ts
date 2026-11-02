// 跨城迁移账户守恒（v0.4 验收问题 7）：
// - 迁移前确保目标群体存款账户存在（旧存档可能没有账户），否则不得扣减源城市；
// - 存款/现金以同一金额原子转移，守恒（不复制、不丢失）；
// - 按 laborForceMoved 拆分为 unemployed 与 nonLabor 两个群体，分别按人均资产转移；
// - syncHouseholdPeople 等同类人数变动路径也不得因账户缺失而静默销毁资金。
import { describe, expect, it } from 'vitest';
import { createInitialWorld } from '../src/simulation/core/initializer';
import { DEMO_CONFIG } from '../src/data/config';
import type { DemoConfig } from '../src/data/config';
import type {
  HouseholdGroup,
  LogEntry,
  OccupationClass,
  WorldState,
} from '../src/simulation/contracts/types';
import { DeterministicRng } from '../src/simulation/core/rng';
import {
  applyMigration,
  migrationAttractiveness,
} from '../src/simulation/population/population';
import {
  householdGroupOf,
  rebalanceHouseholdWealthForMigration,
  syncHouseholdPeople,
} from '../src/simulation/population/household-groups';
import { depositAccountFor } from '../src/simulation/banking/banking';

const TOLERANCE = 0.05;
const SOURCE_CITY = 'lanport';
const DEST_CITY = 'greenfield';

function groupOf(
  world: WorldState,
  cityId: string,
  occupation: OccupationClass,
): HouseholdGroup {
  const group = householdGroupOf(world, cityId, occupation);
  if (!group) throw new Error(`缺少群体 ${cityId}/${occupation}`);
  return group;
}

function groupDepositOf(world: WorldState, groupId: string): number {
  return depositAccountFor(world, { kind: 'household', id: groupId })?.balance ?? 0;
}

function totalGroupCash(world: WorldState): number {
  return world.households.groups.reduce((total, group) => total + group.cash, 0);
}

function totalDeposits(world: WorldState): number {
  return world.banking.deposits.reduce((total, account) => total + account.balance, 0);
}

/** 模拟旧存档：某城居民群体还没有存款账户。 */
function removeCityHouseholdAccounts(world: WorldState, cityId: string): void {
  world.banking.deposits = world.banking.deposits.filter(
    (account) =>
      !(
        account.owner.kind === 'household' &&
        account.owner.id.startsWith(`${cityId}-hh-`)
      ),
  );
}

function removeGroupAccount(world: WorldState, groupId: string): void {
  world.banking.deposits = world.banking.deposits.filter(
    (account) => !(account.owner.kind === 'household' && account.owner.id === groupId),
  );
}

function expectAmount(actual: number, expected: number, tolerance = TOLERANCE): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance);
}

describe('跨城迁移：目标账户不存在时自动开户并守恒', () => {
  it('旧档目标城无账户：迁移前开户，现金/存款按两类群体人均转移且总量守恒', () => {
    const world = createInitialWorld();
    removeCityHouseholdAccounts(world, DEST_CITY);
    const sourceUnemployed = groupOf(world, SOURCE_CITY, 'unemployed');
    const sourceNonLabor = groupOf(world, SOURCE_CITY, 'nonLabor');
    const destUnemployed = groupOf(world, DEST_CITY, 'unemployed');
    const destNonLabor = groupOf(world, DEST_CITY, 'nonLabor');

    const before = {
      totalCash: totalGroupCash(world),
      totalDeposits: totalDeposits(world),
      sourceUnemployedCash: sourceUnemployed.cash,
      sourceNonLaborCash: sourceNonLabor.cash,
      destUnemployedCash: destUnemployed.cash,
      destNonLaborCash: destNonLabor.cash,
      sourceUnemployedDeposit: groupDepositOf(world, sourceUnemployed.id),
      sourceNonLaborDeposit: groupDepositOf(world, sourceNonLabor.id),
    };
    // 旧档：目标城账户确实不存在。
    expect(depositAccountFor(world, { kind: 'household', id: destUnemployed.id })).toBeUndefined();
    expect(depositAccountFor(world, { kind: 'household', id: destNonLabor.id })).toBeUndefined();

    // 1000 人中 620 劳动力 → unemployed 620 人、nonLabor 380 人。
    const result = rebalanceHouseholdWealthForMigration(
      world,
      SOURCE_CITY,
      DEST_CITY,
      1000,
      620,
      DEMO_CONFIG,
      world.time.tick,
    );

    // 岚港人均：unemployed 现金 540 / 存款 660；nonLabor 现金 135 / 存款 165。
    expect(result.transferred).toBe(1000);
    expectAmount(result.cashMoved, 620 * 540 + 380 * 135);
    expectAmount(result.depositMoved, 620 * 660 + 380 * 165);

    // 源城扣减 = 目标城增加：两类群体分别按各自人均资产转移。
    expectAmount(sourceUnemployed.cash, before.sourceUnemployedCash - 620 * 540);
    expectAmount(sourceNonLabor.cash, before.sourceNonLaborCash - 380 * 135);
    expectAmount(destUnemployed.cash, before.destUnemployedCash + 620 * 540);
    expectAmount(destNonLabor.cash, before.destNonLaborCash + 380 * 135);
    expectAmount(groupDepositOf(world, sourceUnemployed.id), before.sourceUnemployedDeposit - 620 * 660);
    expectAmount(groupDepositOf(world, sourceNonLabor.id), before.sourceNonLaborDeposit - 380 * 165);
    // 目标账户被自动创建并收到存款（旧实现会静默丢掉这部分存款）。
    expectAmount(groupDepositOf(world, destUnemployed.id), 620 * 660);
    expectAmount(groupDepositOf(world, destNonLabor.id), 380 * 165);

    // 全局守恒。
    expectAmount(totalGroupCash(world), before.totalCash);
    expectAmount(totalDeposits(world), before.totalDeposits);
  });

  it('只按 laborForceMoved 拆分：0 时只动 nonLabor，=people 时只动 unemployed', () => {
    const nonLaborOnly = createInitialWorld();
    const sourceUnemployed = groupOf(nonLaborOnly, SOURCE_CITY, 'unemployed');
    const sourceNonLabor = groupOf(nonLaborOnly, SOURCE_CITY, 'nonLabor');
    const unemployedCashBefore = sourceUnemployed.cash;
    const unemployedDepositBefore = groupDepositOf(nonLaborOnly, sourceUnemployed.id);
    const nonLaborCashBefore = sourceNonLabor.cash;
    const nonLaborDepositBefore = groupDepositOf(nonLaborOnly, sourceNonLabor.id);

    const nonLaborResult = rebalanceHouseholdWealthForMigration(
      nonLaborOnly,
      SOURCE_CITY,
      DEST_CITY,
      100,
      0,
      DEMO_CONFIG,
      nonLaborOnly.time.tick,
    );
    expect(nonLaborResult.transferred).toBe(100);
    expectAmount(nonLaborResult.cashMoved, 100 * 135);
    expectAmount(nonLaborResult.depositMoved, 100 * 165);
    expectAmount(sourceUnemployed.cash, unemployedCashBefore);
    expectAmount(groupDepositOf(nonLaborOnly, sourceUnemployed.id), unemployedDepositBefore);
    expectAmount(sourceNonLabor.cash, nonLaborCashBefore - 100 * 135);
    expectAmount(
      groupDepositOf(nonLaborOnly, sourceNonLabor.id),
      nonLaborDepositBefore - 100 * 165,
    );

    const laborOnly = createInitialWorld();
    const laborUnemployed = groupOf(laborOnly, SOURCE_CITY, 'unemployed');
    const laborNonLabor = groupOf(laborOnly, SOURCE_CITY, 'nonLabor');
    const nonLaborCashBefore2 = laborNonLabor.cash;
    const laborResult = rebalanceHouseholdWealthForMigration(
      laborOnly,
      SOURCE_CITY,
      DEST_CITY,
      100,
      100,
      DEMO_CONFIG,
      laborOnly.time.tick,
    );
    expect(laborResult.transferred).toBe(100);
    expectAmount(laborResult.cashMoved, 100 * 540);
    expectAmount(laborResult.depositMoved, 100 * 660);
    expectAmount(laborNonLabor.cash, nonLaborCashBefore2);
  });

  it('人数超过源群体人数时按实际人数夹取，不产生负资产', () => {
    const world = createInitialWorld();
    const sourceUnemployed = groupOf(world, SOURCE_CITY, 'unemployed');
    const before = {
      cash: sourceUnemployed.cash,
      deposit: groupDepositOf(world, sourceUnemployed.id),
    };
    const result = rebalanceHouseholdWealthForMigration(
      world,
      SOURCE_CITY,
      DEST_CITY,
      sourceUnemployed.people + 10_000,
      sourceUnemployed.people + 10_000,
      DEMO_CONFIG,
      world.time.tick,
    );
    expect(result.transferred).toBe(sourceUnemployed.people);
    expect(sourceUnemployed.cash).toBeGreaterThanOrEqual(0);
    expectAmount(sourceUnemployed.cash, 0);
    expect(groupDepositOf(world, sourceUnemployed.id)).toBeGreaterThanOrEqual(0);
    expectAmount(groupDepositOf(world, sourceUnemployed.id), 0);
    expect(before.cash).toBeGreaterThan(0);
    expect(before.deposit).toBeGreaterThan(0);
  });
});

describe('跨城迁移：失败回滚（目标账户无法创建时源不扣款）', () => {
  it('开户失败则整体放弃，现金/存款分文不动，并返回零值', () => {
    const world = createInitialWorld();
    removeCityHouseholdAccounts(world, DEST_CITY);
    const before = {
      totalCash: totalGroupCash(world),
      totalDeposits: totalDeposits(world),
      sourceUnemployedCash: groupOf(world, SOURCE_CITY, 'unemployed').cash,
      sourceUnemployedDeposit: groupDepositOf(
        world,
        groupOf(world, SOURCE_CITY, 'unemployed').id,
      ),
      destUnemployedCash: groupOf(world, DEST_CITY, 'unemployed').cash,
      destNonLaborCash: groupOf(world, DEST_CITY, 'nonLabor').cash,
    };
    // 让 banking 配置缺失，ensureDepositAccount 创建账户时抛错。
    const brokenConfig = {
      ...DEMO_CONFIG,
      banking: null as unknown as DemoConfig['banking'],
    };

    const result = rebalanceHouseholdWealthForMigration(
      world,
      SOURCE_CITY,
      DEST_CITY,
      1000,
      620,
      brokenConfig,
      world.time.tick,
    );

    expect(result).toEqual({ cashMoved: 0, depositMoved: 0, transferred: 0 });
    expectAmount(groupOf(world, SOURCE_CITY, 'unemployed').cash, before.sourceUnemployedCash);
    expectAmount(
      groupDepositOf(world, groupOf(world, SOURCE_CITY, 'unemployed').id),
      before.sourceUnemployedDeposit,
    );
    expectAmount(groupOf(world, DEST_CITY, 'unemployed').cash, before.destUnemployedCash);
    expectAmount(groupOf(world, DEST_CITY, 'nonLabor').cash, before.destNonLaborCash);
    expectAmount(totalGroupCash(world), before.totalCash);
    expectAmount(totalDeposits(world), before.totalDeposits);
    // 失败后仍未开户，且不存在“扣了源、目标没收到”的中间态。
    expect(
      depositAccountFor(world, {
        kind: 'household',
        id: groupOf(world, DEST_CITY, 'unemployed').id,
      }),
    ).toBeUndefined();
  });

  it('不传 config（无法开户）时，目标无账户则放弃本次资产转移', () => {
    const world = createInitialWorld();
    removeCityHouseholdAccounts(world, DEST_CITY);
    const source = groupOf(world, SOURCE_CITY, 'unemployed');
    const before = { cash: source.cash, deposit: groupDepositOf(world, source.id) };

    const result = rebalanceHouseholdWealthForMigration(world, SOURCE_CITY, DEST_CITY, 1000, 620);

    expect(result).toEqual({ cashMoved: 0, depositMoved: 0, transferred: 0 });
    expectAmount(source.cash, before.cash);
    expectAmount(groupDepositOf(world, source.id), before.deposit);
  });
});

describe('applyMigration 集成：旧档目标城无账户也不丢存款', () => {
  it('迁移前后全球居民现金与存款守恒，且迁入城被自动开户', () => {
    const world = createInitialWorld();
    const ranked = [...world.cities].sort(
      (a, b) =>
        migrationAttractiveness(b, world, DEMO_CONFIG) -
          migrationAttractiveness(a, world, DEMO_CONFIG) || a.id.localeCompare(b.id),
    );
    const destination = ranked[0]!;
    // 制造岗位空缺，满足迁移门槛。
    destination.publicSector.jobs =
      destination.publicSector.employees +
      Math.max(100, DEMO_CONFIG.population.migrationMinVacancies * 2);
    // 模拟旧存档：目的地居民群体没有存款账户。
    removeCityHouseholdAccounts(world, destination.id);

    const before = {
      totalCash: totalGroupCash(world),
      totalDeposits: totalDeposits(world),
    };
    const logs: LogEntry[] = [];
    applyMigration(world, new DeterministicRng(7), DEMO_CONFIG, logs);
    const moves = world.lastTick.migration;
    expect(moves.length).toBeGreaterThan(0);
    expect(moves.some((move) => move.toCityId === destination.id)).toBe(true);

    syncHouseholdPeople(world, DEMO_CONFIG);

    // 守恒：不复制、不丢失（旧实现在此会丢掉迁入者的人均存款）。
    expectAmount(totalGroupCash(world), before.totalCash);
    expectAmount(totalDeposits(world), before.totalDeposits);

    // 迁入城的对应群体账户被自动创建（有存款转入时）。
    const inbound = moves.filter((move) => move.toCityId === destination.id);
    const laborInbound = inbound.reduce((total, move) => total + move.laborForce, 0);
    const nonLaborInbound = inbound.reduce(
      (total, move) => total + (move.people - move.laborForce),
      0,
    );
    if (laborInbound > 0) {
      const group = groupOf(world, destination.id, 'unemployed');
      expect(depositAccountFor(world, { kind: 'household', id: group.id })).toBeTruthy();
      expect(groupDepositOf(world, group.id)).toBeGreaterThan(0);
    }
    if (nonLaborInbound > 0) {
      const group = groupOf(world, destination.id, 'nonLabor');
      expect(depositAccountFor(world, { kind: 'household', id: group.id })).toBeTruthy();
      expect(groupDepositOf(world, group.id)).toBeGreaterThan(0);
    }
  });
});

describe('syncHouseholdPeople：账户缺失不得静默销毁资金', () => {
  it('接收群体账户缺失（旧存档）时自动开户，城市内存款转移守恒', () => {
    const world = createInitialWorld();
    const city = world.cities.find((candidate) => candidate.id === 'lanport')!;
    const publicSector = groupOf(world, 'lanport', 'publicSector');
    const nonLabor = groupOf(world, 'lanport', 'nonLabor');
    // 旧存档：公共部门群体没有存款账户。
    removeGroupAccount(world, publicSector.id);

    const before = {
      totalCash: totalGroupCash(world),
      totalDeposits: totalDeposits(world),
      nonLaborCash: nonLabor.cash,
      nonLaborDeposit: groupDepositOf(world, nonLabor.id),
      publicSectorCash: publicSector.cash,
    };
    // 城市总人口不变，公共部门就业 +1000（nonLabor 相应 -1000）：
    // 1000 人从 nonLabor 转入 publicSector，应按人均转移现金与存款。
    city.publicSector.employees += 1000;

    syncHouseholdPeople(world, DEMO_CONFIG);

    expect(publicSector.people).toBeGreaterThan(0);
    // 存款：nonLabor 扣减 = publicSector 收到（自动开户），总量守恒。
    expect(
      depositAccountFor(world, { kind: 'household', id: publicSector.id }),
    ).toBeTruthy();
    expect(groupDepositOf(world, publicSector.id)).toBeGreaterThan(0);
    expectAmount(groupDepositOf(world, nonLabor.id), before.nonLaborDeposit - groupDepositOf(world, publicSector.id));
    expectAmount(totalGroupCash(world), before.totalCash);
    expectAmount(totalDeposits(world), before.totalDeposits);
    expectAmount(publicSector.cash, before.publicSectorCash + (before.nonLaborCash - nonLabor.cash));
  });
});
