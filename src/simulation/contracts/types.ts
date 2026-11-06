// 公共数据契约：模拟层、表现层和存档共用。
// 这些类型描述的是“演示方案 v0.2”的数据结构，不代表最终策划规则。
// v0.2 新增证券/治理/居民投资/协议/通知数据；旧 v1 存档由 core/save.ts 迁移。

/** 顶层存档格式版本。v10 起为“模块化快照”格式；v1–v9 为旧单体 WorldState（读取时走既有迁移链）。 */
export const SAVE_FORMAT_VERSION = 10;
/** v1.6：本轮为“规则修复 + 经济规则调整”，新增字段全部可选、缺省安全，存档格式不升版。 */
export const GAME_VERSION = '1.7.0';

export type GoodId =
  | 'grain'
  | 'fiber'
  | 'fabric'
  | 'metal'
  | 'energy'
  | 'food'
  | 'clothing'
  | 'household'
  | 'farmEquipment'
  | 'industryEquipment'
  | 'energyEquipment';

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
  | 'appliance'
  /** v1.0：设备制造企业（生产农业/工业/能源设备，自身使用工业设备）。 */
  | 'equipment';

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
  /**
   * v1.6 §五 D6：连续“无产出且无销售”的月份计数（僵尸企业退出判定）。
   *
   * 由 checkBankruptcies 每月维护：上一完整月 produced≈0 且 sold+exported≈0 时 +1，
   * 有任何经营活动（生产/销售/出口）即清零；保护期内清零。达到 idleExitMonths 且
   * 现金+授信不足 1 个月固定成本、无恢复计划时清算。可选：旧存档缺省视为 0，
   * 不升 SAVE_FORMAT_VERSION。
   */
  idleMonths?: number;
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
  /** v0.9：本月实际发放的员工奖金（现金，计入工资性收入与个税税基）。 */
  bonusPaid?: number;
  /** v0.9：本月购买设备的支出（信用点，已含在现金变化中）。 */
  equipmentPurchased?: number;
  /** v0.9：本月出售设备（含二手机）取得的收入（信用点）。 */
  equipmentSold?: number;
  /** v0.9：本月因紧急裁员减少的员工数（不含常规裁员）。 */
  emergencyLayoffs?: number;
  /**
   * v0.7：经营活动现金流 = 销售收入 − 采购/工资/利息/税等经营支出（不含融资与股息）。
   * 可选：块1/数据块填充；未填充时报告用近似式并标注“近似”。
   */
  operatingCashFlow?: number;
  /**
   * v1.3：本月结转的销货成本（COGS）。
   *
   * 口径：采购支出先进入存货资产（Company.inventoryCost），生产消耗原料只把成本
   * 转入成品存货，不直接计入费用；只有成交（本地/跨城/区域外/协议/设备商品）时
   * 才按移动加权平均结转 COGS。利润 = 营收 − COGS − 期间费用（工资/利息/税等）。
   * 可选：旧存档/旧测试夹具未填时按旧现金制回退（cogs 缺失视为 inputCost）。
   */
  cogs?: number;
  /**
   * v1.3：本月库存注销损失（按账面价值，仅破产清算/报废等场景），
   * 不计入 COGS、不重复计成本；未填视为 0。
   */
  inventoryWriteOff?: number;
  /**
   * v1.4 §6.6：跨城运输容量退款中“超出该商品剩余账面成本”的部分。
   *
   * 退款的正常口径是冲减采购支出与存货账面成本（移动加权平均）；当货已售出/耗用、
   * 该商品账面成本不足以吸收整笔退款时，超出部分是真实的采购退款收益，必须计入
   * 当期利润（否则只留在现金流里，利润与现金流口径不一致）。利润公式因此为：
   * `profit = revenue − cogs − wagesPaid − corporateTax − interestPaid + bonusPaid + refundGain`
   * （bonusPaid 计入 wagesPaid 但不进利润，故计算利润时加回）。
   * 可选：旧存档/旧测试夹具未填时视为 0。
   */
  refundGain?: number;
  /**
   * v1.6 §四：本月应计设备维护费。
   *
   * 口径（D1）：= Σ 本月计费台数 × 所在城市该类新设备当月市场参考单价 × 维护费率；
   * 计费台数取**月初持有时点快照**（Company.maintenanceBase）——当月买入下月起计费，
   * 当月卖出/挂单/返还/破产仍计当月。该金额是独立期间费用，全额（含未付部分）
   * 计入本月税前利润；旧存档缺省按 0 处理。
   */
  maintenanceDue?: number;
  /**
   * v1.6 §四：本月以现金支付的本月维护费（不含偿还以前月份欠款）。
   * 收款方为模拟范围外“城市外部设备维护服务商”，不进入任何企业收入或政府税收。
   */
  maintenancePaid?: number;
  /** v1.6 §四：本月新增维护费欠付（= 应计 − 本月现金已付部分）。 */
  maintenanceArrearsAdded?: number;
  /** v1.6 §四：本月以现金偿还的以前月份维护费欠款（只冲负债，不重复计入费用）。 */
  maintenanceArrearsRepaid?: number;
  /** v1.6 §四：月末未付维护费余额（应付模拟范围外服务商；旧存档缺省 0）。 */
  maintenanceArrears?: number;
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
  /**
   * v1.3：库存账面成本（按商品记录移动加权平均的存货账面价值，合计 = 该商品单位成本 × 数量）。
   *
   * - 采购/调入：数量与成本同时增加（买家付多少记多少，含运费/跨城加价）；
   * - 生产消耗原料：按账面平均单价把成本转入成品存货（不产生费用）；
   * - 销售/调出：按账面平均单价结转 COGS 并减少账面价值；
   * - 破产清算/报废：按剩余账面价值一次性注销（inventoryWriteOff）。
   * 可选字段：旧 v9 存档缺失时由 save 读取路径按当期市场价补齐（标注为兼容估值）。
   */
  inventoryCost?: Record<GoodId, number>;
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
  /** v0.9：设备资产（按行业类别计数的可计量资产，不是现金或商品库存）。 */
  equipment: EquipmentAssets;
  /** v0.9：设备产能（缓存值，权威 = equipment × 单价产能 × 技术系数 + 迁移余量）。 */
  equipmentCapacity: number;
  /**
   * v0.9：v8 旧档迁移余量（显式存储）。
   *
   * 旧档只有总产能、没有设备台数，按整台设备映射后可能有余数。余量只由存档迁移写入：
   * 不随设备买卖转移、企业清算时随企业消失；企业产能 = 设备推导产能 + 本余量。
   */
  equipmentCapacityRemainder: number;
  /** v0.9：最近若干月实际销量（含出口），用于生产计划的销售参考量。 */
  salesHistory: number[];
  /** v0.9：本月生产计划（计划产量、设备/劳动约束与原因），供生产模块与界面读取。 */
  productionPlan: CompanyProductionPlan | null;
  /** v0.9：最近若干月税后利润（用于季度奖金条件）。 */
  recentProfits: number[];
  /**
   * v1.4 §4：创办者从模拟范围外带入的初始实物设备记录（旧档/无实物出资时缺省）。
   * 锁定期内不得出售/转让；企业提前退出时未到期部分返还出资方。
   */
  initialEquipment?: InitialEquipmentGrant;
  /**
   * v1.6 §四：设备维护费月初持有时点快照（D1）。
   *
   * 每个 tick 开始时（advanceTime 之后、任何设备买卖/挂单/破产之前）写入当时各类设备台数；
   * 月末财务按此快照计费：当月买入（含月中挂单后成交）下月起计费，当月卖出/挂单/返还/破产
   * 仍按月初台数计当月。旧存档缺省：首次 tick 开始即补齐，读取后不重复创建设备；
   * 在无 tick 的直调路径（测试/工具）缺省回退为当前 equipment 台数（旧档开始计费）。
   */
  maintenanceBase?: EquipmentAssets;
  /**
   * v1.6 §四：设备维护费月初计价快照：所在城市各类新设备当月市场参考单价。
   * 与 maintenanceBase 同一时点采集，保证“台数 × 单价”取价时点一致（D1）。
   */
  maintenancePrices?: EquipmentAssets;
  /**
   * v1.6 §四：未付设备维护费余额（应付模拟范围外设备维护服务商）。
   * 旧存档缺省视为 0；欠付会影响分红、融资与清算（见 equipment/maintenance.ts）。
   */
  maintenanceArrears?: number;
}

/** v0.9：设备类别。农业设备服务农业/纤维，工业设备服务加工制造，能源设备服务能源生产。 */
export type EquipmentKind = 'farm' | 'industry' | 'energy';

/** 企业持有的设备数量（按类别）。 */
export interface EquipmentAssets {
  farm: number;
  industry: number;
  energy: number;
}

/**
 * v1.4 §4：新企业成立时由创办者从模拟范围外带入的实物设备（外部实物出资）。
 *
 * 这是“模拟范围外的创办者带来的设备”，不是游戏内设备厂生产、不进入设备企业库存、
 * 不消耗政府开局库存、不产生财政补贴或设备市场成交。它只解除新企业的设备库存瓶颈，
 * 让最小可行规模企业能够真实开工；后续扩产仍必须通过游戏内设备市场购买。
 */
export interface InitialEquipmentGrant {
  kind: EquipmentKind;
  /** 带入的实物设备台数（最小可行规模，默认 1 台）。 */
  units: number;
  /** 实物出资估值（按创办时该设备单价；仅用于记录/审计，不计入现金或商品库存）。 */
  valuation: number;
  /** 来源：模拟范围外创办者实物出资（当前唯一合法来源）。 */
  source: 'founderInKind';
  grantedTick: number;
  /** 锁定期结束 tick：此前不得出售/转让；提前退出按实物返还出资方。 */
  lockUntilTick: number;
}

/**
 * v0.9：企业月度生产计划。把设备产能、劳动产能、计划产量与约束分开记录，
 * 实际产量由生产模块再按设备/劳动/原料三者取最小。
 */
export interface CompanyProductionPlan {
  tick: number;
  /** 销售参考量：最近 3 个月实际销量（含出口）均值；无历史时用有依据的初始预测。 */
  salesReference: number;
  /** 目标成品库存（销售参考量 × 目标库存月数）。 */
  targetInventory: number;
  /** 设备支撑的月产能（月末缓存）。 */
  equipmentLimit: number;
  /** 现有员工支撑的月产能。 */
  laborLimit: number;
  /** 计划产量（受设备/劳动/库存/资金约束，已应用 ±20% 平滑与紧急下调）。 */
  plannedOutput: number;
  /** 计划对应的岗位需求（用于招聘/裁员）。 */
  plannedJobs: number;
  /** 本月是否触发紧急下调（现金不足/严重积压）。 */
  emergency: boolean;
  /**
   * v1.6 §三：本企业可触达需求估计（本城缺货份额 + 资金缺口折算 + 降价机会 + 可达跨城，
   * 均已按企业份额分摊，未吸收）。可选：旧存档/旧测试夹具缺省视为 0。
   */
  reachableDemand?: number;
  /** v1.6 §三：潜在需求（资金缺口 + 降价 + 跨城，未吸收），与 reachableDemand 同期写入。 */
  latentDemand?: number;
  /** v1.6 §四.4：本月设备维护费估计（月度固定成本的一部分，不是 COGS）。 */
  maintenanceCost?: number;
  reasons: string[];
}

/** v0.9：企业挂出的二手设备出售委托（真实买家成交后才转移所有权与资金）。 */
export interface UsedEquipmentOffer {
  id: string;
  companyId: string;
  cityId: string;
  kind: EquipmentKind;
  units: number;
  askPrice: number;
  listedTick: number;
  note: string;
}

/**
 * v0.9：设备市场。设备商品由设备企业生产并进入其库存；企业购买时从设备企业库存
 * 或政府开局设备库存取得真实卖方与付款。二手设备通过 offers 撮合，没有买家时继续持有。
 */
export interface EquipmentMarketState {
  /** 政府开局设备库存（仅新开局注入；用于启动设备产业与创办企业；出售所得进入对应城市财政）。 */
  initialStock: EquipmentAssets;
  /** 二手设备出售委托（按企业、类别、价格）。 */
  offers: UsedEquipmentOffer[];
  lastMonthSold: EquipmentAssets;
  /**
   * 本月设备成交的市场账本增量（按城市+商品累积，旧存档可缺省）。
   *
   * 设备采购发生在 `createWorldLedgers` 之前（tick 内的经营计划/创办企业）或 tick 之间
   * （玩家操作），此时还没有当月 MarketLedger；若直接写 city.market 会被 step 12 的
   * finalizeMarkets 覆盖，导致设备商品需求/成交永远为 0。因此成交只记录增量，由
   * createWorldLedgers 合并进对应城市账本后清空。
   */
  pendingLedger?: EquipmentLedgerIncrement[];
  /**
   * 本月从企业库存转为设备资产（资本化）的设备台数，按商品累计（旧存档可缺省）。
   *
   * 设备成交时卖方企业库存减少、买方只增加固定资产，世界口径的“商品库存”会减少；
   * 结算审计必须显式扣减这部分资本化流出，否则会出现“库存不守恒”的误报。
   * tick 开始时清零（tick 之间的玩家操作在 startStock 快照前已生效，不需要重复扣减）。
   */
  capitalizedThisTick?: Partial<Record<GoodId, number>>;
  /**
   * v1.6 §四：本月设备维护费结算流水（月初建立、月末归档；收款方为模拟范围外服务商）。
   * 旧存档缺省：首次进入新 tick 时建立，历史缺失不影响计费。
   */
  maintenanceMonth?: EquipmentMaintenanceMonth;
  /**
   * v1.6 §四：设备维护费历史月度流水（最近 maxHistory 条，供报告/审计）。
   * 这是模拟范围外的独立费用流：资金流出模拟范围，不计入设备厂收入、政府税收或任何主体现金。
   */
  maintenanceHistory?: EquipmentMaintenanceMonth[];
}

/**
 * v1.6 §四：设备维护费月度结算流水（模拟范围外服务商收款，独立于企业/政府账本）。
 *
 * 计费口径（D1）：每类设备维护费 = 月初持有台数 × 所在城市该类新设备当月市场参考单价 × 费率，
 * 逐类求和；所有设备（含闲置、停产、二手、初始实物出资）都计费。
 */
export interface EquipmentMaintenanceMonth {
  tick: number;
  /** 本月计费台数（按类别汇总）。 */
  unitsByKind: EquipmentAssets;
  /** 本月应计费用（按类别汇总）= 台数 × 月初参考单价 × 费率。 */
  feeByKind: EquipmentAssets;
  /** 本月应计合计（= 本月费用现金已付 + 本月新增欠付）。 */
  totalDue: number;
  /** 本月现金支付合计（含偿还以前月份欠费）。 */
  totalPaid: number;
  /** 本月为支付维护费而新增的银行借款（真实放款，计入企业债务）。 */
  totalBorrowed: number;
  /** 本月新增欠付合计。 */
  totalArrearsAdded: number;
  /** 本月偿还以前月份欠款合计（只冲负债，不重复计入费用）。 */
  totalArrearsRepaid: number;
  /** 月末欠付余额合计（仅在营企业；清算企业欠费见 writtenOff）。 */
  totalArrearsOutstanding: number;
  /** 清算时确实无法收回而注销的欠费（服务商坏账；不在模拟范围内制造任何资金）。 */
  totalWrittenOff: number;
  /** 按城市汇总（供面板/报告核对服务收款流向）。 */
  byCity: Record<string, EquipmentMaintenanceCityFlow>;
  /** 本月已结算的企业 id（保证同一企业同一月只扣一次）。 */
  settledCompanyIds: string[];
  note: string;
}

/** 单城单月的设备维护费服务流水。 */
export interface EquipmentMaintenanceCityFlow {
  due: number;
  paid: number;
  borrowed: number;
  arrearsAdded: number;
  arrearsRepaid: number;
  arrearsOutstanding: number;
  writtenOff: number;
}

/** 设备成交对市场账本的增量（sold 同时计入 supply，保证 sold ≤ supply）。 */
export interface EquipmentLedgerIncrement {
  cityId: string;
  goodId: GoodId;
  /** 本月新增需求台数（含跨城进口需求）。 */
  demand: number;
  /** 本月本地成交台数（跨城进口不计 sold，只计 intercityImported）。 */
  sold: number;
  /** 跨城进口台数。 */
  intercityImported: number;
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
  /** v0.8：本月居民消费实际成交额中包含的消费税（基准税额，含税标价内 5%）。 */
  consumptionTax: number;
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
  /**
   * v0.7：财政与居民消费金融月度汇总（可选；块1/块3 填充，未填充时报告用近似式并标注）。
   * 单位均与既有字段一致（信用点）；不改变任何判定口径。
   */
  consumerLoanDrawn?: number;
  consumerLoanRepaid?: number;
  consumerLoanOutstanding?: number;
  bondInterestPaid?: number;
  bondPrincipalPaid?: number;
  bankAdvanceThisMonth?: number;
  /** 月末总负债（五段口径，见 IMPLEMENTATION_v0.7 §4）。 */
  totalDebtAtMonthEnd?: number;
  /** 本月债务/GDP 判定值与分母。 */
  debtRatioAtMonthEnd?: number;
  gdpJudgementValue?: number;
  /**
   * v0.8：本月税收（基准税额与实际入账）。
   * 基准税额 = 纳税人按税法实际承担的税额；实际入账 = 基准 × 交通税收系数。
   * 差额分列为交通财政加成 / 交通征收损耗（游戏化调整，不由纳税人补缴或退款）。
   */
  consumptionTax?: number;
  dividendTax?: number;
  transportTaxFactor?: number;
  transportTaxBonus?: number;
  transportTaxLoss?: number;
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
  /**
   * v0.7（DECISIONS v1.5 #42）：开局首月财政支出基线（信用点），供 AI 发债按
   * 「月支出倍数」计算触发阈值与补足目标；开局首月结算后写入，缺省时退回上月财政支出。
   * 可选字段，存档 v7 接受缺省。
   */
  fiscalExpenseBaseline?: number;
  /** v0.7：gdpHistory 只放真实月度 GDP；估计值带 estimated=true 且不得冒充真实历史。 */
  gdpHistory: { tick: number; value: number; estimated?: boolean }[];
  lastMonth: CityMonthlyReport;
  technology: TechnologyState;
  politics: PoliticsState;
  realEstate: RealEstateState;
  /** v0.3：技能与培训（政策闭环的最小状态）。 */
  workforce: WorkforceState;
  /** v0.3：住房最小状态。 */
  housing: HousingState;
  /**
   * v0.7：政府债务、应付项、银行垫付与破产状态。
   * 市长专属财政信息的数据源；界面必须经权限投影后再展示（见 MayorFiscalView）。
   */
  government: CityGovernmentState;
  /**
   * v0.7：破产判定用的最近 12 个游戏月 GDP 窗口（按 tick 升序，最多 12 条）。
   * 开局 12 条为估计值（estimated=true，tick 为负数表示游戏开始前的估计月），
   * 真实月度 GDP 到来后从最早的估计月逐月替换。**只有这里**用于债务/GDP 判定；
   * gdpHistory 仍是展示用的真实历史，不参与破产判定。
   */
  gdpWindow: CityGdpPoint[];
  /** v0.7：开局 12 个月估计 GDP 的来源与参数说明；迁移旧档时记录填补口径。 */
  gdpEstimate: GdpEstimateInfo | null;
  /**
   * v0.7：破产状态镜像（与 government.bankruptcy 同值，兼容旧读档与界面快速判断）。
   * 迁移后必定存在；旧档 v6 及以前没有该字段。
   */
  bankruptcy?: CityBankruptcyState;
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
  /**
   * v0.7：可见性标注（数据层权限表达）。
   * undefined 表示旧存档迁移前的历史条目：写档时由迁移/规范化补全，渲染期按保守规则处理。
   * 含义见 FiscalVisibility；渲染层必须按**当前** mayorCityId 重新过滤，不能只在写入时过滤。
   */
  visibility?: FiscalVisibility;
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

export type HolderType =
  | 'player'
  | 'company'
  | 'investorGroup'
  | 'city'
  /** v0.7：AI 经营者（CEO）以个人身份持股。 */
  | 'operator'
  /** v0.7：无股东时的无表决权托管持股（破产政府股份暂存，不销毁、不转给公司）。 */
  | 'trust';

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

/** v0.8：单个股份类别、单个游戏月的真实成交行情（K 线）。 */
export interface StockCandle {
  /** 游戏月（结算 tick）。 */
  tick: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** 本月成交股数。 */
  volume: number;
  /** 本月成交笔数。 */
  trades: number;
}

/**
 * v0.8：股份类别的月度行情历史。
 * 只记录真实成交（二级市场撮合与玩家手动成交），不写入账面参考价或挂单价；
 * 某月无成交时不生成 K 线（读档/新功能启用前显示“暂无数据”）。
 */
export interface StockClassHistory {
  shareClassId: string;
  companyId: string;
  kind: ShareKind;
  /** 按 tick 升序；保留最近 config.securities.historyMonths 根。 */
  candles: StockCandle[];
  /** 最近一次真实成交（可跨月），用于“最近成交价”；无成交时缺省。 */
  lastTrade?: { tick: number; price: number; shares: number };
  /** 企业摘牌/退出时的名称快照：企业记录被删除后仍能识别历史行情的归属（v0.8 复验）。 */
  companyName?: string;
  /** 股份类别被移除（企业退出）时的游戏月；存在即表示“已退出，不可交易”。 */
  exitedTick?: number;
  /**
   * v1.7 §五：超过最近 config.history.stockMonthlyMonths 个月的月线按年聚合后的真实 OHLCV。
   * 旧存档/尚未产生超窗口月线时缺省；归档只由真实月线计算，不伪造无成交月份。
   */
  yearlyCandles?: StockYearCandle[];
}

/**
 * v1.7 §五：股票月度 K 线的年度聚合归档（仅由真实月线计算，不新造行情）。
 * 幂等键：year——同一股份类别每年只增量合并一次；Σ months = 该年真实有成交的月线根数。
 */
export interface StockYearCandle {
  /** 游戏日历年（与 StockCandle.tick 对应的日历年）。 */
  year: number;
  /** 该年真实成交月份中最早一根月线的开盘价。 */
  open: number;
  /** 该年真实成交月份中的最高价。 */
  high: number;
  /** 该年真实成交月份中的最低价。 */
  low: number;
  /** 该年真实成交月份中最晚一根月线的收盘价。 */
  close: number;
  /** 该年真实成交月线的成交量合计。 */
  volume: number;
  /** 该年真实成交月线的成交笔数合计。 */
  trades: number;
  /** 参与汇总的真实月线根数（= 该年有成交的月份数；无成交月不生成、不补 0）。 */
  months: number;
  /** 参与汇总月线的最小/最大 tick（用于增量合并与审计）。 */
  firstTick: number;
  lastTick: number;
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
  /** v0.8：按股份类别保存的月度 K 线（真实成交，不虚构历史）。 */
  history: StockClassHistory[];
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

/**
 * v1.7 §五：已结束治理议案的年度聚合归档（只归档终态；open 议案永不归档）。
 * 幂等键：year + companyId + kind；公司名称是归档时的快照，企业退出后仍可识别。
 */
export interface ArchivedMotionYear {
  year: number;
  companyId: string;
  companyName: string;
  kind: MotionKind;
  count: number;
  passed: number;
  rejected: number;
  /** 二元议案（dividendPolicy/operatorAppointment）赞成/反对票合计；选任议案恒为 0。 */
  votesFor: number;
  votesAgainst: number;
  decidedFirstTick: number;
  decidedLastTick: number;
}

export interface GovernanceState {
  boards: Board[];
  motions: Motion[];
  controls: CompanyControl[];
  /** v1.7 §五：超过保留窗口的已结束议案按年聚合归档（旧档/未归档时缺省）。 */
  motionYears?: ArchivedMotionYear[];
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
export type NotificationKind =
  | 'dividend'
  | 'vote'
  | 'major'
  | 'agreement'
  | 'market'
  /** v0.7：市级财政/债券/破产事件（公开事件或市长专属，由 visibility 决定）。 */
  | 'fiscal'
  | 'bankruptcy';

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
  /**
   * v0.7：可见性标注（数据层权限表达）。与 audience（通知目标类型）是两个不同维度：
   * audience 表示“这条通知属于玩家/企业/城市哪一类主体”，visibility 表示“哪些玩家有资格看到”。
   */
  visibility?: FiscalVisibility;
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

/**
 * v1.7 §五：选举历史的年度聚合归档（只归档已有结果的记录，幂等键 cityId + year）。
 * winnerId 不归档（候选人每届可能重建，保留展示用姓名快照）。
 */
export interface ArchivedElectionYear {
  year: number;
  cityId: string;
  count: number;
  playerWins: number;
  lastWinnerName: string;
  lastElectionTick: number;
}

export interface WorldPoliticsState {
  cities: CityPoliticsState[];
  elections: ElectionRecord[];
  /** v1.7 §五：超过保留窗口的选举记录按 城市×年 聚合归档（旧档/未归档时缺省）。 */
  electionYears?: ArchivedElectionYear[];
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
    | 'electionFee'
    // v0.7：政府融资、债券与垫付（金额方向见各注释；均为真实资金流动）。
    | 'governmentLoanProceeds'
    | 'governmentLoanRepayment'
    | 'governmentLoanInterest'
    | 'bondIssuanceProceeds'
    | 'bondInterest'
    | 'bondPrincipal'
    | 'bankAdvance'
    | 'debtWriteOff'
    // v0.8：消费税、股息税与交通税收调整（游戏化财政加成/损耗）。
    | 'consumptionTax'
    | 'dividendTax'
    | 'transportTaxBonus'
    | 'transportTaxLoss';
  /** 正数为财政收入，负数为财政支出。 */
  amount: number;
  source: string;
  policyId?: PolicyId;
  companyId?: string;
}

/**
 * v1.7 §五：财政流水的年度聚合归档。幂等键：year + cityId + kind。
 * 余额不在账本（余额 = city.treasury）；归档只减少审计明细，不改变任何余额语义。
 */
export interface ArchivedFiscalYear {
  year: number;
  cityId: string;
  kind: FiscalEntry['kind'];
  count: number;
  /** 归档流水金额合计（正=收入，负=支出），与明细逐笔相加守恒。 */
  amount: number;
}

export interface FiscalState {
  ledger: FiscalEntry[];
  nextEntryId: number;
  /** v1.7 §五：超过明细保留窗口的财政流水按 城市×年×kind 聚合归档（旧档/未归档时缺省）。 */
  archivedLedger?: ArchivedFiscalYear[];
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
  /** v1.4 §五：执行追踪（可选，旧存档/旧测试夹具缺省）。 */
  tracking?: PolicyTracking;
  /** v1.5 §四：决策时参考预算（AI=体检动态预算或固定默认；可选，旧档缺省）。 */
  referenceBudget?: number;
  /** v1.5 §四：本月已预留、真实可动用的政策资金（财政余额或真实到账借款；可选）。 */
  reservedThisMonth?: number;
  /** v1.5 §四：本月预留后未实际支付的部分（不得计入受益/收入；可选）。 */
  unpaidThisMonth?: number;
  /** v1.5 §四：本月资金实际来源。 */
  fundingSourceThisMonth?: PolicyFundingSource;
}

export interface PolicyHistoryEntry extends ActivePolicy {
  endedTick: number;
}

/** v1.5 §四：政策资金的真实来源（借款必须真实到账，不凭空造钱）。 */
export type PolicyFundingSource = 'treasury' | 'bankLoan' | 'none';

/**
 * v1.6 §一.1：单城单月、单项 AI 危机政策的预算分项（金额单位：信用点，保留 2 位小数）。
 *
 * 口径：本月“月政策预算”是该城当月全部 AI 危机政策的**总额度**（quota = 当月体检 budget），
 * 不是每项政策各自一份。总额度按各政策参考需求权重用最大余数法分配；分项 referenceBudget
 * 之和 = 本月总额度分配（≤ quota，同一笔预算不得重复使用）。claim 是未受额度封顶的真实
 * 月度需求估算，仅用于审计“需求 vs 分配 vs 实支 vs 未支付”。
 */
export interface PolicyBudgetAllocation {
  /** 政策实例 id（ActivePolicy.id）。 */
  policyInstanceId?: string;
  policyId: PolicyId;
  /** 本月分到的参考预算额度（权重分配结果；同城同月各项之和 = 本月总额度分配）。 */
  referenceBudget: number;
  /** 本月真实月度现金需求估算（未受额度封顶；公共岗位为在岗工资口径）。 */
  claim: number;
  /** 本月真实已预留资金（≤ 分项额度，且只来自财政余额/真实到账借款）。 */
  reserved: number;
  /** 本月实际支出（政策流水实支 + 公共岗位按 fiscal.publicWages 实付归属的部分）。 */
  spent: number;
  /** 本月未支付（不计受益/居民收入；≤ 分项额度）。 */
  unpaid: number;
  /** 仅公共岗位：本月按真实支付记录归属本政策的公共工资（可能超出分项额度）。 */
  publicWagesAttributed: number;
}

/** v1.5 §四：单城单月政策资金顺序追踪（决策参考 → 税收 → 公共工资/福利 → 借款到账 → 预留 → 实支）。 */
export interface PolicyFundingMonth {
  tick: number;
  cityId: string;
  /** 本月 AI 政策参考预算合计（体检动态预算或固定默认；不是已到账资金）。 */
  referenceBudget: number;
  /** 本月税收实际入账（财政流水真实值）。 */
  taxReceived: number;
  /** 本月公共工资（支出口径，正数）。 */
  publicWages: number;
  /** 本月福利实际支付（正数）。 */
  benefitsPaid: number;
  /** 公共工资 + 福利（必要支出）。 */
  essentialSpending: number;
  /** 政策预留前财政余额。 */
  treasuryBeforeFunding: number;
  /** 为政策补足而真实到账的政府借款（银行放款，真实增加财政余额与债务）。 */
  borrowingProceeds: number;
  debtRatioBefore: number;
  debtRatioAfterBorrowing: number;
  /** 本月真实可动用的政策预留额。 */
  reserved: number;
  /** 本月实际支付（政策流水）。 */
  spent: number;
  /** 预留但未实际支付（不得计入受益/收入）。 */
  unpaid: number;
  fundingSource: PolicyFundingSource;
  note: string;
  /**
   * v1.6 §一.1：本月“月政策预算”总额度（quota = 当月体检 budget；不是已到账资金）。
   * 可选字段：旧存档/旧测试夹具缺省视为未记录。
   */
  quota?: number;
  /**
   * v1.6 §一.1：本月按政策分项分配（可选）。各项 referenceBudget 之和 = 本月总额度分配，
   * 且 ≤ quota；claim/reserved/spent/unpaid 均按分项封顶（公共岗位工资归属见 publicWage* 字段）。
   */
  policyBudgets?: PolicyBudgetAllocation[];
  /** v1.6 §一.2：本月按真实支付记录归属政策的必要公共工资实发（fiscal.publicWages 口径）。 */
  publicWagesAttributed?: number;
  /**
   * v1.6 §一.2：公共工资实发中超出公共岗位分项额度的部分（边界加项）。
   * 这是已经真实支付、按实付记录归属的工资，不是为凑边界改写出来的金额。
   */
  publicWagesOverQuota?: number;
}

/**
 * v1.6 §一.2：单城单月公共岗位统计（可选，旧存档缺省为空）。
 *
 * 口径：
 * - jobsAdded 是“本月新增岗位数”（岗位，不是人次；政策启动当月一次性计入）；
 * - headcount 是“本月月末实际在岗人数”（headcount，本月快照，不可跨月相加当新增）；
 * - jobsRemoved 是本月因到期/取消/低效停止而撤销的岗位数；
 * - wagesPaid 是本月按 fiscal.publicWages 真实支付记录归属公共岗位政策的工资（信用点）。
 * 累计字段中 jobsAddedCumulative 是去重岗位累计，personMonthsCumulative 是“在岗人次”
 * （Σ 各月 headcount），两者口径不同，报告不得把人次叫新增人数。
 */
export interface PublicJobsMonth {
  tick: number;
  cityId: string;
  /** 本月新增岗位数（岗位，不是人次）。 */
  jobsAdded: number;
  /** 本月月末实际在岗人数（headcount）。 */
  headcount: number;
  /** 本月撤销岗位数（政策结束/取消/低效停止）。 */
  jobsRemoved: number;
  /** 本月实际支付且归属公共岗位政策的工资（信用点，fiscal.publicWages 实付记录）。 */
  wagesPaid: number;
  /** 截至本月累计新增岗位（ΣjobsAdded，去重岗位数，不是人次）。 */
  jobsAddedCumulative: number;
  /** 截至本月累计在岗人次（Σheadcount；是“人次”，不是新增人数）。 */
  personMonthsCumulative: number;
  /** 截至本月累计撤销岗位数。 */
  jobsRemovedCumulative: number;
  /** 截至本月累计实际支付公共工资（信用点）。 */
  wagesPaidCumulative: number;
  /** 截至本月尚未撤销的岗位净额（= 累计新增 − 累计撤销）。 */
  jobsOutstanding: number;
  note: string;
}

export interface PolicyState {
  active: ActivePolicy[];
  history: PolicyHistoryEntry[];
  lastRuns: { cityId: string; policyId: PolicyId; tick: number }[];
  /** 非玩家政府最近一次选政策的说明，供玩家理解。 */
  lastSelection: { tick: number; cityId: string; policyId: PolicyId | null; reason: string }[];
  /**
   * v1.4 §五：AI 政府每月经济体检快照（可选，旧存档缺省为空）。
   *
   * 只保存可重复计算的月度观测值，用于失业率 3 月均值/趋势、分级迟滞（避免边界抖动）
   * 与“不足 3 个月开局”的处理；不保存任何未落地的承诺或虚构数据。
   */
  checkups?: EconomicCheckup[];
  /**
   * v1.5 §四：单城单月政策资金顺序追踪（可选，旧存档缺省为空；只保留最近若干月）。
   * 用于区分参考预算/已预留/实际支出，并让报表核对税收入账 → 必要支出 → 借款到账 → 预留 → 实支。
   */
  fundingMonths?: PolicyFundingMonth[];
  /**
   * v1.6 §一.2：公共岗位月度统计（可选，旧存档缺省为空；只保留最近若干月）。
   * 区分本月新增岗位数 / 实际在岗人数 / 撤销岗位 / 实付工资，并分别给出累计岗位与累计人次。
   */
  publicJobsMonths?: PublicJobsMonth[];
}

/** v1.4 §五：AI 政府经济体检的失业分级。 */
export type UnemploymentTier = 'normal' | 'strained' | 'severe' | 'crisis';

/**
 * v1.4 §五：政策某次月度执行的可追溯记录。
 *
 * 记录原因、资金来源、周期、实际支出、受益人数、就业效果与财政影响；
 * 救助类额外记录理论需求/实发/未支付（未支付部分不计入居民收入）。
 */
export interface PolicyExecutionRecord {
  tick: number;
  reason: string;
  fundingSource: string;
  periodMonths: number;
  spent: number;
  beneficiaries: number;
  /** 对就业的净效果（新增岗位为正、退出为负；培训/补贴不虚构岗位）。 */
  jobsEffect: number;
  /** 对财政的净影响（支出为负；只记实际发生额）。 */
  fiscalImpact: number;
  /** 仅失业救助：理论需求。 */
  theoreticalNeed?: number;
  /** 仅失业救助：实际发放。 */
  paid?: number;
  /** 仅失业救助/预留制政策：未支付（不计入居民收入）。 */
  unpaid?: number;
  /** v1.5 §四：本月参考预算（决策口径，不是资金）。 */
  referenceBudget?: number;
  /** v1.5 §四：本月已预留、真实可动用资金。 */
  reserved?: number;
  note?: string;
}

/**
 * v1.4 §五：政策执行追踪。
 *
 * - 招聘补贴只按“真实净新增岗位”发放：hiringBaseline 记录启动时在岗人数（只增不减），
 *   subsidisedJobs 记录已补贴人次，先裁后招不会重复领取；
 * - 公共工程记录设立岗位、启动时在岗人数与工资来源，便于核对预留/实付/账本；
 * - runs 保留最近若干次执行，效果差时 AI 可据此停止。
 */
export interface PolicyTracking {
  runs: PolicyExecutionRecord[];
  hiringBaseline?: Record<string, number>;
  subsidisedJobs?: Record<string, number>;
  publicWorksJobs?: number;
  publicWorksBaselineEmployees?: number;
  publicWorksWageRate?: number;
  publicWorksFunding?: string;
}

/**
 * v1.4 §五：AI 政府每月经济体检快照（可追溯、可重复计算）。
 *
 * 口径：失业率 = 失业 / 劳动力；3 月均值与趋势用于分级迟滞；
 * 税收区分“真实税收”（taxes.historyByCity 最近 12 个月实际入账）与
 * “估算税收”（不足 12 个月时按近 12 月 GDP 估算，明确标注估计月数）。
 */
export interface EconomicCheckup {
  tick: number;
  cityId: string;
  unemploymentRate: number;
  unemploymentRateAvg3: number;
  unemploymentTrend: number;
  rawTier: UnemploymentTier;
  tier: UnemploymentTier;
  employed: number;
  unemployed: number;
  laborForce: number;
  householdIncome: number;
  consumerSpend: number;
  consumerBudget: number;
  foodDemand: number;
  foodUnmetDemand: number;
  foodUnmetFunding: number;
  foodInventory: number;
  foodCapacity: number;
  foodOutput: number;
  foodPrice: number;
  effectivePurchasingPower: number;
  /** 有供给但居民买不起（收入/购买力不足）。 */
  fundingGap: boolean;
  /** 有购买力但缺货（产能/原料/运输/库存不足）。 */
  supplyGap: boolean;
  vacancies: number;
  /** 有岗位、有失业，但招聘启动受阻。 */
  hiringBlocked: boolean;
  hires: number;
  layoffs: number;
  founded: number;
  closed: number;
  treasury: number;
  monthlyTaxRevenueReal: number;
  monthlyTaxRevenueEstimated: number;
  taxMonthsReal: number;
  taxMonthsEstimated: number;
  necessarySpending: number;
  totalDebt: number;
  /**
   * v1.4 §五（一）：近 12 个月 GDP 窗口合计与月数（债务/GDP 分母的来源，可追溯）。
   * 可选字段：旧存档/旧测试夹具缺省视为未记录，不影响任何判定。
   */
  gdpWindowSum?: number;
  gdpWindowMonths?: number;
  debtRatio: number;
  bondDue: number;
  loanDue: number;
  debtServicePressure: number;
  /** 债务/GDP ≥ 预警线（85%，非破产线）。 */
  debtWarning: boolean;
  budget: number;
  budgetShare: number;
  budgetNote: string;
  skillLevel: number;
  skillMismatch: boolean;
  symptoms: string[];
  note: string;
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
  /** v1.4 §4：创办者从模拟范围外带入的初始实物设备（无实物出资时缺省）。 */
  initialEquipment?: InitialEquipmentGrant;
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
  /** v1.4 §4：锁定期内提前退出时，按实物返还给创办者的初始设备（不进入清算现金）。 */
  initialEquipmentReturned?: { kind: EquipmentKind; units: number; valuation: number };
  /**
   * v1.7 §二 F2：设备处置收入（真实买家付款，已计入清算现金；移交政府库存部分无现金）。
   * 清算对账：处置收入 + 清算前现金 = 维护费实付 + 银行债务偿还 + 股东分配（+ 取整余额）。
   */
  equipmentProceeds?: number;
  /** v1.7 §二 F2：清算时补记的当月设备维护费应计（本月已由财务结算过时为 0，不重复计费）。 */
  equipmentMaintenanceDue?: number;
  /** v1.7 §二 F2：清算资金实际支付给维护服务商的金额（当月费用 + 旧欠）。 */
  equipmentMaintenancePaid?: number;
  /** v1.7 §二 F2：其中偿还以前月份欠款的部分（只冲负债，不重复计入费用）。 */
  equipmentMaintenanceArrearsRepaid?: number;
  /** v1.7 §二 F2：确实收不到、记为模拟范围外服务商坏账的维护费（不制造模拟内资金）。 */
  equipmentMaintenanceWrittenOff?: number;
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
  /** v0.7 / v1.5 #40：本月消费预算（现金口径；可选，块3 填充；存档 v7 接受缺省）。 */
  budget?: number;
  /** v0.7 / v1.5 #40：本月新发放的消费贷款（可选，块3 填充；存档 v7 接受缺省）。 */
  loanDrawn?: number;
  /** v0.7 / v1.5 #40：本月由消费贷款支持的消费成交额（可选，块3 填充；存档 v7 接受缺省）。 */
  loanFinancedConsumption?: number;
  /** v0.7 / v1.5 #40：因资金不足未满足的消费（与供给不足缺口分开；可选，块3 填充；存档 v7 接受缺省）。 */
  unmetFunding?: number;
  /** v0.9：本月为补足基本消费而从本人银行存款提取的金额（先于消费贷）。 */
  depositWithdrawn?: number;
  /**
   * v1.4 §6.1 消费六项口径（件 / 金额，可选；旧存档缺省按 0 处理）。
   * 基本需要量必须单列：不得用“有效需求满足率”代替“基本需要覆盖率”。
   */
  basicNeedUnits?: number;
  basicSoldUnits?: number;
  basicNeedCoverage?: number;
  /** Σ 有效需求量（consumer goods，件）。 */
  effectiveUnits?: number;
  /** Σ 实际成交量（consumer goods，件）。 */
  soldUnits?: number;
  /** Σ 商品不足缺口（尝试过但未成交，件）。 */
  supplyShortfallUnits?: number;
  /** 本月由手头现金支付的消费额（成交额 − 存款提取 − 消费贷）。 */
  cashPaid?: number;
  /** v1.4 §6.1：有支付能力有效需求的金额口径（Σ effectiveQty × 本月价，与件数同源）。 */
  effectiveCost?: number;
  /**
   * v1.5 §3：基本需要商品（food）的有支付能力有效需求量（件，含本地与跨城口径的居民侧需求）。
   * 与 basicSoldUnits 同口径，用于“有效需求满足率 = 居民实际成交 / 有效需求量”；
   * 旧存档缺省按 0 处理（报告回退到市场口径并标注）。
   */
  basicEffectiveUnits?: number;
}

/**
 * v1.1 §2：居民群体投入本城居民投资实体的可审计简化份额账本。
 *
 * 记账口径（首版演示）：现金仍由城市投资实体统一托管；"份额"按累计真实转入额 1:1
 * 记账，群体之间的分红归属按 `shares / 本城居民群体 shares 合计` 分摊。账本只用于
 * 审计与报告，不重复计入居民收入、也不改变实体现金与既有"按持股返还"规则。
 * 该字段为可选字段：旧存档或从未投入过的群体没有账本，读取时按 0 处理。
 */
export interface HouseholdInvestorLedger {
  /** 累计真实转入居民投资实体的现金（信用点，>= 0）。 */
  contributed: number;
  /** 累计记账份额（1 信用点投入 = 1 份；分红归属按份额占比分摊）。 */
  shares: number;
  /**
   * v1.2 §1：一次性“开局无主旧资产”起始份额（1 份 = 1 信用点权益，>= 0）。
   * 投资实体开局已有净资产（现金 + 持股）在首次结算时按开局人口/基本生活费户数记到各群体，
   * 之后新增投入按 1:1 累加；旧档读取时补齐（不追溯改现金、不重复补）。
   * 有效份额 = shares + openingShares；可选字段，缺省视为未初始化/0。
   */
  openingShares?: number;
  /** 累计按份额归属的投资实体股息（记账口径，不代表现金已划给该群体）。 */
  dividends: number;
  /** 最近一次投入记账的 tick（从未投入为 -1）。 */
  lastContributionTick: number;
  /** 最近一次股息归属记账的 tick（从未记账为 -1）。 */
  lastDividendTick: number;
}

/** v1.1 §2：某群体某月真实转入投资实体的流水（报告与审计用；可选字段）。 */
export interface InvestorFundingEntry {
  tick: number;
  cityId: string;
  householdGroupId: string;
  amount: number;
}

/** v1.1 §2：每城每月的投资实体资金用途快照（报告用；可选字段）。 */
export interface InvestorUsageEntry {
  tick: number;
  cityId: string;
  /** 本月居民群体真实转入投资实体的现金。 */
  contributed: number;
  /** 本月投资实体收到的股息（实体侧记账口径，已扣股息税）。 */
  dividendsReceived: number;
  /** 其中返还居民的部分（按既有 dividendDistributionRate 估算）。 */
  dividendsReturned: number;
  /** 其中留存投资实体的部分（计入可用现金）。 */
  dividendsRetained: number;
  /** 期初可用现金（上一次快照的期末现金；首次快照按倒推口径）。 */
  openingCash: number;
  /** 期末可用现金（本城投资实体现金合计）。 */
  closingCash: number;
  /** 本期用于投资（买股/创办/设备等）的支出估算：期初 + 转入 + 留存股息 − 期末。 */
  invested: number;
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
  /** v1.1 §2：可审计的投资份额账本（可选；旧存档或从未投资过时缺省）。 */
  investorLedger?: HouseholdInvestorLedger;
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
  /**
   * v1.1 §2：居民闲钱投资转入流水（每笔 = 某群体某月真实转入实体的金额）。
   * 可选字段：旧存档缺省；业务代码读取时应兜底为空数组。用于 72 月报告与审计。
   */
  investorFundingHistory?: InvestorFundingEntry[];
  /** v1.1 §2：每城每月的投资实体资金用途快照（可选字段；旧存档缺省）。 */
  investorUsageHistory?: InvestorUsageEntry[];
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

export type BankOwnerKind = 'player' | 'household' | 'company' | 'investorGroup' | 'government';

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

export type LoanPurpose =
  | 'workingCapital'
  | 'expansion'
  | 'personal'
  | 'migratedDebt'
  /** v0.7：政府普通银行借款（id 为 cityId）。 */
  | 'government'
  /** v0.7：债券到期/破产时银行无条件垫付形成的政府借款。 */
  | 'bondAdvance'
  /** v0.7：居民群体消费贷款（借款人 id 为居民群体 id）。 */
  | 'householdConsumption';
export type LoanStatus = 'active' | 'repaid' | 'defaulted' | 'writtenOff';

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

/** v1.7 §五：某借款人类别在某月的授信快照明细汇总。 */
export interface CreditSnapshotKindMonth {
  subjects: number;
  totalLimit: number;
  totalOutstanding: number;
}

/**
 * v1.7 §五：授信快照的月度汇总（每主体快照只保留最新 1 条后，历史趋势仍在）。
 * 幂等键：tick——同一 tick 只汇总一次；金额 = 该 tick 各主体快照 limit/outstanding 合计。
 */
export interface ArchivedCreditSnapshotMonth {
  tick: number;
  year: number;
  month: number;
  /** 该 tick 有快照的主体数（按 borrower kind+id 去重）。 */
  subjects: number;
  totalLimit: number;
  totalOutstanding: number;
  byBorrowerKind: Record<string, CreditSnapshotKindMonth>;
}

/**
 * v1.7 §五：已结清（status='repaid'、未偿≈0）银行贷款的年度聚合归档。
 * 幂等键：year + borrowerKind + purpose；Σ = 归档前被移除明细的对应字段合计。
 */
export interface ArchivedBankLoanYear {
  year: number;
  borrowerKind: BankOwner['kind'];
  purpose: LoanPurpose;
  status: LoanStatus;
  count: number;
  principal: number;
  paidPrincipal: number;
  paidInterest: number;
}

export interface BankingState {
  deposits: DepositAccount[];
  loans: LoanContract[];
  snapshots: CreditSnapshot[];
  lastMonth: BankMonthlyStats;
  nextAccountNumber: number;
  nextLoanNumber: number;
  /** v1.7 §五：授信快照月度汇总，保留最近 config.history.bankingSnapshotMonths 个月。 */
  snapshotMonths?: ArchivedCreditSnapshotMonth[];
  /** v1.7 §五：已结清贷款的年度聚合归档（旧档/未归档时缺省）。 */
  archivedLoans?: ArchivedBankLoanYear[];
}

// ---------------------------------------------------------------- 财政可见性（v0.7 数据层权限表达）

/**
 * 财政信息的可见范围。
 * - public：普通玩家可见（城市公开经济信息、已发行债券的必要投资信息、自己的持债记录）。
 * - mayor：只有该城市**现任**市长可见。
 *
 * 权限是数据层契约：模拟层可以读全部字段，但对外投影（store/UI/IPC）只能暴露
 * MayorFiscalView / PublicBondOfferView / OwnBondHoldingView 三种形状。
 * 渲染期必须按**当前** player.roles.mayorCityId 重新校验，换任、离职、破产重选、读档后立即生效。
 */
export type FiscalVisibilityScope = 'public' | 'mayor';

export interface FiscalVisibility {
  scope: FiscalVisibilityScope;
  /** scope==='mayor' 时必填：cityId 现任市长可见；scope==='public' 时必须为 null。 */
  cityId: string | null;
}

/** 当前查看者的身份投影（只含权限判断所需字段，不含任何财政金额）。 */
export interface ViewerIdentity {
  playerId: string;
  /** 当前担任市长的城市；未任市长为 null。 */
  mayorCityId: string | null;
}

// ---------------------------------------------------------------- 开局 GDP 估计与 12 个月判定窗口（v0.7）

/** 开局 12 个月估计 GDP 的来源说明（估计值不是真实交易，不得计入历史现金流）。 */
export interface GdpEstimateInfo {
  /** 每城估计的月度 GDP；12 个估计月填同一值。 */
  monthlyValue: number;
  /** monthlyValue × 12。 */
  annualValue: number;
  /** 估算时采用的理论产能利用率假设（首版暂定 0.8）。 */
  utilizationAssumption: number;
  /** 破产判定/风险比率的最小年 GDP 兜底值（首版暂定 1 信用点）。 */
  minAnnualGdp: number;
  /** 估算口径说明（产出价值 − 中间投入，不含工资/贷款/财政）。 */
  method: string;
  createdAtTick: number;
  note: string;
}

/** 破产判定窗口中的一个月份。 */
export interface CityGdpPoint {
  /** 游戏内 tick；估计月的 tick 为负数（-12…-1），表示游戏开始前的估计月份。 */
  tick: number;
  value: number;
  /** true = 估计值（不得当成真实交易）；false = 该月真实结算 GDP。 */
  estimated: boolean;
}

// ---------------------------------------------------------------- 政府债券（v0.7）

export type BondHolderKind = 'player' | 'investorGroup' | 'company';

/**
 * 债券持有人。玩家本人、居民投资实体、企业都可以购买（含跨城购买）。
 * 居民以居民投资实体为购买主体；不得把债券记到不存在的持有人上。
 */
export interface BondHolder {
  kind: BondHolderKind;
  id: string;
}

export type BondIssuanceStatus = 'offering' | 'active' | 'redeemed';
export type BondRedemptionReason = 'maturity' | 'bankruptcy';

/**
 * 一次债券发行批次（发行计划与实际成交分开记录）。
 * 权威口径：只有 soldUnits 形成债务，principal = soldUnits × faceValue；未售出份数不形成债务。
 */
export interface BondIssuance {
  id: string;
  cityId: string;
  /** 发行结算 tick。 */
  issuedTick: number;
  /** 认购截止 tick（首版与 issuedTick 同月）；null 表示仍在认购期。 */
  closedTick: number | null;
  /** 面额（信用点/份），首版 1000。 */
  faceValue: number;
  /** 票面年利率（如 0.04 = 4%），按年化、按月计提。 */
  couponRateAnnual: number;
  /** 付息周期（月），首版 12：每满 12 个月支付一次已计提利息。 */
  interestPeriodMonths: number;
  /** 期限（月），首版 36。 */
  termMonths: number;
  /** 计划发行份数（整数份）。 */
  planUnits: number;
  /** 实际成交份数（整数份，≤ planUnits）。 */
  soldUnits: number;
  /** 未售出份数 = max(0, planUnits − soldUnits)；关闭时记录，不形成债务（DECISIONS v1.2 #21）。 */
  unsoldUnits: number;
  /** 实际形成本金 = soldUnits × faceValue。 */
  principal: number;
  maturityTick: number;
  status: BondIssuanceStatus;
  /** 最近一次付息 tick；null = 尚未付息。付息周期见 interestPeriodMonths。 */
  lastCouponTick: number | null;
  /**
   * 到期票息财政不足、银行不垫付时累计的欠付利息（DECISIONS v1.2 #19）。
   * 该金额计入总负债；到期/破产时连同本金一并由银行垫付兑付。
   */
  arrearsInterest: number;
  /**
   * 本批次全部持有人已计提、尚未支付的利息合计（对账汇总字段）。
   * 权威明细在 BondHolding.accruedInterest；不变量要求两者一致。
   */
  accruedInterest: number;
  /** 已支付利息累计（含破产提前兑付时支付的利息）。 */
  interestPaid: number;
  /** 已支付票息期数（M12/M24/M36 各一次，首版最多 3 期）。 */
  couponsPaid: number;
  /** 已归还本金累计（到期/破产提前兑付均计入）。 */
  principalRepaid: number;
  /** 累计由银行垫付的金额（本金+欠息，含到期与破产兑付）。 */
  bankAdvancedAmount: number;
  redeemedTick: number | null;
  redemptionReason: BondRedemptionReason | null;
  note: string;
}

/**
 * 某持有人对某发行批次的一份持债记录（同一持有人可分多次、不同月份买入）。
 * 计息从 interestStartTick 起按月计提；每满 interestPeriodMonths 支付一次已计提利息；
 * 破产提前兑付时按**实际持有月份**计付未付利息，不支付未来利息。
 */
export interface BondHolding {
  id: string;
  issuanceId: string;
  cityId: string;
  holder: BondHolder;
  units: number;
  principal: number;
  purchasedTick: number;
  /** 计息起点 = max(purchasedTick, issuedTick)。 */
  interestStartTick: number;
  maturityTick: number;
  lastCouponTick: number | null;
  accruedInterest: number;
  interestPaid: number;
  redeemedTick: number | null;
  status: 'active' | 'redeemed';
  note: string;
}

export type BondPaymentKind = 'coupon' | 'principal' | 'bankruptcyRedemption';

/** 债券兑付流水（逐笔可追溯；利息与本金分开记，禁止重复支付同一笔债权）。 */
export interface BondPayment {
  id: string;
  tick: number;
  issuanceId: string;
  cityId: string;
  /**
   * 对应 BondHolding.id（v0.7 复核追加，可选以兼容既有存档与调用方）。
   * 幂等键约定为 (issuanceId, holdingId, tick, kind)：同一债权同一 tick 同一 kind 只允许一条流水。
   */
  holdingId?: string;
  holder: BondHolder;
  kind: BondPaymentKind;
  principalPaid: number;
  interestPaid: number;
  /** true = 该笔兑付由政府不足额时银行的**无条件垫付**资金支付（垫付转为政府贷款）。 */
  fundedByBankAdvance: boolean;
  /** fundedByBankAdvance=true 时必填：垫付形成的 GovernmentLoanContract.id。 */
  advanceLoanId: string | null;
  note: string;
}

/**
 * v1.7 §五：债券兑付流水的年度聚合归档。
 * 幂等键：year + issuanceId + holderKind + holderId + kind；
 * Σ 聚合 = 归档前被移除明细的 principalPaid/interestPaid/count 合计（同 tick 幂等键不变）。
 */
export interface ArchivedBondPaymentYear {
  year: number;
  issuanceId: string;
  cityId: string;
  holderKind: BondHolder['kind'];
  holderId: string;
  kind: BondPayment['kind'];
  count: number;
  principalPaid: number;
  interestPaid: number;
  /** 其中由银行无条件垫付的笔数/金额（政府借新还旧审计口径）。 */
  bankAdvancedCount: number;
  bankAdvancedAmount: number;
}

/** 债券全局账本（跨城持有人共用一本账；权威数据，禁止另建副本）。 */
export interface BondState {
  issuances: BondIssuance[];
  holdings: BondHolding[];
  payments: BondPayment[];
  nextIssuanceNumber: number;
  nextHoldingNumber: number;
  nextPaymentNumber: number;
  /** v1.7 §五：超过明细保留窗口的兑付流水按 批次×持有人×年×kind 聚合归档（旧档/未归档时缺省）。 */
  archivedPayments?: ArchivedBondPaymentYear[];
}

// ---------------------------------------------------------------- 政府银行债务、应付项与破产（v0.7）

/** 政府银行贷款用途：普通政府借款 / 债券到期时的银行强制垫付。 */
export type GovernmentLoanPurpose = 'government' | 'bondAdvance';

/** writtenOff = 破产清算时银行勾销（银行无限资金、不倒闭；勾销必须留痕）。 */
export type GovernmentLoanStatus = 'active' | 'repaid' | 'writtenOff';

/**
 * 政府银行贷款合同（权威账本在 city.government.loans）。
 * 银行资金无限；授信限制不适用于政府普通借款，也不适用于任何强制垫付。
 * 还款沿用现有银行规则：等额本金、次月起还、月利率按月计提。
 */
export interface GovernmentLoanContract {
  id: string;
  cityId: string;
  purpose: GovernmentLoanPurpose;
  /** 原始本金。 */
  principal: number;
  /** 未偿本金余额。 */
  outstanding: number;
  monthlyPrincipal: number;
  rateMonthly: number;
  termMonths: number;
  startTick: number;
  /** 首期还款 tick（放款后的下一月）。 */
  nextDueTick: number;
  paidPrincipal: number;
  paidInterest: number;
  /** 已计息但尚未支付的利息（月结计提；纳入总负债口径）。 */
  accruedInterest: number;
  arrearsPrincipal: number;
  arrearsInterest: number;
  /** 连续欠付月数；≥2 标记违约（政府债务不因此触发别的东西，只影响欠息口径）。 */
  missedPayments: number;
  status: GovernmentLoanStatus;
  payments: LoanPayment[];
  /** purpose==='bondAdvance' 时必填：垫付覆盖的债券批次。 */
  bondIssuanceId: string | null;
  note: string;
}

export type GovernmentPayableKind = 'bondCoupon' | 'bondPrincipal' | 'loanInstalment';
export type GovernmentPayableStatus =
  | 'pending'
  | 'paid'
  /** 债券到期/破产时由银行垫付结清。 */
  | 'paidByAdvance'
  /** 票息到期但财政不足：银行不垫付，转为欠付利息，等最终付息/到期/破产时一并处理（DECISIONS v1.2 #19）。 */
  | 'arrears'
  /** 破产清算时勾销。 */
  | 'writtenOff';

/**
 * 当月应付项（月结阶段②生成、③④结清）。
 * 幂等权威：同一 (cityId, tick, kind, issuanceId/holder) 只生成一次；
 * 已结清的应付项保留至保留期，用于证明“同月到期与破产只付一次”。
 */
export interface GovernmentPayable {
  id: string;
  cityId: string;
  /** 应付月份 tick。 */
  tick: number;
  kind: GovernmentPayableKind;
  issuanceId: string | null;
  loanId: string | null;
  holder: BondHolder | null;
  principalDue: number;
  interestDue: number;
  status: GovernmentPayableStatus;
  paidTick: number | null;
  /** 结清时对应的 BondPayment.id（贷款分期为 null）。 */
  paymentId: string | null;
  note: string;
}

/** 银行垫付单列记录（DECISIONS v1.1：垫付必须可追溯，且不进普通政府贷款授信口径）。 */
export interface GovernmentAdvanceRecord {
  id: string;
  cityId: string;
  tick: number;
  issuanceId: string;
  /** maturity = 债券到期垫付；bankruptcy = 破产兑付垫付。票息欠付不产生垫付。 */
  purpose: 'maturity' | 'bankruptcy';
  /** 本次垫付覆盖的应付项 id。 */
  payableIds: string[];
  principalAdvanced: number;
  interestAdvanced: number;
  totalAdvanced: number;
  /** 垫付形成的政府贷款合同 id。 */
  loanId: string;
  note: string;
}

export type GovernmentRiskLevel = 'normal' | 'watch' | 'high' | 'bankrupt';
export type GovernmentRiskTrend = 'up' | 'down' | 'flat' | 'unknown';

/**
 * 政府债务汇总（每月结算末生成快照，city.government.lastDebt）。
 *
 * 总负债口径（DECISIONS v1.1 #11，冻结）：
 *   totalDebt = bankLoanPrincipal + bankAdvancePrincipal + bondPrincipalOutstanding
 *               + loanAccruedInterest + bondAccruedInterest
 * 债务/GDP = totalDebt / max(minAnnualGdp, 最近 12 个月 GDP 合计)。
 * 已计提未付利息必须计入分子：利息在月结阶段②计提，阶段⑤判定前完成，避免晚一拍。
 */
export interface GovernmentDebtSummary {
  cityId: string;
  tick: number;
  /** 本月月末财政余额（迁移后不得为负；赤字在月结转为银行贷款）。 */
  treasury: number;
  bankLoanPrincipal: number;
  bankAdvancePrincipal: number;
  bondPrincipalOutstanding: number;
  loanAccruedInterest: number;
  bondAccruedInterest: number;
  totalDebt: number;
  gdpWindowMonths: number;
  gdpWindowSum: number;
  gdpWindowEstimatedMonths: number;
  /** 判定用分母 = max(minAnnualGdp, gdpWindowSum)。 */
  gdpJudgementValue: number;
  debtRatio: number;
  riskLevel: GovernmentRiskLevel;
  riskTrend: GovernmentRiskTrend;
  /** 上一结算月同口径的债务/GDP（无可比数据为 null）；趋势与它比较。 */
  previousSettlementDebtRatio: number | null;
  note: string;
}

/**
 * 一次破产清算的完整记录（幂等：同一城市同一 tick 只能有一条）。
 *
 * 破产语义（DECISIONS v1.2 #8 更正版，冻结）：
 * 1. 银行立即兑付**未到期债券本金 + 按实际持有月份计提的未付利息**（不支付未来利息）；
 * 2. 随后政府原有银行债务与本次垫付形成（含破产兑付形成的）银行债务**一并勾销**；
 * 3. 不存在“按比例清偿/优先级分配”，财政余额不参与此项兑付。
 * 同月到期与破产：到期部分先按阶段③/④各付一次，破产阶段只处理**尚未结清**的债权，
 * 每笔债权只兑付一次，不得重复记债或勾销。
 */
export interface GovernmentBankruptcyRecord {
  id: string;
  cityId: string;
  tick: number;
  totalDebtAtJudgement: number;
  gdpJudgementValue: number;
  debtRatio: number;
  /** 破产时银行兑付的未到期债券本金合计。 */
  bondsRedeemedPrincipal: number;
  /** 破产时按实际持有月份计提支付给债券持有人的未付利息合计。 */
  bondsRedeemedInterest: number;
  /** 破产兑付次数（逐笔 BondPayment 数量，用于验证每笔只付一次）。 */
  bondRedemptionCount: number;
  /** 破产兑付由银行垫付形成的政府贷款金额（垫付利率/期限见 config.government.advance）。 */
  bankAdvanceCreated: number;
  /** 勾销的原有政府银行贷款未偿本金合计。 */
  bankLoansWrittenOff: number;
  /** 勾销的垫付贷款未偿本金合计。 */
  advancesWrittenOff: number;
  /** 勾销后仍未清偿（核销）的债券/贷款利息合计，只作记录，不产生支付。 */
  interestWrittenOff: number;
  /** 判定当月结算内立即触发重选；此处记录触发的 tick（未触发为 null）。 */
  electionTriggeredTick: number | null;
  /** 破产后是否进入看守期（现任市长仅维持性操作，直到重选完成）。 */
  caretakerUntilElection: boolean;
  note: string;
}

/** 破产状态（city.government.bankruptcy 的权威副本；city.bankruptcy 为同值镜像）。 */
export interface CityBankruptcyState {
  status: 'solvent' | 'bankrupt';
  /** 破产判定 tick；从未破产为 null。 */
  tick: number | null;
  /** 当前生效的 GovernmentBankruptcyRecord.id。 */
  recordId: string | null;
  /** 判定时的债务/GDP；未破产为 null。 */
  debtRatio: number | null;
}

export interface CityGovernmentState {
  loans: GovernmentLoanContract[];
  nextLoanNumber: number;
  /** 应付项保留最近 N 个结算月（N 见 config.government.payableRetentionMonths）。 */
  payables: GovernmentPayable[];
  nextPayableNumber: number;
  advances: GovernmentAdvanceRecord[];
  nextAdvanceNumber: number;
  /** 最近一次结算的债务汇总（趋势比较基准；不是权威账本）。 */
  lastDebt: GovernmentDebtSummary | null;
  bankruptcy: CityBankruptcyState;
  records: GovernmentBankruptcyRecord[];
  /** 已按幂等规则处理过财政金融阶段的 tick（同一 tick 不得重复兑付/清算）。 */
  settledTicks: number[];
}

// ---------------------------------------------------------------- 居民消费预算与消费贷款（v0.7）

export type HouseholdLoanStatus = 'active' | 'repaid' | 'defaulted' | 'writtenOff';

/**
 * 居民群体消费贷款（按群体聚合，不逐人建实体）。
 * 是真实债务，不是居民收入；资金从银行支付给商品卖方，不经过居民收入口径。
 * 额度由群体财产（手头现金 + 银行存款 − 未偿本金）决定，禁止无限信用。
 * 群体迁出/并组/人口变化必须保持债务归属与守恒（业务实现负责）。
 */
export interface HouseholdLoanContract {
  id: string;
  cityId: string;
  groupId: string;
  purpose: 'consumption';
  principal: number;
  outstanding: number;
  monthlyPrincipal: number;
  rateMonthly: number;
  termMonths: number;
  startTick: number;
  nextDueTick: number;
  paidPrincipal: number;
  paidInterest: number;
  accruedInterest: number;
  arrearsPrincipal: number;
  arrearsInterest: number;
  missedPayments: number;
  status: HouseholdLoanStatus;
  payments: LoanPayment[];
  note: string;
}

/**
 * 某群体某月的消费预算快照（首版公式与口径的可审计记录）。
 * 首版暂定：参考消费额 = 上月实际可支配收入 × 80% + 当时手头现金 × 5%；
 * 现金预算 = min(手头现金, max(0, 参考消费额))；有积蓄即可消费，上月收入不是硬上限。
 * 银行存款首版不自动取出（depositsIncluded=false），贷款支持后的有效预算单列。
 */
export interface ConsumerBudgetSnapshot {
  tick: number;
  cityId: string;
  groupId: string;
  /** 上月实际可支配收入（已扣个税，现金口径）。 */
  lastMonthDisposableIncome: number;
  /** 上月收入 × 收入参考比例（首版 80%）。 */
  incomeComponent: number;
  /** 当时手头现金。 */
  cash: number;
  /** 手头现金 × 现金参考比例（首版 5%）。 */
  cashComponent: number;
  /** 参考消费额 = incomeComponent + cashComponent。 */
  referenceSpend: number;
  /** 现金消费预算 = min(cash, max(0, referenceSpend))。 */
  cashBudget: number;
  /** 消费贷款可用额度（未放款前为可借上限）。 */
  loanAvailable: number;
  /** 有效预算 = cashBudget + loanAvailable（资金支持后的有效需求，不等于成交）。 */
  effectiveBudget: number;
  /** 本月实际发放的消费贷款。 */
  loanGranted: number;
  /** 本月实际成交消费。 */
  actualSpend: number;
  /** 因资金不足未满足的消费（与供给不足缺口分开）。 */
  unmetByFunding: number;
  /** 存款是否计入预算（首版 false）。 */
  depositsIncluded: boolean;
  note: string;
}

/**
 * v1.7 §五：已结清居民消费贷的年度聚合归档。
 * 幂等键：year + cityId + status；不保存 groupId，避免归档后出现悬空群体引用
 * （读档结构校验 core/save.ts 对消费贷 groupId 比 referenceValidation 更严格，见交付报告）。
 */
export interface ArchivedHouseholdLoanYear {
  year: number;
  cityId: string;
  status: HouseholdLoanStatus;
  count: number;
  principal: number;
  paidPrincipal: number;
  paidInterest: number;
}

/** 居民消费预算快照与消费贷款账本（权威数据）。 */
export interface HouseholdFinanceState {
  loans: HouseholdLoanContract[];
  nextLoanNumber: number;
  /** 消费预算快照，按 tick 升序保留最近 N 个月。 */
  budgets: ConsumerBudgetSnapshot[];
  note: string;
  /** v1.7 §五：已结清消费贷的年度聚合归档（旧档/未归档时缺省）。 */
  archivedLoans?: ArchivedHouseholdLoanYear[];
}

// ---------------------------------------------------------------- 权限投影视图（store/UI 唯一允许读取的形状，v0.7）

/**
 * 市长财政视图：只有该城现任市长可以取得。
 * 这些字段是“市长专属”白名单；界面不得绕过本视图直接读取 city.treasury /
 * city.government.* / 12 月判定合计。
 */
export interface MayorFiscalView {
  cityId: string;
  tick: number;
  treasury: number;
  /** 本月财政收入合计（正数）。 */
  monthIncome: number;
  /** 本月财政支出合计（正数）。 */
  monthExpense: number;
  bankLoanPrincipal: number;
  bankAdvancePrincipal: number;
  bondPrincipalOutstanding: number;
  loanAccruedInterest: number;
  bondAccruedInterest: number;
  totalDebt: number;
  gdpWindowMonths: number;
  gdpWindowSum: number;
  gdpWindowEstimatedMonths: number;
  /** 判定分母 = max(minAnnualGdp, gdpWindowSum)。 */
  gdpJudgementValue: number;
  debtRatio: number;
  riskLevel: GovernmentRiskLevel;
  riskTrend: GovernmentRiskTrend;
  previousSettlementDebtRatio: number | null;
  /** 本月应付项合计（债券利息/到期本金/贷款分期）。 */
  payablesDueThisMonth: number;
  /** 本月由银行垫付的金额合计。 */
  paidByAdvanceThisMonth: number;
  bankruptcyStatus: 'solvent' | 'bankrupt';
  bankruptcyTick: number | null;
  /** 是否触发“GDP 极低，已使用最低判定值”兜底。 */
  gdpLowFallback: boolean;
  /** 债券批次明细（含计划/实售/未售份数，仅市长可见）。 */
  issuances: MayorBondIssuanceView[];
}

/** 市长可见的债券批次明细：计划份数、实售份数、未售份数、已形成本金分开列示。 */
export interface MayorBondIssuanceView {
  issuanceId: string;
  faceValue: number;
  couponRateAnnual: number;
  interestPeriodMonths: number;
  termMonths: number;
  planUnits: number;
  soldUnits: number;
  /** unsoldUnits = max(0, planUnits − soldUnits)；未售出部分不形成债务。 */
  unsoldUnits: number;
  principal: number;
  maturityTick: number;
  status: BondIssuanceStatus;
  accruedInterest: number;
  interestPaid: number;
  /** 发行 tick（认购窗口开启）。 */
  issuedTick: number;
  /** 认购窗口关闭 tick（= issuedTick + 1，下一次月结）；窗口内可认购，跨月不续售。 */
  subscriptionCloseTick: number;
  /** 实际关闭 tick；仍开放时为 null。 */
  closedTick: number | null;
}

/**
 * 非市长可见的债券投资信息白名单：发行城市、期限、票面年利率、面额、可认购数量、到期日，
 * 以及认购窗口的开启/关闭 tick（窗口信息是投资决策必需，不含发行计划总额/总售额/总债务）。
 */
export interface PublicBondOfferView {
  issuanceId: string;
  cityId: string;
  faceValue: number;
  couponRateAnnual: number;
  interestPeriodMonths: number;
  termMonths: number;
  /** 当前可认购份数（整数份）。 */
  unitsAvailable: number;
  maturityTick: number;
  status: BondIssuanceStatus;
  /** 发行 tick（认购窗口开启）。 */
  issuedTick: number;
  /** 认购窗口关闭 tick（= issuedTick + 1，下一次月结关闭；不是无限期窗口）。 */
  subscriptionCloseTick: number;
}

/** 玩家自己持有的债券（含到期日与应得款，任何玩家可见自己的）。 */
export interface OwnBondHoldingView {
  holdingId: string;
  issuanceId: string;
  cityId: string;
  units: number;
  principal: number;
  interestStartTick: number;
  maturityTick: number;
  accruedInterest: number;
  interestPaid: number;
  redeemedTick: number | null;
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
  /**
   * v0.7：政府债券全局账本（发行批次、持债记录、兑付流水；跨城持有人共用）。
   * 可选字段：v6 及更早存档没有；迁移后必定存在（空账本），业务代码读取时应兜底。
   */
  bonds?: BondState;
  /** v0.7：居民消费预算快照与居民群体消费贷款账本。 */
  householdFinance: HouseholdFinanceState;
  /** v0.8：消费税、股息税、交通税收系数与月度税收记录。 */
  taxes: TaxState;
  /** v0.9：设备市场（政府开局设备库存、二手设备委托、月度成交量）。 */
  equipmentMarket: EquipmentMarketState;
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

// ---------------------------------------------------------------- v0.8 税收

/** 本月尚未做交通系数调整的基准税额（消费发生地归属）。 */
export interface CityTaxAccrual {
  consumptionTax: number;
  dividendTax: number;
}

/** 单城单月的税收结算记录（市长可见；非市长只能看到公开财政白名单）。 */
export interface CityTaxMonth {
  tick: number;
  /** 四种税的基准税额（纳税人实际承担）。 */
  incomeTaxBase: number;
  corporateTaxBase: number;
  consumptionTaxBase: number;
  dividendTaxBase: number;
  /** 上一个月真实城内配送数据得到的交通保障率（0–1）与税收系数（0.5–1.5）。 */
  transportGuarantee: number;
  transportFactor: number;
  /** 四种税按系数调整后的实际入账。 */
  incomeTaxRevenue: number;
  corporateTaxRevenue: number;
  consumptionTaxRevenue: number;
  dividendTaxRevenue: number;
  /** 系数 >1 时的加成合计（系统注入，不向纳税人补收）。 */
  transportBonus: number;
  /** 系数 <1 时的损耗合计（基准税额未进入政府的部分，不退还纳税人）。 */
  transportLoss: number;
  totalBase: number;
  totalRevenue: number;
}

export interface TaxState {
  /** 本月待结算的基准税额；财政月结时清零。 */
  accrualByCity: Record<string, CityTaxAccrual>;
  /** 各城最近若干月的税收结算记录（按 tick 升序）。 */
  historyByCity: Record<string, CityTaxMonth[]>;
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
