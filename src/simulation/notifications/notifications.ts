// 玩家通知：按玩家身份筛选“与他有关”的事件。
//
// 本文件只负责“是否通知玩家”与通知的存储（已读、裁剪、排序），
// 不生成事件、不做 UI 文案拼接，也不展示模拟步骤或技术校验日志。
//
// 【暂定方案，可配置】可见性规则（阈值来自 config.notifications）：
// - personal：总是可见（玩家自己的分红、操作结果等）。
// - company + vote：仅当玩家持有该公司有投票权股份（> 0）。
//   无投票权持有人不得收到要求其投票的通知。
// - company + dividend：仅当玩家持有该公司任意股份（投票权或仅分红）。
// - company + major：玩家持股比例 >= majorStakeThreshold，或玩家控制该公司；
//   另允许调用方用 priority: 'important' 标记控制权/董事会/经营异常，
//   此时有投票权的少量持股人也可见。
// - company + market（融资要约等）：持股比例 >= 阈值，或玩家控制该公司。
// - company + agreement：玩家控制该公司，或持股比例 >= 阈值。
// - city：仅当玩家是该市市长（world.player.roles.mayorCityId）。
//   市长选举尚未实现，这是待定身份；不是市长时城市通知一律丢弃。
// - 公司/城市引用无效（id 不存在）时丢弃。
//
// majorStakeThreshold 与“重大变化”的划分是暂定演示规则，不是最终策划；
// 调整 config.notifications 即可改变行为。分红金额下限 minDividendAmount
// 由调用方在构造事件时判断，本模块只做可见性过滤。

import type { DemoConfig } from '../../data/config';
import type {
  NotificationAudience,
  NotificationKind,
  PlayerNotification,
  ShareHolding,
  WorldState,
} from '../contracts/types';

export interface PlayerNoticeInput {
  audience: 'personal' | 'company' | 'city';
  kind: 'dividend' | 'vote' | 'major' | 'agreement' | 'market';
  priority?: 'normal' | 'important';
  companyId?: string;
  cityId?: string;
  title: string;
  body: string;
}

/** 某公司的全部股份类别。旧存档可能尚无 securities，按空处理。 */
function shareClassesOf(world: WorldState, companyId: string) {
  return (world.securities?.classes ?? []).filter((shareClass) => shareClass.companyId === companyId);
}

/** 玩家在某公司的持股记录（权威来源是 securities.holdings，而不是 player.holdings 镜像）。 */
function playerHoldingsOf(world: WorldState, companyId: string): ShareHolding[] {
  return (world.securities?.holdings ?? []).filter(
    (holding) =>
      holding.companyId === companyId && holding.holder.type === 'player' && holding.shares > 0,
  );
}

/** 玩家持股占公司总发行股数的比例（投票权 + 仅分红两类合计），0–1。 */
export function playerStakeOf(world: WorldState, companyId: string): number {
  const issuedShares = shareClassesOf(world, companyId).reduce(
    (total, shareClass) => total + (shareClass.issuedShares > 0 ? shareClass.issuedShares : 0),
    0,
  );
  if (issuedShares <= 0) return 0;
  const heldShares = playerHoldingsOf(world, companyId).reduce(
    (total, holding) => total + holding.shares,
    0,
  );
  return heldShares / issuedShares;
}

/** 玩家持有的有投票权股份数量（按股份类别 kind 判定）。 */
export function playerVotingSharesOf(world: WorldState, companyId: string): number {
  const votingClassIds = new Set(
    shareClassesOf(world, companyId)
      .filter((shareClass) => shareClass.kind === 'voting')
      .map((shareClass) => shareClass.id),
  );
  return playerHoldingsOf(world, companyId)
    .filter((holding) => votingClassIds.has(holding.shareClassId))
    .reduce((total, holding) => total + holding.shares, 0);
}

/** 玩家是否为该公司的经营者（governance.controls 的 operator 指向玩家）。 */
export function playerControlsCompany(world: WorldState, companyId: string): boolean {
  return (world.governance?.controls ?? []).some(
    (control) =>
      control.companyId === companyId &&
      control.operator !== 'management' &&
      control.operator.type === 'player',
  );
}

function companyAudienceVisible(
  world: WorldState,
  config: DemoConfig,
  input: PlayerNoticeInput,
  companyId: string,
): boolean {
  const threshold = config.notifications.majorStakeThreshold;
  switch (input.kind) {
    case 'vote':
      // 无投票权持有人不收到表决通知。
      return playerVotingSharesOf(world, companyId) > 0;
    case 'dividend':
      // 任意一类股份（含仅分红）都可收到分红通知。
      return playerStakeOf(world, companyId) > 0;
    case 'major':
      if (playerStakeOf(world, companyId) >= threshold) return true;
      if (playerControlsCompany(world, companyId)) return true;
      // 控制权/董事会变化等“重要”事件：有投票权的少量持股人也可知情。
      return input.priority === 'important' && playerVotingSharesOf(world, companyId) > 0;
    case 'market':
    case 'agreement':
      return (
        playerStakeOf(world, companyId) >= threshold ||
        playerControlsCompany(world, companyId)
      );
    default:
      return false;
  }
}

/** 按身份规则判断一条通知是否应展示给玩家；无效引用返回 false。 */
export function notificationVisible(
  world: WorldState,
  config: DemoConfig,
  input: PlayerNoticeInput,
): boolean {
  if (input.audience === 'personal') return true;

  if (input.audience === 'company') {
    const companyId = input.companyId;
    if (!companyId) return false;
    if (!world.companies.some((company) => company.id === companyId)) return false;
    return companyAudienceVisible(world, config, input, companyId);
  }

  if (input.audience === 'city') {
    const cityId = input.cityId;
    if (!cityId) return false;
    if (!world.cities.some((city) => city.id === cityId)) return false;
    // 市长身份待定：不是该市市长时不接收城市事件。
    return (world.player.roles?.mayorCityId ?? null) === cityId;
  }

  return false;
}

/**
 * 创建通知。不可见时不修改世界并返回 null。
 * id 使用 tick + 对象 + 序号，完全确定性；序号从当前条数起步并跳过已占用编号。
 */
export function notifyPlayer(
  world: WorldState,
  config: DemoConfig,
  input: PlayerNoticeInput,
): PlayerNotification | null {
  if (!notificationVisible(world, config, input)) return null;

  const tick = world.time.tick;
  const reference = input.companyId ?? input.cityId ?? 'personal';
  const prefix = `n${tick}-${reference}-`;
  let serial = world.notifications.length + 1;
  while (world.notifications.some((notification) => notification.id === `${prefix}${serial}`)) {
    serial += 1;
  }

  const notification: PlayerNotification = {
    id: `${prefix}${serial}`,
    tick,
    audience: input.audience,
    kind: input.kind,
    priority: input.priority ?? 'normal',
    companyId: input.companyId,
    cityId: input.cityId,
    title: input.title,
    body: input.body,
    read: false,
  };

  world.notifications.push(notification);
  while (world.notifications.length > config.notifications.maxEntries) {
    world.notifications.shift();
  }
  return notification;
}

/** 标记单条已读；id 不存在返回 false，重复标记视为成功。 */
export function markNotificationRead(world: WorldState, id: string): boolean {
  const notification = world.notifications.find((candidate) => candidate.id === id);
  if (!notification) return false;
  notification.read = true;
  return true;
}

export function markAllNotificationsRead(world: WorldState): void {
  for (const notification of world.notifications) notification.read = true;
}

export function unreadNotificationCount(world: WorldState): number {
  return world.notifications.filter((notification) => !notification.read).length;
}

/** 生成的 id 末尾是自增序号；同 tick 内用它判断新旧（避免字符串比较把 10 排在 9 前面）。 */
function idSequence(id: string): number {
  const dash = id.lastIndexOf('-');
  if (dash < 0) return 0;
  const value = Number(id.slice(dash + 1));
  return Number.isFinite(value) ? value : 0;
}

/**
 * 返回通知的展示顺序：新的在前，即 tick 倒序、同 tick 序号倒序。
 * 不做未读优先排序，UI 需要时可自行再排。
 * 返回副本，调用方修改数组不影响世界状态。
 */
export function visibleNotifications(world: WorldState): PlayerNotification[] {
  return [...world.notifications].sort((a, b) => {
    if (a.tick !== b.tick) return b.tick - a.tick;
    const sequenceDiff = idSequence(b.id) - idSequence(a.id);
    if (sequenceDiff !== 0) return sequenceDiff;
    return b.id.localeCompare(a.id);
  });
}

// 供上层构造事件时复用的类型别名，避免各处重复写字符串联合。
export type NoticeAudience = NotificationAudience;
export type NoticeKind = NotificationKind;
