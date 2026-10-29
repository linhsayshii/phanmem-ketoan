import type { ColumnType, Generated } from 'kysely';

// Kysely's JSONColumnType yêu cầu T extends object | null; cột jsonb ở đây có thể chứa số/chuỗi (unknown), nên khai báo lại cùng dạng.
type JSONColumnType<T> = ColumnType<T, string, string>;

export type Numeric = ColumnType<string, string | number, string | number>;
type NumericDefault = ColumnType<string, string | number | undefined, string | number>; // Numeric có DEFAULT trong SQL
export type Timestamp = ColumnType<string, string | Date | undefined, string | Date>;
export type DateOnly = ColumnType<string, string, string>;

export interface TenantTable {
  id: Generated<string>;
  code: string;
  name: string;
  tax_code: string | null;
  address: string | null;
  legal_rep: string | null;
  chief_accountant: string | null;
  phone: string | null;
  email: string | null;
  created_at: Generated<string>;
}
export interface AppUserTable {
  id: Generated<string>;
  username: string;
  full_name: string;
  password_hash: string;
  is_active: Generated<boolean>;
  created_at: Generated<string>;
}
export interface PermissionTable { code: string; name: string; group_name: string }
export interface RoleTable { id: Generated<string>; tenant_id: string; code: string; name: string; is_system: Generated<boolean> }
export interface RolePermissionTable { tenant_id: string; role_id: string; permission_code: string }
export interface TenantUserTable {
  tenant_id: string; user_id: string; role_id: string;
  sensitive_flags: JSONColumnType<string[]>; is_active: Generated<boolean>;
}
export interface UserSessionTable { id: Generated<string>; user_id: string;  token_hash: string; tenant_id: string | null; expires_at: Timestamp; created_at: Generated<string>; ip: string | null }
export interface LoginEventTable { id: Generated<number>; ts: Generated<string>; username: string; user_id: string | null; success: boolean; ip: string | null }
export interface AuditEventTable {
  id: Generated<number>; tenant_id: string; ts: Generated<string>; user_id: string | null;
  action: string; entity: string; entity_id: string; before: JSONColumnType<unknown> | null; after: JSONColumnType<unknown> | null; ip: string | null;
}
export interface LegalParamTable { id: Generated<number>; code: string; value: JSONColumnType<unknown>; valid_from: DateOnly; valid_to: DateOnly | null; source: string }
export interface FiscalPeriodTable {
  id: Generated<number>; tenant_id: string; fiscal_year: number; period_no: number;
  date_from: DateOnly; date_to: DateOnly; regime: string; status: Generated<string>; locked_modules: Generated<string[]>;
  hash_tail: Buffer | null; locked_by: string | null; locked_at: Timestamp | null;
}
export interface AccountTable {
  id: Generated<number>; tenant_id: string; regime: string; code: string; name: string; name_en: string | null;
  parent_id: number | null; is_group: Generated<boolean>; root_type: string; normal_balance: string;
  track_currency: Generated<boolean>; subledger_kind: string | null; reconcile: Generated<boolean>; is_active: Generated<boolean>;
  translation_status: Generated<string | null>;
}
export interface CoaTemplateTable {
  regime: string; code: string; name: string; name_en: string | null; parent_code: string | null; is_group: boolean;
  root_type: string; normal_balance: string; track_currency: boolean; subledger_kind: string | null; source: string;
}
export interface TenantSettingTable { tenant_id: string; key: string; value: JSONColumnType<unknown>; updated_at: Generated<string> }
export interface UserPrefTable { user_id: string; tenant_id: string; key: string; value: JSONColumnType<unknown> }

export interface PartyGroupTable { id: Generated<string>; tenant_id: string; code: string; name: string; is_active: Generated<boolean> }
export interface PartyTable {
  id: Generated<string>; tenant_id: string; code: string; name: string;
  is_customer: Generated<boolean>; is_vendor: Generated<boolean>; is_employee: Generated<boolean>;
  group_id: string | null; tax_code: string | null; id_number: string | null; id_issue_date: DateOnly | null; id_issue_place: string | null;
  address: string | null; invoice_address: string | null; contact_name: string | null; phone: string | null; email: string | null;
  payment_term_days: number | null; credit_limit: Numeric | null; default_account_code: string | null; note: string | null;
  is_active: Generated<boolean>; created_at: Generated<string>;
}
export interface PartyBankAccountTable {
  id: Generated<string>; tenant_id: string; party_id: string; bank_name: string; account_no: string; account_name: string | null; branch: string | null;
}
export interface DepartmentTable {
  id: Generated<number>; tenant_id: string; code: string; name: string; parent_id: number | null; is_branch: Generated<boolean>; is_active: Generated<boolean>;
}
export interface EmployeeTable {
  id: Generated<number>; tenant_id: string; code: string; name: string; department_id: number | null; party_id: string | null;
  tax_code: string | null; id_number: string | null; position: string | null; phone: string | null; email: string | null; is_active: Generated<boolean>;
}
export interface CurrencyTable {
  tenant_id: string; code: string; name: string; symbol: string | null; minor_unit: Generated<number>; is_active: Generated<boolean>;
}
export interface ExchangeRateTable {
  id: Generated<number>; tenant_id: string; currency_code: string; rate_date: DateOnly; rate_type: string; rate: Numeric;
}
export interface BankTable { id: Generated<number>; tenant_id: string; code: string; name: string; short_name: string | null; napas_bin: string | null; is_active: Generated<boolean> }
export interface BankAccountTable {
  id: Generated<number>; tenant_id: string; bank_id: number; account_no: string; account_name: string | null; branch: string | null;
  currency_code: Generated<string>; gl_account_code: string; is_active: Generated<boolean>;
}
export interface PaymentMethodTable { id: Generated<number>; tenant_id: string; code: string; name: string; is_active: Generated<boolean> }
export interface TaxCodeTable {
  id: Generated<number>; tenant_id: string; code: string; name: string; kind: string; rate: Numeric | null;
  is_exempt: Generated<boolean>; in_declaration: Generated<boolean>; is_active: Generated<boolean>;
  scope: Generated<string>; method: Generated<string>; price_include: Generated<boolean>;
}
export interface TaxDistributionTable {
  id: Generated<number>; tenant_id: string; tax_code_id: number; document_type: string; scope: string; line_type: string;
  factor_percent: Numeric; account_code: string | null; report_tag: string | null;
}
export interface VoucherDupRuleTable {
  id: Generated<number>; tenant_id: string; type_a: string; type_b: string; days_window: Generated<number>; match_party: Generated<boolean>; match_counter_account: Generated<boolean>; is_active: Generated<boolean>;
}
export interface VoucherDupIgnoreTable { tenant_id: string; voucher_a: string; voucher_b: string; created_by: string; created_at: Generated<Date> }
export interface InvoiceGroupTable {
  id: Generated<number>; tenant_id: string; scope: string; code: string; name: string; rate: Numeric | null; is_active: Generated<boolean>;
}
export interface CostItemTable {
  id: Generated<number>; tenant_id: string; code: string; name: string; parent_id: number | null; default_account_code: string | null; is_active: Generated<boolean>;
  cost_element: 'material' | 'labor' | 'overhead' | null; // 0103
}
export interface ProjectTable {
  id: Generated<number>; tenant_id: string; code: string; name: string; parent_id: number | null; party_id: string | null;
  date_from: DateOnly | null; date_to: DateOnly | null; budget: Numeric | null; is_active: Generated<boolean>;
}
export interface ItemGroupTable { id: Generated<number>; tenant_id: string; code: string; name: string; parent_id: number | null; is_active: Generated<boolean>; created_at: Generated<Date> }
export interface ItemTable {
  id: Generated<number>; tenant_id: string; code: string; name: string; name_en: string | null; group_id: number | null; kind: Generated<string>; base_uom_id: number;
  tracking: Generated<string>; shelf_life_days: number | null; default_tax_code: string | null; min_qty: Numeric | null; max_qty: Numeric | null;
  location: string | null; barcode: string | null; spec_code: string | null; inventory_account_id: number | null; revenue_account_id: number | null; cogs_account_id: number | null;
  is_active: Generated<boolean>; created_at: Generated<Date>;
}
export interface ItemUomTable { id: Generated<number>; tenant_id: string; item_id: number; uom_id: number; factor: Numeric; is_purchase: Generated<boolean>; is_sale: Generated<boolean>; created_at: Generated<Date> }
export interface WarehouseTable {
  id: Generated<number>; tenant_id: string; code: string; name: string; inventory_account_id: number | null; costing_method: string | null; kind: Generated<string>;
  branch_id: number | null; is_active: Generated<boolean>; created_at: Generated<Date>;
}
// Sổ kho (GĐ3): move bất biến sau ghi sổ; lớp giá (remaining có thể âm với kind 'deficit'); lần chạy giá vốn và giá gán.
export interface StockMoveTable {
  id: Generated<number>; tenant_id: string; voucher_id: string; item_line_id: number; item_id: number; warehouse_id: number; posting_date: DateOnly; seq: Generated<number>;
  direction: string; quantity: Numeric; lot_no: string | null; expiry_date: DateOnly | null; transfer_id: string | null; reversal_of: number | null;
}
export interface StockCostLayerTable {
  id: Generated<number>; tenant_id: string; move_id: number; item_id: number; warehouse_id: number; lot_no: string | null; kind: string; posting_date: DateOnly;
  qty: Numeric; unit_cost: Numeric; value: Numeric; remaining_qty: Numeric; remaining_value: Numeric; voucher_id: Generated<string | null>; landed: Generated<boolean>;
  cost_run_id: Generated<number | null>; // lớp giá nhập thành phẩm do chạy giá thành sinh (0106)
}
// Chi phí mua hàng (CPM) phân bổ cho dòng nhập (dòng PNK, dòng MH nhập kho cùng hóa đơn).
export interface LandedCostAllocTable { id: Generated<number>; tenant_id: string; voucher_id: string; receipt_line_id: number | null; receipt_voucher_id: string; receipt_line_no: number; amount: Numeric; basis: string }
export interface CostingRunTable {
  id: Generated<string>; tenant_id: string; period_from: DateOnly; period_to: DateOnly; method: string; warehouse_id: number | null; item_id: number | null; status: string;
  voucher_ids: ColumnType<string[], string[] | undefined, string[]>; created_by: string | null; created_at: Generated<string>; summary: ColumnType<unknown, string | null | undefined, string | null>;
}
export interface StockCostAssignmentTable {
  id: Generated<number>; tenant_id: string; run_id: string; move_id: number; unit_cost: Numeric; amount: Numeric; lot_no: string | null; is_current: Generated<boolean>; voucher_id: ColumnType<string | null, string | null | undefined, string | null>;
}
export interface StockCostStateTable { tenant_id: string; item_id: number; warehouse_id: number; stale_from: DateOnly }
export interface UomTable { id: Generated<number>; tenant_id: string; code: string; name: string; is_active: Generated<boolean> }

export interface VoucherTypeTable {
  id: Generated<number>; tenant_id: string; code: string; name: string; module: Generated<string>;
  prefix: Generated<string>; suffix: Generated<string>; pad_length: Generated<number>; is_system: Generated<boolean>; is_active: Generated<boolean>;
}
export interface VoucherTable {
  id: Generated<string>; tenant_id: string; voucher_type: string; voucher_no: string | null; seq_no: number | null;
  posting_date: DateOnly; document_date: DateOnly; fiscal_year: Generated<number>; period_no: Generated<number>;
  state: Generated<string>; description: string | null; party_id: string | null; currency_code: Generated<string>; fx_rate: Numeric | null;
  source_doc_type: string | null; source_doc_id: string | null; reversal_of_id: string | null; reversed_by_id: string | null;
  is_closing: Generated<boolean>; idempotency_key: string | null; ext_fingerprint: string | null; created_by: string; created_at: Generated<string>;
  posted_by: string | null; posted_at: Timestamp | null; version: Generated<number>; prev_hash: Buffer | null; row_hash: Buffer | null;
  person_name: string | null; person_address: string | null; attachments_count: number | null;
  bank_account_id: number | null; counter_bank_account_id: number | null; party_bank_account_id: string | null; due_date: DateOnly | null; purpose: string | null;
  day_order: Generated<number>; stock_kind: string | null; receipt_state: string | null;
}
// Đối tượng tập hợp chi phí (0097): đúng một tham chiếu theo loại.
export interface CostObjectTable {
  id: Generated<number>; tenant_id: string; code: string; name: string; kind: 'product' | 'project' | 'order' | 'contract';
  item_id: number | null; project_id: number | null; order_id: string | null; contract_id: number | null; method: string | null; unit: string | null; is_active: Generated<boolean>;
}
// 0103: định mức NVL theo sản phẩm (item_id) hoặc đối tượng tập hợp chi phí.
export interface CostNormTable {
  id: Generated<number>; tenant_id: string; item_id: number | null; cost_object_id: number | null; valid_from: DateOnly; valid_to: DateOnly | null; note: string | null;
  created_at: Generated<string>; updated_at: Generated<string>;
}
export interface CostNormLineTable { id: Generated<number>; tenant_id: string; norm_id: number; line_no: number; item_id: number; quantity: Numeric; loss_percent: NumericDefault; note: string | null }
export interface CostRunTable {
  id: Generated<number>; tenant_id: string; year: number; month: number; status: string; regime: string; params: ColumnType<unknown, string, string>; input_hash: string;
  voucher_id: string | null; warnings: ColumnType<unknown, string | undefined, string>; run_by: Generated<string | null>; run_at: Timestamp;
}
// 0108: phân bổ chi phí chung vào vụ việc (alloc, PB) và kết chuyển giá vốn vụ việc 154 → 632 (cogs, GT).
export interface ProjectAllocRunTable {
  id: Generated<number>; tenant_id: string; kind: string; year: number; month: number; status: string; regime: string; params: ColumnType<unknown, string, string>; input_hash: string;
  result: ColumnType<unknown, string | undefined, string>; voucher_id: string | null; warnings: ColumnType<unknown, string | undefined, string>; run_by: Generated<string | null>; run_at: Timestamp;
}
export interface CostRunObjectTable {
  id: Generated<number>; tenant_id: string; run_id: number; cost_object_id: number; method: string; wip_method: string;
  completion_material: Numeric | null; completion_labor: Numeric | null; completion_overhead: Numeric | null; completed: boolean | null;
  overhead_basis: NumericDefault; allocated_overhead: NumericDefault;
  opening_material: Numeric; opening_labor: Numeric; opening_overhead: Numeric; incurred_material: Numeric; incurred_labor: Numeric; incurred_overhead: Numeric;
  closing_material: Numeric; closing_labor: Numeric; closing_overhead: Numeric; cost_material: Numeric; cost_labor: Numeric; cost_overhead: Numeric; total_cost: Numeric;
  completed_qty: NumericDefault; wip_qty: NumericDefault; unit_cost: Numeric | null;
}
export interface CostRunOutputTable {
  id: Generated<number>; tenant_id: string; run_id: number; run_object_id: number; line_no: number; item_id: number | null; qty: Numeric; wip_qty: NumericDefault; coefficient: Numeric | null;
  standard_material: Numeric | null; standard_labor: Numeric | null; standard_overhead: Numeric | null;
  cost_material: Numeric; cost_labor: Numeric; cost_overhead: Numeric; total: Numeric; unit_cost: Numeric;
}
export interface ContractTable { id: Generated<number>; tenant_id: string; code: string; name: string; party_id: string | null; kind: string }
export interface AssetCategoryTable {
  id: Generated<number>; tenant_id: string; code: string; name: string; kind: string; asset_account_code: string; depreciation_account_code: string | null;
  default_life_units: number | null; is_active: Generated<boolean>;
}
export interface AssetTable {
  id: Generated<number>; tenant_id: string; code: string; name: string; kind: string; category_id: number | null; asset_account_code: string; depreciation_account_code: string | null;
  department_id: number | null; use_date: DateOnly | null; depreciation_start_date: DateOnly | null; life_units: number | null; is_depreciable: Generated<boolean>;
  capital_source: string | null; card_no: string | null; country: string | null; year_made: number | null; spec: string | null; quantity: NumericDefault; uom: string | null;
  status: Generated<string>; decrease_date: DateOnly | null; opening_year: number | null; opening_cost: Numeric | null; opening_accumulated: Numeric | null; opening_remaining_units: Numeric | null;
  note: string | null; created_at: Generated<string>;
}
export interface AssetAllocationTable {
  id: Generated<number>; tenant_id: string; asset_id: number; valid_from_year: number; valid_from_period: number; expense_account_code: string;
  department_id: number | null; project_id: number | null; cost_item_id: number | null; ratio: Numeric;
}
export interface PeriodRunTable {
  id: Generated<string>; tenant_id: string; kind: string; fiscal_year: number; period_no: number; voucher_id: string | null; status: Generated<string>;
  result: ColumnType<unknown, string | undefined, string>; created_by: string | null; created_at: Generated<string>; checked_at: Timestamp | null;
}
export interface AssetScheduleTable {
  id: Generated<number>; tenant_id: string; asset_id: number; version: number; eff_year: number; eff_period: number;
  basis_cost: Numeric; basis_acc: Numeric; units: Numeric; reason: string; superseded_at: Timestamp | null; created_at: Generated<string>;
}
export interface AssetEventTable {
  id: Generated<string>; tenant_id: string; asset_id: number; kind: string; event_date: DateOnly; voucher_id: string | null;
  data: ColumnType<Record<string, unknown>, string, string>; state: Generated<string>; created_by: string | null; created_at: Generated<string>;
}
export interface AssetCountTable {
  id: Generated<number>; tenant_id: string; kind: string; count_date: DateOnly; department_id: number | null; members: ColumnType<unknown, string, string>; note: string | null;
  status: Generated<string>; created_by: string | null; created_at: Generated<string>;
}
export interface AssetCountLineTable {
  id: Generated<number>; tenant_id: string; count_id: number; asset_id: number; book_quantity: Numeric; actual_quantity: Numeric | null; book_cost: Numeric; book_nbv: Numeric; condition: string | null; note: string | null;
}
export interface AssetScheduleLineTable {
  id: Generated<number>; tenant_id: string; schedule_id: number; fiscal_year: number; period_no: number; units: Numeric; amount: Numeric; accumulated: Numeric; run_id: string | null;
}
export interface VoucherLineTable {
  id: Generated<number>; tenant_id: string; voucher_id: string; line_no: number; account_id: number; posting_date: DateOnly;
  currency_code: Generated<string>; fx_rate: Numeric | null; amount_currency: NumericDefault;
  debit: NumericDefault; credit: NumericDefault; balance: Generated<string>;
  party_id: string | null; item_id: number | null; warehouse_id: number | null; department_id: number | null; project_id: number | null;
  cost_item_id: number | null; contract_id: number | null; employee_id: number | null; asset_id: number | null; cost_object_id: number | null; // 0097
  // jsonb NOT NULL DEFAULT '{}': Generated<JSONColumnType<...>> không bung được kiểu lồng nên khai báo thẳng ColumnType.
  extra_dims: ColumnType<Record<string, unknown>, string | undefined, string>; description: string | null; due_date: DateOnly | null; bank_account_id: number | null;
  cash_flow_code: string | null; // mã chỉ tiêu B03 (dòng tiền), 0066
}
export interface VoucherCounterTable { tenant_id: string; voucher_type: string; fiscal_year: number; branch_key: Generated<number>; last_no: Generated<number> }
export interface VoucherNumberingSettingTable { tenant_id: string; per_branch: Generated<boolean>; hq_code: Generated<string>; updated_at: Generated<string> }
export interface VoucherLineHistoryTable {
  id: Generated<number>; tenant_id: string; voucher_id: string; version: number;
  header: JSONColumnType<unknown>; lines: JSONColumnType<unknown>; archived_at: Generated<string>; archived_by: string | null;
}
export interface VoucherAttachmentTable {
  id: Generated<string>; tenant_id: string; voucher_id: string; file_name: string; mime: string; bytes: number; storage_key: string;
  uploaded_by: string; uploaded_at: Generated<string>;
}
export interface VoucherPairTable {
  id: Generated<number>; tenant_id: string; voucher_id: string; posting_date: DateOnly; debit_account_id: number; credit_account_id: number;
  debit_party_id: string | null; credit_party_id: string | null; amount: Numeric; is_closing: Generated<boolean>;
  debit_line_id: number | null; credit_line_id: number | null;
}
export interface OpeningBalanceTable {
  id: Generated<number>; tenant_id: string; fiscal_year: number; account_id: number; party_id: string | null; bank_account_id: number | null; currency_code: Generated<string>;
  debit: NumericDefault; credit: NumericDefault; debit_currency: NumericDefault; credit_currency: NumericDefault;
  doc_no: string | null; doc_date: DateOnly | null; due_date: DateOnly | null; // số dư công nợ theo từng hóa đơn
  contract_id: number | null; // khế ước vay (TK 341x, 335); hợp đồng bán/mua (0108)
  project_id: number | null; // vụ việc (0108)
}
export interface OpeningStockTable {
  id: Generated<number>; tenant_id: string; fiscal_year: number; item_id: number; warehouse_id: number; lot_no: Generated<string>; expiry_date: DateOnly | null; quantity: Numeric; value: NumericDefault;
}
// Khoản công nợ theo chứng từ: sinh khi ghi sổ dòng tài khoản công nợ (account.reconcile) có đối tượng; amount có dấu (Nợ dương, Có âm).
export interface OpenItemTable {
  id: Generated<number>; tenant_id: string; voucher_id: string; voucher_line_id: number; line_posting_date: DateOnly; line_no: number; account_id: number; party_id: string;
  currency_code: string; doc_date: DateOnly; doc_no: string | null; due_date: DateOnly | null; amount: Numeric; amount_currency: Numeric; parent_id: number | null; invoice_id: number | null;
}
// Một dòng đối trừ giữa khoản Nợ và khoản Có; các dòng cùng group_id là một lần đối trừ.
export interface SettlementTable {
  id: Generated<number>; tenant_id: string; debit_item_id: number; credit_item_id: number; amount: Numeric; amount_currency: Numeric; settle_date: DateOnly;
  kind: string; fx_voucher_id: string | null; group_id: string; created_by: string | null; created_at: Generated<string>;
}
// Kế hoạch đối trừ gửi kèm chứng từ nháp (dòng line_no đối trừ với khoản open_item_id khi ghi sổ, rồi xóa).
export interface SettlementPlanTable {
  id: Generated<number>; tenant_id: string; voucher_id: string; line_no: number; open_item_id: number; amount: Numeric | null; amount_currency: Numeric | null;
}
// Dòng hàng hóa, dịch vụ của hóa đơn HDB/HDM/GGB/GGM (chỉ ghi khi chứng từ còn nháp).
export interface VoucherItemLineTable {
  id: Generated<number>; tenant_id: string; voucher_id: string; line_no: number; description: string | null; item_id: number | null; uom_id: number | null;
  quantity: Numeric | null; unit_price: Numeric | null; amount_currency: Numeric; amount: Numeric; discount_rate: NumericDefault; discount_amount_currency: NumericDefault;
  discount_amount: NumericDefault; tax_codes: Generated<string[]>; tax_amount: NumericDefault; account_id: number; department_id: number | null; project_id: number | null; cost_item_id: number | null;
  warehouse_id: number | null; dest_warehouse_id: number | null; uom_factor: NumericDefault; base_quantity: Numeric | null; lot_no: string | null; mfg_date: DateOnly | null; expiry_date: DateOnly | null;
  direction: string | null; debit_account_id: number | null; credit_account_id: number | null; unit_cost: Numeric | null; source_line_id: number | null; fixed_cost: Generated<boolean>; receipt_voucher_id: string | null; link_line_id: number | null; stock_value: Numeric | null; cost_ratio: Numeric | null; landed_cost_out: NumericDefault;
  asset_id: number | null;
  import_mode: Generated<boolean>; import_tax: Numeric | null; excise_tax: Numeric | null; import_vat: Numeric | null; import_vat_code: string | null; import_vat_base: Numeric | null;
}
// Bảng kê hóa đơn kê khai thuế: một dòng mỗi (hóa đơn, mã thuế).
export interface VoucherInvoiceTable {
  id: Generated<number>; tenant_id: string; voucher_id: string; direction: string; form_no: string | null; serial: string | null; invoice_no: string | null; invoice_date: DateOnly;
  party_id: string | null; party_name: string | null; party_tax_code: string | null; party_address: string | null; invoice_group_id: number | null; header_group_id: number | null; tax_code_id: number | null;
  base_amount: Numeric; tax_amount: Numeric; is_import: Generated<boolean>; adjusts_invoice_id: number | null; declare_year: number | null; declare_period: number | null; declare_period_kind: Generated<string>; note: string | null;
  einvoice_series_id: number | null; einvoice_pending: Generated<boolean>;
}
// Quy tắc tỷ giá theo chế độ, nạp từ fx-rules.json (bảng tham chiếu dùng chung).
export interface FxRuleTable { regime: string; rules: ColumnType<unknown, string, string> }
export interface CashCountTable {
  id: Generated<number>; tenant_id: string; count_date: DateOnly; account_id: number; currency_code: Generated<string>;
  book_balance: Numeric; book_balance_currency: NumericDefault; denominations: JSONColumnType<{ value: string; qty: number }[]>;
  counted_total: Numeric; difference: Numeric; members: JSONColumnType<{ name: string; role?: string }[]>; note: string | null;
  voucher_id: string | null; created_by: string | null; created_at: Generated<string>;
}
export interface StocktakeTable {
  id: Generated<string>; tenant_id: string; seq: Generated<string>; doc_date: DateOnly; warehouse_id: number | string; status: Generated<string>; note: string | null;
  created_by: string | null; created_at: Generated<string>; adjusted_at: string | null;
}
export interface StocktakeLineTable {
  id: Generated<number>; tenant_id: string; stocktake_id: string; item_id: number | string; lot_no: string | null; book_qty: Numeric; counted_qty: Numeric | null;
  diff_qty: ColumnType<string | null, never, never>; reason: string | null;
}
export interface StocktakeVoucherTable { id: Generated<number>; tenant_id: string; stocktake_id: string; voucher_id: string }
// Nhật ký chạy tỷ giá cuối kỳ: kind 'outflow' (tỷ giá xuất quỹ, chứng từ XQ) hoặc 'revaluation' (đánh giá lại, chứng từ DG).
export interface FxRunTable {
  id: Generated<number>; tenant_id: string; kind: string; fiscal_year: number; period_no: number; run_date: DateOnly;
  voucher_ids: ColumnType<string[], string[] | undefined, string[]>; reversed_voucher_ids: ColumnType<string[], string[] | undefined, string[]>;
  params: ColumnType<unknown, string | undefined, string>; created_by: string | null; created_at: Generated<string>;
}
// Lịch phân bổ (doanh thu nhận trước) và các dòng phân bổ theo kỳ; voucher_id là chứng từ PB đã sinh.
export interface AmortizationScheduleTable {
  id: Generated<number>; tenant_id: string; kind: string; source_voucher_id: string | null; from_account_id: number; to_account_id: number; total: Numeric; periods: number;
  start_year: number; start_period: number; description: string | null; is_active: Generated<boolean>; created_by: string | null; created_at: Generated<string>;
}
export interface AmortizationLineTable { id: Generated<number>; tenant_id: string; schedule_id: number; seq: number; fiscal_year: number; period_no: number; amount: Numeric; voucher_id: string | null }
export interface TaxReturnTable {
  id: Generated<number>; tenant_id: string; form_code: string; template_version: string; period_kind: string; year: number; period: number; revision: Generated<number>; status: Generated<string>;
  values: JSONColumnType<Record<string, string>>; overrides: ColumnType<Record<string, string>, string | undefined, string>; created_by: string | null; created_at: Generated<string>; finalized_by: string | null; finalized_at: string | null; acknowledged_gates: Generated<string[]>;
}
export interface BalanceStaleTable { tenant_id: string; stale_year: number; stale_period: number; marked_at: Generated<string> }
export interface AccountPeriodBalanceTable {
  tenant_id: string; account_id: number; fiscal_year: number; period_no: number; currency_code: string; party_id: Generated<string>;
  opening_debit: NumericDefault; opening_credit: NumericDefault; period_debit: NumericDefault; period_credit: NumericDefault; closing_debit: NumericDefault; closing_credit: NumericDefault;
  opening_debit_cur: NumericDefault; opening_credit_cur: NumericDefault; period_debit_cur: NumericDefault; period_credit_cur: NumericDefault; closing_debit_cur: NumericDefault; closing_credit_cur: NumericDefault;
  computed_at: Generated<string>;
}

export interface ClosingStepTable {
  id: Generated<string>; tenant_id: string; regime: string; step_order: number; name: string; mode: string; from_accounts: string[]; to_account: string | null;
  keep_balance: NumericDefault; by_dimension: string | null; ratio_source: JSONColumnType<unknown> | null; run_at: Generated<string>; is_active: Generated<boolean>;
}
// step_id NULL khi bước đã bị xóa khỏi sơ đồ: nhật ký chạy vẫn còn để lần ra chứng từ KC/PB.
export interface ClosingRunTable {
  id: Generated<number>; tenant_id: string; step_id: string | null; posting_date: DateOnly; voucher_id: string; status: Generated<string>; created_at: Generated<string>; created_by: string | null;
}

// Mẫu báo cáo hệ thống (toàn cục) và bản của công ty; source/side/formula: xem packages/domain/src/reportFormula.ts.
export interface ReportTemplateTable {
  regime: string; report_code: string; line_code: string; label: string; parent_line_code: string | null; source: string; side: string; formula: string | null;
  sort_order: number; is_bold: Generated<boolean>; negate: Generated<boolean>; note_ref: string | null; label_en: Generated<string | null>;
}
export interface ReportDefTable { id: Generated<string>; tenant_id: string; regime: string; report_code: string; name: string; form_no: string; issued_by: string }
export interface ReportLineTable {
  id: Generated<number>; tenant_id: string; report_def_id: string; line_code: string; label: string; parent_line_code: string | null; source: string; side: string; formula: string | null;
  sort_order: number; is_bold: Generated<boolean>; negate: Generated<boolean>; note_ref: string | null;
  label_en: Generated<string | null>; translation_status: Generated<string | null>;
}

// sql chỉ chủ sở hữu CSDL (migration/seed) ghi được; app_user chỉ UPDATE các cột thông điệp (xem 0014).
export interface DataCheckRuleTable {
  id: Generated<number>; tenant_id: string; code: string; name: string; severity: string; sql: string; message: string; fix_hint: string | null;
  is_system: Generated<boolean>; is_enabled: Generated<boolean>; flags: Generated<string[]>;
}

export interface EinvoiceProviderTable {
  id: Generated<number>; tenant_id: string; code: string; name: string; base_url: Generated<string>; username: Generated<string>; secret: Buffer | null;
  seller_tax_code: Generated<string>; options: JSONColumnType<unknown>; is_active: Generated<boolean>; created_at: Generated<Timestamp>;
}
export interface EinvoiceSeriesTable {
  id: Generated<number>; tenant_id: string; provider_id: number; form_no: string; serial: string; year: number; kind: Generated<string>;
  provider_template: string | null; is_active: Generated<boolean>; note: string | null;
}

export interface SigningProfileTable {
  id: Generated<number>; tenant_id: string; user_id: string; kind: string; label: string; cert_der: Buffer; cert_subject: string; cert_serial: string;
  cert_not_after: Timestamp; credentials: Buffer | null; is_default: Generated<boolean>; created_at: Generated<string>;
}
export interface SigningSessionTable {
  id: Generated<string>; tenant_id: string; user_id: string; profile_id: number; doc_kind: string; doc_ref: string; xml_unsigned: string; signing_time: string;
  signed_info_c14n: string; digest_b64: string; status: Generated<string>; provider_ref: string | null; error_message: string | null; signed_xml: string | null;
  expires_at: Timestamp; created_at: Generated<string>;
}

export interface InboundInvoiceTable {
  id: Generated<number>; tenant_id: string; source: string; received_at: Generated<string>; received_by: string | null; api_key_id: string | null; xml: string; xml_sha256: string;
  form_no: string; serial: string; invoice_no: string; issue_date: DateOnly; seller_tax_code: string | null; seller_name: string; seller_address: string | null;
  buyer_tax_code: string | null; buyer_name: string | null; currency: Generated<string>; fx_rate: Numeric | null; total_before_tax: Numeric | null; total_tax: Numeric | null; total: Numeric | null; cqt_code: string | null;
  seller_sig: ColumnType<unknown, string | null | undefined, string | null>; cqt_sig: ColumnType<unknown, string | null | undefined, string | null>; buyer_matches: boolean | null; blocked: Generated<boolean>;
  tax_code_check: ColumnType<unknown, string | null | undefined, string | null>; warnings: ColumnType<unknown, string | undefined, string>;
  status: Generated<string>; duplicate_of: number | null; voucher_id: string | null; party_id: string | null;
}
export interface InboundInvoiceLineTable {
  id: Generated<number>; tenant_id: string; invoice_id: number; line_no: number; kind: string; code: string | null; name: string; uom: string | null;
  quantity: Numeric | null; unit_price: Numeric | null; discount_amount: Numeric | null; amount: Numeric | null; tax_rate: string | null;
}

export interface PayrollParamTable {
  id: Generated<number>; tenant_id: string; code: string; valid_from: DateOnly; valid_to: DateOnly | null; value: JSONColumnType<unknown>; source: string;
  created_at: Generated<Timestamp>; updated_at: Generated<Timestamp>;
}
export interface EmployeePayrollTable {
  id: Generated<number>; tenant_id: string; employee_id: number; pay_method: Generated<string>;
  bank_code: string | null; bank_name: string | null; bank_account_no: string | null; bank_account_name: string | null;
  tax_residency: Generated<string>; contract_type: Generated<string>; start_date: DateOnly | null; end_date: DateOnly | null; region: string | null; si_no: string | null;
  si_participates: Generated<boolean>; hi_participates: Generated<boolean>; ui_participates: Generated<boolean>; occupational_participates: Generated<boolean>;
  si_salary: Numeric | null; union_employer: Generated<boolean>; union_member: Generated<boolean>; pit_authorized: Generated<boolean>;
  default_project_id: number | null; note: string | null; created_at: Generated<Timestamp>; updated_at: Generated<Timestamp>;
}
export interface EmployeeAllowanceTable {
  id: Generated<number>; tenant_id: string; employee_id: number; code: string; name: string; amount: Numeric;
  taxable: Generated<boolean>; si_base: Generated<boolean>; valid_from: DateOnly | null; valid_to: DateOnly | null;
}
export interface EmployeeSalaryHistoryTable {
  id: Generated<number>; tenant_id: string; employee_id: number; valid_from: DateOnly; monthly_salary: Numeric; note: string | null; created_at: Generated<Timestamp>;
}
export interface EmployeeDependentTable {
  id: Generated<number>; tenant_id: string; employee_id: number; name: string; relationship: string; tax_code: string | null; id_number: string | null;
  birth_date: DateOnly | null; from_month: string; to_month: string | null; note: string | null;
}
export interface EmployeeCostSplitTable { id: Generated<number>; tenant_id: string; employee_id: number; project_id: number; pct: Numeric }
export interface DepartmentCostAccountTable {
  id: Generated<number>; tenant_id: string; department_id: number; kind: string; role: string | null; account_code: string | null; cost_item_id: number | null; cost_object_id: number | null;
}
export interface AttendanceSheetTable { id: Generated<number>; tenant_id: string; year: number; month: number; department_id: number | null; created_at: Generated<Timestamp> }
export interface AttendanceEntryTable { id: Generated<number>; tenant_id: string; sheet_id: number; employee_id: number; work_date: DateOnly; kind: string; qty: Numeric }
export interface PayrollStructureTable {
  id: Generated<number>; tenant_id: string; code: string; name: string; proration: Generated<string>; columns: JSONColumnType<unknown>; is_default: Generated<boolean>;
  parent_id: number | null; note: string | null; created_by: Generated<string | null>; created_at: Generated<Timestamp>; updated_at: Generated<Timestamp>;
}
export interface PayrollRunTable {
  id: Generated<number>; tenant_id: string; year: number; month: number; kind: Generated<string>; status: Generated<string>; name: string; department_id: number | null; structure_id: number;
  input_hash: string | null; calculated_at: Timestamp | null; warnings: ColumnType<unknown, string | undefined, string>; voucher_id: string | null; note: string | null;
  cost_hash: string | null; // chữ ký cấu hình hạch toán LU (0111, #974)
  created_by: Generated<string | null>; created_at: Generated<Timestamp>; updated_at: Generated<Timestamp>;
}
export interface PayrollLineTable {
  id: Generated<number>; tenant_id: string; run_id: number; employee_id: number; year: Generated<number>; month: Generated<number>; kind: Generated<string>; run_status: Generated<string>; // chép từ payroll_run bằng trigger
  gross: NumericDefault; si_emp: NumericDefault; si_er: NumericDefault; pit: NumericDefault; net: NumericDefault; warnings: ColumnType<unknown, string | undefined, string>; input_hash: string | null;
}
export interface PayrollRunVoucherTable {
  id: Generated<number>; tenant_id: string; run_id: number; kind: string; voucher_id: string; lu_voucher_id: string | null; created_by: Generated<string | null>; created_at: Generated<Timestamp>;
}
export interface PayrollPaymentFormatTable {
  id: Generated<number>; tenant_id: string; name: string; file_type: string; delimiter: Generated<string>; utf8_bom: Generated<boolean>; has_header: Generated<boolean>; ascii_only: Generated<boolean>;
  content_template: Generated<string>; columns: ColumnType<unknown, string, string>; created_by: Generated<string | null>; created_at: Generated<Timestamp>; updated_at: Generated<Timestamp>;
}
export interface PayrollPaymentBatchTable {
  id: Generated<number>; tenant_id: string; run_id: number; format_id: number; bank_account_id: number | null; voucher_id: string | null; file_name: string; content_type: string; file_content: Buffer;
  total: string; count: number; warnings: ColumnType<unknown, string | undefined, string>; created_by: Generated<string | null>; created_at: Generated<Timestamp>;
}
export interface PayrollLineValueTable { id: Generated<number>; tenant_id: string; line_id: number; column_code: string; value: string; manual: Generated<boolean> }
export interface ApiKeyTable {
  id: Generated<string>; tenant_id: string; user_id: string; name: string; prefix: string; key_hash: string; scopes: string[]; default_warehouse_id: number | null;
  post_sales: Generated<boolean>; expires_at: Timestamp | null; revoked_at: Timestamp | null; last_used_at: Timestamp | null; created_at: Generated<Timestamp>;
}
export interface BankFeedTable {
  id: Generated<number>; tenant_id: string; bank_account_id: number; provider: string; token_hash: string; auth_kind: string; secret: Buffer | null; apikey_hash: string | null;
  is_active: Generated<boolean>; created_at: Generated<Timestamp>;
}
export interface BankTransactionTable {
  id: Generated<number>; tenant_id: string; bank_account_id: number; feed_id: number | null; source: string; external_id: string; txn_time: Timestamp | null; value_date: DateOnly;
  amount_in: NumericDefault; amount_out: NumericDefault; balance_after: Numeric | null; description: string | null; reference: string | null; counter_account: string | null;
  counter_name: string | null; payment_code: string | null; raw: ColumnType<unknown, string | null | undefined, string | null>; status: Generated<string>; voucher_id: string | null;
  matched_by: string | null; matched_at: Timestamp | null; created_at: Generated<Timestamp>;
}
export interface BankWebhookLogTable {
  id: Generated<number>; tenant_id: string; feed_id: number; received_at: Generated<Timestamp>; ok: boolean; http_status: number; error: string | null; body_sha256: string | null;
}
export interface BankStatementFormatTable {
  id: Generated<number>; tenant_id: string; name: string; bank_code: string | null; header_row: Generated<number>; sheet_index: Generated<number>; date_col: string; date_format: string;
  description_col: string; amount_in_col: string | null; amount_out_col: string | null; signed_amount_col: string | null; reference_col: string | null; balance_col: string | null;
}

export interface InboundItemMapTable {
  id: Generated<number>; tenant_id: string; seller_tax_code: string; name_key: string; item_id: number | null; account_id: number | null; tax_code_id: number | null; updated_at: Generated<string>;
}

export interface EinvoiceTable {
  id: Generated<number>; tenant_id: string; voucher_id: string; series_id: number; provider_id: number; relation: Generated<string>; original_id: number | null; adjust_kind: string | null;
  status: string; transaction_uuid: string; invoice_no: string | null; issued_at: Timestamp | null; issue_date: DateOnly | null; cqt_code: string | null; cqt_status: Generated<string>;
  provider_ref: ColumnType<Record<string, unknown>, string | undefined, string>; payload: ColumnType<unknown, string | null | undefined, string | null>; xml: string | null;
  error_code: string | null; error_message: string | null; needs_reversal: Generated<boolean>; adjusted: Generated<boolean>; paid: Generated<boolean>; attempts: Generated<number>;
  last_attempt_at: Timestamp | null; created_by: string | null; created_at: Generated<string>; discarded_at: Timestamp | null;
}
export interface EinvoiceErrorNoticeTable {
  id: Generated<number>; tenant_id: string; notice_kind: string; tax_notice_no: string | null; tax_notice_date: DateOnly | null; notice_date: DateOnly; place: Generated<string>;
  provider_id: number | null; status: Generated<string>; provider_ref: string | null; sent_at: Timestamp | null; created_by: string | null; created_at: Generated<string>;
}
export interface EinvoiceErrorNoticeLineTable {
  id: Generated<number>; tenant_id: string; notice_id: number; line_no: number; einvoice_id: number | null; cqt_code: string | null; form_no: string; serial: string; invoice_no: string;
  issue_date: DateOnly; invoice_type: string; action: string; reason: string;
}
export interface EinvoiceLogTable {
  id: Generated<number>; tenant_id: string; einvoice_id: number | null; provider_id: number; action: string; request: ColumnType<unknown, string | null | undefined, never>;
  response: ColumnType<unknown, string | null | undefined, never>; http_status: number | null; ok: boolean; error: string | null; ms: number | null; created_by: string | null; created_at: Generated<string>;
}
export interface EinvoiceFakeStoreTable {
  id: Generated<number>; tenant_id: string; transaction_uuid: string; serial: string; invoice_no: string; issue_date: DateOnly; cqt_code: string | null; cancelled: Generated<boolean>; created_at: Generated<string>;
}

export interface FiscalYearSettingTable { tenant_id: string; fiscal_year: number; book_form: Generated<string>; updated_at: Generated<string> }
export interface LedgerVoucherSetTable { id: Generated<number>; tenant_id: string; fiscal_year: number; set_no: number; set_date: DateOnly; description: string; date_from: DateOnly; date_to: DateOnly; voucher_type: string | null; created_by: string; created_at: Generated<string> }
export interface LedgerVoucherSetItemTable { tenant_id: string; set_id: number; voucher_id: string }
export interface Database {
  tenant: TenantTable;
  app_user: AppUserTable;
  permission: PermissionTable;
  role: RoleTable;
  role_permission: RolePermissionTable;
  tenant_user: TenantUserTable;
  user_session: UserSessionTable;
  login_event: LoginEventTable;
  audit_event: AuditEventTable;
  legal_param: LegalParamTable;
  fiscal_period: FiscalPeriodTable;
  account: AccountTable;
  coa_template: CoaTemplateTable;
  tenant_setting: TenantSettingTable;
  user_pref: UserPrefTable;
  party_group: PartyGroupTable;
  party: PartyTable;
  party_bank_account: PartyBankAccountTable;
  department: DepartmentTable;
  employee: EmployeeTable;
  currency: CurrencyTable;
  exchange_rate: ExchangeRateTable;
  bank: BankTable;
  bank_account: BankAccountTable;
  payment_method: PaymentMethodTable;
  tax_code: TaxCodeTable;
  tax_distribution: TaxDistributionTable;
  invoice_group: InvoiceGroupTable;
  voucher_dup_rule: VoucherDupRuleTable;
  voucher_dup_ignore: VoucherDupIgnoreTable;
  cost_item: CostItemTable;
  project: ProjectTable;
  uom: UomTable;
  item_group: ItemGroupTable;
  item: ItemTable;
  item_uom: ItemUomTable;
  warehouse: WarehouseTable;
  stock_move: StockMoveTable;
  stock_cost_layer: StockCostLayerTable;
  landed_cost_alloc: LandedCostAllocTable;
  costing_run: CostingRunTable;
  stock_cost_assignment: StockCostAssignmentTable;
  stock_cost_state: StockCostStateTable;
  voucher_type: VoucherTypeTable;
  voucher: VoucherTable;
  voucher_line: VoucherLineTable;
  contract: ContractTable;
  asset_category: AssetCategoryTable;
  asset: AssetTable;
  asset_allocation: AssetAllocationTable;
  period_run: PeriodRunTable;
  asset_schedule: AssetScheduleTable;
  asset_schedule_line: AssetScheduleLineTable;
  asset_event: AssetEventTable;
  asset_count: AssetCountTable;
  asset_count_line: AssetCountLineTable;
  voucher_counter: VoucherCounterTable;
  voucher_line_history: VoucherLineHistoryTable;
  voucher_attachment: VoucherAttachmentTable;
  voucher_pair: VoucherPairTable;
  balance_stale: BalanceStaleTable;
  account_period_balance: AccountPeriodBalanceTable;
  opening_balance: OpeningBalanceTable;
  opening_stock: OpeningStockTable;
  open_item: OpenItemTable;
  settlement: SettlementTable;
  settlement_plan: SettlementPlanTable;
  voucher_item_line: VoucherItemLineTable;
  voucher_invoice: VoucherInvoiceTable;
  fx_rule: FxRuleTable;
  cash_count: CashCountTable;
  stocktake: StocktakeTable;
  stocktake_line: StocktakeLineTable;
  stocktake_voucher: StocktakeVoucherTable;
  fx_run: FxRunTable;
  amortization_schedule: AmortizationScheduleTable;
  amortization_line: AmortizationLineTable;
  tax_return: TaxReturnTable;
  closing_step: ClosingStepTable;
  closing_run: ClosingRunTable;
  report_template: ReportTemplateTable;
  report_def: ReportDefTable;
  report_line: ReportLineTable;
  data_check_rule: DataCheckRuleTable;
  einvoice_provider: EinvoiceProviderTable;
  signing_profile: SigningProfileTable;
  inbound_invoice: InboundInvoiceTable;
  inbound_invoice_line: InboundInvoiceLineTable;
  inbound_item_map: InboundItemMapTable;
  api_key: ApiKeyTable;
  payroll_param: PayrollParamTable;
  employee_payroll: EmployeePayrollTable;
  employee_allowance: EmployeeAllowanceTable;
  employee_salary_history: EmployeeSalaryHistoryTable;
  employee_dependent: EmployeeDependentTable;
  employee_cost_split: EmployeeCostSplitTable;
  department_cost_account: DepartmentCostAccountTable;
  attendance_sheet: AttendanceSheetTable;
  attendance_entry: AttendanceEntryTable;
  payroll_structure: PayrollStructureTable;
  payroll_run: PayrollRunTable;
  payroll_line: PayrollLineTable;
  payroll_line_value: PayrollLineValueTable;
  payroll_run_voucher: PayrollRunVoucherTable;
  payroll_payment_format: PayrollPaymentFormatTable;
  payroll_payment_batch: PayrollPaymentBatchTable;
  cost_object: CostObjectTable;
  cost_norm: CostNormTable;
  cost_norm_line: CostNormLineTable;
  cost_run: CostRunTable;
  cost_run_object: CostRunObjectTable;
  cost_run_output: CostRunOutputTable;
  project_alloc_run: ProjectAllocRunTable;
  bank_feed: BankFeedTable;
  bank_transaction: BankTransactionTable;
  bank_webhook_log: BankWebhookLogTable;
  bank_statement_format: BankStatementFormatTable;
  signing_session: SigningSessionTable;
  einvoice_series: EinvoiceSeriesTable;
  einvoice: EinvoiceTable;
  einvoice_error_notice: EinvoiceErrorNoticeTable;
  einvoice_error_notice_line: EinvoiceErrorNoticeLineTable;
  einvoice_log: EinvoiceLogTable;
  einvoice_fake_store: EinvoiceFakeStoreTable;
  fiscal_year_setting: FiscalYearSettingTable;
  ledger_voucher_set: LedgerVoucherSetTable;
  ledger_voucher_set_item: LedgerVoucherSetItemTable;
  budget: BudgetTable;
  budget_line: BudgetLineTable;
  budget_setting: BudgetSettingTable;
}

// GĐ7 nhóm 3: ngân sách.
export interface BudgetTable {
  id: Generated<number>; tenant_id: string; fiscal_year: number; version: Generated<number>; name: string; status: Generated<string>; note: string | null;
  approved_by: string | null; approved_at: Timestamp | null; created_by: string; created_at: Generated<Timestamp>;
}
export interface BudgetLineTable {
  id: Generated<number>; tenant_id: string; budget_id: number; line_no: number; account_prefix: string; cost_item_id: number | null; department_id: number | null; project_id: number | null;
  m01: NumericDefault; m02: NumericDefault; m03: NumericDefault; m04: NumericDefault; m05: NumericDefault; m06: NumericDefault;
  m07: NumericDefault; m08: NumericDefault; m09: NumericDefault; m10: NumericDefault; m11: NumericDefault; m12: NumericDefault; note: string | null;
}
export interface BudgetSettingTable { tenant_id: string; enabled: Generated<boolean>; warn_pct: Generated<number>; block_pct: number | null }

// GĐ7 nhóm 4: phê duyệt đề nghị thanh toán / tạm ứng (0230). Gộp khai báo vào Database để chỉ thêm ở cuối tệp.
export interface ApprovalStepSnapshot { stepNo: number; roleId: string | null; roleName: string | null; userId: string | null; username: string | null }
export interface ApprovalFlowTable {
  id: Generated<number>; tenant_id: string; kind: string; name: string; min_amount: NumericDefault; is_active: Generated<boolean>; created_at: Generated<Timestamp>;
}
export interface ApprovalFlowStepTable { tenant_id: string; flow_id: number; step_no: number; role_id: string | null; user_id: string | null }
export interface ApprovalRequestTable {
  id: Generated<string>; tenant_id: string; kind: string; request_no: string; request_date: DateOnly; requester_id: string; party_id: string | null; payee_name: string; reason: string;
  currency_code: Generated<string>; amount_currency: Numeric; fx_rate: Numeric | null; amount: Numeric; account_code: string; pay_method: string; bank_account_id: number | null; due_date: DateOnly | null;
  state: Generated<string>; flow_id: number | null; steps: ColumnType<ApprovalStepSnapshot[], string | undefined, string>; current_step: Generated<number>; reject_reason: string | null; voucher_id: string | null;
  submitted_at: Timestamp | null; decided_at: Timestamp | null; created_at: Generated<Timestamp>;
}
export interface ApprovalStepLogTable { id: Generated<number>; tenant_id: string; request_id: string; step_no: number; action: string; actor_id: string; note: string | null; on_behalf_of: string | null; created_at: Generated<Timestamp> }
export interface ApprovalDelegationTable {
  id: Generated<number>; tenant_id: string; delegator_id: string; delegate_id: string; date_from: string; date_to: string; reason: string | null; created_by: string;
  created_at: Generated<Timestamp>; revoked_at: Timestamp | null; revoked_by: string | null;
}
export interface ApprovalAttachmentTable {
  id: Generated<string>; tenant_id: string; request_id: string; file_name: string; mime: string; bytes: number; storage_key: string; uploaded_by: string; uploaded_at: Generated<Timestamp>;
}
export interface Database {
  approval_flow: ApprovalFlowTable;
  approval_flow_step: ApprovalFlowStepTable;
  approval_request: ApprovalRequestTable;
  approval_step_log: ApprovalStepLogTable;
  approval_attachment: ApprovalAttachmentTable;
  approval_delegation: ApprovalDelegationTable;
  user_branch_scope: UserBranchScopeTable;
  branch_consolidation_setting: BranchConsolidationSettingTable;
  recurring_entry: RecurringEntryTable;
  recurring_entry_line: RecurringEntryLineTable;
  recurring_run: RecurringRunTable;
  assistant_recognition_log: AssistantRecognitionLogTable;
  voucher_numbering_setting: VoucherNumberingSettingTable;
}

// GĐ7 nhóm 5: đa chi nhánh (0240). voucher.branch_id, department.tax_code đọc/ghi qua sql trong modules/branch.
export interface UserBranchScopeTable { id: Generated<number>; tenant_id: string; user_id: string; branch_id: number | null }
export interface BranchConsolidationSettingTable { tenant_id: string; internal_prefixes: string[]; updated_at: Generated<string> }

// GĐ7 nhóm 6b: sổ hộ kinh doanh, doanh nghiệp siêu nhỏ (0251). Không qua sổ cái bút toán kép.
export interface BookGroupTable { id: Generated<number>; tenant_id: string; code: string; name: string; vat_rate: Numeric | null; income_rate: Numeric | null; is_active: Generated<boolean> }
export interface BookYearSettingTable { tenant_id: string; fiscal_year: number; tax_method: string; income_tax_rate: Numeric | null }
export interface BookEntryTable {
  id: Generated<number>; tenant_id: string; entry_date: DateOnly; doc_no: string | null; description: string; kind: string; amount: Numeric; group_id: number | null; expense_cat: string | null;
  tax_type: string | null; opening_ref: string | null; money_account: string | null; created_by: string; created_at: Generated<Timestamp>;
}
export interface BookStockItemTable { id: Generated<number>; tenant_id: string; code: string; name: string; unit: string; warehouse: string | null }
export interface BookStockMoveTable {
  id: Generated<number>; tenant_id: string; item_id: number; move_date: DateOnly; doc_no: string | null; description: string; direction: string; quantity: Numeric; unit_price: Numeric | null; created_by: string; created_at: Generated<Timestamp>;
}
export interface BookOtherTaxTable {
  id: Generated<number>; tenant_id: string; entry_date: DateOnly; description: string; tax_kind: string; quantity: Numeric | null; abs_rate: Numeric | null; unit_price: Numeric | null; rate_pct: Numeric | null; other_amount: Numeric | null; created_by: string; created_at: Generated<Timestamp>;
}
export interface BookDebtTable {
  id: Generated<number>; tenant_id: string; entry_date: DateOnly; doc_no: string | null; description: string; party: string; side: string; kind: string; nature: Generated<string>; amount: Numeric; created_by: string; created_at: Generated<Timestamp>;
}
export interface BookFixedAssetTable {
  id: Generated<number>; tenant_id: string; asset_type: string; name: string; inc_doc_no: string | null; inc_date: DateOnly; in_use_month: DateOnly; cost: Numeric; dep_rate: Numeric;
  dec_doc_no: string | null; dec_date: DateOnly | null; dec_reason: string | null; created_by: string; created_at: Generated<Timestamp>;
}
export interface BookEquityTable {
  id: Generated<number>; tenant_id: string; entry_date: DateOnly; doc_no: string | null; description: string; section: string; kind: string; amount: Numeric; created_by: string; created_at: Generated<Timestamp>;
}
export interface BookOtherAssetTable {
  id: Generated<number>; tenant_id: string; entry_date: DateOnly; doc_no: string | null; description: string; kind: string; amount: Numeric; created_by: string; created_at: Generated<Timestamp>;
}
// GĐ7 nhóm 6c: S4a, S4b, S4d, tài sản khác của B01-DNSN (0291).
export interface Database { book_debt: BookDebtTable; book_fixed_asset: BookFixedAssetTable; book_equity: BookEquityTable; book_other_asset: BookOtherAssetTable }
export interface Database {
  book_group: BookGroupTable; book_year_setting: BookYearSettingTable; book_entry: BookEntryTable; book_stock_item: BookStockItemTable; book_stock_move: BookStockMoveTable; book_other_tax: BookOtherTaxTable;
}

// GĐ7 nhóm 7: trợ lý (0290). Mẫu bút toán định kỳ, lần chạy theo (mẫu, kỳ), nhật ký nhận diện hóa đơn.
export interface RecurringEntryTable {
  id: Generated<string>; tenant_id: string; code: string; name: string; status: Generated<string>; frequency: string; day_of_month: number; start_date: string; end_date: string | null;
  catch_up: Generated<boolean>; description: string | null; auto_post: Generated<boolean>; created_by: string; created_at: Generated<string>; updated_at: Generated<string>;
}
export interface RecurringEntryLineTable {
  id: Generated<number>; tenant_id: string; entry_id: string; line_no: number; account_code: string; debit_expr: Generated<string>; credit_expr: Generated<string>;
  party_code: string | null; department_code: string | null; project_code: string | null; cost_item_code: string | null; description: string | null;
}
export interface RecurringRunTable {
  id: Generated<number>; tenant_id: string; entry_id: string; period_key: string; occurrence_date: string; status: string; reason_code: string | null; message: string | null;
  voucher_id: string | null; trigger: string; run_by: string | null; run_at: Generated<string>;
}
export interface AssistantRecognitionLogTable {
  id: Generated<number>; tenant_id: string; user_id: string | null; provider: string; external: Generated<boolean>; file_name: string | null; file_sha256: string | null; bytes: number | null;
  status: string; error_code: string | null; created_at: Generated<string>;
}
