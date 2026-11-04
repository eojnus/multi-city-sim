// 验收 I 组补充：公开破产面板权限（交付分支 b85cc0f / 界面 e49079d）。
// 口径（SUPPLEMENT_ARCHITECT_v1 §7 / DECISIONS #9）：破产事件公开——非市长可看到
// 破产事实、银行垫付、已勾销、股份托管；但财政余额、流水、债务率、风险档仍仅市长可见。
import { beforeAll, describe, expect, it } from 'vitest';
import { GameStore } from '../../src/app/gameStore';
import { Simulation } from '../../src/simulation/core/simulation';
import type { SaveBridge } from '../../src/platform/saveBridge';
import { renderRightCity } from '../../src/ui/panels';

const panelState = { showAllGoods: false, logCollapsed: false } as never;

function createStore(): GameStore {
  const bridge: SaveBridge = {
    list: async () => ({ ok: true, slots: [] }),
    read: async (slot: string) => ({ ok: false, slot, error: '存档不存在', code: 'not-found' }),
    write: async (slot: string) => ({ ok: true, slot, savedAt: new Date().toISOString() }),
    remove: async () => ({ ok: true }),
    onMenuAction: () => () => undefined,
  } as unknown as SaveBridge;
  return new GameStore(Simulation.create(), bridge);
}

function isBankrupt(store: GameStore, cityId: string): boolean {
  const city = store.world.cities.find((entry) => entry.id === cityId);
  return (city?.government?.bankruptcy?.status ?? 'solvent') === 'bankrupt';
}

let store: GameStore;
let bankruptCityId: string;
let solventCityId: string;

beforeAll(() => {
  store = createStore();
  // 真实 36 月序列里首个破产发生在岚港 t27（见矩阵 §1.6）；推进到出现破产城市为止。
  for (let i = 0; i < 40; i += 1) {
    const city = store.world.cities.find((entry) => isBankrupt(store, entry.id));
    if (city) {
      bankruptCityId = city.id;
      break;
    }
    store.tick();
  }
  expect(bankruptCityId, '前置条件：36 月内应出现破产城市').toBeTruthy();
  const solvent = (store.world.cities.find((entry) => !isBankrupt(store, entry.id))?.id ?? '');
  solventCityId = solvent;
  // 回到非市长身份（玩家默认不是市长；破产重选选的是 AI 市长）。
  store.world.player.roles.mayorCityId = null;
  store.emit();
}, 180_000);

describe('AC-I10 公开破产面板权限（非市长可见破产事实、不见财政细节）', () => {
  it('I10a 非市长城市视图：破产事实/重选/股份托管可见，具体金额仅提示受限', () => {
    store.selectCity(bankruptCityId);
    const html = renderRightCity(store, panelState);
    expect(html).toContain('data-testid="public-bankruptcy-notice"');
    expect(html).toContain('data-testid="bankruptcy-share-disposal"');
    expect(html).toContain('data-testid="bankruptcy-details-restricted"');
    // 政府具体兑付/垫付/勾销金额不得对非市长渲染（v0.7 验收问题 5）。
    expect(html).not.toContain('data-testid="bankruptcy-advance"');
    expect(html).not.toContain('data-testid="bankruptcy-written-off"');
    expect(html).not.toContain('data-testid="bankruptcy-bond-redemptions"');
    expect(html).toMatch(/破产|重选/);
  });

  it('I10b 非市长看不到财政余额、流水、债务率、风险档（testid 级）', () => {
    store.selectCity(bankruptCityId);
    const html = renderRightCity(store, panelState);
    for (const forbidden of [
      'data-testid="mayor-fiscal-panel"',
      'data-testid="fiscal-treasury"',
      'data-testid="fiscal-total-debt"',
      'data-testid="fiscal-debt-ratio"',
      'data-testid="fiscal-risk-badge"',
      'data-testid="fiscal-ledger"',
    ]) {
      expect(html, `非市长不得出现 ${forbidden}`).not.toContain(forbidden);
    }
    // 受限占位仍在（市长专属区域提示）。
    expect(html).toContain('data-testid="fiscal-restricted"');
  });

  it('I10c 市长在破产城市：公开面板 + 财政面板并存（余额/风险仅市长可见）', () => {
    store.world.player.roles.mayorCityId = bankruptCityId;
    store.emit();
    try {
      store.selectCity(bankruptCityId);
      const html = renderRightCity(store, panelState);
      expect(html).toContain('data-testid="public-bankruptcy-notice"');
      expect(html).toContain('data-testid="mayor-fiscal-panel"');
      expect(html).toContain('data-testid="fiscal-treasury"');
      expect(html).toContain('data-testid="fiscal-debt-ratio"');
      expect(html).not.toContain('data-testid="fiscal-restricted"');
    } finally {
      store.world.player.roles.mayorCityId = null;
      store.emit();
    }
  });

  it('I10d 公开投影不含财政余额/实时债务率/风险档；非市长金额字段为 null', () => {
    const notice = store.publicBankruptcy(bankruptCityId);
    expect(notice).toBeTruthy();
    const keys = Object.keys(notice ?? {});
    for (const forbidden of ['treasury', 'debtRatio', 'riskLevel', 'gdpJudgementValue']) {
      expect(keys, `公开投影不得含 ${forbidden}`).not.toContain(forbidden);
    }
    expect(notice!.detailsVisible).toBe(false);
    expect(notice!.bankAdvanceCreated).toBeNull();
    expect(notice!.bondRedemptionCount).toBeNull();
    expect(notice!.bondsRedeemedPrincipal).toBeNull();
    expect(notice!.interestWrittenOff).toBeNull();
    expect(notice!.note).not.toMatch(/\d{2,}/);
  });

  it('I10f 该城市现任市长可见兑付/垫付/勾销金额与债务口径', () => {
    store.world.player.roles.mayorCityId = bankruptCityId;
    store.emit();
    try {
      const notice = store.publicBankruptcy(bankruptCityId)!;
      expect(notice.detailsVisible).toBe(true);
      expect(notice.bankAdvanceCreated).toBeGreaterThan(0);
      expect(notice.bondRedemptionCount).toBeGreaterThan(0);
      expect(notice.bondsRedeemedPrincipal).toBeGreaterThan(0);
      expect(notice.note).toContain('债务/GDP');
      store.selectCity(bankruptCityId);
      const html = renderRightCity(store, panelState);
      expect(html).toContain('data-testid="bankruptcy-details"');
      expect(html).toContain('data-testid="bankruptcy-advance"');
      expect(html).toContain('data-testid="bankruptcy-written-off"');
      expect(html).toContain('data-testid="bankruptcy-bond-redemptions"');
      expect(html).not.toContain('data-testid="bankruptcy-details-restricted"');
    } finally {
      store.world.player.roles.mayorCityId = null;
      store.emit();
    }
  });

  it('I10e 未破产城市：无公开破产面板、公开投影为 null', () => {
    // v0.9 序列中三座城市都会在 36 月内破产，因此这里构造一个“未破产”城市视图，
    // 只验证投影与面板逻辑（不改动真实破产记录，断言后恢复原状态）。
    const cityId = solventCityId || bankruptCityId;
    const city = store.world.cities.find((entry) => entry.id === cityId)!;
    const savedGovernment = city.government.bankruptcy;
    const savedMirror = city.bankruptcy;
    const savedRecords = city.government.records;
    city.government.bankruptcy = { status: 'solvent', tick: null, recordId: null, debtRatio: null };
    city.bankruptcy = { status: 'solvent', tick: null, recordId: null, debtRatio: null };
    city.government.records = [];
    try {
      expect(store.publicBankruptcy(cityId)).toBeNull();
      store.selectCity(cityId);
      const html = renderRightCity(store, panelState);
      expect(html).not.toContain('data-testid="public-bankruptcy-notice"');
    } finally {
      city.government.bankruptcy = savedGovernment;
      city.bankruptcy = savedMirror;
      city.government.records = savedRecords;
    }
  });
});
