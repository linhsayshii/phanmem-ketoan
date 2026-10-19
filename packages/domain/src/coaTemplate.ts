import type { Regime } from './period.js';

export type RootType = 'asset' | 'liability' | 'equity' | 'income' | 'expense' | 'off_balance';
export type SubledgerKind = 'receivable' | 'payable' | 'inventory' | 'fixed_asset' | 'bank' | 'cash';
export interface CoaTemplateRow {
  regime: Regime; code: string; name: string; nameEn: string | null; parentCode: string | null; isGroup: boolean;
  rootType: RootType; normalBalance: 'debit' | 'credit' | 'both'; trackCurrency: boolean; subledgerKind: SubledgerKind | null; source: string;
}

export function rootTypeOf(code: string): RootType {
  switch (code[0]) {
    case '1': case '2': return 'asset';
    case '3': return 'liability';
    case '4': return 'equity';
    case '5': case '7': case '9': return 'income';
    case '6': case '8': return 'expense';
    default: return 'off_balance';
  }
}
export function defaultNormalBalance(code: string): 'debit' | 'credit' {
  return ['3', '4', '5', '7'].includes(code[0]!) ? 'credit' : 'debit';
}

// CSV đơn giản: không có dấu phẩy trong tên; nếu cần thì bọc bằng dấu nháy kép.
function splitCsvLine(line: string): string[] {
  const out: string[] = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
    else if (ch === ',' && !q) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

export function parseCoaCsv(text: string, regime: Regime, source: string): CoaTemplateRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  const header = splitCsvLine(lines[0] ?? '');
  const expected = ['code', 'name', 'name_en', 'parent_code', 'is_group', 'normal_balance', 'track_currency', 'subledger_kind'];
  if (header.join(',') !== expected.join(',')) throw new Error(`Tiêu đề CSV phải là: ${expected.join(',')}`);
  return lines.slice(1).map((l, i) => {
    const c = splitCsvLine(l);
    if (c.length !== 8) throw new Error(`Dòng ${i + 2}: cần 8 cột`);
    const nb = c[5] === 'C' ? 'credit' : c[5] === 'L' ? 'both' : c[5] === 'N' ? 'debit' : null;
    if (!nb) throw new Error(`Dòng ${i + 2}: normal_balance phải là N, C hoặc L`);
    const sk = c[7] === '' ? null : (c[7] as SubledgerKind);
    return { regime, code: c[0]!, name: c[1]!, nameEn: c[2] === '' ? null : c[2]!, parentCode: c[3] === '' ? null : c[3]!,
      isGroup: c[4] === '1', rootType: rootTypeOf(c[0]!), normalBalance: nb, trackCurrency: c[6] === '1', subledgerKind: sk, source };
  });
}

export function validateCoaTemplate(rows: CoaTemplateRow[]): string[] {
  const errs: string[] = [];
  const seen = new Set<string>(); const byCode = new Map<string, CoaTemplateRow>(); const children = new Map<string, number>();
  for (const r of rows) {
    if (seen.has(r.code)) errs.push(`${r.code}: trùng mã`); seen.add(r.code); byCode.set(r.code, r);
    if (r.parentCode) children.set(r.parentCode, (children.get(r.parentCode) ?? 0) + 1);
    if (!/^[0-9]{1,8}$/.test(r.code)) errs.push(`${r.code}: mã phải là 1–8 chữ số`);
  }
  for (const r of rows) {
    if (r.parentCode) {
      if (!byCode.has(r.parentCode)) errs.push(`${r.code}: không có tài khoản cha ${r.parentCode}`);
      if (!r.code.startsWith(r.parentCode)) errs.push(`${r.code}: mã không bắt đầu bằng mã cha ${r.parentCode}`);
    }
    if (r.isGroup && !children.has(r.code)) errs.push(`${r.code}: là tài khoản tổng hợp nhưng không có tài khoản con`);
    if (!r.isGroup && children.has(r.code)) errs.push(`${r.code}: có tài khoản con nhưng không đánh dấu tổng hợp`);
  }
  return errs;
}
