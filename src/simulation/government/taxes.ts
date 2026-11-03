// v0.8：消费税、股息税与城内交通税收系数。
//
// 口径（首版暂定，集中配置在 config.tax）：
// - 消费税：居民消费品按含税标价成交，税 = 成交额 × 5%，卖方实收 = 成交额 − 税；
//   企业采购生产资料不征消费税。税收归消费者所在城市（消费发生地）。
// - 股息税：玩家与居民投资实体取得实际分红时按 10% 缴税；企业与政府股东首版不缴。
//   居民投资实体在“收到分红”时缴税，之后把已税分红返还居民收入，不再重复征税。
// - 交通税收系数：系数 = 0.5 + 保障率；保障率 = clamp(有效容量 / 需求, 0, 1)，
//   用上一完整游戏月的城内配送统计（world.transport.lastMonth.intracity，调用方须在
//   本月运输结算覆盖该字段之前取值）。无需求 → 中性系数 1.0；需求>0 且容量=0 → 保障率 0。
// - 四种税（个税、企业所得税、消费税、股息税）统一按系数调整：
//   政府实际入账 = 基准税额 × 系数；差额分别记为“交通财政加成”（系数>1，系统注入）
//   与“交通征收损耗”（系数<1，游戏化资金流出），纳税人不补缴、不退款。
//

import type {
  City,
  CityTaxAccrual,
  CityTaxMonth,
  WorldState,
} from '../contracts/types';
import type { DemoConfig } from '../../data/config';
import { clamp, round2 } from '../core/math';
import { recordFiscal } from './treasury';

export function createEmptyTaxState(): { accrualByCity: Record<string, CityTaxAccrual>; historyByCity: Record<string, CityTaxMonth[]> } {
  return { accrualByCity: {}, historyByCity: {} };
}

export function ensureTaxState(world: WorldState): void {
  if (!world.taxes || typeof world.taxes !== 'object') {
    world.taxes = createEmptyTaxState();
  }
  if (!world.taxes.accrualByCity || typeof world.taxes.accrualByCity !== 'object') {
    world.taxes.accrualByCity = {};
  }
  if (!world.taxes.historyByCity || typeof world.taxes.historyByCity !== 'object') {
    world.taxes.historyByCity = {};
  }
}

/** 本月该城已累积、尚未做交通系数调整的基准税额。 */
export function taxAccrualOf(world: WorldState, cityId: string): CityTaxAccrual {
  ensureTaxState(world);
  const existing = world.taxes.accrualByCity[cityId];
  if (existing) return existing;
  const created = { consumptionTax: 0, dividendTax: 0 };
  world.taxes.accrualByCity[cityId] = created;
  return created;
}

export function accrueConsumptionTax(world: WorldState, cityId: string, baseTax: number): void {
  const value = round2(Math.max(0, baseTax));
  if (value <= 0) return;
  const accrual = taxAccrualOf(world, cityId);
  accrual.consumptionTax = round2(accrual.consumptionTax + value);
}

export function accrueDividendTax(world: WorldState, cityId: string, baseTax: number): void {
  const value = round2(Math.max(0, baseTax));
  if (value <= 0) return;
  const accrual = taxAccrualOf(world, cityId);
  accrual.dividendTax = round2(accrual.dividendTax + value);
}

/**
 * 含税标价拆分：买方支付 gross，卖方实收 gross − tax，税计入消费发生地城市。
 * 例：标价 100、税率 5% → 税 5、卖方 95。
 */
export function splitConsumptionTax(
  gross: number,
  config: DemoConfig,
): { tax: number; sellerProceeds: number } {
  const amount = round2(Math.max(0, gross));
  if (amount <= 0) return { tax: 0, sellerProceeds: 0 };
  const tax = round2(amount * config.tax.consumptionTaxRate);
  return { tax, sellerProceeds: round2(amount - tax) };
}

export interface TransportTaxFactor {
  /** 交通保障率（0–1）；无需求时按中性系数反推，仅用于展示。 */
  guarantee: number;
  /** 税收系数：0.5（保障率 0）→ 1.5（保障率 1）；无需求为 1.0。 */
  factor: number;
}

/**
 * 某城下一结算月使用的交通税收系数。
 * 读取 world.transport.lastMonth.intracity（上一完整月的真实城内配送统计）。
 * 不得在本月运输结算写入之后再调用，否则会读到当月数据（任务书要求“上一完整月”）。
 */
export function transportTaxFactorFor(
  world: WorldState,
  cityId: string,
  config: DemoConfig,
): TransportTaxFactor {
  const transport = config.tax.transport;
  const stats = world.transport?.lastMonth?.intracity?.find((entry) => entry.cityId === cityId);
  if (!stats || stats.demand <= 0) {
    // 新游戏第一月 / 旧档无数据 / 当月无配送需求：中性系数，避免空城拿满额加成。
    return { guarantee: round2(transport.neutralFactorWhenNoDemand - transport.baseFactor), factor: transport.neutralFactorWhenNoDemand };
  }
  const guarantee =
    stats.capacity <= 0
      ? transport.minGuarantee
      : clamp(stats.capacity / stats.demand, transport.minGuarantee, transport.maxGuarantee);
  return {
    guarantee: round2(guarantee * 1000) / 1000,
    factor: round2((transport.baseFactor + guarantee) * 1000) / 1000,
  };
}

/** 一次性计算所有城市的系数（须在本月运输结算前调用）。 */
export function transportTaxFactors(
  world: WorldState,
  config: DemoConfig,
): Record<string, TransportTaxFactor> {
  const result: Record<string, TransportTaxFactor> = {};
  for (const city of world.cities) result[city.id] = transportTaxFactorFor(world, city.id, config);
  return result;
}

/** 把基准税额按系数拆成实际入账 + 加成/损耗。 */
export function adjustTaxByFactor(
  base: number,
  factor: number,
): { revenue: number; bonus: number; loss: number } {
  const amount = round2(Math.max(0, base));
  if (amount <= 0) return { revenue: 0, bonus: 0, loss: 0 };
  const revenue = round2(amount * factor);
  const delta = round2(revenue - amount);
  return { revenue, bonus: delta > 0 ? delta : 0, loss: delta < 0 ? -delta : 0 };
}

export interface TaxBaseInput {
  incomeTaxBase: number;
  corporateTaxBase: number;
}

/**
 * 财政月结时结算四种税：应用交通系数、入账、写财政流水与月度记录，并清零本月累计。
 * 调用方：government/fiscal.ts 的 settleGovernment（每城一次）。
 */
export function settleCityTaxes(
  world: WorldState,
  city: City,
  input: TaxBaseInput,
  factorInfo: TransportTaxFactor,
  config: DemoConfig,
  tick: number,
): CityTaxMonth {
  ensureTaxState(world);
  const accrual = taxAccrualOf(world, city.id);
  const income = adjustTaxByFactor(input.incomeTaxBase, factorInfo.factor);
  const corporate = adjustTaxByFactor(input.corporateTaxBase, factorInfo.factor);
  const consumption = adjustTaxByFactor(accrual.consumptionTax, factorInfo.factor);
  const dividend = adjustTaxByFactor(accrual.dividendTax, factorInfo.factor);

  const totalBase = round2(
    round2(input.incomeTaxBase) +
      round2(input.corporateTaxBase) +
      round2(accrual.consumptionTax) +
      round2(accrual.dividendTax),
  );
  const totalRevenue = round2(
    income.revenue + corporate.revenue + consumption.revenue + dividend.revenue,
  );
  const transportBonus = round2(income.bonus + corporate.bonus + consumption.bonus + dividend.bonus);
  const transportLoss = round2(income.loss + corporate.loss + consumption.loss + dividend.loss);

  city.treasury = round2(city.treasury + totalRevenue);

  // 财政流水按“基准税额 + 交通加成 − 交通征收损耗”记账，使流水净额恒等于政府实际入账。
  // 不能同时记“调整后的四税”和“加成/损耗”：市长面板按流水正负分别汇总收入/支出，
  // 那样会把同一笔交通调整重复计算（v0.8 验收问题 1）。
  const record = (kind: Parameters<typeof recordFiscal>[1]['kind'], amount: number, source: string): void => {
    if (amount <= 0) return;
    recordFiscal(
      world,
      { tick, cityId: city.id, kind, amount, source },
      config,
    );
  };
  record('incomeTax', round2(input.incomeTaxBase), '个人所得税（基准税额；交通调整单列）');
  record('corporateTax', round2(input.corporateTaxBase), '企业所得税（基准税额；交通调整单列）');
  record('consumptionTax', round2(accrual.consumptionTax), '消费税（基准税额；交通调整单列）');
  record('dividendTax', round2(accrual.dividendTax), '股息税（基准税额；交通调整单列）');
  record('transportTaxBonus', transportBonus, '交通财政加成（系数 >1，系统注入，不向纳税人补收）');
  if (transportLoss > 0) {
    recordFiscal(
      world,
      {
        tick,
        cityId: city.id,
        kind: 'transportTaxLoss',
        amount: -transportLoss,
        source: '交通征收损耗（系数 <1，基准税额未进入政府的部分，不退还纳税人）',
      },
      config,
    );
  }

  const month: CityTaxMonth = {
    tick,
    incomeTaxBase: round2(input.incomeTaxBase),
    corporateTaxBase: round2(input.corporateTaxBase),
    consumptionTaxBase: round2(accrual.consumptionTax),
    dividendTaxBase: round2(accrual.dividendTax),
    transportGuarantee: factorInfo.guarantee,
    transportFactor: factorInfo.factor,
    incomeTaxRevenue: income.revenue,
    corporateTaxRevenue: corporate.revenue,
    consumptionTaxRevenue: consumption.revenue,
    dividendTaxRevenue: dividend.revenue,
    transportBonus,
    transportLoss,
    totalBase,
    totalRevenue,
  };
  const history = (world.taxes.historyByCity[city.id] ??= []);
  history.push(month);
  const keep = Math.max(1, config.tax.historyMonths);
  if (history.length > keep) history.splice(0, history.length - keep);

  // 清零本月累计；财政月结是唯一入口，重复调用不会重复入账。
  world.taxes.accrualByCity[city.id] = { consumptionTax: 0, dividendTax: 0 };

  city.lastMonth.consumptionTax = consumption.revenue;
  city.lastMonth.dividendTax = dividend.revenue;
  city.lastMonth.transportTaxFactor = factorInfo.factor;
  city.lastMonth.transportTaxBonus = transportBonus;
  city.lastMonth.transportTaxLoss = transportLoss;

  return month;
}

/** 最近一个月税收记录（无记录时 undefined），供市长财政视图读取。 */
export function latestTaxMonth(world: WorldState, cityId: string): CityTaxMonth | undefined {
  ensureTaxState(world);
  const history = world.taxes.historyByCity[cityId];
  return history && history.length > 0 ? history[history.length - 1] : undefined;
}
