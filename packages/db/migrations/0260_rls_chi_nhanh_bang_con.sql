-- 0260_rls_chi_nhanh_bang_con.sql: GĐ7 gói 1 — phạm vi chi nhánh phủ cả bảng con của chứng từ.
-- 0240 chỉ đặt branch_scope trên voucher: người dùng bị giới hạn vẫn đọc (và, qua trigger "không thấy chứng từ thì cho qua", suýt ghi) được dòng sổ cái,
-- dòng hàng, khoản công nợ, phát sinh kho của chi nhánh khác khi truy vấn không JOIN voucher. Mỗi bảng con có voucher_id NOT NULL mà quyền còn lại của người dùng
-- bị giới hạn chạm tới được phủ chính sách RESTRICTIVE: phạm vi rỗng thì qua, ngược lại chứng từ cha phải thấy được (voucher đã tự áp branch_scope + tenant_isolation).
-- Hiệu năng (đo trên 600.000 dòng voucher_line, phạm vi rỗng): (SELECT ...) ở vế phạm vi rỗng thành InitPlan (đọc biến phiên một lần cho cả câu lệnh), và vế chứng từ viết
-- `voucher_id IN (SELECT id FROM voucher)` không tương quan nên không bị tính khi vế đầu đúng: 268 ms, bằng không có chính sách. Dạng EXISTS tương quan theo tenant_id tốn 800 ms.
-- Không cần so tenant_id: voucher đã lọc theo công ty bằng tenant_isolation, và khóa ngoại tổng hợp (tenant_id, voucher_id) bảo đảm bảng con cùng công ty với chứng từ.
-- Bảng còn lại có voucher_id (lương, giá thành, phê duyệt, HĐĐT, ngân hàng, tài sản...) thuộc phân hệ mà quyền còn lại của người dùng chi nhánh không chạm tới: không phủ, xem quyết định 1310.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['voucher_line', 'voucher_item_line', 'voucher_line_history', 'voucher_attachment', 'voucher_pair', 'voucher_invoice',
                           'stock_move', 'open_item', 'voucher_balance_pending', 'doc_order_link', 'landed_cost_alloc', 'stocktake_voucher'] LOOP
    EXECUTE format($f$CREATE POLICY branch_scope ON %I AS RESTRICTIVE
      USING ((SELECT coalesce(current_setting('app.branch_scope', true), '')) = '' OR voucher_id IN (SELECT id FROM voucher))
      WITH CHECK ((SELECT coalesce(current_setting('app.branch_scope', true), '')) = '' OR voucher_id IN (SELECT id FROM voucher))$f$, t);
  END LOOP;
END $$;
