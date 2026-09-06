import { CYCLE_PHASE, SPORT_TYPE } from '@openathlete/shared';

/**
 * Engine types
 *
 * These describe the inputs and intermediate products of the deterministic plan
 * generation engine. Nothing in this directory imports Nest or Prisma: the
 * engine is a pure function of its inputs, so it can be unit tested without a
 * database and so a generated plan can be reproduced from the
 * `TrainingPlan.generationInput` snapshot.
 */

/**
 * Running intensity levels, following Daniels' running formula.
 *
 * Each level maps to a fraction of VO2max (used to derive pace) and to a
 * %HRmax (used to estimate training load on the same TRIMP scale that
 * TrainingLoadService computes from real activities).
 */
export enum RunIntensity {
  /** Very easy shakeout / active recovery */
  RECOVERY = 'RECOVERY',
  /** Conversational aerobic base pace */
  EASY = 'EASY',
  /** Marathon race pace */
  MARATHON = 'MARATHON',
  /** Lactate threshold / "comfortably hard" tempo */
  THRESHOLD = 'THRESHOLD',
  /** VO2max intervals, ~3-5 min efforts */
  INTERVAL = 'INTERVAL',
  /** Short, fast repetitions for economy and speed */
  REPETITION = 'REPETITION',
}

/** Athlete fitness signals used to derive training paces. */
export interface FitnessInputs {
  /** Maximal aerobic speed in km/h (MetricType.VMA) */
  vmaKmh?: number | null;
  /** VO2max in ml/kg/min (MetricType.VO2MAX) */
  vo2max?: number | null;
  /** Maximum heart rate in bpm (MetricType.HR_MAX) */
  hrMax?: number | null;
  /** Resting heart rate in bpm (MetricType.HR_REST) */
  hrRest?: number | null;
  /** Used to select the gender-specific TRIMP coefficients */
  gender?: 'male' | 'female' | null;
  /** Recent representative efforts, used to derive VDOT */
  bestEfforts?: BestEffort[];
}

export interface BestEffort {
  distanceMeters: number;
  timeSeconds: number;
}

export type VdotSource =
  | 'BEST_EFFORT'
  | 'VO2MAX_METRIC'
  | 'VMA_METRIC'
  | 'GOAL_TIME'
  | 'DEFAULT';

export interface ResolvedFitness {
  /** VDOT reflecting the athlete's current fitness */
  currentVdot: number;
  /** VDOT implied by the goal time, if a goal time was given */
  goalVdot: number | null;
  source: VdotSource;
  hrMax: number;
  hrRest: number;
  gender: 'male' | 'female';
}

/** Training paces in m/s, one per intensity level. */
export type PaceTable = Record<RunIntensity, number>;

/** A weekly availability window, mirroring the AthleteAvailability model. */
export interface AvailabilitySlot {
  /** 0=Sunday .. 6=Saturday */
  dayOfWeek: number;
  /** "HH:mm" */
  startTime: string;
  /** "HH:mm" */
  endTime: string;
  priority: 'LOW' | 'MEDIUM' | 'HIGH';
}

/** An open injury that should bias the plan away from impact. */
export interface InjurySignal {
  location: string;
  /** 0-10 scale */
  painScore: number;
  status: 'WORSENING' | 'IMPROVING' | 'STABLE' | 'RESOLVED';
}

/** Optional mapping of intensity to a configured TrainingZone id. */
export type ZoneIdByIntensity = Partial<Record<RunIntensity, number>>;

/** Everything the engine needs. Assembled by PlanGenerationService. */
export interface EngineInput {
  timeZone?: string;
  recentLongestRun?: number | null;
  sport: SPORT_TYPE;
  startDate: Date;
  /** Race day, or null for open-ended fitness plans */
  raceDate: Date | null;
  /** Race/target distance in meters, or null */
  targetDistance: number | null;
  /** Goal finish time in seconds, or null */
  targetTime: number | null;
  /** Plan length in weeks; derived from raceDate when a race is set */
  durationWeeks: number;
  daysPerWeek: number;
  /** 0=Sunday .. 6=Saturday, or null to let the engine choose */
  longRunDay: number | null;
  /** Current weekly training volume in seconds */
  currentWeeklyVolume: number | null;
  includeCrossTraining: boolean;
  injuryAware: boolean;
  planName: string | null;
  fitness: FitnessInputs;
  availability: AvailabilitySlot[];
  injuries: InjurySignal[];
  zoneIds?: ZoneIdByIntensity;
  /** Locale for the generated fallback prose */
  language: 'EN' | 'FR' | 'IT';
}

/** One week of the periodization curve, before sessions are placed. */
export interface WeekSkeleton {
  /** 1-based index across the whole plan */
  weekNumber: number;
  phase: CYCLE_PHASE;
  isRecovery: boolean;
  /** Target training volume for the week in seconds */
  targetVolume: number;
  /** How many quality (hard) sessions this week should contain */
  qualityCount: number;
  /** True for the week containing the race */
  isRaceWeek: boolean;
}

/** A session as produced by the week builder, before prose is attached. */
export interface SessionSkeleton {
  archetype: string;
  intensity: RunIntensity;
  dayOfWeek: number;
  sport: SPORT_TYPE;
  /** Total planned duration in seconds */
  durationSeconds: number;
  /** Planned distance in meters, when the session is distance-driven */
  distanceMeters: number | null;
  /** Estimated TRIMP for the session */
  estimatedLoad: number;
  /** RPE on a 0-10 scale */
  goalRpe: number;
  /** True for quality/hard sessions */
  isQuality: boolean;
}
