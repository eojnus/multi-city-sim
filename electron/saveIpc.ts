import { ipcMain } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

const SAVE_SLOT_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const MAX_SAVE_BYTES = 8 * 1024 * 1024;

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
      const slots = files.map((name) => {
        const slot = name.replace(/\.json$/, '');
        const full = path.join(dir, name);
        try {
          const stat = fs.statSync(full);
          const parsed = JSON.parse(fs.readFileSync(full, 'utf8')) as Record<string, unknown>;
          return {
            slot,
            exists: true,
            savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : undefined,
            formatVersion: typeof parsed.formatVersion === 'number' ? parsed.formatVersion : undefined,
            gameVersion: typeof parsed.gameVersion === 'string' ? parsed.gameVersion : undefined,
            size: stat.size,
          };
        } catch (error) {
          return { slot, exists: true, error: (error as Error).message };
        }
      });
      return { ok: true, slots };
    } catch (error) {
      return { ok: false, slots: [], error: (error as Error).message };
    }
  });

  ipcMain.handle('saves:read', async (_event, slot: string) => {
    try {
      const full = slotFile(slot);
      if (!fs.existsSync(full)) return { ok: false, slot, error: '存档不存在' };
      const stat = fs.statSync(full);
      if (stat.size > MAX_SAVE_BYTES) return { ok: false, slot, error: '存档过大' };
      const text = fs.readFileSync(full, 'utf8');
      return { ok: true, slot, text };
    } catch (error) {
      return { ok: false, slot, error: (error as Error).message };
    }
  });

  ipcMain.handle('saves:write', async (_event, slot: string, text: string) => {
    try {
      if (typeof text !== 'string') return { ok: false, slot, error: '存档内容无效' };
      if (Buffer.byteLength(text, 'utf8') > MAX_SAVE_BYTES) {
        return { ok: false, slot, error: '存档超过 8MB 限制' };
      }
      const parsed = JSON.parse(text) as { formatVersion?: unknown; savedAt?: unknown; world?: unknown };
      if (typeof parsed.formatVersion !== 'number' || !parsed.world) {
        return { ok: false, slot, error: '存档结构无效，未写入' };
      }
      fs.mkdirSync(savesDirectory(), { recursive: true });
      const full = slotFile(slot);
      const temp = `${full}.tmp-${process.pid}-${Date.now()}`;
      const backup = `${full}.bak`;
      fs.writeFileSync(temp, text, 'utf8');
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
      return { ok: true, slot, savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : undefined };
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
