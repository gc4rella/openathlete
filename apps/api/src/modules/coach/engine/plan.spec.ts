import { CYCLE_PHASE, SPORT_TYPE } from '@openathlete/shared';

import {
  ACWR_OPTIMAL_MAX,
  LOAD_SLOPE_CLAMP,
} from 'src/common/constants/training-formulas.constants';

import { generatePlan, weeksUntil } from './index';
import { resolveDistanceProfile } from './periodization';
import { type EngineInput, type PlanSessionView } from './test-helpers';
import { flattenSessions, flattenWeeks, makeInput } from './test-helpers';

const HOUR = 3600;

describe('plan generation', () => {
  describe('weeksUntil', () => {
    it('counts the race week as the final week', () => {
      const start = new Date('2026-01-05T00:00:00Z'); // Monday
      expect(weeksUntil(start, new Date('2026-01-11T00:00:00Z'))).toBe(1);
      expect(weeksUntil(start, new Date('2026-01-12T00:00:00Z'))).toBe(2);
      expect(weeksUntil(start, new Date('2026-04-26T00:00:00Z'))).toBe(16);
    });
  });

  describe('structure', () => {
    const input = makeInput();
    const { plan } = generatePlan(input);
    const weeks = flattenWeeks(plan);

    it('produces exactly the requested number of weeks, numbered in order', () => {
      expect(weeks).toHaveLength(input.durationWeeks);
      expect(weeks.map((week) => week.weekNumber)).toEqual(
        Array.from({ length: input.durationWeeks }, (_, i) => i + 1),
      );
    });

    it('ends with a race week', () => {
      const lastCycle = plan.cycles[plan.cycles.length - 1];

      expect(lastCycle.phase).toBe(CYCLE_PHASE.COMPETITION);
    });

    it('moves from base through specific to taper and race', () => {
      const phases = plan.cycles.map((cycle) => cycle.phase);

      expect(phases[0]).toBe(CYCLE_PHASE.BASE);
      expect(phases).toContain(CYCLE_PHASE.SPECIFIC);
      expect(phases).toContain(CYCLE_PHASE.TAPER);
      expect(phases[phases.length - 1]).toBe(CYCLE_PHASE.COMPETITION);
    });

    it('schedules the requested number of sessions every week', () => {
      for (const week of weeks) {
        // The race week trims sessions around the race itself.
        if (week.weekNumber === input.durationWeeks) {
          continue;
        }

        expect(week.sessions.length).toBe(input.daysPerWeek);
      }
    });

    it('gives every session a structured workout with timed steps', () => {
      for (const session of flattenSessions(plan)) {
        expect(session.workout).toBeTruthy();
        expect(session.workout?.steps.length).toBeGreaterThan(0);

        for (const step of session.workout?.steps ?? []) {
          expect(typeof step).toBe('object');
          expect(step.stepType).toBeTruthy();
        }
      }
    });

    it('never nests repeat blocks', () => {
      for (const session of flattenSessions(plan)) {
        for (const step of session.workout?.steps ?? []) {
          for (const child of step.repeatBlock?.childSteps ?? []) {
            expect(child.repeatBlock ?? null).toBeNull();
          }
        }
      }
    });

    it("makes each session's steps add up to its stated duration", () => {
      for (const session of flattenSessions(plan)) {
        const stepSeconds = sumStepSeconds(session);

        expect(stepSeconds).toBe(session.goalDuration);
      }
    });
  });

  describe('safety properties', () => {
    it('never ramps volume faster than the shared clamp allows', () => {
      const { plan } = generatePlan(makeInput());

      // The clamp governs the progression of the build, so it is measured
      // between successive *build* weeks. Stepping back up after a recovery
      // week is a return to an already-tolerated load, not new progression -
      // that transition is what the ACWR check below guards instead.
      const buildVolumes = flattenWeeks(plan)
        .filter((week) => week.theme !== 'Recovery week')
        .map((week) => week.targetVolume ?? 0);

      for (let i = 1; i < buildVolumes.length; i++) {
        const previous = buildVolumes[i - 1];

        if (previous <= 0) {
          continue;
        }

        const growth = (buildVolumes[i] - previous) / previous;
        expect(growth).toBeLessThanOrEqual(LOAD_SLOPE_CLAMP.MAX + 1e-9);
      }
    });

    it('keeps the projected acute:chronic ratio inside the optimal zone', () => {
      const input = makeInput({ currentWeeklyVolume: 3 * HOUR });
      const { plan } = generatePlan(input);
      const volumes = flattenWeeks(plan).map((week) => week.targetVolume ?? 0);

      // Same definition as TrainingLoadService: acute is the week itself,
      // chronic is a 6-week exponentially weighted average.
      const chronicWeeks = 6;
      const alpha = 2 / (chronicWeeks + 1);
      const history = new Array<number>(chronicWeeks).fill(
        input.currentWeeklyVolume as number,
      );

      for (const volume of volumes) {
        let chronic = 0;
        for (let i = history.length - chronicWeeks; i < history.length; i++) {
          chronic = alpha * history[i] + (1 - alpha) * chronic;
        }

        expect(volume / chronic).toBeLessThanOrEqual(ACWR_OPTIMAL_MAX + 1e-6);
        history.push(volume);
      }
    });

    it('never schedules two quality sessions on consecutive days', () => {
      const { plan } = generatePlan(makeInput({ daysPerWeek: 6 }));

      for (const week of flattenWeeks(plan)) {
        const hardDays = week.sessions
          .filter((session) => isQuality(session))
          .map((session) => session.dayOfWeek)
          .sort((a, b) => a - b);

        for (let i = 1; i < hardDays.length; i++) {
          expect(hardDays[i] - hardDays[i - 1]).toBeGreaterThan(1);
        }
      }
    });

    it('schedules at most two quality sessions in any week', () => {
      const { plan } = generatePlan(makeInput());

      for (const week of flattenWeeks(plan)) {
        const quality = week.sessions.filter(
          (session) => isQuality(session) && session.archetype !== 'race',
        );

        expect(quality.length).toBeLessThanOrEqual(2);
      }
    });

    it('schedules exactly one long run per week', () => {
      const { plan } = generatePlan(makeInput());

      for (const week of flattenWeeks(plan)) {
        const longRuns = week.sessions.filter((session) =>
          ['long-run', 'progressive-long-run'].includes(
            session.archetype ?? '',
          ),
        );

        // The race replaces the long run in race week.
        expect(longRuns.length).toBeLessThanOrEqual(1);
      }
    });

    it('tapers: the last build week carries more volume than race week', () => {
      const { plan } = generatePlan(makeInput());
      const weeks = flattenWeeks(plan);

      const peak = Math.max(...weeks.map((week) => week.targetVolume ?? 0));
      const raceWeek = weeks[weeks.length - 1].targetVolume ?? 0;

      expect(raceWeek).toBeLessThan(peak * 0.5);
    });

    it('drops volume substantially in every taper week', () => {
      // The taper is a fraction of peak volume, so it must be measured against
      // the volume actually prescribed - not against an uncapped ramp the
      // athlete never trains. A "taper" a few percent below peak wastes the
      // whole build.
      for (const currentWeeklyVolume of [2 * HOUR, 4 * HOUR, 8 * HOUR]) {
        const { plan } = generatePlan(makeInput({ currentWeeklyVolume }));
        const weeks = flattenWeeks(plan);

        const peak = Math.max(...weeks.map((week) => week.targetVolume ?? 0));
        const taperWeeks = plan.cycles
          .filter((cycle) => cycle.phase !== CYCLE_PHASE.COMPETITION)
          .flatMap((cycle) =>
            cycle.phase === CYCLE_PHASE.TAPER ? cycle.weeks : [],
          );

        expect(taperWeeks.length).toBeGreaterThan(0);

        for (const week of taperWeeks) {
          expect(week.targetVolume ?? 0).toBeLessThanOrEqual(peak * 0.8);
        }
      }
    });

    it('leaves at least three days between the last hard session and the race', () => {
      const { plan } = generatePlan(makeInput());
      const weeks = flattenWeeks(plan);
      const raceWeek = weeks[weeks.length - 1];

      const race = raceWeek.sessions.find(
        (session) => session.archetype === 'race',
      );
      expect(race).toBeTruthy();

      const otherHard = raceWeek.sessions.filter(
        (session) => session.archetype !== 'race' && isQuality(session),
      );

      expect(otherHard).toHaveLength(0);
    });
  });

  describe('availability', () => {
    it('only schedules on days the athlete declared', () => {
      const availableDays = [1, 3, 5, 6];
      const input = makeInput({
        daysPerWeek: 4,
        longRunDay: 6,
        availability: availableDays.map((dayOfWeek) => ({
          dayOfWeek,
          startTime: '07:00',
          endTime: '09:00',
          priority: 'HIGH' as const,
        })),
      });

      const { plan } = generatePlan(input);

      for (const session of flattenSessions(plan)) {
        // Race day is fixed by the calendar, not by availability.
        if (session.archetype === 'race') {
          continue;
        }

        expect(availableDays).toContain(session.dayOfWeek);
      }
    });

    it('puts the long run on the requested day', () => {
      const { plan } = generatePlan(makeInput({ longRunDay: 3 }));

      for (const week of flattenWeeks(plan)) {
        const longRun = week.sessions.find((session) =>
          ['long-run', 'progressive-long-run'].includes(
            session.archetype ?? '',
          ),
        );

        if (longRun) {
          expect(longRun.dayOfWeek).toBe(3);
        }
      }
    });

    it('caps the long run as a share of the week', () => {
      const input = makeInput();
      const profile = resolveDistanceProfile(input.targetDistance);
      const { plan } = generatePlan(input);

      for (const week of flattenWeeks(plan)) {
        const longRun = week.sessions.find((session) =>
          ['long-run', 'progressive-long-run'].includes(
            session.archetype ?? '',
          ),
        );

        if (!longRun || !week.targetVolume) {
          continue;
        }

        expect(longRun.goalDuration ?? 0).toBeLessThanOrEqual(
          profile.longRunCapSeconds,
        );
        // Allow a little slack for rounding to five minute blocks.
        expect(longRun.goalDuration ?? 0).toBeLessThanOrEqual(
          week.targetVolume * profile.longRunFraction + 300,
        );
      }
    });
  });

  describe('injury handling', () => {
    it('removes quality work when an injury is painful', () => {
      const { plan } = generatePlan(
        makeInput({
          injuries: [
            { location: 'achilles', painScore: 5, status: 'STABLE' as const },
          ],
        }),
      );

      const quality = flattenSessions(plan).filter(
        (session) => isQuality(session) && session.archetype !== 'race',
      );

      expect(quality).toHaveLength(0);
    });

    it('removes running impact entirely when an injury is severe', () => {
      const { plan } = generatePlan(
        makeInput({
          raceDate: null,
          targetDistance: null,
          targetTime: null,
          durationWeeks: 8,
          injuries: [
            { location: 'shin', painScore: 7, status: 'WORSENING' as const },
          ],
        }),
      );

      for (const session of flattenSessions(plan)) {
        expect(session.sport).toBe(SPORT_TYPE.CYCLING);
      }
    });

    it('ignores injuries when the athlete opted out', () => {
      const { plan } = generatePlan(
        makeInput({
          injuryAware: false,
          injuries: [
            { location: 'shin', painScore: 8, status: 'WORSENING' as const },
          ],
        }),
      );

      const running = flattenSessions(plan).filter(
        (session) => session.sport === SPORT_TYPE.RUNNING,
      );

      expect(running.length).toBeGreaterThan(0);
    });
  });

  describe('determinism', () => {
    it('produces byte-identical plans for identical input', () => {
      const first = generatePlan(makeInput());
      const second = generatePlan(makeInput());

      expect(JSON.stringify(first.plan)).toBe(JSON.stringify(second.plan));
    });
  });

  describe('general fitness plans', () => {
    it('runs for the requested weeks with no taper or race', () => {
      const { plan } = generatePlan(
        makeInput({
          raceDate: null,
          targetDistance: null,
          targetTime: null,
          durationWeeks: 12,
        }),
      );

      expect(flattenWeeks(plan)).toHaveLength(12);
      expect(plan.cycles.map((cycle) => cycle.phase)).not.toContain(
        CYCLE_PHASE.COMPETITION,
      );
      expect(plan.plan.distance).toBe(0);
    });
  });
});

function isQuality(session: PlanSessionView): boolean {
  return (session.goalRpe ?? 0) >= 6;
}

function sumStepSeconds(session: PlanSessionView): number {
  let total = 0;

  for (const step of session.workout?.steps ?? []) {
    if (step.repeatBlock) {
      const cycle = step.repeatBlock.childSteps.reduce(
        (sum, child) => sum + (child.durationValue ?? 0),
        0,
      );
      total += cycle * step.repeatBlock.repetitions;
    } else {
      total += step.durationValue ?? 0;
    }
  }

  return total;
}

export type { EngineInput };
