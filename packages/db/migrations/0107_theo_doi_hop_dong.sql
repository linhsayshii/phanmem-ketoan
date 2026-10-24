-- GĐ6 Task 13b: phụ lục hợp đồng (điều chỉnh giá trị) và chỉ mục chiều hợp đồng/vụ việc trên sổ cái cho theo dõi hợp đồng, lãi lỗ hợp đồng/vụ việc.
-- Quyền contract_track.view|run đã có từ 0094: không thêm quyền.

-- Phụ lục: mỗi dòng là một phụ lục ký ngày signed_date, tăng (dương) hoặc giảm (âm) giá trị hợp đồng theo loại tiền của hợp đồng (số nguyên như contract.value).
-- Giá trị điều chỉnh tại một ngày = contract.value + Σ value_change của phụ lục ký đến ngày đó. Phụ lục chỉ gia hạn/đổi điều khoản ghi value_change = 0.
CREATE TABLE contract_amendment (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  contract_id bigint NOT NULL,
  seq int NOT NULL CHECK (seq > 0),
  amendment_no text CHECK (amendment_no IS NULL OR length(btrim(amendment_no)) > 0),
  signed_date date NOT NULL,
  description text NOT NULL CHECK (length(btrim(description)) > 0),
  value_change numeric(20,0) NOT NULL DEFAULT 0,
  note text,
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, contract_id, seq) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (tenant_id, contract_id) REFERENCES contract (tenant_id, id) ON DELETE CASCADE);
SELECT rls_enable('contract_amendment');
SELECT audit_enable('contract_amendment');

-- Theo dõi/lãi lỗ đọc dòng sổ cái theo hợp đồng, vụ việc.
CREATE INDEX voucher_line_contract ON voucher_line (tenant_id, contract_id, posting_date) WHERE contract_id IS NOT NULL;
CREATE INDEX voucher_line_project ON voucher_line (tenant_id, project_id, posting_date) WHERE project_id IS NOT NULL;
