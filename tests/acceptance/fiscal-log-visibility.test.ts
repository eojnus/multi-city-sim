// 验收补充：财政日志的可见性（v0.7 验收问题 5）。
// 口径：政府具体借款/垫付/勾销/兑付汇总/债务率仅该城市现任市长可见；
// 破产事实与重选结果公开（不含金额）。渲染期按当前 mayorCityId 重新过滤。
import { beforeAll, describe, expect, it } from 'vitest';
import { GameStore } from '../../src/app/gameStore';
import { Simulation } from '../../src/simulation/core/simulation';
import type { SaveBridge } from '../../src/platform/saveBridge';

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

let store: GameStore;
let bankruptCityId: string;
let otherCityId: string;

beforeAll(() => {
  store = createStore();
  for (let i = 0; i < 40; i += 1) {
    const city = store.world.cities.find(
      (entry) => (entry.government?.bankruptcy?.status ?? 'solvent') === 'bankrupt',
    );
    if (city) {
      bankruptCityId = city.id;
      break;
    }
    store.tick();
  }
  expect(bankruptCityId, '前置条件：36 月内应出现破产城市').toBeTruthy();
  otherCityId = store.world.cities.find((entry) => entry.id !== bankruptCityId)?.id ?? '';
  store.world.player.roles.mayorCityId = null;
  store.emit();
}, 180_000);

function messages(viewerMayorCityId: string | null): string[] {
  store.world.player.roles.mayorCityId = viewerMayorCityId;
  store.emit();
  const entries = store.visibleLog();
  return entries.map((entry) => entry.message);
}

describe('AC-I11 财政日志按现任市长身份过滤', () => {
  it('I11a 非市长：看得到破产事实（不含金额），看不到兑付/勾销/债务率明细', () => {
    const list = messages(null);
    expect(list.some((message) => message.includes('政府破产：已触发破产清算与重选程序'))).toBe(true);
    expect(list.some((message) => message.includes('银行兑付债券本金'))).toBe(false);
    expect(list.some((message) => message.includes('政府向银行借款'))).toBe(false);
    expect(list.some((message) => message.includes('债务/GDP'))).toBe(false);
  });

  it('I11b 该城市长：可见破产明细与政府借款/兑付金额', () => {
    const list = messages(bankruptCityId);
    expect(list.some((message) => message.includes('银行兑付债券本金'))).toBe(true);
    expect(list.some((message) => message.includes('债务/GDP') && message.includes('破产'))).toBe(true);
  });

  it('I11c 其他城市长：看不到该城的财政明细（跨城不泄漏）', () => {
    const list = messages(otherCityId);
    const cityName = store.world.cities.find((entry) => entry.id === bankruptCityId)!.name;
    // 断言必须带城市名：v0.9 序列中另一座城市也可能在 36 月内破产，
    // 其自身同名明细对其他城市的现任市长是可见的（那是该市自己的账）。
    expect(list.some((message) => message.includes(`${cityName} 政府破产：债务`))).toBe(false);
    expect(list.some((message) => message.includes(`${cityName} 政府破产`) && message.includes('银行兑付债券本金'))).toBe(false);
  });

  it('I11d 换任后：原市长失去明细，新市长可见', () => {
    const cityName = store.world.cities.find((entry) => entry.id === bankruptCityId)!.name;
    const detailOfBankruptCity = (list: string[]) =>
      list.some((message) => message.includes(`${cityName} 政府破产`) && message.includes('银行兑付债券本金'));
    // 先以市长身份确认可见
    expect(detailOfBankruptCity(messages(bankruptCityId))).toBe(true);
    // 换任为另一座城市（模拟落选/换任）：该城明细不可见
    expect(detailOfBankruptCity(messages(otherCityId))).toBe(false);
    expect(detailOfBankruptCity(messages(bankruptCityId))).toBe(true);
  });
});
