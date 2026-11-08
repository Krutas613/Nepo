/**
 * Display formatting. The sim never formats (player-flow.md section 5): money is integer minor
 * units, quantities are integers, and everything here is a pure function of its input so it can be
 * unit-tested and used in tables without locale surprises (no `Intl`, no wall clock).
 */

export type NegativeStyle = 'minus' | 'parens';

export interface MoneyFormatOptions {
  /** `minus` renders `-$1.00` (default); `parens` renders `($1.00)` as in financial statements. */
  negative?: NegativeStyle;
  /** Currency symbol; `''` omits it (statement columns). Default `$`. */
  symbol?: string;
  /** Show the cents. Default true. */
  cents?: boolean;
}

/** No-break space (a constant, because formatters strip literal ones). */
const NBSP = String.fromCharCode(160);
const MISSING = '—';

/** `1234567` -> `1,234,567`. Input must be a non-negative integer string. */
function groupThousands(digits: string): string {
  let out = '';
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ',';
    out += digits.charAt(i);
  }
  return out;
}

function wrapNegative(body: string, negative: boolean, style: NegativeStyle): string {
  if (!negative) return style === 'parens' ? `${body}${NBSP}` : body;
  return style === 'parens' ? `(${body})` : `-${body}`;
}

/**
 * Integer minor units to `$1,234.56`. `-0` and tiny negatives that round to zero never print a
 * sign. With `parens`, positives get a trailing no-break space so digits line up in a column.
 */
export function formatMoney(minor: number, options: MoneyFormatOptions = {}): string {
  if (!Number.isFinite(minor)) return MISSING;
  const { negative = 'minus', symbol = '$', cents = true } = options;
  // Whole-dollar display rounds to the nearest dollar before deciding the sign.
  const rounded = cents ? Math.round(minor) : Math.round(minor / 100) * 100;
  const abs = Math.abs(rounded);
  const dollars = Math.floor(abs / 100);
  const remainder = abs - dollars * 100;
  let body = symbol + groupThousands(String(dollars));
  if (cents) body += `.${remainder < 10 ? '0' : ''}${String(remainder)}`;
  return wrapNegative(body, rounded < 0, negative);
}

/** Compact money for tight spots: `$12,345.67` below one million, then `$1.23M`, `$4.5B`. */
export function formatMoneyCompact(minor: number): string {
  if (!Number.isFinite(minor)) return MISSING;
  const dollars = Math.abs(minor) / 100;
  const sign = Math.round(minor) < 0 ? '-' : '';
  if (dollars < 1_000_000) return formatMoney(minor);
  const scaled: [number, string][] = [
    [1e12, 'T'],
    [1e9, 'B'],
    [1e6, 'M'],
  ];
  for (const [size, suffix] of scaled) {
    if (dollars >= size) {
      const value = dollars / size;
      const text =
        value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2);
      return `${sign}$${text}${suffix}`;
    }
  }
  return formatMoney(minor);
}

/** Integer quantity with thousands separators; optional unit suffix (`1,200 kg`). */
export function formatQty(qty: number, unit?: string): string {
  if (!Number.isFinite(qty)) return MISSING;
  const rounded = Math.round(qty);
  const body = groupThousands(String(Math.abs(rounded)));
  const text = rounded < 0 ? `-${body}` : body;
  return unit === undefined || unit === '' ? text : `${text}${NBSP}${unit}`;
}

/** Ratio to percent text: `0.1234` -> `12.3%`. */
export function formatPercent(ratio: number, digits = 1): string {
  if (!Number.isFinite(ratio)) return MISSING;
  const text = (ratio * 100).toFixed(digits);
  return `${Number(text) === 0 ? (0).toFixed(digits) : text}%`;
}

export interface DateLike {
  year: number;
  month: number;
  day: number;
}

const pad2 = (n: number): string => (n < 10 ? `0${String(n)}` : String(n));

/** `Y2000 M07 D12`. */
export function formatDate(date: DateLike): string {
  return `Y${String(date.year)} M${pad2(date.month)} D${pad2(date.day)}`;
}

/** Label for a closed period: `Y2000 M03`, `Y2000 Q1`, `Y2000`. */
export function formatPeriod(
  kind: 'month' | 'quarter' | 'year',
  year: number,
  month: number,
): string {
  switch (kind) {
    case 'month':
      return `Y${String(year)} M${pad2(month)}`;
    case 'quarter':
      return `Y${String(year)} Q${String(Math.ceil(month / 3))}`;
    case 'year':
      return `Y${String(year)}`;
  }
}

/** Parses a user-typed seed: a non-negative safe integer verbatim, else `null`. */
export function parseSeedText(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d{1,15}$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isSafeInteger(n) ? n : null;
}
