import type {
  City,
  Company,
  GoodId,
  MarketState,
  WorldState,
} from '../contracts/types';
import { DEMO_CONFIG } from '../../data/config';
import type { DemoConfig } from '../../data/config';
import {
  CITY_SEEDS,
  COMPANY_SEEDS,
  GOODS,
  PRODUCTIVITY,
  RECIPES,
  TRADE_ROUTE_SEEDS,
} from '../../data/demo-data';
import { createEmptyInventory, setCompanyEmployees, monthlyWageBill } from '../companies/company';
import { setCityPopulation, laborForceFor } from '../population/population';
import { round2 } from '../core/math';

function createMarket(): Record<GoodId, MarketState> {
  const market = {} as Record<GoodId, MarketState>;
  for (const good of GOODS) {
    market[good.id] = {
      goodId: good.id,
      price: round2(good.basePrice * DEMO_CONFIG.market.initialPriceFactor),
      supply: 0,
      demand: 0,
      consumerDemand: 0,
      producerDemand: 0,
      sold: 0,
      unmetDemand: 0,
      intercityImported: 0,
      externalExport: 0,
      closingStock: 0,
      lastPriceChangePct: 0,
    };
  }
  return market;
}

export function createInitialWorld(config: DemoConfig = DEMO_CONFIG): WorldState {
  const cities: City[] = CITY_SEEDS.map((seed) => ({
    id: seed.id,
    name: seed.name,
    englishName: seed.englishName,
    tagline: seed.tagline,
    color: seed.color,
    region: { ...seed.region },
    population: {
      total: seed.totalPopulation,
      employed: 0,
      unemployed: 0,
      nonLabor: seed.totalPopulation,
      laborForce: 0,
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
      note: '初始月无结算记录；首次推进后生成。',
    },
    technology: { ...seed.technology },
    politics: { ...seed.politics },
    realEstate: { ...seed.realEstate },
  }));

  const companies: Company[] = COMPANY_SEEDS.map((seed) => {
    const city = cities.find((candidate) => candidate.id === seed.cityId);
    if (!city) throw new Error(`公司 ${seed.id} 的城市 ${seed.cityId} 不存在`);
    const productivity = PRODUCTIVITY[seed.recipeOutput];
    const tech = city.technology.productivityMultiplier;
    const baseCapacity = round2(seed.employees * productivity * tech * 1.08);
    const capacity = baseCapacity;
    const target = capacity * config.company.initialUtilization;
    const inventory = createEmptyInventory();
    const recipe = RECIPES[seed.recipeOutput];
    for (const input of recipe.inputs) {
      inventory[input.good] = round2(
        target * input.qty * config.company.initialInventoryMonths,
      );
    }
    inventory[seed.recipeOutput] = round2(target * config.company.initialOutputMonths);

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
      totalShares: config.company.totalSharesDefault,
      lastMonth: {
        revenue: 0,
        inputCost: 0,
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
      },
      note: seed.note,
    };
    setCompanyEmployees(company, seed.employees);
    const wage = monthlyWageBill(company);
    company.baseWageBill = wage;
    company.cash = round2(wage * config.company.initialCashWageMonths);
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
      .reduce((totalWage, company) => totalWage + monthlyWageBill(company), 0);
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
      note: config.player.note,
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
    message: `世界初始化完成：${cities.length} 座城市、${companies.length} 家企业、${GOODS.length} 种商品。所有数值为演示方案 v0.1。`,
  });
  return world;
}

export function currentDemoConfig(): DemoConfig {
  return DEMO_CONFIG;
}
