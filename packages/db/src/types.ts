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
export interface BankTable { id: Generated<number>; tenant_id: string; code: string; name: string; short_name: string | null; is_active: Generated<boolean> }
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
  is_closing: Generated<boolean>; idempotency_key: string | null; created_by: string; created_at: Generated<string>;
  posted_by: string | null; posted_at: Timestamp | null; version: Generated<number>; prev_hash: Buffer | null; row_hash: Buffer | null;
  person_name: string | null; person_address: string | null; attachments_count: number | null;
  bank_account_id: number | null; counter_bank_account_id: number | null; party_bank_account_id: string | null; due_date: DateOnly | null; purpose: string | null;
  day_order: Generated<number>; stock_kind: string | null; receipt_state: string | null;
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
export interface VoucherLineTable {
  id: Generated<number>; tenant_id: string; voucher_id: string; line_no: number; account_id: number; posting_date: DateOnly;
  currency_code: Generated<string>; fx_rate: Numeric | null; amount_currency: NumericDefault;
  debit: NumericDefault; credit: NumericDefault; balance: Generated<string>;
  party_id: string | null; item_id: number | null; warehouse_id: number | null; department_id: number | null; project_id: number | null;
  cost_item_id: number | null; contract_id: number | null; employee_id: number | null; asset_id: number | null;
  // jsonb NOT NULL DEFAULT '{}': Generated<JSONColumnType<...>> không bung được kiểu lồng nên khai báo thẳng ColumnType.
  extra_dims: ColumnType<Record<string, unknown>, string | undefined, string>; description: string | null; due_date: DateOnly | null; bank_account_id: number | null;
  cash_flow_code: string | null; // mã chỉ tiêu B03 (dòng tiền), 0066
}
export interface VoucherCounterTable { tenant_id: string; voucher_type: string; fiscal_year: number; last_no: Generated<number> }
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
  id: Generated<number>; tenant_id: string; voucher_id: string; direction: string; form_no: string | null; serial: string | null; invoice_no: string; invoice_date: DateOnly;
  party_id: string | null; party_name: string | null; party_tax_code: string | null; party_address: string | null; invoice_group_id: number | null; header_group_id: number | null; tax_code_id: number | null;
  base_amount: Numeric; tax_amount: Numeric; is_import: Generated<boolean>; adjusts_invoice_id: number | null; declare_year: number | null; declare_period: number | null; declare_period_kind: Generated<string>; note: string | null;
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
  values: JSONColumnType<Record<string, string>>; overrides: ColumnType<Record<string, string>, string | undefined, string>; created_by: string | null; created_at: Generated<string>; finalized_by: string | null; finalized_at: string | null;
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
  sort_order: number; is_bold: Generated<boolean>; negate: Generated<boolean>; note_ref: string | null;
}
export interface ReportDefTable { id: Generated<string>; tenant_id: string; regime: string; report_code: string; name: string; form_no: string; issued_by: string }
export interface ReportLineTable {
  id: Generated<number>; tenant_id: string; report_def_id: string; line_code: string; label: string; parent_line_code: string | null; source: string; side: string; formula: string | null;
  sort_order: number; is_bold: Generated<boolean>; negate: Generated<boolean>; note_ref: string | null;
}

// sql chỉ chủ sở hữu CSDL (migration/seed) ghi được; app_user chỉ UPDATE các cột thông điệp (xem 0014).
export interface DataCheckRuleTable {
  id: Generated<number>; tenant_id: string; code: string; name: string; severity: string; sql: string; message: string; fix_hint: string | null;
  is_system: Generated<boolean>; is_enabled: Generated<boolean>; flags: Generated<string[]>;
}

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
}
