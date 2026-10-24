import ExcelJS from 'exceljs';
import { formulaSafe } from '../../lib/formulaSafe.js';
import { sql, type Selectable, type Transaction } from 'kysely';
import { z } from 'zod';
import type { Database } from '@kt/db';
import { D } from '@kt/domain';
import { AppError } from '../../plugins/errors.js';
import { listPayVouchers } from './payments.js';
import { getRun, lockRun } from './runs.js';

// Chi lương theo lô (Task 8): xuất tệp CSV/Excel theo mẫu cột do người dùng khai. Chưa có mẫu thật của ngân hàng nào nên không dựng sẵn mẫu theo tên ngân hàng (chỉ bố cục "Chung").
// Số tiền luôn là chuỗi đồng nguyên (numeric -> decimal.js), không qua number; riêng ô Excel số dùng Number() khi ≤ 15 chữ số (đúng tuyệt đối), dài hơn thì ghi chữ.
type Trx = Transaction<Database>;
export const FIELDS = ['seq', 'employee_code', 'employee_name', 'account_no', 'account_name', 'bank_code', 'bank_name', 'amount', 'content', 'payer_account_no', 'payer_account_name', 'constant'] as const;
type Field = (typeof FIELDS)[number];
export const FIELD_LABEL: Record<Field, string> = {
  seq: 'Số thứ tự', employee_code: 'Mã nhân viên', employee_name: 'Họ tên nhân viên', account_no: 'Số tài khoản nhận', account_name: 'Tên người nhận (chủ tài khoản)', bank_code: 'Mã ngân hàng nhận',
  bank_name: 'Tên ngân hàng nhận', amount: 'Số tiền', content: 'Nội dung', payer_account_no: 'Số tài khoản chi', payer_account_name: 'Tên tài khoản chi', constant: 'Giá trị cố định',
};
const TOKENS = new Set(['month', 'year', 'employee_name', 'employee_code', 'run_name']);
const DEFAULT_CONTENT = 'Lương tháng {month}/{year} {employee_name}';

const column = z.object({ field: z.enum(FIELDS), header: z.string().trim().max(100).default(''), value: z.string().max(200).optional() }).strict()
  .refine((c) => c.field !== 'constant' || c.value !== undefined, { message: 'Cột giá trị cố định cần nhập giá trị' });
export const formatInput = z.object({
  name: z.string().trim().min(1).max(100), fileType: z.enum(['csv', 'xlsx']), delimiter: z.enum([',', ';', '\t', '|']).default(','),
  utf8Bom: z.boolean().default(true), hasHeader: z.boolean().default(true), asciiOnly: z.boolean().default(false),
  contentTemplate: z.string().trim().min(1).max(200).default(DEFAULT_CONTENT),
  columns: z.array(column).min(1).max(50),
}).strict()
  .refine((f) => f.columns.some((c) => c.field === 'amount'), { message: 'Mẫu phải có cột Số tiền', path: ['columns'] })
  .refine((f) => [...f.contentTemplate.matchAll(/\{(\w*)\}/g)].every((m) => TOKENS.has(m[1]!)), { message: `Nội dung chỉ dùng ${[...TOKENS].map((t) => `{${t}}`).join(', ')}`, path: ['contentTemplate'] });
export type FormatInput = z.infer<typeof formatInput>;
export const exportInput = z.object({ formatId: z.number().int().positive(), bankAccountId: z.number().int().positive().optional(), voucherId: z.string().uuid().optional() }).strict();
export const previewInput = z.object({ format: formatInput, runId: z.number().int().positive().optional(), bankAccountId: z.number().int().positive().optional() }).strict();

type FormatRow = Selectable<Database['payroll_payment_format']>;
const dto = (r: FormatRow) => ({ id: r.id, name: r.name, fileType: r.file_type, delimiter: r.delimiter, utf8Bom: r.utf8_bom, hasHeader: r.has_header, asciiOnly: r.ascii_only, contentTemplate: r.content_template, columns: r.columns as FormatInput['columns'] });
const fnf = () => new AppError('PAYMENT_FORMAT_NOT_FOUND', 'Không tìm thấy mẫu tệp chi lương', 404);
const values = (b: FormatInput) => ({ name: b.name, file_type: b.fileType, delimiter: b.delimiter, utf8_bom: b.utf8Bom, has_header: b.hasHeader, ascii_only: b.asciiOnly, content_template: b.contentTemplate, columns: JSON.stringify(b.columns) });

// Bố cục chung: tạo lười khi công ty chưa có mẫu nào (như cấu trúc bảng lương mặc định).
const GENERAL: FormatInput = formatInput.parse({ name: 'Chung', fileType: 'csv', columns: [
  { field: 'seq', header: 'STT' }, { field: 'account_no', header: 'Số tài khoản' }, { field: 'account_name', header: 'Tên người nhận' },
  { field: 'bank_name', header: 'Ngân hàng' }, { field: 'amount', header: 'Số tiền' }, { field: 'content', header: 'Nội dung' }] });
export async function listFormats(trx: Trx, tenantId: string) {
  let rows = await trx.selectFrom('payroll_payment_format').selectAll().orderBy('name').execute();
  if (!rows.length) rows = [await trx.insertInto('payroll_payment_format').values({ tenant_id: tenantId, ...values(GENERAL) }).returningAll().executeTakeFirstOrThrow()];
  return rows.map(dto);
}
export async function saveFormat(trx: Trx, tenantId: string, id: number | null, b: FormatInput) {
  if (id === null) return dto(await trx.insertInto('payroll_payment_format').values({ tenant_id: tenantId, ...values(b) }).returningAll().executeTakeFirstOrThrow());
  const r = await trx.updateTable('payroll_payment_format').set({ ...values(b), updated_at: sql`now()` }).where('id', '=', id).returningAll().executeTakeFirst();
  if (!r) throw fnf();
  return dto(r);
}
export async function deleteFormat(trx: Trx, id: number) {
  const r = await trx.deleteFrom('payroll_payment_format').where('id', '=', id).executeTakeFirst(); // đã có lô dùng mẫu: khóa ngoại → 409 REFERENCED
  if (!r.numDeletedRows) throw fnf();
}

interface Recipient { employeeCode: string; employeeName: string; accountNo: string; accountName: string; bankCode: string; bankName: string; amount: string }
export interface PayWarning { code: 'RECIPIENT_ACCOUNT_MISSING' | 'PAY_METHOD_CASH'; employeeCode: string; employeeName: string; amount: string; message: string }
interface Ctx { runName: string; year: number; month: number; payerNo: string; payerName: string }

// Thực lĩnh từng nhân viên của bảng lương; người nhận đủ điều kiện vào tệp, người còn lại thành cảnh báo (thực lĩnh ≤ 0 không phải chi nên bỏ im lặng).
async function loadRecipients(trx: Trx, runId: number) {
  const rows = await trx.selectFrom('payroll_line as l').innerJoin('employee as e', 'e.id', 'l.employee_id').leftJoin('employee_payroll as p', 'p.employee_id', 'l.employee_id')
    .select(['e.code', 'e.name', 'l.net', 'p.pay_method', 'p.bank_code', 'p.bank_name', 'p.bank_account_no', 'p.bank_account_name']).where('l.run_id', '=', runId).orderBy('e.code').execute();
  const included: Recipient[] = []; const warnings: PayWarning[] = []; let payable = D(0);
  for (const r of rows) {
    const net = D(r.net); if (net.lte(0)) continue;
    const amount = net.toFixed(0); payable = payable.plus(net);
    const w = (code: PayWarning['code'], message: string) => warnings.push({ code, employeeCode: r.code, employeeName: r.name, amount, message });
    const accountNo = (r.bank_account_no ?? '').trim();
    if (r.pay_method === 'cash') w('PAY_METHOD_CASH', `${r.code} ${r.name}: trả bằng tiền mặt, không đưa vào tệp chuyển khoản`);
    else if (!accountNo) w('RECIPIENT_ACCOUNT_MISSING', `${r.code} ${r.name}: chưa có số tài khoản nhận trong hồ sơ lương, không đưa vào tệp`);
    else included.push({ employeeCode: r.code, employeeName: r.name, accountNo, accountName: (r.bank_account_name ?? '').trim() || r.name, bankCode: r.bank_code ?? '', bankName: r.bank_name ?? '', amount });
  }
  return { included, warnings, payable: payable.toFixed(0) };
}

const stripMarks = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D');
// Ma trận chuỗi (dòng tiêu đề nếu có + dòng dữ liệu) theo mẫu; dùng chung cho tệp và xem thử.
function matrix(f: FormatInput, rs: Recipient[], c: Ctx): string[][] {
  const txt = (s: string) => formulaSafe(f.asciiOnly ? stripMarks(s) : s);
  const head = f.hasHeader ? [f.columns.map((col) => txt(col.header || FIELD_LABEL[col.field]))] : [];
  const body = rs.map((r, i) => {
    const tok: Record<string, string> = { month: String(c.month), year: String(c.year), employee_name: r.employeeName, employee_code: r.employeeCode, run_name: c.runName };
    const content = f.contentTemplate.replace(/\{(\w+)\}/g, (_, t: string) => tok[t] ?? '');
    const v: Record<Exclude<Field, 'constant'>, string> = { seq: String(i + 1), employee_code: r.employeeCode, employee_name: r.employeeName, account_no: r.accountNo, account_name: r.accountName,
      bank_code: r.bankCode, bank_name: r.bankName, amount: r.amount, content, payer_account_no: c.payerNo, payer_account_name: c.payerName };
    return f.columns.map((col) => txt(col.field === 'constant' ? col.value ?? '' : v[col.field]));
  });
  return [...head, ...body];
}

function renderCsv(f: FormatInput, rows: string[][]): Buffer {
  const q = (t: string) => (t.includes(f.delimiter) || /["\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t);
  return Buffer.from(`${f.utf8Bom ? '﻿' : ''}${rows.map((r) => r.map(q).join(f.delimiter)).join('\r\n')}\r\n`, 'utf8');
}
async function renderXlsx(f: FormatInput, rows: string[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('Chi lương');
  f.columns.forEach((col, i) => { if (col.field !== 'amount') ws.getColumn(i + 1).numFmt = '@'; }); // số tài khoản, mã... giữ dạng chữ (không mất số 0 đầu)
  rows.forEach((r, ri) => ws.addRow(r.map((t, ci) => (f.columns[ci]!.field === 'amount' && !(f.hasHeader && ri === 0) && /^\d{1,15}$/.test(t) ? Number(t) : t))));
  if (f.hasHeader) ws.getRow(1).font = { bold: true };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function payer(trx: Trx, bankAccountId: number | undefined) {
  if (!bankAccountId) return { payerNo: '', payerName: '' };
  const ba = await trx.selectFrom('bank_account').select(['account_no', 'account_name', 'is_active']).where('id', '=', bankAccountId).executeTakeFirst();
  if (!ba || !ba.is_active) throw new AppError('BANK_ACCOUNT_NOT_FOUND', 'Không có tài khoản ngân hàng đang dùng này', 404);
  return { payerNo: ba.account_no, payerName: ba.account_name ?? '' };
}

/** Xem thử tối đa 5 dòng theo mẫu đang soạn (chưa lưu): với một bảng lương thật, hoặc dòng minh họa khi không chọn bảng lương. */
export async function previewFormat(trx: Trx, b: z.infer<typeof previewInput>) {
  const p = await payer(trx, b.bankAccountId);
  let ctx: Ctx = { runName: 'Bảng lương mẫu', year: 2026, month: 10, ...p }; let rs: Recipient[]; let warnings: PayWarning[] = []; let sample = true;
  if (b.runId) {
    const run = await trx.selectFrom('payroll_run').select(['name', 'year', 'month']).where('id', '=', b.runId).executeTakeFirst();
    if (!run) throw new AppError('PAYROLL_RUN_NOT_FOUND', 'Không tìm thấy bảng lương', 404);
    ctx = { runName: run.name, year: run.year, month: run.month, ...p }; sample = false;
    ({ included: rs, warnings } = await loadRecipients(trx, b.runId));
  } else rs = [['NV001', 'Nguyễn Văn An', '0011001234567', 'Vietcombank', '12500000'], ['NV002', 'Trần Thị Bích', '0071002345678', 'Techcombank', '9800000']]
    .map(([employeeCode, employeeName, accountNo, bankName, amount]) => ({ employeeCode: employeeCode!, employeeName: employeeName!, accountNo: accountNo!, accountName: employeeName!, bankCode: '', bankName: bankName!, amount: amount! }));
  return { sample, rows: matrix(b.format, rs.slice(0, 5), ctx), warnings, recipientCount: rs.length };
}

/** Xuất tệp chi lương của bảng lương đã hạch toán, ghi lô. Tổng số phải chi (kể cả người không vào tệp) phải khớp phiếu chi lương đã lập, lệch → 409 PAYMENT_TOTAL_MISMATCH. */
export async function exportPaymentFile(trx: Trx, tenantId: string, runId: number, b: z.infer<typeof exportInput>) {
  const r = await lockRun(trx, runId);
  if (r.status !== 'posted') throw new AppError('PAYROLL_RUN_NOT_POSTED', 'Bảng lương chưa hạch toán: hạch toán trước khi xuất tệp chi lương', 409);
  if ((await getRun(trx, tenantId, runId)).stale) throw new AppError('PAYROLL_RUN_STALE', 'Bảng lương cần chạy lại hạch toán (hồ sơ, chấm công hoặc tham số đã đổi): chạy lại trước khi xuất tệp chi lương', 409);
  const fr = await trx.selectFrom('payroll_payment_format').selectAll().where('id', '=', b.formatId).executeTakeFirst();
  if (!fr) throw fnf();
  const f = dto(fr) as FormatInput;
  const p = await payer(trx, b.bankAccountId);
  const { included, warnings, payable } = await loadRecipients(trx, runId);

  // Phiếu chi lương: theo voucherId hoặc liên kết sẵn của bảng lương; có thì tổng cần chi phải bằng tổng phiếu (phiếu lập từ cùng thực lĩnh).
  const pays = (await listPayVouchers(trx, runId)).filter((x) => x.kind === 'pay');
  if (b.voucherId && !pays.some((x) => x.voucherId === b.voucherId)) throw new AppError('PAYMENT_VOUCHER_NOT_LINKED', 'Chứng từ này không phải phiếu chi lương của bảng lương', 409);
  const v = pays.find((x) => x.voucherId === (b.voucherId ?? x.voucherId));
  if (v && D(v.amount).toFixed(0) !== payable)
    throw new AppError('PAYMENT_TOTAL_MISMATCH', `Tổng cần chi theo bảng lương (${payable}) lệch phiếu chi lương ${v.voucherNo ?? ''} (${D(v.amount).toFixed(0)}): kiểm tra phiếu chi hoặc lập lại`, 409, { payable, voucherTotal: D(v.amount).toFixed(0), voucherId: v.voucherId });
  if (!included.length) throw new AppError('PAYMENT_FILE_EMPTY', 'Không có nhân viên nào đủ điều kiện vào tệp (thiếu số tài khoản nhận hoặc trả tiền mặt)', 409, { warnings });

  const ext = f.fileType;
  const rows = matrix(f, included, { runName: r.name, year: r.year, month: r.month, ...p });
  const buf = ext === 'csv' ? renderCsv(f, rows) : await renderXlsx(f, rows);
  const total = included.reduce((s, x) => s.plus(x.amount), D(0)).toFixed(0);
  const fileName = `chi_luong_${r.year}_${String(r.month).padStart(2, '0')}.${ext}`;
  const batch = await trx.insertInto('payroll_payment_batch').values({
    tenant_id: tenantId, run_id: runId, format_id: b.formatId, bank_account_id: b.bankAccountId ?? null, voucher_id: v?.voucherId ?? null, file_name: fileName,
    content_type: ext === 'csv' ? 'text/csv; charset=utf-8' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', file_content: buf, total, count: included.length, warnings: JSON.stringify(warnings),
  }).returning(['id', 'created_at']).executeTakeFirstOrThrow();
  return { batchId: batch.id, fileName, fileType: ext, total, count: included.length, payableTotal: payable, voucherId: v?.voucherId ?? null, voucherNo: v?.voucherNo ?? null, warnings, createdAt: batch.created_at };
}

export async function listBatches(trx: Trx, runId: number) {
  const rows = await trx.selectFrom('payroll_payment_batch as b').innerJoin('payroll_payment_format as f', 'f.id', 'b.format_id').leftJoin('voucher as v', 'v.id', 'b.voucher_id')
    .select(['b.id', 'b.file_name', 'b.total', 'b.count', 'b.warnings', 'b.created_at', 'b.bank_account_id', 'b.voucher_id', 'f.name as format_name', 'v.voucher_no']).where('b.run_id', '=', runId).orderBy('b.id', 'desc').execute();
  return rows.map((x) => ({ id: x.id, fileName: x.file_name, total: x.total, count: x.count, warnings: x.warnings as PayWarning[], createdAt: x.created_at, formatName: x.format_name, bankAccountId: x.bank_account_id, voucherId: x.voucher_id, voucherNo: x.voucher_no }));
}
export async function getBatchFile(trx: Trx, batchId: number) {
  const b = await trx.selectFrom('payroll_payment_batch').select(['file_name', 'content_type', 'file_content']).where('id', '=', batchId).executeTakeFirst();
  if (!b) throw new AppError('PAYMENT_BATCH_NOT_FOUND', 'Không tìm thấy lô chi lương', 404);
  return { name: b.file_name, contentType: b.content_type, content: b.file_content };
}
