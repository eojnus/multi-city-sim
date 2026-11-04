// v1.0 开局企业观察脚本（Lead task-22 报告数据）
// 运行：npx tsx scripts/opening-v1-report.ts
// 输出：各城开局企业数量/行业分布/岗位/就业率/设备与主要商品产能、世界设备厂清单与单位经济。
import { Simulation } from '../src/simulation/core/simulation';
import { DEMO_CONFIG } from '../src/data/config';
import { CITY_SEEDS, COMPANY_SEEDS, GOODS, OPENING_COMPANIES, PRODUCTIVITY } from '../src/data/demo-data';
import {
  equipmentCapacityPerUnit,
  equipmentKindForSector,
} from '../src/simulation/equipment/equipment';
import { checkInvariants } from '../src/simulation/core/invariants';
import { round2 } from '../src/simulation/core/math';

const KINDS = ['farm', 'industry', 'energy'] as const;
const goodName = (id: string) => GOODS.find((good) => good.id === id)?.name ?? id;
const openingIds = new Set(OPENING_COMPANIES.map((seed) => seed.id));
const baselineIds = new Set(COMPANY_SEEDS.map((seed) => seed.id));

const world = Simulation.create(DEMO_CONFIG).state;
const cityOf = (id: string) => world.cities.find((city) => city.id === id)!;

console.log('=== v1.0 开局（新世界）===');
console.log(`企业总数：${world.companies.length}（原有 ${COMPANY_SEEDS.length} + 新增 ${OPENING_COMPANIES.length}）`);
console.log(`不变量：${checkInvariants(world).length === 0 ? '通过' : checkInvariants(world).join('；')}`);
console.log('');

for (const seed of CITY_SEEDS) {
  const city = cityOf(seed.id);
  const companies = world.companies.filter((company) => company.cityId === seed.id);
  const opening = companies.filter((company) => openingIds.has(company.id));
  const baseline = companies.filter((company) => baselineIds.has(company.id));
  const privateJobs = companies.reduce((sum, company) => sum + company.employees, 0);
  const openingJobs = opening.reduce((sum, company) => sum + company.employees, 0);
  const unemploymentRate = round2((city.population.unemployed / city.population.laborForce) * 100);

  console.log(`## ${city.name}（${seed.id}）`);
  console.log(
    `人口：总 ${city.population.total}｜就业 ${city.population.employed}（公共 ${city.publicSector.employees} + 私营 ${privateJobs}）｜失业 ${city.population.unemployed}｜非劳动 ${city.population.nonLabor}｜劳动力 ${city.population.laborForce}｜失业率 ${unemploymentRate}%`,
  );
  console.log(
    `企业：${companies.length} 家（原有 ${baseline.length} + 新增 ${opening.length}）｜新增岗位 ${openingJobs}｜原 ${privateJobs - openingJobs}`,
  );

  const byOutput = new Map<string, number>();
  for (const company of companies) {
    byOutput.set(company.recipeOutput, (byOutput.get(company.recipeOutput) ?? 0) + 1);
  }
  console.log(
    '行业分布：' +
      [...byOutput.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([output, count]) => `${goodName(output)}×${count}`)
        .join('｜'),
  );

  for (const kind of KINDS) {
    const units = companies.reduce((sum, company) => sum + company.equipment[kind], 0);
    console.log(`设备（${kind}）：${units} 台`);
  }

  const capacityByOutput = new Map<string, number>();
  for (const company of companies) {
    capacityByOutput.set(
      company.recipeOutput,
      (capacityByOutput.get(company.recipeOutput) ?? 0) + company.capacity,
    );
  }
  const utilization = (output: string) => {
    const units = companies
      .filter((company) => company.recipeOutput === output)
      .reduce((sum, company) => sum + company.employees, 0);
    return units;
  };
  console.log(
    '产能（单位/月）：' +
      [...capacityByOutput.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(
          ([output, capacity]) =>
            `${goodName(output)} ${Math.round(capacity)}（员工 ${utilization(output)}）`,
        )
        .join('｜'),
  );

  const monthlyWage = world.companies
    .filter((company) => company.cityId === seed.id)
    .reduce((sum, company) => sum + company.employees * company.wageRate, 0);
  const openingCash = opening.reduce((sum, company) => sum + company.cash, 0);
  console.log(`工资账单：${Math.round(monthlyWage)}｜新增企业现金：${Math.round(openingCash)}`);
  console.log('');
}

console.log('=== 新增设备制造企业（世界 9 家）===');
for (const company of world.companies.filter((entry) => openingIds.has(entry.id) && entry.sector === 'equipment')) {
  const city = cityOf(company.cityId);
  const kind = equipmentKindForSector(company.sector, DEMO_CONFIG);
  const perUnit = equipmentCapacityPerUnit(DEMO_CONFIG, kind, company.recipeOutput);
  console.log(
    `${company.name}（${city.name}）：员工 ${company.employees}｜设备 ${company.equipment[kind]} 台（${kind}）｜产能 ${Math.round(company.capacity)} 台/月（每台设备 ${perUnit} 台/月 × 技术 ${city.technology.productivityMultiplier.toFixed(3)}）｜现金 ${Math.round(company.cash)}｜人均月产量 ${PRODUCTIVITY[company.recipeOutput]}`,
  );
}

console.log('');
console.log('=== 新增企业清单（48 家）===');
for (const seed of OPENING_COMPANIES) {
  const company = world.companies.find((entry) => entry.id === seed.id)!;
  const kind = equipmentKindForSector(company.sector, DEMO_CONFIG);
  console.log(
    `${company.id.padEnd(22)} ${company.name.padEnd(10)} ${goodName(company.recipeOutput).padEnd(6)} 员工 ${String(company.employees).padStart(5)}｜设备 ${company.equipment[kind]}｜产能 ${Math.round(company.capacity)}｜现金 ${Math.round(company.cash)}｜库存 ${Math.round(company.inventory[company.recipeOutput] ?? 0)}`,
  );
}
