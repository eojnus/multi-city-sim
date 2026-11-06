// v1.6.1 桌面存档凭证兼容 + v1.7 三层大小口径（IPC / 编码层回归）。
//
// 分工（避免重复）：
// - 旧单体文本的 parseSave 迁移/损坏输入语义 → tests/persistence/backward-compatibility.test.ts（bank-dev）；
// - 本文件只测**平台层**：IPC handler 的旧明文/旧 gzip 读取、统一 gzip 写入、三层大小文案、
//   saves:list 元数据与坏文件隔离、渲染层 UTF-8 字节预检、浏览器 localStorage 限制说明；
// - 写失败/并发串行/原档保护 → tests/persistence/save-failure-protection.test.ts。
//
// v1.6.1 的桌面存档是“明文 pretty JSON / 旧 gzip（≥4MiB 阈值压缩）”产物；v1.7 起写盘统一 gzip、
// 原始文本上限 128MiB、压缩文件/解压输出 64MiB/128MiB 两层保护、列表 size 口径=解压后原始字节。
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

// 用假 ipcMain 捕获真实 handler（不启动 Electron），直接验证 electron/saveIpc.ts。
const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => Promise<any>>(),
}));
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: any[]) => Promise<any>) => {
      handlers.set(channel, handler);
    },
  },
}));

import { Simulation } from '../src/simulation/core/simulation';
import { parseSave, serializeLegacySave } from '../src/simulation/core/save';
import { checkInvariants } from '../src/simulation/core/invariants';
import {
  MAX_SAVE_COMPRESSED_BYTES as PERSIST_MAX_COMPRESSED,
  MAX_SAVE_RAW_BYTES as PERSIST_MAX_RAW,
} from '../src/simulation/persistence/types';
import {
  DEFAULT_SAVE_LIMITS,
  MAX_SAVE_COMPRESSED_BYTES,
  MAX_SAVE_RAW_BYTES,
  SAVE_LIMIT_MESSAGES,
  decodeSavePayload,
  encodeSavePayload,
  isGzipPayload,
  registerSaveHandlers,
  tooLargeMessage,
} from '../electron/saveIpc';
import {
  BROWSER_STORAGE_LIMITATION,
  MAX_SAVE_RAW_BYTES as BRIDGE_MAX_RAW,
  SAVE_RAW_TOO_LARGE_ERROR,
  createSaveBridge,
  isSaveTextTooLarge,
  saveTextByteLength,
} from '../src/platform/saveBridge';
import type { SaveBridge } from '../src/platform/saveBridge';

async function ipc(channel: string, ...args: unknown[]): Promise<any> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`未注册 IPC handler：${channel}`);
  return handler({}, ...args);
}

let savesDir = '';
let cachedLegacyText: string | null = null;

function saveFiles(): string[] {
  try {
    return readdirSync(savesDir).sort();
  } catch {
    return [];
  }
}

function slotPath(slot: string): string {
  return join(savesDir, `${slot}.json`);
}

/**
 * 旧单体格式（formatVersion 9）存档文本，模拟 v1.6.1 桌面产物：明文 JSON。
 * 用 core/save.ts 的 serializeLegacySave（Lead 提供的旧档测试入口），不手写格式。
 */
function legacySaveText(savedAt = '2026-11-01T00:00:00.000Z'): string {
  return serializeLegacySave(Simulation.create().state, savedAt);
}

function cachedLegacy(): string {
  cachedLegacyText ??= legacySaveText();
  return cachedLegacyText;
}

beforeEach(() => {
  savesDir = mkdtempSync(join(tmpdir(), 'v17-save-'));
  handlers.clear();
  registerSaveHandlers(() => savesDir);
});

afterEach(() => {
  rmSync(savesDir, { recursive: true, force: true });
});

describe('三层大小口径与常量单一来源（parity）', () => {
  it('parity：persistence ↔ electron ↔ saveBridge 的 128MiB/64MiB 数值与错误文案完全一致', () => {
    // 三个数值：persistence/types.ts 是单一来源，electron/saveIpc.ts 是拷贝，saveBridge 再导出。
    expect(PERSIST_MAX_RAW).toBe(128 * 1024 * 1024);
    expect(PERSIST_MAX_COMPRESSED).toBe(64 * 1024 * 1024);
    expect(MAX_SAVE_RAW_BYTES).toBe(PERSIST_MAX_RAW);
    expect(MAX_SAVE_COMPRESSED_BYTES).toBe(PERSIST_MAX_COMPRESSED);
    expect(BRIDGE_MAX_RAW).toBe(PERSIST_MAX_RAW);
    expect(DEFAULT_SAVE_LIMITS).toEqual({
      rawBytes: PERSIST_MAX_RAW,
      compressedBytes: PERSIST_MAX_COMPRESSED,
    });
    // 错误文案字符串：渲染层写前预检与主进程写盘失败必须逐字相同。
    expect(SAVE_RAW_TOO_LARGE_ERROR).toBe(tooLargeMessage('raw', true));
    expect(SAVE_RAW_TOO_LARGE_ERROR).toContain('128MiB');
  });

  it('三层“存档过大”文案写到对应限制，且不再残留旧 8MB/64MB 单一口径', () => {
    expect(SAVE_LIMIT_MESSAGES.raw).toContain('128MiB');
    expect(SAVE_LIMIT_MESSAGES.raw).not.toContain('未写入');
    expect(tooLargeMessage('raw', true)).toContain('未写入');
    expect(SAVE_LIMIT_MESSAGES.compressed).toContain('64MiB');
    expect(SAVE_LIMIT_MESSAGES.decompressed).toContain('128MiB');
    expect(SAVE_LIMIT_MESSAGES.plainFile).toContain('128MiB');
    // 不再残留 v1.6 的 8MB / 单一口径 64MB 文案。
    for (const message of Object.values(SAVE_LIMIT_MESSAGES)) {
      expect(message).not.toContain('8MB');
      expect(message).not.toContain('超过 64MB');
    }
  });

  it('encodeSavePayload 写盘统一 gzip（不再有“≥4MiB 才压缩”阈值）', async () => {
    // 仅 ~1KB 的文本也必须压缩（旧实现 <4MiB 会存明文）；含重复内容以保证 gzip 收益可断言。
    const small = JSON.stringify({ formatVersion: 9, world: { note: '小存档也压缩', pad: 'x'.repeat(2000) } });
    const encoded = await encodeSavePayload(small);
    expect(encoded.ok, encoded.error).toBe(true);
    expect(encoded.compressedBytes).toBeLessThan(encoded.rawBytes!);
    expect(isGzipPayload(encoded.buffer!)).toBe(true);
    expect(encoded.rawBytes).toBe(Buffer.byteLength(small, 'utf8'));
    const decoded = await decodeSavePayload(encoded.buffer!);
    expect(decoded.ok).toBe(true);
    expect(decoded.compressed).toBe(true);
    expect(decoded.text).toBe(small);
    expect(decoded.rawBytes).toBe(encoded.rawBytes);
  });

  it('三层保护分别返回对应文案与 too-large（注入小上限覆盖边界路径）', async () => {
    // 第一层：原始文本超限，压缩前拒绝。
    const tooBigRaw = await encodeSavePayload('x'.repeat(2000), { rawBytes: 1000, compressedBytes: 1024 });
    expect(tooBigRaw.ok).toBe(false);
    expect(tooBigRaw.code).toBe('too-large');
    expect(tooBigRaw.error).toBe(tooLargeMessage('raw', true));

    // 第二层：压缩结果超过磁盘上限。
    const incompressible = Array.from({ length: 300 }, (_, i) => `${i % 10}${i}`).join('') + Date.now();
    const tooBigCompressed = await encodeSavePayload(
      JSON.stringify({ formatVersion: 10, world: incompressible, pad: incompressible }),
      { rawBytes: 1024 * 1024, compressedBytes: 8 },
    );
    expect(tooBigCompressed.ok).toBe(false);
    expect(tooBigCompressed.code).toBe('too-large');
    expect(tooBigCompressed.error).toBe(tooLargeMessage('compressed', true));

    // 第三层：解压输出超过原始上限（压缩文件本身很小）。
    const bomb = gzipSync(Buffer.from('a'.repeat(5000), 'utf8'));
    const tooBigDecompressed = await decodeSavePayload(bomb, {
      rawBytes: 1000,
      compressedBytes: 1024 * 1024,
    });
    expect(tooBigDecompressed.ok).toBe(false);
    expect(tooBigDecompressed.code).toBe('too-large');
    expect(tooBigDecompressed.error).toBe(tooLargeMessage('decompressed'));
  });

  it('旧明文文件与磁盘 gzip 文件超过各自磁盘上限时被拒绝（注入小上限，不整体读入）', async () => {
    // 明文旧档 >128MiB 上限（注入小上限，避免真实分配 128MiB）。
    registerSaveHandlers(() => savesDir, { limits: { rawBytes: 1024 } });
    writeFileSync(slotPath('big-plain'), '{"formatVersion":9,"world":{}}'.padEnd(2000, ' '));
    const plain = await ipc('saves:read', 'big-plain');
    expect(plain.ok).toBe(false);
    expect(plain.code).toBe('too-large');
    expect(plain.error).toBe(tooLargeMessage('plainFile'));

    // gzip 文件 >64MiB 压缩上限（注入小上限 + 真实小 gzip）。
    const gz = gzipSync(Buffer.alloc(4096, 0x61));
    writeFileSync(slotPath('big-gzip'), gz);
    registerSaveHandlers(() => savesDir, { limits: { compressedBytes: gz.length - 1 } });
    const gzipRead = await ipc('saves:read', 'big-gzip');
    expect(gzipRead.ok).toBe(false);
    expect(gzipRead.code).toBe('too-large');
    expect(gzipRead.error).toBe(tooLargeMessage('compressed'));
  });
});

describe('IPC 写入：统一 gzip + 原子替换', () => {
  it('旧单体文本经 IPC 写入后落盘为 gzip，读回逐字节一致且可 parseSave', async () => {
    const text = cachedLegacy();
    const rawBytes = Buffer.byteLength(text, 'utf8');
    const write = await ipc('saves:write', 'manual-1', text);
    expect(write.ok, JSON.stringify(write)).toBe(true);
    expect(write.compressed).toBe(true);
    expect(write.bytes).toBe(rawBytes);
    expect(write.diskBytes).toBeLessThan(rawBytes);

    const fileBytes = readFileSync(slotPath('manual-1'));
    expect(isGzipPayload(fileBytes)).toBe(true);
    expect(fileBytes.length).toBe(write.diskBytes);
    expect(statSync(slotPath('manual-1')).size).toBe(fileBytes.length);

    const read = await ipc('saves:read', 'manual-1');
    expect(read.ok, JSON.stringify(read)).toBe(true);
    expect(read.text).toBe(text);
    const parsed = parseSave(read.text);
    expect(parsed.ok, parsed.error).toBe(true);
    expect(checkInvariants(parsed.world!)).toEqual([]);
  });

  it('覆盖写入使用 temp+rename+.bak 语义，成功后不残留临时/备份文件', async () => {
    const first = legacySaveText('2026-11-01T00:00:00.000Z');
    const second = legacySaveText('2026-11-02T00:00:00.000Z');
    expect((await ipc('saves:write', 'manual-2', first)).ok).toBe(true);
    expect((await ipc('saves:write', 'manual-2', second)).ok).toBe(true);
    expect(saveFiles()).toEqual(['manual-2.json']);
    expect((await ipc('saves:read', 'manual-2')).text).toBe(second);
  });

  it('结构无效的写入被拒绝且不产生文件（失败路径详见 save-failure-protection）', async () => {
    const result = await ipc('saves:write', 'manual-3', JSON.stringify({ formatVersion: 9, note: '无 world' }));
    expect(result.ok).toBe(false);
    expect(result.code).toBe('invalid-structure');
    expect(existsSync(slotPath('manual-3'))).toBe(false);
    expect(saveFiles()).toEqual([]);
  });
});

describe('IPC 读取：v1.6.1 旧明文 / 旧 gzip 凭证兼容', () => {
  it('旧明文 JSON 直接读取：内容一致，list 标为未压缩且 size=原始字节', async () => {
    const text = legacySaveText('2026-11-03T00:00:00.000Z');
    writeFileSync(slotPath('plain'), text, 'utf8');
    const read = await ipc('saves:read', 'plain');
    expect(read.ok, JSON.stringify(read)).toBe(true);
    expect(read.text).toBe(text);
    expect(read.compressed).toBe(false);

    const list = await ipc('saves:list');
    const entry = list.slots.find((slot: { slot: string }) => slot.slot === 'plain');
    expect(entry.error).toBeUndefined();
    expect(entry.compressed).toBe(false);
    expect(entry.size).toBe(Buffer.byteLength(text, 'utf8'));
    expect(entry.diskSize).toBe(Buffer.byteLength(text, 'utf8'));
    expect(entry.formatVersion).toBe(9);
    expect(entry.savedAt).toBe('2026-11-03T00:00:00.000Z');
  });

  it('v1.6.1 旧 gzip 文件（gzip 明文 JSON）可读，list 的 size=解压后字节、diskSize=磁盘字节', async () => {
    const text = legacySaveText('2026-11-04T00:00:00.000Z');
    const gz = gzipSync(Buffer.from(text, 'utf8'));
    writeFileSync(slotPath('legacy-gzip'), gz);
    const read = await ipc('saves:read', 'legacy-gzip');
    expect(read.ok, JSON.stringify(read)).toBe(true);
    expect(read.text).toBe(text);
    expect(read.compressed).toBe(true);

    const list = await ipc('saves:list');
    const entry = list.slots.find((slot: { slot: string }) => slot.slot === 'legacy-gzip');
    expect(entry.error).toBeUndefined();
    expect(entry.compressed).toBe(true);
    expect(entry.size).toBe(Buffer.byteLength(text, 'utf8')); // 解压后原始数据大小
    expect(entry.diskSize).toBe(gz.length);
    expect(entry.size).toBeGreaterThan(entry.diskSize);
  });

  it('list 同时兼容明文/gzip，且单个损坏文件被隔离（不影响其他槽位）', async () => {
    const goodText = cachedLegacy();
    writeFileSync(slotPath('good-plain'), goodText, 'utf8');
    writeFileSync(slotPath('good-gzip'), gzipSync(Buffer.from(goodText, 'utf8')));
    writeFileSync(
      slotPath('broken-gzip'),
      Buffer.concat([Buffer.from([0x1f, 0x8b]), Buffer.from('not a gzip stream')]),
    );
    writeFileSync(slotPath('broken-json'), '{ this is not json', 'utf8');

    const list = await ipc('saves:list');
    expect(list.ok).toBe(true);
    const bySlot = new Map<string, any>(list.slots.map((slot: any) => [slot.slot, slot]));
    expect(bySlot.get('good-plain').error).toBeUndefined();
    expect(bySlot.get('good-gzip').error).toBeUndefined();
    expect(bySlot.get('broken-gzip').error).toContain('解压失败');
    expect(bySlot.get('broken-json').error).toBeTruthy();
    // 单个坏文件不阻塞读取其他槽位。
    expect((await ipc('saves:read', 'good-plain')).ok).toBe(true);
    expect((await ipc('saves:read', 'good-gzip')).ok).toBe(true);
    const brokenRead = await ipc('saves:read', 'broken-gzip');
    expect(brokenRead.ok).toBe(false);
    expect(brokenRead.code).toBe('read-failed');
  });

  it('空文件/不存在/非法槽位的错误码与“不存在”区分', async () => {
    writeFileSync(slotPath('empty'), '   \n');
    const empty = await ipc('saves:read', 'empty');
    expect(empty.ok).toBe(false);
    expect(empty.error).toContain('为空');

    const missing = await ipc('saves:read', 'nope');
    expect(missing.ok).toBe(false);
    expect(missing.code).toBe('not-found');

    const badSlot = await ipc('saves:read', '../evil');
    expect(badSlot.ok).toBe(false);
    expect(badSlot.code).toBe('invalid-slot');
  });
});

describe('渲染层预检与浏览器 localStorage 限制', () => {
  it('渲染层按 UTF-8 字节预检 128MiB（中文 3 字节，边界“超过才拒绝”）', () => {
    expect(saveTextByteLength('abc')).toBe(3);
    expect(saveTextByteLength('汉')).toBe(3);
    expect(isSaveTextTooLarge('汉'.repeat(400), 1000)).toBe(true); // 1200 字节
    expect(isSaveTextTooLarge('汉'.repeat(333), 999)).toBe(false); // 恰好 999 字节
    expect(isSaveTextTooLarge('a'.repeat(1000), 1000)).toBe(false);
    expect(isSaveTextTooLarge('a'.repeat(1001), 1000)).toBe(true);
  });

  it('桌面桥接写前预检在超限时返回与主进程一致文案且不触达 IPC', async () => {
    const writes: { slot: string; text: string }[] = [];
    const previousWindow = (globalThis as any).window;
    (globalThis as any).window = {
      desktopSim: {
        saves: {
          list: async () => ({ ok: true, slots: [] }),
          read: async () => ({ ok: false, error: '存档不存在' }),
          write: async (slot: string, text: string) => {
            writes.push({ slot, text });
            return { ok: true, slot };
          },
          remove: async () => ({ ok: true }),
        },
        app: { quit: () => undefined },
        onMenuAction: () => () => undefined,
      },
    };
    try {
      const bridge: SaveBridge = createSaveBridge();
      expect(bridge.mode).toBe('desktop');
      expect((await bridge.write('manual-1', '{}')).ok).toBe(true);
      expect(writes).toHaveLength(1);
      // 直接调用预检函数证明 128MiB 口径（避免真实分配 128MiB）。
      expect(isSaveTextTooLarge('a'.repeat(128 * 1024 * 1024 + 1))).toBe(true);
    } finally {
      (globalThis as any).window = previousWindow;
    }
  });

  it('浏览器模式保存未压缩文本，容量不足时明确提示 5–10MB 与桌面版（不冒充桌面能力）', async () => {
    const previousWindow = (globalThis as any).window;
    const previousStorage = (globalThis as any).localStorage;
    const store = new Map<string, string>();
    (globalThis as any).window = undefined;
    (globalThis as any).localStorage = {
      get length() {
        return store.size;
      },
      key: (index: number) => [...store.keys()][index] ?? null,
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
    };
    try {
      const bridge = createSaveBridge();
      expect(bridge.mode).toBe('browser');
      expect((await bridge.write('browser-1', '{"formatVersion":9,"world":{}}')).ok).toBe(true);

      // 配额错误：明确说明浏览器容量限制与“请使用桌面版”。
      (globalThis as any).localStorage.setItem = () => {
        const error = new Error('quota');
        error.name = 'QuotaExceededError';
        throw error;
      };
      const failed = await bridge.write('browser-2', '{"formatVersion":9,"world":{}}');
      expect(failed.ok).toBe(false);
      expect(failed.code).toBe('browser-quota');
      expect(failed.error).toContain('5–10MB');
      expect(failed.error).toContain('桌面版');
      expect(failed.error).toContain(BROWSER_STORAGE_LIMITATION);
    } finally {
      (globalThis as any).window = previousWindow;
      (globalThis as any).localStorage = previousStorage;
    }
  });
});

// ---------------------------------------------------------------- 72 月旧明文桌面凭证（仅 IPC/parse）

const T72_SAVE_PATH = '/tmp/v16-acceptance/t72-save.json';
const has72 = existsSync(T72_SAVE_PATH);

describe.skipIf(!has72)('72 月 v1.6.1 旧明文存档：新平台 gzip 写入/读取/parse 兼容', () => {
  it('53MB 旧明文经 IPC 写入 → gzip 落盘 → 读回逐字节一致、parseSave 通过（长跑 tick 由 Lead 做）', async () => {
    const text = readFileSync(T72_SAVE_PATH, 'utf8');
    const bytes = Buffer.byteLength(text, 'utf8');
    expect(bytes).toBeLessThanOrEqual(PERSIST_MAX_RAW);

    const write = await ipc('saves:write', 't72', text);
    expect(write.ok, JSON.stringify(write)).toBe(true);
    expect(write.compressed).toBe(true);
    const diskBytes = statSync(slotPath('t72')).size;
    expect(diskBytes).toBe(write.diskBytes);
    expect(diskBytes).toBeLessThan(bytes * 0.3);

    const read = await ipc('saves:read', 't72');
    expect(read.ok, JSON.stringify(read)).toBe(true);
    expect(read.text).toBe(text);

    const parsed = parseSave(read.text);
    expect(parsed.ok, parsed.error).toBe(true);
    expect(checkInvariants(parsed.world!)).toEqual([]);

    const list = await ipc('saves:list');
    const entry = list.slots.find((slot: { slot: string }) => slot.slot === 't72');
    expect(entry.size).toBe(bytes);
    expect(entry.diskSize).toBe(diskBytes);
    expect(entry.compressed).toBe(true);
    console.log(
      `[v17-legacy-72m] raw=${bytes} disk=${diskBytes} ratio=${(bytes / diskBytes).toFixed(2)}x formatVersion=${entry.formatVersion}`,
    );
  }, 180_000);
});
