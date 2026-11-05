// v1.3 §4：月内分阶段“采购 → 生产”（固定轮次）的行为测试。
//
// 旧时序：计划 → 采购（只能买月初库存）→ 生产 → 消费市场。本月生产的原料要等
// 下个月才可能被下游采购，于是“本月原料缺口”和“本月新产出留作期末库存”同时出现。
//
// 新时序：同一 tick 内固定执行两轮 runInputPurchasing + runProduction：
// - 第 1 轮用月初库存采购并生产；
// - 第 2 轮把第 1 轮刚产出的原料重新投入市场成交，再完成本月剩余计划的生产。
// 月度计划/设备/劳动按“剩余量”分摊到各轮，两轮合计不超过月度上限；
// 需求只在第 1 轮记账，第 2 轮成交冲减已记的 unmetDemand，因此不会重复计需求。
import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation/core/simulation';
import { DEMO_CONFIG } from '../src/data/config';
import type { DemoConfig } from '../src/data/config';
import type {
  Company,
  CompanyProductionPlan,
  ProductionRecord,
  WorldState,
} from '../src/simulation/contracts/types';
import { round2 } from '../src/simulation/core/math';
import {
  createEmptyInventory,
  setCompanyEmployees,
} from '../src/simulation/companies/company';
import { emptyInventoryCost } from '../src/simulation/finance/inventory-cost';
import { runInputPurchasing, runProduction } from '../src/simulation/production/production';
import { createWorldLedgers } from '../src/simulation/markets/markets';
import { RECIPES } from '../src/data/demo-data';

const GRAIN_PER_FOOD =
  RECIPES.food.inputs.find((entry) => entry.good === 'grain')?.qty ?? 0.62;

function newWorld(): WorldState {
  return Simulation.create().state;
}

function companyOf(world: WorldState, id: string): Company {
  const company = world.companies.find((entry) => entry.id === id);
  if (!company) throw new Error(`测试世界没有企业 ${id}`);
  return company;
}

function companyIn(world: WorldState, cityId: string, output: 'grain' | 'food'): Company {
  const company = world.companies.find(
    (entry) => entry.cityId === cityId && entry.recipeOutput === output,
  );
  if (!company) throw new Error(`${cityId} 没有 ${output} 企业`);
  return company;
}

/** 清空所有企业库存、利用率与计划，只保留测试显式设置的原料与计划。 */
function isolate(world: WorldState): void {
  for (const company of world.companies) {
    company.utilization = 0;
    company.inventory = createEmptyInventory();
    company.inventoryCost = emptyInventoryCost();
    company.productionPlan = null;
  }
}

function planOf(tick: number, plannedOutput: number): CompanyProductionPlan {
  return {
    tick,
    salesReference: plannedOutput,
    targetInventory: 0,
    equipmentLimit: plannedOutput,
    laborLimit: 1_000_000_000,
    plannedOutput,
    plannedJobs: Math.max(1, Math.round(plannedOutput / 100)),
    emergency: false,
    reasons: ['测试计划'],
  };
}

function recordsFor(records: ProductionRecord[], companyId: string): ProductionRecord[] {
  return records.filter((record) => record.companyId === companyId);
}

function configWithRounds(rounds: number): DemoConfig {
  return {
    ...DEMO_CONFIG,
    production: { ...DEMO_CONFIG.production, productionRounds: rounds },
  } as unknown as DemoConfig;
}

describe('月内两轮采购+生产（v1.3 §4）', () => {
  it('月初无原料时，上游本轮产出的原料可立即被下游采购并生产', () => {
    const world = newWorld();
    isolate(world);
    const seller = companyIn(world, 'ironvale', 'grain');
    const buyer = companyIn(world, 'ironvale', 'food');
    const tick = world.time.tick;

    // 粮食厂：有能源但无粮食库存，本月计划 1000 粮食。
    seller.inventory.energy = 100;
    seller.inventoryCost = emptyInventoryCost();
    seller.inventoryCost.energy = 500;
    seller.productionPlan = planOf(tick, 1000);
    seller.cash = 10_000_000;
    setCompanyEmployees(seller, 2000);

    // 食品厂：月初无粮食（只有能源），计划 1000 食品。
    buyer.inventory.energy = 100;
    buyer.inventoryCost = emptyInventoryCost();
    buyer.inventoryCost.energy = 500;
    buyer.productionPlan = planOf(tick, 1000);
    buyer.cash = 10_000_000;
    setCompanyEmployees(buyer, 4000);

    const ledgers = createWorldLedgers(world);

    // 第 1 轮：食品厂没有任何可买粮食，生产 0；粮食厂产出 1000 粮食。
    runInputPurchasing(world, ledgers, DEMO_CONFIG, [], { round: 1 });
    const round1 = runProduction(world, ledgers, DEMO_CONFIG);
    expect(seller.lastMonth.produced).toBeCloseTo(1000, 2);
    expect(buyer.lastMonth.produced).toBe(0);
    expect(seller.inventory.grain ?? 0).toBeCloseTo(1000, 2);

    // 第 2 轮：第 1 轮新产出的粮食进入市场，食品厂买到并生产。
    runInputPurchasing(world, ledgers, DEMO_CONFIG, [], { round: 2 });
    const records2 = runProduction(world, ledgers, DEMO_CONFIG);

    expect(recordsFor(round1, buyer.id)).toHaveLength(0);
    const buyerRound2 = recordsFor(records2, buyer.id);
    expect(buyerRound2).toHaveLength(1);
    expect(buyer.lastMonth.produced).toBeCloseTo(1000, 2);
    // 第 2 轮只补生产月度计划剩余部分：两轮合计恰好 1000，不会翻倍。
    expect(seller.lastMonth.produced).toBeCloseTo(1000, 2);

    // 守恒：本月产出 = 下游消耗 + 期末库存（按票面数量核对，允许 0.01 取整）。
    const grainProduced = [...round1, ...records2]
      .filter((record) => record.good === 'grain')
      .reduce((total, record) => total + record.qty, 0);
    const grainConsumed = [...round1, ...records2]
      .flatMap((record) => record.inputs)
      .filter((input) => input.good === 'grain')
      .reduce((total, input) => total + input.qty, 0);
    const grainEndStock =
      (seller.inventory.grain ?? 0) +
      (buyer.inventory.grain ?? 0) +
      world.companies
        .filter((company) => company.id !== seller.id && company.id !== buyer.id)
        .reduce((total, company) => total + (company.inventory.grain ?? 0), 0);
    expect(grainProduced).toBeCloseTo(1000, 2);
    expect(grainConsumed).toBeCloseTo(round2(1000 * GRAIN_PER_FOOD), 2);
    expect(grainEndStock).toBeCloseTo(round2(grainProduced - grainConsumed), 2);

    // 需求只记一次：粮食账本的有效需求仍是第 1 轮的缺口；第 2 轮成交把它从缺货里冲减。
    const grainLedger = ledgers.ironvale!.grain;
    expect(grainLedger.producerDemand).toBeCloseTo(round2(1000 * GRAIN_PER_FOOD), 1);
    expect(grainLedger.unmetDemand).toBeCloseTo(0, 1);
    expect(grainLedger.sold).toBeCloseTo(round2(1000 * GRAIN_PER_FOOD), 1);
    // 成交不得超过当月产出（不能把同一批粮食卖两次）。
    expect(grainLedger.sold).toBeLessThanOrEqual(grainProduced + 0.01);
    expect(seller.lastMonth.sold).toBeCloseTo(grainLedger.sold, 2);
    expect(seller.inventory.grain ?? 0).toBeGreaterThanOrEqual(0);
    expect(buyer.inventory.grain ?? 0).toBeGreaterThanOrEqual(0);
  });

  it('月度计划与设备/劳动上限按剩余量分摊，两轮合计不超过计划', () => {
    const world = newWorld();
    isolate(world);
    const seller = companyIn(world, 'ironvale', 'grain');
    const tick = world.time.tick;
    // 能源足够生产 2000，但月度计划只有 1000：第二轮不应再产。
    seller.inventory.energy = 500;
    seller.inventoryCost = emptyInventoryCost();
    seller.inventoryCost.energy = 2000;
    seller.productionPlan = planOf(tick, 1000);
    seller.cash = 10_000_000;
    setCompanyEmployees(seller, 2000);
    const ledgers = createWorldLedgers(world);

    const produced: number[] = [];
    for (let round = 1; round <= 2; round += 1) {
      runInputPurchasing(world, ledgers, DEMO_CONFIG, [], { round });
      const records = runProduction(world, ledgers, DEMO_CONFIG);
      const own = recordsFor(records, seller.id);
      produced.push(round2(own.reduce((total, record) => total + record.qty, 0)));
    }
    expect(produced[0]).toBeCloseTo(1000, 2);
    expect(produced[1]).toBeCloseTo(0, 2);
    expect(seller.lastMonth.produced).toBeCloseTo(1000, 2);
  });

  it('整月 tick 使用固定轮次（默认 2 轮；配置 1 轮等价旧行为），且不重复生产', () => {
    const twoRoundSim = Simulation.create();
    twoRoundSim.tick();
    const twoRoundRecords = twoRoundSim.state.lastTick.productionRecords;
    const counts = new Map<string, number>();
    for (const record of twoRoundRecords) {
      counts.set(record.companyId, (counts.get(record.companyId) ?? 0) + 1);
    }
    expect(Math.max(...counts.values())).toBeLessThanOrEqual(2);
    expect(twoRoundRecords.length).toBeGreaterThan(0);
    expect(twoRoundSim.validate()).toEqual([]);

    const oneRoundSim = Simulation.create(configWithRounds(1));
    oneRoundSim.tick();
    const oneRoundCounts = new Map<string, number>();
    for (const record of oneRoundSim.state.lastTick.productionRecords) {
      oneRoundCounts.set(record.companyId, (oneRoundCounts.get(record.companyId) ?? 0) + 1);
    }
    expect(Math.max(...oneRoundCounts.values())).toBeLessThanOrEqual(1);
  });

  it('第 2 轮跨城成交同样受剩余需求上限约束，不重复记需求、不超卖', () => {
    const world = newWorld();
    isolate(world);
    const seller = companyIn(world, 'ironvale', 'grain');
    const localBuyer = companyIn(world, 'ironvale', 'food');
    const remoteBuyer = companyIn(world, 'lanport', 'food');
    const tick = world.time.tick;
    // 粮食厂第 1 轮才产出粮食：第 1 轮没人买得到，缺口记入各买方城市账本；
    // 第 2 轮粮食进入市场，本地与外城买家按各自剩余缺口成交。
    seller.inventory.energy = 500;
    seller.inventoryCost = emptyInventoryCost();
    seller.inventoryCost.energy = 2000;
    seller.productionPlan = planOf(tick, 1000);
    seller.cash = 10_000_000;
    setCompanyEmployees(seller, 2000);
    for (const buyer of [localBuyer, remoteBuyer]) {
      buyer.productionPlan = planOf(tick, 500);
      buyer.cash = 10_000_000;
      setCompanyEmployees(buyer, 2000);
    }
    const ledgers = createWorldLedgers(world);
    const localLedger = ledgers.ironvale!.grain;
    const remoteLedger = ledgers.lanport!.grain;

    runInputPurchasing(world, ledgers, DEMO_CONFIG, [], { round: 1 });
    const demandAfterRound1 = {
      local: localLedger.producerDemand,
      remote: remoteLedger.producerDemand,
      localRequired: localLedger.producerRequired,
      remoteRequired: remoteLedger.producerRequired,
    };
    expect(demandAfterRound1.local).toBeGreaterThan(0);
    expect(demandAfterRound1.remote).toBeGreaterThan(0);
    expect(localLedger.sold).toBe(0);
    expect(remoteLedger.intercityImported).toBe(0);
    runProduction(world, ledgers, DEMO_CONFIG);

    let soldBefore = 0;
    for (let round = 2; round <= 2; round += 1) {
      runInputPurchasing(world, ledgers, DEMO_CONFIG, [], { round });
      runProduction(world, ledgers, DEMO_CONFIG);
      // 成交单调不减且第 2 轮成交不超过“需求 − 已成交”。
      expect(localLedger.sold).toBeGreaterThanOrEqual(soldBefore - 0.01);
      soldBefore = localLedger.sold;
    }

    // 需求只在第 1 轮记账：第 2 轮成交后 producerDemand 不再增长。
    expect(localLedger.producerDemand).toBeCloseTo(demandAfterRound1.local, 2);
    expect(remoteLedger.producerDemand).toBeCloseTo(demandAfterRound1.remote, 2);
    // 不超卖：本地成交与跨城进口都不超过已记需求。
    expect(localLedger.sold + localLedger.intercityImported).toBeLessThanOrEqual(
      localLedger.demand + 0.05,
    );
    expect(remoteLedger.sold + remoteLedger.intercityImported).toBeLessThanOrEqual(
      remoteLedger.demand + 0.05,
    );
    expect(localLedger.sold).toBeLessThanOrEqual(localLedger.supply + localLedger.intercityImported + 0.05);
    // 第 2 轮冲减后恒等式仍成立：producerRequired − 成交 = unmetDemand + unmetFunding。
    for (const ledger of [localLedger, remoteLedger]) {
      expect(
        round2(ledger.producerRequired - ledger.sold - ledger.intercityImported),
      ).toBeCloseTo(round2(ledger.unmetDemand + ledger.unmetFunding), 1);
    }
    // 外城确实通过跨城成交拿到了本月新产出的粮食（跨城路径也受同一上限约束）。
    expect(remoteLedger.intercityImported).toBeGreaterThan(0);
    expect(remoteLedger.intercityImported).toBeLessThanOrEqual(demandAfterRound1.remote + 0.05);
    expect(localLedger.sold + remoteLedger.intercityImported).toBeLessThanOrEqual(1000 + 0.05);
  });
});
