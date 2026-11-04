// v1.0 设备单位经济标定表（只读：不修改规则、不写存档）。
//
// 用法：npx tsx scripts/equipment-economics.ts
//
// 统一单位（task-23）：
// - 普通商品企业：每台设备每月提供 capacityPerUnit 个产出单位（被服务行业口径，首版 300,000）；
// - 资本品企业（设备厂）：每台设备每月提供 outputCapacityPerUnit[设备商品] 台/月；
// - 设备制造人均月产量 unitsPerWorkerMonth 写入 config.equipment.catalog[kind]，
//   demo-data 的 PRODUCTIVITY 与之对齐。
//
// 本表按“设备厂正常运作”口径（60 员工、initializer 反推的设备台数、满负荷）计算：
// 售价 − 金属/能源材料成本 − 按真实生产率折算的工资 − 其他 = 单位收益。

import { Simulation } from '../src/simulation/core/simulation';
import { DEMO_CONFIG } from '../src/data/config';
import { GOODS, PRODUCTIVITY, RECIPES } from '../src/data/demo-data';
import type { Company, EquipmentKind, GoodId, WorldState } from '../src/simulation/contracts/types';
import { monthlyWageBill } from '../src/simulation/companies/company';
import {
  derivedEquipmentCapacity,
  equipmentCapacityPerUnit,
  equipmentUnits,
} from '../src/simulation/equipment/equipment';

const KINDS: EquipmentKind[] = ['farm', 'industry', 'energy'];
const FACTORY_CITY = 'lanport';

function basePriceOf(goodId: GoodId): number {
  return GOODS.find((good) => good.id === goodId)?.basePrice ?? 0;
}

function findFactory(world: WorldState, output: GoodId): Company | undefined {
  return (
    world.companies.find(
      (company) => company.recipeOutput === output && company.cityId === FACTORY_CITY,
    ) ?? world.companies.find((company) => company.recipeOutput === output)
  );
}

function techOf(world: WorldState, cityId: string): number {
  return world.cities.find((city) => city.id === cityId)?.technology.productivityMultiplier ?? 1;
}

interface UnitEconomics {
  kind: EquipmentKind;
  name: string;
  goodId: GoodId;
  price: number;
  metalCost: number;
  energyCost: number;
  materialCost: number;
  workers: number;
  unitsPerWorkerMonth: number;
  laborCapacityFactor: number;
  outputPerMonth: number;
  laborLimit: number;
  wageBill: number;
  wagePerUnit: number;
  otherCost: number;
  unitProfit: number;
  margin: number;
  outputCapacityPerUnit: number;
  equipmentUnits: number;
  equipmentCapacity: number;
  machinesForNormalOutput: number;
  initialCash: number;
  initialCashWageMonths: number;
}

function measure(world: WorldState, kind: EquipmentKind): UnitEconomics {
  const catalog = DEMO_CONFIG.equipment.catalog[kind];
  const goodId = catalog.goodId;
  const recipe = RECIPES[goodId];
  const factory = findFactory(world, goodId);
  const workers = factory?.employees ?? 60;
  const tech = techOf(world, factory?.cityId ?? FACTORY_CITY);
  const laborCapacityFactor = DEMO_CONFIG.production.laborCapacityFactor;
  const wageBill = factory
    ? monthlyWageBill(factory, DEMO_CONFIG)
    : Math.round(workers * DEMO_CONFIG.labor.privateWageRate * 1.15);
  const unitsPerWorkerMonth = catalog.unitsPerWorkerMonth;
  const laborLimit = workers * unitsPerWorkerMonth * tech * laborCapacityFactor;
  const capacity = factory
    ? derivedEquipmentCapacity(world, factory, DEMO_CONFIG)
    : laborLimit;
  const outputPerMonth = Math.max(0.01, Math.min(capacity, laborLimit));
  const metalCost = (recipe?.inputs.find((input) => input.good === 'metal')?.qty ?? 0) * basePriceOf('metal');
  const energyCost = (recipe?.inputs.find((input) => input.good === 'energy')?.qty ?? 0) * basePriceOf('energy');
  const materialCost = metalCost + energyCost;
  const wagePerUnit = wageBill / outputPerMonth;
  const otherCost = 0;
  const unitProfit = catalog.price - materialCost - wagePerUnit - otherCost;
  const equipmentUnitsOfFactory = factory ? equipmentUnits(factory, 'industry') : 0;
  return {
    kind,
    name: catalog.name,
    goodId,
    price: catalog.price,
    metalCost,
    energyCost,
    materialCost,
    workers,
    unitsPerWorkerMonth,
    laborCapacityFactor,
    outputPerMonth,
    laborLimit,
    wageBill,
    wagePerUnit,
    otherCost,
    unitProfit,
    margin: unitProfit / catalog.price,
    outputCapacityPerUnit: equipmentCapacityPerUnit(DEMO_CONFIG, kind, goodId),
    equipmentUnits: equipmentUnitsOfFactory,
    equipmentCapacity: capacity,
    machinesForNormalOutput: Math.max(
      1,
      Math.ceil(laborLimit / Math.max(1, equipmentCapacityPerUnit(DEMO_CONFIG, kind, goodId) * tech)),
    ),
    initialCash: Math.round(wageBill * 4),
    initialCashWageMonths: 4,
  };
}

function money(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}

function table(rows: UnitEconomics[]): void {
  console.log('\n## 三类设备单位经济（60 员工设备厂、满负荷、开局原料/能源价格）\n');
  console.log(
    '| 设备 | 售价 | 金属成本 | 能源成本 | 材料合计 | 月产量(台) | 工资/台 | 单位收益 | 利润率 |',
  );
  console.log('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const row of rows) {
    console.log(
      `| ${row.name} | ${money(row.price)} | ${money(row.metalCost)} | ${money(row.energyCost)} | ${money(
        row.materialCost,
      )} | ${row.outputPerMonth.toFixed(2)} | ${money(row.wagePerUnit)} | ${money(
        row.unitProfit,
      )} | ${(row.margin * 100).toFixed(1)}% |`,
    );
  }

  console.log('\n## 产能口径\n');
  console.log('| 设备 | 普通商品企业：每台产能/月 | 资本品企业：每台产能/月 | 设备厂设备台数 | 设备厂产能/月 |');
  console.log('| --- | ---: | ---: | ---: | ---: |');
  for (const row of rows) {
    console.log(
      `| ${row.name} | ${money(DEMO_CONFIG.equipment.catalog[row.kind].capacityPerUnit)} 产出单位 | ${money(
        row.outputCapacityPerUnit,
      )} 台 | ${row.equipmentUnits} | ${row.equipmentCapacity.toFixed(2)} 台 |`,
    );
  }

  console.log('\n## 设备制造生产率与开局规模建议\n');
  console.log('| 设备 | 人均月产量(台) | 60 员工满负荷(台/月) | 正常产量所需设备台数 | 建议初始现金 |');
  console.log('| --- | ---: | ---: | ---: | ---: |');
  for (const row of rows) {
    console.log(
      `| ${row.name} | ${row.unitsPerWorkerMonth} | ${row.laborLimit.toFixed(2)} | ${row.machinesForNormalOutput} | ${money(row.initialCash)}（${row.initialCashWageMonths}×月工资） |`,
    );
  }
}

function main(): void {
  const simulation = Simulation.create();
  const world = simulation.state;
  const rows = KINDS.map((kind) => measure(world, kind));
  table(rows);
  const failing = rows.filter((row) => row.unitProfit <= 0 || row.margin < 0.1 || row.margin > 0.2);
  console.log(
    `\n利润率目标 10–20%：${failing.length === 0 ? '三类设备全部达标' : `未达标：${failing.map((row) => row.name).join('、')}`}。`,
  );
  console.log(`设备商品人均月产量（demo-data PRODUCTIVITY）：${JSON.stringify(PRODUCTIVITY.farmEquipment)} / ${PRODUCTIVITY.industryEquipment} / ${PRODUCTIVITY.energyEquipment}`);
}

main();
