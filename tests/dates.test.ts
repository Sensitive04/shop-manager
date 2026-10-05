import { describe, expect, it } from 'vitest';

import {
  addDays,
  daysUntil,
  endOfDay,
  expiryCutoff,
  parseLocalDate,
  startOfDay,
  toDate,
  toDateInputValue,
  toDisplayDate,
} from '@/lib/dates';

describe('daysUntil', () => {
  it('counts whole days between date boundaries', () => {
    expect(daysUntil(new Date(2026, 0, 1), new Date(2026, 0, 31))).toBe(30);
  });

  it('is 0 for the same calendar day regardless of the time of day', () => {
    expect(daysUntil(new Date(2026, 5, 1, 0, 1), new Date(2026, 5, 1, 23, 59))).toBe(0);
  });

  it('goes negative once the date has passed', () => {
    expect(daysUntil(new Date(2026, 0, 10), new Date(2026, 0, 4))).toBe(-6);
  });

  it('crosses a month boundary correctly', () => {
    expect(daysUntil(new Date(2026, 0, 30), new Date(2026, 1, 2))).toBe(3);
  });
});

describe('expiryCutoff', () => {
  it('is local midnight on the day the window closes', () => {
    const cutoff = expiryCutoff(new Date(2026, 2, 15, 18, 30), 30);

    expect(cutoff.getHours()).toBe(0);
    expect(cutoff.getMinutes()).toBe(0);
    expect(cutoff.getDate()).toBe(14);
    expect(cutoff.getMonth()).toBe(3);
  });

  it('stays on local midnight across a daylight-saving change', () => {
    // Sydney leaves daylight saving on 5 April 2026. Adding 24h periods in
    // milliseconds put this cutoff at 23:00 on the day before, which dropped any
    // batch expiring exactly on the 4th.
    const cutoff = expiryCutoff(new Date(2026, 2, 15, 9), 20);

    expect(cutoff.getHours()).toBe(0);
    expect(cutoff.getDate()).toBe(4);
    expect(cutoff.getMonth()).toBe(3);
  });

  it('includes an already-expired batch at a zero window', () => {
    const cutoff = expiryCutoff(new Date(2026, 2, 15, 9), 0);
    const expired = new Date(2026, 2, 14);

    expect(expired.getTime()).toBeLessThanOrEqual(cutoff.getTime());
  });

  it('includes a batch expiring exactly on the cutoff day', () => {
    const cutoff = expiryCutoff(new Date(2026, 2, 15, 9), 30);
    const expiresOnCutoff = new Date(2026, 3, 14);

    expect(expiresOnCutoff.getTime()).toBeLessThanOrEqual(cutoff.getTime());
  });
});

describe('startOfDay / addDays', () => {
  it('zeroes the time component without mutating the argument', () => {
    const original = new Date(2026, 4, 9, 17, 45, 12);
    const start = startOfDay(original);

    expect(start.getHours()).toBe(0);
    expect(start.getMinutes()).toBe(0);
    expect(start.getSeconds()).toBe(0);
    expect(original.getHours()).toBe(17);
  });

  it('advances the calendar date and keeps the time of day', () => {
    const base = new Date(2026, 4, 9, 12);
    const later = addDays(base, 10);

    expect(later.getDate()).toBe(19);
    expect(later.getMonth()).toBe(4);
    // Local wall clock is preserved; the elapsed milliseconds may be 10 * 24h
    // plus or minus an hour if the span crosses a daylight-saving change.
    expect(later.getHours()).toBe(12);
  });

  it('steps exactly one calendar day across a daylight-saving transition', () => {
    // Sydney leaves daylight saving on 5 April 2026; UTC-5 leaves it on 8 March.
    // Whatever the host zone, adding one day must land on the next date at the
    // same wall-clock time, not 23:00 or 01:00.
    for (const start of [new Date(2026, 2, 7), new Date(2026, 3, 4)]) {
      const next = addDays(start, 1);

      expect(next.getDate()).toBe(start.getDate() + 1);
      expect(next.getMonth()).toBe(start.getMonth());
      expect(next.getHours()).toBe(start.getHours());
    }
  });

  it('rolls over into the next month', () => {
    expect(addDays(new Date(2026, 0, 30), 5).getMonth()).toBe(1);
  });

  it('handles a negative offset without mutating the argument', () => {
    const base = new Date(2026, 4, 9, 12, 30);
    const earlier = addDays(base, -9);

    expect(earlier.getDate()).toBe(30);
    expect(earlier.getMonth()).toBe(3);
    expect(earlier.getHours()).toBe(12);
    expect(base.getDate()).toBe(9);
  });
});

describe('toDate', () => {
  it('accepts a Date, an ISO string and epoch millis', () => {
    const iso = '2026-03-01T00:00:00.000Z';

    expect(toDate(new Date(iso))?.toISOString()).toBe(iso);
    expect(toDate(iso)?.toISOString()).toBe(iso);
    expect(toDate(new Date(iso).getTime())?.toISOString()).toBe(iso);
  });

  it('reads a date-only string as a local calendar day', () => {
    // UTC midnight would show as the previous day west of Greenwich.
    expect(toDate('2026-03-01')?.getDate()).toBe(1);
  });

  it('returns null for anything unusable', () => {
    expect(toDate('not a date')).toBeNull();
    expect(toDate(new Date('nope'))).toBeNull();
    expect(toDate('2026-02-31')).toBeNull();
    expect(toDate(null)).toBeNull();
    expect(toDate(undefined)).toBeNull();
    expect(toDate({})).toBeNull();
  });
});

describe('parseLocalDate / endOfDay', () => {
  it('parses YYYY-MM-DD as a local calendar date, not UTC midnight', () => {
    const parsed = parseLocalDate('2026-01-31');

    expect(parsed).not.toBeNull();
    expect(parsed?.getFullYear()).toBe(2026);
    expect(parsed?.getMonth()).toBe(0);
    expect(parsed?.getDate()).toBe(31);
    expect(parsed?.getHours()).toBe(0);
  });

  it('returns null for non-date-only input so callers can fall back', () => {
    expect(parseLocalDate('2026-01-31T10:00:00.000Z')).toBeNull();
    expect(parseLocalDate('31/01/2026')).toBeNull();
    expect(parseLocalDate('')).toBeNull();
  });

  it('rejects a day that does not exist rather than rolling it forward', () => {
    // `new Date(2026, 1, 31)` would quietly become 3 March.
    expect(parseLocalDate('2026-02-31')).toBeNull();
    expect(parseLocalDate('2026-13-01')).toBeNull();
  });

  it('accepts a real leap day', () => {
    expect(parseLocalDate('2028-02-29')?.getDate()).toBe(29);
  });

  it('widens a local day to its last instant without mutating the argument', () => {
    const midnight = new Date(2026, 0, 31);
    const end = endOfDay(midnight);

    expect(end.getDate()).toBe(31);
    expect(end.getHours()).toBe(23);
    expect(end.getMinutes()).toBe(59);
    expect(end.getSeconds()).toBe(59);
    expect(end.getMilliseconds()).toBe(999);
    expect(midnight.getHours()).toBe(0);
  });

  it('keeps a whole local day inside one calendar day', () => {
    // The bug this guards: widening UTC midnight with setHours() produced the
    // *previous* local day in any negative-offset timezone, dropping the last
    // hours of the day from ledger reports.
    const start = startOfDay(parseLocalDate('2026-01-31') as Date);
    const end = endOfDay(parseLocalDate('2026-01-31') as Date);

    expect(start.toDateString()).toBe(end.toDateString());
    expect(end.getTime()).toBeGreaterThan(start.getTime());
    // Not exactly 24h: a daylight-saving transition makes some days 23 or 25
    // hours long, and the boundary still has to stay inside the one calendar day.
    const span = end.getTime() - start.getTime();
    expect(span).toBeGreaterThan(23 * 60 * 60 * 1000);
    expect(span).toBeLessThanOrEqual(25 * 60 * 60 * 1000);
  });
});

describe('date formatting for inputs', () => {
  it('emits YYYY-MM-DD in local time, padded', () => {
    expect(toDateInputValue(new Date(2026, 0, 5))).toBe('2026-01-05');
  });

  it('round-trips through the input value format', () => {
    const date = new Date(2026, 10, 27);
    const parsed = toDate(toDateInputValue(date));

    expect(parsed).not.toBeNull();
    expect(parsed?.getDate()).toBe(27);
  });

  it('renders a readable display date', () => {
    expect(toDisplayDate(new Date(2026, 0, 5))).toBe('Jan 5, 2026');
  });
});
