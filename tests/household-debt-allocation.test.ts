// v0.7 验收问题 6：居民群体变化（就业/失业/职业变动/并组拆分/跨城迁移）时的债务归属守恒。
//
// 断言口径（任务书 + SIM_FISCAL_IMPL_DESIGN_v1.md §3.5）：
// - 任何人数变化前后，Σ 未偿本金、Σ 欠付本金、Σ 欠付利息不变（分位精确，容差 0.01）；
// - 转移不是还款：payments 不追加、paidPrincipal/paidInterest 不变；
// - 合同 principal − paidPrincipal === outstanding 保持；
// - 群体人数归零不得静默把债务留在无人群体：并组或显式隔离（日志 + 合同 note）。
import { describe, expect, it } from 'vitest';
import { DEMO_CONFIG } from '../src/data/config';
import { checkInvariants } from '../src/simulation/core/invariants';
import { round2 } from '../src/simulation/core/math';
import { parseSave, serializeSave } from '../src/simulation/core/save';
import { Simulation } from '../src/simulation/core/simulation';
import type {
  City,
  HouseholdGroup,
  HouseholdLoanContract,
  OccupationClass,
  WorldState,
} from '../src/simulation/contracts/types';
import {
  borrowForConsumption,
  transferHouseholdDebtsForMigration,
} from '../src/simulation/population/household-finance';
import {
  householdGroupOf,
  householdGroupsOfCity,
  occupationPeople,
  syncHouseholdPeople,
} from '../src/simulation/population/household-groups';
import { setCityPopulation } from '../src/simulation/population/population';

const CONFIG = DEMO_CONFIG;
const TOLERANCE = 0.01;

function newWorld(months = 0): WorldState {
  const sim = Simulation.create();
  for (let index = 0; index < months; index += 1) {
    const result = sim.tick();
    if (!result.ok) throw new Error(result.error);
  }
  return sim.state;
}

function cityOf(world: WorldState, index = 0): City {
  const city = world.cities[index];
  if (!city) throw new Error(`缺少城市 #${index}`);
  return city;
}

function groupOf(world: WorldState, cityId: string, occupation: OccupationClass): HouseholdGroup {
  const group = householdGroupOf(world, cityId, occupation);
  if (!group) throw new Error(`缺少居民群体 ${cityId}/${occupation}`);
  return group;
}

function loans(world: WorldState): HouseholdLoanContract[] {
  return world.householdFinance?.loans ?? [];
}

function sumField(
  world: WorldState,
  field: 'outstanding' | 'arrearsPrincipal' | 'arrearsInterest',
): number {
  return round2(loans(world).reduce((sum, loan) => sum + loan[field], 0));
}

function expectMoney(actual: number, expected: number, message?: string): void {
  expect(Math.abs(actual - expected), message ?? `${actual} != ${expected}`).toBeLessThanOrEqual(
    TOLERANCE,
  );
}

/** 只转移、不还款：所有既有合同的还款记录必须原样保留。 */
function paymentFingerprints(world: WorldState): Map<string, string> {
  const fingerprints = new Map<string, string>();
  for (const loan of loans(world)) {
    fingerprints.set(
      loan.id,
      JSON.stringify({
        paidPrincipal: loan.paidPrincipal,
        paidInterest: loan.paidInterest,
        payments: loan.payments,
      }),
    );
  }
  return fingerprints;
}

function expectPaymentsUntouched(world: WorldState, before: Map<string, string>): void {
  for (const [id, snapshot] of before) {
    const loan = loans(world).find((entry) => entry.id === id);
    expect(loan, `原有合同 ${id} 不应消失`).toBeDefined();
    const parsed = JSON.parse(snapshot) as {
      paidPrincipal: number;
      paidInterest: number;
      payments: unknown[];
    };
    expect(loan!.paidPrincipal, `合同 ${id} 的 paidPrincipal 被改写（转移被误记为还款）`).toBe(
      parsed.paidPrincipal,
    );
    expect(loan!.paidInterest, `合同 ${id} 的 paidInterest 被改写`).toBe(parsed.paidInterest);
    expect(loan!.payments, `合同 ${id} 的还款流水被改写`).toEqual(parsed.payments);
  }
}

function principalIdentityProblems(world: WorldState): string[] {
  const problems: string[] = [];
  for (const loan of loans(world)) {
    if (Math.abs(loan.principal - round2(loan.paidPrincipal + loan.outstanding)) > TOLERANCE) {
      problems.push(`${loan.id}: ${loan.principal} != ${loan.paidPrincipal} + ${loan.outstanding}`);
    }
  }
  return problems;
}

function expectPrincipalIdentity(world: WorldState): void {
  expect(principalIdentityProblems(world)).toEqual([]);
}

/** 在指定群体上造一笔消费贷（先给足财产基准，额度不成为阻碍）。 */
function seedLoan(world: WorldState, group: HouseholdGroup, amount = 2_000): HouseholdLoanContract {
  group.cash = round2(group.cash + 100_000);
  const result = borrowForConsumption(world, group, CONFIG, amount, world.time.tick);
  expect(result.ok, result.error).toBe(true);
  const loan = result.loan;
  if (!loan) throw new Error('放款成功但未返回合同');
  return loan;
}

function loanSignature(world: WorldState): Map<string, string> {
  const signature = new Map<string, string>();
  for (const loan of loans(world)) {
    signature.set(
      loan.id,
      JSON.stringify({
        groupId: loan.groupId,
        cityId: loan.cityId,
        status: loan.status,
        principal: loan.principal,
        outstanding: loan.outstanding,
        arrearsPrincipal: loan.arrearsPrincipal,
        arrearsInterest: loan.arrearsInterest,
        paidPrincipal: loan.paidPrincipal,
        paidInterest: loan.paidInterest,
        payments: loan.payments,
      }),
    );
  }
  return signature;
}

describe('城内群体人数变化：债务按人均随人走', () => {
  it('部分转移（失业→非劳动力）：未偿/欠息守恒，只转不还，人均债务不跳变', () => {
    const world = newWorld();
    const city = cityOf(world);
    const source = groupOf(world, city.id, 'unemployed');
    const destination = groupOf(world, city.id, 'nonLabor');
    const amount = 3_000;
    const loan = seedLoan(world, source, amount);
    const sourcePeopleBefore = source.people;
    const destinationPeopleBefore = destination.people;
    const beforeOutstanding = sumField(world, 'outstanding');
    const beforeArrearsPrincipal = sumField(world, 'arrearsPrincipal');
    const beforeArrearsInterest = sumField(world, 'arrearsInterest');
    const fingerprints = paymentFingerprints(world);
    expect(loan.outstanding).toBeCloseTo(amount, 2);

    const leaving = Math.max(1, Math.floor(sourcePeopleBefore / 4));
    const share = leaving / sourcePeopleBefore;
    setCityPopulation(
      city,
      city.population.total,
      city.population.laborForce - leaving,
      city.population.employed,
    );
    syncHouseholdPeople(world, CONFIG);

    // 人数按权威数据写回：源群体减少、目标群体等量增加，城市总人口不变。
    expect(groupOf(world, city.id, 'unemployed').people).toBe(sourcePeopleBefore - leaving);
    expect(groupOf(world, city.id, 'nonLabor').people).toBe(destinationPeopleBefore + leaving);

    const moved = round2(amount * share);
    const sourceLoan = loans(world).find((entry) => entry.id === loan.id)!;
    const splitLoans = loans(world).filter(
      (entry) => entry.groupId === destination.id && entry.status === 'active',
    );
    expect(splitLoans.length).toBe(1);
    expectMoney(splitLoans[0]!.outstanding, moved);
    expectMoney(sourceLoan.outstanding, amount - moved);
    expectMoney(splitLoans[0]!.outstanding + sourceLoan.outstanding, amount);

    // 城内合计未偿本金与欠息不变。
    expectMoney(sumField(world, 'outstanding'), beforeOutstanding);
    expectMoney(sumField(world, 'arrearsPrincipal'), beforeArrearsPrincipal);
    expectMoney(sumField(world, 'arrearsInterest'), beforeArrearsInterest);

    // 转移不是还款：既有合同还款记录原样保留。
    expectPaymentsUntouched(world, fingerprints);
    expect(sourceLoan.payments).toHaveLength(0);
    expectPrincipalIdentity(world);

    // 人均债务随人走：源群体剩余人均未偿 ≈ 转移前人均。
    const perCapitaAfter = sourceLoan.outstanding / groupOf(world, city.id, 'unemployed').people;
    expect(Math.abs(perCapitaAfter - amount / sourcePeopleBefore)).toBeLessThan(0.02);
  });

  it('非劳动力→就业（职业变化）：债务由就业群体承接，人数与债务同步', () => {
    const world = newWorld();
    const city = cityOf(world);
    const source = groupOf(world, city.id, 'nonLabor');
    const company = world.companies.find((entry) => entry.cityId === city.id);
    if (!company) throw new Error('城市缺少企业');
    const sourcePeopleBefore = source.people;
    const productionPeopleBefore = groupOf(world, city.id, 'production').people;
    const hired = Math.max(3, Math.floor(sourcePeopleBefore / 5));
    const amount = 1_200;
    const loan = seedLoan(world, source, amount);
    const beforeOutstanding = sumField(world, 'outstanding');
    const fingerprints = paymentFingerprints(world);

    company.roles.production = (company.roles.production ?? 0) + hired;
    company.employees += hired;
    setCityPopulation(
      city,
      city.population.total,
      city.population.laborForce + hired,
      city.population.employed + hired,
    );
    expect(checkInvariants(world)).toEqual([]);
    syncHouseholdPeople(world, CONFIG);

    const hiredGroup = groupOf(world, city.id, 'production');
    expect(hiredGroup.people).toBe(productionPeopleBefore + hired);
    expect(groupOf(world, city.id, 'nonLabor').people).toBe(sourcePeopleBefore - hired);
    const moved = round2(amount * (hired / sourcePeopleBefore));
    const splitLoans = loans(world).filter((entry) => entry.groupId === hiredGroup.id);
    expect(splitLoans.length).toBe(1);
    expectMoney(splitLoans[0]!.outstanding, moved, '非劳动力→就业的债务承接金额');
    expectMoney(loans(world).find((entry) => entry.id === loan.id)!.outstanding, amount - moved);
    expectMoney(sumField(world, 'outstanding'), beforeOutstanding);
    expectPaymentsUntouched(world, fingerprints);
    expectPrincipalIdentity(world);
  });

  it('多接收方（非劳动力→生产/销售/失业同时增加）：按新增人数权重精确拆分', () => {
    const world = newWorld();
    const city = cityOf(world);
    const source = groupOf(world, city.id, 'nonLabor');
    const company = world.companies.find((entry) => entry.cityId === city.id);
    if (!company) throw new Error('城市缺少企业');
    const sourcePeopleBefore = source.people;
    const amount = 2_400;
    const loan = seedLoan(world, source, amount);
    const beforeOutstanding = sumField(world, 'outstanding');
    const fingerprints = paymentFingerprints(world);

    const leavingLaborForce = Math.max(6, Math.floor(sourcePeopleBefore / 4));
    const toProduction = Math.max(2, Math.floor(leavingLaborForce / 2));
    const toSales = Math.max(1, Math.floor(leavingLaborForce / 3));
    const toUnemployed = leavingLaborForce - toProduction - toSales;
    expect(toUnemployed).toBeGreaterThan(0);
    company.roles.production = (company.roles.production ?? 0) + toProduction;
    company.roles.sales = (company.roles.sales ?? 0) + toSales;
    company.employees += toProduction + toSales;
    setCityPopulation(
      city,
      city.population.total,
      city.population.laborForce + leavingLaborForce,
      city.population.employed + toProduction + toSales,
    );
    expect(checkInvariants(world)).toEqual([]);
    syncHouseholdPeople(world, CONFIG);

    const moved = round2(amount * (leavingLaborForce / sourcePeopleBefore));
    const destinations: { occupation: OccupationClass; delta: number }[] = [
      { occupation: 'production', delta: toProduction },
      { occupation: 'sales', delta: toSales },
      { occupation: 'unemployed', delta: toUnemployed },
    ];
    let received = 0;
    for (const entry of destinations) {
      const group = groupOf(world, city.id, entry.occupation);
      const groupLoans = loans(world).filter((loan) => loan.groupId === group.id);
      expect(groupLoans.length, `${entry.occupation} 应收到拆分合同`).toBeGreaterThanOrEqual(1);
      for (const split of groupLoans) received += split.outstanding;
    }
    expectMoney(received, moved, '多接收方合计承接的未偿本金');
    expectMoney(
      loans(world).find((entry) => entry.id === loan.id)!.outstanding,
      amount - moved,
    );
    expectMoney(sumField(world, 'outstanding'), beforeOutstanding);
    expectPaymentsUntouched(world, fingerprints);
    expectPrincipalIdentity(world);
  });

  it('群体人数降为 0 且唯一接收方：整群改挂归属，不改还款历史、不标记已还款', () => {
    const world = newWorld();
    const city = cityOf(world);
    const source = groupOf(world, city.id, 'unemployed');
    const company = world.companies.find((entry) => entry.cityId === city.id);
    if (!company) throw new Error('城市缺少企业');
    const peopleBefore = source.people;
    const productionPeopleBefore = groupOf(world, city.id, 'production').people;
    const amount = 800;
    const loan = seedLoan(world, source, amount);
    const beforeOutstanding = sumField(world, 'outstanding');
    const fingerprints = paymentFingerprints(world);

    company.roles.production = (company.roles.production ?? 0) + peopleBefore;
    company.employees += peopleBefore;
    setCityPopulation(
      city,
      city.population.total,
      city.population.laborForce,
      city.population.employed + peopleBefore,
    );
    expect(checkInvariants(world)).toEqual([]);
    syncHouseholdPeople(world, CONFIG);

    expect(groupOf(world, city.id, 'unemployed').people).toBe(0);
    const destination = groupOf(world, city.id, 'production');
    expect(destination.people).toBe(productionPeopleBefore + peopleBefore);
    const reassigned = loans(world).find((entry) => entry.id === loan.id)!;
    expect(reassigned.groupId).toBe(destination.id);
    expect(reassigned.status, '整群改挂不得把源合同标记为已还款').toBe('active');
    expectMoney(reassigned.outstanding, amount);
    expectMoney(reassigned.principal, amount);
    expect(reassigned.payments).toHaveLength(0);
    expectMoney(sumField(world, 'outstanding'), beforeOutstanding);
    expectPaymentsUntouched(world, fingerprints);
    expectPrincipalIdentity(world);
  });

  it('重复同步幂等：人数未再变化时不会重复拆分债务', () => {
    const world = newWorld();
    const city = cityOf(world);
    const source = groupOf(world, city.id, 'nonLabor');
    const company = world.companies.find((entry) => entry.cityId === city.id);
    if (!company) throw new Error('城市缺少企业');
    seedLoan(world, source, 1_000);
    const hired = Math.max(2, Math.floor(source.people / 8));
    company.roles.production = (company.roles.production ?? 0) + hired;
    company.employees += hired;
    setCityPopulation(
      city,
      city.population.total,
      city.population.laborForce + hired,
      city.population.employed + hired,
    );
    syncHouseholdPeople(world, CONFIG);
    const afterFirst = loans(world)
      .map((loan) => `${loan.id}|${loan.groupId}|${loan.outstanding}|${loan.principal}`)
      .sort();
    const totalAfterFirst = sumField(world, 'outstanding');

    syncHouseholdPeople(world, CONFIG);
    const afterSecond = loans(world)
      .map((loan) => `${loan.id}|${loan.groupId}|${loan.outstanding}|${loan.principal}`)
      .sort();
    expect(afterSecond).toEqual(afterFirst);
    expectMoney(sumField(world, 'outstanding'), totalAfterFirst);
    expectPrincipalIdentity(world);
  });
});

describe('债务兜底与隔离：群体已无人', () => {
  it('人数归零且无接收方：并入同城人数最多的群体并记日志', () => {
    const world = newWorld();
    const city = cityOf(world);
    const source = groupOf(world, city.id, 'publicSector');
    const peopleBefore = source.people;
    expect(peopleBefore).toBeGreaterThan(0);
    const amount = 600;
    const loan = seedLoan(world, source, amount);
    const fingerprints = paymentFingerprints(world);
    const beforeOutstanding = sumField(world, 'outstanding');

    // 模拟公共部门全员消失（死亡/迁出）：岗位与总人口同步减少，其他群体人数不变，
    // 因此本轮没有任何“接收方”，必须走兜底并组。
    city.publicSector.employees = 0;
    setCityPopulation(
      city,
      city.population.total - peopleBefore,
      city.population.laborForce - peopleBefore,
      city.population.employed - peopleBefore,
    );
    const logStart = world.log.length;
    syncHouseholdPeople(world, CONFIG);

    expect(checkInvariants(world)).toEqual([]);
    expect(groupOf(world, city.id, 'publicSector').people).toBe(0);
    const expectedFallback = householdGroupsOfCity(world, city.id)
      .map((group) => ({ group, people: occupationPeople(world, city, group.occupation) }))
      .filter((entry) => entry.people > 0)
      .sort((a, b) => b.people - a.people || a.group.id.localeCompare(b.group.id))[0]?.group;
    expect(expectedFallback).toBeDefined();
    const moved = loans(world).find((entry) => entry.id === loan.id)!;
    expect(moved.groupId).toBe(expectedFallback!.id);
    expectMoney(moved.outstanding, amount);
    expectMoney(sumField(world, 'outstanding'), beforeOutstanding);
    expectPaymentsUntouched(world, fingerprints);
    expectPrincipalIdentity(world);
    const freshLogs = world.log.slice(logStart);
    expect(freshLogs.some((entry) => entry.message.includes('人数归零'))).toBe(true);
  });

  it('同城已无任何在册人口：不删除债务，显式隔离并写 warning 日志', () => {
    const world = newWorld();
    const city = cityOf(world);
    const source = groupOf(world, city.id, 'unemployed');
    const amount = 500;
    const loan = seedLoan(world, source, amount);
    const fingerprints = paymentFingerprints(world);
    const beforeOutstanding = sumField(world, 'outstanding');

    // 全城居民清零：没有任何群体可承接债务。
    for (const company of world.companies.filter((entry) => entry.cityId === city.id)) {
      company.roles = { management: 0, production: 0, sales: 0, research: 0 };
      company.employees = 0;
    }
    city.publicSector.employees = 0;
    setCityPopulation(city, 0, 0, 0);
    const logStart = world.log.length;
    syncHouseholdPeople(world, CONFIG);

    const isolated = loans(world).find((entry) => entry.id === loan.id)!;
    expect(isolated.groupId, '无接收方时不得改挂到不存在的群体').toBe(source.id);
    expect(isolated.note).toContain('【隔离】');
    expectMoney(isolated.outstanding, amount);
    expectMoney(sumField(world, 'outstanding'), beforeOutstanding);
    expectPaymentsUntouched(world, fingerprints);
    const freshLogs = world.log.slice(logStart);
    expect(
      freshLogs.some(
        (entry) =>
          entry.kind === 'warning' &&
          entry.message.includes('显式隔离') &&
          entry.message.includes(loan.id),
      ),
    ).toBe(true);
  });
});

describe('跨城迁移：未偿本金与欠息守恒', () => {
  it('部分迁移：按迁出人数比例拆分债务，不产生现金、不记为还款', () => {
    const world = newWorld();
    const from = cityOf(world, 0);
    const to = cityOf(world, 1);
    const source = groupOf(world, from.id, 'unemployed');
    const destination = groupOf(world, to.id, 'unemployed');
    const amount = 1_000;
    const loan = seedLoan(world, source, amount);
    const moving = Math.max(1, Math.floor(source.people / 3));
    const expectedMoved = round2(amount * (moving / source.people));
    const beforeOutstanding = sumField(world, 'outstanding');
    const beforeArrearsPrincipal = sumField(world, 'arrearsPrincipal');
    const beforeArrearsInterest = sumField(world, 'arrearsInterest');
    const beforeCash = world.households.groups.reduce((sum, group) => sum + group.cash, 0);
    const fingerprints = paymentFingerprints(world);

    const result = transferHouseholdDebtsForMigration(
      world,
      CONFIG,
      from.id,
      to.id,
      moving,
      moving,
      world.time.tick,
    );
    expect(result.loansMoved).toBeGreaterThanOrEqual(1);
    expectMoney(result.principalMoved, expectedMoved);

    const sourceLoan = loans(world).find((entry) => entry.id === loan.id)!;
    const splitLoans = loans(world).filter((entry) => entry.groupId === destination.id);
    expect(splitLoans.length).toBe(1);
    expectMoney(splitLoans[0]!.outstanding, expectedMoved);
    expectMoney(sourceLoan.outstanding, amount - expectedMoved);
    expectMoney(splitLoans[0]!.principal, splitLoans[0]!.outstanding);
    expect(splitLoans[0]!.paidPrincipal).toBe(0);
    expect(splitLoans[0]!.payments).toHaveLength(0);
    expectMoney(sumField(world, 'outstanding'), beforeOutstanding);
    expectMoney(sumField(world, 'arrearsPrincipal'), beforeArrearsPrincipal);
    expectMoney(sumField(world, 'arrearsInterest'), beforeArrearsInterest);
    expectPaymentsUntouched(world, fingerprints);
    expectPrincipalIdentity(world);
    expectMoney(
      world.households.groups.reduce((sum, group) => sum + group.cash, 0),
      beforeCash,
    );
  });

  it('整群迁移：合同改挂目标城，状态与还款记录原样保留', () => {
    const world = newWorld();
    const from = cityOf(world, 0);
    const to = cityOf(world, 1);
    const source = groupOf(world, from.id, 'unemployed');
    const destination = groupOf(world, to.id, 'unemployed');
    const amount = 700;
    const loan = seedLoan(world, source, amount);
    const beforeOutstanding = sumField(world, 'outstanding');
    const fingerprints = paymentFingerprints(world);

    const result = transferHouseholdDebtsForMigration(
      world,
      CONFIG,
      from.id,
      to.id,
      source.people,
      source.people,
      world.time.tick,
    );
    expect(result.loansMoved).toBeGreaterThanOrEqual(1);
    const moved = loans(world).find((entry) => entry.id === loan.id)!;
    expect(moved.groupId).toBe(destination.id);
    expect(moved.cityId).toBe(to.id);
    expect(moved.status).toBe('active');
    expectMoney(moved.outstanding, amount);
    expect(moved.payments).toHaveLength(0);
    expectMoney(sumField(world, 'outstanding'), beforeOutstanding);
    expectPaymentsUntouched(world, fingerprints);
    expectPrincipalIdentity(world);
  });

  it('迁移后存档往返：债务归属、金额与还款记录保持一致', () => {
    const world = newWorld();
    const from = cityOf(world, 0);
    const to = cityOf(world, 1);
    const source = groupOf(world, from.id, 'unemployed');
    seedLoan(world, source, 900);
    const moving = Math.max(1, Math.floor(source.people / 2));
    transferHouseholdDebtsForMigration(
      world,
      CONFIG,
      from.id,
      to.id,
      moving,
      moving,
      world.time.tick,
    );

    const parsed = parseSave(serializeSave(world));
    expect(parsed.ok, parsed.ok ? '' : parsed.error).toBe(true);
    const loaded = parsed.world!;
    expect(checkInvariants(loaded)).toEqual([]);
    expect(loanSignature(loaded)).toEqual(loanSignature(world));
    expectMoney(sumField(loaded, 'outstanding'), sumField(world, 'outstanding'));
    expectPrincipalIdentity(loaded);
  });
});

describe('存档往返与不变量', () => {
  it('城内再分配后存档往返：群体人数/债务/还款记录一致，不变量为空', () => {
    const world = newWorld();
    const city = cityOf(world);
    const source = groupOf(world, city.id, 'nonLabor');
    const company = world.companies.find((entry) => entry.cityId === city.id);
    if (!company) throw new Error('城市缺少企业');
    seedLoan(world, source, 1_500);
    const hired = Math.max(2, Math.floor(source.people / 6));
    company.roles.production = (company.roles.production ?? 0) + hired;
    company.employees += hired;
    setCityPopulation(
      city,
      city.population.total,
      city.population.laborForce + hired,
      city.population.employed + hired,
    );
    syncHouseholdPeople(world, CONFIG);

    const parsed = parseSave(serializeSave(world));
    expect(parsed.ok, parsed.ok ? '' : parsed.error).toBe(true);
    const loaded = parsed.world!;
    expect(checkInvariants(loaded)).toEqual([]);
    expect(loanSignature(loaded)).toEqual(loanSignature(world));
    const groupSignature = (state: WorldState): string =>
      JSON.stringify(
        state.households.groups
          .map((group) => ({
            id: group.id,
            people: group.people,
            cash: round2(group.cash),
          }))
          .sort((a, b) => a.id.localeCompare(b.id)),
      );
    expect(groupSignature(loaded)).toBe(groupSignature(world));
    expectPrincipalIdentity(loaded);
  });
});
