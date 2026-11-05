import type { ExternalExport, GoodId, WorldState } from '../contracts/types';
import type { DemoConfig } from '../../data/config';
import { GOODS } from '../../data/demo-data';
import type { CityLedgers } from '../markets/markets';
import { offeredStock, sumCityStock } from '../markets/markets';
import { round2 } from '../core/math';
import { issueInventory } from '../finance/inventory-cost';

/**
 * 区域外净出口（演示）：只吸收超出目标库存的消费品，价格按本城市场价的 90%。
 * 付款来自区域外，因此会增加本区域企业收入；这是开放经济演示，不对应真实国家。
 */
export function runExternalDemand(
  world: WorldState,
  ledgers: Record<string, CityLedgers>,
  config: DemoConfig,
): ExternalExport[] {
  if (!config.externalDemand.enabled) return [];
  const exports: ExternalExport[] = [];
  const consumerGoods = GOODS.filter((good) => good.category === 'consumer');

  for (const city of [...world.cities].sort((a, b) => a.id.localeCompare(b.id))) {
    const cityLedgers = ledgers[city.id];
    if (!cityLedgers) continue;
    for (const good of consumerGoods) {
      const producers = world.companies
        .filter((company) => company.cityId === city.id && company.recipeOutput === good.id)
        .sort((a, b) => a.id.localeCompare(b.id));
      if (producers.length === 0) continue;
      const monthlyOutput = producers.reduce(
        (total, company) => total + company.capacity * company.utilization,
        0,
      );
      if (monthlyOutput <= 0) continue;
      const targetStock = monthlyOutput * config.externalDemand.targetStockMonths;
      const safetyStock = monthlyOutput * config.externalDemand.minStockMonths;
      const stock = sumCityStock(world, city.id, good.id);
      const surplus = Math.max(0, stock - targetStock);
      const baseline = monthlyOutput * config.externalDemand.baselineShareOfOutput;
      const exportable = Math.max(0, stock - safetyStock);
      const cap = monthlyOutput * config.externalDemand.maxShareOfOutput;
      let remaining = Math.floor(Math.min(exportable, Math.max(baseline, surplus), cap));
      if (remaining < 1) continue;
      const unitPrice = round2(
        (city.market[good.id]?.price ?? good.basePrice) * config.externalDemand.priceFactor,
      );
      if (unitPrice <= 0) continue;

      for (const producer of producers) {
        if (remaining < 1) break;
        const available = offeredStock(producer, good.id);
        if (available <= 0) continue;
        const qty = Math.floor(Math.min(remaining, available));
        if (qty < 1) continue;
        const value = round2(qty * unitPrice);
        const currentStock = producer.inventory[good.id] ?? 0;
        if (qty > currentStock + 1e-6) continue;

        // ---- 原子提交 ----
        // v1.3：区域外出口按存货账面成本结转 COGS（区域外付款、不进入本地市场）。
        const soldCost = issueInventory(producer, good.id, qty);
        producer.lastMonth.cogs = round2((producer.lastMonth.cogs ?? 0) + soldCost);
        producer.cash = round2(producer.cash + value);
        producer.lastMonth.revenue = round2(producer.lastMonth.revenue + value);
        producer.lastMonth.exported = round2(producer.lastMonth.exported + qty);
        cityLedgers[good.id]!.externalExport = round2(
          cityLedgers[good.id]!.externalExport + qty,
        );

        exports.push({
          tick: world.time.tick,
          cityId: city.id,
          good: good.id,
          qty,
          unitPrice,
          value,
          note: '区域外净出口（演示），付款来自区域外。',
        });
        remaining -= qty;
      }
    }
  }
  return exports;
}

export function externalExportQty(
  countries: ExternalExport[],
  goodId: GoodId,
): number {
  return countries
    .filter((entry) => entry.good === goodId)
    .reduce((total, entry) => total + entry.qty, 0);
}
