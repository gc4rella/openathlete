import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

import {
  PlanAdjustmentTrigger,
  PlanStatus,
  Prisma,
  SportType,
} from '@openathlete/database';
import { type PlanChange, type CreateWorkoutStepDto, mapPrismaWorkoutToDto, mapWorkoutDtoToPrisma, WORKOUT_DURATION_TYPE, WORKOUT_STEP_TYPE, WORKOUT_TARGET_TYPE } from '@openathlete/shared';
import { adaptationTarget, resizeSteps, timedDuration } from './workout-resize';

import {
  ACWR_HIGH_RISK_THRESHOLD,
  ACWR_OPTIMAL_MAX,
  ACWR_RECOMMENDATION_ADJUSTMENTS,
  ACWR_SAFE_THRESHOLD,
} from 'src/common/constants/training-formulas.constants';
import { WorkoutPlannedChangedEvent } from 'src/events';

import { PrismaService } from '../../prisma/services/prisma.service';

/**
 * Plan adaptation
 *
 * Adjusts the upcoming week of an active plan from what actually happened.
 *
 * Design constraints, in order of importance:
 *
 *  - **Only the next week is touched.** Rewriting the whole remaining plan on
 *    every signal makes the plan feel unstable and is premature: the next
 *    evaluation will see fresher data anyway.
 *  - **Manually edited sessions are never overwritten.** If the athlete moved
 *    or rewrote a session, that decision stands.
 *  - **Completed sessions are never touched.** They are history.
 *  - **Every change is recorded.** An adjustment the athlete cannot see the
 *    reason for is indistinguishable from a bug.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Weeks of load history used for the chronic term. */
const CHRONIC_WEEKS = 6;

/** Below this completion rate the plan is asking for more than the athlete can give. */
const LOW_COMPLETION_THRESHOLD = 0.6;
/** Above this, the athlete is doing everything asked of them. */
const HIGH_COMPLETION_THRESHOLD = 0.9;

/** Sessions felt this much harder than prescribed (on the 0-10 RPE scale). */
const RPE_OVERSHOOT_MARGIN = 1.5;
const MIN_RPE_SAMPLES = 3;

/** Pain levels mirroring the generator's injury policy. */
const INJURY_CAUTION_PAIN = 4;
const INJURY_SEVERE_PAIN = 6;

/** Never shrink a session below this. */


export interface AdaptationSignals {
  completionRate: number | null;
  plannedLoad: number;
  actualLoad: number;
  acwr: number | null;
  worstPainScore: number;
  injuryWorsening: boolean;
  rpeOvershoot: number | null;
}

export interface AdaptationDecision {
  trigger: PlanAdjustmentTrigger;
  reason: string;
  /** Multiplier applied to upcoming session durations */
  loadScale: number;
  /** Turn quality sessions into easy running */
  downgradeQuality: boolean;
  /** Replace running with low-impact cross-training */
  removeImpact: boolean;
}

export interface AdaptationResult {
  adjusted: boolean;
  trigger?: PlanAdjustmentTrigger;
  reason?: string;
  changes: PlanChange[];
}

@Injectable()
export class PlanAdaptationService {
  private readonly logger = new Logger(PlanAdaptationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Evaluate and, if warranted, adjust the active plan of every athlete who
   * has one. Used by the weekly scheduler.
   */
  async adaptAllActivePlans(): Promise<number> {
    const plans = await this.prisma.trainingPlan.findMany({
      where: { status: PlanStatus.ACTIVE },
      select: { trainingPlanId: true },
    });

    let adjusted = 0;

    for (const plan of plans) {
      try {
        const result = await this.adaptPlan(plan.trainingPlanId, new Date(), "next");

        if (result.adjusted) {
          adjusted++;
        }
      } catch (error) {
        // One athlete's bad data must not stop everyone else's adaptation.
        this.logger.error(
          `Failed to adapt plan ${plan.trainingPlanId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    return adjusted;
  }

  /** Evaluate the athlete's active plan, if they have one. */
  async adaptAthlete(athleteId: number): Promise<AdaptationResult> {
    const plan = await this.prisma.trainingPlan.findFirst({
      where: { athleteId, status: PlanStatus.ACTIVE },
      orderBy: { startDate: 'desc' },
      select: { trainingPlanId: true },
    });

    if (!plan) {
      return { adjusted: false, changes: [] };
    }

    return this.adaptPlan(plan.trainingPlanId);
  }

  async adaptPlan(
    trainingPlanId: number,
    now = new Date(),
    mode: "current" | "next" = "current",
  ): Promise<AdaptationResult> {
    const plan = await this.prisma.trainingPlan.findUnique({
      where: { trainingPlanId },
      include: {
        cycles: {
          orderBy: { startDate: 'asc' },
          include: { weeks: { orderBy: { weekNumber: 'asc' } } },
        },
      },
    });

    if (!plan || plan.status !== PlanStatus.ACTIVE) {
      return { adjusted: false, changes: [] };
    }

    const weeks = plan.cycles.flatMap((cycle) => cycle.weeks);
    const upcoming = weeks.find((week) => mode === "next" ? week.startDate > now : week.endDate >= now);

    if (!upcoming) {
      return { adjusted: false, changes: [] };
    }

    const signals = await this.gatherSignals(plan.athleteId, weeks, now);
    const decision = this.decide(signals);

    if (!decision || (decision.loadScale > 1 && !["BASE", "SPECIFIC"].includes(upcoming.phase ?? ""))) {
      return { adjusted: false, changes: [] };
    }

    const changes = await this.applyDecision(
      plan.athleteId,
      upcoming.trainingWeekId,
      decision,
      now,
    );

    if (changes.length === 0) {
      return { adjusted: false, changes: [] };
    }

    await this.prisma.trainingPlanAdjustment.create({
      data: {
        trainingPlanId,
        trainingWeekId: upcoming.trainingWeekId,
        trigger: decision.trigger,
        reason: decision.reason,
        changes: changes as unknown as Prisma.InputJsonValue,
        automatic: true,
      },
    });

    this.logger.log(
      `Adapted plan ${trainingPlanId} week ${upcoming.weekNumber}: ` +
        `${decision.trigger} (${changes.length} sessions changed)`,
    );

    return {
      adjusted: true,
      trigger: decision.trigger,
      reason: decision.reason,
      changes,
    };
  }

  // ==========================================================================
  // Signals
  // ==========================================================================

  async gatherSignals(
    athleteId: number,
    weeks: Array<{ startDate: Date; endDate: Date }>,
    now: Date,
  ): Promise<AdaptationSignals> {
    const completedWeeks = weeks.filter((week) => week.endDate < now).slice(-2);

    const [completion, loads, weeklyLoads, injuries, rpeOvershoot] =
      await Promise.all([
        this.completionRate(athleteId, completedWeeks),
        this.plannedVsActualLoad(athleteId, completedWeeks),
        this.recentWeeklyLoads(athleteId, now),
        this.openInjuries(athleteId),
        this.rpeOvershoot(athleteId, now),
      ]);

    return {
      completionRate: completion,
      plannedLoad: loads.planned,
      actualLoad: loads.actual,
      acwr: acwrFromWeeklyLoads(weeklyLoads),
      worstPainScore: injuries.worstPainScore,
      injuryWorsening: injuries.worsening,
      rpeOvershoot,
    };
  }

  /** Share of planned sessions that were actually completed. */
  private async completionRate(
    athleteId: number,
    weeks: Array<{ startDate: Date; endDate: Date }>,
  ): Promise<number | null> {
    if (weeks.length === 0) {
      return null;
    }

    const range = {
      gte: weeks[0].startDate,
      lte: weeks[weeks.length - 1].endDate,
    };

    const sessions = await this.prisma.eventTraining.findMany({
      where: { event: { athleteId, startDate: range } },
      select: { relatedActivityId: true },
    });

    if (sessions.length === 0) {
      return null;
    }

    const completed = sessions.filter(
      (session) => session.relatedActivityId !== null,
    ).length;

    return completed / sessions.length;
  }

  private async plannedVsActualLoad(
    athleteId: number,
    weeks: Array<{ startDate: Date; endDate: Date }>,
  ): Promise<{ planned: number; actual: number }> {
    if (weeks.length === 0) {
      return { planned: 0, actual: 0 };
    }

    const range = {
      gte: weeks[0].startDate,
      lte: weeks[weeks.length - 1].endDate,
    };

    const [planned, entries] = await Promise.all([
      this.prisma.eventTraining.findMany({
        where: { event: { athleteId, startDate: range } },
        select: { estimatedLoad: true },
      }),
      this.prisma.trainingLoadEntry.findMany({
        where: {
          calculation: { athleteId, type: "TRIMP" },
          date: { gte: range.gte, lte: range.lte },
        },
        select: { value: true },
      }),
    ]);

    return {
      planned: planned.reduce(
        (total, session) => total + (session.estimatedLoad ?? 0),
        0,
      ),
      actual: entries.reduce((total, entry) => total + entry.value, 0),
    };
  }

  /**
   * Weekly training load, most recent week first, for the acute:chronic ratio.
   * Same shape as TrainingLoadService expects.
   */
  private async recentWeeklyLoads(
    athleteId: number,
    now: Date,
  ): Promise<number[]> {
    const since = new Date(now.getTime() - (CHRONIC_WEEKS + 1) * 7 * DAY_MS);

    const entries = await this.prisma.trainingLoadEntry.findMany({
      where: { calculation: { athleteId, type: "TRIMP" }, date: { gte: since, lte: now } },
      select: { date: true, value: true },
    });

    const loads = new Array<number>(CHRONIC_WEEKS + 1).fill(0);

    for (const entry of entries) {
      const weeksAgo = Math.floor(
        (now.getTime() - entry.date.getTime()) / (7 * DAY_MS),
      );

      if (weeksAgo >= 0 && weeksAgo < loads.length) {
        loads[weeksAgo] += entry.value;
      }
    }

    return loads;
  }

  private async openInjuries(
    athleteId: number,
  ): Promise<{ worstPainScore: number; worsening: boolean }> {
    const injuries = await this.prisma.athleteInjury.findMany({
      where: { athleteId, status: { not: 'RESOLVED' } },
      select: { painScore: true, status: true },
    });

    if (injuries.length === 0) {
      return { worstPainScore: 0, worsening: false };
    }

    return {
      // Pain is stored normalized 0-1; the thresholds below are on the 0-10
      // scale the athlete reported, matching the generator's injury policy.
      worstPainScore: Math.max(
        ...injuries.map((injury) => injury.painScore * 10),
      ),
      worsening: injuries.some((injury) => injury.status === 'WORSENING'),
    };
  }

  /**
   * How much harder recent sessions felt than they were meant to.
   * Planned RPE is stored 0-1; reported RPE is stored 0-1 too. Both are
   * compared on the 0-10 scale the athlete actually sees.
   */
  private async rpeOvershoot(
    athleteId: number,
    now: Date,
  ): Promise<number | null> {
    const since = new Date(now.getTime() - 14 * DAY_MS);

    const sessions = await this.prisma.eventTraining.findMany({
      where: {
        event: { athleteId, startDate: { gte: since, lte: now } },
        goalRpe: { not: null },
        relatedActivityId: { not: null },
      },
      select: { goalRpe: true, relatedActivity: { select: { rpe: true } } },
    });

    const deltas = sessions
      .filter(
        (session) =>
          session.goalRpe !== null &&
          session.relatedActivity?.rpe !== null &&
          session.relatedActivity?.rpe !== undefined,
      )
      .map(
        (session) =>
          ((session.relatedActivity?.rpe ?? 0) - (session.goalRpe ?? 0)) * 10,
      );

    if (deltas.length < MIN_RPE_SAMPLES) {
      return null;
    }

    return deltas.reduce((total, delta) => total + delta, 0) / deltas.length;
  }

  // ==========================================================================
  // Decision
  // ==========================================================================

  /**
   * Pick at most one action. Ordered by severity: an injury outranks a load
   * spike, which outranks poor completion, which outranks feeling tired, which
   * outranks having room to progress.
   */
  decide(signals: AdaptationSignals): AdaptationDecision | null {
    if (
      signals.worstPainScore >= INJURY_SEVERE_PAIN ||
      (signals.injuryWorsening && signals.worstPainScore >= INJURY_CAUTION_PAIN)
    ) {
      return {
        trigger: PlanAdjustmentTrigger.INJURY,
        reason:
          'You reported significant pain, so this week drops the running impact and the hard sessions. Getting the injury settled is worth more than any single week of training.',
        loadScale: 0.6,
        downgradeQuality: true,
        removeImpact: true,
      };
    }

    if (signals.worstPainScore >= INJURY_CAUTION_PAIN) {
      return {
        trigger: PlanAdjustmentTrigger.INJURY,
        reason:
          'You are carrying a niggle, so the quality sessions this week become easy running and the volume comes down. Keep the easy days genuinely easy.',
        loadScale: 0.8,
        downgradeQuality: true,
        removeImpact: false,
      };
    }

    if (signals.acwr !== null && signals.acwr > ACWR_HIGH_RISK_THRESHOLD) {
      return {
        trigger: PlanAdjustmentTrigger.LOAD_SPIKE,
        reason: `Your recent training load jumped well above what you have built up to (acute:chronic ratio ${signals.acwr.toFixed(2)}). This week is cut back to let the last block settle.`,
        loadScale: ACWR_RECOMMENDATION_ADJUSTMENTS.HIGH_RISK_MULTIPLIER,
        downgradeQuality: true,
        removeImpact: false,
      };
    }

    if (signals.acwr !== null && signals.acwr > ACWR_OPTIMAL_MAX) {
      return {
        trigger: PlanAdjustmentTrigger.LOAD_SPIKE,
        reason: `Your load is climbing faster than your base is (acute:chronic ratio ${signals.acwr.toFixed(2)}). This week is trimmed slightly to keep the progression sustainable.`,
        loadScale: ACWR_RECOMMENDATION_ADJUSTMENTS.MODERATE_RISK_MULTIPLIER,
        downgradeQuality: false,
        removeImpact: false,
      };
    }

    if (
      signals.completionRate !== null &&
      signals.completionRate < LOW_COMPLETION_THRESHOLD
    ) {
      return {
        trigger: PlanAdjustmentTrigger.LOW_COMPLETION,
        reason: `You completed ${Math.round(signals.completionRate * 100)}% of the last sessions. The plan was asking for more than the week allowed, so this week is scaled back to something you can finish.`,
        loadScale: 0.8,
        downgradeQuality: false,
        removeImpact: false,
      };
    }

    if (
      signals.rpeOvershoot !== null &&
      signals.rpeOvershoot > RPE_OVERSHOOT_MARGIN
    ) {
      return {
        trigger: PlanAdjustmentTrigger.RPE_OVERSHOOT,
        reason:
          'Recent sessions have been feeling harder than they were meant to. This week eases off so the easy days do their job.',
        loadScale: 0.9,
        downgradeQuality: true,
        removeImpact: false,
      };
    }

    if (
      signals.acwr !== null &&
      signals.acwr < ACWR_SAFE_THRESHOLD &&
      signals.completionRate !== null &&
      signals.completionRate >= HIGH_COMPLETION_THRESHOLD
    ) {
      return {
        trigger: PlanAdjustmentTrigger.UNDERLOAD,
        reason:
          'You are completing everything comfortably and have room to build. This week gets a small bump.',
        loadScale: ACWR_RECOMMENDATION_ADJUSTMENTS.SAFE_PROGRESSION_MULTIPLIER,
        downgradeQuality: false,
        removeImpact: false,
      };
    }

    return null;
  }

  // ==========================================================================
  // Application
  // ==========================================================================

  private async applyDecision(
    athleteId: number, trainingWeekId: number, decision: AdaptationDecision, now: Date,
  ): Promise<PlanChange[]> {
    const candidates = await this.prisma.event.findMany({
      where: { athleteId, trainingWeekId, type: 'TRAINING', startDate: { gt: now }, training: { relatedActivityId: null, manuallyEdited: false } },
      select: { eventId: true },
    });
    const changes: PlanChange[] = [];
    for (const candidate of candidates) {
      const changed = await this.prisma.$transaction(async tx => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${athleteId})`;
        const event = await tx.event.findUnique({ where: { eventId: candidate.eventId }, include: {
          trainingWeek: { include: { cycle: { include: { trainingPlan: true } } } },
          training: { include: { workout: { include: { steps: { include: { targets: true, repeatBlock: { include: { childSteps: { include: { targets: true } } } } }, orderBy: { orderIndex: 'asc' } } } } } },
        } });
        const training = event?.training;
        if (!event || !training || training.manuallyEdited || training.relatedActivityId != null || event.startDate <= now || event.trainingWeek?.cycle.trainingPlan?.status !== 'ACTIVE') return null;
        const severity = decision.removeImpact ? 2 : decision.downgradeQuality ? 1 : 0;
        const target = adaptationTarget(training.adaptationScale, training.adaptationSeverity, decision.loadScale, severity);
        if (!target.changed) return null;
        type Baseline = { duration: number; distance: number | null; load: number | null; rpe: number | null; sport: SportType; steps: CreateWorkoutStepDto[] };
        const baseline: Baseline = training.adaptationBaseline ? training.adaptationBaseline as unknown as Baseline : {
          duration: training.goalDuration ?? 0, distance: training.goalDistance, load: training.estimatedLoad, rpe: training.goalRpe,
          sport: training.sport, steps: training.workout ? mapPrismaWorkoutToDto(training.workout).steps : [],
        };
        const downgrade = target.severity > 0 && (baseline.rpe ?? 0) >= 0.6;
        const crossTrain = target.severity >= 2;
        const replace = downgrade || crossTrain;
        const scaled = Math.max(600, Math.round(baseline.duration * target.scale));
        const steps: CreateWorkoutStepDto[] = replace ? [{ stepType: WORKOUT_STEP_TYPE.STEADY, durationType: WORKOUT_DURATION_TYPE.TIME, durationValue: scaled, targets: [{ targetType: WORKOUT_TARGET_TYPE.RPE, targetValue: 0.3 }] }] : resizeSteps(baseline.steps, target.scale);
        const duration = steps.length ? timedDuration(steps) ?? scaled : scaled;
        const before = { goalDuration: training.goalDuration, goalDistance: training.goalDistance, sport: training.sport };
        const after = { goalDuration: duration, goalDistance: replace ? null : baseline.distance == null ? null : Math.round(baseline.distance * target.scale), sport: crossTrain ? SportType.CYCLING : baseline.sport };
        await tx.eventTraining.update({ where: { eventTrainingId: training.eventTrainingId }, data: {
          ...after, estimatedLoad: replace ? null : baseline.load == null ? null : round(baseline.load * target.scale, 1),
          goalRpe: replace ? 0.3 : baseline.rpe,
          ...(replace ? { description: decision.reason } : {}),
          adaptationBaseline: baseline as unknown as Prisma.InputJsonValue, adaptationScale: target.scale, adaptationSeverity: target.severity,
        } });
        await tx.event.update({ where: { eventId: event.eventId }, data: { endDate: new Date(event.startDate.getTime() + duration * 1000) } });
        if (training.workout) {
          await tx.workoutStep.deleteMany({ where: { workoutId: training.workout.workoutId } });
          await tx.workout.update({ where: { workoutId: training.workout.workoutId }, data: mapWorkoutDtoToPrisma({ steps }) });
        }
        return { event, after, before, kind: crossTrain ? 'SESSION_SWAPPED' : downgrade ? 'SESSION_DOWNGRADED' : 'WEEK_LOAD_SCALED' };
      });
      if (!changed) continue;
      changes.push({ eventId: changed.event.eventId, trainingWeekId, kind: changed.kind as PlanChange['kind'], before: changed.before, after: changed.after });
      this.eventEmitter.emit(WorkoutPlannedChangedEvent.SLUG, new WorkoutPlannedChangedEvent({ eventId: changed.event.eventId, athleteId, workoutId: changed.event.training?.workout?.workoutId ?? null, startDate: changed.event.startDate, sport: changed.after.sport }));
    }
    const totals = await this.prisma.eventTraining.aggregate({ where: { event: { trainingWeekId } }, _sum: { goalDuration: true, estimatedLoad: true } });
    await this.prisma.trainingWeek.update({ where: { trainingWeekId }, data: { targetVolume: totals._sum.goalDuration, targetLoad: totals._sum.estimatedLoad } });
    return changes;
  }

}

/**
 * Acute:chronic workload ratio from weekly loads, newest first.
 *
 * Same definition as TrainingLoadService.calculateACWRFromWeeklyLoads with one
 * deliberate difference: the exponential average is seeded with the oldest week
 * rather than with zero.
 *
 * Seeding from zero leaves the average still climbing out of its warm-up after
 * six weeks, so it lands about 13% below the athlete's true chronic load. An
 * athlete training perfectly steadily then reads as ACWR 1.15 rather than 1.00,
 * which is most of the way to the 1.3 threshold - and this function decides
 * whether to cut someone's training week, so a systematic upward bias means
 * cutting weeks that did not need cutting.
 */
export function acwrFromWeeklyLoads(weeklyLoads: number[]): number | null {
  if (weeklyLoads.length < 2) {
    return null;
  }

  const acute = weeklyLoads[0] ?? 0;
  const weeksForChronic = Math.min(weeklyLoads.length - 1, CHRONIC_WEEKS);
  const alpha = 2 / (weeksForChronic + 1);

  let chronic = weeklyLoads[1] ?? 0;

  for (let i = 2; i <= weeksForChronic; i++) {
    chronic = alpha * (weeklyLoads[i] ?? 0) + (1 - alpha) * chronic;
  }

  if (chronic <= 0) {
    return null;
  }

  return acute / chronic;
}

function round(value: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}
