import type { City, Company, LogEntry, WorldState } from '../contracts/types';
import type { DemoConfig } from '../../data/config';
import { round2 } from '../core/math';
import { setCityPopulation, syncCityPopulationFromAllocations } from '../population/population';
import { monthlyWageBill, setCompanyEmployees } from '../companies/company';
import { availableCredit } from '../banking/credit';

/**
 * v0.9 T5：企业是否满足“紧急裁员”情形。
 *
 * 条件（全部满足）：
 * 1. 最近 config.labor.emergencyLossMonths 个月（默认 2）经营利润均 < 0；
 * 2. 现金 + 合法可借授信 < config.labor.emergencyCashWageMonths 个月（默认 1）工资。
 *    授信取 availableCredit（同一主体全部银行贷款共享额度），因此“无资金”既包括现金耗尽，
 *    也包括授信耗尽；本判定只放宽当月裁员速度上限，不改变“需求下降才裁员”的岗位依据。
 * 该判定不修改任何状态；`recentProfits` 由 finance.settleCompanyFinance 每月维护。
 */
function isEmergencyLayoffEligible(
  world: WorldState,
  company: Company,
  config: DemoConfig,
): boolean {
  const lossMonths = Math.max(1, Math.round(config.labor.emergencyLossMonths));
  if (company.recentProfits.length < lossMonths) return false;
  const recent = company.recentProfits.slice(-lossMonths);
  if (!recent.every((profit) => profit < 0)) return false;
  const wageMonths = Math.max(0, config.labor.emergencyCashWageMonths);
  const liquidity = round2(
    company.cash +
      availableCredit(world, { kind: 'company', id: company.id }, config),
  );
  return liquidity < round2(monthlyWageBill(company, config) * wageMonths);
}

function layoffCompanies(
  city: City,
  world: WorldState,
  excess: number,
  includePublic: boolean,
): number {
  let remaining = excess;
  const companies = world.companies
    .filter((company) => company.cityId === city.id && company.employees > 0)
    .sort((a, b) => a.cash / Math.max(1, a.employees) - b.cash / Math.max(1, b.employees) || a.id.localeCompare(b.id));
  for (const company of companies) {
    if (remaining <= 0) break;
    const cut = Math.min(company.employees, remaining);
    if (cut > 0) {
      setCompanyEmployees(company, company.employees - cut);
      remaining -= cut;
    }
  }
  if (remaining > 0 && includePublic && city.publicSector.employees > 0) {
    const cut = Math.min(city.publicSector.employees, remaining);
    city.publicSector.employees -= cut;
    remaining -= cut;
  }
  return remaining;
}

export interface LaborResult {
  /** 每家企业本月实际新增雇员数（用于新增招聘补贴结算）。 */
  hiresByCompany: Record<string, number>;
  publicHires: number;
}

/**
 * 劳动力匹配。企业只能从本城失业人口中招聘；公共部门优先补员。
 * 所有人数变化完成后统一重算人口状态，保证 P = E + U + N。
 */
export function reconcileLabor(
  world: WorldState,
  config: DemoConfig,
  log: LogEntry[],
): LaborResult {
  const hiresByCompany: Record<string, number> = {};
  let publicHiresTotal = 0;
  for (const city of [...world.cities].sort((a, b) => a.id.localeCompare(b.id))) {
    const companies = world.companies
      .filter((company) => company.cityId === city.id)
      .sort((a, b) => a.id.localeCompare(b.id));

    // 1) 需求下降时逐步裁员：常规每月最多裁减 maxMonthlyLayoffRate（默认 8%），
    //    避免断崖式失业；v0.9 起严重情形（连续亏损 + 现金/授信不足 1 个月工资）允许
    //    当月上限提高到 emergencyLayoffShare（默认 30%），超出常规上限的部分记入
    //    stats.emergencyLayoffs（常规部分不计入，便于审计区分）。裁员依据仍是生产计划需求
    //    jobDemand：最多裁到需求人数为止，不得裁掉仍在计划中的岗位，也不得裁成负数。
    for (const company of companies) {
      if (company.employees <= company.jobDemand) continue;
      const regularCut = Math.max(
        0,
        company.employees -
          Math.ceil(company.employees * (1 - config.labor.maxMonthlyLayoffRate)),
      );
      const emergency = isEmergencyLayoffEligible(world, company, config);
      const emergencyShare = Math.max(0, Math.min(1, config.labor.emergencyLayoffShare));
      const emergencyCut = Math.max(
        0,
        company.employees - Math.ceil(company.employees * (1 - emergencyShare)),
      );
      const allowedCut = emergency ? Math.max(regularCut, emergencyCut) : regularCut;
      const desiredCut = company.employees - company.jobDemand;
      const cut = Math.max(0, Math.min(desiredCut, allowedCut, company.employees));
      if (cut > 0) {
        setCompanyEmployees(company, company.employees - cut);
        if (emergency && cut > regularCut) {
          company.lastMonth.emergencyLayoffs = cut - regularCut;
        }
      }
    }
    if (city.publicSector.employees > city.publicSector.jobs) {
      city.publicSector.employees = city.publicSector.jobs;
    }

    // 2) 人口下降可能使就业人数超过劳动力总量，必须先从企业侧调整。
    let employed = city.publicSector.employees;
    for (const company of companies) employed += company.employees;
    if (employed > city.population.laborForce) {
      const excess = employed - city.population.laborForce;
      const left = layoffCompanies(city, world, excess, false);
      if (left > 0) {
        city.publicSector.employees = Math.max(0, city.publicSector.employees - left);
      }
      employed = city.publicSector.employees;
      for (const company of companies) employed += company.employees;
      log.push({
        tick: world.time.tick,
        kind: 'warning',
        message: `${city.name} 劳动力总量下降，强制调整 ${excess} 个岗位。`,
      });
    }

    // 3) 招聘：公共部门优先，然后按企业 ID 确定性排序。
    let available = Math.max(0, city.population.laborForce - employed);
    let hired = 0;
    const publicVacancy = Math.max(0, city.publicSector.jobs - city.publicSector.employees);
    const publicHire = Math.min(publicVacancy, available);
    if (publicHire > 0) {
      city.publicSector.employees += publicHire;
      available -= publicHire;
      hired += publicHire;
      publicHiresTotal += publicHire;
    }
    for (const company of companies) {
      if (available <= 0) break;
      const vacancy = Math.max(0, company.jobDemand - company.employees);
      const hire = Math.min(vacancy, available);
      if (hire > 0) {
        setCompanyEmployees(company, company.employees + hire);
        hiresByCompany[company.id] = (hiresByCompany[company.id] ?? 0) + hire;
        available -= hire;
        hired += hire;
      }
    }

    syncCityPopulationFromAllocations(city, world);
    if (hired > 0) {
      log.push({
        tick: world.time.tick,
        kind: 'labor',
        message: `${city.name} 本月新招聘 ${hired} 人，失业 ${city.population.unemployed} 人。`,
      });
    }
  }
  return { hiresByCompany, publicHires: publicHiresTotal };
}

export function publicWageBill(city: City): number {
  return Math.round(city.publicSector.employees * city.publicSector.wageRate);
}

export function privateWageBill(city: City, world: WorldState): number {
  let total = 0;
  for (const company of world.companies) {
    if (company.cityId === city.id) total += company.employees * company.wageRate;
  }
  return Math.round(total);
}

export function totalWageBill(city: City, world: WorldState): number {
  return publicWageBill(city) + privateWageBill(city, world);
}

/** 仅用于初始化后的自检。 */
export function assertCityEmployment(city: City, world: WorldState): void {
  let employed = city.publicSector.employees;
  for (const company of world.companies) {
    if (company.cityId === city.id) employed += company.employees;
  }
  if (employed !== city.population.employed) {
    setCityPopulation(city, city.population.total, city.population.laborForce, employed);
  }
}
