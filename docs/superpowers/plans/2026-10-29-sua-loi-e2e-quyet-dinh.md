# Sửa lỗi E2E sau GĐ7: sổ quyết định (1600–1619)

Bối cảnh: E2E Playwright sau GĐ7 trên máy Mac 64 đạt, 19 đỏ, 2 không chạy (`docs/TIEP-THEO.md`). Đợt này điều tra từng spec đỏ trên DB E2E tạo mới mỗi lượt (`ketoan_e2e`), sửa lỗi thật ở mã và lỗi đua trong spec, rồi chạy lại toàn bộ.

## Lỗi thật ở mã

- **1600** — `useRememberedFilter` (`packages/ui`): bản nạp bộ lọc từ máy chủ về sau khi người dùng đã sửa bộ lọc thì ghi đè thứ vừa nhập. Thêm cờ `touched`: người dùng đã gọi `update` thì bỏ qua bản nạp (và nhánh dự phòng cục bộ). Đổi khóa/phạm vi thì đặt lại cờ. Kiểm thử hồi quy trong `packages/ui/test/useRememberedFilter.test.tsx` (đỏ khi bỏ bản sửa).
- **1601** — Bảng lương (`PayrollRuns.tsx`): sửa tay một ô thì máy chủ trả dòng tính lại, `patchRow` ghi tại chỗ vào cùng đối tượng dòng nên AG Grid không vẽ lại kiểu ô (ô sửa tay không in đậm, nền vàng; E2E `bang-luong` đỏ ở bước này). Sau khi lưu ô, `refreshCells({ rowNodes: [node], force: true })` cho dòng đó.
- **1602** — Hộp thoại biến động tài sản (`assetDialogs.tsx`): đặt lại form trong `afterOpenChange` (sau hiệu ứng mở) xóa mất lựa chọn người dùng đã kịp chọn (vd. Lý do ghi tăng). Chuyển phần đặt lại sang `useEffect` theo `kind`, chạy ngay khi mở.
- **1603** — Hộp thoại dòng con của Hồ sơ lương (`RowDialog` trong `PayrollProfiles.tsx`: phụ cấp, người phụ thuộc, mức lương): `busy` về `false` cùng lần vẽ với lúc hộp thoại ẩn nên hiệu ứng thu biểu tượng loading của nút Lưu không chạy xong; `forceRender` giữ nút đó cho lần mở sau, tên truy cập của nút thành "loading Lưu" (trình đọc màn hình đọc sai, Playwright không tìm được nút). Mỗi lần mở dựng lại chân hộp thoại (`footer` theo `gen`). 11 hộp thoại khác cùng mẫu `confirmLoading` + `forceRender` chưa sửa vì chưa thấy lỗi (cần mở lại cùng hộp thoại sau khi lưu); nếu gặp thì áp cùng cách.

## Lỗi trong spec (không phải lỗi phần mềm)

- **1604** — `Control+a` trên macOS là "về đầu dòng", không phải chọn hết: gõ đè ô số nối thêm vào giá trị cũ (`1000000` thành `10000000`). Đổi thành `ControlOrMeta+a` ở 10 spec. Đây là nguyên nhân của phần lớn nhóm "đỏ cố định" (`so-du-dau-ky`, `ton-dau-ky`, `cham-cong`, `kiem-ke-quy`, `kiem-ke-kho`, `kiem-ke-tai-san`, `tai-san-dau-ky`, `phieu-ke-toan`, `doi-tuong-gia-thanh`, `bang-luong`); trên VPS Linux không gặp.
- **1605** — rc-select khi bấm một lựa chọn đặt `setTimeout` trả tiêu điểm về ô vừa chọn. Spec bấm hoặc gõ vào ô kế tiếp ngay sau đó thì bị cướp tiêu điểm (dropdown ô sau không mở, chữ gõ rơi vào ô trước). Sau khi chọn, chờ `.ant-select-dropdown:visible` về 0 ở các chỗ đã đỏ (`choose`/`pickF4` của `bao-cao-gia-thanh`, `chay-gia-thanh`, `phan-bo-vu-viec`, `hop-dong`, `doi-tuong-gia-thanh`; `bao-cao-luong`, `tncn`, `tai-san`, `bao-cao-ban-hang`). Không sửa đồng loạt 85 chỗ chọn: người dùng thật không thao tác trong vài mili giây.
- **1606** — Gõ ngày bằng `fill` + Enter: khi chạy nhanh antd 5.29 đôi khi chưa chốt ngày (ô hiện chữ đã gõ nhưng giá trị vẫn cũ, RangePicker còn đảo hai đầu: yêu cầu `from=2026-08-31&to=2026-10-01` khi gõ 01/08–31/08). Helper `e2e/helpers/dates.ts` (`typeDate`, `typeRange`) gõ phím thật, Enter, rời ô rồi kiểm giá trị; dùng ở `bao-cao-ban-hang`, `bao-cao-kho`, `bao-cao-tai-san`, `cong-no`, `hoa-don`, `so-quy`, `ty-gia`. Người dùng gõ ngày rồi Enter vẫn thấy đúng vì rời ô chốt ngày; hiện tượng chỉ làm truy vấn chạy muộn đến lúc rời ô.
- **1607** — `cong-no`: bộ lọc nhớ của lần chạy trước giữ khoảng ngày khác; đặt sẵn `filter:arap-reports` (ngày, `asOf`, TK 131) qua API trước khi mở trang, như `danh-muc` đã làm.
- **1608** — `danh-muc`: bấm "Ngưng dùng" khi lưới chưa lọc xong theo mã (15 nút cùng tên); chờ lưới còn đúng một dòng. `phan-bo-thue` cùng mẫu: đọc `row-index` của dòng khi lưới còn danh sách chưa lọc nên nút Sửa ở vùng ghim phải trỏ sai dòng; chờ phản hồi tìm kiếm `q=3335` trước.
- **1609** — `so-du-dau-ky`, `ton-dau-ky`: hàm chờ `editingCol` coi ô đã vào chế độ sửa khi div ô có tiêu điểm, trước khi ô nhập của trình soạn nhận tiêu điểm; gõ lúc đó thì phím rơi mất (dòng vừa thêm mất mã tài khoản). Chỉ tính khi tiêu điểm là `HTMLInputElement`.
- **1610** — `PayrollPages.test.tsx` (vitest web): bấm "Nhập" khi bảng tham số còn lớp mờ đang tải (`ant-spin-blur`, `pointer-events: none`) nên đỏ khi máy bận. Chờ hết lớp mờ.

## Môi trường

- **1611** — Máy Mac: Postgres của dự án chạy ở container `ketoan-gd7-pg` cổng 5441 (không phải 5432 như `.env`). Chạy kiểm thử bằng `DATABASE_URL=postgres://app_user:app_pass@127.0.0.1:5441/ketoan DATABASE_ADMIN_URL=postgres://postgres:postgres@127.0.0.1:5441/ketoan`. E2E dùng DB riêng `ketoan_e2e` (tạo mới bằng `createdb`, `pnpm db:migrate`, `create-admin` cho `e2e` và `e2ehkd`), cổng `E2E_API_PORT=3100`, `E2E_WEB_PORT=5273`.
- **1612** — Không sửa mã `apps/web/src` hay `packages/ui/src` khi E2E đang chạy: Vite tải lại trang giữa ca (đã làm đỏ giả `danh-muc`, `hoa-don-dau-vao` một lượt). Không chạy E2E đè bộ kiểm thử đơn vị (nhiều ca hết 60 giây).
