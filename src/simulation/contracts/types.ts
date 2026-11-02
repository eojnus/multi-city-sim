// 公共数据契约：模拟层、表现层和存档共用。
// 这些类型描述的是“演示方案 v0.2”的数据结构，不代表最终策划规则。
// v0.2 新增证券/治理/居民投资/协议/通知数据；旧 v1 存档由 core/save.ts 迁移。

export const SAVE_FORMAT_VERSION = 6;
export const GAME_VERSION = '0.6.0';

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

/** v0.3：企业经营风格。不同风格使用同一套经济规则，但取舍不同。 */
export type CompanyStyle = 'growth' | 'steady' | 'return';

/** 企业最近一次经营计划（玩家可读，不含调试信息）。 */
export interface CompanyAiPlan {
  tick: number;
  style: CompanyStyle;
  utilization: number;
  targetJobs: number;
  /** 计入政策补贴后的月用工成本估算。 */
  expectedWageCost: number;
  /** 本月计划中计入的新增招聘补贴（每名新员工的补贴额）。 */
  hiringSubsidyPerHire: number;
  /** 本月计划中计入的稳岗补贴（每名在岗员工的补贴额）。 */
  retentionSubsidyPerEmployee: number;
  /** 计划用于设备/扩产的支出。 */
  investment: number;
  /** 计划原因，例如“库存积压，降低生产”。 */
  reasons: string[];
}

/** v0.3：企业自动经营的可追溯决策状态。 */
export interface CompanyAiState {
  style: CompanyStyle;
  riskTolerance: number;
  /** 连续亏损月份，用于困难判定与纾困资格。 */
  lossMonths: number;
  /** 经营月龄（用于新企业保护期）。 */
  ageMonths: number;
  lastPlan: CompanyAiPlan | null;
  lastDecision: string;
  lastDecisionTick: number;
}

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
  /** v0.3：自动经营风格与最近决策。旧存档迁移时按行业确定性分配。 */
  ai: CompanyAiState;
}

export interface MarketState {
  goodId: GoodId;
  price: number;
  supply: number;
  demand: number;
  consumerDemand: number;
  /** 企业按生产计划需要的采购量（资金不足前），见 producerDemand 的说明。 */
  producerRequired: number;
  /** 企业形成有效购买需求的数量：计划需求中，用自有采购预算 + 合法可用授信买得起的那部分。 */
  producerDemand: number;
  sold: number;
  /**
   * 未满足需求（缺货口径）：有效需求中因可售供应/配送不足而没有成交的数量。
   * 资金不足导致的未满足单独记在 unmetFunding，两者合计为计划需求减实际成交。
   */
  unmetDemand: number;
  /** 未满足需求（资金口径）：有计划需求、但自有预算 + 合法授信不足而没有形成有效需求的数量。 */
  unmetFunding: number;
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
  /** v0.3 起研发资助会推进等级；'initial-only' 表示尚未发生研发投入。 */
  status: 'initial-only' | 'active';
  note: string;
}

export interface PoliticsState {
  approval: number;
  rulingParty: string;
  electionInMonths: number | null;
  /** v0.3 起市长/选举由 politics 模块推进；'initial-only' 表示尚未举行选举。 */
  status: 'initial-only' | 'active';
  note: string;
}

/** v0.3：城市劳动力技能与培训状态（最小原型，不是完整教育系统）。 */
export interface WorkforceState {
  /** 0–1，对生产率与招聘速度有上限约束的影响。 */
  skillLevel: number;
  trainedThisMonth: number;
  trainedTotal: number;
  trainedLastTick: number;
}

/** v0.3：住房最小状态（仅用于住房支持政策闭环，不是完整房地产市场）。 */
export interface HousingState {
  units: number;
  demand: number;
  rentSubsidyPaid: number;
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
  /** v0.3：本月政策支出（从财政到企业/居民）。 */
  policySpending: number;
  /** v0.3：本月交通维护与建设支出。 */
  transportSpending: number;
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
  /** v0.3：技能与培训（政策闭环的最小状态）。 */
  workforce: WorkforceState;
  /** v0.3：住房最小状态。 */
  housing: HousingState;
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
  /** 买方按成交价支付的总额（容量惩罚不改变买方付款）。 */
  value: number;
  /** v0.3：卖方实际所得（跨城交易在期末按容量统一结算后填写）。 */
  sellerProceeds?: number;
  /** v0.3：容量不足造成的收益损失（不计入任何主体收入）。 */
  capacityLoss?: number;
  /** v0.3：该笔跨城交易适用的容量惩罚比例。 */
  penaltyRate?: number;
  /** v0.3：跨城交易的来源路径，用于统一容量核算。 */
  path?: 'contract' | 'agreement' | 'intercityPurchase' | 'householdPurchase';
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

export type HolderType = 'player' | 'company' | 'investorGroup' | 'city';

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

export type MotionKind = 'dividendPolicy' | 'operatorAppointment' | 'operatorElection';

export interface MotionVote {
  holder: HolderRef;
  vote: 'for' | 'against' | 'abstain';
  votingShares: number;
  tick: number;
  /** v0.4：选任议案中的候选票（仅 kind='operatorElection' 使用）。 */
  candidateId?: string;
}

/** v0.4：经营者选任议案中的候选人（候选人在议案创建时固定；玩家可在投票期内登记加入）。 */
export interface MotionCandidate {
  candidateId: string;
  kind: 'ai' | 'player';
  /** AI 候选人对应的经营者档案 id；玩家候选人为 null。 */
  operatorId: string | null;
  name: string;
  style: CompanyStyle | null;
  isIncumbent: boolean;
}

/** 议案登记日的投票权快照：议案创建时的持有人与股数。 */
export interface VotingEntitlement {
  holder: HolderRef;
  shares: number;
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
  /** v0.4：选任议案的候选人名单（kind='operatorElection' 时存在）。 */
  candidates?: MotionCandidate[];
  status: 'open' | 'passed' | 'rejected';
  /**
   * 表决权登记日快照（创建议案时记录）。
   * 只有快照内的持有人可投票；票重按快照股数计算。
   * 这是演示规则：议案期间的股份转让不会把同一批股票的票数转给新持有人。
   */
  eligible: VotingEntitlement[];
  votes: MotionVote[];
  decidedTick: number | null;
  result: string;
  note: string;
}

export interface CompanyControl {
  companyId: string;
  /** 'management' 表示职业经理人经营；换成具体持有人需经议案通过。 */
  operator: HolderRef | 'management';
  basis: 'management' | 'boardAppointment' | 'election';
  sinceTick: number;
  /** v0.4：现任经营者档案 id（AI 经营者）；职业经理人/玩家持有型经营者为 null。 */
  operatorId?: string | null;
  /** v0.4：任期结束的 tick（24 个月）；null 表示未设任期。 */
  termEndTick?: number | null;
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

// ---------------------------------------------------------------- 领导人、政策与财政流水

export type PolicyDomain =
  | 'employment'
  | 'enterprise'
  | 'industry'
  | 'technology'
  | 'trade'
  | 'welfare'
  | 'fiscal';

export type PolicyId =
  | 'hiringSubsidy'
  | 'retentionSubsidy'
  | 'vocationalTraining'
  | 'publicJobs'
  | 'startupSupport'
  | 'companyRelief'
  | 'equipmentSubsidy'
  | 'keyIndustrySupport'
  | 'researchGrant'
  | 'educationInvestment'
  | 'intercityTradeSupport'
  | 'transportInvestment'
  | 'unemploymentAid'
  | 'housingSupport'
  | 'taxAdjustment';

/** 领导人的被动属性：领域倾向 0–1 与一个重点行业。 */
export interface LeaderProfile {
  sectorAffinity: SectorId | null;
  domainLeanings: Record<PolicyDomain, number>;
  traitLabel: string;
  traitNote: string;
}

export interface Candidate {
  id: string;
  cityId: string;
  name: string;
  party: string;
  profile: LeaderProfile;
  /** 演示支持度 0–100，用于确定性的候选人排序。 */
  popularity: number;
  note: string;
}

export interface CityPoliticsState {
  cityId: string;
  candidates: Candidate[];
  /** 当前领导人（候选人之一）；null 表示玩家市长在任或尚未产生。 */
  leader: Candidate | null;
  termMonthsLeft: number;
  electionCount: number;
  lastElectionTick: number | null;
  lastResult: string;
}

export interface ElectionRecord {
  tick: number;
  cityId: string;
  winnerId: string;
  winnerName: string;
  playerWon: boolean;
  note: string;
}

export interface WorldPoliticsState {
  cities: CityPoliticsState[];
  elections: ElectionRecord[];
}

export interface FiscalEntry {
  id: string;
  tick: number;
  cityId: string;
  kind:
    | 'incomeTax'
    | 'corporateTax'
    | 'publicWages'
    | 'benefits'
    | 'policySpending'
    | 'policyTransfer'
    | 'transportConstruction'
    | 'transportMaintenance'
    | 'debtForgiven'
    | 'liquidationProceeds'
    | 'dividendIncome'
    | 'electionFee';
  /** 正数为财政收入，负数为财政支出。 */
  amount: number;
  source: string;
  policyId?: PolicyId;
  companyId?: string;
}

export interface FiscalState {
  ledger: FiscalEntry[];
  nextEntryId: number;
}

export interface ActivePolicy {
  id: string;
  cityId: string;
  policyId: PolicyId;
  budget: number;
  spent: number;
  monthsRemaining: number;
  startedTick: number;
  status: 'active' | 'completed' | 'cancelled';
  targetSector: SectorId | null;
  taxDirection: 'cut' | 'raise' | null;
  transportTarget: 'intracity' | string | null;
  effects: Record<string, number>;
  reason: string;
  note: string;
}

export interface PolicyHistoryEntry extends ActivePolicy {
  endedTick: number;
}

export interface PolicyState {
  active: ActivePolicy[];
  history: PolicyHistoryEntry[];
  lastRuns: { cityId: string; policyId: PolicyId; tick: number }[];
  /** 非玩家政府最近一次选政策的说明，供玩家理解。 */
  lastSelection: { tick: number; cityId: string; policyId: PolicyId | null; reason: string }[];
}

// ---------------------------------------------------------------- 交通（政府主导）与容量结算

export type TransportMode = 'road' | 'rail';

export interface TransportConstruction {
  targetLevel: number;
  monthsRemaining: number;
  totalMonths: number;
  costPaid: number;
  startedTick: number;
}

export interface TransportLink {
  id: string;
  fromCityId: string;
  toCityId: string;
  mode: TransportMode;
  level: number;
  maxLevel: number;
  construction: TransportConstruction | null;
  note: string;
}

export interface IntracityNetwork {
  cityId: string;
  roadLevel: number;
  railLevel: number;
  maxLevel: number;
  construction: TransportConstruction & { kind: 'road' | 'rail' } | null;
  note: string;
}

/** 一笔已成交但尚未按容量结算的跨城销售：买方已付款，卖方尚未入账。 */
export interface PendingIntercitySale {
  tick: number;
  path: 'contract' | 'agreement' | 'intercityPurchase' | 'householdPurchase';
  fromCityId: string;
  toCityId: string;
  corridorKey: string;
  sellerCompanyId: string;
  buyerCompanyId: string | 'households';
  good: GoodId;
  qty: number;
  grossValue: number;
  /** v0.5：居民跨城购买所属群体；容量差额退款按此归属到原购买群体（旧存档可为空）。 */
  householdGroupId?: string;
}

export interface TransportTradeRecord {
  tick: number;
  path: PendingIntercitySale['path'];
  corridorKey: string;
  fromCityId: string;
  toCityId: string;
  sellerCompanyId: string;
  buyerCompanyId: string;
  good: GoodId;
  qty: number;
  /** 买方付款（不因容量变化）。 */
  grossValue: number;
  /** 卖方实际所得。 */
  sellerProceeds: number;
  /** 收益损失 = grossValue - sellerProceeds，不计入任何主体收入。 */
  capacityLoss: number;
  /**
   * 买方退款（暂定结算）：容量不足时买方先按原价付款，期末把该笔差额退回买方，
   * 使买方净支付等于卖方实际所得。旧存档的历史记录可能没有该字段。
   */
  buyerRefund?: number;
  penaltyRate: number;
  demand: number;
  capacity: number;
}

export interface TransportCorridorStats {
  corridorKey: string;
  fromCityId: string;
  toCityId: string;
  demand: number;
  capacity: number;
  overloadRatio: number;
  penaltyRate: number;
}

export interface TransportIntracityStats {
  cityId: string;
  demand: number;
  capacity: number;
  utilization: number;
  /** 次月本地配送可用效率 0–1。 */
  deliveryEfficiency: number;
}

export interface TransportMonthStats {
  tick: number;
  demand: number;
  capacity: number;
  overloadRatio: number;
  penaltyRate: number;
  capacityLossTotal: number;
  freightSubsidy: number;
  maintenancePaid: number;
  corridors: TransportCorridorStats[];
  intracity: TransportIntracityStats[];
  trades: TransportTradeRecord[];
  note: string;
}

export interface TransportState {
  links: TransportLink[];
  intracity: IntracityNetwork[];
  pendingSales: PendingIntercitySale[];
  lastMonth: TransportMonthStats;
}

// ---------------------------------------------------------------- 企业成立与倒闭

export type FounderType = 'investorGroup' | 'company' | 'government';

export interface FoundingInvestor {
  type: FounderType;
  id: string;
  cash: number;
  shares: number;
}

export interface FoundingRecord {
  id: string;
  tick: number;
  cityId: string;
  companyId: string;
  companyName: string;
  sector: SectorId;
  recipeOutput: GoodId;
  founderType: FounderType;
  capital: number;
  investorCount: number;
  investors: FoundingInvestor[];
  governmentGrant: number;
  note: string;
}

export interface LiquidationHolding {
  holder: HolderRef;
  shares: number;
  amount: number;
}

export interface LiquidationRecord {
  id: string;
  tick: number;
  companyId: string;
  companyName: string;
  cityId: string;
  reason: string;
  employeesReleased: number;
  cash: number;
  debt: number;
  debtRepaid: number;
  debtForgiven: number;
  shareholderPayout: number;
  holdings: LiquidationHolding[];
  inventoryWrittenOff: { good: GoodId; qty: number; bookValue: number }[];
  inventoryBookValue: number;
  agreementsAffected: string[];
  note: string;
}

export interface CompanyLifecycleState {
  foundings: FoundingRecord[];
  liquidations: LiquidationRecord[];
  nextFoundingNumber: number;
  nextLiquidationNumber: number;
}

// ---------------------------------------------------------------- 居民群体与财富阶层
//
// 居民群体（household group）是“人口、收入与资产”的承载模型，**不是额外人口**：
// - 人数（people）由城市人口与就业权威派生，每月重算；一个居民只会落在一个群体里。
// - 现金（cash）是群体手头现金；银行存款权威在 world.banking.deposits 的 household 账户。
// - 股票权益复用现有 securities 账本：群体通过本城居民投资实体间接持股，
//   估值时按群体人口占本城比例归属实体净资产（首版暂定口径，见交付报告）。

export type OccupationClass =
  | 'management'
  | 'production'
  | 'sales'
  | 'research'
  | 'publicSector'
  | 'unemployed'
  | 'nonLabor';

export type WealthTier = 'low' | 'middle' | 'high';

export interface HouseholdMonthlyStats {
  /** 本月税后现金收入（工资 + 福利 + 股息返还，已扣个税）。 */
  income: number;
  wageIncome: number;
  benefits: number;
  dividendIncome: number;
  incomeTax: number;
  /** 本月实际消费支出（成交额）。 */
  consumption: number;
  /** 本月想要购买的商品成本（用于展示预算约束）。 */
  desiredConsumption: number;
  /** 本月转入居民投资实体的储蓄。 */
  savingsContribution: number;
  /** 本月现金净变化 = income - consumption - savingsContribution。 */
  netCashChange: number;
}

export interface HouseholdGroup {
  id: string;
  cityId: string;
  occupation: OccupationClass;
  name: string;
  /** 该群体人数；由城市人口/就业/企业岗位角色派生，不是独立人口权威。 */
  people: number;
  /** 手头现金（信用点）。银行存款不在本字段，见 world.banking.deposits。 */
  cash: number;
  lastMonth: HouseholdMonthlyStats;
  note: string;
}

/** 每城财富阶层统计快照（展示用；人口合计等于城市总人口）。 */
export interface HouseholdTierStat {
  tier: WealthTier;
  people: number;
  share: number;
  perCapitaWealth: number;
  perCapitaIncome: number;
  cash: number;
  deposits: number;
  /** 按本城居民投资实体净资产归属的股票权益（市值口径，不是现金）。 */
  equity: number;
}

export interface HouseholdWealthStats {
  cityId: string;
  tick: number;
  tiers: HouseholdTierStat[];
  totalPeople: number;
  totalCash: number;
  totalDeposits: number;
  totalEquity: number;
  /** 人均可支配收入（本月，按群体人数加权）。 */
  perCapitaIncome: number;
  /** 人均总资产（现金 + 存款 + 股票权益）。 */
  perCapitaWealth: number;
  note: string;
}

export interface HouseholdState {
  groups: HouseholdGroup[];
  lastStats: HouseholdWealthStats[];
}

// ---------------------------------------------------------------- 经营者、人才市场与选任

export interface OperatorTenure {
  companyId: string;
  companyName: string;
  fromTick: number;
  toTick: number;
  reason: string;
}

export interface OperatorProfile {
  id: string;
  name: string;
  style: CompanyStyle;
  /** 0–1 演示声望，用于候选人排序与人才市场展示。 */
  reputation: number;
  /** employed 表示正在经营某家企业；available 表示在人才市场待选。 */
  status: 'employed' | 'available';
  companyId: string | null;
  appointedTick: number | null;
  termEndTick: number | null;
  history: OperatorTenure[];
  note: string;
}

export type PlayerOperationMode = 'manual' | 'assisted' | 'delegated';

/** 高度托管模式下玩家为该企业预设的授权范围（超出范围的重大事项需玩家批准）。 */
export interface PlayerAuthorization {
  maxInvestmentPerMonth: number;
  maxHiresPerMonth: number;
  maxLoanAmount: number;
  allowInvestment: boolean;
  allowHiring: boolean;
  allowLoan: boolean;
  allowPriceAdjust: boolean;
}

export type ProposalKind = 'hire' | 'expand' | 'loan' | 'dividend' | 'price';
export type ProposalStatus = 'pending' | 'approved' | 'rejected' | 'executed' | 'expired';

export interface PlayerProposal {
  id: string;
  companyId: string;
  kind: ProposalKind;
  title: string;
  summary: string;
  reasons: string[];
  params: Record<string, number | string>;
  amount: number;
  status: ProposalStatus;
  createdTick: number;
  decidedTick: number | null;
  /** 去重键：同一去重键在冷却期内不会重复生成提案。 */
  dedupeKey: string;
  expiresTick: number;
  result: string;
}

/** 持续生效的经营计划（手动模式下由玩家设定，直到修改或条件失效）。 */
export interface StandingPlan {
  utilization: number;
  targetJobs: number;
  priceFactor: number;
  investmentPerMonth: number;
  expiresTick: number;
  note: string;
}

export interface PlayerCompanyOperation {
  companyId: string;
  mode: PlayerOperationMode;
  authorization: PlayerAuthorization;
  standingPlan: StandingPlan | null;
  proposals: PlayerProposal[];
  lastExecutedTick: number;
  note: string;
}

export interface ManagementState {
  operators: OperatorProfile[];
  playerOperations: PlayerCompanyOperation[];
  nextOperatorNumber: number;
}

// ---------------------------------------------------------------- 银行（独立系统，资金无限、不会倒闭）

export type BankOwnerKind = 'player' | 'household' | 'company' | 'investorGroup';

export interface BankOwner {
  kind: BankOwnerKind;
  id: string;
}

export interface DepositAccount {
  id: string;
  owner: BankOwner;
  balance: number;
  /** 月利率（如 0.001 = 0.10%）。 */
  rateMonthly: number;
  accruedInterest: number;
  lastInterestTick: number;
  openedTick: number;
  note: string;
}

export type LoanPurpose = 'workingCapital' | 'expansion' | 'personal' | 'migratedDebt';
export type LoanStatus = 'active' | 'repaid' | 'defaulted';

export interface LoanPayment {
  tick: number;
  principalDue: number;
  interestDue: number;
  principalPaid: number;
  interestPaid: number;
  /** 本次未付金额（转入欠款，不另计罚息）。 */
  arrears: number;
  note: string;
}

export interface LoanContract {
  id: string;
  borrower: BankOwner;
  purpose: LoanPurpose;
  /** 原始本金（等额本金还款的分母）。 */
  principal: number;
  outstanding: number;
  monthlyPrincipal: number;
  rateMonthly: number;
  termMonths: number;
  startTick: number;
  /** 首期还款 tick（放款后的下一月）。 */
  nextDueTick: number;
  paidPrincipal: number;
  paidInterest: number;
  /** 已计息但尚未支付的利息。 */
  accruedInterest: number;
  arrearsPrincipal: number;
  arrearsInterest: number;
  /** 连续欠付月数；≥2 标记违约。 */
  missedPayments: number;
  status: LoanStatus;
  payments: LoanPayment[];
  note: string;
}

/** 每月基于上一完整月数据生成的授信估值快照，当月保持稳定。 */
export interface CreditSnapshot {
  tick: number;
  borrower: BankOwner;
  /** 授信基准：个人 = 可核验净资产；企业 = 非负账面股权价值。 */
  baseValue: number;
  limitRate: number;
  limit: number;
  outstanding: number;
  available: number;
  method: 'netWorth' | 'equityBook';
  reason: string;
}

export interface BankMonthlyStats {
  tick: number;
  interestExpense: number;
  interestIncome: number;
  principalIssued: number;
  principalRepaid: number;
  depositsTotal: number;
  loansOutstanding: number;
  newDefaults: number;
  note: string;
}

export interface BankingState {
  deposits: DepositAccount[];
  loans: LoanContract[];
  snapshots: CreditSnapshot[];
  lastMonth: BankMonthlyStats;
  nextAccountNumber: number;
  nextLoanNumber: number;
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
  /** v0.3：候选人、领导人与选举。 */
  politics: WorldPoliticsState;
  /** v0.3：政策生效状态与结果记录。 */
  policies: PolicyState;
  /** v0.3：财政流水（每项收入与支出的来源）。 */
  fiscal: FiscalState;
  /** v0.3：城内/城际公路铁路与容量。 */
  transport: TransportState;
  /** v0.3：企业成立与倒闭记录。 */
  lifecycle: CompanyLifecycleState;
  /** v0.4：居民群体（人口、收入与资产承载模型；不是额外人口）。 */
  households: HouseholdState;
  /** v0.4：经营者、人才市场与玩家经营模式。 */
  management: ManagementState;
  /** v0.4：独立银行系统（存款、贷款、授信快照）。 */
  banking: BankingState;
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

/** v0.3：政策、交通与企业生命周期的统一命令结果。 */
export interface ActionResult {
  ok: boolean;
  error?: string;
  note?: string;
  amount?: number;
}
