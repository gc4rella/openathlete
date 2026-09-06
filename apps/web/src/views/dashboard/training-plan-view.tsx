import {
  TrainingPlanDetail,
  useCurrentTrainingPlanQuery,
  useDeleteTrainingPlanMutation,
  useTrainingPlansQuery,
  useUpdateTrainingPlanMutation,
} from '@/api/training-plan';
import { LoadingScreen } from '@/components/loading-screen';
import { TrainingPlanWizard } from '@/components/training-plan-wizard';
import { ActivityFileImport } from '@/components/activity-file-import';
import { formatDurationShort } from '@/components/training-plan-wizard/format';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { m } from '@/paraglide/messages';
import { Target } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { PLAN_STATUS } from '@openathlete/shared';

/**
 * Training plan view
 *
 * The athlete's plan: where they are in it, what the coming weeks hold, and
 * every change that has been made to it.
 *
 * The adjustments feed is not decoration. A plan that silently rewrites itself
 * is indistinguishable from a broken one, so every automatic change is shown
 * with the reason it was made.
 */

const STATUS_LABELS: Record<string, () => string> = {
  DRAFT: () => m.training_plan_status_draft(),
  ACTIVE: () => m.training_plan_status_active(),
  COMPLETED: () => m.training_plan_status_completed(),
  ARCHIVED: () => m.training_plan_status_archived(),
};

export function TrainingPlanView({ athleteId }: { athleteId: number }) {
  const [wizardOpen, setWizardOpen] = useState(false);

  const { data: currentPlan, isLoading } =
    useCurrentTrainingPlanQuery(athleteId);
  const { data: plans } = useTrainingPlansQuery(athleteId);

  const updateMutation = useUpdateTrainingPlanMutation({
    onError: () => toast.error(m.training_plan_create_failed()),
  });
  const deleteMutation = useDeleteTrainingPlanMutation({
    onSuccess: () => toast.success(m.training_plan_deleted()),
  });

  if (isLoading) {
    return <LoadingScreen />;
  }

  const otherPlans = (plans ?? []).filter(
    (plan) => plan.trainingPlanId !== currentPlan?.trainingPlanId,
  );

  return (
    <div className="space-y-6 p-4">
      <ActivityFileImport />
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{m.training_plan()}</h1>
        {currentPlan && (
          <Button onClick={() => setWizardOpen(true)}>
            {m.training_plan_create()}
          </Button>
        )}
      </div>

      {!currentPlan ? (
        <EmptyState onCreate={() => setWizardOpen(true)} />
      ) : (
        <PlanDetail
          plan={currentPlan}
          onDelete={() => deleteMutation.mutate(currentPlan.trainingPlanId)}
        />
      )}

      {otherPlans.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {m.training_plan_other_plans()}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {otherPlans.map((plan) => (
              <div
                key={plan.trainingPlanId}
                className="flex items-center justify-between rounded-md border p-3"
              >
                <div>
                  <p className="font-medium">{plan.name}</p>
                  <p className="text-sm text-muted-foreground">{plan.goal}</p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="outline">
                    {STATUS_LABELS[plan.status]?.() ?? plan.status}
                  </Badge>
                  {plan.status !== PLAN_STATUS.ACTIVE && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        updateMutation.mutate({
                          trainingPlanId: plan.trainingPlanId,
                          body: { status: PLAN_STATUS.ACTIVE },
                        })
                      }
                    >
                      {m.training_plan_activate()}
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <TrainingPlanWizard
        open={wizardOpen}
        onClose={() => setWizardOpen(false)}
        athleteId={athleteId}
      />
    </div>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-4 py-12 text-center">
        <Target className="h-10 w-10 text-muted-foreground" />
        <div>
          <p className="font-medium">{m.training_plan_none_title()}</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
            {m.training_plan_none_description()}
          </p>
        </div>
        <Button onClick={onCreate}>{m.training_plan_create()}</Button>
      </CardContent>
    </Card>
  );
}

function PlanDetail({
  plan,
  onDelete,
}: {
  plan: TrainingPlanDetail;
  onDelete: () => void;
}) {
  const weeks = plan.cycles.flatMap((cycle) =>
    cycle.weeks.map((week) => ({ ...week, cycle })),
  );
  const now = new Date();
  const currentWeek = weeks.find(
    (week) => week.startDate <= now && week.endDate >= now,
  );

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between">
            <div>
              <CardTitle>{plan.name}</CardTitle>
              <CardDescription>{plan.goal}</CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Badge>{STATUS_LABELS[plan.status]?.() ?? plan.status}</Badge>
              <Button size="sm" variant="ghost" onClick={onDelete}>
                {m.training_plan_delete()}
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {plan.description && (
            <p className="text-sm text-muted-foreground">{plan.description}</p>
          )}

          <div className="flex flex-wrap gap-2">
            <Badge variant="secondary">
              {weeks.length} {m.training_plan_weeks()}
            </Badge>
            {currentWeek && (
              <Badge variant="secondary">
                {m.training_plan_week()} {currentWeek.weekNumber} /{' '}
                {weeks.length}
              </Badge>
            )}
            {plan.raceDate && (
              <Badge variant="secondary">
                {m.training_plan_race_date()}:{' '}
                {plan.raceDate.toLocaleDateString()}
              </Badge>
            )}
          </div>

          {/* Phase timeline. */}
          <div className="flex gap-1">
            {plan.cycles.map((cycle) => (
              <div
                key={cycle.cycleId}
                className="h-2 rounded"
                style={{
                  flexGrow: cycle.weeks.length,
                  backgroundColor: cycle.color ?? '#94a3b8',
                }}
                title={`${cycle.name} — ${cycle.weeks.length} ${m.training_plan_weeks()}`}
              />
            ))}
          </div>
        </CardContent>
      </Card>

      {currentWeek && <WeekCard week={currentWeek} />}

      <AdjustmentsFeed plan={plan} />
    </div>
  );
}

function WeekCard({
  week,
}: {
  week: TrainingPlanDetail['cycles'][number]['weeks'][number];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          {m.training_plan_week()} {week.weekNumber}
          {week.theme ? ` — ${week.theme}` : ''}
        </CardTitle>
        <CardDescription>
          {m.training_plan_weekly_volume()}:{' '}
          {formatDurationShort(week.targetVolume)}
          {week.targetLoad
            ? ` · ${m.training_plan_target_load()}: ${Math.round(week.targetLoad)}`
            : ''}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {week.sessions.map((session) => (
          <div
            key={session.eventId}
            className="flex items-center justify-between rounded-md border p-3"
          >
            <div>
              <p className="font-medium">{session.name}</p>
              <p className="text-sm text-muted-foreground">
                {session.startDate.toLocaleDateString(undefined, {
                  weekday: 'long',
                })}
                {' · '}
                {formatDurationShort(session.training?.goalDuration)}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {session.training?.manuallyEdited && (
                <Badge variant="outline">
                  {m.training_plan_adjusted_manually()}
                </Badge>
              )}
              {session.training?.relatedActivityId !== null && (
                <Badge variant="secondary">✓</Badge>
              )}
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function AdjustmentsFeed({ plan }: { plan: TrainingPlanDetail }) {
  const adjustments = plan.adjustments ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          {m.training_plan_adjustments()}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {adjustments.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {m.training_plan_no_adjustments()}
          </p>
        ) : (
          <div className="space-y-3">
            {adjustments.map((adjustment) => (
              <div
                key={adjustment.trainingPlanAdjustmentId}
                className="rounded-md border p-3"
              >
                <div className="flex items-center justify-between">
                  <Badge variant="outline">{adjustment.trigger}</Badge>
                  <span className="text-xs text-muted-foreground">
                    {new Date(adjustment.createdAt).toLocaleDateString()}
                  </span>
                </div>
                <p className="mt-2 text-sm">{adjustment.reason}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {adjustment.automatic
                    ? m.training_plan_adjusted_automatically()
                    : m.training_plan_adjusted_manually()}
                </p>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
