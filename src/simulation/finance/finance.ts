import type { Company, LogEntry, WorldState } from '../contracts/types';
import type { DemoConfig } from '../../data/config';
import { clamp, round2 } from '../core/math';
import { monthlyWageBill } from '../companies/company';
import { serviceCompanyLoans } from '../banking/banking';
import { bankLoansOf } from '../banking/credit';
import { requestCompanyWorkingCapital } from '../management/financing';
import { distributeDividend, playerTotalShares } from '../securities/securities';
import { accrueDividendTax } from '../government/taxes';

export interface FinanceResult {
  /** 居民投资实体本次实际收到的股息总额（按城市）。 */
  investorDividendsByCity: Record<string, number>;
  /** 其中返还给居民可支配收入的部分（其余留作投资资金）。 */
  investorDistributionByCity: Record<string, number>;
  /** 政府股东取得的股息（进入对应城市财政，不计入居民收入）。 */
  cityDividendsByCity: Record<string, number>;
  /** 兼容字段：v0.2 起等于 investorDividendsByCity（不再直接把全部股息计入居民收入）。 */
  dividendsByCity: Record<string, number>;
  playerDividends: number;
  playerDividendsByCompany: Record<string, number>;
  corporateTaxByCity: Record<string, number>;
  privateWagesByCity: Record<string, number>;
  wageArrears: number;
  /** v0.8：本月按城市汇总的代扣股息税（基准税额，交通系数在财政月结时应用）。 */
  dividendTaxByCity?: Record<string, number>;
  /** v0.8：其中玩家被代扣的股息税。 */
  playerDividendTax?: number;
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
 * v0.9：企业下月“已知偿债额”近似，仅用于季度奖金的现金储备校验。
 *
 * 口径（与 banking.serviceLoan 的下一期应收对齐，但不修改任何贷款）：
 * - 利息 = 当前未偿本金 × 合同月利率，外加已到期未付欠息；
 * - 本金 = min(合同月还本, 未偿本金)，最后一期按剩余未偿本金结清，外加已到期欠本；
 * - 逾期欠款按“下一期仍会继续催收”计入，属于保守估计（实际可能更高，但不会让奖金挤占偿债）。
 * 不含未来新增借款与罚息（本作不罚息、不计复利）。
 */
function estimateNextMonthDebtService(world: WorldState, company: Company): number {
  let total = 0;
  for (const loan of bankLoansOf(world)) {
    if (loan.borrower.kind !== 'company' || loan.borrower.id !== company.id) continue;
    if (loan.status === 'repaid') continue;
    const periodNumber = loan.nextDueTick - loan.startTick;
    const isFinalPeriod = periodNumber >= loan.termMonths;
    const interestDue = round2(loan.outstanding * loan.rateMonthly);
    const scheduledPrincipal = isFinalPeriod
      ? round2(loan.outstanding)
      : round2(Math.min(loan.monthlyPrincipal, loan.outstanding));
    total = round2(
      total + loan.arrearsInterest + interestDue + loan.arrearsPrincipal + scheduledPrincipal,
    );
  }
  return total;
}

/**
 * 企业月度财务：支付工资 → 缴纳企业所得税 → 分配股息 → 季度奖金 → 调整产能。
 * 股息按 world.securities 的实际持股逐笔分配：玩家、企业、居民投资实体各自入账，
 * 不会把同一笔股息重复计入居民收入。
 */
export function settleCompanyFinance(
  world: WorldState,
  config: DemoConfig,
  log: LogEntry[],
): FinanceResult {
  const investorDividendsByCity: Record<string, number> = {};
  const cityDividendsByCity: Record<string, number> = {};
  const investorDistribution: Record<string, number> = {};
  const playerDividendsByCompany: Record<string, number> = {};
  const corporateTaxByCity: Record<string, number> = {};
  const privateWagesByCity: Record<string, number> = {};
  let playerDividends = 0;
  let totalArrears = 0;
  const dividendTaxByCity: Record<string, number> = {};
  let playerDividendTax = 0;

  for (const company of [...world.companies].sort((a, b) => a.id.localeCompare(b.id))) {
    const city = world.cities.find((candidate) => candidate.id === company.cityId);
    if (!city) continue;
    const stats = company.lastMonth;
    const owedWages = monthlyWageBill(company, config);
    // v0.4：现金不足时按银行授信自动借入周转贷款（旧的无对手方信贷已停用）。
    // v0.4.1（验收问题 2）：玩家经营企业必须先过经营模式/授权，手动模式不得暗中举债；
    // 被拒绝时工资按可用现金发放并留下欠薪，由调用方日志/通知解释，不得先借后报。
    if (company.cash < owedWages) {
      const financing = requestCompanyWorkingCapital(
        world,
        config,
        world.time.tick,
        company,
        round2(owedWages - company.cash),
        '发放工资时现金不足',
      );
      if (financing.denied && financing.reason) {
        log.push({
          tick: world.time.tick,
          kind: 'warning',
          message: `${company.name} 工资资金不足：${financing.reason}`,
        });
      }
    }
    const paidWages = round2(Math.min(company.cash, owedWages));
    company.cash = round2(company.cash - paidWages);
    const arrears = round2(owedWages - paidWages);
    stats.wagesPaid = paidWages;
    stats.wageArrears = arrears;
    totalArrears += arrears;

    const preTaxProfit = round2(stats.revenue - stats.inputCost - paidWages);
    // 使用企业所在城市的有效企业税率：政策调整只影响该城市企业。
    const corporateTaxRate = clamp(city.corporateTaxRate, 0, 1);
    const taxOwed = round2(Math.max(0, preTaxProfit) * corporateTaxRate);
    const taxPaid = round2(Math.min(company.cash, taxOwed));
    company.cash = round2(company.cash - taxPaid);
    stats.corporateTax = taxPaid;

    // v0.4：银行还本付息排在工资与企业所得税之后、股息之前（债务优先于分红）。
    const loanService = serviceCompanyLoans(world, company, config, world.time.tick, log);
    stats.interestPaid = loanService.interestPaid;
    stats.profit = round2(preTaxProfit - taxPaid - stats.interestPaid);
    if (!company.ai) {
      company.ai = {
        style: 'steady',
        riskTolerance: 0.5,
        lossMonths: 0,
        ageMonths: 0,
        lastPlan: null,
        lastDecision: '尚未制定经营计划。',
        lastDecisionTick: world.time.tick,
      };
    }
    company.ai.lossMonths = stats.profit < 0 ? company.ai.lossMonths + 1 : 0;

    const payoutRatio = clamp(company.dividendPayoutRatio, 0, 1);
    const dividendOwed = stats.profit > 0 ? round2(stats.profit * payoutRatio) : 0;
    const reserve = monthlyWageBill(company, config) * 0.5;
    const dividendPaid = round2(
      Math.min(company.cash, dividendOwed, Math.max(0, company.cash - reserve)),
    );

    // v0.8 股息税：玩家与居民投资实体按实际分红代扣 10%（企业与政府股东首版不征）。
    // 在 distributeDividend 前记录投资实体的当月累计，按增量得到各实体实际所得；
    // 税从纳税人所得中扣除，企业分红支出不因税增加；实体返还居民的部分不再重复征。
    const investorDividendBefore = new Map(
      world.investors.map((group) => [group.id, group.lastDividend]),
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
    const dividendTaxRate = clamp(config.tax.dividendTaxRate, 0, 1);
    if (distribution.player > 0) {
      const playerTax = round2(distribution.player * dividendTaxRate);
      if (playerTax > 0) {
        world.player.cash = round2(world.player.cash - playerTax);
        world.player.lastDividend = round2(
          Math.max(0, (world.player.lastDividend ?? 0) - playerTax),
        );
        world.player.dividendsReceived = round2(
          Math.max(0, (world.player.dividendsReceived ?? 0) - playerTax),
        );
        playerDividendTax = round2(playerDividendTax + playerTax);
        dividendTaxByCity[world.player.homeCityId] = round2(
          (dividendTaxByCity[world.player.homeCityId] ?? 0) + playerTax,
        );
        accrueDividendTax(world, world.player.homeCityId, playerTax);
      }
      const playerNet = round2(distribution.player - playerTax);
      playerDividends = round2(playerDividends + playerNet);
      playerDividendsByCompany[company.id] = playerNet;
      const stake = company.totalShares > 0 ? playerTotalShares(world, company.id) / company.totalShares : 0;
      log.push({
        tick: world.time.tick,
        kind: 'player',
        message: `${company.name} 分红 ${actualPaid.toFixed(2)}；玩家按 ${(stake * 100).toFixed(2)}% 持股获得 ${playerNet.toFixed(2)} 信用点${playerTax > 0 ? `（代扣股息税 ${playerTax.toFixed(2)}）` : ''}。`,
      });
    }
    // 居民投资实体：按本月实际所得（lastDividend 增量）代扣税，现金与统计按净额。
    for (const group of world.investors) {
      const dividendGain = round2(group.lastDividend - (investorDividendBefore.get(group.id) ?? 0));
      if (dividendGain <= 0) continue;
      const tax = round2(dividendGain * dividendTaxRate);
      if (tax <= 0) continue;
      group.cash = round2(group.cash - tax);
      group.lastDividend = round2(Math.max(0, group.lastDividend - tax));
      group.dividendsReceived = round2(Math.max(0, group.dividendsReceived - tax));
      dividendTaxByCity[group.cityId] = round2((dividendTaxByCity[group.cityId] ?? 0) + tax);
      accrueDividendTax(world, group.cityId, tax);
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
    for (const [cityId, amount] of Object.entries(distribution.cityByCity)) {
      cityDividendsByCity[cityId] = round2((cityDividendsByCity[cityId] ?? 0) + amount);
    }
    for (const [cityId, amount] of Object.entries(distribution.investorDistributionByCity)) {
      investorDistribution[cityId] = round2((investorDistribution[cityId] ?? 0) + amount);
    }

    // v0.9 T5：季度奖金。每 bonusEveryMonths 月评估一次（默认 3 个月，即 tick 为 3 的倍数）；
    // 发放条件 = 最近 bonusEveryMonths 个月经营利润（stats.profit，不含奖金本身）均 > 0，
    // 且发完后仍保留 ≥ bonusReserveWageMonths×月工资 + bonusDebtServiceMonths×下月已知偿债。
    // 奖金池 = min(窗口利润合计 × bonusProfitShare, 可动用现金 − 储备)，下限 0；
    // 只用企业自有现金支付（绝不借款发奖金），不得把现金发成负数；核算不通过则不发。
    // 口径说明：利润不含奖金（奖金是对税后利润的分配，避免“发奖金→利润下降→下次不发”的反馈）；
    // 奖金计入 wagesPaid（居民工资拆分自动按职业权重分配）与城市私营工资（个税口径），
    // 同时单独记 bonusPaid，不另造重复收入口径；企业现金减少与居民收入增加一一对应。
    const compensation = config.compensation;
    const bonusWindow = Math.max(1, Math.round(compensation.bonusEveryMonths));
    let bonusPaid = 0;
    if (world.time.tick % bonusWindow === 0) {
      const profitWindow = [...company.recentProfits, stats.profit].slice(-bonusWindow);
      if (
        profitWindow.length === bonusWindow &&
        profitWindow.every((profit) => profit > 0)
      ) {
        const profitSum = round2(profitWindow.reduce((total, profit) => total + profit, 0));
        const reserve = round2(
          monthlyWageBill(company, config) * compensation.bonusReserveWageMonths +
            estimateNextMonthDebtService(world, company) *
              compensation.bonusDebtServiceMonths,
        );
        const spendableCash = round2(Math.max(0, company.cash - reserve));
        bonusPaid = round2(
          Math.min(
            Math.max(0, profitSum * compensation.bonusProfitShare),
            spendableCash,
          ),
        );
        if (bonusPaid > 0) {
          company.cash = round2(company.cash - bonusPaid);
          stats.bonusPaid = bonusPaid;
          stats.wagesPaid = round2(stats.wagesPaid + bonusPaid);
        }
      }
    }
    // 维护最近 bonusEveryMonths 个月税后利润（当前月最后入队），供下次季度评估与紧急裁员判定。
    company.recentProfits = [...company.recentProfits, stats.profit].slice(-bonusWindow);

    if (arrears > 0.01) {
      log.push({
        tick: world.time.tick,
        kind: 'warning',
        message: `${company.name} 现金不足，欠薪 ${arrears.toFixed(0)}（工资应付 ${owedWages.toFixed(0)}）。`,
      });
    }

    // v0.9：产能完全由设备资产决定（购买/出售设备时重算），不再随盈亏自动增减；
    // 避免“付费扩产”与设备购买重复获得产能。capacityChange 仅由设备交易写入。
    stats.capacityChange = 0;

    corporateTaxByCity[city.id] = round2((corporateTaxByCity[city.id] ?? 0) + taxPaid);
    // 私营工资口径含季度奖金（工资性收入），个税与居民工资拆分因此自动覆盖奖金。
    privateWagesByCity[city.id] = round2(
      (privateWagesByCity[city.id] ?? 0) + paidWages + bonusPaid,
    );
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
    cityDividendsByCity,
    dividendsByCity: investorDividendsByCity,
    playerDividends,
    playerDividendsByCompany,
    corporateTaxByCity,
    privateWagesByCity,
    wageArrears: round2(totalArrears),
    dividendTaxByCity,
    playerDividendTax,
  };
}
