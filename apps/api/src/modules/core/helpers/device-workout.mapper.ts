import {
  DEVICE_SCHEMA_VERSION,
  type DeviceStepKind,
  type DeviceWorkout,
  type DeviceWorkoutStep,
  WORKOUT_DURATION_TYPE,
  WORKOUT_STEP_TYPE,
  WORKOUT_TARGET_TYPE,
  getTargetIntensity,
} from '@openathlete/shared';

// ============================================================================
// Planned session -> watch-ready workout
// ============================================================================
// Pure mapping, no database access. The caller loads the athlete's zones and
// latest metrics once and passes them in, so a two-week feed costs two queries.
// Anything the watch cannot coach live (power, cadence, unknown zones) becomes
// instruction text plus a warning, never a rejected workout.
// ============================================================================

/** Plain-object view of the Prisma models this mapper reads. */
export type MapperTarget = {
  targetType: string;
  targetMin: number | null;
  targetMax: number | null;
  targetValue: number | null;
  metricType: string | null;
};
export type MapperStep = {
  workoutStepId: number;
  orderIndex: number;
  stepType: string;
  name: string | null;
  notes: string | null;
  durationType: string;
  durationValue: number | null;
  repeatParentId: number | null;
  targets: MapperTarget[];
  repeatBlock: { repetitions: number; childSteps: MapperStep[] } | null;
};
export type MapperEvent = {
  eventId: number;
  name: string;
  description: string | null;
  startDate: Date;
  training: {
    sport: string;
    description: string | null;
    goalDistance: number | null;
    goalDuration: number | null;
    goalRpe: number | null;
    workout: { workoutId: number; steps: MapperStep[] } | null;
  };
};
export type MapperZone = {
  trainingZoneId: number;
  index: number;
  type: string;
  values: { min: number; max: number; sports: string[] }[];
};
export type MapperContext = {
  metrics: Record<string, number>;
  zones: MapperZone[];
};

const MAX_STEPS = 500;
/** Planner pace targets carry a ±3% band; a single value gets the same band. */
const PACE_BAND = 0.03;
/** A single heart-rate value becomes a ±5 bpm band. */
const HEART_RATE_BAND = 5;

const KIND_BY_STEP_TYPE: Record<string, DeviceStepKind> = {
  [WORKOUT_STEP_TYPE.WARMUP]: 'warmup',
  [WORKOUT_STEP_TYPE.COOLDOWN]: 'cooldown',
  [WORKOUT_STEP_TYPE.INTERVAL_REST]: 'recovery',
};

const DEFAULT_TITLE: Record<DeviceStepKind, string> = {
  warmup: 'Warm up',
  run: 'Run',
  recovery: 'Recover',
  cooldown: 'Cool down',
};

const DEFAULT_INSTRUCTION: Record<DeviceStepKind, string> = {
  warmup: 'Start gently. Keep your breathing comfortable.',
  run: 'Follow this step’s target. Stay in control.',
  recovery: 'Jog or walk easy and let your breathing settle.',
  cooldown: 'Ease down. Finish feeling in control.',
};

const intensityOf = (target: MapperTarget, context: MapperContext) =>
  getTargetIntensity(
    target as Parameters<typeof getTargetIntensity>[0],
    context.metrics,
  );

const round = (value: number, digits = 1) =>
  Math.round(value * 10 ** digits) / 10 ** digits;
const positive = (value: number | null | undefined): value is number =>
  value !== null && value !== undefined && Number.isFinite(value) && value > 0;

export function toDeviceWorkout(
  event: MapperEvent,
  context: MapperContext,
): DeviceWorkout {
  const { training } = event;
  const warnings: string[] = [];
  const steps: DeviceWorkoutStep[] = [];
  const nextId = () => `${event.eventId}-${steps.length}`;

  const topLevel = (training.workout?.steps ?? [])
    .filter((step) => step.repeatParentId === null)
    .sort((a, b) => a.orderIndex - b.orderIndex);

  for (const source of topLevel) {
    if (source.stepType === WORKOUT_STEP_TYPE.REPEAT) {
      const block = source.repeatBlock;
      if (!block || block.repetitions < 1 || block.childSteps.length === 0) {
        warnings.push(`Skipped an empty repeat block.`);
        continue;
      }
      const children = [...block.childSteps].sort(
        (a, b) => a.orderIndex - b.orderIndex,
      );
      const groupId = `${event.eventId}-r${source.workoutStepId}`;
      for (let index = 1; index <= block.repetitions; index++) {
        for (const child of children) {
          steps.push(
            mapStep(child, nextId(), training.sport, context, warnings, {
              groupId,
              index,
              count: block.repetitions,
            }),
          );
        }
      }
    } else {
      steps.push(
        mapStep(source, nextId(), training.sport, context, warnings, null),
      );
    }
    if (steps.length > MAX_STEPS) {
      throw new Error(`Workout "${event.name}" exceeds ${MAX_STEPS} steps`);
    }
  }

  if (steps.length === 0) {
    // Unstructured session: one step from the session goal.
    const byDistance = positive(training.goalDistance);
    steps.push({
      id: nextId(),
      workoutStepId: null,
      title: event.name,
      kind: 'run',
      end: byDistance
        ? { type: 'distance', value: training.goalDistance }
        : positive(training.goalDuration)
          ? { type: 'time', value: training.goalDuration }
          : { type: 'open', value: null },
      pace: null,
      heartRate: null,
      rpe: positive(training.goalRpe) ? round(training.goalRpe * 10, 0) : null,
      instruction:
        training.description ??
        event.description ??
        'Follow the effort prescribed by your coach.',
      repeat: null,
    });
  }

  return {
    schemaVersion: DEVICE_SCHEMA_VERSION,
    eventId: event.eventId,
    workoutId: training.workout?.workoutId ?? null,
    title: event.name,
    description: training.description ?? event.description,
    scheduledAt: event.startDate.toISOString(),
    sport: training.sport,
    steps,
    warnings,
  };
}

function mapStep(
  source: MapperStep,
  id: string,
  sport: string,
  context: MapperContext,
  warnings: string[],
  repeat: DeviceWorkoutStep['repeat'],
): DeviceWorkoutStep {
  const kind = KIND_BY_STEP_TYPE[source.stepType] ?? 'run';
  const title = source.name?.trim() || DEFAULT_TITLE[kind];
  const notes: string[] = [];

  let end: DeviceWorkoutStep['end'] = { type: 'open', value: null };
  if (
    source.durationType === WORKOUT_DURATION_TYPE.TIME &&
    positive(source.durationValue)
  ) {
    end = { type: 'time', value: source.durationValue };
  } else if (
    source.durationType === WORKOUT_DURATION_TYPE.DISTANCE &&
    positive(source.durationValue)
  ) {
    end = { type: 'distance', value: source.durationValue };
  } else if (
    source.durationType === WORKOUT_DURATION_TYPE.HR_BELOW &&
    positive(source.durationValue)
  ) {
    notes.push(
      `Move on when heart rate drops below ${Math.round(source.durationValue)}.`,
    );
  } else if (
    source.durationType === WORKOUT_DURATION_TYPE.HR_ABOVE &&
    positive(source.durationValue)
  ) {
    notes.push(
      `Move on when heart rate rises above ${Math.round(source.durationValue)}.`,
    );
  }

  let pace: DeviceWorkoutStep['pace'] = null;
  let heartRate: DeviceWorkoutStep['heartRate'] = null;
  let rpe: number | null = null;

  for (const target of source.targets) {
    if (target.metricType && context.metrics[target.metricType] === undefined) {
      warnings.push(
        `${title}: no ${target.metricType} on record, target estimated from population defaults.`,
      );
    }
    switch (target.targetType) {
      case WORKOUT_TARGET_TYPE.PACE:
        pace = resolvePace(target, context) ?? pace;
        if (!pace)
          warnings.push(`${title}: pace target could not be resolved.`);
        break;
      case WORKOUT_TARGET_TYPE.HEARTRATE:
        heartRate = resolveHeartRate(target, context) ?? heartRate;
        if (!heartRate)
          warnings.push(`${title}: heart-rate target could not be resolved.`);
        break;
      case WORKOUT_TARGET_TYPE.ZONE: {
        const zone = resolveZone(target, sport, context);
        if (zone?.pace) pace = zone.pace;
        else if (zone?.heartRate) heartRate = zone.heartRate;
        else warnings.push(`${title}: training zone could not be resolved.`);
        if (zone?.name) notes.push(`${zone.name}.`);
        break;
      }
      case WORKOUT_TARGET_TYPE.RPE: {
        const value = target.targetValue ?? target.targetMax;
        if (value !== null && Number.isFinite(value)) {
          // Stored on a 0-1 scale.
          rpe = round(Math.min(1, Math.max(0, value)) * 10, 0);
          notes.push(`Effort ${rpe} out of 10.`);
        }
        break;
      }
      case WORKOUT_TARGET_TYPE.POWER:
      case WORKOUT_TARGET_TYPE.CADENCE: {
        const intensity = intensityOf(target, context);
        const low = intensity.min ?? intensity.value;
        const high = intensity.max ?? intensity.value;
        const unit =
          target.targetType === WORKOUT_TARGET_TYPE.POWER ? 'W' : 'spm';
        if (positive(low) && positive(high)) {
          notes.push(
            low === high
              ? `Aim for ${Math.round(low)} ${unit}.`
              : `Aim for ${Math.round(low)}–${Math.round(high)} ${unit}.`,
          );
        }
        break;
      }
      default:
        break;
    }
  }

  const base = source.notes?.trim() || DEFAULT_INSTRUCTION[kind];
  return {
    id,
    workoutStepId: source.workoutStepId,
    title,
    kind,
    end,
    pace,
    heartRate,
    rpe,
    instruction: [base, ...notes].join(' '),
    repeat,
  };
}

/** PACE targets are stored as speed in m/s (absolute or % of VMA). */
export function resolvePace(
  target: MapperTarget,
  context: MapperContext,
): DeviceWorkoutStep['pace'] {
  const intensity = intensityOf(target, context);
  let low = intensity.min;
  let high = intensity.max;
  if (!positive(low) || !positive(high)) {
    if (!positive(intensity.value)) return null;
    low = intensity.value * (1 - PACE_BAND);
    high = intensity.value * (1 + PACE_BAND);
  }
  const [slowSpeed, fastSpeed] = low <= high ? [low, high] : [high, low];
  // Faster speed means fewer seconds per kilometer.
  return { fast: round(1000 / fastSpeed), slow: round(1000 / slowSpeed) };
}

/** HEARTRATE targets are bpm, or fractions of HR_MAX/HR_RESERVE when a metric is referenced. */
export function resolveHeartRate(
  target: MapperTarget,
  context: MapperContext,
): DeviceWorkoutStep['heartRate'] {
  const intensity = intensityOf(target, context);
  const min = positive(intensity.min) ? Math.round(intensity.min) : null;
  const max = positive(intensity.max) ? Math.round(intensity.max) : null;
  if (min !== null || max !== null) {
    return min !== null && max !== null && min > max
      ? { min: max, max: min }
      : { min, max };
  }
  if (!positive(intensity.value)) return null;
  return {
    min: Math.round(intensity.value - HEART_RATE_BAND),
    max: Math.round(intensity.value + HEART_RATE_BAND),
  };
}

/**
 * ZONE targets hold the athlete's trainingZoneId (planner and web picker).
 * Older data may hold a 1-5 zone number instead; fall back to the heart-rate
 * zone at that position.
 */
export function resolveZone(
  target: MapperTarget,
  sport: string,
  context: MapperContext,
): {
  name: string;
  pace?: DeviceWorkoutStep['pace'];
  heartRate?: DeviceWorkoutStep['heartRate'];
} | null {
  const value = target.targetValue;
  if (value === null || !Number.isInteger(value)) return null;
  const zone =
    context.zones.find((candidate) => candidate.trainingZoneId === value) ??
    (value >= 1 && value <= 5
      ? context.zones.find(
          (candidate) =>
            candidate.type === 'HEARTRATE' && candidate.index === value - 1,
        )
      : undefined);
  if (!zone) return null;
  const range =
    zone.values.find((entry) => entry.sports.includes(sport)) ??
    zone.values.find((entry) => entry.sports.length === 0);
  if (!range || !positive(range.min) || !positive(range.max)) return null;
  const name = `Zone ${zone.index + 1}`;
  if (zone.type === 'HEARTRATE') {
    return {
      name,
      heartRate: {
        min: Math.round(Math.min(range.min, range.max)),
        max: Math.round(Math.max(range.min, range.max)),
      },
    };
  }
  if (zone.type === 'PACE') {
    // Pace zones are entered in decimal minutes per kilometer.
    const fast = Math.min(range.min, range.max) * 60;
    const slow = Math.max(range.min, range.max) * 60;
    return { name, pace: { fast: round(fast), slow: round(slow) } };
  }
  return null;
}
