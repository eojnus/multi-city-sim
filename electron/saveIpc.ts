import { ipcMain } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { gzip, gunzip } from 'node:zlib';

const SAVE_SLOT_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
/**
 * v1.6 §三：桌面存档上限 64MiB（字节，UTF-8）。
 * 与渲染层 `src/platform/saveBridge.ts` 的 MAX_SAVE_BYTES 必须一致；旧 8MB 上限会误拒正常存档。
 * 读写两条路径共用同一常量和文案，避免“限制已改、文案仍写 8MB”再次出现
 * （tests/save-boundary-v17.test.ts 会校验两处常量与文案一致）。
 */
export const MAX_SAVE_BYTES = 64 * 1024 * 1024;
/** 用户可见的“存档过大”文案：必须与真实上限一致（渲染层使用同一文案）。 */
export const SAVE_TOO_LARGE_ERROR = '存档过大（超过 64MB / 64MiB 限制）';
/**
 * v1.6 §三 长期方案：桌面存档 gzip 压缩。
 *
 * 依据（72 月默认世界实测，见 save-boundary-v17 测试与交付报告）：序列化 52,347,982 字节
 * ≈ 49.9MiB，已达 64MiB 上限的 78%；t48→t72 增长 10.95MB（≈456KB/月），按此趋势约 90–120 月
 * 会撞上上限。gzip(level 6) 后为 2,408,255 字节（21.7×，即原文本 4.6%；压缩约 0.46s、
 * 解压约 0.06–0.10s），不删除债券/贷款/权益/追溯等任何权威数据即可获得长期余量；因此不采用
 * “归档历史字段/提高上限”方案。
 *
 * 兼容性：压缩文件以 gzip 魔数 0x1f 0x8b 标记，读取时按魔数识别——旧未压缩 JSON 存档仍可直接读取，
 * 不需要迁移或手工处理。压缩是异步的（zlib 线程池），不阻塞主进程事件循环。
 */
export const SAVE_COMPRESSION_THRESHOLD_BYTES = 4 * 1024 * 1024;
const GZIP_MAGIC_0 = 0x1f;
const GZIP_MAGIC_1 = 0x8b;

function gzipBuffer(input: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    gzip(input, { level: 6 }, (error, result) => {
      if (error) reject(error);
      else resolve(result);
    });
  });
}

function gunzipBuffer(input: Buffer, maxBytes: number): Promise<Buffer> {
  // maxOutputLength 防止损坏/恶意压缩文件解压出超大内容占满内存。
  return new Promise((resolve, reject) => {
    gunzip(input, { maxOutputLength: maxBytes }, (error, result) => {
      if (error) reject(error);
      else resolve(result);
    });
  });
}

export function isGzipPayload(buffer: Buffer): boolean {
  return buffer.length >= 2 && buffer[0] === GZIP_MAGIC_0 && buffer[1] === GZIP_MAGIC_1;
}

export interface EncodedSavePayload {
  /** 实际写入磁盘的字节（压缩或未压缩）。 */
  buffer: Buffer;
  compressed: boolean;
  /** 未压缩的 UTF-8 字节数（存档真实大小，用于上限判断与保存对话框展示）。 */
  bytes: number;
}

/** 把存档文本编码为落盘 payload：达到阈值时尝试 gzip，压缩反而变大则保留原文。 */
export async function encodeSavePayload(
  text: string,
  threshold = SAVE_COMPRESSION_THRESHOLD_BYTES,
): Promise<EncodedSavePayload> {
  const raw = Buffer.from(text, 'utf8');
  if (raw.length < threshold) return { buffer: raw, compressed: false, bytes: raw.length };
  try {
    const compressed = await gzipBuffer(raw);
    if (compressed.length < raw.length) {
      return { buffer: compressed, compressed: true, bytes: raw.length };
    }
  } catch {
    // 压缩失败（极少见的 zlib 错误）时退回未压缩；存档仍可读，不阻断保存。
  }
  return { buffer: raw, compressed: false, bytes: raw.length };
}

export interface DecodedSavePayload {
  ok: boolean;
  text?: string;
  compressed?: boolean;
  bytes?: number;
  error?: string;
  code?: 'too-large' | 'read-error';
}

/** 读取落盘 payload：gzip 魔数则解压，否则按旧格式裸 JSON 文本读取；上限按解压后字节数判断。 */
export async function decodeSavePayload(
  buffer: Buffer,
  maxBytes = MAX_SAVE_BYTES,
): Promise<DecodedSavePayload> {
  if (isGzipPayload(buffer)) {
    let raw: Buffer;
    try {
      raw = await gunzipBuffer(buffer, maxBytes + 1);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') {
        return { ok: false, error: SAVE_TOO_LARGE_ERROR, code: 'too-large' };
      }
      return { ok: false, error: `存档解压失败：${(error as Error).message}`, code: 'read-error' };
    }
    if (raw.length > maxBytes) return { ok: false, error: SAVE_TOO_LARGE_ERROR, code: 'too-large' };
    return { ok: true, text: raw.toString('utf8'), compressed: true, bytes: raw.length };
  }
  if (buffer.length > maxBytes) return { ok: false, error: SAVE_TOO_LARGE_ERROR, code: 'too-large' };
  return { ok: true, text: buffer.toString('utf8'), compressed: false, bytes: buffer.length };
}

export function registerSaveHandlers(savesDirectory: () => string): void {
  const slotFile = (slot: string): string => {
    if (!SAVE_SLOT_PATTERN.test(slot)) throw new Error('非法存档槽位名称');
    return path.join(savesDirectory(), `${slot}.json`);
  };

  ipcMain.handle('saves:list', async () => {
    try {
      const dir = savesDirectory();
      fs.mkdirSync(dir, { recursive: true });
      const files = fs.readdirSync(dir).filter((name) => name.endsWith('.json'));
      // 顺序处理：大存档（52MB 级）解压 + JSON.parse 峰值内存高，并发多个槽位可能撑爆内存。
      const slots: Record<string, unknown>[] = [];
      for (const name of files) {
        const slot = name.replace(/\.json$/, '');
        const full = path.join(dir, name);
        try {
          const stat = fs.statSync(full);
          // 本程序写出的文件（明文或 gzip）都不会超过上限；超限文件直接拒绝，避免先整体读入撑爆内存。
          if (stat.size > MAX_SAVE_BYTES) {
            slots.push({ slot, exists: true, error: SAVE_TOO_LARGE_ERROR, size: stat.size });
            continue;
          }
          const decoded = await decodeSavePayload(fs.readFileSync(full));
          if (!decoded.ok || decoded.text === undefined) {
            slots.push({ slot, exists: true, error: decoded.error ?? '存档无法读取', size: stat.size });
            continue;
          }
          const parsed = JSON.parse(decoded.text) as Record<string, unknown>;
          slots.push({
            slot,
            exists: true,
            savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : undefined,
            formatVersion: typeof parsed.formatVersion === 'number' ? parsed.formatVersion : undefined,
            gameVersion: typeof parsed.gameVersion === 'string' ? parsed.gameVersion : undefined,
            // 展示真实存档大小（解压后字节数），压缩文件的磁盘占用更小但不代表存档内容变小。
            size: decoded.bytes ?? stat.size,
            compressed: decoded.compressed === true,
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
      // 先看文件大小再整体读入：本程序写出的文件（明文或 gzip）都不会超过上限，
      // 异常巨大文件在分配内存前就拒绝（旧实现此处用 stat.size 判断，语义保持不变）。
      if (fs.statSync(full).size > MAX_SAVE_BYTES) {
        return { ok: false, slot, error: SAVE_TOO_LARGE_ERROR, code: 'too-large' };
      }
      const decoded = await decodeSavePayload(fs.readFileSync(full));
      if (!decoded.ok || decoded.text === undefined) {
        return { ok: false, slot, error: decoded.error ?? '存档读取失败', code: decoded.code ?? 'read-error' };
      }
      const text = decoded.text;
      if (!text.trim()) {
        return { ok: false, slot, error: '存档文件为空', code: 'read-error' };
      }
      return { ok: true, slot, text };
    } catch (error) {
      // 文件存在但读取失败（权限、占用、IO 错误）必须与“不存在”区分，避免被自动存档覆盖。
      const message = (error as Error).message;
      const code = message.includes('非法存档槽位') ? 'invalid-slot' : 'read-error';
      return { ok: false, slot, error: message, code };
    }
  });

  ipcMain.handle('saves:write', async (_event, slot: string, text: string) => {
    try {
      if (typeof text !== 'string') return { ok: false, slot, error: '存档内容无效' };
      // 先校验再落盘：超限/结构无效时绝不触碰原存档（含 .bak / 临时文件）。
      if (Buffer.byteLength(text, 'utf8') > MAX_SAVE_BYTES) {
        return { ok: false, slot, error: SAVE_TOO_LARGE_ERROR, code: 'too-large' };
      }
      const parsed = JSON.parse(text) as { formatVersion?: unknown; savedAt?: unknown; world?: unknown };
      if (typeof parsed.formatVersion !== 'number' || !parsed.world) {
        return { ok: false, slot, error: '存档结构无效，未写入' };
      }
      const payload = await encodeSavePayload(text);
      fs.mkdirSync(savesDirectory(), { recursive: true });
      const full = slotFile(slot);
      const temp = `${full}.tmp-${process.pid}-${Date.now()}`;
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
            fs.rmSync(full, { force: true });
            fs.renameSync(backup, full);
          } catch {
            // 恢复失败时保留 .bak，交给人工处理。
          }
        }
        throw error;
      }
      return {
        ok: true,
        slot,
        savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : undefined,
        bytes: payload.bytes,
        compressed: payload.compressed,
      };
    } catch (error) {
      return { ok: false, slot, error: (error as Error).message };
    }
  });

  ipcMain.handle('saves:remove', async (_event, slot: string) => {
    try {
      const full = slotFile(slot);
      if (fs.existsSync(full)) fs.rmSync(full);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  });
}
