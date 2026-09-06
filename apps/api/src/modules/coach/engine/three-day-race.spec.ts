import { CYCLE_PHASE } from '@openathlete/shared';

import { generatePlan } from './index';
import { paceTableForVdot } from './physiology';
import { ARCHETYPES, type ArchetypeKey } from './session-templates';
import { flattenWeeks, makeInput } from './test-helpers';

const input = makeInput({
  startDate: new Date('2026-09-06'), raceDate: new Date('2026-12-21'),
  durationWeeks: 16, daysPerWeek: 3, longRunDay: 6,
  targetDistance: 21097.5, targetTime: 6000,
  currentWeeklyVolume: 10211, recentLongestRun: 6984,
});
const isQuality = (archetype: string | null | undefined) => ARCHETYPES[archetype as ArchetypeKey]?.isQuality;

describe('three-day half-marathon race builds', () => {
  it('includes one quality workout, easy running and a longer long run', () => {
    const { plan } = generatePlan(input);
    const weeks = flattenWeeks(plan);
    const archetypes = weeks.flatMap(week => week.sessions.map(session => session.archetype));
    expect(archetypes).toContain('threshold');
    expect(archetypes).toContain('cruise-intervals');
    expect(archetypes).toContain('race-pace');
    for (const week of weeks.filter(week => week.phase !== CYCLE_PHASE.COMPETITION)) {
      expect(week.sessions).toHaveLength(3);
      const quality = week.sessions.filter(session => isQuality(session.archetype));
      expect(quality.length).toBeLessThanOrEqual(1);
      if (week.phase === CYCLE_PHASE.RECOVERY) expect(quality).toHaveLength(0);
      const long = week.sessions.find(session => session.archetype === 'long-run')!;
      expect(long.dayOfWeek).toBe(6);
      expect(long.goalDuration).toBeGreaterThanOrEqual(Math.max(...week.sessions.filter(session => session !== long).map(session => session.goalDuration ?? 0)));
      for (const session of quality) {
        const gap = Math.abs(session.dayOfWeek - long.dayOfWeek);
        expect(Math.min(gap, 7 - gap)).toBeGreaterThanOrEqual(2);
      }
    }
    expect(weeks[0].targetVolume).toBeLessThanOrEqual(input.currentWeeklyVolume!);
  });

  it.each([
    { daysPerWeek: 2 },
    { fitness: {} },
    { injuries: [{ location: 'calf', painScore: 5, status: 'STABLE' as const }] },
    { raceDate: null, targetTime: null, targetDistance: null },
  ])('preserves conservative restrictions for %j', overrides => {
    const { plan } = generatePlan({ ...input, ...overrides });
    const sessions = flattenWeeks(plan).flatMap(week => week.sessions).filter(session => session.archetype !== 'race');
    expect(sessions.some(session => isQuality(session.archetype))).toBe(false);
  });
});


describe('quality session dose', () => {
  const context = { paces: paceTableForVdot(40), durationSeconds: 5400, maxQualitySeconds: 1200 };
  it('limits repeats instead of filling a long session with hard work', () => {
    for (const key of ['hills', 'fartlek', 'cruise-intervals', 'vo2-intervals'] as const) {
      const built = ARCHETYPES[key].build(context);
      const repeat = built.steps.find(step => step.repeatBlock)!.repeatBlock!;
      expect(repeat.repetitions).toBeLessThanOrEqual(8);
      expect(repeat.repetitions * repeat.childSteps[0].durationValue!).toBeLessThanOrEqual(1200);
      expect(built.durationSeconds).toBe(5400);
    }
  });
  it('keeps continuous tempo work at twenty minutes with easy running around it', () => {
    const built = ARCHETYPES.threshold.build(context);
    expect(built.steps[1].durationValue).toBe(1200);
    expect(built.durationSeconds).toBe(5400);
  });
});
