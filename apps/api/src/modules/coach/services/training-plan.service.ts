import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { PlanStatus, Prisma } from '@openathlete/database';
import {
  type CreateTrainingPlanDto,
  type GeneratedPlanData,
  PLAN_STATUS,
  type PlanGenerationInput,
  type SEOPlanData,
  type UpdateTrainingPlanDto,
} from '@openathlete/shared';

import { CaslAbilityFactory } from '../../auth';
import { AuthUser } from '../../auth/decorators/user.decorator';
import { accessibleBy } from '../../auth/services/casl-prisma';
import { PrismaService } from '../../prisma/services/prisma.service';
import { GENERATOR_VERSION } from '../engine';
import { PlanGenerationService } from './plan-generation.service';
import { PlanMaterializationService } from './plan-materialization.service';
import { PlanNarrativeService } from './plan-narrative.service';

/**
 * Training plan lifecycle
 *
 * CRUD over generated plans, plus the two entry points that create them:
 * `preview` (generate without touching the database) and `create` (generate and
 * materialize).
 *
 * Access is filtered through CASL exactly like CycleService, so a coach sees
 * their athletes' plans and nobody sees anyone else's.
 */

@Injectable()
export class TrainingPlanService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly abilities: CaslAbilityFactory,
    private readonly generation: PlanGenerationService,
    private readonly materialization: PlanMaterializationService,
    private readonly narrative: PlanNarrativeService,
  ) {}

  // ==========================================================================
  // Generation
  // ==========================================================================

  /**
   * Generate a plan without persisting anything, so the wizard can show it and
   * the athlete can re-roll for free.
   */
  async preview(
    user: AuthUser,
    input: PlanGenerationInput,
    athleteId?: number,
    skipNarrative = false,
  ) {
    const targetAthleteId = this.resolveAthleteId(user, athleteId);
    const language = input.language ?? await this.languageFor(user);
    const result = await this.generation.generate(
      targetAthleteId,
      input,
      language,
    );

    return {
      plan: skipNarrative
        ? result.plan
        : await this.narrative.embellish(user.userId, result.plan, language),
      fitness: {
        source: result.fitness.source,
        currentVdot: round(result.fitness.currentVdot, 1),
        goalVdot:
          result.fitness.goalVdot === null
            ? null
            : round(result.fitness.goalVdot, 1),
      },
      predictedRaceTime: result.predictedRaceTime,
      weeklyLoads: result.weeklyLoads,
    };
  }

  async create(
    user: AuthUser,
    body: CreateTrainingPlanDto,
    athleteId?: number,
  ) {
    const targetAthleteId = this.resolveAthleteId(user, athleteId);
    const language = body.input.language ?? await this.languageFor(user);

    const result = await this.generation.generate(
      targetAthleteId,
      body.input,
      language,
    );

    const planData = body.skipNarrative
      ? result.plan
      : await this.narrative.embellish(user.userId, result.plan, language);


    return this.materialization.materialize({
      timeZone: body.input.timeZone,
      athleteId: targetAthleteId,
      planData,
      startDate: body.input.startDate,
      status: body.activate ? PlanStatus.ACTIVE : PlanStatus.DRAFT,
      raceDate: body.input.raceDate ?? null,
      daysPerWeek: body.input.daysPerWeek,
      generatorVersion: GENERATOR_VERSION,
      generationInput: serializeInput(body.input),
    });
  }

  /**
   * Import a plan authored elsewhere (the website's SEO plans).
   * Shares the materializer with generated plans so both behave identically.
   */
  async importPlan(
    user: AuthUser,
    planData: SEOPlanData | GeneratedPlanData,
    startDate: Date | string,
  ) {
    const athleteId = user?.athlete?.athleteId;

    if (!athleteId) {
      throw new BadRequestException('Athlete ID is required');
    }

    const start = startDate instanceof Date ? startDate : new Date(startDate);

    if (Number.isNaN(start.getTime())) {
      throw new BadRequestException('Invalid start date provided');
    }

    return this.materialization.materialize({
      athleteId,
      planData,
      startDate: start,
      status: PlanStatus.DRAFT,
    });
  }

  // ==========================================================================
  // Reads
  // ==========================================================================

  async findMany(user: AuthUser, athleteId?: number) {
    const ability = await this.abilities.getFor({ user });

    return this.prisma.trainingPlan.findMany({
      where: {
        AND: [
          accessibleBy(ability, 'read').TrainingPlan,
          athleteId ? { athleteId } : {},
        ],
      },
      orderBy: [{ status: 'asc' }, { startDate: 'desc' }],
      include: {
        _count: { select: { cycles: true, adjustments: true } },
      },
    });
  }

  async findOne(user: AuthUser, trainingPlanId: number) {
    await this.assertCanAccess(user, trainingPlanId);

    const plan =
      await this.materialization.findPlanWithRelations(trainingPlanId);

    if (!plan) {
      throw new NotFoundException('Training plan not found');
    }

    return plan;
  }

  /** The athlete's currently active plan, if any. */
  async findCurrent(user: AuthUser, athleteId?: number) {
    const targetAthleteId = this.resolveAthleteId(user, athleteId);
    const ability = await this.abilities.getFor({ user });

    const plan = await this.prisma.trainingPlan.findFirst({
      where: {
        AND: [
          accessibleBy(ability, 'read').TrainingPlan,
          { athleteId: targetAthleteId, status: PlanStatus.ACTIVE },
        ],
      },
      orderBy: { startDate: 'desc' },
    });

    if (!plan) {
      return null;
    }

    return this.materialization.findPlanWithRelations(plan.trainingPlanId);
  }

  async findAdjustments(user: AuthUser, trainingPlanId: number) {
    await this.assertCanAccess(user, trainingPlanId);

    return this.prisma.trainingPlanAdjustment.findMany({
      where: { trainingPlanId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  // ==========================================================================
  // Writes
  // ==========================================================================

  async update(
    user: AuthUser,
    trainingPlanId: number,
    body: UpdateTrainingPlanDto,
  ) {
    const plan = await this.assertCanAccess(user, trainingPlanId);

    return this.prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${plan.athleteId})`;
      if (body.status === PLAN_STATUS.ACTIVE) await tx.trainingPlan.updateMany({ where: { athleteId: plan.athleteId, status: PlanStatus.ACTIVE, trainingPlanId: { not: trainingPlanId } }, data: { status: PlanStatus.ARCHIVED } });
      return tx.trainingPlan.update({ where: { trainingPlanId }, data: { name: body.name, description: body.description, status: body.status as PlanStatus | undefined } });
    });
  }

  /**
   * Delete a plan and the sessions it created.
   *
   * Sessions the athlete already completed are kept: the activity is real
   * training history and must survive the plan that suggested it.
   */
  async remove(user: AuthUser, trainingPlanId: number) {
    await this.assertCanAccess(user, trainingPlanId);

    await this.prisma.$transaction(async (tx) => {
      const weeks = await tx.trainingWeek.findMany({
        where: { cycle: { trainingPlanId } },
        select: { trainingWeekId: true },
      });
      const weekIds = weeks.map((week) => week.trainingWeekId);

      if (weekIds.length > 0) {
        const events = await tx.event.findMany({
          where: {
            trainingWeekId: { in: weekIds },
            training: { relatedActivityId: null },
          },
          select: {
            eventId: true,
            training: { select: { eventTrainingId: true } },
          },
        });

        const trainingIds = events
          .map((event) => event.training?.eventTrainingId)
          .filter((id): id is number => id !== undefined);

        await tx.workout.deleteMany({
          where: { eventTrainingId: { in: trainingIds } },
        });
        await tx.eventTraining.deleteMany({
          where: { eventTrainingId: { in: trainingIds } },
        });
        await tx.event.deleteMany({
          where: { eventId: { in: events.map((event) => event.eventId) } },
        });

        // Completed sessions stay in the calendar, detached from the plan.
        await tx.event.updateMany({
          where: { trainingWeekId: { in: weekIds } },
          data: { trainingWeekId: null },
        });

        await tx.trainingWeek.deleteMany({
          where: { trainingWeekId: { in: weekIds } },
        });
      }

      // Cycle.trainingPlan is an optional relation, so deleting the plan would
      // only null out the link and leave the phase blocks behind, cluttering
      // the athlete's calendar with cycles belonging to a plan that no longer
      // exists. Remove them explicitly.
      await tx.cycle.deleteMany({ where: { trainingPlanId } });

      await tx.trainingPlan.delete({ where: { trainingPlanId } });
    });

    return { deleted: true };
  }

  // ==========================================================================
  // Internals
  // ==========================================================================

  private async assertCanAccess(user: AuthUser, trainingPlanId: number) {
    const ability = await this.abilities.getFor({ user });

    const plan = await this.prisma.trainingPlan.findFirst({
      where: {
        AND: [accessibleBy(ability, 'read').TrainingPlan, { trainingPlanId }],
      },
    });

    if (!plan) {
      throw new NotFoundException('Training plan not found');
    }

    return plan;
  }

  /**
   * Which athlete a request is for: the caller's own athlete profile, or - for
   * a coach - one of the athletes they coach.
   */
  private resolveAthleteId(user: AuthUser, athleteId?: number): number {
    if (athleteId === undefined) {
      const own = user?.athlete?.athleteId;

      if (!own) {
        throw new BadRequestException(
          'No athlete profile found for this user; specify an athleteId',
        );
      }

      return own;
    }

    const isOwn = user?.athlete?.athleteId === athleteId;
    const isCoached = user.coachAthletes?.some(
      (coachAthlete) => coachAthlete.athleteId === athleteId,
    );

    if (!isOwn && !isCoached) {
      throw new ForbiddenException('You are not coaching this athlete');
    }

    return athleteId;
  }

  /** Generated prose follows the athlete's own language preference. */
  private async languageFor(user: AuthUser): Promise<'EN' | 'FR' | 'IT'> {
    const record = await this.prisma.user.findUnique({
      where: { userId: user.userId },
      select: { language: true },
    });

    const language = record?.language;

    return language === 'FR' || language === 'IT' || language === 'EN'
      ? language
      : 'EN';
  }
}

function serializeInput(input: PlanGenerationInput): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(input)) as Prisma.InputJsonValue;
}

function round(value: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}
