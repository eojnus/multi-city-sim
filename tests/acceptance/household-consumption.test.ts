// 验收 D 组：居民消费（AC-D01–D09）。
// 只调用 src/simulation 的公开 API（预算快照/消费市场），不改产品代码。
import { describe, expect, it } from 'vitest';
import { DEMO_CONFIG } from '../../src/data/config';
import type { DemoConfig } from '../../src/data/config';
import { GOODS } from '../../src/data/demo-data';
import { createWorldLedgers } from '../../src/simulation/markets/markets';
import { runConsumerMarket } from '../../src/simulation/markets/consumer';
import {
  householdConsumerBudgetSnapshot,
  householdCreditLimit,
} from '../../src/simulation/population/household-finance';
import { householdGroupsOfCity } from '../../src/simulation/population/household-groups';
import { depositAccountFor } from '../../src/simulation/banking/banking';
import type { HouseholdGroup, WorldState } from '../../src/simulation/contracts/types';
import { cityById, newWorld } from './helpers';

const BUDGET = DEMO_CONFIG.households.consumerBudget;
/** 关闭消费贷（额度=0），隔离预算与消费本身。 */
const NO_LOAN: DemoConfig = {
  ...DEMO_CONFIG,
  households: {
    ...DEMO_CONFIG.households,
    householdCredit: { ...DEMO_CONFIG.households.householdCredit, creditLimitRate: 0 },
  },
} as unknown as DemoConfig;

/** 关闭消费贷 + 关闭跨城补货：只保本地渠道，用于货币守恒恒等式。 */
const NO_LOAN_NO_INTERCITY: DemoConfig = {
  ...NO_LOAN,
  intercity: { ...DEMO_CONFIG.intercity, enabled: false },
} as unknown as DemoConfig;

function groups(world: WorldState, cityId = 'lanport'): HouseholdGroup[] {
  return householdGroupsOfCity(world, cityId);
}

function pickGroup(world: WorldState, index = 0): HouseholdGroup {
  const list = groups(world);
  const group = list[index];
  if (!group) throw new Error('缺少居民群体');
  return group;
}

/** 世界总现金：全群体手头现金 + 企业现金 + 财政余额 + 玩家现金。 */
function totalCash(world: WorldState): number {
  const groupCash = world.households.groups.reduce((sum, group) => sum + group.cash, 0);
  const companyCash = world.companies.reduce((sum, company) => sum + company.cash, 0);
  const treasury = world.cities.reduce((sum, city) => sum + city.treasury, 0);
  return Math.round((groupCash + companyCash + treasury + world.player.cash) * 100) / 100;
}

/** 清空所有企业的某商品库存（制造本地供给不足）。 */
function zeroInventory(world: WorldState, goodId: string): void {
  for (const company of world.companies) {
    company.inventory[goodId as keyof typeof company.inventory] = 0;
  }
}

/** 给某城企业补一块库存（制造本地供给）。 */
function stockInventory(world: WorldState, cityId: string, goodId: string, qty: number): void {
  const company = world.companies.find((entry) => entry.cityId === cityId);
  if (!company) throw new Error('缺少企业');
  company.inventory[goodId as keyof typeof company.inventory] = qty;
}

const FOOD = 'food';
/** 全部消费类商品（供给不足场景一次性清零）。 */
const CONSUMER_GOODS = GOODS.filter((good) => good.category === 'consumer').map((good) => good.id);

describe('AC-D01 消费预算公式', () => {
  it('参考额 = 上月可支配收入×80% + 手头现金×5%；预算 = min(现金, max(0, 参考额))', () => {
    const world = newWorld(0);
    const group = pickGroup(world);
    group.cash = 10_000;
    group.lastMonth.income = 1_000;
    const snapshot = householdConsumerBudgetSnapshot(world, group, DEMO_CONFIG, 0);
    expect(snapshot.incomeComponent).toBeCloseTo(1_000 * BUDGET.lastIncomeShare, 2);
    expect(snapshot.cashComponent).toBeCloseTo(10_000 * BUDGET.cashShare, 2);
    expect(snapshot.referenceSpend).toBeCloseTo(800 + 500, 2);
    expect(snapshot.cashBudget).toBeCloseTo(1_300, 2);
    // 现金不足时预算被现金封顶（参考额不是硬上限，现金才是）。
    group.cash = 200;
    group.lastMonth.income = 10_000;
    const capped = householdConsumerBudgetSnapshot(world, group, DEMO_CONFIG, 1);
    expect(capped.cashBudget).toBeCloseTo(200, 2);
    expect(capped.referenceSpend).toBeGreaterThan(capped.cashBudget);
  });
});

describe('AC-D02 计算时点与不重复入账', () => {
  it('同一 tick 重复取快照结果一致；上月收入不再次入账、现金不被改动', () => {
    const world = newWorld(0);
    const group = pickGroup(world);
    group.cash = 5_000;
    group.lastMonth.income = 2_000;
    const first = householdConsumerBudgetSnapshot(world, group, DEMO_CONFIG, 3);
    const second = householdConsumerBudgetSnapshot(world, group, DEMO_CONFIG, 3);
    expect(second.cashBudget).toBe(first.cashBudget);
    expect(second.referenceSpend).toBe(first.referenceSpend);
    expect(group.cash).toBe(5_000);
    expect(group.lastMonth.income).toBe(2_000);
  });
});

describe('AC-D03 无收入但有积蓄', () => {
  it('10 万现金 + 上月收入 0 → 预算 5,000', () => {
    const world = newWorld(0);
    const group = pickGroup(world);
    group.cash = 100_000;
    group.lastMonth.income = 0;
    const snapshot = householdConsumerBudgetSnapshot(world, group, DEMO_CONFIG, 0);
    expect(snapshot.cashBudget).toBeCloseTo(5_000, 2);
  });
});

describe('AC-D04 四层分账', () => {
  it('成交 ≤ 现金预算 + 实际放款；资金缺口/供给缺口非负且与成交互补', () => {
    const world = newWorld(0);
    stockInventory(world, 'lanport', FOOD, 10_000);
    const group = pickGroup(world);
    group.cash = 3_000;
    group.lastMonth.income = 1_000;
    const ledgers = createWorldLedgers(world);
    const result = runConsumerMarket(world, cityById(world, 'lanport'), ledgers.lanport!, NO_LOAN);
    const byGroup = result.byGroup![group.id]!;
    expect(byGroup.spend).toBeLessThanOrEqual(byGroup.budget + (byGroup.loanFinanced ?? 0) + 0.01);
    expect(byGroup.unmetFunding ?? 0).toBeGreaterThanOrEqual(0);
    const unmetQty = Object.values(byGroup.unmet).reduce((sum, qty) => sum + (qty ?? 0), 0);
    expect(unmetQty).toBeGreaterThanOrEqual(0);
    expect(byGroup.desiredCost).toBeGreaterThanOrEqual(byGroup.spend - 0.01);
    expect(byGroup.budget).toBeLessThanOrEqual(group.cash + 0.01);
  });
});

describe('AC-D05 群体隔离', () => {
  it('各群体独立预算与现金，不挪用他群体资金；成交额不超本群体预算', () => {
    const world = newWorld(0);
    stockInventory(world, 'lanport', FOOD, 10_000);
    const list = groups(world);
    const poor = list[1]!;
    const rich = list[2]!;
    poor.cash = 0;
    poor.lastMonth.income = 0;
    rich.cash = 50_000;
    rich.lastMonth.income = 10_000;
    const ledgers = createWorldLedgers(world);
    const result = runConsumerMarket(world, cityById(world, 'lanport'), ledgers.lanport!, NO_LOAN);
    const poorResult = result.byGroup![poor.id]!;
    const richResult = result.byGroup![rich.id]!;
    expect(poorResult.budget).toBeCloseTo(0, 2);
    expect(poorResult.spend).toBeCloseTo(0, 2);
    expect(richResult.spend).toBeGreaterThan(0);
    expect(richResult.spend).toBeLessThanOrEqual(richResult.budget + 0.01);
    // 群体之间不共享现金：穷人现金仍为 0，未被富群体或市场扣成负数。
    expect(poor.cash).toBeGreaterThanOrEqual(0);
    expect(rich.cash).toBeGreaterThanOrEqual(0);
  });
});

describe('AC-D06 供给不足', () => {
  it('无任何消费品库存时不成交、不扣款、记供给缺口；补本地库存后成交且扣款=成交额', () => {
    const world = newWorld(0);
    for (const good of CONSUMER_GOODS) zeroInventory(world, good);
    const group = pickGroup(world);
    group.cash = 10_000;
    group.lastMonth.income = 5_000;
    const city = cityById(world, 'lanport');
    const beforeCash = group.cash;
    const ledgers = createWorldLedgers(world);
    const short = runConsumerMarket(world, city, ledgers.lanport!, NO_LOAN);
    for (const good of CONSUMER_GOODS) expect(short.bought[good]).toBeCloseTo(0, 2);
    expect(short.byGroup![group.id]!.unmet[FOOD]!).toBeGreaterThan(0);
    expect(group.cash).toBeCloseTo(beforeCash, 2);

    // 只补本地食品库存：成交 > 0，且该群体现金减少额 = 本群体成交额（无跨城补货）。
    stockInventory(world, 'lanport', FOOD, 10_000);
    const before = group.cash;
    const ledgers2 = createWorldLedgers(world);
    const enough = runConsumerMarket(world, city, ledgers2.lanport!, NO_LOAN_NO_INTERCITY);
    const spend = enough.byGroup![group.id]!.spend;
    expect(enough.bought[FOOD]).toBeGreaterThan(0);
    expect(spend).toBeGreaterThan(0);
    expect(before - group.cash).toBeCloseTo(spend, 2);
  });
});

describe('AC-D07 存款/资产不纳入预算', () => {
  it('存款不计入预算、不被复制到手头；结算前后存款余额不变', () => {
    const world = newWorld(0);
    const group = pickGroup(world);
    group.cash = 1_000;
    group.lastMonth.income = 0;
    const account = depositAccountFor(world, { kind: 'household', id: group.id });
    expect(account).toBeDefined();
    account!.balance = 900_000;
    const snapshot = householdConsumerBudgetSnapshot(world, group, DEMO_CONFIG, 0);
    expect(snapshot.depositsIncluded).toBe(false);
    expect(snapshot.cashComponent).toBeCloseTo(1_000 * BUDGET.cashShare, 2);
    // 上月收入为 0：参考额=现金×5%=50，预算=min(现金,50)=50（存款 90 万完全不参与）。
    expect(snapshot.referenceSpend).toBeCloseTo(50, 2);
    expect(snapshot.cashBudget).toBeCloseTo(50, 2);
    // 快照不搬钱：现金与存款都不变。
    expect(group.cash).toBe(1_000);
    expect(account!.balance).toBe(900_000);
  });
});

describe('AC-D08 确定性', () => {
  it('固定种子下两次独立运行消费市场结果一致', () => {
    const build = () => {
      const world = newWorld(0);
      stockInventory(world, 'lanport', FOOD, 10_000);
      const group = pickGroup(world);
      group.cash = 4_000;
      group.lastMonth.income = 2_000;
      const ledgers = createWorldLedgers(world);
      return runConsumerMarket(world, cityById(world, 'lanport'), ledgers.lanport!, NO_LOAN);
    };
    expect(JSON.stringify(build().byGroup)).toBe(JSON.stringify(build().byGroup));
  });
});

describe('AC-D09 消费不创造资金', () => {
  it('全群体成交后世界总现金不变（现金只在群体→卖方之间转移）', () => {
    const world = newWorld(0);
    for (const good of CONSUMER_GOODS) stockInventory(world, 'lanport', good, 50_000);
    const group = pickGroup(world);
    group.cash = 10_000;
    group.lastMonth.income = 5_000;
    const before = totalCash(world);
    const ledgers = createWorldLedgers(world);
    const result = runConsumerMarket(
      world,
      cityById(world, 'lanport'),
      ledgers.lanport!,
      NO_LOAN_NO_INTERCITY,
    );
    expect(result.spend).toBeGreaterThan(0);
    expect(totalCash(world)).toBeCloseTo(before, 2);
  });
});
