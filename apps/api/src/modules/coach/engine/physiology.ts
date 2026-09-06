import {
  DEFAULT_HR_MAX,
  DEFAULT_HR_REST,
  DEFAULT_VMA_KMH,
  TRAINING_ZONE_PERCENTAGES,
} from 'src/common/constants/training-formulas.constants';

import {
  type FitnessInputs,
  type PaceTable,
  type ResolvedFitness,
  RunIntensity,
} from './types';

/**
 * Running physiology
 *
 * Derives an athlete's VDOT (Daniels' composite fitness number) from whatever
 * signals are available, and turns it into concrete training paces.
 *
 * References:
 * - Daniels, J. & Gilbert, J. (1979). Oxygen Power.
 * - Daniels, J. (2013). Daniels' Running Formula, 3rd ed.
 * - Riegel, P. (1981). Athletic records and human endurance.
 *
 * Every function here is pure and deterministic. No LLM is involved in
 * producing a single pace: a hallucinated training pace is an injury.
 */

const SECONDS_PER_MINUTE = 60;
const METERS_PER_KILOMETER = 1000;

// ============================================================================
// Daniels/Gilbert oxygen power equations
// ============================================================================

/**
 * Aerobic demand (ml/kg/min) of running at a given velocity.
 *
 * VO2 = -4.60 + 0.182258 * v + 0.000104 * v^2, with v in meters per minute.
 * Source: Daniels & Gilbert (1979).
 */
export function vo2AtVelocity(metersPerMinute: number): number {
  return (
    -4.6 +
    0.182258 * metersPerMinute +
    0.000104 * metersPerMinute * metersPerMinute
  );
}

/**
 * Inverse of {@link vo2AtVelocity}: the velocity (m/min) that costs a given
 * aerobic demand. Solves the quadratic and takes the positive root.
 */
export function velocityForVo2(vo2: number): number {
  const a = 0.000104;
  const b = 0.182258;
  const c = -4.6 - vo2;
  const discriminant = b * b - 4 * a * c;

  if (discriminant <= 0) {
    return 0;
  }

  return (-b + Math.sqrt(discriminant)) / (2 * a);
}

/**
 * Fraction of VO2max an athlete can sustain for a given race duration.
 *
 * %VO2max = 0.8 + 0.1894393*e^(-0.012778t) + 0.2989558*e^(-0.1932605t),
 * with t in minutes. Source: Daniels & Gilbert (1979).
 */
export function percentVo2maxForDuration(minutes: number): number {
  return (
    0.8 +
    0.1894393 * Math.exp(-0.012778 * minutes) +
    0.2989558 * Math.exp(-0.1932605 * minutes)
  );
}

/**
 * VDOT implied by a performance over a known distance and time.
 */
export function vdotFromPerformance(
  distanceMeters: number,
  timeSeconds: number,
): number {
  if (distanceMeters <= 0 || timeSeconds <= 0) {
    return 0;
  }

  const minutes = timeSeconds / SECONDS_PER_MINUTE;
  const metersPerMinute = distanceMeters / minutes;

  return vo2AtVelocity(metersPerMinute) / percentVo2maxForDuration(minutes);
}

/**
 * Predicted race time (seconds) over a distance for a given VDOT.
 *
 * There is no closed form: %VO2max depends on the duration we are solving for.
 * Bisection converges in well under 60 iterations and is deterministic, which
 * matters because plans must be reproducible from their stored input.
 */
export function predictRaceTime(vdot: number, distanceMeters: number): number {
  if (vdot <= 0 || distanceMeters <= 0) {
    return 0;
  }

  // Bracket the answer between an implausibly fast and an implausibly slow pace.
  let lowMinutes = distanceMeters / (12 * SECONDS_PER_MINUTE); // 12 m/s
  let highMinutes = distanceMeters / (1 * SECONDS_PER_MINUTE); // 1 m/s

  for (let i = 0; i < 60; i++) {
    const midMinutes = (lowMinutes + highMinutes) / 2;
    const metersPerMinute = distanceMeters / midMinutes;
    const demand = vo2AtVelocity(metersPerMinute);
    const supply = vdot * percentVo2maxForDuration(midMinutes);

    if (demand > supply) {
      // Too fast to sustain: allow more time.
      lowMinutes = midMinutes;
    } else {
      highMinutes = midMinutes;
    }
  }

  return ((lowMinutes + highMinutes) / 2) * SECONDS_PER_MINUTE;
}

/**
 * Riegel's endurance model: equivalent time over a different distance.
 * t2 = t1 * (d2/d1)^1.06
 */
export function riegelEquivalentTime(
  knownDistanceMeters: number,
  knownTimeSeconds: number,
  targetDistanceMeters: number,
  exponent = 1.06,
): number {
  if (knownDistanceMeters <= 0 || knownTimeSeconds <= 0) {
    return 0;
  }

  return (
    knownTimeSeconds *
    Math.pow(targetDistanceMeters / knownDistanceMeters, exponent)
  );
}

// ============================================================================
// Intensity mapping
// ============================================================================

/**
 * Marathon distance, in meters. Marathon pace is defined as the pace the
 * athlete would actually race a marathon at, not a fixed share of VO2max.
 */
const MARATHON_METERS = 42195;

/**
 * Easy intensities are genuinely defined as a fraction of VO2max.
 * Source: Daniels' Running Formula (E pace = 59-74% VO2max).
 */
const INTENSITY_VO2_FRACTION: Partial<Record<RunIntensity, number>> = {
  [RunIntensity.RECOVERY]: 0.62,
  [RunIntensity.EASY]: 0.7,
};

/**
 * The quality intensities are defined by *how long the effort could be held*,
 * not by a fixed fraction:
 *
 * - Threshold is one-hour race pace.
 * - Interval work is run at 3-5k effort, roughly a 12 minute race.
 * - Repetitions are run at ~1500m/mile effort, roughly a 5 minute race.
 *
 * Deriving them this way rather than from hard-coded fractions matters most at
 * the slow end of the range: a fixed "marathon = 84% of VO2max" prescribes a
 * pace a four-hour marathoner cannot hold for four hours.
 */
const INTENSITY_EFFORT_MINUTES: Partial<Record<RunIntensity, number>> = {
  [RunIntensity.THRESHOLD]: 60,
  [RunIntensity.INTERVAL]: 12,
  [RunIntensity.REPETITION]: 5,
};

/**
 * Approximate %HRmax for each intensity, used to estimate the training load of
 * a *planned* session (no heart rate stream exists yet). Anchored to the
 * shared TRAINING_ZONE_PERCENTAGES so planned and actual load stay comparable.
 *
 * REPETITION sits above Z5: the efforts are short and heart rate lags, but for
 * load accounting the cardiovascular cost is close to maximal.
 */
export const INTENSITY_HR_FRACTION: Record<RunIntensity, number> = {
  [RunIntensity.RECOVERY]: TRAINING_ZONE_PERCENTAGES.Z1,
  [RunIntensity.EASY]: TRAINING_ZONE_PERCENTAGES.Z2,
  [RunIntensity.MARATHON]: TRAINING_ZONE_PERCENTAGES.Z3,
  [RunIntensity.THRESHOLD]: TRAINING_ZONE_PERCENTAGES.Z4,
  [RunIntensity.INTERVAL]: TRAINING_ZONE_PERCENTAGES.Z5,
  [RunIntensity.REPETITION]: 0.95,
};

/** RPE (0-10) associated with each intensity, stored as the session goal. */
export const INTENSITY_RPE: Record<RunIntensity, number> = {
  [RunIntensity.RECOVERY]: 2,
  [RunIntensity.EASY]: 3,
  [RunIntensity.MARATHON]: 6,
  [RunIntensity.THRESHOLD]: 7,
  [RunIntensity.INTERVAL]: 9,
  [RunIntensity.REPETITION]: 9,
};

// ============================================================================
// Fitness resolution
// ============================================================================

/**
 * Efforts shorter than this are dominated by anaerobic capacity and are poor
 * VDOT estimators, so they are ignored when deriving current fitness.
 */
const MIN_EFFORT_DISTANCE_METERS = 1500;
const MIN_EFFORT_SECONDS = 180;

/**
 * Resolve the athlete's current VDOT from the best signal available.
 *
 * Priority: a real recent performance beats a device-reported metric, which
 * beats a population default. The chosen source is returned so the UI can tell
 * the athlete what their paces are based on.
 */
export function resolveFitness(
  fitness: FitnessInputs,
  goal?: { distanceMeters: number | null; timeSeconds: number | null },
): ResolvedFitness {
  const hrMax = positiveOr(fitness.hrMax, DEFAULT_HR_MAX);
  const hrRest = positiveOr(fitness.hrRest, DEFAULT_HR_REST);
  const gender = fitness.gender === 'female' ? 'female' : 'male';

  const goalVdot =
    goal?.distanceMeters && goal?.timeSeconds
      ? vdotFromPerformance(goal.distanceMeters, goal.timeSeconds)
      : null;

  const usableEfforts = (fitness.bestEfforts ?? []).filter(
    (effort) =>
      effort.distanceMeters >= MIN_EFFORT_DISTANCE_METERS &&
      effort.timeSeconds >= MIN_EFFORT_SECONDS,
  );

  if (usableEfforts.length > 0) {
    const currentVdot = Math.max(
      ...usableEfforts.map((effort) =>
        vdotFromPerformance(effort.distanceMeters, effort.timeSeconds),
      ),
    );

    return {
      currentVdot,
      goalVdot,
      source: 'BEST_EFFORT',
      hrMax,
      hrRest,
      gender,
    };
  }

  if (isPositive(fitness.vo2max)) {
    return {
      currentVdot: fitness.vo2max,
      goalVdot,
      source: 'VO2MAX_METRIC',
      hrMax,
      hrRest,
      gender,
    };
  }

  if (isPositive(fitness.vmaKmh)) {
    // VMA is the velocity at VO2max, so its aerobic demand *is* VO2max.
    const metersPerMinute =
      (fitness.vmaKmh * METERS_PER_KILOMETER) / SECONDS_PER_MINUTE;

    return {
      currentVdot: vo2AtVelocity(metersPerMinute),
      goalVdot,
      source: 'VMA_METRIC',
      hrMax,
      hrRest,
      gender,
    };
  }

  if (goalVdot !== null) {
    return {
      currentVdot: goalVdot * 0.92,
      goalVdot,
      source: 'GOAL_TIME',
      hrMax,
      hrRest,
      gender,
    };
  }

  const defaultMetersPerMinute =
    (DEFAULT_VMA_KMH * METERS_PER_KILOMETER) / SECONDS_PER_MINUTE;

  return {
    currentVdot: vo2AtVelocity(defaultMetersPerMinute),
    goalVdot,
    source: 'DEFAULT',
    hrMax,
    hrRest,
    gender,
  };
}

/**
 * VDOT to train off in a given week.
 *
 * Training paces follow *current* fitness, not the goal - training at goal pace
 * from week one can overstate readiness. New performance evidence is needed
 * before increasing training paces.
 */
export function vdotForProgress(
  fitness: ResolvedFitness,
  progress: number,
): number {
  // A goal does not establish a fitness improvement. Reassess from new evidence.
  void progress;
  return fitness.currentVdot;
}

/**
 * Training paces in m/s for a given VDOT.
 *
 * m/s is the unit the database stores for PACE workout targets (see
 * convertWorkoutPaceTargetsToMs in the agent helpers), so the engine emits it
 * directly and no unit conversion is needed on the way in.
 */
export function paceTableForVdot(vdot: number): PaceTable {
  const table = {} as PaceTable;

  for (const intensity of Object.values(RunIntensity)) {
    table[intensity] = velocityForIntensity(vdot, intensity);
  }

  return table;
}

/** Speed in m/s for one intensity at a given VDOT. */
export function velocityForIntensity(
  vdot: number,
  intensity: RunIntensity,
): number {
  if (intensity === RunIntensity.MARATHON) {
    const marathonSeconds = predictRaceTime(vdot, MARATHON_METERS);
    return marathonSeconds > 0 ? MARATHON_METERS / marathonSeconds : 0;
  }

  const effortMinutes = INTENSITY_EFFORT_MINUTES[intensity];

  const fraction =
    effortMinutes !== undefined
      ? percentVo2maxForDuration(effortMinutes)
      : (INTENSITY_VO2_FRACTION[intensity] ?? 0.7);

  return velocityForVo2(vdot * fraction) / SECONDS_PER_MINUTE;
}

/** Convert a speed in m/s to a pace in seconds per kilometer. */
export function secondsPerKm(metersPerSecond: number): number {
  if (metersPerSecond <= 0) {
    return 0;
  }

  return METERS_PER_KILOMETER / metersPerSecond;
}

/** Format a speed in m/s as a "m:ss/km" pace string. */
export function formatPace(metersPerSecond: number): string {
  const total = Math.round(secondsPerKm(metersPerSecond));
  const minutes = Math.floor(total / SECONDS_PER_MINUTE);
  const seconds = total % SECONDS_PER_MINUTE;

  return `${minutes}:${seconds.toString().padStart(2, '0')}/km`;
}

function isPositive(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function positiveOr(
  value: number | null | undefined,
  fallback: number,
): number {
  return isPositive(value) ? value : fallback;
}
