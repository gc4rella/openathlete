import {
  useAthleteAvailabilityQuery,
  useSetAthleteAvailabilityMutation,
} from '@/api/athlete-availability';
import {
  PlanPreview as PlanPreviewData,
  useCreateTrainingPlanMutation,
  usePreviewTrainingPlanMutation,
} from '@/api/training-plan';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { m } from '@/paraglide/messages';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import {
  AthleteAvailabilitySlot,
  PLAN_GOAL_KIND,
  PlanGenerationInput,
  SPORT_TYPE,
} from '@openathlete/shared';

import { AvailabilityGridField } from './availability-grid';
import { RACE_DISTANCES, formatDateInput, parseFinishTime } from './format';
import { PlanPreview } from './plan-preview';

/**
 * Plan wizard
 *
 * Three steps: what you are training for, what your week looks like, and a
 * preview you can re-roll before committing.
 *
 * The preview step is the important one. Generating without saving is cheap
 * and deterministic, so an athlete can look at the actual weeks before a
 * single row is written to their calendar.
 */

type Step = 'goal' | 'schedule' | 'preview';

const DAY_OPTIONS = [
  { value: '0', label: 'Sunday' },
  { value: '1', label: 'Monday' },
  { value: '2', label: 'Tuesday' },
  { value: '3', label: 'Wednesday' },
  { value: '4', label: 'Thursday' },
  { value: '5', label: 'Friday' },
  { value: '6', label: 'Saturday' },
];

type Props = {
  open: boolean;
  onClose: () => void;
  athleteId?: number;
  /** Weekly volume in seconds, read from the athlete's real recent training */
  suggestedWeeklyVolume?: number | null;
};

export function TrainingPlanWizard({
  open,
  onClose,
  athleteId,
  suggestedWeeklyVolume,
}: Props) {
  const [step, setStep] = useState<Step>('goal');
  const [preview, setPreview] = useState<PlanPreviewData | null>(null);

  const [goalKind, setGoalKind] = useState<PLAN_GOAL_KIND>(PLAN_GOAL_KIND.RACE);
  const [targetDistance, setTargetDistance] = useState('42195');
  const [raceDate, setRaceDate] = useState('');
  const [goalTime, setGoalTime] = useState('');
  const [durationWeeks, setDurationWeeks] = useState('12');
  const [startDate, setStartDate] = useState(formatDateInput(new Date()));
  const [daysPerWeek, setDaysPerWeek] = useState('4');
  const [longRunDay, setLongRunDay] = useState('0');
  const [weeklyHours, setWeeklyHours] = useState('');
  const [injuryAware, setInjuryAware] = useState(true);
  const [includeCrossTraining, setIncludeCrossTraining] = useState(false);
  const [availability, setAvailability] = useState<AthleteAvailabilitySlot[]>(
    [],
  );

  const { data: existingAvailability } = useAthleteAvailabilityQuery(athleteId);
  const setAvailabilityMutation = useSetAthleteAvailabilityMutation();

  // Start from what the athlete already told us, and from what they have
  // actually been running, rather than from an empty form.
  useEffect(() => {
    if (existingAvailability && existingAvailability.length > 0) {
      setAvailability(
        existingAvailability.map((slot) => ({
          dayOfWeek: slot.dayOfWeek,
          startTime: slot.startTime,
          endTime: slot.endTime,
          priority: slot.priority,
        })),
      );
    }
  }, [existingAvailability]);

  useEffect(() => {
    if (suggestedWeeklyVolume && weeklyHours === '') {
      setWeeklyHours((suggestedWeeklyVolume / 3600).toFixed(1));
    }
  }, [suggestedWeeklyVolume, weeklyHours]);

  const input: PlanGenerationInput | null = useMemo(() => {
    const start = new Date(`${startDate}T00:00:00Z`);

    if (Number.isNaN(start.getTime())) {
      return null;
    }

    const isRace = goalKind === PLAN_GOAL_KIND.RACE;
    const race = raceDate ? new Date(`${raceDate}T00:00:00Z`) : null;

    if (isRace && (!race || Number.isNaN(race.getTime()))) {
      return null;
    }

    const hours = Number.parseFloat(weeklyHours);

    return {
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      goalKind,
      sport: SPORT_TYPE.RUNNING,
      startDate: start,
      raceDate: isRace ? race : null,
      targetDistance: isRace ? Number(targetDistance) : null,
      targetTime: goalTime ? parseFinishTime(goalTime) : null,
      durationWeeks: isRace ? null : Number(durationWeeks),
      daysPerWeek: Number(daysPerWeek),
      longRunDay: Number(longRunDay),
      currentWeeklyVolume: Number.isFinite(hours) ? hours * 3600 : null,
      includeCrossTraining,
      injuryAware,
      planName: null,
    };
  }, [
    goalKind,
    startDate,
    raceDate,
    targetDistance,
    goalTime,
    durationWeeks,
    daysPerWeek,
    longRunDay,
    weeklyHours,
    includeCrossTraining,
    injuryAware,
  ]);

  const previewMutation = usePreviewTrainingPlanMutation({
    onSuccess: (data) => {
      setPreview(data);
      setStep('preview');
    },
    onError: (error) => toast.error(planError(error.message)),
  });

  const createMutation = useCreateTrainingPlanMutation({
    onSuccess: () => {
      toast.success(m.training_plan_created());
      handleClose();
    },
    onError: (error) => toast.error(planError(error.message)),
  });

  const handleClose = () => {
    setStep('goal');
    setPreview(null);
    onClose();
  };

  const generate = async () => {
    if (!input) {
      toast.error(m.training_plan_generate_failed());
      return;
    }

    try {
      await setAvailabilityMutation.mutateAsync({ body: { slots: availability }, athleteId });
    } catch { toast.error(m.training_plan_generate_failed()); return; }

    previewMutation.mutate({ input, athleteId, skipNarrative: true });
  };

  const confirm = () => {
    if (!input) {
      return;
    }

    createMutation.mutate({
      body: { input, activate: true, skipNarrative: true },
      athleteId,
    });
  };

  const isRace = goalKind === PLAN_GOAL_KIND.RACE;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && handleClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{m.training_plan_wizard_title()}</DialogTitle>
        </DialogHeader>

        {step === 'goal' && (
          <div className="space-y-4">
            <div className="flex gap-2">
              <Button
                type="button"
                variant={isRace ? 'default' : 'outline'}
                onClick={() => setGoalKind(PLAN_GOAL_KIND.RACE)}
              >
                {m.training_plan_goal_race()}
              </Button>
              <Button
                type="button"
                variant={!isRace ? 'default' : 'outline'}
                onClick={() => setGoalKind(PLAN_GOAL_KIND.GENERAL_FITNESS)}
              >
                {m.training_plan_goal_fitness()}
              </Button>
            </div>

            <div className="space-y-2">
              <Label>{m.training_plan_start_date()}</Label>
              <Input
                type="date"
                value={startDate}
                onChange={(event) => setStartDate(event.target.value)}
              />
            </div>

            {isRace ? (
              <>
                <div className="space-y-2">
                  <Label>{m.training_plan_race_distance()}</Label>
                  <Select
                    value={targetDistance}
                    onValueChange={setTargetDistance}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {RACE_DISTANCES.map((distance) => (
                        <SelectItem
                          key={distance.meters}
                          value={String(distance.meters)}
                        >
                          {distance.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label>{m.training_plan_race_date()}</Label>
                  <Input
                    type="date"
                    value={raceDate}
                    onChange={(event) => setRaceDate(event.target.value)}
                  />
                </div>

                <div className="space-y-2">
                  <Label>{m.training_plan_goal_time()}</Label>
                  <Input
                    placeholder="3:30:00"
                    value={goalTime}
                    onChange={(event) => setGoalTime(event.target.value)}
                  />
                </div>
              </>
            ) : (
              <div className="space-y-2">
                <Label>{m.training_plan_duration_weeks()}</Label>
                <Input
                  type="number"
                  min={4}
                  max={52}
                  value={durationWeeks}
                  onChange={(event) => setDurationWeeks(event.target.value)}
                />
              </div>
            )}

            <div className="flex justify-end">
              <Button
                type="button"
                disabled={isRace && !raceDate}
                onClick={() => setStep('schedule')}
              >
                {m.training_plan_next()}
              </Button>
            </div>
          </div>
        )}

        {step === 'schedule' && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>{m.training_plan_days_per_week()}</Label>
                <Select value={daysPerWeek} onValueChange={setDaysPerWeek}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {[2, 3, 4, 5, 6, 7].map((days) => (
                      <SelectItem key={days} value={String(days)}>
                        {days}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>{m.training_plan_long_run_day()}</Label>
                <Select value={longRunDay} onValueChange={setLongRunDay}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {DAY_OPTIONS.map((day) => (
                      <SelectItem key={day.value} value={day.value}>
                        {day.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-2">
              <Label>{m.training_plan_current_volume()}</Label>
              <Input
                type="number"
                step="0.5"
                min={0}
                value={weeklyHours}
                onChange={(event) => setWeeklyHours(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                {m.training_plan_current_volume_hint()}
              </p>
            </div>

            <AvailabilityGridField
              label={m.training_plan_availability()}
              hint={m.training_plan_availability_hint()}
              value={availability}
              onChange={setAvailability}
            />

            <div className="space-y-2">
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={injuryAware}
                  onCheckedChange={(checked) =>
                    setInjuryAware(checked === true)
                  }
                />
                {m.training_plan_injury_aware()}
              </label>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={includeCrossTraining}
                  onCheckedChange={(checked) =>
                    setIncludeCrossTraining(checked === true)
                  }
                />
                {m.training_plan_cross_training()}
              </label>
            </div>

            <div className="flex justify-between">
              <Button
                type="button"
                variant="outline"
                onClick={() => setStep('goal')}
              >
                {m.training_plan_back()}
              </Button>
              <Button
                type="button"
                onClick={generate}
                disabled={previewMutation.isPending}
              >
                {m.training_plan_generate()}
              </Button>
            </div>
          </div>
        )}

        {step === 'preview' && preview && (
          <div className="space-y-4">
            <PlanPreview preview={preview} />

            <div className="flex justify-between">
              <Button
                type="button"
                variant="outline"
                onClick={() => setStep('schedule')}
              >
                {m.training_plan_back()}
              </Button>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={generate}
                  disabled={previewMutation.isPending}
                >
                  {m.training_plan_regenerate()}
                </Button>
                <Button
                  type="button"
                  onClick={confirm}
                  disabled={createMutation.isPending}
                >
                  {m.training_plan_confirm()}
                </Button>
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function planError(message: string) {
  if (message.includes('BASELINE_REQUIRED')) return 'Add recent weekly training volume before generating a marathon plan.';
  if (message.includes('AVAILABILITY_CONFLICT')) return 'Your training days do not fit the availability windows you entered.';
  if (message.includes('PREPARATION_TOO_SHORT')) return 'A race plan needs at least four weeks of preparation.';
  return message || m.training_plan_generate_failed();
}
