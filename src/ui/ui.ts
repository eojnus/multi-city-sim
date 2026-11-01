// 岚湾区域控制台：DOM 覆盖层、HUD、面板、模态框与 toast。
// 只通过 GameStore 的公开命令改变状态，不直接写模拟数据。
import type { GameStore, SaveSlotView } from '../app/gameStore';
import type { SaveBridge } from '../platform/saveBridge';
import { assetUrl } from '../platform/assets';
import { DEMO_CONFIG } from '../data/config';
import { shortTime, localizeTime, money, num, tickDate } from './format';
import {
  renderLeftCity,
  renderLeftFoot,
  renderLeftRegion,
  renderLogDock,
  renderMapGuide,
  renderMapLegend,
  renderRightCity,
  renderRightFoot,
  renderRightRegion,
} from './panels';
import type { ModalKind, ModalState } from './modals';
import { renderModal } from './modals';
import { bindPieInteractions } from './charts/pie';
import { NotificationCenter } from './notifications';
import type { NotificationItem, SystemNotice } from './notifications';
import type { PlayerNotification } from '../simulation/contracts/types';

const SKELETON = `
  <header class="hud" aria-label="顶部控制台">
    <div class="brand">
      <span class="brand-mark" aria-hidden="true"></span>
      <div class="brand-text">
        <span class="brand-kicker">LANWAN REGION</span>
        <span class="brand-title">岚湾区域</span>
        <span class="brand-sub">多城经济模拟 · 控制台</span>
      </div>
    </div>
    <div class="hud-clock" id="hud-clock">
      <span class="clock-kicker">SIMULATION TIME</span>
      <div class="clock-main">
        <strong class="hud-date" id="hud-date" data-testid="hud-date">—</strong>
        <span class="tick-chip" id="hud-tick">T0</span>
      </div>
      <div class="clock-sub">
        <span class="save-dot" id="hud-save-dot" aria-hidden="true"></span>
        <span id="hud-save-note" title="自动存档状态">尚未自动存档</span>
      </div>
    </div>
    <div class="hud-controls" role="group" aria-label="时间控制">
      <button
        type="button"
        class="ken-btn ken-btn--blue"
        id="btn-pause"
        data-testid="btn-pause"
        data-action="toggle-auto"
        aria-pressed="false"
        title="自动运行开关（Space）"
      >
        <span class="btn-ico ico-pause" aria-hidden="true"></span>
        <span class="btn-label" id="pause-label">继续</span>
      </button>
      <button
        type="button"
        class="ken-btn ken-btn--green"
        id="btn-tick"
        data-testid="btn-tick"
        data-action="tick"
        title="推进一个月（N）"
      >
        <span class="btn-ico ico-play" aria-hidden="true"></span>
        <span class="btn-label">推进 1 月</span>
      </button>
      <span class="run-pill" id="hud-run-state" title="自动推进状态">
        <i aria-hidden="true"></i>
        <span id="hud-run-text">已暂停</span>
      </span>
    </div>
    <div class="hud-stats" aria-label="关键指标">
      <div class="hud-stat">
        <span>世界 GDP</span>
        <b id="hud-gdp" data-testid="hud-gdp">—</b>
      </div>
      <div class="hud-stat">
        <span>玩家现金</span>
        <b id="hud-cash" data-testid="hud-cash">—</b>
      </div>
      <div class="hud-stat">
        <span>玩家净值</span>
        <b id="hud-net">—</b>
      </div>
    </div>
    <div class="hud-menu" role="group" aria-label="存档与信息">
      <button type="button" class="ken-btn ken-btn--grey" data-action="open-save" data-testid="btn-save" title="存档 / 手动槽位">保存</button>
      <button type="button" class="ken-btn ken-btn--grey" data-action="open-load" data-testid="btn-load" title="读取存档 / 新建世界">读取</button>
      <button type="button" class="ken-btn ken-btn--grey" data-action="open-assumptions" data-testid="btn-assumptions" title="参数与假设">参数</button>
      <button type="button" class="ken-btn ken-btn--grey" data-action="open-credits" data-testid="btn-credits" title="资源署名">署名</button>
    </div>
  </header>
  <div id="notification-host"></div>
  <div class="stage">
    <aside class="rail rail-left panel" aria-label="城市与图层">
      <div class="rail-scroll" id="left-scroll" data-scroll="left"></div>
      <div class="rail-foot" id="left-foot"></div>
    </aside>
    <section class="map-stage" aria-label="地图区域">
      <div class="map-guide" id="map-guide"></div>
      <div class="map-legend" id="map-legend"></div>
      <div class="log-dock panel" id="log-dock">
        <div class="log-content" id="log-content"></div>
      </div>
    </section>
    <aside class="rail rail-right panel" aria-label="城市与企业详情">
      <div class="rail-scroll" id="right-scroll" data-scroll="right"></div>
      <div class="rail-foot" id="right-foot"></div>
    </aside>
  </div>
  <div class="toast-stack" id="toast-stack" aria-live="polite" aria-atomic="false"></div>
  <div class="modal-host" id="modal-host" hidden></div>
`;

const TOAST_ICONS: Record<string, string> = {
  info: 'i',
  success: '✓',
  warning: '!',
  error: '×',
};

export class GameUI {
  protected overlay: HTMLDivElement | null = null;
  private leftScroll: HTMLDivElement | null = null;
  private leftFoot: HTMLDivElement | null = null;
  private rightScroll: HTMLDivElement | null = null;
  private rightFoot: HTMLDivElement | null = null;
  private logDock: HTMLDivElement | null = null;
  private logContent: HTMLDivElement | null = null;
  private mapGuide: HTMLDivElement | null = null;
  private mapLegend: HTMLDivElement | null = null;
  private toastStack: HTMLDivElement | null = null;
  private modalHost: HTMLDivElement | null = null;
  private notificationHost: HTMLDivElement | null = null;
  private notificationCenter: NotificationCenter | null = null;

  private hudClock: HTMLDivElement | null = null;
  private hudDate: HTMLElement | null = null;
  private hudTick: HTMLElement | null = null;
  private hudGdp: HTMLElement | null = null;
  private hudCash: HTMLElement | null = null;
  private hudNet: HTMLElement | null = null;
  private saveNote: HTMLElement | null = null;
  private saveDot: HTMLElement | null = null;
  private pauseButton: HTMLButtonElement | null = null;
  private pauseLabel: HTMLElement | null = null;
  private runState: HTMLElement | null = null;
  private runText: HTMLElement | null = null;

  private focusCompanyId: string | null = null;
  private showAllGoods = false;
  private logCollapsed = false;

  private lastView: 'region' | 'city' = 'region';
  private lastCityId: string | null = null;
  private lastBuildingId: string | null = null;
  private lastDistrictId: string | null = null;
  private lastDateKey = '';

  private modalKind: ModalKind | null = null;
  private modalSlots: SaveSlotView[] | null = null;
  private modalBusy: string | null = null;
  private modalPendingDelete: string | null = null;
  private modalPendingOverwrite: string | null = null;
  private modalConfirmReset = false;
  private modalNotice: string | null = null;
  private modalError: string | null = null;
  private modalCopyLabel: string | null = null;
  private modalToken = 0;
  private modalCopyTimer: number | null = null;
  private lastFocused: HTMLElement | null = null;
  private lastFocusedTestId: string | null = null;
  private flashTimer: number | null = null;
  private resetSavePending = false;
  private resetSaveStamp: string | null = null;

  constructor(
    protected store: GameStore,
    protected bridge: SaveBridge,
  ) {}

  mount(root: HTMLElement): void {
    const overlay = document.createElement('div');
    overlay.className = 'ui-overlay';
    overlay.innerHTML = SKELETON;
    overlay.dataset.view = this.store.view;
    overlay.dataset.layer = this.store.layer;
    root.appendChild(overlay);
    this.overlay = overlay;

    this.applyAssetVariables(overlay);
    this.cacheElements(overlay);
    this.mountNotifications();
    if (this.rightScroll) bindPieInteractions(this.rightScroll);
    this.bindEvents(overlay);
    this.bindExternalEvents();

    this.lastView = this.store.view;
    this.lastCityId = this.store.selectedCityId;
    this.lastBuildingId = this.store.selectedBuildingId;
    this.lastDistrictId = this.store.selectedDistrictId;
    this.lastDateKey = `${this.store.dateLabel}#${this.store.world.time.tick}`;

    this.store.subscribe(() => this.onStoreChange());
    this.renderAll();
    window.setInterval(() => this.syncSaveNote(), 1500);
  }

  private applyAssetVariables(overlay: HTMLElement): void {
    const variables: Record<string, string> = {
      '--btn-grey': assetUrl('assets/ui/buttons/grey/button_rectangle_depth_flat.png'),
      '--btn-blue': assetUrl('assets/ui/buttons/blue/button_rectangle_depth_flat.png'),
      '--btn-green': assetUrl('assets/ui/buttons/green/button_rectangle_depth_flat.png'),
      '--btn-red': assetUrl('assets/ui/buttons/red/button_rectangle_depth_flat.png'),
      '--icon-play': assetUrl('assets/ui/icons/icon_play_light.png'),
      '--icon-play-outline': assetUrl('assets/ui/icons/icon_play_outline.png'),
      '--icon-repeat': assetUrl('assets/ui/icons/icon_repeat_light.png'),
      '--divider': assetUrl('assets/ui/icons/divider.png'),
    };
    for (const [name, value] of Object.entries(variables)) {
      overlay.style.setProperty(name, `url("${value}")`);
    }
  }

  private cacheElements(overlay: HTMLElement): void {
    this.leftScroll = overlay.querySelector<HTMLDivElement>('#left-scroll');
    this.leftFoot = overlay.querySelector<HTMLDivElement>('#left-foot');
    this.rightScroll = overlay.querySelector<HTMLDivElement>('#right-scroll');
    this.rightFoot = overlay.querySelector<HTMLDivElement>('#right-foot');
    this.logDock = overlay.querySelector<HTMLDivElement>('#log-dock');
    this.logContent = overlay.querySelector<HTMLDivElement>('#log-content');
    this.mapGuide = overlay.querySelector<HTMLDivElement>('#map-guide');
    this.mapLegend = overlay.querySelector<HTMLDivElement>('#map-legend');
    this.toastStack = overlay.querySelector<HTMLDivElement>('#toast-stack');
    this.modalHost = overlay.querySelector<HTMLDivElement>('#modal-host');
    this.notificationHost = overlay.querySelector<HTMLDivElement>('#notification-host');

    this.hudClock = overlay.querySelector<HTMLDivElement>('#hud-clock');
    this.hudDate = overlay.querySelector<HTMLElement>('#hud-date');
    this.hudTick = overlay.querySelector<HTMLElement>('#hud-tick');
    this.hudGdp = overlay.querySelector<HTMLElement>('#hud-gdp');
    this.hudCash = overlay.querySelector<HTMLElement>('#hud-cash');
    this.hudNet = overlay.querySelector<HTMLElement>('#hud-net');
    this.saveNote = overlay.querySelector<HTMLElement>('#hud-save-note');
    this.saveDot = overlay.querySelector<HTMLElement>('#hud-save-dot');
    this.pauseButton = overlay.querySelector<HTMLButtonElement>('#btn-pause');
    this.pauseLabel = overlay.querySelector<HTMLElement>('#pause-label');
    this.runState = overlay.querySelector<HTMLElement>('#hud-run-state');
    this.runText = overlay.querySelector<HTMLElement>('#hud-run-text');
  }

  private mountNotifications(): void {
    if (!this.notificationHost) return;
    const center = new NotificationCenter(this.notificationHost);
    center.onMarkRead((id) => {
      this.store.markNotificationRead(id);
    });
    center.onMarkAllRead(() => {
      this.store.markAllNotificationsRead();
    });
    this.notificationCenter = center;
  }

  private notificationAudience(notice: PlayerNotification): string {
    if (notice.audience === 'personal') return '个人';
    if (notice.audience === 'company') {
      const company = notice.companyId
        ? this.store.world.companies.find((entry) => entry.id === notice.companyId)
        : undefined;
      return company?.name ?? '企业事务';
    }
    const city = notice.cityId
      ? this.store.world.cities.find((entry) => entry.id === notice.cityId)
      : undefined;
    return city ? `${city.name} · 市长事务` : '市长事务';
  }

  private syncNotifications(): void {
    if (!this.notificationCenter) return;
    const items: NotificationItem[] = this.store.notifications.map((notice) => ({
      id: notice.id,
      title: notice.title,
      body: notice.body,
      tickLabel: tickDate(notice.tick),
      kind: notice.kind,
      priority: notice.priority,
      read: notice.read,
      audienceLabel: this.notificationAudience(notice),
    }));
    const notices: SystemNotice[] = this.store.systemNotices.map((notice) => ({
      id: notice.id,
      tone: notice.tone,
      text: notice.text,
    }));
    this.notificationCenter.setData(items, notices);
  }

  // ---------------------------------------------------------------- 渲染

  private renderAll(options: { resetLeft?: boolean; resetRight?: boolean } = {}): void {
    const focusKey = this.captureFocusKey();
    const scrolls = this.captureScrolls();

    this.syncHud();
    this.syncNotifications();
    const { store } = this;
    if (this.leftScroll) {
      this.leftScroll.innerHTML =
        store.view === 'region' ? renderLeftRegion(store) : renderLeftCity(store);
    }
    if (this.leftFoot) this.leftFoot.innerHTML = renderLeftFoot(store);
    if (this.rightScroll) {
      this.rightScroll.innerHTML =
        store.view === 'region'
          ? renderRightRegion(store, {
              focusCompanyId: this.focusCompanyId,
              showAllGoods: this.showAllGoods,
            })
          : renderRightCity(store, {
              focusCompanyId: this.focusCompanyId,
              showAllGoods: this.showAllGoods,
            });
    }
    if (this.rightFoot) this.rightFoot.innerHTML = renderRightFoot(store);
    this.renderLog();
    if (this.mapGuide) this.mapGuide.innerHTML = renderMapGuide(store);
    if (this.mapLegend) this.mapLegend.innerHTML = renderMapLegend(store);

    if (this.overlay) {
      this.overlay.dataset.view = store.view;
      this.overlay.dataset.layer = store.layer;
    }

    this.restoreScrolls(scrolls);
    if (options.resetLeft && this.leftScroll) this.leftScroll.scrollTop = 0;
    if (options.resetRight && this.rightScroll) this.rightScroll.scrollTop = 0;
    this.renderToasts();
    this.restoreFocus(focusKey);
  }

  private renderRightPanel(): void {
    if (!this.rightScroll) return;
    const focusKey = this.captureFocusKey();
    const scrollTop = this.rightScroll.scrollTop;
    const state = { focusCompanyId: this.focusCompanyId, showAllGoods: this.showAllGoods };
    this.rightScroll.innerHTML =
      this.store.view === 'region'
        ? renderRightRegion(this.store, state)
        : renderRightCity(this.store, state);
    this.rightScroll.scrollTop = scrollTop;
    this.restoreFocus(focusKey);
  }

  private renderLog(): void {
    if (this.logDock) this.logDock.classList.toggle('is-collapsed', this.logCollapsed);
    if (this.logContent) this.logContent.innerHTML = renderLogDock(this.store, this.logCollapsed);
  }

  private syncHud(): void {
    const { store } = this;
    const world = store.world;
    if (this.hudDate) {
      this.hudDate.textContent = store.dateLabel;
      this.hudDate.title = store.dateLabel;
    }
    if (this.hudTick) this.hudTick.textContent = `T${world.time.tick}`;
    const gdp = world.cities.reduce((total, city) => total + city.gdp, 0);
    if (this.hudGdp) {
      this.hudGdp.textContent = money(gdp);
      this.hudGdp.title = `${num(gdp, 2)} 信用点 · 演示 GDP 口径`;
    }
    if (this.hudCash) {
      this.hudCash.textContent = money(world.player.cash);
      this.hudCash.title = `${num(world.player.cash, 2)} 信用点可投资现金`;
    }
    if (this.hudNet) {
      this.hudNet.textContent = money(store.playerNetWorth);
      this.hudNet.title = `${num(store.playerNetWorth, 2)} 信用点（现金 + 持股估值）`;
    }
    this.syncSaveNote();

    const running = store.autoRunning;
    if (this.pauseButton) {
      this.pauseButton.classList.toggle('ken-btn--red', running);
      this.pauseButton.classList.toggle('ken-btn--blue', !running);
      this.pauseButton.setAttribute('aria-pressed', String(running));
      this.pauseButton.title = running ? '暂停自动推进（Space）' : '开始自动推进（Space）';
    }
    if (this.pauseLabel) this.pauseLabel.textContent = running ? '暂停' : '继续';
    if (this.runState) {
      this.runState.classList.toggle('is-running', running);
      this.runState.title = running
        ? `自动推进中：每 ${(DEMO_CONFIG.ui.autoTickMs / 1000).toFixed(1)} 秒 1 个月`
        : '自动推进已暂停';
    }
    if (this.runText) this.runText.textContent = running ? '自动运行' : '已暂停';
  }

  private syncSaveNote(): void {
    if (!this.saveNote || !this.saveDot) return;
    if (this.store.autosaveDisabled) {
      this.saveNote.textContent = '自动存档已暂停';
      this.saveNote.title = `自动存档已暂停：${this.store.autosaveDisabledReason ?? '检测到损坏文件'}；原文件保留，可读取其他存档或手动保存。`;
      this.saveDot.classList.add('is-error');
      this.saveDot.classList.remove('is-pending');
      return;
    }
    const error = this.store.lastAutoSaveError;
    if (this.resetSavePending && !error && this.store.lastSavedAt === this.resetSaveStamp) {
      this.saveNote.textContent = '新世界 · 尚未自动存档';
      this.saveNote.title = '新世界还没有写入自动存档；推进 1 月后会写入。';
      this.saveDot.classList.remove('is-error');
      this.saveDot.classList.add('is-pending');
      return;
    }
    if (this.resetSavePending) {
      this.resetSavePending = false;
      this.resetSaveStamp = null;
    }
    const savedAt = this.store.lastSavedAt;
    this.saveNote.textContent = error
      ? '自动存档失败'
      : savedAt
        ? `自动存档 ${shortTime(savedAt)}`
        : '尚未自动存档';
    this.saveNote.title = error
      ? `自动存档失败：${error}`
      : savedAt
        ? `最近保存：${localizeTime(savedAt)}（${this.bridge.mode === 'desktop' ? '桌面存档' : '浏览器本地存储'}）`
        : '自动存档会在每次推进 1 月后写入。';
    this.saveDot.classList.toggle('is-error', Boolean(error));
    this.saveDot.classList.remove('is-pending');
  }

  private onStoreChange(): void {
    const store = this.store;
    const viewChanged = this.lastView !== store.view;
    const cityChanged = this.lastCityId !== store.selectedCityId;
    const buildingChanged = this.lastBuildingId !== store.selectedBuildingId;
    const districtChanged = this.lastDistrictId !== store.selectedDistrictId;

    if (viewChanged || cityChanged) this.focusCompanyId = null;
    this.renderAll({
      resetLeft: viewChanged,
      resetRight: viewChanged || cityChanged || buildingChanged || districtChanged,
    });
    this.updateDateFlash();

    this.lastView = store.view;
    this.lastCityId = store.selectedCityId;
    this.lastBuildingId = store.selectedBuildingId;
    this.lastDistrictId = store.selectedDistrictId;
  }

  private updateDateFlash(): void {
    const key = `${this.store.dateLabel}#${this.store.world.time.tick}`;
    if (key === this.lastDateKey) return;
    this.lastDateKey = key;
    if (!this.hudClock) return;
    this.hudClock.classList.remove('is-ticking');
    // 强制重启动画。
    void this.hudClock.offsetWidth;
    this.hudClock.classList.add('is-ticking');
    if (this.flashTimer !== null) window.clearTimeout(this.flashTimer);
    this.flashTimer = window.setTimeout(() => {
      this.hudClock?.classList.remove('is-ticking');
      this.flashTimer = null;
    }, 900);
  }

  private renderToasts(): void {
    if (!this.toastStack) return;
    const active = new Set(this.store.toasts.map((toast) => String(toast.id)));
    this.toastStack.querySelectorAll<HTMLElement>('[data-toast-id]').forEach((element) => {
      if (!active.has(element.dataset.toastId ?? '')) {
        element.classList.add('is-leaving');
        window.setTimeout(() => element.remove(), 220);
      }
    });
    for (const toast of this.store.toasts) {
      if (this.toastStack.querySelector(`[data-toast-id="${toast.id}"]`)) continue;
      const element = document.createElement('div');
      element.className = `toast toast--${toast.kind}`;
      element.dataset.toastId = String(toast.id);
      element.setAttribute('role', toast.kind === 'error' ? 'alert' : 'status');
      element.innerHTML = `
        <span class="toast-ico" aria-hidden="true">${TOAST_ICONS[toast.kind] ?? 'i'}</span>
        <span class="toast-msg">${escapeText(toast.message)}</span>
      `;
      this.toastStack.appendChild(element);
    }
  }

  private captureScrolls(): Map<string, number> {
    const map = new Map<string, number>();
    this.overlay?.querySelectorAll<HTMLElement>('[data-scroll]').forEach((element) => {
      const key = element.dataset.scroll;
      if (key) map.set(key, element.scrollTop);
    });
    return map;
  }

  private restoreScrolls(map: Map<string, number>): void {
    this.overlay?.querySelectorAll<HTMLElement>('[data-scroll]').forEach((element) => {
      const key = element.dataset.scroll;
      if (!key) return;
      const previous = map.get(key);
      if (previous !== undefined) element.scrollTop = previous;
    });
  }

  private captureFocusKey(): string | null {
    const active = document.activeElement as HTMLElement | null;
    return active?.closest<HTMLElement>('[data-focus-key]')?.dataset.focusKey ?? null;
  }

  private restoreFocus(key: string | null): void {
    if (!key || !this.overlay) return;
    const target = this.overlay.querySelector<HTMLElement>(`[data-focus-key="${key}"]`);
    if (target && target !== document.activeElement) {
      target.focus({ preventScroll: true });
    }
  }

  // ---------------------------------------------------------------- 事件

  private bindEvents(overlay: HTMLElement): void {
    overlay.addEventListener('click', (event) => {
      const rawTarget = event.target as HTMLElement | null;
      if (!rawTarget) return;
      if (rawTarget.classList.contains('modal-backdrop')) {
        this.closeModal();
        return;
      }
      const actionElement = rawTarget.closest<HTMLElement>('[data-action]');
      if (!actionElement) return;
      this.handleAction(actionElement);
    });

    overlay.addEventListener('dblclick', (event) => {
      const target = event.target as HTMLElement | null;
      const card = target?.closest<HTMLElement>('[data-action="select-city"]');
      const cityId = card?.dataset.cityId;
      if (!cityId) return;
      event.preventDefault();
      this.focusCompanyId = null;
      this.store.enterCity(cityId);
    });

    this.modalHost?.addEventListener('keydown', (event) => {
      if (!this.modalKind) return;
      // 模态框打开时阻止底层全局快捷键（Space/N/R/1-3）继续生效。
      event.stopPropagation();
      if (event.key === 'Escape') {
        event.preventDefault();
        this.closeModal();
        return;
      }
      if (event.key !== 'Tab' || !this.modalHost) return;
      const focusable = [
        ...this.modalHost.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
        ),
      ].filter((element) => element.offsetParent !== null);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      const modal = this.modalHost.querySelector<HTMLElement>('.modal');
      if (event.shiftKey && document.activeElement === (modal ?? first)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });
  }

  private bindExternalEvents(): void {
    window.addEventListener('lanwan:escape', () => {
      if (this.modalKind) this.closeModal();
    });
    window.addEventListener('lanwan:open-save', () => {
      void this.openModal('save');
    });
    window.addEventListener('lanwan:open-load', () => {
      void this.openModal('load');
    });
    window.addEventListener('lanwan:open-credits', () => {
      void this.openModal('credits');
    });
    window.addEventListener('lanwan:open-assumptions', () => {
      void this.openModal('assumptions');
    });
  }

  private handleAction(element: HTMLElement): void {
    const action = element.dataset.action;
    if (!action) return;
    const cityId = element.dataset.cityId ?? null;
    const companyId = element.dataset.companyId ?? null;
    const districtId = element.dataset.districtId ?? null;
    const buildingId = element.dataset.buildingId ?? null;
    const slot = element.dataset.slot ?? null;
    const amount = Number(element.dataset.amount ?? '');
    const motionId = element.dataset.motionId ?? null;
    const offerId = element.dataset.offerId ?? null;
    const agreementId = element.dataset.agreementId ?? null;
    const partnerCityId = element.dataset.partnerCityId ?? null;

    switch (action) {
      case 'tick':
        this.store.tick();
        break;
      case 'toggle-auto':
        this.store.setAutoRunning(!this.store.autoRunning);
        break;
      case 'set-layer': {
        const layer = element.dataset.layer;
        if (layer === 'population' || layer === 'economy' || layer === 'industry') {
          this.store.setLayer(layer);
        }
        break;
      }
      case 'select-city':
        if (cityId) {
          this.focusCompanyId = null;
          this.store.selectCity(cityId);
        }
        break;
      case 'enter-city': {
        const targetCity = cityId ?? this.store.selectedCityId;
        if (targetCity) {
          this.focusCompanyId = null;
          this.store.enterCity(targetCity);
        }
        break;
      }
      case 'back-region':
        this.focusCompanyId = null;
        this.store.backToRegion();
        break;
      case 'select-district':
        if (districtId) this.store.selectDistrict(districtId);
        break;
      case 'select-building':
        if (buildingId) this.store.selectBuilding(buildingId);
        break;
      case 'clear-selection':
        this.focusCompanyId = null;
        this.store.clearSelection();
        break;
      case 'focus-company':
        if (!companyId) break;
        this.focusCompanyId = this.focusCompanyId === companyId ? null : companyId;
        this.renderRightPanel();
        if (this.focusCompanyId) this.scrollRightToCompany();
        break;
      case 'close-company':
        this.focusCompanyId = null;
        this.renderRightPanel();
        break;
      case 'scroll-company':
        this.scrollRightToCompany();
        break;
      case 'invest':
        if (companyId && Number.isFinite(amount) && amount > 0) {
          this.focusCompanyId = companyId;
          this.store.invest(companyId, amount);
          if (this.store.view === 'region') this.scrollRightToCompany();
        }
        break;
      case 'trade-shares': {
        const kind = element.dataset.kind;
        const side = element.dataset.side;
        const shares = Number(element.dataset.shares ?? '');
        const limitPrice = Number(element.dataset.limitPrice ?? '');
        if (
          companyId &&
          (kind === 'voting' || kind === 'nonVoting') &&
          (side === 'buy' || side === 'sell') &&
          Number.isFinite(shares) &&
          shares > 0 &&
          Number.isFinite(limitPrice) &&
          limitPrice > 0
        ) {
          this.store.tradeShares(companyId, kind, side, shares, limitPrice);
        }
        break;
      }
      case 'accept-offer':
        if (offerId) this.store.acceptFinancingOffer(offerId);
        break;
      case 'decline-offer':
        if (offerId) this.store.declineFinancingOffer(offerId);
        break;
      case 'vote-motion': {
        const vote = element.dataset.vote;
        if (motionId && (vote === 'for' || vote === 'against' || vote === 'abstain')) {
          this.store.voteOnMotion(motionId, vote);
        }
        break;
      }
      case 'propose-operator': {
        const operator = element.dataset.operator;
        if (!companyId) break;
        if (operator === 'player') {
          this.store.proposeOperator(companyId, { type: 'player', id: 'player' });
        } else if (operator === 'management') {
          this.store.proposeOperator(companyId, 'management');
        }
        break;
      }
      case 'organize-agreement':
        if (partnerCityId) this.store.organizeAgreement(partnerCityId);
        break;
      case 'decide-agreement':
        if (agreementId && companyId) {
          this.store.decideAgreement(agreementId, companyId, element.dataset.accept === 'true');
        }
        break;
      case 'withdraw-agreement':
        if (agreementId) this.store.withdrawAgreement(agreementId);
        break;
      case 'toggle-mayor-demo': {
        const targetCity = cityId ?? this.store.selectedCityId;
        if (targetCity) {
          this.store.setMayorDemo(this.store.mayorCityId === targetCity ? null : targetCity);
        }
        break;
      }
      case 'toggle-goods':
        this.showAllGoods = !this.showAllGoods;
        this.renderRightPanel();
        break;
      case 'toggle-log':
        this.logCollapsed = !this.logCollapsed;
        this.renderLog();
        break;
      case 'open-save':
        void this.openModal('save');
        break;
      case 'open-load':
        void this.openModal('load');
        break;
      case 'open-assumptions':
        void this.openModal('assumptions');
        break;
      case 'open-credits':
        void this.openModal('credits');
        break;
      case 'open-report':
        void this.openModal('report');
        break;
      case 'switch-modal': {
        const target = element.dataset.modal;
        if (target === 'save' || target === 'load') void this.openModal(target);
        break;
      }
      case 'save-slot':
        if (slot) void this.handleSaveSlot(slot, false);
        break;
      case 'confirm-overwrite':
        if (slot) {
          this.modalPendingOverwrite = null;
          void this.handleSaveSlot(slot, true);
        }
        break;
      case 'cancel-overwrite':
        this.modalPendingOverwrite = null;
        this.renderModal();
        break;
      case 'load-slot':
        if (slot) void this.handleLoadSlot(slot);
        break;
      case 'request-delete':
        if (slot) {
          this.modalPendingDelete = slot;
          this.renderModal();
        }
        break;
      case 'cancel-delete':
        this.modalPendingDelete = null;
        this.renderModal();
        break;
      case 'confirm-delete':
        if (slot) void this.handleDeleteSlot(slot);
        break;
      case 'request-reset':
        this.modalConfirmReset = true;
        this.renderModal();
        break;
      case 'cancel-reset':
        this.modalConfirmReset = false;
        this.renderModal();
        break;
      case 'confirm-reset':
        this.resetSavePending = true;
        this.resetSaveStamp = this.store.lastSavedAt;
        this.store.resetWorld();
        this.closeModal();
        break;
      case 'close-modal':
        this.closeModal();
        break;
      case 'copy-modal':
        void this.copyModalText();
        break;
      default:
        break;
    }
  }

  private scrollRightToCompany(): void {
    if (!this.rightScroll) return;
    window.requestAnimationFrame(() => {
      const panel = this.rightScroll?.querySelector<HTMLElement>('#company-panel');
      if (!panel || !this.rightScroll) return;
      this.rightScroll.scrollTo({
        top: Math.max(0, panel.offsetTop - 4),
        behavior: 'smooth',
      });
      panel.classList.remove('is-revealed');
      void panel.offsetWidth;
      panel.classList.add('is-revealed');
    });
  }

  // ---------------------------------------------------------------- 模态框

  private buildModalState(): ModalState {
    return {
      kind: this.modalKind ?? 'save',
      slots: this.modalSlots,
      busy: this.modalBusy,
      pendingDelete: this.modalPendingDelete,
      pendingOverwrite: this.modalPendingOverwrite,
      confirmReset: this.modalConfirmReset,
      notice: this.modalNotice,
      error: this.modalError,
      copyLabel: this.modalCopyLabel,
    };
  }

  private async openModal(kind: ModalKind): Promise<void> {
    if (!this.modalKind) {
      const origin = document.activeElement as HTMLElement | null;
      this.lastFocused = origin;
      this.lastFocusedTestId =
        origin?.closest<HTMLElement>('[data-testid]')?.dataset.testid ?? null;
    }
    this.modalKind = kind;
    this.modalSlots = null;
    this.modalBusy = null;
    this.modalPendingDelete = null;
    this.modalPendingOverwrite = null;
    this.modalConfirmReset = false;
    this.modalNotice = null;
    this.modalError = null;
    this.modalCopyLabel = null;
    this.modalToken += 1;
    const token = this.modalToken;
    this.renderModal(true);

    if (kind === 'save' || kind === 'load') {
      const slots = await this.store.listSlots();
      if (this.modalToken !== token || this.modalKind !== kind) return;
      this.modalSlots = slots;
      this.renderModal();
    }
    window.requestAnimationFrame(() => {
      this.modalHost?.querySelector<HTMLElement>('.modal')?.focus({ preventScroll: true });
    });
  }

  private renderModal(resetScroll = false): void {
    if (!this.modalHost) return;
    if (!this.modalKind) {
      this.modalHost.hidden = true;
      this.modalHost.innerHTML = '';
      return;
    }
    const activeKey = this.captureFocusKey();
    const previousScroll = resetScroll
      ? 0
      : this.modalHost.querySelector<HTMLElement>('.modal-body')?.scrollTop ?? 0;
    this.modalHost.hidden = false;
    this.modalHost.innerHTML = renderModal(this.store, this.buildModalState());
    const body = this.modalHost.querySelector<HTMLElement>('.modal-body');
    if (body) body.scrollTop = previousScroll;
    if (activeKey) {
      this.modalHost
        .querySelector<HTMLElement>(`[data-focus-key="${activeKey}"]`)
        ?.focus({ preventScroll: true });
    }
  }

  private closeModal(): void {
    this.modalToken += 1;
    this.modalKind = null;
    this.modalSlots = null;
    this.modalBusy = null;
    this.modalPendingDelete = null;
    this.modalPendingOverwrite = null;
    this.modalConfirmReset = false;
    this.modalNotice = null;
    this.modalError = null;
    this.modalCopyLabel = null;
    if (this.modalHost) {
      this.modalHost.hidden = true;
      this.modalHost.innerHTML = '';
    }
    if (this.lastFocused?.isConnected) {
      this.lastFocused.focus({ preventScroll: true });
    } else if (this.lastFocusedTestId) {
      const target = document.querySelector<HTMLElement>(
        `[data-testid="${this.lastFocusedTestId}"]`,
      );
      target?.focus({ preventScroll: true });
    }
    this.lastFocused = null;
    this.lastFocusedTestId = null;
  }

  private async handleSaveSlot(slot: string, force: boolean): Promise<void> {
    if (this.modalBusy) return;
    const info = this.modalSlots?.find((entry) => entry.slot === slot);
    if (!force && info?.exists) {
      this.modalPendingOverwrite = slot;
      this.modalPendingDelete = null;
      this.renderModal();
      return;
    }
    this.modalBusy = slot;
    this.modalPendingOverwrite = null;
    this.modalNotice = null;
    this.modalError = null;
    this.renderModal();
    const ok = await this.store.saveSlot(slot);
    this.modalBusy = null;
    if (this.modalKind !== 'save' && this.modalKind !== 'load') return;
    if (ok) {
      this.modalNotice = `已写入 ${info?.label ?? slot}。`;
    } else {
      this.modalError = '保存失败；原存档未被修改。详情见右上角提示。';
    }
    this.modalSlots = await this.store.listSlots();
    if (this.modalKind) this.renderModal();
  }

  private async handleLoadSlot(slot: string): Promise<void> {
    if (this.modalBusy) return;
    this.modalBusy = slot;
    this.modalNotice = null;
    this.modalError = null;
    this.modalPendingDelete = null;
    this.renderModal();
    const ok = await this.store.loadSlot(slot);
    this.modalBusy = null;
    if (ok) {
      this.resetSavePending = false;
      this.resetSaveStamp = null;
      this.focusCompanyId = null;
      this.closeModal();
      return;
    }
    this.modalError = '读取失败；当前进度未被覆盖。详情见右上角提示。';
    this.modalSlots = await this.store.listSlots();
    if (this.modalKind) this.renderModal();
  }

  private async handleDeleteSlot(slot: string): Promise<void> {
    if (this.modalBusy) return;
    this.modalBusy = slot;
    this.renderModal();
    await this.store.deleteSlot(slot);
    this.modalBusy = null;
    this.modalPendingDelete = null;
    this.modalSlots = await this.store.listSlots();
    if (this.modalKind) this.renderModal();
  }

  private async copyModalText(): Promise<void> {
    const body = this.modalHost?.querySelector<HTMLElement>('.modal-body');
    const text = body?.innerText ?? this.modalHost?.innerText ?? '';
    if (!text.trim()) return;
    const ok = await copyText(text);
    this.modalCopyLabel = ok ? '已复制到剪贴板' : '复制失败，请手动选择文本';
    this.renderModal();
    if (this.modalCopyTimer !== null) window.clearTimeout(this.modalCopyTimer);
    this.modalCopyTimer = window.setTimeout(() => {
      this.modalCopyLabel = null;
      this.modalCopyTimer = null;
      if (this.modalKind) this.renderModal();
    }, 2200);
  }
}

function escapeText(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case "'":
        return '&#39;';
      default:
        return char;
    }
  });
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 回退到 execCommand。
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}
