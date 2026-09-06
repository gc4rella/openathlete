import { estimateTrimp } from './load-estimator';
import { type DistanceProfile } from './periodization';
import {
  ARCHETYPES,
  type ArchetypeDefinition,
  type ArchetypeKey,
  type BuiltSession,
  type SessionContext,
} from './session-templates';
import {
  type AvailabilitySlot,
  type EngineInput,
  type InjurySignal,
  type PaceTable,
  type ResolvedFitness,
  RunIntensity,
  type SessionSkeleton,
  type WeekSkeleton,
} from './types';

/**
 * Week builder
 *
 * Places a week's sessions on real weekdays and divides the week's volume
 * between them.
 *
 * The rules encoded here are the ones a coach applies without thinking:
 * respect the athlete's availability, keep hard days apart, put the long run
 * where there is time for it, and keep the great majority of the volume easy.
 */

/**
 * Preferred weekday order when the athlete has not declared any availability.
 * Chosen so that the first few picks are naturally spaced.
 * 0=Sunday .. 6=Saturday
 */
const DEFAULT_DAY_ORDER = [2, 4, 6, 0, 1, 3, 5];

const PRIORITY_SCORE: Record<AvailabilitySlot['priority'], number> = {
  HIGH: 3,
  MEDIUM: 2,
  LOW: 1,
};

/** Shortest session worth scheduling. */
const MIN_SESSION_SECONDS = 20 * 60;
const MAX_SESSION_SECONDS = 150 * 60;

/** Quality sessions carry slightly more of the week than easy days. */
const QUALITY_WEIGHT = 1.15;
const EASY_WEIGHT = 1;

/**
 * Ceiling on the share of weekly volume spent at threshold intensity or above.
 * The classic polarized/80-20 guideline; exceeded builds break down.
 */
const MAX_HARD_FRACTION = 0.22;

/** Pain at or above this level removes quality work. */
const INJURY_CAUTION_PAIN = 4;
/** Pain at or above this level removes running impact altogether. */
const INJURY_SEVERE_PAIN = 6;

export interface PlacedSession {
  skeleton: SessionSkeleton;
  built: BuiltSession;
  archetype: ArchetypeDefinition;
}

export interface WeekBuildContext {
  input: EngineInput;
  profile: DistanceProfile;
  paces: PaceTable;
  fitness: ResolvedFitness;
  /** Rotates quality archetypes so consecutive weeks are not identical */
  rotationOffset: number;
  /** Goal race pace in m/s, when the athlete gave a time target */
  racePace: number | null;
  /** Race day of week and duration, only for the race week */
  race?: { dayOfWeek: number; durationSeconds: number; distanceMeters: number };
}

// ============================================================================
// Day selection
// ============================================================================

function slotMinutes(slot: AvailabilitySlot): number {
  const [startHour, startMinute] = slot.startTime.split(':').map(Number);
  const [endHour, endMinute] = slot.endTime.split(':').map(Number);

  return endHour * 60 + endMinute - (startHour * 60 + startMinute);
}

/**
 * Score every weekday by how well it suits training, from the athlete's
 * declared availability. Days with no declared window score 0 and are only
 * used if there are not enough declared days.
 */
export function scoreDays(
  availability: AvailabilitySlot[],
): Map<number, number> {
  const scores = new Map<number, number>();

  for (const slot of availability) {
    const minutes = Math.max(0, slotMinutes(slot));
    const score = PRIORITY_SCORE[slot.priority] * 100 + minutes;
    scores.set(
      slot.dayOfWeek,
      Math.max(scores.get(slot.dayOfWeek) ?? 0, score),
    );
  }

  return scores;
}

/**
 * Choose which weekdays to train on.
 *
 * Greedy: repeatedly take the best-scoring remaining day, penalising days
 * adjacent to one already chosen so sessions end up spread across the week
 * rather than stacked on a weekend.
 */
export function chooseTrainingDays(
  availability: AvailabilitySlot[],
  daysPerWeek: number,
  longRunDay: number | null,
): number[] {
  const scores = scoreDays(availability);
  if (availability.length && (scores.size < daysPerWeek || (longRunDay !== null && !scores.has(longRunDay)))) throw new Error('AVAILABILITY_CONFLICT');
  const chosen: number[] = [];

  // The long run day is non-negotiable if the athlete asked for one.
  if (longRunDay !== null) {
    chosen.push(longRunDay);
  }

  const candidates = DEFAULT_DAY_ORDER.filter(day => !availability.length || scores.has(day)).sort((a, b) => {
    const scoreDiff = (scores.get(b) ?? 0) - (scores.get(a) ?? 0);
    if (scoreDiff !== 0) {
      return scoreDiff;
    }
    return DEFAULT_DAY_ORDER.indexOf(a) - DEFAULT_DAY_ORDER.indexOf(b);
  });

  while (chosen.length < daysPerWeek) {
    let best: number | null = null;
    let bestScore = -Infinity;

    for (const day of candidates) {
      if (chosen.includes(day)) {
        continue;
      }

      const adjacency = chosen.some((c) => circularDayDistance(c, day) === 1)
        ? 150
        : 0;
      const score = (scores.get(day) ?? 0) - adjacency;

      if (score > bestScore) {
        bestScore = score;
        best = day;
      }
    }

    if (best === null) {
      break;
    }

    chosen.push(best);
  }

  return chosen.sort((a, b) => a - b);
}

/** Distance between two weekdays, wrapping around the week. */
export function circularDayDistance(a: number, b: number): number {
  const diff = Math.abs(a - b);
  return Math.min(diff, 7 - diff);
}

/** Pick the day the long run should land on. */
export function resolveLongRunDay(
  trainingDays: number[],
  availability: AvailabilitySlot[],
  requested: number | null,
): number {
  if (requested !== null && trainingDays.includes(requested)) {
    return requested;
  }

  // Otherwise the day with the most declared time, falling back to Sunday.
  let best = trainingDays.includes(0)
    ? 0
    : trainingDays[trainingDays.length - 1];
  let bestMinutes = -1;

  for (const day of trainingDays) {
    const minutes = availability
      .filter((slot) => slot.dayOfWeek === day)
      .reduce((total, slot) => total + Math.max(0, slotMinutes(slot)), 0);

    if (minutes > bestMinutes) {
      bestMinutes = minutes;
      best = day;
    }
  }

  return best;
}

/**
 * Choose which days carry the quality sessions: as far as possible from the
 * long run and from each other, so no two hard days ever sit back to back.
 *
 * Selected exhaustively rather than greedily. Greedy fails on exactly the case
 * that matters: with a long run on Sunday and six training days, taking the
 * single furthest day first (Wednesday) strands the second pick next to the
 * long run, whereas Tuesday+Thursday spaces all three properly. The search
 * space is at most a handful of combinations from seven days, so the exact
 * answer is free.
 */
export function chooseQualityDays(
  trainingDays: number[],
  longRunDay: number,
  qualityCount: number,
): number[] {
  if (qualityCount <= 0) {
    return [];
  }

  const candidates = trainingDays.filter((day) => day !== longRunDay);

  if (qualityCount > candidates.length) return chooseQualityDays(trainingDays, longRunDay, candidates.length);

  let best: number[] = [];
  let bestScore = -Infinity;

  for (const combination of combinations(candidates, qualityCount)) {
    const hardDays = [longRunDay, ...combination];
    let minGap = Infinity;

    for (let i = 0; i < hardDays.length; i++) {
      for (let j = i + 1; j < hardDays.length; j++) {
        minGap = Math.min(
          minGap,
          circularDayDistance(hardDays[i], hardDays[j]),
        );
      }
    }

    if (minGap > bestScore) {
      bestScore = minGap;
      best = combination;
    }
  }

  return bestScore >= 2 ? best : chooseQualityDays(trainingDays, longRunDay, qualityCount - 1);
}

/** All k-subsets of `items`, in a stable order. */
function* combinations<T>(items: T[], k: number): Generator<T[]> {
  if (k === 0) {
    yield [];
    return;
  }

  for (let i = 0; i <= items.length - k; i++) {
    for (const rest of combinations(items.slice(i + 1), k - 1)) {
      yield [items[i], ...rest];
    }
  }
}

// ============================================================================
// Volume distribution
// ============================================================================

interface DayAllocation {
  dayOfWeek: number;
  durationSeconds: number;
  archetypeKey: ArchetypeKey;
  isQuality: boolean;
}

/**
 * Divide the week's volume between the chosen days.
 *
 * The long run is taken off the top (capped both as a fraction of the week and
 * in absolute terms), then the remainder is split by weight, and the rounding
 * residual is absorbed by the longest easy day so the week's sessions add up to
 * exactly the target volume.
 */
export function allocateVolume(
  week: WeekSkeleton,
  trainingDays: number[],
  longRunDay: number,
  qualityDays: number[],
  profile: DistanceProfile,
  qualityArchetypes: ArchetypeKey[],
  easyArchetype: ArchetypeKey,
  longRunArchetype: ArchetypeKey,
): DayAllocation[] {
  const longRunSeconds = Math.min(
    week.targetVolume * (trainingDays.length <= 2
      ? 0.5
      : trainingDays.length === 3
        ? Math.max(0.4, profile.longRunFraction)
        : profile.longRunFraction),
    profile.longRunCapSeconds,
  );

  const otherDays = trainingDays.filter((day) => day !== longRunDay);
  const remaining = Math.max(0, week.targetVolume - longRunSeconds);

  const totalWeight = otherDays.reduce(
    (total, day) =>
      total + (qualityDays.includes(day) ? QUALITY_WEIGHT : EASY_WEIGHT),
    0,
  );

  const allocations: DayAllocation[] = [
    {
      dayOfWeek: longRunDay,
      durationSeconds: roundToFiveMinutes(longRunSeconds),
      archetypeKey: longRunArchetype,
      isQuality: ARCHETYPES[longRunArchetype].isQuality,
    },
  ];

  let qualityIndex = 0;

  for (const day of otherDays) {
    const isQuality = qualityDays.includes(day);
    const weight = isQuality ? QUALITY_WEIGHT : EASY_WEIGHT;
    const raw = totalWeight > 0 ? (remaining * weight) / totalWeight : 0;

    const archetypeKey = isQuality
      ? (qualityArchetypes[
          qualityIndex++ % Math.max(1, qualityArchetypes.length)
        ] ?? easyArchetype)
      : easyArchetype;

    allocations.push({
      dayOfWeek: day,
      durationSeconds: clamp(
        roundToFiveMinutes(raw),
        Math.min(MIN_SESSION_SECONDS, raw),
        MAX_SESSION_SECONDS,
      ),
      archetypeKey,
      isQuality,
    });
  }

  // Absorb the rounding/clamping residual into the longest easy session so the
  // week actually delivers the volume the periodizer asked for.
  //
  // The long run is excluded: giving it the leftovers is what pushes it past
  // its own share-of-the-week cap, which is the one duration in the week that
  // must not drift upwards.
  const scheduled = allocations.reduce(
    (total, allocation) => total + allocation.durationSeconds,
    0,
  );
  const residual = week.targetVolume - scheduled;

  if (residual !== 0) {
    const target = allocations
      .filter(
        (allocation) =>
          !allocation.isQuality && allocation.dayOfWeek !== longRunDay,
      )
      .sort((a, b) => b.durationSeconds - a.durationSeconds)[0];

    if (target) {
      target.durationSeconds = Math.max(0, Math.min(MAX_SESSION_SECONDS, target.durationSeconds + residual));
    }
  }

  return allocations.sort((a, b) => a.dayOfWeek - b.dayOfWeek);
}

// ============================================================================
// Injury handling
// ============================================================================

type InjuryPolicy = 'NONE' | 'CAUTION' | 'SEVERE';

export function resolveInjuryPolicy(
  injuries: InjurySignal[],
  injuryAware: boolean,
): InjuryPolicy {
  if (!injuryAware) {
    return 'NONE';
  }

  const open = injuries.filter((injury) => injury.status !== 'RESOLVED');

  if (open.length === 0) {
    return 'NONE';
  }

  const worst = Math.max(...open.map((injury) => injury.painScore));
  const worsening = open.some((injury) => injury.status === 'WORSENING');

  if (
    worst >= INJURY_SEVERE_PAIN ||
    (worsening && worst >= INJURY_CAUTION_PAIN)
  ) {
    return 'SEVERE';
  }

  if (worst >= INJURY_CAUTION_PAIN) {
    return 'CAUTION';
  }

  return 'NONE';
}

// ============================================================================
// Week assembly
// ============================================================================

export function buildWeek(
  week: WeekSkeleton,
  context: WeekBuildContext,
): PlacedSession[] {
  const { input, profile } = context;

  const injuryPolicy = resolveInjuryPolicy(input.injuries, input.injuryAware);

  // An injured athlete trains less, and at lower impact.
  const volumeFactor =
    injuryPolicy === 'SEVERE' ? 0.6 : injuryPolicy === 'CAUTION' ? 0.8 : 1;
  // Three-day race builds can support one quality workout, an easy run and
  // a long run. Keep general fitness and unknown-fitness plans conservative.
  const hasFitnessEvidence = context.fitness.source !== 'DEFAULT' && context.fitness.source !== 'GOAL_TIME';
  const threeDayRaceBuild = input.daysPerWeek === 3 && input.raceDate !== null && input.targetTime !== null;
  const qualityLimit = input.daysPerWeek >= 4 ? 2 : threeDayRaceBuild ? 1 : 0;
  const adjustedWeek: WeekSkeleton = {
    ...week,
    targetVolume: Math.round(week.targetVolume * volumeFactor),
    qualityCount: injuryPolicy === 'NONE' && hasFitnessEvidence
      ? Math.min(week.qualityCount, qualityLimit)
      : 0,
  };

  const requestedLongRunDay = input.longRunDay;
  const trainingDays = chooseTrainingDays(
    input.availability,
    input.daysPerWeek,
    requestedLongRunDay,
  );
  const longRunDay = resolveLongRunDay(
    trainingDays,
    input.availability,
    requestedLongRunDay,
  );
  const rotation = profile.rotationByPhase[week.phase] ?? [];

  // The progressive long run is a *long run* variant, not a midweek session:
  // leaving it in the rotation hands a second long run to a quality day.
  const qualityArchetypes = rotate(
    rotation.filter((key) => key !== 'progressive-long-run'),
    context.rotationOffset,
  );

  const easyArchetype: ArchetypeKey =
    injuryPolicy === 'SEVERE'
      ? 'cross-training'
      : input.includeCrossTraining && week.isRecovery
        ? 'cross-training'
        : week.isRecovery
          ? 'recovery'
          : 'easy';

  const longRunArchetype: ArchetypeKey =
    injuryPolicy === 'SEVERE'
      ? 'cross-training'
      : // A progressive long run is quality work, so an injured athlete does
        // not get one either.
        adjustedWeek.qualityCount > 0 && injuryPolicy === 'NONE' &&
          rotation.includes('progressive-long-run') &&
          context.rotationOffset % 3 === 0 &&
          !week.isRecovery
        ? 'progressive-long-run'
        : 'long-run';

  // A progressive long run *is* a quality session, so it takes one of the
  // week's quality slots rather than adding a third hard day on top.
  const midweekQualityCount = Math.max(
    0,
    adjustedWeek.qualityCount -
      (ARCHETYPES[longRunArchetype].isQuality ? 1 : 0),
  );

  const qualityDays = chooseQualityDays(
    trainingDays,
    longRunDay,
    midweekQualityCount,
  );

  let allocations = allocateVolume(
    adjustedWeek,
    trainingDays,
    longRunDay,
    qualityDays,
    profile,
    qualityArchetypes,
    easyArchetype,
    longRunArchetype,
  );

  // Fit one continuous availability window, preserving the requested long-run cap.
  allocations = allocations.map(allocation => {
    const windows = input.availability.filter(slot => slot.dayOfWeek === allocation.dayOfWeek);
    const capacity = windows.length ? Math.max(...windows.map(slot => slotMinutes(slot) * 60)) : Infinity;
    const longCap = allocation.dayOfWeek === longRunDay && input.recentLongestRun
      ? input.recentLongestRun * Math.pow(1.08, week.weekNumber - 1) : Infinity;
    return { ...allocation, durationSeconds: Math.floor(Math.min(allocation.durationSeconds, capacity, longCap)) };
  }).filter(allocation => allocation.durationSeconds >= 600);

  // Race week: the race replaces whatever was scheduled that day, and nothing
  // hard is left standing in front of it.
  if (week.isRaceWeek && context.race) {
    allocations = allocations
      .filter(
        (allocation) =>
          allocation.dayOfWeek !== context.race?.dayOfWeek &&
          !allocation.isQuality &&
          (allocation.dayOfWeek - input.startDate.getUTCDay() + 7) % 7 < (context.race!.dayOfWeek - input.startDate.getUTCDay() + 7) % 7,
      )
      .map((allocation) => ({
        ...allocation,
        durationSeconds: Math.min(allocation.durationSeconds, 45 * 60),
        archetypeKey: (injuryPolicy === 'SEVERE' ? 'cross-training' : 'easy') as ArchetypeKey,
        isQuality: false,
      }));

    if (injuryPolicy === 'NONE') allocations.push({
      dayOfWeek: context.race.dayOfWeek,
      durationSeconds: context.race.durationSeconds,
      archetypeKey: 'race',
      isQuality: true,
    });

    allocations.sort((a, b) => a.dayOfWeek - b.dayOfWeek);
  }

  let sessions = allocations.map((allocation) =>
    materializeSession(allocation, context, week),
  );

  // 80/20 guard: if too much of the week ended up at threshold or above, trim
  // the quality sessions and rebuild them once.
  const hard = hardFraction(sessions);

  if (hard > MAX_HARD_FRACTION && !week.isRaceWeek) {
    const scale = MAX_HARD_FRACTION / hard;

    sessions = allocations
      .map((allocation) =>
        allocation.isQuality
          ? {
              ...allocation,
              durationSeconds: Math.max(
                MIN_SESSION_SECONDS,
                roundToFiveMinutes(allocation.durationSeconds * scale),
              ),
            }
          : allocation,
      )
      .map((allocation) => materializeSession(allocation, context, week));
  }

  return sessions;
}

function materializeSession(
  allocation: DayAllocation,
  context: WeekBuildContext,
  week: WeekSkeleton,
): PlacedSession {
  let archetype = ARCHETYPES[allocation.archetypeKey];

  const sessionContext: SessionContext = {
    effortBased: context.fitness.source === "DEFAULT" || context.fitness.source === "GOAL_TIME",
    paces: context.paces,
    maxQualitySeconds: context.input.daysPerWeek === 3
      ? allocation.archetypeKey === 'race-pace' ? 30 * 60 : 20 * 60
      : undefined,
    durationSeconds: allocation.durationSeconds,
    zoneIds: context.input.zoneIds,
    racePace: allocation.archetypeKey === 'race' && context.input.targetDistance && context.input.targetTime
      ? context.input.targetDistance / context.input.targetTime
      : context.racePace,
  };

  let built = archetype.build(sessionContext);
  if (built.durationSeconds > allocation.durationSeconds ||
      (archetype.isQuality && built.intensity === RunIntensity.EASY)) {
    archetype = ARCHETYPES.easy;
    built = archetype.build(sessionContext);
  }
  const estimatedLoad = estimateTrimp(built.segments, context.fitness);

  const distanceMeters =
    week.isRaceWeek && allocation.archetypeKey === 'race' && context.race
      ? context.race.distanceMeters
      : built.distanceMeters;

  return {
    archetype,
    built,
    skeleton: {
      archetype: archetype.key,
      intensity: built.intensity,
      dayOfWeek: allocation.dayOfWeek,
      sport: archetype.sport,
      durationSeconds: built.durationSeconds,
      distanceMeters,
      estimatedLoad: Math.round(estimatedLoad * 10) / 10,
      goalRpe: built.goalRpe,
      isQuality: archetype.isQuality,
    },
  };
}

/** Share of the week's time spent at threshold intensity or above. */
export function hardFraction(sessions: PlacedSession[]): number {
  let hard = 0;
  let total = 0;

  for (const session of sessions) {
    for (const segment of session.built.segments) {
      total += segment.durationSeconds;

      if (
        segment.intensity === RunIntensity.THRESHOLD ||
        segment.intensity === RunIntensity.INTERVAL ||
        segment.intensity === RunIntensity.REPETITION
      ) {
        hard += segment.durationSeconds;
      }
    }
  }

  return total > 0 ? hard / total : 0;
}

function rotate<T>(items: T[], offset: number): T[] {
  if (items.length === 0) {
    return items;
  }

  const shift = ((offset % items.length) + items.length) % items.length;
  return [...items.slice(shift), ...items.slice(0, shift)];
}

function roundToFiveMinutes(seconds: number): number {
  return Math.round(seconds / 300) * 300;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
