import type { Company, InvestmentResult, TradeFlow, WorldState } from '../simulation/contracts/types';
import { Simulation } from '../simulation/core/simulation';
import { parseSave, serializeSave } from '../simulation/core/save';
import { createCityLayout } from '../data/city-layout';
import type { BuildingDefinition, CityLayout, DistrictDefinition } from '../data/city-layout';
import type { SaveBridge } from '../platform/saveBridge';
import type { SaveSlotInfo } from '../platform/desktop';
import { companySharePrice } from '../simulation/companies/company';
import { cityMarketPrices } from '../simulation/markets/markets';
import { playerNetWorth, holdingStake } from '../simulation/economy/gdp';

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
    this.toast(`已从${sourceLabel}恢复（保存于 ${date}）。`, 'success');
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
      this.disableAutosave(`读取自动存档失败：${(error as Error).message}`);
      return false;
    }
    if (!read.ok || !read.text) return false;
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
    this.rebuildLayouts();
    this.selectedCityId = this.world.cities[0]?.id ?? null;
    this.view = 'region';
    this.lastSavedAt = parsed.save?.savedAt ?? null;
    this.autosaveDisabled = false;
    this.autosaveDisabledReason = null;
    this.lastAutoSaveError = null;
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

  currentTradeFlows(): TradeFlow[] {
    return this.world.lastTick.tradeFlows;
  }

  companiesForCity(cityId: string): Company[] {
    return this.world.companies.filter((company) => company.cityId === cityId);
  }

  companionDistricts(cityId: string): DistrictDefinition[] {
    return this.layouts[cityId]?.districts ?? [];
  }
}
