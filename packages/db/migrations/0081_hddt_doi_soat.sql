-- GĐ5 Task 5: phát hành hai pha, bỏ hóa đơn phát hành lỗi (xóa mềm), đối soát nền.
-- Bỏ phát hành hóa đơn lỗi: giữ hàng làm lịch sử, chỉ đánh dấu; hàng đã bỏ không còn là hóa đơn của chứng từ và không được dùng lại.
ALTER TABLE einvoice ADD COLUMN discarded_at timestamptz,
  ADD CONSTRAINT einvoice_discarded_failed CHECK (discarded_at IS NULL OR status = 'failed');

-- Hàng cần đối soát (đang gửi, hoặc đã phát hành chờ mã của cơ quan thuế): ít, chỉ mục riêng phần cho lượt quét toàn hệ thống.
CREATE INDEX einvoice_pending_idx ON einvoice (tenant_id) WHERE status = 'sending' OR (status = 'issued' AND cqt_status = 'waiting');

-- Worker chạy bằng app_user chưa biết công ty nào cần đối soát: chỉ trả tenant_id, phần còn lại đọc dưới RLS của từng công ty.
CREATE FUNCTION fn_einvoice_pending_tenants(p_older_than_sec int) RETURNS TABLE (tenant_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT DISTINCT e.tenant_id FROM einvoice e
   WHERE (e.status = 'sending' OR (e.status = 'issued' AND e.cqt_status = 'waiting'))
     AND coalesce(e.last_attempt_at, e.created_at) < now() - make_interval(secs => p_older_than_sec) $$;
REVOKE ALL ON FUNCTION fn_einvoice_pending_tenants(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_einvoice_pending_tenants(int) TO app_user;
