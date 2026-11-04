import type {
  CityTaxMonth,
  Company,
  CompanyProductionPlan,
  EquipmentKind,
  GoodId,
  HolderRef,
  InvestmentResult,
  MayorFiscalView,
  OwnBondHoldingView,
  PlayerNotification,
  PublicBondOfferView,
  SectorId,
  ShareKind,
  StockClassHistory,
  TradeActionResult,
  TradeFlow,
  ViewerIdentity,
  WorldState,
} from '../simulation/contracts/types';
import { Simulation } from '../simulation/core/simulation';
import { parseSave, serializeSave } from '../simulation/core/save';
import { createCityLayout } from '../data/city-layout';
import type { BuildingDefinition, CityLayout, DistrictDefinition } from '../data/city-layout';
import type { SaveBridge } from '../platform/saveBridge';
import type { SaveSlotInfo } from '../platform/desktop';
import { companySharePrice, monthlyWageBill } from '../simulation/companies/company';
import {
  buyNewEquipment,
  buyUsedEquipment,
  cancelUsedEquipmentOffer,
  companyEquipmentKind,
  equipmentCatalog,
  equipmentUnitPrice,
  listUsedEquipment,
  localNewEquipmentSupply,
  recomputeCompanyCapacity,
} from '../simulation/equipment/equipment';
import { laborCapacity } from '../simulation/production/production';
import { cityMarketPrices } from '../simulation/markets/markets';
import { playerNetWorth, holdingStake } from '../simulation/economy/gdp';
import {
  acceptFinancingOffer,
  bookPrice,
  classOf,
  companyHolders,
  declineFinancingOffer,
  openOffersFor,
  openOrdersFor,
  playerStakeOf,
  playerTotalShares,
  playerVotingShares,
  shareClassId,
  tradeImmediately,
} from '../simulation/securities/securities';
import {
  castVote,
  governanceFor,
  playerEligibleShares,
  proposeOperatorMotion,
} from '../simulation/corporate-governance/governance';
import {
  markAllNotificationsRead,
  markNotificationRead,
  unreadNotificationCount,
  // 旧函数只负责“新在前”的展示顺序；权限过滤走 v0.7 的 fiscal-view（渲染期按当前身份重算）。
  visibleNotifications as orderNotifications,
} from '../simulation/notifications/notifications';
import {
  buildMayorFiscalView,
  buildOwnBondHoldingViews,
  buildPublicBondOffer,
  viewerIdentity,
  visibleLogEntries,
  visibleNotifications as filterVisibleNotifications,
} from '../simulation/government/fiscal-view';
import { latestTaxMonth } from '../simulation/government/taxes';
import {
  bondSubscriptionCloseTick,
  issueGovernmentBond,
  subscribeGovernmentBond,
} from '../simulation/government/bonds';
import {
  cancelAgreement,
  applyAutoDecisions,
  decideParticipant,
  proposeAgreement,
} from '../simulation/agreements/agreements';
import { DEMO_CONFIG } from '../data/config';
import { SAVE_FORMAT_VERSION } from '../simulation/contracts/types';
import { POLICY_DEFINITIONS } from '../simulation/policies/definitions';
import {
  cancelPolicy,
  canStartPolicy,
  policySummary,
  startPolicy,
} from '../simulation/policies/policies';
import {
  appointPlayerMayor,
  playerIsMayor,
  runForMayor,
  stepDownPlayerMayor,
} from '../simulation/politics/politics';
import {
  cityCorridorSummary,
  corridorCapacity,
  estimateCorridorUpgrade,
  estimateIntracityUpgrade,
  intracityCapacity,
} from '../simulation/transport/network';
import {
  companyStyleDescription,
  companyStyleLabel,
  decisionSummary,
} from '../simulation/companies/ai/strategy';
import {
  expandCompanyCapacity,
  foundCompany,
  lifecycleLimits,
} from '../simulation/companies/lifecycle/lifecycle';
import {
  cityHouseholdDeposits,
  cityInvestorEquity,
  householdGroupsOfCity,
} from '../simulation/population/household-groups';
import {
  deposit,
  depositAccountFor,
  loanLabel,
  withdraw,
} from '../simulation/banking/banking';
import { bankLoansOf, creditEvaluation, sameOwner } from '../simulation/banking/credit';
import {
  availableOperators,
  currentOperator,
  operatorNameFor,
  operatorStyleDescription,
  operatorStyleLabel,
  termMonthsLeft,
} from '../simulation/management/manager-pool';
import {
  playerOpenLoan,
  playerRepayBankLoan,
} from '../simulation/management/financing';
import {
  canOperate,
  decideProposal,
  playerOperationFor,
  proposalView,
  setAuthorization,
  setOperationMode,
  setStandingPlan,
} from '../simulation/management/operations';
import { OPERATION_MODE_LABELS } from '../simulation/management/types';
import {
  castElectionVote,
  playerHoldsVotingShares,
  registerPlayerCandidate,
} from '../simulation/management/elections';

export type ViewMode = 'region' | 'city';
export type LayerMode = 'population' | 'economy' | 'industry';
export type ToastKind = 'info' | 'success' | 'warning' | 'error';

export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

export interface SaveSlotView extends SaveSlotInfo {
  label: string;
}

// ---------------------------------------------------------------- v0.8 股票市场视图

/** 股票列表中的一行（每家企业一行；价格按当前选中股份类别展示）。 */
export interface StockListRow {
  companyId: string;
  companyName: string;
  cityId: string;
  cityName: string;
  industry: string;
  kind: ShareKind;
  classId: string;
  issuedShares: number;
  /** 当前类别最近一笔真实成交价；没有成交时为 null（不伪造）。 */
  lastPrice: number | null;
  lastTradeTick: number | null;
  bookPrice: number;
  /** 相对上一根月 K 线收盘价的涨跌幅（百分比）；没有可靠比较基准时为 null。 */
  changePct: number | null;
  playerShares: number;
  playerStake: number;
  playerOpenOrders: number;
  tradable: boolean;
  /** 企业已退出/倒闭：只保留真实历史行情，不可再交易（v0.8 复验）。 */
  exited: boolean;
}

export interface StockCandleView {
  tick: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  trades: number;
}

export interface StockOrderView {
  id: string;
  side: 'buy' | 'sell';
  shares: number;
  limitPrice: number;
  createdTick: number;
}

export interface StockDetailView {
  company: {
    id: string;
    name: string;
    cityId: string;
    cityName: string;
    industry: string;
    note: string;
    employees: number;
    capacity: number;
    utilization: number;
  };
  kind: ShareKind;
  classId: string;
  issuedShares: number;
  lastPrice: number | null;
  lastTradeTick: number | null;
  bookPrice: number;
  changePct: number | null;
  candles: StockCandleView[];
  bestBid: number | null;
  bestAsk: number | null;
  playerShares: number;
  playerStake: number;
  playerCash: number;
  playerOrders: StockOrderView[];
  tradable: boolean;
  exited: boolean;
  /** 已退出企业仍可查到的最后交易月份（无成交时 null）。 */
  exitedTick: number | null;
  note: string;
}

export interface StockMarketView {
  open: boolean;
  view: 'all' | 'holdings';
  search: string;
  cityFilter: string | null;
  industryFilter: string | null;
  cities: { id: string; name: string }[];
  industries: string[];
  rows: StockListRow[];
  selected: StockDetailView | null;
  kind: ShareKind;
  note: string;
}

export interface CityTaxPanelView {
  cityId: string;
  cityName: string;
  latest: CityTaxMonth | null;
  history: CityTaxMonth[];
  note: string;
}

const SAVE_SLOTS: { slot: string; label: string }[] = [
  { slot: 'autosave', label: '自动存档' },
  { slot: 'manual-1', label: '手动存档 1' },
  { slot: 'manual-2', label: '手动存档 2' },
  { slot: 'manual-3', label: '手动存档 3' },
];

/**
 * 公开破产事件摘要（渲染用）。
 *
 * 权限口径（v0.7 验收问题 5）：破产事实、处置流程、重选结果与股份托管对所有人公开；
 * 但政府具体兑付/垫付/勾销金额、未清偿利息与债务率仅该城市**现任市长**可见。
 * 非市长渲染时金额为 null、note 不含财政数字，个人持债兑付记录请看 ownBondHoldings。
 */
export interface PublicBankruptcyNotice {
  cityId: string;
  status: 'solvent' | 'bankrupt';
  tick: number | null;
  caretakerUntilElection: boolean;
  electionTriggeredTick: number | null;
  /** 当前查看者是否为该城市现任市长（决定金额明细是否可见）。 */
  detailsVisible: boolean;
  bondsRedeemedPrincipal: number | null;
  bondsRedeemedInterest: number | null;
  bondRedemptionCount: number | null;
  bankAdvanceCreated: number | null;
  bankLoansWrittenOff: number | null;
  advancesWrittenOff: number | null;
  interestWrittenOff: number | null;
  note: string;
  trustHoldings: { companyId: string; companyName: string; shares: number }[];
}

// ---------------------------------------------------------------- v0.9 设备与生产视图

/** 设备类别（农业/工业/能源）；顺序固定，供 UI 与市场表格使用。 */
export const EQUIPMENT_KINDS: readonly EquipmentKind[] = ['farm', 'industry', 'energy'];

export interface CompanyEquipmentRowView {
  kind: EquipmentKind;
  name: string;
  units: number;
  unitCapacity: number;
  capacity: number;
  catalogPrice: number;
  marketPrice: number;
  /** 同城设备企业可立即交付的新机库存。 */
  supply: number;
  /** 政府开局设备储备（按目录价付款，进入本城财政）。 */
  governmentStock: number;
}

export interface CompanyLastMonthView {
  produced: number;
  sold: number;
  exported: number;
  revenue: number;
  wagesPaid: number;
  wageArrears: number;
  bonusPaid: number;
  equipmentPurchased: number;
  equipmentSold: number;
  emergencyLayoffs: number;
  profit: number;
}

export interface CompanyOperatingView {
  companyId: string;
  companyName: string;
  cityId: string;
  cityName: string;
  sector: SectorId;
  outputGood: GoodId;
  isPlayerOperator: boolean;
  cash: number;
  debt: number;
  equipment: Record<EquipmentKind, number>;
  equipmentRows: CompanyEquipmentRowView[];
  equipmentCapacity: number;
  capacity: number;
  laborCapacity: number;
  utilization: number;
  employees: number;
  jobDemand: number;
  wageRate: number;
  monthlyWageBill: number;
  plan: CompanyProductionPlan | null;
  salesHistory: number[];
  recentProfits: number[];
  finishedStock: number;
  /** 现有成品库存可支撑的销售月数；没有销售参考时为 null。 */
  sellableMonths: number | null;
  salesReference: number;
  lastMonth: CompanyLastMonthView;
  techMultiplier: number;
  note: string;
}

export interface EquipmentKindMarketView {
  kind: EquipmentKind;
  name: string;
  goodId: string;
  catalogPrice: number;
  marketPrice: number;
  capacityPerUnit: number;
  unitCapacity: number;
  techMultiplier: number;
  sectors: string[];
  supply: number;
  governmentStock: number;
  lastMonthSold: number;
}

export interface UsedEquipmentOfferView {
  id: string;
  companyId: string;
  companyName: string;
  cityId: string;
  kind: EquipmentKind;
  kindName: string;
  units: number;
  askPrice: number;
  listedTick: number;
  note: string;
}

export interface EquipmentMarketView {
  cityId: string;
  cityName: string;
  kinds: EquipmentKindMarketView[];
  offers: UsedEquipmentOfferView[];
  usedPriceFactor: number;
  liquidationPriceFactor: number;
  maxBuyUnitsPerMonth: number;
  note: string;
}

export class GameStore {
  simulation: Simulation;
  bridge: SaveBridge;
  view: ViewMode = 'region';
  selectedCityId: string | null = 'lanport';
  selectedBuildingId: string | null = null;
  selectedCompanyId: string | null = null;
  selectedDistrictId: string | null = null;
  layer: LayerMode = 'population';
  autoRunning = false;
  toasts: Toast[] = [];
  lastSavedAt: string | null = null;
  lastError: string | null = null;
  lastAutoSaveError: string | null = null;
  /** 最近一次读取发生旧格式迁移时的来源版本；正常 v2 为 null。 */
  lastMigrationFrom: number | null = null;
  autosaveDisabled = false;
  autosaveDisabledReason: string | null = null;
  layouts: Record<string, CityLayout> = {};
  // v0.8 股票市场窗口状态（纯 UI 视图状态，不参与模拟）。
  stockMarketOpen = false;
  stockMarketKind: ShareKind = 'voting';
  stockMarketViewMode: 'all' | 'holdings' = 'all';
  stockMarketFocusCompanyId: string | null = null;
  stockMarketSearch = '';
  stockMarketCityFilter: string | null = null;
  stockMarketIndustryFilter: string | null = null;
  private listeners = new Set<() => void>();
  private toastId = 0;
  private menuCleanup: (() => void) | null = null;

  constructor(simulation: Simulation, bridge: SaveBridge) {
    this.simulation = simulation;
    this.bridge = bridge;
    this.rebuildLayouts();
  }

  get world(): WorldState {
    return this.simulation.state;
  }

  get selectedCity() {
    if (!this.selectedCityId) return null;
    return this.world.cities.find((city) => city.id === this.selectedCityId) ?? null;
  }

  get selectedLayout(): CityLayout | null {
    return this.selectedCityId ? this.layouts[this.selectedCityId] ?? null : null;
  }

  get selectedBuilding(): BuildingDefinition | null {
    if (!this.selectedBuildingId) return null;
    return this.selectedLayout?.buildings.find((building) => building.id === this.selectedBuildingId) ?? null;
  }

  get selectedDistrict(): DistrictDefinition | null {
    if (!this.selectedDistrictId) return null;
    return this.selectedLayout?.districts.find((district) => district.id === this.selectedDistrictId) ?? null;
  }

  get selectedCompany(): Company | null {
    if (!this.selectedCompanyId) return null;
    return this.world.companies.find((company) => company.id === this.selectedCompanyId) ?? null;
  }

  get playerNetWorth(): number {
    return playerNetWorth(this.world);
  }

  get dateLabel(): string {
    return `${this.world.time.year} 年 ${String(this.world.time.month).padStart(2, '0')} 月`;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(): void {
    for (const listener of this.listeners) listener();
  }

  bindMenu(): void {
    this.menuCleanup?.();
    this.menuCleanup = this.bridge.onMenuAction((action) => {
      switch (action) {
        case 'tick':
          this.tick();
          break;
        case 'toggle-pause':
          this.setAutoRunning(!this.autoRunning);
          break;
        case 'save':
          this.emit();
          window.dispatchEvent(new CustomEvent('lanwan:open-save'));
          break;
        case 'load':
          this.emit();
          window.dispatchEvent(new CustomEvent('lanwan:open-load'));
          break;
        case 'credits':
          window.dispatchEvent(new CustomEvent('lanwan:open-credits'));
          break;
        case 'assumptions':
          window.dispatchEvent(new CustomEvent('lanwan:open-assumptions'));
          break;
        default:
          break;
      }
    });
  }

  rebuildLayouts(): void {
    const layouts: Record<string, CityLayout> = {};
    for (const city of this.world.cities) {
      layouts[city.id] = createCityLayout(city.id, this.world.companies);
    }
    this.layouts = layouts;
    if (this.selectedBuildingId) {
      const stillExists = this.selectedLayout?.buildings.some(
        (building) => building.id === this.selectedBuildingId,
      );
      if (!stillExists) this.selectedBuildingId = null;
    }
  }

  selectCity(cityId: string): void {
    this.selectedCityId = cityId;
    this.selectedBuildingId = null;
    this.selectedDistrictId = null;
    this.selectedCompanyId = null;
    this.emit();
  }

  enterCity(cityId: string): void {
    this.selectedCityId = cityId;
    this.view = 'city';
    this.selectedBuildingId = null;
    this.selectedDistrictId = null;
    this.selectedCompanyId = null;
    this.autoRunning = false;
    this.emit();
  }

  backToRegion(): void {
    this.view = 'region';
    this.selectedBuildingId = null;
    this.selectedDistrictId = null;
    this.selectedCompanyId = null;
    this.emit();
  }

  selectBuilding(buildingId: string): void {
    const building = this.selectedLayout?.buildings.find((entry) => entry.id === buildingId);
    this.selectedBuildingId = buildingId;
    this.selectedDistrictId = building?.districtId ?? null;
    this.selectedCompanyId = building?.companyId ?? null;
    this.emit();
  }

  selectDistrict(districtId: string): void {
    this.selectedDistrictId = districtId;
    this.selectedBuildingId = null;
    this.selectedCompanyId = null;
    this.emit();
  }

  selectCompany(companyId: string | null): void {
    this.selectedCompanyId = companyId;
    this.emit();
  }

  clearSelection(): void {
    this.selectedBuildingId = null;
    this.selectedDistrictId = null;
    this.selectedCompanyId = null;
    this.emit();
  }

  setLayer(layer: LayerMode): void {
    this.layer = layer;
    this.emit();
  }

  setView(view: ViewMode): void {
    this.view = view;
    if (view === 'region') this.autoRunning = false;
    this.emit();
  }

  setAutoRunning(value: boolean): void {
    this.autoRunning = value;
    this.emit();
  }

  tick(): boolean {
    const result = this.simulation.tick();
    if (!result.ok) {
      this.lastError = result.error ?? '月度结算失败';
      this.toast(this.lastError, 'error');
      this.emit();
      return false;
    }
    this.lastError = null;
    void this.autosave();
    this.emit();
    return true;
  }

  invest(companyId: string, amount: number): InvestmentResult {
    const result = this.simulation.invest(companyId, amount);
    if (result.ok) {
      this.toast(
        `已向 ${result.companyName} 注资 ${amount.toLocaleString('zh-CN')}，获得 ${result.shares} 股（发行价 ${result.price?.toFixed(2)}）。`,
        'success',
      );
      this.emit();
    } else {
      this.toast(result.error ?? '注资失败', 'error');
      this.emit();
    }
    return result;
  }

  toast(message: string, kind: ToastKind = 'info'): void {
    const id = ++this.toastId;
    this.toasts.push({ id, kind, message });
    if (this.toasts.length > 4) this.toasts.shift();
    setTimeout(() => {
      this.toasts = this.toasts.filter((toast) => toast.id !== id);
      this.emit();
    }, kind === 'error' ? 6500 : 4200);
  }

  async autosave(): Promise<void> {
    // 损坏的自动存档会保留原文件，直到玩家显式载入有效存档或开始新世界。
    if (this.autosaveDisabled) return;
    const text = serializeSave(this.world);
    const result = await this.bridge.write('autosave', text);
    if (result.ok) {
      this.lastSavedAt = new Date().toISOString();
      this.lastAutoSaveError = null;
    } else {
      this.lastAutoSaveError = result.error ?? '自动存档失败';
    }
  }

  async saveSlot(slot: string): Promise<boolean> {
    const text = serializeSave(this.world);
    const result = await this.bridge.write(slot, text);
    if (result.ok) {
      this.lastSavedAt = new Date().toISOString();
      this.toast(`已保存到 ${slot}。`, 'success');
      this.emit();
      return true;
    }
    this.toast(`保存失败：${result.error ?? '未知错误'}`, 'error');
    this.emit();
    return false;
  }

  async loadSlot(slot: string): Promise<boolean> {
    try {
      const read = await this.bridge.read(slot);
      if (!read.ok || !read.text) {
        this.toast(`读取失败：${read.error ?? '存档不存在'}；当前进度未被覆盖。`, 'error');
        this.emit();
        return false;
      }
      return this.loadFromText(read.text, slot);
    } catch (error) {
      this.toast(`读取失败：${(error as Error).message}；当前进度未被覆盖。`, 'error');
      this.emit();
      return false;
    }
  }

  loadFromText(text: string, sourceLabel = '存档'): boolean {
    let parsed: ReturnType<typeof parseSave>;
    try {
      parsed = parseSave(text);
    } catch (error) {
      parsed = { ok: false, error: `存档校验异常：${(error as Error).message}` };
    }
    if (!parsed.ok || !parsed.world) {
      this.toast(`读取失败：${parsed.error ?? '未知错误'}；当前进度未被覆盖。`, 'error');
      this.emit();
      return false;
    }
    this.simulation = new Simulation(parsed.world);
    this.lastMigrationFrom = parsed.migratedFrom ?? null;
    this.view = 'region';
    this.selectedCityId = this.world.cities[0]?.id ?? null;
    this.selectedBuildingId = null;
    this.selectedDistrictId = null;
    this.selectedCompanyId = null;
    this.autoRunning = false;
    this.lastError = null;
    // 玩家显式读取了有效存档，允许自动存档恢复；损坏原文件在此之前一直保留。
    this.autosaveDisabled = false;
    this.autosaveDisabledReason = null;
    this.lastAutoSaveError = null;
    this.rebuildLayouts();
    const date = parsed.save?.savedAt ? new Date(parsed.save.savedAt).toLocaleString('zh-CN') : '未知时间';
    this.lastSavedAt = parsed.save?.savedAt ?? null;
    this.toast(
      parsed.migratedFrom
        ? `已从${sourceLabel}恢复（保存于 ${date}），旧格式 v${parsed.migratedFrom} 已迁移。`
        : `已从${sourceLabel}恢复（保存于 ${date}）。`,
      'success',
    );
    this.emit();
    return true;
  }

  async deleteSlot(slot: string): Promise<void> {
    const result = await this.bridge.remove(slot);
    if (result.ok) this.toast(`已删除存档 ${slot}。`, 'info');
    else this.toast(`删除失败：${result.error ?? '未知错误'}`, 'error');
    this.emit();
  }

  async listSlots(): Promise<SaveSlotView[]> {
    const existing = await this.bridge.list();
    const map = new Map(existing.map((entry) => [entry.slot, entry]));
    return SAVE_SLOTS.map((entry) => ({
      ...(map.get(entry.slot) ?? { slot: entry.slot, exists: false }),
      label: entry.label,
    }));
  }

  async tryRestoreAutosave(): Promise<boolean> {
    let read: Awaited<ReturnType<SaveBridge['read']>>;
    try {
      read = await this.bridge.read('autosave');
    } catch (error) {
      // 无法确认文件是否存在时，按“存在但读取失败”处理，避免下一次自动保存覆盖。
      this.disableAutosave(`读取自动存档失败：${(error as Error).message}`);
      return false;
    }
    if (!read.ok) {
      // 只有明确的“不存在”才是首次运行；其他错误说明文件可能存在但读不出来，必须保护。
      if (read.code === 'not-found' || (!read.code && read.error === '存档不存在')) {
        return false;
      }
      this.disableAutosave(
        `自动存档存在但无法读取：${read.error ?? '未知错误'}`,
      );
      return false;
    }
    if (!read.text) {
      this.disableAutosave('自动存档内容为空');
      return false;
    }
    let parsed: ReturnType<typeof parseSave>;
    try {
      parsed = parseSave(read.text);
    } catch (error) {
      parsed = { ok: false, error: `存档校验异常：${(error as Error).message}` };
    }
    if (!parsed.ok || !parsed.world) {
      this.disableAutosave(parsed.error ?? '自动存档损坏');
      return false;
    }
    this.simulation = new Simulation(parsed.world);
    this.lastMigrationFrom = parsed.migratedFrom ?? null;
    this.rebuildLayouts();
    this.selectedCityId = this.world.cities[0]?.id ?? null;
    this.view = 'region';
    this.lastSavedAt = parsed.save?.savedAt ?? null;
    this.autosaveDisabled = false;
    this.autosaveDisabledReason = null;
    this.lastAutoSaveError = null;
    if (this.lastMigrationFrom !== null) {
      this.toast(
        `自动存档来自旧版格式 ${this.lastMigrationFrom}，已迁移到 v2；原有资金、持股、企业、人口和随机状态保留。`,
        'info',
      );
    }
    this.emit();
    return true;
  }

  private disableAutosave(reason: string): void {
    // 不删除、不重命名、不覆盖损坏文件；给玩家保留用其他工具恢复的机会。
    this.autosaveDisabled = true;
    this.autosaveDisabledReason = reason;
    this.lastAutoSaveError = `自动存档已暂停：${reason}`;
    this.lastError = `自动存档损坏：${reason}`;
    this.toast(
      `自动存档损坏：${reason}；已暂停自动写入并保留原文件，当前为新世界。可读取其他存档或手动保存。`,
      'warning',
    );
    this.emit();
  }

  resetWorld(): void {
    this.simulation = Simulation.create();
    this.view = 'region';
    this.selectedCityId = this.world.cities[0]?.id ?? null;
    this.selectedBuildingId = null;
    this.selectedDistrictId = null;
    this.selectedCompanyId = null;
    this.autoRunning = false;
    this.lastError = null;
    this.autosaveDisabled = false;
    this.autosaveDisabledReason = null;
    this.lastAutoSaveError = null;
    this.rebuildLayouts();
    this.toast('已开始新的世界；旧的手动存档仍保留。', 'info');
    void this.autosave();
    this.emit();
  }

  // ---- 供 UI 读取的派生视图 ----
  citySharePrice(company: Company): number {
    const city = this.world.cities.find((candidate) => candidate.id === company.cityId);
    return city ? companySharePrice(company, cityMarketPrices(city)) : 0;
  }

  playerStake(companyId: string): number {
    return holdingStake(this.world, companyId);
  }

  /** 通知中心数据：已按玩家身份与持股权利筛选，不含模拟日志。 */
  get notifications(): PlayerNotification[] {
    // 补充指令 §7 / IMPLEMENTATION_v0.7 §8：权限只在渲染期按**当前** viewer 计算（不缓存）。
    // 旧存档里的城市通知在换任 / 离职 / 破产重选后仍留在通知列表，必须在这里重过滤；
    // fiscal-view 负责 visibility（public/mayor+cityId），audience=city 再按当前市长兜底。
    const viewer = this.viewer;
    const allowed = new Set(
      filterVisibleNotifications(this.world, viewer).map((notice) => notice.id),
    );
    return orderNotifications(this.world)
      .filter((notice) => allowed.has(notice.id))
      .filter(
        (notice) =>
          notice.audience !== 'city' || (notice.cityId ?? null) === viewer.mayorCityId,
      );
  }

  /** 当前查看者身份（只含权限判断字段；每次现算，换任/读档立即生效）。 */
  get viewer(): ViewerIdentity {
    return viewerIdentity(this.world);
  }

  /** 事件日志的可见条目（按当前身份重过滤；面板不得直接读 world.log）。 */
  visibleLog(): ReturnType<typeof visibleLogEntries> {
    return visibleLogEntries(this.world, this.viewer);
  }

  /**
   * 市长财政视图（唯一允许给界面用的财政形状）。
   * 非该城现任市长返回 null，调用方必须按 null 处理，不得回退读 city.treasury。
   */
  fiscalView(cityId: string): MayorFiscalView | null {
    const city = this.world.cities.find((entry) => entry.id === cityId);
    if (!city) return null;
    return buildMayorFiscalView(this.world, city, DEMO_CONFIG, this.viewer);
  }

  /**
   * 公开破产事件摘要（§7：破产事件公开）。
   * 只暴露破产事实与处置结果（兑付/垫付/勾销/看守期/托管持股），
   * 不含财政余额、实时债务率等市长专属字段，非市长也可渲染。
   */
  publicBankruptcy(cityId: string): PublicBankruptcyNotice | null {
    const city = this.world.cities.find((entry) => entry.id === cityId);
    if (!city) return null;
    const government = city.government;
    const records = government?.records ?? [];
    const record = [...records].sort((a, b) => b.tick - a.tick)[0] ?? null;
    const status = government?.bankruptcy?.status ?? city.bankruptcy?.status ?? 'solvent';
    if (!record && status === 'solvent') return null;
    const trustHoldings = this.world.securities.holdings
      .filter((holding) => holding.holder.type === 'trust' && holding.holder.id === `trust-${holding.companyId}`)
      .map((holding) => ({
        companyId: holding.companyId,
        companyName: this.world.companies.find((company) => company.id === holding.companyId)?.name ?? holding.companyId,
        shares: holding.shares,
      }));
    // 金额明细仅该城市现任市长可见；事实、流程与重选结果对所有人公开。
    const detailsVisible = this.viewer.mayorCityId === cityId;
    return {
      cityId,
      status,
      tick: record?.tick ?? government?.bankruptcy?.tick ?? null,
      caretakerUntilElection: record?.caretakerUntilElection ?? false,
      electionTriggeredTick: record?.electionTriggeredTick ?? null,
      detailsVisible,
      bondsRedeemedPrincipal: detailsVisible ? record?.bondsRedeemedPrincipal ?? 0 : null,
      bondsRedeemedInterest: detailsVisible ? record?.bondsRedeemedInterest ?? 0 : null,
      bondRedemptionCount: detailsVisible ? record?.bondRedemptionCount ?? 0 : null,
      bankAdvanceCreated: detailsVisible ? record?.bankAdvanceCreated ?? 0 : null,
      bankLoansWrittenOff: detailsVisible ? record?.bankLoansWrittenOff ?? 0 : null,
      advancesWrittenOff: detailsVisible ? record?.advancesWrittenOff ?? 0 : null,
      interestWrittenOff: detailsVisible ? record?.interestWrittenOff ?? 0 : null,
      note: detailsVisible
        ? record?.note ?? ''
        : '破产处置金额、政府债务口径与财政流水仅该城市现任市长可见；破产事实与重选结果公开，个人持债兑付记录可在债券市场查看。',
      trustHoldings,
    };
  }

  /** 单批发债的公开投资信息（白名单形状；批次不存在返回 null）。 */
  publicBondView(issuanceId: string): PublicBondOfferView | null {
    return buildPublicBondOffer(this.world, issuanceId);
  }

  /** 债券市场公开信息（不含发行计划总额、总售额、政府总债务）。 */
  get bondMarketOffers(): PublicBondOfferView[] {
    const issuances = this.world.bonds?.issuances ?? [];
    return issuances
      .map((issuance) => buildPublicBondOffer(this.world, issuance.id))
      .filter((offer): offer is PublicBondOfferView => offer !== null)
      .sort(
        (a, b) =>
          a.maturityTick - b.maturityTick || a.issuanceId.localeCompare(b.issuanceId),
      );
  }

  /** 玩家自己的持债记录（任何玩家都能看自己的）。 */
  get ownBondHoldings(): OwnBondHoldingView[] {
    return buildOwnBondHoldingViews(this.world, this.viewer.playerId);
  }

  get unreadNotificationCount(): number {
    return unreadNotificationCount(this.world);
  }

  /** 需要玩家处理的系统提示（存档失败等），用易懂语言展示在通知窗口顶部。 */
  get systemNotices(): { id: string; tone: 'info' | 'warning' | 'error'; text: string }[] {
    const notices: { id: string; tone: 'info' | 'warning' | 'error'; text: string }[] = [];
    if (this.autosaveDisabled) {
      notices.push({
        id: 'autosave-paused',
        tone: 'error',
        text: `自动存档已暂停：${this.autosaveDisabledReason ?? '检测到无法读取的自动存档'}。原文件已保留；读取其他存档或开始新世界后才会恢复自动保存。`,
      });
    } else if (this.lastAutoSaveError) {
      notices.push({
        id: 'autosave-error',
        tone: 'warning',
        text: `自动存档失败：${this.lastAutoSaveError}。当前进度仍可手动保存。`,
      });
    }
    if (this.lastMigrationFrom !== null) {
      notices.push({
        id: 'save-migrated',
        tone: 'info',
        text: `存档已从旧格式 v${this.lastMigrationFrom} 迁移：原有资金、持股、企业、人口和随机状态已保留，新增股权结构按规则生成。`,
      });
    }
    return notices;
  }

  markNotificationRead(id: string): void {
    if (markNotificationRead(this.world, id)) this.emit();
  }

  markAllNotificationsRead(): void {
    markAllNotificationsRead(this.world);
    this.emit();
  }

  /** 企业股权概览（只读，供详情面板与交易界面使用）。 */
  securitiesView(companyId: string): {
    price: number;
    holders: ReturnType<typeof companyHolders>;
    orders: ReturnType<typeof openOrdersFor>;
    offers: ReturnType<typeof openOffersFor>;
    playerShares: number;
    playerVotingShares: number;
    playerStake: number;
    votingClassId: string;
    nonVotingClassId: string;
  } {
    const company = this.world.companies.find((candidate) => candidate.id === companyId);
    return {
      price: company ? bookPrice(this.world, company) : 0,
      holders: companyHolders(this.world, companyId),
      orders: openOrdersFor(this.world, companyId),
      offers: openOffersFor(this.world, companyId),
      playerShares: playerTotalShares(this.world, companyId),
      playerVotingShares: playerVotingShares(this.world, companyId),
      playerStake: playerStakeOf(this.world, companyId),
      votingClassId: classOf(this.world, companyId, 'voting')?.id ?? shareClassId(companyId, 'voting'),
      nonVotingClassId:
        classOf(this.world, companyId, 'nonVoting')?.id ?? shareClassId(companyId, 'nonVoting'),
    };
  }

  governanceView(companyId: string) {
    return governanceFor(this.world, companyId);
  }

  /** 玩家在某议案的登记日可投票股数；0 表示不能参与该次表决。 */
  motionEligibility(motionId: string): number {
    const motion = this.world.governance.motions.find((candidate) => candidate.id === motionId);
    if (!motion) return 0;
    return playerEligibleShares(this.world, motion);
  }

  /** 二级市场买卖：先下单再撮合；未成交部分保留为挂单（不冻结资金/股份）。 */
  tradeShares(
    companyId: string,
    kind: ShareKind,
    side: 'buy' | 'sell',
    shares: number,
    limitPrice: number,
  ): TradeActionResult {
    const classId =
      kind === 'voting' ? shareClassId(companyId, 'voting') : shareClassId(companyId, 'nonVoting');
    const company = this.world.companies.find((candidate) => candidate.id === companyId);
    const liveClass = this.world.securities.classes.some(
      (candidate) => candidate.id === classId,
    );
    if (!company || !liveClass) {
      this.toast('该企业已退出市场或股份已注销：不可再交易。', 'error');
      this.emit();
      return { ok: false, error: '该企业已退出市场或股份已注销：不可再交易。' };
    }
    const result = tradeImmediately(
      this.world,
      {
        companyId,
        shareClassId: classId,
        side,
        holder: { type: 'player', id: 'player' },
        shares,
        limitPrice,
        tick: this.world.time.tick,
        note: '玩家二级市场订单',
      },
      DEMO_CONFIG,
    );
    if (!result.ok) {
      this.toast(result.error ?? '股票交易失败', 'error');
      this.emit();
      return { ok: false, error: result.error };
    }
    if (result.shares > 0) {
      this.toast(
        `${side === 'buy' ? '买入' : '卖出'} ${company.name} ${kind === 'voting' ? '有投票权' : '仅分红'}股份 ${result.shares} 股，成交额 ${result.value.toFixed(2)} 信用点。`,
        'success',
      );
      void this.autosave();
    } else {
      this.toast('订单已挂出，暂时没有对手方；未冻结资金或股份，可在企业页面查看挂单。', 'info');
    }
    this.emit();
    return {
      ok: true,
      shares: result.shares,
      unitPrice: result.unitPrice,
      value: result.value,
    };
  }

  // ---------------------------------------------------------------- v0.8 股票市场

  openStockMarket(companyId?: string, kind?: ShareKind): void {
    this.stockMarketOpen = true;
    if (kind) this.stockMarketKind = kind;
    const focus = companyId ?? this.stockMarketFocusCompanyId ?? this.selectedCompanyId;
    if (focus && this.hasStockHistoryFor(focus)) {
      this.stockMarketFocusCompanyId = focus;
    }
    this.emit();
  }

  closeStockMarket(): void {
    this.stockMarketOpen = false;
    this.emit();
  }

  setStockMarketKind(kind: ShareKind): void {
    this.stockMarketKind = kind;
    this.emit();
  }

  setStockMarketFocus(companyId: string): void {
    this.stockMarketFocusCompanyId = companyId;
    this.emit();
  }

  setStockMarketView(view: 'all' | 'holdings'): void {
    this.stockMarketViewMode = view;
    this.emit();
  }

  setStockMarketFilter(patch: { search?: string; cityId?: string | null; industry?: string | null }): void {
    if (patch.search !== undefined) this.stockMarketSearch = patch.search;
    if (patch.cityId !== undefined) this.stockMarketCityFilter = patch.cityId;
    if (patch.industry !== undefined) this.stockMarketIndustryFilter = patch.industry;
    this.emit();
  }

  /** 股票市场大窗口的只读视图：列表、明细、K 线、玩家持仓与本人类别的挂单。 */
  stockMarketView(): StockMarketView {
    const kind = this.stockMarketKind;
    const cityNameOf = (id: string) => this.world.cities.find((city) => city.id === id)?.name ?? id;
    const companies = [...this.world.companies].sort(
      (a, b) =>
        cityNameOf(a.cityId).localeCompare(cityNameOf(b.cityId), 'zh-Hans-CN') ||
        a.name.localeCompare(b.name, 'zh-Hans-CN'),
    );
    const cities = [...new Set(companies.map((company) => company.cityId))].map((id) => ({
      id,
      name: cityNameOf(id),
    }));
    const industries = [...new Set(companies.map((company) => company.sector).filter(Boolean))].sort();

    const companyIds = new Set(companies.map((company) => company.id));
    const classIds = new Set(this.world.securities.classes.map((candidate) => candidate.id));
    const exitedRows = this.world.securities.history
      .filter((entry) => entry.kind === kind && !classIds.has(entry.shareClassId))
      .map((entry) => this.buildExitedStockRow(entry))
      .filter((row) => !companyIds.has(row.companyId));
    let rows = [...companies.map((company) => this.buildStockRow(company, kind)), ...exitedRows];
    if (this.stockMarketViewMode === 'holdings') rows = rows.filter((row) => row.playerShares > 0);
    const search = this.stockMarketSearch.trim().toLowerCase();
    if (search) {
      rows = rows.filter((row) =>
        `${row.companyName} ${row.cityName} ${row.industry}`.toLowerCase().includes(search),
      );
    }
    if (this.stockMarketCityFilter) rows = rows.filter((row) => row.cityId === this.stockMarketCityFilter);
    if (this.stockMarketIndustryFilter) {
      rows = rows.filter((row) => row.industry === this.stockMarketIndustryFilter);
    }
    const focusId = this.stockMarketFocusCompanyId ?? this.selectedCompanyId;
    const selectedRow = rows.find((row) => row.companyId === focusId) ?? rows[0] ?? null;

    return {
      open: this.stockMarketOpen,
      view: this.stockMarketViewMode,
      search: this.stockMarketSearch,
      cityFilter: this.stockMarketCityFilter,
      industryFilter: this.stockMarketIndustryFilter,
      cities,
      industries,
      rows,
      kind,
      selected: selectedRow ? this.buildStockDetail(selectedRow.companyId, kind) : null,
      note:
        '行情来自真实成交（玩家撮合与月度撮合）；某月无成交则不生成 K 线，旧存档历史显示“暂无数据”。' +
        '最近成交价与账面参考价分开标注，两者不可互相冒充。',
    };
  }

  /** 撤销玩家自己的未成交股票委托；不改变现金与持股。 */
  cancelStockOrder(orderId: string): { ok: boolean; error?: string } {
    const index = this.world.securities.orders.findIndex((order) => order.id === orderId);
    if (index < 0) {
      this.toast('委托不存在或已成交。', 'error');
      this.emit();
      return { ok: false, error: '委托不存在' };
    }
    const order = this.world.securities.orders[index];
    if (!order) {
      this.toast('委托不存在或已成交。', 'error');
      this.emit();
      return { ok: false, error: '委托不存在' };
    }
    if (order.holder.type !== 'player' || order.holder.id !== 'player') {
      this.toast('只能撤销自己的委托。', 'error');
      this.emit();
      return { ok: false, error: '不是玩家的委托' };
    }
    this.world.securities.orders.splice(index, 1);
    this.toast('委托已撤销；未冻结的资金与股份不受影响。', 'success');
    void this.autosave();
    this.emit();
    return { ok: true };
  }

  /**
   * 市长税收面板（基准税额、交通系数、加成/损耗与最终入账）。
   * 仅该城市现任市长可见；非市长返回 null（财政信息白名单）。
   */
  taxView(cityId: string): CityTaxPanelView | null {
    if (viewerIdentity(this.world).mayorCityId !== cityId) return null;
    const city = this.world.cities.find((candidate) => candidate.id === cityId);
    if (!city) return null;
    const history = this.world.taxes.historyByCity[cityId] ?? [];
    return {
      cityId,
      cityName: city.name,
      latest: latestTaxMonth(this.world, cityId) ?? null,
      history,
      note:
        '基准税额由居民与企业按税法缴纳；交通税收系数只调整政府最终入账。系数 >1 的差额记为交通财政加成（系统注入），' +
        '<1 的差额记为交通征收损耗（不再退回纳税人）；两者都不是债务、贷款或 GDP。',
    };
  }

  private buildStockRow(company: Company, kind: ShareKind): StockListRow {
    const shareClass = classOf(this.world, company.id, kind);
    const classId = shareClass?.id ?? shareClassId(company.id, kind);
    const issuedShares = shareClass?.issuedShares ?? 0;
    const last = this.stockLastTrade(classId);
    const candles = this.stockCandles(classId);
    const playerShares = this.stockPlayerShares(classId);
    const playerOpenOrders = this.world.securities.orders.filter(
      (order) =>
        order.shareClassId === classId && order.holder.type === 'player' && order.holder.id === 'player',
    ).length;
    return {
      companyId: company.id,
      companyName: company.name,
      cityId: company.cityId,
      cityName: this.world.cities.find((city) => city.id === company.cityId)?.name ?? company.cityId,
      industry: company.sector,
      kind,
      classId,
      issuedShares,
      lastPrice: last ? last.price : null,
      lastTradeTick: last ? last.tick : null,
      bookPrice: bookPrice(this.world, company),
      changePct: this.stockChangePct(candles, last ? last.price : null),
      playerShares,
      playerStake: issuedShares > 0 ? playerShares / issuedShares : 0,
      playerOpenOrders,
      tradable: Boolean(shareClass) && issuedShares > 0,
      exited: false,
    };
  }

  /** 已退出企业的历史行：只读、不可交易，但保留真实成交与 K 线（v0.8 复验问题 3）。 */
  private buildExitedStockRow(entry: StockClassHistory): StockListRow {
    const candles = this.stockCandles(entry.shareClassId);
    const last = this.stockLastTrade(entry.shareClassId);
    const playerShares = this.stockPlayerShares(entry.shareClassId);
    return {
      companyId: entry.companyId,
      companyName: entry.companyName ?? entry.companyId,
      cityId: '',
      cityName: '已退出市场',
      industry: '已退出',
      kind: entry.kind,
      classId: entry.shareClassId,
      issuedShares: 0,
      lastPrice: last ? last.price : null,
      lastTradeTick: last ? last.tick : null,
      bookPrice: 0,
      changePct: this.stockChangePct(candles, last ? last.price : null),
      playerShares,
      playerStake: 0,
      playerOpenOrders: 0,
      tradable: false,
      exited: true,
    };
  }

  private hasStockHistoryFor(companyId: string): boolean {
    return (
      this.world.companies.some((company) => company.id === companyId) ||
      this.world.securities.history.some((entry) => entry.companyId === companyId)
    );
  }

  /** 已退出企业的明细：历史 K 线只读，禁止下单或恢复注销股份。 */
  private buildExitedStockDetail(entry: StockClassHistory): StockDetailView {
    const candles = this.stockCandles(entry.shareClassId);
    const last = this.stockLastTrade(entry.shareClassId);
    return {
      company: {
        id: entry.companyId,
        name: entry.companyName ?? entry.companyId,
        cityId: '',
        cityName: '已退出市场',
        industry: '已退出',
        note: '该企业已退出市场：以下为退出前的真实成交历史，仅用于查阅，不可再交易。',
        employees: 0,
        capacity: 0,
        utilization: 0,
      },
      kind: entry.kind,
      classId: entry.shareClassId,
      issuedShares: 0,
      lastPrice: last ? last.price : null,
      lastTradeTick: last ? last.tick : null,
      bookPrice: 0,
      changePct: this.stockChangePct(candles, last ? last.price : null),
      candles,
      bestBid: null,
      bestAsk: null,
      playerShares: this.stockPlayerShares(entry.shareClassId),
      playerStake: 0,
      playerCash: this.world.player.cash,
      playerOrders: [],
      tradable: false,
      exited: true,
      exitedTick: entry.exitedTick ?? null,
      note:
        '企业已退出市场：这里只展示退出前真实成交形成的 K 线与最后成交时间；' +
        '已注销股份不可恢复，也不能再对其下单。',
    };
  }

  private buildStockDetail(companyId: string, kind: ShareKind): StockDetailView | null {
    const company = this.world.companies.find((candidate) => candidate.id === companyId);
    if (!company) {
      const history = this.world.securities.history.find(
        (entry) => entry.companyId === companyId && entry.kind === kind,
      );
      return history ? this.buildExitedStockDetail(history) : null;
    }
    const shareClass = classOf(this.world, company.id, kind);
    const classId = shareClass?.id ?? shareClassId(company.id, kind);
    const issuedShares = shareClass?.issuedShares ?? 0;
    const last = this.stockLastTrade(classId);
    const candles = this.stockCandles(classId);
    const orders = openOrdersFor(this.world, company.id).filter((order) => order.shareClassId === classId);
    const bids = orders.filter((order) => order.side === 'buy' && order.shares > 0);
    const asks = orders.filter((order) => order.side === 'sell' && order.shares > 0);
    const playerShares = this.stockPlayerShares(classId);
    const playerOrders = orders
      .filter((order) => order.holder.type === 'player' && order.holder.id === 'player')
      .map((order) => ({
        id: order.id,
        side: order.side,
        shares: order.shares,
        limitPrice: order.limitPrice,
        createdTick: order.createdTick,
      }));
    return {
      company: {
        id: company.id,
        name: company.name,
        cityId: company.cityId,
        cityName: this.world.cities.find((city) => city.id === company.cityId)?.name ?? company.cityId,
        industry: company.sector,
        note: company.note,
        employees: company.employees,
        capacity: company.capacity,
        utilization: company.utilization,
      },
      kind,
      classId,
      issuedShares,
      lastPrice: last ? last.price : null,
      lastTradeTick: last ? last.tick : null,
      bookPrice: bookPrice(this.world, company),
      changePct: this.stockChangePct(candles, last ? last.price : null),
      candles,
      bestBid: bids.length > 0 ? Math.max(...bids.map((order) => order.limitPrice)) : null,
      bestAsk: asks.length > 0 ? Math.min(...asks.map((order) => order.limitPrice)) : null,
      playerShares,
      playerStake: issuedShares > 0 ? playerShares / issuedShares : 0,
      playerCash: this.world.player.cash,
      playerOrders,
      tradable: Boolean(shareClass) && issuedShares > 0,
      exited: false,
      exitedTick: null,
      note:
        '最近成交价 = 最近一笔真实成交；账面参考价 = 企业账面估值参考，不是可成交价；本月无成交时 K 线为空档。',
    };
  }

  private stockPlayerShares(classId: string): number {
    return this.world.securities.holdings
      .filter(
        (holding) =>
          holding.shareClassId === classId &&
          holding.holder.type === 'player' &&
          holding.holder.id === 'player',
      )
      .reduce((total, holding) => total + holding.shares, 0);
  }

  private stockCandles(classId: string): StockCandleView[] {
    const history = this.world.securities.history.find((entry) => entry.shareClassId === classId);
    if (!history) return [];
    return history.candles.map((candle) => ({
      tick: candle.tick,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume,
      trades: candle.trades,
    }));
  }

  private stockLastTrade(classId: string): { price: number; tick: number } | null {
    const history = this.world.securities.history.find((entry) => entry.shareClassId === classId);
    if (history?.lastTrade) return { price: history.lastTrade.price, tick: history.lastTrade.tick };
    const trades = this.world.securities.lastTrades.filter((trade) => trade.shareClassId === classId);
    if (trades.length === 0) return null;
    const latest = trades.reduce((best, trade) => (trade.tick >= best.tick ? trade : best));
    return { price: latest.unitPrice, tick: latest.tick };
  }

  /** 相对上一根月 K 线收盘价的涨跌幅；只有一根或没有成交时返回 null。 */
  private stockChangePct(candles: readonly StockCandleView[], lastPrice: number | null): number | null {
    const closes = candles.map((candle) => candle.close).filter((value) => value > 0);
    if (closes.length >= 2) {
      const previous = closes[closes.length - 2] ?? 0;
      const latest = closes[closes.length - 1] ?? 0;
      if (previous > 0) return Math.round((latest / previous - 1) * 10000) / 100;
      return null;
    }
    if (closes.length === 1 || lastPrice === null) return null;
    return null;
  }

  acceptFinancingOffer(offerId: string): boolean {
    const offer = this.world.securities.offers.find((candidate) => candidate.id === offerId);
    if (!offer) {
      this.toast('融资要约不存在', 'error');
      return false;
    }
    if (offer.investor.type !== 'player') {
      this.toast('这份融资要约不是发给玩家的。', 'error');
      return false;
    }
    const result = acceptFinancingOffer(this.world, offerId, this.world.time.tick);
    if (!result.ok) {
      this.toast(result.error ?? '接受融资要约失败', 'error');
      this.emit();
      return false;
    }
    const company = this.world.companies.find((candidate) => candidate.id === offer.companyId);
    this.toast(
      `已向 ${company?.name ?? '企业'} 出资 ${offer.amount.toFixed(2)} 信用点，获得 ${offer.shares} 股${offer.kind === 'voting' ? '有投票权' : '仅分红'}股份。`,
      'success',
    );
    void this.autosave();
    this.emit();
    return true;
  }

  declineFinancingOffer(offerId: string): void {
    const result = declineFinancingOffer(this.world, offerId);
    if (!result.ok) {
      this.toast(result.error ?? '拒绝融资要约失败', 'error');
      return;
    }
    this.toast('已拒绝融资要约；没有资金或股份变化。', 'info');
    void this.autosave();
    this.emit();
  }

  voteOnMotion(motionId: string, vote: 'for' | 'against' | 'abstain'): boolean {
    const result = castVote(
      this.world,
      motionId,
      { type: 'player', id: 'player' },
      vote,
      this.world.time.tick,
    );
    if (!result.ok) {
      this.toast(result.error ?? '表决失败', 'error');
      this.emit();
      return false;
    }
    this.toast(
      vote === 'for' ? '已投赞成票。' : vote === 'against' ? '已投反对票。' : '已投弃权票。',
      'success',
    );
    void this.autosave();
    this.emit();
    return true;
  }

  proposeOperator(companyId: string, operator: 'management' | HolderRef): boolean {
    const result = proposeOperatorMotion(
      this.world,
      companyId,
      { type: 'player', id: 'player' },
      operator,
      this.world.time.tick,
      DEMO_CONFIG,
    );
    if (!result.ok) {
      this.toast(result.error ?? '无法提出经营者议案', 'error');
      this.emit();
      return false;
    }
    this.toast('已提出经营者任命议案，将在表决期结束时计票。', 'success');
    void this.autosave();
    this.emit();
    return true;
  }

  /** 市政府组织跨城协议（演示入口；市长选举系统尚未实现，不把玩家当成市长）。 */
  organizeAgreement(partnerCityId: string): boolean {
    const sponsorCityId = this.selectedCityId;
    if (!sponsorCityId) {
      this.toast('请先选择发起城市。', 'error');
      return false;
    }
    const result = proposeAgreement(
      this.world,
      sponsorCityId,
      partnerCityId,
      DEMO_CONFIG,
      this.world.time.tick,
      'demo',
    );
    if (!result.ok || !result.agreement) {
      this.toast(result.error ?? '没有可协商的买卖配对', 'warning');
      this.emit();
      return false;
    }
    applyAutoDecisions(this.world, result.agreement.id, DEMO_CONFIG, this.world.time.tick);
    const agreement = this.world.agreements.find((entry) => entry.id === result.agreement?.id);
    this.toast(
      `市政府（演示）已组织「${agreement?.title ?? '跨城协议'}」：${agreement?.status === 'active' ? '企业已接受，下月起逐项履约。' : '未达成或仍在协商，拒绝方不承担义务。'}`,
      'info',
    );
    void this.autosave();
    this.emit();
    return true;
  }

  decideAgreement(agreementId: string, companyId: string, accept: boolean): boolean {
    const result = decideParticipant(
      this.world,
      agreementId,
      companyId,
      accept,
      this.world.time.tick,
      DEMO_CONFIG,
    );
    if (!result.ok) {
      this.toast(result.error ?? '协议决策失败', 'error');
      this.emit();
      return false;
    }
    this.toast(accept ? '企业已接受协议参与邀请。' : '企业已拒绝协议；不产生任何买卖义务。', 'info');
    void this.autosave();
    this.emit();
    return true;
  }

  withdrawAgreement(agreementId: string): void {
    const result = cancelAgreement(
      this.world,
      agreementId,
      this.world.time.tick,
      '玩家取消（演示）',
    );
    if (!result.ok) this.toast(result.error ?? '取消协议失败', 'error');
    else this.toast('协议已取消，未履约条目不再执行。', 'info');
    void this.autosave();
    this.emit();
  }

  /**
   * 明确标注的演示身份：用于验证市长专属路径（可绕过选举，不代表选举结果）。
   * 生产构建必须移除该后门（补充指令 §7 / DECISIONS v1.1 #15）；界面按钮同步隐藏。
   */
  setMayorDemo(cityId: string | null): void {
    if (!import.meta.env.DEV) {
      this.toast('演示市长身份仅开发构建可用；正式版请通过选举获得身份。', 'warning');
      return;
    }
    if (cityId) {
      appointPlayerMayor(this.world, cityId);
      const city = this.world.cities.find((candidate) => candidate.id === cityId);
      this.toast(
        `演示身份：${city?.name ?? cityId} 市长。政策将由你选择，AI 不会代选。`,
        'warning',
      );
    } else {
      const current = this.world.player.roles.mayorCityId;
      if (current) stepDownPlayerMayor(this.world, current);
      this.toast('已退出市长演示身份。', 'info');
    }
    void this.autosave();
    this.emit();
  }

  /** 市值/估值工具：按当前账面价计算玩家持股价值。 */
  playerHoldingValue(companyId: string): number {
    const company = this.world.companies.find((candidate) => candidate.id === companyId);
    if (!company) return 0;
    return Math.round(playerTotalShares(this.world, companyId) * bookPrice(this.world, company) * 100) / 100;
  }

  playerVotingSharesOf(companyId: string): number {
    return playerVotingShares(this.world, companyId);
  }

  /** 玩家当前是否为某城市市长（仅状态；演示设置见 setMayorDemo）。 */
  get mayorCityId(): string | null {
    return this.world.player.roles?.mayorCityId ?? null;
  }

  /**
   * 界面与命令共用的市长判据：每次调用现算，不缓存。
   * 换任、离职、破产重新选举或读档后会立即返回新身份，界面无需额外失效逻辑。
   */
  isMayorOf(cityId: string): boolean {
    return playerIsMayor(this.world, cityId);
  }

  agreementsForCity(cityId: string): WorldState['agreements'] {
    return this.world.agreements
      .filter(
        (agreement) =>
          agreement.sponsorCityId === cityId || agreement.partnerCityId === cityId,
      )
      .sort((a, b) => b.createdTick - a.createdTick || a.id.localeCompare(b.id));
  }

  agreementPartners(cityId: string): { id: string; name: string }[] {
    return this.world.cities
      .filter((city) => city.id !== cityId)
      .map((city) => ({ id: city.id, name: city.name }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  currentTradeFlows(): TradeFlow[] {
    return this.world.lastTick.tradeFlows;
  }

  companiesForCity(cityId: string): Company[] {
    return this.world.companies.filter((company) => company.cityId === cityId);
  }

  companionDistricts(cityId: string): DistrictDefinition[] {
    return this.layouts[cityId]?.districts ?? [];
  }

  // ---- v0.3：政府、政策、交通、企业与生命周期 ----

  /** 当前存档格式版本（供界面与桌面验证脚本读取，不硬编码）。 */
  get saveFormatVersion(): number {
    return SAVE_FORMAT_VERSION;
  }

  get fiscalLedger() {
    return this.world.fiscal.ledger.slice(-40).reverse();
  }

  policyView(cityId: string) {
    const city = this.world.cities.find((entry) => entry.id === cityId);
    const summary = policySummary(this.world, cityId);
    return {
      city,
      isPlayerMayor: playerIsMayor(this.world, cityId),
      leader: summary.leader,
      lastSelection: summary.lastSelection,
      active: summary.active,
      history: this.world.policies.history.filter((entry) => entry.cityId === cityId).slice(-6),
      definitions: POLICY_DEFINITIONS.map((definition) => {
        const check = canStartPolicy(this.world, cityId, definition.id, DEMO_CONFIG);
        return {
          ...definition,
          defaultBudget: DEMO_CONFIG.policies.budgets[definition.id],
          available: check.ok,
          reason: check.error ?? '',
        };
      }),
    };
  }

  /** 玩家市长选择政策；非玩家政府由模拟自动选择，这里会拒绝。 */
  selectPolicy(policyId: (typeof POLICY_DEFINITIONS)[number]['id'], options: {
    budget?: number;
    taxDirection?: 'cut' | 'raise';
    transportTarget?: string;
    targetSector?: string;
  } = {}): boolean {
    const cityId = this.selectedCityId;
    if (!cityId) {
      this.toast('请先选择城市。', 'error');
      return false;
    }
    if (!playerIsMayor(this.world, cityId)) {
      this.toast('只有该城市市长可以决定政策；当前由政府自主施政。', 'warning');
      return false;
    }
    const result = startPolicy(this.world, cityId, policyId, DEMO_CONFIG, {
      budget: options.budget,
      taxDirection: options.taxDirection,
      transportTarget: options.transportTarget,
      targetSector: options.targetSector as never,
      reason: '玩家市长选择',
    });
    if (!result.ok) {
      this.toast(result.error ?? '政策未能启动', 'error');
      this.emit();
      return false;
    }
    this.toast(result.note ?? '政策已启动。', 'success');
    void this.autosave();
    this.emit();
    return true;
  }

  stopPolicy(policyId: (typeof POLICY_DEFINITIONS)[number]['id']): boolean {
    const cityId = this.selectedCityId;
    if (!cityId) return false;
    if (!playerIsMayor(this.world, cityId)) {
      this.toast('只有该城市市长可以停止政策。', 'warning');
      this.emit();
      return false;
    }
    const result = cancelPolicy(this.world, cityId, policyId);
    if (!result.ok) {
      this.toast(result.error ?? '无法停止政策', 'error');
      this.emit();
      return false;
    }
    this.toast(result.note ?? '政策已停止。', 'info');
    void this.autosave();
    this.emit();
    return true;
  }

  runForMayor(cityId: string): boolean {
    const result = runForMayor(this.world, cityId, DEMO_CONFIG);
    if (!result.ok) {
      this.toast(result.error ?? '参选失败', 'error');
      this.emit();
      return false;
    }
    this.toast(result.note ?? '已参加市长选举。', 'success');
    void this.autosave();
    this.emit();
    return true;
  }

  transportView(cityId: string) {
    const city = this.world.cities.find((entry) => entry.id === cityId);
    const intracity = this.world.transport.intracity.find((entry) => entry.cityId === cityId);
    const links = this.world.transport.links
      .filter((link) => link.fromCityId === cityId || link.toCityId === cityId)
      .map((link) => {
        const partner = link.fromCityId === cityId ? link.toCityId : link.fromCityId;
        const estimate = estimateCorridorUpgrade(this.world, link.fromCityId, link.toCityId, link.mode, DEMO_CONFIG);
        return {
          ...link,
          partner,
          capacity: corridorCapacity(this.world, link.fromCityId, link.toCityId, DEMO_CONFIG),
          estimate,
        };
      })
      .sort((a, b) => a.id.localeCompare(b.id));
    const corridors = cityCorridorSummary(this.world, cityId, DEMO_CONFIG);
    return {
      city,
      links,
      corridors,
      intracity: intracity
        ? {
            ...intracity,
            capacity: intracityCapacity(intracity, DEMO_CONFIG),
            stats: this.world.transport.lastMonth.intracity.find((entry) => entry.cityId === cityId) ?? null,
            estimateRoad: estimateIntracityUpgrade(this.world, cityId, 'road', DEMO_CONFIG),
            estimateRail: estimateIntracityUpgrade(this.world, cityId, 'rail', DEMO_CONFIG),
          }
        : null,
      stats: this.world.transport.lastMonth,
    };
  }

  /** 政府投资交通：target = 'intracity:road' | 'intracity:rail' | 城际线路 ID。 */
  investTransport(target: string): boolean {
    const cityId = this.selectedCityId;
    if (!cityId) {
      this.toast('请先选择城市。', 'error');
      return false;
    }
    // 政府出资属于市长专属财政操作（补充指令 §7）：非市长在命令层直接拒绝，
    // 不能只靠界面禁用按钮。
    if (!playerIsMayor(this.world, cityId)) {
      this.toast('只有该城市市长可以决定市政投资。', 'warning');
      this.emit();
      return false;
    }
    const link = this.world.transport.links.find((entry) => entry.id === target);
    const label = link
      ? `${link.fromCityId}—${link.toCityId} ${link.mode === 'rail' ? '铁路' : '公路'}`
      : target === 'intracity:rail'
        ? '城内铁路'
        : '城内公路';
    // 与政策列表共用同一施工入口：记账、冷却与财政校验完全一致。
    const result = startPolicy(this.world, cityId, 'transportInvestment', DEMO_CONFIG, {
      transportTarget: target,
      reason: `政府投资：${label}`,
    });
    if (!result.ok) {
      this.toast(result.error ?? '交通投资失败', 'error');
      this.emit();
      return false;
    }
    this.toast(result.note ?? '交通建设已开工。', 'success');
    void this.autosave();
    this.emit();
    return true;
  }

  // ---- v0.7 债券：发债（仅市长）与认购（所有玩家） ----

  /**
   * 发起债券发行（仅该城市现任市长）。
   * 计划份数、两次发行间隔、单次上限均由模拟层校验；界面只发起命令、不预判额度。
   */
  issueBond(cityId: string, planUnits: number): boolean {
    if (!playerIsMayor(this.world, cityId)) {
      this.toast('只有该城市市长可以发起债券发行。', 'warning');
      this.emit();
      return false;
    }
    const city = this.world.cities.find((entry) => entry.id === cityId);
    if (!city) {
      this.toast('城市不存在，无法发行债券。', 'error');
      this.emit();
      return false;
    }
    const result = issueGovernmentBond(
      this.world,
      city,
      DEMO_CONFIG,
      planUnits,
      this.world.time.tick,
    );
    if (!result.ok) {
      this.toast(result.error ?? '债券发行失败', 'error');
      this.emit();
      return false;
    }
    this.toast(
      `已发起债券发行：计划 ${planUnits} 份；认购窗口为发行当月（下一次月结关闭），居民投资实体与企业会在窗口关闭前用自身资金认购剩余份数。`,
      'success',
    );
    void this.autosave();
    this.emit();
    return true;
  }

  /**
   * 认购债券（任何玩家；用真实可用资金，禁止贷款购债）。
   * 超过可售份数或资金不足时模拟层按可成交份数部分成交，界面如实反馈成交结果。
   */
  subscribeBond(issuanceId: string, units: number): boolean {
    const result = subscribeGovernmentBond(
      this.world,
      DEMO_CONFIG,
      issuanceId,
      { kind: 'player', id: this.viewer.playerId },
      units,
      this.world.time.tick,
    );
    if (!result.ok) {
      this.toast(result.error ?? '认购失败', 'error');
      this.emit();
      return false;
    }
    if (result.units <= 0) {
      this.toast('没有可成交的份数；请检查可认购份数与可用资金。', 'warning');
      this.emit();
      return false;
    }
    const partial = result.units < units ? `（申请 ${units} 份，按可成交部分成交）` : '';
    const issuance = this.world.bonds?.issuances.find((entry) => entry.id === issuanceId);
    const windowNote =
      issuance && issuance.status === 'offering'
        ? `；认购窗口至 ${bondSubscriptionCloseTick(issuance)}（下一次月结关闭）`
        : '';
    this.toast(
      `认购成功：${result.units} 份，实付 ${result.principal.toFixed(0)} 信用点${partial}${windowNote}。`,
      'success',
    );
    void this.autosave();
    this.emit();
    return true;
  }

  lifecycleView(cityId: string) {
    return {
      limits: lifecycleLimits(this.world, cityId, DEMO_CONFIG),
      foundings: this.world.lifecycle.foundings.filter((entry) => entry.cityId === cityId).slice(-5).reverse(),
      liquidations: this.world.lifecycle.liquidations.filter((entry) => entry.cityId === cityId).slice(-5).reverse(),
      canFoundInvestorGroup: this.world.investors.filter((group) => group.cityId === cityId).some((group) => group.cash > 0),
    };
  }

  /** 创办企业：居民投资群体（可联合）/现有企业/市政府；校验与出资由模拟层完成。 */
  foundCompany(founderType: 'investorGroup' | 'company' | 'government', companyId?: string): boolean {
    const cityId = this.selectedCityId;
    if (!cityId) {
      this.toast('请先选择城市。', 'error');
      return false;
    }
    // 市政府出资创办企业同属市长专属财政操作，命令层校验。
    if (founderType === 'government' && !playerIsMayor(this.world, cityId)) {
      this.toast('只有该城市市长可以以市政府名义创办企业。', 'warning');
      this.emit();
      return false;
    }
    const result = foundCompany(
      this.world,
      { cityId, founderType, founderId: companyId },
      DEMO_CONFIG,
    );
    if (!result.ok) {
      this.toast(result.error ?? '创办企业失败', 'error');
      this.emit();
      return false;
    }
    this.rebuildLayouts();
    this.toast(result.note ?? '新企业已成立。', 'success');
    void this.autosave();
    this.emit();
    return true;
  }

  expandCapacity(companyId: string): boolean {
    const company = this.world.companies.find((entry) => entry.id === companyId);
    if (!company) return false;
    const result = expandCompanyCapacity(this.world, company, DEMO_CONFIG, []);
    if (!result.ok) {
      this.toast(result.error ?? '扩产失败', 'error');
      this.emit();
      return false;
    }
    this.toast(result.note ?? '扩产完成。', 'success');
    void this.autosave();
    this.emit();
    return true;
  }

  companyAiView(companyId: string) {
    const company = this.world.companies.find((entry) => entry.id === companyId);
    if (!company) return null;
    return {
      style: company.ai.style,
      styleLabel: companyStyleLabel(company.ai.style),
      styleDescription: companyStyleDescription(company.ai.style),
      decision: decisionSummary(company),
      plan: company.ai.lastPlan,
      lossMonths: company.ai.lossMonths,
      ageMonths: company.ai.ageMonths,
      expansionEstimate: Math.round(company.capacity * DEMO_CONFIG.companyAi.maxExpansionShare),
      expansionCost: Math.round(
        company.capacity * DEMO_CONFIG.companyAi.maxExpansionShare * DEMO_CONFIG.companyAi.capacityCostPerUnit,
      ),
    };
  }

  // ---------------------------------------------------------------- v0.4 居民阶层
  /** 城市居民阶层视图：职业群体、财富阶层与统计口径（只读）。 */
  populationStrataView(cityId: string) {
    const city = this.world.cities.find((entry) => entry.id === cityId);
    if (!city) return null;
    const groups = householdGroupsOfCity(this.world, cityId).map((group) => ({
      id: group.id,
      name: group.name,
      occupation: group.occupation,
      people: group.people,
      income: group.lastMonth.income,
      wageIncome: group.lastMonth.wageIncome,
      benefits: group.lastMonth.benefits,
      dividendIncome: group.lastMonth.dividendIncome,
      incomeTax: group.lastMonth.incomeTax,
      consumption: group.lastMonth.consumption,
      desiredConsumption: group.lastMonth.desiredConsumption,
      unmetFunding: group.lastMonth.unmetFunding ?? 0,
      budget: group.lastMonth.budget ?? 0,
      loanFinancedConsumption: group.lastMonth.loanFinancedConsumption ?? 0,
      depositWithdrawn: group.lastMonth.depositWithdrawn ?? 0,
      savings: group.lastMonth.savingsContribution,
      cash: group.cash,
      deposits:
        depositAccountFor(this.world, { kind: 'household', id: group.id })?.balance ?? 0,
    }));
    const stats = this.world.households.lastStats.find((entry) => entry.cityId === cityId) ?? null;
    const totalDesiredConsumption = groups.reduce((total, group) => total + group.desiredConsumption, 0);
    const totalConsumption = groups.reduce((total, group) => total + group.consumption, 0);
    const totalUnmetFunding = groups.reduce((total, group) => total + group.unmetFunding, 0);
    return {
      cityId,
      cityName: city.name,
      groups,
      stats,
      population: { ...city.population },
      totalCash: groups.reduce((total, group) => total + group.cash, 0),
      totalDeposits: cityHouseholdDeposits(this.world, cityId),
      investorEquity: cityInvestorEquity(this.world, cityId),
      demand: {
        desiredConsumption: totalDesiredConsumption,
        consumption: totalConsumption,
        unmetFunding: totalUnmetFunding,
        budget: groups.reduce((total, group) => total + group.budget, 0),
        loanFinancedConsumption: groups.reduce(
          (total, group) => total + group.loanFinancedConsumption,
          0,
        ),
        depositWithdrawn: groups.reduce((total, group) => total + group.depositWithdrawn, 0),
      },
      note: '人数由城市人口与岗位派生，一个人只统计一次；股票权益按人口比例归属居民投资实体，不是现金。需求 = 居民本月想要购买的商品成本；成交 = 实际买到的商品成本；资金缺口 = 想买但资金不足的金额。',
    };
  }

  // ---------------------------------------------------------------- v0.4 经营者与人才市场
  /** 人才市场视图：只展示空闲经营者（其他企业的现任 AI 经营者不是可用人才）。 */
  talentMarketView(cityId?: string) {
    const operators = availableOperators(this.world, cityId).map((operator) => ({
      id: operator.id,
      name: operator.name,
      style: operator.style,
      styleLabel: operatorStyleLabel(operator.style),
      reputation: operator.reputation,
      status: operator.status,
      lastTenure: operator.history.length > 0 ? operator.history[operator.history.length - 1]! : null,
      note: operator.note,
    }));
    return {
      cityId: cityId ?? null,
      operators,
      poolLimit: DEMO_CONFIG.management.maxPoolPerCity,
    };
  }

  /** 企业经营者视图：现任、任期、选任状态与玩家经营模式（只读）。 */
  operatorView(companyId: string) {
    const company = this.world.companies.find((entry) => entry.id === companyId);
    if (!company) return null;
    const control = this.world.governance.controls.find((entry) => entry.companyId === companyId);
    const operator = currentOperator(this.world, companyId);
    const style = operator?.style ?? company.ai.style;
    const motion =
      this.world.governance.motions.find(
        (entry) =>
          entry.companyId === companyId && entry.kind === 'operatorElection' && entry.status === 'open',
      ) ?? null;
    const canVote = motion ? this.motionEligibility(motion.id) > 0 : false;
    const isCandidate = motion
      ? (motion.candidates ?? []).some((entry) => entry.kind === 'player')
      : false;
    const operation = playerOperationFor(this.world, companyId);
    const holdsVoting = playerHoldsVotingShares(this.world, companyId);
    return {
      companyId,
      isPlayerOperator: canOperate(this.world, companyId),
      operatorName: operatorNameFor(this.world, companyId),
      operatorStyle: style,
      styleLabel: operatorStyleLabel(style),
      styleDescription: operatorStyleDescription(style),
      basis: control?.basis ?? null,
      termMonthsLeft: termMonthsLeft(this.world, companyId, this.world.time.tick),
      election: motion
        ? {
            motionId: motion.id,
            closesTick: motion.closesAtTick,
            candidates: motion.candidates ?? [],
            canVote,
            isCandidate,
            canRegister: holdsVoting && !isCandidate,
            votes: motion.votes.map((vote) => ({ ...vote })),
          }
        : null,
      operation: operation
        ? {
            mode: operation.mode,
            modeLabel: OPERATION_MODE_LABELS[operation.mode],
            authorization: { ...operation.authorization },
            standingPlan: operation.standingPlan ? { ...operation.standingPlan } : null,
            proposals: proposalView(this.world, companyId),
          }
        : null,
      holdsVoting,
      majorThresholds: DEMO_CONFIG.management.majorThresholds,
    };
  }

  setOperationMode(companyId: string, mode: 'manual' | 'assisted' | 'delegated'): boolean {
    const result = setOperationMode(this.world, companyId, mode, DEMO_CONFIG, this.world.time.tick);
    return this.finishAction(result, '经营模式已更新。');
  }

  setOperationAuthorization(
    companyId: string,
    patch: Partial<{
      maxInvestmentPerMonth: number;
      maxHiresPerMonth: number;
      maxLoanAmount: number;
      allowInvestment: boolean;
      allowHiring: boolean;
      allowLoan: boolean;
      allowPriceAdjust: boolean;
    }>,
  ): boolean {
    const result = setAuthorization(this.world, companyId, patch, DEMO_CONFIG);
    return this.finishAction(result, '授权范围已更新。');
  }

  setStandingPlan(
    companyId: string,
    plan: {
      utilization: number;
      targetJobs: number;
      priceFactor: number;
      investmentPerMonth: number;
    },
  ): boolean {
    const result = setStandingPlan(this.world, companyId, plan, DEMO_CONFIG, this.world.time.tick);
    return this.finishAction(result, '经营计划已保存（持续生效直到修改或到期）。');
  }

  decideProposal(proposalId: string, approve: boolean): boolean {
    const result = decideProposal(
      this.world,
      proposalId,
      approve,
      DEMO_CONFIG,
      this.world.time.tick,
    );
    return this.finishAction(result, approve ? '提案已批准并执行。' : '提案已拒绝。');
  }

  registerCandidate(motionId: string): boolean {
    const result = registerPlayerCandidate(
      this.world,
      motionId,
      DEMO_CONFIG,
      this.world.time.tick,
    );
    return this.finishAction(result, '已登记参选。');
  }

  voteElection(motionId: string, candidateId: string): boolean {
    const result = castElectionVote(
      this.world,
      motionId,
      { type: 'player', id: 'player' },
      candidateId,
      this.world.time.tick,
    );
    return this.finishAction(result, '选票已提交。');
  }

  // ---------------------------------------------------------------- v0.4 银行
  /** 银行视图：玩家与选中企业的存款、额度、贷款与还款状态（只读）。 */
  bankView(companyId?: string | null) {
    const playerOwner = { kind: 'player' as const, id: 'player' };
    const playerCredit = creditEvaluation(this.world, playerOwner, DEMO_CONFIG);
    const playerDeposit =
      depositAccountFor(this.world, playerOwner)?.balance ?? 0;
    const playerLoans = bankLoansOf(this.world)
      .filter((loan) => sameOwner(loan.borrower, playerOwner))
      .map((loan) => ({ ...loan, label: loanLabel(this.world, loan) }));
    const company = companyId
      ? this.world.companies.find((entry) => entry.id === companyId)
      : null;
    const companyView = company
      ? (() => {
          const owner = { kind: 'company' as const, id: company.id };
          return {
            companyId: company.id,
            name: company.name,
            /** 只有具备该企业经营权的玩家才能以企业名义借款/还款（持股不等于经营权）。 */
            canOperate: canOperate(this.world, company.id),
            cash: company.cash,
            debt: company.debt,
            deposits: depositAccountFor(this.world, owner)?.balance ?? 0,
            credit: creditEvaluation(this.world, owner, DEMO_CONFIG),
            loans: bankLoansOf(this.world)
              .filter((loan) => sameOwner(loan.borrower, owner))
              .map((loan) => ({ ...loan, label: loanLabel(this.world, loan) })),
          };
        })()
      : null;
    return {
      depositRateMonthly: DEMO_CONFIG.banking.depositRateMonthly,
      products: DEMO_CONFIG.banking.products,
      creditLimitRate: DEMO_CONFIG.banking.creditLimitRate,
      graceMonths: DEMO_CONFIG.banking.graceMonths,
      player: {
        cash: this.world.player.cash,
        deposits: playerDeposit,
        credit: playerCredit,
        loans: playerLoans,
      },
      company: companyView,
      lastMonth: { ...this.world.banking.lastMonth },
      note: '银行资金无限、不会倒闭；额度 = 授信基准 × 50% − 已有未偿本金，同一主体全部贷款共享额度。',
    };
  }

  takeLoan(
    ownerKind: 'player' | 'company',
    ownerId: string,
    purpose: 'workingCapital' | 'expansion' | 'personal',
    amount: number,
  ): boolean {
    const result = playerOpenLoan(
      this.world,
      DEMO_CONFIG,
      this.world.time.tick,
      { kind: ownerKind, id: ownerKind === 'player' ? 'player' : ownerId },
      purpose,
      amount,
    );
    return this.finishAction(result, result.note ?? '贷款已放款。');
  }

  repayBankLoan(loanId: string, amount: number): boolean {
    const result = playerRepayBankLoan(
      this.world,
      loanId,
      amount,
      DEMO_CONFIG,
      this.world.time.tick,
    );
    return this.finishAction(result, result.note ?? '还款已入账。');
  }

  depositToBank(amount: number): boolean {
    const result = deposit(
      this.world,
      { kind: 'player', id: 'player' },
      amount,
      DEMO_CONFIG,
      this.world.time.tick,
    );
    return this.finishAction(result, '存款已入账。');
  }

  withdrawFromBank(amount: number): boolean {
    const result = withdraw(
      this.world,
      { kind: 'player', id: 'player' },
      amount,
      DEMO_CONFIG,
      this.world.time.tick,
    );
    return this.finishAction(result, '取款已完成。');
  }

  // ---------------------------------------------------------------- v0.9 设备、产能与生产计划

  /** 企业经营视图：设备/劳动产能、生产计划、工资奖金与库存可售月数（只读）。 */
  companyOperatingView(companyId: string): CompanyOperatingView | null {
    const company = this.world.companies.find((entry) => entry.id === companyId);
    if (!company) return null;
    const city = this.world.cities.find((entry) => entry.id === company.cityId) ?? null;
    const config = DEMO_CONFIG;
    const tech = city?.technology.productivityMultiplier ?? 1;
    const salesHistory = [...(company.salesHistory ?? [])];
    const previousSold = company.previousMonth.sold + company.previousMonth.exported;
    const referenceSamples = salesHistory.length > 0 ? salesHistory.slice(-3) : [previousSold];
    const salesReference =
      referenceSamples.reduce((total, value) => total + value, 0) / Math.max(1, referenceSamples.length);
    const finishedStock = Math.max(0, company.inventory[company.recipeOutput] ?? 0);
    const equipmentRows = EQUIPMENT_KINDS.map((kind) => {
      const catalog = equipmentCatalog(kind, config);
      const units = Math.floor(company.equipment[kind] ?? 0);
      return {
        kind,
        name: catalog.name,
        units,
        unitCapacity: catalog.capacityPerUnit * tech,
        capacity: units * catalog.capacityPerUnit * tech,
        catalogPrice: catalog.price,
        marketPrice: equipmentUnitPrice(this.world, company.cityId, kind, config),
        supply: localNewEquipmentSupply(this.world, company.cityId, kind, config),
        governmentStock: Math.floor(this.world.equipmentMarket.initialStock[kind] ?? 0),
      };
    });
    const lastMonth = company.lastMonth;
    const plan = company.productionPlan
      ? { ...company.productionPlan, reasons: [...company.productionPlan.reasons] }
      : null;
    return {
      companyId: company.id,
      companyName: company.name,
      cityId: company.cityId,
      cityName: city?.name ?? '',
      sector: company.sector,
      outputGood: company.recipeOutput,
      isPlayerOperator: canOperate(this.world, companyId),
      cash: company.cash,
      debt: company.debt,
      equipment: { ...company.equipment },
      equipmentRows,
      equipmentCapacity: company.equipmentCapacity,
      capacity: company.capacity,
      laborCapacity: city ? laborCapacity(company, city, config, this.world) : 0,
      utilization: company.utilization,
      employees: company.employees,
      jobDemand: company.jobDemand,
      wageRate: company.wageRate,
      monthlyWageBill: monthlyWageBill(company, config),
      plan,
      salesHistory,
      recentProfits: [...(company.recentProfits ?? [])],
      finishedStock,
      sellableMonths: salesReference > 0 ? finishedStock / salesReference : null,
      salesReference,
      lastMonth: {
        produced: lastMonth.produced,
        sold: lastMonth.sold,
        exported: lastMonth.exported,
        revenue: lastMonth.revenue,
        wagesPaid: lastMonth.wagesPaid,
        wageArrears: lastMonth.wageArrears,
        bonusPaid: lastMonth.bonusPaid ?? 0,
        equipmentPurchased: lastMonth.equipmentPurchased ?? 0,
        equipmentSold: lastMonth.equipmentSold ?? 0,
        emergencyLayoffs: lastMonth.emergencyLayoffs ?? 0,
        profit: lastMonth.profit,
      },
      techMultiplier: tech,
      note: '设备产能 = 台数 × 每台产能 × 城市技术系数；员工支持产能按生产口径（员工 × 人均生产率 × 技术 × 技能 × 政策）。计划产量取设备/劳动/原料三者最小。',
    };
  }

  /** 城市设备市场视图：新机价格与供给、政府储备、二手委托（只读）。 */
  equipmentMarketView(cityId: string): EquipmentMarketView | null {
    const city = this.world.cities.find((entry) => entry.id === cityId);
    if (!city) return null;
    const config = DEMO_CONFIG;
    const tech = city.technology.productivityMultiplier;
    const kinds = EQUIPMENT_KINDS.map((kind) => {
      const catalog = equipmentCatalog(kind, config);
      return {
        kind,
        name: catalog.name,
        goodId: catalog.goodId,
        catalogPrice: catalog.price,
        marketPrice: equipmentUnitPrice(this.world, cityId, kind, config),
        capacityPerUnit: catalog.capacityPerUnit,
        unitCapacity: catalog.capacityPerUnit * tech,
        techMultiplier: tech,
        sectors: [...catalog.sectors],
        supply: localNewEquipmentSupply(this.world, cityId, kind, config),
        governmentStock: Math.floor(this.world.equipmentMarket.initialStock[kind] ?? 0),
        lastMonthSold: Math.floor(this.world.equipmentMarket.lastMonthSold[kind] ?? 0),
      };
    });
    const offers = this.world.equipmentMarket.offers
      .filter((offer) => offer.cityId === cityId)
      .map((offer) => ({
        id: offer.id,
        companyId: offer.companyId,
        companyName: this.world.companies.find((entry) => entry.id === offer.companyId)?.name ?? '已退出企业',
        cityId: offer.cityId,
        kind: offer.kind,
        kindName: equipmentCatalog(offer.kind, config).name,
        units: offer.units,
        askPrice: offer.askPrice,
        listedTick: offer.listedTick,
        note: offer.note,
      }))
      .sort((a, b) => a.askPrice - b.askPrice || a.id.localeCompare(b.id));
    return {
      cityId,
      cityName: city.name,
      kinds,
      offers,
      usedPriceFactor: config.equipment.usedPriceFactor,
      liquidationPriceFactor: config.equipment.liquidationPriceFactor,
      maxBuyUnitsPerMonth: config.equipment.maxBuyUnitsPerMonth,
      note: '新设备优先由同城设备企业供货；不足部分可动用政府开局设备储备（按目录价真实付款，款项进入本城财政）。二手设备需买方真实付款、卖方设备才会转移。',
    };
  }

  /** 购买新设备：玩家经营的企业才可操作；真实扣款，政府储备付款进入本城财政。 */
  buyEquipment(companyId: string, kind: EquipmentKind, units: number): boolean {
    const company = this.world.companies.find((entry) => entry.id === companyId);
    if (!company) {
      this.toast('企业不存在。', 'error');
      this.emit();
      return false;
    }
    if (!canOperate(this.world, company.id)) {
      this.toast('只有具备该企业经营权的玩家才能购买设备。', 'warning');
      this.emit();
      return false;
    }
    if (!EQUIPMENT_KINDS.includes(kind)) {
      this.toast('设备类别无效。', 'error');
      this.emit();
      return false;
    }
    if (!Number.isInteger(units) || units <= 0) {
      this.toast('购买数量必须是正整数。', 'error');
      this.emit();
      return false;
    }
    const result = buyNewEquipment(this.world, company, kind, units, DEMO_CONFIG, this.world.time.tick, {
      allowGovernmentStock: true,
      reason: '玩家设备投资',
      log: this.world.log,
    });
    const catalog = equipmentCatalog(kind, DEMO_CONFIG);
    return this.finishAction(result, `已购买 ${result.units} 台${catalog.name}，支出 ${result.cost.toFixed(0)} 信用点。`);
  }

  /** 挂出二手设备：立即从企业设备中扣除并进入本城二手市场。 */
  sellUsedEquipment(companyId: string, kind: EquipmentKind, units: number, askPrice?: number): boolean {
    const company = this.world.companies.find((entry) => entry.id === companyId);
    if (!company) {
      this.toast('企业不存在。', 'error');
      this.emit();
      return false;
    }
    if (!canOperate(this.world, company.id)) {
      this.toast('只有具备该企业经营权的玩家才能出售设备。', 'warning');
      this.emit();
      return false;
    }
    if (!EQUIPMENT_KINDS.includes(kind)) {
      this.toast('设备类别无效。', 'error');
      this.emit();
      return false;
    }
    if (!Number.isInteger(units) || units <= 0) {
      this.toast('出售数量必须是正整数。', 'error');
      this.emit();
      return false;
    }
    if (askPrice !== undefined && (!Number.isFinite(askPrice) || askPrice <= 0)) {
      this.toast('挂牌单价必须是正数（留空按目录价 65% 挂出）。', 'error');
      this.emit();
      return false;
    }
    const result = listUsedEquipment(this.world, company, kind, units, DEMO_CONFIG, this.world.time.tick, askPrice);
    const catalog = equipmentCatalog(kind, DEMO_CONFIG);
    return this.finishAction(result, `已挂出 ${units} 台二手${catalog.name}。`);
  }

  /** 买入二手设备：真实付款给卖方，设备所有权即时转移。 */
  buyUsedEquipment(companyId: string, offerId: string, units: number): boolean {
    const company = this.world.companies.find((entry) => entry.id === companyId);
    if (!company) {
      this.toast('企业不存在。', 'error');
      this.emit();
      return false;
    }
    if (!canOperate(this.world, company.id)) {
      this.toast('只有具备该企业经营权的玩家才能购买二手设备。', 'warning');
      this.emit();
      return false;
    }
    if (!offerId) {
      this.toast('设备委托不存在。', 'error');
      this.emit();
      return false;
    }
    if (!Number.isInteger(units) || units <= 0) {
      this.toast('购买数量必须是正整数。', 'error');
      this.emit();
      return false;
    }
    const result = buyUsedEquipment(
      this.world,
      company,
      offerId,
      units,
      DEMO_CONFIG,
      this.world.time.tick,
    );
    return this.finishAction(result, `已购买二手设备 ${result.units} 台，支出 ${result.cost.toFixed(0)} 信用点。`);
  }

  /** 撤销本企业的二手设备委托（返还设备并重算产能）。 */
  cancelUsedEquipment(companyId: string, offerId: string): boolean {
    const company = this.world.companies.find((entry) => entry.id === companyId);
    if (!company) {
      this.toast('企业不存在。', 'error');
      this.emit();
      return false;
    }
    if (!canOperate(this.world, company.id)) {
      this.toast('只有具备该企业经营权的玩家才能撤销设备委托。', 'warning');
      this.emit();
      return false;
    }
    const result = cancelUsedEquipmentOffer(this.world, company.id, offerId);
    if (result.ok) recomputeCompanyCapacity(this.world, company, DEMO_CONFIG);
    return this.finishAction(result, '已撤销设备出售委托，设备已返还企业。');
  }

  /** 统一处理命令结果：成功 toast + 自动存档 + 重绘；失败只提示与重绘。 */
  private finishAction(result: { ok: boolean; error?: string; note?: string }, successText: string): boolean {
    if (!result.ok) {
      this.toast(result.error ?? '操作失败', 'error');
      this.emit();
      return false;
    }
    this.toast(result.note ?? successText, 'success');
    void this.autosave();
    this.emit();
    return true;
  }
}
