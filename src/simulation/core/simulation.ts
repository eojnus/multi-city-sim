import type {
  GoodId,
  InvestmentResult,
  TickResult,
  WorldState,
  LogEntry,
} from '../contracts/types';
import { DEMO_CONFIG } from '../../data/config';
import type { DemoConfig } from '../../data/config';
import { createInitialWorld } from './initializer';
import { DeterministicRng } from './rng';
import { applyNaturalGrowth, applyMigration } from '../population/population';
import { planCompanies } from '../companies/planning';
import { reconcileLabor } from '../labor/labor';
import { createWorldLedgers, executePurchase, finalizeMarkets } from '../markets/markets';
import type { WorldLedgers } from '../markets/markets';
import { runInputPurchasing, runProduction } from '../production/production';
import { executeTradeRoutes } from '../trade/trade';
import { runExternalDemand } from '../trade/external';
import { runConsumerMarket } from '../markets/consumer';
import { settleCompanyFinance } from '../finance/finance';
import { settleGovernment, recordMigrationReports } from '../government/fiscal';
import { computeCityGdp, playerNetWorth, investInCompany, trimLog } from '../economy/gdp';
import { checkInvariants } from './invariants';
import type { GoodsAudit } from './invariants';
import { GOOD_IDS } from '../companies/company';
import { round2 } from './math';
import { deepClone } from './save';

function resetCompanyMonth(world: WorldState): void {
  for (const company of world.companies) {
    company.lastMonth = {
      revenue: 0,
      inputCost: 0,
      wagesPaid: 0,
      wageArrears: 0,
      interestPaid: 0,
      corporateTax: 0,
      dividendsPaid: 0,
      profit: 0,
      produced: 0,
      sold: 0,
      exported: 0,
      unmetDemand: 0,
      capacityChange: 0,
    };
  }
  for (const city of world.cities) {
    city.lastMonth = {
      ...city.lastMonth,
      consumerSpend: 0,
      consumerBudget: 0,
      benefitsPaid: 0,
      incomeTax: 0,
      corporateTax: 0,
      publicWageBill: 0,
      gdp: 0,
      migrationIn: 0,
      migrationOut: 0,
    };
  }
}

function advanceTime(world: WorldState): void {
  world.time.tick += 1;
  world.time.month += 1;
  if (world.time.month > 12) {
    world.time.month = 1;
    world.time.year += 1;
  }
}

function totalStock(world: WorldState, goodId: GoodId): number {
  let total = 0;
  for (const company of world.companies) total += company.inventory[goodId] ?? 0;
  return round2(total);
}

export class Simulation {
  state: WorldState;
  config: DemoConfig;

  constructor(state: WorldState, config: DemoConfig = DEMO_CONFIG) {
    this.state = state;
    this.config = config;
  }

  static create(config: DemoConfig = DEMO_CONFIG): Simulation {
    return new Simulation(createInitialWorld(config), config);
  }

  get dateLabel(): string {
    return `${this.state.time.year} 年 ${String(this.state.time.month).padStart(2, '0')} 月`;
  }

  invest(companyId: string, amount: number): InvestmentResult {
    return investInCompany(this.state, companyId, amount, this.config);
  }

  validate(): string[] {
    return checkInvariants(this.state);
  }

  /**
   * 月度结算。顺序固定：人口 → 劳动力 → 采购 → 城际贸易 → 生产 →
   * 居民消费 → 价格 → 企业财务 → 财政与收入 → GDP。
   * 结算失败时恢复到本期开始前的快照，避免留下半期状态。
   */
  tick(): TickResult {
    const snapshot = deepClone(this.state);
    const logs: LogEntry[] = [];
    const rng = new DeterministicRng(this.state.rngState);

    try {
      resetCompanyMonth(this.state);
      advanceTime(this.state);
      this.state.lastTick = {
        productionRecords: [],
        tradeFlows: [],
        externalExports: [],
        migration: [],
        invariants: [],
      };

      const startStock: Record<GoodId, number> = {} as Record<GoodId, number>;
      for (const goodId of GOOD_IDS) startStock[goodId] = totalStock(this.state, goodId);

      // 1. 人口自然变动 + 迁移（迁移是原子操作）
      applyNaturalGrowth(this.state, rng, this.config, logs);
      applyMigration(this.state, rng, this.config, logs);

      // 2. 企业计划与劳动力匹配
      planCompanies(this.state, this.config, logs);
      reconcileLabor(this.state, this.config, logs);

      // 3. 市场期初供应；长期贸易合同优先执行（保证合同买方先拿到投入品）
      const ledgers = createWorldLedgers(this.state);
      const tradeFlows = executeTradeRoutes(this.state, this.config, logs);
      this.state.lastTick.tradeFlows.push(...tradeFlows);

      // 4. 生产资料采购：本地市场 + 区域市场补货
      runInputPurchasing(this.state, ledgers, this.config, logs);

      // 5. 生产：消耗库存、产出、记录增加值
      const productionRecords = runProduction(this.state, ledgers, this.config);
      this.state.lastTick.productionRecords = productionRecords;

      // 6. 居民消费（使用上一月已实现收入）
      const householdConsumed: Record<GoodId, number> = {} as Record<GoodId, number>;
      for (const goodId of GOOD_IDS) householdConsumed[goodId] = 0;
      for (const city of [...this.state.cities].sort((a, b) => a.id.localeCompare(b.id))) {
        const cityLedgers = ledgers[city.id];
        if (!cityLedgers) continue;
        const result = runConsumerMarket(this.state, city, cityLedgers, this.config);
        city.lastMonth.consumerSpend = result.spend;
        city.lastMonth.consumerBudget = result.budget;
        for (const goodId of GOOD_IDS) {
          householdConsumed[goodId] += result.bought[goodId] ?? 0;
        }
      }

      // 7. 区域外净出口（演示）：吸收超出目标库存的消费品
      const externalExports = runExternalDemand(this.state, ledgers, this.config);
      this.state.lastTick.externalExports = externalExports;

      // 8. 价格与市场统计
      finalizeMarkets(this.state, ledgers, this.config);

      // 8. 企业财务：工资、税、股息、产能
      const finance = settleCompanyFinance(this.state, this.config, logs);

      // 9. 城市财政与居民收入（供下一月消费）
      settleGovernment(this.state, finance, this.config, logs);
      for (const city of this.state.cities) recordMigrationReports(this.state, city);

      // 10. GDP 与历史
      computeCityGdp(this.state);
      const netWorth = playerNetWorth(this.state);
      const population = this.state.cities.reduce((tot, city) => tot + city.population.total, 0);
      const employed = this.state.cities.reduce((tot, city) => tot + city.population.employed, 0);
      const unemployed = this.state.cities.reduce(
        (tot, city) => tot + city.population.unemployed,
        0,
      );
      const gdp = this.state.cities.reduce((tot, city) => tot + city.gdp, 0);
      this.state.history.push({
        tick: this.state.time.tick,
        year: this.state.time.year,
        month: this.state.time.month,
        population,
        employed,
        unemployed,
        gdp: round2(gdp),
        playerNetWorth: netWorth,
      });
      if (this.state.history.length > this.config.simulation.maxHistory) {
        this.state.history.shift();
      }

      // 11. 库存守恒审计
      const audits: GoodsAudit[] = [];
      for (const goodId of GOOD_IDS) {
        let produced = 0;
        let intermediateConsumed = 0;
        let externalExported = 0;
        for (const record of productionRecords) {
          if (record.good === goodId) produced += record.qty;
          for (const input of record.inputs) {
            if (input.good === goodId) intermediateConsumed += input.qty;
          }
        }
        for (const entry of externalExports) {
          if (entry.good === goodId) externalExported += entry.qty;
        }
        const tradeNet = 0;
        // 跨城市贸易是全球库存的内部转移，世界口径净额为 0。
        const endStock = totalStock(this.state, goodId);
        audits.push({
          goodId,
          startStock: startStock[goodId] ?? 0,
          produced: round2(produced),
          intermediateConsumed: round2(intermediateConsumed),
          householdConsumed: round2(householdConsumed[goodId] ?? 0),
          externalExported: round2(externalExported),
          endStock,
          tradeNet: round2(tradeNet),
          expectedEndStock: round2(
            (startStock[goodId] ?? 0) +
              produced -
              intermediateConsumed -
              (householdConsumed[goodId] ?? 0) -
              externalExported +
              tradeNet,
          ),
        });
      }

      const problems = checkInvariants(this.state, audits);
      this.state.lastTick.invariants = problems;
      if (problems.length > 0) {
        this.state = snapshot;
        return { ok: false, error: `本期结算未通过不变量校验：${problems.slice(0, 3).join('；')}`, invariants: problems };
      }

      // 12. 日志与 RNG 状态
      for (const entry of logs) this.state.log.push(entry);
      this.state.log.push({
        tick: this.state.time.tick,
        kind: 'system',
        message: `月度结算完成：世界 GDP ${gdp.toFixed(0)}，就业 ${employed}，失业 ${unemployed}。`,
      });
      trimLog(this.state, this.config);
      this.state.rngState = rng.state >>> 0;

      return { ok: true, tick: this.state.time.tick, invariants: [] };
    } catch (error) {
      this.state = snapshot;
      return {
        ok: false,
        error: `结算异常，已恢复到本期开始前：${(error as Error).message}`,
        invariants: [(error as Error).message],
      };
    }
  }

  /** 原子买入（供未来玩家操作使用）；当前 UI 未开放直接商品交易。 */
  buyGood(companyId: string, cityId: string, goodId: GoodId, qty: number): { ok: boolean; error?: string } {
    const company = this.state.companies.find((candidate) => candidate.id === companyId);
    const city = this.state.cities.find((candidate) => candidate.id === cityId);
    if (!company || !city || company.cityId !== cityId) return { ok: false, error: '主体无效' };
    if (qty <= 0) return { ok: false, error: '数量无效' };
    const price = city.market[goodId]?.price ?? 0;
    const maxSpend = company.cash;
    if (price <= 0 || maxSpend <= 0) return { ok: false, error: '没有可用资金' };
    const ledgers = createWorldLedgers(this.state);
    const result = executePurchase(this.state, city, ledgers[city.id]!, goodId, qty, maxSpend, {
      buyerCompanyId: companyId,
    });
    if (result.qty <= 0) return { ok: false, error: '没有可成交供应' };
    return { ok: true };
  }
}
