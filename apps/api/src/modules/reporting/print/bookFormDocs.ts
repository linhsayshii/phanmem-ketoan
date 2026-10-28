import type { Transaction } from 'kysely';
import type { Database } from '@kt/db';
import { formatVnDate } from '@kt/domain';
import { ctgsLedger, nksc, nkct, nkctCreditAccounts, voucherSetDetail, voucherSetRegister, type BookForm } from '../bookForms.js';
import { bookFormFor } from './forms.js';
import { periodSubtitle, type ReportDoc } from './html.js';
import { companyInfo } from './bookSet.js';

type Trx = Transaction<Database>;
// Số mẫu chỉ in khi có trong bảng FORMS (xem forms.ts): mẫu chưa đối chiếu văn bản gốc để trống thay vì đoán.
async function head(trx: Trx, tenantId: string, regime: string, key: string) {
  const c = await companyInfo(trx, tenantId, regime, null); const f = bookFormFor(regime, key) ?? { formNo: '', issuedBy: '' };
  return { company: { ...c, formNo: f.formNo, issuedBy: f.issuedBy }, formNo: f.formNo, issuedBy: f.issuedBy };
}
type P = { from: string; to: string };

export async function nkscDoc(trx: Trx, tenantId: string, regime: string, p: P): Promise<ReportDoc> {
  const n = await nksc(trx, p);
  return { title: 'Sổ Nhật ký – Sổ Cái', ...(await head(trx, tenantId, regime, 'NKSC')), subtitle: periodSubtitle(p.from, p.to), landscape: true, sheetName: 'NKSC',
    columns: [{ key: 'postingDate', label: 'Ngày ghi sổ', type: 'date', width: '10%' }, { key: 'voucherNo', label: 'Số hiệu CT', width: '11%' }, { key: 'documentDate', label: 'Ngày CT', type: 'date', width: '10%' }, { key: 'description', label: 'Diễn giải' }, { key: 'accountCode', label: 'TK', width: '8%' }, { key: 'debit', label: 'Phát sinh Nợ', type: 'number', width: '13%' }, { key: 'credit', label: 'Phát sinh Có', type: 'number', width: '13%' }],
    rows: [...n.rows, ...n.accounts.map((a) => ({ description: `Cộng phát sinh TK ${a.accountCode} – ${a.accountName}`, accountCode: a.accountCode, debit: a.debit, credit: a.credit, isBold: true }))],
    footer: { description: 'Cộng', debit: n.totalDebit, credit: n.totalCredit } };
}
export async function nkctDoc(trx: Trx, tenantId: string, regime: string, p: P & { creditAccountCode: string }): Promise<ReportDoc> {
  const n = await nkct(trx, regime, p);
  return { title: `Nhật ký – Chứng từ (ghi Có TK ${n.creditAccountCode} – ${n.creditAccountName})`, ...(await head(trx, tenantId, regime, 'NKCT')), subtitle: `${periodSubtitle(p.from, p.to)}. Bảng kê chung theo bên Có, cột là TK Nợ đối ứng`, landscape: true, sheetName: `NKCT ${n.creditAccountCode}`,
    columns: [{ key: 'postingDate', label: 'Ngày ghi sổ', type: 'date' }, { key: 'voucherNo', label: 'Số hiệu CT' }, { key: 'description', label: 'Diễn giải' }, ...n.debitAccounts.map((c) => ({ key: `c${c}`, label: `Nợ TK ${c}`, type: 'number' as const })), { key: 'total', label: `Cộng Có TK ${n.creditAccountCode}`, type: 'number' }],
    rows: n.rows.map((r) => ({ ...r, ...Object.fromEntries(Object.entries(r.amounts).map(([c, v]) => [`c${c}`, v])) })),
    footer: { description: 'Cộng', total: n.total, ...Object.fromEntries(Object.entries(n.totals).map(([c, v]) => [`c${c}`, v])) } };
}
export async function ctgsRegisterDoc(trx: Trx, tenantId: string, regime: string, p: P & { fiscalYear?: number | undefined }): Promise<ReportDoc> {
  const r = await voucherSetRegister(trx, p);
  return { title: 'Sổ đăng ký Chứng từ ghi sổ', ...(await head(trx, tenantId, regime, 'S02b')), subtitle: periodSubtitle(p.from, p.to), sheetName: 'S02b CTGS',
    columns: [{ key: 'setNo', label: 'Số hiệu', width: '12%' }, { key: 'setDate', label: 'Ngày tháng', type: 'date', width: '14%' }, { key: 'description', label: 'Diễn giải' }, { key: 'vouchers', label: 'Số chứng từ gốc', width: '12%', align: 'right' }, { key: 'amount', label: 'Số tiền', type: 'number', width: '18%' }],
    rows: r.rows, footer: { description: 'Cộng', amount: r.total } };
}
export async function ctgsSetDoc(trx: Trx, tenantId: string, regime: string, id: number): Promise<ReportDoc> {
  const s = await voucherSetDetail(trx, id);
  return { title: `Chứng từ ghi sổ số ${s.setNo}`, ...(await head(trx, tenantId, regime, 'S02a')), subtitle: `Ngày ${formatVnDate(s.setDate)} – ${s.description}`, sheetName: `S02a ${s.setNo}`,
    columns: [{ key: 'voucherNo', label: 'Số hiệu CT gốc', width: '14%' }, { key: 'documentDate', label: 'Ngày CT', type: 'date', width: '12%' }, { key: 'description', label: 'Trích yếu' }, { key: 'debitCode', label: 'TK Nợ', width: '9%' }, { key: 'creditCode', label: 'TK Có', width: '9%' }, { key: 'amount', label: 'Số tiền', type: 'number', width: '16%' }],
    rows: s.rows, footer: { description: 'Cộng', amount: s.total }, signatures: ['Người lập', 'Kế toán trưởng'] };
}
export async function ctgsLedgerDoc(trx: Trx, tenantId: string, regime: string, p: P & { accountCode: string }): Promise<ReportDoc> {
  const l = await ctgsLedger(trx, tenantId, regime, p);
  const warn = l.unassigned ? [`Còn ${l.unassigned} chứng từ ghi sổ trong kỳ chưa vào Chứng từ ghi sổ nào; sổ này chưa gồm các chứng từ đó.`] : undefined;
  return { title: `Sổ Cái (hình thức Chứng từ ghi sổ) – Tài khoản ${l.accountCode} – ${l.accountName}`, ...(await head(trx, tenantId, regime, 'S02c1')), subtitle: periodSubtitle(p.from, p.to), sheetName: `S02c1 ${l.accountCode}`, ...(warn ? { outro: warn } : {}),
    columns: [{ key: 'setDate', label: 'Ngày CTGS', type: 'date' }, { key: 'setNo', label: 'Số hiệu CTGS', align: 'right' }, { key: 'description', label: 'Diễn giải' }, { key: 'counterAccountCode', label: 'TK đối ứng' }, { key: 'debit', label: 'Nợ', type: 'number' }, { key: 'credit', label: 'Có', type: 'number' }],
    rows: [{ description: 'Số dư đầu kỳ', debit: l.opening.debit, credit: l.opening.credit, isBold: true }, ...l.rows as Record<string, unknown>[], { description: 'Cộng số phát sinh', debit: l.totalDebit, credit: l.totalCredit, isBold: true }, { description: 'Số dư cuối kỳ', debit: l.closing.debit, credit: l.closing.credit, isBold: true }] };
}

// Phần "Nhật ký" và "Sổ Cái" của bộ sổ in theo hình thức đã chọn (NKC do bookSet.ts tự dựng). `ledgerCodes` = tài khoản chi tiết có số liệu, do bộ sổ truyền vào.
export async function formJournalDocs(trx: Trx, tenantId: string, regime: string, form: BookForm, p: P & { fiscalYear: number }): Promise<ReportDoc[]> {
  if (form === 'NKSC') return [await nkscDoc(trx, tenantId, regime, p)];
  if (form === 'NKCT') { const docs: ReportDoc[] = []; for (const creditAccountCode of await nkctCreditAccounts(trx, regime, p)) docs.push(await nkctDoc(trx, tenantId, regime, { ...p, creditAccountCode })); return docs; }
  if (form === 'CTGS') {
    const docs: ReportDoc[] = [await ctgsRegisterDoc(trx, tenantId, regime, p)];
    for (const s of (await voucherSetRegister(trx, p)).rows) docs.push(await ctgsSetDoc(trx, tenantId, regime, s.id));
    return docs;
  }
  return [];
}
