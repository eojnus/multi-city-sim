// 城市上下文（区域视图与城市视图）各标签页的内容。
//
// 只组合 panels.ts 已有的 section 渲染函数，不复制任何业务计算；
// 标签里展示什么完全由 panels.ts 与 GameStore 视图决定。

import type { GameStore } from '../../app/gameStore';
import type { City } from '../../simulation/contracts/types';
import { esc } from '../format';
import {
  renderAgreementsSection,
  renderBankSection,
  renderBondMarketSection,
  renderCityIdentity,
  renderCompanies,
  renderGovernmentSection,
  renderInvestorSection,
  renderKpis,
  renderMarket,
  renderMayorDemo,
  renderPopulationSection,
  renderPopulationStrataSection,
  renderPublicBankruptcyNotice,
  renderPulse,
  renderSystems,
  renderTalentMarketSection,
  renderTradeSummary,
  renderTransportSection,
} from '../panels';

export interface CityTabOptions {
  /** 区域视图：先展示城市身份卡与「进入城市」入口。 */
  inRegion: boolean;
  showAllGoods: boolean;
}

function renderCityOverview(store: GameStore, city: City, options: CityTabOptions): string {
  const identity = options.inRegion ? renderCityIdentity(store, city, { enter: true }) : '';
  const selectionHint = options.inRegion
    ? ''
    : `
      <div class="empty-state selection-empty">
        <span class="empty-mark" aria-hidden="true">▦</span>
        <p>选择建筑或街区</p>
        <small>单击地图中的建筑查看企业与注资；也可以从左侧街区索引进入。</small>
      </div>`;
  return `
    ${identity}
    ${renderMayorDemo(store, city)}
    ${selectionHint}
    <section class="panel-section overview-section">
      <div class="section-head">
        <div>
          <span class="kicker">CITY OVERVIEW</span>
          <h2>${options.inRegion ? '城市概况' : `城市概况 · ${esc(city.name)}`}</h2>
        </div>
        <span class="section-tag">${esc(store.dateLabel)}</span>
      </div>
      ${renderKpis(store, city)}
      ${renderPulse(city)}
    </section>`;
}

function renderCityPopulation(store: GameStore, city: City): string {
  return `
    ${renderPopulationSection(city)}
    ${renderPopulationStrataSection(store, city)}
    ${renderInvestorSection(store, city)}
    ${renderTalentMarketSection(store, city)}`;
}

function renderCityCompanies(store: GameStore, city: City): string {
  return renderCompanies(store, city, null);
}

function renderCityMarket(store: GameStore, city: City, options: CityTabOptions): string {
  return `
    ${renderMarket(city, options.showAllGoods)}
    ${renderBankSection(store, city)}
    ${renderBondMarketSection(store)}
    ${renderAgreementsSection(store, city)}
    ${options.inRegion ? renderTradeSummary(store) : ''}`;
}

function renderCityGovernment(store: GameStore, city: City): string {
  return `
    ${renderGovernmentSection(store, city)}
    ${renderSystems(store, city)}
    ${renderPublicBankruptcyNotice(store, city)}`;
}

/** 城市标签正文。未知标签回退到概况（标签状态机已保证合法，这里只是兜底）。 */
export function renderCityTabBody(
  store: GameStore,
  city: City,
  tab: string,
  options: CityTabOptions,
): string {
  switch (tab) {
    case 'population':
      return renderCityPopulation(store, city);
    case 'companies':
      return renderCityCompanies(store, city);
    case 'market':
      return renderCityMarket(store, city, options);
    case 'government':
      return renderCityGovernment(store, city);
    case 'transport':
      return renderTransportSection(store, city);
    case 'overview':
    default:
      return renderCityOverview(store, city, options);
  }
}
