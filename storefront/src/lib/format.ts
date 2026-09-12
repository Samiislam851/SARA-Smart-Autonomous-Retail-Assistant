/**
 * Money is stored throughout this codebase as an integer number of the
 * currency's minor unit (e.g. cents for USD, paise for INR). Never do
 * float arithmetic on money — convert to a display string only at the
 * last moment, with this helper.
 */

/** Currencies whose minor unit is not 1/100th of the major unit. */
const MINOR_UNIT_EXPONENT: Record<string, number> = {
  JPY: 0,
  KRW: 0,
  VND: 0,
  BHD: 3,
  KWD: 3,
  OMR: 3,
};

/** Exported for `lib/money.ts` (admin price-input <-> minor-units conversion). */
export function minorUnitExponent(currency: string): number {
  return MINOR_UNIT_EXPONENT[currency.toUpperCase()] ?? 2;
}

export interface FormatPriceOptions {
  /** BCP 47 locale for `Intl.NumberFormat`. Defaults to "en-US". */
  locale?: string;
}

/**
 * Formats an integer minor-units amount as a localized currency string.
 *
 * @param amountMinorUnits - integer count of minor units, e.g. 1999 for $19.99
 * @param currency - ISO 4217 code, e.g. "USD"
 *
 * @example
 * formatPrice(1999, "USD") // "$19.99"
 * formatPrice(0, "USD")    // "$0.00"
 * formatPrice(100000, "JPY") // "¥100,000"
 */
export function formatPrice(
  amountMinorUnits: number,
  currency: string,
  options: FormatPriceOptions = {}
): string {
  if (!Number.isInteger(amountMinorUnits)) {
    throw new TypeError(
      `formatPrice expects an integer number of minor units, got ${amountMinorUnits}`
    );
  }

  const exponent = minorUnitExponent(currency);
  const majorUnits = amountMinorUnits / 10 ** exponent;

  return new Intl.NumberFormat(options.locale ?? "en-US", {
    style: "currency",
    currency,
  }).format(majorUnits);
}
