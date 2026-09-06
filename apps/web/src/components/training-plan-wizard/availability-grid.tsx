import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/utils/shadcn';

import {
  AVAILABILITY_PRIORITY,
  AthleteAvailabilitySlot,
} from '@openathlete/shared';

/**
 * Weekly availability editor.
 *
 * Deliberately simple: one optional window per day. The plan generator only
 * needs to know which days work and roughly when, and asking for more than
 * that in a setup wizard is how people abandon setup wizards. Athletes with
 * more complex weeks can add extra windows through the API.
 */

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const DEFAULT_START = '07:00';
const DEFAULT_END = '09:00';

type Props = {
  value: AthleteAvailabilitySlot[];
  onChange: (slots: AthleteAvailabilitySlot[]) => void;
};

export function AvailabilityGrid({ value, onChange }: Props) {
  const byDay = new Map(value.map((slot) => [slot.dayOfWeek, slot]));

  const toggleDay = (dayOfWeek: number) => {
    if (byDay.has(dayOfWeek)) {
      onChange(value.filter((slot) => slot.dayOfWeek !== dayOfWeek));
      return;
    }

    onChange(
      [
        ...value,
        {
          dayOfWeek,
          startTime: DEFAULT_START,
          endTime: DEFAULT_END,
          priority: AVAILABILITY_PRIORITY.MEDIUM,
        },
      ].sort((a, b) => a.dayOfWeek - b.dayOfWeek),
    );
  };

  const updateSlot = (
    dayOfWeek: number,
    patch: Partial<AthleteAvailabilitySlot>,
  ) => {
    onChange(
      value.map((slot) =>
        slot.dayOfWeek === dayOfWeek ? { ...slot, ...patch } : slot,
      ),
    );
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {DAY_LABELS.map((label, dayOfWeek) => (
          <Button
            key={label}
            type="button"
            size="sm"
            variant={byDay.has(dayOfWeek) ? 'default' : 'outline'}
            className={cn('w-14')}
            onClick={() => toggleDay(dayOfWeek)}
          >
            {label}
          </Button>
        ))}
      </div>

      {value.length > 0 && (
        <div className="space-y-2">
          {value.map((slot) => (
            <div
              key={slot.dayOfWeek}
              className="flex items-center gap-2 text-sm"
            >
              <span className="w-12 text-muted-foreground">
                {DAY_LABELS[slot.dayOfWeek]}
              </span>
              <Input
                type="time"
                className="w-28"
                value={slot.startTime}
                onChange={(event) =>
                  updateSlot(slot.dayOfWeek, { startTime: event.target.value })
                }
              />
              <span className="text-muted-foreground">–</span>
              <Input
                type="time"
                className="w-28"
                value={slot.endTime}
                onChange={(event) =>
                  updateSlot(slot.dayOfWeek, { endTime: event.target.value })
                }
              />
              <Button
                type="button"
                size="sm"
                variant={
                  slot.priority === AVAILABILITY_PRIORITY.HIGH
                    ? 'default'
                    : 'ghost'
                }
                onClick={() =>
                  updateSlot(slot.dayOfWeek, {
                    priority:
                      slot.priority === AVAILABILITY_PRIORITY.HIGH
                        ? AVAILABILITY_PRIORITY.MEDIUM
                        : AVAILABILITY_PRIORITY.HIGH,
                  })
                }
                title="Mark this as a day with plenty of time - long runs go here"
              >
                ★
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function AvailabilityGridField({
  label,
  hint,
  ...props
}: Props & { label: string; hint?: string }) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      <AvailabilityGrid {...props} />
    </div>
  );
}
