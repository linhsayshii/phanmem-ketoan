import { D, formatVnDate, vnd, type Decimal } from '@kt/domain';
import { loadBookSet } from '@kt/coa-data';
import { AppError } from '../../plugins/errors.js';
import type { ReportColumn, ReportDoc } from '../reporting/print/html.js';
import { companyInfo } from '../reporting/print/bookSet.js';
import { b02, buildBook, CASH_IN, CASH_OUT, FAR_PAST, frame, openingTax, paidOf, S, stockCosting, type BookFilter, type Mv, type Row } from './books.js';
import { dayBefore, getSetting, loadEntries, profitFlagFor, sumOf, taxAccrued, yearBack, yearOf, type Ent, type Trx } from './service.js';

// Sổ S4a, S4b, S4d và báo cáo B01-DNSN của TT 58/2026 (Điều 9 khoản 1.1, 1.2, 1.4; Điều 10 khoản 2.2.1). Dữ liệu ở book_debt, book_fixed_asset, book_equity, book_other_asset (0291).
export type DebtSide = 'recv' | 'pay';
// sides: bên công nợ người dùng được xem (cờ view_receivable, view_payable); bỏ trống là cả hai.
export interface DnsnFilter extends BookFilter { party?: string | undefined; sides?: DebtSide[] | undefined }
const sheetSafe = (s: string) => s.replace(/[:\\/?*[\]]/g, ' ').slice(0, 28);
const viSort = (a: string, b: string) => a.localeCompare(b, 'vi');

// ---- S4a: sổ chi tiết thanh toán công nợ, mỗi đối tượng một sổ ----
interface Debt { id: number; date: string; docNo: string | null; desc: string; party: string; side: 'recv' | 'pay'; kind: string; nature: string; amount: Decimal }
async function loadDebts(trx: Trx, to: string): Promise<Debt[]> {
  return (await trx.selectFrom('book_debt').selectAll().where('entry_date', '<=', to).orderBy('entry_date').orderBy('id').execute())
    .map((r) => ({ id: r.id, date: r.entry_date, docNo: r.doc_no, desc: r.description, party: r.party, side: r.side as 'recv' | 'pay', kind: r.kind, nature: r.nature, amount: D(r.amount) }));
}
// Số dư đầu kỳ gồm bút `opening` ngày không sau đầu kỳ và mọi phát sinh trước đầu kỳ; `opening` ngày sau đầu kỳ tính là phát sinh tăng trong kỳ (như sổ tiền, QĐ 1507).
const debtOpens = (e: Debt, from: string) => (e.kind === 'opening' ? e.date <= from : e.date < from);
const signed = (e: Debt) => (e.kind === 'settle' ? e.amount.neg() : e.amount);
const balanceOf = (es: Debt[], side: 'recv' | 'pay') => es.filter((e) => e.side === side).reduce((a, e) => a.plus(signed(e)), D(0));

async function s4a(trx: Trx, tenantId: string, f: DnsnFilter): Promise<ReportDoc[]> {
  const fr = await frame(trx, tenantId, 'S4a-DNSN', f, { landscape: true });
  const all = (await loadDebts(trx, f.to)).filter((e) => !f.sides || f.sides.includes(e.side));
  const parties = [...new Set(all.map((e) => e.party))].filter((p) => !f.party || p === f.party).sort(viSort);
  const docs: ReportDoc[] = [];
  parties.forEach((party, idx) => {
    const mine = all.filter((e) => e.party === party);
    const open = mine.filter((e) => debtOpens(e, f.from)); const inRange = mine.filter((e) => !debtOpens(e, f.from));
    let recv = balanceOf(open, 'recv'); let pay = balanceOf(open, 'pay');
    const rows: Row[] = [{ desc: 'Số dư đầu kỳ', recvLeft: S(recv), payLeft: S(pay), isBold: true }, { desc: 'Số phát sinh trong kỳ', isBold: true }];
    const tot = { recv: D(0), recvPaid: D(0), pay: D(0), payPaid: D(0) };
    for (const e of inRange) {
      const settle = e.kind === 'settle'; const col = e.side === 'recv' ? (settle ? 'recvPaid' : 'recv') : (settle ? 'payPaid' : 'pay');
      tot[col] = tot[col].plus(e.amount);
      if (e.side === 'recv') recv = recv.plus(signed(e)); else pay = pay.plus(signed(e));
      rows.push({ docNo: e.docNo, date: e.date, desc: e.desc, [col]: S(e.amount), ...(e.side === 'recv' ? { recvLeft: S(recv) } : { payLeft: S(pay) }) });
    }
    rows.push({ desc: 'Cộng số phát sinh trong kỳ', recv: S(tot.recv), recvPaid: S(tot.recvPaid), pay: S(tot.pay), payPaid: S(tot.payPaid), isBold: true }, { desc: 'Số dư cuối kỳ', recvLeft: S(recv), payLeft: S(pay), isBold: true });
    docs.push(fr.doc(rows, { sheetName: sheetSafe(`S4a ${idx + 1} ${party}`), intro: [`Đối tượng: ${party}`, 'Đơn vị tính: đồng Việt Nam'] }));
  });
  if (!docs.length) docs.push(fr.doc([], { intro: ['Chưa có khoản công nợ nào.'] }));
  return docs;
}

// ---- S4b: sổ tài sản cố định, mỗi loại tài sản một sổ ----
interface Fa { id: number; type: string; name: string; incDocNo: string | null; incDate: string; inUse: string; cost: Decimal; rate: Decimal; decDocNo: string | null; decDate: string | null; decReason: string | null }
async function loadAssets(trx: Trx, to: string): Promise<Fa[]> {
  return (await trx.selectFrom('book_fixed_asset').selectAll().where('inc_date', '<=', to).orderBy('asset_type').orderBy('inc_date').orderBy('id').execute())
    .map((r) => ({ id: r.id, type: r.asset_type, name: r.name, incDocNo: r.inc_doc_no, incDate: r.inc_date, inUse: String(r.in_use_month).slice(0, 7), cost: D(r.cost), rate: D(r.dep_rate), decDocNo: r.dec_doc_no, decDate: r.dec_date, decReason: r.dec_reason }));
}
const monthIdx = (iso: string) => Number(iso.slice(0, 4)) * 12 + Number(iso.slice(5, 7)) - 1;
const isMonthEnd = (iso: string) => { const [y, m, d] = iso.split('-').map(Number) as [number, number, number]; return d === new Date(Date.UTC(y, m, 0)).getUTCDate(); };
// Số tháng đã trích khấu hao đến hết ngày `d`: tính tròn tháng, từ tháng đưa vào sử dụng, tháng chưa kết thúc tại `d` chưa tính, thôi từ tháng ghi giảm (quyết định 1624).
export function depMonths(inUse: string, decDate: string | null, d: string): number {
  let last = isMonthEnd(d) ? monthIdx(d) : monthIdx(d) - 1;
  if (decDate && decDate <= d) last = Math.min(last, monthIdx(decDate) - 1);
  return Math.max(0, last - monthIdx(inUse) + 1);
}
// Khấu hao lũy kế (đường thẳng theo tỷ lệ hằng năm), làm tròn nửa lên đến đồng và không vượt nguyên giá.
export function accumulatedDep(a: { cost: Decimal; rate: Decimal; inUse: string; decDate: string | null }, d: string): Decimal {
  const v = vnd(a.cost.times(a.rate).div(100).times(depMonths(a.inUse, a.decDate, d)).div(12));
  return v.gt(a.cost) ? a.cost : v;
}
const decidedBy = (a: Fa, d: string) => a.decDate !== null && a.decDate <= d;

async function s4b(trx: Trx, tenantId: string, f: DnsnFilter): Promise<ReportDoc[]> {
  const fr = await frame(trx, tenantId, 'S4b-DNSN', f, { landscape: true });
  const assets = (await loadAssets(trx, f.to)).filter((a) => a.decDate === null || a.decDate >= f.from);
  const types = [...new Set(assets.map((a) => a.type))].sort(viSort); const before = dayBefore(f.from);
  const docs: ReportDoc[] = types.map((type, idx) => {
    const rows: Row[] = []; const tot = { dep: D(0), acc: D(0) };
    for (const a of assets.filter((x) => x.type === type)) {
      const acc = accumulatedDep(a, f.to); const dep = acc.minus(accumulatedDep(a, before));
      tot.dep = tot.dep.plus(dep); tot.acc = tot.acc.plus(acc);
      const dec = decidedBy(a, f.to);
      rows.push({ incDocNo: a.incDocNo, incDate: a.incDate, name: a.name, inUse: `${a.inUse.slice(5)}/${a.inUse.slice(0, 4)}`, cost: S(a.cost), depRate: S(a.rate), dep: S(dep), accDep: S(acc), ...(dec ? { decDocNo: a.decDocNo, decDate: a.decDate, decReason: a.decReason } : {}) });
    }
    // Dòng Cộng của mẫu: các ô Tháng, năm đưa vào sử dụng, Nguyên giá (cột 1) và ba cột ghi giảm đánh dấu x (không ghi); chỉ cột 2, 3, 4 để trống (bản .docx của thông tư). Tỷ lệ khấu hao (cột 2) không cộng được nên để trống.
    rows.push({ name: 'Cộng', dep: S(tot.dep), accDep: S(tot.acc), isBold: true });
    return fr.doc(rows, { sheetName: sheetSafe(`S4b ${idx + 1} ${type}`), intro: [`Loại tài sản: ${type}`, 'Khấu hao tính tròn tháng theo tỷ lệ hằng năm, từ tháng đưa vào sử dụng, thôi từ tháng ghi giảm.'] });
  });
  if (!docs.length) docs.push(fr.doc([], { intro: ['Chưa có tài sản cố định nào.'] }));
  return docs;
}

// ---- S4d: sổ theo dõi vốn chủ sở hữu ----
interface Eq { id: number; date: string; docNo: string | null; desc: string; section: string; kind: string; amount: Decimal }
async function loadEquity(trx: Trx, to: string): Promise<Eq[]> {
  return (await trx.selectFrom('book_equity').selectAll().where('entry_date', '<=', to).orderBy('entry_date').orderBy('id').execute())
    .map((r) => ({ id: r.id, date: r.entry_date, docNo: r.doc_no, desc: r.description, section: r.section, kind: r.kind, amount: D(r.amount) }));
}
const eqSigned = (e: Eq) => (e.kind === 'decrease' ? e.amount.neg() : e.amount);
const eqOpens = (e: Eq, from: string) => (e.kind === 'opening' ? e.date <= from : e.date < from);
const EQ_TITLE: Record<string, string> = { capital: '1. Vốn góp của chủ sở hữu', retained: '2. Lợi nhuận sau thuế chưa phân phối', funds: '3. Các quỹ thuộc vốn chủ sở hữu' };

async function s4d(trx: Trx, tenantId: string, f: DnsnFilter): Promise<ReportDoc[]> {
  const fr = await frame(trx, tenantId, 'S4d-DNSN', f);
  const all = await loadEquity(trx, f.to); const rows: Row[] = [];
  for (const [sec, no] of [['capital', 1], ['retained', 2], ['funds', 3]] as const) {
    const mine = all.filter((e) => e.section === sec); const open = mine.filter((e) => eqOpens(e, f.from)); const inRange = mine.filter((e) => !eqOpens(e, f.from));
    let bal = open.reduce((a, e) => a.plus(eqSigned(e)), D(0));
    rows.push({ desc: EQ_TITLE[sec], isBold: true }, { desc: `${no}.1. Số dư đầu kỳ`, bal: S(bal) }, { desc: `${no}.2. Phát sinh trong kỳ` });
    for (const e of inRange) { bal = bal.plus(eqSigned(e)); rows.push({ docNo: e.docNo, date: e.date, desc: e.desc, ...(e.kind === 'decrease' ? { dec: S(e.amount) } : { inc: S(e.amount) }) }); }
    rows.push({ desc: `${no}.3. Số dư cuối kỳ`, bal: S(bal), isBold: true });
  }
  return [fr.doc(rows, { intro: ['Đơn vị tính: đồng Việt Nam. Lợi nhuận sau thuế chưa phân phối âm là lỗ lũy kế.'] })];
}

// ---- B01-DNSN: báo cáo tình hình tài chính ----
export interface B01Position { l110: Decimal; l120: Decimal; l130: Decimal; l140: Decimal; l150: Decimal; l310: Decimal; l320: Decimal; l410: Decimal; l420: Decimal; l430: Decimal; notes: string[] }
const isDeductVat = (m: string) => m === 'vat_deduct_cit_percent' || m === 'vat_deduct_cit_profit';

// Mốc cắt của một cột B01: bút "số dư đầu" tính đến ngày `open`, mọi bút khác tính đến ngày `other`. Số cuối năm: cả hai là ngày lập; số đầu năm: `open` là ngày đầu năm
// (số dư đầu nhập ở ngày đầu năm chính là số đầu năm, cùng quy ước đầu kỳ của các sổ, QĐ 1621), `other` là ngày liền trước đó.
export interface Cut { open: string; other: string }
const upTo = <T extends { date: string; kind: string }>(xs: T[], cut: Cut): T[] => xs.filter((e) => (e.kind === 'opening' ? e.date <= cut.open : e.date <= cut.other));

// Thuế GTGT hoặc TNDN còn phải nộp tại mốc `cut` của năm bắt đầu `yearStart`: số đầu năm (bút opening và thuế phát sinh, đã nộp các năm trước, như các sổ thuế) + phát sinh trong năm - đã nộp trong năm.
async function taxPayable(trx: Trx, t: 'vat' | 'income', cut: Cut, yearStart: string, method: string, rate: Decimal | null): Promise<Decimal> {
  const early = cut.other < yearStart;
  const ents = early ? [] : upTo(await loadEntries(trx, yearStart, cut.open), cut);
  const start = await openingTax(trx, yearStart, t, method, rate);
  const accrued = early ? D(0) : (await taxAccrued(trx, yearStart, cut.other, { profitRate: rate, profit: profitFlagFor(method) }))[t];
  const ref = t === 'vat' ? 'vat_payable' : 'income_tax';
  const laterOpen = sumOf(ents.filter((e) => e.kind === 'opening' && e.openRef === ref && e.date > yearStart));
  return start.plus(accrued).plus(laterOpen).minus(paidOf(ents, t));
}
// Thuế GTGT khấu trừ: số dư ròng (dương = còn phải nộp, âm = còn được khấu trừ), cùng công thức S3b-DNSN (QĐ 1506).
function vatDeductNet(ents: Ent[]): Decimal {
  const open = (ref: string) => sumOf(ents.filter((e) => e.kind === 'opening' && e.openRef === ref));
  return open('vat_payable').minus(open('vat_credit')).plus(sumOf(ents.filter((e) => e.kind === 'vat_output'))).minus(sumOf(ents.filter((e) => e.kind === 'vat_input'))).minus(paidOf(ents, 'vat')).plus(sumOf(ents.filter((e) => e.kind === 'vat_refund')));
}
// Giá trị tồn kho tại mốc `cut` của mọi mặt hàng: cùng công thức bình quân tháng của S2c-DNSN (stockCosting), một truy vấn cho cả công ty.
async function stockValue(trx: Trx, cut: Cut): Promise<Decimal> {
  const rows = await trx.selectFrom('book_stock_move').selectAll().where('move_date', '<=', cut.open).orderBy('move_date').orderBy('id').execute();
  const byItem = new Map<number, Mv[]>();
  for (const m of rows) {
    if (m.direction !== 'opening' && m.move_date > cut.other) continue;
    const mv: Mv = { id: m.id, itemId: m.item_id, date: m.move_date, docNo: m.doc_no, desc: m.description, dir: m.direction, qty: D(m.quantity), price: m.unit_price === null ? null : D(m.unit_price) };
    (byItem.get(m.item_id) ?? byItem.set(m.item_id, []).get(m.item_id)!).push(mv);
  }
  let total = D(0);
  for (const mvs of byItem.values()) {
    const { outAmt } = stockCosting(mvs);
    for (const m of mvs) total = total.plus(m.dir === 'out' ? outAmt.get(m.id)!.neg() : m.qty.times(m.price!).toDecimalPlaces(0));
  }
  return total;
}

export async function b01Position(trx: Trx, cut: Cut, yearStart: string, method: string, rate: Decimal | null): Promise<B01Position> {
  const notes: string[] = []; const ents = upTo(await loadEntries(trx, FAR_PAST, cut.open), cut);
  // 110: số dư cuối kỳ Sổ chi tiết tiền (tiền mặt và tiền gửi không kỳ hạn)
  const l110 = ents.filter((e) => e.money).reduce((a, e) => (e.kind === 'opening' ? (e.openRef === 'cash' ? a.plus(e.amount) : a) : CASH_IN.has(e.kind) ? a.plus(e.amount) : CASH_OUT.has(e.kind) ? a.minus(e.amount) : a), D(0));
  // 130: số dư cuối kỳ của mọi mặt hàng trên sổ vật liệu, dụng cụ, sản phẩm, hàng hóa
  const l130 = await stockValue(trx, cut);
  // 120, 310 và thuế khác trong 320: S4a
  const debts = upTo(await loadDebts(trx, cut.open), cut);
  const sideBal = (side: 'recv' | 'pay', tax: boolean) => debts.filter((e) => e.side === side && (e.nature === 'tax') === tax).reduce((a, e) => a.plus(signed(e)), D(0));
  const byParty = new Map<string, Decimal>();
  for (const e of debts) { const k = `${e.party}\u0000${e.side}`; byParty.set(k, (byParty.get(k) ?? D(0)).plus(signed(e))); }
  const negative = [...byParty.entries()].filter(([, v]) => v.isNegative()).map(([k]) => k.split('\u0000')[0]!);
  if (negative.length) notes.push(`Sổ S4a có đối tượng dư âm (đã thu, đã trả vượt số phải thu, phải trả): ${[...new Set(negative)].join(', ')}. Số âm được cộng trừ thẳng vào mã 120, 310, 320; cần rà soát.`);
  let l120 = sideBal('recv', false); const l310 = sideBal('pay', false); let l320 = sideBal('pay', true);
  // Thuế GTGT: khấu trừ (S3b-DNSN) hay theo tỷ lệ % (sổ doanh thu)
  const vat = isDeductVat(method) ? vatDeductNet(ents) : await taxPayable(trx, 'vat', cut, yearStart, method, rate);
  if (vat.isNegative()) l120 = l120.plus(vat.neg()); else l320 = l320.plus(vat);
  // Thuế TNDN: nộp thừa so với phải nộp là tài sản khác (hướng dẫn mã 150)
  const cit = await taxPayable(trx, 'income', cut, yearStart, method, rate);
  let l150 = D(0);
  if (cit.isNegative()) l150 = l150.plus(cit.neg()); else l320 = l320.plus(cit);
  const other = upTo((await trx.selectFrom('book_other_asset').selectAll().where('entry_date', '<=', cut.open).execute()).map((r) => ({ date: r.entry_date, kind: r.kind, amount: D(r.amount) })), cut);
  l150 = other.reduce((a, r) => (r.kind === 'decrease' ? a.minus(r.amount) : a.plus(r.amount)), l150);
  // 140: giá trị còn lại (nguyên giá - khấu hao lũy kế) của TSCĐ chưa ghi giảm
  const assets = (await loadAssets(trx, cut.other)).filter((a) => !decidedBy(a, cut.other));
  const l140 = assets.reduce((a, x) => a.plus(x.cost.minus(accumulatedDep(x, cut.other))), D(0));
  // 410, 420, 430: S4d
  const eq = upTo(await loadEquity(trx, cut.open), cut); const sec = (s: string) => eq.filter((e) => e.section === s).reduce((a, e) => a.plus(eqSigned(e)), D(0));
  return { l110, l120, l130, l140, l150, l310, l320, l410: sec('capital'), l420: sec('retained'), l430: sec('funds'), notes };
}

const sumAssets = (p: B01Position) => p.l110.plus(p.l120).plus(p.l130).plus(p.l140).plus(p.l150);
const sumLiab = (p: B01Position) => p.l310.plus(p.l320);
const sumEquity = (p: B01Position) => p.l410.plus(p.l420).plus(p.l430);
export const b01Totals = (p: B01Position) => ({ '200': sumAssets(p), '300': sumLiab(p), '400': sumEquity(p), '500': sumLiab(p).plus(sumEquity(p)) });

export async function b01(trx: Trx, tenantId: string, f: DnsnFilter): Promise<ReportDoc> {
  const set = loadBookSet('TT58'); const rep = set.reports.find((r) => r.code === 'B01-DNSN')!;
  if (!rep.built) throw new AppError('BOOK_NOT_BUILT', 'Chưa dựng B01-DNSN', 501);
  const st = await getSetting(trx, await yearOf(trx, f.to));
  if (!st.taxMethod) throw new AppError('TAX_METHOD_MISSING', 'Chọn phương pháp nộp thuế của năm ở tab Cài đặt năm để lập B01-DNSN (cách tính thuế phải nộp phụ thuộc phương pháp)', 409);
  const method = st.taxMethod; const rate = st.incomeTaxRate === null ? null : D(st.incomeTaxRate);
  // Số đầu năm, thuế phát sinh trong năm tính từ ngày đầu năm tài chính chứa ngày lập (không phải đầu khoảng chọn): chưa mở năm tài chính thì lấy đầu khoảng.
  const year = await yearOf(trx, f.to); const ys = await trx.selectFrom('fiscal_period').select(({ fn }) => fn.min('date_from').as('d')).where('fiscal_year', '=', year).where('period_no', '>', 0).executeTakeFirst();
  const yearStart = ys?.d ?? f.from;
  const cur = await b01Position(trx, { open: f.to, other: f.to }, yearStart, method, rate);
  const prev = await b01Position(trx, { open: yearStart, other: dayBefore(yearStart) }, yearBack(yearStart), method, rate);
  const c = await companyInfo(trx, tenantId, 'TT58', null); const company = { ...c, formNo: 'B01 – DNSN', issuedBy: set.issuedBy };
  const tc = b01Totals(cur); const tp = b01Totals(prev);
  const val = (p: B01Position, t: ReturnType<typeof b01Totals>, no: string): Decimal => (no in t ? t[no as '200'] : p[`l${no}` as 'l110']);
  const rows: Row[] = [];
  for (const l of rep.lines) {
    if (l.lineNo === '110') rows.push({ label: 'TÀI SẢN', isBold: true });
    if (l.lineNo === '300') rows.push({ label: 'NGUỒN VỐN', isBold: true });
    rows.push({ label: l.label, code: l.lineNo, cur: S(val(cur, tc, l.lineNo)), prev: S(val(prev, tp, l.lineNo)), isBold: ['200', '300', '400', '500'].includes(l.lineNo) });
  }
  const cols: ReportColumn[] = [{ key: 'label', label: 'CHỈ TIÊU (1)' }, { key: 'code', label: 'Mã số (2)', width: '10%' }, { key: 'cur', label: 'Số cuối năm (3)', type: 'number', width: '20%' }, { key: 'prev', label: 'Số đầu năm (4)', type: 'number', width: '20%' }];
  const notes: string[] = [...new Set([...cur.notes, ...prev.notes])];
  const diff = tc['200'].minus(tc['500']); const diffPrev = tp['200'].minus(tp['500']);
  if (!diff.isZero() || !diffPrev.isZero()) {
    notes.unshift(`Tổng tài sản (mã 200) và tổng nguồn vốn (mã 500) chưa bằng nhau: số cuối năm lệch ${S(diff)} đồng, số đầu năm lệch ${S(diffPrev)} đồng (200 trừ 500). Sổ ghi đơn của doanh nghiệp siêu nhỏ không có bút toán đối ứng nên phần mềm không tự bảo đảm cân đối; rà soát số dư đầu kỳ của S4a, S4b, S4d, tài sản khác và các sổ khác, các bút chưa ghi sổ, rồi lập lại.`);
  }
  if (profitFlagFor(method)) {
    const p = await b02(trx, tenantId, { from: yearStart, to: f.to }); const net = String((p.rows.find((r) => r.code === '20') as Row | undefined)?.cur ?? '0');
    notes.push(`Lợi nhuận sau thuế TNDN của năm theo B02-DNSN (mã 20) là ${net} đồng. Số này chỉ nằm trong mã 420 khi bạn đã ghi tăng vào Sổ theo dõi vốn chủ sở hữu (S4d); phần mềm không tự kết chuyển.`);
  }
  if (rate === null && profitFlagFor(method)) notes.push('Chưa khai thuế suất TNDN trên thu nhập tính thuế cho năm này (Cài đặt năm): thuế TNDN phải nộp tạm tính 0.');
  notes.push('Mã 320 gồm thuế GTGT, thuế TNDN còn phải nộp theo các sổ thuế và nghĩa vụ thuế khác ghi ở S4a (bên phải trả, tính chất "Thuế"); S4c-DNSN không ghi số đã nộp nên không cộng vào mã 320.');
  return { title: rep.name, formNo: 'B01 – DNSN', issuedBy: set.issuedBy, company, subtitle: `Tại ngày ${formatVnDate(f.to)}`, columns: cols, rows, sheetName: 'B01-DNSN', outro: notes,
    signers: [{ title: 'NGƯỜI LẬP BIỂU', note: '(Ký, ghi rõ họ tên)' }, { title: 'KẾ TOÁN TRƯỞNG', note: '(Ký, ghi rõ họ tên)', name: c.chiefAccountant ?? '' }, { title: 'NGƯỜI ĐẠI DIỆN THEO PHÁP LUẬT', note: '(Ký, ghi rõ họ tên, đóng dấu)', name: c.legalRep ?? '' }] };
}

// Đầu mối dựng mọi sổ và báo cáo hộ kinh doanh, siêu nhỏ: S4a, S4b, S4d, B01-DNSN ở đây, còn lại ở books.ts.
export async function buildAnyBook(trx: Trx, tenantId: string, code: string, f: DnsnFilter): Promise<ReportDoc[]> {
  switch (code) {
    case 'S4a-DNSN': return s4a(trx, tenantId, f);
    case 'S4b-DNSN': return s4b(trx, tenantId, f);
    case 'S4d-DNSN': return s4d(trx, tenantId, f);
    case 'B01-DNSN': return [await b01(trx, tenantId, f)];
    default: return buildBook(trx, tenantId, code, f);
  }
}
