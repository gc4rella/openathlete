// ============================================================================
// SEO Training Plan DTOs
// ============================================================================
// The SEO plan shape is the canonical generated-plan shape. It used to be
// defined here; it now lives in ../core/plan.dto.ts because the plan generation
// engine, the plan materializer and the static website plans must all agree on
// one structure. Everything the generator added is optional, so the static JSON
// plans in apps/website and existing TemporaryTrainingPlan rows still validate.
//
// These aliases are kept so existing imports (and the public API surface)
// continue to work.
// ============================================================================
import {
  type ElevationGainRange,
  type GeneratedPlanData,
  type PlanCycle,
  type PlanInfo,
  type PlanSession,
  type PlanWeek,
  generatedPlanDataSchema,
} from '../core/plan.dto';

export const seoPlanDataSchema = generatedPlanDataSchema;

export type SEOPlanData = GeneratedPlanData;

export type { ElevationGainRange, PlanCycle, PlanInfo, PlanSession, PlanWeek };
