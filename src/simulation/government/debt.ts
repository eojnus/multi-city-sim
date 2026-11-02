/**
 * 政府债务、应付项、银行垫付与破产（v0.7 契约骨架，块0 空实现）。
 *
 * 月结唯一入口：`settleGovernmentDebt`，在 `computeCityGdp` **之后**调用（DECISIONS v1.2 #22）。
 * 内部固定顺序（冻结，业务实现不得调整）：
 *   ① 计提应计利息并生成应付项：先债券按月（本金 × couponRateAnnual / 12）、政府贷款按月
 *      （outstanding × rateMonthly）计提，再生成本月到期的票息、到期债券本金、政府贷款分期。
 *      债券票息固定 3 期：M12、M24、M36（每满 interestPeriodMonths=12 一次）；**M36 同时还本**，
 *      应付项必须包含「M36 第 3 期票息」与「M36 到期本金」两笔（v1.4 #33，不能只按 2 期建模）。
 *   ② 票息/到期兑付：先用财政余额；票息不足 → 欠付利息（银行不垫付）；
 *      到期本金+欠息不足 → 银行无条件垫付（形成 bondAdvance 贷款，见 advances 记录）；
 *   ③ 银行贷款分期还款：财政不足时欠付，不影响破产判定之外的其他系统；
 *   ④ 债务汇总与破产判定：债务/GDP ≥ config.government.fiscalRisk.bankruptAt 即破产；
 *   ⑤ 破产清算与重选：银行立即兑付未到期债券本金+按实际持有月份计提的未付利息（不付未来利息），
 *      随后原有银行贷款与本次垫付形成的贷款一并勾销（不存在按比例清偿）；
 *      判定当月结算内立即触发重选，过渡期现任市长看守、仅维持性操作。
 *
 * 总负债口径（DECISIONS v1.1 #11 更正版 v1.3）：只计一次垫付——
 *   totalDebt = 政府全部银行贷款未偿本金（含 bondAdvance 垫付转贷款）
 *               + 未偿债券本金
 *               + 已计提未付利息（含欠付票息与欠付贷款利息）
 * 面板可拆分展示 ordinaryLoan / advanceLoan，但判定不得重复相加；GovernmentAdvanceRecord
 * 只是可追溯流水，**不得**再作为独立负债项目加入 totalDebt。
 * 公共口径统一由 `metrics.ts` 的 `cityDebt` / `assessCityFiscalRisk` / `recent12MonthGdp`
 * 提供（v1.4 #36），本文件不得另写一套。
 *
 * 本文件当前只提供签名与空实现，业务体由游戏程序在块2 填充；签名冻结后只增不改。
 */
import type {
  City,
  GovernmentAdvanceRecord,
  GovernmentBankruptcyRecord,
  GovernmentDebtSummary,
  GovernmentLoanContract,
  GovernmentPayable,
  LogEntry,
  WorldState,
} from '../contracts/types';
import type { DemoConfig } from '../../data/config';
import { assessCityFiscalRisk } from './metrics';

export interface GovernmentSettlementResult {
  tick: number;
  cityId: string;
  payablesCreated: number;
  payablesPaid: number;
  payablesInArrears: number;
  advancedByBank: number;
  bankrupted: boolean;
  debtSummary: GovernmentDebtSummary | null;
  problems: string[];
}

export interface GovernmentAdvanceResult {
  ok: boolean;
  advance: GovernmentAdvanceRecord | null;
  loan: GovernmentLoanContract | null;
  amountAdvanced: number;
  error?: string;
}

/**
 * 月结唯一入口：对全部城市按固定六阶段顺序结算政府债务（对同一 tick 幂等：
 * 已记录在 city.government.settledTicks 的 tick 不得重复兑付/清算）。
 */
export function settleGovernmentDebt(
  world: WorldState,
  config: DemoConfig,
  logs: LogEntry[],
): void {
  void world;
  void config;
  void logs;
  // TODO(块2)：遍历城市调用 settleCityGovernmentDebt，并处理破产重选触发（与 elections 模块衔接）。
}

/** 单城六阶段顺序结算（供入口调用；也可被测试直接驱动）。 */
export function settleCityGovernmentDebt(
  world: WorldState,
  city: City,
  config: DemoConfig,
  logs: LogEntry[],
): GovernmentSettlementResult {
  void world;
  void city;
  void config;
  void logs;
  // TODO(块2)：阶段①–⑥，返回本城结算摘要。
  return {
    tick: world.time.tick,
    cityId: city.id,
    payablesCreated: 0,
    payablesPaid: 0,
    payablesInArrears: 0,
    advancedByBank: 0,
    bankrupted: false,
    debtSummary: null,
    problems: [],
  };
}

/**
 * 阶段②：计提本月应计利息（债券 + 政府银行贷款），返回本次计提合计。
 * 必须在破产判定前执行（DECISIONS v1.1 #11：避免利息漏计导致判定晚一拍）。
 */
export function accrueGovernmentDebtInterest(
  world: WorldState,
  city: City,
  config: DemoConfig,
  tick: number,
): number {
  void world;
  void city;
  void config;
  void tick;
  return 0;
}

/** 阶段①：生成本月应付项（幂等锚：cityId + tick + kind + issuanceId/loanId/holder）。 */
export function buildGovernmentPayables(
  world: WorldState,
  city: City,
  config: DemoConfig,
  tick: number,
): GovernmentPayable[] {
  void world;
  void city;
  void config;
  void tick;
  return [];
}

/** 阶段③④：按“票息 → 到期本息 → 贷款分期”顺序结清应付项；不足部分转欠付或银行垫付。 */
export function payGovernmentPayables(
  world: WorldState,
  city: City,
  config: DemoConfig,
  payables: GovernmentPayable[],
  tick: number,
  logs: LogEntry[],
): { paid: number; inArrears: number; advanced: number } {
  void world;
  void city;
  void config;
  void payables;
  void tick;
  void logs;
  return { paid: 0, inArrears: 0, advanced: 0 };
}

/**
 * 政府财政不足时由银行无条件垫付，形成 GovernmentLoanContract(purpose='bondAdvance')。
 * 不适用普通授信限制；必须写 GovernmentAdvanceRecord 以逐笔可追溯。
 */
export function applyBankAdvance(
  world: WorldState,
  city: City,
  config: DemoConfig,
  input: {
    tick: number;
    issuanceId: string;
    payableIds: string[];
    principal: number;
    interest: number;
    purpose: 'maturity' | 'bankruptcy';
  },
): GovernmentAdvanceResult {
  void world;
  void city;
  void config;
  void input;
  return {
    ok: false,
    advance: null,
    loan: null,
    amountAdvanced: 0,
    error: '银行垫付尚未实现（块2）',
  };
}

/** 政府银行借款（普通借款；不包括垫付转借款，后者由 applyBankAdvance 创建）。 */
export function borrowForGovernment(
  world: WorldState,
  city: City,
  config: DemoConfig,
  amount: number,
  tick: number,
  logs: LogEntry[],
): { ok: boolean; loan: GovernmentLoanContract | null; error?: string } {
  void world;
  void city;
  void config;
  void amount;
  void tick;
  void logs;
  return { ok: false, loan: null, error: '政府借款尚未实现（块2）' };
}

/** 服务政府银行贷款：到期分期还款与利息支付（财政不足时记欠付）。 */
export function serviceGovernmentLoans(
  world: WorldState,
  city: City,
  config: DemoConfig,
  tick: number,
  logs: LogEntry[],
): { repaid: number; interestPaid: number; inArrears: number } {
  void world;
  void city;
  void config;
  void tick;
  void logs;
  return { repaid: 0, interestPaid: 0, inArrears: 0 };
}

/**
 * 阶段⑤：债务汇总（五段分子 + 分母 + 分级 + 趋势）。
 * totalDebt 口径见文件头；previousSettlementDebtRatio 取上一结算月 lastDebt.debtRatio。
 */
export function computeGovernmentDebtSummary(
  world: WorldState,
  city: City,
  config: DemoConfig,
  tick: number,
): GovernmentDebtSummary {
  void world;
  void city;
  void config;
  void tick;
  // 唯一口径：复用 metrics.assessCityFiscalRisk（v1.4 #36），这里只覆盖 tick。
  void assessCityFiscalRisk;
  return { ...assessCityFiscalRisk(world, city.id, config), tick };
}

/** 阶段⑤：破产判定（债务/GDP ≥ bankruptAt；分母取 max(minAnnualGdp, 12 月 GDP 合计)）。 */
export function evaluateGovernmentBankruptcy(
  city: City,
  summary: GovernmentDebtSummary,
  config: DemoConfig,
): boolean {
  void city;
  void summary;
  void config;
  return false;
}

/**
 * 阶段⑥：破产清算。银行兑付未到期债券本金 + 实际持有月份已计提未付利息（不付未来利息），
 * 随后原有银行贷款与垫付形成的贷款一并勾销；不存在按比例清偿。写 GovernmentBankruptcyRecord。
 * 幂等：同一城市同一 tick 只允许一条记录。
 */
export function liquidateBankruptGovernment(
  world: WorldState,
  city: City,
  config: DemoConfig,
  summary: GovernmentDebtSummary,
  tick: number,
  logs: LogEntry[],
): GovernmentBankruptcyRecord | null {
  void world;
  void city;
  void config;
  void summary;
  void tick;
  void logs;
  return null;
}

/**
 * 破产政府持股处理：无 CEO 时，在除破产政府外的现有股东之间按股东主体数量平均分配；
 * 无股东时进入 'trust' 无表决权托管持股（不得销毁、不得转给公司、不得增发）。
 */
export function distributeBankruptGovernmentShares(
  world: WorldState,
  city: City,
  config: DemoConfig,
): { distributedHolders: number; custody: boolean } {
  void world;
  void city;
  void config;
  return { distributedHolders: 0, custody: false };
}
