import { buildWeekWindows } from './plan-materialization.service';

/**
 * The week window builder decides which calendar days each training week
 * covers, and therefore which day every session lands on.
 */
describe('buildWeekWindows', () => {
  it('produces the requested number of consecutive weeks', () => {
    const windows = buildWeekWindows(new Date(2026, 0, 5), 16);

    expect(windows).toHaveLength(16);

    for (let i = 1; i < windows.length; i++) {
      // Each week starts the day after the previous one ends.
      const previousEnd = windows[i - 1].end;
      const gapMs = windows[i].start.getTime() - previousEnd.getTime();

      expect(gapMs).toBeGreaterThan(0);
      expect(gapMs).toBeLessThan(2 * 60 * 60 * 1000);
    }
  });

  it('starts every week on the same weekday, across daylight saving changes', () => {
    // A 16 week block from early September crosses the autumn clock change in
    // every European and North American timezone. Advancing by a fixed
    // 7 x 86_400_000 ms loses an hour there and rolls the week back onto the
    // previous day, which silently moves race day a week early.
    const start = new Date(2026, 8, 7); // Monday 7 September 2026
    const windows = buildWeekWindows(start, 16);

    for (const window of windows) {
      expect(window.start.getDay()).toBe(start.getDay());
      expect(window.start.getHours()).toBe(0);
      expect(window.start.getMinutes()).toBe(0);
    }
  });

  it('spans a spring clock change without drifting either', () => {
    const start = new Date(2026, 1, 2); // Monday 2 February 2026
    const windows = buildWeekWindows(start, 20);

    for (const window of windows) {
      expect(window.start.getDay()).toBe(start.getDay());
    }
  });

  it('covers exactly seven days per week', () => {
    const windows = buildWeekWindows(new Date(2026, 8, 7), 16);

    for (const window of windows) {
      expect(window.end.getDay()).toBe((window.start.getDay() + 6) % 7);
      expect(window.end.getHours()).toBe(23);
    }
  });

  it('places the final week so it contains the race day', () => {
    // 7 September to 27 December is 16 weeks; the race must fall in week 16.
    const start = new Date(2026, 8, 7);
    const raceDate = new Date(2026, 11, 27);
    const windows = buildWeekWindows(start, 16);
    const last = windows[windows.length - 1];

    expect(last.start.getTime()).toBeLessThanOrEqual(raceDate.getTime());
    expect(last.end.getTime()).toBeGreaterThanOrEqual(raceDate.getTime());
  });
});
