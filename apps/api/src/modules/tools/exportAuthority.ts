import archiver from 'archiver';
import { createHash } from 'node:crypto';
import { sql, type Transaction } from 'kysely';
import type { Database } from '@kt/db';
import { renderPdf } from '../reporting/print/pdf.js';
import { assertPrintable, renderReportsHtml, type ReportDoc } from '../reporting/print/html.js';
import { bookSetDocs } from '../reporting/print/bookSet.js';

type Trx = Transaction<Database>;
type Row = Record<string, unknown>;
export interface AuthorityData { from: string; to: string; company: { name: string; taxCode: string | null }; csv: { name: string; data: string }[]; pdfs: { name: string; docs: ReportDoc[] }[] }

// BOM để Excel nhận UTF-8; bọc nháy kép khi ô chứa dấu phân cách, nháy kép hoặc xuống dòng (\n hoặc \r).
export function toCsv(rows: Row[], columns: string[]): string {
  const esc = (v: unknown) => { const s = v === null || v === undefined ? '' : String(v); return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return '\ufeff' + [columns.join(';'), ...rows.map((r) => columns.map((c) => esc(r[c])).join(';'))].join('\n') + '\n';
}

// Mỗi tệp PDF là một nhóm sổ của cả năm tài chính chứa ngày kết thúc (bookSetDocs dựng theo năm); gọi riêng từng nhóm để khỏi đoán nhóm theo tiêu đề.
const PDF_FILES = [['so_nhat_ky_chung.pdf', 'journal'], ['so_cai.pdf', 'ledgers'], ['bang_can_doi_so_phat_sinh.pdf', 'trial'], ['B01.pdf', 'B01'], ['B02.pdf', 'B02'], ['B03.pdf', 'B03']] as const;

// Phần đọc dữ liệu: chạy trong giao dịch của công ty. PDF và zip dựng sau, ngoài giao dịch (buildAuthorityPackage), để Chromium không giữ kết nối DB.
// shortcut: toàn bộ CSV nằm trong bộ nhớ, đủ cho vài trăm nghìn dòng định khoản; lớn hơn thì phải ghi luồng.
export async function collectAuthorityData(trx: Trx, tenantId: string, p: { from: string; to: string }): Promise<AuthorityData> {
  const pdfs: AuthorityData['pdfs'] = [];
  // Báo cáo chưa có định nghĩa được bookSetDocs bỏ qua nên không có B0x.pdf. Chặn sổ quá lớn trước mọi việc dựng PDF (CSV không bị giới hạn).
  for (const [name, include] of PDF_FILES) { const docs = await bookSetDocs(trx, tenantId, Number(p.to.slice(0, 4)), [include]); if (docs.length) { assertPrintable(docs); pdfs.push({ name, docs }); } }
  const t = await trx.selectFrom('tenant').select(['name', 'tax_code']).where('id', '=', tenantId).executeTakeFirstOrThrow();
  const csv: AuthorityData['csv'] = [];
  const add = (name: string, rows: Row[], cols: string[]) => csv.push({ name, data: toCsv(rows, cols) });
  const vouchers = (await sql<Row>`SELECT v.id, v.voucher_type, v.voucher_no, v.seq_no, v.posting_date, v.document_date, v.state, v.description, p.code AS party_code, p.name AS party_name, v.currency_code, v.fx_rate, v.is_closing, v.reversal_of_id, v.reversed_by_id, v.source_doc_type, v.source_doc_id, u.username AS created_by, v.created_at, pu.username AS posted_by, v.posted_at, encode(v.row_hash, 'hex') AS row_hash
    FROM voucher v LEFT JOIN party p ON p.id = v.party_id LEFT JOIN app_user u ON u.id = v.created_by LEFT JOIN app_user pu ON pu.id = v.posted_by WHERE v.posting_date BETWEEN ${p.from}::date AND ${p.to}::date AND v.state <> 'draft' ORDER BY v.posting_date, v.voucher_type, v.seq_no, v.id`.execute(trx)).rows;
  add('chung_tu.csv', vouchers, ['id', 'voucher_type', 'voucher_no', 'seq_no', 'posting_date', 'document_date', 'state', 'description', 'party_code', 'party_name', 'currency_code', 'fx_rate', 'is_closing', 'reversal_of_id', 'reversed_by_id', 'source_doc_type', 'source_doc_id', 'created_by', 'created_at', 'posted_by', 'posted_at', 'row_hash']);
  const lines = (await sql<Row>`SELECT l.voucher_id, v.voucher_no, l.line_no, a.code AS account_code, a.name AS account_name, l.debit, l.credit, l.currency_code, l.amount_currency, l.fx_rate, p.code AS party_code, d.code AS department_code, pr.code AS project_code, ci.code AS cost_item_code, e.code AS employee_code, l.description, l.due_date, l.posting_date
    FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id JOIN account a ON a.id = l.account_id LEFT JOIN party p ON p.id = l.party_id LEFT JOIN department d ON d.id = l.department_id LEFT JOIN project pr ON pr.id = l.project_id LEFT JOIN cost_item ci ON ci.id = l.cost_item_id LEFT JOIN employee e ON e.id = l.employee_id
    WHERE v.posting_date BETWEEN ${p.from}::date AND ${p.to}::date AND v.state <> 'draft' ORDER BY v.posting_date, v.voucher_type, v.seq_no, v.id, l.line_no`.execute(trx)).rows;
  add('dong_chung_tu.csv', lines, ['voucher_id', 'voucher_no', 'line_no', 'account_code', 'account_name', 'debit', 'credit', 'currency_code', 'amount_currency', 'fx_rate', 'party_code', 'department_code', 'project_code', 'cost_item_code', 'employee_code', 'description', 'due_date', 'posting_date']);
  // Một công ty có thể giữ nhiều hệ tài khoản (UNIQUE theo regime, code): liệt kê đủ, cột regime phân biệt.
  const accountCols = ['regime', 'code', 'name', 'is_group', 'root_type', 'normal_balance', 'subledger_kind', 'track_currency', 'is_active'];
  add('he_thong_tai_khoan.csv', await trx.selectFrom('account').select(['regime', 'code', 'name', 'is_group', 'root_type', 'normal_balance', 'subledger_kind', 'track_currency', 'is_active']).orderBy('regime').orderBy('code').execute(), accountCols);
  const partyCols = ['code', 'name', 'tax_code', 'address', 'is_customer', 'is_vendor', 'is_employee', 'is_active'];
  add('doi_tuong.csv', await trx.selectFrom('party').select(['code', 'name', 'tax_code', 'address', 'is_customer', 'is_vendor', 'is_employee', 'is_active']).orderBy('code').execute(), partyCols);
  const periodCols = ['fiscal_year', 'period_no', 'date_from', 'date_to', 'regime', 'status', 'hash_tail', 'locked_at'];
  add('ky_ke_toan.csv', await trx.selectFrom('fiscal_period').select(['fiscal_year', 'period_no', 'date_from', 'date_to', 'regime', 'status', sql<string>`encode(hash_tail, 'hex')`.as('hash_tail'), 'locked_at']).orderBy('fiscal_year').orderBy('period_no').execute(), periodCols);
  // Cùng cách lọc khoảng ngày như màn hình Nhật ký kiểm toán: ts từ đầu ngày `from` đến hết ngày `to`.
  const auditCols = ['ts', 'username', 'action', 'entity', 'entity_id', 'before', 'after', 'ip'];
  add('nhat_ky_kiem_toan.csv', await trx.selectFrom('audit_event as a').leftJoin('app_user as u', 'u.id', 'a.user_id')
    .select(['a.ts', 'u.username', 'a.action', 'a.entity', 'a.entity_id', sql<string>`a.before::text`.as('before'), sql<string>`a.after::text`.as('after'), 'a.ip'])
    .where('a.ts', '>=', p.from).where('a.ts', '<', sql<string>`(${p.to}::date + 1)`).orderBy('a.id').execute(), auditCols);
  return { from: p.from, to: p.to, company: { name: t.name, taxCode: t.tax_code }, csv, pdfs };
}

const readme = (d: AuthorityData, exportedAt: Date) => [`CÔNG TY: ${d.company.name}`, `MÃ SỐ THUẾ: ${d.company.taxCode ?? ''}`, `KHOẢNG KỲ: ${d.from} đến ${d.to}`, `THỜI ĐIỂM XUẤT: ${exportedAt.toISOString()}`, '',
  'Tệp CSV mã hóa UTF-8 có BOM, phân cách bằng dấu chấm phẩy (;), dòng đầu là tên cột; ô có dấu ;, nháy kép hoặc xuống dòng được bọc nháy kép (nháy kép trong ô viết đôi). Tiền hạch toán VND là số nguyên, ngày dạng YYYY-MM-DD, thời điểm theo giờ máy chủ kèm múi giờ.',
  'chung_tu.csv: phần đầu chứng từ đã ghi sổ có ngày ghi sổ trong khoảng kỳ (gồm đã đảo, đã hủy; không có chứng từ nháp). Cột: id; voucher_type loại; voucher_no số; seq_no số thứ tự; posting_date ngày ghi sổ; document_date ngày chứng từ; state (posted đã ghi sổ, reversed đã đảo, cancelled đã hủy); description diễn giải; party_code, party_name đối tượng; currency_code, fx_rate ngoại tệ và tỷ giá; is_closing chứng từ kết chuyển; reversal_of_id, reversed_by_id liên kết đảo; source_doc_type, source_doc_id nguồn của chứng từ tự động; created_by, created_at người và thời điểm lập; posted_by, posted_at người và thời điểm ghi sổ; row_hash băm SHA-256 trong chuỗi khóa cứng (trống khi kỳ chưa khóa cứng).',
  'dong_chung_tu.csv: dòng định khoản của các chứng từ trên. Cột: voucher_id, voucher_no, line_no; account_code, account_name tài khoản; debit, credit số tiền Nợ, Có theo VND; currency_code, amount_currency (nguyên tệ, có dấu), fx_rate; party_code, department_code, project_code, cost_item_code, employee_code các chiều phân tích; description; due_date hạn thanh toán; posting_date.',
  'he_thong_tai_khoan.csv: mọi hệ tài khoản của công ty, cột regime là hệ (TT99, TT133, TT200, TT58). doi_tuong.csv: danh mục đối tượng. ky_ke_toan.csv: các kỳ kế toán, trạng thái khóa (open, soft_locked, hard_locked), hash_tail là băm cuối chuỗi của kỳ khóa cứng, locked_at thời điểm khóa.',
  'nhat_ky_kiem_toan.csv: mọi sự kiện ghi nhận trong khoảng kỳ (theo thời điểm xảy ra, không theo ngày ghi sổ) với giá trị trước/sau dạng JSON (Điều 28 TT 99/2025).',
  'so_nhat_ky_chung.pdf, so_cai.pdf, bang_can_doi_so_phat_sinh.pdf, B01.pdf, B02.pdf, B03.pdf: sổ kế toán và báo cáo tài chính của cả năm tài chính chứa ngày kết thúc (khác với các tệp CSV chỉ trong khoảng kỳ). Báo cáo tài chính chưa được công ty định nghĩa thì không có tệp.',
  'MANIFEST.sha256: băm SHA-256 từng tệp trong gói (trừ chính nó), kiểm tra bằng: shasum -a 256 -c MANIFEST.sha256'].join('\n');

// Dựng PDF và nén zip: chạy ngoài giao dịch DB. Khổ giấy từng sổ do renderReportsHtml quyết định (CSS), không qua tùy chọn landscape của renderPdf.
export async function buildAuthorityPackage(d: AuthorityData, exportedAt = new Date()): Promise<Buffer> {
  const files: { name: string; data: Buffer }[] = [{ name: 'README.txt', data: Buffer.from(readme(d, exportedAt), 'utf8') }, ...d.csv.map((c) => ({ name: c.name, data: Buffer.from(c.data, 'utf8') }))];
  for (const f of d.pdfs) files.push({ name: f.name, data: await renderPdf(renderReportsHtml(f.docs)) });
  files.push({ name: 'MANIFEST.sha256', data: Buffer.from(files.map((f) => `${createHash('sha256').update(f.data).digest('hex')}  ${f.name}`).join('\n') + '\n', 'utf8') });
  return new Promise<Buffer>((resolve, reject) => {
    const zip = archiver('zip', { zlib: { level: 6 } }); const chunks: Buffer[] = [];
    zip.on('data', (c: Buffer) => chunks.push(c)).on('error', reject).on('end', () => resolve(Buffer.concat(chunks)));
    for (const f of files) zip.append(f.data, { name: f.name });
    void zip.finalize();
  });
}
