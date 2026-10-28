import type { Transaction } from 'kysely';
import type { Database } from '@kt/db';
import { D, formatVnDate } from '@kt/domain';
import { AppError } from '../../../plugins/errors.js';
import { accountDetail, accountLedger, generalJournal, trialBalance } from '../ledgers.js';
import { evaluateFinancialReport } from '../financial.js';
import { getBookForm } from '../bookForms.js';
import { ctgsLedgerDoc, formJournalDocs } from './bookFormDocs.js';
import { formNoFor } from './forms.js';
import { periodSubtitle, type ReportDoc } from './html.js';
import type { CompanyInfo } from './voucherHtml.js';

type Trx = Transaction<Database>;
// Hàng công ty đọc một lần cho mỗi giao dịch (bộ sổ năm dựng hàng trăm tài liệu trong cùng một giao dịch); WeakMap nên hết giao dịch là bỏ.
const tenantRows = new WeakMap<Trx, ReturnType<typeof loadTenant>>();
const loadTenant = (trx: Trx, tenantId: string) => trx.selectFrom('tenant').selectAll().where('id', '=', tenantId).executeTakeFirstOrThrow();
// formKey null: tài liệu nội bộ không có số mẫu, formNo và issuedBy để trống.
export async function companyInfo(trx: Trx, tenantId: string, regime: string, formKey: string | null): Promise<CompanyInfo> {
  let row = tenantRows.get(trx); if (!row) tenantRows.set(trx, row = loadTenant(trx, tenantId));
  const t = await row; const f = formKey === null ? { formNo: '', issuedBy: '' } : formNoFor(regime, formKey);
  return { name: t.name, address: t.address, taxCode: t.tax_code, legalRep: t.legal_rep, chiefAccountant: t.chief_accountant, formNo: f.formNo, issuedBy: f.issuedBy };
}
export async function journalDoc(trx: Trx, tenantId: string, regime: string, p: { from: string; to: string }): Promise<ReportDoc> {
  const j = await generalJournal(trx, p); const c = await companyInfo(trx, tenantId, regime, 'S03a');
  return { title: 'Sổ Nhật ký chung', company: c, formNo: c.formNo, issuedBy: c.issuedBy, subtitle: periodSubtitle(p.from, p.to), sheetName: 'S03a NKC',
    columns: [{ key: 'postingDate', label: 'Ngày ghi sổ', type: 'date', width: '11%' }, { key: 'voucherNo', label: 'Số hiệu', width: '11%' }, { key: 'documentDate', label: 'Ngày CT', type: 'date', width: '11%' }, { key: 'description', label: 'Diễn giải' }, { key: 'accountCode', label: 'TK', width: '8%' }, { key: 'debit', label: 'Số phát sinh Nợ', type: 'number', width: '14%' }, { key: 'credit', label: 'Số phát sinh Có', type: 'number', width: '14%' }],
    rows: j.rows, footer: { description: 'Cộng', debit: j.totalDebit, credit: j.totalCredit } };
}
export async function ledgerDoc(trx: Trx, tenantId: string, regime: string, p: { accountCode: string; from: string; to: string }): Promise<ReportDoc> {
  const l = await accountLedger(trx, tenantId, { ...p, mode: 'voucher' });
  // Một công ty giữ nhiều hệ tài khoản trùng mã: tên lấy đúng hệ của kỳ in.
  const acc = await trx.selectFrom('account').select('name').where('regime', '=', regime).where('code', '=', p.accountCode).executeTakeFirstOrThrow();
  const c = await companyInfo(trx, tenantId, regime, 'S03b');
  return { title: `Sổ Cái – Tài khoản ${p.accountCode} – ${acc.name}`, company: c, formNo: c.formNo, issuedBy: c.issuedBy, subtitle: periodSubtitle(p.from, p.to), sheetName: `S03b ${p.accountCode}`,
    columns: [{ key: 'postingDate', label: 'Ngày ghi sổ', type: 'date' }, { key: 'voucherNo', label: 'Số hiệu' }, { key: 'description', label: 'Diễn giải' }, { key: 'counterAccountCode', label: 'TK đối ứng' }, { key: 'debit', label: 'Nợ', type: 'number' }, { key: 'credit', label: 'Có', type: 'number' }],
    rows: [{ description: 'Số dư đầu kỳ', debit: l.opening.debit, credit: l.opening.credit, isBold: true }, ...('rows' in l ? l.rows : []) as Record<string, unknown>[], { description: 'Cộng số phát sinh', debit: l.totalDebit, credit: l.totalCredit, isBold: true }, { description: 'Số dư cuối kỳ', debit: l.closing.debit, credit: l.closing.credit, isBold: true }] };
}
export async function detailDoc(trx: Trx, tenantId: string, regime: string, p: Parameters<typeof accountDetail>[2]): Promise<ReportDoc> {
  const l = await accountDetail(trx, tenantId, p); const c = await companyInfo(trx, tenantId, regime, 'S38');
  return { title: `Sổ chi tiết tài khoản ${p.accountCode}${p.partyCode ? ` – Đối tượng ${p.partyCode}` : ''}`, company: c, formNo: c.formNo, issuedBy: c.issuedBy, subtitle: periodSubtitle(p.from, p.to), sheetName: `S38 ${p.accountCode}`,
    columns: [{ key: 'postingDate', label: 'Ngày', type: 'date' }, { key: 'voucherNo', label: 'Số hiệu' }, { key: 'description', label: 'Diễn giải' }, { key: 'partyCode', label: 'Đối tượng' }, { key: 'counterAccountCode', label: 'TK đối ứng' }, { key: 'debit', label: 'Nợ', type: 'number' }, { key: 'credit', label: 'Có', type: 'number' }],
    rows: [{ description: 'Số dư đầu kỳ', debit: l.opening.debit, credit: l.opening.credit, isBold: true }, ...l.rows as Record<string, unknown>[], { description: 'Cộng số phát sinh', debit: l.totalDebit, credit: l.totalCredit, isBold: true }, { description: 'Số dư cuối kỳ', debit: l.closing.debit, credit: l.closing.credit, isBold: true }] };
}
export async function trialBalanceDoc(trx: Trx, tenantId: string, regime: string, p: { from: string; to: string; level?: number | undefined; splitParty?: boolean | undefined }): Promise<ReportDoc> {
  const t = await trialBalance(trx, tenantId, p); const c = await companyInfo(trx, tenantId, regime, 'S06');
  return { title: 'Bảng cân đối số phát sinh', company: c, formNo: c.formNo, issuedBy: c.issuedBy, subtitle: periodSubtitle(p.from, p.to), landscape: true, sheetName: 'S06 BCĐPS',
    columns: [{ key: 'accountCode', label: 'Số hiệu TK' }, { key: 'accountName', label: 'Tên tài khoản' }, { key: 'openingDebit', label: 'Dư đầu kỳ Nợ', type: 'number' }, { key: 'openingCredit', label: 'Dư đầu kỳ Có', type: 'number' }, { key: 'periodDebit', label: 'Phát sinh Nợ', type: 'number' }, { key: 'periodCredit', label: 'Phát sinh Có', type: 'number' }, { key: 'closingDebit', label: 'Dư cuối kỳ Nợ', type: 'number' }, { key: 'closingCredit', label: 'Dư cuối kỳ Có', type: 'number' }],
    rows: t.rows.map((r) => ({ accountCode: r.accountCode, accountName: r.accountName, openingDebit: r.opening.debit, openingCredit: r.opening.credit, periodDebit: r.period.debit, periodCredit: r.period.credit, closingDebit: r.closing.debit, closingCredit: r.closing.credit, isBold: r.level === 1 })),
    footer: { accountName: 'Tổng cộng', openingDebit: t.totals.opening.debit, openingCredit: t.totals.opening.credit, periodDebit: t.totals.period.debit, periodCredit: t.totals.period.credit, closingDebit: t.totals.closing.debit, closingCredit: t.totals.closing.credit } };
}
// Báo cáo chưa có định nghĩa của công ty thì evaluateFinancialReport ném REPORT_NOT_FOUND (404): in lẻ thì báo lỗi cho người dùng, bộ sổ năm thì bỏ qua báo cáo đó.
export async function financialDoc(trx: Trx, tenantId: string, regime: string, p: { reportCode: string; from: string; to: string }): Promise<ReportDoc> {
  const r = await evaluateFinancialReport(trx, tenantId, { ...p, comparePrevYear: true }); const c = await companyInfo(trx, tenantId, regime, p.reportCode);
  const isB01 = p.reportCode === 'B01';
  // Thụt lề theo số bậc dòng cha, bằng khoảng trắng không ngắt (khoảng trắng thường bị HTML gộp mất).
  const parent = new Map(r.rows.map((x) => [x.lineCode, x.parentLineCode]));
  const depth = (code: string | null) => { let n = 0; for (let q = code; q && n < 10; q = parent.get(q) ?? null) n++; return n; };
  // Như màn hình: dòng không có công thức để trống, dòng "âm" (khoản chi) in số âm trong ngoặc.
  const amount = (x: { formula: string | null; negate: boolean }, v: string | null) => (v === null || !x.formula ? null : x.negate ? D(v).neg().toString() : v);
  return { title: r.name, company: c, formNo: r.formNo, issuedBy: r.issuedBy, subtitle: isB01 ? `Tại ngày ${formatVnDate(p.to)}` : periodSubtitle(p.from, p.to), sheetName: r.formNo,
    columns: [{ key: 'label', label: 'Chỉ tiêu' }, { key: 'lineCode', label: 'Mã số', align: 'center' }, { key: 'noteRef', label: 'Thuyết minh', align: 'center' }, { key: 'current', label: isB01 ? 'Số cuối kỳ' : 'Năm nay', type: 'number' }, { key: 'previous', label: isB01 ? 'Số đầu năm' : 'Năm trước', type: 'number' }],
    rows: r.rows.map((x) => ({ ...x, label: `${' '.repeat(4 * depth(x.parentLineCode))}${x.label}`, current: amount(x, x.current), previous: amount(x, x.previous) })), signatures: ['Người lập biểu', 'Kế toán trưởng', 'Người đại diện theo pháp luật'] };
}
export async function bookSetDocs(trx: Trx, tenantId: string, year: number, include: string[]): Promise<ReportDoc[]> {
  const ps = await trx.selectFrom('fiscal_period').select(['date_from', 'date_to', 'regime']).where('fiscal_year', '=', year).where('period_no', '>=', 1).orderBy('period_no').execute();
  if (!ps.length) throw new AppError('PERIOD_NOT_FOUND', `Không có năm tài chính ${year}`, 404);
  const from = ps[0]!.date_from; const to = ps.at(-1)!.date_to; const regime = ps[0]!.regime; const docs: ReportDoc[] = [];
  const form = await getBookForm(trx, year); // hình thức sổ của năm: chỉ đổi cách trình bày Nhật ký/Sổ Cái, số liệu vẫn từ sổ cái
  if (include.includes('journal')) docs.push(...(form === 'NKC' ? [await journalDoc(trx, tenantId, regime, { from, to })] : await formJournalDocs(trx, tenantId, regime, form, { from, to, fiscalYear: year })));
  if (include.includes('ledgers') && form !== 'NKSC') { // Nhật ký – Sổ Cái là một sổ duy nhất, không in Sổ Cái riêng
    const tb = await trialBalance(trx, tenantId, { from, to, splitParty: false });
    for (const r of tb.rows.filter((x) => !x.isGroup)) docs.push(form === 'CTGS' ? await ctgsLedgerDoc(trx, tenantId, regime, { accountCode: r.accountCode, from, to }) : await ledgerDoc(trx, tenantId, regime, { accountCode: r.accountCode, from, to }));
  }
  if (include.includes('trial')) docs.push(await trialBalanceDoc(trx, tenantId, regime, { from, to, splitParty: true }));
  for (const code of ['B01', 'B02', 'B03']) if (include.includes(code)) { try { docs.push(await financialDoc(trx, tenantId, regime, { reportCode: code, from, to })); } catch (e) { if ((e as { code?: string }).code !== 'REPORT_NOT_FOUND') throw e; } }
  return docs;
}
