import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';

import { AvailabilityPriority } from '@openathlete/database';
import { type SetAthleteAvailabilityDto } from '@openathlete/shared';

import { CaslAbilityFactory } from '../../auth';
import { AuthUser } from '../../auth/decorators/user.decorator';
import { accessibleBy } from '../../auth/services/casl-prisma';
import { PrismaService } from '../../prisma/services/prisma.service';

/**
 * Athlete availability
 *
 * The athlete's weekly training windows. The plan generator uses these to
 * decide which days to train on, which day carries the long run, and what time
 * of day sessions are scheduled for.
 *
 * The model existed in the schema from the start but had no API; this is it.
 */

@Injectable()
export class AthleteAvailabilityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly abilities: CaslAbilityFactory,
  ) {}

  async find(user: AuthUser, athleteId?: number) {
    const targetAthleteId = this.resolveAthleteId(user, athleteId);
    const ability = await this.abilities.getFor({ user });

    return this.prisma.athleteAvailability.findMany({
      where: {
        AND: [
          accessibleBy(ability, 'read').AthleteAvailability,
          { athleteId: targetAthleteId },
        ],
      },
      orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }],
    });
  }

  /**
   * Replace the athlete's whole weekly availability.
   *
   * A full replacement rather than per-slot edits: the wizard always submits
   * the complete week, and this avoids partial-update races leaving a half
   * updated schedule behind.
   */
  async set(
    user: AuthUser,
    body: SetAthleteAvailabilityDto,
    athleteId?: number,
  ) {
    const targetAthleteId = this.resolveAthleteId(user, athleteId);

    this.assertNoOverlaps(body.slots);

    await this.prisma.$transaction([
      this.prisma.athleteAvailability.deleteMany({
        where: { athleteId: targetAthleteId },
      }),
      this.prisma.athleteAvailability.createMany({
        data: body.slots.map((slot) => ({
          athleteId: targetAthleteId,
          dayOfWeek: slot.dayOfWeek,
          startTime: slot.startTime,
          endTime: slot.endTime,
          priority: slot.priority as AvailabilityPriority,
        })),
      }),
    ]);

    return this.find(user, athleteId);
  }

  private assertNoOverlaps(slots: SetAthleteAvailabilityDto['slots']) {
    const byDay = new Map<number, Array<{ start: string; end: string }>>();

    for (const slot of slots) {
      const day = byDay.get(slot.dayOfWeek) ?? [];

      for (const existing of day) {
        if (slot.startTime < existing.end && existing.start < slot.endTime) {
          throw new BadRequestException(
            `Overlapping availability windows on day ${slot.dayOfWeek}`,
          );
        }
      }

      day.push({ start: slot.startTime, end: slot.endTime });
      byDay.set(slot.dayOfWeek, day);
    }
  }

  private resolveAthleteId(user: AuthUser, athleteId?: number): number {
    if (athleteId === undefined) {
      const own = user?.athlete?.athleteId;

      if (!own) {
        throw new BadRequestException(
          'No athlete profile found for this user; specify an athleteId',
        );
      }

      return own;
    }

    const isOwn = user?.athlete?.athleteId === athleteId;
    const isCoached = user.coachAthletes?.some(
      (coachAthlete) => coachAthlete.athleteId === athleteId,
    );

    if (!isOwn && !isCoached) {
      throw new ForbiddenException('You are not coaching this athlete');
    }

    return athleteId;
  }
}
