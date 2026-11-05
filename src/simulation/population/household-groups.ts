// 居民群体：人口、收入与资产的承载模型。
//
// 重要边界：
// - 群体人数（people）不是独立人口权威：它由城市人口、公共部门与企业岗位角色派生，
//   每期重算，保证“一个人只被统计一次”。
// - 群体手头现金属于本模块；银行存款权威在 world.banking.deposits（owner.kind='household'），
//   股票权益复用 world.securities 的居民投资实体持股，按有效投资份额（investorLedger）归属。
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
import { companySharePrice, occupationWageRate } from '../companies/company';
import { cityMarketPrices } from '../markets/markets';
import { depositAccountFor, ensureDepositAccount } from '../banking/banking';
import { reallocateHouseholdDebtsForGroupChange } from './household-finance';
import {
  allocateMoneyExact,
  effectiveInvestorShares,
  ensureInvestorLedger,
  investorBondValue,
  investorEquityOfGroup,
  splitInvestorEquity,
} from './household-investment';
import { ensureInvestorOpeningShares } from '../investors/investors';

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
        // 问题 4：岗位月工资率 = 企业基准 wageRate × 职业工资倍数，
        // 不再按全体统一 wageRate 计算，因此不同职业群体的人均收入不同。
        total += (company.roles[occupation] ?? 0) * occupationWageRate(company, occupation, config);
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

/**
 * 调整群体存款余额；账户不存在时返回 false，绝不静默吞掉资金。
 * 调用方必须显式处理 false（先 ensureGroupDepositAccount 或放弃本次转移）。
 */
function addDepositBalance(world: WorldState, groupId: string, delta: number): boolean {
  const account = depositAccountFor(world, { kind: 'household', id: groupId });
  if (!account) return false;
  account.balance = round2(Math.max(0, account.balance + delta));
  return true;
}

/**
 * 确保群体存款账户存在（旧存档/迁移前可能尚未开户）。
 * 返回 false 表示无法开户，调用方应放弃这笔存款转移而不是让它消失。
 */
function ensureGroupDepositAccount(
  world: WorldState,
  groupId: string,
  config: DemoConfig,
  tick: number,
): boolean {
  if (depositAccountFor(world, { kind: 'household', id: groupId })) return true;
  try {
    ensureDepositAccount(world, { kind: 'household', id: groupId }, config, tick);
    return true;
  } catch {
    return false;
  }
}

/** 群体可支配现金（手头现金 + 银行存款）。 */
export function householdLiquidWealth(world: WorldState, group: HouseholdGroup): number {
  return round2(group.cash + depositBalanceOf(world, group.id));
}

/** 本城居民投资实体净资产（现金 + 持股市值 + 政府债券未到期本息，v1.4 §3）。 */
export function cityInvestorEquity(world: WorldState, cityId: string): number {
  let total = 0;
  for (const investor of world.investors) {
    if (investor.cityId !== cityId) continue;
    total += investor.cash;
    total += investorBondValue(world, investor.id);
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
      const cashTransfers: { group: HouseholdGroup; cashOut: number; depositOut: number }[] = [];
      for (const entry of decreases) {
        const group = entry.group;
        const leaving = Math.min(-entry.delta, group.people);
        const perCapCash = group.people > 0 ? group.cash / group.people : 0;
        const perCapDeposit =
          group.people > 0 ? depositBalanceOf(world, group.id) / group.people : 0;
        cashTransfers.push({
          group,
          cashOut: round2(Math.min(group.cash, leaving * perCapCash)),
          // 用余额夹取，避免 round2 后略大于余额导致“多转出”。
          depositOut: round2(
            Math.min(depositBalanceOf(world, group.id), leaving * perCapDeposit),
          ),
        });
      }
      const poolCash = round2(
        cashTransfers.reduce((total, entry) => total + entry.cashOut, 0),
      );
      const poolDeposit = round2(
        cashTransfers.reduce((total, entry) => total + entry.depositOut, 0),
      );

      // 存款转移要求双方都有账户（旧存档可能尚未开户）。任一参与方开户失败时，
      // 本应转移的存款留在原群体，绝不因 addDepositBalance 找不到账户而消失。
      let depositsMovable = poolDeposit > 0;
      if (depositsMovable) {
        const participants = [
          ...cashTransfers
            .filter((entry) => entry.depositOut > 0)
            .map((entry) => entry.group.id),
          ...increases.map((entry) => entry.group.id),
        ];
        for (const groupId of participants) {
          if (ensureGroupDepositAccount(world, groupId, config, world.time.tick)) continue;
          depositsMovable = false;
          break;
        }
      }

      for (const entry of cashTransfers) {
        entry.group.cash = round2(entry.group.cash - entry.cashOut);
        if (depositsMovable && entry.depositOut > 0) {
          addDepositBalance(world, entry.group.id, -entry.depositOut);
        }
      }
      for (const entry of increases) {
        const share = entry.delta / totalIncrease;
        entry.group.cash = round2(entry.group.cash + poolCash * share);
        if (depositsMovable && poolDeposit > 0) {
          addDepositBalance(world, entry.group.id, poolDeposit * share);
        }
      }

      // v1.3 §2：投资权益随人口同步转移（与现金/存款同一“迁出人数占比”口径）。
      // 减少群体按迁出比例拆出有效份额，汇总后按各接收群体新增人数权重分币级分配：
      // 接收方记入 openingShares（随人承接的既有权益，不是新投入），账本合计严格守恒。
      const ledgerMoves: { group: HouseholdGroup; moved: number; effective: number }[] = [];
      for (const entry of decreases) {
        const group = entry.group;
        const leaving = Math.min(-entry.delta, group.people);
        if (leaving <= 0 || group.people <= 0) continue;
        const effective = effectiveInvestorShares(group.investorLedger);
        if (effective <= 0) continue;
        const whole = leaving >= group.people;
        const moved = whole ? effective : round2(effective * (leaving / group.people));
        if (moved <= 0) continue;
        ledgerMoves.push({ group, moved, effective });
      }
      const poolShares = round2(ledgerMoves.reduce((total, entry) => total + entry.moved, 0));
      if (poolShares > 0) {
        const weights = increases.map((entry) => entry.delta);
        const credits = allocateMoneyExact(poolShares, weights);
        // 迁出人口的累计投入按同一比例随人转出，接收群体记账（只分配一次，避免重复累加）。
        const contributedPool = round2(
          ledgerMoves.reduce((total, entry) => {
            if (entry.effective <= 0) return total;
            return round2(total + ensureInvestorLedger(entry.group).contributed * (entry.moved / entry.effective));
          }, 0),
        );
        const contributedCredits = allocateMoneyExact(contributedPool, weights);
        for (const entry of ledgerMoves) {
          const ledger = ensureInvestorLedger(entry.group);
          const sharesOut = Math.min(Math.max(0, ledger.shares), entry.moved);
          const openingOut = round2(Math.max(0, entry.moved - sharesOut));
          const contributedOut =
            entry.effective > 0
              ? round2(ledger.contributed * (entry.moved / entry.effective))
              : 0;
          ledger.shares = round2(Math.max(0, ledger.shares - sharesOut));
          ledger.openingShares = round2(Math.max(0, (ledger.openingShares ?? 0) - openingOut));
          ledger.contributed = round2(Math.max(0, ledger.contributed - contributedOut));
        }
        increases.forEach((receiver, index) => {
          const received = credits[index] ?? 0;
          const contributed = contributedCredits[index] ?? 0;
          if (received <= 0 && contributed <= 0) return;
          const receiverLedger = ensureInvestorLedger(receiver.group);
          receiverLedger.openingShares = round2((receiverLedger.openingShares ?? 0) + received);
          receiverLedger.contributed = round2(receiverLedger.contributed + contributed);
        });
      }
    }

    // 人数统一按权威数据写回（资产转移只发生在有人数增加时）。
    // 债务与现金/存款同一套人数口径：按人均把消费贷未偿本金/欠息转移到新增人数的群体；
    // 群体人数归零且无接收方时按兜底规则并组或显式隔离（见 reallocateHouseholdDebtsForGroupChange）。
    reallocateHouseholdDebtsForGroupChange(world, config, city.id, targets);
    for (const group of groups) {
      group.people = targets.get(group.occupation) ?? 0;
    }

    // v1.3 §2：群体人数归零时不得把投资份额留在空群体。
    // 净迁出/无接收方场景下（上面的按人数转移不会触发），把空群体的有效份额按人口权重
    // 转给同城仍有人口的群体（分币级），合计守恒；若同城已无人则保留账本等待后续处理。
    const emptyGroups = groups.filter(
      (group) => group.people <= 0 && effectiveInvestorShares(group.investorLedger) > 0,
    );
    const holders = groups.filter((group) => group.people > 0);
    if (emptyGroups.length > 0 && holders.length > 0) {
      const holderWeights = holders.map((group) => Math.max(0, group.people));
      for (const group of emptyGroups) {
        const ledger = ensureInvestorLedger(group);
        const moved = effectiveInvestorShares(ledger);
        if (moved <= 0) continue;
        const credits = allocateMoneyExact(moved, holderWeights);
        const contributedCredits = allocateMoneyExact(ledger.contributed, holderWeights);
        ledger.shares = 0;
        ledger.openingShares = 0;
        ledger.contributed = 0;
        holders.forEach((holder, index) => {
          const received = credits[index] ?? 0;
          const contributed = contributedCredits[index] ?? 0;
          if (received <= 0 && contributed <= 0) return;
          const holderLedger = ensureInvestorLedger(holder);
          holderLedger.openingShares = round2((holderLedger.openingShares ?? 0) + received);
          holderLedger.contributed = round2(holderLedger.contributed + contributed);
        });
      }
    }
  }
  // v1.2 §1：开局/旧档首次同步人口时，把投资实体已有净资产一次性记为各群体的起始份额
  // （份额挂在“城 + 职业”群体上；自然人口变化不搬份额，只改变人均权益）。
  ensureInvestorOpeningShares(world);
}

export interface MigrationAssetTransfer {
  /** 随人口迁移的现金（源城扣减 = 目标城增加）。 */
  cashMoved: number;
  /** 随人口迁移的存款（源城扣减 = 目标城增加）。 */
  depositMoved: number;
  /** 实际发生资产转移的人数（按源群体人数夹取后的合计）。 */
  transferred: number;
}

/**
 * 跨城迁移：人口带走其人均现金与存款。由 population.applyMigration 在原子提交后调用。
 *
 * v0.4 验收问题 7 修复：
 * - 迁移人数按 laborForceMoved 拆分：劳动力部分对应 unemployed 群体，其余对应
 *   nonLabor 群体，分别按各自群体的人均资产转移（此前只处理 unemployed 群体，
 *   非劳动力那部分人的资产被留在原地）；
 * - 目标群体账户可能不存在（旧存档），先用 banking.ensureDepositAccount 确保开户；
 *   开户失败则整体放弃并返回零值，源城市资产分文不动，绝不出现“扣了源、目标没收到”；
 * - 现金与存款使用同一金额原子提交，返回实际转移额便于测试/审计。
 */
export function rebalanceHouseholdWealthForMigration(
  world: WorldState,
  fromCityId: string,
  toCityId: string,
  people: number,
  laborForceMoved: number = people,
  config?: DemoConfig,
  tick: number = world.time.tick,
): MigrationAssetTransfer {
  const result: MigrationAssetTransfer = { cashMoved: 0, depositMoved: 0, transferred: 0 };
  if (people <= 0) return result;

  const laborMoving = Math.max(0, Math.min(people, Math.round(laborForceMoved)));
  const nonLaborMoving = Math.max(0, people - laborMoving);
  const legs: { occupation: OccupationClass; moving: number }[] = [
    { occupation: 'unemployed', moving: laborMoving },
    { occupation: 'nonLabor', moving: nonLaborMoving },
  ];

  const moves: {
    source: HouseholdGroup;
    destination: HouseholdGroup;
    moving: number;
    cash: number;
    deposit: number;
  }[] = [];
  for (const leg of legs) {
    if (leg.moving <= 0) continue;
    const source = householdGroupOf(world, fromCityId, leg.occupation);
    const destination = householdGroupOf(world, toCityId, leg.occupation);
    if (!source || !destination || source.people <= 0) continue;
    const moving = Math.min(leg.moving, source.people);
    if (moving <= 0) continue;
    const depositBalance = depositBalanceOf(world, source.id);
    const perCapCash = source.cash / source.people;
    const perCapDeposit = depositBalance / source.people;
    moves.push({
      source,
      destination,
      moving,
      cash: round2(Math.min(source.cash, moving * perCapCash)),
      deposit: round2(Math.min(depositBalance, moving * perCapDeposit)),
    });
  }
  if (moves.length === 0) return result;

  // 目标账户必须全部可用：先开户；任何一步失败都整体放弃（源不扣款）。
  for (const move of moves) {
    if (move.deposit <= 0) continue;
    if (depositAccountFor(world, { kind: 'household', id: move.destination.id })) continue;
    if (!config) return result;
    if (ensureGroupDepositAccount(world, move.destination.id, config, tick)) continue;
    return result;
  }

  // 原子提交：同一金额从源群体扣除并加到目标群体，现金与存款都不复制、不丢失。
  for (const move of moves) {
    move.source.cash = round2(move.source.cash - move.cash);
    move.destination.cash = round2(move.destination.cash + move.cash);
    let depositMoved = 0;
    if (move.deposit > 0) {
      // 源账户一定存在（余额 > 0），但仍以返回值为准：借记失败则本笔存款原地不动。
      if (addDepositBalance(world, move.source.id, -move.deposit)) {
        addDepositBalance(world, move.destination.id, move.deposit);
        depositMoved = move.deposit;
      }
    }
    result.cashMoved = round2(result.cashMoved + move.cash);
    result.depositMoved = round2(result.depositMoved + depositMoved);
    result.transferred += move.moving;
  }
  return result;
}

function tierOf(perCapitaWealth: number, config: DemoConfig): WealthTier {
  if (perCapitaWealth >= config.households.tierThresholds.high) return 'high';
  if (perCapitaWealth >= config.households.tierThresholds.middle) return 'middle';
  return 'low';
}

/** 每城财富阶层统计快照（人数合计 = 城市总人口；股票权益按有效投资份额归属）。 */
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
    // v1.3 §2：权益按有效份额归属（与股息返还、居民授信同一口径），不再按人口平均。
    const groupEquities = splitInvestorEquity(groups, equity);

    const buckets: Record<WealthTier, HouseholdTierStat> = {
      low: { tier: 'low', people: 0, share: 0, perCapitaWealth: 0, perCapitaIncome: 0, cash: 0, deposits: 0, equity: 0 },
      middle: { tier: 'middle', people: 0, share: 0, perCapitaWealth: 0, perCapitaIncome: 0, cash: 0, deposits: 0, equity: 0 },
      high: { tier: 'high', people: 0, share: 0, perCapitaWealth: 0, perCapitaIncome: 0, cash: 0, deposits: 0, equity: 0 },
    };

    let totalCash = 0;
    let totalDeposits = 0;
    let totalIncome = 0;
    for (let index = 0; index < groups.length; index += 1) {
      const group = groups[index]!;
      const deposits = depositBalanceOf(world, group.id);
      const groupEquity = groupEquities[index] ?? 0;
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
      note: '人均资产 = 现金 + 银行存款 + 按有效投资份额归属的居民投资实体股票权益；股票市值不是现金。',
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
  const equity = cityInvestorEquity(world, city.id);
  // v1.3 §2：与财富统计、股息返还、居民授信共用“有效份额”口径。
  const equityShare = investorEquityOfGroup(cityGroups, group, equity);
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
