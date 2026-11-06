/**
 * v1.7 存档系统：候选世界骨架。
 *
 * 恢复流程不直接改运行时世界：协调器先用本文件创建“候选世界”，各模块把数据写进去，
 * 全部通过校验后才整体替换。
 *
 * 为什么这里不预填各系统的空默认值：
 * - 每个必需模块都会恢复自己拥有的字段；缺失字段应由最终的结构校验/不变量校验报错，
 *   而不是被看似合理的空默认掩盖（空默认会让损坏存档变成“合法但状态错误”）。
 * - 只需保证顶层字段容器存在（数组/对象/数字），让各模块按 ID 填充即可。
 *
 * 因此候选世界在“全部模块恢复完成前”不是合法 WorldState；类型上的断言仅为内部构建方便。
 */

import type { WorldState } from '../contracts/types';
import type { SaveWorldMeta } from './types';

/** 清理后的候选世界容器：字段全部存在，但内容由各模块恢复。 */
export function createCandidateWorld(meta: SaveWorldMeta): WorldState {
  const candidate = {
    seed: meta.seed,
    rngState: meta.randomState,
    time: { year: meta.year, month: meta.month, tick: meta.tick },
    cities: [],
    companies: [],
    tradeRoutes: [],
    player: {
      name: '',
      homeCityId: '',
      cash: 0,
      holdings: [],
      roles: { mayorCityId: null },
      note: '',
    },
    securities: {
      classes: [],
      holdings: [],
      orders: [],
      lastTrades: [],
      offers: [],
      history: [],
    },
    governance: { boards: [], motions: [], controls: [] },
    investors: [],
    agreements: [],
    notifications: [],
    politics: { cities: [], elections: [] },
    policies: { active: [], history: [], lastRuns: [], lastSelection: [] },
    fiscal: { ledger: [], nextEntryId: 1 },
    transport: {
      links: [],
      intracity: [],
      pendingSales: [],
      lastMonth: {
        tick: 0,
        demand: 0,
        capacity: 0,
        overloadRatio: 0,
        penaltyRate: 0,
        capacityLossTotal: 0,
        freightSubsidy: 0,
        maintenancePaid: 0,
        corridors: [],
        intracity: [],
        trades: [],
        note: '',
      },
    },
    lifecycle: {
      foundings: [],
      liquidations: [],
      nextFoundingNumber: 1,
      nextLiquidationNumber: 1,
    },
    households: { groups: [], lastStats: [] },
    management: { operators: [], playerOperations: [], nextOperatorNumber: 1 },
    banking: {
      deposits: [],
      loans: [],
      snapshots: [],
      lastMonth: {
        tick: 0,
        interestExpense: 0,
        interestIncome: 0,
        principalIssued: 0,
        principalRepaid: 0,
        depositsTotal: 0,
        loansOutstanding: 0,
        newDefaults: 0,
        note: '',
      },
      nextAccountNumber: 1,
      nextLoanNumber: 1,
    },
    bonds: {
      issuances: [],
      holdings: [],
      payments: [],
      nextIssuanceNumber: 1,
      nextHoldingNumber: 1,
      nextPaymentNumber: 1,
    },
    householdFinance: { loans: [], nextLoanNumber: 1, budgets: [], note: '' },
    taxes: { accrualByCity: {}, historyByCity: {} },
    equipmentMarket: {
      initialStock: { farm: 0, industry: 0, energy: 0 },
      offers: [],
      lastMonthSold: { farm: 0, industry: 0, energy: 0 },
      pendingLedger: [],
      capitalizedThisTick: {},
    },
    history: [],
    log: [],
    lastTick: {
      productionRecords: [],
      tradeFlows: [],
      externalExports: [],
      migration: [],
      invariants: [],
    },
  };
  return candidate as unknown as WorldState;
}
