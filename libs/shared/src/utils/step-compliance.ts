/** Minimal segment shape needed to score how well a session followed its targets. */
export type ComplianceSegment = {
  timeInTarget: number | null;
  movingTime: number | null;
};

/**
 * Time-weighted share (0-1) of a session spent inside its step targets, from
 * the WORKOUT_STEP segments recorded by the watch. Null when no step had a
 * measurable target (e.g. activities imported from another provider).
 */
export function sessionCompliance(
  segments: ComplianceSegment[] | null | undefined,
): number | null {
  let weighted = 0;
  let total = 0;
  for (const segment of segments ?? []) {
    if (segment.timeInTarget === null || !segment.movingTime) continue;
    weighted += segment.timeInTarget * segment.movingTime;
    total += segment.movingTime;
  }
  return total > 0 ? weighted / total : null;
}

export type ComplianceLevel = 'good' | 'fair' | 'poor';

export function complianceLevel(value: number): ComplianceLevel {
  if (value >= 0.8) return 'good';
  if (value >= 0.5) return 'fair';
  return 'poor';
}
