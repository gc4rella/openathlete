import {
  type CreateWorkoutStepDto,
  type CreateWorkoutStepTarget,
  SPORT_TYPE,
  WORKOUT_DURATION_TYPE,
  WORKOUT_STEP_TYPE,
  WORKOUT_TARGET_TYPE,
} from '@openathlete/shared';

import { type LoadSegment } from './load-estimator';
import { INTENSITY_RPE } from './physiology';
import { type PaceTable, RunIntensity, type ZoneIdByIntensity } from './types';

/**
 * Session archetypes
 *
 * A library of parameterized running sessions. Each archetype receives a
 * duration budget and produces the structured workout steps that fill it,
 * along with the intensity segments used to estimate its training load.
 *
 * Targets are emitted as absolute paces in m/s (the unit the database stores)
 * unless the athlete has configured training zones, in which case ZONE targets
 * are used so the session respects their own zone definitions.
 */

/** Tolerance band applied around a target pace. */
const PACE_BAND = 0.03;

const MIN_WARMUP_SECONDS = 600;
const MAX_WARMUP_SECONDS = 900;
const MIN_COOLDOWN_SECONDS = 300;
const MAX_COOLDOWN_SECONDS = 600;

export type ArchetypeKey =
  | 'recovery'
  | 'easy'
  | 'easy-strides'
  | 'long-run'
  | 'progressive-long-run'
  | 'threshold'
  | 'cruise-intervals'
  | 'vo2-intervals'
  | 'hills'
  | 'fartlek'
  | 'race-pace'
  | 'race'
  | 'cross-training';

export interface SessionContext {
  /** Training paces in m/s for the current week */
  effortBased?: boolean;
  paces: PaceTable;
  /** Total time budget for the session, in seconds */
  durationSeconds: number;
  /** Zone ids to target instead of absolute paces, when configured */
  zoneIds?: ZoneIdByIntensity;
  /** Goal race pace in m/s, when the athlete has a time goal */
  racePace?: number | null;
  /** Limit sustained hard work for low-frequency race builds. */
  maxQualitySeconds?: number;
}

export interface BuiltSession {
  steps: CreateWorkoutStepDto[];
  /** Intensity breakdown, consumed by the load estimator */
  segments: LoadSegment[];
  /** Actual total duration of the built steps, in seconds */
  durationSeconds: number;
  /** Estimated distance covered, in meters */
  distanceMeters: number;
  /** Dominant intensity, used for reporting and for downgrade decisions */
  intensity: RunIntensity;
  goalRpe: number;
}

export interface ArchetypeDefinition {
  key: ArchetypeKey;
  /** Quality sessions need recovery either side and are spaced apart */
  isQuality: boolean;
  /** Impact archetypes are avoided or replaced when an injury is flagged */
  isHighImpact: boolean;
  sport: SPORT_TYPE;
  intensity: RunIntensity;
  build: (context: SessionContext) => BuiltSession;
}

// ============================================================================
// Step helpers
// ============================================================================

function paceTarget(
  intensity: RunIntensity,
  context: SessionContext,
  paceOverride?: number | null,
): CreateWorkoutStepTarget {
  if (context.effortBased) return { targetType: WORKOUT_TARGET_TYPE.RPE, targetValue: INTENSITY_RPE[intensity] / 10 };
  // An explicit race pace beats the generic intensity: on race day, and when
  // rehearsing it, the number that matters is the athlete's goal pace.
  if (paceOverride !== undefined && paceOverride !== null && paceOverride > 0) {
    return {
      targetType: WORKOUT_TARGET_TYPE.PACE,
      targetMin: round(paceOverride * (1 - PACE_BAND), 3),
      targetMax: round(paceOverride * (1 + PACE_BAND), 3),
    };
  }

  const zoneId = context.zoneIds?.[intensity];

  if (zoneId !== undefined) {
    return {
      targetType: WORKOUT_TARGET_TYPE.ZONE,
      targetValue: zoneId,
    };
  }

  const pace = context.paces[intensity];

  return {
    targetType: WORKOUT_TARGET_TYPE.PACE,
    targetMin: round(pace * (1 - PACE_BAND), 3),
    targetMax: round(pace * (1 + PACE_BAND), 3),
  };
}

function timedStep(
  stepType: WORKOUT_STEP_TYPE,
  intensity: RunIntensity,
  durationSeconds: number,
  context: SessionContext,
  name?: string,
  paceOverride?: number | null,
): CreateWorkoutStepDto {
  return {
    stepType,
    name: name ?? null,
    durationType: WORKOUT_DURATION_TYPE.TIME,
    durationValue: Math.round(durationSeconds),
    targets: [paceTarget(intensity, context, paceOverride)],
  };
}

function repeatStep(
  repetitions: number,
  childSteps: CreateWorkoutStepDto[],
  name: string,
): CreateWorkoutStepDto {
  return {
    stepType: WORKOUT_STEP_TYPE.REPEAT,
    name,
    durationType: WORKOUT_DURATION_TYPE.OPEN,
    targets: [],
    repeatBlock: { repetitions, childSteps },
  };
}

/**
 * Fit as many work/recovery cycles as the budget allows, then hand the
 * remainder to the cooldown so the session's total duration matches the budget
 * exactly. Volume targets are only meaningful if sessions actually consume
 * the time they were allocated.
 */
function fitIntervals(
  budgetSeconds: number,
  onSeconds: number,
  offSeconds: number,
  minRepetitions = 3,
): { warmup: number; cooldown: number; repetitions: number } {
  const warmup = clamp(
    budgetSeconds * 0.2,
    MIN_WARMUP_SECONDS,
    MAX_WARMUP_SECONDS,
  );
  const cycle = onSeconds + offSeconds;

  let repetitions = Math.max(
    minRepetitions,
    Math.round((budgetSeconds - warmup - MIN_COOLDOWN_SECONDS) / cycle),
  );
  let cooldown = budgetSeconds - warmup - repetitions * cycle;

  while (cooldown < MIN_COOLDOWN_SECONDS && repetitions > minRepetitions) {
    repetitions -= 1;
    cooldown = budgetSeconds - warmup - repetitions * cycle;
  }

  return {
    warmup,
    cooldown: Math.max(MIN_COOLDOWN_SECONDS, cooldown),
    repetitions,
  };
}

/**
 * Split a budget into warmup / continuous work / cooldown.
 */
function fitContinuous(budgetSeconds: number): {
  warmup: number;
  work: number;
  cooldown: number;
} {
  const warmup = clamp(
    budgetSeconds * 0.2,
    MIN_WARMUP_SECONDS,
    MAX_WARMUP_SECONDS,
  );
  const cooldown = clamp(
    budgetSeconds * 0.15,
    MIN_COOLDOWN_SECONDS,
    MAX_COOLDOWN_SECONDS,
  );
  const work = Math.max(600, budgetSeconds - warmup - cooldown);

  return { warmup, work, cooldown };
}

function finish(
  steps: CreateWorkoutStepDto[],
  segments: LoadSegment[],
  intensity: RunIntensity,
  context: SessionContext,
): BuiltSession {
  const durationSeconds = segments.reduce(
    (total, segment) => total + segment.durationSeconds,
    0,
  );
  const distanceMeters = segments.reduce(
    (total, segment) =>
      total + segment.durationSeconds * (segment.velocity ?? context.paces[segment.intensity]),
    0,
  );

  return {
    steps,
    segments,
    durationSeconds: Math.round(durationSeconds),
    distanceMeters: Math.round(distanceMeters),
    intensity,
    goalRpe: INTENSITY_RPE[intensity],
  };
}

/** A single continuous run at one intensity. */
function steadyRun(
  intensity: RunIntensity,
  context: SessionContext,
  paceOverride?: number | null,
): BuiltSession {
  const duration = context.durationSeconds;

  return finish(
    [
      timedStep(
        WORKOUT_STEP_TYPE.STEADY,
        intensity,
        duration,
        context,
        undefined,
        paceOverride,
      ),
    ],
    [{ durationSeconds: duration, intensity, velocity: paceOverride }],
    intensity,
    context,
  );
}

/** Warmup + repeated work/recovery cycles + cooldown. */
function intervalSession(
  workIntensity: RunIntensity,
  onSeconds: number,
  offSeconds: number,
  restIntensity: RunIntensity,
  label: string,
  context: SessionContext,
  minRepetitions = 3,
  maxRepetitions = 8,
): BuiltSession {
  if (context.durationSeconds < MIN_WARMUP_SECONDS + MIN_COOLDOWN_SECONDS + minRepetitions * (onSeconds + offSeconds)) {
    return steadyRun(RunIntensity.EASY, context);
  }
  const fitted = fitIntervals(
    context.durationSeconds,
    onSeconds,
    offSeconds,
    minRepetitions,
  );
  const repetitions = Math.min(fitted.repetitions, maxRepetitions,
    context.maxQualitySeconds ? Math.floor(context.maxQualitySeconds / onSeconds) : Infinity);
  const warmup = fitted.warmup;
  const cooldown = context.durationSeconds - warmup - repetitions * (onSeconds + offSeconds);

  const steps: CreateWorkoutStepDto[] = [
    timedStep(WORKOUT_STEP_TYPE.WARMUP, RunIntensity.EASY, warmup, context),
    repeatStep(
      repetitions,
      [
        timedStep(
          WORKOUT_STEP_TYPE.INTERVAL_ACTIVE,
          workIntensity,
          onSeconds,
          context,
        ),
        timedStep(
          WORKOUT_STEP_TYPE.INTERVAL_REST,
          restIntensity,
          offSeconds,
          context,
        ),
      ],
      `${repetitions}x ${label}`,
    ),
    timedStep(WORKOUT_STEP_TYPE.COOLDOWN, RunIntensity.EASY, cooldown, context),
  ];

  const segments: LoadSegment[] = [
    { durationSeconds: warmup, intensity: RunIntensity.EASY },
    ...Array.from({ length: repetitions }).flatMap<LoadSegment>(() => [
      { durationSeconds: onSeconds, intensity: workIntensity },
      { durationSeconds: offSeconds, intensity: restIntensity },
    ]),
    { durationSeconds: cooldown, intensity: RunIntensity.EASY },
  ];

  return finish(steps, segments, workIntensity, context);
}

/** Warmup + one continuous block at intensity + cooldown. */
function continuousQualitySession(
  intensity: RunIntensity,
  label: string,
  context: SessionContext,
  paceOverride?: number | null,
): BuiltSession {
  if (context.durationSeconds < 1500) return steadyRun(RunIntensity.EASY, context);
  const fitted = fitContinuous(context.durationSeconds);
  const work = Math.min(fitted.work, context.maxQualitySeconds ?? Infinity);
  const warmup = fitted.warmup;
  const cooldown = context.durationSeconds - warmup - work;

  const steps: CreateWorkoutStepDto[] = [
    timedStep(WORKOUT_STEP_TYPE.WARMUP, RunIntensity.EASY, warmup, context),
    timedStep(
      WORKOUT_STEP_TYPE.STEADY,
      intensity,
      work,
      context,
      label,
      paceOverride,
    ),
    timedStep(WORKOUT_STEP_TYPE.COOLDOWN, RunIntensity.EASY, cooldown, context),
  ];

  const segments: LoadSegment[] = [
    { durationSeconds: warmup, intensity: RunIntensity.EASY },
    { durationSeconds: work, intensity, velocity: paceOverride },
    { durationSeconds: cooldown, intensity: RunIntensity.EASY },
  ];

  return finish(steps, segments, intensity, context);
}

// ============================================================================
// Archetypes
// ============================================================================

export const ARCHETYPES: Record<ArchetypeKey, ArchetypeDefinition> = {
  recovery: {
    key: 'recovery',
    isQuality: false,
    isHighImpact: false,
    sport: SPORT_TYPE.RUNNING,
    intensity: RunIntensity.RECOVERY,
    build: (context) => steadyRun(RunIntensity.RECOVERY, context),
  },

  easy: {
    key: 'easy',
    isQuality: false,
    isHighImpact: false,
    sport: SPORT_TYPE.RUNNING,
    intensity: RunIntensity.EASY,
    build: (context) => steadyRun(RunIntensity.EASY, context),
  },

  /**
   * An easy run finished with short accelerations. Cheap neuromuscular work
   * that does not count as a quality session.
   */
  'easy-strides': {
    key: 'easy-strides',
    isQuality: false,
    isHighImpact: false,
    sport: SPORT_TYPE.RUNNING,
    intensity: RunIntensity.EASY,
    build: (context) => {
      const strideCount = 6;
      const strideOn = 20;
      const strideOff = 60;
      const strideBlock = strideCount * (strideOn + strideOff);
      const easy = Math.max(600, context.durationSeconds - strideBlock);

      const steps: CreateWorkoutStepDto[] = [
        timedStep(WORKOUT_STEP_TYPE.STEADY, RunIntensity.EASY, easy, context),
        repeatStep(
          strideCount,
          [
            timedStep(
              WORKOUT_STEP_TYPE.INTERVAL_ACTIVE,
              RunIntensity.REPETITION,
              strideOn,
              context,
            ),
            timedStep(
              WORKOUT_STEP_TYPE.INTERVAL_REST,
              RunIntensity.RECOVERY,
              strideOff,
              context,
            ),
          ],
          `${strideCount}x 20s strides`,
        ),
      ];

      const segments: LoadSegment[] = [
        { durationSeconds: easy, intensity: RunIntensity.EASY },
        ...Array.from({ length: strideCount }).flatMap<LoadSegment>(() => [
          { durationSeconds: strideOn, intensity: RunIntensity.REPETITION },
          { durationSeconds: strideOff, intensity: RunIntensity.RECOVERY },
        ]),
      ];

      return finish(steps, segments, RunIntensity.EASY, context);
    },
  },

  'long-run': {
    key: 'long-run',
    isQuality: false,
    isHighImpact: true,
    sport: SPORT_TYPE.RUNNING,
    intensity: RunIntensity.EASY,
    build: (context) => steadyRun(RunIntensity.EASY, context),
  },

  /** Long run with the final third lifted to marathon effort. */
  'progressive-long-run': {
    key: 'progressive-long-run',
    isQuality: true,
    isHighImpact: true,
    sport: SPORT_TYPE.RUNNING,
    intensity: RunIntensity.MARATHON,
    build: (context) => {
      const fast = Math.round(context.durationSeconds * 0.3);
      const easy = context.durationSeconds - fast;

      const steps: CreateWorkoutStepDto[] = [
        timedStep(WORKOUT_STEP_TYPE.STEADY, RunIntensity.EASY, easy, context),
        timedStep(
          WORKOUT_STEP_TYPE.STEADY,
          RunIntensity.MARATHON,
          fast,
          context,
          'Progression',
        ),
      ];

      const segments: LoadSegment[] = [
        { durationSeconds: easy, intensity: RunIntensity.EASY },
        { durationSeconds: fast, intensity: RunIntensity.MARATHON },
      ];

      return finish(steps, segments, RunIntensity.MARATHON, context);
    },
  },

  threshold: {
    key: 'threshold',
    isQuality: true,
    isHighImpact: true,
    sport: SPORT_TYPE.RUNNING,
    intensity: RunIntensity.THRESHOLD,
    build: (context) =>
      continuousQualitySession(RunIntensity.THRESHOLD, 'Tempo', context),
  },

  /** Threshold broken into 6 minute blocks with short float recoveries. */
  'cruise-intervals': {
    key: 'cruise-intervals',
    isQuality: true,
    isHighImpact: true,
    sport: SPORT_TYPE.RUNNING,
    intensity: RunIntensity.THRESHOLD,
    build: (context) =>
      intervalSession(
        RunIntensity.THRESHOLD,
        360,
        60,
        RunIntensity.EASY,
        '6min threshold',
        context,
      ),
  },

  'vo2-intervals': {
    key: 'vo2-intervals',
    isQuality: true,
    isHighImpact: true,
    sport: SPORT_TYPE.RUNNING,
    intensity: RunIntensity.INTERVAL,
    build: (context) =>
      intervalSession(
        RunIntensity.INTERVAL,
        180,
        120,
        RunIntensity.RECOVERY,
        '3min VO2max',
        context,
      ),
  },

  hills: {
    key: 'hills',
    isQuality: true,
    isHighImpact: true,
    sport: SPORT_TYPE.RUNNING,
    intensity: RunIntensity.INTERVAL,
    build: (context) =>
      intervalSession(
        RunIntensity.INTERVAL,
        45,
        90,
        RunIntensity.RECOVERY,
        '45s hill',
        { ...context, effortBased: true },
        6,
      ),
  },

  fartlek: {
    key: 'fartlek',
    isQuality: true,
    isHighImpact: true,
    sport: SPORT_TYPE.RUNNING,
    intensity: RunIntensity.THRESHOLD,
    build: (context) =>
      intervalSession(
        RunIntensity.THRESHOLD,
        120,
        120,
        RunIntensity.EASY,
        '2min surge',
        context,
        4,
      ),
  },

  'race-pace': {
    key: 'race-pace',
    isQuality: true,
    isHighImpact: true,
    sport: SPORT_TYPE.RUNNING,
    intensity: RunIntensity.MARATHON,
    build: (context) =>
      continuousQualitySession(
        RunIntensity.MARATHON,
        'Race pace',
        context,
        context.racePace,
      ),
  },

  /**
   * The goal event itself. Duration is the predicted finish time, so the week
   * accounts for the race's load like any other session.
   */
  race: {
    key: 'race',
    isQuality: true,
    isHighImpact: true,
    sport: SPORT_TYPE.RUNNING,
    intensity: RunIntensity.MARATHON,
    build: (context) =>
      steadyRun(RunIntensity.MARATHON, context, context.racePace),
  },

  /**
   * Low-impact aerobic work. Used in place of an easy run when an injury makes
   * running impact unwise, or when the athlete opted into cross-training.
   */
  'cross-training': {
    key: 'cross-training',
    isQuality: false,
    isHighImpact: false,
    sport: SPORT_TYPE.CYCLING,
    intensity: RunIntensity.EASY,
    build: (context) => steadyRun(RunIntensity.EASY, context),
  },
};

export function getArchetype(key: ArchetypeKey): ArchetypeDefinition {
  return ARCHETYPES[key];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round(value: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}
