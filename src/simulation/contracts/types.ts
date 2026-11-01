// 公共数据契约：模拟层、表现层和存档共用。
// 这些类型描述的是“演示方案 v0.2”的数据结构，不代表最终策划规则。
// v0.2 新增证券/治理/居民投资/协议/通知数据；旧 v1 存档由 core/save.ts 迁移。

export const SAVE_FORMAT_VERSION = 2;
export const GAME_VERSION = '0.2.0';

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
  /** v0.2：企业作为股东从其他企业取得的股息（进入企业现金，不重复计入居民收入）。 */
  dividendIncome: number;
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
  /** 已发行股份合计（v0.2 起为各股份类别的缓存汇总，权威在 securities.classes）。 */
  totalShares: number;
  lastMonth: CompanyMonthlyStats;
  /** v0.2：上一完整结算月的统计，经营计划只读取此字段。 */
  previousMonth: CompanyMonthlyStats;
  /** v0.2：股息派发比例，可由董事会/股东议案改变（演示规则）。 */
  dividendPayoutRatio: number;
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
  /** v0.2：居民投资实体从企业取得的股息（未扣除留存部分）。 */
  investorDividends: number;
  /** v0.2：本月从居民收入转入投资实体的可投资资金。 */
  investableContribution: number;
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

export interface PlayerRoles {
  /** 玩家担任市长的城市；null 表示尚未参选/未担任。演示场景可显式设置。 */
  mayorCityId: string | null;
}

export interface PlayerState {
  name: string;
  homeCityId: string;
  cash: number;
  /** v1 兼容的持股镜像（权威在 securities.holdings，由 securities 同步）。 */
  holdings: PlayerHolding[];
  /** 最近一次月度结算中玩家实际收到的股息（演示字段，旧存档可缺省）。 */
  lastDividend?: number;
  /** 至今累计收到的股息，便于界面在日志被裁剪后仍可见（旧存档可缺省）。 */
  dividendsReceived?: number;
  /** v0.2：玩家身份。默认不是任何城市的市长。 */
  roles: PlayerRoles;
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

// ---------------------------------------------------------------- 证券与股权

export type ShareKind = 'voting' | 'nonVoting';

export interface ShareClass {
  /** 稳定 ID，形如 `${companyId}:voting`。 */
  id: string;
  companyId: string;
  kind: ShareKind;
  issuedShares: number;
  note: string;
}

export type HolderType = 'player' | 'company' | 'investorGroup';

export interface HolderRef {
  type: HolderType;
  id: string;
}

export interface ShareHolding {
  companyId: string;
  shareClassId: string;
  holder: HolderRef;
  shares: number;
  /** primary = 企业融资；secondary = 二级市场；migration = 旧存档迁移。 */
  acquiredVia: 'primary' | 'secondary' | 'migration';
  sinceTick: number;
}

export interface StockOrder {
  id: string;
  companyId: string;
  shareClassId: string;
  side: 'buy' | 'sell';
  holder: HolderRef;
  /** 尚未成交的剩余股数。 */
  shares: number;
  limitPrice: number;
  createdTick: number;
  note: string;
}

export interface StockTrade {
  id: string;
  tick: number;
  companyId: string;
  shareClassId: string;
  buyer: HolderRef;
  seller: HolderRef;
  shares: number;
  unitPrice: number;
  value: number;
  origin: 'secondary' | 'primary';
}

export interface FinancingOffer {
  id: string;
  companyId: string;
  investor: HolderRef;
  /** 逐出资方决定：本次融资给予的股份类别。 */
  kind: ShareKind;
  amount: number;
  pricePerShare: number;
  shares: number;
  status: 'open' | 'accepted' | 'declined' | 'expired';
  createdTick: number;
  note: string;
}

export interface SecuritiesState {
  classes: ShareClass[];
  holdings: ShareHolding[];
  orders: StockOrder[];
  /** 最近一个结算月成交的股票交易，供界面与审计。 */
  lastTrades: StockTrade[];
  offers: FinancingOffer[];
}

// ---------------------------------------------------------------- 董事会与治理

export interface BoardSeat {
  holder: HolderRef;
  votingShares: number;
  sinceTick: number;
}

export interface Board {
  companyId: string;
  seats: BoardSeat[];
  chair: HolderRef | null;
  lastElectionTick: number;
  note: string;
}

export type MotionKind = 'dividendPolicy' | 'operatorAppointment';

export interface MotionVote {
  holder: HolderRef;
  vote: 'for' | 'against' | 'abstain';
  votingShares: number;
  tick: number;
}

export interface Motion {
  id: string;
  companyId: string;
  kind: MotionKind;
  title: string;
  proposedBy: HolderRef;
  createdTick: number;
  /** 在该 tick 的月度结算中计票。 */
  closesAtTick: number;
  /** dividendPolicy: { ratio }；operatorAppointment: { operatorType, operatorId }。 */
  params: Record<string, number | string>;
  status: 'open' | 'passed' | 'rejected';
  votes: MotionVote[];
  decidedTick: number | null;
  result: string;
  note: string;
}

export interface CompanyControl {
  companyId: string;
  /** 'management' 表示职业经理人经营；换成具体持有人需经议案通过。 */
  operator: HolderRef | 'management';
  basis: 'management' | 'boardAppointment';
  sinceTick: number;
  note: string;
}

export interface GovernanceState {
  boards: Board[];
  motions: Motion[];
  controls: CompanyControl[];
}

// ---------------------------------------------------------------- 居民投资实体

export interface InvestorGroup {
  id: string;
  cityId: string;
  name: string;
  cash: number;
  /** 占本城居民的比例（0–1），用于收入分配；不代表额外人口。 */
  populationShare: number;
  /** 0–1 的演示风险偏好，用于自动投资规则。 */
  riskAppetite: number;
  dividendsReceived: number;
  lastDividend: number;
  note: string;
}

// ---------------------------------------------------------------- 政府牵头的跨城协议

export type AgreementStatus = 'proposed' | 'active' | 'completed' | 'cancelled';

export interface AgreementParticipant {
  companyId: string;
  cityId: string;
  side: 'buyer' | 'seller';
  decision: 'pending' | 'accepted' | 'declined';
  decidedTick: number | null;
  note: string;
}

export type AgreementItemStatus = 'pending' | 'active' | 'fulfilled' | 'failed' | 'declined';

export interface AgreementItem {
  id: string;
  good: GoodId;
  buyerCompanyId: string;
  sellerCompanyId: string;
  qtyPerMonth: number;
  unitPrice: number;
  months: number;
  deliveredQty: number;
  paidValue: number;
  monthsExecuted: number;
  status: AgreementItemStatus;
  lastNote: string;
}

export interface TradeAgreement {
  id: string;
  title: string;
  sponsorCityId: string;
  partnerCityId: string;
  createdTick: number;
  /** government = 由市政府组织；demo = 明确标注的演示/测试场景。 */
  createdBy: 'government' | 'demo';
  status: AgreementStatus;
  participants: AgreementParticipant[];
  items: AgreementItem[];
  note: string;
}

// ---------------------------------------------------------------- 玩家通知

export type NotificationAudience = 'personal' | 'company' | 'city';
export type NotificationKind = 'dividend' | 'vote' | 'major' | 'agreement' | 'market';

export interface PlayerNotification {
  id: string;
  tick: number;
  audience: NotificationAudience;
  kind: NotificationKind;
  priority: 'normal' | 'important';
  companyId?: string;
  cityId?: string;
  title: string;
  body: string;
  read: boolean;
}

// ---------------------------------------------------------------- 世界与存档

export interface WorldState {
  seed: number;
  rngState: number;
  time: { year: number; month: number; tick: number };
  cities: City[];
  companies: Company[];
  tradeRoutes: TradeRoute[];
  player: PlayerState;
  securities: SecuritiesState;
  governance: GovernanceState;
  investors: InvestorGroup[];
  agreements: TradeAgreement[];
  notifications: PlayerNotification[];
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
  /** 读取失败分类：not-found 表示首次运行；其他错误意味着文件可能存在但无法读取，必须保护。 */
  code?: SaveReadErrorCode;
}

export type SaveReadErrorCode = 'not-found' | 'read-error' | 'too-large' | 'invalid-slot';

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

export interface TradeActionResult {
  ok: boolean;
  error?: string;
  shares?: number;
  unitPrice?: number;
  value?: number;
}
