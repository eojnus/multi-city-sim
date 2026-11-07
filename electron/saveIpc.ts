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

/** 单备份文件后缀：存档槽位 `${slot}.json` 的上一版本备份为 `${slot}.json.bak`。 */
export const BACKUP_SUFFIX = '.bak';
/** 列表扫描用的主档/备份后缀（备份文件名 = `${slot}.json.bak`）。 */
const LIST_MAIN_SUFFIX = '.json';
const LIST_BACKUP_SUFFIX = '.json.bak';

/**
 * 备份/恢复的复制策略。
 *
 * 优先硬链接：同目录下 link 是原子的且零拷贝，`.bak` 与“上一版本主档”共享 inode；
 * 主档替换走 rename（只改目录项，不写 inode），因此硬链接备份内容不会被新主档覆盖。
 * 文件系统不支持硬链接（如部分 Windows/FAT、跨设备）时回退 copyFile（EXCL 防覆盖）。
 */
function linkOrCopyFile(source: string, destination: string): void {
  try {
    fs.linkSync(source, destination);
    return;
  } catch {
    // 回退到复制；目标名由调用方保证不存在（EXCL），避免误覆盖有效文件。
  }
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
}

/**
 * 清理该槽位上次进程中断留下的临时文件（主档替换 temp / 备份生成 bak.next）。
 * 只在同槽位写队列内调用；主档 `.bak` 绝不在此清理。
 */
/** 两个路径是否指向同一 inode（硬链接备份与主档可能是同一文件）。 */
function isSameFile(first: string, second: string): boolean {
  try {
    const a = fs.statSync(first);
    const b = fs.statSync(second);
    return a.ino === b.ino && a.dev === b.dev;
  } catch {
    return false;
  }
}

function removeStaleWriteArtifacts(full: string): void {
  const dir = path.dirname(full);
  const base = path.basename(full);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const isTemp = name.startsWith(`${base}.tmp-`);
    const isBakNext = name.startsWith(`${base}${BACKUP_SUFFIX}.next-`);
    if (!isTemp && !isBakNext) continue;
    try {
      fs.rmSync(path.join(dir, name), { force: true });
    } catch {
      // 单个残留清理失败不影响本次写入（不影响主档/备份）。
    }
  }
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
  /** 本次覆盖是否生成了“上一版本”备份（首次写入且无旧主档时为 false）。 */
  backupCreated?: boolean;
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
    const backup = `${full}${BACKUP_SUFFIX}`;
    // 清理上次进程中断残留的 temp/bak.next（本槽位队列内，安全）；.bak 永不在此清理。
    removeStaleWriteArtifacts(full);

    // 中断恢复：主档缺失但 .bak 存在（旧替换算法在“主档→备份 / temp→主档”之间崩溃的窗口）。
    // 先恢复主档再继续本次写入，既保证下一次“备份=上一版本”轮换有依据，也绝不让仅存备份被当垃圾。
    if (!fs.existsSync(full) && fs.existsSync(backup)) {
      try {
        linkOrCopyFile(backup, full);
      } catch (error) {
        return {
          ok: false,
          slot,
          error: `存档写入失败：主档缺失且无法从备份恢复（${(error as Error).message}）`,
          code: 'write-failed',
          bytes: rawBytes,
        };
      }
    }

    const temp = `${full}.tmp-${process.pid}-${Date.now()}-${++tempSequence}`;
    fs.writeFileSync(temp, payload.buffer);

    // 第 1 步：先生成“下一份备份”（= 本次写入前的主档内容）。失败则主档完全不动。
    // 顺序：link/copy 到 bak.next → 原子 rename 轮换到 .bak。旧 .bak 只在这一步被替换。
    let backupCreated = false;
    if (fs.existsSync(full)) {
      const bakNext = `${backup}.next-${process.pid}-${Date.now()}-${++tempSequence}`;
      try {
        // 若主档与 .bak 已是同一 inode（中断恢复用硬链接把备份恢复成主档），备份已等于主档内容：
        // 跳过 link+rename（POSIX 对同 inode 硬链接 rename 是 no-op，会留下 bak.next）。
        if (fs.existsSync(backup) && isSameFile(full, backup)) {
          backupCreated = true;
        } else {
          linkOrCopyFile(full, bakNext);
          fs.renameSync(bakNext, backup);
          backupCreated = true;
        }
      } catch (error) {
        fs.rmSync(bakNext, { force: true });
        fs.rmSync(temp, { force: true });
        return {
          ok: false,
          slot,
          error: `存档写入失败：备份生成失败，主档未改动（${(error as Error).message}）`,
          code: 'write-failed',
          bytes: rawBytes,
        };
      }
    }

    // 第 2 步：原子替换主档。rename 只改目录项，不存在“主档缺失”窗口；
    // 失败时主档仍是旧版本，且 .bak 已与旧主档同内容，主/备至少一方完整可读。
    try {
      fs.renameSync(temp, full);
    } catch (error) {
      fs.rmSync(temp, { force: true });
      return {
        ok: false,
        slot,
        error: `存档写入失败：主档替换失败，原档仍保留（${(error as Error).message}）`,
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
      /** 本次覆盖是否生成了上一版本备份；首次写入没有旧主档时为 false。 */
      backupCreated,
    };
  }

  /** 解码一个存档文件（主档或备份），统一三层大小保护；供 read / read-backup / list 复用。 */
  async function decodeFileAt(file: string): Promise<{
    ok: boolean;
    text?: string;
    compressed?: boolean;
    rawBytes?: number;
    diskBytes?: number;
    error?: string;
    code?: SaveIpcErrorCode;
  }> {
    const stat = fs.statSync(file);
    const compressed = isGzipPayload(readFileHeader(file));
    const diskLimit = compressed ? limits.compressedBytes : limits.rawBytes;
    if (stat.size > diskLimit) {
      return { ok: false, error: tooLargeMessage(compressed ? 'compressed' : 'plainFile'), code: 'too-large' };
    }
    const decoded = await decodeSavePayload(fs.readFileSync(file), limits);
    if (!decoded.ok || decoded.text === undefined) {
      return { ok: false, error: decoded.error ?? '存档读取失败', code: decoded.code ?? 'read-failed' };
    }
    if (!decoded.text.trim()) return { ok: false, error: '存档文件为空', code: 'read-failed' };
    return {
      ok: true,
      text: decoded.text,
      compressed: decoded.compressed === true,
      rawBytes: decoded.rawBytes,
      diskBytes: stat.size,
    };
  }

  /** 提取列表/备份展示用的顶层元信息（JSON 损坏时由调用方按读失败处理）。 */
  function saveMetaOf(text: string): { savedAt?: string; formatVersion?: number; gameVersion?: string } {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    return {
      savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : undefined,
      formatVersion: typeof parsed.formatVersion === 'number' ? parsed.formatVersion : undefined,
      gameVersion: typeof parsed.gameVersion === 'string' ? parsed.gameVersion : undefined,
    };
  }

  ipcMain.handle('saves:list', async () => {
    try {
      const dir = savesDirectory();
      fs.mkdirSync(dir, { recursive: true });
      const names = fs.readdirSync(dir);
      // 顺序处理：大存档解压 + JSON.parse 峰值内存高；每个槽位独立 try/catch，坏文件不影响其他槽位。
      const slots: Record<string, unknown>[] = [];
      const seen = new Set<string>();

      // 主档：size 口径不变 = 解压后原始字节；diskSize = 磁盘文件字节；backupExists 标记同槽位 .bak。
      for (const name of names) {
        if (!name.endsWith(LIST_MAIN_SUFFIX)) continue;
        const slot = name.slice(0, -LIST_MAIN_SUFFIX.length);
        seen.add(slot);
        const full = path.join(dir, name);
        const backup = `${full}${BACKUP_SUFFIX}`;
        try {
          const decoded = await decodeFileAt(full);
          const backupExists = fs.existsSync(backup);
          if (!decoded.ok || decoded.text === undefined) {
            slots.push({
              slot,
              exists: true,
              error: decoded.error ?? '存档无法读取',
              diskSize: decoded.diskBytes,
              size: undefined,
              compressed: decoded.compressed === true,
              backupExists,
            });
            continue;
          }
          const meta = saveMetaOf(decoded.text);
          slots.push({
            slot,
            exists: true,
            ...meta,
            size: decoded.rawBytes ?? decoded.diskBytes,
            diskSize: decoded.diskBytes,
            compressed: decoded.compressed === true,
            backupExists,
          });
        } catch (error) {
          slots.push({
            slot,
            exists: true,
            error: (error as Error).message,
            backupExists: fs.existsSync(backup),
          });
        }
      }

      // 仅备份存在的槽位（主档缺失：上次进程在替换窗口中断）→ 视为可恢复数据，
      // 标记 recoveredFromBackup；读取由 saves:read 回退到备份，下一次写入先恢复主档。
      // 该分支绝不删除备份，也不改变主档 size 口径。
      for (const name of names) {
        if (!name.endsWith(LIST_BACKUP_SUFFIX)) continue;
        const slot = name.slice(0, -LIST_BACKUP_SUFFIX.length);
        if (seen.has(slot)) continue;
        const mainPath = path.join(dir, `${slot}${LIST_MAIN_SUFFIX}`);
        if (fs.existsSync(mainPath)) continue;
        seen.add(slot);
        const backup = path.join(dir, name);
        try {
          const decoded = await decodeFileAt(backup);
          if (!decoded.ok || decoded.text === undefined) {
            slots.push({
              slot,
              exists: true,
              error: decoded.error ?? '备份无法读取',
              backupExists: true,
              recoveredFromBackup: false,
            });
            continue;
          }
          const meta = saveMetaOf(decoded.text);
          slots.push({
            slot,
            exists: true,
            ...meta,
            size: decoded.rawBytes ?? decoded.diskBytes,
            diskSize: decoded.diskBytes,
            compressed: decoded.compressed === true,
            backupExists: true,
            recoveredFromBackup: true,
          });
        } catch (error) {
          slots.push({
            slot,
            exists: true,
            error: (error as Error).message,
            backupExists: true,
            recoveredFromBackup: false,
          });
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
      const backup = `${full}${BACKUP_SUFFIX}`;
      // 主档缺失但备份存在：上次进程在替换窗口中断 → 回退读备份并标记；
      // 下一次写入会先把备份恢复成主档再轮换。备份绝不在此删除。
      const recoveredFromBackup = !fs.existsSync(full) && fs.existsSync(backup);
      const source = recoveredFromBackup ? backup : full;
      if (!fs.existsSync(source)) {
        return { ok: false, slot, error: '存档不存在', code: 'not-found' };
      }
      const decoded = await decodeFileAt(source);
      if (!decoded.ok || decoded.text === undefined) {
        return { ok: false, slot, error: decoded.error ?? '存档读取失败', code: decoded.code ?? 'read-failed' };
      }
      return {
        ok: true,
        slot,
        text: decoded.text,
        compressed: decoded.compressed === true,
        bytes: decoded.rawBytes,
        diskBytes: decoded.diskBytes,
        recoveredFromBackup,
      };
    } catch (error) {
      // 文件存在但读取失败（权限、占用、IO 错误）必须与“不存在”区分，避免被自动存档覆盖。
      const message = (error as Error).message;
      const code: SaveIpcErrorCode = message.includes('非法存档槽位') ? 'invalid-slot' : 'read-failed';
      return { ok: false, slot, error: message, code };
    }
  });

  ipcMain.handle('saves:read-backup', async (_event, slot: string) => {
    try {
      const full = slotFile(slot);
      const backup = `${full}${BACKUP_SUFFIX}`;
      if (!fs.existsSync(backup)) {
        return { ok: false, slot, error: '备份不存在', code: 'not-found' };
      }
      const decoded = await decodeFileAt(backup);
      if (!decoded.ok || decoded.text === undefined) {
        return { ok: false, slot, error: decoded.error ?? '备份读取失败', code: decoded.code ?? 'read-failed' };
      }
      const meta = saveMetaOf(decoded.text);
      return {
        ok: true,
        slot,
        text: decoded.text,
        compressed: decoded.compressed === true,
        bytes: decoded.rawBytes,
        diskBytes: decoded.diskBytes,
        backupExists: true,
        ...meta,
      };
    } catch (error) {
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
