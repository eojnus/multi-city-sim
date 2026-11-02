import type { GoodId, WorldState } from '../contracts/types';
import { GOOD_IDS, roleTotal } from '../companies/company';
import { sumCityStock } from '../markets/markets';
import { round2 } from './math';

export interface GoodsAudit {  goodId: GoodId;
  startStock: number;
  produced: number;
  intermediateConsumed: number;
  householdConsumed: number;
  externalExported: number;
  /** v0.3：倒闭企业库存注销数量（显式去向，不是消费）。 */
  writtenOff: number;
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
  problems.push(...checkPolitics(world));
  problems.push(...checkPolicies(world));
  problems.push(...checkTransport(world));
  problems.push(...checkLifecycle(world));
  problems.push(...checkCompanyAi(world));
  // ---- v0.4 居民群体、经营者与银行 ----
  problems.push(...checkHouseholds(world));
  problems.push(...checkManagement(world));
  problems.push(...checkBanking(world));
  // ---- v0.7 政府债务、债券、居民消费金融与 GDP 判定窗口 ----
  checkGovernmentDebtInvariants(world, problems);

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
  const cityIds = new Set(world.cities.map((city) => city.id));
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
    if (holding.holder.type === 'city' && !cityIds.has(holding.holder.id)) {
      problems.push(`持股记录引用了不存在的城市 ${holding.holder.id}`);
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
  const votingIssued = new Map<string, number>();
  for (const shareClass of world.securities?.classes ?? []) {
    if (shareClass.kind !== 'voting') continue;
    votingIssued.set(
      shareClass.companyId,
      (votingIssued.get(shareClass.companyId) ?? 0) + shareClass.issuedShares,
    );
  }
  const holderValid = (holder: { type: string; id: string }): boolean => {
    if (holder.type === 'player') return holder.id === 'player';
    if (holder.type === 'company') return companyIds.has(holder.id);
    if (holder.type === 'city') return world.cities.some((city) => city.id === holder.id);
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
    if (!Array.isArray(motion.eligible)) {
      problems.push(`议案 ${motion.id}: 缺少登记日投票权快照`);
      continue;
    }
    const eligibility = new Map<string, number>();
    let eligibleTotal = 0;
    for (const entry of motion.eligible) {
      if (!holderValid(entry.holder)) {
        problems.push(`议案 ${motion.id}: 登记日持有人无效`);
        continue;
      }
      if (!(entry.shares >= 0)) problems.push(`议案 ${motion.id}: 登记日股数为负`);
      const key = `${entry.holder.type}:${entry.holder.id}`;
      if (eligibility.has(key)) {
        problems.push(`议案 ${motion.id}: 登记日快照存在重复持有人 ${key}`);
      }
      eligibility.set(key, entry.shares);
      eligibleTotal += entry.shares;
    }
    const issued = votingIssued.get(motion.companyId) ?? 0;
    // 已结束议案可能由旧规则创建，其历史票重按当时持股记录；不要求其快照合计等于当前发行量。
    if (motion.status === 'open' && eligibleTotal > issued + 0.05) {
      problems.push(
        `议案 ${motion.id}: 登记日投票权合计 ${eligibleTotal} 超过发行量 ${issued}`,
      );
    }
    const seenVoters = new Set<string>();
    for (const vote of motion.votes) {
      if (!holderValid(vote.holder)) {
        problems.push(`议案 ${motion.id} 的投票人无效`);
        continue;
      }
      const key = `${vote.holder.type}:${vote.holder.id}`;
      if (seenVoters.has(key)) {
        problems.push(`议案 ${motion.id}: 同一持有人出现多张表决票`);
      }
      seenVoters.add(key);
      const entitled = eligibility.get(key);
      if (entitled === undefined) {
        problems.push(`议案 ${motion.id}: 投票人 ${key} 不在登记日快照内`);
      } else if (vote.votingShares > entitled + 0.01) {
        problems.push(`议案 ${motion.id}: 投票人 ${key} 票数超过登记日持股`);
      }
      if (vote.votingShares < -0.01) problems.push(`议案 ${motion.id} 的票数为负`);
    }
  }
  for (const control of world.governance.controls) {
    if (!companyIds.has(control.companyId)) problems.push('经营控制记录引用了不存在的企业');
    if (control.operator !== 'management' && !holderValid(control.operator)) {
      problems.push(`${control.companyId}: 经营者持有人无效`);
    }
    if (control.operator !== 'management' && control.operator.type === 'city') {
      problems.push(`${control.companyId}: 城市政府不能直接担任企业经营层（暂定）`);
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

// ---------------------------------------------------------------- v0.3 政治、政策、交通、生命周期

const POLICY_ID_SET = new Set<string>([
  'hiringSubsidy',
  'retentionSubsidy',
  'vocationalTraining',
  'publicJobs',
  'startupSupport',
  'companyRelief',
  'equipmentSubsidy',
  'keyIndustrySupport',
  'researchGrant',
  'educationInvestment',
  'intercityTradeSupport',
  'transportInvestment',
  'unemploymentAid',
  'housingSupport',
  'taxAdjustment',
]);

const SECTOR_ID_SET = new Set<string>([
  'agriculture',
  'fiber-farm',
  'textile',
  'food',
  'garment',
  'metal',
  'utility',
  'appliance',
]);

const STYLE_SET = new Set<string>(['growth', 'steady', 'return']);

function checkPolitics(world: WorldState): string[] {
  const problems: string[] = [];
  if (!world.politics || !Array.isArray(world.politics.cities)) {
    return ['世界缺少 politics 数据'];
  }
  if (world.politics.cities.length !== world.cities.length) {
    problems.push('政治状态与城市数量不一致');
  }
  for (const city of world.cities) {
    const state = world.politics.cities.find((entry) => entry.cityId === city.id);
    if (!state) {
      problems.push(`${city.name}: 缺少候选人/领导人状态`);
      continue;
    }
    if (!Array.isArray(state.candidates) || state.candidates.length === 0) {
      problems.push(`${city.name}: 没有候选人`);
    }
    const ids = new Set<string>();
    for (const candidate of state.candidates) {
      if (ids.has(candidate.id)) problems.push(`${city.name}: 候选人 ID 重复 ${candidate.id}`);
      ids.add(candidate.id);
      if (candidate.cityId !== city.id) problems.push(`${city.name}: 候选人城市不一致`);
      for (const [domain, value] of Object.entries(candidate.profile.domainLeanings)) {
        if (!(value >= 0 && value <= 1)) {
          problems.push(`${city.name}: 候选人 ${candidate.name} 的 ${domain} 倾向越界`);
        }
      }
      if (
        candidate.profile.sectorAffinity !== null &&
        !SECTOR_ID_SET.has(candidate.profile.sectorAffinity)
      ) {
        problems.push(`${city.name}: 候选人 ${candidate.name} 重点行业无效`);
      }
    }
    if (state.leader && !ids.has(state.leader.id)) {
      problems.push(`${city.name}: 领导人不在候选人列表中`);
    }
    if (state.termMonthsLeft < 0) problems.push(`${city.name}: 任期倒计时为负`);
    if (world.player.roles?.mayorCityId === city.id && state.leader) {
      problems.push(`${city.name}: 玩家市长在任时不应同时存在 AI 领导人`);
    }
    if (!city.workforce || !(city.workforce.skillLevel >= 0 && city.workforce.skillLevel <= 1)) {
      problems.push(`${city.name}: 技能水平越界`);
    }
    if (!city.housing || city.housing.units < 0) {
      problems.push(`${city.name}: 住房状态无效`);
    }
    if (!(city.technology.researchPoints >= 0)) {
      problems.push(`${city.name}: 研究点为负`);
    }
    if (!(city.technology.productivityMultiplier > 0)) {
      problems.push(`${city.name}: 科技生产率非正`);
    }
  }
  return problems;
}

function checkPolicies(world: WorldState): string[] {
  const problems: string[] = [];
  if (!world.policies) return ['世界缺少 policies 数据'];
  if (!world.fiscal || !Array.isArray(world.fiscal.ledger)) {
    problems.push('世界缺少 fiscal 数据');
  }
  const cityIds = new Set(world.cities.map((city) => city.id));
  const activeKeys = new Set<string>();
  for (const policy of world.policies.active) {
    if (!cityIds.has(policy.cityId)) problems.push(`政策 ${policy.id} 引用不存在的城市`);
    if (!POLICY_ID_SET.has(policy.policyId)) problems.push(`政策 ${policy.id} 类型无效`);
    const key = `${policy.cityId}:${policy.policyId}`;
    if (activeKeys.has(key)) problems.push(`同一城市重复生效：${policy.policyId}`);
    activeKeys.add(key);
    if (!(policy.budget >= 0)) problems.push(`政策 ${policy.id} 预算为负`);
    if (!(policy.spent >= 0 && policy.spent <= policy.budget + 0.01)) {
      problems.push(`政策 ${policy.id} 支出超过预算`);
    }
    if (!(policy.monthsRemaining >= 0)) problems.push(`政策 ${policy.id} 剩余月份为负`);
    if (policy.status !== 'active') problems.push(`政策 ${policy.id} 状态与生效列表不一致`);
    for (const value of Object.values(policy.effects)) {
      if (!Number.isFinite(value)) problems.push(`政策 ${policy.id} 效果记录无效`);
    }
  }
  for (const entry of world.fiscal?.ledger ?? []) {
    if (!cityIds.has(entry.cityId)) problems.push(`财政流水 ${entry.id} 引用不存在的城市`);
    if (!Number.isFinite(entry.amount)) problems.push(`财政流水 ${entry.id} 金额无效`);
    if (entry.policyId && !POLICY_ID_SET.has(entry.policyId)) {
      problems.push(`财政流水 ${entry.id} 政策无效`);
    }
  }
  return problems;
}

function checkTransport(world: WorldState): string[] {
  const problems: string[] = [];
  if (!world.transport) return ['世界缺少 transport 数据'];
  const cityIds = new Set(world.cities.map((city) => city.id));
  const ids = new Set<string>();
  for (const link of world.transport.links) {
    if (ids.has(link.id)) problems.push(`交通线路 ID 重复：${link.id}`);
    ids.add(link.id);
    if (!cityIds.has(link.fromCityId) || !cityIds.has(link.toCityId)) {
      problems.push(`交通线路 ${link.id} 引用不存在的城市`);
    }
    if (link.fromCityId === link.toCityId) problems.push(`交通线路 ${link.id} 连接同一城市`);
    if (!(link.level >= 0 && link.level <= link.maxLevel)) {
      problems.push(`交通线路 ${link.id} 等级越界`);
    }
    if (link.construction) {
      if (link.construction.targetLevel !== link.level + 1) {
        problems.push(`交通线路 ${link.id} 建设目标不是下一等级`);
      }
      if (link.construction.monthsRemaining < 0) {
        problems.push(`交通线路 ${link.id} 建设工期为负`);
      }
    }
  }
  for (const network of world.transport.intracity) {
    if (!cityIds.has(network.cityId)) problems.push('城内交通引用了不存在的城市');
    if (!(network.roadLevel >= 0 && network.roadLevel <= network.maxLevel)) {
      problems.push(`${network.cityId}: 城内公路等级越界`);
    }
    if (!(network.railLevel >= 0 && network.railLevel <= network.maxLevel)) {
      problems.push(`${network.cityId}: 城内铁路等级越界`);
    }
  }
  for (const sale of world.transport.pendingSales) {
    if (!(sale.qty > 0) || !(sale.grossValue >= 0)) {
      problems.push('待结算跨城销售数量/金额无效');
    }
    if (!world.companies.some((company) => company.id === sale.sellerCompanyId)) {
      problems.push(`待结算跨城销售引用了不存在的卖方 ${sale.sellerCompanyId}`);
    }
  }
  const stats = world.transport.lastMonth;
  if (!stats) return problems.length > 0 ? problems : ['缺少上期交通统计'];
  if (!(stats.penaltyRate >= 0 && stats.penaltyRate <= 1)) {
    problems.push('上期容量惩罚比例越界');
  }
  let lossSum = 0;
  for (const trade of stats.trades) {
    if (trade.sellerProceeds < -0.01) problems.push('跨城结算卖方所得为负');
    if (trade.sellerProceeds > trade.grossValue + 0.01) {
      problems.push('跨城结算卖方所得超过买方付款');
    }
    // 新记录带买方退款；旧存档历史记录没有该字段，按“退款=容量损失”兼容校验。
    const buyerRefund = trade.buyerRefund ?? trade.capacityLoss;
    if (buyerRefund < -0.01) problems.push('跨城结算买方退款为负');
    if (Math.abs(buyerRefund - trade.capacityLoss) > 0.05) {
      problems.push('跨城结算买方退款与容量损失不一致');
    }
    if (Math.abs(trade.grossValue - (trade.sellerProceeds + buyerRefund)) > 0.05) {
      problems.push('跨城结算账目不平：付款 != 卖方所得 + 买方退款');
    }
    if (!(trade.penaltyRate >= 0 && trade.penaltyRate <= 1)) {
      problems.push('跨城结算惩罚比例越界');
    }
    lossSum += trade.capacityLoss;
  }
  if (Math.abs(lossSum - stats.capacityLossTotal) > 0.05) {
    problems.push('上期容量损失合计与逐笔记录不一致');
  }
  for (const entry of stats.intracity) {
    if (!(entry.deliveryEfficiency >= 0 && entry.deliveryEfficiency <= 1)) {
      problems.push('城内配送效率越界');
    }
    if (!(entry.capacity >= 0 && entry.demand >= 0)) {
      problems.push('城内配送需求/容量为负');
    }
  }
  return problems;
}

function checkLifecycle(world: WorldState): string[] {
  const problems: string[] = [];
  if (!world.lifecycle) return ['世界缺少 lifecycle 数据'];
  const companyIds = new Set(world.companies.map((company) => company.id));
  for (const record of world.lifecycle.foundings) {
    if (!(record.capital > 0)) problems.push(`成立记录 ${record.id} 资本无效`);
    if (record.investorCount <= 0) problems.push(`成立记录 ${record.id} 缺少出资人`);
    const invested = record.investors.reduce((sum, investor) => sum + investor.cash, 0);
    if (Math.abs(invested - record.capital) > 0.05) {
      problems.push(`成立记录 ${record.id} 出资合计与资本不一致`);
    }
    if (record.governmentGrant < -0.01) problems.push(`成立记录 ${record.id} 财政扶持为负`);
  }
  for (const record of world.lifecycle.liquidations) {
    if (companyIds.has(record.companyId)) {
      problems.push(`倒闭记录 ${record.id} 的企业仍在世界中`);
    }
    if (record.employeesReleased < 0) problems.push(`倒闭记录 ${record.id} 员工数为负`);
    const remaining = record.cash - record.debtRepaid;
    if (record.shareholderPayout > remaining + 0.05) {
      problems.push(`倒闭记录 ${record.id} 股东分配超过剩余现金`);
    }
    if (record.debtRepaid > record.debt + 0.05) {
      problems.push(`倒闭记录 ${record.id} 偿债超过债务`);
    }
    for (const entry of record.inventoryWrittenOff) {
      if (entry.qty < -0.01) problems.push(`倒闭记录 ${record.id} 注销库存为负`);
    }
  }
  return problems;
}

function checkCompanyAi(world: WorldState): string[] {
  const problems: string[] = [];
  for (const company of world.companies) {
    if (!company.ai) {
      problems.push(`${company.name}: 缺少经营 AI 状态`);
      continue;
    }
    if (!STYLE_SET.has(company.ai.style)) problems.push(`${company.name}: 经营风格无效`);
    if (!Number.isInteger(company.ai.lossMonths) || company.ai.lossMonths < 0) {
      problems.push(`${company.name}: 连续亏损月份无效`);
    }
    if (company.ai.ageMonths < 0) problems.push(`${company.name}: 经营月龄为负`);
    if (company.ai.lastPlan) {
      if (company.ai.lastPlan.targetJobs < 0) problems.push(`${company.name}: 计划岗位为负`);
      if (!(company.ai.lastPlan.utilization >= 0)) problems.push(`${company.name}: 计划利用率为负`);
    }
  }
  return problems;
}

/** v0.4：居民群体人数合计必须等于城市总人口（一个人只被统计一次）。 */
function checkHouseholds(world: WorldState): string[] {
  const problems: string[] = [];
  if (!world.households || !Array.isArray(world.households.groups)) {
    return ['世界缺少居民群体数据'];
  }
  for (const city of world.cities) {
    const groups = world.households.groups.filter((group) => group.cityId === city.id);
    if (groups.length === 0) {
      problems.push(`${city.name}: 缺少居民群体`);
      continue;
    }
    let people = 0;
    for (const group of groups) {
      if (!Number.isInteger(group.people) || group.people < 0) {
        problems.push(`${city.name} ${group.name}: 群体人数无效`);
      }
      if (group.cash < -0.01) problems.push(`${city.name} ${group.name}: 群体现金为负`);
      people += group.people;
    }
    if (people !== city.population.total) {
      problems.push(
        `${city.name}: 居民群体人数合计 ${people} 与城市总人口 ${city.population.total} 不一致`,
      );
    }
    // 群体本月净现金变化 = 收入 - 消费 - 储蓄（容差 0.05）。
    for (const group of groups) {
      const expected = round2(
        group.lastMonth.income - group.lastMonth.consumption - group.lastMonth.savingsContribution,
      );
      if (Math.abs(expected - group.lastMonth.netCashChange) > 0.05) {
        problems.push(
          `${city.name} ${group.name}: 群体现金流不闭合（应 ${expected}，记 ${group.lastMonth.netCashChange}）`,
        );
      }
    }
  }
  return problems;
}

/** v0.4：经营者任职关系一致；AI 经营者不得同时经营两家企业。 */
function checkManagement(world: WorldState): string[] {
  const problems: string[] = [];
  if (!world.management || !Array.isArray(world.management.operators)) {
    return ['世界缺少经营者数据'];
  }
  const operatorById = new Map(world.management.operators.map((entry) => [entry.id, entry]));
  const busyCompanies = new Map<string, string>();
  for (const control of world.governance.controls) {
    if (!control.operatorId) continue;
    const operator = operatorById.get(control.operatorId);
    if (!operator) {
      problems.push(`企业 ${control.companyId}: 经营者档案 ${control.operatorId} 不存在`);
      continue;
    }
    if (operator.status !== 'employed' || operator.companyId !== control.companyId) {
      problems.push(`${operator.name}: 经营者状态与企业控制记录不一致`);
    }
    const existing = busyCompanies.get(operator.id);
    if (existing && existing !== control.companyId) {
      problems.push(`${operator.name}: 同时经营两家企业（${existing}、${control.companyId}）`);
    }
    busyCompanies.set(operator.id, control.companyId);
  }
  for (const operator of world.management.operators) {
    if (operator.status === 'employed') {
      if (!operator.companyId) problems.push(`${operator.name}: 在职但未记录企业`);
    } else if (operator.companyId !== null) {
      problems.push(`${operator.name}: 在人才市场但仍绑定企业`);
    }
  }
  // 选任议案：候选人唯一，选票必须指向候选人，一人一票。
  for (const motion of world.governance.motions) {
    if (motion.kind !== 'operatorElection') continue;
    const candidates = new Set((motion.candidates ?? []).map((entry) => entry.candidateId));
    if (candidates.size === 0) problems.push(`选任议案 ${motion.id}: 缺少候选人`);
    const voters = new Set<string>();
    for (const vote of motion.votes) {
      if (!vote.candidateId || !candidates.has(vote.candidateId)) {
        problems.push(`选任议案 ${motion.id}: 选票指向不存在的候选人`);
      }
      const key = holderKeyOf(vote.holder);
      if (voters.has(key)) problems.push(`选任议案 ${motion.id}: 持有人 ${key} 重复投票`);
      voters.add(key);
    }
  }
  return problems;
}

/** v0.4：银行账目一致（存款非负、贷款余额与已还本金一致、企业债务镜像一致）。 */
function checkBanking(world: WorldState): string[] {
  const problems: string[] = [];
  if (!world.banking || !Array.isArray(world.banking.loans)) {
    return ['世界缺少银行数据'];
  }
  for (const account of world.banking.deposits) {
    if (account.balance < -0.01) problems.push(`存款账户 ${account.id}: 余额为负`);
  }
  const debtByCompany = new Map<string, number>();
  for (const loan of world.banking.loans) {
    if (loan.outstanding < -0.01) problems.push(`贷款 ${loan.id}: 未偿本金为负`);
    if (loan.paidPrincipal < -0.01 || loan.paidInterest < -0.01) {
      problems.push(`贷款 ${loan.id}: 已还金额为负`);
    }
    const expected = round2(loan.principal - loan.paidPrincipal);
    if (Math.abs(expected - loan.outstanding) > 0.01) {
      problems.push(`贷款 ${loan.id}: 未偿本金 ${loan.outstanding} 与已还本金不一致（应 ${expected}）`);
    }
    if (loan.status === 'repaid' && loan.outstanding > 0.01) {
      problems.push(`贷款 ${loan.id}: 已结清但仍有未偿本金`);
    }
    if (loan.borrower.kind === 'company') {
      const current = debtByCompany.get(loan.borrower.id) ?? 0;
      // 违约贷款仍计入企业债务（银行不放弃债权），与 syncCompanyDebt 口径一致。
      if (loan.status !== 'repaid') {
        debtByCompany.set(loan.borrower.id, round2(current + loan.outstanding));
      }
    }
  }
  for (const company of world.companies) {
    const expected = debtByCompany.get(company.id) ?? 0;
    if (Math.abs(expected - company.debt) > 0.01) {
      problems.push(
        `${company.name}: 企业债务镜像 ${company.debt} 与银行贷款未偿 ${expected} 不一致`,
      );
    }
  }
  return problems;
}

/**
 * v0.7：政府债务/债券/居民消费金融/GDP 窗口的不变量（只写当前空态也成立的检查）。
 * 全量口径（DECISIONS v1.1 #11 更正版）：总负债只计一次垫付——
 *   政府全部银行贷款未偿本金（含 bondAdvance）+ 未偿债券本金 + 已计提未付利息。
 * 不变量逐项检查，失败时把中文问题串 push 进 problems。
 */
export function checkGovernmentDebtInvariants(world: WorldState, problems: string[]): void {
  const cityIds = new Set(world.cities.map((city) => city.id));
  const issuanceById = new Map(
    (world.bonds?.issuances ?? []).map((issuance) => [issuance.id, issuance] as const),
  );

  // ---- 债券账本 ----
  if (world.bonds) {
    const holdingsByIssuance = new Map<string, { units: number; principal: number; accrued: number }>();
    for (const holding of world.bonds.holdings) {
      const issuance = issuanceById.get(holding.issuanceId);
      if (!issuance) {
        problems.push(`持债记录 ${holding.id}: 引用了不存在的债券批次 ${holding.issuanceId}`);
        continue;
      }
      if (holding.units < 0) problems.push(`持债记录 ${holding.id}: 份数为负`);
      if (holding.principal < -0.01) problems.push(`持债记录 ${holding.id}: 本金为负`);
      const expectedPrincipal = round2(holding.units * issuance.faceValue);
      if (Math.abs(expectedPrincipal - holding.principal) > 0.01) {
        problems.push(
          `持债记录 ${holding.id}: 本金 ${holding.principal} 与份数×面额 ${expectedPrincipal} 不一致`,
        );
      }
      const aggregate = holdingsByIssuance.get(holding.issuanceId) ?? {
        units: 0,
        principal: 0,
        accrued: 0,
      };
      aggregate.units += holding.units;
      aggregate.principal = round2(aggregate.principal + holding.principal);
      aggregate.accrued = round2(aggregate.accrued + holding.accruedInterest);
      holdingsByIssuance.set(holding.issuanceId, aggregate);
    }
    const paymentIds = new Set<string>();
    for (const payment of world.bonds.payments) {
      if (paymentIds.has(payment.id)) problems.push(`债券兑付流水 ID 重复：${payment.id}`);
      paymentIds.add(payment.id);
      if (!issuanceById.has(payment.issuanceId)) {
        problems.push(`债券兑付流水 ${payment.id}: 引用了不存在的债券批次`);
      }
      if (payment.principalPaid < -0.01 || payment.interestPaid < -0.01) {
        problems.push(`债券兑付流水 ${payment.id}: 金额为负`);
      }
    }
    for (const issuance of world.bonds.issuances) {
      if (!cityIds.has(issuance.cityId)) {
        problems.push(`债券批次 ${issuance.id}: 引用了不存在的城市 ${issuance.cityId}`);
      }
      if (issuance.soldUnits < 0 || issuance.soldUnits > issuance.planUnits) {
        problems.push(`债券批次 ${issuance.id}: 实售份数 ${issuance.soldUnits} 越过 [0, 计划份数]`);
      }
      if (issuance.unsoldUnits !== issuance.planUnits - issuance.soldUnits) {
        problems.push(`债券批次 ${issuance.id}: 未售份数与 计划−实售 不一致`);
      }
      const expectedPrincipal = round2(issuance.soldUnits * issuance.faceValue);
      if (Math.abs(expectedPrincipal - issuance.principal) > 0.01) {
        problems.push(
          `债券批次 ${issuance.id}: 本金 ${issuance.principal} 与 实售份数×面额 ${expectedPrincipal} 不一致`,
        );
      }
      if (issuance.accruedInterest < -0.01 || issuance.arrearsInterest < -0.01) {
        problems.push(`债券批次 ${issuance.id}: 应计/欠付利息为负`);
      }
      const aggregate = holdingsByIssuance.get(issuance.id);
      const aggregateUnits = aggregate?.units ?? 0;
      const aggregatePrincipal = aggregate?.principal ?? 0;
      if (issuance.soldUnits !== aggregateUnits) {
        problems.push(
          `债券批次 ${issuance.id}: 实售份数 ${issuance.soldUnits} 与持债份数合计 ${aggregateUnits} 不一致`,
        );
      }
      if (Math.abs(issuance.principal - aggregatePrincipal) > 0.01) {
        problems.push(
          `债券批次 ${issuance.id}: 本金 ${issuance.principal} 与持债本金合计 ${aggregatePrincipal} 不一致`,
        );
      }
      // 汇总字段与持债明细对账（容差 0.05，吸收逐笔四舍五入）。
      const aggregateAccrued = aggregate?.accrued ?? 0;
      if (Math.abs(issuance.accruedInterest - aggregateAccrued) > 0.05) {
        problems.push(
          `债券批次 ${issuance.id}: 汇总应计利息 ${issuance.accruedInterest} 与持债明细 ${aggregateAccrued} 不一致`,
        );
      }
    }
  }

  // ---- 各城政府债务、GDP 窗口 ----
  for (const city of world.cities) {
    const window = city.gdpWindow ?? [];
    if (window.length > 12) problems.push(`${city.name}: GDP 判定窗口超过 12 条`);
    let lastTick = -Infinity;
    for (const point of window) {
      if (point.value < 0) problems.push(`${city.name}: GDP 判定窗口出现负值`);
      if (typeof point.estimated !== 'boolean') {
        problems.push(`${city.name}: GDP 判定窗口缺 estimated 标注`);
      }
      if (point.estimated && point.tick >= 0) {
        problems.push(`${city.name}: 估计月 tick ${point.tick} 应为负数`);
      }
      if (!point.estimated && point.tick <= 0) {
        problems.push(`${city.name}: 真实月 tick ${point.tick} 应为正数`);
      }
      if (point.tick <= lastTick) {
        problems.push(`${city.name}: GDP 判定窗口未按 tick 升序`);
      }
      lastTick = point.tick;
    }

    const government = city.government;
    if (!government) continue;

    // 政府贷款：余额与已还本金一致，垫付贷款合计 = 汇总中的 bankAdvancePrincipal。
    let ordinaryPrincipal = 0;
    let advancePrincipal = 0;
    let loanAccrued = 0;
    for (const loan of government.loans) {
      if (loan.outstanding < -0.01) problems.push(`政府贷款 ${loan.id}: 未偿本金为负`);
      const expected = round2(loan.principal - loan.paidPrincipal);
      if (Math.abs(expected - loan.outstanding) > 0.01) {
        problems.push(
          `政府贷款 ${loan.id}: 未偿本金 ${loan.outstanding} 与已还本金不一致（应 ${expected}）`,
        );
      }
      if (loan.status === 'active' || loan.status === 'writtenOff') {
        if (loan.purpose === 'bondAdvance') {
          advancePrincipal = round2(advancePrincipal + loan.outstanding);
        } else {
          ordinaryPrincipal = round2(ordinaryPrincipal + loan.outstanding);
        }
        loanAccrued = round2(loanAccrued + loan.accruedInterest + loan.arrearsInterest);
      }
    }

    // 应付项：金额非负；pending 项不得标记已结清时间。
    for (const payable of government.payables) {
      if (payable.principalDue < -0.01 || payable.interestDue < -0.01) {
        problems.push(`应付项 ${payable.id}: 金额为负`);
      }
      if (payable.status === 'pending' && payable.paidTick !== null) {
        problems.push(`应付项 ${payable.id}: 未结清却有结清 tick`);
      }
    }

    // 垫付流水：总额 = 本金 + 利息。
    for (const advance of government.advances) {
      const expected = round2(advance.principalAdvanced + advance.interestAdvanced);
      if (Math.abs(expected - advance.totalAdvanced) > 0.01) {
        problems.push(`垫付记录 ${advance.id}: 总额与本金+利息不一致`);
      }
    }

    // 总负债口径：五段相加，且与政府贷款/持债明细对账（垫付只在 bondAdvance 贷款里计一次）。
    const summary = government.lastDebt;
    if (summary) {
      const segments = round2(
        summary.bankLoanPrincipal +
          summary.bankAdvancePrincipal +
          summary.bondPrincipalOutstanding +
          summary.loanAccruedInterest +
          summary.bondAccruedInterest,
      );
      if (Math.abs(segments - summary.totalDebt) > 0.05) {
        problems.push(
          `${city.name}: 总负债 ${summary.totalDebt} 与五段分子合计 ${segments} 不一致`,
        );
      }
      if (Math.abs(summary.bankAdvancePrincipal - advancePrincipal) > 0.05) {
        problems.push(
          `${city.name}: 汇总垫付本金 ${summary.bankAdvancePrincipal} 与垫付贷款未偿合计 ${advancePrincipal} 不一致`,
        );
      }
      if (Math.abs(summary.bankLoanPrincipal - ordinaryPrincipal) > 0.05) {
        problems.push(
          `${city.name}: 汇总普通贷款本金 ${summary.bankLoanPrincipal} 与贷款未偿合计 ${ordinaryPrincipal} 不一致`,
        );
      }
      if (Math.abs(summary.loanAccruedInterest - loanAccrued) > 0.05) {
        problems.push(`${city.name}: 汇总贷款应计利息与贷款明细不一致`);
      }
      const judgement = Math.max(1, summary.gdpWindowSum);
      if (Math.abs(summary.gdpJudgementValue - judgement) > 0.05) {
        problems.push(`${city.name}: 判定分母 ${summary.gdpJudgementValue} 与 max(1, 窗口合计) 不一致`);
      }
      const ratio = summary.totalDebt / Math.max(summary.gdpJudgementValue, 0.0001);
      if (Math.abs(ratio - summary.debtRatio) > 0.001) {
        problems.push(`${city.name}: 债务/GDP ${summary.debtRatio} 与 totalDebt/判定分母 不一致`);
      }
      if (summary.riskLevel === 'bankrupt' && government.bankruptcy.status !== 'bankrupt') {
        problems.push(`${city.name}: 汇总标记破产但政府状态不是破产`);
      }
    }
  }

  // ---- 居民消费金融 ----
  if (world.householdFinance) {
    const groupIds = new Set(world.households?.groups.map((group) => group.id) ?? []);
    for (const loan of world.householdFinance.loans) {
      if (!cityIds.has(loan.cityId)) {
        problems.push(`居民消费贷款 ${loan.id}: 引用了不存在的城市`);
      }
      if (!groupIds.has(loan.groupId)) {
        problems.push(`居民消费贷款 ${loan.id}: 引用了不存在的居民群体`);
      }
      if (loan.outstanding < -0.01) problems.push(`居民消费贷款 ${loan.id}: 未偿本金为负`);
      if (loan.outstanding > round2(loan.principal - loan.paidPrincipal) + 0.01) {
        problems.push(`居民消费贷款 ${loan.id}: 未偿本金超过合同本金`);
      }
    }
  }
}
