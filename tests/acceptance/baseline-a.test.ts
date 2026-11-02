// 验收 A 组追加：既有基线已知限制（AC-A05/A06/A07）。
// 期望值来源：数值岗归档 36 月基线（固定种子 20261101、玩家无操作、默认 AI）。
// 本文件只校验归档数据自身的阈值与自洽，不重跑 36 个月（重跑属数值岗职责，且耗时长）。
// 归档复制件：tests/acceptance/fixtures/economy-baseline-36m-v07.json
// 源：docs/development/reports/economy-baseline-36m-v07.json（data 分支 @391909e，sha256 前缀 dcbce239e2ff7947）。
import { describe, expect, it } from 'vitest';
import baseline from './fixtures/economy-baseline-36m-v07.json';

interface MonthlyRow {
  tick: number;
  world: {
    tick: number;
    bankInterestIncome: number;
    bankInterestExpense: number;
  };
}

const monthly = baseline.monthly as unknown as MonthlyRow[];
const banking = baseline.banking as {
  open: number;
  defaulted: number;
  outstanding: number;
  defaultedOutstanding: number;
  interestIncome: number;
  interestExpense: number;
};
const companiesTop = baseline.companiesTop as {
  name: string;
  cash: number;
  monthlyWage: number;
  profit: number;
  dividendsPaid: number;
}[];
const anomalies = baseline.anomalies as string[];

describe('A05 既有基线：企业倒闭清算银行实收 0（不判失败，交付报告列已知限制）', () => {
  it('归档记录：6 家倒闭企业债务全额减免合计 166,267,450，银行实收 0', () => {
    // 归档的期末未偿与违约未偿。
    expect(banking.outstanding).toBeCloseTo(415_320_142.29, 2);
    expect(banking.defaultedOutstanding).toBeCloseTo(240_675_751.26, 2);
    expect(banking.defaulted).toBe(123);

    // 清算减免合计（anomalies 文本与数值岗归档一致）。
    const forgiven = 166_267_450;
    const forgivenRatio = forgiven / banking.outstanding;
    expect(forgivenRatio).toBeGreaterThan(0.395);
    expect(forgivenRatio).toBeLessThan(0.405);
    const text = anomalies.join('\n');
    expect(text).toContain('166267450');
    expect(text).toContain('银行实收 0');
    expect(text).toContain('40.0%');
  });
});

describe('A06 既有基线：银行 36/36 个月利息收入 < 利息支出（块6 复核）', () => {
  it('逐月归档中利息收入均小于利息支出，M36 为 778,449.56 vs 1,878,615.19', () => {
    expect(monthly).toHaveLength(36);
    const negativeMonths = monthly.filter(
      (row) => row.world.bankInterestIncome < row.world.bankInterestExpense,
    );
    expect(negativeMonths).toHaveLength(36);

    const last = monthly[monthly.length - 1]!;
    expect(last.world.bankInterestIncome).toBeCloseTo(778_449.56, 2);
    expect(last.world.bankInterestExpense).toBeCloseTo(1_878_615.19, 2);
    // 期末快照与逐月序列同口径。
    expect(banking.interestIncome).toBeCloseTo(last.world.bankInterestIncome, 2);
    expect(banking.interestExpense).toBeCloseTo(last.world.bankInterestExpense, 2);
  });
});

describe('A07 既有基线：3 家企业利润基本全分红且现金 < 2 个月工资（观察项，影响 #23 可认购额度）', () => {
  const targets = [
    { name: '岚港纺织厂', cash: 3_032_595, wage: 5_023_200 },
    { name: '青原纤维农场', cash: 12_812_954, wage: 7_180_600 },
    { name: '青原食品加工厂', cash: 80_911_087, wage: 41_712_800 },
  ];

  it('归档企业现金均低于 2 个月工资，且多为“利润≈分红”', () => {
    for (const target of targets) {
      const company = companiesTop.find((entry) => entry.name === target.name);
      expect(company, `缺少企业：${target.name}`).toBeDefined();
      expect(company!.cash).toBeLessThan(2 * company!.monthlyWage);
      expect(company!.cash).toBeCloseTo(target.cash, 0);
      expect(company!.monthlyWage).toBeCloseTo(target.wage, 0);
    }
    // 数值岗把它列为异常观察项（若后续修复应同步更新归档与矩阵）。
    expect(anomalies.join('\n')).toContain('3 家企业利润基本全部分红且现金 < 2 个月工资');
  });

  it('该现象与 #23 企业购债流动性保留口径相关：现金不足 2 个月工资，但保留 1 个月后仍可能有额度', () => {
    // 保留额 = 上月实发工资 × wageMonths（归档中 wageMonths=1）。
    const wageMonths = (baseline.params as {
      government: { companyPurchaseReserve: { wageMonths: number } };
    }).government.companyPurchaseReserve.wageMonths;
    expect(wageMonths).toBe(1);
    for (const target of targets) {
      const available = target.cash - target.wage * wageMonths;
      // 3 家均现金 < 2 个月工资（观察项本身）。
      expect(target.cash).toBeLessThan(2 * target.wage);
      // 岚港纺织厂连 1 个月工资都不够 → 可认购额 0（#23 直接影响）。
      if (target.name === '岚港纺织厂') expect(available).toBeLessThan(0);
      else expect(available).toBeGreaterThan(0);
    }
  });
});
