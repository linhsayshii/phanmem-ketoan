import { z } from 'zod';
import type { Database } from '@kt/db';

export interface ColumnDef { key: string; label: string; type: 'text' | 'number' | 'boolean' | 'date' | 'select'; required?: boolean; options?: { value: string; label: string }[]; lookup?: { catalog: string }; width?: number }
export interface CatalogDef { name: string; table: keyof Database; label: string; schema: z.ZodObject<z.ZodRawShape>; columns: ColumnDef[]; uniqueBy: string[]; sort: string; searchIn: string[] }

// Số tiền VND: số nguyên không dấu (cột numeric(20,0)).
const vnd = z.string().regex(/^\d+$/);
// Tỷ giá numeric(20,10): tối đa 10 chữ số nguyên và 10 chữ số thập phân, phải > 0.
const exRate = z.string().regex(/^\d{1,10}(\.\d{1,10})?$/).refine((v) => Number(v) > 0);
// Thuế suất % numeric(5,2): không quá 100.
const pct = z.string().regex(/^\d{1,3}(\.\d{1,2})?$/).refine((v) => Number(v) <= 100);
// Ngày ISO hợp lệ: loại 2026-02-30 bằng cách dựng lại ngày UTC rồi so chuỗi.
export const dateIso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => {
  const [y, m, d] = s.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d));
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === s;
});
// Mã tiền tệ khớp assertId của currency (/^[A-Z]{3}$/), nếu không dòng tạo ra sẽ không GET/PUT/DELETE được.
const ccy = z.string().regex(/^[A-Z]{3}$/, 'Mã tiền tệ gồm 3 chữ in hoa');
const code = z.string().min(1).max(30);
const text = (o = true) => (o ? z.string().nullable().optional() : z.string().min(1));

const defs: CatalogDef[] = [
  { name: 'party_group', table: 'party_group', label: 'Nhóm đối tượng', uniqueBy: ['code'], sort: 'code', searchIn: ['code', 'name'],
    schema: z.object({ code, name: text(false), is_active: z.boolean().optional() }),
    columns: [{ key: 'code', label: 'Mã', type: 'text', required: true }, { key: 'name', label: 'Tên nhóm', type: 'text', required: true }] },
  { name: 'party', table: 'party', label: 'Đối tượng', uniqueBy: ['code'], sort: 'code', searchIn: ['code', 'name', 'tax_code'],
    schema: z.object({ code, name: text(false), is_customer: z.boolean().optional(), is_vendor: z.boolean().optional(), is_employee: z.boolean().optional(),
      group_code: text(), tax_code: z.string().regex(/^\d{10}(-\d{3})?$/).nullable().optional(), id_number: text(), id_issue_date: dateIso.nullable().optional(), id_issue_place: text(),
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
    schema: z.object({ code, name: text(false), short_name: text(), is_active: z.boolean().optional() }),
    columns: [{ key: 'code', label: 'Mã', type: 'text', required: true }, { key: 'name', label: 'Tên ngân hàng', type: 'text', required: true }, { key: 'short_name', label: 'Tên viết tắt', type: 'text' }] },
  { name: 'bank_account', table: 'bank_account', label: 'Tài khoản ngân hàng công ty', uniqueBy: ['account_no'], sort: 'account_no', searchIn: ['account_no', 'account_name'],
    schema: z.object({ bank_code: code, account_no: text(false), account_name: text(), branch: text(), currency_code: ccy.optional(), gl_account_code: text(false), is_active: z.boolean().optional() }),
    columns: [{ key: 'bank_code', label: 'Ngân hàng', type: 'text', required: true, lookup: { catalog: 'bank' } }, { key: 'account_no', label: 'Số tài khoản', type: 'text', required: true },
      { key: 'account_name', label: 'Tên tài khoản', type: 'text' }, { key: 'branch', label: 'Chi nhánh', type: 'text' }, { key: 'currency_code', label: 'Loại tiền', type: 'text', lookup: { catalog: 'currency' } },
      { key: 'gl_account_code', label: 'Tài khoản kế toán (112x)', type: 'text', required: true }] },
  { name: 'payment_method', table: 'payment_method', label: 'Hình thức thanh toán', uniqueBy: ['code'], sort: 'code', searchIn: ['code', 'name'],
    schema: z.object({ code, name: text(false), is_active: z.boolean().optional() }),
    columns: [{ key: 'code', label: 'Mã', type: 'text', required: true }, { key: 'name', label: 'Tên', type: 'text', required: true }] },
  { name: 'tax_code', table: 'tax_code', label: 'Loại thuế', uniqueBy: ['code'], sort: 'code', searchIn: ['code', 'name'],
    schema: z.object({ code, name: text(false), kind: z.enum(['vat', 'import', 'excise']), rate: pct.nullable().optional(), is_exempt: z.boolean().optional(), in_declaration: z.boolean().optional(), is_active: z.boolean().optional() }),
    columns: [{ key: 'code', label: 'Mã', type: 'text', required: true }, { key: 'name', label: 'Tên', type: 'text', required: true },
      { key: 'kind', label: 'Loại', type: 'select', required: true, options: [{ value: 'vat', label: 'GTGT' }, { value: 'import', label: 'Nhập khẩu' }, { value: 'excise', label: 'TTĐB' }] },
      { key: 'rate', label: 'Thuế suất %', type: 'number' }, { key: 'is_exempt', label: 'Không chịu thuế', type: 'boolean' }, { key: 'in_declaration', label: 'Lên tờ khai', type: 'boolean' }] },
  { name: 'invoice_group', table: 'invoice_group', label: 'Nhóm hóa đơn', uniqueBy: ['scope', 'code'], sort: 'code', searchIn: ['code', 'name'],
    schema: z.object({ scope: z.enum(['purchase', 'sale']), code, name: text(false), rate: pct.nullable().optional(), is_active: z.boolean().optional() }),
    columns: [{ key: 'scope', label: 'Mua/Bán', type: 'select', required: true, options: [{ value: 'purchase', label: 'Mua vào' }, { value: 'sale', label: 'Bán ra' }] },
      { key: 'code', label: 'Mã', type: 'text', required: true }, { key: 'name', label: 'Tên nhóm', type: 'text', required: true }, { key: 'rate', label: 'Thuế suất %', type: 'number' }] },
  { name: 'cost_item', table: 'cost_item', label: 'Khoản mục chi phí', uniqueBy: ['code'], sort: 'code', searchIn: ['code', 'name'],
    schema: z.object({ code, name: text(false), parent_code: text(), default_account_code: text(), is_active: z.boolean().optional() }),
    columns: [{ key: 'code', label: 'Mã', type: 'text', required: true }, { key: 'name', label: 'Tên khoản mục', type: 'text', required: true },
      { key: 'parent_code', label: 'Thuộc khoản mục', type: 'text', lookup: { catalog: 'cost_item' } }, { key: 'default_account_code', label: 'TK chi phí ngầm định', type: 'text' }] },
  { name: 'project', table: 'project', label: 'Vụ việc / công trình', uniqueBy: ['code'], sort: 'code', searchIn: ['code', 'name'],
    schema: z.object({ code, name: text(false), parent_code: text(), party_code: text(), date_from: dateIso.nullable().optional(), date_to: dateIso.nullable().optional(), budget: vnd.nullable().optional(), is_active: z.boolean().optional() }),
    columns: [{ key: 'code', label: 'Mã', type: 'text', required: true }, { key: 'name', label: 'Tên vụ việc', type: 'text', required: true },
      { key: 'parent_code', label: 'Thuộc vụ việc', type: 'text', lookup: { catalog: 'project' } }, { key: 'party_code', label: 'Khách hàng / chủ đầu tư', type: 'text', lookup: { catalog: 'party' } },
      { key: 'date_from', label: 'Từ ngày', type: 'date' }, { key: 'date_to', label: 'Đến ngày', type: 'date' }, { key: 'budget', label: 'Giá trị dự toán', type: 'number' }] },
  { name: 'uom', table: 'uom', label: 'Đơn vị tính', uniqueBy: ['code'], sort: 'code', searchIn: ['code', 'name'],
    schema: z.object({ code, name: text(false), is_active: z.boolean().optional() }),
    columns: [{ key: 'code', label: 'Mã', type: 'text', required: true }, { key: 'name', label: 'Tên', type: 'text', required: true }] },
];
// Mọi schema đều strict: khóa lạ trong thân yêu cầu bị từ chối (400 VALIDATION) thay vì bị bỏ qua.
export const CATALOGS: CatalogDef[] = defs.map((d) => ({ ...d, schema: d.schema.strict() }));
export const catalogByName = (name: string): CatalogDef | undefined => CATALOGS.find((c) => c.name === name);
