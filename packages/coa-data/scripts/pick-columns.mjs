// Dùng: node pick-columns.mjs COL1,COL2,... < in.csv > out.csv  (giữ đúng thứ tự cột yêu cầu)
/* global process, console */
import { readFileSync } from 'node:fs';
const want = process.argv[2].split(',');
const text = readFileSync(0, 'utf8');
const lines = text.split(/\r?\n/).filter(Boolean);
const split = (l) => { const o = []; let c = ''; let q = false; for (let i = 0; i < l.length; i++) { const ch = l[i]; if (ch === '"') { if (q && l[i+1] === '"') { c += '"'; i++; } else q = !q; } else if (ch === ',' && !q) { o.push(c); c = ''; } else c += ch; } o.push(c); return o; };
const esc = (v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const header = split(lines[0]); const idx = want.map((w) => { const i = header.indexOf(w); if (i < 0) throw new Error(`thiếu cột ${w}`); return i; });
console.log(want.join(','));
for (const l of lines.slice(1)) { const c = split(l); console.log(idx.map((i) => esc(c[i] ?? '')).join(',')); }
