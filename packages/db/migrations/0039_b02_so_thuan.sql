-- GĐ2 Task 27b: B02 TT99 trình bày số thuần chênh lệch đánh giá lại ngoại tệ cuối kỳ (TT99 TK 413 mục 1.5.2, 4.2; Phụ lục IV B02 mục 3.7, 3.8).
-- Mã 22 = 515 trừ nhóm đánh giá lại + lãi thuần; mã 23 = 635 trừ nhóm đánh giá lại + lỗ thuần (cú pháp !REVAL, REVAL_GAIN, REVAL_LOSS của reportFormula).
-- Mẫu hệ thống (report_template) cập nhật theo đường đồng bộ dữ liệu tham chiếu (packages/coa-data B02.csv); ở đây chỉ cập nhật bản của công ty,
-- và chỉ dòng còn đúng công thức mẫu cũ ('515', '635'): dòng đã sửa tay giữ nguyên. Giữ nhật ký kiểm toán (trước/sau) của report_line; migration không có người dùng nên user_id rỗng.
UPDATE report_line l
SET formula = CASE l.line_code WHEN '22' THEN '515!REVAL + REVAL_GAIN' ELSE '635!REVAL + REVAL_LOSS' END
FROM report_def d
WHERE d.tenant_id = l.tenant_id AND d.id = l.report_def_id AND d.regime = 'TT99' AND d.report_code = 'B02'
  AND ((l.line_code = '22' AND btrim(l.formula) = '515') OR (l.line_code = '23' AND btrim(l.formula) = '635'));
