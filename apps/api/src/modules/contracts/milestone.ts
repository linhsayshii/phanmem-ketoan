import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import type { Database } from '@kt/db';
import { D, Decimal, VND_AMOUNT_RE } from '@kt/domain';
import { AppError } from '../../plugins/errors.js';
import { dateIso, fxRate } from '../ledger/vouchers.service.js';
import { createInvoice, type InvoiceDto, type InvoiceInput } from '../invoices/service.js';
import { listContracts } from '../orders/service.js';

// Đợt thanh toán của hợp đồng bán/mua và lập hóa đơn (HDB/HDM nháp) từ đợt (GĐ6 Task 13a). Hợp đồng vẫn là bảng contract (CRUD ở orders/service.ts).
type Trx = Transaction<Database>;
type Ctx = Parameters<typeof createInvoice>[1];

const amountRe = /^\d{1,16}(\.\d{1,4})?$/;
export const milestonesInput = z.object({
  milestones: z.array(z.object({
    id: z.number().int().positive().optional(), seq: z.number().int().positive(), description: z.string().trim().min(1, 'Nhập nội dung đợt').max(500),
    dueDate: dateIso.nullable().optional(),
    percent: z.string().regex(/^\d{1,3}(\.\d{1,4})?$/, 'Tỷ lệ không hợp lệ').refine((s) => D(s).gt(0) && D(s).lte(100), 'Tỷ lệ phải lớn hơn 0 và tối đa 100%').nullable().optional(),
    amount: z.string().regex(amountRe, 'Số tiền không hợp lệ').refine((s) => D(s).gt(0), 'Số tiền phải lớn hơn 0').nullable().optional(), // bỏ trống: tính theo tỷ lệ × giá trị hợp đồng
    taxCode: z.string().min(1).nullable().optional(), status: z.enum(['planned', 'cancelled']).default('planned'), note: z.string().max(1000).nullable().optional(),
  })).max(200, 'Tối đa 200 đợt mỗi hợp đồng').refine((a) => new Set(a.map((m) => m.seq)).size === a.length, 'STT đợt bị trùng'),
});
export const invoiceFromMilestoneInput = z.object({
  postingDate: dateIso, invoiceDate: dateIso.optional(), invoiceGroupCode: z.string().min(1), accountCode: z.string().min(1).optional(),
  invoiceNo: z.string().trim().min(1).max(30).optional(), formNo: z.string().max(20).optional(), serial: z.string().max(20).optional(), einvoiceSeriesId: z.number().int().positive().optional(),
  fxRate: fxRate.optional(), description: z.string().max(500).optional(),
});

export interface MilestoneDto {
  id: number; seq: number; description: string; dueDate: string | null; percent: string | null; amount: string; taxCode: string | null;
  status: 'planned' | 'cancelled' | 'invoiced'; note: string | null; voucherId: string | null; voucherType: string | null; voucherNo: string | null; voucherState: string | null; invoicedAt: string | null;
}
const notFound = () => new AppError('CONTRACT_NOT_FOUND', 'Không tìm thấy hợp đồng', 404);

async function milestonesOf(trx: Trx, contractId: number): Promise<MilestoneDto[]> {
  return (await sql<MilestoneDto>`SELECT m.id::int, m.seq, m.description, m.due_date::text AS "dueDate", m.percent::text, m.amount::text, m.tax_code AS "taxCode",
      CASE WHEN m.voucher_id IS NOT NULL THEN 'invoiced' ELSE m.status END AS status, m.note, m.voucher_id::text AS "voucherId", v.voucher_type AS "voucherType", v.voucher_no AS "voucherNo", v.state AS "voucherState",
      m.invoiced_at::text AS "invoicedAt"
    FROM contract_milestone m LEFT JOIN voucher v ON v.tenant_id = m.tenant_id AND v.id = m.voucher_id WHERE m.contract_id = ${contractId}::bigint ORDER BY m.seq`.execute(trx)).rows;
}

export async function getContract(trx: Trx, id: number) {
  const c = (await listContracts(trx)).find((x) => (x as { id: number }).id === id);
  if (!c) throw notFound();
  return { ...c, milestones: await milestonesOf(trx, id) };
}

// Thay cả danh sách đợt: có id thì sửa, không có thì thêm, đợt cũ không còn trong danh sách thì xóa. Đợt đã lập hóa đơn không xóa được, không đổi
// số tiền, thuế, trạng thái (hủy hóa đơn hoặc đảo trước); đổi nội dung, ngày, STT, ghi chú vẫn được. Khóa các dòng đợt như lúc lập hóa đơn để hai việc không đan xen.
export async function saveMilestones(trx: Trx, tenantId: string, contractId: number, b: z.infer<typeof milestonesInput>) {
  const c = (await sql<{ value: string; currency_code: string; minor_unit: number | null }>`SELECT c.value::text, c.currency_code, cu.minor_unit FROM contract c
    LEFT JOIN currency cu ON cu.tenant_id = c.tenant_id AND cu.code = c.currency_code WHERE c.id = ${contractId}::bigint AND c.kind <> 'loan' FOR UPDATE OF c`.execute(trx)).rows[0];
  if (!c) throw notFound();
  const isVnd = c.currency_code === 'VND'; const dp = isVnd ? 0 : (c.minor_unit ?? 2);
  const old = new Map((await sql<{ id: number; amount: string; tax_code: string | null; status: string; voucher_id: string | null }>`
    SELECT id::int, amount::text, tax_code, status, voucher_id::text FROM contract_milestone WHERE contract_id = ${contractId}::bigint FOR UPDATE`.execute(trx)).rows.map((r) => [r.id, r]));
  const taxCodes = [...new Set(b.milestones.map((m) => m.taxCode).filter((x): x is string => !!x))];
  if (taxCodes.length) {
    const found = new Set((await trx.selectFrom('tax_code').select('code').where('code', 'in', taxCodes).execute()).map((r) => r.code));
    const miss = taxCodes.find((x) => !found.has(x));
    if (miss) throw new AppError('LOOKUP_NOT_FOUND', `Không có mã thuế "${miss}"`, 404);
  }
  const keep = new Set<number>();
  for (const m of b.milestones) {
    const n = `Đợt ${m.seq}`;
    let amount = m.amount ?? null;
    if (amount === null) {
      if (!m.percent) throw new AppError('VALIDATION', `${n}: nhập số tiền hoặc tỷ lệ`, 400);
      if (!D(c.value).gt(0)) throw new AppError('VALIDATION', `${n}: hợp đồng chưa có giá trị để tính số tiền theo tỷ lệ`, 400);
      amount = D(c.value).times(m.percent).div(100).toDecimalPlaces(dp, Decimal.ROUND_HALF_UP).toFixed(dp);
      if (!D(amount).gt(0)) throw new AppError('VALIDATION', `${n}: số tiền theo tỷ lệ bằng 0`, 400);
    }
    if (isVnd ? !VND_AMOUNT_RE.test(D(amount).toFixed()) : D(amount).decimalPlaces() > dp) throw new AppError('VALIDATION', `${n}: số tiền ${isVnd ? 'VND phải là số nguyên' : `tối đa ${dp} chữ số thập phân`}`, 400);
    const row = { seq: m.seq, description: m.description, due_date: m.dueDate ?? null, percent: m.percent ?? null, amount, tax_code: m.taxCode ?? null, status: m.status, note: m.note ?? null };
    if (m.id === undefined) {
      await sql`INSERT INTO contract_milestone(tenant_id, contract_id, seq, description, due_date, percent, amount, tax_code, status, note)
        VALUES (${tenantId}::uuid, ${contractId}::bigint, ${row.seq}, ${row.description}, ${row.due_date}::date, ${row.percent}::numeric, ${row.amount}::numeric, ${row.tax_code}, ${row.status}, ${row.note})`.execute(trx);
      continue;
    }
    const o = old.get(m.id);
    if (!o) throw new AppError('MILESTONE_NOT_FOUND', `${n}: không có đợt này trong hợp đồng`, 404);
    keep.add(m.id);
    if (o.voucher_id && (!D(o.amount).eq(amount) || o.tax_code !== row.tax_code || row.status !== 'planned'))
      throw new AppError('MILESTONE_INVOICED', `${n} đã lập hóa đơn: không đổi số tiền, thuế, trạng thái (hủy hoặc đảo hóa đơn trước)`, 409);
    await sql`UPDATE contract_milestone SET seq = ${row.seq}, description = ${row.description}, due_date = ${row.due_date}::date, percent = ${row.percent}::numeric, amount = ${row.amount}::numeric,
      tax_code = ${row.tax_code}, status = ${row.status}, note = ${row.note} WHERE id = ${m.id}::bigint`.execute(trx);
  }
  const drop = [...old.values()].filter((o) => !keep.has(o.id));
  if (drop.some((o) => o.voucher_id)) throw new AppError('MILESTONE_INVOICED', 'Đợt đã lập hóa đơn không xóa được (hủy hoặc đảo hóa đơn trước)', 409);
  if (drop.length) await sql`DELETE FROM contract_milestone WHERE id = ANY(${drop.map((o) => o.id)}::bigint[])`.execute(trx);
  return getContract(trx, contractId);
}

// Lập hóa đơn nháp (HDB cho hợp đồng bán, HDM cho hợp đồng mua) từ một đợt qua dịch vụ hóa đơn: một dòng hàng = số tiền chưa thuế của đợt, thuế GTGT của đợt
// (không có thì của hợp đồng), TK doanh thu/chi phí theo yêu cầu hoặc hợp đồng, chiều hợp đồng trên mọi dòng sổ cái. Khóa dòng đợt (FOR UPDATE) rồi mới kiểm
// "đã lập": yêu cầu đồng thời thứ hai đợi, đọc lại dòng đã gắn hóa đơn và nhận 409.
export async function invoiceMilestone(trx: Trx, ctx: Ctx, contractId: number, milestoneId: number, b: z.infer<typeof invoiceFromMilestoneInput>): Promise<{ milestone: MilestoneDto; invoice: InvoiceDto }> {
  const m = (await sql<{ seq: number; description: string; amount: string; tax_code: string | null; status: string; voucher_id: string | null; code: string; name: string; kind: string;
    c_status: string; party_code: string | null; currency_code: string; account_code: string | null; c_tax: string | null }>`
    SELECT m.seq, m.description, m.amount::text, m.tax_code, m.status, m.voucher_id::text, c.code, c.name, c.kind, c.status AS c_status, p.code AS party_code, c.currency_code, c.account_code, c.tax_code AS c_tax
    FROM contract_milestone m JOIN contract c ON c.tenant_id = m.tenant_id AND c.id = m.contract_id LEFT JOIN party p ON p.tenant_id = c.tenant_id AND p.id = c.party_id
    WHERE m.id = ${milestoneId}::bigint AND m.contract_id = ${contractId}::bigint FOR UPDATE OF m`.execute(trx)).rows[0];
  if (!m) throw new AppError('MILESTONE_NOT_FOUND', 'Không tìm thấy đợt thanh toán của hợp đồng', 404);
  if (m.voucher_id) throw new AppError('MILESTONE_INVOICED', `Đợt ${m.seq} đã lập hóa đơn`, 409);
  if (m.status === 'cancelled') throw new AppError('MILESTONE_CANCELLED', `Đợt ${m.seq} đã hủy`, 409);
  if (m.c_status !== 'active') throw new AppError('CONTRACT_NOT_ACTIVE', `Hợp đồng ${m.code} không ở trạng thái hiệu lực`, 409);
  if (!m.party_code) throw new AppError('CONTRACT_PARTY_REQUIRED', `Hợp đồng ${m.code} chưa có đối tượng (khách hàng/nhà cung cấp)`, 400);
  const accountCode = b.accountCode ?? m.account_code;
  if (!accountCode) throw new AppError('CONTRACT_ACCOUNT_REQUIRED', `Chọn tài khoản ${m.kind === 'sale' ? 'doanh thu' : 'chi phí'} cho hóa đơn (hoặc khai báo ở hợp đồng ${m.code})`, 400);
  const taxCode = m.tax_code ?? m.c_tax;
  const invoiceDate = b.invoiceDate ?? b.postingDate;
  const input: InvoiceInput = {
    voucherType: m.kind === 'sale' ? 'HDB' : 'HDM', postingDate: b.postingDate, documentDate: invoiceDate, partyCode: m.party_code, currencyCode: m.currency_code,
    ...(b.fxRate && { fxRate: b.fxRate }), description: b.description ?? `${m.name} - đợt ${m.seq}: ${m.description}`, contractCode: m.code,
    items: [{ description: m.description, accountCode, amountCurrency: D(m.amount).toFixed(), discountCurrency: '0', taxCodes: taxCode ? [taxCode] : [] }],
    invoice: { invoiceDate, invoiceGroupCode: b.invoiceGroupCode, ...(b.invoiceNo && { invoiceNo: b.invoiceNo }), ...(b.formNo && { formNo: b.formNo }), ...(b.serial && { serial: b.serial }),
      ...(b.einvoiceSeriesId !== undefined && { einvoiceSeriesId: b.einvoiceSeriesId }) },
  };
  const invoice = await createInvoice(trx, ctx, input);
  await sql`UPDATE contract_milestone SET voucher_id = ${invoice.id}::uuid, invoiced_by = ${ctx.userId}::uuid, invoiced_at = now() WHERE id = ${milestoneId}::bigint`.execute(trx);
  return { milestone: (await milestonesOf(trx, contractId)).find((x) => x.id === milestoneId)!, invoice };
}
