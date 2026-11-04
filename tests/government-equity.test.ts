import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation/core/simulation';
import { DEMO_CONFIG } from '../src/data/config';
import type { WorldState } from '../src/simulation/contracts/types';
import {
  distributeDividend,
  holderCash,
  issueShares,
  playerStakeOf,
} from '../src/simulation/securities/securities';
import {
  castVote,
  ensureGovernance,
  proposeOperatorMotion,
  refreshBoards,
} from '../src/simulation/corporate-governance/governance';
import { foundCompany, liquidateCompany } from '../src/simulation/companies/lifecycle/lifecycle';
import { parseSave, serializeSave } from '../src/simulation/core/save';
import { checkInvariants } from '../src/simulation/core/invariants';
import { settleCompanyFinance } from '../src/simulation/finance/finance';
import { setCompanyEmployees } from '../src/simulation/companies/company';

function richWorld(): WorldState {
  const world = Simulation.create().state;
  for (const city of world.cities) city.treasury = 50_000_000;
  for (const group of world.investors) group.cash = 5_000_000;
  for (const company of world.companies) company.cash = 5_000_000;
  return world;
}

function governmentCompany(world: WorldState) {
  const city = world.cities.find((entry) => entry.id === 'greenfield')!;
  const result = foundCompany(
    world,
    { cityId: city.id, founderType: 'government', capital: 500_000 },
    DEMO_CONFIG,
  );
  expect(result.ok, result.error).toBe(true);
  const company = world.companies.find((entry) => entry.id === result.companyId)!;
  return { city, company };
}

describe('修复一：政府持股的分红与公司治理', () => {
  it('政府持股企业分红 1,000：财政增加 1,000，不记为居民投资收入', () => {
    const world = richWorld();
    const { city, company } = governmentCompany(world);
    const investorCashBefore = world.investors.reduce((sum, group) => sum + group.cash, 0);
    const treasuryBefore = city.treasury;
    const result = distributeDividend(world, company, 1_000, world.time.tick, DEMO_CONFIG);
    expect(result.total).toBeCloseTo(1_000, 2);
    expect(result.cities).toBeCloseTo(1_000, 2);
    expect(result.cityByCity[city.id]).toBeCloseTo(1_000, 2);
    expect(result.investors).toBe(0);
    expect(result.player).toBe(0);
    expect(result.companies).toBe(0);
    expect(city.treasury).toBeCloseTo(treasuryBefore + 1_000, 2);
    // 居民投资实体现金与投资分红统计都不应被计入这笔政府股息。
    const investorCashAfter = world.investors.reduce((sum, group) => sum + group.cash, 0);
    expect(investorCashAfter).toBe(investorCashBefore);
    const ledger = world.fiscal.ledger.filter(
      (entry) => entry.cityId === city.id && entry.kind === 'dividendIncome',
    );
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.amount).toBeCloseTo(1_000, 2);
    expect(checkInvariants(world)).toEqual([]);
  });

  it('政府与玩家、企业、居民群体共同持股时，分红总额与各方到账严格一致', () => {
    const world = richWorld();
    const { city, company } = governmentCompany(world);
    const player = { type: 'player' as const, id: 'player' };
    const companyHolder = { type: 'company' as const, id: world.companies[0]!.id };
    const group = world.investors.find((entry) => entry.cityId === city.id)!;
    issueShares(world, company, 'voting', companyHolder, 100_000, world.time.tick);
    issueShares(world, company, 'nonVoting', player, 200_000, world.time.tick);
    issueShares(world, company, 'nonVoting', { type: 'investorGroup', id: group.id }, 100_000, world.time.tick);

    const before = {
      city: city.treasury,
      player: world.player.cash,
      company: world.companies.find((entry) => entry.id === companyHolder.id)!.cash,
      group: group.cash,
      groupIncome: city.householdIncomeLastMonth,
    };
    const result = distributeDividend(world, company, 1_000, world.time.tick, DEMO_CONFIG);
    expect(result.total).toBeCloseTo(1_000, 2);
    expect(result.player + result.companies + result.cities + result.investors).toBeCloseTo(
      1_000,
      2,
    );
    expect(city.treasury - before.city).toBeCloseTo(result.cityByCity[city.id] ?? 0, 2);
    expect(world.player.cash - before.player).toBeCloseTo(result.player, 2);
    expect(
      world.companies.find((entry) => entry.id === companyHolder.id)!.cash - before.company,
    ).toBeCloseTo(result.companies, 2);
    // 居民实体现金只增加留存部分；返还部分随后进入居民收入（fiscal），两者合计等于其股息。
    const groupShare = result.investorByCity[city.id] ?? 0;
    expect(groupShare).toBeGreaterThan(0);
    expect(group.cash - before.group).toBeCloseTo(
      groupShare * (1 - DEMO_CONFIG.investors.dividendDistributionRate),
      2,
    );
    expect(result.investorDistributionByCity[city.id]).toBeCloseTo(
      groupShare * DEMO_CONFIG.investors.dividendDistributionRate,
      2,
    );
    expect(
      group.cash - before.group + (result.investorDistributionByCity[city.id] ?? 0),
    ).toBeCloseTo(groupShare, 2);
    expect(city.householdIncomeLastMonth).toBe(before.groupIncome);
    expect(checkInvariants(world)).toEqual([]);
  });

  it('政府持股企业清算时，剩余资产进入城市财政而不是居民投资实体', () => {
    const world = richWorld();
    const { city, company } = governmentCompany(world);
    company.cash = 700_000;
    company.debt = 0;
    const treasuryBefore = city.treasury;
    const investorCashBefore = world.investors.reduce((sum, group) => sum + group.cash, 0);
    const result = liquidateCompany(world, company.id, DEMO_CONFIG, '政府持股清算测试', []);
    expect(result.ok, result.error).toBe(true);
    const record = world.lifecycle.liquidations.at(-1)!;
    expect(record.holdings.some((entry) => entry.holder.type === 'city')).toBe(true);
    // v0.9：设备按真实买家处置，清算先变现设备（1 台工业设备残值 90,000），剩余资产再按股分配。
    expect(city.treasury - treasuryBefore).toBeCloseTo(790_000, 2);
    expect(world.investors.reduce((sum, group) => sum + group.cash, 0)).toBe(investorCashBefore);
    expect(
      world.fiscal.ledger.some(
        (entry) => entry.cityId === city.id && entry.kind === 'liquidationProceeds',
      ),
    ).toBe(true);
    expect(checkInvariants(world)).toEqual([]);
  });

  it('月度财务：政府持股企业的股息进入城市财政，居民投资分红不重复计入', () => {
    const world = richWorld();
    const { city, company } = governmentCompany(world);
    for (const other of world.companies) {
      other.lastMonth.revenue = 0;
      other.lastMonth.inputCost = 0;
      other.lastMonth.wagesPaid = 0;
      other.lastMonth.profit = 0;
    }
    company.cash = 1_000_000;
    company.debt = 0;
    setCompanyEmployees(company, 0);
    company.dividendPayoutRatio = 1;
    company.lastMonth.revenue = 200_000;
    company.lastMonth.inputCost = 0;
    city.corporateTaxRate = 0.05;
    const treasuryBefore = city.treasury;
    const finance = settleCompanyFinance(world, DEMO_CONFIG, []);
    const cityDividend = finance.cityDividendsByCity[city.id] ?? 0;
    expect(cityDividend).toBeGreaterThan(0);
    expect(city.treasury - treasuryBefore).toBeCloseTo(cityDividend, 2);
    expect(finance.investorDividendsByCity[city.id] ?? 0).toBe(0);
    expect(company.lastMonth.dividendsPaid).toBeCloseTo(cityDividend, 2);
    expect(
      world.fiscal.ledger.some(
        (entry) => entry.cityId === city.id && entry.kind === 'dividendIncome',
      ),
    ).toBe(true);
  });

  it('政府作为有投票权股东可以提案、投票并取得董事席位；仅分红股份无投票权', () => {
    const world = richWorld();
    const { city, company } = governmentCompany(world);
    const cityHolder = { type: 'city' as const, id: city.id };
    ensureGovernance(world, DEMO_CONFIG, 0);
    refreshBoards(world, DEMO_CONFIG, 0);
    const board = world.governance.boards.find((entry) => entry.companyId === company.id)!;
    expect(board.seats.some((seat) => seat.holder.type === 'city' && seat.holder.id === city.id)).toBe(
      true,
    );

    const proposed = proposeOperatorMotion(
      world,
      company.id,
      cityHolder,
      'management',
      world.time.tick,
      DEMO_CONFIG,
    );
    expect(proposed.ok, proposed.error).toBe(true);
    expect(proposed.motion!.proposedBy.type).toBe('city');
    expect(proposed.motion!.eligible.some((entry) => entry.holder.type === 'city')).toBe(true);
    expect(
      castVote(world, proposed.motion!.id, cityHolder, 'for', world.time.tick).ok,
    ).toBe(true);
    const vote = world.governance.motions
      .find((motion) => motion.id === proposed.motion!.id)!
      .votes.find((entry) => entry.holder.type === 'city')!;
    expect(vote.votingShares).toBeGreaterThan(0);

    // 只有仅分红股份的政府股东不能提案或投票。
    const second = foundCompany(
      world,
      {
        cityId: city.id,
        founderType: 'investorGroup',
        capital: 500_000,
      },
      DEMO_CONFIG,
    );
    expect(second.ok, second.error).toBe(true);
    const secondCompany = world.companies.find((entry) => entry.id === second.companyId)!;
    issueShares(world, secondCompany, 'nonVoting', cityHolder, 50_000, world.time.tick);
    const rejected = proposeOperatorMotion(
      world,
      secondCompany.id,
      cityHolder,
      'management',
      world.time.tick,
      DEMO_CONFIG,
    );
    expect(rejected.ok).toBe(false);
    expect(rejected.error).toContain('投票权');
  });

  it('政府持股、表决与股息在保存读取后保持一致', () => {
    const world = richWorld();
    const { city, company } = governmentCompany(world);
    const cityHolder = { type: 'city' as const, id: city.id };
    ensureGovernance(world, DEMO_CONFIG, 0);
    refreshBoards(world, DEMO_CONFIG, 0);
    const proposed = proposeOperatorMotion(
      world,
      company.id,
      cityHolder,
      'management',
      world.time.tick,
      DEMO_CONFIG,
    );
    expect(proposed.ok, proposed.error).toBe(true);
    expect(castVote(world, proposed.motion!.id, cityHolder, 'for', world.time.tick).ok).toBe(true);
    distributeDividend(world, company, 500, world.time.tick, DEMO_CONFIG);

    const parsed = parseSave(serializeSave(world));
    expect(parsed.ok, parsed.error).toBe(true);
    const restored = parsed.world!;
    const restoredCity = restored.cities.find((entry) => entry.id === city.id)!;
    const restoredCompany = restored.companies.find((entry) => entry.id === company.id)!;
    expect(restoredCity.treasury).toBeCloseTo(city.treasury, 2);
    expect(holderCash(restored, cityHolder)).toBeCloseTo(city.treasury, 2);
    expect(
      restored.securities.holdings.some(
        (holding) =>
          holding.companyId === company.id &&
          holding.holder.type === 'city' &&
          holding.holder.id === city.id,
      ),
    ).toBe(true);
    const restoredMotion = restored.governance.motions.find(
      (motion) => motion.id === proposed.motion!.id,
    )!;
    expect(restoredMotion.proposedBy.type).toBe('city');
    expect(restoredMotion.votes.some((vote) => vote.holder.type === 'city')).toBe(true);
    expect(
      restored.governance.boards
        .find((board) => board.companyId === company.id)!
        .seats.some((seat) => seat.holder.type === 'city'),
    ).toBe(true);
    expect(playerStakeOf(restored, restoredCompany.id)).toBe(0);
    expect(checkInvariants(restored)).toEqual([]);
  });
});
