import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation/core/simulation';
import { DEMO_CONFIG } from '../src/data/config';
import { checkInvariants } from '../src/simulation/core/invariants';
import { round2 } from '../src/simulation/core/math';
import {
  acceptFinancingOffer,
  bookPrice,
  createFinancingOffer,
  declineFinancingOffer,
  distributeDividend,
  holderTotalShares,
  holderVotingShares,
  matchOrders,
  playerTotalShares,
  shareClassId,
  tradeImmediately,
} from '../src/simulation/securities/securities';
import { parseSave, serializeSave } from '../src/simulation/core/save';
import { groupHolder, groupsOfCity, maybeCreateCompanyFinancing, planInvestorOrders } from '../src/simulation/investors/investors';
import type { DemoConfig } from '../src/data/config';
import type { WorldState } from '../src/simulation/contracts/types';

function newWorld(): WorldState {
  return Simulation.create().state;
}

function issuedTotal(world: WorldState, companyId: string): number {
  return world.securities.classes
    .filter((shareClass) => shareClass.companyId === companyId)
    .reduce((total, shareClass) => total + shareClass.issuedShares, 0);
}

function heldTotal(world: WorldState, shareClassIdValue: string): number {
  return world.securities.holdings
    .filter((holding) => holding.shareClassId === shareClassIdValue)
    .reduce((total, holding) => total + holding.shares, 0);
}

describe('证券与股权', () => {
  it('每个企业的股份类别发行量、持股合计与 totalShares 一致', () => {
    const world = newWorld();
    for (const company of world.companies) {
      expect(issuedTotal(world, company.id)).toBeCloseTo(company.totalShares, 2);
      for (const shareClass of world.securities.classes.filter(
        (entry) => entry.companyId === company.id,
      )) {
        expect(heldTotal(world, shareClass.id)).toBeCloseTo(shareClass.issuedShares, 2);
      }
    }
    expect(checkInvariants(world)).toEqual([]);
  });

  it('融资按出资方分别记录权利：拒绝无变化，接受后资金进入企业并增发对应类别', () => {
    const world = newWorld();
    const company = world.companies.find((entry) => entry.id === 'lp-food')!;
    const cityGroups = groupsOfCity(world, company.cityId);
    const group = cityGroups[0]!;
    const crossCompany = world.companies.find(
      (entry) => entry.cityId !== company.cityId && entry.cash > 1_000_000,
    )!;
    const price = bookPrice(world, company);

    const toGroup = createFinancingOffer(world, {
      companyId: company.id,
      investor: groupHolder(group),
      kind: 'nonVoting',
      amount: 100_000,
      pricePerShare: price,
      tick: world.time.tick,
    });
    const toCompany = createFinancingOffer(world, {
      companyId: company.id,
      investor: { type: 'company', id: crossCompany.id },
      kind: 'voting',
      amount: 100_000,
      pricePerShare: price,
      tick: world.time.tick,
    });
    expect(toGroup.ok).toBe(true);
    expect(toCompany.ok).toBe(true);

    const groupCash = group.cash;
    const companyCash = company.cash;
    const totalShares = company.totalShares;

    expect(declineFinancingOffer(world, toGroup.offerId!).ok).toBe(true);
    expect(group.cash).toBe(groupCash);
    expect(company.cash).toBe(companyCash);
    expect(company.totalShares).toBe(totalShares);

    const offer = world.securities.offers.find((entry) => entry.id === toCompany.offerId)!;
    const buyerCash = crossCompany.cash;
    expect(acceptFinancingOffer(world, offer.id, world.time.tick).ok).toBe(true);
    expect(company.cash).toBeCloseTo(companyCash + offer.amount, 2);
    expect(crossCompany.cash).toBeCloseTo(buyerCash - offer.amount, 2);
    expect(company.totalShares).toBeCloseTo(totalShares + offer.shares, 2);
    expect(
      world.securities.holdings.find(
        (holding) =>
          holding.shareClassId === shareClassId(company.id, 'voting') &&
          holding.holder.type === 'company' &&
          holding.holder.id === crossCompany.id,
      )?.shares ?? 0,
    ).toBeGreaterThan(0);
    expect(checkInvariants(world)).toEqual([]);
  });

  it('融资可以给企业出资方仅分红股份，但股票市场买入仍受投票权限制', () => {
    const world = newWorld();
    const company = world.companies.find((entry) => entry.id === 'lp-food')!;
    const votingInvestor = world.companies.find(
      (entry) => entry.cityId !== company.cityId && entry.cash > 1_000_000,
    )!;
    const dividendInvestor = [...world.companies]
      .filter((entry) => entry.id !== company.id && entry.id !== votingInvestor.id)
      .sort((a, b) => a.id.localeCompare(b.id))[0]!;
    dividendInvestor.cash = 5_000_000;
    const price = bookPrice(world, company);

    const votingOffer = createFinancingOffer(world, {
      companyId: company.id,
      investor: { type: 'company', id: votingInvestor.id },
      kind: 'voting',
      amount: 100_000,
      pricePerShare: price,
      tick: world.time.tick,
    });
    const dividendOffer = createFinancingOffer(world, {
      companyId: company.id,
      investor: { type: 'company', id: dividendInvestor.id },
      kind: 'nonVoting',
      amount: 100_000,
      pricePerShare: price,
      tick: world.time.tick,
    });
    expect(votingOffer.ok).toBe(true);
    expect(dividendOffer.ok).toBe(true);

    const companyCash = company.cash;
    expect(acceptFinancingOffer(world, votingOffer.offerId!, world.time.tick).ok).toBe(true);
    expect(acceptFinancingOffer(world, dividendOffer.offerId!, world.time.tick).ok).toBe(true);
    const acceptedVoting = world.securities.offers.find(
      (entry) => entry.id === votingOffer.offerId,
    )!;
    const acceptedDividend = world.securities.offers.find(
      (entry) => entry.id === dividendOffer.offerId,
    )!;
    expect(company.cash).toBeCloseTo(
      companyCash + acceptedVoting.amount + acceptedDividend.amount,
      2,
    );

    const votingHolding = world.securities.holdings.find(
      (holding) =>
        holding.holder.type === 'company' &&
        holding.holder.id === votingInvestor.id &&
        holding.companyId === company.id,
    )!;
    const dividendHolding = world.securities.holdings.find(
      (holding) =>
        holding.holder.type === 'company' &&
        holding.holder.id === dividendInvestor.id &&
        holding.companyId === company.id,
    )!;
    expect(votingHolding.shareClassId).toBe(shareClassId(company.id, 'voting'));
    expect(dividendHolding.shareClassId).toBe(shareClassId(company.id, 'nonVoting'));

    // 仅分红股份不产生投票权，但可以正常获得股息。
    expect(
      holderVotingShares(world, company.id, { type: 'company', id: dividendInvestor.id }),
    ).toBe(0);
    expect(
      holderTotalShares(world, company.id, { type: 'company', id: dividendInvestor.id }),
    ).toBe(dividendHolding.shares);
    const cashBefore = dividendInvestor.cash;
    const result = distributeDividend(world, company, 10_000, world.time.tick, DEMO_CONFIG);
    expect(result.companies).toBeGreaterThan(0);
    expect(dividendInvestor.cash).toBeGreaterThan(cashBefore);
    expect(dividendInvestor.lastMonth.dividendIncome).toBeGreaterThan(0);

    // 同一企业通过股票市场买入仅分红股份仍然被拒绝。
    const marketBuy = tradeImmediately(
      world,
      {
        companyId: company.id,
        shareClassId: shareClassId(company.id, 'nonVoting'),
        side: 'buy',
        holder: { type: 'company', id: dividendInvestor.id },
        shares: 10,
        limitPrice: 10,
        tick: world.time.tick,
      },
      DEMO_CONFIG,
    );
    expect(marketBuy.ok).toBe(false);
    expect(world.securities.orders).toHaveLength(0);
    expect(checkInvariants(world)).toEqual([]);
  });

  it('企业可以出售其通过融资合法持有的仅分红股份', () => {
    const world = newWorld();
    const company = world.companies.find((entry) => entry.id === 'lp-garment')!;
    const seller = world.companies.find((entry) => entry.id === 'iv-metal')!;
    seller.cash = 5_000_000;
    const offer = createFinancingOffer(world, {
      companyId: company.id,
      investor: { type: 'company', id: seller.id },
      kind: 'nonVoting',
      amount: 100_000,
      pricePerShare: bookPrice(world, company),
      tick: world.time.tick,
    });
    expect(offer.ok).toBe(true);
    expect(acceptFinancingOffer(world, offer.offerId!, world.time.tick).ok).toBe(true);

    const classId = shareClassId(company.id, 'nonVoting');
    const holding = world.securities.holdings.find(
      (entry) =>
        entry.holder.type === 'company' &&
        entry.holder.id === seller.id &&
        entry.shareClassId === classId,
    )!;
    const quantity = Math.min(10, holding.shares);
    const price = bookPrice(world, company);
    world.securities.orders.push({
      id: 'test-sell-order-nonvoting',
      companyId: company.id,
      shareClassId: classId,
      side: 'sell',
      holder: { type: 'company', id: seller.id },
      shares: quantity,
      limitPrice: price,
      createdTick: world.time.tick,
      note: '企业出售仅分红股份',
    });
    world.player.cash = 1_000_000;
    const playerCash = world.player.cash;
    const result = tradeImmediately(
      world,
      {
        companyId: company.id,
        shareClassId: classId,
        side: 'buy',
        holder: { type: 'player', id: 'player' },
        shares: quantity,
        limitPrice: price,
        tick: world.time.tick,
      },
      DEMO_CONFIG,
    );
    expect(result.ok).toBe(true);
    expect(result.shares).toBe(quantity);
    expect(world.player.cash).toBeLessThan(playerCash);
    expect(checkInvariants(world)).toEqual([]);
  });

  it('含企业仅分红股份的世界可存档并读回', () => {
    const world = newWorld();
    const company = world.companies.find((entry) => entry.id === 'lp-appliance')!;
    const investor = world.companies.find((entry) => entry.id === 'iv-energy')!;
    investor.cash = 5_000_000;
    const offer = createFinancingOffer(world, {
      companyId: company.id,
      investor: { type: 'company', id: investor.id },
      kind: 'nonVoting',
      amount: 100_000,
      pricePerShare: bookPrice(world, company),
      tick: world.time.tick,
    });
    expect(acceptFinancingOffer(world, offer.offerId!, world.time.tick).ok).toBe(true);
    expect(checkInvariants(world)).toEqual([]);

    const roundTrip = parseSave(serializeSave(world));
    expect(roundTrip.ok, roundTrip.error).toBe(true);
    expect(
      roundTrip.world!.securities.holdings.some(
        (holding) =>
          holding.holder.type === 'company' &&
          holding.holder.id === investor.id &&
          holding.shareClassId === shareClassId(company.id, 'nonVoting'),
      ),
    ).toBe(true);
  });

  it('二级市场成交：买方现金进入卖方，企业不会因此获得融资', () => {
    const world = newWorld();
    const company = world.companies.find((entry) => entry.id === 'lp-food')!;
    const seller = groupsOfCity(world, company.cityId)[0]!;
    const sellerHolding = world.securities.holdings.find(
      (holding) =>
        holding.holder.type === 'investorGroup' &&
        holding.holder.id === seller.id &&
        holding.shareClassId === shareClassId(company.id, 'voting'),
    )!;
    const price = bookPrice(world, company);
    world.securities.orders.push({
      id: 'test-sell-order',
      companyId: company.id,
      shareClassId: sellerHolding.shareClassId,
      side: 'sell',
      holder: groupHolder(seller),
      shares: 1_000,
      limitPrice: price,
      createdTick: world.time.tick,
      note: '测试卖单',
    });

    world.player.cash = 1_000_000;
    const playerCash = world.player.cash;
    const sellerCash = seller.cash;
    const companyCash = company.cash;
    const issued = company.totalShares;
    const playerBefore = playerTotalShares(world, company.id);

    const result = tradeImmediately(
      world,
      {
        companyId: company.id,
        shareClassId: sellerHolding.shareClassId,
        side: 'buy',
        holder: { type: 'player', id: 'player' },
        shares: 100,
        limitPrice: price,
        tick: world.time.tick,
      },
      DEMO_CONFIG,
    );

    expect(result.ok).toBe(true);
    expect(result.shares).toBe(100);
    expect(world.player.cash).toBeCloseTo(playerCash - result.value, 2);
    expect(seller.cash).toBeCloseTo(sellerCash + result.value, 2);
    expect(company.cash).toBeCloseTo(companyCash, 2);
    expect(company.totalShares).toBe(issued);
    expect(playerTotalShares(world, company.id)).toBeCloseTo(playerBefore + 100, 2);
    const votingClass = world.securities.classes.find(
      (entry) => entry.id === sellerHolding.shareClassId,
    )!;
    expect(heldTotal(world, sellerHolding.shareClassId)).toBeCloseTo(
      votingClass.issuedShares,
      2,
    );
    expect(checkInvariants(world)).toEqual([]);
  });

  it('资金不足或股份不足时不成交，且不留下部分变化', () => {
    const world = newWorld();
    const company = world.companies[0]!;
    const classId = shareClassId(company.id, 'voting');
    world.player.cash = 10;
    const before = JSON.stringify(world.securities.holdings);
    const poor = tradeImmediately(
      world,
      {
        companyId: company.id,
        shareClassId: classId,
        side: 'buy',
        holder: { type: 'player', id: 'player' },
        shares: 1_000,
        limitPrice: 100,
        tick: world.time.tick,
      },
      DEMO_CONFIG,
    );
    expect(poor.ok).toBe(false);
    expect(JSON.stringify(world.securities.holdings)).toBe(before);

    const noShares = tradeImmediately(
      world,
      {
        companyId: company.id,
        shareClassId: classId,
        side: 'sell',
        holder: { type: 'player', id: 'player' },
        shares: 10,
        limitPrice: 100,
        tick: world.time.tick,
      },
      DEMO_CONFIG,
    );
    expect(noShares.ok).toBe(false);
    expect(JSON.stringify(world.securities.holdings)).toBe(before);
  });

  it('同一持有人不能与自己撮合，避免居民实体对倒消耗流动性', () => {
    const world = newWorld();
    const company = world.companies.find((entry) => entry.id === 'lp-food')!;
    const group = groupsOfCity(world, company.cityId)[0]!;
    const holder = groupHolder(group);
    const classId = shareClassId(company.id, 'voting');
    const price = bookPrice(world, company);
    const sharesBefore = group.cash;
    world.securities.orders.push(
      {
        id: 'self-buy',
        companyId: company.id,
        shareClassId: classId,
        side: 'buy',
        holder,
        shares: 50,
        limitPrice: round2(price * 1.05),
        createdTick: world.time.tick,
        note: '对倒测试买单',
      },
      {
        id: 'self-sell',
        companyId: company.id,
        shareClassId: classId,
        side: 'sell',
        holder,
        shares: 50,
        limitPrice: price,
        createdTick: world.time.tick,
        note: '对倒测试卖单',
      },
    );
    const trades = matchOrders(world, world.time.tick, DEMO_CONFIG);
    expect(trades).toHaveLength(0);
    expect(group.cash).toBe(sharesBefore);
    expect(world.securities.orders.find((order) => order.id === 'self-buy')?.shares).toBe(50);
    expect(world.securities.orders.find((order) => order.id === 'self-sell')?.shares).toBe(50);
  });

  it('投资者自动卖单会按最新账面价重挂，避免旧限价长期偏离市场', () => {
    const world = newWorld();
    const company = world.companies.find((entry) => entry.id === 'lp-food')!;
    world.time.tick = 3;
    const classId = shareClassId(company.id, 'voting');
    const group = groupsOfCity(world, company.cityId)[0]!;
    world.securities.orders.push({
      id: 'stale-sell',
      companyId: company.id,
      shareClassId: classId,
      side: 'sell',
      holder: groupHolder(group),
      shares: 100,
      limitPrice: 999,
      createdTick: 1,
      note: '过期高价卖单',
    });
    company.cash = round2(company.cash * 0.8);
    const expected = round2(bookPrice(world, company) * 1.02);
    // v1.0 开局 65 家企业后，默认每群组 4 笔卖单配额覆盖不到 lp-food；调高配额，
    // 验证的仍是“旧限价卖单会按最新账面价重挂”。
    const config = {
      ...DEMO_CONFIG,
      securities: {
        ...DEMO_CONFIG.securities,
        ai: { ...DEMO_CONFIG.securities.ai, maxSellOrdersPerGroup: 500 },
      },
    } as unknown as DemoConfig;
    planInvestorOrders(world, config, world.time.tick);
    const refreshed = world.securities.orders.find(
      (order) =>
        order.side === 'sell' &&
        order.shareClassId === classId &&
        order.holder.type === 'investorGroup' &&
        order.holder.id === group.id,
    );
    expect(refreshed).toBeDefined();
    expect(refreshed!.id).not.toBe('stale-sell');
    expect(refreshed!.limitPrice).toBeCloseTo(expected, 2);
    expect(world.securities.orders.some((order) => order.id === 'stale-sell')).toBe(false);
  });

  it('企业融资会向玩家发出可接受的要约，资金进入企业并取得有投票权股份', () => {
    const world = newWorld();
    maybeCreateCompanyFinancing(world, DEMO_CONFIG, 1, []);
    const offer = world.securities.offers.find(
      (entry) => entry.status === 'open' && entry.investor.type === 'player',
    );
    expect(offer).toBeDefined();
    const company = world.companies.find((entry) => entry.id === offer!.companyId)!;
    const companyCash = company.cash;
    const playerCash = world.player.cash;
    expect(acceptFinancingOffer(world, offer!.id, 1).ok).toBe(true);
    expect(company.cash).toBeCloseTo(companyCash + offer!.amount, 2);
    expect(world.player.cash).toBeCloseTo(playerCash - offer!.amount, 2);
    expect(
      world.securities.holdings.find(
        (holding) =>
          holding.holder.type === 'player' &&
          holding.companyId === company.id &&
          holding.shareClassId === shareClassId(company.id, 'voting'),
      )?.shares ?? 0,
    ).toBe(offer!.shares);
    expect(checkInvariants(world)).toEqual([]);
  });

  it('企业买方在二级市场只能下投票权股份的买单', () => {
    const world = newWorld();
    const company = world.companies[0]!;
    const buyer = world.companies.find((entry) => entry.id !== company.id)!;
    buyer.cash = 10_000_000;
    const result = tradeImmediately(
      world,
      {
        companyId: company.id,
        shareClassId: shareClassId(company.id, 'nonVoting'),
        side: 'buy',
        holder: { type: 'company', id: buyer.id },
        shares: 10,
        limitPrice: 10,
        tick: world.time.tick,
      },
      DEMO_CONFIG,
    );
    expect(result.ok).toBe(false);
    expect(world.securities.orders).toHaveLength(0);
  });

  it('股息按实际持股分配一次，玩家、企业、居民实体所得合计等于支付总额', () => {
    const world = newWorld();
    const company = world.companies.find((entry) => entry.id === 'lp-garment')!;
    const groupBefore = new Map(world.investors.map((group) => [group.id, group.cash]));
    const companyBefore = new Map(world.companies.map((entry) => [entry.id, entry.cash]));
    const playerBefore = world.player.cash;
    const amount = 10_000;

    const result = distributeDividend(world, company, amount, world.time.tick, DEMO_CONFIG);

    expect(result.total).toBeCloseTo(amount, 2);
    expect(result.player).toBe(0);
    const groupGain = world.investors.reduce(
      (total, group) => total + (group.cash - (groupBefore.get(group.id) ?? 0)),
      0,
    );
    const companyGain = world.companies.reduce(
      (total, entry) => total + (entry.cash - (companyBefore.get(entry.id) ?? 0)),
      0,
    );
    const distributedToHouseholds = Object.values(result.investorDistributionByCity).reduce(
      (total, value) => total + value,
      0,
    );
    // 实体现金只增加留存部分；返还部分已从实体现金扣除，二者相加等于实收股息。
    expect(groupGain).toBeCloseTo(result.investors - distributedToHouseholds, 2);
    expect(round2(groupGain + distributedToHouseholds)).toBeCloseTo(result.investors, 2);
    expect(companyGain).toBeCloseTo(result.companies, 2);
    expect(result.player).toBeCloseTo(world.player.cash - playerBefore, 2);
    expect(result.investors + result.companies + result.player).toBeCloseTo(amount, 2);
  });

  it('多回合运行后股份、现金与不变量保持稳定（固定种子可复现）', () => {
    const run = (): string => {
      const sim = Simulation.create();
      for (let index = 0; index < 18; index++) {
        const result = sim.tick();
        expect(result.ok, result.error).toBe(true);
      }
      for (const company of sim.state.companies) {
        expect(issuedTotal(sim.state, company.id)).toBeCloseTo(company.totalShares, 2);
      }
      expect(checkInvariants(sim.state)).toEqual([]);
      return JSON.stringify(sim.state);
    };
    expect(run()).toBe(run());
  });
});
