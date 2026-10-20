import { D, VND_AMOUNT_RE, type Decimal } from './money.js';

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

const DIGIT_WORDS = ['không', 'một', 'hai', 'ba', 'bốn', 'năm', 'sáu', 'bảy', 'tám', 'chín'];
// Tên nhóm ba chữ số theo vị trí từ phải sang trái: 16 chữ số tối đa nên đủ sáu nhóm.
const GROUP_NAMES = ['', 'nghìn', 'triệu', 'tỷ', 'nghìn tỷ', 'triệu tỷ'];
// Đọc nhóm ba chữ số. `full`: phía trước đã có nhóm khác 0 nên đọc đủ "không trăm" và "lẻ" (1.001 = một nghìn không trăm lẻ một).
function readGroup(g: string, full: boolean): string {
  const [h, t, u] = [...g].map(Number) as [number, number, number];
  const w: string[] = [];
  if (h || full) w.push(DIGIT_WORDS[h]!, 'trăm');
  if (t > 1) w.push(DIGIT_WORDS[t]!, 'mươi'); else if (t === 1) w.push('mười'); else if (u && (h || full)) w.push('lẻ');
  if (u) w.push(t > 1 && u === 1 ? 'mốt' : t && u === 5 ? 'lăm' : t > 1 && u === 4 ? 'tư' : DIGIT_WORDS[u]!);
  return w.join(' ');
}
// Đọc số nguyên không âm (chuỗi tối đa 16 chữ số) thành chữ thường: "1500000" -> "một triệu năm trăm nghìn", "0" -> "không".
function readInt(digits: string): string {
  const s = digits.padStart(18, '0'); const parts: string[] = [];
  for (let i = 0; i < 6; i++) {
    const g = s.slice(i * 3, i * 3 + 3);
    if (g !== '000') parts.push(readGroup(g, parts.length > 0), GROUP_NAMES[5 - i]!);
  }
  return parts.filter(Boolean).join(' ') || 'không';
}
const AMOUNT_RE = /^\d{1,16}(\.\d{1,4})?$/;
// Số tiền (chuỗi thập phân, tối đa 16 chữ số nguyên và 4 chữ số lẻ) thành chữ kèm tên đơn vị: ("1200.50", "đô la Mỹ") -> "Một nghìn hai trăm đô la Mỹ phẩy năm mươi".
// Phần lẻ khác 0 đọc sau "phẩy", tối thiểu hai chữ số (".5" = "năm mươi", ".05" = "không năm"). Âm hoặc sai dạng: lỗi.
export function amountInWords(amount: string, unit: string): string {
  if (!AMOUNT_RE.test(amount)) throw new Error(`Số tiền phải là số không âm tối đa 16 chữ số nguyên, 4 chữ số lẻ: "${amount}"`);
  const [int, frac = ''] = amount.split('.');
  let words = `${readInt(int!)} ${unit}`;
  const f = frac.replace(/0+$/, '').padEnd(2, '0');
  if (/[1-9]/.test(f)) { const lead = f.length - f.replace(/^0+/, '').length; words += ` phẩy ${'không '.repeat(lead)}${readInt(f.slice(lead))}`; }
  return `${words[0]!.toUpperCase()}${words.slice(1)}`;
}
// Số tiền VND nguyên (chuỗi thập phân, tối đa 16 chữ số) thành chữ, ví dụ "1500000" -> "Một triệu năm trăm nghìn đồng". Âm hoặc không nguyên: lỗi.
export function vndInWords(amount: string): string {
  if (!VND_AMOUNT_RE.test(amount)) throw new Error(`Số tiền VND phải là số nguyên không âm tối đa 16 chữ số: "${amount}"`);
  return amountInWords(amount, 'đồng');
}
