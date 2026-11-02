// 验收复验：生产采购预算为零时，只要存在需求、可售供应与合法授信，
// 仍应在经营模式/授权允许的范围内借款并完成采购；无供应、未授权、
// 融资失败或玩家拒绝时，不得留下无关贷款或部分成交。
import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation/core/simulation';
import { DEMO_CONFIG } from '../src/data/config';
import type {
  Company,
  LogEntry,
  PlayerOperationMode,
  WorldState,
} from '../src/simulation/contracts/types';
import { round2 } from '../src/simulation/core/math';
import { bankLoansOf } from '../src/simulation/banking/credit';
import {
  createEmptyInventory,
  monthlyWageBill,
  setCompanyEmployees,
} from '../src/simulation/companies/company';
import { runInputPurchasing } from '../src/simulation/production/production';
import { createWorldLedgers } from '../src/simulation/markets/markets';
import {
  playerOperationFor,
  setOperationMode,
} from '../src/simulation/management/operations';

function newWorld(): WorldState {
  return Simulation.create().state;
}

function companyOf(world: WorldState, id: string): Company {
  const company = world.companies.find((entry) => entry.id === id);
  if (!company) throw new Error(`测试世界没有企业 ${id}`);
  return company;
}

/** 清空所有企业的利用率和库存，只留下测试指定的供应，避免随机库存干扰断言。 */
function isolateMarket(world: WorldState): void {
  for (const company of world.companies) {
    company.utilization = 0;
    company.inventory = createEmptyInventory();
  }
}

/** 把玩家设为该企业经营者，并设置经营模式。 */
function operate(world: WorldState, companyId: string, mode: PlayerOperationMode): void {
  const control = world.governance.controls.find((entry) => entry.companyId === companyId);
  if (!control) throw new Error('企业缺少治理控制记录');
  control.operator = { type: 'player', id: 'player' };
  control.basis = 'election';
  control.operatorId = null;
  control.termEndTick = null;
  const result = setOperationMode(world, companyId, mode, DEMO_CONFIG, 0);
  if (!result.ok) throw new Error(result.error);
}

function pendingLoanProposals(world: WorldState, companyId: string) {
  return (playerOperationFor(world, companyId)?.proposals ?? []).filter(
    (proposal) => proposal.kind === 'loan' && proposal.status === 'pending',
  );
}

/** 本地卖家的实际单价（市价 × 价格系数，与成交规则一致）。 */
function localUnitPrice(world: WorldState, cityId: string, goodId: 'grain' | 'energy', sellerId: string) {
  const city = world.cities.find((entry) => entry.id === cityId);
  const seller = companyOf(world, sellerId);
  if (!city) throw new Error(`测试世界没有城市 ${cityId}`);
  return round2((city.market[goodId]?.price ?? 0) * seller.priceFactor);
}

/** 让岚港的食品厂处于可生产、但零现金的状态，并在本城准备少量谷物与能源。 */
function zeroCashBuyer(supply = 10) {
  const world = newWorld();
  isolateMarket(world);
  const buyer = companyOf(world, 'lp-food');
  const grainSeller = companyOf(world, 'lp-garment');
  const energySeller = companyOf(world, 'lp-energy');
  buyer.utilization = DEMO_CONFIG.company.initialUtilization;
  setCompanyEmployees(buyer, 3);
  buyer.cash = 0;
  buyer.debt = 0;
  grainSeller.inventory.grain = supply;
  energySeller.inventory.energy = supply;
  return { world, buyer, grainSeller, energySeller };
}

describe('采购预算为零时的融资采购（验收复验）', () => {
  it('零现金、有授信、有本地供应：自动借款并完成采购，贷款金额与采购支出对账', () => {
    const { world, buyer, grainSeller, energySeller } = zeroCashBuyer(10);
    const grainUnit = localUnitPrice(world, 'lanport', 'grain', grainSeller.id);
    const energyUnit = localUnitPrice(world, 'lanport', 'energy', energySeller.id);

    runInputPurchasing(world, createWorldLedgers(world), DEMO_CONFIG, []);

    const grainBought = buyer.inventory.grain ?? 0;
    const energyBought = buyer.inventory.energy ?? 0;
    expect(grainBought).toBeGreaterThan(0);
    expect(energyBought).toBeGreaterThan(0);

    const expectedSpend = round2(grainBought * grainUnit + energyBought * energyUnit);
    expect(buyer.debt).toBeCloseTo(expectedSpend, 2);
    // 借款全部用于成交：没有多余现金，也没有留下无关贷款。
    expect(buyer.cash).toBeCloseTo(0, 2);
    const loans = bankLoansOf(world);
    expect(loans.length).toBeGreaterThan(0);
    expect(loans.every((loan) => loan.startTick === 0 && loan.nextDueTick === 1)).toBe(true);
  });

  it('工资预留把采购预算压到零时，仍可融资采购（预算来自现金扣除预留后的余额）', () => {
    const { world, buyer, grainSeller, energySeller } = zeroCashBuyer(10);
    const wage = monthlyWageBill(buyer, DEMO_CONFIG);
    // wageReserve = 月工资 × wageReserveMonths(1) × 0.5 = 0.5 × 月工资 → 采购预算恰好为 0。
    buyer.cash = round2(wage * 0.5);
    const grainUnit = localUnitPrice(world, 'lanport', 'grain', grainSeller.id);
    const energyUnit = localUnitPrice(world, 'lanport', 'energy', energySeller.id);

    runInputPurchasing(world, createWorldLedgers(world), DEMO_CONFIG, []);

    const grainBought = buyer.inventory.grain ?? 0;
    const energyBought = buyer.inventory.energy ?? 0;
    expect(grainBought).toBeGreaterThan(0);
    expect(energyBought).toBeGreaterThan(0);
    const expectedSpend = round2(grainBought * grainUnit + energyBought * energyUnit);
    // 采购预算为 0：全部采购由贷款支付，工资预留现金保持不动。
    expect(buyer.debt).toBeCloseTo(expectedSpend, 2);
    expect(buyer.cash).toBeCloseTo(round2(wage * 0.5), 2);
  });

  it('没有任何可售供应：不借款、不成交、现金与债务都不变', () => {
    const world = newWorld();
    isolateMarket(world);
    const buyer = companyOf(world, 'lp-food');
    buyer.utilization = DEMO_CONFIG.company.initialUtilization;
    setCompanyEmployees(buyer, 3);
    buyer.cash = 0;
    buyer.debt = 0;

    runInputPurchasing(world, createWorldLedgers(world), DEMO_CONFIG, []);

    expect(buyer.debt).toBe(0);
    expect(buyer.cash).toBe(0);
    expect(bankLoansOf(world)).toHaveLength(0);
    expect(buyer.inventory.grain ?? 0).toBe(0);
    expect(buyer.inventory.energy ?? 0).toBe(0);
  });

  it('玩家全面手动模式：即使有供应和授信也不自动举债，采购受限并给出说明', () => {
    const { world, buyer } = zeroCashBuyer(10);
    operate(world, buyer.id, 'manual');
    const logs: LogEntry[] = [];

    runInputPurchasing(world, createWorldLedgers(world), DEMO_CONFIG, logs);

    expect(buyer.debt).toBe(0);
    expect(bankLoansOf(world)).toHaveLength(0);
    expect(pendingLoanProposals(world, buyer.id)).toHaveLength(0);
    expect(buyer.inventory.grain ?? 0).toBe(0);
    expect(buyer.inventory.energy ?? 0).toBe(0);
    expect(logs.some((entry) => entry.message.includes('手动'))).toBe(true);
  });

  it('玩家授权后：按实际可成交金额自动借款采购，不超额借款、不留待批准提案', () => {
    const { world, buyer, grainSeller, energySeller } = zeroCashBuyer(10);
    operate(world, buyer.id, 'assisted');
    const grainUnit = localUnitPrice(world, 'lanport', 'grain', grainSeller.id);
    const energyUnit = localUnitPrice(world, 'lanport', 'energy', energySeller.id);

    runInputPurchasing(world, createWorldLedgers(world), DEMO_CONFIG, []);

    const grainBought = buyer.inventory.grain ?? 0;
    const energyBought = buyer.inventory.energy ?? 0;
    expect(grainBought).toBeGreaterThan(0);
    expect(energyBought).toBeGreaterThan(0);
    const expectedSpend = round2(grainBought * grainUnit + energyBought * energyUnit);
    // 授权额度内直接放款：金额等于实际成交支出，不因“估算整批需求”而超额借款。
    expect(buyer.debt).toBeCloseTo(expectedSpend, 2);
    expect(buyer.cash).toBeCloseTo(0, 2);
    expect(bankLoansOf(world).length).toBeGreaterThan(0);
    expect(pendingLoanProposals(world, buyer.id)).toHaveLength(0);
  });
});
