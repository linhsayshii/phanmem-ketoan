# Giao diện mới apps/web theo evon:ui-ux (dựng luôn)

Ngày: 2026-10-29. Lối: skill `evon:ui-ux` chế độ **dựng luôn** (không brief chờ duyệt, không wireframe). Thực hiện: agent agy (`claude-sonnet-4-6` thực hiện và rà soát, `gemini-3.8-flash-*` việc cơ học) chạy trong pane herdr, controller (Opus) thiết kế và nghiệm thu.

## Audit (câu 2 của skill)

- Stack: React 18 + Vite, Ant Design 5, AG Grid 33 (`themeQuartz`), TanStack Router/Query, không Tailwind. Biểu đồ tự vẽ SVG ở `apps/web/src/pages/charts.tsx` (`Chart`).
- Token: `packages/ui/src/theme.ts` (`appTheme` cho antd, `gridTheme` cho AG Grid, `DENSITY`). Màu nhấn `PRIMARY`, font `FONT` chỉ ở file đó.
- Thành phần có sẵn trong `packages/ui`: `KeyboardGrid` (lưới chứng từ chung), `LookupSelect` (F4), `VnNumberInput`, `useHotkeys`, `useRememberedFilter`, `useUnsavedChanges`, `VietQr`.
- Phong cách: flat, hướng C "dày đặc dữ liệu" (đã chốt trong `theme.ts`). Không dark mode. Hướng C đè phần nhịp của `budgets.md` (chữ 13px, control 28px, hàng 28px).
- Hiện trạng: mỗi trang tự dựng đầu trang bằng `<Space><h2 style={{margin:0}}>…` + bộ lọc; trang chủ `/` chỉ là dòng "Chọn chức năng ở menu trái."; header chỉ có huy hiệu Chờ duyệt, tên người dùng, link Đăng xuất.

## Brief (U1, đọc code)

- Sản phẩm: phần mềm kế toán doanh nghiệp Việt Nam, TT99/TT133, nhiều công ty trên một tài khoản. *(đọc code)*
- Người dùng: kế toán viên, kế toán trưởng, người duyệt chứng từ. Ngồi máy tính cả ngày, nhập bằng bàn phím. *(đọc code, CLAUDE.md)*
- Việc chính: lập và ghi sổ chứng từ; xem sổ, báo cáo, tờ khai; khóa sổ cuối kỳ. *(đọc code)*
- Nền tảng: máy tính (1280–1920). Màn hẹp chỉ cần không vỡ (khung app thu sidebar). *(đoán)*
- Khác biệt: nhập liệu bàn phím (Enter/Tab, F4, Ctrl+S, F9, Insert) trên lưới chứng từ chung. *(CLAUDE.md)*

## Việc chính từng loại màn (U2)

| Loại màn | Đến để làm gì | So sánh bằng gì | Hành động cuối | Quy ước phần mềm kế toán (theo trí nhớ, cần kiểm) |
| --- | --- | --- | --- | --- |
| Tổng quan | Biết tình hình tiền, công nợ, kết quả; thấy việc tồn | Số dư tiền, phải thu, phải trả, doanh thu, lợi nhuận lũy kế; số chờ duyệt, số nháp | Mở việc tồn, lập chứng từ | Hàng số liệu trên, biểu đồ theo tháng, khối việc cần làm, nút lập nhanh |
| Danh sách chứng từ | Tìm chứng từ trong kỳ, mở sửa, thêm mới | Ngày, số, đối tượng, số tiền, trạng thái | Mở (Enter), Thêm (Insert) | Hàng lọc kỳ + trạng thái + tìm ở đầu; lưới chiếm hết chiều cao; tổng số chứng từ |
| Form chứng từ | Nhập nhanh bằng bàn phím, ghi sổ | Tổng nợ/có, chênh lệch | Lưu (Ctrl+S), Ghi sổ (F9) | Đầu phiếu gọn hai ba cột, lưới hạch toán bên dưới, thanh nút dính đáy hoặc đầu |
| Danh mục | Tra, thêm, sửa mã | Mã, tên, trạng thái | Thêm, sửa tại lưới | Ô tìm + nút thêm, lưới sửa trực tiếp |
| Báo cáo, sổ | Chọn kỳ và tham số, xem, in, xuất | Số liệu theo chỉ tiêu, kỳ | Xem, In, Xuất Excel | Thanh tham số trên, bảng kết quả dưới, nút in/xuất bên phải |
| Cài đặt | Đổi cấu hình hiếm khi đổi | Giá trị hiện tại | Lưu | Form một cột, nhóm theo khối |

Bố cục khuyên dùng (không vẽ wireframe): khung app sidebar trái + thanh đầu mảnh; mọi màn dùng một đầu trang chung (`PageHeader`) gồm tên trang, mô tả ngắn tùy chọn, nút bên phải, hàng lọc bên dưới.

## Hợp đồng nguyên tố (D1) cho cả bộ

| Nguyên tố | Dùng | Ghi chú |
| --- | --- | --- |
| Đầu trang | `PageHeader` (`@kt/ui`) | `title` là `<h1>` duy nhất của trang, 18px/600; `description` 13px xám; `extra` nút bên phải, tối đa một `type="primary"`; `children` là hàng lọc (`Toolbar`). Thay mọi `<h2 style={{margin:0}}>` trong `<Space>` |
| Hàng lọc | `Toolbar` (`@kt/ui`) | flex wrap, gap 8; con là control antd; phần đếm ("12 chứng từ") đặt cuối, chữ xám |
| Khối nội dung | `Section` (`@kt/ui`) | antd `Card size="small"`, viền 1px `BORDER`, không bóng, `title` 14px/600, `extra` link "Xem tất cả" |
| Hàng số liệu | `StatStrip` (`@kt/ui`) | một khối chia ô bằng đường kẻ dọc, không nhiều card; nhãn 12px xám, số 20px/600 `tabular-nums`, căn trái; giá trị `null` hiện "Không có quyền xem" xám |
| Rỗng | `EmptyState` (`@kt/ui`) | tiêu đề 14px/600, một câu, tối đa một nút; căn giữa khối |
| Trạng thái chứng từ | antd `Tag` theo `STATE_COLOR` có sẵn | không thêm màu mới |
| Nút | antd `Button`: `primary` (một việc chính), mặc định viền, `text`/`link` cho việc phụ, `danger` chỉ cho xóa/hủy | chữ nút kèm phím tắt trong ngoặc như hiện có: "Thêm (Insert)", "Lưu (Ctrl+S)", "Ghi sổ (F9)" |
| Lưới | `KeyboardGrid` + `gridTheme` | không đổi hành vi bàn phím |
| Bảng báo cáo | antd `Table size="small"` theo `appTheme` | số căn phải, `tabular-nums` |
| Thanh cuộn | CSS toàn cục `packages/ui/src/app.css` | 8px, xám nhạt, tự đậm khi rê; áp cả sidebar, lưới |

Token mới (nếu cần) chỉ thêm vào `packages/ui/src/theme.ts`, không mã màu rời trong trang. Màu nền trang `colorBgLayout`, nền khối trắng, viền `BORDER`, chữ phụ `rgba(0,0,0,0.55)` (antd `colorTextSecondary`).

## Danh sách màn theo phân hệ và thứ tự làm

Mỗi dòng là một commit (Conventional Commits, tiếng Việt), push `main` sau mỗi dòng, chạy `pnpm lint && pnpm typecheck && pnpm -F @kt/web test` và Playwright các spec của phân hệ (tuần tự).

| # | Phân hệ | Màn (tệp trong `apps/web/src/pages`) | Spec E2E liên quan |
| --- | --- | --- | --- |
| 1 | Khung app + Tổng quan | `layout/AppLayout.tsx`, `layout/menu.tsx`, trang mới `Dashboard.tsx` (route `/`) | `tong-quan.spec.ts` (mới) |
| 2 | Danh mục | `Accounts`, `Catalog` (`/danh-muc/$name`, 17 danh mục), `ImportExcel` | `danh-muc`, `khu-trung` |
| 3 | Tiền mặt, ngân hàng (+ khung chứng từ dùng chung) | `VoucherList`, `VoucherForm`, `VoucherBranchField`, `CashCount`, `BankTransactions`, `BankFeeds` | `phieu-thu`, `nhap-chung-tu`, `kiem-ke-quy`, `ngan-hang`, `chung-tu-chi-nhanh` |
| 4 | Mua hàng | `Orders` (đơn mua), `InvoiceForm` (MH, TLM, HDM, GGM), `LandedCost` (CPM), `SalesPurchaseReports` (mua) | `mua-hang`, `don-hang`, `chi-phi-mua`, `hoa-don` |
| 5 | Bán hàng | `Orders` (báo giá, đơn bán), `InvoiceForm` (BH, TLB, HDB, GGB), `SalesPurchaseReports` (bán) | `ban-hang`, `bao-cao-ban-hang` |
| 6 | Hóa đơn điện tử | `EInvoices`, `InboundInvoices`, `EInvoiceErrorNotice`, `EInvoiceConfig` | `hoa-don-dien-tu`, `hoa-don-dau-vao` |
| 7 | Kho | `Items`, `PriceLists`, `StockVoucher`, `AssemblyVoucher`, `Stocktake`, `CostingRun`, `StockReports` | `vthh`, `bang-gia`, `phieu-kho`, `lap-rap`, `kiem-ke-kho`, `gia-von`, `bao-cao-kho` |
| 8 | Tài sản | `Assets` (TSCĐ, CCDC, CPTT, loại), `assetDialogs`, `AssetCount`, `AssetReports` | `tai-san`, `ccdc`, `kiem-ke-tai-san`, `bao-cao-tai-san` |
| 9 | Lương | `PayrollProfiles`, `Attendance`, `PayrollRuns`, `PayrollRunImport`, `PayrollReports`, `TncnReturns`, `PayrollPaymentFormats`, `PayrollPaymentFile`, `PayrollStructures`, `PayrollParams` | `luong-ho-so`, `cham-cong`, `bang-luong`, `bao-cao-luong`, `tncn`, `chi-luong`, `chi-luong-lo` |
| 10 | Giá thành | `CostObjects`, `CostNorms`, `CostRuns`, `CostReports` | `doi-tuong-gia-thanh`, `chay-gia-thanh`, `bao-cao-gia-thanh` |
| 11 | Hợp đồng, khế ước | `Loans`, `Contracts`, `ContractReports`, `ProjectAlloc` | `khe-uoc`, `hop-dong`, `theo-doi-hop-dong`, `phan-bo-vu-viec` |
| 12 | Công nợ | `ArapReports`, `Settlement`, `FxTools` | `cong-no`, `doi-tru`, `ty-gia` |
| 13 | Thuế | `InvoiceRegister`, `VatReturn`, `CitEstimate`, `CitReturn`, `SigningSetup`, `DeclaredInvoices` | `bang-ke-thue`, `to-khai-gtgt`, `thue-tndn`, `ky-so`, `phan-bo-thue` |
| 14 | Tổng hợp | `ImportVouchers`, `PeriodClose`, `Periods`, `OpeningBalance`, `OpeningStock`, `AssetOpening`, `Closing`, `Amortization`, `SuggestEntry` | `phieu-ke-toan`, `cuoi-ky`, `so-du-dau-ky`, `ton-dau-ky`, `tai-san-dau-ky`, `phan-bo-doanh-thu` |
| 15 | Phê duyệt | `Approvals`, `ApprovalDelegations` | `phe-duyet`, `phe-duyet-hang-loat` |
| 16 | Báo cáo | `Ledgers`, `BookForms`, `CashBooks`, `Financial`, `Analytics`, `Budget`, `HkdBooks`, `PrintLangSelect` | `in-so`, `so-quy`, `hinh-thuc-so`, `bo-so-hinh-thuc`, `phan-tich`, `ngan-sach`, `hkd-sieu-nho`, `song-ngu` |
| 17 | Hệ thống (cài đặt) | `Users`, `Company`, `CompanyWizard`, `AuditLog`, `ApiKeys`, `Regimes`, `EnglishNames`, `Branches`, `NumberingBranch`, `Dedupe`, `DataCheck`, `Export`, `Assistant`, `Login`, `SelectTenant` | `cong-ty`, `khoa-api`, `chi-nhanh`, `khu-trung`, `tro-ly` |

Thứ tự theo yêu cầu: Tổng quan → danh mục → chứng từ (3–15, theo thứ tự menu) → báo cáo → cài đặt.

## Tác vụ 1: khung app, thành phần dùng chung, Tổng quan

### 1a. Thành phần dùng chung (`packages/ui`)

- `src/PageHeader.tsx`: `PageHeader({ title, description?, extra?, children? })` và `Toolbar({ children })`. `title` render `<h1 className="kt-page-title">`.
- `src/Section.tsx`: `Section({ title?, extra?, children, testId?, bodyPadding? })` bọc antd `Card size="small"`.
- `src/StatStrip.tsx`: `StatStrip({ items: { label: string; value: string | null; hint?: string; testId?: string }[] })`; `value === null` → "Không có quyền xem". Màn hẹp (<768px) chia 2 cột.
- `src/EmptyState.tsx`: `EmptyState({ title, description?, action? })`.
- `src/app.css`: nền `body` = `colorBgLayout`, `.kt-page-title`, thanh cuộn, `font-variant-numeric: tabular-nums` cho `.kt-num`. Import một lần ở `apps/web/src/main.tsx`.
- Xuất từ `src/index.ts`. Kiểm thử vitest `packages/ui/test/*.test.tsx` (render, giá trị `null`, heading).
- Token mới (khoảng cách đầu trang, màu chữ phụ) thêm vào `theme.ts`, xuất `LAYOUT` nếu cần.

### 1b. Khung app (`apps/web/src/layout/AppLayout.tsx`)

- Sidebar 240px nền trắng, không viền phải (nền nội dung xám). Đầu sidebar: tên công ty (600) + mã/chế độ nhỏ xám, đường kẻ dưới chạy hết bề ngang, cao bằng header (48px).
- Ô lọc menu dưới đầu sidebar (`Input` size small, placeholder "Tìm chức năng"): lọc mục theo tên (không dấu cũng khớp), nhóm khớp tự mở. Chỉ là lọc phía giao diện.
- Menu antd `inline`: chỉ mở nhóm chứa trang đang xem lúc tải (`openKeys` điều khiển, người dùng mở thêm được); mục đang chọn nền xám trung tính đậm hơn nền rê, chữ đậm, **không** tô màu nhấn (token `Menu.itemSelectedBg`, `itemSelectedColor`, `itemHoverBg` trong `theme.ts`). Vùng menu cuộn riêng, thanh cuộn mảnh.
- Thanh đầu 48px nền trắng, đường kẻ dưới `BORDER`: trái là đường dẫn phân hệ (tên nhóm menu chứa trang, chữ xám, **không** phải heading, không lặp tên trang); phải: `ApprovalBadge` (giữ nhãn link "Chờ duyệt: N"), menu người dùng (antd `Dropdown` trên nút có tên đăng nhập: "Đổi công ty" → `/chon-cong-ty` khi có >1 công ty, "Đăng xuất" giữ nguyên handler).
- Nội dung padding 16, không giới hạn bề rộng (màn dữ liệu).
- `breakpoint="lg"` giữ thu sidebar ở màn hẹp, thêm nút mở menu trên thanh đầu khi sidebar đã thu.
- Giữ `visibleMenu` và kiểm thử của nó.

### 1c. Tổng quan (`apps/web/src/pages/Dashboard.tsx`, route `/`)

Chỉ dùng API có sẵn, không thêm route API.

- `PageHeader` title "Tổng quan", description "Năm tài chính {năm} · số liệu đến hết tháng {tháng}"; hàng lọc: chọn năm tài chính (`/api/fiscal-years`), chọn đến tháng (mặc định tháng hiện tại nếu thuộc năm, không thì 12); `extra`: nút `primary` dropdown "Lập chứng từ" (Phiếu thu, Phiếu chi, Giấy báo Có, Giấy báo Nợ, Phiếu kế toán, Bán hàng hóa, Mua hàng hóa → `/chung-tu/<mã>/moi`), chỉ hiện khi `can('voucher.create')`.
- `StatStrip` 5 ô từ `/api/analytics/overview` (quyền `report.view`): Tiền cuối tháng, Phải thu, Phải trả, Doanh thu lũy kế, Lợi nhuận lũy kế (`null` → không có quyền xem).
- Lưới 3 cột (xl): `Section` "Doanh thu, chi phí theo tháng" chiếm 2 cột, dùng `Chart` kind bar có sẵn (`testId="chart-dashboard"`); cột phải `Section` "Việc cần làm": dòng "Chờ duyệt" + số (khi `can('approval_request.approve')`, `/api/approvals/inbox/count`, link `/phe-duyet`), dòng "Chứng từ nháp trong tháng" + số (`/api/vouchers?state=draft&from&to&size=5`), dưới là tối đa 5 chứng từ nháp (ngày, số/(nháp), diễn giải, link mở `/chung-tu/<loại>/<id>`), "Xem tất cả" khi có.
- Không có quyền `report.view`: bỏ hàng số liệu và biểu đồ, chỉ còn Việc cần làm. Chưa có năm tài chính: `EmptyState` "Chưa có năm tài chính" + nút "Tạo năm tài chính" → `/so-cai/ky-ke-toan` thay cho lưới.
- Lỗi API: `Alert` như các trang khác.
- E2E `apps/web/e2e/tong-quan.spec.ts`: đăng nhập e2e, vào `/`, thấy heading "Tổng quan", nhãn "Tiền cuối tháng", biểu đồ `chart-dashboard` có `svg`, khối "Việc cần làm"; bấm "Lập chứng từ" → "Phiếu thu" → URL `/chung-tu/PT/moi`.

## Tác vụ 2: Danh mục (`Accounts`, `Catalog`, `ImportExcel`)

Chỉ đổi bố cục. Không đổi gọi API, quyền, hộp thoại, nhãn trường, chữ thông báo, `useHotkeys`, bộ lọc nhớ.

- `Catalog.tsx`: thay `<Space><h2>…` bằng `PageHeader` title `def.label` (h1), `extra` = nút `primary` "Thêm (Insert)" (giữ điều kiện quyền), `children` = `Toolbar` gồm ô tìm (giữ placeholder "Tìm mã, tên…", `onSearch`), chọn trạng thái (giữ `aria-label="Trạng thái"`), cuối hàng chữ xám "{n} dòng" (`rows.data.total`, `formatVnNumber`). Lưới chiếm phần còn lại: `height` tính theo chiều cao đầu trang mới (vd. `calc(100vh - 190px)`), không cuộn trang ngoài. Danh mục rỗng (không có dòng, không tìm): lưới rỗng có sẵn chữ tiếng Việt, không thêm `EmptyState` chồng lên lưới.
- `Accounts.tsx`: `PageHeader` title "Hệ thống tài khoản", description "Thêm tiểu khoản, đổi số hiệu, ghép tài khoản theo chế độ kế toán"; `Toolbar`: nhãn + chọn chế độ (thêm `aria-label="Chế độ kế toán"`), ô lọc nhanh `Input.Search` placeholder "Tìm số hiệu, tên…" lọc phía giao diện trên cây (khớp mã đầu hoặc tên không dấu; khi lọc thì mở hết nhánh khớp), cuối hàng "{n} tài khoản". Bảng trong `Section` (bodyPadding 0), cột "Số hiệu" chữ `kt-num`, cột thao tác dùng `Button type="link"` như cũ. Bảng `sticky` header, cuộn trong khối (`scroll={{ y: 'calc(100vh - 230px)' }}`). Giữ `buildTree` và kiểm thử của nó.
- `ImportExcel.tsx`: bỏ `Card` ngoài; `PageHeader` title "Nhập danh mục từ Excel", description "Tải mẫu, điền dữ liệu, kiểm tra rồi nhập. Có lỗi thì chưa nhập dòng nào."; `Toolbar` giữ các control theo thứ tự cũ (chọn danh mục thêm `aria-label="Danh mục"`), nút "Nhập" là primary duy nhất. Kết quả và bảng lỗi đặt trong `Section` "Kết quả kiểm tra" chỉ khi có kết quả/lỗi.
- Kiểm thử: cập nhật `apps/web/test` nếu có test các trang này (grep `Catalog|Accounts|ImportExcel`); thêm test vitest nhỏ cho bộ lọc cây tài khoản (hàm thuần xuất từ `Accounts.tsx`, vd. `filterTree(tree, q)`).
- E2E: `danh-muc.spec.ts` và `khu-trung.spec.ts` phải xanh (heading `Đối tượng` vẫn là heading; nút "Ngưng dùng", "Sửa", "Đồng ý" giữ tên). Thêm một ca vào `danh-muc.spec.ts`: vào `/danh-muc/he-thong-tai-khoan`, thấy heading "Hệ thống tài khoản", gõ "111" vào ô tìm, thấy dòng "1111".

## Tác vụ 3: Tiền mặt, ngân hàng và khung chứng từ chung

Chia hai phần, làm tuần tự: 3a (Claude Sonnet, rủi ro cao vì mọi loại chứng từ dùng chung), 3b (agy).

### 3a. `VoucherList.tsx`, `VoucherForm.tsx` (dùng cho mọi loại chứng từ qua `/chung-tu/$type`)

- `VoucherList`: `PageHeader` title `typeLabel(def)` (h1), `extra` = nút/dropdown "Thêm (Insert)" giữ nguyên logic loại phiếu kho; `Toolbar`: khoảng ngày, trạng thái (thêm `aria-label="Trạng thái"`), ô tìm (giữ placeholder), `BranchFilter`, cuối hàng chữ xám "{n} chứng từ" (định dạng số Việt Nam). Lưới chiếm phần còn lại (`height` tính lại theo đầu trang). Giữ Enter mở, Insert thêm, nhấp đúp mở, bộ lọc nhớ.
- `VoucherForm`: bỏ `Card` ngoài, thay bằng `PageHeader`: title = "{typeLabel} {số | (mới) | (chưa cấp số)}" là h1, ngay sau là `Tag` trạng thái (trong `title` dạng ReactNode hoặc prop `tags` mới của `PageHeader` nếu cần, thêm vào `packages/ui` kèm test); `extra` = các nút như hiện có, cùng thứ tự, "Lưu (Ctrl+S)" vẫn là primary duy nhất, nút ít dùng (Bỏ ghi sổ, Đảo, Hủy, Nhân bản) giữ là nút thường (không gom menu, để E2E và phím tắt không đổi). Đầu phiếu (Form) đặt trong `Section` "Thông tin chung"; lưới hạch toán trong `Section` "Hạch toán" (bodyPadding 0 hoặc nhỏ), tổng Nợ/Có và chênh lệch ở `extra` hoặc chân khối, số `kt-num`; Tabs Hạch toán/Hóa đơn khi kê khai giữ nguyên, đặt trong khối. Tồn quỹ/số dư tiền gửi, Đính kèm giữ chỗ, đặt trong khối riêng nếu hợp lý. Màu chữ phụ dùng `COLOR.textSecondary`.
- Giữ tuyệt đối: phím tắt (Ctrl+S, F9, F4, Insert, Enter/Tab trong lưới), `useUnsavedChanges`, tên nút, nhãn trường, `data-testid` có sẵn, chữ "(mới)", logic quyền và trạng thái.
- E2E: các spec dùng `.ant-card-head-title` cho form chứng từ chung (`phieu-thu.spec.ts:49`, `phieu-ke-toan.spec.ts:42,104`, và spec nào khác mở `/chung-tu/<loại>` do `VoucherForm` render; kiểm `InvoiceForm`/`StockVoucher`/`LandedCost`/`AssemblyVoucher` có dùng `VoucherForm` không trước khi sửa) đổi sang `page.getByRole('heading', { level: 1 })` (đối với số chứng từ) và locator Tag trạng thái tương ứng. Không đụng spec của các form riêng (để phân hệ của chúng).
- Spec chạy: `phieu-thu`, `nhap-chung-tu`, `phieu-ke-toan`, `chung-tu-chi-nhanh`, `tong-quan`.

### 3b. `CashCount.tsx`, `BankTransactions.tsx`, `BankFeeds.tsx`, `VoucherBranchField.tsx` (agy)

- Mỗi trang: `PageHeader` (h1 giữ đúng tên trang hiện tại nếu E2E dùng heading/text), `Toolbar` cho hàng lọc/tham số, nội dung trong `Section`; một nút primary. `VoucherBranchField` chỉ chỉnh nếu lệch bố cục với form mới.
- Spec chạy: `kiem-ke-quy`, `ngan-hang`.
