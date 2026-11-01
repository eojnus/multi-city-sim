import type { Company, LogEntry, WorldState } from '../contracts/types';
import type { DemoConfig } from '../../data/config';
import { PRODUCTIVITY } from '../../data/demo-data';
import { clamp, round2 } from '../core/math';
import { monthlyWageBill } from '../companies/company';

/** 根据上月销售、库存和现金状况设定本月利用率与岗位需求。 */
export function planCompanies(
  world: WorldState,
  config: DemoConfig,
  log: LogEntry[],
): void {
  for (const company of [...world.companies].sort((a, b) => a.id.localeCompare(b.id))) {
    const city = world.cities.find((candidate) => candidate.id === company.cityId);
    if (!city) continue;
    const output = company.recipeOutput;
    const stock = company.inventory[output] ?? 0;
    const wageBill = monthlyWageBill(company);

    // 经营计划读取上一个完整结算月：本期开始时 lastMonth 已被重置为本月累计值。
    if (company.previousMonth.produced > 0.01) {
      const sellRatio =
        (company.previousMonth.sold + company.previousMonth.exported) /
        company.previousMonth.produced;
      company.utilization += (sellRatio - 1) * config.company.utilizationAdjust;
    }
    if (stock > Math.max(1, company.capacity * 0.8)) {
      company.utilization -= 0.05;
    }
    if (
      stock < Math.max(1, company.capacity * 0.15) &&
      (city.market[output]?.unmetDemand ?? 0) > 0
    ) {
      company.utilization += 0.05;
    }
    company.utilization = round2(
      clamp(company.utilization, config.company.minUtilization, config.company.maxUtilization),
    );

    const productivity = Math.max(1, PRODUCTIVITY[output] ?? 1);
    const tech = city.technology.productivityMultiplier;
    // 演示：岗位需求按产能而非当月利用率设定，避免短期需求波动直接造成断崖式失业。
    let targetJobs = Math.ceil(company.capacity / (productivity * tech));
    if (company.cash < wageBill * 1.5) targetJobs = Math.floor(targetJobs * 0.9);
    if (company.cash < wageBill * 0.5) targetJobs = Math.floor(targetJobs * 0.7);
    const maxJobs = Math.ceil(company.maxCapacity / Math.max(1, productivity * tech));
    const previous = company.jobDemand;
    company.jobDemand = clamp(targetJobs, 0, maxJobs);
    if (Math.abs(company.jobDemand - previous) >= Math.max(5, previous * 0.03)) {
      log.push({
        tick: world.time.tick,
        kind: 'labor',
        message: `${company.name} 岗位需求 ${previous} → ${company.jobDemand}（利用率 ${(company.utilization * 100).toFixed(0)}%）。`,
      });
    }
  }
}

export function companyPayroll(companies: Company[]): number {
  return round2(companies.reduce((total, company) => total + company.employees * company.wageRate, 0));
}
