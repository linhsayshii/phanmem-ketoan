import { D, type Decimal } from './money.js';

export function formatVnNumber(v: string | Decimal | null | undefined, scale = 0): string {
  if (v === null || v === undefined || v === '') return '';
  const d = D(v).toFixed(scale);
  const [intPart, frac] = d.split('.');
  const sign = intPart!.startsWith('-') ? '-' : '';
  const digits = intPart!.replace('-', '');
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return sign + grouped + (frac ? ',' + frac : '');
}

export function parseVnNumber(text: string): string | null {
  const s = text.trim();
  if (!/^-?(\d{1,3}([. ]\d{3})+|\d+)(,\d+)?$/.test(s)) return null;
  const cleaned = s.replace(/[. ]/g, '').replace(',', '.');
  return D(cleaned).toString();
}

export function formatVnDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

export function parseVnDate(text: string): string | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(text.trim());
  if (!m) return null;
  const day = Number(m[1]); const month = Number(m[2]);
  const year = m[3]!.length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
