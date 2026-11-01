import type { GoodId, WorldState } from '../contracts/types';
import { GOOD_IDS, roleTotal } from '../companies/company';
import { sumCityStock } from '../markets/markets';

export interface GoodsAudit {
  goodId: GoodId;
  startStock: number;
  produced: number;
  intermediateConsumed: number;
  householdConsumed: number;
  externalExported: number;
  endStock: number;
  tradeNet: number;
  expectedEndStock: number;
}

export function checkInvariants(world: WorldState, audits: GoodsAudit[] = []): string[] {
  const problems: string[] = [];
  if (!world || !Array.isArray(world.cities) || !Array.isArray(world.companies)) {
    return ['世界结构无效：cities/companies 不是数组'];
  }
  let worldPopulation = 0;

  for (const city of world.cities) {
    if (!city || !city.population || !city.publicSector) {
      problems.push(`${city?.name ?? '未知城市'}: 缺少 population 或 publicSector`);
      continue;
    }
    const p = city.population;
    worldPopulation += p.total;
    if (p.total !== p.employed + p.unemployed + p.nonLabor) {
      problems.push(
        `${city.name}: P != E+U+N (${p.total} != ${p.employed}+${p.unemployed}+${p.nonLabor})`,
      );
    }
    if (p.unemployed !== p.laborForce - p.employed) {
      problems.push(`${city.name}: 失业人口与劳动力不一致`);
    }
    if (p.nonLabor !== p.total - p.laborForce) {
      problems.push(`${city.name}: 非劳动力与总人口不一致`);
    }
    if (p.employed < 0 || p.unemployed < 0 || p.nonLabor < 0 || p.laborForce < 0) {
      problems.push(`${city.name}: 人口状态出现负数`);
    }

    let allocated = city.publicSector.employees;
    for (const company of world.companies) {
      if (!company || !company.roles || !company.inventory) {
        problems.push('企业缺少 roles/inventory');
        continue;
      }
      if (company.cityId !== city.id) continue;
      allocated += company.employees;
      if (!Number.isInteger(company.employees) || company.employees < 0) {
        problems.push(`${company.name}: 员工数非法 (${company.employees})`);
      }
      if (roleTotal(company.roles) !== company.employees) {
        problems.push(
          `${company.name}: 岗位合计 ${roleTotal(company.roles)} != 员工数 ${company.employees}`,
        );
      }
      for (const goodId of GOOD_IDS) {
        const qty = company.inventory[goodId] ?? 0;
        if (qty < -0.01) problems.push(`${company.name}: ${goodId} 库存为负 (${qty})`);
      }
      if (company.cash < -0.01) problems.push(`${company.name}: 现金为负 (${company.cash})`);
    }
    if (allocated !== p.employed) {
      problems.push(`${city.name}: 雇主员工合计 ${allocated} != 就业人口 ${p.employed}`);
    }
    if (city.publicSector.employees < 0 || city.publicSector.employees > city.publicSector.jobs) {
      problems.push(`${city.name}: 公共部门人数越界`);
    }
  }

  if (worldPopulation !== sumCityPopulations(world)) {
    problems.push('世界总人口与城市人口合计不一致');
  }

  for (const city of world.cities) {
    if (!city || !city.market) {
      problems.push(`${city?.name ?? '未知城市'}: 缺少 market`);
      continue;
    }
    for (const goodId of GOOD_IDS) {
      const market = city.market[goodId];
      if (!market) {
        problems.push(`${city.name}: 缺少 ${goodId} 市场`);
        continue;
      }
      if (market.price <= 0) problems.push(`${city.name}/${goodId}: 价格非正`);
      if (market.sold > market.demand + 0.05) {
        problems.push(
          `${city.name}/${goodId}: 成交 ${market.sold} 超过需求 ${market.demand}`,
        );
      }
      if (market.sold + market.intercityImported > market.demand + 0.05) {
        problems.push(`${city.name}/${goodId}: 本地成交 + 进口超过需求`);
      }
      if (market.sold > market.supply + 0.05) {
        problems.push(
          `${city.name}/${goodId}: 成交 ${market.sold} 超过供应 ${market.supply}`,
        );
      }
      if (market.unmetDemand < -0.01) {
        problems.push(`${city.name}/${goodId}: 未满足需求为负`);
      }
      const actualStock = sumCityStock(world, city.id, goodId);
      if (Math.abs(actualStock - market.closingStock) > 0.05) {
        problems.push(
          `${city.name}/${goodId}: 市场期末库存 ${market.closingStock} != 企业库存合计 ${actualStock}`,
        );
      }
    }
  }

  if (!world.player || !Array.isArray(world.player.holdings)) {
    problems.push('玩家数据缺少 holdings');
  } else {
    if (world.player.cash < -0.01) problems.push('玩家现金为负');
    if (world.player.lastDividend !== undefined && world.player.lastDividend < -0.01) {
      problems.push('玩家最近分红为负');
    }
    if (world.player.dividendsReceived !== undefined && world.player.dividendsReceived < -0.01) {
      problems.push('玩家累计分红为负');
    }
    for (const holding of world.player.holdings) {
      if (holding.shares < 0) problems.push('玩家持股为负');
    }
  }

  for (const audit of audits) {
    if (Math.abs(audit.endStock - audit.expectedEndStock) > 0.2) {
      problems.push(
        `${audit.goodId}: 库存不守恒 期初 ${audit.startStock} + 产出 ${audit.produced} - 中间投入 ${audit.intermediateConsumed} - 居民消费 ${audit.householdConsumed} - 区域外出口 ${audit.externalExported} + 贸易净额 ${audit.tradeNet} = ${audit.expectedEndStock}，实际 ${audit.endStock}`,
      );
    }
  }

  return problems;
}

function sumCityPopulations(world: WorldState): number {
  return world.cities.reduce((total, city) => total + city.population.total, 0);
}
