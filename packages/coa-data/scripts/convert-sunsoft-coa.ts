// Chuyển OrgDMTK (TT133) và OrgDMTK_200 (TT200) của SUNSOFT sang định dạng data/coa/*.csv.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const split = (l: string) => { const o: string[] = []; let c = ''; let q = false; for (let i = 0; i < l.length; i++) { const ch = l[i]!; if (ch === '"') { if (q && l[i + 1] === '"') { c += '"'; i++; } else q = !q; } else if (ch === ',' && !q) { o.push(c); c = ''; } else c += ch; } o.push(c); return o; };
const esc = (v: string) => (/[",]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

function convert(src: string, dst: string) {
  const lines = readFileSync(path.join(here, '..', 'reference', 'sunsoft', src), 'utf8').split(/\r?\n/).filter(Boolean);
  const h = split(lines[0]!); const col = (r: string[], n: string) => r[h.indexOf(n)] ?? '';
  const rows = lines.slice(1).map(split).filter((r) => /^\d+$/.test(col(r, 'TK_TI')));  // bỏ dòng nhánh gốc 'N', '1'..'9' một chữ số
  const codes = new Set(rows.map((r) => col(r, 'TK_TI')));
  // Cha = mã dài nhất (>= 3 chữ số) là tiền tố thực sự của mã; nhóm = có con. SUNSOFT để NHOM_ME trống ở 336x và CHI_TIET lệch ở 121, 521, 1113, 356.
  const parentOf = (code: string) => { for (let n = code.length - 1; n >= 3; n--) if (codes.has(code.slice(0, n))) return code.slice(0, n); return ''; };
  const parents = new Set([...codes].map(parentOf));
  const out = ['code,name,name_en,parent_code,is_group,normal_balance,track_currency,subledger_kind'];
  for (const r of rows) {
    const code = col(r, 'TK_TI'); if (code.length < 3) continue;
    const parent = parentOf(code);
    const loaiDu = col(r, 'LOAI_DU');
    const nb = loaiDu === 'C' ? 'C' : loaiDu === 'L' ? 'L' : loaiDu === 'N' ? 'N' : (['3', '4', '5', '7'].includes(code[0]!) ? 'C' : 'N');
    const tc = col(r, 'TC_KHAC');
    const sk = tc === 'CN' ? (code.startsWith('1') ? 'receivable' : 'payable') : tc === 'VT' ? 'inventory' : tc === 'TS' ? 'fixed_asset'
      : code.startsWith('112') && code.length > 3 ? 'bank' : code.startsWith('111') && code.length > 3 ? 'cash' : '';
    out.push([code, esc(col(r, 'TEN_TK')), esc(col(r, 'TEN_TK_E')), parent, parents.has(code) ? '1' : '0', nb, col(r, 'TK_NTE') === '1' ? '1' : '0', sk].join(','));
  }
  writeFileSync(path.join(here, '..', 'data', 'coa', dst), out.join('\n') + '\n');
  console.log(`${dst}: ${out.length - 1} tài khoản`);
}
convert('OrgDMTK_133.csv', 'tt133.csv');
convert('OrgDMTK_200.csv', 'tt200.csv');
