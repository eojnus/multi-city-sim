import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation/core/simulation';
import { parseSave, serializeSave } from '../src/simulation/core/save';
import { GameStore } from '../src/app/gameStore';
import type { SaveBridge } from '../src/platform/saveBridge';

function baseSaveText(): string {
  return serializeSave(Simulation.create().state, '2026-11-01T00:00:00.000Z');
}

function mutateSave(mutator: (world: Record<string, any>) => void): string {
  const save = JSON.parse(baseSaveText()) as { world: Record<string, any> };
  mutator(save.world);
  return JSON.stringify(save);
}

function fakeBridge(overrides: Partial<SaveBridge> = {}): SaveBridge {
  return {
    mode: 'desktop',
    list: async () => [],
    read: async () => ({ ok: false, error: '存档不存在' }),
    write: async () => ({ ok: true }),
    remove: async () => ({ ok: true }),
    onMenuAction: () => () => undefined,
    quit: () => undefined,
    ...overrides,
  };
}

describe('损坏/不兼容存档防护', () => {
  it('缺少 publicSector 时返回明确错误而不是抛出 TypeError', () => {
    const text = mutateSave((world) => {
      delete world.cities[0].publicSector;
    });
    const result = parseSave(text);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('publicSector');
  });

  it('关键字段类型错误时返回读取错误', () => {
    const text = mutateSave((world) => {
      world.cities[0].population.total = '120000';
    });
    const result = parseSave(text);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('population.total');
  });

  it('损坏 JSON 与版本过新均被拒绝', () => {
    const broken = parseSave('{ definitely not json');
    expect(broken.ok).toBe(false);
    expect(broken.error).toContain('JSON');

    const save = JSON.parse(baseSaveText()) as { formatVersion: number };
    save.formatVersion = 99;
    const tooNew = parseSave(JSON.stringify(save));
    expect(tooNew.ok).toBe(false);
    expect(tooNew.error).toContain('高于');
  });

  it('读取失败不改变当前游戏状态', () => {
    const store = new GameStore(Simulation.create(), fakeBridge());
    const before = JSON.stringify(store.world);
    const bad = mutateSave((world) => {
      delete world.cities[0].publicSector;
    });
    expect(store.loadFromText(bad)).toBe(false);
    expect(JSON.stringify(store.world)).toBe(before);
  });

  it('启动时损坏的自动存档不会被自动覆盖，且程序保留可用世界', async () => {
    let writes = 0;
    const bad = mutateSave((world) => {
      world.cities[0].population.total = 'broken';
    });
    const bridge = fakeBridge({
      read: async () => ({ ok: true, slot: 'autosave', text: bad }),
      write: async () => {
        writes += 1;
        return { ok: true, slot: 'autosave' };
      },
    });
    const store = new GameStore(Simulation.create(), bridge);
    await expect(store.tryRestoreAutosave()).resolves.toBe(false);
    expect(store.autosaveDisabled).toBe(true);
    expect(store.autosaveDisabledReason).toContain('population.total');
    await store.autosave();
    expect(writes).toBe(0);
    expect(store.world.cities.length).toBe(3);
  });
});
