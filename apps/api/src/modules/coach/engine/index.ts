import {
  addCalendarDays,
  type GeneratedPlanData,
  type PlanCycle,
  type PlanSession,
  type PlanWeek,
  SPORT_TYPE,
} from '@openathlete/shared';

import {
  CYCLE_COLORS,
  cycleDescription,
  cycleName,
  planDescription,
  planGoal,
  sessionDescription,
  sessionName,
  weekTheme,
} from './narrative';
import {
  type DistanceProfile,
  buildWeekSkeletons,
  groupIntoCycles,
  resolveDistanceProfile,
} from './periodization';
import {
  paceTableForVdot,
  predictRaceTime,
  resolveFitness,
  vdotForProgress,
} from './physiology';
import { type ArchetypeKey } from './session-templates';
import {
  type EngineInput,
  type ResolvedFitness,
  type WeekSkeleton,
} from './types';
import { type PlacedSession, buildWeek } from './week-builder';

/**
 * Plan generation engine
 *
 * `generatePlan` is a pure function: the same input always produces the same
 * plan. That is why `TrainingPlan.generationInput` stores the whole input -
 * any plan in the database can be regenerated and diffed.
 *
 * The LLM narrative pass runs *after* this, and may only replace prose.
 */

export const GENERATOR_VERSION = '1.2.0';

export interface GeneratePlanResult {
  plan: GeneratedPlanData;
  fitness: ResolvedFitness;
  profile: DistanceProfile;
  /** Predicted finish time in seconds for the target distance, if any */
  predictedRaceTime: number | null;
  /** Total planned load (TRIMP) per week, in order */
  weeklyLoads: number[];
}

/**
 * Number of whole weeks a plan should run for, given a start and a race date.
 * The race falls inside the final week.
 */
export function weeksUntil(startDate: Date, raceDate: Date): number {
  const days = Math.ceil(
    (raceDate.getTime() - startDate.getTime()) / (24 * 60 * 60 * 1000),
  );

  return Math.max(1, Math.ceil((days + 1) / 7));
}

export function generatePlan(input: EngineInput): GeneratePlanResult {
  if (input.currentWeeklyVolume === null || !Number.isFinite(input.currentWeeklyVolume) || input.currentWeeklyVolume <= 0) {
    throw new Error('BASELINE_REQUIRED');
  }
  if (input.raceDate && input.durationWeeks < 4) throw new Error('PREPARATION_TOO_SHORT');
  const profile = resolveDistanceProfile(input.targetDistance);

  const fitness = resolveFitness(input.fitness, {
    distanceMeters: input.targetDistance,
    timeSeconds: input.targetTime,
  });

  const skeletons = buildWeekSkeletons(input, profile);

  const predictedRaceTime =
    input.targetDistance !== null && fitness.source !== 'DEFAULT' && fitness.source !== 'GOAL_TIME'
      ? Math.round(
          predictRaceTime(
            fitness.currentVdot,
            input.targetDistance,
          ),
        )
      : null;

  const race =
    input.raceDate !== null && input.targetDistance !== null
      ? {
          dayOfWeek: input.raceDate.getUTCDay(),
          durationSeconds: input.targetTime ?? predictedRaceTime ?? 3600,
          distanceMeters: input.targetDistance,
        }
      : undefined;

  // Rehearsals follow current fitness. Race day retains the stated goal.
  const racePace =
    input.targetDistance !== null && input.targetTime !== null
      ? Math.min(input.targetDistance / input.targetTime, input.targetDistance / (predictedRaceTime ?? input.targetTime))
      : null;

  const lastIndex = Math.max(1, skeletons.length - 1);

  const builtWeeks = skeletons.map((skeleton, index) => {
    // Keep training paces anchored to the available fitness evidence.
    const progress = index / lastIndex;
    const paces = paceTableForVdot(vdotForProgress(fitness, progress));

    const sessions = buildWeek(skeleton, {
      input,
      profile,
      paces,
      fitness,
      rotationOffset: index,
      racePace,
      race,
    });

    return { skeleton, paces, sessions };
  });

  const weeklyLoads = builtWeeks.map((week) =>
    round(
      week.sessions.reduce(
        (total, session) => total + session.skeleton.estimatedLoad,
        0,
      ),
      1,
    ),
  );

  const cycles = assembleCycles(builtWeeks, input);

  const targetLabel = describeTarget(input);

  return {
    plan: {
      plan: {
        name: input.planName ?? defaultPlanName(input, targetLabel),
        description: planDescription(
          skeletons.length,
          input.daysPerWeek,
          input.language,
        ),
        goal: planGoal(targetLabel, input.language),
        sportType: input.sport,
        distance: input.targetDistance ?? 0,
        duration: skeletons.length,
        timeTarget: input.targetTime ?? null,
        elevationGainRange: null,
        coachNotes: null,
      },
      cycles,
    },
    fitness,
    profile,
    predictedRaceTime,
    weeklyLoads,
  };
}

interface BuiltWeek {
  skeleton: WeekSkeleton;
  paces: ReturnType<typeof paceTableForVdot>;
  sessions: PlacedSession[];
}

function assembleCycles(
  builtWeeks: BuiltWeek[],
  input: EngineInput,
): PlanCycle[] {
  const grouped = groupIntoCycles(builtWeeks.map((week) => week.skeleton));
  const byWeekNumber = new Map(
    builtWeeks.map((week) => [week.skeleton.weekNumber, week]),
  );

  return grouped.map((group) => ({
    name: cycleName(group.phase, input.language),
    description: cycleDescription(group.phase, input.language),
    phase: group.phase,
    color: CYCLE_COLORS[group.phase],
    weeks: group.weeks.map((skeleton): PlanWeek => {
      const built = byWeekNumber.get(skeleton.weekNumber);

      return {
        weekNumber: skeleton.weekNumber,
        theme: weekTheme(skeleton, input.language),
        phase: skeleton.phase,
        targetVolume: built ? Math.round(built.sessions.filter(s => s.skeleton.archetype !== "race").reduce((sum, s) => sum + s.skeleton.durationSeconds, 0)) : skeleton.targetVolume,
        targetLoad: built
          ? round(
              built.sessions.reduce(
                (total, session) => total + session.skeleton.estimatedLoad,
                0,
              ),
              1,
            )
          : null,
        sessions: (built?.sessions ?? []).map((session) =>
          toPlanSession(session, built, input),
        ),
      };
    }),
  }));
}

function toPlanSession(
  session: PlacedSession,
  built: BuiltWeek | undefined,
  input: EngineInput,
): PlanSession {
  const archetype = session.skeleton.archetype as ArchetypeKey;

  return {
    scheduledDate: addCalendarDays(input.startDate, ((built?.skeleton.weekNumber ?? 1) - 1) * 7 + (session.skeleton.dayOfWeek - input.startDate.getUTCDay() + 7) % 7),
    dayOfWeek: session.skeleton.dayOfWeek,
    name: sessionName(archetype, input.language),
    sport: session.skeleton.sport,
    description: built
      ? sessionDescription(
          archetype,
          session.skeleton.intensity,
          built.paces,
          input.language,
          false,
          session.built.steps,
          input.targetDistance && input.targetTime ? input.targetDistance / input.targetTime : null,
        )
      : '',
    goalDistance: session.skeleton.archetype === 'race' || (input.fitness.bestEfforts?.length ?? 0) > 0 || input.fitness.vmaKmh || input.fitness.vo2max ? session.skeleton.distanceMeters : null,
    goalDuration: session.skeleton.durationSeconds,
    goalElevationGain: null,
    goalRpe: session.skeleton.goalRpe,
    estimatedLoad: session.skeleton.estimatedLoad,
    startTime: null,
    archetype,
    workout: { steps: session.built.steps },
  };
}

function describeTarget(input: EngineInput): string | null {
  if (input.targetDistance === null || input.targetDistance <= 0) {
    return null;
  }

  const km = input.targetDistance / 1000;

  if (Math.abs(km - 42.195) < 0.5) {
    return 'Marathon';
  }
  if (Math.abs(km - 21.0975) < 0.5) {
    return 'Half Marathon';
  }

  return `${trimNumber(km)} km`;
}

function defaultPlanName(
  input: EngineInput,
  targetLabel: string | null,
): string {
  const sportLabel = input.sport === SPORT_TYPE.TRAIL_RUNNING ? 'Trail' : 'Run';

  return targetLabel === null
    ? `${sportLabel} fitness plan`
    : `${targetLabel} plan`;
}

function trimNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function round(value: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

export * from './types';
export * from './physiology';
export * from './periodization';
export * from './session-templates';
export * from './week-builder';
export * from './load-estimator';
export * from './narrative';
