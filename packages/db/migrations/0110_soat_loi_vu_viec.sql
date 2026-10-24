-- GĐ6 Task 14b: quy tắc soát lỗi VU_VIEC_CHI_PHI_CHUNG_CHUA_PHAN_BO (tổng 50). Cần nhóm TK bán hàng/quản lý theo chế độ (TT99 641/642, TT133 6421/6422 trong coa-data), nên chạy bằng mã:
-- dòng quy tắc có SQL rỗng, phần chạy nằm ở apps/api/src/modules/tools/dataCheckTs.ts theo mã quy tắc (như LUONG_CAN_TINH_LAI). Số tiền in trong chi tiết nên mang cờ view_cost.
-- Định nghĩa lại seed_data_check_rules từ thân hiện hành (qua 0109): chèn dòng mới trước ON CONFLICT như 0109.
DO $mig$
DECLARE d text; n text;
BEGIN
  d := pg_get_functiondef('seed_data_check_rules(uuid)'::regprocedure);
  IF position($r$ON CONFLICT DO NOTHING$r$ IN d) = 0 THEN RAISE EXCEPTION 'seed_data_check_rules không có ON CONFLICT DO NOTHING'; END IF;
  n := $new$,
  (p_tenant, 'VU_VIEC_CHI_PHI_CHUNG_CHUA_PHAN_BO', 'Chi phí bán hàng, quản lý chung chưa phân bổ vào vụ việc', 'warning',
   $q$SELECT NULL::uuid, NULL::text, NULL::text WHERE false$q$,
   'Tháng có vụ việc đang hoạt động mà chi phí bán hàng, quản lý doanh nghiệp chưa gắn vụ việc còn dư (chưa phân bổ hoặc phải chạy lại phân bổ)', 'Phân bổ chi phí chung vào vụ việc (Vụ việc > Phân bổ chi phí) hoặc chạy lại phân bổ của tháng', true, '{view_cost}')
  $new$;
  d := replace(d, E'\n  ON CONFLICT DO NOTHING', n || E'\n  ON CONFLICT DO NOTHING');
  IF position('VU_VIEC_CHI_PHI_CHUNG_CHUA_PHAN_BO' IN d) = 0 THEN RAISE EXCEPTION 'không chèn được quy tắc vụ việc (khuôn ON CONFLICT khác dự kiến)'; END IF;
  EXECUTE d;
END $mig$;

-- Công ty đã có: bổ sung quy tắc mới (tắt nhật ký kiểm toán như 0109).
ALTER TABLE data_check_rule DISABLE TRIGGER trg_audit;
SELECT seed_data_check_rules(id) FROM tenant;
ALTER TABLE data_check_rule ENABLE TRIGGER trg_audit;
