// v1.7 存档重构：旧档明文 / gzip 兼容与当前存档往返测试（backward compatibility）。
//
// 只验证存档文本层的公开契约（`parseSave` / `serializeSave`），不导入 persistence/modules/**，
// 也不依赖存档内部布局，因此 Lead 把 `serializeSave` 切换为 v10 模块化格式后本文件仍应通过：
// - 旧版真实明文 fixture（v0.9 f942cc9 生成，formatVersion=9）读取成功、不变量为空、重复读取幂等；
// - 同一文本 gzipSync 压缩后 gunzip 回文本再解析，结果与明文完全一致
//   （解压是存档层的职责；解析器只接收文本，本测试不跨界测试压缩落盘）；
// - 当前世界（Simulation.create() 推进 3 月）serialize → parse 往返：随机状态/时间/现金/持股/
//   贷款/债券/设备等权威字段一致、不变量为空、二次往返（规范形式）逐字节稳定；
// - 损坏输入（非 JSON / 截断 / 缺 formatVersion / 版本过高）返回 ok:false 且错误可读、不抛异常。
//
// 关于“世界 JSON 深相等”：v10 之后世界由模块快照重建，个别派生统计字段在重建时的同步时点可能
// 与源世界不同；因此这里比较“关键权威字段快照”（逐项 toEqual，失败信息能直接定位字段），并额外
// 断言二次往返的 JSON 完全相等（证明读取结果已是稳定规范形式），而不是对整个世界做一次字符串比较。
import { readFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import type {
  City,
  Company,
  HouseholdGroup,
  InvestorGroup,
  WorldState,
} from '../../src/simulation/contracts/types';
import { checkInvariants } from '../../src/simulation/core/invariants';
import { parseSave, serializeSave } from '../../src/simulation/core/save';
import type { ParseResult } from '../../src/simulation/core/save';
import { Simulation } from '../../src/simulation/core/simulation';

const FIXTURE_URL = new URL('../fixtures/v0.9-real-f942cc9.json', import.meta.url);
const FIXTURE_TEXT = readFileSync(FIXTURE_URL, 'utf8');
const FIXTURE_RAW = JSON.parse(FIXTURE_TEXT) as {
  formatVersion: number;
  gameVersion: string;
  savedAt: string;
  world: {
    seed: number;
    rngState: number;
    time: { year: number; month: number; tick: number };
    cities: { id: string; population: { total: number } }[];
    companies: { id: string; cash: number; debt: number; totalShares: number }[];
  };
};

function loadFixture(): WorldState {
  const parsed = parseSave(FIXTURE_TEXT);
  if (!parsed.ok || !parsed.world) {
    throw new Error(`真实 v0.9 旧档读取失败：${parsed.error ?? '未知错误'}`);
  }
  return parsed.world;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

/** 断言解析失败：不抛异常、ok:false、不返回世界、错误文本可读且匹配预期。 */
function expectParseFailure(text: string, errorPattern: RegExp): void {
  let result: ParseResult | undefined;
  expect(() => {
    result = parseSave(text);
  }).not.toThrow();
  expect(result).toBeDefined();
  const parsed = result as ParseResult;
  expect(parsed.ok).toBe(false);
  expect(parsed.world).toBeUndefined();
  expect(parsed.save).toBeUndefined();
  expect(typeof parsed.error).toBe('string');
  expect((parsed.error ?? '').length).toBeGreaterThan(0);
  expect(parsed.error).toMatch(errorPattern);
  // 错误信息不能是 "undefined" / "[object Object]" 之类的实现细节泄露。
  expect(parsed.error).not.toMatch(/undefined|\[object Object\]/);
}

// ---------------------------------------------------------------- 权威字段快照

/** 城市：人口/财政/市场（价格与真实成交）/政府债务账本（权威，不取派生趋势字段）。 */
function cityAuthority(city: City) {
  return {
    id: city.id,
    population: { ...city.population },
    treasury: city.treasury,
    incomeTaxRate: city.incomeTaxRate,
    corporateTaxRate: city.corporateTaxRate,
    unemploymentBenefit: city.unemploymentBenefit,
    nonLaborTransfer: city.nonLaborTransfer,
    householdIncomeLastMonth: city.householdIncomeLastMonth,
    gdp: city.gdp,
    market: Object.fromEntries(
      Object.entries(city.market).map(([goodId, market]) => [
        goodId,
        {
          price: market.price,
          supply: market.supply,
          demand: market.demand,
          sold: market.sold,
          unmetDemand: market.unmetDemand,
          closingStock: market.closingStock,
        },
      ]),
    ),
    governmentLoans: city.government.loans.map((loan) => ({
      id: loan.id,
      purpose: loan.purpose,
      status: loan.status,
      principal: loan.principal,
      paidPrincipal: loan.paidPrincipal,
      outstanding: loan.outstanding,
      accruedInterest: loan.accruedInterest,
      arrearsInterest: loan.arrearsInterest,
    })),
    payables: city.government.payables.map((payable) => ({
      id: payable.id,
      status: payable.status,
      principalDue: payable.principalDue,
      interestDue: payable.interestDue,
    })),
    // 注意：不比较 government.lastDebt（文档明确它是“最近一次结算趋势基准，不是权威账本”，
    // 重建后允许按权威贷款/债券明细重新同步）；bankruptcy 是权威状态镜像，保留比较。
    bankruptcy: city.government.bankruptcy,
  };
}

/** 企业：现金/债务/股份/库存（含账面成本）/设备资产（含维护费快照）/上月真实收支。 */
function companyAuthority(company: Company) {
  return {
    id: company.id,
    cityId: company.cityId,
    cash: company.cash,
    debt: company.debt,
    employees: company.employees,
    totalShares: company.totalShares,
    inventory: { ...company.inventory },
    inventoryCost: company.inventoryCost ? { ...company.inventoryCost } : null,
    equipment: { ...company.equipment },
    equipmentCapacity: company.equipmentCapacity,
    equipmentCapacityRemainder: company.equipmentCapacityRemainder,
    maintenanceBase: company.maintenanceBase ? { ...company.maintenanceBase } : null,
    maintenancePrices: company.maintenancePrices ? { ...company.maintenancePrices } : null,
    maintenanceArrears: company.maintenanceArrears ?? 0,
    initialEquipment: company.initialEquipment ? { ...company.initialEquipment } : null,
    lastMonth: {
      revenue: company.lastMonth.revenue,
      profit: company.lastMonth.profit,
      wagesPaid: company.lastMonth.wagesPaid,
    },
  };
}

function investorAuthority(investor: InvestorGroup) {
  return {
    id: investor.id,
    cityId: investor.cityId,
    cash: investor.cash,
    populationShare: investor.populationShare,
    dividendsReceived: investor.dividendsReceived,
  };
}

function householdGroupAuthority(group: HouseholdGroup) {
  return {
    id: group.id,
    cityId: group.cityId,
    occupation: group.occupation,
    people: group.people,
    cash: group.cash,
    ledger: group.investorLedger
      ? {
          contributed: group.investorLedger.contributed,
          shares: group.investorLedger.shares,
          openingShares: group.investorLedger.openingShares ?? 0,
          dividends: group.investorLedger.dividends,
          lastContributionTick: group.investorLedger.lastContributionTick,
          lastDividendTick: group.investorLedger.lastDividendTick,
        }
      : null,
    lastMonthIncome: group.lastMonth.income,
    lastMonthConsumption: group.lastMonth.consumption,
  };
}

/** 证券持股（股份数量为权威；总股数缓存由 classes 校验）。 */
function securitiesAuthority(world: WorldState) {
  return {
    classes: world.securities.classes.map((shareClass) => ({
      id: shareClass.id,
      companyId: shareClass.companyId,
      issuedShares: shareClass.issuedShares,
    })),
    holdings: world.securities.holdings.map((holding) => ({
      companyId: holding.companyId,
      shareClassId: holding.shareClassId,
      holder: `${holding.holder.type}:${holding.holder.id}`,
      shares: holding.shares,
    })),
    orders: world.securities.orders.map((order) => ({
      id: order.id,
      companyId: order.companyId,
      holder: `${order.holder.type}:${order.holder.id}`,
      side: order.side,
      shares: order.shares,
      limitPrice: order.limitPrice,
    })),
  };
}

/** 银行/居民/政府三类贷款（未偿本金、已还、状态为权威口径）。 */
function loanAuthority(world: WorldState) {
  return {
    bankLoans: world.banking.loans.map((loan) => ({
      id: loan.id,
      borrower: `${loan.borrower.kind}:${loan.borrower.id}`,
      purpose: loan.purpose,
      principal: loan.principal,
      paidPrincipal: loan.paidPrincipal,
      outstanding: loan.outstanding,
      accruedInterest: loan.accruedInterest,
      arrearsPrincipal: loan.arrearsPrincipal,
      arrearsInterest: loan.arrearsInterest,
      status: loan.status,
    })),
    deposits: world.banking.deposits.map((deposit) => ({
      id: deposit.id,
      owner: `${deposit.owner.kind}:${deposit.owner.id}`,
      balance: deposit.balance,
    })),
    householdLoans: world.householdFinance.loans.map((loan) => ({
      id: loan.id,
      cityId: loan.cityId,
      groupId: loan.groupId,
      principal: loan.principal,
      paidPrincipal: loan.paidPrincipal,
      outstanding: loan.outstanding,
      accruedInterest: loan.accruedInterest,
      arrearsPrincipal: loan.arrearsPrincipal,
      arrearsInterest: loan.arrearsInterest,
      status: loan.status,
    })),
    householdNextLoanNumber: world.householdFinance.nextLoanNumber,
  };
}

/** 债券：发行批次、持债明细、兑付流水（只比较笔数与关键金额，不伪造未发生的流水）。 */
function bondAuthority(world: WorldState) {
  const bonds = world.bonds;
  if (!bonds) return null;
  return {
    issuances: bonds.issuances.map((issuance) => ({
      id: issuance.id,
      cityId: issuance.cityId,
      status: issuance.status,
      faceValue: issuance.faceValue,
      soldUnits: issuance.soldUnits,
      principal: issuance.principal,
      accruedInterest: issuance.accruedInterest,
      interestPaid: issuance.interestPaid,
      couponsPaid: issuance.couponsPaid,
      principalRepaid: issuance.principalRepaid,
      arrearsInterest: issuance.arrearsInterest,
      redeemedTick: issuance.redeemedTick,
    })),
    holdings: bonds.holdings.map((holding) => ({
      id: holding.id,
      issuanceId: holding.issuanceId,
      holder: `${holding.holder.kind}:${holding.holder.id}`,
      units: holding.units,
      principal: holding.principal,
      accruedInterest: holding.accruedInterest,
      interestPaid: holding.interestPaid,
      status: holding.status,
    })),
    payments: bonds.payments.map((payment) => ({
      id: payment.id,
      tick: payment.tick,
      issuanceId: payment.issuanceId,
      kind: payment.kind,
      principalPaid: payment.principalPaid,
      interestPaid: payment.interestPaid,
      fundedByBankAdvance: payment.fundedByBankAdvance,
    })),
  };
}

/** 设备：企业持有量、政府开局库存、二手委托（未成交量也是权威资产）。 */
function equipmentAuthority(world: WorldState) {
  return {
    initialStock: { ...world.equipmentMarket.initialStock },
    lastMonthSold: { ...world.equipmentMarket.lastMonthSold },
    offers: world.equipmentMarket.offers.map((offer) => ({
      id: offer.id,
      companyId: offer.companyId,
      cityId: offer.cityId,
      kind: offer.kind,
      units: offer.units,
      askPrice: offer.askPrice,
      listedTick: offer.listedTick,
    })),
    pendingLedger: (world.equipmentMarket.pendingLedger ?? []).map((entry) => ({ ...entry })),
  };
}

/** 当前世界的关键权威字段快照（任务要求：随机状态/时间/现金/持股/贷款/债券/设备）。 */
function authoritativeSnapshot(world: WorldState) {
  return {
    seed: world.seed,
    rngState: world.rngState,
    time: { ...world.time },
    player: {
      cash: world.player.cash,
      homeCityId: world.player.homeCityId,
      holdings: world.player.holdings.map((holding) => ({ ...holding })),
      roles: { ...world.player.roles },
    },
    cities: world.cities.map(cityAuthority),
    companies: world.companies.map(companyAuthority),
    investors: world.investors.map(investorAuthority),
    householdGroups: world.households.groups.map(householdGroupAuthority),
    securities: securitiesAuthority(world),
    loans: loanAuthority(world),
    bonds: bondAuthority(world),
    equipment: equipmentAuthority(world),
  };
}

/** 世界的现金/股本/债券本金/设备台数汇总，作为“无凭空增减”的额外交叉校验。 */
function worldTotals(world: WorldState) {
  return {
    cityTreasury: sum(world.cities.map((city) => city.treasury)),
    companyCash: sum(world.companies.map((company) => company.cash)),
    investorCash: sum(world.investors.map((investor) => investor.cash)),
    householdCash: sum(world.households.groups.map((group) => group.cash)),
    playerCash: world.player.cash,
    depositBalance: sum(world.banking.deposits.map((deposit) => deposit.balance)),
    companyDebt: sum(world.companies.map((company) => company.debt)),
    totalShares: sum(world.securities.classes.map((shareClass) => shareClass.issuedShares)),
    bondPrincipal: sum(
      (world.bonds?.holdings ?? [])
        .filter((holding) => holding.status === 'active')
        .map((holding) => holding.principal),
    ),
    equipmentUnits: sum(
      world.companies.map(
        (company) => company.equipment.farm + company.equipment.industry + company.equipment.energy,
      ),
    ),
  };
}

describe('旧版存档兼容（真实明文 / gzip / 重复读取）', () => {
  it('真实 v0.9 fixture：明文读取成功、旧档数据不被改写、不变量为空且重复读取幂等', () => {
    const parsed = parseSave(FIXTURE_TEXT);
    expect(parsed.ok, parsed.error).toBe(true);
    expect(parsed.world).toBeDefined();
    expect(parsed.save).toBeDefined();
    // formatVersion=9 的旧档：v1.6.x 下为“当前版本、未迁移”（undefined），
    // v10 模块化重构后应报告 migratedFrom=9。两种都属于合理迁移结果。
    expect([undefined, 9]).toContain(parsed.migratedFrom);
    expect(typeof parsed.save?.formatVersion).toBe('number');
    expect(parsed.save!.formatVersion).toBeGreaterThanOrEqual(9);

    const world = parsed.world!;
    // 时间/随机状态：读取不得重跑开局或推进时间。
    expect(world.time).toEqual(FIXTURE_RAW.world.time);
    expect(world.time.tick).toBe(5);
    expect(world.seed).toBe(FIXTURE_RAW.world.seed);
    expect(world.rngState).toBe(FIXTURE_RAW.world.rngState);
    // 旧档人口是真实值，不得再乘 5；企业名单与数量不变。
    expect(
      world.cities.map((city) => [city.id, city.population.total]),
    ).toEqual(FIXTURE_RAW.world.cities.map((city) => [city.id, city.population.total]));
    expect(world.companies.map((company) => company.id)).toEqual(
      FIXTURE_RAW.world.companies.map((company) => company.id),
    );
    // 金额/债务/股本不因读取而跳变（旧档字段校验与迁移不得伪造资产）。
    expect(sum(world.companies.map((company) => company.cash))).toBeCloseTo(
      sum(FIXTURE_RAW.world.companies.map((company) => company.cash)),
      2,
    );
    expect(sum(world.companies.map((company) => company.debt))).toBeCloseTo(
      sum(FIXTURE_RAW.world.companies.map((company) => company.debt)),
      2,
    );
    expect(sum(world.companies.map((company) => company.totalShares))).toBe(
      sum(FIXTURE_RAW.world.companies.map((company) => company.totalShares)),
    );
    expect(checkInvariants(world)).toEqual([]);

    // 重复读取幂等：同一文本解析两次，世界完全一致（不累积兼容日志/迁移副作用）。
    const second = parseSave(FIXTURE_TEXT);
    expect(second.ok, second.error).toBe(true);
    expect(JSON.stringify(second.world)).toBe(JSON.stringify(world));
  });

  it('旧版 gzip：gzipSync 压缩后 gunzip 回文本再解析，结果与明文完全一致', () => {
    const plain = parseSave(FIXTURE_TEXT);
    expect(plain.ok, plain.error).toBe(true);

    const compressed = gzipSync(Buffer.from(FIXTURE_TEXT, 'utf8'));
    expect(compressed.length).toBeLessThan(Buffer.byteLength(FIXTURE_TEXT, 'utf8'));
    // 解压是存档层职责：解析器只接收解压后的文本。
    const decompressed = gunzipSync(compressed).toString('utf8');
    expect(decompressed).toBe(FIXTURE_TEXT);

    const fromGzip = parseSave(decompressed);
    expect(fromGzip.ok, fromGzip.error).toBe(true);
    expect(fromGzip.migratedFrom).toBe(plain.migratedFrom);
    expect(JSON.stringify(fromGzip.world)).toBe(JSON.stringify(plain.world));
    expect(checkInvariants(fromGzip.world!)).toEqual([]);
  });
});

describe('当前存档往返（serializeSave → parseSave）', () => {
  function createAdvancedWorld(months: number): WorldState {
    const sim = Simulation.create();
    for (let month = 0; month < months; month += 1) {
      const result = sim.tick();
      expect(result.ok, result.error).toBe(true);
    }
    return sim.state;
  }

  it('推进 3 月后往返：随机状态/时间/现金/持股/贷款/债券/设备等权威字段一致、不变量为空', () => {
    const source = createAdvancedWorld(3);
    const savedAt = '2026-11-07T00:00:00.000Z';
    const text = serializeSave(source, savedAt);

    const parsed = parseSave(text);
    expect(parsed.ok, parsed.error).toBe(true);
    expect(parsed.world).toBeDefined();
    expect(parsed.save).toBeDefined();
    expect(parsed.migratedFrom).toBeUndefined();
    expect(parsed.save!.savedAt).toBe(savedAt);
    const restored = parsed.world!;

    // 关键权威字段逐项一致（失败时 toEqual 能直接定位到具体字段）。
    expect(authoritativeSnapshot(restored)).toEqual(authoritativeSnapshot(source));
    expect(worldTotals(restored)).toEqual(worldTotals(source));
    expect(checkInvariants(restored)).toEqual([]);
    // 源世界未被读取过程改写：同一 savedAt 重新序列化得到完全相同的文本。
    expect(serializeSave(source, savedAt)).toBe(text);

    // 二次往返幂等：读取结果已是稳定规范形式（新格式/旧格式都应成立），不重复迁移、不重复计账。
    const second = parseSave(serializeSave(restored, savedAt));
    expect(second.ok, second.error).toBe(true);
    expect(JSON.stringify(second.world)).toBe(JSON.stringify(restored));
    expect(checkInvariants(second.world!)).toEqual([]);
  });

  it('当前存档 gzip 压缩往返：压缩后解压文本解析与明文解析结果一致（压缩不改变内容）', () => {
    const source = createAdvancedWorld(3);
    const text = serializeSave(source, '2026-11-07T00:00:00.000Z');
    const plain = parseSave(text);
    expect(plain.ok, plain.error).toBe(true);

    const compressed = gzipSync(Buffer.from(text, 'utf8'));
    const decompressed = gunzipSync(compressed).toString('utf8');
    expect(decompressed).toBe(text);
    const fromGzip = parseSave(decompressed);
    expect(fromGzip.ok, fromGzip.error).toBe(true);
    expect(JSON.stringify(fromGzip.world)).toBe(JSON.stringify(plain.world));
  });
});

describe('损坏存档输入（不得抛异常，错误可读）', () => {
  it('非 JSON 文本：ok:false 且提示不是有效 JSON', () => {
    expectParseFailure('this is not a save file', /JSON/);
  });

  it('截断 JSON：ok:false 且提示不是有效 JSON', () => {
    expectParseFailure(FIXTURE_TEXT.slice(0, 4096), /JSON/);
  });

  it('缺少 formatVersion：ok:false 且提示 formatVersion 无效', () => {
    expectParseFailure(JSON.stringify({ world: { seed: 1 } }), /formatVersion/);
  });

  it('formatVersion 非整数 / 非数字：ok:false 且提示 formatVersion 无效', () => {
    expectParseFailure(JSON.stringify({ formatVersion: '9', world: {} }), /formatVersion/);
    expectParseFailure(JSON.stringify({ formatVersion: 9.5, world: {} }), /formatVersion/);
  });

  it('formatVersion 高于当前支持版本：ok:false 且提示需要更新游戏', () => {
    expectParseFailure(JSON.stringify({ formatVersion: 9999, world: {} }), /高于当前支持/);
  });

  it('根节点不是对象：ok:false 且提示根节点无效', () => {
    expectParseFailure(JSON.stringify([1, 2, 3]), /根节点/);
    expectParseFailure('null', /JSON|根节点/);
  });
});
