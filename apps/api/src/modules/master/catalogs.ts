import { z } from 'zod';
import { loadNapasBins } from '@kt/coa-data';
import type { Database } from '@kt/db';
import { TAX_CODE_RE, VND_AMOUNT_RE } from '@kt/domain';

export interface ColumnDef { key: string; label: string; type: 'text' | 'number' | 'boolean' | 'date' | 'select'; required?: boolean; options?: { value: string; label: string }[]; lookup?: { catalog: string }; width?: number;
  // Tài khoản kế toán theo mã (theo chế độ của kỳ mới nhất); idKey: tên cột id khi khác `<x>_id`; importOnly: cột chỉ có trong mẫu Excel, không phải cột bảng.
  account?: boolean; idKey?: string; importOnly?: boolean }
// nullsNotDistinct: ràng buộc duy nhất của bảng là UNIQUE NULLS NOT DISTINCT (NULL trùng NULL), nhập Excel kiểm trùng theo IS NULL.
export interface CatalogDef { name: string; table: keyof Database; label: string; schema: z.ZodObject<z.ZodRawShape>; columns: ColumnDef[]; uniqueBy: string[]; sort: string; searchIn: string[]; nullsNotDistinct?: boolean; perm?: string }
// Cột id trong DB của cột tra cứu `<x>_code`.
export const idKeyOf = (c: ColumnDef): string => c.idKey ?? c.key.replace(/_code$/, '_id');

// Số tiền VND: số nguyên không dấu, tối đa 16 chữ số (cột numeric(20,0)).
const vnd = z.string().regex(VND_AMOUNT_RE);
// Tỷ giá numeric(20,10): tối đa 10 chữ số nguyên và 10 chữ số thập phân, phải > 0.
const exRate = z.string().regex(/^\d{1,10}(\.\d{1,10})?$/).refine((v) => Number(v) > 0);
// Thuế suất % numeric(5,2): không quá 100.
const pct = z.string().regex(/^\d{1,3}(\.\d{1,2})?$/).refine((v) => Number(v) <= 100);
// Tỷ lệ phân bổ thuế numeric(7,4) trong [-100, 100]: âm là khấu trừ tại nguồn.
const factor = z.string().regex(/^-?\d{1,3}(\.\d{1,4})?$/).refine((v) => Math.abs(Number(v)) <= 100);
const SCOPE_OPTIONS = [{ value: 'purchase', label: 'Mua vào' }, { value: 'sale', label: 'Bán ra' }];
// Ngày ISO hợp lệ: loại 2026-02-30 bằng cách dựng lại ngày UTC rồi so chuỗi.
export const dateIso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => {
  const [y, m, d] = s.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d));
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === s;
});
// Mã tiền tệ khớp assertId của currency (/^[A-Z]{3}$/), nếu không dòng tạo ra sẽ không GET/PUT/DELETE được.
const ccy = z.string().regex(/^[A-Z]{3}$/, 'Mã tiền tệ gồm 3 chữ in hoa');
const code = z.string().trim().min(1).max(30);
const qty = z.string().regex(/^\d{1,16}(\.\d{1,4})?$/, 'Số lượng không hợp lệ').nullable().optional();
const uomFactor = z.string().regex(/^\d{1,14}(\.\d{1,6})?$/, 'Hệ số không hợp lệ').refine((v) => Number(v) > 0, 'Hệ số phải lớn hơn 0');
const intOpt = (max: number) => z.union([z.number(), z.string().trim().regex(/^\d+$/, 'Nhập số nguyên').transform(Number)]).pipe(z.number().int().min(1).max(max)).nullable().optional();
const text = (o = true) => (o ? z.string().nullable().optional() : z.string().trim().min(1));

const defs: CatalogDef[] = [
  { name: 'party_group', table: 'party_group', label: 'Nhóm đối tượng', uniqueBy: ['code'], sort: 'code', searchIn: ['code', 'name'],
    schema: z.object({ code, name: text(false), is_active: z.boolean().optional() }),
    columns: [{ key: 'code', label: 'Mã', type: 'text', required: true }, { key: 'name', label: 'Tên nhóm', type: 'text', required: true }] },
  { name: 'party', table: 'party', label: 'Đối tượng', uniqueBy: ['code'], sort: 'code', searchIn: ['code', 'name', 'tax_code'],
    schema: z.object({ code, name: text(false), is_customer: z.boolean().optional(), is_vendor: z.boolean().optional(), is_employee: z.boolean().optional(),
      group_code: text(), tax_code: z.string().regex(TAX_CODE_RE).nullable().optional(), id_number: text(), id_issue_date: dateIso.nullable().optional(), id_issue_place: text(),
      address: text(), invoice_address: text(), contact_name: text(), phone: text(), email: z.string().email().nullable().optional(),
      payment_term_days: z.number().int().min(0).max(3650).nullable().optional(), credit_limit: vnd.nullable().optional(), default_account_code: text(), note: text(), is_active: z.boolean().optional() }),
    columns: [{ key: 'code', label: 'Mã', type: 'text', required: true }, { key: 'name', label: 'Tên đối tượng', type: 'text', required: true },
      { key: 'is_customer', label: 'Khách hàng', type: 'boolean' }, { key: 'is_vendor', label: 'Nhà cung cấp', type: 'boolean' }, { key: 'is_employee', label: 'Nhân viên', type: 'boolean' },
      { key: 'group_code', label: 'Nhóm', type: 'text', lookup: { catalog: 'party_group' } }, { key: 'tax_code', label: 'Mã số thuế', type: 'text' }, { key: 'id_number', label: 'Số CCCD', type: 'text' },
      { key: 'address', label: 'Địa chỉ', type: 'text' }, { key: 'invoice_address', label: 'Địa chỉ hóa đơn', type: 'text' }, { key: 'contact_name', label: 'Người liên hệ', type: 'text' },
      { key: 'phone', label: 'Điện thoại', type: 'text' }, { key: 'email', label: 'Email', type: 'text' }, { key: 'payment_term_days', label: 'Hạn thanh toán (ngày)', type: 'number' },
      { key: 'credit_limit', label: 'Hạn mức nợ', type: 'number' }, { key: 'default_account_code', label: 'TK công nợ ngầm định', type: 'text' }] },
  { name: 'party_bank_account', table: 'party_bank_account', label: 'Tài khoản ngân hàng đối tượng', uniqueBy: ['party_code', 'account_no'], sort: 'account_no', searchIn: ['account_no', 'bank_name'],
    schema: z.object({ party_code: code, bank_name: text(false), account_no: text(false), account_name: text(), branch: text() }),
    columns: [{ key: 'party_code', label: 'Đối tượng', type: 'text', required: true, lookup: { catalog: 'party' } }, { key: 'bank_name', label: 'Ngân hàng', type: 'text', required: true },
      { key: 'account_no', label: 'Số tài khoản', type: 'text', required: true }, { key: 'account_name', label: 'Tên tài khoản', type: 'text' }, { key: 'branch', label: 'Chi nhánh', type: 'text' }] },
  { name: 'department', table: 'department', label: 'Bộ phận / chi nhánh', uniqueBy: ['code'], sort: 'code', searchIn: ['code', 'name'],
    schema: z.object({ code, name: text(false), parent_code: text(), is_branch: z.boolean().optional(), is_active: z.boolean().optional() }),
    columns: [{ key: 'code', label: 'Mã', type: 'text', required: true }, { key: 'name', label: 'Tên bộ phận', type: 'text', required: true },
      { key: 'parent_code', label: 'Thuộc bộ phận', type: 'text', lookup: { catalog: 'department' } }, { key: 'is_branch', label: 'Là chi nhánh', type: 'boolean' }] },
  { name: 'employee', table: 'employee', label: 'Nhân viên', uniqueBy: ['code'], sort: 'code', searchIn: ['code', 'name'],
    schema: z.object({ code, name: text(false), department_code: text(), party_code: text(), tax_code: text(), id_number: text(), position: text(), phone: text(), email: text(), is_active: z.boolean().optional() }),
    columns: [{ key: 'code', label: 'Mã', type: 'text', required: true }, { key: 'name', label: 'Họ tên', type: 'text', required: true },
      { key: 'department_code', label: 'Bộ phận', type: 'text', lookup: { catalog: 'department' } }, { key: 'party_code', label: 'Đối tượng công nợ', type: 'text', lookup: { catalog: 'party' } },
      { key: 'tax_code', label: 'MST cá nhân', type: 'text' }, { key: 'id_number', label: 'Số CCCD', type: 'text' }, { key: 'position', label: 'Chức vụ', type: 'text' }, { key: 'phone', label: 'Điện thoại', type: 'text' }, { key: 'email', label: 'Email', type: 'text' }] },
  { name: 'currency', table: 'currency', label: 'Loại tiền', uniqueBy: ['code'], sort: 'code', searchIn: ['code', 'name'],
    schema: z.object({ code: ccy, name: text(false), symbol: text(), minor_unit: z.number().int().min(0).max(4).optional(), is_active: z.boolean().optional() }),
    columns: [{ key: 'code', label: 'Mã', type: 'text', required: true }, { key: 'name', label: 'Tên', type: 'text', required: true }, { key: 'symbol', label: 'Ký hiệu', type: 'text' }, { key: 'minor_unit', label: 'Số lẻ', type: 'number' }] },
  { name: 'exchange_rate', table: 'exchange_rate', label: 'Tỷ giá', uniqueBy: ['currency_code', 'rate_date', 'rate_type'], sort: 'rate_date', searchIn: ['currency_code'],
    schema: z.object({ currency_code: ccy, rate_date: dateIso, rate_type: z.enum(['transfer_avg', 'buy', 'sell']), rate: exRate }),
    columns: [{ key: 'currency_code', label: 'Loại tiền', type: 'text', required: true, lookup: { catalog: 'currency' } }, { key: 'rate_date', label: 'Ngày', type: 'date', required: true },
      { key: 'rate_type', label: 'Loại tỷ giá', type: 'select', required: true, options: [{ value: 'transfer_avg', label: 'Mua bán CK trung bình' }, { value: 'buy', label: 'Mua' }, { value: 'sell', label: 'Bán' }] },
      { key: 'rate', label: 'Tỷ giá', type: 'number', required: true }] },
  { name: 'bank', table: 'bank', label: 'Ngân hàng', uniqueBy: ['code'], sort: 'code', searchIn: ['code', 'name', 'short_name'],
    schema: z.object({ code, name: text(false), short_name: text(), napas_bin: z.string().regex(/^\d{6}$/, 'BIN NAPAS gồm 6 chữ số').nullable().optional(), is_active: z.boolean().optional() }),
    columns: [{ key: 'code', label: 'Mã', type: 'text', required: true }, { key: 'name', label: 'Tên ngân hàng', type: 'text', required: true }, { key: 'short_name', label: 'Tên viết tắt', type: 'text' },
      { key: 'napas_bin', label: 'BIN NAPAS (mã VietQR)', type: 'select', options: loadNapasBins().map((b) => ({ value: b.bin, label: `${b.bin} – ${b.shortName}` })) }] },
  { name: 'bank_account', table: 'bank_account', label: 'Tài khoản ngân hàng công ty', uniqueBy: ['account_no'], sort: 'account_no', searchIn: ['account_no', 'account_name'],
    schema: z.object({ bank_code: code, account_no: text(false), account_name: text(), branch: text(), currency_code: ccy.optional(), gl_account_code: text(false), is_active: z.boolean().optional() }),
    columns: [{ key: 'bank_code', label: 'Ngân hàng', type: 'text', required: true, lookup: { catalog: 'bank' } }, { key: 'account_no', label: 'Số tài khoản', type: 'text', required: true },
      { key: 'account_name', label: 'Tên tài khoản', type: 'text' }, { key: 'branch', label: 'Chi nhánh', type: 'text' }, { key: 'currency_code', label: 'Loại tiền', type: 'text', lookup: { catalog: 'currency' } },
      { key: 'gl_account_code', label: 'Tài khoản kế toán (112x)', type: 'text', required: true }] },
  { name: 'payment_method', table: 'payment_method', label: 'Hình thức thanh toán', uniqueBy: ['code'], sort: 'code', searchIn: ['code', 'name'],
    schema: z.object({ code, name: text(false), is_active: z.boolean().optional() }),
    columns: [{ key: 'code', label: 'Mã', type: 'text', required: true }, { key: 'name', label: 'Tên', type: 'text', required: true }] },
  { name: 'tax_code', table: 'tax_code', label: 'Loại thuế', uniqueBy: ['code'], sort: 'code', searchIn: ['code', 'name'],
    schema: z.object({ code, name: text(false), kind: z.enum(['vat', 'pit', 'import', 'excise']), rate: pct.nullable().optional(), is_exempt: z.boolean().optional(), in_declaration: z.boolean().optional(),
      scope: z.enum(['sale', 'purchase', 'both']).optional(), method: z.enum(['deduct', 'direct', 'none']).optional(), price_include: z.boolean().optional(), is_active: z.boolean().optional() }),
    columns: [{ key: 'code', label: 'Mã', type: 'text', required: true }, { key: 'name', label: 'Tên', type: 'text', required: true },
      { key: 'kind', label: 'Loại', type: 'select', required: true, options: [{ value: 'vat', label: 'GTGT' }, { value: 'pit', label: 'TNCN' }, { value: 'import', label: 'Nhập khẩu' }, { value: 'excise', label: 'TTĐB' }] },
      { key: 'rate', label: 'Thuế suất %', type: 'number' }, { key: 'is_exempt', label: 'Không chịu thuế', type: 'boolean' }, { key: 'in_declaration', label: 'Lên tờ khai', type: 'boolean' },
      { key: 'scope', label: 'Áp dụng', type: 'select', options: [...SCOPE_OPTIONS, { value: 'both', label: 'Mua vào và bán ra' }] },
      { key: 'method', label: 'Phương pháp', type: 'select', options: [{ value: 'deduct', label: 'Khấu trừ' }, { value: 'direct', label: 'Trực tiếp trên doanh thu' }, { value: 'none', label: 'Không tính thuế' }] },
      { key: 'price_include', label: 'Giá đã gồm thuế', type: 'boolean' }] },
  { name: 'tax_distribution', table: 'tax_distribution', label: 'Phân bổ thuế', uniqueBy: ['tax_code_code', 'document_type', 'scope', 'line_type', 'account_code'], nullsNotDistinct: true, sort: 'tax_code_id', searchIn: ['account_code', 'report_tag'],
    schema: z.object({ tax_code_code: code, document_type: z.enum(['invoice', 'refund']), scope: z.enum(['sale', 'purchase']), line_type: z.enum(['base', 'tax']), factor_percent: factor, account_code: text(), report_tag: text() }),
    columns: [{ key: 'tax_code_code', label: 'Loại thuế', type: 'text', required: true, lookup: { catalog: 'tax_code' } },
      { key: 'document_type', label: 'Chứng từ', type: 'select', required: true, options: [{ value: 'invoice', label: 'Hóa đơn' }, { value: 'refund', label: 'Giảm giá, trả lại' }] },
      { key: 'scope', label: 'Mua/Bán', type: 'select', required: true, options: SCOPE_OPTIONS },
      { key: 'line_type', label: 'Dòng', type: 'select', required: true, options: [{ value: 'tax', label: 'Tiền thuế' }, { value: 'base', label: 'Giá tính thuế' }] },
      { key: 'factor_percent', label: 'Tỷ lệ %', type: 'number', required: true }, { key: 'account_code', label: 'Tài khoản', type: 'text' }, { key: 'report_tag', label: 'Nhãn báo cáo', type: 'text' }] },
  { name: 'invoice_group', table: 'invoice_group', label: 'Nhóm hóa đơn', uniqueBy: ['scope', 'code'], sort: 'code', searchIn: ['code', 'name'],
    schema: z.object({ scope: z.enum(['purchase', 'sale']), code, name: text(false), rate: pct.nullable().optional(), is_active: z.boolean().optional() }),
    columns: [{ key: 'scope', label: 'Mua/Bán', type: 'select', required: true, options: [{ value: 'purchase', label: 'Mua vào' }, { value: 'sale', label: 'Bán ra' }] },
      { key: 'code', label: 'Mã', type: 'text', required: true }, { key: 'name', label: 'Tên nhóm', type: 'text', required: true }, { key: 'rate', label: 'Thuế suất %', type: 'number' }] },
  { name: 'voucher_dup_rule', table: 'voucher_dup_rule', label: 'Quy tắc khử trùng chứng từ', uniqueBy: ['type_a', 'type_b'], sort: 'type_a', searchIn: ['type_a', 'type_b'],
    schema: z.object({ type_a: code, type_b: code, days_window: z.union([z.number(), z.string().trim().regex(/^\d+$/, 'Nhập số nguyên').transform(Number)]).pipe(z.number().int().min(0).max(31)).optional(), match_party: z.boolean().optional(), match_counter_account: z.boolean().optional(), is_active: z.boolean().optional() }),
    columns: [{ key: 'type_a', label: 'Loại chứng từ A', type: 'text', required: true }, { key: 'type_b', label: 'Loại chứng từ B', type: 'text', required: true },
      { key: 'days_window', label: 'Cách tối đa (ngày)', type: 'number', required: true }, { key: 'match_party', label: 'Cùng đối tượng', type: 'boolean' }, { key: 'match_counter_account', label: 'Cùng TK đối ứng', type: 'boolean' }] },
  { name: 'cost_item', table: 'cost_item', label: 'Khoản mục chi phí', uniqueBy: ['code'], sort: 'code', searchIn: ['code', 'name'],
    schema: z.object({ code, name: text(false), parent_code: text(), default_account_code: text(), cost_element: z.enum(['material', 'labor', 'overhead']).nullable().optional(), is_active: z.boolean().optional() }),
    columns: [{ key: 'code', label: 'Mã', type: 'text', required: true }, { key: 'name', label: 'Tên khoản mục', type: 'text', required: true },
      { key: 'parent_code', label: 'Thuộc khoản mục', type: 'text', lookup: { catalog: 'cost_item' } }, { key: 'default_account_code', label: 'TK chi phí ngầm định', type: 'text' },
      // yếu tố giá thành: tập hợp chi phí ghi thẳng TK 154 (TT133 không có 621/622/627) xếp theo khoản mục của dòng
      { key: 'cost_element', label: 'Yếu tố giá thành', type: 'select', options: [{ value: 'material', label: 'Nguyên vật liệu trực tiếp' }, { value: 'labor', label: 'Nhân công trực tiếp' }, { value: 'overhead', label: 'Sản xuất chung' }] }] },
  { name: 'project', table: 'project', label: 'Vụ việc / công trình', uniqueBy: ['code'], sort: 'code', searchIn: ['code', 'name'],
    schema: z.object({ code, name: text(false), parent_code: text(), party_code: text(), date_from: dateIso.nullable().optional(), date_to: dateIso.nullable().optional(), budget: vnd.nullable().optional(), is_active: z.boolean().optional() }),
    columns: [{ key: 'code', label: 'Mã', type: 'text', required: true }, { key: 'name', label: 'Tên vụ việc', type: 'text', required: true },
      { key: 'parent_code', label: 'Thuộc vụ việc', type: 'text', lookup: { catalog: 'project' } }, { key: 'party_code', label: 'Khách hàng / chủ đầu tư', type: 'text', lookup: { catalog: 'party' } },
      { key: 'date_from', label: 'Từ ngày', type: 'date' }, { key: 'date_to', label: 'Đến ngày', type: 'date' }, { key: 'budget', label: 'Giá trị dự toán', type: 'number' }] },
  { name: 'uom', table: 'uom', label: 'Đơn vị tính', uniqueBy: ['code'], sort: 'code', searchIn: ['code', 'name'],
    schema: z.object({ code, name: text(false), is_active: z.boolean().optional() }),
    columns: [{ key: 'code', label: 'Mã', type: 'text', required: true }, { key: 'name', label: 'Tên', type: 'text', required: true }] },
  { name: 'item_group', table: 'item_group', label: 'Nhóm vật tư hàng hóa', perm: 'item', uniqueBy: ['code'], sort: 'code', searchIn: ['code', 'name'],
    schema: z.object({ code, name: text(false), parent_code: text(), is_active: z.boolean().optional() }),
    columns: [{ key: 'code', label: 'Mã', type: 'text', required: true }, { key: 'name', label: 'Tên nhóm', type: 'text', required: true },
      { key: 'parent_code', label: 'Thuộc nhóm', type: 'text', lookup: { catalog: 'item_group' } }] },
  { name: 'item', table: 'item', label: 'Vật tư hàng hóa', perm: 'item', uniqueBy: ['code'], sort: 'code', searchIn: ['code', 'name', 'barcode'],
    schema: z.object({ code, name: text(false), name_en: text(), item_group_code: text(), kind: z.enum(['goods', 'material', 'finished', 'service', 'tool']).optional(), base_uom_code: code,
      tracking: z.enum(['none', 'lot', 'lot_expiry']).optional(), shelf_life_days: intOpt(36500), default_tax_code: text(), min_qty: qty, max_qty: qty, location: text(), barcode: text(), spec_code: text(),
      inventory_account_code: text(), revenue_account_code: text(), cogs_account_code: text(), uom_conversions: text(), is_active: z.boolean().optional() }),
    columns: [{ key: 'code', label: 'Mã', type: 'text', required: true }, { key: 'name', label: 'Tên vật tư hàng hóa', type: 'text', required: true }, { key: 'name_en', label: 'Tên tiếng Anh', type: 'text' },
      { key: 'item_group_code', label: 'Nhóm', type: 'text', lookup: { catalog: 'item_group' }, idKey: 'group_id' },
      { key: 'kind', label: 'Tính chất', type: 'select', options: [{ value: 'goods', label: 'Hàng hóa' }, { value: 'material', label: 'Nguyên vật liệu' }, { value: 'finished', label: 'Thành phẩm' }, { value: 'service', label: 'Dịch vụ (không tồn kho)' }, { value: 'tool', label: 'Công cụ dụng cụ' }] },
      { key: 'base_uom_code', label: 'ĐVT cơ sở', type: 'text', required: true, lookup: { catalog: 'uom' } },
      { key: 'tracking', label: 'Theo dõi lô, hạn dùng', type: 'select', options: [{ value: 'none', label: 'Không' }, { value: 'lot', label: 'Theo lô' }, { value: 'lot_expiry', label: 'Theo lô và hạn dùng' }] },
      { key: 'shelf_life_days', label: 'Hạn dùng (ngày)', type: 'number' }, { key: 'default_tax_code', label: 'Thuế GTGT ngầm định', type: 'text' },
      { key: 'min_qty', label: 'Tồn tối thiểu', type: 'number' }, { key: 'max_qty', label: 'Tồn tối đa', type: 'number' }, { key: 'location', label: 'Vị trí', type: 'text' }, { key: 'barcode', label: 'Mã vạch', type: 'text' }, { key: 'spec_code', label: 'Quy cách', type: 'text' },
      { key: 'inventory_account_code', label: 'TK kho', type: 'text', account: true }, { key: 'revenue_account_code', label: 'TK doanh thu', type: 'text', account: true }, { key: 'cogs_account_code', label: 'TK giá vốn', type: 'text', account: true },
      { key: 'uom_conversions', label: 'ĐVT quy đổi (THUNG=24;HOP=6)', type: 'text', importOnly: true }] },
  { name: 'item_uom', table: 'item_uom', label: 'ĐVT quy đổi', perm: 'item', uniqueBy: ['item_code', 'uom_code'], sort: 'item_id', searchIn: ['factor'],
    schema: z.object({ item_code: code, uom_code: code, factor: uomFactor, is_purchase: z.boolean().optional(), is_sale: z.boolean().optional() }),
    columns: [{ key: 'item_code', label: 'Vật tư hàng hóa', type: 'text', required: true, lookup: { catalog: 'item' } }, { key: 'uom_code', label: 'ĐVT', type: 'text', required: true, lookup: { catalog: 'uom' } },
      { key: 'factor', label: 'Hệ số quy đổi ra ĐVT cơ sở', type: 'number', required: true }, { key: 'is_purchase', label: 'Dùng khi mua', type: 'boolean' }, { key: 'is_sale', label: 'Dùng khi bán', type: 'boolean' }] },
  { name: 'warehouse', table: 'warehouse', label: 'Kho', perm: 'warehouse', uniqueBy: ['code'], sort: 'code', searchIn: ['code', 'name'],
    schema: z.object({ code, name: text(false), inventory_account_code: text(), costing_method: z.enum(['avg_period', 'avg_moving', 'fifo', 'specific']).nullable().optional(),
      kind: z.enum(['normal', 'consignment_out', 'consignment_in']).optional(), branch_code: text(), is_active: z.boolean().optional() }),
    columns: [{ key: 'code', label: 'Mã', type: 'text', required: true }, { key: 'name', label: 'Tên kho', type: 'text', required: true },
      { key: 'kind', label: 'Loại kho', type: 'select', options: [{ value: 'normal', label: 'Kho thường' }, { value: 'consignment_out', label: 'Kho gửi bán (TK 157)' }, { value: 'consignment_in', label: 'Kho nhận bán hộ' }] },
      { key: 'inventory_account_code', label: 'TK kho', type: 'text', account: true },
      { key: 'costing_method', label: 'Phương pháp tính giá xuất', type: 'select', options: [{ value: 'avg_period', label: 'Bình quân cuối kỳ' }, { value: 'avg_moving', label: 'Bình quân tức thời' }, { value: 'fifo', label: 'Nhập trước xuất trước' }, { value: 'specific', label: 'Đích danh' }] },
      { key: 'branch_code', label: 'Chi nhánh', type: 'text', lookup: { catalog: 'department' }, idKey: 'branch_id' }] },
];
// Mọi schema đều strict: khóa lạ trong thân yêu cầu bị từ chối (400 VALIDATION) thay vì bị bỏ qua.
export const CATALOGS: CatalogDef[] = defs.map((d) => ({ ...d, schema: d.schema.strict() }));
export const catalogByName = (name: string): CatalogDef | undefined => CATALOGS.find((c) => c.name === name);
