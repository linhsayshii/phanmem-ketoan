-- GĐ4 Task 4: lần chạy kỳ (khấu hao, phân bổ CCDC/CPTT, lãi vay), lịch khấu hao theo phiên bản, hàm giá trị tài sản đọc từ sổ cái.
CREATE TABLE period_run (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  kind text NOT NULL CHECK (kind IN ('depreciation','tool','prepaid','loan_interest')),
  fiscal_year int NOT NULL, period_no int NOT NULL,
  voucher_id uuid,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded')),
  result jsonb NOT NULL DEFAULT '{}',
  created_by uuid REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  checked_at timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, fiscal_year, period_no) REFERENCES fiscal_period (tenant_id, fiscal_year, period_no),
  FOREIGN KEY (tenant_id, voucher_id) REFERENCES voucher (tenant_id, id));
-- Một lần chạy hiệu lực mỗi (loại, kỳ): chốt chặn cuối khi hai yêu cầu chạy cùng lúc (ngoài khóa tư vấn).
CREATE UNIQUE INDEX period_run_active ON period_run (tenant_id, kind, fiscal_year, period_no) WHERE status = 'active';

CREATE TABLE asset_schedule (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  asset_id bigint NOT NULL,
  version int NOT NULL,
  eff_year int NOT NULL, eff_period int NOT NULL,
  basis_cost numeric(20,0) NOT NULL, basis_acc numeric(20,0) NOT NULL,
  units numeric(24,12) NOT NULL CHECK (units >= 0),
  reason text NOT NULL CHECK (reason IN ('initial','ledger_change','window_change','life_change','rerun')),
  superseded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, asset_id, version),
  FOREIGN KEY (tenant_id, asset_id) REFERENCES asset (tenant_id, id) ON DELETE CASCADE);

CREATE TABLE asset_schedule_line (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  schedule_id bigint NOT NULL,
  fiscal_year int NOT NULL, period_no int NOT NULL,
  units numeric(24,12) NOT NULL, amount numeric(20,0) NOT NULL, accumulated numeric(20,0) NOT NULL,
  run_id uuid,
  UNIQUE (tenant_id, schedule_id, fiscal_year, period_no),
  FOREIGN KEY (tenant_id, schedule_id) REFERENCES asset_schedule (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, run_id) REFERENCES period_run (tenant_id, id));

SELECT rls_enable(t) FROM unnest(ARRAY['period_run','asset_schedule','asset_schedule_line']::regclass[]) AS t;
SELECT audit_enable(t) FROM unnest(ARRAY['period_run','asset_schedule','asset_schedule_line']::regclass[]) AS t;

CREATE INDEX voucher_line_asset ON voucher_line (tenant_id, asset_id, posting_date) WHERE asset_id IS NOT NULL;

-- Quy ước 1: nguyên giá = Σ (Nợ − Có) trên TK tài sản của thẻ, hao mòn = Σ (Có − Nợ) trên TK hao mòn, chứng từ đã ghi sổ (kể cả đã bị đảo), ngày ghi sổ ≤ p_date.
-- So theo mã tài khoản (không theo id): dòng của một tài sản qua nhiều năm có thể nằm ở tài khoản của các chế độ khác nhau cùng mã.
-- p_exclude_runs: bỏ chứng từ của các lần chạy này (kể cả bản đảo, vì đảo chép source_doc_*) — động cơ lịch dùng để tính hao mòn "trừ lần chạy kỳ P".
CREATE FUNCTION fn_asset_values_at(p_tenant uuid, p_date date, p_exclude_runs uuid[] DEFAULT '{}')
RETURNS TABLE(asset_id bigint, cost numeric, accumulated numeric) LANGUAGE sql STABLE AS $$
  SELECT a.id, coalesce(x.cost, 0), coalesce(x.acc, 0)
  FROM asset a
  LEFT JOIN (
    SELECT l.asset_id,
      sum(l.debit - l.credit) FILTER (WHERE ac.code = s.asset_account_code) AS cost,
      sum(l.credit - l.debit) FILTER (WHERE ac.code = s.depreciation_account_code) AS acc
    FROM voucher_line l
    JOIN voucher v ON v.id = l.voucher_id AND v.tenant_id = l.tenant_id
    JOIN account ac ON ac.id = l.account_id AND ac.tenant_id = l.tenant_id
    JOIN asset s ON s.id = l.asset_id AND s.tenant_id = l.tenant_id
    WHERE l.tenant_id = p_tenant AND l.asset_id IS NOT NULL AND l.posting_date <= p_date AND v.state IN ('posted','reversed')
      AND (v.source_doc_type IS DISTINCT FROM 'asset_run' OR v.source_doc_id <> ALL (p_exclude_runs))
    GROUP BY l.asset_id) x ON x.asset_id = a.id
  WHERE a.tenant_id = p_tenant
$$;
