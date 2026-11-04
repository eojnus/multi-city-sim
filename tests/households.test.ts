// 居民群体（household groups）行为测试：人口派生、财富阶层、招聘/裁员/迁移资产跟随、
// 收入/消费/储蓄入账与存档往返。
//
// 说明：
// - 只写测试，不改产品代码。
// - 每个测试独立使用 Simulation.create() 或 deepClone，避免互相污染。
// - 金额断言统一用容差（toBeCloseTo / Math.abs < 0.05），不用浮点严格相等。
// - 迁移资产守恒与消费统计闭合曾暴露两个产品 bug（已由 lead 修复），
//   现在按真实断言校验守恒/闭合；再次失败即为新问题，不放宽断言。

import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation/core/simulation';
import { DEMO_CONFIG } from '../src/data/config';
import type { DemoConfig } from '../src/data/config';
import type {
  City,
  LogEntry,
  OccupationClass,
  WealthTier,
  WorldState,
} from '../src/simulation/contracts/types';
import { checkInvariants } from '../src/simulation/core/invariants';
import { deepClone, parseSave, serializeSave } from '../src/simulation/core/save';
import { round2 } from '../src/simulation/core/math';
import { DeterministicRng } from '../src/simulation/core/rng';
import {
  OCCUPATIONS,
  cityHouseholdCash,
  cityInvestorEquity,
  computeHouseholdWealthStats,
  householdGroupOf,
  householdGroupsOfCity,
  occupationPeople,
  syncHouseholdPeople,
} from '../src/simulation/population/household-groups';
import { applyMigration, migrationAttractiveness } from '../src/simulation/population/population';
import { reconcileLabor } from '../src/simulation/labor/labor';
import { collectInvestableFunds } from '../src/simulation/investors/investors';
import { depositAccountFor } from '../src/simulation/banking/banking';

const WAGE_OCCUPATIONS: OccupationClass[] = ['management', 'production', 'sales', 'research'];
const AMOUNT_TOLERANCE = 0.05;

function sumOf<T>(items: T[], pick: (item: T) => number): number {
  return items.reduce((total, item) => total + pick(item), 0);
}

function expectAmount(actual: number, expected: number, tolerance = AMOUNT_TOLERANCE): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance);
}

function cityOf(world: WorldState, cityId: string): City {
  const city = world.cities.find((candidate) => candidate.id === cityId);
  if (!city) throw new Error(`测试世界缺少城市 ${cityId}`);
  return city;
}

function groupOf(world: WorldState, cityId: string, occupation: OccupationClass) {
  const group = householdGroupOf(world, cityId, occupation);
  if (!group) throw new Error(`城市 ${cityId} 缺少 ${occupation} 群体`);
  return group;
}

function groupDepositOf(world: WorldState, groupId: string): number {
  return depositAccountFor(world, { kind: 'household', id: groupId })?.balance ?? 0;
}

function householdRefundOfCity(world: WorldState, cityId: string): number {
  return world.transport.lastMonth.trades
    .filter((trade) => trade.buyerCompanyId === 'households' && trade.toCityId === cityId)
    .reduce((total, trade) => total + (trade.buyerRefund ?? 0), 0);
}

function expectedTier(perCapitaWealth: number, config: DemoConfig): WealthTier {
  if (perCapitaWealth >= config.households.tierThresholds.high) return 'high';
  if (perCapitaWealth >= config.households.tierThresholds.middle) return 'middle';
  return 'low';
}

function peopleOfCityGroups(world: WorldState, cityId: string): number {
  return sumOf(householdGroupsOfCity(world, cityId), (group) => group.people);
}

describe('居民群体：人口与就业派生', () => {
  it('初始人口一致：每城群体人数合计等于城市总人口，且不变量为空', () => {
    const sim = Simulation.create();
    expect(checkInvariants(sim.state)).toEqual([]);
    for (const city of sim.state.cities) {
      const groups = householdGroupsOfCity(sim.state, city.id);
      expect(groups.length).toBe(OCCUPATIONS.length);
      expect(peopleOfCityGroups(sim.state, city.id)).toBe(city.population.total);
      for (const occupation of OCCUPATIONS) {
        expect(groupOf(sim.state, city.id, occupation).people).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('职业人数派生：四类工资群体合计 = 私营就业，加公共部门 = employed，失业/非劳动力与人口字段一致', () => {
    const world = Simulation.create().state;
    for (const city of world.cities) {
      const privateEmployment = sumOf(
        world.companies.filter((company) => company.cityId === city.id),
        (company) => company.employees,
      );
      const wagePeople = sumOf(
        WAGE_OCCUPATIONS,
        (occupation) => occupationPeople(world, city, occupation),
      );
      const publicPeople = occupationPeople(world, city, 'publicSector');
      const unemployedPeople = occupationPeople(world, city, 'unemployed');
      const nonLaborPeople = occupationPeople(world, city, 'nonLabor');

      expect(wagePeople).toBe(privateEmployment);
      expect(wagePeople + publicPeople).toBe(city.population.employed);
      expect(unemployedPeople).toBe(city.population.unemployed);
      expect(nonLaborPeople).toBe(city.population.nonLabor);
      expect(wagePeople + publicPeople + unemployedPeople + nonLaborPeople).toBe(
        city.population.total,
      );

      // 群体人数必须等于同一派生口径（不是第二份人口权威）。
      for (const occupation of OCCUPATIONS) {
        expect(groupOf(world, city.id, occupation).people).toBe(
          occupationPeople(world, city, occupation),
        );
      }
      // 岗位分配合计必须等于企业员工数（派生口径的前提）。
      for (const company of world.companies.filter((entry) => entry.cityId === city.id)) {
        const roles = company.roles;
        expect(roles.management + roles.production + roles.sales + roles.research).toBe(
          company.employees,
        );
      }
    }
  });

  it('招聘不重复人口：提高企业 jobDemand 后 reconcileLabor，总人口不变且职业人数与就业数一致', () => {
    const world = deepClone(Simulation.create().state);
    const city = cityOf(world, 'lanport');
    const company = world.companies
      .filter((entry) => entry.cityId === city.id && entry.employees > 0)
      .sort((a, b) => a.id.localeCompare(b.id))[0]!;
    const beforePopulation = { ...city.population };
    const beforeEmployees = company.employees;
    const extraJobs = 30;

    company.jobDemand = beforeEmployees + extraJobs;
    const logs: LogEntry[] = [];
    reconcileLabor(world, DEMO_CONFIG, logs);
    syncHouseholdPeople(world, DEMO_CONFIG);

    expect(company.employees).toBe(beforeEmployees + extraJobs);
    expect(city.population.total).toBe(beforePopulation.total);
    expect(city.population.employed).toBe(beforePopulation.employed + extraJobs);
    expect(city.population.unemployed).toBe(beforePopulation.unemployed - extraJobs);

    const privateEmployment = sumOf(
      world.companies.filter((entry) => entry.cityId === city.id),
      (entry) => entry.employees,
    );
    const wagePeople = sumOf(
      WAGE_OCCUPATIONS,
      (occupation) => occupationPeople(world, city, occupation),
    );
    expect(wagePeople).toBe(privateEmployment);
    expect(wagePeople + occupationPeople(world, city, 'publicSector')).toBe(
      city.population.employed,
    );
    for (const occupation of OCCUPATIONS) {
      expect(groupOf(world, city.id, occupation).people).toBe(
        occupationPeople(world, city, occupation),
      );
    }
    expect(peopleOfCityGroups(world, city.id)).toBe(city.population.total);
    expect(checkInvariants(world)).toEqual([]);
  });
});

describe('居民群体：财富阶层统计', () => {
  it('阶层人数合计 = 城市总人口，perCapitaWealth 与现金/存款/权益口径自洽，阈值分组正确', () => {
    const world = Simulation.create().state;
    const stats = computeHouseholdWealthStats(world, DEMO_CONFIG, 0);
    expect(stats.length).toBe(world.cities.length);

    for (const city of world.cities) {
      const cityStats = stats.find((entry) => entry.cityId === city.id)!;
      const groups = householdGroupsOfCity(world, city.id);

      expect(cityStats.totalPeople).toBe(city.population.total);
      expect(sumOf(cityStats.tiers, (tier) => tier.people)).toBe(city.population.total);
      expect(sumOf(cityStats.tiers, (tier) => tier.share)).toBeCloseTo(1, 4);

      const totalCash = sumOf(groups, (group) => group.cash);
      const totalDeposits = sumOf(groups, (group) => groupDepositOf(world, group.id));
      expectAmount(cityStats.totalCash, totalCash);
      expectAmount(cityStats.totalDeposits, totalDeposits);
      expectAmount(cityStats.totalEquity, cityInvestorEquity(world, city.id));

      const totalWealth = round2(totalCash + cityStats.totalDeposits + cityStats.totalEquity);
      expectAmount(
        cityStats.perCapitaWealth,
        round2(totalWealth / Math.max(1, city.population.total)),
      );

      // 按 config 阈值独立复算每个群体应落入的阶层，人数必须与快照一致。
      const equityPerPerson =
        cityStats.totalPeople > 0 ? cityStats.totalEquity / cityStats.totalPeople : 0;
      const expectedPeople: Record<WealthTier, number> = { low: 0, middle: 0, high: 0 };
      for (const group of groups) {
        const deposits = groupDepositOf(world, group.id);
        const groupEquity = round2(group.people * equityPerPerson);
        const wealth = round2(group.cash + deposits + groupEquity);
        const perCapita = group.people > 0 ? wealth / group.people : 0;
        expectedPeople[expectedTier(perCapita, DEMO_CONFIG)] += group.people;
      }
      for (const tier of ['low', 'middle', 'high'] as WealthTier[]) {
        expect(cityStats.tiers.find((entry) => entry.tier === tier)!.people).toBe(
          expectedPeople[tier],
        );
      }
    }
  });
});

describe('居民群体：就业变动时资产跟随', () => {
  it('裁员资产跟随：被裁人数从职业群体转入失业群体，城市群体现金合计不变，失业群体现金增加', () => {
    const world = deepClone(Simulation.create().state);
    const city = cityOf(world, 'lanport');
    // 选员工最多的企业，确保 8% 渐进裁员在多个职业群体上都产生整数变化。
    const company = world.companies
      .filter((entry) => entry.cityId === city.id && entry.employees > 1000)
      .sort((a, b) => b.employees - a.employees || a.id.localeCompare(b.id))[0]!;

    const beforePopulation = { ...city.population };
    const beforePeople = new Map(
      OCCUPATIONS.map((occupation) => [occupation, groupOf(world, city.id, occupation).people]),
    );
    const beforeCash = cityHouseholdCash(world, city.id);
    const beforeCashByOccupation = new Map(
      OCCUPATIONS.map((occupation) => [occupation, groupOf(world, city.id, occupation).cash]),
    );
    const beforeUnemployedCash = groupOf(world, city.id, 'unemployed').cash;
    const beforeEmployees = company.employees;
    // 初始财富注入保证职业群体有现金（正是“资产跟随”的前提）。
    expect(groupOf(world, city.id, 'production').cash).toBeGreaterThan(0);

    company.jobDemand = 0;
    const logs: LogEntry[] = [];
    reconcileLabor(world, DEMO_CONFIG, logs);
    syncHouseholdPeople(world, DEMO_CONFIG);

    const layoff = beforeEmployees - company.employees;
    expect(layoff).toBeGreaterThan(0);
    expect(city.population.total).toBe(beforePopulation.total);
    expect(beforePopulation.employed - city.population.employed).toBe(layoff);
    expect(city.population.unemployed - beforePopulation.unemployed).toBe(layoff);

    const wagePeopleBefore = sumOf(
      WAGE_OCCUPATIONS,
      (occupation) => beforePeople.get(occupation) ?? 0,
    );
    const wagePeopleAfter = sumOf(
      WAGE_OCCUPATIONS,
      (occupation) => groupOf(world, city.id, occupation).people,
    );
    expect(wagePeopleBefore - wagePeopleAfter).toBe(layoff);
    expect(
      groupOf(world, city.id, 'unemployed').people - (beforePeople.get('unemployed') ?? 0),
    ).toBe(layoff);
    expect(groupOf(world, city.id, 'nonLabor').people).toBe(beforePeople.get('nonLabor'));
    expect(peopleOfCityGroups(world, city.id)).toBe(city.population.total);

    // 城市内部重新分类不得改变群体现金合计；失业群体接手被裁者的现金。
    expectAmount(cityHouseholdCash(world, city.id), beforeCash);
    const unemployedCashIncrease = groupOf(world, city.id, 'unemployed').cash - beforeUnemployedCash;
    expect(unemployedCashIncrease).toBeGreaterThan(0);
    const wageCashChange = sumOf(
      WAGE_OCCUPATIONS,
      (occupation) =>
        groupOf(world, city.id, occupation).cash -
        (beforeCashByOccupation.get(occupation) ?? 0),
    );
    expect(wageCashChange).toBeLessThan(0);
    // 减少的职业群体现金全部转入失业群体，不蒸发也不复制。
    expectAmount(unemployedCashIncrease, -wageCashChange);
    expect(checkInvariants(world)).toEqual([]);
  });
});

describe('居民群体：跨城迁移资产跟随', () => {
  function migrationSetup() {
    const world = deepClone(Simulation.create().state);
    const ranked = [...world.cities].sort(
      (a, b) =>
        migrationAttractiveness(b, world, DEMO_CONFIG) -
          migrationAttractiveness(a, world, DEMO_CONFIG) || a.id.localeCompare(b.id),
    );
    const destination = ranked[0]!;
    const source = ranked[ranked.length - 1]!;
    // 目的地制造岗位空缺，满足迁移门槛（否则初始世界 vacancies=0 不会有人口流动）。
    destination.publicSector.jobs =
      destination.publicSector.employees + Math.max(100, DEMO_CONFIG.population.migrationMinVacancies * 2);
    const before = {
      sourcePeople: source.population.total,
      destinationPeople: destination.population.total,
      sourceUnemployed: groupOf(world, source.id, 'unemployed').people,
      destinationUnemployed: groupOf(world, destination.id, 'unemployed').people,
      totalCash: sumOf(world.households.groups, (group) => group.cash),
      totalDeposits: sumOf(world.banking.deposits, (account) => account.balance),
    };
    const logs: LogEntry[] = [];
    applyMigration(world, new DeterministicRng(7), DEMO_CONFIG, logs);
    const moves = world.lastTick.migration;
    syncHouseholdPeople(world, DEMO_CONFIG);
    return { world, source, destination, before, moves };
  }

  it('迁移人数跟随：source 失业群体减少、dest 失业群体增加，群体人数合计仍等于城市人口', () => {
    const { world, source, destination, before, moves } = migrationSetup();
    const outbound = moves.filter((move) => move.fromCityId === source.id);
    const inbound = moves.filter((move) => move.toCityId === destination.id);
    expect(moves.length).toBeGreaterThan(0);
    expect(outbound.length).toBeGreaterThan(0);
    expect(inbound.length).toBeGreaterThan(0);

    const outboundPeople = sumOf(outbound, (move) => move.people);
    const outboundLabor = sumOf(outbound, (move) => move.laborForce);
    const inboundPeople = sumOf(inbound, (move) => move.people);
    const inboundLabor = sumOf(inbound, (move) => move.laborForce);
    expect(outboundPeople).toBeGreaterThan(0);
    expect(inboundPeople).toBeGreaterThanOrEqual(outboundPeople);

    expect(source.population.total).toBe(before.sourcePeople - outboundPeople);
    // 目的地可能同时接收其他城市迁入，因此按“迁入合计”而不是单一来源断言。
    expect(destination.population.total).toBe(before.destinationPeople + inboundPeople);
    expect(groupOf(world, source.id, 'unemployed').people).toBe(
      before.sourceUnemployed - outboundLabor,
    );
    expect(groupOf(world, destination.id, 'unemployed').people).toBe(
      before.destinationUnemployed + inboundLabor,
    );
    for (const city of world.cities) {
      expect(peopleOfCityGroups(world, city.id)).toBe(city.population.total);
    }
    expect(checkInvariants(world)).toEqual([]);
  });

  it('迁移资产守恒：跨城群体现金/存款合计不得复制或丢失', () => {
    const { world, before } = migrationSetup();
    const afterCash = sumOf(world.households.groups, (group) => group.cash);
    const afterDeposits = sumOf(world.banking.deposits, (account) => account.balance);

    // 迁移者带走人均现金/存款后，两城合计必须守恒（不复制、不丢失）。
    expectAmount(afterCash, before.totalCash);
    expectAmount(afterDeposits, before.totalDeposits);
  });
});

describe('居民群体：收入、消费与储蓄入账', () => {
  it('收入入账闭合：Σ group.income ≈ 城市居民收入 + 退款，Σ netCashChange ≈ income − consumption − savings', () => {
    const sim = Simulation.create();
    // 问题 5 起消费按群体预算结算，跨城补货规模比“全城统一预算”时小，
    // 容量退款出现得更晚（实测第 10 个月），因此用 12 个月窗口覆盖“+退款”分支。
    let sawRefund = false;
    for (let month = 1; month <= 12; month += 1) {
      const result = sim.tick();
      expect(result.ok, result.error).toBe(true);
      let refundTotal = 0;
      for (const city of sim.state.cities) {
        const groups = householdGroupsOfCity(sim.state, city.id);
        const refund = householdRefundOfCity(sim.state, city.id);
        refundTotal += refund;
        const income = sumOf(groups, (group) => group.lastMonth.income);
        const consumption = sumOf(groups, (group) => group.lastMonth.consumption);
        const savings = sumOf(groups, (group) => group.lastMonth.savingsContribution);
        const netCashChange = sumOf(groups, (group) => group.lastMonth.netCashChange);

        expect(income).toBeGreaterThan(0);
        // 退款不是新增收入，但计入下期可用资金，必须完整出现在群体收入中。
        expectAmount(income, city.lastMonth.householdIncome + refund, 0.1);
        expectAmount(netCashChange, income - consumption - savings, 0.1);
      }
      if (refundTotal > 0) sawRefund = true;
    }
    // 窗口内必须出现居民跨城购买退款，确保上面的“+退款”分支被真实覆盖。
    expect(sawRefund).toBe(true);
  });

  it('消费受现金约束：群体现金清零后现金预算为 0，只能靠自有授信消费（贷款不计收入）', () => {
    const sim = Simulation.create();
    const city = cityOf(sim.state, 'lanport');
    for (const group of householdGroupsOfCity(sim.state, city.id)) group.cash = 0;
    // v0.9 T1：存在基本需求缺口时允许从存款提取（≤ 月初存款 5%），这会抬高现金预算。
    // 本用例只验证“现金预算不含贷款额度”，故同时清零存款，聚焦纯现金口径。
    for (const group of householdGroupsOfCity(sim.state, city.id)) {
      group.lastMonth.depositWithdrawn = 0;
      const account = depositAccountFor(sim.state, { kind: 'household', id: group.id });
      if (account) account.balance = 0;
    }

    const result = sim.tick();
    expect(result.ok, result.error).toBe(true);
    // 现金预算严格为 0（#39：只用手头现金），贷款额度单列、不进入现金预算。
    expect(city.lastMonth.consumerBudget).toBe(0);
    const groups = householdGroupsOfCity(sim.state, city.id);
    const recordedConsumption = sumOf(groups, (group) => group.lastMonth.consumption);
    expect(city.lastMonth.consumerSpend).toBeCloseTo(recordedConsumption, 2);
    const loanDrawn = sumOf(groups, (group) => group.lastMonth.loanDrawn ?? 0);
    if (city.lastMonth.consumerSpend > 0) {
      // 有成交就必须有同月消费贷支撑（真实债务），且贷款不得进收入口径。
      expect(loanDrawn).toBeGreaterThan(0);
    }
    expect(loanDrawn).toBeGreaterThanOrEqual(0);
    // 收入在本月月末入账；贷款只是负债，现金增加不来自收入口径。
    expect(cityHouseholdCash(sim.state, city.id)).toBeGreaterThan(0);
  });

  it('储蓄真实转账：储蓄从群体现金转入本城居民投资实体，等额且不凭空造钱', () => {
    const world = deepClone(Simulation.create().state);
    const city = cityOf(world, 'lanport');
    const groupCashBefore = cityHouseholdCash(world, city.id);
    const investorCashBefore = sumOf(
      world.investors.filter((investor) => investor.cityId === city.id),
      (investor) => investor.cash,
    );

    collectInvestableFunds(world, DEMO_CONFIG, []);
    const contribution = city.lastMonth.investableContribution;
    expect(contribution).toBeGreaterThan(0);

    const groupCashAfter = cityHouseholdCash(world, city.id);
    const investorCashAfter = sumOf(
      world.investors.filter((investor) => investor.cityId === city.id),
      (investor) => investor.cash,
    );
    // 群体侧等额减少、投资实体侧等额增加。
    expectAmount(groupCashBefore - groupCashAfter, contribution);
    expectAmount(investorCashAfter - investorCashBefore, contribution);
    // 两个主体合计（不含银行）现金不变：储蓄只是居民资产在用途之间划转。
    expectAmount(
      groupCashAfter + investorCashAfter,
      groupCashBefore + investorCashBefore,
    );
  });

  it('储蓄统计入账：推进后各城群体 savingsContribution 合计等于城市 investableContribution', () => {
    const sim = Simulation.create();
    const result = sim.tick();
    expect(result.ok, result.error).toBe(true);
    for (const city of sim.state.cities) {
      const savings = sumOf(
        householdGroupsOfCity(sim.state, city.id),
        (group) => group.lastMonth.savingsContribution,
      );
      expect(city.lastMonth.investableContribution).toBeGreaterThan(0);
      expectAmount(savings, city.lastMonth.investableContribution);
    }
  });

  it('居民统计净现金流等于群体现金实际变动：消费统计入账且现金流闭合', () => {
    const sim = Simulation.create();
    const city = cityOf(sim.state, 'lanport');
    const cashBefore = cityHouseholdCash(sim.state, city.id);
    const result = sim.tick();
    expect(result.ok, result.error).toBe(true);
    expect(city.lastMonth.consumerSpend).toBeGreaterThan(0);

    const groups = householdGroupsOfCity(sim.state, city.id);
    const recordedConsumption = sumOf(groups, (group) => group.lastMonth.consumption);
    // 类型契约要求 lastMonth.consumption = 本月实际消费支出。
    expect(recordedConsumption).toBeCloseTo(city.lastMonth.consumerSpend, 2);

    const cashChange = cityHouseholdCash(sim.state, city.id) - cashBefore;
    const netCashChange = sumOf(groups, (group) => group.lastMonth.netCashChange);
    // 统计口径应与实际现金变动闭合：现金变动 = 收入 − 消费 − 储蓄 + 本月新借 − 本月还本付息。
    const loop = (sim.state.householdFinance?.loans ?? []).filter(
      (loan) => loan.cityId === city.id,
    );
    const loanDrawn = sumOf(loop, (loan) => Math.max(0, loan.principal));
    const repaidThisTick = sumOf(loop, (loan) =>
      loan.payments
        .filter((payment) => payment.tick === sim.state.time.tick)
        .reduce((total, payment) => total + payment.principalPaid + payment.interestPaid, 0),
    );
    expect(netCashChange + loanDrawn - repaidThisTick).toBeCloseTo(cashChange, 2);
  });
});

describe('居民群体：确定性与存档往返', () => {
  it('固定种子确定性：两个新世界各推进 12 期，serializeSave 文本完全一致', () => {
    const savedAt = '2026-11-02T00:00:00.000Z';
    const runTwelveMonths = (): string => {
      const sim = Simulation.create();
      for (let month = 0; month < 12; month += 1) {
        const result = sim.tick();
        expect(result.ok, result.error).toBe(true);
      }
      return serializeSave(sim.state, savedAt);
    };
    const first = runTwelveMonths();
    const second = runTwelveMonths();
    expect(second).toBe(first);
  });

  it('存档往返：推进 6 期后 parseSave(serializeSave(state))，居民/经营者/银行状态一致', () => {
    const sim = Simulation.create();
    for (let month = 0; month < 6; month += 1) {
      const result = sim.tick();
      expect(result.ok, result.error).toBe(true);
    }
    const parsed = parseSave(serializeSave(sim.state, '2026-11-02T00:00:00.000Z'));
    expect(parsed.ok, parsed.error).toBe(true);
    const restored = parsed.world!;

    for (const city of sim.state.cities) {
      const beforeGroups = householdGroupsOfCity(sim.state, city.id);
      const afterGroups = householdGroupsOfCity(restored, city.id);
      expect(afterGroups.length).toBe(beforeGroups.length);
      for (let index = 0; index < beforeGroups.length; index += 1) {
        const before = beforeGroups[index]!;
        const after = afterGroups[index]!;
        expect(after.occupation).toBe(before.occupation);
        expect(after.people).toBe(before.people);
        expectAmount(after.cash, before.cash);
        expect(after.lastMonth).toEqual(before.lastMonth);
        expectAmount(groupDepositOf(restored, after.id), groupDepositOf(sim.state, before.id));
      }
      const beforeStats = sim.state.households.lastStats.find(
        (entry) => entry.cityId === city.id,
      )!;
      const afterStats = restored.households.lastStats.find(
        (entry) => entry.cityId === city.id,
      )!;
      expect(afterStats).toEqual(beforeStats);
    }

    expect(restored.management.operators).toEqual(sim.state.management.operators);
    expect(restored.management.playerOperations).toEqual(sim.state.management.playerOperations);
    expect(restored.banking.deposits).toEqual(sim.state.banking.deposits);
    expect(restored.banking.loans).toEqual(sim.state.banking.loans);
    expect(restored.banking.snapshots).toEqual(sim.state.banking.snapshots);
    expect(checkInvariants(restored)).toEqual([]);
  });
});
