// v1.5 §1：非市长财政信息隔离回归（政府标签 / AI 经济体检 / 政策视图数据 / 日志）。
//
// 规则（SUPPLEMENT_ARCHITECT_v1 §7 / DECISIONS #9 / v1.5 验收问题 §1）：
// - 公开城市经济信息照常显示：GDP、人口、失业率、就业结构、一般市场信息、食品供需；
// - 市长专属财政口径（财政余额/负债/债务-GDP/85% 预警/到期计划/政策预算与参考税收）
//   仅对该城现任 `playerIsMayor` 显示；非市长渲染 fiscal-restricted 占位；
// - 非市长的 HTML（含属性/标题）、AI 体检公开文本、gameStore 视图数据里都不得出现受限数值，
//   不是靠 CSS 隐藏；
// - 权限按真实 politics 状态每次渲染现算（上任/离任/换届/读档后立即生效，不缓存）。
import { beforeAll, describe, expect, it } from 'vitest';
import { GameStore } from '../src/app/gameStore';
import { Simulation } from '../src/simulation/core/simulation';
import { DEMO_CONFIG } from '../src/data/config';
import { latestCheckup } from '../src/simulation/policies/ai-labor';
import { appointPlayerMayor, stepDownPlayerMayor } from '../src/simulation/politics/politics';
import { serializeSave } from '../src/simulation/core/save';
import { renderRightCity } from '../src/ui/panels';
import { renderRightPanel } from '../src/ui/right-panel';
import { money, num, pct } from '../src/ui/format';
import type { SaveBridge } from '../src/platform/saveBridge';

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

function appointMayor(store: GameStore, cityId = 'lanport'): void {
  const result = appointPlayerMayor(store.world, cityId);
  expect(result.ok, result.error).toBe(true);
}

function stepDownMayor(store: GameStore): void {
  const current = store.world.player.roles.mayorCityId;
  if (!current) return;
  const result = stepDownPlayerMayor(store.world, current);
  expect(result.ok, result.error).toBe(true);
}

function checkupOf(store: GameStore, cityId = 'lanport') {
  const checkup = latestCheckup(store.world, cityId);
  expect(checkup, '推进 1 月后应有经济体检快照').toBeTruthy();
  return checkup!;
}

/**
 * AI 体检里市长专属财政口径的“可识别取值”。
 * 断言非市长 HTML/属性/视图数据不包含它们（只排除过于通用的 0/0.0%/—，用标签与唯一金额覆盖）。
 */
function restrictedCheckupValues(checkup: ReturnType<typeof checkupOf>): string[] {
  return [
    money(checkup.budget),
    pct(checkup.budgetShare),
    `真实 ${num(checkup.taxMonthsReal)} 月 / 估算 ${num(checkup.taxMonthsEstimated)} 月`,
    money(checkup.monthlyTaxRevenueReal),
    money(checkup.monthlyTaxRevenueEstimated),
    pct(checkup.debtRatio),
    pct(checkup.debtServicePressure),
    money(checkup.bondDue),
    money(checkup.loanDue),
    money(checkup.treasury),
    checkup.budgetNote,
  ].filter((value) => !['0', '0.0%', '—', ''].includes(value));
}

/** 数字/百分比 token 匹配：要求前后不是数字，避免 “35.0%” 误命中 “5.0%”。 */
function containsToken(text: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\d.])${escaped}(?![\\d])`, 'u').test(text);
}

function expectHtmlWithout(html: string, values: readonly string[]): void {
  for (const value of values) {
    expect(containsToken(html, value), `非市长 HTML 不得包含受限数值：${value}`).toBe(false);
  }
}

let store: GameStore;

beforeAll(() => {
  store = createStore();
  store.selectCity('lanport');
  expect(store.tick()).toBe(true);
});

describe('v1.5 §1 非市长：AI 体检公开/受限拆分', () => {
  it('非市长看不到财政口径：标签、受限 testid、金额、预算说明都不进入 HTML', () => {
    stepDownMayor(store);
    const checkup = checkupOf(store);
    const html = renderRightCity(store, panelState);

    // 公开部分保留：档位/3 月均值/趋势/公开症状/就业招聘/食品供需。
    expect(html).toContain('data-testid="ai-government"');
    expect(html).toContain('data-testid="ai-checkup-public"');
    expect(html).toContain('data-testid="ai-checkup-tier"');
    expect(html).toContain('失业档位');
    expect(html).toContain(pct(checkup.unemploymentRateAvg3));
    expect(html).toContain('data-testid="ai-checkup-symptoms"');
    expect(html).toContain('就业 / 失业 / 劳动力');
    expect(html).toContain('上月招聘 / 裁员');
    expect(html).toContain('食品库存覆盖');
    expect(html).toContain('食品价格 / 未满足需求');

    // 受限部分：不得出现字段标签、testid 或任何取值。
    expect(html).toContain('data-testid="fiscal-restricted"');
    expect(html).toContain('data-restricted-scope="ai-checkup"');
    // 受限字段的明细标签（带 <i> 的数值格）与 testid 都不得出现；
    // 占位文案可以说明“财政口径仅市长可见”，但不得携带任何数值。
    for (const marker of [
      'data-testid="ai-checkup-restricted"',
      'data-testid="ai-checkup-budget"',
      'data-testid="ai-checkup-tax"',
      'data-testid="ai-checkup-debt"',
      'data-testid="ai-checkup-due"',
      'data-testid="ai-checkup-treasury"',
      'data-testid="ai-checkup-budget-note"',
      '<i>月政策预算</i>',
      '<i>税收参考月数</i>',
      '<i>债务 / GDP</i>',
      '<i>本月到期压力</i>',
      '<i>政府财政余额</i>',
      '占参考税收',
      '预警线 85%',
      '预算参考：',
    ]) {
      expect(html, `非市长 HTML 不得包含受限字段：${marker}`).not.toContain(marker);
    }
    expectHtmlWithout(html, restrictedCheckupValues(checkup));
    // AI 体检公开症状里也不得混入“债务/GDP 预警”这类财政口径症状。
    for (const symptom of checkup.symptoms) {
      if (/债务|预算|税收|财政/.test(symptom)) {
        expect(html, `公开症状不应包含财政口径条目：${symptom}`).not.toContain(symptom);
      }
    }
    // 非市长不得出现市长财政面板。
    expect(html).not.toContain('data-testid="mayor-fiscal-panel"');
    expect(html).not.toContain('data-testid="fiscal-debt-ratio"');
  });

  it('非市长视图数据（policyView）不含预算/支出/默认预算/历史等受限字段', () => {
    stepDownMayor(store);
    const checkup = checkupOf(store);
    const view = store.policyView('lanport');
    expect(view.isPlayerMayor).toBe(false);
    expect(view.active.length).toBeGreaterThan(0);
    for (const policy of view.active) {
      expect(policy.budget).toBeNull();
      expect(policy.spent).toBeNull();
      expect(policy.effects.paid).toBeUndefined();
      expect(policy.effects.invested).toBeUndefined();
      for (const run of policy.tracking?.runs ?? []) {
        expect(run.spent).toBeNull();
        expect(run.fiscalImpact).toBeNull();
        expect(run.theoreticalNeed ?? null).toBeNull();
        expect(run.paid ?? null).toBeNull();
        expect(run.unpaid ?? null).toBeNull();
      }
      // 财政金额型效果与备注金额也不进入非市长视图。
      for (const key of ['paid', 'invested', 'reservedWages', 'publicWagePaid', 'spentThisMonth', 'expectedClaim']) {
        expect(policy.effects[key]).toBeUndefined();
      }
      expect(policy.note).not.toMatch(/预留\s*\d/);
      expect(policy.note).not.toMatch(/预算\s*\d/);
    }
    for (const definition of view.definitions) {
      expect(definition.defaultBudget).toBeNull();
      // 可用性原因里的“预算低于最低额 80,000 / 财政资金不足”等财政口径也不返回。
      expect(definition.reason).not.toMatch(/财政|预算|债务|余额|税收/);
    }
    expect(view.history).toEqual([]);
    // 序列化后的视图数据也不包含任何受限金额。
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain(String(checkup.budget));
    expect(serialized).not.toContain(DEMO_CONFIG.policies.minBudget.toLocaleString('zh-CN'));
    expect(serialized).not.toContain(String(Math.max(...Object.values(DEMO_CONFIG.policies.budgets))));
    for (const value of restrictedCheckupValues(checkup)) {
      if (value.length >= 4) {
        expect(containsToken(serialized, value), `视图数据不得包含受限数值：${value}`).toBe(false);
      }
    }
  });

  it('实际 UI 路径（右侧栏「政府」标签）同样隔离：tab 渲染不出现受限字段', () => {
    stepDownMayor(store);
    store.selectCity('lanport');
    const checkup = checkupOf(store);
    const html = renderRightPanel(store, {
      tab: 'government',
      focusCompanyId: null,
      showAllGoods: false,
      previousContextKey: 'city:lanport',
    });
    expect(html).toContain('data-testid="government-section"');
    expect(html).toContain('data-testid="ai-checkup-public"');
    expect(html).toContain('data-restricted-scope="ai-checkup"');
    expect(html).not.toContain('data-testid="ai-checkup-restricted"');
    expect(html).not.toContain('data-testid="ai-checkup-debt"');
    expectHtmlWithout(html, restrictedCheckupValues(checkup));
  });

  it('非市长其他财政视图为 null，政策命令被拒且提示不含金额', () => {
    stepDownMayor(store);
    store.selectCity('lanport');
    expect(store.fiscalView('lanport')).toBeNull();
    expect(store.taxView('lanport')).toBeNull();

    const ok = store.selectPolicy('hiringSubsidy', { budget: 700_000 });
    expect(ok).toBe(false);
    const message = store.toasts.at(-1)?.message ?? '';
    expect(message).toContain('只有该城市市长');
    expect(message).not.toMatch(/\d{3,}/);
    const stopOk = store.stopPolicy('hiringSubsidy');
    expect(stopOk).toBe(false);
  });

  it('非市长仍在行政策与执行追踪可见：原因/受益/真实岗位公开，支出金额隐藏', () => {
    stepDownMayor(store);
    const html = renderRightCity(store, panelState);
    const policy = store.world.policies.active.find((entry) => entry.cityId === 'lanport')!;
    expect(policy).toBeTruthy();
    const latestRun = policy.tracking?.runs.at(-1)!;
    expect(latestRun).toBeTruthy();

    expect(html).toContain(`data-testid="policy-reason-${policy.policyId}"`);
    expect(html).toContain('启动原因：');
    expect(html).toContain(`data-testid="policy-run-${policy.policyId}"`);
    expect(html).toContain(`受益 <b>${num(latestRun.beneficiaries)}</b>`);
    expect(html).toContain('真实岗位');
    expect(html).toContain('支出 <b>—</b>');
    expect(html).toContain('仅市长可见');
    // 不出现执行支出金额与资金来源（财政口径）。
    if (latestRun.spent > 0.005) {
      expect(html).not.toContain(`支出 <b>${money(latestRun.spent)}</b>`);
    }
    expect(html).not.toContain(`来源：${latestRun.fundingSource}`);
    expect(html).toContain('政策预算额度与城市财政流水仅该城市市长可见');
  });

  it('公开城市经济信息不受影响：GDP/人口/失业/就业结构/市场仍显示', () => {
    stepDownMayor(store);
    store.selectCity('lanport');
    const html = renderRightCity(store, panelState);
    expect(html).toContain('人口 POP');
    expect(html).toContain('就业 E');
    expect(html).toContain('失业 U');
    expect(html).toContain('GDP 本月');
    expect(html).toContain('data-testid="population-strata-section"');
    expect(html).toContain('data-testid="talent-market-section"');
    expect(html).toContain('data-testid="bond-market-section"');
    expect(html).toContain('data-testid="ai-checkup-public"');
  });
});

describe('v1.5 §1 现任市长：财政口径完整可见', () => {
  it('市长 AI 体检显示预算/税月/债务比/到期压力/财政余额与预算说明，且无受限占位', () => {
    appointMayor(store);
    const checkup = checkupOf(store);
    const html = renderRightCity(store, panelState);

    expect(html).toContain('data-testid="ai-mayor-status"');
    expect(html).toContain('AI 不代选政策');
    expect(html).toContain('data-testid="ai-government"');
    expect(html).toContain('data-testid="ai-checkup-restricted"');
    expect(html).toContain('data-testid="ai-checkup-budget"');
    expect(html).toContain('data-testid="ai-checkup-tax"');
    expect(html).toContain('data-testid="ai-checkup-debt"');
    expect(html).toContain('data-testid="ai-checkup-due"');
    expect(html).toContain('data-testid="ai-checkup-treasury"');
    expect(html).toContain('data-testid="ai-checkup-budget-note"');
    expect(html).toContain('月政策预算');
    expect(html).toContain(money(checkup.budget));
    expect(html).toContain(pct(checkup.budgetShare));
    expect(html).toContain(
      `真实 ${num(checkup.taxMonthsReal)} 月 / 估算 ${num(checkup.taxMonthsEstimated)} 月`,
    );
    expect(html).toContain(money(checkup.monthlyTaxRevenueReal));
    expect(html).toContain(money(checkup.monthlyTaxRevenueEstimated));
    expect(html).toContain(pct(checkup.debtRatio));
    expect(html).toContain('85%');
    expect(html).toContain(pct(checkup.debtServicePressure));
    expect(html).toContain(money(checkup.bondDue));
    expect(html).toContain(money(checkup.loanDue));
    expect(html).toContain(money(checkup.treasury));
    expect(html).toContain('预算参考');
    // 市长视角不应再出现“财政受限占位”，但保留财政流水与政策操作入口。
    expect(html).not.toContain('data-testid="fiscal-restricted"');
    expect(html).toContain('data-testid="fiscal-ledger"');
    expect(html).toContain('data-testid="fiscal-debt-ratio"');
    expect(html).toContain('data-action="stop-policy"');
  });

  it('市长视图数据包含真实预算/支出/默认预算（供 UI 渲染）', () => {
    appointMayor(store);
    const view = store.policyView('lanport');
    expect(view.isPlayerMayor).toBe(true);
    const rawPolicy = store.world.policies.active.find((entry) => entry.cityId === 'lanport')!;
    const policy = view.active.find((entry) => entry.id === rawPolicy.id)!;
    expect(policy.budget).toBe(rawPolicy.budget);
    expect(policy.spent).toBe(rawPolicy.spent);
    const hireDefault = view.definitions.find((definition) => definition.id === 'hiringSubsidy')!;
    expect(hireDefault.defaultBudget).toBe(DEMO_CONFIG.policies.budgets.hiringSubsidy);
    for (const definition of view.definitions) expect(definition.defaultBudget).not.toBeNull();
  });
});

describe('v1.5 §1 其他城市市长：权限按城市隔离', () => {
  it('岚港市长看铁谷仍按普通玩家：铁谷受限隐藏，岚港仍可见', () => {
    appointMayor(store, 'lanport');
    store.selectCity('ironvale');
    const ironvaleHtml = renderRightCity(store, panelState);
    expect(ironvaleHtml).toContain('data-testid="ai-government"');
    expect(ironvaleHtml).toContain('data-restricted-scope="ai-checkup"');
    expect(ironvaleHtml).not.toContain('data-testid="ai-checkup-restricted"');
    expect(ironvaleHtml).not.toContain('data-testid="ai-checkup-debt"');
    const ironvaleView = store.policyView('ironvale');
    expect(ironvaleView.isPlayerMayor).toBe(false);
    for (const policy of ironvaleView.active) expect(policy.budget).toBeNull();
    for (const definition of ironvaleView.definitions) expect(definition.defaultBudget).toBeNull();

    // 同一 store、同一时刻：岚港（我是市长）仍有财政口径。
    const lanportView = store.policyView('lanport');
    expect(lanportView.isPlayerMayor).toBe(true);
    expect(lanportView.active.some((policy) => typeof policy.budget === 'number')).toBe(true);
    store.selectCity('lanport');
    const lanportHtml = renderRightCity(store, panelState);
    expect(lanportHtml).toContain('data-testid="ai-checkup-restricted"');
    expect(lanportHtml).not.toContain('data-testid="fiscal-restricted"');
  });
});

describe('v1.5 §1 权限切换：上任/离任/读档立即生效（不缓存）', () => {
  it('同一 store 非市长→上任→离任，渲染与视图立即切换', () => {
    stepDownMayor(store);
    store.selectCity('lanport');
    const before = renderRightCity(store, panelState);
    expect(before).not.toContain('data-testid="ai-checkup-restricted"');
    expect(store.policyView('lanport').active.every((policy) => policy.budget === null)).toBe(true);

    appointMayor(store, 'lanport');
    const asMayor = renderRightCity(store, panelState);
    expect(asMayor).toContain('data-testid="ai-checkup-restricted"');
    expect(store.policyView('lanport').active.some((policy) => policy.budget !== null)).toBe(true);

    stepDownMayor(store);
    const after = renderRightCity(store, panelState);
    expect(after).not.toContain('data-testid="ai-checkup-restricted"');
    expect(after).toContain('data-restricted-scope="ai-checkup"');
    expect(store.policyView('lanport').active.every((policy) => policy.budget === null)).toBe(true);
  });

  it('换届/破产重选清空市长身份后立即隐藏（读取真实 politics 状态，不缓存）', () => {
    appointMayor(store, 'lanport');
    store.selectCity('lanport');
    expect(renderRightCity(store, panelState)).toContain('data-testid="ai-checkup-restricted"');

    // 换届/破产重选最终都写入同一个角色字段并清空玩家市长身份；渲染不得沿用旧缓存。
    store.world.player.roles.mayorCityId = null;
    const html = renderRightCity(store, panelState);
    expect(html).not.toContain('data-testid="ai-checkup-restricted"');
    expect(html).toContain('data-restricted-scope="ai-checkup"');
    expect(store.policyView('lanport').isPlayerMayor).toBe(false);
    expect(store.policyView('lanport').active.every((policy) => policy.budget === null)).toBe(true);
  });

  it('读档：市长存档载入后受限可见，离任后立即隐藏；非市长存档载入后受限隐藏', () => {
    // 1) 市长存档往返：身份随存档恢复。
    appointMayor(store, 'lanport');
    const mayorSave = serializeSave(store.world);
    const loadedMayor = createStore();
    expect(loadedMayor.loadFromText(mayorSave, '测试存档')).toBe(true);
    loadedMayor.selectCity('lanport');
    const mayorHtml = renderRightCity(loadedMayor, panelState);
    expect(mayorHtml).toContain('data-testid="ai-checkup-restricted"');
    expect(loadedMayor.policyView('lanport').isPlayerMayor).toBe(true);

    // 2) 载入后离任：不重启、不重新读档，下一页立即隐藏。
    stepDownMayor(loadedMayor);
    const afterStepDown = renderRightCity(loadedMayor, panelState);
    expect(afterStepDown).not.toContain('data-testid="ai-checkup-restricted"');
    expect(afterStepDown).toContain('data-restricted-scope="ai-checkup"');
    expect(loadedMayor.policyView('lanport').isPlayerMayor).toBe(false);

    // 3) 非市长存档载入后直接受限隐藏。
    const nonMayorSave = serializeSave(loadedMayor.world);
    const loadedCitizen = createStore();
    expect(loadedCitizen.loadFromText(nonMayorSave, '测试存档')).toBe(true);
    loadedCitizen.selectCity('lanport');
    const citizenHtml = renderRightCity(loadedCitizen, panelState);
    expect(citizenHtml).not.toContain('data-testid="ai-checkup-restricted"');
    expect(citizenHtml).toContain('data-restricted-scope="ai-checkup"');
    expect(loadedCitizen.policyView('lanport').isPlayerMayor).toBe(false);
  });
});

describe('v1.5 §1 其他入口审计：日志/通知/其他视图不泄露财政金额', () => {
  it('非市长 visibleLog 不含城市政策预算/支出/财政余额金额', () => {
    stepDownMayor(store);
    const logs = store.visibleLog().filter(
      (entry) => /预算|支出|财政支持|财政余额|财政流水|债务\/GDP/.test(entry.message) && /\d/.test(entry.message),
    );
    expect(logs.map((entry) => entry.message)).toEqual([]);
  });

  it('非市长通知列表不含城市财政通知（城市通知仅市长生成）', () => {
    stepDownMayor(store);
    const cityNotices = store.notifications.filter((notice) => notice.audience === 'city');
    expect(cityNotices).toEqual([]);
  });

  it('债券市场等公开面板只含公开字段，不含总债务/债务率', () => {
    stepDownMayor(store);
    store.selectCity('lanport');
    const html = renderRightCity(store, panelState);
    expect(html).toContain('data-testid="bond-market-section"');
    expect(html).not.toContain('data-testid="fiscal-total-debt"');
    expect(html).not.toContain('data-testid="fiscal-risk-badge"');
    expect(html).not.toContain('data-testid="mayor-fiscal-panel"');
  });
});
