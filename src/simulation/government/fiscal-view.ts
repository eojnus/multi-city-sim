/**
 * 财政信息权限投影（v0.7 契约骨架，块0 空实现）。
 *
 * 数据层权限表达（补充指令 #7、DECISIONS v1.1 #9/#14）：
 * - 渲染期必须按**当前** viewer.mayorCityId 重新过滤；换任、离职、破产重选、读档后立即生效。
 * - 非市长可见：城市公开信息、当月 GDP 与普通历史、已发行债券必要投资信息（不含计划总额/总售额/总债务）、
 *   自持债券与收款、公开选举与破产事件。
 * - 仅市长可见：财政余额、收支流水、政府贷款与债券本金/总负债、12 月判定合计与债务率/风险等级/趋势、
 *   兑付计划、发债与借款操作。
 * - 存储期的可见性过滤只是缓存；任何对外投影都必须再经过本模块。
 *
 * 本文件当前只提供签名与空实现，业务体由界面/游戏程序在块4 填充；签名冻结后只增不改。
 */
import type {
  City,
  FiscalVisibility,
  LogEntry,
  MayorFiscalView,
  OwnBondHoldingView,
  PlayerNotification,
  PublicBondOfferView,
  ViewerIdentity,
  WorldState,
} from '../contracts/types';
import type { DemoConfig } from '../../data/config';

/** 当前查看者是否能看某城的市长专属财政信息。 */
export function canViewMayorFiscal(viewer: ViewerIdentity, cityId: string): boolean {
  return viewer.mayorCityId === cityId;
}

/** 单条可见性判定：public 恒可见；mayor 仅 current mayorCityId 匹配者可见。 */
export function isVisibleTo(
  visibility: FiscalVisibility | undefined,
  viewer: ViewerIdentity,
): boolean {
  if (!visibility || visibility.scope === 'public') return true;
  return visibility.cityId !== null && visibility.cityId === viewer.mayorCityId;
}

/**
 * 市长财政视图（唯一允许给市长 UI 的财政形状）。
 * 非该城现任市长返回 null；不得绕过本函数直接读取 city.treasury / city.government.*。
 */
export function buildMayorFiscalView(
  world: WorldState,
  city: City,
  config: DemoConfig,
  viewer: ViewerIdentity,
): MayorFiscalView | null {
  void world;
  void city;
  void config;
  void viewer;
  return null;
}

/** 公开债券投资信息（白名单：不含发行计划总额、总售额、政府总债务）。 */
export function buildPublicBondOffer(
  world: WorldState,
  issuanceId: string,
): PublicBondOfferView | null {
  void world;
  void issuanceId;
  return null;
}

/** 任何玩家可看自己的持债记录（含应得款与到期日）。 */
export function buildOwnBondHoldingViews(
  world: WorldState,
  holderId: string,
): OwnBondHoldingView[] {
  void world;
  void holderId;
  return [];
}

/** 按当前身份过滤日志（渲染期重校验；不得只依赖存储期过滤）。 */
export function visibleLogEntries(world: WorldState, viewer: ViewerIdentity): LogEntry[] {
  return (world.log ?? []).filter((entry) => isVisibleTo(entry.visibility, viewer));
}

/** 按当前身份过滤通知（渲染期重校验；换任后旧市长通知立即不可见）。 */
export function visibleNotifications(
  world: WorldState,
  viewer: ViewerIdentity,
): PlayerNotification[] {
  return (world.notifications ?? []).filter((notice) => isVisibleTo(notice.visibility, viewer));
}
