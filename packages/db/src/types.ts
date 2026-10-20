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
}
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
}
export interface VoucherLineTable {
  id: Generated<number>; tenant_id: string; voucher_id: string; line_no: number; account_id: number; posting_date: DateOnly;
  currency_code: Generated<string>; fx_rate: Numeric | null; amount_currency: NumericDefault;
  debit: NumericDefault; credit: NumericDefault; balance: Generated<string>;
  party_id: string | null; item_id: number | null; warehouse_id: number | null; department_id: number | null; project_id: number | null;
  cost_item_id: number | null; contract_id: number | null; employee_id: number | null; asset_id: number | null;
  // jsonb NOT NULL DEFAULT '{}': Generated<JSONColumnType<...>> không bung được kiểu lồng nên khai báo thẳng ColumnType.
  extra_dims: ColumnType<Record<string, unknown>, string | undefined, string>; description: string | null; due_date: DateOnly | null; bank_account_id: number | null;
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
  id: Generated<number>; tenant_id: string; fiscal_year: number; account_id: number; party_id: string | null; currency_code: Generated<string>;
  debit: NumericDefault; credit: NumericDefault; debit_currency: NumericDefault; credit_currency: NumericDefault;
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
  is_system: Generated<boolean>; is_enabled: Generated<boolean>;
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
  invoice_group: InvoiceGroupTable;
  cost_item: CostItemTable;
  project: ProjectTable;
  uom: UomTable;
  voucher_type: VoucherTypeTable;
  voucher: VoucherTable;
  voucher_line: VoucherLineTable;
  voucher_counter: VoucherCounterTable;
  voucher_line_history: VoucherLineHistoryTable;
  voucher_attachment: VoucherAttachmentTable;
  voucher_pair: VoucherPairTable;
  balance_stale: BalanceStaleTable;
  account_period_balance: AccountPeriodBalanceTable;
  opening_balance: OpeningBalanceTable;
  closing_step: ClosingStepTable;
  closing_run: ClosingRunTable;
  report_template: ReportTemplateTable;
  report_def: ReportDefTable;
  report_line: ReportLineTable;
  data_check_rule: DataCheckRuleTable;
}
