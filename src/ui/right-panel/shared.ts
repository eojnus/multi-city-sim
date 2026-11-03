// 右侧栏共享逻辑：上下文解析、标题/标签头、建筑与街区的「相关主体」正文。

import type { GameStore } from '../../app/gameStore';
import type { City, Company } from '../../simulation/contracts/types';
import type { BuildingDefinition, DistrictDefinition } from '../../data/city-layout';
import { esc, num } from '../format';
import {
  companyRow,
  renderBuildingDetail,
  renderCompanyDetail,
  renderDistrictDetail,
} from '../panels';
import { renderCityTabBody } from './city-tabs';
import { renderCompanyTabBody } from './company-tabs';
import type { RightContextKind } from './tabs';
import { renderRightTabBar } from './tabs';

export type RightContext =
  | { kind: 'city'; city: City | null; inRegion: boolean; key: string }
  | { kind: 'company'; city: City; company: Company; inRegion: boolean; key: string }
  | {
      kind: 'building';
      city: City;
      building: BuildingDefinition;
      company: Company | null;
      key: string;
    }
  | { kind: 'district'; city: City; district: DistrictDefinition; key: string };

export interface RightPanelUiState {
  /** UI 层保存的当前标签（不是 GameStore 状态）。 */
  tab: string;
  focusCompanyId: string | null;
  showAllGoods: boolean;
}

function cityCompany(store: GameStore, city: City, companyId: string | null): Company | null {
  if (!companyId) return null;
  return (
    store.world.companies.find(
      (company) => company.id === companyId && company.cityId === city.id,
    ) ?? null
  );
}

/**
 * 解析右侧栏上下文。优先级：
 * 区域视图聚焦企业 → 企业标签；城市视图选中建筑 → 建筑标签；选中街区 → 街区标签；
 * 其余为城市标签（区域视图或城市视图）。
 */
export function resolveRightContext(store: GameStore, state: RightPanelUiState): RightContext {
  const city = store.selectedCity;
  if (!city) {
    return { kind: 'city', city: null, inRegion: store.view === 'region', key: 'city:none' };
  }
  const focused = cityCompany(store, city, state.focusCompanyId);
  if (focused) {
    return {
      kind: 'company',
      city,
      company: focused,
      inRegion: store.view === 'region',
      key: `company:${city.id}:${focused.id}`,
    };
  }
  if (store.view === 'city') {
    const building = store.selectedBuilding;
    if (building) {
      const company = building.companyId
        ? store.world.companies.find((entry) => entry.id === building.companyId) ?? null
        : null;
      return {
        kind: 'building',
        city,
        building,
        company,
        key: `building:${city.id}:${building.id}`,
      };
    }
    const district = store.selectedDistrict;
    if (district) {
      return {
        kind: 'district',
        city,
        district,
        key: `district:${city.id}:${district.id}`,
      };
    }
  }
  return {
    kind: 'city',
    city,
    inRegion: store.view === 'region',
    key: `city:${city.id}`,
  };
}

const CONTEXT_KICKERS: Record<RightContextKind, string> = {
  city: 'CITY PANEL',
  company: 'COMPANY PANEL',
  building: 'BUILDING PANEL',
  district: 'DISTRICT PANEL',
};

function contextTitle(context: RightContext): { title: string; subtitle: string } {
  switch (context.kind) {
    case 'company':
      return {
        title: context.company.name,
        subtitle: `${context.city.name} · ${context.company.note}`,
      };
    case 'building':
      return {
        title: context.building.name,
        subtitle: `${context.city.name} · 建筑详情${context.company ? ` · ${context.company.name}` : ''}`,
      };
    case 'district':
      return {
        title: context.district.name,
        subtitle: `${context.city.name} · 街区详情`,
      };
    case 'city':
    default:
      return {
        title: context.city ? context.city.name : '请选择一座城市',
        subtitle: context.city ? '城市与企业详情' : '从左侧城市索引中选择，或单击地图上的城市。',
      };
  }
}

/** 标题 + 标签栏（放在右侧栏固定区域，不随正文滚动）。 */
export function renderRightHead(context: RightContext, tab: string): string {
  if (!context.city) return '';
  const { title, subtitle } = contextTitle(context);
  const close =
    context.kind === 'company'
      ? `<button
          type="button"
          class="icon-btn rp-close"
          data-action="close-company"
          data-focus-key="right-close-company"
          aria-label="关闭企业标签"
          title="关闭企业详情，回到城市标签"
        >×</button>`
      : '';
  return `
    <div class="right-panel-head" data-testid="right-panel-head" data-context="${context.kind}">
      <div class="rp-head-row">
        <div class="rp-heading">
          <span class="kicker">${CONTEXT_KICKERS[context.kind]}</span>
          <h2 class="rp-title" data-testid="right-panel-title">${esc(title)}</h2>
          <p class="rp-subtitle" title="${esc(subtitle)}">${esc(subtitle)}</p>
        </div>
        ${close}
      </div>
      ${renderRightTabBar(context.kind, tab, context.key)}
    </div>`;
}

export function renderRightBody(
  store: GameStore,
  context: RightContext,
  tab: string,
  showAllGoods: boolean,
): string {
  if (!context.city) {
    return `
      <div class="empty-state">
        <span class="empty-mark" aria-hidden="true">◎</span>
        <p>请选择一座城市</p>
        <small>从左侧城市索引中选择，或单击地图上的城市。</small>
      </div>`;
  }
  return `<div class="right-tabpanel" role="tabpanel" id="right-tabpanel" aria-labelledby="right-tab-${context.kind}-${tab}" data-testid="right-tabpanel" data-tab="${tab}">
    ${renderTabBody(store, context, tab, showAllGoods)}
  </div>`;
}

function renderTabBody(
  store: GameStore,
  context: RightContext,
  tab: string,
  showAllGoods: boolean,
): string {
  if (!context.city) return '';
  switch (context.kind) {
    case 'city':
      return renderCityTabBody(store, context.city, tab, {
        inRegion: context.inRegion,
        showAllGoods,
      });
    case 'company':
      return renderCompanyTabBody(store, context.company, tab, {
        showClose: context.inRegion,
      });
    case 'building':
      return renderBuildingTabBody(store, context.city, context.building, context.company, tab);
    case 'district':
      return renderDistrictTabBody(store, context.city, context.district, tab);
    default:
      return '';
  }
}

function renderRelatedCompanies(store: GameStore, companies: Company[]): string {
  return `
    <section class="panel-section" data-testid="related-companies">
      <div class="section-head">
        <div>
          <span class="kicker">RELATED COMPANIES</span>
          <h2>相关企业</h2>
        </div>
        <span class="section-tag">${num(companies.length)} 家</span>
      </div>
      ${
        companies.length === 0
          ? `<div class="empty-state compact">
              <span class="empty-mark" aria-hidden="true">▦</span>
              <p>暂无相关企业</p>
              <small>该街区还没有关联企业；可在企业标签中查看更多。</small>
            </div>`
          : `<div class="company-list">${companies
              .map((company) => companyRow(store, company, false))
              .join('')}</div>`
      }
    </section>`;
}

export function renderBuildingTabBody(
  store: GameStore,
  city: City,
  building: BuildingDefinition,
  company: Company | null,
  tab: string,
): string {
  if (tab === 'related') {
    return company
      ? `<div class="related-company" data-testid="building-related-company">
          ${renderCompanyDetail(store, company, { showClose: false, investTestId: false })}
        </div>`
      : `<div class="empty-state compact">
          <span class="empty-mark" aria-hidden="true">▦</span>
          <p>该建筑没有关联企业</p>
          <small>居民建筑或公共建筑不绑定企业主体。</small>
        </div>`;
  }
  return renderBuildingDetail(store, city, building, company, { includeCompany: false });
}

export function renderDistrictTabBody(
  store: GameStore,
  city: City,
  district: DistrictDefinition,
  tab: string,
): string {
  if (tab === 'related') {
    const layout = store.selectedLayout;
    const companyIds = new Set(
      (layout?.buildings ?? [])
        .filter((building) => building.districtId === district.id && building.companyId)
        .map((building) => building.companyId as string),
    );
    const companies = [...companyIds]
      .map((id) => store.world.companies.find((company) => company.id === id) ?? null)
      .filter((company): company is Company => company !== null);
    return renderRelatedCompanies(store, companies);
  }
  return renderDistrictDetail(store, city, district);
}
