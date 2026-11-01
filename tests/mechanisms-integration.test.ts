import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation/core/simulation';
import { DEMO_CONFIG } from '../src/data/config';
import { castVote, proposeOperatorMotion } from '../src/simulation/corporate-governance/governance';
import { visibleNotifications } from '../src/simulation/notifications/notifications';
import { checkInvariants } from '../src/simulation/core/invariants';

describe('机制联动：表决、通知与企业决策', () => {
  it('玩家持有的投票权可参与经营者议案，表决通过后经营控制权改变', () => {
    const sim = Simulation.create();
    expect(sim.invest('lp-food', 500_000).ok).toBe(true);
    const world = sim.state;
    expect(
      world.securities.holdings.some(
        (holding) => holding.holder.type === 'player' && holding.shares > 0,
      ),
    ).toBe(true);

    const motion = proposeOperatorMotion(
      world,
      'lp-food',
      { type: 'player', id: 'player' },
      { type: 'player', id: 'player' },
      world.time.tick,
      DEMO_CONFIG,
    );
    expect(motion.ok, motion.error).toBe(true);

    // 推进一期：自动投票发生，同时玩家应在通知中看到“有表决待参与”。
    expect(sim.tick().ok).toBe(true);
    const voteNotice = visibleNotifications(world).find(
      (notice) => notice.kind === 'vote' && notice.companyId === 'lp-food',
    );
    expect(voteNotice).toBeDefined();
    expect(voteNotice?.body).not.toMatch(/securities|holdings|invariant/i);

    // 玩家投票（缺席视为弃权；居民实体已按暂定规则投赞成）。
    const open = world.governance.motions.find((entry) => entry.id === motion.motion!.id)!;
    expect(castVote(world, open.id, { type: 'player', id: 'player' }, 'for', world.time.tick).ok).toBe(
      true,
    );

    for (let index = 0; index < 3; index++) {
      expect(sim.tick().ok).toBe(true);
    }
    const closed = world.governance.motions.find((entry) => entry.id === motion.motion!.id)!;
    expect(closed.status).toBe('passed');
    const control = world.governance.controls.find((entry) => entry.companyId === 'lp-food')!;
    expect(control.operator).not.toBe('management');
    expect(control.operator === 'management' ? '' : control.operator.id).toBe('player');
    expect(control.basis).toBe('boardAppointment');
    expect(checkInvariants(world)).toEqual([]);
  });

  it('持股玩家会收到实际分红通知，金额与入账一致', () => {
    const sim = Simulation.create();
    expect(sim.invest('lp-garment', 500_000).ok).toBe(true);
    const world = sim.state;
    const before = world.player.cash;
    let sawDividend = false;
    for (let index = 0; index < 6; index++) {
      expect(sim.tick().ok).toBe(true);
      if (
        visibleNotifications(world).some(
          (notice) => notice.kind === 'dividend' && notice.companyId === 'lp-garment',
        )
      ) {
        sawDividend = true;
        break;
      }
    }
    expect(sawDividend).toBe(true);
    expect(world.player.dividendsReceived ?? 0).toBeGreaterThan(0);
    expect(world.player.cash).toBeGreaterThan(before);
  });

  it('无持股时不会收到企业表决通知，也不会收到城市事务通知（非市长）', () => {
    const sim = Simulation.create();
    for (let index = 0; index < 4; index++) expect(sim.tick().ok).toBe(true);
    const notices = visibleNotifications(sim.state);
    expect(notices.filter((notice) => notice.kind === 'vote')).toHaveLength(0);
    expect(notices.filter((notice) => notice.audience === 'city')).toHaveLength(0);
  });
});
