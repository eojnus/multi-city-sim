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
    dividends: ledger.dividends,
    lastContributionTick: ledger.lastContributionTick,
    lastDividendTick: ledger.lastDividendTick,
  };
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
