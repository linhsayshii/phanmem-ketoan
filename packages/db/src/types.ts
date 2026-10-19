import type { ColumnType, Generated } from 'kysely';

// Kysely's JSONColumnType yêu cầu T extends object | null; cột jsonb ở đây có thể chứa số/chuỗi (unknown), nên khai báo lại cùng dạng.
type JSONColumnType<T> = ColumnType<T, string, string>;

export type Numeric = ColumnType<string, string | number, string | number>;
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
export interface UserSessionTable { id: Generated<string>; user_id: string; tenant_id: string | null; expires_at: Timestamp; created_at: Generated<string>; ip: string | null }
export interface LoginEventTable { id: Generated<number>; ts: Generated<string>; username: string; user_id: string | null; success: boolean; ip: string | null }
export interface AuditEventTable {
  id: Generated<number>; tenant_id: string; ts: Generated<string>; user_id: string | null;
  action: string; entity: string; entity_id: string; before: JSONColumnType<unknown> | null; after: JSONColumnType<unknown> | null; ip: string | null;
}
export interface LegalParamTable { id: Generated<number>; code: string; value: JSONColumnType<unknown>; valid_from: DateOnly; valid_to: DateOnly | null; source: string }
export interface FiscalPeriodTable {
  id: Generated<number>; tenant_id: string; fiscal_year: number; period_no: number;
  date_from: DateOnly; date_to: DateOnly; regime: string; status: Generated<string>;
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
}
