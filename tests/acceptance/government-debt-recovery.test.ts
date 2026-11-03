// v0.7 验收问题 4/7：政府贷款按实际未偿本金计息；AI 发债闸门与破产后恢复融资。
// 口径见 docs/development/DESIGN_government_bonds_debt_fixes_v0.7.md §2/§3。
import { describe, expect, it } from 'vitest';
import { DEMO_CONFIG, type DemoConfig } from '../../src/data/config';
import type {
  BondIssuance,
  GovernmentLoanContract,
  LoanPayment,
  WorldState,
} from '../../src/simulation/contracts/types';
import {
  closeGovernmentBondSubscription,
  issueGovernmentBond,
  subscribeGovernmentBond,
} from '../../src/simulation/government/bonds';
import {
  borrowForGovernment,
  governmentLoanAccrual,
  maybeAutoIssueGovernmentBond,
  settleCityGovernmentDebt,
  settleGovernmentDebt,
} from '../../src/simulation/government/debt';
import { cityPolitics } from '../../src/simulation/politics/politics';
import { cityById, newWorld } from './helpers';

const CONFIG = DEMO_CONFIG;
const NO_AI = {
  ...CONFIG,
  government: {
    ...CONFIG.government,
    aiGovernment: { ...CONFIG.government.aiGovernment, enabled: false },
  },
} as unknown as DemoConfig;

/** 构造政府贷款合同（纯函数计息测试用）。 */
function makeLoan(overrides: Partial<GovernmentLoanContract> = {}): GovernmentLoanContract {
  return {
    id: 'govloan-test-1',
    cityId: 'lanport',
    purpose: 'government',
    principal: 24_000,
    outstanding: 24_000,
    monthlyPrincipal: 1_000,
    rateMonthly: 0.005,
    termMonths: 24,
    startTick: 0,
    nextDueTick: 1,
    paidPrincipal: 0,
    paidInterest: 0,
    accruedInterest: 0,
    arrearsPrincipal: 0,
    arrearsInterest: 0,
    missedPayments: 0,
    status: 'active',
    payments: [],
    bondIssuanceId: null,
    note: '',
    ...overrides,
  };
}

function payment(tick: number, principalPaid: number, principalDue = 1_000): LoanPayment {
  return {
    tick,
    principalDue,
    interestDue: 0,
    principalPaid,
    interestPaid: 0,
    arrears: 0,
    note: '',
  };
}

/** 把判定窗口压到 12×monthly，让少量债务即可触发 100% 破产（与既有验收测试同口径）。 */
function setGdpWindow(world: WorldState, cityId: string, monthly: number): void {
  const city = cityById(world, cityId);
  city.gdpWindow = Array.from({ length: 12 }, (_, index) => ({
    tick: -12 + index,
    value: monthly,
    estimated: true,
  }));
}

function mainCity(world: WorldState) {
  return cityById(world, 'lanport');
}

describe('问题4：政府贷款按实际未偿本金逐月计息（纯函数）', () => {
  it('首月未还本金时，第 2 月仍按 24000 计息 120（旧口径 115）', () => {
    const loan = makeLoan({ payments: [payment(1, 0)] });
    const accrual = governmentLoanAccrual(loan, 2);
    expect(accrual.elapsedMonths).toBe(2);
    expect(accrual.currentMonthInterest).toBeCloseTo(120, 2);
    expect(accrual.cumulativeInterest).toBeCloseTo(240, 2);
    // 纯函数幂等。
    expect(governmentLoanAccrual(loan, 2)).toEqual(accrual);
  });

  it('部分还款后按剩余实际本金计息；累计利息不重复', () => {
    const loan = makeLoan({
      outstanding: 19_000,
      paidPrincipal: 5_000,
      payments: [payment(1, 5_000)],
    });
    const accrual = governmentLoanAccrual(loan, 2);
    expect(accrual.currentMonthInterest).toBeCloseTo(95, 2); // 19000 × 0.5%
    expect(accrual.cumulativeInterest).toBeCloseTo(215, 2); // 120 + 95
    expect(accrual.unpaidInterest).toBeCloseTo(215, 2);
  });

  it('提前还款降低后续计息本金；结清后不再计息', () => {
    // 第 1 月提前还 18000，剩余 6000：第 2 月按 6000 计息 30。
    const partial = makeLoan({
      outstanding: 6_000,
      paidPrincipal: 18_000,
      payments: [payment(1, 18_000)],
    });
    expect(governmentLoanAccrual(partial, 2).currentMonthInterest).toBeCloseTo(30, 2);
    expect(governmentLoanAccrual(partial, 2).cumulativeInterest).toBeCloseTo(150, 2);

    // 第 1 月结清全部本金：后续月份利息为 0。
    const settled = makeLoan({
      outstanding: 0,
      paidPrincipal: 24_000,
      status: 'repaid',
      payments: [payment(1, 24_000)],
    });
    expect(governmentLoanAccrual(settled, 2).currentMonthInterest).toBe(0);
    expect(governmentLoanAccrual(settled, 5).currentMonthInterest).toBe(0);
    expect(governmentLoanAccrual(settled, 5).cumulativeInterest).toBeCloseTo(120, 2);
  });

  it('超期未结清不封顶：第 30 个月仍按实际未偿 6600 计息 33', () => {
    const payments = Array.from({ length: 29 }, (_, index) => payment(index + 1, 600));
    const loan = makeLoan({
      outstanding: 6_600,
      paidPrincipal: 17_400,
      termMonths: 24,
      payments,
    });
    const accrual = governmentLoanAccrual(loan, 30);
    expect(accrual.elapsedMonths).toBe(30); // 不封顶于 termMonths
    expect(accrual.currentMonthInterest).toBeCloseTo(33, 2);
  });
});

describe('问题4：月结逾期/欠付/重复结算（真实结算路径）', () => {
  it('财政不足连续两月：利息按实际未偿 24000 计，欠息累计 240、本金欠付 2000 不被抹掉', () => {
    const world = newWorld(0);
    const city = mainCity(world);
    expect(borrowForGovernment(world, city, CONFIG, 24_000, 0, []).ok).toBe(true);
    city.treasury = 0;

    world.time.tick = 1;
    settleCityGovernmentDebt(world, city, NO_AI, []);
    const loan = city.government!.loans.find((entry) => entry.purpose === 'government')!;
    expect(loan.payments).toHaveLength(1);
    expect(loan.payments[0]!.principalPaid).toBe(0);
    expect(loan.accruedInterest).toBe(0); // 本月息转入欠息
    expect(loan.arrearsInterest).toBeCloseTo(120, 2);
    expect(loan.arrearsPrincipal).toBeCloseTo(1_000, 2);
    expect(loan.outstanding).toBeCloseTo(24_000, 2);
    expect(loan.paidPrincipal).toBe(0);
    expect(loan.missedPayments).toBe(1);

    world.time.tick = 2;
    settleCityGovernmentDebt(world, city, NO_AI, []);
    expect(loan.payments).toHaveLength(2);
    // 第 2 月仍按实际未偿 24000 计息 120（不是按计划余额的 115），欠息累计 240。
    expect(loan.arrearsInterest).toBeCloseTo(240, 2);
    expect(loan.arrearsPrincipal).toBeCloseTo(2_000, 2);
    expect(loan.outstanding).toBeCloseTo(24_000, 2);
    expect(loan.paidPrincipal).toBe(0);
    expect(loan.missedPayments).toBe(2);

    // 同一 tick 重复结算：不重复计息、不重复追加还款记录。
    const paymentsBefore = loan.payments.length;
    settleCityGovernmentDebt(world, city, NO_AI, []);
    expect(loan.payments).toHaveLength(paymentsBefore);
    expect(loan.arrearsInterest).toBeCloseTo(240, 2);
    expect(governmentLoanAccrual(loan, 2)).toEqual(governmentLoanAccrual(loan, 2));
  });

  it('按期还款：第 1 月利息 60、第 2 月 57.5，本息按计划结清', () => {
    const world = newWorld(0);
    const city = mainCity(world);
    expect(borrowForGovernment(world, city, CONFIG, 12_000, 0, []).ok).toBe(true);

    world.time.tick = 1;
    settleCityGovernmentDebt(world, city, NO_AI, []);
    const loan = city.government!.loans.find((entry) => entry.purpose === 'government')!;
    expect(loan.paidInterest).toBeCloseTo(60, 2);
    expect(loan.paidPrincipal).toBeCloseTo(500, 2);
    expect(loan.outstanding).toBeCloseTo(11_500, 2);
    expect(loan.arrearsInterest).toBe(0);

    world.time.tick = 2;
    settleCityGovernmentDebt(world, city, NO_AI, []);
    // 第 2 月按实际未偿 11500 计息 57.5 并已付；累计已付利息 117.5。
    expect(loan.paidInterest).toBeCloseTo(117.5, 2);
    expect(loan.accruedInterest).toBe(0);
    expect(loan.paidPrincipal).toBeCloseTo(1_000, 2);
    expect(loan.outstanding).toBeCloseTo(11_000, 2);
  });
});

describe('问题7：AI 发债闸门（贷款分期不再永久阻断，债券到期仍禁借新还旧）', () => {
  it('破产前：政府贷款常规分期到期时默认仍可发起发行计划（只创建 offering）', () => {
    const world = newWorld(0);
    const city = mainCity(world);
    city.fiscalExpenseBaseline = 100_000;
    city.treasury = 0;
    expect(borrowForGovernment(world, city, CONFIG, 10_000, 0, []).ok).toBe(true);
    city.treasury = 0;
    world.time.tick = 1;
    const loan = city.government!.loans.find((entry) => entry.purpose === 'government')!;
    expect(loan.nextDueTick).toBe(1); // 本月确有贷款分期到期

    const result = maybeAutoIssueGovernmentBond(world, city, CONFIG, 1, []);
    expect(result.issued).toBe(true);
    const issuance = world.bonds!.issuances.find((entry) => entry.cityId === city.id)!;
    expect(issuance.status).toBe('offering');
    expect(issuance.soldUnits).toBe(0);
    expect(result.units).toBe(issuance.planUnits);
    expect(world.bonds!.holdings.filter((entry) => entry.issuanceId === issuance.id)).toHaveLength(0);
  });

  it('配置回退：blockIssuanceOnLoanInstalment=true 时贷款分期到期仍阻断（口径可复现）', () => {
    const world = newWorld(0);
    const city = mainCity(world);
    city.fiscalExpenseBaseline = 100_000;
    city.treasury = 0;
    expect(borrowForGovernment(world, city, CONFIG, 10_000, 0, []).ok).toBe(true);
    city.treasury = 0;
    world.time.tick = 1;
    const BLOCK_LOAN = {
      ...CONFIG,
      government: {
        ...CONFIG.government,
        aiGovernment: { ...CONFIG.government.aiGovernment, blockIssuanceOnLoanInstalment: true },
      },
    } as unknown as DemoConfig;
    expect(maybeAutoIssueGovernmentBond(world, city, BLOCK_LOAN, 1, [])).toEqual({
      issued: false,
      units: 0,
    });
  });

  it('债券到期本息当月默认禁借新还旧；关闭该闸门后可发（配置生效）', () => {
    const world = newWorld(0);
    const city = mainCity(world);
    city.fiscalExpenseBaseline = 100_000;
    city.treasury = 0;
    world.player.cash = 10_000;
    // 造一笔 36 月到期、tick 36 处于到期月的债券。
    const issued = issueBondAt(world, city, 10, 0);
    subscribeAll(world, issued.id, 0);
    closeSubscription(world, issued.id, 0);
    world.time.tick = 36;

    expect(maybeAutoIssueGovernmentBond(world, city, CONFIG, 36, [])).toEqual({
      issued: false,
      units: 0,
    });
    const ALLOW_BOND = {
      ...CONFIG,
      government: {
        ...CONFIG.government,
        aiGovernment: { ...CONFIG.government.aiGovernment, blockIssuanceOnBondService: false },
      },
    } as unknown as DemoConfig;
    expect(maybeAutoIssueGovernmentBond(world, city, ALLOW_BOND, 36, []).issued).toBe(true);
  });
});

describe('问题7：破产当月/看守期/重选后恢复融资', () => {
  it('破产当月不新发；解除破产后需完成重选才恢复；恢复后 AI 认购入账且不取消债务', () => {
    const world = newWorld(0);
    const city = mainCity(world);
    setGdpWindow(world, city.id, 100); // 12 月 GDP = 1200
    city.treasury = 0;
    expect(borrowForGovernment(world, city, NO_AI, 2_000, 0, []).ok).toBe(true);
    // 让重选无法进行 → 破产记录进入看守期。
    const politics = cityPolitics(world, city.id);
    expect(politics).toBeDefined();
    politics!.candidates = [];
    world.time.tick = 1;
    const bankrupted = settleCityGovernmentDebt(world, city, NO_AI, []);
    expect(bankrupted.bankrupted).toBe(true);
    const record = city.government!.records[city.government!.records.length - 1]!;
    expect(record.caretakerUntilElection).toBe(true);
    // 破产当月：即便在结算后也不发起新发行。
    expect(maybeAutoIssueGovernmentBond(world, city, CONFIG, 1, [])).toEqual({
      issued: false,
      units: 0,
    });

    // 下一月债务率回落后解除破产状态。
    world.time.tick = 2;
    settleCityGovernmentDebt(world, city, NO_AI, []);
    expect(city.government!.bankruptcy.status).toBe('solvent');
    city.treasury = 0;
    city.fiscalExpenseBaseline = 100_000;
    // 看守期且记录之后没有重选 → 不恢复发债。
    expect(maybeAutoIssueGovernmentBond(world, city, CONFIG, 2, [])).toEqual({
      issued: false,
      units: 0,
    });

    // 完成重选后恢复发债（发行只创建 offering）。先恢复判定 GDP，避免新增债务再次触发破产。
    setGdpWindow(world, city.id, 100_000);
    world.politics.elections.push({
      tick: 3,
      cityId: city.id,
      winnerId: 'candidate-test',
      winnerName: '测试候选人',
      playerWon: false,
      note: '看守期后重选',
    });
    city.treasury = 0;
    const recovered = maybeAutoIssueGovernmentBond(world, city, CONFIG, 3, []);
    expect(recovered.issued).toBe(true);
    const issuance = world.bonds!.issuances.find((entry) => entry.cityId === city.id)!;
    expect(issuance.status).toBe('offering');
    expect(issuance.issuedTick).toBe(3);

    // 下一次月结：窗口关闭、AI 用真实资金认购、资金进入财政；城市仍 solvent，持有者非玩家/非银行。
    world.time.tick = 4;
    const treasuryBefore = city.treasury;
    settleGovernmentDebt(world, CONFIG, []);
    expect(issuance.status).toBe('active');
    expect(issuance.closedTick).toBe(4);
    expect(issuance.soldUnits).toBeGreaterThan(0);
    expect(city.treasury).toBeCloseTo(treasuryBefore + issuance.soldUnits * issuance.faceValue, 2);
    expect(city.government!.bankruptcy.status).toBe('solvent');
    const holders = world.bonds!.holdings.filter((entry) => entry.issuanceId === issuance.id);
    expect(holders.length).toBeGreaterThan(0);
    expect(holders.every((entry) => entry.holder.kind === 'investorGroup' || entry.holder.kind === 'company')).toBe(true);
    expect(holders.some((entry) => entry.holder.kind === 'player')).toBe(false);
    // 不取消债务：新发行形成真实本金与持债。
    expect(issuance.principal).toBeCloseTo(issuance.soldUnits * issuance.faceValue, 2);
  });

  it('requireElectionAfterBankruptcy=false 时看守期无需重选即可恢复', () => {
    const world = newWorld(0);
    const city = mainCity(world);
    setGdpWindow(world, city.id, 100);
    city.treasury = 0;
    expect(borrowForGovernment(world, city, NO_AI, 2_000, 0, []).ok).toBe(true);
    cityPolitics(world, city.id)!.candidates = [];
    world.time.tick = 1;
    settleCityGovernmentDebt(world, city, NO_AI, []);
    world.time.tick = 2;
    settleCityGovernmentDebt(world, city, NO_AI, []);
    expect(city.government!.bankruptcy.status).toBe('solvent');
    city.treasury = 0;
    city.fiscalExpenseBaseline = 100_000;

    const RELAXED = {
      ...CONFIG,
      government: {
        ...CONFIG.government,
        aiGovernment: { ...CONFIG.government.aiGovernment, requireElectionAfterBankruptcy: false },
      },
    } as unknown as DemoConfig;
    expect(maybeAutoIssueGovernmentBond(world, city, RELAXED, 2, []).issued).toBe(true);
    // 默认口径仍需重选。
    const world2 = newWorld(0);
    const city2 = mainCity(world2);
    setGdpWindow(world2, city2.id, 100);
    city2.treasury = 0;
    borrowForGovernment(world2, city2, NO_AI, 2_000, 0, []);
    cityPolitics(world2, city2.id)!.candidates = [];
    world2.time.tick = 1;
    settleCityGovernmentDebt(world2, city2, NO_AI, []);
    world2.time.tick = 2;
    settleCityGovernmentDebt(world2, city2, NO_AI, []);
    city2.treasury = 0;
    city2.fiscalExpenseBaseline = 100_000;
    expect(maybeAutoIssueGovernmentBond(world2, city2, CONFIG, 2, [])).toEqual({
      issued: false,
      units: 0,
    });
  });

  it('破产门槛不被绕过：债务/GDP 已达上限时即使未破产也不新发', () => {
    const world = newWorld(0);
    const city = mainCity(world);
    setGdpWindow(world, city.id, 100); // GDP 1200
    city.fiscalExpenseBaseline = 100_000;
    city.treasury = 0;
    expect(borrowForGovernment(world, city, NO_AI, 2_000, 0, []).ok).toBe(true);
    city.treasury = 0;
    world.time.tick = 1;
    // 债务 2000 > 判定 GDP 1200 → 发债后债务率会超过 maxDebtRatioToIssue(100%)。
    expect(maybeAutoIssueGovernmentBond(world, city, CONFIG, 1, [])).toEqual({
      issued: false,
      units: 0,
    });
  });
});

// ---- 债券构造辅助（用于"债券到期当月"闸门测试） ----
function issueBondAt(world: WorldState, city: ReturnType<typeof mainCity>, units: number, tick: number): BondIssuance {
  const issued = issueGovernmentBond(world, city, CONFIG, units, tick);
  if (!issued.ok || !issued.issuance) throw new Error(issued.error ?? '发行失败');
  return issued.issuance;
}

function subscribeAll(world: WorldState, issuanceId: string, tick: number): void {
  const bought = subscribeGovernmentBond(
    world,
    CONFIG,
    issuanceId,
    { kind: 'player', id: 'player' },
    10,
    tick,
  );
  if (!bought.ok) throw new Error(bought.error ?? '认购失败');
}

function closeSubscription(world: WorldState, issuanceId: string, tick: number): void {
  closeGovernmentBondSubscription(world, CONFIG, issuanceId, tick);
}
