/** Expiry and date-window helpers, kept pure so they are trivially testable. */

export const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Whole days from `from` until `to`. Negative when `to` is in the past. */
export function daysUntil(from: Date, to: Date): number {
  // Compare on date boundaries, not raw ms, so a batch expiring "today" reads
  // as 0 days regardless of the current time of day.
  const startOfFrom = startOfDay(from).getTime();
  const startOfTo = startOfDay(to).getTime();
  return Math.round((startOfTo - startOfFrom) / MS_PER_DAY);
}

export function startOfDay(date: Date): Date {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

/**
 * Last representable instant of a local day.
 *
 * `new Date('2026-01-31')` is UTC midnight, which in any timezone west of
 * Greenwich is still 31 January *locally* only after the offset is applied — so
 * widening it with `setHours(23, 59, …)` lands on 30 January and silently drops
 * the last hours of the day from a report. Day boundaries therefore have to be
 * built from a local calendar date, which is what {@link parseLocalDate} and this
 * function are for.
 */
export function endOfDay(date: Date): Date {
  const copy = new Date(date);
  copy.setHours(23, 59, 59, 999);
  return copy;
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True when the string is shaped like `YYYY-MM-DD`, valid or not. */
export function isDateOnly(value: string): boolean {
  return DATE_ONLY.test(value.trim());
}

/**
 * Parse a `YYYY-MM-DD` string as a *local* calendar date.
 *
 * Returns null for anything else, so callers can fall back to `new Date(value)`
 * and keep whatever time-of-day an ISO timestamp carried.
 */
export function parseLocalDate(value: string): Date | null {
  const match = DATE_ONLY.exec(value.trim());
  if (!match) return null;

  const [, year, month, day] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day));

  // Reject overflow such as 2026-02-31, which Date would silently roll forward.
  if (
    date.getFullYear() !== Number(year) ||
    date.getMonth() !== Number(month) - 1 ||
    date.getDate() !== Number(day)
  ) {
    return null;
  }

  return date;
}

/**
 * Parse user-supplied date input (a `Date`, epoch millis or a string).
 *
 * A `YYYY-MM-DD` is read as a local calendar date, and one that is not a real
 * day yields an invalid Date rather than being rolled forward — `new Date(
 * '2026-02-31')` is 3 March, which would quietly report on the wrong period.
 */
export function parseDateInput(value: Date | number | string): Date {
  if (value instanceof Date) return value;

  if (typeof value === 'string' && isDateOnly(value)) {
    return parseLocalDate(value) ?? new Date(Number.NaN);
  }

  return new Date(value);
}

/**
 * Add whole *calendar* days, preserving the local time of day.
 *
 * Adding `n * MS_PER_DAY` in milliseconds instead would drift by an hour across
 * every daylight-saving transition — in Sydney, thirty days on from 15 March
 * lands at 23:00 on 13 April rather than midnight on 14 April, which quietly
 * pulls the expiry cutoff forward and drops a batch that expires on the day the
 * alert window closes.
 */
export function addDays(date: Date, days: number): Date {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy;
}

/**
 * Cutoff date for the "expiring soon" view: anything at or before this instant
 * counts as inside the alert window.
 */
export function expiryCutoff(now: Date, windowDays: number): Date {
  return addDays(startOfDay(now), windowDays);
}

/** Coerce anything date-ish into a Date, or null if it is not a usable date. */
export function toDate(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === 'string' || typeof value === 'number') {
    // Delegates so a date-only string follows the same local-calendar rule as
    // request parsing; a Date instance is already the instant it claims to be.
    const parsed = parseDateInput(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

/** Format a date as YYYY-MM-DD in local time, for <input type="date">. */
export function toDateInputValue(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function toDisplayDate(date: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(date);
}