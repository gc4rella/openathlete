import {
  type MapperContext,
  type MapperEvent,
  type MapperStep,
  type MapperTarget,
  toDeviceWorkout,
} from './device-workout.mapper';

const target = (overrides: Partial<MapperTarget>): MapperTarget => ({
  targetType: 'OPEN',
  targetMin: null,
  targetMax: null,
  targetValue: null,
  metricType: null,
  ...overrides,
});

let nextStepId = 100;
const step = (overrides: Partial<MapperStep>): MapperStep => ({
  workoutStepId: nextStepId++,
  orderIndex: 0,
  stepType: 'STEADY',
  name: null,
  notes: null,
  durationType: 'TIME',
  durationValue: 600,
  repeatParentId: null,
  targets: [],
  repeatBlock: null,
  ...overrides,
});

const event = (
  steps: MapperStep[],
  overrides: Partial<MapperEvent['training']> = {},
): MapperEvent => ({
  eventId: 7,
  name: 'Intervals',
  description: null,
  startDate: new Date('2026-09-24T06:00:00.000Z'),
  training: {
    sport: 'RUNNING',
    description: null,
    goalDistance: null,
    goalDuration: null,
    goalRpe: null,
    workout: { workoutId: 3, steps },
    ...overrides,
  },
});

const context: MapperContext = {
  metrics: { HR_MAX: 200, VMA: 18 },
  zones: [
    {
      trainingZoneId: 41,
      index: 1,
      type: 'HEARTRATE',
      values: [
        { min: 130, max: 145, sports: [] },
        { min: 125, max: 140, sports: ['CYCLING'] },
      ],
    },
    {
      trainingZoneId: 44,
      index: 4,
      type: 'HEARTRATE',
      values: [{ min: 180, max: 200, sports: [] }],
    },
    {
      trainingZoneId: 51,
      index: 2,
      type: 'PACE',
      values: [{ min: 4.5, max: 5, sports: ['RUNNING'] }],
    },
  ],
};

describe('toDeviceWorkout', () => {
  it('expands repeat blocks with rep numbers and keeps the planned step id', () => {
    const rep = step({
      stepType: 'INTERVAL_ACTIVE',
      durationType: 'DISTANCE',
      durationValue: 200,
      orderIndex: 0,
    });
    const rest = step({
      stepType: 'INTERVAL_REST',
      durationValue: 90,
      orderIndex: 1,
    });
    const block = step({
      stepType: 'REPEAT',
      orderIndex: 1,
      repeatBlock: { repetitions: 3, childSteps: [rest, rep] },
    });
    const children = [rep, rest].map((child) => ({
      ...child,
      repeatParentId: block.workoutStepId,
    }));
    const workout = toDeviceWorkout(
      event([step({ stepType: 'WARMUP', orderIndex: 0 }), block, ...children]),
      context,
    );

    expect(workout.steps).toHaveLength(7);
    expect(workout.steps.map((s) => s.kind)).toEqual([
      'warmup',
      'run',
      'recovery',
      'run',
      'recovery',
      'run',
      'recovery',
    ]);
    expect(workout.steps[5]).toMatchObject({
      id: '7-5',
      workoutStepId: rep.workoutStepId,
      end: { type: 'distance', value: 200 },
      repeat: { index: 3, count: 3, groupId: `7-r${block.workoutStepId}` },
    });
    expect(new Set(workout.steps.map((s) => s.id)).size).toBe(7);
  });

  it('converts absolute speed ranges to seconds per kilometer', () => {
    const workout = toDeviceWorkout(
      event([
        step({
          targets: [target({ targetType: 'PACE', targetMin: 4, targetMax: 5 })],
        }),
      ]),
      context,
    );
    expect(workout.steps[0].pace).toEqual({ fast: 200, slow: 250 });
  });

  it('resolves percentage of VMA', () => {
    const workout = toDeviceWorkout(
      event([
        step({
          targets: [
            target({
              targetType: 'PACE',
              targetMin: 0.9,
              targetMax: 1,
              metricType: 'VMA',
            }),
          ],
        }),
      ]),
      context,
    );
    // 18 km/h = 5 m/s = 200 s/km; 90% = 4.5 m/s = 222.2 s/km
    expect(workout.steps[0].pace).toEqual({ fast: 200, slow: 222.2 });
    expect(workout.warnings).toEqual([]);
  });

  it('resolves percentage of max heart rate', () => {
    const workout = toDeviceWorkout(
      event([
        step({
          targets: [
            target({
              targetType: 'HEARTRATE',
              targetMin: 0.7,
              targetMax: 0.8,
              metricType: 'HR_MAX',
            }),
          ],
        }),
      ]),
      context,
    );
    expect(workout.steps[0].heartRate).toEqual({ min: 140, max: 160 });
  });

  it('falls back to defaults and warns when the metric is missing', () => {
    const workout = toDeviceWorkout(
      event([
        step({
          targets: [
            target({
              targetType: 'HEARTRATE',
              targetMin: 0.7,
              targetMax: 0.8,
              metricType: 'HR_MAX',
            }),
          ],
        }),
      ]),
      { ...context, metrics: {} },
    );
    expect(workout.steps[0].heartRate).toEqual({ min: 133, max: 152 });
    expect(workout.warnings[0]).toContain('HR_MAX');
  });

  it('resolves zone targets by training zone id for the session sport', () => {
    const workout = toDeviceWorkout(
      event([
        step({ targets: [target({ targetType: 'ZONE', targetValue: 41 })] }),
      ]),
      context,
    );
    expect(workout.steps[0].heartRate).toEqual({ min: 130, max: 145 });
    expect(workout.steps[0].instruction).toContain('Zone 2.');
  });

  it('accepts a 1-5 zone number as a heart-rate zone position', () => {
    const workout = toDeviceWorkout(
      event([
        step({ targets: [target({ targetType: 'ZONE', targetValue: 5 })] }),
      ]),
      context,
    );
    expect(workout.steps[0].heartRate).toEqual({ min: 180, max: 200 });
  });

  it('resolves pace zones entered in minutes per kilometer', () => {
    const workout = toDeviceWorkout(
      event([
        step({ targets: [target({ targetType: 'ZONE', targetValue: 51 })] }),
      ]),
      context,
    );
    expect(workout.steps[0].pace).toEqual({ fast: 270, slow: 300 });
  });

  it('degrades unknown zones to an effort cue instead of failing', () => {
    const workout = toDeviceWorkout(
      event([
        step({ targets: [target({ targetType: 'ZONE', targetValue: 999 })] }),
      ]),
      context,
    );
    expect(workout.steps[0].heartRate).toBeNull();
    expect(workout.warnings).toHaveLength(1);
  });

  it('turns single values into bands and RPE into instruction text', () => {
    const workout = toDeviceWorkout(
      event([
        step({
          targets: [
            target({ targetType: 'HEARTRATE', targetValue: 150 }),
            target({ targetType: 'RPE', targetValue: 0.6 }),
          ],
        }),
      ]),
      context,
    );
    expect(workout.steps[0].heartRate).toEqual({ min: 145, max: 155 });
    expect(workout.steps[0].rpe).toBe(6);
    expect(workout.steps[0].instruction).toContain('Effort 6 out of 10.');
  });

  it('builds a single step for unstructured sessions', () => {
    const workout = toDeviceWorkout(
      event([], { goalDistance: 8000, workout: null }),
      context,
    );
    expect(workout.workoutId).toBeNull();
    expect(workout.steps).toEqual([
      expect.objectContaining({
        id: '7-0',
        end: { type: 'distance', value: 8000 },
        workoutStepId: null,
      }),
    ]);
  });

  it('keeps heart-rate step endings as open steps with guidance', () => {
    const workout = toDeviceWorkout(
      event([step({ durationType: 'HR_BELOW', durationValue: 120 })]),
      context,
    );
    expect(workout.steps[0].end).toEqual({ type: 'open', value: null });
    expect(workout.steps[0].instruction).toContain('below 120');
  });
});
