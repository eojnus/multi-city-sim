import type { InvestmentResult, WorldState } from '../contracts/types';
import type { DemoConfig } from '../../data/config';
import { cityMarketPrices } from '../markets/markets';
import { companySharePrice } from '../companies/company';
import { clamp, round2 } from '../core/math';
import { issueShares, playerStakeOf } from '../securities/securities';

export function computeCityGdp(world: WorldState): Record<string, number> {
  const gdpByCity: Record<string, number> = {};
  for (const city of world.cities) gdpByCity[city.id] = 0;
  for (const record of world.lastTick.productionRecords) {
    gdpByCity[record.cityId] = round2((gdpByCity[record.cityId] ?? 0) + record.valueAdded);
  }
  for (const city of world.cities) {
    const value = Math.max(0, gdpByCity[city.id] ?? 0);
    gdpByCity[city.id] = value;
    city.gdp = value;
    city.gdpHistory.push({ tick: world.time.tick, value });
    if (city.gdpHistory.length > 60) city.gdpHistory.shift();
    city.lastMonth.gdp = value;
  }
  return gdpByCity;
}

export function worldGdp(world: WorldState): number {
  return round2(world.cities.reduce((total, city) => total + city.gdp, 0));
}

export function playerNetWorth(world: WorldState): number {
  let value = world.player.cash;
  for (const holding of world.player.holdings) {
    const company = world.companies.find((candidate) => candidate.id === holding.companyId);
    if (!company) continue;
    const city = world.cities.find((candidate) => candidate.id === company.cityId);
    if (!city) continue;
    value += holding.shares * companySharePrice(company, cityMarketPrices(city));
  }
  return round2(value);
}

export function holdingStake(world: WorldState, companyId: string): number {
  return round2(playerStakeOf(world, companyId) * 10000) / 10000;
}

/**
 * 玩家向企业注资：玩家现金 → 企业现金，企业按演示规则扩大产能并增发有投票权股份。
 * 这是"企业融资"，资金进入发行企业；与二级市场买卖（钱付给卖方）严格区分。
 * 校验全部通过后才提交，避免部分扣款或部分增发。
 */
export function investInCompany(
  world: WorldState,
  companyId: string,
  amount: number,
  config: DemoConfig,
): InvestmentResult {
  const company = world.companies.find((candidate) => candidate.id === companyId);
  if (!company) return { ok: false, error: '企业不存在' };
  if (!Number.isFinite(amount)) return { ok: false, error: '投资金额无效' };
  const rounded = round2(amount);
  if (rounded < config.player.minInvestment) {
    return { ok: false, error: `最低注资 ${config.player.minInvestment} 信用点` };
  }
  if (rounded > config.player.maxInvestment) {
    return { ok: false, error: `单次注资上限 ${config.player.maxInvestment} 信用点` };
  }
  if (rounded > world.player.cash + 1e-6) return { ok: false, error: '玩家现金不足' };
  const city = world.cities.find((candidate) => candidate.id === company.cityId);
  if (!city) return { ok: false, error: '企业所在城市不存在' };

  const price = companySharePrice(company, cityMarketPrices(city));
  const issuedShares = Math.max(1, Math.round(rounded / price));
  const capacityGain = round2(
    company.capacity *
      clamp(
        rounded * config.company.investmentCapacityGainPerCurrency,
        0,
        config.company.maxInvestmentCapacityGain,
      ),
  );

  // ---- 提交 ----
  world.player.cash = round2(world.player.cash - rounded);
  company.cash = round2(company.cash + rounded);
  // 玩家出资为一级发行；暂定给予有投票权股份（个人二级市场买入权利仍待用户决定）。
  issueShares(world, company, 'voting', { type: 'player', id: 'player' }, issuedShares, world.time.tick);
  company.capacity = round2(company.capacity + capacityGain);
  company.maxCapacity = round2(
    Math.max(company.maxCapacity, company.capacity * 1.2, company.maxCapacity + capacityGain * 2),
  );

  world.log.push({
    tick: world.time.tick,
    kind: 'player',
    message: `玩家向 ${company.name} 注资 ${rounded.toFixed(0)}，获得 ${issuedShares} 股有投票权股份（发行价 ${price.toFixed(2)}），产能 +${capacityGain.toFixed(0)}。`,
  });
  trimLog(world, config);

  return { ok: true, shares: issuedShares, price, companyName: company.name };
}

export function trimLog(world: WorldState, config: DemoConfig): void {
  const max = config.simulation.maxLogEntries;
  if (world.log.length > max) world.log.splice(0, world.log.length - max);
}
