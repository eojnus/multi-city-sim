// v1.7 存档系统重构：跨模块引用校验测试（referenceValidation.validateCrossReferences）。
//
// 目标（SAVE-T2）：
// 1) 正常世界（新开局 + 真实推进 2 个月）0 错误，返回空数组表示通过；
// 2) 注入错误引用能被检出，覆盖任务书列出的全部跨模块引用：
//    企业→城市、贸易路线→企业（'households' 占位合法）、证券持仓/订单/类别→企业、
//    设备挂单→企业、政策/财政/税收→城市、债券持债→批次、active 银行贷款借款人、
//    消费贷 groupId、在位经营者 companyId、协议 sponsor/partner 城市；
// 3) 历史例外：allowHistoricalMissing 默认 true 时已兑付债券/已结清贷款允许悬空，
//    false 时报错；活跃数据两种口径都必须报错；
// 4) 每条坏数据只报一次，错误信息含路径与标识。
//
// 做法：以 `Simulation.create()` 的真实世界为基底，JSON 深拷贝后注入错误引用，
// 不修改真实世界对象；只依赖已完成的 referenceValidation.ts，不 import 未完成的 modules/**。

import { describe, expect, it } from 'vitest';
import type { WorldState } from '../../src/simulation/contracts/types';
import { Simulation } from '../../src/simulation/core/simulation';
import { validateCrossReferences } from '../../src/simulation/persistence/referenceValidation';

const GHOST_CITY = 'ghost-city';
const GHOST_COMPANY = 'ghost-company';
const GHOST_GROUP = 'ghost-investor-group';
const GHOST_ISSUANCE = 'ghost-bond-issuance';

function cloneWorld(world: WorldState): WorldState {
  return JSON.parse(JSON.stringify(world)) as WorldState;
}

/** 真实新开局世界的深拷贝（不能被注入测试污染）。 */
function baseWorld(): WorldState {
  return cloneWorld(Simulation.create().state);
}

function cityId(world: WorldState): string {
  return world.cities[0]!.id;
}

function companyId(world: WorldState): string {
  return world.companies[0]!.id;
}

/** 向数组推入一条“结构最小”的坏数据（校验器只读被检查字段，其余字段不参与）。 */
function pushEntry(list: unknown, entry: Record<string, unknown>): void {
  if (!Array.isArray(list)) throw new Error('目标数组不存在');
  list.push(entry);
}

/** 错误信息里同时包含全部片段（路径/标识）的条目。 */
function matching(errors: string[], ...fragments: string[]): string[] {
  return errors.filter((error) => fragments.every((fragment) => error.includes(fragment)));
}

function ensureBondState(world: WorldState): NonNullable<WorldState['bonds']> {
  world.bonds ??= {
    issuances: [],
    holdings: [],
    payments: [],
    nextIssuanceNumber: 1,
    nextHoldingNumber: 1,
    nextPaymentNumber: 1,
  };
  return world.bonds;
}

describe('跨模块引用校验：正常世界', () => {
  it('新开局真实世界：默认与严格历史口径都返回 0 错误（空数组）', () => {
    const world = baseWorld();
    expect(validateCrossReferences(world)).toEqual([]);
    expect(validateCrossReferences(world, { allowHistoricalMissing: false })).toEqual([]);
  });

  it('真实推进 2 个月后（已有贷款/债券/股票成交/财政流水/经营者）：仍 0 错误', () => {
    const sim = Simulation.create();
    expect(sim.tick().ok).toBe(true);
    expect(sim.tick().ok).toBe(true);
    const world = cloneWorld(sim.state);
    // 确认这个基底确实携带了跨模块数据（否则“0 错误”没有意义）。
    expect(world.banking.loans.length).toBeGreaterThan(0);
    expect(world.bonds?.holdings.length ?? 0).toBeGreaterThan(0);
    expect(world.securities.lastTrades.length).toBeGreaterThan(0);
    expect(world.fiscal.ledger.length).toBeGreaterThan(0);
    expect(world.management.operators.length).toBeGreaterThan(0);
    expect(validateCrossReferences(world)).toEqual([]);
    expect(validateCrossReferences(world, { allowHistoricalMissing: false })).toEqual([]);
  });
});

describe('跨模块引用校验：企业 / 贸易路线 / 协议的城市与企业引用', () => {
  it('企业指向不存在城市：报 companies[].cityId，含企业 id 与目标城市，且只报一次', () => {
    const world = baseWorld();
    world.companies[0]!.cityId = GHOST_CITY;
    const errors = validateCrossReferences(world);
    const hits = matching(errors, 'companies[].cityId', world.companies[0]!.id, GHOST_CITY);
    expect(hits).toHaveLength(1);
  });

  it('贸易路线引用不存在企业：报 from/toCompanyId；城市引用不存在也报', () => {
    const world = baseWorld();
    const route = world.tradeRoutes[0]!;
    route.fromCompanyId = GHOST_COMPANY;
    route.toCityId = GHOST_CITY;
    const errors = validateCrossReferences(world);
    expect(matching(errors, 'tradeRoutes[].fromCompanyId', GHOST_COMPANY)).toHaveLength(1);
    expect(matching(errors, 'tradeRoutes[].toCityId', GHOST_CITY)).toHaveLength(1);
  });

  it("贸易路线 'households' 占位合法：不产生企业引用错误", () => {
    const world = baseWorld();
    const route = world.tradeRoutes[0]!;
    route.fromCompanyId = 'households';
    route.toCompanyId = companyId(world);
    route.fromCityId = cityId(world);
    route.toCityId = cityId(world);
    const errors = validateCrossReferences(world);
    expect(matching(errors, 'tradeRoutes[].fromCompanyId')).toEqual([]);
    expect(matching(errors, 'tradeRoutes[].toCompanyId')).toEqual([]);
  });

  it('协议 sponsorCityId / partnerCityId 引用不存在城市：两条都能检出', () => {
    const world = baseWorld();
    pushEntry(world.agreements, {
      id: 'agreement-ghost-sponsor',
      title: '测试协议',
      sponsorCityId: GHOST_CITY,
      partnerCityId: cityId(world),
    });
    let errors = validateCrossReferences(world);
    expect(matching(errors, 'agreements[].sponsorCityId', GHOST_CITY)).toHaveLength(1);

    const world2 = baseWorld();
    pushEntry(world2.agreements, {
      id: 'agreement-ghost-partner',
      title: '测试协议',
      sponsorCityId: cityId(world2),
      partnerCityId: GHOST_CITY,
    });
    errors = validateCrossReferences(world2);
    expect(matching(errors, 'agreements[].partnerCityId', GHOST_CITY)).toHaveLength(1);
  });
});

describe('跨模块引用校验：证券 / 设备挂单', () => {
  it('股份类别引用不存在企业：报 securities.classes[].companyId', () => {
    const world = baseWorld();
    const shareClass = world.securities.classes[0]!;
    shareClass.companyId = GHOST_COMPANY;
    const errors = validateCrossReferences(world);
    expect(matching(errors, 'securities.classes[].companyId', GHOST_COMPANY)).toHaveLength(1);
  });

  it('活跃持仓引用不存在企业：报 securities.holdings[].companyId（含持仓所属企业 id）', () => {
    const world = baseWorld();
    const holding = world.securities.holdings.find((entry) => entry.shares > 0)!;
    expect(holding).toBeDefined();
    holding.companyId = GHOST_COMPANY;
    const errors = validateCrossReferences(world);
    expect(matching(errors, 'securities.holdings[].companyId', GHOST_COMPANY)).toHaveLength(1);
  });

  it('股票订单引用不存在企业：报 securities.orders[].companyId', () => {
    const world = baseWorld();
    pushEntry(world.securities.orders, { id: 'order-ghost', companyId: GHOST_COMPANY });
    const errors = validateCrossReferences(world);
    expect(matching(errors, 'securities.orders[].companyId', GHOST_COMPANY)).toHaveLength(1);
  });

  it('设备市场挂单引用不存在企业：报 equipmentMarket.offers[].companyId', () => {
    const world = baseWorld();
    pushEntry(world.equipmentMarket.offers, {
      id: 'used-offer-ghost',
      companyId: GHOST_COMPANY,
      cityId: cityId(world),
      kind: 'industry',
      units: 1,
      askPrice: 1000,
      listedTick: world.time.tick,
      note: '测试坏引用',
    });
    const errors = validateCrossReferences(world);
    expect(matching(errors, 'equipmentMarket.offers[].companyId', GHOST_COMPANY)).toHaveLength(1);
  });
});

describe('跨模块引用校验：政策 / 财政 / 税收的城市引用', () => {
  it('政策（活跃与历史）引用不存在城市：都能检出', () => {
    const world = baseWorld();
    pushEntry(world.policies.active, { id: 'policy-active-ghost', cityId: GHOST_CITY });
    pushEntry(world.policies.history, { id: 'policy-history-ghost', cityId: GHOST_CITY });
    const errors = validateCrossReferences(world);
    expect(matching(errors, 'policies[].cityId', GHOST_CITY)).toHaveLength(2);
  });

  it('财政流水引用不存在城市：报 fiscal.ledger[].cityId', () => {
    const world = baseWorld();
    pushEntry(world.fiscal.ledger, {
      id: 'fiscal-ghost',
      tick: world.time.tick,
      cityId: GHOST_CITY,
      kind: 'benefits',
      amount: 1,
      source: '测试坏引用',
    });
    const errors = validateCrossReferences(world);
    expect(matching(errors, 'fiscal.ledger[].cityId', GHOST_CITY)).toHaveLength(1);
  });

  it('税收历史与累计按城市键引用不存在城市：两个入口都能检出', () => {
    const world = baseWorld();
    world.taxes.historyByCity[GHOST_CITY] = [];
    world.taxes.accrualByCity[GHOST_CITY] = {
      consumptionTax: 0,
      dividendTax: 0,
    };
    const errors = validateCrossReferences(world);
    expect(matching(errors, 'taxes.historyByCity', GHOST_CITY)).toHaveLength(1);
    expect(matching(errors, 'taxes.accrualByCity', GHOST_CITY)).toHaveLength(1);
  });
});

describe('跨模块引用校验：债券 / 银行 / 居民消费贷', () => {
  it('债券发行批次城市不存在、持债与兑付流水引用不存在批次：各自报一次并含标识', () => {
    const world = baseWorld();
    const bonds = ensureBondState(world);
    pushEntry(bonds.issuances, {
      id: 'issuance-ghost-city',
      cityId: GHOST_CITY,
      issuedTick: 0,
    });
    pushEntry(bonds.holdings, {
      id: 'bond-holding-ghost',
      issuanceId: GHOST_ISSUANCE,
      cityId: cityId(world),
      holder: { kind: 'player', id: 'player' },
      units: 1,
      principal: 1000,
      purchasedTick: 0,
      interestStartTick: 0,
      maturityTick: 12,
      lastCouponTick: null,
      accruedInterest: 0,
      interestPaid: 0,
      redeemedTick: null,
      status: 'active',
      note: '测试坏引用',
    });
    pushEntry(bonds.payments, {
      id: 'bond-payment-ghost',
      tick: 0,
      issuanceId: GHOST_ISSUANCE,
      cityId: cityId(world),
      kind: 'coupon',
      amount: 1,
    });
    const errors = validateCrossReferences(world);
    expect(matching(errors, 'bonds.issuances[].cityId', GHOST_CITY)).toHaveLength(1);
    expect(matching(errors, 'bonds.holdings[].issuanceId', 'bond-holding-ghost', GHOST_ISSUANCE)).toHaveLength(1);
    expect(matching(errors, 'bonds.payments[].issuanceId', GHOST_ISSUANCE)).toHaveLength(1);
  });

  it('active 银行贷款借款人不存在：报 banking.loans[].borrower.id；存款所有者也校验', () => {
    const world = baseWorld();
    pushEntry(world.banking.loans, {
      id: 'loan-ghost-borrower',
      borrower: { kind: 'company', id: GHOST_COMPANY },
      status: 'active',
    });
    pushEntry(world.banking.deposits, {
      id: 'deposit-ghost-owner',
      owner: { kind: 'company', id: GHOST_COMPANY },
      balance: 0,
      rateMonthly: 0,
      accruedInterest: 0,
      lastInterestTick: 0,
      openedTick: 0,
      note: '测试坏引用',
    });
    const errors = validateCrossReferences(world);
    expect(matching(errors, 'banking.loans[].borrower.id', GHOST_COMPANY)).toHaveLength(1);
    expect(matching(errors, 'banking.deposits[].owner.id', GHOST_COMPANY)).toHaveLength(1);
  });

  it('居民消费贷 groupId 不存在：报 householdFinance.loans[].groupId 并含贷款 id', () => {
    const world = baseWorld();
    pushEntry(world.householdFinance.loans, {
      id: 'household-loan-ghost',
      groupId: GHOST_GROUP,
      status: 'active',
    });
    const errors = validateCrossReferences(world);
    expect(
      matching(errors, 'householdFinance.loans[].groupId', 'household-loan-ghost', GHOST_GROUP),
    ).toHaveLength(1);
  });
});

describe('跨模块引用校验：经营者与居民实体城市', () => {
  it('在位经营者 companyId 不存在：报 management.operators[].companyId', () => {
    const world = baseWorld();
    const operator = world.management.operators.find(
      (entry) => typeof entry.companyId === 'string' && entry.companyId.length > 0,
    )!;
    expect(operator).toBeDefined();
    operator.companyId = GHOST_COMPANY;
    const errors = validateCrossReferences(world);
    expect(matching(errors, 'management.operators[].companyId', GHOST_COMPANY)).toHaveLength(1);
  });

  it('居民群体 / 投资实体 cityId 不存在：报 households.groups[].cityId 与 investors[].cityId', () => {
    const world = baseWorld();
    world.households.groups[0]!.cityId = GHOST_CITY;
    world.investors[0]!.cityId = GHOST_CITY;
    const errors = validateCrossReferences(world);
    expect(matching(errors, 'households.groups[].cityId', GHOST_CITY)).toHaveLength(1);
    expect(matching(errors, 'investors[].cityId', GHOST_CITY)).toHaveLength(1);
  });
});

describe('跨模块引用校验：历史例外（allowHistoricalMissing）', () => {
  it('已兑付债券持债：默认允许持有人悬空；false 时报错', () => {
    const world = baseWorld();
    const bonds = ensureBondState(world);
    pushEntry(bonds.holdings, {
      id: 'bond-holding-redeemed',
      issuanceId: GHOST_ISSUANCE,
      cityId: cityId(world),
      holder: { kind: 'company', id: GHOST_COMPANY },
      units: 1,
      principal: 1000,
      purchasedTick: 0,
      interestStartTick: 0,
      maturityTick: 12,
      lastCouponTick: null,
      accruedInterest: 0,
      interestPaid: 0,
      redeemedTick: 12,
      status: 'redeemed',
      note: '历史已兑付',
    });
    // 先补上真实批次，只考察“持有人已删除”这一历史例外（批次引用仍必须存在）。
    pushEntry(bonds.issuances, {
      id: GHOST_ISSUANCE,
      cityId: cityId(world),
      issuedTick: 0,
    });
    expect(matching(validateCrossReferences(world), 'bond-holding-redeemed')).toEqual([]);
    const strictErrors = validateCrossReferences(world, { allowHistoricalMissing: false });
    // 持有人错误以“路径 + 缺失标识”定位：bonds.holdings[].holder.id: 引用了不存在的企业：ghost-company。
    expect(
      matching(strictErrors, 'bonds.holdings[].holder.id', GHOST_COMPANY),
    ).toHaveLength(1);
  });

  it('已结清银行贷款：默认允许借款人悬空；false 时报错', () => {
    const world = baseWorld();
    pushEntry(world.banking.loans, {
      id: 'loan-repaid-ghost-borrower',
      borrower: { kind: 'company', id: GHOST_COMPANY },
      status: 'repaid',
    });
    expect(matching(validateCrossReferences(world), 'loan-repaid-ghost-borrower')).toEqual([]);
    const strictErrors = validateCrossReferences(world, { allowHistoricalMissing: false });
    expect(matching(strictErrors, 'banking.loans[].borrower.id', GHOST_COMPANY)).toHaveLength(1);
  });

  it('已结清居民消费贷：默认允许居民群体悬空；false 时报错', () => {
    const world = baseWorld();
    pushEntry(world.householdFinance.loans, {
      id: 'household-loan-repaid',
      groupId: GHOST_GROUP,
      status: 'repaid',
    });
    expect(matching(validateCrossReferences(world), 'household-loan-repaid')).toEqual([]);
    const strictErrors = validateCrossReferences(world, { allowHistoricalMissing: false });
    expect(matching(strictErrors, 'householdFinance.loans[].groupId', GHOST_GROUP)).toHaveLength(1);
  });

  it('零股历史持仓允许企业已退市：默认不报，false 时报错', () => {
    const world = baseWorld();
    const holding = world.securities.holdings[0]!;
    holding.shares = 0;
    holding.companyId = GHOST_COMPANY;
    expect(matching(validateCrossReferences(world), 'securities.holdings[].companyId')).toEqual([]);
    const strictErrors = validateCrossReferences(world, { allowHistoricalMissing: false });
    expect(
      matching(strictErrors, 'securities.holdings[].companyId', GHOST_COMPANY),
    ).toHaveLength(1);
  });

  it('活跃数据不受历史例外影响：默认与 false 都必须报错', () => {
    const world = baseWorld();
    pushEntry(world.banking.loans, {
      id: 'loan-active-ghost-borrower',
      borrower: { kind: 'company', id: GHOST_COMPANY },
      status: 'active',
    });
    expect(
      matching(validateCrossReferences(world), 'banking.loans[].borrower.id', GHOST_COMPANY),
    ).toHaveLength(1);
    expect(
      matching(
        validateCrossReferences(world, { allowHistoricalMissing: false }),
        'banking.loans[].borrower.id',
        GHOST_COMPANY,
      ),
    ).toHaveLength(1);
  });
});

describe('跨模块引用校验：错误格式与单条数据只报一次', () => {
  it('错误信息以“路径: 说明”开头，包含坏标识；同一条坏数据只报一次', () => {
    const world = baseWorld();
    const company = world.companies[0]!;
    company.cityId = GHOST_CITY; // 唯一一处坏引用
    const errors = validateCrossReferences(world);
    expect(errors.length).toBeGreaterThan(0);
    for (const error of errors) {
      expect(error).toMatch(/^[A-Za-z][\w.[\]]*: /);
    }
    const companyErrors = errors.filter((error) => error.includes(company.id));
    expect(companyErrors).toHaveLength(1);
    expect(companyErrors[0]).toContain('companies[].cityId');
    expect(companyErrors[0]).toContain(GHOST_CITY);
  });

  it('多处坏引用各报一次（互不吞并、排名不重复）', () => {
    const world = baseWorld();
    world.companies[0]!.cityId = GHOST_CITY;
    const shareClass = world.securities.classes[0]!;
    shareClass.companyId = GHOST_COMPANY;
    pushEntry(world.equipmentMarket.offers, {
      id: 'used-offer-ghost-2',
      companyId: GHOST_COMPANY,
      cityId: cityId(world),
      kind: 'industry',
      units: 1,
      askPrice: 1000,
      listedTick: world.time.tick,
      note: '测试坏引用',
    });
    const errors = validateCrossReferences(world);
    expect(matching(errors, 'companies[].cityId', GHOST_CITY)).toHaveLength(1);
    expect(matching(errors, 'securities.classes[].companyId', GHOST_COMPANY)).toHaveLength(1);
    expect(matching(errors, 'equipmentMarket.offers[].companyId', GHOST_COMPANY)).toHaveLength(1);
    expect(errors).toHaveLength(3);
  });

  it('空数组世界的最小合法结构：无引用可查时返回空数组（旧档/空模块不误报）', () => {
    const world = baseWorld();
    // 清空所有可选/可空的跨模块集合（保留 cities/companies/investors 三个 ID 源）。
    world.tradeRoutes = [];
    world.agreements = [];
    world.securities.classes = [];
    world.securities.holdings = [];
    world.securities.orders = [];
    world.securities.offers = [];
    world.securities.lastTrades = [];
    world.securities.history = [];
    world.equipmentMarket.offers = [];
    world.management.operators = [];
    world.management.playerOperations = [];
    world.policies.active = [];
    world.policies.history = [];
    world.fiscal.ledger = [];
    world.taxes.historyByCity = {};
    world.taxes.accrualByCity = {};
    if (world.bonds) {
      world.bonds.issuances = [];
      world.bonds.holdings = [];
      world.bonds.payments = [];
    }
    world.banking.loans = [];
    world.banking.deposits = [];
    world.householdFinance.loans = [];
    world.households.investorFundingHistory = [];
    expect(validateCrossReferences(world)).toEqual([]);
  });
});
