// v1.2 §4：旧 v0.9 真实存档完整往返（读取 → 不变量 → 推进 1 月 → 保存 → 再读取）。
//
// fixture `tests/fixtures/v0.9-real-f942cc9.json` 由 f942cc9（v0.9 发布版）代码真实生成
// （详见 tests/fixtures/README.md 与 tests/legacy-v09-save.test.ts 的说明）：
//   git worktree add /tmp/v09-old f942cc9
//   ln -s /workspace/Coding/multi-city-sim/node_modules /tmp/v09-old/node_modules
//   在 /tmp/v09-old 用 tsx 运行 Simulation.create(DEMO_CONFIG) → 5 × tick() → 该版本 serializeSave
// 固定种子 seed=20261101、玩家无操作、默认 AI、推进 5 个月。
//
// 本文件关注 v1.2 验收的“完整往返”：旧档读取后不得因迁移重复改写企业数/现金/债务/股份/人口，
// v1.2 新增字段（居民投资份额账本等）必须在读取时补齐、且第二次保存/读取完全幂等。
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Simulation } from '../src/simulation/core/simulation';
import { parseSave, serializeSave } from '../src/simulation/core/save';
import { checkInvariants } from '../src/simulation/core/invariants';
import { equipmentCapacityFor } from '../src/simulation/equipment/equipment';
import { cityInvestorEquity } from '../src/simulation/population/household-groups';
import {
  effectiveInvestorShares,
  investorBondValue,
} from '../src/simulation/population/household-investment';
import { companySharePrice } from '../src/simulation/companies/company';
import { cityMarketPrices } from '../src/simulation/markets/markets';
import { round2 } from '../src/simulation/core/math';
import { DEMO_CONFIG } from '../src/data/config';
import type {
  HouseholdInvestorLedger,
  WorldState,
} from '../src/simulation/contracts/types';

const FIXTURE_URL = new URL('./fixtures/v0.9-real-f942cc9.json', import.meta.url);
const FIXTURE_TEXT = readFileSync(FIXTURE_URL, 'utf8');
const RAW_SAVE = JSON.parse(FIXTURE_TEXT) as {
  formatVersion: number;
  savedAt: string;
  world: any;
};
const RAW_WORLD = RAW_SAVE.world;
const COMPAT_LOG_PREFIX = '读取 v0.9 旧档';
const SAVED_AT = '2026-11-04T00:00:00.000Z';
const KINDS = ['farm', 'industry', 'energy'] as const;

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function loadLegacy(text = FIXTURE_TEXT): WorldState {
  const parsed = parseSave(text);
  if (!parsed.ok || !parsed.world) {
    throw new Error(`真实 v0.9 旧档读取失败：${parsed.error ?? '未知错误'}`);
  }
  return parsed.world;
}

function parseOrThrow(text: string): WorldState {
  const parsed = parseSave(text);
  if (!parsed.ok || !parsed.world) {
    throw new Error(`存档重新读取失败：${parsed.error ?? '未知错误'}`);
  }
  return parsed.world;
}

function equipmentUnits(company: {
  equipment: { farm: number; industry: number; energy: number };
}): number {
  return sum(KINDS.map((kind) => Number(company.equipment[kind] ?? 0)));
}

function ledgerSnapshot(ledger?: HouseholdInvestorLedger) {
  if (!ledger) return null;
  return {
    contributed: ledger.contributed,
    shares: ledger.shares,
    // v1.4 §3：有效份额 = shares + openingShares；往返后起始份额不得重算/漂移。
    openingShares: ledger.openingShares ?? null,
    effectiveShares: effectiveInvestorShares(ledger),
    dividends: ledger.dividends,
    lastContributionTick: ledger.lastContributionTick,
    lastDividendTick: ledger.lastDividendTick,
  };
}

/** 金额近似比较（分币级尾差容忍 0.11 元，覆盖多次 round2 的累计舍入）。 */
function expectMoneyClose(actual: number, expected: number): void {
  expect(Math.abs(actual - expected)).toBeLessThan(0.11);
}

/** 独立重算本城投资实体净资产 = 现金 + 持股市值 + 债券估值（v1.4 §3 口径）。 */
function recomputeCityInvestorNetWorth(world: WorldState, cityId: string): number {
  let cash = 0;
  let holdings = 0;
  let bonds = 0;
  for (const investor of world.investors.filter((entry) => entry.cityId === cityId)) {
    cash += investor.cash;
    bonds += investorBondValue(world, investor.id);
    for (const holding of world.securities.holdings) {
      if (holding.holder.type !== 'investorGroup' || holding.holder.id !== investor.id) continue;
      const company = world.companies.find((entry) => entry.id === holding.companyId);
      if (!company) continue;
      const city = world.cities.find((entry) => entry.id === company.cityId);
      if (!city) continue;
      holdings += holding.shares * companySharePrice(company, cityMarketPrices(city));
    }
  }
  return round2(cash + holdings + bonds);
}

/**
 * 结构快照：覆盖迁移可能重复改写的全部权威字段（企业数/现金/债务/股份/库存/设备/人口/
 * 居民群体与 v1.2 投资份额账本/投资实体现金/银行贷款/证券发行量）。
 * 用固定 savedAt 序列化后比较，可在不知道 v1.2 具体新增字段名的情况下验证幂等。
 */
function snapshot(world: WorldState) {
  return {
    tick: world.time.tick,
    seed: world.seed,
    populations: world.cities
      .map((city) => ({
        id: city.id,
        total: city.population.total,
        employed: city.population.employed,
        unemployed: city.population.unemployed,
        nonLabor: city.population.nonLabor,
        laborForce: city.population.laborForce,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    companies: world.companies
      .map((company) => ({
        id: company.id,
        cityId: company.cityId,
        cash: company.cash,
        debt: company.debt,
        totalShares: company.totalShares,
        employees: company.employees,
        capacity: company.capacity,
        equipmentCapacity: company.equipmentCapacity,
        remainder: company.equipmentCapacityRemainder ?? 0,
        equipmentUnits: equipmentUnits(company),
        inventory: Object.fromEntries(
          Object.entries(company.inventory).map(([goodId, qty]) => [goodId, qty]),
        ),
        // v1.3 存货成本：旧档没有该字段，读取时按市场价补齐；往返后账面成本不得漂移。
        inventoryCost: Object.fromEntries(
          Object.entries(company.inventoryCost ?? {}).sort(([a], [b]) => a.localeCompare(b)),
        ),
        cogs: company.lastMonth?.cogs ?? null,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    groups: world.households.groups
      .map((group) => ({
        id: group.id,
        cityId: group.cityId,
        occupation: group.occupation,
        people: group.people,
        cash: group.cash,
        ledger: ledgerSnapshot(group.investorLedger),
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    investors: world.investors
      .map((investor) => ({
        id: investor.id,
        cityId: investor.cityId,
        cash: investor.cash,
        populationShare: investor.populationShare,
        dividendsReceived: investor.dividendsReceived,
        lastDividend: investor.lastDividend,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    loans: world.banking.loans
      .map((loan) => ({
        id: loan.id,
        principal: loan.principal,
        outstanding: loan.outstanding,
        paidPrincipal: loan.paidPrincipal,
        paidInterest: loan.paidInterest,
        arrearsPrincipal: loan.arrearsPrincipal,
        arrearsInterest: loan.arrearsInterest,
        status: loan.status,
        payments: loan.payments.length,
        borrower: `${loan.borrower.kind}:${loan.borrower.id}`,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    classes: world.securities.classes
      .map((entry) => ({ id: entry.id, issuedShares: entry.issuedShares }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    compatLogs: world.log.filter((entry) => entry.message.startsWith(COMPAT_LOG_PREFIX))
      .length,
  };
}

describe('v1.2 旧 v0.9 真实档完整往返（读取 → 推进 1 月 → 保存 → 再读取）', () => {
  it('读取旧档：不变量为空，人口/企业数不因迁移重复变化', () => {
    const parsed = parseSave(FIXTURE_TEXT);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || !parsed.world) throw new Error(parsed.error);
    const world = parsed.world;

    expect(parsed.migratedFrom).toBeUndefined();
    expect(world.time.tick).toBe(5);
    // 旧档本身已是 v0.9 乘 5 后的人口；读取不得再乘 5。
    expect(world.cities.map((city) => [city.id, city.population.total])).toEqual(
      RAW_WORLD.cities.map((city: any) => [city.id, city.population.total]),
    );
    expect(world.cities.find((city) => city.id === 'lanport')!.population.total).toBe(600077);
    // 企业名单/数量与旧档完全一致，不追加 v1.0 的 48 家开局企业。
    expect(world.companies.map((company) => company.id)).toEqual(
      RAW_WORLD.companies.map((company: any) => company.id),
    );
    expect(world.companies).toHaveLength(RAW_WORLD.companies.length);

    expect(checkInvariants(world)).toEqual([]);
  });

  it('读取旧档不改变金额/债务/股份/库存/设备台数与投资份额', () => {
    const world = loadLegacy();
    const rawCompanies = RAW_WORLD.companies as any[];

    expect(sum(world.companies.map((company) => company.cash))).toBeCloseTo(
      sum(rawCompanies.map((company) => company.cash)),
      2,
    );
    expect(sum(world.companies.map((company) => company.debt))).toBeCloseTo(
      sum(rawCompanies.map((company) => company.debt)),
      2,
    );
    expect(sum(world.companies.map((company) => company.totalShares))).toBe(
      sum(rawCompanies.map((company) => company.totalShares)),
    );
    expect(sum(world.companies.map((company) => equipmentUnits(company)))).toBeLessThanOrEqual(
      sum(rawCompanies.map((company) => equipmentUnits(company))),
    );
    // 设备台数只允许为消除旧档取整伪影而减少，不得凭空新增可售设备。
    expect(sum(world.companies.map((company) => equipmentUnits(company)))).toBeGreaterThan(0);

    for (const company of world.companies) {
      expect(company.equipmentCapacityRemainder).toBeDefined();
      expect(Number.isFinite(company.equipmentCapacityRemainder)).toBe(true);
      expect(company.equipmentCapacityRemainder!).toBeGreaterThanOrEqual(0);
      expect(company.equipmentCapacity).toBeCloseTo(
        equipmentCapacityFor(world, company, DEMO_CONFIG),
        2,
      );

      // v1.2 投资份额账本：旧档若被补齐，必须是有限非负数值且份额口径自洽。
      for (const group of world.households.groups.filter(
        (entry) => entry.cityId === company.cityId,
      )) {
        const ledger = group.investorLedger;
        if (!ledger) continue;
        expect(Number.isFinite(ledger.contributed)).toBe(true);
        expect(Number.isFinite(ledger.shares)).toBe(true);
        expect(Number.isFinite(ledger.dividends)).toBe(true);
        expect(ledger.contributed).toBeGreaterThanOrEqual(-0.01);
        expect(ledger.shares).toBeGreaterThanOrEqual(-1e-9);
        expect(ledger.dividends).toBeGreaterThanOrEqual(-0.01);
      }
    }

    expect(sum(world.households.groups.map((group) => group.cash))).toBeCloseTo(
      sum((RAW_WORLD.households.groups as any[]).map((group) => group.cash)),
      2,
    );
    expect(sum(world.investors.map((group) => group.cash))).toBeCloseTo(
      sum((RAW_WORLD.investors as any[]).map((group) => group.cash)),
      2,
    );
    expect(sum(world.banking.loans.map((loan) => loan.outstanding))).toBeCloseTo(
      sum((RAW_WORLD.banking.loans as any[]).map((loan) => loan.outstanding)),
      2,
    );
  });

  it('第一次读取后保存再读取：结构快照完全一致（v1.2 新字段补齐幂等）', () => {
    const first = loadLegacy();
    const firstText = serializeSave(first, SAVED_AT);
    const second = parseOrThrow(firstText);
    const secondText = serializeSave(second, SAVED_AT);

    // 第二次保存文本必须与第一次逐字节一致：不允许重复补字段/重复迁移/重复记账。
    expect(secondText).toBe(firstText);
    expect(checkInvariants(second)).toEqual([]);
    expect(snapshot(second)).toEqual(snapshot(first));

    // 兼容日志只补一次；v1.2 若新增其他迁移日志也不得在第二次读取时重复追加。
    const firstCompat = first.log.filter((entry) =>
      entry.message.startsWith(COMPAT_LOG_PREFIX),
    ).length;
    const secondCompat = second.log.filter((entry) =>
      entry.message.startsWith(COMPAT_LOG_PREFIX),
    ).length;
    expect(firstCompat).toBe(1);
    expect(secondCompat).toBe(1);
  });

  it('推进 1 月 → 不变量空 → 保存 → 再读取：企业/现金/债务/股份/人口不重复变化', () => {
    const world = loadLegacy();
    const simulation = new Simulation(world, DEMO_CONFIG);
    const tickResult = simulation.tick();
    expect(tickResult.ok, tickResult.error).toBe(true);
    const advanced = simulation.state;
    expect(advanced.time.tick).toBe(6);
    expect(checkInvariants(advanced)).toEqual([]);

    const savedText = serializeSave(advanced, SAVED_AT);
    const reloaded = parseOrThrow(savedText);

    expect(reloaded.time.tick).toBe(6);
    expect(checkInvariants(reloaded)).toEqual([]);
    expect(snapshot(reloaded)).toEqual(snapshot(advanced));

    // 迁移（兼容补齐）没有让企业凭空增加或金额重复变化：以读取后的世界为基准逐项相等。
    expect(reloaded.companies.map((company) => company.id).sort()).toEqual(
      advanced.companies.map((company) => company.id).sort(),
    );
    expect(sum(reloaded.companies.map((company) => company.cash))).toBeCloseTo(
      sum(advanced.companies.map((company) => company.cash)),
      2,
    );
    expect(sum(reloaded.companies.map((company) => company.debt))).toBeCloseTo(
      sum(advanced.companies.map((company) => company.debt)),
      2,
    );
    expect(sum(reloaded.companies.map((company) => company.totalShares))).toBe(
      sum(advanced.companies.map((company) => company.totalShares)),
    );
    expect(reloaded.households.groups.map((group) => group.people).sort()).toEqual(
      advanced.households.groups.map((group) => group.people).sort(),
    );
    expect(reloaded.cities.map((city) => city.population.total)).toEqual(
      advanced.cities.map((city) => city.population.total),
    );
    expect(reloaded.banking.loans.map((loan) => loan.outstanding).sort()).toEqual(
      advanced.banking.loans.map((loan) => loan.outstanding).sort(),
    );
  });

  it('推进后再次保存→读取→保存：字节一致且设备/余量/投资份额不漂移', () => {
    const world = loadLegacy();
    const simulation = new Simulation(world, DEMO_CONFIG);
    expect(simulation.tick().ok).toBe(true);
    const first = serializeSave(simulation.state, SAVED_AT);

    const reloaded = parseOrThrow(first);
    const second = serializeSave(reloaded, SAVED_AT);
    expect(second).toBe(first);

    for (const company of reloaded.companies) {
      const before = simulation.state.companies.find((entry) => entry.id === company.id)!;
      expect(company.equipmentCapacityRemainder).toBeCloseTo(
        before.equipmentCapacityRemainder!,
        2,
      );
      expect(company.equipmentCapacity).toBeCloseTo(before.equipmentCapacity, 2);
      for (const kind of KINDS) {
        expect(company.equipment[kind]).toBe(before.equipment[kind]);
      }
    }
    expect(
      reloaded.households.groups.map((group) => ledgerSnapshot(group.investorLedger)),
    ).toEqual(
      simulation.state.households.groups.map((group) => ledgerSnapshot(group.investorLedger)),
    );
  });
});

// ---------------------------------------------------------------- v1.4 §7：新可选字段往返
//
// v1.4 新增字段全部是“可选、旧档缺省合法”：
// - company.initialEquipment / lifecycle.foundings[].initialEquipment（§4 实物出资）
// - policies.checkups（§5 AI 经济体检）与 active policy.tracking（§5 执行追踪）
// - investorLedger.openingShares（v1.2 已有，v1.4 §3 起计入债券估值的无主净资产归属）
// 旧 v0.9 真实档既没有这些字段，也不应被追溯补发/改写；推进一个月后新字段落盘，
// 必须能完整往返且二次序列化逐字节稳定（归一化幂等、不重复记账）。
describe('v1.4 旧 v0.9 真实档：新可选字段往返与归一化幂等', () => {
  it('fixture 确无 v1.4 可选字段；读取不追溯补发、不改资金/债务/股份/人口/债券', () => {
    // 先证明 fixture 是真实旧档：所有 v1.4 可选字段在原始 JSON 中都不存在。
    for (const company of RAW_WORLD.companies as any[]) {
      expect(company.initialEquipment).toBeUndefined();
    }
    expect(RAW_WORLD.policies.checkups).toBeUndefined();
    for (const policy of RAW_WORLD.policies.active as any[]) {
      expect(policy.tracking).toBeUndefined();
    }
    for (const founding of RAW_WORLD.lifecycle.foundings as any[]) {
      expect(founding.initialEquipment).toBeUndefined();
    }
    for (const group of RAW_WORLD.households.groups as any[]) {
      expect(group.investorLedger).toBeUndefined();
    }

    const world = loadLegacy();
    const rawCompanies = RAW_WORLD.companies as any[];

    // 旧档不乘人口、不追加开局企业。
    expect(world.time.tick).toBe(RAW_WORLD.time.tick);
    expect(world.cities.map((city) => [city.id, city.population.total])).toEqual(
      RAW_WORLD.cities.map((city: any) => [city.id, city.population.total]),
    );
    expect(world.companies.map((company) => company.id)).toEqual(
      rawCompanies.map((company: any) => company.id),
    );
    expect(sum(world.companies.map((company) => company.cash))).toBeCloseTo(
      sum(rawCompanies.map((company) => company.cash)),
      2,
    );
    expect(sum(world.companies.map((company) => company.debt))).toBeCloseTo(
      sum(rawCompanies.map((company) => company.debt)),
      2,
    );
    expect(sum(world.companies.map((company) => company.totalShares))).toBe(
      sum(rawCompanies.map((company) => company.totalShares)),
    );
    expect(world.seed).toBe(RAW_WORLD.seed);
    expect(world.rngState).toBe(RAW_WORLD.rngState);

    // 读取不得“追溯补发”v1.4 字段：旧企业/旧创办记录没有实物出资，旧档也没有体检记录。
    expect(world.companies.every((company) => company.initialEquipment === undefined)).toBe(true);
    expect(world.policies.checkups ?? []).toHaveLength(0);
    expect(world.policies.active.every((policy) => policy.tracking === undefined)).toBe(true);
    expect(
      world.lifecycle!.foundings.every((founding) => founding.initialEquipment === undefined),
    ).toBe(true);

    // 债券估值口径（v1.4 §3）：旧档 17 笔居民投资实体持债按“未到期本金 + 已计提未付利息”计入，
    // 且只读聚合不产生现金/不改变持债状态。
    const rawInvestorHoldings = (RAW_WORLD.bonds.holdings as any[]).filter(
      (holding) => holding.holder.kind === 'investorGroup' && holding.status === 'active',
    );
    expect(rawInvestorHoldings.length).toBeGreaterThan(0);
    const rawBondValue = sum(
      rawInvestorHoldings.map(
        (holding) => Math.max(0, holding.principal) + Math.max(0, holding.accruedInterest),
      ),
    );
    const loadedBondValue = sum(
      world.investors.map((investor) => investorBondValue(world, investor.id)),
    );
    expectMoneyClose(loadedBondValue, round2(rawBondValue));
    expect(sum(world.investors.map((investor) => investor.cash))).toBeCloseTo(
      sum((RAW_WORLD.investors as any[]).map((investor) => investor.cash)),
      2,
    );
    expect(
      world.bonds!.holdings.filter((holding) => holding.status === 'active'),
    ).toHaveLength(
      (RAW_WORLD.bonds.holdings as any[]).filter((holding) => holding.status === 'active').length,
    );
    expect(checkInvariants(world)).toEqual([]);
  });

  it('openingShares 一次性补齐且计入债券估值：有效份额 = 无主净资产，重复读取不重算', () => {
    const world = loadLegacy();
    for (const city of world.cities) {
      const groups = world.households.groups.filter((group) => group.cityId === city.id);
      expect(groups.length).toBeGreaterThan(0);
      for (const group of groups) {
        // 旧档读取后账本必须初始化，openingShares 显式写入（含 0），不能缺省。
        expect(group.investorLedger).toBeDefined();
        expect(group.investorLedger!.openingShares).toBeDefined();
        expect(Number.isFinite(group.investorLedger!.openingShares)).toBe(true);
        expect(group.investorLedger!.openingShares!).toBeGreaterThanOrEqual(0);
      }
      const contributed = round2(sum(groups.map((group) => Math.max(0, group.investorLedger?.shares ?? 0))));
      const opening = round2(sum(groups.map((group) => Math.max(0, group.investorLedger?.openingShares ?? 0))));
      const effective = round2(sum(groups.map((group) => effectiveInvestorShares(group.investorLedger))));
      // 有效份额合计 = 历史投入份额 + 起始份额，且差额恰好是无主旧资产（含债券估值）。
      expectMoneyClose(effective, round2(contributed + opening));
      expectMoneyClose(opening, round2(Math.max(0, cityInvestorEquity(world, city.id) - contributed)));
      // 独立重算净资产（现金 + 股票市值 + 债券估值），确保债券估值没有被漏计或重复计。
      expectMoneyClose(cityInvestorEquity(world, city.id), recomputeCityInvestorNetWorth(world, city.id));
    }

    // 归一化幂等：保存 → 再读取 → 再保存，文本逐字节一致，openingShares/债券估值不漂移。
    const firstText = serializeSave(world, SAVED_AT);
    const second = parseOrThrow(firstText);
    const secondText = serializeSave(second, SAVED_AT);
    expect(secondText).toBe(firstText);
    expect(second.households.groups.map((group) => ledgerSnapshot(group.investorLedger))).toEqual(
      world.households.groups.map((group) => ledgerSnapshot(group.investorLedger)),
    );
    expect(second.investors.map((investor) => investorBondValue(second, investor.id))).toEqual(
      world.investors.map((investor) => investorBondValue(world, investor.id)),
    );
    expect(checkInvariants(second)).toEqual([]);
  });

  it('推进 1 月：checkups/tracking/initialEquipment 落盘并可完整往返、二次序列化稳定', () => {
    const world = loadLegacy();
    const bondValueBefore = world.investors.map((investor) => investorBondValue(world, investor.id));

    const simulation = new Simulation(world, DEMO_CONFIG);
    const tickResult = simulation.tick();
    expect(tickResult.ok, tickResult.ok ? '' : tickResult.error).toBe(true);
    const advanced = simulation.state;
    const tick = advanced.time.tick;
    expect(tick).toBe(RAW_WORLD.time.tick + 1);
    expect(checkInvariants(advanced)).toEqual([]);

    // 1) §5 经济体检：本月每城一条，档位/预算/症状字段可核验。
    const checkups = advanced.policies.checkups ?? [];
    expect(checkups.length).toBeGreaterThanOrEqual(advanced.cities.length);
    for (const city of advanced.cities) {
      const checkup = checkups.find((entry) => entry.cityId === city.id && entry.tick === tick);
      expect(checkup, `${city.id} 缺少本月体检`).toBeDefined();
      expect(checkup!.laborForce).toBeGreaterThan(0);
      expect(checkup!.unemploymentRate).toBeGreaterThanOrEqual(0);
      expect(checkup!.unemploymentRate).toBeLessThanOrEqual(1);
      expect(Number.isFinite(checkup!.budget)).toBe(true);
      expect(checkup!.budget).toBeGreaterThanOrEqual(0);
      expect(['normal', 'strained', 'severe', 'crisis']).toContain(checkup!.tier);
      expect(checkup!.taxMonthsReal + checkup!.taxMonthsEstimated).toBe(12);
    }

    // 2) §5 执行追踪：本月结算过的在行政策留下 runs，记录金额不重复计支出。
    const tracked = advanced.policies.active.filter((policy) => (policy.tracking?.runs.length ?? 0) > 0);
    expect(tracked.length).toBeGreaterThan(0);
    for (const policy of advanced.policies.active) {
      const runs = policy.tracking?.runs ?? [];
      for (const run of runs) {
        expect(Number.isFinite(run.spent)).toBe(true);
        expect(run.spent).toBeGreaterThanOrEqual(-0.01);
        expect(run.spent).toBeLessThanOrEqual(policy.budget + 0.01);
        expect(Number.isFinite(run.fiscalImpact)).toBe(true);
        if (run.spent > 0.01) expect(run.fiscalImpact).toBeLessThanOrEqual(0);
        expect(run.periodMonths).toBeGreaterThanOrEqual(1);
      }
      // 执行记录只做“归属”，不得比政策实际支出记更多（防重复记账/重复扣费）。
      expect(sum(runs.map((run) => run.spent))).toBeLessThanOrEqual(policy.spent + 0.11);
    }

    // 3) §4 实物出资：本月新创办企业各 1 台、且只记一次。
    const newFoundings = advanced.lifecycle!.foundings.filter((founding) => founding.tick === tick);
    expect(newFoundings.length).toBeGreaterThan(0);
    for (const founding of newFoundings) {
      expect(founding.initialEquipment, `${founding.companyId} 缺少实物出资记录`).toBeDefined();
      const grant = founding.initialEquipment!;
      expect(grant.source).toBe('founderInKind');
      expect(grant.units).toBeGreaterThanOrEqual(1);
      expect(grant.valuation).toBeGreaterThan(0);
      expect(grant.grantedTick).toBe(tick);
      expect(grant.lockUntilTick).toBe(tick + 12);
      const company = advanced.companies.find((entry) => entry.id === founding.companyId);
      expect(company, `${founding.companyId} 创办后不存在`).toBeDefined();
      // 实物出资只计一次：企业设备台数 ≥ 实物出资台数，产能按台数独立推导一致。
      expect(company!.initialEquipment).toEqual(grant);
      expect(company!.equipment[grant.kind]).toBeGreaterThanOrEqual(grant.units);
      expect(company!.equipmentCapacity).toBeCloseTo(
        equipmentCapacityFor(advanced, company!, DEMO_CONFIG),
        2,
      );
    }
    // 旧企业不因读取/推进被追溯补发实物出资（只有本月新创办企业带该字段）。
    const newCompanyIds = new Set(newFoundings.map((founding) => founding.companyId));
    for (const company of advanced.companies) {
      if (company.initialEquipment) expect(newCompanyIds.has(company.id)).toBe(true);
    }

    // 4) 人口没有被推进再次乘 5；旧档投资份额与债券估值不变。
    for (const city of advanced.cities) {
      const raw = (RAW_WORLD.cities as any[]).find((entry) => entry.id === city.id)!;
      expect(city.population.total).toBeGreaterThan(raw.population.total * 0.9);
      expect(city.population.total).toBeLessThan(raw.population.total * 1.2);
    }
    // 迁移/人口变动只会在群体间转移有效份额（含 openingShares），不会产生负值或缺失账本。
    for (const group of advanced.households.groups) {
      expect(group.investorLedger).toBeDefined();
      expect(group.investorLedger!.openingShares).toBeDefined();
      expect(group.investorLedger!.openingShares!).toBeGreaterThanOrEqual(-0.01);
      expect(Number.isFinite(group.investorLedger!.openingShares)).toBe(true);
    }
    // 债券估值只读聚合：每笔投资实体净资产仍等于“未到期本金 + 已计提未付利息”，不产生新债。
    const rawActiveHoldings = advanced.bonds!.holdings.filter(
      (holding) => holding.holder.kind === 'investorGroup' && holding.status === 'active',
    );
    const independentBondValue = round2(
      sum(
        rawActiveHoldings.map(
          (holding) => Math.max(0, holding.principal) + Math.max(0, holding.accruedInterest),
        ),
      ),
    );
    expectMoneyClose(
      sum(advanced.investors.map((investor) => investorBondValue(advanced, investor.id))),
      independentBondValue,
    );
    for (const [index, value] of advanced.investors
      .map((investor) => investorBondValue(advanced, investor.id))
      .entries()) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(bondValueBefore[index])).toBe(true);
    }

    // 5) 保存 → 再读取：v1.4 新字段完整保留，结构/金额/债务/股份不重复变化。
    const savedText = serializeSave(advanced, SAVED_AT);
    const reloaded = parseOrThrow(savedText);
    expect(reloaded.policies.checkups).toEqual(advanced.policies.checkups);
    expect(
      reloaded.policies.active.map((policy) => policy.tracking ?? null),
    ).toEqual(advanced.policies.active.map((policy) => policy.tracking ?? null));
    expect(
      reloaded.companies
        .filter((company) => company.initialEquipment)
        .map((company) => [company.id, company.initialEquipment]),
    ).toEqual(
      advanced.companies
        .filter((company) => company.initialEquipment)
        .map((company) => [company.id, company.initialEquipment]),
    );
    expect(
      reloaded.lifecycle!.foundings
        .filter((founding) => founding.initialEquipment)
        .map((founding) => [founding.companyId, founding.initialEquipment]),
    ).toEqual(
      advanced.lifecycle!.foundings
        .filter((founding) => founding.initialEquipment)
        .map((founding) => [founding.companyId, founding.initialEquipment]),
    );
    expect(reloaded.households.groups.map((group) => ledgerSnapshot(group.investorLedger))).toEqual(
      advanced.households.groups.map((group) => ledgerSnapshot(group.investorLedger)),
    );
    expect(reloaded.investors.map((investor) => investorBondValue(reloaded, investor.id))).toEqual(
      advanced.investors.map((investor) => investorBondValue(advanced, investor.id)),
    );
    expect(sum(reloaded.companies.map((company) => company.cash))).toBeCloseTo(
      sum(advanced.companies.map((company) => company.cash)),
      2,
    );
    expect(sum(reloaded.companies.map((company) => company.debt))).toBeCloseTo(
      sum(advanced.companies.map((company) => company.debt)),
      2,
    );
    expect(sum(reloaded.companies.map((company) => company.totalShares))).toBe(
      sum(advanced.companies.map((company) => company.totalShares)),
    );
    expect(checkInvariants(reloaded)).toEqual([]);

    // 6) 二次序列化逐字节稳定（归一化幂等，不重复补字段/重复迁移）。
    expect(serializeSave(reloaded, SAVED_AT)).toBe(savedText);
  });
});
