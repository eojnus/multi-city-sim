/**
 * v1.6 §四：设备月度维护费（PLAN.md S2 / D1 / D2）。
 *
 * 口径（用户任务书 + D1/D2）：
 * - 每月每类设备维护费 = 企业持有该类设备台数 × 所在城市该类“新设备”当月市场参考单价 × 费率（默认 1%），
 *   逐类求和；所有设备（在工作、闲置、停产、二手、初始实物出资）都计费。
 * - 计费时点（D1）= **当月月初持有时点快照**（`Company.maintenanceBase`）与**月初参考价**
 *   （`Company.maintenancePrices`）。快照由 `beginEquipmentMaintenanceMonth` 在每个 tick 开头
 *   （advanceTime 之后、任何设备买卖/挂单/破产之前）写入：
 *     · 当月买入（含月中挂单后成交）的设备下月起计费；
 *     · 当月卖出/挂单/返还/破产的设备仍按月初台数计当月费用（防止月末交易绕费）；
 *     · 旧存档没有快照：下一次 tick 开头自动补齐，不重复创建设备，旧档正常开始计费；
 *       在没有 tick 的直调路径（测试/工具）缺省回退为当前 equipment 台数与当前市场价。
 * - 维护费是**独立期间费用**：全额（已付 + 未付）计入企业税前利润，现金支付进经营现金流；
 *   绝不资本化进库存或设备购置成本，也不得重复扣款（同一企业同一月只结算一次，见
 *   `settledCompanyIds`）。
 * - 收款方（D2）= 模拟范围外“城市外部设备维护服务商”：资金流出模拟范围，记独立月度流水
 *   `world.equipmentMarket.maintenanceMonth / maintenanceHistory` 与企业月度流水字段，
 *   **绝不**记为设备厂收入、政府税收或任何模拟内主体收入。
 * - 现金不足：先按既有规则合法融资（`requestCompanyWorkingCapital`：银行授信 + 玩家经营授权），
 *   仍不足则记录欠付 `Company.maintenanceArrears`，后果规则一致：
 *     · 欠付未清不得分红（服务商债权优先于股东）；
 *     · 已存在欠付时不再为维护费新增借款（避免以贷养欠）；
 *     · 清算时用企业现金优先补收当月费用与欠款，确实收不到的记服务商坏账（只留痕）。
 */
import type {
  Company,
  EquipmentAssets,
  EquipmentKind,
  EquipmentMaintenanceCityFlow,
  EquipmentMaintenanceMonth,
  LogEntry,
  WorldState,
} from '../contracts/types';
import type { DemoConfig } from '../../data/config';
import { round2 } from '../core/math';
import { emptyEquipmentAssets, equipmentUnitPrice } from './equipment';
import { requestCompanyWorkingCapital } from '../management/financing';

const KINDS: EquipmentKind[] = ['farm', 'industry', 'energy'];

const MAINTENANCE_NOTE =
  '设备维护费由模拟范围外“城市外部设备维护服务商”收取：资金流出模拟范围，不计入设备厂收入、政府税收或任何模拟内主体收入；台数按月初持有时点、单价按月初参考价（D1）。';

/** 单类设备的月度维护费明细（台数 × 月初参考单价 × 费率）。 */
export interface MaintenanceLine {
  kind: EquipmentKind;
  name: string;
  units: number;
  /** 计费单价（元/台/月，即该类“新设备”当月市场参考单价）。 */
  unitPrice: number;
  /** 该类本月维护费 = units × unitPrice × rate。 */
  fee: number;
}

/** 计费基准来源：月初快照 / 无 tick 的直调回退 / 本月新设（无快照，下月起计费）。 */
export type MaintenanceBasis = 'monthStartSnapshot' | 'currentFallback' | 'newThisMonth';

export interface CompanyMaintenanceDue {
  tick: number;
  basis: MaintenanceBasis;
  lines: MaintenanceLine[];
  unitsByKind: EquipmentAssets;
  /** 本月应计维护费合计。 */
  due: number;
}

/** 单企业单月维护费结算结果。 */
export interface CompanyMaintenanceSettlement {
  /** false 表示本月该企业已结算过（幂等，不会重复扣款）。 */
  settled: boolean;
  tick: number;
  basis: MaintenanceBasis;
  due: number;
  /** 本月现金支付的本月费用。 */
  paidToCurrent: number;
  /** 本月现金偿还的以前月份欠款（只冲负债，不重复计费用）。 */
  arrearsRepaid: number;
  /** 本月为付维护费而新增的银行借款。 */
  borrowed: number;
  /** 本月新增欠付。 */
  arrearsAdded: number;
  /** 月末欠付余额。 */
  arrearsOutstanding: number;
  /** 清算时注销的无法收回欠费（服务商坏账）。 */
  writtenOff: number;
  lines: MaintenanceLine[];
}

/** 维护费率（配置缺省 1%）。 */
export function equipmentMaintenanceRate(config: DemoConfig): number {
  const rate = config.equipment.maintenanceMonthlyRate;
  return Number.isFinite(rate) && rate > 0 ? rate : 0.01;
}

/** 企业未付维护费余额（旧档缺省 0）。 */
export function maintenanceArrearsOf(company: Company): number {
  const value = company.maintenanceArrears ?? 0;
  return Number.isFinite(value) && value > 0 ? round2(value) : 0;
}

/** 企业是否存在未清维护费欠付（供银行/清算/AI 只读判断）。 */
export function companyHasMaintenanceArrears(company: Company): boolean {
  return maintenanceArrearsOf(company) > 0.005;
}

function roundUnits(value: number): number {
  return Math.max(0, Math.floor(Number.isFinite(value) ? value : 0));
}

function cityFlow(cityId: string, month: EquipmentMaintenanceMonth): EquipmentMaintenanceCityFlow {
  month.byCity[cityId] ??= {
    due: 0,
    paid: 0,
    borrowed: 0,
    arrearsAdded: 0,
    arrearsRepaid: 0,
    arrearsOutstanding: 0,
    writtenOff: 0,
  };
  return month.byCity[cityId]!;
}

function emptyMonth(tick: number): EquipmentMaintenanceMonth {
  return {
    tick,
    unitsByKind: emptyEquipmentAssets(),
    feeByKind: emptyEquipmentAssets(),
    totalDue: 0,
    totalPaid: 0,
    totalBorrowed: 0,
    totalArrearsAdded: 0,
    totalArrearsRepaid: 0,
    totalArrearsOutstanding: 0,
    totalWrittenOff: 0,
    byCity: {},
    settledCompanyIds: [],
    note: MAINTENANCE_NOTE,
  };
}

/** 把上一月流水归档到 maintenanceHistory（有上限），不重复归档。 */
function archivePreviousMonth(world: WorldState, config: DemoConfig): void {
  const market = world.equipmentMarket;
  const current = market.maintenanceMonth;
  if (!current) return;
  const history = (market.maintenanceHistory ??= []);
  if (history.some((entry) => entry.tick === current.tick)) return;
  history.push(current);
  const limit = Math.max(1, Math.floor(config.equipment.maintenanceHistoryMonths ?? 60));
  if (history.length > limit) history.splice(0, history.length - limit);
}

/** 取（必要时建立）本月维护费流水；tick 变化时先归档上月。 */
function ensureMaintenanceMonth(world: WorldState, config: DemoConfig): EquipmentMaintenanceMonth {
  const market = world.equipmentMarket;
  const tick = world.time.tick;
  if (!market.maintenanceMonth || market.maintenanceMonth.tick !== tick) {
    archivePreviousMonth(world, config);
    market.maintenanceMonth = emptyMonth(tick);
  }
  return market.maintenanceMonth;
}

/**
 * v1.6 §四 D1：tick 开头的月初快照（每个 tick 只应在最开头调用一次）。
 *
 * 必须在任何设备买卖/挂单/破产之前调用（simulation.ts 在 advanceTime 之后、resetCompanyMonth
 * 与全部经营步骤之前调用）；在 tick 中途再调用会用当时台数覆盖月初快照，不应发生。
 * 同时归档上一月的维护费流水（独立费用流的月度边界）。
 */
export function beginEquipmentMaintenanceMonth(world: WorldState, config: DemoConfig): void {
  const market = world.equipmentMarket;
  const tick = world.time.tick;
  if (market.maintenanceMonth && market.maintenanceMonth.tick !== tick) {
    archivePreviousMonth(world, config);
  }
  const freshMonth = !market.maintenanceMonth || market.maintenanceMonth.tick !== tick;
  if (freshMonth) {
    market.maintenanceMonth = emptyMonth(tick);
  }
  const month = market.maintenanceMonth;
  // 月末欠付余额是“存量”而不是“本月增量”：以月初未付维护费合计为初值，
  // 之后各企业结算/补付/清算坏账只累加增量（arrearsDelta）。否则跨月存量会在
  // 清算注销时被重复扣减，出现负的月末欠付（v1.6 72 月报告实测 -2,839）。
  if (freshMonth && month) {
    for (const company of world.companies) {
      const carried = maintenanceArrearsOf(company);
      if (carried <= 0.005) continue;
      month.totalArrearsOutstanding = round2(month.totalArrearsOutstanding + carried);
      cityFlow(company.cityId, month).arrearsOutstanding = round2(
        cityFlow(company.cityId, month).arrearsOutstanding + carried,
      );
    }
  }
  for (const company of world.companies) {
    company.maintenanceBase = {
      farm: roundUnits(company.equipment.farm),
      industry: roundUnits(company.equipment.industry),
      energy: roundUnits(company.equipment.energy),
    };
    company.maintenancePrices = {
      farm: equipmentUnitPrice(world, company.cityId, 'farm', config),
      industry: equipmentUnitPrice(world, company.cityId, 'industry', config),
      energy: equipmentUnitPrice(world, company.cityId, 'energy', config),
    };
  }
}

/**
 * 只读：本月计费依据（台数、单价、逐类费用）。
 *
 * - 月初快照已建立（正常 tick 路径）：用快照台数与快照单价（D1 同一时点取价）；
 *   月初快照里没有该企业 = 本月新设企业 → 本月计费 0，下月起计费。
 * - 没有月初快照（旧档直调/测试）：回退当前 equipment 台数与当前市场价。
 */
export function monthlyMaintenanceDue(
  world: WorldState,
  company: Company,
  config: DemoConfig,
): CompanyMaintenanceDue {
  const rate = equipmentMaintenanceRate(config);
  const tick = world.time.tick;
  const snapshotActive = world.equipmentMarket.maintenanceMonth?.tick === tick;
  const base = company.maintenanceBase;
  const prices = company.maintenancePrices;
  let basis: MaintenanceBasis;
  if (snapshotActive && !base) {
    basis = 'newThisMonth';
  } else if (base) {
    basis = 'monthStartSnapshot';
  } else {
    basis = 'currentFallback';
  }
  const lines: MaintenanceLine[] = [];
  const unitsByKind = emptyEquipmentAssets();
  let due = 0;
  for (const kind of KINDS) {
    const units =
      basis === 'newThisMonth'
        ? 0
        : roundUnits(basis === 'monthStartSnapshot' ? base![kind] : company.equipment[kind]);
    const unitPrice =
      basis === 'monthStartSnapshot'
        ? round2(Math.max(1, prices?.[kind] ?? equipmentUnitPrice(world, company.cityId, kind, config)))
        : equipmentUnitPrice(world, company.cityId, kind, config);
    const fee = units > 0 ? round2(units * unitPrice * rate) : 0;
    unitsByKind[kind] = units;
    lines.push({
      kind,
      name: config.equipment.catalog[kind].name,
      units,
      unitPrice,
      fee,
    });
    due = round2(due + fee);
  }
  return { tick, basis, lines, unitsByKind, due };
}

/**
 * 只读：本月应计设备维护费合计（结算口径，含月初快照；见 monthlyMaintenanceDue）。
 *
 * 与 `estimatedMonthlyMaintenance` 的区别：本函数回答“本月账单是多少”，
 * 后者回答“按当前持有与当前价格，下个月大约是多少”。
 */
export function currentMonthMaintenance(
  world: WorldState,
  company: Company,
  config: DemoConfig,
): number {
  return monthlyMaintenanceDue(world, company, config).due;
}

/**
 * 只读（AI 用，签名稳定）：按**当前**设备台数与**当前**城市参考单价估算的月维护费。
 *
 * 用于公司经营计划的固定成本/现金储备估算：闲置设备也计入，所以用当前持有台数而不是
 * 产出利用率。不修改世界状态；旧档/无快照同样可用。
 */
export function estimatedMonthlyMaintenance(
  world: WorldState,
  company: Company,
  config: DemoConfig,
): number {
  const rate = equipmentMaintenanceRate(config);
  let cost = 0;
  for (const kind of KINDS) {
    const units = roundUnits(company.equipment[kind]);
    if (units <= 0) continue;
    const price = equipmentUnitPrice(world, company.cityId, kind, config);
    cost = round2(cost + units * price * rate);
  }
  return cost;
}

/** 只读：企业月度维护费明细（企业内部账：座机、单价、费用）——面板与 AI 共用。 */
export function maintenanceBreakdown(
  world: WorldState,
  company: Company,
  config: DemoConfig,
): MaintenanceLine[] {
  return monthlyMaintenanceDue(world, company, config).lines;
}

function addCityFlow(
  month: EquipmentMaintenanceMonth,
  cityId: string,
  delta: {
    due?: number;
    paid?: number;
    borrowed?: number;
    arrearsAdded?: number;
    arrearsRepaid?: number;
    arrearsDelta?: number;
    writtenOff?: number;
  },
): void {
  const flow = cityFlow(cityId, month);
  flow.due = round2(flow.due + (delta.due ?? 0));
  flow.paid = round2(flow.paid + (delta.paid ?? 0));
  flow.borrowed = round2(flow.borrowed + (delta.borrowed ?? 0));
  flow.arrearsAdded = round2(flow.arrearsAdded + (delta.arrearsAdded ?? 0));
  flow.arrearsRepaid = round2(flow.arrearsRepaid + (delta.arrearsRepaid ?? 0));
  flow.arrearsOutstanding = round2(flow.arrearsOutstanding + (delta.arrearsDelta ?? 0));
  flow.writtenOff = round2(flow.writtenOff + (delta.writtenOff ?? 0));
}

/**
 * 当月维护费结算（单企业）：融资 → 支付 → 欠付入账 → 写月度流水。
 *
 * 幂等：同一 tick 内同一企业只结算一次（`settledCompanyIds`），保证“只扣一次”。
 * 由 finance.settleCompanyFinance 在工资之后、所得税/还本付息/股息之前逐企业调用；
 * 清算路径由 disposeCompanyEquipment 在分配清算现金之前调用。
 */
export function settleCompanyMaintenanceForCompany(
  world: WorldState,
  config: DemoConfig,
  company: Company,
  log: LogEntry[],
  tick = world.time.tick,
): CompanyMaintenanceSettlement {
  const month = ensureMaintenanceMonth(world, config);
  const already = month.settledCompanyIds.includes(company.id);
  if (already) {
    return {
      settled: false,
      tick,
      basis: 'monthStartSnapshot',
      due: 0,
      paidToCurrent: 0,
      arrearsRepaid: 0,
      borrowed: 0,
      arrearsAdded: 0,
      arrearsOutstanding: maintenanceArrearsOf(company),
      writtenOff: 0,
      lines: [],
    };
  }
  const dueInfo = monthlyMaintenanceDue(world, company, config);
  const due = dueInfo.due;
  const arrearsBefore = maintenanceArrearsOf(company);
  const stats = company.lastMonth;

  // 1) 现金不足时按既有规则合法融资（银行授信 + 玩家经营授权）；有欠付时不再以贷养欠。
  let borrowed = 0;
  const shortfall = round2(Math.max(0, due - company.cash));
  if (shortfall > 0.005) {
    const blockedByArrears =
      (config.equipment.maintenanceArrearsBlocksFinancing ?? true) && arrearsBefore > 0.005;
    if (blockedByArrears) {
      log.push({
        tick,
        kind: 'warning',
        message: `${company.name} 已有设备维护费欠付 ${arrearsBefore.toFixed(0)}，按欠费规则不再为维护费新增借款；本月不足部分继续记欠付。`,
      });
    } else {
      const financing = requestCompanyWorkingCapital(
        world,
        config,
        tick,
        company,
        shortfall,
        '支付设备维护费',
      );
      borrowed = round2(Math.max(0, financing.drawn));
      if (borrowed <= 0 && financing.reason) {
        log.push({
          tick,
          kind: 'warning',
          message: `${company.name} 设备维护费资金不足：${financing.reason}（本月应计 ${due.toFixed(0)}）。`,
        });
      } else if (borrowed > 0) {
        log.push({
          tick,
          kind: 'system',
          message: `${company.name} 为支付设备维护费向银行借款 ${borrowed.toFixed(0)}（真实放款，计入企业债务与利息）。`,
        });
      }
    }
  }

  // 2) 先付本月费用，再以剩余现金偿还以前月份欠款（只冲负债，不重复计费用）。
  const paidToCurrent = round2(Math.min(company.cash, due));
  company.cash = round2(company.cash - paidToCurrent);
  const arrearsAdded = round2(due - paidToCurrent);
  const arrearsRepaid = round2(Math.min(company.cash, arrearsBefore));
  company.cash = round2(company.cash - arrearsRepaid);
  const arrearsOutstanding = round2(Math.max(0, arrearsBefore - arrearsRepaid) + arrearsAdded);
  company.maintenanceArrears = arrearsOutstanding;

  // 3) 企业月度流水（独立期间费用；金额为模拟范围外服务商收款）。
  // 同一企业同一月只结算一次（幂等），因此这里是赋值而不是累加：lastMonth 在 tick 开头
  // 已由 resetCompanyMonth 清零，赋值避免重复调用/迁移路径把同月费用算两遍。
  stats.maintenanceDue = due;
  stats.maintenancePaid = paidToCurrent;
  stats.maintenanceArrearsAdded = arrearsAdded;
  stats.maintenanceArrearsRepaid = arrearsRepaid;
  stats.maintenanceArrears = arrearsOutstanding;

  // 4) world 月度服务流水（独立于企业/政府账本）。
  for (const line of dueInfo.lines) {
    month.unitsByKind[line.kind] = round2(month.unitsByKind[line.kind] + line.units);
    month.feeByKind[line.kind] = round2(month.feeByKind[line.kind] + line.fee);
  }
  month.totalDue = round2(month.totalDue + due);
  month.totalPaid = round2(month.totalPaid + paidToCurrent + arrearsRepaid);
  month.totalBorrowed = round2(month.totalBorrowed + borrowed);
  month.totalArrearsAdded = round2(month.totalArrearsAdded + arrearsAdded);
  month.totalArrearsRepaid = round2(month.totalArrearsRepaid + arrearsRepaid);
  month.totalArrearsOutstanding = round2(
    month.totalArrearsOutstanding + arrearsOutstanding - arrearsBefore,
  );
  addCityFlow(month, company.cityId, {
    due,
    paid: paidToCurrent + arrearsRepaid,
    borrowed,
    arrearsAdded,
    arrearsRepaid,
    arrearsDelta: arrearsOutstanding - arrearsBefore,
  });
  month.settledCompanyIds.push(company.id);

  if (arrearsAdded > 0.005) {
    log.push({
      tick,
      kind: 'warning',
      message: `${company.name} 本月设备维护费 ${due.toFixed(0)} 中 ${arrearsAdded.toFixed(0)} 因现金不足形成欠付（累计欠付 ${arrearsOutstanding.toFixed(0)}，应付模拟范围外设备维护服务商）。`,
    });
  }
  return {
    settled: true,
    tick,
    basis: dueInfo.basis,
    due,
    paidToCurrent,
    arrearsRepaid,
    borrowed,
    arrearsAdded,
    arrearsOutstanding,
    writtenOff: 0,
    lines: dueInfo.lines,
  };
}

/**
 * 世界级结算入口：对当月尚未结算的企业逐家结算（幂等，可重复调用）。
 *
 * 生产路径由 finance 逐企业调用单企业结算（保证工资 → 维护费 → 税/债/股利的顺序）；
 * 本入口供测试与工具做“整月维护费结算”，返回本月服务流水（收款方为模拟范围外服务商）。
 */
export function settleCompanyMaintenance(
  world: WorldState,
  config: DemoConfig,
  log: LogEntry[],
): EquipmentMaintenanceMonth {
  const month = ensureMaintenanceMonth(world, config);
  for (const company of [...world.companies].sort((a, b) => a.id.localeCompare(b.id))) {
    if (month.settledCompanyIds.includes(company.id)) continue;
    settleCompanyMaintenanceForCompany(world, config, company, log);
  }
  return month;
}

/**
 * 清算路径：在分配清算现金之前补收当月维护费（D1：按月初台数计当月）。
 *
 * 企业清算时现金先被真实扣减，剩余现金才用于偿债/股东分配；确实收不到的欠款
 * 记服务商坏账（只留痕，不在模拟范围内制造任何资金）。返回 null 表示本月已结算过。
 */
export function settleCompanyMaintenanceOnLiquidation(
  world: WorldState,
  config: DemoConfig,
  company: Company,
  log: LogEntry[],
): CompanyMaintenanceSettlement | null {
  const result = settleCompanyMaintenanceForCompany(world, config, company, log);
  const target = result.settled ? null : result;
  // 已结算但仍有欠付（月末结算后、tick 之间清算）：欠款随企业消失，记服务商坏账。
  const arrears = maintenanceArrearsOf(company);
  if (arrears > 0.005 && (config.equipment.maintenanceWriteOffOnLiquidation ?? true)) {
    const month = ensureMaintenanceMonth(world, config);
    month.totalWrittenOff = round2(month.totalWrittenOff + arrears);
    month.totalArrearsOutstanding = round2(month.totalArrearsOutstanding - arrears);
    addCityFlow(month, company.cityId, { writtenOff: arrears, arrearsDelta: -arrears });
    company.maintenanceArrears = 0;
    company.lastMonth.maintenanceArrears = 0;
    log.push({
      tick: world.time.tick,
      kind: 'warning',
      message: `${company.name} 清算：未付设备维护费 ${arrears.toFixed(0)} 无法收回，记模拟范围外服务商坏账（不制造模拟内资金，不影响股东分配）。`,
    });
    if (result.settled) result.writtenOff = arrears;
    return result.settled ? result : null;
  }
  return target;
}

/**
 * 只读：某月维护费服务流水（默认最近一个月；含已归档与当月），供报告/面板核对。
 * 没有记录时返回 null（旧档首月尚未结算）。
 */
export function equipmentMaintenanceMonthFlow(
  world: WorldState,
  tick?: number,
): EquipmentMaintenanceMonth | null {
  const market = world.equipmentMarket;
  const target = tick ?? market.maintenanceMonth?.tick;
  if (target === undefined) {
    const history = market.maintenanceHistory ?? [];
    return history.length > 0 ? history[history.length - 1]! : null;
  }
  if (market.maintenanceMonth?.tick === target) return market.maintenanceMonth;
  const found = (market.maintenanceHistory ?? []).find((entry) => entry.tick === target);
  return found ?? null;
}
