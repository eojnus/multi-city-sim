// v1.7 起当前存档是 v10 模块化格式；本文件测的是**旧单体存档**的校验/迁移/损坏防护语义
// （篡改 world 字段必须是旧单体结构），因此固定使用 core/save.ts 的 serializeLegacySave 生成
// formatVersion 9 明文夹具。当前 v10 格式的往返/未知模块/大小口径由
// tests/persistence/{roundtrip,backward-compatibility,save-failure-protection}.test.ts 与
// tests/save-boundary-v17.test.ts 覆盖，避免本文件同时承担两种格式语义。
import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation/core/simulation';
import { parseSave, serializeLegacySave } from '../src/simulation/core/save';
import { GameStore } from '../src/app/gameStore';
import type { SaveBridge } from '../src/platform/saveBridge';

/** 旧单体（formatVersion 9）明文存档文本：只用于旧档校验/迁移语义测试。 */
function baseSaveText(): string {
  return serializeLegacySave(Simulation.create().state, '2026-11-01T00:00:00.000Z');
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

  it('自动存档存在但无法读取时暂停自动写入，原文件保留', async () => {
    let writes = 0;
    const bridge = fakeBridge({
      read: async () => ({
        ok: false,
        error: '存档过大（压缩文件超过 64MiB 上限）',
        code: 'too-large' as const,
      }),
      write: async () => {
        writes += 1;
        return { ok: true, slot: 'autosave' };
      },
    });
    const store = new GameStore(Simulation.create(), bridge);
    await expect(store.tryRestoreAutosave()).resolves.toBe(false);
    expect(store.autosaveDisabled).toBe(true);
    expect(store.autosaveDisabledReason).toContain('存档过大');
    expect(store.systemNotices.some((notice) => notice.tone === 'error')).toBe(true);
    await store.autosave();
    expect(writes).toBe(0);
  });

  it('自动存档不存在时按首次运行处理，不会误判为损坏', async () => {
    let writes = 0;
    const bridge = fakeBridge({
      read: async () => ({ ok: false, error: '存档不存在', code: 'not-found' as const }),
      write: async () => {
        writes += 1;
        return { ok: true, slot: 'autosave' };
      },
    });
    const store = new GameStore(Simulation.create(), bridge);
    await expect(store.tryRestoreAutosave()).resolves.toBe(false);
    expect(store.autosaveDisabled).toBe(false);
    expect(store.world.cities.length).toBe(3);
    await store.autosave();
    expect(writes).toBe(1);
  });
});

describe('企业退出后的协议审计记录', () => {
  function withTerminalAgreement(mutator: (agreement: Record<string, any>) => void): string {
    return mutateSave((world) => {
      const template = JSON.parse(JSON.stringify(world.agreements[0] ?? {}));
      const agreement: Record<string, any> = {
        ...template,
        id: 'agreement-terminal-test',
        title: '验收测试协议',
        sponsorCityId: world.cities[0].id,
        partnerCityId: world.cities[1].id,
        createdTick: 0,
        createdBy: 'demo',
        status: 'completed',
        participants: [
          {
            companyId: 'gone-company',
            cityId: world.cities[0].id,
            side: 'seller',
            decision: 'declined',
            decidedTick: 1,
            note: '企业已倒闭，不再履约。',
          },
        ],
        items: [
          {
            id: 'agreement-terminal-item-failed',
            good: 'food',
            buyerCompanyId: 'gone-company',
            sellerCompanyId: 'gone-company',
            qtyPerMonth: 1,
            unitPrice: 1,
            months: 1,
            deliveredQty: 0,
            paidValue: 0,
            monthsExecuted: 0,
            status: 'failed',
            lastNote: '相关企业已倒闭。',
          },
          {
            id: 'agreement-terminal-item-fulfilled',
            good: 'food',
            buyerCompanyId: 'gone-company',
            sellerCompanyId: 'gone-company',
            qtyPerMonth: 1,
            unitPrice: 1,
            months: 3,
            deliveredQty: 3,
            paidValue: 3,
            monthsExecuted: 3,
            status: 'fulfilled',
            lastNote: '已履约完毕。',
          },
        ],
        note: '协议因参与企业倒闭而结束。',
      };
      mutator(agreement);
      world.agreements.push(agreement);
    });
  }

  it('终态参与者/条目允许引用已退出的企业（审计留痕）', () => {
    const text = withTerminalAgreement((agreement) => {
      agreement.participants[0].decision = 'declined';
      agreement.items[0].status = 'failed';
      agreement.items[1].status = 'fulfilled';
    });
    const result = parseSave(text);
    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    // 往返后记录仍在，便于审计。
    expect(result.world?.agreements.some((entry) => entry.id === 'agreement-terminal-test')).toBe(true);
  });

  it('未终结的参与者/条目引用不存在的企业仍被拒绝', () => {
    const pendingParticipant = withTerminalAgreement((agreement) => {
      agreement.status = 'active';
      agreement.participants[0].decision = 'pending';
      agreement.participants[0].decidedTick = null;
    });
    const participantResult = parseSave(pendingParticipant);
    expect(participantResult.ok).toBe(false);
    expect(participantResult.error).toContain('参与企业无效');

    const pendingItem = withTerminalAgreement((agreement) => {
      // 让参与方指向真实企业，单独验证“未终结条目”仍要求企业存在。
      const save = JSON.parse(baseSaveText()) as { world: { companies: Array<{ id: string }> } };
      agreement.status = 'active';
      agreement.participants[0].companyId = save.world.companies[0]?.id ?? 'lp-food';
      agreement.participants[0].decision = 'accepted';
      agreement.items[0].status = 'active';
    });
    const itemResult = parseSave(pendingItem);
    expect(itemResult.ok).toBe(false);
    expect(itemResult.error).toContain('买方无效');
  });
});
