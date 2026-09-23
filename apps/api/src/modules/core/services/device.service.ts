import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  forwardRef,
} from '@nestjs/common';

import { Prisma, SportType } from '@openathlete/database';
import type {
  DeviceSessionDto,
  DeviceSessionResult,
  DeviceWorkout,
} from '@openathlete/shared';

import { AuthUser } from '../../auth/decorators/user.decorator';
import { PrismaService } from '../../prisma/services/prisma.service';
import { QueueService } from '../../queue/queue.service';
import { compressActivityStream } from '../helpers/activity-stream';
import {
  buildDeviceStream,
  buildStepSegments,
  cleanSamples,
  summarizeSession,
} from '../helpers/device-session.mapper';
import {
  type MapperEvent,
  toDeviceWorkout,
} from '../helpers/device-workout.mapper';
import { computeRecords } from '../helpers/record';
import { EVENT_INCLUDES } from './event-includes';

/** Sports the watch records as an outdoor run. */
const DEVICE_SPORTS: SportType[] = [SportType.RUNNING, SportType.TRAIL_RUNNING];
const MAX_FEED_DAYS = 31;

const json = (value: unknown): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

@Injectable()
export class DeviceService {
  private readonly logger = new Logger(DeviceService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => QueueService))
    private readonly queue: QueueService,
  ) {}

  private athleteId(user: AuthUser): number {
    if (!user.athlete?.athleteId) {
      throw new BadRequestException('An athlete profile is required');
    }
    return user.athlete.athleteId;
  }

  /** Planned runs in [from, to), resolved for real-time coaching on the watch. */
  async workouts(
    user: AuthUser,
    from: Date,
    to: Date,
  ): Promise<DeviceWorkout[]> {
    const athleteId = this.athleteId(user);
    if (
      Number.isNaN(from.getTime()) ||
      Number.isNaN(to.getTime()) ||
      to <= from
    ) {
      throw new BadRequestException('Invalid date range');
    }
    if (to.getTime() - from.getTime() > MAX_FEED_DAYS * 86_400_000) {
      throw new BadRequestException(
        `Date range is limited to ${MAX_FEED_DAYS} days`,
      );
    }

    const [events, metrics, zones] = await Promise.all([
      this.prisma.event.findMany({
        where: {
          athleteId,
          type: 'TRAINING',
          startDate: { gte: from, lt: to },
          training: { sport: { in: DEVICE_SPORTS } },
        },
        include: { training: EVENT_INCLUDES.training },
        orderBy: { startDate: 'asc' },
      }),
      this.latestMetrics(athleteId),
      this.prisma.trainingZone.findMany({
        where: { athleteId },
        include: { values: true },
      }),
    ]);

    const context = { metrics, zones };
    const result: DeviceWorkout[] = [];
    for (const event of events) {
      if (!event.training) continue;
      try {
        result.push(toDeviceWorkout(event as unknown as MapperEvent, context));
      } catch (error) {
        // One broken session must not hide the rest of the week.
        this.logger.warn(
          `Event ${event.eventId} skipped for device feed: ${error instanceof Error ? error.message : error}`,
        );
      }
    }
    return result;
  }

  /** Store a run recorded on the watch or phone. Safe to retry with the same clientId. */
  async ingest(
    user: AuthUser,
    session: DeviceSessionDto,
  ): Promise<DeviceSessionResult> {
    const athleteId = this.athleteId(user);
    const externalId = `native:${athleteId}:${session.clientId}`;

    const existing = await this.prisma.eventActivity.findUnique({
      where: { externalId },
      select: { eventId: true, relatedTraining: { select: { eventId: true } } },
    });
    if (existing) {
      return {
        status: 'duplicate',
        eventId: existing.eventId,
        linkedEventId: existing.relatedTraining?.eventId ?? null,
      };
    }

    const planned = session.eventId
      ? await this.prisma.event.findFirst({
          where: { eventId: session.eventId, athleteId, type: 'TRAINING' },
          include: {
            training: {
              select: {
                eventTrainingId: true,
                sport: true,
                relatedActivityId: true,
                workout: {
                  select: { steps: { select: { workoutStepId: true } } },
                },
              },
            },
          },
        })
      : null;
    if (session.eventId && !planned?.training) {
      throw new NotFoundException('Planned session not found');
    }

    const samples = cleanSamples(session.samples);
    const stream = buildDeviceStream(samples);
    const totals = summarizeSession(session, samples);
    const startDate = new Date(session.startedAt);
    const endDate = new Date(startDate.getTime() + session.duration * 1000);
    const sport = planned?.training?.sport ?? SportType.RUNNING;
    const validStepIds = new Set(
      planned?.training?.workout?.steps.map((step) => step.workoutStepId) ?? [],
    );
    const segments = buildStepSegments(session, validStepIds);

    const created = await this.prisma.$transaction(async (tx) => {
      // Serialize concurrent retries of the same upload.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${athleteId})`;
      const again = await tx.eventActivity.findUnique({
        where: { externalId },
        select: { eventId: true, eventActivityId: true },
      });
      if (again) return { ...again, duplicate: true, linked: false };

      const event = await tx.event.create({
        data: {
          athleteId,
          name: session.title,
          type: 'ACTIVITY',
          startDate,
          endDate,
          activity: {
            create: {
              sport,
              externalId,
              provider: 'APPLE_HEALTH',
              distance: session.distance,
              movingTime: totals.movingTime,
              averageSpeed: totals.averageSpeed,
              maxSpeed: totals.maxSpeed,
              averageHeartrate: totals.averageHeartrate,
              maxHeartrate: totals.maxHeartrate,
              elevationGain: 0,
              description: '',
              stream: json(compressActivityStream(stream)),
              importMetadata: json({
                source: 'openathlete-apple',
                clientId: session.clientId,
                plannedEventId: session.eventId ?? null,
                adaptations: session.adaptations,
                skippedSteps: session.steps
                  .filter((step) => step.outcome === 'skipped')
                  .map((step) => step.stepId),
              }),
            },
          },
        },
        include: { activity: true },
      });
      const activity = event.activity!;

      if (segments.length) {
        await tx.activitySegment.createMany({
          data: segments.map((segment) => ({
            ...segment,
            eventActivityId: activity.eventActivityId,
          })),
        });
      }
      const records = computeRecords(stream);
      if (records.length) {
        await tx.record.createMany({
          data: records.map((record) => ({
            ...record,
            athleteId,
            eventActivityId: activity.eventActivityId,
            date: startDate,
          })),
        });
      }
      // The athlete chose this session on the watch: link it directly instead of guessing.
      let linked = false;
      if (planned?.training && planned.training.relatedActivityId === null) {
        await tx.eventTraining.update({
          where: { eventTrainingId: planned.training.eventTrainingId },
          data: { relatedActivityId: activity.eventActivityId },
        });
        linked = true;
      }
      return {
        eventId: event.eventId,
        eventActivityId: activity.eventActivityId,
        duplicate: false,
        linked,
      };
    });

    if (created.duplicate) {
      return {
        status: 'duplicate',
        eventId: created.eventId,
        linkedEventId: null,
      };
    }

    // Same path as provider imports: normalization, matching, load, AI feedback.
    await this.queue.addActivityProcessingJob(
      created.eventActivityId,
      created.eventId,
    );

    return {
      status: 'imported',
      eventId: created.eventId,
      linkedEventId: created.linked ? session.eventId! : null,
    };
  }

  private async latestMetrics(
    athleteId: number,
  ): Promise<Record<string, number>> {
    const metrics = await this.prisma.athleteMetric.findMany({
      where: { athleteId },
      orderBy: { date: 'desc' },
      select: { type: true, value: true },
    });
    const latest: Record<string, number> = {};
    for (const metric of metrics) {
      if (latest[metric.type] === undefined) latest[metric.type] = metric.value;
    }
    return latest;
  }
}
