import type {
  ActionResult,
  Company,
  EquipmentAssets,
  EquipmentKind,
  GoodId,
  LogEntry,
  UsedEquipmentOffer,
  WorldState,
} from '../contracts/types';
import type { DemoConfig } from '../../data/config';
import { round2 } from '../core/math';
import {
  intercityEquipmentOffers,
  recordIntercityEquipmentPurchase,
} from '../markets/intercity';

/**
 * v0.9：设备资产与设备市场。
 *
 * 设计口径（首版暂定，见交付报告）：
 * - 设备是“按行业分类的可计数资产”，不是商品库存；企业产能 = Σ(设备数量 × 每台产能 × 城市技术系数)。
 * - 新设备由设备生产企业按配方生产（农业/工业/能源设备三种商品），进入其库存；
 *   购买设备必须找到真实卖方：同城设备企业库存，或政府开局设备库存（仅新开局注入）。
 * - 政府开局设备库存用于启动设备产业与创办企业；出售所得进入本城财政（不是凭空补贴）。
 * - 二手设备通过企业挂单（UsedEquipmentOffer）撮合：只有真实买家出价成交才转移所有权与资金；
 *   没有买家时设备继续由原企业持有（挂单期间暂时冻结在委托中，可撤销）。
 * - 企业清算时设备按清算折价寻找真实买家；无人购买的设备移交政府设备库存（可追溯、不产生现金），
 *   不得把账面价值直接当成现金。
 */

const KINDS: EquipmentKind[] = ['farm', 'industry', 'energy'];

export function emptyEquipmentAssets(): EquipmentAssets {
  return { farm: 0, industry: 0, energy: 0 };
}

export function equipmentKindForSector(sector: string, config: DemoConfig): EquipmentKind {
  for (const kind of KINDS) {
    if (config.equipment.catalog[kind].sectors.includes(sector as never)) return kind;
  }
  return config.equipment.fallbackKind;
}

export function equipmentCatalog(kind: EquipmentKind, config: DemoConfig) {
  return config.equipment.catalog[kind];
}

export function equipmentGoodId(kind: EquipmentKind, config: DemoConfig) {
  return config.equipment.catalog[kind].goodId;
}

/** 企业使用的设备类别（由其行业决定；企业只使用一类设备）。 */
export function companyEquipmentKind(company: Company, config: DemoConfig): EquipmentKind {
  return equipmentKindForSector(company.sector, config);
}

export function equipmentUnits(company: Company, kind: EquipmentKind): number {
  return Math.max(0, Math.floor(company.equipment[kind] ?? 0));
}

/** 该产出是否为资本品（设备商品）：资本品企业的产能单位是“台/月”，不是普通产出单位。 */
export function isCapitalGood(config: DemoConfig, output: GoodId): boolean {
  const value = (config.equipment.outputCapacityPerUnit as Partial<Record<GoodId, number>>)[output];
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * 每台设备对企业产能的贡献（不含城市技术系数与迁移余量），单位 = 该企业产出单位/台/月。
 *
 * v1.0 统一单位（task-23）：
 * - 普通商品企业：每台设备贡献 catalog[kind].capacityPerUnit 个产出单位/月（首版 300,000）；
 * - 资本品企业（产出为设备商品）：每台设备贡献 outputCapacityPerUnit[资本品] 台/月（5/3/3），
 *   不能沿用 300,000，否则设备厂 1 台设备 = 30 万台/月，创业资本会被高估到数百亿。
 */
export function equipmentCapacityPerUnit(
  config: DemoConfig,
  kind: EquipmentKind,
  output: GoodId,
): number {
  const capitalValue = (config.equipment.outputCapacityPerUnit as Partial<Record<GoodId, number>>)[
    output
  ];
  if (typeof capitalValue === 'number' && Number.isFinite(capitalValue) && capitalValue > 0) {
    return capitalValue;
  }
  return config.equipment.catalog[kind].capacityPerUnit;
}

/** 由设备台数推导的产能：设备数量 × 每台产能 × 城市技术系数（不含迁移余量）。 */
export function derivedEquipmentCapacity(
  world: WorldState,
  company: Company,
  config: DemoConfig,
): number {
  const city = world.cities.find((entry) => entry.id === company.cityId);
  const tech = city?.technology.productivityMultiplier ?? 1;
  let capacity = 0;
  for (const kind of KINDS) {
    capacity +=
      equipmentUnits(company, kind) *
      equipmentCapacityPerUnit(config, kind, company.recipeOutput);
  }
  return round2(capacity * tech);
}

/**
 * v8 旧档迁移余量（显式存储，不随设备交易转移）。
 *
 * 旧档产能不一定能被“整台设备 × 每台产能 × 技术系数”整除；迁移时按整台设备映射，
 * 余量记在企业上，避免悄悄增加或删除旧产能。规则：
 * - 余量只由迁移写入，之后买卖设备不改变余量，也不随设备转移给买方/卖方；
 * - 企业产能 = 设备推导产能 + 迁移余量；企业清算时余量随企业消失；
 * - 存档校验与不变量都会显式核对这一口径。
 */
export function equipmentCapacityRemainder(company: Company): number {
  const value = company.equipmentCapacityRemainder;
  return Number.isFinite(value) && value > 0 ? round2(value) : 0;
}

/** 设备理论产能（权威口径）：设备推导产能 + 迁移余量。 */
export function equipmentCapacityFor(
  world: WorldState,
  company: Company,
  config: DemoConfig,
): number {
  return round2(
    derivedEquipmentCapacity(world, company, config) + equipmentCapacityRemainder(company),
  );
}

/**
 * 重算并写回企业产能缓存。
 * capacity 的权威来源由“初始员工×生产率”改为“设备资产”；旧存档迁移会按原产能反推设备数量，
 * 保证迁移后产能不跳变（见 core/save.ts 的 v8→v9 迁移）。
 */
export function recomputeCompanyCapacity(
  world: WorldState,
  company: Company,
  config: DemoConfig,
): number {
  const capacity = equipmentCapacityFor(world, company, config);
  company.equipmentCapacity = capacity;
  company.capacity = capacity;
  company.baseCapacity = round2(Math.min(company.baseCapacity || capacity, capacity));
  // v0.9：设备购买会提高真实产能，扩张上限必须同步抬高，否则不变量“产能≤上限”被打破。
  company.maxCapacity = round2(Math.max(company.maxCapacity, capacity));
  return capacity;
}

/** 设备商品在城内的市场价格（缺省退回目录价）。 */
export function equipmentUnitPrice(
  world: WorldState,
  cityId: string,
  kind: EquipmentKind,
  config: DemoConfig,
): number {
  const city = world.cities.find((entry) => entry.id === cityId);
  const catalog = config.equipment.catalog[kind];
  const price = city?.market[catalog.goodId]?.price;
  return round2(Math.max(1, price && price > 0 ? price : catalog.price));
}

/** 同城设备企业可售的新设备数量（按库存计）。 */
export function localNewEquipmentSupply(
  world: WorldState,
  cityId: string,
  kind: EquipmentKind,
  config: DemoConfig,
): number {
  const goodId = config.equipment.catalog[kind].goodId;
  let total = 0;
  for (const company of world.companies) {
    if (company.cityId !== cityId || company.recipeOutput !== goodId) continue;
    total += Math.max(0, company.inventory[goodId] ?? 0);
  }
  return Math.max(0, Math.floor(total * 100) / 100);
}

/** 新设备可获得量：同城设备企业库存 + 政府开局库存 + 其他城市设备企业可售量。 */
export interface NewEquipmentSupply {
  local: number;
  government: number;
  intercity: number;
  total: number;
}

/**
 * 设备可获得性口径（创办企业评估与真实采购共用）。
 *
 * 只统计“现在就能成交”的整数台数：同城设备企业库存、政府开局库存、其他城市设备企业
 * 可售库存（已扣除自身生产预留，并按运输加成计价）。评估与实际采购都调用本函数，
 * 保证“评估算得到来源”与“实际买得到”同口径。
 */
export function newEquipmentSupply(
  world: WorldState,
  cityId: string,
  kind: EquipmentKind,
  config: DemoConfig,
  excludeCompanyId?: string,
): NewEquipmentSupply {
  const city = world.cities.find((entry) => entry.id === cityId);
  if (!city) return { local: 0, government: 0, intercity: 0, total: 0 };
  const local = Math.max(0, Math.floor(localNewEquipmentSupply(world, cityId, kind, config)));
  const government = Math.max(0, Math.floor(world.equipmentMarket.initialStock[kind] ?? 0));
  const intercity = Math.max(
    0,
    intercityEquipmentOffers(world, city, kind, config, excludeCompanyId).reduce(
      (total, offer) => total + Math.floor(offer.available),
      0,
    ),
  );
  return { local, government, intercity, total: local + government + intercity };
}

interface EquipmentPurchaseOptions {
  /** 允许使用政府开局设备库存（创办企业/启动设备产业时使用）。 */
  allowGovernmentStock?: boolean;
  /** 是否允许向其他城市设备企业采购（同城不足时；默认允许，创办企业与扩产同口径）。 */
  allowIntercity?: boolean;
  /** 是否写入市场账本（生产投入采购为 false；设备商品交易写入 sold/demand）。 */
  log?: LogEntry[];
  /** 购买原因，用于日志与统计。 */
  reason?: string;
}

export interface EquipmentPurchaseResult {
  ok: boolean;
  units: number;
  cost: number;
  fromCompanies: number;
  fromGovernment: number;
  fromIntercity: number;
  error?: string;
}

export type NewEquipmentSource = 'company' | 'government' | 'intercity';

/** 一笔设备成交计划（只描述，不改世界状态；供“先规划、后原子提交”使用）。 */
/**
 * 记录设备成交对当月市场账本的增量（城市+商品维度）。
 *
 * 设备采购可能发生在 tick 内 createWorldLedgers 之前，也可能发生在 tick 之间（玩家操作）；
 * 此时直接写 city.market 会被 finalizeMarkets 覆盖。统一先记增量，由 createWorldLedgers
 * 并入对应城市账本并清空；sold 同时计入 supply，保证 sold ≤ supply。
 */
export function recordEquipmentLedgerIncrement(
  world: WorldState,
  cityId: string,
  goodId: GoodId,
  increment: { demand?: number; sold?: number; intercityImported?: number },
): void {
  const list = (world.equipmentMarket.pendingLedger ??= []);
  let entry = list.find((item) => item.cityId === cityId && item.goodId === goodId);
  if (!entry) {
    entry = { cityId, goodId, demand: 0, sold: 0, intercityImported: 0 };
    list.push(entry);
  }
  entry.demand = round2(entry.demand + (increment.demand ?? 0));
  entry.sold = round2(entry.sold + (increment.sold ?? 0));
  entry.intercityImported = round2(
    entry.intercityImported + (increment.intercityImported ?? 0),
  );
}

/**
 * tick 之间（玩家创办/扩产、存读档前）设备成交不经过 finalizeMarkets：
 * 设备从卖家企业库存转为买方资产后立即同步卖方城市的市场期末库存，
 * 否则 checkInvariants 的“市场期末库存 == 企业库存合计”会在两次 tick 之间误报。
 * 下一期 finalizeMarkets 会按真实企业库存重算期末库存，无需额外回滚。
 */
export function syncMarketClosingStock(
  world: WorldState,
  cityId: string,
  goodId: GoodId,
  delta: number,
): void {
  const market = world.cities.find((entry) => entry.id === cityId)?.market[goodId];
  if (!market) return;
  market.closingStock = Math.max(0, round2((market.closingStock ?? 0) + delta));
}

export interface NewEquipmentPurchaseLine {
  source: NewEquipmentSource;
  sellerCompanyId?: string;
  sellerCityId?: string;
  units: number;
  unitPrice: number;
  cost: number;
  /** 跨城运输加成（仅 intercity 行；用于日志与诊断）。 */
  transportMarkup?: number;
}

export interface NewEquipmentPurchasePlan {
  ok: boolean;
  lines: NewEquipmentPurchaseLine[];
  units: number;
  cost: number;
  fromCompanies: number;
  fromGovernment: number;
  fromIntercity: number;
  error?: string;
}

const EMPTY_PURCHASE_RESULT: EquipmentPurchaseResult = {
  ok: false,
  units: 0,
  cost: 0,
  fromCompanies: 0,
  fromGovernment: 0,
  fromIntercity: 0,
};

/**
 * 规划一笔新设备采购（不修改世界状态）。
 *
 * 供给优先级：同城设备企业库存 → 政府开局库存（同城供给）→ 其他城市设备企业库存。
 * 价格口径：
 * - 同城设备企业/政府库存按本城设备市场价格（政府库存按目录价，与既有规则一致）；
 * - 跨城按“本城设备市场价 × 卖方价格系数 × (1 + 运输加成)”，运输加成与商品跨城共用
 *   intercity.ts 的距离/上限/下限模型。
 * 资金不足时按可负担台数部分成交；单企业单月仍受 maxBuyUnitsPerMonth 限制。
 */
export function planNewEquipmentPurchase(
  world: WorldState,
  company: Company,
  kind: EquipmentKind,
  requestedUnits: number,
  config: DemoConfig,
  options: { allowGovernmentStock?: boolean; allowIntercity?: boolean; budget?: number } = {},
): NewEquipmentPurchasePlan {
  const city = world.cities.find((entry) => entry.id === company.cityId);
  if (!city) return { ...EMPTY_PURCHASE_RESULT, lines: [], error: '企业城市不存在' };
  const want = Math.max(0, Math.floor(requestedUnits));
  if (want <= 0) {
    return { ...EMPTY_PURCHASE_RESULT, lines: [], error: '购买数量必须为正整数' };
  }
  const catalog = config.equipment.catalog[kind];
  const goodId = catalog.goodId;
  const limited = Math.min(want, config.equipment.maxBuyUnitsPerMonth);
  let budget = round2(Math.max(0, options.budget ?? company.cash));
  const lines: NewEquipmentPurchaseLine[] = [];
  let bought = 0;
  let cost = 0;
  let fromCompanies = 0;
  let fromGovernment = 0;
  let fromIntercity = 0;

  const take = (
    source: NewEquipmentSource,
    unitPrice: number,
    stock: number,
    sellerCompanyId?: string,
    sellerCityId?: string,
    transportMarkup?: number,
  ): void => {
    if (bought >= limited || budget <= 0) return;
    const affordable = Math.min(
      stock,
      Math.floor((budget + 1e-6) / unitPrice),
      limited - bought,
    );
    if (affordable <= 0) return;
    const spend = round2(affordable * unitPrice);
    lines.push({
      source,
      sellerCompanyId,
      sellerCityId,
      units: affordable,
      unitPrice,
      cost: spend,
      transportMarkup,
    });
    budget = round2(budget - spend);
    bought += affordable;
    cost = round2(cost + spend);
    if (source === 'company') fromCompanies += affordable;
    else if (source === 'government') fromGovernment += affordable;
    else fromIntercity += affordable;
  };

  // 1) 同城设备企业（真实卖方；同价按企业 id 确定性排序）。
  const localPrice = equipmentUnitPrice(world, city.id, kind, config);
  const localSellers = world.companies
    .filter(
      (candidate) =>
        candidate.id !== company.id &&
        candidate.cityId === city.id &&
        candidate.recipeOutput === goodId,
    )
    .map((candidate) => ({
      company: candidate,
      stock: Math.max(0, Math.floor(candidate.inventory[goodId] ?? 0)),
    }))
    .filter((entry) => entry.stock > 0)
    .sort((a, b) => a.company.id.localeCompare(b.company.id));
  for (const seller of localSellers) {
    if (bought >= limited || budget <= 0) break;
    take('company', localPrice, seller.stock, seller.company.id, city.id);
  }

  // 2) 政府开局设备库存（同城供给，先于跨城；付款进入本城财政）。
  const governmentStock = options.allowGovernmentStock
    ? Math.max(0, Math.floor(world.equipmentMarket.initialStock[kind] ?? 0))
    : 0;
  if (governmentStock > 0 && bought < limited && budget > 0) {
    take('government', round2(Math.max(1, catalog.price)), governmentStock);
  }

  // 3) 其他城市设备企业（按单价升序；同价按城市/企业 id 确定性排序）。
  const intercityOffers =
    options.allowIntercity === false
      ? []
      : intercityEquipmentOffers(world, city, kind, config, company.id);
  for (const offer of intercityOffers) {
    if (bought >= limited || budget <= 0) break;
    take(
      'intercity',
      offer.unitPrice,
      Math.max(0, Math.floor(offer.available)),
      offer.company.id,
      offer.city.id,
      offer.markup,
    );
  }

  if (bought <= 0) {
    const supply = newEquipmentSupply(world, city.id, kind, config, company.id);
    return {
      ...EMPTY_PURCHASE_RESULT,
      lines: [],
      error:
        supply.total <= 0
          ? `没有可购买的${catalog.name}（同城设备企业无库存、政府库存为空，其他城市也无货）`
          : '资金不足以购买任何设备',
    };
  }
  return { ok: true, lines, units: bought, cost, fromCompanies, fromGovernment, fromIntercity };
}

/**
 * 原子提交一笔已规划的新设备采购（不再重新选择卖方）。
 *
 * 提交前先整体校验所有卖方仍存在且库存足够；任一行不满足则不做任何改动。
 * 资金与设备/库存/市场账本在同一函数内一次性转移，失败不留半成品。
 */
export function executeNewEquipmentPlan(
  world: WorldState,
  company: Company,
  kind: EquipmentKind,
  plan: NewEquipmentPurchasePlan,
  config: DemoConfig,
  tick: number,
  options: EquipmentPurchaseOptions = {},
): EquipmentPurchaseResult {
  const city = world.cities.find((entry) => entry.id === company.cityId);
  if (!city) return { ...EMPTY_PURCHASE_RESULT, error: '企业城市不存在' };
  if (!plan.ok || plan.units <= 0 || plan.lines.length === 0) {
    return { ...EMPTY_PURCHASE_RESULT, error: plan.error ?? '没有可成交的设备' };
  }
  const catalog = config.equipment.catalog[kind];
  const goodId = catalog.goodId;

  // 提交前整体校验：任一卖方缺失/库存不足则整体失败，不产生资金或库存副作用。
  for (const line of plan.lines) {
    if (line.source === 'government') {
      if ((world.equipmentMarket.initialStock[kind] ?? 0) < line.units) {
        return { ...EMPTY_PURCHASE_RESULT, error: '政府设备库存已变化，请重试' };
      }
      continue;
    }
    const seller = world.companies.find((entry) => entry.id === line.sellerCompanyId);
    if (!seller) return { ...EMPTY_PURCHASE_RESULT, error: '设备卖方已不存在，请重试' };
    if ((seller.inventory[goodId] ?? 0) + 1e-6 < line.units) {
      return { ...EMPTY_PURCHASE_RESULT, error: '设备卖方库存已变化，请重试' };
    }
  }

  for (const line of plan.lines) {
    company.cash = round2(company.cash - line.cost);
    if (line.source === 'company') {
      const seller = world.companies.find((entry) => entry.id === line.sellerCompanyId)!;
      seller.cash = round2(seller.cash + line.cost);
      seller.inventory[goodId] = Math.max(
        0,
        round2((seller.inventory[goodId] ?? 0) - line.units),
      );
      seller.lastMonth.sold = round2(seller.lastMonth.sold + line.units);
      seller.lastMonth.revenue = round2(seller.lastMonth.revenue + line.cost);
      // 设备作为资本品出售的收入：计入卖方 equipmentSold（与二手设备口径一致），
      // 供 72 月报告区分“设备产业售出收入”与普通商品销售。
      seller.lastMonth.equipmentSold = round2((seller.lastMonth.equipmentSold ?? 0) + line.cost);
      syncMarketClosingStock(world, seller.cityId, goodId, -line.units);
      recordEquipmentLedgerIncrement(world, city.id, goodId, {
        demand: line.units,
        sold: line.units,
      });
    } else if (line.source === 'government') {
      // 政府设备库存出售所得进入本城财政（真实付款，不是补贴）。
      city.treasury = round2(city.treasury + line.cost);
      world.equipmentMarket.initialStock[kind] = Math.max(
        0,
        Math.floor((world.equipmentMarket.initialStock[kind] ?? 0) - line.units),
      );
      // 政府储备释放属于真实成交：pending 合并时 sold 同时计入 supply，维持市场守恒。
      recordEquipmentLedgerIncrement(world, city.id, goodId, {
        demand: line.units,
        sold: line.units,
      });
    } else {
      const seller = world.companies.find((entry) => entry.id === line.sellerCompanyId)!;
      seller.inventory[goodId] = Math.max(
        0,
        round2((seller.inventory[goodId] ?? 0) - line.units),
      );
      syncMarketClosingStock(world, seller.cityId, goodId, -line.units);
      // 跨城：买方全额付款，卖方所得按既有运输容量结算（期末统一扣减并退回差额）。
      recordIntercityEquipmentPurchase(world, company, seller, kind, line.units, line.cost, config);
      // 进口台数计入买方城市需求与跨城进口，不计本地 sold（口径与跨城商品一致）。
      recordEquipmentLedgerIncrement(world, city.id, goodId, {
        demand: line.units,
        sold: 0,
        intercityImported: line.units,
      });
    }
    if (line.source !== 'government') {
      // 企业/跨城卖方库存转为买方设备资产：世界口径的商品库存减少，
      // 结算审计把它作为“资本化流出”显式扣减，避免误报库存不守恒。
      const capitalized = (world.equipmentMarket.capitalizedThisTick ??= {});
      capitalized[goodId] = round2((capitalized[goodId] ?? 0) + line.units);
    }
  }

  company.equipment[kind] = Math.floor((company.equipment[kind] ?? 0) + plan.units);
  company.lastMonth.equipmentPurchased = round2(
    (company.lastMonth.equipmentPurchased ?? 0) + plan.cost,
  );
  recomputeCompanyCapacity(world, company, config);
  const crossCityNote =
    plan.fromIntercity > 0
      ? `，其中跨城 ${plan.fromIntercity} 台（含运输加成，卖方所得按期末运力结算）`
      : '';
  options.log?.push({
    tick,
    kind: 'production',
    message: `${company.name} 购买${catalog.name} ${plan.units} 台（${options.reason ?? '设备投资'}）${crossCityNote}，支出 ${plan.cost.toFixed(0)}；产能增至 ${company.capacity.toFixed(0)} 单位/月。`,
  });
  return {
    ok: true,
    units: plan.units,
    cost: plan.cost,
    fromCompanies: plan.fromCompanies,
    fromGovernment: plan.fromGovernment,
    fromIntercity: plan.fromIntercity,
  };
}

/**
 * 购买新设备：先同城设备企业库存（真实卖方、按市场价付款给卖方），
 * 不足部分可选用政府开局设备库存（付款进入本城财政），仍不足时可向其他城市设备企业采购
 * （按运输加成计价，卖方所得按期末运力结算）。资金不足时按可负担数量部分成交。
 */
export function buyNewEquipment(
  world: WorldState,
  company: Company,
  kind: EquipmentKind,
  requestedUnits: number,
  config: DemoConfig,
  tick: number,
  options: EquipmentPurchaseOptions = {},
): EquipmentPurchaseResult {
  const plan = planNewEquipmentPurchase(world, company, kind, requestedUnits, config, {
    allowGovernmentStock: options.allowGovernmentStock,
    allowIntercity: options.allowIntercity,
  });
  if (!plan.ok) return { ...EMPTY_PURCHASE_RESULT, error: plan.error };
  return executeNewEquipmentPlan(world, company, kind, plan, config, tick, options);
}

/**
 * 出售二手设备：先把设备挂单冻结（从可用设备中扣除并重算产能），
 * 只有真实买家成交后才转移资金；没有买家时设备保留在委托中，可撤销。
 * 挂单价格默认按目录价的二手系数计算，卖方也可指定。
 */
export function listUsedEquipment(
  world: WorldState,
  company: Company,
  kind: EquipmentKind,
  units: number,
  config: DemoConfig,
  tick: number,
  askPrice?: number,
  note = '企业二手设备',
): ActionResult & { offerId?: string } {
  const want = Math.max(0, Math.floor(units));
  if (want <= 0) return { ok: false, error: '出售数量必须为正整数' };
  const owned = Math.floor(company.equipment[kind] ?? 0);
  if (owned < want) return { ok: false, error: `设备数量不足：持有 ${owned}，拟出售 ${want}` };
  const catalog = config.equipment.catalog[kind];
  const price = round2(Math.max(1, askPrice ?? catalog.price * config.equipment.usedPriceFactor));
  company.equipment[kind] = owned - want;
  recomputeCompanyCapacity(world, company, config);
  const offer: UsedEquipmentOffer = {
    id: nextUsedOfferId(world),
    companyId: company.id,
    cityId: company.cityId,
    kind,
    units: want,
    askPrice: price,
    listedTick: tick,
    note,
  };
  world.equipmentMarket.offers.push(offer);
  return { ok: true, offerId: offer.id, note: `已挂出 ${want} 台${catalog.name}，单价 ${price.toFixed(0)}。` };
}

/**
 * 撤销二手设备委托：设备返还企业后必须同步重算产能。
 *
 * 挂单时已把设备从企业设备资产中扣除并重算过产能；撤单若不重算，capacity /
 * equipmentCapacity 会与设备数量脱节，后续任意一次重算又会突变。这里统一在函数内重算，
 * 调用方无需再补（存档往返后同样成立）。
 */
export function cancelUsedEquipmentOffer(
  world: WorldState,
  companyId: string,
  offerId: string,
  config: DemoConfig,
): ActionResult {
  const index = world.equipmentMarket.offers.findIndex((entry) => entry.id === offerId);
  if (index < 0) return { ok: false, error: '设备出售委托不存在' };
  const offer = world.equipmentMarket.offers[index]!;
  if (offer.companyId !== companyId) return { ok: false, error: '只能撤销自己的设备出售委托' };
  const company = world.companies.find((entry) => entry.id === companyId);
  if (!company) return { ok: false, error: '企业不存在' };
  company.equipment[offer.kind] = Math.floor((company.equipment[offer.kind] ?? 0) + offer.units);
  recomputeCompanyCapacity(world, company, config);
  world.equipmentMarket.offers.splice(index, 1);
  return {
    ok: true,
    note: `已撤销 ${offer.units} 台${config.equipment.catalog[offer.kind].name}出售委托，产能已重算。`,
  };
}

/** 购买二手设备（部分成交；买方资金不足时按可负担数量成交）。 */
export function buyUsedEquipment(
  world: WorldState,
  buyer: Company,
  offerId: string,
  units: number,
  config: DemoConfig,
  trickle: number,
): ActionResult & { units: number; cost: number } {
  void trickle;
  const offer = world.equipmentMarket.offers.find((entry) => entry.id === offerId);
  if (!offer) return { ok: false, units: 0, cost: 0, error: '设备出售委托不存在' };
  if (offer.companyId === buyer.id) return { ok: false, units: 0, cost: 0, error: '不能购买自己挂出的设备' };
  const want = Math.max(0, Math.floor(units));
  if (want <= 0) return { ok: false, units: 0, cost: 0, error: '购买数量必须为正整数' };
  const affordable = Math.min(want, offer.units, Math.floor((buyer.cash + 1e-6) / offer.askPrice));
  if (affordable <= 0) return { ok: false, units: 0, cost: 0, error: '资金不足以购买该设备' };
  const seller = world.companies.find((entry) => entry.id === offer.companyId);
  const cost = round2(affordable * offer.askPrice);
  buyer.cash = round2(buyer.cash - cost);
  if (seller) {
    seller.cash = round2(seller.cash + cost);
    seller.lastMonth.equipmentSold = round2((seller.lastMonth.equipmentSold ?? 0) + cost);
  } else {
    const city = world.cities.find((entry) => entry.id === offer.cityId);
    if (city) city.treasury = round2(city.treasury + cost);
  }
  buyer.equipment[offer.kind] = Math.floor((buyer.equipment[offer.kind] ?? 0) + affordable);
  buyer.lastMonth.equipmentPurchased = round2((buyer.lastMonth.equipmentPurchased ?? 0) + cost);
  offer.units -= affordable;
  if (offer.units <= 0) {
    world.equipmentMarket.offers = world.equipmentMarket.offers.filter((entry) => entry.id !== offerId);
  }
  recomputeCompanyCapacity(world, buyer, config);
  if (seller) recomputeCompanyCapacity(world, seller, config);
  world.equipmentMarket.lastMonthSold[offer.kind] = Math.floor(
    (world.equipmentMarket.lastMonthSold[offer.kind] ?? 0) + affordable,
  );
  return { ok: true, units: affordable, cost, note: `购买二手${config.equipment.catalog[offer.kind].name} ${affordable} 台，支出 ${cost.toFixed(0)}。` };
}

/**
 * 企业清算时的设备处置：按清算折价寻找真实买家（其他同城企业，现金足够且确实需要产能）；
 * 无人购买的设备移交政府设备库存（不产生现金，记录可追溯），绝不按账面价值变现。
 */
export function disposeCompanyEquipment(
  world: WorldState,
  company: Company,
  config: DemoConfig,
  tick: number,
  log: LogEntry[],
): { proceeds: number; unitsSold: number; unitsConsigned: number; buyers: string[] } {
  let proceeds = 0;
  let unitsSold = 0;
  let unitsConsigned = 0;
  const buyers: string[] = [];
  for (const kind of KINDS) {
    const units = Math.floor(company.equipment[kind] ?? 0);
    if (units <= 0) continue;
    const catalog = config.equipment.catalog[kind];
    const price = round2(catalog.price * config.equipment.liquidationPriceFactor);
    // 候选买家：同城、有现金、产能利用率高且设备类别匹配（真实需求）。
    const candidates = world.companies
      .filter((entry) => entry.id !== company.id && entry.cityId === company.cityId)
      .filter((entry) => equipmentKindForSector(entry.sector, config) === kind)
      .filter((entry) => entry.cash >= price)
      .sort((a, b) => b.utilization - a.utilization || b.cash - a.cash || a.id.localeCompare(b.id));
    let remaining = units;
    for (const candidate of candidates) {
      if (remaining <= 0) break;
      const affordable = Math.min(remaining, Math.floor(candidate.cash / price));
      if (affordable <= 0) continue;
      const cost = round2(affordable * price);
      candidate.cash = round2(candidate.cash - cost);
      candidate.equipment[kind] = Math.floor((candidate.equipment[kind] ?? 0) + affordable);
      candidate.lastMonth.equipmentPurchased = round2((candidate.lastMonth.equipmentPurchased ?? 0) + cost);
      recomputeCompanyCapacity(world, candidate, config);
      proceeds = round2(proceeds + cost);
      unitsSold += affordable;
      remaining -= affordable;
      buyers.push(candidate.id);
    }
    if (remaining > 0) {
      world.equipmentMarket.initialStock[kind] = Math.floor(
        (world.equipmentMarket.initialStock[kind] ?? 0) + remaining,
      );
      unitsConsigned += remaining;
      log.push({
        tick,
        kind: 'warning',
        message: `${company.name} 清算：${remaining} 台${catalog.name}无买家，按账面移交政府设备库存（未变现，不计入清算现金）。`,
      });
    }
  }
  return { proceeds: round2(proceeds), unitsSold, unitsConsigned, buyers };
}

export function nextUsedOfferId(world: WorldState): string {
  let number = world.equipmentMarket.offers.length + 1;
  const ids = new Set(world.equipmentMarket.offers.map((entry) => entry.id));
  while (ids.has(`used-${number}`)) number += 1;
  return `used-${number}`;
}

/** 供存档迁移与诊断：按产能反推设备数量（保持产能≈迁移前，不凭空增加产能）。 */
export function equipmentFromCapacity(
  capacityByKind: Partial<Record<EquipmentKind, number>>,
  techMultiplier: number,
  config: DemoConfig,
  output: GoodId = 'food',
): EquipmentAssets {
  const assets = emptyEquipmentAssets();
  for (const kind of KINDS) {
    const capacity = capacityByKind[kind] ?? 0;
    const perUnit =
      equipmentCapacityPerUnit(config, kind, output) * (techMultiplier > 0 ? techMultiplier : 1);
    assets[kind] = Math.max(0, Math.round(capacity / Math.max(1, perUnit)));
  }
  return assets;
}

/**
 * v8→v9 迁移专用：把旧档产能映射为“整台设备 + 显式迁移余量”。
 *
 * 旧档只记录总产能（capacity），没有设备台数。若直接四舍五入反推设备，再把 capacity
 * 原样写回，设备推导产能与缓存会永久不一致（后续任意重算都会突变）。这里改为：
 * - 设备台数 = floor(capacity / 每台产能)；
 * - 余量 = capacity − 设备推导产能（< 每台产能），显式记录在 equipmentCapacityRemainder；
 * - 迁移后 capacity 仍等于原值，且 = 设备推导产能 + 余量，不凭空增减产能/现金。
 */
export function equipmentFromLegacyCapacity(
  capacity: number,
  techMultiplier: number,
  config: DemoConfig,
  kind: EquipmentKind,
  output: GoodId,
): { equipment: EquipmentAssets; remainder: number } {
  const assets = emptyEquipmentAssets();
  const perUnit = Math.max(
    1,
    equipmentCapacityPerUnit(config, kind, output) *
      (techMultiplier > 0 ? techMultiplier : 1),
  );
  const safeCapacity = Number.isFinite(capacity) && capacity > 0 ? capacity : 0;
  const units = Math.max(0, Math.floor(safeCapacity / perUnit));
  assets[kind] = units;
  const remainder = round2(Math.max(0, safeCapacity - units * perUnit));
  return { equipment: assets, remainder };
}
