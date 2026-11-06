// v1.5 §6 横切验证：权限矩阵 / 债券无流动性迁移 / 报告口径 / AI 政策资金三口径 /
// 初始设备入口 / 旧档可选字段。与各 owner 的单模块测试互补，这里全部走“集成路径”：
// - 权限：真实 GameStore 视图 + 右侧栏 HTML + 日志 visibility + 读档，覆盖非市长/现任市长/
//   其他城市市长/上任/离任/换届/读档；
// - 迁移：走人口迁移真实调用的 transferHouseholdDebtsForMigration（内部转投资权益），
//   债券无流动性场景三方价值守恒 + 付息/到期 + 存档往返；
// - 报告：真实 8 月默认种子的数据层恒等式 + 真实报告脚本 `--months=5` 输出（明细 vs 汇总
//   覆盖率一致、本地+进口只计一次、AI 政策资金三口径入报告）；
// - AI 资金：真实 8 月默认种子的参考预算/预留/实支/未支付/借款到账，至少一城实付>0 且受益>0；
// - 初始设备：正常 tick/AI 自动创办入口全部带实物出资，只计一次；
// - 旧档：v0.9 真实 fixture 无 fundingMonths（可选）→ 推进 → 存档 → 再读幂等，删除可选字段仍可读。
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { GameStore } from '../src/app/gameStore';
import { Simulation } from '../src/simulation/core/simulation';
import { DEMO_CONFIG } from '../src/data/config';
import type {
  BondHolder,
  City,
  HouseholdGroup,
  InvestorGroup,
  OccupationClass,
  WorldState,
} from '../src/simulation/contracts/types';
import { checkInvariants } from '../src/simulation/core/invariants';
import { round2 } from '../src/simulation/core/math';
import { parseSave, serializeLegacySave, serializeSave } from '../src/simulation/core/save';
import { appointPlayerMayor, stepDownPlayerMayor } from '../src/simulation/politics/politics';
import { latestCheckup } from '../src/simulation/policies/ai-labor';
import { policyFundingMonthlyReport } from '../src/simulation/policies/policies';
import { renderRightCity } from '../src/ui/panels';
import { money, num, pct } from '../src/ui/format';
import { INITIAL_EQUIPMENT_LOCK_MONTHS, INITIAL_EQUIPMENT_UNITS } from '../src/simulation/companies/founding';
import {
  cityInvestorEquity,
  householdGroupsOfCity,
  rebalanceHouseholdWealthForMigration,
} from '../src/simulation/population/household-groups';
import { transferHouseholdDebtsForMigration } from '../src/simulation/population/household-finance';
import {
  effectiveInvestorShares,
  investorBondValue,
} from '../src/simulation/population/household-investment';
import { ensureInvestorOpeningShares } from '../src/simulation/investors/investors';
import {
  accrueBondInterest,
  closeGovernmentBondSubscription,
  issueGovernmentBond,
  payBondCoupon,
  settleBondMaturity,
  subscribeGovernmentBond,
} from '../src/simulation/government/bonds';
import type { SaveBridge } from '../src/platform/saveBridge';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const FIXTURE_PATH = path.join(REPO_ROOT, 'tests', 'fixtures', 'v0.9-real-f942cc9.json');
const SAVE_AT = '2026-11-06T00:00:00.000Z';
const PANEL_STATE = { showAllGoods: false, logCollapsed: false } as never;
const CITY_NAMES: Record<string, string> = { lanport: '岚港', ironvale: '铁谷', greenfield: '青原' };

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

/** 解析报告脚本里的 zh-CN 数字（含千分位/小数）。 */
function numFrom(text: string): number {
  return Number(text.replace(/,/g, ''));
}

function createBridge(): SaveBridge {
  return {
    list: async () => ({ ok: true, slots: [] }),
    read: async (slot: string) => ({ ok: false, slot, error: '存档不存在', code: 'not-found' }),
    write: async (slot: string) => ({ ok: true, slot, savedAt: new Date().toISOString() }),
    remove: async () => ({ ok: true }),
    onMenuAction: () => () => undefined,
  } as unknown as SaveBridge;
}

/** 8 月默认种子世界（真实 tick，含 v1.5 政策借款/支出与跨城贸易）。 */
let world: WorldState;
let worldSaveText: string;

beforeAll(() => {
  const simulation = Simulation.create();
  for (let month = 0; month < 8; month += 1) {
    const result = simulation.tick();
    if (!result.ok) throw new Error(`第 ${month + 1} 月 tick 失败：${result.error}`);
  }
  world = simulation.state;
  worldSaveText = serializeSave(world, SAVE_AT);
}, 300_000);

/** 从存档文本重建一个独立 store（避免测试之间互相污染，也验证读档后权限口径）。 */
function storeFromSave(text = worldSaveText): GameStore {
  const parsed = parseSave(text);
  if (!parsed.ok || !parsed.world) throw new Error(parsed.error);
  return new GameStore(new Simulation(parsed.world, DEMO_CONFIG), createBridge());
}

/** 某城某月 AI 危机政策“公共岗位归属工资”（fiscal publicWages 实付，不在 policySpending 流水）。 */
function publicWageAttribution(world: WorldState, cityId: string, tick: number): number {
  return round2(
    [...world.policies.active, ...world.policies.history]
      .filter(
        (policy) =>
          policy.cityId === cityId &&
          (policy.effects.aiCrisisPolicy === 1 || policy.reason.startsWith('AI 高失业决策')) &&
          policy.effects.reservedTick === tick,
      )
      .reduce((total, policy) => total + (policy.effects.publicWagePaidThisMonth ?? 0), 0),
  );
}

/** 存档里的检查点（AI 体检）里的受限财政取值，用于断言非市长 HTML/视图不出现。 */
function restrictedCheckupValues(checkup: NonNullable<ReturnType<typeof latestCheckup>>): string[] {
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

/** 数字 token 匹配：前后不能是数字/小数点，避免 “35.0%” 命中 “5.0%”。 */
function containsToken(text: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\d.])${escaped}(?![\\d])`, 'u').test(text);
}

function expectHtmlWithout(html: string, values: readonly string[]): void {
  for (const value of values) {
    expect(containsToken(html, value), `非市长 HTML 不得包含受限数值：${value}`).toBe(false);
  }
}

/**
 * v1.6：财政口径泄露检查只扫“政府与政策”区块。
 * 公司列表等公开面板会显示企业现金/利润，金额与受限财政数值偶然相同（v1.6 实测
 * 铁谷工业设备工坊现金 185.9 万与某受限值相同），扫整页 HTML 会误报。
 */
function governmentSectionHtml(html: string): string {
  const start = html.indexOf('data-testid="government-section"');
  if (start < 0) return html;
  const end = html.indexOf('</section>', start);
  return end < 0 ? html.slice(start) : html.slice(start, end);
}

// ---------------------------------------------------------------- §1 权限矩阵

describe('v1.5 §1 权限矩阵（store 视图 + HTML + 日志 visibility，集成）', () => {
  it('非市长：三城 HTML/视图/通知/日志均不泄露受限财政数值', () => {
    const store = storeFromSave();
    store.world.player.roles.mayorCityId = null;
    const checkups = world.cities.map((city) => latestCheckup(store.world, city.id));
    const restricted = checkups.flatMap((checkup) =>
      checkup ? restrictedCheckupValues(checkup) : [],
    );
    const traces = store.world.policies.fundingMonths ?? [];
    expect(traces.length).toBeGreaterThan(0);
    const traceAmounts = traces
      .flatMap((trace) => [
        money(trace.referenceBudget),
        money(trace.reserved),
        money(trace.spent),
        money(trace.borrowingProceeds),
      ])
      .filter((value) => !['0', '—', ''].includes(value));

    for (const city of store.world.cities) {
      store.selectCity(city.id);
      const html = renderRightCity(store, PANEL_STATE);
      expect(html, city.id).toContain('data-testid="ai-government"');
      expect(html, city.id).toContain('data-restricted-scope="ai-checkup"');
      expect(html, city.id).not.toContain('data-testid="ai-checkup-restricted"');
      expect(html, city.id).not.toContain('data-testid="mayor-fiscal-panel"');
      expect(html, city.id).not.toContain('data-testid="fiscal-debt-ratio"');
      // 财政明细标签/预算说明不进入非市长 HTML，且体检里的受限金额不出现。
      for (const marker of [
        'data-testid="ai-checkup-budget"',
        'data-testid="ai-checkup-debt"',
        '本月参考',
        '预留 <b>',
        '未支付 <b>',
        '政策资金顺序',
      ]) {
        expect(html, `${city.id} 不得包含 ${marker}`).not.toContain(marker);
      }
      // 只校验足够长的“可识别取值”，避免公共面板里同值的短百分比（如税率 15.0%）误判；
      // 短 token 的泄露风险由 policyView 结构化断言（budget/spent 均为 null）兜底。
      expectHtmlWithout(governmentSectionHtml(html), [...restricted, ...traceAmounts].filter((value) => value.length >= 6));

      const view = store.policyView(city.id);
      expect(view.isPlayerMayor).toBe(false);
      expect(view.history).toEqual([]);
      expect(view.active.length).toBeGreaterThan(0);
      for (const policy of view.active) {
        expect(policy.budget).toBeNull();
        expect(policy.spent).toBeNull();
        expect(policy.referenceBudget).toBeNull();
        expect(policy.reservedThisMonth).toBeNull();
        expect(policy.unpaidThisMonth).toBeNull();
        expect(policy.fundingSourceThisMonth).toBeNull();
        for (const run of policy.tracking?.runs ?? []) {
          expect(run.spent).toBeNull();
          expect(run.fiscalImpact).toBeNull();
          expect(run.paid ?? null).toBeNull();
          expect(run.unpaid ?? null).toBeNull();
        }
        for (const key of ['paid', 'invested', 'reservedWages', 'publicWagePaid', 'spentThisMonth']) {
          expect(policy.effects[key]).toBeUndefined();
        }
      }
      for (const definition of view.definitions) {
        expect(definition.defaultBudget).toBeNull();
        expect(definition.reason).not.toMatch(/财政|预算|税收|债务|余额/);
      }
      const serialized = JSON.stringify(view);
      for (const amount of traceAmounts.filter((value) => value.length >= 4)) {
        expect(containsToken(serialized, amount), `视图数据不得包含 ${amount}`).toBe(false);
      }
    }

    // 通知：非市长看不到任何城市级（市长）通知。
    expect(store.notifications.filter((notice) => notice.audience === 'city')).toEqual([]);
    // 日志：所有 scope='mayor' 的日志（含 v1.5 政策资金顺序/执行）都不可见。
    const mayorLogs = (store.world.log ?? []).filter((entry) => entry.visibility?.scope === 'mayor');
    expect(mayorLogs.length).toBeGreaterThan(0);
    const visibleMessages = new Set(store.visibleLog().map((entry) => entry.message));
    for (const log of mayorLogs) {
      expect(visibleMessages.has(log.message), `非市长可见日志泄露：${log.message}`).toBe(false);
    }
    expect(
      store
        .visibleLog()
        .filter(
          (entry) =>
            /政策资金顺序|政策执行：预留|财政余额|债务\/GDP|预算参考/.test(entry.message) &&
            /\d/.test(entry.message),
        ),
    ).toEqual([]);
  });

  it('现任市长：本城三口径/财政明细可见；他城仍受限；日志按城市隔离', () => {
    const store = storeFromSave();
    const appointed = appointPlayerMayor(store.world, 'lanport');
    expect(appointed.ok, appointed.ok ? '' : appointed.error).toBe(true);
    store.selectCity('lanport');

    const checkup = latestCheckup(store.world, 'lanport')!;
    const html = renderRightCity(store, PANEL_STATE);
    expect(html).toContain('data-testid="ai-checkup-restricted"');
    expect(html).toContain('data-testid="mayor-fiscal-panel"');
    expect(html).toContain('data-testid="ai-checkup-budget"');
    expect(html).toContain(money(checkup.budget));
    expect(html).toContain('本月参考');
    expect(html).toContain('预留 <b>');
    expect(html).not.toContain('data-testid="fiscal-restricted"');

    // 本城政策视图：三口径区分（参考预算 / 预留 / 未支付 / 来源），且与真实执行记录一致。
    const view = store.policyView('lanport');
    expect(view.isPlayerMayor).toBe(true);
    expect(view.history.length).toBeGreaterThan(0);
    const crisisPolicies = view.active.filter(
      (policy) => policy.referenceBudget !== null && policy.referenceBudget > 0,
    );
    expect(crisisPolicies.length).toBeGreaterThan(0);
    for (const policy of crisisPolicies) {
      expect(policy.budget).not.toBeNull();
      expect(policy.spent).not.toBeNull();
      expect(policy.spent!).toBeGreaterThanOrEqual(0);
      // reservedThisMonth 是“本月预留”，spent 是“政策累计支出”，二者不能按同一口径比较；
      // 单月三口径约束：0 ≤ 本月预留 ≤ 本月参考预算。
      expect(policy.reservedThisMonth!).toBeGreaterThanOrEqual(0);
      expect(policy.reservedThisMonth!).toBeLessThanOrEqual((policy.referenceBudget ?? 0) + 0.01);
      expect(policy.unpaidThisMonth!).toBeGreaterThanOrEqual(0);
      expect(['treasury', 'bankLoan', 'none']).toContain(policy.fundingSourceThisMonth);
      expect(policy.referenceBudget).toBeGreaterThan(0);
    }
    // 本城 mayor 日志可见，他城 mayor 日志不可见。
    const visibleMessages = new Set(store.visibleLog().map((entry) => entry.message));
    const lanportMayorLogs = (store.world.log ?? []).filter(
      (entry) => entry.visibility?.scope === 'mayor' && entry.visibility.cityId === 'lanport',
    );
    const ironvaleMayorLogs = (store.world.log ?? []).filter(
      (entry) => entry.visibility?.scope === 'mayor' && entry.visibility.cityId === 'ironvale',
    );
    expect(lanportMayorLogs.length).toBeGreaterThan(0);
    for (const log of lanportMayorLogs) expect(visibleMessages.has(log.message)).toBe(true);
    for (const log of ironvaleMayorLogs) expect(visibleMessages.has(log.message)).toBe(false);

    // 切换到铁谷：同一个 store 立即按“非市长”渲染（权限每次现算）。
    store.selectCity('ironvale');
    const ironvaleHtml = renderRightCity(store, PANEL_STATE);
    expect(ironvaleHtml).not.toContain('data-testid="ai-checkup-restricted"');
    expect(ironvaleHtml).toContain('data-restricted-scope="ai-checkup"');
    expect(store.policyView('ironvale').isPlayerMayor).toBe(false);
    for (const policy of store.policyView('ironvale').active) expect(policy.budget).toBeNull();
  });

  it('上任/离任/换届/读档：权限立即生效且不缓存', () => {
    const store = storeFromSave();
    store.world.player.roles.mayorCityId = null;
    store.selectCity('lanport');
    expect(renderRightCity(store, PANEL_STATE)).not.toContain('data-testid="ai-checkup-restricted"');

    // 上任 → 可见。
    expect(appointPlayerMayor(store.world, 'lanport').ok).toBe(true);
    expect(renderRightCity(store, PANEL_STATE)).toContain('data-testid="ai-checkup-restricted"');
    expect(store.policyView('lanport').isPlayerMayor).toBe(true);

    // 离任 → 立即隐藏。
    expect(stepDownPlayerMayor(store.world, 'lanport').ok).toBe(true);
    const afterStepDown = renderRightCity(store, PANEL_STATE);
    expect(afterStepDown).not.toContain('data-testid="ai-checkup-restricted"');
    expect(afterStepDown).toContain('data-restricted-scope="ai-checkup"');
    expect(store.policyView('lanport').isPlayerMayor).toBe(false);

    // 换届/破产重选：角色字段被清空后渲染立即隐藏（不沿用旧缓存）。
    expect(appointPlayerMayor(store.world, 'lanport').ok).toBe(true);
    store.world.player.roles.mayorCityId = null;
    expect(renderRightCity(store, PANEL_STATE)).not.toContain('data-testid="ai-checkup-restricted"');

    // 读档：市长存档恢复可见；离任后立即隐藏；非市长存档直接隐藏。
    expect(appointPlayerMayor(store.world, 'lanport').ok).toBe(true);
    const mayorSave = serializeSave(store.world, SAVE_AT);
    const mayorStore = storeFromSave(mayorSave);
    mayorStore.selectCity('lanport');
    expect(renderRightCity(mayorStore, PANEL_STATE)).toContain('data-testid="ai-checkup-restricted"');
    expect(mayorStore.policyView('lanport').isPlayerMayor).toBe(true);
    expect(stepDownPlayerMayor(mayorStore.world, 'lanport').ok).toBe(true);
    expect(renderRightCity(mayorStore, PANEL_STATE)).not.toContain('data-testid="ai-checkup-restricted"');
    const citizenStore = storeFromSave(serializeSave(mayorStore.world, SAVE_AT));
    citizenStore.selectCity('lanport');
    expect(renderRightCity(citizenStore, PANEL_STATE)).not.toContain('data-testid="ai-checkup-restricted"');
    expect(citizenStore.policyView('lanport').isPlayerMayor).toBe(false);
  });
});

// ---------------------------------------------------------------- §4 AI 政策资金三口径

describe('v1.5 §4 AI 政策资金三口径（真实 8 月默认种子）', () => {
  it('参考预算/预留/实支/未支付/借款到账字段区分，实支≤预留且来自真实财政流水', () => {
    const months = world.policies.fundingMonths ?? [];
    expect(months.length).toBeGreaterThan(0);
    const retention = DEMO_CONFIG.policies.aiLabor.policyFunding.retentionMonths;
    for (const city of world.cities) {
      const traces = months
        .filter((trace) => trace.cityId === city.id)
        .sort((left, right) => left.tick - right.tick);
      expect(traces.length, city.id).toBeGreaterThan(0);
      expect(traces.length).toBeLessThanOrEqual(retention);
      // 政策资金流程从 AI 首次执行高失业政策当月起记录（默认种子 t3 起）。
      expect(traces[0]!.tick).toBeGreaterThanOrEqual(1);
      for (const trace of traces) {
        expect(trace.referenceBudget).toBeGreaterThanOrEqual(0);
        expect(trace.reserved).toBeGreaterThanOrEqual(0);
        expect(trace.spent).toBeGreaterThanOrEqual(0);
        expect(trace.unpaid).toBeGreaterThanOrEqual(0);
        expect(trace.spent).toBeLessThanOrEqual(trace.reserved + 0.01);
        expect(trace.borrowingProceeds).toBeGreaterThanOrEqual(0);
        expect(trace.debtRatioAfterBorrowing).toBeLessThan(
          DEMO_CONFIG.government.fiscalRisk.bankruptAt,
        );
        expect(['treasury', 'bankLoan', 'none']).toContain(trace.fundingSource);
        // 三口径在记录里分开保存，不是同一个字段复用。
        expect(Object.keys(trace)).toEqual(
          expect.arrayContaining([
            'referenceBudget',
            'reserved',
            'spent',
            'unpaid',
            'borrowingProceeds',
            'fundingSource',
          ]),
        );
      }
      // 实支来源可对账：trace.spent = policySpending 现金 + 公共岗位归属工资（fiscal publicWages）。
      // v1.5 §4 起公共岗位纳入政策资助，其工资由财政公共工资科目实付、不在 policySpending 流水，
      // 因此逐月核对“现金部分 = 该月政策支出流水”，而不是把整笔实支都算作 policySpending。
      for (const trace of traces) {
        const publicWage = publicWageAttribution(world, city.id, trace.tick);
        const cashSpent = round2(trace.spent - publicWage);
        expect(publicWage, city.id).toBeGreaterThanOrEqual(-0.01);
        expect(cashSpent, city.id).toBeGreaterThanOrEqual(-0.01);
        expect(trace.spent).toBeCloseTo(round2(cashSpent + publicWage), 2);
        const ledgerSpentForTick = round2(
          world.fiscal.ledger
            .filter(
              (entry) =>
                entry.cityId === city.id &&
                entry.kind === 'policySpending' &&
                entry.tick === trace.tick,
            )
            .reduce((total, entry) => total + Math.abs(entry.amount), 0),
        );
        // 现金实支来自真实财政流水（同 tick policySpending 是所有政策合计，故为包含关系）。
        if (ledgerSpentForTick > 0) {
          expect(cashSpent).toBeLessThanOrEqual(ledgerSpentForTick + 0.01);
        }
      }
      // 实支 ≤ 预留（不超支）在所有月份成立。
      for (const trace of traces) expect(trace.spent).toBeLessThanOrEqual(trace.reserved + 0.01);
    }
    // 至少一次真实银行借款到账（不是从无到有凭空产生资金）。
    expect(months.some((trace) => trace.borrowingProceeds > 0)).toBe(true);
    expect(months.some((trace) => trace.fundingSource === 'bankLoan')).toBe(true);

    // 至少一城真实实付 > 0 且受益人数 > 0（AI 高失业政策执行记录）。
    const spentCities: string[] = [];
    const beneficiaryCities: string[] = [];
    for (const city of world.cities) {
      const spent = round2(
        sum(
          (world.policies.fundingMonths ?? [])
            .filter((trace) => trace.cityId === city.id)
            .map((trace) => trace.spent),
        ),
      );
      if (spent > 0) spentCities.push(city.id);
      const beneficiaries = sum(
        [...world.policies.active, ...world.policies.history]
          .filter(
            (policy) =>
              policy.cityId === city.id && policy.reason.startsWith('AI 高失业决策'),
          )
          .flatMap((policy) => (policy.tracking?.runs ?? []).map((run) => run.beneficiaries)),
      );
      if (beneficiaries > 0) beneficiaryCities.push(city.id);
    }
    expect(spentCities.length).toBeGreaterThan(0);
    expect(beneficiaryCities.length).toBeGreaterThan(0);
    expect(beneficiaryCities.some((cityId) => spentCities.includes(cityId))).toBe(true);
  });

  it('月度报告按真实顺序给出三口径，且与存档/执行记录一致', () => {
    const trace = [...(world.policies.fundingMonths ?? [])]
      .sort((left, right) => left.tick - right.tick)
      .at(-1)!;
    const report = policyFundingMonthlyReport(world, trace.cityId, trace.tick);
    expect(report).not.toBeNull();
    expect(report!.referenceBudget).toBeCloseTo(trace.referenceBudget, 2);
    expect(report!.reserved).toBeCloseTo(trace.reserved, 2);
    expect(report!.spent).toBeCloseTo(trace.spent, 2);
    expect(report!.unpaid).toBeCloseTo(trace.unpaid, 2);
    expect(report!.borrowingProceeds).toBeCloseTo(trace.borrowingProceeds, 2);
    const stageOrder = report!.stages.map((stage) => stage.stage);
    expect(stageOrder[0]).toBe('policyDecision');
    expect(stageOrder).toContain('policyReserved');
    expect(stageOrder).toContain('unpaid');
    expect(stageOrder.indexOf('policyReserved')).toBeLessThan(stageOrder.indexOf('unpaid'));
    if (trace.borrowingProceeds > 0) {
      expect(stageOrder).toContain('policyBorrowing');
      expect(stageOrder.indexOf('policyBorrowing')).toBeLessThan(
        stageOrder.indexOf('policyReserved'),
      );
    }
    // 报告金额与阶段明细一致（同一份真实数据，不重算、不重复计入）。
    const byStage = new Map(report!.stages.map((stage) => [stage.stage, stage.amount]));
    expect(byStage.get('policyDecision')).toBeCloseTo(report!.referenceBudget, 2);
    expect(byStage.get('policyReserved')).toBeCloseTo(report!.reserved, 2);
    // 报告实支 = policySpending 现金 + 公共岗位归属工资（§4：公共岗位纳入资助，工资走 fiscal）。
    const publicWage = publicWageAttribution(world, trace.cityId, trace.tick);
    const cashStage = byStage.get('policySpent') ?? 0;
    expect(round2(cashStage + publicWage)).toBeCloseTo(report!.spent, 2);
    expect(publicWage).toBeGreaterThanOrEqual(0);
    expect(byStage.get('unpaid')).toBeCloseTo(report!.unpaid, 2);

    // 存档往返：fundingMonths 与三口径字段保留、二次序列化逐字节一致。
    const parsed = parseSave(worldSaveText);
    expect(parsed.ok, parsed.error).toBe(true);
    const loaded = parsed.world!;
    expect(loaded.policies.fundingMonths ?? []).toEqual(world.policies.fundingMonths ?? []);
    expect(serializeSave(loaded, SAVE_AT)).toBe(worldSaveText);
    const loadedPolicy = loaded.policies.active.find(
      (policy) => policy.referenceBudget !== undefined,
    );
    expect(loadedPolicy).toBeDefined();
    expect(loadedPolicy!.referenceBudget).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------- §2 债券无流动性迁移

function newBondWorld(): WorldState {
  return Simulation.create().state;
}

function sortedCities(target: WorldState): City[] {
  return [...target.cities].sort((left, right) => left.id.localeCompare(right.id));
}

function investorsOf(target: WorldState, cityId: string): InvestorGroup[] {
  return target.investors
    .filter((group) => group.cityId === cityId)
    .sort((left, right) => left.id.localeCompare(right.id));
}

function groupOf(target: WorldState, cityId: string, occupation: OccupationClass): HouseholdGroup {
  const group = householdGroupsOfCity(target, cityId).find((entry) => entry.occupation === occupation);
  if (!group) throw new Error(`缺少 ${cityId}/${occupation} 群体`);
  return group;
}

function totalEffectiveShares(target: WorldState, cityId: string): number {
  return round2(
    householdGroupsOfCity(target, cityId).reduce(
      (total, group) => total + effectiveInvestorShares(group.investorLedger),
      0,
    ),
  );
}

function navOf(target: WorldState, cityId: string): number {
  const shares = totalEffectiveShares(target, cityId);
  return shares > 0 ? round2(cityInvestorEquity(target, cityId) / shares) : 0;
}

function groupShareValue(target: WorldState, cityId: string, group: HouseholdGroup): number {
  const equity = cityInvestorEquity(target, cityId);
  const shares = totalEffectiveShares(target, cityId);
  const own = effectiveInvestorShares(group.investorLedger);
  if (shares <= 0 || own <= 0) return 0;
  return round2((own / shares) * equity);
}

function bondsOfInvestors(target: WorldState, cityId: string): number {
  return round2(
    investorsOf(target, cityId).reduce(
      (total, investor) => total + investorBondValue(target, investor.id),
      0,
    ),
  );
}

function totalActiveBondValue(target: WorldState): number {
  return round2(
    (target.bonds?.holdings ?? [])
      .filter((holding) => holding.status === 'active')
      .reduce((total, holding) => total + holding.principal + holding.accruedInterest, 0),
  );
}

function seedInvestorCash(target: WorldState, city: City, cash: number): InvestorGroup {
  const investors = investorsOf(target, city.id);
  const ids = new Set(investors.map((investor) => investor.id));
  for (const holding of target.securities.holdings) {
    if (holding.holder.type === 'investorGroup' && ids.has(holding.holder.id)) {
      holding.holder = { type: 'city', id: city.id };
    }
  }
  for (const investor of investors) investor.cash = 0;
  const first = investors[0];
  if (!first) throw new Error(`缺少 ${city.id} 投资实体`);
  first.cash = cash;
  return first;
}

function seedHouseholdShares(
  target: WorldState,
  cityId: string,
  sharesByOccupation: Partial<Record<OccupationClass, number>>,
): void {
  for (const group of householdGroupsOfCity(target, cityId)) {
    const shares = round2(sharesByOccupation[group.occupation] ?? 0);
    group.investorLedger = {
      contributed: shares,
      shares,
      openingShares: 0,
      dividends: 0,
      lastContributionTick: -1,
      lastDividendTick: -1,
    };
  }
}

function bondHolderRef(group: InvestorGroup): BondHolder {
  return { kind: 'investorGroup', id: group.id };
}

function setupInvestorBond(
  target: WorldState,
  city: City,
  group: InvestorGroup,
  units: number,
  tick = 0,
): { issuanceId: string; issuance: NonNullable<ReturnType<typeof issueGovernmentBond>['issuance']> } {
  const market = DEMO_CONFIG.government.bondMarket;
  target.time.tick = tick;
  city.treasury = 0;
  group.cash = Math.max(group.cash, units * market.faceValue + 100_000);
  const issued = issueGovernmentBond(target, city, DEMO_CONFIG, units, tick);
  expect(issued.ok, issued.error).toBe(true);
  const issuance = issued.issuance!;
  expect(
    subscribeGovernmentBond(target, DEMO_CONFIG, issuance.id, bondHolderRef(group), units, tick).ok,
  ).toBe(true);
  expect(closeGovernmentBondSubscription(target, DEMO_CONFIG, issuance.id, tick).ok).toBe(true);
  return { issuanceId: issuance.id, issuance };
}

describe('v1.5 §2 债券无流动性迁移端到端（真实迁移调用链）', () => {
  it('A 城仅 10,000 债券、迁移者持 5,000 迁入 B：三方价值守恒、拆分不碎片、付息/到期/存档正确', () => {
    const target = newBondWorld();
    const from = sortedCities(target)[0]!;
    const to = sortedCities(target)[1]!;
    const bondGroup = investorsOf(target, from.id)[0]!;
    const { issuanceId, issuance } = setupInvestorBond(target, from, bondGroup, 10, 0);
    seedInvestorCash(target, from, 0);
    seedInvestorCash(target, to, 1_000);
    seedHouseholdShares(target, from.id, { unemployed: 500, production: 500 });
    seedHouseholdShares(target, to.id, { management: 1_000 });
    ensureInvestorOpeningShares(target);

    // 迁出前：A = 债券 10,000 / 1,000 份（净值 10），B = 现金 1,000 / 1,000 份（净值 1）。
    expect(cityInvestorEquity(target, from.id)).toBe(10_000);
    expect(cityInvestorEquity(target, to.id)).toBe(1_000);
    expect(totalActiveBondValue(target)).toBeCloseTo(10_000, 2);
    const migrantBefore = round2(500 * navOf(target, from.id));
    const remainingResident = groupOf(target, from.id, 'production');
    const remainingBefore = groupShareValue(target, from.id, remainingResident);
    const originalToResident = groupOf(target, to.id, 'management');
    const originalToBefore = groupShareValue(target, to.id, originalToResident);
    expect(migrantBefore).toBe(5_000);

    // 真实迁移调用链：population 迁移时调用 rebalanceHouseholdWealthForMigration +
    // transferHouseholdDebtsForMigration（后者内部转投资权益/债券拆分）。
    // 迁移人数取源群体真实人数（整群迁移），保证“迁出份额 = 该群体 500 份”与验收例一致。
    const moving = groupOf(target, from.id, 'unemployed').people;
    rebalanceHouseholdWealthForMigration(target, from.id, to.id, moving, moving, DEMO_CONFIG, 0);
    transferHouseholdDebtsForMigration(target, DEMO_CONFIG, from.id, to.id, moving, moving, 0);

    // 债券被真实拆分为两份：A 5,000 + B 5,000，合计不增不减。
    expect(totalActiveBondValue(target)).toBeCloseTo(10_000, 2);
    expect(bondsOfInvestors(target, from.id)).toBe(5_000);
    expect(bondsOfInvestors(target, to.id)).toBe(5_000);
    const activeHoldings = (target.bonds?.holdings ?? []).filter(
      (holding) => holding.issuanceId === issuanceId && holding.status === 'active',
    );
    // 源城实体 1 条 + 目标城每个投资实体各 1 条（B 城 3 个实体 → 合计 4 条，且不产生碎片）。
    const expectedHolderRows = 1 + investorsOf(target, to.id).length;
    expect(activeHoldings).toHaveLength(expectedHolderRows);
    expect(round2(sum(activeHoldings.map((holding) => holding.units)))).toBeCloseTo(
      issuance.soldUnits,
      2,
    );
    expect(round2(sum(activeHoldings.map((holding) => holding.principal)))).toBeCloseTo(
      issuance.soldUnits * issuance.faceValue,
      2,
    );
    // 同一（发行批次, 持有实体）只有一条 active 持债（无碎片）。
    const keys = activeHoldings.map((holding) => `${holding.holder.kind}:${holding.holder.id}`);
    expect(new Set(keys).size).toBe(keys.length);

    // 三方价值均不被无偿转移。
    expect(groupShareValue(target, to.id, groupOf(target, to.id, 'unemployed'))).toBe(migrantBefore);
    expect(groupShareValue(target, from.id, remainingResident)).toBe(remainingBefore);
    expect(groupShareValue(target, to.id, originalToResident)).toBe(originalToBefore);
    expect(navOf(target, from.id)).toBeCloseTo(10, 2);
    expect(navOf(target, to.id)).toBeCloseTo(1, 2);
    expect(round2(cashOfInvestors(target, from.id) + cashOfInvestors(target, to.id))).toBe(1_000);
    expect(checkInvariants(target)).toEqual([]);

    // 存档往返：拆分出的跨城持债通过校验，净资产/持债行/二次序列化幂等。
    const savedText = serializeSave(target, SAVE_AT);
    const parsed = parseSave(savedText);
    expect(parsed.ok, parsed.error).toBe(true);
    const loaded = parsed.world!;
    const loadedHoldings = (loaded.bonds?.holdings ?? []).filter(
      (holding) => holding.issuanceId === issuanceId && holding.status === 'active',
    );
    expect(loadedHoldings).toHaveLength(expectedHolderRows);
    expect(round2(sum(loadedHoldings.map((holding) => holding.principal)))).toBeCloseTo(
      issuance.soldUnits * issuance.faceValue,
      2,
    );
    expect(bondsOfInvestors(loaded, from.id)).toBe(5_000);
    expect(bondsOfInvestors(loaded, to.id)).toBe(5_000);
    expect(serializeSave(loaded, SAVE_AT)).toBe(savedText);
    expect(checkInvariants(loaded)).toEqual([]);

    // 付息：拆分后的两份持债分别收到票息（不重复、不遗漏）。
    const city = sortedCities(loaded)[0]!;
    city.treasury = 5_000_000;
    for (let tick = 1; tick <= 12; tick += 1) {
      loaded.time.tick = tick;
      accrueBondInterest(loaded, city, DEMO_CONFIG, tick);
    }
    loaded.time.tick = 12;
    const cashBeforeCoupon = new Map(
      loaded.investors.map((investor) => [investor.id, investor.cash] as const),
    );
    const coupon = payBondCoupon(loaded, city, DEMO_CONFIG, issuanceId, 12, []);
    expect(coupon.ok, coupon.error).toBe(true);
    expect(coupon.payments.length).toBe(expectedHolderRows);
    expect(coupon.interestPaid).toBeGreaterThan(0);
    expect(round2(sum(coupon.payments.map((payment) => payment.interestPaid)))).toBeCloseTo(
      coupon.interestPaid,
      2,
    );
    for (const payment of coupon.payments) {
      const investor = loaded.investors.find((entry) => entry.id === payment.holder.id)!;
      expect(round2(investor.cash - (cashBeforeCoupon.get(investor.id) ?? 0))).toBeCloseTo(
        payment.interestPaid,
        2,
      );
    }
    // 同一 tick 重放不重复支付。
    const replay = payBondCoupon(loaded, city, DEMO_CONFIG, issuanceId, 12, []);
    expect(replay.payments).toHaveLength(0);
    expect(replay.interestPaid).toBe(0);

    // 到期兑付：拆分后的两份真实持债分别收本息，发行状态 redeemed，重复调用不再支付。
    city.treasury = 0; // 财政不足时由银行垫付，兑付仍必须到账（不改变拆分逻辑）
    for (let tick = 13; tick <= issuance.maturityTick; tick += 1) {
      loaded.time.tick = tick;
      accrueBondInterest(loaded, city, DEMO_CONFIG, tick);
    }
    loaded.time.tick = issuance.maturityTick;
    const paymentsBeforeMaturity = loaded.bonds!.payments.length;
    const maturity = settleBondMaturity(loaded, city, DEMO_CONFIG, issuanceId, issuance.maturityTick, []);
    expect(maturity.ok, maturity.error).toBe(true);
    expect(maturity.principalPaid).toBeGreaterThan(0);
    const maturityPayments = loaded.bonds!.payments.slice(paymentsBeforeMaturity);
    expect(maturityPayments.length).toBe(expectedHolderRows);
    expect(round2(sum(maturityPayments.map((payment) => payment.principalPaid)))).toBeCloseTo(
      10_000,
      2,
    );
    expect(loaded.bonds!.issuances.find((entry) => entry.id === issuanceId)!.status).toBe('redeemed');
    expect(
      loaded.bonds!.holdings.filter((holding) => holding.issuanceId === issuanceId).every(
        (holding) => holding.status === 'redeemed',
      ),
    ).toBe(true);
    const totalAfterMaturity = loaded.bonds!.payments.length;
    const replayMaturity = settleBondMaturity(loaded, city, DEMO_CONFIG, issuanceId, issuance.maturityTick, []);
    expect(replayMaturity.principalPaid).toBe(0);
    expect(loaded.bonds!.payments.length).toBe(totalAfterMaturity);
    expect(checkInvariants(loaded)).toEqual([]);
  });
});

function cashOfInvestors(target: WorldState, cityId: string): number {
  return round2(investorsOf(target, cityId).reduce((total, investor) => total + investor.cash, 0));
}

// ---------------------------------------------------------------- §3 报告口径

describe('v1.5 §3 报告口径（明细 vs 汇总，本地 + 进口只计一次）', () => {
  it('真实 8 月世界：逐城居民实际成交 = 本地账本 + 进口，覆盖率与有效需求满足率同源', () => {
    const groupsOf = (cityId: string) => householdGroupsOfCity(world, cityId);
    let totalImported = 0;
    let totalFlowImported = 0;
    for (const city of world.cities) {
      const groups = groupsOf(city.id);
      const residentSold = round2(
        sum(groups.map((group) => group.lastMonth.basicSoldUnits ?? 0)),
      );
      const basicNeed = round2(
        sum(groups.map((group) => group.lastMonth.basicNeedUnits ?? 0)),
      );
      const effectiveDemand = round2(
        sum(groups.map((group) => group.lastMonth.basicEffectiveUnits ?? 0)),
      );
      const market = city.market['food'];
      const ledgerSold = round2(market.sold);
      const imported = round2(market.intercityImported);
      const flowImported = round2(
        sum(
          world.lastTick.tradeFlows
            .filter((flow) => flow.good === 'food' && flow.toCityId === city.id)
            .map((flow) => flow.qty),
        ),
      );
      // 明细（群体落账）与汇总（本地账本 + 进口）一致：进口只计一次、不重复、不遗漏。
      expect(residentSold, city.id).toBeCloseTo(round2(ledgerSold + imported), 2);
      expect(imported, city.id).toBeCloseTo(flowImported, 2);
      expect(round2(residentSold - imported), city.id).toBeCloseTo(ledgerSold, 2);
      expect(basicNeed).toBeGreaterThan(0);
      // 覆盖率/满足率同源（都是居民实际成交作分子）；落账字段与公式一致（4 位小数）。
      const coverage = residentSold / basicNeed;
      const satisfaction = effectiveDemand > 0 ? residentSold / effectiveDemand : null;
      // 群体 lastMonth.basicNeedCoverage 是“该群体成交/该群体需要量”的比率，不可求和；
      // 逐群体核对（4 位小数，与落账一致），整体覆盖率另按成交/需要量计算。
      for (const group of groups) {
        const need = group.lastMonth.basicNeedUnits ?? 0;
        const sold = group.lastMonth.basicSoldUnits ?? 0;
        if (need <= 0.01) continue;
        expect(group.lastMonth.basicNeedCoverage ?? 0, group.id).toBeCloseTo(
          Math.round((sold / need) * 10000) / 10000,
          4,
        );
      }
      if (satisfaction !== null) expect(satisfaction).toBeGreaterThanOrEqual(coverage - 1e-9);
      // 汇总覆盖率（本地 + 进口）与“只用本地成交”的旧口径差异 = 进口占比，不能相等。
      const localOnlyCoverage = ledgerSold / basicNeed;
      expect(Math.abs(coverage - localOnlyCoverage)).toBeCloseTo(imported / basicNeed, 3);
      totalImported = round2(totalImported + imported);
      totalFlowImported = round2(totalFlowImported + flowImported);
    }
    // 全局：Σ买方进口 = Σ收货贸易流 = Σ出口贸易流（跨城成交只记一次）。
    const totalExported = round2(
      sum(
        world.lastTick.tradeFlows
          .filter((flow) => flow.good === 'food')
          .map((flow) => flow.qty),
      ),
    );
    expect(totalImported).toBeCloseTo(totalFlowImported, 2);
    expect(totalImported).toBeCloseTo(totalExported, 2);
    expect(totalImported).toBeGreaterThan(0);
  });

  it('真实报告脚本（--months=5）：汇总与明细覆盖率一致，进口计入、三口径入报告', () => {
    const tsxBin = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
    expect(existsSync(tsxBin), `缺少本地 tsx：${tsxBin}`).toBe(true);
    const output = execFileSync(
      tsxBin,
      [
        path.join(REPO_ROOT, 'scripts', 'economy-v09-report.ts'),
        '--months=5',
        '--checkpoints=1,5',
        '--seed=20261101',
      ],
      { cwd: REPO_ROOT, encoding: 'utf8', timeout: 180_000, env: process.env },
    );
    const lines = output.split('\n');

    // 明细快照（每个 checkpoint 每城一行）：取每城最后一条（第 5 月）。
    const detail = new Map<string, { sold: number; local: number; imported: number; coverage: number | null; satisfaction: number | null }>();
    let currentCityId: string | null = null;
    for (const line of lines) {
      const header = line.match(/^## .+（(?<id>[a-z-]+)）$/u);
      if (header?.groups?.id) currentCityId = header.groups.id;
      const detailMatch = line.match(
        /^食品口径 居民实际成交 (?<sold>[\d,.]+) 件（本地 (?<local>[\d,.]+) \+ 进口 (?<imported>[\d,.]+)；/u,
      );
      if (!detailMatch?.groups || !currentCityId) continue;
      const coverageMatch = line.match(/基本需要覆盖率 (?<value>[\d.]+)%/u);
      const satisfactionMatch = line.match(/有效需求满足率 (?<value>[\d.]+)%/u);
      detail.set(currentCityId, {
        sold: numFrom(detailMatch.groups.sold!),
        local: numFrom(detailMatch.groups.local!),
        imported: numFrom(detailMatch.groups.imported!),
        coverage: coverageMatch ? Number(coverageMatch.groups!.value) : null,
        satisfaction: satisfactionMatch ? Number(satisfactionMatch.groups!.value) : null,
      });
      // 明细校验残差（本地居民−账本 / 进口−收货流）必须为 0。
      const checkMatch = line.match(
        /校验 本地居民−账本 (?<cross>-?[\d,.]+)\/进口−收货流 (?<import>-?[\d,.]+)/u,
      );
      expect(checkMatch).not.toBeNull();
      expect(Math.abs(numFrom(checkMatch!.groups!.cross!))).toBeLessThanOrEqual(0.05);
      expect(Math.abs(numFrom(checkMatch!.groups!.import!))).toBeLessThanOrEqual(0.005);
    }
    expect(detail.size).toBe(3);

    // 汇总（脚本 summary）：与明细同 tick 同口径。
    const summary = new Map<string, {
      sold: number; local: number; imported: number; need: number;
      coverage: number; satisfaction: number; effective: number;
      cross: number; importCheck: number;
    }>();
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      if (!line.startsWith('基本食品 需要量')) continue;
      const doneLine = lines[index + 1] ?? '';
      const nameMatch = doneLine.match(/^食品满足率 (?<name>[^：]+)：/u);
      expect(nameMatch, `汇总行后应紧跟食品满足率行：${line}`).not.toBeNull();
      const cityId = Object.entries(CITY_NAMES).find(([, name]) => name === nameMatch!.groups!.name)?.[0];
      expect(cityId, `未知城市名：${nameMatch!.groups!.name}`).toBeDefined();
      const match = line.match(
        /^基本食品 需要量 (?<need>[\d,.]+) 件\/月.*居民实际成交 (?<sold>[\d,.]+) 件（本地 (?<local>[\d,.]+) \+ 进口 (?<imported>[\d,.]+)）｜基本需要覆盖率 (?<coverage>[\d.]+)%.*有效需求满足率 (?<satisfaction>[\d.]+)%（有效需求 (?<effective>[\d,.]+)）.*校验 本地居民−账本 (?<cross>-?[\d,.]+)\/进口−收货流 (?<import>[\d,.]+)/u,
      );
      expect(match, `无法解析汇总行：${line}`).not.toBeNull();
      summary.set(cityId!, {
        need: numFrom(match!.groups!.need!),
        sold: numFrom(match!.groups!.sold!),
        local: numFrom(match!.groups!.local!),
        imported: numFrom(match!.groups!.imported!),
        coverage: Number(match!.groups!.coverage),
        satisfaction: Number(match!.groups!.satisfaction),
        effective: numFrom(match!.groups!.effective!),
        cross: numFrom(match!.groups!.cross!),
        importCheck: numFrom(match!.groups!.import!),
      });
    }
    expect(summary.size).toBe(3);

    for (const [cityId, item] of summary) {
      // 汇总成交 = 本地 + 进口（本地+进口只计一次），且与明细快照一致。
      // 报告中的本地/进口按 1 位小数格式化，相加与居民成交可能存在 ≤0.2 的展示舍入差。
      expect(Math.abs(item.sold - round2(item.local + item.imported)), cityId).toBeLessThanOrEqual(0.21);
      const detailItem = detail.get(cityId)!;
      expect(detailItem.sold, cityId).toBeCloseTo(item.sold, 1);
      expect(detailItem.local, cityId).toBeCloseTo(item.local, 1);
      expect(detailItem.imported, cityId).toBeCloseTo(item.imported, 1);
      // 覆盖率与满足率：脚本打印值 = 汇总成交/需要量（明细与汇总同一口径）。
      expect(item.coverage, cityId).toBeCloseTo(
        Math.round((item.sold / item.need) * 1000) / 10,
        1,
      );
      expect(item.satisfaction, cityId).toBeCloseTo(
        Math.round((item.sold / Math.max(1, item.effective)) * 1000) / 10,
        1,
      );
      // 明细覆盖率 == 汇总覆盖率（不能出现 51.2% vs 23.2% 的双口径）。
      expect(detailItem.coverage, cityId).toBeCloseTo(item.coverage, 1);
      expect(detailItem.satisfaction, cityId).toBeCloseTo(item.satisfaction, 1);
      // 校验残差为 0；覆盖率不能退化成“只用本地成交”。
      expect(Math.abs(item.cross), cityId).toBeLessThanOrEqual(0.05);
      expect(Math.abs(item.importCheck), cityId).toBeLessThanOrEqual(0.005);
      expect(item.coverage).toBeGreaterThanOrEqual(
        Math.round((item.local / item.need) * 1000) / 10 - 0.11,
      );
    }
    // 青原在 5 月有大量进口：汇总覆盖率必须显著高于“只用本地成交”的旧口径（证明进口计入）。
    const greenfield = summary.get('greenfield')!;
    expect(greenfield.imported).toBeGreaterThan(0);
    const localOnly = (greenfield.local / greenfield.need) * 100;
    expect(greenfield.coverage - localOnly).toBeGreaterThan(5);

    // 跨城口径校验行：三城进口合计 = 跨城成交流合计（差 ≈ 0，只计一次）。
    const crossLine = lines.find((line) => line.startsWith('食品跨城口径校验'));
    expect(crossLine).toBeDefined();
    const crossMatch = crossLine!.match(
      /三城进口合计 (?<imported>[\d,.]+) 件｜跨城成交流合计 (?<exported>[\d,.]+) 件｜差 (?<diff>-?[\d,.]+)/u,
    );
    expect(crossMatch).not.toBeNull();
    expect(numFrom(crossMatch!.groups!.imported!)).toBeCloseTo(
      numFrom(crossMatch!.groups!.exported!),
      1,
    );
    expect(Math.abs(numFrom(crossMatch!.groups!.diff!))).toBeLessThanOrEqual(0.05);

    // AI 政策资金三口径进入报告（第 3 月起）：参考/预留/实支/借款到账分列，至少一城实支>0。
    const fundingLines = lines.filter((line) => line.includes('AI 政策资金窗口'));
    expect(fundingLines.length).toBe(3);
    let anySpent = false;
    for (const line of fundingLines) {
      const match = line.match(
        /AI 政策资金窗口（(?<months>\d+) 月）：参考 (?<ref>[\d,.]+(?:万|亿)?)｜预留 (?<reserved>[\d,.]+(?:万|亿)?)｜实支 (?<spent>[\d,.]+(?:万|亿)?)｜未支付 (?<unpaid>[\d,.]+(?:万|亿)?)｜政策借款到账 (?<borrowed>[\d,.]+(?:万|亿)?)/u,
      );
      expect(match, `无法解析政策资金窗口：${line}`).not.toBeNull();
      expect(Number(match!.groups!.months)).toBeGreaterThan(0);
      const spent = parseReportMoney(match!.groups!.spent!);
      if (spent > 0) anySpent = true;
      expect(parseReportMoney(match!.groups!.ref!)).toBeGreaterThanOrEqual(spent - 1);
      expect(parseReportMoney(match!.groups!.reserved!)).toBeGreaterThanOrEqual(spent - 1);
      expect(parseReportMoney(match!.groups!.borrowed!)).toBeGreaterThanOrEqual(0);
    }
    expect(anySpent).toBe(true);
  });
});

/** 解析脚本 money() 输出：`1634.0万` / `1.23亿` / `12345`。 */
function parseReportMoney(text: string): number {
  if (text.endsWith('亿')) return numFrom(text.slice(0, -1)) * 1e8;
  if (text.endsWith('万')) return numFrom(text.slice(0, -1)) * 1e4;
  return numFrom(text);
}

// ---------------------------------------------------------------- §5 初始设备入口

describe('v1.5 §5 初始设备兼容入口（正常游戏可达入口）', () => {
  it('真实 tick/AI 自动创办的每条创办记录都带实物出资，且只计一次', () => {
    const foundings = world.lifecycle!.foundings;
    expect(foundings.length).toBeGreaterThan(0);
    for (const founding of foundings) {
      const grant = founding.initialEquipment;
      expect(grant, `${founding.companyId} 正常入口创办缺实物出资`).toBeDefined();
      expect(grant!.source).toBe('founderInKind');
      expect(grant!.units).toBe(INITIAL_EQUIPMENT_UNITS);
      expect(grant!.valuation).toBeGreaterThan(0);
      expect(grant!.lockUntilTick).toBe(grant!.grantedTick + INITIAL_EQUIPMENT_LOCK_MONTHS);
      const company = world.companies.find((entry) => entry.id === founding.companyId);
      if (!company) continue; // 已倒闭企业设备已处置，锁定/返还路径由 §4 专项测试覆盖。
      expect(company.initialEquipment).toEqual(grant);
      // 实物出资只计入企业设备一次；锁定期内不得少于授予台数。
      if (world.time.tick < grant!.lockUntilTick) {
        expect(company.equipment[grant!.kind]).toBeGreaterThanOrEqual(grant!.units);
      }
      // 估值只按授予台数记录一次（不是市场购买金额、也不是财政补贴）。
      expect(founding.governmentGrant ?? 0).toBeGreaterThanOrEqual(0);
    }
    // 存活企业中带实物出资的，都能对应到一条创办记录（记录窗口内），不重复授予。
    const grantedCompanies = world.companies.filter((company) => company.initialEquipment);
    expect(grantedCompanies.length).toBeGreaterThan(0);
    for (const company of grantedCompanies) {
      const grant = company.initialEquipment!;
      expect(grant.kind).toBeDefined();
      expect(grant.units).toBe(INITIAL_EQUIPMENT_UNITS);
      expect(company.equipment[grant.kind]).toBeGreaterThanOrEqual(
        Math.min(grant.units, company.initialEquipment ? 1 : 0),
      );
    }
    // 所有企业设备台数均为非负整数，产能与设备独立推导一致（不变量兜底）。
    for (const company of world.companies) {
      for (const kind of ['farm', 'industry', 'energy'] as const) {
        expect(Number.isInteger(company.equipment[kind])).toBe(true);
        expect(company.equipment[kind]).toBeGreaterThanOrEqual(0);
      }
    }
    expect(checkInvariants(world)).toEqual([]);
  });
});

// ---------------------------------------------------------------- §6 旧档可选字段

describe('v1.5 §6 旧档往返：fundingMonths 可选且幂等', () => {
  it('v0.9 真实 fixture 无 fundingMonths：读取/推进/保存/再读不报错且幂等', () => {
    const rawText = readFileSync(FIXTURE_PATH, 'utf8');
    const raw = JSON.parse(rawText) as { world: any };
    expect(raw.world.policies.fundingMonths).toBeUndefined();

    const parsed = parseSave(rawText);
    expect(parsed.ok, parsed.error).toBe(true);
    const legacy = parsed.world!;
    expect(legacy.policies.fundingMonths).toBeUndefined();
    expect(checkInvariants(legacy)).toEqual([]);

    // 推进 1 月：旧档不因新字段缺失而失败；新字段可有可无（可选）。
    const simulation = new Simulation(legacy, DEMO_CONFIG);
    const tickResult = simulation.tick();
    expect(tickResult.ok, tickResult.ok ? '' : tickResult.error).toBe(true);
    const advanced = simulation.state;
    expect(checkInvariants(advanced)).toEqual([]);
    for (const trace of advanced.policies.fundingMonths ?? []) {
      expect(trace.tick).toBeGreaterThanOrEqual(0);
      expect(trace.cityId).toBeTruthy();
      expect(trace.referenceBudget).toBeGreaterThanOrEqual(0);
      expect(trace.reserved).toBeGreaterThanOrEqual(0);
      expect(trace.spent).toBeGreaterThanOrEqual(0);
      expect(trace.unpaid).toBeGreaterThanOrEqual(0);
    }

    const saved = serializeSave(advanced, SAVE_AT);
    const reparsed = parseSave(saved);
    expect(reparsed.ok, reparsed.error).toBe(true);
    expect(reparsed.world!.policies.fundingMonths).toEqual(advanced.policies.fundingMonths);
    // 二次序列化逐字节稳定（归一化幂等，不重复补字段）。
    expect(serializeSave(reparsed.world!, SAVE_AT)).toBe(saved);

    // v1.5 存档删除可选 fundingMonths 后仍可读、可再序列化（旧客户端/裁剪存档兼容）。
    // 旧档夹具必须是旧单体格式（v10 模块化文本没有 world.policies）。
    const v15 = JSON.parse(serializeLegacySave(advanced, SAVE_AT)) as { world: any };
    delete v15.world.policies.fundingMonths;
    const stripped = parseSave(JSON.stringify(v15));
    expect(stripped.ok, stripped.error).toBe(true);
    expect(stripped.world!.policies.fundingMonths).toBeUndefined();
    expect(checkInvariants(stripped.world!)).toEqual([]);
    const strippedText = serializeSave(stripped.world!, SAVE_AT);
    expect(parseSave(strippedText).ok).toBe(true);
  });
});
