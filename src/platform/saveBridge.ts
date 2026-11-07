import type { DesktopSimApi, SaveSlotInfo } from './desktop';
import { MAX_SAVE_RAW_BYTES } from '../simulation/persistence/types';

const STORAGE_PREFIX = 'lanwan-save:';

/**
 * v1.7 存档系统：渲染层与平台层的边界（任务书 §六/§七）。
 *
 * 大小口径与主进程一致（src/simulation/persistence/types.ts）：
 * - 原始文本（未压缩 UTF-8）≤ MAX_SAVE_RAW_BYTES = 128MiB；桌面版另有“磁盘 gzip ≤64MiB、
 *   解压输出 ≤128MiB”两处主进程保护，渲染层只负责第一层预检。
 * - 浏览器 localStorage 保存的是**未压缩文本**，容量通常只有 5–10MB，不能与桌面能力等同；
 *   浏览器模式不假设能存桌面级存档，超限时明确提示使用桌面版。
 */
export { MAX_SAVE_RAW_BYTES };
/** 与 electron/saveIpc.SAVE_LIMIT_MESSAGES.raw + “未写入”完全一致的用户可见文案。 */
export const SAVE_RAW_TOO_LARGE_ERROR = '存档过大（原始数据超过 128MiB 上限，未写入）';
/** 浏览器 localStorage 的真实限制说明（不冒充桌面能力）。 */
export const BROWSER_STORAGE_LIMITATION =
  '浏览器本地存储容量通常只有 5–10MB，且保存的是未压缩文本；桌面版支持 128MiB 原始存档与 gzip 压缩。请使用桌面版保存大型存档。';

/** 文本的 UTF-8 字节数（与主进程 Buffer.byteLength 口径一致；浏览器/Node 24 都有 TextEncoder）。 */
export function saveTextByteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/**
 * 渲染层写入/读取前的大小预检（第一层：原始文本上限）。
 *
 * 必须按 UTF-8 字节判断：中文 1 个字 = 3 字节，只用 `text.length` 会放过主进程随后拒绝的
 * 存档（出现“预检通过但保存失败”的不一致）。快路径利用 length ≤ 字节数 ≤ 3×length：
 * 超上限的 length 直接拒绝，明显安全的小存档不做编码分配，只有边界灰区才精确编码。
 */
export function isSaveTextTooLarge(text: string, maxBytes = MAX_SAVE_RAW_BYTES): boolean {
  if (text.length > maxBytes) return true;
  if (text.length * 3 <= maxBytes) return false;
  return saveTextByteLength(text) > maxBytes;
}

export type SaveReadCode = 'not-found' | 'read-error' | 'too-large' | 'invalid-slot';
/** 写入错误码：与主进程 IPC 返回的 SaveIpcErrorCode 子集保持一致（字符串稳定，可跨 IPC）。 */
export type SaveWriteCode =
  | 'too-large'
  | 'invalid-content'
  | 'invalid-json'
  | 'invalid-structure'
  | 'invalid-slot'
  | 'compression-failed'
  | 'write-failed'
  | 'browser-quota';

export interface SaveWriteResult {
  ok: boolean;
  error?: string;
  code?: SaveWriteCode;
}

/**
 * 备份读取结果（`saves:read-backup`）：成功覆盖后保留的“上一版本”存档。
 * v1.7 验收修复：.json.bak 是上一版本（保留/轮换语义见 electron/saveIpc.ts 与 DESIGN §10）。
 */
export interface SaveBackupReadResult {
  ok: boolean;
  text?: string;
  error?: string;
  code?: SaveReadCode;
  savedAt?: string;
  formatVersion?: number;
  gameVersion?: string;
}

export interface SaveBridge {
  mode: 'desktop' | 'browser';
  list(): Promise<SaveSlotInfo[]>;
  read(slot: string): Promise<{ ok: boolean; text?: string; error?: string; code?: SaveReadCode }>;
  /**
   * 读取上一版本备份（桌面 `.json.bak`）；浏览器模式没有桌面备份能力。
   * 可选：旧测试替身/旧 preload 可能没有该能力，调用方需按 undefined 处理。
   */
  readBackup?(slot: string): Promise<SaveBackupReadResult>;
  write(slot: string, text: string): Promise<SaveWriteResult>;
  remove(slot: string): Promise<{ ok: boolean; error?: string }>;
  onMenuAction(callback: (action: string) => void): () => void;
  quit(): void;
  saveDirectory?: string;
}

/** 浏览器 localStorage 配额错误判定（不同浏览器/内核名称不一）。 */
function isStorageQuotaError(error: unknown): boolean {
  if (typeof DOMException !== 'undefined' && error instanceof DOMException) {
    return (
      error.name === 'QuotaExceededError' ||
      error.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
      error.code === 22 ||
      error.code === 1014
    );
  }
  const message = (error as Error)?.name ?? '';
  return message === 'QuotaExceededError' || message === 'NS_ERROR_DOM_QUOTA_REACHED';
}

function browserWriteFailure(error: unknown): SaveWriteResult {
  if (isStorageQuotaError(error)) {
    return {
      ok: false,
      error: `保存失败：本地存储空间不足。${BROWSER_STORAGE_LIMITATION}`,
      code: 'browser-quota',
    };
  }
  return { ok: false, error: `保存失败：${(error as Error).message}`, code: 'write-failed' };
}

function getDesktop(): DesktopSimApi | undefined {
  return typeof window !== 'undefined' ? window.desktopSim : undefined;
}

export function createSaveBridge(): SaveBridge {
  const desktop = getDesktop();
  if (desktop) {
    return {
      mode: 'desktop',
      async list() {
        const result = await desktop.saves.list();
        return result.ok ? result.slots : [];
      },
      async read(slot) {
        const result = await desktop.saves.read(slot);
        return {
          ok: result.ok,
          text: result.text,
          error: result.error,
          code: result.code as SaveReadCode | undefined,
        };
      },
      async readBackup(slot) {
        // DesktopSimApi 类型来自 preload 的 api 对象；这里运行时透传，类型用可选方法兼容旧 preload。
        const saves = desktop.saves as typeof desktop.saves & {
          readBackup?: (slot: string) => Promise<{
            ok: boolean;
            text?: string;
            error?: string;
            code?: string;
            savedAt?: string;
            formatVersion?: number;
            gameVersion?: string;
          }>;
        };
        if (typeof saves.readBackup !== 'function') {
          return { ok: false, error: '当前运行环境不支持读取备份', code: 'read-error' };
        }
        const result = await saves.readBackup(slot);
        return {
          ok: result.ok,
          text: result.text,
          error: result.error,
          code: result.code as SaveReadCode | undefined,
          savedAt: result.savedAt,
          formatVersion: result.formatVersion,
          gameVersion: result.gameVersion,
        };
      },
      async write(slot, text) {
        // 第一层预检：明显超限时不走 IPC（主进程仍会独立再校验一次）。
        if (isSaveTextTooLarge(text)) {
          return { ok: false, error: SAVE_RAW_TOO_LARGE_ERROR, code: 'too-large' };
        }
        const result = await desktop.saves.write(slot, text);
        // DesktopSimApi 的 write 结果未声明 code；主进程会返回，运行时透传即可。
        const code = (result as { code?: SaveWriteCode }).code;
        return { ok: result.ok, error: result.error, code };
      },
      async remove(slot) {
        const result = await desktop.saves.remove(slot);
        return { ok: result.ok, error: result.error };
      },
      onMenuAction(callback) {
        return desktop.onMenuAction(callback);
      },
      quit() {
        desktop.app.quit();
      },
    };
  }

  // 浏览器回退：便于 `npm run dev:web` 和自动化截图验证；Electron 下始终走 IPC。
  // 注意：localStorage 保存未压缩文本、容量约 5–10MB，不能冒充桌面存档能力。
  return {
    mode: 'browser',
    async list() {
      const slots: SaveSlotInfo[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key || !key.startsWith(STORAGE_PREFIX)) continue;
        const slot = key.slice(STORAGE_PREFIX.length);
        const text = localStorage.getItem(key) ?? '';
        try {
          const parsed = JSON.parse(text) as Record<string, unknown>;
          slots.push({
            slot,
            exists: true,
            savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : undefined,
            formatVersion:
              typeof parsed.formatVersion === 'number' ? parsed.formatVersion : undefined,
            gameVersion: typeof parsed.gameVersion === 'string' ? parsed.gameVersion : undefined,
            // localStorage 存未压缩文本，size 即原始数据字节数。
            size: saveTextByteLength(text),
          });
        } catch {
          slots.push({ slot, exists: true, error: '浏览器存档损坏（本地存储内容不是有效 JSON）' });
        }
      }
      return slots;
    },
    async read(slot) {
      const text = localStorage.getItem(STORAGE_PREFIX + slot);
      if (text === null) return { ok: false, error: '存档不存在', code: 'not-found' };
      if (isSaveTextTooLarge(text)) {
        return { ok: false, error: SAVE_RAW_TOO_LARGE_ERROR, code: 'too-large' };
      }
      return { ok: true, text };
    },
    async readBackup() {
      // localStorage 只保留当前版本，没有文件级备份/轮换能力，不冒充桌面备份语义。
      return {
        ok: false,
        error: '浏览器模式没有上一版本备份（localStorage 不保留历史版本）',
        code: 'not-found',
      };
    },
    async write(slot, text) {
      if (isSaveTextTooLarge(text)) {
        return { ok: false, error: SAVE_RAW_TOO_LARGE_ERROR, code: 'too-large' };
      }
      try {
        localStorage.setItem(STORAGE_PREFIX + slot, text);
        return { ok: true };
      } catch (error) {
        return browserWriteFailure(error);
      }
    },
    async remove(slot) {
      localStorage.removeItem(STORAGE_PREFIX + slot);
      return { ok: true };
    },
    onMenuAction() {
      return () => undefined;
    },
    quit() {
      window.close();
    },
  };
}
