import { describe, expect, it, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SAVE_FORMAT_VERSION } from '../src/simulation/contracts/types';
import { serializeSave } from '../src/simulation/core/save';
import { Simulation } from '../src/simulation/core/simulation';

const requireCjs = createRequire(import.meta.url);
const { verifySaveFile } = requireCjs('../scripts/save-format-check.cjs') as {
  verifySaveFile: (options: {
    savesDir: string;
    slot: string;
    storeFormatVersion: unknown;
  }) => {
    ok: boolean;
    error: string | null;
    fileFormatVersion: unknown;
    fileGameVersion: unknown;
    fileBytes: number | null;
    listing: string[];
  };
};

const root = mkdtempSync(join(tmpdir(), 'city-save-format-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function isolatedDir(name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('桌面验证脚本的存档格式断言（读取真实文件）', () => {
  it('读取本次实际产生的存档并与游戏当前版本比较', () => {
    const dir = isolatedDir('ok');
    const text = serializeSave(Simulation.create().state, '2026-11-02T00:00:00.000Z');
    writeFileSync(join(dir, 'manual-1.json'), text, 'utf8');
    const result = verifySaveFile({ savesDir: dir, slot: 'manual-1', storeFormatVersion: SAVE_FORMAT_VERSION });
    expect(result.ok, result.error ?? '').toBe(true);
    expect(result.fileFormatVersion).toBe(SAVE_FORMAT_VERSION);
    expect(result.fileGameVersion).toBe('0.3.0');
    expect(result.fileBytes).toBeGreaterThan(0);
    expect(result.listing).toContain('manual-1.json');
  });

  it('文件版本与当前游戏格式不一致时明确失败', () => {
    const dir = isolatedDir('mismatch');
    writeFileSync(
      join(dir, 'manual-1.json'),
      JSON.stringify({ formatVersion: 2, gameVersion: '0.2.1', world: {} }),
      'utf8',
    );
    const result = verifySaveFile({ savesDir: dir, slot: 'manual-1', storeFormatVersion: SAVE_FORMAT_VERSION });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('不一致');
    expect(result.error).toContain('formatVersion=2');
  });

  it('文件缺失、非法 JSON、版本缺失与版本非整数都安全失败', () => {
    const dir = isolatedDir('broken');
    const missing = verifySaveFile({ savesDir: dir, slot: 'manual-1', storeFormatVersion: 4 });
    expect(missing.ok).toBe(false);
    expect(missing.error).toContain('未找到');

    writeFileSync(join(dir, 'manual-1.json'), '{not json', 'utf8');
    const invalid = verifySaveFile({ savesDir: dir, slot: 'manual-1', storeFormatVersion: 4 });
    expect(invalid.ok).toBe(false);
    expect(invalid.error).toContain('不是有效 JSON');

    writeFileSync(join(dir, 'manual-1.json'), JSON.stringify({ gameVersion: '0.3.0' }), 'utf8');
    const noVersion = verifySaveFile({ savesDir: dir, slot: 'manual-1', storeFormatVersion: 4 });
    expect(noVersion.ok).toBe(false);
    expect(noVersion.error).toContain('不是整数');

    writeFileSync(join(dir, 'manual-1.json'), JSON.stringify({ formatVersion: '4' }), 'utf8');
    const stringVersion = verifySaveFile({ savesDir: dir, slot: 'manual-1', storeFormatVersion: 4 });
    expect(stringVersion.ok).toBe(false);
    expect(stringVersion.error).toContain('不是整数');
  });

  it('脚本自身的期望版本来自运行中的游戏，而不是硬编码数字', () => {
    const dir = isolatedDir('dynamic');
    writeFileSync(join(dir, 'manual-1.json'), JSON.stringify({ formatVersion: 99 }), 'utf8');
    // 若脚本硬编码 4，此用例会失败；动态读取时 99 应与 store 版本一致。
    const dynamic = verifySaveFile({ savesDir: dir, slot: 'manual-1', storeFormatVersion: 99 });
    expect(dynamic.ok, dynamic.error ?? '').toBe(true);
  });

  it('检查失败时不删除、不覆盖原存档文件', () => {
    const dir = isolatedDir('preserve');
    const file = join(dir, 'manual-1.json');
    const text = JSON.stringify({ formatVersion: 2, world: { keep: true } });
    writeFileSync(file, text, 'utf8');
    const result = verifySaveFile({ savesDir: dir, slot: 'manual-1', storeFormatVersion: SAVE_FORMAT_VERSION });
    expect(result.ok).toBe(false);
    expect(requireCjs('node:fs').readFileSync(file, 'utf8')).toBe(text);
  });
});
