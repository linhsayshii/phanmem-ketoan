import { D, formatVnDate, type Decimal } from '@kt/domain';
import { bookRegimeOf, loadBookSet, type BookDef, type BookRegime, type BookSetDef } from '@kt/coa-data';
import { AppError } from '../../plugins/errors.js';
import { periodSubtitle, type ReportColumn, type ReportDoc } from '../reporting/print/html.js';
import { companyInfo } from '../reporting/print/bookSet.js';
import { dayBefore, getSetting, loadEntries, loadGroups, pctTax, profitFlagFor, profitTax, sumOf, taxAccrued, yearBack, yearOf, type Ent, type Grp, type Trx } from './service.js';

// Dựng sổ và báo cáo của hộ kinh doanh (TT 152/2025) và doanh nghiệp siêu nhỏ (TT 58/2026) từ bút ghi sổ đơn. Cột, tên sổ, điều lấy từ packages/coa-data/data/books/*.json.
export type Row = Record<string, unknown>;
export const FAR_PAST = '1900-01-01';
export interface BookFilter { from: string; to: string; itemId?: number | undefined }
export const S = (x: Decimal) => x.toString();

const CAT_LABEL_HKD: Record<string, string> = {
  a: 'a) Chi phí nguyên liệu, vật liệu, nhiên liệu, năng lượng, hàng hóa sử dụng vào sản xuất, kinh doanh',
  b: 'b) Chi phí tiền lương, tiền công, các khoản phụ cấp, bảo hiểm bắt buộc và các khoản chi trả cho người lao động có đóng bảo hiểm bắt buộc theo quy định; chi phí tiền lương, tiền công, các khoản phụ cấp và các khoản chi trả cho người lao động dưới 01 tháng',
  c: 'c) Chi phí khấu hao tài sản cố định phục vụ cho hoạt động sản xuất, kinh doanh theo chế độ quản lý, sử dụng và trích khấu hao tài sản cố định (nếu có)',
  d: 'd) Chi phí dịch vụ mua ngoài như điện, nước, điện thoại, internet, vận chuyển, thuê tài sản, sửa chữa, bảo dưỡng',
  dd: 'đ) Chi phí trả lãi tiền vay vốn sản xuất, kinh doanh của tổ chức tín dụng theo lãi suất thực tế. Chi phí trả lãi tiền vay vốn sản xuất, kinh doanh của đối tượng không phải là tổ chức tín dụng không vượt quá mức quy định tại Bộ luật Dân sự',
  e: 'e) Các khoản chi khác phục vụ trực tiếp hoạt động sản xuất, kinh doanh',
};
const CAT_LABEL_DNSN: Record<string, string> = { ...CAT_LABEL_HKD,
  c: 'c) Chi phí khấu hao tài sản cố định phục vụ cho hoạt động sản xuất, kinh doanh theo chế độ quản lý, sử dụng và trích khấu hao tài sản cố định',
  dd: 'đ) Chi phí trả lãi tiền vay vốn sản xuất, kinh doanh của tổ chức tín dụng' };

export async function frame(trx: Trx, tenantId: string, code: string, f: { from: string; to: string }, opts: { landscape?: boolean; subtitle?: string } = {}) {
  const regime = bookRegimeOf(code); if (!regime) throw new AppError('BOOK_NOT_FOUND', `Không có sổ ${code}`, 404);
  const set = loadBookSet(regime); const def = set.books.find((b) => b.code === code);
  if (!def) throw new AppError('BOOK_NOT_FOUND', `Không có sổ ${code}`, 404);
  if (!def.built) throw new AppError('BOOK_NOT_BUILT', `Chưa dựng sổ ${code}: ${def.reason ?? ''}`, 501);
  const c = await companyInfo(trx, tenantId, regime, null);
  const company = { ...c, formNo: code, issuedBy: set.issuedBy };
  const columns: ReportColumn[] = def.columns.map((x) => ({ key: x.key, label: `${x.label} (${x.ref})`, ...(x.type ? { type: x.type } : {}), ...(x.scale ? { scale: x.scale } : {}) }));
  const signers = regime === 'TT152'
    ? [{ title: 'NGƯỜI ĐẠI DIỆN HỘ KINH DOANH/ CÁ NHÂN KINH DOANH', note: '(Ký, ghi rõ họ tên và đóng dấu (nếu có))', name: c.legalRep ?? '' }]
    : [{ title: 'NGƯỜI LẬP BIỂU', note: '(Ký, ghi rõ họ tên)' }, { title: 'KẾ TOÁN TRƯỞNG', note: '(Ký, ghi rõ họ tên)', name: c.chiefAccountant ?? '' }, { title: 'NGƯỜI ĐẠI DIỆN THEO PHÁP LUẬT', note: '(Ký, ghi rõ họ tên, đóng dấu)', name: c.legalRep ?? '' }];
  const doc = (rows: Row[], extra: Partial<ReportDoc> = {}, columnsOverride?: ReportColumn[]): ReportDoc => ({ title: def.name, formNo: code, issuedBy: set.issuedBy, company, subtitle: opts.subtitle ?? periodSubtitle(f.from, f.to), columns: columnsOverride ?? columns, rows, signers, sheetName: code, ...(opts.landscape ? { landscape: true } : {}), ...extra });
  return { regime, set, def, doc, company };
}

export async function profitRateOf(trx: Trx, to: string) { const s = await getSetting(trx, await yearOf(trx, to)); return { rate: s.incomeTaxRate === null ? null : D(s.incomeTaxRate), method: s.taxMethod }; }
const missingRateNote = (groups: Grp[], which: 'vat' | 'income', label: string) => { const m = groups.filter((g) => (which === 'vat' ? g.vatRate : g.incomeRate) === null).map((g) => g.code); return m.length ? [`Chưa khai tỷ lệ ${label} cho nhóm ${m.join(', ')}: thuế của nhóm này tạm tính 0.`] : []; };

// Thuế đã nộp (tax_paid) trong khoảng, theo loại thuế.
export const paidOf = (ents: Ent[], t: 'vat' | 'income') => sumOf(ents.filter((e) => e.kind === 'tax_paid' && e.taxType === t));
// Số thuế còn phải nộp đầu kỳ: số dư đầu nhập tay (ngày không sau đầu kỳ) + thuế phát sinh các kỳ trước - thuế đã nộp các kỳ trước.
export async function openingTax(trx: Trx, from: string, t: 'vat' | 'income', method: string | null, rate: Decimal | null): Promise<Decimal> {
  const prev = dayBefore(from); const earlier = await loadEntries(trx, FAR_PAST, prev);
  const open = sumOf((await loadEntries(trx, FAR_PAST, from)).filter((e) => e.kind === 'opening' && e.openRef === (t === 'vat' ? 'vat_payable' : 'income_tax')));
  const acc = await taxAccrued(trx, FAR_PAST, prev, { profitRate: rate, profit: profitFlagFor(method) });
  return open.plus(t === 'vat' ? acc.vat : acc.income).minus(paidOf(earlier, t));
}

// ---- S1a-HKD: danh sách doanh thu, không chia nhóm ----
async function s1a(trx: Trx, tenantId: string, f: BookFilter) {
  const fr = await frame(trx, tenantId, 'S1a-HKD', f);
  const rows = (await loadEntries(trx, f.from, f.to)).filter((e) => e.kind === 'revenue');
  return fr.doc(rows.map((e) => ({ date: e.date, desc: e.desc, amount: S(e.amount) })), { footer: { desc: 'Tổng cộng', amount: S(sumOf(rows)) } });
}

// ---- Sổ doanh thu theo nhóm ngành nghề: S2a-HKD, S2b-HKD, S1-DNSN, S2a-DNSN, S3a-DNSN ----
const GROUP_SPEC: Record<string, { taxes: ('vat' | 'income')[]; incomeName: string; settle?: 'vat' | 'income'; letters?: boolean }> = {
  'S2a-HKD': { taxes: ['vat', 'income'], incomeName: 'TNCN' }, 'S2b-HKD': { taxes: ['vat'], incomeName: 'TNCN' },
  'S1-DNSN': { taxes: ['vat', 'income'], incomeName: 'TNDN' },
  'S2a-DNSN': { taxes: ['vat'], incomeName: 'TNDN', settle: 'vat', letters: true }, 'S3a-DNSN': { taxes: ['income'], incomeName: 'TNDN', settle: 'income', letters: true },
};
async function groupBook(trx: Trx, tenantId: string, code: string, f: BookFilter) {
  const spec = GROUP_SPEC[code]!; const fr = await frame(trx, tenantId, code, f);
  const ents = (await loadEntries(trx, f.from, f.to)); const groups = [...(await loadGroups(trx)).values()];
  const taxName = (t: 'vat' | 'income') => (t === 'vat' ? 'GTGT' : spec.incomeName);
  const rows: Row[] = []; const total = { vat: D(0), income: D(0) };
  const { rate, method } = await profitRateOf(trx, f.to);
  let opening = D(0);
  if (spec.settle) { opening = await openingTax(trx, f.from, spec.settle, method, rate); rows.push({ desc: `Số thuế ${taxName(spec.settle)} còn phải nộp đầu kỳ (1)`, amount: S(opening), isBold: true }, { desc: 'Số phát sinh trong kỳ', isBold: true }); }
  let n = 0;
  for (const g of groups) {
    const gEnts = ents.filter((e) => e.kind === 'revenue' && e.groupId === g.id); if (!gEnts.length) continue;
    n += 1; const lead = spec.letters ? String.fromCharCode(64 + n) : String(n);
    rows.push({ desc: `${lead}. ${code.endsWith('-HKD') ? 'Ngành nghề' : 'Nhóm hàng hóa, dịch vụ, ngành nghề'} ${g.name}`, isBold: true });
    for (const e of gEnts) rows.push({ docNo: e.docNo, date: e.date, desc: e.desc, amount: S(e.amount) });
    const rev = sumOf(gEnts); rows.push({ desc: `Tổng cộng (${n})`, amount: S(rev), isBold: true });
    for (const t of spec.taxes) { const v = pctTax(rev, t === 'vat' ? g.vatRate : g.incomeRate); total[t] = total[t].plus(v); rows.push({ desc: `Thuế ${taxName(t)}`, amount: S(v) }); }
  }
  const notes = spec.taxes.flatMap((t) => missingRateNote(groups.filter((g) => ents.some((e) => e.kind === 'revenue' && e.groupId === g.id)), t, `thuế ${taxName(t)}`));
  if (spec.settle) {
    const t = spec.settle; const paid = paidOf(ents, t);
    rows.push({ desc: `Tổng số thuế ${taxName(t)} phải nộp trong kỳ (2)`, amount: S(total[t]), isBold: true }, { desc: `Số thuế ${taxName(t)} đã nộp trong kỳ (3)`, amount: S(paid), isBold: true },
      { desc: `Số thuế ${taxName(t)} còn phải nộp cuối kỳ {(4)= (1) + (2) - (3)}`, amount: S(opening.plus(total[t]).minus(paid)), isBold: true });
  } else for (const t of spec.taxes) rows.push({ desc: `Tổng số thuế ${taxName(t)} phải nộp`, amount: S(total[t]), isBold: true });
  return fr.doc(rows, notes.length ? { outro: notes } : {});
}

// ---- Sổ chi tiết doanh thu, chi phí: S2c-HKD (thuế TNCN trên thu nhập) và S2b-DNSN (thuế TNDN) ----
async function incomeExpense(trx: Trx, tenantId: string, code: 'S2c-HKD' | 'S2b-DNSN', f: BookFilter) {
  const fr = await frame(trx, tenantId, code, f); const ents = await loadEntries(trx, f.from, f.to);
  const hkd = code === 'S2c-HKD'; const labels = hkd ? CAT_LABEL_HKD : CAT_LABEL_DNSN; const { rate, method } = await profitRateOf(trx, f.to);
  const revEnts = ents.filter((e) => e.kind === 'revenue' || (!hkd && e.kind === 'other_income')); const expEnts = ents.filter((e) => e.kind === 'expense');
  const rev = sumOf(revEnts); const exp = sumOf(expEnts); const rows: Row[] = [];
  let opening = D(0);
  if (!hkd) { opening = await openingTax(trx, f.from, 'income', method, rate); rows.push({ desc: 'Số thuế TNDN còn phải nộp đầu kỳ (1)', amount: S(opening), isBold: true }, { desc: 'Số phát sinh trong kỳ', isBold: true }); }
  rows.push({ desc: hkd ? '1. Doanh thu bán hàng hóa, dịch vụ' : '1. Doanh thu và thu nhập', amount: S(rev), isBold: true });
  for (const e of revEnts) rows.push({ docNo: e.docNo, date: e.date, desc: `- ${e.desc}`, amount: S(e.amount) });
  rows.push({ desc: hkd ? '2. Chi phí hợp lý' : '2. Chi phí', amount: S(exp), isBold: true });
  for (const cat of ['a', 'b', 'c', 'd', 'dd', 'e']) {
    const es = expEnts.filter((e) => e.cat === cat); rows.push({ desc: labels[cat], amount: S(sumOf(es)) });
    for (const e of es) rows.push({ docNo: e.docNo, date: e.date, desc: `- ${e.desc}`, amount: S(e.amount) });
  }
  const tax = profitTax(rev, exp, rate);
  const notes = rate === null ? [`Chưa khai thuế suất ${hkd ? 'TNCN' : 'TNDN'} trên thu nhập tính thuế cho năm này (Cài đặt năm): số thuế tạm tính 0.`] : [];
  if (hkd) rows.push({ desc: '3. Chênh lệch {(3) = (1) - (2)}', amount: S(rev.minus(exp)), isBold: true }, { desc: '4. Tổng số thuế TNCN phải nộp {(4) = (3) x thuế suất}', amount: S(tax), isBold: true });
  else { const paid = paidOf(ents, 'income'); rows.push({ desc: 'Tổng số thuế TNDN phải nộp trong kỳ (2)', amount: S(tax), isBold: true }, { desc: 'Số thuế TNDN đã nộp trong kỳ (3)', amount: S(paid), isBold: true }, { desc: 'Số thuế TNDN còn phải nộp cuối kỳ {(4)=(1) +(2) - (3)}', amount: S(opening.plus(tax).minus(paid)), isBold: true }); }
  return fr.doc(rows, { ...(notes.length ? { outro: notes } : {}), intro: ['Các dòng bắt đầu bằng dấu gạch ngang là chi tiết của dòng tổng ngay trên (không cộng lại).'] });
}

// ---- Sổ chi tiết tiền: S2e-HKD, S2d-DNSN ----
export const CASH_IN = new Set(['revenue', 'other_income', 'cash_in']); export const CASH_OUT = new Set(['expense', 'tax_paid', 'cash_out']);
async function cashBook(trx: Trx, tenantId: string, code: 'S2e-HKD' | 'S2d-DNSN', f: BookFilter) {
  const fr = await frame(trx, tenantId, code, f); const all = (await loadEntries(trx, FAR_PAST, f.to)).filter((e) => e.money);
  const accounts = [...new Set(all.map((e) => e.money!))].sort((a, b) => (a === 'TM' ? -1 : b === 'TM' ? 1 : a.localeCompare(b, 'vi')));
  const rows: Row[] = [];
  const block = (acc: string) => {
    const mine = all.filter((e) => e.money === acc); const label = acc === 'TM' ? 'Tiền mặt' : 'Tiền gửi';
    const openBal = mine.reduce((a, e) => (e.kind === 'opening' && e.openRef === 'cash' && e.date <= f.from ? a.plus(e.amount) : e.date < f.from && CASH_IN.has(e.kind) ? a.plus(e.amount) : e.date < f.from && CASH_OUT.has(e.kind) ? a.minus(e.amount) : a), D(0));
    rows.push({ desc: acc === 'TM' ? 'Tiền mặt' : `Ngân hàng ${acc}`, isBold: true }, { desc: `${label} ${acc === 'TM' ? 'tồn đầu kỳ' : 'tồn đầu kỳ'}`, in: S(openBal) });
    let tin = D(0); let tout = D(0);
    for (const e of mine.filter((x) => x.date >= f.from && x.date <= f.to)) {
      const isIn = CASH_IN.has(e.kind) || (e.kind === 'opening' && e.openRef === 'cash'); const isOut = CASH_OUT.has(e.kind);
      if (!isIn && !isOut) continue; // vat_*: không đi qua tiền
      if (e.kind === 'opening' && e.date <= f.from) continue;
      rows.push({ docNo: e.docNo, date: e.date, desc: e.desc, in: isIn ? S(e.amount) : '', out: isOut ? S(e.amount) : '' });
      if (isIn) tin = tin.plus(e.amount); else tout = tout.plus(e.amount);
    }
    rows.push({ desc: acc === 'TM' ? 'Tổng tiền thu vào trong kỳ' : 'Tổng tiền gửi vào trong kỳ', in: S(tin), isBold: true }, { desc: acc === 'TM' ? 'Tổng tiền chi ra trong kỳ' : 'Tổng tiền rút ra trong kỳ', out: S(tout), isBold: true },
      { desc: acc === 'TM' ? 'Tiền mặt tồn cuối kỳ' : 'Tiền gửi tồn cuối kỳ', in: S(openBal.plus(tin).minus(tout)), isBold: true });
  };
  if (accounts.includes('TM')) block('TM'); else rows.push({ desc: 'Tiền mặt', isBold: true }, { desc: 'Tiền mặt tồn đầu kỳ', in: '0' }, { desc: 'Tổng tiền thu vào trong kỳ', in: '0', isBold: true }, { desc: 'Tổng tiền chi ra trong kỳ', out: '0', isBold: true }, { desc: 'Tiền mặt tồn cuối kỳ', in: '0', isBold: true });
  const banks = accounts.filter((a) => a !== 'TM');
  rows.push({ desc: 'Tiền gửi không kỳ hạn', isBold: true }); for (const b of banks) block(b);
  return fr.doc(rows, { intro: ['Số dư đầu kỳ và tồn cuối kỳ ghi ở cột 1 (Thu/Gửi vào).'] });
}

// ---- Sổ chi tiết vật liệu, dụng cụ, sản phẩm, hàng hóa: S2d-HKD, S2c-DNSN. Đơn giá xuất kho theo công thức của thông tư tính theo từng tháng dương lịch ----
export interface Mv { id: number; itemId: number; date: string; docNo: string | null; desc: string; dir: string; qty: Decimal; price: Decimal | null }
// Giá bình quân từng tháng = (giá trị tồn đầu tháng + giá trị nhập trong tháng) / (số lượng tồn đầu tháng + số lượng nhập trong tháng); dòng xuất cuối cùng làm hết số lượng thì lấy phần giá trị còn lại.
export function stockCosting(mvs: Mv[]): { priceOf: Map<string, Decimal>; outAmt: Map<number, Decimal> } {
  const months = [...new Set(mvs.map((m) => m.date.slice(0, 7)))].sort();
  const priceOf = new Map<string, Decimal>(); const outAmt = new Map<number, Decimal>();
  let qOpen = D(0); let vOpen = D(0);
  for (const mo of months) {
    const inMs = mvs.filter((m) => m.date.slice(0, 7) === mo && m.dir !== 'out'); const outMs = mvs.filter((m) => m.date.slice(0, 7) === mo && m.dir === 'out');
    const inQ = inMs.reduce((a, m) => a.plus(m.qty), D(0)); const inV = inMs.reduce((a, m) => a.plus(m.qty.times(m.price!).toDecimalPlaces(0)), D(0));
    const den = qOpen.plus(inQ); const p = den.isZero() ? D(0) : vOpen.plus(inV).div(den); priceOf.set(mo, p);
    let outV = D(0); const outQ = outMs.reduce((a, m) => a.plus(m.qty), D(0));
    outMs.forEach((m, i) => { const last = i === outMs.length - 1 && qOpen.plus(inQ).minus(outQ).isZero(); const a = last ? vOpen.plus(inV).minus(outV) : m.qty.times(p).toDecimalPlaces(0); outAmt.set(m.id, a); outV = outV.plus(a); });
    qOpen = qOpen.plus(inQ).minus(outQ); vOpen = vOpen.plus(inV).minus(outV);
  }
  return { priceOf, outAmt };
}
export async function stockDocs(trx: Trx, tenantId: string, code: 'S2d-HKD' | 'S2c-DNSN', f: BookFilter): Promise<ReportDoc[]> {
  const fr = await frame(trx, tenantId, code, f, { landscape: true });
  let items = await trx.selectFrom('book_stock_item').selectAll().orderBy('code').execute(); if (f.itemId) items = items.filter((i) => i.id === f.itemId);
  const docs: ReportDoc[] = [];
  for (const it of items) {
    const mvs: Mv[] = (await trx.selectFrom('book_stock_move').selectAll().where('item_id', '=', it.id).where('move_date', '<=', f.to).orderBy('move_date').orderBy('id').execute())
      .map((m) => ({ id: m.id, itemId: m.item_id, date: m.move_date, docNo: m.doc_no, desc: m.description, dir: m.direction, qty: D(m.quantity), price: m.unit_price === null ? null : D(m.unit_price) }));
    const { priceOf, outAmt } = stockCosting(mvs);
    // Chạy tuần tự để có tồn sau từng dòng; dòng trước kỳ gộp vào số dư đầu kỳ.
    let q = D(0); let v = D(0); const rows: Row[] = []; let totIQ = D(0); let totIV = D(0); let totOQ = D(0); let totOV = D(0); let openRowAdded = false;
    const addOpen = () => { if (!openRowAdded) { openRowAdded = true; rows.unshift({ desc: 'Số dư đầu kỳ', stockQty: S(q), stockAmt: S(v), isBold: true }); } };
    for (const m of mvs) {
      const inRange = m.date >= f.from; const isOut = m.dir === 'out';
      const amt = isOut ? outAmt.get(m.id)! : m.qty.times(m.price!).toDecimalPlaces(0);
      if (inRange) addOpen();
      if (isOut) { q = q.minus(m.qty); v = v.minus(amt); } else { q = q.plus(m.qty); v = v.plus(amt); }
      if (!inRange) continue;
      if (isOut) { totOQ = totOQ.plus(m.qty); totOV = totOV.plus(amt); } else { totIQ = totIQ.plus(m.qty); totIV = totIV.plus(amt); }
      rows.push({ docNo: m.docNo, date: m.date, desc: m.desc, unit: it.unit, price: S(isOut ? priceOf.get(m.date.slice(0, 7))! : m.price!), ...(isOut ? { outQty: S(m.qty), outAmt: S(amt) } : { inQty: S(m.qty), inAmt: S(amt) }), stockQty: S(q), stockAmt: S(v) });
    }
    addOpen();
    rows.push({ desc: 'Cộng phát sinh trong kỳ', inQty: S(totIQ), inAmt: S(totIV), outQty: S(totOQ), outAmt: S(totOV), isBold: true }, { desc: 'Số dư cuối kỳ', stockQty: S(q), stockAmt: S(v), isBold: true });
    docs.push(fr.doc(rows, { sheetName: `${code} ${it.code}`.slice(0, 28), intro: [`Tên vật liệu, dụng cụ, sản phẩm, hàng hóa: ${it.code} - ${it.name}${it.warehouse ? `. Kho: ${it.warehouse}` : ''}`] }));
  }
  if (!docs.length) docs.push(fr.doc([], { intro: ['Chưa có mặt hàng nào.'] }));
  return docs;
}

// ---- Sổ theo dõi nghĩa vụ thuế GTGT: S3b-DNSN ----
async function s3b(trx: Trx, tenantId: string, f: BookFilter) {
  const fr = await frame(trx, tenantId, 'S3b-DNSN', f); const ents = await loadEntries(trx, f.from, f.to); const earlier = await loadEntries(trx, FAR_PAST, dayBefore(f.from));
  const opens = (await loadEntries(trx, FAR_PAST, f.from)).filter((e) => e.kind === 'opening');
  const net = (xs: Ent[], openingEnts: Ent[]) => sumOf(openingEnts.filter((e) => e.openRef === 'vat_payable')).minus(sumOf(openingEnts.filter((e) => e.openRef === 'vat_credit')))
    .plus(sumOf(xs.filter((e) => e.kind === 'vat_output'))).minus(sumOf(xs.filter((e) => e.kind === 'vat_input'))).minus(paidOf(xs, 'vat')).plus(sumOf(xs.filter((e) => e.kind === 'vat_refund')));
  const open = net(earlier, opens);
  const rows: Row[] = [{ desc: 'Số dư đầu kỳ', isBold: true }, { desc: 'Số thuế GTGT còn được khấu trừ hoặc được hoàn đầu kỳ', vatIn: S(open.isNegative() ? open.neg() : D(0)) }, { desc: 'Số thuế GTGT còn phải nộp đầu kỳ', vatOut: S(open.isPositive() ? open : D(0)) }, { desc: 'Số phát sinh trong kỳ', isBold: true }];
  let tin = D(0); let tout = D(0);
  for (const e of ents.filter((x) => x.kind === 'vat_input' || x.kind === 'vat_output')) { rows.push({ docNo: e.docNo, date: e.date, desc: e.desc, ...(e.kind === 'vat_input' ? { vatIn: S(e.amount) } : { vatOut: S(e.amount) }) }); if (e.kind === 'vat_input') tin = tin.plus(e.amount); else tout = tout.plus(e.amount); }
  const paid = paidOf(ents, 'vat'); const refunded = sumOf(ents.filter((e) => e.kind === 'vat_refund'));
  const dueMonth = tout.minus(tin);
  const close = open.plus(tout).minus(tin).minus(paid).plus(refunded);
  rows.push({ desc: 'Cộng số phát sinh trong kỳ', vatIn: S(tin), vatOut: S(tout), isBold: true }, { desc: 'Tổng số thuế GTGT phải nộp trong kỳ (2)', vatOut: S(dueMonth.isNegative() ? D(0) : dueMonth), isBold: true },
    { desc: 'Số thuế GTGT đã nộp trong kỳ (3)', vatOut: S(paid) }, { desc: 'Số thuế GTGT đã được hoàn trong kỳ (4)', vatOut: S(refunded) }, { desc: 'Số dư cuối kỳ', isBold: true },
    { desc: 'Số thuế GTGT còn được khấu trừ hoặc được hoàn cuối kỳ', vatIn: S(close.isNegative() ? close.neg() : D(0)), isBold: true }, { desc: 'Số thuế GTGT còn phải nộp cuối kỳ', vatOut: S(close.isPositive() ? close : D(0)), isBold: true });
  return fr.doc(rows, { intro: ['Các dòng số thuế phải nộp, đã nộp, đã hoàn trong kỳ ghi ở cột 2.'] });
}

// ---- Sổ theo dõi nghĩa vụ thuế khác: S3a-HKD, S4c-DNSN ----
export interface OtherTaxCalc { pct: Decimal; abs: Decimal; xnk: Decimal; env: Decimal; res: Decimal; land: Decimal; other: Decimal }
export function calcOtherTax(r: { taxKind: string; quantity: string | null; absRate: string | null; unitPrice: string | null; ratePct: string | null; otherAmount: string | null }): OtherTaxCalc {
  const z = D(0); const c: OtherTaxCalc = { pct: z, abs: z, xnk: z, env: z, res: z, land: z, other: z };
  const q = D(r.quantity ?? '0'); const ab = D(r.absRate ?? '0'); const up = D(r.unitPrice ?? '0'); const rt = D(r.ratePct ?? '0');
  const roundVnd = (x: Decimal) => x.toDecimalPlaces(0);
  if (r.taxKind === 'xnk_ttdb') { c.pct = r.ratePct === null ? z : roundVnd(q.times(up).times(rt).div(100)); c.abs = r.absRate === null ? z : roundVnd(q.times(ab)); c.xnk = c.pct.plus(c.abs); }
  else if (r.taxKind === 'env') c.env = roundVnd(q.times(ab));
  else if (r.taxKind === 'resource') c.res = roundVnd(q.times(up).times(rt).div(100));
  else if (r.taxKind === 'land') c.land = roundVnd(q.times(up).times(rt).div(100));
  else c.other = D(r.otherAmount ?? '0');
  return c;
}
async function otherTax(trx: Trx, tenantId: string, code: 'S3a-HKD' | 'S4c-DNSN', f: BookFilter) {
  const fr = await frame(trx, tenantId, code, f, { landscape: true });
  const rs = await trx.selectFrom('book_other_tax').selectAll().where('entry_date', '>=', f.from).where('entry_date', '<=', f.to).orderBy('entry_date').orderBy('id').execute();
  const tot: OtherTaxCalc = { pct: D(0), abs: D(0), xnk: D(0), env: D(0), res: D(0), land: D(0), other: D(0) };
  const rows: Row[] = rs.map((r) => {
    const c = calcOtherTax({ taxKind: r.tax_kind, quantity: r.quantity, absRate: r.abs_rate, unitPrice: r.unit_price, ratePct: r.rate_pct, otherAmount: r.other_amount });
    for (const k of Object.keys(tot) as (keyof OtherTaxCalc)[]) tot[k] = tot[k].plus(c[k]);
    const dash = (x: string | null) => x ?? '';
    return { date: r.entry_date, desc: r.description, qty: dash(r.quantity), absRate: dash(r.abs_rate), unitPrice: dash(r.unit_price), rate: dash(r.rate_pct), pct: S(c.pct), abs: S(c.abs), xnk: S(c.xnk), env: S(c.env), res: S(c.res), land: S(c.land), ...(code === 'S4c-DNSN' ? { other: S(c.other) } : {}) };
  });
  return fr.doc(rows, { footer: { desc: 'Tổng cộng', pct: S(tot.pct), abs: S(tot.abs), xnk: S(tot.xnk), env: S(tot.env), res: S(tot.res), land: S(tot.land), ...(code === 'S4c-DNSN' ? { other: S(tot.other) } : {}) } });
}

// ---- B02-DNSN: Báo cáo kết quả hoạt động kinh doanh (năm nay, năm trước) ----
export async function b02(trx: Trx, tenantId: string, f: BookFilter): Promise<ReportDoc> {
  const set = loadBookSet('TT58'); const rep = set.reports.find((r) => r.code === 'B02-DNSN')!;
  const c = await companyInfo(trx, tenantId, 'TT58', null); const company = { ...c, formNo: 'B02 - DNSN', issuedBy: set.issuedBy };
  const calc = async (from: string, to: string) => {
    const ents = await loadEntries(trx, from, to); const { rate } = await profitRateOf(trx, to);
    const rev = sumOf(ents.filter((e) => e.kind === 'revenue' || e.kind === 'other_income')); const exp = sumOf(ents.filter((e) => e.kind === 'expense'));
    const pre = rev.minus(exp); const tax = profitTax(rev, exp, rate);
    return { '01': rev, '02': exp, '03': pre, '10': tax, '20': pre.minus(tax), rateMissing: rate === null };
  };
  const cur = await calc(f.from, f.to); const prev = await calc(yearBack(f.from), yearBack(f.to));
  const rows: Row[] = rep.lines.map((l) => ({ label: l.label, code: l.lineNo, cur: S(cur[l.lineNo as '01']), prev: S(prev[l.lineNo as '01']), isBold: l.lineNo === '03' || l.lineNo === '20' }));
  const cols: ReportColumn[] = [{ key: 'label', label: 'CHỈ TIÊU (1)' }, { key: 'code', label: 'Mã số (2)', width: '10%' }, { key: 'cur', label: 'Năm nay (3)', type: 'number', width: '20%' }, { key: 'prev', label: 'Năm trước (4)', type: 'number', width: '20%' }];
  const notes = cur.rateMissing ? ['Chưa khai thuế suất TNDN trên thu nhập tính thuế cho năm này (Cài đặt năm): chi phí thuế TNDN tạm tính 0.'] : [];
  return { title: rep.name, formNo: 'B02 - DNSN', issuedBy: set.issuedBy, company, subtitle: `Năm ${f.to.slice(0, 4)} (từ ngày ${formatVnDate(f.from)} đến ngày ${formatVnDate(f.to)})`, columns: cols, rows, sheetName: 'B02-DNSN', ...(notes.length ? { outro: notes } : {}),
    signers: [{ title: 'NGƯỜI LẬP BIỂU', note: '(Ký, ghi rõ họ tên)' }, { title: 'KẾ TOÁN TRƯỞNG', note: '(Ký, ghi rõ họ tên)', name: c.chiefAccountant ?? '' }, { title: 'NGƯỜI ĐẠI DIỆN THEO PHÁP LUẬT', note: '(Ký, ghi rõ họ tên, đóng dấu)', name: c.legalRep ?? '' }] };
}

export async function buildBook(trx: Trx, tenantId: string, code: string, f: BookFilter): Promise<ReportDoc[]> {
  switch (code) {
    case 'S1a-HKD': return [await s1a(trx, tenantId, f)];
    case 'S2a-HKD': case 'S2b-HKD': case 'S1-DNSN': case 'S2a-DNSN': case 'S3a-DNSN': return [await groupBook(trx, tenantId, code, f)];
    case 'S2c-HKD': case 'S2b-DNSN': return [await incomeExpense(trx, tenantId, code, f)];
    case 'S2e-HKD': case 'S2d-DNSN': return [await cashBook(trx, tenantId, code, f)];
    case 'S2d-HKD': case 'S2c-DNSN': return stockDocs(trx, tenantId, code, f);
    case 'S3b-DNSN': return [await s3b(trx, tenantId, f)];
    case 'S3a-HKD': case 'S4c-DNSN': return [await otherTax(trx, tenantId, code, f)];
    case 'B02-DNSN': return [await b02(trx, tenantId, f)];
    default: {
      const regime = bookRegimeOf(code);
      if (regime && (loadBookSet(regime).books.some((b) => b.code === code) || loadBookSet(regime).reports.some((r) => r.code === code))) throw new AppError('BOOK_NOT_BUILT', `Chưa dựng ${code}`, 501);
      throw new AppError('BOOK_NOT_FOUND', `Không có sổ ${code}`, 404);
    }
  }
}

// Danh mục sổ và báo cáo của chế độ theo phương pháp nộp thuế đã chọn cho năm.
export interface CatalogItem { code: string; name: string; article: string; built: boolean; required: boolean; reason: string | null; kind: 'book' | 'report' }
export interface CatalogVoucher { code: string; name: string; article: string; built: boolean }
export async function catalog(trx: Trx, regime: BookRegime, year: number): Promise<{ regime: BookRegime; regimeLabel: string; fiscalYear: number; taxMethod: string | null; methods: BookSetDef['methods']; items: CatalogItem[]; vouchers: CatalogVoucher[] }> {
  const set = loadBookSet(regime); const st = await getSetting(trx, year); const m = set.methods.find((x) => x.code === st.taxMethod);
  const required = new Set(m?.books ?? []);
  const items: CatalogItem[] = [
    ...set.books.map((b: BookDef) => ({ code: b.code, name: b.name, article: b.article, built: b.built, required: required.has(b.code), reason: b.reason ?? null, kind: 'book' as const })),
    ...set.reports.map((r) => ({ code: r.code, name: r.name, article: r.article, built: r.built, required: false, reason: r.reason ?? null, kind: 'report' as const })),
  ];
  return { regime, regimeLabel: regime === 'TT152' ? 'TT 152/2025/TT-BTC (hộ kinh doanh)' : 'TT 58/2026/TT-BTC (doanh nghiệp siêu nhỏ)', fiscalYear: year, taxMethod: st.taxMethod, methods: set.methods, items, vouchers: (set.vouchers ?? []).map((v) => ({ code: v.code, name: v.name, article: v.article, built: v.built })) };
}
