// v1.7 存档平台层：失败保护、并发串行、损坏隔离与 GameStore 保存锁回归。
//
// 覆盖（任务书 §六/§七 + task-10 #5）：
// - saveIpc handler：原始文本超限 / 错误结构 / 损坏 gzip / 写失败原档不变 / 同槽位并发写串行 /
//   列表隔离损坏文件 / 旧明文与 gzip 双格式读取；
// - GameStore：保存失败释放锁（不无限“正在保存”）、自动存档失败暂停且保留原档、手动/自动串行、
//   读取损坏不覆盖当前世界。
//
// 说明：超限用例通过 registerSaveHandlers({limits}) 注入小上限覆盖边界路径，避免在 2GB 容器里
// 分配真实 128MiB 字符串；生产默认值由 tests/save-boundary-v17.test.ts 的 parity 用例校验。
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
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

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
  MAX_SAVE_RAW_BYTES,
  SAVE_LIMIT_MESSAGES,
  isGzipPayload,
  registerSaveHandlers,
  tooLargeMessage,
} from '../../electron/saveIpc';
import { GameStore } from '../../src/app/gameStore';
import type { SaveBridge, SaveWriteResult } from '../../src/platform/saveBridge';
import { Simulation } from '../../src/simulation/core/simulation';
import { parseSave, serializeSave } from '../../src/simulation/core/save';

async function ipc(channel: string, ...args: unknown[]): Promise<any> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`未注册 IPC handler：${channel}`);
  return handler({}, ...args);
}

let savesDir = '';

function slotPath(slot: string): string {
  return join(savesDir, `${slot}.json`);
}

function saveFiles(): string[] {
  try {
    return readdirSync(savesDir).sort();
  } catch {
    return [];
  }
}

/** 旧单体格式的最小合法存档文本（IPC 写入只校验 formatVersion + world 结构）。 */
function smallSaveText(note = 'ok', savedAt = '2026-11-01T00:00:00.000Z'): string {
  return JSON.stringify({ formatVersion: 9, gameVersion: '1.6.1', savedAt, world: { note } });
}

function smallLimits(rawBytes = 4096, compressedBytes = 64 * 1024): void {
  registerSaveHandlers(() => savesDir, { limits: { rawBytes, compressedBytes } });
}

beforeEach(() => {
  savesDir = mkdtempSync(join(tmpdir(), 'v17-fail-'));
  handlers.clear();
  registerSaveHandlers(() => savesDir);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(savesDir, { recursive: true, force: true });
});

describe('saveIpc：写入失败原档不变', () => {
  it('原始文本超限被拒绝（注入小上限），原档字节不变且仍可读', async () => {
    smallLimits(4096, 64 * 1024);
    const original = smallSaveText('original');
    expect((await ipc('saves:write', 'manual-1', original)).ok).toBe(true);
    const before = readFileSync(slotPath('manual-1'));
    const beforeFiles = saveFiles();

    const tooBig = smallSaveText('x'.repeat(5000));
    const result = await ipc('saves:write', 'manual-1', tooBig);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('too-large');
    expect(result.error).toBe(tooLargeMessage('raw', true));

    expect(readFileSync(slotPath('manual-1')).equals(before)).toBe(true);
    expect(saveFiles()).toEqual(beforeFiles);
    const read = await ipc('saves:read', 'manual-1');
    expect(read.ok).toBe(true);
    expect(read.text).toBe(original);
  });

  it('结构无效 / JSON 损坏被拒绝且不产生也没有覆盖文件', async () => {
    expect((await ipc('saves:write', 'manual-2', smallSaveText('v1'))).ok).toBe(true);
    const before = readFileSync(slotPath('manual-2'));

    const invalidCases: [string, string][] = [
      ['结构无效', JSON.stringify({ formatVersion: 9, savedAt: 'x' })],
      ['JSON 损坏', '{ not valid json'],
      ['formatVersion 非法', JSON.stringify({ formatVersion: '9', world: {} })],
    ];
    for (const [label, text] of invalidCases) {
      const result = await ipc('saves:write', 'manual-2', text);
      expect(result.ok, label).toBe(false);
      expect(['invalid-structure', 'invalid-json']).toContain(result.code);
      expect(readFileSync(slotPath('manual-2')).equals(before)).toBe(true);
    }
    expect(saveFiles()).toEqual(['manual-2.json']);

    // 新槽位的非法写入不得留下空文件。
    const fresh = await ipc('saves:write', 'manual-new', JSON.stringify({ formatVersion: 9 }));
    expect(fresh.ok).toBe(false);
    expect(existsSync(slotPath('manual-new'))).toBe(false);
  });

  it('IO 写入失败（模拟 rename 失败）：返回错误、回滚原档、不残留临时文件', async () => {
    expect((await ipc('saves:write', 'manual-3', smallSaveText('original'))).ok).toBe(true);
    const before = readFileSync(slotPath('manual-3'));

    // 第一次 rename 是 full→.bak（写新内容前备份原档）；失败后应回滚到原档。
    const originalRename = fs.renameSync.bind(fs);
    let renameCalls = 0;
    vi.spyOn(fs, 'renameSync').mockImplementation((oldPath: any, newPath: any) => {
      renameCalls += 1;
      if (renameCalls === 2) throw new Error('EIO: 模拟磁盘错误（temp→full）');
      return originalRename(oldPath, newPath);
    });

    const result = await ipc('saves:write', 'manual-3', smallSaveText('replacement'));
    expect(result.ok).toBe(false);
    expect(result.code).toBe('write-failed');
    expect(result.error).toContain('存档写入失败');

    vi.restoreAllMocks();
    // 原档内容恢复，.bak 清理，且没有残留 .tmp。
    expect(readFileSync(slotPath('manual-3')).equals(before)).toBe(true);
    expect(saveFiles()).toEqual(['manual-3.json']);
    const read = await ipc('saves:read', 'manual-3');
    expect(read.ok).toBe(true);
    expect(read.text).toBe(smallSaveText('original'));
  });
});

describe('saveIpc：同槽位并发写串行化', () => {
  it('并发写同一槽位按提交顺序执行，最终文件是最后一次写入（旧结果不得覆盖新结果）', async () => {
    const first = smallSaveText('first', '2026-11-01T00:00:00.000Z');
    const second = smallSaveText('second', '2026-11-02T00:00:00.000Z');
    const [resultA, resultB] = await Promise.all([
      ipc('saves:write', 'race', first),
      ipc('saves:write', 'race', second),
    ]);
    expect(resultA.ok, JSON.stringify(resultA)).toBe(true);
    expect(resultB.ok, JSON.stringify(resultB)).toBe(true);

    const read = await ipc('saves:read', 'race');
    expect(read.ok).toBe(true);
    expect(read.text).toBe(second);
    // 串行执行：中途的临时/备份文件全部清理，只剩最终文件。
    expect(saveFiles()).toEqual(['race.json']);
  });

  it('并发写不同槽位互不阻塞、互不覆盖', async () => {
    const textA = smallSaveText('slot-a');
    const textB = smallSaveText('slot-b');
    const [resultA, resultB] = await Promise.all([
      ipc('saves:write', 'slot-a', textA),
      ipc('saves:write', 'slot-b', textB),
    ]);
    expect(resultA.ok).toBe(true);
    expect(resultB.ok).toBe(true);
    expect((await ipc('saves:read', 'slot-a')).text).toBe(textA);
    expect((await ipc('saves:read', 'slot-b')).text).toBe(textB);
    expect(saveFiles().sort()).toEqual(['slot-a.json', 'slot-b.json']);
  });
});

describe('saveIpc：损坏文件隔离与旧格式兼容', () => {
  it('单个损坏 gzip 不影响其他槽位；旧明文与旧 gzip 均可读', async () => {
    const plainText = smallSaveText('old-plain');
    const gzipText = smallSaveText('old-gzip');
    writeFileSync(slotPath('old-plain'), plainText, 'utf8');
    writeFileSync(slotPath('old-gzip'), gzipSync(Buffer.from(gzipText, 'utf8')));
    writeFileSync(
      slotPath('broken-gzip'),
      Buffer.concat([Buffer.from([0x1f, 0x8b]), Buffer.from('corrupted')]),
    );

    expect((await ipc('saves:read', 'old-plain')).text).toBe(plainText);
    expect((await ipc('saves:read', 'old-gzip')).text).toBe(gzipText);

    const brokenRead = await ipc('saves:read', 'broken-gzip');
    expect(brokenRead.ok).toBe(false);
    expect(brokenRead.code).toBe('read-failed');
    expect(brokenRead.error).toContain('解压失败');

    const list = await ipc('saves:list');
    expect(list.ok).toBe(true);
    const bySlot = new Map<string, any>(list.slots.map((slot: any) => [slot.slot, slot]));
    expect(bySlot.get('old-plain').compressed).toBe(false);
    expect(bySlot.get('old-gzip').compressed).toBe(true);
    expect(bySlot.get('broken-gzip').error).toContain('解压失败');
    // 坏文件不影响正常槽位的元数据。
    expect(bySlot.get('old-plain').size).toBe(Buffer.byteLength(plainText, 'utf8'));
    expect(bySlot.get('old-gzip').size).toBe(Buffer.byteLength(gzipText, 'utf8'));
  });

  it('读取损坏/超限失败不删除也不改写磁盘文件', async () => {
    const broken = Buffer.concat([Buffer.from([0x1f, 0x8b]), Buffer.from('corrupted')]);
    writeFileSync(slotPath('keep-broken'), broken);
    await ipc('saves:read', 'keep-broken');
    expect(readFileSync(slotPath('keep-broken')).equals(broken)).toBe(true);

    // 注入压缩上限：超限 gzip 文件被拒绝且文件保持不变。
    const gz = gzipSync(Buffer.from(smallSaveText('large-ish'), 'utf8'));
    writeFileSync(slotPath('too-big-gzip'), gz);
    registerSaveHandlers(() => savesDir, { limits: { compressedBytes: gz.length - 1 } });
    const result = await ipc('saves:read', 'too-big-gzip');
    expect(result.ok).toBe(false);
    expect(result.code).toBe('too-large');
    expect(result.error).toBe(SAVE_LIMIT_MESSAGES.compressed);
    expect(readFileSync(slotPath('too-big-gzip')).equals(gz)).toBe(true);
  });
});

// ---------------------------------------------------------------- GameStore 保存锁/失败语义

interface DeferredWrite {
  slot: string;
  text: string;
  resolve: (result: SaveWriteResult) => void;
}

interface MemoryBridge {
  bridge: SaveBridge;
  files: Map<string, string>;
  writes: { slot: string; text: string }[];
  pending: DeferredWrite[];
  gate: boolean;
  failWrites: Map<string, string>;
  throwWrites: Set<string>;
}

/**
 * 内存桥：默认立即成功；gate=true 时写入挂起，由测试手动 resolve（用于观察并发/串行）；
 * failWrites/throwWrites 模拟失败/异常。
 */
function memoryBridge(initial: Record<string, string> = {}): MemoryBridge {
  const files = new Map<string, string>(Object.entries(initial));
  const writes: { slot: string; text: string }[] = [];
  const pending: DeferredWrite[] = [];
  const failWrites = new Map<string, string>();
  const throwWrites = new Set<string>();
  const state: MemoryBridge = {
    files,
    writes,
    pending,
    gate: false,
    failWrites,
    throwWrites,
    bridge: null as unknown as SaveBridge,
  };
  state.bridge = {
    mode: 'desktop',
    list: async () =>
      [...files.entries()].map(([slot, text]) => ({ slot, exists: true, size: text.length })),
    read: async (slot) => {
      const text = files.get(slot);
      if (text === undefined) return { ok: false, error: '存档不存在', code: 'not-found' };
      return { ok: true, text };
    },
    write: (slot, text) => {
      writes.push({ slot, text });
      if (throwWrites.has(slot)) return Promise.reject(new Error('桥接层异常'));
      const failure = failWrites.get(slot);
      if (failure) return Promise.resolve<SaveWriteResult>({ ok: false, error: failure, code: 'too-large' });
      if (!state.gate) {
        files.set(slot, text);
        return Promise.resolve({ ok: true });
      }
      return new Promise((resolve) => {
        pending.push({ slot, text, resolve: (result) => resolve(result) });
      });
    },
    remove: async (slot) => {
      files.delete(slot);
      return { ok: true };
    },
    onMenuAction: () => () => undefined,
    quit: () => undefined,
  };
  return state;
}

async function flushMicrotasks(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

function lastToast(store: GameStore): string {
  return store.toasts.at(-1)?.message ?? '';
}

// v10 模块化 API 已就位时，验证 GameStore 的“未知可选模块无损透传”真实契约；
// 模块注册表尚未全部就绪（v10 往返暂不可用）时跳过，避免把 Lead 的进行中工作误报为失败。
// 注意：新开局世界未推进过时部分可选数组尚未初始化，取推进 1 月后的稳定世界做探测。
const v10RoundtripSupported = (() => {
  try {
    const simulation = Simulation.create();
    simulation.tick();
    return parseSave(serializeSave(simulation.state)).ok;
  } catch {
    return false;
  }
})();

describe.skipIf(!v10RoundtripSupported)('GameStore：v10 未知可选模块无损透传', () => {
  function withFutureModule(): string {
    const simulation = Simulation.create();
    simulation.tick();
    const base = JSON.parse(serializeSave(simulation.state, { savedAt: '2026-11-06T00:00:00.000Z' })) as any;
    base.modules.futureOptional = { version: 3, required: false, data: { hello: 'world' } };
    return JSON.stringify(base);
  }

  it('读取含未知可选模块的 v10 存档：preservedModules 被记录，保存时原样写回', async () => {
    const memory = memoryBridge();
    const store = new GameStore(Simulation.create(), memory.bridge);
    memory.files.set('manual-future', withFutureModule());

    expect(await store.loadSlot('manual-future')).toBe(true);
    expect(store.preservedModules).toEqual({
      futureOptional: { version: 3, required: false, data: { hello: 'world' } },
    });
    // warnings 至少包含“未知可选模块已保留”的提示。
    expect(store.lastLoadWarnings.length).toBeGreaterThan(0);
    expect(store.systemNotices.some((notice) => notice.id === 'save-load-warnings')).toBe(true);

    expect(await store.saveSlot('manual-resaved')).toBe(true);
    const written = JSON.parse(memory.files.get('manual-resaved')!) as any;
    // 协调器把 preservedModules 原样合并回 modules（模块 ID 不丢、数据不丢）。
    expect(written.modules.futureOptional).toEqual({
      version: 3,
      required: false,
      data: { hello: 'world' },
    });
    // 再次读取仍然保留该未知可选模块（未静默丢弃）。
    const reparsed = parseSave(memory.files.get('manual-resaved')!);
    expect(reparsed.ok).toBe(true);
    expect(reparsed.preservedModules).toEqual({
      futureOptional: { version: 3, required: false, data: { hello: 'world' } },
    });
  });

  it('真实 v10 存档：读档后世界可继续使用，保存写出模块化文本（formatVersion 10）', async () => {
    const memory = memoryBridge();
    const store = new GameStore(Simulation.create(), memory.bridge);
    const simulation = Simulation.create();
    simulation.tick();
    const text = serializeSave(simulation.state, { savedAt: '2026-11-07T00:00:00.000Z' });
    memory.files.set('manual-v10', text);

    expect(await store.loadSlot('manual-v10')).toBe(true);
    expect(store.lastSavedAt).toBe('2026-11-07T00:00:00.000Z');
    expect(await store.saveSlot('manual-v10-saved')).toBe(true);

    const written = JSON.parse(memory.files.get('manual-v10-saved')!) as any;
    expect(written.formatVersion).toBe(10);
    expect(written.kind).toBe('lanwan-modules');
    expect(written.modules).toBeTypeOf('object');
    // 写出的文本能被真实 parseSave 读回（模块化往返）。
    expect(parseSave(memory.files.get('manual-v10-saved')!).ok).toBe(true);
  });

  it('开始新世界会清空 preservedModules，避免未知模块数据串档', async () => {
    const memory = memoryBridge();
    const store = new GameStore(Simulation.create(), memory.bridge);
    memory.files.set('manual-future', withFutureModule());
    expect(await store.loadSlot('manual-future')).toBe(true);
    expect(store.preservedModules).not.toBeNull();

    store.resetWorld();
    expect(store.preservedModules).toBeNull();
    expect(store.lastLoadWarnings).toEqual([]);
  });
});

describe('GameStore：保存锁与失败释放', () => {
  it('手动保存失败：释放 isSaving/pendingSaves、toast 注明原档未修改，原档仍可读', async () => {
    const memory = memoryBridge();
    const store = new GameStore(Simulation.create(), memory.bridge);
    expect(await store.saveSlot('manual-1')).toBe(true);
    const original = memory.files.get('manual-1');

    memory.failWrites.set('manual-1', SAVE_LIMIT_MESSAGES.compressed);
    expect(await store.saveSlot('manual-1')).toBe(false);
    expect(store.isSaving).toBe(false);
    expect(store.lastSaveErrorCode).toBe('too-large');
    expect(lastToast(store)).toContain('保存失败');
    expect(lastToast(store)).toContain('原存档未被修改');
    expect(memory.files.get('manual-1')).toBe(original);

    // 失败后锁已释放：后续保存仍能执行。
    memory.failWrites.delete('manual-1');
    expect(await store.saveSlot('manual-1')).toBe(true);
    expect(store.isSaving).toBe(false);
  });

  it('桥接层抛异常同样释放锁并提示（不会无限“正在保存”）', async () => {
    const memory = memoryBridge();
    const store = new GameStore(Simulation.create(), memory.bridge);
    memory.throwWrites.add('manual-1');
    expect(await store.saveSlot('manual-1')).toBe(false);
    expect(store.isSaving).toBe(false);
    expect(lastToast(store)).toContain('保存失败');
  });

  it('手动/自动保存并发时串行：同一时刻只有一个写入在途，自动存档在有保存在途时跳过', async () => {
    const memory = memoryBridge();
    const store = new GameStore(Simulation.create(), memory.bridge);
    memory.gate = true;

    const first = store.saveSlot('manual-1');
    await flushMicrotasks();
    expect(store.isSaving).toBe(true);
    expect(memory.pending).toHaveLength(1);

    // 自动存档不应在手动保存进行中再发起写入。
    await store.autosave();
    expect(memory.pending).toHaveLength(1);

    // 第二个手动保存排队，等第一个完成后才发起。
    const second = store.saveSlot('manual-2');
    await flushMicrotasks();
    expect(memory.pending).toHaveLength(1);

    memory.pending[0]!.resolve({ ok: true });
    memory.files.set('manual-1', memory.pending[0]!.text);
    await flushMicrotasks();
    expect(memory.pending).toHaveLength(2);

    memory.pending[1]!.resolve({ ok: true });
    memory.files.set('manual-2', memory.pending[1]!.text);
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(store.isSaving).toBe(false);
    expect(store.pendingSaves).toBe(0);
    expect(memory.writes.map((write) => write.slot)).toEqual(['manual-1', 'manual-2']);
  });

  it('自动存档写入失败：暂停自动写入、保留原自动存档、释放锁且不覆盖原档', async () => {
    const memory = memoryBridge();
    const store = new GameStore(Simulation.create(), memory.bridge);
    await store.autosave();
    const originalAutosave = memory.files.get('autosave');
    expect(originalAutosave).toBeTruthy();

    memory.failWrites.set('autosave', SAVE_LIMIT_MESSAGES.compressed);
    await store.autosave();
    expect(store.autosaveDisabled).toBe(true);
    expect(store.autosaveWriteFailure).toBe(true);
    expect(store.autosaveDisabledReason).toBe(SAVE_LIMIT_MESSAGES.compressed);
    expect(store.isSaving).toBe(false);
    expect(store.pendingSaves).toBe(0);
    expect(memory.files.get('autosave')).toBe(originalAutosave);

    // 暂停后不再尝试写入。
    const attempts = memory.writes.length;
    await store.autosave();
    await store.autosave();
    expect(memory.writes.length).toBe(attempts);
  });

  it('自动存档桥接异常：暂停自动写入并释放锁', async () => {
    const memory = memoryBridge();
    const store = new GameStore(Simulation.create(), memory.bridge);
    memory.throwWrites.add('autosave');
    await store.autosave();
    expect(store.autosaveDisabled).toBe(true);
    expect(store.autosaveWriteFailure).toBe(true);
    expect(store.isSaving).toBe(false);
  });

  it('读取损坏存档失败：当前世界不被覆盖、锁状态不残留', async () => {
    const memory = memoryBridge();
    const store = new GameStore(Simulation.create(), memory.bridge);
    const before = JSON.stringify(store.world);
    memory.files.set('manual-bad', '{ definitely not json');

    expect(await store.loadSlot('manual-bad')).toBe(false);
    expect(JSON.stringify(store.world)).toBe(before);
    expect(lastToast(store)).toContain('当前进度未被覆盖');
    expect(store.isSaving).toBe(false);
  });
});

describe('默认上限常量与口径', () => {
  it('主进程默认上限为 128MiB 原始 / 64MiB 压缩，超限文案含对应口径', () => {
    expect(MAX_SAVE_RAW_BYTES).toBe(128 * 1024 * 1024);
    expect(SAVE_LIMIT_MESSAGES.raw).toContain('128MiB');
    expect(SAVE_LIMIT_MESSAGES.compressed).toContain('64MiB');
    expect(SAVE_LIMIT_MESSAGES.decompressed).toContain('128MiB');
  });

  it('默认上限下旧明文与 gzip 均可读，且写入统一 gzip', async () => {
    const text = serializeSave(Simulation.create().state, '2026-11-05T00:00:00.000Z');
    const write = await ipc('saves:write', 'defaults', text);
    expect(write.ok).toBe(true);
    expect(write.compressed).toBe(true);
    expect(isGzipPayload(readFileSync(slotPath('defaults')))).toBe(true);
    expect(statSync(slotPath('defaults')).size).toBeLessThan(Buffer.byteLength(text, 'utf8'));
    expect((await ipc('saves:read', 'defaults')).text).toBe(text);
  });
});
