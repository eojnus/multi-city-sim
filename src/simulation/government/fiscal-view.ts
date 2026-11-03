/**
 * 财政信息权限投影（v0.7 契约，块4 界面实现）。
 *
 * 数据层权限表达（补充指令 #7、DECISIONS v1.1 #9/#14）：
 * - 渲染期必须按**当前** viewer.mayorCityId 重新过滤；换任、离职、破产重选、读档后立即生效。
 * - 非市长可见：城市公开信息、当月 GDP 与普通历史、已发行债券必要投资信息（不含计划总额/总售额/总债务）、
 *   自持债券与收款、公开选举与破产事件。
 * - 仅市长可见：财政余额、收支流水、政府贷款与债券本金/总负债、12 月判定合计与债务率/风险等级/趋势、
 *   兑付计划、发债与借款操作。
 * - 存储期的可见性过滤只是缓存；任何对外投影都必须再经过本模块。
 *
 * 口径来源：`metrics.ts` 的 cityDebt / recent12MonthGdp / assessCityFiscalRisk（v1.4 #36 冻结），
 * 本文件不重复计算债务或风险分档，只做字段投影与权限判定。
 */
import type {
  BondIssuance,
  City,
  FiscalVisibility,
  LogEntry,
  MayorBondIssuanceView,
  MayorFiscalView,
  OwnBondHoldingView,
  PlayerNotification,
  PublicBondOfferView,
  ViewerIdentity,
  WorldState,
} from '../contracts/types';
import type { DemoConfig } from '../../data/config';
import { round2 } from '../core/math';
import { classifyLegacyVisibility } from '../core/save';
import { bondSubscriptionCloseTick, bondsOf } from './bonds';
import { assessCityFiscalRisk, cityDebt, isCityBankrupt, recent12MonthGdp } from './metrics';

/** 当前查看者的身份投影（只含权限判断所需字段；不缓存，每次现算）。 */
export function viewerIdentity(world: WorldState): ViewerIdentity {
  return {
    playerId: 'player',
    mayorCityId: world.player.roles?.mayorCityId ?? null,
  };
}

/** 当前查看者是否能看某城的市长专属财政信息。 */
export function canViewMayorFiscal(viewer: ViewerIdentity, cityId: string): boolean {
  return viewer.mayorCityId !== null && viewer.mayorCityId === cityId;
}

/** 单条可见性判定：public 恒可见；mayor 仅 current mayorCityId 匹配者可见。 */
export function isVisibleTo(
  visibility: FiscalVisibility | undefined,
  viewer: ViewerIdentity,
): boolean {
  if (!visibility || visibility.scope === 'public') return true;
  return visibility.cityId !== null && visibility.cityId === viewer.mayorCityId;
}

/**
 * 旧数据（缺少 visibility）的渲染期兜底：按内容归类后再判权。
 * 迁移前的内存世界（读档失败、测试构造）与 v6 存档都可能出现，不能默认公开。
 */
function legacyVisibility(
  message: string,
  cityId: string | null,
  stored: FiscalVisibility | undefined,
): FiscalVisibility {
  return stored ?? classifyLegacyVisibility(message, cityId);
}

function issuanceView(issuance: BondIssuance): MayorBondIssuanceView {
  return {
    issuanceId: issuance.id,
    faceValue: issuance.faceValue,
    couponRateAnnual: issuance.couponRateAnnual,
    interestPeriodMonths: issuance.interestPeriodMonths,
    termMonths: issuance.termMonths,
    planUnits: issuance.planUnits,
    soldUnits: issuance.soldUnits,
    unsoldUnits: Math.max(0, issuance.planUnits - issuance.soldUnits),
    principal: issuance.principal,
    maturityTick: issuance.maturityTick,
    status: issuance.status,
    accruedInterest: issuance.accruedInterest,
    interestPaid: issuance.interestPaid,
    issuedTick: issuance.issuedTick,
    subscriptionCloseTick: bondSubscriptionCloseTick(issuance),
    closedTick: issuance.closedTick,
  };
}

/**
 * 市长财政视图（唯一允许给市长 UI 的财政形状）。
 * 非该城现任市长返回 null；不得绕过本函数直接读取 city.treasury / city.government.*。
 */
export function buildMayorFiscalView(
  world: WorldState,
  city: City,
  config: DemoConfig,
  viewer: ViewerIdentity,
): MayorFiscalView | null {
  if (!canViewMayorFiscal(viewer, city.id)) return null;
  const tick = world.time.tick;
  const debt = cityDebt(world, city.id);
  const gdp = recent12MonthGdp(world, city.id, config);
  const risk = assessCityFiscalRisk(world, city.id, config);
  const government = city.government;

  // 本月收支：以世界财政流水为准（正数收入、负数支出），只统计本城本月。
  let monthIncome = 0;
  let monthExpense = 0;
  for (const entry of world.fiscal?.ledger ?? []) {
    if (entry.tick !== tick || entry.cityId !== city.id) continue;
    if (entry.amount > 0) monthIncome += entry.amount;
    else monthExpense += -entry.amount;
  }

  const payablesDueThisMonth = (government?.payables ?? [])
    .filter((payable) => payable.tick === tick)
    .reduce((sum, payable) => sum + payable.principalDue + payable.interestDue, 0);
  const paidByAdvanceThisMonth = (government?.advances ?? [])
    .filter((advance) => advance.tick === tick)
    .reduce((sum, advance) => sum + advance.totalAdvanced, 0);

  const bankruptcy = government?.bankruptcy ?? city.bankruptcy ?? null;
  const bankrupt = bankruptcy?.status === 'bankrupt' || isCityBankrupt(city);

  const issuances = (world.bonds?.issuances ?? [])
    .filter((issuance) => issuance.cityId === city.id)
    .map(issuanceView)
    .sort((a, b) => a.maturityTick - b.maturityTick || a.issuanceId.localeCompare(b.issuanceId));

  return {
    cityId: city.id,
    tick,
    treasury: round2(city.treasury),
    monthIncome: round2(monthIncome),
    monthExpense: round2(monthExpense),
    bankLoanPrincipal: debt.bankLoanPrincipal,
    bankAdvancePrincipal: debt.advanceLoanPrincipal,
    bondPrincipalOutstanding: debt.bondPrincipalOutstanding,
    loanAccruedInterest: debt.loanAccruedInterest,
    bondAccruedInterest: debt.bondAccruedInterest,
    totalDebt: debt.totalDebt,
    gdpWindowMonths: gdp.months,
    gdpWindowSum: gdp.sum,
    gdpWindowEstimatedMonths: gdp.estimatedMonths,
    gdpJudgementValue: risk.gdpJudgementValue,
    debtRatio: risk.debtRatio,
    riskLevel: risk.riskLevel,
    riskTrend: risk.riskTrend,
    previousSettlementDebtRatio: risk.previousSettlementDebtRatio,
    payablesDueThisMonth: round2(payablesDueThisMonth),
    paidByAdvanceThisMonth: round2(paidByAdvanceThisMonth),
    bankruptcyStatus: bankrupt ? 'bankrupt' : 'solvent',
    bankruptcyTick: bankrupt ? bankruptcy?.tick ?? null : null,
    gdpLowFallback: gdp.sum < config.government.fiscalRisk.minAnnualGdp,
    issuances,
  };
}

/** 公开债券投资信息（白名单：不含发行计划总额、总售额、政府总债务）。 */
export function buildPublicBondOffer(
  world: WorldState,
  issuanceId: string,
): PublicBondOfferView | null {
  const issuance = bondsOf(world).issuances.find((entry) => entry.id === issuanceId);
  if (!issuance) return null;
  return {
    issuanceId: issuance.id,
    cityId: issuance.cityId,
    faceValue: issuance.faceValue,
    couponRateAnnual: issuance.couponRateAnnual,
    interestPeriodMonths: issuance.interestPeriodMonths,
    termMonths: issuance.termMonths,
    unitsAvailable: Math.max(0, issuance.planUnits - issuance.soldUnits),
    maturityTick: issuance.maturityTick,
    status: issuance.status,
    issuedTick: issuance.issuedTick,
    subscriptionCloseTick: bondSubscriptionCloseTick(issuance),
  };
}

/** 任何玩家可看自己的持债记录（含应得款与到期日）。 */
export function buildOwnBondHoldingViews(
  world: WorldState,
  holderId: string,
): OwnBondHoldingView[] {
  return bondsOf(world)
    .holdings.filter(
      (holding) => holding.holder.kind === 'player' && holding.holder.id === holderId,
    )
    .map((holding) => ({
      holdingId: holding.id,
      issuanceId: holding.issuanceId,
      cityId: holding.cityId,
      units: holding.units,
      principal: holding.principal,
      interestStartTick: holding.interestStartTick,
      maturityTick: holding.maturityTick,
      accruedInterest: holding.accruedInterest,
      interestPaid: holding.interestPaid,
      redeemedTick: holding.redeemedTick,
    }))
    .sort((a, b) => a.maturityTick - b.maturityTick || a.holdingId.localeCompare(b.holdingId));
}

/** 按当前身份过滤日志（渲染期重校验；不得只依赖存储期过滤）。 */
export function visibleLogEntries(world: WorldState, viewer: ViewerIdentity): LogEntry[] {
  return (world.log ?? []).filter((entry) =>
    isVisibleTo(legacyVisibility(entry.message, null, entry.visibility), viewer),
  );
}

/** 按当前身份过滤通知（渲染期重校验；换任后旧市长通知立即不可见）。 */
export function visibleNotifications(
  world: WorldState,
  viewer: ViewerIdentity,
): PlayerNotification[] {
  return (world.notifications ?? []).filter((notice) =>
    isVisibleTo(
      legacyVisibility(
        `${notice.title} ${notice.body}`,
        notice.cityId ?? null,
        notice.visibility,
      ),
      viewer,
    ),
  );
}
