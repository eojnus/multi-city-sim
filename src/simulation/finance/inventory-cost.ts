import type { Company, GoodId } from '../contracts/types';
import { GOOD_IDS } from '../companies/company';
import { round2 } from '../core/math';

/**
 * v1.3：存货成本账面（moving weighted average）。
 *
 * 口径（与 task-47 §3 对应）：
 * - 采购/调入：`receiveInventory` 同时增加数量与账面成本（买家实付金额，含跨城加价，
 *   运输结算的退款由 `adjustInventoryCost` 冲减，保证账面成本与实付净额一致）；
 * - 生产消耗原料：`issueInventory` 按移动加权平均单价取出成本，由生产模块转入成品存货，
 *   这一步不产生费用（只是资产内部结转）；
 * - 销售/调出：`issueInventory` 返回的账面成本即当期 COGS，由各成交模块累加到
 *   `lastMonth.cogs`；
 * - 破产清算/报废：`writeOffInventory` 一次性注销剩余账面价值，记入
 *   `lastMonth.inventoryWriteOff`，不重复计入 COGS。
 *
 * 因此“采购 → 原料库存 → 成品库存 → 销售”是一条成本链，利润只受 COGS 与期间费用影响，
 * 未售成品留在期末存货资产中，不会被当期费用化（旧口径把采购当成本直接计入利润）。
 *
 * 存档兼容：`Company.inventoryCost` 是可选字段。旧 v9 存档没有它时，
 * `ensureInventoryCost`（以及 save 读取路径）按当期市场价把现有库存入账，
 * 不产生 NaN/负成本；之后各月按真实成本滚动。
 */

/** 全商品清零的存货成本账面。 */
export function emptyInventoryCost(): Record<GoodId, number> {
  const cost = {} as Record<GoodId, number>;
  for (const goodId of GOOD_IDS) cost[goodId] = 0;
  return cost;
}

/**
 * 确保企业有完整、合法的存货成本账面；缺失/非法项按“数量 × 参考单价”补齐。
 *
 * 只在字段缺失、非有限数或负数时补写，正常账面不改变，因此可重复调用（幂等）。
 * 参考单价由调用方提供（例如所在城市市场价）；不提供时缺省为 0。
 */
export function ensureInventoryCost(
  company: Company,
  priceOf?: (goodId: GoodId) => number,
): Record<GoodId, number> {
  if (!company.inventoryCost) company.inventoryCost = emptyInventoryCost();
  const book = company.inventoryCost;
  let changed = false;
  for (const goodId of GOOD_IDS) {
    const qty = Math.max(0, company.inventory[goodId] ?? 0);
    const price = priceOf ? priceOf(goodId) : 0;
    const fallback = round2(qty * (Number.isFinite(price) && price > 0 ? price : 0));
    const current = book[goodId];
    if (!Number.isFinite(current) || (current as number) < 0) {
      book[goodId] = fallback;
      changed = true;
    } else if (qty <= 1e-9 && (current as number) > 0.005) {
      // 数量已为 0 但账面残留（旧档取整/外部写入）：清零，避免“无货却有成本”。
      book[goodId] = 0;
      changed = true;
    }
  }
  if (changed) {
    // 触发一次显式写回，便于调试与存档校验看到完整账面。
    company.inventoryCost = book;
  }
  return book;
}

/** 某商品当前账面总成本（旧档/缺字段时按 0 处理，由 ensureInventoryCost 负责补齐）。 */
export function inventoryBookValue(company: Company, goodId: GoodId): number {
  const book = company.inventoryCost;
  if (!book) return 0;
  const value = book[goodId];
  return Number.isFinite(value) && (value as number) > 0 ? round2(value as number) : 0;
}

/** 企业全部存货的账面总价值（期末存货资产）。 */
export function totalInventoryBookValue(company: Company): number {
  return round2(GOOD_IDS.reduce((total, goodId) => total + inventoryBookValue(company, goodId), 0));
}

/** 某商品的移动加权平均单位成本；数量为 0 时返回 0（有成本无数量视为异常，由 ensure 清理）。 */
export function inventoryAverageUnitCost(company: Company, goodId: GoodId): number {
  const qty = company.inventory[goodId] ?? 0;
  if (!(qty > 1e-9)) return 0;
  return round2(inventoryBookValue(company, goodId) / qty);
}

/**
 * 入库：数量与账面成本同时增加。
 *
 * @param totalCost 本次入库对应的总成本（现金采购实付/生产结转成本）。
 *   非有限或负数按 0 处理，保证账面不出现 NaN/负成本。
 */
export function receiveInventory(
  company: Company,
  goodId: GoodId,
  qty: number,
  totalCost: number,
): void {
  const addQty = round2(Math.max(0, Number.isFinite(qty) ? qty : 0));
  if (addQty <= 0) return;
  const book = ensureInventoryCost(company);
  const addCost = round2(Math.max(0, Number.isFinite(totalCost) ? totalCost : 0));
  company.inventory[goodId] = round2((company.inventory[goodId] ?? 0) + addQty);
  book[goodId] = round2(inventoryBookValue(company, goodId) + addCost);
}

/**
 * 出库：按移动加权平均单价取走数量，返回本次结转的账面成本。
 *
 * 调用方必须保证数量足够（或传入的 qty 不超过库存）；这里再做一次夹取，
 * 宁可少取也不产生负库存/负账面成本。取完最后一点数量时清空残留成本，
 * 避免浮点残差让后续 COGS 出现 0.01 级毛刺。
 */
export function issueInventory(company: Company, goodId: GoodId, qty: number): number {
  const book = ensureInventoryCost(company);
  const available = round2(Math.max(0, company.inventory[goodId] ?? 0));
  const issueQty = round2(Math.min(available, Math.max(0, Number.isFinite(qty) ? qty : 0)));
  if (issueQty <= 0) return 0;
  const bookValue = inventoryBookValue(company, goodId);
  const unitCost = available > 1e-9 ? bookValue / available : 0;
  let cost = round2(issueQty * unitCost);
  if (cost > bookValue) cost = bookValue;
  company.inventory[goodId] = round2(available - issueQty);
  if (company.inventory[goodId] <= 1e-9) {
    // 清空：剩余账面价值全部随最后一批结转，库存归零。
    company.inventory[goodId] = 0;
    cost = bookValue;
    book[goodId] = 0;
  } else {
    book[goodId] = round2(Math.max(0, bookValue - cost));
  }
  return round2(cost);
}

/**
 * 调整某商品账面成本（只调成本、不调数量）。
 *
 * 用于跨城运输结算把多付的运费退回买方：采购净成本下降。
 * 减少额不超过当前账面价值（货已消耗/售出时不产生负成本，差额视为当期收益调整，
 * 由调用方决定是否记录，当前实现只做账面冲减）。
 */
export function adjustInventoryCost(company: Company, goodId: GoodId, delta: number): number {
  const book = ensureInventoryCost(company);
  const current = inventoryBookValue(company, goodId);
  const change = Number.isFinite(delta) ? delta : 0;
  const next = round2(Math.max(0, current + change));
  book[goodId] = next;
  return round2(next - current);
}

/**
 * 注销全部库存并返回逐商品明细（破产清算/报废）。
 *
 * 账面价值按当前账面成本记录；旧档没有账面时按参考单价估值。
 * 调用后企业库存与账面成本都清零，调用方把返回的总额记入 inventoryWriteOff。
 */
export function writeOffInventory(
  company: Company,
  priceOf?: (goodId: GoodId) => number,
): { good: GoodId; qty: number; bookValue: number }[] {
  const book = ensureInventoryCost(company, priceOf);
  const written: { good: GoodId; qty: number; bookValue: number }[] = [];
  for (const goodId of GOOD_IDS) {
    const qty = round2(Math.max(0, company.inventory[goodId] ?? 0));
    if (qty <= 0) {
      company.inventory[goodId] = 0;
      book[goodId] = 0;
      continue;
    }
    const value = inventoryBookValue(company, goodId);
    written.push({ good: goodId, qty, bookValue: value });
    company.inventory[goodId] = 0;
    book[goodId] = 0;
  }
  return written;
}
