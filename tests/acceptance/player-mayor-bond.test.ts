// v0.7.1 复验问题 B：玩家担任现任市长时，AI 不得代替玩家自动发债。
//
// 验收口径：
// - 完整月结路径（Simulation.tick → settleGovernmentDebt）判定，而不是只直接调用单函数；
// - 每次月结按当前 world.player.roles.mayorCityId 判定：上任/离任/换届/重选/读档后立即生效；
// - 非玩家市长城市保留 AI 自动发债；玩家仍可主动发债，居民投资实体/企业仍可按规则认购；
// - 政府可向银行借款、债券到期银行无条件垫付、破产兑付勾销规则不变（本文件不触碰这些路径）。
import { describe, expect, it } from 'vitest';
import { DEMO_CONFIG, type DemoConfig } from '../../src/data/config';
import { Simulation } from '../../src/simulation/core/simulation';
import { createInitialWorld } from '../../src/simulation/core/initializer';
import { parseSave, serializeSave } from '../../src/simulation/core/save';
import type { WorldState } from '../../src/simulation/contracts/types';
import { bondsOf, issueGovernmentBond } from '../../src/simulation/government/bonds';
import { appointPlayerMayor } from '../../src/simulation/politics/politics';
import { cityById } from './helpers';

const PLAYER_CITY = 'lanport';
const AI_CITY = 'ironvale';

/**
 * 财政紧张口径（v0.8 回归修复）：
 * 旧 helper 只手工置 treasury=0 / baseline=1M，但同一次月结里 settleGovernment 会先按当月
 * 真实税收与支出重算 treasury，settleCityGovernmentDebt 又会用当月实际支出刷新
 * fiscalExpenseBaseline，于是 maybeAutoIssueGovernmentBond 看到的是"结算后"的财政，
 * 门槛（treasury < baseline × triggerBelowExpenseMonths）不再成立。
 *
 * 现在改为通过**完整月结路径**制造紧张：
 * - 月结前清空各城 treasury（模拟财政耗尽），让第一次结算仍从低位起算；
 * - 测试用代理 config 把 triggerBelowExpenseMonths 抬到 2、topUpToExpenseMonths 抬到 3，
 *   使"结算后 treasury < 2×当月支出基线"对正常月份也成立，且补足目标 3×基线保证 need>0。
 * 这样 AI 发债判定仍由 Simulation.tick() 的 settleGovernment → settleGovernmentDebt 真实触发，
 * 不直接调用 maybeAutoIssueGovernmentBond，也不改变产品默认参数。
 */
const TENSE_CONFIG = {
  ...DEMO_CONFIG,
  government: {
    ...DEMO_CONFIG.government,
    aiGovernment: {
      ...DEMO_CONFIG.government.aiGovernment,
      triggerBelowExpenseMonths: 2,
      topUpToExpenseMonths: 3,
    },
  },
} as unknown as DemoConfig;

/** 制造财政紧张：清空各城 treasury（月结会再按真实收支重算；门槛由 TENSE_CONFIG 保证）。 */
function makeFiscalTense(world: WorldState): void {
  for (const city of world.cities) {
    city.treasury = 0;
    city.fiscalExpenseBaseline = 1_000_000;
  }
}

/** 新建一个财政紧张的世界（初始 world + 代理 config），后续全部走完整 tick。 */
function createTenseSim(): Simulation {
  const sim = new Simulation(createInitialWorld(TENSE_CONFIG), TENSE_CONFIG);
  makeFiscalTense(sim.state);
  return sim;
}

function issuancesAt(world: WorldState, cityId: string, tick: number) {
  return bondsOf(world).issuances.filter(
    (issuance) => issuance.cityId === cityId && issuance.issuedTick === tick,
  );
}

describe('问题B：玩家市长城市禁止 AI 自动发债（完整月结路径）', () => {
  it('玩家任岚港市长：本城同月不出现 AI 发行计划，非玩家城市铁谷照常发债', () => {
    const sim = createTenseSim();
    expect(appointPlayerMayor(sim.state, PLAYER_CITY).ok).toBe(true);

    const result = sim.tick();
    expect(result.ok, result.ok ? '' : result.error).toBe(true);
    const tick = sim.state.time.tick;

    expect(sim.state.player.roles.mayorCityId).toBe(PLAYER_CITY);
    expect(issuancesAt(sim.state, PLAYER_CITY, tick)).toHaveLength(0);
    expect(issuancesAt(sim.state, AI_CITY, tick).length).toBeGreaterThan(0);
  });

  it('玩家离任后下一个完整月结立即恢复 AI 发债（不重启世界）', () => {
    const sim = createTenseSim();
    expect(appointPlayerMayor(sim.state, PLAYER_CITY).ok).toBe(true);
    expect(sim.tick().ok).toBe(true);
    const firstTick = sim.state.time.tick;
    expect(issuancesAt(sim.state, PLAYER_CITY, firstTick)).toHaveLength(0);

    // 离任：只改当前身份，不重建世界。
    sim.state.player.roles.mayorCityId = null;
    makeFiscalTense(sim.state);
    expect(sim.tick().ok).toBe(true);
    const secondTick = sim.state.time.tick;
    expect(issuancesAt(sim.state, PLAYER_CITY, secondTick).length).toBeGreaterThan(0);
  });

  it('玩家上任后立即停止本城 AI 发债：上任前已发一期，上任后同月不再新增', () => {
    const sim = createTenseSim();
    expect(sim.tick().ok).toBe(true);
    const beforeTick = sim.state.time.tick;
    expect(issuancesAt(sim.state, PLAYER_CITY, beforeTick).length).toBeGreaterThan(0);

    expect(appointPlayerMayor(sim.state, PLAYER_CITY).ok).toBe(true);
    makeFiscalTense(sim.state);
    expect(sim.tick().ok).toBe(true);
    const afterTick = sim.state.time.tick;
    expect(issuancesAt(sim.state, PLAYER_CITY, afterTick)).toHaveLength(0);
  });

  it('读档后立即按存档中的市长身份判定：岚港不再 AI 发债，铁谷照常', () => {
    const sim = createTenseSim();
    expect(appointPlayerMayor(sim.state, PLAYER_CITY).ok).toBe(true);
    expect(sim.tick().ok).toBe(true);

    const parsed = parseSave(serializeSave(sim.state));
    expect(parsed.ok, parsed.ok ? '' : parsed.error).toBe(true);
    const loaded = parsed.world!;
    expect(loaded.player.roles.mayorCityId).toBe(PLAYER_CITY);
    makeFiscalTense(loaded);

    const resumed = new Simulation(loaded, TENSE_CONFIG);
    expect(resumed.tick().ok).toBe(true);
    const tick = resumed.state.time.tick;
    expect(issuancesAt(resumed.state, PLAYER_CITY, tick)).toHaveLength(0);

    // 对照：同一份存档把市长身份清空后，同样条件下 AI 会发债——证明上面的 0 是身份判定生效。
    const controlParsed = parseSave(serializeSave(sim.state));
    const controlWorld = controlParsed.world!;
    controlWorld.player.roles.mayorCityId = null;
    makeFiscalTense(controlWorld);
    const controlSim = new Simulation(controlWorld, TENSE_CONFIG);
    expect(controlSim.tick().ok).toBe(true);
    expect(issuancesAt(controlSim.state, PLAYER_CITY, controlSim.state.time.tick).length).toBeGreaterThan(0);
  });

  it('玩家市长仍可主动发债，居民投资实体/企业仍按既有规则在窗口关闭时认购', () => {
    const sim = createTenseSim();
    expect(appointPlayerMayor(sim.state, PLAYER_CITY).ok).toBe(true);
    const tick = sim.state.time.tick;
    const city = cityById(sim.state, PLAYER_CITY);
    const issued = issueGovernmentBond(sim.state, city, TENSE_CONFIG, 20, tick);
    expect(issued.ok, issued.ok ? '' : issued.error).toBe(true);
    expect(issued.issuance!.status).toBe('offering');

    // 让居民投资实体有真实可用资金，窗口关闭时可按规则认购。
    for (const group of sim.state.investors) group.cash = 0;
    sim.state.investors[0]!.cash = 10_000;
    for (const company of sim.state.companies) company.cash = 0;

    expect(sim.tick().ok).toBe(true);
    const issuance = bondsOf(sim.state).issuances.find(
      (entry) => entry.id === issued.issuance!.id,
    )!;
    expect(issuance.closedTick).not.toBeNull();
    expect(issuance.soldUnits).toBeGreaterThan(0);
    expect(issuance.principal).toBeCloseTo(issuance.soldUnits * issuance.faceValue, 2);
    // 玩家没有主动发债以外的本城 AI 发行（本 tick 唯一一期就是玩家发起的这一期）。
    expect(
      bondsOf(sim.state).issuances.filter(
        (entry) => entry.cityId === PLAYER_CITY && entry.issuedTick === sim.state.time.tick,
      ),
    ).toHaveLength(0);
  });
});
