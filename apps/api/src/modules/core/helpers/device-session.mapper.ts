import type {
  ActivityStream,
  DeviceSessionDto,
  DeviceSessionSample,
} from '@openathlete/shared';

// ============================================================================
// Device session -> activity stream, totals and WORKOUT_STEP segments
// ============================================================================

const mean = (values: number[]) =>
  values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null;
const maxOf = (values: number[]) =>
  values.length ? values.reduce((a, b) => Math.max(a, b), -Infinity) : null;
const isNumber = (value: number | null | undefined): value is number =>
  value !== null && value !== undefined && Number.isFinite(value);

/** Samples sorted by time, with non-monotonic time or distance dropped. */
export function cleanSamples(
  samples: DeviceSessionSample[],
): DeviceSessionSample[] {
  const sorted = [...samples].sort((a, b) => a.t - b.t);
  const clean: DeviceSessionSample[] = [];
  for (const sample of sorted) {
    const previous = clean[clean.length - 1];
    if (
      previous &&
      (sample.t <= previous.t || sample.distance < previous.distance)
    )
      continue;
    clean.push(sample);
  }
  return clean;
}

/**
 * Stream arrays must stay index-aligned. Heart rate and position gaps are
 * filled from the previous reading; a channel with no readings is omitted.
 */
export function buildDeviceStream(
  samples: DeviceSessionSample[],
): ActivityStream {
  const stream: ActivityStream = {
    time: samples.map((sample) => Math.round(sample.t)),
    distance: samples.map((sample) => sample.distance),
  };
  if (samples.some((sample) => isNumber(sample.heartRate))) {
    let last = samples.find((sample) => isNumber(sample.heartRate))!.heartRate!;
    stream.heartrate = samples.map((sample) => {
      if (isNumber(sample.heartRate)) last = sample.heartRate;
      return Math.round(last);
    });
  }
  const located = samples.find(
    (sample) => isNumber(sample.latitude) && isNumber(sample.longitude),
  );
  if (located) {
    let last = [located.latitude!, located.longitude!];
    stream.latlng = samples.map((sample) => {
      if (isNumber(sample.latitude) && isNumber(sample.longitude)) {
        last = [sample.latitude, sample.longitude];
      }
      return last;
    });
  }
  return stream;
}

export function summarizeSession(
  session: DeviceSessionDto,
  samples: DeviceSessionSample[],
) {
  const heartRates = samples.map((sample) => sample.heartRate).filter(isNumber);
  const speeds = samples.map((sample) => sample.speed).filter(isNumber);
  const movingTime = Math.max(1, Math.round(session.duration));
  const averageSpeed = session.distance / movingTime;
  return {
    movingTime,
    averageSpeed,
    maxSpeed: Math.max(averageSpeed, maxOf(speeds) ?? 0),
    averageHeartrate: mean(heartRates),
    maxHeartrate: maxOf(heartRates),
  };
}

export type StepSegmentInput = {
  segmentType: 'WORKOUT_STEP';
  name: string;
  orderIndex: number;
  startTimeSeconds: number;
  endTimeSeconds: number;
  distance: number;
  movingTime: number;
  averageSpeed: number | null;
  maxSpeed: number | null;
  averageHeartrate: number | null;
  maxHeartrate: number | null;
  timeInTarget: number | null;
  workoutStepId: number | null;
};

/**
 * One segment per executed step. Skipped steps get no segment: the web view
 * shows planned steps without a segment as skipped. Step ids that do not
 * belong to the linked workout are dropped rather than trusted.
 */
export function buildStepSegments(
  session: DeviceSessionDto,
  validWorkoutStepIds: Set<number>,
): StepSegmentInput[] {
  return session.steps
    .filter(
      (step) => step.outcome !== 'skipped' && step.endOffset > step.startOffset,
    )
    .map((step, orderIndex) => {
      const duration = step.endOffset - step.startOffset;
      const rep =
        step.repeatIndex && step.repeatCount && step.repeatCount > 1
          ? ` ${step.repeatIndex}/${step.repeatCount}`
          : '';
      return {
        segmentType: 'WORKOUT_STEP' as const,
        name: `${step.title}${rep}`.slice(0, 200),
        orderIndex,
        startTimeSeconds: Math.floor(step.startOffset),
        endTimeSeconds: Math.max(
          Math.floor(step.startOffset) + 1,
          Math.round(step.endOffset),
        ),
        distance: step.distance,
        movingTime: Math.round(duration),
        averageSpeed: duration > 0 ? step.distance / duration : null,
        maxSpeed: null,
        averageHeartrate: step.averageHeartRate ?? null,
        maxHeartrate: step.maxHeartRate ?? null,
        timeInTarget: step.timeInTarget ?? null,
        workoutStepId:
          step.workoutStepId && validWorkoutStepIds.has(step.workoutStepId)
            ? step.workoutStepId
            : null,
      };
    });
}
