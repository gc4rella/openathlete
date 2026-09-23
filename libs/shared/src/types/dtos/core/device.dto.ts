import { z } from 'zod';

// ============================================================================
// Device DTOs
// ============================================================================
// Contract between the API and the native Apple apps (iPhone + Watch).
// - DeviceWorkout: a planned session flattened for real-time execution. Repeats
//   are expanded and every target is resolved to absolute units (bpm, s/km),
//   so the watch never needs athlete zones or metrics.
// - DeviceSession: a completed run recorded on the device, with per-step results.
// Bump DEVICE_SCHEMA_VERSION on breaking changes; the apps check it.
// ============================================================================

export const DEVICE_SCHEMA_VERSION = 1;

export const DEVICE_STEP_KIND = [
  'warmup',
  'run',
  'recovery',
  'cooldown',
] as const;
export type DeviceStepKind = (typeof DEVICE_STEP_KIND)[number];

export type DeviceWorkoutStep = {
  /** Unique within the workout, stable across fetches ("<eventId>-<n>") */
  id: string;
  /** Planned step this entry came from; shared by all repetitions */
  workoutStepId: number | null;
  title: string;
  kind: DeviceStepKind;
  end: { type: 'time' | 'distance' | 'open'; value: number | null };
  /** Seconds per kilometer. fast <= slow */
  pace: { fast: number; slow: number } | null;
  /** Beats per minute. Either bound may be open */
  heartRate: { min: number | null; max: number | null } | null;
  /** 0-10 */
  rpe: number | null;
  instruction: string;
  repeat: { groupId: string; index: number; count: number } | null;
};

export type DeviceWorkout = {
  schemaVersion: number;
  eventId: number;
  workoutId: number | null;
  title: string;
  description: string | null;
  scheduledAt: string;
  sport: string;
  steps: DeviceWorkoutStep[];
  /** Targets that could not be resolved and were degraded to effort cues */
  warnings: string[];
};

const optionalNumber = z.number().finite().nullish();

export const deviceSessionSampleSchema = z.object({
  t: z.number().finite().min(0),
  distance: z.number().finite().min(0),
  heartRate: optionalNumber,
  speed: optionalNumber,
  latitude: z.number().min(-90).max(90).nullish(),
  longitude: z.number().min(-180).max(180).nullish(),
});

export const deviceSessionStepSchema = z.object({
  stepId: z.string().min(1).max(100),
  workoutStepId: z.number().int().positive().nullish(),
  title: z.string().max(200),
  kind: z.enum(DEVICE_STEP_KIND),
  repeatIndex: z.number().int().positive().nullish(),
  repeatCount: z.number().int().positive().nullish(),
  targetLabel: z.string().max(100).nullish(),
  startOffset: z.number().finite().min(0),
  endOffset: z.number().finite().min(0),
  distance: z.number().finite().min(0),
  averageHeartRate: optionalNumber,
  maxHeartRate: optionalNumber,
  timeInTarget: z.number().min(0).max(1).nullish(),
  outcome: z.enum(['completed', 'cut', 'skipped']),
});

export const deviceSessionSchema = z.object({
  schemaVersion: z.literal(DEVICE_SCHEMA_VERSION),
  /** Generated on the device; makes uploads idempotent */
  clientId: z.string().uuid(),
  eventId: z.number().int().positive().nullish(),
  title: z.string().min(1).max(200),
  startedAt: z.string().datetime({ offset: true }),
  duration: z.number().finite().positive().max(86_400),
  distance: z.number().finite().min(0).max(500_000),
  samples: z.array(deviceSessionSampleSchema).max(20_000),
  steps: z.array(deviceSessionStepSchema).max(500),
  adaptations: z.array(z.string().max(300)).max(50).default([]),
});

export type DeviceSessionSample = z.infer<typeof deviceSessionSampleSchema>;
export type DeviceSessionStep = z.infer<typeof deviceSessionStepSchema>;
export type DeviceSessionDto = z.infer<typeof deviceSessionSchema>;

export type DeviceSessionResult = {
  status: 'imported' | 'duplicate';
  eventId: number;
  linkedEventId: number | null;
};
