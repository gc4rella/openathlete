/** Date-only plan values use UTC midnight as a carrier, never the host timezone. */
export function calendarDate(value: Date | string): string {
  return new Date(value).toISOString().slice(0, 10);
}

export function addCalendarDays(value: Date | string, days: number): string {
  const date = new Date(`${calendarDate(value)}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return calendarDate(date);
}

export function dateInTimeZone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const part = (type: string) => parts.find((item) => item.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function isTimeZone(value: string): boolean {
  try { new Intl.DateTimeFormat('en', { timeZone: value }).format(); return true; }
  catch { return false; }
}

/** Resolve local wall time, rejecting nonexistent spring-forward times. */
export function zonedDateTime(day: string, time: string, timeZone: string): Date {
  const target = Date.parse(`${day}T${time}:00Z`);
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  let instant = target;
  for (let index = 0; index < 5; index++) {
    const parts = formatter.formatToParts(new Date(instant));
    const p = (type: string) => parts.find((item) => item.type === type)?.value;
    const wall = Date.parse(`${p('year')}-${p('month')}-${p('day')}T${p('hour')}:${p('minute')}:${p('second')}Z`);
    if (wall === target) return new Date(instant);
    instant += target - wall;
  }
  throw new Error(`The time ${time} on ${day} does not exist in ${timeZone}`);
}
