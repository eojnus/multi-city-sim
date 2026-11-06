// v1.7 存档系统：长期运行存档规模与性能测试（任务书 §9.5）。
//
// 默认只跑 12 个月（快速、每次回归可承受）；36/72/120 月长跑通过环境变量开启：
//   LONG_RUN_SAVE=1 npx vitest run tests/persistence/long-run-save.test.ts --maxWorkers=1 --testTimeout=3600000
//
// 记录并输出：每个检查点的原始 JSON 字节（minified）、gzip 字节、serialize/parse 耗时、
// 进程内存（rss/heapUsed）、不变量、读档后能否继续推进。120 月目标：gzip ≤ 10 MiB
// （未达标时必须如实输出实际数字；测试会失败以标记目标未达成）。

import { describe, expect, it } from 'vitest';
import { gzipSync } from 'node:zlib';
import { Simulation } from '../../src/simulation/core/simulation';
import { checkInvariants } from '../../src/simulation/core/invariants';
import { parseSave, serializeSave } from '../../src/simulation/core/save';

const LONG_RUN = process.env.LONG_RUN_SAVE === '1';
const GZIP_TARGET_BYTES = 10 * 1024 * 1024;

interface Checkpoint {
  tick: number;
  rawBytes: number;
  gzipBytes: number;
  serializeMs: number;
  parseMs: number;
  rssMb: number;
  heapUsedMb: number;
  invariants: number;
  canContinue: boolean;
}

function measure(sim: Simulation): Checkpoint {
  const before = process.memoryUsage();
  const t0 = Date.now();
  const text = serializeSave(sim.state, { savedAt: '2026-11-07T00:00:00.000Z' });
  const serializeMs = Date.now() - t0;
  const rawBytes = Buffer.byteLength(text, 'utf8');
  const gzipBytes = gzipSync(Buffer.from(text, 'utf8'), { level: 6 }).length;
  const t1 = Date.now();
  const parsed = parseSave(text);
  const parseMs = Date.now() - t1;
  if (!parsed.ok || !parsed.world) throw new Error(`读档失败（tick ${sim.state.time.tick}）：${parsed.error}`);
  const invariants = checkInvariants(parsed.world).length;
  const after = process.memoryUsage();
  const loaded = new Simulation(parsed.world);
  const next = loaded.tick();
  return {
    tick: sim.state.time.tick,
    rawBytes,
    gzipBytes,
    serializeMs,
    parseMs,
    rssMb: Math.round(Math.max(before.rss, after.rss) / 1048576),
    heapUsedMb: Math.round(Math.max(before.heapUsed, after.heapUsed) / 1048576),
    invariants,
    canContinue: next.ok,
  };
}

describe('v1.7 存档：长期运行存档规模与性能', () => {
  it('12 个月：体积/耗时/不变量/读档后继续推进（每次回归必跑）', () => {
    const sim = Simulation.create();
    const checkpoints: Checkpoint[] = [];
    for (let month = 1; month <= 12; month += 1) {
      const result = sim.tick();
      if (result.ok === false) throw new Error(`第 ${month} 月推进失败：${result.error ?? ''}`);
      if (month === 12) checkpoints.push(measure(sim));
    }
    const checkpoint = checkpoints[0]!;
    // eslint-disable-next-line no-console
    console.log('[long-run-save] 12m', JSON.stringify(checkpoint));
    expect(checkpoint.invariants).toBe(0);
    expect(checkpoint.canContinue).toBe(true);
    expect(checkpoint.rawBytes).toBeGreaterThan(0);
    // 12 月远低于旧 64MiB 原始上限（防止序列化回归到膨胀格式）。
    expect(checkpoint.rawBytes).toBeLessThan(64 * 1024 * 1024);
  });

  it.skipIf(!LONG_RUN)('120 个月：压缩后 ≤10MiB 目标（LONG_RUN_SAVE=1 时运行）', () => {
    const sim = Simulation.create();
    const results: Checkpoint[] = [];
    for (let month = 1; month <= 120; month += 1) {
      const result = sim.tick();
      if (result.ok === false) throw new Error(`第 ${month} 月推进失败：${result.error ?? ''}`);
      if ([12, 36, 72, 120].includes(month)) results.push(measure(sim));
    }
    for (const checkpoint of results) {
      // eslint-disable-next-line no-console
      console.log('[long-run-save]', JSON.stringify(checkpoint));
    }
    const final = results[results.length - 1]!;
    expect(final.invariants).toBe(0);
    expect(final.canContinue).toBe(true);
    expect(final.gzipBytes).toBeLessThanOrEqual(GZIP_TARGET_BYTES);
  }, 3_600_000);
});
