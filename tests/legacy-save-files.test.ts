import { describe, expect, it, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Simulation } from '../src/simulation/core/simulation';
import { parseSave } from '../src/simulation/core/save';
import { checkInvariants } from '../src/simulation/core/invariants';

const dir = mkdtempSync(join(tmpdir(), 'city-save-migration-'));

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function worldAfterTicks() {
  const sim = Simulation.create();
  for (let index = 0; index < 4; index++) expect(sim.tick().ok).toBe(true);
  expect(sim.invest('lp-food', 400_000).ok).toBe(true);
  expect(sim.tick().ok).toBe(true);
  return sim.state;
}

/** 与运行时一致的降级：删除后续版本字段，生成结构忠实的旧存档文件。 */
function downgrade(world: Record<string, any>, version: 1 | 2 | 3): Record<string, any> {
  const clone = JSON.parse(JSON.stringify(world)) as Record<string, any>;
  if (version <= 3) {
    delete clone.transport;
    delete clone.politics;
    delete clone.policies;
    delete clone.fiscal;
    delete clone.lifecycle;
    for (const company of clone.companies) delete company.ai;
    for (const city of clone.cities) {
      delete city.workforce;
      delete city.housing;
      delete city.lastMonth.policySpending;
      delete city.lastMonth.transportSpending;
      city.technology.status = 'initial-only';
      city.politics.status = 'initial-only';
    }
  }
  if (version <= 2) {
    for (const motion of clone.governance.motions) delete motion.eligible;
  }
  if (version <= 1) {
    delete clone.securities;
    delete clone.governance;
    delete clone.investors;
    delete clone.agreements;
    delete clone.notifications;
    delete clone.player.roles;
    for (const city of clone.cities) {
      delete city.lastMonth.investorDividends;
      delete city.lastMonth.investableContribution;
    }
    for (const company of clone.companies) {
      delete company.previousMonth;
      delete company.dividendPayoutRatio;
      delete company.lastMonth.dividendIncome;
    }
  }
  return clone;
}

function writeLegacy(version: 1 | 2 | 3, world: Record<string, any>): string {
  const file = join(dir, `legacy-v${version}.json`);
  const text = JSON.stringify(
    {
      formatVersion: version,
      gameVersion: version === 1 ? '0.1.0' : '0.2.1',
      savedAt: '2026-11-01T00:00:00.000Z',
      world: downgrade(world, version),
    },
    null,
    2,
  );
  writeFileSync(file, text, 'utf8');
  return file;
}

describe('隔离目录中的 v1/v2/v3 旧存档文件迁移', () => {
  it('逐个读取真实文件，保留人口、企业、库存、资金、股份、时间与随机状态', () => {
    const before = worldAfterTicks();
    const files = [writeLegacy(1, before), writeLegacy(2, before), writeLegacy(3, before)];
    for (const [index, file] of files.entries()) {
      const version = (index + 1) as 1 | 2 | 3;
      const text = readFileSync(file, 'utf8');
      const result = parseSave(text);
      expect(result.ok, `${file}: ${result.error}`).toBe(true);
      expect(result.migratedFrom).toBe(version);
      const world = result.world!;
      expect(world.time).toEqual(before.time);
      expect(world.seed).toBe(before.seed);
      expect(world.rngState).toBe(before.rngState);
      expect(world.player.cash).toBeCloseTo(before.player.cash, 2);
      for (const company of world.companies) {
        const previous = before.companies.find((entry) => entry.id === company.id)!;
        expect(company.cash).toBeCloseTo(previous.cash, 2);
        expect(company.inventory).toEqual(previous.inventory);
        expect(company.ai).toBeDefined();
      }
      for (const city of world.cities) {
        const previous = before.cities.find((entry) => entry.id === city.id)!;
        expect(city.population).toEqual(previous.population);
      }
      for (const company of world.companies) {
        const issued = world.securities.classes
          .filter((shareClass) => shareClass.companyId === company.id)
          .reduce((sum, shareClass) => sum + shareClass.issuedShares, 0);
        expect(issued).toBeCloseTo(company.totalShares, 2);
      }
      expect(checkInvariants(world)).toEqual([]);
    }
    // 原始旧文件保持不变，迁移只在内存中进行。
    for (const [index, file] of files.entries()) {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { formatVersion: number };
      expect(parsed.formatVersion).toBe(index + 1);
    }
    const names = readdirSync(dir).sort();
    expect(names).toEqual(['legacy-v1.json', 'legacy-v2.json', 'legacy-v3.json']);
  });
});
