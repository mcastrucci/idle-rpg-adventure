import { getLocale } from './locale.ts';

/** Locale-aware integer/decimal formatting (`1,200` / `1.200`). */
export function formatNumber(value: number): string {
  return new Intl.NumberFormat(getLocale()).format(value);
}

export function formatDateTime(timestamp: number): string {
  return new Intl.DateTimeFormat(getLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(timestamp));
}

/** Fixed-decimals formatting in the active locale (`12.50` / `12,50`). */
export function formatFixed(value: number, digits: number): string {
  return new Intl.NumberFormat(getLocale(), { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
}

/** Decimal separator of the active locale (`.` or `,`), for numbers that are built from integer pieces. */
export function decimalSeparator(): string {
  return new Intl.NumberFormat(getLocale()).formatToParts(1.1).find((part) => part.type === 'decimal')?.value ?? '.';
}
