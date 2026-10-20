-- 0013_bao_cao.sql: định nghĩa báo cáo tài chính là dữ liệu. report_template là mẫu hệ thống theo chế độ (toàn cục, chỉ đọc với app_user);
-- report_def/report_line là bản của từng công ty, sao chép từ mẫu khi tạo năm tài chính hoặc nạp lại mẫu, sửa được công thức từng dòng.
-- Công thức dòng (xem packages/domain/src/reportFormula.ts) lưu dạng chuỗi và chỉ được phân tích khi tính báo cáo.
CREATE TABLE report_template (
  regime text NOT NULL CHECK (regime IN ('TT99','TT133','TT200','TT58')), report_code text NOT NULL, line_code text NOT NULL, label text NOT NULL, parent_line_code text,
  source text NOT NULL CHECK (source IN ('balance','movement','pair','lines')), side text NOT NULL CHECK (side IN ('debit','credit','net_debit','net_credit')),
  formula text, sort_order int NOT NULL, is_bold boolean NOT NULL DEFAULT false, negate boolean NOT NULL DEFAULT false, note_ref text,
  PRIMARY KEY (regime, report_code, line_code));
REVOKE INSERT, UPDATE, DELETE ON report_template FROM app_user;

CREATE TABLE report_def (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenant(id), regime text NOT NULL CHECK (regime IN ('TT99','TT133','TT200','TT58')),
  report_code text NOT NULL, name text NOT NULL, form_no text NOT NULL, issued_by text NOT NULL,
  UNIQUE (tenant_id, regime, report_code),
  UNIQUE (tenant_id, id));
-- Khóa ngoại ghép (tenant_id, report_def_id): dòng không thể gắn vào định nghĩa của công ty khác (kiểm tra khóa ngoại bỏ qua RLS).
CREATE TABLE report_line (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id), report_def_id uuid NOT NULL,
  line_code text NOT NULL, label text NOT NULL, parent_line_code text,
  source text NOT NULL CHECK (source IN ('balance','movement','pair','lines')), side text NOT NULL CHECK (side IN ('debit','credit','net_debit','net_credit')),
  formula text, sort_order int NOT NULL, is_bold boolean NOT NULL DEFAULT false, negate boolean NOT NULL DEFAULT false, note_ref text,
  UNIQUE (tenant_id, report_def_id, line_code),
  FOREIGN KEY (tenant_id, report_def_id) REFERENCES report_def (tenant_id, id) ON DELETE CASCADE);
SELECT rls_enable('report_def'), audit_enable('report_def'), rls_enable('report_line'), audit_enable('report_line');
