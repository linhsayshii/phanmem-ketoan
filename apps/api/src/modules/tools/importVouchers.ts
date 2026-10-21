import { createHash } from 'node:crypto';
import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import type { Database } from '@kt/db';
import { D, TaxError, VND_AMOUNT_MSG, VND_AMOUNT_RE } from '@kt/domain';
import { AppError } from '../../plugins/errors.js';
import { postWithCashCheck } from '../cash/books.js';
import { createInvoice, type InvoiceInput } from '../invoices/service.js';
import { createVoucher, dateIso, fxRate, type LineInput, type VoucherInput } from '../ledger/vouchers.service.js';
import type { ColumnDef } from '../master/catalogs.js';
import { buildSheetTemplate, readSheet, zodIssueVi, type ImportError } from '../master/excelSheet.js';
import { MAX_ERRORS, MAX_ROWS } from '../master/importExcel.js';

// Nhập chứng từ thu chi (PT, PC, BC, BN) và bảng kê hóa đơn mua/bán từ Excel. Đọc và kiểm tra toàn bộ trước; ghi trong MỘT giao dịch của người gọi,
// có lỗi ở bất kỳ dòng nào thì người gọi hoàn tác tất cả (không chứng từ nào được ghi). Mỗi nhóm dòng (cột `group`) là một chứng từ.
export const KINDS = ['thu-chi', 'bang-ke-mua', 'bang-ke-ban'] as const;
export type Kind = (typeof KINDS)[number];
export const MAX_GROUPS = 5000;
const SHEET = 'Du_lieu';
const KEY_ROW = 2;
const FIRST_DATA_ROW = 4;

export interface ImportReport { total: number; rows: number; created: number; existing: number; posted: number; errors: ImportError[]; errorCount: number }
type Rec = Record<string, string | undefined>;
interface Item { row: number; v: Rec }

const col = (key: string, label: string, type: ColumnDef['type'], required = false): ColumnDef => ({ key, label, type, ...(required && { required }) });
const text = (max: number) => z.string().max(max).optional();
const money = z.string().regex(VND_AMOUNT_RE, VND_AMOUNT_MSG);
const positive = (s: string) => /[1-9]/.test(s);

// ---- Thu chi ----
const THU_CHI_COLUMNS: ColumnDef[] = [
  col('group', 'Số chứng từ tạm (cùng số = một chứng từ)', 'text', true), col('type', 'Loại chứng từ (PT, PC, BC, BN)', 'select', true), col('postingDate', 'Ngày hạch toán', 'date', true),
  col('documentDate', 'Ngày chứng từ', 'date'), col('description', 'Diễn giải', 'text'), col('personName', 'Người nộp/nhận', 'text'), col('partyCode', 'Mã đối tượng', 'text'),
  col('bankAccountNo', 'Số tài khoản ngân hàng', 'text'), col('debitAccount', 'Tài khoản Nợ', 'text', true), col('creditAccount', 'Tài khoản Có', 'text', true), col('amount', 'Số tiền (VND)', 'number', true),
  col('currency', 'Loại tiền', 'text'), col('fxRate', 'Tỷ giá', 'number'), col('amountCurrency', 'Số tiền nguyên tệ', 'number'), col('lineDescription', 'Diễn giải dòng', 'text'),
];
const thuChiSchema = z.object({
  group: z.string().min(1).max(28), type: z.enum(['PT', 'PC', 'BC', 'BN']), postingDate: dateIso, documentDate: dateIso.optional(), description: text(500), personName: text(200), partyCode: text(50),
  bankAccountNo: text(50), debitAccount: z.string().min(1).max(20), creditAccount: z.string().min(1).max(20), amount: money.refine(positive, 'Số tiền phải lớn hơn 0'),
  currency: z.string().length(3).transform((s) => s.toUpperCase()).optional(), fxRate: fxRate.optional(), amountCurrency: z.string().regex(/^\d{1,16}(\.\d{1,4})?$/, 'Số tiền nguyên tệ không hợp lệ').optional(), lineDescription: text(500),
}).superRefine((r, ctx) => {
  if (r.currency && r.currency !== 'VND') {
    if (!r.fxRate) ctx.addIssue({ code: 'custom', path: ['fxRate'], message: 'Ngoại tệ phải có tỷ giá' });
    if (!r.amountCurrency) ctx.addIssue({ code: 'custom', path: ['amountCurrency'], message: 'Ngoại tệ phải có số tiền nguyên tệ' });
  }
}).transform((r): Rec => ({ ...r, documentDate: r.documentDate ?? r.postingDate }));

// Giá trị tiêu đề của nhóm: giá trị khác rỗng đầu tiên.
const head = (items: Item[]) => (k: string): string | undefined => items.find((i) => i.v[k])?.v[k];

function buildThuChi(items: Item[], key: string): VoucherInput {
  const h = head(items); const cur = h('currency') ?? 'VND'; const foreign = cur !== 'VND'; const party = h('partyCode');
  const lines: LineInput[] = [];
  for (const { v } of items) {
    const base = { partyCode: v.partyCode ?? party ?? null, description: v.lineDescription ?? v.description ?? null };
    // Ngoại tệ: nguyên tệ có dấu (Nợ dương, Có âm); tiền hạch toán VND là cột "Số tiền".
    lines.push({ ...base, accountCode: v.debitAccount!, debit: v.amount!, credit: '0', ...(foreign && { amountCurrency: v.amountCurrency! }) });
    lines.push({ ...base, accountCode: v.creditAccount!, debit: '0', credit: v.amount!, ...(foreign && { amountCurrency: `-${v.amountCurrency!}` }) });
  }
  return {
    voucherType: h('type')!, postingDate: h('postingDate')!, documentDate: h('documentDate')!, description: h('description') ?? null, partyCode: party ?? null, currencyCode: cur,
    ...(foreign && { fxRate: h('fxRate')! }), personName: h('personName') ?? null, bankAccountNo: h('bankAccountNo') ?? null, idempotencyKey: key, lines,
  };
}

// ---- Bảng kê hóa đơn ----
const BANG_KE_COLUMNS: ColumnDef[] = [
  col('group', 'Nhóm (cùng nhóm = một hóa đơn nhiều thuế suất)', 'text', true), col('postingDate', 'Ngày hạch toán', 'date', true), col('serial', 'Ký hiệu hóa đơn', 'text'), col('invoiceNo', 'Số hóa đơn', 'text', true),
  col('invoiceDate', 'Ngày hóa đơn', 'date', true), col('partyCode', 'Mã đối tượng', 'text', true), col('partyTaxCode', 'Mã số thuế ghi trên hóa đơn', 'text'), col('partyName', 'Tên ghi trên hóa đơn', 'text'),
  col('accountCode', 'Tài khoản chi phí/doanh thu', 'text', true), col('counterAccountCode', 'Tài khoản đối ứng (công nợ/tiền)', 'text'), col('amount', 'Tiền hàng (VND)', 'number', true),
  col('taxCode', 'Mã thuế', 'text'), col('taxAmount', 'Tiền thuế ghi trên hóa đơn (VND)', 'number'), col('invoiceGroupCode', 'Nhóm hóa đơn (kê khai)', 'text', true),
  col('dueDate', 'Hạn thanh toán', 'date'), col('description', 'Diễn giải', 'text'),
];
const bangKeSchema = z.object({
  group: text(28), postingDate: dateIso, serial: text(20), invoiceNo: z.string().trim().min(1).max(30), invoiceDate: dateIso, partyCode: z.string().min(1).max(50), partyTaxCode: text(20), partyName: text(200),
  accountCode: z.string().min(1).max(20), counterAccountCode: z.string().max(20).optional(), amount: money, taxCode: text(50), taxAmount: money.optional(), invoiceGroupCode: z.string().min(1).max(50),
  dueDate: dateIso.optional(), description: text(500),
}).superRefine((r, ctx) => {
  if (r.taxAmount && !r.taxCode) ctx.addIssue({ code: 'custom', path: ['taxCode'], message: 'Có tiền thuế thì phải nhập mã thuế' });
}).transform((r): Rec => ({ ...r }));

const buildBangKe = (direction: 'mua' | 'ban') => (items: Item[], key: string): InvoiceInput => {
  const h = head(items); const declared: Record<string, string> = {};
  for (const { v } of items) if (v.taxCode && v.taxAmount !== undefined) declared[v.taxCode] = D(declared[v.taxCode] ?? '0').plus(v.taxAmount).toFixed(0);
  return {
    voucherType: direction === 'mua' ? 'HDM' : 'HDB', postingDate: h('postingDate')!, documentDate: h('invoiceDate')!, partyCode: h('partyCode')!, currencyCode: 'VND',
    ...(h('counterAccountCode') && { counterAccountCode: h('counterAccountCode')! }), ...(h('dueDate') && { dueDate: h('dueDate')! }), description: h('description') ?? null,
    items: items.map(({ v }) => ({ description: v.description ?? null, accountCode: v.accountCode!, amountCurrency: v.amount!, discountCurrency: '0', taxCodes: v.taxCode ? [v.taxCode] : [] })),
    invoice: {
      invoiceNo: h('invoiceNo')!, invoiceDate: h('invoiceDate')!, invoiceGroupCode: h('invoiceGroupCode')!, ...(h('serial') && { serial: h('serial')! }),
      ...(h('partyTaxCode') && { partyTaxCode: h('partyTaxCode')! }), ...(h('partyName') && { partyName: h('partyName')! }), ...(Object.keys(declared).length && { declaredTax: declared }),
    },
    idempotencyKey: key,
  };
};

interface Spec {
  columns: ColumnDef[]; schema: z.ZodType<Rec, z.ZodTypeDef, unknown>; same: string[]; label: string; example: Rec;
  build: (items: Item[], key: string) => { voucher: VoucherInput } | { invoice: InvoiceInput }; help: string[];
}
const SPECS: Record<Kind, Spec> = {
  'thu-chi': {
    columns: THU_CHI_COLUMNS, schema: thuChiSchema, same: ['type', 'postingDate', 'documentDate', 'currency', 'partyCode', 'bankAccountNo', 'fxRate'], label: 'phiếu thu, phiếu chi, giấy báo Có, giấy báo Nợ',
    example: { group: 'T001', type: 'PT', postingDate: '2026-01-05', documentDate: '2026-01-05', description: 'Thu tiền khách hàng', personName: 'Nguyễn Văn A', partyCode: 'KH001', bankAccountNo: '', debitAccount: '1111', creditAccount: '131', amount: '1000000', currency: 'VND', fxRate: '', amountCurrency: '', lineDescription: '' },
    build: (items, key) => ({ voucher: buildThuChi(items, key) }),
    help: ['Mỗi dòng là một bút toán Nợ/Có cùng số tiền. Các dòng cùng "Số chứng từ tạm" gộp thành một chứng từ; thông tin tiêu đề (loại, ngày, loại tiền, tài khoản ngân hàng) phải giống nhau, ô nào bỏ trống lấy theo dòng đầu.',
      'Loại PT/PC: phiếu thu/phiếu chi tiền mặt (một bên là tài khoản tiền mặt 111). Loại BC/BN: giấy báo Có/Nợ, bắt buộc "Số tài khoản ngân hàng".',
      'Tài khoản công nợ 131, 331 bắt buộc "Mã đối tượng". Ngoại tệ: nhập Loại tiền, Tỷ giá và Số tiền nguyên tệ; cột Số tiền vẫn là số tiền VND.'],
  },
  'bang-ke-mua': {
    columns: BANG_KE_COLUMNS, schema: bangKeSchema, same: ['postingDate', 'serial', 'invoiceNo', 'invoiceDate', 'partyCode', 'partyTaxCode', 'partyName', 'invoiceGroupCode', 'counterAccountCode', 'dueDate'], label: 'bảng kê hóa đơn mua vào',
    example: { group: 'M001', postingDate: '2026-01-05', serial: 'AA/26E', invoiceNo: '0000123', invoiceDate: '2026-01-05', partyCode: 'NCC001', partyTaxCode: '0101234567', partyName: 'Công ty ABC', accountCode: '6422', counterAccountCode: '331', amount: '1000000', taxCode: 'V10', taxAmount: '100000', invoiceGroupCode: '01', dueDate: '', description: 'Mua văn phòng phẩm' },
    build: (items, key) => ({ invoice: buildBangKe('mua')(items, key) }),
    help: ['Mỗi dòng là một mức thuế suất của một hóa đơn. Hóa đơn có nhiều mức thuế: các dòng dùng chung "Nhóm" (và cùng số hóa đơn, ký hiệu, ngày); bỏ trống "Nhóm" thì mỗi dòng là một hóa đơn.',
      '"Tiền thuế ghi trên hóa đơn" là số in trên hóa đơn; lệch với số tính theo thuế suất thì chênh lệch dồn vào dòng thuế lớn nhất. Hóa đơn mua trùng (cùng mã số thuế, ký hiệu, số hóa đơn) bị từ chối.'],
  },
  'bang-ke-ban': {
    columns: BANG_KE_COLUMNS, schema: bangKeSchema, same: ['postingDate', 'serial', 'invoiceNo', 'invoiceDate', 'partyCode', 'partyTaxCode', 'partyName', 'invoiceGroupCode', 'counterAccountCode', 'dueDate'], label: 'bảng kê hóa đơn bán ra',
    example: { group: 'B001', postingDate: '2026-01-05', serial: 'C26TAA', invoiceNo: '0000045', invoiceDate: '2026-01-05', partyCode: 'KH001', partyTaxCode: '', partyName: '', accountCode: '5113', counterAccountCode: '131', amount: '2000000', taxCode: 'V10', taxAmount: '200000', invoiceGroupCode: '10', dueDate: '', description: 'Dịch vụ tư vấn' },
    build: (items, key) => ({ invoice: buildBangKe('ban')(items, key) }),
    help: ['Mỗi dòng là một mức thuế suất của một hóa đơn bán ra. Các dòng cùng "Nhóm" gộp thành một hóa đơn; bỏ trống "Nhóm" thì mỗi dòng là một hóa đơn.',
      '"Tiền thuế ghi trên hóa đơn" là số in trên hóa đơn; lệch với số tính theo thuế suất thì chênh lệch dồn vào dòng thuế lớn nhất.'],
  },
};

export const isKind = (s: string): s is Kind => (KINDS as readonly string[]).includes(s);
export const templateFileName = (kind: Kind) => `mau_nhap_${kind.replaceAll('-', '_')}.xlsx`;

export function buildVoucherTemplate(kind: Kind): Promise<Buffer> {
  const spec = SPECS[kind];
  return buildSheetTemplate({
    sheet: SHEET, columns: spec.columns, keyRow: KEY_ROW, example: (c) => spec.example[c.key] ?? '',
    help: [
      [`Mẫu nhập ${spec.label}`],
      ['Dòng 1: tên cột (cột có (*) bắt buộc). Dòng 2 (ẩn) là khóa kỹ thuật, ánh xạ cột theo dòng này nên được đổi thứ tự cột. Dòng 3 là ví dụ và luôn bị bỏ qua. Nhập dữ liệu từ dòng 4.'],
      ['Ngày dạng YYYY-MM-DD hoặc dd/MM/yyyy. Tiền VND là số nguyên, không thập phân. Tối đa 5.000 chứng từ và 20.000 dòng mỗi tệp.'],
      ['Có lỗi ở bất kỳ dòng nào thì không nhập chứng từ nào. Nhập lại đúng tệp đã nhập không tạo chứng từ trùng.'],
      ...spec.help.map((s) => [s]),
      ...spec.columns.map((c) => [c.key, c.label, c.type, c.required ? 'bắt buộc' : '']),
    ],
  });
}

// Lỗi nghiệp vụ của dịch vụ → mã và thông báo tiếng Việt; lỗi hệ thống thật thì ném tiếp.
function failure(e: unknown): { code: string; message: string } {
  if (e instanceof AppError || e instanceof TaxError) return { code: e.code, message: e.message };
  const p = e as { code?: string; message?: string };
  if (p.code === 'P0001' && p.message?.includes(':')) { const [c, ...r] = p.message.split(':'); return { code: c!.trim(), message: r.join(':').trim() }; }
  if (p.code?.startsWith('22') || p.code === '23502' || p.code === '23514') return { code: 'VALIDATION', message: 'Dữ liệu không hợp lệ' };
  if (p.code === '23505') return { code: 'DUPLICATE', message: 'Trùng dữ liệu đã có' };
  throw e;
}

const CODE_COLUMN: Record<string, string> = {
  PERIOD_NOT_FOUND: 'postingDate', BANK_ACCOUNT_NOT_FOUND: 'bankAccountNo', BANK_ACCOUNT_GL_MISMATCH: 'bankAccountNo', INVOICE_DUPLICATE: 'invoiceNo',
  INVOICE_GROUP_MISMATCH: 'invoiceGroupCode', LINE_PARTY_REQUIRED: 'partyCode', VOUCHER_PARTY_REQUIRED: 'partyCode', TAX_CODE_UNKNOWN: 'taxCode', TAX_DECLARED_MISMATCH: 'taxAmount',
};
// Dòng/cột nghi ngờ của lỗi: ô trong nhóm có đúng giá trị được trích trong thông báo ("mã X"), rồi cột theo mã lỗi, cuối cùng ô đầu tiên của nhóm.
function locate(spec: Spec, items: Item[], f: { code: string; message: string }): { row: number; column: string } {
  const quoted = f.message.match(/"([^"]+)"/)?.[1];
  if (quoted) for (const i of items) { const c = spec.columns.find((x) => i.v[x.key] === quoted); if (c) return { row: i.row, column: c.key }; }
  const first = items[0]!;
  if (f.code === 'VOUCHER_FIELD_REQUIRED') {
    const m = /ngân hàng/i.test(f.message) ? 'bankAccountNo' : /đối tượng/i.test(f.message) ? 'partyCode' : /người/i.test(f.message) ? 'personName' : 'group';
    return { row: first.row, column: m };
  }
  if (f.code === 'VOUCHER_CASH_LINE_REQUIRED') return { row: first.row, column: /Nợ/.test(f.message) ? 'debitAccount' : 'creditAccount' };
  return { row: first.row, column: CODE_COLUMN[f.code] ?? spec.columns[0]!.key };
}

const dupKey = (kind: Kind, v: Rec) => `${kind === 'bang-ke-mua' ? (v.partyTaxCode || v.partyCode)!.trim().toUpperCase() : ''}|${(v.serial ?? '').trim().toUpperCase()}|${v.invoiceNo!.trim().replace(/^0+/, '')}`;

export async function runImport(trx: Transaction<Database>, ctx: { tenantId: string; userId: string }, kind: Kind, buf: Buffer, autoPost: boolean): Promise<ImportReport> {
  const spec = SPECS[kind]; const label = (k: string) => spec.columns.find((c) => c.key === k)?.label ?? k;
  const sheet = await readSheet(buf, { sheet: SHEET, keyRow: KEY_ROW, firstDataRow: FIRST_DATA_ROW, maxRows: MAX_ROWS, columns: spec.columns });
  const errors: ImportError[] = [...sheet.errors]; const badRows = new Set(sheet.errors.map((e) => e.row));
  const groups = new Map<string, Item[]>();
  for (const { row, values } of sheet.rows) {
    if (badRows.has(row)) continue;
    const parsed = spec.schema.safeParse(values);
    if (!parsed.success) { for (const issue of parsed.error.issues) { const column = String(issue.path[0] ?? 'group'); errors.push({ row, column, message: zodIssueVi(issue, label(column)) }); } continue; }
    const g = parsed.data.group || `R${row}`; // bảng kê không ghi nhóm: mỗi dòng là một hóa đơn
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push({ row, v: parsed.data });
  }
  if (groups.size > MAX_GROUPS) throw new AppError('IMPORT_TOO_MANY_GROUPS', `Tệp có ${groups.size.toLocaleString('vi-VN')} chứng từ, tối đa ${MAX_GROUPS.toLocaleString('vi-VN')}`, 400);
  const rows = sheet.rows.length;

  // Tiêu đề trong nhóm phải thống nhất: ô nào khác giá trị đầu tiên của nhóm là lỗi ở dòng đó.
  const seenInvoice = new Map<string, number>();
  for (const [g, items] of groups) {
    const flagged = new Set<number>(); // mỗi dòng báo một lỗi tiêu đề (ngày chứng từ mặc định bằng ngày hạch toán nên sai ngày hạch toán kéo theo sai cả hai)
    for (const k of spec.same) {
      const first = items.find((i) => i.v[k]);
      if (first) for (const i of items) if (i.v[k] && i.v[k] !== first.v[k] && !flagged.has(i.row)) { flagged.add(i.row); errors.push({ row: i.row, column: k, message: `${label(k)}: khác dòng ${first.row} cùng nhóm "${g}"` }); }
    }
    if (kind !== 'thu-chi') { // trùng hóa đơn giữa các nhóm trong tệp (hóa đơn mua còn bị dịch vụ kiểm lại với dữ liệu đã có)
      const k = dupKey(kind, items[0]!.v); const prev = seenInvoice.get(k);
      if (prev !== undefined) errors.push({ row: items[0]!.row, column: 'invoiceNo', message: `Số hóa đơn trùng với dòng ${prev} trong tệp` }); else seenInvoice.set(k, items[0]!.row);
    }
  }
  const report = (created: number, existing: number, posted: number): ImportReport => {
    const sorted = [...errors].sort((a, b) => a.row - b.row);
    return { total: groups.size, rows, created: errors.length ? 0 : created, existing, posted: errors.length ? 0 : posted, errors: sorted.slice(0, MAX_ERRORS), errorCount: errors.length };
  };
  if (errors.length) return report(0, 0, 0);

  // Nhập lại đúng tệp đã nhập: khóa idempotency chứa băm tệp nên nhóm đã có chứng từ thì bỏ qua, không tính vào `created`.
  const hash = createHash('sha256').update(buf).digest('hex');
  const have = new Set((await sql<{ k: string }>`SELECT idempotency_key AS k FROM voucher WHERE idempotency_key LIKE ${`import:${hash}:%`}`.execute(trx)).rows.map((r) => r.k));
  let created = 0; let existing = 0; let posted = 0;
  for (const [g, items] of groups) {
    const key = `import:${hash}:${g}`;
    if (have.has(key)) { existing++; continue; }
    await sql`SAVEPOINT imp_group`.execute(trx);
    try {
      const b = spec.build(items, key);
      const dto = 'voucher' in b ? await createVoucher(trx, ctx, b.voucher) : await createInvoice(trx, ctx, b.invoice);
      if (autoPost && dto.state === 'draft' && dto.version === 1) { await postWithCashCheck(trx, ctx.tenantId, dto.id); posted++; }
      await sql`RELEASE SAVEPOINT imp_group`.execute(trx);
      created++;
    } catch (e) {
      const f = failure(e); // lỗi hệ thống ném tiếp, giao dịch hoàn tác
      await sql`ROLLBACK TO SAVEPOINT imp_group`.execute(trx);
      errors.push({ ...locate(spec, items, f), message: f.message });
      if (errors.length >= MAX_ERRORS) break;
    }
  }
  return report(created, existing, posted);
}
