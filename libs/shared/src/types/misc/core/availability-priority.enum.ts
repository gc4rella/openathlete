/**
 * Availability priority enum matching Prisma AvailabilityPriority
 * Describes how strongly an athlete prefers a given training window.
 * The plan generator places long and quality sessions in HIGH windows first.
 */
export enum AVAILABILITY_PRIORITY {
  LOW = 'LOW',
  MEDIUM = 'MEDIUM',
  HIGH = 'HIGH',
}
