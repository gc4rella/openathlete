import { WORKOUT_TARGET_TYPE } from '@openathlete/shared';

import { generatePlan } from './index';
import { sessionDescription } from './narrative';
import { formatPace, paceTableForVdot } from './physiology';
import { ARCHETYPES } from './session-templates';
import { flattenSessions, makeInput } from './test-helpers';
import { RunIntensity } from './types';

const paces = paceTableForVdot(40);

describe('half-marathon pace consistency', () => {
  it('keeps the 1:40 race goal distinct from slower current training fitness', () => {
    const result = generatePlan(makeInput({
      targetDistance: 21097.5,
      targetTime: 6000,
      fitness: { bestEfforts: [{ distanceMeters: 10000, timeSeconds: 3310 }] },
    }));
    const race = flattenSessions(result.plan).find(session => session.archetype === 'race')!;
    expect(race.description).toContain('Goal pace: 4:44/km');
    expect(result.predictedRaceTime).toBeGreaterThan(6000);
    const target = race.workout!.steps[0].targets![0];
    expect(formatPace((target.targetMin! + target.targetMax!) / 2)).toBe('4:44/km');
  });

  it('uses the race-specific speed for both rehearsal distance and description', () => {
    const racePace = 21097.5 / 6000;
    const built = ARCHETYPES['race-pace'].build({ paces, durationSeconds: 3600, racePace });
    const expectedDistance = built.steps.reduce((total, step) => {
      const target = step.targets![0];
      return total + step.durationValue! * ((target.targetMin! + target.targetMax!) / 2);
    }, 0);
    expect(Math.abs(built.distanceMeters - expectedDistance)).toBeLessThan(3);
    expect(sessionDescription('race-pace', built.intensity, paces, 'EN', false, built.steps)).toContain('4:44/km');
  });

  it('does not put a pace in prose for a heart-rate-zone workout', () => {
    const built = ARCHETYPES.easy.build({ paces, durationSeconds: 2400, zoneIds: { [RunIntensity.EASY]: 7 } });
    expect(sessionDescription('easy', built.intensity, paces, 'EN', false, built.steps)).not.toContain('/km');
  });

  it('does not turn a goal with no fitness evidence into a forecast or training pace', () => {
    const result = generatePlan(makeInput({ fitness: {}, targetDistance: 21097.5, targetTime: 6000 }));
    expect(result.predictedRaceTime).toBeNull();
    const easy = flattenSessions(result.plan).find(session => session.archetype === 'easy')!;
    expect(easy.workout!.steps[0].targets![0].targetType).toBe(WORKOUT_TARGET_TYPE.RPE);
    expect(easy.description).not.toContain('/km');
  });
});
