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
    // v0.9 起计划产量受劳动产能硬约束：员工要足够覆盖设备产能，利用率才由计划而非缺工决定。
    setCompanyEmployees(company, Math.max(1000, Math.ceil(company.capacity / 50)));
    company.jobDemand = company.employees;
    company.cash = 1_000_000_000;
    company.utilization = 0.8;
    // 以“设备利用率 80%”为销量参考，目标库存 0.5 个月，现有库存 0.2 个月：
    // 计划目标会向上限（上期实际产量 +20%）调整，两种风格的利用率偏置因此可见。
    company.salesHistory = [Math.round(company.capacity * 0.8)];
    company.inventory[company.recipeOutput] = company.capacity * 0.2;
    company.previousMonth.produced = company.capacity * 0.8;
    company.previousMonth.sold = company.capacity * 0.8;
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
        // v0.9 每城每月可新设企业：本 tick 才成立、尚未进入 planCompanies 的企业合法地没有计划。
        if (company.ai.lastPlan === null) {
          expect(company.ai.ageMonths).toBe(0);
        } else {
          expect(company.ai.lastDecision.length).toBeGreaterThan(0);
        }
      }
      expect(allocated).toBe(city.population.employed);
    }
    expect(checkInvariants(world)).toEqual([]);
  });
});
