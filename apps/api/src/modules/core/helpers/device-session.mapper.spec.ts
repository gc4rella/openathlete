import type { DeviceSessionDto } from '@openathlete/shared';

import {
  buildDeviceStream,
  buildStepSegments,
  cleanSamples,
  summarizeSession,
} from './device-session.mapper';

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
  samples: [],
  steps: [],
  adaptations: [],
  ...overrides,
});

describe('device session mapping', () => {
  it('drops out-of-order and regressing samples', () => {
    const samples = cleanSamples([
      { t: 10, distance: 40 },
      { t: 5, distance: 20 },
      { t: 10, distance: 45 },
      { t: 15, distance: 30 },
      { t: 20, distance: 80 },
    ]);
    expect(samples.map((sample) => sample.t)).toEqual([5, 10, 20]);
  });

  it('keeps stream channels index-aligned by carrying readings forward', () => {
    const stream = buildDeviceStream([
      { t: 0, distance: 0 },
      { t: 5, distance: 20, heartRate: 140, latitude: 45, longitude: 9 },
      { t: 10, distance: 40 },
      { t: 15, distance: 60, heartRate: 150.4 },
    ]);
    expect(stream.time).toEqual([0, 5, 10, 15]);
    expect(stream.heartrate).toEqual([140, 140, 140, 150]);
    expect(stream.latlng).toEqual([
      [45, 9],
      [45, 9],
      [45, 9],
      [45, 9],
    ]);
  });

  it('omits channels with no readings', () => {
    const stream = buildDeviceStream([
      { t: 0, distance: 0 },
      { t: 5, distance: 20 },
    ]);
    expect(stream.heartrate).toBeUndefined();
    expect(stream.latlng).toBeUndefined();
  });

  it('summarizes totals from the session and samples', () => {
    const totals = summarizeSession(session(), [
      { t: 0, distance: 0, heartRate: 140, speed: 3 },
      { t: 5, distance: 20, heartRate: 160, speed: 6 },
    ]);
    expect(totals).toEqual({
      movingTime: 100,
      averageSpeed: 4,
      maxSpeed: 6,
      averageHeartrate: 150,
      maxHeartrate: 160,
    });
  });

  it('creates one segment per executed step and ignores foreign step ids', () => {
    const segments = buildStepSegments(
      session({
        steps: [
          {
            stepId: '7-0',
            workoutStepId: 11,
            title: '200 m',
            kind: 'run',
            repeatIndex: 1,
            repeatCount: 8,
            startOffset: 0,
            endOffset: 40,
            distance: 200,
            averageHeartRate: 170,
            maxHeartRate: 178,
            timeInTarget: 0.9,
            outcome: 'completed',
          },
          {
            stepId: '7-1',
            workoutStepId: 99,
            title: 'Recover',
            kind: 'recovery',
            startOffset: 40,
            endOffset: 70.6,
            distance: 60,
            timeInTarget: null,
            outcome: 'cut',
          },
          {
            stepId: '7-2',
            workoutStepId: 11,
            title: '200 m',
            kind: 'run',
            startOffset: 70.6,
            endOffset: 70.6,
            distance: 0,
            outcome: 'skipped',
          },
        ],
      }),
      new Set([11, 12]),
    );
    expect(segments).toEqual([
      expect.objectContaining({
        name: '200 m 1/8',
        orderIndex: 0,
        startTimeSeconds: 0,
        endTimeSeconds: 40,
        averageSpeed: 5,
        timeInTarget: 0.9,
        workoutStepId: 11,
      }),
      expect.objectContaining({
        name: 'Recover',
        orderIndex: 1,
        startTimeSeconds: 40,
        endTimeSeconds: 71,
        movingTime: 31,
        workoutStepId: null,
      }),
    ]);
  });
});
