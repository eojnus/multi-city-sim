// 验收测试公共工具：世界构造、旧档降级、金额口径与查看者身份。
// 只读 src/**，不改产品代码；本目录 tests/acceptance/** 属于验收员写作用域。
import { Simulation } from '../../src/simulation/core/simulation';
import { parseSave, serializeSave } from '../../src/simulation/core/save';
import type { WorldState, ViewerIdentity } from '../../src/simulation/contracts/types';
import { createInitialWorld } from '../../src/simulation/core/initializer';
import { DEMO_CONFIG } from '../../src/data/config';

export const PLAYER_ID = 'player';

/** 新建世界；months 期推进（每期都会跑完整月结）。 */
export function newWorld(months = 0): WorldState {
  if (months === 0) return createInitialWorld(DEMO_CONFIG);
  const sim = Simulation.create();
  for (let index = 0; index < months; index += 1) {
    const result = sim.tick();
    if (!result.ok) throw new Error(result.error);
  }
  return sim.state;
}

/** 查看者身份投影（只含权限字段）。 */
export function viewer(mayorCityId: string | null = null): ViewerIdentity {
  return { playerId: PLAYER_ID, mayorCityId };
}

export function cityById(world: WorldState, cityId: string) {
  const city = world.cities.find((entry) => entry.id === cityId);
  if (!city) throw new Error(`测试城市不存在：${cityId}`);
  return city;
}

/** 简化版“货币总量”：财政余额 + 企业现金 + 玩家现金。迁移不得凭空创造或销毁。 */
export function totalMoney(world: WorldState): number {
  const treasury = world.cities.reduce((sum, city) => sum + city.treasury, 0);
  const companyCash = world.companies.reduce((sum, company) => sum + company.cash, 0);
  return Math.round((treasury + companyCash + world.player.cash) * 100) / 100;
}

/** 当前存档 JSON（深拷贝对象，便于降级改造）。 */
export function saveObject(world: WorldState): Record<string, any> {
  return JSON.parse(serializeSave(world, '2026-11-01T00:00:00.000Z')) as Record<string, any>;
}

/**
 * 把当前 v7 存档降级成指定旧版本（与运行时迁移链互补：删除该版本之后新增的字段）。
 * 版本对应迁移链：v1 → v2/v3 → v4 → v5 → v6 → v7。
 * 说明：字段删除清单来自 src/simulation/core/save.ts 各迁移函数实际补写的字段，
 * 与 tests/legacy-save-files.test.ts 的降级思路一致，再补 v0.7 新增字段。
 */
export function downgrade(save: Record<string, any>, version: number): Record<string, any> {
  const clone = JSON.parse(JSON.stringify(save)) as Record<string, any>;
  const world = clone.world as Record<string, any>;

  // v7 新增：债券账本、居民消费金融、政府债务/破产/GDP 窗口、日志与通知可见性、贷款批次关联。
  if (version <= 6) {
    delete world.bonds;
    delete world.householdFinance;
    for (const city of world.cities) {
      delete city.government;
      delete city.gdpWindow;
      delete city.gdpEstimate;
      delete city.bankruptcy;
    }
    for (const entry of world.log ?? []) delete entry.visibility;
    for (const notice of world.notifications ?? []) delete notice.visibility;
    for (const loan of world.banking?.loans ?? []) delete loan.bondIssuanceId;
  }

  // v6 新增：市场账本生产计划需求 / 资金不足未满足。
  if (version <= 5) {
    for (const city of world.cities) {
      for (const entry of Object.values(city.market as Record<string, Record<string, unknown>>)) {
        delete entry.producerRequired;
        delete entry.unmetFunding;
      }
    }
  }

  // v5 新增：居民群体、经营者、银行。
  if (version <= 4) {
    delete world.households;
    delete world.management;
    delete world.banking;
  }

  // v4 新增：交通、政治、政策、财政账本、企业生命周期、AI 状态、劳动力/住房。
  if (version <= 3) {
    delete world.transport;
    delete world.politics;
    delete world.policies;
    delete world.fiscal;
    delete world.lifecycle;
    for (const company of world.companies) delete company.ai;
    for (const city of world.cities) {
      delete city.workforce;
      delete city.housing;
      delete city.lastMonth.policySpending;
      delete city.lastMonth.transportSpending;
      city.technology.status = 'initial-only';
      city.politics.status = 'initial-only';
    }
  }

  // v3 新增：表决资格快照。
  if (version <= 2) {
    for (const motion of world.governance?.motions ?? []) delete motion.eligible;
  }

  // v2 新增：证券、治理、投资实体、协议、通知、玩家角色、分红口径。
  if (version <= 1) {
    delete world.securities;
    delete world.governance;
    delete world.investors;
    delete world.agreements;
    delete world.notifications;
    delete world.player.roles;
    for (const city of world.cities) {
      delete city.lastMonth.investorDividends;
      delete city.lastMonth.investableContribution;
    }
    for (const company of world.companies) {
      delete company.previousMonth;
      delete company.dividendPayoutRatio;
      delete company.lastMonth.dividendIncome;
    }
  }
  return clone;
}

/** 构造旧版存档文本（formatVersion = version）。 */
export function legacySaveText(world: WorldState, version: number): string {
  const clone = downgrade(saveObject(world), version);
  clone.formatVersion = version;
  clone.gameVersion = `0.${Math.max(1, version)}.0`;
  return JSON.stringify(clone, null, 2);
}

/** 读取旧档后的便捷断言入口。 */
export function readLegacy(world: WorldState, version: number) {
  const text = legacySaveText(world, version);
  const result = parseSave(text);
  return { text, result };
}
