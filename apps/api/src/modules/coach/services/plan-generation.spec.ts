import { PLAN_GOAL_KIND, SPORT_TYPE } from '@openathlete/shared';

import { PlanGenerationService } from './plan-generation.service';

describe('plan generation context', () => {
  it('uses running record times as seconds and prefers them over fallback zones', async () => {
    const prisma = {
      athlete: { findUnique: jest.fn().mockResolvedValue({ user: { gender: 'MALE' } }) },
      eventActivity: {
        findMany: jest.fn().mockResolvedValue([]),
        aggregate: jest.fn().mockResolvedValue({ _max: { movingTime: 3600 } }),
      },
      athleteAvailability: { findMany: jest.fn().mockResolvedValue([]) },
      athleteInjury: { findMany: jest.fn().mockResolvedValue([]) },
      record: { findMany: jest.fn().mockResolvedValue([{ distance: 10000, value: 2700 }]) },
      athleteMetric: { findMany: jest.fn().mockResolvedValue([]) },
      trainingZone: { findMany: jest.fn().mockResolvedValue(Array.from({ length: 5 }, (_, index) => ({ index, trainingZoneId: index + 1 }))) },
    };
    const service = new PlanGenerationService(prisma as never);
    const input = await service.buildEngineInput(2, {
      goalKind: PLAN_GOAL_KIND.RACE, sport: SPORT_TYPE.RUNNING,
      startDate: new Date('2026-09-06'), raceDate: new Date('2026-12-21'),
      targetDistance: 21097.5, targetTime: 6000, timeZone: 'Europe/Berlin',
      daysPerWeek: 3, currentWeeklyVolume: 10800, includeCrossTraining: false, injuryAware: true,
    }, 'EN');
    expect(input.fitness.bestEfforts).toEqual([{ distanceMeters: 10000, timeSeconds: 2700 }]);
    expect(input.zoneIds).toBeUndefined();
  });
});
