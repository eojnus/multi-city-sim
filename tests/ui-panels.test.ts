import { describe, expect, it } from 'vitest';
import { GameStore } from '../src/app/gameStore';
import { Simulation } from '../src/simulation/core/simulation';
import {
  renderCompanyDetail,
  renderLeftRegion,
  renderRightCity,
  renderRightRegion,
} from '../src/ui/panels';
import { POLICY_DEFINITIONS } from '../src/simulation/policies/definitions';
import type { Motion } from '../src/simulation/contracts/types';
import type { SaveBridge } from '../src/platform/saveBridge';

/** 桌面环境不可用时的无 DOM 面板回归：只验证渲染出的 HTML 包含必需入口。 */
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

const panelState = { showAllGoods: false, logCollapsed: false } as never;

describe('控制台面板：政府、政策、交通与企业生命周期入口', () => {
  it('城市面板包含政府与交通 section，玩家市长时 15 项政策全部可操作', () => {
    const store = createStore();
    store.setMayorDemo('lanport');
    const city = store.world.cities.find((entry) => entry.id === 'lanport')!;
    const html = renderRightCity(store, panelState);
    expect(html).toContain('data-testid="government-section"');
    expect(html).toContain('data-testid="transport-section"');
    for (const definition of POLICY_DEFINITIONS) {
      expect(html).toContain(`data-policy-id="${definition.id}"`);
    }
    expect(html).not.toContain('data-action="run-for-mayor"');
    expect(html).toContain('data-action="invest-transport"');
    expect(html).toContain('data-testid="intracity-road"');
    expect(html).toContain(`data-testid="transport-link-`);
    expect(html).toContain(city.name);
    expect(html).not.toContain('系统未实现');
    // 玩家可以分配政策预算：13 项需要预算的政策各有一个输入；税收与交通不按预算。
    const budgetInputs = html.match(/data-policy-budget="/g) ?? [];
    expect(budgetInputs.length).toBe(13);
    expect(html).toContain('data-testid="policy-budget-hiringSubsidy"');
    expect(html).toContain('data-default-budget="700000"');
    expect(html).not.toContain('data-policy-budget="taxAdjustment"');
    expect(html).not.toContain('data-policy-budget="transportInvestment"');
  });

  it('非玩家市长时政策按钮不可直接执行，并显示 AI 选择原因', () => {
    const store = createStore();
    store.world.player.roles.mayorCityId = null;
    const html = renderRightCity(store, panelState);
    expect(html).toContain('data-testid="government-section"');
    expect(html).toContain('data-action="run-for-mayor"');
    expect(html).toContain('由政府自主施政');
  });

  it('区域面板包含企业创办入口与生命周期记录区域', () => {
    const store = createStore();
    const left = renderLeftRegion(store);
    expect(left).toContain('data-action="enter-city"');
    const html = renderRightRegion(store, panelState);
    expect(html).toContain('data-testid="company-row-lp-food"');
    expect(html).toContain('data-testid="company-lifecycle"');
    expect(html).toContain('data-action="found-company"');
    expect(store.lifecycleView('lanport').limits.maxCompanies).toBeGreaterThan(0);
  });

  it('企业详情包含经营风格、最近决策、扩产入口与生命周期状态', () => {
    const store = createStore();
    store.selectCity('lanport');
    store.selectCompany('lp-food');
    const html = renderRightRegion(store, { showAllGoods: false, focusCompanyId: 'lp-food' } as never);
    expect(html).toContain('data-testid="company-ai"');
    expect(html).toContain('data-action="expand-capacity"');
    const view = store.companyAiView('lp-food')!;
    expect(view.styleLabel.length).toBeGreaterThan(0);
    expect(view.decision.length).toBeGreaterThan(0);
  });
});

describe('控制台面板：v0.4 居民阶层、人才市场、银行与经营者', () => {
  it('城市面板包含人口阶层、人才市场与银行 section，以及对应的操作入口', () => {
    const store = createStore();
    store.selectCity('lanport');
    const html = renderRightCity(store, panelState);
    expect(html).toContain('data-testid="population-strata-section"');
    expect(html).toContain('data-testid="talent-market-section"');
    expect(html).toContain('data-testid="bank-section"');
    // 人口阶层：口径说明 + 职业群体表。
    expect(html).toContain('一个人只统计一次');
    expect(html).toContain('股票市值不是现金');
    expect(html).toContain('data-scroll="pop-strata"');
    // 人才市场：只列空闲人才，每行有稳定 testid。
    expect(html).toContain('只展示空闲人才');
    const talentView = store.talentMarketView('lanport');
    expect(talentView.operators.length).toBeGreaterThan(0);
    for (const operator of talentView.operators) {
      expect(html).toContain(`data-testid="talent-row-${operator.id}"`);
    }
    // 银行：存取款与贷款入口、额度口径与逾期宽限说明。
    expect(html).toContain('data-action="bank-deposit"');
    expect(html).toContain('data-action="bank-withdraw"');
    expect(html).toContain('data-action="take-loan"');
    expect(html).toContain('data-owner-kind="player"');
    expect(html).toContain('data-purpose="personal"');
    expect(html).toContain('同一主体全部贷款共享额度');
    expect(html).toContain('逾期宽限');
  });

  it('财富阶层人数合计等于城市总人口（视图数据与渲染合计一致）', () => {
    const store = createStore();
    store.selectCity('lanport');
    const city = store.world.cities.find((entry) => entry.id === 'lanport')!;
    const view = store.populationStrataView('lanport')!;
    const stats = view.stats!;
    const tierPeople = stats.tiers.reduce((total, tier) => total + tier.people, 0);
    expect(tierPeople).toBe(city.population.total);
    expect(stats.totalPeople).toBe(city.population.total);
    // 职业群体人数同样合计为总人口（一个人只统计一次）。
    const groupPeople = view.groups.reduce((total, group) => total + group.people, 0);
    expect(groupPeople).toBe(city.population.total);
    const html = renderRightCity(store, panelState);
    expect(html).toContain('data-testid="population-strata-section"');
    expect(html).toContain('财富阶层');
    expect(html).toContain('职业群体');
  });

  it('企业详情在股票交易之后、警告说明之前插入经营者区块', () => {
    const store = createStore();
    store.selectCity('lanport');
    const company = store.world.companies.find((entry) => entry.id === 'lp-food')!;
    const html = renderCompanyDetail(store, company);
    expect(html).toContain('data-testid="company-operator"');
    const tradingAt = html.indexOf('data-testid="company-trading"');
    const operatorAt = html.indexOf('data-testid="company-operator"');
    const warningAt = html.indexOf('class="warning-note"');
    expect(tradingAt).toBeGreaterThan(-1);
    expect(operatorAt).toBeGreaterThan(tradingAt);
    expect(warningAt).toBeGreaterThan(operatorAt);
    // 玩家不是经营者且无选任时的说明。
    expect(html).toContain('你目前不经营该企业');
    const view = store.operatorView('lp-food')!;
    expect(view.operatorName.length).toBeGreaterThan(0);
  });

  it('玩家经营企业渲染模式、授权预设、持续计划输入与提案入口', () => {
    const store = createStore();
    store.selectCity('lanport');
    const company = store.world.companies.find((entry) => entry.id === 'lp-food')!;
    const control = store.world.governance.controls.find(
      (entry) => entry.companyId === 'lp-food',
    )!;
    control.operator = { type: 'player', id: 'player' };
    control.basis = 'election';
    expect(store.setOperationMode('lp-food', 'assisted')).toBe(true);
    const html = renderCompanyDetail(store, company);
    expect(html).toContain('data-testid="company-operator"');
    expect(html).toContain('data-testid="company-operator-operation"');
    expect(html).toContain('data-action="set-operation-mode"');
    expect(html).toContain('data-company-id="lp-food"');
    expect(html).toContain('data-mode="manual"');
    expect(html).toContain('data-mode="assisted"');
    expect(html).toContain('data-mode="delegated"');
    expect(html).toContain('data-action="set-operation-authorization"');
    expect(html).toContain('data-preset="conservative"');
    expect(html).toContain('data-preset="standard"');
    expect(html).toContain('data-preset="generous"');
    expect(html).toContain('data-action="set-standing-plan"');
    expect((html.match(/data-plan-field="/g) ?? []).length).toBe(4);
    expect(html).toContain('data-plan-field="utilization"');
    expect(html).toContain('data-plan-field="investmentPerMonth"');
  });

  it('开放中的经营者选任渲染候选人、票数与投票入口', () => {
    const store = createStore();
    store.selectCity('lanport');
    const company = store.world.companies.find((entry) => entry.id === 'lp-food')!;
    const motion: Motion = {
      id: 'motion-test-election',
      companyId: company.id,
      kind: 'operatorElection',
      title: '经营者选任（测试）',
      proposedBy: { type: 'company', id: company.id },
      createdTick: 0,
      closesAtTick: 2,
      params: {},
      candidates: [
        {
          candidateId: 'op-test-incumbent',
          kind: 'ai',
          operatorId: 'op-test-incumbent',
          name: '测试现任',
          style: 'steady',
          isIncumbent: true,
        },
        {
          candidateId: 'player',
          kind: 'player',
          operatorId: null,
          name: '玩家 · 测试',
          style: null,
          isIncumbent: false,
        },
      ],
      status: 'open',
      eligible: [{ holder: { type: 'player', id: 'player' }, shares: 500 }],
      votes: [
        {
          holder: { type: 'player', id: 'player' },
          vote: 'for',
          votingShares: 500,
          tick: 0,
          candidateId: 'player',
        },
      ],
      decidedTick: null,
      result: '',
      note: '测试选任议案',
    };
    store.world.governance.motions.push(motion);
    // 玩家持有有表决权股份：登记参选按钮的前提（票权本身按议案快照计算）。
    const votingClass = store.world.securities.classes.find(
      (entry) => entry.companyId === company.id && entry.kind === 'voting',
    )!;
    store.world.securities.holdings.push({
      companyId: company.id,
      shareClassId: votingClass.id,
      holder: { type: 'player', id: 'player' },
      shares: 500,
      acquiredVia: 'secondary',
      sinceTick: 0,
    });
    const html = renderCompanyDetail(store, company);
    expect(html).toContain('data-testid="company-operator-election"');
    expect(html).toContain('投票截止 T2');
    expect(html).toContain('data-action="vote-election"');
    expect(html).toContain('data-motion-id="motion-test-election"');
    expect(html).toContain('data-candidate-id="player"');
    expect(html).toContain('现任');
    expect(html).toContain('得票 500 股');
    expect(html).toContain('你已登记参选');
    // 未登记时同一区块给出登记参选入口。
    motion.candidates = motion.candidates!.filter((candidate) => candidate.kind !== 'player');
    const htmlAfter = renderCompanyDetail(store, company);
    expect(htmlAfter).toContain('data-action="register-candidate"');
    expect(htmlAfter).toContain('data-motion-id="motion-test-election"');
  });
});
