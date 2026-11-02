import type { LogEntry, TradeFlow, WorldState } from '../contracts/types';
import type { DemoConfig } from '../../data/config';
import { RECIPES } from '../../data/demo-data';
import { round2 } from '../core/math';
import { productionTarget } from '../production/production';
import { planCompanyWorkingCapital, drawPlannedWorkingCapital } from '../management/financing';
import { corridorKey, recordIntercitySale } from '../transport/network';

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

    // 先计算“现金 + 已裁决的融资额度”能买到的数量。融资额度必须先过经营模式/授权
    // （验收问题 2），且只在成交条件全部确认后放款（验收问题 7：不留部分状态）。
    const financingNeed = round2(Math.max(0, route.monthlyTarget * price - importer.cash));
    const financing = planCompanyWorkingCapital(
      world,
      config,
      world.time.tick,
      importer,
      financingNeed,
      '跨城进口现金不足',
    );
    if (financing.denied && financingNeed > 0.01) {
      log.push({
        tick: world.time.tick,
        kind: 'warning',
        message: `${importer.name} 跨城进口受可用现金限制：${financing.reason}`,
      });
    }
    const creditRoom = financing.limit;
    const maxAffordableQty =
      price > 0
        ? Math.floor(((Math.max(0, importer.cash) + creditRoom) / price) * 100) / 100
        : 0;
    let qty = Math.min(
      route.monthlyTarget,
      exporter.inventory[route.good] ?? 0,
      importerNeed,
      maxAffordableQty,
    );
    qty = Math.floor(qty * 100) / 100;
    if (qty < 1) continue;
    const value = round2(qty * price);
    if (value <= 0) continue;
    const borrowNeeded = round2(Math.max(0, value - importer.cash));
    if (borrowNeeded > creditRoom + 1e-6) continue;

    // 所有条件都已确认，再提交融资、货物、资金和成交记录。
    const exporterStock = exporter.inventory[route.good] ?? 0;
    if (exporterStock < qty || importer.cash + borrowNeeded < value - 1e-6) continue;

    // v0.4：进口融资走独立银行（形成贷款合同）；失败则放弃本笔交易，不留部分状态。
    if (borrowNeeded > 0) {
      // 每笔借款独立合同（独立批次），仍受同一授信额度限制。
      const drawn = drawPlannedWorkingCapital(
        world,
        config,
        world.time.tick,
        importer,
        borrowNeeded,
      );
      if (drawn + 1e-6 < borrowNeeded) {
        log.push({
          tick: world.time.tick,
          kind: 'warning',
          message: `${importer.name} 进口融资放款不足（需 ${borrowNeeded.toFixed(2)}，实得 ${drawn.toFixed(2)}），本笔交易取消。`,
        });
        continue;
      }
    }
    if (importer.cash + 1e-6 < value) continue;

    // ---- 原子提交 ----
    exporter.inventory[route.good] = round2(exporterStock - qty);
    importer.inventory[route.good] = round2((importer.inventory[route.good] ?? 0) + qty);
    importer.cash = round2(importer.cash - value);
    importer.lastMonth.inputCost = round2(importer.lastMonth.inputCost + value);
    // 出口所得在期末按运输容量结算；容量不足时减少卖方该笔收益，不额外扣款。
    recordIntercitySale(world, {
      tick: world.time.tick,
      path: 'contract',
      fromCityId: fromCity.id,
      toCityId: toCity.id,
      corridorKey: corridorKey(fromCity.id, toCity.id),
      sellerCompanyId: exporter.id,
      buyerCompanyId: importer.id,
      good: route.good,
      qty,
      grossValue: value,
    });

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
      path: 'contract',
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
