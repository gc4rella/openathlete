import { getLocale } from '@/paraglide/runtime';
import client, { routes } from '@/utils/axios';

import {
  CreateTrainingPlanDto,
  GeneratedPlanData,
  PlanGenerationInput,
  TrainingPlanAdjustmentDto,
  UpdateTrainingPlanDto,
} from '@openathlete/shared';

/**
 * Training plan API client.
 *
 * `preview` is the only endpoint that generates without saving, which is what
 * lets the wizard show a plan and let the athlete re-roll it for free.
 */

export type FitnessSummary = {
  source:
    | 'BEST_EFFORT'
    | 'VO2MAX_METRIC'
    | 'VMA_METRIC'
    | 'GOAL_TIME'
    | 'DEFAULT';
  currentVdot: number;
  goalVdot: number | null;
};

export type PlanPreview = {
  plan: GeneratedPlanData;
  fitness: FitnessSummary;
  predictedRaceTime: number | null;
  weeklyLoads: number[];
};

export type TrainingPlanSummary = {
  trainingPlanId: number;
  name: string;
  description: string | null;
  goal: string;
  status: 'DRAFT' | 'ACTIVE' | 'COMPLETED' | 'ARCHIVED';
  startDate: Date;
  endDate: Date;
  raceDate: Date | null;
  targetDistance: number | null;
  targetTime: number | null;
  daysPerWeek: number | null;
  _count?: { cycles: number; adjustments: number };
};

export type PlanSessionRecord = {
  eventId: number;
  name: string;
  startDate: Date;
  endDate: Date;
  training: {
    eventTrainingId: number;
    sport: string;
    description: string;
    goalDistance: number | null;
    goalDuration: number | null;
    goalRpe: number | null;
    estimatedLoad: number | null;
    manuallyEdited: boolean;
    relatedActivityId: number | null;
    workout: { workoutId: number; steps: unknown[] } | null;
  } | null;
};

export type PlanWeekRecord = {
  trainingWeekId: number;
  weekNumber: number;
  startDate: Date;
  endDate: Date;
  theme: string | null;
  targetVolume: number | null;
  targetLoad: number | null;
  sessions: PlanSessionRecord[];
};

export type PlanCycleRecord = {
  cycleId: number;
  name: string;
  description: string;
  phase: string | null;
  color: string | null;
  startDate: Date;
  endDate: Date;
  weeks: PlanWeekRecord[];
};

export type TrainingPlanDetail = TrainingPlanSummary & {
  cycles: PlanCycleRecord[];
  adjustments: TrainingPlanAdjustmentDto[];
};

const toDate = (value: string | Date | null): Date | null =>
  value === null ? null : new Date(value);

function mapPlan<
  T extends { startDate: string | Date; endDate: string | Date },
>(plan: T) {
  return {
    ...plan,
    startDate: new Date(plan.startDate),
    endDate: new Date(plan.endDate),
  };
}

function mapDetail(plan: TrainingPlanDetail): TrainingPlanDetail {
  return {
    ...mapPlan(plan),
    raceDate: toDate(plan.raceDate),
    cycles: (plan.cycles ?? []).map((cycle) => ({
      ...mapPlan(cycle),
      weeks: (cycle.weeks ?? []).map((week) => ({
        ...mapPlan(week),
        sessions: (week.sessions ?? []).map((session) => mapPlan(session)),
      })),
    })),
  };
}

export class TrainingPlanAPI {
  static async preview(params: {
    input: PlanGenerationInput;
    athleteId?: number;
    skipNarrative?: boolean;
  }): Promise<PlanPreview> {
    const res = await client.post(
      routes.trainingPlan.preview,
      { input: { ...params.input, language: getLocale().toUpperCase() as 'EN' | 'FR' | 'IT' }, skipNarrative: params.skipNarrative ?? false },
      { params: { athleteId: params.athleteId } },
    );

    return res.data as PlanPreview;
  }

  static async create(params: {
    body: CreateTrainingPlanDto;
    athleteId?: number;
  }): Promise<TrainingPlanDetail> {
    const res = await client.post(routes.trainingPlan.create, { ...params.body, input: { ...params.body.input, language: getLocale().toUpperCase() as 'EN' | 'FR' | 'IT' } }, {
      params: { athleteId: params.athleteId },
    });

    return mapDetail(res.data);
  }

  static async list(athleteId?: number): Promise<TrainingPlanSummary[]> {
    const res = await client.get(routes.trainingPlan.list, {
      params: { athleteId },
    });

    return (res.data as TrainingPlanSummary[]).map((plan) => ({
      ...mapPlan(plan),
      raceDate: toDate(plan.raceDate),
    }));
  }

  static async current(athleteId?: number): Promise<TrainingPlanDetail | null> {
    const res = await client.get(routes.trainingPlan.current, {
      params: { athleteId },
    });

    return res.data ? mapDetail(res.data) : null;
  }

  static async get(trainingPlanId: number): Promise<TrainingPlanDetail> {
    const res = await client.get(routes.trainingPlan.get(trainingPlanId));

    return mapDetail(res.data);
  }

  static async adjustments(
    trainingPlanId: number,
  ): Promise<TrainingPlanAdjustmentDto[]> {
    const res = await client.get(
      routes.trainingPlan.adjustments(trainingPlanId),
    );

    return (res.data as TrainingPlanAdjustmentDto[]).map((adjustment) => ({
      ...adjustment,
      createdAt: new Date(adjustment.createdAt),
    }));
  }

  static async update(params: {
    trainingPlanId: number;
    body: UpdateTrainingPlanDto;
  }): Promise<TrainingPlanSummary> {
    const res = await client.patch(
      routes.trainingPlan.update(params.trainingPlanId),
      params.body,
    );

    return { ...mapPlan(res.data), raceDate: toDate(res.data.raceDate) };
  }

  static async remove(trainingPlanId: number): Promise<{ deleted: boolean }> {
    const res = await client.delete(routes.trainingPlan.remove(trainingPlanId));

    return res.data;
  }
}
