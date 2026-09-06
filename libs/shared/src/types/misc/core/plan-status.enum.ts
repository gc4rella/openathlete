/**
 * Plan status enum matching Prisma PlanStatus
 * Lifecycle of a training plan: DRAFT -> ACTIVE -> COMPLETED / ARCHIVED
 */
export enum PLAN_STATUS {
  DRAFT = 'DRAFT',
  ACTIVE = 'ACTIVE',
  COMPLETED = 'COMPLETED',
  ARCHIVED = 'ARCHIVED',
}
