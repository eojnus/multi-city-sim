import { Simulation } from '../src/simulation/core/simulation';
import { checkInvariants } from '../src/simulation/core/invariants';
import { formatMoney, formatNumber } from '../src/simulation/core/math';

const months = Number(process.argv[2] ?? 24);
const sim = Simulation.create();

console.log(`初始时间 ${sim.dateLabel}`);
console.log('初始不变量:', checkInvariants(sim.state));

for (let i = 0; i < months; i++) {
  const result = sim.tick();
  if (!result.ok) {
    console.error(`第 ${i + 1} 月失败: ${result.error}`);
    process.exit(1);
  }
}

const world = sim.state;
console.log(`\n推进 ${months} 月后：${sim.dateLabel}，tick ${world.time.tick}`);
for (const city of world.cities) {
  const p = city.population;
  console.log(
    `${city.name}: 人口 ${formatNumber(p.total)} | 就业 ${formatNumber(p.employed)} | 失业 ${formatNumber(p.unemployed)} (${((p.unemployed / p.laborForce) * 100).toFixed(1)}%) | 非劳动力 ${formatNumber(p.nonLabor)} | GDP ${formatMoney(city.gdp)} | 财政 ${formatMoney(city.treasury)}`,
  );
}
console.log('');
for (const city of world.cities) {
  console.log(`${city.name} 市场:`);
  for (const market of Object.values(city.market)) {
    console.log(
      `  ${market.goodId.padEnd(9)} 价 ${market.price.toFixed(2).padStart(7)} | 供应 ${market.supply.toFixed(0).padStart(9)} | 需求 ${market.demand.toFixed(0).padStart(9)} | 成交 ${market.sold.toFixed(0).padStart(9)} | 未满足 ${market.unmetDemand.toFixed(0).padStart(8)} | 库存 ${market.closingStock.toFixed(0).padStart(9)}`,
    );
  }
}
console.log('\n最近贸易:');
for (const flow of world.lastTick.tradeFlows) {
  console.log(
    `${flow.fromCityId}->${flow.toCityId} ${flow.good} ${flow.qty.toFixed(0)} @ ${flow.unitPrice}`,
  );
}
console.log('\n企业:');
for (const company of world.companies) {
  console.log(
    `${company.name.padEnd(10)} 员工 ${String(company.employees).padStart(6)} | 需求 ${String(company.jobDemand).padStart(6)} | 现金 ${formatMoney(company.cash).padStart(10)} | 产能 ${company.capacity.toFixed(0).padStart(8)} | 利用率 ${(company.utilization * 100).toFixed(0)}% | 收入 ${formatMoney(company.lastMonth.revenue)} | 工资 ${formatMoney(company.lastMonth.wagesPaid)} | 利润 ${formatMoney(company.lastMonth.profit)} | 库存 ${company.inventory[company.recipeOutput].toFixed(0)}`,
  );
}
console.log('\n世界 GDP:', formatMoney(world.cities.reduce((t, c) => t + c.gdp, 0)));
console.log('玩家净值:', formatMoney(world.history[world.history.length - 1]?.playerNetWorth ?? 0));
console.log('不变量:', checkInvariants(world));
console.log('日志尾部:');
for (const entry of world.log.slice(-8)) console.log(`  [${entry.kind}] ${entry.message}`);
