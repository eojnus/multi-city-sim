// 人才市场保留规则（v0.4 验收问题 6）：
// - 人才池超限时只记录日志，不删除任何经营者档案（落选者未来仍可被聘用）；
// - 选任只复用同城 available 经营者，在任 AI 不会成为空闲候选；
// - 只有 AI 候选不足最低数时才新建，且受 maxNewPerElection 与 maxPoolPerCity 限制；
// - 选任期间候选人固定，池子维护不得改变已有议案。
import { describe, expect, it } from 'vitest';
import { createInitialWorld } from '../src/simulation/core/initializer';
import { DEMO_CONFIG } from '../src/data/config';
import type { DemoConfig } from '../src/data/config';
import type {
  Company,
  LogEntry,
  Motion,
  WorldState,
} from '../src/simulation/contracts/types';
import {
  availableOperators,
  currentOperator,
  generateOperator,
  operatorCityId,
  pruneOperatorPool,
  releaseOperator,
} from '../src/simulation/management/manager-pool';
import {
  electionCandidates,
  openOperatorElection,
} from '../src/simulation/management/elections';

function companyOf(world: WorldState, companyId: string): Company {
  const company = world.companies.find((candidate) => candidate.id === companyId);
  if (!company) throw new Error(`缺少企业 ${companyId}`);
  return company;
}

function controlOf(world: WorldState, companyId: string) {
  const control = world.governance.controls.find((entry) => entry.companyId === companyId);
  if (!control) throw new Error(`缺少控制记录 ${companyId}`);
  return control;
}

/** 制造职位空缺（原经营者离任回到人才市场）。 */
function makeVacancy(world: WorldState, companyId: string, tick = 0): void {
  const control = controlOf(world, companyId);
  if (control.operatorId) releaseOperator(world, control.operatorId, tick, '测试：制造空缺');
}

function openElectionFor(
  world: WorldState,
  companyId: string,
  config: DemoConfig = DEMO_CONFIG,
): { motion: Motion; logs: string[] } {
  const logEntries: LogEntry[] = [];
  const result = openOperatorElection(
    world,
    companyOf(world, companyId),
    config,
    world.time.tick,
    'termEnd',
    logEntries,
  );
  expect(result.ok, result.error).toBe(true);
  const motion = world.governance.motions.find(
    (entry) =>
      entry.kind === 'operatorElection' &&
      entry.companyId === companyId &&
      entry.status === 'open',
  );
  if (!motion) throw new Error(`缺少 ${companyId} 的选任议案`);
  return { motion, logs: logEntries.map((entry) => entry.message) };
}

function withPoolLimit(config: DemoConfig, maxPoolPerCity: number): DemoConfig {
  return {
    ...config,
    management: { ...config.management, maxPoolPerCity },
  } as unknown as DemoConfig;
}

describe('人才池超限：保留档案，不删人', () => {
  it('超过 maxPoolPerCity 时只写一条提示日志，经营者档案/履历/状态完全不变', () => {
    const world = createInitialWorld();
    const cityId = 'lanport';
    for (let index = 0; index < 10; index += 1) generateOperator(world, cityId, 0);
    const before = world.management!.operators.map((operator) => JSON.stringify(operator));
    const beforeAvailable = availableOperators(world, cityId).length;
    expect(beforeAvailable).toBeGreaterThan(DEMO_CONFIG.management.maxPoolPerCity);

    pruneOperatorPool(world, DEMO_CONFIG, 3);

    // 不删档：数量、顺序、内容（status/companyId/history）全部保持不变。
    expect(world.management!.operators.map((operator) => JSON.stringify(operator))).toEqual(before);
    expect(availableOperators(world, cityId).length).toBe(beforeAvailable);
    expect(
      world.log.some(
        (entry) =>
          entry.message.includes('人才市场调整') &&
          entry.message.includes('保留全部现有档案') &&
          entry.message.includes('岚港'),
      ),
    ).toBe(true);

    // 每月都会超限，但同一提示只保留一条。
    const noticeCount = world.log.filter((entry) => entry.message.includes('人才市场调整')).length;
    pruneOperatorPool(world, DEMO_CONFIG, 4);
    expect(
      world.log.filter((entry) => entry.message.includes('人才市场调整')).length,
    ).toBe(noticeCount);
  });

  it('选任期间候选人固定：池子维护不会修改已有议案或让候选人失效', () => {
    const world = createInitialWorld();
    makeVacancy(world, 'gf-food');
    const { motion } = openElectionFor(world, 'gf-food');
    const snapshot = JSON.stringify(motion.candidates);

    // 同一城市制造远超上限的闲置档案。
    for (let index = 0; index < 20; index += 1) generateOperator(world, 'greenfield', 0);
    const operatorCountBefore = world.management!.operators.length;
    pruneOperatorPool(world, DEMO_CONFIG, 5);
    expect(world.management!.operators.length).toBe(operatorCountBefore);
    expect(JSON.stringify(motion.candidates)).toBe(snapshot);

    for (const candidate of motion.candidates ?? []) {
      if (!candidate.operatorId) continue;
      const profile = world.management!.operators.find(
        (operator) => operator.id === candidate.operatorId,
      );
      expect(profile).toBeTruthy();
      expect(profile!.status).toBe('available');
    }
  });
});

describe('选任候选人：同城 available、在任不可用、限制新增', () => {
  it('候选人来自同城 available 人才市场，在任 AI 不会成为空闲候选', () => {
    const world = createInitialWorld();
    const incumbent = controlOf(world, 'lp-food').operatorId;
    const { motion } = openElectionFor(world, 'lp-food');
    const candidates = motion.candidates ?? [];

    expect(candidates).toHaveLength(DEMO_CONFIG.management.candidatesPerElection);
    expect(candidates[0]!.isIncumbent).toBe(true);
    expect(candidates[0]!.candidateId).toBe(incumbent);

    const challengers = candidates.filter((candidate) => candidate.kind === 'ai' && !candidate.isIncumbent);
    expect(challengers.length).toBeGreaterThan(0);
    for (const candidate of challengers) {
      const profile = world.management!.operators.find(
        (operator) => operator.id === candidate.operatorId,
      );
      expect(profile).toBeTruthy();
      // 空闲候选：未任职，且与选任企业同城。
      expect(profile!.status).toBe('available');
      expect(operatorCityId(profile!)).toBe('lanport');
    }

    // 其他企业的在任 AI 不会出现在候选人名单里。
    const employedElsewhere = world.management!.operators.filter(
      (operator) => operator.status === 'employed' && operator.id !== incumbent,
    );
    expect(employedElsewhere.length).toBeGreaterThan(0);
    for (const operator of employedElsewhere) {
      expect(candidates.some((candidate) => candidate.operatorId === operator.id)).toBe(false);
    }
  });

  it('池子达到 maxPoolPerCity 后不再新建；候选不足时仍可开启选任', () => {
    const world = createInitialWorld();
    // 模拟一个 available 档案很少的城市（旧存档/长期无人问津），并把上限设为 2。
    world.management!.operators = world.management!.operators.filter(
      (operator) => !(operator.status === 'available' && operatorCityId(operator) === 'greenfield'),
    );
    const config = withPoolLimit(DEMO_CONFIG, 2);

    makeVacancy(world, 'gf-food'); // 原经营者回到人才市场 → available = 1
    const { motion: first } = openElectionFor(world, 'gf-food', config);
    expect(availableOperators(world, 'greenfield').length).toBe(2);
    // 无现任：AI 候选最低 2 名，池中已有 1 名，因此只补建 1 名（受剩余容量限制）。
    expect(first.candidates).toHaveLength(2);
    expect(first.candidates!.every((candidate) => candidate.kind === 'ai')).toBe(true);

    // 另一个空缺：同城 available 已达上限，候选不足（只有 1 名未被其他议案提名）时
    // 不再新建，但仍能开启选任（至少 1 名 AI 候选）。
    makeVacancy(world, 'gf-fiber');
    const availableBefore = availableOperators(world, 'greenfield').length;
    const { motion: second } = openElectionFor(world, 'gf-fiber', config);
    expect(second.candidates).toHaveLength(1);
    expect(availableOperators(world, 'greenfield').length).toBe(availableBefore);
  });

  it('直接调用 electionCandidates 也遵守同城与“不新增”规则', () => {
    const world = createInitialWorld();
    // 先制造空缺（现任回到人才市场），再清空 lanport 的可用档案：
    // 空池 + 上限为 0 时只能复用、不能新建。
    makeVacancy(world, 'lp-food');
    world.management!.operators = world.management!.operators.filter(
      (operator) => !(operator.status === 'available' && operatorCityId(operator) === 'lanport'),
    );
    const config = withPoolLimit(DEMO_CONFIG, 0);
    const company = companyOf(world, 'lp-food');
    const candidates = electionCandidates(world, company, config, world.time.tick);
    // 空池 + 无新建：只能没有候选人；上层会以“没有可用候选人”报错，但绝不删档。
    expect(candidates).toHaveLength(0);
    expect(
      world.management!.operators.some(
        (operator) => operator.status === 'available' && operatorCityId(operator) === 'lanport',
      ),
    ).toBe(false);
  });

  it('落选者档案保留，可被后续选任重新复用（不重新生成新人）', () => {
    const world = createInitialWorld();
    // 让某企业现任离任 → 回到同城人才市场；随后选任应从池中复用它，而不是新建。
    const companyId = 'gf-food';
    const releasedId = controlOf(world, companyId).operatorId!;
    makeVacancy(world, companyId);
    // v1.0 开局 65 家企业后同城人才市场更大；抬高该落选者声望，确保其进入前 3 名候选，
    // 验证的仍是“落选档案被复用、不新建新人”。
    const released = world.management!.operators.find((operator) => operator.id === releasedId)!;
    released.reputation = 999;
    const operatorCount = world.management!.operators.length;
    const { motion } = openElectionFor(world, companyId);
    expect(
      motion.candidates!.some((candidate) => candidate.operatorId === releasedId),
    ).toBe(true);
    expect(world.management!.operators.length).toBe(operatorCount);
  });
});

describe('在任经营者不是空闲候选（辅助断言）', () => {
  it('availableOperators 只返回 available 状态，已任职者不在其中', () => {
    const world = createInitialWorld();
    const employedIds = new Set(
      world.management!.operators
        .filter((operator) => operator.status === 'employed')
        .map((operator) => operator.id),
    );
    expect(employedIds.size).toBeGreaterThan(0);
    for (const city of world.cities) {
      for (const operator of availableOperators(world, city.id)) {
        expect(operator.status).toBe('available');
        expect(employedIds.has(operator.id)).toBe(false);
      }
    }
    // currentOperator 与空闲池不重叠。
    const current = currentOperator(world, 'lp-food');
    expect(current).not.toBeNull();
    expect(availableOperators(world, 'lanport').some((operator) => operator.id === current!.id)).toBe(
      false,
    );
  });
});
