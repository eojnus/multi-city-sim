import type { City, LogEntry, WorldState } from '../contracts/types';
import type { DemoConfig } from '../../data/config';
import { setCityPopulation, syncCityPopulationFromAllocations } from '../population/population';
import { setCompanyEmployees } from '../companies/company';

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

    // 1) 需求下降时逐步裁员（演示：每月最多裁减 8%），避免断崖式失业。
    for (const company of companies) {
      if (company.employees > company.jobDemand) {
        const gradualFloor = Math.ceil(
          company.employees * (1 - config.labor.maxMonthlyLayoffRate),
        );
        setCompanyEmployees(company, Math.max(company.jobDemand, gradualFloor));
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
