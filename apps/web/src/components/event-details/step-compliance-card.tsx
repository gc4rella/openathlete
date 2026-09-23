import { useGetEventQuery } from '@/api/event';
import { m } from '@/paraglide/messages';
import { cn } from '@/utils/shadcn';
import { useMemo } from 'react';

import {
  type ActivityEvent,
  EVENT_TYPE,
  type Workout,
  type WorkoutStep,
  type WorkoutStepTargetDto,
  complianceLevel,
  formatDistance,
  formatDuration,
  formatSpeed,
  sessionCompliance,
} from '@openathlete/shared';

import { Badge } from '../ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../ui/table';
import { TargetBadge } from '../workout';

const LEVEL_CLASS = {
  good: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  fair: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  poor: 'bg-red-500/15 text-red-700 dark:text-red-400',
} as const;

export function ComplianceBadge({
  value,
  className,
}: {
  value: number;
  className?: string;
}) {
  return (
    <Badge
      variant="outline"
      className={cn(
        'border-transparent tabular-nums',
        LEVEL_CLASS[complianceLevel(value)],
        className,
      )}
      title={m.step_compliance()}
    >
      {Math.round(value * 100)}%
    </Badge>
  );
}

interface P {
  activityEventId: number;
  workout: Workout;
}

/**
 * Planned vs actual, rep by rep, for sessions recorded live on the watch.
 * Renders nothing for activities without WORKOUT_STEP segments.
 */
export function StepComplianceCard({ activityEventId, workout }: P) {
  const { data: activity } = useGetEventQuery(activityEventId);

  const plannedById = useMemo(() => {
    const byId = new Map<number, WorkoutStep>();
    const visit = (steps: WorkoutStep[] | undefined) => {
      for (const step of steps ?? []) {
        byId.set(step.workoutStepId, step);
        visit(step.repeatBlock?.childSteps);
      }
    };
    visit(workout.steps);
    return byId;
  }, [workout]);

  if (!activity || activity.type !== EVENT_TYPE.ACTIVITY) return null;
  const segments = ((activity as ActivityEvent).segments ?? []).filter(
    (segment) => segment.segmentType === 'WORKOUT_STEP',
  );
  if (segments.length === 0) return null;
  const overall = sessionCompliance(segments);

  return (
    <Card>
      <CardHeader className="space-y-1">
        <div className="flex items-center justify-between gap-2">
          <CardTitle>{m.step_compliance()}</CardTitle>
          {overall !== null && <ComplianceBadge value={overall} />}
        </div>
        <p className="text-sm text-muted-foreground">
          {overall !== null
            ? m.step_compliance_summary({
                percent: String(Math.round(overall * 100)),
              })
            : m.step_compliance_recorded()}
        </p>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{m.step_compliance_step()}</TableHead>
              <TableHead>{m.step_compliance_target()}</TableHead>
              <TableHead>{m.step_compliance_actual()}</TableHead>
              <TableHead className="text-right">
                {m.step_compliance_on_target()}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {segments.map((segment) => {
              const planned =
                segment.workoutStepId !== null
                  ? plannedById.get(segment.workoutStepId)
                  : undefined;
              const actual = [
                segment.movingTime ? formatDuration(segment.movingTime) : null,
                segment.distance
                  ? `${formatDistance(segment.distance)} km`
                  : null,
                segment.averageSpeed
                  ? `${formatSpeed(segment.averageSpeed)} /km`
                  : null,
                segment.averageHeartrate
                  ? `${Math.round(segment.averageHeartrate)} bpm`
                  : null,
              ].filter(Boolean);
              return (
                <TableRow key={segment.activitySegmentId}>
                  <TableCell className="font-medium whitespace-nowrap">
                    {segment.name}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {planned?.targets
                        .filter((target) => target.targetType !== 'OPEN')
                        .map((target) => (
                          <TargetBadge
                            key={target.workoutStepTargetId}
                            target={target as WorkoutStepTargetDto}
                            showAbsoluteValues
                          />
                        ))}
                    </div>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground tabular-nums">
                    {actual.join(' · ')}
                  </TableCell>
                  <TableCell className="text-right">
                    {segment.timeInTarget !== null ? (
                      <ComplianceBadge value={segment.timeInTarget} />
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
