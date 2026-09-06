/**
 * Plan adjustment trigger enum matching Prisma PlanAdjustmentTrigger
 * Records why the adaptation engine (or a human) changed a training plan.
 */
export enum PLAN_ADJUSTMENT_TRIGGER {
  /** ACWR / TSB indicates too much acute load */
  LOAD_SPIKE = 'LOAD_SPIKE',
  /** Athlete missed a significant share of planned sessions */
  LOW_COMPLETION = 'LOW_COMPLETION',
  /** An open injury requires reducing impact */
  INJURY = 'INJURY',
  /** Sessions felt consistently harder than targeted */
  RPE_OVERSHOOT = 'RPE_OVERSHOOT',
  /** Athlete is comfortably under target and can progress faster */
  UNDERLOAD = 'UNDERLOAD',
  /** Athlete or coach changed the plan themselves */
  MANUAL = 'MANUAL',
}
