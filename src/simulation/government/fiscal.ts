import type { City, LogEntry, WorldState } from '../contracts/types';
import type { DemoConfig } from '../../data/config';
import { round2 } from '../core/math';
import type { FinanceResult } from '../finance/finance';

/**
 * 城市财政与居民收入。个人所得税从工资中扣除，企业所得税进入财政；
 * 财政不足时福利按可用资金支付，公职人员工资仍按名义额支付并形成赤字。
 */
export function settleGovernment(
  world: WorldState,
  finance: FinanceResult,
  config: DemoConfig,
  log: LogEntry[],
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

    let treasury = city.treasury;
    treasury += corporateTax + privateIncomeTax + publicIncomeTax;
    treasury -= publicGross;
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
    treasury -= benefitsPaid;

    const householdIncome = round2(
      privateWages * (1 - city.incomeTaxRate) +
        publicGross * (1 - city.incomeTaxRate) +
        benefitsPaid +
        residentDividends,
    );

    city.treasury = round2(treasury);
    city.householdIncomeLastMonth = householdIncome;
    city.lastMonth = {
      ...city.lastMonth,
      householdIncome,
      benefitsPaid,
      incomeTax: round2(privateIncomeTax + publicIncomeTax),
      corporateTax,
      publicWageBill: publicGross,
      migrationIn: 0,
      migrationOut: 0,
      investorDividends: finance.investorDividendsByCity[city.id] ?? 0,
      investableContribution: 0,
    };
  }
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
