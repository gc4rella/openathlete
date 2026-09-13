import { PLAN_GOAL_KIND, type PlanIntakeDraft } from '@openathlete/shared';

import { ChatGptPlannerProviderService } from './chatgpt-planner-provider.service';
import { PlanGenerationService } from './plan-generation.service';
import { PlanIntakeService } from './plan-intake.service';
import { requiredIntakeFields } from './plan-intake.validation';

const completeRaceDraft: PlanIntakeDraft = {
  goalKind: PLAN_GOAL_KIND.RACE,
  startDate: '2026-09-08',
  raceDate: '2026-12-06',
  targetDistance: 21097,
  targetTime: 6000,
  durationWeeks: null,
  daysPerWeek: 3,
  longRunDay: 0,
  currentWeeklyVolume: 10800,
  includeCrossTraining: false,
  injuryAware: true,
  planName: null,
};

describe('conversational plan intake validation', () => {
  it('accepts a complete race brief', () => {
    expect(requiredIntakeFields(completeRaceDraft)).toEqual([]);
  });

  it('does not trust a race date before the plan start', () => {
    expect(
      requiredIntakeFields({
        ...completeRaceDraft,
        raceDate: '2026-09-01',
      }),
    ).toContain('raceDateAfterStartDate');
  });

  it('requires at least four weeks of race preparation', () => {
    expect(
      requiredIntakeFields({
        ...completeRaceDraft,
        raceDate: '2026-09-30',
      }),
    ).toContain('preparationAtLeastFourWeeks');
  });

  it('requires duration but not race fields for general fitness', () => {
    const missing = requiredIntakeFields({
      ...completeRaceDraft,
      goalKind: PLAN_GOAL_KIND.GENERAL_FITNESS,
      raceDate: null,
      targetDistance: null,
      durationWeeks: null,
    });

    expect(missing).toEqual(['durationWeeks']);
  });

  it('recomputes readiness instead of trusting the model flag', async () => {
    const generation = {
      recentWeeklyVolume: jest.fn().mockResolvedValue(10800),
      recentLongestRun: jest.fn().mockResolvedValue(5400),
    };
    const provider = {
      generate: jest.fn().mockResolvedValue({
        message: 'Please review your details.',
        ready: false,
        missingFields: ['incorrectModelGuess'],
        draft: completeRaceDraft,
      }),
    };
    const service = new PlanIntakeService(
      generation as unknown as PlanGenerationService,
      provider as unknown as ChatGptPlannerProviderService,
    );

    await expect(
      service.reply({
        athleteId: 1,
        messages: [{ role: 'user', content: 'My race details' }],
        language: 'EN',
        timeZone: 'Europe/Berlin',
      }),
    ).resolves.toMatchObject({ ready: true, missingFields: [] });
  });
});
