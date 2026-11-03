import type {
  CompanyMonthlyStats,
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
import { transportTaxFactors } from '../government/taxes';
import { settleGovernmentDebt } from '../government/debt';
import { pushRealGdpPoint } from '../government/gdp-window';
import { computeCityGdp, playerNetWorth, investInCompany, trimLog } from '../economy/gdp';
import { checkInvariants } from './invariants';
import type { GoodsAudit } from './invariants';
import { GOOD_IDS } from '../companies/company';
import { round2 } from './math';
import { deepClone } from './save';
import {
  autoCastVotes,
  closeMotions,
  ensureGovernance,
  openDividendPolicyMotion,
  playerEligibleShares,
  refreshBoards,
} from '../corporate-governance/governance';
import {
  executeAgreements,
  maybeAutoPropose as maybeAutoProposeAgreements,
} from '../agreements/agreements';
import {
  autoDecideFinancingOffers,
  collectInvestableFunds,
  maybeCreateCompanyFinancing,
  planCompanyOrders,
  planInvestorOrders,
} from '../investors/investors';
import { matchOrders, playerStakeOf } from '../securities/securities';
import { notifyPlayer } from '../notifications/notifications';
import { advancePolitics } from '../politics/politics';
import { autoSelectPolicies, settlePolicies } from '../policies/policies';
import { advanceTransportConstruction } from '../transport/network';
import { settleTransportMonth } from '../transport/settlement';
import { checkBankruptcies, maybeFoundCompanies } from '../companies/lifecycle/lifecycle';
import { startWorkforceMonth } from '../labor/workforce';
import {
  recordHouseholdWealthStats,
  syncHouseholdPeople,
} from '../population/household-groups';
import {
  refreshBankingTotals,
  servicePlayerLoans,
  settleDepositInterest,
} from '../banking/banking';
import { refreshCreditSnapshots } from '../banking/credit';
import { ensureOperators, pruneOperatorPool, releaseOperator } from '../management/manager-pool';
import { autoCastElectionVotes, maybeOpenElections } from '../management/elections';
import {
  ensurePlayerOperations,
  expireProposals,
  generateProposals,
} from '../management/operations';

function blankStats(): CompanyMonthlyStats {
  return {
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
    dividendIncome: 0,
  };
}

function resetCompanyMonth(world: WorldState): void {
  world.player.lastDividend = 0;
  for (const company of world.companies) {
    // 上期统计必须先保留，经营计划只读 previousMonth；lastMonth 才是本月累计。
    company.previousMonth = { ...company.lastMonth };
    company.lastMonth = blankStats();
  }
  for (const group of world.investors) {
    group.lastDividend = 0;
  }
  // v0.4：居民群体本月统计清零（人数与现金是存量，不清零）。
  // v0.5：income 保留上月值——本月消费（步骤 7）按“上月收入 × 消费倾向”计算各群体预算，
  // 月末 applyHouseholdIncome 会把它覆盖为本月收入，因此这里不能提前清零。
  for (const group of world.households.groups) {
    group.lastMonth = {
      income: group.lastMonth.income,
      wageIncome: 0,
      benefits: 0,
      dividendIncome: 0,
      incomeTax: 0,
      consumption: 0,
      desiredConsumption: 0,
      savingsContribution: 0,
      netCashChange: 0,
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
      investorDividends: 0,
      investableContribution: 0,
      policySpending: 0,
      transportSpending: 0,
    };
    startWorkforceMonth(city);
  }
  world.securities.lastTrades = [];
  // 上期交通统计的维护支出口径保留，其余在结算时重写。
  world.transport.lastMonth = { ...world.transport.lastMonth, maintenancePaid: 0 };
  // v0.4：银行本月流量统计清零（存款/贷款存量在结算时实时刷新，不清零）。
  world.banking.lastMonth = {
    ...world.banking.lastMonth,
    tick: world.time.tick,
    interestExpense: 0,
    interestIncome: 0,
    principalIssued: 0,
    principalRepaid: 0,
    newDefaults: 0,
  };
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
   * 月度结算。顺序固定：
   * 人口 → 计划/劳动力 → 长期合同 → 政府协议 → 采购 → 生产 → 居民消费 →
   * 区域外出口 → 价格 → 治理表决 → 企业财务/股息 → 财政/居民收入 →
   * 居民投资资金 → 融资要约 → 二级股票撮合 → 通知 → GDP。
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

      // 1. 经营者与选任：补齐经营者/玩家经营状态，任期到期、空缺或严重经营问题触发选任。
      ensureOperators(this.state, this.config, this.state.time.tick);
      ensurePlayerOperations(this.state, this.config, this.state.time.tick);
      maybeOpenElections(this.state, this.config, this.state.time.tick, logs);
      pruneOperatorPool(this.state, this.config, this.state.time.tick);
      expireProposals(this.state, this.config, this.state.time.tick);

      // 2. 政治：任期、选举；非玩家政府按弱项与领导人倾向选择政策。
      //    玩家为市长的城市由玩家选择，autoSelectPolicies 明确跳过。
      advancePolitics(this.state, this.config, this.state.time.tick, logs);
      autoSelectPolicies(this.state, this.config, logs);

      // 3. 交通建设推进与维护（财政支出，容量在建成后提高）。
      advanceTransportConstruction(this.state, this.config, logs);

      // 4. 人口自然变动 + 迁移（迁移是原子操作，迁移者带走人均现金与存款）
      applyNaturalGrowth(this.state, rng, this.config, logs);
      applyMigration(this.state, rng, this.config, logs);

      // 5. 银行：活期存款按月计息（存款账户余额真实增加）。
      settleDepositInterest(this.state, this.config, this.state.time.tick, logs);

      // 6. 授信估值快照：基于上一完整月数据生成，当月保持稳定。
      refreshCreditSnapshots(this.state, this.config, this.state.time.tick);

      // 7. 企业自动经营计划与劳动力匹配（计划读取现任经营者风格与上月结果）
      planCompanies(this.state, this.config, logs);
      const labor = reconcileLabor(this.state, this.config, logs);
      // 招聘/裁员改变了各职业人数：重算群体人数，并按人均资产转移现金与存款。
      syncHouseholdPeople(this.state, this.config);

      // 5. 企业成立与倒闭（成立资金来自出资人；倒闭不留半期状态）
      maybeFoundCompanies(this.state, this.config, logs);
      checkBankruptcies(this.state, this.config, logs);
      // 倒闭企业：释放经营者、清理控制权与玩家经营记录，避免悬空引用。
      this.reconcileLifecycleAssignments();

      // 6. 长期贸易合同与政府协议：真实转移货物与资金（世界内部，库存净额不变）
      const tradeFlows = executeTradeRoutes(this.state, this.config, logs);
      this.state.lastTick.tradeFlows.push(...tradeFlows);

      const agreementFlows = executeAgreements(this.state, this.config, this.state.time.tick, logs);
      this.state.lastTick.tradeFlows.push(...agreementFlows);
      maybeAutoProposeAgreements(this.state, this.config, this.state.time.tick, logs);
      this.pruneAgreementHistory();

      // 7. 市场期初供应（在合同/协议改变企业库存之后计算）
      const ledgers = createWorldLedgers(this.state);

      // 8. 生产资料采购：本地市场 + 区域市场补货（成交后才补足融资）
      runInputPurchasing(this.state, ledgers, this.config, logs);

      // 9. 生产：消耗库存、产出、记录增加值（受员工、技能、政策与产能限制）
      const productionRecords = runProduction(this.state, ledgers, this.config);
      this.state.lastTick.productionRecords = productionRecords;

      // 7. 居民消费（使用上一月已实现收入）
      const householdConsumed: Record<GoodId, number> = {} as Record<GoodId, number>;
      for (const goodId of GOOD_IDS) householdConsumed[goodId] = 0;
      for (const city of [...this.state.cities].sort((a, b) => a.id.localeCompare(b.id))) {
        const cityLedgers = ledgers[city.id];
        if (!cityLedgers) continue;
        const result = runConsumerMarket(this.state, city, cityLedgers, this.config);
        city.lastMonth.consumerSpend = result.spend;
        city.lastMonth.consumerBudget = result.budget;
        // v0.5：runConsumerMarket 内部已按群体逐笔扣款并记账（含现金流与期望消费），
        // 这里不再统一扣减，避免重复记账。
        for (const goodId of GOOD_IDS) {
          householdConsumed[goodId] += result.bought[goodId] ?? 0;
        }
      }

      // 10. 区域外净出口（演示）：吸收超出目标库存的消费品
      const externalExports = runExternalDemand(this.state, ledgers, this.config);
      this.state.lastTick.externalExports = externalExports;

      // 11. 跨城运输结算：统一按城市对计算容量惩罚，卖方所得在此时入账。
      // v0.8：税收系数必须用“上一完整月”的城内配送统计，因此在结算覆盖 lastMonth 之前取。
      const taxFactors = transportTaxFactors(this.state, this.config);
      const householdRefunds = settleTransportMonth(this.state, this.config, logs, ledgers);

      // 12. 价格与市场统计
      finalizeMarkets(this.state, ledgers, this.config);

      // 13. 治理：先计票并应用既有议案（影响本月股息政策），再重选董事
      ensureGovernance(this.state, this.config, this.state.time.tick);
      autoCastVotes(this.state, this.config, this.state.time.tick);
      // v0.4：选任议案的 AI 持有人自动投票（与二元议案分开计票）。
      autoCastElectionVotes(this.state, this.config, this.state.time.tick);
      const decidedMotions = closeMotions(this.state, this.config, this.state.time.tick, logs);
      refreshBoards(this.state, this.config, this.state.time.tick);

      // 14. 企业财务：工资、税、银行还本付息、按实际持股分配股息、产能
      const finance = settleCompanyFinance(this.state, this.config, logs);
      // 14a. 玩家个人贷款还本付息（工资/税之后，股息之前无冲突）。
      servicePlayerLoans(this.state, this.config, this.state.time.tick, logs);

      // 14b. 基于已结算利润提出下期议案（表决期结束后生效）
      openDividendPolicyMotion(this.state, this.config, this.state.time.tick);

      // 15. 城市财政与居民收入（供下一月消费）
      settleGovernment(this.state, finance, this.config, logs, householdRefunds, taxFactors);
      for (const city of this.state.cities) recordMigrationReports(this.state, city);
      this.collectMayorNotices(logs);

      // 16. 政策执行：补贴、培训、纾困、研发、住房、救助等（实际财政支出与状态变化）
      settlePolicies(this.state, this.config, { hiresByCompany: labor.hiresByCompany, log: logs });

      // 16b. 玩家经营模式：AI 辅助/高度托管按需生成重大事项提案（未批准不执行）。
      generateProposals(this.state, this.config, this.state.time.tick, logs);

      // 13. 居民可投资资金（从下月消费预算中划出，不新增货币）
      collectInvestableFunds(this.state, this.config, logs);

      // 14. 融资要约与二级股票市场（资金/股份逐笔校验后原子成交）
      maybeCreateCompanyFinancing(this.state, this.config, this.state.time.tick, logs);
      autoDecideFinancingOffers(this.state, this.config, this.state.time.tick);
      planInvestorOrders(this.state, this.config, this.state.time.tick);
      planCompanyOrders(this.state, this.config, this.state.time.tick);
      matchOrders(this.state, this.state.time.tick, this.config);

      // 15. 玩家通知（按身份与持股权利筛选，不展示模拟步骤）
      this.publishNotices(finance.playerDividendsByCompany, decidedMotions);
      this.publishManagementNotices();

      // 16. GDP 与历史
      computeCityGdp(this.state);
      // 16a. v0.7：本月真实 GDP 入 12 个月判定窗口（替换最早的估计月；估计值仍保留 estimated 标注）。
      for (const city of this.state.cities) {
        pushRealGdpPoint(this.state, city, this.state.time.tick, city.gdp, this.config);
      }
      // 16b. v0.7：政府债务月结唯一入口（内部固定顺序：应付/计提 → 票息与到期兑付 → 银行垫付
      //      → 贷款分期 → 负债率与破产判定 → 清算与重选）。块0 为空实现，不改变现有结算结果。
      settleGovernmentDebt(this.state, this.config, logs);
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

      // 17. 库存守恒审计
      // v0.4：记录本月财富阶层快照（人数合计等于城市总人口）。
      recordHouseholdWealthStats(this.state, this.config, this.state.time.tick);
      // 银行存贷款存量统计按月末实际余额刷新（流量字段在本月结算中累加）。
      refreshBankingTotals(this.state);
      const audits: GoodsAudit[] = [];
      for (const goodId of GOOD_IDS) {
        let produced = 0;
        let intermediateConsumed = 0;
        let externalExported = 0;
        let writtenOff = 0;
        for (const record of productionRecords) {
          if (record.good === goodId) produced += record.qty;
          for (const input of record.inputs) {
            if (input.good === goodId) intermediateConsumed += input.qty;
          }
        }
        for (const entry of externalExports) {
          if (entry.good === goodId) externalExported += entry.qty;
        }
        // 倒闭企业库存按账面注销：不是被消费，也不是凭空消失，必须有显式去向。
        for (const liquidation of this.state.lifecycle.liquidations) {
          if (liquidation.tick !== this.state.time.tick) continue;
          for (const entry of liquidation.inventoryWrittenOff) {
            if (entry.good === goodId) writtenOff += entry.qty;
          }
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
          writtenOff: round2(writtenOff),
          endStock,
          tradeNet: round2(tradeNet),
          expectedEndStock: round2(
            (startStock[goodId] ?? 0) +
              produced -
              intermediateConsumed -
              (householdConsumed[goodId] ?? 0) -
              externalExported -
              writtenOff +
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

      // 18. 日志与 RNG 状态
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

  /** 倒闭企业：释放经营者、清理控制权与玩家经营记录，避免悬空引用。 */
  private reconcileLifecycleAssignments(): void {
    const companyIds = new Set(this.state.companies.map((company) => company.id));
    for (const operator of [...this.state.management.operators]) {
      if (operator.status === 'employed' && operator.companyId && !companyIds.has(operator.companyId)) {
        releaseOperator(this.state, operator.id, this.state.time.tick, '企业已倒闭');
      }
    }
    this.state.governance.controls = this.state.governance.controls.filter((control) =>
      companyIds.has(control.companyId),
    );
    this.state.management.playerOperations = this.state.management.playerOperations.filter(
      (operation) => companyIds.has(operation.companyId),
    );
  }

  /** 已结束的协议只保留最近 10 条，避免存档无限增长；进行中的协议不受影响。 */  private pruneAgreementHistory(): void {
    const finished = this.state.agreements.filter(
      (agreement) => agreement.status === 'completed' || agreement.status === 'cancelled',
    );
    if (finished.length <= 10) return;
    const remove = new Set(finished.slice(0, finished.length - 10).map((agreement) => agreement.id));
    this.state.agreements = this.state.agreements.filter((agreement) => !remove.has(agreement.id));
  }

  /** 玩家担任市长时才生成城市事务通知；未当选时 notifyPlayer 会丢弃。 */
  private collectMayorNotices(logs: LogEntry[]): void {
    const mayorCityId = this.state.player.roles?.mayorCityId ?? null;
    if (!mayorCityId) return;
    const city = this.state.cities.find((candidate) => candidate.id === mayorCityId);
    if (!city) return;
    if (city.treasury < 0) {
      notifyPlayer(this.state, this.config, {
        audience: 'city',
        kind: 'major',
        priority: 'important',
        cityId: city.id,
        title: `${city.name} 财政出现赤字`,
        body: `本月财政缺口 ${Math.abs(city.treasury).toFixed(0)} 信用点。福利支付将受可用资金限制，请考虑财政安排。`,
      });
      logs.push({
        tick: this.state.time.tick,
        kind: 'government',
        message: `${city.name} 财政赤字 ${Math.abs(city.treasury).toFixed(0)}（市长事务通知）。`,
      });
    }
  }

  /** 只生成玩家真正需要处理或知情的通知；普通经营明细留在企业页面。 */
  private publishNotices(
    playerDividendsByCompany: Record<string, number>,
    decidedMotions: ReturnType<typeof closeMotions>,
  ): void {
    const threshold = this.config.notifications.majorStakeThreshold;
    for (const [companyId, amount] of Object.entries(playerDividendsByCompany)) {
      if (amount < this.config.notifications.minDividendAmount) continue;
      const company = this.state.companies.find((candidate) => candidate.id === companyId);
      if (!company) continue;
      notifyPlayer(this.state, this.config, {
        audience: 'personal',
        kind: 'dividend',
        priority: 'normal',
        companyId,
        title: `${company.name} 股息到账`,
        body: `本月按持股比例收到 ${amount.toFixed(2)} 信用点股息，已计入现金。`,
      });
    }

    for (const motion of this.state.governance.motions) {
      if (motion.status !== 'open') continue;
      // 以议案登记日快照为准：议案创建后买入股份的玩家不获得本次表决权。
      if (playerEligibleShares(this.state, motion) <= 0) continue;
      const company = this.state.companies.find((candidate) => candidate.id === motion.companyId);
      if (!company) continue;
      // 同一企业同一时间只保留一条未读表决通知，避免每月重复提醒。
      const already = this.state.notifications.some(
        (notice) =>
          notice.kind === 'vote' &&
          notice.companyId === company.id &&
          !notice.read,
      );
      if (already) continue;
      notifyPlayer(this.state, this.config, {
        audience: 'company',
        kind: 'vote',
        priority: 'important',
        companyId: company.id,
        motionId: motion.id,
        title: `${company.name} 有股东表决待你参与`,
        body: `${motion.title} 将于第 ${motion.closesAtTick} 期计票；你在登记日持有投票权，可在企业页面选择赞成、反对或弃权。`,
      });
    }

    for (const motion of decidedMotions) {
      const company = this.state.companies.find((candidate) => candidate.id === motion.companyId);
      if (!company) continue;
      // 表决结果属于企业重大变化：少量持股人（含有投票权/仅分红）都应知情；
      // 无持股且非经营者会被 notificationVisible 过滤。
      notifyPlayer(this.state, this.config, {
        audience: 'company',
        kind: 'major',
        priority: 'important',
        companyId: company.id,
        title: `${company.name} 股东表决结果`,
        body: motion.result,
      });
    }

    for (const company of this.state.companies) {
      if (company.capacity <= 0) continue;
      const changeRatio = Math.abs(company.lastMonth.capacityChange) / company.capacity;
      if (changeRatio < 0.08) continue;
      // 重大变化按“全部持股”判断，不要求投票权；仅分红股东也应获知。
      const stake = playerStakeOf(this.state, company.id);
      if (stake <= 0 && !this.playerIsOperator(company.id)) continue;
      notifyPlayer(this.state, this.config, {
        audience: 'company',
        kind: 'major',
        priority: 'important',
        companyId: company.id,
        title: `${company.name} 产能明显变化`,
        body: `本月产能${company.lastMonth.capacityChange >= 0 ? '扩大' : '收缩'} ${Math.abs(company.lastMonth.capacityChange).toFixed(0)} 单位/月（约 ${(changeRatio * 100).toFixed(1)}%）。`,
      });
    }

    for (const agreement of this.state.agreements) {
      if (agreement.createdTick !== this.state.time.tick) continue;
      const participant = agreement.participants.find(
        (entry) =>
          entry.decision === 'accepted' && this.isPlayerInterestedCompany(entry.companyId),
      );
      if (!participant) continue;
      notifyPlayer(this.state, this.config, {
        audience: 'company',
        kind: 'agreement',
        priority: 'normal',
        companyId: participant.companyId,
        title: `政府牵头协议：${agreement.title}`,
        body:
          agreement.status === 'active'
            ? `协议已生效，涉及 ${agreement.items.length} 项商品买卖。参与企业分别履约，拒绝方不承担义务。`
            : `协议状态：${agreement.status === 'cancelled' ? '未达成（企业拒绝或条件不满足）' : '协商中'}。`,
      });
    }
  }

  private playerIsOperator(companyId: string): boolean {
    const control = this.state.governance.controls.find((entry) => entry.companyId === companyId);
    return Boolean(
      control &&
        control.operator !== 'management' &&
        control.operator.type === 'player' &&
        control.operator.id === 'player',
    );
  }

  /**
   * v0.4：经营者选任、玩家经营提案与银行贷款的通知。
   * 只在事件发生当月生成，避免每月重复刷屏；无投票权/无经营身份时不打扰玩家。
   */
  private publishManagementNotices(): void {
    const tick = this.state.time.tick;

    // 1. 选任：玩家有投票权，或玩家已登记为候选人。
    for (const motion of this.state.governance.motions) {
      if (motion.kind !== 'operatorElection' || motion.status !== 'open') continue;
      if (motion.createdTick !== tick) continue;
      const company = this.state.companies.find((candidate) => candidate.id === motion.companyId);
      if (!company) continue;
      const canVote = playerEligibleShares(this.state, motion) > 0;
      const isCandidate = (motion.candidates ?? []).some((entry) => entry.kind === 'player');
      if (!canVote && !isCandidate) continue;
      const names = (motion.candidates ?? []).map((entry) => entry.name).join('、');
      notifyPlayer(this.state, this.config, {
        audience: 'company',
        kind: 'vote',
        priority: 'important',
        companyId: company.id,
        title: `${company.name} 经营者选任开始`,
        body: `候选人：${names}。投票期至第 ${motion.closesAtTick} 期；你${canVote ? '持有投票权股份，可投票' : ''}${canVote && isCandidate ? '；' : ''}${isCandidate ? '已登记为候选人' : ''}。`,
      });
    }

    // 2. 玩家经营企业：待批准的重大事项提案。
    for (const operation of this.state.management.playerOperations) {
      for (const proposal of operation.proposals) {
        if (proposal.status !== 'pending' || proposal.createdTick !== tick) continue;
        const company = this.state.companies.find((candidate) => candidate.id === proposal.companyId);
        if (!company) continue;
        notifyPlayer(this.state, this.config, {
          audience: 'company',
          kind: 'major',
          priority: 'important',
          companyId: company.id,
          title: `${company.name} 有待批准的提案`,
          body: `${proposal.title}：${proposal.summary}${proposal.reasons.length > 0 ? `（原因：${proposal.reasons.join('；')}）` : ''}`,
        });
      }
    }

    // 3. 贷款：本月新出现欠款或违约的，通知借款主体是玩家或玩家经营的企业。
    for (const loan of this.state.banking.loans) {
      const payment = loan.payments.find((entry) => entry.tick === tick);
      if (!payment) continue;
      if (payment.arrears <= 0.01 && loan.status !== 'defaulted') continue;
      const companyId = loan.borrower.kind === 'company' ? loan.borrower.id : null;
      const isPlayerDebt = loan.borrower.kind === 'player';
      const isPlayerCompany = companyId !== null && this.playerIsOperator(companyId);
      if (!isPlayerDebt && !isPlayerCompany) continue;
      const company = companyId
        ? this.state.companies.find((candidate) => candidate.id === companyId)
        : null;
      const subject = isPlayerDebt ? '你的个人贷款' : `${company?.name ?? '企业'}的银行贷款`;
      notifyPlayer(this.state, this.config, {
        audience: company ? 'company' : 'personal',
        kind: 'major',
        priority: 'important',
        companyId: company?.id,
        title: `${subject}${loan.status === 'defaulted' ? '已标记违约' : '出现欠款'}`,
        body: `合同 ${loan.id}：本月应还利息 ${payment.interestDue.toFixed(2)}、本金 ${payment.principalDue.toFixed(2)}，实付利息 ${payment.interestPaid.toFixed(2)}、本金 ${payment.principalPaid.toFixed(2)}。`,
      });
    }
  }

  private isPlayerInterestedCompany(companyId: string): boolean {
    const company = this.state.companies.find((candidate) => candidate.id === companyId);
    if (!company) return false;
    if (this.playerIsOperator(companyId)) return true;
    return (
      playerStakeOf(this.state, companyId) >= this.config.notifications.majorStakeThreshold
    );
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
