import type { GoodId, WorldState } from '../contracts/types';
import { GOOD_IDS, roleTotal } from '../companies/company';
import { sumCityStock } from '../markets/markets';

export interface GoodsAudit {  goodId: GoodId;
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

  // ---- v0.2 证券、居民投资、治理、协议与通知 ----
  problems.push(...checkSecurities(world));
  problems.push(...checkInvestors(world));
  problems.push(...checkGovernance(world));
  problems.push(...checkAgreements(world));
  problems.push(...checkNotifications(world));

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

function holderKeyOf(holder: { type: string; id: string }): string {
  return `${holder.type}:${holder.id}`;
}

/** 股份守恒：发行量 = 各持股人之和；企业买方只能持有投票权股份。 */
function checkSecurities(world: WorldState): string[] {
  const problems: string[] = [];
  if (!world.securities || !Array.isArray(world.securities.classes)) {
    return ['世界缺少 securities 数据'];
  }
  const companyIds = new Set(world.companies.map((company) => company.id));
  const groupIds = new Set((world.investors ?? []).map((group) => group.id));
  const classById = new Map<string, { companyId: string; kind: string }>();
  const kindsByCompany = new Map<string, Set<string>>();

  for (const shareClass of world.securities.classes) {
    if (!companyIds.has(shareClass.companyId)) {
      problems.push(`股份类别 ${shareClass.id} 引用不存在的企业`);
      continue;
    }
    if (classById.has(shareClass.id)) problems.push(`股份类别 ID 重复：${shareClass.id}`);
    if (shareClass.issuedShares < -0.01) problems.push(`股份类别 ${shareClass.id} 发行量为负`);
    classById.set(shareClass.id, { companyId: shareClass.companyId, kind: shareClass.kind });
    const kinds = kindsByCompany.get(shareClass.companyId) ?? new Set<string>();
    kinds.add(shareClass.kind);
    kindsByCompany.set(shareClass.companyId, kinds);
  }

  const holdingTotals = new Map<string, number>();
  for (const holding of world.securities.holdings) {
    const shareClass = classById.get(holding.shareClassId);
    if (!shareClass) {
      problems.push(`持股记录引用了未知股份类别 ${holding.shareClassId}`);
      continue;
    }
    if (shareClass.companyId !== holding.companyId) {
      problems.push('持股记录的企业与股份类别不一致');
    }
    if (holding.shares < -0.01) {
      problems.push(`持股记录 ${holding.shareClassId}/${holderKeyOf(holding.holder)} 股数为负`);
    }
    if (holding.holder.type === 'player' && holding.holder.id !== 'player') {
      problems.push('玩家持股记录的持有人 ID 无效');
    }
    if (holding.holder.type === 'company' && !companyIds.has(holding.holder.id)) {
      problems.push(`持股记录引用了不存在的企业 ${holding.holder.id}`);
    }
    if (holding.holder.type === 'investorGroup' && !groupIds.has(holding.holder.id)) {
      problems.push(`持股记录引用了不存在的居民投资实体 ${holding.holder.id}`);
    }
    holdingTotals.set(
      holding.shareClassId,
      (holdingTotals.get(holding.shareClassId) ?? 0) + holding.shares,
    );
  }

  for (const company of world.companies) {
    const kinds = kindsByCompany.get(company.id);
    if (!kinds || !kinds.has('voting') || !kinds.has('nonVoting')) {
      problems.push(`${company.name}: 缺少有投票权或仅分红股份类别`);
    }
    let issued = 0;
    for (const shareClass of world.securities.classes) {
      if (shareClass.companyId !== company.id) continue;
      issued += shareClass.issuedShares;
      const held = holdingTotals.get(shareClass.id) ?? 0;
      if (Math.abs(held - shareClass.issuedShares) > 0.05) {
        problems.push(
          `${company.name}: 股份类别 ${shareClass.kind} 持股合计 ${held} != 发行量 ${shareClass.issuedShares}`,
        );
      }
    }
    if (Math.abs(issued - company.totalShares) > 0.05) {
      problems.push(`${company.name}: 发行合计 ${issued} != totalShares ${company.totalShares}`);
    }
  }

  // 玩家持股镜像必须与证券权威数据一致，避免旧 UI 显示与实际权利脱节。
  const playerByCompany = new Map<string, number>();
  for (const holding of world.securities.holdings) {
    if (holding.holder.type !== 'player') continue;
    playerByCompany.set(
      holding.companyId,
      (playerByCompany.get(holding.companyId) ?? 0) + holding.shares,
    );
  }
  for (const company of world.companies) {
    const mirror = world.player.holdings
      .filter((holding) => holding.companyId === company.id)
      .reduce((total, holding) => total + holding.shares, 0);
    const authoritative = playerByCompany.get(company.id) ?? 0;
    if (Math.abs(mirror - authoritative) > 0.05) {
      problems.push(`${company.name}: 玩家持股镜像 ${mirror} != 证券记录 ${authoritative}`);
    }
  }
  return problems;
}

/** 居民投资实体不是额外人口；资金非负，人口占比按城市合计为 1。 */
function checkInvestors(world: WorldState): string[] {
  const problems: string[] = [];
  if (!Array.isArray(world.investors)) return ['世界缺少 investors 数据'];
  const seen = new Set<string>();
  const shareByCity = new Map<string, number>();
  for (const group of world.investors) {
    if (seen.has(group.id)) problems.push(`居民投资实体 ID 重复：${group.id}`);
    seen.add(group.id);
    if (!world.cities.some((city) => city.id === group.cityId)) {
      problems.push(`居民投资实体 ${group.id} 引用了不存在的城市`);
    }
    if (group.cash < -0.01) problems.push(`居民投资实体 ${group.id} 现金为负`);
    if (group.populationShare < -1e-9) {
      problems.push(`居民投资实体 ${group.id} 人口占比为负`);
    }
    shareByCity.set(
      group.cityId,
      (shareByCity.get(group.cityId) ?? 0) + group.populationShare,
    );
  }
  for (const city of world.cities) {
    const share = shareByCity.get(city.id) ?? 0;
    if (Math.abs(share - 1) > 0.01) {
      problems.push(`${city.name}: 居民投资实体人口占比合计 ${share.toFixed(4)} != 1`);
    }
  }
  return problems;
}

function checkGovernance(world: WorldState): string[] {
  const problems: string[] = [];
  if (!world.governance) return ['世界缺少 governance 数据'];
  const companyIds = new Set(world.companies.map((company) => company.id));
  const holderValid = (holder: { type: string; id: string }): boolean => {
    if (holder.type === 'player') return holder.id === 'player';
    if (holder.type === 'company') return companyIds.has(holder.id);
    return (world.investors ?? []).some((group) => group.id === holder.id);
  };
  for (const board of world.governance.boards) {
    if (!companyIds.has(board.companyId)) problems.push('董事会引用了不存在的企业');
    for (const seat of board.seats) {
      if (!holderValid(seat.holder)) problems.push(`${board.companyId}: 董事席位持有人无效`);
      if (seat.votingShares < -0.01) problems.push(`${board.companyId}: 董事席位票数为负`);
    }
    if (board.chair && !holderValid(board.chair)) {
      problems.push(`${board.companyId}: 董事长持有人无效`);
    }
  }
  for (const motion of world.governance.motions) {
    if (!companyIds.has(motion.companyId)) problems.push('议案引用了不存在的企业');
    if (!holderValid(motion.proposedBy)) problems.push(`议案 ${motion.id} 的提案人无效`);
    for (const vote of motion.votes) {
      if (!holderValid(vote.holder)) problems.push(`议案 ${motion.id} 的投票人无效`);
      if (vote.votingShares < -0.01) problems.push(`议案 ${motion.id} 的票数为负`);
    }
  }
  for (const control of world.governance.controls) {
    if (!companyIds.has(control.companyId)) problems.push('经营控制记录引用了不存在的企业');
    if (control.operator !== 'management' && !holderValid(control.operator)) {
      problems.push(`${control.companyId}: 经营者持有人无效`);
    }
  }
  return problems;
}

function checkAgreements(world: WorldState): string[] {
  const problems: string[] = [];
  if (!Array.isArray(world.agreements)) return ['世界缺少 agreements 数据'];
  for (const agreement of world.agreements) {
    for (const item of agreement.items) {
      if (item.deliveredQty < -0.01) continue;
      if (item.qtyPerMonth < 0 || item.unitPrice < 0) continue;
      const maxQty = item.qtyPerMonth * item.months + 0.05;
      if (item.deliveredQty > maxQty) {
        problems.push(`协议条目 ${item.id} 交付量超过协议总量`);
      }
      if (Math.abs(item.paidValue - item.deliveredQty * item.unitPrice) > 0.1) {
        problems.push(`协议条目 ${item.id} 付款与交付量不一致`);
      }
    }
  }
  return problems;
}

function checkNotifications(world: WorldState): string[] {
  const problems: string[] = [];
  if (!Array.isArray(world.notifications)) return ['世界缺少 notifications 数据'];
  const seen = new Set<string>();
  for (const notice of world.notifications) {
    if (seen.has(notice.id)) problems.push(`通知 ID 重复：${notice.id}`);
    seen.add(notice.id);
  }
  return problems;
}
