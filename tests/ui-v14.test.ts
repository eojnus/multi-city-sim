// v1.4 UI 可观察性回归（无 DOM，纯字符串渲染 + GameStore 真实状态）。
//
// 覆盖：
// 1. 居民/投资面板：有效份额（shares + openingShares）、占比、投资实体净资产（现金 + 股票市值 +
//    债券估值）、每份净值、债券估值；口径直接取自 investorFundingReport（与月度/CLI 报告一致）。
// 2. 企业设备面板：初始实物出资来源/台数/估值/锁定期剩余；锁定设备出售由后端拒绝并可见错误；
//    锁定期满后可正常挂出。
// 3. 政府/政策面板：AI 经济体检（档位/3 月均值/趋势/症结/预算与占比/真实与估算税月/
//    债务 GDP 与 85% 预警/到期压力）、在行政策及原因、本月执行支出/受益/真实岗位；
//    玩家市长时显示“AI 不代选政策”。
import { describe, expect, it } from 'vitest';
import { GameStore } from '../src/app/gameStore';
import { Simulation } from '../src/simulation/core/simulation';
import { DEMO_CONFIG } from '../src/data/config';
import { GOODS } from '../src/data/demo-data';
import { investorFundingReport } from '../src/simulation/investors/investors';
import { latestCheckup, unemploymentTierLabel } from '../src/simulation/policies/ai-labor';
import { foundCompany } from '../src/simulation/companies/lifecycle/lifecycle';
import { ensureGovernance } from '../src/simulation/corporate-governance/governance';
import { renderCompanyDetail, renderRightCity } from '../src/ui/panels';
import { renderRightPanel } from '../src/ui/right-panel';
import { money, num, pct, signedPct, tickDate } from '../src/ui/format';
import type { EquipmentKind, WorldState } from '../src/simulation/contracts/types';
import type { SaveBridge } from '../src/platform/saveBridge';

const panelState = { showAllGoods: false, logCollapsed: false } as never;
const KINDS: EquipmentKind[] = ['farm', 'industry', 'energy'];

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

/** 与 ui-equipment 测试同一套“玩家当选经营者”最小状态。 */
function makePlayerOperator(store: GameStore, companyId: string): void {
  ensureGovernance(store.world, DEMO_CONFIG, store.world.time.tick);
  const control = store.world.governance.controls.find((entry) => entry.companyId === companyId);
  if (!control) throw new Error(`找不到企业控制权：${companyId}`);
  control.operator = { type: 'player', id: 'player' };
  control.operatorId = null;
  control.basis = 'election';
  control.sinceTick = store.world.time.tick;
  control.termEndTick = store.world.time.tick + DEMO_CONFIG.management.termMonths;
}

function richWorld(world: WorldState): void {
  for (const city of world.cities) city.treasury = 50_000_000;
  for (const group of world.investors) group.cash = 100_000_000;
  for (const company of world.companies) company.cash = 50_000_000;
}

/**
 * 制造“食品持续缺货 + 价格合理”的创办机会，并清空所有设备库存（本地企业与政府）。
 * 与 tests/founding-v14.test.ts 同一构造：新企业只能靠创办者实物出资带入的 1 台设备开工。
 */
function foodGapWithoutEquipment(world: WorldState, cityId = 'lanport'): void {
  const city = world.cities.find((entry) => entry.id === cityId)!;
  const base = GOODS.find((good) => good.id === 'food')!.basePrice;
  const market = city.market.food;
  market.price = base * 1.4;
  market.lastPriceChangePct = 5;
  market.demand = 2_000_000;
  market.sold = 0;
  market.unmetDemand = 2_000_000;
  market.supply = 500_000;
  for (const kind of KINDS) world.equipmentMarket.initialStock[kind] = 0;
  for (const company of world.companies) {
    for (const kind of KINDS) company.inventory[DEMO_CONFIG.equipment.catalog[kind].goodId] = 0;
  }
  for (const entry of world.cities) {
    for (const kind of KINDS) {
      const goodId = DEMO_CONFIG.equipment.catalog[kind].goodId;
      entry.market[goodId].closingStock = 0;
      entry.market[goodId].supply = 0;
    }
  }
}

describe('v1.4 居民/投资面板：有效份额、占比、净资产与每份净值', () => {
  it('人口标签渲染依赖数据，展示全部有效份额（含 openingShares）与净资产口径', () => {
    const store = createStore();
    // v1.4：openingShares 在首次结算/旧档读取时补齐（不在 create 时预写，保持 v1.2 股息归属语义）；
    // 面板在真实游戏里总是读取已结算的世界，这里推进 1 月后再断言（与桌面验收 t1 一致）。
    store.tick();
    store.selectCity('lanport');
    const report = investorFundingReport(store.world).find((entry) => entry.cityId === 'lanport');
    expect(report).toBeTruthy();
    const shares = report!.householdShares;
    expect(shares.length).toBeGreaterThan(0);
    const totalShares = shares.reduce((sum, entry) => sum + entry.effectiveShares, 0);
    const holdingsValue = report!.groups.reduce((sum, group) => sum + group.holdingsValue, 0);
    const bondsValue = report!.groups.reduce((sum, group) => sum + group.bondsValue, 0);
    const navPerShare = report!.investorNetWorth / totalShares;

    const html = renderRightPanel(store, {
      tab: 'population',
      focusCompanyId: null,
      showAllGoods: false,
      previousContextKey: 'city:lanport',
    });

    expect(html).toContain('data-testid="investor-section"');
    expect(html).toContain('data-testid="investor-networth"');
    expect(html).toContain('data-testid="investor-share-table"');
    // 净资产 = 现金 + 股票市值 + 债券估值：三块与合计都在面板上，且合计来自 investorFundingReport。
    expect(html).toContain(money(report!.investorNetWorth));
    expect(html).toContain(money(report!.investorCash));
    expect(html).toContain(money(holdingsValue));
    expect(html).toContain(money(bondsValue));
    expect(html).toContain('债券估值');
    expect(html).toContain('每份净值');
    expect(html).toContain(num(navPerShare, 4));
    expect(html).toContain('有效份额');
    expect(html).toContain(num(totalShares, 2));

    // 每个群体的有效份额、占比与 openingShares 都逐行渲染；有效份额 = shares + openingShares。
    for (const entry of shares) {
      expect(html).toContain(`data-testid="investor-share-${entry.householdGroupId}"`);
      expect(html).toContain(num(entry.effectiveShares, 2));
      expect(html).toContain(pct(entry.shareRatio, 2));
      expect(entry.effectiveShares).toBeCloseTo(entry.shares + entry.openingShares, 2);
    }
    // 开局旧资产份额（openingShares > 0）必须出现在面板里，不能只显示 shares。
    const withOpening = shares.find((entry) => entry.openingShares > 0);
    expect(withOpening, '演示开局应存在 openingShares 份额').toBeTruthy();
    expect(html).toContain(num(withOpening!.openingShares, 2));
    expect(html).toContain(pct(withOpening!.shareRatio, 2));
    expect(html).toContain('data-testid="investor-share-total"');
    // 口径提示：净资产由现金 + 股票市值 + 债券估值构成，与月度报告一致。
    expect(html).toContain('现金 + 股票市值 + 债券估值');
  });

  it('净资产与分项自洽：合计 = 实体现金 + 股票市值 + 债券估值（面板同一数据源）', () => {
    const store = createStore();
    const report = investorFundingReport(store.world).find((entry) => entry.cityId === 'lanport')!;
    const holdingsValue = report.groups.reduce((sum, group) => sum + group.holdingsValue, 0);
    const bondsValue = report.groups.reduce((sum, group) => sum + group.bondsValue, 0);
    expect(report.investorNetWorth).toBeCloseTo(report.investorCash + holdingsValue + bondsValue, 2);
    // 面板不展示“内部持仓明细”，也不出现负的有效份额。
    for (const entry of report.householdShares) {
      expect(entry.effectiveShares).toBeGreaterThanOrEqual(0);
      expect(entry.shareRatio).toBeGreaterThanOrEqual(0);
      expect(entry.shareRatio).toBeLessThanOrEqual(1);
    }
  });

  it('城市整页渲染（区域视图）同样包含投资面板；无资金用途时不编造数字', () => {
    const store = createStore();
    const html = renderRightCity(store, panelState);
    expect(html).toContain('data-testid="investor-section"');
    expect(html).toContain('data-testid="investor-usage-empty"');
    expect(html).toContain('不虚构成交');
  });
});

describe('v1.4 企业设备面板：初始实物出资来源/估值/锁定期', () => {
  function foundInKindCompany(store: GameStore) {
    richWorld(store.world);
    foodGapWithoutEquipment(store.world);
    const result = foundCompany(
      store.world,
      { cityId: 'lanport', recipeOutput: 'food' },
      DEMO_CONFIG,
    );
    expect(result.ok, result.error).toBe(true);
    const company = store.world.companies.find((entry) => entry.id === result.companyId)!;
    expect(company.initialEquipment).toBeTruthy();
    makePlayerOperator(store, company.id);
    return company;
  }

  it('展示来源（模拟范围外实物出资）、台数、估值、锁定期剩余与市场采购台数', () => {
    const store = createStore();
    const company = foundInKindCompany(store);
    const grant = company.initialEquipment!;
    const view = store.companyOperatingView(company.id)!;
    const totalOwned = view.equipmentRows.reduce((total, row) => total + row.units, 0);
    const html = renderCompanyDetail(store, company);

    expect(html).toContain('data-testid="company-equipment"');
    expect(html).toContain('data-testid="equipment-initial"');
    expect(html).toContain('模拟范围外实物出资');
    expect(html).toContain(`${num(grant.units)} 台`);
    expect(html).toContain(money(grant.valuation));
    // 锁定期剩余 = lockUntilTick − 当前 tick（开局创办时为完整 12 个月）。
    expect(html).toContain(`${num(Math.max(0, grant.lockUntilTick - store.world.time.tick))} 个月后解禁`);
    expect(html).toContain(`锁定 ${num(grant.units)} 台不可出售`);
    expect(html).toContain('data-testid="equipment-initial-lock"');
    // 市场采购台数 = 持有合计 − 实物出资台数（当前为 0；不重复计实物出资）。
    expect(html).toContain('市场采购');
    expect(html).toContain(`${num(Math.max(0, totalOwned - grant.units))} 台`);
    expect(html).toContain(`持有合计</i><b>${num(totalOwned)} 台`);
    // 出售表单里也标注锁定台数，玩家知道不能卖哪部分。
    expect(html).toContain(`（锁定 ${num(grant.units)} 台）`);
  });

  it('尝试出售锁定期内的实物出资设备：后端拒绝，错误信息可见且资产不变', () => {
    const store = createStore();
    const company = foundInKindCompany(store);
    const grant = company.initialEquipment!;
    const beforeUnits = company.equipment[grant.kind];
    const beforeOffers = store.world.equipmentMarket.offers.length;

    const ok = store.sellUsedEquipment(company.id, grant.kind, 1);

    expect(ok).toBe(false);
    expect(company.equipment[grant.kind]).toBe(beforeUnits);
    expect(store.world.equipmentMarket.offers.length).toBe(beforeOffers);
    const message = store.toasts.at(-1)?.message ?? '';
    expect(message).toContain('锁定期内');
    expect(message).toContain('创办实物出资');
    // 面板在出售前就给出锁定提示（不是等玩家点了才编造）。
    const html = renderCompanyDetail(store, company);
    expect(html).toContain('锁定期内');
  });

  it('锁定期满后同一台设备可以正常挂出（锁定只按真实 tick 生效）', () => {
    const store = createStore();
    const company = foundInKindCompany(store);
    const grant = company.initialEquipment!;
    // 把锁定期结束 tick 设到当前 tick：等价于已等到解禁（不推进模拟，避免长跑）。
    grant.lockUntilTick = store.world.time.tick;

    const html = renderCompanyDetail(store, company);
    expect(html).toContain('已解禁');
    expect(html).not.toContain('锁定 1 台不可出售');

    const ok = store.sellUsedEquipment(company.id, grant.kind, 1);
    expect(ok).toBe(true);
    const offer = store.world.equipmentMarket.offers.find(
      (entry) => entry.companyId === company.id,
    );
    expect(offer).toBeTruthy();
    expect(offer!.units).toBe(1);
  });

  it('没有实物出资的既有企业：明确标注设备全部为市场采购，不伪造初始出处', () => {
    const store = createStore();
    const company = store.world.companies.find((entry) => entry.id === 'lp-food')!;
    expect(company.initialEquipment ?? null).toBeNull();
    const view = store.companyOperatingView(company.id)!;
    const totalOwned = view.equipmentRows.reduce((total, row) => total + row.units, 0);
    const html = renderCompanyDetail(store, company);
    expect(html).toContain('data-testid="equipment-initial"');
    expect(html).toContain('全部为市场采购');
    expect(html).toContain('无实物出资');
    expect(html).toContain(`市场采购</i><b>${num(totalOwned)} 台`);
    expect(html).not.toContain('模拟范围外实物出资');
  });
});

describe('v1.4 政府/政策面板：AI 经济体检、政策原因与执行追踪', () => {
  it('非市长（AI 执政）显示体检档位/3 月均值/趋势/症结/预算与占比/税月/债务预警/到期压力', () => {
    const store = createStore();
    store.selectCity('lanport');
    expect(store.tick()).toBe(true);
    const checkup = latestCheckup(store.world, 'lanport');
    expect(checkup).toBeTruthy();
    const html = renderRightCity(store, panelState);

    expect(html).toContain('data-testid="ai-government"');
    expect(html).toContain('data-testid="ai-checkup-tier"');
    expect(html).toContain('AI 政府 · 经济体检');
    expect(html).toContain(unemploymentTierLabel(checkup!.tier));
    expect(html).toContain(unemploymentTierLabel(checkup!.rawTier));
    expect(html).toContain(pct(checkup!.unemploymentRateAvg3));
    expect(html).toContain(signedPct(checkup!.unemploymentTrend));
    // 症结（symptoms）逐条来自体检快照；没有症状时显示“无明显症状”。
    expect(html).toContain('data-testid="ai-checkup-symptoms"');
    if (checkup!.symptoms.length > 0) {
      for (const symptom of checkup!.symptoms) expect(html).toContain(symptom);
    } else {
      expect(html).toContain('无明显症状');
    }
    // 月预算与档位占比；真实/估算税月；债务/GDP 与 85% 预警线；到期压力（债券 + 贷款）。
    expect(html).toContain(money(checkup!.budget));
    expect(html).toContain(pct(checkup!.budgetShare));
    expect(html).toContain(
      `真实 ${num(checkup!.taxMonthsReal)} 月 / 估算 ${num(checkup!.taxMonthsEstimated)} 月`,
    );
    expect(html).toContain(money(checkup!.monthlyTaxRevenueReal));
    expect(html).toContain(money(checkup!.monthlyTaxRevenueEstimated));
    expect(html).toContain('data-testid="ai-checkup-debt"');
    expect(html).toContain(pct(checkup!.debtRatio));
    expect(html).toContain('85%');
    expect(html).toContain(pct(checkup!.debtServicePressure));
    expect(html).toContain(money(checkup!.bondDue));
    expect(html).toContain(money(checkup!.loanDue));
    expect(html).toContain('预算参考');
    // 非市长不得出现市长专属财政面板。
    expect(html).not.toContain('data-testid="mayor-fiscal-panel"');
    expect(html).toContain('data-testid="fiscal-restricted"');
  });

  it('在行政策显示启动原因与最近一次真实执行（支出/受益/真实岗位）', () => {
    const store = createStore();
    store.selectCity('lanport');
    expect(store.tick()).toBe(true);
    const policy = store.world.policies.active.find((entry) => entry.cityId === 'lanport');
    expect(policy, 'AI 政府应在首月启动政策').toBeTruthy();
    const latestRun = policy!.tracking?.runs.at(-1);
    expect(latestRun, '政策执行必须有可追溯记录').toBeTruthy();
    const html = renderRightCity(store, panelState);

    expect(html).toContain(`data-testid="policy-reason-${policy!.policyId}"`);
    expect(html).toContain('启动原因：');
    expect(html).toContain(policy!.reason);
    expect(html).toContain(`data-testid="policy-run-${policy!.policyId}"`);
    expect(html).toContain(tickDate(latestRun!.tick));
    expect(html).toContain(money(latestRun!.spent));
    expect(html).toContain(`受益 <b>${num(latestRun!.beneficiaries)}</b>`);
    expect(html).toContain('真实岗位');
    expect(html).toContain(`来源：${latestRun!.fundingSource}`);
    expect(html).toContain(latestRun!.reason);
  });

  it('玩家市长：显示“AI 不代选政策”，不显示 AI 体检决策块', () => {
    const store = createStore();
    store.selectCity('lanport');
    expect(store.tick()).toBe(true);
    store.setMayorDemo('lanport');
    const html = renderRightCity(store, panelState);
    expect(html).toContain('data-testid="ai-mayor-status"');
    expect(html).toContain('AI 不代选政策');
    expect(html).not.toContain('data-testid="ai-government"');
    // 市长仍能看到自己的财政面板与政策操作入口。
    expect(html).toContain('data-testid="fiscal-ledger"');
    expect(html).toContain('data-action="stop-policy"');
    expect(html).toContain('data-testid="policy-reason-');
  });

  it('尚无体检快照时明确写“尚无记录”，不虚构档位/预算/预警', () => {
    const store = createStore();
    store.selectCity('lanport');
    const html = renderRightCity(store, panelState);
    expect(html).toContain('data-testid="ai-checkup-empty"');
    expect(html).toContain('尚无记录');
    expect(html).toContain('不会在没有体检数据时凭空选择政策');
  });
});
