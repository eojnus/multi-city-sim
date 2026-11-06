/**
 * v1.7 存档系统：population 模块。
 *
 * 归属：
 * - 城市人口/公共部门/劳动力技能/住房/上月居民收入（cities[].population / publicSector /
 *   workforce / housing / householdIncomeLastMonth）；
 * - 居民群体 household groups（人数派生、手头现金与月度账本权威）；
 * - 居民投资实体 investors（现金与份额权威）；
 * - 居民消费预算快照与消费贷款 householdFinance（权威账本）。
 *
 * 恢复依赖 world：候选世界的城市骨架由 world 模块建立，本模块用 `context.cityOf(id)` 填充。
 * 不负责的公司/市场/设备字段不得触碰（企业原子聚合在 company 模块，见 companySave.ts）。
 */

import type {
  HouseholdFinanceState,
  HouseholdState,
  HousingState,
  InvestorGroup,
  PopulationState,
  PublicSector,
  WorkforceState,
} from '../../contracts/types';
import type {
  SaveExportContext,
  SaveModule,
  SaveModuleMigrationContext,
  SaveModuleValidation,
  SaveRestoreContext,
} from '../types';

/** population 模块数据版本。 */
export const POPULATION_SAVE_MODULE_VERSION = 1;

/** 模块数据中的城市级 population 字段。 */
export interface PopulationSaveCity {
  id: string;
  population: PopulationState;
  publicSector: PublicSector;
  workforce: WorkforceState;
  housing: HousingState;
  householdIncomeLastMonth: number;
}

export interface PopulationSaveData {
  cities: PopulationSaveCity[];
  households: HouseholdState;
  investors: InvestorGroup[];
  householdFinance: HouseholdFinanceState;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

/** 深拷贝（存档数据均为 JSON 可序列化纯数据；JSON 口径与落盘一致）。 */
function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const OCCUPATIONS = new Set([
  'management',
  'production',
  'sales',
  'research',
  'publicSector',
  'unemployed',
  'nonLabor',
]);
const WEALTH_TIERS = new Set(['low', 'middle', 'high']);
const HOUSEHOLD_LOAN_STATUSES = new Set(['active', 'repaid', 'defaulted', 'writtenOff']);

/** 居民群体月度账本的必填数值字段（HouseholdMonthlyStats）。 */
const HOUSEHOLD_STATS_REQUIRED_NUMBERS = [
  'income',
  'wageIncome',
  'benefits',
  'dividendIncome',
  'incomeTax',
  'consumption',
  'desiredConsumption',
  'savingsContribution',
  'netCashChange',
] as const;

/** 居民群体月度账本的可选数值字段：缺省合法，出现时必须为有限数值。 */
const HOUSEHOLD_STATS_OPTIONAL_NUMBERS = [
  'budget',
  'loanDrawn',
  'loanFinancedConsumption',
  'unmetFunding',
  'depositWithdrawn',
  'basicNeedUnits',
  'basicSoldUnits',
  'basicNeedCoverage',
  'effectiveUnits',
  'soldUnits',
  'supplyShortfallUnits',
  'cashPaid',
  'effectiveCost',
  'basicEffectiveUnits',
] as const;

/** 结构校验收集器：一次收集全部错误，便于定位损坏字段。 */
class ShapeCheck {
  readonly errors: string[] = [];

  fail(message: string): void {
    this.errors.push(message);
  }

  object(value: unknown, path: string): UnknownRecord | null {
    if (!isRecord(value)) {
      this.fail(`${path} 必须是对象`);
      return null;
    }
    return value;
  }

  array(value: unknown, path: string): unknown[] | null {
    if (!Array.isArray(value)) {
      this.fail(`${path} 必须是数组`);
      return null;
    }
    return value;
  }

  /** 旧档/新开局可缺省的数组字段：undefined 视为“未写入”，不报错。 */
  optionalArray(value: unknown, path: string): unknown[] | null {
    if (value === undefined) return null;
    return this.array(value, path);
  }

  number(value: unknown, path: string): void {
    if (!isFiniteNumber(value)) this.fail(`${path} 必须是有限数值`);
  }

  integer(value: unknown, path: string): void {
    if (!isInteger(value)) this.fail(`${path} 必须是整数`);
  }

  text(value: unknown, path: string): void {
    if (typeof value !== 'string') this.fail(`${path} 必须是字符串`);
  }

  boolean(value: unknown, path: string): void {
    if (typeof value !== 'boolean') this.fail(`${path} 必须是布尔值`);
  }

  numbers(record: UnknownRecord, keys: readonly string[], path: string): void {
    for (const key of keys) this.number(record[key], `${path}.${key}`);
  }

  optionalNumbers(record: UnknownRecord, keys: readonly string[], path: string): void {
    for (const key of keys) {
      if (record[key] === undefined) continue;
      this.number(record[key], `${path}.${key}`);
    }
  }

  texts(record: UnknownRecord, keys: readonly string[], path: string): void {
    for (const key of keys) this.text(record[key], `${path}.${key}`);
  }
}

function validatePopulationCity(check: ShapeCheck, value: unknown, index: number): void {
  const path = `cities[${index}]`;
  const city = check.object(value, path);
  if (!city) return;
  check.text(city.id, `${path}.id`);

  const population = check.object(city.population, `${path}.population`);
  if (population) {
    check.numbers(
      population,
      ['total', 'employed', 'unemployed', 'nonLabor', 'laborForce'],
      `${path}.population`,
    );
  }

  const publicSector = check.object(city.publicSector, `${path}.publicSector`);
  if (publicSector) {
    check.numbers(publicSector, ['jobs', 'employees', 'wageRate'], `${path}.publicSector`);
  }

  const workforce = check.object(city.workforce, `${path}.workforce`);
  if (workforce) {
    check.numbers(
      workforce,
      ['skillLevel', 'trainedThisMonth', 'trainedTotal', 'trainedLastTick'],
      `${path}.workforce`,
    );
    if (isFiniteNumber(workforce.skillLevel) && (workforce.skillLevel < 0 || workforce.skillLevel > 1)) {
      check.fail(`${path}.workforce.skillLevel 必须在 0–1 之间`);
    }
  }

  const housing = check.object(city.housing, `${path}.housing`);
  if (housing) {
    check.numbers(housing, ['units', 'demand', 'rentSubsidyPaid'], `${path}.housing`);
    if (isFiniteNumber(housing.units) && housing.units < 0) {
      check.fail(`${path}.housing.units 不能为负`);
    }
  }

  check.number(city.householdIncomeLastMonth, `${path}.householdIncomeLastMonth`);
}

function validateInvestorLedger(check: ShapeCheck, value: unknown, path: string): void {
  const ledger = check.object(value, path);
  if (!ledger) return;
  check.numbers(ledger, ['contributed', 'shares', 'dividends'], path);
  if (ledger.openingShares !== undefined) check.number(ledger.openingShares, `${path}.openingShares`);
  check.integer(ledger.lastContributionTick, `${path}.lastContributionTick`);
  check.integer(ledger.lastDividendTick, `${path}.lastDividendTick`);
}

function validateHouseholdGroups(check: ShapeCheck, value: unknown): void {
  const groups = check.array(value, 'households.groups');
  if (!groups) return;
  const ids = new Set<string>();
  for (const [index, group] of groups.entries()) {
    const path = `households.groups[${index}]`;
    const record = check.object(group, path);
    if (!record) continue;
    check.text(record.id, `${path}.id`);
    if (typeof record.id === 'string' && record.id.length > 0) {
      if (ids.has(record.id)) check.fail(`居民群体 ID 重复：${record.id}`);
      ids.add(record.id);
    }
    check.text(record.cityId, `${path}.cityId`);
    if (typeof record.occupation !== 'string' || !OCCUPATIONS.has(record.occupation)) {
      check.fail(`${path}.occupation 必须是合法职业类别`);
    }
    check.text(record.name, `${path}.name`);
    check.number(record.people, `${path}.people`);
    check.number(record.cash, `${path}.cash`);
    check.text(record.note, `${path}.note`);

    const lastMonth = check.object(record.lastMonth, `${path}.lastMonth`);
    if (lastMonth) {
      check.numbers(lastMonth, HOUSEHOLD_STATS_REQUIRED_NUMBERS, `${path}.lastMonth`);
      check.optionalNumbers(lastMonth, HOUSEHOLD_STATS_OPTIONAL_NUMBERS, `${path}.lastMonth`);
    }
    if (record.investorLedger !== undefined) {
      validateInvestorLedger(check, record.investorLedger, `${path}.investorLedger`);
    }
  }
}

function validateHouseholdHistory(check: ShapeCheck, households: UnknownRecord): void {
  const funding = check.optionalArray(
    households.investorFundingHistory,
    'households.investorFundingHistory',
  );
  if (funding) {
    for (const [index, entry] of funding.entries()) {
      const path = `households.investorFundingHistory[${index}]`;
      const record = check.object(entry, path);
      if (!record) continue;
      check.integer(record.tick, `${path}.tick`);
      check.texts(record, ['cityId', 'householdGroupId'], path);
      check.number(record.amount, `${path}.amount`);
    }
  }

  const usage = check.optionalArray(
    households.investorUsageHistory,
    'households.investorUsageHistory',
  );
  if (usage) {
    for (const [index, entry] of usage.entries()) {
      const path = `households.investorUsageHistory[${index}]`;
      const record = check.object(entry, path);
      if (!record) continue;
      check.integer(record.tick, `${path}.tick`);
      check.text(record.cityId, `${path}.cityId`);
      check.numbers(
        record,
        [
          'contributed',
          'dividendsReceived',
          'dividendsReturned',
          'dividendsRetained',
          'openingCash',
          'closingCash',
          'invested',
        ],
        path,
      );
    }
  }
}

function validateWealthStats(check: ShapeCheck, value: unknown): void {
  const stats = check.array(value, 'households.lastStats');
  if (!stats) return;
  for (const [index, entry] of stats.entries()) {
    const path = `households.lastStats[${index}]`;
    const record = check.object(entry, path);
    if (!record) continue;
    check.text(record.cityId, `${path}.cityId`);
    check.integer(record.tick, `${path}.tick`);
    check.numbers(
      record,
      ['totalPeople', 'totalCash', 'totalDeposits', 'totalEquity', 'perCapitaIncome', 'perCapitaWealth'],
      path,
    );
    check.text(record.note, `${path}.note`);
    const tiers = check.array(record.tiers, `${path}.tiers`);
    if (!tiers) continue;
    for (const [tierIndex, tier] of tiers.entries()) {
      const tierPath = `${path}.tiers[${tierIndex}]`;
      const tierRecord = check.object(tier, tierPath);
      if (!tierRecord) continue;
      if (typeof tierRecord.tier !== 'string' || !WEALTH_TIERS.has(tierRecord.tier)) {
        check.fail(`${tierPath}.tier 必须是 low/middle/high`);
      }
      check.numbers(
        tierRecord,
        ['people', 'share', 'perCapitaWealth', 'perCapitaIncome', 'cash', 'deposits', 'equity'],
        tierPath,
      );
    }
  }
}

function validateHouseholds(check: ShapeCheck, value: unknown): void {
  const households = check.object(value, 'households');
  if (!households) return;
  validateHouseholdGroups(check, households.groups);
  validateWealthStats(check, households.lastStats);
  validateHouseholdHistory(check, households);
}

function validateInvestors(check: ShapeCheck, value: unknown): void {
  const investors = check.array(value, 'investors');
  if (!investors) return;
  const ids = new Set<string>();
  for (const [index, investor] of investors.entries()) {
    const path = `investors[${index}]`;
    const record = check.object(investor, path);
    if (!record) continue;
    check.text(record.id, `${path}.id`);
    if (typeof record.id === 'string' && record.id.length > 0) {
      if (ids.has(record.id)) check.fail(`居民投资实体 ID 重复：${record.id}`);
      ids.add(record.id);
    }
    check.texts(record, ['cityId', 'name'], path);
    check.numbers(
      record,
      ['cash', 'populationShare', 'riskAppetite', 'dividendsReceived', 'lastDividend'],
      path,
    );
    check.text(record.note, `${path}.note`);
  }
}

function validateLoanPayments(check: ShapeCheck, value: unknown, loanPath: string): void {
  const path = `${loanPath}.payments`;
  const payments = check.array(value, path);
  if (!payments) return;
  for (const [index, payment] of payments.entries()) {
    const paymentPath = `${path}[${index}]`;
    const record = check.object(payment, path);
    if (!record) continue;
    check.integer(record.tick, `${paymentPath}.tick`);
    check.numbers(
      record,
      ['principalDue', 'interestDue', 'principalPaid', 'interestPaid', 'arrears'],
      paymentPath,
    );
    check.text(record.note, `${paymentPath}.note`);
  }
}

function validateHouseholdFinance(check: ShapeCheck, value: unknown): void {
  const finance = check.object(value, 'householdFinance');
  if (!finance) return;
  check.integer(finance.nextLoanNumber, 'householdFinance.nextLoanNumber');
  check.text(finance.note, 'householdFinance.note');

  const loans = check.array(finance.loans, 'householdFinance.loans');
  if (loans) {
    const ids = new Set<string>();
    for (const [index, loan] of loans.entries()) {
      const path = `householdFinance.loans[${index}]`;
      const record = check.object(loan, path);
      if (!record) continue;
      check.text(record.id, `${path}.id`);
      if (typeof record.id === 'string' && record.id.length > 0) {
        if (ids.has(record.id)) check.fail(`居民消费贷款 ID 重复：${record.id}`);
        ids.add(record.id);
      }
      check.texts(record, ['cityId', 'groupId'], path);
      if (record.purpose !== 'consumption') check.fail(`${path}.purpose 必须是 consumption`);
      if (typeof record.status !== 'string' || !HOUSEHOLD_LOAN_STATUSES.has(record.status)) {
        check.fail(`${path}.status 必须是 active/repaid/defaulted/writtenOff`);
      }
      check.numbers(
        record,
        [
          'principal',
          'outstanding',
          'monthlyPrincipal',
          'rateMonthly',
          'termMonths',
          'startTick',
          'nextDueTick',
          'paidPrincipal',
          'paidInterest',
          'accruedInterest',
          'arrearsPrincipal',
          'arrearsInterest',
          'missedPayments',
        ],
        path,
      );
      check.text(record.note, `${path}.note`);
      if (record.payments !== undefined) validateLoanPayments(check, record.payments, path);
    }
  }

  const budgets = check.array(finance.budgets, 'householdFinance.budgets');
  if (budgets) {
    for (const [index, budget] of budgets.entries()) {
      const path = `householdFinance.budgets[${index}]`;
      const record = check.object(budget, path);
      if (!record) continue;
      check.integer(record.tick, `${path}.tick`);
      check.texts(record, ['cityId', 'groupId'], path);
      check.numbers(
        record,
        [
          'lastMonthDisposableIncome',
          'incomeComponent',
          'cash',
          'cashComponent',
          'referenceSpend',
          'cashBudget',
          'loanAvailable',
          'effectiveBudget',
          'loanGranted',
          'actualSpend',
          'unmetByFunding',
        ],
        path,
      );
      check.boolean(record.depositsIncluded, `${path}.depositsIncluded`);
      check.text(record.note, `${path}.note`);
    }
  }
}

function validatePopulationData(input: unknown): SaveModuleValidation {
  const check = new ShapeCheck();

  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: ['population 模块数据必须是对象'] };
  }

  const data = input as UnknownRecord;
  const cities = check.array(data.cities, 'cities');
  if (cities) {
    const ids = new Set<string>();
    for (const [index, city] of cities.entries()) {
      validatePopulationCity(check, city, index);
      const id = isRecord(city) ? city.id : undefined;
      if (typeof id === 'string' && id.length > 0) {
        if (ids.has(id)) check.fail(`population 城市 ID 重复：${id}`);
        ids.add(id);
      }
    }
  }

  validateHouseholds(check, data.households);
  validateInvestors(check, data.investors);
  validateHouseholdFinance(check, data.householdFinance);

  return { ok: check.errors.length === 0, errors: check.errors };
}

export const populationSaveModule: SaveModule<PopulationSaveData> = {
  id: 'population',
  version: POPULATION_SAVE_MODULE_VERSION,
  required: true,
  dependsOn: ['world'],
  ownedPaths: [
    'cities[].population',
    'cities[].publicSector',
    'cities[].workforce',
    'cities[].housing',
    'cities[].householdIncomeLastMonth',
    'households',
    'investors',
    'householdFinance',
  ],

  export(context: SaveExportContext): PopulationSaveData {
    const world = context.world;
    return cloneJson({
      cities: world.cities.map((city) => ({
        id: city.id,
        population: city.population,
        publicSector: city.publicSector,
        workforce: city.workforce,
        housing: city.housing,
        householdIncomeLastMonth: city.householdIncomeLastMonth,
      })),
      households: world.households,
      investors: world.investors,
      householdFinance: world.householdFinance,
    });
  },

  validate(data: unknown, version: number): SaveModuleValidation {
    if (version !== POPULATION_SAVE_MODULE_VERSION) {
      return {
        ok: false,
        errors: [
          `population 模块数据版本不受支持：${version}（当前支持 ${POPULATION_SAVE_MODULE_VERSION}）`,
        ],
      };
    }
    return validatePopulationData(data);
  },

  migrate(data: unknown, context: SaveModuleMigrationContext): PopulationSaveData {
    if (context.fromVersion === 0) {
      throw new Error('存档缺少 population 模块：居民现金/人口账本无法凭空重建');
    }
    if (context.fromVersion === POPULATION_SAVE_MODULE_VERSION) return data as PopulationSaveData;
    throw new Error(
      `不支持从 population 模块数据版本 ${context.fromVersion} 迁移到 ${context.toVersion}`,
    );
  },

  restore(data: PopulationSaveData, context: SaveRestoreContext): void {
    const world = context.world;
    for (const cityData of data.cities) {
      const city = context.cityOf(cityData.id);
      city.population = { ...cityData.population };
      city.publicSector = { ...cityData.publicSector };
      city.workforce = { ...cityData.workforce };
      city.housing = { ...cityData.housing };
      city.householdIncomeLastMonth = cityData.householdIncomeLastMonth;
    }
    world.households = data.households;
    world.investors = data.investors;
    world.householdFinance = data.householdFinance;
  },
};
