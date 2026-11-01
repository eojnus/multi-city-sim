// 人口结构环形图：纯 SVG donut，无 canvas、无第三方图表库。
// renderPopulationPie 只输出 HTML 字符串；悬停 / 聚焦交互由 bindPieInteractions
// 以事件委托方式接管，调用方在插入 innerHTML 后调用一次并保存返回的清理函数。
import { esc } from '../format';

export interface PieSegment {
  id: string;
  label: string;
  value: number;
  color: string;
}

export interface PieInput {
  /** 互斥口径（就业 / 失业 / 非劳动力），由调用方保证。 */
  segments: PieSegment[];
  /** 互斥口径合计；为 0 时绘制空环。 */
  total: number;
  /** 中心大数字，例如 "12.0 万"。 */
  centerLabel: string;
  /** 中心说明，例如 "总人口"。 */
  centerCaption: string;
  ariaLabel: string;
  /** 口径说明，例如 "就业 + 失业 + 非劳动力 = 总人口"。 */
  note?: string;
}

export const POPULATION_PIE_COLORS = {
  employed: '#5fe3c0',
  unemployed: '#f2c14e',
  nonLabor: '#6f8bb5',
} as const;

const SVG_SIZE = 200;
const CENTER = SVG_SIZE / 2;
const RADIUS = 70;
/** 2.6 个用户单位 ≈ 环形周长（约 440）上的 2px，换算到 pathLength=100 的约 0.6。 */
const GAP_UNITS = 0.6;
/** 悬停时沿角平分线外移的距离（SVG 用户单位；132–158px 下约 4.6–5.5 屏幕像素）。 */
const HOVER_OFFSET = 7;

interface PieGeometry {
  length: number;
  offset: number;
}

/**
 * 上一次渲染的扇区几何，用于 @starting-style 的补间起点。
 * 面板整块重绘时 DOM 会被替换，但这里仍能让新节点从上一帧的弧长平滑过渡；
 * 数据未变化时起点与终点一致，不会重复播放动画。
 */
const GEOMETRY_CACHE = new Map<string, PieGeometry>();
const GEOMETRY_LIMIT = 120;

function rememberGeometry(key: string, geometry: PieGeometry): void {
  GEOMETRY_CACHE.delete(key);
  GEOMETRY_CACHE.set(key, geometry);
  if (GEOMETRY_CACHE.size > GEOMETRY_LIMIT) {
    const oldest = GEOMETRY_CACHE.keys().next();
    if (!oldest.done) GEOMETRY_CACHE.delete(oldest.value);
  }
}

const INT_FORMAT = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 });

function formatInt(value: number): string {
  return INT_FORMAT.format(Math.max(0, value));
}

function formatShare(value: number, total: number): string {
  if (!(total > 0)) return '—';
  const share = Math.min(100, Math.max(0, (value / total) * 100));
  return `${share.toFixed(1)}%`;
}

export function renderPopulationPie(input: PieInput): string {
  const total = Number.isFinite(input.total) && input.total > 0 ? input.total : 0;
  const empty = total <= 0;
  const rows = input.segments.map((segment) => ({
    segment,
    value: Number.isFinite(segment.value) && segment.value > 0 ? segment.value : 0,
  }));

  let cursor = 0;
  const slices: string[] = [];

  for (const { segment, value } of rows) {
    if (total <= 0 || value <= 0) continue;
    const share = Math.min((value / total) * 100, Math.max(0, 100 - cursor));
    if (share <= 0) continue;

    const length = Math.max(share - GAP_UNITS, 0.3);
    const offset = -cursor;
    // pathLength=100 下，0 位于 3 点方向；外层分组统一旋转 -90° 到 12 点。
    const angle = ((cursor + share / 2) / 100) * Math.PI * 2;
    const tx = (Math.cos(angle) * HOVER_OFFSET).toFixed(2);
    const ty = (Math.sin(angle) * HOVER_OFFSET).toFixed(2);
    const shareLabel = formatShare(value, total);
    const aria = `${segment.label} ${formatInt(value)} 人，占 ${shareLabel}`;

    // 起点：同口径上一次的弧长；首次出现时从 0 展开。终点写入属性，由 CSS transition 补间。
    const cacheKey = `${input.ariaLabel}|${segment.id}`;
    const previous = GEOMETRY_CACHE.get(cacheKey);
    const startDash = previous
      ? `${previous.length.toFixed(2)} ${(100 - previous.length).toFixed(2)}`
      : '0 100';
    const startOffset = previous ? previous.offset.toFixed(2) : offset.toFixed(2);

    slices.push(
      `<circle class="pop-pie-seg" ` +
        `cx="${CENTER}" cy="${CENTER}" r="${RADIUS}" ` +
        `pathLength="100" fill="none" stroke="${esc(segment.color)}" stroke-width="26" ` +
        `stroke-dasharray="${length.toFixed(2)} ${(100 - length).toFixed(2)}" ` +
        `stroke-dashoffset="${offset.toFixed(2)}" ` +
        `data-pop-pie-seg="${esc(segment.id)}" ` +
        `data-pop-pie-label="${esc(segment.label)}" ` +
        `data-pop-pie-value="${esc(formatInt(value))}" ` +
        `data-pop-pie-share="${esc(shareLabel)}" ` +
        `style="--pop-tx:${tx}px;--pop-ty:${ty}px;--pop-start-dash:${startDash};--pop-start-offset:${startOffset}" ` +
        `tabindex="0" role="img" aria-label="${esc(aria)}" />`,
    );

    rememberGeometry(cacheKey, { length, offset });
    cursor += share;
  }

  const legend = rows
    .map(
      ({ segment, value }) => `
        <li class="pop-pie-row" style="--seg-color:${esc(segment.color)}">
          <span class="pop-pie-swatch" aria-hidden="true"></span>
          <span class="pop-pie-row-main">
            <b>${esc(segment.label)}</b>
            <small>${formatInt(value)} 人</small>
          </span>
          <span class="pop-pie-row-share">${formatShare(value, total)}</span>
        </li>`,
    )
    .join('');

  const centerText = empty ? '暂无数据' : input.centerLabel;
  const centerCaption = !empty && input.centerCaption ? input.centerCaption : '';
  const note = input.note ? `<p class="pop-pie-note">${esc(input.note)}</p>` : '';
  let svgLabel = input.ariaLabel;
  if (empty && !svgLabel.includes('暂无')) svgLabel = `${svgLabel}，暂无数据`;

  return `
    <div class="pop-pie${empty ? ' is-empty' : ''}" data-pop-pie>
      <div class="pop-pie-plot">
        <svg class="pop-pie-svg" viewBox="0 0 ${SVG_SIZE} ${SVG_SIZE}" role="group" aria-label="${esc(svgLabel)}">
          <circle class="pop-pie-track" cx="${CENTER}" cy="${CENTER}" r="${RADIUS}" pathLength="100" />
          <circle class="pop-pie-hairline" cx="${CENTER}" cy="${CENTER}" r="53" />
          <g transform="rotate(-90 ${CENTER} ${CENTER})">
            ${slices.join('')}
          </g>
        </svg>
        <div class="pop-pie-center" aria-hidden="true">
          <b>${esc(centerText)}</b>
          ${centerCaption ? `<span>${esc(centerCaption)}</span>` : ''}
        </div>
      </div>
      <ul class="pop-pie-legend" aria-label="人口构成图例">${legend}
      </ul>
      <div class="pop-pie-tip" role="tooltip" aria-hidden="true">
        <b data-pop-pie-tip-label></b>
        <span class="pop-pie-tip-line">
          <span data-pop-pie-tip-value></span>
          <em data-pop-pie-tip-share></em>
        </span>
      </div>
      ${note}
    </div>`;
}

function sliceFrom(target: EventTarget | null): Element | null {
  if (!(target instanceof Element)) return null;
  return target.closest('[data-pop-pie-seg]');
}

function inside(element: Element, target: EventTarget | null): boolean {
  return target instanceof Node && element.contains(target);
}

function hideTips(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>('.pop-pie-tip.is-on').forEach((tip) => {
    tip.classList.remove('is-on');
  });
}

function positionTip(wrapper: HTMLElement, tip: HTMLElement, x: number, y: number): void {
  const wrapRect = wrapper.getBoundingClientRect();
  const tipRect = tip.getBoundingClientRect();
  const pad = 6;
  const half = tipRect.width / 2;

  const minLeft = Math.min(half + pad, wrapRect.width / 2);
  const maxLeft = Math.max(minLeft, wrapRect.width - half - pad);
  const minTop = Math.min(tipRect.height + pad + 8, wrapRect.height);
  const maxTop = Math.max(minTop, wrapRect.height - pad);

  const left = Math.min(Math.max(x - wrapRect.left, minLeft), maxLeft);
  const top = Math.min(Math.max(y - wrapRect.top, minTop), maxTop);

  tip.style.left = `${left.toFixed(1)}px`;
  tip.style.top = `${top.toFixed(1)}px`;
}

function showTipAt(slice: Element, point: { x: number; y: number }): void {
  const wrapper = slice.closest('.pop-pie');
  if (!(wrapper instanceof HTMLElement)) return;
  const tip = wrapper.querySelector<HTMLElement>('.pop-pie-tip');
  if (!tip) return;

  const label = tip.querySelector<HTMLElement>('[data-pop-pie-tip-label]');
  const value = tip.querySelector<HTMLElement>('[data-pop-pie-tip-value]');
  const share = tip.querySelector<HTMLElement>('[data-pop-pie-tip-share]');
  if (label) label.textContent = slice.getAttribute('data-pop-pie-label') ?? '';
  if (value) value.textContent = `${slice.getAttribute('data-pop-pie-value') ?? '0'} 人`;
  if (share) share.textContent = slice.getAttribute('data-pop-pie-share') ?? '';

  // 先显示再量尺寸，保证 tooltip 宽度参与边界收拢。
  tip.classList.add('is-on');
  positionTip(wrapper, tip, point.x, point.y);
}

/**
 * 在插入 innerHTML 之后调用一次，接管某个容器内所有饼图的悬停 / 键盘提示。
 * 返回清理函数；不依赖模块级单例，可安全地重复绑定到新 DOM。
 */
export function bindPieInteractions(root: HTMLElement): () => void {
  let pointerSlice: Element | null = null;
  let focusSlice: Element | null = null;
  let lastPointer: { x: number; y: number } | null = null;
  let focusMode = false;

  const activeSlice = (): Element | null =>
    focusMode ? focusSlice ?? pointerSlice : pointerSlice ?? focusSlice;

  const sync = (): void => {
    const active = activeSlice();
    root.querySelectorAll<Element>('.pop-pie-seg.is-hot').forEach((segment) => {
      if (segment !== active) segment.classList.remove('is-hot');
    });

    if (!active) {
      hideTips(root);
      return;
    }

    const activeWrapper = active.closest('.pop-pie');
    root.querySelectorAll<HTMLElement>('.pop-pie-tip.is-on').forEach((tip) => {
      if (tip.closest('.pop-pie') !== activeWrapper) tip.classList.remove('is-on');
    });

    active.classList.add('is-hot');
    if (pointerSlice === active && lastPointer) {
      showTipAt(active, lastPointer);
    } else {
      const rect = active.getBoundingClientRect();
      showTipAt(active, { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
    }
  };

  const onPointerOver = (event: PointerEvent): void => {
    const slice = sliceFrom(event.target);
    if (!slice) return;
    pointerSlice = slice;
    focusMode = false;
    lastPointer = { x: event.clientX, y: event.clientY };
    sync();
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (!pointerSlice) return;
    lastPointer = { x: event.clientX, y: event.clientY };
    showTipAt(pointerSlice, lastPointer);
  };

  const onPointerOut = (event: PointerEvent): void => {
    const slice = pointerSlice;
    if (!slice || inside(slice, event.relatedTarget)) return;
    pointerSlice = null;
    if (focusSlice) focusMode = true;
    sync();
  };

  const onFocusIn = (event: FocusEvent): void => {
    const slice = sliceFrom(event.target);
    if (!slice) return;
    // 鼠标点击也会让扇区获得焦点，这里只接管键盘（focus-visible）情形。
    if (!slice.matches(':focus-visible')) return;
    focusSlice = slice;
    focusMode = true;
    sync();
  };

  const onFocusOut = (event: FocusEvent): void => {
    const slice = focusSlice;
    if (!slice || inside(slice, event.relatedTarget)) return;
    focusSlice = null;
    if (pointerSlice) focusMode = false;
    sync();
  };

  root.addEventListener('pointerover', onPointerOver);
  root.addEventListener('pointermove', onPointerMove);
  root.addEventListener('pointerout', onPointerOut);
  root.addEventListener('focusin', onFocusIn);
  root.addEventListener('focusout', onFocusOut);

  return () => {
    root.removeEventListener('pointerover', onPointerOver);
    root.removeEventListener('pointermove', onPointerMove);
    root.removeEventListener('pointerout', onPointerOut);
    root.removeEventListener('focusin', onFocusIn);
    root.removeEventListener('focusout', onFocusOut);
    root.querySelectorAll<Element>('.pop-pie-seg.is-hot').forEach((segment) => {
      segment.classList.remove('is-hot');
    });
    hideTips(root);
    pointerSlice = null;
    focusSlice = null;
    lastPointer = null;
  };
}
