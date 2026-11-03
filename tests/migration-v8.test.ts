// v7 → v8 存档迁移：新增股票月度行情（history）、消费税/股息税账目（world.taxes）
// 与城内交通税收系数状态。
//
// 迁移口径（任务书 + 冻结设计）：
// - 旧档没有 K 线历史 → history=[]，界面显示“暂无数据”，不根据 lastTrades 或账面价反推；
// - 不补记过去税额；本月累计为 0；
// - 不改变现金、股份、债务、价格、成交、库存与游戏进度。
import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation/core/simulation';
import { parseSave, serializeSave } from '../src/simulation/core/save';
import { SAVE_FORMAT_VERSION } from '../src/simulation/contracts/types';
import type { WorldState } from '../src/simulation/contracts/types';
import { checkInvariants } from '../src/simulation/core/invariants';

function currentWorld(months = 2): WorldState {
  const simulation = Simulation.create();
  for (let month = 0; month < months; month += 1) {
    const result = simulation.tick();
    if (!result.ok) throw new Error(`推进第 ${month + 1} 月失败：${result.error ?? '未知错误'}`);
  }
  return simulation.state;
}

interface RawSave {
  formatVersion: number;
  world: {
    taxes?: unknown;
    securities: { history?: unknown; lastTrades: unknown[] };
    cities: {
      market: Record<string, Record<string, unknown>>;
      lastMonth: Record<string, unknown>;
    }[];
  };
}

/** 把当前存档降级成结构上的 v7：删掉 v8 新增字段，格式号改 7。 */
function toV7(world: WorldState): { text: string; raw: RawSave } {
  const save = JSON.parse(serializeSave(world, '2026-11-01T00:00:00.000Z')) as unknown as RawSave;
  save.formatVersion = 7;
  delete save.world.taxes;
  delete save.world.securities.history;
  for (const city of save.world.cities) {
    for (const entry of Object.values(city.market)) delete entry.consumptionTax;
    delete city.lastMonth.consumptionTax;
    delete city.lastMonth.dividendTax;
    delete city.lastMonth.transportTaxFactor;
    delete city.lastMonth.transportTaxBonus;
    delete city.lastMonth.transportTaxLoss;
  }
  return { text: JSON.stringify(save), raw: save };
}

describe('v7 → v8 股票行情与税收状态迁移', () => {
  it('旧 v7 存档加载成功：migratedFrom=7，补空行情、空税账与中性交通系数', () => {
    const world = currentWorld(2);
    const before = {
      cash: world.player.cash,
      treasury: world.cities.map((city) => city.treasury),
      companyCash: world.companies.map((company) => company.cash),
      trades: world.securities.lastTrades.length,
    };
    const { text, raw } = toV7(world);
    const result = parseSave(text);
    expect(result.ok, result.error).toBe(true);
    expect(result.migratedFrom).toBe(7);
    expect(result.save?.formatVersion).toBe(SAVE_FORMAT_VERSION);

    const parsed = result.world!;
    // 行情：空数组，不虚构历史。
    expect(parsed.securities.history).toEqual([]);
    expect(parsed.securities.lastTrades.length).toBe(before.trades);
    // 税收：空账本，本月累计为 0。
    expect(parsed.taxes.accrualByCity).toEqual({});
    expect(parsed.taxes.historyByCity).toEqual({});
    // 市场与月度报告：补 0 / 中性系数。
    for (const city of parsed.cities) {
      for (const market of Object.values(city.market)) {
        expect(market.consumptionTax).toBe(0);
      }
      expect(city.lastMonth.consumptionTax).toBe(0);
      expect(city.lastMonth.dividendTax).toBe(0);
      expect(city.lastMonth.transportTaxFactor).toBe(1);
      expect(city.lastMonth.transportTaxBonus).toBe(0);
      expect(city.lastMonth.transportTaxLoss).toBe(0);
    }
    // 资金、股份、债务、价格与成交不变。
    expect(parsed.player.cash).toBe(before.cash);
    expect(parsed.cities.map((city) => city.treasury)).toEqual(before.treasury);
    expect(parsed.companies.map((company) => company.cash)).toEqual(before.companyCash);
    for (const [cityIndex, city] of parsed.cities.entries()) {
      const source = raw.world.cities[cityIndex];
      for (const [goodId, market] of Object.entries(city.market)) {
        const sourceMarket = source?.market[goodId];
        if (!sourceMarket) continue;
        expect(market.price).toBe(sourceMarket.price);
        expect(market.sold).toBe(sourceMarket.sold);
        expect(market.closingStock).toBe(sourceMarket.closingStock);
      }
    }
    // 迁移日志可追溯且不泄露金额。
    const migrationLog = parsed.log.find((entry) => entry.message.includes('v7 迁移到 v8'));
    expect(migrationLog).toBeDefined();
    expect(migrationLog!.message).toContain('未改变任何现金、股份与债务');
    expect(checkInvariants(parsed)).toEqual([]);
  });

  it('迁移幂等：v8 存档重复读取不追加迁移日志、不重复清空数据', () => {
    const world = currentWorld(1);
    const text = serializeSave(world);
    const first = parseSave(text);
    expect(first.ok, first.error).toBe(true);
    expect(first.migratedFrom).toBeUndefined();
    const logsAfterFirst = first.world!.log.length;
    const second = parseSave(text);
    expect(second.ok, second.error).toBe(true);
    expect(second.migratedFrom).toBeUndefined();
    expect(second.world!.log.length).toBe(logsAfterFirst);
    // 读档本身不重算或追加行情：两次读取的行情结构完全一致。
    const summarize = (entries: WorldState['securities']['history']) =>
      entries.map((entry) => ({
        shareClassId: entry.shareClassId,
        candles: entry.candles.map((candle) => candle.tick),
        lastTradeTick: entry.lastTrade?.tick ?? null,
      }));
    expect(summarize(second.world!.securities.history)).toEqual(
      summarize(first.world!.securities.history),
    );
  });

  it('v8 存档往返保留税收状态与行情字段', () => {
    const world = currentWorld(1);
    world.taxes.accrualByCity.lanport = { consumptionTax: 12.34, dividendTax: 5.66 };
    world.taxes.historyByCity.lanport = [
      {
        tick: 1,
        incomeTaxBase: 100,
        corporateTaxBase: 20,
        consumptionTaxBase: 12.34,
        dividendTaxBase: 5.66,
        transportGuarantee: 0.5,
        transportFactor: 1,
        incomeTaxRevenue: 100,
        corporateTaxRevenue: 20,
        consumptionTaxRevenue: 12.34,
        dividendTaxRevenue: 5.66,
        transportBonus: 0,
        transportLoss: 0,
        totalBase: 132.34,
        totalRevenue: 132.34,
      },
    ];
    const result = parseSave(serializeSave(world));
    expect(result.ok, result.error).toBe(true);
    expect(result.world!.taxes.accrualByCity.lanport).toEqual({
      consumptionTax: 12.34,
      dividendTax: 5.66,
    });
    expect(result.world!.taxes.historyByCity.lanport?.length).toBe(1);
    expect(result.world!.taxes.historyByCity.lanport?.[0]?.totalRevenue).toBe(132.34);
  });

  it('v4 旧档仍能一路迁移到当前版本并补齐 v8 结构', () => {
    const world = currentWorld(1);
    const save = JSON.parse(serializeSave(world)) as unknown as RawSave & {
      world: { households?: unknown; management?: unknown; banking?: unknown };
    };
    save.formatVersion = 4;
    delete save.world.households;
    delete save.world.management;
    delete save.world.banking;
    delete save.world.taxes;
    delete save.world.securities.history;
    const result = parseSave(JSON.stringify(save));
    expect(result.ok, result.error).toBe(true);
    expect(result.migratedFrom).toBe(4);
    expect(result.save?.formatVersion).toBe(SAVE_FORMAT_VERSION);
    expect(result.world!.securities.history).toEqual([]);
    expect(result.world!.taxes.accrualByCity).toEqual({});
    expect(checkInvariants(result.world!)).toEqual([]);
  });
});
