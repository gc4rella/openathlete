import { z } from 'zod';
import { isTimeZone } from '../../../utils/calendar-date';

import {
  AVAILABILITY_PRIORITY,
  CYCLE_PHASE,
  PLAN_ADJUSTMENT_TRIGGER,
  PLAN_STATUS,
  SPORT_TYPE,
} from '../../misc';
import { createWorkoutStepDtoSchema } from './workout.dto';

// ============================================================================
// Training Plan DTOs
// ============================================================================
// Canonical shape of a generated training plan, shared by:
// - the deterministic plan generation engine (apps/api .../modules/coach/engine)
// - the plan materializer that writes it to TrainingPlan/Cycle/TrainingWeek/Event
// - the static SEO plans served by the website (see ../seo/seo-plan.dto)
//
// The SEO plan schema is an alias of this one: every field added here for the
// generator is optional, so plans authored before the generator existed (and
// TemporaryTrainingPlan rows already in the database) still validate.
// ============================================================================

const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/;

export const elevationGainRangeSchema = z.object({
  min: z.number(),
  max: z.number().optional(),
});

export type ElevationGainRange = z.infer<typeof elevationGainRangeSchema>;

export const planSessionSchema = z.object({
  scheduledDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dayOfWeek: z.number().min(0).max(6), // 0-6 (sunday-saturday)
  name: z.string().min(1),
  sport: z.nativeEnum(SPORT_TYPE),
  description: z.string(),
  goalDistance: z.number().optional().nullable(),
  goalDuration: z.number().optional().nullable(), // seconds
  goalElevationGain: z.number().optional().nullable(),
  /// Goal RPE on a 0-10 scale (converted to the 0-1 scale on materialization)
  goalRpe: z.number().optional().nullable(),
  /// Estimated training load (TRIMP) for this session, produced by the engine
  estimatedLoad: z.number().optional().nullable(),
  /// Preferred start time "HH:mm"; falls back to the athlete's availability window
  startTime: z.string().regex(HH_MM).optional().nullable(),
  /// Session archetype key (e.g. "long-run", "threshold"), used by the adaptation
  /// engine to downgrade or swap a session without re-deriving its intent
  archetype: z.string().optional().nullable(),
  workout: z
    .object({
      steps: z.array(createWorkoutStepDtoSchema).default([]),
    })
    .optional()
    .nullable(),
});

export type PlanSession = z.infer<typeof planSessionSchema>;

export const planWeekSchema = z.object({
  phase: z.nativeEnum(CYCLE_PHASE).optional(),
  weekNumber: z.number().min(1),
  theme: z.string().optional().nullable(),
  /// Target training volume for the week in seconds
  targetVolume: z.number().optional().nullable(),
  /// Target training load (TRIMP) for the week
  targetLoad: z.number().optional().nullable(),
  sessions: z.array(planSessionSchema),
});

export type PlanWeek = z.infer<typeof planWeekSchema>;

export const planCycleSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  phase: z.nativeEnum(CYCLE_PHASE),
  color: z.string().optional().nullable(),
  weeks: z.array(planWeekSchema),
});

export type PlanCycle = z.infer<typeof planCycleSchema>;

export const planInfoSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  goal: z.string().min(1),
  sportType: z.nativeEnum(SPORT_TYPE),
  distance: z.number(), // meters
  duration: z.number().min(1), // total duration in weeks
  // For running/triathlon : time target in seconds (ex: 16200 for 4h30)
  timeTarget: z.number().optional().nullable(),
  // For trail : positive elevation gain range (ex: 2000 for "2000d+")
  elevationGainRange: elevationGainRangeSchema.optional().nullable(),
  /// Free-form coach rationale for the plan as a whole
  coachNotes: z.string().optional().nullable(),
});

export type PlanInfo = z.infer<typeof planInfoSchema>;

export const generatedPlanDataSchema = z.object({
  plan: planInfoSchema,
  cycles: z.array(planCycleSchema),
});

export type GeneratedPlanData = z.infer<typeof generatedPlanDataSchema>;

// ============================================================================
// Plan generation input (wizard answers)
// ============================================================================

export enum PLAN_GOAL_KIND {
  /// Build towards a specific race on a specific date
  RACE = 'RACE',
  /// No race; just get fitter over a chosen number of weeks
  GENERAL_FITNESS = 'GENERAL_FITNESS',
}

export const planGenerationInputSchema = z
  .object({
    goalKind: z.nativeEnum(PLAN_GOAL_KIND),
    language: z.enum(['EN', 'FR', 'IT']).optional(),
    sport: z.nativeEnum(SPORT_TYPE).default(SPORT_TYPE.RUNNING),
    /// First day of the plan
    timeZone: z.string().refine(isTimeZone, "Invalid time zone").default("UTC"),
    recentLongestRun: z.number().positive().optional().nullable(),
    startDate: z.coerce.date(),
    /// Race day (required when goalKind is RACE)
    raceDate: z.coerce.date().optional().nullable(),
    /// Race/target distance in meters (required when goalKind is RACE)
    targetDistance: z.number().positive().optional().nullable(),
    /// Goal finish time in seconds (optional; paces are derived from fitness if absent)
    targetTime: z.number().int().positive().optional().nullable(),
    /// Plan length in weeks (required when goalKind is GENERAL_FITNESS)
    durationWeeks: z.number().int().min(4).max(52).optional().nullable(),
    /// Training days per week
    daysPerWeek: z.number().int().min(2).max(7),
    /// Preferred long run day (0=Sunday .. 6=Saturday)
    longRunDay: z.number().int().min(0).max(6).optional().nullable(),
    /// Current weekly training volume in seconds. Prefilled from the athlete's
    /// real 8-week history when available; the ramp starts from this value.
    currentWeeklyVolume: z.number().nonnegative().optional().nullable(),
    /// Allow low-impact cross-training sessions (bike/swim) in place of easy runs
    includeCrossTraining: z.boolean().default(false),
    /// Take open injuries into account when placing impact sessions
    injuryAware: z.boolean().default(true),
    /// Override the generated plan name
    planName: z.string().min(1).optional().nullable(),
  })
  .refine(
    (input) =>
      input.goalKind !== PLAN_GOAL_KIND.RACE ||
      (input.raceDate != null && input.targetDistance != null),
    {
      message: 'A race plan requires both raceDate and targetDistance',
      path: ['raceDate'],
    },
  )
  .refine(
    (input) =>
      input.goalKind !== PLAN_GOAL_KIND.GENERAL_FITNESS ||
      input.durationWeeks != null,
    {
      message: 'A general fitness plan requires durationWeeks',
      path: ['durationWeeks'],
    },
  )
  .refine(
    (input) =>
      input.raceDate == null ||
      input.raceDate.getTime() > input.startDate.getTime(),
    {
      message: 'raceDate must be after startDate',
      path: ['raceDate'],
    },
  );

export type PlanGenerationInput = z.infer<typeof planGenerationInputSchema>;

// ============================================================================
// Training plan CRUD DTOs
// ============================================================================

export const createTrainingPlanDtoSchema = z.object({
  input: planGenerationInputSchema,
  /// Activate the plan immediately instead of leaving it as a DRAFT
  activate: z.boolean().default(false),
  /// Skip the LLM narrative pass even when AI features are available
  skipNarrative: z.boolean().default(false),
});

export type CreateTrainingPlanDto = z.infer<typeof createTrainingPlanDtoSchema>;

export const previewTrainingPlanDtoSchema = z.object({
  input: planGenerationInputSchema,
  skipNarrative: z.boolean().default(false),
});

export type PreviewTrainingPlanDto = z.infer<
  typeof previewTrainingPlanDtoSchema
>;

export const updateTrainingPlanDtoSchema = z
  .object({
    name: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
    status: z.nativeEnum(PLAN_STATUS).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: 'At least one field must be provided',
  });

export type UpdateTrainingPlanDto = z.infer<typeof updateTrainingPlanDtoSchema>;

// ============================================================================
// Athlete availability DTOs
// ============================================================================

export const athleteAvailabilitySlotSchema = z
  .object({
    dayOfWeek: z.number().int().min(0).max(6),
    startTime: z.string().regex(HH_MM),
    endTime: z.string().regex(HH_MM),
    priority: z
      .nativeEnum(AVAILABILITY_PRIORITY)
      .default(AVAILABILITY_PRIORITY.MEDIUM),
  })
  .refine((slot) => slot.endTime > slot.startTime, {
    message: 'endTime must be after startTime',
    path: ['endTime'],
  });

export type AthleteAvailabilitySlot = z.infer<
  typeof athleteAvailabilitySlotSchema
>;

/// Full replacement of the athlete's weekly availability.
/// Availability is a small, entirely rewritten set - a PUT is simpler and
/// avoids partial-update races with the wizard.
export const setAthleteAvailabilityDtoSchema = z.object({
  slots: z.array(athleteAvailabilitySlotSchema).max(21),
});

export type SetAthleteAvailabilityDto = z.infer<
  typeof setAthleteAvailabilityDtoSchema
>;

// ============================================================================
// Plan adjustment DTOs
// ============================================================================

export const trainingPlanAdjustmentSchema = z.object({
  trainingPlanAdjustmentId: z.number(),
  trainingPlanId: z.number(),
  trainingWeekId: z.number().nullable(),
  trigger: z.nativeEnum(PLAN_ADJUSTMENT_TRIGGER),
  reason: z.string(),
  changes: z.unknown(),
  automatic: z.boolean(),
  createdAt: z.coerce.date(),
});

export type TrainingPlanAdjustmentDto = z.infer<
  typeof trainingPlanAdjustmentSchema
>;

/// Structured description of a single change applied to a plan, stored in
/// TrainingPlanAdjustment.changes so the UI can explain what moved and why.
export const planChangeSchema = z.object({
  eventId: z.number().optional().nullable(),
  trainingWeekId: z.number().optional().nullable(),
  kind: z.enum([
    'SESSION_DOWNGRADED',
    'SESSION_MOVED',
    'SESSION_REMOVED',
    'SESSION_ADDED',
    'SESSION_SWAPPED',
    'WEEK_LOAD_SCALED',
  ]),
  before: z.unknown().optional().nullable(),
  after: z.unknown().optional().nullable(),
  note: z.string().optional().nullable(),
});

export type PlanChange = z.infer<typeof planChangeSchema>;
