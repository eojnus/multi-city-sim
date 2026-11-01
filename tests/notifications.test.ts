import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation/core/simulation';
import { DEMO_CONFIG } from '../src/data/config';
import {
  markAllNotificationsRead,
  markNotificationRead,
  notificationVisible,
  notifyPlayer,
  playerControlsCompany,
  playerStakeOf,
  playerVotingSharesOf,
  unreadNotificationCount,
  visibleNotifications,
} from '../src/simulation/notifications/notifications';
import type { PlayerNoticeInput } from '../src/simulation/notifications/notifications';
import { openDividendPolicyMotion } from '../src/simulation/corporate-governance/governance';
import { groupsOfCity, groupHolder } from '../src/simulation/investors/investors';
import type { ShareKind, WorldState } from '../src/simulation/contracts/types';

/** 新建世界，并兼容尚未初始化 v0.2 数据节的旧 initializer。 */
function freshWorld(): WorldState {
  const world = Simulation.create().state;
  if (!world.securities) {
    world.securities = { classes: [], holdings: [], orders: [], lastTrades: [], offers: [] };
  }
  if (!world.notifications) world.notifications = [];
  if (!world.governance) world.governance = { boards: [], motions: [], controls: [] };
  if (!world.player.roles) world.player.roles = { mayorCityId: null };
  return world;
}

/** 清空某企业的股份夹具，确保 totalShares 与测试构造的类别一致。 */
function resetCompanyShares(world: WorldState, companyId: string): void {
  world.securities.classes = world.securities.classes.filter(
    (shareClass) => shareClass.companyId !== companyId,
  );
  world.securities.holdings = world.securities.holdings.filter(
    (holding) => holding.companyId !== companyId,
  );
  const company = world.companies.find((candidate) => candidate.id === companyId);
  if (company) company.totalShares = 0;
}

function addShareClass(
  world: WorldState,
  companyId: string,
  kind: ShareKind,
  issuedShares: number,
): void {
  world.securities.classes.push({
    id: `${companyId}:${kind}`,
    companyId,
    kind,
    issuedShares,
    note: '测试股份类别',
  });
  const company = world.companies.find((candidate) => candidate.id === companyId);
  if (company) {
    company.totalShares = world.securities.classes
      .filter((shareClass) => shareClass.companyId === companyId)
      .reduce((total, shareClass) => total + shareClass.issuedShares, 0);
  }
}

function addPlayerHolding(
  world: WorldState,
  companyId: string,
  kind: ShareKind,
  shares: number,
): void {
  world.securities.holdings.push({
    companyId,
    shareClassId: `${companyId}:${kind}`,
    holder: { type: 'player', id: 'player' },
    shares,
    acquiredVia: 'migration',
    sinceTick: 0,
  });
}

function notice(overrides: Partial<PlayerNoticeInput>): PlayerNoticeInput {
  return {
    audience: 'personal',
    kind: 'dividend',
    title: '测试通知',
    body: '测试内容',
    ...overrides,
  };
}

describe('玩家通知的身份筛选', () => {
  it('只有无投票权股份时，表决通知被丢弃', () => {
    const world = freshWorld();
    const company = world.companies[0]!;
    resetCompanyShares(world, company.id);
    addShareClass(world, company.id, 'nonVoting', 1_000);
    addPlayerHolding(world, company.id, 'nonVoting', 200);

    const input = notice({
      audience: 'company',
      kind: 'vote',
      companyId: company.id,
      title: '股东大会表决',
      body: '请对股息政策议案投票。',
    });

    expect(playerStakeOf(world, company.id)).toBeCloseTo(0.2, 10);
    expect(playerVotingSharesOf(world, company.id)).toBe(0);
    expect(notificationVisible(world, DEMO_CONFIG, input)).toBe(false);
    expect(notifyPlayer(world, DEMO_CONFIG, input)).toBeNull();
    expect(world.notifications).toHaveLength(0);
  });

  it('持有投票权股份时，表决通知可见', () => {
    const world = freshWorld();
    const company = world.companies[0]!;
    resetCompanyShares(world, company.id);
    addShareClass(world, company.id, 'nonVoting', 1_000);
    addShareClass(world, company.id, 'voting', 1_000);
    addPlayerHolding(world, company.id, 'nonVoting', 200);
    addPlayerHolding(world, company.id, 'voting', 1);

    const input = notice({
      audience: 'company',
      kind: 'vote',
      companyId: company.id,
      title: '股东大会表决',
      body: '请对股息政策议案投票。',
    });

    expect(playerVotingSharesOf(world, company.id)).toBe(1);
    expect(notificationVisible(world, DEMO_CONFIG, input)).toBe(true);
    expect(notifyPlayer(world, DEMO_CONFIG, input)).not.toBeNull();
  });

  it('低于 5% 阈值时仍会收到重大变化，但日常经营信息被过滤', () => {
    const world = freshWorld();
    const company = world.companies[0]!;
    resetCompanyShares(world, company.id);
    addShareClass(world, company.id, 'voting', 95);
    addShareClass(world, company.id, 'nonVoting', 5);
    addPlayerHolding(world, company.id, 'voting', 1);

    expect(playerStakeOf(world, company.id)).toBeCloseTo(0.01, 10);

    const major = notice({
      audience: 'company',
      kind: 'major',
      companyId: company.id,
      title: '董事会改选',
      body: '公司完成董事会改选。',
    });
    expect(notificationVisible(world, DEMO_CONFIG, major)).toBe(true);
    expect(notifyPlayer(world, DEMO_CONFIG, major)).not.toBeNull();

    const market = notice({
      audience: 'company',
      kind: 'market',
      companyId: company.id,
      title: '日常融资方案',
      body: '公司发布新的融资方案。',
    });
    expect(notificationVisible(world, DEMO_CONFIG, market)).toBe(false);

    const dividend = notice({
      audience: 'company',
      kind: 'dividend',
      companyId: company.id,
      title: '收到股息',
      body: '你收到该公司派发的股息。',
    });
    expect(notificationVisible(world, DEMO_CONFIG, dividend)).toBe(true);
    expect(notifyPlayer(world, DEMO_CONFIG, dividend)).not.toBeNull();
    expect(world.notifications).toHaveLength(2);
  });

  it('持股达到阈值后，重大变化通知可见', () => {
    const world = freshWorld();
    const company = world.companies[0]!;
    resetCompanyShares(world, company.id);
    addShareClass(world, company.id, 'voting', 95);
    addShareClass(world, company.id, 'nonVoting', 5);
    addPlayerHolding(world, company.id, 'voting', 5);

    expect(playerStakeOf(world, company.id)).toBeCloseTo(DEMO_CONFIG.notifications.majorStakeThreshold, 10);

    const major = notice({
      audience: 'company',
      kind: 'major',
      companyId: company.id,
      title: '董事会改选',
      body: '公司完成董事会改选。',
    });
    expect(notificationVisible(world, DEMO_CONFIG, major)).toBe(true);
  });

  it('少量仅分红股东会收到重大变化通知，但不会收到表决通知', () => {
    const world = freshWorld();
    const company = world.companies[0]!;
    resetCompanyShares(world, company.id);
    addShareClass(world, company.id, 'nonVoting', 1_000);
    addPlayerHolding(world, company.id, 'nonVoting', 10);

    const major = notice({
      audience: 'company',
      kind: 'major',
      priority: 'important',
      companyId: company.id,
      title: '控制权变化',
      body: '公司经营者发生变更。',
    });
    expect(notificationVisible(world, DEMO_CONFIG, major)).toBe(true);
    expect(notifyPlayer(world, DEMO_CONFIG, major)).not.toBeNull();

    const vote = notice({
      audience: 'company',
      kind: 'vote',
      priority: 'important',
      companyId: company.id,
      title: '股东表决',
      body: '请参与表决。',
    });
    expect(notificationVisible(world, DEMO_CONFIG, vote)).toBe(false);
  });

  it('没有持股且非经营者的玩家不会收到企业重大变化通知', () => {
    const world = freshWorld();
    const company = world.companies[0]!;
    resetCompanyShares(world, company.id);
    addShareClass(world, company.id, 'voting', 100);
    addShareClass(world, company.id, 'nonVoting', 0);
    const input = notice({
      audience: 'company',
      kind: 'major',
      priority: 'important',
      companyId: company.id,
      title: '控制权变化',
      body: '公司经营者发生变更。',
    });
    expect(notificationVisible(world, DEMO_CONFIG, input)).toBe(false);
    expect(notifyPlayer(world, DEMO_CONFIG, input)).toBeNull();
  });

  it('有投票权的小股东可通过 important 标记获知控制权变化', () => {
    const world = freshWorld();
    const company = world.companies[0]!;
    resetCompanyShares(world, company.id);
    addShareClass(world, company.id, 'voting', 1_000);
    addPlayerHolding(world, company.id, 'voting', 1);

    const input = notice({
      audience: 'company',
      kind: 'major',
      priority: 'important',
      companyId: company.id,
      title: '控制权变化',
      body: '公司经营者发生变更。',
    });
    expect(notificationVisible(world, DEMO_CONFIG, input)).toBe(true);
  });

  it('玩家控制公司时，即使没有股份也能收到经营与融资通知', () => {
    const world = freshWorld();
    const company = world.companies[0]!;
    world.governance.controls.push({
      companyId: company.id,
      operator: { type: 'player', id: 'player' },
      basis: 'boardAppointment',
      sinceTick: 0,
      note: '测试控制权',
    });

    expect(playerControlsCompany(world, company.id)).toBe(true);
    expect(
      notificationVisible(
        world,
        DEMO_CONFIG,
        notice({ audience: 'company', kind: 'market', companyId: company.id }),
      ),
    ).toBe(true);
    expect(
      notificationVisible(
        world,
        DEMO_CONFIG,
        notice({ audience: 'company', kind: 'agreement', companyId: company.id }),
      ),
    ).toBe(true);
  });

  it('玩家不是市长时城市通知被丢弃，担任市长后可见', () => {
    const world = freshWorld();
    const city = world.cities[0]!;
    world.player.roles.mayorCityId = null;

    const input = notice({
      audience: 'city',
      kind: 'major',
      cityId: city.id,
      title: `${city.name}市政动态`,
      body: '城市本月新增一项公共工程。',
    });

    expect(notificationVisible(world, DEMO_CONFIG, input)).toBe(false);
    expect(notifyPlayer(world, DEMO_CONFIG, input)).toBeNull();
    expect(world.notifications).toHaveLength(0);

    world.player.roles.mayorCityId = city.id;
    expect(notificationVisible(world, DEMO_CONFIG, input)).toBe(true);
    const created = notifyPlayer(world, DEMO_CONFIG, input);
    expect(created).not.toBeNull();
    expect(created!.cityId).toBe(city.id);
  });

  it('公司或城市 id 不存在时丢弃通知', () => {
    const world = freshWorld();
    expect(
      notificationVisible(
        world,
        DEMO_CONFIG,
        notice({ audience: 'company', kind: 'dividend', companyId: 'missing-company' }),
      ),
    ).toBe(false);
    expect(
      notificationVisible(
        world,
        DEMO_CONFIG,
        notice({ audience: 'city', kind: 'major', cityId: 'missing-city' }),
      ),
    ).toBe(false);
  });
});

describe('玩家通知的存储与已读状态', () => {
  it('统计未读数、标记单条已读并全部已读', () => {
    const world = freshWorld();
    const first = notifyPlayer(world, DEMO_CONFIG, notice({ title: '通知一' }));
    const second = notifyPlayer(world, DEMO_CONFIG, notice({ title: '通知二' }));
    notifyPlayer(world, DEMO_CONFIG, notice({ title: '通知三' }));

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(unreadNotificationCount(world)).toBe(3);

    expect(markNotificationRead(world, second!.id)).toBe(true);
    expect(unreadNotificationCount(world)).toBe(2);
    expect(markNotificationRead(world, 'missing-id')).toBe(false);

    markAllNotificationsRead(world);
    expect(unreadNotificationCount(world)).toBe(0);
  });

  it('超过上限时删除最旧通知，并保证 id 唯一、新的在前', () => {
    const world = freshWorld();
    const maxEntries = DEMO_CONFIG.notifications.maxEntries;
    const created = [];
    for (let index = 0; index < maxEntries + 3; index += 1) {
      const createdNotice = notifyPlayer(
        world,
        DEMO_CONFIG,
        notice({ title: `个人通知 ${index}`, body: '玩家个人事件。' }),
      );
      expect(createdNotice).not.toBeNull();
      created.push(createdNotice!);
    }

    expect(world.notifications).toHaveLength(maxEntries);
    const ids = world.notifications.map((notification) => notification.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain(created[0]!.id);
    expect(ids).not.toContain(created[1]!.id);
    expect(ids).toContain(created[3]!.id);
    expect(ids[ids.length - 1]).toBe(created[created.length - 1]!.id);
    expect(unreadNotificationCount(world)).toBe(maxEntries);

    const ordered = visibleNotifications(world);
    expect(ordered).toHaveLength(maxEntries);
    expect(ordered[0]!.id).toBe(created[created.length - 1]!.id);
    expect(ordered[1]!.id).toBe(created[created.length - 2]!.id);
  });

  it('通知文案来自调用方，不附加模拟步骤或校验信息', () => {
    const world = freshWorld();
    const body = '本次股息 1,200 元已存入你的现金账户。';
    const created = notifyPlayer(
      world,
      DEMO_CONFIG,
      notice({ kind: 'dividend', title: '收到股息', body }),
    );

    expect(created).not.toBeNull();
    expect(created!.title).toBe('收到股息');
    expect(created!.body).toBe(body);
    expect(created!.body).not.toContain('模拟步骤');
    expect(created!.body).not.toContain('校验');
    expect(created!.read).toBe(false);
  });

  it('表决通知按登记日快照判断，而不是当前持股', () => {
    const world = freshWorld();
    const company = world.companies[0]!;
    resetCompanyShares(world, company.id);
    addShareClass(world, company.id, 'voting', 100);
    addPlayerHolding(world, company.id, 'voting', 10);
    company.lastMonth.profit = 1_000_000;
    company.dividendPayoutRatio = 0;
    const motion = openDividendPolicyMotion(world, DEMO_CONFIG, 0)!;
    expect(motion).not.toBeNull();

    // 卖出全部股份后，登记日投票权仍有效，表决通知仍应可见。
    world.securities.holdings = world.securities.holdings.filter(
      (holding) => holding.holder.type !== 'player',
    );
    const withMotion = notice({
      audience: 'company',
      kind: 'vote',
      companyId: company.id,
      motionId: motion.id,
      title: '股东表决',
      body: '请参与表决。',
    });
    expect(notificationVisible(world, DEMO_CONFIG, withMotion)).toBe(true);
    expect(notificationVisible(world, DEMO_CONFIG, { ...withMotion, motionId: undefined })).toBe(
      false,
    );

    // 议案创建后才买入：当前有股份，但不在登记日快照内，不应收到表决通知。
    const lateWorld = freshWorld();
    const lateCompany = lateWorld.companies[0]!;
    resetCompanyShares(lateWorld, lateCompany.id);
    addShareClass(lateWorld, lateCompany.id, 'voting', 100);
    addShareClass(lateWorld, lateCompany.id, 'nonVoting', 0);
    const lateGroup = groupsOfCity(lateWorld, lateCompany.cityId)[0]!;
    lateWorld.securities.holdings.push({
      companyId: lateCompany.id,
      shareClassId: `${lateCompany.id}:voting`,
      holder: groupHolder(lateGroup),
      shares: 100,
      acquiredVia: 'primary',
      sinceTick: 0,
    });
    lateCompany.lastMonth.profit = 1_000_000;
    lateCompany.dividendPayoutRatio = 0;
    const lateMotion = openDividendPolicyMotion(lateWorld, DEMO_CONFIG, 0)!;
    expect(lateMotion).not.toBeNull();
    addPlayerHolding(lateWorld, lateCompany.id, 'voting', 10);
    expect(
      notificationVisible(lateWorld, DEMO_CONFIG, {
        ...withMotion,
        companyId: lateCompany.id,
        motionId: lateMotion.id,
      }),
    ).toBe(false);
  });
});
