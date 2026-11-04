import type {
  ActionResult,
  Company,
  EquipmentAssets,
  EquipmentKind,
  LogEntry,
  UsedEquipmentOffer,
  WorldState,
} from '../contracts/types';
import type { DemoConfig } from '../../data/config';
import { round2 } from '../core/math';

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

/** 设备理论产能：设备数量 × 每台产能 × 城市技术系数。 */
export function equipmentCapacityFor(
  world: WorldState,
  company: Company,
  config: DemoConfig,
): number {
  const city = world.cities.find((entry) => entry.id === company.cityId);
  const tech = city?.technology.productivityMultiplier ?? 1;
  let capacity = 0;
  for (const kind of KINDS) {
    capacity += equipmentUnits(company, kind) * config.equipment.catalog[kind].capacityPerUnit;
  }
  return round2(capacity * tech);
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

interface EquipmentPurchaseOptions {
  /** 允许使用政府开局设备库存（创办企业/启动设备产业时使用）。 */
  allowGovernmentStock?: boolean;
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
  error?: string;
}

/**
 * 购买新设备：先同城设备企业库存（真实卖方、按市场价付款给卖方），
 * 不足部分可选用政府开局设备库存（付款进入本城财政）。资金不足时按可负担数量购买。
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
  const city = world.cities.find((entry) => entry.id === company.cityId);
  if (!city) return { ok: false, units: 0, cost: 0, fromCompanies: 0, fromGovernment: 0, error: '企业城市不存在' };
  const want = Math.max(0, Math.floor(requestedUnits));
  if (want <= 0) return { ok: false, units: 0, cost: 0, fromCompanies: 0, fromGovernment: 0, error: '购买数量必须为正整数' };
  const limited = Math.min(want, config.equipment.maxBuyUnitsPerMonth);
  const catalog = config.equipment.catalog[kind];
  const goodId = catalog.goodId;
  const price = equipmentUnitPrice(world, city.id, kind, config);

  // 真实卖方清单：同城设备企业（按价格升序，保证公平与确定性）。
  const sellers = world.companies
    .filter((candidate) => candidate.id !== company.id && candidate.cityId === city.id && candidate.recipeOutput === goodId)
    .map((candidate) => ({
      company: candidate,
      price,
      stock: Math.max(0, Math.floor(candidate.inventory[goodId] ?? 0)),
    }))
    .filter((entry) => entry.stock > 0)
    .sort((a, b) => a.price - b.price || a.company.id.localeCompare(b.company.id));

  const governmentAvailable = options.allowGovernmentStock
    ? Math.max(0, Math.floor(world.equipmentMarket.initialStock[kind] ?? 0))
    : 0;
  const totalSupply = sellers.reduce((total, entry) => total + entry.stock, 0) + governmentAvailable;
  if (totalSupply <= 0) {
    return { ok: false, units: 0, cost: 0, fromCompanies: 0, fromGovernment: 0, error: `没有可购买的${catalog.name}（无设备企业库存且政府设备库存为空）` };
  }

  let budget = round2(Math.max(0, company.cash));
  let bought = 0;
  let cost = 0;
  let fromCompanies = 0;
  let fromGovernment = 0;
  const remaining = Math.min(limited, totalSupply);

  for (const seller of sellers) {
    if (bought >= remaining) break;
    const affordable = Math.min(seller.stock, Math.floor((budget + 1e-6) / seller.price), remaining - bought);
    if (affordable <= 0) continue;
    const spend = round2(affordable * seller.price);
    // 原子转移：买方现金 → 卖方现金；卖方库存 → 买方设备资产。
    company.cash = round2(company.cash - spend);
    seller.company.cash = round2(seller.company.cash + spend);
    seller.company.inventory[goodId] = Math.max(0, round2((seller.company.inventory[goodId] ?? 0) - affordable));
    seller.company.lastMonth.sold = round2(seller.company.lastMonth.sold + affordable);
    seller.company.lastMonth.revenue = round2(seller.company.lastMonth.revenue + spend);
    const ledger = city.market[goodId];
    if (ledger) {
      ledger.sold = round2(ledger.sold + affordable);
      ledger.demand = round2(ledger.demand + affordable);
    }
    budget = round2(budget - spend);
    bought += affordable;
    cost = round2(cost + spend);
    fromCompanies += affordable;
  }

  if (bought < remaining && governmentAvailable > 0) {
    const govPrice = round2(Math.max(1, catalog.price));
    const affordable = Math.min(governmentAvailable, Math.floor((budget + 1e-6) / govPrice), remaining - bought);
    if (affordable > 0) {
      const spend = round2(affordable * govPrice);
      company.cash = round2(company.cash - spend);
      // 政府设备库存出售所得进入本城财政（真实付款，不是补贴）。
      city.treasury = round2(city.treasury + spend);
      world.equipmentMarket.initialStock[kind] = Math.max(
        0,
        Math.floor((world.equipmentMarket.initialStock[kind] ?? 0) - affordable),
      );
      budget = round2(budget - spend);
      bought += affordable;
      cost = round2(cost + spend);
      fromGovernment += affordable;
      const ledger = city.market[goodId];
      if (ledger) {
        // 政府储备释放属于真实新增供应：否则“成交 ≤ 供应”的市场守恒会被打破。
        ledger.supply = round2(ledger.supply + affordable);
        ledger.sold = round2(ledger.sold + affordable);
        ledger.demand = round2(ledger.demand + affordable);
      }
    }
  }

  if (bought <= 0) {
    return { ok: false, units: 0, cost: 0, fromCompanies: 0, fromGovernment: 0, error: '资金不足以购买任何设备' };
  }

  company.equipment[kind] = Math.floor((company.equipment[kind] ?? 0) + bought);
  company.lastMonth.equipmentPurchased = round2((company.lastMonth.equipmentPurchased ?? 0) + cost);
  recomputeCompanyCapacity(world, company, config);
  options.log?.push({
    tick,
    kind: 'production',
    message: `${company.name} 购买${catalog.name} ${bought} 台（${options.reason ?? '设备投资'}），支出 ${cost.toFixed(0)}；产能增至 ${company.capacity.toFixed(0)} 单位/月。`,
  });
  return { ok: true, units: bought, cost, fromCompanies, fromGovernment };
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

export function cancelUsedEquipmentOffer(
  world: WorldState,
  companyId: string,
  offerId: string,
): ActionResult {
  const index = world.equipmentMarket.offers.findIndex((entry) => entry.id === offerId);
  if (index < 0) return { ok: false, error: '设备出售委托不存在' };
  const offer = world.equipmentMarket.offers[index]!;
  if (offer.companyId !== companyId) return { ok: false, error: '只能撤销自己的设备出售委托' };
  const company = world.companies.find((entry) => entry.id === companyId);
  if (company) {
    company.equipment[offer.kind] = Math.floor((company.equipment[offer.kind] ?? 0) + offer.units);
  }
  world.equipmentMarket.offers.splice(index, 1);
  return { ok: true, note: `已撤销 ${offer.units} 台${offer.kind}设备的出售委托。` };
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
): EquipmentAssets {
  const assets = emptyEquipmentAssets();
  for (const kind of KINDS) {
    const capacity = capacityByKind[kind] ?? 0;
    const perUnit = config.equipment.catalog[kind].capacityPerUnit * techMultiplier;
    assets[kind] = Math.max(0, Math.round(capacity / Math.max(1, perUnit)));
  }
  return assets;
}
