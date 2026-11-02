import type {
  Company,
  HolderRef,
  InvestmentResult,
  PlayerNotification,
  ShareKind,
  TradeActionResult,
  TradeFlow,
  WorldState,
} from '../simulation/contracts/types';
import { Simulation } from '../simulation/core/simulation';
import { parseSave, serializeSave } from '../simulation/core/save';
import { createCityLayout } from '../data/city-layout';
import type { BuildingDefinition, CityLayout, DistrictDefinition } from '../data/city-layout';
import type { SaveBridge } from '../platform/saveBridge';
import type { SaveSlotInfo } from '../platform/desktop';
import { companySharePrice } from '../simulation/companies/company';
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
  visibleNotifications,
} from '../simulation/notifications/notifications';
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
  openLoan,
  repayLoan,
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

const SAVE_SLOTS: { slot: string; label: string }[] = [
  { slot: 'autosave', label: '自动存档' },
  { slot: 'manual-1', label: '手动存档 1' },
  { slot: 'manual-2', label: '手动存档 2' },
  { slot: 'manual-3', label: '手动存档 3' },
];

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
    return visibleNotifications(this.world);
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
    if (!company) {
      this.toast('企业不存在', 'error');
      return { ok: false, error: '企业不存在' };
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

  /** 明确标注的演示身份：用于验证市长专属路径（可绕过选举，不代表选举结果）。 */
  setMayorDemo(cityId: string | null): void {
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
      savings: group.lastMonth.savingsContribution,
      cash: group.cash,
      deposits:
        depositAccountFor(this.world, { kind: 'household', id: group.id })?.balance ?? 0,
    }));
    const stats = this.world.households.lastStats.find((entry) => entry.cityId === cityId) ?? null;
    return {
      cityId,
      cityName: city.name,
      groups,
      stats,
      population: { ...city.population },
      totalCash: groups.reduce((total, group) => total + group.cash, 0),
      totalDeposits: cityHouseholdDeposits(this.world, cityId),
      investorEquity: cityInvestorEquity(this.world, cityId),
      note: '人数由城市人口与岗位派生，一个人只统计一次；股票权益按人口比例归属居民投资实体，不是现金。',
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
    const result = openLoan(
      this.world,
      { owner: { kind: ownerKind, id: ownerId }, purpose, amount },
      DEMO_CONFIG,
      this.world.time.tick,
    );
    return this.finishAction(result, result.note ?? '贷款已放款。');
  }

  repayBankLoan(loanId: string, amount: number): boolean {
    const result = repayLoan(this.world, loanId, amount, DEMO_CONFIG, this.world.time.tick);
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
