import type {
  ActionResult,
  Candidate,
  City,
  CityPoliticsState,
  ElectionRecord,
  LeaderProfile,
  LogEntry,
  PolicyDomain,
  SectorId,
  WorldPoliticsState,
  WorldState,
} from '../contracts/types';
import type { DemoConfig } from '../../data/config';
import { clamp, round2 } from '../core/math';
import { transmitPlayerCash } from './electionFunds';

/**
 * 候选人、领导人与选举（最小可运行原型）。
 *
 * 【演示假设，用户尚未确定】：
 * - 每城固定 3 名候选人，姓名/党派/倾向由城市 ID 确定性生成，不使用外部 AI；
 * - 任期 24 个月，到期自动举行一次选举；
 * - 玩家可以支付一笔参选费用参加下一次选举；
 * - 领导人被动属性 = 一个重点行业 + 七个政策领域的倾向（0–1）；
 *   重点行业带来有上限的生产率加成，领域倾向影响非玩家政府选政策的权重与政策效果。
 * 这些都不是最终选举制度，也不改变用户已确认的“玩家当市长时由玩家选择政策”。
 */

const FIRST_NAMES = ['沈清和', '顾南舟', '叶明', '罗知远', '程澜', '唐叙白', '许星野', '季文昭'];
const PARTIES = ['城市建设同盟', '民生优先联盟', '产业发展党', '独立市民团'];
const TRAITS: { label: string; note: string; domain: PolicyDomain; sector?: SectorId }[] = [
  { label: '就业组织者', note: '重视就业与职业培训。', domain: 'employment' },
  { label: '产业规划者', note: '重视重点产业与设备投资。', domain: 'industry', sector: 'metal' },
  { label: '技术推动者', note: '重视研发与教育。', domain: 'technology' },
  { label: '贸易协调者', note: '重视跨城贸易与交通。', domain: 'trade' },
  { label: '民生守护者', note: '重视救助与住房。', domain: 'welfare' },
  { label: '财政稳健派', note: '重视税收与预算平衡。', domain: 'fiscal' },
];

const DOMAINS: PolicyDomain[] = [
  'employment',
  'enterprise',
  'industry',
  'technology',
  'trade',
  'welfare',
  'fiscal',
];

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function profileFor(city: City, index: number): LeaderProfile {
  const trait = TRAITS[(hashString(city.id) + index) % TRAITS.length]!;
  const leanings = {} as Record<PolicyDomain, number>;
  for (const domain of DOMAINS) {
    const base = (hashString(`${city.id}:${index}:${domain}`) % 60) / 100;
    leanings[domain] = round2(clamp(base + (domain === trait.domain ? 0.45 : 0), 0, 1));
  }
  const citySectors: SectorId[] = [
    'agriculture',
    'fiber-farm',
    'textile',
    'food',
    'garment',
    'metal',
    'utility',
    'appliance',
  ];
  const affinity =
    trait.sector ??
    citySectors[(hashString(`${city.id}:${index}:sector`) + index) % citySectors.length]!;
  return {
    sectorAffinity: affinity,
    domainLeanings: leanings,
    traitLabel: trait.label,
    traitNote: trait.note,
  };
}

export function createCandidate(city: City, index: number): Candidate {
  return {
    id: `${city.id}-candidate-${index + 1}`,
    cityId: city.id,
    name: FIRST_NAMES[(hashString(city.id) + index) % FIRST_NAMES.length]!,
    party: PARTIES[(hashString(`${city.id}:party`) + index) % PARTIES.length]!,
    profile: profileFor(city, index),
    popularity: round2(40 + ((hashString(`${city.id}:pop:${index}`) % 25) / 1)),
    note: '候选人（演示生成）：姓名、党派与倾向为程序生成，不代表最终选举制度。',
  };
}

export function createInitialPolitics(world: WorldState, config: DemoConfig): WorldPoliticsState {
  const cities: CityPoliticsState[] = [];
  const elections: ElectionRecord[] = [];
  for (const city of [...world.cities].sort((a, b) => a.id.localeCompare(b.id))) {
    const candidates = Array.from({ length: config.politics.candidatesPerCity }, (_, index) =>
      createCandidate(city, index),
    );
    const leader = candidates.reduce(
      (best, candidate) => (candidate.popularity > best.popularity ? candidate : best),
      candidates[0]!,
    );
    cities.push({
      cityId: city.id,
      candidates,
      leader,
      termMonthsLeft: config.politics.termMonths,
      electionCount: 0,
      lastElectionTick: null,
      lastResult: `初始领导人：${leader.name}（${leader.party}，${leader.profile.traitLabel}）。`,
    });
    elections.push({
      tick: world.time.tick,
      cityId: city.id,
      winnerId: leader.id,
      winnerName: leader.name,
      playerWon: false,
      note: '初始领导人按确定性规则产生，不是选举结果。',
    });
  }
  return { cities, elections };
}

export function cityPolitics(world: WorldState, cityId: string): CityPoliticsState | undefined {
  return world.politics.cities.find((entry) => entry.cityId === cityId);
}

export function leaderOf(world: WorldState, cityId: string) {
  return cityPolitics(world, cityId)?.leader ?? null;
}

/** 领导人重点行业的生产率加成（有上限，仅对特定行业有效）。 */
export function leaderSectorMultiplier(world: WorldState, cityId: string, sector: SectorId, config: DemoConfig): number {
  const leader = leaderOf(world, cityId);
  if (!leader || !leader.profile.sectorAffinity) return 1;
  if (leader.profile.sectorAffinity !== sector) return 1;
  return 1 + config.politics.sectorProductivityBonus;
}

export function playerIsMayor(world: WorldState, cityId: string): boolean {
  return world.player.roles?.mayorCityId === cityId;
}

/** 同步城市展示字段：支持率、执政党、选举倒计时。 */
function syncCityDisplay(world: WorldState, city: City): void {
  const state = cityPolitics(world, city.id);
  const mayor = playerIsMayor(world, city.id);
  const leader = state?.leader;
  city.politics = {
    approval: round2(clamp(city.politics.approval, 0, 100)),
    rulingParty: mayor ? '玩家执政（演示）' : leader?.party ?? city.politics.rulingParty,
    electionInMonths: state ? Math.max(0, state.termMonthsLeft) : null,
    status: 'active',
    note: mayor
      ? '玩家担任市长（演示身份）：政策由玩家选择，AI 不会代选。'
      : leader
        ? `现任领导人：${leader.name}（${leader.party}），重点行业 ${leader.profile.sectorAffinity ?? '—'}，${leader.profile.traitLabel}。`
        : '尚未产生领导人。',
  };
}

function electionScore(
  world: WorldState,
  candidate: Candidate,
  city: City,
  config: DemoConfig,
): number {
  const leadership = leaderOf(world, city.id);
  const leaderBonus = leadership?.id === candidate.id ? 6 : 0;
  const unemployment = city.population.laborForce > 0
    ? city.population.unemployed / city.population.laborForce
    : 0;
  // 就业与财政表现好的城市更认可现任者；这是演示规则。
  const performance = -unemployment * 80 + clamp(city.treasury / 1_000_000, -3, 3) * 2;
  return round2(candidate.popularity + leaderBonus + performance);
}

function holdElection(
  world: WorldState,
  city: City,
  config: DemoConfig,
  log: LogEntry[],
  playerRuns: boolean,
): ActionResult {
  const state = cityPolitics(world, city.id);
  if (!state) return { ok: false, error: '城市政治状态缺失' };
  if (state.candidates.length === 0) return { ok: false, error: '没有候选人' };

  const ranked = [...state.candidates]
    .map((candidate) => ({ candidate, score: electionScore(world, candidate, city, config) }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.candidate.popularity - a.candidate.popularity ||
        a.candidate.id.localeCompare(b.candidate.id),
    );
  const best = ranked[0]!;

  if (playerRuns) {
    // 【演示】玩家参选：财政稳健与低失业时胜出；参选费用已支付，失败不退。
    const unemployment = city.population.laborForce > 0
      ? city.population.unemployed / city.population.laborForce
      : 0;
    const playerScore = 50 + clamp(city.treasury / 500_000, -5, 5) * 2 - unemployment * 120;
    if (playerScore >= best.score) {
      world.player.roles.mayorCityId = city.id;
      state.leader = null;
      state.termMonthsLeft = config.politics.termMonths;
      state.electionCount += 1;
      state.lastElectionTick = world.time.tick;
      state.lastResult = `玩家以 ${playerScore.toFixed(1)} 分当选（竞选对手最高 ${best.score.toFixed(1)} 分，演示规则）。`;
      world.politics.elections.push({
        tick: world.time.tick,
        cityId: city.id,
        winnerId: 'player',
        winnerName: world.player.name,
        playerWon: true,
        note: state.lastResult,
      });
      log.push({
        tick: world.time.tick,
        kind: 'government',
        message: `${city.name} 选举：玩家当选市长（演示规则）。政策将由玩家选择。`,
      });
      syncCityDisplay(world, city);
      return { ok: true, note: state.lastResult };
    }
    state.lastResult = `玩家参选未当选：对手 ${best.candidate.name} 以 ${best.score.toFixed(1)} 分胜出（演示规则）。`;
    world.politics.elections.push({
      tick: world.time.tick,
      cityId: city.id,
      winnerId: best.candidate.id,
      winnerName: best.candidate.name,
      playerWon: false,
      note: state.lastResult,
    });
    log.push({
      tick: world.time.tick,
      kind: 'government',
      message: `${city.name} 选举：${best.candidate.name} 当选；玩家未当选（演示规则，参选费用不退回）。`,
    });
    state.leader = best.candidate;
    state.termMonthsLeft = config.politics.termMonths;
    state.electionCount += 1;
    state.lastElectionTick = world.time.tick;
    if (world.player.roles.mayorCityId === city.id) world.player.roles.mayorCityId = null;
    syncCityDisplay(world, city);
    return { ok: true, note: state.lastResult };
  }

  state.leader = best.candidate;
  state.termMonthsLeft = config.politics.termMonths;
  state.electionCount += 1;
  state.lastElectionTick = world.time.tick;
  state.lastResult = `${best.candidate.name}（${best.candidate.party}）当选，得分 ${best.score.toFixed(1)}。`;
  if (world.player.roles.mayorCityId === city.id) {
    world.player.roles.mayorCityId = null;
  }
  world.politics.elections.push({
    tick: world.time.tick,
    cityId: city.id,
    winnerId: best.candidate.id,
    winnerName: best.candidate.name,
    playerWon: false,
    note: state.lastResult,
  });
  log.push({
    tick: world.time.tick,
    kind: 'government',
    message: `${city.name} 选举：${best.candidate.name} 当选市长（${best.candidate.profile.traitLabel}）。`,
  });
  syncCityDisplay(world, city);
  return { ok: true, note: state.lastResult };
}

/**
 * v0.7：破产判定当月立即举行一次 AI 选举（DECISIONS v1.2 #8、任务书 §四）。
 * 玩家不参选（观战/参选入口仍走 runForMayor）；同一 tick 已有选举则不重复举行（幂等）。
 */
export function requestImmediateElection(
  world: WorldState,
  cityId: string,
  config: DemoConfig,
  log: LogEntry[] = [],
): ActionResult {
  const city = world.cities.find((entry) => entry.id === cityId);
  if (!city) return { ok: false, error: '城市不存在' };
  const state = cityPolitics(world, cityId);
  if (!state) return { ok: false, error: '城市政治状态缺失' };
  if (state.lastElectionTick === world.time.tick) {
    return { ok: true, note: '本 tick 已举行过选举' };
  }
  return holdElection(world, city, config, log, false);
}

/** 公开命令：玩家支付演示参选费用并立即举行一次选举。 */
export function runForMayor(
  world: WorldState,
  cityId: string,
  config: DemoConfig,
  log: LogEntry[] = [],
): ActionResult {
  const city = world.cities.find((entry) => entry.id === cityId);
  if (!city) return { ok: false, error: '城市不存在' };
  if (playerIsMayor(world, cityId)) return { ok: false, error: '你已经是该城市市长' };
  const cost = config.politics.electionCost;
  if (world.player.cash + 1e-6 < cost) {
    return { ok: false, error: `参选费用不足：需要 ${cost.toLocaleString('zh-CN')} 信用点` };
  }
  // 参选费用进入城市财政，资金守恒；失败不退款是演示规则。
  const paid = transmitPlayerCash(world, city, cost, '玩家参选费用（演示）', config);
  if (paid < cost - 0.01) return { ok: false, error: '参选费用支付失败' };
  return holdElection(world, city, config, log, true);
}

/** 月度推进：任期倒计时、到期选举、支持率漂移。 */
export function advancePolitics(
  world: WorldState,
  config: DemoConfig,
  tick: number,
  log: LogEntry[],
): void {
  for (const city of [...world.cities].sort((a, b) => a.id.localeCompare(b.id))) {
    const state = cityPolitics(world, city.id);
    if (!state) continue;
    const mayor = playerIsMayor(world, city.id);
    if (mayor) {
      // 玩家在任：不举行 AI 选举，也不把领导人被动属性套给玩家。
      state.leader = null;
      state.termMonthsLeft = Math.max(0, state.termMonthsLeft - 1);
      if (state.termMonthsLeft <= 0) {
        state.lastResult = '玩家任期届满（演示规则），将举行下一次选举。';
        holdElection(world, city, config, log, false);
      } else {
        syncCityDisplay(world, city);
      }
    } else {
      state.termMonthsLeft = Math.max(0, state.termMonthsLeft - 1);
      if (state.termMonthsLeft <= 0) {
        holdElection(world, city, config, log, false);
      } else {
        syncCityDisplay(world, city);
      }
    }

    // 支持率缓慢向“就业与财政表现”收敛（演示规则）。
    const unemployment = city.population.laborForce > 0
      ? city.population.unemployed / city.population.laborForce
      : 0;
    const target = clamp(70 - unemployment * 180 + clamp(city.treasury / 1_000_000, -2, 2) * 3, 5, 95);
    city.politics.approval = round2(clamp(city.politics.approval + (target - city.politics.approval) * 0.08, 0, 100));
    void tick;
  }
}

/** 供 AI 选政策使用：城市弱项的 0–1 评分（越高越需要该方向）。 */
export function cityWeaknesses(world: WorldState, city: City, config: DemoConfig): Record<PolicyDomain, number> {
  const unemployment = city.population.laborForce > 0
    ? city.population.unemployed / city.population.laborForce
    : 0;
  const treasuryMonths = city.lastMonth.publicWageBill > 0
    ? city.treasury / city.lastMonth.publicWageBill
    : 3;
  const gdpTrend = city.gdpHistory.length > 1
    ? (city.gdp - city.gdpHistory[city.gdpHistory.length - 2]!.value) /
      Math.max(1, city.gdpHistory[city.gdpHistory.length - 2]!.value)
    : 0;
  const transportLoad = world.transport.lastMonth.corridors
    .filter((entry) => entry.fromCityId === city.id)
    .reduce((max, entry) => Math.max(max, entry.overloadRatio), 0);
  const distressed = world.companies.filter((company) => {
    if (company.cityId !== city.id) return false;
    return company.ai.lossMonths >= 2;
  }).length;
  return {
    employment: clamp(unemployment * 6, 0, 1),
    enterprise: clamp(distressed / 3, 0, 1),
    industry: clamp(
      (world.companies.filter((company) => company.cityId === city.id && company.capacity < company.maxCapacity).length / 4) * 0.6,
      0,
      1,
    ),
    technology: clamp(1 - (city.technology.level / 5) * 0.5 - city.workforce.skillLevel, 0, 1),
    trade: clamp(transportLoad * 1.5, 0, 1),
    welfare: clamp(unemployment * 4, 0, 1),
    fiscal: clamp(1 - treasuryMonths / 4, 0, 1) * (gdpTrend < 0 ? 1 : 0.6),
  };
}

/** 【演示入口】直接授予玩家市长身份，用于验证玩家选政策的路径（不是选举结果）。 */
export function appointPlayerMayor(world: WorldState, cityId: string): ActionResult {
  const city = world.cities.find((entry) => entry.id === cityId);
  const state = cityPolitics(world, cityId);
  if (!city || !state) return { ok: false, error: '城市或政治状态不存在' };
  world.player.roles.mayorCityId = cityId;
  state.leader = null;
  state.termMonthsLeft = Math.max(1, state.termMonthsLeft);
  state.lastResult = '玩家以演示身份担任市长（不是选举结果）。';
  syncCityDisplay(world, city);
  return { ok: true, note: state.lastResult };
}

/** 【演示入口】退出市长身份：由当前候选人中支持度最高者接任，直到下一次选举。 */
export function stepDownPlayerMayor(world: WorldState, cityId: string): ActionResult {
  const city = world.cities.find((entry) => entry.id === cityId);
  const state = cityPolitics(world, cityId);
  if (!city || !state) return { ok: false, error: '城市或政治状态不存在' };
  if (world.player.roles.mayorCityId === cityId) world.player.roles.mayorCityId = null;
  if (!state.leader && state.candidates.length > 0) {
    state.leader = state.candidates.reduce(
      (best, candidate) => (candidate.popularity > best.popularity ? candidate : best),
      state.candidates[0]!,
    );
  }
  state.lastResult = '玩家退出市长职务（演示身份），由候选人按支持度接任。';
  syncCityDisplay(world, city);
  return { ok: true, note: state.lastResult };
}

export function incumbencySummary(world: WorldState, cityId: string): string {  const state = cityPolitics(world, cityId);
  if (!state) return '政治状态缺失';
  const mayor = playerIsMayor(world, cityId);
  if (mayor) return '玩家市长（演示）：政策由玩家选择，AI 不代选。';
  if (!state.leader) return '尚未产生领导人。';
  return `${state.leader.name} · ${state.leader.party} · ${state.leader.profile.traitLabel}（重点行业：${state.leader.profile.sectorAffinity ?? '—'}）`;
}
