import { Injectable, Logger } from '@nestjs/common';

import { PlanStatus, Prisma, SportType } from '@openathlete/database';
import {
  addCalendarDays, calendarDate, dateInTimeZone, zonedDateTime,
  EVENT_TYPE,
  type GeneratedPlanData,
  type PlanSession,
  type WorkoutStepDto,
  createWorkoutSchema,
  mapWorkoutDtoToPrisma,
} from '@openathlete/shared';

import { PrismaService } from '../../prisma/services/prisma.service';

/**
 * Plan materialization
 *
 * Writes a generated plan into TrainingPlan / Cycle / TrainingWeek / Event /
 * Workout rows.
 *
 * This is the single writer for both the plan generation engine and the SEO
 * plan import from the website, so a plan behaves identically whichever way it
 * arrived.
 */

const DEFAULT_SESSION_SECONDS = 3600;

/**
 * Split a plan into consecutive week-long windows, starting on the plan's
 * start date.
 *
 * Advanced by calendar days rather than by adding 7 x 86_400_000 ms. Fixed
 * millisecond arithmetic silently loses an hour at the autumn clock change,
 * which is enough to roll every subsequent week back onto the previous day -
 * so a plan starting on a Monday in September ends up with weeks starting on
 * Sunday in December, and race day lands a week early.
 *
 * Exported so the property that matters (every week starts on the same
 * weekday, DST or not) can be tested without a database.
 */
export function buildWeekWindows(
  startDate: Date,
  weeks: number,
  timeZone?: string,
): Array<{ start: Date; end: Date }> {
  const windows: Array<{ start: Date; end: Date }> = [];
  for (let index = 0; index < weeks; index++) {
    const start = timeZone
      ? zonedDateTime(addCalendarDays(startDate, index * 7), '00:00', timeZone)
      : new Date(startDate);
    if (!timeZone) { start.setDate(start.getDate() + index * 7); start.setHours(0, 0, 0, 0); }
    const next = timeZone
      ? zonedDateTime(addCalendarDays(startDate, (index + 1) * 7), '00:00', timeZone)
      : new Date(start);
    if (!timeZone) { next.setDate(next.getDate() + 7); next.setHours(0, 0, 0, 0); }
    windows.push({ start, end: new Date(next.getTime() - 1) });
  }

  return windows;
}

/** Materializing a whole plan is dozens of writes; give it room. */
const TRANSACTION_TIMEOUT_MS = 60_000;
const TRANSACTION_MAX_WAIT_MS = 15_000;

export interface MaterializeOptions {
  timeZone?: string;
  athleteId: number;
  planData: GeneratedPlanData;
  startDate: Date;
  status?: PlanStatus;
  raceDate?: Date | null;
  daysPerWeek?: number | null;
  generatorVersion?: string | null;
  generationInput?: Prisma.InputJsonValue | null;
}

interface WeekWindow {
  start: Date;
  end: Date;
}

@Injectable()
export class PlanMaterializationService {
  private readonly logger = new Logger(PlanMaterializationService.name);

  constructor(private readonly prisma: PrismaService) {}

  async materialize(options: MaterializeOptions) {
    const {
      athleteId,
      planData,
      startDate,
      status = PlanStatus.DRAFT,
    } = options;

    if (!Number.isFinite(startDate.getTime())) {
      throw new Error('Invalid start date provided');
    }

    const timeZone = options.timeZone ?? "UTC";
    const weekWindows = buildWeekWindows(startDate, planData.plan.duration, timeZone);

    const totalWeeks = planData.cycles.reduce(
      (total, cycle) => total + cycle.weeks.length,
      0,
    );

    if (totalWeeks > weekWindows.length) {
      throw new Error(
        `Plan contains ${totalWeeks} weeks but is declared as ${planData.plan.duration} weeks long`,
      );
    }

    const availability = await this.prisma.athleteAvailability.findMany({
      where: { athleteId },
    });

    const planId = await this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${athleteId})`;
        if (status === PlanStatus.ACTIVE) await tx.trainingPlan.updateMany({ where: { athleteId, status: PlanStatus.ACTIVE }, data: { status: PlanStatus.ARCHIVED } });
        const trainingPlan = await tx.trainingPlan.create({
          data: {
            athleteId,
            name: planData.plan.name,
            description: planData.plan.description,
            goal: planData.plan.goal,
            timeZone,
            startDate: weekWindows[0].start,
            endDate: weekWindows[weekWindows.length - 1].end,
            status,
            sportType: planData.plan.sportType as SportType,
            targetDistance: planData.plan.distance || null,
            targetTime: planData.plan.timeTarget ?? null,
            raceDate: options.raceDate ? zonedDateTime(calendarDate(options.raceDate), "12:00", timeZone) : null,
            daysPerWeek: options.daysPerWeek ?? null,
            generatorVersion: options.generatorVersion ?? null,
            generationInput: options.generationInput ?? Prisma.DbNull,
          },
        });

        let weekIndex = 0;

        for (const cycleData of planData.cycles) {
          if (cycleData.weeks.length === 0) {
            continue;
          }

          const cycleStart = weekWindows[weekIndex].start;
          const cycleEnd =
            weekWindows[weekIndex + cycleData.weeks.length - 1].end;

          const cycle = await tx.cycle.create({
            data: {
              athleteId,
              trainingPlanId: trainingPlan.trainingPlanId,
              name: cycleData.name,
              description: cycleData.description,
              phase: cycleData.phase,
              color: cycleData.color || null,
              startDate: cycleStart,
              endDate: cycleEnd,
            },
          });

          for (const weekData of cycleData.weeks) {
            const window = weekWindows[weekIndex];

            const trainingWeek = await tx.trainingWeek.create({
              data: {
                cycleId: cycle.cycleId,
                weekNumber: weekData.weekNumber,
                startDate: window.start,
                endDate: window.end,
                phase: weekData.phase ?? cycleData.phase,
                theme: weekData.theme || null,
                targetVolume: weekData.targetVolume ?? null,
                targetLoad: weekData.targetLoad ?? null,
              },
            });

            for (const session of weekData.sessions) {
              await this.createSession(
                tx,
                athleteId,
                trainingWeek.trainingWeekId,
                window,
                session,
                timeZone,
                availability,
              );
            }

            weekIndex++;
          }
        }

        return trainingPlan.trainingPlanId;
      },
      {
        timeout: TRANSACTION_TIMEOUT_MS,
        maxWait: TRANSACTION_MAX_WAIT_MS,
      },
    );

    this.logger.log(
      `Materialized training plan ${planId} for athlete ${athleteId} (${totalWeeks} weeks)`,
    );

    return this.findPlanWithRelations(planId);
  }

  findPlanWithRelations(trainingPlanId: number) {
    return this.prisma.trainingPlan.findUnique({
      where: { trainingPlanId },
      include: {
        cycles: {
          orderBy: { startDate: 'asc' },
          include: {
            weeks: {
              orderBy: { weekNumber: 'asc' },
              include: {
                sessions: {
                  orderBy: { startDate: 'asc' },
                  include: {
                    competition: { include: { relatedActivity: true } },
                    training: {
                      include: {
                        relatedActivity: {
                          include: {
                            // Enough for the plan view's per-session compliance badge.
                            segments: {
                              where: { segmentType: 'WORKOUT_STEP' },
                              select: { timeInTarget: true, movingTime: true },
                            },
                          },
                        },
                        workout: {
                          include: {
                            steps: {
                              orderBy: { orderIndex: 'asc' },
                              include: {
                                targets: true,
                                repeatBlock: {
                                  include: {
                                    childSteps: {
                                      orderBy: { orderIndex: 'asc' },
                                      include: { targets: true },
                                    },
                                  },
                                },
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        adjustments: { orderBy: { createdAt: 'desc' } },
      },
    });
  }

  // ==========================================================================
  // Internals
  // ==========================================================================

  private async createSession(
    tx: Prisma.TransactionClient,
    athleteId: number,
    trainingWeekId: number,
    window: WeekWindow,
    session: PlanSession,
    timeZone: string,
    availability: Array<{ dayOfWeek: number; startTime: string; endTime: string }>,
  ) {
    const durationMinutes = (session.goalDuration ?? DEFAULT_SESSION_SECONDS) / 60;
    const toMinutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
    const slots = availability.filter(slot => slot.dayOfWeek === session.dayOfWeek).sort((a,b) => a.startTime.localeCompare(b.startTime));
    const slot = slots.find(slot => toMinutes(slot.endTime) - toMinutes(slot.startTime) >= durationMinutes);
    if (slots.length && !slot && session.archetype !== 'race') throw new Error('AVAILABILITY_CONFLICT');
    const day = session.scheduledDate ?? addCalendarDays(dateInTimeZone(window.start, timeZone), (session.dayOfWeek - new Date(`${dateInTimeZone(window.start, timeZone)}T00:00:00Z`).getUTCDay() + 7) % 7);
    const startDate = zonedDateTime(day, session.startTime ?? slot?.startTime ?? '09:00', timeZone);

    const durationSeconds = session.goalDuration || DEFAULT_SESSION_SECONDS;
    const endDate = new Date(startDate.getTime() + durationSeconds * 1000);

    if (session.archetype === 'race') {
      await tx.event.create({ data: { athleteId, startDate, endDate, name: session.name, type: EVENT_TYPE.COMPETITION, trainingWeekId,
        competition: { create: { sport: session.sport as SportType, description: session.description, goalDistance: session.goalDistance, goalDuration: session.goalDuration, goalRpe: session.goalRpe == null ? null : session.goalRpe / 10 } } } });
      return;
    }
    const createdEvent = await tx.event.create({
      data: {
        athleteId,
        startDate,
        endDate,
        name: session.name,
        type: EVENT_TYPE.TRAINING,
        trainingWeekId,
        training: {
          create: {
            sport: session.sport as SportType,
            description: session.description,
            goalDistance: session.goalDistance ?? null,
            goalDuration: session.goalDuration ?? null,
            goalElevationGain: session.goalElevationGain ?? null,
            // Goals are authored on a 0-10 RPE scale; the column stores 0-1.
            goalRpe:
              session.goalRpe !== null && session.goalRpe !== undefined
                ? session.goalRpe / 10
                : null,
            estimatedLoad: session.estimatedLoad ?? null,
          },
        },
      },
      include: { training: true },
    });

    if (!session.workout || !createdEvent.training) {
      return;
    }

    const parsed = createWorkoutSchema.safeParse({
      steps: session.workout.steps ?? [],
    });

    if (!parsed.success) {
      this.logger.warn(
        `Skipping invalid workout for session "${session.name}": ${parsed.error.message}`,
      );
      return;
    }

    const workoutData = mapWorkoutDtoToPrisma({ steps: parsed.data.steps });

    if (workoutData.steps?.create) {
      workoutData.steps.create = workoutData.steps.create.map((step, index) => {
        const withOrder = { ...step, orderIndex: step.orderIndex ?? index };

        if (withOrder.repeatBlock?.create?.childSteps?.create) {
          withOrder.repeatBlock.create.childSteps.create =
            withOrder.repeatBlock.create.childSteps.create.map(
              (child: WorkoutStepDto, childIndex: number) => ({
                ...child,
                orderIndex: child.orderIndex ?? childIndex,
              }),
            );
        }

        return withOrder;
      });
    }

    await tx.workout.create({
      data: {
        eventTrainingId: createdEvent.training.eventTrainingId,
        ...workoutData,
      },
    });
  }

}
