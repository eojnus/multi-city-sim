// 通知中心：顶部 HUD 下方的一个小图标 + 可拖动的通知窗口。
// 组件自己管理开合、未读标记与窗口位置，不依赖任何外部 UI 框架。
import { esc } from './format';

export interface NotificationItem {
  id: string;
  title: string;
  body: string;
  tickLabel: string;
  kind: 'dividend' | 'vote' | 'major' | 'agreement' | 'market' | string;
  priority: 'normal' | 'important';
  read: boolean;
  /** 例如 "个人" / "岚港食品厂" / "岚港 · 市长事务"。 */
  audienceLabel: string;
}

export interface SystemNotice {
  id: string;
  tone: 'info' | 'warning' | 'error';
  text: string;
}

const BELL_ICON = `
  <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
    <path d="M12 3.4a5.5 5.5 0 0 0-5.5 5.5v3.5L4.9 15.2h14.2l-1.6-2.8V8.9A5.5 5.5 0 0 0 12 3.4Z"
      fill="none" stroke="currentColor" stroke-width="1.55" stroke-linejoin="round" />
    <path d="M9.7 18a2.4 2.4 0 0 0 4.6 0" fill="none" stroke="currentColor"
      stroke-width="1.55" stroke-linecap="round" />
  </svg>`;

const KIND_GLYPHS: Record<string, string> = {
  dividend: '¥',
  vote: '◇',
  major: '!',
  agreement: '⇄',
  market: '↗',
};

const TONE_GLYPHS: Record<SystemNotice['tone'], string> = {
  info: 'i',
  warning: '!',
  error: '×',
};

let instanceSeq = 0;

function need<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`通知中心缺少元素：${selector}`);
  return element;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function glyphFor(kind: string): string {
  return KIND_GLYPHS[kind] ?? '•';
}

function badgeText(unread: number): string {
  return unread > 99 ? '99+' : String(unread);
}

/** 未读优先；同一状态内按时间标签倒序（假定 tickLabel 可排序，例如 "1924.03"）。 */
function sortItems(items: NotificationItem[]): NotificationItem[] {
  return [...items].sort((a, b) => {
    if (a.read !== b.read) return a.read ? 1 : -1;
    return b.tickLabel.localeCompare(a.tickLabel, 'zh-CN', { numeric: true });
  });
}

export class NotificationCenter {
  private readonly host: HTMLElement;
  private readonly root: HTMLElement;
  private readonly windowEl: HTMLElement;
  private readonly headEl: HTMLElement;
  private readonly titleEl: HTMLElement;
  private readonly countEl: HTMLElement;
  private readonly noticesEl: HTMLElement;
  private readonly listEl: HTMLUListElement;
  private readonly toggleBtn: HTMLButtonElement;
  private readonly badgeEl: HTMLElement;
  private readonly dotEl: HTMLElement;
  private readonly liveEl: HTMLElement;
  private readonly allReadBtn: HTMLButtonElement;
  private readonly closeBtn: HTMLButtonElement;
  private readonly titleId: string;
  private readonly windowId: string;

  private items: NotificationItem[] = [];
  private notices: SystemNotice[] = [];
  private openState = false;
  private position: { left: number; top: number } | null = null;
  private dragging = false;
  private dragPointer: number | null = null;
  private dragOffset = { x: 0, y: 0 };
  private readHandler: ((id: string) => void) | null = null;
  private allReadHandler: (() => void) | null = null;
  private announced = 0;
  private hasAnnounced = false;

  constructor(host: HTMLElement) {
    this.host = host;
    instanceSeq += 1;
    this.titleId = `notif-title-${instanceSeq}`;
    this.windowId = `notif-window-${instanceSeq}`;

    this.root = document.createElement('div');
    this.root.className = 'notif-center';
    this.root.innerHTML = this.template();

    this.windowEl = need<HTMLElement>(this.root, '.notif-window');
    this.headEl = need<HTMLElement>(this.root, '.notif-head');
    this.titleEl = need<HTMLElement>(this.root, '#' + this.titleId);
    this.countEl = need<HTMLElement>(this.root, '.notif-count');
    this.noticesEl = need<HTMLElement>(this.root, '.notif-notices');
    this.listEl = need<HTMLUListElement>(this.root, '.notif-list');
    this.toggleBtn = need<HTMLButtonElement>(this.root, '.notif-toggle');
    this.badgeEl = need<HTMLElement>(this.root, '.notif-badge');
    this.dotEl = need<HTMLElement>(this.root, '.notif-alert-dot');
    this.liveEl = need<HTMLElement>(this.root, '.notif-live');
    this.allReadBtn = need<HTMLButtonElement>(this.root, '.notif-allread');
    this.closeBtn = need<HTMLButtonElement>(this.root, '.notif-close');

    host.classList.add('notif-dock');
    host.replaceChildren(this.root);

    this.bind();
    this.render();
  }

  private template(): string {
    return `
      <button type="button" class="notif-toggle" data-testid="notif-toggle" aria-haspopup="dialog"
        aria-expanded="false" aria-controls="${this.windowId}" aria-label="通知" title="通知">
        <span class="notif-toggle-ico" aria-hidden="true">${BELL_ICON}</span>
        <span class="notif-badge" hidden></span>
        <span class="notif-alert-dot" hidden></span>
      </button>
      <span class="notif-live" role="status" aria-live="polite"></span>
      <section class="notif-window" id="${this.windowId}" data-testid="notif-window" role="dialog" aria-modal="false"
        aria-labelledby="${this.titleId}" hidden>
        <header class="notif-head">
          <div class="notif-title">
            <h2 id="${this.titleId}" tabindex="-1">通知</h2>
            <span class="notif-count">全部已读</span>
          </div>
          <button type="button" class="notif-allread">全部已读</button>
          <button type="button" class="notif-close" aria-label="关闭通知" title="关闭通知">×</button>
        </header>
        <div class="notif-notices" hidden></div>
        <div class="notif-body">
          <ul class="notif-list" aria-label="通知列表"></ul>
        </div>
      </section>`;
  }

  private bind(): void {
    this.toggleBtn.addEventListener('click', this.onToggleClick);
    this.closeBtn.addEventListener('click', this.onCloseClick);
    this.allReadBtn.addEventListener('click', this.onAllReadClick);
    this.listEl.addEventListener('click', this.onListClick);

    this.headEl.addEventListener('pointerdown', this.onHeadPointerDown);
    this.headEl.addEventListener('pointermove', this.onHeadPointerMove);
    this.headEl.addEventListener('pointerup', this.onHeadPointerUp);
    this.headEl.addEventListener('pointercancel', this.onHeadPointerUp);
    this.headEl.addEventListener('lostpointercapture', this.onHeadPointerUp);

    window.addEventListener('resize', this.onResize);
  }

  // ---------------------------------------------------------------- 公开 API

  setData(items: NotificationItem[], notices: SystemNotice[]): void {
    this.items = items.map((item) => ({ ...item }));
    this.notices = notices.map((notice) => ({ ...notice }));
    this.renderBadge();
    this.renderCount();
    if (this.openState) this.renderContent(this.focusedItemId());
  }

  onMarkRead(cb: (id: string) => void): void {
    this.readHandler = cb;
  }

  onMarkAllRead(cb: () => void): void {
    this.allReadHandler = cb;
  }

  open(): void {
    if (this.openState) return;
    this.openState = true;
    this.renderContent();
    this.windowEl.hidden = false;
    this.ensurePosition();
    this.toggleBtn.setAttribute('aria-expanded', 'true');
    this.root.classList.add('is-open');
    this.titleEl.focus({ preventScroll: true });
    document.addEventListener('keydown', this.onDocumentKeyDown);
    document.addEventListener('pointerdown', this.onDocumentPointerDown, true);
  }

  close(): void {
    this.closeWindow(true);
  }

  isOpen(): boolean {
    return this.openState;
  }

  destroy(): void {
    this.closeWindow(false);
    this.toggleBtn.removeEventListener('click', this.onToggleClick);
    this.closeBtn.removeEventListener('click', this.onCloseClick);
    this.allReadBtn.removeEventListener('click', this.onAllReadClick);
    this.listEl.removeEventListener('click', this.onListClick);
    this.headEl.removeEventListener('pointerdown', this.onHeadPointerDown);
    this.headEl.removeEventListener('pointermove', this.onHeadPointerMove);
    this.headEl.removeEventListener('pointerup', this.onHeadPointerUp);
    this.headEl.removeEventListener('pointercancel', this.onHeadPointerUp);
    this.headEl.removeEventListener('lostpointercapture', this.onHeadPointerUp);
    document.removeEventListener('keydown', this.onDocumentKeyDown);
    document.removeEventListener('pointerdown', this.onDocumentPointerDown, true);
    window.removeEventListener('resize', this.onResize);
    this.root.remove();
    this.host.classList.remove('notif-dock');
    this.items = [];
    this.notices = [];
    this.readHandler = null;
    this.allReadHandler = null;
  }

  // ---------------------------------------------------------------- 渲染

  private render(): void {
    this.renderBadge();
    this.renderCount();
    this.renderContent();
  }

  private unreadCount(): number {
    return this.items.reduce((total, item) => total + (item.read ? 0 : 1), 0);
  }

  private renderBadge(): void {
    const unread = this.unreadCount();
    const hasNotices = this.notices.length > 0;
    const hasAny = this.items.length > 0 || hasNotices;

    this.badgeEl.hidden = unread <= 0;
    this.badgeEl.textContent = badgeText(unread);
    this.dotEl.hidden = !(unread === 0 && hasNotices);
    this.root.classList.toggle('is-quiet', !hasAny && unread === 0);
    this.toggleBtn.setAttribute(
      'aria-label',
      unread > 0 ? `通知，${unread} 条未读` : hasAny ? '通知，暂无未读' : '通知，暂无消息',
    );

    if (this.hasAnnounced && this.announced !== unread) {
      this.liveEl.textContent = unread > 0 ? `${unread} 条未读通知` : '通知已全部读完';
    }
    this.announced = unread;
    this.hasAnnounced = true;
  }

  private renderCount(): void {
    const unread = this.unreadCount();
    this.countEl.textContent = unread > 0 ? `${unread} 条未读` : '没有未读';
    this.allReadBtn.disabled = unread === 0;
  }

  private renderContent(focusItemId: string | null = null): void {
    const items = sortItems(this.items);
    this.listEl.innerHTML =
      items.length === 0
        ? `<li class="notif-empty">
            <b>暂时没有需要你处理的消息</b>
            <span>新的分红、表决与重大变化会出现在这里。</span>
          </li>`
        : items.map((item) => this.itemMarkup(item)).join('');

    this.noticesEl.hidden = this.notices.length === 0;
    this.noticesEl.innerHTML = this.notices
      .map(
        (notice) => `
          <div class="notif-notice is-${esc(notice.tone)}">
            <span class="notif-notice-ico" aria-hidden="true">${esc(TONE_GLYPHS[notice.tone] ?? 'i')}</span>
            <span class="notif-notice-text">${esc(notice.text)}</span>
          </div>`,
      )
      .join('');

    if (focusItemId) {
      const button = this.itemButton(focusItemId);
      if (button) button.focus({ preventScroll: true });
      else this.titleEl.focus({ preventScroll: true });
    }
  }

  private itemMarkup(item: NotificationItem): string {
    const unread = !item.read;
    const important = item.priority === 'important';
    return `
      <li>
        <button type="button" data-notif-id="${esc(item.id)}" data-kind="${esc(item.kind)}"
          class="notif-item ${unread ? 'is-unread' : 'is-read'} ${important ? 'is-important' : ''}">
          <span class="notif-item-top">
            <span class="notif-item-glyph" aria-hidden="true">${esc(glyphFor(item.kind))}</span>
            <span class="notif-item-title">${esc(item.title)}${
              unread ? '<span class="notif-sr" data-notif-unread>（未读）</span>' : ''
            }</span>
            ${important ? '<span class="notif-item-flag">重要</span>' : ''}
            ${unread ? '<span class="notif-item-dot" aria-hidden="true"></span>' : ''}
          </span>
          <span class="notif-item-body">${esc(item.body)}</span>
          <span class="notif-item-meta">
            <span>${esc(item.tickLabel)}</span>
            <span aria-hidden="true">·</span>
            <span>${esc(item.audienceLabel)}</span>
          </span>
        </button>
      </li>`;
  }

  private itemButton(id: string): HTMLElement | null {
    for (const button of this.listEl.querySelectorAll<HTMLElement>('[data-notif-id]')) {
      if (button.dataset.notifId === id) return button;
    }
    return null;
  }

  private focusedItemId(): string | null {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !this.windowEl.contains(active)) return null;
    return active.closest<HTMLElement>('[data-notif-id]')?.dataset.notifId ?? null;
  }

  // ---------------------------------------------------------------- 标记已读

  private markRead(id: string): void {
    const item = this.items.find((entry) => entry.id === id);
    if (!item || item.read) return;
    item.read = true;

    // 就地更新，避免列表因重新排序而跳动、焦点丢失。
    const button = this.itemButton(id);
    if (button) {
      button.classList.remove('is-unread');
      button.classList.add('is-read');
      button.querySelector('[data-notif-unread]')?.remove();
      button.querySelector('.notif-item-dot')?.remove();
    }

    this.renderBadge();
    this.renderCount();
    this.readHandler?.(id);
  }

  private markAllRead(): void {
    if (this.unreadCount() === 0) return;
    for (const item of this.items) item.read = true;
    this.renderBadge();
    this.renderCount();
    this.renderContent(this.focusedItemId());
    this.allReadHandler?.();
  }

  // ---------------------------------------------------------------- 开合

  private closeWindow(restoreFocus: boolean): void {
    if (!this.openState) return;
    const hadFocus = this.windowEl.contains(document.activeElement);
    this.openState = false;
    this.windowEl.hidden = true;
    this.toggleBtn.setAttribute('aria-expanded', 'false');
    this.root.classList.remove('is-open');
    if (this.dragPointer !== null && this.headEl.hasPointerCapture(this.dragPointer)) {
      this.headEl.releasePointerCapture(this.dragPointer);
    }
    this.dragging = false;
    this.dragPointer = null;
    this.windowEl.classList.remove('is-dragging');
    document.removeEventListener('keydown', this.onDocumentKeyDown);
    document.removeEventListener('pointerdown', this.onDocumentPointerDown, true);
    if (restoreFocus && hadFocus) this.toggleBtn.focus({ preventScroll: true });
  }

  private ensurePosition(): void {
    const margin = 8;
    const width = this.windowEl.offsetWidth || 360;
    const height = this.windowEl.offsetHeight || 320;
    const maxLeft = Math.max(margin, window.innerWidth - width - margin);
    const maxTop = Math.max(margin, window.innerHeight - height - margin);

    if (this.position) {
      this.position = {
        left: clamp(this.position.left, margin, maxLeft),
        top: clamp(this.position.top, margin, maxTop),
      };
    } else {
      const button = this.toggleBtn.getBoundingClientRect();
      let top = button.bottom + 8;
      if (top + height > window.innerHeight - margin) {
        top = button.top - height - 8;
      }
      this.position = {
        left: clamp(button.right - width, margin, maxLeft),
        top: clamp(top, margin, maxTop),
      };
    }
    this.applyPosition();
  }

  private applyPosition(): void {
    if (!this.position) return;
    this.windowEl.style.left = `${Math.round(this.position.left)}px`;
    this.windowEl.style.top = `${Math.round(this.position.top)}px`;
  }

  // ---------------------------------------------------------------- 焦点与键盘

  private focusableElements(): HTMLElement[] {
    return Array.from(
      this.windowEl.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      ),
    );
  }

  private trapFocus(event: KeyboardEvent): void {
    if (!this.windowEl.contains(document.activeElement)) {
      event.preventDefault();
      this.titleEl.focus({ preventScroll: true });
      return;
    }
    const focusables = this.focusableElements();
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (!first || !last) {
      event.preventDefault();
      this.titleEl.focus({ preventScroll: true });
      return;
    }
    if (event.shiftKey && (document.activeElement === first || document.activeElement === this.titleEl)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  // ---------------------------------------------------------------- 事件

  private readonly onToggleClick = (): void => {
    if (this.openState) this.close();
    else this.open();
  };

  private readonly onCloseClick = (): void => {
    this.close();
  };

  private readonly onAllReadClick = (): void => {
    this.markAllRead();
  };

  private readonly onListClick = (event: MouseEvent): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest<HTMLElement>('[data-notif-id]');
    if (!button || !this.listEl.contains(button)) return;
    const id = button.dataset.notifId;
    if (id) this.markRead(id);
  };

  private readonly onDocumentPointerDown = (event: PointerEvent): void => {
    if (!this.openState) return;
    if (event.target instanceof Node && this.root.contains(event.target)) return;
    this.closeWindow(false);
  };

  private readonly onDocumentKeyDown = (event: KeyboardEvent): void => {
    if (!this.openState) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.close();
      return;
    }
    if (event.key === 'Tab') this.trapFocus(event);
  };

  private readonly onResize = (): void => {
    if (this.openState) this.ensurePosition();
  };

  private readonly onHeadPointerDown = (event: PointerEvent): void => {
    if (!this.openState || event.button !== 0) return;
    if (event.target instanceof Element && event.target.closest('button')) return;
    event.preventDefault();

    const rect = this.windowEl.getBoundingClientRect();
    this.dragOffset = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    this.dragging = true;
    this.dragPointer = event.pointerId;
    this.windowEl.classList.add('is-dragging');
    this.headEl.setPointerCapture(event.pointerId);
  };

  private readonly onHeadPointerMove = (event: PointerEvent): void => {
    if (!this.dragging || this.dragPointer !== event.pointerId) return;
    event.preventDefault();
    const width = this.windowEl.offsetWidth;
    const height = this.windowEl.offsetHeight;
    this.position = {
      left: clamp(event.clientX - this.dragOffset.x, 8, Math.max(8, window.innerWidth - width - 8)),
      top: clamp(event.clientY - this.dragOffset.y, 8, Math.max(8, window.innerHeight - height - 8)),
    };
    this.applyPosition();
  };

  private readonly onHeadPointerUp = (event: PointerEvent): void => {
    if (!this.dragging || this.dragPointer !== event.pointerId) return;
    this.dragging = false;
    this.dragPointer = null;
    this.windowEl.classList.remove('is-dragging');
    if (this.headEl.hasPointerCapture(event.pointerId)) {
      this.headEl.releasePointerCapture(event.pointerId);
    }
  };
}
