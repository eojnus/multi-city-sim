// 公共数据契约：模拟层、表现层和存档共用。
// 这些类型描述的是“演示方案 v0.1”的数据结构，不代表最终策划规则。

export const SAVE_FORMAT_VERSION = 1;
export const GAME_VERSION = '0.1.0';

export type GoodId =
  | 'grain'
  | 'fiber'
  | 'fabric'
  | 'metal'
  | 'energy'
  | 'food'
  | 'clothing'
  | 'household';

export type GoodCategory = 'consumer' | 'producer';

export interface GoodDefinition {
  id: GoodId;
  name: string;
  category: GoodCategory;
  unit: string;
  basePrice: number;
  /** 演示参数：劳动适龄人口中每人每月的基础消费量，仅消费品使用。 */
  perCapitaMonthlyNeed: number;
  description: string;
}

export interface RecipeInput {
  good: GoodId;
  qty: number;
}

export interface Recipe {
  output: GoodId;
  inputs: RecipeInput[];
  description: string;
}

export type RoleKey = 'management' | 'production' | 'sales' | 'research';

export type RoleAllocation = Record<RoleKey, number>;

export type SectorId =
  | 'agriculture'
  | 'fiber-farm'
  | 'textile'
  | 'food'
  | 'garment'
  | 'metal'
  | 'utility'
  | 'appliance';

export interface CompanyMonthlyStats {
  revenue: number;
  inputCost: number;
  wagesPaid: number;
  wageArrears: number;
  interestPaid: number;
  corporateTax: number;
  dividendsPaid: number;
  profit: number;
  produced: number;
  sold: number;
  exported: number;
  unmetDemand: number;
  capacityChange: number;
}

export interface Company {
  id: string;
  name: string;
  cityId: string;
  sector: SectorId;
  recipeOutput: GoodId;
  cash: number;
  debt: number;
  capacity: number;
  baseCapacity: number;
  /** 演示参数：产能上限，初始值的倍数。玩家注资会同时提高该上限。 */
  maxCapacity: number;
  utilization: number;
  employees: number;
  baseWageBill: number;
  roles: RoleAllocation;
  jobDemand: number;
  wageRate: number;
  priceFactor: number;
  inventory: Record<GoodId, number>;
  totalShares: number;
  lastMonth: CompanyMonthlyStats;
  note: string;
}

export interface MarketState {
  goodId: GoodId;
  price: number;
  supply: number;
  demand: number;
  consumerDemand: number;
  producerDemand: number;
  sold: number;
  unmetDemand: number;
  intercityImported: number;
  externalExport: number;
  closingStock: number;
  lastPriceChangePct: number;
}

export interface PopulationState {
  total: number;
  employed: number;
  unemployed: number;
  nonLabor: number;
  laborForce: number;
}

export interface PublicSector {
  jobs: number;
  employees: number;
  wageRate: number;
}

export interface TechnologyState {
  level: number;
  researchPoints: number;
  productivityMultiplier: number;
  status: 'initial-only';
  note: string;
}

export interface PoliticsState {
  approval: number;
  rulingParty: string;
  electionInMonths: number | null;
  status: 'initial-only';
  note: string;
}

export interface RealEstateState {
  avgHomePrice: number;
  rentIndex: number;
  vacancyRate: number;
  status: 'initial-only';
  note: string;
}

export interface CityMonthlyReport {
  householdIncome: number;
  consumerSpend: number;
  consumerBudget: number;
  benefitsPaid: number;
  incomeTax: number;
  corporateTax: number;
  publicWageBill: number;
  gdp: number;
  migrationIn: number;
  migrationOut: number;
  note: string;
}

export interface City {
  id: string;
  name: string;
  englishName: string;
  tagline: string;
  color: string;
  region: { x: number; y: number; radius: number };
  population: PopulationState;
  publicSector: PublicSector;
  treasury: number;
  incomeTaxRate: number;
  corporateTaxRate: number;
  unemploymentBenefit: number;
  nonLaborTransfer: number;
  householdIncomeLastMonth: number;
  market: Record<GoodId, MarketState>;
  gdp: number;
  gdpHistory: { tick: number; value: number }[];
  lastMonth: CityMonthlyReport;
  technology: TechnologyState;
  politics: PoliticsState;
  realEstate: RealEstateState;
}

export interface TradeRoute {
  id: string;
  fromCityId: string;
  toCityId: string;
  fromCompanyId: string;
  toCompanyId: string;
  good: GoodId;
  monthlyTarget: number;
  distanceKm: number;
  active: boolean;
  note: string;
}

export interface TradeFlow {
  routeId: string;
  tick: number;
  fromCityId: string;
  toCityId: string;
  fromCompanyId: string;
  toCompanyId: string;
  good: GoodId;
  qty: number;
  unitPrice: number;
  value: number;
}

export interface ProductionRecord {
  tick: number;
  cityId: string;
  companyId: string;
  good: GoodId;
  qty: number;
  outputValue: number;
  inputValue: number;
  valueAdded: number;
  inputs: { good: GoodId; qty: number; value: number }[];
}

export interface PlayerHolding {
  companyId: string;
  shares: number;
}

export interface PlayerState {
  name: string;
  homeCityId: string;
  cash: number;
  holdings: PlayerHolding[];
  /** 最近一次月度结算中玩家实际收到的股息（演示字段，旧存档可缺省）。 */
  lastDividend?: number;
  /** 至今累计收到的股息，便于界面在日志被裁剪后仍可见（旧存档可缺省）。 */
  dividendsReceived?: number;
  note: string;
}

export type LogKind =
  | 'system'
  | 'market'
  | 'labor'
  | 'production'
  | 'trade'
  | 'population'
  | 'government'
  | 'player'
  | 'warning';

export interface LogEntry {
  tick: number;
  kind: LogKind;
  message: string;
}

export interface WorldHistoryPoint {
  tick: number;
  year: number;
  month: number;
  population: number;
  employed: number;
  unemployed: number;
  gdp: number;
  playerNetWorth: number;
}

export interface ExternalExport {
  tick: number;
  cityId: string;
  good: GoodId;
  qty: number;
  unitPrice: number;
  value: number;
  note: string;
}

export interface WorldState {
  seed: number;
  rngState: number;
  time: { year: number; month: number; tick: number };
  cities: City[];
  companies: Company[];
  tradeRoutes: TradeRoute[];
  player: PlayerState;
  history: WorldHistoryPoint[];
  log: LogEntry[];
  lastTick: {
    productionRecords: ProductionRecord[];
    tradeFlows: TradeFlow[];
    externalExports: ExternalExport[];
    migration: { fromCityId: string; toCityId: string; people: number; laborForce: number }[];
    invariants: string[];
  };
}

export interface SaveFile {
  formatVersion: number;
  gameVersion: string;
  savedAt: string;
  world: WorldState;
}

export interface SaveSlotInfo {
  slot: string;
  exists: boolean;
  savedAt?: string;
  formatVersion?: number;
  gameVersion?: string;
  size?: number;
  error?: string;
}

export interface SaveListResult {
  ok: boolean;
  slots: SaveSlotInfo[];
  error?: string;
}

export interface SaveReadResult {
  ok: boolean;
  slot: string;
  text?: string;
  savedAt?: string;
  error?: string;
}

export interface SaveWriteResult {
  ok: boolean;
  slot: string;
  savedAt?: string;
  error?: string;
}

export interface DesktopApi {
  platform: string;
  appVersion: string;
  saves: {
    list(): Promise<SaveListResult>;
    read(slot: string): Promise<SaveReadResult>;
    write(slot: string, text: string): Promise<SaveWriteResult>;
    remove(slot: string): Promise<{ ok: boolean; error?: string }>;
  };
  onMenuAction(callback: (action: string) => void): void;
  quit(): void;
}

export interface TickResult {
  ok: boolean;
  error?: string;
  tick?: number;
  invariants: string[];
}

export interface InvestmentResult {
  ok: boolean;
  error?: string;
  shares?: number;
  price?: number;
  companyName?: string;
}
