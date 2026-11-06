// 居民投资实体：每座城市若干群体，持有可投资资金和股票，参与融资与二级买卖。
// 普通居民不逐个建模；群体不是额外人口，populationShare 只用于分配居民收入。
//
// 暂定演示规则（待用户决定）：
// - 每月按“居民闲钱”规则从居民群体手头现金转入投资实体（v1.1 §2）：每个群体先保留
//   3 个月基本生活需求资金，仅对保留额以上的闲置现金每月最多转入 1%；取消“当月收入
//   为零则不能投资”——收入为零但仍有闲钱时按闲钱上限转入。不提取存款、不借消费贷，
//   群体现金不足（或无闲置）时不转，转入后现金不会为负。
// - 每笔转入与每月股息归属记入可审计的简化份额账本（HouseholdGroup.investorLedger），
//   现金仍由投资实体统一托管；账本记录“谁投入、多少份额、应归属多少股息”，不重复计收入。
// - 实体收到的股息按 dividendDistributionRate 返还居民收入，其余留存投资。
// - 自动投资规则可替换：投票权与仅分红两类股份都参与买卖打分；投票权接近持股上限时
//   只排除投票权买入，仅分红类别按股息收益率、折价、趋势与风险偏好独立评估；
//   两类股份每月都按真实持仓提供极小比例的流动性卖单（仅分红另有现金需求/股息惜售规则）。
// - 跨城买股、阈值、风险偏好均为演示参数。

import type {
  BondHolder,
  BondHolding,
  Company,
  HolderRef,
  HouseholdGroup,
  HouseholdInvestorLedger,
  InvestorFundingEntry,
  InvestorGroup,
  InvestorUsageEntry,
  LogEntry,
  ShareClass,
  WorldState,
} from '../contracts/types';
import type { DemoConfig } from '../../data/config';
import { allocateProportionally, clamp, round2 } from '../core/math';
import { companyBookValue, companySharePrice, monthlyWageBill } from '../companies/company';
import { cityMarketPrices } from '../markets/markets';
import { householdBasicNeedCost } from '../population/household-finance';
import { cityInvestorEquity, householdGroupsOfCity } from '../population/household-groups';
import {
  allocateMoneyExact,
  effectiveInvestorShares,
  ensureInvestorLedger,
  investorBondValue,
  investorNavPerShare,
  sharesForInvestorValue,
} from '../population/household-investment';
import { PRODUCTIVITY } from '../../data/demo-data';
import {
  acceptFinancingOffer,
  bookPrice,
  companyHolders,
  createFinancingOffer,
  declineFinancingOffer,
  holderTotalShares,
  holderVotingShares,
  placeOrder,
  transferShares,
} from '../securities/securities';
import { latestStockPrice, stockHistoryFor } from '../securities/history';

const GROUP_NAME_SUFFIX = ['储蓄互助会', '工薪投资者联盟', '城市养老基金'];

/**
 * v1.1 §2“居民闲钱投资实体”首版口径（config 未设键，先以模块常量固定）：
 * 群体先保留 3 个月基本生活需求资金；超出部分为闲置现金，每月最多转入 1%。
 * 后续若要调参，应迁移到 config.investors，而不是散落魔法数。
 */
export const BASIC_NEED_RESERVE_MONTHS = 3;
export const IDLE_CASH_MONTHLY_INVEST_SHARE = 0.01;

/** v1.1 §2：报告保留的月度转入/用途流水月数（72 月报告用；超出裁掉最旧记录）。 */
export const INVESTOR_FUNDING_HISTORY_MONTHS = 72;

/** 群体预计 3 个月基本生活需求保留额（基本需求 food 口径，见 household-finance）。 */
export function householdBasicNeedReserve(
  world: WorldState,
  group: HouseholdGroup,
  config: DemoConfig,
): number {
  return round2(
    Math.max(0, householdBasicNeedCost(world, group, config)) * BASIC_NEED_RESERVE_MONTHS,
  );
}

/**
 * 群体闲置现金 = max(0, 手头现金 − 3 个月基本需求保留额)。
 * 只算手头现金：银行存款、消费贷额度都不算闲钱（不得提取存款/借消费贷去投资）。
 */
export function householdIdleCash(
  world: WorldState,
  group: HouseholdGroup,
  config: DemoConfig,
): number {
  return round2(Math.max(0, group.cash - householdBasicNeedReserve(world, group, config)));
}

/**
 * 读取（必要时初始化）居民闲钱投资流水账本。
 * v1.1 新字段，旧存档缺省视为空数组；不改动既有数据，保持存档 v9 兼容。
 */
function ensureInvestorFundingHistory(world: WorldState): InvestorFundingEntry[] {
  if (!Array.isArray(world.households.investorFundingHistory)) {
    world.households.investorFundingHistory = [];
  }
  return world.households.investorFundingHistory;
}

/** 读取（必要时初始化）每城每月投资实体资金用途快照（v1.1 可选字段，旧档兜底为空数组）。 */
function ensureInvestorUsageHistory(world: WorldState): InvestorUsageEntry[] {
  if (!Array.isArray(world.households.investorUsageHistory)) {
    world.households.investorUsageHistory = [];
  }
  return world.households.investorUsageHistory;
}

/** 本城投资实体现金合计（用途快照与报告口径）。 */
function investorCashOfCity(world: WorldState, cityId: string): number {
  return round2(
    world.investors
      .filter((investor) => investor.cityId === cityId)
      .reduce((sum, investor) => sum + investor.cash, 0),
  );
}

/**
 * v1.2 §1：有效份额 = 历史投入份额 + 一次性“开局无主旧资产”起始份额。
 * 股息返还、股息归属、报告占比全部以有效份额为权威口径（未初始化账本按 0）。
 *
 * v1.3 §2：实现移到 population/household-investment（纯函数层），财富统计与居民授信
 * 也必须复用同一口径；这里保留导出以兼容既有调用方。
 */
export { effectiveInvestorShares };

/**
 * v1.2 §1：把投资实体“开局已有净资产”一次性记为各群体的起始份额。
 *
 * 为什么需要：投资实体在 v1.1 之前就持有现金与股票，这部分权益不是本月新投入买来的。
 * 若只按“新增投入份额”分配股息，首个出资者会无偿取得全部旧资产收益；因此首次结算时
 * 按开局人口把 `本城投资实体净资产（现金 + 持股估值）− 已有投入份额` 记为各群体的
 * openingShares（分币最大余数法，合计严格等于无主净资产）。之后新增投入仍按 1:1 累加，
 * 该函数幂等：所有群体都已记录（含 0）后不再改动。
 *
 * 口径说明：只做权益归属记账，不产生现金、不追溯修改居民现金或既有统计；旧档读取时补齐。
 */
export function ensureInvestorOpeningShares(world: WorldState): void {
  const cities = [...world.cities].sort((a, b) => a.id.localeCompare(b.id));
  for (const city of cities) {
    const groups = householdGroupsOfCity(world, city.id);
    if (groups.length === 0) continue;
    // 已初始化（哪怕只有一个群体有值）后不再重算，避免把后续新增投入再算成“无主资产”。
    const anyInitialized = groups.some(
      (group) => group.investorLedger?.openingShares !== undefined,
    );
    if (anyInitialized) {
      for (const group of groups) {
        const ledger = ensureInvestorLedger(group);
        if (ledger.openingShares === undefined) ledger.openingShares = 0;
      }
      continue;
    }
    const contributedShares = round2(
      groups.reduce((sum, group) => sum + Math.max(0, group.investorLedger?.shares ?? 0), 0),
    );
    const equity = round2(cityInvestorEquity(world, city.id));
    const unowned = round2(Math.max(0, equity - contributedShares));
    // 按开局人口（基本生活费户数口径的人口权重）分摊；allocateMoney 保证合计不差分币。
    const weights = groups.map((group) => Math.max(0, group.people));
    const opening = allocateMoneyExact(unowned, weights);
    groups.forEach((group, index) => {
      ensureInvestorLedger(group).openingShares = opening[index] ?? 0;
    });
  }
}

/**
 * v1.2 §1：把投资实体“实际返还居民”的月度股息按有效份额分给各居民群体。
 *
 * 与 finance.investorDistributionByCity 对接：该总额已由 distributeDividend 从实体现金
 * 扣除（返还部分不入实体留存），这里只负责按权威份额账本落地到群体，不重复扣款/造币；
 * 账本尚未建立（例如手工构造的世界）时按人口兜底，保证返还款不会凭空消失。
 */
export function allocateResidentDividendReturns(
  world: WorldState,
  cityId: string,
  amount: number,
): Map<string, number> {
  const result = new Map<string, number>();
  const target = round2(Math.max(0, amount));
  if (target <= 0) return result;
  const groups = householdGroupsOfCity(world, cityId);
  if (groups.length === 0) return result;
  ensureInvestorOpeningShares(world);
  const weights = groups.map((group) => effectiveInvestorShares(group.investorLedger));
  const totalShares = round2(weights.reduce((sum, value) => sum + value, 0));
  const basis = totalShares > 0 ? weights : groups.map((group) => Math.max(0, group.people));
  const shares = allocateMoneyExact(target, basis);
  groups.forEach((group, index) => {
    const value = shares[index] ?? 0;
    if (value > 0) result.set(group.id, value);
  });
  return result;
}

/**
 * v1.2 §1 账本口径：按有效份额归属本月股息。
 * 只记账、不划现金（现金仍由投资实体统一托管，返还居民部分按既有规则由实体扣除）；
 * 合计严格等于实体本月收到的股息（分币尾差给最后一个份额持有人）；同一 tick 幂等。
 * 有效份额 = 历史投入份额 + 开局无主旧资产起始份额，与返还现金的分摊口径一致。
 */
function attributeInvestorDividends(
  world: WorldState,
  cityId: string,
  householdGroups: HouseholdGroup[],
  tick: number,
): void {
  ensureInvestorOpeningShares(world);
  const ledgers = householdGroups
    .map((group) => group.investorLedger)
    .filter(
      (ledger): ledger is HouseholdInvestorLedger =>
        Boolean(ledger) && effectiveInvestorShares(ledger) > 0,
    );
  if (ledgers.length === 0) return;
  // 同月幂等：本月已经归属过就不再累加。
  if (ledgers.some((ledger) => ledger.lastDividendTick === tick)) return;
  const dividends = round2(totalInvestorDividendsByCity(world)[cityId] ?? 0);
  if (dividends <= 0) return;
  const totalShares = round2(
    ledgers.reduce((sum, ledger) => sum + effectiveInvestorShares(ledger), 0),
  );
  if (totalShares <= 0) return;
  let assigned = 0;
  ledgers.forEach((ledger, index) => {
    const isLast = index === ledgers.length - 1;
    const amount = isLast
      ? round2(Math.max(0, dividends - assigned))
      : round2((dividends * effectiveInvestorShares(ledger)) / totalShares);
    ledger.dividends = round2(ledger.dividends + amount);
    ledger.lastDividendTick = tick;
    assigned = round2(assigned + amount);
  });
}

/**
 * v1.5 §2 / v1.6 §P5：跨城迁移时把源城投资实体的**未到期政府债券**按迁移价值比例真实拆分给目标城实体。
 *
 * 为什么需要：v1.4 及以前迁移只划转现金与股票；当源城实体现金/股票为 0、净资产全是未到期债券时，
 * 迁移者实际带走 0 资产（v1.4 只能下调迁出份额），迁入者权益丢失，剩余债券权益留在源城实体
 * 被剩余居民无偿获得。
 *
 * 口径（v1.6 起不新增存档字段、不改债券兑付规则）：
 * - 只拆 `status='active'` 的持债；本金/应计利息/已付利息按迁移比例拆分，源城减少额 = 目标城增加额；
 *   发行批次的 soldUnits/principal 与兑付规则完全不变，后续付息/到期/破产兑付仍走既有 per-holding 规则；
 * - 精度（PLAN D4 方案①“内部高精度份额”）：**本金以信用点分（round2）为权威粒度**，份数不再
 *   四舍五入到 0.01 份，而是按 `本金 / 面额` 保留内部全精度（面额 1000 时 1 分 = 1e-5 份，
 *   优于任务要求的 1e-6 份级）。旧实现 0.01 份粒度 = 面额×0.01 = 10 信用点（面额 1000），
 *   迁移应带走 4 信用点时 round 成 0 份、权益留在源城；新实现拆 0.004 份 = 4 信用点，
 *   迁移者不丢权益；
 * - 拆分残差：只会剩下“不足 1 分”的金额（每笔每持债 ≤0.005 信用点）。0.01 信用点是全仿真
 *   账本（现金/应计/兑付流水）的最小记账单位，任何账本都无法表示更小金额，所以这部分既
 *   不会消失也不会被重复计——它留在源持债本金里，后续迁移继续按比例拆分、到期/破产按余额
 *   兑付。因此不需要 tailPrincipal 字段，也不需要改存档格式（SAVE_FORMAT_VERSION 不必因
 *   本项 +1；v1.6 的 D5 版本号仍由 Lead 统一决定）；
 * - 目标城同一（发行批次, 持有实体）已有 active 持债时合并，多次迁移不产生碎片持债。
 */

/**
 * v1.6 §P5：本金（信用点，分粒度为权威）→ 内部持债份数。
 * 不做 0.01 份舍入：份数 = 本金 / 面额，保留内部全精度。
 * 这样迁移应带走 4 信用点（面额 1000）时得到 0.004 份而不是 0；不变量
 * “本金 = round2(份数×面额)” 在全精度下自动成立（本金本身已是分）。
 */
function bondUnitsForPrincipal(principal: number, faceValue: number): number {
  if (faceValue <= 0 || principal <= 0) return 0;
  return principal / faceValue;
}

function bondFaceValueOf(world: WorldState, holding: BondHolding): number {
  const issuance = world.bonds?.issuances.find((entry) => entry.id === holding.issuanceId);
  if (issuance && issuance.faceValue > 0) return issuance.faceValue;
  const implied = holding.units > 0 ? holding.principal / holding.units : 0;
  return implied > 0 ? implied : 1;
}

/**
 * 把一段迁移债券并入目标实体：同批次已有 active 持债则合并（每“批次+实体”最多 1 条）。
 * v1.6 §P5：份数由合并后的本金/面额推导（内部全精度），不再 round2 到 0.01 份，
 * 保证小额多次迁移累加不因份数舍入丢失。
 */
function mergeMigratedBondHolding(
  world: WorldState,
  source: BondHolding,
  toInvestor: InvestorGroup,
  faceValue: number,
  principal: number,
  accruedInterest: number,
  interestPaid: number,
): void {
  const bonds = world.bonds;
  const movedPrincipal = round2(principal);
  if (!bonds || movedPrincipal <= 0 || faceValue <= 0) return;
  const holder: BondHolder = { kind: 'investorGroup', id: toInvestor.id };
  const existing = bonds.holdings.find(
    (entry) =>
      entry.issuanceId === source.issuanceId &&
      entry.status === 'active' &&
      entry.holder.kind === holder.kind &&
      entry.holder.id === holder.id &&
      entry.interestStartTick === source.interestStartTick,
  );
  if (existing) {
    existing.principal = round2(existing.principal + movedPrincipal);
    existing.units = bondUnitsForPrincipal(existing.principal, faceValue);
    existing.accruedInterest = round2(existing.accruedInterest + accruedInterest);
    existing.interestPaid = round2(existing.interestPaid + interestPaid);
    existing.note = `v1.5 §2 / v1.6 §P5：跨城迁移并入 ${existing.units} 份（本金 ${existing.principal}，来源 ${source.id}，tick ${world.time.tick}）`;
    return;
  }
  bonds.holdings.push({
    id: `bondholding-${bonds.nextHoldingNumber}`,
    issuanceId: source.issuanceId,
    cityId: source.cityId,
    holder,
    units: bondUnitsForPrincipal(movedPrincipal, faceValue),
    principal: movedPrincipal,
    purchasedTick: world.time.tick,
    interestStartTick: source.interestStartTick,
    maturityTick: source.maturityTick,
    lastCouponTick: source.lastCouponTick,
    accruedInterest: round2(accruedInterest),
    interestPaid: round2(interestPaid),
    redeemedTick: null,
    status: 'active',
    note: `v1.5 §2 / v1.6 §P5：跨城迁移自 ${source.id} 按比例拆出的真实持债（本金 ${movedPrincipal}，tick ${world.time.tick}）`,
  });
  bonds.nextHoldingNumber += 1;
}

/** 拆分债券持债并按目标实体份额分配；返回真实划转的债券权益价值（本金 + 应计利息）。 */
function splitBondHoldingsForMigration(
  world: WorldState,
  fromInvestors: InvestorGroup[],
  toInvestors: InvestorGroup[],
  fraction: number,
): { valueMoved: number; holdingsMoved: number } {
  const bonds = world.bonds;
  if (!bonds || fraction <= 0) return { valueMoved: 0, holdingsMoved: 0 };
  const fromIds = new Set(fromInvestors.map((investor) => investor.id));
  const entityWeights = toInvestors.map((investor) => Math.max(0, investor.populationShare));
  let valueMoved = 0;
  let holdingsMoved = 0;
  const sourceHoldings = bonds.holdings.filter(
    (holding) =>
      holding.status === 'active' &&
      holding.holder.kind === 'investorGroup' &&
      fromIds.has(holding.holder.id),
  );
  for (const source of sourceHoldings) {
    const faceValue = bondFaceValueOf(world, source);
    // v1.6 §P5：本金以“分”为权威粒度；份数由本金/面额内部全精度推导，不再四舍五入到 0.01 份。
    // 因此迁移应带走 4 信用点（面额 1000 → 0.004 份）时能真实拆出，不再 round 成 0 份留源城。
    const movedPrincipal = round2(Math.max(0, source.principal) * fraction);
    if (movedPrincipal <= 0) continue;
    if (movedPrincipal > source.principal + 0.005) continue;
    const ratio = source.principal > 0 ? movedPrincipal / source.principal : 0;
    const movedAccrued = round2(Math.max(0, source.accruedInterest) * ratio);
    const movedInterestPaid = round2(Math.max(0, source.interestPaid) * ratio);
    // 源城持债等额扣减（本金/应计/已付利息三项合计守恒，拆分尾差留在源实体）。
    source.principal = round2(Math.max(0, source.principal - movedPrincipal));
    source.accruedInterest = round2(Math.max(0, source.accruedInterest - movedAccrued));
    source.interestPaid = round2(Math.max(0, source.interestPaid - movedInterestPaid));
    source.units = bondUnitsForPrincipal(source.principal, faceValue);
    // 目标城：本金按分币精确分给各投资实体（合计严格 = movedPrincipal），份数由各自本金/面额推导，
    // 利息按本金切片比例分（分币精确），利息合计也严格守恒。
    const principalSlices = allocateMoneyExact(movedPrincipal, entityWeights);
    const accruedSlices = allocateMoneyExact(movedAccrued, principalSlices);
    const interestPaidSlices = allocateMoneyExact(movedInterestPaid, principalSlices);
    toInvestors.forEach((toInvestor, index) => {
      const principal = round2(principalSlices[index] ?? 0);
      if (principal <= 0) return;
      mergeMigratedBondHolding(
        world,
        source,
        toInvestor,
        faceValue,
        principal,
        accruedSlices[index] ?? 0,
        interestPaidSlices[index] ?? 0,
      );
      holdingsMoved += 1;
    });
    valueMoved = round2(valueMoved + movedPrincipal + movedAccrued);
  }
  return { valueMoved, holdingsMoved };
}

/**
 * v1.3 §2 / v1.4 §3 / v1.5 §2：跨城迁移时居民投资权益随人转移，且必须是**真实资产流转**。
 *
 * v1.4 §3 修复“两城净值不同导致权益价值错配”：
 * 迁移权益不再按“份额 1:1 改挂”，而是按**源城净值/份额**计价出真实价值，
 * 再按**目标城净值/份额**换算为目标城份额：
 * - 价值：迁出者带走的价值 = 迁出有效份额 × 源城净值/份额（源城净资产含现金、持股市值、
 *   未到期国债本息）；源城净资产为 0 时价值为 0，不凭空划转资产、也不给目标城增发份额；
 * - 资产：按“迁移价值/源城净资产”的比例，把现金、持股与**未到期债券**从源城实体真实划转到
 *   目标城实体（股份总股数不变、债券本金/应计不变、两城现金守恒，合计划转价值严格等于迁移价值）；
 * - 份额：目标城新增份额 = 迁移价值 / 目标城净值/份额（目标城零净资产时回退 1:1），
 *   记入目标群体 openingShares（不是“新投入”，不重复计投入额）；
 * - 结果：迁出者、迁出地其他居民、迁入地原居民每份价值均不因迁移而变，无无偿转移。
 */
export interface MigrationInvestorTransfer {
  /** 源城随人转出的有效份额（shares + openingShares）。 */
  effectiveSharesMoved: number;
  /** 真实划转的现金（源城实体减少 = 目标城实体增加）。 */
  cashMoved: number;
  /** 真实划转的持股数量（同一类别总股数不变）。 */
  holdingsMoved: number;
  /** 真实划转的债券权益价值（未到期本金 + 应计利息）。 */
  bondValueMoved: number;
  /** 拆分/并入的持债条数（同一发行批次在目标实体合并）。 */
  bondHoldingsMoved: number;
  /** 按源城净值/份额计价后随人转移的权益价值。 */
  valueMoved: number;
  /** 按目标城净值/份额换算后新增到目标群体的有效份额。 */
  targetSharesAdded: number;
}

export function transferInvestorAssetsForMigration(
  world: WorldState,
  fromCityId: string,
  toCityId: string,
  people: number,
  laborForceMoved: number = people,
): MigrationInvestorTransfer {
  const result: MigrationInvestorTransfer = {
    effectiveSharesMoved: 0,
    cashMoved: 0,
    holdingsMoved: 0,
    bondValueMoved: 0,
    bondHoldingsMoved: 0,
    valueMoved: 0,
    targetSharesAdded: 0,
  };
  if (people <= 0 || fromCityId === toCityId) return result;
  const fromGroups = householdGroupsOfCity(world, fromCityId);
  const toGroups = householdGroupsOfCity(world, toCityId);
  const fromInvestors = groupsOfCity(world, fromCityId);
  const toInvestors = groupsOfCity(world, toCityId);
  // 没有承接方（旧档缺投资实体）时整体放弃：不能只改账本而不搬资产。
  if (fromGroups.length === 0 || toGroups.length === 0) return result;
  if (fromInvestors.length === 0 || toInvestors.length === 0) return result;

  // 旧档/新世界可能尚未建立起始份额：先补齐，保证“份额占比”与投资实体净资产一致，
  // 否则迁移会按虚低的份额占比搬走过多实体资产。
  ensureInvestorOpeningShares(world);
  const totalCityShares = round2(
    fromGroups.reduce((sum, group) => sum + effectiveInvestorShares(group.investorLedger), 0),
  );
  if (totalCityShares <= 0) return result;
  const fromEquity = cityInvestorEquity(world, fromCityId);
  const fromNavPerShare = investorNavPerShare(fromEquity, totalCityShares);

  const laborMoving = Math.max(0, Math.min(people, Math.round(laborForceMoved)));
  const legs: { occupation: HouseholdGroup['occupation']; moving: number }[] = [
    { occupation: 'unemployed', moving: laborMoving },
    { occupation: 'nonLabor', moving: people - laborMoving },
  ];
  const legMoves: {
    source: HouseholdGroup;
    destination: HouseholdGroup;
    effective: number;
    moved: number;
  }[] = [];
  for (const leg of legs) {
    if (leg.moving <= 0) continue;
    const source = fromGroups.find((group) => group.occupation === leg.occupation);
    const destination = toGroups.find((group) => group.occupation === leg.occupation);
    if (!source || !destination || source.people <= 0) continue;
    const moving = Math.min(leg.moving, source.people);
    if (moving <= 0) continue;
    const effective = effectiveInvestorShares(source.investorLedger);
    if (effective <= 0) continue;
    const whole = moving >= source.people;
    const moved = whole ? effective : round2(effective * (moving / source.people));
    if (moved <= 0) continue;
    legMoves.push({ source, destination, effective, moved });
  }
  const totalMoved = round2(legMoves.reduce((sum, move) => sum + move.moved, 0));
  if (totalMoved <= 0) return result;
  // 迁移权益价值：源城净值/份额 × 迁出份额（净值=0 时价值=0，不虚增）。
  const valueMoved = round2(totalMoved * fromNavPerShare);
  // 目标城净值/份额必须在划入资产之前取，否则会把自己划入的资产算进分母。
  const toSharesBefore = round2(
    toGroups.reduce((sum, group) => sum + effectiveInvestorShares(group.investorLedger), 0),
  );
  const toNavPerShare = investorNavPerShare(
    cityInvestorEquity(world, toCityId),
    toSharesBefore,
  );
  // 目标城份额：价值 / 目标城净值；目标城零净资产时 1:1 兜底（旧份额价值为 0，不稀释）。
  let targetShares = sharesForInvestorValue(valueMoved, toNavPerShare);
  let movedSharesActual = totalMoved;
  const fraction = fromEquity > 0 ? Math.min(1, valueMoved / fromEquity) : 0;

  // 1) 持股：按迁移价值占源城净资产的比例划转（向下取到 0.01 股，避免划多）。
  const fromIds = new Set(fromInvestors.map((investor) => investor.id));
  const holdingWeights = toInvestors.map((investor) => Math.max(0, investor.populationShare));
  let holdingsValueMoved = 0;
  if (fraction > 0) {
    const holdings = world.securities.holdings.filter(
      (holding) => holding.holder.type === 'investorGroup' && fromIds.has(holding.holder.id),
    );
    for (const holding of holdings) {
      const moved = Math.floor(Math.max(0, holding.shares) * fraction * 100) / 100;
      if (moved <= 0) continue;
      const company = world.companies.find((candidate) => candidate.id === holding.companyId);
      if (!company) continue;
      const companyCity = world.cities.find((candidate) => candidate.id === company.cityId);
      if (!companyCity) continue;
      const unitPrice = companySharePrice(company, cityMarketPrices(companyCity));
      const splits = allocateMoneyExact(moved, holdingWeights);
      toInvestors.forEach((investor, index) => {
        const quantity = splits[index] ?? 0;
        if (quantity <= 0) return;
        const to: HolderRef = { type: 'investorGroup', id: investor.id };
        if (
          transferShares(
            world,
            holding.companyId,
            holding.shareClassId,
            holding.holder,
            to,
            quantity,
            world.time.tick,
          )
        ) {
          result.holdingsMoved = round2(result.holdingsMoved + quantity);
          holdingsValueMoved = round2(holdingsValueMoved + quantity * unitPrice);
        }
      });
    }
  }

  // 1b) 债券：按迁移价值占源城净资产的比例拆分未到期持债到目标城实体（v1.5 §2）。
  //     只拆 active 持债；本金/应计利息/已付利息合计守恒，不新增现金、不改变发行与兑付规则。
  const bondTransfer = splitBondHoldingsForMigration(world, fromInvestors, toInvestors, fraction);
  result.bondValueMoved = bondTransfer.valueMoved;
  result.bondHoldingsMoved = bondTransfer.holdingsMoved;

  // 2) 现金：迁移价值扣除已划转股票市值与债券估值后的余额，从源城实体现金扣出并转入目标城实体。
  const cashTarget = round2(
    Math.max(0, valueMoved - holdingsValueMoved - bondTransfer.valueMoved),
  );
  const fromCashTotal = round2(
    fromInvestors.reduce((sum, investor) => sum + Math.max(0, investor.cash), 0),
  );
  const cashToMove = round2(Math.min(cashTarget, fromCashTotal));
  if (cashToMove > 0) {
    // 先按现金比例分币分配，再夹取到各自现金余额并重分配尾差，绝不把实体现金扣成负数。
    const amounts = allocateMoneyExact(
      cashToMove,
      fromInvestors.map((investor) => Math.max(0, investor.cash)),
    );
    let residual = cashToMove;
    const taken = amounts.map((amount, index) => {
      const available = Math.max(0, fromInvestors[index]!.cash);
      const value = Math.min(amount, available);
      residual = round2(residual - value);
      return value;
    });
    for (let guard = 0; guard < fromInvestors.length * 2 && residual > 0.005; guard += 1) {
      let moved = 0;
      for (let index = 0; index < fromInvestors.length && residual > 0.005; index += 1) {
        const investor = fromInvestors[index]!;
        const capacity = round2(Math.max(0, investor.cash - (taken[index] ?? 0)));
        if (capacity <= 0) continue;
        const add = round2(Math.min(capacity, residual));
        taken[index] = round2((taken[index] ?? 0) + add);
        moved = round2(moved + add);
        residual = round2(residual - add);
      }
      if (moved <= 0) break;
    }
    const cashTotal = round2(taken.reduce((sum, value) => sum + value, 0));
    if (cashTotal > 0) {
      fromInvestors.forEach((investor, index) => {
        investor.cash = round2(investor.cash - (taken[index] ?? 0));
      });
      const credits = allocateMoneyExact(cashTotal, holdingWeights);
      toInvestors.forEach((investor, index) => {
        investor.cash = round2(investor.cash + (credits[index] ?? 0));
      });
      result.cashMoved = cashTotal;
    }
  }

  // 3) 账本随人转移：若源城实体可划转资产不足，实际划转价值可能低于理论迁移价值；
  //    此时按“实际划转价值”重算迁出份额与目标份额，避免账本份额多于实际资产（无偿转移）。
  //    v1.6 §P5：债券份数内部全精度（本金按分守恒），拆分误差只剩“不足 1 分”的残差，
  //    不再有 v1.5 的“0.01 份 = 面额×0.01”量级误差；现金/股票仍按既有分币/0.01 股粒度，
  //    因此仍保留 shortfall 保护：实际划转少于理论价值时按实际值重算份额。
  const actualValueMoved = round2(
    holdingsValueMoved + bondTransfer.valueMoved + result.cashMoved,
  );
  const shortfall = actualValueMoved + 0.005 < valueMoved;
  if (shortfall) {
    movedSharesActual = Math.min(
      totalMoved,
      sharesForInvestorValue(actualValueMoved, fromNavPerShare),
    );
    targetShares = sharesForInvestorValue(actualValueMoved, toNavPerShare);
  } else if (actualValueMoved > valueMoved + 0.005) {
    targetShares = sharesForInvestorValue(valueMoved, toNavPerShare);
  }
  const legRemovedShares = shortfall
    ? allocateMoneyExact(movedSharesActual, legMoves.map((move) => move.moved))
    : legMoves.map((move) => move.moved);
  const legShares = allocateMoneyExact(
    targetShares,
    legMoves.map((move) => move.moved),
  );
  legMoves.forEach((move, index) => {
    const removed = round2(Math.min(legRemovedShares[index] ?? 0, move.effective));
    const from = ensureInvestorLedger(move.source);
    const to = ensureInvestorLedger(move.destination);
    const sharesOut = Math.min(Math.max(0, from.shares), removed);
    const openingOut = round2(Math.max(0, removed - sharesOut));
    const contributedOut =
      move.effective > 0 ? round2(from.contributed * (removed / move.effective)) : 0;
    from.shares = round2(Math.max(0, from.shares - sharesOut));
    from.openingShares = round2(Math.max(0, (from.openingShares ?? 0) - openingOut));
    from.contributed = round2(Math.max(0, from.contributed - contributedOut));
    to.openingShares = round2((to.openingShares ?? 0) + (legShares[index] ?? 0));
    to.contributed = round2(to.contributed + contributedOut);
    result.effectiveSharesMoved = round2(result.effectiveSharesMoved + removed);
  });
  result.valueMoved = actualValueMoved;
  result.targetSharesAdded = targetShares;
  return result;
}

/** 记录本月投资实体资金用途快照；同一 tick 重算时覆盖而不是重复追加。 */
function recordInvestorUsage(
  world: WorldState,
  config: DemoConfig,
  history: InvestorUsageEntry[],
  cityId: string,
  tick: number,
  contributed: number,
  dividends: number,
): void {
  const closingCash = investorCashOfCity(world, cityId);
  const rate = clamp(config.investors.dividendDistributionRate, 0, 1);
  const dividendsReturned = round2(dividends * rate);
  const dividendsRetained = round2(dividends - dividendsReturned);
  const previous = [...history]
    .reverse()
    .find((entry) => entry.cityId === cityId && entry.tick < tick);
  const openingCash = previous
    ? previous.closingCash
    : round2(Math.max(0, closingCash - contributed - dividendsRetained));
  // 用途估算：期初 + 本月流入 − 期末 = 本月用于投资（买股/创办/设备等）的现金。
  const invested = round2(Math.max(0, openingCash + contributed + dividendsRetained - closingCash));
  const entry: InvestorUsageEntry = {
    tick,
    cityId,
    contributed,
    dividendsReceived: dividends,
    dividendsReturned,
    dividendsRetained,
    openingCash,
    closingCash,
    invested,
  };
  const existing = history.findIndex((item) => item.tick === tick && item.cityId === cityId);
  if (existing >= 0) history[existing] = entry;
  else history.push(entry);
}

/** 裁剪投资流水到最近 INVESTOR_FUNDING_HISTORY_MONTHS 月，避免存档无限增长。 */
function pruneInvestorFundingHistory(
  funding: InvestorFundingEntry[],
  usage: InvestorUsageEntry[],
  tick: number,
): void {
  const cutoff = tick - INVESTOR_FUNDING_HISTORY_MONTHS;
  for (let index = funding.length - 1; index >= 0; index -= 1) {
    const entry = funding[index];
    if (!entry || entry.tick <= cutoff) funding.splice(index, 1);
  }
  for (let index = usage.length - 1; index >= 0; index -= 1) {
    const entry = usage[index];
    if (!entry || entry.tick <= cutoff) usage.splice(index, 1);
  }
}

/**
 * 把可投总额按各群体闲置现金比例分摊，且每组不超过自身闲置现金的 1%。
 * 尾差（分币级）按剩余容量从大到小补足，保证合计严格等于 target；确定性、无随机。
 */
function allocateIdleSavings(idles: number[], target: number): number[] {
  const takes = idles.map(() => 0);
  if (target <= 0) return takes;
  const caps = idles.map((idle) => round2(Math.max(0, idle) * IDLE_CASH_MONTHLY_INVEST_SHARE));
  const capTotal = round2(caps.reduce((sum, value) => sum + value, 0));
  if (capTotal <= 0) return takes;
  const planned = allocateMoney(target, caps);
  let assigned = 0;
  planned.forEach((value, index) => {
    const take = round2(Math.max(0, Math.min(value, caps[index] ?? 0)));
    takes[index] = take;
    assigned = round2(assigned + take);
  });
  let remaining = round2(target - assigned);
  if (remaining <= 0) return takes;
  const order = caps
    .map((_, index) => index)
    .sort(
      (left, right) =>
        round2((caps[right] ?? 0) - (takes[right] ?? 0)) -
          round2((caps[left] ?? 0) - (takes[left] ?? 0)) || left - right,
    );
  for (const index of order) {
    if (remaining <= 0) break;
    const room = round2((caps[index] ?? 0) - (takes[index] ?? 0));
    const add = round2(Math.min(room, remaining));
    if (add <= 0) continue;
    takes[index] = round2((takes[index] ?? 0) + add);
    remaining = round2(remaining - add);
  }
  return takes;
}

export const PLAYER_HOLDER: HolderRef = { type: 'player', id: 'player' };

export function groupHolder(group: InvestorGroup): HolderRef {
  return { type: 'investorGroup', id: group.id };
}

export function groupsOfCity(world: WorldState, cityId: string): InvestorGroup[] {
  return world.investors
    .filter((group) => group.cityId === cityId)
    .sort((a, b) => a.id.localeCompare(b.id));
}


function allocateMoney(total: number, weights: number[]): number[] {
  const counts = allocateProportionally(100_000, weights);
  const result = counts.map((count) => round2((total * count) / 100_000));
  const paid = round2(result.reduce((sum, value) => sum + value, 0));
  if (result.length > 0) {
    const last = result.length - 1;
    result[last] = round2((result[last] ?? 0) + (total - paid));
  }
  return result;
}

/**
 * 建立每座城市的居民投资实体。
 * 新世界初始化时给予演示初始资金（类比玩家初始现金）；旧存档迁移时 endow=false，
 * 不凭空创造资金，迁移前已存在的居民股息流由后续分红继续承接。
 */
export function createInvestorGroups(
  world: WorldState,
  config: DemoConfig,
  options: { endow?: boolean } = {},
): void {
  const endow = options.endow ?? true;
  const groups: InvestorGroup[] = [];
  for (const city of [...world.cities].sort((a, b) => a.id.localeCompare(b.id))) {
    const count = Math.max(1, config.investors.groupsPerCity);
    const weights = Array.from({ length: count }, (_, index) => count - index);
    const shares = weights.map((weight) => weight / weights.reduce((sum, value) => sum + value, 0));
    const endowment = endow
      ? round2(Math.max(0, city.householdIncomeLastMonth) * config.investors.initialCashIncomeMonths)
      : 0;
    const cashShares = allocateMoney(endowment, shares);
    for (let index = 0; index < count; index++) {
      const id = `${city.id}-invest${index + 1}`;
      groups.push({
        id,
        cityId: city.id,
        name: `${city.name}${GROUP_NAME_SUFFIX[index % GROUP_NAME_SUFFIX.length]}`,
        cash: cashShares[index] ?? 0,
        populationShare: shares[index] ?? 0,
        riskAppetite: round2(0.3 + index * 0.22),
        dividendsReceived: 0,
        lastDividend: 0,
        note: '居民投资实体（演示）：代表一部分居民，不逐人建模；内部明细不在玩家界面展示。',
      });
    }
  }
  world.investors = groups;
}

export function totalInvestorDividendsByCity(world: WorldState): Record<string, number> {
  const result: Record<string, number> = {};
  for (const group of world.investors) {
    result[group.cityId] = round2((result[group.cityId] ?? 0) + group.lastDividend);
  }
  return result;
}

/**
 * 从居民闲钱转入投资实体（v1.1 §2）。
 *
 * 口径（config 暂未设键，首版以模块常量固定）：
 * 1. 每个居民群体先保留 3 个月基本生活需求资金（householdBasicNeedCost 的 food 口径，
 *    人口 × 人均月需求 × 市场价），超出部分才是“闲置现金”；
 * 2. 每月最多把每群体闲置现金的 1% 转入投资实体（城市合计即闲置现金总额的 1%）；
 * 3. **取消“当月收入为零则不能投资”**：收入为零（失业/非劳动群体）只要仍有超过保留额的
 *    闲钱，也按闲钱上限转入；有收入时仍与旧口径整合为 min(收入 × savingsRate, 闲钱上限)，
 *    不会把两条规则叠加成两次扣款；
 * 4. 只动 group.cash，不提取银行存款、不借消费贷，转入后现金不会为负；
 * 5. 真实转账（居民现金减少 = 投资实体现金增加），不增加货币总量、不计入居民收入；
 * 6. 每笔转入与每月股息归属写入可审计份额账本与月度流水（v1.1 §2），账本只记账不改现金。
 * 同一月重复调用时跳过（防重复扣款）；流水按 (tick, 城) 去重，避免重算造成重复记录。
 */
export function collectInvestableFunds(world: WorldState, config: DemoConfig, log: LogEntry[]): void {
  const tick = world.time.tick;
  const fundingHistory = ensureInvestorFundingHistory(world);
  const usageHistory = ensureInvestorUsageHistory(world);
  // v1.4 §3：新资金按“净值/份额”一致口径增发，必须先补齐开局起始份额；
  // 否则份额合计为 0/偏低会把净值算虚高，新资金换到过多份额、稀释原持有人。
  ensureInvestorOpeningShares(world);
  for (const city of [...world.cities].sort((a, b) => a.id.localeCompare(b.id))) {
    const groups = groupsOfCity(world, city.id);
    if (groups.length === 0) continue;
    const householdGroups = householdGroupsOfCity(world, city.id);
    // 同月幂等：本月已执行过（investableContribution>0）就不再扣第二次；
    // 股息归属按 tick 单独幂等，因此这里只补账、不重复转账。
    if (city.lastMonth.investableContribution > 0) {
      attributeInvestorDividends(world, city.id, householdGroups, tick);
      continue;
    }
    const income = Math.max(0, city.householdIncomeLastMonth);
    const incomeDesired = round2(income * config.investors.savingsRate);
    const idles = householdGroups.map((group) => householdIdleCash(world, group, config));
    const idleTotal = round2(idles.reduce((sum, value) => sum + value, 0));
    const idleCap = round2(idleTotal * IDLE_CASH_MONTHLY_INVEST_SHARE);
    // v1.1：收入为零不再阻止投资；有收入时仍取收入意愿额与闲钱上限的较小者。
    const target = round2(income > 0 ? Math.min(incomeDesired, idleCap) : idleCap);
    const takes = allocateIdleSavings(idles, target);
    // v1.4 §3：转入前的实体净值与有效份额，决定每 1 信用点应换多少份额。
    // 零净资产（净值=0）时回退 1:1：此时旧份额价值为 0，新资金按 1:1 入账不会稀释任何人。
    const equityBefore = cityInvestorEquity(world, city.id);
    const sharesBefore = round2(
      householdGroups.reduce(
        (sum, group) => sum + effectiveInvestorShares(group.investorLedger),
        0,
      ),
    );
    const navPerShare = investorNavPerShare(equityBefore, sharesBefore);
    let contribution = 0;
    householdGroups.forEach((group, index) => {
      const take = takes[index] ?? 0;
      if (take <= 0) return;
      // 真实转账：现金减少、投资实体同额增加；现金不足的群体 idle=0，不会转出。
      group.cash = round2(group.cash - take);
      group.lastMonth.savingsContribution = round2(group.lastMonth.savingsContribution + take);
      group.lastMonth.netCashChange = round2(group.lastMonth.netCashChange - take);
      // v1.4 §3：按净值换算份额（不再是 1:1），保证新资金进入后原持有人每份价值不变；
      // contributed 仍记真实投入现金，便于审计与报告。
      const ledger = ensureInvestorLedger(group);
      ledger.contributed = round2(ledger.contributed + take);
      ledger.shares = round2(ledger.shares + sharesForInvestorValue(take, navPerShare));
      ledger.lastContributionTick = tick;
      contribution = round2(contribution + take);
    });
    if (contribution > 0) {
      const amounts = allocateMoney(contribution, groups.map((group) => group.populationShare));
      groups.forEach((group, index) => {
        group.cash = round2(group.cash + (amounts[index] ?? 0));
      });
      // 流水按 (tick, 城) 去重后重建，保证重复调用/测试重算不会重复记录。
      for (let index = fundingHistory.length - 1; index >= 0; index -= 1) {
        const entry = fundingHistory[index];
        if (entry && entry.tick === tick && entry.cityId === city.id) {
          fundingHistory.splice(index, 1);
        }
      }
      householdGroups.forEach((group, index) => {
        const take = takes[index] ?? 0;
        if (take <= 0) return;
        fundingHistory.push({
          tick,
          cityId: city.id,
          householdGroupId: group.id,
          amount: take,
        });
      });
    }
    city.householdIncomeLastMonth = round2(
      Math.max(0, city.householdIncomeLastMonth - contribution),
    );
    city.lastMonth.investableContribution = contribution;
    const dividends = round2(totalInvestorDividendsByCity(world)[city.id] ?? 0);
    city.lastMonth.investorDividends = dividends;
    // 账本：按份额归属本月股息（只记账，不划现金）；再记本月资金用途快照。
    attributeInvestorDividends(world, city.id, householdGroups, tick);
    recordInvestorUsage(
      world,
      config,
      usageHistory,
      city.id,
      tick,
      contribution,
      dividends,
    );
    if (contribution > 0) {
      log.push({
        tick,
        kind: 'government',
        message: `${city.name} 居民闲钱投资：本月转入投资实体 ${contribution.toFixed(0)} 信用点（先保留 3 个月基本生活需求，闲置现金最多转 ${(IDLE_CASH_MONTHLY_INVEST_SHARE * 100).toFixed(1)}%）。`,
      });
    }
  }
  pruneInvestorFundingHistory(fundingHistory, usageHistory, tick);
}

/**
 * 每月居民投资实体报告（任务书第五节第 5 条 + v1.1 §2 可审计要求）。
 * 只读聚合，不修改世界；金额与 household-groups 的权益口径一致（市值法）。
 */
export interface InvestorGroupFundingReport {
  groupId: string;
  cityId: string;
  name: string;
  /** 可用现金（投资实体自己的账户） */
  cash: number;
  /** 持股按当前城市市价的估值 */
  holdingsValue: number;
  /** 本月收到的股息（分红回流前，实体侧记账） */
  dividendIncomeLastMonth: number;
  /** 累计收到的股息（含已返还居民部分） */
  dividendsReceived: number;
  /** 持有的政府债券估值（未到期本金 + 已计提未付利息，v1.4 §3） */
  bondsValue: number;
  /** 实体净资产 = 现金 + 持股市值 + 债券估值 */
  netWorth: number;
}

/** v1.1 §2：居民群体投资份额账本的可审计视图（投入/份额/归属股息）。 */
export interface HouseholdFundingShare {
  householdGroupId: string;
  name: string;
  occupation: string;
  /** 累计从该群体转入投资实体的现金 */
  contributed: number;
  /** 历史投入份额（v1.4 §3 起按转入时净值换算，不再与投入现金 1:1） */
  shares: number;
  /** 开局/旧档无主旧资产的一次性起始份额（旧档缺省 0） */
  openingShares: number;
  /** 有效份额 = shares + openingShares（股息/财富/授信/展示的权威口径） */
  effectiveShares: number;
  /** 占本城有效份额的比例（0~1，四位小数） */
  shareRatio: number;
  /** 按份额归属给该群体的累计股息（只审计，不重复计收入） */
  attributedDividends: number;
}

/** 本月投资实体资金用途快照（来源、股息返还/留存、期初期末现金、已用于投资的现金）。 */
export interface InvestorUsageSummary {
  tick: number;
  contributed: number;
  dividendsReceived: number;
  dividendsReturned: number;
  dividendsRetained: number;
  openingCash: number;
  closingCash: number;
  /** 期初 + 本月流入 − 期末：本月用于买股/创办/设备等投资的现金估算 */
  invested: number;
}

export interface CityInvestorFundingReport {
  cityId: string;
  cityName: string;
  /** 本月居民闲钱转入的投资实体资金（真实转账） */
  householdContribution: number;
  investorCash: number;
  groups: InvestorGroupFundingReport[];
  /** 本城最近一个月的资金用途快照；尚无记录时全为 0 */
  usage: InvestorUsageSummary;
  /** 本城每月实际转入金额（按 tick 升序，最多保留 INVESTOR_FUNDING_HISTORY_MONTHS 月） */
  monthlyFunding: { tick: number; amount: number }[];
  /** 居民群体投入/份额/归属股息账本（可审计） */
  householdShares: HouseholdFundingShare[];
  /** 本城投资实体净资产（现金 + 持股市值 + 未到期国债本息，v1.4 §3） */
  investorNetWorth: number;
  note: string;
}

const EMPTY_INVESTOR_USAGE: InvestorUsageSummary = {
  tick: 0,
  contributed: 0,
  dividendsReceived: 0,
  dividendsReturned: 0,
  dividendsRetained: 0,
  openingCash: 0,
  closingCash: 0,
  invested: 0,
};

export function investorFundingReport(world: WorldState): CityInvestorFundingReport[] {
  const companyById = new Map(world.companies.map((company) => [company.id, company]));
  return [...world.cities]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((city) => {
      const prices = cityMarketPrices(city);
      const groups = groupsOfCity(world, city.id).map((group) => {
        const holdingsValue = round2(
          world.securities.holdings
            .filter(
              (holding) =>
                holding.holder.type === 'investorGroup' && holding.holder.id === group.id,
            )
            .reduce((sum, holding) => {
              const company = companyById.get(holding.companyId);
              return company ? sum + holding.shares * companySharePrice(company, prices) : sum;
            }, 0),
        );
        return {
          groupId: group.id,
          cityId: group.cityId,
          name: group.name,
          cash: round2(group.cash),
          holdingsValue,
          dividendIncomeLastMonth: round2(group.lastDividend),
          dividendsReceived: round2(group.dividendsReceived),
          bondsValue: investorBondValue(world, group.id),
          netWorth: round2(group.cash + holdingsValue + investorBondValue(world, group.id)),
        };
      });
      // 本月实际转入流水：同一 tick 聚合，按 tick 升序（旧档缺省为空）。
      const fundingByTick = new Map<number, number>();
      for (const entry of world.households.investorFundingHistory ?? []) {
        if (entry.cityId !== city.id) continue;
        fundingByTick.set(entry.tick, round2((fundingByTick.get(entry.tick) ?? 0) + entry.amount));
      }
      const monthlyFunding = [...fundingByTick.entries()]
        .map(([tick, amount]) => ({ tick, amount: round2(amount) }))
        .sort((left, right) => left.tick - right.tick);
      // 最近一个月用途快照。
      let latestUsage: InvestorUsageEntry | undefined;
      for (const entry of world.households.investorUsageHistory ?? []) {
        if (entry.cityId !== city.id) continue;
        if (!latestUsage || entry.tick > latestUsage.tick) latestUsage = entry;
      }
      const usage: InvestorUsageSummary = latestUsage
        ? {
            tick: latestUsage.tick,
            contributed: round2(latestUsage.contributed),
            dividendsReceived: round2(latestUsage.dividendsReceived),
            dividendsReturned: round2(latestUsage.dividendsReturned),
            dividendsRetained: round2(latestUsage.dividendsRetained),
            openingCash: round2(latestUsage.openingCash),
            closingCash: round2(latestUsage.closingCash),
            invested: round2(latestUsage.invested),
          }
        : { ...EMPTY_INVESTOR_USAGE };
      // 居民群体账本：v1.4 §3 起份额按转入时净值换算，展示/占比必须用有效份额
      // （shares + openingShares），否则会把开局旧资产份额或按净值增发的份额漏掉。
      const residents = householdGroupsOfCity(world, city.id);
      const effectiveSharesOf = (group: HouseholdGroup): number =>
        effectiveInvestorShares(group.investorLedger);
      const totalShares = round2(
        residents.reduce((sum, group) => sum + effectiveSharesOf(group), 0),
      );
      const householdShares = residents
        .filter((group) => {
          const ledger = group.investorLedger;
          return (
            Boolean(ledger) &&
            ((ledger?.contributed ?? 0) > 0 || effectiveSharesOf(group) > 0)
          );
        })
        .map((group) => {
          const ledger = group.investorLedger;
          const shares = round2(ledger?.shares ?? 0);
          const openingShares = round2(ledger?.openingShares ?? 0);
          const effectiveShares = effectiveSharesOf(group);
          return {
            householdGroupId: group.id,
            name: group.name,
            occupation: group.occupation,
            contributed: round2(ledger?.contributed ?? 0),
            shares,
            openingShares,
            effectiveShares,
            shareRatio:
              totalShares > 0 ? Math.round((effectiveShares / totalShares) * 10_000) / 10_000 : 0,
            attributedDividends: round2(ledger?.dividends ?? 0),
          };
        });
      return {
        cityId: city.id,
        cityName: city.name,
        householdContribution: round2(city.lastMonth.investableContribution),
        investorCash: round2(groups.reduce((sum, group) => sum + group.cash, 0)),
        groups,
        usage,
        monthlyFunding,
        householdShares,
        investorNetWorth: cityInvestorEquity(world, city.id),
        note: '居民闲钱投资：先保留 3 个月基本生活需求，闲置现金每月最多转入 1%；不提取存款、不借消费贷；账本记录各群体投入、份额（含开局起始份额 openingShares）与归属股息。',
      };
    });
}

/**
 * 确定性伪随机：只依赖世界种子与传入标识，不读取时钟、不使用 Math.random。
 * 用于同一评分下的稳定抖动，保证“相同种子 + 相同操作序列 = 相同结果”。
 */
function stableUnit(seed: number, ...parts: (string | number)[]): number {
  let hash = (seed >>> 0) ^ 0x9e3779b9;
  for (const part of parts) {
    const text = String(part);
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619) >>> 0;
    }
    hash = Math.imul(hash ^ 0x85ebca6b, 2246822519) >>> 0;
  }
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0x5bd1e995) >>> 0;
  hash ^= hash >>> 15;
  return (hash >>> 0) / 4294967296;
}

/** 最近一个完整月的利润：本月已结算则用 lastMonth，否则回退 previousMonth（只读演示口径）。 */
function recentProfit(company: Company): number {
  if (company.lastMonth.profit !== 0) return round2(company.lastMonth.profit);
  return round2(company.previousMonth.profit);
}

/** 用真实财务给单家企业估值：账面股权、负债/权益、最近利润与行情趋势（无成交时按账面价）。 */
interface CompanyFinancials {
  equity: number;
  profit: number;
  profitYield: number;
  debtRatio: number;
  price: number;
  lastPrice: number;
  /** 最近 lookbackMonths 根 K 线的收盘价变化率；无行情时为 0。 */
  momentum: number;
  /** 相对最近成交价的折价（>0 表示市价低于账面价）。 */
  valueGap: number;
}

function financialsOf(
  world: WorldState,
  company: Company,
  shareClassIdValue: string,
  config: DemoConfig,
): CompanyFinancials {
  const city = world.cities.find((candidate) => candidate.id === company.cityId);
  const equity = city ? round2(companyBookValue(company, cityMarketPrices(city))) : 0;
  const profit = recentProfit(company);
  const profitYield = equity > 0 ? round2(profit / equity) : 0;
  const debtRatio = equity > 0 ? round2(company.debt / equity) : Number.POSITIVE_INFINITY;
  const price = bookPrice(world, company);
  const lastPrice = latestStockPrice(world, shareClassIdValue) ?? price;
  const lookback = Math.max(1, Math.floor(config.securities.ai.lookbackMonths));
  const candles = stockHistoryFor(world, shareClassIdValue)?.candles ?? [];
  const window = candles.slice(-lookback);
  const first = window[0]?.close ?? lastPrice;
  const last = window[window.length - 1]?.close ?? lastPrice;
  const momentum = first > 0 ? round2(last / first - 1) : 0;
  const valueGap = lastPrice > 0 ? round2((price - lastPrice) / lastPrice) : 0;
  return { equity, profit, profitYield, debtRatio, price, lastPrice, momentum, valueGap };
}

/** 玩家经营企业判定（与 management/operations.canOperate 同口径；此处内联以避免模块循环依赖）。 */
function isPlayerOperated(world: WorldState, companyId: string): boolean {
  const control = world.governance?.controls?.find((entry) => entry.companyId === companyId);
  return !!control && control.operator !== 'management' && control.operator.type === 'player';
}

/** 每月按最新账面价重挂自动订单，避免旧限价长期偏离市场。 */
function clearOrders(
  world: WorldState,
  holder: HolderRef,
  shareClassIdValue: string,
  side: 'buy' | 'sell',
): void {
  world.securities.orders = world.securities.orders.filter(
    (order) =>
      !(
        order.side === side &&
        order.shareClassId === shareClassIdValue &&
        order.holder.type === holder.type &&
        order.holder.id === holder.id
      ),
  );
}

function votingClassOf(world: WorldState, companyId: string) {
  return world.securities.classes.find(
    (candidate) => candidate.companyId === companyId && candidate.kind === 'voting',
  );
}

/** 企业当前可交易的两类股份（存在才返回；顺序固定为仅分红在前，便于确定性排序）。 */
function classesForCompany(world: WorldState, companyId: string): ShareClass[] {
  return world.securities.classes
    .filter((candidate) => candidate.companyId === companyId)
    .sort((a, b) => a.kind.localeCompare(b.kind));
}

/**
 * 每股股息收益率：最近一个完整月的实际派息 ÷ 总股本 ÷ 参考价
 * （两类股份按持股比例分享同一笔分红）。
 *
 * 注意：收益率是无量纲比率（默认阈值 0.002 = 月 0.2%），必须保留足够精度再参与
 * 惜售阈值比较与买入评分；若先按货币精度（round2）舍入，0.0019~0.0021 这类真实
 * 收益率会被抹成 0 或 0.01，惜售规则与评分都会失真。金额与展示各自按需舍入。
 */
export function dividendYieldOf(company: Company, price: number): number {
  if (!(price > 0) || !(company.totalShares > 0)) return 0;
  const dividendPerShare = company.lastMonth.dividendsPaid / company.totalShares;
  if (!(dividendPerShare > 0)) return 0;
  const yieldValue = dividendPerShare / price;
  return Number.isFinite(yieldValue) ? yieldValue : 0;
}

/**
 * 仅分红股份的买入评分加成：基础偏好 + 股息率 × 权重（收益率保留原始精度）。
 * 独立导出以便测试精度；调用方仍按真实资金与撮合规则下单，不因此制造交易。
 */
export function nonVotingScoreBonus(yieldValue: number, config: DemoConfig): number {
  const ai = config.securities.ai;
  return ai.nonVotingBuyBias + Math.min(yieldValue, 0.1) * ai.nonVotingDividendWeight;
}

interface PlannedSell {
  company: Company;
  shareClass: ShareClass;
  shares: number;
  limitPrice: number;
  gainRatio: number;
  priority: number;
}

interface PlannedCandidate {
  company: Company;
  shareClassIdValue: string;
  kind: 'voting' | 'nonVoting';
  financials: CompanyFinancials;
  score: number;
}

/**
 * 居民投资实体的自动下单（可替换规则，不是逐居民 AI）。
 *
 * v0.8 改进：
 * - 用真实财务与行情决定买卖：账面股权、最近利润、负债/权益、最近成交价与 K 线趋势；
 * - 风险偏好（riskAppetite）与现金规模影响限价、预算与追涨/价值倾向；
 * - 只用真实现金与持仓（placeOrder 二次校验，撮合时再校验）；
 * - 每月每实体买单数受 maxBuyOrdersPerGroup、卖单数受 maxSellOrdersPerGroup 限制；
 * - 买入预算受 groupBudgetShare 限制，且不会在同一股份类别上同时挂买卖（避免自成交）。
 */
export function planInvestorOrders(world: WorldState, config: DemoConfig, tick: number): void {
  const ai = config.securities.ai;
  if (!ai.enabled) return;
  const groups = [...world.investors].sort((a, b) => a.id.localeCompare(b.id));
  const companies = [...world.companies].sort((a, b) => a.id.localeCompare(b.id));
  const maxBuy = Math.max(1, Math.floor(ai.maxBuyOrdersPerGroup));
  const maxSell = Math.max(1, Math.floor(ai.maxSellOrdersPerGroup));

  for (const group of groups) {
    const holder = groupHolder(group);
    const risk = clamp(group.riskAppetite, 0, 1);
    const sellingClasses = new Set<string>();
    let sellCount = 0;

    // 1) 卖出：投票权与仅分红两类股份各自按真实持仓提供流动性。
    //    v0.8.2 修复：此前只遍历 votingClassOf，仅分红股份永远不会被自动卖出。
    const cashPressed = group.cash < config.investors.minCashToInvest * ai.nonVotingCashPressureMultiple;
    const sellCandidates: PlannedSell[] = [];
    for (const company of companies) {
      const price = bookPrice(world, company);
      if (!Number.isFinite(price) || price <= 0) continue;
      for (const shareClass of classesForCompany(world, company.id)) {
        const holding = world.securities.holdings.find(
          (entry) =>
            entry.shareClassId === shareClass.id &&
            entry.holder.type === 'investorGroup' &&
            entry.holder.id === group.id,
        );
        if (!holding || holding.shares < 10) continue;
        const lastPrice = latestStockPrice(world, shareClass.id) ?? price;
        const gainRatio = price > 0 ? round2(lastPrice / price - 1) : 0;
        const nonVoting = shareClass.kind === 'nonVoting';
        let sellShare = nonVoting ? ai.nonVotingSellShare : config.investors.liquiditySellShare;
        let limitPremium: number = nonVoting ? ai.nonVotingSellLimitPremium : 1.02;
        let priority = gainRatio >= ai.takeProfitRatio ? 1.3 : 1;
        if (nonVoting) {
          // 现金需求：提高仅分红股份的卖出比例并接受小幅折价；高股息时惜售。
          if (cashPressed) {
            sellShare *= ai.nonVotingCashPressureBoost;
            limitPremium = ai.nonVotingCashPressureLimitPremium;
            priority += 0.5;
          }
          if (dividendYieldOf(company, price) >= ai.nonVotingDividendHoldThreshold) {
            sellShare *= ai.nonVotingDividendHoldFactor;
          }
        }
        if (gainRatio >= ai.takeProfitRatio) {
          // 市价明显高于账面价：落袋意愿随风险偏好上升（高风险更愿意卖出锁定收益）。
          sellShare *= 1.5 + risk;
        } else if (gainRatio <= -ai.takeProfitRatio) {
          // 市价明显低于账面价：惜售，减少流动性供给。
          sellShare *= 0.5;
        }
        const shares = Math.floor(holding.shares * clamp(sellShare, 0, 0.25));
        if (shares < 1) continue;
        const limitPrice = round2(price * limitPremium);
        if (!Number.isFinite(limitPrice) || limitPrice <= 0) continue;
        sellCandidates.push({ company, shareClass, shares, limitPrice, gainRatio, priority });
      }
    }
    // 卖出配额：仅分红至少 1 笔（现金需求时 2 笔），其余名额给投票权股份。
    // 投票权按公司 id 顺序覆盖不同企业（与旧行为一致，保证企业买方有可成交对手方），
    // 仅分红按优先级（现金需求/止盈）选择；两类换算互不挤占。
    const votingCandidates = sellCandidates
      .filter((candidate) => candidate.shareClass.kind === 'voting')
      .sort(
        (a, b) =>
          a.company.id.localeCompare(b.company.id) ||
          a.shareClass.id.localeCompare(b.shareClass.id),
      );
    const nonVotingCandidates = sellCandidates
      .filter((candidate) => candidate.shareClass.kind === 'nonVoting')
      .sort(
        (a, b) =>
          b.priority - a.priority ||
          a.company.id.localeCompare(b.company.id) ||
          a.shareClass.id.localeCompare(b.shareClass.id),
      );
    // 仅分红卖单与投票权卖单分开计数：投票权仍覆盖 maxSell 家企业（保持既有市场流动性），
    // 仅分红按现金需求挂 1–2 笔，两类互不挤占名额。
    const nonVotingQuota = Math.min(
      ai.nonVotingMaxSellOrdersPerGroup,
      cashPressed ? ai.nonVotingMaxSellOrdersPerGroup : 1,
    );
    const chosenSells: PlannedSell[] = [
      ...votingCandidates.slice(0, maxSell),
      ...nonVotingCandidates.slice(0, nonVotingQuota),
    ];
    chosenSells.sort(
      (a, b) =>
        a.shareClass.kind.localeCompare(b.shareClass.kind) ||
        a.company.id.localeCompare(b.company.id),
    );
    for (const candidate of chosenSells) {
      clearOrders(world, holder, candidate.shareClass.id, 'sell');
      const placed = placeOrder(world, {
        companyId: candidate.company.id,
        shareClassId: candidate.shareClass.id,
        side: 'sell',
        holder,
        shares: candidate.shares,
        limitPrice: candidate.limitPrice,
        tick,
        note: `${group.name} 按最新账面价提供流动性（${candidate.shareClass.kind === 'nonVoting' ? '仅分红' : '投票权'}${candidate.gainRatio >= ai.takeProfitRatio ? '，止盈' : ''}${cashPressed && candidate.shareClass.kind === 'nonVoting' ? '，现金需求' : ''}，演示自动规则）`,
      });
      if (placed.ok) {
        sellCount += 1;
        sellingClasses.add(candidate.shareClass.id);
      }
    }

    // 2) 买入：按真实财务 + 行情 + 风险偏好打分，预算与订单数受配置约束。
    if (group.cash < config.investors.minCashToInvest) continue;
    const budget = round2(group.cash * ai.groupBudgetShare);
    if (budget < 1) continue;

    const candidates: PlannedCandidate[] = [];
    for (const company of companies) {
      if (company.totalShares <= 0) continue;
      const votingStake =
        company.totalShares > 0
          ? holderVotingShares(world, company.id, holder) / company.totalShares
          : 0;
      const atCap = votingStake >= config.investors.maxVotingStakeShare * 0.85;
      // v0.8.2：两类股份都进入候选池；投票权接近持股上限时只排除投票权候选，
      // 仅分红类别仍按股息收益率、折价、趋势与风险偏好独立打分（不只是“被动兜底”）。
      for (const shareClass of classesForCompany(world, company.id)) {
        if (shareClass.kind === 'voting' && atCap) continue;
        if (sellingClasses.has(shareClass.id)) continue; // 同一类别不双向挂单，避免自成交
        const financials = financialsOf(world, company, shareClass.id, config);
        if (!Number.isFinite(financials.price) || financials.price <= 0) continue;
        // 低风险偏好更看重折价与盈利（价值），高风险偏好更愿意追趋势。
        const valueWeight = 1 - risk * 0.5;
        const trendWeight = risk * ai.riskWeight;
        const dividendYield = dividendYieldOf(company, financials.price);
        const classBonus =
          shareClass.kind === 'nonVoting' ? nonVotingScoreBonus(dividendYield, config) : 0;
        const score =
          financials.valueGap * valueWeight +
          clamp(financials.momentum, -0.3, 0.3) * trendWeight +
          financials.profitYield * (0.2 + risk * 0.2) +
          classBonus +
          stableUnit(world.seed, tick, group.id, company.id, shareClass.kind) * 0.01;
        candidates.push({
          company,
          shareClassIdValue: shareClass.id,
          kind: shareClass.kind,
          financials,
          // 评分只是排序用的无量纲值：保留原始精度（尤其股息率贡献），不按货币精度舍入。
          score,
        });
      }
    }
    candidates.sort(
      (a, b) =>
        b.score - a.score ||
        a.company.id.localeCompare(b.company.id) ||
        a.kind.localeCompare(b.kind),
    );

    let buyCount = 0;
    let remainingBudget = budget;
    for (const candidate of candidates) {
      if (buyCount >= maxBuy || remainingBudget < 1) break;
      const riskPremium = config.investors.orderBidDiscount * (1 - risk * ai.riskWeight);
      // 仅分红股份：股息偏好可以支付少量溢价；投票权仍按风险折价报价。
      const limitPrice = round2(
        candidate.financials.price *
          (candidate.kind === 'nonVoting' ? 1 - riskPremium + ai.nonVotingBidPremium : 1 - riskPremium),
      );
      if (!Number.isFinite(limitPrice) || limitPrice <= 0) continue;
      // 第一笔用 60% 预算，第二笔用剩余；总额严格不超过 groupBudgetShare 预算。
      const orderBudget =
        buyCount === 0 && maxBuy > 1 ? round2(remainingBudget * 0.6) : remainingBudget;
      let shares = Math.floor(orderBudget / limitPrice);
      if (shares < 1) continue;
      if (candidate.kind === 'voting') {
        const currentVoting = holderVotingShares(world, candidate.company.id, holder);
        const maxByStake = Math.floor(
          config.investors.maxVotingStakeShare * candidate.company.totalShares - currentVoting,
        );
        shares = Math.min(shares, Math.max(0, maxByStake));
        if (shares < 1) continue;
      }
      const cost = round2(shares * limitPrice);
      if (cost > remainingBudget + 0.01 || cost > group.cash + 0.01) continue;
      clearOrders(world, holder, candidate.shareClassIdValue, 'buy');
      const placed = placeOrder(world, {
        companyId: candidate.company.id,
        shareClassId: candidate.shareClassIdValue,
        side: 'buy',
        holder,
        shares,
        limitPrice,
        tick,
        note: `${group.name} 自动投资（${candidate.kind === 'voting' ? '投票权' : '仅分红'}；折价 ${candidate.financials.valueGap.toFixed(3)}，最近利润 ${candidate.financials.profit.toFixed(0)}；演示规则）`,
      });
      if (placed.ok) {
        buyCount += 1;
        remainingBudget = round2(remainingBudget - cost);
      }
    }
  }
}

/**
 * 企业作为股票市场买方：只允许买入有投票权类别（用户已确认的规则）。
 *
 * v0.8：只对真实财务允许的企业下单——现金需高于 companyReserveWageMonths 个月工资，
 * 预算 = min(companyBudgetCap, 现金 × companyBudgetShare)；目标必须账面股权为正、
 * 负债/权益不过高、最近利润非负（requireNonNegativeProfit），并用行情折价/趋势打分。
 * 玩家经营的企业不参与 AI 下单（经营决策归玩家）。
 */
export function planCompanyOrders(world: WorldState, config: DemoConfig, tick: number): void {
  const ai = config.securities.ai;
  if (!ai.enabled) return;
  const companies = [...world.companies].sort((a, b) => a.id.localeCompare(b.id));

  for (const company of companies) {
    if (isPlayerOperated(world, company.id)) continue;
    const wage = monthlyWageBill(company, config);
    if (company.cash <= wage * ai.companyReserveWageMonths) continue;
    const budget = round2(
      Math.min(ai.companyBudgetCap, company.cash * ai.companyBudgetShare),
    );
    if (budget < 1) continue;

    const candidates: PlannedCandidate[] = [];
    for (const target of companies) {
      if (target.id === company.id) continue;
      if (target.totalShares <= 0) continue;
      const shareClass = votingClassOf(world, target.id);
      if (!shareClass) continue;
      const financials = financialsOf(world, target, shareClass.id, config);
      if (!Number.isFinite(financials.price) || financials.price <= 0) continue;
      if (financials.equity <= 0) continue;
      if (financials.debtRatio > 1.5) continue; // 高杠杆目标不做财务投资
      if (ai.requireNonNegativeProfit && financials.profit < 0) continue;
      const risk = company.ai?.style === 'growth' ? 1 : company.ai?.style === 'return' ? 0.2 : 0.5;
      const score =
        financials.valueGap * (1 - risk * 0.3) +
        clamp(financials.momentum, -0.3, 0.3) * risk * ai.riskWeight +
        financials.profitYield * 0.5 +
        (1 - clamp(financials.debtRatio, 0, 1)) * 0.1 +
        stableUnit(world.seed, tick, company.id, target.id) * 0.01;
      candidates.push({
        company: target,
        shareClassIdValue: shareClass.id,
        kind: 'voting',
        financials,
        score: round2(score),
      });
    }
    if (candidates.length === 0) continue;
    candidates.sort(
      (a, b) => b.score - a.score || a.company.id.localeCompare(b.company.id),
    );
    const target = candidates[0]!;
    // 企业买方对目标支付小额溢价（旧行为 3%），扩张型略高、回报型略低。
    const premium =
      company.ai?.style === 'growth' ? 0.04 : company.ai?.style === 'return' ? 0.02 : 0.03;
    const limitPrice = round2(target.financials.price * (1 + premium));
    if (!Number.isFinite(limitPrice) || limitPrice <= 0) continue;
    const shares = Math.floor(budget / limitPrice);
    if (shares < 1) continue;
    const holder: HolderRef = { type: 'company', id: company.id };
    clearOrders(world, holder, target.shareClassIdValue, 'buy');
    placeOrder(world, {
      companyId: target.company.id,
      shareClassId: target.shareClassIdValue,
      side: 'buy',
      holder,
      shares,
      limitPrice,
      tick,
      note: `${company.name} 作为企业买方买入 ${target.company.name} 投票权股份（账面折价 ${target.financials.valueGap.toFixed(3)}，最近利润 ${target.financials.profit.toFixed(0)}；演示）`,
    });
  }
}

/** 融资要约为企业提供逐出资方的股份类别；接受前不改变任何资产。 */
export function maybeCreateCompanyFinancing(
  world: WorldState,
  config: DemoConfig,
  tick: number,
  log: LogEntry[],
): void {
  const ordered = [...world.companies].sort((a, b) => a.id.localeCompare(b.id));
  let created = 0;
  for (const company of ordered) {
    if (created >= 2) break;
    const wage = monthlyWageBill(company, config);
    // 现金低于两个月工资时视为需要融资（演示阈值）。
    if (company.cash >= wage * 2) continue;
    const open = world.securities.offers.some(
      (offer) => offer.companyId === company.id && offer.status === 'open',
    );
    if (open) continue;
    const recent = world.securities.offers
      .filter((offer) => offer.companyId === company.id)
      .reduce((latest, offer) => Math.max(latest, offer.createdTick), -999);
    if (tick - recent < 3) continue;

    const cityGroups = groupsOfCity(world, company.cityId).sort(
      (a, b) => b.cash - a.cash || a.id.localeCompare(b.id),
    );
    const group = cityGroups[0];
    const price = bookPrice(world, company);
    let offers = 0;
    if (group && group.cash > 0) {
      const amount = Math.min(round2(wage * 2), 1_500_000, group.cash);
      if (amount > 0) {
        const result = createFinancingOffer(world, {
          companyId: company.id,
          investor: groupHolder(group),
          kind: 'nonVoting',
          amount,
          pricePerShare: price,
          tick,
          note: `${group.name} 的仅分红融资方案（逐出资方约定，无投票权）`,
        });
        if (result.ok) offers += 1;
      }
    }
    const external = [...world.companies]
      .filter(
        (candidate) =>
          candidate.id !== company.id &&
          candidate.cityId !== company.cityId &&
          candidate.cash > monthlyWageBill(candidate, config) * 3,
      )
      .sort((a, b) => b.cash - a.cash || a.id.localeCompare(b.id))[0];
    if (external) {
      const amount = Math.min(round2(wage), 800_000, round2(external.cash * 0.1));
      if (amount > 0) {
        const result = createFinancingOffer(world, {
          companyId: company.id,
          investor: { type: 'company', id: external.id },
          kind: 'voting',
          amount,
          pricePerShare: price,
          tick,
          note: `${external.name} 的融资方案（有投票权；企业买方必须取得投票权）`,
        });
        if (result.ok) offers += 1;
      }
    }

    // 给玩家的融资要约：提供实际可操作的接受/拒绝入口（个人融资权利仍为暂定）。
    const openPlayerOffers = world.securities.offers.filter(
      (offer) => offer.status === 'open' && offer.investor.type === 'player',
    ).length;
    if (openPlayerOffers < 3 && world.player.cash > 200_000) {
      const amount = Math.min(round2(wage * 0.5), 300_000, round2(world.player.cash * 0.2));
      if (amount >= 10_000) {
        const result = createFinancingOffer(world, {
          companyId: company.id,
          investor: { type: 'player', id: 'player' },
          kind: 'voting',
          amount,
          pricePerShare: price,
          tick,
          note: '面向玩家的融资方案（暂定：个人出资取得有投票权股份）',
        });
        if (result.ok) offers += 1;
      }
    }
    if (offers > 0) {
      created += 1;
      log.push({
        tick,
        kind: 'market',
        message: `${company.name} 发布 ${offers} 份融资方案，分别约定不同股份权利。`,
      });
    }
  }
}

/** 居民投资实体与企业按演示规则回应融资要约；玩家需要自己决定。 */
export function autoDecideFinancingOffers(
  world: WorldState,
  config: DemoConfig,
  tick: number,
): void {
  // 玩家要约在若干期后失效，避免未处理的要约无限堆积。
  for (const offer of world.securities.offers) {
    if (
      offer.status === 'open' &&
      offer.investor.type === 'player' &&
      tick - offer.createdTick > 4
    ) {
      offer.status = 'expired';
    }
  }
  const offers = world.securities.offers
    .filter((offer) => offer.status === 'open' && offer.investor.type !== 'player')
    .sort((a, b) => a.id.localeCompare(b.id));
  for (const offer of offers) {
    const company = world.companies.find((candidate) => candidate.id === offer.companyId);
    if (!company) continue;
    const price = bookPrice(world, company);
    if (offer.investor.type === 'investorGroup') {
      const group = world.investors.find((candidate) => candidate.id === offer.investor.id);
      if (!group) continue;
      const affordable = group.cash + 1e-6 >= offer.amount;
      const acceptable = offer.pricePerShare <= price * (1 + config.investors.maxBuyPremium);
      const votingOk =
        offer.kind !== 'voting' ||
        company.totalShares <= 0 ||
        (holderVotingShares(world, company.id, offer.investor) + offer.shares) /
          company.totalShares <=
          config.investors.maxVotingStakeShare;
      if (affordable && acceptable && votingOk) {
        acceptFinancingOffer(world, offer.id, tick);
      } else {
        declineFinancingOffer(world, offer.id);
      }
      continue;
    }
    if (offer.investor.type === 'company') {
      const buyer = world.companies.find((candidate) => candidate.id === offer.investor.id);
      if (!buyer) continue;
      const affordable = buyer.cash >= offer.amount * 2;
      const acceptable = offer.pricePerShare <= price * 1.05;
      if (affordable && acceptable) {
        acceptFinancingOffer(world, offer.id, tick);
      } else {
        declineFinancingOffer(world, offer.id);
      }
    }
  }
}

/**
 * 群体迁移/人口变化的一致性说明：
 * populationShare 保持不变，representedPeople = 城市总人口 × share（派生值）。
 * 人口迁入迁出不会自动带走或带来投资实体资产；这是初期简化，交付文档中说明。
 */
export function representedPeople(world: WorldState, group: InvestorGroup): number {
  const city = world.cities.find((candidate) => candidate.id === group.cityId);
  return city ? Math.round(city.population.total * group.populationShare) : 0;
}

/** 供测试/审计：实体持有的股份总量（两类合计）。 */
export function groupTotalShares(world: WorldState, group: InvestorGroup): number {
  const holder = groupHolder(group);
  return round2(
    [...world.companies].reduce(
      (total, company) => total + holderTotalShares(world, company.id, holder),
      0,
    ),
  );
}

export function groupVotingSummary(world: WorldState, group: InvestorGroup): number {
  const holder = groupHolder(group);
  return round2(
    [...world.companies].reduce(
      (total, company) => total + holderVotingShares(world, company.id, holder),
      0,
    ),
  );
}

/** 仅用于诊断：实体在各企业的持股行数。 */
export function groupHoldingRows(world: WorldState, group: InvestorGroup): number {
  return world.securities.holdings.filter(
    (holding) => holding.holder.type === 'investorGroup' && holding.holder.id === group.id,
  ).length;
}

export function companyHolderCount(world: WorldState, companyId: string): number {
  return companyHolders(world, companyId).length;
}

/** 生产率的只读引用，避免某些 UI 需要额外 import 时重复实现。 */
export function companyProductivity(company: Company): number {
  return PRODUCTIVITY[company.recipeOutput] ?? 0;
}
