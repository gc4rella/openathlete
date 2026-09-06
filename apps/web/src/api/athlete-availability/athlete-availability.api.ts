import client, { routes } from '@/utils/axios';

import {
  AthleteAvailabilitySlot,
  SetAthleteAvailabilityDto,
} from '@openathlete/shared';

export type AthleteAvailabilityRecord = AthleteAvailabilitySlot & {
  athleteAvailabilityId: number;
  athleteId: number;
};

export class AthleteAvailabilityAPI {
  static async get(athleteId?: number): Promise<AthleteAvailabilityRecord[]> {
    const res = await client.get(routes.athleteAvailability.get, {
      params: { athleteId },
    });

    return res.data as AthleteAvailabilityRecord[];
  }

  static async set(params: {
    body: SetAthleteAvailabilityDto;
    athleteId?: number;
  }): Promise<AthleteAvailabilityRecord[]> {
    const res = await client.put(routes.athleteAvailability.set, params.body, {
      params: { athleteId: params.athleteId },
    });

    return res.data as AthleteAvailabilityRecord[];
  }
}
