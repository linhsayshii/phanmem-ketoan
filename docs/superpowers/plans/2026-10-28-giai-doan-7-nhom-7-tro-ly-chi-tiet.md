# GĐ7 nhóm 7 — Trợ lý AI: gợi ý định khoản, bút toán định kỳ, nhận diện hóa đơn: kế hoạch chi tiết

Migration 0290–0299 (dùng 0290), quyết định 1450–1499 (ghi ở `2026-10-28-giai-doan-7-quyet-dinh-tro-ly.md`, chuyển vào sổ quyết định GĐ7 khi hợp nhất). Tài liệu người dùng `docs/user/giai-doan-7-tro-ly-ai.md`.

Nguyên tắc: trợ lý chỉ TẠO GỢI Ý hoặc CHỨNG TỪ NHÁP; không tự ghi sổ (trừ mẫu định kỳ được cấu hình `auto_post` rõ ràng, mặc định nháp). Không cần khóa API LLM: gợi ý chạy cục bộ, xác định. Văn bản trong hóa đơn là dữ liệu, không là lệnh.

## Tác vụ

1. Quyền và lược đồ (`0290_tro_ly.sql`): quyền `assistant.use`, `recurring.view`, `recurring.manage` (admin, kế toán trưởng, kế toán viên; chỉ xem nhận `recurring.view`); bảng `recurring_entry` (mẫu: tần suất tháng/quý/năm, ngày, hạn, `auto_post`), `recurring_entry_line` (tài khoản, Nợ/Có là số cố định hoặc công thức), `recurring_run` (mỗi mẫu + kỳ một dòng, UNIQUE tenant+mẫu+kỳ, trạng thái created/skipped/error), `assistant_recognition_log` (nhật ký nhận diện, ghi rõ có gửi ra ngoài hay không); RLS + audit; hàm `fn_recurring_tenants()` SECURITY DEFINER cho worker; kiểu `types.ts`; danh sách quyền ở `packages/domain`.
2. Thuần (kiểm thử trước): `assistant/formula.ts` (bộ tính công thức đệ quy xuống, decimal.js, biến THANG, QUY, NAM, SO_NGAY, hàm ROUND/MIN/MAX, kết quả làm tròn xuống đồng nguyên không âm), `assistant/schedule.ts` (các kỳ đến hạn của mẫu, ngày cuối tháng cắt theo tháng), `assistant/rank.ts` (xếp hạng gợi ý bằng số tính tay).
3. Gợi ý định khoản: `assistant/suggest.ts` học từ chứng từ ghi sổ của công ty (RLS, chi nhánh theo phiên), bỏ chứng từ có tài khoản bị cờ nhạy cảm che, API `POST /api/assistant/suggest-entry`.
4. Bút toán định kỳ: `assistant/recurring.ts` (CRUD mẫu, `runRecurring` idempotent theo mẫu + kỳ, kỳ khóa sổ/không tồn tại → bỏ qua có lý do, lỗi từng kỳ không chặn kỳ khác, chứng từ PKT nháp qua `createSystemVoucher` kèm `source_doc_type = 'recurring_entry'`), API `/api/recurring-entries` và `/run`, worker `recurringEntries` (cron hằng ngày 01:30).
5. Nhận diện hóa đơn: `assistant/recognizer/` — giao diện `InvoiceRecognizer`, bộ XML (tái dùng `parseInvoiceXml` GĐ5, độ tin cậy từng trường), bộ giả lập, bộ HTTP/LLM theo `RECOGNIZER_PROVIDER` (mặc định tắt; chỉ dùng khi cài đặt công ty bật và người dùng chọn, mỗi lần ghi `assistant_recognition_log`); chặn tệp không tin cậy (kích thước, chữ ký tệp, zip, DOCTYPE/ENTITY); API `POST /api/assistant/recognize`.
6. Giao diện: trang `/tro-ly` (3 thẻ: Bút toán định kỳ, Nhận diện hóa đơn, Gợi ý), nút Gợi ý (Ctrl+G) ở form chứng từ, Playwright `e2e/tro-ly.spec.ts`.
7. Kiểm thử: đơn vị, tích hợp (gợi ý, định kỳ, kỳ khóa, cờ nhạy cảm), fast-check định kỳ luôn cân Nợ/Có, quét quyền; chạy `inbound`, `vouchers`.
8. Tài liệu người dùng, sổ quyết định, mục "GĐ7 nhóm 7" ở `docs/TIEP-THEO.md`.

## Self-review

Không có số liệu pháp lý nào được nhập. Công thức không dùng `eval`/`Function`. Mọi tiền là chuỗi thập phân + `decimal.js`. Chứng từ định kỳ là PKT thật có số khi ghi sổ, ngày, người lập, `source_doc_*`; không sửa/xóa dòng sổ cái đã ghi sổ.
