import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation/core/simulation';
import { DEMO_CONFIG } from '../src/data/config';
import { planCompanyDecision, companyStyleLabel } from '../src/simulation/companies/ai/strategy';
import { setCompanyEmployees } from '../src/simulation/companies/company';
import { checkInvariants } from '../src/simulation/core/invariants';

describe('企业自动经营：风格差异与约束', () => {
  it('相同形势下不同风格给出可解释的不同计划', () => {
    const world = Simulation.create().state;
    const city = world.cities.find((entry) => entry.id === 'lanport')!;
    const company = world.companies.find((entry) => entry.cityId === city.id)!;
    setCompanyEmployees(company, 100);
    company.jobDemand = 100;
    company.cash = 5_000_000;
    company.utilization = 0.8;
    company.inventory[company.recipeOutput] = company.capacity * 0.5;
    company.previousMonth.produced = 100;
    company.previousMonth.sold = 100;
    city.market[company.recipeOutput].unmetDemand = 50;

    company.ai.style = 'growth';
    const growth = planCompanyDecision(world, company, DEMO_CONFIG);
    company.ai.style = 'return';
    const conservative = planCompanyDecision(world, company, DEMO_CONFIG);

    expect(companyStyleLabel('growth')).toContain('扩张');
    expect(companyStyleLabel('return')).toContain('回报');
    expect(growth.utilization).not.toBe(conservative.utilization);
    expect(growth.utilization).toBeGreaterThan(conservative.utilization);
    expect(growth.reasons.length).toBeGreaterThan(0);
    expect(conservative.reasons.length).toBeGreaterThan(0);
    // 两种风格都遵守同一组边界：利用率、岗位需求、投资不超过资金。
    for (const plan of [growth, conservative]) {
      expect(plan.utilization).toBeGreaterThanOrEqual(DEMO_CONFIG.company.minUtilization);
      expect(plan.utilization).toBeLessThanOrEqual(DEMO_CONFIG.company.maxUtilization);
      expect(plan.targetJobs).toBeGreaterThanOrEqual(0);
      expect(plan.investment).toBeLessThanOrEqual(company.cash);
      expect(Number.isFinite(plan.plan.expectedWageCost)).toBe(true);
    }
  });

  it('经营计划不突破失业人口、库存与产能上限（整月推进）', () => {
    const sim = Simulation.create();
    for (let index = 0; index < 6; index++) {
      const result = sim.tick();
      expect(result.ok, result.error).toBe(true);
    }
    const world = sim.state;
    for (const city of world.cities) {
      let allocated = city.publicSector.employees;
      for (const company of world.companies) {
        if (company.cityId !== city.id) continue;
        allocated += company.employees;
        expect(company.employees).toBeGreaterThanOrEqual(0);
        expect(company.employees).toBeLessThanOrEqual(city.population.laborForce);
        expect(company.capacity).toBeLessThanOrEqual(company.maxCapacity + 0.01);
        expect(company.ai.lastPlan).not.toBeNull();
        expect(company.ai.lastDecision.length).toBeGreaterThan(0);
      }
      expect(allocated).toBe(city.population.employed);
    }
    expect(checkInvariants(world)).toEqual([]);
  });
});
