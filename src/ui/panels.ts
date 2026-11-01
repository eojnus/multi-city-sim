// 控制台各面板的 HTML 渲染。面板本身无状态，所有交互通过 data-action 交给 GameUI。
import { DEMO_CONFIG } from '../data/config';
import { GOODS, RECIPES } from '../data/demo-data';
import type { BuildingDefinition, DistrictDefinition } from '../data/city-layout';
import type {
  AgreementItemStatus,
  AgreementStatus,
  City,
  Company,
  HolderRef,
  MarketState,
  Motion,
  ShareKind,
  TradeAgreement,
} from '../simulation/contracts/types';
import type { GameStore, LayerMode, ViewMode } from '../app/gameStore';
import { renderPopulationPie, POPULATION_PIE_COLORS } from './charts/pie';
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

const SHARE_KIND_LABELS: Record<ShareKind, string> = {
  voting: '有表决权',
  nonVoting: '仅分红',
};

const MOTION_STATUS_LABELS: Record<Motion['status'], string> = {
  open: '待表决',
  passed: '已通过',
  rejected: '已否决',
};

const VOTE_LABELS: Record<'for' | 'against' | 'abstain', string> = {
  for: '赞成',
  against: '反对',
  abstain: '弃权',
};

const AGREEMENT_STATUS_LABELS: Record<AgreementStatus, string> = {
  proposed: '协商中',
  active: '生效',
  completed: '完成',
  cancelled: '取消',
};

const AGREEMENT_ITEM_STATUS_LABELS: Record<AgreementItemStatus, string> = {
  pending: '待履约',
  active: '履约中',
  fulfilled: '完成',
  failed: '失败',
  declined: '被拒绝',
};

const DECISION_LABELS: Record<'pending' | 'accepted' | 'declined', string> = {
  pending: '待定',
  accepted: '接受',
  declined: '拒绝',
};

function shareKindLabel(kind: ShareKind): string {
  return SHARE_KIND_LABELS[kind];
}

function holderKey(holder: HolderRef): string {
  return `${holder.type}:${holder.id}`;
}

/** 界面上的持有人名称：玩家、企业名或居民投资实体名；不展示实体现金等内部明细。 */
function holderLabel(store: GameStore, holder: HolderRef | 'management'): string {
  if (holder === 'management') return '职业经理人';
  if (holder.type === 'player') return '玩家';
  if (holder.type === 'company') {
    return store.world.companies.find((company) => company.id === holder.id)?.name ?? '其他企业';
  }
  return store.world.investors.find((group) => group.id === holder.id)?.name ?? '居民投资实体';
}

function companyNameOf(store: GameStore, companyId: string): string {
  return store.world.companies.find((company) => company.id === companyId)?.name ?? '未知企业';
}

function limitPriceFor(price: number, side: 'buy' | 'sell'): string {
  const factor = side === 'buy' ? 1.02 : 0.98;
  return (Math.round(price * factor * 100) / 100).toFixed(2);
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

export function renderPopulationSection(city: City): string {
  return `
    <section class="panel-section population-section">
      <div class="section-head">
        <div>
          <span class="kicker">POPULATION MIX</span>
          <h2>人口结构</h2>
        </div>
        <span class="section-tag">互斥口径</span>
      </div>
      <div id="population-pie" data-testid="population-pie">
        ${renderPopulationPie({
          segments: [
            {
              id: 'employed',
              label: '就业',
              value: city.population.employed,
              color: POPULATION_PIE_COLORS.employed,
            },
            {
              id: 'unemployed',
              label: '失业',
              value: city.population.unemployed,
              color: POPULATION_PIE_COLORS.unemployed,
            },
            {
              id: 'nonLabor',
              label: '非劳动力',
              value: city.population.nonLabor,
              color: POPULATION_PIE_COLORS.nonLabor,
            },
          ],
          total: city.population.total,
          centerLabel: qty(city.population.total),
          centerCaption: '总人口',
          ariaLabel: `${city.name}人口构成：就业、失业与非劳动力`,
          note: '就业 + 失业 + 非劳动力 = 总人口；劳动力（就业 + 失业）不与总人口相加。',
        })}
      </div>
    </section>`;
}

export function renderMayorDemo(store: GameStore, city: City): string {
  const active = store.mayorCityId === city.id;
  return `
    <div class="mayor-demo ${active ? 'is-active' : ''}">
      <span class="mayor-demo-kicker" aria-hidden="true">DEMO ROLE</span>
      <button
        type="button"
        class="mayor-demo-btn"
        data-action="toggle-mayor-demo"
        data-city-id="${esc(city.id)}"
        data-testid="mayor-demo-toggle"
        data-focus-key="mayor-${esc(city.id)}"
        aria-pressed="${active}"
        title="${active ? `退出 ${esc(city.name)} 市长演示身份` : '仅用于查看市长专属信息，不代表选举结果'}"
      >${active ? '退出市长演示' : '以市长身份查看（演示）'}</button>
      ${
        active
          ? '<span class="mayor-demo-badge">演示：市长身份 · 选举系统未实现</span>'
          : '<span class="mayor-demo-hint">选举未实现，仅作演示入口。</span>'
      }
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

export function renderAgreementsSection(store: GameStore, city: City): string {
  const partners = store.agreementPartners(city.id);
  const agreements = store.agreementsForCity(city.id).slice(0, 6);

  const agreementCard = (agreement: TradeAgreement): string => {
    const canDecide = agreement.status === 'proposed' || agreement.status === 'active';
    const parties = agreement.participants
      .map((participant) => {
        const isActive = (accept: boolean) =>
          accept ? participant.decision === 'accepted' : participant.decision === 'declined';
        return `
          <div class="agreement-party">
            <div class="agreement-party-main">
              <b>${esc(companyNameOf(store, participant.companyId))}</b>
              <span>${participant.side === 'buyer' ? '买方' : '卖方'} · <em class="decision-${participant.decision}">${DECISION_LABELS[participant.decision]}</em></span>
            </div>
            ${
              canDecide
                ? `<div class="agreement-party-actions" role="group" aria-label="代 ${esc(companyNameOf(store, participant.companyId))} 表态">
                    <button
                      type="button"
                      class="ken-btn ken-btn--green ken-btn--mini ${isActive(true) ? 'is-active' : ''}"
                      data-action="decide-agreement"
                      data-agreement-id="${esc(agreement.id)}"
                      data-company-id="${esc(participant.companyId)}"
                      data-accept="true"
                      data-focus-key="agreement-${esc(agreement.id)}-${esc(participant.companyId)}-accept"
                      aria-pressed="${isActive(true)}"
                      title="接受协议参与邀请；仅代表该演示企业表态，不产生玩家个人义务"
                    >接受（演示：代企业表态）</button>
                    <button
                      type="button"
                      class="ken-btn ken-btn--grey ken-btn--mini ${isActive(false) ? 'is-active' : ''}"
                      data-action="decide-agreement"
                      data-agreement-id="${esc(agreement.id)}"
                      data-company-id="${esc(participant.companyId)}"
                      data-accept="false"
                      data-focus-key="agreement-${esc(agreement.id)}-${esc(participant.companyId)}-decline"
                      aria-pressed="${isActive(false)}"
                      title="拒绝协议参与邀请；拒绝对局不会产生买卖义务"
                    >拒绝（演示：代企业表态）</button>
                  </div>`
                : ''
            }
          </div>`;
      })
      .join('');

    const items = agreement.items
      .map(
        (item) => `
        <li class="agreement-item">
          <div class="agreement-item-main">
            <b>${esc(goodName(item.good))}</b>
            <span>${qty(item.qtyPerMonth)} / 月 × ${item.months} 月 · ${num(item.unitPrice, 2)} / 单位</span>
          </div>
          <div class="agreement-item-meta">
            <span>已交付 ${qty(item.deliveredQty)}</span>
            <span class="agreement-item-state is-${item.status}">${AGREEMENT_ITEM_STATUS_LABELS[item.status]}</span>
          </div>
          <p class="agreement-item-note">${esc(item.lastNote)}</p>
        </li>`,
      )
      .join('');

    return `
      <article class="agreement-card status-${agreement.status}">
        <div class="agreement-head">
          <b>${esc(agreement.title)}</b>
          <span class="agreement-state">${AGREEMENT_STATUS_LABELS[agreement.status]}</span>
        </div>
        <div class="agreement-route">
          ${esc(cityName(store.world, agreement.sponsorCityId))} → ${esc(cityName(store.world, agreement.partnerCityId))}
          · 发起 T${agreement.createdTick}
          ${agreement.createdBy === 'demo' ? ' · 演示入口' : ''}
        </div>
        <p class="agreement-note">${esc(agreement.note)}</p>
        <div class="agreement-parties">${parties}</div>
        ${items ? `<ul class="agreement-items" aria-label="协议条目">${items}</ul>` : ''}
        ${
          canDecide
            ? `<div class="agreement-actions">
                <button
                  type="button"
                  class="ken-btn ken-btn--grey ken-btn--mini"
                  data-action="withdraw-agreement"
                  data-agreement-id="${esc(agreement.id)}"
                  data-focus-key="withdraw-${esc(agreement.id)}"
                  title="取消协议；未履约条目不再执行"
                >取消协议（演示）</button>
              </div>`
            : ''
        }
      </article>`;
  };

  return `
    <section class="panel-section agreement-section" data-testid="agreements-section">
      <div class="section-head">
        <div>
          <span class="kicker">CITY AGREEMENTS</span>
          <h2>跨城贸易协议</h2>
        </div>
        <span class="section-tag">${agreements.length} 条</span>
      </div>
      <p class="demo-note">市政府牵头（演示入口）。市长选举尚未实现，这里不代表玩家已当选。</p>
      <div class="agreement-partners">
        <span class="agreement-partner-label">组织协商</span>
        ${partners
          .map(
            (partner) => `
            <button
              type="button"
              class="chip-btn agreement-partner-btn"
              data-action="organize-agreement"
              data-partner-city-id="${esc(partner.id)}"
              data-focus-key="agreement-${esc(city.id)}-${esc(partner.id)}"
              title="由市政府（演示）组织 ${esc(city.name)} 与 ${esc(partner.name)} 的跨城协议"
            >与${esc(partner.name)}协商（演示）</button>`,
          )
          .join('')}
      </div>
      <div class="agreement-list">
        ${agreements.length > 0 ? agreements.map(agreementCard).join('') : '<p class="fin-hint">暂无协议记录；可先与伙伴城市协商。</p>'}
      </div>
      <p class="fin-hint">只有在协议生效且参与企业接受后，条目才逐月执行；协商中、拒绝或取消都不会产生买卖义务。</p>
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
    ${renderMayorDemo(store, city)}
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
      ${renderPopulationSection(city)}
      ${renderPulse(city)}
    </section>
    ${renderSystems(city)}
    ${renderMarket(city, state.showAllGoods)}
    ${renderCompanies(store, city, state.focusCompanyId)}
    ${renderTradeSummary(store)}
    ${renderAgreementsSection(store, city)}`;
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
  const securities = store.securitiesView(company.id);
  const governance = store.governanceView(company.id);
  const price = securities.price;
  const stake = securities.playerStake;
  const recipe = RECIPES[company.recipeOutput];
  const roleKeys = Object.keys(company.roles) as (keyof Company['roles'])[];
  const roleTotal = roleKeys.reduce((total, key) => total + company.roles[key], 0);
  const playerCash = store.world.player.cash;
  const lastMonth = company.lastMonth;

  const shareClasses = store.world.securities.classes.filter(
    (shareClass) => shareClass.companyId === company.id,
  );
  const votingIssued = shareClasses
    .filter((shareClass) => shareClass.kind === 'voting')
    .reduce((total, shareClass) => total + shareClass.issuedShares, 0);
  const nonVotingIssued = shareClasses
    .filter((shareClass) => shareClass.kind === 'nonVoting')
    .reduce((total, shareClass) => total + shareClass.issuedShares, 0);
  const totalShares =
    company.totalShares > 0 ? company.totalShares : votingIssued + nonVotingIssued;
  const playerTotalShares = securities.playerShares;
  const playerVotingShares = securities.playerVotingShares;
  const playerNonVotingShares = Math.max(0, playerTotalShares - playerVotingShares);
  const canVote = playerVotingShares > 0;

  const holdersHtml =
    securities.holders.length === 0
      ? '<tr><td class="mini-empty" colspan="4">暂无股东记录。</td></tr>'
      : securities.holders
          .map((entry) => {
            const isPlayer = entry.holder.type === 'player';
            const ratio = totalShares > 0 ? entry.totalShares / totalShares : 0;
            const label = holderLabel(store, entry.holder);
            return `
              <tr class="${isPlayer ? 'is-player' : ''}">
                <th scope="row" title="${esc(label)}">${esc(label)}</th>
                <td>${num(entry.votingShares)}</td>
                <td>${num(entry.nonVotingShares)}</td>
                <td>${pct(ratio, 2)}</td>
              </tr>`;
          })
          .join('');

  const seatsByHolder = new Map<
    string,
    { holder: HolderRef; count: number; votingShares: number }
  >();
  for (const seat of governance.board?.seats ?? []) {
    const key = holderKey(seat.holder);
    const entry = seatsByHolder.get(key) ?? {
      holder: seat.holder,
      count: 0,
      votingShares: 0,
    };
    entry.count += 1;
    entry.votingShares += seat.votingShares;
    seatsByHolder.set(key, entry);
  }
  const seats = [...seatsByHolder.values()].sort(
    (a, b) => b.count - a.count || b.votingShares - a.votingShares,
  );
  const chairKey = governance.board?.chair ? holderKey(governance.board.chair) : null;
  const seatsHtml =
    seats.length === 0
      ? '<span class="fin-hint">暂无董事席位。</span>'
      : seats
          .map((entry) => {
            const key = holderKey(entry.holder);
            const isChair = key === chairKey;
            return `<span class="gov-seat ${isChair ? 'is-chair' : ''}" title="${num(entry.votingShares)} 股表决权">
              <b>${esc(holderLabel(store, entry.holder))}</b>
              <em>${entry.count} 席</em>
              ${isChair ? '<span class="gov-chair">董事长</span>' : ''}
            </span>`;
          })
          .join('');

  const control = governance.control;
  const operatorLabel = control ? holderLabel(store, control.operator) : '职业经理人';
  const basisLabel = control?.basis === 'boardAppointment' ? '董事会任命' : '默认管理';

  const openMotions = governance.motions
    .filter((motion) => motion.status === 'open')
    .sort((a, b) => a.closesAtTick - b.closesAtTick)
    .slice(0, 3);
  const closedMotions = governance.motions
    .filter((motion) => motion.status !== 'open')
    .sort(
      (a, b) =>
        (b.decidedTick ?? b.closesAtTick) - (a.decidedTick ?? a.closesAtTick) ||
        a.id.localeCompare(b.id),
    )
    .slice(0, 2);

  const motionCard = (motion: Motion): string => {
    const forVotes = motion.votes.filter((vote) => vote.vote === 'for');
    const againstVotes = motion.votes.filter((vote) => vote.vote === 'against');
    const forWeight = forVotes.reduce((total, vote) => total + vote.votingShares, 0);
    const againstWeight = againstVotes.reduce((total, vote) => total + vote.votingShares, 0);
    const playerVote =
      motion.votes.find(
        (vote) => vote.holder.type === 'player' && vote.holder.id === 'player',
      )?.vote ?? null;
    const voteButtons =
      motion.status === 'open' && canVote
        ? `<div class="motion-actions" role="group" aria-label="对「${esc(motion.title)}」投票">
            ${(['for', 'against', 'abstain'] as const)
              .map(
                (vote) => `
                <button
                  type="button"
                  class="chip-btn vote-btn ${playerVote === vote ? 'is-selected' : ''}"
                  data-action="vote-motion"
                  data-motion-id="${esc(motion.id)}"
                  data-vote="${vote}"
                  data-focus-key="motion-${esc(motion.id)}-${vote}"
                  aria-pressed="${playerVote === vote}"
                  title="${VOTE_LABELS[vote]}（演示：按你的表决权计票）"
                >${VOTE_LABELS[vote]}</button>`,
              )
              .join('')}
          </div>`
        : '';
    const result =
      motion.status !== 'open' && motion.result
        ? `<p class="motion-result">${esc(motion.result)}</p>`
        : '';
    return `
      <article class="motion-card status-${motion.status}">
        <div class="motion-head">
          <b>${esc(motion.title)}</b>
          <span class="motion-state">${MOTION_STATUS_LABELS[motion.status]}</span>
        </div>
        <div class="motion-meta">
          <span>截止 T${motion.closesAtTick}</span>
          <span>赞成 ${forVotes.length} 票 · ${num(forWeight)} 权</span>
          <span>反对 ${againstVotes.length} 票 · ${num(againstWeight)} 权</span>
        </div>
        <p class="motion-note">${esc(motion.note)}</p>
        ${result}
        ${voteButtons}
      </article>`;
  };

  const buyLimit = limitPriceFor(price, 'buy');
  const sellLimit = limitPriceFor(price, 'sell');
  const orderRows =
    securities.orders.length === 0
      ? '<tr><td class="mini-empty" colspan="5">暂无挂单。</td></tr>'
      : securities.orders
          .slice(0, 6)
          .map((order) => {
            const kind = shareClasses.find(
              (shareClass) => shareClass.id === order.shareClassId,
            )?.kind;
            return `
              <tr>
                <td class="${order.side === 'buy' ? 'is-buy' : 'is-sell'}">${order.side === 'buy' ? '买入' : '卖出'}</td>
                <td>${kind ? shareKindLabel(kind) : '股份'}</td>
                <td>${num(order.shares)}</td>
                <td>${num(order.limitPrice, 2)}</td>
                <td>T${order.createdTick}</td>
              </tr>`;
          })
          .join('');

  const tradeRows = (['voting', 'nonVoting'] as const)
    .flatMap((kind) =>
      (['buy', 'sell'] as const).map((side) => {
        const limit = side === 'buy' ? buyLimit : sellLimit;
        const actionLabel = side === 'buy' ? '买入' : '卖出';
        return `
          <div class="trade-row">
            <span class="trade-row-label">${shareKindLabel(kind)} · ${actionLabel}<em>限价 ${limit}</em></span>
            <div class="trade-btns">
              ${[100, 1000]
                .map(
                  (shares) => `
                  <button
                    type="button"
                    class="ken-btn ken-btn--mini ${side === 'buy' ? 'ken-btn--green' : 'ken-btn--grey'}"
                    data-action="trade-shares"
                    data-company-id="${esc(company.id)}"
                    data-kind="${kind}"
                    data-side="${side}"
                    data-shares="${shares}"
                    data-limit-price="${limit}"
                    data-focus-key="trade-${esc(company.id)}-${kind}-${side}-${shares}"
                    title="${actionLabel} ${num(shares)} 股${shareKindLabel(kind)}股份，限价 ${limit} 信用点 / 股（演示）"
                    aria-label="${actionLabel} ${num(shares)} 股${shareKindLabel(kind)}股份，限价 ${limit} 信用点每股"
                  >${num(shares)} 股</button>`,
                )
                .join('')}
            </div>
          </div>`;
      }),
    )
    .join('');

  const offersHtml =
    securities.offers.length === 0
      ? '<p class="fin-hint">暂无待处理的融资要约。</p>'
      : securities.offers
          .map((offer) => {
            const fromPlayer = offer.investor.type === 'player';
            return `
              <div class="offer-card">
                <div class="offer-head">
                  <b>${esc(holderLabel(store, offer.investor))}</b>
                  <span>${offer.kind === 'voting' ? '有表决权' : '仅分红'}</span>
                </div>
                <div class="offer-meta">出资 ${money(offer.amount)} · ${num(offer.shares)} 股 · ${num(offer.pricePerShare, 2)} / 股 · T${offer.createdTick}</div>
                <p class="offer-note">${esc(offer.note)}</p>
                ${
                  fromPlayer
                    ? `<div class="offer-actions">
                        <button type="button" class="ken-btn ken-btn--green ken-btn--mini" data-action="accept-offer" data-offer-id="${esc(offer.id)}" data-company-id="${esc(company.id)}" data-focus-key="accept-offer-${esc(offer.id)}" title="接受这份融资要约；资金进入企业，你获得对应股份">接受要约</button>
                        <button type="button" class="ken-btn ken-btn--grey ken-btn--mini" data-action="decline-offer" data-offer-id="${esc(offer.id)}" data-company-id="${esc(company.id)}" data-focus-key="decline-offer-${esc(offer.id)}" title="拒绝这份融资要约；没有资金或股份变化">拒绝</button>
                      </div>`
                    : '<p class="fin-hint">这份要约由其他出资方提出，只有该出资方可以处理。</p>'
                }
              </div>`;
          })
          .join('');

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
          <small>${num(playerTotalShares)} 股</small>
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
              <tr><td>其中玩家</td><td title="按本月实际股息 × 当前持股比例估算；实际入账见事件日志">${money(lastMonth.dividendsPaid * stake)}</td></tr>
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
      <section class="detail-subsection" data-testid="company-holders">
        <div class="sub-head">
          <h4>股权结构</h4>
          <span>账面价 ${num(price, 2)}</span>
        </div>
        <div class="sec-issued">
          <span>有表决权 <b>${num(votingIssued)}</b> 股</span>
          <span>仅分红 <b>${num(nonVotingIssued)}</b> 股</span>
        </div>
        <div class="table-wrap">
          <table class="sec-table" aria-label="${esc(company.name)} 股东结构">
            <thead>
              <tr>
                <th scope="col">持有人</th>
                <th scope="col">表决权</th>
                <th scope="col">仅分红</th>
                <th scope="col">占比</th>
              </tr>
            </thead>
            <tbody>${holdersHtml}</tbody>
          </table>
        </div>
        <p class="holding-line ${playerTotalShares > 0 ? 'is-player' : ''}">
          你的持股 <b>${num(playerTotalShares)}</b> 股
          <span>表决权 <b>${num(playerVotingShares)}</b> 股</span>
          <span>占比 <b>${pct(stake, 2)}</b></span>
        </p>
        <p class="fin-hint">企业作为买方只能持有有表决权股份；居民投资实体只展示汇总持股，不展示内部明细。</p>
      </section>

      <section class="detail-subsection" data-testid="company-governance">
        <div class="sub-head">
          <h4>董事会与经营控制</h4>
          <span class="mini-tag">演示规则</span>
        </div>
        <div class="gov-operator">
          <span>经营者</span>
          <b>${esc(operatorLabel)}</b>
          <em>${basisLabel}</em>
        </div>
        <div class="gov-seats">${seatsHtml}</div>
        <p class="fin-hint">持股产生表决权与董事席位；经营控制权默认属于职业经理人，须经议案表决才能变更（演示规则）。</p>
        ${
          canVote
            ? `<div class="gov-actions">
                <button
                  type="button"
                  class="ken-btn ken-btn--blue ken-btn--mini"
                  data-action="propose-operator"
                  data-company-id="${esc(company.id)}"
                  data-operator="player"
                  data-focus-key="propose-player-${esc(company.id)}"
                  title="提出由玩家经营企业的议案；需表决通过（演示）"
                >提议由玩家经营（演示）</button>
                <button
                  type="button"
                  class="ken-btn ken-btn--grey ken-btn--mini"
                  data-action="propose-operator"
                  data-company-id="${esc(company.id)}"
                  data-operator="management"
                  data-focus-key="propose-management-${esc(company.id)}"
                  title="提出恢复职业经理人经营的议案；需表决通过（演示）"
                >提议恢复职业经理人</button>
              </div>
              <p class="gov-vote-note">需表决通过；通过前经营者不变。</p>`
            : '<p class="fin-hint">你没有该公司的表决权，无法发起经营者议案。</p>'
        }
      </section>

      <section class="detail-subsection" data-testid="company-motions">
        <div class="sub-head">
          <h4>议案与表决</h4>
          <span>${openMotions.length} 项待表决</span>
        </div>
        <div class="motion-group">
          <span class="motion-group-label">待表决</span>
          ${openMotions.length > 0 ? openMotions.map(motionCard).join('') : '<p class="fin-hint">暂无待表决议案。</p>'}
        </div>
        ${
          closedMotions.length > 0
            ? `<div class="motion-group">
                <span class="motion-group-label">最近结束</span>
                ${closedMotions.map(motionCard).join('')}
              </div>`
            : ''
        }
        ${canVote ? '' : '<p class="fin-hint">你没有该公司的表决权，不会收到表决要求。</p>'}
      </section>

      <section class="detail-subsection" data-testid="company-trading">
        <div class="sub-head">
          <h4>股票交易</h4>
          <span>账面价 ${num(price, 2)}</span>
        </div>
        <div class="trade-holdings">
          <span>有表决权 <b>${num(playerVotingShares)}</b> 股</span>
          <span>仅分红 <b>${num(playerNonVotingShares)}</b> 股</span>
        </div>
        <div class="table-wrap">
          <table class="trade-table" aria-label="${esc(company.name)} 股票挂单">
            <thead>
              <tr>
                <th scope="col">方向</th>
                <th scope="col">类别</th>
                <th scope="col">剩余</th>
                <th scope="col">限价</th>
                <th scope="col">下单</th>
              </tr>
            </thead>
            <tbody>${orderRows}</tbody>
          </table>
        </div>
        <p class="fin-hint">一级融资（注资）资金进入企业；二级买卖资金只进入卖方，企业不会因此获得资金。</p>
        <div class="trade-grid" role="group" aria-label="二级市场下单">
          ${tradeRows}
        </div>
        <div class="offer-block">
          <div class="sub-head">
            <h4>融资要约</h4>
            <span>${securities.offers.length} 条待处理</span>
          </div>
          ${offersHtml}
        </div>
      </section>
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
    ${renderMayorDemo(store, city)}
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
      ${renderPopulationSection(city)}
      ${renderPulse(city)}
    </section>
    ${renderSystems(city)}
    ${renderMarket(city, state.showAllGoods)}
    ${renderAgreementsSection(store, city)}`;
}

function isPlayerFacingLog(message: string): boolean {
  return !/不变量|事务|校验|invariant|transaction/i.test(message);
}

export function renderLogDock(store: GameStore, collapsed: boolean): string {
  const totals = worldTotals(store.world, store.playerNetWorth);
  const lastDividend = store.world.player.dividendsReceived ?? store.world.player.lastDividend ?? 0;
  const logs = store.world.log
    .filter((entry) => entry.kind !== 'system' && isPlayerFacingLog(entry.message))
    .slice(-14)
    .reverse();
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
        <div class="snap is-player" title="玩家至今累计实际收到的股息（不是企业股息总额）"><span>累计玩家分红</span><b>${money(lastDividend)}</b></div>
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
