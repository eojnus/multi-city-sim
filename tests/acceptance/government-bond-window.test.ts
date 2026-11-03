// v0.7 验收问题 1/2：政府债券认购窗口（手动发债 AI 认购、玩家购买 AI 城市债券、存档幂等）。
// 口径见 docs/development/DESIGN_government_bonds_debt_fixes_v0.7.md §1。
import { describe, expect, it } from 'vitest';
import { GameStore } from '../../src/app/gameStore';
import { Simulation } from '../../src/simulation/core/simulation';
import type { SaveBridge } from '../../src/platform/saveBridge';
import { DEMO_CONFIG } from '../../src/data/config';
import type { BondHolder, LogEntry } from '../../src/simulation/contracts/types';
import {
  bondSubscriptionCloseTick,
  closeGovernmentBondSubscription,
  issueGovernmentBond,
  settleBondSubscriptionWindow,
  subscribeGovernmentBond,
} from '../../src/simulation/government/bonds';
import {
  maybeAutoIssueGovernmentBond,
  settleCityGovernmentDebt,
} from '../../src/simulation/government/debt';
import { parseSave, serializeSave } from '../../src/simulation/core/save';
import { cityById, newWorld } from './helpers';

const CONFIG = DEMO_CONFIG;
const PLAYER: BondHolder = { kind: 'player', id: 'player' };
const SAVE_STAMP = '2026-11-01T00:00:00.000Z';

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

describe('问题1：市长手动发债的认购窗口（AI 真实资金认购、部分成交、资金入账）', () => {
  it('窗口关闭时由居民投资实体/企业用真实资金按整数份、部分成交认购，资金进发行城市财政', () => {
    const world = newWorld(0);
    const city = cityById(world, 'lanport');
    const issued = issueGovernmentBond(world, city, CONFIG, 10, 0);
    expect(issued.ok).toBe(true);
    const issuance = issued.issuance!;
    expect(issuance.status).toBe('offering');
    expect(issuance.soldUnits).toBe(0);
    expect(issuance.unsoldUnits).toBe(10);
    // 认购窗口 = 发行当月：发行 tick 至下一次月结关闭。
    expect(bondSubscriptionCloseTick(issuance)).toBe(1);

    // 只给一个居民投资实体 3000 现金，其余主体 0：成交份数必须受真实可用资金约束。
    for (const group of world.investors) group.cash = 0;
    for (const company of world.companies) company.cash = 0;
    world.investors[0]!.cash = 3_000;

    const treasuryBefore = city.treasury;
    world.time.tick = 1;
    const logs: LogEntry[] = [];
    const result = settleBondSubscriptionWindow(world, CONFIG, city, 1, logs);

    expect(result.issuancesClosed).toBe(1);
    expect(result.subscribedUnits).toBe(3); // 3000 / 面额 1000，整数份、部分成交
    expect(result.proceeds).toBe(3_000);
    expect(city.treasury).toBeCloseTo(treasuryBefore + 3_000, 2);
    expect(issuance.soldUnits).toBe(3);
    expect(issuance.unsoldUnits).toBe(7);
    expect(issuance.status).toBe('active');
    expect(issuance.closedTick).toBe(1);
    expect(issuance.principal).toBeCloseTo(3_000, 2);

    const holdings = world.bonds!.holdings.filter((entry) => entry.issuanceId === issuance.id);
    expect(holdings).toHaveLength(1);
    expect(holdings[0]!.holder.kind).toBe('investorGroup');
    expect(holdings[0]!.units).toBe(3);
    expect(Number.isInteger(holdings[0]!.units)).toBe(true);
    // 未售出份数不形成债务：本金只按成交份数计。
    expect(issuance.principal).toBeCloseTo(issuance.soldUnits * issuance.faceValue, 2);

    // 幂等：同一窗口重复结算不重复认购、不重复入账。
    const again = settleBondSubscriptionWindow(world, CONFIG, city, 1, logs);
    expect(again.issuancesClosed).toBe(0);
    expect(again.subscribedUnits).toBe(0);
    expect(again.proceeds).toBe(0);
    expect(world.bonds!.holdings.filter((entry) => entry.issuanceId === issuance.id)).toHaveLength(1);
    expect(issuance.soldUnits).toBe(3);
    expect(city.treasury).toBeCloseTo(treasuryBefore + 3_000, 2);
  });

  it('GameStore 端到端：发起发行→推进一月→AI 认购入账→不自动扣玩家现金', () => {
    const store = createStore();
    const world = store.world;
    world.player.roles.mayorCityId = 'lanport';
    world.player.cash = 123_456;
    const city = cityById(world, 'lanport');

    expect(store.issueBond('lanport', 100)).toBe(true);
    const issuance = world.bonds!.issuances.find((entry) => entry.cityId === city.id)!;
    expect(issuance).toBeDefined();
    expect(issuance.status).toBe('offering');
    expect(issuance.soldUnits).toBe(0);
    expect(issuance.planUnits).toBe(100);

    const playerCashBefore = world.player.cash;
    expect(store.tick()).toBe(true);

    expect(issuance.status).toBe('active');
    expect(issuance.closedTick).toBe(1);
    expect(issuance.soldUnits).toBeGreaterThan(0);
    expect(issuance.soldUnits + issuance.unsoldUnits).toBe(100);
    expect(issuance.principal).toBeCloseTo(issuance.soldUnits * issuance.faceValue, 2);

    // 认购资金真实进入发行城市财政（fiscal 流水，tick=月结 tick）。
    const proceeds = world.fiscal.ledger
      .filter((entry) => entry.tick === 1 && entry.cityId === city.id && entry.kind === 'bondIssuanceProceeds')
      .reduce((sum, entry) => sum + entry.amount, 0);
    expect(proceeds).toBeCloseTo(issuance.soldUnits * issuance.faceValue, 2);

    // 玩家未被自动扣款（AI 政府不得使用玩家资金；玩家当月股息等入账不受影响）。
    expect(world.player.cash).toBeGreaterThanOrEqual(playerCashBefore);
    expect(store.ownBondHoldings.filter((entry) => entry.issuanceId === issuance.id)).toHaveLength(0);
    const holdings = world.bonds!.holdings.filter((entry) => entry.issuanceId === issuance.id);
    expect(holdings.length).toBeGreaterThan(0);
    expect(holdings.every((entry) => entry.holder.kind !== 'player')).toBe(true);
    expect(holdings.every((entry) => Number.isInteger(entry.units) && entry.units > 0)).toBe(true);
  });

  it('读档后窗口状态一致；关闭窗口与重复结算均不重复认购', () => {
    const build = () => {
      const world = newWorld(0);
      const city = cityById(world, 'lanport');
      world.player.cash = 5_000;
      const issued = issueGovernmentBond(world, city, CONFIG, 10, 0);
      const issuance = issued.issuance!;
      const bought = subscribeGovernmentBond(world, CONFIG, issuance.id, PLAYER, 2, 0);
      expect(bought.ok).toBe(true);
      expect(bought.units).toBe(2);
      return { world, city, issuance };
    };

    const continuous = build();
    continuous.world.time.tick = 1;
    settleCityGovernmentDebt(continuous.world, continuous.city, CONFIG, []);

    const saveText = serializeSave(build().world, SAVE_STAMP);
    const parsed = parseSave(saveText);
    expect(parsed.ok).toBe(true);
    const loaded = parsed.world!;
    // 读档后窗口仍是 offering，玩家窗口内买入的 2 份仍在。
    const loadedOffering = loaded.bonds!.issuances[0]!;
    expect(loadedOffering.status).toBe('offering');
    expect(loadedOffering.soldUnits).toBe(2);
    expect(loaded.bonds!.holdings.some((entry) => entry.holder.kind === 'player' && entry.units === 2)).toBe(true);

    loaded.time.tick = 1;
    const loadedCity = cityById(loaded, 'lanport');
    settleCityGovernmentDebt(loaded, loadedCity, CONFIG, []);
    const loadedIssuance = loaded.bonds!.issuances[0]!;
    const continuousIssuance = continuous.world.bonds!.issuances[0]!;
    expect(loadedIssuance.soldUnits).toBe(continuousIssuance.soldUnits);
    expect(loadedIssuance.unsoldUnits).toBe(continuousIssuance.unsoldUnits);
    expect(loadedIssuance.closedTick).toBe(1);
    expect(loadedCity.treasury).toBeCloseTo(continuous.city.treasury, 2);
    expect(loaded.bonds!.holdings.filter((entry) => entry.issuanceId === loadedIssuance.id)).toHaveLength(
      continuous.world.bonds!.holdings.filter((entry) => entry.issuanceId === continuousIssuance.id).length,
    );

    // 同一 tick 重复结算：settledTicks 幂等，不重复认购/入账。
    const sold = loadedIssuance.soldUnits;
    const holdingsCount = loaded.bonds!.holdings.length;
    const treasury = loadedCity.treasury;
    settleCityGovernmentDebt(loaded, loadedCity, CONFIG, []);
    expect(loaded.bonds!.issuances[0]!.soldUnits).toBe(sold);
    expect(loaded.bonds!.holdings.length).toBe(holdingsCount);
    expect(loadedCity.treasury).toBeCloseTo(treasury, 2);
  });
});

describe('问题2：玩家可在 AI 城市发行窗口内购买其债券', () => {
  it('AI 发债只创建 offering 窗口；玩家真实购买；窗口关闭后不可再买', () => {
    const store = createStore();
    const world = store.world;
    world.player.roles.mayorCityId = null;
    world.player.cash = 500_000;
    const city = cityById(world, 'ironvale');
    city.treasury = 0;
    city.fiscalExpenseBaseline = 200_000;

    const result = maybeAutoIssueGovernmentBond(world, city, CONFIG, world.time.tick, []);
    expect(result.issued).toBe(true);
    const issuance = world.bonds!.issuances.find((entry) => entry.cityId === city.id)!;
    expect(issuance).toBeDefined();
    // 不再同一次月结内创建+认购+立即关闭：窗口留给玩家操作。
    expect(issuance.status).toBe('offering');
    expect(issuance.soldUnits).toBe(0);
    expect(issuance.issuedTick).toBe(world.time.tick);
    expect(result.units).toBe(issuance.planUnits);

    const offer = store.bondMarketOffers.find((entry) => entry.issuanceId === issuance.id)!;
    expect(offer).toBeDefined();
    expect(offer.status).toBe('offering');
    expect(offer.subscriptionCloseTick).toBe(issuance.issuedTick + 1);
    expect(offer.termMonths).toBe(36);
    expect(offer.issuedTick).toBe(issuance.issuedTick);
    expect(offer.unitsAvailable).toBe(issuance.planUnits);

    // 玩家用自身资金购买 AI 城市债券（整数份）。
    const cashBefore = world.player.cash;
    expect(store.subscribeBond(issuance.id, 20)).toBe(true);
    expect(world.player.cash).toBeCloseTo(cashBefore - 20 * issuance.faceValue, 2);
    expect(issuance.soldUnits).toBe(20);

    // 推进一月：窗口关闭，剩余份数由居民投资实体/企业认购。
    expect(store.tick()).toBe(true);
    expect(issuance.status).toBe('active');
    expect(issuance.closedTick).toBe(issuance.issuedTick + 1);
    expect(issuance.soldUnits + issuance.unsoldUnits).toBe(issuance.planUnits);

    // 窗口关闭后不可再认购，且不扣款。
    const cashAfterClose = world.player.cash;
    expect(store.subscribeBond(issuance.id, 1)).toBe(false);
    expect(world.player.cash).toBe(cashAfterClose);
  });

  it('售罄与部分成交：申请超量按可成交份数成交，售罄后再买不扣款', () => {
    const store = createStore();
    const world = store.world;
    world.player.roles.mayorCityId = null;
    const city = cityById(world, 'greenfield');
    city.treasury = 0;
    city.fiscalExpenseBaseline = 100_000;
    expect(maybeAutoIssueGovernmentBond(world, city, CONFIG, world.time.tick, []).issued).toBe(true);
    const issuance = world.bonds!.issuances.find((entry) => entry.cityId === city.id)!;
    const available = issuance.planUnits - issuance.soldUnits;
    expect(available).toBeGreaterThan(0);
    world.player.cash = available * issuance.faceValue;

    // 部分成交：申请 available+50 份，只按可成交份数成交。
    expect(store.subscribeBond(issuance.id, available + 50)).toBe(true);
    expect(issuance.soldUnits).toBe(issuance.planUnits);
    expect(issuance.unsoldUnits).toBe(0);

    // 售罄：可认购 0 份，再买失败且不扣款。
    const cashAfterSoldOut = world.player.cash;
    expect(store.subscribeBond(issuance.id, 1)).toBe(false);
    expect(world.player.cash).toBe(cashAfterSoldOut);
    expect(store.bondMarketOffers.find((entry) => entry.issuanceId === issuance.id)?.unitsAvailable).toBe(0);
  });
});
