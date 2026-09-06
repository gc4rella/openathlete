import { PlanPreview as PlanPreviewData } from '@/api/training-plan';
import { Badge } from '@/components/ui/badge';
import { m } from '@/paraglide/messages';

import { formatDurationShort, formatFinishTime } from './format';

/**
 * The plan as the athlete sees it before committing to it.
 *
 * Shows the shape of the block (phases, weekly volume) and, importantly, what
 * the paces were derived from - an athlete whose plan was built on population
 * averages should know that before they train off it.
 */

const FITNESS_LABELS: Record<
  PlanPreviewData['fitness']['source'],
  () => string
> = {
  BEST_EFFORT: () => m.training_plan_fitness_best_effort(),
  VO2MAX_METRIC: () => m.training_plan_fitness_vo2max(),
  VMA_METRIC: () => m.training_plan_fitness_vma(),
  GOAL_TIME: () => m.training_plan_fitness_goal(),
  DEFAULT: () => m.training_plan_fitness_default(),
};

export function PlanPreview({ preview }: { preview: PlanPreviewData }) {
  const weeks = preview.plan.cycles.flatMap((cycle) => cycle.weeks);
  const peakVolume = Math.max(
    ...weeks.map((week) => week.targetVolume ?? 0),
    0,
  );

  return (
    <div className="space-y-4">
      <div>
        <h3 className="font-semibold">{preview.plan.plan.name}</h3>
        <p className="text-sm text-muted-foreground">
          {preview.plan.plan.description}
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <Badge variant="secondary">
          {weeks.length} {m.training_plan_weeks()}
        </Badge>
        {preview.predictedRaceTime !== null && (
          <Badge variant="secondary">
            {m.training_plan_predicted_time()}:{' '}
            {formatFinishTime(preview.predictedRaceTime)}
          </Badge>
        )}
        <Badge
          variant={
            preview.fitness.source === 'DEFAULT' ? 'destructive' : 'secondary'
          }
        >
          {m.training_plan_fitness_basis()}:{' '}
          {FITNESS_LABELS[preview.fitness.source]()}
        </Badge>
      </div>

      {preview.plan.plan.coachNotes && (
        <div className="rounded-md border bg-muted/40 p-3">
          <p className="text-xs font-medium uppercase text-muted-foreground">
            {m.training_plan_coach_notes()}
          </p>
          <p className="mt-1 text-sm">{preview.plan.plan.coachNotes}</p>
        </div>
      )}

      {/* Volume curve: the shape of the block at a glance. */}
      <div>
        <p className="mb-2 text-sm font-medium">
          {m.training_plan_weekly_volume()}
        </p>
        <div className="flex h-24 items-end gap-1">
          {weeks.map((week) => {
            const volume = week.targetVolume ?? 0;
            const height = peakVolume > 0 ? (volume / peakVolume) * 100 : 0;

            return (
              <div
                key={week.weekNumber}
                className="flex-1 rounded-t bg-primary/70"
                style={{ height: `${Math.max(4, height)}%` }}
                title={`${m.training_plan_week()} ${week.weekNumber}: ${formatDurationShort(volume)}`}
              />
            );
          })}
        </div>
      </div>

      <div className="space-y-2">
        {preview.plan.cycles.map((cycle, index) => (
          <div key={index} className="rounded-md border p-3">
            <div className="flex items-center justify-between">
              <span className="font-medium">{cycle.name}</span>
              <span className="text-xs text-muted-foreground">
                {cycle.weeks.length} {m.training_plan_weeks()}
              </span>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {cycle.description}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
