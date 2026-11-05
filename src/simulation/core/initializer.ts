import type {
  City,
  CityGovernmentState,
  CityGdpPoint,
  Company,
  GdpEstimateInfo,
  GoodId,
  BondState,
  HouseholdFinanceState,
  MarketState,
  WorldState,
} from '../contracts/types';
import { DEMO_CONFIG } from '../../data/config';
import type { DemoConfig } from '../../data/config';
import {
  CITY_SEEDS,
  COMPANY_SEEDS,
  GOODS,
  OPENING_COMPANIES,
  PRODUCTIVITY,
  RECIPES,
  TRADE_ROUTE_SEEDS,
} from '../../data/demo-data';
import { emptyEquipmentAssets, equipmentCapacityPerUnit, equipmentKindForSector } from '../equipment/equipment';
import { createEmptyInventory, setCompanyEmployees, monthlyWageBill } from '../companies/company';
import { setCityPopulation, laborForceFor } from '../population/population';
import { round2, allocateProportionally } from '../core/math';
import { createInvestorGroups, groupsOfCity, groupHolder } from '../investors/investors';
import { createShareStructure, syncAllCompanyShares } from '../securities/securities';
import { createInitialTransport } from '../transport/network';
import { createInitialPolitics } from '../politics/politics';
import { freshAiState } from '../companies/lifecycle/lifecycle';
import {
  createInitialHouseholds,
  householdGroupsOfCity,
  occupationMonthlyIncome,
  recordHouseholdWealthStats,
} from '../population/household-groups';
import { createInitialBanking } from '../banking/banking';
import { laborCapacity } from '../production/production';
import { createInitialManagement } from '../management/manager-pool';
import { createEmptyTaxState } from '../government/taxes';
import { ensureStockHistory } from '../securities/history';

function createMarket(): Record<GoodId, MarketState> {
  const market = {} as Record<GoodId, MarketState>;
  for (const good of GOODS) {
    market[good.id] = {
      goodId: good.id,
      price: round2(good.basePrice * DEMO_CONFIG.market.initialPriceFactor),
      supply: 0,
      demand: 0,
      consumerDemand: 0,
      producerRequired: 0,
      producerDemand: 0,
      sold: 0,
      unmetDemand: 0,
      unmetFunding: 0,
      intercityImported: 0,
      externalExport: 0,
      closingStock: 0,
      consumptionTax: 0,
      lastPriceChangePct: 0,
    };
  }
  return market;
}

/**
 * 新世界：为各居民群体写入一份“首月可用收入”估算（净工资/福利/转移支付），
 * 否则首月逐群体消费预算恒为 0（缺少上月收入）。这是演示估算值，
 * 首次推进后由 applyHouseholdIncome 用实际结算覆盖。
 */
function seedInitialHouseholdIncome(world: WorldState, config: DemoConfig): void {
  for (const city of world.cities) {
    const publicWages = city.publicSector.employees * city.publicSector.wageRate;
    for (const group of householdGroupsOfCity(world, city.id)) {
      let income = 0;
      switch (group.occupation) {
        case 'management':
        case 'production':
        case 'sales':
        case 'research':
          income = round2(
            occupationMonthlyIncome(world, city, group.occupation, config) *
              (1 - city.incomeTaxRate),
          );
          break;
        case 'publicSector':
          income = round2(publicWages * (1 - city.incomeTaxRate));
          break;
        case 'unemployed':
          income = round2(city.population.unemployed * city.unemploymentBenefit);
          break;
        case 'nonLabor':
          income = round2(city.population.nonLabor * city.nonLaborTransfer);
          break;
      }
      group.lastMonth.income = income;
      // 初始现金是资产负债表上的“既有财富”，不是本月现金流；为了让
      // “收入 − 消费 − 储蓄 == 净现金变化”的月度口径在首月保存时也成立，
      // 这里把同额记为当月净现金变化（之后每 tick 由结算覆盖）。
      group.lastMonth.netCashChange = income;
    }
  }
}

export function createInitialWorld(config: DemoConfig = DEMO_CONFIG): WorldState {
  const cities: City[] = CITY_SEEDS.map((seed) => {
    // v0.9：新开局人口按配置倍数放大；非劳动人口占初始总人口固定比例，其余为劳动力。
    const total = Math.round(seed.totalPopulation * config.population.initialPopulationMultiplier);
    const nonLabor = Math.round(total * config.population.initialNonLaborShare);
    const laborForce = total - nonLabor;
    return {
    id: seed.id,
    name: seed.name,
    englishName: seed.englishName,
    tagline: seed.tagline,
    color: seed.color,
    region: { ...seed.region },
    population: {
      total,
      employed: 0,
      unemployed: 0,
      nonLabor,
      laborForce,
    },
    publicSector: {
      jobs: seed.publicJobs,
      employees: seed.publicJobs,
      wageRate: config.labor.publicWageRate,
    },
    treasury: seed.treasury,
    incomeTaxRate: config.labor.incomeTaxRate,
    corporateTaxRate: config.labor.corporateTaxRate,
    unemploymentBenefit: config.labor.unemploymentBenefit,
    nonLaborTransfer: config.labor.nonLaborTransfer,
    householdIncomeLastMonth: 0,
    market: createMarket(),
    gdp: 0,
    gdpHistory: [],
    lastMonth: {
      householdIncome: 0,
      consumerSpend: 0,
      consumerBudget: 0,
      benefitsPaid: 0,
      incomeTax: 0,
      corporateTax: 0,
      publicWageBill: 0,
      gdp: 0,
      migrationIn: 0,
      migrationOut: 0,
      investorDividends: 0,
      investableContribution: 0,
      policySpending: 0,
      transportSpending: 0,
      note: '初始月无结算记录；首次推进后生成。',
    },
    technology: { ...seed.technology },
    politics: { ...seed.politics },
    realEstate: { ...seed.realEstate },
    workforce: {
      skillLevel: 0.3,
      trainedThisMonth: 0,
      trainedTotal: 0,
      trainedLastTick: 0,
    },
    housing: {
      units: Math.round(total * 0.32),
      demand: Math.round(total * 0.3),
      rentSubsidyPaid: 0,
    },
    // v0.7：政府债务与破产为全新状态；GDP 窗口在全部企业/市场就绪后统一播种估计值。
    government: createEmptyGovernmentState(),
    gdpWindow: [],
    gdpEstimate: null,
    bankruptcy: { status: 'solvent', tick: null, recordId: null, debtRatio: null },
    };
  });

  // v1.0：原有 17 家 + 每城新增 16 家（OPENING_COMPANIES，共 65 家）。
  // 新增企业走同一创建管道，开局资产（设备/库存/现金/股份）在初始化阶段一次性建立；
  // 旧存档读取不经过这里，因此不会追加企业或再次乘人口。
  const openingSeeds = [...COMPANY_SEEDS, ...OPENING_COMPANIES];
  const companies: Company[] = openingSeeds.map((seed, companyIndex) => {
    const city = cities.find((candidate) => candidate.id === seed.cityId);
    if (!city) throw new Error(`公司 ${seed.id} 的城市 ${seed.cityId} 不存在`);
    const productivity = PRODUCTIVITY[seed.recipeOutput];
    const tech = city.technology.productivityMultiplier;
    const equipKind = equipmentKindForSector(seed.sector, config);
    // 统一单位（task-23）：普通商品企业每台设备贡献 catalog.capacityPerUnit 个产出单位/月；
    // 资本品企业（设备商品）每台设备贡献 outputCapacityPerUnit[output] 台/月。
    const perUnitCapacity = Math.max(
      1,
      equipmentCapacityPerUnit(config, equipKind, seed.recipeOutput) * tech,
    );
    const seededCapacity = round2(seed.employees * productivity * tech * 1.08);
    // 设备台数是权威资产：新开局按“种子产能 → 整数台设备”映射后，产能必须等于
    // 设备台数 × 每台产能 × 技术系数（不保留隐藏余量），否则首次重算就会跳变。
    const equipment = emptyEquipmentAssets();
    equipment[equipKind] = Math.max(1, Math.round(seededCapacity / perUnitCapacity));
    const capacity = round2(equipment[equipKind] * perUnitCapacity);
    const baseCapacity = capacity;
    const target = capacity * config.company.initialUtilization;
    const inventory = createEmptyInventory();
    const recipe = RECIPES[seed.recipeOutput];
    for (const input of recipe.inputs) {
      inventory[input.good] = round2(
        target * input.qty * config.company.initialInventoryMonths,
      );
    }
    inventory[seed.recipeOutput] = round2(target * config.company.initialOutputMonths);
    // v1.3：开局库存按开局市场价入账为存货资产（与现金不同，库存成本只在销售时结转 COGS）。
    const inventoryCost = {} as Record<GoodId, number>;
    for (const goodId of Object.keys(inventory) as GoodId[]) {
      const qty = inventory[goodId] ?? 0;
      inventoryCost[goodId] = round2(qty * (city.market[goodId]?.price ?? 0));
    }

    const company: Company = {
      id: seed.id,
      name: seed.name,
      cityId: seed.cityId,
      sector: seed.sector,
      recipeOutput: seed.recipeOutput,
      cash: 0,
      debt: 0,
      capacity,
      baseCapacity,
      maxCapacity: round2(capacity * config.company.maxCapacityMultiple),
      utilization: config.company.initialUtilization,
      employees: 0,
      baseWageBill: 0,
      roles: { management: 0, production: 0, sales: 0, research: 0 },
      jobDemand: seed.employees,
      wageRate: seed.wageRate,
      priceFactor: seed.priceFactor,
      inventory,
      inventoryCost,
      equipment,
      equipmentCapacity: capacity,
      equipmentCapacityRemainder: 0,
      salesHistory: [],
      productionPlan: null,
      recentProfits: [],
      totalShares: config.company.totalSharesDefault,
      lastMonth: {
        revenue: 0,
        inputCost: 0,
        cogs: 0,
        wagesPaid: 0,
        wageArrears: 0,
        interestPaid: 0,
        corporateTax: 0,
        dividendsPaid: 0,
        profit: 0,
        produced: 0,
        sold: 0,
        exported: 0,
        unmetDemand: 0,
        capacityChange: 0,
        dividendIncome: 0,
        bonusPaid: 0,
        equipmentPurchased: 0,
        equipmentSold: 0,
        emergencyLayoffs: 0,
      },
      previousMonth: {
        revenue: 0,
        inputCost: 0,
        cogs: 0,
        wagesPaid: 0,
        wageArrears: 0,
        interestPaid: 0,
        corporateTax: 0,
        dividendsPaid: 0,
        profit: 0,
        produced: 0,
        sold: 0,
        exported: 0,
        unmetDemand: 0,
        capacityChange: 0,
        dividendIncome: 0,
        bonusPaid: 0,
        equipmentPurchased: 0,
        equipmentSold: 0,
        emergencyLayoffs: 0,
      },
      dividendPayoutRatio: config.governance.defaultDividendPayoutRatio,
      note: seed.note,
      ai: { ...freshAiState(seed.id, seed.sector, companyIndex), ageMonths: 12 },
    };
    setCompanyEmployees(company, seed.employees);
    const wage = monthlyWageBill(company, config);
    company.baseWageBill = wage;
    // v1.1 §4：开局流动资金 = 工资储备（默认 2 个月）+ 1 个月计划原料采购额。
    // 原料额按首月目标产量 target × 配方用量 × 城市市场价估算，保证企业买到设备后
    // 仍能支付工资并采购首批原料等待真实销售回款；这是初始化的一次性资产，
    // 运行中不会对亏损企业无条件注资。
    const monthlyMaterialCost = round2(
      recipe.inputs.reduce(
        (total, input) =>
          total + target * input.qty * (city.market[input.good]?.price ?? 0),
        0,
      ),
    );
    company.cash = round2(
      wage * (seed.initialCashWageMonths ?? config.company.initialCashWageMonths) +
        monthlyMaterialCost,
    );
    return company;
  });

  for (const city of cities) {
    let privateEmployees = 0;
    for (const company of companies) {
      if (company.cityId === city.id) privateEmployees += company.employees;
    }
    const total = city.population.total;
    const laborForce = laborForceFor(total, config.population.participationRate);
    const employed = city.publicSector.employees + privateEmployees;
    setCityPopulation(city, total, laborForce, employed);
    if (employed > laborForce) {
      throw new Error(`城市 ${city.id} 初始就业超过劳动力：${employed} > ${laborForce}`);
    }

    for (const good of GOODS) {
      let stock = 0;
      for (const company of companies) {
        if (company.cityId === city.id) stock += company.inventory[good.id] ?? 0;
      }
      const market = city.market[good.id];
      if (market) {
        market.closingStock = round2(stock);
        market.supply = round2(stock);
      }
    }

    const privateWages = companies
      .filter((company) => company.cityId === city.id)
      .reduce((totalWage, company) => totalWage + monthlyWageBill(company, config), 0);
    const publicWages = city.publicSector.employees * city.publicSector.wageRate;
    const benefits =
      city.population.unemployed * city.unemploymentBenefit +
      city.population.nonLabor * city.nonLaborTransfer;
    city.householdIncomeLastMonth = round2(
      (privateWages + publicWages) * (1 - city.incomeTaxRate) + benefits,
    );
    city.lastMonth.householdIncome = city.householdIncomeLastMonth;
    city.lastMonth.note = '初始收入为按初始工资与福利估算的演示值；首次推进后改为实际结算。';
  }

  const world: WorldState = {
    seed: config.simulation.seed,
    rngState: config.simulation.seed >>> 0,
    time: {
      year: config.simulation.startYear,
      month: config.simulation.startMonth,
      tick: 0,
    },
    cities,
    companies,
    tradeRoutes: TRADE_ROUTE_SEEDS.map((route) => ({ ...route })),
    player: {
      name: config.player.name,
      homeCityId: config.player.homeCityId,
      cash: config.player.startingCash,
      holdings: [],
      lastDividend: 0,
      dividendsReceived: 0,
      roles: { mayorCityId: null },
      note: config.player.note,
    },
    securities: { classes: [], holdings: [], orders: [], lastTrades: [], offers: [], history: [] },
    governance: { boards: [], motions: [], controls: [] },
    investors: [],
    agreements: [],
    notifications: [],
    politics: { cities: [], elections: [] },
    policies: { active: [], history: [], lastRuns: [], lastSelection: [] },
    fiscal: { ledger: [], nextEntryId: 1 },
    transport: {
      links: [],
      intracity: [],
      pendingSales: [],
      lastMonth: {
        tick: 0, demand: 0, capacity: 0, overloadRatio: 0, penaltyRate: 0,
        capacityLossTotal: 0, freightSubsidy: 0, maintenancePaid: 0,
        corridors: [], intracity: [], trades: [], note: '尚未结算。',
      },
    },
    lifecycle: { foundings: [], liquidations: [], nextFoundingNumber: 1, nextLiquidationNumber: 1 },
    // v0.4：居民群体、经营者与银行在下面按依赖顺序初始化。
    households: { groups: [], lastStats: [] },
    management: { operators: [], playerOperations: [], nextOperatorNumber: 1 },
    banking: createInitialBanking(config),
    // v0.7：债券与居民消费金融全新建账（空账本；迁移旧档时同样为空+迁移日志）。
    bonds: createEmptyBondState(),
    householdFinance: createEmptyHouseholdFinanceState(),
    // v0.8：税收账本（空账本；旧档迁移时同样为空，不补记过去税额）。
    taxes: createEmptyTaxState(),
    // v0.9：政府开局设备库存（仅新开局注入，用于启动设备产业与创办企业；不是每月补贴）。
    equipmentMarket: {
      initialStock: {
        farm: config.equipment.governmentInitialStockPerCity.farm * CITY_SEEDS.length,
        industry: config.equipment.governmentInitialStockPerCity.industry * CITY_SEEDS.length,
        energy: config.equipment.governmentInitialStockPerCity.energy * CITY_SEEDS.length,
      },
      offers: [],
      lastMonthSold: emptyEquipmentAssets(),
      pendingLedger: [],
      capitalizedThisTick: {},
    },
    history: [],
    log: [],
    lastTick: {
      productionRecords: [],
      tradeFlows: [],
      externalExports: [],
      migration: [],
      invariants: [],
    },
  };

  // 居民投资实体：先建立资金来源，再发行股份给出资方。
  createInvestorGroups(world, config);
  createInitialShareStructure(world, config);
  // v0.8：为每个股份类别建立空的月度行情容器；新世界首月前显示“暂无数据”，不虚构 K 线。
  ensureStockHistory(world);

  // v0.4：居民群体（人口/收入/资产承载）、经营者（沿用原企业风格）、银行（空账本）。
  world.households = createInitialHouseholds(world, config);
  seedInitialHouseholdIncome(world, config);
  world.management = createInitialManagement(world, config, 0);
  recordHouseholdWealthStats(world, config, 0);

  // 政府主导的交通网络与候选人/领导人（演示规则）。
  world.transport = createInitialTransport(world, config);
  const politics = createInitialPolitics(world, config);
  world.politics = politics;
  for (const city of world.cities) {
    const state = politics.cities.find((entry) => entry.cityId === city.id);
    const leader = state?.leader;
    city.politics = {
      ...city.politics,
      approval: 55,
      rulingParty: leader?.party ?? city.politics.rulingParty,
      electionInMonths: state?.termMonthsLeft ?? null,
      status: 'active',
      note: leader
        ? `现任领导人：${leader.name}（${leader.party}），重点行业 ${leader.profile.sectorAffinity ?? '—'}。演示生成，不是最终选举制度。`
        : '由 politics 模块管理。',
    };
  }

  // v0.7：开局 12 个月 GDP 估计（估计值必须标注，不得写成真实历史）。
  seedOpeningGdpEstimates(world, config);

  world.history.push({
    tick: 0,
    year: world.time.year,
    month: world.time.month,
    population: cities.reduce((total, city) => total + city.population.total, 0),
    employed: cities.reduce((total, city) => total + city.population.employed, 0),
    unemployed: cities.reduce((total, city) => total + city.population.unemployed, 0),
    gdp: 0,
    playerNetWorth: config.player.startingCash,
  });

  world.log.push({
    tick: 0,
    kind: 'system',
    message: `世界初始化完成：${cities.length} 座城市、${companies.length} 家企业、${GOODS.length} 种商品、${world.investors.length} 个居民投资实体、${world.households.groups.length} 个居民群体、${world.management.operators.length} 名经营者。所有数值为演示方案 v0.4。`,
  });
  return world;
}

/**
 * 新世界初始股权结构：企业持有其他企业的投票权股份作为演示交叉持股，
 * 其余股份由本城居民投资实体按人口占比持有；同时发行仅分红股份。
 * 这是演示初始条件，不是用户已确认的最终股权分布。
 */
function createInitialShareStructure(world: WorldState, config: DemoConfig): void {
  const ordered = [...world.companies].sort((a, b) => a.id.localeCompare(b.id));
  const votingTotal = config.securities.votingSharesPerCompany;
  const nonVotingTotal = config.securities.nonVotingSharesPerCompany;

  ordered.forEach((company, index) => {
    const groups = groupsOfCity(world, company.cityId);
    if (groups.length === 0) {
      throw new Error(`城市 ${company.cityId} 没有居民投资实体，无法建立股权结构`);
    }
    const weights = groups.map((group) => group.populationShare);
    const crossCandidates = ordered.filter((candidate) => candidate.cityId !== company.cityId);
    const cross = crossCandidates.length > 0 ? crossCandidates[index % crossCandidates.length] : null;
    const corporateShares = cross
      ? Math.round(votingTotal * config.securities.corporateVotingShare)
      : 0;
    const investorVoting = votingTotal - corporateShares;
    const votingSplit = allocateProportionally(investorVoting, weights);
    const nonVotingSplit = allocateProportionally(nonVotingTotal, weights);

    const votingHolders = groups.map((group, groupIndex) => ({
      holder: groupHolder(group),
      shares: votingSplit[groupIndex] ?? 0,
    }));
    if (cross && corporateShares > 0) {
      votingHolders.push({
        holder: { type: 'company', id: cross.id },
        shares: corporateShares,
      });
    }

    createShareStructure(world, company, {
      votingShares: votingTotal,
      nonVotingShares: nonVotingTotal,
      votingHolders,
      nonVotingHolders: groups.map((group, groupIndex) => ({
        holder: groupHolder(group),
        shares: nonVotingSplit[groupIndex] ?? 0,
      })),
      tick: 0,
      acquiredVia: 'primary',
    });
  });

  syncAllCompanyShares(world);
}

export function currentDemoConfig(): DemoConfig {
  return DEMO_CONFIG;
}

// ---------------------------------------------------------------- v0.7 政府/债券/居民金融空状态与开局 GDP 估计

/** 空的政府债务状态（新世界与 v6→v7 迁移共用）。 */
export function createEmptyGovernmentState(): CityGovernmentState {
  return {
    loans: [],
    nextLoanNumber: 1,
    payables: [],
    nextPayableNumber: 1,
    advances: [],
    nextAdvanceNumber: 1,
    lastDebt: null,
    bankruptcy: { status: 'solvent', tick: null, recordId: null, debtRatio: null },
    records: [],
    settledTicks: [],
  };
}

/** 空的债券全局账本。 */
export function createEmptyBondState(): BondState {
  return {
    issuances: [],
    holdings: [],
    payments: [],
    nextIssuanceNumber: 1,
    nextHoldingNumber: 1,
    nextPaymentNumber: 1,
  };
}

/** 空的居民消费金融状态。 */
export function createEmptyHouseholdFinanceState(): HouseholdFinanceState {
  return {
    loans: [],
    nextLoanNumber: 1,
    budgets: [],
    note: '尚未发生消费预算结算；首次居民消费结算后写入快照。',
  };
}

/**
 * 开局月度 GDP 估计（DECISIONS v1 #6、v1.4 #32，口径冻结，估计值不是真实交易）：
 *   每城月度估计 = Σ 本城企业 [ q̂ × (产出市场价 − Σ配方投入×市场价) ]
 *   其中 q̂ = min(capacity, laborCapacity) × utilizationAssumption，**80% 只乘一次**；
 *   laborCapacity 复用生产模块口径（员工数×人均生产率×技术×技能×政策×laborCapacityFactor）。
 * 不含工资、贷款、还款与财政拨款。数值只写 city.gdpEstimate / city.gdpWindow，
 * 不写 city.gdp、不写 gdpHistory。
 */
export function estimateCityMonthlyGdp(
  world: WorldState,
  city: City,
  config: DemoConfig,
): GdpEstimateInfo {
  const assumption = config.government.gdpEstimate.utilizationAssumption;
  let monthlyValue = 0;
  for (const company of world.companies) {
    if (company.cityId !== city.id) continue;
    const recipe = RECIPES[company.recipeOutput];
    const outputPrice = city.market[company.recipeOutput]?.price ?? 0;
    let inputCost = 0;
    for (const input of recipe.inputs) {
      inputCost += input.qty * (city.market[input.good]?.price ?? 0);
    }
    const unitValueAdded = Math.max(0, outputPrice - inputCost);
    // v1.4 #32：q̂ = min(产能, 劳动力可支撑产量) × 80%，80% 只乘一次。
    const laborOutput = laborCapacity(company, city, config, world);
    const producible = Math.min(company.capacity, laborOutput);
    monthlyValue += producible * assumption * unitValueAdded;
  }
  const rounded = round2(monthlyValue);
  return {
    monthlyValue: rounded,
    annualValue: round2(rounded * config.government.gdpEstimate.windowMonths),
    utilizationAssumption: assumption,
    minAnnualGdp: config.government.fiscalRisk.minAnnualGdp,
    method: config.government.gdpEstimate.method,
    createdAtTick: world.time.tick,
    note: '开局 12 个月估计值（同一数值填入），真实月度 GDP 到来后从最早月份逐月替换；估计值不是真实交易。',
  };
}

/**
 * 构建 12 个月 GDP 判定窗口：
 * - 真实月份优先（按 tick 升序取最近 windowMonths 条，estimated=false）；
 * - 不足部分用开局估计补齐（estimated=true，tick 取 -missing…-1，表示游戏开始前的估计月）；
 * - 返回按 tick 升序的最多 windowMonths 条。
 * 迁移与开局共用同一函数，保证口径一致。
 */
export function buildGdpWindow(
  world: WorldState,
  city: City,
  config: DemoConfig,
  realPoints: CityGdpPoint[],
): { points: CityGdpPoint[]; estimate: GdpEstimateInfo } {
  const windowMonths = config.government.gdpEstimate.windowMonths;
  const estimate = estimateCityMonthlyGdp(world, city, config);
  const real = realPoints
    .filter((point) => !point.estimated)
    .sort((a, b) => a.tick - b.tick)
    .slice(-windowMonths)
    .map((point) => ({ tick: point.tick, value: point.value, estimated: false }));
  const missing = Math.max(0, windowMonths - real.length);
  const estimates: CityGdpPoint[] = [];
  for (let index = missing; index > 0; index -= 1) {
    estimates.push({ tick: -index, value: estimate.monthlyValue, estimated: true });
  }
  return { points: [...estimates, ...real], estimate };
}

/**
 * 新世界播种：每城 12 条估计值；真实历史为空（新开局 city.gdp 初始为 0，不得用首月实际 GDP×12）。
 * 迁移入口复用 buildGdpWindow（真实历史优先，缺口用估计填补并标注）。
 */
export function seedOpeningGdpEstimates(world: WorldState, config: DemoConfig): void {
  for (const city of world.cities) {
    const realPoints: CityGdpPoint[] = city.gdpHistory.map((point) => ({
      tick: point.tick,
      value: point.value,
      estimated: point.estimated === true,
    }));
    const { points, estimate } = buildGdpWindow(world, city, config, realPoints);
    city.gdpWindow = points;
    city.gdpEstimate = estimate;
  }
}
