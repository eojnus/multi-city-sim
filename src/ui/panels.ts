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
  MotionKind,
  ShareKind,
  TradeAgreement,
} from '../simulation/contracts/types';
import type {
  GameStore,
  LayerMode,
  ViewMode,
} from '../app/gameStore';
// v1.4 只读视图：投资实体的净资产/债券估值/有效份额与 AI 政府经济体检都在模拟层计算，
// 面板只做展示，不在这里重算财富或政策效果（口径与月度报告/CLI 报告一致）。
import { investorFundingReport } from '../simulation/investors/investors';
import { latestCheckup, unemploymentTierLabel } from '../simulation/policies/ai-labor';
import { lockedInitialEquipmentUnits } from '../simulation/equipment/equipment';
import {
  maintenanceArrearsOf,
  maintenanceBreakdown,
} from '../simulation/equipment/maintenance';
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
  signedPct,
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
      '以城市 GDP 与人口体量读图；城市地图按街区地价系数着色，商务与办公区更亮。',
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

const POLICY_DOMAIN_LABELS: Record<string, string> = {
  employment: '就业',
  enterprise: '企业',
  industry: '产业',
  technology: '科技',
  trade: '贸易',
  welfare: '民生',
  fiscal: '财政',
};

/** v1.4：居民群体职业标签（配置里的只读展示名；occupation 是字符串枚举）。 */
const HOUSEHOLD_OCCUPATION_LABELS: Record<string, string> = DEMO_CONFIG.households.labels;

const FISCAL_KIND_LABELS: Record<string, string> = {
  incomeTax: '个人所得税',
  corporateTax: '企业所得税',
  publicWages: '公共部门工资',
  benefits: '居民转移支付',
  policySpending: '政策支出',
  policyTransfer: '政策拨款',
  transportConstruction: '交通建设',
  transportMaintenance: '交通维护',
  debtForgiven: '债务减免',
  liquidationProceeds: '企业退出清算',
  dividendIncome: '政府股息收入',
  electionFee: '参选费用',
  // v0.7 财政融资与债券（FiscalEntry.kind 扩展）。
  governmentLoanProceeds: '政府借款',
  governmentLoanRepayment: '政府还本',
  governmentLoanInterest: '政府付息',
  bondIssuanceProceeds: '债券发行',
  bondInterest: '债券票息',
  bondPrincipal: '债券本金兑付',
  bankAdvance: '银行垫付',
  debtWriteOff: '债务勾销',
};

const FOUNDER_LABELS: Record<string, string> = {
  investorGroup: '居民投资群体',
  company: '现有企业',
  government: '市政府',
};

const TRANSPORT_MODE_LABELS: Record<string, string> = {
  road: '公路',
  rail: '铁路',
};

// ---- v0.7 财政风险与债券展示文案（风险用「文字 + 图标 + 颜色」三重表达，不只靠颜色） ----
const FISCAL_RISK_LABELS: Record<'normal' | 'watch' | 'high' | 'bankrupt', string> = {
  normal: '正常',
  watch: '关注',
  high: '高风险',
  bankrupt: '已破产',
};
const FISCAL_RISK_ICONS: Record<'normal' | 'watch' | 'high' | 'bankrupt', string> = {
  normal: '●',
  watch: '▲',
  high: '▲',
  bankrupt: '✖',
};
const FISCAL_RISK_CLASSES: Record<'normal' | 'watch' | 'high' | 'bankrupt', string> = {
  normal: 'is-good',
  watch: 'is-warn',
  high: 'is-warn',
  bankrupt: 'is-bad',
};
const FISCAL_TREND_LABELS: Record<'up' | 'down' | 'flat' | 'unknown', string> = {
  up: '↑ 上升（较上月变差）',
  down: '↓ 下降（较上月改善）',
  flat: '→ 持平',
  unknown: '— 无可比上月',
};
const BOND_STATUS_LABELS: Record<'offering' | 'active' | 'redeemed', string> = {
  offering: '认购中',
  active: '存续中',
  redeemed: '已兑付',
};

const EFFECT_LABELS: Record<string, string> = {
  paid: '已支付',
  invested: '投资额',
  reservedWages: '预留工资',
  publicWagePaid: '公共工资实付',
  spentThisMonth: '本月支出',
  expectedClaim: '资金需求',
  hiresSubsidised: '补贴新员工',
  employeesRetained: '稳岗人数',
  trained: '结训人次',
  skillGain: '技能提升',
  companiesHelped: '受助企业',
  companiesSupported: '支持企业',
  points: '研究点',
  unitsBuilt: '新建住房',
  jobsCreated: '新增岗位',
  jobs: '公共岗位',
  peopleHelped: '受助居民',
  incomeRateDelta: '个税变化',
  corporateRateDelta: '企税变化',
  productivityBonus: '生产率加成',
};

// 财政金额型效果：非市长视图与渲染里一律剔除（v1.5 §1）。
const MONEY_EFFECTS = new Set([
  'paid',
  'invested',
  'reservedWages',
  'publicWagePaid',
  'spentThisMonth',
  'expectedClaim',
]);
const RATE_EFFECTS = new Set(['incomeRateDelta', 'corporateRateDelta', 'productivityBonus', 'skillGain']);

function policyDomainLabel(domain: string): string {
  return POLICY_DOMAIN_LABELS[domain] ?? domain;
}

function fiscalKindLabel(kind: string): string {
  return FISCAL_KIND_LABELS[kind] ?? '财政收支';
}

function founderLabel(type: string): string {
  return FOUNDER_LABELS[type] ?? type;
}

function transportModeLabel(mode: string): string {
  return TRANSPORT_MODE_LABELS[mode] ?? mode;
}

function effectValue(key: string, value: number): string {
  if (!Number.isFinite(value)) return '—';
  if (MONEY_EFFECTS.has(key)) return money(value);
  if (RATE_EFFECTS.has(key)) {
    const sign = value > 0 ? '+' : '';
    // 技能提升是 0–1 的比例；其他比率量级更小，用百分比统一展示。
    return `${sign}${(value * 100).toFixed(2)}%`;
  }
  if (Number.isInteger(value)) return num(value);
  const rounded = Math.round(value * 100) / 100;
  if (rounded === 0 && value !== 0) return '不足 0.01';
  return num(rounded, 2);
}

/** 生效政策效果摘要：金额取整、其他最多两位小数，并隐藏内部字段。 */
function effectSummary(effects: Record<string, number>): string {
  const entries = Object.entries(effects).filter(
    ([key, value]) => key !== 'passiveTick' && Number.isFinite(value),
  );
  if (entries.length === 0) return '本月暂无效果记录';
  return entries.map(([key, value]) => `${EFFECT_LABELS[key] ?? '效果'} ${effectValue(key, value)}`).join(' · ');
}

// ---- v1.5 §1：非市长财政信息隔离（在渲染层根本不生成受限内容，不靠 CSS 隐藏） ----

/**
 * 市长专属财政口径关键词：债务/GDP、债务预警、政策预算、参考税收、财政收支。
 * AI 体检的公开症状与 AI 决策原因里若出现这些片段，非市长一律过滤掉。
 */
const RESTRICTED_FISCAL_TEXT = /债务|预算|税收|财政/;

/** 公开症状：剔除债务/预算/税收/财政口径条目（保留高失业、缺货、招聘受阻等公开事实）。 */
function publicSymptoms(symptoms: readonly string[]): string[] {
  return symptoms.filter((symptom) => !RESTRICTED_FISCAL_TEXT.test(symptom));
}

/** 公开的 AI 决策原因：保留失业/供需/招聘等公开依据，剔除财政口径片段。 */
function publicPolicyReason(reason: string): string {
  const kept = reason
    .split('；')
    .map((segment) => {
      if (segment.startsWith('症状：')) {
        const symptoms = segment
          .slice('症状：'.length)
          .split('、')
          .filter((symptom) => !RESTRICTED_FISCAL_TEXT.test(symptom));
        return symptoms.length > 0 ? `症状：${symptoms.join('、')}` : '';
      }
      return RESTRICTED_FISCAL_TEXT.test(segment) ? '' : segment;
    })
    .filter((segment) => segment.trim().length > 0);
  return kept.length > 0 ? kept.join('；') : '政府已选择该政策（详细财政依据仅市长可见）';
}

/** 公开政策效果：去掉金额型字段（已支付/投资额），非市长只看非财政效果。 */
function publicEffectSummary(effects: Record<string, number>): string {
  const publicEntries = Object.fromEntries(
    Object.entries(effects).filter(([key]) => !MONEY_EFFECTS.has(key)),
  );
  const summary = effectSummary(publicEntries);
  return summary === '本月暂无效果记录' ? '财政效果仅市长可见' : summary;
}

/**
 * 政策不可用原因面向玩家，只保留简短中文；
 * 具体错误文本（内部校验、资金算式）不直接展示。
 */
function shortPolicyReason(reason: string): string {
  const text = reason.trim();
  if (!text) return '';
  if (text.includes('已有正在执行')) return '该政策正在执行';
  const cooldown = text.match(/还需\s*(\d+)\s*个月/);
  if (text.includes('冷却')) return `冷却中，还需 ${cooldown?.[1] ?? '数'} 个月`;
  if (text.includes('已达上限')) return '同时执行的政策已达上限';
  if (text.includes('财政资金不足')) return '财政资金不足';
  if (text.includes('低于最低额')) return '预算低于最低额';
  if (text.includes('不存在') || text.includes('未知') || text.includes('无效')) return '当前不可用';
  return text.length > 26 ? `${text.slice(0, 26)}…` : text;
}


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
  if (holder.type === 'city') {
    const city = store.world.cities.find((candidate) => candidate.id === holder.id);
    return city ? `${city.name}市政府` : '城市政府';
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
          <span>劳动力 <b>${num(city.population.laborForce)}</b></span>
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

export function renderCityIdentity(store: GameStore, city: City, options: { enter: boolean }): string {
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

export function renderKpis(store: GameStore, city: City): string {
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
      <div
        class="kpi kpi--link"
        role="button"
        tabindex="0"
        data-action="show-companies"
        data-testid="kpi-companies"
        title="点击跳到企业列表（财政余额属于市长专属信息，不在此展示）"
      >
        <span>企业数量</span>
        <b>${num(store.companiesForCity(city.id).length)} 家</b>
        <small>点击查看企业列表</small>
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
      <div class="info-row"><span>税率（个税 · 企税）</span><b>${pct(city.incomeTaxRate, 0)} · ${pct(city.corporateTaxRate, 0)}</b></div>
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
  // 生产构建移除演示入口（补充指令 §7 / DECISIONS v1.1 #15）；仅开发构建保留，并带 DEV 水印。
  if (!import.meta.env.DEV) return '';
  const active = store.mayorCityId === city.id;
  return `
    <div class="mayor-demo ${active ? 'is-active' : ''}">
      <span class="mayor-demo-kicker" aria-hidden="true">DEV ONLY · 调试后门</span>
      <button
        type="button"
        class="mayor-demo-btn"
        data-action="toggle-mayor-demo"
        data-city-id="${esc(city.id)}"
        data-testid="mayor-demo-toggle"
        data-focus-key="mayor-${esc(city.id)}"
        aria-pressed="${active}"
        title="${active ? `退出 ${esc(city.name)} 市长演示身份` : '直接以市长身份查看政策面板，不代表选举结果'}"
      >${active ? '退出市长演示' : '以市长身份查看（演示）'}</button>
      ${
        active
          ? '<span class="mayor-demo-badge">演示：市长身份 · 仅开发构建 · 政策由你选择</span>'
          : '<span class="mayor-demo-hint">仅开发构建可用；正式版请通过「政府与政策」参选市长。</span>'
      }
    </div>`;
}

export function renderPulse(city: City): string {
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

export function renderSystems(store: GameStore, city: City): string {
  const politics = store.world.politics.cities.find((entry) => entry.cityId === city.id) ?? null;
  const isPlayerMayor = store.mayorCityId === city.id;
  const leaderName = isPlayerMayor ? '玩家（演示市长）' : politics?.leader?.name ?? '暂未产生';
  const leaderParty = isPlayerMayor ? '玩家执政' : politics?.leader?.party ?? '—';
  const termMonths = politics?.termMonthsLeft ?? 0;
  const techActive = city.technology.status === 'active' || city.technology.level > 1;
  return `
    <section class="panel-section">
      <div class="section-head">
        <div>
          <span class="kicker">POLICY-DRIVEN SYSTEMS</span>
          <h2>科技 · 政治 · 房地产</h2>
        </div>
        <span class="status-badge is-active">已接入（演示）</span>
      </div>
      <div class="system-grid">
        <div class="system-card">
          <h3>科技</h3>
          <span class="system-status">${techActive ? '随研发政策变化' : '待研发投入'}</span>
          <div class="system-values">
            <span>等级 <b>Lv.${num(city.technology.level)}</b></span>
            <span>生产率 <b>×${city.technology.productivityMultiplier.toFixed(3)}</b></span>
            <span>研究点 <b>${num(city.technology.researchPoints)}</b></span>
          </div>
          <p class="system-note">研发资助会把财政投入转为研究点，累计到阈值后提升等级与生产率；教育投入则缓慢提高劳动力技能。</p>
        </div>
        <div class="system-card">
          <h3>政治</h3>
          <span class="system-status">${isPlayerMayor ? '玩家在任' : '民选政府'}</span>
          <div class="system-values">
            <span>领导人 <b>${esc(leaderName)}</b></span>
            <span>党派 <b>${esc(leaderParty)}</b></span>
            <span>任期 <b>${termMonths} 个月</b></span>
            <span>支持率 <b>${pct(city.politics.approval / 100, 0)}</b></span>
          </div>
          <p class="system-note">${esc(city.politics.note)}</p>
        </div>
        <div class="system-card">
          <h3>房地产</h3>
          <span class="system-status">最小住房机制</span>
          <div class="system-values">
            <span>均价 <b>${money(city.realEstate.avgHomePrice)}</b></span>
            <span>租金指数 <b>${num(city.realEstate.rentIndex)}</b></span>
            <span>空置率 <b>${pct(city.realEstate.vacancyRate)}</b></span>
          </div>
          <p class="system-note">住房支持会建设住房单元并发放租金补贴，影响住房存量与租金指数；住房买卖尚未接入。</p>
        </div>
      </div>
      <p class="note">政治由选举模块推进，科技随研发投入变化；以上仍是可替换的演示方案，不代表正式制度。</p>
    </section>`;
}

interface PolicyStartOptions {
  policyId: string;
  label: string;
  testId?: string;
  disabled?: boolean;
  disabledReason?: string;
  taxDirection?: string;
  transportTarget?: string;
  hint?: string;
  focusKey?: string;
}

function policyStartButton(options: PolicyStartOptions): string {
  const disabled = options.disabled === true;
  const attrs = [
    'type="button"',
    'class="ken-btn ken-btn--green ken-btn--mini policy-start"',
    'data-action="start-policy"',
    `data-policy-id="${esc(options.policyId)}"`,
    options.taxDirection ? `data-tax-direction="${esc(options.taxDirection)}"` : '',
    options.transportTarget ? `data-transport-target="${esc(options.transportTarget)}"` : '',
    options.testId ? `data-testid="${esc(options.testId)}"` : '',
    options.focusKey ? `data-focus-key="${esc(options.focusKey)}"` : '',
    disabled ? 'disabled' : '',
    `title="${esc(
      disabled
        ? options.disabledReason?.trim() || '当前不可用'
        : options.hint ?? `${options.label}（演示参数）`,
    )}"`,
  ]
    .filter(Boolean)
    .join(' ');
  return `<button ${attrs}>${esc(options.label)}</button>`;
}

interface InvestButtonOptions {
  target: string;
  testId: string;
  label: string;
  disabled: boolean;
  reason?: string;
  hint: string;
}

function investTransportButton(options: InvestButtonOptions): string {
  const attrs = [
    'type="button"',
    'class="ken-btn ken-btn--blue ken-btn--mini transport-invest-btn"',
    'data-action="invest-transport"',
    `data-target="${esc(options.target)}"`,
    `data-testid="${esc(options.testId)}"`,
    `data-focus-key="transport-${esc(options.target)}"`,
    options.disabled ? 'disabled' : '',
    `title="${esc(options.disabled ? options.reason?.trim() || '当前不可投资' : options.hint)}"`,
  ]
    .filter(Boolean)
    .join(' ');
  return `<button ${attrs}>${esc(options.label)}</button>`;
}


// ---------------------------------------------------------------- v1.7 §五：历史明细窗口与年度归档（只读展示）

/**
 * 历史数据治理（simulation/persistence/historyPolicy.ts）在月结时把超过保留窗口的
 * 只读明细归档为“年度/月度聚合”。这里只做两件事：
 * 1) 在“近期明细”面板明确标注保留窗口，说明更早数据已归档、不是丢失；
 * 2) 把语义明确的年度归档以只读“年度汇总（非逐笔）”折叠区块展示。
 * 不修改世界状态、不把汇总当逐笔明细、不补造缺失数据。
 */
interface AnnualArchiveRow {
  year: number;
  cells: string[];
}

/** 只读年度汇总表（第一列为年份；空数据显示真实空状态，不伪造行）。 */
function annualArchiveTable(
  headers: readonly string[],
  rows: readonly AnnualArchiveRow[],
  testId: string,
  emptyText: string,
): string {
  if (rows.length === 0) {
    return `<p class="fin-hint" data-testid="${esc(testId)}-empty">${esc(emptyText)}</p>`;
  }
  return `<div class="table-wrap">
    <table class="sec-table archive-table" data-testid="${esc(testId)}" aria-label="年度汇总（非逐笔）">
      <thead><tr><th scope="col">年份</th>${headers
        .map((header) => `<th scope="col">${esc(header)}</th>`)
        .join('')}</tr></thead>
      <tbody>${rows
        .map(
          (row) =>
            `<tr><td>${esc(String(row.year))} 年</td>${row.cells
              .map((cell) => `<td>${cell}</td>`)
              .join('')}</tr>`,
        )
        .join('')}</tbody>
    </table>
  </div>`;
}

/** 只读“年度汇总（非逐笔）”折叠区块；标题与说明都显式区分汇总与逐笔明细。 */
function annualArchiveBlock(options: {
  testId: string;
  title: string;
  note: string;
  body: string;
}): string {
  return `<details class="archive-block" data-testid="${esc(options.testId)}">
    <summary>${esc(options.title)}</summary>
    <p class="fin-hint archive-note">${esc(options.note)}</p>
    ${options.body}
  </details>`;
}

/** 财政流水年度归档（历史治理：城市×年×kind 聚合；仅市长可见，由调用点保证）。 */
function renderFiscalAnnualArchive(store: GameStore, city: City): string {
  const buckets = (store.world.fiscal.archivedLedger ?? []).filter(
    (entry) => entry.cityId === city.id,
  );
  const years = [...new Set(buckets.map((entry) => entry.year))].sort((a, b) => b - a);
  const rows: AnnualArchiveRow[] = years.map((year) => {
    const list = buckets.filter((entry) => entry.year === year);
    const count = list.reduce((sum, entry) => sum + entry.count, 0);
    const income = list.reduce((sum, entry) => sum + Math.max(0, entry.amount), 0);
    const expense = list.reduce((sum, entry) => sum + Math.max(0, -entry.amount), 0);
    return {
      year,
      cells: [num(count), money(income), money(expense), signedMoney(income - expense)],
    };
  });
  return annualArchiveBlock({
    testId: 'fiscal-annual-archive',
    title: '财政年度汇总（非逐笔）',
    note: `按 城市×年×科目 归档的流水合计（${city.name}）；这是年度汇总，不是逐笔明细，也不能替代对逐笔来源的核对。`,
    body: annualArchiveTable(
      ['笔数', '收入', '支出', '净额'],
      rows,
      'fiscal-annual-archive-table',
      '该城暂无已归档的财政流水年度汇总。',
    ),
  });
}

/** 债券兑付年度归档（历史治理：批次×持有人×年×kind 聚合；不展示破产垫付金额）。 */
function renderBondPaymentAnnualArchive(store: GameStore): string {
  // 公开汇总只含正常票息/到期兑付；破产处置兑付（银行垫付）金额属市长财政口径，不在此公开。
  const buckets = (store.world.bonds?.archivedPayments ?? []).filter(
    (entry) => entry.kind !== 'bankruptcyRedemption',
  );
  const years = [...new Set(buckets.map((entry) => entry.year))].sort((a, b) => b - a);
  const rows: AnnualArchiveRow[] = years.map((year) => {
    const list = buckets.filter((entry) => entry.year === year);
    const count = list.reduce((sum, entry) => sum + entry.count, 0);
    const principal = list.reduce((sum, entry) => sum + entry.principalPaid, 0);
    const interest = list.reduce((sum, entry) => sum + entry.interestPaid, 0);
    return { year, cells: [num(count), money(principal), money(interest)] };
  });
  return annualArchiveBlock({
    testId: 'bond-payment-annual-archive',
    title: '债券兑付年度汇总（非逐笔）',
    note: '按 批次×持有人×年×类型 归档的正常票息与到期兑付合计；不逐笔列示持有人，破产处置兑付（银行垫付）属市长财政口径，不在本公开汇总内。',
    body: annualArchiveTable(
      ['笔数', '本金', '利息'],
      rows,
      'bond-payment-annual-archive-table',
      '暂无已归档的债券兑付记录。',
    ),
  });
}

const MOTION_KIND_ARCHIVE_LABELS: Record<MotionKind, string> = {
  dividendPolicy: '分红政策',
  operatorAppointment: '经营者任命',
  operatorElection: '经营者选任',
};

/** 治理议案年度归档（历史治理：公司×年×kind 聚合；open 议案永不归档，仍在逐笔列表）。 */
function renderMotionAnnualArchive(store: GameStore, companyId: string): string {
  const buckets = (store.world.governance.motionYears ?? []).filter(
    (entry) => entry.companyId === companyId,
  );
  const years = [...new Set(buckets.map((entry) => entry.year))].sort((a, b) => b - a);
  const rows: AnnualArchiveRow[] = years.map((year) => {
    const list = buckets.filter((entry) => entry.year === year);
    let count = 0;
    let passed = 0;
    let rejected = 0;
    let votesFor = 0;
    let votesAgainst = 0;
    const kinds: string[] = [];
    for (const entry of list) {
      count += entry.count;
      passed += entry.passed;
      rejected += entry.rejected;
      votesFor += entry.votesFor;
      votesAgainst += entry.votesAgainst;
      kinds.push(MOTION_KIND_ARCHIVE_LABELS[entry.kind] ?? entry.kind);
    }
    return {
      year,
      cells: [
        esc([...new Set(kinds)].join('、') || '—'),
        num(count),
        num(passed),
        num(rejected),
        num(votesFor),
        num(votesAgainst),
      ],
    };
  });
  return annualArchiveBlock({
    testId: 'motion-annual-archive',
    title: '议案年度汇总（非逐笔）',
    note: '按 公司×年×类型 归档的已结束议案统计；待表决议案仍在逐笔列表中，不受归档影响。',
    body: annualArchiveTable(
      ['类型', '议案数', '通过', '否决', '赞成票', '反对票'],
      rows,
      'motion-annual-archive-table',
      '该公司暂无已归档的议案年度统计。',
    ),
  });
}

/** 结清贷款年度归档（银行贷款：全部主体、仅笔数；居民消费贷：本城×年×状态）。 */
function renderLoanAnnualArchive(store: GameStore, city: City): string {
  const bankBuckets = store.world.banking?.archivedLoans ?? [];
  const bankYears = [...new Set(bankBuckets.map((entry) => entry.year))].sort((a, b) => b - a);
  const bankRows: AnnualArchiveRow[] = bankYears.map((year) => {
    const list = bankBuckets.filter((entry) => entry.year === year);
    return {
      year,
      cells: [
        num(list.reduce((sum, entry) => sum + entry.count, 0)),
        num(list.length),
      ],
    };
  });
  const householdBuckets = (store.world.householdFinance?.archivedLoans ?? []).filter(
    (entry) => entry.cityId === city.id,
  );
  const householdYears = [...new Set(householdBuckets.map((entry) => entry.year))].sort(
    (a, b) => b - a,
  );
  const householdRows: AnnualArchiveRow[] = householdYears.map((year) => {
    const list = householdBuckets.filter((entry) => entry.year === year);
    const count = list.reduce((sum, entry) => sum + entry.count, 0);
    const principal = list.reduce((sum, entry) => sum + entry.principal, 0);
    const paidPrincipal = list.reduce((sum, entry) => sum + entry.paidPrincipal, 0);
    const paidInterest = list.reduce((sum, entry) => sum + entry.paidInterest, 0);
    return {
      year,
      cells: [num(count), money(principal), money(paidPrincipal), money(paidInterest)],
    };
  });
  return `<details class="archive-block" data-testid="bank-loan-annual-archive">
    <summary>结清贷款年度汇总（非逐笔）</summary>
    <p class="fin-hint archive-note">银行贷款归档按 年×借款人类别/用途 聚合（全部主体，只列笔数，避免暴露单个主体金额）；居民消费贷按 本城×年×状态 聚合。</p>
    <h5 class="archive-subhead">银行贷款（全部主体，仅笔数）</h5>
    ${annualArchiveTable(
      ['结清笔数', '聚合类别数'],
      bankRows,
      'bank-loan-annual-archive-table',
      '暂无已归档的银行贷款结清记录。',
    )}
    <h5 class="archive-subhead">居民消费贷（${esc(city.name)}）</h5>
    ${annualArchiveTable(
      ['结清笔数', '本金', '已还本金', '已还利息'],
      householdRows,
      'household-loan-annual-archive-table',
      '本城暂无已归档的居民消费贷结清记录。',
    )}
  </details>`;
}

export function renderGovernmentSection(store: GameStore, city: City): string {
  const view = store.policyView(city.id);
  const politics = store.world.politics.cities.find((entry) => entry.cityId === city.id) ?? null;
  const isPlayerMayor = view.isPlayerMayor;
  const leaderName = isPlayerMayor ? '玩家（演示市长）' : politics?.leader?.name ?? '暂未产生';
  const leaderParty = isPlayerMayor ? '玩家执政' : politics?.leader?.party ?? '—';
  const termMonths = Math.max(0, politics?.termMonthsLeft ?? 0);
  const electionCost = DEMO_CONFIG.politics.electionCost;
  // 财政流水属于市长专属信息（补充指令 §7）：非市长连数据都不取，避免模板层误用。
  const ledger = isPlayerMayor
    ? store.fiscalLedger.filter((entry) => entry.cityId === city.id).slice(0, 6)
    : [];
  const fiscalArchive = isPlayerMayor ? renderFiscalAnnualArchive(store, city) : '';

  const activeCards =
    view.active.length === 0
      ? '<p class="gov-empty">当前没有生效中的政策。</p>'
      : view.active
          .map((policy) => {
            const definition = view.definitions.find((entry) => entry.id === policy.policyId);
            const name = definition?.name ?? policy.policyId;
            // v1.4 §五：执行追踪只在真实发生月度执行后才有记录；没有记录不编造支出/受益/岗位。
            // v1.5 §1：支出/理论需求/实发/未支付属市长财政口径；非市长只保留公开执行事实
            // （时间、周期、受益人数、真实岗位、执行原因），HTML 里不出现任何金额。
            const latestRun = policy.tracking?.runs.at(-1) ?? null;
            const runHtml = latestRun
              ? `<div class="policy-run" data-testid="policy-run-${esc(policy.policyId)}">
                  <span>最近执行 <b>${esc(tickDate(latestRun.tick))}</b> · 周期 ${num(latestRun.periodMonths)} 个月</span>
                  ${
                    isPlayerMayor
                      ? `<span>支出 <b>${money(latestRun.spent ?? 0)}</b></span>`
                      : '<span>支出 <b>—</b><small>（仅市长可见）</small></span>'
                  }
                  <span>受益 <b>${num(latestRun.beneficiaries)}</b></span>
                  <span>真实岗位 <b class="${latestRun.jobsEffect > 0 ? 'is-positive' : ''}">${
                    latestRun.jobsEffect > 0 ? '+' : ''
                  }${num(latestRun.jobsEffect)}</b></span>
                  ${
                    isPlayerMayor && latestRun.theoreticalNeed != null
                      ? `<span>理论需求 ${money(latestRun.theoreticalNeed)} · 实发 ${money(
                          latestRun.paid ?? 0,
                        )} · 未支付 ${money(latestRun.unpaid ?? 0)}</span>`
                      : ''
                  }
                  ${
                    isPlayerMayor
                      ? `<span class="policy-run-source">来源：${esc(latestRun.fundingSource)}</span>`
                      : ''
                  }
                  <span class="policy-run-reason">${esc(
                    isPlayerMayor ? latestRun.reason : publicPolicyReason(latestRun.reason),
                  )}</span>
                </div>`
              : '<p class="policy-run-empty">尚无月度执行记录：政策启动后，首次真实执行会记录支出、受益与岗位效果（不预填数据）。</p>';
            return `
              <div class="policy-active-card" data-policy-id="${esc(policy.policyId)}">
                <div class="policy-active-head">
                  <b>${esc(name)}</b>
                  <span>剩余 ${Math.max(0, policy.monthsRemaining)} 个月</span>
                </div>
                <div class="policy-active-meta">
                  ${
                    isPlayerMayor
                      ? `已支出 <b>${money(policy.spent ?? 0)}</b> / 总预算 ${money(policy.budget ?? 0)}｜本月参考 <b>${money(
                          policy.referenceBudget ?? 0,
                        )}</b> · 预留 <b>${money(policy.reservedThisMonth ?? 0)}</b> · 未支付 <b>${money(
                          policy.unpaidThisMonth ?? 0,
                        )}</b> · 来源 ${esc(policy.fundingSourceThisMonth ?? '—')}`
                      : '<span class="is-restricted-inline">政策预算额度与城市财政流水仅该城市市长可见</span>'
                  }
                </div>
                <p class="policy-active-reason" data-testid="policy-reason-${esc(policy.policyId)}">启动原因：${esc(
                  isPlayerMayor ? policy.reason || '—' : publicPolicyReason(policy.reason || '—'),
                )}</p>
                <p class="policy-active-effect">${esc(
                  isPlayerMayor ? effectSummary(policy.effects) : publicEffectSummary(policy.effects),
                )}</p>
                ${runHtml}
                ${
                  isPlayerMayor
                    ? `<div class="policy-active-foot">
                        <button
                          type="button"
                          class="ken-btn ken-btn--grey ken-btn--mini"
                          data-action="stop-policy"
                          data-policy-id="${esc(policy.policyId)}"
                          data-testid="stop-policy-${esc(policy.policyId)}"
                          data-focus-key="stop-${esc(policy.policyId)}"
                          title="停止「${esc(name)}」；未使用预算不再支出"
                        >停止</button>
                      </div>`
                    : ''
                }
              </div>`;
          })
          .join('');

  const policyCards = view.definitions
    .map((definition) => {
      const reason = shortPolicyReason(definition.reason);
      const isTax = definition.id === 'taxAdjustment';
      const isTransport = definition.id === 'transportInvestment';
      const budgetLabel = isTax
        ? '不产生财政支出'
        : `${isTransport ? '参考预算' : '默认预算'} ${money(definition.defaultBudget ?? 0)}`;
      // 税收按税率方向执行、交通按工程造价出资，两者都不由玩家分配预算。
      const budgetField =
        isTax || isTransport
          ? ''
          : `<label class="policy-budget-field">
              <span>预算（信用点）</span>
              <input
                type="number"
                data-policy-budget="${esc(definition.id)}"
                data-testid="policy-budget-${esc(definition.id)}"
                data-default-budget="${definition.defaultBudget ?? 0}"
                min="0"
                step="10000"
                inputmode="numeric"
                value="${definition.defaultBudget ?? 0}"
                ${definition.available ? '' : 'disabled'}
              >
            </label>`;


      let buttons = '';
      if (isTax) {        buttons = [
          policyStartButton({
            policyId: definition.id,
            label: '上调税率',
            testId: `policy-${definition.id}`,
            focusKey: `policy-${definition.id}-raise`,
            disabled: !definition.available,
            disabledReason: reason,
            taxDirection: 'raise',
            hint: '个人所得税与企业所得税同时上调一档（演示）',
          }),
          policyStartButton({
            policyId: definition.id,
            label: '下调税率',
            testId: `policy-${definition.id}-cut`,
            focusKey: `policy-${definition.id}-cut`,
            disabled: !definition.available,
            disabledReason: reason,
            taxDirection: 'cut',
            hint: '个人所得税与企业所得税同时下调一档（演示）',
          }),
        ].join('');
      } else if (isTransport) {
        const transport = store.transportView(city.id);
        const network = transport.intracity;
        const road = network?.estimateRoad ?? null;
        const rail = network?.estimateRail ?? null;
        const constructionReason = network?.construction
          ? `城内${transportModeLabel(network.construction.kind)}正在建设中`
          : '';
        const roadReason = !road
          ? '暂无城内交通网络'
          : !road.ok
            ? constructionReason || '城内道路已达最高等级'
            : city.treasury < road.cost
              ? '财政资金不足'
              : '';
        const railReason = !rail
          ? '暂无城内交通网络'
          : !rail.ok
            ? constructionReason || '城内铁路已达最高等级'
            : city.treasury < rail.cost
              ? '财政资金不足'
              : '';
        const linkButtons = transport.links
          .filter((link) => link.estimate.ok)
          .map((link) =>
            policyStartButton({
              policyId: definition.id,
              label: `${cityName(store.world, link.partner)} · ${transportModeLabel(link.mode)} · ${money(link.estimate.cost)}`,
              transportTarget: link.id,
              focusKey: `policy-${definition.id}-${link.id}`,
              disabled: !definition.available || city.treasury < link.estimate.cost,
              disabledReason:
                city.treasury < link.estimate.cost ? '财政资金不足' : reason,
              hint: `升级 ${cityName(store.world, link.partner)} ${transportModeLabel(link.mode)}线路，工期 ${link.estimate.months} 个月`,
            }),
          )
          .join('');
        buttons = [
          policyStartButton({
            policyId: definition.id,
            label: `城内道路 · ${money(road?.cost ?? 0)}`,
            testId: `policy-${definition.id}`,
            focusKey: `policy-${definition.id}-road`,
            transportTarget: 'intracity:road',
            disabled: !definition.available || !road?.ok || city.treasury < (road?.cost ?? 0),
            disabledReason: roadReason || reason,
            hint: '由财政出资开工城内道路升级',
          }),
          policyStartButton({
            policyId: definition.id,
            label: `城内铁路 · ${money(rail?.cost ?? 0)}`,
            testId: `policy-${definition.id}-rail`,
            focusKey: `policy-${definition.id}-rail`,
            transportTarget: 'intracity:rail',
            disabled: !definition.available || !rail?.ok || city.treasury < (rail?.cost ?? 0),
            disabledReason: railReason || reason,
            hint: '由财政出资开工城内铁路升级',
          }),
          linkButtons,
        ].join('');
      } else {
        buttons = policyStartButton({
          policyId: definition.id,
          label: '启动',
          testId: `policy-${definition.id}`,
          focusKey: `policy-${definition.id}`,
          disabled: !definition.available,
          disabledReason: reason,
        });
      }

      return `
        <article class="policy-item ${definition.available ? '' : 'is-locked'}">
          <div class="policy-item-head">
            <b>${esc(definition.name)}</b>
            <span class="policy-domain">${esc(policyDomainLabel(definition.domain))}</span>
          </div>
          <p class="policy-target">作用对象：${esc(definition.target)}</p>
          <p class="policy-effect" title="${esc(definition.effect)}">${esc(definition.effect)}</p>
          <div class="policy-actions">
            ${budgetField}
            ${buttons}
            <span class="policy-budget">${esc(budgetLabel)}</span>
          </div>
          ${
            definition.available
              ? ''
              : `<p class="policy-why">${esc(reason || '当前不可用')}</p>`
          }
        </article>`;
    })
    .join('');

  // v1.5 §1：AI 政府经济体检拆成「公开」与「市长财政口径」两部分。
  // - 公开：失业档位/3 月均值/趋势/公开症状/就业与招聘/岗位空缺/食品供需；
  // - 受限（仅该城现任市长）：月政策预算与占比、参考税收月数与月均、债务/GDP 与 85% 预警、
  //   债券/贷款到期压力、财政余额、预算说明。
  // 非市长时受限数值根本不进入 HTML/属性，只渲染 fiscal-restricted 占位（不是 CSS 隐藏）。
  const checkup = latestCheckup(store.world, city.id);
  const warningLine = pct(DEMO_CONFIG.policies.aiLabor.debtWarningRatio, 0);
  const mayorStatusHtml = isPlayerMayor
    ? `<p class="ai-status" data-testid="ai-mayor-status"><b>AI 不代选政策</b>：你是本城现任市长，政策由你选择与停止，AI 不会替你选政策或替城市花钱。月度经济体检仍按真实数据生成，仅供背景参考。</p>`
    : '';
  const aiCheckupPublicHtml = checkup
    ? (() => {
        const publicSymptomList = publicSymptoms(checkup.symptoms);
        const symptomText =
          publicSymptomList.length > 0
            ? publicSymptomList.join('、')
            : checkup.symptoms.length > 0
              ? '财政口径症状仅市长可见'
              : '无明显症状';
        const foodCoverage = checkup.foodDemand > 0 ? checkup.foodInventory / checkup.foodDemand : null;
        return `
          <div class="ai-checkup-grid" data-testid="ai-checkup-public">
            <span data-testid="ai-checkup-tier"${
              checkup.tier !== 'normal' ? ' class="is-warn"' : ''
            }><i>失业档位</i><b>${esc(unemploymentTierLabel(checkup.tier))}</b><small>3 月均值 ${pct(
              checkup.unemploymentRateAvg3,
            )} · 原始档 ${esc(unemploymentTierLabel(checkup.rawTier))}${
              checkup.tier !== checkup.rawTier ? ' · 迟滞/开局上限生效' : ''
            }</small></span>
            <span><i>失业率 3 月均值</i><b>${pct(checkup.unemploymentRateAvg3)}</b><small>趋势 ${signedPct(
              checkup.unemploymentTrend,
            )}（环比前 3 月）</small></span>
            <span data-testid="ai-checkup-symptoms"><i>症结</i><b>${esc(
              symptomText,
            )}</b><small>按真实失业/供需/招聘判定</small></span>
            <span><i>就业 / 失业 / 劳动力</i><b>${num(checkup.employed)} / ${num(
              checkup.unemployed,
            )} / ${num(checkup.laborForce)}</b><small>真实人口口径</small></span>
            <span><i>上月招聘 / 裁员</i><b>${num(checkup.hires)} / ${num(
              checkup.layoffs,
            )}</b><small>创办 ${num(checkup.founded)} · 退出 ${num(checkup.closed)}</small></span>
            <span><i>岗位空缺</i><b>${num(checkup.vacancies)}</b><small>企业 + 公共部门未招满</small></span>
            <span><i>食品需求 / 产出</i><b>${qty(checkup.foodDemand)} / ${qty(
              checkup.foodOutput,
            )}</b><small>基本需要量 / 上月产出</small></span>
            <span><i>食品库存覆盖</i><b>${
              foodCoverage === null ? '—' : `${num(foodCoverage, 2)} 个月`
            }</b><small>库存 ${qty(checkup.foodInventory)} · 产能 ${qty(checkup.foodCapacity)}</small></span>
            <span><i>食品价格 / 未满足需求</i><b>${num(checkup.foodPrice, 2)} / ${qty(
              checkup.foodUnmetDemand,
            )}</b><small>价格单位信用点</small></span>
          </div>`;
      })()
    : '';
  const aiCheckupRestrictedHtml =
    checkup && isPlayerMayor
      ? `<div class="ai-checkup-restricted" data-testid="ai-checkup-restricted">
          <div class="sub-head"><span>财政口径</span><em>仅市长可见 · AI 决策参考</em></div>
          <div class="ai-checkup-grid">
            <span data-testid="ai-checkup-budget"><i>月政策预算</i><b>${money(
              checkup.budget,
            )}</b><small>占参考税收 ${pct(checkup.budgetShare)}</small></span>
            <span data-testid="ai-checkup-tax"><i>税收参考月数</i><b>真实 ${num(
              checkup.taxMonthsReal,
            )} 月 / 估算 ${num(checkup.taxMonthsEstimated)} 月</b><small>真实月均 ${money(
              checkup.monthlyTaxRevenueReal,
            )} · 估算 ${money(checkup.monthlyTaxRevenueEstimated)}/月</small></span>
            <span data-testid="ai-checkup-debt"${
              checkup.debtWarning ? ' class="is-warn"' : ''
            }><i>债务 / GDP</i><b>${pct(
              checkup.debtRatio,
            )}</b><small>${
              checkup.debtWarning
                ? `≥ ${warningLine} 预警线，长期承诺政策已缩减`
                : `预警线 ${warningLine}（非破产线）`
            }</small></span>
            <span data-testid="ai-checkup-due"><i>本月到期压力</i><b>${pct(
              checkup.debtServicePressure,
            )}</b><small>债券到期 ${money(checkup.bondDue)} · 贷款到期 ${money(
              checkup.loanDue,
            )}</small></span>
            <span data-testid="ai-checkup-treasury"><i>政府财政余额</i><b>${money(
              checkup.treasury,
            )}</b><small>体检时点可用资金</small></span>
          </div>
          <p class="ai-budget-note" data-testid="ai-checkup-budget-note">${esc(checkup.budgetNote)}</p>
        </div>`
      : '';
  const aiCheckupRestrictedPlaceholder =
    checkup && !isPlayerMayor
      ? `<div class="fiscal-brief is-restricted ai-checkup-restricted" data-testid="fiscal-restricted" data-restricted-scope="ai-checkup">
          <div class="gov-sub-head"><span>AI 体检 · 财政口径</span><em>仅市长可见</em></div>
          <p class="fiscal-empty">债务/GDP、债务预警、债券与贷款到期压力、月政策预算与参考税收仅该城市现任市长可见；公开信息见上方失业、招聘与食品供需。</p>
        </div>`
      : '';
  const aiGovernmentHtml = checkup
    ? `<div class="ai-government" data-testid="ai-government">
        <div class="sub-head"><span>AI 政府 · 经济体检</span><em>${esc(tickDate(checkup.tick))} 快照 · 只读</em></div>
        ${mayorStatusHtml}
        ${aiCheckupPublicHtml}
        ${isPlayerMayor ? aiCheckupRestrictedHtml : aiCheckupRestrictedPlaceholder}
        <p class="fin-hint">公开部分来自真实失业、招聘与食品供需；财政口径仅该城市现任市长可见，AI 不虚构支出、受益人数或岗位。</p>
      </div>`
    : `<div class="ai-government" data-testid="ai-government">
        <div class="sub-head"><span>AI 政府 · 经济体检</span><em>尚无记录</em></div>
        ${mayorStatusHtml}
        <p class="fin-hint" data-testid="ai-checkup-empty">本月经济体检尚未生成：AI 政府不会在没有体检数据时凭空选择政策。推进 1 个月后这里会显示失业档位、招聘与食品供需等公开指标。</p>
      </div>`;

  const ledgerRows =
    ledger.length === 0
      ? '<li class="fiscal-empty">本月暂无财政流水。</li>'
      : ledger
          .map(
            (entry) => `
            <li class="fiscal-row" title="${esc(entry.source)}">
              <span class="fiscal-kind">${esc(fiscalKindLabel(entry.kind))}</span>
              <span class="fiscal-source">${esc(entry.source)}</span>
              <b class="fiscal-amount ${signClass(entry.amount)}">${signedMoney(entry.amount)}</b>
            </li>`,
          )
          .join('');

  return `
    <section class="panel-section government-section" data-testid="government-section">
      <div class="section-head">
        <div>
          <span class="kicker">CITY GOVERNMENT</span>
          <h2>政府与政策</h2>
        </div>
        <span class="section-tag">${view.active.length} 项生效</span>
      </div>
      <div class="gov-summary">
        <div class="gov-row"><span>现任领导人</span><b>${esc(leaderName)}</b></div>
        <div class="gov-row"><span>党派</span><b>${esc(leaderParty)}</b></div>
        <div class="gov-row"><span>任期剩余</span><b>${termMonths} 个月</b></div>
        <div class="gov-row"><span>支持率</span><b>${pct(city.politics.approval / 100, 0)}</b></div>
      </div>
      <p class="gov-selection"><b>最近选择</b>${esc(
        isPlayerMayor ? view.lastSelection : publicPolicyReason(view.lastSelection),
      )}</p>
      ${
        isPlayerMayor
          ? `<p class="gov-mode is-player">政策由你选择；每次启动从城市财政支出，预算与期限为演示参数。</p>`
          : `<div class="gov-mode">
              <span>当前由政府自主施政；参选后可自己选择政策</span>
              <button
                type="button"
                class="ken-btn ken-btn--green ken-btn--mini"
                data-action="run-for-mayor"
                data-testid="run-for-mayor"
                data-focus-key="run-for-mayor"
                title="支付 ${money(electionCost)} 信用点参选费用并立即举行一次选举（演示规则）"
              >参选市长（${money(electionCost)}）</button>
            </div>`
      }
      ${aiGovernmentHtml}
      ${isPlayerMayor ? renderMayorFiscalPanel(store, city) : ''}
      ${isPlayerMayor ? renderCityTaxPanel(store, city) : ''}
      <div class="gov-active">
        <div class="gov-sub-head"><span>生效政策</span><em>${view.active.length} 项</em></div>
        ${activeCards}
      </div>
      ${
        isPlayerMayor
          ? `<div class="gov-policies">
              <div class="gov-sub-head"><span>可选政策</span><em>共 ${view.definitions.length} 项</em></div>
              <div class="policy-list" data-scroll="policies">${policyCards}</div>
              <p class="fin-hint">全部 ${view.definitions.length} 项政策均在列表中；同时生效的政策数量与冷却受演示规则限制。</p>
            </div>`
          : ''
      }
      ${
        isPlayerMayor
          ? `<div class="fiscal-brief" data-testid="fiscal-ledger">
              <div class="gov-sub-head"><span>财政流水 · 逐笔明细</span><em>最近 ${ledger.length} 条</em></div>
              <p class="fin-hint archive-note" data-testid="fiscal-ledger-window-note">仅显示最近 ${num(
                DEMO_CONFIG.history.fiscalDetailMonths,
              )} 个月逐笔明细（本面板取最近 ${ledger.length} 条）；更早财政流水已按 城市×年×科目 归档为年度汇总，不再逐笔展示。</p>
              <ul class="fiscal-list">${ledgerRows}</ul>
              ${fiscalArchive}
            </div>`
          : `<div class="fiscal-brief is-restricted" data-testid="fiscal-restricted">
              <div class="gov-sub-head"><span>财政流水</span><em>仅市长可见</em></div>
              <p class="fiscal-empty">财政余额、收支与流水明细仅该城市市长可见；公开信息见城市概况与债券市场。</p>
            </div>`
      }
    </section>`;
}

/** 开局估计月的 tick 为负，共用 tickDate 会把负 tick 夹到当前月，这里按自然月回推。 */
function gdpWindowDate(tick: number): string {
  if (tick >= 0) return tickDate(tick);
  const start = DEMO_CONFIG.simulation;
  const months = tick + start.startMonth - 1;
  const year = start.startYear + Math.floor(months / 12);
  const month = ((months % 12) + 12) % 12 + 1;
  return `${year}.${String(month).padStart(2, '0')}`;
}

/**
 * 市长财政面板（v0.7 块4，补充指令 §7 白名单）。
 *
 * 数据只来自 `store.fiscalView(city.id)`（契约投影，非市长返回 null），
 * 不直接读 city.treasury / city.government.*。
 * 12 个月逐月明细用 city.gdpWindow（公开的普通 GDP 历史），判定合计与债务率仍取视图字段。
 */
export function renderMayorFiscalPanel(store: GameStore, city: City): string {
  const view = store.fiscalView(city.id);
  if (!view) {
    return `
      <div class="fiscal-brief is-restricted" data-testid="fiscal-restricted">
        <div class="gov-sub-head"><span>财政面板</span><em>仅市长可见</em></div>
        <p class="fiscal-empty">可用资金、当月收支、银行贷款与债券本金、总负债、12 个月 GDP 判定合计、债务/GDP、风险等级与趋势、兑付计划均为市长专属信息，仅该城市现任市长可见。</p>
      </div>`;
  }

  const net = view.monthIncome - view.monthExpense;
  const windowPoints = [...(city.gdpWindow ?? [])].sort((a, b) => a.tick - b.tick);
  const windowRows =
    windowPoints.length === 0
      ? '<li class="fiscal-empty">尚无 GDP 窗口数据。</li>'
      : windowPoints
          .map(
            (point) => `
            <li class="gdp-window-row">
              <span>${esc(gdpWindowDate(point.tick))}</span>
              <b>${money(point.value)}</b>
              <em class="${point.estimated ? 'is-estimate' : 'is-real'}">${point.estimated ? '估计' : '真实'}</em>
            </li>`,
          )
          .join('');

  const loanCount = (city.government?.loans ?? []).filter((loan) => loan.status === 'active').length;
  const riskClass = FISCAL_RISK_CLASSES[view.riskLevel];
  const riskIcon = FISCAL_RISK_ICONS[view.riskLevel];
  const riskLabel = FISCAL_RISK_LABELS[view.riskLevel];
  const trendLabel = FISCAL_TREND_LABELS[view.riskTrend];

  const issuanceRows =
    view.issuances.length === 0
      ? '<tr><td colspan="9" class="fiscal-empty-cell">尚未发行债券。</td></tr>'
      : view.issuances
          .map(
            (issuance) => `
            <tr>
              <td>${esc(issuance.issuanceId)}</td>
              <td>${num(issuance.planUnits)}</td>
              <td>${num(issuance.soldUnits)}</td>
              <td>${num(issuance.unsoldUnits)}</td>
              <td>${money(issuance.principal)}</td>
              <td>${pct(issuance.couponRateAnnual, 2)} / ${num(issuance.interestPeriodMonths)} 月</td>
              <td>${esc(tickDate(issuance.maturityTick))}</td>
              <td>${
                issuance.closedTick === null
                  ? `发行中 · ${esc(tickDate(issuance.subscriptionCloseTick))} 月结关闭`
                  : `已关闭（${esc(tickDate(issuance.closedTick))}）`
              }</td>
              <td>${esc(BOND_STATUS_LABELS[issuance.status])}</td>
            </tr>`,
          )
          .join('');

  const maxPlanUnits = DEMO_CONFIG.government.bondMarket.maxPlanUnitsPerIssue;
  const faceValue = DEMO_CONFIG.government.bondMarket.faceValue;
  const bankruptNotice =
    view.bankruptcyStatus === 'bankrupt'
      ? `<div class="fiscal-alert is-bad" data-testid="fiscal-bankrupt-notice">
          <b>${riskIcon} 已发生破产事件</b>
          <p>判定月 ${view.bankruptcyTick === null ? '—' : esc(tickDate(view.bankruptcyTick))}，债务/GDP ${pct(view.debtRatio)} ≥ 100%。银行已立即兑付未到期债券本金与已计提未付利息，政府原有银行债务随之一并勾销并留痕；随后重新选举市长，过渡期由看守政府自主施政。</p>
        </div>`
      : '';

  return `
    <div class="fiscal-panel ${riskClass}" data-testid="mayor-fiscal-panel">
      <div class="gov-sub-head">
        <span>市长财政面板</span>
        <em class="fiscal-risk-badge ${riskClass}" data-testid="fiscal-risk-badge" title="风险等级：${esc(riskLabel)}；方向：${esc(trendLabel)}">
          <span aria-hidden="true">${riskIcon}</span>${esc(riskLabel)} · ${esc(trendLabel)}
        </em>
      </div>

      ${bankruptNotice}

      <div class="fiscal-kpi-grid">
        <div class="fiscal-kpi is-strong"><span>可用资金</span><b data-testid="fiscal-treasury">${money(view.treasury)}</b></div>
        <div class="fiscal-kpi"><span>当月收入</span><b class="is-good">+${money(view.monthIncome)}</b></div>
        <div class="fiscal-kpi"><span>当月支出</span><b class="is-bad">−${money(view.monthExpense)}</b></div>
        <div class="fiscal-kpi"><span>当月净额</span><b class="${net >= 0 ? 'is-good' : 'is-bad'}">${net >= 0 ? '+' : '−'}${money(Math.abs(net))}</b></div>
      </div>

      <div class="fiscal-debt-grid">
        <div><span>银行贷款</span><b>${money(view.bankLoanPrincipal)}</b><em>${num(loanCount)} 笔存续</em></div>
        <div><span>银行垫付本金</span><b>${money(view.bankAdvancePrincipal)}</b><em>到期/破产兑付形成</em></div>
        <div><span>在外债券本金</span><b>${money(view.bondPrincipalOutstanding)}</b><em>${num(view.issuances.filter((entry) => entry.status !== 'redeemed').length)} 批次存续</em></div>
        <div><span>应计未付利息</span><b>${money(view.loanAccruedInterest + view.bondAccruedInterest)}</b><em>贷款 ${money(view.loanAccruedInterest)} · 债券 ${money(view.bondAccruedInterest)}</em></div>
        <div class="is-strong"><span>总负债</span><b data-testid="fiscal-total-debt">${money(view.totalDebt)}</b><em>本金 + 应计未付利息</em></div>
      </div>

      <div class="fiscal-risk-row">
        <div><span>债务 / GDP</span><b data-testid="fiscal-debt-ratio">${pct(view.debtRatio)}</b><em>判定分母 ${money(view.gdpJudgementValue)}${view.gdpLowFallback ? '（GDP 极低，已用最低判定值）' : ''}</em></div>
        <div><span>风险等级</span><b class="${riskClass}">${riskIcon} ${esc(riskLabel)}</b><em>${esc(trendLabel)}</em></div>
        <div><span>上月同口径</span><b>${view.previousSettlementDebtRatio === null ? '—' : pct(view.previousSettlementDebtRatio)}</b><em>无上月数据时显示 —</em></div>
      </div>

      <details class="fiscal-gdp-window" data-testid="fiscal-gdp-window">
        <summary>12 个月 GDP 窗口 · 合计 ${money(view.gdpWindowSum)}（真实 ${num(view.gdpWindowMonths - view.gdpWindowEstimatedMonths)} 月 / 估计 ${num(view.gdpWindowEstimatedMonths)} 月）</summary>
        <ul class="gdp-window-list">${windowRows}</ul>
        <p class="fiscal-note">估计月是开局估算值（tick 为负），不是真实交易；判定合计 = 最近 ${num(view.gdpWindowMonths)} 个月之和，不足 12 个月时按实际月数汇总。</p>
      </details>

      <div class="fiscal-due-row">
        <div><span>本月应付项</span><b>${money(view.payablesDueThisMonth)}</b><em>票息 / 到期本金 / 贷款分期</em></div>
        <div><span>本月银行垫付</span><b class="${view.paidByAdvanceThisMonth > 0 ? 'is-warn' : ''}">${money(view.paidByAdvanceThisMonth)}</b><em>垫付转为政府贷款，计入总负债</em></div>
      </div>

      <p class="fiscal-note">
        兑付规则：票息每个付息周期支付一次（12/24/36 月各一期，M36 与到期本金同月各付一次）；
        到期时财政不足的部分由银行无条件垫付并转为政府借款，垫付金额计入总负债；
        票息到期财政不足时银行不垫付，欠付利息累计到批次，到期/破产时一并处理。
      </p>
      <p class="fiscal-note">
        破产规则：债务/GDP ≥ 100% 判定破产；银行立即兑付未到期债券本金与已计提未付利息（不付未来利息），
        随后政府银行债务一并勾销并留痕，触发重选。总负债 = 银行贷款未偿本金（含垫付）+ 未偿债券本金 + 已计提未付利息。
      </p>

      <div class="fiscal-issuance">
        <div class="gov-sub-head"><span>发债批次</span><em>计划 / 实售 / 未售分开列示</em></div>
        <div class="fiscal-table-wrap" data-scroll="fiscal-issuances">
          <table class="fiscal-table">
            <thead>
              <tr><th scope="col">批次</th><th scope="col">计划</th><th scope="col">实售</th><th scope="col">未售</th><th scope="col">形成本金</th><th scope="col">票息 / 周期</th><th scope="col">到期</th><th scope="col">认购窗口</th><th scope="col">状态</th></tr>
            </thead>
            <tbody>${issuanceRows}</tbody>
          </table>
        </div>
        <div class="bond-issue-form" data-city-id="${esc(city.id)}">
          <label>
            <span>计划份数（面额 ${money(faceValue)}/份）</span>
            <input
              type="number"
              data-bond-plan-units
              data-testid="bond-plan-units"
              min="1"
              max="${maxPlanUnits}"
              step="1"
              value="100"
              inputmode="numeric"
              title="计划份数 ${num(maxPlanUnits)} 份以内；未售出份数封闭后不形成债务"
            >
          </label>
          <button
            type="button"
            class="ken-btn ken-btn--gold ken-btn--mini"
            data-action="issue-bond"
            data-city-id="${esc(city.id)}"
            data-testid="issue-bond"
            data-focus-key="issue-bond"
            title="按当前计划份数发起一次发行；认购窗口为发行当月，下一次月结关闭"
          >发起发行</button>
        </div>
        <p class="fiscal-note">计划份数上限 ${num(maxPlanUnits)} 份；只有实际售出的份数形成本金，未售出份数关闭后记录但不形成债务。认购窗口为发行当月（下一次月结关闭）：玩家可在窗口内认购，窗口关闭前居民投资实体与企业会用自身资金认购剩余份数。</p>
      </div>
    </div>`;
}

/**
 * 债券市场（所有玩家可见的公开区）。
 * 只展示 PublicBondOfferView 白名单字段：不含计划总额、总售额与政府总债务。
 */
/**
 * 公开破产事件（§7：破产事件公开，非市长可见）。
 * 仅展示破产事实与处置结果：看守期、银行垫付兑付、已勾销单列、无股东股份托管。
 */
/**
 * 市长税收结算面板（v0.8）。
 *
 * 数据只来自 `store.taxView(city.id)`（契约投影，非市长返回 null）。交通系数只调整政府最终入账：
 * 系数 >1 的差额是交通财政加成（系统注入），<1 的差额是交通征收损耗（不退纳税人）。
 * 两者都不是债务、贷款或 GDP。非市长不渲染任何金额。
 */
export function renderCityTaxPanel(store: GameStore, city: City): string {
  const view = store.taxView(city.id);
  if (!view) {
    return `
      <div class="fiscal-brief is-restricted" data-testid="city-tax-panel">
        <div class="gov-sub-head"><span>税收结算</span><em>仅市长可见</em></div>
        <p class="fiscal-empty">基准税额、交通系数与最终入账仅该城市现任市长可见。</p>
      </div>`;
  }
  const latest = view.latest;
  const rows = view.history
    .slice(-6)
    .reverse()
    .map(
      (month) => `
      <tr>
        <td>${esc(tickDate(month.tick))}</td>
        <td>${money(month.totalBase)}</td>
        <td title="交通保障率 ${pct(month.transportGuarantee, 0)}">×${month.transportFactor.toFixed(2)}</td>
        <td class="${month.transportBonus > 0 ? 'is-teal' : ''}">${money(month.transportBonus)}</td>
        <td class="${month.transportLoss > 0 ? 'is-warn' : ''}">${money(month.transportLoss)}</td>
        <td><b>${money(month.totalRevenue)}</b></td>
      </tr>`,
    )
    .join('');
  return `
    <div class="fiscal-brief tax-panel" data-testid="city-tax-panel">
      <div class="gov-sub-head"><span>税收结算 · 基准税与交通系数</span><em>${latest ? `最近 ${esc(tickDate(latest.tick))}` : '尚无结算'}</em></div>
      ${
        latest
          ? `<div class="tax-grid">
              <div class="tax-cell"><span>基准税额</span><b>${money(latest.totalBase)}</b></div>
              <div class="tax-cell"><span>交通系数</span><b>×${latest.transportFactor.toFixed(2)}</b><small>保障率 ${pct(latest.transportGuarantee, 0)}</small></div>
              <div class="tax-cell is-teal"><span>交通加成</span><b>${money(latest.transportBonus)}</b><small>系统注入，不向纳税人补收</small></div>
              <div class="tax-cell ${latest.transportLoss > 0 ? 'is-warn' : ''}"><span>交通损耗</span><b>${money(latest.transportLoss)}</b><small>基准税未入账部分，不退还</small></div>
              <div class="tax-cell is-gold"><span>最终入账</span><b>${money(latest.totalRevenue)}</b></div>
            </div>
            <div class="tax-breakdown">
              <span><i>个税</i><b>${money(latest.incomeTaxRevenue)}</b><em>基准 ${money(latest.incomeTaxBase)}</em></span>
              <span><i>企税</i><b>${money(latest.corporateTaxRevenue)}</b><em>基准 ${money(latest.corporateTaxBase)}</em></span>
              <span><i>消费税</i><b>${money(latest.consumptionTaxRevenue)}</b><em>基准 ${money(latest.consumptionTaxBase)}</em></span>
              <span><i>股息税</i><b>${money(latest.dividendTaxRevenue)}</b><em>基准 ${money(latest.dividendTaxBase)}</em></span>
            </div>
            <div class="table-wrap">
              <table class="sec-table tax-history-table" aria-label="${esc(city.name)} 逐月税收结算">
                <thead>
                  <tr><th scope="col">月份</th><th scope="col">基准税</th><th scope="col">交通系数</th><th scope="col">加成</th><th scope="col">损耗</th><th scope="col">最终入账</th></tr>
                </thead>
                <tbody>${rows || '<tr><td class="mini-empty" colspan="6">尚无税收结算记录。</td></tr>'}</tbody>
              </table>
            </div>`
          : '<p class="fiscal-empty">尚无月度税收结算；推进 1 月后生成。</p>'
      }
      <p class="tax-note">${esc(view.note)}</p>
      <p class="fin-hint" data-testid="tax-history-window-note">仅显示最近 6 个月逐月税收明细（本城保留最近 ${num(
        DEMO_CONFIG.tax.historyMonths,
      )} 个月）；更早税收记录不保留、也未归档为年度汇总（该历史是破产判定与 AI 预算的规则读取窗口，不参与展示归档）。</p>
    </div>`;
}

export function renderPublicBankruptcyNotice(store: GameStore, city: City): string {
  const notice = store.publicBankruptcy(city.id);
  if (!notice) return '';
  const bankrupt = notice.status === 'bankrupt';
  const tickLabel = notice.tick === null ? '—' : tickDate(notice.tick);
  const election = notice.electionTriggeredTick === null ? '—' : tickDate(notice.electionTriggeredTick);
  const trusts =
    notice.trustHoldings.length === 0
      ? '本次无无股东企业股份需要处置。'
      : `${notice.trustHoldings
          .map((holding) => `${esc(holding.companyName)}（${num(holding.shares)} 股）`)
          .join('、')} 的股份转为无表决权托管持股：不销毁、不转给公司，待后续处置。`;
  return `
    <section class="panel-section bankruptcy-notice${bankrupt ? ' is-active' : ''}" data-testid="public-bankruptcy-notice">
      <div class="section-head">
        <div>
          <span class="kicker">BANKRUPTCY</span>
          <h2>${bankrupt ? '破产清算 · 看守期' : '曾破产清算'}</h2>
        </div>
        <span class="section-tag">${
          bankrupt
            ? notice.caretakerUntilElection
              ? '现任市长仅维持性操作'
              : '重选已触发 · 等待新任市长'
            : '已进入重建'
        }</span>
      </div>
      <p class="bankruptcy-lead" data-testid="bankruptcy-lead">
        ${esc(city.name)} 于 <b>${esc(tickLabel)}</b> 触发破产判定并完成清算${
          notice.electionTriggeredTick === null
            ? ''
            : `，并于 <b>${esc(election)}</b> 触发重选${notice.caretakerUntilElection ? '（现任市长进入看守期）' : '（重选当月完成，无看守期）'}`
        }；破产事件公开，财政余额、实时债务率与风险档仍仅该城市市长可见。
      </p>
      <div class="bankruptcy-grid">
        <span>判定月<b>${esc(tickLabel)}</b></span>
        <span>重选触发<b>${esc(election)}</b></span>
        <span>看守期<b>${
          notice.caretakerUntilElection
            ? '是（仅维持性操作）'
            : bankrupt
              ? '本月已即时重选'
              : '否'
        }</b></span>
      </div>
      ${
        notice.detailsVisible
          ? `<div class="bankruptcy-grid" data-testid="bankruptcy-details">
        <span>破产兑付<b data-testid="bankruptcy-bond-redemptions">${num(notice.bondRedemptionCount ?? 0)} 笔 · 本金 ${money(notice.bondsRedeemedPrincipal ?? 0)} · 利息 ${money(notice.bondsRedeemedInterest ?? 0)}</b></span>
        <span>银行垫付<b data-testid="bankruptcy-advance">${money(notice.bankAdvanceCreated ?? 0)}</b></span>
        <span>已勾销<b data-testid="bankruptcy-written-off">银行贷款本金 ${money(notice.bankLoansWrittenOff ?? 0)} · 垫付贷款本金 ${money(notice.advancesWrittenOff ?? 0)} · 未清偿利息 ${money(notice.interestWrittenOff ?? 0)}</b></span>
      </div>`
          : `<p class="bankruptcy-note" data-testid="bankruptcy-details-restricted">破产处置金额（兑付、垫付、勾销、未清偿利息）与政府债务口径仅该城市现任市长可见；破产事实与重选结果公开，个人持债兑付记录可在债券市场查看。</p>`
      }
      <p class="bankruptcy-note" data-testid="bankruptcy-settlement-note">
        未到期债券的本金与已计提利息由银行垫付兑付（财政不参与兑付）；垫付形成的政府贷款与原有政府银行贷款在清算中勾销。按 #44 口径，“已勾销”单列，不计入“已还本金”。
      </p>
      <p class="bankruptcy-note" data-testid="bankruptcy-share-disposal"><b>股份处置：</b>${trusts}</p>
    </section>`;
}

export function renderBondMarketSection(store: GameStore): string {
  const offers = store.bondMarketOffers;
  const holdings = store.ownBondHoldings;
  const currentTick = store.world.time.tick;
  // 破产兑付只能发生在到期日之前（到期兑付 redeemedTick >= maturityTick），
  // 因此用「已兑付且尚未到期」即可从公开投影判定破产清算，无需新增契约字段。
  const bankruptCities = [
    ...new Set(
      offers
        .filter((offer) => offer.status === 'redeemed' && currentTick < offer.maturityTick)
        .map((offer) => cityName(store.world, offer.cityId)),
    ),
  ];
  const offerRows =
    offers.length === 0
      ? `<p class="bond-empty" data-testid="bond-market-empty">暂无已发行债券；市长发起发行后会出现在这里。</p>`
      : offers
          .map((offer) => {
            const cityLabel = cityName(store.world, offer.cityId);
            const isOffering = offer.status === 'offering' && offer.unitsAvailable > 0;
            const settledEarly = offer.status === 'redeemed' && currentTick < offer.maturityTick;
            const statusLabel = settledEarly
              ? '已兑付 · 破产清算（银行垫付）'
              : offer.status === 'redeemed'
                ? '已兑付 · 到期'
                : BOND_STATUS_LABELS[offer.status];
            const action = isOffering
              ? `<span class="bond-buy">
                  <input
                    type="number"
                    data-bond-subscribe-units
                    min="1"
                    max="${offer.unitsAvailable}"
                    step="1"
                    value="1"
                    inputmode="numeric"
                    aria-label="认购 ${esc(cityLabel)} 债券份数（最多 ${num(offer.unitsAvailable)} 份）"
                  >
                  <button
                    type="button"
                    class="ken-btn ken-btn--green ken-btn--mini"
                    data-action="subscribe-bond"
                    data-issuance-id="${esc(offer.issuanceId)}"
                    data-testid="subscribe-bond-${esc(offer.issuanceId)}"
                    data-focus-key="subscribe-${esc(offer.issuanceId)}"
                    title="用可用资金认购；不可贷款购债"
                  >认购</button>
                </span>`
              : `<span class="bond-closed${offer.status === 'redeemed' ? (settledEarly ? ' is-bad' : ' is-good') : ''}" data-testid="bond-closed-${esc(offer.issuanceId)}">${esc(
                  offer.status === 'redeemed' ? statusLabel : `${BOND_STATUS_LABELS[offer.status]}${offer.status === 'offering' ? '（已售罄）' : ''}`,
                )}</span>`;
            return `
              <div class="bond-offer" data-issuance-id="${esc(offer.issuanceId)}">
                <div class="bond-offer-head">
                  <b>${esc(cityLabel)} · 政府债券</b>
                  <span class="bond-status${offer.status === 'redeemed' ? (settledEarly ? ' is-bad' : ' is-good') : ''}">${esc(statusLabel)}</span>
                </div>
                <div class="bond-offer-grid">
                  <span>面额<b>${money(offer.faceValue)}</b></span>
                  <span>票面年利率<b>${pct(offer.couponRateAnnual, 2)}</b></span>
                  <span>期限<b>${num(offer.termMonths)} 月</b></span>
                  <span>付息周期<b>每 ${num(offer.interestPeriodMonths)} 月</b></span>
                  <span>到期<b>${esc(tickDate(offer.maturityTick))}</b></span>
                  <span>可认购<b>${num(offer.unitsAvailable)} 份</b></span>
                  <span>认购窗口<b>${
                    offer.status === 'offering'
                      ? `本月内（${esc(tickDate(offer.subscriptionCloseTick))} 月结关闭）`
                      : `已关闭（发行月内一次撮合）`
                  }</b></span>
                </div>
                ${
                  settledEarly
                    ? `<p class="bond-bankruptcy-note">该市已破产清算：未到期本金与已计提利息由银行垫付兑付，财政不参与兑付；垫付形成的银行债权已在清算中勾销。</p>`
                    : ''
                }
                <div class="bond-offer-foot">${action}</div>
              </div>`;
          })
          .join('');

  const holdingRows =
    holdings.length === 0
      ? `<p class="bond-empty" data-testid="own-bond-empty">你还没有持有债券。</p>`
      : `<ul class="bond-holding-list">${holdings
          .map(
            (holding) => `
            <li class="bond-holding" data-testid="own-bond-${esc(holding.holdingId)}">
              <span class="bond-holding-city">${esc(cityName(store.world, holding.cityId))}</span>
              <span>${num(holding.units)} 份 · 本金 <b>${money(holding.principal)}</b></span>
              <span>应计利息 <b>${money(holding.accruedInterest)}</b></span>
              <span>到期 ${esc(tickDate(holding.maturityTick))}${
                holding.redeemedTick === null
                  ? ''
                  : `（${esc(tickDate(holding.redeemedTick))} ${holding.redeemedTick < holding.maturityTick ? '破产兑付' : '到期兑付'}）`
              }</span>
            </li>`,
          )
          .join('')}</ul>`;

  return `
    <section class="panel-section bond-market-section" data-testid="bond-market-section">
      <div class="section-head">
        <div>
          <span class="kicker">BOND MARKET</span>
          <h2>债券市场</h2>
        </div>
        <span class="section-tag">${num(offers.filter((offer) => offer.status === 'offering').length)} 批次认购中</span>
      </div>
      <p class="fiscal-note">公开信息只含发行城市、面额、票面年利率、期限、到期日与认购窗口；发行计划总额、总售额与政府总债务不公开。认购只使用可用资金，不可贷款购债。</p>
      <p class="fiscal-note">认购窗口为发行当月：发行后至下一次月结关闭（暂停/加速不改变游戏月），跨月不续售。窗口关闭前，居民投资实体与企业会用自身可用资金认购剩余份数；AI 不会使用玩家资金，玩家买不买由玩家自己决定。</p>
      ${
        bankruptCities.length > 0
          ? `<div class="bond-bankruptcy-banner" data-testid="bond-bankruptcy-banner">
              <b>${esc(bankruptCities.join('、'))} 曾进入破产清算</b>
              <span>未到期债券由银行垫付兑付（本金 + 已计提利息），财政不参与兑付；垫付形成的银行债权已在清算中勾销，破产批次不再付息。</span>
            </div>`
          : ''
      }
      ${offerRows}
      <p class="fin-hint archive-note" data-testid="bond-payment-window-note">本面板不逐笔列出兑付流水：最近 ${num(
        DEMO_CONFIG.history.bondPaymentDetailMonths,
      )} 个月的债券兑付可在市长财政流水与个人持债状态中核对；更早兑付已按 批次×持有人×年×类型 归档，见下方年度汇总。</p>
      <div class="bond-holdings">
        <div class="gov-sub-head"><span>我的持债</span><em>${num(holdings.length)} 条记录</em></div>
        ${holdingRows}
      </div>
      ${renderBondPaymentAnnualArchive(store)}
    </section>`;
}

export function renderTransportSection(store: GameStore, city: City): string {
  const view = store.transportView(city.id);
  const stats = view.stats;
  // 补充指令 §7：政府可用资金与支出明细仅该城市市长可见。
  // 非市长不读取余额、不做"资金是否够"的比较，也不展示投资入口为可用。
  const isMayor = store.isMayorOf(city.id);
  // 财政余额只从市长财政视图读取（契约投影），非市长为 null，不直接读 city.treasury。
  const treasury = isMayor ? store.fiscalView(city.id)?.treasury ?? null : null;
  const corridors = new Map(view.corridors.map((entry) => [entry.withCityId, entry]));

  const linkRows =
    view.links.length === 0
      ? '<tr><td class="mini-empty" colspan="5">本城暂无城际线路。</td></tr>'
      : view.links
          .map((link) => {
            const partner = cityName(store.world, link.partner);
            const estimate = link.estimate;
            const construction = link.construction;
            const atMax = link.level >= link.maxLevel;
            const noMoney = treasury !== null && treasury < estimate.cost;
            const canInvest = isMayor && estimate.ok && !noMoney;
            const reason = !isMayor
              ? '仅市长可决定市政投资'
              : construction
                ? `建设中 ${construction.monthsRemaining}/${construction.totalMonths} 月`
                : atMax
                  ? '已达最高等级'
                  : noMoney
                    ? '财政资金不足'
                    : '';
            const corridor = corridors.get(link.partner);
            return `
              <tr class="${canInvest ? '' : 'is-locked'}">
                <th scope="row">
                  <b>${esc(partner)}</b>
                  <em>需求 ${qty(corridor?.demand ?? 0)} · 惩罚 ${pct(corridor?.penaltyRate ?? 0, 1)}</em>
                </th>
                <td><span class="transport-mode is-${esc(link.mode)}">${transportModeLabel(link.mode)}</span></td>
                <td>${link.level}/${link.maxLevel}<em>${qty(link.capacity)}</em></td>
                <td class="transport-state">${
                  construction
                    ? `<span class="is-building">升级中 → ${construction.targetLevel} 级</span>`
                    : `<span>${atMax ? '已达最高' : '可升级'}</span>`
                }</td>
                <td class="transport-invest">
                  <span>${estimate.ok ? `${money(estimate.cost)} · ${estimate.months} 月` : '—'}</span>
                  ${investTransportButton({
                    target: link.id,
                    testId: `transport-link-${link.id}`,
                    label: estimate.ok ? '投资' : '不可用',
                    disabled: !canInvest,
                    reason: reason || estimate.error,
                    hint: `由 ${city.name} 财政出资升级 ${partner} ${transportModeLabel(link.mode)}线路`,
                  })}
                  ${reason ? `<em class="transport-why">${esc(reason)}</em>` : ''}
                </td>
              </tr>`;
          })
          .join('');

  const network = view.intracity;
  const intracityStats = network?.stats ?? null;
  const road = network?.estimateRoad ?? null;
  const rail = network?.estimateRail ?? null;
  const construction = network?.construction ?? null;
  const constructionReason = construction
    ? `城内${transportModeLabel(construction.kind)}正在建设中`
    : '';
  const roadReason = !isMayor
    ? '仅市长可决定市政投资'
    : !road
      ? '暂无城内交通网络'
      : !road.ok
        ? constructionReason || '城内道路已达最高等级'
        : treasury !== null && treasury < road.cost
          ? '财政资金不足'
          : '';
  const railReason = !isMayor
    ? '仅市长可决定市政投资'
    : !rail
      ? '暂无城内交通网络'
      : !rail.ok
        ? constructionReason || '城内铁路已达最高等级'
        : treasury !== null && treasury < rail.cost
          ? '财政资金不足'
          : '';

  return `
    <section class="panel-section transport-section" data-testid="transport-section">
      <div class="section-head">
        <div>
          <span class="kicker">FREIGHT CAPACITY</span>
          <h2>交通与运输容量</h2>
        </div>
        <span class="section-tag">${view.links.length} 条城际线路</span>
      </div>
      <div class="transport-kpis">
        <div class="transport-kpi"><span>城际需求</span><b>${qty(stats.demand)}</b></div>
        <div class="transport-kpi"><span>城际容量</span><b>${qty(stats.capacity)}</b></div>
        <div class="transport-kpi ${stats.penaltyRate > 0 ? 'is-warn' : ''}"><span>惩罚比例</span><b>${pct(stats.penaltyRate, 1)}</b></div>
        <div class="transport-kpi ${stats.capacityLossTotal > 0 ? 'is-warn' : ''}"><span>收益损失合计</span><b>${money(stats.capacityLossTotal)}</b></div>
        <div class="transport-kpi"><span>财政补偿</span><b>${isMayor ? money(stats.freightSubsidy) : '—'}</b></div>
        <div class="transport-kpi"><span>维护支出</span><b>${isMayor ? money(stats.maintenancePaid) : '—'}</b></div>
      </div>
      <div class="gov-sub-head"><span>城际线路</span><em>公路 / 铁路</em></div>
      <div class="table-wrap">
        <table class="transport-table" aria-label="${esc(city.name)} 城际交通线路">
          <thead>
            <tr>
              <th scope="col">伙伴城市</th>
              <th scope="col">方式</th>
              <th scope="col">等级 · 容量</th>
              <th scope="col">状态</th>
              <th scope="col">升级成本</th>
            </tr>
          </thead>
          <tbody>${linkRows}</tbody>
        </table>
      </div>
      <div class="gov-sub-head"><span>城内交通</span><em>${network ? `容量 ${qty(network.capacity)}` : '无网络'}</em></div>
      ${
        network
          ? `<div class="intracity-grid">
              <div class="intracity-cell">
                <span>道路</span>
                <b>${network.roadLevel}/${network.maxLevel}</b>
                <small>${road?.ok ? `${money(road.cost)} · ${road.months} 月` : roadReason || '—'}</small>
                ${investTransportButton({
                  target: 'intracity:road',
                  testId: 'intracity-road',
                  label: '升级道路',
                  disabled: !isMayor || !road?.ok || (treasury ?? 0) < (road?.cost ?? 0),
                  reason: roadReason,
                  hint: '由财政出资开工城内道路升级',
                })}
              </div>
              <div class="intracity-cell">
                <span>铁路</span>
                <b>${network.railLevel}/${network.maxLevel}</b>
                <small>${rail?.ok ? `${money(rail.cost)} · ${rail.months} 月` : railReason || '—'}</small>
                ${investTransportButton({
                  target: 'intracity:rail',
                  testId: 'intracity-rail',
                  label: '升级铁路',
                  disabled: !isMayor || !rail?.ok || (treasury ?? 0) < (rail?.cost ?? 0),
                  reason: railReason,
                  hint: '由财政出资开工城内铁路升级',
                })}
              </div>
            </div>
            <div class="intracity-stats">
              <span>上期配送利用率 <b>${intracityStats ? pct(intracityStats.utilization, 1) : '—'}</b></span>
              <span>配送效率 <b>${intracityStats ? pct(intracityStats.deliveryEfficiency, 1) : '—'}</b></span>
              ${
                construction
                  ? `<span class="is-building">施工中：${transportModeLabel(construction.kind)} → ${construction.targetLevel} 级，剩 ${construction.monthsRemaining} 月</span>`
                  : ''
              }
            </div>`
          : '<p class="fin-hint">本城暂无城内交通网络。</p>'
      }
      <p class="note">容量不是成交上限；超载只减少卖方该笔收益，买方付款不变（暂定方案）。</p>
    </section>`;
}

export function renderMarket(city: City, showAllGoods: boolean): string {
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
              <th
                scope="col"
                title="本地市场成交（不含跨城进口）；居民实际食品成交 = 本地市场成交 + 跨城进口（居民侧含进口花费）"
              >成交</th>
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
                  <td title="居民需求 ${num(market.consumerDemand)} · 生产有效需求 ${num(market.producerDemand)} · 企业计划采购 ${num(market.producerRequired)}">${qty(market.demand)}</td>
                  <td title="本地市场成交（不含跨城进口）；居民实际食品成交 = 本地市场成交 + 跨城进口">${qty(
                    market.sold,
                  )}</td>
                  <td class="${market.unmetDemand > 0 ? 'is-hot' : ''}" title="缺货未满足 ${num(market.unmetDemand, 1)} · 资金不足未满足 ${num(market.unmetFunding, 1)}">${qty(market.unmetDemand)}</td>
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
      <p class="note">数量均为演示货品单位；需求含居民与生产有效需求（企业计划采购中买得起的那部分），成交为上月结果，贸易列为跨城进口 / 区域外出口数量。未满足列是缺货/配送不足造成的未成交数量；企业因资金不足未形成有效需求的数量见悬停说明。</p>
      <p class="note" data-testid="market-scope-note">口径：“成交”是本地市场成交（不含跨城进口）；“贸易”列分别显示跨城进口与区域外出口。居民实际食品成交 = 本地市场成交 + 跨城进口（居民侧含进口花费，见人口标签的「需求 vs 成交」）。</p>
    </section>`;
}

export function companyRow(store: GameStore, company: Company, focused: boolean): string {
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

function renderCompanyLifecycle(store: GameStore, city: City): string {
  const view = store.lifecycleView(city.id);
  const localCompanies = store.companiesForCity(city.id);
  const richest = [...localCompanies].sort((a, b) => b.cash - a.cash)[0] ?? null;
  const atCompanyLimit = view.limits.companies >= view.limits.maxCompanies;
  const atGovernmentLimit = view.limits.governmentFoundings >= view.limits.maxGovernmentFoundings;
  const canInvestorGroup = view.canFoundInvestorGroup && !atCompanyLimit;
  const canCompany = richest !== null && !atCompanyLimit;
  const canGovernment = !atGovernmentLimit && !atCompanyLimit;

  const foundingRecords = view.foundings.length === 0
    ? '<li class="lifecycle-empty">本城暂无成立记录。</li>'
    : view.foundings
        .slice(0, 3)
        .map(
          (record) => `
          <li class="lifecycle-row" title="${esc(record.note)}">
            <span class="lifecycle-main"><b>${esc(record.companyName)}</b><em>第 ${record.tick} 期 · ${founderLabel(record.founderType)}</em></span>
            <span class="lifecycle-meta">资本 ${money(record.capital)} · ${num(record.investorCount)} 位出资方${record.governmentGrant > 0 ? ` · 政府 ${money(record.governmentGrant)}` : ''}</span>
          </li>`,
        )
        .join('');

  const liquidationRecords = view.liquidations.length === 0
    ? '<li class="lifecycle-empty">本城暂无倒闭记录。</li>'
    : view.liquidations
        .slice(0, 3)
        .map(
          (record) => `
          <li class="lifecycle-row is-exit" title="${esc(record.reason)}">
            <span class="lifecycle-main"><b>${esc(record.companyName)}</b><em>第 ${record.tick} 期退出</em></span>
            <span class="lifecycle-meta">释放员工 ${num(record.employeesReleased)} · 债务减免 ${money(record.debtForgiven)} · 股东分配 ${money(record.shareholderPayout)} · 库存注销 ${money(record.inventoryBookValue)}</span>
          </li>`,
        )
        .join('');

  return `
    <div class="company-lifecycle" data-testid="company-lifecycle">
      <div class="gov-sub-head"><span>企业创办与退出</span><em>演示规则</em></div>
      <div class="lifecycle-limits">
        <span>本城企业 <b>${num(view.limits.companies)}/${num(view.limits.maxCompanies)}</b></span>
        <span>政府已创办 <b>${num(view.limits.governmentFoundings)}/${num(view.limits.maxGovernmentFoundings)}</b></span>
        <span>居民投资群体 <b class="${view.canFoundInvestorGroup ? 'is-ok' : 'is-warn'}">${view.canFoundInvestorGroup ? '可出资' : '暂无可出资群体'}</b></span>
      </div>
      <div class="lifecycle-actions">
        <button
          type="button"
          class="ken-btn ken-btn--green ken-btn--mini"
          data-action="found-company"
          data-founder="investorGroup"
          data-testid="found-investorGroup"
          data-focus-key="found-investorGroup"
          ${canInvestorGroup ? '' : 'disabled'}
          title="${canInvestorGroup ? '由本城居民投资群体联合出资创办一家企业' : atCompanyLimit ? '本城企业数量已达上限' : '暂无可出资的居民投资群体'}"
        >居民联合出资</button>
        <button
          type="button"
          class="ken-btn ken-btn--blue ken-btn--mini"
          data-action="found-company"
          data-founder="company"
          ${richest ? `data-company-id="${esc(richest.id)}"` : ''}
          data-testid="found-company"
          data-focus-key="found-company"
          ${canCompany ? '' : 'disabled'}
          title="${canCompany ? `由 ${richest?.name ?? '本城企业'} 出资设立子公司` : atCompanyLimit ? '本城企业数量已达上限' : '本城暂时没有可作为出资方的企业'}"
        >现有企业设立</button>
        <button
          type="button"
          class="ken-btn ken-btn--grey ken-btn--mini"
          data-action="found-company"
          data-founder="government"
          data-testid="found-government"
          data-focus-key="found-government"
          ${canGovernment ? '' : 'disabled'}
          title="${canGovernment ? '由市政府出资创办一家市属企业' : '政府创办数量已达上限'}"
        >市政府创办</button>
      </div>
      <div class="lifecycle-lists">
        <div class="lifecycle-list">
          <span class="lifecycle-list-title">最近成立</span>
          <ul>${foundingRecords}</ul>
        </div>
        <div class="lifecycle-list">
          <span class="lifecycle-list-title">最近倒闭</span>
          <ul>${liquidationRecords}</ul>
        </div>
      </div>
      <p class="fin-hint">创办需要自有资本与资格；企业退出时员工回到劳动力市场，债务与库存按演示规则处理。</p>
    </div>`;
}

export function renderCompanies(store: GameStore, city: City, focusCompanyId: string | null): string {
  const companies = [...store.companiesForCity(city.id)].sort(
    (a, b) => b.employees - a.employees || a.name.localeCompare(b.name, 'zh-CN'),
  );
  const totalEmployees = companies.reduce((total, company) => total + company.employees, 0);
  return `
    <section class="panel-section" data-testid="companies-section">
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
      ${renderCompanyLifecycle(store, city)}
    </section>`;
}

export function renderTradeSummary(store: GameStore): string {
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
      <p class="demo-note">市政府牵头（演示入口）。协议由市政府组织，不代表玩家已当选或产生个人义务。</p>
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
    ${renderSystems(store, city)}
    ${renderMarket(city, state.showAllGoods)}
    ${renderCompanies(store, city, state.focusCompanyId)}
    ${renderTradeSummary(store)}
    ${renderBondMarketSection(store)}
    ${renderAgreementsSection(store, city)}`;
}

export function renderBuildingDetail(
  store: GameStore,
  city: City,
  building: BuildingDefinition,
  company: Company | null,
  options: { includeCompany?: boolean } = {},
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
      company && options.includeCompany !== false
        ? renderCompanyDetail(store, company, {
            showClose: false,
            investTestId: true,
          })
        : ''
    }
    <p class="selection-context">${esc(city.name)} · ${esc(district?.name ?? '城市街区')}</p>`;
}

export function renderDistrictDetail(store: GameStore, city: City, district: DistrictDefinition): string {
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

export type CompanyDetailSection =
  | 'all'
  | 'overview'
  | 'operation'
  | 'finance'
  | 'governance'
  | 'stocks';

export interface CompanyDetailOptions {
  showClose?: boolean;
  investTestId?: boolean;
  /** 只渲染指定标签页的分区；缺省 all 保持旧版完整详情。 */
  section?: CompanyDetailSection;
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
  const aiView = store.companyAiView(company.id);
  const aiPlan = aiView?.plan ?? null;
  const expansionCost = aiView?.expansionCost ?? 0;
  const expansionEstimate = aiView?.expansionEstimate ?? 0;
  const canExpand = expansionCost > 0 && company.cash + 1e-6 >= expansionCost;

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
    // 以议案登记日快照判断能否投票：登记日后买入或已卖出的股份不改变本次票权。
    const eligibleShares = store.motionEligibility(motion.id);
    const voteButtons =
      motion.status === 'open' && eligibleShares > 0
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
                  title="${VOTE_LABELS[vote]}（按登记日快照 ${num(eligibleShares)} 股计票）"
                >${VOTE_LABELS[vote]}</button>`,
              )
              .join('')}
          </div>`
        : '';
    const snapshotHint =
      motion.status === 'open' && canVote && eligibleShares <= 0
        ? '<p class="fin-hint">你在本议案登记日之后才取得投票权（或已转出），本次不能投票；下一项议案会按新的持股重新登记。</p>'
        : motion.status === 'open' && eligibleShares > 0
          ? `<p class="fin-hint">登记日票权 ${num(eligibleShares)} 股 · 登记股东 ${num(motion.eligible.length)} 名。</p>`
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
        ${snapshotHint}
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

  const html = `
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
      <section class="detail-subsection company-ai" data-testid="company-ai">
        <div class="sub-head">
          <h4>自动经营</h4>
          <span class="mini-tag">${esc(aiView?.styleLabel ?? '职业经理人')}</span>
        </div>
        <p class="ai-style">${esc(aiView?.styleDescription ?? '企业由职业经理人按月度计划经营。')}</p>
        <p class="ai-decision"><b>最近决策</b>${esc(aiView?.decision || '尚无决策记录；推进 1 月后生成。')}</p>
        ${
          aiPlan
            ? `<div class="ai-plan">
                <span><i>计划利用率</i><b>${pct(aiPlan.utilization, 1)}</b></span>
                <span><i>岗位需求</i><b>${num(aiPlan.targetJobs)}</b></span>
                <span><i>补贴后月用工成本</i><b>${money(aiPlan.expectedWageCost)}</b></span>
                <span><i>计划投资</i><b>${money(aiPlan.investment)}</b></span>
              </div>
              ${
                aiPlan.reasons.length > 0
                  ? `<ul class="ai-reasons">${aiPlan.reasons
                      .slice(0, 3)
                      .map((reason) => `<li>${esc(reason)}</li>`)
                      .join('')}</ul>`
                  : ''
              }`
            : '<p class="fin-hint">尚无经营计划；推进 1 月后，这里会显示利用率、岗位与投资安排。</p>'
        }
        <div class="ai-foot">
          <span class="ai-loss ${(aiView?.lossMonths ?? 0) > 0 ? 'is-warn' : ''}">连续亏损 ${num(aiView?.lossMonths ?? 0)} 个月</span>
          <button
            type="button"
            class="ken-btn ken-btn--green ken-btn--mini"
            data-action="expand-capacity"
            data-company-id="${esc(company.id)}"
            data-testid="expand-capacity-${esc(company.id)}"
            data-focus-key="expand-${esc(company.id)}"
            ${canExpand ? '' : 'disabled'}
            title="${canExpand ? `由企业自有资金扩产，预计新增 ${qty(expansionEstimate)} 单位/月，成本 ${money(expansionCost)}` : `企业现金不足：扩产需要 ${money(expansionCost)}`}"
          >扩产 +${qty(expansionEstimate)} · ${money(expansionCost)}</button>
        </div>
      </section>
      ${renderCompanyEquipmentSection(store, company)}
      <div class="finance-grid">
        <div class="fin-block">
          <h4>上月损益</h4>
          <table class="fin-table">
            <tbody>
              <tr><td>收入</td><td>${money(lastMonth.revenue)}</td></tr>
              <tr><td>投入</td><td>${money(lastMonth.inputCost)}</td></tr>
              <tr><td>工资</td><td>${money(lastMonth.wagesPaid)}</td></tr>
              ${lastMonth.wageArrears > 0 ? `<tr class="is-warn"><td>欠薪</td><td>${money(lastMonth.wageArrears)}</td></tr>` : ''}
              ${(lastMonth.bonusPaid ?? 0) > 0 ? `<tr><td>奖金</td><td>${money(lastMonth.bonusPaid ?? 0)}</td></tr>` : ''}
              ${(lastMonth.equipmentPurchased ?? 0) > 0 ? `<tr><td>设备支出</td><td>${money(lastMonth.equipmentPurchased ?? 0)}</td></tr>` : ''}
              ${(lastMonth.equipmentSold ?? 0) > 0 ? `<tr><td>设备出售</td><td>${money(lastMonth.equipmentSold ?? 0)}</td></tr>` : ''}
              ${(lastMonth.maintenanceDue ?? 0) > 0 ? `<tr${(lastMonth.maintenanceArrears ?? 0) > 0.005 ? ' class="is-warn"' : ''}><td title="设备月度维护费：台数 × 月初新机参考价 × 费率；收款方为模拟范围外服务商">设备维护费</td><td>${money(lastMonth.maintenanceDue ?? 0)}${(lastMonth.maintenanceArrears ?? 0) > 0.005 ? `（欠付 ${money(lastMonth.maintenanceArrears ?? 0)}）` : ''}</td></tr>` : ''}
              ${(lastMonth.emergencyLayoffs ?? 0) > 0 ? `<tr class="is-warn"><td>紧急裁员</td><td>${num(lastMonth.emergencyLayoffs ?? 0)} 人</td></tr>` : ''}
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
        <p class="fin-hint archive-note" data-testid="motion-window-note">仅显示最近 ${num(
          DEMO_CONFIG.history.governanceArchiveMonths,
        )} 个月已结束议案的逐笔明细（“最近结束”最多展示 2 条）；更早议案已按 公司×年×类型 归档为年度统计，见下方年度汇总。</p>
        ${renderMotionAnnualArchive(store, company.id)}
        <p class="fin-hint">表决按议案创建时的登记日快照计票：期间股份转手不会让同一批票被重复使用（演示规则）。</p>
        ${
          canVote || openMotions.some((motion) => store.motionEligibility(motion.id) > 0)
            ? ''
            : '<p class="fin-hint">你没有该公司的表决权，不会收到表决要求。</p>'
        }
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
        <div class="stock-entry">
          <button
            type="button"
            class="ken-btn ken-btn--gold ken-btn--mini"
            data-action="open-stock-market"
            data-company-id="${esc(company.id)}"
            data-testid="open-stock-window-${esc(company.id)}"
            data-focus-key="open-stock-${esc(company.id)}"
            title="打开股票市场浮动窗口：月 K 线、盘口、我的委托与下单"
          >查看股票行情</button>
          <span class="fin-hint">浮动窗口可查看月 K 线与盘口；打开窗口不会暂停模拟。</span>
        </div>
      </section>
      ${renderCompanyOperatorBlock(store, company)}
      <p class="warning-note">企业现金不足会触发营运资金信贷 / 债务重组（演示）。该机制不是正式金融模型。</p>
    </article>`;
  return options.section && options.section !== 'all'
    ? selectCompanyDetailSection(html, options.section)
    : html;
}

/**
 * 企业详情按标签页取分区。这里只切割已渲染好的 HTML，不重复任何业务计算；
 * 「经营」= 自动经营 + 经营者区块，「财务」= 损益/岗位/库存/注资，其余按原顺序。
 */
function selectCompanyDetailSection(
  html: string,
  section: Exclude<CompanyDetailSection, 'all'>,
): string {
  const at = (marker: string): number => html.indexOf(marker);
  const sectionStart = (marker: string): number => {
    const index = at(marker);
    return index < 0 ? -1 : html.lastIndexOf('<section', index);
  };
  const slice = (start: number, end: number): string =>
    start < 0 || end <= start ? '' : html.slice(start, end);

  const aiAt = sectionStart('company-ai');
  const financeAt = at('<div class="finance-grid">');
  const holdersAt = sectionStart('data-testid="company-holders"');
  const tradingAt = sectionStart('data-testid="company-trading"');
  const operatorAt = sectionStart('data-testid="company-operator"');
  const warningAt = at('<p class="warning-note">');

  const overview = slice(0, aiAt).replace(/<article[\s\S]*?>/, '');

  switch (section) {
    case 'operation':
      return `${slice(aiAt, financeAt)}${slice(operatorAt, warningAt)}`;
    case 'finance':
      return slice(financeAt, holdersAt);
    case 'governance':
      return slice(holdersAt, tradingAt);
    case 'stocks':
      return slice(tradingAt, operatorAt);
    case 'overview':
      return overview;
    default:
      return overview;
  }
}

// ---------------------------------------------------------------- v0.4 居民阶层 · 人才市场 · 银行 · 经营者
// 面板只读 store 的 v0.4 视图；写操作一律通过 data-action 交给 GameUI，面板本身无状态。

type PopulationStrataView = NonNullable<ReturnType<GameStore['populationStrataView']>>;
type TalentMarketView = NonNullable<ReturnType<GameStore['talentMarketView']>>;
type BankView = NonNullable<ReturnType<GameStore['bankView']>>;
type BankLoanView = BankView['player']['loans'][number];
type OperatorView = NonNullable<ReturnType<GameStore['operatorView']>>;
type OperatorElectionView = NonNullable<OperatorView['election']>;
type OperationView = NonNullable<OperatorView['operation']>;
type ProposalView = OperationView['proposals'][number];

const WEALTH_TIER_LABELS: Record<'low' | 'middle' | 'high', string> = {
  low: '低',
  middle: '中',
  high: '高',
};

const OPERATOR_BASIS_LABELS: Record<'management' | 'boardAppointment' | 'election', string> = {
  management: '职业经理人管理',
  boardAppointment: '董事会任命',
  election: '股东选任',
};

const OPERATOR_STYLE_LABELS: Record<'growth' | 'steady' | 'return', string> = {
  growth: '扩张型',
  steady: '稳健型',
  return: '回报型',
};

const LOAN_PURPOSE_LABELS: Record<BankLoanView['purpose'], string> = {
  workingCapital: '周转贷款',
  expansion: '扩张贷款',
  personal: '个人贷款',
  migratedDebt: '旧债务承接',
  // v0.7：枚举扩展后的展示文案（接口契约要求，非界面改版）。
  government: '政府借款',
  bondAdvance: '债券垫付转借款',
  householdConsumption: '居民消费贷款',
};

const LOAN_STATUS_LABELS: Record<BankLoanView['status'], string> = {
  active: '还款中',
  repaid: '已结清',
  defaulted: '已违约',
  writtenOff: '已核销',
};

const PROPOSAL_STATUS_LABELS: Record<ProposalView['status'], string> = {
  pending: '待批准',
  approved: '已批准',
  rejected: '已拒绝',
  executed: '已执行',
  expired: '已过期',
};

const OPERATION_MODE_OPTIONS = [
  { id: 'manual', label: '手动', hint: '你设定持续经营计划；AI 不代为决策。' },
  { id: 'assisted', label: 'AI 辅助', hint: 'AI 按月生成提案，重大事项等你批准。' },
  { id: 'delegated', label: '高度托管', hint: '授权范围内自动执行，超出范围仍需批准。' },
] as const;

const BANK_DEPOSIT_AMOUNT = 100_000;
const BANK_WITHDRAW_AMOUNT = 100_000;
const BANK_REPAY_AMOUNT = 10_000;
const PLAYER_LOAN_AMOUNTS = [50_000, 200_000] as const;
const COMPANY_LOAN_PRODUCTS = [
  { purpose: 'workingCapital', amount: 100_000, label: '周转贷款' },
  { purpose: 'expansion', amount: 500_000, label: '扩张贷款' },
] as const;

function operatorBasisLabel(basis: OperatorView['basis']): string {
  return basis ? OPERATOR_BASIS_LABELS[basis] : '默认管理';
}

function candidateStyleLabel(style: 'growth' | 'steady' | 'return' | null): string {
  return style ? OPERATOR_STYLE_LABELS[style] : '玩家';
}

function amountWanLabel(amount: number): string {
  return `${num(amount / 10_000)} 万`;
}

/** A. 城市居民阶层与职业群体：人数由人口/岗位派生，财富口径见视图 note。 */
export function renderPopulationStrataSection(store: GameStore, city: City): string {
  const view = store.populationStrataView(city.id);
  if (!view) return '';
  const stats = view.stats;
  const tierRows = stats
    ? stats.tiers
        .map(
          (tier) => `
            <tr>
              <th scope="row">${esc(WEALTH_TIER_LABELS[tier.tier])}</th>
              <td>${num(tier.people)}</td>
              <td>${pct(tier.share)}</td>
              <td>${money(tier.perCapitaWealth)}</td>
              <td>${money(tier.perCapitaIncome)}</td>
            </tr>`,
        )
        .join('')
    : '';
  const tierTotalRow = stats
    ? `<tr class="total">
        <th scope="row">合计</th>
        <td>${num(stats.totalPeople)}</td>
        <td>100.0%</td>
        <td>${money(stats.perCapitaWealth)}</td>
        <td>${money(stats.perCapitaIncome)}</td>
      </tr>`
    : '';
  const groupRows = view.groups
    .map(
      (group) => `
        <tr>
          <th scope="row">${esc(group.name)}</th>
          <td>${num(group.people)}</td>
          <td>${money(group.income)}</td>
          <td>${money(group.desiredConsumption)}</td>
          <td>${money(group.consumption)}</td>
          <td class="${group.unmetFunding > 0 ? 'is-warn' : ''}">${money(group.unmetFunding)}</td>
          <td>${money(group.savings)}</td>
          <td>${money(group.cash)}</td>
          <td>${money(group.deposits)}</td>
        </tr>`,
    )
    .join('');
  const demand = view.demand;
  const unmetShare = demand.desiredConsumption > 0 ? demand.unmetFunding / demand.desiredConsumption : 0;
  return `
    <section class="panel-section strata-section" data-testid="population-strata-section">
      <div class="section-head">
        <div>
          <span class="kicker">HOUSEHOLD STRATA</span>
          <h2>居民阶层与职业群体</h2>
        </div>
        <span class="section-tag">${qty(view.population.total)} 人</span>
      </div>
      <p class="strata-note">人数由城市人口与岗位派生，一个人只统计一次；人均资产 = 现金 + 银行存款 + 股票权益，股票市值不是现金。</p>
      <div class="strata-structure" data-testid="population-structure">
        <span>就业<b>${qty(view.population.employed)}</b></span>
        <span>失业<b>${qty(view.population.unemployed)}</b></span>
        <span>非劳动力<b>${qty(view.population.nonLabor)}</b></span>
        <span>劳动力<b>${qty(view.population.laborForce)}</b></span>
      </div>
      <div class="detail-subsection strata-demand" data-testid="population-demand-vs-trade">
        <div class="sub-head">
          <h4>需求 vs 成交</h4>
          <span>本月 · 信用点</span>
        </div>
        <div class="strata-demand-grid">
          <span><i>需求总额</i><b>${money(demand.desiredConsumption)}</b><small>想要购买的商品成本</small></span>
          <span><i>实际成交</i><b class="is-teal">${money(demand.consumption)}</b><small>本月真实买到</small></span>
          <span class="${demand.unmetFunding > 0 ? 'is-warn' : ''}"><i>资金缺口</i><b>${money(demand.unmetFunding)}</b><small>想买但资金不足 · ${pct(unmetShare, 1)}</small></span>
          <span><i>消费预算</i><b>${money(demand.budget)}</b><small>含工资、分红与转移</small></span>
          <span><i>消费贷支持</i><b>${money(demand.loanFinancedConsumption)}</b><small>借款支撑的消费</small></span>
          <span><i>存款提取</i><b>${money(demand.depositWithdrawn)}</b><small>为消费取出的存款</small></span>
        </div>
        <p class="fin-hint">需求与成交都是商品成本口径；资金缺口来自居民现金与预算不足，不是缺货（缺货见市场标签的未满足需求）。</p>
      </div>
      <div class="detail-subsection strata-tiers">
        <div class="sub-head">
          <h4>财富阶层</h4>
          <span>人均 · 信用点</span>
        </div>
        ${
          stats
            ? `<div class="table-wrap">
                <table class="strata-table" aria-label="${esc(city.name)} 财富阶层">
                  <thead>
                    <tr>
                      <th scope="col">阶层</th>
                      <th scope="col">人数</th>
                      <th scope="col">占比</th>
                      <th scope="col">人均资产</th>
                      <th scope="col">人均收入</th>
                    </tr>
                  </thead>
                  <tbody>${tierRows}${tierTotalRow}</tbody>
                </table>
              </div>`
            : '<p class="fin-hint">尚无月度统计（推进一个月后生成）。</p>'
        }
      </div>
      <div class="detail-subsection strata-groups">
        <div class="sub-head">
          <h4>职业群体</h4>
          <span>本月流水</span>
        </div>
        <div class="strata-scroll" data-scroll="pop-strata">
          <table class="strata-table strata-table--groups" aria-label="${esc(city.name)} 职业群体">
            <thead>
              <tr>
                <th scope="col">职业</th>
                <th scope="col">人数</th>
                <th scope="col">收入</th>
                <th scope="col">需求</th>
                <th scope="col">成交</th>
                <th scope="col">资金缺口</th>
                <th scope="col">储蓄</th>
                <th scope="col">现金</th>
                <th scope="col">存款</th>
              </tr>
            </thead>
            <tbody>${groupRows}</tbody>
          </table>
        </div>
      </div>
      <p class="fin-hint">合计：手头现金 ${money(view.totalCash)} · 银行存款 ${money(view.totalDeposits)} · 股票权益 ${money(view.investorEquity)}（权益按人口比例归属，不是现金）。</p>
    </section>`;
}

/**
 * v1.4 §3：居民投资实体面板（有效份额 / 净资产 / 每份净值 / 债券估值）。
 *
 * 口径完全来自只读聚合 `investorFundingReport`（同一个函数供月度报告与 CLI 使用）：
 * - 有效份额 = shares + openingShares（含开局无主旧资产的起始份额与按净值增发的新份额）；
 * - 投资实体净资产 = 现金 + 股票市值 + 债券估值（未到期本金 + 已计提未付利息）；
 * - 每份净值 = 净资产 ÷ 有效份额合计。
 * 面板不重算财富、不展示内部持仓明细，也不虚构任何成交或收益。
 */
export function renderInvestorSection(store: GameStore, city: City): string {
  const report = investorFundingReport(store.world).find((entry) => entry.cityId === city.id);
  if (!report) return '';
  const shares = report.householdShares;
  const totalShares = shares.reduce((sum, entry) => sum + entry.effectiveShares, 0);
  const holdingsValue = report.groups.reduce((sum, group) => sum + group.holdingsValue, 0);
  const bondsValue = report.groups.reduce((sum, group) => sum + group.bondsValue, 0);
  const attributedDividends = shares.reduce((sum, entry) => sum + entry.attributedDividends, 0);
  const navPerShare = totalShares > 0 ? report.investorNetWorth / totalShares : 0;
  const shareRows =
    shares.length === 0
      ? '<tr><td class="mini-empty" colspan="8">本城居民尚未向投资实体投入，暂无份额。</td></tr>'
      : shares
          .map(
            (entry) => `
              <tr data-testid="investor-share-${esc(entry.householdGroupId)}">
                <th scope="row">${esc(entry.name)}</th>
                <td title="${esc(HOUSEHOLD_OCCUPATION_LABELS[entry.occupation] ?? entry.occupation)}">${esc(
                  HOUSEHOLD_OCCUPATION_LABELS[entry.occupation] ?? entry.occupation,
                )}</td>
                <td>${money(entry.contributed)}</td>
                <td>${num(entry.shares, 2)}</td>
                <td>${num(entry.openingShares, 2)}</td>
                <td><b>${num(entry.effectiveShares, 2)}</b></td>
                <td>${pct(entry.shareRatio, 2)}</td>
                <td>${money(entry.attributedDividends)}</td>
              </tr>`,
          )
          .join('');
  const shareTotalRow =
    shares.length === 0
      ? ''
      : `<tr class="total" data-testid="investor-share-total">
          <th scope="row">合计</th>
          <td>—</td>
          <td>—</td>
          <td>${num(shares.reduce((sum, entry) => sum + entry.shares, 0), 2)}</td>
          <td>${num(shares.reduce((sum, entry) => sum + entry.openingShares, 0), 2)}</td>
          <td><b>${num(totalShares, 2)}</b></td>
          <td>${totalShares > 0 ? pct(1, 2) : pct(0, 2)}</td>
          <td>${money(attributedDividends)}</td>
        </tr>`;
  const usage = report.usage;
  const usageHasRecord = usage.tick > 0;
  const usageGrid = usageHasRecord
    ? `<div class="strata-demand-grid" data-testid="investor-usage">
        <span><i>本月转入</i><b>${money(usage.contributed)}</b><small>居民闲钱转进投资实体</small></span>
        <span><i>收到股息</i><b>${money(usage.dividendsReceived)}</b><small>返还居民 ${money(usage.dividendsReturned)} · 留存 ${money(
          usage.dividendsRetained,
        )}</small></span>
        <span><i>本月投资支出</i><b>${money(usage.invested)}</b><small>期初 ${money(usage.openingCash)} → 期末 ${money(
          usage.closingCash,
        )}</small></span>
      </div>`
    : '<p class="fin-hint" data-testid="investor-usage-empty">尚无资金用途记录：推进 1 个月后显示真实转入、股息返还与投资支出（未发生的月份不编造数字）。</p>';
  const lastFunding = report.monthlyFunding.at(-1) ?? null;
  return `
    <section class="panel-section investor-section" data-testid="investor-section">
      <div class="section-head">
        <div>
          <span class="kicker">HOUSEHOLD INVESTMENT</span>
          <h2>居民投资实体 · 有效份额与净资产</h2>
        </div>
        <span class="section-tag">${num(totalShares, 2)} 份</span>
      </div>
      <p class="strata-note">口径与月度投资报告一致：有效份额 = shares + openingShares；投资实体净资产 = 现金 + 股票市值 + 债券估值；每份净值 = 净资产 ÷ 有效份额合计。股票市值不是现金，债券按发行批次记在投资实体层。</p>
      <div class="investor-kpis" data-testid="investor-networth">
        <span><i>投资实体净资产</i><b>${money(report.investorNetWorth)}</b><small>现金 + 股票市值 + 债券估值</small></span>
        <span><i>实体现金</i><b>${money(report.investorCash)}</b><small>投资实体账户可用现金</small></span>
        <span><i>股票市值</i><b>${money(holdingsValue)}</b><small>按当前城市市价估值</small></span>
        <span><i>债券估值</i><b>${money(bondsValue)}</b><small>未到期本金 + 已计提未付利息</small></span>
        <span><i>有效份额合计</i><b>${num(totalShares, 2)}</b><small>含 openingShares 与按净值增发份额</small></span>
        <span data-testid="investor-nav"><i>每份净值</i><b>${totalShares > 0 ? num(navPerShare, 4) : '—'}</b><small>信用点 / 份</small></span>
      </div>
      <div class="detail-subsection">
        <div class="sub-head">
          <h4>居民群体份额与占比</h4>
          <span>本城 ${shares.length} 个群体 · 只读账本</span>
        </div>
        <div class="table-wrap">
          <table class="strata-table" aria-label="${esc(city.name)} 居民投资有效份额" data-testid="investor-share-table">
            <thead>
              <tr>
                <th scope="col">群体</th>
                <th scope="col">职业</th>
                <th scope="col">累计投入</th>
                <th scope="col">shares</th>
                <th scope="col">openingShares</th>
                <th scope="col">有效份额</th>
                <th scope="col">占比</th>
                <th scope="col">归属股息</th>
              </tr>
            </thead>
            <tbody>${shareRows}${shareTotalRow}</tbody>
          </table>
        </div>
        <p class="fin-hint">占比按本城有效份额合计计算（原始比例四位小数，这里保留两位显示）；归属股息只做账本归属，不重复计入居民收入。</p>
      </div>
      <div class="detail-subsection">
        <div class="sub-head">
          <h4>资金用途 · 最近一月</h4>
          <span>${usageHasRecord ? `${esc(tickDate(usage.tick))}` : '尚无记录'}${
            lastFunding ? ` · 上次转入 T${num(lastFunding.tick)} ${money(lastFunding.amount)}` : ''
          }</span>
        </div>
        ${usageGrid}
      </div>
      <p class="fin-hint">以上字段全部来自 investorFundingReport 的只读聚合；不展示投资实体内部持仓明细，也不虚构成交。</p>
    </section>`;
}

/** B. 城市人才市场：只展示空闲经营者；在任 AI 经营者不在名单内。 */
export function renderTalentMarketSection(store: GameStore, city: City): string {
  const view = store.talentMarketView(city.id);
  const rows =
    view.operators.length === 0
      ? '<p class="talent-empty">本城暂无可聘经营者；选任时会按需从人才池生成。</p>'
      : `<ul class="talent-list" data-scroll="talent-market">${view.operators
          .map((operator) => {
            const tenure = operator.lastTenure;
            return `
              <li class="talent-row" data-testid="talent-row-${esc(operator.id)}">
                <div class="talent-main">
                  <b>${esc(operator.name)}</b>
                  <span class="talent-style">${esc(operator.styleLabel)}</span>
                  <em title="0–1 演示声望">声望 ${pct(operator.reputation, 0)}</em>
                </div>
                <div class="talent-meta">
                  <span>上一段任职：${
                    tenure
                      ? `${esc(tenure.companyName)} · T${num(tenure.fromTick)}–T${num(tenure.toTick)}`
                      : '暂无任职记录'
                  }</span>
                  <span class="talent-status">${operator.status === 'available' ? '空闲 · 可聘' : '在任'}</span>
                </div>
              </li>`;
          })
          .join('')}</ul>`;
  return `
    <section class="panel-section talent-section" data-testid="talent-market-section">
      <div class="section-head">
        <div>
          <span class="kicker">OPERATOR MARKET</span>
          <h2>人才市场</h2>
        </div>
        <span class="section-tag">${view.operators.length}/${num(view.poolLimit)} 空闲</span>
      </div>
      <p class="talent-note">只展示空闲人才；其他企业的现任 AI 经营者不在名单内。经营者选任会优先从这份人才池中挑选候选人。</p>
      ${rows}
    </section>`;
}

function bankCreditChips(credit: BankView['player']['credit']): string {
  return `
    <div class="bank-credit">
      <span>授信基准<b>${money(credit.baseValue)}</b></span>
      <span>额度<b>${money(credit.limit)}</b></span>
      <span>已用<b>${money(credit.outstanding)}</b></span>
      <span class="${credit.available <= 0 ? 'is-warn' : ''}">可借<b>${money(credit.available)}</b></span>
    </div>`;
}

function bankLoanCards(
  loans: BankLoanView[],
  emptyText: string,
  allowRepay = true,
): string {
  if (loans.length === 0) return `<p class="fin-hint">${esc(emptyText)}</p>`;
  return `<ul class="bank-loans">${loans
    .map((loan) => {
      const repayable = loan.status !== 'repaid' && loan.outstanding > 0;
      const arrears = loan.arrearsPrincipal + loan.arrearsInterest;
      return `
        <li class="bank-loan status-${esc(loan.status)}">
          <div class="bank-loan-head">
            <b>${esc(LOAN_PURPOSE_LABELS[loan.purpose])}</b>
            <span class="bank-loan-id">${esc(loan.id)}</span>
            <span class="bank-loan-state">${esc(LOAN_STATUS_LABELS[loan.status])}</span>
          </div>
          <div class="bank-loan-grid">
            <span>未偿本金<b>${money(loan.outstanding)}</b></span>
            <span>月供本金<b>${money(loan.monthlyPrincipal)}</b></span>
            <span>月利率<b>${pct(loan.rateMonthly, 2)}</b></span>
            <span>下一期<b>T${num(loan.nextDueTick)}</b></span>
            <span>欠款<b class="${arrears > 0 ? 'is-warn' : ''}">${money(arrears)}</b></span>
            <span>期限<b>${num(loan.termMonths)} 月</b></span>
          </div>
          ${
            allowRepay
              ? `<div class="bank-loan-actions">
            <button
              type="button"
              class="ken-btn ken-btn--grey ken-btn--mini"
              data-action="repay-loan"
              data-loan-id="${esc(loan.id)}"
              data-amount="${BANK_REPAY_AMOUNT}"
              data-focus-key="repay-${esc(loan.id)}"
              ${repayable ? '' : 'disabled'}
              title="${repayable ? '提前偿还 1 万信用点本金；首版不收提前还款费' : '该合同已结清，无需还款'}"
            >提前还款 1 万</button>
          </div>`
              : ''
          }
        </li>`;
    })
    .join('')}</ul>`;
}

function bankLoanButton(
  options: {
    ownerKind: 'player' | 'company';
    ownerId: string;
    purpose: 'workingCapital' | 'expansion' | 'personal';
    amount: number;
    label: string;
  },
  available: number,
): string {
  const disabled = options.amount > available;
  const focusKey = `loan-${options.ownerKind}-${options.purpose}-${options.amount}`;
  return `<button
    type="button"
    class="ken-btn ken-btn--blue ken-btn--mini"
    data-action="take-loan"
    data-owner-kind="${options.ownerKind}"
    data-owner-id="${esc(options.ownerId)}"
    data-purpose="${options.purpose}"
    data-amount="${options.amount}"
    data-focus-key="${esc(focusKey)}"
    ${disabled ? 'disabled' : ''}
    title="${disabled ? `可借额度 ${money(available)}，不足 ${amountWanLabel(options.amount)}` : `申请${options.label} ${amountWanLabel(options.amount)}；放款后按合同月供还款`}"
  >申请${options.label} ${amountWanLabel(options.amount)}</button>`;
}

function renderBankCompanyBlock(companyView: NonNullable<BankView['company']>): string {
  const available = companyView.credit.available;
  return `
    <div class="bank-owner" data-testid="bank-company">
      <div class="bank-owner-head">
        <b>${esc(companyView.name)}</b>
        <span>企业账户</span>
      </div>
      <div class="bank-kpis">
        <span>现金<b>${money(companyView.cash)}</b></span>
        <span class="${companyView.debt > 0 ? 'is-warn' : ''}">债务<b>${money(companyView.debt)}</b></span>
        <span>存款<b>${money(companyView.deposits)}</b></span>
      </div>
      ${bankCreditChips(companyView.credit)}
      ${
        companyView.canOperate
          ? `<div class="bank-actions" role="group" aria-label="企业贷款申请">
        ${COMPANY_LOAN_PRODUCTS.map((product) =>
          bankLoanButton(
            {
              ownerKind: 'company',
              ownerId: companyView.companyId,
              purpose: product.purpose,
              amount: product.amount,
              label: product.label,
            },
            available,
          ),
        ).join('')}
      </div>`
          : '<p class="fin-hint" data-testid="bank-company-no-operator">你没有该企业的经营权：不能以企业名义申请贷款或还款（持有股票不等于经营权）。</p>'
      }
      <div class="gov-sub-head"><span>企业贷款</span><em>${companyView.loans.length} 笔</em></div>
      ${bankLoanCards(companyView.loans, '该企业暂无银行贷款。', companyView.canOperate)}
    </div>`;
}

/** C. 银行：玩家账户 / 选中企业账户、授信与贷款合同。 */
export function renderBankSection(store: GameStore, city: City): string {
  const selected = store.selectedCompany;
  const selectedCompany = selected && selected.cityId === city.id ? selected : null;
  const view = store.bankView(selectedCompany?.id ?? null);
  const player = view.player;
  const canDeposit = player.cash >= BANK_DEPOSIT_AMOUNT;
  const canWithdraw = player.deposits >= BANK_WITHDRAW_AMOUNT;
  const personalAvailable = player.credit.available;
  const companyView = view.company;
  return `
    <section class="panel-section bank-section" data-testid="bank-section">
      <div class="section-head">
        <div>
          <span class="kicker">BANKING</span>
          <h2>银行 · 存款与贷款</h2>
        </div>
        <span class="section-tag">存款月利率 ${pct(view.depositRateMonthly, 2)}</span>
      </div>
      <div class="bank-owner" data-testid="bank-player">
        <div class="bank-owner-head">
          <b>玩家账户</b>
          <span>个人</span>
        </div>
        <div class="bank-kpis">
          <span>现金<b>${money(player.cash)}</b></span>
          <span>存款<b>${money(player.deposits)}</b></span>
        </div>
        ${bankCreditChips(player.credit)}
        <div class="bank-actions" role="group" aria-label="玩家存取款">
          <button
            type="button"
            class="ken-btn ken-btn--green ken-btn--mini"
            data-action="bank-deposit"
            data-amount="${BANK_DEPOSIT_AMOUNT}"
            data-focus-key="bank-deposit"
            ${canDeposit ? '' : 'disabled'}
            title="${canDeposit ? '把 10 万现金存入银行，按月计息' : '现金不足 10 万'}"
          >存款 ${amountWanLabel(BANK_DEPOSIT_AMOUNT)}</button>
          <button
            type="button"
            class="ken-btn ken-btn--grey ken-btn--mini"
            data-action="bank-withdraw"
            data-amount="${BANK_WITHDRAW_AMOUNT}"
            data-focus-key="bank-withdraw"
            ${canWithdraw ? '' : 'disabled'}
            title="${canWithdraw ? '从存款取出 10 万现金' : '存款不足 10 万'}"
          >取款 ${amountWanLabel(BANK_WITHDRAW_AMOUNT)}</button>
        </div>
        <div class="gov-sub-head"><span>个人贷款</span><em>${player.loans.length} 笔</em></div>
        <div class="bank-actions" role="group" aria-label="个人贷款申请">
          ${PLAYER_LOAN_AMOUNTS.map((amount) =>
            bankLoanButton(
              {
                ownerKind: 'player',
                ownerId: 'player',
                purpose: 'personal',
                amount,
                label: '个人贷款',
              },
              personalAvailable,
            ),
          ).join('')}
        </div>
        ${bankLoanCards(player.loans, '暂无个人贷款。')}
      </div>
      ${
        companyView
          ? renderBankCompanyBlock(companyView)
          : '<p class="fin-hint">在左侧企业列表或地图选中本城企业后，这里显示企业账户、授信与贷款。</p>'
      }
      <p class="fin-hint archive-note" data-testid="bank-loan-window-note">贷款列表仅显示最近 ${num(
        DEMO_CONFIG.history.closedLoanArchiveMonths,
      )} 个月结清贷款的逐笔明细（未结清/违约贷款始终保留）；更早结清贷款已按 年×类别 归档，见下方年度汇总。</p>
      ${renderLoanAnnualArchive(store, city)}
      <p class="bank-note">${esc(view.note)}</p>
      <p class="fin-hint">逾期宽限 ${num(view.graceMonths)} 个月：第 2 个月仍欠付才标记违约；不收罚息，提前还款不收手续费。</p>
    </section>`;
}

function renderOperatorElection(
  election: OperatorElectionView,
): string {
  const votesFor = (candidateId: string): number =>
    election.votes
      .filter((vote) => vote.candidateId === candidateId)
      .reduce((total, vote) => total + vote.votingShares, 0);
  const playerVote =
    election.votes.find(
      (vote) => vote.holder.type === 'player' && vote.holder.id === 'player',
    )?.candidateId ?? null;
  const candidateRows = election.candidates
    .map((candidate) => {
      const isPlayerCandidate = candidate.kind === 'player';
      const voteCount = votesFor(candidate.candidateId);
      const isVoted = playerVote === candidate.candidateId;
      return `
        <li class="op-candidate ${candidate.isIncumbent ? 'is-incumbent' : ''}">
          <div class="op-candidate-main">
            <b>${esc(candidate.name)}</b>
            ${candidate.isIncumbent ? '<span class="op-tag op-tag--incumbent">现任</span>' : ''}
            ${isPlayerCandidate ? '<span class="op-tag op-tag--player">玩家候选</span>' : ''}
            <em>${esc(candidateStyleLabel(candidate.style))}</em>
          </div>
          <div class="op-candidate-meta">
            <span class="op-votes">得票 ${num(voteCount)} 股</span>
            ${
              election.canVote
                ? `<button
                    type="button"
                    class="chip-btn ${isVoted ? 'is-selected' : ''}"
                    data-action="vote-election"
                    data-motion-id="${esc(election.motionId)}"
                    data-candidate-id="${esc(candidate.candidateId)}"
                    data-focus-key="vote-${esc(election.motionId)}-${esc(candidate.candidateId)}"
                    aria-pressed="${isVoted}"
                    title="按议案登记日快照股数投给 ${esc(candidate.name)}"
                  >${isVoted ? '已投' : '投票'}</button>`
                : ''
            }
          </div>
        </li>`;
    })
    .join('');
  const registerHtml = election.canRegister
    ? `<div class="op-actions">
        <button
          type="button"
          class="ken-btn ken-btn--blue ken-btn--mini"
          data-action="register-candidate"
          data-motion-id="${esc(election.motionId)}"
          data-focus-key="register-${esc(election.motionId)}"
          title="登记参选该企业经营者；投票期结束后按得票计票"
        >登记参选</button>
      </div>`
    : election.isCandidate
      ? '<p class="fin-hint">你已登记参选，等待投票期结束后计票。</p>'
      : '';
  return `
    <div class="detail-subsection op-election" data-testid="company-operator-election">
      <div class="sub-head">
        <h4>经营者选任</h4>
        <span>投票截止 T${num(election.closesTick)}</span>
      </div>
      <ul class="op-candidates">${candidateRows}</ul>
      ${
        election.canVote
          ? '<p class="fin-hint">你有表决权，可在截止前改票；票重按议案登记日快照股数计算。</p>'
          : '<p class="fin-hint">你在本议案登记日没有投票权，只能观察选任过程。</p>'
      }
      ${registerHtml}
    </div>`;
}

function renderPlayerOperation(company: Company, operation: OperationView): string {
  const auth = operation.authorization;
  const plan = operation.standingPlan;
  const modeButtons = OPERATION_MODE_OPTIONS.map((option) => {
    const active = operation.mode === option.id;
    return `<button
      type="button"
      class="ken-btn ken-btn--mini op-mode-btn ${active ? 'ken-btn--blue is-active' : 'ken-btn--grey'}"
      data-action="set-operation-mode"
      data-company-id="${esc(company.id)}"
      data-mode="${option.id}"
      data-focus-key="op-mode-${esc(company.id)}-${option.id}"
      aria-pressed="${active}"
      title="${esc(option.hint)}"
    >${esc(option.label)}</button>`;
  }).join('');
  const flag = (allowed: boolean): string =>
    allowed ? '<b class="is-ok">允许</b>' : '<b class="is-warn">需批准</b>';
  const presetButtons = (
    [
      { preset: 'conservative', label: '保守', hint: '投资 10 万 / 招聘 3 人 / 贷款 10 万，仅允许招聘与调价' },
      { preset: 'standard', label: '标准', hint: '使用配置默认授权：全开，按默认上限执行' },
      { preset: 'generous', label: '宽裕', hint: '投资 100 万 / 招聘 20 人 / 贷款 100 万，全开' },
    ] as const
  )
    .map(
      (option) => `<button
        type="button"
        class="ken-btn ken-btn--grey ken-btn--mini"
        data-action="set-operation-authorization"
        data-company-id="${esc(company.id)}"
        data-preset="${option.preset}"
        data-focus-key="op-auth-${esc(company.id)}-${option.preset}"
        title="${esc(option.hint)}"
      >${option.label}</button>`,
    )
    .join('');
  const planInputs = (
    [
      { field: 'utilization', label: '目标利用率', value: plan?.utilization ?? 0.8, step: 0.05, min: 0, max: 1 },
      { field: 'targetJobs', label: '目标岗位', value: plan?.targetJobs ?? company.jobDemand, step: 1, min: 0, max: undefined },
      { field: 'priceFactor', label: '价格系数', value: plan?.priceFactor ?? 1, step: 0.05, min: 0, max: undefined },
      { field: 'investmentPerMonth', label: '每月投资', value: plan?.investmentPerMonth ?? 0, step: 10_000, min: 0, max: undefined },
    ] as const
  )
    .map(
      (field) => `
        <label class="op-plan-field">
          <span>${esc(field.label)}</span>
          <input
            type="number"
            data-plan-field="${field.field}"
            data-focus-key="plan-${esc(company.id)}-${field.field}"
            value="${field.value}"
            step="${field.step}"
            min="${field.min}"
            ${field.max === undefined ? '' : `max="${field.max}"`}
            inputmode="decimal"
          />
        </label>`,
    )
    .join('');
  const planState = plan
    ? `当前计划：利用率 ${pct(plan.utilization, 1)} · 岗位 ${num(plan.targetJobs)} · 价格系数 ${num(plan.priceFactor, 2)} · 每月投资 ${money(plan.investmentPerMonth)}；到期 T${num(plan.expiresTick)}。`
    : '尚未设定持续经营计划；保存后持续生效，直到修改或到期。';
  const pending = operation.proposals.filter((proposal) => proposal.status === 'pending');
  const proposalRows =
    operation.proposals.length === 0
      ? '<p class="fin-hint">暂无待处理提案。</p>'
      : `<ul class="op-proposals">${operation.proposals
          .map(
            (proposal) => `
              <li class="op-proposal status-${esc(proposal.status)}">
                <div class="op-proposal-head">
                  <b>${esc(proposal.title)}</b>
                  <span>${esc(PROPOSAL_STATUS_LABELS[proposal.status])}</span>
                </div>
                <p class="op-proposal-summary">${esc(proposal.summary)}</p>
                ${
                  proposal.reasons.length > 0
                    ? `<ul class="op-proposal-reasons">${proposal.reasons
                        .slice(0, 3)
                        .map((reason) => `<li>${esc(reason)}</li>`)
                        .join('')}</ul>`
                    : ''
                }
                <div class="op-proposal-meta">
                  <span>金额 ${money(proposal.amount)}</span>
                  <span>提出 T${num(proposal.createdTick)}</span>
                  <span>到期 T${num(proposal.expiresTick)}</span>
                </div>
                ${
                  proposal.status === 'pending'
                    ? `<div class="op-proposal-actions">
                        <button
                          type="button"
                          class="ken-btn ken-btn--green ken-btn--mini"
                          data-action="decide-proposal"
                          data-proposal-id="${esc(proposal.id)}"
                          data-approve="1"
                          data-focus-key="approve-${esc(proposal.id)}"
                          title="批准并立即执行该提案"
                        >批准</button>
                        <button
                          type="button"
                          class="ken-btn ken-btn--red ken-btn--mini"
                          data-action="decide-proposal"
                          data-proposal-id="${esc(proposal.id)}"
                          data-approve="0"
                          data-focus-key="reject-${esc(proposal.id)}"
                          title="拒绝该提案；同一事项在冷却期内不会重复提出"
                        >拒绝</button>
                      </div>`
                    : ''
                }
              </li>`,
          )
          .join('')}</ul>`;
  return `
    <div class="detail-subsection op-operation" data-testid="company-operator-operation">
      <div class="sub-head">
        <h4>你的经营模式</h4>
        <span>${esc(operation.modeLabel)}</span>
      </div>
      <div class="op-modes" role="group" aria-label="经营模式">${modeButtons}</div>
      <div class="op-auth">
        <div class="op-auth-values">
          <span>月投资上限<b>${money(auth.maxInvestmentPerMonth)}</b></span>
          <span>月招聘上限<b>${num(auth.maxHiresPerMonth)} 人</b></span>
          <span>单笔贷款上限<b>${money(auth.maxLoanAmount)}</b></span>
        </div>
        <div class="op-auth-flags">
          <span>投资${flag(auth.allowInvestment)}</span>
          <span>招聘${flag(auth.allowHiring)}</span>
          <span>贷款${flag(auth.allowLoan)}</span>
          <span>调价${flag(auth.allowPriceAdjust)}</span>
        </div>
        <div class="op-presets" role="group" aria-label="授权预设">${presetButtons}</div>
      </div>
      <div class="op-plan">
        <div class="gov-sub-head"><span>持续经营计划</span><em>到期自动失效</em></div>
        <p class="op-plan-state">${esc(planState)}</p>
        <div class="op-plan-grid">${planInputs}</div>
        <div class="op-actions">
          <button
            type="button"
            class="ken-btn ken-btn--green ken-btn--mini"
            data-action="set-standing-plan"
            data-company-id="${esc(company.id)}"
            data-focus-key="save-plan-${esc(company.id)}"
            title="保存 4 项计划数值；计划持续生效，直到修改或到期"
          >保存计划</button>
        </div>
      </div>
      <div class="gov-sub-head"><span>提案</span><em>${pending.length} 项待批准</em></div>
      ${proposalRows}
    </div>`;
}

/**
 * v0.9：企业设备、产能与生产计划（公司「经营」标签）。
 * 设备交易全部走 GameStore 命令（canOperate 校验、真实付款）；面板本身只读，不维护账本。
 */
export function renderCompanyEquipmentSection(store: GameStore, company: Company): string {
  const view = store.companyOperatingView(company.id);
  if (!view) return '';
  const market = store.equipmentMarketView(company.cityId);
  const plan = view.plan;
  const isPlayerOperator = view.isPlayerOperator;
  // v1.4 §4：初始实物出资（模拟范围外）与锁定期。只读 company.initialEquipment；
  // 锁定台数由 equipment.ts 的只读函数按当前 tick 计算（锁定期满自动解禁）。
  const tick = store.world.time.tick;
  const grant = company.initialEquipment;
  const grantRow = grant ? view.equipmentRows.find((row) => row.kind === grant.kind) ?? null : null;
  const lockedUnits = grant ? lockedInitialEquipmentUnits(company, tick, grant.kind) : 0;
  const lockRemaining = grant ? Math.max(0, grant.lockUntilTick - tick) : 0;
  const totalOwnedUnits = view.equipmentRows.reduce((total, row) => total + row.units, 0);
  const inKindUnits = grant ? Math.min(grant.units, totalOwnedUnits) : 0;
  const marketPurchasedUnits = Math.max(0, totalOwnedUnits - inKindUnits);
  const lockLabel = !grant
    ? '无锁定设备'
    : lockRemaining > 0
      ? `${num(lockRemaining)} 个月后解禁`
      : '已解禁';
  const equipmentRows = view.equipmentRows
    .map(
      (row) => `
        <tr>
          <th scope="row">${esc(row.name)}</th>
          <td>${num(row.units)} 台</td>
          <td>${qty(row.unitCapacity)}</td>
          <td>${qty(row.capacity)}</td>
          <td>${money(row.catalogPrice)} / ${money(row.marketPrice)}</td>
          <td title="同城设备企业可立即交付的新机库存 / 政府开局设备储备">${num(row.supply)} / ${num(row.governmentStock)} 台</td>
        </tr>`,
    )
    .join('');
  const kindOptions = view.equipmentRows
    .map(
      (row) =>
        `<option value="${esc(row.kind)}">${esc(row.name)} · 目录 ${money(row.catalogPrice)}/台</option>`,
    )
    .join('');
  const ownedOptions = view.equipmentRows
    .filter((row) => row.units > 0)
    .map((row) => {
      const rowLocked = grant ? lockedInitialEquipmentUnits(company, tick, row.kind) : 0;
      return `<option value="${esc(row.kind)}">${esc(row.name)} · 持有 ${num(row.units)} 台${
        rowLocked > 0 ? `（锁定 ${num(rowLocked)} 台）` : ''
      }</option>`;
    })
    .join('');
  const held = view.equipmentRows.reduce((total, row) => total + row.units, 0);
  // v1.6 §四：设备月度维护费（独立期间费用，收款方为模拟范围外设备维护服务商）。
  // 计费口径 = 月初持有台数 × 月初该城该类新设备参考单价 × 费率（D1）；面板只读展示。
  const maintenanceRate = DEMO_CONFIG.equipment.maintenanceMonthlyRate ?? 0.01;
  const maintenanceLines = maintenanceBreakdown(store.world, company, DEMO_CONFIG);
  const maintenanceDue = maintenanceLines.reduce((total, line) => total + line.fee, 0);
  const maintenanceUnits = maintenanceLines.reduce((total, line) => total + line.units, 0);
  const maintenanceArrears = maintenanceArrearsOf(company);
  const lastMaintenance = company.lastMonth;
  const lastMaintenanceDue = lastMaintenance.maintenanceDue ?? 0;
  const lastMaintenancePaid = lastMaintenance.maintenancePaid ?? 0;
  const lastMaintenanceArrearsAdded = lastMaintenance.maintenanceArrearsAdded ?? 0;
  const maintenanceStatus = maintenanceArrears > 0.005
    ? `欠付 ${money(maintenanceArrears)}`
    : lastMaintenanceDue > 0.005
      ? '已付清'
      : '本月无计费';
  const maintenanceStatusClass = maintenanceArrears > 0.005
    ? 'is-warn'
    : lastMaintenanceDue > 0.005
      ? 'is-ok'
      : '';
  const maintenanceRows = maintenanceLines
    .filter((line) => line.units > 0)
    .map(
      (line) => `
        <tr data-testid="equipment-maintenance-row-${line.kind}">
          <th scope="row">${esc(line.name)}</th>
          <td>${num(line.units)} 台</td>
          <td>${money(line.unitPrice)}</td>
          <td>${pct(maintenanceRate, 0)}</td>
          <td>${money(line.fee)}</td>
        </tr>`,
    )
    .join('');
  const maintenanceTable =
    maintenanceUnits > 0
      ? `<div class="table-wrap">
          <table class="fin-table" aria-label="${esc(company.name)} 设备月度维护费" title="台数 × 月初参考单价 × ${pct(maintenanceRate, 0)}">
            <thead>
              <tr>
                <th scope="col">设备</th>
                <th scope="col">计费台数</th>
                <th scope="col">计价单价（新机参考价）</th>
                <th scope="col">费率</th>
                <th scope="col">月维护费</th>
              </tr>
            </thead>
            <tbody>${maintenanceRows}</tbody>
          </table>
        </div>`
      : '<p class="fin-hint" data-testid="equipment-maintenance-empty">当前没有设备台数，本月维护费为 0。</p>';
  const offers = market?.offers ?? [];
  const offerRows =
    offers.length === 0
      ? '<p class="fin-hint" data-testid="equipment-used-empty">本城暂无二手设备委托；其他企业出售设备后会出现在这里。</p>'
      : `<ul class="equip-offers">${offers
          .map((offer) => {
            const isOwn = offer.companyId === company.id;
            const action = !isPlayerOperator
              ? '<span class="equip-offer-note">只读</span>'
              : isOwn
                ? `<button
                    type="button"
                    class="ken-btn ken-btn--mini"
                    data-action="cancel-used-equipment"
                    data-company-id="${esc(company.id)}"
                    data-offer-id="${esc(offer.id)}"
                    data-focus-key="cancel-used-${esc(offer.id)}"
                  >撤单</button>`
                : `<button
                    type="button"
                    class="ken-btn ken-btn--gold ken-btn--mini"
                    data-action="buy-used-equipment"
                    data-company-id="${esc(company.id)}"
                    data-offer-id="${esc(offer.id)}"
                    data-units="${num(offer.units)}"
                    data-focus-key="buy-used-${esc(offer.id)}"
                  >买入 ${num(offer.units)} 台</button>`;
            return `
              <li class="equip-offer" data-testid="used-offer-${esc(offer.id)}">
                <div class="equip-offer-main">
                  <b>${esc(offer.kindName)}</b>
                  <span>${num(offer.units)} 台 · ${esc(offer.companyName)}${isOwn ? '（你经营）' : ''}</span>
                </div>
                <div class="equip-offer-meta">
                  <span>单价 ${money(offer.askPrice)}</span>
                  <span>发布于 T${num(offer.listedTick)}</span>
                  <span>${esc(offer.note)}</span>
                </div>
                ${action}
              </li>`;
          })
          .join('')}</ul>`;
  const planHtml = plan
    ? `<div class="equip-plan" data-testid="equipment-plan">
        <div class="equip-plan-grid">
          <span><i>计划产量</i><b>${qty(plan.plannedOutput)}</b></span>
          <span><i>计划岗位</i><b>${num(plan.plannedJobs)}</b></span>
          <span><i>设备上限</i><b>${qty(plan.equipmentLimit)}</b></span>
          <span><i>劳动上限</i><b>${qty(plan.laborLimit)}</b></span>
          <span><i>销售参考</i><b>${qty(plan.salesReference)}</b></span>
          <span><i>目标库存</i><b>${qty(plan.targetInventory)}</b></span>
          ${plan.emergency ? '<span class="is-warn"><i>状态</i><b>紧急下调</b></span>' : ''}
        </div>
        ${
          plan.reasons.length > 0
            ? `<ul class="equip-plan-reasons">${plan.reasons
                .slice(0, 4)
                .map((reason) => `<li>${esc(reason)}</li>`)
                .join('')}</ul>`
            : ''
        }
        <p class="fin-hint">计划更新于 T${num(plan.tick)}；产量取设备/劳动/原料支持产能三者最小，紧急时自动下调。</p>
      </div>`
    : '<p class="fin-hint" data-testid="equipment-plan-empty">暂无计划：推进 1 个月后，生产计划模块会按销售参考、目标库存与设备/劳动能力生成。</p>';
  const tradeForms = isPlayerOperator
    ? `<div class="equip-trade">
        <form class="equip-form" data-testid="equipment-buy-form" data-equipment-form="buy" onsubmit="return false">
          <div class="sub-head">
            <h4>购买新设备</h4>
            <span>真实付款 · 政府储备进入本城财政</span>
          </div>
          <div class="equip-form-row">
            <label>设备 <select data-equipment-kind="new">${kindOptions}</select></label>
            <label>数量 <input type="number" min="1" max="${num(market?.maxBuyUnitsPerMonth ?? 60)}" step="1" value="1" data-equipment-units /></label>
            <button
              type="button"
              class="ken-btn ken-btn--gold ken-btn--mini"
              data-action="buy-equipment"
              data-company-id="${esc(company.id)}"
              data-testid="buy-equipment-${esc(company.id)}"
              data-focus-key="buy-equipment-${esc(company.id)}"
            >购买</button>
          </div>
          <p class="fin-hint">新机优先由同城设备企业供货；不足部分动用政府储备（目录价付款）。每月最多买 ${num(market?.maxBuyUnitsPerMonth ?? 60)} 台。企业现金 ${money(view.cash)}。</p>
        </form>
        <form class="equip-form" data-testid="equipment-sell-form" data-equipment-form="sell" onsubmit="return false">
          <div class="sub-head">
            <h4>挂出二手设备</h4>
            <span>挂出后立即扣减产能</span>
          </div>
          <div class="equip-form-row">
            <label>设备 <select data-equipment-kind="sell">${
              ownedOptions || '<option value="farm">暂无可出售设备</option>'
            }</select></label>
            <label>数量 <input type="number" min="1" step="1" value="1" data-equipment-units ${held > 0 ? '' : 'disabled'} /></label>
            <label>单价 <input type="number" min="0" step="1" placeholder="留空 65% 目录价" data-equipment-price ${held > 0 ? '' : 'disabled'} /></label>
            <button
              type="button"
              class="ken-btn ken-btn--mini"
              data-action="sell-used-equipment"
              data-company-id="${esc(company.id)}"
              data-testid="sell-used-equipment-${esc(company.id)}"
              data-focus-key="sell-used-equipment-${esc(company.id)}"
              ${held > 0 ? '' : 'disabled'}
            >挂出</button>
          </div>
          <p class="fin-hint">默认挂单价 = 目录价 × ${pct(market?.usedPriceFactor ?? 0.65, 0)}；成交后买方付款、设备所有权即时转移。${
            lockedUnits > 0
              ? `锁定期内的 ${num(lockedUnits)} 台实物出资设备不可出售：后端会拒绝并提示可售台数。`
              : ''
          }</p>
        </form>
      </div>`
    : `<p class="fin-hint equip-readonly" data-testid="equipment-readonly">你目前不经营该企业：只能查看设备、产能与生产计划；购买/出售设备需要经营授权。</p>`;
  return `
    <section class="detail-subsection company-equipment" data-testid="company-equipment">
      <div class="sub-head">
        <h4>设备 · 产能 · 生产计划</h4>
        <span class="mini-tag">${esc(goodName(view.outputGood))}</span>
      </div>
      <div class="equip-kpis">
        <span><i>设备产能</i><b>${qty(view.equipmentCapacity)}</b><small>单位 / 月</small></span>
        <span><i>劳动产能</i><b>${qty(view.laborCapacity)}</b><small>单位 / 月</small></span>
        <span><i>计划产量</i><b>${plan ? qty(plan.plannedOutput) : '—'}</b><small>${plan ? `T${num(plan.tick)} 计划` : '暂无计划'}</small></span>
        <span><i>上月产出</i><b>${qty(view.lastMonth.produced)}</b><small>利用率 ${pct(view.utilization, 1)}</small></span>
        <span><i>员工 / 岗位</i><b>${num(view.employees)} / ${num(view.jobDemand)}</b><small>工资 ${money(view.monthlyWageBill)}/月</small></span>
        <span><i>成品库存</i><b>${qty(view.finishedStock)}</b><small>${
          view.sellableMonths === null ? '无销售参考' : `约 ${num(view.sellableMonths, 1)} 个月销量`
        }</small></span>
      </div>
      <div class="equip-block equip-initial" data-testid="equipment-initial">
        <div class="sub-head">
          <span>初始实物出资</span>
          <em>${grant ? '模拟范围外实物出资' : '无实物出资'}</em>
        </div>
        <div class="equip-kpis">
          <span><i>来源</i><b>${grant ? '模拟范围外实物出资' : '全部为市场采购'}</b><small>${
            grant ? `创办者带入 · T${num(grant.grantedTick)}` : '无创办实物出资记录（旧档/未带设备）'
          }</small></span>
          <span><i>实物出资台数</i><b>${grant ? `${num(grant.units)} 台${grantRow ? ` · ${esc(grantRow.name)}` : ''}` : '0 台'}</b><small>${
            grant ? '不计入游戏内设备生产/库存/销售' : '设备全部来自游戏内市场或政府储备'
          }</small></span>
          <span><i>实物出资估值</i><b>${grant ? money(grant.valuation) : '—'}</b><small>按创办时单价记录，仅审计</small></span>
          <span data-testid="equipment-initial-lock"${
            lockedUnits > 0 ? ' class="is-warn"' : ''
          }><i>锁定期剩余</i><b>${lockLabel}</b><small>${
            lockedUnits > 0
              ? `锁定 ${num(lockedUnits)} 台不可出售/转让`
              : grant
                ? '锁定期已满，设备可正常出售'
                : '设备全部可按二手规则出售'
          }</small></span>
          <span><i>市场采购</i><b>${num(marketPurchasedUnits)} 台</b><small>游戏内设备市场 / 政府储备</small></span>
          <span><i>持有合计</i><b>${num(totalOwnedUnits)} 台</b><small>设备产能按台数重算</small></span>
        </div>
        <p class="fin-hint">${
          grant
            ? `实物出资 ${num(grant.units)} 台锁定期至 T${num(grant.lockUntilTick)}：锁定期内尝试出售会被后端拒绝并给出可售台数；锁定期满后转为普通企业资产。`
            : '该企业没有实物出资记录：设备全部来自游戏内设备市场或政府储备，按二手设备规则出售。'
        }</p>
      </div>
      <div class="equip-block">
        <div class="sub-head"><span>设备持有</span><em>技术系数 ×${num(view.techMultiplier, 2)}</em></div>
        <div class="table-wrap">
          <table class="fin-table equip-table" aria-label="${esc(company.name)} 设备持有" title="单价与可购数量：同城设备企业库存 / 政府储备">
            <thead>
              <tr>
                <th scope="col">设备</th>
                <th scope="col">台数</th>
                <th scope="col">单台产能</th>
                <th scope="col">合计产能</th>
                <th scope="col">目录价 / 市场价</th>
                <th scope="col">可购（同城 / 储备）</th>
              </tr>
            </thead>
            <tbody>${equipmentRows}</tbody>
          </table>
        </div>
      </div>
      <div class="equip-block" data-testid="equipment-maintenance">
        <div class="sub-head">
          <span>设备月度维护费</span>
          <em>台数 × 月初新机参考价 × ${pct(maintenanceRate, 0)}</em>
        </div>
        <div class="equip-kpis">
          <span><i>本月计费台数</i><b>${num(maintenanceUnits)} 台</b><small>月初持有时点；闲置/停产同样计费</small></span>
          <span><i>本月应计</i><b data-testid="equipment-maintenance-total">${money(maintenanceDue)}</b><small>独立期间费用，计入税前利润</small></span>
          <span data-testid="equipment-maintenance-status" class="${maintenanceStatusClass}"><i>支付状态</i><b>${maintenanceStatus}</b><small>收款方：模拟范围外设备维护服务商</small></span>
          <span><i>上月实付 / 新增欠付</i><b>${money(lastMaintenancePaid)} / ${money(lastMaintenanceArrearsAdded)}</b><small>欠费影响分红、融资与清算</small></span>
        </div>
        ${maintenanceTable}
        <p class="fin-hint">维护费是独立期间费用，资金支付给模拟范围外“城市外部设备维护服务商”，不进入设备厂收入或政府税收。计费时点（D1）：当月买入下月起计费；当月卖出/挂单/返还/破产仍按月初台数计当月。现金不足时先按既有规则融资，仍不足记欠付，欠付未清不得分红。</p>
      </div>
      <div class="equip-block">
        <div class="sub-head"><span>本月工资与用工</span><em>${esc(sectorLabel(view.sector))}</em></div>
        <div class="equip-labor">
          <span><i>本月工资</i><b>${money(view.lastMonth.wagesPaid)}</b></span>
          <span class="${view.lastMonth.wageArrears > 0 ? 'is-warn' : ''}"><i>欠薪</i><b>${money(view.lastMonth.wageArrears)}</b></span>
          <span><i>奖金</i><b>${money(view.lastMonth.bonusPaid)}</b></span>
          <span class="${view.lastMonth.emergencyLayoffs > 0 ? 'is-warn' : ''}"><i>紧急裁员</i><b>${num(view.lastMonth.emergencyLayoffs)} 人</b></span>
          <span><i>上月销售</i><b>${qty(view.lastMonth.sold)}</b><small>出口 ${qty(view.lastMonth.exported)}</small></span>
          <span><i>设备支出 / 收入</i><b>${money(view.lastMonth.equipmentPurchased)} / ${money(view.lastMonth.equipmentSold)}</b></span>
        </div>
      </div>
      <div class="equip-block">
        <div class="sub-head"><span>生产计划</span><em>设备 / 劳动 / 原料取最小</em></div>
        ${planHtml}
      </div>
      ${tradeForms}
      <div class="equip-block equip-used" data-testid="equipment-used-market">
        <div class="sub-head"><span>本城二手设备</span><em>${offers.length} 条委托 · 买方付款后转移</em></div>
        ${offerRows}
      </div>
    </section>`;
}

/** D. 企业经营者区块：现任、选任状态与玩家经营模式。 */
export function renderCompanyOperatorBlock(store: GameStore, company: Company): string {
  const view = store.operatorView(company.id);
  if (!view) return '';
  const election = view.election;
  const operation = view.operation;
  const electionHtml = election ? renderOperatorElection(election) : '';
  const operationHtml = operation ? renderPlayerOperation(company, operation) : '';
  const idleNote =
    !view.isPlayerOperator && !election
      ? '<p class="fin-hint">你目前不经营该企业；持有有投票权股份可在选任时参选。</p>'
      : '';
  return `
    <section class="detail-subsection" data-testid="company-operator">
      <div class="sub-head">
        <h4>经营者与经营模式</h4>
        <span class="mini-tag">${esc(view.isPlayerOperator ? '你在经营' : operatorBasisLabel(view.basis))}</span>
      </div>
      <div class="op-incumbent">
        <div class="op-incumbent-main">
          <b>${esc(view.operatorName)}</b>
          <span class="op-style">${esc(view.styleLabel)}</span>
          <em>任职依据：${esc(operatorBasisLabel(view.basis))}</em>
          <em>${view.termMonthsLeft === null ? '任期：未设任期' : `剩余任期：${num(view.termMonthsLeft)} 个月`}</em>
        </div>
        <p class="op-style-note">${esc(view.styleDescription)}</p>
      </div>
      ${electionHtml}
      ${operationHtml}
      ${idleNote}
    </section>`;
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
      ${renderPopulationStrataSection(store, city)}
      ${renderInvestorSection(store, city)}
      ${renderPulse(city)}
    </section>
    ${renderCompanies(store, city, state.focusCompanyId)}
    ${renderPublicBankruptcyNotice(store, city)}
    ${renderGovernmentSection(store, city)}
    ${renderBondMarketSection(store)}
    ${renderTransportSection(store, city)}
    ${renderTalentMarketSection(store, city)}
    ${renderSystems(store, city)}
    ${renderMarket(city, state.showAllGoods)}
    ${renderBankSection(store, city)}
    ${renderAgreementsSection(store, city)}`;
}

function isPlayerFacingLog(message: string): boolean {
  return !/不变量|事务|校验|invariant|transaction/i.test(message);
}

export function renderLogDock(store: GameStore, collapsed: boolean): string {
  const totals = worldTotals(store.world, store.playerNetWorth);
  const lastDividend = store.world.player.dividendsReceived ?? store.world.player.lastDividend ?? 0;
  // 渲染期按当前身份重过滤（IMPLEMENTATION_v0.7 §8）；不得直接读 world.log。
  const logs = store
    .visibleLog()
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
