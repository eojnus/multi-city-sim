import type { DesktopSimApi, SaveSlotInfo } from './desktop';

const STORAGE_PREFIX = 'lanwan-save:';
/**
 * v1.6 §三：世界状态（近上限 480 家企业 + 银行/证券/债券/维护费流水）在 15 个月即达 12MB，
 * 旧 8MB 上限会让正常游戏无法保存；上限提高到 64MiB（字节，UTF-8），并保留明确错误提示。
 * 必须与 electron/saveIpc.MAX_SAVE_BYTES 一致（tests/save-boundary-v17.test.ts 校验）。
 */
export const MAX_SAVE_BYTES = 64 * 1024 * 1024;
/** 与 electron/saveIpc.SAVE_TOO_LARGE_ERROR 完全一致的用户可见文案。 */
export const SAVE_TOO_LARGE_ERROR = '存档过大（超过 64MB / 64MiB 限制）';

/** 文本的 UTF-8 字节数（与主进程 Buffer.byteLength 口径一致；浏览器/Node 24 都有 TextEncoder）。 */
export function saveTextByteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/**
 * 渲染层写入/读取前的上限预检。
 *
 * 必须按 UTF-8 字节判断：中文 1 个字 = 3 字节，只用 `text.length` 会放过主进程随后拒绝的
 * 存档（出现“预检通过但保存失败”的不一致）。快路径利用 length ≤ 字节数 ≤ 3×length：
 * 超上限的 length 直接拒绝，明显安全的小存档不做编码分配，只有边界灰区才精确编码。
 */
export function isSaveTextTooLarge(text: string, maxBytes = MAX_SAVE_BYTES): boolean {
  if (text.length > maxBytes) return true;
  if (text.length * 3 <= maxBytes) return false;
  return saveTextByteLength(text) > maxBytes;
}

export type SaveReadCode = 'not-found' | 'read-error' | 'too-large' | 'invalid-slot';

export interface SaveBridge {
  mode: 'desktop' | 'browser';
  list(): Promise<SaveSlotInfo[]>;
  read(slot: string): Promise<{ ok: boolean; text?: string; error?: string; code?: SaveReadCode }>;
  write(slot: string, text: string): Promise<{ ok: boolean; error?: string }>;
  remove(slot: string): Promise<{ ok: boolean; error?: string }>;
  onMenuAction(callback: (action: string) => void): () => void;
  quit(): void;
  saveDirectory?: string;
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
      async write(slot, text) {
        if (isSaveTextTooLarge(text)) return { ok: false, error: SAVE_TOO_LARGE_ERROR };
        const result = await desktop.saves.write(slot, text);
        return { ok: result.ok, error: result.error };
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
            size: text.length,
          });
        } catch {
          slots.push({ slot, exists: true, error: '浏览器存档损坏' });
        }
      }
      return slots;
    },
    async read(slot) {
      const text = localStorage.getItem(STORAGE_PREFIX + slot);
      if (text === null) return { ok: false, error: '存档不存在', code: 'not-found' };
      if (isSaveTextTooLarge(text)) {
        return { ok: false, error: SAVE_TOO_LARGE_ERROR, code: 'too-large' };
      }
      return { ok: true, text };
    },
    async write(slot, text) {
      if (isSaveTextTooLarge(text)) return { ok: false, error: SAVE_TOO_LARGE_ERROR };
      try {
        localStorage.setItem(STORAGE_PREFIX + slot, text);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: (error as Error).message };
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
