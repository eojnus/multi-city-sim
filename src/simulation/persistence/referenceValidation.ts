/**
 * v1.7 存档系统：跨模块引用校验。
 *
 * 读取模块化存档时，各模块先各自恢复数据；全部恢复完成后在这里统一检查“活跃数据”引用的
 * 稳定 ID 是否存在。历史记录允许引用已删除实体（例如清算记录、已兑付债券、已结清贷款），
 * 这些例外在下方逐项注明，避免把合法历史判成损坏。
 *
 * 说明：本函数只覆盖模块划分带来的跨模块引用；世界结构校验与 checkInvariants 仍由 core/save.ts
 * 的既有实现负责，两者不得互相替代。
 */

import type { WorldState } from '../contracts/types';

interface ReferenceIssue {
  path: string;
  message: string;
}

function collectIds(values: readonly { id: string }[], path: string, issues: ReferenceIssue[]): Set<string> {
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value.id !== 'string' || value.id.length === 0) {
      issues.push({ path, message: `存在空/非法 ID（${path}）` });
      continue;
    }
    if (seen.has(value.id)) issues.push({ path, message: `${path} 存在重复 ID：${value.id}` });
    seen.add(value.id);
  }
  return seen;
}

export interface CrossReferenceOptions {
  /**
   * 历史记录是否允许引用已删除实体。模块化新存档默认 true：清算记录、已兑付债券、
   * 已结清贷款等历史需要保留且会引用已删除企业/居民实体。
   */
  allowHistoricalMissing?: boolean;
}

/** 校验模块化存档恢复后的跨模块引用；返回错误信息（空数组 = 通过）。 */
export function validateCrossReferences(
  world: WorldState,
  options: CrossReferenceOptions = {},
): string[] {
  const allowHistoricalMissing = options.allowHistoricalMissing ?? true;
  const issues: ReferenceIssue[] = [];

  const cityIds = collectIds(world.cities, 'cities', issues);
  const companyIds = collectIds(world.companies, 'companies', issues);
  const investorIds = collectIds(world.investors ?? [], 'investors', issues);

  const requireCity = (cityId: unknown, path: string): void => {
    if (typeof cityId !== 'string' || !cityIds.has(cityId)) {
      issues.push({ path, message: `引用了不存在的城市：${String(cityId)}` });
    }
  };
  const requireCompany = (companyId: unknown, path: string): void => {
    if (typeof companyId !== 'string' || !companyIds.has(companyId)) {
      issues.push({ path, message: `引用了不存在的企业：${String(companyId)}` });
    }
  };
  const requireInvestor = (investorId: unknown, path: string): void => {
    if (typeof investorId !== 'string' || !investorIds.has(investorId)) {
      issues.push({ path, message: `引用了不存在的居民投资实体：${String(investorId)}` });
    }
  };

  // ---- 企业 → 城市 ----
  for (const company of world.companies) {
    if (typeof company.cityId !== 'string' || !cityIds.has(company.cityId)) {
      issues.push({ path: 'companies[].cityId', message: `企业 ${company.id} 引用不存在的城市 ${String(company.cityId)}` });
    }
  }

  // ---- 贸易路线 / 协议：城市与企业引用；跨城采购买方/卖方可能为 'households' 占位 ----
  for (const route of world.tradeRoutes ?? []) {
    requireCity(route.fromCityId, 'tradeRoutes[].fromCityId');
    requireCity(route.toCityId, 'tradeRoutes[].toCityId');
    if (route.fromCompanyId !== 'households') requireCompany(route.fromCompanyId, 'tradeRoutes[].fromCompanyId');
    if (route.toCompanyId !== 'households') requireCompany(route.toCompanyId, 'tradeRoutes[].toCompanyId');
  }
  for (const agreement of world.agreements ?? []) {
    requireCity(agreement.sponsorCityId, 'agreements[].sponsorCityId');
    requireCity(agreement.partnerCityId, 'agreements[].partnerCityId');
  }

  // ---- 证券：活跃股份类别/持仓/订单必须引用现存企业；历史 K 线与最近成交允许企业已退市 ----
  for (const shareClass of world.securities?.classes ?? []) {
    requireCompany(shareClass.companyId, 'securities.classes[].companyId');
  }
  for (const holding of world.securities?.holdings ?? []) {
    if (holding.shares > 0 || !allowHistoricalMissing) {
      requireCompany(holding.companyId, 'securities.holdings[].companyId');
    }
  }
  for (const order of world.securities?.orders ?? []) {
    requireCompany(order.companyId, 'securities.orders[].companyId');
  }
  for (const offer of world.securities?.offers ?? []) {
    requireCompany(offer.companyId, 'securities.offers[].companyId');
  }
  for (const trade of world.securities?.lastTrades ?? []) {
    if (allowHistoricalMissing) continue;
    requireCompany(trade.companyId, 'securities.lastTrades[].companyId');
  }

  // ---- 债券：发行批次的城市、持有人的批次与实体引用；已兑付/历史持债允许持有人已删除 ----
  const issuanceIds = new Set<string>();
  for (const issuance of world.bonds?.issuances ?? []) {
    if (issuanceIds.has(issuance.id)) {
      issues.push({ path: 'bonds.issuances[].id', message: `债券批次 ID 重复：${issuance.id}` });
    }
    issuanceIds.add(issuance.id);
    requireCity(issuance.cityId, 'bonds.issuances[].cityId');
  }
  for (const holding of world.bonds?.holdings ?? []) {
    if (!issuanceIds.has(holding.issuanceId)) {
      issues.push({
        path: 'bonds.holdings[].issuanceId',
        message: `持债记录 ${holding.id} 引用不存在的债券批次 ${String(holding.issuanceId)}`,
      });
    }
    const active = holding.status === 'active';
    if (!active && allowHistoricalMissing) continue;
    const holder = holding.holder;
    if (holder.kind === 'company') requireCompany(holder.id, 'bonds.holdings[].holder.id');
    else if (holder.kind === 'investorGroup') requireInvestor(holder.id, 'bonds.holdings[].holder.id');
    // player 持有人不需要额外引用检查。
  }
  for (const payment of world.bonds?.payments ?? []) {
    if (!issuanceIds.has(payment.issuanceId)) {
      issues.push({
        path: 'bonds.payments[].issuanceId',
        message: `债券兑付流水引用了不存在的债券批次 ${String(payment.issuanceId)}`,
      });
    }
  }

  // ---- 银行：存款/贷款的所有者引用。已结清贷款允许引用已删除实体（历史保留） ----
  for (const deposit of world.banking?.deposits ?? []) {
    const owner = deposit.owner;
    if (!owner) continue;
    if (owner.kind === 'company') requireCompany(owner.id, 'banking.deposits[].owner.id');
    else if (owner.kind === 'investorGroup') requireInvestor(owner.id, 'banking.deposits[].owner.id');
    else if (owner.kind === 'government') requireCity(owner.id, 'banking.deposits[].owner.id');
    // player / household（居民群体由 households.groups 承载）在结构校验中检查。
  }
  for (const loan of world.banking?.loans ?? []) {
    const closed = loan.status !== 'active';
    if (closed && allowHistoricalMissing) continue;
    const borrower = loan.borrower;
    if (!borrower) {
      issues.push({ path: 'banking.loans[].borrower', message: `银行贷款 ${String(loan.id)} 缺少借款人` });
      continue;
    }
    if (borrower.kind === 'company') requireCompany(borrower.id, 'banking.loans[].borrower.id');
    else if (borrower.kind === 'investorGroup') requireInvestor(borrower.id, 'banking.loans[].borrower.id');
    else if (borrower.kind === 'government') requireCity(borrower.id, 'banking.loans[].borrower.id');
  }

  // ---- 居民消费贷：借款人引用；已结清允许历史例外 ----
  for (const loan of world.householdFinance?.loans ?? []) {
    const closed = loan.status !== 'active';
    if (closed && allowHistoricalMissing) continue;
    const groupId = loan.groupId;
    if (typeof groupId !== 'string' || !world.households?.groups?.some((group) => group.id === groupId)) {
      issues.push({
        path: 'householdFinance.loans[].groupId',
        message: `居民消费贷 ${String(loan.id)} 引用不存在的居民群体 ${String(groupId)}`,
      });
    }
  }

  // ---- 政策 / 财政 / 税收：城市引用 ----
  for (const policy of [...(world.policies?.active ?? []), ...(world.policies?.history ?? [])]) {
    requireCity(policy.cityId, 'policies[].cityId');
  }
  for (const entry of world.fiscal?.ledger ?? []) {
    requireCity(entry.cityId, 'fiscal.ledger[].cityId');
  }
  for (const cityId of Object.keys(world.taxes?.historyByCity ?? {})) {
    if (!cityIds.has(cityId)) {
      issues.push({ path: 'taxes.historyByCity', message: `税收历史引用了不存在的城市：${cityId}` });
    }
  }
  for (const cityId of Object.keys(world.taxes?.accrualByCity ?? {})) {
    if (!cityIds.has(cityId)) {
      issues.push({ path: 'taxes.accrualByCity', message: `税收累计引用了不存在的城市：${cityId}` });
    }
  }

  // ---- 居民 / 投资实体：城市引用 ----
  for (const group of world.households?.groups ?? []) {
    requireCity(group.cityId, 'households.groups[].cityId');
  }
  for (const entry of world.households?.investorFundingHistory ?? []) {
    if (allowHistoricalMissing) continue;
    requireCity(entry.cityId, 'households.investorFundingHistory[].cityId');
  }
  for (const group of world.investors ?? []) {
    requireCity(group.cityId, 'investors[].cityId');
  }

  // ---- 设备市场：挂单企业引用（活跃委托必须引用现存企业） ----
  for (const offer of world.equipmentMarket?.offers ?? []) {
    requireCompany(offer.companyId, 'equipmentMarket.offers[].companyId');
  }

  // ---- 经营者：企业引用（离职经营者 companyId 为 null） ----
  for (const operator of world.management?.operators ?? []) {
    if (operator.companyId !== null && operator.companyId !== undefined) {
      requireCompany(operator.companyId, 'management.operators[].companyId');
    }
  }
  for (const operation of world.management?.playerOperations ?? []) {
    if (typeof operation.companyId === 'string' && operation.companyId.length > 0) {
      requireCompany(operation.companyId, 'management.playerOperations[].companyId');
    }
  }

  return issues.map((issue) => `${issue.path}: ${issue.message}`);
}
