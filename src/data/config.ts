// 集中演示参数。所有数值均为“可替换的演示方案”，不是最终策划规则。
// 调整此处即可改变模拟节奏，业务代码不应散落魔法数字。

export const DEMO_CONFIG = {
  meta: {
    label: '演示参数 v0.4',
    assumptions: [
      '1 回合 = 1 个游戏月；月度结算。',
      '人口按群体统计，不为每个居民建立独立 AI。',
      '劳动参与率按总人口 38% 计算（包含儿童、退休者等非劳动力，演示口径）。',
      '居民消费使用上一月可支配收入，消费倾向 96%；其中 6% 在结算时转入居民投资实体。',
      '企业注资同时补充营运资金并按演示汇率提升产能，不是真实资本形成模型。',
      '政府收入为个人所得税 + 企业所得税；财政不足时按可用资金支付福利。',
      '城市间贸易为点对点企业交易；运输容量只影响卖方该笔收益，不限制成交数量。',
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
      '【暂定】企业按“扩张/稳健/回报”三种风格经营，具体系数是可替换原型。',
      '【暂定】企业成立者可为居民投资群体（可联合）、现有企业与城市政府；数量上限可配置。',
      '【暂定】企业倒闭按“现金 → 债务 → 剩余资产按股分配”处理，库存注销、债务减免均留痕。',
      '【暂定】每城多候选人 + 领导人被动属性；非玩家政府按城市弱项与领导人倾向选政策。',
      '【暂定】玩家为市长时政策必须由玩家选择，AI 不代选；选举资格与任期是演示规则。',
      '【暂定】15 项政策均为可替换原型：预算、期限、效果系数集中配置。',
      '【暂定】城际容量超载只减少卖方该笔收益；买方付款不变，差额记为无主体的收益损失。',
      '【暂定】居民群体按职业分为 7 类，人数由城市人口与就业权威派生；阶层按人均总资产分低/中/高，阈值为演示值。',
      '【暂定】居民群体初始财富按“若干个月群体收入”注入（仅新世界；旧存档迁移不创造资金）。',
      '【暂定】经营者风格沿用扩张/稳健/回报三种；任期 24 个月；3 名候选人；严重经营问题触发提前改选。',
      '【暂定】玩家经营模式分手动/AI 辅助/高度托管；重大事项阈值与默认授权可配置。',
      '【暂定】银行资金无限、不会倒闭；个人额度 = 净资产 50%，企业额度 = 非负账面股权价值 50%；同一主体共享额度。',
      '【暂定】存款月息 0.10%、周转贷款 0.50%/24 月、扩张贷款 0.60%/36 月、个人贷款 0.60%/24 月；等额本金、次月起还。',
      '【暂定】逾期宽限 1 个月，第 2 个月仍欠付标记违约；首版不加罚息、不收提前还款费。',
      '【暂定】旧 company.debt 迁移为银行承接贷款，利息与还款从此有对手方与留痕。',
      '【暂定】债券面额 1,000/份、整数份成交；票面年利率 4%、每满 12 个月付息、期限 36 个月；仅实售份数形成债务。',
      '【暂定】政府普通银行贷款 0.50%/24 月等额本金；银行强制垫付转贷款 0.50%/24 月，不受授信限制。',
      '【暂定】总负债 = 银行贷款未偿本金 + 银行垫付未偿余额 + 未偿债券本金 + 已计提未付利息；债务/GDP ≥ 100% 破产。',
      '【暂定】开局 12 个月 GDP 估计 = 理论产量 × 80% ×（产出单价 − 单位投入成本）；最小年 GDP 判定值 1。',
      '【暂定】居民消费预算 = 上月收入 × 80% + 手头现金 × 5%（受现金约束）；消费贷款额度 = 群体财产 × 50%。',
      '【暂定】旧档负财政余额在 v6→v7 迁移中等额转为政府银行贷款、财政余额归零，不额外发放现金。',
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
    /**
     * 【暂定】职业工资倍数：以企业 wageRate 为基准的岗位系数。
     * 口径：岗位月工资率 = company.wageRate × 该倍数；企业工资总额按岗位人数加权求和。
     * 取值理由：管理岗承担经营决策与风险（1.6）、研发岗是技术与长期增长来源（1.35）、
     * 销售岗承担需求侧波动（1.15）、生产岗可替代性最高且人数最多（0.95）。
     * 成本影响：按初始岗位权重（管理 8% / 生产 76% / 销售 10% / 研发 6%）加权，
     * 0.08×1.6 + 0.76×0.95 + 0.10×1.15 + 0.06×1.35 = 1.046，
     * 即企业月工资总额约 +4.6%，低于验收要求的 +10% 上限；若按人头简单平均则约 +1.25/4 ≈ +26%，
     * 但实际企业以生产岗为主，故加权后增幅温和。数值仍是可替换的演示方案。
     */
    occupationWageMultipliers: {
      management: 1.6,
      production: 0.95,
      sales: 1.15,
      research: 1.35,
    },
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
  /**
   * v0.8：消费税、股息税与城内交通税收系数。
   * 全部为【首版暂定】工程参数；用户已确认：消费税 5% 含税标价、股息税 10%、
   * 交通对四种税的系数范围 0.5–1.5（保障率 0→0.5、25%→0.75、50%→1.0、75%→1.25、100%→1.5）。
   */
  tax: {
    /** 居民消费品实际含税成交额的 5%（卖方收入 = 成交额 − 消费税）。 */
    consumptionTaxRate: 0.05,
    /** 股东实际取得分红的 10%（玩家与居民投资实体缴纳；企业与政府股东首版不缴）。 */
    dividendTaxRate: 0.1,
    /** 交通税收系数：系数 = 0.5 + 保障率，保障率 = clamp(有效容量 / 需求, 0, 1)。 */
    transport: {
      /** 保障率下限/上限（用于防御异常数据）。 */
      minGuarantee: 0,
      maxGuarantee: 1,
      /** 系数 = baseFactor + 保障率；baseFactor=0.5 时范围 0.5–1.5。 */
      baseFactor: 0.5,
      /** 城市当月无城内交通需求时使用的中性系数（避免空城获得满额加成）。 */
      neutralFactorWhenNoDemand: 1,
    },
    /** 各城税收结算记录保留月数。 */
    historyMonths: 12,
  },
  intercity: {
    /** 区域市场补货的演示运输加成：按距离线性增加，最高 12%。 */
    transportMarkupPerKm: 0.00025,
    minMarkup: 0.01,
    maxMarkup: 0.12,
    enabled: true,
  },
  /** v0.3：企业自动经营的风格系数（可替换原型，不是最终策划）。 */
  companyAi: {
    styles: {
      growth: {
        jobFactor: 1,
        utilizationBias: 0.04,
        investmentMonths: 4,
        investmentShare: 0.25,
        priceBias: -0.01,
        reserveMonths: 1.2,
      },
      steady: {
        jobFactor: 0.94,
        utilizationBias: 0,
        investmentMonths: 6,
        investmentShare: 0.18,
        priceBias: 0,
        reserveMonths: 1.5,
      },
      return: {
        jobFactor: 0.88,
        utilizationBias: -0.03,
        investmentMonths: 9,
        investmentShare: 0.1,
        priceBias: 0.01,
        reserveMonths: 2,
      },
    },
    /** 现金只够这么多月工资时，分别压缩到 90% / 70% 岗位需求（补贴会改变该判断）。 */
    cashJobThresholdHigh: 1.5,
    cashJobThresholdLow: 0.5,
    priceBiasMin: 0.85,
    priceBiasMax: 1.15,
    maxInvestmentShareOfCash: 0.3,
    /** 设备/扩产的单位产能成本（信用点/单位）。 */
    capacityCostPerUnit: 900,
    /** 每次扩产最多增加的产能比例。 */
    maxExpansionShare: 0.08,
    /** 新企业保护期（月）：期内不因亏损直接倒闭。 */
    newCompanyGraceMonths: 6,
  },
  /** v0.3：企业成立与倒闭的演示限制（口径、固定/动态与数值均待用户决定）。 */
  lifecycle: {
    minCapital: 250_000,
    /** 资本转换为初始产能：capacity = capital / capitalPerCapacity。 */
    capitalPerCapacity: 500,
    maxCompaniesPerCity: 16,
    maxInvestorsPerSyndicate: 3,
    maxCompaniesPerInvestorGroup: 3,
    maxCompaniesPerCompany: 1,
    maxGovernmentCompaniesPerCity: 1,
    maxFoundingsPerCityMonth: 1,
    /** 同一城市两次自动创办之间的最小间隔（月），避免企业数量爆发式增长。 */
    foundingCooldownMonths: 4,
    /** 每个居民投资实体对应的居民人数（仅用于资格判断，不新增人口）。 */
    populationPerInvestorGroup: 60_000,
    bankruptcy: {
      cashWageMonths: 0.25,
      lossMonths: 4,
      /** 无杠杆但长期亏损时也允许退出。 */
      longLossMonths: 8,
      /** 债务达到信贷额度的该比例时视为无法继续融资（接近额度上限）。 */
      debtRatioForDefault: 0.95,
      minAgeMonths: 6,
      /** 企业纾困政策生效时，倒闭判定延后观察的月份。 */
      reliefGraceMonths: 2,
    },
    maxHistory: 60,
  },
  /** v0.3：候选人与领导人的演示规则。 */
  politics: {
    candidatesPerCity: 3,
    termMonths: 24,
    /** 玩家参选的演示成本（从玩家现金扣除，进入城市财政）。 */
    electionCost: 60_000,
    /** 领导人重点行业带来的生产率加成（有上限、可追溯）。 */
    sectorProductivityBonus: 0.06,
    /** 领导人领域倾向对政策效果的放大比例（0–0.2）。 */
    domainEffectScale: 0.2,
  },
  /** v0.3：15 项政策的集中参数（全部为可替换原型）。 */
  policies: {
    defaultDurationMonths: 6,
    cooldownMonths: 2,
    maxActivePerCity: 2,
    maxHistory: 60,
    ledgerLimit: 800,
    minBudget: 80_000,
    /** 非玩家政府的财政安全垫：至少保留这么多个月公共工资。 */
    aiReserveWageMonths: 1,
    budgets: {
      hiringSubsidy: 700_000,
      retentionSubsidy: 700_000,
      vocationalTraining: 400_000,
      publicJobs: 900_000,
      startupSupport: 600_000,
      companyRelief: 600_000,
      equipmentSubsidy: 700_000,
      keyIndustrySupport: 800_000,
      researchGrant: 500_000,
      educationInvestment: 700_000,
      intercityTradeSupport: 400_000,
      transportInvestment: 1_500_000,
      unemploymentAid: 500_000,
      housingSupport: 900_000,
      taxAdjustment: 0,
    },
    hiring: { subsidyRate: 0.4 },
    retention: { subsidyRate: 0.25 },
    training: {
      costPerTrainee: 1_400,
      skillGainPerTrainee: 0.00004,
      maxSkillGainPerMonth: 0.02,
    },
    publicJobs: { wageMonthsReserved: 3 },
    startup: { capitalRelief: 0.3, grantRate: 0.2 },
    relief: { wageMonths: 1, maxCompanies: 3 },
    equipment: { subsidyRate: 0.5 },
    keyIndustry: { productivityBonus: 0.08, grantShare: 0.3 },
    research: {
      costPerPoint: 5_000,
      pointsPerLevel: 40,
      productivityPerLevel: 0.02,
      maxMultiplier: 1.15,
    },
    education: { skillGainPerBudget: 1 / 2_500_000, maxSkillGainPerMonth: 0.006 },
    tradeSupport: { reimbursementShare: 1 },
    unemploymentAid: { extraPerUnemployed: 220 },
    housing: { unitCost: 90_000, rentSubsidyShare: 0.35 },
    tax: {
      adjustStep: 0.02,
      minIncomeTax: 0.05,
      maxIncomeTax: 0.3,
      minCorporateTax: 0.02,
      maxCorporateTax: 0.2,
      aiRaiseMonths: 1.5,
      aiCutMonths: 4,
    },
  },
  /** v0.3：政府主导的城内/城际公路与铁路容量（单位：货物单位/月）。 */
  transport: {
    maxLevel: 4,
    initialRoadLevel: 1,
    initialRailLevel: 0,
    road: { capacityPerLevel: 1_200_000, buildCostPerLevel: 900_000, buildMonthsPerLevel: 3 },
    rail: { capacityPerLevel: 3_600_000, buildCostPerLevel: 2_600_000, buildMonthsPerLevel: 5 },
    /** 每月维护费 = 建设成本 × 该比率 × 等级。 */
    maintenanceRatePerLevel: 0.004,
    penalty: { strength: 0.6, max: 0.5 },
    intracity: {
      roadCapacityPerLevel: 2_400_000,
      railCapacityPerLevel: 6_000_000,
      buildCostRoad: 350_000,
      buildCostRail: 900_000,
      buildMonthsPerLevel: 2,
      maxLevel: 3,
      initialRoadLevel: 1,
      initialRailLevel: 0,
      efficiencyFloor: 0.55,
      maintenanceRatePerLevel: 0.003,
    },
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
    /** v0.8：每类股份保留的月度 K 线数量（真实成交，不虚构历史）。 */
    historyMonths: 36,
    /** v0.8：成交明细保留条数（防止存档无限增长）。 */
    tradeHistoryLimit: 400,
    /** v0.8：AI 投资行为参数（居民投资实体与企业，均为可替换的演示值）。 */
    ai: {
      /** 关闭后不生成新的 AI 买卖订单（已有订单仍可撮合）。 */
      enabled: true,
      /** 估值参考的回看月数（用于 K 线收盘价趋势）。 */
      lookbackMonths: 6,
      /** 单个投资实体每月最多挂出的买单数量。 */
      maxBuyOrdersPerGroup: 2,
      /** 单个投资实体每月最多挂出的卖单数量。 */
      maxSellOrdersPerGroup: 4,
      /** 居民实体买入股票预算上限（相对可支配现金）。 */
      groupBudgetShare: 0.35,
      /** 企业购买其他企业股票的单月预算上限（信用点与现金比例取小）。 */
      companyBudgetCap: 500_000,
      companyBudgetShare: 0.05,
      /** 企业只买投票权股份（已确认规则）；要求现金高于若干月工资才投资。 */
      companyReserveWageMonths: 3,
      /** 企业投资时对目标的要求：至少最近一个月利润非负。 */
      requireNonNegativeProfit: true,
      /** 卖出获利阈值：相对账面价上涨该比例时提高卖出意愿。 */
      takeProfitRatio: 0.15,
      /** 风险偏好权重：实体风险偏好越高，越愿意追涨并接受更高买价。 */
      riskWeight: 0.6,
      /**
       * v0.8.2：仅分红股份的 AI 交易参数（居民投资实体；企业买方仍只允许投票权股份）。
       * 首版设计意图：让仅分红类别有独立的卖出与买入意愿，而不是只在“接近投票权持股上限”时才被动考虑。
       */
      /** 仅分红股份每月基础卖出比例（相对该实体持仓），低于投票权的流动性比例。 */
      nonVotingSellShare: 0.004,
      /** 仅分红股份每月最多挂出的卖单数（与投票权的 maxSellOrdersPerGroup 分开计数）。 */
      nonVotingMaxSellOrdersPerGroup: 2,
      /** 仅分红股份常规卖单限价相对账面价的溢价。 */
      nonVotingSellLimitPremium: 1.02,
      /** 实体现金低于 minCashToInvest × 该倍数时视为有现金需求，提高卖出比例并接受折价。 */
      nonVotingCashPressureMultiple: 2,
      /** 现金需求下的卖出比例放大倍数。 */
      nonVotingCashPressureBoost: 2.5,
      /** 现金需求下的卖单限价（低于账面价，换取更快成交）。 */
      nonVotingCashPressureLimitPremium: 0.995,
      /** 股息收益率达到该阈值（每月每股股息/价格）时惜售。 */
      nonVotingDividendHoldThreshold: 0.002,
      /** 惜售时的卖出比例系数（0–1）。 */
      nonVotingDividendHoldFactor: 0.6,
      /** 买入打分中仅分红候选的固定加分，避免总是排在投票权之后。 */
      nonVotingBuyBias: 0.02,
      /** 买入打分中“每股股息收益率”的权重（仅分红类别）。 */
      nonVotingDividendWeight: 2,
      /** 仅分红买单相对账面价的最高溢价（股息偏好愿意支付的价格）。 */
      nonVotingBidPremium: 0.015,
    },
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
  /** v0.4：居民群体与财富阶层（全部为可替换的暂定参数）。 */
  households: {
    /** 每城群体数 = 职业类别数（管理/生产/销售/研发/公共部门/失业/非劳动力）。 */
    /** 初始财富：按“若干个月群体收入”注入，制造可解释的初始贫富差距。 */
    initialWealthIncomeMonths: {
      management: 18,
      production: 6,
      sales: 5,
      research: 7,
      publicSector: 5,
      unemployed: 2,
      nonLabor: 3,
    },
    /** 初始财富中银行存款占比（其余为手头现金）。 */
    initialDepositShare: 0.55,
    /** 消费倾向（群体预算 = 可支配现金 × 该比例；仍受实际现金约束）。 */
    consumptionPropensity: 0.96,
    /** 财富阶层阈值（人均总资产 = 现金 + 存款 + 股票权益，信用点）。 */
    tierThresholds: { middle: 15_000, high: 60_000 },
    /** 展示用：保留最近几个月的阶层统计。 */
    maxStatsMonths: 24,
    /**
     * v0.7：居民消费预算公式（任务书 §5.1；v1.5 #39 复核）。
     * 【数值岗】原值（旧 propensity 0.96 单口径）→ 新值：收入 80% + 现金 5% 双项；单位：比例。
     * #39 口径：先扣当月还款再算预算 → min(扣款后现金, 0.8×上月可支配收入 + 0.05×扣款后现金)；
     *   收入基数不再扣还款（避免双重扣减）。实现归块 3，本岗只定数值。
     * 影响面：预算上限直接决定居民消费与"资金缺口"判据（B5 判据 9）。
     */
    consumerBudget: {
      /** 参考消费额中的上月实际可支配收入比例（首版 80%）。 */
      lastIncomeShare: 0.8,
      /** 参考消费额中的当时手头现金比例（首版 5%）。 */
      cashShare: 0.05,
      /** 是否把银行存款自动计入现金预算（首版 false：只用现金，不偷偷把存款复制到手头）。 */
      depositsIncluded: false,
    },
    /**
     * v0.7：居民群体消费贷款/授信（与玩家个人贷款配置分开；数值岗定值，v1.5 #38 复核）。
     * 【数值岗】原值（无此机制）→ 新值即下方各项；单位见各行注释；理由/影响面见 DESIGNS §C2/C8。
     * 资产基准 = 现金 + 存款 + 按人数分摊的 cityInvestorEquity（不重复计价）；额度 = 基准 × creditLimitRate。
     */
    householdCredit: {
      /** 月利率 0.60%（名义年化 7.2%），与玩家个人贷款同档。 */
      rateMonthly: 0.006,
      termMonths: 24,
      /** 额度 = max(0, 群体财产基准) × 该比例（与银行个人授信同口径 50%）。 */
      creditLimitRate: 0.5,
      /** 单笔最低金额（信用点）。 */
      minLoanAmount: 100,
      /** v1.4 #35：新授信冻结条件——存在未结清违约合同时不得新增消费贷。 */
      denyWhenDefaulted: true,
      /** v1.4 #35：连续欠付达到该月数时不得新增消费贷（宽限沿用 banking.graceMonths，不新开 grace 键）。 */
      denyWhenArrearsMonthsAtLeast: 2,
      /** 每群体每月最多新增贷款笔数，防止拆单绕过额度。 */
      maxLoansPerGroupPerMonth: 1,
      /** 无资产无抵押信用默认关闭（仅作额度口径占位；实际授信条件以 #35 为准）。 */
      allowUnsecuredNoAsset: false,
    },
    /** 消费预算快照保留月数（审计、界面与测试用）。 */
    budgetSnapshotMonths: 24,
    /** 群体名称（界面展示用，不含模拟规则）。 */
    labels: {
      management: '管理层',
      production: '生产工人',
      sales: '销售人员',
      research: '研发人员',
      publicSector: '公共部门',
      unemployed: '失业居民',
      nonLabor: '非劳动力',
    },
  },
  /** v0.4：经营者、人才市场与选任（全部为可替换的暂定参数）。 */
  management: {
    /** 首版任期：24 个游戏月。 */
    termMonths: 24,
    /** 每次选任通常提供的候选人数（含现任）。 */
    candidatesPerElection: 3,
    /** 选任议案的投票期（结算月数）。 */
    electionOpenTicks: 2,
    /** 初始经营者池规模（每城）。 */
    initialPoolPerCity: 5,
    /** 人才市场上限（每城），避免无限增长。 */
    maxPoolPerCity: 12,
    /** 池内可用人才不足时新生成的人数上限（每次选任）。 */
    maxNewPerElection: 2,
    /** 无现任时平票的确定性排序：按 candidateId 字典序。 */
    /** 严重经营问题触发选任的判定参数。 */
    severe: {
      lossMonths: 4,
      cashWageMonths: 0.5,
      minAgeMonths: 6,
      /** 同一企业两次选任的最小间隔（月），避免每月重复生成议案。 */
      cooldownMonths: 6,
    },
    /** 玩家经营模式：重大事项阈值（超过阈值才需要玩家批准）。 */
    majorThresholds: {
      investmentAmount: 300_000,
      hireCount: 5,
      loanAmount: 200_000,
      priceChangeRatio: 0.05,
    },
    /** 玩家拒绝/批准的提案不会在这么多月内以同一去重键重复生成。 */
    proposalCooldownMonths: 3,
    /** 待处理提案上限（每家玩家经营企业）。 */
    maxPendingProposals: 6,
    /** 提案过期月数。 */
    proposalTtlMonths: 4,
    /** 默认授权（高度托管模式）。 */
    defaultAuthorization: {
      maxInvestmentPerMonth: 500_000,
      maxHiresPerMonth: 8,
      maxLoanAmount: 300_000,
      allowInvestment: true,
      allowHiring: true,
      allowLoan: true,
      allowPriceAdjust: true,
    },
    /** 手动模式持续计划的有效月数（到期后需要玩家重新设定）。 */
    standingPlanMonths: 12,
  },
  /**
   * v0.7：政府债券、政府银行债务、财政风险与破产。
   * 所有数值均为「首版暂定方案」，不是用户已确认的策划规则；集中在此处便于数值岗整段替换。
   * 【数值岗】本段每个数值的原值→新值、单位与理由见
   * docs/development/DESIGN_parameters_bonds_loans_ai_government.md §C8；
   * 36 月债券观察口径见 docs/development/DESIGN_block6_36m_observation_tables.md。
   */
  government: {
    /** 债券市场参数（面额/票息/期限/付息周期；数值为暂定，数值岗可整段替换）。 */
    bondMarket: {
      /** 面额：1,000 信用点/份；发行与认购都以整数份为单位。 */
      faceValue: 1000,
      /** 票面年利率 4%（按年化、按月计提）。 */
      couponRateAnnual: 0.04,
      /** 付息周期：每满 12 个月支付一次已计提利息。 */
      interestPeriodMonths: 12,
      /** 期限：36 个游戏月。 */
      termMonths: 36,
      /**
       * 单次发行计划上限（份/城/次），防止误操作把债务放大到不可解释。
       * 【首版暂定·数值岗】原值 10,000 份 → 新值 100,000 份；单位：份（每份 faceValue=1000 信用点）。
       * 理由：补足 1 个月支出约需 16–21 千份（岚港 21.0M/月、铁谷 16.8M/月，面额 1000），
       * 10 千份会把正常补缺口发行压到 47–63%，人为制造"未售出/发行不足"；100,000 份=1 亿
       * ≈ 单城 3–5 个月支出，仍是防误操作的 sanity cap，不是政策上限。
       * 影响面：仅块 1 `planIssue` 输入校验；不改债券规则（块 6 复核）。
       */
      maxPlanUnitsPerIssue: 100_000,
      /** 同一城市两次发行之间的最小间隔（月）；0 表示可连续发行。 */
      minMonthsBetweenIssues: 1,
      /** 单次实际售出占计划份数的上限（1 = 允许全部售出）。 */
      maxSoldRatio: 1,
      /** 认购主体排序（确定性顺序；是否认购仍由各自真实可用资金与策略决定）。 */
      subscriptionOrder: ['player', 'investorGroup', 'company'],
      /** 是否按风险等级调整票面利率（首版固定票面利率，暂不做风险定价）。 */
      riskPricedCoupon: false,
      /** 首版银行不得认购国债（任务书列举主体为玩家/居民投资实体/企业，DECISIONS v1.2 #21）。 */
      allowBankSubscription: false,
      /** 认购窗口：发行当月一次撮合，不跨月续售（DECISIONS v1.2 #21）。 */
      singleMonthSubscription: true,
      /** 12/24 月票息财政不足时不垫付、记欠付利息；36 月到期与破产才由银行无条件垫付（#19）。 */
      couponGuaranteedByBank: false,
    },
    /**
     * v1.4 #23/#37：企业认购国债的流动性保留口径（数值岗：各留 1 个月）。
     * 可用于购债上限 = 企业现金 − 上月实发工资 × wageMonths − 上月应付利息 × interestMonths；低于 0 不可认购。
     */
    companyPurchaseReserve: {
      wageMonths: 1,
      interestMonths: 1,
    },
    /** 政府普通银行贷款（沿用现有银行规则：等额本金、次月起还、月利率计提）。 */
    loan: {
      /** 月利率 0.50%（名义年化 6.0%），沿用企业周转贷款口径。 */
      rateMonthly: 0.005,
      termMonths: 24,
      /** 单笔最低金额（信用点）。 */
      minAmount: 10_000,
      /** 是否允许政府主动申请贷款（首版允许，用于维持性支出与周转）。 */
      allowActiveBorrowing: true,
    },
    /** 银行强制垫付转为政府贷款的口径；额度不受任何授信限制。 */
    advance: {
      rateMonthly: 0.005,
      termMonths: 24,
      /** 垫付时是否立即形成新贷款合同（首版 true；垫付必须逐笔可追溯）。 */
      createLoanContract: true,
    },
    /** 财政风险分档与破产门槛（50/75/100 分档；首版展示参数，不提前触发破产）。 */
    fiscalRisk: {
      /** < 50% 正常。 */
      normalBelow: 0.5,
      /** 50%–75% 关注。 */
      watchBelow: 0.75,
      /** 75%–100% 高风险；≥ 100% 破产。 */
      bankruptAt: 1.0,
      /** 最小年 GDP 判定值（防除零；只用于计算，不创造产出与现金）。 */
      minAnnualGdp: 1,
      /** 趋势容差：比率变化绝对值小于该值视为持平。 */
      trendEpsilon: 0.005,
    },
    /** 开局 12 个月 GDP 估计（估计值必须标注，不得当作真实历史）。 */
    gdpEstimate: {
      /** 理论可生产量 × 该利用率假设（首版暂定 80%）。 */
      utilizationAssumption: 0.8,
      /** 破产判定窗口月数。 */
      windowMonths: 12,
      /** 估算口径（写入存档 gdpEstimate.method；文字不是数值参数）。 */
      method:
        '企业理论产出价值 − 中间投入价值（Σ 企业产能 × 利用率假设 ×（产出单价 − 单位投入成本）），不含工资、贷款、还款与财政拨款',
    },
    /** 破产与重选（团队暂定：判定当月结算内立即触发重选；过渡期现任市长看守、仅维持性操作）。 */
    bankruptcy: {
      triggerElectionSameTick: true,
      /** 破产政府持股分配：无 CEO 时在除破产政府外的现有股东之间按股东主体数量平均分配。 */
      shareDistribution: 'byHolderCount',
      /** 无 CEO 且无其他股东时的无表决权托管持股（不得销毁或增发）。 */
      custodyShareKind: 'nonVoting',
    },
    /**
     * AI 政府的自动发债策略（DECISIONS v1.4 #29、v1.5 #43；键名已冻结，块1 实现触发逻辑）。
     *
     * 语义（块1 按此实现）：
     *   触发：treasury < 上月财政支出 × triggerBelowExpenseMonths（分母见 #42）
     *   补足：发债后 treasury 补到 上月财政支出 × topUpToExpenseMonths，份数 = ceil(缺口 / faceValue)
     *   频次：每城每月最多 maxIssuesPerCityMonth 期；不得借新还旧（#29）
     *   闸门：债务/GDP ≥ maxDebtRatioToIssue 时停止发行
     *   分母：max(上月财政支出, city.fiscalExpenseBaseline)（#42，baseline 由 initializer 首月结算后写入；
     *         缺省时退回「上月财政支出」）
     *
     * 【首版暂定·数值岗】原值（架构师占位）0.5 / 1 / 1 / 0.5 → 新值：触发 0.5、补足 1.0、频次 1、闸门 1.0。
     * 单位：触发/补足 = 上月财政支出倍数（非信用点）；频次 = 期/城/月；闸门 = 债务/GDP 比例。
     * 理由：初始财政可撑 1.84/1.61/1.39 个月支出，0.5 倍触发点约在赤字累计 1.3–1.5 个月后，不会开局举债；
     *   补到 1.0 倍避免边界抖动；闸门卡破产线（100%）而非 50%，因为 50%–100% 正是最需要补缺口的区间。
     * 影响面：只影响 AI 市长自动发债频率/规模；不改债券规则与破产判定。详见 DESIGNS §C3/C8。
     */
    aiGovernment: {
      /** 是否允许 AI 市长自动发债（DECISIONS #29：默认开启；块1 实现前无副作用）。 */
      enabled: true,
      /** 触发阈值：财政余额 < 上月财政支出 × 该倍数（月支出倍数，非信用点）。 */
      triggerBelowExpenseMonths: 0.5,
      /** 每城每月最多自动发行期数（整数期）。 */
      maxIssuesPerCityMonth: 1,
      /** 补足目标：财政余额补到上月财政支出 × 该倍数。 */
      topUpToExpenseMonths: 1.0,
      /** 债务/GDP 达到该比例后不再新发债（与破产线一致）。 */
      maxDebtRatioToIssue: 1.0,
      /**
       * v0.7 验收问题 7：本月存在**债券**到期本金/票息时是否禁止新发（禁借新还旧核心）。
       * 默认 true：保持 #29 借新还旧约束。债券到期本息是集中兑付，靠新债滚动会掩盖偿付能力。
       */
      blockIssuanceOnBondService: true,
      /**
       * v0.7 验收问题 7：本月存在**政府贷款常规分期**时是否禁止新发。
       * 默认 false：赤字转贷（borrowForGovernment）每月都有分期到期，旧口径（true）会让
       * hasDebtServiceDueThisTick 恒真，破产/赤字后 AI 永久停发、只能靠贷款滚动。
       * 贷款分期属常规偿债，不构成"借新还旧"；破产门槛（债务/GDP ≥ 100%）仍独立生效。
       */
      blockIssuanceOnLoanInstalment: false,
      /**
       * v0.7 验收问题 7：破产后恢复发债的门槛。true 时，若最近破产记录进入看守期
       * （caretakerUntilElection），必须在该记录之后完成一次重选才恢复发债；
       * 破产状态未解除（status==='bankrupt'）时始终禁止，不受本开关影响。
       * 影响面：只影响 AI 发债时点，不取消债务、不修改破产判定、不允许银行买债。
       */
      requireElectionAfterBankruptcy: true,
    },
    /** 应付项保留月数（同月幂等与审计）。 */
    payableRetentionMonths: 24,
    /** 破产记录保留条数。 */
    maxBankruptcyRecords: 8,
  },
  /** v0.4：独立银行系统（资金无限、不会倒闭；额度由财产/市值决定）。 */
  banking: {
    /** 活期存款月利率 0.10%（名义年化 1.2%）。 */
    depositRateMonthly: 0.001,
    /** 贷款产品：月利率与期限（月）。 */
    products: {
      workingCapital: { rateMonthly: 0.005, termMonths: 24, label: '企业周转贷款' },
      expansion: { rateMonthly: 0.006, termMonths: 36, label: '企业扩张贷款' },
      personal: { rateMonthly: 0.006, termMonths: 24, label: '玩家个人贷款' },
      migratedDebt: { rateMonthly: 0.005, termMonths: 12, label: '旧债务承接' },
      /** v0.7：政府银行借款（权威账本在 city.government.loans，银行台账仅展示口径）。 */
      government: { rateMonthly: 0.005, termMonths: 24, label: '政府借款' },
      /** v0.7：债券到期/破产时银行无条件垫付形成的政府借款。 */
      bondAdvance: { rateMonthly: 0.005, termMonths: 24, label: '债券垫付转借款' },
      /** v0.7：居民群体消费贷款（权威账本在 world.householdFinance.loans）。 */
      householdConsumption: { rateMonthly: 0.006, termMonths: 24, label: '居民消费贷款' },
    },
    /** 授信上限 = 授信基准 × 该比例。 */
    creditLimitRate: 0.5,
    /** 逾期宽限月数；第 2 个月仍欠付标记违约。 */
    graceMonths: 1,
    /** 首版不收提前还款费。 */
    earlyRepaymentFee: 0,
    /** 贷款审批的最低金额。 */
    minLoanAmount: 10_000,
    /** 授信快照保留月数（每借款人）。 */
    maxSnapshotsPerBorrower: 24,
    /** 银行月度统计保留月数。 */
    maxLoanPaymentsPerLoan: 60,
  },
} as const;

export type DemoConfig = typeof DEMO_CONFIG;
