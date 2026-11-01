import type { LogEntry, WorldState } from '../contracts/types';
import type { DemoConfig } from '../../data/config';
import { clamp, round2 } from '../core/math';
import { monthlyWageBill } from '../companies/company';
import { ensureLiquidity, payInterest, repayDebt, companyCreditLimit, restructureDebt } from '../companies/credit';
import { distributeDividend, playerTotalShares } from '../securities/securities';

export interface FinanceResult {
  /** 居民投资实体本次实际收到的股息总额（按城市）。 */
  investorDividendsByCity: Record<string, number>;
  /** 其中返还给居民可支配收入的部分（其余留作投资资金）。 */
  investorDistributionByCity: Record<string, number>;
  /** 兼容字段：v0.2 起等于 investorDividendsByCity（不再直接把全部股息计入居民收入）。 */
  dividendsByCity: Record<string, number>;
  playerDividends: number;
  playerDividendsByCompany: Record<string, number>;
  corporateTaxByCity: Record<string, number>;
  privateWagesByCity: Record<string, number>;
  wageArrears: number;
}

/**
 * 拆分一笔股息（保留给旧测试与外部调用）：
 * 玩家所得按 round2 取两位小数，其他股东取得精确余额。
 * v0.2 的实际分配由 securities.distributeDividend 按持股逐笔完成。
 */
export function splitDividend(
  totalPaid: number,
  playerShares: number,
  totalShares: number,
): { player: number; other: number; stake: number } {
  const total = round2(Math.max(0, totalPaid));
  const stake = totalShares > 0 ? clamp(playerShares / totalShares, 0, 1) : 0;
  const player = round2(total * stake);
  return { player, other: round2(total - player), stake };
}

/**
 * 企业月度财务：支付工资 → 缴纳企业所得税 → 分配股息 → 调整产能。
 * 股息按 world.securities 的实际持股逐笔分配：玩家、企业、居民投资实体各自入账，
 * 不会把同一笔股息重复计入居民收入。
 */
export function settleCompanyFinance(
  world: WorldState,
  config: DemoConfig,
  log: LogEntry[],
): FinanceResult {
  const investorDividendsByCity: Record<string, number> = {};
  const investorDistribution: Record<string, number> = {};
  const playerDividendsByCompany: Record<string, number> = {};
  const corporateTaxByCity: Record<string, number> = {};
  const privateWagesByCity: Record<string, number> = {};
  let playerDividends = 0;
  let totalArrears = 0;

  for (const company of [...world.companies].sort((a, b) => a.id.localeCompare(b.id))) {
    const city = world.cities.find((candidate) => candidate.id === company.cityId);
    if (!city) continue;
    const stats = company.lastMonth;
    const owedWages = monthlyWageBill(company);
    const creditLimit = companyCreditLimit(company, config);
    if (company.debt > creditLimit * 0.8 && company.cash < owedWages * 0.2) {
      const forgiven = restructureDebt(company);
      company.cash = round2(company.cash + owedWages * 0.35);
      log.push({
        tick: world.time.tick,
        kind: 'warning',
        message: `${company.name} 触发债务重组：减免 ${forgiven.toFixed(0)} 债务并注入 ${(owedWages * 0.35).toFixed(0)} 营运资金（演示机制）。`,
      });
    }
    ensureLiquidity(company, owedWages, config);
    const paidWages = round2(Math.min(company.cash, owedWages));
    company.cash = round2(company.cash - paidWages);
    const arrears = round2(owedWages - paidWages);
    stats.wagesPaid = paidWages;
    stats.wageArrears = arrears;
    totalArrears += arrears;

    const preTaxProfit = round2(stats.revenue - stats.inputCost - paidWages);
    const taxOwed = round2(Math.max(0, preTaxProfit) * config.labor.corporateTaxRate);
    const taxPaid = round2(Math.min(company.cash, taxOwed));
    company.cash = round2(company.cash - taxPaid);
    stats.corporateTax = taxPaid;

    payInterest(company, config);
    repayDebt(company, config);
    stats.profit = round2(preTaxProfit - taxPaid - stats.interestPaid);

    const payoutRatio = clamp(company.dividendPayoutRatio, 0, 1);
    const dividendOwed = stats.profit > 0 ? round2(stats.profit * payoutRatio) : 0;
    const reserve = monthlyWageBill(company) * 0.5;
    const dividendPaid = round2(
      Math.min(company.cash, dividendOwed, Math.max(0, company.cash - reserve)),
    );

    const distribution = distributeDividend(
      world,
      company,
      dividendPaid,
      world.time.tick,
      config,
    );
    // 以实际可分出的金额扣款：无股东或最小货币单位不足时不会凭空扣走资金。
    const actualPaid = distribution.total;
    company.cash = round2(company.cash - actualPaid);
    stats.dividendsPaid = actualPaid;
    if (distribution.player > 0) {
      playerDividends = round2(playerDividends + distribution.player);
      playerDividendsByCompany[company.id] = distribution.player;
      const stake = company.totalShares > 0 ? playerTotalShares(world, company.id) / company.totalShares : 0;
      log.push({
        tick: world.time.tick,
        kind: 'player',
        message: `${company.name} 分红 ${actualPaid.toFixed(2)}；玩家按 ${(stake * 100).toFixed(2)}% 持股获得 ${distribution.player.toFixed(2)} 信用点。`,
      });
    }
    if (actualPaid !== dividendPaid && dividendPaid > 0) {
      log.push({
        tick: world.time.tick,
        kind: 'warning',
        message: `${company.name} 股息按最小货币单位分配后实付 ${actualPaid.toFixed(2)}（计划 ${dividendPaid.toFixed(2)}），差额未从企业扣除。`,
      });
    }
    for (const [cityId, amount] of Object.entries(distribution.investorByCity)) {
      investorDividendsByCity[cityId] = round2((investorDividendsByCity[cityId] ?? 0) + amount);
    }
    for (const [cityId, amount] of Object.entries(distribution.investorDistributionByCity)) {
      investorDistribution[cityId] = round2((investorDistribution[cityId] ?? 0) + amount);
    }

    if (arrears > 0.01) {
      log.push({
        tick: world.time.tick,
        kind: 'warning',
        message: `${company.name} 现金不足，欠薪 ${arrears.toFixed(0)}（工资应付 ${owedWages.toFixed(0)}）。`,
      });
    }

    // 产能调整：盈利且库存偏低时小幅扩张，亏损或库存过高时收缩。
    const stock = company.inventory[company.recipeOutput] ?? 0;
    let capacityChange = 0;
    if (stats.profit > 0 && stock < company.capacity * 0.5) {
      capacityChange = company.capacity * config.company.capacityGrowth;
    } else if (stats.profit < 0 || stock > company.capacity * 1.4) {
      capacityChange = -company.capacity * config.company.capacityShrink;
    }
    const minCapacity = Math.max(1, company.baseCapacity * config.company.minCapacityMultiple);
    const nextCapacity = clamp(
      company.capacity + capacityChange,
      minCapacity,
      company.maxCapacity,
    );
    stats.capacityChange = round2(nextCapacity - company.capacity);
    company.capacity = round2(nextCapacity);

    corporateTaxByCity[city.id] = round2((corporateTaxByCity[city.id] ?? 0) + taxPaid);
    privateWagesByCity[city.id] = round2((privateWagesByCity[city.id] ?? 0) + paidWages);
  }

  if (totalArrears > 0.01) {
    log.push({
      tick: world.time.tick,
      kind: 'warning',
      message: `本月企业欠薪合计 ${totalArrears.toFixed(0)}；居民收入按实际支付计算。`,
    });
  }

  const investorDistributionResult: Record<string, number> = {};
  for (const [cityId, amount] of Object.entries(investorDistribution)) {
    investorDistributionResult[cityId] = round2(amount);
  }

  return {
    investorDividendsByCity,
    investorDistributionByCity: investorDistributionResult,
    dividendsByCity: investorDividendsByCity,
    playerDividends,
    playerDividendsByCompany,
    corporateTaxByCity,
    privateWagesByCity,
    wageArrears: round2(totalArrears),
  };
}
