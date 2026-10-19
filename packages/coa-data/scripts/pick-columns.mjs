// Dùng: node pick-columns.mjs COL1,COL2,... [NHÃN] < in.csv > out.csv  (giữ đúng thứ tự cột yêu cầu; in "<NHÃN>: N bản ghi" ra stderr)
/* global process, console */
import { readFileSync } from 'node:fs';

// Tách bản ghi CSV có nhận biết dấu nháy: dấu xuống dòng trong ô được bọc nháy không kết thúc bản ghi.
function parseCsv(text) {
  const records = []; let rec = []; let cell = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { rec.push(cell); cell = ''; }
    else if (ch === '\n' || (ch === '\r' && text[i + 1] === '\n')) {
      if (ch === '\r') i++;
      rec.push(cell); cell = '';
      if (rec.length > 1 || rec[0] !== '') records.push(rec);  // bỏ dòng trống
      rec = [];
    } else cell += ch;
  }
  rec.push(cell);
  if (rec.length > 1 || rec[0] !== '') records.push(rec);
  return records;
}
const clean = (v) => v.replace(/\r\n|\n|\r/g, ' ');
const esc = (v) => { const s = clean(v); return /[",]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s; };

const want = process.argv[2].split(',');
const label = process.argv[3] ?? 'bảng';
const records = parseCsv(readFileSync(0, 'utf8'));
if (records.length === 0) { console.error(`${label}: không có dữ liệu`); process.exit(1); }
const header = records[0].map(clean);
const idx = want.map((w) => { const i = header.indexOf(w); if (i < 0) throw new Error(`thiếu cột ${w}`); return i; });
console.log(want.join(','));
for (const c of records.slice(1)) console.log(idx.map((i) => esc(c[i] ?? '')).join(','));
console.error(`${label}: ${records.length - 1} bản ghi`);
