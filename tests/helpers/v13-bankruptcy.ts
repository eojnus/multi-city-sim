// v1.3 验收辅助：构造“真实债券兑付”的破产场景。
//
// 背景：v1.3 经济修复后，seed 20261101 的真实 36 月序列不再触发政府破产
// （见 tests/acceptance/bankruptcy-real-run.test.ts）。依赖“必须出现破产城市”的
// 验收测试改为用本 helper 显式构造破产，并保留真实债券兑付/垫付/勾销流水，
// 使公开面板与财政日志断言仍能覆盖真实金额路径。
import { GameStore } from '../../src/app/gameStore';
import { Simulation } from '../../src/simulation/core/simulation';
import { DEMO_CONFIG } from '../../src/data/config';
import { issueGovernmentBond, subscribeGovernmentBond } from '../../src/simulation/government/bonds';
import { settleCityGovernmentDebt } from '../../src/simulation/government/debt';
import { ensureInvestorOpeningShares } from '../../src/simulation/investors/investors';
import type { SaveBridge } from '../../src/platform/saveBridge';
import type { LogEntry } from '../../src/simulation/contracts/types';

export function createStore(): GameStore {
  const bridge: SaveBridge = {
    list: async () => ({ ok: true, slots: [] }),
    read: async (slot: string) => ({ ok: false, slot, error: '存档不存在', code: 'not-found' }),
    write: async (slot: string) => ({ ok: true, slot, savedAt: new Date().toISOString() }),
    remove: async () => ({ ok: true }),
    onMenuAction: () => () => undefined,
  } as unknown as SaveBridge;
  return new GameStore(Simulation.create(), bridge);
}

export interface ConstructedBankruptcy {
  store: GameStore;
  bankruptCityId: string;
  solventCityId: string;
  logs: LogEntry[];
}

/**
 * 构造一座破产城市：
 * - 把该城 12 个月 GDP 窗口压到 100/月（判定 GDP=1200）；
 * - 发行 100 份债券并由玩家全额认购（真实本金 100,000）；
 * - treasury 置 0 后结算 → 债务/GDP 远超 100%，触发破产并真实兑付债券
 *   （bankAdvanceCreated / bondsRedeemedPrincipal / bondRedemptionCount 均 > 0）。
 * 结算产生的日志会追加到 world.log（与 Simulation.tick 的行为一致），
 * 供 visibleLog / 公开面板过滤测试使用。
 */
export function constructBankruptcy(): ConstructedBankruptcy {
  const store = createStore();
  const world = store.world;
  const city = world.cities[0]!;
  world.time.tick = 0;
  city.gdpWindow = Array.from({ length: 12 }, (_, index) => ({
    tick: -12 + index,
    value: 100,
    estimated: true,
  }));
  city.treasury = 0;
  ensureInvestorOpeningShares(world);

  const issue = issueGovernmentBond(world, city, DEMO_CONFIG, 100, 0);
  if (!issue.ok || !issue.issuance) {
    throw new Error(`构造破产场景失败：发行债券失败（${issue.error ?? '未知原因'}）`);
  }
  const subscription = subscribeGovernmentBond(
    world,
    DEMO_CONFIG,
    issue.issuance.id,
    { kind: 'player', id: 'player' },
    100,
    0,
  );
  if (!subscription.ok) {
    throw new Error(`构造破产场景失败：认购债券失败（${subscription.error ?? '未知原因'}）`);
  }

  const logs: LogEntry[] = [];
  const settlement = settleCityGovernmentDebt(world, city, DEMO_CONFIG, logs);
  if (!settlement.bankrupted) {
    throw new Error('构造破产场景失败：结算未触发破产');
  }
  world.log.push(...logs);

  store.world.player.roles.mayorCityId = null;
  store.emit();

  return {
    store,
    bankruptCityId: city.id,
    solventCityId: world.cities.find((entry) => entry.id !== city.id)?.id ?? '',
    logs,
  };
}
