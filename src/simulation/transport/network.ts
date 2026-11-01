import type {
  ActionResult,
  City,
  IntracityNetwork,
  LogEntry,
  PendingIntercitySale,
  TransportLink,
  TransportState,
  WorldState,
} from '../contracts/types';
import type { DemoConfig } from '../../data/config';
import { clamp, round2 } from '../core/math';
import { spendTreasury } from '../government/treasury';

/**
 * 政府主导的公路/铁路网络。城内与城际分别核算：
 * - 城际：每条“城市对”的容量 = 公路各等级容量 + 铁路各等级容量。
 * - 城内：每座城市的配送容量由城内道路/铁路等级决定，影响本地成交可配送量。
 *
 * 所有容量数值、建设成本与时长都是【暂定演示参数】，集中配置在 data/config.ts。
 * 本模块只负责网络与容量，不改变任何商品或资金权威数据。
 */

export const TRANSPORT_MODES = ['road', 'rail'] as const;

export function transportModeLabel(mode: 'road' | 'rail'): string {
  return mode === 'road' ? '公路' : '铁路';
}

export function corridorKey(fromCityId: string, toCityId: string): string {
  return [fromCityId, toCityId].sort((a, b) => a.localeCompare(b)).join('|');
}

export function transportLinkId(fromCityId: string, toCityId: string, mode: 'road' | 'rail'): string {
  return `${corridorKey(fromCityId, toCityId)}:${mode}`;
}

export function createInitialTransport(world: WorldState, config: DemoConfig): TransportState {
  const links: TransportLink[] = [];
  const cityIds = [...world.cities].map((city) => city.id).sort((a, b) => a.localeCompare(b));
  for (let i = 0; i < cityIds.length; i++) {
    for (let j = i + 1; j < cityIds.length; j++) {
      const fromCityId = cityIds[i]!;
      const toCityId = cityIds[j]!;
      for (const mode of TRANSPORT_MODES) {
        const level = mode === 'road' ? config.transport.initialRoadLevel : config.transport.initialRailLevel;
        links.push({
          id: transportLinkId(fromCityId, toCityId, mode),
          fromCityId,
          toCityId,
          mode,
          level,
          maxLevel: config.transport.maxLevel,
          construction: null,
          note: `${transportModeLabel(mode)}连接；容量随政府建设等级提高（演示规则）。`,
        });
      }
    }
  }
  const intracity: IntracityNetwork[] = world.cities.map((city) => ({
    cityId: city.id,
    roadLevel: config.transport.intracity.initialRoadLevel,
    railLevel: config.transport.intracity.initialRailLevel,
    maxLevel: config.transport.intracity.maxLevel,
    construction: null,
    note: '城内配送网络（演示）：等级决定本地可配送量与配送效率。',
  }));
  return {
    links,
    intracity,
    pendingSales: [],
    lastMonth: emptyTransportMonth(0),
  };
}

export function emptyTransportMonth(tick: number): TransportState['lastMonth'] {
  return {
    tick,
    demand: 0,
    capacity: 0,
    overloadRatio: 0,
    penaltyRate: 0,
    capacityLossTotal: 0,
    freightSubsidy: 0,
    maintenancePaid: 0,
    corridors: [],
    intracity: [],
    trades: [],
    note: '尚无城际运输结算。',
  };
}

export function findLink(
  world: WorldState,
  fromCityId: string,
  toCityId: string,
  mode: 'road' | 'rail',
): TransportLink | undefined {
  const id = transportLinkId(fromCityId, toCityId, mode);
  return world.transport.links.find((link) => link.id === id);
}

export function corridorLinks(
  world: WorldState,
  fromCityId: string,
  toCityId: string,
): TransportLink[] {
  const key = corridorKey(fromCityId, toCityId);
  return world.transport.links
    .filter((link) => corridorKey(link.fromCityId, link.toCityId) === key)
    .sort((a, b) => a.mode.localeCompare(b.mode));
}

export function linkCapacity(link: TransportLink, config: DemoConfig): number {
  const perLevel =
    link.mode === 'rail' ? config.transport.rail.capacityPerLevel : config.transport.road.capacityPerLevel;
  return round2(Math.max(0, link.level) * perLevel);
}

export function corridorCapacity(
  world: WorldState,
  fromCityId: string,
  toCityId: string,
  config: DemoConfig,
): number {
  return round2(
    corridorLinks(world, fromCityId, toCityId).reduce(
      (total, link) => total + linkCapacity(link, config),
      0,
    ),
  );
}

/**
 * 容量惩罚：容量不是成交上限。
 * overloadRatio = max(0, demand - capacity) / demand；
 * penaltyRate = min(max, overloadRatio × strength)。
 * 容量为 0 且有需求时 overloadRatio = 1，取最大惩罚；交易仍可完成。
 */
export function capacityPenalty(
  demand: number,
  capacity: number,
  config: DemoConfig,
): { overloadRatio: number; penaltyRate: number } {
  if (demand <= 0) return { overloadRatio: 0, penaltyRate: 0 };
  if (capacity >= demand) return { overloadRatio: 0, penaltyRate: 0 };
  const overloadRatio = clamp((demand - Math.max(0, capacity)) / demand, 0, 1);
  const penaltyRate = clamp(
    overloadRatio * config.transport.penalty.strength,
    0,
    config.transport.penalty.max,
  );
  return { overloadRatio: round2(overloadRatio), penaltyRate: round2(penaltyRate) };
}

export function intracityCapacity(network: IntracityNetwork, config: DemoConfig): number {
  const intracity = config.transport.intracity;
  return round2(
    Math.max(0, network.roadLevel) * intracity.roadCapacityPerLevel +
      Math.max(0, network.railLevel) * intracity.railCapacityPerLevel,
  );
}

/**
 * 本地配送效率：使用“上一期实际配送需求 / 当前容量”计算，避免同月订单先后造成差别。
 * 新世界初始为 1；只有真正拥堵时才会低于 1（下限 efficiencyFloor）。
 */
export function intracityDeliveryEfficiency(world: WorldState, cityId: string): number {
  const stats = world.transport.lastMonth.intracity.find((entry) => entry.cityId === cityId);
  if (!stats) return 1;
  return clamp(stats.deliveryEfficiency, 0, 1);
}

export function transportMaintenanceForLevel(
  mode: 'road' | 'rail',
  level: number,
  config: DemoConfig,
): number {
  const cost = mode === 'rail' ? config.transport.rail.buildCostPerLevel : config.transport.road.buildCostPerLevel;
  return round2(Math.max(0, level) * cost * config.transport.maintenanceRatePerLevel);
}

export function intracityMaintenance(
  network: IntracityNetwork,
  config: DemoConfig,
): number {
  const intracity = config.transport.intracity;
  return round2(
    (network.roadLevel * intracity.buildCostRoad + network.railLevel * intracity.buildCostRail) *
      intracity.maintenanceRatePerLevel,
  );
}

export interface BuildEstimate {
  ok: boolean;
  error?: string;
  cost: number;
  months: number;
  targetLevel: number;
  label: string;
}

/** 建设/升级估价：只计算，不修改世界。 */
export function estimateCorridorUpgrade(
  world: WorldState,
  fromCityId: string,
  toCityId: string,
  mode: 'road' | 'rail',
  config: DemoConfig,
): BuildEstimate {
  const link = findLink(world, fromCityId, toCityId, mode);
  const label = `${transportModeLabel(mode)}（${fromCityId}—${toCityId}）`;
  if (!link) return { ok: false, error: '该城际线路不存在', cost: 0, months: 0, targetLevel: 0, label };
  if (link.construction) {
    return { ok: false, error: `该${transportModeLabel(mode)}线路正在建设中`, cost: 0, months: 0, targetLevel: link.construction.targetLevel, label };
  }
  if (link.level >= link.maxLevel) {
    return { ok: false, error: `该${transportModeLabel(mode)}线路已达最高等级`, cost: 0, months: 0, targetLevel: link.level, label };
  }
  const spec = mode === 'rail' ? config.transport.rail : config.transport.road;
  return {
    ok: true,
    cost: round2(spec.buildCostPerLevel),
    months: spec.buildMonthsPerLevel,
    targetLevel: link.level + 1,
    label,
  };
}

export function estimateIntracityUpgrade(
  world: WorldState,
  cityId: string,
  kind: 'road' | 'rail',
  config: DemoConfig,
): BuildEstimate {
  const network = world.transport.intracity.find((entry) => entry.cityId === cityId);
  const label = `城内${transportModeLabel(kind)}（${cityId}）`;
  if (!network) return { ok: false, error: '该城市没有城内交通网络', cost: 0, months: 0, targetLevel: 0, label };
  if (network.construction) {
    return { ok: false, error: '城内交通正在建设中', cost: 0, months: 0, targetLevel: network.construction.targetLevel, label };
  }
  const current = kind === 'road' ? network.roadLevel : network.railLevel;
  if (current >= network.maxLevel) {
    return { ok: false, error: '该城内交通已达最高等级', cost: 0, months: 0, targetLevel: current, label };
  }
  const intracity = config.transport.intracity;
  return {
    ok: true,
    cost: round2(kind === 'rail' ? intracity.buildCostRail : intracity.buildCostRoad),
    months: intracity.buildMonthsPerLevel,
    targetLevel: current + 1,
    label,
  };
}

/** 政府出资开工城际线路升级；资金不足则明确失败，不留下半成品。 */
export function startCorridorUpgrade(
  world: WorldState,
  fromCityId: string,
  toCityId: string,
  mode: 'road' | 'rail',
  config: DemoConfig,
  options: { cityId?: string; reason?: string } = {},
): ActionResult {
  const estimate = estimateCorridorUpgrade(world, fromCityId, toCityId, mode, config);
  if (!estimate.ok) return { ok: false, error: estimate.error };
  const link = findLink(world, fromCityId, toCityId, mode)!;
  const payerId = options.cityId ?? fromCityId;
  const payer = world.cities.find((city) => city.id === payerId);
  if (!payer) return { ok: false, error: '出资城市不存在' };
  if (payer.treasury + 1e-6 < estimate.cost) {
    return { ok: false, error: `财政资金不足：需要 ${estimate.cost.toLocaleString('zh-CN')} 信用点` };
  }
  const paid = spendTreasury(
    world,
    payer,
    estimate.cost,
    'transportConstruction',
    `${estimate.label} 升级至 ${estimate.targetLevel} 级${options.reason ? `（${options.reason}）` : ''}`,
    {},
    config,
  );
  if (paid < estimate.cost - 0.01) return { ok: false, error: '财政资金不足，建设未开工' };
  link.construction = {
    targetLevel: estimate.targetLevel,
    monthsRemaining: estimate.months,
    totalMonths: estimate.months,
    costPaid: paid,
    startedTick: world.time.tick,
  };
  return { ok: true, note: `${estimate.label} 已开工，${estimate.months} 个月后达到 ${estimate.targetLevel} 级。`, amount: paid };
}

export function startIntracityUpgrade(
  world: WorldState,
  cityId: string,
  kind: 'road' | 'rail',
  config: DemoConfig,
  options: { reason?: string } = {},
): ActionResult {
  const estimate = estimateIntracityUpgrade(world, cityId, kind, config);
  if (!estimate.ok) return { ok: false, error: estimate.error };
  const network = world.transport.intracity.find((entry) => entry.cityId === cityId)!;
  const city = world.cities.find((entry) => entry.id === cityId);
  if (!city) return { ok: false, error: '城市不存在' };
  if (city.treasury + 1e-6 < estimate.cost) {
    return { ok: false, error: `财政资金不足：需要 ${estimate.cost.toLocaleString('zh-CN')} 信用点` };
  }
  const paid = spendTreasury(
    world,
    city,
    estimate.cost,
    'transportConstruction',
    `${estimate.label} 升级至 ${estimate.targetLevel} 级${options.reason ? `（${options.reason}）` : ''}`,
    {},
    config,
  );
  if (paid < estimate.cost - 0.01) return { ok: false, error: '财政资金不足，建设未开工' };
  network.construction = {
    kind,
    targetLevel: estimate.targetLevel,
    monthsRemaining: estimate.months,
    totalMonths: estimate.months,
    costPaid: paid,
    startedTick: world.time.tick,
  };
  return { ok: true, note: `${estimate.label} 已开工，${estimate.months} 个月后达到 ${estimate.targetLevel} 级。`, amount: paid };
}

/** 月度推进建设与维护。返回本月维护支出总额。 */
export function advanceTransportConstruction(
  world: WorldState,
  config: DemoConfig,
  log: LogEntry[],
): number {
  let maintenance = 0;
  for (const link of [...world.transport.links].sort((a, b) => a.id.localeCompare(b.id))) {
    if (link.construction) {
      link.construction.monthsRemaining -= 1;
      if (link.construction.monthsRemaining <= 0) {
        link.level = link.construction.targetLevel;
        link.note = `${transportModeLabel(link.mode)}已升级至 ${link.level} 级（政府建设，演示规则）。`;
        log.push({
          tick: world.time.tick,
          kind: 'government',
          message: `${transportModeLabel(link.mode)} ${link.fromCityId}—${link.toCityId} 建成，容量提升到 ${linkCapacity(link, config).toFixed(0)} 单位/月。`,
        });
        link.construction = null;
      }
    }
  }
  for (const network of [...world.transport.intracity].sort((a, b) => a.cityId.localeCompare(b.cityId))) {
    if (network.construction) {
      network.construction.monthsRemaining -= 1;
      if (network.construction.monthsRemaining <= 0) {
        if (network.construction.kind === 'road') network.roadLevel = network.construction.targetLevel;
        else network.railLevel = network.construction.targetLevel;
        log.push({
          tick: world.time.tick,
          kind: 'government',
          message: `城内${transportModeLabel(network.construction.kind)} ${network.cityId} 建成，配送容量提升。`,
        });
        network.construction = null;
      }
    }
  }

  // 维护费：每条线路/城市按月支付；财政不足时按可用资金支付并记录欠维护。
  for (const city of [...world.cities].sort((a, b) => a.id.localeCompare(b.id))) {
    let due = 0;
    for (const link of world.transport.links) {
      // 每城只按自己作为 from 的一侧计费，避免同一条线路被两城重复计费。
      if (link.fromCityId !== city.id) continue;
      due += transportMaintenanceForLevel(link.mode, link.level, config);
    }
    const network = world.transport.intracity.find((entry) => entry.cityId === city.id);
    if (network) due += intracityMaintenance(network, config);
    if (due <= 0) continue;
    const paid = spendTreasury(
      world,
      city,
      due,
      'transportMaintenance',
      `城内与城际交通维护费（${city.name}）`,
      {},
      config,
    );
    if (paid < due - 0.01) {
      log.push({
        tick: world.time.tick,
        kind: 'warning',
        message: `${city.name} 交通维护费仅支付 ${paid.toFixed(0)}/${due.toFixed(0)}（财政不足，容量不因此变化）。`,
      });
    }
    city.lastMonth.transportSpending = round2(city.lastMonth.transportSpending + paid);
    maintenance = round2(maintenance + paid);
  }
  world.transport.lastMonth.maintenancePaid = maintenance;
  return maintenance;
}

export function recordIntercitySale(world: WorldState, sale: PendingIntercitySale): void {
  world.transport.pendingSales.push(sale);
}

/** 供界面使用：城市对外联系容量汇总（按城市对）。 */
export function cityCorridorSummary(
  world: WorldState,
  cityId: string,
  config: DemoConfig,
): { withCityId: string; capacity: number; demand: number; penaltyRate: number }[] {
  const partners = new Set<string>();
  for (const link of world.transport.links) {
    if (link.fromCityId === cityId) partners.add(link.toCityId);
    if (link.toCityId === cityId) partners.add(link.fromCityId);
  }
  return [...partners].sort((a, b) => a.localeCompare(b)).map((withCityId) => {
    const stats = world.transport.lastMonth.corridors.find(
      (entry) => entry.corridorKey === corridorKey(cityId, withCityId),
    );
    return {
      withCityId,
      capacity: corridorCapacity(world, cityId, withCityId, config),
      demand: stats?.demand ?? 0,
      penaltyRate: stats?.penaltyRate ?? 0,
    };
  });
}

export function cityNamesForCorridor(world: WorldState, entry: City | string): string {
  if (typeof entry !== 'string') return entry.name;
  return world.cities.find((city) => city.id === entry)?.name ?? entry;
}
