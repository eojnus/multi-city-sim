// 右侧栏容器：标题 + 标签栏（固定，不随正文滚动）+ 标签正文。
//
// 设计约定：
// - 标签状态只存在 GameUI（UI 层），切换标签不调用 GameStore 命令，不改变模拟状态；
// - 上下文（选中城市/企业/建筑/街区）变化时回到默认「概况」；
// - 渲染全部复用 panels.ts 的 section 函数，这里只做分组，不复制业务计算。

import type { GameStore } from '../../app/gameStore';
import { resolveRightContext, renderRightBody, renderRightHead } from './shared';
import type { RightContext } from './shared';
import type { RightContextKind } from './tabs';
import { resolveRightTab } from './tabs';

export interface RightPanelUiState {
  /** UI 层保存的当前标签，例如 overview / population / stocks。 */
  tab: string;
  /** UI 层聚焦的企业（区域视图点击企业，或城市视图点击企业行）。 */
  focusCompanyId: string | null;
  showAllGoods: boolean;
  /** 上一次渲染的上下文键；用于判断是否需要重置标签。 */
  previousContextKey?: string | null;
}

export interface RightPanelParts {
  context: RightContextKind;
  contextKey: string;
  tab: string;
  /** 固定头部（标题 + 标签栏）。 */
  headHtml: string;
  /** 可滚动正文。 */
  bodyHtml: string;
}

export function renderRightPanelParts(
  store: GameStore,
  state: RightPanelUiState,
): RightPanelParts {
  const context: RightContext = resolveRightContext(store, state);
  const tab = resolveRightTab(
    context.kind,
    state.tab,
    state.previousContextKey ?? null,
    context.key,
  );
  return {
    context: context.kind,
    contextKey: context.key,
    tab,
    headHtml: renderRightHead(context, tab),
    bodyHtml: renderRightBody(store, context, tab, state.showAllGoods),
  };
}

/** 测试与旧代码使用的整块 HTML：容器 + 头部 + 正文。 */
export function renderRightPanel(store: GameStore, state: RightPanelUiState): string {
  const parts = renderRightPanelParts(store, state);
  return `<div class="right-panel" data-testid="right-panel" data-context="${parts.context}">
    ${parts.headHtml}
    ${parts.bodyHtml}
  </div>`;
}

export type { RightContext, RightPanelUiState as RightPanelState } from './shared';
export { renderRightHead, renderRightBody, resolveRightContext } from './shared';
export * from './tabs';
