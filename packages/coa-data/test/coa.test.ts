import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validateCoaTemplate } from '@kt/domain';
import { COA_REGIMES, dataPath, loadCoaTemplate, loadDefaultClosingSteps, tt99Status } from '../src/index.js';

// Tách một dòng CSV có nhận biết dấu nháy (cùng quy tắc với scripts/pick-columns.mjs; tệp tham chiếu không còn dấu xuống dòng trong ô).
const splitLine = (l: string): string[] => {
  const o: string[] = []; let c = ''; let q = false;
  for (let i = 0; i < l.length; i++) {
    const ch = l[i]!;
    if (q) { if (ch === '"') { if (l[i + 1] === '"') { c += '"'; i++; } else q = false; } else c += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { o.push(c); c = ''; }
    else c += ch;
  }
  o.push(c);
  return o;
};
const refCodes = (file: string, col: string): string[] => {
  const lines = readFileSync(dataPath('..', 'reference', 'sunsoft', file), 'utf8').split(/\r?\n/).filter(Boolean);
  const i = splitLine(lines[0]!).indexOf(col);
  return lines.slice(1).map((l) => splitLine(l)[i] ?? '').filter((v) => /^\d{3,}$/.test(v));
};
// Các bảng DesBC_*_99 của SUNSOFT là bản sao TT200 nên còn tham chiếu các tài khoản TT99 đã bỏ.
const TT99_REMOVED = ['161', '417', '441', '461', '466', '611', '631'];
const kept = (codes: string[]): string[] => codes.filter((c) => !TT99_REMOVED.includes(c));

describe('mẫu hệ thống tài khoản', () => {
  for (const regime of COA_REGIMES) {
    it(`${regime}: cấu trúc hợp lệ`, () => {
      const rows = loadCoaTemplate(regime);
      expect(validateCoaTemplate(rows)).toEqual([]);
    });
  }
  it('TT133 có 131/331 lưỡng tính, 1112/1122 theo dõi ngoại tệ, đủ tài khoản SUNSOFT', () => {
    const rows = loadCoaTemplate('TT133'); const by = new Map(rows.map((r) => [r.code, r]));
    expect(by.get('131')?.normalBalance).toBe('both'); expect(by.get('131')?.subledgerKind).toBe('receivable');
    expect(by.get('331')?.subledgerKind).toBe('payable'); expect(by.get('1112')?.trackCurrency).toBe(true);
    // 521 có trong SUNSOFT nhưng không có trong Phụ lục 1 TT 133/2016 (giảm trừ doanh thu ghi thẳng vào 511).
    for (const c of refCodes('OrgDMTK_133.csv', 'TK_TI').filter((x) => x !== '521')) expect(by.has(c), `thiếu ${c}`).toBe(true);
  });
  it('TT200 đủ tài khoản SUNSOFT OrgDMTK_200', () => {
    const by = new Set(loadCoaTemplate('TT200').map((r) => r.code));
    // 1552 là số hiệu SUNSOFT ghi nhầm: Phụ lục 1 TT 200/2014 là 1557 (Thành phẩm bất động sản).
    for (const c of refCodes('OrgDMTK_200.csv', 'TK_TI').filter((x) => x !== '1552')) expect(by.has(c), `thiếu ${c}`).toBe(true);
    expect(by.has('1552')).toBe(false);
  });
  it('TT200: khớp Phụ lục 1 (1123 Vàng tiền tệ gửi ngân hàng, 1557, tên theo văn bản, có nguồn Công báo)', () => {
    const rows = loadCoaTemplate('TT200'); const by = new Map(rows.map((r) => [r.code, r]));
    expect(rows).toHaveLength(235);
    expect(by.get('1123')?.parentCode).toBe('112'); expect(by.get('1557')?.name).toBe('Thành phẩm bất động sản'); expect(by.get('1557')?.parentCode).toBe('155');
    expect(by.get('3331')?.name).toBe('Thuế giá trị gia tăng phải nộp'); expect(by.get('2115')?.name).toBe('Cây lâu năm, súc vật làm việc và cho sản phẩm');
    expect(by.get('911')?.name).toBe('Xác định kết quả kinh doanh');
    for (const r of rows) if (r.parentCode) expect(by.has(r.parentCode), `${r.code}: thiếu cha ${r.parentCode}`).toBe(true);
    expect(rows[0]!.source).toContain('congbao.chinhphu.vn');
  });
  it('TT99: nhập từ Phụ lục II, đã hoàn tất, có nguồn Công báo', () => {
    const st = tt99Status();
    expect(st.complete).toBe(true);
    expect(st.source).toContain('congbao.chinhphu.vn');
    expect(loadCoaTemplate('TT99')).toHaveLength(184);
  });
  it('TT99: có TK mới, không có TK đã bỏ, cha tồn tại, tên khớp văn bản', () => {
    const rows = loadCoaTemplate('TT99'); const by = new Map(rows.map((r) => [r.code, r]));
    // 137, 246, 351 không có trong bảng danh mục Phụ lục II TT 99/2025 nên không đòi hỏi.
    for (const c of ['215', '2295', '332', '1383', '215121', '215122', '82111', '82112']) expect(by.has(c), `thiếu TK mới ${c}`).toBe(true);
    for (const c of [...TT99_REMOVED, '137', '246', '351']) expect(by.has(c), `TK ${c} không có trong Phụ lục II TT99`).toBe(false);
    for (const r of rows) if (r.parentCode) expect(by.has(r.parentCode), `${r.code}: thiếu cha ${r.parentCode}`).toBe(true);
    expect(by.get('112')?.name).toBe('Tiền gửi không kỳ hạn');
    expect(by.get('1383')?.name).toBe('Thuế TTĐB của hàng nhập khẩu');
    expect(by.get('131')?.subledgerKind).toBe('receivable'); expect(by.get('331')?.subledgerKind).toBe('payable');
  });
  it('TT99: cột TK của DesBC_*_99 (bản sao TT200 của SUNSOFT) có trong tt99, trừ ngoại lệ có lý do', () => {
    const by = new Set(loadCoaTemplate('TT99').map((r) => r.code));
    // Ngoại lệ: 142, 342, 5211-5213 chỉ có trong TT200; TT99 dùng 242, 341 (3412) và 521 không chia cấp 2. Các bảng này không phải nguồn TT99.
    const TT200_ONLY = ['142', '342', '5211', '5212', '5213'];
    const refs = [...refCodes('DesBC_CDKT_B01_99.csv', 'TK'), ...refCodes('DesBC_KQKD_LAILO_99.csv', 'TK_TI'), ...refCodes('DesBC_KQKD_LAILO_99.csv', 'TK_DU')];
    const missing = [...new Set(kept(refs))].filter((c) => !by.has(c)).sort();
    expect(missing, 'TK tham chiếu không có trong tt99').toEqual(TT200_ONLY);
  });
  it('TT133: khớp Phụ lục 1 (không có 521; 642 có 6421, 6422; 1386 ký quỹ)', () => {
    const by = new Map(loadCoaTemplate('TT133').map((r) => [r.code, r]));
    expect(loadCoaTemplate('TT133')).toHaveLength(123);
    expect(by.has('521')).toBe(false); expect(by.get('642')?.name).toBe('Chi phí quản lý kinh doanh');
    expect(by.get('1386')?.name).toBe('Cầm cố, thế chấp, ký quỹ, ký cược'); expect(by.get('3562')?.name).toContain('khoa học');
  });
});

describe('sơ đồ kết chuyển mặc định theo chế độ', () => {
  it.each(COA_REGIMES)('%s: mọi tài khoản nguồn và đích có trong hệ thống tài khoản của chế độ', (regime) => {
    const codes = new Set(loadCoaTemplate(regime).map((r) => r.code));
    const steps = loadDefaultClosingSteps(regime);
    expect(steps.length).toBeGreaterThan(0);
    for (const s of steps) for (const a of [...s.fromAccounts, ...(s.toAccount ? [s.toAccount] : [])]) expect(codes.has(a), `${regime} bước ${s.stepOrder}: ${a}`).toBe(true);
  });
  it('TT99 kết chuyển 521 vào 511; TT133 không có 521 và 641', () => {
    expect(loadDefaultClosingSteps('TT99')[0]).toMatchObject({ fromAccounts: ['521'], toAccount: '511' });
    const t133 = loadDefaultClosingSteps('TT133');
    expect(t133.flatMap((s) => s.fromAccounts)).not.toContain('521');
    expect(t133.flatMap((s) => s.fromAccounts)).not.toContain('641');
    expect(loadDefaultClosingSteps('TT200')[0]).toMatchObject({ fromAccounts: ['521'], toAccount: '5111' });
  });
});
