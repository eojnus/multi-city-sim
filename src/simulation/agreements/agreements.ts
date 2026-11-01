import type {
  AgreementItem,
  AgreementParticipant,
  City,
  Company,
  LogEntry,
  TradeAgreement,
  TradeFlow,
  WorldState,
} from '../contracts/types';
import type { DemoConfig } from '../../data/config';
import { RECIPES } from '../../data/demo-data';
import { GOOD_IDS } from '../companies/company';
import { offeredStock } from '../markets/markets';
import { clamp, round2 } from '../core/math';
import { corridorKey, recordIntercitySale } from '../transport/network';

/**
 * 政府牵头的跨城多企业贸易协议（演示实现）。
 *
 * 规则声明：政府牵头协议、自动撮合、自动接受/拒绝条件、每月执行节奏
 * 全部是【暂定演示方案】，最终规则待用户决定。
 *
 * 每家企业独立决定是否参加，资金、库存与履约义务互不连带；
 * 任一环节失败都不会留下部分扣款或部分货物转移。
 */

export interface AgreementResult {
  ok: boolean;
  error?: string;
  agreement?: TradeAgreement;
}

/** 单个协议最多包含的买卖条目数，避免协议过大（暂定）。 */
const MAX_ITEMS_PER_AGREEMENT = 6;

/** 自动提议的最小间隔（月）。 */
const AUTO_PROPOSE_MIN_GAP_TICKS = 3;

/**
 * 读取世界的协议列表。
 * 兼容并行开发期间的旧初始化器：若字段缺失则视为空列表，不做写入。
 */
function agreementList(world: WorldState): TradeAgreement[] {
  return Array.isArray(world.agreements) ? world.agreements : [];
}

function findAgreement(world: WorldState, agreementId: string): TradeAgreement | undefined {
  return agreementList(world).find((agreement) => agreement.id === agreementId);
}

function companyById(world: WorldState, companyId: string): Company | undefined {
  return world.companies.find((company) => company.id === companyId);
}

function cityById(world: WorldState, cityId: string): City | undefined {
  return world.cities.find((city) => city.id === cityId);
}

/** 与 markets/intercity.ts 的 cityDistanceKm 相同的公式与标记；此处私有实现以避免循环依赖。 */
function cityDistanceKm(a: City, b: City): number {
  const dx = a.region.x - b.region.x;
  const dy = a.region.y - b.region.y;
  return Math.sqrt(dx * dx + dy * dy) * 0.35;
}

/** 复用 config.intercity 的演示运输加成：按距离线性增加并夹在区间内。 */
function transportMarkup(fromCity: City, toCity: City, config: DemoConfig): number {
  if (!config.intercity.enabled) return 0;
  const km = cityDistanceKm(fromCity, toCity);
  return clamp(
    km * config.intercity.transportMarkupPerKm,
    config.intercity.minMarkup,
    config.intercity.maxMarkup,
  );
}

/**
 * 【暂定】用 产能 × 利用率 近似月度生产目标（与 production.ts 的 productionTarget 等价）。
 * 这里重复计算而不是 import production.ts，避免 simulation/production 与本模块形成循环依赖。
 */
function productionTargetApprox(company: Company): number {
  return Math.max(0, round2(company.capacity * company.utilization));
}

function nextAgreementId(world: WorldState): string {
  const list = agreementList(world);
  let sequence = list.length + 1;
  let id = `agreement-${sequence}`;
  while (list.some((agreement) => agreement.id === id)) {
    sequence += 1;
    id = `agreement-${sequence}`;
  }
  return id;
}

function participantCityId(agreement: TradeAgreement, companyId: string): string | undefined {
  return agreement.participants.find((participant) => participant.companyId === companyId)?.cityId;
}

function isAccepted(agreement: TradeAgreement, companyId: string): boolean {
  const participant = agreement.participants.find((entry) => entry.companyId === companyId);
  return participant?.decision === 'accepted';
}

function itemInvolves(item: AgreementItem, companyId: string): boolean {
  return item.buyerCompanyId === companyId || item.sellerCompanyId === companyId;
}

function itemIsOpen(item: AgreementItem): boolean {
  return item.status === 'pending' || item.status === 'active';
}

/**
 * 【暂定】把某参与方的决定同步到条目上：
 * 拒绝 → 其全部条目 declined；重新接受 → 尚未履约的 declined 条目回到 pending。
 */
function applyParticipantDecisionToItems(
  agreement: TradeAgreement,
  companyId: string,
  accept: boolean,
): void {
  for (const item of agreement.items) {
    if (!itemInvolves(item, companyId)) continue;
    if (!accept) {
      item.status = 'declined';
      item.lastNote = '参与方拒绝参加，条目不再执行（暂定演示规则）。';
      continue;
    }
    if (item.status === 'declined') {
      item.status = 'pending';
      item.lastNote = '等待其他参与方决定（暂定演示规则）。';
    }
  }
}

/**
 * 【暂定】所有参与方都表态后确定协议状态：
 * 仍有买卖双方都接受的条目 → active；否则 cancelled。
 */
function finalizeAgreementStatus(agreement: TradeAgreement): void {
  if (agreement.status !== 'proposed') return;
  if (agreement.participants.some((participant) => participant.decision === 'pending')) return;

  const viableItems = agreement.items.filter(
    (item) =>
      itemIsOpen(item) &&
      isAccepted(agreement, item.buyerCompanyId) &&
      isAccepted(agreement, item.sellerCompanyId),
  );

  if (viableItems.length > 0) {
    for (const item of viableItems) {
      item.status = 'active';
      item.lastNote = '协议生效，等待按月履约（暂定演示规则）。';
    }
    agreement.status = 'active';
    agreement.note = '所有参与方已决定，协议生效（暂定演示规则）。';
    return;
  }

  agreement.status = 'cancelled';
  agreement.note = '没有买卖双方都接受的条目，协议取消（暂定演示规则）。';
}

/**
 * 【暂定】自动决定规则：
 * - 卖方：单价 ≥ 卖方城市市价 × sellerMinPriceFactor；
 * - 买方：单价 ≤ 买方城市市价 × buyerMaxPriceFactor，且现金 ≥ 一个月对应采购额。
 * 任一硬性条件不满足即拒绝，拒绝不产生资金或库存变化。
 */
function evaluateAutoDecision(
  world: WorldState,
  agreement: TradeAgreement,
  participant: AgreementParticipant,
  config: DemoConfig,
): { accept: boolean; note: string } {
  const company = companyById(world, participant.companyId);
  if (!company) return { accept: false, note: '拒绝：企业不存在（暂定演示规则）。' };

  const city = cityById(world, participant.cityId);
  const cityName = city?.name ?? '本市';
  const liveItems = agreement.items.filter(
    (item) => itemInvolves(item, company.id) && item.status !== 'declined',
  );
  if (liveItems.length === 0) {
    return { accept: false, note: '拒绝：没有可执行条目（暂定演示规则）。' };
  }

  let monthlyPurchaseValue = 0;
  for (const item of liveItems) {
    const cityPrice = city?.market[item.good]?.price ?? 0;
    if (item.sellerCompanyId === company.id) {
      if (item.unitPrice + 1e-9 < cityPrice * config.agreements.sellerMinPriceFactor) {
        return {
          accept: false,
          note: `拒绝：单价 ${item.unitPrice} 低于${cityName}市价可接受下限（暂定演示规则）。`,
        };
      }
    }
    if (item.buyerCompanyId === company.id) {
      if (item.unitPrice - 1e-9 > cityPrice * config.agreements.buyerMaxPriceFactor) {
        return {
          accept: false,
          note: `拒绝：单价 ${item.unitPrice} 高于${cityName}市价可接受上限（暂定演示规则）。`,
        };
      }
      monthlyPurchaseValue += item.qtyPerMonth * item.unitPrice;
    }
  }

  monthlyPurchaseValue = round2(monthlyPurchaseValue);
  if (monthlyPurchaseValue > 0 && company.cash + 1e-6 < monthlyPurchaseValue) {
    return {
      accept: false,
      note: `拒绝：现金 ${round2(company.cash)} 不足以支付一个月采购额 ${monthlyPurchaseValue}（暂定演示规则）。`,
    };
  }

  return { accept: true, note: '接受：价格在可接受区间，资金充足（暂定演示规则）。' };
}

interface ParticipantRoleFlags {
  buyer: boolean;
  seller: boolean;
}

/**
 * 政府牵头提议一份跨城贸易协议。
 *
 * 【暂定演示规则】发起城市的企业为买方，伙伴城市的企业为卖方：
 * 遍历伙伴城市企业的可售库存，在发起城市寻找把它作为生产投入的买方企业。
 * 需求量 = 月度生产目标 × 配方用量 − 现有库存；数量同时受卖方库存份额与买方资金限制。
 * 价格 = 买方城市市价 × (1 + 运输加成)。任何企业都仍可选择拒绝参加。
 *
 * 若找不到任何买卖配对，返回错误且不修改世界。
 */
export function proposeAgreement(
  world: WorldState,
  sponsorCityId: string,
  partnerCityId: string,
  config: DemoConfig,
  tick: number,
  createdBy: 'government' | 'demo',
): AgreementResult {
  const sponsor = cityById(world, sponsorCityId);
  const partner = cityById(world, partnerCityId);
  if (!sponsor || !partner) return { ok: false, error: '发起城市或伙伴城市不存在' };
  if (sponsor.id === partner.id) return { ok: false, error: '协议双方必须是不同城市' };

  const agreementId = nextAgreementId(world);
  const markup = transportMarkup(sponsor, partner, config);

  const items: AgreementItem[] = [];
  // 同一买方已承诺的月度采购金额 / 同一卖方同一商品已承诺的月度数量，避免重复占用。
  const committedCash = new Map<string, number>();
  const committedStock = new Map<string, number>();

  const sellers = world.companies
    .filter((company) => company.cityId === partner.id)
    .sort((a, b) => a.id.localeCompare(b.id));
  const buyers = world.companies
    .filter((company) => company.cityId === sponsor.id)
    .sort((a, b) => a.id.localeCompare(b.id));

  outer: for (const seller of sellers) {
    for (const goodId of GOOD_IDS) {
      if (items.length >= MAX_ITEMS_PER_AGREEMENT) break outer;

      const offered = offeredStock(seller, goodId);
      if (offered <= 0) continue;

      const marketPrice = sponsor.market[goodId]?.price ?? 0;
      if (marketPrice <= 0) continue;

      const unitPrice = Math.max(0.01, round2(marketPrice * (1 + markup)));
      const sellerCap = offered * config.agreements.maxSellerShare;
      const stockKey = `${seller.id}:${goodId}`;

      for (const buyer of buyers) {
        if (items.length >= MAX_ITEMS_PER_AGREEMENT) break outer;

        const recipe = RECIPES[buyer.recipeOutput];
        const input = recipe?.inputs.find((entry) => entry.good === goodId);
        if (!input) continue;

        const target = productionTargetApprox(buyer);
        const need = Math.max(0, target * input.qty - (buyer.inventory[goodId] ?? 0));
        if (need < config.agreements.minQuantity) continue;

        const stockLeft = sellerCap - (committedStock.get(stockKey) ?? 0);
        if (stockLeft < config.agreements.minQuantity) break;

        const cashLeft = Math.max(0, buyer.cash - (committedCash.get(buyer.id) ?? 0));
        const affordableQty = cashLeft / unitPrice;
        // 向下取整到整单位；低于最小数量则跳过，避免碎片协议。
        const qty = Math.floor(Math.min(need, stockLeft, affordableQty));
        if (qty < config.agreements.minQuantity) continue;

        const item: AgreementItem = {
          id: `${agreementId}-item-${items.length + 1}`,
          good: goodId,
          buyerCompanyId: buyer.id,
          sellerCompanyId: seller.id,
          qtyPerMonth: qty,
          unitPrice,
          months: config.agreements.months,
          deliveredQty: 0,
          paidValue: 0,
          monthsExecuted: 0,
          status: 'pending',
          lastNote: '等待参与方决定（暂定演示规则）。',
        };
        items.push(item);
        committedCash.set(
          buyer.id,
          round2((committedCash.get(buyer.id) ?? 0) + qty * unitPrice),
        );
        committedStock.set(stockKey, round2((committedStock.get(stockKey) ?? 0) + qty));
      }
    }
  }

  if (items.length === 0) return { ok: false, error: '没有可协商的买卖配对' };

  const roleFlags = new Map<string, ParticipantRoleFlags>();
  const addRole = (companyId: string, side: 'buyer' | 'seller'): void => {
    const entry = roleFlags.get(companyId) ?? { buyer: false, seller: false };
    if (side === 'buyer') entry.buyer = true;
    else entry.seller = true;
    roleFlags.set(companyId, entry);
  };
  for (const item of items) {
    addRole(item.buyerCompanyId, 'buyer');
    addRole(item.sellerCompanyId, 'seller');
  }

  // 参与者去重并按公司 id 排序，保证存档与界面顺序确定。
  const participantIds = [...roleFlags.keys()].sort((a, b) => a.localeCompare(b));
  const participants: AgreementParticipant[] = participantIds.map((companyId) => {
    const company = companyById(world, companyId);
    const flags = roleFlags.get(companyId) ?? { buyer: false, seller: false };
    // 【暂定】既买又卖的企业记为 buyer，并在 note 中说明。
    const side: 'buyer' | 'seller' = flags.buyer ? 'buyer' : 'seller';
    const note =
      flags.buyer && flags.seller
        ? '该企业同时买入与卖出，暂按买方记录（暂定演示规则）。'
        : '参与方，等待决定（暂定演示规则）。';
    return {
      companyId,
      cityId: company?.cityId ?? (flags.buyer ? sponsor.id : partner.id),
      side,
      decision: 'pending',
      decidedTick: null,
      note,
    };
  });

  const agreement: TradeAgreement = {
    id: agreementId,
    title: `${sponsor.name}—${partner.name} 跨城贸易协议`,
    sponsorCityId: sponsor.id,
    partnerCityId: partner.id,
    createdTick: tick,
    createdBy,
    status: 'proposed',
    participants,
    items,
    note: '政府牵头协议与接受/拒绝规则均为暂定演示方案，最终规则待用户决定。每家企业可独立拒绝。',
  };

  // 只有确认存在条目后才写入世界，失败路径不留下任何变化。
  if (!Array.isArray(world.agreements)) world.agreements = [];
  world.agreements.push(agreement);
  return { ok: true, agreement };
}

/**
 * 公开命令：让某参与企业接受或拒绝协议。
 * 【暂定】仅在协议仍为 proposed 时允许改变决定（可翻转）；生效或结束后锁定。
 */
export function decideParticipant(
  world: WorldState,
  agreementId: string,
  companyId: string,
  accept: boolean,
  tick: number,
  config: DemoConfig,
  log: LogEntry[] = [],
): AgreementResult {
  const agreement = findAgreement(world, agreementId);
  if (!agreement) return { ok: false, error: '协议不存在' };

  const participant = agreement.participants.find((entry) => entry.companyId === companyId);
  if (!participant) return { ok: false, error: '该企业不是协议参与方' };

  if (agreement.status === 'completed' || agreement.status === 'cancelled') {
    return { ok: false, error: '协议已结束，不能再改变决定' };
  }
  if (agreement.status === 'active') {
    return { ok: false, error: '协议已生效，不能再改变决定' };
  }

  participant.decision = accept ? 'accepted' : 'declined';
  participant.decidedTick = tick;
  participant.note = accept
    ? '接受：由参与方确认（暂定演示规则）。'
    : '拒绝参加：不承担任何义务（暂定演示规则）。';
  applyParticipantDecisionToItems(agreement, companyId, accept);
  finalizeAgreementStatus(agreement);

  const company = companyById(world, companyId);
  log.push({
    tick,
    kind: 'trade',
    message: `${company?.name ?? companyId} ${accept ? '接受' : '拒绝'}了协议「${agreement.title}」，当前状态 ${agreement.status}。`,
  });

  // config 预留给后续按配置校验决定（当前判断只用协议内价格与市价）。
  void config;
  return { ok: true, agreement };

}

/**
 * 【暂定演示】对协议内所有待决定参与方套用自动接受/拒绝规则。
 * 拒绝只改变参与方与条目状态，不产生资金或库存变化。
 */
export function applyAutoDecisions(
  world: WorldState,
  agreementId: string,
  config: DemoConfig,
  tick: number,
  log: LogEntry[] = [],
): void {
  const agreement = findAgreement(world, agreementId);
  if (!agreement || agreement.status !== 'proposed') return;

  for (const participant of agreement.participants) {
    if (participant.decision !== 'pending') continue;
    const decision = evaluateAutoDecision(world, agreement, participant, config);
    participant.decision = decision.accept ? 'accepted' : 'declined';
    participant.decidedTick = tick;
    participant.note = decision.note;
    applyParticipantDecisionToItems(agreement, participant.companyId, decision.accept);

    const company = companyById(world, participant.companyId);
    log.push({
      tick,
      kind: 'trade',
      message: `协议「${agreement.title}」：${company?.name ?? participant.companyId} ${decision.accept ? '接受' : '拒绝'}参加。${decision.note}`,
    });
  }

  finalizeAgreementStatus(agreement);
  log.push({
    tick,
    kind: 'trade',
    message: `协议「${agreement.title}」自动决策完成，当前状态 ${agreement.status}（暂定演示规则）。`,
  });
}

/**
 * 执行所有 active 协议的月度条目。
 *
 * 每个条目依次验证：卖方存在且库存足够、买方存在且现金足够。
 * 全部通过才一次性提交货物与资金；任一失败则该条目 failed 且不做任何变化。
 * 用局部 Set 以 item.id + tick 去重，保证同一次结算中每条最多执行一次。
 */
export function executeAgreements(
  world: WorldState,
  config: DemoConfig,
  tick: number,
  log: LogEntry[],
): TradeFlow[] {
  const flows: TradeFlow[] = [];
  const executedThisCall = new Set<string>();

  const activeAgreements = agreementList(world)
    .filter((agreement) => agreement.status === 'active')
    .sort((a, b) => a.createdTick - b.createdTick || a.id.localeCompare(b.id));

  for (const agreement of activeAgreements) {
    for (const item of agreement.items) {
      if (!itemIsOpen(item)) continue;
      if (item.monthsExecuted >= item.months) {
        item.status = 'fulfilled';
        item.lastNote = '履约月份已满（暂定演示规则）。';
        continue;
      }

      const dedupeKey = `${item.id}@${tick}`;
      if (executedThisCall.has(dedupeKey)) continue;
      executedThisCall.add(dedupeKey);

      const seller = companyById(world, item.sellerCompanyId);
      const buyer = companyById(world, item.buyerCompanyId);
      if (!seller) {
        item.status = 'failed';
        item.lastNote = '卖方企业不存在，条目失败（暂定演示规则）。';
        continue;
      }
      if (!buyer) {
        item.status = 'failed';
        item.lastNote = '买方企业不存在，条目失败（暂定演示规则）。';
        continue;
      }
      if (!isAccepted(agreement, seller.id) || !isAccepted(agreement, buyer.id)) {
        item.status = 'failed';
        item.lastNote = '参与方未接受，条目失败（暂定演示规则）。';
        continue;
      }

      const qty = round2(item.qtyPerMonth);
      const value = round2(qty * item.unitPrice);
      if (qty <= 0 || value <= 0) {
        item.status = 'failed';
        item.lastNote = '数量或金额无效，条目失败（暂定演示规则）。';
        continue;
      }

      const stock = seller.inventory[item.good] ?? 0;
      if (stock + 1e-6 < qty) {
        item.status = 'failed';
        item.lastNote = `库存不足：需要 ${qty}，现有 ${round2(stock)}（暂定演示规则）。`;
        log.push({
          tick,
          kind: 'warning',
          message: `协议「${agreement.title}」${seller.name} 库存不足，${item.good} 条目失败；未发生任何资金或货物转移。`,
        });
        continue;
      }
      if (buyer.cash + 1e-6 < value) {
        item.status = 'failed';
        item.lastNote = `资金不足：需要 ${value}，现金 ${round2(buyer.cash)}（暂定演示规则）。`;
        log.push({
          tick,
          kind: 'warning',
          message: `协议「${agreement.title}」${buyer.name} 资金不足，${item.good} 条目失败；未发生任何资金或货物转移。`,
        });
        continue;
      }

      // ---- 原子提交：以下变化要么全部发生，要么不发生 ----
      const fromCityId =
        participantCityId(agreement, seller.id) ?? seller.cityId;
      const toCityId = participantCityId(agreement, buyer.id) ?? buyer.cityId;

      seller.inventory[item.good] = round2(stock - qty);
      if (seller.inventory[item.good] < 0 && seller.inventory[item.good] > -1e-6) {
        seller.inventory[item.good] = 0;
      }
      buyer.inventory[item.good] = round2((buyer.inventory[item.good] ?? 0) + qty);
      buyer.cash = round2(buyer.cash - value);
      // 卖方所得在期末按运输容量统一结算（容量不足时少获得该笔收益）。
      recordIntercitySale(world, {
        tick,
        path: 'agreement',
        fromCityId,
        toCityId,
        corridorKey: corridorKey(fromCityId, toCityId),
        sellerCompanyId: seller.id,
        buyerCompanyId: buyer.id,
        good: item.good,
        qty,
        grossValue: value,
      });

      buyer.lastMonth.inputCost = round2(buyer.lastMonth.inputCost + value);

      item.deliveredQty = round2(item.deliveredQty + qty);
      item.paidValue = round2(item.paidValue + value);
      item.monthsExecuted += 1;
      if (item.monthsExecuted >= item.months) {
        item.status = 'fulfilled';
        item.lastNote = '全部月份履约完成（暂定演示规则）。';
      } else {
        item.status = 'active';
        item.lastNote = `第 ${item.monthsExecuted}/${item.months} 月履约完成（暂定演示规则）。`;
      }

      const flow: TradeFlow = {
        routeId: `agreement:${agreement.id}`,
        tick,
        fromCityId,
        toCityId,
        fromCompanyId: seller.id,
        toCompanyId: buyer.id,
        good: item.good,
        qty,
        unitPrice: item.unitPrice,
        value,
        path: 'agreement',
      };
      flows.push(flow);

      log.push({
        tick,
        kind: 'trade',
        message: `协议「${agreement.title}」履约：${seller.name} → ${buyer.name}，${item.good} ${qty} 单位，价值 ${value}。`,
      });
    }

    const stillOpen = agreement.items.some((item) => itemIsOpen(item));
    if (!stillOpen) {
      agreement.status = 'completed';
      const hasFailed = agreement.items.some((item) => item.status === 'failed');
      const hasDeclined = agreement.items.some((item) => item.status === 'declined');
      if (hasFailed) {
        agreement.note = '协议结束：部分履约失败（暂定演示规则）。';
      } else if (hasDeclined) {
        agreement.note = '协议结束：部分条目因参与方拒绝而未执行（暂定演示规则）。';
      } else {
        agreement.note = '协议全部履约完成（暂定演示规则）。';
      }
    }
  }

  // config 保留在签名中供后续阶段使用（当前执行数量与价格已写入条目）。
  void config;
  return flows;
}

/**
 * 取消协议（政府/界面命令）。
 * 【暂定】proposed 或 active 可取消；未完成条目置 failed，无任何资金变化。
 */
export function cancelAgreement(
  world: WorldState,
  agreementId: string,
  tick: number,
  reason: string,
): AgreementResult {
  const agreement = findAgreement(world, agreementId);
  if (!agreement) return { ok: false, error: '协议不存在' };
  if (agreement.status !== 'proposed' && agreement.status !== 'active') {
    return { ok: false, error: '协议已结束，无法取消' };
  }

  agreement.status = 'cancelled';
  for (const item of agreement.items) {
    if (!itemIsOpen(item)) continue;
    item.status = 'failed';
    item.lastNote = `协议取消：${reason}（暂定演示规则）。`;
  }
  agreement.note = `协议已取消：${reason}（暂定演示规则）。取消不产生资金或库存变化。`;
  void tick;
  return { ok: true, agreement };
}

/**
 * 【暂定演示】按配置自动发起并自动决策协议。
 * 条件：autoPropose 启用、活跃协议数 < maxActive、距上一条协议创建 ≥ 3 个月。
 * 城市对按城市 id 排序后两两组合并轮转选择；不使用 Math.random，
 * 若调用方提供 rngNext 则仅用于起点平局选择。
 */
export function maybeAutoPropose(
  world: WorldState,
  config: DemoConfig,
  tick: number,
  log: LogEntry[],
  rngNext?: () => number,
): void {
  if (!config.agreements.autoPropose) return;

  const list = agreementList(world);
  const openCount = list.filter(
    (agreement) => agreement.status === 'proposed' || agreement.status === 'active',
  ).length;
  if (openCount >= config.agreements.maxActive) return;

  if (list.length > 0) {
    const lastCreated = Math.max(...list.map((agreement) => agreement.createdTick));
    if (tick - lastCreated < AUTO_PROPOSE_MIN_GAP_TICKS) return;
  }

  const cityIds = world.cities.map((city) => city.id).sort((a, b) => a.localeCompare(b));
  const pairs: { sponsor: string; partner: string }[] = [];
  for (let i = 0; i < cityIds.length; i++) {
    const sponsor = cityIds[i];
    if (!sponsor) continue;
    for (let j = i + 1; j < cityIds.length; j++) {
      const partner = cityIds[j];
      if (!partner) continue;
      pairs.push({ sponsor, partner });
    }
  }
  if (pairs.length === 0) return;

  const start = rngNext ? Math.floor(rngNext() * pairs.length) % pairs.length : list.length % pairs.length;

  // 轮转尝试，直到某一对城市成功产出条目；失败的尝试不修改世界。
  for (let offset = 0; offset < pairs.length; offset++) {
    const pair = pairs[(start + offset) % pairs.length];
    if (!pair) continue;
    const result = proposeAgreement(world, pair.sponsor, pair.partner, config, tick, 'government');
    if (!result.ok || !result.agreement) continue;

    const agreement = result.agreement;
    applyAutoDecisions(world, agreement.id, config, tick, log);
    log.push({
      tick,
      kind: 'trade',
      message: `市政府牵头「${agreement.title}」，共 ${agreement.items.length} 项商品；状态 ${agreement.status}。政府牵头与自动接受/拒绝均为暂定演示方案，最终规则待用户决定。`,
    });
    return;
  }
}

/** 查询某企业参与的协议，按创建时间与 id 排序。 */
export function agreementsForCompany(world: WorldState, companyId: string): TradeAgreement[] {
  return agreementList(world)
    .filter((agreement) =>
      agreement.participants.some((participant) => participant.companyId === companyId),
    )
    .sort((a, b) => a.createdTick - b.createdTick || a.id.localeCompare(b.id));
}
