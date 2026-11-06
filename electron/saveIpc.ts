import { ipcMain } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { gzip, gunzip } from 'node:zlib';

const SAVE_SLOT_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

/**
 * v1.7 存档系统平台层（任务书 §六/§七，设计见 docs/development/SAVE_SYSTEM_DESIGN.md §9–§10）。
 *
 * 单一来源约定：`src/simulation/persistence/types.ts` 定义 MAX_SAVE_RAW_BYTES=128MiB /
 * MAX_SAVE_COMPRESSED_BYTES=64MiB；electron tsconfig 的 rootDir 是 electron/，不能直接 import src/，
 * 故本文件保留一份拷贝。**本文件顶部的 MAX_SAVE_RAW_BYTES / MAX_SAVE_COMPRESSED_BYTES /
 * SAVE_LIMIT_MESSAGES 必须与 persistence/types.ts 的数值及 saveBridge 的错误文案完全一致**，
 * 由 tests/save-boundary-v17.test.ts 的 parity 用例断言三个数值与文案字符串相等；
 * 若以后 electron 构建范围允许，应改为从 persistence/types.ts 单源导入（留给后续任务）。
 *
 * 三层大小口径（三处文案必须与界面口径一致）：
 * 1. 原始文本（未压缩 UTF-8）≤ 128MiB：渲染层预检 + 主进程校验，超限返回 too-large；
 * 2. 磁盘压缩文件（gzip）≤ 64MiB：防异常文件（正常 gzip 远小于此）；
 * 3. 解压输出 ≤ 128MiB：gunzip maxOutputLength + 校验，防压缩炸弹。
 */
export const MAX_SAVE_RAW_BYTES = 128 * 1024 * 1024;
export const MAX_SAVE_COMPRESSED_BYTES = 64 * 1024 * 1024;

/** 三层“存档过大”文案：主进程与渲染层（saveBridge）使用完全相同的字符串。 */
export const SAVE_LIMIT_MESSAGES = {
  /** 原始文本超过 128MiB（写入时由渲染层预检与主进程共同校验）。 */
  raw: '存档过大（原始数据超过 128MiB 上限）',
  /** 压缩结果或磁盘 gzip 文件超过 64MiB。 */
  compressed: '存档过大（压缩文件超过 64MiB 上限）',
  /** gunzip 输出超过 128MiB。 */
  decompressed: '存档过大（解压后超过 128MiB 上限）',
  /** 旧明文存档文件自身超过 128MiB。 */
  plainFile: '存档过大（未压缩存档超过 128MiB 上限）',
} as const;
export type SaveLimitKind = keyof typeof SAVE_LIMIT_MESSAGES;

export function tooLargeMessage(kind: SaveLimitKind, writing = false): string {
  const base: string = SAVE_LIMIT_MESSAGES[kind];
  // 写入失败时追加“未写入”，与 v1.6.1 的用户提示口径保持一致。
  return writing ? base.replace(/）$/, '，未写入）') : base;
}

const GZIP_MAGIC_0 = 0x1f;
const GZIP_MAGIC_1 = 0x8b;

/** 大小上限（字节）；测试可注入更小的值以覆盖边界路径，生产使用默认值。 */
export interface SaveLimits {
  rawBytes: number;
  compressedBytes: number;
}

export const DEFAULT_SAVE_LIMITS: SaveLimits = {
  rawBytes: MAX_SAVE_RAW_BYTES,
  compressedBytes: MAX_SAVE_COMPRESSED_BYTES,
};

/** 写盘/读取结果的稳定错误码（与 src/simulation/persistence/types.ts 的 SaveErrorCode 子集同名）。 */
export type SaveIpcErrorCode =
  | 'too-large'
  | 'invalid-content'
  | 'invalid-json'
  | 'invalid-structure'
  | 'invalid-slot'
  | 'compression-failed'
  | 'write-failed'
  | 'read-failed';

function gzipBuffer(input: Buffer): Promise<Buffer> {
  // 异步 gzip（zlib 线程池）：128MiB 级压缩不会阻塞主进程事件循环。
  return new Promise((resolve, reject) => {
    gzip(input, { level: 6 }, (error, result) => (error ? reject(error) : resolve(result)));
  });
}

function gunzipBuffer(input: Buffer, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    gunzip(input, { maxOutputLength: maxBytes }, (error, result) =>
      error ? reject(error) : resolve(result),
    );
  });
}

export function isGzipPayload(buffer: Buffer): boolean {
  return buffer.length >= 2 && buffer[0] === GZIP_MAGIC_0 && buffer[1] === GZIP_MAGIC_1;
}

/** 只读文件头（用于在整体读入前判断格式/大小口径，避免异常大文件先撑爆内存）。 */
function readFileHeader(full: string, bytes = 2): Buffer {
  const fd = fs.openSync(full, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const read = fs.readSync(fd, buffer, 0, bytes, 0);
    return buffer.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 写入前的最小结构校验（不加载世界）：
 * - 旧单体格式：formatVersion 为整数 + world 为对象；
 * - v10 模块化格式：formatVersion 为整数 + modules 对象 + worldMeta 对象（kind='lanwan-modules' 允许但非强制）。
 * 结构不合法时拒绝写入，绝不触碰原存档。
 */
export function isPlausibleSaveDocument(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  if (typeof value.formatVersion !== 'number' || !Number.isInteger(value.formatVersion)) return false;
  if (isRecord(value.world)) return true;
  return isRecord(value.modules) && isRecord(value.worldMeta);
}

export interface EncodedSavePayload {
  ok: boolean;
  /** 实际写入磁盘的 gzip 字节。 */
  buffer?: Buffer;
  /** 未压缩的 UTF-8 字节数（原始数据大小）。 */
  rawBytes: number;
  /** gzip 后字节数（磁盘文件大小）。 */
  compressedBytes: number;
  error?: string;
  code?: SaveIpcErrorCode;
}

/**
 * 把存档文本编码为落盘 payload：v1.7 起**写盘统一 gzip**。
 * 原始文本超过上限在压缩前拒绝；压缩结果超过磁盘上限也拒绝（正常存档远小于此）。
 */
export async function encodeSavePayload(
  text: string,
  limits: SaveLimits = DEFAULT_SAVE_LIMITS,
): Promise<EncodedSavePayload> {
  if (typeof text !== 'string') {
    return { ok: false, rawBytes: 0, compressedBytes: 0, error: '存档内容无效', code: 'invalid-content' };
  }
  const raw = Buffer.from(text, 'utf8');
  if (raw.length > limits.rawBytes) {
    return {
      ok: false,
      rawBytes: raw.length,
      compressedBytes: 0,
      error: tooLargeMessage('raw', true),
      code: 'too-large',
    };
  }
  let compressed: Buffer;
  try {
    compressed = await gzipBuffer(raw);
  } catch (error) {
    return {
      ok: false,
      rawBytes: raw.length,
      compressedBytes: 0,
      error: `存档压缩失败：${(error as Error).message}`,
      code: 'compression-failed',
    };
  }
  if (compressed.length > limits.compressedBytes) {
    return {
      ok: false,
      rawBytes: raw.length,
      compressedBytes: compressed.length,
      error: tooLargeMessage('compressed', true),
      code: 'too-large',
    };
  }
  return { ok: true, buffer: compressed, rawBytes: raw.length, compressedBytes: compressed.length };
}

export interface DecodedSavePayload {
  ok: boolean;
  text?: string;
  /** 是否来自 gzip 文件（旧明文为 false）。 */
  compressed?: boolean;
  /** 解压后（原始）字节数。 */
  rawBytes?: number;
  /** 磁盘文件字节数。 */
  diskBytes?: number;
  error?: string;
  code?: SaveIpcErrorCode;
}

/**
 * 读取落盘 payload：gzip 魔数 → gunzip（maxOutputLength 防压缩炸弹）；否则按旧明文 JSON 读取。
 * 三层大小保护全部在此收口：磁盘 gzip ≤64MiB、明文 ≤128MiB、解压输出 ≤128MiB。
 */
export async function decodeSavePayload(
  buffer: Buffer,
  limits: SaveLimits = DEFAULT_SAVE_LIMITS,
): Promise<DecodedSavePayload> {
  const diskBytes = buffer.length;
  if (isGzipPayload(buffer)) {
    if (diskBytes > limits.compressedBytes) {
      return {
        ok: false,
        compressed: true,
        diskBytes,
        error: tooLargeMessage('compressed'),
        code: 'too-large',
      };
    }
    let raw: Buffer;
    try {
      raw = await gunzipBuffer(buffer, limits.rawBytes + 1);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') {
        return {
          ok: false,
          compressed: true,
          diskBytes,
          error: tooLargeMessage('decompressed'),
          code: 'too-large',
        };
      }
      return {
        ok: false,
        compressed: true,
        diskBytes,
        error: `存档解压失败：${(error as Error).message}`,
        code: 'read-failed',
      };
    }
    if (raw.length > limits.rawBytes) {
      return {
        ok: false,
        compressed: true,
        diskBytes,
        rawBytes: raw.length,
        error: tooLargeMessage('decompressed'),
        code: 'too-large',
      };
    }
    return { ok: true, text: raw.toString('utf8'), compressed: true, rawBytes: raw.length, diskBytes };
  }
  if (diskBytes > limits.rawBytes) {
    return { ok: false, compressed: false, diskBytes, error: tooLargeMessage('plainFile'), code: 'too-large' };
  }
  return { ok: true, text: buffer.toString('utf8'), compressed: false, rawBytes: diskBytes, diskBytes };
}

export interface SaveHandlerOptions {
  /**
   * 大小上限覆盖（仅供测试注入更小阈值；生产不传，使用 DEFAULT_SAVE_LIMITS）。
   * 注入值必须为正整数，避免误把生产上限调小。
   */
  limits?: Partial<SaveLimits>;
}

interface SaveWriteResult {
  ok: boolean;
  slot: string;
  savedAt?: string;
  /** 原始（未压缩）字节数。 */
  bytes?: number;
  /** 磁盘 gzip 字节数。 */
  diskBytes?: number;
  compressed?: boolean;
  error?: string;
  code?: SaveIpcErrorCode;
}

export function registerSaveHandlers(
  savesDirectory: () => string,
  options: SaveHandlerOptions = {},
): void {
  const limits: SaveLimits = {
    rawBytes: options.limits?.rawBytes ?? DEFAULT_SAVE_LIMITS.rawBytes,
    compressedBytes: options.limits?.compressedBytes ?? DEFAULT_SAVE_LIMITS.compressedBytes,
  };
  /** 每个槽位一条写队列：同一槽位的写/删串行执行，不同槽位互不影响。 */
  const slotQueues = new Map<string, Promise<unknown>>();
  let tempSequence = 0;

  const slotFile = (slot: string): string => {
    if (!SAVE_SLOT_PATTERN.test(slot)) throw new Error('非法存档槽位名称');
    return path.join(savesDirectory(), `${slot}.json`);
  };

  function enqueueSlot<T>(slot: string, task: () => Promise<T>): Promise<T> {
    const previous = slotQueues.get(slot) ?? Promise.resolve();
    // 前一个任务失败也必须继续执行后续任务（失败不能永久卡住该槽位）。
    const run = previous.catch(() => undefined).then(task);
    slotQueues.set(slot, run);
    const cleanup = (): void => {
      if (slotQueues.get(slot) === run) slotQueues.delete(slot);
    };
    run.then(cleanup, cleanup);
    return run;
  }

  async function writeSave(slot: string, text: string): Promise<SaveWriteResult> {
    const full = slotFile(slot);
    if (typeof text !== 'string') {
      return { ok: false, slot, error: '存档内容无效', code: 'invalid-content' };
    }
    // 第一层：原始文本上限（主进程独立校验，不信任渲染层预检）。
    const rawBytes = Buffer.byteLength(text, 'utf8');
    if (rawBytes > limits.rawBytes) {
      return { ok: false, slot, error: tooLargeMessage('raw', true), code: 'too-large', bytes: rawBytes };
    }
    // 写入前校验 JSON 与顶层结构；任何失败都发生在落盘之前，原档不受影响。
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      return {
        ok: false,
        slot,
        error: `存档不是有效 JSON：${(error as Error).message}`,
        code: 'invalid-json',
        bytes: rawBytes,
      };
    }
    if (!isPlausibleSaveDocument(parsed)) {
      return { ok: false, slot, error: '存档结构无效，未写入', code: 'invalid-structure', bytes: rawBytes };
    }
    // 第二层：压缩结果（磁盘文件）上限。
    const payload = await encodeSavePayload(text, limits);
    if (!payload.ok || !payload.buffer) {
      return {
        ok: false,
        slot,
        error: payload.error ?? '存档压缩失败',
        code: payload.code ?? 'compression-failed',
        bytes: rawBytes,
      };
    }
    fs.mkdirSync(savesDirectory(), { recursive: true });
    const temp = `${full}.tmp-${process.pid}-${Date.now()}-${++tempSequence}`;
    const backup = `${full}.bak`;
    fs.writeFileSync(temp, payload.buffer);
    try {
      if (fs.existsSync(full)) {
        fs.rmSync(backup, { force: true });
        fs.renameSync(full, backup);
      }
      fs.renameSync(temp, full);
      fs.rmSync(backup, { force: true });
    } catch (error) {
      fs.rmSync(temp, { force: true });
      if (fs.existsSync(backup)) {
        try {
          // 原子替换中途失败：恢复原档（只有恢复失败时才保留 .bak 交给人工处理）。
          fs.rmSync(full, { force: true });
          fs.renameSync(backup, full);
        } catch {
          // 保留 .bak。
        }
      }
      return {
        ok: false,
        slot,
        error: `存档写入失败：${(error as Error).message}`,
        code: 'write-failed',
        bytes: rawBytes,
      };
    }
    const record = isRecord(parsed) ? parsed : {};
    return {
      ok: true,
      slot,
      savedAt: typeof record.savedAt === 'string' ? record.savedAt : undefined,
      bytes: payload.rawBytes,
      diskBytes: payload.compressedBytes,
      compressed: true,
    };
  }

  ipcMain.handle('saves:list', async () => {
    try {
      const dir = savesDirectory();
      fs.mkdirSync(dir, { recursive: true });
      const files = fs.readdirSync(dir).filter((name) => name.endsWith('.json'));
      // 顺序处理：大存档解压 + JSON.parse 峰值内存高，并发多个槽位可能撑爆内存；
      // 每个槽位独立 try/catch，单个损坏文件不影响其他槽位。
      const slots: Record<string, unknown>[] = [];
      for (const name of files) {
        const slot = name.replace(/\.json$/, '');
        const full = path.join(dir, name);
        try {
          const stat = fs.statSync(full);
          const header = readFileHeader(full);
          const compressed = isGzipPayload(header);
          const diskLimit = compressed ? limits.compressedBytes : limits.rawBytes;
          if (stat.size > diskLimit) {
            slots.push({
              slot,
              exists: true,
              error: tooLargeMessage(compressed ? 'compressed' : 'plainFile'),
              diskSize: stat.size,
              size: undefined,
              compressed,
            });
            continue;
          }
          const decoded = await decodeSavePayload(fs.readFileSync(full), limits);
          if (!decoded.ok || decoded.text === undefined) {
            slots.push({
              slot,
              exists: true,
              error: decoded.error ?? '存档无法读取',
              diskSize: stat.size,
              size: undefined,
              compressed: decoded.compressed === true,
            });
            continue;
          }
          const parsed = JSON.parse(decoded.text) as Record<string, unknown>;
          slots.push({
            slot,
            exists: true,
            savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : undefined,
            formatVersion: typeof parsed.formatVersion === 'number' ? parsed.formatVersion : undefined,
            gameVersion: typeof parsed.gameVersion === 'string' ? parsed.gameVersion : undefined,
            // size = 原始数据大小（解压后字节）；diskSize = 磁盘压缩文件大小。二者不得混淆。
            size: decoded.rawBytes ?? stat.size,
            diskSize: stat.size,
            compressed,
          });
        } catch (error) {
          slots.push({ slot, exists: true, error: (error as Error).message });
        }
      }
      return { ok: true, slots };
    } catch (error) {
      return { ok: false, slots: [], error: (error as Error).message };
    }
  });

  ipcMain.handle('saves:read', async (_event, slot: string) => {
    try {
      const full = slotFile(slot);
      if (!fs.existsSync(full)) {
        return { ok: false, slot, error: '存档不存在', code: 'not-found' };
      }
      const stat = fs.statSync(full);
      const compressed = isGzipPayload(readFileHeader(full));
      // 读入前先按磁盘口径拦截异常大文件（gzip 用 64MiB、旧明文用 128MiB）。
      const diskLimit = compressed ? limits.compressedBytes : limits.rawBytes;
      if (stat.size > diskLimit) {
        return {
          ok: false,
          slot,
          error: tooLargeMessage(compressed ? 'compressed' : 'plainFile'),
          code: 'too-large',
        };
      }
      const decoded = await decodeSavePayload(fs.readFileSync(full), limits);
      if (!decoded.ok || decoded.text === undefined) {
        return { ok: false, slot, error: decoded.error ?? '存档读取失败', code: decoded.code ?? 'read-failed' };
      }
      const text = decoded.text;
      if (!text.trim()) {
        return { ok: false, slot, error: '存档文件为空', code: 'read-failed' };
      }
      return {
        ok: true,
        slot,
        text,
        compressed: decoded.compressed === true,
        bytes: decoded.rawBytes,
        diskBytes: stat.size,
      };
    } catch (error) {
      // 文件存在但读取失败（权限、占用、IO 错误）必须与“不存在”区分，避免被自动存档覆盖。
      const message = (error as Error).message;
      const code: SaveIpcErrorCode = message.includes('非法存档槽位') ? 'invalid-slot' : 'read-failed';
      return { ok: false, slot, error: message, code };
    }
  });

  ipcMain.handle('saves:write', async (_event, slot: string, text: string) => {
    try {
      // 槽位校验放在入队前：非法槽位直接拒绝，不占用队列。
      slotFile(slot);
    } catch (error) {
      return { ok: false, slot, error: (error as Error).message, code: 'invalid-slot' as const };
    }
    return enqueueSlot(slot, () => writeSave(slot, text));
  });

  ipcMain.handle('saves:remove', async (_event, slot: string) => {
    try {
      const full = slotFile(slot);
      return await enqueueSlot(slot, async () => {
        // 删除是显式操作（等价于用户确认丢弃该槽位）：主文件、备份与中断写残留的临时文件一起清理。
        fs.rmSync(full, { force: true });
        fs.rmSync(`${full}.bak`, { force: true });
        const prefix = `${path.basename(full)}.tmp-`;
        try {
          for (const name of fs.readdirSync(savesDirectory())) {
            if (name.startsWith(prefix)) fs.rmSync(path.join(savesDirectory(), name), { force: true });
          }
        } catch {
          // 目录不可读时忽略残留清理；主档删除结果不受影响。
        }
        return { ok: true };
      });
    } catch (error) {
      return { ok: false, error: (error as Error).message, code: 'invalid-slot' as const };
    }
  });
}
