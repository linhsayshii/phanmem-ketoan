# Kế hoạch: việc tồn đọng agent tự làm được (2026-10-30)

Nguồn: `docs/TIEP-THEO.md` mục 3b ("Còn lại"), "Lỗ hổng phát hiện khi thử Docker", ghi chú E2E (QĐ 1603), GĐ7 "Còn lại" và QĐ 1517(b). Chỉ lấy việc không chờ người dùng. Sổ quyết định: `2026-10-30-ton-dong-quyet-dinh.md`, bắt đầu từ **1787**. Không cần migration mới trừ T5 (nếu cần thì số tiếp theo sau `0291`, tức `0292`).

Thực hiện: mỗi tác vụ một subagent Sonnet, một subagent rà soát; hai luồng chạy song song vì không chạm cùng tệp: luồng web (T1–T4) và luồng API (T5–T6). Mỗi tác vụ chỉ `git add` tệp của mình, commit Conventional Commits tiếng Việt.

## Luồng web

### T1. `e2e/hoa-don-dau-vao.spec.ts` chạy lại được trên cùng DB
- Vấn đề: ánh xạ hàng hóa nhớ ở `inbound_item_map` làm tài khoản điền sẵn ở lần chạy sau, spec mong nút "Lập chứng từ" bị khóa.
- Làm như `phan-bo-thue`: mỗi lần chạy dùng mã hàng/MST mới (hậu tố theo thời gian) hoặc dọn ánh xạ qua API trước khi chạy. Chỉ đổi spec.
- Kiểm: chạy spec hai lần liền trên cùng DB E2E, cả hai đạt.

### T2. `NoFiscalYear` cho các trang còn tự viết thông báo
- Tổng quan (`Section` + `EmptyState` riêng), Hình thức sổ, Ngân sách, Sổ HKD, Báo cáo tài chính (`Alert` riêng) đổi sang `NoFiscalYear`/`NoFiscalYearNotice` như các trang ở QĐ 1772–1782.
- Kiểm: bổ sung `apps/web/test/NoFiscalYearPages.test.tsx`; `e2e/chua-co-nam.spec.ts` vẫn đạt.

### T3. Hộp thoại `confirmLoading` + `forceRender` (QĐ 1603)
- 11 hộp thoại cùng mẫu với `RowDialog` (`PayrollProfiles.tsx`) chưa sửa: nút Lưu có thể kẹt biểu tượng loading ở lần mở sau. Áp cùng cách (dựng lại chân hộp thoại theo `gen` mỗi lần mở) hoặc thành phần dùng chung trong `packages/ui` nếu gọn hơn.
- Kiểm: kiểm thử đơn vị mở, lưu, mở lại một hộp thoại đại diện; tên truy cập nút là "Lưu".

### T4. Nút "Từ chối hàng loạt" trên trang Phê duyệt
- API `POST /api/approvals/batch/reject` đã có. Thêm nút cạnh "Duyệt hàng loạt", hộp thoại nhập lý do (bắt buộc), báo kết quả từng đề nghị như duyệt hàng loạt.
- Kiểm: kiểm thử đơn vị và một ca Playwright trong spec phê duyệt hiện có.

## Luồng API

### T5. Sổ HKD/DNSN: cờ nhạy cảm và khóa kỳ (QĐ 1517 b)
- Bút ghi sổ HKD (`hkdbooks`) ở ngày thuộc kỳ đã khóa (khóa sổ/khóa cứng theo `fiscal_period`) không thêm, sửa, xóa được: 409 với thông báo tiếng Việt như chứng từ.
- Sổ/báo cáo có số công nợ phải thu/phải trả, giá vốn: chặn theo `view_receivable`, `view_payable`, `view_cost` ở API (như B01-DNSN mã 120/310 đã làm cho TT58 ở QĐ 1640–1653; giữ nguyên quyết định "B01 không che" đang chờ người dùng ở QĐ 1777 b). Sổ nào chặn ghi vào sổ quyết định.
- Kiểm: kiểm thử API; `sensitiveSweep` vẫn xanh.

### T6. Số dư đầu kỳ theo chi nhánh
- Hiện chứng từ số dư đầu kỳ thuộc chi nhánh làm việc của người nhập. Cho phép người không bị giới hạn chọn chi nhánh khi nhập số dư đầu kỳ (tài khoản, công nợ, tồn kho, tài sản nếu cùng đường mã), người bị giới hạn chỉ nhập cho chi nhánh mình.
- Nếu đường mã yêu cầu đổi `post_voucher` hay ràng buộc số chứng từ: dừng, ghi quyết định "hoãn" kèm lý do.
- Kiểm: kiểm thử API (BCTC tổng hợp theo chi nhánh thấy số đầu kỳ đúng chi nhánh), giao diện ô chọn chi nhánh khi công ty có nhiều chi nhánh.

## Không làm trong đợt này
- QĐ 1318 (cờ phiên vượt rào đặt được từ `app_user`): đụng mọi hàm ghi sổ, rủi ro cao; để đợt bảo mật riêng.
- Chứng từ lương/giá thành tự sinh gắn chi nhánh của nhân viên/đối tượng: cần tách một chứng từ thành nhiều theo chi nhánh, là quyết định thiết kế.
- Mọi hàng ở mục 4 (chờ người dùng).

## Kết thúc
`pnpm lint && pnpm typecheck && pnpm test`, E2E các spec đụng tới, cập nhật `docs/TIEP-THEO.md` và tài liệu người dùng, push `main` lên `origin`.
