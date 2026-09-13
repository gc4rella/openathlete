import { PLAN_GOAL_KIND, type PlanIntakeDraft } from '@openathlete/shared';

/** Recompute readiness in trusted code instead of accepting the model's flag. */
export function requiredIntakeFields(draft: PlanIntakeDraft): string[] {
  const missing: string[] = [];

  if (!draft.goalKind) missing.push('goalKind');
  if (!draft.startDate) missing.push('startDate');
  if (!draft.daysPerWeek) missing.push('daysPerWeek');
  if (!draft.currentWeeklyVolume) missing.push('currentWeeklyVolume');

  if (draft.goalKind === PLAN_GOAL_KIND.RACE) {
    if (!draft.raceDate) missing.push('raceDate');
    if (!draft.targetDistance) missing.push('targetDistance');

    if (
      draft.startDate &&
      draft.raceDate &&
      draft.raceDate <= draft.startDate
    ) {
      missing.push('raceDateAfterStartDate');
    } else if (draft.startDate && draft.raceDate) {
      const preparationMs =
        Date.parse(`${draft.raceDate}T00:00:00Z`) -
        Date.parse(`${draft.startDate}T00:00:00Z`);
      if (preparationMs < 28 * 24 * 60 * 60 * 1000) {
        missing.push('preparationAtLeastFourWeeks');
      }
    }
  }

  if (
    draft.goalKind === PLAN_GOAL_KIND.GENERAL_FITNESS &&
    !draft.durationWeeks
  ) {
    missing.push('durationWeeks');
  }

  return missing;
}
