import {
  useAthleteAvailabilityQuery,
  useSetAthleteAvailabilityMutation,
} from '@/api/athlete-availability';
import {
  PlanPreview as PlanPreviewData,
  useChatGptPlannerLoginMutation,
  useChatGptPlannerProviderQuery,
  useCreateTrainingPlanMutation,
  usePreviewTrainingPlanMutation,
  useTrainingPlanIntakeMutation,
} from '@/api/training-plan';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Loader } from '@/components/ui/loader';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { m } from '@/paraglide/messages';
import { getLocale } from '@/paraglide/runtime';
import { Bot, ExternalLink, Send, Sparkles, UserRound } from 'lucide-react';
import { KeyboardEvent, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import {
  AthleteAvailabilitySlot,
  PLAN_GOAL_KIND,
  PlanGenerationInput,
  PlanIntakeDraft,
  PlanIntakeMessage,
  SPORT_TYPE,
} from '@openathlete/shared';

import { AvailabilityGridField } from './availability-grid';
import {
  RACE_DISTANCES,
  formatDateInput,
  formatFinishTime,
  parseFinishTime,
} from './format';
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

type Step = 'chat' | 'goal' | 'schedule' | 'preview';

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
  const [step, setStep] = useState<Step>('chat');
  const [preview, setPreview] = useState<PlanPreviewData | null>(null);
  const [intakeMessages, setIntakeMessages] = useState<PlanIntakeMessage[]>([]);
  const [intakeText, setIntakeText] = useState('');
  const [intakeDraft, setIntakeDraft] = useState<PlanIntakeDraft | null>(null);

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
  const [planName, setPlanName] = useState<string | null>(null);
  const [availability, setAvailability] = useState<AthleteAvailabilitySlot[]>(
    [],
  );

  const { data: existingAvailability } = useAthleteAvailabilityQuery(athleteId);
  const setAvailabilityMutation = useSetAthleteAvailabilityMutation();
  const plannerLoginMutation = useChatGptPlannerLoginMutation({
    onError: (error) => toast.error(planIntakeError(error.message)),
  });
  const plannerProviderQuery = useChatGptPlannerProviderQuery(
    open,
    plannerLoginMutation.isSuccess,
  );
  const plannerConnected = plannerProviderQuery.data?.connected === true;

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
      planName,
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
    planName,
  ]);

  const intakeMutation = useTrainingPlanIntakeMutation({
    onSuccess: (data) => {
      setIntakeDraft(data.draft);
      setIntakeMessages((messages) => [
        ...messages,
        { role: 'assistant', content: data.message },
      ]);
    },
    onError: (error) => toast.error(planIntakeError(error.message)),
  });

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
    setStep('chat');
    setPreview(null);
    setIntakeMessages([]);
    setIntakeText('');
    setIntakeDraft(null);
    plannerLoginMutation.reset();
    onClose();
  };

  const sendIntakeMessage = () => {
    const content = intakeText.trim();
    if (!content || intakeMutation.isPending) return;

    const messages: PlanIntakeMessage[] = [
      ...intakeMessages,
      { role: 'user', content },
    ];
    setIntakeMessages(messages);
    setIntakeText('');
    intakeMutation.mutate({
      body: {
        messages,
        language: getLocale().toUpperCase() as 'EN' | 'FR' | 'IT',
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
      athleteId,
    });
  };

  const applyIntakeDraft = () => {
    if (!intakeDraft) return;

    if (intakeDraft.goalKind) setGoalKind(intakeDraft.goalKind);
    if (intakeDraft.startDate) setStartDate(intakeDraft.startDate);
    if (intakeDraft.raceDate) setRaceDate(intakeDraft.raceDate);
    if (intakeDraft.targetDistance)
      setTargetDistance(String(intakeDraft.targetDistance));
    setGoalTime(
      intakeDraft.targetTime ? formatFinishTime(intakeDraft.targetTime) : '',
    );
    if (intakeDraft.durationWeeks)
      setDurationWeeks(String(intakeDraft.durationWeeks));
    if (intakeDraft.daysPerWeek)
      setDaysPerWeek(String(intakeDraft.daysPerWeek));
    if (intakeDraft.longRunDay !== null)
      setLongRunDay(String(intakeDraft.longRunDay));
    if (intakeDraft.currentWeeklyVolume)
      setWeeklyHours((intakeDraft.currentWeeklyVolume / 3600).toFixed(1));
    setIncludeCrossTraining(intakeDraft.includeCrossTraining);
    setInjuryAware(intakeDraft.injuryAware);
    setPlanName(intakeDraft.planName);
    setStep('schedule');
  };

  const handleIntakeKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendIntakeMessage();
    }
  };

  const generate = async () => {
    if (!input) {
      toast.error(m.training_plan_generate_failed());
      return;
    }

    try {
      await setAvailabilityMutation.mutateAsync({
        body: { slots: availability },
        athleteId,
      });
    } catch {
      toast.error(m.training_plan_generate_failed());
      return;
    }

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
          <DialogDescription className="sr-only">
            {m.training_plan_none_description()}
          </DialogDescription>
        </DialogHeader>

        {step === 'chat' && (
          <div className="space-y-4">
            <div className="rounded-lg border bg-muted/30 p-3 text-sm">
              <div className="mb-1 flex items-center gap-2 font-medium">
                <Sparkles className="h-4 w-4 text-primary" />
                {m.training_plan_ai_title()}
              </div>
              <p className="text-muted-foreground">
                {m.training_plan_ai_description()}
              </p>
            </div>

            {!plannerConnected && (
              <div className="space-y-3 rounded-lg border p-3 text-sm">
                <p className="font-medium">
                  {m.training_plan_chatgpt_connect_title()}
                </p>
                <p className="text-muted-foreground">
                  {plannerProviderMessage(plannerProviderQuery.data)}
                </p>

                {plannerLoginMutation.data ? (
                  <div className="space-y-2">
                    <div className="rounded-md bg-muted px-3 py-2 text-center font-mono text-lg font-semibold tracking-widest">
                      {plannerLoginMutation.data.userCode}
                    </div>
                    <Button asChild type="button" className="w-full">
                      <a
                        href={plannerLoginMutation.data.verificationUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {m.training_plan_chatgpt_open_login()}
                        <ExternalLink className="ml-2 h-4 w-4" />
                      </a>
                    </Button>
                    <p className="text-xs text-muted-foreground">
                      {m.training_plan_chatgpt_waiting()}
                    </p>
                  </div>
                ) : (
                  <Button
                    type="button"
                    onClick={() => plannerLoginMutation.mutate()}
                    disabled={
                      plannerProviderQuery.isPending ||
                      plannerLoginMutation.isPending ||
                      !plannerProviderQuery.data?.enabled ||
                      !plannerProviderQuery.data?.available
                    }
                  >
                    {plannerLoginMutation.isPending && (
                      <Loader size="sm" className="mr-2" />
                    )}
                    {m.training_plan_chatgpt_connect()}
                  </Button>
                )}
              </div>
            )}

            {plannerConnected && (
              <p className="text-xs text-muted-foreground">
                {m.training_plan_chatgpt_connected({
                  plan: plannerProviderQuery.data?.planType || 'ChatGPT',
                })}
              </p>
            )}

            <div
              className="max-h-[38vh] min-h-52 space-y-3 overflow-y-auto rounded-lg border p-3"
              aria-live="polite"
            >
              <ChatMessage
                role="assistant"
                content={m.training_plan_ai_greeting()}
              />
              {intakeMessages.map((message, index) => (
                <ChatMessage
                  key={`${message.role}-${index}`}
                  role={message.role}
                  content={message.content}
                />
              ))}
              {intakeMutation.isPending && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader size="sm" /> {m.training_plan_ai_thinking()}
                </div>
              )}
            </div>

            <div className="flex items-end gap-2">
              <Textarea
                value={intakeText}
                onChange={(event) => setIntakeText(event.target.value)}
                onKeyDown={handleIntakeKeyDown}
                placeholder={m.training_plan_ai_placeholder()}
                disabled={intakeMutation.isPending || !plannerConnected}
                className="max-h-32 min-h-16 resize-none"
              />
              <Button
                type="button"
                size="icon"
                className="h-16 w-16 shrink-0"
                onClick={sendIntakeMessage}
                disabled={
                  !plannerConnected ||
                  !intakeText.trim() ||
                  intakeMutation.isPending
                }
                aria-label={m.training_plan_ai_send()}
              >
                <Send className="h-5 w-5" />
              </Button>
            </div>

            <div className="flex items-center justify-between gap-3">
              <Button
                type="button"
                variant="ghost"
                onClick={() => setStep('goal')}
              >
                {m.training_plan_manual_setup()}
              </Button>
              <Button
                type="button"
                onClick={applyIntakeDraft}
                disabled={
                  intakeMutation.isPending ||
                  !intakeDraft ||
                  !intakeMutation.data?.ready
                }
              >
                {m.training_plan_review_details()}
              </Button>
            </div>
          </div>
        )}

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
                      {!RACE_DISTANCES.some(
                        (distance) =>
                          String(distance.meters) === targetDistance,
                      ) &&
                        Number(targetDistance) > 0 && (
                          <SelectItem value={targetDistance}>
                            {Number(targetDistance) / 1000} km
                          </SelectItem>
                        )}
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
  if (message.includes('BASELINE_REQUIRED'))
    return 'Add recent weekly training volume before generating a marathon plan.';
  if (message.includes('AVAILABILITY_CONFLICT'))
    return 'Your training days do not fit the availability windows you entered.';
  if (message.includes('PREPARATION_TOO_SHORT'))
    return 'A race plan needs at least four weeks of preparation.';
  return message || m.training_plan_generate_failed();
}

function planIntakeError(message: string) {
  if (message.includes('CHATGPT_PLANNER_DISABLED'))
    return m.training_plan_chatgpt_disabled();
  if (message.includes('CHATGPT_PLANNER_RUNTIME_UNAVAILABLE'))
    return m.training_plan_chatgpt_runtime_unavailable();
  if (message.includes('CHATGPT_PLANNER_AUTH_REQUIRED'))
    return m.training_plan_chatgpt_auth_required();
  return message || m.training_plan_ai_failed();
}

function plannerProviderMessage(
  status:
    | {
        enabled: boolean;
        available: boolean;
      }
    | undefined,
) {
  if (!status) return m.training_plan_chatgpt_checking();
  if (!status.enabled) return m.training_plan_chatgpt_disabled();
  if (!status.available) return m.training_plan_chatgpt_runtime_unavailable();
  return m.training_plan_chatgpt_connect_description();
}

function ChatMessage({
  role,
  content,
}: {
  role: PlanIntakeMessage['role'];
  content: string;
}) {
  const assistant = role === 'assistant';

  return (
    <div
      className={`flex gap-2 ${assistant ? 'justify-start' : 'justify-end'}`}
    >
      {assistant && (
        <div className="mt-1 rounded-full bg-primary/10 p-1.5 text-primary">
          <Bot className="h-4 w-4" />
        </div>
      )}
      <div
        className={`max-w-[85%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm ${
          assistant ? 'bg-muted' : 'bg-primary text-primary-foreground'
        }`}
      >
        {content}
      </div>
      {!assistant && (
        <div className="mt-1 rounded-full bg-muted p-1.5">
          <UserRound className="h-4 w-4" />
        </div>
      )}
    </div>
  );
}
