import { type CreateWorkoutStepDto, WORKOUT_DURATION_TYPE } from '@openathlete/shared';

/** Resize every timed/distance leaf; repeat parents keep their repetition count. */
export function resizeSteps(steps: CreateWorkoutStepDto[], scale: number): CreateWorkoutStepDto[] {
  return steps.map(step => ({
    ...step,
    durationValue: step.durationValue != null &&
      (step.durationType === WORKOUT_DURATION_TYPE.TIME || step.durationType === WORKOUT_DURATION_TYPE.DISTANCE)
      ? Math.max(1, Math.round(step.durationValue * scale)) : step.durationValue,
    repeatBlock: step.repeatBlock ? {
      ...step.repeatBlock, childSteps: resizeSteps(step.repeatBlock.childSteps, scale),
    } : step.repeatBlock,
  }));
}

/** Null for workouts whose duration cannot be derived without a measured pace. */
export function timedDuration(steps: CreateWorkoutStepDto[]): number | null {
  let total = 0;
  for (const step of steps) {
    if (step.repeatBlock) {
      const child = timedDuration(step.repeatBlock.childSteps);
      if (child === null) return null;
      total += child * step.repeatBlock.repetitions;
    } else if (step.durationType === WORKOUT_DURATION_TYPE.TIME && step.durationValue != null) total += step.durationValue;
    else return null;
  }
  return total;
}

export function adaptationTarget(currentScale: number, currentSeverity: number, scale: number, severity: number) {
  const nextScale = scale < 1 ? Math.min(currentScale, scale) : currentScale < 1 ? currentScale : scale;
  const nextSeverity = Math.max(currentSeverity, severity);
  return { scale: nextScale, severity: nextSeverity, changed: nextScale !== currentScale || nextSeverity !== currentSeverity };
}
