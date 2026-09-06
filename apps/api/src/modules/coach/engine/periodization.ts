import { CYCLE_PHASE } from '@openathlete/shared';

import {
  ACWR_OPTIMAL_MAX,
  LOAD_SLOPE_CLAMP,
} from 'src/common/constants/training-formulas.constants';

import { type ArchetypeKey } from './session-templates';
import { type EngineInput, type WeekSkeleton } from './types';

/**
 * Periodization
 *
 * Turns a goal and a start date into a week-by-week volume curve: which weeks
 * are base, specific, recovery or taper, how much time each should contain, and
 * how many quality sessions it should hold.
 *
 * Two safety properties are enforced here rather than left to the session
 * builder, because they are the ones that hurt people when they are wrong:
 *
 *  1. Week-over-week volume never grows faster than LOAD_SLOPE_CLAMP.MAX.
 *  2. Projected ACWR never exceeds ACWR_OPTIMAL_MAX, using the same
 *     acute:chronic definition as TrainingLoadService so the projection and the
 *     dashboard agree.
 */

const HOUR = 3600;

/** Default week-over-week volume growth, well inside the hard clamp. */
export const DEFAULT_WEEKLY_RAMP = 0.08;

/** Recovery weeks drop to this fraction of the preceding build week. */
const RECOVERY_WEEK_FACTOR = 0.65;

/** Every Nth week of a build block is a recovery week. */
const RECOVERY_WEEK_INTERVAL = 4;

/** Fraction of the build phase spent on base before turning specific. */
const BASE_PHASE_FRACTION = 0.45;

/** Volume multipliers for the taper, from first taper week to race week. */
const TAPER_CURVE = [0.75, 0.55, 0.4];
const RACE_WEEK_FACTOR = 0.3;

export interface DistanceProfile {
  key: string;
  /** Upper bound of the distance band, in meters */
  maxDistanceMeters: number;
  taperWeeks: number;
  /** Long run as a fraction of weekly volume */
  longRunFraction: number;
  longRunCapSeconds: number;
  /** Weekly volume floor used when the athlete's current volume is unknown */
  defaultStartVolumeSeconds: number;
  /** Weekly volume ceiling, regardless of how long the plan is */
  maxPeakVolumeSeconds: number;
  /** Quality sessions per week, by phase */
  qualityByPhase: Record<CYCLE_PHASE, number>;
  /** Quality archetypes to rotate through, by phase */
  rotationByPhase: Record<CYCLE_PHASE, ArchetypeKey[]>;
}

const SHARED_ROTATION = {
  [CYCLE_PHASE.RECOVERY]: ['fartlek'] as ArchetypeKey[],
  [CYCLE_PHASE.COMPETITION]: [] as ArchetypeKey[],
};

export const DISTANCE_PROFILES: DistanceProfile[] = [
  {
    key: '5K',
    maxDistanceMeters: 7000,
    taperWeeks: 1,
    longRunFraction: 0.25,
    longRunCapSeconds: 90 * 60,
    defaultStartVolumeSeconds: 2.5 * HOUR,
    maxPeakVolumeSeconds: 6 * HOUR,
    qualityByPhase: {
      [CYCLE_PHASE.BASE]: 1,
      [CYCLE_PHASE.SPECIFIC]: 2,
      [CYCLE_PHASE.TAPER]: 1,
      [CYCLE_PHASE.RECOVERY]: 0,
      [CYCLE_PHASE.COMPETITION]: 0,
    },
    rotationByPhase: {
      [CYCLE_PHASE.BASE]: ['fartlek', 'hills'],
      [CYCLE_PHASE.SPECIFIC]: ['vo2-intervals', 'cruise-intervals'],
      [CYCLE_PHASE.TAPER]: ['vo2-intervals'],
      ...SHARED_ROTATION,
    },
  },
  {
    key: '10K',
    maxDistanceMeters: 15000,
    taperWeeks: 1,
    longRunFraction: 0.28,
    longRunCapSeconds: 105 * 60,
    defaultStartVolumeSeconds: 3 * HOUR,
    maxPeakVolumeSeconds: 7 * HOUR,
    qualityByPhase: {
      [CYCLE_PHASE.BASE]: 1,
      [CYCLE_PHASE.SPECIFIC]: 2,
      [CYCLE_PHASE.TAPER]: 1,
      [CYCLE_PHASE.RECOVERY]: 0,
      [CYCLE_PHASE.COMPETITION]: 0,
    },
    rotationByPhase: {
      [CYCLE_PHASE.BASE]: ['fartlek', 'hills'],
      [CYCLE_PHASE.SPECIFIC]: ['cruise-intervals', 'vo2-intervals'],
      [CYCLE_PHASE.TAPER]: ['cruise-intervals'],
      ...SHARED_ROTATION,
    },
  },
  {
    key: 'HALF_MARATHON',
    maxDistanceMeters: 30000,
    taperWeeks: 2,
    longRunFraction: 0.3,
    longRunCapSeconds: 120 * 60,
    defaultStartVolumeSeconds: 3.5 * HOUR,
    maxPeakVolumeSeconds: 8 * HOUR,
    qualityByPhase: {
      [CYCLE_PHASE.BASE]: 1,
      [CYCLE_PHASE.SPECIFIC]: 2,
      [CYCLE_PHASE.TAPER]: 1,
      [CYCLE_PHASE.RECOVERY]: 0,
      [CYCLE_PHASE.COMPETITION]: 0,
    },
    rotationByPhase: {
      [CYCLE_PHASE.BASE]: ['fartlek', 'hills'],
      [CYCLE_PHASE.SPECIFIC]: ['threshold', 'cruise-intervals', 'race-pace'],
      [CYCLE_PHASE.TAPER]: ['race-pace'],
      ...SHARED_ROTATION,
    },
  },
  {
    key: 'MARATHON',
    maxDistanceMeters: 50000,
    taperWeeks: 3,
    longRunFraction: 0.33,
    longRunCapSeconds: 180 * 60,
    defaultStartVolumeSeconds: 4 * HOUR,
    maxPeakVolumeSeconds: 10 * HOUR,
    qualityByPhase: {
      [CYCLE_PHASE.BASE]: 1,
      [CYCLE_PHASE.SPECIFIC]: 2,
      [CYCLE_PHASE.TAPER]: 1,
      [CYCLE_PHASE.RECOVERY]: 0,
      [CYCLE_PHASE.COMPETITION]: 0,
    },
    rotationByPhase: {
      [CYCLE_PHASE.BASE]: ['fartlek', 'hills'],
      [CYCLE_PHASE.SPECIFIC]: [
        'threshold',
        'race-pace',
        'progressive-long-run',
      ],
      [CYCLE_PHASE.TAPER]: ['race-pace'],
      ...SHARED_ROTATION,
    },
  },
  {
    key: 'ULTRA',
    maxDistanceMeters: Number.POSITIVE_INFINITY,
    taperWeeks: 3,
    longRunFraction: 0.35,
    longRunCapSeconds: 300 * 60,
    defaultStartVolumeSeconds: 5 * HOUR,
    maxPeakVolumeSeconds: 12 * HOUR,
    qualityByPhase: {
      [CYCLE_PHASE.BASE]: 1,
      [CYCLE_PHASE.SPECIFIC]: 1,
      [CYCLE_PHASE.TAPER]: 1,
      [CYCLE_PHASE.RECOVERY]: 0,
      [CYCLE_PHASE.COMPETITION]: 0,
    },
    rotationByPhase: {
      [CYCLE_PHASE.BASE]: ['hills'],
      [CYCLE_PHASE.SPECIFIC]: ['hills', 'progressive-long-run', 'threshold'],
      [CYCLE_PHASE.TAPER]: ['threshold'],
      ...SHARED_ROTATION,
    },
  },
];

/** Profile used for open-ended "get fitter" plans with no race. */
export const GENERAL_FITNESS_PROFILE: DistanceProfile = {
  key: 'GENERAL_FITNESS',
  maxDistanceMeters: Number.POSITIVE_INFINITY,
  taperWeeks: 0,
  longRunFraction: 0.28,
  longRunCapSeconds: 90 * 60,
  defaultStartVolumeSeconds: 2.5 * HOUR,
  maxPeakVolumeSeconds: 7 * HOUR,
  qualityByPhase: {
    [CYCLE_PHASE.BASE]: 1,
    [CYCLE_PHASE.SPECIFIC]: 2,
    [CYCLE_PHASE.TAPER]: 1,
    [CYCLE_PHASE.RECOVERY]: 0,
    [CYCLE_PHASE.COMPETITION]: 0,
  },
  rotationByPhase: {
    [CYCLE_PHASE.BASE]: ['fartlek', 'hills'],
    [CYCLE_PHASE.SPECIFIC]: ['cruise-intervals', 'threshold', 'fartlek'],
    [CYCLE_PHASE.TAPER]: ['fartlek'],
    ...SHARED_ROTATION,
  },
};

export function resolveDistanceProfile(
  targetDistanceMeters: number | null,
): DistanceProfile {
  if (targetDistanceMeters === null || targetDistanceMeters <= 0) {
    return GENERAL_FITNESS_PROFILE;
  }

  return (
    DISTANCE_PROFILES.find(
      (profile) => targetDistanceMeters <= profile.maxDistanceMeters,
    ) ?? DISTANCE_PROFILES[DISTANCE_PROFILES.length - 1]
  );
}

/**
 * Build the week-by-week skeleton of the plan.
 */
export function buildWeekSkeletons(
  input: EngineInput,
  profile: DistanceProfile,
): WeekSkeleton[] {
  const totalWeeks = Math.max(1, Math.round(input.durationWeeks));

  // Never spend more than a quarter of a short plan tapering.
  const taperWeeks =
    input.raceDate === null
      ? 0
      : Math.min(profile.taperWeeks, Math.max(1, Math.floor(totalWeeks / 4)));

  const buildWeeks = Math.max(0, totalWeeks - taperWeeks);
  const baseWeeks = Math.round(buildWeeks * BASE_PHASE_FRACTION);

  const startVolume =
    input.currentWeeklyVolume !== null && input.currentWeeklyVolume >= 0
      ? input.currentWeeklyVolume
      : profile.defaultStartVolumeSeconds;

  const ramp = Math.min(DEFAULT_WEEKLY_RAMP, LOAD_SLOPE_CLAMP.MAX);

  const weeks: WeekSkeleton[] = [];

  // ---- build phase -------------------------------------------------------
  let lastBuildVolume = startVolume;

  for (let index = 0; index < buildWeeks; index++) {
    const weekNumber = index + 1;
    const isRecovery =
      weekNumber % RECOVERY_WEEK_INTERVAL === 0 && weekNumber !== buildWeeks;
    const phase = index < baseWeeks ? CYCLE_PHASE.BASE : CYCLE_PHASE.SPECIFIC;

    let targetVolume: number;

    if (index === 0) {
      targetVolume = startVolume;
    } else if (isRecovery) {
      targetVolume = lastBuildVolume * RECOVERY_WEEK_FACTOR;
    } else {
      targetVolume = Math.min(
        lastBuildVolume * (1 + ramp),
        profile.maxPeakVolumeSeconds,
      );
    }

    if (!isRecovery) {
      lastBuildVolume = targetVolume;
    }

    weeks.push({
      weekNumber,
      phase: isRecovery ? CYCLE_PHASE.RECOVERY : phase,
      isRecovery,
      targetVolume,
      qualityCount: isRecovery
        ? profile.qualityByPhase[CYCLE_PHASE.RECOVERY]
        : profile.qualityByPhase[phase],
      isRaceWeek: false,
    });
  }

  // ---- taper -------------------------------------------------------------
  // Clamp the build phase *before* deriving the peak. The taper is expressed
  // as a fraction of peak volume, so taking the peak from the unclamped ramp
  // would produce a "taper" barely below the weeks the athlete actually
  // trained - the one week of the plan where getting the volume wrong wastes
  // the whole build.
  const clampedBuild = enforceAcwr(weeks, startVolume);
  const peakVolume = clampedBuild.reduce(
    (peak, week) => Math.max(peak, week.targetVolume),
    0,
  );

  const taper: WeekSkeleton[] = [];

  for (let index = 0; index < taperWeeks; index++) {
    const weekNumber = buildWeeks + index + 1;
    const isRaceWeek = index === taperWeeks - 1;

    // Walk the taper curve backwards so the race week always lands on
    // RACE_WEEK_FACTOR regardless of how many taper weeks there are.
    const curveIndex = TAPER_CURVE.length - (taperWeeks - index);
    const factor = isRaceWeek
      ? RACE_WEEK_FACTOR
      : (TAPER_CURVE[curveIndex] ?? TAPER_CURVE[0]);

    taper.push({
      weekNumber,
      phase: isRaceWeek ? CYCLE_PHASE.COMPETITION : CYCLE_PHASE.TAPER,
      isRecovery: false,
      targetVolume: Math.round(peakVolume * factor),
      qualityCount: isRaceWeek
        ? profile.qualityByPhase[CYCLE_PHASE.COMPETITION]
        : profile.qualityByPhase[CYCLE_PHASE.TAPER],
      isRaceWeek,
    });
  }

  // The taper only ever descends from an already-clamped peak, so it cannot
  // breach the ACWR ceiling and needs no further clamping.
  return [...clampedBuild, ...taper];
}

/**
 * Scale down any week whose projected acute:chronic workload ratio would push
 * the athlete past the optimal zone.
 *
 * Mirrors TrainingLoadService.calculateACWRFromWeeklyLoads: the acute term is
 * the week itself, the chronic term is an exponentially weighted average of the
 * preceding six weeks with alpha = 2 / (weeks + 1). ACWR is a ratio, so running
 * it on volume rather than TRIMP is equivalent as long as the intensity mix is
 * broadly stable - which periodization keeps it.
 */
export function enforceAcwr(
  weeks: WeekSkeleton[],
  seedWeeklyVolume: number,
): WeekSkeleton[] {
  const chronicWeeks = 6;
  const alpha = 2 / (chronicWeeks + 1);

  // Seed the history with the athlete's current volume so week 1 is judged
  // against what they are actually doing today.
  const history: number[] = new Array<number>(chronicWeeks).fill(
    seedWeeklyVolume,
  );

  return weeks.map((week) => {
    let chronic = 0;
    for (let i = history.length - chronicWeeks; i < history.length; i++) {
      chronic = alpha * (history[i] ?? 0) + (1 - alpha) * chronic;
    }

    let targetVolume = week.targetVolume;

    if (chronic > 0) {
      const maxSafeVolume = chronic * ACWR_OPTIMAL_MAX;

      if (targetVolume > maxSafeVolume) {
        targetVolume = maxSafeVolume;
      }
    }

    // Round down, never up: rounding up a capped week would put it back over
    // the ACWR ceiling it was just clamped to.
    const rounded = Math.floor(targetVolume);
    history.push(rounded);

    return { ...week, targetVolume: rounded };
  });
}

/**
 * Group consecutive weeks that share a phase into cycles.
 * Recovery weeks are absorbed into the surrounding block rather than becoming
 * a one-week cycle of their own, which would make the plan overview unreadable.
 */
export function groupIntoCycles(
  weeks: WeekSkeleton[],
): Array<{ phase: CYCLE_PHASE; weeks: WeekSkeleton[] }> {
  const cycles: Array<{ phase: CYCLE_PHASE; weeks: WeekSkeleton[] }> = [];

  for (const week of weeks) {
    const phase = week.isRecovery ? previousPhase(cycles, week) : week.phase;
    const current = cycles[cycles.length - 1];

    if (current && current.phase === phase) {
      current.weeks.push(week);
    } else {
      cycles.push({ phase, weeks: [week] });
    }
  }

  return cycles;
}

function previousPhase(
  cycles: Array<{ phase: CYCLE_PHASE; weeks: WeekSkeleton[] }>,
  week: WeekSkeleton,
): CYCLE_PHASE {
  const current = cycles[cycles.length - 1];
  return current ? current.phase : week.phase;
}
