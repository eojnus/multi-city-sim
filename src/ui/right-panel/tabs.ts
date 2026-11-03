// 右侧栏标签定义与状态机。
//
// 标签只是 UI 视图状态：切换标签不会调用 GameStore 的任何命令，也不会改变模拟状态。
// GameUI 只保存「当前上下文 + 当前标签」两个字段；上下文变化时由 resolveRightTab 决定保留还是回到默认标签。

export type RightContextKind = 'city' | 'company' | 'building' | 'district';

export interface RightTabDefinition {
  /** 稳定的标签 id（写入 data-tab，测试与键盘导航都依赖它）。 */
  id: string;
  label: string;
  /** 悬停说明：标签里放什么。 */
  hint: string;
}

export const DEFAULT_RIGHT_TAB = 'overview';

/** 城市标签：区域视图与城市视图共用。 */
export const CITY_TABS: readonly RightTabDefinition[] = [
  { id: 'overview', label: '概况', hint: '城市身份、关键指标与 GDP 轨迹' },
  { id: 'population', label: '人口', hint: '人口结构、财富阶层、职业群体与人才市场' },
  { id: 'companies', label: '企业', hint: '主要企业、创办与退出记录' },
  { id: 'market', label: '市场', hint: '市场快照、银行、债券与贸易协议' },
  { id: 'government', label: '政府', hint: '政策、财政、税收与科技/政治/房地产' },
  { id: 'transport', label: '交通', hint: '城内交通网络与跨城线路' },
] as const;

/** 企业标签：经营者、财务、股东治理与股票分开，避免单栏过长。 */
export const COMPANY_TABS: readonly RightTabDefinition[] = [
  { id: 'overview', label: '概况', hint: '企业身份、现金、债务与产能' },
  { id: 'operation', label: '经营', hint: '自动经营计划与经营者/授权/提案' },
  { id: 'finance', label: '财务', hint: '上月损益、岗位分布、库存与注资' },
  { id: 'governance', label: '股东与治理', hint: '股权结构、董事会与议案表决' },
  { id: 'stocks', label: '股票', hint: '二级市场挂单、买卖与股票大窗口入口' },
] as const;

/** 建筑：建筑本身 + 关联企业（若有）。 */
export const BUILDING_TABS: readonly RightTabDefinition[] = [
  { id: 'overview', label: '概况', hint: '建筑层数、户数、岗位与租金' },
  { id: 'related', label: '相关主体', hint: '该建筑内的企业详情' },
] as const;

/** 街区：街区概况 + 街区内的企业入口。 */
export const DISTRICT_TABS: readonly RightTabDefinition[] = [
  { id: 'overview', label: '概况', hint: '人口/岗位占比、地价与建筑列表' },
  { id: 'related', label: '相关主体', hint: '街区内的企业' },
] as const;

export function tabsForContext(kind: RightContextKind): readonly RightTabDefinition[] {
  switch (kind) {
    case 'company':
      return COMPANY_TABS;
    case 'building':
      return BUILDING_TABS;
    case 'district':
      return DISTRICT_TABS;
    case 'city':
    default:
      return CITY_TABS;
  }
}

export function tabIdsForContext(kind: RightContextKind): string[] {
  return tabsForContext(kind).map((tab) => tab.id);
}

export function isValidTab(kind: RightContextKind, tab: string | null | undefined): boolean {
  return typeof tab === 'string' && tabIdsForContext(kind).includes(tab);
}

/**
 * 标签状态机：给定上下文与上一轮的上下文键，决定本轮应显示的标签。
 * - 上下文变化（选中城市/企业/建筑/街区改变）→ 回到默认「概况」，避免停留在无意义的旧标签；
 * - 上下文不变但标签已不适用（例如从城市切到企业）→ 回到默认；
 * - 其余情况保留玩家选择。
 */
export function resolveRightTab(
  kind: RightContextKind,
  requested: string | null | undefined,
  previousContextKey: string | null,
  nextContextKey: string,
): string {
  if (previousContextKey !== nextContextKey) return DEFAULT_RIGHT_TAB;
  return isValidTab(kind, requested) ? (requested as string) : DEFAULT_RIGHT_TAB;
}

/** 渲染标签栏（ARIA tabs 模式；原生 button 支持 Tab 聚焦与 Enter/空格切换）。 */
export function renderRightTabBar(
  kind: RightContextKind,
  activeTab: string,
  contextKey: string,
): string {
  const tabs = tabsForContext(kind);
  return `
    <div class="rp-tabs" role="tablist" aria-label="右侧栏内容标签" data-testid="right-tabs" data-context="${kind}">
      ${tabs
        .map((tab) => {
          const selected = tab.id === activeTab;
          return `<button
            type="button"
            role="tab"
            class="rp-tab ${selected ? 'is-active' : ''}"
            id="right-tab-${kind}-${tab.id}"
            data-action="right-tab"
            data-tab="${tab.id}"
            data-focus-key="right-tab-${tab.id}"
            aria-selected="${selected}"
            aria-controls="right-tabpanel"
            tabindex="0"
            title="${tab.hint}"
          >${tab.label}</button>`;
        })
        .join('')}
      <span class="rp-tabs-meta" title="标签切换只改变右侧栏视图，不会推进时间或改变选择">${tabs.length} 个标签</span>
    </div>`;
}
