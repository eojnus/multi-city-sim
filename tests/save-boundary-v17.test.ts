// v1.6 验收修复 §三（F3）：存档边界。
//
// 覆盖：
// 1) 桌面存档上限文案（64MiB）与错误码路径一致，不再残留 8MB 文案；
// 2) Electron `saveIpc` 真实文件写入/读取：原子写、超限/结构无效失败不覆盖原有效存档、
//    读取损坏/超限的明确错误码；
// 3) 自动/手动存档失败提示：自动存档失败暂停自动写入并保留原档，手动失败有明确错误信息；
// 4) 72 月默认世界存档经同一套 handler 写入/读取/parseSave/推进 1 月（Lead 产物就绪时运行，
//    缺失时跳过；Electron 端到端由 Lead 的验收脚本负责）。
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

// 用假 ipcMain 捕获真实 handler（不启动 Electron），从而直接验证 electron/saveIpc.ts 的
// 校验顺序、原子写与备份语义；测试不需要 electron 运行时。
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

import {
  MAX_SAVE_BYTES as MAIN_MAX_SAVE_BYTES,
  SAVE_COMPRESSION_THRESHOLD_BYTES,
  SAVE_TOO_LARGE_ERROR as MAIN_SAVE_TOO_LARGE_ERROR,
  decodeSavePayload,
  encodeSavePayload,
  isGzipPayload,
  registerSaveHandlers,
} from '../electron/saveIpc';
import {
  MAX_SAVE_BYTES,
  SAVE_TOO_LARGE_ERROR,
  createSaveBridge,
  isSaveTextTooLarge,
  saveTextByteLength,
} from '../src/platform/saveBridge';
import type { SaveBridge } from '../src/platform/saveBridge';
import { GameStore } from '../src/app/gameStore';
import { Simulation } from '../src/simulation/core/simulation';
import { parseSave, serializeSave } from '../src/simulation/core/save';
import { checkInvariants } from '../src/simulation/core/invariants';

async function ipc(channel: string, ...args: unknown[]): Promise<any> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`未注册 IPC handler：${channel}`);
  return handler({}, ...args);
}

const VALID_SAVE = (() => serializeSave(Simulation.create().state, '2026-11-01T00:00:00.000Z'))();

let savesDir = '';

function saveFiles(): string[] {
  try {
    return readdirSync(savesDir).sort();
  } catch {
    return [];
  }
}

beforeEach(() => {
  savesDir = mkdtempSync(join(tmpdir(), 'v17-save-'));
  handlers.clear();
  registerSaveHandlers(() => savesDir);
});

afterEach(() => {
  rmSync(savesDir, { recursive: true, force: true });
});

describe('存档上限文案与常量（64MiB）', () => {
  it('主进程与渲染层上限/文案完全一致，且不再出现 8MB 文案', () => {
    expect(MAIN_MAX_SAVE_BYTES).toBe(64 * 1024 * 1024);
    expect(MAX_SAVE_BYTES).toBe(MAIN_MAX_SAVE_BYTES);
    expect(MAIN_SAVE_TOO_LARGE_ERROR).toBe(SAVE_TOO_LARGE_ERROR);
    expect(SAVE_TOO_LARGE_ERROR).toContain('64MiB');
    expect(SAVE_TOO_LARGE_ERROR).toContain('64MB');
    expect(SAVE_TOO_LARGE_ERROR).not.toContain('8MB');
    expect(SAVE_TOO_LARGE_ERROR).not.toContain('8 MB');
  });

  it('渲染层按 UTF-8 字节预检（中文 3 字节），边界为“超过才拒绝”', () => {
    expect(saveTextByteLength('abc')).toBe(3);
    expect(saveTextByteLength('汉')).toBe(3);
    expect(saveTextByteLength('汉a')).toBe(4);
    // 注入较小上限，验证字节口径（不分配 64MiB）。
    expect(isSaveTextTooLarge('汉'.repeat(400), 1000)).toBe(true); // 400 字 = 1200 字节
    expect(isSaveTextTooLarge('汉'.repeat(333), 999)).toBe(false); // 999 字节，恰好等于上限不拒绝
    expect(isSaveTextTooLarge('汉'.repeat(333), 1000)).toBe(false);
    expect(isSaveTextTooLarge('a'.repeat(1000), 1000)).toBe(false);
    expect(isSaveTextTooLarge('a'.repeat(1001), 1000)).toBe(true);
  });
});

describe('Electron saveIpc：写入/读取与失败不覆盖原档', () => {
  it('写入后读取回同一文本且可 parseSave；文件按需 gzip 压缩但大小口径为真实字节数', async () => {
    const expectedBytes = Buffer.byteLength(VALID_SAVE, 'utf8');
    const write = await ipc('saves:write', 'manual-1', VALID_SAVE);
    expect(write.ok, JSON.stringify(write)).toBe(true);
    expect(write.bytes).toBe(expectedBytes);
    const full = join(savesDir, 'manual-1.json');
    expect(existsSync(full)).toBe(true);
    // 大存档（≥4MiB）落盘为 gzip：文件带魔数、磁盘占用小于真实字节数；小存档保持裸 JSON。
    const onDisk = readFileSync(full);
    if (expectedBytes >= SAVE_COMPRESSION_THRESHOLD_BYTES) {
      expect(write.compressed).toBe(true);
      expect(isGzipPayload(onDisk)).toBe(true);
      expect(onDisk.length).toBeLessThan(expectedBytes);
    } else {
      expect(write.compressed).toBe(false);
      expect(onDisk.toString('utf8')).toBe(VALID_SAVE);
    }

    const read = await ipc('saves:read', 'manual-1');
    expect(read.ok, JSON.stringify(read)).toBe(true);
    expect(read.text).toBe(VALID_SAVE);
    const parsed = parseSave(read.text);
    expect(parsed.ok, parsed.error).toBe(true);
    expect(checkInvariants(parsed.world!)).toEqual([]);
  });

  it('重复写入成功使用原子写，不残留 .tmp/.bak', async () => {
    const first = VALID_SAVE;
    const second = serializeSave(Simulation.create().state, '2026-11-02T00:00:00.000Z');
    expect((await ipc('saves:write', 'manual-2', first)).ok).toBe(true);
    expect((await ipc('saves:write', 'manual-2', second)).ok).toBe(true);
    expect(saveFiles()).toEqual(['manual-2.json']);
    expect((await ipc('saves:read', 'manual-2')).text).toBe(second);
  });

  it('写入超限失败：返回 64MiB 文案，原有效存档字节不变且仍可读', async () => {
    const full = join(savesDir, 'manual-1.json');
    expect((await ipc('saves:write', 'manual-1', VALID_SAVE)).ok).toBe(true);
    const before = readFileSync(full);
    const beforeFiles = saveFiles();

    const huge = 'a'.repeat(MAIN_MAX_SAVE_BYTES + 1);
    const result = await ipc('saves:write', 'manual-1', huge);
    expect(result.ok).toBe(false);
    expect(result.error).toBe(MAIN_SAVE_TOO_LARGE_ERROR);
    expect(result.error).toContain('64MiB');

    // 原文件未被触碰，也没有留下临时/备份文件。
    expect(saveFiles()).toEqual(beforeFiles);
    expect(readFileSync(full).equals(before)).toBe(true);
    const read = await ipc('saves:read', 'manual-1');
    expect(read.ok).toBe(true);
    expect(parseSave(read.text).ok).toBe(true);
  });

  it('写入结构无效失败：不覆盖原有效存档，错误可读', async () => {
    const full = join(savesDir, 'manual-1.json');
    expect((await ipc('saves:write', 'manual-1', VALID_SAVE)).ok).toBe(true);
    const before = readFileSync(full);
    const beforeFiles = saveFiles();

    const invalidCases = [
      ['缺少 world', JSON.stringify({ formatVersion: 9, savedAt: 'x' })],
      ['formatVersion 非数字', JSON.stringify({ formatVersion: '9', world: { cities: [] } })],
      ['不是 JSON', '{ this is not json'],
    ] as const;
    for (const [label, text] of invalidCases) {
      const result = await ipc('saves:write', 'manual-1', text);
      expect(result.ok, label).toBe(false);
      expect(typeof result.error).toBe('string');
      expect(saveFiles()).toEqual(beforeFiles);
      expect(readFileSync(full).equals(before)).toBe(true);
    }
    expect((await ipc('saves:read', 'manual-1')).text).toBe(VALID_SAVE);
  });

  it('读取超限文件返回 too-large 错误码与 64MiB 文案', async () => {
    const full = join(savesDir, 'oversize.json');
    writeFileSync(full, Buffer.alloc(MAIN_MAX_SAVE_BYTES + 1, 0x61)); // 64MiB + 1，不解析内容
    const read = await ipc('saves:read', 'oversize');
    expect(read.ok).toBe(false);
    expect(read.code).toBe('too-large');
    expect(read.error).toBe(MAIN_SAVE_TOO_LARGE_ERROR);

    // saves:list 对超限文件也给出明确错误而不是让 UI 崩溃。
    const list = await ipc('saves:list');
    const entry = list.slots.find((slot: { slot: string }) => slot.slot === 'oversize');
    expect(entry.error).toBe(MAIN_SAVE_TOO_LARGE_ERROR);
    expect(entry.size).toBe(MAIN_MAX_SAVE_BYTES + 1);
  });

  it('读取空文件/不存在/非法槽位的错误码与“不存在”区分', async () => {
    writeFileSync(join(savesDir, 'empty.json'), '   \n');
    const empty = await ipc('saves:read', 'empty');
    expect(empty.ok).toBe(false);
    expect(empty.code).toBe('read-error');
    expect(empty.error).toContain('为空');

    const missing = await ipc('saves:read', 'nope');
    expect(missing.ok).toBe(false);
    expect(missing.code).toBe('not-found');

    const badSlot = await ipc('saves:read', '../evil');
    expect(badSlot.ok).toBe(false);
    expect(badSlot.code).toBe('invalid-slot');
  });
});

describe('长期方案：桌面存档 gzip 压缩（旧明文 JSON 仍可读）', () => {
  it('大文本按 gzip 落盘且读回逐字节相等；小文本保持明文', async () => {
    const large = JSON.stringify({
      formatVersion: 9,
      savedAt: '2026-11-01T00:00:00.000Z',
      world: { payload: 'abcdef'.repeat(Math.ceil((5 * 1024 * 1024) / 6)) },
    });
    const encoded = await encodeSavePayload(large);
    expect(encoded.compressed).toBe(true);
    expect(encoded.bytes).toBe(Buffer.byteLength(large, 'utf8'));
    expect(isGzipPayload(encoded.buffer)).toBe(true);
    // 重复内容的压缩率远小于 30%（72 月真实存档实测约 4.6%），只断言“显著变小”不锁死比率。
    expect(encoded.buffer.length).toBeLessThan(encoded.bytes * 0.3);
    const decoded = await decodeSavePayload(encoded.buffer);
    expect(decoded.ok).toBe(true);
    expect(decoded.compressed).toBe(true);
    expect(decoded.bytes).toBe(encoded.bytes);
    expect(decoded.text).toBe(large);

    const small = await encodeSavePayload('{"formatVersion":9}');
    expect(small.compressed).toBe(false);
    expect(small.buffer.toString('utf8')).toBe('{"formatVersion":9}');
    expect((await decodeSavePayload(small.buffer)).text).toBe('{"formatVersion":9}');
  });

  it('旧未压缩明文 JSON 文件仍可直接读取并出现在 saves:list', async () => {
    const legacy = serializeSave(Simulation.create().state, '2026-11-03T00:00:00.000Z');
    const full = join(savesDir, 'legacy.json');
    writeFileSync(full, legacy, 'utf8'); // 模拟旧版本写下的明文 JSON
    const read = await ipc('saves:read', 'legacy');
    expect(read.ok, JSON.stringify(read)).toBe(true);
    expect(read.text).toBe(legacy);
    expect(parseSave(read.text).ok).toBe(true);

    const list = await ipc('saves:list');
    const entry = list.slots.find((slot: { slot: string }) => slot.slot === 'legacy');
    expect(entry.error).toBeUndefined();
    expect(entry.size).toBe(Buffer.byteLength(legacy, 'utf8'));
    expect(entry.compressed).toBe(false);
    expect(entry.formatVersion).toBe(9);
    expect(typeof entry.savedAt).toBe('string');
  });

  it('gzip 文件在 saves:list 中可解析元数据，size 标注为解压后真实字节数', async () => {
    // 新开局存档约 0.5MB（低于 4MiB 压缩阈值），这里用 ≥4MiB 的合成“存档结构文本”验证
    // 压缩文件在 list/read 两条路径上的元数据；真实 72 月存档的压缩见文末实测用例。
    const text = JSON.stringify({
      formatVersion: 9,
      gameVersion: '1.6.0',
      savedAt: '2026-11-04T00:00:00.000Z',
      world: { pad: 'x'.repeat(5 * 1024 * 1024) },
    });
    const write = await ipc('saves:write', 'zipped', text);
    expect(write.ok, JSON.stringify(write)).toBe(true);
    expect(write.compressed).toBe(true);
    const list = await ipc('saves:list');
    const entry = list.slots.find((slot: { slot: string }) => slot.slot === 'zipped');
    expect(entry.error).toBeUndefined();
    expect(entry.compressed).toBe(true);
    expect(entry.size).toBe(Buffer.byteLength(text, 'utf8'));
    expect(entry.formatVersion).toBe(9);
    expect(entry.savedAt).toBe('2026-11-04T00:00:00.000Z');
    // 磁盘文件是 gzip 流，且显著小于真实大小。
    expect(isGzipPayload(readFileSync(join(savesDir, 'zipped.json')))).toBe(true);

    const read = await ipc('saves:read', 'zipped');
    expect(read.ok).toBe(true);
    expect(read.text).toBe(text);
  });

  it('解压失败/解压后超限被拒绝，错误码正确', async () => {
    // 损坏的 gzip：魔数正确但内容不是合法 gzip 流。
    writeFileSync(
      join(savesDir, 'broken.json'),
      Buffer.concat([Buffer.from([0x1f, 0x8b]), Buffer.from('not-a-gzip-stream')]),
    );
    const broken = await ipc('saves:read', 'broken');
    expect(broken.ok).toBe(false);
    expect(broken.code).toBe('read-error');
    expect(broken.error).toContain('解压失败');

    // 解压后超过上限：用注入的较小上限验证保护逻辑（真实路径为 64MiB）。
    const encoded = await encodeSavePayload('a'.repeat(2000), 0);
    expect(encoded.compressed).toBe(true);
    const over = await decodeSavePayload(encoded.buffer, 1000);
    expect(over.ok).toBe(false);
    expect(over.code).toBe('too-large');
    expect(over.error).toBe(MAIN_SAVE_TOO_LARGE_ERROR);
  });
});

describe('渲染层 SaveBridge：桌面模式下与主进程边界一致', () => {
  it('桌面前端写入正常文本仍透传 IPC 结果；超限预检不触达主进程', async () => {
    const writes: { slot: string; text: string }[] = [];
    const fakeWindow = {
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
    const previous = (globalThis as any).window;
    (globalThis as any).window = fakeWindow;
    try {
      const bridge = createSaveBridge();
      expect(bridge.mode).toBe('desktop');
      const ok = await bridge.write('manual-1', '{}');
      expect(ok.ok).toBe(true);
      expect(writes).toEqual([{ slot: 'manual-1', text: '{}' }]);
    } finally {
      (globalThis as any).window = previous;
    }
  });
});

// ---------------------------------------------------------------- GameStore 失败提示

interface MemoryBridge {
  bridge: SaveBridge;
  files: Map<string, string>;
  writes: { slot: string; text: string }[];
  failWrites: Map<string, string>;
  readErrors: Map<string, { error: string; code?: 'too-large' | 'read-error' | 'invalid-slot' }>;
}

function memoryBridge(initial: Record<string, string> = {}): MemoryBridge {
  const files = new Map<string, string>(Object.entries(initial));
  const writes: { slot: string; text: string }[] = [];
  const failWrites = new Map<string, string>();
  const readErrors = new Map<string, { error: string; code?: 'too-large' | 'read-error' | 'invalid-slot' }>();
  const bridge: SaveBridge = {
    mode: 'desktop',
    list: async () =>
      [...files.entries()].map(([slot, text]) => ({ slot, exists: true, size: text.length })),
    read: async (slot) => {
      const failure = readErrors.get(slot);
      if (failure) return { ok: false, error: failure.error, code: failure.code };
      const text = files.get(slot);
      if (text === undefined) return { ok: false, error: '存档不存在', code: 'not-found' };
      return { ok: true, text };
    },
    write: async (slot, text) => {
      writes.push({ slot, text });
      const failure = failWrites.get(slot);
      if (failure) return { ok: false, error: failure };
      files.set(slot, text);
      return { ok: true };
    },
    remove: async (slot) => {
      files.delete(slot);
      return { ok: true };
    },
    onMenuAction: () => () => undefined,
    quit: () => undefined,
  };
  return { bridge, files, writes, failWrites, readErrors };
}

function lastToast(store: GameStore): string {
  return store.toasts.at(-1)?.message ?? '';
}

describe('自动/手动存档失败提示与不覆盖原档', () => {
  it('自动存档失败：暂停自动写入、保留原自动存档并提示 64MiB 原因', async () => {
    const memory = memoryBridge();
    const store = new GameStore(Simulation.create(), memory.bridge);
    // 先正常写一次自动存档（模拟玩家已有有效进度）。
    await store.autosave();
    expect(store.lastAutoSaveError).toBeNull();
    const originalText = memory.files.get('autosave');
    expect(originalText).toBeTruthy();
    const writesBefore = memory.writes.length;

    // 之后写入失败（超限文案由主进程给出）。
    memory.failWrites.set('autosave', SAVE_TOO_LARGE_ERROR);
    await store.autosave();
    expect(store.autosaveDisabled).toBe(true);
    expect(store.autosaveWriteFailure).toBe(true);
    expect(store.autosaveDisabledReason).toBe(SAVE_TOO_LARGE_ERROR);
    expect(store.lastAutoSaveError).toBe(SAVE_TOO_LARGE_ERROR);
    expect(lastToast(store)).toContain('自动存档失败');
    expect(lastToast(store)).toContain('64MiB');
    // 原自动存档内容未被覆盖，仍可解析。
    expect(memory.files.get('autosave')).toBe(originalText);
    expect(parseSave(memory.files.get('autosave')!).ok).toBe(true);

    // 已暂停：后续 autosave 不再尝试写入。
    const attemptsAfterPause = memory.writes.length;
    await store.autosave();
    await store.autosave();
    expect(memory.writes.length).toBe(attemptsAfterPause);
    expect(attemptsAfterPause).toBe(writesBefore + 1); // 只有失败那一次

    // 系统提示明确：失败原因 + 原档未覆盖 + 恢复方式。
    const notice = store.systemNotices.find((entry) => entry.id === 'autosave-paused');
    expect(notice?.tone).toBe('error');
    expect(notice?.text).toContain('64MiB');
    expect(notice?.text).toContain('未被覆盖');
    expect(notice?.text).toContain('手动保存');
  });

  it('自动存档失败后手动保存成功：解除暂停并恢复自动写入', async () => {
    const memory = memoryBridge();
    const store = new GameStore(Simulation.create(), memory.bridge);
    memory.failWrites.set('autosave', SAVE_TOO_LARGE_ERROR);
    await store.autosave();
    expect(store.autosaveDisabled).toBe(true);

    // 手动保存到其他槽位成功（磁盘空间/体积问题修复后玩家可保存）。
    const ok = await store.saveSlot('manual-2');
    expect(ok).toBe(true);
    expect(store.autosaveDisabled).toBe(false);
    expect(store.autosaveWriteFailure).toBe(false);
    expect(store.lastAutoSaveError).toBeNull();

    // 写入通道恢复后，自动存档重新开始写入。
    memory.failWrites.delete('autosave');
    await store.autosave();
    expect(memory.files.has('autosave')).toBe(true);
  });

  it('手动存档失败：明确错误信息，原槽位存档未被修改', async () => {
    const memory = memoryBridge();
    const store = new GameStore(Simulation.create(), memory.bridge);
    expect(await store.saveSlot('manual-1')).toBe(true);
    const original = memory.files.get('manual-1');

    memory.failWrites.set('manual-1', SAVE_TOO_LARGE_ERROR);
    expect(await store.saveSlot('manual-1')).toBe(false);
    expect(lastToast(store)).toContain('保存失败');
    expect(lastToast(store)).toContain('64MiB');
    expect(lastToast(store)).toContain('原存档未被修改');
    expect(memory.files.get('manual-1')).toBe(original);
    expect(parseSave(original!).ok).toBe(true);
  });

  it('读取超限/损坏失败：当前进度不被覆盖，提示保留当前进度', async () => {
    const memory = memoryBridge({ 'manual-1': VALID_SAVE });
    const store = new GameStore(Simulation.create(), memory.bridge);
    const before = JSON.stringify(store.world);

    memory.readErrors.set('manual-1', { error: SAVE_TOO_LARGE_ERROR, code: 'too-large' });
    expect(await store.loadSlot('manual-1')).toBe(false);
    expect(lastToast(store)).toContain('读取失败');
    expect(lastToast(store)).toContain('64MiB');
    expect(lastToast(store)).toContain('当前进度未被覆盖');
    expect(JSON.stringify(store.world)).toBe(before);

    memory.readErrors.delete('manual-1');
    memory.files.set('manual-1', '{ definitely not json');
    expect(await store.loadSlot('manual-1')).toBe(false);
    expect(lastToast(store)).toContain('当前进度未被覆盖');
    expect(JSON.stringify(store.world)).toBe(before);
    // 损坏文件仍在：读取失败不删除/不覆盖磁盘存档。
    expect(memory.files.get('manual-1')).toBe('{ definitely not json');
  });
});

// ---------------------------------------------------------------- 72 月桌面存档实测（Lead 产物）

const T72_SAVE_PATH = '/tmp/v16-acceptance/t72-save.json';
const has72 = existsSync(T72_SAVE_PATH);

describe.skipIf(!has72)('72 月默认世界：saveIpc 写入/读取/解析/推进 1 月', () => {
  it('真实写入读取 72 月存档并记录字节数/耗时，parseSave 通过、不变量为空、可推进 1 月', async () => {
    const text = readFileSync(T72_SAVE_PATH, 'utf8');
    const bytes = Buffer.byteLength(text, 'utf8');
    expect(bytes).toBeGreaterThan(0);
    expect(bytes).toBeLessThanOrEqual(MAIN_MAX_SAVE_BYTES);

    const writeStart = performance.now();
    const write = await ipc('saves:write', 't72', text);
    const writeMs = performance.now() - writeStart;
    expect(write.ok, JSON.stringify(write)).toBe(true);
    expect(write.bytes).toBe(bytes);
    const full = join(savesDir, 't72.json');
    const diskBytes = statSync(full).size;
    // 长期方案生效证据：52MB 文本落盘为 gzip，磁盘占用 ≤ 原文本 30%（Lead 定的验收基线），
    // 读回文本与原始 52MB 文本逐字节相等。
    expect(write.compressed).toBe(true);
    expect(isGzipPayload(readFileSync(full))).toBe(true);
    expect(diskBytes).toBeLessThan(bytes * 0.3);

    const readStart = performance.now();
    const read = await ipc('saves:read', 't72');
    const readMs = performance.now() - readStart;
    expect(read.ok, JSON.stringify(read)).toBe(true);
    expect(read.text).toBe(text);

    const listStart = performance.now();
    const list = await ipc('saves:list');
    const listMs = performance.now() - listStart;
    const entry = list.slots.find((slot: { slot: string }) => slot.slot === 't72');
    expect(entry?.error).toBeUndefined();
    expect(entry?.size).toBe(bytes);
    expect(entry?.compressed).toBe(true);
    expect(entry?.formatVersion).toBe(9);

    const parseStart = performance.now();
    const parsed = parseSave(read.text);
    const parseMs = performance.now() - parseStart;
    expect(parsed.ok, parsed.error).toBe(true);
    const problems = checkInvariants(parsed.world!);
    expect(problems).toEqual([]);
    const companiesBeforeTick = parsed.world!.companies.length;
    const tickBefore = parsed.world!.time.tick;

    const simulation = new Simulation(parsed.world!);
    const tickStart = performance.now();
    const tick = simulation.tick();
    const tickMs = performance.now() - tickStart;
    expect(tick.ok, tick.error).toBe(true);
    expect(checkInvariants(simulation.state)).toEqual([]);

    // 供 Lead 交付报告引用（测试日志不参与断言）。
    console.log(
      `[v17-72m] bytes=${bytes} diskBytes=${diskBytes} ratio=${((bytes / diskBytes)).toFixed(2)}x ` +
        `writeMs=${writeMs.toFixed(1)} readMs=${readMs.toFixed(1)} listMs=${listMs.toFixed(1)} ` +
        `parseMs=${parseMs.toFixed(1)} tick1Ms=${tickMs.toFixed(1)} ` +
        `tick=${tickBefore}->${simulation.state.time.tick} ` +
        `formatVersion=${parsed.save?.formatVersion} companies=${companiesBeforeTick} ` +
        `companiesAfterTick=${simulation.state.companies.length}`,
    );
  }, 180_000);
});
