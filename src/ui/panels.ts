// 控制台各面板的 HTML 渲染。面板本身无状态，所有交互通过 data-action 交给 GameUI。
import { DEMO_CONFIG } from '../data/config';
import { GOODS, RECIPES } from '../data/demo-data';
import type { BuildingDefinition, DistrictDefinition } from '../data/city-layout';
import type { City, Company, MarketState } from '../simulation/contracts/types';
import type { GameStore, LayerMode, ViewMode } from '../app/gameStore';
import {
  aggregateTradeFlows,
  buildingKindLabel,
  cityName,
  deltaClass,
  districtTypeLabel,
  employmentRate,
  esc,
  goodName,
  goodUnit,
  hexColor,
  logKindLabel,
  money,
  num,
  pct,
  qty,
  roleLabel,
  sectorLabel,
  signClass,
  signedMoney,
  signedPointPercent,
  sparkline,
  tickDate,
  unemploymentRate,
  worldTotals,
} from './format';

export interface PanelState {
  focusCompanyId: string | null;
  showAllGoods: boolean;
}

interface LayerDefinition {
  id: LayerMode;
  name: string;
  code: string;
  hintRegion: string;
  hintCity: string;
  short: string;
}

const LAYERS: LayerDefinition[] = [
  {
    id: 'population',
    name: '人口',
    code: '01',
    short: '圆圈大小 = 人口规模',
    hintRegion:
      '区域圆圈按人口规模缩放，卡片同时展示就业与失业结构；切换到城市后，街区人口占比越高，蓝色覆盖越深。',
    hintCity:
      '街区人口占比越高，蓝色覆盖越深；由住宅街区向内城递减。数据来自演示布局，不逐人模拟。',
  },
  {
    id: 'economy',
    name: '经济',
    code: '02',
    short: '金线 = 月度 GDP',
    hintRegion:
      '以城市 GDP 与财政体量读图；城市地图按街区地价系数着色，商务与办公区更亮。',
    hintCity:
      '街区颜色对应地价系数；数值来自布局模板，住房交易与地价形成尚未接入模拟。',
  },
  {
    id: 'industry',
    name: '产业',
    code: '03',
    short: '橙色 = 工业就业',
    hintRegion:
      '标示各城主导产业与就业规模；城市地图突出工业、办公与商务街区，适合查看企业与岗位分布。',
    hintCity:
      '工业与办公街区获得更高覆盖；具体企业与产能请点击厂区建筑查看。',
  },
];

const QUICK_INVEST = 50_000;
const INVEST_AMOUNTS = [50_000, 100_000, 250_000] as const;

function investLabel(amount: number): string {
  return `${num(amount / 10_000)} 万`;
}

function layerDefinition(layer: LayerMode): LayerDefinition {
  return LAYERS.find((entry) => entry.id === layer) ?? LAYERS[0]!;
}

function renderLayerSection(store: GameStore, view: ViewMode): string {
  const active = layerDefinition(store.layer);
  return `
    <section class="panel-section layer-section">
      <div class="section-head">
        <div>
          <span class="kicker">MAP LAYERS</span>
          <h2>${view === 'city' ? '街道图层' : '区域图层'}</h2>
        </div>
        <span class="section-tag">${esc(active.name)} · 当前</span>
      </div>
      <div class="layer-grid">
        ${LAYERS.map(
          (layer) => `
          <button
            type="button"
            class="layer-btn ${layer.id === store.layer ? 'is-active' : ''}"
            data-action="set-layer"
            data-layer="${layer.id}"
            data-testid="layer-${layer.id}"
            data-focus-key="layer-${layer.id}"
            aria-pressed="${layer.id === store.layer}"
            title="${esc(view === 'city' ? layer.hintCity : layer.hintRegion)}"
          >
            <span class="layer-no">${layer.code}</span>
            <span class="layer-name">${esc(layer.name)}</span>
            <span class="layer-state">${layer.id === store.layer ? '当前' : '切换'}</span>
          </button>`,
        ).join('')}
      </div>
      <p class="layer-hint">
        <b>${esc(active.name)}图层：</b>${esc(view === 'city' ? active.hintCity : active.hintRegion)}
      </p>
    </section>`;
}

function cityCard(city: City, selected: boolean): string {
  const rate = unemploymentRate(city);
  return `
    <div class="city-card ${selected ? 'is-selected' : ''}" style="--city-color:${esc(city.color)}">
      <button
        type="button"
        class="city-card-main"
        data-action="select-city"
        data-city-id="${esc(city.id)}"
        data-testid="city-card-${esc(city.id)}"
        data-focus-key="city-${esc(city.id)}"
        aria-pressed="${selected}"
        title="单击查看 ${esc(city.name)} 概况；双击进入城市地图"
      >
        <span class="city-name"><b>${esc(city.name)}</b><em>${esc(city.englishName)}</em></span>
        <span class="city-tagline">${esc(city.tagline)}</span>
        <span class="city-metrics">
          <span><i>人口</i><b>${num(city.population.total)}</b></span>
          <span><i>就业</i><b>${num(city.population.employed)}</b></span>
          <span><i>失业</i><b class="${rate > 0.08 ? 'is-warn' : ''}">${pct(rate)}</b></span>
        </span>
        <span class="city-econ">
          <span>GDP <b>${money(city.gdp)}</b></span>
          <span>财政 <b>${money(city.treasury)}</b></span>
        </span>
      </button>
      <div class="city-card-foot">
        <span>${selected ? '当前选中 · 双击进入' : '双击进入城市'}</span>
        <button
          type="button"
          class="ken-btn ken-btn--blue ken-btn--mini city-enter"
          data-action="enter-city"
          data-city-id="${esc(city.id)}"
          data-focus-key="enter-${esc(city.id)}"
          title="进入 ${esc(city.name)} 城市地图"
        >进入城市</button>
      </div>
    </div>`;
}

export function renderLeftRegion(store: GameStore): string {
  const totalCompanies = store.world.companies.length;
  return `
    <header class="rail-head">
      <span class="kicker">REGION INDEX</span>
      <h2 class="rail-title">城市索引</h2>
      <p class="rail-sub">${store.world.cities.length} 座城市 · ${totalCompanies} 家企业 · ${esc(DEMO_CONFIG.meta.label)}</p>
      <span class="ken-divider"></span>
    </header>
    ${renderLayerSection(store, 'region')}
    <section class="panel-section city-section">
      <div class="section-head">
        <div>
          <span class="kicker">REGIONAL CITIES</span>
          <h2>选择城市</h2>
        </div>
        <span class="section-tag">单击查看</span>
      </div>
      <div class="city-list">
        ${store.world.cities
          .map((city) => cityCard(city, store.selectedCityId === city.id))
          .join('')}
      </div>
      <p class="note">双击城市卡片或地图上的城市，也可以使用卡片内的「进入城市」。</p>
    </section>`;
}

function renderBreadcrumb(store: GameStore, city: City): string {
  const building = store.selectedBuilding;
  const district = store.selectedDistrict;
  const parts: string[] = [
    `<button type="button" class="crumb-btn" data-action="clear-selection" title="返回全城视图">${esc(city.name)}</button>`,
  ];
  if (district) {
    parts.push('<span class="crumb-sep">›</span>');
    parts.push(
      `<button type="button" class="crumb-btn" data-action="select-district" data-district-id="${esc(district.id)}">${esc(district.name)}</button>`,
    );
  } else {
    parts.push('<span class="crumb-sep">›</span><span class="crumb-current">全城视图</span>');
  }
  if (building) {
    parts.push('<span class="crumb-sep">›</span>');
    parts.push(`<span class="crumb-current">${esc(building.name)}</span>`);
  }
  return `<div class="breadcrumb" aria-label="当前选择路径">${parts.join('')}</div>`;
}

function renderDistrictList(store: GameStore): string {
  const districts = store.selectedLayout?.districts ?? [];
  return `
    <section class="panel-section district-section">
      <div class="section-head">
        <div>
          <span class="kicker">DISTRICT INDEX</span>
          <h2>街区索引</h2>
        </div>
        <span class="section-tag">${districts.length} 个街区</span>
      </div>
      <div class="district-list">
        ${districts
          .map(
            (district) => `
          <button
            type="button"
            class="district-row ${store.selectedDistrictId === district.id ? 'is-active' : ''}"
            data-action="select-district"
            data-district-id="${esc(district.id)}"
            data-focus-key="district-${esc(district.id)}"
            style="--dist-color:${hexColor(district.color)}"
            aria-pressed="${store.selectedDistrictId === district.id}"
            title="${esc(district.description)}"
          >
            <span class="dist-swatch"></span>
            <span class="dist-main">
              <b>${esc(district.name)}</b>
              <em>${districtTypeLabel(district.type)}</em>
            </span>
            <span class="dist-share">人口 ${pct(district.populationShare, 0)}<br>岗位 ${pct(district.jobsShare, 0)}</span>
          </button>`,
          )
          .join('')}
      </div>
      <p class="note">选择街区可查看占比与建筑列表；也可直接单击地图。</p>
    </section>`;
}

export function renderLeftCity(store: GameStore): string {
  const city = store.selectedCity;
  if (!city) {
    return `
      <header class="rail-head">
        <button type="button" class="ken-btn ken-btn--grey ken-btn--mini" data-action="back-region" data-testid="btn-back-region">← 返回区域</button>
        <h2 class="rail-title">城市地图</h2>
        <p class="rail-sub">没有选中的城市。</p>
      </header>`;
  }
  return `
    <header class="rail-head city-rail-head">
      <button
        type="button"
        class="ken-btn ken-btn--grey ken-btn--mini back-btn"
        data-action="back-region"
        data-testid="btn-back-region"
        data-focus-key="back-region"
      >← 返回区域</button>
      <div class="rail-city-title" style="--city-color:${esc(city.color)}">
        <span class="city-dot"></span>
        <div>
          <span class="kicker">CITY MAP</span>
          <h2 class="rail-title">${esc(city.name)} <em>${esc(city.englishName)}</em></h2>
        </div>
      </div>
      <p class="rail-sub">${esc(city.tagline)}</p>
      ${renderBreadcrumb(store, city)}
      <span class="ken-divider"></span>
    </header>
    ${renderLayerSection(store, 'city')}
    ${renderDistrictList(store)}`;
}

function renderCityIdentity(store: GameStore, city: City, options: { enter: boolean }): string {
  return `
    <header class="city-head" style="--city-color:${esc(city.color)}">
      <div class="city-title-row">
        <span class="city-dot"></span>
        <div class="city-title-text">
          <span class="kicker">SELECTED CITY</span>
          <h1>${esc(city.name)}<em>${esc(city.englishName)}</em></h1>
          <p class="city-tagline">${esc(city.tagline)}</p>
        </div>
      </div>
      ${
        options.enter
          ? `<div class="city-head-actions">
              <button
                type="button"
                class="ken-btn ken-btn--green"
                data-action="enter-city"
                data-city-id="${esc(city.id)}"
                data-testid="btn-enter-city"
                data-focus-key="panel-enter-city"
              >进入城市 <span aria-hidden="true">→</span></button>
              <span class="city-head-hint">单击查看 · 双击进入</span>
            </div>`
          : ''
      }
      <span class="ken-divider"></span>
    </header>`;
}

function renderKpis(store: GameStore, city: City): string {
  const rate = unemploymentRate(city);
  return `
    <div class="kpi-grid">
      <div class="kpi">
        <span>人口 POP</span>
        <b>${num(city.population.total)}</b>
        <small>劳动力 ${num(city.population.laborForce)}</small>
      </div>
      <div class="kpi">
        <span>就业 E</span>
        <b>${num(city.population.employed)}</b>
        <small>就业率 ${pct(employmentRate(city))}</small>
      </div>
      <div class="kpi ${rate > 0.08 ? 'is-warn' : ''}">
        <span>失业 U</span>
        <b>${num(city.population.unemployed)}</b>
        <small>失业率 ${pct(rate)}</small>
      </div>
      <div class="kpi is-gold">
        <span>GDP 本月</span>
        <b>${money(city.gdp)}</b>
        <small>增加值口径</small>
      </div>
      <div class="kpi">
        <span>财政</span>
        <b>${money(city.treasury)}</b>
        <small>个税 ${pct(city.incomeTaxRate, 0)} · 企税 ${pct(city.corporateTaxRate, 0)}</small>
      </div>
      <div class="kpi is-teal">
        <span>居民收入</span>
        <b>${money(city.householdIncomeLastMonth)}</b>
        <small>上月可支配</small>
      </div>
    </div>
    <div class="info-rows">
      <div class="info-row"><span>非劳动力 N</span><b>${num(city.population.nonLabor)}</b></div>
      <div class="info-row"><span>劳动人口</span><b>${num(city.population.laborForce)}</b></div>
      <div class="info-row"><span>公共岗位</span><b>${num(city.publicSector.employees)}</b></div>
      <div class="info-row"><span>企业数量</span><b>${num(store.companiesForCity(city.id).length)} 家</b></div>
    </div>`;
}

function renderPulse(city: City): string {
  const history = city.gdpHistory.slice(-18).map((point) => point.value);
  return `
    <div class="pulse-strip">
      ${sparkline(history, 150, 30, '#f2c14e')}
      <div class="pulse-meta">
        <span>GDP 轨迹</span>
        <b>${
          history.length > 1
            ? `近 ${history.length} 期`
            : history.length === 1
              ? '仅 1 期'
              : '等待首次结算'
        }</b>
      </div>
    </div>`;
}

function renderSystems(city: City): string {
  return `
    <section class="panel-section">
      <div class="section-head">
        <div>
          <span class="kicker">INITIAL STATES</span>
          <h2>科技 · 政治 · 房地产</h2>
        </div>
        <span class="status-badge">初始展示 · 系统未实现</span>
      </div>
      <div class="system-grid">
        <div class="system-card">
          <h3>科技</h3>
          <span class="system-status">initial-only</span>
          <div class="system-values">
            <span>等级 <b>Lv.${num(city.technology.level)}</b></span>
            <span>生产率 <b>×${city.technology.productivityMultiplier.toFixed(3)}</b></span>
            <span>研究点 <b>${num(city.technology.researchPoints)}</b></span>
          </div>
          <p class="system-note">${esc(city.technology.note)}</p>
        </div>
        <div class="system-card">
          <h3>政治</h3>
          <span class="system-status">initial-only</span>
          <div class="system-values">
            <span>支持率 <b>${pct(city.politics.approval / 100, 0)}</b></span>
            <span>执政党 <b>${esc(city.politics.rulingParty)}</b></span>
            <span>选举 <b>${
              city.politics.electionInMonths === null
                ? '—'
                : `${num(city.politics.electionInMonths)} 个月后`
            }</b></span>
          </div>
          <p class="system-note">${esc(city.politics.note)}</p>
        </div>
        <div class="system-card">
          <h3>房地产</h3>
          <span class="system-status">initial-only</span>
          <div class="system-values">
            <span>均价 <b>${money(city.realEstate.avgHomePrice)}</b></span>
            <span>租金指数 <b>${num(city.realEstate.rentIndex)}</b></span>
            <span>空置率 <b>${pct(city.realEstate.vacancyRate)}</b></span>
          </div>
          <p class="system-note">${esc(city.realEstate.note)}</p>
        </div>
      </div>
      <p class="note">以上为初始值展示，仅参与有限的演示计算；没有研发、选举或住房交易等可操作入口。</p>
    </section>`;
}

function renderMarket(city: City, showAllGoods: boolean): string {
  const goods = showAllGoods
    ? GOODS
    : GOODS.filter((good) => good.category === 'consumer');
  return `
    <section class="panel-section">
      <div class="section-head">
        <div>
          <span class="kicker">MARKET SNAPSHOT</span>
          <h2>市场快照</h2>
        </div>
        <button
          type="button"
          class="chip-btn"
          data-action="toggle-goods"
          aria-pressed="${showAllGoods}"
          data-focus-key="toggle-goods"
        >${showAllGoods ? '仅消费品' : `全部商品 (${GOODS.length})`}</button>
      </div>
      <div class="table-wrap">
        <table class="market-table" aria-label="${esc(city.name)} 市场快照">
          <thead>
            <tr>
              <th scope="col">商品</th>
              <th scope="col">价格</th>
              <th scope="col">需求</th>
              <th scope="col">成交</th>
              <th scope="col">未满足</th>
              <th scope="col">库存</th>
              <th scope="col" title="跨城进口 / 区域外出口">贸易</th>
            </tr>
          </thead>
          <tbody>
            ${goods
              .map((good) => {
                const market: MarketState | undefined = city.market[good.id];
                if (!market) return '';
                return `
                <tr>
                  <td class="good" title="${esc(good.description)}">${esc(good.name)}</td>
                  <td class="price">
                    <b>${num(market.price, 1)}</b>
                    <em class="delta ${deltaClass(market.lastPriceChangePct)}">${signedPointPercent(market.lastPriceChangePct)}</em>
                  </td>
                  <td title="居民需求 ${num(market.consumerDemand)} · 生产需求 ${num(market.producerDemand)}">${qty(market.demand)}</td>
                  <td>${qty(market.sold)}</td>
                  <td class="${market.unmetDemand > 0 ? 'is-hot' : ''}" title="未满足需求 ${num(market.unmetDemand, 1)}">${qty(market.unmetDemand)}</td>
                  <td>${qty(market.closingStock)}</td>
                  <td class="trade-cell" title="跨城进口 ${num(market.intercityImported, 1)} · 区域外出口 ${num(market.externalExport, 1)}">
                    <span>进 ${qty(market.intercityImported)}</span>
                    <span>出 ${qty(market.externalExport)}</span>
                  </td>
                </tr>`;
              })
              .join('')}
          </tbody>
        </table>
      </div>
      <p class="note">数量均为演示货品单位；需求含居民与生产需求，成交为上月结果，贸易列为跨城进口 / 区域外出口数量。</p>
    </section>`;
}

function companyRow(store: GameStore, company: Company, focused: boolean): string {
  const stake = store.playerStake(company.id);
  const profit = company.lastMonth.profit;
  const cashEnough = store.world.player.cash >= QUICK_INVEST;
  return `
    <div class="company-row ${focused ? 'is-focus' : ''}">
      <button
        type="button"
        class="company-main"
        data-action="focus-company"
        data-company-id="${esc(company.id)}"
        data-testid="company-row-${esc(company.id)}"
        data-focus-key="company-${esc(company.id)}"
        aria-pressed="${focused}"
        title="查看 ${esc(company.name)} 详情与注资"
      >
        <span class="co-top">
          <b>${esc(company.name)}</b>
          <span class="sector-chip">${esc(sectorLabel(company.sector))}</span>
          <span class="stake">${stake > 0 ? `持股 ${pct(stake, 2)}` : '未持股'}</span>
        </span>
        <span class="co-mid">
          <span>员工 ${num(company.employees)}</span>
          <span>岗位 ${num(company.jobDemand)}</span>
          <span>现金 ${money(company.cash)}</span>
        </span>
        <span class="co-bot">
          <span class="profit ${signClass(profit)}">上月利润 ${signedMoney(profit)}</span>
          <span class="co-hint">${focused ? '收起详情' : '查看详情 / 注资'}</span>
        </span>
      </button>
      <button
        type="button"
        class="ken-btn ken-btn--green ken-btn--mini co-quick"
        data-action="invest"
        data-company-id="${esc(company.id)}"
        data-amount="${QUICK_INVEST}"
        data-testid="company-invest-${esc(company.id)}"
        data-focus-key="quick-invest-${esc(company.id)}"
        title="${cashEnough ? `向 ${esc(company.name)} 注资 ${investLabel(QUICK_INVEST)} 信用点` : `玩家现金不足 ${investLabel(QUICK_INVEST)}，无法注资`}"
        ${cashEnough ? '' : 'disabled'}
      >注资</button>
    </div>`;
}

function renderCompanies(store: GameStore, city: City, focusCompanyId: string | null): string {
  const companies = [...store.companiesForCity(city.id)].sort(
    (a, b) => b.employees - a.employees || a.name.localeCompare(b.name, 'zh-CN'),
  );
  const totalEmployees = companies.reduce((total, company) => total + company.employees, 0);
  return `
    <section class="panel-section">
      <div class="section-head">
        <div>
          <span class="kicker">PRIVATE EMPLOYERS</span>
          <h2>主要企业</h2>
        </div>
        <span class="section-tag">${companies.length} 家 · 员工 ${num(totalEmployees)}</span>
      </div>
      <div class="company-list">
        ${companies.map((company) => companyRow(store, company, focusCompanyId === company.id)).join('')}
      </div>
      <p class="note">点击企业展开详情与注资入口。企业现金不足时会在月度结算中触发营运资金信贷 / 债务重组（演示）。</p>
    </section>`;
}

function renderTradeSummary(store: GameStore): string {
  const flows = store.currentTradeFlows();
  const groups = aggregateTradeFlows(flows);
  const totalValue = groups.reduce((total, group) => total + group.value, 0);
  const external = store.world.lastTick.externalExports;
  const externalValue = external.reduce((total, entry) => total + entry.value, 0);
  const visible = groups.slice(0, 8);
  return `
    <section class="panel-section">
      <div class="section-head">
        <div>
          <span class="kicker">REGIONAL TRADE</span>
          <h2>区域贸易摘要</h2>
        </div>
        <span class="section-tag">${flows.length} 笔 · ${money(totalValue)}</span>
      </div>
      ${
        groups.length === 0
          ? `<div class="empty-state compact">
              <span class="empty-mark" aria-hidden="true">⇄</span>
              <p>本月暂无成交</p>
              <small>推进一个月后，这里会列出实际发生的跨城市企业交易。</small>
            </div>`
          : `<div class="table-wrap">
              <table class="trade-table" aria-label="本回合跨城市贸易流量">
                <thead>
                  <tr><th scope="col">路线</th><th scope="col">商品</th><th scope="col">数量</th><th scope="col">价值</th></tr>
                </thead>
                <tbody>
                  ${visible
                    .map(
                      (group) => `
                    <tr title="${esc(cityName(store.world, group.fromCityId))} → ${esc(cityName(store.world, group.toCityId))} · ${esc(goodName(group.good))} · ${num(group.qty, 1)} ${esc(goodUnit(group.good))}">
                      <td class="route">${esc(cityName(store.world, group.fromCityId))}<span>→</span>${esc(cityName(store.world, group.toCityId))}</td>
                      <td class="good">${esc(goodName(group.good))}</td>
                      <td>${qty(group.qty)}</td>
                      <td class="value">${money(group.value)}</td>
                    </tr>`,
                    )
                    .join('')}
                </tbody>
              </table>              ${groups.length > visible.length ? `<p class="table-foot">另有 ${groups.length - visible.length} 条成交未展开。</p>` : ''}
            </div>`
      }
      ${
        external.length > 0
          ? `<p class="note">区域外出口 ${external.length} 笔 · 货值 ${money(externalValue)}（开放经济演示，不对应具体贸易伙伴）。</p>`
          : ''
      }
    </section>`;
}

export function renderRightRegion(store: GameStore, state: PanelState): string {
  const city = store.selectedCity;
  if (!city) {
    return `
      <div class="empty-state">
        <span class="empty-mark" aria-hidden="true">◎</span>
        <p>请选择一座城市</p>
        <small>从左侧城市索引中选择，或单击地图上的城市。</small>
      </div>`;
  }
  const focusCompany =
    state.focusCompanyId !== null
      ? store.world.companies.find(
          (company) => company.id === state.focusCompanyId && company.cityId === city.id,
        ) ?? null
      : null;
  return `
    ${renderCityIdentity(store, city, { enter: true })}
    ${
      focusCompany
        ? renderCompanyDetail(store, focusCompany, { showClose: true, investTestId: false })
        : ''
    }
    <section class="panel-section overview-section">
      <div class="section-head">
        <div>
          <span class="kicker">CITY OVERVIEW</span>
          <h2>城市概况</h2>
        </div>
        <span class="section-tag">${esc(store.dateLabel)}</span>
      </div>
      ${renderKpis(store, city)}
      ${renderPulse(city)}
    </section>
    ${renderSystems(city)}
    ${renderMarket(city, state.showAllGoods)}
    ${renderCompanies(store, city, state.focusCompanyId)}
    ${renderTradeSummary(store)}`;
}

function renderBuildingDetail(
  store: GameStore,
  city: City,
  building: BuildingDefinition,
  company: Company | null,
): string {
  const district = store.selectedLayout?.districts.find(
    (entry) => entry.id === building.districtId,
  );
  return `
    <article class="selection-card" data-testid="building-detail" data-building-id="${esc(building.id)}">
      <header class="selection-head">
        <div>
          <span class="kicker">SELECTED BUILDING</span>
          <h3>${esc(building.name)}</h3>
          <div class="chips">
            <span class="chip">${esc(buildingKindLabel(building.kind))}</span>
            <span class="chip">${esc(district?.name ?? building.districtId)}</span>
            ${company ? `<span class="chip chip--gold">${esc(company.name)}</span>` : ''}
          </div>
        </div>
        <button type="button" class="icon-btn" data-action="clear-selection" aria-label="清除建筑选择" title="清除选择">×</button>
      </header>
      <div class="detail-grid">
        <div class="detail-cell"><span>层数</span><b>${num(building.floors)} 层</b></div>
        <div class="detail-cell"><span>户数</span><b>${building.households > 0 ? `${num(building.households)} 户` : '—'}</b></div>
        <div class="detail-cell"><span>岗位</span><b>${num(building.jobs)} 个</b></div>
        <div class="detail-cell"><span>月租</span><b>${money(building.rentPerMonth)}</b></div>
      </div>
      <p class="note">${esc(building.note)}</p>
      ${
        company
          ? `<button type="button" class="ken-btn ken-btn--blue ken-btn--mini selection-action" data-action="scroll-company">查看企业 / 注资 ↓</button>`
          : ''
      }
    </article>
    ${
      company
        ? renderCompanyDetail(store, company, {
            showClose: false,
            investTestId: true,
          })
        : ''
    }
    <p class="selection-context">${esc(city.name)} · ${esc(district?.name ?? '城市街区')}</p>`;
}

function renderDistrictDetail(store: GameStore, city: City, district: DistrictDefinition): string {
  const layout = store.selectedLayout;
  const buildings = layout?.buildings.filter((building) => building.districtId === district.id) ?? [];
  const estimatedPopulation = city.population.total * district.populationShare;
  const estimatedJobs = city.population.employed * district.jobsShare;
  return `
    <article class="selection-card" data-testid="district-detail" data-district-id="${esc(district.id)}">
      <header class="selection-head">
        <div>
          <span class="kicker">SELECTED DISTRICT</span>
          <h3>${esc(district.name)}</h3>
          <div class="chips">
            <span class="chip">${esc(districtTypeLabel(district.type))}</span>
            <span class="chip">${num(buildings.length)} 栋建筑</span>
          </div>
        </div>
        <button type="button" class="icon-btn" data-action="clear-selection" aria-label="清除街区选择" title="清除选择">×</button>
      </header>
      <div class="detail-grid">
        <div class="detail-cell"><span>人口占比</span><b>${pct(district.populationShare, 0)}</b></div>
        <div class="detail-cell"><span>岗位占比</span><b>${pct(district.jobsShare, 0)}</b></div>
        <div class="detail-cell"><span>地价系数</span><b>×${district.landValueFactor.toFixed(2)}</b></div>
        <div class="detail-cell"><span>估算人口</span><b>${num(estimatedPopulation)}</b></div>
        <div class="detail-cell"><span>估算岗位</span><b>${num(estimatedJobs)}</b></div>
        <div class="detail-cell"><span>建筑数量</span><b>${num(buildings.length)} 栋</b></div>
      </div>
      <p class="note">${esc(district.description)} 占比与地价来自布局模板，估算值仅用于读图。</p>
      <div class="building-list">
        <span class="building-list-title">本街区建筑</span>
        ${buildings
          .map((building) => {
            const company = building.companyId
              ? store.world.companies.find((entry) => entry.id === building.companyId)
              : null;
            return `
              <button
                type="button"
                class="building-item"
                data-action="select-building"
                data-building-id="${esc(building.id)}"
                data-testid="building-${esc(building.id)}"
                data-focus-key="building-${esc(building.id)}"
                title="${esc(building.name)} · ${esc(buildingKindLabel(building.kind))}"
              >
                <span class="building-item-main">
                  <b>${esc(company?.name ?? building.name)}</b>
                  <em>${esc(buildingKindLabel(building.kind))} · ${num(building.floors)} 层</em>
                </span>
                <span class="building-item-side">${building.jobs > 0 ? `${num(building.jobs)} 岗位` : `${num(building.households)} 户`}</span>
              </button>`;
          })
          .join('')}
      </div>
    </article>`;
}

export interface CompanyDetailOptions {
  showClose?: boolean;
  investTestId?: boolean;
}

export function renderCompanyDetail(
  store: GameStore,
  company: Company,
  options: CompanyDetailOptions = {},
): string {
  const city = store.world.cities.find((entry) => entry.id === company.cityId);
  const price = store.citySharePrice(company);
  const stake = store.playerStake(company.id);
  const holding = store.world.player.holdings.find((entry) => entry.companyId === company.id);
  const recipe = RECIPES[company.recipeOutput];
  const roleKeys = Object.keys(company.roles) as (keyof Company['roles'])[];
  const roleTotal = roleKeys.reduce((total, key) => total + company.roles[key], 0);
  const playerCash = store.world.player.cash;
  const lastMonth = company.lastMonth;
  return `
    <article
      class="company-detail"
      id="company-panel"
      data-testid="company-detail-${esc(company.id)}"
      data-company-detail="${esc(company.id)}"
    >
      <header class="selection-head">
        <div>
          <span class="kicker">COMPANY DETAIL</span>
          <h3>${esc(company.name)}</h3>
          <div class="chips">
            <span class="chip">${esc(sectorLabel(company.sector))}</span>
            <span class="chip">${esc(city?.name ?? company.cityId)}</span>
            <span class="chip">${esc(goodName(company.recipeOutput))}生产</span>
          </div>
        </div>
        ${
          options.showClose
            ? '<button type="button" class="icon-btn" data-action="close-company" aria-label="关闭企业详情" title="关闭">×</button>'
            : ''
        }
      </header>
      <p class="company-note">${esc(company.note)}</p>
      <div class="kpi-grid kpi-grid--tight">
        <div class="kpi">
          <span>现金</span>
          <b>${money(company.cash)}</b>
          <small>信用点</small>
        </div>
        <div class="kpi ${company.debt > 0 ? 'is-warn' : ''}">
          <span>债务</span>
          <b>${money(company.debt)}</b>
          <small>${company.debt > 0 ? '营运资金信贷' : '无负债'}</small>
        </div>
        <div class="kpi">
          <span>产能</span>
          <b title="${num(company.capacity, 0)} 单位 / 月">${qty(company.capacity)}</b>
          <small>单位 / 月</small>
        </div>
        <div class="kpi ${company.utilization < 0.6 ? 'is-warn' : 'is-teal'}">
          <span>利用率</span>
          <b>${pct(company.utilization)}</b>
          <small title="${num(company.maxCapacity, 0)} 单位 / 月">上限 ${qty(company.maxCapacity)}</small>
        </div>
        <div class="kpi">
          <span>员工 / 岗位</span>
          <b>${num(company.employees)}</b>
          <small>岗位需求 ${num(company.jobDemand)}</small>
        </div>
        <div class="kpi">
          <span>工资率</span>
          <b>${money(company.wageRate)}</b>
          <small>每人 · 月</small>
        </div>
        <div class="kpi is-gold">
          <span>股价</span>
          <b>${num(price, 2)}</b>
          <small>信用点 / 股</small>
        </div>
        <div class="kpi is-teal">
          <span>玩家持股</span>
          <b>${pct(stake, 2)}</b>
          <small>${num(holding?.shares ?? 0)} 股</small>
        </div>
      </div>
      <div class="finance-grid">
        <div class="fin-block">
          <h4>上月损益</h4>
          <table class="fin-table">
            <tbody>
              <tr><td>收入</td><td>${money(lastMonth.revenue)}</td></tr>
              <tr><td>投入</td><td>${money(lastMonth.inputCost)}</td></tr>
              <tr><td>工资</td><td>${money(lastMonth.wagesPaid)}</td></tr>
              ${lastMonth.wageArrears > 0 ? `<tr class="is-warn"><td>欠薪</td><td>${money(lastMonth.wageArrears)}</td></tr>` : ''}
              <tr><td>利息</td><td>${money(lastMonth.interestPaid)}</td></tr>
              <tr><td>公司税</td><td>${money(lastMonth.corporateTax)}</td></tr>
              <tr><td>股息</td><td>${money(lastMonth.dividendsPaid)}</td></tr>
              <tr><td>出口</td><td>${qty(lastMonth.exported)} 单位</td></tr>
              <tr class="total"><td>利润</td><td class="${signClass(lastMonth.profit)}">${signedMoney(lastMonth.profit)}</td></tr>
            </tbody>
          </table>
        </div>
        <div class="fin-block">
          <h4>岗位分布</h4>
          ${roleKeys
            .map((key) => {
              const value = company.roles[key];
              const width = roleTotal > 0 ? Math.min(100, (value / roleTotal) * 100) : 0;
              return `
                <div class="role-row" title="${esc(roleLabel(key))} ${num(value)} 人">
                  <span>${esc(roleLabel(key))}</span>
                  <div class="role-bar"><i style="width:${width.toFixed(1)}%"></i></div>
                  <b>${num(value)}</b>
                </div>`;
            })
            .join('')}
          <p class="fin-hint">产出：${esc(goodName(company.recipeOutput))} · 配方 ${esc(
            recipe?.inputs.length
              ? recipe.inputs.map((input) => `${goodName(input.good)} ×${input.qty}`).join(' / ')
              : '无材料投入',
          )}</p>
        </div>
      </div>
      <div class="inventory-row">
        <span class="inventory-title">库存 · 产出与关键投入</span>
        <div class="inv-chips">
          <span class="inv-chip is-output" title="${num(company.inventory[company.recipeOutput], 1)} ${esc(goodUnit(company.recipeOutput))}"><b>${esc(goodName(company.recipeOutput))}</b> ${qty(
            company.inventory[company.recipeOutput],
          )}</span>
          ${(recipe?.inputs ?? [])
            .map(
              (input) =>
                `<span class="inv-chip" title="${num(company.inventory[input.good], 1)} ${esc(goodUnit(input.good))}"><b>${esc(goodName(input.good))}</b> ${qty(company.inventory[input.good])}</span>`,
            )
            .join('')}
        </div>
      </div>
      <div class="invest-box">
        <div class="invest-head">
          <span>向企业注资</span>
          <small>玩家现金 ${money(playerCash)} 信用点</small>
        </div>
        <div class="invest-btns">
          ${INVEST_AMOUNTS.map((amount) => {
            const disabled = playerCash < amount;
            const testId =
              options.investTestId && amount === INVEST_AMOUNTS[0]
                ? ` data-testid="company-invest-${esc(company.id)}"`
                : '';
            return `
              <button
                type="button"
                class="ken-btn ken-btn--green ken-btn--mini"
                data-action="invest"
                data-company-id="${esc(company.id)}"
                data-amount="${amount}"
                data-focus-key="invest-${esc(company.id)}-${amount}"
                title="${disabled ? `玩家现金不足 ${investLabel(amount)} 信用点` : `注资 ${investLabel(amount)} 信用点`}"
                ${disabled ? 'disabled' : ''}${testId}
              >注资 ${investLabel(amount)}</button>`;
          }).join('')}
        </div>
      </div>
      <p class="warning-note">企业现金不足会触发营运资金信贷 / 债务重组（演示）。该机制不是正式金融模型。</p>
    </article>`;
}

export function renderRightCity(store: GameStore, state: PanelState): string {
  const city = store.selectedCity;
  if (!city) {
    return `
      <div class="empty-state">
        <span class="empty-mark" aria-hidden="true">◎</span>
        <p>没有选中的城市</p>
        <small>返回区域并选择一座城市。</small>
      </div>`;
  }
  const building = store.selectedBuilding;
  const district = store.selectedDistrict;
  const company =
    building?.companyId !== undefined
      ? store.world.companies.find((entry) => entry.id === building.companyId) ?? null
      : null;
  let detail = '';
  if (building) {
    detail = renderBuildingDetail(store, city, building, company);
  } else if (district) {
    detail = renderDistrictDetail(store, city, district);
  } else {
    detail = `
      <div class="empty-state selection-empty">
        <span class="empty-mark" aria-hidden="true">▦</span>
        <p>选择建筑或街区</p>
        <small>单击地图中的建筑查看企业与注资；也可以从左侧街区索引进入。</small>
      </div>`;
  }
  return `
    ${detail}
    <section class="panel-section overview-section">
      <div class="section-head">
        <div>
          <span class="kicker">CITY OVERVIEW</span>
          <h2>城市概况 · ${esc(city.name)}</h2>
        </div>
        <span class="section-tag">${esc(store.dateLabel)}</span>
      </div>
      ${renderKpis(store, city)}
      ${renderPulse(city)}
    </section>
    ${renderSystems(city)}
    ${renderMarket(city, state.showAllGoods)}`;
}

export function renderLogDock(store: GameStore, collapsed: boolean): string {
  const totals = worldTotals(store.world, store.playerNetWorth);
  const logs = store.world.log.slice(-14).reverse();
  const history = store.world.history.slice(-18).map((point) => point.gdp);
  return `
    <header class="log-head">
      <div class="log-title">
        <span class="kicker">MONTHLY FEED</span>
        <h2>事件日志 · 月度快照</h2>
      </div>
      <div class="log-spark" title="世界 GDP 轨迹">
        ${sparkline(history, 120, 26, '#5fe3c0')}
      </div>
      <div class="log-actions">
        <button type="button" class="chip-btn" data-action="open-report" data-testid="btn-report">月度报告</button>
        <button
          type="button"
          class="icon-btn"
          data-action="toggle-log"
          aria-expanded="${!collapsed}"
          aria-label="${collapsed ? '展开事件日志' : '收起事件日志'}"
          title="${collapsed ? '展开事件日志' : '收起事件日志'}"
        >${collapsed ? '▴' : '▾'}</button>
      </div>
    </header>
    <div class="log-body">
      <div class="snapshot-strip">
        <div class="snap"><span>世界人口</span><b>${num(totals.population)}</b></div>
        <div class="snap"><span>就业</span><b>${num(totals.employed)}</b></div>
        <div class="snap"><span>失业</span><b title="失业率 ${pct(totals.unemploymentRate)}">${num(totals.unemployed)}</b></div>
        <div class="snap is-gdp"><span>世界 GDP</span><b>${money(totals.gdp)}</b></div>
        <div class="snap is-net"><span>玩家净值</span><b>${money(totals.netWorth)}</b></div>
      </div>
      <ol class="log-list" data-scroll="log" aria-label="最近事件日志">
        ${
          logs.length === 0
            ? '<li class="log-empty">尚无事件记录。</li>'
            : logs
                .map(
                  (entry) => `
              <li class="log-item log-${entry.kind}" title="${esc(tickDate(entry.tick))} · ${esc(logKindLabel(entry.kind))}">
                <span class="log-tick">${esc(tickDate(entry.tick))}</span>
                <span class="log-kind">${esc(logKindLabel(entry.kind))}</span>
                <span class="log-msg">${esc(entry.message)}</span>
              </li>`,
                )
                .join('')
        }
      </ol>
    </div>
    <footer class="log-foot">
      <span class="hotkeys">
        <span><kbd>Space</kbd> 暂停 / 继续</span>
        <span><kbd>N</kbd> 推进 1 月</span>
        <span><kbd>R</kbd> 返回区域</span>
        <span><kbd>1–3</kbd> 图层</span>
      </span>
      <span class="log-stamp">${esc(store.dateLabel)} · T${store.world.time.tick}</span>
    </footer>`;
}

export function renderMapGuide(store: GameStore): string {
  if (store.view === 'city') {
    return `
      <span class="guide-mark" aria-hidden="true">＋</span>
      <div>
        <b>拖动平移 · 滚轮缩放 · 单击建筑</b>
        <span>右侧面板可查看企业、注资与街区占比。</span>
      </div>`;
  }
  return `
    <span class="guide-mark" aria-hidden="true">◎</span>
    <div>
      <b>单击城市查看概况 · 双击进入城市</b>
      <span>也可以使用城市卡片内的「进入城市」。</span>
    </div>`;
}

export function renderMapLegend(store: GameStore): string {
  const active = layerDefinition(store.layer);
  return `
    <span class="legend-kicker">LAYER ${active.code}</span>
    <b>${esc(active.name)}图层</b>
    <span>${esc(active.short)}</span>`;
}

export function renderLeftFoot(store: GameStore): string {
  if (store.view === 'city') {
    return '<b>地图素材</b> Kenney Roguelike Modern City 2.0（CC0）作为备用体系；Rasak 主素材未获取，待人工下载。';
  }
  const totals = worldTotals(store.world, store.playerNetWorth);
  return (
    `<b>区域</b> ${qty(totals.population)}人 · 失业 ${pct(totals.unemploymentRate)} · GDP ${money(totals.gdp)}` +
    `<span class="foot-extra"><br><b>${esc(DEMO_CONFIG.meta.label)}</b> · 所有数值均为可替换演示方案，不代表正式规则。</span>`
  );
}

export function renderRightFoot(_store: GameStore): string {
  return '<b>UI</b> Kenney UI Pack 2.0 · <b>字体</b> Kenney Future（CC0）· 数字口径见「参数」';
}

export { layerDefinition, LAYERS, QUICK_INVEST, INVEST_AMOUNTS };
