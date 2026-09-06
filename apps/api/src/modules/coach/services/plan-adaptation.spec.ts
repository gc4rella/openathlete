import { PlanAdjustmentTrigger } from '@openathlete/database';

import {
  type AdaptationSignals,
  PlanAdaptationService,
  acwrFromWeeklyLoads,
} from './plan-adaptation.service';

/**
 * The decision function is pure, so it is tested directly with synthetic
 * signals rather than through a database.
 */
const service = new PlanAdaptationService(
  null as never,
  { emit: () => true } as never,
);

function signals(
  overrides: Partial<AdaptationSignals> = {},
): AdaptationSignals {
  return {
    completionRate: 0.85,
    plannedLoad: 400,
    actualLoad: 390,
    acwr: 1.05,
    worstPainScore: 0,
    injuryWorsening: false,
    rpeOvershoot: null,
    ...overrides,
  };
}

describe('acwrFromWeeklyLoads', () => {
  it('returns null without enough history', () => {
    expect(acwrFromWeeklyLoads([])).toBeNull();
    expect(acwrFromWeeklyLoads([500])).toBeNull();
  });

  it('returns null when the athlete has no chronic load', () => {
    expect(acwrFromWeeklyLoads([500, 0, 0, 0, 0, 0, 0])).toBeNull();
  });

  it('reports roughly 1 for steady training', () => {
    const steady = new Array<number>(7).fill(400);

    expect(acwrFromWeeklyLoads(steady)).toBeCloseTo(1, 1);
  });

  it('rises when the most recent week spikes', () => {
    const spike = [900, 400, 400, 400, 400, 400, 400];

    expect(acwrFromWeeklyLoads(spike)).toBeGreaterThan(1.5);
  });

  it('falls when the athlete has been resting', () => {
    const detrained = [100, 400, 400, 400, 400, 400, 400];

    expect(acwrFromWeeklyLoads(detrained)).toBeLessThan(0.8);
  });
});

describe('adaptation decisions', () => {
  it('does nothing when training is going to plan', () => {
    expect(service.decide(signals())).toBeNull();
  });

  describe('injury takes priority over everything', () => {
    it('removes impact for severe pain', () => {
      const decision = service.decide(
        signals({ worstPainScore: 7, acwr: 2.0, completionRate: 0.2 }),
      );

      expect(decision?.trigger).toBe(PlanAdjustmentTrigger.INJURY);
      expect(decision?.removeImpact).toBe(true);
      expect(decision?.downgradeQuality).toBe(true);
      expect(decision?.loadScale).toBeLessThan(1);
    });

    it('treats a worsening moderate injury as severe', () => {
      const decision = service.decide(
        signals({ worstPainScore: 4, injuryWorsening: true }),
      );

      expect(decision?.removeImpact).toBe(true);
    });

    it('only drops quality for a moderate stable niggle', () => {
      const decision = service.decide(signals({ worstPainScore: 4 }));

      expect(decision?.trigger).toBe(PlanAdjustmentTrigger.INJURY);
      expect(decision?.removeImpact).toBe(false);
      expect(decision?.downgradeQuality).toBe(true);
    });

    it('ignores minor discomfort', () => {
      expect(service.decide(signals({ worstPainScore: 2 }))).toBeNull();
    });
  });

  describe('load spikes', () => {
    it('cuts back hard above the high risk ratio', () => {
      const decision = service.decide(signals({ acwr: 1.8 }));

      expect(decision?.trigger).toBe(PlanAdjustmentTrigger.LOAD_SPIKE);
      expect(decision?.loadScale).toBe(0.8);
      expect(decision?.downgradeQuality).toBe(true);
    });

    it('trims gently above the optimal ratio', () => {
      const decision = service.decide(signals({ acwr: 1.4 }));

      expect(decision?.trigger).toBe(PlanAdjustmentTrigger.LOAD_SPIKE);
      expect(decision?.loadScale).toBe(0.9);
      expect(decision?.downgradeQuality).toBe(false);
    });

    it('quotes the actual ratio in the reason shown to the athlete', () => {
      const decision = service.decide(signals({ acwr: 1.42 }));

      expect(decision?.reason).toContain('1.42');
    });
  });

  it('scales back when the athlete cannot finish the week', () => {
    const decision = service.decide(signals({ completionRate: 0.4 }));

    expect(decision?.trigger).toBe(PlanAdjustmentTrigger.LOW_COMPLETION);
    expect(decision?.reason).toContain('40%');
  });

  it('eases off when sessions consistently feel too hard', () => {
    const decision = service.decide(signals({ rpeOvershoot: 2.1 }));

    expect(decision?.trigger).toBe(PlanAdjustmentTrigger.RPE_OVERSHOOT);
    expect(decision?.downgradeQuality).toBe(true);
  });

  it('ignores a small RPE difference', () => {
    expect(service.decide(signals({ rpeOvershoot: 0.8 }))).toBeNull();
  });

  it('adds load when the athlete is under-trained and completing everything', () => {
    const decision = service.decide(signals({ acwr: 0.6, completionRate: 1 }));

    expect(decision?.trigger).toBe(PlanAdjustmentTrigger.UNDERLOAD);
    expect(decision?.loadScale).toBeGreaterThan(1);
  });

  it('does not add load to an athlete who is missing sessions', () => {
    expect(
      service.decide(signals({ acwr: 0.6, completionRate: 0.7 })),
    ).toBeNull();
  });

  it('never acts on missing data alone', () => {
    const decision = service.decide(
      signals({ acwr: null, completionRate: null, rpeOvershoot: null }),
    );

    expect(decision).toBeNull();
  });

  it('always explains itself in language an athlete can read', () => {
    const cases: Array<Partial<AdaptationSignals>> = [
      { worstPainScore: 7 },
      { worstPainScore: 4 },
      { acwr: 1.8 },
      { acwr: 1.4 },
      { completionRate: 0.3 },
      { rpeOvershoot: 3 },
      { acwr: 0.5, completionRate: 1 },
    ];

    for (const override of cases) {
      const decision = service.decide(signals(override));

      expect(decision).not.toBeNull();
      expect(decision?.reason.length).toBeGreaterThan(40);
      expect(decision?.loadScale).toBeGreaterThan(0);
    }
  });
});
