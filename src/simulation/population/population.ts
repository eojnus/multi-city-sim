import type { City, WorldState, LogEntry } from '../contracts/types';
import type { DemoConfig } from '../../data/config';
import { clamp, round2 } from '../core/math';
import type { DeterministicRng } from '../core/rng';
import { rebalanceHouseholdWealthForMigration } from './household-groups';
import { transferHouseholdDebtsForMigration } from './household-finance';

export function setCityPopulation(
  city: City,
  total: number,
  laborForce: number,
  employed: number,
): void {
  const populationTotal = Math.max(0, Math.round(total));
  const lf = clamp(Math.round(laborForce), 0, populationTotal);
  const emp = clamp(Math.round(employed), 0, lf);
  city.population = {
    total: populationTotal,
    laborForce: lf,
    employed: emp,
    unemployed: lf - emp,
    nonLabor: populationTotal - lf,
  };
}

export function cityEmployedFromAllocations(city: City, companies: WorldState['companies']): number {
  let employed = city.publicSector.employees;
  for (const company of companies) {
    if (company.cityId === city.id) employed += company.employees;
  }
  return employed;
}

export function syncCityPopulationFromAllocations(city: City, world: WorldState): void {
  const employed = cityEmployedFromAllocations(city, world.companies);
  setCityPopulation(city, city.population.total, city.population.laborForce, employed);
}

export function laborForceFor(total: number, participationRate: number): number {
  return Math.round(total * participationRate);
}

export function unemploymentRate(city: City): number {
  const lf = city.population.laborForce;
  return lf <= 0 ? 0 : city.population.unemployed / lf;
}

export function averageWage(city: City, world: WorldState): number {
  let wage = city.publicSector.employees * city.publicSector.wageRate;
  let people = city.publicSector.employees;
  for (const company of world.companies) {
    if (company.cityId !== city.id) continue;
    wage += company.employees * company.wageRate;
    people += company.employees;
  }
  return people === 0 ? 0 : round2(wage / people);
}

export function cityVacancies(city: City, world: WorldState): number {
  let vacancies = Math.max(0, city.publicSector.jobs - city.publicSector.employees);
  for (const company of world.companies) {
    if (company.cityId === city.id) vacancies += Math.max(0, company.jobDemand - company.employees);
  }
  return vacancies;
}

export function migrationAttractiveness(city: City, world: WorldState, config: DemoConfig): number {
  const avg = averageWage(city, world);
  const homeCost = city.realEstate.avgHomePrice / 50_000;
  // 政治支持率越高表示治理越好，应提高迁入吸引力（演示假设，不是最终规则）。
  return round2(
    -unemploymentRate(city) * 100 +
      avg / 1000 -
      homeCost +
      city.politics.approval * config.population.approvalMigrationWeight,
  );
}

export function applyNaturalGrowth(
  world: WorldState,
  rng: DeterministicRng,
  config: DemoConfig,
  log: LogEntry[],
): void {
  for (const city of world.cities) {
    const base =
      city.population.total *
      (config.population.monthlyBirthRate - config.population.monthlyDeathRate);
    const noise =
      city.population.total *
      config.population.naturalNoise *
      (rng.next() * 2 - 1);
    const change = Math.round(base + noise);
    const nextTotal = Math.max(0, city.population.total + change);
    const nextLaborForce = clamp(
      laborForceFor(nextTotal, config.population.participationRate),
      city.population.employed,
      nextTotal,
    );
    const before = city.population.total;
    setCityPopulation(city, nextTotal, nextLaborForce, city.population.employed);
    if (Math.abs(change) >= 1) {
      log.push({
        tick: world.time.tick,
        kind: 'population',
        message: `${city.name} 自然人口变动 ${change > 0 ? '+' : ''}${change}（${before} → ${nextTotal}）。`,
      });
    }
  }
}

export function applyMigration(
  world: WorldState,
  rng: DeterministicRng,
  config: DemoConfig,
  log: LogEntry[],
): void {
  const scores = new Map<string, number>();
  for (const city of world.cities) {
    scores.set(city.id, migrationAttractiveness(city, world, config));
  }
  const sources = [...world.cities].sort(
    (a, b) => (scores.get(a.id) ?? 0) - (scores.get(b.id) ?? 0) || a.id.localeCompare(b.id),
  );
  const destinations = [...world.cities].sort(
    (a, b) => (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0) || a.id.localeCompare(b.id),
  );

  for (const source of sources) {
    const destination = destinations.find((candidate) => candidate.id !== source.id);
    if (!destination) continue;
    const sourceScore = scores.get(source.id) ?? 0;
    const destScore = scores.get(destination.id) ?? 0;
    if (destScore - sourceScore < config.population.migrationScoreGap) continue;
    if (source.population.unemployed <= 0) continue;

    const vacancies = cityVacancies(destination, world);
    if (vacancies < config.population.migrationMinVacancies) continue;

    const desired = Math.min(
      Math.floor(source.population.total * config.population.migrationBaseRate),
      Math.floor(source.population.unemployed * 0.05),
      Math.floor(vacancies * 0.3),
    );
    const jitter = rng.next() < 0.35 ? 1 : 0;
    const people = Math.max(0, desired - jitter);
    if (people < 1) continue;

    // 原子迁移：先计算全部结果并验证，再一次性提交。
    const nextSourceTotal = source.population.total - people;
    const nextDestTotal = destination.population.total + people;
    if (nextSourceTotal < source.population.employed) continue;
    const laborForceMoved = Math.min(
      Math.round(people * config.population.migrationLaborShare),
      source.population.laborForce - source.population.employed,
      people,
    );
    const nextSourceLf = source.population.laborForce - laborForceMoved;
    const nextDestLf = destination.population.laborForce + laborForceMoved;
    if (nextSourceLf < source.population.employed) continue;

    setCityPopulation(
      source,
      nextSourceTotal,
      nextSourceLf,
      source.population.employed,
    );
    setCityPopulation(
      destination,
      nextDestTotal,
      nextDestLf,
      destination.population.employed,
    );

    // v0.4：迁移者带走其人均现金与存款（跨城资产跟随人口，不复制也不丢失）；
    // 按 laborForceMoved 拆成 unemployed / nonLabor 两个群体分别转移，并确保目标账户存在。
    rebalanceHouseholdWealthForMigration(
      world,
      source.id,
      destination.id,
      people,
      laborForceMoved,
      config,
      world.time.tick,
    );
    // 消费贷款随人口迁移：迁移者按人均带走自己那部分未偿债务，两城合计债务守恒。
    transferHouseholdDebtsForMigration(
      world,
      config,
      source.id,
      destination.id,
      people,
      laborForceMoved,
      world.time.tick,
    );

    world.lastTick.migration.push({
      fromCityId: source.id,
      toCityId: destination.id,
      people,
      laborForce: laborForceMoved,
    });
    log.push({
      tick: world.time.tick,
      kind: 'population',
      message: `${source.name} → ${destination.name} 迁移 ${people} 人（其中劳动力 ${laborForceMoved} 人）。`,
    });
  }
}

export interface HouseholdGroupWeights {
  employed: number;
  unemployed: number;
  nonLabor: number;
  total: number;
}

export function householdGroupWeights(city: City, config: DemoConfig): HouseholdGroupWeights {
  const employed = city.population.employed * config.consumer.employedNeedFactor;
  const unemployed = city.population.unemployed * config.consumer.unemployedNeedFactor;
  const nonLabor = city.population.nonLabor * config.consumer.nonLaborNeedFactor;
  return { employed, unemployed, nonLabor, total: employed + unemployed + nonLabor };
}
