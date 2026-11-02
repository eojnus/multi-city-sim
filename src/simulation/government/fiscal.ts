import type { City, LogEntry, WorldState } from '../contracts/types';
import type { DemoConfig } from '../../data/config';
import { round2 } from '../core/math';
import type { FinanceResult } from '../finance/finance';
import { recordFiscal } from './treasury';
import { applyHouseholdIncome } from '../population/household-economy';
import type { HouseholdRefundAllocation } from '../transport/settlement';

/**
 * 城市财政与居民收入。个人所得税从工资中扣除，企业所得税进入财政；
 * 财政不足时福利按可用资金支付，公职人员工资仍按名义额支付并形成赤字。
 *
 * v0.3：每项收入与支出都写入 world.fiscal.ledger（来源可追溯），
 * 政策支出与交通支出由各自模块通过 treasury 记录。
 */
export function settleGovernment(
  world: WorldState,
  finance: FinanceResult,
  config: DemoConfig,
  log: LogEntry[],
  householdRefunds: Readonly<Record<string, number | HouseholdRefundAllocation>> = {},
): void {
  for (const city of [...world.cities].sort((a, b) => a.id.localeCompare(b.id))) {
    const privateWages = finance.privateWagesByCity[city.id] ?? 0;
    // 只有居民投资实体返还给居民的部分进入可支配收入；留存部分留在实体账户。
    // 企业持股所得留在企业现金，玩家所得进入玩家现金，均不重复计入居民收入。
    const residentDividends = finance.investorDistributionByCity[city.id] ?? 0;
    const corporateTax = finance.corporateTaxByCity[city.id] ?? 0;
    const publicGross = round2(
      city.publicSector.employees * city.publicSector.wageRate,
    );
    const privateIncomeTax = round2(privateWages * city.incomeTaxRate);
    const publicIncomeTax = round2(publicGross * city.incomeTaxRate);
    const incomeTax = round2(privateIncomeTax + publicIncomeTax);

    let treasury = city.treasury;
    receiveFiscal(world, city, incomeTax, 'incomeTax', `个人所得税（${city.name}）`, config);
    receiveFiscal(world, city, corporateTax, 'corporateTax', `企业所得税（${city.name}）`, config);
    treasury = round2(treasury + incomeTax + corporateTax);
    treasury = round2(treasury - publicGross);
    recordFiscal(
      world,
      {
        tick: world.time.tick,
        cityId: city.id,
        kind: 'publicWages',
        amount: -publicGross,
        source: `公共部门工资 ${city.publicSector.employees} 人（${city.name}）`,
      },
      config,
    );
    if (treasury < 0) {
      log.push({
        tick: world.time.tick,
        kind: 'warning',
        message: `${city.name} 财政出现赤字 ${(-treasury).toFixed(0)}；福利支付将受可用资金限制。`,
      });
    }

    const benefitsDesired = round2(
      city.population.unemployed * city.unemploymentBenefit +
        city.population.nonLabor * city.nonLaborTransfer,
    );
    const benefitsPaid = round2(Math.min(benefitsDesired, Math.max(0, treasury)));
    treasury = round2(treasury - benefitsPaid);
    if (benefitsPaid > 0) {
      recordFiscal(
        world,
        {
          tick: world.time.tick,
          cityId: city.id,
          kind: 'benefits',
          amount: -benefitsPaid,
          source: `失业与非劳动力转移支付（${city.name}）`,
        },
        config,
      );
    }

    const householdIncome = round2(
      privateWages * (1 - city.incomeTaxRate) +
        publicGross * (1 - city.incomeTaxRate) +
        benefitsPaid +
        residentDividends,
    );

    // v0.4：把同一批收入按职业群体计入群体现金（工资/福利/股息返还/个税），
    // 合计口径与上面的 householdIncome 一致，不新增货币。
    // v0.5：交通退款优先按实际购买群体归属，旧口径的城市总额按人口分摊。
    const refund = householdRefundParts(householdRefunds[city.id]);
    applyHouseholdIncome(
      world,
      city,
      finance,
      benefitsPaid,
      refund.allocation,
      log,
      config,
    );

    city.treasury = round2(treasury);
    // 退款不是新增收入，但应进入下期可支配资金，不能被本月收入覆盖。
    city.householdIncomeLastMonth = round2(householdIncome + refund.total);
    city.lastMonth = {
      ...city.lastMonth,
      householdIncome,
      benefitsPaid,
      incomeTax,
      corporateTax,
      publicWageBill: publicGross,
      migrationIn: 0,
      migrationOut: 0,
      investorDividends: finance.investorDividendsByCity[city.id] ?? 0,
      investableContribution: 0,
    };
  }
}

/**
 * 兼容两种退款口径：旧存档/旧调用的城市总额 number，以及 v0.5 的 { total, byGroup }。
 * 返回可直接交给 applyHouseholdIncome 的参数（byGroup map 或按人口分摊的总额）。
 */
function householdRefundParts(refund: number | HouseholdRefundAllocation | undefined): {
  total: number;
  allocation: number | Readonly<Record<string, number>>;
} {
  if (typeof refund === 'number') {
    const total = round2(Math.max(0, refund));
    return { total, allocation: total };
  }
  const total = round2(Math.max(0, refund?.total ?? 0));
  const byGroup = refund?.byGroup;
  if (!byGroup || total <= 0) return { total, allocation: total };
  const byGroupTotal = round2(
    Object.values(byGroup).reduce((sum, value) => sum + Math.max(0, value), 0),
  );
  // 明细合计与城市总额一致时按群体归属；不一致（旧数据）退回人口分摊，保证账目闭合。
  return {
    total,
    allocation: Math.abs(byGroupTotal - total) <= 0.005 ? byGroup : total,
  };
}

function receiveFiscal(
  world: WorldState,
  city: City,
  amount: number,
  kind: 'incomeTax' | 'corporateTax',
  source: string,
  config: DemoConfig,
): void {
  if (amount <= 0) return;
  recordFiscal(
    world,
    { tick: world.time.tick, cityId: city.id, kind, amount, source },
    config,
  );
}

export function recordMigrationReports(world: WorldState, city: City): void {
  let inbound = 0;
  let outbound = 0;
  for (const move of world.lastTick.migration) {
    if (move.toCityId === city.id) inbound += move.people;
    if (move.fromCityId === city.id) outbound += move.people;
  }
  city.lastMonth.migrationIn = inbound;
  city.lastMonth.migrationOut = outbound;
}
