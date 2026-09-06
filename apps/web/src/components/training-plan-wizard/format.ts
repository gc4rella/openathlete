/**
 * Formatting helpers shared by the plan wizard and the plan view.
 */

/** Seconds to "5h 30min" / "45min". */
export function formatDurationShort(
  seconds: number | null | undefined,
): string {
  if (!seconds || seconds <= 0) {
    return '—';
  }

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);

  if (hours === 0) {
    return `${minutes}min`;
  }

  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}min`;
}

/** Seconds to a race clock, "3:29:41". */
export function formatFinishTime(seconds: number | null | undefined): string {
  if (!seconds || seconds <= 0) {
    return '—';
  }

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = Math.round(seconds % 60);

  return `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

/** "3:30" or "3:30:00" to seconds; null when unparseable. */
export function parseFinishTime(value: string): number | null {
  const parts = value.trim().split(':');

  if (parts.length < 2 || parts.length > 3) {
    return null;
  }

  const numbers = parts.map((part) => Number.parseInt(part, 10));

  if (numbers.some((n) => Number.isNaN(n) || n < 0)) {
    return null;
  }

  const [hours, minutes, seconds = 0] = numbers;

  return hours * 3600 + minutes * 60 + seconds;
}

export function formatDateInput(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');

  return `${year}-${month}-${day}`;
}

/** Common race distances, in meters. */
export const RACE_DISTANCES = [
  { label: '5 km', meters: 5000 },
  { label: '10 km', meters: 10000 },
  { label: 'Half marathon', meters: 21097 },
  { label: 'Marathon', meters: 42195 },
  { label: '50 km', meters: 50000 },
  { label: '100 km', meters: 100000 },
];
