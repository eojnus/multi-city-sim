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
    /**
     * v0.9【已确认】：新开局每城初始总人口 = 基线初始人口 × 5。
     * 只作用于新开局；旧存档迁移不做任何人口放大。
     */
    initialPopulationMultiplier: 5,
    /** v0.9【已确认】：开局非劳动人口占总人口 20%，其余 80% 为劳动力；运行后不强制重置。 */
    initialNonLaborShare: 0.2,
    participationRate: 0.8,
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
    /** v0.9：紧急裁员条件与上限（连续亏损 ≥ 2 月且现金 + 合法授信 < 1 个月工资时，可裁 30%）。 */
    emergencyLossMonths: 2,
    emergencyCashWageMonths: 1,
    emergencyLayoffShare: 0.3,
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
    // v1.1 §8 起非基本有效需求不再用此值抬升下限（effective 必须是可支付需求），
    // 字段保留以兼容旧配置/存档读取；消费贷阶段不得为超出日常预算的非基本需求放贷。
    minAffordability: 0.15,
  },
  market: {
    initialPriceFactor: 0.95,
    /**
     * v1.6 §二：商品价格规则（全部可配置）。
     *
     * 每月价格变动的四个来源：
     * 1) 短缺：涨幅 = 缺口率（未成交有效需求 ÷ 有效需求）× shortageRiseSpeed；
     *    缺口率用“已被跨城进口冲销过”的未成交有效需求计算，进口满足的需求不算缺口。
     * 2) 过剩：跌幅 = 过剩率（期末库存超出“成交覆盖量 × stockSurplusThreshold”的部分 ÷ 成交覆盖量）× surplusFallSpeed；
     * 3) 竞争：同城卖家数 > 1 且价格高于锚价时，按卖家数与溢价幅度压价（competitionFallSpeed）；
     * 4) 回归：向锚价（基础价值，或真实单位生产成本推高的锚）× reversionSpeed 回归；
     *    仅在“价格高于锚”或“价格低于锚且有真实需求/成本压力”时回归，不制造无需求上涨。
     *
     * 单月变动夹在 ±maxMonthlyChange；价格夹在 basePrice × [minPriceFactor, maxPriceFactor]。
     */
    /** 短缺涨幅系数。 */
    shortageRiseSpeed: 0.3,
    /** 过剩跌幅系数。 */
    surplusFallSpeed: 0.12,
    /** 竞争压价系数。 */
    competitionFallSpeed: 0.08,
    /** 向锚价回归的月度比例。 */
    reversionSpeed: 0.03,
    /** 单月价格变动上限（涨跌同限）。 */
    maxMonthlyChange: 0.15,
    /** 期末库存超过“本地成交+跨城进口覆盖量 × 该阈值”视为过剩。 */
    stockSurplusThreshold: 1.6,
    /** 成本锚系数：锚价 = max(基础价, 上月单位生产成本中位数 × 系数)。 */
    costAnchorFactor: 1,
    /** 成本锚上限（相对基础价）：防止异常成本把锚价推飞。 */
    costAnchorMaxFactor: 1.6,
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
    /**
     * v1.6 §三：企业真实报价竞争参数（P3 / pool-dev）。
     *
     * - 内部 priceFactor 保留 6 位小数，成交价仍按分舍入（修复“每月变动不足 1 分被
     *   round2 吞掉、价格从未真正变动”）；
     * - priceBiasMin/Max（上方）是本模块的绝对价格系数上下限：报价夹在
     *   [0.85, 1.15] × 本城市场价，不允许负价/失控价；
     * - 每月变动最多 maxMonthlyMove（相对当前报价），且至少 minVisiblePriceStep 元。
     */
    pricing: {
      /** 无短缺/积压时向市场价（系数 1.0）回归的每月比例，避免风格偏移无限累积。 */
      reversionSpeed: 0.1,
      /** 有可支付缺货且库存低于目标时，每月加价幅度。 */
      shortageMarkup: 0.03,
      /** 成品积压超过 stuckInventoryMonths 时，每月降价幅度。 */
      surplusDiscount: 0.02,
      /** 销量低于销售参考 85% 时的小幅降价（除积压外的需求下滑信号）。 */
      salesDropDiscount: 0.01,
      /** 同类对手报价更低时，让到对手报价之下该比例。 */
      undercut: 0.01,
      /** 单月价格最大变动（相对当前报价）。 */
      maxMonthlyMove: 0.05,
      /** 成本底线：报价不低于单位变动成本 × (1 + 该比例)。 */
      minUnitMargin: 0.03,
      /** 最小可见变动（信用点）：小于 1 分钱的调价会被成交价舍入吞掉，直接补到 1 分。 */
      minVisiblePriceStep: 0.01,
    },
  },
  /** v0.3：企业成立与倒闭的演示限制（口径、固定/动态与数值均待用户决定）。 */
  lifecycle: {
    minCapital: 250_000,
    /** 资本转换为初始产能：capacity = capital / capitalPerCapacity。 */
    capitalPerCapacity: 500,
    /** v0.9【已确认】：每城同时经营的企业上限 160；初始企业数量不变。 */
    maxCompaniesPerCity: 160,
    maxInvestorsPerSyndicate: 3,
    maxCompaniesPerInvestorGroup: 3,
    maxCompaniesPerCompany: 1,
    maxGovernmentCompaniesPerCity: 1,
    /**
     * v1.2【已确认】：每城每月自动创办上限 4→100。100 是上限不是目标——实际创办数仍受
     * 可支付缺口、真实出资/授信、设备库存、劳动力、利润与周转金逐次约束；机会/资源耗尽即早停。
     * 160 在营企业上限与开局 65 家不变；玩家经界面发起的创办不受该月上限限制。
     */
    maxFoundingsPerCityMonth: 100,
    /** v0.9：旧冷却已与月度创办上限冲突，改为不额外限制（由月度上限控制节奏）。 */
    foundingCooldownMonths: 0,
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
      /**
       * v1.6 §五 D6【已确认】：连续多少个月“无产出且无销售”后判定僵尸企业。
       *
       * 计数由 checkBankruptcies 每月维护（上一完整月 produced≈0 且 sold+exported≈0 时 +1，
       * 有任一经营活动即清零；保护期内清零）。达到该月数后，若现金 + 可用授信 <
       * idleFixedCostCoverMonths 个月固定成本（工资 + 设备维护费 + 偿债），且无实际恢复计划
       * （本城/跨城可支付需求 + 正毛利 + 生产资产）与纾困观察期，则走 liquidateCompany 清算。
       * 短于该月数的暂时停业不清算。
       */
      idleExitMonths: 6,
      /** v1.6 §五：僵尸判定时现金+授信需覆盖的月固定成本数（默认 1 个月）。 */
      idleFixedCostCoverMonths: 1,
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
    /**
     * v1.7 §五：财政流水全局条数上限（FIFO 丢最早）。
     * 实测单月新增 84–322 条（24 月真实运行，max t23=322）；36 个月明细窗口最坏约
     * 36×322≈11,592 条，故上限取 12,000，保证明细窗口与“当月明细完整”不被全局 FIFO 挤掉。
     * 归档明细由 historyPolicy 按月聚合到 fiscal.archivedLedger，不改变余额语义。
     */
    ledgerLimit: 12_000,
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
    /**
     * v1.4 §五：AI 政府高失业决策（经济体检 / 失业分级 / 对症政策 / 动态预算 / 执行追踪）。
     *
     * 失业分级（按 3 个月均值失业率）：
     * - normal   < 10%
     * - strained 10%–20%
     * - severe   20%–35%
     * - crisis   > 35%
     * 分级采用迟滞：升级需连续 tierConfirmMonths 个月达到新档位，降级需连续
     * tierDeescalateMonths 个月低于当前档位，避免在阈值附近逐月抖动。
     * 开局不足 earlyMonthsCap 个月时最多判为 earlyTierCap（“承压”），防止样本过少就饱和。
     *
     * 动态预算：参考近 12 个月“真实税收”的月均（不足 12 个月时用近 12 个月 GDP 估算补齐，
     * 估算月数显式记录），按档位取 budgetTaxRevenueMinShare–budgetTaxRevenueMaxShare 的比例；
     * 债务/GDP ≥ debtWarningRatio 时预算乘以 debtWarningBudgetShare（缩减高风险承诺，
     * 不是破产线，破产仍由 fiscalRisk.bankruptAt=100% 判定）。
     */
    aiLabor: {
      /** 失业分级阈值（3 个月均值失业率）。 */
      tierStrainedAt: 0.1,
      tierSevereAt: 0.2,
      tierCrisisAt: 0.35,
      /** 升级确认月数与降级确认月数（迟滞，防止边界抖动）。 */
      tierConfirmMonths: 2,
      tierDeescalateMonths: 2,
      /** 趋势窗口：3 个月均值与再前 3 个月均值之差。 */
      trendMonths: 3,
      /** 开局不足该月数时最多判为 earlyTierCap，避免过早饱和。 */
      earlyMonthsCap: 3,
      earlyTierCap: 'strained' as const,
      /** 月预算 = 近 12 月平均月税收 × 档位比例（5%–15% 区间）。 */
      budgetTaxRevenueMinShare: 0.05,
      budgetTaxRevenueMaxShare: 0.15,
      budgetTierShares: { normal: 0.05, strained: 0.08, severe: 0.11, crisis: 0.15 },
      /** 不足 12 个月时用 GDP 估算月税收：月税收 ≈ 月 GDP × 该比例。 */
      budgetEstimateGdpTaxBaseShare: 0.08,
      /** 单城月预算下限/上限（与 policies.minBudget 共同约束）。 */
      budgetFloor: 120_000,
      budgetCap: 6_000_000,
      /** 债务/GDP 预警线（85%）与预警时预算比例。 */
      debtWarningRatio: 0.85,
      debtWarningBudgetShare: 0.5,
      /** 食品库存覆盖低于该月数视为“缺货”。 */
      foodCoverageMonths: 0.5,
      /** 岗位空缺/劳动力 超过该比例视为招聘启动受阻。 */
      vacancyRateForHiringBlocked: 0.02,
      /** 技能水平低于该值且存在岗位空缺时，才允许用培训缓解结构性错配。 */
      skillMismatchSkillLevel: 0.55,
      /** 公共工程期限（月）：到期撤岗，不无限期占用财政工资。 */
      publicWorksMonths: 6,
      /** 政策连续 ineffectiveStopMonths 个月有支出但无受益/无就业效果时停止。 */
      ineffectiveStopMonths: 2,
      /** 经济体检快照保留月数。 */
      checkupRetentionMonths: 60,
      /**
       * v1.5 §4：AI 高失业政策预算与真实资金执行衔接。
       *
       * 问题：政策决策用“本月动态预算”，但执行排在税收/公共工资/福利之后，财政常已被用尽，
       * 导致算出预算却实际支付 0。这里在“必要支出之后、政策执行之前”用既有政府借款规则
       * 把缺口真实补足（银行放款真实到账、计息入债），再把可动用资金预留给政策，实支 ≤ 预留。
       *
       * 约束：补足后债务/GDP 必须仍低于 maxDebtRatioForBorrowing（<100% 破产线，取 85% 预警线，
       * 不替代破产规则）；借款失败/达到上限时如实记录未支付，不支付、不造钱。
       */
      policyFunding: {
        /** 是否启用政策资金预留/补足（关闭时政策仍按可用财政支付）。 */
        enabled: true,
        /** 为政策补足借款允许的最高债务/GDP（达到/超过即不再新增融资）。 */
        maxDebtRatioForBorrowing: 0.85,
        /** 每城 fundingMonths 保留月数（超出截断，并在 note 标注）。 */
        retentionMonths: 24,
      },
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
    /**
     * v1.2：分红前必须保留的经营工作资金（按“月数 × 对应月度支出”估算）。
     * 旧口径只预留 0.5 个月工资，盈利企业把利润 100% 分掉后，下月买不起原料、
     * 发不出工资，形成“盈利企业被分红抽干现金 → 停产 → 倒闭”的死锁
     * （v1.2 验收问题三：食品链最早断点）。
     * 分红上限 = min(利润 × dividendPayoutRatio, cash − 工作资金保留额)，
     * 保留额 = 工资月数×月工资 + 原料月数×按生产计划估算的计划原料采购额。
     * 只限制分红金额，不产生现金、不改变利润/税收/持股口径。
     */
    dividendReserveWageMonths: 2,
    dividendReserveMaterialMonths: 1,
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
    /**
     * v1.1 §4：开局流动资金（月工资倍数）。
     * 任务书要求买完启动设备后至少保留“2 个月基础工资 + 1 个月计划原料采购额”；
     * 原料采购额由 initializer 按首月目标产量 × 配方用量 × 城市市场价单独计入，
     * 因此这里只列工资部分（原 1.6，v1.1 调整为 2）。个别种子（如设备厂）可覆盖更高值。
     */
    initialCashWageMonths: 2,
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
    /**
     * v1.3 §4【暂定】月内“采购 → 生产”轮数（固定轮次，1–3）：
     * 默认 2 轮——第 1 轮用月初库存采购并生产，第 2 轮让本月新产出的原料重新进入
     * 采购/成交后再完成剩余计划，避免“本月产出必须等下月才能被下游采购”的时序断点。
     * 同一份月度计划/劳动/设备上限按“剩余量”分摊到各轮，不会重复消耗或重复生产；
     * 1 轮即旧行为（仅用于 A/B 对比与排查），3 轮为上限（性能与复杂度控制）。
     */
    productionRounds: 2,
    /**
     * v0.9【首版暂定】生产计划参数：计划产量围绕“近 3 月实际销量 + 目标库存”调整，
     * 正常月份上下调均不超过 20%；现金不足或严重积压时允许紧急下调（下限 60%）。
     * v1.0：计划输入再加入“有支付能力但缺货”的未满足需求，并按企业可触达份额吸收。
     */
    plan: {
      salesLookbackMonths: 3,
      targetInventoryMonths: 0.5,
      maxUpAdjust: 0.2,
      maxDownAdjust: 0.2,
      emergencyDownAdjust: 0.6,
      stuckInventoryMonths: 2,
      /** 无销量历史时，初始销售参考量 = 设备产能 × 该系数（有依据的初始需求预测）。 */
      initialSalesFactor: 0.8,
      /** 计划产量下限（相对设备产能），避免完全停产但仍保留最低维护性产出。 */
      minOutputRatio: 0.05,
      /**
       * v1.0【首版暂定】缺货信号吸收比例：每月把“本企业合理份额的额外缺货”按该比例
       * 叠加进计划，再走正常 ±20% 平滑。首版取 20%，避免一次性把多年缺口补进单月计划。
       */
      unmetDemandAbsorption: 0.2,
      /** 扩产判定：连续 expansionUtilizationMonths 个月设备利用率 ≥ 该阈值。 */
      expansionUtilizationThreshold: 0.8,
      expansionUtilizationMonths: 2,
      /** 扩产判定：成品库存 ≤ expansionInventoryMonths 个月的预期销量。 */
      expansionInventoryMonths: 1,
      /** 扩产判定：发放投资后仍需保留 expansionReserveWageMonths 个月工资 + 近期偿债。 */
      expansionReserveWageMonths: 2,
      /** 近期月偿债估计：剩余债务按该月数均摊，再加上月利息支出。 */
      expansionDebtMonths: 24,
      /**
       * v1.6 §三【首版暂定】：需求估计的三个附加来源（都不当确定订单，按份额与
       * unmetDemandAbsorption 吸收）：
       * - 资金缺口（market.unmetFunding，想买但买不起）中可被收入增长/信贷恢复转化的比例；
       * - 其中可通过合理降价转化的比例（再乘“报价相对成本底线”的降价空间，降到成本线
       *   以下不会产生机会）；
       * - 可达跨城市场：其他城市可支付缺口 × 本企业全国产能份额 × 距离运价可达性 × 权重。
       */
      fundingDemandShare: 0.05,
      priceCutDemandShare: 0.05,
      intercityDemandWeight: 0.5,
      /**
       * v1.6 §三：需求驱动增产阈值。上月设备利用率低于该值（设备尚有余量）、本城有
       * 真实可支付缺货、企业有盈利且现金不紧张时，允许突破 ±maxUpAdjust 平滑，直接按
       * min(需求, 设备/劳动/原料上限) 增产（优先用现有设备，再采购原料/招聘）。
       */
      demandRampUtilization: 0.8,
    },
  },
  /**
   * v1.0【单位标定】设备市场。设备是按行业分类的可计数资产。
   *
   * 统一单位（task-23）：
   * - 普通商品企业：产能 = Σ(设备台数 × capacityPerUnit × 城市技术系数)，capacityPerUnit
   *   是“每台设备每月为被服务行业提供的产出单位”（首版 300,000，农业/工业/能源设备同值）。
   * - 资本品企业（recipeOutput 为设备商品）：产能 = Σ(设备台数 × outputCapacityPerUnit[资本品] ×
   *   城市技术系数)，单位是“台/月”。不能沿用 300,000，否则 1 台设备 = 30 万台/月，
   *   创业规模与资本计算会误判成数十万台产能。
   * - unitsPerWorkerMonth：设备制造企业每名员工每月生产的台数（按设备类别标定），
   *   demo-data 的 PRODUCTIVITY 直接引用该字段，保证生产/创业/库存/利润同一口径。
   */
  equipment: {
    catalog: {
      farm: {
        name: '农业设备',
        goodId: 'farmEquipment',
        price: 120_000,
        /** 每台设备为农业/纤维农场提供的产出单位/月（被服务企业口径）。 */
        capacityPerUnit: 300_000,
        /** 设备制造：每名员工每月生产 0.15 台（60 员工满负荷约 9 台/月）。 */
        unitsPerWorkerMonth: 0.15,
        sectors: ['agriculture', 'fiber-farm'],
      },
      industry: {
        name: '工业设备',
        goodId: 'industryEquipment',
        price: 200_000,
        /** 每台设备为食品/纺织/成衣/日用品/金属/设备行业提供的产出单位/月。 */
        capacityPerUnit: 300_000,
        /** 设备制造：每名员工每月生产 0.08 台（60 员工满负荷约 5.2 台/月）。 */
        unitsPerWorkerMonth: 0.08,
        sectors: ['food', 'textile', 'garment', 'appliance', 'metal', 'equipment'],
      },
      energy: {
        name: '能源设备',
        goodId: 'energyEquipment',
        price: 160_000,
        /** 每台设备为能源行业提供的产出单位/月。 */
        capacityPerUnit: 300_000,
        /** 设备制造：每名员工每月生产 0.09 台（60 员工满负荷约 5.4 台/月）。 */
        unitsPerWorkerMonth: 0.09,
        sectors: ['utility'],
      },
    },
    /**
     * 资本品企业（设备厂）自身产能：每台设备资产每月可生产的“台数”（随技术系数缩放）。
     * 取值使 60 员工设备厂约需 2 台自身设备（满负荷 6–10 台/月）：
     * farm 2×5=10 台/月、industry 2×3=6 台/月、energy 2×3=6 台/月。
     */
    outputCapacityPerUnit: {
      farmEquipment: 5,
      industryEquipment: 3,
      energyEquipment: 3,
    },
    /** 未知行业的兜底设备类别。 */
    fallbackKind: 'industry',
    /** 二手设备成交参考价 = 目录价 × 该系数（最终由卖方报价决定）。 */
    usedPriceFactor: 0.65,
    /** 企业清算时设备挂牌折价（无人购买则移交政府设备库存，不产生现金）。 */
    liquidationPriceFactor: 0.45,
    /** 政府开局设备库存（每城数量）：用于启动设备产业与创办企业，出售所得进入本城财政。 */
    governmentInitialStockPerCity: { farm: 24, industry: 60, energy: 16 },
    /** 单企业单月购买设备数量上限（防止一次性吃光库存）。 */
    maxBuyUnitsPerMonth: 60,
    /**
     * v1.6 §四：设备月度维护费率【已确认】。
     *
     * 每台每月维护费 = 所在城市该类“新设备”当月市场参考单价 × 该费率（默认 1%），
     * 逐类求和。计费时点（D1）：当月月初持有台数 × 月初参考单价——当月买入下月起计费，
     * 当月卖出/挂单/返还/破产仍计当月；闲置、停产、二手与初始实物出资设备同样计费。
     * 维护费是独立期间费用：进企业税前利润与现金流；收款方为模拟范围外设备维护服务商，
     * 不进设备厂收入、不记政府税收。
     */
    maintenanceMonthlyRate: 0.01,
    /** v1.6 §四：存在未付维护费时不得分红（服务商债权优先于股东分配）。 */
    maintenanceArrearsBlocksDividends: true,
    /** v1.6 §四：已存在未付维护费时不再为维护费新增借款（避免以贷养欠，欠费即信用风险）。 */
    maintenanceArrearsBlocksFinancing: true,
    /** v1.6 §四：维护费月度历史流水保留条数（供报告/审计）。 */
    maintenanceHistoryMonths: 60,
    /** v1.6 §四：清算时确实无法收回的维护费欠款记服务商坏账（只留痕，不制造模拟内资金）。 */
    maintenanceWriteOffOnLiquidation: true,
  },
  /** v0.9【首版暂定】工资、奖金与裁员参数。 */
  compensation: {
    /** 每 3 个月评估一次奖金。 */
    bonusEveryMonths: 3,
    /** 奖金池 ≤ 最近 3 个月累计税后利润的 10%。 */
    bonusProfitShare: 0.1,
    /** 发放奖金后至少保留 2 个月工资。 */
    bonusReserveWageMonths: 2,
    /** 并保留 1 个月已知偿债额。 */
    bonusDebtServiceMonths: 1,
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
    /**
     * v1.7 §五：每类股份保留的月度 K 线数量（真实成交，不虚构历史）。
     * 任务书目标“最近 120 个月保留月线，更早按年聚合 OHLCV”；必须与
     * config.history.stockMonthlyMonths 一致（recordStockTrade 按本值裁剪，历史治理按窗口归档）。
     */
    historyMonths: 120,
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
     * v1.1 §5：企业认购国债的流动性保留口径（替换 v1.4 #23/#37 的“1 个月工资 + 1 个月利息”）。
     * 可用于购债上限 = 企业现金 −（工资储备 + 原料储备 + 偿债储备），低于 0 不可认购：
     * - wageMonths 个月基础工资（monthlyWageBill，含岗位工资倍数，不含奖金）；
     * - materialMonths 个月计划原料采购额（按生产计划 plannedOutput 与现有库存缺口 × 本城市场价，不双计库存）；
     * - debtServiceMonths 个月已知应还贷款本息（下一期本息 + 逾期欠息，与 serviceLoan 同口径）。
     * 只有扣除这些已分配资金后的剩余自有现金才能购债；不得用贷款资金认购。
     */
    companyPurchaseReserve: {
      wageMonths: 2,
      materialMonths: 1,
      debtServiceMonths: 1,
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
  /**
   * v1.7 §五：历史记录与数据增长治理（月度结算全部完成后的安全时点统一执行）。
   *
   * 原则：只裁剪/聚合“只读展示历史与派生缓存”，不删除未结清义务、有效资产、规则读取窗口；
   * 归档幂等（重复执行不重复累计），且只改历史数组、不读 RNG、不改变结算顺序。
   * 各窗口的时间边界与守恒等式见 `persistence/historyPolicy.ts` 各段注释；
   * 数据归属与 UI 展示规则见 `docs/development/SAVE_SYSTEM_DESIGN.md` §7。
   */
  history: {
    /** 关闭时 Simulation.tick 不执行历史治理（诊断/对照测试用；默认开启）。 */
    enabled: true,
    /**
     * 授信快照：每主体只保留最新 1 条（规则只读最新一条），另按 tick 汇总最近 N 个月。
     * 任务书要求 ≥120 月。
     */
    bankingSnapshotMonths: 120,
    /**
     * 已结清（status='repaid' 且未偿≈0）银行贷款：结清后超过 N 个月按 年×借款人类别×用途 聚合移除明细。
     * 未结清/违约（defaulted/writtenOff）/有引用合同一律保留。
     */
    closedLoanArchiveMonths: 36,
    /**
     * 财政流水明细保留最近 N 个月（当月必须完整）；更早按 城市×年×kind 聚合到 fiscal.archivedLedger。
     * 全局条数上限见 policies.ledgerLimit（已按实测提升）。
     */
    fiscalDetailMonths: 36,
    /** 债券兑付流水明细保留最近 N 个月；更早按 批次×持有人×年×kind 聚合到 bonds.archivedPayments。 */
    bondPaymentDetailMonths: 36,
    /** 股票月线每类保留最近 N 个月；更早按年聚合真实 OHLCV（无成交月不生成）。 */
    stockMonthlyMonths: 120,
    /** 已结束治理议案保留最近 N 个月；更早按 公司×年×kind 聚合到 governance.motionYears（open 永不归档）。 */
    governanceArchiveMonths: 12,
    /** 选举记录保留最近 N 个月；更早按 城市×年 聚合到 politics.electionYears。 */
    electionArchiveMonths: 12,
  },
} as const;

export type DemoConfig = typeof DEMO_CONFIG;
