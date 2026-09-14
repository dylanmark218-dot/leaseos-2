/**
 * Money is integer minor units. These helpers are the only sanctioned way
 * to cross between the older double columns and their integer shadows.
 * Rounding is half away from zero, so a debit and its reversal round the
 * same way; a non-finite input is refused rather than stored as 0.
 */
export function toCents(amount: number | null | undefined, scale = 100): number | null {
  if (amount == null) return null;
  if (!Number.isFinite(amount)) throw new Error(`Not a money amount: ${amount}`);
  const scaled = Math.abs(amount) * scale;
  const rounded = Math.round(scaled + 1e-9);
  return amount < 0 ? -rounded : rounded;
}
export function fromCents(cents: number | null | undefined): number | null {
  if (cents == null) return null;
  return Math.round(cents) / 100;
}
/** The pair must agree to the cent; a disagreement is a finding, never silently taken from either side. */
/** A per-unit rate carries three decimals: its shadow is thousandths. */
export const toMillis = (rate: number | null | undefined) => toCents(rate, 1000);
export function reconcile(amount: number | null, cents: number | null, scale = 100): { agrees: boolean; finding: string | null } {
  if (amount == null && cents == null) return { agrees: true, finding: null };
  if (amount == null || cents == null) return { agrees: false, finding: `one side missing: double=${amount} cents=${cents}` };
  const expect = toCents(amount, scale);
  return expect === cents ? { agrees: true, finding: null } : { agrees: false, finding: `double ${amount} → ${expect} cents, shadow holds ${cents}` };
}
