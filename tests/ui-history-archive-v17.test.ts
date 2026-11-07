import { describe, expect, it } from 'vitest';
import { GameStore } from '../src/app/gameStore';
import { Simulation } from '../src/simulation/core/simulation';
import { DEMO_CONFIG } from '../src/data/config';
import {
  renderBankSection,
  renderBondMarketSection,
  renderCompanyDetail,
  renderGovernmentSection,
} from '../src/ui/panels';
import { renderStockWindow } from '../src/ui/stock-window';
import { money } from '../src/ui/format';
import type { SaveBridge } from '../src/platform/saveBridge';

/**
 * v1.7 §五：历史数据显示的 UI 标注（SAVE-FIX-U）。
 *
 * 历史治理把超过保留窗口的只读明细归档为年度/月度聚合；本测试锁定：
 * - “近期明细”面板明确标注保留窗口与“更早已归档”；
 * - 语义明确的年度归档以只读“年度汇总（非逐笔）”展示，且不把汇总混进逐笔列表；
 * - 不伪造缺失数据、不泄露其他城市/主体的归档金额（财政归档仅市长、贷款归档仅笔数）。
 */

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

const cityOf = (store: GameStore, cityId = 'lanport') =>
  store.world.cities.find((entry) => entry.id === cityId)!;

describe('v1.7 §五 UI：近期明细窗口标注 + 年度汇总（非逐笔）', () => {
  it('财政流水：市长面板标注 36 个月明细窗口，并只展示本城年度归档汇总', () => {
    const store = createStore();
    store.setMayorDemo('lanport');
    store.world.fiscal.archivedLedger = [
      { year: 2024, cityId: 'lanport', kind: 'incomeTax', count: 12, amount: 1_200_000 },
      { year: 2024, cityId: 'lanport', kind: 'publicWages', count: 12, amount: -800_000 },
      // 他城归档不得出现在本城面板。
      { year: 2023, cityId: 'ironvale', kind: 'incomeTax', count: 12, amount: 999_000 },
    ];
    const html = renderGovernmentSection(store, cityOf(store));

    expect(html).toContain('data-testid="fiscal-ledger"');
    expect(html).toContain('data-testid="fiscal-ledger-window-note"');
    expect(html).toContain(`最近 ${DEMO_CONFIG.history.fiscalDetailMonths} 个月逐笔明细`);
    expect(html).toContain('已按 城市×年×科目 归档为年度汇总');
    // 年度汇总与逐笔明细区分：独立折叠区块 + “非逐笔”标题。
    expect(html).toContain('data-testid="fiscal-annual-archive"');
    expect(html).toContain('财政年度汇总（非逐笔）');
    expect(html).toContain('data-testid="fiscal-annual-archive-table"');
    expect(html).toContain('2024 年');
    expect(html).toContain(money(1_200_000));
    expect(html).toContain(money(800_000));
    expect(html).toContain('+40.0 万'); // 净额 = 120 万收入 − 80 万支出
    expect(html).not.toContain('2023 年');
    expect(html).not.toContain(money(999_000));
  });

  it('财政归档仅市长可见：非市长面板不含归档区块与金额', () => {
    const store = createStore();
    store.world.player.roles.mayorCityId = null;
    store.world.fiscal.archivedLedger = [
      { year: 2024, cityId: 'lanport', kind: 'incomeTax', count: 12, amount: 1_200_000 },
    ];
    const html = renderGovernmentSection(store, cityOf(store));
    expect(html).toContain('data-testid="fiscal-restricted"');
    expect(html).not.toContain('data-testid="fiscal-annual-archive"');
    expect(html).not.toContain('data-testid="fiscal-ledger-window-note"');
    expect(html).not.toContain(money(1_200_000));
  });

  it('债券兑付：标注明细窗口，并展示全部批次的年度兑付汇总（不含持有人与垫付金额）', () => {
    const store = createStore();
    store.world.bonds = {
      ...store.world.bonds!,
      archivedPayments: [
        {
          year: 2024,
          issuanceId: 'bond-lanport-1',
          cityId: 'lanport',
          holderKind: 'player',
          holderId: 'player',
          kind: 'coupon',
          count: 3,
          principalPaid: 0,
          interestPaid: 30_000,
          bankAdvancedCount: 1,
          bankAdvancedAmount: 10_000,
        },
        {
          year: 2024,
          issuanceId: 'bond-ironvale-1',
          cityId: 'ironvale',
          holderKind: 'company',
          holderId: 'iv-food',
          kind: 'principal',
          count: 1,
          principalPaid: 500_000,
          interestPaid: 0,
          bankAdvancedCount: 0,
          bankAdvancedAmount: 0,
        },
        {
          // 破产处置兑付（银行垫付）属市长财政口径，公开汇总必须排除。
          year: 2024,
          issuanceId: 'bond-lanport-2',
          cityId: 'lanport',
          holderKind: 'player',
          holderId: 'player',
          kind: 'bankruptcyRedemption',
          count: 1,
          principalPaid: 777_000,
          interestPaid: 7_000,
          bankAdvancedCount: 1,
          bankAdvancedAmount: 777_000,
        },
      ],
    };
    const html = renderBondMarketSection(store);
    expect(html).toContain('data-testid="bond-payment-window-note"');
    expect(html).toContain(`最近 ${DEMO_CONFIG.history.bondPaymentDetailMonths} 个月`);
    expect(html).toContain('data-testid="bond-payment-annual-archive"');
    expect(html).toContain('债券兑付年度汇总（非逐笔）');
    expect(html).toContain('2024 年');
    expect(html).toContain(money(500_000));
    expect(html).toContain(money(30_000));
    // 破产处置兑付不计入公开年度汇总。
    expect(html).not.toContain(money(777_000));
    expect(html).not.toContain(money(7_000));
    // 汇总不等于逐笔：不展示具体持有人 id，也不展示破产垫付金额。
    expect(html).not.toContain('iv-food');
    expect(html).not.toContain(money(10_000));
  });

  it('治理议案：标注 12 个月明细窗口，并按公司展示年度议案统计', () => {
    const store = createStore();
    const company = store.world.companies.find((entry) => entry.id === 'lp-food')!;
    store.world.governance.motionYears = [
      {
        year: 2023,
        companyId: 'lp-food',
        companyName: '蓝港食品',
        kind: 'dividendPolicy',
        count: 4,
        passed: 3,
        rejected: 1,
        votesFor: 900_000,
        votesAgainst: 100_000,
        decidedFirstTick: 1,
        decidedLastTick: 12,
      },
      {
        year: 2022,
        companyId: 'other-company',
        companyName: '他企',
        kind: 'operatorAppointment',
        count: 2,
        passed: 2,
        rejected: 0,
        votesFor: 0,
        votesAgainst: 0,
        decidedFirstTick: 1,
        decidedLastTick: 2,
      },
    ];
    const html = renderCompanyDetail(store, company, { showClose: false, investTestId: false });
    expect(html).toContain('data-testid="motion-window-note"');
    expect(html).toContain(`最近 ${DEMO_CONFIG.history.governanceArchiveMonths} 个月已结束议案`);
    expect(html).toContain('data-testid="motion-annual-archive"');
    expect(html).toContain('议案年度汇总（非逐笔）');
    expect(html).toContain('2023 年');
    expect(html).toContain('分红政策');
    expect(html).not.toContain('2022 年'); // 他企归档不进入本公司面板
  });

  it('银行/居民贷款：标注 36 个月结清明细窗口，银行贷款仅汇总笔数、居民贷按本城聚合', () => {
    const store = createStore();
    const city = cityOf(store);
    store.world.banking.archivedLoans = [
      {
        year: 2023,
        borrowerKind: 'company',
        purpose: 'workingCapital',
        status: 'repaid',
        count: 5,
        principal: 4_321_000,
        paidPrincipal: 4_321_000,
        paidInterest: 120_000,
      },
    ];
    store.world.householdFinance.archivedLoans = [
      {
        year: 2023,
        cityId: 'lanport',
        status: 'repaid',
        count: 3,
        principal: 300_000,
        paidPrincipal: 300_000,
        paidInterest: 9_000,
      },
      {
        year: 2023,
        cityId: 'ironvale',
        status: 'repaid',
        count: 9,
        principal: 900_000,
        paidPrincipal: 900_000,
        paidInterest: 27_000,
      },
    ];
    const html = renderBankSection(store, city);
    expect(html).toContain('data-testid="bank-loan-window-note"');
    expect(html).toContain(`最近 ${DEMO_CONFIG.history.closedLoanArchiveMonths} 个月结清贷款`);
    expect(html).toContain('data-testid="bank-loan-annual-archive"');
    expect(html).toContain('结清贷款年度汇总（非逐笔）');
    expect(html).toContain('data-testid="bank-loan-annual-archive-table"');
    expect(html).toContain('data-testid="household-loan-annual-archive-table"');
    // 银行贷款汇总只列笔数（不泄露单个主体金额）；居民消费贷按本城聚合（不含他城 9 笔）。
    expect(html).toContain(`居民消费贷（${city.name}）`);
    expect(html).toContain(money(300_000));
    expect(html).not.toContain(money(900_000));
    expect(html).not.toContain(money(4_321_000));
  });

  it('股票 K 线：标注 120 个月月线窗口，并展示年度 OHLCV 归档（来自 store 投影）', () => {
    const store = createStore();
    const history = store.world.securities.history[0];
    if (!history) throw new Error('前置失败：默认种子缺少股票历史');
    history.yearlyCandles = [
      {
        year: 2023,
        open: 10,
        high: 15,
        low: 9,
        close: 14,
        volume: 12_000,
        trades: 48,
        months: 6,
        firstTick: 1,
        lastTick: 6,
      },
    ];
    store.openStockMarket(history.companyId, history.kind);
    const view = store.stockMarketView();
    const selected = view.selected!;
    expect(selected.yearlyCandles).toHaveLength(1);
    expect(selected.yearlyCandles![0]!.year).toBe(2023);

    const html = renderStockWindow(view);
    expect(html).toContain('data-testid="stock-kline-window-note"');
    expect(html).toContain(`最近 ${DEMO_CONFIG.securities.historyMonths} 个月逐月成交明细`);
    expect(html).toContain('data-testid="stock-yearly-archive"');
    expect(html).toContain('年度 OHLCV 汇总（非逐笔）');
    expect(html).toContain('data-testid="stock-yearly-archive-table"');
    expect(html).toContain('2023 年');
  });

  it('无归档数据时不伪造：年度区块显示真实空状态', () => {
    const store = createStore();
    const company = store.world.companies.find((entry) => entry.id === 'lp-food')!;
    const html = renderCompanyDetail(store, company, { showClose: false, investTestId: false });
    expect(html).toContain('data-testid="motion-annual-archive"');
    expect(html).toContain('data-testid="motion-annual-archive-table-empty"');
    expect(html).toContain('暂无已归档的议案年度统计');
  });
});
