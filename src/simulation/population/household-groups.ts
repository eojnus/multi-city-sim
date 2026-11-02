// 居民群体：人口、收入与资产的承载模型。
//
// 重要边界：
// - 群体人数（people）不是独立人口权威：它由城市人口、公共部门与企业岗位角色派生，
//   每期重算，保证“一个人只被统计一次”。
// - 群体手头现金属于本模块；银行存款权威在 world.banking.deposits（owner.kind='household'），
//   股票权益复用 world.securities 的居民投资实体持股，按人口比例归属。
// - 群体人口变化（招聘、裁员、自然变动、迁移）时按人均资产转移现金与存款，
//   不凭空产生或丢失资金。

import type {
  City,
  HouseholdGroup,
  HouseholdState,
  HouseholdTierStat,
  HouseholdWealthStats,
  OccupationClass,
  WealthTier,
  WorldState,
} from '../contracts/types';
import type { DemoConfig } from '../../data/config';
import { clamp, round2 } from '../core/math';
import { companySharePrice } from '../companies/company';
import { cityMarketPrices } from '../markets/markets';
import { depositAccountFor, ensureDepositAccount } from '../banking/banking';

/** 职业类别的固定顺序（确定性遍历与展示顺序）。 */
export const OCCUPATIONS: OccupationClass[] = [
  'management',
  'production',
  'sales',
  'research',
  'publicSector',
  'unemployed',
  'nonLabor',
];

export function householdGroupId(cityId: string, occupation: OccupationClass): string {
  return `${cityId}-hh-${occupation}`;
}

export function householdGroupsOfCity(world: WorldState, cityId: string): HouseholdGroup[] {
  return world.households.groups
    .filter((group) => group.cityId === cityId)
    .sort((a, b) => OCCUPATIONS.indexOf(a.occupation) - OCCUPATIONS.indexOf(b.occupation));
}

export function householdGroupOf(
  world: WorldState,
  cityId: string,
  occupation: OccupationClass,
): HouseholdGroup | undefined {
  return world.households.groups.find(
    (group) => group.cityId === cityId && group.occupation === occupation,
  );
}

/** 该职业群体本月名义收入（工资 / 福利口径），用于初始财富与展示，不写入世界。 */
export function occupationMonthlyIncome(
  world: WorldState,
  city: City,
  occupation: OccupationClass,
  config: DemoConfig,
): number {
  switch (occupation) {
    case 'management':
    case 'production':
    case 'sales':
    case 'research': {
      let total = 0;
      for (const company of world.companies) {
        if (company.cityId !== city.id) continue;
        total += (company.roles[occupation] ?? 0) * company.wageRate;
      }
      return round2(total);
    }
    case 'publicSector':
      return round2(city.publicSector.employees * city.publicSector.wageRate);
    case 'unemployed':
      return round2(city.population.unemployed * city.unemploymentBenefit);
    case 'nonLabor':
      return round2(city.population.nonLabor * city.nonLaborTransfer);
    default:
      return 0;
  }
}

/** 该职业群体人数（由权威数据派生）。 */
export function occupationPeople(
  world: WorldState,
  city: City,
  occupation: OccupationClass,
): number {
  switch (occupation) {
    case 'management':
    case 'production':
    case 'sales':
    case 'research': {
      let total = 0;
      for (const company of world.companies) {
        if (company.cityId !== city.id) continue;
        total += company.roles[occupation] ?? 0;
      }
      return total;
    }
    case 'publicSector':
      return city.publicSector.employees;
    case 'unemployed':
      return city.population.unemployed;
    case 'nonLabor':
      return city.population.nonLabor;
    default:
      return 0;
  }
}

function emptyGroup(
  cityId: string,
  occupation: OccupationClass,
  config: DemoConfig,
): HouseholdGroup {
  return {
    id: householdGroupId(cityId, occupation),
    cityId,
    occupation,
    name: config.households.labels[occupation],
    people: 0,
    cash: 0,
    lastMonth: {
      income: 0,
      wageIncome: 0,
      benefits: 0,
      dividendIncome: 0,
      incomeTax: 0,
      consumption: 0,
      desiredConsumption: 0,
      savingsContribution: 0,
      netCashChange: 0,
    },
    note: '群体人数由城市人口与岗位派生，不是额外人口。',
  };
}

/**
 * 新世界：按“若干个月群体收入”注入初始财富，制造可解释的初始贫富差距。
 * 只有新建世界会调用；旧存档迁移不得调用（不得凭空造钱）。
 */
export function createInitialHouseholds(world: WorldState, config: DemoConfig): HouseholdState {
  const groups: HouseholdGroup[] = [];
  for (const city of [...world.cities].sort((a, b) => a.id.localeCompare(b.id))) {
    for (const occupation of OCCUPATIONS) {
      const group = emptyGroup(city.id, occupation, config);
      group.people = occupationPeople(world, city, occupation);
      const months = config.households.initialWealthIncomeMonths[occupation];
      const monthlyIncome = occupationMonthlyIncome(world, city, occupation, config);
      const wealth = round2(monthlyIncome * months);
      const depositShare = config.households.initialDepositShare;
      group.cash = round2(wealth * (1 - depositShare));
      const account = ensureDepositAccount(
        world,
        { kind: 'household', id: group.id },
        config,
        world.time.tick,
      );
      account.balance = round2(wealth * depositShare);
      groups.push(group);
    }
  }
  return { groups, lastStats: [] };
}

/** 旧存档迁移：群体现金与存款为 0，不创造资金；人口由 syncHouseholdPeople 重算。 */
export function migrateHouseholds(world: WorldState, config: DemoConfig): HouseholdState {
  const groups: HouseholdGroup[] = [];
  for (const city of [...world.cities].sort((a, b) => a.id.localeCompare(b.id))) {
    for (const occupation of OCCUPATIONS) {
      const group = emptyGroup(city.id, occupation, config);
      group.people = occupationPeople(world, city, occupation);
      group.note = '旧存档迁移：群体初始现金与存款为 0（不凭空造钱），财富来自投资实体权益归属。';
      groups.push(group);
    }
  }
  return { groups, lastStats: [] };
}

function depositBalanceOf(world: WorldState, groupId: string): number {
  return depositAccountFor(world, { kind: 'household', id: groupId })?.balance ?? 0;
}

function addDepositBalance(world: WorldState, groupId: string, delta: number): void {
  const account = depositAccountFor(world, { kind: 'household', id: groupId });
  if (!account) return;
  account.balance = round2(Math.max(0, account.balance + delta));
}

/** 群体可支配现金（手头现金 + 银行存款）。 */
export function householdLiquidWealth(world: WorldState, group: HouseholdGroup): number {
  return round2(group.cash + depositBalanceOf(world, group.id));
}

/** 本城居民投资实体净资产（现金 + 持股市值）。 */
export function cityInvestorEquity(world: WorldState, cityId: string): number {
  let total = 0;
  for (const investor of world.investors) {
    if (investor.cityId !== cityId) continue;
    total += investor.cash;
    for (const holding of world.securities.holdings) {
      if (holding.holder.type !== 'investorGroup' || holding.holder.id !== investor.id) continue;
      const company = world.companies.find((candidate) => candidate.id === holding.companyId);
      if (!company) continue;
      const city = world.cities.find((candidate) => candidate.id === company.cityId);
      if (!city) continue;
      total += holding.shares * companySharePrice(company, cityMarketPrices(city));
    }
  }
  return round2(total);
}

/**
 * 群体人口变动时按人均资产转移现金与存款：减少的群体按人均转出，增加的群体按新增人数分配。
 * 城市内部总现金/存款不变；跨城迁移由 rebalanceHouseholdWealthForMigration 单独处理。
 */
export function syncHouseholdPeople(world: WorldState, config: DemoConfig): void {
  for (const city of [...world.cities].sort((a, b) => a.id.localeCompare(b.id))) {
    const groups = householdGroupsOfCity(world, city.id);
    if (groups.length === 0) continue;
    const targets = new Map<OccupationClass, number>();
    for (const occupation of OCCUPATIONS) {
      targets.set(occupation, Math.max(0, occupationPeople(world, city, occupation)));
    }
    let targetTotal = 0;
    for (const value of targets.values()) targetTotal += value;
    // 兜底：派生人数与城市总人口不一致时，差额计入非劳动力，保证合计严格相等。
    const diff = city.population.total - targetTotal;
    if (diff !== 0) {
      targets.set('nonLabor', Math.max(0, (targets.get('nonLabor') ?? 0) + diff));
    }

    const increases: { group: HouseholdGroup; delta: number }[] = [];
    const decreases: { group: HouseholdGroup; delta: number }[] = [];
    for (const group of groups) {
      const target = targets.get(group.occupation) ?? 0;
      const delta = target - group.people;
      if (delta > 0) increases.push({ group, delta });
      else if (delta < 0) decreases.push({ group, delta });
    }

    const totalIncrease = increases.reduce((total, entry) => total + entry.delta, 0);
    if (totalIncrease > 0) {
      // 只有存在接收方时才从减少的群体按人均转出资产；否则（例如净迁出后只剩减少）
      // 资产保留在剩余人口手中，避免同步人数时销毁资金。
      let poolCash = 0;
      let poolDeposit = 0;
      for (const entry of decreases) {
        const group = entry.group;
        const leaving = Math.min(-entry.delta, group.people);
        const perCapCash = group.people > 0 ? group.cash / group.people : 0;
        const perCapDeposit =
          group.people > 0 ? depositBalanceOf(world, group.id) / group.people : 0;
        const cashOut = round2(Math.min(group.cash, leaving * perCapCash));
        const depositOut = round2(leaving * perCapDeposit);
        group.cash = round2(group.cash - cashOut);
        addDepositBalance(world, group.id, -depositOut);
        poolCash = round2(poolCash + cashOut);
        poolDeposit = round2(poolDeposit + depositOut);
      }
      for (const entry of increases) {
        const share = entry.delta / totalIncrease;
        entry.group.cash = round2(entry.group.cash + poolCash * share);
        addDepositBalance(world, entry.group.id, poolDeposit * share);
      }
    }

    // 人数统一按权威数据写回（资产转移只发生在有人数增加时）。
    for (const group of groups) {
      group.people = targets.get(group.occupation) ?? 0;
    }
  }
}

/**
 * 跨城迁移：人口带走其人均现金与存款。由 population.applyMigration 在原子提交后调用。
 */
export function rebalanceHouseholdWealthForMigration(
  world: WorldState,
  fromCityId: string,
  toCityId: string,
  people: number,
): void {
  if (people <= 0) return;
  const source = householdGroupOf(world, fromCityId, 'unemployed');
  const destination = householdGroupOf(world, toCityId, 'unemployed');
  if (!source || !destination || source.people <= 0) return;
  const moving = Math.min(people, source.people);
  const perCapCash = source.cash / source.people;
  const perCapDeposit = depositBalanceOf(world, source.id) / source.people;
  const cashMoved = round2(Math.min(source.cash, moving * perCapCash));
  const depositMoved = round2(moving * perCapDeposit);
  source.cash = round2(source.cash - cashMoved);
  addDepositBalance(world, source.id, -depositMoved);
  destination.cash = round2(destination.cash + cashMoved);
  const account = depositAccountFor(world, { kind: 'household', id: destination.id });
  if (account) account.balance = round2(account.balance + depositMoved);
}

function tierOf(perCapitaWealth: number, config: DemoConfig): WealthTier {
  if (perCapitaWealth >= config.households.tierThresholds.high) return 'high';
  if (perCapitaWealth >= config.households.tierThresholds.middle) return 'middle';
  return 'low';
}

/** 每城财富阶层统计快照（人数合计 = 城市总人口；股票权益按人口比例归属）。 */
export function computeHouseholdWealthStats(
  world: WorldState,
  config: DemoConfig,
  tick: number,
): HouseholdWealthStats[] {
  const stats: HouseholdWealthStats[] = [];
  for (const city of [...world.cities].sort((a, b) => a.id.localeCompare(b.id))) {
    const groups = householdGroupsOfCity(world, city.id);
    const totalPeople = groups.reduce((total, group) => total + group.people, 0);
    const equity = cityInvestorEquity(world, city.id);
    const equityPerPerson = totalPeople > 0 ? equity / totalPeople : 0;

    const buckets: Record<WealthTier, HouseholdTierStat> = {
      low: { tier: 'low', people: 0, share: 0, perCapitaWealth: 0, perCapitaIncome: 0, cash: 0, deposits: 0, equity: 0 },
      middle: { tier: 'middle', people: 0, share: 0, perCapitaWealth: 0, perCapitaIncome: 0, cash: 0, deposits: 0, equity: 0 },
      high: { tier: 'high', people: 0, share: 0, perCapitaWealth: 0, perCapitaIncome: 0, cash: 0, deposits: 0, equity: 0 },
    };

    let totalCash = 0;
    let totalDeposits = 0;
    let totalIncome = 0;
    for (const group of groups) {
      const deposits = depositBalanceOf(world, group.id);
      const groupEquity = round2(group.people * equityPerPerson);
      const wealth = round2(group.cash + deposits + groupEquity);
      const perCapita = group.people > 0 ? wealth / group.people : 0;
      const tier = tierOf(perCapita, config);
      const bucket = buckets[tier];
      bucket.people += group.people;
      bucket.cash = round2(bucket.cash + group.cash);
      bucket.deposits = round2(bucket.deposits + deposits);
      bucket.equity = round2(bucket.equity + groupEquity);
      bucket.perCapitaIncome = round2(bucket.perCapitaIncome + group.lastMonth.income);
      totalCash = round2(totalCash + group.cash);
      totalDeposits = round2(totalDeposits + deposits);
      totalIncome = round2(totalIncome + group.lastMonth.income);
    }

    for (const tier of ['low', 'middle', 'high'] as WealthTier[]) {
      const bucket = buckets[tier];
      bucket.share = totalPeople > 0 ? round2(bucket.people / totalPeople * 10000) / 10000 : 0;
      const wealth = bucket.cash + bucket.deposits + bucket.equity;
      bucket.perCapitaWealth = bucket.people > 0 ? round2(wealth / bucket.people) : 0;
      bucket.perCapitaIncome = bucket.people > 0 ? round2(bucket.perCapitaIncome / bucket.people) : 0;
    }

    const totalWealth = round2(totalCash + totalDeposits + equity);
    stats.push({
      cityId: city.id,
      tick,
      tiers: [buckets.low, buckets.middle, buckets.high],
      totalPeople,
      totalCash,
      totalDeposits,
      totalEquity: equity,
      perCapitaIncome: totalPeople > 0 ? round2(totalIncome / totalPeople) : 0,
      perCapitaWealth: totalPeople > 0 ? round2(totalWealth / totalPeople) : 0,
      note: '人均资产 = 现金 + 银行存款 + 按人口比例归属的居民投资实体股票权益；股票市值不是现金。',
    });
  }
  return stats;
}

/** 记录本月阶层快照（保留最近若干月）。 */
export function recordHouseholdWealthStats(
  world: WorldState,
  config: DemoConfig,
  tick: number,
): void {
  world.households.lastStats = computeHouseholdWealthStats(world, config, tick);
}

/** 本城居民群体现金合计（消费预算上限）。 */
export function cityHouseholdCash(world: WorldState, cityId: string): number {
  let total = 0;
  for (const group of householdGroupsOfCity(world, cityId)) total += group.cash;
  return round2(total);
}

/** 按现金比例扣减本城群体现金（消费支出）。返回实际扣减额。 */
export function debitCityHouseholdCash(
  world: WorldState,
  cityId: string,
  amount: number,
): number {
  const groups = householdGroupsOfCity(world, cityId);
  const totalCash = groups.reduce((total, group) => total + group.cash, 0);
  const target = Math.min(amount, totalCash);
  if (target <= 0 || totalCash <= 0) return 0;
  let paid = 0;
  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index]!;
    const isLast = index === groups.length - 1;
    const share = isLast ? round2(target - paid) : round2(target * (group.cash / totalCash));
    const take = Math.min(group.cash, share);
    group.cash = round2(group.cash - take);
    paid = round2(paid + take);
  }
  return paid;
}

/** 群体现金上限校验（不变量用）。 */
export function clampHouseholdCash(world: WorldState): void {
  for (const group of world.households.groups) {
    group.people = Math.max(0, Math.round(group.people));
    group.cash = Math.max(0, round2(group.cash));
  }
}

/** 展示用：人均总资产（现金 + 存款 + 权益）。 */
export function householdPerCapitaWealth(
  world: WorldState,
  config: DemoConfig,
  group: HouseholdGroup,
): number {
  const city = world.cities.find((candidate) => candidate.id === group.cityId);
  if (!city) return 0;
  const cityGroups = householdGroupsOfCity(world, city.id);
  const totalPeople = cityGroups.reduce((total, entry) => total + entry.people, 0);
  const equity = cityInvestorEquity(world, city.id);
  const equityShare = totalPeople > 0 ? (equity / totalPeople) * group.people : 0;
  const wealth = group.cash + depositBalanceOf(world, group.id) + equityShare;
  return group.people > 0 ? round2(wealth / group.people) : 0;
}

/** 供 UI/银行：某城市居民总存款。 */
export function cityHouseholdDeposits(world: WorldState, cityId: string): number {
  let total = 0;
  for (const group of householdGroupsOfCity(world, cityId)) {
    total += depositBalanceOf(world, group.id);
  }
  return round2(total);
}

/** 消费预算：群体可支配现金 × 消费倾向，且不超过实际现金。 */
export function cityHouseholdBudget(
  world: WorldState,
  city: City,
  config: DemoConfig,
): number {
  const incomeBudget = Math.max(0, city.householdIncomeLastMonth * config.households.consumptionPropensity);
  const cash = cityHouseholdCash(world, city.id);
  return round2(Math.min(incomeBudget, cash));
}

export function clampNumber(value: number, min: number, max: number): number {
  return clamp(value, min, max);
}
