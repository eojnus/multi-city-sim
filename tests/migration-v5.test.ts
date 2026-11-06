// v4 → v5 存档迁移测试：居民群体、经营者、独立银行（含旧债务承接）。
//
// 说明：
// - 只写测试，不改产品代码；v4 存档由 tests/helpers/v5.ts 从当前世界“结构忠实降级”得到。
// - 旧存档文件测试使用 mkdtempSync(tmpdir()) 隔离目录，afterAll 清理，不写仓库外固定路径。
// - 金额断言统一用容差，不用浮点严格相等。

import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Simulation } from '../src/simulation/core/simulation';
import { migrateWorldV4ToV5, parseSave, serializeLegacySave, serializeSave } from '../src/simulation/core/save';
import { SAVE_FORMAT_VERSION } from '../src/simulation/contracts/types';
import { checkInvariants } from '../src/simulation/core/invariants';
import { round2 } from '../src/simulation/core/math';
import { DEMO_CONFIG } from '../src/data/config';
import { migrateLegacyCompanyDebt } from '../src/simulation/banking/banking';
import { currentStyle } from '../src/simulation/management/manager-pool';
import {
  OCCUPATIONS,
  householdGroupOf,
  occupationPeople,
} from '../src/simulation/population/household-groups';
import {
  currentWorld,
  sumOf,
  toV4,
  totalOwnerCash,
  v4SaveText,
  type AnyWorld,
} from './helpers/v5';

const SAVED_AT = '2026-11-01T00:00:00.000Z';
const AMOUNT_TOLERANCE = 0.05;

function expectAmount(actual: number, expected: number, tolerance = AMOUNT_TOLERANCE): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance);
}

/** 生成一份 v4 存档并迁移；默认推进 1 个月，得到包含真实资金流的世界。 */
function migrateV4(world = currentWorld(1)) {
  const v4 = toV4(world);
  const result = parseSave(v4SaveText(v4, SAVED_AT));
  expect(result.ok, result.error).toBe(true);
  return { v4, result, world: result.world! };
}

describe('v4 → v5 基本迁移', () => {
  it('迁移成功：migratedFrom=4、formatVersion 为当前版本、不变量为空、新结构齐全', () => {
    const { result, world } = migrateV4();
    expect(result.migratedFrom).toBe(4);
    expect(result.save?.formatVersion).toBe(SAVE_FORMAT_VERSION);
    expect(world.households).toBeDefined();
    expect(world.households.groups.length).toBeGreaterThan(0);
    expect(world.management).toBeDefined();
    expect(world.management.operators.length).toBeGreaterThan(0);
    expect(world.banking).toBeDefined();
    expect(Array.isArray(world.banking.loans)).toBe(true);
    expect(checkInvariants(world)).toEqual([]);
  });

  it('不造钱：迁移前后企业现金 + 玩家现金 + 投资实体现金完全一致，居民群体现金/存款为 0', () => {
    const source = currentWorld(2);
    const v4 = toV4(source);
    const beforeCash = totalOwnerCash(v4);
    const result = parseSave(v4SaveText(v4, SAVED_AT));
    expect(result.ok, result.error).toBe(true);
    const world = result.world!;

    expectAmount(totalOwnerCash(world), beforeCash);
    // 时间、随机状态、玩家现金都不能因迁移改变。
    expect(world.time).toEqual(v4.time);
    expect(world.seed).toBe(v4.seed);
    expect(world.rngState).toBe(v4.rngState);
    expectAmount(world.player.cash, v4.player.cash);

    expect(world.households.groups.length).toBeGreaterThan(0);
    for (const group of world.households.groups) expect(group.cash).toBe(0);
    const householdDeposits = sumOf(
      world.banking.deposits.filter((account) => account.owner.kind === 'household'),
      (account) => account.balance,
    );
    expectAmount(householdDeposits, 0);
  });
});

describe('v4 → v5 旧债务承接', () => {
  it('company.debt 转为 migratedDebt 合同：本金相等、镜像一致、幂等且不重复计息', () => {
    const source = currentWorld(1);
    const v4 = toV4(source);
    // 清空历史债务，只给目标企业设置一个明确金额，便于逐项比对。
    for (const company of v4.companies as AnyWorld[]) company.debt = 0;
    const target = (v4.companies as AnyWorld[]).find((company) => company.id === 'lp-food') ??
      (v4.companies as AnyWorld[])[0]!;
    const legacyDebt = 1_234_567;
    target.debt = legacyDebt;
    const targetCash = target.cash;

    const result = parseSave(v4SaveText(v4, SAVED_AT));
    expect(result.ok, result.error).toBe(true);
    const world = result.world!;
    const company = world.companies.find((entry) => entry.id === target.id)!;
    const migratdLoans = world.banking.loans.filter(
      (loan) =>
        loan.purpose === 'migratedDebt' &&
        loan.borrower.kind === 'company' &&
        loan.borrower.id === company.id,
    );
    expect(migratdLoans).toHaveLength(1);
    const loan = migratdLoans[0]!;
    const product = DEMO_CONFIG.banking.products.migratedDebt;

    expectAmount(loan.principal, legacyDebt);
    expectAmount(loan.outstanding, legacyDebt);
    expectAmount(loan.monthlyPrincipal, round2(legacyDebt / product.termMonths));
    expectAmount(company.debt, legacyDebt);
    // 承接债务不向企业注入现金。
    expectAmount(company.cash, targetCash);
    expect(loan.termMonths).toBe(product.termMonths);
    expect(loan.rateMonthly).toBeCloseTo(product.rateMonthly, 6);
    expect(loan.startTick).toBe(world.time.tick);
    expect(loan.nextDueTick).toBe(world.time.tick + 1);
    // 迁移当刻尚未计息（首期从下一月开始，按结算前剩余本金计算）。
    expectAmount(loan.accruedInterest, 0);
    expect(loan.payments).toHaveLength(0);

    // 幂等：再调一次迁移函数不新增合同、不改本金。
    const loanCount = world.banking.loans.length;
    expect(migrateLegacyCompanyDebt(world, DEMO_CONFIG, world.time.tick)).toBe(0);
    expect(world.banking.loans.length).toBe(loanCount);
    expectAmount(company.debt, legacyDebt);
    // 再跑一次完整 v4→v5 迁移同样不重复承接、不重复计息。
    const again = migrateWorldV4ToV5(world);
    expect(again.ok, again.error).toBe(true);
    const againLoans = again.world!.banking.loans.filter(
      (entry) => entry.purpose === 'migratedDebt' && entry.borrower.id === company.id,
    );
    expect(againLoans).toHaveLength(1);
    expectAmount(againLoans[0]!.principal, legacyDebt);
    expectAmount(
      again.world!.companies.find((entry) => entry.id === company.id)!.debt,
      legacyDebt,
    );
    expect(checkInvariants(world)).toEqual([]);
  });
});

describe('v4 → v5 经营者生成', () => {
  it('每家企业都有在任经营者，风格沿用迁移前 company.ai.style，且不改变企业资产与股份', () => {
    const { v4, world } = migrateV4(currentWorld(2));
    const beforeCompanies = v4.companies as AnyWorld[];
    const styles = new Map<string, string>(
      beforeCompanies.map((company) => [company.id as string, company.ai.style as string]),
    );
    const assets = new Map(
      beforeCompanies.map((company) => [
        company.id as string,
        {
          cash: company.cash as number,
          inventory: JSON.parse(JSON.stringify(company.inventory)) as Record<string, number>,
          capacity: company.capacity as number,
          totalShares: company.totalShares as number,
          employees: company.employees as number,
        },
      ]),
    );

    const employedOperatorIds = new Set<string>();
    for (const company of world.companies) {
      const control = world.governance.controls.find((entry) => entry.companyId === company.id);
      expect(control, `${company.id} 缺少控制权记录`).toBeDefined();
      expect(control!.operatorId).toBeTruthy();
      const operator = world.management.operators.find(
        (entry) => entry.id === control!.operatorId,
      );
      expect(operator, `${company.id} 的经营者档案不存在`).toBeDefined();
      expect(operator!.status).toBe('employed');
      expect(operator!.companyId).toBe(company.id);
      // 同一 AI 经营者不得同时经营两家企业。
      expect(employedOperatorIds.has(operator!.id)).toBe(false);
      employedOperatorIds.add(operator!.id);
      expect(currentStyle(world, company)).toBe(styles.get(company.id));

      const before = assets.get(company.id)!;
      expectAmount(company.cash, before.cash);
      expect(company.inventory).toEqual(before.inventory);
      expectAmount(company.capacity, before.capacity);
      expect(company.totalShares).toBe(before.totalShares);
      expect(company.employees).toBe(before.employees);
    }
    expect(employedOperatorIds.size).toBe(world.companies.length);
    expect(checkInvariants(world)).toEqual([]);
  });
});

describe('v4 → v5 人口与存档往返', () => {
  it('人群人数一致：迁移后每城 Σ household.people = city.population.total，且与派生口径一致', () => {
    const { world } = migrateV4(currentWorld(1));
    for (const city of world.cities) {
      const groups = world.households.groups.filter((group) => group.cityId === city.id);
      expect(groups.length).toBe(OCCUPATIONS.length);
      expect(sumOf(groups, (group) => group.people)).toBe(city.population.total);
      for (const occupation of OCCUPATIONS) {
        expect(householdGroupOf(world, city.id, occupation)!.people).toBe(
          occupationPeople(world, city, occupation),
        );
      }
    }
  });

  it('存档往返：迁移后再 serializeSave/parseSave，一次不变量为空且居民/经营者/银行状态一致', () => {
    const { world } = migrateV4(currentWorld(2));
    const parsed = parseSave(serializeSave(world, SAVED_AT));
    expect(parsed.ok, parsed.error).toBe(true);
    // 当前版本存档不再触发迁移。
    expect(parsed.migratedFrom).toBeUndefined();
    expect(parsed.save?.formatVersion).toBe(SAVE_FORMAT_VERSION);
    const restored = parsed.world!;

    expect(restored.households).toEqual(world.households);
    expect(restored.management).toEqual(world.management);
    expect(restored.banking).toEqual(world.banking);
    for (const company of restored.companies) {
      const original = world.companies.find((entry) => entry.id === company.id)!;
      expect(currentStyle(restored, company)).toBe(currentStyle(world, original));
    }
    expect(checkInvariants(restored)).toEqual([]);
  });
});

describe('v4 → v5 失败路径安全', () => {
  it('未来版本拒绝：formatVersion 高于当前版本时返回可读错误', () => {
    const text = serializeSave(Simulation.create().state, SAVED_AT);
    const raw = JSON.parse(text) as { formatVersion: number };
    raw.formatVersion = SAVE_FORMAT_VERSION + 1;
    const result = parseSave(JSON.stringify(raw));
    expect(result.ok).toBe(false);
    expect(typeof result.error).toBe('string');
    expect(result.error!.length).toBeGreaterThan(0);
    expect(result.error!).toContain('高于');
    expect(result.error!).toContain(String(SAVE_FORMAT_VERSION + 1));
  });

  it('损坏/缺字段安全失败：缺少 world、缺少 households、结构不足都返回 ok:false 而不是抛异常', () => {
    // “缺少 world”的旧档：用旧单体格式版本号（v10 文本用 modules，不经过 world 校验路径）。
    const missingWorld = parseSave(JSON.stringify({ formatVersion: SAVE_FORMAT_VERSION - 1 }));
    expect(missingWorld.ok).toBe(false);
    expect(missingWorld.error).toContain('world');

    // 当前版本存档删除 v0.4 新字段：不再走 v4 迁移，必须由结构校验拒绝。
    const raw = JSON.parse(serializeLegacySave(currentWorld(1), SAVED_AT)) as AnyWorld;
    delete raw.world.households;
    delete raw.world.management;
    delete raw.world.banking;
    expect(() => parseSave(JSON.stringify(raw))).not.toThrow();
    const missingHouseholds = parseSave(JSON.stringify(raw));
    expect(missingHouseholds.ok).toBe(false);
    expect(typeof missingHouseholds.error).toBe('string');
    expect(missingHouseholds.error!.length).toBeGreaterThan(0);
    expect(missingHouseholds.error!).toContain('households');

    // 其他字段也不足（只剩 seed/rngState）：只返回错误，不抛异常。
    const truncated = parseSave(
      JSON.stringify({ formatVersion: SAVE_FORMAT_VERSION, world: { seed: 1, rngState: 1 } }),
    );
    expect(truncated.ok).toBe(false);
    expect(typeof truncated.error).toBe('string');
    expect(truncated.error!.length).toBeGreaterThan(0);

    const brokenJson = parseSave('{ not json');
    expect(brokenJson.ok).toBe(false);
    expect(brokenJson.error).toContain('JSON');
  });
});

describe('隔离目录中的 v4 旧存档文件', () => {
  const dir = mkdtempSync(join(tmpdir(), 'city-v5-migration-'));

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('从磁盘读取 v4 存档：成功后迁移、失败可读，原文件字节始终不变', () => {
    const v4 = toV4(currentWorld(1));
    const legacyFile = join(dir, 'legacy-v4.json');
    writeFileSync(legacyFile, v4SaveText(v4, SAVED_AT), 'utf8');

    const legacyBytes = readFileSync(legacyFile);
    const result = parseSave(readFileSync(legacyFile, 'utf8'));
    expect(result.ok, result.error).toBe(true);
    expect(result.migratedFrom).toBe(4);
    expect(readFileSync(legacyFile).equals(legacyBytes)).toBe(true);

    // 失败路径（未来版本）同样不得改写原文件。
    const futureFile = join(dir, 'future-v6.json');
    const futureSave = JSON.parse(readFileSync(legacyFile, 'utf8')) as AnyWorld;
    futureSave.formatVersion = SAVE_FORMAT_VERSION + 1;
    writeFileSync(futureFile, JSON.stringify(futureSave, null, 2), 'utf8');
    const futureBytes = readFileSync(futureFile);
    const failed = parseSave(readFileSync(futureFile, 'utf8'));
    expect(failed.ok).toBe(false);
    expect(failed.error).toContain('高于');
    expect(readFileSync(futureFile).equals(futureBytes)).toBe(true);

    // 同样是 v4 文件但内容损坏（缺少 world 必需字段）：读取失败且原文件字节不变。
    const brokenFile = join(dir, 'broken-v4.json');
    writeFileSync(brokenFile, JSON.stringify({ formatVersion: 4, world: { seed: 1 } }), 'utf8');
    const brokenBytes = readFileSync(brokenFile);
    const brokenResult = parseSave(readFileSync(brokenFile, 'utf8'));
    expect(brokenResult.ok).toBe(false);
    expect(typeof brokenResult.error).toBe('string');
    expect(brokenResult.error!.length).toBeGreaterThan(0);
    expect(readFileSync(brokenFile).equals(brokenBytes)).toBe(true);

    expect(readdirSync(dir).sort()).toEqual([
      'broken-v4.json',
      'future-v6.json',
      'legacy-v4.json',
    ]);
  });
});
