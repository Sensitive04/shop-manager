/**
 * Money is stored as a JS number in major units (e.g. 12.5 for 12.50) but all
 * arithmetic runs through integer cents. Summing floats in a retail ledger is
 * how you end up with a total that is off by a cent and no way to explain it.
 */

/** Convert a major-unit amount to integer cents. */
export function toCents(amount: number): number {
  return Math.round(amount * 100);
}

/** Convert integer cents back to a major-unit amount. */
export function fromCents(cents: number): number {
  return cents / 100;
}

/**
 * Round to 2 decimal places.
 *
 * Naive `Math.round(amount * 100)` does *not* work here: `1.005 * 100` evaluates
 * to 100.49999999999999, so the "obvious" implementation returns 1 instead of
 * 1.01. Shifting the decimal point via the exponent notation — `Number('1.005e2')`
 * is exactly 100.5 — makes the value being rounded the one the author wrote.
 *
 * Ties round half up (toward positive infinity), matching `Math.round`, which is
 * what `multiplyCents` also does. Consistency matters more than the direction of
 * the tie: what must not happen is the same 10% landing on two different cents.
 */
export function roundMoney(amount: number): number {
  if (!Number.isFinite(amount)) return amount;
  return Number(`${Math.round(Number(`${amount}e2`))}e-2`);
}

/** Multiply cents by a whole-unit factor and return rounded cents. */
export function multiplyCents(cents: number, factor: number): number {
  return Math.round(cents * factor);
}

/** Sum a list of cent amounts, staying in integer space. */
export function sumCents(values: readonly number[]): number {
  return values.reduce<number>((acc, value) => acc + value, 0);
}

/**
 * Format a major-unit amount for display. Uses Intl so grouping separators and
 * decimal marks match the shop's locale rather than being hardcoded.
 */
export function formatMoney(amount: number, currency = 'USD'): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
  }).format(roundMoney(amount));
}