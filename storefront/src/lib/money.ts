import { minorUnitExponent } from "./format";

/**
 * Admin price-input <-> integer-minor-units conversion. This is the one
 * place a human-typed price string (e.g. "19.99") becomes the integer
 * `moneyMinorUnitsSchema` the product schema requires — and the one place
 * a stored integer is turned back into a string to prefill the edit form.
 *
 * Deliberately does NOT do `Number(input) * 10 ** exponent`: float
 * multiplication is exactly how a price like 19.99 * 100 can land on
 * 1998.9999999999998 instead of 1999. Every conversion here works on the
 * decimal string's digits directly, never on a float, so it cannot drift.
 */

/**
 * Parses a human-entered price string into an integer count of minor units
 * for `currency`. Accepts an optional leading/trailing whitespace, a
 * non-negative integer or decimal with at most `minorUnitExponent(currency)`
 * fractional digits (0 for currencies like JPY). Returns `null` for
 * anything else (empty, negative, too many decimal places, non-numeric,
 * `NaN`/`Infinity` spellings, etc.) — the caller treats `null` as a
 * validation error, never as 0.
 */
export function parsePriceToMinorUnits(input: string, currency: string): number | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const exponent = minorUnitExponent(currency);
  const pattern =
    exponent === 0 ? /^\d+$/ : new RegExp(`^\\d+(?:\\.\\d{1,${exponent}})?$`);
  if (!pattern.test(trimmed)) return null;

  const [wholePartRaw, fractionPartRaw = ""] = trimmed.split(".");
  const fractionPart = fractionPartRaw.padEnd(exponent, "0");
  const combinedDigits = `${wholePartRaw}${fractionPart}`.replace(/^0+(?=\d)/, "");

  // combinedDigits is now a plain non-negative integer string (digits only,
  // no sign, no leading zeros beyond a single "0") — safe to hand to
  // Number() because there is no fractional/scientific notation left in it.
  if (!/^\d+$/.test(combinedDigits)) return null;
  const value = Number(combinedDigits);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * Inverse of `parsePriceToMinorUnits` — formats a stored integer minor-units
 * amount as a plain decimal string suitable for a price `<input>`'s
 * `defaultValue` (no currency symbol/grouping — that's `formatPrice`'s job
 * for display, this is for round-tripping through an editable form field).
 */
export function minorUnitsToPriceInput(amountMinorUnits: number, currency: string): string {
  const exponent = minorUnitExponent(currency);
  if (exponent === 0) return String(amountMinorUnits);

  const digits = String(amountMinorUnits).padStart(exponent + 1, "0");
  const wholePart = digits.slice(0, digits.length - exponent);
  const fractionPart = digits.slice(digits.length - exponent);
  return `${wholePart}.${fractionPart}`;
}
