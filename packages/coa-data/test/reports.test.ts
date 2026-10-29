import { describe, expect, it } from 'vitest';
import { formulaRefs, parseFormula, splitCsvLine, type Regime } from '@kt/domain';
import { readFileSync } from 'node:fs';
import { dataPath, loadCoaTemplate, loadReportTemplates, reportStatus } from '../src/index.js';

const REGIMES = ['TT99', 'TT133', 'TT200'] as const; const CODES = ['B01', 'B02', 'B03'] as const;
const complete = (regime: Regime, code: string) => reportStatus()[regime.toLowerCase() as 'tt99' | 'tt133' | 'tt200'][code] === true;

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
  it('định dạng: đối ứng có dấu phẩy được bọc nháy; chỉ tiêu tiêu biểu đúng văn bản gốc', () => {
    const get = (r: Regime, c: string, l: string) => rows.find((x) => x.regime === r && x.reportCode === c && x.lineCode === l);
    expect(get('TT99', 'B03', '03')).toMatchObject({ formula: 'N334/C111,112,113!CF-CF(03)', negate: true, source: 'pair' });
    expect(get('TT99', 'B01', '135')).toMatchObject({ formula: '1388+334+338+141+244-LT(1388,334,338,141,244)', source: 'balance', side: 'debit', parentLineCode: '130' });
    expect(get('TT99', 'B01', '215')).toMatchObject({ formula: 'LT(1388,334,338,141,244)', source: 'balance', side: 'debit', parentLineCode: '210' });
    expect(get('TT133', 'B01', '124')).toMatchObject({ formula: '2291+2292', side: 'credit', negate: true });
  });
  it('cây tổng khép kín: tổng tài sản, tổng nguồn vốn, lợi nhuận sau thuế, lưu chuyển tiền thuần', () => {
    const f = (r: Regime, c: string, l: string) => rows.find((x) => x.regime === r && x.reportCode === c && x.lineCode === l)?.formula;
    expect(f('TT99', 'B01', '280')).toBe('[100]+[200]');
    expect(f('TT99', 'B01', '440')).toBe('[300]+[400]');
    expect(f('TT133', 'B01', '200')).toBe('[110]+[120]+[130]+[140]+[150]+[160]+[170]+[180]');
    expect(f('TT133', 'B01', '500')).toBe('[300]+[400]');
    expect(f('TT99', 'B02', '60')).toBe('[50]-[51]-[52]');
    expect(f('TT133', 'B02', '60')).toBe('[50]-[51]');
    for (const r of REGIMES) expect(f(r, 'B03', '50')).toBe('[20]+[30]+[40]');
  });
  it('bộ chưa hoàn tất không được nạp vào bảng mẫu hệ thống; bộ đã hoàn tất phải ghi nguồn', () => {
    const st = reportStatus();
    const loaded = loadReportTemplates({ onlyComplete: true });
    for (const regime of REGIMES) {
      for (const code of CODES) {
        const n = loaded.filter((r) => r.regime === regime && r.reportCode === code).length;
        if (complete(regime, code)) { expect(st[regime.toLowerCase() as 'tt99' | 'tt133' | 'tt200'].source, `${regime}/${code}: thiếu nguồn`).not.toBe(''); expect(n).toBeGreaterThan(0); }
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
          for (const a of formulaRefs(parseFormula(l.formula)).accounts) expect(coa.has(a) || [...coa].some((c) => c.startsWith(a)), `${regime}/${code}/${l.lineCode}: TK ${a}`).toBe(true);
      }
    }
    if (pending.length) console.warn(`CẢNH BÁO: ${pending.length} bộ báo cáo chưa hoàn tất (chờ văn bản), bỏ qua đối chiếu tài khoản: ${pending.join(', ')}`);
  });
  it('B02 TT99: chỉ mã 22 và 23 dùng số thuần đánh giá lại (dòng phát sinh); TT133 không dùng', () => {
    const withReval = rows.filter((r) => /REVAL/.test(r.formula ?? '')).map((r) => [r.regime, r.reportCode, r.lineCode, r.source, r.formula]);
    expect(withReval).toEqual([['TT99', 'B02', '22', 'movement', '515!REVAL + REVAL_GAIN'], ['TT99', 'B02', '23', 'movement', '635!REVAL + REVAL_LOSS']]);
  });
  it('kỳ hạn và mã luồng tiền: LT chỉ ở dòng số dư B01 của TT99 và TT200; mỗi dòng luồng tiền B03 bỏ cặp có mã (!CF) và cộng CF(mã của chính nó) theo chiều thu/chi', () => {
    for (const r of rows.filter((x) => /LT\(/.test(x.formula ?? ''))) { expect(['TT99', 'TT200'], r.regime).toContain(r.regime); expect([r.reportCode, r.source]).toEqual(['B01', 'balance']); }
    for (const regime of REGIMES) for (const l of rows.filter((x) => x.regime === regime && x.reportCode === 'B03' && x.source === 'pair' && x.parentLineCode))
      expect(l.formula, `${regime}/B03/${l.lineCode}`).toMatch(new RegExp(`^N[^!]+!CF${l.negate ? '-' : '\\+'}CF\\(${l.lineCode}\\)$`));
  });
  it('TT200 theo Phụ lục 2 Công báo 289 + 290: mã chỉ tiêu và cây tổng của B01-DN, B02-DN, B03-DN', () => {
    const lines = (c: string) => rows.filter((r) => r.regime === 'TT200' && r.reportCode === c);
    const f = (c: string, l: string) => lines(c).find((x) => x.lineCode === l);
    // Mã số in trên mẫu B01-DN (trang PDF 46-49 của Công báo), theo thứ tự in.
    const b01 = '100 110 111 112 120 121 122 123 130 131 132 133 134 135 136 137 139 140 141 149 150 151 152 153 154 155 200 210 211 212 213 214 215 216 219 220 221 222 223 224 225 226 227 228 229 230 231 232 240 241 242 250 251 252 253 254 255 260 261 262 263 268 270 300 310 311 312 313 314 315 316 317 318 319 320 321 322 323 324 330 331 332 333 334 335 336 337 338 339 340 341 342 343 400 410 411 411a 411b 412 413 414 415 416 417 418 419 420 421 421a 421b 422 430 431 432 440';
    expect(lines('B01').map((l) => l.lineCode).join(' ')).toBe(b01);
    expect(lines('B02').map((l) => l.lineCode).join(' ')).toBe('01 02 10 11 20 21 22 23 25 26 30 31 32 40 50 51 52 60 70 71');
    expect(lines('B03').map((l) => l.lineCode).join(' ')).toBe('01 02 03 04 05 06 07 20 21 22 23 24 25 26 27 30 31 32 33 34 35 36 40 50 60 61 70');
    expect(f('B01', '270')!.formula).toBe('[100]+[200]'); expect(f('B01', '440')!.formula).toBe('[300]+[400]');
    expect(f('B01', '260')!.formula).toBe('[261]+[262]+[263]+[268]'); // Điều 112 khoản 1.4 điểm b bỏ sót 263, mẫu in có 263
    expect(f('B01', '320')).toMatchObject({ formula: '341+3431-LT(341,3431)', side: 'net_credit' });
    expect(f('B01', '136')!.formula).toBe('1385+1388+334+338+141+244-LT(1385,1388,334,338,141,244)');
    expect(f('B02', '30')!.formula).toBe('[20]+[21]-[22]-[25]-[26]'); expect(f('B02', '60')!.formula).toBe('[50]-[51]-[52]');
    expect(f('B03', '20')!.formula).toBe('[01]-[02]-[03]-[04]-[05]+[06]-[07]'); expect(f('B03', '30')!.formula).toBe('[22]+[24]+[26]+[27]-[21]-[23]-[25]');
    expect(f('B03', '40')!.formula).toBe('[31]-[32]+[33]-[34]-[35]-[36]');
    // Dòng dự phòng, hao mòn, cổ phiếu quỹ in trong ngoặc: negate và trừ trong công thức của dòng tổng.
    for (const l of ['122', '137', '149', '219', '223', '226', '229', '232', '254', '415']) expect(f('B01', l)!.negate, l).toBe(true);
  });
});
