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
import { householdGroupsOfCity } from '../population/household-groups';
import { accrueConsumptionTax, splitConsumptionTax } from '../government/taxes';
import { allocateMoney } from '../population/household-economy';
import { adjustInventoryCost } from '../finance/inventory-cost';

/**
 * 城际容量结算（期末统一核算，避免订单先后造成差别）。
 *
 * 【暂定账务方案，待用户决定】
 * - 成交时买方按成交价全额付款并取得货物；卖方暂不入账；
 * - 期末按“城市对”汇总本月运输需求 / 网络容量，得到统一的惩罚比例；
 * - 卖方实际所得 = 该笔成交额 × (1 − 惩罚比例)；
 * - 差额退回买方（暂定方案），使买方净支付等于卖方实际所得；
 *   不向卖方额外扣款，也不把差额变成政府或运输方的收入。
 *   差额仍记为“容量不足造成的贸易收益损失”（相对原销售金额）。
 *
 * 这样买卖双方的实际收付款恒等：买方净支付 = 卖方所得 = gross − loss。
 * 另一种可选方案（买方按原价支付、差额作为无主体损失）尚未确认，因此未采用。
 */
/**
 * 把跨城交易的差额退回买方（暂定方案）。
 * 企业买方退回现金并冲减本月采购支出；居民退款交给财政结算合入下期可用资金。
 * 只处理资金账目，不改变库存或交易数量。
 */
function refundIntercityBuyer(
  world: WorldState,
  sale: PendingIntercitySale,
  amount: number,
  ledgers: WorldLedgers,
): number {
  const refund = round2(Math.max(0, amount));
  if (refund <= 0) return 0;
  if (sale.buyerCompanyId === 'households') {
    const buyerCity = world.cities.find((city) => city.id === sale.toCityId);
    if (buyerCity) {
      buyerCity.lastMonth.consumerSpend = round2(
        Math.max(0, buyerCity.lastMonth.consumerSpend - refund),
      );
    }
    const ledger = ledgers[sale.toCityId]?.[sale.good];
    if (ledger) {
      ledger.spend = round2(Math.max(0, ledger.spend - refund));
    }
    return buyerCity ? refund : 0;
  }
  const buyerCompany = world.companies.find((company) => company.id === sale.buyerCompanyId);
  if (!buyerCompany) return 0;
  buyerCompany.cash = round2(buyerCompany.cash + refund);
  buyerCompany.lastMonth.inputCost = round2(
    Math.max(0, buyerCompany.lastMonth.inputCost - refund),
  );
  // v1.3/v1.4 §6.6：退款是采购价的冲减，先冲减该商品剩余账面成本（最多到 0，不产生负成本）。
  // 货已售出/耗用时账面成本可能不足以吸收整笔退款：超出部分是真实的采购退款收益，
  // 必须计入当期利润（refundGain），否则这笔钱只出现在现金流里，利润与现金流口径不一致
  // （v1.4 探针：892 company-month 中 8 例，单例 4.32M/当月采购 48.86M）。
  const absorbed = adjustInventoryCost(buyerCompany, sale.good, -refund);
  const unabsorbed = round2(refund + absorbed);
  if (unabsorbed > 0.005) {
    buyerCompany.lastMonth.refundGain = round2(
      (buyerCompany.lastMonth.refundGain ?? 0) + unabsorbed,
    );
  }
  return 0;
}

/** 某城本月居民跨城交易退款：城市总额 + 按实际购买群体归属的明细。 */
export interface HouseholdRefundAllocation {
  total: number;
  /** key = householdGroupId；金额合计等于 total。 */
  byGroup: Record<string, number>;
}

export type HouseholdRefundsByCity = Record<string, HouseholdRefundAllocation>;

export function settleTransportMonth(
  world: WorldState,
  config: DemoConfig,
  log: LogEntry[],
  ledgers: WorldLedgers,
): HouseholdRefundsByCity {
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
  const householdRefunds: HouseholdRefundsByCity = {};
  const refundBuyer = (sale: PendingIntercitySale, amount: number): void => {
    const residentRefund = refundIntercityBuyer(world, sale, amount, ledgers);
    if (residentRefund <= 0) return;
    const summary = (householdRefunds[sale.toCityId] ??= { total: 0, byGroup: {} });
    summary.total = round2(summary.total + residentRefund);
    // 退款按“实际购买群体”归属；历史/企业代购等没有群体标记的退款按人口比例兜底分摊。
    const groupId = sale.householdGroupId;
    if (groupId) {
      summary.byGroup[groupId] = round2((summary.byGroup[groupId] ?? 0) + residentRefund);
      return;
    }
    const groups = householdGroupsOfCity(world, sale.toCityId);
    const shares = allocateMoney(
      residentRefund,
      groups.map((group) => group.people),
    );
    groups.forEach((group, index) => {
      const share = shares[index] ?? 0;
      if (share <= 0) return;
      summary.byGroup[group.id] = round2((summary.byGroup[group.id] ?? 0) + share);
    });
  };

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
        // 理论上不会出现（企业倒闭时清理待结算销售）；仍把付款退回买方，
        // 不让资金无解释地消失，也不凭空补钱给不存在的卖方。
        log.push({
          tick: world.time.tick,
          kind: 'warning',
          message: `跨城销售结算失败：卖方 ${sale.sellerCompanyId} 已不存在，${gross.toFixed(0)} 付款已退回买方。`,
        });
        refundBuyer(sale, gross);
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
          buyerRefund: gross,
          penaltyRate,
          demand,
          capacity,
        });
        continue;
      }

      // v0.8：居民跨城消费按“最终消费者实付”（容量退款后的 proceeds）计 5% 消费税，
      // 税归买方城市（消费发生地），卖方实收净额；企业间交易不征消费税。
      // 退款已先冲减买方消费支出/账本支出，因此以净支付为税基不会重复征或漏征。
      const householdSale = sale.buyerCompanyId === 'households';
      const consumptionTax = householdSale ? splitConsumptionTax(proceeds, config).tax : 0;
      const sellerNet = round2(proceeds - consumptionTax);
      seller.cash = round2(seller.cash + sellerNet);
      seller.lastMonth.revenue = round2(seller.lastMonth.revenue + sellerNet);
      if (sale.good === seller.recipeOutput) {
        seller.lastMonth.exported = round2(seller.lastMonth.exported + sale.qty);
      }
      if (consumptionTax > 0) {
        accrueConsumptionTax(world, sale.toCityId, consumptionTax);
        const buyerLedger = ledgers[sale.toCityId]?.[sale.good];
        if (buyerLedger) {
          buyerLedger.consumptionTax = round2(buyerLedger.consumptionTax + consumptionTax);
        }
      }

      // 【暂定】容量不足时把差额退回买方：买方此前按原价付款，期末净支付应等于卖方所得。
      // 不向卖方额外扣款，也不把差额变成政府/运输方收入。
      const buyerRefund = loss;
      refundBuyer(sale, buyerRefund);

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
        // sellerProceeds 保持“容量结算后、税前”的卖方所得，满足
        // grossValue = sellerProceeds + buyerRefund 的跨城账目恒等式（不变量校验）。
        // 消费税另从卖方实收中代扣并计入买方城市，故 seller.cash 实收为
        // sellerProceeds − consumptionTax。
        sellerProceeds: proceeds,
        capacityLoss: loss,
        buyerRefund,
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
      '城际容量按城市对期末统一核算；卖方所得按容量比例减少，差额暂定退回买方。',
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
  return householdRefunds;
}
