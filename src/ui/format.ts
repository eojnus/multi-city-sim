// UI 层的格式化与派生展示小工具。
// 只读取模拟数据，不修改任何世界状态。
import { DEMO_CONFIG } from '../data/config';
import { GOODS, RECIPES } from '../data/demo-data';
import { formatMoney, formatNumber, formatPercent } from '../simulation/core/math';
import type {
  City,
  Company,
  GoodDefinition,
  GoodId,
  LogKind,
  TradeFlow,
  WorldState,
} from '../simulation/contracts/types';
import type { BuildingKind, DistrictType } from '../data/city-layout';

const GOOD_MAP = new Map<string, GoodDefinition>(GOODS.map((good) => [good.id, good]));

const LOG_LABELS: Record<LogKind, string> = {
  system: '系统',
  market: '市场',
  labor: '劳动',
  production: '生产',
  trade: '贸易',
  population: '人口',
  government: '财政',
  player: '玩家',
  warning: '警告',
};

const SECTOR_LABELS: Record<Company['sector'], string> = {
  agriculture: '谷物种植',
  'fiber-farm': '纤维种植',
  textile: '纺织',
  food: '食品加工',
  garment: '成衣制造',
  metal: '金属加工',
  utility: '能源',
  appliance: '日用品',
  equipment: '设备制造',
};

const DISTRICT_TYPE_LABELS: Record<DistrictType, string> = {
  residential: '住宅',
  commercial: '商业',
  office: '办公',
  industrial: '工业',
  public: '公共',
  park: '公园',
};

const BUILDING_KIND_LABELS: Record<BuildingKind, string> = {
  residential: '住宅',
  commercial: '商业',
  office: '办公',
  industrial: '工业',
  public: '公共',
  park: '公园',
};

const ROLE_LABELS: Record<keyof Company['roles'], string> = {
  management: '管理',
  production: '生产',
  sales: '销售',
  research: '研发',
};

export function goodOf(id: GoodId): GoodDefinition | undefined {
  return GOOD_MAP.get(id);
}

export function goodName(id: GoodId): string {
  return GOOD_MAP.get(id)?.name ?? id;
}

export function goodUnit(id: GoodId): string {
  return GOOD_MAP.get(id)?.unit ?? '单位';
}

export function goodRecipeSummary(id: GoodId): string {
  const recipe = RECIPES[id];
  if (!recipe) return '无配方数据';
  if (recipe.inputs.length === 0) return '无材料投入';
  return recipe.inputs.map((input) => `${goodName(input.good)} ×${input.qty}`).join(' · ');
}

export function logKindLabel(kind: LogKind): string {
  return LOG_LABELS[kind] ?? kind;
}

export function sectorLabel(sector: Company['sector']): string {
  return SECTOR_LABELS[sector] ?? sector;
}

export function districtTypeLabel(type: DistrictType): string {
  return DISTRICT_TYPE_LABELS[type] ?? type;
}

export function buildingKindLabel(kind: BuildingKind): string {
  return BUILDING_KIND_LABELS[kind] ?? kind;
}

export function roleLabel(key: keyof Company['roles']): string {
  return ROLE_LABELS[key] ?? key;
}

export function money(value: number): string {
  return Number.isFinite(value) ? formatMoney(value) : '—';
}

export function num(value: number, digits = 0): string {
  return Number.isFinite(value) ? formatNumber(value, digits) : '—';
}

/** 商品数量/产能的紧凑显示：大数转万/亿，避免表格被长数字挤爆。 */
export function qty(value: number, digits = 1): string {
  if (!Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs >= 100_000_000) return `${(value / 100_000_000).toFixed(2)} 亿`;
  if (abs >= 1_000_000) return `${(value / 10_000).toFixed(0)} 万`;
  if (abs >= 10_000) return `${(value / 10_000).toFixed(digits)} 万`;
  return formatNumber(value, abs % 1 === 0 ? 0 : digits);
}

export function quantityTitle(value: number): string {
  return Number.isFinite(value) ? formatNumber(value, 1) : '—';
}

export function pct(value: number, digits = 1): string {
  return Number.isFinite(value) ? formatPercent(value, digits) : '—';
}

export function signedPct(value: number, digits = 1): string {
  if (!Number.isFinite(value)) return '—';
  const prefix = value > 0 ? '+' : '';
  return `${prefix}${formatPercent(value, digits)}`;
}

/** 模拟层的 lastPriceChangePct 已经以“百分点”存储（如 -3.01 表示 -3.01%）。 */
export function signedPointPercent(value: number, digits = 1): string {
  if (!Number.isFinite(value)) return '—';
  const prefix = value > 0 ? '+' : '';
  return `${prefix}${value.toFixed(digits)}%`;
}

export function signedMoney(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const prefix = value > 0 ? '+' : '';
  return `${prefix}${formatMoney(value)}`;
}

export function signClass(value: number): string {
  if (value > 0) return 'is-positive';
  if (value < 0) return 'is-negative';
  return 'is-zero';
}

export function deltaClass(value: number): string {
  if (value > 0) return 'is-up';
  if (value < 0) return 'is-down';
  return 'is-flat';
}

export function esc(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (char) => {
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

export function unemploymentRate(city: City): number {
  const laborForce = city.population.laborForce;
  return laborForce > 0 ? city.population.unemployed / laborForce : 0;
}

export function employmentRate(city: City): number {
  const laborForce = city.population.laborForce;
  return laborForce > 0 ? city.population.employed / laborForce : 0;
}

export function hexColor(value: number): string {
  return `#${(value >>> 0).toString(16).padStart(6, '0').slice(-6)}`;
}

export function cityName(world: WorldState, cityId: string): string {
  return world.cities.find((city) => city.id === cityId)?.name ?? cityId;
}

export interface WorldTotals {
  population: number;
  employed: number;
  unemployed: number;
  gdp: number;
  netWorth: number;
  unemploymentRate: number;
}

export function worldTotals(world: WorldState, netWorth: number): WorldTotals {
  const population = world.cities.reduce((total, city) => total + city.population.total, 0);
  const employed = world.cities.reduce((total, city) => total + city.population.employed, 0);
  const unemployed = world.cities.reduce((total, city) => total + city.population.unemployed, 0);
  const gdp = world.cities.reduce((total, city) => total + city.gdp, 0);
  const laborForce = world.cities.reduce((total, city) => total + city.population.laborForce, 0);
  return {
    population,
    employed,
    unemployed,
    gdp,
    netWorth,
    unemploymentRate: laborForce > 0 ? unemployed / laborForce : 0,
  };
}

export interface TradeGroup {
  fromCityId: string;
  toCityId: string;
  good: GoodId;
  qty: number;
  value: number;
  count: number;
}

export function aggregateTradeFlows(flows: TradeFlow[]): TradeGroup[] {
  const groups = new Map<string, TradeGroup>();
  for (const flow of flows) {
    const key = `${flow.fromCityId}>${flow.toCityId}:${flow.good}`;
    const current = groups.get(key);
    if (current) {
      current.qty += flow.qty;
      current.value += flow.value;
      current.count += 1;
    } else {
      groups.set(key, {
        fromCityId: flow.fromCityId,
        toCityId: flow.toCityId,
        good: flow.good,
        qty: flow.qty,
        value: flow.value,
        count: 1,
      });
    }
  }
  return [...groups.values()].sort((a, b) => b.value - a.value);
}

/** 按演示起始月推算回合对应的年月，用于日志/历史条目的紧凑时间标签。 */
export function tickDate(tick: number): string {
  const start = DEMO_CONFIG.simulation;
  const months = Math.max(0, Math.floor(tick)) + start.startMonth - 1;
  const year = start.startYear + Math.floor(months / 12);
  const month = (months % 12) + 1;
  return `${year}.${String(month).padStart(2, '0')}`;
}

export function localizeTime(iso?: string): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

export function shortTime(iso?: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

export function sizeLabel(bytes?: number): string {
  if (!bytes || bytes <= 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

/** 轻量 SVG 折线，用于 GDP 轨迹；不依赖任何图表库。 */
export function sparkline(
  values: number[],
  width = 140,
  height = 30,
  color = '#5fe3c0',
): string {
  const clean = values.filter((value) => Number.isFinite(value));
  if (clean.length < 2) {
    const y = (height / 2).toFixed(1);
    return (
      `<svg class="sparkline" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">` +
      `<line x1="1" y1="${y}" x2="${width - 1}" y2="${y}" stroke="${color}" stroke-width="1" stroke-dasharray="3 4" opacity="0.45"/>` +
      `</svg>`
    );
  }
  const min = Math.min(...clean);
  const max = Math.max(...clean);
  const span = max - min || 1;
  const step = width / (clean.length - 1);
  const points = clean.map((value, index) => {
    const x = index * step;
    const y = height - 3 - ((value - min) / span) * (height - 6);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const last = clean[clean.length - 1] ?? 0;
  const lastX = width;
  const lastY = height - 3 - ((last - min) / span) * (height - 6);
  return (
    `<svg class="sparkline" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">` +
    `<polygon points="0,${height} ${points.join(' ')} ${width},${height}" fill="${color}" opacity="0.11"/>` +
    `<polyline points="${points.join(' ')}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>` +
    `<circle cx="${lastX.toFixed(1)}" cy="${lastY.toFixed(1)}" r="2" fill="${color}"/>` +
    `</svg>`
  );
}
