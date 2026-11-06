// v1.7 存档系统：大载荷（超过旧 64MiB 原始数据）读写路径与内存实测。
//
// 任务书 §9.5 要求“超过旧 64 MiB 原始数据的读写路径也要专门测试，验证实际新限制和错误处理，
// 不得仅测试小存档”。这里用真实 v10 文档 + 一个很大的未知可选模块载荷构造 >64MiB 原始文本：
// - 未知可选模块按协议必须原样保留，因此不污染任何权威游戏状态；
// - 验证 128MiB 原始上限内可解析（保留未知模块）、超过 128MiB 在渲染层预检被拒绝；
// - 记录解析一次大载荷的进程内存增量，作为 128MiB 兜底值的安全依据（实际数字写入交付报告）。
//
// 该测试需要约 100–300MB 堆内存，2GB 容器内单独运行；不参与常规快速回归的默认并发。

import { describe, expect, it } from 'vitest';
import { Simulation } from '../../src/simulation/core/simulation';
import { parseSave, serializeSave } from '../../src/simulation/core/save';
import { MAX_SAVE_RAW_BYTES } from '../../src/simulation/persistence/types';
import { isSaveTextTooLarge, saveTextByteLength } from '../../src/platform/saveBridge';

/** 构造一个约 70MiB 的 v10 文档：真实世界 + 未知可选模块大载荷。 */
function buildLargeDocument(): { text: string; rawBytes: number; blobChars: number; memoryBefore: NodeJS.MemoryUsage } {
  const sim = Simulation.create();
  for (let index = 0; index < 2; index += 1) sim.tick();
  const base = JSON.parse(serializeSave(sim.state, { savedAt: '2026-11-07T00:00:00.000Z' })) as {
    modules: Record<string, unknown>;
  };
  // 70MiB 字符（UTF-8 下 ASCII 1 字节/字符）。
  const blobChars = 70 * 1024 * 1024;
  const blob = 'x'.repeat(blobChars);
  (base.modules as Record<string, unknown>).futureBulk = {
    version: 1,
    required: false,
    data: { blob },
  };
  const before = process.memoryUsage();
  const text = JSON.stringify(base);
  return { text, rawBytes: Buffer.byteLength(text, 'utf8'), blobChars, memoryBefore: before };
}

describe('v1.7 存档：超过旧 64MiB 原始数据的大载荷路径', () => {
  it('70MiB 原始 v10 文档在 128MiB 上限内可解析，未知可选模块原样保留，内存增量可测', () => {
    expect(MAX_SAVE_RAW_BYTES).toBe(128 * 1024 * 1024);
    const { text, rawBytes, blobChars } = buildLargeDocument();
    expect(rawBytes).toBeGreaterThan(64 * 1024 * 1024);
    expect(rawBytes).toBeLessThan(MAX_SAVE_RAW_BYTES);
    expect(isSaveTextTooLarge(text)).toBe(false);

    const memoryBeforeParse = process.memoryUsage();
    const started = Date.now();
    const parsed = parseSave(text);
    const parseMs = Date.now() - started;
    const memoryAfterParse = process.memoryUsage();
    // 记录真实数字（交付报告引用）；断言只做“不会失控”的宽松上限。
    // eslint-disable-next-line no-console
    console.log(
      '[large-save]',
      JSON.stringify({
        rawBytes,
        rawMiB: Math.round((rawBytes / 1048576) * 10) / 10,
        blobMiB: blobChars / 1048576,
        parseMs,
        rssDeltaMiB: Math.round((memoryAfterParse.rss - memoryBeforeParse.rss) / 1048576),
        heapDeltaMiB: Math.round((memoryAfterParse.heapUsed - memoryBeforeParse.heapUsed) / 1048576),
        rssTotalMiB: Math.round(memoryAfterParse.rss / 1048576),
      }),
    );
    expect(parsed.ok, parsed.error).toBe(true);
    if (!parsed.ok || !parsed.world) return;
    expect(parsed.preservedModules?.futureBulk).toBeDefined();
    const data = parsed.preservedModules?.futureBulk?.data as { blob: string };
    expect(data.blob.length).toBe(blobChars);
    expect(parsed.world.companies.length).toBeGreaterThan(0);
    // 内存增量上限：解析 70MiB JSON 不应超过约 1.2GB（2GB 容器里的安全边界；实测值见日志）。
    expect(memoryAfterParse.rss - memoryBeforeParse.rss).toBeLessThan(1200 * 1024 * 1024);
  });

  it('原始文本超过 128MiB 时渲染层预检拒绝（不依赖主进程解压/解析）', () => {
    // 用字符长度快速判断路径：ASCII 130Mi 字符 = 130MiB；不做 JSON 序列化以省内存。
    const oversized = 'x'.repeat(130 * 1024 * 1024);
    expect(saveTextByteLength(oversized)).toBeGreaterThan(MAX_SAVE_RAW_BYTES);
    expect(isSaveTextTooLarge(oversized)).toBe(true);
  });
});
