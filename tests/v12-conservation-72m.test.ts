// v1.2 §4：72 月观察口径测试（固定种子 20261101、玩家无操作、默认 AI）。
//
// 目的不是锁定具体经济数值（避免把衰退/波动写成期望），而是保证 72 个月里
// 人口、资金、股份、市场账本、贷款账本等**守恒与结构口径**不崩：
// - 每期结算成功（内部 checkInvariants 已通过），人口 P=E+U+N、群体人数合计=总人口；
// - 企业数 ≤ config.lifecycle.maxCompaniesPerCity（160/城），现金不为负、不是 NaN；
// - 市场 sold ≤ supply + intercityImported，食品市场同口径（跨城进口计入供给）；
// - 股份类 Σholdings == issuedShares；贷款 outstanding == principal − paidPrincipal；
// - 居民群体现金流闭合（收入 − 消费 − 储蓄 ≈ 净现金变化）；
// - 末月存档→读取往返后上述结构一致。
import { beforeAll, describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation/core/simulation';
import { parseSave, serializeSave } from '../src/simulation/core/save';
import { checkInvariants } from '../src/simulation/core/invariants';
import { DEMO_CONFIG } from '../src/data/config';
import { GOOD_IDS } from '../src/simulation/companies/company';
import type { GoodId, WorldState } from '../src/simulation/contracts/types';

const MONTHS = 72;
const SAVED_AT = '2026-11-04T00:00:00.000Z';
const EPS = 0.05;

let simulation: Simulation;
const problems: string[] = [];

function finite(problems: string[], label: string, value: number): void {
  if (!Number.isFinite(value)) problems.push(`${label} 不是有限数值（${value}）`);
}

/** 逐月结构审计：只查守恒/结构与非法数值，不查具体经济水平。 */
function auditMonth(world: WorldState, tick: number): string[] {
  const found: string[] = [];
  const prefix = `t${tick}`;

  // 人口：P=E+U+N；群体人数合计=总人口；就业群体人数=employed。
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
    // 说明：月中裁员/招聘后 syncHouseholdPeople 于下期再对齐职业群体人数，
    // 因此这里只校验“群体合计=总人口”（不变量口径），不校验就业群体与 employed 的瞬时相等。
    finite(found, `${prefix} ${city.id}.treasury`, city.treasury);
  }

  // 企业：每城在册企业数 ≤ 160；现金/债务/产能有限且现金不为负。
  const companiesByCity = new Map<string, number>();
  for (const company of world.companies) {
    companiesByCity.set(company.cityId, (companiesByCity.get(company.cityId) ?? 0) + 1);
    finite(found, `${prefix} ${company.id}.cash`, company.cash);
    finite(found, `${prefix} ${company.id}.debt`, company.debt);
    finite(found, `${prefix} ${company.id}.capacity`, company.capacity);
    if (company.cash < -EPS) {
      found.push(`${prefix} ${company.id}: 现金为负 ${company.cash}`);
    }
    if (company.debt < -EPS) found.push(`${prefix} ${company.id}: 债务为负 ${company.debt}`);
  }
  for (const [cityId, count] of companiesByCity) {
    if (count > DEMO_CONFIG.lifecycle.maxCompaniesPerCity) {
      found.push(
        `${prefix} ${cityId}: 在册企业 ${count} > 上限 ${DEMO_CONFIG.lifecycle.maxCompaniesPerCity}`,
      );
    }
  }

  // 市场账本：价格 > 0，成交不超过“本地供给 + 跨城进口”；食品单独再查一遍。
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
        found.push(
          `${prefix} ${city.id}/${goodId}: 成交 ${market.sold} 超过供给 ${available}`,
        );
      }
    }
  }

  // 股份：每个股份类别的持仓合计 == 发行量。
  for (const shareClass of world.securities.classes) {
    const held = world.securities.holdings
      .filter((holding) => holding.shareClassId === shareClass.id)
      .reduce((total, holding) => total + holding.shares, 0);
    if (Math.abs(held - shareClass.issuedShares) > 0.01) {
      found.push(
        `${prefix} ${shareClass.id}: 持仓 ${held} != 发行 ${shareClass.issuedShares}`,
      );
    }
  }

  // 银行：贷款恒等、存款非负；居民/投资实体/玩家现金有限。
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
    // 现金流闭合：收入 − 消费 − 储蓄 ≈ 净现金变化。
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

// v1.4 下 72 月模拟在 2 核/2GB 容器约 10 分钟，超过默认 hook 超时；提高上限。
beforeAll(async () => {
  simulation = Simulation.create(DEMO_CONFIG);
  for (let month = 0; month < MONTHS; month += 1) {
    const result = simulation.tick();
    if (!result.ok) {
      problems.push(`t${simulation.state.time.tick}: 结算失败 ${result.error ?? ''}`);
      break;
    }
    problems.push(...auditMonth(simulation.state, simulation.state.time.tick));
    // 早停：问题过多时不再继续跑，避免日志爆炸。
    if (problems.length > 50) break;
    // 长同步循环会让 vitest worker 超过 onTaskUpdate RPC 超时；每月让出事件循环一次，
    // 保证容器低内存下不产生 unhandled error（断言本身仍逐月执行）。
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}, 1_200_000);

describe('v1.2 72 月观察口径守恒（seed 20261101，玩家无操作，默认 AI）', () => {
  it('72 月逐月结算成功，人口/企业数/市场/股份/贷款/现金流结构无违规', () => {
    expect(problems).toEqual([]);
    expect(simulation.state.time.tick).toBe(MONTHS);
  });

  it('末月不变量为空，食品市场成交不超过供给+跨城进口', () => {
    const world = simulation.state;
    expect(checkInvariants(world)).toEqual([]);
    for (const city of world.cities) {
      const food = city.market.food;
      expect(food.price).toBeGreaterThan(0);
      expect(food.sold).toBeLessThanOrEqual(food.supply + food.intercityImported + EPS);
      expect(food.sold).toBeGreaterThanOrEqual(-EPS);
      expect(food.closingStock).toBeGreaterThanOrEqual(-EPS);
    }
    // 每城在册企业数在 160 上限内（开局 65 家，倒闭释放名额）。
    for (const city of world.cities) {
      const count = world.companies.filter((company) => company.cityId === city.id).length;
      expect(count).toBeLessThanOrEqual(DEMO_CONFIG.lifecycle.maxCompaniesPerCity);
      expect(count).toBeGreaterThan(0);
    }
  });

  it('末月存档→读取往返：进度/人口/资金/股份/贷款结构一致，不变量为空', () => {
    const world = simulation.state;
    const text = serializeSave(world, SAVED_AT);
    const parsed = parseSave(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || !parsed.world) throw new Error(parsed.error);
    const reloaded = parsed.world;

    expect(reloaded.time.tick).toBe(world.time.tick);
    expect(reloaded.cities.map((city) => city.population.total)).toEqual(
      world.cities.map((city) => city.population.total),
    );
    expect(reloaded.companies.map((company) => company.id).sort()).toEqual(
      world.companies.map((company) => company.id).sort(),
    );
    const sumOf = (values: number[]) => values.reduce((total, value) => total + value, 0);
    expect(sumOf(reloaded.companies.map((company) => company.cash))).toBeCloseTo(
      sumOf(world.companies.map((company) => company.cash)),
      2,
    );
    expect(sumOf(reloaded.households.groups.map((group) => group.cash))).toBeCloseTo(
      sumOf(world.households.groups.map((group) => group.cash)),
      2,
    );
    expect(sumOf(reloaded.investors.map((investor) => investor.cash))).toBeCloseTo(
      sumOf(world.investors.map((investor) => investor.cash)),
      2,
    );
    expect(reloaded.banking.loans.map((loan) => loan.outstanding).sort()).toEqual(
      world.banking.loans.map((loan) => loan.outstanding).sort(),
    );
    expect(checkInvariants(reloaded)).toEqual([]);
  });
});
