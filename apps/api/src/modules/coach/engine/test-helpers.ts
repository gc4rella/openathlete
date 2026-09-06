import {
  type GeneratedPlanData,
  type PlanSession,
  type PlanWeek,
  SPORT_TYPE,
} from '@openathlete/shared';

import { type EngineInput } from './types';

/**
 * Shared fixtures for the engine tests.
 *
 * Kept in a plain module rather than a `.spec.ts` so the jest testRegex does
 * not try to run it as a suite.
 */

export type PlanSessionView = PlanSession;

const HOUR = 3600;

/**
 * A 16 week sub-3:30 marathon build for a moderately trained runner: the
 * reference case most of the safety assertions are written against.
 */
export function makeInput(overrides: Partial<EngineInput> = {}): EngineInput {
  return {
    sport: SPORT_TYPE.RUNNING,
    startDate: new Date('2026-01-05T00:00:00Z'),
    raceDate: new Date('2026-04-26T00:00:00Z'),
    targetDistance: 42195,
    targetTime: 3.5 * HOUR,
    durationWeeks: 16,
    daysPerWeek: 5,
    longRunDay: 0,
    currentWeeklyVolume: 4 * HOUR,
    includeCrossTraining: false,
    injuryAware: true,
    planName: null,
    fitness: {
      vmaKmh: 16,
      hrMax: 190,
      hrRest: 50,
      gender: 'male',
      bestEfforts: [{ distanceMeters: 10000, timeSeconds: 45 * 60 }],
    },
    availability: [],
    injuries: [],
    language: 'EN',
    ...overrides,
  };
}

export function flattenWeeks(plan: GeneratedPlanData): PlanWeek[] {
  return plan.cycles.flatMap((cycle) => cycle.weeks);
}

export function flattenSessions(plan: GeneratedPlanData): PlanSession[] {
  return flattenWeeks(plan).flatMap((week) => week.sessions);
}

export type { EngineInput };
