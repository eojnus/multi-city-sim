import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation/core/simulation';
import { DEMO_CONFIG } from '../src/data/config';
import type { WorldState } from '../src/simulation/contracts/types';
import { foundCompany, checkBankruptcies, liquidateCompany } from '../src/simulation/companies/lifecycle/lifecycle';
import { setCompanyEmployees, monthlyWageBill } from '../src/simulation/companies/company';
import { checkInvariants } from '../src/simulation/core/invariants';
import { sumCityStock } from '../src/simulation/markets/markets';
import { GOOD_IDS } from '../src/simulation/companies/company';
import { visibleNotifications } from '../src/simulation/notifications/notifications';
import { companyCreditLimit } from '../src/simulation/companies/credit';
import { syncCityPopulationFromAllocations } from '../src/simulation/population/population';
import { startPolicy } from '../src/simulation/policies/policies';

function worldWithMoney(): WorldState {
  const world = Simulation.create().state;
  for (const city of world.cities) city.treasury = 10_000_000;
  for (const group of world.investors) group.cash = 3_000_000;
  for (const company of world.companies) company.cash = 3_000_000;
  return world;
}

function syncMarketStock(world: WorldState, cityId: string): void {
  const city = world.cities.find((entry) => entry.id === cityId)!;
  for (const goodId of GOOD_IDS) {
    city.market[goodId].closingStock = sumCityStock(world, cityId, goodId);
  }
}

describe('企业成立：居民投资群体 / 现有企业 / 城市政府', () => {
  it('居民投资群体联合创办：资金与股份来自出资人，企业获得等额现金', () => {
    const world = worldWithMoney();
    const city = world.cities.find((entry) => entry.id === 'greenfield')!;
    const groupsBefore = world.investors
      .filter((group) => group.cityId === city.id)
      .reduce((sum, group) => sum + group.cash, 0);
    const companiesBefore = world.companies.length;
    const result = foundCompany(
      world,
      { cityId: city.id, founderType: 'investorGroup', capital: 600_000 },
      DEMO_CONFIG,
    );
    expect(result.ok, result.error).toBe(true);
    const company = world.companies.find((entry) => entry.id === result.companyId)!;
    const groupsAfter = world.investors
      .filter((group) => group.cityId === city.id)
      .reduce((sum, group) => sum + group.cash, 0);
    expect(world.companies).toHaveLength(companiesBefore + 1);
    expect(company.cash).toBeCloseTo(600_000, 2);
    expect(groupsBefore - groupsAfter).toBeCloseTo(600_000, 2);
    const holdings = world.securities.holdings.filter(
      (holding) => holding.companyId === company.id && holding.holder.type === 'investorGroup',
    );
    expect(holdings.length).toBeGreaterThan(0);
    expect(holdings.reduce((sum, holding) => sum + holding.shares, 0)).toBeCloseTo(1_000_000, 2);
    const record = world.lifecycle.foundings.at(-1)!;
    expect(record.founderType).toBe('investorGroup');
    expect(record.investorCount).toBeGreaterThan(0);
    expect(record.investorCount).toBeLessThanOrEqual(DEMO_CONFIG.lifecycle.maxInvestorsPerSyndicate);
    expect(record.investors.reduce((sum, investor) => sum + investor.cash, 0)).toBeCloseTo(600_000, 2);
    expect(company.ai.style).toMatch(/^(growth|steady|return)$/);
    expect(checkInvariants(world)).toEqual([]);
  });

  it('现有企业创办：出资企业现金减少并获得股份，超过数量限制被拒绝', () => {
    const world = worldWithMoney();
    const city = world.cities.find((entry) => entry.id === 'lanport')!;
    const founder = world.companies.find((entry) => entry.cityId === city.id)!;
    const founderCashBefore = founder.cash;
    const first = foundCompany(
      world,
      { cityId: city.id, founderType: 'company', founderId: founder.id, capital: 500_000 },
      DEMO_CONFIG,
    );
    expect(first.ok, first.error).toBe(true);
    expect(founder.cash).toBeCloseTo(founderCashBefore - 500_000, 2);
    const newCompany = world.companies.find((entry) => entry.id === first.companyId)!;
    const shares = world.securities.holdings
      .filter(
        (holding) =>
          holding.companyId === newCompany.id &&
          holding.holder.type === 'company' &&
          holding.holder.id === founder.id,
      )
      .reduce((sum, holding) => sum + holding.shares, 0);
    expect(shares).toBeCloseTo(1_000_000, 2);
    const second = foundCompany(
      world,
      { cityId: city.id, founderType: 'company', founderId: founder.id, capital: 500_000 },
      DEMO_CONFIG,
    );
    expect(second.ok).toBe(false);
    expect(second.error).toContain('上限');
    expect(checkInvariants(world)).toEqual([]);
  });

  it('城市政府创办：财政出资、股份由城市持有，政府创办数量受限', () => {
    const world = worldWithMoney();
    const city = world.cities.find((entry) => entry.id === 'ironvale')!;
    const treasuryBefore = city.treasury;
    const first = foundCompany(
      world,
      { cityId: city.id, founderType: 'government', capital: 400_000 },
      DEMO_CONFIG,
    );
    expect(first.ok, first.error).toBe(true);
    expect(city.treasury).toBeCloseTo(treasuryBefore - 400_000, 2);
    const company = world.companies.find((entry) => entry.id === first.companyId)!;
    const cityShares = world.securities.holdings
      .filter(
        (holding) =>
          holding.companyId === company.id &&
          holding.holder.type === 'city' &&
          holding.holder.id === city.id,
      )
      .reduce((sum, holding) => sum + holding.shares, 0);
    expect(cityShares).toBeCloseTo(1_000_000, 2);
    const second = foundCompany(
      world,
      { cityId: city.id, founderType: 'government', capital: 400_000 },
      DEMO_CONFIG,
    );
    expect(second.ok).toBe(false);
    expect(second.error).toContain('上限');
  });

  it('资金不足、企业数量上限与重复创办都明确失败且不改变资产', () => {
    const world = worldWithMoney();
    const city = world.cities.find((entry) => entry.id === 'greenfield')!;
    for (const group of world.investors) group.cash = 0;
    const companiesBefore = world.companies.length;
    const failed = foundCompany(
      world,
      { cityId: city.id, founderType: 'investorGroup', capital: 500_000 },
      DEMO_CONFIG,
    );
    expect(failed.ok).toBe(false);
    expect(world.companies).toHaveLength(companiesBefore);

    const poorCity = world.cities.find((entry) => entry.id === 'greenfield')!;
    poorCity.treasury = 1_000;
    const poor = foundCompany(
      world,
      { cityId: city.id, founderType: 'government', capital: 500_000 },
      DEMO_CONFIG,
    );
    expect(poor.ok).toBe(false);
    expect(poor.error).toContain('财政');

    // 城市企业数量上限：用更低上限的配置验证边界。
    const limited = {
      ...DEMO_CONFIG,
      lifecycle: { ...DEMO_CONFIG.lifecycle, maxCompaniesPerCity: 0 },
    } as unknown as typeof DEMO_CONFIG;
    const capped = foundCompany(
      world,
      { cityId: city.id, founderType: 'government', capital: 500_000 },
      limited,
    );
    expect(capped.ok).toBe(false);
    expect(capped.error).toContain('企业数量');
  });
});

describe('企业倒闭：员工、资产、库存、债务、股份与协议的完整处理', () => {
  it('清算后企业移除、员工回到劳动力市场、债务与库存有记录、股东按股分得剩余现金', () => {
    const sim = Simulation.create();
    const world = sim.state;
    const company = world.companies.find((entry) => entry.id === 'lp-food')!;
    const city = world.cities.find((entry) => entry.id === company.cityId)!;
    // 玩家持有股份，验证分配与通知。
    expect(sim.invest(company.id, 500_000).ok).toBe(true);
    company.inventory.grain = 1_000;
    company.cash = 900_000;
    company.debt = 300_000;
    setCompanyEmployees(company, 20);
    company.jobDemand = 20;
    // 让城市人口与新员工数一致，避免把测试数据当成真实结算。
    syncCityPopulationFromAllocations(city, world);
    const employees = company.employees;
    const employedBefore = city.population.employed;
    world.agreements.push({
      id: 'agreement-liq',
      title: '倒闭测试协议',
      sponsorCityId: city.id,
      partnerCityId: 'greenfield',
      createdTick: world.time.tick,
      createdBy: 'demo',
      status: 'active',
      participants: [
        { companyId: company.id, cityId: city.id, side: 'buyer', decision: 'accepted', decidedTick: 0, note: '' },
        { companyId: 'gf-grain', cityId: 'greenfield', side: 'seller', decision: 'accepted', decidedTick: 0, note: '' },
      ],
      items: [
        {
          id: 'agreement-liq-item-1',
          good: 'grain',
          buyerCompanyId: company.id,
          sellerCompanyId: 'gf-grain',
          qtyPerMonth: 10,
          unitPrice: 10,
          months: 2,
          deliveredQty: 0,
          paidValue: 0,
          monthsExecuted: 0,
          status: 'active',
          lastNote: '',
        },
      ],
      note: '',
    });
    const playerCashBefore = world.player.cash;
    const result = liquidateCompany(world, company.id, DEMO_CONFIG, '测试倒闭', []);
    expect(result.ok, result.error).toBe(true);
    expect(world.companies.some((entry) => entry.id === company.id)).toBe(false);
    const record = world.lifecycle.liquidations.at(-1)!;
    expect(record.companyId).toBe(company.id);
    expect(record.employeesReleased).toBe(employees);
    expect(record.debtRepaid).toBe(300_000);
    expect(record.debtForgiven).toBe(0);
    expect(record.inventoryWrittenOff.find((entry) => entry.good === 'grain')!.qty).toBe(1_000);
    expect(record.shareholderPayout).toBeCloseTo(600_000, 2);
    expect(record.holdings.length).toBeGreaterThan(0);
    expect(world.player.cash).toBeGreaterThan(playerCashBefore);
    expect(world.agreements[0]!.items[0]!.status).toBe('failed');
    expect(city.population.employed).toBe(employedBefore - employees);
    expect(world.player.holdings.some((holding) => holding.companyId === company.id)).toBe(false);
    expect(
      world.securities.classes.some((shareClass) => shareClass.companyId === company.id),
    ).toBe(false);
    const notice = visibleNotifications(world).find(
      (entry) => entry.kind === 'major' && entry.title.includes(company.name),
    );
    expect(notice).toBeDefined();
    syncMarketStock(world, city.id);
    expect(checkInvariants(world)).toEqual([]);
  });

  it('倒闭企业持有的其他企业股份按股东比例转出，股份发行量保持守恒', () => {
    const world = worldWithMoney();
    const city = world.cities.find((entry) => entry.id === 'lanport')!;
    const company = world.companies.find((entry) => entry.cityId === city.id)!;
    const target = world.companies.find((entry) => entry.id !== company.id)!;
    // 让 company 持有 target 的有投票权股份。
    const shareClass = world.securities.classes.find(
      (entry) => entry.companyId === target.id && entry.kind === 'voting',
    )!;
    const issuedBefore = shareClass.issuedShares;
    world.securities.holdings.push({
      companyId: target.id,
      shareClassId: shareClass.id,
      holder: { type: 'company', id: company.id },
      shares: 10_000,
      acquiredVia: 'secondary',
      sinceTick: 0,
    });
    const holder = world.securities.holdings.find(
      (entry) => entry.companyId === target.id && entry.shareClassId === shareClass.id && entry.holder.type === 'investorGroup',
    );
    if (holder) holder.shares -= 10_000;
    company.cash = 0;
    company.debt = 0;
    const result = liquidateCompany(world, company.id, DEMO_CONFIG, '股份转出测试', []);
    expect(result.ok, result.error).toBe(true);
    expect(shareClass.issuedShares).toBe(issuedBefore);
    const held = world.securities.holdings
      .filter((entry) => entry.shareClassId === shareClass.id)
      .reduce((sum, entry) => sum + entry.shares, 0);
    expect(held).toBeCloseTo(issuedBefore, 2);
    expect(
      world.securities.holdings.some(
        (entry) => entry.holder.type === 'company' && entry.holder.id === company.id,
      ),
    ).toBe(false);
    syncMarketStock(world, city.id);
    expect(checkInvariants(world)).toEqual([]);
  });

  it('现金耗尽且信贷用尽的企业在下月判定中倒闭；有纾困政策时暂缓', () => {
    const world = worldWithMoney();
    const company = world.companies.find((entry) => entry.employees > 0)!;
    company.cash = 0;
    company.ai.lossMonths = 5;
    company.ai.ageMonths = 20;
    company.debt = companyCreditLimit(company, DEMO_CONFIG);
    const liquidated = checkBankruptcies(world, DEMO_CONFIG, []);
    expect(liquidated).toContain(company.id);
    const record = world.lifecycle.liquidations.find((entry) => entry.companyId === company.id)!;
    expect(record).toBeDefined();
    expect(record.debtForgiven).toBeGreaterThanOrEqual(0);

    const world2 = worldWithMoney();
    const saved = world2.companies.find((entry) => entry.employees > 0)!;
    saved.cash = 0;
    saved.ai.lossMonths = 5;
    saved.ai.ageMonths = 20;
    saved.debt = companyCreditLimit(saved, DEMO_CONFIG);
    startPolicy(world2, saved.cityId, 'companyRelief', DEMO_CONFIG);
    const liquidated2 = checkBankruptcies(world2, DEMO_CONFIG, []);
    expect(liquidated2).not.toContain(saved.id);
    expect(monthlyWageBill(saved)).toBeGreaterThanOrEqual(0);
  });
});
