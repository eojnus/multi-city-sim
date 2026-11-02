// 居民群体经济：收入分配、个税、消费与储蓄的账目。
//
// 口径约定（与交付报告一致）：
// - 群体收入 = 私营工资（按企业岗位角色拆分实际已付工资）+ 公共部门工资
//             + 失业/非劳动力转移支付 + 居民投资实体返还的股息 + 交通退款。
// - 个税按城市既有口径（工资 × 城市个税率）计算，再按各群体工资比例分摊，
//   保证“群体个税合计 == 城市财政入账个税”。
// - 收入计入群体手头现金；消费与储蓄从群体手头现金扣减。资金守恒由 tick 级不变量兜底。

import type {
  City,
  HouseholdGroup,
  LogEntry,
  OccupationClass,
  RoleAllocation,
  WorldState,
} from '../contracts/types';
import type { DemoConfig } from '../../data/config';
import { DEMO_CONFIG } from '../../data/config';
import { round2 } from '../core/math';
import type { FinanceResult } from '../finance/finance';
import { occupationWageRate } from '../companies/company';
import { householdGroupsOfCity } from './household-groups';

const WAGE_OCCUPATIONS: (keyof RoleAllocation)[] = ['management', 'production', 'sales', 'research'];

/** 以 0.01 为单位按权重分配金额，保证合计严格等于 total。 */
export function allocateMoney(total: number, weights: number[]): number[] {
  const target = round2(total);
  if (weights.length === 0) return [];
  const cents = Math.round(target * 100);
  if (cents <= 0) return weights.map(() => 0);
  const weightSum = weights.reduce((acc, value) => acc + Math.max(0, value), 0);
  if (weightSum <= 0) {
    const base = Math.floor(cents / weights.length);
    const result = weights.map(() => base);
    for (let i = 0; i < cents - base * weights.length; i += 1) {
      result[i] = (result[i] ?? 0) + 1;
    }
    return result.map((value) => round2(value / 100));
  }
  const exact = weights.map((value) => (Math.max(0, value) / weightSum) * cents);
  const floors = exact.map((value) => Math.floor(value));
  let remaining = cents - floors.reduce((acc, value) => acc + value, 0);
  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  const result = [...floors];
  for (let i = 0; i < order.length && remaining > 0; i += 1) {
    const entry = order[i];
    if (!entry) continue;
    result[entry.index] = (result[entry.index] ?? 0) + 1;
    remaining -= 1;
  }
  return result.map((value) => round2(value / 100));
}

export interface CityHouseholdIncomeSplit {
  cityId: string;
  /** 各群体税前工资（私营 + 公共部门）。 */
  wages: Map<string, number>;
  /** 各群体转移支付。 */
  benefits: Map<string, number>;
  /** 各群体股息返还。 */
  dividends: Map<string, number>;
  /** 各群体交通退款。 */
  refunds: Map<string, number>;
  /** 各群体个税。 */
  taxes: Map<string, number>;
  /** 群体税后收入合计（不含退款）。 */
  householdIncome: number;
  incomeTax: number;
  benefitsPaid: number;
}

/** 交通退款总额：既支持旧的全城汇总数字，也支持按群体归属的明细。 */
export function householdRefundTotal(
  householdRefund: number | Readonly<Record<string, number>>,
): number {
  if (typeof householdRefund === 'number') return round2(Math.max(0, householdRefund));
  return round2(
    Object.values(householdRefund).reduce((total, value) => total + Math.max(0, value), 0),
  );
}

/**
 * 计算某城居民收入按职业群体的拆分。只读，不修改世界。
 * 拆分结果合计严格等于城市既有口径的收入与税收。
 */
export function splitCityHouseholdIncome(
  world: WorldState,
  city: City,
  finance: FinanceResult,
  benefitsPaid: number,
  householdRefund: number | Readonly<Record<string, number>>,
  config: DemoConfig = DEMO_CONFIG,
): CityHouseholdIncomeSplit {
  const groups = householdGroupsOfCity(world, city.id);
  const wages = new Map<string, number>();
  const benefits = new Map<string, number>();
  const dividends = new Map<string, number>();
  const refunds = new Map<string, number>();
  const taxes = new Map<string, number>();
  for (const group of groups) {
    wages.set(group.id, 0);
    benefits.set(group.id, 0);
    dividends.set(group.id, 0);
    refunds.set(group.id, 0);
    taxes.set(group.id, 0);
  }

  // 1. 私营工资：按企业本月实际支付的工资与岗位工资权重拆分。
  //    权重 = 岗位人数 × 该岗位月工资率（企业基准工资率 × 职业工资倍数），
  //    因此同一企业内管理/研发群体的人均工资高于生产/销售群体，不再是等额分摊。
  //    企业实发额可能低于应付（欠薪），故按权重比例缩放；allocateMoney 保证
  //    每个企业拆分到各群体的工资合计严格等于其实际支付额（0.01 精度）。
  for (const company of world.companies) {
    if (company.cityId !== city.id) continue;
    const paid = company.lastMonth.wagesPaid;
    if (paid <= 0 || company.employees <= 0) continue;
    const entries: { group: HouseholdGroup; weight: number }[] = [];
    for (const occupation of WAGE_OCCUPATIONS) {
      const count = company.roles[occupation] ?? 0;
      if (count <= 0) continue;
      const group = groups.find((entry) => entry.occupation === occupation);
      if (!group) continue;
      entries.push({
        group,
        weight: count * occupationWageRate(company, occupation, config),
      });
    }
    if (entries.length === 0) continue;
    const shares = allocateMoney(
      paid,
      entries.map((entry) => entry.weight),
    );
    entries.forEach((entry, index) => {
      wages.set(entry.group.id, round2((wages.get(entry.group.id) ?? 0) + (shares[index] ?? 0)));
    });
  }

  // 2. 公共部门工资。
  const publicGross = round2(city.publicSector.employees * city.publicSector.wageRate);
  const publicGroup = groups.find((entry) => entry.occupation === 'publicSector');
  if (publicGroup && publicGross > 0) {
    wages.set(publicGroup.id, round2((wages.get(publicGroup.id) ?? 0) + publicGross));
  }

  // 3. 转移支付：按“失业 × 救济 + 非劳动力 × 转移”的意愿比例拆分实际支付额。
  const unemployedGroup = groups.find((entry) => entry.occupation === 'unemployed');
  const nonLaborGroup = groups.find((entry) => entry.occupation === 'nonLabor');
  const unemployedDesired = city.population.unemployed * city.unemploymentBenefit;
  const nonLaborDesired = city.population.nonLabor * city.nonLaborTransfer;
  const desiredTotal = unemployedDesired + nonLaborDesired;
  if (benefitsPaid > 0 && desiredTotal > 0) {
    const [unemployedShare, nonLaborShare] = allocateMoney(benefitsPaid, [
      unemployedDesired,
      nonLaborDesired,
    ]);
    if (unemployedGroup) benefits.set(unemployedGroup.id, unemployedShare ?? 0);
    if (nonLaborGroup) benefits.set(nonLaborGroup.id, nonLaborShare ?? 0);
  }

  // 4. 股息返还：按群体人口比例归属。
  const residentDividends = finance.investorDistributionByCity[city.id] ?? 0;
  if (residentDividends > 0) {
    const shares = allocateMoney(
      residentDividends,
      groups.map((group) => group.people),
    );
    groups.forEach((group, index) => dividends.set(group.id, shares[index] ?? 0));
  }

  // 5. 交通退款：优先按“实际购买群体”归属（跨城购买产生的退款），
  //    旧口径（历史存档/无群体归属的汇总调用）按人口比例分摊。
  const refundTotal = householdRefundTotal(householdRefund);
  if (refundTotal > 0) {
    if (typeof householdRefund === 'number') {
      const shares = allocateMoney(refundTotal, groups.map((group) => group.people));
      groups.forEach((group, index) => refunds.set(group.id, shares[index] ?? 0));
    } else {
      let assigned = 0;
      for (const group of groups) {
        const amount = round2(Math.max(0, householdRefund[group.id] ?? 0));
        refunds.set(group.id, amount);
        assigned += amount;
      }
      // 明细合计与总额不一致时（旧数据兜底），差额按人口补足，保证账目闭合。
      const diff = round2(refundTotal - assigned);
      if (Math.abs(diff) >= 0.01) {
        const shares = allocateMoney(Math.abs(diff), groups.map((group) => group.people));
        groups.forEach((group, index) => {
          const delta = diff > 0 ? (shares[index] ?? 0) : -(shares[index] ?? 0);
          refunds.set(group.id, round2((refunds.get(group.id) ?? 0) + delta));
        });
      }
    }
  }

  // 6. 个税：沿用城市既有口径（工资 × 个税率），再按各群体工资比例分摊。
  const incomeTax = round2(
    round2(round2(finance.privateWagesByCity[city.id] ?? 0) * city.incomeTaxRate) +
      round2(publicGross * city.incomeTaxRate),
  );
  if (incomeTax > 0) {
    const shares = allocateMoney(
      incomeTax,
      groups.map((group) => wages.get(group.id) ?? 0),
    );
    groups.forEach((group, index) => taxes.set(group.id, shares[index] ?? 0));
  }

  let householdIncome = 0;
  for (const group of groups) {
    householdIncome +=
      (wages.get(group.id) ?? 0) +
      (benefits.get(group.id) ?? 0) +
      (dividends.get(group.id) ?? 0) -
      (taxes.get(group.id) ?? 0);
  }

  return {
    cityId: city.id,
    wages,
    benefits,
    dividends,
    refunds,
    taxes,
    householdIncome: round2(householdIncome),
    incomeTax,
    benefitsPaid: round2(benefitsPaid),
  };
}

/**
 * 把本月收入计入群体手头现金，并记录群体统计。
 * 返回该城居民可支配收入（与既有 city.lastMonth.householdIncome 口径一致）。
 */
export function applyHouseholdIncome(
  world: WorldState,
  city: City,
  finance: FinanceResult,
  benefitsPaid: number,
  householdRefund: number | Readonly<Record<string, number>>,
  log: LogEntry[],
  config?: DemoConfig,
): number {
  const split = splitCityHouseholdIncome(
    world,
    city,
    finance,
    benefitsPaid,
    householdRefund,
    config,
  );
  const refundTotal = householdRefundTotal(householdRefund);
  const groups = householdGroupsOfCity(world, city.id);
  for (const group of groups) {
    const wage = split.wages.get(group.id) ?? 0;
    const benefit = split.benefits.get(group.id) ?? 0;
    const dividend = split.dividends.get(group.id) ?? 0;
    const refund = split.refunds.get(group.id) ?? 0;
    const tax = split.taxes.get(group.id) ?? 0;
    const income = round2(wage + benefit + dividend - tax);
    group.cash = round2(group.cash + income + refund);
    // 净现金变化按“收入 + 退款 − 当期消费 − 当期储蓄”重算：
    // 消费（更早的步骤 13）与储蓄（更晚的步骤 21）都会同步改写 netCashChange，
    // 这里重算而不是累加，避免测试/迁移等直接结算路径把上月残值带进来。
    group.lastMonth = {
      ...group.lastMonth,
      income: round2(income + refund),
      wageIncome: wage,
      benefits: benefit,
      dividendIncome: dividend,
      incomeTax: tax,
      netCashChange: round2(
        income +
          refund -
          group.lastMonth.consumption -
          group.lastMonth.savingsContribution,
      ),
    };
  }
  // 退款不是新增收入，但进入下期可支配资金；与既有口径保持一致。
  if (refundTotal > 0) {
    log.push({
      tick: world.time.tick,
      kind: 'population',
      message: `${city.name} 居民收到跨城交易退款 ${refundTotal.toFixed(2)}（按实际购买群体计入群体现金）。`,
    });
  }
  return split.householdIncome;
}

/** 消费结算：从群体现金扣减实际消费，并记录想要购买的成本（预算约束展示）。 */
export function recordHouseholdConsumption(
  world: WorldState,
  city: City,
  spend: number,
  desiredCost: number,
): void {
  const groups = householdGroupsOfCity(world, city.id);
  const totalCash = groups.reduce((total, group) => total + group.cash, 0);
  const target = Math.min(round2(spend), totalCash);
  if (target > 0 && totalCash > 0) {
    const shares = allocateMoney(
      target,
      groups.map((group) => group.cash),
    );
    groups.forEach((group, index) => {
      const take = Math.min(group.cash, shares[index] ?? 0);
      group.cash = round2(group.cash - take);
      group.lastMonth.consumption = round2(group.lastMonth.consumption + take);
      group.lastMonth.netCashChange = round2(group.lastMonth.netCashChange - take);
    });
  }
  const desiredShares = allocateMoney(
    Math.max(0, round2(desiredCost)),
    groups.map((group) => group.people),
  );
  groups.forEach((group, index) => {
    group.lastMonth.desiredConsumption = desiredShares[index] ?? 0;
  });
}

/**
 * 某群体本月可用于消费的预算：上月收入 × 消费倾向，且不超过群体手头现金。
 * 逐群体消费必须以此为准，任何群体都不能动用其他群体的现金。
 */
export function householdGroupBudget(
  world: WorldState,
  city: City,
  group: HouseholdGroup,
  config: DemoConfig,
): number {
  const propensity = Math.max(0, config.consumer.propensity);
  const incomeBudget = round2(group.lastMonth.income * propensity);
  return round2(Math.max(0, Math.min(incomeBudget, group.cash)));
}

/**
 * 逐群体消费结算：从该群体现金扣减实际消费，记录消费与未满足的需求。
 * 返回实际扣款额（不超过该群体现金）。调用方负责把各群体支出汇总到城市口径。
 */
export function recordGroupConsumption(
  world: WorldState,
  city: City,
  groupId: string,
  spend: number,
  desiredCost: number,
): number {
  const group = householdGroupsOfCity(world, city.id).find((entry) => entry.id === groupId);
  if (!group) return 0;
  const paid = round2(Math.max(0, Math.min(round2(spend), group.cash)));
  if (paid > 0) {
    group.cash = round2(group.cash - paid);
    group.lastMonth.consumption = round2(group.lastMonth.consumption + paid);
    group.lastMonth.netCashChange = round2(group.lastMonth.netCashChange - paid);
  }
  group.lastMonth.desiredConsumption = round2(
    group.lastMonth.desiredConsumption + Math.max(0, round2(desiredCost)),
  );
  return paid;
}

/** 储蓄结算：居民可投资资金从群体现金转入居民投资实体。返回实际转出额。 */
export function debitHouseholdSavings(
  world: WorldState,
  city: City,
  amount: number,
): number {
  const groups = householdGroupsOfCity(world, city.id);
  const totalCash = groups.reduce((total, group) => total + group.cash, 0);
  const target = Math.min(round2(amount), totalCash);
  if (target <= 0 || totalCash <= 0) return 0;
  const shares = allocateMoney(
    target,
    groups.map((group) => group.cash),
  );
  let moved = 0;
  groups.forEach((group, index) => {
    const take = Math.min(group.cash, shares[index] ?? 0);
    group.cash = round2(group.cash - take);
    group.lastMonth.savingsContribution = round2(group.lastMonth.savingsContribution + take);
    group.lastMonth.netCashChange = round2(group.lastMonth.netCashChange - take);
    moved += take;
  });
  return round2(moved);
}

/** 供界面：某群体的展示信息（不含投资实体内部明细）。 */
export function householdGroupSummary(
  world: WorldState,
  group: HouseholdGroup,
): { id: string; name: string; occupation: OccupationClass; people: number; income: number } {
  return {
    id: group.id,
    name: group.name,
    occupation: group.occupation,
    people: group.people,
    income: group.lastMonth.income,
  };
}
