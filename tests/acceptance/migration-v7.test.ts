// 验收 H 组：存档迁移 v1–v6 → v7（AC-H01–H07）。
// 目标：迁移结构、负财政余额转贷款、GDP 估计条目、全链兼容、往返幂等、安全失败。
// 当前预期状态：save.ts 迁移与 initializer 估计已由块0 实现，本组应转绿；
// 与结算相关的 H08/H09（到期/破产双路径、重复结算）依赖块2，暂不在本文件。
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSave, serializeSave } from '../../src/simulation/core/save';
import { checkInvariants } from '../../src/simulation/core/invariants';
import { SAVE_FORMAT_VERSION } from '../../src/simulation/contracts/types';
import type { WorldState } from '../../src/simulation/contracts/types';
import { DEMO_CONFIG } from '../../src/data/config';
import {
  cityById,
  legacySaveText,
  newWorld,
  saveObject,
  totalMoney,
} from './helpers';

describe('H01 v6→v7 结构迁移', () => {
  it('旧 v6 档加载成功：migratedFrom=6、补齐债券/居民金融/政府/GDP 窗口，且不变量为空', () => {
    const before = newWorld(2);
    const beforeMoney = totalMoney(before);
    const result = parseSave(legacySaveText(before, 6));
    expect(result.ok, result.error).toBe(true);
    expect(result.migratedFrom).toBe(6);
    expect(result.save?.formatVersion).toBe(SAVE_FORMAT_VERSION);

    const world = result.world!;
    expect(world.bonds?.issuances).toEqual([]);
    expect(world.bonds?.holdings).toEqual([]);
    expect(world.householdFinance?.loans).toEqual([]);
    for (const city of world.cities) {
      expect(city.government).toBeDefined();
      expect(city.government!.loans).toEqual([]);
      expect(city.government!.payables).toEqual([]);
      expect(city.government!.advances).toEqual([]);
      expect(city.government!.bankruptcy.status).toBe('solvent');
      expect(city.bankruptcy?.status).toBe('solvent');
      expect(city.gdpWindow?.length).toBe(12);
      expect(city.gdpEstimate).not.toBeNull();
    }
    // 迁移不改真实金钱：财政余额/企业现金/玩家现金合计不变。
    expect(totalMoney(world)).toBeCloseTo(beforeMoney, 2);
    expect(checkInvariants(world)).toEqual([]);
  });

  it('迁移日志为 public 且不含任何财政金额（不把余额写进明文）', () => {
    const result = parseSave(legacySaveText(newWorld(1), 6));
    expect(result.ok, result.error).toBe(true);
    const world = result.world!;
    const entry = world.log.find((item) => item.message.includes('已从 v6 迁移到 v7'));
    expect(entry).toBeDefined();
    expect(entry!.visibility).toEqual({ scope: 'public', cityId: null });
    for (const city of world.cities) {
      expect(entry!.message).not.toContain(String(city.treasury));
    }
  });
});

describe('H02 旧档负财政余额等额转政府贷款', () => {
  it('负余额转为 purpose=government 的等额贷款、财政归零，不额外发钱且不追溯利息', () => {
    const before = newWorld(0);
    const target = cityById(before, 'lanport');
    target.treasury = -1_234_567.89;
    const moneyBefore = totalMoney(before);

    const result = parseSave(legacySaveText(before, 6));
    expect(result.ok, result.error).toBe(true);
    const world = result.world!;
    const city = cityById(world, 'lanport');
    expect(city.treasury).toBe(0);
    expect(city.government!.loans.length).toBe(1);
    const loan = city.government!.loans[0]!;
    expect(loan.purpose).toBe('government');
    expect(loan.principal).toBeCloseTo(1_234_567.89, 2);
    expect(loan.outstanding).toBeCloseTo(1_234_567.89, 2);
    expect(loan.paidPrincipal).toBe(0);
    expect(loan.paidInterest).toBe(0);
    expect(loan.accruedInterest).toBe(0);
    expect(loan.arrearsInterest).toBe(0);
    expect(loan.startTick).toBe(world.time.tick);
    expect(loan.status).toBe('active');
    // 财政余额从负变 0 属于债务转换记账：其他主体现金不变，货币总量只差这笔账。
    expect(totalMoney(world)).toBeCloseTo(moneyBefore + 1_234_567.89, 2);
    // 迁移说明不得出现该金额明文。
    const entry = world.log.find((item) => item.message.includes('已从 v6 迁移到 v7'))!;
    expect(entry.message).not.toContain('1234567');
    expect(entry.message).not.toContain('1,234,567');
    expect(checkInvariants(world)).toEqual([]);
  });

  it('重复读档幂等：同一旧档读两次、以及迁移后再保存读取，都不重复转贷', () => {
    const before = newWorld(0);
    cityById(before, 'greenfield').treasury = -800_000;
    const text = legacySaveText(before, 6);
    const first = parseSave(text);
    const second = parseSave(text);
    expect(first.ok, first.error).toBe(true);
    expect(second.ok, second.error).toBe(true);
    const loans = (world: WorldState) => cityById(world, 'greenfield').government!.loans.length;
    expect(loans(first.world!)).toBe(1);
    expect(loans(second.world!)).toBe(1);

    // 迁移后的 v7 存档再次保存/读取：不再触发迁移，也不新增贷款。
    const v7Text = serializeSave(first.world!, '2026-11-01T00:00:00.000Z');
    const reread = parseSave(v7Text);
    expect(reread.ok, reread.error).toBe(true);
    expect(reread.migratedFrom).toBeUndefined();
    expect(loans(reread.world!)).toBe(1);
    expect(cityById(reread.world!, 'greenfield').treasury).toBe(0);
  });
});

describe('H03 GDP 判定窗口迁移与估计标注', () => {
  it('真实历史保留为 estimated=false，缺口用负数 tick 的估计月补齐且估计值带标注', () => {
    const before = newWorld(2);
    const beforeHistory = new Map(before.cities.map((city) => [city.id, [...city.gdpHistory]]));
    const result = parseSave(legacySaveText(before, 6));
    expect(result.ok, result.error).toBe(true);
    const world = result.world!;

    for (const city of world.cities) {
      const history = beforeHistory.get(city.id)!;
      const window = city.gdpWindow ?? [];
      expect(window.length).toBe(12);
      // 真实历史不被改写、不被冒充成估计值。
      expect(city.gdpHistory.length).toBe(history.length);
      for (const point of history) {
        expect(city.gdpHistory.find((entry) => entry.tick === point.tick)?.value).toBe(point.value);
      }
      const real = window.filter((point) => !point.estimated);
      expect(real.length).toBe(history.filter((point) => !point.estimated).length);
      for (const point of real) {
        expect(point.tick).toBeGreaterThan(0);
      }
      const estimated = window.filter((point) => point.estimated);
      expect(estimated.length).toBe(12 - real.length);
      for (const point of estimated) {
        expect(point.tick).toBeLessThan(0);
      }
      // tick 升序。
      for (let index = 1; index < window.length; index += 1) {
        expect(window[index]!.tick).toBeGreaterThan(window[index - 1]!.tick);
      }
      // 估计来源标注不能为空，且年化 = 月 × 12。
      expect(city.gdpEstimate!.utilizationAssumption).toBe(
        DEMO_CONFIG.government.gdpEstimate.utilizationAssumption,
      );
      expect(city.gdpEstimate!.annualValue).toBeCloseTo(
        city.gdpEstimate!.monthlyValue * 12,
        2,
      );
      expect(city.gdpEstimate!.createdAtTick).toBe(world.time.tick);
      expect(city.gdpEstimate!.monthlyValue).toBeGreaterThan(0);
    }
    expect(checkInvariants(world)).toEqual([]);
  });
});

describe('H04 v1–v6 全链兼容', () => {
  for (const version of [1, 2, 3, 4, 5, 6] as const) {
    it(`v${version} 旧档可迁移到 v7：migratedFrom=${version}、结构完整、不变量为空`, () => {
      const before = newWorld(0);
      const moneyBefore = totalMoney(before);
      const result = parseSave(legacySaveText(before, version));
      expect(result.ok, result.error).toBe(true);
      expect(result.migratedFrom).toBe(version);
      expect(result.save?.formatVersion).toBe(SAVE_FORMAT_VERSION);
      const world = result.world!;
      expect(world.cities.length).toBe(before.cities.length);
      expect(world.companies.length).toBe(before.companies.length);
      expect(world.time).toEqual(before.time);
      expect(world.seed).toBe(before.seed);
      expect(world.player.cash).toBeCloseTo(before.player.cash, 2);
      for (const city of world.cities) {
        expect(city.gdpWindow?.length).toBe(12);
        expect(city.gdpWindow!.every((point) => point.estimated)).toBe(true);
      }
      expect(totalMoney(world)).toBeCloseTo(moneyBefore, 2);
      expect(checkInvariants(world)).toEqual([]);
    });
  }
});

describe('H05 迁移往返幂等', () => {
  it('旧档→迁移→保存→再读：状态一致、不再迁移、不重复转换', () => {
    const first = parseSave(legacySaveText(newWorld(1), 6));
    expect(first.ok, first.error).toBe(true);
    const again = parseSave(serializeSave(first.world!, '2026-11-01T00:00:00.000Z'));
    expect(again.ok, again.error).toBe(true);
    expect(again.migratedFrom).toBeUndefined();
    expect(again.world!.cities.map((city) => city.treasury)).toEqual(
      first.world!.cities.map((city) => city.treasury),
    );
    expect(again.world!.cities.map((city) => city.government!.loans.length)).toEqual(
      first.world!.cities.map((city) => city.government!.loans.length),
    );
    expect(again.world!.bonds).toEqual(first.world!.bonds);
    expect(again.world!.cities.map((city) => city.gdpWindow)).toEqual(
      first.world!.cities.map((city) => city.gdpWindow),
    );
    // 二次读取不得重复追加迁移日志。
    const migrationLogs = again.world!.log.filter((entry) =>
      entry.message.includes('已从 v6 迁移到 v7'),
    );
    expect(migrationLogs.length).toBe(1);
  });
});

describe('H06 迁移不覆盖用户存档文件', () => {
  it('只读旧档文件迁移：文件字节不变、目录不新增文件', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qa-legacy-readonly-'));
    try {
      const file = join(dir, 'legacy-v6.json');
      const text = legacySaveText(newWorld(1), 6);
      writeFileSync(file, text, 'utf8');
      const before = readFileSync(file);
      const parsed = parseSave(readFileSync(file, 'utf8'));
      expect(parsed.ok, parsed.error).toBe(true);
      expect(parsed.migratedFrom).toBe(6);
      expect(readFileSync(file).equals(before)).toBe(true);
      expect(readdirSync(dir)).toEqual(['legacy-v6.json']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('H07 安全失败', () => {
  it('损坏 JSON / 未来版本 / 缺关键字段返回可读错误而不是抛异常', () => {
    const broken = parseSave('{ 这不是 json');
    expect(broken.ok).toBe(false);
    expect(broken.error).toBeTruthy();

    const future = JSON.parse(legacySaveText(newWorld(0), 6));
    future.formatVersion = 99;
    const futureResult = parseSave(JSON.stringify(future));
    expect(futureResult.ok).toBe(false);
    expect(futureResult.error).toContain('高于');

    const missing = saveObject(newWorld(0));
    missing.formatVersion = 6;
    missing.world.cities = [];
    const missingResult = parseSave(JSON.stringify(missing));
    expect(missingResult.ok).toBe(false);
    expect(missingResult.error).toBeTruthy();
  });
});
