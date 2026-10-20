import { describe, expect, it } from 'vitest';
import { formulaRefs, parseFormula, splitCsvLine, type Regime } from '@kt/domain';
import { readFileSync } from 'node:fs';
import { dataPath, loadCoaTemplate, loadReportTemplates, reportStatus } from '../src/index.js';

const REGIMES = ['TT99', 'TT133'] as const; const CODES = ['B01', 'B02', 'B03'] as const;
const complete = (regime: Regime, code: string) => reportStatus()[regime.toLowerCase() as 'tt99' | 'tt133'][code] === true;

describe('mẫu báo cáo tài chính', () => {
  const rows = loadReportTemplates();
  it('mọi tệp CSV có tiêu đề đúng và mọi dòng đã nạp phân tích được (kể cả bộ chờ văn bản)', () => {
    for (const regime of REGIMES) for (const code of CODES) {
      const text = readFileSync(dataPath('reports', regime.toLowerCase(), `${code}.csv`), 'utf8');
      expect(splitCsvLine(text.split(/\r?\n/)[0]!).join(',')).toBe('line_code,label,parent_line_code,source,side,formula,is_bold,negate,note_ref');
      const body = text.split(/\r?\n/).slice(1).filter((l) => l.trim() !== '');
      expect(rows.filter((r) => r.regime === regime && r.reportCode === code), `${regime}/${code}`).toHaveLength(body.length);
    }
  });
  it('công thức phân tích được, dòng [x] tham chiếu tồn tại, mã dòng không trùng; dòng cha tồn tại khi bộ đã hoàn tất', () => {
    for (const regime of REGIMES) for (const code of CODES) {
      const ls = rows.filter((r) => r.regime === regime && r.reportCode === code); const codes = new Set(ls.map((l) => l.lineCode));
      expect(codes.size, `${regime}/${code}: trùng mã dòng`).toBe(ls.length);
      for (const l of ls) {
        // Bộ chờ văn bản mới có vài dòng ví dụ định dạng nên dòng cha có thể chưa nhập; bộ hoàn tất thì không được thiếu.
        if (l.parentLineCode && complete(regime, code)) expect(codes.has(l.parentLineCode), `${regime}/${code}/${l.lineCode}: cha ${l.parentLineCode}`).toBe(true);
        if (!l.formula) continue;
        const refs = formulaRefs(parseFormula(l.formula));
        for (const x of refs.lines) expect(codes.has(x), `${regime}/${code}/${l.lineCode}: dòng [${x}]`).toBe(true);
      }
    }
  });
  it('dòng ví dụ TT99 đúng định dạng: đối ứng có dấu phẩy được bọc nháy', () => {
    const b03 = rows.filter((r) => r.regime === 'TT99' && r.reportCode === 'B03');
    expect(b03.map((r) => r.formula)).toEqual(['N111,112/C511,131', 'N331,152,153,156,641,642/C111,112', 'N334/C111,112']);
    expect(b03.map((r) => r.negate)).toEqual([false, true, true]);
    const b01 = rows.filter((r) => r.regime === 'TT99' && r.reportCode === 'B01');
    expect(b01.find((r) => r.lineCode === '136')).toMatchObject({ formula: '1388+334+338(3387)', source: 'balance', side: 'debit', parentLineCode: '130', sortOrder: 7 });
  });
  it('bộ chưa hoàn tất không được nạp vào bảng mẫu hệ thống; bộ đã hoàn tất phải ghi nguồn', () => {
    const st = reportStatus();
    const loaded = loadReportTemplates({ onlyComplete: true });
    for (const regime of REGIMES) {
      for (const code of CODES) {
        const n = loaded.filter((r) => r.regime === regime && r.reportCode === code).length;
        if (complete(regime, code)) { expect(st[regime.toLowerCase() as 'tt99' | 'tt133'].source, `${regime}/${code}: thiếu nguồn`).not.toBe(''); expect(n).toBeGreaterThan(0); }
        else expect(n, `${regime}/${code} chưa hoàn tất`).toBe(0);
      }
    }
  });
  it('tài khoản trong công thức tồn tại trong mẫu hệ thống tài khoản (chỉ khi bộ báo cáo complete=true)', () => {
    const pending: string[] = [];
    for (const regime of REGIMES) {
      const coa = new Set(loadCoaTemplate(regime).map((a) => a.code));
      for (const code of CODES) {
        if (!complete(regime, code)) { pending.push(`${regime}/${code}`); continue; }
        for (const l of rows.filter((r) => r.regime === regime && r.reportCode === code)) if (l.formula)
          for (const a of formulaRefs(parseFormula(l.formula)).accounts) expect([...coa].some((c) => c.startsWith(a) || a.startsWith(c)), `${regime}/${code}/${l.lineCode}: TK ${a}`).toBe(true);
      }
    }
    if (pending.length) console.warn(`CẢNH BÁO: ${pending.length} bộ báo cáo chưa hoàn tất (chờ văn bản), bỏ qua đối chiếu tài khoản: ${pending.join(', ')}`);
  });
});
