import type {
  LogEntry,
  PendingIntercitySale,
  TransportCorridorStats,
  TransportIntracityStats,
  TransportTradeRecord,
  WorldState,
} from '../contracts/types';
import type { DemoConfig } from '../../data/config';
import { GOOD_IDS } from '../companies/company';
import type { WorldLedgers } from '../markets/markets';
import { clamp, round2 } from '../core/math';
import {
  capacityPenalty,
  corridorCapacity,
  intracityCapacity,
} from './network';
import { intercityTradeSupportPayment } from '../policies/policies';

/**
 * 城际容量结算（期末统一核算，避免订单先后造成差别）。
 *
 * 【暂定账务方案，待用户决定】
 * - 成交时买方按成交价全额付款并取得货物；卖方暂不入账；
 * - 期末按“城市对”汇总本月运输需求 / 网络容量，得到统一的惩罚比例；
 * - 卖方实际所得 = 该笔成交额 × (1 − 惩罚比例)；
 * - 差额记为“容量不足造成的贸易收益损失”，不进入任何主体收入，
 *   不从企业已有现金额外扣款，也不向政府或运输方收取罚金。
 *
 * 这样买方付款、卖方所得与损失三项恒等：gross = proceeds + loss。
 * 另一种可选方案（买方也少付）尚未确认，因此未采用。
 */
export function settleTransportMonth(
  world: WorldState,
  config: DemoConfig,
  log: LogEntry[],
  ledgers: WorldLedgers,
): void {
  const pending = [...world.transport.pendingSales].sort(
    (a, b) =>
      a.corridorKey.localeCompare(b.corridorKey) ||
      a.sellerCompanyId.localeCompare(b.sellerCompanyId) ||
      a.good.localeCompare(b.good) ||
      b.grossValue - a.grossValue,
  );

  const groups = new Map<string, PendingIntercitySale[]>();
  for (const sale of pending) {
    const list = groups.get(sale.corridorKey) ?? [];
    list.push(sale);
    groups.set(sale.corridorKey, list);
  }

  const corridors: TransportCorridorStats[] = [];
  const trades: TransportTradeRecord[] = [];
  let lossTotal = 0;
  let freightSubsidy = 0;
  let totalDemand = 0;
  let totalCapacity = 0;

  for (const key of [...groups.keys()].sort((a, b) => a.localeCompare(b))) {
    const sales = groups.get(key)!;
    const first = sales[0]!;
    const capacity = corridorCapacity(world, first.fromCityId, first.toCityId, config);
    const demand = round2(sales.reduce((sum, sale) => sum + sale.qty, 0));
    const { overloadRatio, penaltyRate } = capacityPenalty(demand, capacity, config);
    totalDemand = round2(totalDemand + demand);
    totalCapacity = round2(totalCapacity + capacity);
    corridors.push({
      corridorKey: key,
      fromCityId: first.fromCityId,
      toCityId: first.toCityId,
      demand,
      capacity,
      overloadRatio,
      penaltyRate,
    });

    for (const sale of sales) {
      const seller = world.companies.find((company) => company.id === sale.sellerCompanyId);
      const gross = round2(Math.max(0, sale.grossValue));
      const proceeds = round2(gross * (1 - penaltyRate));
      const loss = round2(gross - proceeds);
      lossTotal = round2(lossTotal + loss);

      if (!seller) {
        // 理论上不会出现（企业倒闭时清理待结算销售）；保留明确告警，不凭空补钱。
        log.push({
          tick: world.time.tick,
          kind: 'warning',
          message: `跨城销售结算失败：卖方 ${sale.sellerCompanyId} 已不存在，${gross.toFixed(0)} 付款无法入账。`,
        });
        trades.push({
          tick: world.time.tick,
          path: sale.path,
          corridorKey: key,
          fromCityId: sale.fromCityId,
          toCityId: sale.toCityId,
          sellerCompanyId: sale.sellerCompanyId,
          buyerCompanyId: sale.buyerCompanyId,
          good: sale.good,
          qty: sale.qty,
          grossValue: gross,
          sellerProceeds: 0,
          capacityLoss: gross,
          penaltyRate,
          demand,
          capacity,
        });
        continue;
      }

      seller.cash = round2(seller.cash + proceeds);
      seller.lastMonth.revenue = round2(seller.lastMonth.revenue + proceeds);
      if (sale.good === seller.recipeOutput) {
        seller.lastMonth.exported = round2(seller.lastMonth.exported + sale.qty);
      }

      // 跨城贸易支持：财政补偿卖方该笔容量损失（不是罚款，也不是凭空收入）。
      let subsidy = 0;
      if (loss > 0) {
        const sellerCity = world.cities.find((city) => city.id === sale.fromCityId);
        if (sellerCity) {
          subsidy = intercityTradeSupportPayment(world, sellerCity, loss, config, seller.id);
          if (subsidy > 0) {
            seller.cash = round2(seller.cash + subsidy);
            freightSubsidy = round2(freightSubsidy + subsidy);
          }
        }
      }

      trades.push({
        tick: world.time.tick,
        path: sale.path,
        corridorKey: key,
        fromCityId: sale.fromCityId,
        toCityId: sale.toCityId,
        sellerCompanyId: sale.sellerCompanyId,
        buyerCompanyId: sale.buyerCompanyId,
        good: sale.good,
        qty: sale.qty,
        grossValue: gross,
        sellerProceeds: proceeds,
        capacityLoss: loss,
        penaltyRate,
        demand,
        capacity,
      });
    }
  }

  // 城内配送：用本期实际本地成交 + 进口量衡量配送需求，供下月效率使用。
  const intracity: TransportIntracityStats[] = [];
  for (const city of [...world.cities].sort((a, b) => a.id.localeCompare(b.id))) {
    const network = world.transport.intracity.find((entry) => entry.cityId === city.id);
    if (!network) continue;
    const capacity = intracityCapacity(network, config);
    const cityLedgers = ledgers[city.id];
    let demand = 0;
    if (cityLedgers) {
      for (const goodId of GOOD_IDS) {
        const ledger = cityLedgers[goodId];
        if (!ledger) continue;
        demand += ledger.sold + ledger.intercityImported;
      }
    }
    demand = round2(demand);
    const utilization = capacity > 0 ? round2(demand / capacity) : demand > 0 ? 1 : 0;
    const efficiency =
      demand <= 0 ? 1 : clamp(capacity > 0 ? capacity / demand : config.transport.intracity.efficiencyFloor, config.transport.intracity.efficiencyFloor, 1);
    intracity.push({
      cityId: city.id,
      demand,
      capacity,
      utilization,
      deliveryEfficiency: round2(efficiency),
    });
  }

  const overloadRatio = totalDemand > 0 ? clamp((totalDemand - totalCapacity) / totalDemand, 0, 1) : 0;
  const penaltyRate = totalDemand > 0 ? clamp(overloadRatio * config.transport.penalty.strength, 0, config.transport.penalty.max) : 0;

  world.transport.lastMonth = {
    tick: world.time.tick,
    demand: totalDemand,
    capacity: totalCapacity,
    overloadRatio: round2(overloadRatio),
    penaltyRate: round2(penaltyRate),
    capacityLossTotal: lossTotal,
    freightSubsidy,
    maintenancePaid: world.transport.lastMonth.maintenancePaid,
    corridors,
    intracity,
    trades,
    note:
      '城际容量按城市对期末统一核算；买方付款不变，卖方所得按容量比例减少，差额记为收益损失（暂定方案）。',
  };
  world.transport.pendingSales = [];

  const overloaded = corridors.filter((entry) => entry.penaltyRate > 0);
  if (overloaded.length > 0) {
    log.push({
      tick: world.time.tick,
      kind: 'trade',
      message: `跨城运输容量不足：${overloaded.length} 条城市联系出现收益损失，合计 ${lossTotal.toFixed(0)}${freightSubsidy > 0 ? `（贸易支持补偿 ${freightSubsidy.toFixed(0)}）` : ''}。`,
    });
  }
}
