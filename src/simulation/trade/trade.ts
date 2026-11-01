import type { LogEntry, TradeFlow, WorldState } from '../contracts/types';
import type { DemoConfig } from '../../data/config';
import { RECIPES } from '../../data/demo-data';
import { round2 } from '../core/math';
import { productionTarget } from '../production/production';
import { ensureLiquidity } from '../companies/credit';

/**
 * 点对点跨城市企业贸易。先校验双方城市、商品、库存、需求与资金，
 * 再一次性转移货物和资金；失败不留下部分变化。
 */
export function executeTradeRoutes(
  world: WorldState,
  config: DemoConfig,
  log: LogEntry[],
  transportEnabled = false,
): TradeFlow[] {
  const flows: TradeFlow[] = [];

  for (const route of [...world.tradeRoutes].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!route.active) continue;
    const exporter = world.companies.find((company) => company.id === route.fromCompanyId);
    const importer = world.companies.find((company) => company.id === route.toCompanyId);
    const fromCity = world.cities.find((city) => city.id === route.fromCityId);
    const toCity = world.cities.find((city) => city.id === route.toCityId);
    if (!exporter || !importer || !fromCity || !toCity) continue;
    if (exporter.cityId !== fromCity.id || importer.cityId !== toCity.id) continue;
    if (exporter.recipeOutput !== route.good) continue;

    const recipe = RECIPES[importer.recipeOutput];
    const input = recipe?.inputs.find((entry) => entry.good === route.good);
    if (!input) continue;
    const importerTarget = productionTarget(importer);
    const importerNeed = Math.max(
      0,
      importerTarget * input.qty - (importer.inventory[route.good] ?? 0),
    );
    const price = toCity.market[route.good]?.price ?? 0;
    if (price <= 0) continue;

    let qty = Math.min(
      route.monthlyTarget,
      exporter.inventory[route.good] ?? 0,
      importerNeed,
    );
    qty = Math.floor(qty * 100) / 100;
    if (qty < 1) continue;
    let value = round2(qty * price);
    if (value <= 0) continue;
    ensureLiquidity(importer, value, config);
    if (importer.cash < value) {
      qty = Math.floor((importer.cash / price) * 100) / 100;
      value = round2(qty * price);
    }
    if (qty < 1) continue;

    // ---- 原子提交 ----
    const exporterStock = exporter.inventory[route.good] ?? 0;
    if (exporterStock < qty || importer.cash < value) continue;
    exporter.inventory[route.good] = round2(exporterStock - qty);
    importer.inventory[route.good] = round2((importer.inventory[route.good] ?? 0) + qty);
    exporter.cash = round2(exporter.cash + value);
    importer.cash = round2(importer.cash - value);
    exporter.lastMonth.revenue = round2(exporter.lastMonth.revenue + value);
    exporter.lastMonth.sold = round2(exporter.lastMonth.sold + qty);
    exporter.lastMonth.exported = round2(exporter.lastMonth.exported + qty);
    importer.lastMonth.inputCost = round2(importer.lastMonth.inputCost + value);

    const flow: TradeFlow = {
      routeId: route.id,
      tick: world.time.tick,
      fromCityId: fromCity.id,
      toCityId: toCity.id,
      fromCompanyId: exporter.id,
      toCompanyId: importer.id,
      good: route.good,
      qty,
      unitPrice: price,
      value,
    };
    flows.push(flow);
    log.push({
      tick: world.time.tick,
      kind: 'trade',
      message: `${fromCity.name} ${exporter.name} → ${toCity.name} ${importer.name}：${route.good} ${qty.toFixed(0)} 单位，价值 ${value.toFixed(0)}。`,
    });

    if (transportEnabled) {
      // 明确保留：运输能力、运费与物流损耗尚未进入结算。
    }
  }

  return flows;
}
