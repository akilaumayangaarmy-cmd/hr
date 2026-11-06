import { ColumnDef } from '../metadata/types';

export type Scalar = string | number | null;

export type CoerceResult =
  | { ok: true; value: Scalar }
  | { ok: false; message: string };

const SPREADSHEET_ERROR = /^#(NULL!|DIV\/0!|VALUE!|REF!|NAME\?|NUM!|N\/A|GETTING_DATA)/i;

export function isBlank(value: unknown): boolean {
  if (value == null) return true;
  if (typeof value === 'string') {
    const trimmed = value.replace(/^\uFEFF/, '').trim();
    if (!trimmed) return true;
    return /^(null|n\/a|na)$/i.test(trimmed);
  }
  return false;
}

export function formatDateOnly(date: Date): string {
  const localMidnight =
    date.getHours() === 0 &&
    date.getMinutes() === 0 &&
    date.getSeconds() === 0 &&
    date.getMilliseconds() === 0;
  const year = localMidnight ? date.getFullYear() : date.getUTCFullYear();
  const month = (localMidnight ? date.getMonth() : date.getUTCMonth()) + 1;
  const day = localMidnight ? date.getDate() : date.getUTCDate();
  return isoDate(year, month, day);
}

export function excelSerialToIso(serial: number): string | null {
  if (!Number.isFinite(serial)) return null;
  const whole = Math.floor(serial);
  if (whole < 1 || whole > 2_958_465) return null;
  const adjusted = whole >= 61 ? whole - 1 : whole === 60 ? 59 : whole;
  const date = new Date(Date.UTC(1900, 0, 1) + (adjusted - 1) * 86_400_000);
  const year = date.getUTCFullYear();
  if (year < 1900 || year > 2200) return null;
  return isoDate(year, date.getUTCMonth() + 1, date.getUTCDate());
}

export function coerceValue(column: ColumnDef, value: unknown): CoerceResult {
  if (typeof value === 'string' && SPREADSHEET_ERROR.test(value.trim())) {
    return { ok: false, message: `${column.label} contains spreadsheet error ${value.trim()}` };
  }
  const blank = column.type === 'string'
    ? value == null || value === ''
    : isBlank(value);
  if (blank) {
    if (column.generateOnInsert) return { ok: true, value: null };
    if (!column.nullable) return { ok: false, message: `${column.label} is required` };
    return { ok: true, value: null };
  }
  switch (column.type) {
    case 'string':
      return parseString(column, value);
    case 'number':
      return parseNumber(column, value);
    case 'flag':
      return parseFlag(column, value);
    case 'date':
      return parseDate(column, value);
  }
}

export function parseOldId(value: unknown): { ok: true; value: number } | { ok: false; message: string } {
  const parsed = coerceValue(
    {
      name: 'old_id',
      physicalName: 'old_id',
      label: 'Old ID',
      type: 'number',
      precision: 38,
      scale: 0,
      nullable: false,
      requiredOnInsert: true,
    },
    value,
  );
  if (!parsed.ok) return parsed;
  if (typeof parsed.value !== 'number' || parsed.value < 0) {
    return { ok: false, message: 'Old ID must be a non-negative integer' };
  }
  return { ok: true, value: parsed.value };
}

function parseString(column: ColumnDef, value: unknown): CoerceResult {
  let text: string;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return { ok: false, message: `${column.label} cannot be converted to text` };
    text = String(value);
  } else if (typeof value === 'boolean') {
    text = value ? 'true' : 'false';
  } else if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return { ok: false, message: `${column.label} is an invalid date` };
    text = formatDateOnly(value);
  } else if (typeof value === 'string') {
    text = value;
  } else {
    return { ok: false, message: `${column.label} must be text` };
  }
  const limit = column.length ?? 4000;
  if (Buffer.byteLength(text, 'utf8') > limit) {
    return { ok: false, message: `${column.label} exceeds ${limit} bytes` };
  }
  return { ok: true, value: text };
}

function parseNumber(column: ColumnDef, value: unknown): CoerceResult {
  const scale = column.scale ?? 0;
  const precision = column.precision ?? 38;
  let raw: string;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return { ok: false, message: `${column.label} must be a finite number` };
    raw = String(value);
  } else if (typeof value === 'string') {
    raw = value.replace(/^\uFEFF/, '').trim().replace(/,/g, '').replace(/^\+/, '');
    if (/^\d+\.0+$/.test(raw)) raw = raw.replace(/\.0+$/, '');
  } else {
    return { ok: false, message: `${column.label} must be a number` };
  }
  if (!/^-?\d+(\.\d+)?$/.test(raw)) {
    return { ok: false, message: `${column.label} must be a number` };
  }
  if (column.name === 'old_id' && raw.startsWith('-')) {
    return { ok: false, message: 'Old ID must be a non-negative integer' };
  }
  const unsigned = raw.startsWith('-') ? raw.slice(1) : raw;
  const [ints, fraction = ''] = unsigned.split('.');
  const significantFraction = fraction.replace(/0+$/, '');
  if (scale === 0 && /[1-9]/.test(fraction)) {
    return { ok: false, message: `${column.label} must be an integer` };
  }
  if (significantFraction.length > scale) {
    return { ok: false, message: `${column.label} allows at most ${scale} decimal places` };
  }
  const integerDigits = ints.replace(/^0+/, '').length;
  if (integerDigits > precision - scale) {
    return { ok: false, message: `${column.label} exceeds NUMBER(${precision},${scale})` };
  }
  const numeric = Number(raw);
  if (!Number.isFinite(numeric)) return { ok: false, message: `${column.label} must be a finite number` };
  if (scale === 0 && !Number.isSafeInteger(numeric)) {
    return { ok: false, message: `${column.label} is outside the safe integer range` };
  }
  return { ok: true, value: numeric };
}

function parseFlag(column: ColumnDef, value: unknown): CoerceResult {
  if (typeof value === 'number') {
    if (value === 0 || value === 1) return { ok: true, value };
    return { ok: false, message: `${column.label} must be 0 or 1` };
  }
  if (typeof value === 'boolean') return { ok: true, value: value ? 1 : 0 };
  if (typeof value !== 'string') return { ok: false, message: `${column.label} must be a flag` };
  const token = value.trim().toLowerCase();
  if (['1', 'y', 'yes', 'true', 't'].includes(token)) return { ok: true, value: 1 };
  if (['0', 'n', 'no', 'false', 'f'].includes(token)) return { ok: true, value: 0 };
  return { ok: false, message: `${column.label} must be 0/1, Y/N, or true/false` };
}

function parseDate(column: ColumnDef, value: unknown): CoerceResult {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return { ok: false, message: `${column.label} is an invalid date` };
    return { ok: true, value: formatDateOnly(value) };
  }
  if (typeof value === 'number') {
    const iso = excelSerialToIso(value);
    if (!iso) return { ok: false, message: `${column.label} is not a valid Excel date serial` };
    return { ok: true, value: iso };
  }
  if (typeof value !== 'string') return { ok: false, message: `${column.label} must be a date` };
  const text = value.replace(/^\uFEFF/, '').trim();
  const isoMatch = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s].*)?$/);
  if (isoMatch) {
    const iso = calendarIso(Number(isoMatch[1]), Number(isoMatch[2]), Number(isoMatch[3]));
    if (!iso) return { ok: false, message: `${column.label} is not a real calendar date` };
    return { ok: true, value: iso };
  }
  const yearFirst = text.match(/^(\d{4})[/.](\d{1,2})[/.](\d{1,2})$/);
  if (yearFirst) {
    const iso = calendarIso(Number(yearFirst[1]), Number(yearFirst[2]), Number(yearFirst[3]));
    if (!iso) return { ok: false, message: `${column.label} is not a real calendar date` };
    return { ok: true, value: iso };
  }
  const dayFirst = text.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
  if (dayFirst) {
    const iso = calendarIso(Number(dayFirst[3]), Number(dayFirst[2]), Number(dayFirst[1]));
    if (!iso) return { ok: false, message: `${column.label} is not a real calendar date. Use DD/MM/YYYY` };
    return { ok: true, value: iso };
  }
  if (/^\d+(\.\d+)?$/.test(text)) {
    const whole = text.split('.')[0];
    if (whole.length >= 5) {
      const iso = excelSerialToIso(Number(text));
      if (iso) return { ok: true, value: iso };
    }
  }
  return {
    ok: false,
    message: `${column.label} must be YYYY-MM-DD, DD/MM/YYYY, or an Excel date serial`,
  };
}

function calendarIso(year: number, month: number, day: number): string | null {
  if (year < 1900 || year > 9999) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  return isoDate(year, month, day);
}

function isoDate(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
