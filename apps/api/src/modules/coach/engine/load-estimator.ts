import {
  TRIMP_COEFFICIENT_K_FEMALE,
  TRIMP_COEFFICIENT_K_MALE,
  TRIMP_COEFFICIENT_Y_FEMALE,
  TRIMP_COEFFICIENT_Y_MALE,
} from 'src/common/constants/training-formulas.constants';

import { INTENSITY_HR_FRACTION } from './physiology';
import { type ResolvedFitness, RunIntensity } from './types';

/**
 * Planned training load estimation
 *
 * A planned session has no heart rate stream, so its load cannot be measured -
 * but it must be *estimated on the same scale* as the load TrainingLoadService
 * computes from real activities, otherwise "planned vs actual" comparisons and
 * the whole adaptation loop are meaningless.
 *
 * So this uses the identical Bannister TRIMP formula as
 * TrainingLoadService.calculateTRIMP:
 *
 *   TRIMP = duration_min * delta * y * e^(k * delta)
 *   delta = (HR - HRrest) / (HRmax - HRrest)
 *
 * The only difference is where `delta` comes from: instead of per-sample heart
 * rate, it is derived from the intended intensity of each segment via
 * INTENSITY_HR_FRACTION (a %HRmax anchored to TRAINING_ZONE_PERCENTAGES).
 */

const SECONDS_PER_MINUTE = 60;

/** A homogeneous chunk of a planned session. */
export interface LoadSegment {
  /** Explicit speed for race-specific blocks, in m/s. */
  velocity?: number | null;
  durationSeconds: number;
  intensity: RunIntensity;
}

/**
 * Heart rate reserve fraction for an intensity, given the athlete's HR range.
 * Clamped to [0, 1] so an athlete with an unusual HRrest/HRmax pair cannot
 * produce a negative or explosive load.
 */
export function heartRateReserveFraction(
  intensity: RunIntensity,
  fitness: Pick<ResolvedFitness, 'hrMax' | 'hrRest'>,
): number {
  const reserve = fitness.hrMax - fitness.hrRest;

  if (reserve <= 0) {
    return 0;
  }

  const heartRate = INTENSITY_HR_FRACTION[intensity] * fitness.hrMax;
  const fraction = (heartRate - fitness.hrRest) / reserve;

  return Math.min(1, Math.max(0, fraction));
}

/**
 * Estimate the TRIMP of a planned session from its intensity segments.
 */
export function estimateTrimp(
  segments: LoadSegment[],
  fitness: ResolvedFitness,
): number {
  const k =
    fitness.gender === 'female'
      ? TRIMP_COEFFICIENT_K_FEMALE
      : TRIMP_COEFFICIENT_K_MALE;
  const y =
    fitness.gender === 'female'
      ? TRIMP_COEFFICIENT_Y_FEMALE
      : TRIMP_COEFFICIENT_Y_MALE;

  let trimp = 0;

  for (const segment of segments) {
    if (segment.durationSeconds <= 0) {
      continue;
    }

    const minutes = segment.durationSeconds / SECONDS_PER_MINUTE;
    const delta = heartRateReserveFraction(segment.intensity, fitness);

    if (delta <= 0) {
      continue;
    }

    trimp += minutes * delta * y * Math.exp(k * delta);
  }

  return trimp;
}

/**
 * TRIMP per second of running at a given intensity. Used to convert between a
 * weekly volume target and a weekly load target without building the sessions
 * first.
 */
export function trimpPerSecond(
  intensity: RunIntensity,
  fitness: ResolvedFitness,
): number {
  return estimateTrimp([{ durationSeconds: 1, intensity }], fitness);
}
