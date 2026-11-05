// v1.3 §7 多 seed 观察口径测试（骨架，最终版待 task-46/47/48/49/50 落盘后补 v1.3 恒等式）。
//
// 目的：对固定种子 20261101 + 另两个种子（20261102、777001）各跑 36 月，
// 只断言守恒/结构与非法数值，不锁定具体经济曲线（避免把某条衰退曲线写成期望）。
// 覆盖：人口 P=E+U+N、群体人数合计=总人口、企业 ≤160/城、市场 sold ≤ supply+intercityImported、
// 股份 Σholdings==issuedShares、贷款 outstanding==principal−paidPrincipal、现金流闭合、
// 无 NaN/负现金（企业现金为负按规则内欠薪容差处理）、每月结算后不变量为空。
//
// 末尾输出每城失业率 / 食品满足率对照表（console + 收集在 results 中供 report 引用），
// Lead 可据此做多 seed 对照；不硬编码曲线数值。
import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation/core/simulation';
import { checkInvariants } from '../src/simulation/core/invariants';
import { DEMO_CONFIG } from '../src/data/config';
import type { DemoConfig } from '../src/data/config';
import { GOOD_IDS } from '../src/simulation/companies/company';
import type { GoodId, WorldState } from '../src/simulation/contracts/types';

const SEEDS = [20261101, 20261102, 777001] as const;
const MONTHS = 36;
const EPS = 0.05;

function configForSeed(seed: number): DemoConfig {
  return {
    ...DEMO_CONFIG,
    simulation: { ...DEMO_CONFIG.simulation, seed },
  } as DemoConfig;
}

function finite(found: string[], label: string, value: number): void {
  if (!Number.isFinite(value)) found.push(`${label} 不是有限数值（${value}）`);
}

/** 逐月结构审计：只查守恒/结构与非法数值，不查具体经济水平。 */
function auditMonth(world: WorldState, tick: number): string[] {
  const found: string[] = [];
  const prefix = `t${tick}`;

  for (const city of world.cities) {
    const p = city.population;
    if (p.total !== p.employed + p.unemployed + p.nonLabor) {
      found.push(`${prefix} ${city.id}: P != E+U+N`);
    }
    if (p.laborForce !== p.employed + p.unemployed) {
      found.push(`${prefix} ${city.id}: laborForce != E+U`);
    }
    if (p.total !== p.laborForce + p.nonLabor) {
      found.push(`${prefix} ${city.id}: total != laborForce+nonLabor`);
    }
    if (p.employed < 0 || p.unemployed < 0 || p.nonLabor < 0) {
      found.push(`${prefix} ${city.id}: 人口字段为负`);
    }
    const groups = world.households.groups.filter((group) => group.cityId === city.id);
    if (groups.length === 0) found.push(`${prefix} ${city.id}: 缺少居民群体`);
    const groupPeople = groups.reduce((total, group) => total + group.people, 0);
    if (groupPeople !== p.total) {
      found.push(`${prefix} ${city.id}: 群体人数 ${groupPeople} != 总人口 ${p.total}`);
    }
    finite(found, `${prefix} ${city.id}.treasury`, city.treasury);
  }

  // 企业：每城在册企业数 ≤ 160；现金/债务/产能有限且不为负。
  const companiesByCity = new Map<string, number>();
  for (const company of world.companies) {
    companiesByCity.set(company.cityId, (companiesByCity.get(company.cityId) ?? 0) + 1);
    finite(found, `${prefix} ${company.id}.cash`, company.cash);
    finite(found, `${prefix} ${company.id}.debt`, company.debt);
    finite(found, `${prefix} ${company.id}.capacity`, company.capacity);
    finite(found, `${prefix} ${company.id}.equipmentCapacity`, company.equipmentCapacity);
    if (company.cash < -EPS) found.push(`${prefix} ${company.id}: 现金为负 ${company.cash}`);
    if (company.debt < -EPS) found.push(`${prefix} ${company.id}: 债务为负 ${company.debt}`);
    for (const goodId of GOOD_IDS as GoodId[]) {
      const stock = company.inventory[goodId];
      finite(found, `${prefix} ${company.id}.inventory.${goodId}`, stock);
      if (stock < -EPS) found.push(`${prefix} ${company.id}: ${goodId} 库存为负 ${stock}`);
    }
  }
  for (const [cityId, count] of companiesByCity) {
    if (count > DEMO_CONFIG.lifecycle.maxCompaniesPerCity) {
      found.push(
        `${prefix} ${cityId}: 在册企业 ${count} > 上限 ${DEMO_CONFIG.lifecycle.maxCompaniesPerCity}`,
      );
    }
  }

  // 市场账本：价格 > 0，成交不超过“本地供给 + 跨城进口”；食品单独同口径。
  for (const city of world.cities) {
    for (const goodId of GOOD_IDS as GoodId[]) {
      const market = city.market[goodId];
      if (!market) continue;
      finite(found, `${prefix} ${city.id}/${goodId}.price`, market.price);
      finite(found, `${prefix} ${city.id}/${goodId}.sold`, market.sold);
      finite(found, `${prefix} ${city.id}/${goodId}.supply`, market.supply);
      finite(found, `${prefix} ${city.id}/${goodId}.closingStock`, market.closingStock);
      if (!(market.price > 0)) found.push(`${prefix} ${city.id}/${goodId}: 价格非正`);
      if (market.sold < -EPS) found.push(`${prefix} ${city.id}/${goodId}: 成交为负`);
      if (market.closingStock < -EPS) {
        found.push(`${prefix} ${city.id}/${goodId}: 期末库存为负`);
      }
      const available = market.supply + market.intercityImported;
      if (market.sold > available + EPS) {
        found.push(`${prefix} ${city.id}/${goodId}: 成交 ${market.sold} 超过供给 ${available}`);
      }
    }
  }

  // 股份：每个股份类别的持仓合计 == 发行量。
  for (const shareClass of world.securities.classes) {
    const held = world.securities.holdings
      .filter((holding) => holding.shareClassId === shareClass.id)
      .reduce((total, holding) => total + holding.shares, 0);
    if (Math.abs(held - shareClass.issuedShares) > 0.01) {
      found.push(`${prefix} ${shareClass.id}: 持仓 ${held} != 发行 ${shareClass.issuedShares}`);
    }
  }

  // 银行：贷款恒等、存款非负；居民/投资实体/玩家现金有限且不为负。
  for (const loan of world.banking.loans) {
    finite(found, `${prefix} ${loan.id}.principal`, loan.principal);
    finite(found, `${prefix} ${loan.id}.outstanding`, loan.outstanding);
    const expected = loan.principal - loan.paidPrincipal;
    if (Math.abs(expected - loan.outstanding) > 0.01) {
      found.push(`${prefix} ${loan.id}: 未偿 ${loan.outstanding} != ${expected}`);
    }
    if (loan.outstanding < -EPS) found.push(`${prefix} ${loan.id}: 未偿为负`);
  }
  for (const account of world.banking.deposits) {
    finite(found, `${prefix} ${account.id}.balance`, account.balance);
    if (account.balance < -EPS) found.push(`${prefix} ${account.id}: 存款余额为负`);
  }
  for (const group of world.households.groups) {
    finite(found, `${prefix} ${group.id}.cash`, group.cash);
    if (group.cash < -EPS) found.push(`${prefix} ${group.id}: 群体现金为负`);
    const expected =
      group.lastMonth.income - group.lastMonth.consumption - group.lastMonth.savingsContribution;
    if (Math.abs(expected - group.lastMonth.netCashChange) > 0.05) {
      found.push(
        `${prefix} ${group.id}: 现金流不闭合（应 ${expected}，记 ${group.lastMonth.netCashChange}）`,
      );
    }
  }
  for (const investor of world.investors) {
    finite(found, `${prefix} ${investor.id}.cash`, investor.cash);
    if (investor.cash < -EPS) found.push(`${prefix} ${investor.id}: 投资实体现金为负`);
  }
  finite(found, `${prefix} player.cash`, world.player.cash);
  if (world.player.cash < -EPS) found.push(`${prefix} player: 现金为负`);

  return found;
}

interface SeedMeasurement {
  seed: number;
  tick: number;
  cities: {
    cityId: string;
    name: string;
    unemploymentRate: number;
    foodFulfillmentRate: number;
    foodSold: number;
    foodConsumerDemand: number;
    foodIntercityImported: number;
    companies: number;
  }[];
}

const measurements: SeedMeasurement[] = [];

function measure(seed: number, world: WorldState): SeedMeasurement {
  return {
    seed,
    tick: world.time.tick,
    cities: world.cities.map((city) => {
      const p = city.population;
      const food = city.market.food;
      // 满足率 = 成交 / 居民需求（有跨城进口时仍以本地成交口径计，供对照参考）。
      const unemploymentRate = p.laborForce > 0 ? p.unemployed / p.laborForce : 0;
      const foodFulfillmentRate =
        food.consumerDemand > 0 ? Math.min(1, food.sold / food.consumerDemand) : 1;
      return {
        cityId: city.id,
        name: city.name,
        unemploymentRate,
        foodFulfillmentRate,
        foodSold: food.sold,
        foodConsumerDemand: food.consumerDemand,
        foodIntercityImported: food.intercityImported,
        companies: world.companies.filter((company) => company.cityId === city.id).length,
      };
    }),
  };
}

describe('v1.3 多 seed 守恒/结构观察（36 月，玩家无操作，默认 AI）', () => {
  for (const seed of SEEDS) {
    it(
      `seed ${seed}：36 月逐月结算成功且人口/企业/市场/股份/贷款/现金流结构无违规`,
      async () => {
        const simulation = Simulation.create(configForSeed(seed));
        const problems: string[] = [];
        for (let month = 0; month < MONTHS; month += 1) {
          const result = simulation.tick();
          const tick = simulation.state.time.tick;
          if (!result.ok) {
            problems.push(`t${tick}: 结算失败 ${result.error ?? ''}`);
            break;
          }
          problems.push(...auditMonth(simulation.state, tick));
          if (problems.length > 50) break;
          // 长同步循环会让 vitest worker 超过 onTaskUpdate RPC 超时；每月让出事件循环一次。
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
        expect(problems).toEqual([]);
        expect(simulation.state.time.tick).toBe(MONTHS);
        expect(checkInvariants(simulation.state)).toEqual([]);

        // 每城在册企业数在 160 上限内且有企业。
        for (const city of simulation.state.cities) {
          const count = simulation.state.companies.filter(
            (company) => company.cityId === city.id,
          ).length;
          expect(count).toBeGreaterThan(0);
          expect(count).toBeLessThanOrEqual(DEMO_CONFIG.lifecycle.maxCompaniesPerCity);
        }

        measurements.push(measure(seed, simulation.state));
      },
      240_000,
    );
  }

  it('多 seed 对照表：每城失业率/食品满足率/企业数可计算且落在合理区间', () => {
    expect(measurements).toHaveLength(SEEDS.length);
    const table: Record<string, unknown>[] = [];
    for (const measurement of measurements) {
      expect(measurement.tick).toBe(MONTHS);
      for (const city of measurement.cities) {
        expect(Number.isFinite(city.unemploymentRate)).toBe(true);
        expect(city.unemploymentRate).toBeGreaterThanOrEqual(0);
        expect(city.unemploymentRate).toBeLessThanOrEqual(1);
        expect(Number.isFinite(city.foodFulfillmentRate)).toBe(true);
        expect(city.foodFulfillmentRate).toBeGreaterThanOrEqual(0);
        expect(city.foodFulfillmentRate).toBeLessThanOrEqual(1);
        expect(city.companies).toBeGreaterThan(0);
        table.push({
          seed: measurement.seed,
          city: city.name,
          unemploymentRate: city.unemploymentRate,
          foodFulfillmentRate: city.foodFulfillmentRate,
          foodSold: city.foodSold,
          foodConsumerDemand: city.foodConsumerDemand,
          foodIntercityImported: city.foodIntercityImported,
          companies: city.companies,
        });
      }
    }
    // 供 Lead 做多 seed 对照（不硬编码具体曲线）：测试日志中输出 JSON 表。
    console.log(`v1.3 multi-seed t${MONTHS} comparison:\n${JSON.stringify(table, null, 2)}`);
  });
});
