import { CYCLE_PHASE } from '@openathlete/shared';

import { estimateTrimp, heartRateReserveFraction } from './load-estimator';
import { resolveDistanceProfile } from './periodization';
import { paceTableForVdot, resolveFitness } from './physiology';
import { makeInput } from './test-helpers';
import { RunIntensity, type WeekSkeleton } from './types';
import {
  buildWeek,
  chooseQualityDays,
  chooseTrainingDays,
  circularDayDistance,
  hardFraction,
  resolveInjuryPolicy,
} from './week-builder';

const HOUR = 3600;

function makeWeek(overrides: Partial<WeekSkeleton> = {}): WeekSkeleton {
  return {
    weekNumber: 5,
    phase: CYCLE_PHASE.SPECIFIC,
    isRecovery: false,
    targetVolume: 5 * HOUR,
    qualityCount: 2,
    isRaceWeek: false,
    ...overrides,
  };
}

function makeContext(inputOverrides = {}) {
  const input = makeInput(inputOverrides);
  const fitness = resolveFitness(input.fitness, {
    distanceMeters: input.targetDistance,
    timeSeconds: input.targetTime,
  });

  return {
    input,
    profile: resolveDistanceProfile(input.targetDistance),
    paces: paceTableForVdot(fitness.currentVdot),
    fitness,
    rotationOffset: 1,
    racePace: null,
  };
}

describe('week builder', () => {
  describe('circularDayDistance', () => {
    it('wraps around the end of the week', () => {
      expect(circularDayDistance(0, 6)).toBe(1);
      expect(circularDayDistance(6, 0)).toBe(1);
      expect(circularDayDistance(0, 3)).toBe(3);
      expect(circularDayDistance(2, 2)).toBe(0);
    });
  });

  describe('chooseTrainingDays', () => {
    it('honours the requested long run day', () => {
      expect(chooseTrainingDays([], 4, 6)).toContain(6);
    });

    it('prefers days the athlete declared as available', () => {
      const days = chooseTrainingDays(
        [1, 3, 5].map((dayOfWeek) => ({
          dayOfWeek,
          startTime: '06:00',
          endTime: '09:00',
          priority: 'HIGH' as const,
        })),
        3,
        null,
      );

      expect(days.sort()).toEqual([1, 3, 5]);
    });

    it('prefers high priority windows over low priority ones', () => {
      const days = chooseTrainingDays(
        [
          {
            dayOfWeek: 1,
            startTime: '06:00',
            endTime: '07:00',
            priority: 'LOW' as const,
          },
          {
            dayOfWeek: 4,
            startTime: '06:00',
            endTime: '07:00',
            priority: 'HIGH' as const,
          },
        ],
        1,
        null,
      );

      expect(days).toEqual([4]);
    });

    it('spreads sessions instead of stacking them on consecutive days', () => {
      const days = chooseTrainingDays([], 3, null);

      for (let i = 1; i < days.length; i++) {
        expect(days[i] - days[i - 1]).toBeGreaterThan(1);
      }
    });
  });

  describe('chooseQualityDays', () => {
    it('spaces quality days away from the long run and each other', () => {
      // The case greedy selection gets wrong: six training days with the long
      // run on Sunday.
      const quality = chooseQualityDays([0, 1, 2, 3, 4, 6], 0, 2);
      const hardDays = [0, ...quality].sort((a, b) => a - b);

      for (let i = 1; i < hardDays.length; i++) {
        expect(
          circularDayDistance(hardDays[i], hardDays[i - 1]),
        ).toBeGreaterThan(1);
      }
    });

    it('returns nothing when no quality is requested', () => {
      expect(chooseQualityDays([1, 3, 5], 5, 0)).toEqual([]);
    });

    it('never returns the long run day', () => {
      expect(chooseQualityDays([1, 3, 5], 3, 2)).not.toContain(3);
    });
  });

  describe('resolveInjuryPolicy', () => {
    it('ignores resolved injuries', () => {
      expect(
        resolveInjuryPolicy(
          [{ location: 'knee', painScore: 9, status: 'RESOLVED' }],
          true,
        ),
      ).toBe('NONE');
    });

    it('escalates with pain', () => {
      expect(
        resolveInjuryPolicy(
          [{ location: 'knee', painScore: 2, status: 'STABLE' }],
          true,
        ),
      ).toBe('NONE');
      expect(
        resolveInjuryPolicy(
          [{ location: 'knee', painScore: 4, status: 'STABLE' }],
          true,
        ),
      ).toBe('CAUTION');
      expect(
        resolveInjuryPolicy(
          [{ location: 'knee', painScore: 7, status: 'STABLE' }],
          true,
        ),
      ).toBe('SEVERE');
    });

    it('treats a worsening moderate injury as severe', () => {
      expect(
        resolveInjuryPolicy(
          [{ location: 'knee', painScore: 4, status: 'WORSENING' }],
          true,
        ),
      ).toBe('SEVERE');
    });
  });

  describe('polarised intensity distribution', () => {
    it('keeps time at threshold or above under the 80/20 ceiling', () => {
      // Measured on the actual intensity segments, so a quality session's easy
      // warmup and cooldown count as easy - which is the whole point of the
      // guideline.
      for (const qualityCount of [1, 2]) {
        const sessions = buildWeek(makeWeek({ qualityCount }), makeContext());

        expect(hardFraction(sessions)).toBeLessThanOrEqual(0.22 + 1e-9);
      }
    });

    it('has no hard time at all in a recovery week', () => {
      const sessions = buildWeek(
        makeWeek({ isRecovery: true, qualityCount: 0 }),
        makeContext(),
      );

      expect(hardFraction(sessions)).toBe(0);
    });
  });

  describe('volume delivery', () => {
    it('schedules close to the volume the periodizer asked for', () => {
      const week = makeWeek();
      const sessions = buildWeek(week, makeContext());

      const scheduled = sessions.reduce(
        (total, session) => total + session.skeleton.durationSeconds,
        0,
      );

      // Sessions are rounded to five minute blocks and clamped, so exact
      // equality is not achievable; 5% is well inside coaching tolerance.
      expect(
        Math.abs(scheduled - week.targetVolume) / week.targetVolume,
      ).toBeLessThan(0.05);
    });
  });
});

describe('load estimation', () => {
  const fitness = resolveFitness({ hrMax: 190, hrRest: 50, gender: 'male' });

  it('places intensities in ascending order of heart rate reserve', () => {
    const fractions = [
      RunIntensity.RECOVERY,
      RunIntensity.EASY,
      RunIntensity.MARATHON,
      RunIntensity.THRESHOLD,
      RunIntensity.INTERVAL,
    ].map((intensity) => heartRateReserveFraction(intensity, fitness));

    for (let i = 1; i < fractions.length; i++) {
      expect(fractions[i]).toBeGreaterThan(fractions[i - 1]);
    }
  });

  it('scales linearly with duration', () => {
    const oneHour = estimateTrimp(
      [{ durationSeconds: HOUR, intensity: RunIntensity.EASY }],
      fitness,
    );
    const twoHours = estimateTrimp(
      [{ durationSeconds: 2 * HOUR, intensity: RunIntensity.EASY }],
      fitness,
    );

    expect(twoHours).toBeCloseTo(oneHour * 2, 6);
  });

  it('weights intensity exponentially, as Bannister TRIMP does', () => {
    const easy = estimateTrimp(
      [{ durationSeconds: HOUR, intensity: RunIntensity.EASY }],
      fitness,
    );
    const threshold = estimateTrimp(
      [{ durationSeconds: HOUR, intensity: RunIntensity.THRESHOLD }],
      fitness,
    );

    // An hour at threshold must cost meaningfully more than an hour easy.
    expect(threshold).toBeGreaterThan(easy * 2);
  });

  it('produces a plausible TRIMP for an hour of easy running', () => {
    const trimp = estimateTrimp(
      [{ durationSeconds: HOUR, intensity: RunIntensity.EASY }],
      fitness,
    );

    expect(trimp).toBeGreaterThan(30);
    expect(trimp).toBeLessThan(120);
  });

  it('returns zero for an empty or zero-length session', () => {
    expect(estimateTrimp([], fitness)).toBe(0);
    expect(
      estimateTrimp(
        [{ durationSeconds: 0, intensity: RunIntensity.INTERVAL }],
        fitness,
      ),
    ).toBe(0);
  });
});
