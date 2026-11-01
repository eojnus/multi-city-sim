import type { LogEntry, WorldState } from '../contracts/types';
import type { DemoConfig } from '../../data/config';
import { clamp, round2 } from '../core/math';
import { monthlyWageBill } from '../companies/company';
import { ensureLiquidity, payInterest, repayDebt, companyCreditLimit, restructureDebt } from '../companies/credit';

export interface FinanceResult {
  /** 非玩家股东获得、计入城市居民收入的分红（已扣除玩家所得）。 */
  dividendsByCity: Record<string, number>;
  /** 玩家按持股比例实际收到的分红。 */
  playerDividends: number;
  playerDividendsByCompany: Record<string, number>;
  corporateTaxByCity: Record<string, number>;
  privateWagesByCity: Record<string, number>;
  wageArrears: number;
}

/**
 * 拆分一笔已支付股息。
 * 玩家所得先按 round2 取两位小数，其他股东取得“总额 - 玩家所得”的精确余额，
 * 因此 玩家所得 + 其他股东所得 === 企业实际支付总额（浮点误差由两次 round2 控制在 0.01 内）。
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
 * 现金不足时只能支付部分工资，欠薪记录在 lastMonth.wageArrears。
 */
export function settleCompanyFinance(
  world: WorldState,
  config: DemoConfig,
  log: LogEntry[],
): FinanceResult {
  const dividendsByCity: Record<string, number> = {};
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

    const dividendOwed =
      stats.profit > 0 ? round2(stats.profit * config.company.dividendPayoutRatio) : 0;
    const reserve = monthlyWageBill(company) * 0.5;
    const dividendPaid = round2(
      Math.min(company.cash, dividendOwed, Math.max(0, company.cash - reserve)),
    );
    company.cash = round2(company.cash - dividendPaid);
    stats.dividendsPaid = dividendPaid;

    const playerHolding = world.player.holdings.find(
      (holding) => holding.companyId === company.id,
    );
    const dividendSplit = splitDividend(
      dividendPaid,
      playerHolding?.shares ?? 0,
      company.totalShares,
    );
    if (dividendSplit.player > 0) {
      world.player.cash = round2(world.player.cash + dividendSplit.player);
      world.player.lastDividend = round2((world.player.lastDividend ?? 0) + dividendSplit.player);
      world.player.dividendsReceived = round2(
        (world.player.dividendsReceived ?? 0) + dividendSplit.player,
      );
      playerDividends = round2(playerDividends + dividendSplit.player);
      playerDividendsByCompany[company.id] = dividendSplit.player;
      log.push({
        tick: world.time.tick,
        kind: 'player',
        message: `${company.name} 分红 ${dividendPaid.toFixed(2)}；玩家按 ${(dividendSplit.stake * 100).toFixed(2)}% 持股获得 ${dividendSplit.player.toFixed(2)} 信用点。`,
      });
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

    dividendsByCity[city.id] = round2((dividendsByCity[city.id] ?? 0) + dividendSplit.other);
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

  return {
    dividendsByCity,
    playerDividends,
    playerDividendsByCompany,
    corporateTaxByCity,
    privateWagesByCity,
    wageArrears: round2(totalArrears),
  };
}
