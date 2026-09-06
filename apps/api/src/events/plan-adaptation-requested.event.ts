type PlanAdaptationRequestedPayload = {
  athleteId: number;
  /** What prompted the request, for logging and traceability */
  reason: 'injury-reported' | 'training-load-updated' | 'manual';
};

/**
 * Something happened that the athlete's plan should react to now rather than
 * at the next weekly pass - typically an injury reported in post-activity
 * feedback, or a recalculated training load that reveals a spike.
 */
export class PlanAdaptationRequestedEvent {
  static readonly SLUG = 'plan.adaptation-requested';

  constructor(public readonly payload: PlanAdaptationRequestedPayload) {}
}
