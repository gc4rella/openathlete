import type { DeviceSessionDto } from '@openathlete/shared';

import type { AuthUser } from '../../auth/decorators/user.decorator';
import type { PrismaService } from '../../prisma/services/prisma.service';
import type { QueueService } from '../../queue/queue.service';
import { DeviceService } from './device.service';

const user = { athlete: { athleteId: 5 } } as unknown as AuthUser;

const session = (
  overrides: Partial<DeviceSessionDto> = {},
): DeviceSessionDto => ({
  schemaVersion: 1,
  clientId: '5b3c0d8e-2f6e-4b7a-9d5e-0f1a2b3c4d5e',
  eventId: 7,
  title: 'Intervals',
  startedAt: '2026-09-24T06:00:00.000Z',
  duration: 100,
  distance: 400,
  samples: [
    { t: 0, distance: 0, heartRate: 120 },
    { t: 50, distance: 200, heartRate: 170 },
  ],
  steps: [
    {
      stepId: '7-0',
      workoutStepId: 11,
      title: '200 m',
      kind: 'run',
      startOffset: 0,
      endOffset: 50,
      distance: 200,
      timeInTarget: 0.8,
      outcome: 'completed',
    },
  ],
  adaptations: [],
  ...overrides,
});

function setup(
  existing: unknown = null,
  relatedActivityId: number | null = null,
) {
  const tx = {
    $executeRaw: jest.fn(),
    eventActivity: { findUnique: jest.fn().mockResolvedValue(null) },
    event: {
      create: jest
        .fn()
        .mockResolvedValue({ eventId: 90, activity: { eventActivityId: 900 } }),
    },
    activitySegment: { createMany: jest.fn() },
    record: { createMany: jest.fn() },
    eventTraining: { update: jest.fn() },
  };
  const prisma = {
    eventActivity: { findUnique: jest.fn().mockResolvedValue(existing) },
    event: {
      findFirst: jest.fn().mockResolvedValue({
        eventId: 7,
        training: {
          eventTrainingId: 70,
          sport: 'TRAIL_RUNNING',
          relatedActivityId,
          workout: { steps: [{ workoutStepId: 11 }] },
        },
      }),
    },
    $transaction: jest.fn((run: (client: typeof tx) => unknown) => run(tx)),
  };
  const queue = { addActivityProcessingJob: jest.fn() };
  const service = new DeviceService(
    prisma as unknown as PrismaService,
    queue as unknown as QueueService,
  );
  return { service, prisma, tx, queue };
}

describe('DeviceService.ingest', () => {
  it('creates the activity, step segments and links the planned session', async () => {
    const { service, tx, queue } = setup();
    const result = await service.ingest(user, session());

    expect(result).toEqual({
      status: 'imported',
      eventId: 90,
      linkedEventId: 7,
    });
    const created = tx.event.create.mock.calls[0][0].data;
    expect(created.activity.create).toMatchObject({
      externalId: 'native:5:5b3c0d8e-2f6e-4b7a-9d5e-0f1a2b3c4d5e',
      sport: 'TRAIL_RUNNING',
      provider: 'APPLE_HEALTH',
      averageHeartrate: 145,
      maxHeartrate: 170,
    });
    expect(tx.activitySegment.createMany.mock.calls[0][0].data).toEqual([
      expect.objectContaining({
        eventActivityId: 900,
        workoutStepId: 11,
        timeInTarget: 0.8,
      }),
    ]);
    expect(tx.eventTraining.update).toHaveBeenCalledWith({
      where: { eventTrainingId: 70 },
      data: { relatedActivityId: 900 },
    });
    expect(queue.addActivityProcessingJob).toHaveBeenCalledWith(900, 90);
  });

  it('returns the existing activity for a repeated upload', async () => {
    const { service, prisma, queue } = setup({
      eventId: 90,
      relatedTraining: { eventId: 7 },
    });
    const result = await service.ingest(user, session());

    expect(result).toEqual({
      status: 'duplicate',
      eventId: 90,
      linkedEventId: 7,
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(queue.addActivityProcessingJob).not.toHaveBeenCalled();
  });

  it('does not steal a planned session already linked to another activity', async () => {
    const { service, tx } = setup(null, 555);
    const result = await service.ingest(user, session());

    expect(result.linkedEventId).toBeNull();
    expect(tx.eventTraining.update).not.toHaveBeenCalled();
  });

  it('rejects an event that is not a planned session of this athlete', async () => {
    const { service, prisma } = setup();
    prisma.event.findFirst.mockResolvedValue(null);
    await expect(service.ingest(user, session())).rejects.toThrow(
      'Planned session not found',
    );
  });
});
