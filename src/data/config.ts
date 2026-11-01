// 集中演示参数。所有数值均为“可替换的演示方案”，不是最终策划规则。
// 调整此处即可改变模拟节奏，业务代码不应散落魔法数字。

export const DEMO_CONFIG = {
  meta: {
    label: '演示参数 v0.2',
    assumptions: [
      '1 回合 = 1 个游戏月；月度结算。',
      '人口按群体统计，不为每个居民建立独立 AI。',
      '劳动参与率按总人口 38% 计算（包含儿童、退休者等非劳动力，演示口径）。',
      '居民消费使用上一月可支配收入，消费倾向 96%；其中 6% 在结算时转入居民投资实体。',
      '企业注资同时补充营运资金并按演示汇率提升产能，不是真实资本形成模型。',
      '政府收入为个人所得税 + 企业所得税；财政不足时按可用资金支付福利。',
      '城市间贸易为点对点企业交易，运输成本与物流容量尚未模拟。',
      '游戏 GDP = 本月企业产出价值 - 中间投入价值（不含公共服务）。',
      '【暂定】股票分有投票权与仅分红两类；企业作为买方在股票市场买入的股票一律为有投票权类别。',
      '【暂定】企业融资可对不同出资方分别约定股份类别；企业出资方也可以获得仅分红股份。',
      '【暂定】个人二级市场买入的股票默认也有投票权（配置项，用户尚未决定）。',
      '【暂定】每张投票权股票一票；董事会席位按投票权股份比例分配；持股市值不等于经营控制权。',
      '【暂定】两类股票按股同额分红；股息比例可由股东议案改变。',
      '【暂定】居民投资实体收到股息后，70% 返还居民收入（从实体现金扣除），30% 留存投资。',
      '【暂定】居民投资实体不展示内部明细，资金来自居民收入的一部分，并参与二级股票买卖。',
      '【暂定】政府牵头的跨城协议由市政府自动组织，企业按演示规则接受或拒绝。',
      '【暂定】少量持股阈值 5%；低于该比例只通知分红、可参与的表决和重大变化。',
    ],
  },
  simulation: {
    startYear: 2026,
    startMonth: 1,
    seed: 20261101,
    maxLogEntries: 160,
    maxHistory: 240,
  },
  population: {
    participationRate: 0.38,
    monthlyBirthRate: 0.00045,
    monthlyDeathRate: 0.00025,
    naturalNoise: 0.00012,
    migrationBaseRate: 0.00035,
    migrationLaborShare: 0.62,
    migrationMinVacancies: 40,
    migrationScoreGap: 3,
    approvalMigrationWeight: 0.08,
  },
  labor: {
    publicWageRate: 4200,
    privateWageRate: 4600,
    unemploymentBenefit: 600,
    nonLaborTransfer: 100,
    incomeTaxRate: 0.14,
    corporateTaxRate: 0.05,
    hiringOrder: 'public-first',
    /** 演示：企业每月最多裁减 8% 员工，避免一次性需求波动造成断崖式失业。 */
    maxMonthlyLayoffRate: 0.08,
  },
  consumer: {
    propensity: 0.96,
    priceElasticity: 0.4,
    employedNeedFactor: 1.0,
    unemployedNeedFactor: 0.72,
    nonLaborNeedFactor: 0.6,
    minAffordability: 0.15,
  },
  market: {
    initialPriceFactor: 0.95,
    priceAdjustSpeed: 0.08,
    maxMonthlyChange: 0.08,
    stockSurplusThreshold: 1.6,
    stockDiscount: 0.03,
    minPriceFactor: 0.55,
    maxPriceFactor: 2.2,
  },
  intercity: {
    /** 区域市场补货的演示运输加成：按距离线性增加，最高 12%。 */
    transportMarkupPerKm: 0.00025,
    minMarkup: 0.01,
    maxMarkup: 0.12,
    enabled: true,
  },
  externalDemand: {
    /** 区域外净出口（演示）：吸收超出目标库存的消费品，付款来自区域外。 */
    enabled: true,
    priceFactor: 0.9,
    targetStockMonths: 0.45,
    maxShareOfOutput: 0.3,
    baselineShareOfOutput: 0.12,
    minStockMonths: 0.2,
    note: '区域外需求为开放经济演示设定，不对应具体国家或贸易伙伴。',
  },
  company: {
    initialUtilization: 0.8,
    minUtilization: 0.5,
    maxUtilization: 1.05,
    utilizationAdjust: 0.18,
    wageReserveMonths: 1,
    dividendPayoutRatio: 1.0,
    capacityGrowth: 0.004,
    capacityShrink: 0.005,
    maxCapacityMultiple: 2.5,
    minCapacityMultiple: 0.7,
    shareBookCashWeight: 1,
    shareBookCapacityValue: 0.6,
    shareBookBase: 300_000,
    totalSharesDefault: 2_000_000,
    investmentCapacityGainPerCurrency: 1 / 20_000_000,
    maxInvestmentCapacityGain: 0.15,
    initialInventoryMonths: 1.2,
    initialOutputMonths: 0.55,
    initialCashWageMonths: 1.6,
    /** 演示：企业可获得最多 3 个月工资额的营运资金信贷，月息 1%。 */
    creditLimitWageMonths: 6,
    creditInterestRate: 0.005,
    debtRepaymentRate: 0.25,
    /** 【暂定】采购融资只在实际成交金额确定后补足，不在无供应时预先借款。 */
    purchaseCreditMode: 'on-settlement',
  },
  production: {
    /** 【暂定】产能还受当期员工限制：每名员工可支撑的生产率倍数。 */
    laborCapacityFactor: 1.08,
  },
  securities: {
    /** 新世界初始发行：每个企业两类股份。 */
    votingSharesPerCompany: 2_000_000,
    nonVotingSharesPerCompany: 500_000,
    /** 【暂定】企业作为买方持有其他企业的投票权股份比例（演示交叉持股）。 */
    corporateVotingShare: 0.13,
    /** 二级订单在多少个结算月后失效。 */
    orderTtlTicks: 2,
    /** 每个成交月的成交笔数上限，避免无限循环。 */
    maxTradesPerTick: 200,
  },
  governance: {
    /** 【暂定】董事会席位数量与分配规则。 */
    boardSeats: 5,
    /** 议案开放多少个结算月后计票。 */
    motionOpenTicks: 2,
    /** 默认股息派发比例（演示：保留部分利润，便于观察股东议案改变该决策）。 */
    defaultDividendPayoutRatio: 0.6,
    /** 提案触发条件：利润高于该值时才讨论股息政策。 */
    minProfitForMotion: 50_000,
    /** 企业经营者默认是职业经理人，持股不等于控制权。 */
    defaultOperator: 'management',
  },
  investors: {
    /** 每座城市的居民投资实体数量。 */
    groupsPerCity: 3,
    /** 【暂定】居民收入转入投资实体的比例。 */
    savingsRate: 0.06,
    /** 【暂定】实体把收到的股息中返还居民收入的比例，其余留作投资资金。 */
    dividendDistributionRate: 0.7,
    /** 新世界初始可投资金：按一个月居民收入的比例一次性注入（演示初始条件）。 */
    initialCashIncomeMonths: 0.5,
    /** 自动买入：每次最多使用可用现金的比例。 */
    buyBudgetShare: 0.35,
    /** 自动买入的价格上限（相对账面价）。 */
    maxBuyPremium: 0.05,
    /** 【暂定】自动买单的限价折扣：低于账面价，避免投资者自己吃掉自己挂出的卖单。 */
    orderBidDiscount: 0.02,
    /** 低于该现金时不主动买入。 */
    minCashToInvest: 100_000,
    /** 提供市场流动性：每月最多卖出自身持股的比例。 */
    liquiditySellShare: 0.006,
    /** 单一实体在单一企业的投票权持股上限（演示风控）。 */
    maxVotingStakeShare: 0.35,
    /** 居民投资实体可跨城买股。 */
    crossCityInvestment: true,
  },
  agreements: {
    /** 政府自动组织协议（演示）。 */
    autoPropose: true,
    maxActive: 4,
    /** 协议默认持续月份。 */
    months: 3,
    minQuantity: 100,
    /** 自动撮合采购量占卖方可售库存的比例。 */
    maxSellerShare: 0.3,
    /** 【暂定】买方接受上限：单位价格不高于买方城市市价的该倍数。 */
    buyerMaxPriceFactor: 1.12,
    /** 【暂定】卖方接受下限：单位价格不低于卖方城市市价的该倍数。 */
    sellerMinPriceFactor: 0.95,
  },
  notifications: {
    /** 【暂定】少量持股阈值：低于该比例只通知分红、表决和重大变化。 */
    majorStakeThreshold: 0.05,
    /** 保留的最大通知条数。 */
    maxEntries: 120,
    /** 分红低于该金额不通知，避免噪音。 */
    minDividendAmount: 1,
  },
  player: {
    name: '林澈',
    startingCash: 2_000_000,
    minInvestment: 50_000,
    maxInvestment: 5_000_000,
    homeCityId: 'lanport',
    note: '独立投资者。初始资金和身份为演示设定，尚非最终策划。',
  },
  ui: {
    tickAnimationMs: 280,
    autoTickMs: 1400,
  },
} as const;

export type DemoConfig = typeof DEMO_CONFIG;
