-- 0263_chi_muc_khoa_ngoai_gd7.sql: GĐ7 gói 1 — chỉ mục dẫn đầu cho khóa ngoại tổng hợp của 0220–0240 (xóa/đổi dòng bảng cha quét tuần tự bảng con nếu thiếu).
-- Quan trọng nhất approval_request(tenant_id, voucher_id): xóa chứng từ nháp (thao tác thường xuyên) kích hoạt ON DELETE SET NULL (voucher_id) trên bảng này.
CREATE INDEX IF NOT EXISTS approval_request_voucher_idx ON approval_request (tenant_id, voucher_id) WHERE voucher_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS approval_request_flow_idx ON approval_request (tenant_id, flow_id);
CREATE INDEX IF NOT EXISTS approval_request_party_idx ON approval_request (tenant_id, party_id) WHERE party_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS approval_request_bank_idx ON approval_request (tenant_id, bank_account_id) WHERE bank_account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS approval_flow_step_role_idx ON approval_flow_step (tenant_id, role_id) WHERE role_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS approval_flow_step_user_idx ON approval_flow_step (tenant_id, user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS approval_step_log_actor_idx ON approval_step_log (tenant_id, actor_id);
CREATE INDEX IF NOT EXISTS ledger_voucher_set_created_by_idx ON ledger_voucher_set (tenant_id, created_by);
CREATE INDEX IF NOT EXISTS user_branch_scope_branch_idx ON user_branch_scope (tenant_id, branch_id) WHERE branch_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS budget_created_by_idx ON budget (tenant_id, created_by);
CREATE INDEX IF NOT EXISTS budget_approved_by_idx ON budget (tenant_id, approved_by) WHERE approved_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS budget_line_cost_item_idx ON budget_line (tenant_id, cost_item_id) WHERE cost_item_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS budget_line_department_idx ON budget_line (tenant_id, department_id) WHERE department_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS budget_line_project_idx ON budget_line (tenant_id, project_id) WHERE project_id IS NOT NULL;
